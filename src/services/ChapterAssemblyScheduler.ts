/**
 * 统一装配调度器（r38 T02 · 全链路唯一「装配某章」的入口）
 *
 * 设计（见架构 §2.2 / §4）：
 *  - 5 级优先级 P1 目标章 > P2 上滚邻章 > P3 下滚邻章 > P4 视口空壳 > P5 空闲扩散；
 *  - **单 worker 串行**（INV-1：任何时刻最多 1 个装配任务在执行）；
 *  - **世代作废**（INV-3：bumpGeneration() 后队列内旧世代请求立即作废；
 *    正在执行的单章允许跑完 —— 取消粒度 = 章边界，保「全有或全无」语义，
 *    防中途强杀留下部分产出 + 游标状态不明的**永久截断章**）；
 *  - **同章去重**（INV-2：同 bookId:chapterId 任意时刻至多 1 个 in-flight，
 *    队列内同章合并到最高优先级且 requestedAt 取更早者，防「接力去重」把
 *    饥饿计时不断重置）；
 *  - **饥饿保护**（INV-4：入队后 starvationMs(10s) 必被提权或显式放弃，
 *    显式放弃必落 [PERF][asm] abandon 日志，不静默丢失）；
 *  - **FTS 让路**（INV-5：队列内有 P1~P3 或正在执行时，把 ftsQueuePausedUntil
 *    抬到 now + tier.ftsYieldMs，并对外提供 isUserActive() 供 FTS 队列在
 *    书间/章间双检查点查询）；
 *  - **波次交错**（【T04】P2/P3 **同组**，组内按 `wave` = 距阅读锚点的距离取用
 *    ⇒ **执行序 = 调用点入队序** `prev1 → next1 → prev2 → next2 → …`。
 *    在此之前的暗桩：排序键是 `(priority, seq)`，而 `PrevNeighbor=2 < NextNeighbor=3`
 *    ⇒ 实际执行恒为「全部 prev 先、再全部 next」，`k` 循环的交错**只在入队层成立**。
 *    见 {@link priorityGroupOf} 与 {@link takesPrecedence}）；
 *  - 执行器由宿主（UserBookService）注入（AsmHost），调度器本身不依赖任何
 *    IO/资产实现 → 可被 jest 以假宿主直接单测。
 */
import { getParams as getTierParams, type TierParams } from '@/services/DeviceTierService';

/** 【灰度开关】装配是否走统一调度器：false → 旧 prefillBuiltinNeighbors 串行"前 N 后 N"（r37 行为） */
export const R38_SCHEDULER_ENABLED = true;

/**
 * 【T04 灰度开关】邻章**波次交错**（「执行序 = 入队序」）。
 *
 * `false` → `takeNext()` 的排序键退回 `(priority, seq)`，逐字等价 T04 之前
 * （即**先跑完所有上滚、再跑所有下滚**）。**一行回退**。
 *
 * ⚠ **本开关必须被真实消费**（运行期镜像 `waveInterleaveEnabled` 的初值即取自本常量）：
 * T07 的**死常量血训** —— 新增开关若不接线，则「改成 false 一键回退」是空头承诺，
 * 且改值不改变任何行为、无任何测试可观测。故本文件另有一条**行为**断言
 * 覆盖「开关关 → 旧序」（见 `schedulerWaveInterleave.test.ts` ②）。
 */
export const R38_WAVE_INTERLEAVE_ENABLED = true;

/** 5 级优先级（数值越小越优先；与 PRD P0-2 一一对应） */
export enum AsmPriority {
  /** 目标章（跳章落点；阻塞 loading） */
  Target = 1,
  /** 上滚方向邻章（用户新增：双向都要有） */
  PrevNeighbor = 2,
  /** 下滚方向邻章 */
  NextNeighbor = 3,
  /** 当前视口窗口内的空壳章 */
  ViewportShell = 4,
  /** 空闲扩散（离当前位置越近越优先） */
  IdleDiffuse = 5,
}

export type AsmReason = 'target' | 'prev' | 'next' | 'shell' | 'idle' | 'bookorder';

/**
 * 就绪级别：门控「能否进入拼接序列」。
 * - Empty：空壳（segments.length === 0）→ ★红线④：永不插入拼接序列；
 * - Partial：有内容但流式游标未 done → 只能做目标章首屏，禁止参与 prepend；
 * - Full：完全就绪（游标 done 或一次性装配完成）→ 可参与双向拼接序列。
 */
export enum ChapterReadiness {
  Empty = 0,
  Partial = 1,
  Full = 2,
}

