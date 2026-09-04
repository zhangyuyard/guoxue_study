/**
 * MDict 解析器（MDictParser）
 * .mdx / .mdd 容器解析（engine v1 / v2；v3 不在 P0 范围）：
 *   - 头部：BE u32 头长 + UTF-16LE/UTF-8 XML 属性 + LE adler32
 *   - key block info：v2 zlib 压缩（encrypt&2 时 fast_decrypt 解密）
 *   - key blocks / record blocks：块级 zlib / 无压缩 / LZO（LZO 明确不支持）
 *   - encrypt=1/3（记录加密，无注册码）：brutal-force 扫描 key block 边界
 * 格式细节参考 mdict-analysis/readmdict.py 与 zhansliu/writemdict 的格式披露（仅格式参考）。
 * 解析器为纯逻辑（仅依赖注入的 readChunk），单测零原生 mock。
 */
import { inflate } from '@/vendor/inflate';
import {
  PARSER_REGISTRY,
  fileExt,
  utf16leDecode,
  utf8Decode,
  type DictParser,
  type DictParserContext,
  type ParsedEntry,
} from './types';
import { decryptHeaderBlock, fastDecrypt, ripemd128, salsaDecryptWithAdlerKey } from './MDictCrypto';

/** 分块读取大小（4MB） */
const CHUNK_SIZE = 4 * 1024 * 1024;
/** 单批最大条数 */
const BATCH_SIZE = 1000;
/** key block 起始标记（zlib 压缩类型 BE u32 = 2） */
const ZLIB_BLOCK_MARKER = new Uint8Array([0x02, 0x00, 0x00, 0x00]);

// ============ 缓冲读取器（顺序读取为主） ============

class ChunkReader {
  private buf: Uint8Array = new Uint8Array(0);
  private bufStart = 0;
  private posVal = 0;

  constructor(private readonly ctx: DictParserContext) {}

  get position(): number {
    return this.posVal;
  }

  /** 确保 [pos, pos+n) 在缓冲内（不足则从 pos 处重载） */
  private async fill(n: number): Promise<void> {
    if (this.posVal + n <= this.bufStart + this.buf.length) {
      return;
    }
    const take = Math.min(this.ctx.fileSize - this.posVal, Math.max(CHUNK_SIZE, n));
    this.buf = await this.ctx.readChunk(this.posVal, Math.max(take, 0));
    this.bufStart = this.posVal;
  }

  async readBytes(n: number): Promise<Uint8Array> {
    if (n <= 0) {
      return new Uint8Array(0);
    }
    await this.fill(n);
    const start = this.posVal - this.bufStart;
    if (start + n > this.buf.length) {
      // 文件尾不足 n：返回剩余部分
      this.posVal = this.bufStart + this.buf.length;
      return this.buf.slice(start);
    }
    this.posVal += n;
    return this.buf.slice(start, start + n);
  }

  /** 从当前位置回退 n 字节（brutal-force 扫描修正用） */
  seekBackward(n: number): void {
    this.posVal = Math.max(0, this.posVal - n);
  }

