/**
 * tapRegions.ts 单测（滚动模式单击翻屏横向分区 / 点-拖判定）。
 *
 * 回归背景（2026-10-08 真机实证）：
 * ① 旧实现用左右 30% 的 `Pressable` 覆盖层压在 FlatList 之上（兄弟关系）⇒
 *    Android 不再把触摸交给下层 ScrollView ⇒ 真机差分证实「x=100 上滑滚不动、
 *    x=540 上滑正常」⇒ 覆盖层必须删除，分区判定改挂列表自身 touch 事件。
 * ② 纵向几何命中不可靠（pageY 相对 React 根视图 / measureInWindow 相对应用窗口，
 *    本机实测差一个 117px 状态栏）⇒ 判定只用**横向占比**。
 * ③ 点字 vs 翻屏的冲突改由 press 时刻「回问宿主」解决（见 ScrollMode 的
 *    charTapIntercept）⇒ 本函数**不再**持有「行内点按时刻」抑制窗——原 clock
 *    方案依赖 press/touchEnd 的到达顺序，同一毫秒内到达时会随机漏判。
 *
 * 本文件只依赖纯 `.ts` 模块（jest 未配 react-native preset ⇒ import `.tsx` 会灭进程）。
 *
 * 变异判据（三处均实测，红数 = 失败用例数，非断言数）：
 * - M2 掐掉几何兜底 `if (false && !(fraction >= 0))` ⇒ **1 红**（fraction = -1 → 'prev'）。
 *   ★ NaN 例在变异下**仍绿**（NaN 走边缘比较自然落回 'none'）⇒ 该例只文档化行为，
 *     兜底的唯一判别点是**负** fraction。
 * - M3 边界比较改 `<=` / `>=` ⇒ **1 红**（恰 0.3 / 恰 0.7 两断言同例）。
 * - M4 `return moveMax <= slopPx;`（掐掉时长判据）⇒ **2 红**。
 */
import {
  TAP_MAX_DURATION_MS,
  isTapGesture,
  resolveTapRegion,
} from '@/reader/core/modes/tapRegions';

describe('tapRegions 常量契约', () => {
  it('单击时长上限 350ms（语义判据，改动须同步本用例；> 350ms 视为长按）', () => {
    expect(TAP_MAX_DURATION_MS).toBe(350);
  });
});

describe('resolveTapRegion 横向分区', () => {
  it('左 30% → prev', () => {
    expect(resolveTapRegion({ fraction: 0.1 })).toBe('prev');
    expect(resolveTapRegion({ fraction: 0.29 })).toBe('prev');
  });

  it('中间 40% → none（不翻屏）', () => {
    expect(resolveTapRegion({ fraction: 0.35 })).toBe('none');
    expect(resolveTapRegion({ fraction: 0.5 })).toBe('none');
  });

  it('右 30% → next', () => {
    expect(resolveTapRegion({ fraction: 0.71 })).toBe('next');
    expect(resolveTapRegion({ fraction: 0.95 })).toBe('next');
  });

  it('分区边界：恰 0.3 / 恰 0.7 都归「中间」（区间为左开右闭的补集）', () => {
    expect(resolveTapRegion({ fraction: 0.3 })).toBe('none');
    expect(resolveTapRegion({ fraction: 0.7 })).toBe('none');
  });

  it('edgeRatio 可调：0.5 ⇒ 0.45 prev / 0.55 next', () => {
    expect(resolveTapRegion({ fraction: 0.45, edgeRatio: 0.5 })).toBe('prev');
    expect(resolveTapRegion({ fraction: 0.55, edgeRatio: 0.5 })).toBe('next');
  });
});

describe('resolveTapRegion 几何未知兜底', () => {
  it('fraction = -1（未测到列表 frame）⇒ none，不猜分区', () => {
    expect(resolveTapRegion({ fraction: -1 })).toBe('none');
  });

  it('fraction = NaN ⇒ none（NaN 比较全假，不能被当成 prev）', () => {
    expect(resolveTapRegion({ fraction: Number.NaN })).toBe('none');
  });
});

describe('isTapGesture 点/拖判定', () => {
  it('小位移 + 短时长 ⇒ 是单击', () => {
    expect(isTapGesture(0, 0, 12)).toBe(true);
    expect(isTapGesture(12, 350, 12)).toBe(true);
  });

  it('位移超阈 ⇒ 不是单击（拖动/滑动交给原生滚动）', () => {
    expect(isTapGesture(12.5, 100, 12)).toBe(false);
  });

  it('时长超上限 ⇒ 不是单击（长按不算点）', () => {
    expect(isTapGesture(0, 351, 12)).toBe(false);
  });

  it('默认时长上限取自 TAP_MAX_DURATION_MS', () => {
    expect(isTapGesture(0, TAP_MAX_DURATION_MS, 12)).toBe(true);
    expect(isTapGesture(0, TAP_MAX_DURATION_MS + 1, 12)).toBe(false);
  });
});
