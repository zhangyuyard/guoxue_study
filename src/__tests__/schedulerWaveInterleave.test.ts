/**
 * 【T04 · P1-3】`takeNext()` 波次交错：「执行序 = 入队序」
 *
 * ## 被测的暗桩（T04 之前）
 * `takeNext()` 的排序键是 `(priority, seq)`，而 `AsmPriority.PrevNeighbor = 2 <
 * NextNeighbor = 3` ⇒ **首个键就分出胜负** ⇒ 实际执行序恒为
 * 「**全部上滚先、再全部下滚**」。调用点 `k` 循环里写的
 * `prev1 → next1 → prev2 → next2 → …` **只在入队层成立**，在**执行层从未成立**；
 * 而 `UserBookService.prefillBuiltinNeighbors` 的文档注释一直宣称它就是执行序。
 * 后果：跳章后「下滚方向够到边界前就绪」这件事被系统性推迟到「上滚 3 章全跑完」之后。
 *
 * ## 修法（不改枚举数值）
 * 排序键 → `(priorityGroup, wave, priority, seq)`，其中 `priorityGroup` 把
 * **P2/P3 归为同组**、`wave` = 距阅读锚点的距离（`prev1 = next1 = 0`，
 * `prev2 = next2 = 1`…）。`AsmPriority` 的 1/2/3/4/5 **一个都没动**。
 *
 * ## 取证边界（★ 必读，勿把本文件当端到端证据）
 * 1. **A 组（行为）**：用**假宿主**直接单测调度器 ⇒ 证的是「调度器交出的执行序」。
 *    这是本任务的核心判据，且它**能证伪**（见下方「鉴别力自锁」）。
 * 2. ⚠ **B 组是源码契约断言，不是行为证据**：被断言的调用点（装配调度层）
 *    在 jest 环境**不可渲染/不可驱动**（既有先例：同族测试同样
 *    `readFileSync` 读源码）⇒「**生产真的把 `k` 当第 5 实参传下去了**」这件事，
 *    行为层测不到，**只能**由源码契约断言 + 真机 `[PERF][asm] done … wave=<k>`
 *    读数共同覆盖。本条与 T07 的 D 组同类：**源码断言的必要性来自行为层原理上不可达**。
 *    ⚠ 清理后本组只剩 `ChapterAssemblyScheduler.ts` 与 `UserBookService.ts` 两侧
 *    （原 B3 针对 `ReaderScreen.tsx`，随该文件重写为最小空壳而删除，理由见 B3 位）。
 * 3. **真机才能证**：真实跳章时 `wave=1..5` 的**实际出货顺序**与
 *    `[PERF][asm] abandon == 0`（CI 只能用假宿主证「取序正确」，证不了真实耗时）。
 *
 * ## 鉴别力自锁（防「假绿」）
 * A① 的期望序列**同时**是「旧序的反例」：若 `wave` 未接线 / 未参与比较，
 * 该断言必红（旧序是 `t,p1,p2,p3,n1,n2,n3`）。A② 反向验证「关掉开关回到旧序」，
 * 于是「交错」这条结论被**双向夹住**：开着必须是新序、关掉必须是旧序。
 * 任何一侧绿另一侧红都说明实现或断言有一处是错的。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  AsmPriority,
  ChapterReadiness,
  R38_WAVE_INTERLEAVE_ENABLED,
  createChapterAssemblyScheduler,
  type AsmHost,
} from '@/services/ChapterAssemblyScheduler';
import { __setTierForTests } from '@/services/DeviceTierService';

const BOOK = 'builtin-t04-wave-test';

// ============================ 假宿主（可编程，含阻塞闸门） ============================

interface FakeHostState {
  readiness: Map<string, ChapterReadiness>;
  /** 执行序（按装配**开始**时间记录） */
  calls: string[];
  concurrent: number;
  maxConcurrent: number;
  gate: (() => Promise<void>) | null;
}

