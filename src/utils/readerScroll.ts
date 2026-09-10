/**
 * 连续滚动阅读的初始渲染行数计算（BugFix：滚动模式下导入书无法即时滚动）
 *
 * 根因：ReaderScreen 滚动模式 FlatList 的 initialNumToRender 固定为 30（按「行数」）。
 * 导入书籍单段可达 MAX_SEGMENT_CHARS = 2500 字，且默认注音模式（pinyinMode='full'）
 * 下 PinyinText 逐字渲染——每个汉字一个字格（1 View + 2 Text）。30 行 × 2500 字
 * 最多在首帧同步挂载约 7.5 万个字格（20 万+ 原生视图），JS 线程与原生视图管理器
 * 被压死，表现为打开导入书后长时间无法滚动；内置经典段落极短（几十字），固定 30 行毫无压力。
 *
 * 修复策略：按「内容量（码点数）预算」而非固定行数决定初始渲染行数——
 * 无条件逐行累计码点数，超过 charBudget 即停止扩行，其余行交给 FlatList
 * 窗口化随滚动增量渲染。内置短章经典（单章几段几十字）远达不到预算，
 * 行为与旧固定 30 行一致；超长章（资治通鉴级单段数百行、导入书 2500 字大段）
 * 初始窗口按预算收敛，首帧不再同步挂载数千乃至数万字格。
 *
 * 历史语义注记：旧版在「行平均码点数 ≤ 300」时早退维持 30 行（内置书免算），
 * 但真机实测证明该早退是盲区——资治通鉴级行均仅 ~63 字，永不触发收缩，
 * 30 行 ≈1900 字格首帧挂载实测 jsBlocked≈5.3s；故 v2 移除早退，一律按预算。
 *
 * 设计取舍说明：
 * - 不下调 MAX_SEGMENT_CHARS：用户书已按旧阈值解析并持久化（JSON 存 db），改阈值
 *   既不修复存量书籍，又会使重新导入后的段落 id 变化、划线/笔记偏移失效；
 * - 不给长段落做「首帧渲染上限」之外的拆页：滚动模式的超高段渲染成本由初始行数
 *   收敛后已可接受，拆页属于翻页模式的既有机制，滚动模式引入会破坏 onLayout
 *   偏移与锚点补偿的对应关系；
 * - 深段落定位（续读到章节深处）若目标行超出初始窗口，由既有 LOCATE_TIMEOUT_MS
 *   超时兜底落回章首（代码库既定的可接受降级），优于为定位而重新压死首帧。
 */

/** 计算选项（均可缺省，缺省值见 SCROLL_INITIAL_ROWS_DEFAULTS） */
export interface ScrollInitialRowsOptions {
  /** 初始渲染字符预算（码点数）：累计超过即停止扩行 */
  charBudget?: number;
  /** 最少初始渲染行数（预算被单行超出时的下限） */
  minRows?: number;
  /** 最多初始渲染行数（与旧固定值 30 一致，短章行为不变） */
  maxRows?: number;
}

/** 缺省值：1200 字预算——全文注音模式下约 3~4 屏内容，首帧字格量控制在千级 */
export const SCROLL_INITIAL_ROWS_DEFAULTS = {
  charBudget: 1200,
  minRows: 2,
  maxRows: 30,
} as const;

/**
 * 判断「距内容末尾是否不足预载窗口」（连续滚动向后追加下一章的统一口径）。
 *
 * 背景（BugFix：短章经典滚动模式停在第一章、无法滚动）：《道德经》等内置经典
 * 每章仅一段几十字，单章内容不足一屏 → FlatList 无可滚动区间，物理上产生不了
 * onScroll；RN 的 onEndReached 在内容不满一屏时不触发（Android 长期已知问题）、
 * 追加后仍不满一屏时也不重触发。于是「追加下一章」必须有不依赖滚动事件的
 * 兜底触发点（onContentSizeChange / FlatList onLayout），且其判定口径必须与
 * handleScroll（onScroll）完全一致——统一收敛到本函数，避免多处口径漂移。
 *
 * @param contentHeight 内容总高（px；≤0 视为未量出，返回 false）
 * @param viewHeight 视口高（px；≤0 视为未量出，返回 false）
 * @param scrollOffset 当前滚动偏移（px）
 * @param preloadScreens 预载窗口（屏高倍数）
 * @returns 距末尾不足 preloadScreens 屏时为 true（应追加下一章）
 */
