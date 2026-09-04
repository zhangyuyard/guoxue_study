/**
 * 字典解析器接口与扩展点注册表
 * 解析器为纯逻辑：只依赖注入的 readChunk / fileSize / onProgress / isCancelled /
 * reportError，不触碰任何原生模块（单测在 node 环境直跑，零 mock）。
 */
import type { DictContentType, DictEntryExtra } from '@/types/dict';

/** 解析产物（ParsedEntry 为 DictEntry 的导入侧形态；headwordNorm 由导入服务统一补齐） */
export interface ParsedEntry {
  headword: string;
  pinyin?: string;
  /** 多音字候选读音 */
  readings?: string[];
  contentType: DictContentType;
  /** structured→DictSense[] JSON；html→MDX HTML；plain→文本 */
  content: string;
  extra?: DictEntryExtra;
  /** mdd 资源专用（format='mdd' 时有效）：二进制资源 */
  resource?: {
    mime: string;
    sizeBytes: number;
    dataBase64: string;
  };
}

export interface DictParserContext {
  /** 分块读文件（position 起 length 字节）；解析器绝不整读大文件（JSON 除外，见 TextDictParser） */
  readChunk(position: number, length: number): Promise<Uint8Array>;
  /** 文件总字节数 */
  fileSize: number;
  /** 每解析 N 条回调一次（UI 进度；计数而非百分比——总数解析前未知） */
  onProgress: (entryCount: number) => void;
  /** 取消标志（UI 触发）；解析器在每个块边界检查 */
  isCancelled: () => boolean;
  /** 单条解析失败记录（行号/偏移/原因），不打断整体 */
  reportError: (e: { at?: number | string; reason: string }) => void;
}

export interface DictParser {
  readonly format: 'csv' | 'tsv' | 'json' | 'txt' | 'mdx' | 'mdd';
  /** 依据文件名与首字节判断是否可解析 */
  sniff(fileName: string, firstBytes: Uint8Array): boolean;
  /** 流式解析；每批 ≤1000 条 */
  parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void>;
}

/** 扩展点：P1 追加 StarDictParser 即注册即用 */
export const PARSER_REGISTRY: DictParser[] = [];

/** 依据扩展名取小写形式（兼容 query 参数等杂项） */
export function fileExt(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0 || idx === fileName.length - 1) {
    return '';
  }
  return fileName.slice(idx + 1).toLowerCase().split('?')[0].split('#')[0];
}

// ============ 通用编解码工具（Hermes 无 TextDecoder，手写实现；纯逻辑可单测） ============

/** UTF-8 解码（覆盖完整码点，含 4 字节序列；非法序列替换为 U+FFFD） */
export function utf8Decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xc0) {
      out += '\uFFFD';
      i += 1;
    } else if (b < 0xe0) {
      if (i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80) {
        out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
        i += 2;
      } else {
        out += '\uFFFD';
        i += 1;
      }
    } else if (b < 0xf0) {
      if (i + 2 < end && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
        out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
        i += 3;
      } else {
        out += '\uFFFD';
        i += 1;
      }
    } else {
      if (i + 3 < end && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) {
        const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        // 代理对
        out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
        i += 4;
      } else {
        out += '\uFFFD';
        i += 1;
      }
    }
  }
  return out;
}

/** UTF-16LE 解码（按 2 字节步进；奇数尾部字节忽略） */
export function utf16leDecode(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  const len = start + Math.floor((end - start) / 2) * 2;
  for (let i = start; i < len; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    // 代理对
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < len) {
      const lo = bytes[i + 2] | (bytes[i + 3] << 8);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += String.fromCharCode(code, lo);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(code);
  }
  return out;
}

/** 字符串 → UTF-16LE 字节（含结尾终止符可选；MDX 头与词条使用） */
export function utf16leEncode(text: string, terminator: '' | '\u0000' = ''): Uint8Array {
  const s = text + terminator;
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >> 8;
  }
  return out;
}

/** 字符串 → UTF-8 字节 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** 字节 → base64（Hermes 有全局 btoa，但输入须为 binary string；此处自实现保证环境无关） */
export function bytesToBase64(bytes: Uint8Array): string {
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
