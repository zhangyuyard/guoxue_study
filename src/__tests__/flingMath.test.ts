/**
 * flingMath 测试：SPLINE 表性质 / fling 距离时长公式 / 定速滚动。
 * 参考值：Android 实机 Scroller.fling(0, 0, 0, v, ...) 的 duration/distance 量级。
 */
import { makeFling, makeLinearScroll, physicalCoeffOf } from '../reader/flingMath';

const PPI = 440; // density 2.75 常见机型

describe('fling SPLINE 数学', () => {
  test('总距离与总时长公式（v=3000px/s 慢滑 ≈ 半屏；v=10000 ≈ 3.5 屏）', () => {
    const f = makeFling(3000, 0, PPI);
    // friction*physicalCoeff = 0.015 * 142,708 ≈ 2140.6（AOSP L790 乘的是乘积本身）
    // l = ln(0.35*3000/2140.6) = -0.712；distance = 2140.6*exp(-1.236) ≈ 622 px
    expect(f.totalDistance).toBeGreaterThan(500);
    expect(f.totalDistance).toBeLessThan(800);
    // duration = 1000 * exp(-0.712/1.3592) ≈ 592ms 量级
    expect(f.durationMs).toBeGreaterThan(400);
    expect(f.durationMs).toBeLessThan(900);
    const fast = makeFling(10000, 0, PPI);
    expect(Math.abs(fast.totalDistance)).toBeGreaterThan(4000);
    expect(Math.abs(fast.totalDistance)).toBeLessThan(7000);
  });

  test('位移随时间单调增、收尾趋近总距离', () => {
    const f = makeFling(3000, 0, PPI);
    let prev = f.distanceAt(0);
    for (let t = 50; t <= f.durationMs; t += 50) {
      const d = f.distanceAt(t);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(f.distanceAt(f.durationMs + 5000)).toBeCloseTo(f.totalDistance, 6);
  });

  test('起始连续：distanceAt(0)=start', () => {
    const f = makeFling(-2000, 123, PPI);
    expect(f.distanceAt(0)).toBe(123);
    expect(f.totalDistance).toBeLessThan(0); // 符号随 velocity
  });

  test('速度越大滚越远', () => {
    const a = makeFling(2000, 0, PPI);
    const b = makeFling(6000, 0, PPI);
    expect(Math.abs(b.totalDistance)).toBeGreaterThan(Math.abs(a.totalDistance));
    expect(b.durationMs).toBeGreaterThan(a.durationMs);
  });

  test('physicalCoeff 与 Android 公式一致（density=2.75）', () => {
    // 9.80665 * 39.37 * 440 * 0.84 ≈ 142,614
    expect(physicalCoeffOf(440)).toBeCloseTo(142600, -3);
  });
});

describe('makeLinearScroll（点击翻页定速）', () => {
  test('duration = 300ms × |dy|/viewHeight（PageDelegate L72-82）', () => {
    const s = makeLinearScroll(-800, 0, 800);
    expect(s.durationMs).toBeCloseTo(300, 5);
    expect(s.distanceAt(150)).toBeCloseTo(-400, 5);
    expect(s.distanceAt(400)).toBeCloseTo(-800, 5);
  });

  test('滚距越大时长越长（速度恒定）', () => {
    const a = makeLinearScroll(-400, 0, 800);
    const b = makeLinearScroll(-1600, 0, 800);
    expect(b.durationMs).toBeCloseTo(a.durationMs * 4, 5);
  });

  test('零距离防御', () => {
    const s = makeLinearScroll(0, 0, 800);
    expect(s.done).toBe(true);
  });
});
