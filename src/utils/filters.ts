/**
 * 列表筛选纯函数（P1-10 笔记时间范围 / P1-13 收藏标签筛选）
 * 独立于 UI 与存储层，便于单元测试锁定筛选语义。
 */
import type { Bookmark, BookmarkType } from '@/types';

/** 笔记时间范围：全部 / 今天 / 本周（周一为起点）/ 本月 */
export type TimeRange = 'all' | 'today' | 'week' | 'month';

/** 时间范围选项（供筛选 chips 渲染） */
export const TIME_RANGE_OPTIONS: { key: TimeRange; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

/**
 * 时间范围的起点时刻（毫秒，含）；'all' 返回 null 表示不过滤。
 * - today：今天 00:00（本地时区）
 * - week：本周周一 00:00（本地时区）
 * - month：本月 1 日 00:00（本地时区）
 */
export function timeRangeStartMs(range: TimeRange, now: Date = new Date()): number | null {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case 'today':
      return dayStart.getTime();
    case 'week': {
      // getDay(): 0=周日；以周一为一周起点，偏移 (day + 6) % 7 天
      const offsetDays = (dayStart.getDay() + 6) % 7;
      return dayStart.getTime() - offsetDays * 24 * 60 * 60 * 1000;
    }
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case 'all':
    default:
      return null;
  }
}

/**
 * 按时间范围过滤（P1-10）。
 * getTimeISO 提取条目的 ISO 时间字符串；无效时间在非 'all' 范围下视为不命中。
 */
export function filterByTimeRange<T>(
  items: T[],
  getTimeISO: (item: T) => string,
  range: TimeRange,
  now: Date = new Date(),
): T[] {
  const startMs = timeRangeStartMs(range, now);
  if (startMs === null) {
    return items;
  }
  return items.filter((item) => {
    const t = new Date(getTimeISO(item)).getTime();
    return !Number.isNaN(t) && t >= startMs;
  });
}

/**
 * 解析收藏专用标签（P1-05）：解析收藏以 paragraph 类型 + 本标签存储，
 * 收藏列表据此提供独立的「解析」筛选档，与标签筛选 AND 叠加。
 */
export const ANALYSIS_TAG = '解析';

/**
 * 收藏筛选（P1-13）：类型（'' 为全部）与标签（'' 为全部）叠加，AND 语义。
 * 标签命中要求条目 tags 包含该标签。
 * analysisOnly（P1-05）：仅保留带 ANALYSIS_TAG 的解析收藏，可与其余条件叠加。
 */
export function filterBookmarks(
  items: Bookmark[],
  type: BookmarkType | '',
  tag: string,
  analysisOnly = false,
): Bookmark[] {
  return items.filter((b) => {
    if (analysisOnly && !(b.tags ?? []).includes(ANALYSIS_TAG)) {
      return false;
    }
    if (type && b.type !== type) {
      return false;
    }
    if (tag && !(b.tags ?? []).includes(tag)) {
      return false;
    }
    return true;
  });
}

/** 是否存在解析收藏（P1-05：用于收藏列表决定是否显示「解析」筛选档） */
export function hasAnalysisBookmarks(items: Bookmark[]): boolean {
  return items.some((b) => (b.tags ?? []).includes(ANALYSIS_TAG));
}

/** 无标签收藏在分组视图中的归属组名（P2-09） */
export const UNGROUPED_LABEL = '未分组';

/** 分组视图的一个分组（P2-09） */
export interface BookmarkGroup {
  /** 组名：首标签，或 UNGROUPED_LABEL（无标签） */
  tag: string;
  /** 是否为「未分组」（无标签收藏） */
  ungrouped: boolean;
  /** 组内收藏（保持输入顺序） */
  items: Bookmark[];
}

/**
 * 按首标签分组（P2-09 收藏夹分组·轻量）。
 * 口径：
 * - 仅按 tags[0] 归组——多标签收藏只出现在首标签对应的组（口径：first-tag）；
 * - 无标签收藏归入「未分组」组；
 * - 组顺序 = 各首标签在输入中的首次出现顺序；组内保持原顺序；
 * - 不产生空组（每组至少含一条收藏）。
 * 输入通常是筛选后的列表，分组不改变筛选语义。
 */
export function groupBookmarksByFirstTag(items: Bookmark[]): BookmarkGroup[] {
  const map = new Map<string, BookmarkGroup>();
  for (const b of items) {
    const tags = b.tags ?? [];
    const tag = tags.length > 0 ? tags[0] : UNGROUPED_LABEL;
    let group = map.get(tag);
    if (!group) {
      group = { tag, ungrouped: tags.length === 0, items: [] };
      map.set(tag, group);
    }
    group.items.push(b);
  }
  return Array.from(map.values());
}