function keyOf(bookId: string, chapterId: string): string {
  return `${bookId}:${chapterId}`;
}

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
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    gate: null,
  };
  const host: AsmHost = {
    readinessOf: (bookId, chapterId) =>
      state.readiness.get(keyOf(bookId, chapterId)) ?? ChapterReadiness.Empty,
    orderOf: () => 0,
    async assemble(bookId, chapterId) {
      state.calls.push(chapterId);
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      try {
        if (state.gate) {
          await state.gate();
        }
      } finally {
        state.concurrent -= 1;
      }
      state.readiness.set(keyOf(bookId, chapterId), ChapterReadiness.Full);
      return true;
    },
    pauseFts() {
      /* 本文件不观测 FTS 让路 */
    },
  };
  return { host, state };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise<void>((res) => setTimeout(res, 5));
  }
}

const CAS_PATH = resolve(__dirname, '../services/ChapterAssemblyScheduler.ts');
const UBS_PATH = resolve(__dirname, '../services/UserBookService.ts');

/**
 * 剥注释（**先块后行**，顺序不可换）。
 *
 * ⚠ 必要性：本文件与被测源码的**文档注释里都出现** `AsmPriority.PrevNeighbor` /
 * `'prev',` / `wave` 这类被断言的片段。不剥离 ⇒ 断言会被**注释**满足 ⇒
 * 恒真假绿（「源码文本即断言」血训的变体，T07 D 组已踩过一次）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 抽取指定调用名的**全部实参表**（括号配平）。
 *
 * `callee` 传**不含 `(` 的调用名**（函数内部自行要求下一个字符恰为 `(`）。
 * 找不到锚点返回 `[]` ⇒ 调用方必须先 `expect(...).not.toHaveLength(0)`
 * （否则会退化成「空数组里找不到 ⇒ 断言空转」的假绿）。
 */
function argLists(src: string, callee: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(callee, from);
    if (at < 0) {
      break;
    }
    let i = at + callee.length;
    if (src[i] !== '(') {
      // 同前缀的更长的调用名（如 `…requestMany(` 之于 `…request`）：跳过本次命中
      from = at + callee.length;
      continue;
    }
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(start, i));
          break;
        }
      }
    }
    from = i + 1;
  }
  return out;
}

/** 规整空白并去掉尾随逗号（实参表末尾逗号是风格差异，不是语义差异） */
const norm = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,$/, '');

beforeEach(() => {
  __setTierForTests(null); // 档位回落 mid（starvationMs = 10000）
});

// ============================ A 组：λ 执行序（行为） ============================

