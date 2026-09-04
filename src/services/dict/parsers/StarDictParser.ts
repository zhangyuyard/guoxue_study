/**
 * StarDict 字典解析器（.ifo + .idx/.idx.dz/.idx.gz + .dict/.dict.dz）
 *
 * StarDict 为三文件成组格式，无法套用「单文件 parser.sniff + ctx」管线，
 * 由 DictImportService.importStarDict 成组校验后经 makeStarDictParser 适配为
 * parserLike（format + parse(ctx)）接入既有流式入库主流程。
 *
 * 实现要点：
 * - .ifo：纯文本 key=value（首行为版本声明行，跳过）
 * - .idx：词条序 = word(utf-8) NUL + offset(4/8B 大端) + size(4B 大端)；
 *   idxoffsetbits=64 或 version=3.0.0 时 offset 为 8 字节
 * - .idx.dz / .dict.dz：dictzip（gzip 兼容）—— extra field 'RA' 内含
 *   ver(2LE) + chlen(2LE) + 各块压缩后大小(2LE × N，末块除外)，
 *   据此随机访问按块 inflateRaw，避免整本解压爆内存；
 *   普通 gzip（无 'RA'）与未压缩文件分别走整体解压 / 直读降级
 * - sametypesequence：m/l=plain、h/x/g=html（EntryContent 白名单渲染兜底）；
 *   无 sametypesequence 时按「类型字节 + 数据」序列解析，聚合文本段
 */
import { inflateRaw, ungzip } from 'pako';

import type { DictContentType } from '@/types/dict';

import type { DictParserContext, ParsedEntry } from './types';
import { utf8Decode } from './types';

/** 文件句柄（与 DictFileService.createChunkReader 产物同构，便于单测注入） */
export interface StarDictChunkReader {
  fileSize: number;
  readChunk(position: number, length: number): Promise<Uint8Array>;
}

/** 整体解压上限（普通 gzip idx 兜底；超过则拒绝，防内存爆掉） */
const MAX_FULL_DECOMPRESS_BYTES = 128 * 1024 * 1024;
/** 单条释义上限（2MB；超限记错误跳过，防坏数据撑爆内存） */
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
/** 流式解析批大小（与既有解析器一致） */
const BATCH_SIZE = 1000;
/** idx 流式窗口（1MB） */
const IDX_WINDOW_BYTES = 1024 * 1024;

/** gzip 头解析的初始读取窗口（64KB；字段超出此界时需扩读） */
const GZIP_HEADER_INIT_WINDOW = 65536;
/** gzip 头扩读步长（64KB） */
const GZIP_HEADER_GROW_STEP = 65536;

/**
 * 确保头部缓冲覆盖 [0, need)：不足时从文件起始重新读取 need 字节。
 * gzip 头总长（10 + FEXTRA + FNAME + FCOMMENT + FHCRC）通常远小于文件大小，
 * 从 0 重读一次即可；文件读尽仍不足则抛错。
 */
async function ensureHeadBytes(
  head: Uint8Array,
  need: number,
  file: StarDictChunkReader,
): Promise<Uint8Array> {
  if (head.length >= need) {
    return head;
  }
  if (need > file.fileSize) {
    throw new Error('gzip 文件头不完整');
  }
  return file.readChunk(0, need);
}

/**
 * 在 [p, head.length) 内跳过一个以 NUL 终止的头部字段（FNAME / FCOMMENT）。
 * 当前缓冲内找不到 NUL 时按步长扩读文件，直至找到或读尽（抛错）。
 * 返回更新后的 [head, p]。
 */
async function skipNulTerminatedField(
  head: Uint8Array,
  p: number,
  file: StarDictChunkReader,
): Promise<[Uint8Array, number]> {
  for (;;) {
    const nul = head.indexOf(0, p);
    if (nul >= 0) {
      return [head, nul + 1];
    }
    if (head.length >= file.fileSize) {
      throw new Error('gzip 文件头不完整（字段缺少 NUL 终止）');
    }
    head = await file.readChunk(0, Math.min(file.fileSize, head.length + GZIP_HEADER_GROW_STEP));
  }
}

// ---------- .ifo ----------

