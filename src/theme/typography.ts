/**
 * 字体尺寸与行距常量
 */

/** 字号档位：小 / 中 / 大 / 特大 */
export const FONT_SIZE_OPTIONS = [16, 18, 20, 24] as const;

/** 行距倍数：紧凑 / 标准 / 宽松 */
export const LINE_HEIGHT_OPTIONS = [1.4, 1.6, 1.8] as const;

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
