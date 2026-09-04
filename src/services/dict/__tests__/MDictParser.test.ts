/**
 * MDictParser 单元测试（纯逻辑直跑，零原生 mock）
 * 夹具在 Node 端程序化构造（zlib deflate + 手写 u16/u32/u64 BE 编码）：
 *   - v2.0 UTF-8 无加密 mdx
 *   - v2.0 UTF-16LE 无加密 mdx
 *   - v2.0 UTF-8 encrypt=2（key block info 经 fastDecrypt；配套自研 fastEncrypt 生成密文）
 *   - LZO 压缩块 → 明确报错
 *   - mdd 资源（mime/base64）
 * 另附 RIPEMD-128 标准向量校验（MDictCrypto 自研实现的正确性基准）。
 */
import { deflateSync } from 'node:zlib';

import type { DictParserContext, ParsedEntry } from '@/services/dict/parsers/types';
import { utf16leEncode, utf8Encode } from '@/services/dict/parsers/types';
import { ripemd128 } from '@/services/dict/parsers/MDictCrypto';
import { MDictParser } from '@/services/dict/parsers/MDictParser';

// ============ 字节工具 ============

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u64be(n: number): Uint8Array {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return concatBytes(u32be(hi), u32be(lo));
}

/** nibble 互换（fastDecrypt 内部同款） */
function rotNibbles(x: number): number {
  return ((x >> 4) | (x << 4)) & 0xff;
}

/** fastDecrypt 的逆函数（依解密式推导）：c[i] = rot(p[i] ^ c[i-1] ^ i ^ key)，c[-1]=0x36 */
function fastEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let prev = 0x36;
  for (let i = 0; i < data.length; i += 1) {
    const t = (data[i] ^ prev ^ (i & 0xff) ^ key[i % key.length]) & 0xff;
    const c = rotNibbles(t);
    out[i] = c;
    prev = c;
  }
  return out;
}

// ============ mdx/mdd 夹具构造（v2.0） ============

interface FixtureRecord {
  key: string;
  /** mdx：词条 HTML 字节；mdd：二进制资源 */
  data: Uint8Array;
}

interface FixtureOptions {
  encoding: 'utf-8' | 'utf-16';
  encrypt: 0 | 2;
  /** record block 压缩方式标记（默认 2=zlib；1=LZO 用于错误路径用例） */
  recordCompression?: number;
}

/** 块包装：[压缩标记 BE→LE 解析] + 4 字节 adler（解析器宽松校验，占位即可）+ 压缩数据 */
function wrapBlock(raw: Uint8Array, compression = 2): Uint8Array {
  return concatBytes(
    new Uint8Array([compression & 0xff, 0x00, 0x00, 0x00]),
    new Uint8Array(4),
    raw,
  );
}

