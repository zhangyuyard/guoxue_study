/**
 * StarDictParser 单测（node 直跑，零 mock）
 * 覆盖：.ifo 解析/校验、plain 与 dictzip 读取、32/64 位索引、
 * 无 sametypesequence 序列解析、取消与坏数据容错。
 */
import { deflateRaw } from 'pako';

import { utf8Encode } from '@/test-utils/utf8';
import {
  DictZipReader,
  articleToContent,
  makeStarDictParser,
  parseIfoBytes,
  validateIfo,
  type StarDictChunkReader,
} from '@/services/dict/parsers/StarDictParser';
import type { ParsedEntry } from '@/services/dict/parsers/types';

/** Uint8Array → 零 mock 文件句柄 */
function readerFromBytes(bytes: Uint8Array): StarDictChunkReader {
  return {
    fileSize: bytes.length,
    readChunk: async (pos: number, len: number) => bytes.slice(pos, pos + len),
  };
}

/** .ifo 文本 → 字节 */
function buildIfo(meta: Record<string, string>): Uint8Array {
  const lines = ["StarDict's dict ifo file", ...Object.entries(meta).map(([k, v]) => `${k}=${v}`)];
  return utf8Encode(lines.join('\n') + '\n');
}

interface IdxEntrySpec {
  word: string;
  offset: number;
  size: number;
}

/** 构造 .idx 字节（大端 offset 4/8 字节 + size 4 字节） */
function buildIdx(entries: IdxEntrySpec[], bits: 32 | 64 = 32): Uint8Array {
  const parts: number[] = [];
  const pushBE = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i -= 1) {
      parts.push(Math.floor(value / 256 ** i) & 0xff);
    }
  };
  for (const e of entries) {
    for (const b of utf8Encode(e.word)) {
      parts.push(b);
    }
    parts.push(0);
    pushBE(e.offset, bits === 64 ? 8 : 4);
    pushBE(e.size, 4);
  }
  return new Uint8Array(parts);
}

/** 构造 dictzip 字节：每块独立 deflateRaw + gzip 头（'RA' extra field）+ 8 字节尾 */
function buildDictzip(chunks: Uint8Array[], chlen = 64): Uint8Array {
  const compressed = chunks.map((c) => deflateRaw(c));
  // RA data: ver(2LE) + chlen(2LE) + 除末块外各块压缩大小(2LE)
  const nSizes = chunks.length - 1;
  const raLen = 4 + nSizes * 2; // 'RA' 子字段数据长度（ver+chlen+sizes）
  const xlen = raLen + 4; // RFC 1952：XLEN 含 SI1/SI2/SLEN 共 4 字节头
  const out: number[] = [];
  // gzip 头：magic + CM=8 + FLG=FEXTRA + mtime(4) + XFL + OS
  out.push(0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff);
  // XLEN
  out.push(xlen & 0xff, (xlen >> 8) & 0xff);
  // 'R' 'A' + SLEN
  out.push(0x52, 0x41, raLen & 0xff, (raLen >> 8) & 0xff);
  // ver=1 + chlen
  out.push(1, 0, chlen & 0xff, (chlen >> 8) & 0xff);
  for (let i = 0; i < nSizes; i += 1) {
    const sz = compressed[i].length;
    out.push(sz & 0xff, (sz >> 8) & 0xff);
  }
  const head = new Uint8Array(out);
  const bodyParts: Uint8Array[] = [head, ...compressed];
  // trailer：CRC32 + ISIZE 共 8 字节（DictZipReader 不校验 trailer，填零即可）
  bodyParts.push(new Uint8Array(8));
  const total = bodyParts.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of bodyParts) {
    all.set(p, off);
    off += p.length;
  }
  return all;
}

/** 收集 parser 全部产物（idx/dict 允许直接传字节） */
async function collect(
  ifo: Record<string, string>,
  idx: Uint8Array | StarDictChunkReader,
  dict: Uint8Array | StarDictChunkReader,
  opts?: { isCancelled?: () => boolean; reportError?: (e: { at?: number | string; reason: string }) => void },
): Promise<ParsedEntry[]> {
  const idxReader = idx instanceof Uint8Array ? readerFromBytes(idx) : idx;
  const dictReader = dict instanceof Uint8Array ? readerFromBytes(dict) : dict;
  const entries: ParsedEntry[] = [];
  const gen = makeStarDictParser({ ifo, idx: idxReader, dict: dictReader }).parse({
    fileSize: idxReader.fileSize,
    readChunk: idxReader.readChunk,
    onProgress: () => undefined,
    isCancelled: opts?.isCancelled ?? (() => false),
    reportError: opts?.reportError ?? (() => undefined),
  });
  for await (const batch of gen) {
    entries.push(...batch);
  }
  return entries;
}

const BASE_IFO = {
  version: '2.4.2',
  wordcount: '3',
  idxfilesize: '100',
  bookname: 'Test Dict',
};

