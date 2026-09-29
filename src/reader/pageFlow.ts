/**
 * 页流解析（legado TextPageFactory 机制对齐，docs/reader-legado-full-analysis-2026-09-24.md §2）。
 *
 * 页 = 一屏行（排版期由 linesPerPage 切定）；页流跨章连续：
 * 章内下一页 → 下一章第 0 页（含章首标题行）。章界在页工厂内部消化，
 * 滚动状态机不感知章（legado ContentTextView.scroll 同构）。
 *
 * 解析失败（null）两义，由调用方以 hasMorePrev/hasMoreNext 区分：
 * - 书首/书尾封口 → 硬钳（legado 顶/尾钳，ContentTextView.scroll L279-286）
 * - 窗口外未载 → loading 占位块渲染 + 钳住（legado msg 页「加载中…」，我们更稳：不进 pr）
 */
import type { Line } from './geometry';

export interface PageRef {
  chapterId: string;
  /** 章内页号（0 起） */
  page: number;
}

export interface ResolvedPage {
  ref: PageRef;
  lines: readonly Line[];
  /** 页高 = 行数 × rowHeight（末页 = 余数行，legado durY 同构） */
  height: number;
}

export interface ScrollChapter {
  chapterId: string;
  lines: readonly Line[];
}

export function pageCountOf(ch: ScrollChapter, linesPerPage: number): number {
  const lpp = Math.max(1, Math.floor(linesPerPage));
  return Math.max(1, Math.ceil(ch.lines.length / lpp));
}

export function pageLinesOf(
  ch: ScrollChapter,
  linesPerPage: number,
  page: number,
): readonly Line[] {
  const lpp = Math.max(1, Math.floor(linesPerPage));
  const start = page * lpp;
  return ch.lines.slice(start, start + lpp);
}

/**
 * 步进解析页流。dir = -1 上一页 / 0 当前页 / +1 下一页。
 * legado TextPageFactory.curPage/nextPage/prevPage 的跨章规则：
 * 章内越界即跨到邻章（next=下章 p0、prev=上章末页）。
 */
export function resolvePage(
  chapters: readonly ScrollChapter[],
  linesPerPage: number,
  rowHeight: number,
  ref: PageRef,
  dir: -1 | 0 | 1,
): ResolvedPage | null {
  const idx = chapters.findIndex((c) => c.chapterId === ref.chapterId);
  if (idx < 0) {
    return null;
  }
  const ch = chapters[idx];
  const pc = pageCountOf(ch, linesPerPage);
  let target: PageRef;
  if (dir === 0) {
    target = { chapterId: ref.chapterId, page: Math.min(Math.max(0, ref.page), pc - 1) };
  } else if (dir === 1) {
    // legado nextPage：章内 p+1 → 下章 p0（L73-92）
    if (ref.page + 1 < pc) {
      target = { chapterId: ref.chapterId, page: ref.page + 1 };
    } else if (idx + 1 < chapters.length) {
      target = { chapterId: chapters[idx + 1].chapterId, page: 0 };
    } else {
      return null;
    }
  } else {
    // legado prevPage：章内 p-1 → 上章末页（L94-110）
    if (ref.page > 0) {
      target = { chapterId: ref.chapterId, page: ref.page - 1 };
    } else if (idx - 1 >= 0) {
      const prevCh = chapters[idx - 1];
      target = { chapterId: prevCh.chapterId, page: pageCountOf(prevCh, linesPerPage) - 1 };
    } else {
      return null;
    }
  }
  const tch = chapters.find((c) => c.chapterId === target.chapterId);
  if (!tch) {
    return null;
  }
  const lines = pageLinesOf(tch, linesPerPage, target.page);
  return { ref: target, lines, height: lines.length * Math.max(1, rowHeight) };
}

/**
 * 前进 n 页的页流解析（legado nextPlusPage 的跨章规则，TextPageFactory L112-130：
 * cur=末页时 nextPlus=下章 p1）——循环 n 次 resolvePage(+1) 步进，中途 null 即 null。
 */
export function resolveN(
  chapters: readonly ScrollChapter[],
  linesPerPage: number,
  rowHeight: number,
  ref: PageRef,
  n: number,
): ResolvedPage | null {
  let cur: PageRef = ref;
  let resolved: ResolvedPage | null = null;
  for (let i = 0; i < n; i++) {
    resolved = resolvePage(chapters, linesPerPage, rowHeight, cur, 1);
    if (!resolved) {
      return null;
    }
    cur = resolved.ref;
  }
  return resolved;
}
