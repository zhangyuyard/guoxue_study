/**
 * #18 回归测试：App 层 `heartbeatTimer` / `jankReportTimer` 的**对称清理**。
 *
 * 背景（#15 静态勘查留下的疑点）：`src/App.tsx` 的启动 useEffect 里创建了
 *   ① `heartbeatTimer`（50ms，r37 的 `[PERF][jank] jsBlocked=` 心跳）与
 *   ② `jankReportTimer`（`ADAPTIVE_JANK_WINDOW_MS` 冷启动窗口结束时上报一次 jank 样本）。
 * RN 没有 `setTimeout().unref`，Node 那套「让计时器不阻塞退出」不适用 ⇒ 若析构器缺失，
 * App 层 effect 重跑（含热重载/开发期）会**累积恒速唤醒源**。
 *
 * 本测试的取证方式（**不是**源码文本 grep，而是行为观测）：
 *   从 `App.tsx` **原文抽取真实的启动 useEffect 回调**，用 babel 剥掉 TS 注解后在
 *   jest 假计时器上**真跑**，然后把「React 卸载 / effect 重跑」建模为**调用该回调返回的
 *   析构器**（React 语义：卸载与依赖变化前都会跑同一个析构器），最后：
 *     · 断言心跳回调的**实跑次数**在析构后不再增长（真泄漏 ⇒ 持续增长）；
 *     · 断言冷启动上报在析构后不再触发；
 *     · 断言 effect 重跑**不累积**唤醒源（同窗内实跑次数必须是单份，而非两份叠加）。
 *   因此把 `clearInterval(heartbeatTimer)` / `clearTimeout(jankReportTimer)` 从 App.tsx
 *   删掉，本文件的断言会**变红**（已做变异反证，见提交信息）。
 *
 * 声明：本文件只读 App.tsx **源码文本**用于抽取，不改任何生产代码；不新增依赖
 * （用已声明的 `@babel/core` + jest 假计时器；本仓无 react-test-renderer / RN 渲染器，
 * testEnvironment 为 node，故以「抽取真实回调 + 假计时器」达成等价的行为取证）。
 *
 * 口径红线（不得顺手改，改动即打断既有探针口径）：
 *   · 心跳周期 50ms；间隔 ≥300ms 才记一次 `jsBlocked`；日志前缀 `[PERF][jank] `；
 *   · 冷启动窗口 = `ADAPTIVE_JANK_WINDOW_MS`（30s），窗口结束时上报**一次**累计值。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transformSync } from '@babel/core';

import { ADAPTIVE_JANK_WINDOW_MS } from '@/services/DeviceTierService';

const APP_SOURCE = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

/** 抽取锚点①：启动 useEffect 的开启片段 */
const EFFECT_OPEN_ANCHOR = 'useEffect(() => {';
/** 抽取锚点②：启动 useEffect 的依赖数组（`[loadBooks]` 是 App 层唯一的启动 effect 依赖） */
const EFFECT_CLOSE_ANCHOR = ', [loadBooks]);';

/**
 * 从 App.tsx 原文抽取启动 useEffect 的**回调源码**（形如 `() => { … }`）。
 *
 * 锚点失配时**抛错**而不是静默返回空串 —— 否则本测试会在源码重构后变成永远绿的空测试。
 */
function extractStartupEffectSource(): string {
  const open = APP_SOURCE.indexOf(EFFECT_OPEN_ANCHOR);
  if (open < 0) {
    throw new Error(
      `未找到 App.tsx 的启动 useEffect（锚点「${EFFECT_OPEN_ANCHOR}」）：源码结构已变，请同步本测试的锚点。`,
    );
  }
  if (APP_SOURCE.indexOf(EFFECT_OPEN_ANCHOR, open + 1) >= 0) {
    throw new Error('App.tsx 中出现多个启动 useEffect 锚点 ⇒ 抽取不再唯一，请改用更精确的锚点。');
  }
  const close = APP_SOURCE.indexOf(EFFECT_CLOSE_ANCHOR, open);
  if (close < 0) {
    throw new Error(`未找到启动 useEffect 的依赖数组锚点「${EFFECT_CLOSE_ANCHOR}」。`);
  }
  return APP_SOURCE.slice(open + 'useEffect('.length, close);
}