describe('parseIfoBytes / validateIfo', () => {
  it('解析 key=value 并跳过声明行与 BOM', () => {
    const meta = parseIfoBytes(buildIfo(BASE_IFO));
    expect(meta.version).toBe('2.4.2');
    expect(meta.bookname).toBe('Test Dict');
    expect(meta.wordcount).toBe('3');
  });

  it('validateIfo：合法通过、缺 bookname / 坏版本报错', () => {
    expect(validateIfo(BASE_IFO)).toBeNull();
    expect(validateIfo({ ...BASE_IFO, bookname: '' })).toContain('bookname');
    expect(validateIfo({ ...BASE_IFO, version: '9.9' })).toContain('版本');
  });
});

describe('plain .idx + plain .dict', () => {
  const articles = [utf8Encode('a translation'), utf8Encode('<b>hello</b> def')];
  const idx = buildIdx([
    { word: 'alpha', offset: 0, size: articles[0].length },
    { word: 'beta', offset: articles[0].length, size: articles[1].length },
  ]);
  const dict = (() => {
    const all = new Uint8Array(articles[0].length + articles[1].length);
    all.set(articles[0], 0);
    all.set(articles[1], articles[0].length);
    return all;
  })();

  it('无 sametypesequence 且首字节非类型码：整段按 plain', async () => {
    const entries = await collect(BASE_IFO, idx, dict);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ headword: 'alpha', contentType: 'plain', content: 'a translation' });
    expect(entries[1]).toMatchObject({ headword: 'beta', contentType: 'plain', content: '<b>hello</b> def' });
  });

  it('sametypesequence=h：html 内容', async () => {
    const ifo = { ...BASE_IFO, sametypesequence: 'h' };
    const entries = await collect(ifo, idx, dict);
    expect(entries[0].contentType).toBe('html');
    expect(entries[0].content).toBe('a translation');
  });
});

describe('dictzip .dict.dz 随机访问', () => {
  // 两个 64 字节块：块 0 填充 + 词条 1，块 1 词条 2
  const text0 = utf8Encode('零一二三四五六七八九'.slice(0, 1).repeat(3)); // 短文本
  const _pad0 = new Uint8Array(64 - text0.length); // 块内填充
  const text1 = utf8Encode('second entry meaning');
  const chunk0 = (() => {
    const c = new Uint8Array(64);
    c.set(text0, 0);
    return c;
  })();
  const chunk1 = (() => {
    const c = new Uint8Array(64);
    c.set(text1, 0);
    return c;
  })();
  const dictDz = buildDictzip([chunk0, chunk1], 64);
  const idx = buildIdx([
    { word: 'one', offset: 0, size: text0.length },
    { word: 'two', offset: 64, size: text1.length },
  ]);

  it('DictZipReader.open 识别 dz 并按块解压', async () => {
    const r = await DictZipReader.open(readerFromBytes(dictDz));
    expect(r).toBeInstanceOf(DictZipReader);
    const part = await r.read(0, text0.length);
    expect(part.length).toBe(text0.length);
    expect(Array.from(part)).toEqual(Array.from(text0));
    const part2 = await r.read(64, text1.length);
    expect(Array.from(part2)).toEqual(Array.from(text1));
  });

  it('成组解析：dict.dz 下词条内容正确', async () => {
    const entries = await collect(BASE_IFO, idx, readerFromBytes(dictDz));
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('零零零');
    expect(entries[1].content).toBe('second entry meaning');
  });

  it('跨块读取（offset 落在块边界附近）', async () => {
    const r = await DictZipReader.open(readerFromBytes(dictDz));
    const cross = await r.read(60, 10); // 块 0 末 4 字节 + 块 1 首 6 字节
    expect(cross.length).toBe(10);
    expect(Array.from(cross.slice(4))).toEqual(Array.from(text1.slice(0, 6)));
  });
});

describe('idxoffsetbits=64 与无 sametypesequence', () => {
  it('64 位大端 offset 正确寻址', async () => {
    const article = utf8Encode('long definition at high offset');
    const idx = buildIdx([{ word: 'word', offset: article.length + 5, size: article.length }], 64);
    const dict = (() => {
      const all = new Uint8Array(article.length + 5 + article.length);
      all.set(article, article.length + 5);
      return all;
    })();
    const ifo = { ...BASE_IFO, idxoffsetbits: '64', sametypesequence: 'm' };
    const entries = await collect(ifo, idx, dict);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('long definition at high offset');
  });

  it('无 sametypesequence：按类型字节序列解析（m 段）', async () => {
    const article = (() => {
      const text = utf8Encode('plain via type byte');
      const out = new Uint8Array(text.length + 1);
      out[0] = 'm'.charCodeAt(0);
      out.set(text, 1);
      return out;
    })();
    const idx = buildIdx([{ word: 'entry', offset: 0, size: article.length }]);
    const entries = await collect(BASE_IFO, idx, readerFromBytes(article));
    expect(entries).toHaveLength(1);
    expect(articleToContent(article, '')).toMatchObject({ contentType: 'plain', content: 'plain via type byte' });
    expect(entries[0].content).toBe('plain via type byte');
  });
});

