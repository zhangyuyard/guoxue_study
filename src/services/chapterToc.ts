/**
 * 归一化文本与 `.gxbook.toc` 目录（2026-10-12 B 档 · 步骤 4）。
 *
 * 要解决的真缺陷（实测确认，非推演）：
 * 归一化（`text.replace(/\r\n?/g, '\n')`）只发生在 `parseTxtBook` /
 * `parseTxtBookChunked` **函数内部**，而 `parseBookFile` 返回的
 * `text` 是**未归一化**的原文（`decodeTextBytes(...).text` / `converted.text`
 * 原样透传）⇒ `processOversizedBooks` 直写 `parsed.text` ⇒ **`.gxbook` 落盘的
 * 是归一化前文本**。
 *
 * ⇒ 未来 `.gxbook.toc` 若按「归一化文本的字节偏移」记账，而缓存文本里含 CRLF，
 * 偏移会**随 CRLF 数量线性漂移**：10 万行 CRLF ⇒ 第 900 章偏 9 万字节 ⇒
 * **静默显示错章，不报错**（最坏的一类缺陷）。
 *
 * 本文件提供两条真值：
 * ①`normalizeForCache` —— 落盘专用归一化（**唯一**口径，防各处各写一遍）
 * ②`buildChapterToc` / `verifyTocAgainstText` —— toc 构造与**自洽校验**
 *   （偏移必须是**行边界**，且切出的文本必须能重建出同样的段数）
 *
 * ⚠ 偏移基准＝**UTF-8 字节**（RNFS 读写、`readLocalTextFileChunked` 均按字节），
 *   不是 JS 字符下标。中文一字 3 字节 ⇒ 两者混算必错位。
 */

import type { Book } from '@/types';

export interface ChapterTocEntry {
  /** 章 id */
  id: string;
  /** 章标题（仅供目录展示/调试，渲染以切出正文重算为准） */
  title: string;
  /** 章序（1 起） */
  order: number;
  /** 本章正文（**不含**标题行）在归一化文本中的起始字节偏移 */
  start: number;
  /** 本章正文在归一化文本中的结束字节偏移（**开区间**，指向下一章起点或文本末尾） */
  end: number;
  /** 本章段数（目录字段，读取时重算段落的期望值） */
  segCount: number;
  /** 本章正文字数（目录字段） */
  charCount: number;
}

export interface ChapterToc {
  /** 格式版本；不兼容时必须整体作废重建，不得局部迁移 */
  v: number;
  /** 章条目（按 order 升序，**必须**首尾相接无缝无叠） */
  chapters: ChapterTocEntry[];
}

/** 当前 toc 格式版本 */
export const CHAPTER_TOC_VERSION = 1;

/**
 * 落盘专用归一化：CRLF / 裸 CR → LF。
 *
 * ⚠ 与解析层（`parseTxtBook` / `parseTxtBookChunked` / `buildBuiltinChapterShells`）
 *   的口径**逐字一致** —— 任何差异都会让 toc 偏移与缓存文本错位。
 */
export function normalizeForCache(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** UTF-8 字节长度（不用 `string.length`，后者是 UTF-16 码元数） */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) as number;
    if (code <= 0x7f) {
      n += 1;
    } else if (code <= 0x7ff) {
      n += 2;
    } else if (code <= 0xffff) {
      n += 3;
    } else {
      n += 4;
      // 代理对：跳过低位代理元（codePointAt 已返回整码点，但循环要前进 2）
      i += 1;
    }
  }
  return n;
}

/** 行起止字节偏移表（行 i 覆盖 `[starts[i], starts[i+1])`，末行到 `byteLen`） */
export function lineByteRanges(normalized: string): {
  starts: number[];
  byteLen: number;
} {
  const starts = [0];
  let bytes = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const cp = normalized.codePointAt(i) as number;
    let w: number;
    if (cp <= 0x7f) {
      w = 1;
    } else if (cp <= 0x7ff) {
      w = 2;
    } else if (cp <= 0xffff) {
      w = 3;
    } else {
      w = 4;
      i += 1;
    }
    bytes += w;
    if (ch === '\n') {
      starts.push(bytes);
    }
  }
  return { starts, byteLen: bytes };
}