/** 构造完整 mdx / mdd 文件字节 */
function buildMdict(records: FixtureRecord[], opts: FixtureOptions): Uint8Array {
  const textWidth = opts.encoding === 'utf-16' ? 2 : 1;
  const keyBytesWithTerm = (s: string) =>
    opts.encoding === 'utf-16' ? utf16leEncode(s, '\u0000') : utf8Encode(`${s}\u0000`);
  const _textBytes = (s: string) =>
    opts.encoding === 'utf-16' ? utf16leEncode(s) : utf8Encode(s);

  // ---- 头部（UTF-16LE XML + 0 终止符，adler 占位） ----
  const headerXml =
    `<MDDefinition GeneratedByEngineVersion="2.0" Title="t" Encoding="${opts.encoding === 'utf-16' ? 'UTF-16' : 'UTF-8'}" ` +
    `Encrypted="${opts.encrypt}" Format="HTML"/>`;
  const headerBytes = utf16leEncode(headerXml, '\u0000');
  const headerPart = concatBytes(u32be(headerBytes.length), headerBytes, new Uint8Array(4));

  // ---- key blocks（单块承载全部 key） ----
  let offset = 0;
  const keyParts: Uint8Array[] = [];
  for (const r of records) {
    keyParts.push(concatBytes(u64be(offset), keyBytesWithTerm(r.key)));
    offset += r.data.length;
  }
  const keyDataRaw = concatBytes(...keyParts);
  const keyBlock = wrapBlock(new Uint8Array(deflateSync(Buffer.from(keyDataRaw))));

  // ---- key block info（解压态：count + 首尾 key 文本 + 块尺寸） ----
  const headSize = Math.floor(keyBytesWithTerm(records[0].key).length / textWidth) - 1;
  const tailSize = Math.floor(keyBytesWithTerm(records[records.length - 1].key).length / textWidth) - 1;
  const infosRaw = concatBytes(
    u64be(records.length),
    u16be(headSize),
    keyBytesWithTerm(records[0].key),
    u16be(tailSize),
    keyBytesWithTerm(records[records.length - 1].key),
    u64be(keyBlock.length),
    u64be(keyDataRaw.length),
  );
  const infosDeflated = new Uint8Array(deflateSync(Buffer.from(infosRaw)));
  let infoSection = wrapBlock(infosDeflated);
  if (opts.encrypt & 2) {
    // key = ripemd128(adler 占位字节 + LE u32 0x3695)，加密第 8 字节起的 body
    const seed = concatBytes(new Uint8Array(4), new Uint8Array([0x95, 0x36, 0x00, 0x00]));
    const key = ripemd128(seed);
    const bodyEnc = fastEncrypt(infosDeflated, key);
    infoSection = concatBytes(new Uint8Array([0x02, 0x00, 0x00, 0x00]), new Uint8Array(4), bodyEnc);
  }

  // ---- 数字区（v2：5 个 u64 + adler 占位） ----
  const numbers = concatBytes(
    u64be(1),
    u64be(records.length),
    u64be(infosRaw.length),
    u64be(infoSection.length),
    u64be(0),
    new Uint8Array(4),
  );

  // ---- record section（单块承载全部记录） ----
  const recordRaw = concatBytes(...records.map((r) => r.data));
  const recordBlock = wrapBlock(
    new Uint8Array(deflateSync(Buffer.from(recordRaw))),
    opts.recordCompression ?? 2,
  );

  return concatBytes(
    headerPart,
    numbers,
    u64be(infoSection.length),
    u64be(keyBlock.length),
    infoSection,
    keyBlock,
    u64be(1),
    u64be(records.length),
    u64be(16),
    u64be(recordBlock.length),
    u64be(recordBlock.length),
    u64be(recordRaw.length),
    recordBlock,
  );
}

/** 由字节构造解析上下文 */
function makeCtx(bytes: Uint8Array): DictParserContext {
  return {
    fileSize: bytes.length,
    readChunk: async (position: number, length: number) => bytes.slice(position, position + length),
    onProgress: jest.fn(),
    isCancelled: () => false,
    reportError: jest.fn(),
  };
}

/** 解析并收集全部词条 */
async function parseAll(
  parser: { parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> },
  bytes: Uint8Array,
): Promise<ParsedEntry[]> {
  const out: ParsedEntry[] = [];
  for await (const batch of parser.parse(makeCtx(bytes))) {
    out.push(...batch);
  }
  return out;
}

// ============ 用例 ============

describe('MDictParser mdx（v2.0 UTF-8 无加密）', () => {
  test('头部 / key / record 全链路解析为 html 词条', async () => {
    const bytes = buildMdict(
      [
        { key: '学', data: utf8Encode('<b>学</b>：学习') },
        { key: '说', data: utf8Encode('<i>说</i>：说话') },
      ],
      { encoding: 'utf-8', encrypt: 0 },
    );
    const entries = await parseAll(MDictParser.mdxParser, bytes);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ headword: '学', contentType: 'html', content: '<b>学</b>：学习' });
    expect(entries[1]).toMatchObject({ headword: '说', contentType: 'html', content: '<i>说</i>：说话' });
  });
});

describe('MDictParser mdx（v2.0 UTF-16LE 无加密）', () => {
  test('UTF-16 编码的 key 与记录正确解码', async () => {
    const bytes = buildMdict(
      [
        { key: '仁', data: utf16leEncode('<p>仁者爱人</p>') },
        { key: '义', data: utf16leEncode('<p>义者宜也</p>') },
      ],
      { encoding: 'utf-16', encrypt: 0 },
    );
    const entries = await parseAll(MDictParser.mdxParser, bytes);
    expect(entries.map((e) => e.headword)).toEqual(['仁', '义']);
    expect(entries[0].content).toBe('<p>仁者爱人</p>');
    expect(entries[1].content).toBe('<p>义者宜也</p>');
  });
});

