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
 * - 行平均码点数 ≤ longRowThreshold（内置书场景）→ 维持 maxRows，行为与旧版完全一致；
 * - 行平均码点数超阈值（导入书大段落场景）→ 按字符预算累计，初始只渲染预算内行数，
 *   其余行交给 FlatList 窗口化随滚动增量渲染。
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
  /** 最多初始渲染行数（与旧固定值 30 一致，内置书行为不变） */
  maxRows?: number;
  /** 行平均码点数超过该值才按预算收缩初始行数（内置书段落远低于此值） */
  longRowThreshold?: number;
}

/** 缺省值：3000 字预算约对应全文注音模式 8~10 屏内容 */
export const SCROLL_INITIAL_ROWS_DEFAULTS = {
  charBudget: 3000,
  minRows: 2,
  maxRows: 30,
  longRowThreshold: 300,
} as const;

/**
 * 计算滚动模式初始渲染行数。
 * @param rowCharCounts 各行码点数（标题行传 0；顺序与渲染顺序一致）
 * @param options 计算选项
 * @returns initialNumToRender 取值（1 ~ maxRows 之间）
 */
export function computeScrollInitialRows(
  rowCharCounts: readonly number[],
  options: ScrollInitialRowsOptions = {},
): number {
  const { charBudget, minRows, maxRows, longRowThreshold } = {
    ...SCROLL_INITIAL_ROWS_DEFAULTS,
    ...options,
  };

  // 无数据（章节尚未就绪）时给默认上限，行为等同旧版固定值
  if (rowCharCounts.length === 0) {
    return maxRows;
  }

  const withinMax = Math.min(maxRows, rowCharCounts.length);
  let sum = 0;
  for (let i = 0; i < withinMax; i += 1) {
    sum += rowCharCounts[i];
  }

  // 内置书场景：行平均码点数低于阈值 → 维持固定 maxRows，与旧版行为完全一致
  if (sum / withinMax <= longRowThreshold) {
    return maxRows;
  }

  // 导入书大段落场景：按字符预算累计行码点数，超出即停止（标题行计 0 字）
  let acc = 0;
  for (let i = 0; i < withinMax; i += 1) {
    acc += rowCharCounts[i];
    if (acc > charBudget) {
      // 至少渲染 minRows 行，保证初始窗口有可滚动内容
      return Math.max(minRows, i + 1);
    }
  }
  // 预算内已覆盖前 maxRows 行（数据不足 maxRows 行）：渲染全部即可
  return maxRows;
}
