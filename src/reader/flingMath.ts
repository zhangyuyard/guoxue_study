/**
 * Android Scroller.fling 粘性样条（spline）数学的独立移植（AOSP Apache-2.0，
 * frameworks/base OverScroller.SplineOverScroller 的公开数学模型）。
 *
 * legado 滚动模式的惯性直接调 Scroller.fling（ScrollPageDelegate L23-29）——
 * 手感 100% 对齐 = 移植同一数学。仅移植 SPLINE 相位（fling 主体）；
 * BALLISTIC/CUBIC 相位是 overscroll/bounce 行为，legado 边界 ±10 视口高几乎
 * 不触发，且本项目钳制在滚动状态机内（内容钳 vs 滚动器钳），故不移植。
 */

const SCROLL_FRICTION = 0.015;
const DECELERATION_RATE = Math.log(0.78) / Math.log(0.9); // ≈ 2.3592
const INFLEXION = 0.35;
const START_TENSION = 0.5;
const END_TENSION = 1.0;
const P1 = START_TENSION * INFLEXION;
const P2 = 1.0 - END_TENSION * (1.0 - INFLEXION);
const NB_SAMPLES = 100;
const GRAVITY_EARTH = 9.80665;

// SPLINE 采样表：贝塞尔 ease 曲线的位置/时间插值表（模块级生成一次）
const SPLINE_POSITION = new Float64Array(NB_SAMPLES + 1);
const SPLINE_TIME = new Float64Array(NB_SAMPLES + 1);
(function buildSplineTable() {
  let xMin = 0;
  let yMin = 0;
  for (let i = 0; i < NB_SAMPLES; i++) {
    const alpha = i / NB_SAMPLES;
    let xMax = 1;
    let x = 0;
    let tx = 0;
    let coef = 0;
    for (;;) {
      x = xMin + (xMax - xMin) / 2;
      coef = 3 * x * (1 - x);
      tx = coef * ((1 - x) * P1 + x * P2) + x * x * x;
      if (Math.abs(tx - alpha) < 1e-5) break;
      if (tx > alpha) xMax = x;
      else xMin = x;
    }
    SPLINE_POSITION[i] = coef * ((1 - x) * START_TENSION + x) + x * x * x;

    let yMax = 1;
    let y = 0;
    let dy = 0;
    for (;;) {
      y = yMin + (yMax - yMin) / 2;
      coef = 3 * y * (1 - y);
      dy = coef * ((1 - y) * START_TENSION + y) + y * y * y;
      if (Math.abs(dy - alpha) < 1e-5) break;
      if (dy > alpha) yMax = y;
      else yMin = y;
    }
    SPLINE_TIME[i] = coef * ((1 - y) * P1 + y * P2) + y * y * y;
  }
  SPLINE_POSITION[NB_SAMPLES] = 1;
  SPLINE_TIME[NB_SAMPLES] = 1;
})();

/** ppi = density × 160（displayMetrics.density 同源；RN PixelRatio.get() 即 density） */
export function physicalCoeffOf(ppi: number): number {
  return GRAVITY_EARTH * 39.37 * ppi * 0.84;
}

export interface FlingCurve {
  /** elapsed 毫秒时刻的累计位移（px） */
  distanceAt(elapsedMs: number): number;
  /** 总时长（毫秒） */
  durationMs: number;
  /** 总位移（px） */
  totalDistance: number;
}

/**
 * 构造 fling 位移曲线。start 为起始累计位移（输出绝对位移供差值），
 * velocity 单位 px/s（legado VelocityTracker.computeCurrentVelocity(1000) 同单位）。
 * 位移符号随 velocity 自带；调用方每帧取 distanceAt 差值喂滚动状态机。
 */
export function makeFling(
  velocity: number,
  start: number,
  ppi: number,
  friction: number = SCROLL_FRICTION,
): FlingCurve {
  const physicalCoeff = physicalCoeffOf(ppi);
  const v = Math.abs(velocity);
  const l = Math.log((INFLEXION * v) / (friction * physicalCoeff));
  const decelMinusOne = DECELERATION_RATE - 1;
  const totalDistance =
    friction * physicalCoeff * Math.exp((DECELERATION_RATE / decelMinusOne) * l);
  const durationMs = 1000 * Math.exp(l / decelMinusOne);
  const sign = Math.sign(velocity);
  return {
    durationMs,
    totalDistance: totalDistance * sign,
    distanceAt(elapsedMs: number) {
      if (elapsedMs <= 0) return start;
      if (elapsedMs >= durationMs) return start + totalDistance * sign;
      const t = elapsedMs / durationMs;
      const index = Math.floor(NB_SAMPLES * t);
      let distanceCoef = 1;
      if (index < NB_SAMPLES) {
        const tInf = index / NB_SAMPLES;
        const tSup = (index + 1) / NB_SAMPLES;
        const dInf = SPLINE_POSITION[index];
        const dSup = SPLINE_POSITION[index + 1];
        const velocityCoef = (dSup - dInf) / (tSup - tInf);
        distanceCoef = dInf + (t - tInf) * velocityCoef;
      }
      return start + distanceCoef * totalDistance * sign;
    },
  };
}

/**
 * 定速滚动曲线（点击翻页：startScroll 的 LinearInterpolator 对应，PageDelegate L72-82）。
 * duration = animationSpeed(300ms) × |dy| / viewHeight ⇒ 速度恒定 viewHeight/300ms。
 */
export function makeLinearScroll(
  distance: number,
  start: number,
  viewHeight: number,
  animationSpeedMs = 300,
): FlingCurve & { done: boolean } {
  const durationMs = (animationSpeedMs * Math.abs(distance)) / Math.max(1, viewHeight);
  return {
    durationMs,
    totalDistance: distance,
    distanceAt(elapsedMs: number) {
      const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
      return start + distance * t;
    },
    done: durationMs <= 0,
  };
}