/**
 * 装配完成通知（架构 §2.6 事件契约：扩展既有 onBuiltinFillProgress，
 * 保持向后兼容）。`generation` = 该事件由哪一代请求产生：阅读器据此丢弃
 * 「跳章世代之前」的陈旧事件（旧位置任务完成后不得驱动新章列表重算）。
 */
export interface ChapterReadyEvent {
  bookId: string;
  chapterId: string;
  chapterOrder: number;
  readiness: ChapterReadiness;
  bytes: number;
  ms: number;
  /** 该事件是否由「跳章世代」之后的请求产生（阅读器据此丢弃陈旧事件） */
  generation: number;
}

export interface AsmRequest {
  bookId: string;
  chapterId: string;
  priority: AsmPriority;
  reason: AsmReason;
  /** 入队时的跳章世代快照：见 bumpGeneration() */
  generation: number;
  /** 饥饿保护基准（in-flight 去重命中时继承更早者） */
  requestedAt: number;
  /**
   * 【T04】波次 = **「距阅读锚点的层次」**：上滚第 `k` 层与下滚第 `k` 层**同号**
   * （调用点传循环变量 `k`，`k` 从 1 起 ⇒ 实测 `prev1`/`next1` 都是 `wave=1`）。
   *
   * **可选**：缺省（undefined）在排序中等价于 `0`（见 {@link waveOf}）。
   * 所有既有调用者（P1/P4/P5 与未改造的邻章调用点）都不传 ⇒ 排序退化为
   * T04 之前的语义（`(priority, seq)`），历史行为不被改写。
   *
   * 只有 `takeNext()` 消费它；**不得**把 `wave` 抬进 `AsmPriority`（数值 1–5 被
   * 冻结测试逐字锁定，且 `PrevNeighbor=2 < NextNeighbor=3` 一旦当首键，
   * `wave` 就永远是死字段）。
   */
  wave?: number;
}

export interface AsmStats {
  queued: number;
  /** 正在执行的章 key（`bookId:chapterId`）；无则 null */
  inflight: string | null;
  /** in-flight 去重命中次数（验收口径：同章 IO ≤1） */
  dedupHits: number;
  /** 世代作废丢弃数 */
  staleDrops: number;
  /** 饥饿提权次数 */
  starvePromotes: number;
  /** 饥饿显式放弃次数（必须为 0 才是健康态） */
  starveAbandons: number;
  doneCount: number;
  generation: number;
}

/** 执行上下文（宿主据此把事件打上世代，阅读器可丢弃陈旧事件） */
export interface AsmExecContext {
  generation: number;
  priority: AsmPriority;
  reason: AsmReason;
}

/**
 * 【r38 T03】扩散锚点 = 当前阅读位置（空闲扩散的唯一依据）。
 * 由阅读器在跳章 / 切章 / 跨章滚动进入新章时上报；**锚点迁移即旧位置扩散作废**
 * （验收口径：跳章后原位置扩散 2s 内停止推进）。
 */
export interface AsmReadingAnchor {
  bookId: string;
  chapterId: string;
  /** 章序（book.chapters 下标 + 1；0 = 未知） */
  order: number;
  /** 上报时的跳章世代（诊断用，便于与 stale-drop 对齐） */
  generation: number;
  updatedAt: number;
}

/**
 * 锚点上报后的「用户活跃窗口」（ms）：窗口内不做空闲扩散。
 * 取值与 `SCROLL_WINDOW_CLOSE_MS` 同级（手势关窗量级），保证
 * 「用户刚跳到新位置还在滚动」期间绝不启动后台扩散抢 JS。
 */
export const ANCHOR_ACTIVITY_WINDOW_MS = 2000;

/** 宿主适配器（UserBookService 注入真实实现；测试注入假实现） */
export interface AsmHost {
  /** 读取就绪级别（拼接门唯一判据的真源） */
  readinessOf(bookId: string, chapterId: string): ChapterReadiness;
  /**
   * 章节顺序（book.chapters 下标 + 1）；未知章返回 0。
   * 【D6 保留钩子】调度器当前不消费：按阅读位置排序的装配策略属于 T05
   * （锚点模型）——届时饥饿提升/同级择优将以此判据就近排序。保留而不删除
   * 的理由：删除会改变 AsmHost 契约并迫使 T05 重新引入同一入口；此处显式
   * 标注「保留待接线」，不留隐式死码。
   */
  orderOf(bookId: string, chapterId: string): number;
  /** 执行一章装配；返回 true = 已达到 READY_FULL。**不可中途取消**（章边界语义） */
  assemble(bookId: string, chapterId: string, ctx: AsmExecContext): Promise<boolean>;
  /** 抬升 FTS 让路时间戳（宿主内部取 max，不会下调） */
  pauseFts(untilMs: number): void;
}

