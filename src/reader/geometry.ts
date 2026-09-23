/**
 * L1 行化层 —— 阅读器几何唯一真源（架构方案 §4，docs/reader-architecture-2026-09-22.md）。
 *
 * 纯函数：零 React / 零时钟 / 零状态。输入只有「文本 + 常量档位」，
 * 不含注音结果（U7：几何不得等注音）——注音就绪与否不改变任何几何量。
 *
 * 行高公式与渲染器（components/reader/PinyinText.tsx）逐字同源：
 *   pinyinSize       = max(9, round(fontSize × PINYIN_FONT_RATIO))
 *   pinyinLineHeight = round(pinyinSize × 1.35)
 *   charLineHeight   = round(fontSize × 1.3)
 *   rowGap           = max(2, round(fontSize × (lineHeight − 1)))
 *   pinyinSlot       = pinyinLineHeight + PINYIN_LINE_GAP（方案 D：pinyin.marginBottom 同源）
 *   rowHeight(注音开) = pinyinSlot + charLineHeight + rowGap   // 默认档 16+23+11 = 50
 *   rowHeight(注音关) = round(fontSize × lineHeight)            // 默认档 29
 *
 * 前置硬约束（§7.2）：所有承载正文的 Text 必须 allowFontScaling={false}，
 * 否则 lineHeight 走 SP 随系统 fontScale 缩放，rowHeight 不再是常量（INV-G1 失效）。
 */
import { PINYIN_FONT_RATIO, PINYIN_LINE_GAP } from '../theme/typography';

/** 拼音行高系数（PinyinText.tsx styles.pinyin 同源） */
export const PINYIN_LINE_HEIGHT_RATIO = 1.35;
/** 汉字行高系数（PinyinText.tsx styles.char/styles.run 同源） */
export const CHAR_LINE_HEIGHT_RATIO = 1.3;
/** 拼音字号下限（PinyinText.tsx getPinyinSize 同源） */
export const PINYIN_SIZE_FLOOR = 9;

/**
 * 字格水平间距（渲染器 marginHorizontal 与几何层 cellAdvance 同源，
 * 消除「两处字距公式各自漂移」）。与 PinyinText.tsx 原 charGap 公式逐字同值：
 * 全文注音模式加大避免相邻拼音相贴，其余模式保持紧凑。
 */
export function charGapFor(pinyinMode: 'full' | 'rare' | 'off', fontSize: number): number {
  return pinyinMode === 'full'
    ? Math.max(4, Math.round(fontSize * 0.16))
    : Math.max(2, Math.round(fontSize * 0.06));
}

/** 注音行的行高子项（渲染器与几何层共同消费，消除两处公式漂移） */
export interface PinyinRowMetrics {
  readonly pinyinSize: number;
  readonly pinyinLineHeight: number;
  readonly charLineHeight: number;
  readonly rowGap: number;
  /** 拼音槽高 = pinyinLineHeight + PINYIN_LINE_GAP（方案 D 后 cell/run 同源） */
  readonly pinyinSlot: number;
  /** 行高 = pinyinSlot + charLineHeight + rowGap（默认档 = 50） */
  readonly rowHeight: number;
}

/** 注音行行高子项（纯函数，12 档可枚举穷举测） */
export function pinyinRowMetrics(fontSize: number, lineHeight: number): PinyinRowMetrics {
  const pinyinSize = Math.max(PINYIN_SIZE_FLOOR, Math.round(fontSize * PINYIN_FONT_RATIO));
  const pinyinLineHeight = Math.round(pinyinSize * PINYIN_LINE_HEIGHT_RATIO);
  const charLineHeight = Math.round(fontSize * CHAR_LINE_HEIGHT_RATIO);
  const rowGap = Math.max(2, Math.round(fontSize * (lineHeight - 1)));
  const pinyinSlot = pinyinLineHeight + PINYIN_LINE_GAP;
  return { pinyinSize, pinyinLineHeight, charLineHeight, rowGap, pinyinSlot, rowHeight: pinyinSlot + charLineHeight + rowGap };
}

