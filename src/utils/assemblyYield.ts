/**
 * 「让路给装配」的**保底配额**与**纯判定**——装配侧忙期与消费方推进之间的唯一闸门。
 *
 * ⚠ 本模块是「真零起点」阅读器清理后的**保留最小面**：仅两个导出，
 * `ASSEMBLY_YIELD_STARVE_MAX_MS` 与 {@link planAssemblyYield}，被**保留族**
 * `services/UserBookService.ts` 的 `ftsBookChunkPaused()`（书级分片 FTS 索引写入
 * 让路）消费 —— 这是 FTS 章级/分片增量索引的**真实契约**，与视口/翻页无关。
 *
 * 契约要求：消费方**必须** `import` 本模块的配额常量，**不得**在本地再写一份
 * 数值真相（`src/__tests__/ftsBookChunkYield.test.ts` D2 组锁定该接线）。
 *
 * 本文件**无任何 import**、零时钟、零状态、零 IO。
 */

/**
 * 【章节加载重构 T05】让路给装配的**保底配额**（ms）——「不许饿死」的唯一闸门。
 *
 * ── 语义（产品侧已代决，**不可放宽**）─────────────────────────────────────
 * 装配侧「用户活跃」（`ChapterAssemblyScheduler.isUserActive()` = 有 P1~P3 装配
 * 在飞）期间，消费方**主动让路**；但让路**累计不得超过本配额**：连续忙期一旦
 * 超过本配额 ⇒ **强行放行**（继续推进）⇒ 结构上排除「装配一直忙 ⇒ 消费方永不跑」
 * 的饿死路径（→ {@link planAssemblyYield}）。
 *
 * ── 为什么是「连续忙期只发一次」，而不是「每 2s 抖一下」──────────────────
 * 放行后**不重置**忙期起点，只有装配转入空闲才重新记账。理由：若每次放行都重置，
 * 长忙期内会退化成「每 2s 只推一步」，而帧率其实已由消费方自身的切片/让出机制
 * 保证 ⇒ 重置只损收益、不增保护。副作用（**已知并接受**）：长忙期内放行之后的
 * 切片会与装配切片重新互插 —— 这是「帧率 > 时效」取舍下的上限，且此时装配已连跑
 * ≥2s。
 */
export const ASSEMBLY_YIELD_STARVE_MAX_MS = 2000;

/**
 * 让路给装配的**判定结果**（纯数据；执行器只需把它写回自己的忙期字段）。
 */
export interface AssemblyYieldPlan {
  /** 是否继续让路（等待）。`false` = 可以推进：装配已空闲，或配额已耗尽 */
  defer: boolean;
  /**
   * 新的**忙期起点**：
   *  - 装配空闲 ⇒ `null`（配额**重新记账**）；
   *  - 装配忙 ⇒ 首次让路时 = `now`，此后保持不变（**放行也不重置** —— 见
   *    {@link ASSEMBLY_YIELD_STARVE_MAX_MS} 的「只发一次」论证）。
   */
  busySince: number | null;
}

/**
 * 【章节加载重构 T05】让路给装配的**纯判定**（`now` 与 `busy` 由调用方注入；
 * 本模块零时钟、零状态 —— 执行器只保存一个 `busySince` 字段）。
 *
 * ```text
 * !busy                        ⇒ 不让路，busySince = null（配额重新记账）
 * busy 且 busySince === null   ⇒ 让路一次，busySince = now（忙期起点）
 * busy 且 now − busySince < 配额⇒ 让路（继续等）
 * busy 且 now − busySince ≥ 配额⇒ **放行**（保底：强行推进），busySince 不变
 * ```
 *
 * ── 三条边界（都可被变异反证）─────────────────────────────────────────────
 * ① **`busy` 的真源在调用方**：本函数只接受布尔值，绝不自己读装配调度器 ——
 *    避免「消费方第二套活跃判定」这一双真相源；
 * ② **`quotaMs ≤ 0` / 非法 ⇒ 配额 0 ⇒ 恒不让路**（一行回退；也是 NaN 的失效安全向：
 *    宁可不让路，也绝不因 NaN 变成「永远让路」）；
 * ③ **`now` 非法（NaN/Infinity）⇒ 让路一次**：宁可慢一次，也不因时钟异常而放行
 *    （放行 = 与装配抢帧；让路是安全侧）。
 *
 * @param busy 装配侧是否「用户活跃」（`ChapterAssemblyScheduler.isUserActive()`）
 * @param busySince 上次判定给出的忙期起点（`null` = 上一轮装配空闲）
 * @param now 当前墙钟（由调用方注入）
 * @param quotaMs 保底配额（默认 {@link ASSEMBLY_YIELD_STARVE_MAX_MS}）
 */
export function planAssemblyYield(
  busy: boolean,
  busySince: number | null,
  now: number,
  quotaMs: number = ASSEMBLY_YIELD_STARVE_MAX_MS,
): AssemblyYieldPlan {
  if (!busy) {
    return { defer: false, busySince: null };
  }
  const quota = Number.isFinite(quotaMs) && quotaMs > 0 ? quotaMs : 0;
  const start =
    typeof busySince === 'number' && Number.isFinite(busySince) ? busySince : now;
  if (!Number.isFinite(now)) {
    return { defer: true, busySince: start };
  }
  return { defer: now - start < quota, busySince: start };
}
