/**
 * 划线构造纯函数（R2d-1）。
 *
 * 口径（唯一真源，渲染层 buildHighlightedSegments 同一坐标系）：
 * offset 单位 = 段内**码点**索引（Array.from 语义），非 UTF-16 code unit。
 * 整段划线 = [0, 码点总长)；含代理对（emoji/生僻扩展区字）时
 * text.length（UTF-16 单位）会多算，必须走码点口径。
 */
import type { Highlight, HighlightColor } from '@/types';

export function buildSegmentHighlight(
  bookId: string,
  chapterId: string,
  segmentId: string,
  text: string,
  color: HighlightColor,
  createdAt: string = new Date().toISOString(),
): Highlight {
  return {
    id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    bookId,
    chapterId,
    segmentId,
    startOffset: 0,
    endOffset: Array.from(text).length,
    color,
    text,
    createdAt,
  };
}
