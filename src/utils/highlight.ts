/**
 * 划线高亮计算工具
 * 约定：所有偏移量基于 Array.from(text) 的码点索引，
 * 与 PinyinText 的逐字渲染基准保持一致。
 */
import type { Highlight, HighlightColor } from '@/types';

/** 归一化后的划线区间 */
export interface HighlightRange {
  /** 起始偏移（码点索引，含） */
  start: number;
  /** 结束偏移（码点索引，不含） */
  end: number;
  /** 划线颜色 */
  color: HighlightColor;
  /** 所属划线 ID */
  highlightId: string;
}

/** 带颜色标记的文本片段 */
export interface HighlightedSegment {
  /** 片段文本 */
  text: string;
  /** 起始偏移（码点索引） */
  start: number;
  /** 结束偏移（码点索引，不含） */
  end: number;
  /** 命中的划线（未命中为 undefined） */
  highlight?: Highlight;
}

/** 纯区间（无颜色信息） */
export interface PlainRange {
  start: number;
  end: number;
}

/**
 * 根据 Highlight[] 计算渲染区间。
 * - 偏移量按码点索引 clamp 到 [0, text 长度]，过滤无效区间
 * - 重叠区间按创建时间先后应用：新划线覆盖旧划线
 */
export function computeHighlightRanges(
  segmentText: string,
  highlights: Highlight[],
): HighlightRange[] {
  const chars = Array.from(segmentText);
  const len = chars.length;
  if (len === 0 || highlights.length === 0) {
    return [];
  }

  // 按 createdAt 升序：后创建的划线后填充，自然覆盖旧划线
  const sorted = [...highlights].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
  );

  // 每个码点位置命中的划线 ID
  const owner = new Array<string | undefined>(len);
  for (const h of sorted) {
    const start = Math.max(0, Math.floor(h.startOffset));
    const end = Math.min(len, Math.ceil(h.endOffset));
    if (start >= end) {
      continue;
    }
    for (let i = start; i < end; i++) {
      owner[i] = h.id;
    }
  }

  // 相同归属的连续位置合并为区间
  const idToHighlight = new Map(sorted.map((h) => [h.id, h] as const));
  const ranges: HighlightRange[] = [];
  let cursor = 0;
  while (cursor < len) {
    const id = owner[cursor];
    let end = cursor + 1;
    while (end < len && owner[end] === id) {
      end++;
    }
    if (id !== undefined) {
      const h = idToHighlight.get(id);
      if (h) {
        ranges.push({ start: cursor, end, color: h.color, highlightId: id });
      }
    }
    cursor = end;
  }
  return ranges;
}

/**
 * 合并重叠（或相邻）的纯区间。
 * 输入顺序任意，输出按 start 升序且互不重叠。
 */
export function mergeRanges(ranges: PlainRange[]): PlainRange[] {
  const valid = ranges
    .map((r) => ({ start: Math.floor(r.start), end: Math.ceil(r.end) }))
    .filter((r) => r.start < r.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: PlainRange[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      // 重叠或相邻：扩展右端
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * 将文本切分为带颜色标记的片段数组。
 * 未命中划线的部分 highlight 为 undefined。
 */
export function buildHighlightedSegments(
  text: string,
  highlights: Highlight[],
): HighlightedSegment[] {
  const chars = Array.from(text);
  const len = chars.length;
  if (len === 0) {
    return [];
  }

  const ranges = computeHighlightRanges(text, highlights);
  const idToHighlight = new Map(highlights.map((h) => [h.id, h] as const));

  const segments: HighlightedSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({
        text: chars.slice(cursor, range.start).join(''),
        start: cursor,
        end: range.start,
      });
    }
    segments.push({
      text: chars.slice(range.start, range.end).join(''),
      start: range.start,
      end: range.end,
      highlight: idToHighlight.get(range.highlightId),
    });
    cursor = range.end;
  }
  if (cursor < len) {
    segments.push({
      text: chars.slice(cursor, len).join(''),
      start: cursor,
      end: len,
    });
  }
  return segments;
}
