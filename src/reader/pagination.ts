/**
 * R3-1 翻页纯函数层：章 → 页切分 + 页↔滚动位置互算。
 *
 * 判据纪律（docs/progress-alignment §4.3）：R3 动手前先立
 * 「滚动↔翻页互切位置往返」判据——本文件即判据承载层，见
 * pagination.test.ts T2/T3/T5（offsetOfPage ∘ pageAtOffset 幂等往返回路）。
 *
 * 模型（保守，与行化同哲学 §7.2 第 4 条）：
 * - 页 = 整数行区间，行对齐 ⇒ 翻页落点永不裁半行（linesPerPage = floor）；
 * - **可达页域**：pageCount = floor(maxScroll / pageStride) + 1——末页 = 滚动
 *   到底（offset = maxScroll）。满页时末页也行对齐；不满页（余数行）时
 *   「往前翻到末页」与「滚到底」是同一落点，floor 语义下共享页号——这是
 *   模型性质而非缺陷，T3 断言按此立。
 * - T2 变异判据：pageAtOffset 用 round 会把页首前半屏误归下页 ⇒ 往返红。
 */
import type { ChapterLayout, LineGeometry } from './geometry';

export interface Pagination {
  readonly linesPerPage: number;
  readonly pageCount: number;
  /** 一页的滚动步长 = linesPerPage × rowHeight */
  readonly pageStride: number;
  /** 行高（页↔行换算基准 = pageStride / linesPerPage） */
  readonly rowHeight: number;
  /** 滚动可达上界 = max(0, totalHeight − viewportHeight) */
  readonly maxScroll: number;
}

/**
 * 章分页。viewportHeight ≤ 0 或 0 行章 → pageCount = 0（无可翻页）。
 */
export function paginateChapter(
  layout: ChapterLayout,
  g: LineGeometry,
  viewportHeight: number,
): Pagination {
  const lineCount = layout.lines.length;
  const rowHeight = g.rowHeight;
  if (viewportHeight <= 0 || lineCount === 0) {
    return { linesPerPage: 1, pageCount: 0, pageStride: 0, rowHeight, maxScroll: 0 };
  }
  const linesPerPage = Math.max(1, Math.floor(viewportHeight / rowHeight));
  const pageStride = linesPerPage * rowHeight;
  const maxScroll = Math.max(0, lineCount * rowHeight - viewportHeight);
  const pageCount = Math.floor(maxScroll / pageStride) + 1;
  return { linesPerPage, pageCount, pageStride, rowHeight, maxScroll };
}

/**
 * 页序号 → 滚动 offset。
 * - 普通页：page × pageStride（行对齐页首）；
 * - **末页特判 = maxScroll（滚到底）**：余数行并入末页视口，保证「翻到
 *   末页必见尾行」（否则末页 offset 行对齐落在尾行之前，最后几行无页可翻
 *   ——真机可感缺陷）。floor 语义下 maxScroll 页号 = pageCount−1 恒成立
 *   （数学：pageCount = floor(maxScroll/stride)+1 ⇒ maxScroll/stride ∈
 *   [pageCount−1, pageCount) ⇒ floor = pageCount−1），往返判据 T2 全域闭合。
 * - 越界页号 clamp 到末页。
 */
export function offsetOfPage(p: Pagination, page: number): number {
  if (p.pageCount === 0) {
    return 0;
  }
  const clampedPage = Math.min(Math.max(page, 0), p.pageCount - 1);
  return clampedPage === p.pageCount - 1 ? p.maxScroll : clampedPage * p.pageStride;
}

/**
 * 滚动 offset → 页序号（floor：滚动位置在页中间时归入当前页）。
 */
export function pageAtOffset(p: Pagination, y: number): number {
  if (p.pageCount === 0) {
    return 0;
  }
  const page = Math.floor(Math.max(0, y) / p.pageStride);
  return Math.min(page, p.pageCount - 1);
}

/**
 * 定长切块：页 = 定长行区间。
 * 末页 = 余数行（不足一页也成页，渲染顶对齐、底部留白）。
 * size ≤ 0 或空输入 → 空数组。
 */
export function chunkLines<T>(lines: readonly T[], size: number): T[][] {
  if (size <= 0 || lines.length === 0) {
    return [];
  }
  const out: T[][] = [];
  for (let i = 0; i < lines.length; i += size) {
    out.push(lines.slice(i, i + size));
  }
  return out;
}