describe('A 组 · 执行序 = 入队序（行为，假宿主）', () => {
  test('① 双向交错：k=1 的 prev/next 先跑完，才轮到 k=2 —— 而不是「上滚全跑完再下滚」', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    // 占住 worker（进行中的章不可取消 = 章边界语义）
    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    expect(state.calls).toEqual(['seed']);

    // 与真实调用点**逐一对应**的提交序：目标章 P1，然后 k=1..3 逐轮 prev→next
    s.request(BOOK, 't', AsmPriority.Target, 'target');
    for (let k = 1; k <= 3; k += 1) {
      s.requestMany(BOOK, [`p${k}`], AsmPriority.PrevNeighbor, 'prev', k);
      s.requestMany(BOOK, [`n${k}`], AsmPriority.NextNeighbor, 'next', k);
    }
    expect(s.getStats().queued).toBe(7);

    gate.release();
    await waitFor(() => state.calls.length === 8);

    // ★ 断言即「旧序的反例」：旧序会是 seed,t,p1,p2,p3,n1,n2,n3
    expect(state.calls).toEqual(['seed', 't', 'p1', 'n1', 'p2', 'n2', 'p3', 'n3']);
    expect(s.getStats().doneCount).toBe(8);
    expect(s.getStats().queued).toBe(0);
  });

  test('② 一行回退：关掉交错 ⇒ 逐字回到 T04 之前（全部上滚先、再全部下滚）', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    // 本用例是「回退能力」的**行为**承接者：常量本身是模块级 `const`、
    // 不可运行期翻转，故经测试钩子驱动其运行期镜像（初值 = 常量值）。
    s.__setWaveInterleaveForTests(false);

    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    s.request(BOOK, 't', AsmPriority.Target, 'target');
    for (let k = 1; k <= 3; k += 1) {
      s.requestMany(BOOK, [`p${k}`], AsmPriority.PrevNeighbor, 'prev', k);
      s.requestMany(BOOK, [`n${k}`], AsmPriority.NextNeighbor, 'next', k);
    }

    gate.release();
    await waitFor(() => state.calls.length === 8);

    // 与 ① 的**同一入队序列**，仅开关不同 ⇒ 取序必须退回旧序
    expect(state.calls).toEqual(['seed', 't', 'p1', 'p2', 'p3', 'n1', 'n2', 'n3']);
  });

  test('③ `wave` 缺省 ⇒ 同样退回旧序（向后兼容：历史调用点行为不被改写）', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    s.request(BOOK, 't', AsmPriority.Target, 'target');
    // 与 ① 完全相同的入队序，但**不传**第 5 实参
    for (let k = 1; k <= 3; k += 1) {
      s.requestMany(BOOK, [`p${k}`], AsmPriority.PrevNeighbor, 'prev');
      s.requestMany(BOOK, [`n${k}`], AsmPriority.NextNeighbor, 'next');
    }

    gate.release();
    await waitFor(() => state.calls.length === 8);

    expect(state.calls).toEqual(['seed', 't', 'p1', 'p2', 'p3', 'n1', 'n2', 'n3']);
  });

  test('④ 同章合并取 min(wave)：更近的一次请求决定其交错位置', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    // `farA` 先以 wave=3 入场，再以 wave=1 被重复请求（锚点迁移的真实形态）
    s.request(BOOK, 'farA', AsmPriority.PrevNeighbor, 'prev', 3);
    s.request(BOOK, 'midB', AsmPriority.NextNeighbor, 'next', 2);
    s.request(BOOK, 'farA', AsmPriority.PrevNeighbor, 'prev', 1);

    expect(s.getStats().dedupHits).toBe(1);
    expect(s.getStats().queued).toBe(2); // 合并不新增队列项

    gate.release();
    await waitFor(() => state.calls.length === 3);

    // min(3,1) = 1 ⇒ farA 应排在 wave=2 的 midB **之前**
    // （若不取 min、保留 wave=3，则顺序会是 midB, farA ⇒ 红）
    expect(state.calls).toEqual(['seed', 'farA', 'midB']);
  });

  test('⑤ P1 绝对优先 + P4/P5 仍排在其后（波次不得破坏五级语义）', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    // 目标章**不带** wave（缺省 0），邻章带大 wave —— 目标章仍必须先跑
    s.request(BOOK, 'shell', AsmPriority.ViewportShell, 'shell');
    s.request(BOOK, 't', AsmPriority.Target, 'target');
    s.requestMany(BOOK, ['p1'], AsmPriority.PrevNeighbor, 'prev', 1);
    s.requestMany(BOOK, ['n1'], AsmPriority.NextNeighbor, 'next', 1);
    s.request(BOOK, 'idle', AsmPriority.IdleDiffuse, 'idle');

    gate.release();
    await waitFor(() => state.calls.length === 6);

    // P1 → P2/P3（同 wave 内 prev 先）→ P4 → P5
    expect(state.calls).toEqual(['seed', 't', 'p1', 'n1', 'shell', 'idle']);
  });

  test('⑥ 零饿死 + INV-1：8 章全跑到、各一次、并发恒 ≤1、abandon = 0', async () => {
    const { host, state } = createFakeHost();
    const gate = makeGate();
    state.gate = () => gate.promise;
    const s = createChapterAssemblyScheduler(() => host);

    s.request(BOOK, 'seed', AsmPriority.IdleDiffuse, 'idle');
    s.request(BOOK, 't', AsmPriority.Target, 'target');
    for (let k = 1; k <= 3; k += 1) {
      s.requestMany(BOOK, [`p${k}`], AsmPriority.PrevNeighbor, 'prev', k);
      s.requestMany(BOOK, [`n${k}`], AsmPriority.NextNeighbor, 'next', k);
    }

    gate.release();
    await waitFor(() => s.getStats().doneCount === 8);

    const expected = ['seed', 't', 'p1', 'n1', 'p2', 'n2', 'p3', 'n3'];
    expect([...state.calls].sort()).toEqual([...expected].sort()); // 全跑到
    expect(new Set(state.calls).size).toBe(8); // 各一次
    expect(state.maxConcurrent).toBe(1); // INV-1 单 worker
    // ★ 一票否决项：交错不得把任何人饿到放弃
    expect(s.getStats().starveAbandons).toBe(0);
  });
});