describe('gzip 头边界：FEXTRA 贴近 65535 上限 + 长 FNAME（超 64KB 初始窗口）', () => {
  /**
   * 构造头部总长 > 65536（初始窗口）的 dictzip：
   * 10(基本头) + 2(XLEN) + 65535(FEXTRA) + 128(FNAME) + 1(NUL) = 65676 字节。
   * FEXTRA 内含 'RA' 子字段 + 一个大填充子字段（SI1/SI2 非 'RA'）。
   */
  function buildDictzipBigHeader(chunks: Uint8Array[], chlen = 64): Uint8Array {
    const compressed = chunks.map((c) => deflateRaw(c));
    const nSizes = chunks.length - 1;
    const raLen = 4 + nSizes * 2; // ver(2LE) + chlen(2LE) + sizes(2LE×N)
    const fname = 'very-long-dictionary-file-name-'.repeat(4); // 128 字节
    // XLEN = Σ(4 + SLEN)：'RA' 子字段 (4+raLen) + 填充子字段 (4+padLen) = 65535
    const padLen = 65535 - (4 + raLen) - 4;
    const out: number[] = [];
    // gzip 头：magic + CM=8 + FLG=FEXTRA|FNAME + mtime(4) + XFL + OS
    out.push(0x1f, 0x8b, 0x08, 0x04 | 0x08, 0, 0, 0, 0, 0, 0xff);
    // XLEN = 65535
    out.push(0xff, 0xff);
    // 'RA' 子字段：SI1 SI2 SLEN + ver=1 + chlen + 各块压缩大小
    out.push(0x52, 0x41, raLen & 0xff, (raLen >> 8) & 0xff);
    out.push(1, 0, chlen & 0xff, (chlen >> 8) & 0xff);
    for (let i = 0; i < nSizes; i += 1) {
      const sz = compressed[i].length;
      out.push(sz & 0xff, (sz >> 8) & 0xff);
    }
    // 填充子字段（SI1/SI2 非 'RA'）：读取器应跳过继续扫描
    out.push(0x50, 0x41, padLen & 0xff, (padLen >> 8) & 0xff);
    for (let i = 0; i < padLen; i += 1) {
      out.push(0x00);
    }
    // FNAME + NUL
    for (const b of utf8Encode(fname)) {
      out.push(b);
    }
    out.push(0);
    const head = new Uint8Array(out);
    const bodyParts: Uint8Array[] = [head, ...compressed, new Uint8Array(8)];
    const total = bodyParts.reduce((s, part) => s + part.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const part of bodyParts) {
      all.set(part, off);
      off += part.length;
    }
    return all;
  }

  it('头部超过 64KB 初始窗口：扩读后仍可按块随机访问读取', async () => {
    const text0 = utf8Encode('big header entry one');
    const chunk0 = (() => {
      const c = new Uint8Array(64);
      c.set(text0, 0);
      return c;
    })();
    const text1 = utf8Encode('big header entry two');
    const chunk1 = (() => {
      const c = new Uint8Array(64);
      c.set(text1, 0);
      return c;
    })();
    const dictDz = buildDictzipBigHeader([chunk0, chunk1], 64);

    const r = await DictZipReader.open(readerFromBytes(dictDz));
    expect(r).toBeInstanceOf(DictZipReader);
    const part0 = await r.read(0, text0.length);
    expect(Array.from(part0)).toEqual(Array.from(text0));
    const part1 = await r.read(64, text1.length);
    expect(Array.from(part1)).toEqual(Array.from(text1));
  });
});

describe('容错与取消', () => {
  it('释义超长（>2MB）跳过并继续后续词条', async () => {
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    const ok = utf8Encode('fine');
    const idx = buildIdx([
      { word: 'bad', offset: 0, size: huge.length },
      { word: 'good', offset: 0, size: ok.length },
    ]);
    const dict = (() => {
      const all = new Uint8Array(huge.length);
      all.set(ok, 0);
      return all;
    })();
    const errors: string[] = [];
    const entries = await collect(BASE_IFO, idx, readerFromBytes(dict), {
      reportError: (e) => errors.push(e.reason),
    });
    expect(errors).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].headword).toBe('good');
  });

  it('isCancelled=true 时立即结束', async () => {
    const article = utf8Encode('never read');
    const idx = buildIdx([{ word: 'x', offset: 0, size: article.length }]);
    const entries = await collect(BASE_IFO, idx, readerFromBytes(article), {
      isCancelled: () => true,
    });
    expect(entries).toHaveLength(0);
  });
});
