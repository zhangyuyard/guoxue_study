/**
 * 测试辅助：手工构造 zip 字节流（供 zipReader / bookFormat 单测使用）。
 * CRC 字段填 0（zipReader 不校验 CRC）；支持 stored 与 deflate（经 pako.deflateRaw）。
 */
import { deflateRaw } from 'pako';
import { utf8Encode } from '@/test-utils/utf8';

export interface ZipFileSpec {
  name: string;
  /** 文本内容（与 bytes 二选一） */
  content?: string;
  /** 原始字节（用于构造嵌套 zip/二进制条目） */
  bytes?: Uint8Array;
  method?: 0 | 8;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
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

export function buildZip(files: ZipFileSpec[]): Uint8Array {
  const enc = (s: string): Uint8Array => utf8Encode(s);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameB = enc(f.name);
    const raw = f.bytes ?? utf8Encode(f.content ?? '');
    const method = f.method ?? 0;
    const data = method === 8 ? deflateRaw(raw) : raw;

    const lfh = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(raw.length),
      u16(nameB.length),
      u16(0),
      nameB,
      data,
    ]);
    const cdh = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(raw.length),
      u16(nameB.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameB,
    ]);
    localParts.push(lfh);
    centralParts.push(cdh);
    offset += lfh.length;
  }

  const central = concat(centralParts);
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...localParts, central, eocd]);
}