/**
 * 注入到抽取回调里的自由标识符（顺序即 `new Function` 形参顺序）。
 *
 * 覆盖 App.tsx 启动 effect 体内引用的全部外部符号：服务/动作 + 计时器 + 时钟 + 日志。
 * 计时器与 `Date` 显式注入，是为了让「回调实跑次数」与「阻塞窗口判定」都可观测、可驱动。
 */
const EFFECT_DEP_NAMES = [
  'StorageService',
  'loadBooks',
  'DictEngine',
  'ADAPTIVE_JANK_WINDOW_MS',
  'scheduleStartupTasks',
  'DeviceTierService',
  'setReady',
  'console',
  'Date',
  'setInterval',
  'setTimeout',
  'clearInterval',
  'clearTimeout',
  'useSettingsStore',
  'useReadingOverrideStore',
  'useRecitationStore',
  'useAchievementStore',
] as const;

/** app 层启动 effect 的签名：执行一次返回析构器 */
type StartupEffect = () => () => void;

/** 把抽取到的回调编译成可执行函数（剥 TS 注解） */
function compileStartupEffectFactory(): (...deps: unknown[]) => StartupEffect {
  const source = extractStartupEffectSource();
  // 用「赋值表达式」而不是 `return (…)`：preset-env 会在产物前面补 `"use strict";`，
  // 若直接 `return ${code};` 会被 ASI 截断成 `return "use strict";`（拿到字符串）。
  const compiled = transformSync(`module.exports = (${source});`, {
    configFile: false,
    filename: 'App.startupEffect.tsx',
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' } }],
      '@babel/preset-typescript',
    ],
  });
  if (!compiled || typeof compiled.code !== 'string' || compiled.code.length === 0) {
    throw new Error('App.tsx 启动 useEffect 编译失败：babel 未产出代码');
  }
  // 故意使用 new Function：本测试要跑的是 App.tsx 的**原文**，不是它的复写版；
  // 代码来源是仓内文件（非外部输入），无注入面。eslint 的 no-implied-eval 为此豁免。
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const runner = new Function(
    ...EFFECT_DEP_NAMES,
    'module',
    `${compiled.code}\nreturn module.exports;`,
  ) as (...args: unknown[]) => StartupEffect;

  return (...deps: unknown[]): StartupEffect => runner(...deps, { exports: undefined });
}

interface Harness {
  /** 可控时钟（注入给回调的 `Date.now()`），与假计时器解耦 ⇒ 可精确造「阻塞窗口」 */
  clock: { value: number };
  /** 心跳回调的**实跑**次数（行为观测点：泄漏 ⇒ 析构后仍增长） */
  heartbeats: () => number;
  /** 建过的 interval 延迟（口径断言：必须是 50ms） */
  intervalDelays: number[];
  /** 建过的 timeout 延迟（口径断言：必须是冷启动窗口） */
  timeoutDelays: number[];
  /** `[PERF][jank]` 日志原文（口径断言：前缀与语义） */
  jankLogs: string[];
  reportJankSample: jest.Mock;
  cancelTasks: jest.Mock;
  setReadyCalls: boolean[];
  /** 建模 React 挂载：执行 effect */
  mount: () => void;
  /** 建模 React 卸载 / effect 重跑前的析构：调用 effect 返回的析构器 */
  unmount: () => void;
}

