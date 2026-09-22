/**
 * r38 T02 统一装配调度器测试（文档 §10 T02 测试条 ①~⑦）
 *
 * 覆盖不变量：
 *  ① 出队序严格 P1 < P2 < P3 < P4 < P5，同优先级 FIFO；
 *  ② 世代作废（bumpGeneration 丢队列内旧世代、in-flight 保留跑完）；
 *  ③ 同章 in-flight 去重（IO ≤1）+ 队列内同章合并取最高优先级；
 *  ④ 饥饿保护（10s 提权 / 20s 显式放弃并落 abandon 日志，不静默丢失）；
 *  ⑤ 单 worker 串行（执行器并发恒 ≤1）；
 *  ⑥ INV-5 FTS 让路（P1~P3 排队或执行中 → ftsQueuePausedUntil ≥ now + ftsYieldMs）；
 *  ⑦ 流式装配状态机结构（carry 跨批防护 / 「非空行=段落」/ 行级时间片）。
 *
 * 测试策略：调度器不依赖任何 IO（宿主适配器模式），故本文件全部使用
 * **假宿主**（可编程就绪级别 + 可阻塞执行器 + 并发观测），无需 RN 渲染环境；
 * ⑦/⑧ 为源码结构断言（r38 一贯的回归守卫风格）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  AsmPriority,
  ChapterAssemblyScheduler,
  ChapterReadiness,
  R38_SCHEDULER_ENABLED,
  STARVE_WATCHDOG_TICK_MS,
  chapterAssemblyScheduler,
  createChapterAssemblyScheduler,
  registerAssemblyHost,
  type AsmHost,
} from '@/services/ChapterAssemblyScheduler';
import { __setTierForTests, getParams } from '@/services/DeviceTierService';

const BOOK = 'builtin-r38-test';

// ============================ 假宿主（可编程） ============================

interface FakeCall {
  key: string;
  chapterId: string;
  priority: AsmPriority;
  reason: string;
  generation: number;
}

interface FakeHostState {
  readiness: Map<string, ChapterReadiness>;
  orders: Map<string, number>;
  calls: FakeCall[];
  concurrent: number;
  maxConcurrent: number;
  ftsPauses: number[];
  /** 阻塞闸门：非空时每次装配都等待该 promise（用于精确控制 worker 占用） */
  gate: (() => Promise<void>) | null;
  /** 执行器内部延迟（真实计时，用于并发交叠观测） */
  delayMs: number;
}

function keyOf(bookId: string, chapterId: string): string {
  return `${bookId}:${chapterId}`;
}

/** 可释放闸门：release() 后所有等待者（含后续 await）立即通过 */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    release = res;
  });
  return { promise, release: () => release() };
}

function createFakeHost(): { host: AsmHost; state: FakeHostState } {
  const state: FakeHostState = {
    readiness: new Map<string, ChapterReadiness>(),
    orders: new Map<string, number>(),
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    ftsPauses: [],
    gate: null,
    delayMs: 0,
  };
  const host: AsmHost = {
    readinessOf: (bookId, chapterId) =>
      state.readiness.get(keyOf(bookId, chapterId)) ?? ChapterReadiness.Empty,
    orderOf: (bookId, chapterId) =>
      state.orders.get(keyOf(bookId, chapterId)) ?? 0,
    async assemble(bookId, chapterId, ctx) {
      const key = keyOf(bookId, chapterId);
      state.calls.push({
        key,
        chapterId,
        priority: ctx.priority,
        reason: ctx.reason,
        generation: ctx.generation,
      });
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      try {
        if (state.gate) {
          await state.gate();
        } else if (state.delayMs > 0) {
          await new Promise<void>((res) => setTimeout(res, state.delayMs));
        }
      } finally {
        state.concurrent -= 1;
      }
      state.readiness.set(key, ChapterReadiness.Full);
      return true;
    },
    pauseFts(untilMs) {
      state.ftsPauses.push(untilMs);
    },
  };
  return { host, state };
}