export function isWithinPreloadWindow(
  contentHeight: number,
  viewHeight: number,
  scrollOffset: number,
  preloadScreens: number,
): boolean {
  if (viewHeight <= 0 || contentHeight <= 0) {
    return false;
  }
  return contentHeight - viewHeight - scrollOffset < viewHeight * preloadScreens;
}

/**
 * 滑动窗口丢头方案（阅读器连续滚动「可无限前进」改造）。
 *
 * 背景：连续滚动拼接原以 MAX_CONTINUOUS_CHAPTERS 为「到达即停」的硬上限——序列满后
 * 正文停在章边界，只能靠翻页条前进；阅读器 UI 精简删除翻页条后，改为滑动窗口：
 * appendNextChapter 成功后若序列超限，丢弃头部最旧章节腾位，使连续滚动可无限前进。
 *
 * 丢头安全规则（宁晚勿扰）：
 * - 只丢「严格位于当前阅读章之前」的头部章节：若当前章落在将被丢弃的头部区间内
 *   （用户正在回看头部），本轮不丢，等用户向前进、当前章前移后的下一次触发再丢；
 * - 当前章未知（-1）时保守不丢，绝不丢弃用户可能正在看的内容；
 * - 末章收敛：丢头只发生在 length > max 时，且结果恰好收敛到 max，不会死循环；
 * - 上限边界（恰好 = max）不丢。
 *
 * 丢弃后的滚动偏移补偿由调用方按 rowOffsets 精确计算（保留首行旧偏移 - 被丢首行
 * 旧偏移 = 丢弃内容总高），并在 onContentSizeChange 中消费；偏移不可靠时调用方
 * 应推迟本轮丢弃。
 */
export interface HeadDropPlan {
  /** 丢弃后保留的章 id 序列（保持原顺序，长度恰为 maxChapters） */
  keptChapterIds: string[];
  /** 被丢弃的头部章 id（按原顺序；空数组表示本轮不丢） */
  droppedChapterIds: string[];
}

/**
 * 规划滑动窗口丢头：序列超限时丢弃头部最旧章节，使长度收敛回 maxChapters。
 * @param chapterIds 当前拼接序列的章 id（按拼接顺序）
 * @param activeChapterId 用户当前正在阅读的章 id（未知传 null）
 * @param maxChapters 窗口上限
 * @returns 丢弃方案；droppedChapterIds 为空表示本轮不丢（序列未超限或当前章在头部区间）
 */
export function planHeadDrop(
  chapterIds: readonly string[],
  activeChapterId: string | null,
  maxChapters: number,
): HeadDropPlan {
  // 未超限（含恰好 = 上限的边界）：不丢
  if (chapterIds.length <= maxChapters) {
    return { keptChapterIds: [...chapterIds], droppedChapterIds: [] };
  }
  const excess = chapterIds.length - maxChapters;
  const activeIdx = activeChapterId ? chapterIds.indexOf(activeChapterId) : -1;
  // 当前章未知或落在将被丢弃的头部区间内（用户正在回看头部）→ 本轮不丢（宁晚勿扰）
  if (activeIdx < 0 || activeIdx < excess) {
    return { keptChapterIds: [...chapterIds], droppedChapterIds: [] };
  }
  return {
    keptChapterIds: chapterIds.slice(excess),
    droppedChapterIds: chapterIds.slice(0, excess),
  };
}

/**
 * 计算滚动模式初始渲染行数（v2：无条件按字符预算累计，无行长阈值早退）。
 * @param rowCharCounts 各行码点数（标题行传 0；顺序与渲染顺序一致）
 * @param options 计算选项
 * @returns initialNumToRender 取值（1 ~ maxRows 之间）
 */
export function computeScrollInitialRows(
  rowCharCounts: readonly number[],
  options: ScrollInitialRowsOptions = {},
): number {
  const { charBudget, minRows, maxRows } = {
    ...SCROLL_INITIAL_ROWS_DEFAULTS,
    ...options,
  };

  // 无数据（章节尚未就绪）时给默认上限，行为等同旧版固定值
  if (rowCharCounts.length === 0) {
    return maxRows;
  }

  const withinMax = Math.min(maxRows, rowCharCounts.length);

  // 按字符预算逐行累计，超出即停止（标题行计 0 字）
  let acc = 0;
  for (let i = 0; i < withinMax; i += 1) {
    acc += rowCharCounts[i];
    if (acc > charBudget) {
      // 至少渲染 minRows 行，保证初始窗口有可滚动内容
      return Math.max(minRows, i + 1);
    }
  }
  // 预算内已覆盖前 withinMax 行（短章经典场景）：渲染全部，等同旧版
  return maxRows;
}
