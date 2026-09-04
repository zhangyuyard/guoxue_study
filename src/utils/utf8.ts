/**
 * UTF-8 解码（Hermes 无 TextDecoder，自实现）。
 * 从 UserBookService 抽出为通用工具（textEncoding 亦复用）。
 */

/** UTF-8 bytes → string（容错：非法序列以 U+FFFD 替代） */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let code: number;
    let extra: number;
    if (b0 < 0x80) {
      code = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07;
      extra = 3;
    } else {
      out += '\ufffd';
      i += 1;
      continue;
    }
    if (i + extra >= n) {
      out += '\ufffd';
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const bk = bytes[i + k];
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      code = (code << 6) | (bk & 0x3f);
    }
    if (!ok) {
      out += '\ufffd';
      i += 1;
      continue;
    }
    i += extra + 1;
    if (code >= 0x10000) {
      const c = code - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}
