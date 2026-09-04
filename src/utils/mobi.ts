/**
 * MOBI 提取器（PalmDB + PalmDOC 压缩，纯函数可单测）。
 *
 * 结构：PalmDB 头（78B）→ 记录索引表 → 记录 0（PalmDOC 头 + MOBI 头）→
 *       记录 1..N 为文本记录（HTML）。
 * 支持：压缩方式 1（无压缩）/ 2（PalmDOC LZ77）；编码 65001(UTF-8) / 1252。
 * 拒绝：DRM 加密文件、HUFF/CDIC 压缩（compression=17480）。
 * 剥离：MOBI 头 extraFlags 声明的记录尾部条目（最后一条含 multibyte 重叠）。
 */
import { decodeUtf8 } from '@/utils/utf8';
import { decodeTextBytes, isStrictUtf8 } from '@/utils/textEncoding';
import { CHAPTER_MARKER, type StructuredText, htmlToText } from '@/utils/htmlText';

const MOBI_MAGIC = 0x4d4f4249; // 'MOBI'
const HUFF_CDIC_COMPRESSION = 17480;

function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readU32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/**
 * PalmDOC LZ77 解压（压缩方式 2）。
 * 规则：0x00 字面量；0x01-0x08 为 1-8 个空格；0x09-0x7F 字面量；
 *       0x80-0xBF 与下一字节组成 <距离,长度> 回引；0xC0-0xFF 为「空格 + 字符」。
 */
export function decompressPalmdoc(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    const b = data[i];
    i += 1;
    if (b === 0) {
      out.push(0);
    } else if (b <= 8) {
      for (let k = 0; k < b; k += 1) {
        out.push(0x20);
      }
    } else if (b < 0x80) {
      out.push(b);
    } else if (b < 0xc0) {
      if (i >= n) {
        break;
      }
      const b2 = data[i];
      i += 1;
      const v = (b << 8) | b2;
      const distance = (v >> 3) & 0x7ff;
      const length = (v & 0x7) + 3;
      const src = out.length - distance;
      if (src < 0) {
        break;
      }
      for (let k = 0; k < length; k += 1) {
        out.push(out[src + k]);
      }
    } else {
      out.push(0x20);
      out.push(b & 0x7f);
    }
  }
  return new Uint8Array(out);
}

/** 从尾部按 varint 读取条目长度（LEB128 反向） */
function readVarintBackwards(data: Uint8Array, end: number): number {
  let result = 0;
  let bitpos = 0;
  let pos = end;
  while (pos > 0) {
    const v = data[pos - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    pos -= 1;
    if ((v & 0x80) !== 0 || bitpos >= 28 || pos === 0) {
      break;
    }
  }
  return result;
}

/** 剥离记录尾部 extra data（entry flags 全部记录；multibyte 仅最后一条） */
function stripTrailingEntries(data: Uint8Array, extraFlags: number, isLast: boolean): Uint8Array {
  let end = data.length;
  let flags = extraFlags >> 1;
  let safe = true;
  while (flags) {
    if (flags & 1) {
      const size = readVarintBackwards(data, end);
      if (size <= 0 || size > end) {
        safe = false;
        break;
      }
      end -= size;
    }
    flags >>= 1;
  }
  if (safe && isLast && (extraFlags & 1) && end > 0) {
    const size = (data[end - 1] & 0x3) + 1;
    if (size <= end) {
      end -= size;
    }
  }
  return data.subarray(0, end);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * MOBI/PRC/AZW → 纯文本。
 * 全部文本记录拼接为 HTML（mbp:pagebreak 转行），h1-h3 转章节标记。
 */
export function mobiExtractText(bytes: Uint8Array): StructuredText {
  if (bytes.length < 78) {
    throw new Error('无效的 MOBI 文件');
  }
  const numRecords = readU16(bytes, 76);
  if (numRecords < 2) {
    throw new Error('无效的 MOBI 文件');
  }
  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i += 1) {
    const p = 78 + i * 8;
    if (p + 8 > bytes.length) {
      throw new Error('无效的 MOBI 文件');
    }
    offsets.push(readU32(bytes, p));
  }
  const at = (i: number): Uint8Array =>
    bytes.subarray(offsets[i], i + 1 < numRecords ? offsets[i + 1] : bytes.length);

  // 记录 0：PalmDOC 头
  const r0 = at(0);
  if (r0.length < 16) {
    throw new Error('无效的 MOBI 文件');
  }
  const compression = readU16(r0, 0);
  const textRecordCount = readU16(r0, 8);
  const encryption = readU16(r0, 12);
  if (encryption !== 0) {
    throw new Error('该文件含 DRM 版权保护，无法导入');
  }
  if (compression === HUFF_CDIC_COMPRESSION) {
    throw new Error('暂不支持 HUFF/CDIC 压缩的 MOBI 文件');
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error(`不支持的 MOBI 压缩方式（${compression}）`);
  }

  // MOBI 扩展头：编码 / 书名 / extra data flags
  let encoding = 65001;
  let extraFlags = 0;
  let title: string | undefined;
  if (readU32(r0, 16) === MOBI_MAGIC && r0.length >= 132) {
    const headerLen = readU32(r0, 20);
    encoding = readU32(r0, 28);
    const fullNameOffset = readU32(r0, 84);
    const fullNameLength = readU32(r0, 88);
    if (fullNameOffset + fullNameLength <= r0.length && fullNameLength > 0) {
      const nameBytes = r0.subarray(fullNameOffset, fullNameOffset + fullNameLength);
      const raw = isStrictUtf8(nameBytes) ? decodeUtf8(nameBytes) : decodeTextBytes(nameBytes).text;
      const cleaned = raw.replace(/\0/g, '').trim();
      if (cleaned && !/^html|^text|^book$/i.test(cleaned)) {
        title = cleaned;
      }
    }
    if (headerLen >= 244 && r0.length >= 244) {
      extraFlags = readU16(r0, 242);
    }
  }

  // 文本记录 1..N：剥尾部 extra data → 解压 → 拼接
  const chunks: Uint8Array[] = [];
  const count = Math.min(textRecordCount, numRecords - 1);
  for (let i = 1; i <= count; i += 1) {
    let data = at(i);
    if (extraFlags !== 0) {
      data = stripTrailingEntries(data, extraFlags, i === count);
    }
    chunks.push(compression === 2 ? decompressPalmdoc(data) : data);
  }
  const htmlBytes = concatBytes(chunks);
  const html = (encoding === 65001 ? decodeUtf8(htmlBytes) : decodeTextBytes(htmlBytes).text)
    .replace(/<mbp:pagebreak\s*\/?>/gi, '\n');
  const text = htmlToText(html, { headingMarkers: true });
  if (!text) {
    throw new Error('未解析出任何内容（文件可能为空或损坏）');
  }
  return { title, author: undefined, text };
}

/** 导出标记常量供测试使用 */
export { CHAPTER_MARKER };