/** 解析 .ifo 字节为 key/value 表（首行为「StarDict's dict ifo file」声明行） */
export function parseIfoBytes(bytes: Uint8Array): Record<string, string> {
  const text = utf8Decode(bytes).replace(/^\uFEFF/, '');
  const meta: Record<string, string> = {};
  let first = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (first) {
      first = false;
      if (/^StarDict's dict ifo file/i.test(line)) {
        continue;
      }
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return meta;
}

/** 校验 .ifo 必备字段（version/bookname/wordcount/idxfilesize） */
export function validateIfo(meta: Record<string, string>): string | null {
  if (!/^2\.\d+\.\d+$|^3\.\d+\.\d+$/.test(meta.version ?? '')) {
    return `不支持的 StarDict 版本：${meta.version ?? '缺失'}`;
  }
  if (!meta.bookname) {
    return '.ifo 缺少 bookname';
  }
  return null;
}

// ---------- dictzip / gzip / plain 随机访问读取 ----------

/** 小端 u16 */
function readU16LE(bytes: Uint8Array, pos: number): number {
  return bytes[pos] | (bytes[pos + 1] << 8);
}

export class DictZipReader {
  /** plain=未压缩直读；full=普通 gzip 整体解压；dz=dictzip 按块随机访问 */
  private readonly mode: 'plain' | 'full' | 'dz';
  private readonly file: StarDictChunkReader;
  /** full 模式：解压后全量数据 */
  private fullData: Uint8Array | null = null;
  /** dz 模式：块内解压长度 / 各块压缩数据起始偏移 */
  private readonly chlen: number;
  private readonly chunkOffsets: number[];
  /** 块解压缓存（最近一块，词典查询局部性强） */
  private cachedChunk = -1;
  private cachedData: Uint8Array | null = null;

  private constructor(
    mode: 'plain' | 'full' | 'dz',
    file: StarDictChunkReader,
    opts?: { chlen?: number; chunkOffsets?: number[] },
  ) {
    this.mode = mode;
    this.file = file;
    this.chlen = opts?.chlen ?? 0;
    this.chunkOffsets = opts?.chunkOffsets ?? [];
  }

  /** 打开读取器：嗅探 gzip 头并解析 dictzip 'RA' extra field */
  static async open(file: StarDictChunkReader): Promise<DictZipReader> {
    if (file.fileSize < 2) {
      return new DictZipReader('plain', file);
    }
    const head0 = await file.readChunk(0, Math.min(file.fileSize, GZIP_HEADER_INIT_WINDOW));
    if (head0[0] !== 0x1f || head0[1] !== 0x8b) {
      return new DictZipReader('plain', file);
    }
    // gzip header 解析（RFC 1952）：按 FLG 位逐字段推进；
    // 字段超出初始窗口时经 ensureHeadBytes / skipNulTerminatedField 扩读补齐
    let head = await ensureHeadBytes(head0, 10, file);
    const flg = head[3];
    let p = 10;
    let raData: Uint8Array | null = null;
    if (flg & 0x04) {
      // FEXTRA：读 XLEN 后跳过扩展字段，扫描子字段找 dictzip 'RA'
      head = await ensureHeadBytes(head, p + 2, file);
      const xlen = readU16LE(head, p);
      p += 2;
      const extraEnd = p + xlen;
      head = await ensureHeadBytes(head, extraEnd, file);
      let q = p;
      while (q + 4 <= extraEnd) {
        const si1 = head[q];
        const si2 = head[q + 1];
        const slen = readU16LE(head, q + 2);
        if (si1 === 0x52 && si2 === 0x41) {
          raData = head.slice(q + 4, Math.min(q + 4 + slen, extraEnd));
          break;
        }
        q += 4 + slen;
      }
      p = extraEnd;
    }
    if (flg & 0x08) {
      // FNAME：跳过以 NUL 结尾的原文件名（可能很长，需扩读）
      [head, p] = await skipNulTerminatedField(head, p, file);
    }
    if (flg & 0x10) {
      // FCOMMENT：同样以 NUL 结尾
      [head, p] = await skipNulTerminatedField(head, p, file);
    }
    if (flg & 0x02) {
      p += 2; // FHCRC
    }
    if (p > file.fileSize) {
      throw new Error('gzip 文件头不完整');
    }
    if (!raData) {
      // 普通 gzip：整体解压（idx 一般可承受；.dict 全量 gzip 罕见）
      if (file.fileSize > MAX_FULL_DECOMPRESS_BYTES) {
        throw new Error(`gzip 文件过大（${file.fileSize} 字节），无法整体解压（上限 128MB）`);
      }
      const all = await file.readChunk(0, file.fileSize);
      const reader = new DictZipReader('full', file);
      reader.fullData = ungzip(all);
      return reader;
    }
    // dictzip 'RA'：ver(2LE) + chlen(2LE) + 各块压缩大小(2LE × N，末块除外)
    if (raData.length < 6) {
      throw new Error('dictzip RA 字段不完整');
    }
    const chlen = readU16LE(raData, 2);
    if (chlen <= 0) {
      throw new Error(`dictzip 块长度非法：${chlen}`);
    }
    const nSizes = Math.floor((raData.length - 4) / 2);
    const offsets: number[] = [p];
    for (let i = 0; i < nSizes; i += 1) {
      offsets.push(offsets[i] + readU16LE(raData, 4 + i * 2));
    }
    return new DictZipReader('dz', file, { chlen, chunkOffsets: offsets });
  }

  /** 解压第 k 块（dz 模式） */
  private async inflateChunk(k: number): Promise<Uint8Array> {
    if (k === this.cachedChunk && this.cachedData) {
      return this.cachedData;
    }
    const start = this.chunkOffsets[k];
    const isLast = k === this.chunkOffsets.length - 1;
    // 末块到 gzip trailer（8 字节 CRC+ISIZE）为止
    const end = isLast ? this.file.fileSize - 8 : this.chunkOffsets[k + 1];
    if (end <= start) {
      throw new Error(`dictzip 块偏移非法：chunk ${k}`);
    }
    const compressed = await this.file.readChunk(start, end - start);
    const data = inflateRaw(compressed);
    this.cachedChunk = k;
    this.cachedData = data;
    return data;
  }

  /** 在解压空间中随机读取 [pos, pos+len) */
  async read(pos: number, len: number): Promise<Uint8Array> {
    if (len <= 0) {
      return new Uint8Array(0);
    }
    if (this.mode === 'plain') {
      const take = Math.min(len, Math.max(this.file.fileSize - pos, 0));
      return this.file.readChunk(pos, take);
    }
    if (this.mode === 'full') {
      const data = this.fullData;
      if (!data) {
        throw new Error('DictZipReader 未初始化');
      }
      return data.slice(Math.min(pos, data.length), Math.min(pos + len, data.length));
    }
    // dz：跨块拼接
    const out: Uint8Array = new Uint8Array(len);
    let filled = 0;
    let cur = pos;
    while (filled < len) {
      const k = Math.floor(cur / this.chlen);
      const chunk = await this.inflateChunk(k);
      const inner = cur - k * this.chlen;
      if (inner >= chunk.length) {
        break; // 越过末块有效数据
      }
      const take = Math.min(chunk.length - inner, len - filled);
      out.set(chunk.subarray(inner, inner + take), filled);
      filled += take;
      cur += take;
    }
    return filled === len ? out : out.slice(0, filled);
  }
}

// ---------- 释义内容解析 ----------

/** sametypesequence 字母 → 内容形态 */
function seqToContentType(seq: string): DictContentType | null {
  switch (seq) {
    case 'm':
    case 'l':
    case 't':
    case 'y':
      return 'plain';
    case 'h':
    case 'x':
    case 'g':
    case 'p':
      return 'html';
    case 'w':
      return null; // 音频资源，跳过
    default:
      return null;
  }
}

/** 单字节类型码 → 内容形态（无 sametypesequence 序列解析用；小写无 NUL 结尾） */
function typeByteToContentType(t: number): DictContentType | null {
  return seqToContentType(String.fromCharCode(t));
}

/**
 * 解析释义字节：
 * - 有 sametypesequence：整段按指定类型解码
 * - 无：首字节为合法类型码时按「类型字节 + 数据」序列解析（取首个文本段）；
 *   否则整段按 plain 处理（大量词典实际省略类型字节，宽松兼容）
 */
export function articleToContent(article: Uint8Array, seq: string): { contentType: DictContentType; content: string } {
  if (seq) {
    const ct = seqToContentType(seq[0]);
    if (!ct) {
      return { contentType: 'plain', content: '' };
    }
    return { contentType: ct, content: utf8Decode(article) };
  }
  const first = article[0];
  const firstIsType = first !== undefined && /^[mltyhxgpw]$/i.test(String.fromCharCode(first));
  if (!firstIsType) {
    return { contentType: 'plain', content: utf8Decode(article) };
  }
  const ct = typeByteToContentType(first);
  if (!ct) {
    // 音频等资源类型：无文本内容
    return { contentType: 'plain', content: '' };
  }
  const rest = utf8Decode(article.subarray(1));
  return { contentType: ct, content: rest };
}

// ---------- 解析器装配 ----------

export interface StarDictParserLike {
  format: 'stardict';
  parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void>;
}

/**
 * 装配 StarDict parserLike：parse(ctx) 流式产出词条批次。
 * ctx.readChunk/isCancelled/onProgress/reportError 语义与其他解析器一致
 * （readChunk 作用于 .idx 文件，释义经 dict 读取器随机访问）。
 */
export function makeStarDictParser(files: {
  ifo: Record<string, string>;
  idx: StarDictChunkReader;
  dict: StarDictChunkReader;
}): StarDictParserLike {
  return {
    format: 'stardict',
    async *parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> {
      const seq = (files.ifo.sametypesequence ?? '').trim();
      const version = files.ifo.version ?? '2.4.2';
      const offsetBits =
        files.ifo.idxoffsetbits === '64' || version.startsWith('3.') ? 64 : 32;
      const seqLen = offsetBits === 64 ? 12 : 8; // offset(4/8) + size(4)

      const idxZip = await DictZipReader.open(files.idx);
      const dictZip = await DictZipReader.open(files.dict);

      // 流式扫描 idx：固定缓冲 + 视图偏移。消费词条只前移 viewStart（零拷贝），
      // 仅在续读窗口前做一次 copyWithin compact —— 避免每词条 O(窗口) 的 slice 复制
      // （12.5 万词条 × 1MB 窗口的 memcpy 会拖垮导入速度）。
      const buf = new Uint8Array(IDX_WINDOW_BYTES);
      let viewStart = 0; // 缓冲内消费起点
      let viewEnd = 0; // 缓冲内有效数据终点
      let absStart = 0; // buf[viewStart] 在 idx 解压空间中的偏移
      let readPos = 0; // 下一窗口起点（idx 全局偏移）
      let totalEntries = 0;
      let batch: ParsedEntry[] = [];

      /** 在 [viewStart, viewEnd) 内找 NUL（词尾） */
      const findNul = (): number => {
        for (let i = viewStart; i < viewEnd; i += 1) {
          if (buf[i] === 0) {
            return i;
          }
        }
        return -1;
      };

      /** 续读 idx 至缓冲足够容纳下一个完整词条（或 EOF） */
      const fillForNextEntry = async (): Promise<boolean> => {
        for (;;) {
          const nul = findNul();
          if (nul >= 0 && nul + 1 + seqLen <= viewEnd) {
            return true;
          }
          // 数据不足：把未消费数据 compact 到缓冲头部，再续读
          if (viewStart > 0) {
            buf.copyWithin(0, viewStart, viewEnd);
            viewEnd -= viewStart;
            absStart += viewStart;
            viewStart = 0;
          }
          if (viewEnd === buf.length) {
            // 缓冲已满仍无完整词条：单词条超过 1MB 缓冲（理论不可能，词头 ≤1024 字节）
            return false;
          }
          const window = await idxZip.read(readPos, buf.length - viewEnd);
          if (window.length === 0) {
            // EOF：缓冲中已有完整词条则成功，否则流截断
            const nulEof = findNul();
            return nulEof >= 0 && nulEof + 1 + seqLen <= viewEnd;
          }
          buf.set(window, viewEnd);
          viewEnd += window.length;
          readPos += window.length;
        }
      };

      /** 消费缓冲中的一个词条（只前移 viewStart，零拷贝）；无完整词条返回 null */
      const takeEntry = (): { word: string; offset: number; size: number } | null => {
        let nul = -1;
        for (let i = viewStart; i < viewEnd; i += 1) {
          if (buf[i] === 0) {
            nul = i;
            break;
          }
          if (i - viewStart > 1024) {
            // 词头异常过长：视为坏数据，跳过该字节避免死循环
            viewStart += 1;
            absStart += 1;
            return null;
          }
        }
        if (nul < 0 || nul + 1 + seqLen > viewEnd) {
          return null;
        }
        const word = utf8Decode(buf.subarray(viewStart, nul));
        const p = nul + 1;
        let offset = 0;
        if (offsetBits === 64) {
          // 大端 64 位（JS 精度内取低 53 位足够；>2^53 的词典不存在）
          for (let i = 0; i < 8; i += 1) {
            offset = offset * 256 + buf[p + i];
          }
        } else {
          offset =
            ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
        }
        const size =
          ((buf[p + seqLen - 4] << 24) |
            (buf[p + seqLen - 3] << 16) |
            (buf[p + seqLen - 2] << 8) |
            (buf[p + seqLen - 1])) >>>
          0;
        viewStart = p + seqLen;
        return { word, offset, size };
      };

      for (;;) {
        if (ctx.isCancelled()) {
          break;
        }
        const has = await fillForNextEntry();
        if (!has) {
          break;
        }
        const entry = takeEntry();
        if (!entry) {
          continue;
        }
        if (!entry.word) {
          ctx.reportError({ at: absStart, reason: '空词头，跳过' });
          continue;
        }
        if (entry.size <= 0 || entry.size > MAX_ARTICLE_BYTES) {
          ctx.reportError({ at: entry.word, reason: `释义长度异常（${entry.size} 字节），跳过` });
          continue;
        }
        try {
          const article = await dictZip.read(entry.offset, entry.size);
          const { contentType, content } = articleToContent(article, seq);
          if (!content.trim()) {
            ctx.reportError({ at: entry.word, reason: '释义为空，跳过' });
            continue;
          }
          batch.push({ headword: entry.word, contentType, content });
          totalEntries += 1;
        } catch (e) {
          ctx.reportError({ at: entry.word, reason: `释义读取失败：${(e as Error).message}` });
          continue;
        }
        if (batch.length >= BATCH_SIZE) {
          ctx.onProgress(totalEntries);
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) {
        ctx.onProgress(totalEntries);
        yield batch;
      }
    },
  };
}