/** 行几何（L1 → L2/L3 的唯一几何载体） */
export interface LineGeometry {
  readonly fontSize: number;
  /** round(fontSize × lineHeight)；注音关时即 rowHeight */
  readonly lineHeightPx: number;
  /** 行高：注音开 = 固定常量（pinyinRowMetrics）；注音关 = lineHeightPx */
  readonly rowHeight: number;
  /** 字格宽 = fontSize（固定 1em，不再由拼音串撑宽，§7.2 第 1 条） */
  readonly cellWidth: number;
  /** 单格步进 = cellWidth + 2 × charGap（渲染器 marginHorizontal 的真实足迹） */
  readonly cellAdvance: number;
  /** 每行码点数 = max(1, floor(containerWidth / cellAdvance)) */
  readonly charsPerLine: number;
  readonly pinyinEnabled: boolean;
}

export interface ResolveGeometryInput {
  fontSize: number;
  lineHeight: number;
  pinyinEnabled: boolean;
  containerWidth: number;
  /** 字格水平间距（渲染器 marginHorizontal 同值）；缺省 = max(2, round(fontSize × 0.06)) */
  charGap?: number;
}

/** 几何解析（纯函数）：档位 + 容器宽 → 行几何。12 档 × 注音开/关 = 24 个常量，可穷举单测。 */
export function resolveGeometry(input: ResolveGeometryInput): LineGeometry {
  const { fontSize, lineHeight, pinyinEnabled, containerWidth } = input;
  const lineHeightPx = Math.round(fontSize * lineHeight);
  const rowHeight = pinyinEnabled
    ? pinyinRowMetrics(fontSize, lineHeight).rowHeight
    : lineHeightPx;
  const cellWidth = fontSize;
  const charGap = input.charGap ?? Math.max(2, Math.round(fontSize * 0.06));
  const cellAdvance = cellWidth + charGap * 2;
  const charsPerLine = Math.max(1, Math.floor(containerWidth / cellAdvance));
  return { fontSize, lineHeightPx, rowHeight, cellWidth, cellAdvance, charsPerLine, pinyinEnabled };
}

/** 一行：几何已被完全决定的最小布局单元 */
export interface Line {
  readonly index: number;
  readonly chapterId: string;
  readonly segmentId: string;
  /** 章内码点偏移（章局、与排版无关的位置真值；段界处连续累加） */
  readonly charStart: number;
  readonly charEnd: number;
}

export interface ChapterSegment {
  readonly id: string;
  readonly text: string;
}

export interface ChapterLayout {
  readonly lines: Line[];
  /** = lines.length × rowHeight（INV-G1 等式左半） */
  readonly totalHeight: number;
}

/**
 * 章级行化（纯函数）：段文本按码点切行。
 * - 行不跨段（Line 只属一个 segment）；章内码点偏移跨段连续累加。
 * - 每个码点计 1 格（ASCII 亦然）——保守模型：宁可提前折，不可超出（§7.2 第 4 条）。
 * - 空段产出 0 行。
 */
export function layoutChapter(
  chapterId: string,
  segments: readonly ChapterSegment[],
  g: LineGeometry,
): ChapterLayout {
  const lines: Line[] = [];
  let offset = 0;
  for (const seg of segments) {
    const len = Array.from(seg.text).length;
    for (let i = 0; i < len; i += g.charsPerLine) {
      const end = offset + Math.min(i + g.charsPerLine, len);
      lines.push({ index: lines.length, chapterId, segmentId: seg.id, charStart: offset + i, charEnd: end });
    }
    offset += len;
  }
  return { lines, totalHeight: lines.length * g.rowHeight };
}

/**
 * L1/L3 接口（渲染层唯一入口）：无表、无状态、纯算式的 getItemLayout。
 * 前提 = 每行渲染高度恒等于 rowHeight（INV-G1，§7.2 六条改造为其生效前提）。
 */
export function getItemLayoutOf(g: LineGeometry) {
  return (_: unknown, index: number) => ({ length: g.rowHeight, offset: g.rowHeight * index, index });
}