export interface ChapterAssemblyScheduler {
  /** 跳章：递增世代。**未开始**的旧世代请求立即作废；**正在执行**的单章允许跑完 */
  bumpGeneration(): number;
  getGeneration(): number;
  /**
   * 提交装配请求。幂等：已就绪短路 / in-flight 去重 / 队列内同章取最高优先级。
   *
   * 【T04】`wave` = 距阅读锚点的距离（可选；缺省 ⇒ 与 T04 之前逐字等价）。
   * 仅 P2 上滚 / P3 下滚的调用点需要传（见 `AsmRequest.wave`）。
   */
  request(
    bookId: string,
    chapterId: string,
    priority: AsmPriority,
    reason: AsmReason,
    wave?: number,
  ): void;
  /**
   * 批量：按给定量请求（用于双向预热与扩散），内部保证去重与排序。
   * 【T04】`wave` 透传给每个请求（`requestMany` 的调用点均为「同一距离」的一批）。
   */
  requestMany(
    bookId: string,
    chapterIds: string[],
    priority: AsmPriority,
    reason: AsmReason,
    wave?: number,
  ): void;
  /** 同步等待某章达到指定就绪级别（仅用于目标章首屏；带超时，超时返回实际级别） */
  awaitReadiness(
    bookId: string,
    chapterId: string,
    min: ChapterReadiness,
    timeoutMs: number,
  ): Promise<ChapterReadiness>;
  /** 读取就绪级别（拼接门唯一判据） */
  readinessOf(bookId: string, chapterId: string): ChapterReadiness;
  /** 活动门闩：读者是否在交互 / 是否有高优先请求 → 抬升 FTS 让路时间戳 */
  isUserActive(): boolean;
  /**
   * 【r38 T03】上报当前阅读位置（空闲扩散锚点）。跳章 / 切章 / 跨章滚动调用：
   *  - 锚点迁移 → 旧位置的空闲扩散立即作废（取消粒度 = 章边界，进行中的
   *    单章允许跑完）；
   *  - 同时开一个「用户活跃窗口」（ANCHOR_ACTIVITY_WINDOW_MS），窗口内
   *    `isIdle()` 为 false。
   */
  reportReadingAnchor(bookId: string, chapterId: string, order: number): void;
  /** 【r38 T03】读取当前扩散锚点（空闲扩散据此 ±k 交替）；无上报则为 null */
  getReadingAnchor(): AsmReadingAnchor | null;
  /** 【r38 T03】标记用户活跃窗口（手势 / 滚动 / loading）：期间不做空闲扩散 */
  markUserActive(durationMs?: number): void;
  /** 【r38 T03】是否空闲：无活跃窗口且无 P1~P3 活动（空闲扩散与书序兜底的门） */
  isIdle(): boolean;
  /** 断言 / 探针 */
  getStats(): AsmStats;
  /** 仅测试：强制清空队列与 in-flight（不改变世代） */
  __resetForTests(): void;
  /**
   * 仅测试：【T04】切换波次交错的运行期镜像（初值 = `R38_WAVE_INTERLEAVE_ENABLED`）。
   *
   * 存在的理由：`R38_WAVE_INTERLEAVE_ENABLED` 是模块级常量、不可运行期翻转，
   * 于是「关掉开关真的回到旧序」这条**回退能力**就无法被**行为**断言覆盖 ——
   * 那正是 T07 死常量缺陷的同族风险（承诺了回退、却没有可观测的承接者）。
   * 本钩子让回退分支成为**可执行、可断言**的代码路径。
   *
   * ⚠ 传入值一律按**布尔真值**处理；`__resetForTests()` 会把它复位回常量值。
   */
  __setWaveInterleaveForTests(enabled: boolean): void;
  /** 诊断：当前 FTS 让路时间戳（INV-5 探针） */
  getFtsPausedUntil(): number;
  /** 唤醒单 worker（宿主注册后 / 外部状态变化后调用；幂等，无队列时零动作） */
  resume(): void;
}

/** 饥饿保护 watchdog 间隔（与既有同类定时器模式一致：500ms 轮询） */
export const STARVE_WATCHDOG_TICK_MS = 500;

/** 队列内部条目（seq 提供同优先级 FIFO 的稳定序） */
interface QueuedEntry {
  req: AsmRequest;
  seq: number;
}

interface Waiter {
  bookId: string;
  chapterId: string;
  min: ChapterReadiness;
  settle: (level: ChapterReadiness) => void;
}

