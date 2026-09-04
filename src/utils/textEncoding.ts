/**
 * 文本编码检测与解码（Hermes 无 TextDecoder，全部自实现）。
 *
 * 中文 txt 来源多样：GBK/GB2312（网页小说主流）、UTF-8、UTF-16（带 BOM）。
 * decodeTextBytes 按以下优先级判定：
 *   1. BOM（UTF-8 / UTF-16LE / UTF-16BE）直接按对应编码解码；
 *   2. 无 BOM 且字节流是严格合法的 UTF-8 → UTF-8（纯 ASCII 亦属此列）；
 *   3. 无 BOM 但零字节占比极高 → 疑似无 BOM 的 UTF-16（按字节序探测）；
 *   4. 其余 → GBK（双字节区即 GB2312/GBK/GB18030 双字节部分）。
 *
 * GBK 解码使用构建期生成的索引表（scripts/gen-gbk-table.mjs），
 * GB18030 四字节扩展码位（CJK 扩展 B-F 等罕见字）不在表内，输出替换符。
 */
import { decodeUtf8 } from '@/utils/utf8';
import { GBK_INDEX } from '@/data/encoding/gbk-index';

/** GBK 解码：双字节区查表；0x80 = €；非法序列输出 U+FFFD */
export function decodeGbk(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    if (b0 === 0x80) {
      // GBK 单字节 €
      out += '\u20ac';
      i += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    if (b0 >= 0x81 && b0 <= 0xfe) {
      const t = bytes[i + 1];
      if (t === undefined || t < 0x40 || t > 0xfe || t === 0x7f) {
        out += '\ufffd';
        i += 1;
        // eslint-disable-next-line no-continue
        continue;
      }
      const p = (b0 - 0x81) * 190 + (t - 0x40) - (t > 0x7f ? 1 : 0);
      const ch = GBK_INDEX[p];
      out += ch === '\ufffd' ? '\ufffd' : ch;
      i += 2;
      // eslint-disable-next-line no-continue
      continue;
    }
    out += '\ufffd';
    i += 1;
  }
  return out;
}

/** UTF-16 解码（默认按 LE；无 BOM 由 detect 层判定字节序） */
export function decodeUtf16(bytes: Uint8Array, order: 'le' | 'be'): string {
  let out = '';
  let i = 0;
  const n = bytes.length - (bytes.length % 2);
  const at = (k: number): number => (order === 'le' ? bytes[k] | (bytes[k + 1] << 8) : (bytes[k] << 8) | bytes[k + 1]);
  while (i < n) {
    const u = at(i);
    i += 2;
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 2 <= n) {
        const u2 = at(i);
        if (u2 >= 0xdc00 && u2 <= 0xdfff) {
          i += 2;
          const c = 0x10000 + ((u - 0xd800) << 10) + (u2 - 0xdc00);
          out += String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff));
          // eslint-disable-next-line no-continue
          continue;
        }
      }
      out += '\ufffd';
      // eslint-disable-next-line no-continue
      continue;
    }
    if (u >= 0xdc00 && u <= 0xdfff) {
      out += '\ufffd';
      // eslint-disable-next-line no-continue
      continue;
    }
    out += String.fromCharCode(u);
  }
  return out;
}

/** 严格 UTF-8 校验（拒绝越界/过长编码/代理区码点） */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let extra: number;
    let code: number;
    if (b0 < 0x80) {
      extra = 0;
      code = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      extra = 1;
      code = b0 & 0x1f;
    } else if ((b0 & 0xf0) === 0xe0) {
      extra = 2;
      code = b0 & 0x0f;
    } else if ((b0 & 0xf8) === 0xf0) {
      extra = 3;
      code = b0 & 0x07;
    } else {
      return false;
    }
    if (extra > 0) {
      if (i + extra >= n) {
        return false;
      }
      let ok = true;
      for (let k = 1; k <= extra; k += 1) {
        if ((bytes[i + k] & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        code = (code << 6) | (bytes[i + k] & 0x3f);
      }
      if (!ok) {
        return false;
      }
      if (extra === 1 && code < 0x80) {
        return false;
      }
      if (extra === 2 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) {
        return false;
      }
      if (extra === 3 && (code < 0x10000 || code > 0x10ffff)) {
        return false;
      }
    }
    i += extra + 1;
  }
  return true;
}

/** 检测结果 */
export interface DecodedText {
  text: string;
  /** 实际使用的编码（BOM 判定 / utf-8 / gbk / utf-16le / utf-16be） */
  encoding: string;
}

/**
 * 编码检测 + 解码（导入 txt 的统一入口）。
 * 判定顺序见文件头注释；GBK 判定兜底保证中文 txt 永不输出整篇乱码。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText {
  // 1) BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeUtf8(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), 'le'), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), 'be'), encoding: 'utf-16be' };
  }
  // 2) 严格 UTF-8（含纯 ASCII）
  if (isStrictUtf8(bytes)) {
    return { text: decodeUtf8(bytes), encoding: 'utf-8' };
  }
  // 3) 无 BOM 的 UTF-16：零字节占比异常高（CJK BMP 字符高字节多为 0）
  let zeros = 0;
  const sample = Math.min(bytes.length, 8192);
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] === 0) {
      zeros += 1;
    }
  }
  if (bytes.length >= 2 && zeros / sample > 0.25) {
    // 首字节 0 → BE（字符高位在前），否则 LE
    const order = bytes[0] === 0 ? 'be' : 'le';
    return { text: decodeUtf16(bytes, order), encoding: `utf-16${order}` };
  }
  // 4) 兜底 GBK
  return { text: decodeGbk(bytes), encoding: 'gbk' };
}
