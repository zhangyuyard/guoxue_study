/**
 * 滑块（进度条）纯数学层 —— 与 RN 组件解耦，便于单测。
 *
 * ⚠ 为什么单独一个 `.ts` 文件（而不是放 `SliderField.tsx` 里）：
 * 本仓 `jest.config.js` 的 babel 内联配置只有 `@babel/preset-typescript`、**没有 preset-react**
 * ⇒ 单测 import 任何含 JSX 的 `.tsx` 都会以 `SyntaxError: Unexpected token '<'` 挂掉。
 * 仓内既有约定：`.tsx` 组件只用**源码文本断言**（`readFileSync` + 计数）覆盖，
 * 可执行逻辑一律下沉到 `.ts`。故数学部分独立成文件。
 */
import type { SliderSpec } from '@/theme/typography';

/** 滑块圆点直径（同时决定轨道可视区左右留白；组件与数学层共用同一常量口径） */
export const SLIDER_THUMB = 20;

/** 小数位数（用于吸附后消浮点噪声：0.1 步进会得到 1.7000000000000002） */
function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * 吸附到 `spec` 网格。
 * - `±Infinity` 先被 clamp 到区间端点（是「很大/很小的值」，不是无意义输入）；
 * - `NaN` 与非法 spec（step ≤ 0、max ≤ min）一律回落 `spec.min`；
 * - 结果按 `step` 的小数位取整 ⇒ **不把浮点噪声写进 store**（0.1 步进会得到 1.7000000000000002）。
 */
export function snapToGrid(value: number, spec: SliderSpec): number {
  const span = spec.max - spec.min;
  if (!(span > 0) || !(spec.step > 0) || Number.isNaN(value)) {
    return spec.min;
  }
  const clampedInput = Math.min(spec.max, Math.max(spec.min, value));
  const steps = Math.round((clampedInput - spec.min) / spec.step);
  const clamped = Math.min(spec.max, Math.max(spec.min, spec.min + steps * spec.step));
  return Number(clamped.toFixed(decimalsOf(spec.step)));
}

/** 值 → 0..1 比例（先吸附，保证「显示位置」与「实际生效值」一致） */
export function ratioOfValue(value: number, spec: SliderSpec): number {
  const span = spec.max - spec.min;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (snapToGrid(value, spec) - spec.min) / span));
}

/** 0..1 比例 → 吸附后的值（比例越界 / `±Infinity` 自动 clamp；`NaN` 回落 min） */
export function valueAtRatio(ratio: number, spec: SliderSpec): number {
  const span = spec.max - spec.min;
  if (!(span > 0) || Number.isNaN(ratio)) return spec.min;
  const r = Math.min(1, Math.max(0, ratio));
  return snapToGrid(spec.min + r * span, spec);
}

/**
 * 轨道内触点 x（相对轨道容器）→ 值：扣除滑块半径（两端圆点不被裁，故轴向留白 THUMB/2）。
 * 轨道实测宽 ≤ 0（尚未 onLayout）时返回 null ⇒ 调用方跳过本次事件。
 */
export function valueAtTouchX(locationX: number, trackWidth: number, spec: SliderSpec): number | null {
  if (!(trackWidth > 0)) return null;
  return valueAtRatio((locationX - SLIDER_THUMB / 2) / trackWidth, spec);
}