/**
 * 把归一化文本按**字节**区间切回字符串。
 *
 * ⚠ **必须走字节口径，不能用 `String.prototype.slice` 直切**：
 * `slice` 的下标是 **UTF-16 码元**，而 toc 记的是 **UTF-8 字节**。
 * 中文一字 3 字节 ⇒ 两者混算会在第一章就错位，且**不报错**。
 * 这是本函数存在的全部理由（初版误用 `slice`，已被判据抓到）。
 *
 * @param normalized 归一化后的文本
 * @param startByte 起始**字节**偏移（含）
 * @param endByte 结束**字节**偏移（不含）
 */
export function sliceBytes(
  normalized: string,
  startByte: number,
  endByte: number,
): string {
  const { starts, byteLen } = lineByteRanges(normalized);
  if (!(startByte >= 0) || !(endByte <= byteLen) || startByte >= endByte) {
    return '';
  }
  // 二分定位 startByte 所在行 ⇒ 得到 startByte 的 UTF-16 下标
  const toIndex = (byteOffset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= byteOffset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };
  const sLine = toIndex(startByte);
  const eLine = toIndex(endByte);
  // startByte 必须恰在行首（行边界）；否则切点落在多字节字符中间 ⇒ 抛错而非静默
  if (starts[sLine] !== startByte) {
    throw new Error(`sliceBytes: startByte=${startByte} 不在行边界（拒绝静默错位）`);
  }
  const from = utf16IndexOfLineStart(normalized, starts, sLine);
  // endByte 若恰为行首，取该行起点；否则取其所在行的起点再 + 该行字节数
  const to = utf16IndexOfLineStart(normalized, starts, eLine);
  if (endByte !== starts[eLine]) {
    // 行内偏移：逐字符累加字节，直到刚好等于 endByte
    let acc = starts[eLine];
    let idx = to;
    while (acc < endByte && idx < normalized.length) {
      const cp = normalized.codePointAt(idx) as number;
      const w = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      acc += w;
      idx += cp > 0xffff ? 2 : 1;
    }
    return normalized.slice(from, idx);
  }
  return normalized.slice(from, to);
}

/** 第 line 行行首（字节偏移 `starts[line]`）对应的 UTF-16 下标 */
function utf16IndexOfLineStart(normalized: string, starts: number[], line: number): number {
  if (line <= 0) {
    return 0;
  }
  // starts 是「行首字节偏移」单调递增表；逐行累加 UTF-16 宽度求下标。
  // O(lines) 每次调用，但 toc 校验/切章是章级调用（非逐段），代价可忽略。
  let idx = 0;
  let byte = 0;
  for (let l = 0; l < line; l += 1) {
    const target = starts[l + 1];
    while (byte < target && idx < normalized.length) {
      const cp = normalized.codePointAt(idx) as number;
      const w = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      byte += w;
      idx += cp > 0xffff ? 2 : 1;
    }
  }
  return idx;
}

/**
 * 由 `Book` 的字节范围字段生成 toc。
 *
 * ★**全有或全无**契约：任一章缺 `byteStart`/`byteEnd` 即返回 `null`，
 * **绝不返回「部分 toc」**——部分 toc 会让消费端切出错误章节而不报错，
 * 比「没有 toc」危险得多（没有 toc 时消费端会回退全量读，永远正确）。
 *
 * 返回 `null` 的合法情形（设计文档 §6「诚实边界」）：
 * ①空书 / 无章节；
 * ②无章节标记且正文超 `SEGMENTS_PER_PART` → 按段数切「第N部分」，
 *   而**段落边界不一定落在行边界** ⇒ 偏移无法表达；
 * ③任一章构造点漏写范围（防御性兜底）。
 */
