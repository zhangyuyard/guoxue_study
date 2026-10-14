/**
 * 章级目录字段的**唯一读侧真值**（2026-10-12 加）。
 *
 * 存在理由（设计文档 `docs/reader-chapter-offset-toc-design-2026-10-12.md` §2/§3）：
 * 「章节改偏移量」重构把 `Chapter.segments` 从**正文字符串实体数组**改为按需读取，
 * 于是「读 `segments.length`」这类写法会在**「未装载」与「已装载」时拿到同一个 0**
 * ⇒ 空壳判据失效（阻塞 B）；而 `bookTextChars` 那种「遍历 `sg.text.length`」
 * 会恒返回 0 ⇒ FTS 闸门形同虚设。
 *
 *⇒ 解法：段数/字数在**构造时**（正文在手）算一次存进目录字段，读侧优先读字段、
 *   缺省才回落到遍历 `segments`。
 *
 * ⚠ **为何必须走本模块而不是各处内联回落**：
 *   ① 回落逻辑一旦分散，某个调用点漏改＝「该处 FTS 闸门失效」这类**静默缺陷**，
 *      且没有任何测试会红（现状就正是这种形态：`bookTextChars` 是唯一一处
 *      「为做判断而遍历全书」的代码，勘察时才发现）；
 *   ② 字段与 `segments` 的一致性（「字段是否陈旧」）需要**单一判定口径**，
 *      否则会出现「一处信字段、一处信 segments」的分裂。
 */

import type { Book, Chapter } from '@/types';

/** 判定字段是否**可用**的最小门槛（用于非有限数与负值兜底） */
function usable(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * 本章段数。
 *
 * @returns `segCount` 字段（若可用）；否则回落遍历 `segments`。
 * ⚠ 回落分支在「未装载」态会返回 0——这是**旧形状下的既有行为**，
 *   偏移量化推进到该分支时须换成读目录，而不是扩大回落的使用面。
 */
export function chapterSegCount(chapter: Chapter): number {
  if (usable(chapter.segCount)) {
    return chapter.segCount;
  }
  return Array.isArray(chapter.segments) ? chapter.segments.length : 0;
}

/**
 * 本章正文字数。
 *
 * @returns `charCount` 字段（若可用）；否则回落遍历 `segments` 求 `text.length`。
 *⚠ 该回落**需要正文在手**，是「字段缺失」时的兼容路径，不是常规路径。
 */
export function chapterCharCount(chapter: Chapter): number {
  if (usable(chapter.charCount)) {
    return chapter.charCount;
  }
  if (!Array.isArray(chapter.segments)) {
    return 0;
  }
  let n = 0;
  for (const sg of chapter.segments) {
    n += typeof sg?.text === 'string' ? sg.text.length : 0;
  }
  return n;
}

/**
 * 全书正文字数（**供 FTS 闸门等「需要全书规模」判断使用**）。
 *
 * ★ 存在理由：`StorageService.bookTextChars` 原本内联遍历全书正文求和，
 *   偏移量化后会恒返回 ~0 ⇒ `FTS_MAX_BOOK_CHARS`（4M）闸门**形同虚设**，
 *   中等书会被误判为「很小」而全部入索引 ⇒ 反而制造新的索引卡顿。
 *
 * @returns 字数和；`charCount` 缺失的章回落到遍历该章 `segments`。
 */
export function bookTextChars(book: Book): number {
  let n = 0;
  for (const ch of book.chapters ?? []) {
    n += chapterCharCount(ch);
  }
  return n;
}

/**
 * 全书段数（供描述字段与覆盖判据使用；与 `Chapter.segCount` 同源）。
 */
export function bookSegCount(book: Book): number {
  let n = 0;
  for (const ch of book.chapters ?? []) {
    n += chapterSegCount(ch);
  }
  return n;
}