describe('A 组附 · 饥饿保护的「一票否决」留痕（假定时器）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('⑦ 9.9s 不放弃（abandon = 0）且 10.1s 确实提权 —— 既守否决项、又证度量非空转', async () => {
    const { host, state } = createFakeHost();
    // 永久占住 worker：只可能「被放弃」，不可能「被执行」
    state.gate = () => new Promise<void>(() => undefined);
    const s = createChapterAssemblyScheduler(() => host);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    s.request(BOOK, 'seed', AsmPriority.Target, 'target');
    for (let k = 1; k <= 3; k += 1) {
      s.requestMany(BOOK, [`p${k}`], AsmPriority.PrevNeighbor, 'prev', k);
      s.requestMany(BOOK, [`n${k}`], AsmPriority.NextNeighbor, 'next', k);
    }
    expect(s.getStats().queued).toBe(6);

    await jest.advanceTimersByTimeAsync(9900);
    // ★ 一票否决项（ABANDON_VETO）：T04 的交错不得让任何邻章被显式放弃
    expect(s.getStats().starveAbandons).toBe(0);
    expect(s.getStats().queued).toBe(6);

    await jest.advanceTimersByTimeAsync(200); // 累计 10.1s ≥ starvationMs(10s)
    // 非空转自证：同一个 watchdog 确实在**评估这 6 个条目**并提权
    //（若把这段删掉，上一行 `abandon === 0` 就可能只是「watchdog 没在跑」的假绿）
    expect(s.getStats().starvePromotes).toBeGreaterThanOrEqual(6);

    infoSpy.mockRestore();
    s.__resetForTests();
  });
});

// ============================ B 组：接线契约（源码断言，行为层不可达） ============================