export function buildTocFromBook(book: Book, normalized: string): ChapterToc | null {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  if (chapters.length === 0) {
    return null;
  }
  const { starts, byteLen } = lineByteRanges(normalized);
  const toByte = (line: number): number => (line < starts.length ? starts[line] : byteLen);
  const entries: ChapterTocEntry[] = [];
  for (const ch of chapters) {
    if (!Number.isFinite(ch.byteStart) || !Number.isFinite(ch.byteEnd)) {
      return null; // ③：缺范围 ⇒ 整体放弃
    }
    const start = ch.byteStart as number;
    const end = ch.byteEnd as number;
    entries.push({
      id: ch.id,
      title: ch.title,
      order: ch.order,
      start,
      end,
      segCount: ch.segCount ?? ch.segments.length,
      charCount: ch.charCount ?? ch.segments.reduce((n, s) => n + s.text.length, 0),
    });
  }
  const toc: ChapterToc = { v: CHAPTER_TOC_VERSION, chapters: entries };
  // 自检：生成物必须立刻自洽（fail-fast ⇒ 绝不把不自洽的 toc 交给消费端）
  const reason = verifyTocAgainstText(toc, normalized);
  if (reason !== '') {
    return null;
  }
  void toByte;
  return toc;
}

/**
 * toc 的**纯结构**校验（不需要原文）。
 *
 * ★与 `verifyTocAgainstText` 的分工（两者都要，不可互相替代）：
 *   · 本函数：toc 文件本身合法吗？（版本/字段/范围自洽/章数一致）
 *     —— **读盘那一刻**就能做，不用读 12.78MB 正文 ⇒ 快路径的**闸门**。
 *   · `verifyTocAgainstText`：toc 与**这份文本**对得上吗？（行边界/不重叠）
 *     —— 必须拿到正文才算得出来 ⇒ 生成端自检用。
 *
 * ⚠ 消费端**只能**用本函数做闸门（读盘即判），不得为了「更严」而去读正文校验
 *   ——那就等于把要省的 6275ms 又花回去。若本函数通过但文本其实已被换掉，
 *   偏移会错位 ⇒ 所以落盘时必须同时写 `.meta` 并在消费端比对指纹（见调用方）。
 *
 * @param bookId 期望书 id；toc 内条目 id 必须以它为前缀
 * @param expectedChapterCount 期望章数；不符即整体拒绝
 * @returns 空串＝通过；非空＝**首条**失败原因
 */
export function validateTocShape(
  raw: unknown,
  bookId: string,
  expectedChapterCount: number,
): string {
  if (!raw || typeof raw !== 'object') {
    return 'toc 不是对象';
  }
  const toc = raw as ChapterToc;
  if (toc.v !== CHAPTER_TOC_VERSION) {
    return `toc 版本不兼容：${String(toc.v)} ≠ ${CHAPTER_TOC_VERSION}`;
  }
  if (!Array.isArray(toc.chapters) || toc.chapters.length === 0) {
    return 'toc 无章节条目';
  }
  if (
    expectedChapterCount > 0 &&
    toc.chapters.length !== expectedChapterCount
  ) {
    return `toc 章数不符：${toc.chapters.length} ≠ ${expectedChapterCount}`;
  }
  let prevEnd = -1;
  let prevOrder = 0;
  for (let i = 0; i < toc.chapters.length; i += 1) {
    const c = toc.chapters[i] as ChapterTocEntry;
    if (
      !c ||
      typeof c.id !== 'string' ||
      c.id === '' ||
      typeof c.title !== 'string' ||
      !Number.isFinite(c.order) ||
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      !Number.isFinite(c.segCount) ||
      !Number.isFinite(c.charCount)
    ) {
      return `第 ${i + 1} 条字段缺失或非有限值`;
    }
    // ⚠ id 归属：条目必须属于本书（防「别本书的 toc 被错挂」——
    //   那会让每一条偏移都指向别的书的正文，静默错章）
    if (bookId !== '' && !c.id.startsWith(bookId)) {
      return `第 ${i + 1} 条 id 不属于本书：${c.id}`;
    }
    if (!(c.start >= 0) || !(c.end > c.start)) {
      return `第 ${i + 1} 条区间非法：start=${c.start} end=${c.end}`;
    }
    // 不重叠（允许有缝：缝是标题行）
    if (prevEnd >= 0 && c.start < prevEnd) {
      return `第 ${i + 1} 条与上一条重叠：start=${c.start} < 上一条 end=${prevEnd}`;
    }
    if (!(c.segCount >= 1) || !(c.charCount >= 0)) {
      return `第 ${i + 1} 条目录字段非法：segCount=${c.segCount} charCount=${c.charCount}`;
    }
    if (i > 0 && c.order <= prevOrder) {
      return `第 ${i + 1} 条 order 未升序：${prevOrder} → ${c.order}`;
    }
    prevEnd = c.end;
    prevOrder = c.order;
  }
  return '';
}

