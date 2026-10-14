/**
 * 滚动模式「单击分区」判定（纯函数，零 RN 依赖，可单测）。
 *
 * 背景（2026-10-08 真机实证）：旧实现用左右 30% 的 `Pressable`（absolute +
 * zIndex:10）压在原生 FlatList **之上**作为翻屏热区。覆盖层与 FlatList 是
 * **兄弟** ⇒ 触摸落在覆盖层上，Android 不再把事件交给下层 ScrollView
 * （`ReactScrollView.onInterceptTouchEvent` 只对其**子树内**的触摸生效）⇒
 * 真机差分：从同一健康态出发，x=100 上滑后正文整屏消失、只剩整屏「加载中…」
 * 且再滑不动；x=540 上滑正文正常推进（24 行）。
 *
 * 修法（三层，本文件只负责第 1 层）：
 * ① 覆盖层删除，分区判定改挂 **FlatList 自身** touch 事件（不阻断原生滚动）；
 * ② 判定只用**横向占比**，不做纵向几何命中——理由：纵向命中要靠
 *    `pageY − measureInWindow().y`，而 RN 的 `pageY` 相对 React 根视图、
 *    `measureInWindow` 相对应用窗口（本机实测 `screen=346x764 px=3.125`，
 *    窗口比屏幕矮 117px 状态栏）⇒ 系统性偏移；且铁律 67④ 已证字体实际
 *    advance ≠ 几何 cellAdvance，行内命中本就有 10~30px 误差；
 * ③ 「点字」与「翻屏」的冲突**不在本文件解决**：命中字符的触摸由行内
 *    Pressable 在 press 时刻把 `pageX` 回问宿主（`charTapIntercept`），
 *    宿主按同一分区函数判定并返回「已消费」——**不用时刻对比**（同一手势的
 *    press 与 touchEnd 可能在同一毫秒内先后到达，靠时间窗判会随机漏判）；
 *    未被行内消费的空白区点按再由列表 touchEnd 走本函数补判。
 *
 * 语义：短按（未位移、未超时）且落在左 30% ⇒ 上一屏 / 右 30% ⇒ 下一屏 /
 * 中间 40% 不翻屏。
 */

/** 单击最长时长（ms）：超过即视为长按，不算单击 */
export const TAP_MAX_DURATION_MS = 350;

export type TapRegion = 'prev' | 'next' | 'none';

export interface TapRegionInput {
  /** 触点横向占比 ∈ [0,1]（相对列表宽）；< 0 = 几何未知 ⇒ 不分区 */
  readonly fraction: number;
  /** 分区比（缺省 0.3 ⇒ 左/右各 30%，中间 40% 不动） */
  readonly edgeRatio?: number;
}

export function resolveTapRegion(input: TapRegionInput): TapRegion {
  const { fraction } = input;

  // 几何未知（未测到列表 frame）⇒ 不分区。★ 必须用 `!(x >= 0)` 而非 `x < 0`：
  // 后者对 NaN 为假 ⇒ 会把 NaN 放进比较链（结果偶然同为 'none'，但语义已错）。
  if (!(fraction >= 0)) {
    return 'none';
  }

  const edge = input.edgeRatio ?? 0.3;
  if (fraction < edge) {
    return 'prev';
  }
  if (fraction > 1 - edge) {
    return 'next';
  }
  return 'none';
}

/**
 * 单击判定：必须「未位移」且「时长在窗口内」。
 * 位移给的是 `|Δx|`、`|Δy|` 的最大值（调用方取 max 即可）。
 */
export function isTapGesture(
  moveMax: number,
  durationMs: number,
  slopPx: number,
  maxDurationMs: number = TAP_MAX_DURATION_MS,
): boolean {
  return moveMax <= slopPx && durationMs <= maxDurationMs;
}