/**
 * 读取请求的波次（**规范化为「非负有限数」**）。
 *
 * ⚠ **不能**直接返回 `req.wave ?? 0` 就完事：`-3` / `NaN` / `Infinity` 都会让比较
 * 出现**非全序**（`NaN` 与任何数比较皆 false ⇒ 排序结果取决于遍历顺序，
 * 同一队列两次 `takeNext` 可能选出不同的「最小」）。故一律夹到 `0`。
 *
 * 缺省（undefined）⇒ `0`：这是**向后兼容的关键**——所有既有调用点都不传 `wave`，
 * 于是排序键退化为 `(priorityGroup, priority, seq)`，与 T04 之前的 `(priority, seq)`
 * 在**结果上逐位等价**（`priorityGroup` 是 `priority` 的单调分段函数）。
 */
function waveOf(req: AsmRequest): number {
  const w = req.wave;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 【T04】优先级**分组**（`takeNext()` 排序键的首项）。
 *
 * - P1 `Target` → `0`：目标章**绝对优先**，任何波次都越不过它；
 * - P2 `PrevNeighbor` / P3 `NextNeighbor` → `1`：**同组** —— 这是交错成立的前提；
 * - P4 `ViewportShell` → `2`；P5 `IdleDiffuse` → `3`。
 *
 * ⚠⚠ **禁止**把排序键首项改成裸 `priority`：`PrevNeighbor = 2 < NextNeighbor = 3`
 * ⇒ 首键即分出胜负 ⇒ `wave` 永远不做决定 ⇒ **交错整体失效**（T04 的诉求落空，
 * 且不会有任何编译/测试红灯）。这是一处「看起来更简单、实则是暗桩」的位置，
 * 已被 `schedulerWaveInterleave.test.ts` 的源码契约断言 + 行为断言双重守住。
 *
 * ⚠ `AsmPriority` 数值 1/2/3/4/5 **不得改**、不得重编号、不得新增枚举成员
 * （`chapterAssemblyScheduler.test.ts:181-187` 逐字锁定 PRD P0-2 五级映射）。
 */
function priorityGroupOf(priority: AsmPriority): number {
  if (priority <= AsmPriority.Target) {
    return 0;
  }
  if (priority <= AsmPriority.NextNeighbor) {
    return 1;
  }
  return priority === AsmPriority.ViewportShell ? 2 : 3;
}

const EMPTY_TIER: TierParams = getTierParams();

function keyOf(bookId: string, chapterId: string): string {
  return `${bookId}:${chapterId}`;
}

/**
 * 创建调度器实例。
 * @param hostProvider 宿主提供者（懒取：允许先构造单例、后由 UserBookService 注册宿主）
 */
export function createChapterAssemblyScheduler(
  hostProvider: () => AsmHost | null,
): ChapterAssemblyScheduler {
  let generation = 1;
  let seqCounter = 0;
  let queue: QueuedEntry[] = [];
  let index = new Map<string, QueuedEntry>();
  let inflight: AsmRequest | null = null;
  let pumping = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let ftsPausedUntil = 0;
  let waiters: Waiter[] = [];
  /**
   * 【T04】波次交错的运行期镜像：初值取自 `R38_WAVE_INTERLEAVE_ENABLED`
   * ⇒ 常量是**唯一真源**，且**被真实消费**（防 T07 死常量类缺陷）。
   * 仅 `__setWaveInterleaveForTests` 可改；`__resetForTests` 复位回常量值。
   */
  let waveInterleaveEnabled = R38_WAVE_INTERLEAVE_ENABLED;
  /** 【r38 T03】扩散锚点（当前阅读位置）与用户活跃窗口 */
  let readingAnchor: AsmReadingAnchor | null = null;
  let userActiveUntil = 0;
  let stats = {
    dedupHits: 0,
    staleDrops: 0,
    starvePromotes: 0,
    starveAbandons: 0,
    doneCount: 0,
  };

  function params(): TierParams {
    try {
      return getTierParams();
    } catch {
      return EMPTY_TIER; // 档位矩阵读取异常：回落 mid 数值（等价 r37 现状）
    }
  }

  function safeReadiness(bookId: string, chapterId: string): ChapterReadiness {
    const host = hostProvider();
    if (!host) {
      return ChapterReadiness.Empty;
    }
    try {
      const level = host.readinessOf(bookId, chapterId);
      return level === ChapterReadiness.Full || level === ChapterReadiness.Partial
        ? level
        : ChapterReadiness.Empty;
    } catch {
      return ChapterReadiness.Empty;
    }
  }

  /** P1~P3 活动判据（isUserActive 的单一实现，供 isIdle 复用） */
  function isUserActiveNow(): boolean {
    return (
      inflight !== null ||
      queue.some((entry) => entry.req.priority <= AsmPriority.NextNeighbor)
    );
  }

  /** 标记用户活跃窗口（手势 / 滚动 / loading / 锚点上报） */
  function markUserActive(durationMs?: number): void {
    const ms =
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : ANCHOR_ACTIVITY_WINDOW_MS;
    userActiveUntil = Math.max(userActiveUntil, Date.now() + ms);
  }

  /** INV-5：队列内有 P1~P3 或正在执行 → 抬升 FTS 让路时间戳 */
  function latchFts(): void {
    const active =
      inflight !== null ||
      queue.some((entry) => entry.req.priority <= AsmPriority.NextNeighbor);
    if (!active) {
      return;
    }
    const until = Date.now() + params().ftsYieldMs;
    ftsPausedUntil = Math.max(ftsPausedUntil, until);
    try {
      hostProvider()?.pauseFts(ftsPausedUntil);
    } catch {
      // 让路失败不影响装配
    }
  }

  function ensureWatchdog(): void {
    if (watchdog !== null) {
      return;
    }
    watchdog = setInterval(() => {
      watchdogTick();
    }, STARVE_WATCHDOG_TICK_MS);
    // 【D7】后台看门狗不得阻塞宿主进程退出：Node/测试环境有 unref，
    // RN 的 setInterval 返回数字（unref 为 undefined）→ 可选调用即无副作用。
    // 原有「空闲即自停」（stopWatchdogIfIdle）继续作为主防线。
    (watchdog as unknown as { unref?: () => void }).unref?.();
  }

  function stopWatchdogIfIdle(): void {
    if (watchdog !== null && queue.length === 0 && inflight === null) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  function pruneStale(): number {
    if (queue.length === 0) {
      return 0;
    }
    const kept: QueuedEntry[] = [];
    let dropped = 0;
    for (const entry of queue) {
      // INV-3：旧世代请求在未开始前必须作废；in-flight 不在队列内（允许跑完）
      if (entry.req.generation < generation) {
        index.delete(keyOf(entry.req.bookId, entry.req.chapterId));
        dropped += 1;
        continue;
      }
      kept.push(entry);
    }
    if (dropped > 0) {
      queue = kept;
      stats.staleDrops += dropped;
      console.info(
        `[PERF][asm] stale-drop n=${dropped} gen=${generation} queued=${queue.length}`,
      );
    }
    return dropped;
  }

  /**
   * 饥饿保护（§4.3）：
   *  - waited ≥ starvationMs(10s) 且 priority > P1 → 提权到 P1（队首）并计数；
   *  - waited ≥ 2 × starvationMs(20s) → 显式放弃（移除 + 日志），阅读器侧
   *    readinessOf 仍为 Empty → 边界处「停留不空白」，下次滚动/跳章重提。
   */
  function watchdogTick(): void {
    try {
      const now = Date.now();
      const starvationMs = params().starvationMs;
      const abandonMs = starvationMs * 2;
      const survivors: QueuedEntry[] = [];
      let promoted = 0;
      let abandoned = 0;
      for (const entry of queue) {
        const waited = now - entry.req.requestedAt;
        if (waited >= abandonMs) {
          index.delete(keyOf(entry.req.bookId, entry.req.chapterId));
          abandoned += 1;
          stats.starveAbandons += 1;
          console.info(
            `[PERF][asm] abandon ch=${entry.req.chapterId} waited=${waited}ms pri=${entry.req.priority}`,
          );
          settleWaiters(entry.req.bookId, entry.req.chapterId);
          continue;
        }
        if (waited >= starvationMs && entry.req.priority > AsmPriority.Target) {
          entry.req.priority = AsmPriority.Target;
          promoted += 1;
          stats.starvePromotes += 1;
          console.info(
            `[PERF][asm] starve-promote ch=${entry.req.chapterId} waited=${waited}ms`,
          );
        }
        survivors.push(entry);
      }
      queue = survivors;
      if (abandoned > 0 || promoted > 0) {
        console.info(
          `[PERF][asm] watchdog queued=${queue.length} promote=${promoted} abandon=${abandoned}`,
        );
      }
      latchFts();
      if (queue.length > 0 && inflight === null) {
        void pump();
      }
      stopWatchdogIfIdle();
    } catch {
      // watchdog 异常不得影响装配主链路
    }
  }

  function settleWaiters(bookId: string, chapterId: string): void {
    if (waiters.length === 0) {
      return;
    }
    const rest: Waiter[] = [];
    for (const waiter of waiters) {
      if (waiter.bookId !== bookId || waiter.chapterId !== chapterId) {
        rest.push(waiter);
        continue;
      }
      const level = safeReadiness(bookId, chapterId);
      if (level >= waiter.min) {
        waiter.settle(level);
        continue;
      }
      rest.push(waiter);
    }
    waiters = rest;
  }

  /**
   * 【T04】`a` 是否应先于 `b` 执行。
   *
   * 排序键（交错开）：
   * ```
   * (priorityGroup, wave, priority, seq)
   *    priorityGroup: P1→0 | P2,P3→1 | P4→2 | P5→3
   *    wave:          距锚点距离（prev1 = next1 = 0，prev2 = next2 = 1…）
   *    priority:      同 wave 内 prev(P2) 先于 next(P3) —— 与调用点 `k` 循环的声明语义一致
   *    seq:           同优先级 FIFO
   * ```
   * 排序键（交错关，**逐字等价 T04 之前**）：`(priority, seq)`。
   *
   * `priorityGroupOf` 在**异组**时是 `priority` 的单调函数 ⇒ 异组比较退化为
   * `priority` 比较，故两条分支的**异组行为完全一致**；只有**同组（P2/P3）**才分岔。
   */
  function takesPrecedence(a: QueuedEntry, b: QueuedEntry, interleave: boolean): boolean {
    const pa = a.req.priority;
    const pb = b.req.priority;
    if (interleave && priorityGroupOf(pa) === priorityGroupOf(pb)) {
      const wa = waveOf(a.req);
      const wb = waveOf(b.req);
      if (wa !== wb) {
        return wa < wb;
      }
      if (pa !== pb) {
        return pa < pb; // 同 wave 内 prev 先于 next
      }
      return a.seq < b.seq;
    }
    if (pa !== pb) {
      return pa < pb;
    }
    return a.seq < b.seq;
  }

  /**
   * 取下一个待执行请求：先作废 stale，再按排序键最小取值（同级 FIFO）。
   *
   * 【T04】排序键与「为什么 P2/P3 必须同组」见 {@link takesPrecedence} 与
   * {@link priorityGroupOf}。本任务的整条诉求就是让 `takeNext` 的取用顺序
   * **等于调用点的入队顺序**（`prev1 → next1 → prev2 → next2 → …`）。
   */
  function takeNext(): QueuedEntry | null {
    pruneStale();
    if (queue.length === 0) {
      return null;
    }
    const interleave = waveInterleaveEnabled;
    let best = 0;
    for (let i = 1; i < queue.length; i += 1) {
      if (takesPrecedence(queue[i], queue[best], interleave)) {
        best = i;
      }
    }
    const [entry] = queue.splice(best, 1);
    index.delete(keyOf(entry.req.bookId, entry.req.chapterId));
    return entry;
  }

  /**
   * 单 worker 串行泵（INV-1）：
   *  - 执行期间 inflight 非空 → 不再取新任务（并发恒 ≤1）；
   *  - 进入执行的请求**不可取消**（章边界语义，红线⑤/R6）；
   *  - 章间不追加墙钟等待：节奏由执行器内部按 tier.fillYieldMs 分片让出。
   */
  async function pump(): Promise<void> {
    if (pumping || inflight !== null) {
      return;
    }
    pumping = true;
    try {
      for (;;) {
        const host = hostProvider();
        if (!host) {
          // 宿主未注册（理论上不可达：UserBookService 模块加载即注册）：
          // 保留队列不丢弃，注册后由 resume()/registerAssemblyHost 唤醒
          console.warn(`[PERF][asm] host-not-registered queued=${queue.length}`);
          break;
        }
        const entry = takeNext();
        if (!entry) {
          break;
        }
        inflight = entry.req;
        latchFts();
        const t0 = Date.now();
        let ok = false;
        try {
          ok = await host.assemble(entry.req.bookId, entry.req.chapterId, {
            generation,
            priority: entry.req.priority,
            reason: entry.req.reason,
          });
        } catch {
          ok = false;
        }
        const ms = Date.now() - t0;
        inflight = null;
        if (ok) {
          stats.doneCount += 1;
        }
        // 【T04】**纯追加后缀**：仅当该请求带波次才打印 ` wave=<k>`。
        // 目的 = 让「执行序 = 入队序（k=1:prev1,next1 → … → k=5:next5）」这条
        // 真机验收口径**可直接从小票读出**，而不必靠人脑把章 id 映射回距离。
        // 不打印 `wave=-1` 之类占位：既有调用点（P1/P4/P5）不带波次，
        // 补一个假值会让「未参与交错」与「距离 0」在日志上不可区分（伪证）。
        const waveTag = typeof entry.req.wave === 'number' ? ` wave=${entry.req.wave}` : '';
        console.info(
          `[PERF][asm] ${ok ? 'done' : 'not-ready'} ch=${entry.req.chapterId} ` +
            `pri=${entry.req.priority} reason=${entry.req.reason} gen=${generation} ` +
            `ms=${ms}${waveTag}`,
        );
        settleWaiters(entry.req.bookId, entry.req.chapterId);
        stopWatchdogIfIdle();
      }
    } finally {
      pumping = false;
      stopWatchdogIfIdle();
    }
  }

  function request(
    bookId: string,
    chapterId: string,
    priority: AsmPriority,
    reason: AsmReason,
    wave?: number,
  ): void {
    if (!bookId || !chapterId) {
      return;
    }
    const now = Date.now();
    const key = keyOf(bookId, chapterId);
    // 【T04】入参波次：非正/非有限一律视为「未提供」（null），由 waveOf 兜 0
    const waveIn =
      typeof wave === 'number' && Number.isFinite(wave) && wave > 0 ? wave : null;
    // ① 已就绪短路（零成本幂等）
    if (safeReadiness(bookId, chapterId) >= ChapterReadiness.Full) {
      return;
    }
    // ② 队列内同章：合并到最高优先级（reason 跟随胜出者）+ requestedAt 取更早者
    const queued = index.get(key);
    if (queued) {
      stats.dedupHits += 1;
      if (priority < queued.req.priority) {
        queued.req.priority = priority;
        queued.req.reason = reason;
      }
      queued.req.requestedAt = Math.min(queued.req.requestedAt, now);
      queued.req.generation = Math.max(queued.req.generation, generation);
      // 【T04】同章合并取 **min(wave)**：更近的那次请求决定它的交错位置
      // （更远的位置只会让它更晚，合并到更晚是无理由的劣化）。
      // 仅当「本次带了 wave」才参与；否则保留既有值（缺省请求不得把已编号的
      // 条目打回 0 —— 否则 P1/P4/P5 的重复请求会静默改变交错位置）。
      if (waveIn !== null) {
        queued.req.wave =
          typeof queued.req.wave === 'number' && Number.isFinite(queued.req.wave)
            ? Math.min(queued.req.wave, waveIn)
            : waveIn;
      }
      latchFts();
      return;
    }
    // ③ in-flight 同章：去重命中（章边界不可取消），仅继承更早的饥饿基准
    if (inflight && keyOf(inflight.bookId, inflight.chapterId) === key) {
      stats.dedupHits += 1;
      inflight.requestedAt = Math.min(inflight.requestedAt, now);
      latchFts();
      return;
    }
    const req: AsmRequest = {
      bookId,
      chapterId,
      priority,
      reason,
      generation,
      requestedAt: now,
      // 【T04】缺省保持 `undefined`（不写成 0）：字段缺席本身就是
      // 「本调用点未参与波次交错」的可观测事实，便于诊断与源码契约断言。
      ...(waveIn !== null ? { wave: waveIn } : {}),
    };
    seqCounter += 1;
    const entry: QueuedEntry = { req, seq: seqCounter };
    queue.push(entry);
    index.set(key, entry);
    ensureWatchdog();
    latchFts();
    void pump();
  }

  function requestMany(
    bookId: string,
    chapterIds: string[],
    priority: AsmPriority,
    reason: AsmReason,
    wave?: number,
  ): void {
    const seen = new Set<string>();
    for (const chapterId of chapterIds) {
      if (!chapterId || seen.has(chapterId)) {
        continue; // 入参去重（保持给定顺序 = 同级 FIFO 的稳定序）
      }
      seen.add(chapterId);
      request(bookId, chapterId, priority, reason, wave);
    }
  }

  function awaitReadiness(
    bookId: string,
    chapterId: string,
    min: ChapterReadiness,
    timeoutMs: number,
  ): Promise<ChapterReadiness> {
    const level = safeReadiness(bookId, chapterId);
    if (level >= min) {
      return Promise.resolve(level);
    }
    const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
    return new Promise<ChapterReadiness>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: ChapterReadiness): void => {
        if (done) {
          return;
        }
        done = true;
        // 【D7】提前 settle（就绪达成 / 超时自身）→ 撤掉超时定时器，
        // 不留悬挂句柄（此前提前 settle 后定时器仍存活，是 jest
        // 「worker failed to exit gracefully」的唯一悬挂句柄来源）
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      };
      const waiter: Waiter = {
        bookId,
        chapterId,
        min,
        settle: finish,
      };
      waiters.push(waiter);
      timer = setTimeout(() => {
        timer = null;
        waiters = waiters.filter((w) => w !== waiter);
        finish(safeReadiness(bookId, chapterId)); // 超时返回实际级别
      }, safeTimeout);
      // 【D7】等待语义的纯后台定时器：不阻塞宿主进程退出（RN 无 unref，可选调用）
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  function getStats(): AsmStats {
    return {
      queued: queue.length,
      inflight: inflight ? keyOf(inflight.bookId, inflight.chapterId) : null,
      dedupHits: stats.dedupHits,
      staleDrops: stats.staleDrops,
      starvePromotes: stats.starvePromotes,
      starveAbandons: stats.starveAbandons,
      doneCount: stats.doneCount,
      generation,
    };
  }

  return {
    bumpGeneration(): number {
      generation += 1;
      const dropped = pruneStale();
      console.info(`[PERF][asm] bump-generation gen=${generation} stale-drop=${dropped}`);
      // in-flight 请求（若属于旧世代）保留：允许跑完（章边界取消语义）
      return generation;
    },
    getGeneration(): number {
      return generation;
    },
    request,
    requestMany,
    awaitReadiness,
    readinessOf(bookId: string, chapterId: string): ChapterReadiness {
      return safeReadiness(bookId, chapterId);
    },
    isUserActive(): boolean {
      return isUserActiveNow();
    },
    reportReadingAnchor(bookId: string, chapterId: string, order: number): void {
      if (!bookId || !chapterId) {
        return;
      }
      const prev = readingAnchor;
      readingAnchor = {
        bookId,
        chapterId,
        order: Number.isFinite(order) && order > 0 ? order : 0,
        generation,
        updatedAt: Date.now(),
      };
      markUserActive();
      console.info(
        `[PERF][diffuse] anchor-move book=${bookId} ch=${chapterId} order=${
          readingAnchor.order
        } gen=${generation}${
          prev ? ` from=${prev.bookId}:${prev.chapterId}` : ''
        }`,
      );
    },
    getReadingAnchor(): AsmReadingAnchor | null {
      return readingAnchor;
    },
    markUserActive(durationMs?: number): void {
      markUserActive(durationMs);
    },
    isIdle(): boolean {
      return Date.now() >= userActiveUntil && !isUserActiveNow();
    },
    getStats,
    __setWaveInterleaveForTests(enabled: boolean): void {
      waveInterleaveEnabled = !!enabled;
    },
    __resetForTests(): void {
      queue = [];
      index = new Map<string, QueuedEntry>();
      inflight = null;
      pumping = false;
      ftsPausedUntil = 0;
      readingAnchor = null;
      userActiveUntil = 0;
      // 【T04】交错镜像复位回常量值：跨用例残留会让下一个用例在
      // 「上一用例关掉了交错」的脏状态下断言取序 ⇒ 假红/假绿。
      waveInterleaveEnabled = R38_WAVE_INTERLEAVE_ENABLED;
      stats = {
        dedupHits: 0,
        staleDrops: 0,
        starvePromotes: 0,
        starveAbandons: 0,
        doneCount: 0,
      };
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      for (const waiter of waiters) {
        waiter.settle(ChapterReadiness.Empty);
      }
      waiters = [];
    },
    getFtsPausedUntil(): number {
      return ftsPausedUntil;
    },
    resume(): void {
      ensureWatchdog();
      void pump();
    },
  };
}

// ============ 默认单例（宿主由 UserBookService 在模块加载时注册） ============

let registeredHost: AsmHost | null = null;

/** 注册宿主适配器（UserBookService 注入；重复注册以最后一次为准） */
export function registerAssemblyHost(host: AsmHost): void {
  registeredHost = host;
  // 注册前可能已有请求滞留（宿主未就绪时队列不消费）：注册后立即唤醒单 worker
  const pending = chapterAssemblyScheduler.getStats();
  if (pending.queued > 0) {
    console.info(`[PERF][asm] host-registered queued=${pending.queued}`);
  }
  chapterAssemblyScheduler.resume();
}

/** 默认调度器单例（阅读器/预热链路统一走它） */
export const chapterAssemblyScheduler: ChapterAssemblyScheduler =
  createChapterAssemblyScheduler(() => registeredHost);

/** 与模块同名的聚合导出（调用方以 ChapterAssemblyScheduler.xxx 取用） */
export const ChapterAssemblyScheduler: ChapterAssemblyScheduler = chapterAssemblyScheduler;

export default chapterAssemblyScheduler;