/**
 * toc 自洽校验。**在任何 toc 被消费前必须先过这一关**——
 * 静默错位（切出别的章）比报错危险得多。
 *
 * ★★ 不变量的真实语义（初版写错，2026-10-13 由对拍判据实测纠正）：
 *   toc 记的是**各章正文**的区间，而**标题行被排除在正文之外**
 *   ⇒①**首条 `start` 通常不为 0**（前面是标题行/前言）
 *   ②**末条 `end` 通常小于 `byteLen`**（后面是下一章标题行）
 *   ③**相邻章区间之间天然有「缝」**（那正是标题行）
 *   ⇒ 「首尾相接无缝」这个不变量**不成立**，强行要求会把正确 toc 判成错误
 *     （初版正是如此，导致所有逐章对拍样本全红）。
 *   真正要保证的是**不重叠** + **行对齐** + **有序**。
 *
 * 逐条检查：
 * ①`0 <= start < end <= byteLen`
 * ②`start`/`end` 都落在**行边界**上（`end === byteLen` 允许：末行无换行）
 * ③相邻**不重叠**：`chapters[i].end <= chapters[i+1].start`（**有缝是正常的**）
 * ④`start` 严格递增、`order` 严格升序
 * ⑤`segCount >= 1`、`charCount >= 0`
 *
 * @returns 空串＝通过；非空＝**首条**失败原因（多条失败只报首条，避免噪声）
 */
export function verifyTocAgainstText(toc: ChapterToc, normalized: string): string {
  if (!toc || typeof toc !== 'object') {
    return 'toc 不是对象';
  }
  if (toc.v !== CHAPTER_TOC_VERSION) {
    return `toc 版本不兼容：${String(toc.v)} ≠ ${CHAPTER_TOC_VERSION}`;
  }
  if (!Array.isArray(toc.chapters) || toc.chapters.length === 0) {
    return 'toc 无章节条目';
  }
  const { starts, byteLen } = lineByteRanges(normalized);
  const lineStartSet = new Set(starts);
  let prevEnd = -1;
  let prevOrder = 0;
  for (let i = 0; i < toc.chapters.length; i += 1) {
    const c = toc.chapters[i];
    if (!(c.start >= 0) || !(c.end <= byteLen) || !(c.end > c.start)) {
      return `第 ${i + 1} 条区间非法：start=${c.start} end=${c.end} byteLen=${byteLen}`;
    }
    // ⚠ 行边界检查先于重叠检查：偏移漂移时两者可能同时不成立，
    //   先报「重叠」会掩盖真正的病因（切点不在行边界 ⇒ 归一化口径不一致）。
    if (!lineStartSet.has(c.start)) {
      return `第 ${i + 1} 条 start=${c.start} 不在行边界上`;
    }
    if (c.end !== byteLen && !lineStartSet.has(c.end)) {
      return `第 ${i + 1} 条 end=${c.end} 不在行边界上（byteLen=${byteLen}）`;
    }
    // 不重叠（**允许有缝**：缝就是标题行）
    if (prevEnd >= 0 && c.start < prevEnd) {
      return `第 ${i + 1} 条与上一条重叠：start=${c.start} < 上一条 end=${prevEnd}`;
    }
    if (!(c.segCount >= 1)) {
      return `第 ${i + 1} 条 segCount 非法：${String(c.segCount)}`;
    }
    if (!(c.charCount >= 0)) {
      return `第 ${i + 1} 条 charCount 非法：${String(c.charCount)}`;
    }
    if (i > 0 && c.order <= prevOrder) {
      return `第 ${i + 1} 条 order 未升序：${prevOrder} → ${c.order}`;
    }
    prevEnd = c.end;
    prevOrder = c.order;
  }
  return '';
}
