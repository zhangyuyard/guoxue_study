/**
 * 阅读分页纯函数（与 RN 渲染无关，便于单测）。
 *
 * 设计约束：国学正文带「逐字注音 + 通假字角标」，无法用单一 <Text> 的 onTextLayout
 * 做行级切分（自定义 ruby 布局）。因此分页以「段落（segment）」为最小不可拆单元：
 * 用运行时 onLayout 量得每段高度后，贪心装箱进若干「页」。
 * - 单段即超过整页高度 → 独占一页并标记 overflow（由页内纵向滚动兜底，避免裁切正文）。
 * - 其余页严格不超出页高，翻页即翻段，选区 / 划线偏移基准不变。
 */

/** 待分页的块（段落或伪块如章标题），height 为已量得的高度（px） */
export interface PaginateBlock {
  id: string;
  height: number;
}

/** 分页结果：一页包含的块、内容总高、是否溢出（需页内滚动） */
export interface PaginatedPage {
  blocks: PaginateBlock[];
  /** 本页内容总高（含段间距） */
  height: number;
  /** 是否因单段超高而溢出（该页内容 > 页高） */
  overflow: boolean;
}

/**
 * 贪心分页：按 blocks 顺序装箱，每页内容总高不超过 pageHeight。
 * @param blocks   段落块（已含章标题伪块、顺序与正文一致）
 * @param pageHeight 可用页高（已扣除页内上下 padding 预算）
 * @param gap      段间距（每段之间的垂直间距）。
 *                 注意：blocks[].height 通常已包含该块自身的下外边距（章标题
 *                 marginBottom / 段落 marginBottom），此时应传 0，否则间距被
 *                 重复计算，每页底部会白空出一大片，甚至把首段挤到第二页。
 * @param keepWithNext 返回 true 的块「不允许单独成页」（如章标题）：若紧邻其后
 *                 的块放不进本页，则该块连同后续块一起落到同一页，即便因此超出
 *                 页高也照做（标记 overflow，由页内纵向滚动兜底）。
 *                 没有这条规则时，「章标题 + 首段」一旦超过一页就会产出
 *                 「只有标题、正文全在下一页」的空白首页。
 */
export function paginateBlocks(
  blocks: PaginateBlock[],
  pageHeight: number,
  gap = 0,
  keepWithNext?: (id: string) => boolean,
): PaginatedPage[] {
  const pages: PaginatedPage[] = [];
  let cur: PaginateBlock[] = [];
  let curH = 0;

  const flush = () => {
    if (cur.length > 0) {
      pages.push({ blocks: cur, height: curH, overflow: false });
      cur = [];
      curH = 0;
    }
  };

  for (const b of blocks) {
    // 当前页剩下的块是否全都是「不可单独成页」的块（典型：仅一个章标题）
    const onlyKeepWithNext =
      keepWithNext != null && cur.length > 0 && cur.every((x) => keepWithNext(x.id));

    // 单段超高：独占一页并标记溢出
    if (b.height > pageHeight) {
      if (cur.length > 0) {
        if (onlyKeepWithNext) {
          // 标题不能独自成页 → 随这个超高段一起落到本页（页内可纵向滚动）
          const carriedH = curH;
          cur.push(b);
          pages.push({
            blocks: cur,
            height: carriedH + gap + b.height,
            overflow: true,
          });
          cur = [];
          curH = 0;
          continue;
        }
        flush();
      }
      pages.push({ blocks: [b], height: b.height, overflow: true });
      continue;
    }

    // 当前页已有内容，且放入本段会超页高 → 另起一页
    const gapBefore = cur.length > 0 ? gap : 0;
    if (cur.length > 0 && curH + gapBefore + b.height > pageHeight) {
      if (onlyKeepWithNext) {
        // 标题不能独自成页 → 整页内容顺延，与后一段同页（该页允许溢出）
        cur.push(b);
        pages.push({
          blocks: cur,
          height: curH + gapBefore + b.height,
          overflow: true,
        });
        cur = [];
        curH = 0;
        continue;
      }
      flush();
    }

    const g = cur.length > 0 ? gap : 0;
    cur.push(b);
    curH += g + b.height;
  }

  flush();

  return pages;
}

/**
 * 计算超高段落的码点切分边界（含 0 与 charCount，结果单调递增）。
 * 仿真翻页模式下，单段高度超过一页时按此切分为若干「字符区间块」，
 * 每块作为独立分页块参与装箱，实现「超出一屏的段落跨多页翻页阅读」。
 *
 * 切分策略：贪心填充而非均分——第一块填满该段所在页的剩余空间（firstBudget），
 * 后续每块填满一整页，剩余不足一块时并入末块。这样「当前页装满后剩余部分
 * 从下一页开始」，页面利用率与常规翻页一致；每码点高度按 height/charCount
 * 线性近似，块高由 sizer 实测，若某块仍超高（超出容差）可对其递归再切。
 *
 * @param height      段落整体实测高度（px）
 * @param pageBudget  可用页高（px，已扣除页内 padding）
 * @param charCount   段落码点数（与选区/划线偏移基准一致）
 * @param firstBudget 该段所在页的剩余可用空间（px）；默认整页（段起新页时）
 */
export function computeChunkBoundaries(
  height: number,
  pageBudget: number,
  charCount: number,
  firstBudget: number = pageBudget,
): number[] {
  if (!(pageBudget > 0) || charCount <= 1 || height <= pageBudget) {
    return [0, charCount];
  }
  const perChar = height / charCount;
  const bounds: number[] = [0];
  let pos = 0;
  let budget = firstBudget > 0 ? firstBudget : pageBudget;
  while (pos < charCount) {
    // floor 保证不超预算（宁可少装，由后续块补齐）；至少 1 个码点保证推进
    const take = Math.max(1, Math.floor(budget / perChar));
    pos = Math.min(charCount, pos + take);
    bounds.push(pos);
    budget = pageBudget;
  }
  // 末块若只剩孤字（< 2 个码点），并入前一块，避免产生「一行只有一两个字」的碎页
  if (bounds.length >= 3 && charCount - bounds[bounds.length - 2] < 2) {
    bounds.splice(bounds.length - 2, 1);
  }
  return bounds;
}