describe('MDictParser mdx（v2.0 encrypt=2 key block info 加密）', () => {
  test('fastEncrypt 与 decryptHeaderBlock 互逆', () => {
    const body = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff);
    const key = ripemd128(new Uint8Array(16).fill(0xab));
    const enc = fastEncrypt(body, key);
    // 解密式：p[i] = rot(c[i]) ^ c[i-1] ^ i ^ key
    const dec = new Uint8Array(enc.length);
    let prev = 0x36;
    for (let i = 0; i < enc.length; i += 1) {
      dec[i] = (rotNibbles(enc[i]) ^ prev ^ (i & 0xff) ^ key[i % key.length]) & 0xff;
      prev = enc[i];
    }
    expect(Array.from(dec)).toEqual(Array.from(body));
  });

  test('加密的 key block info 正确解密并解析', async () => {
    const bytes = buildMdict(
      [
        { key: '礼', data: utf8Encode('<div>礼：规范</div>') },
        { key: '乐', data: utf8Encode('<div>乐：音乐</div>') },
      ],
      { encoding: 'utf-8', encrypt: 2 },
    );
    const entries = await parseAll(MDictParser.mdxParser, bytes);
    expect(entries.map((e) => e.headword)).toEqual(['礼', '乐']);
    expect(entries[1].content).toBe('<div>乐：音乐</div>');
  });
});

describe('MDictParser 错误路径', () => {
  test('LZO 压缩块（compression=1）抛出明确错误', async () => {
    const bytes = buildMdict(
      [{ key: '天', data: utf8Encode('<span>天：苍天</span>') }],
      { encoding: 'utf-8', encrypt: 0, recordCompression: 1 },
    );
    await expect(parseAll(MDictParser.mdxParser, bytes)).rejects.toThrow('LZO');
  });

  test('非法头部长度（0）报错', async () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    await expect(parseAll(MDictParser.mdxParser, bytes)).rejects.toThrow('文件头部');
  });

  test('MDict 3.0 版本明确拒绝', async () => {
    const headerXml =
      '<MDDefinition GeneratedByEngineVersion="3.0" Title="t" Encoding="UTF-8" Encrypted="0"/>';
    const headerBytes = utf16leEncode(headerXml, '\u0000');
    const bytes = concatBytes(u32be(headerBytes.length), headerBytes, new Uint8Array(4), new Uint8Array(64));
    await expect(parseAll(MDictParser.mdxParser, bytes)).rejects.toThrow('3.0');
  });
});

describe('MDictParser mdd（资源文件）', () => {
  test('二进制资源产出 mime / sizeBytes / base64', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const bytes = buildMdict([{ key: '/logo.png', data: png }], { encoding: 'utf-8', encrypt: 0 });
    const entries = await parseAll(MDictParser.mddParser, bytes);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.headword).toBe('/logo.png');
    expect(e.resource).toBeDefined();
    expect(e.resource?.mime).toBe('image/png');
    expect(e.resource?.sizeBytes).toBe(png.length);
    expect(Buffer.from(e.resource?.dataBase64 ?? '', 'base64')).toEqual(Buffer.from(png));
  });
});

describe('MDictParser sniff 分发', () => {
  test('mdx / mdd 扩展名互斥命中', () => {
    expect(MDictParser.mdxParser.sniff('a.mdx')).toBe(true);
    expect(MDictParser.mdxParser.sniff('a.mdd')).toBe(false);
    expect(MDictParser.mddParser.sniff('a.mdd')).toBe(true);
    expect(MDictParser.mddParser.sniff('a.mdx')).toBe(false);
    expect(MDictParser.mdxParser.sniff('a.csv')).toBe(false);
  });
});

describe('RIPEMD-128 标准向量（MDictCrypto 自研实现基准）', () => {
  function hex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  test('空串 / "a" / "abc" / "message digest" / fox（ISO/IEC 10118-3 官方向量）', () => {
    expect(hex(ripemd128(new Uint8Array(0)))).toBe('cdf26213a150dc3ecb610f18f6b38b46');
    expect(hex(ripemd128(utf8Encode('a')))).toBe('86be7afa339d0fc7cfc785e72f578d33');
    expect(hex(ripemd128(utf8Encode('abc')))).toBe('c14a12199c66e4ba84636b0f69144c77');
    expect(hex(ripemd128(utf8Encode('message digest')))).toBe('9e327b3d6e523062afc1132d7df9d1b8');
    expect(hex(ripemd128(utf8Encode('The quick brown fox jumps over the lazy dog')))).toBe(
      '3fa9b57f053c053fbe2735b2380db596',
    );
  });
});
