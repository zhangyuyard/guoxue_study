/**
 * 字体尺寸与行距常量
 */

/** 字号档位：小 / 中 / 大 / 特大 */
export const FONT_SIZE_OPTIONS = [16, 18, 20, 24] as const;

/** 行距倍数：紧凑 / 标准 / 宽松 */
export const LINE_HEIGHT_OPTIONS = [1.4, 1.6, 1.8] as const;

/**
 * 正文左右边距档位（dp，用户可自定义；版心自动水平居中）。
 * 窄 / 标准 / 宽 / 更宽 —— 默认档 = PAGE_MARGIN_DEFAULT。
 */
export const PAGE_MARGIN_OPTIONS = [12, 20, 32, 48] as const;

/** 默认左右边距（标准档） */
export const PAGE_MARGIN_DEFAULT = 20;

/** 左右边距合法区间（设置写入 / 备份恢复统一 clamp 口径） */
export const PAGE_MARGIN_MIN = 0;
export const PAGE_MARGIN_MAX = 120;

/**
 * ★ 滑块（进度条）网格 —— 09-29 起「字号 / 行距 / 左右边距」由分段控件改为滑块。
 *
 * 三条硬约束（改步进前必读）：
 * ① **网格必须覆盖上面三组历史档位**（`FONT_SIZE_OPTIONS` ⊂ `FONT_SIZE_RANGE` 等）：
 *    存量值（默认 18 / 1.6 / 20）落在网格上 ⇒ 拖动不产生「先跳一格」的突变，也无需数据迁移；
 *    该覆盖性由 `src/__tests__/sliderRow.test.ts` 逐值断言（改错步进即红）。
 * ② 步进取「用户能感知的一格」：字号 2px（18→20 视觉差 ≈11%）、行距 0.1（≈6%）、边距 4px；
 *    再细则拖动无手感，再粗则调不到想要的值。
 * ③ 边距滑块上限取 **64** 而非 `PAGE_MARGIN_MAX`(120)：手机上 120dp 只剩 ~5 字/行，没有可用性；
 *    store/备份恢复仍按 [PAGE_MARGIN_MIN, PAGE_MARGIN_MAX] clamp 兜底（120 只可能来自旧备份）。
 *
 * ⚠ 本块必须排在 `PAGE_MARGIN_MIN` **之后**：`PAGE_MARGIN_RANGE` 在模块求值时即读它，
 *    前置会触发 const TDZ ReferenceError（不是类型错误，tsc 不报）。
 */
export interface SliderSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** 字号滑块：14–30px，步进 2（覆盖 16/18/20/24） */
export const FONT_SIZE_RANGE: SliderSpec = { min: 14, max: 30, step: 2 };

/** 行距滑块：1.2–2.0，步进 0.1（覆盖 1.4/1.6/1.8） */
export const LINE_HEIGHT_RANGE: SliderSpec = { min: 1.2, max: 2, step: 0.1 };

/** 左右边距滑块：0–64dp，步进 4（覆盖 12/20/32/48） */
export const PAGE_MARGIN_RANGE: SliderSpec = { min: PAGE_MARGIN_MIN, max: 64, step: 4 };

/** 默认字号 */
export const DEFAULT_FONT_SIZE = 18;

/** 默认行距 */
export const DEFAULT_LINE_HEIGHT = 1.6;

/** 注音字号（相对正文字号的比例） */
export const PINYIN_FONT_RATIO = 0.55;

/** 标题字号 */
export const TITLE_FONT_SIZE = 20;

/** 页面大标题字号 */
export const PAGE_TITLE_FONT_SIZE = 24;

/** 小字（辅助信息） */
export const SMALL_FONT_SIZE = 12;

/** 正文与注音行间距 */
export const PINYIN_LINE_GAP = 2;

/** 章节标题与正文间距 */
export const SECTION_SPACING = 12;

/** 段落间距 */
export const PARAGRAPH_SPACING = 16;

/** 根据正文字号计算行高（px） */
export function getLineHeightPx(fontSize: number, lineHeight: number): number {
  return Math.round(fontSize * lineHeight);
}