/** 轮询等待（真实计时器）：仅用于等待异步链自然收敛 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise<void>((res) => setTimeout(res, 5));
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>((res) => setImmediate(res));
}

const USER_BOOK_SERVICE_PATH = resolve(__dirname, '../services/UserBookService.ts');

beforeEach(() => {
  __setTierForTests(null); // 档位回落 mid（starvationMs=10000 / ftsYieldMs=30000，三档一致）
});

afterEach(() => {
  chapterAssemblyScheduler.__resetForTests();
});

// ============================ ① 优先级与 FIFO ============================

describe('① 出队序：P1 < P2 < P3 < P4 < P5，同优先级 FIFO', () => {
  test('逆序入队仍按优先级出队；P2 两个请求按入队序执行', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    // 先用一个 P5 占住 worker（进入执行不可取消 = 章边界语义）
    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    expect(state.calls.map((c) => c.chapterId)).toEqual(['seed']);

    // 逆优先级入队：P4 → P5 → P3 → P2a → P2b → P1
    s.request(BOOK, 'p4', AsmPriority.ViewportShell, 'shell');
    s.request(BOOK, 'p5', AsmPriority.IdleDiffuse, 'idle');
    s.request(BOOK, 'p3', AsmPriority.NextNeighbor, 'next');
    s.request(BOOK, 'p2a', AsmPriority.PrevNeighbor, 'prev');
    s.request(BOOK, 'p2b', AsmPriority.PrevNeighbor, 'prev');
    s.request(BOOK, 'p1', AsmPriority.Target, 'target');
    expect(s.getStats().queued).toBe(6);

    gate.release();
    await waitFor(() => state.calls.length === 7);
    expect(state.calls.map((c) => c.chapterId)).toEqual([
      'seed',
      'p1',
      'p2a',
      'p2b',
      'p3',
      'p4',
      'p5',
    ]);
    expect(s.getStats().queued).toBe(0);
    expect(s.getStats().inflight).toBeNull();
    expect(s.getStats().doneCount).toBe(7);
  });

  test('优先级枚举数值与 PRD P0-2 一一对应（P1 最小 = 最高）', () => {
    expect(AsmPriority.Target).toBe(1);
    expect(AsmPriority.PrevNeighbor).toBe(2);
    expect(AsmPriority.NextNeighbor).toBe(3);
    expect(AsmPriority.ViewportShell).toBe(4);
    expect(AsmPriority.IdleDiffuse).toBe(5);
  });

  test('已就绪章（Full）请求零成本短路：不入队、不执行', async () => {
    const { host, state } = createFakeHost();
    state.readiness.set(keyOf(BOOK, 'ready'), ChapterReadiness.Full);
    const s = createChapterAssemblyScheduler(() => host);
    s.request(BOOK, 'ready', AsmPriority.Target, 'target');
    await flushMicrotasks();
    expect(state.calls).toEqual([]);
    expect(s.getStats().queued).toBe(0);
  });

  test('空 bookId / chapterId 被忽略（防脏参数污染队列）', async () => {
    const { host, state } = createFakeHost();
    const s = createChapterAssemblyScheduler(() => host);
    s.request('', 'c', AsmPriority.Target, 'target');
    s.request(BOOK, '', AsmPriority.Target, 'target');
    await flushMicrotasks();
    expect(state.calls).toEqual([]);
    expect(s.getStats().queued).toBe(0);
  });
});

// ============================ ② 世代作废 ============================

describe('② 世代作废（INV-3，取消粒度 = 章边界）', () => {
  test('bumpGeneration() 丢队列内旧世代请求，in-flight 保留并跑完', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    expect(s.getGeneration()).toBe(1);
    s.request(BOOK, 'inflight', AsmPriority.Target, 'target');
    expect(state.calls.map((c) => c.chapterId)).toEqual(['inflight']);

    // worker 被占住期间入队两个旧世代请求
    s.request(BOOK, 'old1', AsmPriority.PrevNeighbor, 'prev');
    s.request(BOOK, 'old2', AsmPriority.NextNeighbor, 'next');
    expect(s.getStats().queued).toBe(2);

    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const gen = s.bumpGeneration();
    expect(gen).toBe(2);
    const stats = s.getStats();
    expect(stats.staleDrops).toBe(2);
    expect(stats.queued).toBe(0);
    // ★ in-flight 不被作废：进入执行即「全有或全无」，允许跑完
    expect(stats.inflight).toBe(keyOf(BOOK, 'inflight'));
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes('[PERF][asm] stale-drop'),
      ),
    ).toBe(true);
    infoSpy.mockRestore();

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
    await flushMicrotasks();
    // 旧世代的两个请求自始至终未被执行
    expect(state.calls.map((c) => c.chapterId)).toEqual(['inflight']);
  });

  test('新世代请求正常执行（作废只针对旧世代）', async () => {
    const { host, state } = createFakeHost();
    const s = createChapterAssemblyScheduler(() => host);
    s.bumpGeneration();
    s.request(BOOK, 'fresh', AsmPriority.Target, 'target');
    await waitFor(() => state.calls.length === 1);
    expect(state.calls[0].generation).toBe(2);
  });
});

// ============================ ③ 同章去重 ============================

describe('③ 同章去重（INV-2：同章 IO ≤ 1）', () => {
  test('in-flight 同章重复 request 只执行一次执行器', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'a', AsmPriority.Target, 'target');
    const before = state.calls.length;
    for (let i = 0; i < 5; i += 1) {
      s.request(BOOK, 'a', AsmPriority.Target, 'target');
    }
    expect(s.getStats().dedupHits).toBe(5);
    expect(state.calls.length).toBe(before); // 去重期间零额外执行

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
    await flushMicrotasks();
    expect(state.calls.filter((c) => c.chapterId === 'a').length).toBe(1);
  });

  test('队列内同章合并到最高优先级（reason 跟随胜出者）并保持更早的饥饿基准', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'busy', AsmPriority.Target, 'target');
    // b 先以 P5 入队（低优先），c 以 P3 入队
    s.request(BOOK, 'b', AsmPriority.IdleDiffuse, 'idle');
    s.request(BOOK, 'c', AsmPriority.NextNeighbor, 'next');
    expect(s.getStats().queued).toBe(2);
    // b 被提权到 P1（目标章）：合并而非新增队列项
    s.request(BOOK, 'b', AsmPriority.Target, 'target');
    expect(s.getStats().queued).toBe(2);
    expect(s.getStats().dedupHits).toBe(1);

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
    await flushMicrotasks();
    // b 已升为 P1 → 先于 P3 的 c 执行
    expect(state.calls.map((c) => c.chapterId)).toEqual(['busy', 'b', 'c']);
    const bCall = state.calls.find((c) => c.chapterId === 'b');
    expect(bCall?.priority).toBe(AsmPriority.Target);
    expect(bCall?.reason).toBe('target');
  });

  test('requestMany 入参去重且保持给定顺序（同级 FIFO 稳定序）', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'busy', AsmPriority.Target, 'target');
    s.requestMany(
      BOOK,
      ['n1', 'n1', 'n2', '', 'n3'],
      AsmPriority.PrevNeighbor,
      'prev',
    );
    expect(s.getStats().queued).toBe(3);
    gate.release();
    await waitFor(() => s.getStats().inflight === null);
    await flushMicrotasks();
    expect(state.calls.map((c) => c.chapterId)).toEqual(['busy', 'n1', 'n2', 'n3']);
  });
});

// ============================ ④ 饥饿保护 ============================

describe('④ 饥饿保护（INV-4：提权或显式放弃，绝不静默丢失）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('watchdog 间隔 500ms；9.9s 不动、10.1s 提权到 P1（reason 保持原意）', async () => {
    expect(STARVE_WATCHDOG_TICK_MS).toBe(500);
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise; // 占住 worker
    const s = createChapterAssemblyScheduler(() => host);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    s.request(BOOK, 'busy', AsmPriority.Target, 'target');
    s.request(BOOK, 'starve', AsmPriority.IdleDiffuse, 'idle');

    await jest.advanceTimersByTimeAsync(9900);
    let stats = s.getStats();
    expect(stats.starvePromotes).toBe(0);
    expect(stats.starveAbandons).toBe(0);
    expect(stats.queued).toBe(1);

    await jest.advanceTimersByTimeAsync(200); // 累计 10.1s ≥ starvationMs(10s)
    stats = s.getStats();
    expect(stats.starvePromotes).toBe(1);
    expect(stats.starveAbandons).toBe(0);
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes('[PERF][asm] starve-promote'),
      ),
    ).toBe(true);

    infoSpy.mockRestore();
    gate.release();
    await jest.advanceTimersByTimeAsync(600);
    await jest.advanceTimersByTimeAsync(0);
    // 提权后以 P1 执行
    expect(state.calls.map((c) => c.chapterId)).toEqual(['busy', 'starve']);
    expect(state.calls[1].priority).toBe(AsmPriority.Target);
    expect(state.calls[1].reason).toBe('idle');
    s.__resetForTests();
  });

  test('9.9s 不放弃、20.1s 显式放弃并落 abandon 日志（不静默丢失）', async () => {
    const { host, state } = createFakeHost();
    // 永久占住 worker（永不释放）：验证「放弃」而非「被执行」
    state.gate = () => new Promise<void>(() => undefined);
    const s = createChapterAssemblyScheduler(() => host);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    s.request(BOOK, 'busy', AsmPriority.Target, 'target');
    s.request(BOOK, 'starve', AsmPriority.IdleDiffuse, 'idle');

    await jest.advanceTimersByTimeAsync(9900);
    expect(s.getStats().starveAbandons).toBe(0);

    await jest.advanceTimersByTimeAsync(10200); // 累计 20.1s ≥ 2 × starvationMs
    const stats = s.getStats();
    expect(stats.starveAbandons).toBe(1);
    expect(stats.queued).toBe(0);

    const abandonLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[PERF][asm] abandon'));
    expect(abandonLogs.length).toBe(1);
    expect(abandonLogs[0]).toContain('ch=starve');

    infoSpy.mockRestore();
    s.__resetForTests();
  });

  test('饥饿时钟基准取更早者：重复 request 不重置计时（防「接力去重」拖延）', async () => {
    const { host, state } = createFakeHost();
    state.gate = () => new Promise<void>(() => undefined);
    const s = createChapterAssemblyScheduler(() => host);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    s.request(BOOK, 'busy', AsmPriority.Target, 'target');
    s.request(BOOK, 'starve', AsmPriority.IdleDiffuse, 'idle');

    // 每 5s 重复提交一次同章请求（若按新请求重置计时，则永不提权）
    for (let i = 0; i < 2; i += 1) {
      await jest.advanceTimersByTimeAsync(5000);
      s.request(BOOK, 'starve', AsmPriority.IdleDiffuse, 'idle');
    }
    // 累计 10s：仍按最初 requestedAt 判定 → 已提权
    await jest.advanceTimersByTimeAsync(200);
    expect(s.getStats().starvePromotes).toBeGreaterThanOrEqual(1);
    expect(s.getStats().dedupHits).toBeGreaterThanOrEqual(2);

    infoSpy.mockRestore();
    s.__resetForTests();
  });
});

// ============================ ⑤ 单 worker 串行 ============================

describe('⑤ 单 worker 串行（INV-1：执行器并发恒 ≤ 1）', () => {
  test('6 章混合优先级并发提交：无任何时刻两个装配同时执行', async () => {
    const { host, state } = createFakeHost();
    state.delayMs = 5; // 制造真实交叠窗口
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'c1', AsmPriority.IdleDiffuse, 'idle');
    s.requestMany(BOOK, ['c2', 'c3'], AsmPriority.PrevNeighbor, 'prev');
    s.request(BOOK, 'c4', AsmPriority.Target, 'target');
    s.requestMany(BOOK, ['c5', 'c6'], AsmPriority.ViewportShell, 'shell');

    // 等待「全部执行完」（calls.length 只在装配开始时递增，须以 doneCount 为完成判据）
    await waitFor(() => s.getStats().doneCount === 6);
    expect(state.calls.length).toBe(6);
    expect(state.maxConcurrent).toBe(1);
    expect(s.getStats().queued).toBe(0);
    expect(s.getStats().inflight).toBeNull();
  });

  test('执行期间 inflight 唯一（进行中再提交不改写 inflight）', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'a', AsmPriority.Target, 'target');
    expect(s.getStats().inflight).toBe(keyOf(BOOK, 'a'));
    s.request(BOOK, 'b', AsmPriority.Target, 'target');
    expect(s.getStats().inflight).toBe(keyOf(BOOK, 'a'));
    expect(s.getStats().queued).toBe(1);

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
    expect(state.maxConcurrent).toBe(1);
  });
});

// ============================ ⑥ INV-5 FTS 让路 ============================

describe('⑥ INV-5：FTS 让路时间戳（装配优先于词典后台索引）', () => {
  test('空闲态不抬升（pausedUntil = 0，isUserActive = false）', () => {
    const { host } = createFakeHost();
    const s = createChapterAssemblyScheduler(() => host);
    expect(s.getFtsPausedUntil()).toBe(0);
    expect(s.isUserActive()).toBe(false);
  });

  test('P1 执行中 → ftsQueuePausedUntil ≥ now + ftsYieldMs 且已通知宿主', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);
    const ftsYieldMs = getParams().ftsYieldMs;

    const t0 = Date.now();
    s.request(BOOK, 'a', AsmPriority.Target, 'target');
    const pausedUntil = s.getFtsPausedUntil();
    expect(pausedUntil).toBeGreaterThanOrEqual(t0 + ftsYieldMs);
    expect(pausedUntil).toBeLessThanOrEqual(Date.now() + ftsYieldMs);
    expect(s.isUserActive()).toBe(true);
    expect(state.ftsPauses.length).toBeGreaterThan(0);
    expect(state.ftsPauses[state.ftsPauses.length - 1]).toBe(pausedUntil);

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
  });

  test('worker 被 P5 占住、队列内有 P2 排队 → 同样抬升让路窗口', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);
    const ftsYieldMs = getParams().ftsYieldMs;

    s.request(BOOK, 'idle-job', AsmPriority.IdleDiffuse, 'idle');
    await flushMicrotasks();
    expect(s.isUserActive()).toBe(true); // in-flight 本身即活动

    const t1 = Date.now();
    s.request(BOOK, 'neighbor', AsmPriority.PrevNeighbor, 'prev');
    expect(s.getFtsPausedUntil()).toBeGreaterThanOrEqual(t1 + ftsYieldMs);
    expect(s.getStats().queued).toBe(1);

    gate.release();
    await waitFor(() => s.getStats().inflight === null);
  });

  test('执行完成且队列清空后 isUserActive 转 false（让路窗口自然到期）', async () => {
    const { host } = createFakeHost();
    const s = createChapterAssemblyScheduler(() => host);
    s.request(BOOK, 'a', AsmPriority.Target, 'target');
    await waitFor(() => s.getStats().inflight === null);
    expect(s.isUserActive()).toBe(false);
  });
});

// ============================ 附：awaitReadiness / 宿主注册 ============================

describe('附：awaitReadiness 与宿主注册（宿主适配器模式）', () => {
  test('已达标的章立即返回（零等待）', async () => {
    const { host, state } = createFakeHost();
    state.readiness.set(keyOf(BOOK, 'ready'), ChapterReadiness.Full);
    const s = createChapterAssemblyScheduler(() => host);
    const t0 = Date.now();
    const level = await s.awaitReadiness(
      BOOK,
      'ready',
      ChapterReadiness.Partial,
      1000,
    );
    expect(level).toBe(ChapterReadiness.Full);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('超时返回实际级别（不悬挂、不阻塞 UI）', async () => {
    const { host } = createFakeHost();
    const s = createChapterAssemblyScheduler(() => host);
    const level = await s.awaitReadiness(
      BOOK,
      'never',
      ChapterReadiness.Partial,
      20,
    );
    expect(level).toBe(ChapterReadiness.Empty);
  });

  test('装配完成后唤醒等待者', async () => {
    const { host, state } = createFakeHost();
    state.delayMs = 5;
    const s = createChapterAssemblyScheduler(() => host);
    s.request(BOOK, 'a', AsmPriority.Target, 'target');
    const level = await s.awaitReadiness(
      BOOK,
      'a',
      ChapterReadiness.Full,
      1000,
    );
    expect(level).toBe(ChapterReadiness.Full);
  });

  test('宿主未注册时队列不丢弃；registerAssemblyHost 后立即消费', async () => {
    const { host, state } = createFakeHost();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 单例初始无宿主：请求滞留在队列
    chapterAssemblyScheduler.request(BOOK, 'c1', AsmPriority.Target, 'target');
    expect(chapterAssemblyScheduler.getStats().queued).toBe(1);
    expect(state.calls).toEqual([]);

    registerAssemblyHost(host);
    await waitFor(() => state.calls.length === 1);
    expect(state.calls[0].chapterId).toBe('c1');
    expect(chapterAssemblyScheduler.getStats().queued).toBe(0);
    warnSpy.mockRestore();
    chapterAssemblyScheduler.__resetForTests();
  });

  test('聚合导出与默认导出指向同一单例（调用方唯一入口）', () => {
    expect(ChapterAssemblyScheduler).toBe(chapterAssemblyScheduler);
    expect(typeof ChapterAssemblyScheduler.request).toBe('function');
    expect(typeof ChapterAssemblyScheduler.bumpGeneration).toBe('function');
    expect(typeof ChapterAssemblyScheduler.awaitReadiness).toBe('function');
    expect(typeof ChapterAssemblyScheduler.isUserActive).toBe('function');
    expect(typeof chapterAssemblyScheduler.__resetForTests).toBe('function');
  });

  test('readinessOf 透传宿主就绪级别（拼接门唯一判据）', () => {
    const { host, state } = createFakeHost();
    state.readiness.set(keyOf(BOOK, 'x'), ChapterReadiness.Partial);
    const s = createChapterAssemblyScheduler(() => host);
    expect(s.readinessOf(BOOK, 'x')).toBe(ChapterReadiness.Partial);
    expect(s.readinessOf(BOOK, 'none')).toBe(ChapterReadiness.Empty);
    // 枚举值与「插序列门」语义锁定
    expect(ChapterReadiness.Empty).toBe(0);
    expect(ChapterReadiness.Partial).toBe(1);
    expect(ChapterReadiness.Full).toBe(2);
  });
});

// ============================ ⑦ 流式装配状态机（源码结构断言） ============================

describe('⑦ 流式装配状态机（carry 跨批 + 非空行=段落 + 行级时间片）', () => {
  const src = readFileSync(USER_BOOK_SERVICE_PATH, 'utf8');

  test('assembleChapterStreaming 已提炼为独立可测原语（返回 done/progress/failed）', () => {
    expect(src).toMatch(/export async function assembleChapterStreaming\(/);
    expect(src).toMatch(
      /export type ChapterAssembleStep = 'done' \| 'progress' \| 'failed';/,
    );
    expect(src).toMatch(/return 'failed'; \/\/ 慢路径壳（整读扫描产物）不走流式/);
  });

  test('分批读档位化，且 FILL_* 常量保留为默认值快照（灰度可回退）', () => {
    expect(src).toMatch(/FILL_READ_CHUNK_BYTES = 64 \* 1024/);
    expect(src).toMatch(
      /const want = Math\.min\(readChunkBytes, totalBytes - cur\.bytePos\);/,
    );
    expect(src).toMatch(
      /pickTierNumber\(opts\.readChunkBytes, tier\.readChunkBytes\)/,
    );
    expect(src).toMatch(
      /pickTierNumber\(opts\.timeBudgetMs, tier\.timeBudgetMs\)/,
    );
  });

  test('carry 跨批未完结行防护：整批无换行则整批留 carry（半行绝不当段落产出）', () => {
    expect(src).toMatch(/let chunk = cur\.carry \+ slice;/);
    expect(src).toMatch(/cur\.carry = '';/);
    expect(src).toMatch(/const lastNl = chunk\.lastIndexOf\('\\n'\);/);
    expect(src).toMatch(/cur\.carry = chunk\.slice\(lastNl \+ 1\);/);
    expect(src).toMatch(/chunk = chunk\.slice\(0, lastNl \+ 1\);/);
    expect(src).toMatch(/cur\.carry = chunk;\s*\n\s*chunk = '';/);
  });

  test('「非空行 = 段落」（与 toParagraphs 对资产格式等价）+ 超长段落再切分', () => {
    expect(src).toMatch(/const t = lines\[cur\.lineIdx\]\.trim\(\);/);
    expect(src).toMatch(/if \(!t\) \{\s*\n\s*continue; \/\/ 空行 = 段落分隔/);
    expect(src).toMatch(/splitLongParagraph\(t, MAX_SEGMENT_CHARS\)/);
    expect(src).toMatch(/segs\.push\(\{/);
    // 段落增量 push：首段产出即可上屏（目标章 Partial）
    expect(src).toMatch(/cur\.segCount \+= 1;/);
  });

  test('行级时间片：超预算余行留 pendingLines 下批续作（单块 ≤ 一行切分）', () => {
    expect(src).toMatch(/if \(Date\.now\(\) - batchT0 >= timeBudgetMs\) \{/);
    expect(src).toMatch(/cur\.pendingLines = lines;/);
    expect(src).toMatch(/if \(cur\.pendingLines\) \{\s*\n\s*lines = cur\.pendingLines;/);
    expect(src).toMatch(/exhausted = false;/);
    expect(src).toMatch(/return 'progress';/);
  });

  test('调度器执行器：只经 assembleChapterStreaming 推进，不中途取消', () => {
    expect(src).toMatch(/export async function assembleChapterToFull\(/);
    expect(src).toMatch(/const step = await assembleChapterStreaming\(shell, \{/);
    // D1：failed 不得当 full（否则截断章被标 READY_FULL 且永不重试）
    // 【#20】full 的「游标已定」判据抽为 cursorSettled。
    // 【#20 复验追加·关键】"无游标" **不再**无条件视作已定：必须持有「整章一次性
    // 装配」证明（`chapterWholeReadComplete`）。旧写法 `? true :` 过宽 —— 真机
    // 复验抓到 `ready-full paras=148/105`（oracle 156/106）：游标被并发接管后
    // 脱钩，旧写法把「未证实完整」当「已完整」。failed 仍严格排除在 full 之外。
    expect(src).toMatch(
      /const cursorSettled =\s*\n\s*shell\.fillCursor === undefined\s*\n\s*\? chapterWholeReadComplete\.has\(key\)\s*\n\s*: shell\.fillCursor\.done === true;/,
    );
    expect(src).toMatch(/const full = !failed && cursorSettled;/);
    // 无证明 ⇒ 不判完成（停 Partial），且**先补全**再判（executor 入口）
    expect(src).toMatch(/const repaired = await repairChapterByWholeRead\(bookId, chapterId\);/);
    expect(src).toMatch(/if \(chapterWholeReadComplete\.has\(key\)\) \{/);
    // 空壳永不进入拼接门（红线④）
    expect(src).toMatch(/return false; \/\/ 空壳不进入拼接门（红线④）/);
    expect(src).toMatch(/const MAX_ASSEMBLE_STEPS = 100_000;/);
  });

  test('G1：FTS 章级写入严格被 READY_FULL 门控（调度器路径 Partial 不写）', () => {
    // 把 `if (full)` 改成 `if (true)` 必须被抓住：写入点必须由 full 包裹，
    // 且 full 已排除 failed（D1）——两道合起来保证「搜到的章必定装配完整」
    const asmBody = src.slice(
      src.indexOf('export async function assembleChapterToFull('),
    );
    const writePos = asmBody.indexOf('writeFtsForReadyChapter(spec, shell);');
    const guardPos = asmBody.indexOf('if (full) {');
    const fullPos = asmBody.indexOf('const full = !failed && cursorSettled;');
    expect(fullPos).toBeGreaterThan(-1);
    expect(guardPos).toBeGreaterThan(fullPos); // 守卫在 full 判定之后
    expect(writePos).toBeGreaterThan(guardPos); // 写入在守卫之内
    // 写入语句必须紧贴守卫（无中间分支/无其他条件绕过）
    expect(asmBody.slice(guardPos, writePos + 40)).toMatch(
      /^if \(full\) \{\s*\n\s*writeFtsForReadyChapter\(spec, shell\);/,
    );
    // 未就绪分支不得写 FTS：`if (full)` 之外再无第二处调用
    const callCount = (asmBody.match(/writeFtsForReadyChapter\(/g) ?? []).length;
    expect(callCount).toBe(1);
  });

  test('宿主适配器登记 + 聚合导出登记（装配唯一入口）', () => {
    expect(src).toMatch(/const chapterAssemblyHost: AsmHost = \{/);
    expect(src).toMatch(/readinessOf: builtinChapterReadiness,/);
    expect(src).toMatch(/registerAssemblyHost\(chapterAssemblyHost\);/);
    expect(src).toMatch(/^  assembleChapterStreaming,$/m);
    expect(src).toMatch(/^  assembleChapterToFull,$/m);
    expect(src).toMatch(/^  onChapterReady,$/m);
  });
});

// ============================ ⑧ 接线与灰度回退（结构断言） ============================

describe('⑧ 接线与灰度回退（一行回退且真能回退）', () => {
  const svc = readFileSync(USER_BOOK_SERVICE_PATH, 'utf8');

  test('R38_SCHEDULER_ENABLED 默认开启（关掉即回落 r37 行为）', () => {
    expect(R38_SCHEDULER_ENABLED).toBe(true);
  });

  test('prefillBuiltinNeighbors：默认走调度器双向交错，关闭时完整回落 r37 串行', () => {
    expect(svc).toMatch(/export async function prefillBuiltinNeighbors\(/);
    expect(svc).toMatch(/count = resolvePreloadSpan\(\)/);
    expect(svc).toMatch(/if \(R38_SCHEDULER_ENABLED\) \{/);
    // 双向交错：同一 k 内 prev 先于 next 提交（两侧最近邻同时进入队列）
    const prevPos = svc.search(/AsmPriority\.PrevNeighbor,\s*'prev',/);
    const nextPos = svc.search(/AsmPriority\.NextNeighbor,\s*'next',/);
    expect(prevPos).toBeGreaterThan(-1);
    expect(nextPos).toBeGreaterThan(prevPos);
    expect(nextPos - prevPos).toBeLessThan(400); // 同一 for 块内 = 交错而非「前 N 后 N」
    // 交错由同一个 k 循环驱动
    expect(svc).toMatch(
      /for \(let k = 1; k <= count; k \+= 1\) \{[\s\S]{0,900}?PrevNeighbor,[\s\S]{0,400}?NextNeighbor,/,
    );
    // 回退路径逐字保留 r37：fillBuiltinChapterNow + 章间让出
    expect(svc).toMatch(/await fillBuiltinChapterNow\(bookId, cid\);/);
    expect(svc).toMatch(/setTimeout\(resolve, FILL_YIELD_MS\)/);
    // 回退分支位于调度器分支之后（调度器分支 return 早退，开关关闭才落到串行）
    const schedBranch = svc.search(/if \(R38_SCHEDULER_ENABLED\) \{/);
    const fallbackPos = svc.search(/await fillBuiltinChapterNow\(bookId, cid\);/);
    expect(schedBranch).toBeGreaterThan(-1);
    expect(fallbackPos).toBeGreaterThan(schedBranch);
  });

  // 【已删除用例 · 4 条】原 ⑧ 组内针对 `screens/ReaderScreen.tsx` 的源码文本契约：
  //   · 「ReaderScreen：目标章 P1（先 bumpGeneration） + 邻章双向交错」
  //   · 「ReaderScreen：关闭调度器时保留 r37 直连装配（真能回退）」
  //   · 「ReaderScreen：onChapterReady 按世代 + 就绪级别精确门控」
  //   · 「ReaderScreen：常量外置为档位读取入口（快照兜底，判定逻辑一字不改）」
  //
  //   谁删的：cleanup-executor（2026-09-22，团队 software-guoxue-reader）。
  //   为什么删：依据 `docs/reader-cleanup-plan-2026-09-22.md` §4/§5/§6（用户裁定
  //     「真零起点」），`ReaderScreen.tsx` 的 5430 行实现**整体移除**（跳章 / 翻页 /
  //     跨章拼接 / 定位落位 / 视口补偿 / 边缘手势），文件已替换为 56 行最小空壳。
  //     这 4 条锁定的正是被清除的接线（`bumpGeneration` + P1/邻章 request、
  //     r37 直连回退分支、`onChapterReady` 世代门控、`MAX_CONTINUOUS_CHAPTERS` /
  //     `PRELOAD_SPAN_FALLBACK` / `CONTIGUOUS_PRELOAD_SCREENS` 等阅读器窗口常量）
  //     ⇒ 现在只会**假红**（断言具体结构），不构成回归防护。
  //   替代覆盖：**调度器侧**的同族契约仍在本文件其余用例中（①~⑦ 行为组 +
  //     ⑧ 组上面两条 `UserBookService` 接线断言），未受清理影响。
  //   新阅读器从零重写后，须由新实现自己重新立「接线 + 世代门控」断言。
  //
  // 【已删除常量】`READER_SCREEN_PATH` 仅为上述 4 条而存在，一并移除（否则成死变量）。
});
