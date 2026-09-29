/**
 * 版心布局（L1 之下、渲染层之上）——左右边距 + 水平居中唯一真源。
 *
 * 背景（真机实证 2026-09-29）：ScrollMode 的行容器原为 `left:0 right:0` 全宽，
 * 未应用边距 ⇒ 正文贴左边、右边多出 2×margin（与 hitTest 的 `locationX - margin`
 * 口径自相矛盾）。本模块把「版心壳 + 文字块偏移」显式化，渲染层只消费结果。
 *
 * 【三条必须同时成立的约束（真机 1080×2504 / density 500 = 345.6dp 实测）】
 *
 * 1) **容器宽 ≡ 几何 containerWidth**（否则丢字）。行化层按 `containerWidth` 切行
 *    （16 字/行），渲染容器若比它窄，超出部分被 `overflow:'hidden'` 裁掉 ——
 *    实测：把左右 inset 都取 29dp 时容器 = 287.4dp < 305.6dp ⇒ **每行第 16 字不可见**
 *    （行墨迹只到第 15 格末 942px，而第 16 格为 [946,1003]）。
 *    ⇒ 故 `left + right ≡ 窗宽 − contentWidth`，容器宽恒 = `contentWidth`。
 *
 * 2) **文字块左右留白相等**（视觉居中）。文字块宽 = `gridWidth = charsPerLine × cellAdvance`
 *    （整字数栅格），比 `contentWidth` 少 `2×shift`。把版心整体右移 `shift`
 *    （`left = base + shift`、`right = base − shift`，`base = (窗宽 − contentWidth)/2`）
 *    ⇒ 左留白 = 右留白 = `base + shift`，且 `2×left + gridWidth ≡ 窗宽`（精确居中）。
 *
 * 3) **边距是下限**（用户档位只增不减）。因栅格取整，生效留白 = `base + shift`
 *    （base ≥ margin，shift ≤ 半个字格），宽屏受上限约束时 base 更大。
 *
 * 若只做 2) 不做 1)（把 inset 直接取成居中值），第 1 条被破坏 ⇒ 丢字（已实测）。
 *
 * 纯函数：零 React / 零状态；窗宽、用户边距、单格步进入，几何量出。
 */
import { PAGE_MARGIN_DEFAULT, PAGE_MARGIN_MAX, PAGE_MARGIN_MIN } from '../theme/typography';

/** 版心最大宽度（dp）：约 35 个 18px 汉字，宽屏下避免行长过长伤阅读 */
export const READER_MAX_CONTENT_WIDTH = 640;

export interface ContentLayout {
  /** 生效边距下限（clamp 到合法区间后的用户设定值） */
  readonly margin: number;
  /** 版心宽（= 窗宽 − 2×margin，上限 maxContentWidth；渲染容器宽与行化 containerWidth 的唯一来源） */
  readonly contentWidth: number;
  /** 文字块宽 = charsPerLine × cellAdvance（整字数栅格；≤ contentWidth） */
  readonly gridWidth: number;
  /** 渲染容器左偏移 = base + shift（文字块左缘） */
  readonly left: number;
  /**
   * 渲染容器右偏移 = base − shift（shift 可大于 base 时为负：容器可略超窗宽，
   * 但文字块恒在窗内 —— left + gridWidth = base + (contentWidth + gridWidth)/2 ≤ 窗宽 − base）。
   */
  readonly right: number;
}

/** 区间钳制 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 版心解析（纯函数）：窗宽 + 用户边距 + 单格步进 → { margin, contentWidth, gridWidth, left, right }。
 *
 * - 窗宽保留小数（dp 常带小数，如 1080px / 500dpi = 345.6dp），**偏移不取整**
 *   （取整会让 left + right 偏离 2×margin，容器宽与几何口径失配 ⇒ 亚像素裁字）；
 * - margin 先 clamp 到 [MIN, MAX]，再在该窗宽下二次收敛（半窗宽为上限）；
 * - cellAdvance 非有限/非正（脏输入）⇒ 退化为 shift = 0（文字块 = 版心，旧行为）。
 *
 * @param cellAdvance 单格步进 dp（= cellAdvanceFor(fontSize, charGap)，几何层同源）
 */
export function resolveContentLayout(
  windowWidth: number,
  pageMargin: number,
  cellAdvance: number,
  maxContentWidth: number = READER_MAX_CONTENT_WIDTH,
): ContentLayout {
  const w = Math.max(1, Number.isFinite(windowWidth) ? windowWidth : 0);
  const requested = Number.isFinite(pageMargin) ? Math.round(pageMargin) : PAGE_MARGIN_DEFAULT;
  const margin = clamp(requested, PAGE_MARGIN_MIN, Math.min(PAGE_MARGIN_MAX, Math.floor((w - 1) / 2)));
  const available = Math.max(1, w - margin * 2);
  const cap = Math.max(1, Math.round(maxContentWidth));
  const contentWidth = Math.max(1, Math.min(available, cap));

  // 整字数栅格（与 L1 charsPerLine 同口径：floor(contentWidth / cellAdvance)）
  const adv = Number.isFinite(cellAdvance) && cellAdvance > 0 ? cellAdvance : 0;
  const charsPerLine = adv > 0 ? Math.max(1, Math.floor(contentWidth / adv)) : 0;
  const gridWidth = Math.max(1, Math.min(adv > 0 ? charsPerLine * adv : contentWidth, contentWidth));

  // 版心整体右移 shift ⇒ 文字块在窗内精确居中；left + right 恒 = 窗宽 − contentWidth（约束 1 不回退）
  const base = Math.max(margin, (w - contentWidth) / 2);
  const shift = (contentWidth - gridWidth) / 2;
  const left = base + shift;
  const right = base - shift;
  return { margin, contentWidth, gridWidth, left, right };
}