describe('B 组 · 契约：排序键与调用点接线（源码断言；行为层不可达，见文件头②）', () => {
  const casCode = stripComments(readFileSync(CAS_PATH, 'utf8'));
  const ubsCode = stripComments(readFileSync(UBS_PATH, 'utf8'));

  test('B1 排序键首项是 priorityGroupOf（P2/P3 同组）——裸 priority 当首键会让 wave 永远是死字段', () => {
    const body = casCode.slice(casCode.indexOf('function takesPrecedence('));
    const end = body.indexOf('\n  }');
    const fn = end > 0 ? body.slice(0, end) : '';
    expect(fn).not.toBe(''); // 锚点失效 ⇒ 立即失败，不做空转断言

    // 必须走「同组 ⇒ 先比 wave」这条路
    expect(fn).toMatch(/priorityGroupOf\(pa\)\s*===\s*priorityGroupOf\(pb\)/);
    expect(fn).toMatch(/const wa = waveOf\(a\.req\);/);
    expect(fn).toMatch(/const wb = waveOf\(b\.req\);/);
    expect(fn).toMatch(/if \(wa !== wb\) \{\s*\n\s*return wa < wb;/);
    // 同 wave 内 prev 先于 next（priority 次级键）
    expect(fn).toMatch(/if \(pa !== pb\) \{\s*\n\s*return pa < pb;/);

    // 反断言：**同组判定必须早于**任何裸 priority 比较 —— 否则（如把首键退回裸
    // `priority`）P2/P3 在首键就分出胜负，`wave` 永不参与比较（= T04 前的暗桩形态）。
    const groupAt = fn.indexOf('priorityGroupOf(pa) === priorityGroupOf(pb)');
    const bareAt = fn.indexOf('return pa < pb');
    expect(groupAt).toBeGreaterThan(-1);
    expect(bareAt).toBeGreaterThan(-1);
    expect(groupAt).toBeLessThan(bareAt);
  });

  test('B2 takeNext 真的消费交错开关（防「新开关是死常量」——T07 同族缺陷）', () => {
    expect(R38_WAVE_INTERLEAVE_ENABLED).toBe(true);
    // 常量必须被**代码**消费（不是只出现在注释里）：运行期镜像的初值取自它
    expect(casCode).toMatch(
      /let waveInterleaveEnabled = R38_WAVE_INTERLEAVE_ENABLED;/,
    );
    const take = casCode.slice(casCode.indexOf('function takeNext('));
    const takeBody = take.slice(0, take.indexOf('\n  }'));
    expect(takeBody).not.toBe('');
    expect(takeBody).toMatch(/const interleave = waveInterleaveEnabled;/);
    expect(takeBody).toMatch(/takesPrecedence\(queue\[i\], queue\[best\], interleave\)/);
    // 复位路径必须把镜像还原回常量值（否则跨用例脏状态 ⇒ 假红/假绿）
    expect(casCode).toMatch(/waveInterleaveEnabled = R38_WAVE_INTERLEAVE_ENABLED;\s*\n\s*stats = \{/);
    // 死亡自证：整文件里该常量至少出现 2 次**代码**引用（定义 + 消费）
    const refs = (casCode.match(/R38_WAVE_INTERLEAVE_ENABLED/g) ?? []).length;
    expect(refs).toBeGreaterThanOrEqual(3); // 定义 + 初始化 + 复位
  });

  // 【已删除用例】原「B3 ReaderScreen 两处邻章 request 都把 `k` 作为第 5 实参传下去」
  //   谁删的：cleanup-executor（2026-09-22，团队 software-guoxue-reader）。
  //   为什么删：依据 `docs/reader-cleanup-plan-2026-09-22.md` §4/§5/§6（用户裁定
  //     「真零起点」），`src/screens/ReaderScreen.tsx` 的 5430 行实现**整体移除**
  //     （跳章 / 翻页 / 跨章拼接 / 定位落位 / 视口补偿 / 边缘手势），现为 56 行空壳
  //     ⇒ 该用例断言的两处 `chapterAssemblyScheduler.request(..., 'prev'|'next', k)`
  //     调用点已不存在，`argLists` 会返回空数组而先挂在
  //     `expect(lists.length).toBeGreaterThanOrEqual(3)` 上（假红）。
  //   替代覆盖：**同族接线在保留侧仍有两条独立断言**——
  //     · 本组 B4：`UserBookService` 两处 `requestMany` 的第 5 实参 `k`（未受清理影响）
  //     · `chapterAssemblyScheduler.test.ts` 的调度器侧排序/交错断言
  //     新阅读器从零重写后，若恢复「邻章 request 带 k」的接线，须由新实现自己重新立断言。
  //
  // 【已删除常量】`RS_PATH` / `rsCode` 仅为 B3 而存在，一并移除（否则成死变量）。

  test('B4 UserBookService 两处邻章 requestMany 都把 `k` 作为第 5 实参传下去', () => {
    const lists = argLists(ubsCode, 'chapterAssemblyScheduler.requestMany');
    expect(lists.length).toBeGreaterThanOrEqual(2);
    const prev = lists.find((a) => a.includes('[prevId]'));
    const next = lists.find((a) => a.includes('[nextId]'));
    expect(prev).toBeDefined();
    expect(next).toBeDefined();
    expect(norm(prev!)).toBe("bookId, [prevId], AsmPriority.PrevNeighbor, 'prev', k");
    expect(norm(next!)).toBe("bookId, [nextId], AsmPriority.NextNeighbor, 'next', k");
  });

  test('B5 冻结面未动：枚举数值 1–5 与 PrevNeighbor < NextNeighbor 逐字保持', () => {
    // 与 chapterAssemblyScheduler.test.ts:181-187 同口径（此处再钉一次，防 T04 顺手改数值）
    expect(AsmPriority.Target).toBe(1);
    expect(AsmPriority.PrevNeighbor).toBe(2);
    expect(AsmPriority.NextNeighbor).toBe(3);
    expect(AsmPriority.ViewportShell).toBe(4);
    expect(AsmPriority.IdleDiffuse).toBe(5);
    expect(AsmPriority.PrevNeighbor).toBeLessThan(AsmPriority.NextNeighbor);
    // 且源码里没有新增/重编号枚举成员（枚举体恰好 5 项）
    const enumBody = casCode.slice(
      casCode.indexOf('export enum AsmPriority {'),
      casCode.indexOf('export type AsmReason'),
    );
    expect(enumBody).not.toBe('');
    expect((enumBody.match(/= \d+,/g) ?? []).length).toBe(5);
  });
});
