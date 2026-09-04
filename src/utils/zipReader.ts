/**
 * 最小 ZIP 读取器（用于 EPUB 导入）。
 *
 * 只做读取：解析 End of Central Directory → 中央目录 → 按条目定位本地头取数据。
 * 支持压缩方法：0（stored）/ 8（deflate，经 pako.inflateRaw 解压）。
 * 不支持 ZIP64（>4GB 文件不在导入场景内）、不校验 CRC32、不处理加密条目。
 */
import { inflateRaw } from 'pako';
import { decodeUtf8 } from '@/utils/utf8';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 压缩方法常量 */
export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATE = 8;

export interface ZipEntry {
  /** 条目名（UTF-8 解码，保留目录前缀） */
  name: string;
  /** 压缩方法（0=stored 8=deflate） */
  method: number;
  /** 压缩后字节数 */
  compressedSize: number;
  /** 原始字节数 */
  size: number;
  /** 本地文件头在 zip 中的偏移（读取用） */
  localHeaderOffset: number;
}

function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readU32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/** 从尾部向前搜索 EOCD（注释最长 65535 字节，搜索范围留足） */
function findEocd(bytes: Uint8Array): number {
  const minEocd = 22;
  const scanFrom = Math.max(0, bytes.length - minEocd - 65535);
  for (let i = bytes.length - minEocd; i >= scanFrom; i -= 1) {
    if (readU32(bytes, i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

/**
 * 解析 zip 全部条目（中央目录）。
 * 抛出 Error('无效的 zip 文件') 当签名/结构不合法。
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new Error('无效的 zip 文件');
  }
  const entryCount = readU16(bytes, eocd + 10);
  const cdOffset = readU32(bytes, eocd + 16);
  if (cdOffset + 4 > bytes.length) {
    throw new Error('无效的 zip 文件');
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > bytes.length || readU32(bytes, p) !== CDH_SIG) {
      throw new Error('无效的 zip 文件');
    }
    const method = readU16(bytes, p + 10);
    const compressedSize = readU32(bytes, p + 20);
    const size = readU32(bytes, p + 24);
    const nameLen = readU16(bytes, p + 28);
    const extraLen = readU16(bytes, p + 30);
    const commentLen = readU16(bytes, p + 32);
    const localHeaderOffset = readU32(bytes, p + 42);
    const name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读取单个条目内容（自动解压；加密条目抛错） */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const lfh = entry.localHeaderOffset;
  if (lfh + 30 > bytes.length || readU32(bytes, lfh) !== LFH_SIG) {
    throw new Error(`zip 条目损坏：${entry.name}`);
  }
  const nameLen = readU16(bytes, lfh + 26);
  const extraLen = readU16(bytes, lfh + 28);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new Error(`zip 条目损坏：${entry.name}`);
  }
  const raw = bytes.subarray(dataStart, dataEnd);
  if (entry.method === ZIP_METHOD_STORED) {
    return raw;
  }
  if (entry.method === ZIP_METHOD_DEFLATE) {
    try {
      return inflateRaw(raw);
    } catch {
      throw new Error(`zip 条目解压失败：${entry.name}`);
    }
  }
  throw new Error(`不支持的 zip 压缩方法（${entry.method}）：${entry.name}`);
}
