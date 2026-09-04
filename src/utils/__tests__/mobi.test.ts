/**
 * mobi 提取器单测：PalmDB 结构解析、无压缩/PalmDOC 解压、DRM/HUFF 拒绝、书名提取。
 */
import { decompressPalmdoc, mobiExtractText } from '@/utils/mobi';
import { utf8Encode } from '@/test-utils/utf8';

function setU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function setU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
  buf[off + 2] = (v >> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

interface MobiOptions {
  compression: number;
  encryption?: number;
  encoding?: number;
  fullName?: string;
  extraFlags?: number;
  textRecords: Uint8Array[];
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 构造最小合法 MOBI（PalmDB 头 + 记录索引 + 记录 0 + 文本记录） */
function buildMobi(opts: MobiOptions): Uint8Array {
  const encoding = opts.encoding ?? 65001;
  const nameBytes = opts.fullName ? utf8Encode(opts.fullName) : new Uint8Array(0);
  const headerLen = opts.extraFlags !== undefined ? 248 : 232;

  // 记录 0 = PalmDOC 头(16) + MOBI 头(headerLen) + 书名
  const textLen = opts.textRecords.reduce((n, r) => n + r.length, 0);
  const r0 = new Uint8Array(16 + headerLen + nameBytes.length);
  setU16(r0, 0, opts.compression);
  setU32(r0, 4, textLen);
  setU16(r0, 8, opts.textRecords.length);
  setU16(r0, 10, 4096);
  setU16(r0, 12, opts.encryption ?? 0);
  setU32(r0, 16, 0x4d4f4249); // 'MOBI'
  setU32(r0, 20, headerLen);
  setU32(r0, 24, 2); // mobi type: book
  setU32(r0, 28, encoding);
  setU32(r0, 84, 16 + headerLen); // Full Name Offset
  setU32(r0, 88, nameBytes.length); // Full Name Length
  if (opts.extraFlags !== undefined) {
    setU16(r0, 242, opts.extraFlags);
  }
  r0.set(nameBytes, 16 + headerLen);

  const records = [r0, ...opts.textRecords];
  const numRecords = records.length;

  // PalmDB 头（78B）
  const pdb = new Uint8Array(78);
  pdb.set(utf8Encode('测试书名'.slice(0, 20)), 0);
  pdb.set(utf8Encode('BOOK'), 60);
  pdb.set(utf8Encode('MOBI'), 64);
  setU16(pdb, 76, numRecords);

  // 记录索引（8B/条）+ 记录数据
  const offsets: number[] = [];
  let off = 78 + numRecords * 8;
  for (const r of records) {
    offsets.push(off);
    off += r.length;
  }
  const indexParts = records.map((_, i) => {
    const e = new Uint8Array(8);
    setU32(e, 0, offsets[i]);
    return e;
  });
  return concat([pdb, ...indexParts, ...records]);
}

describe('decompressPalmdoc', () => {
  test('字面量、1-8 空格、回引、空格+字符', () => {
    // 'A' + 回引(dist=1,len=3 → AAA) + 0xC5 → ' E' + 0x03 → 3 空格
    const out = decompressPalmdoc(new Uint8Array([0x41, 0x80, 0x08, 0xc5, 0x03]));
    expect(new TextDecoder().decode(out)).toBe('AAAA E   ');
  });

  test('0x00 字面量与 0x09-0x7F 字面量', () => {
    const out = decompressPalmdoc(new Uint8Array([0x00, 0x41, 0x7f]));
    expect(Array.from(out)).toEqual([0x00, 0x41, 0x7f]);
  });
});

describe('mobiExtractText', () => {
  test('无压缩（compression=1）+ UTF-8 编码 + 书名 + h1 切章', () => {
    const rec1 = utf8Encode('<html><body><h1>第一章 起点</h1><p>山不在高。</p></body></html>');
    const rec2 = utf8Encode('<p>水不在深。</p>');
    const mobi = buildMobi({ compression: 1, fullName: '测试之书', textRecords: [rec1, rec2] });
    const r = mobiExtractText(mobi);
    expect(r.title).toBe('测试之书');
    expect(r.text).toContain('@@CH@@第一章 起点');
    expect(r.text).toContain('山不在高。');
    expect(r.text).toContain('水不在深。');
  });

  test('PalmDOC 压缩（compression=2）端到端', () => {
    // '<p>hello world</p>' 手工压缩：字面量 + 0x01（1 空格）
    const rec = new Uint8Array([
      0x3c, 0x70, 0x3e, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x01, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x3c,
      0x2f, 0x70, 0x3e,
    ]);
    const mobi = buildMobi({ compression: 2, textRecords: [rec] });
    const r = mobiExtractText(mobi);
    expect(r.text).toBe('hello world');
  });

  test('DRM 加密文件拒绝并给出明确错误', () => {
    const mobi = buildMobi({
      compression: 1,
      encryption: 2,
      textRecords: [utf8Encode('<p>x</p>')],
    });
    expect(() => mobiExtractText(mobi)).toThrow('DRM');
  });

  test('HUFF/CDIC 压缩拒绝', () => {
    const mobi = buildMobi({ compression: 17480, textRecords: [utf8Encode('<p>x</p>')] });
    expect(() => mobiExtractText(mobi)).toThrow('HUFF');
  });

  test('非 MOBI 字节流抛错', () => {
    expect(() => mobiExtractText(new Uint8Array(10))).toThrow('无效的 MOBI 文件');
  });

  test('mbp:pagebreak 转行', () => {
    const rec = utf8Encode('<p>上段。</p><mbp:pagebreak/><p>下段。</p>');
    const mobi = buildMobi({ compression: 1, textRecords: [rec] });
    const r = mobiExtractText(mobi);
    expect(r.text).toContain('上段。');
    expect(r.text).toContain('下段。');
  });
});