  async readUint32BE(): Promise<number> {
    const b = await this.readBytes(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
}

// ============ 头部模型 ============

interface MDictHeaderInfo {
  version: number;
  encoding: 'utf-8' | 'utf-16';
  encrypt: number;
}

/** 解析头部 XML 属性 */
function parseHeaderAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = m[2]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return attrs;
}

// ============ 块解码 ============

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** 块级解压/解密（key block 与 record block 共用）；LZO 抛可读错误 */
function decodeBlock(block: Uint8Array, decompressedSize: number): Uint8Array {
  if (block.length < 8) {
    throw new Error(`词典数据块过短（${block.length} 字节），文件可能已损坏`);
  }
  const info = (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;
  const compressionMethod = info & 0xf;
  const encryptionMethod = (info >> 4) & 0xf;
  const encryptionSize = (info >> 8) & 0xff;

  const adlerBytes = block.slice(4, 8);
  let data: Uint8Array = block.slice(8);

  if (encryptionMethod === 1) {
    const enc = data.slice(0, encryptionSize);
    const rest = data.slice(encryptionSize);
    data = concat(fastDecrypt(enc, ripemd128(adlerBytes)), rest);
  } else if (encryptionMethod === 2) {
    const enc = data.slice(0, encryptionSize);
    const rest = data.slice(encryptionSize);
    data = concat(salsaDecryptWithAdlerKey(adlerBytes, enc), rest);
  } else if (encryptionMethod !== 0) {
    throw new Error(`暂不支持的数据块加密方式（encryption=${encryptionMethod}）`);
  }

  if (compressionMethod === 0) {
    return data;
  }
  if (compressionMethod === 2) {
    return inflate(data);
  }
  if (compressionMethod === 1) {
    throw new Error('暂不支持 LZO 压缩的词典数据块（请使用 zlib 压缩或未压缩版本）');
  }
  throw new Error(`暂不支持的数据块压缩方式（compression=${compressionMethod}，期望解压后 ${decompressedSize} 字节）`);
}

/** 子串查找（字节级） */
function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** 依据资源名推断 MIME */
function guessMime(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.mp3')) {
    return 'audio/mpeg';
  }
  if (lower.endsWith('.wav')) {
    return 'audio/wav';
  }
  if (lower.endsWith('.css')) {
    return 'text/css';
  }
  return 'application/octet-stream';
}

/** 字节 → base64 */
function bytesToBase64Local(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

// ============ 解析器实现 ============

interface KeyItem {
  id: number;
  text: string;
}

interface BlockSizeInfo {
  compressedSize: number;
  decompressedSize: number;
}

class MDictParserImpl implements DictParser {
  readonly format: 'mdx' | 'mdd';

  constructor(format: 'mdx' | 'mdd') {
    this.format = format;
  }

  sniff(fileName: string): boolean {
    const ext = fileExt(fileName);
    if (ext === 'mdx') {
      return this.format === 'mdx';
    }
    if (ext === 'mdd') {
      return this.format === 'mdd';
    }
    return false;
  }

  async *parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> {
    const reader = new ChunkReader(ctx);

    // ---- 1) 头部 ----
    const headerSize = await reader.readUint32BE();
    if (headerSize <= 0 || headerSize > 10 * 1024 * 1024) {
      throw new Error('词典文件头部长度非法，可能不是有效的 MDX/MDD 文件');
    }
    const headerBytes = await reader.readBytes(headerSize);
    await reader.readBytes(4); // 头部 adler32（LE，宽松校验不中断）

    const isUtf16Header =
      headerBytes.length >= 2 &&
      headerBytes[headerBytes.length - 1] === 0 &&
      headerBytes[headerBytes.length - 2] === 0;
    const headerText = isUtf16Header
      ? utf16leDecode(headerBytes, 0, headerBytes.length - 2)
      : utf8Decode(headerBytes, 0, Math.max(0, headerBytes.length - 1));
    const attrs = parseHeaderAttrs(headerText);

    const header = this.buildHeaderInfo(attrs);
    const numberWidth = header.version >= 2 ? 8 : 4;

    // ---- 2) key block 头部数字（encrypt&1 时无法读取 → brutal force） ----
    let keyBlockInfoList: BlockSizeInfo[];
    let keyBlockSize: number;

    if (header.encrypt & 1) {
      // encrypt=1/3：数字区被 Salsa20 加密且无注册码 → 跳过并扫描 key block 边界
      const brute = await this.brutalForceKeyBlockInfo(reader, header, ctx);
      keyBlockInfoList = brute.infoList;
      keyBlockSize = brute.keyBlockSize;
    } else {
      const numBytesCount = header.version >= 2 ? 5 : 4;
      await reader.readBytes(numberWidth * numBytesCount);
      if (header.version >= 2) {
        await reader.readBytes(4); // 数字区 adler32
      }
      const keyBlockInfoSize = await this.readNumber(reader, numberWidth);
      keyBlockSize = await this.readNumber(reader, numberWidth);
      let keyBlockInfoRaw = await reader.readBytes(keyBlockInfoSize);
      if (header.version >= 2 && header.encrypt & 2) {
        keyBlockInfoRaw = decryptHeaderBlock(keyBlockInfoRaw);
      }
      keyBlockInfoList = this.decodeKeyBlockInfo(keyBlockInfoRaw, header.version, header.encoding, numberWidth);
    }

    // ---- 3) key blocks ----
    const keys = await this.readKeyBlocks(reader, keyBlockSize, keyBlockInfoList, numberWidth, header.encoding);

    // ---- 4) record blocks（流式产出） ----
    yield* this.readRecordBlocks(reader, keys, numberWidth, header.encoding, ctx);
  }

  /** 头部属性 → 解析参数（版本/编码/加密标志） */
  private buildHeaderInfo(attrs: Record<string, string>): MDictHeaderInfo {
    const version = Number.parseFloat(attrs.GeneratedByEngineVersion ?? '1.2');
    if (!Number.isFinite(version)) {
      throw new Error('词典头部缺少有效的 GeneratedByEngineVersion 属性');
    }
    if (version >= 3) {
      throw new Error('暂不支持 MDict 3.0 格式（仅支持 1.x / 2.x）');
    }
    const encAttr = (attrs.Encoding ?? 'UTF-8').toUpperCase();
    if (!(encAttr.includes('UTF-16') || encAttr.includes('UTF-8') || encAttr === '')) {
      throw new Error(`暂不支持词典编码 ${encAttr}（当前仅支持 UTF-8 / UTF-16）`);
    }
    const encoding: 'utf-8' | 'utf-16' = encAttr.includes('UTF-16') ? 'utf-16' : 'utf-8';

    let encrypt = 0;
    if (attrs.Encrypted !== undefined) {
      if (attrs.Encrypted === 'Yes') {
        encrypt = 1;
      } else if (attrs.Encrypted !== 'No') {
        encrypt = Number.parseInt(attrs.Encrypted, 10) || 0;
      }
    }
    if (encrypt !== 0 && encrypt !== 1 && encrypt !== 2 && encrypt !== 3) {
      throw new Error(`暂不支持该词典的加密方式（Encrypted=${attrs.Encrypted}）`);
    }
    return { version, encoding, encrypt };
  }

  /** 读一个宽度自适应无符号整数（BE） */
  private async readNumber(reader: ChunkReader, numberWidth: number): Promise<number> {
    const b = await reader.readBytes(numberWidth);
    if (b.length < numberWidth) {
      throw new Error('词典文件意外结束（读取数字区失败）');
    }
    return this.readNumberFromBytes(b, numberWidth);
  }

  private readNumberFromBytes(b: Uint8Array, numberWidth: number): number {
    if (numberWidth === 4) {
      return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    }
    const hi = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const lo = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | (b[7]) >>> 0) >>> 0;
    return hi * 0x100000000 + lo;
  }

  /**
   * brutal force：跳过被加密的数字区，扫描 key block 起始标记（02 00 00 00）
   * 以确定 key block info 边界（参考 readmdict._read_keys_brutal 思路）。
   */
  private async brutalForceKeyBlockInfo(
    reader: ChunkReader,
    header: MDictHeaderInfo,
    ctx: DictParserContext,
  ): Promise<{ infoList: BlockSizeInfo[]; keyBlockSize: number }> {
    const numberWidth = header.version >= 2 ? 8 : 4;
    // 跳过数字区 + adler32
    const skip = header.version >= 2 ? 8 * 5 + 4 : 4 * 4;
    await reader.readBytes(skip);

    // key block info 区起始 8 字节（02 00 00 00 + adler32）
    let infoBytes = await reader.readBytes(8);
    if (findSubarray(infoBytes, ZLIB_BLOCK_MARKER) !== 0) {
      throw new Error('加密词典结构异常：未找到 key block info 起始标记');
    }

    for (;;) {
      if (ctx.isCancelled()) {
        throw new Error('导入已取消');
      }
      const win = await reader.readBytes(4096);
      if (win.length === 0) {
        throw new Error('加密词典结构异常：未找到 key block 起始标记');
      }
      const idx = findSubarray(win, ZLIB_BLOCK_MARKER);
      if (idx >= 0) {
        infoBytes = concat(infoBytes, win.slice(0, idx));
        // reader 已越过标记，回退使其指向第一个 key block
        reader.seekBackward(win.length - idx);
        break;
      }
      infoBytes = concat(infoBytes, win);
    }

    const infoList = this.decodeKeyBlockInfo(infoBytes, header.version, header.encoding, numberWidth);
    const keyBlockSize = infoList.reduce((sum, b) => sum + b.compressedSize, 0);
    return { infoList, keyBlockSize };
  }

  /** 解码 key block info 区（v2 zlib，可能已解密；v1 原样） */
  private decodeKeyBlockInfo(
    raw: Uint8Array,
    version: number,
    encoding: 'utf-8' | 'utf-16',
    numberWidth: number,
  ): BlockSizeInfo[] {
    let bytes = raw;
    if (version >= 2) {
      if (findSubarray(bytes.subarray(0, 4), ZLIB_BLOCK_MARKER) !== 0) {
        throw new Error('词典 key block info 区格式异常（缺少 zlib 标记）');
      }
      bytes = inflate(bytes.subarray(8));
    }

    const list: BlockSizeInfo[] = [];
    let i = 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const textWidth = encoding === 'utf-16' ? 2 : 1;
    const sizeWidth = version >= 2 ? 2 : 1; // v1 用 1 字节文本长度，v2 用 2 字节
    while (i + numberWidth <= bytes.length) {
      i += numberWidth; // 块内词条数
      if (i + sizeWidth > bytes.length) {
        break;
      }
      // text head
      const headSize = sizeWidth === 2 ? dv.getUint16(i, false) : bytes[i];
      i += sizeWidth;
      i += version >= 2 ? (headSize + 1) * textWidth : headSize;
      // text tail
      if (i + sizeWidth > bytes.length) {
        break;
      }
      const tailSize = sizeWidth === 2 ? dv.getUint16(i, false) : bytes[i];
      i += sizeWidth;
      i += version >= 2 ? (tailSize + 1) * textWidth : tailSize;
      // 压缩/解压尺寸
      if (i + numberWidth * 2 > bytes.length) {
        break;
      }
      const compressedSize = this.readNumberAt(dv, i, numberWidth);
      i += numberWidth;
      const decompressedSize = this.readNumberAt(dv, i, numberWidth);
      i += numberWidth;
      list.push({ compressedSize, decompressedSize });
    }
    if (list.length === 0) {
      throw new Error('词典 key block info 解析结果为空');
    }
    return list;
  }

  /** 从 DataView 指定偏移读 BE 无符号整数 */
  private readNumberAt(dv: DataView, offset: number, numberWidth: number): number {
    if (numberWidth === 4) {
      return dv.getUint32(offset, false);
    }
    const hi = dv.getUint32(offset, false);
    const lo = dv.getUint32(offset + 4, false);
    return hi * 0x100000000 + lo;
  }

  /** 读取并切分全部 key blocks */
  private async readKeyBlocks(
    reader: ChunkReader,
    keyBlockSize: number,
    infoList: BlockSizeInfo[],
    numberWidth: number,
    encoding: 'utf-8' | 'utf-16',
  ): Promise<KeyItem[]> {
    const keys: KeyItem[] = [];
    let remaining = keyBlockSize;
    for (const info of infoList) {
      const take = Math.min(info.compressedSize, remaining);
      if (take <= 0) {
        break;
      }
      const block = await reader.readBytes(take);
      remaining -= block.length;
      const decompressed = decodeBlock(block, info.decompressedSize);
      this.splitKeyBlock(decompressed, keys, numberWidth, encoding);
    }
    return keys;
  }

  /** 切分单个 key block 为 (recordOffset, keyText) 列表 */
  private splitKeyBlock(
    block: Uint8Array,
    keys: KeyItem[],
    numberWidth: number,
    encoding: 'utf-8' | 'utf-16',
  ): void {
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const step = encoding === 'utf-16' ? 2 : 1;
    let i = 0;
    while (i + numberWidth <= block.length) {
      const keyId = this.readNumberAt(dv, i, numberWidth);
      i += numberWidth;
      const textStart = i;
      let textEnd = -1;
      while (i + step <= block.length) {
        const code = step === 2 ? dv.getUint16(i, true) : block[i];
        if (code === 0) {
          textEnd = i;
          break;
        }
        i += step;
      }
      if (textEnd < 0) {
        break;
      }
      const text =
        encoding === 'utf-16'
          ? utf16leDecode(block, textStart, textEnd)
          : utf8Decode(block, textStart, textEnd);
      keys.push({ id: keyId, text: text.trim() });
      i = textEnd + step;
    }
  }

  /** record blocks：流式解码并按 key 偏移切分，产出词条 */
  private async *readRecordBlocks(
    reader: ChunkReader,
    keys: KeyItem[],
    numberWidth: number,
    encoding: 'utf-8' | 'utf-16',
    ctx: DictParserContext,
  ): AsyncGenerator<ParsedEntry[], void, void> {
    const numRecordBlocks = await this.readNumber(reader, numberWidth);
    await this.readNumber(reader, numberWidth); // num_entries（宽松校验）
    const recordBlockInfoSize = await this.readNumber(reader, numberWidth);
    await this.readNumber(reader, numberWidth); // record_block_size 总量

    // record block info：每块 (compressedSize, decompressedSize)
    const infos: BlockSizeInfo[] = [];
    let infoRead = 0;
    while (infoRead < recordBlockInfoSize && infos.length < numRecordBlocks) {
      const compressedSize = await this.readNumber(reader, numberWidth);
      const decompressedSize = await this.readNumber(reader, numberWidth);
      infos.push({ compressedSize, decompressedSize });
      infoRead += numberWidth * 2;
    }

    let offset = 0;
    let keyIdx = 0;
    let batch: ParsedEntry[] = [];
    let emitted = 0;

    for (const info of infos) {
      if (ctx.isCancelled()) {
        return;
      }
      const blockBytes = await reader.readBytes(info.compressedSize);
      const block = decodeBlock(blockBytes, info.decompressedSize);

      while (keyIdx < keys.length) {
        const recordStart = keys[keyIdx].id;
        if (recordStart - offset >= block.length) {
          break;
        }
        const recordEnd = keyIdx + 1 < keys.length ? keys[keyIdx + 1].id : block.length + offset;
        const from = recordStart - offset;
        const to = Math.max(recordEnd - offset, from);
        const data = block.subarray(from, to);
        const keyText = keys[keyIdx].text;
        keyIdx += 1;

        if (this.format === 'mdd') {
          batch.push({
            headword: keyText,
            contentType: 'plain',
            content: '',
            resource: {
              mime: guessMime(keyText),
              sizeBytes: data.length,
              dataBase64: bytesToBase64Local(data),
            },
          });
        } else if (encoding === 'utf-16') {
          batch.push({
            headword: keyText,
            contentType: 'html',
            content: utf16leDecode(data).replace(/\x00/g, '').trim(),
          });
        } else {
          batch.push({
            headword: keyText,
            contentType: 'html',
            content: utf8Decode(data).replace(/\x00/g, '').trim(),
          });
        }

        if (batch.length >= BATCH_SIZE) {
          emitted += batch.length;
          ctx.onProgress(emitted);
          yield batch;
          batch = [];
        }
      }
      offset += block.length;
    }

    if (batch.length > 0) {
      emitted += batch.length;
      ctx.onProgress(emitted);
      yield batch;
    }
  }
}

export const mdxParser = new MDictParserImpl('mdx');
export const mddParser = new MDictParserImpl('mdd');

// 注册进扩展点（DictImportService 按 PARSER_REGISTRY 分发）
PARSER_REGISTRY.push(mdxParser, mddParser);

export const MDictParser = {
  mdxParser,
  mddParser,
};

export default MDictParser;
