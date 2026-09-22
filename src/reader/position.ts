/**
 * L2 位置模型 —— 位置真值 = (chapterId, charOffset)（章内码点偏移，与排版无关）。
 * 纯函数，消费 L1 的 Line[] / LineGeometry（docs/reader-architecture-2026-09-22.md §4）。
 *
 * 不变量 INV-P1（往返一致）：对任意章内码点 c，
 *   lineAtCharOffset(lines, charOffsetAtY(lines, g, yOfLine(g, lineAtCharOffset(lines, c))).charOffset)
 *   === lineAtCharOffset(lines, c)
 * 即「码点 → 行 → Y → 行 → 码点」保行不变；精确等号当且仅当 c 为行首。
 */
import type { Line, LineGeometry } from './geometry';

/** 码点 → 行下标（二分）。找不到（空章 / 偏移越界于首行之前）返回 -1。 */
export function lineAtCharOffset(lines: readonly Line[], charOffset: number): number {
  if (lines.length === 0 || charOffset < lines[0].charStart) {
    return -1;
  }
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].charStart <= charOffset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 行下标 → 视口 Y（开环，无测量）：y = index × rowHeight */
export function yOfLine(g: LineGeometry, index: number): number {
  return index * g.rowHeight;
}

/** 视口 Y → 行下标（floor；负 Y 钳 0 —— 通假字圆标向上溢出区仍属第 0 行） */
export function lineAtY(g: LineGeometry, y: number): number {
  return Math.max(0, Math.floor(y / g.rowHeight));
}

/**
 * 视口 Y → 位置（行粒度）：Y 只能决定行，码点取该行行首 charStart。
 * 空章返回 { lineIndex: -1, charOffset: -1 }。
 */
export function charOffsetAtY(
  lines: readonly Line[],
  g: LineGeometry,
  y: number,
): { lineIndex: number; charOffset: number } {
  if (lines.length === 0) {
    return { lineIndex: -1, charOffset: -1 };
  }
  const lineIndex = Math.min(lineAtY(g, y), lines.length - 1);
  return { lineIndex, charOffset: lines[lineIndex].charStart };
}