/** 造一台「真跑 App.tsx 启动 effect」的观测台 */
function createHarness(): Harness {
  const clock = { value: 0 };
  // 只用到 Date.now()；注入独立时钟以便与 jest 假计时器解耦驱动「阻塞窗口」
  const injectedDate = { now: (): number => clock.value } as unknown as DateConstructor;

  let beatCount = 0;
  const intervalDelays: number[] = [];
  const timeoutDelays: number[] = [];
  const jankLogs: string[] = [];

  const reportJankSample = jest.fn();
  const cancelTasks = jest.fn();
  const setReadyCalls: boolean[] = [];

  // 计时器包装：既记录创建口径，又把「回调实跑」变成可断言的行为信号
  const injectedSetInterval = (fn: () => void, ms: number): unknown => {
    intervalDelays.push(ms);
    return globalThis.setInterval(() => {
      beatCount += 1;
      fn();
    }, ms);
  };
  const injectedClearInterval = (handle: unknown): void => {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  };
  const injectedSetTimeout = (fn: () => void, ms: number): unknown => {
    timeoutDelays.push(ms);
    return globalThis.setTimeout(fn, ms);
  };
  const injectedClearTimeout = (handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
  const injectedConsole = {
    info: (msg: string): void => {
      const text = String(msg);
      if (text.includes('[PERF][jank]')) {
        jankLogs.push(text);
      }
    },
    warn: (): void => undefined,
    error: (): void => undefined,
    log: (): void => undefined,
  };

  // 只桩掉「引用了但不该在本测试里做真活」的依赖（不桩计时器/时钟 —— 那是被测对象）
  const storeStub = (): { getState: () => Record<string, unknown> } => ({
    getState: () => ({}),
  });
  const deps: unknown[] = [
    { initDatabase: (): void => undefined },
    (): void => undefined,
    { init: (): Promise<void> => Promise.resolve() },
    ADAPTIVE_JANK_WINDOW_MS,
    jest.fn((): jest.Mock => cancelTasks),
    { reportJankSample },
    (flag: boolean): void => {
      setReadyCalls.push(flag);
    },
    injectedConsole,
    injectedDate,
    injectedSetInterval,
    injectedSetTimeout,
    injectedClearInterval,
    injectedClearTimeout,
    storeStub(),
    storeStub(),
    storeStub(),
    storeStub(),
  ];
  const effect = compileStartupEffectFactory()(...deps);

  let cleanup: (() => void) | null = null;
  return {
    clock,
    heartbeats: () => beatCount,
    intervalDelays,
    timeoutDelays,
    jankLogs,
    reportJankSample,
    cancelTasks,
    setReadyCalls,
    mount: (): void => {
      if (cleanup !== null) {
        throw new Error('mount 前必须先 unmount（本观测台不允许一个会话叠两次挂载）');
      }
      cleanup = effect();
    },
    unmount: (): void => {
      if (cleanup === null) {
        throw new Error('unmount 前必须先 mount');
      }
      cleanup();
      cleanup = null;
    },
  };
}

describe('#18 App 层心跳/上报定时器的对称清理', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('抽取出的就是 App.tsx 的启动 effect（自证：确有心跳与上报两个计时器，且 r37 口径未变）', () => {
    const h = createHarness();
    h.mount();

    // 心跳周期 50ms（r37 口径）；冷启动窗口上报一次（30s）
    expect(h.intervalDelays).toEqual([50]);
    expect(h.timeoutDelays).toEqual([ADAPTIVE_JANK_WINDOW_MS]);
    // 首屏必需项已放行首帧
    expect(h.setReadyCalls).toEqual([true]);

    // 挂载期心跳确实在跑（否则后面的「析构后不再跑」会是假绿）
    expect(h.heartbeats()).toBe(0);
    jest.advanceTimersByTime(500);
    expect(h.heartbeats()).toBe(10);

    h.unmount();
  });

  test('【核心·泄漏雷达】析构后心跳回调不得再增长：卸载后 interval 必须已被 clearInterval', () => {
    const h = createHarness();
    h.mount();
    jest.advanceTimersByTime(500);
    const before = h.heartbeats();
    expect(before).toBe(10);

    h.unmount(); // ← 建模卸载 / effect 重跑前的析构

    // 析构后推进 5s（=100 个心跳周期）：实跑次数必须冻结
    jest.advanceTimersByTime(5000);
    expect(h.heartbeats()).toBe(before);
  });

  test('【核心·泄漏雷达】析构后冷启动上报不得再触发：jankReportTimer 必须已被 clearTimeout', () => {
    const h = createHarness();
    h.mount();
    h.unmount();

    jest.advanceTimersByTime(ADAPTIVE_JANK_WINDOW_MS * 3);
    expect(h.reportJankSample).not.toHaveBeenCalled();
  });

  test('对照组（防止上一例「永远不会调用」的假绿）：不析构时窗口结束必须上报一次', () => {
    const h = createHarness();
    h.mount();

    jest.advanceTimersByTime(ADAPTIVE_JANK_WINDOW_MS);
    expect(h.reportJankSample).toHaveBeenCalledTimes(1);
    // 窗口内无 jank（时钟不前进 ⇒ gap=0）⇒ 上报值必为 0（<3 次由 reportJankSample 自行忽略）
    expect(h.reportJankSample).toHaveBeenCalledWith(0);
    expect(h.jankLogs).toEqual([]);

    h.unmount();
  });

  test('【effect 重跑】新旧会话不得叠加唤醒源：同窗内实跑次数必须是单份', () => {
    const h = createHarness();
    // 第 1 个会话
    h.mount();
    jest.advanceTimersByTime(500);
    expect(h.heartbeats()).toBe(10);

    // 依赖变化 ⇒ React 先跑旧析构器，再跑新 effect（顺序即真实语义）
    h.unmount();
    h.mount();
    expect(h.intervalDelays).toEqual([50, 50]);

    jest.advanceTimersByTime(500);
    // 第 1 会话已跑 10；本窗内：旧 interval 已清 ⇒ 只有新会话跑 ⇒ 10（合计 20）。
    // 若旧 interval 未清 ⇒ 两份并跑 ⇒ 本窗 +20（合计 30） ⇒ 本断言即红。
    expect(h.heartbeats()).toBe(20);

    h.unmount();
  });

  test('析构器必须同时取消延后任务（计时器与任务取消同一析构器，缺一不可）', () => {
    const h = createHarness();
    h.mount();
    expect(h.cancelTasks).not.toHaveBeenCalled();

    h.unmount();
    expect(h.cancelTasks).toHaveBeenCalledTimes(1);
  });

  test('r37 语义不变：仅当相邻心跳间隔 ≥300ms 才记 jsBlocked，窗口内累计值随窗口结束上报', () => {
    const h = createHarness();
    h.mount(); // 时钟 0 ⇒ lastBeat=0、coldStartAt=0

    // 第 1 拍：时钟跳到 400 ⇒ gap=400 ≥300 ⇒ 记一次
    h.clock.value = 400;
    jest.advanceTimersByTime(50);
    expect(h.jankLogs).toEqual(['[PERF][jank] jsBlocked=400ms']);

    // 第 2、3 拍：时钟每次只前进 100ms ⇒ gap=100 <300 ⇒ 不得记（阈值语义）
    h.clock.value = 500;
    jest.advanceTimersByTime(50);
    h.clock.value = 600;
    jest.advanceTimersByTime(50);
    expect(h.jankLogs).toEqual(['[PERF][jank] jsBlocked=400ms']);

    // 走到窗口结束（已推进 150ms）：窗口内累计 1 次 => 上报 1（<3 由 reportJankSample 自行忽略）
    jest.advanceTimersByTime(ADAPTIVE_JANK_WINDOW_MS - 150);
    expect(h.reportJankSample).toHaveBeenCalledTimes(1);
    expect(h.reportJankSample).toHaveBeenCalledWith(1);

    h.unmount();
  });
});
