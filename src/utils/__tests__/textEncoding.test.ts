/**
 * textEncoding 测试：编码检测（BOM/严格 UTF-8/无 BOM UTF-16/GBK）与各解码器。
 * GBK 回归背景：GBK 编码 txt 一律按 UTF-8 解码导致整篇乱码（2026-09-02 用户反馈）。
 */
import { decodeGbk, decodeTextBytes, decodeUtf16, isStrictUtf8 } from '@/utils/textEncoding';
import { GBK_INDEX } from '@/data/encoding/gbk-index';

const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf-8'));

/** 用生成的 GBK 索引表反向求码位（仅测试辅助） */
const gbkEncodeChar = (ch: string): Uint8Array | null => {
  const p = GBK_INDEX.indexOf(ch);
  if (p < 0) {
    return null;
  }
  const lead = 0x81 + Math.floor(p / 190);
  let trail = 0x40 + (p % 190);
  if (trail >= 0x7f) {
    trail += 1;
  }
  return new Uint8Array([lead, trail]);
};

const gbkEncode = (s: string): Uint8Array => {
  const parts: number[] = [];
  for (const ch of s) {
    if (ch.charCodeAt(0) <= 0x7f) {
      parts.push(ch.charCodeAt(0));
    } else {
      const b = gbkEncodeChar(ch);
      if (!b) {
        throw new Error(`GBK 表中无字符: ${ch}`);
      }
      parts.push(...b);
    }
  }
  return new Uint8Array(parts);
};

describe('decodeGbk', () => {
  test('已知码位：道德经 / 你好', () => {
    expect(decodeGbk(new Uint8Array([0xb5, 0xc0, 0xb5, 0xc2, 0xbe, 0xad]))).toBe('道德经');
    expect(decodeGbk(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe('你好');
  });

  test('ASCII 与中文混排', () => {
    expect(decodeGbk(new Uint8Array([0x41, 0x62, 0xb5, 0xc0, 0x31]))).toBe('Ab道1');
  });

  test('非法尾字节输出 U+FFFD 且不吞后续字节', () => {
    // B5 后跟 0x20（非法尾字节）→ fffd + 0x20 原样输出
    expect(decodeGbk(new Uint8Array([0xb5, 0x20]))).toBe('\ufffd ');
  });

  test('截断的双字节序列（文件尾部）输出 U+FFFD', () => {
    expect(decodeGbk(new Uint8Array([0xb5]))).toBe('\ufffd');
  });

  test('查表回环：中文文本 encode→decode 无损', () => {
    const s = '学而时习之，不亦说乎？有朋自远方来，不亦乐乎！';
    expect(decodeGbk(gbkEncode(s))).toBe(s);
  });
});

describe('decodeUtf16', () => {
  test('LE 基本中文', () => {
    // 「道」U+9053 → LE: 0x53 0x90；「德」U+5FB7 → LE: 0xB7 0x5F
    expect(decodeUtf16(new Uint8Array([0x53, 0x90, 0xb7, 0x5f]), 'le')).toBe('道德');
  });

  test('BE 基本中文', () => {
    expect(decodeUtf16(new Uint8Array([0x90, 0x53, 0x5f, 0xb7]), 'be')).toBe('道德');
  });

  test('代理对（emoji）LE', () => {
    const bytes = new Uint8Array([0x3d, 0xd8, 0xa9, 0xdc]); // U+1F4A9
    expect(decodeUtf16(bytes, 'le')).toBe('\u{1F4A9}');
  });

  test('孤立代理项输出 U+FFFD', () => {
    expect(decodeUtf16(new Uint8Array([0x00, 0xd8, 0x41, 0x00]), 'le')).toBe('\ufffdA');
  });
});

describe('isStrictUtf8', () => {
  test('合法 UTF-8（含中文/emoji）通过', () => {
    expect(isStrictUtf8(utf8('道德经 📖 ascii'))).toBe(true);
  });

  test('GBK 双字节被拒绝', () => {
    expect(isStrictUtf8(new Uint8Array([0xb5, 0xc0]))).toBe(false);
  });

  test('过长编码被拒绝', () => {
    // C0 80 = 过长的 NUL
    expect(isStrictUtf8(new Uint8Array([0xc0, 0x80]))).toBe(false);
  });

  test('UTF-16LE 零字节流被拒绝', () => {
    expect(isStrictUtf8(new Uint8Array([0x53, 0x00, 0x90, 0x00]))).toBe(false);
  });
});

describe('decodeTextBytes（检测 + 解码）', () => {
  test('UTF-8 无 BOM', () => {
    expect(decodeTextBytes(utf8('道可道，非常道。'))).toEqual({
      text: '道可道，非常道。',
      encoding: 'utf-8',
    });
  });

  test('UTF-8 带 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('道德经')]);
    expect(decodeTextBytes(bytes)).toEqual({ text: '道德经', encoding: 'utf-8' });
  });

  test('GBK 无 BOM（乱码回归主场景）', () => {
    expect(decodeTextBytes(gbkEncode('大学之道，在明明德。'))).toEqual({
      text: '大学之道，在明明德。',
      encoding: 'gbk',
    });
  });

  test('GBK 与 UTF-8 判定互斥：GBK 字节流不会被误判为 UTF-8', () => {
    // 「道」B5C0 不是合法 UTF-8 序列 → 走 GBK
    const r = decodeTextBytes(new Uint8Array([0xb5, 0xc0]));
    expect(r.encoding).toBe('gbk');
    expect(r.text).toBe('道');
  });

  test('UTF-16LE 带 BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x53, 0x90, 0xb7, 0x5f]);
    expect(decodeTextBytes(bytes)).toEqual({ text: '道德', encoding: 'utf-16le' });
  });

  test('UTF-16BE 带 BOM', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x90, 0x53, 0x5f, 0xb7]);
    expect(decodeTextBytes(bytes)).toEqual({ text: '道德', encoding: 'utf-16be' });
  });

  test('纯 ASCII 按 UTF-8', () => {
    expect(decodeTextBytes(utf8('hello'))).toEqual({ text: 'hello', encoding: 'utf-8' });
  });
});
