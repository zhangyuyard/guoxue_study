/**
 * 章滑窗缓存状态机（R2b1，架构 L3c 预取层；对齐 legado 三章滑窗行为的
 * 合规重写：只取「预取前后章 + 跳章不清屏」行为，零代码/零资源引用）。
 *
 * 设计约束：
 * - 纯函数 + 不可变更新：每次操作返回新窗，调用方持单一 state 引用；
 * - 本层不知道章序（prev/next 链属于 TextLibraryService）：裁剪时由调用方
 *   传入应保留的 id 集合（retainIds），避免在本层复制章序逻辑；
 * - 去重判据 = windowBegin 返回 null：已有数据或已在加载都不得重复发起。
 *   对应铁律「绕门直调=一次手势多次推进」：配平式 windowBegin 成功次数
 *   ≤ 发起源次数，调用方不得绕过 begin 直接 put。
 */

export interface ChapterWindow<T> {
  /** 当前中心章（null = 未定位，初始态） */
  readonly centerId: string | null;
  /** 已就绪的章数据（id → 数据） */
  readonly data: ReadonlyMap<string, T>;
  /** 加载中的章 id 集合 */
  readonly inflight: ReadonlySet<string>;
}

export function createChapterWindow<T>(): ChapterWindow<T> {
  return { centerId: null, data: new Map(), inflight: new Set() };
}

/** 章数据是否已就绪 */
export function windowHas<T>(w: ChapterWindow<T>, id: string): boolean {
  return w.data.has(id);
}

/** 章是否加载中 */
export function windowIsLoading<T>(w: ChapterWindow<T>, id: string): boolean {
  return w.inflight.has(id);
}

export function windowGet<T>(w: ChapterWindow<T>, id: string): T | undefined {
  return w.data.get(id);
}

/**
 * 声明开始加载某章。去重闸门：已有数据或已在加载 → 返回 null（调用方
 * 不得发起）；否则该章进入 inflight。inflight 的章 recenter 时按保留集裁剪。
 */
export function windowBegin<T>(w: ChapterWindow<T>, id: string): ChapterWindow<T> | null {
  if (w.data.has(id) || w.inflight.has(id)) {
    return null;
  }
  const inflight = new Set(w.inflight);
  inflight.add(id);
  return { centerId: w.centerId, data: w.data, inflight };
}

/** 加载成功：数据入窗、清除 inflight。 */
export function windowPut<T>(w: ChapterWindow<T>, id: string, data: T): ChapterWindow<T> {
  const nextData = new Map(w.data);
  nextData.set(id, data);
  const inflight = new Set(w.inflight);
  inflight.delete(id);
  return { centerId: w.centerId, data: nextData, inflight };
}

/** 加载失败：仅清除 inflight（允许后续重试），窗内容不变。 */
export function windowFail<T>(w: ChapterWindow<T>, id: string): ChapterWindow<T> {
  const inflight = new Set(w.inflight);
  inflight.delete(id);
  return { centerId: w.centerId, data: w.data, inflight };
}

/**
 * 换中心（跳章/初始化）：更新 centerId；data 与 inflight 只保留
 * retainIds ∪ {centerId}（跳章清窗语义：中心与保留邻域之外的全部丢弃，
 * 与被跳离章相关的加载也作废——陈旧丢弃）。
 */
export function windowRecenter<T>(
  w: ChapterWindow<T>,
  centerId: string,
  retainIds: ReadonlySet<string>,
): ChapterWindow<T> {
  const keep = new Set(retainIds);
  keep.add(centerId);
  // ★★ RB4-PROBE（可移除）：裁窗的前后章集合 + 被裁章的 id。
  //   动机（真机 `rb8-56.log` + 录屏 `291` 对齐墙钟 10:00:xx）：
  //   `TRIM dropped=1` 后 0.3s 内出现 `DROP 287px + 332px`，
  //   而 `CHG delta=0`（锚点 key 下标未变 ⇒ 锚点算法判定「不需补偿」）。
  //   ⇒★**必须知道被裁的是哪一章、在锚点的哪一侧**，才能定修法。
  {
    const out: string[] = [];
    for (const id of w.data.keys()) {
      if (keep.has(id)) out.push(id);
    }
    const droppedIds = [...w.data.keys()].filter((id) => !keep.has(id));
    console.info(
      `[RB4][TRIM] center=${centerId} before=[${[...w.data.keys()].join(',')}] ` +
        `after=[${out.join(',')}] dropped=${droppedIds.length}` +
        `${droppedIds.length ? ` droppedIds=[${droppedIds.join(',')}]` : ''} ` +
        `retainRequested=[${[...retainIds].join(',')}]`,
    );
  }
  const data = new Map<string, T>();
  for (const [id, v] of w.data) {
    if (keep.has(id)) {
      data.set(id, v);
    }
  }
  const inflight = new Set<string>();
  for (const id of w.inflight) {
    if (keep.has(id)) {
      inflight.add(id);
    }
  }
  return { centerId, data, inflight };
}

/**
 * 按**行数预算**求「应当保留的章 id 集合」（渲染序邻域，中心必留）。
 *
 * 存在理由（2026-10-08 真机实证，根因级）：
 * 跨章提交曾固定保留 `{prev, cur, next}` 三章。短章书上三章的行数可能
 * **少于一屏**（道德经每章约 6 行 ⇒ 三章 ≈ 18 行 < 一屏 ≈ 22 行）⇒ 裁剪后
 * `contentH < viewportH` ⇒ **原生 `maxScroll = 0`，滚动位置被原生钳到 0**。
 * 真机表现为「下滚中突然跳回窗口顶部 + 章节栏回跳 + 露出『上一章加载中…』
 * 占位」。探针实测该瞬间 `prevLen=103 → nextLen=18`、锚行下标 62 → 7、
 * 补偿 `delta=-1595`（记账 target=252，算式正确），但随后原生 `y=0`
 * ⇒ **不是补偿算错，而是「内容比视口还高」这一几何前提被裁剪破坏**。
 * ⇒ 保留集必须按行数预算取（≥ 数屏），保证任何一次裁剪后 `contentH` 都远
 * 大于 `viewportH`，补偿才有意义。
 *
 * 算法：**先无条件保中心两侧各一章（离散下限）**，再从该初始集向两侧交替扩张
 * （优先扩张跨度较小的一侧），累加 `lineCountOf`，直到累计 ≥ `budgetLines` 或链耗尽。
 * 取不到行数的章按 0 计 ⇒ 只会多留不会少留。
 *
 * ## ★★ 离散三章下限：为什么有它，以及它的**真实效果**（2026-10-14 A6/B2 两轮实测）
 *
 * 行数预算是**量纲相关**的量：它在短章书上生效（10-08 根因：固定三章 ≈ 18 行 <
 * 一屏 22 行 ⇒ 原生 `maxScroll=0`），在长章书上不生效（单章行数 ≫
 * `budget = 6×lpp = 78 行` ⇒ 扩张循环一次都不执行 ⇒ 保留集只剩离散三章）。
 *
 * 最初写的理由（**已被 B2 实测推翻，勿再照抄**）：
 * ```
 * ~~退化的后果是自造 prepend：跨章 A → B ⇒ windowRecenter 只留 B ⇒ A 出门
 *   ⇒ needPrev = (loadedChapters[0] === activeChapterId) 恒真 ⇒ 又补回 A = prepend~~
 * ```
 * ★★ B2 真机读数：`chainEqActive` 在**加下限之前那一版就已经是 false**
 *   （那一版 `keep=2`，覆盖集已保住前章）⇒ 「退化 ⇒ 链首==锚章 ⇒ needPrev 恒真」
 *   **这条根因在本载体上从来没成立过**。真正让 needPrev 为真的是
 *   `handleScrollCommit` 里**无条件**的 `fillNeighborsRef.current({forcePrev:true})`。
 *   我在同一份分析里既写「不靠 forcePrev 也会补」又写「forcePrev 是正常预取」，
 *   两句自相矛盾，**真机读数站在前者的反面**。
 *
 * ⇒ 所以这个下限**不是治 prepend 的药**：A/B 同起点对照，两臂都出 prepend 且量级相当
 *   （A 臂无下限 err=795；B 臂三章下限 err=952）。它保留的理由降级为下面两条：
 *   ① 它是**离散、与行数量纲无关**的下限，不受 cpl/lpp 随机型漂移影响；
 *   ② 未水合的相邻章照样保留，0 行的章不占位 ⇒ 不改变任何几何量。
 *   ③ 短章书仍靠**行数预算**兜底（否则 contentH < viewportH ⇒ 原生 maxScroll=0）。
 *   ⇒ 两者互补，但**都别当成 prepend 的修复**。
 *
 * ★ 下限刻意**不看行数**：若挂上行数条件（「为 0 则不保」），未水合的相邻章会被丢出门
 *   → 重新水合 → 又是一次 prepend，恰好在最需要它的时候失效。
 */
export function retainIdsByBudget(
  centerId: string,
  order: readonly string[],
  lineCountOf: (id: string) => number,
  budgetLines: number,
): Set<string> {
  const keep = new Set<string>([centerId]);
  const idx = order.indexOf(centerId);
  if (idx < 0) {
    return keep;
  }
  // ── 离散下限：中心两侧各一章（存在才保）。与行数量纲无关，见上方「为什么必须先有」
  let lo = idx > 0 ? idx - 1 : idx;
  let hi = idx < order.length - 1 ? idx + 1 : idx;
  for (let i = lo; i <= hi; i += 1) {
    keep.add(order[i]);
  }
  // ★ acc 从初始集起算（不是从中心章起算）——否则会重复累加已在 keep 里的章，
  //   使扩张提前退出、保留集小于预算所承诺的行数。
  let acc = 0;
  for (let i = lo; i <= hi; i += 1) {
    acc += Math.max(0, lineCountOf(order[i]));
  }
  while (acc < budgetLines && (lo > 0 || hi < order.length - 1)) {
    const atRightEnd = hi >= order.length - 1;
    const atLeftEnd = lo <= 0;
    const leftSpan = idx - lo;
    const rightSpan = hi - idx;
    const goLeft = !atLeftEnd && (atRightEnd || leftSpan <= rightSpan);
    if (goLeft) {
      lo -= 1;
      keep.add(order[lo]);
      acc += Math.max(0, lineCountOf(order[lo]));
    } else {
      hi += 1;
      keep.add(order[hi]);
      acc += Math.max(0, lineCountOf(order[hi]));
    }
  }
  return keep;
}

/**
 * 渲染序中与行区间 `[rangeStart, rangeEnd)` **相交**的章（纯几何判定，无中心语义）。
 *
 * ## 为什么要单独导出（2026-10-14 第二次自纠的延续）
 *
 * 本函数是「视口覆盖」这条约束的全部实现。它原先内嵌在 `retainIdsForViewport` 里，
 * 而那个函数的**基础集已含离散三章下限**（相邻章无条件保留）⇒ 任何「视口没覆盖到
 * 相邻章」的样本，其 `has(相邻章)` 恒为 `true`（被下限兜住）⇒ **区间相交判定的
 * 专属鉴别样本（边界切章界、末端恰落界）全部失去鉴别力**（变异 M5「视口少算几行」/
 * M6「只判 start 不判 end」会重新零红 —— 条目 91①：前置条件遮蔽后置判定）。
 *
 * ⇒ 把几何判定抽成独立纯函数：边界样本直接测它（无下限干扰），
 *   `retainIdsForViewport` 只负责「并集」语义。**抽的是同一份实现，不是复制。**
 *
 * ## 不变式
 *
 * 1. 行数前缀和累计口径**必须与 `buildStitchedLines` 逐行一致**（未就绪的章按 0 行、
 *    不占位）—— 否则覆盖判定会整体偏移；
 * 2. 判定是**区间相交**（`start < rangeEnd && end > rangeStart`），不是「只看起点」：
 *    视口左界恰切章界时前一章**不得**被保（它在视口右边），视口末端恰落界时
 *    下一章**不得**被保（在视口左边）；
 * 3. 行数为 0（未就绪）的章不占位 ⇒ 永不相交 ⇒ 不会被返回；
 * 4. `rangeStart >= rangeEnd`（空区间）⇒ 返回空。
 *
 * @param order 渲染序（含锚章的最长已装载连续章链）
 * @param lineCountOf 章 → 行数；取不到按 0（与拼接层同口径）
 * @param rangeStart 行区间左端（闭）
 * @param rangeEnd 行区间右端（开）
 */
export function chaptersInRowRange(
  order: readonly string[],
  lineCountOf: (id: string) => number,
  rangeStart: number,
  rangeEnd: number,
): string[] {
  const lo = Math.max(0, Math.floor(rangeStart));
  const hi = Math.floor(rangeEnd);
  if (!(hi > lo)) {
    return [];
  }
  const out: string[] = [];
  // 前缀和：与 buildStitchedLines 同口径累计（未就绪的章记 0 行、不占位）
  let acc = 0;
  for (const id of order) {
    const start = acc;
    const count = Math.max(0, lineCountOf(id));
    acc += count;
    if (count <= 0) {
      continue; // 未就绪的章不占行 ⇒ 永不相交（不返回）
    }
    const end = start + count;
    // 区间相交（含「视口恰好落在本章最后一行的边界」这一常见情形）
    if (start < hi && end > lo) {
      out.push(id);
    }
  }
  return out;
}

/**
 * 滚动跨章提交的保留集：**行数预算 ∪ 覆盖区间（视口 + 上方余量）触及的章**
 *
 * ⚠⚠ **本函数整体已被真机判决为「无效」（2026-10-14 A6 / B2 两轮），代码暂留未删。**
 *   下方「真机读数」「枢纽」「为什么覆盖区间必须含上方余量」三段记录的是**当时**的
 *   推理与算例（其中两条结论已被自己的后一轮实测推翻，已就地标注）。
 *   **不要把这里的算例当依据引用**；载体与量级见 `ReaderScreen.retainForScrollCommit`
 *   注释里的「当前内置书载体的真实量级」表。
 *
 * ## ⚠ 真机读数 —— 载体已被删除，读数只作历史留档
 *
 * 载体 = 161MB epub / 980 章（**已被 `pm clear` 删除，`/sdcard` 无源文件，不可恢复**）。
 * 当日按方向拆分：
 * - **append**（新章追加在后面）6 次，anchorIdx 全部不变、delta 全部 0
 * - **prepend**（章插到上面）9 次，delta = 229–305 行
 *
 * ⇒ 闪烁 100% 来自 prepend，append 不贡献 delta —— **这一条仍成立**。
 *
 * ## 链条
 *
 * ```
 * 跨章 A → B（B 在 A 下面，来源：视口顶行跨过章界）
 *   ├─ windowRecenter(win, B, retain)     ← A 若不在 retain 里就出门
 *   └─ fillNeighbors(...)                 ← 又把 A 补回来，插在 B 上方 = prepend
 * ```
 *
 * ★★ 「不删 forcePrev 也照样发生」这个说法**已被 B2 实测推翻**：
 *   当时据「A 被裁后 `loadedChapters[0]` 就是 B、`activeChapterId` 也是 B ⇒ 判据恒真」
 *   推出「不靠 forcePrev 也会补」。但 B2 实测 `chainEqActive` 在**加下限之前那一版
 *   就已经是 false** ⇒ 该判据**没有恒真** ⇒ 真正让 needPrev 为真的是
 *   `handleScrollCommit` 里**无条件**的 `fillNeighborsRef.current({forcePrev:true})`。
 *   ⇒ 「所以修法不是删 forcePrev」这个结论也随之失效：现在看，**forcePrev 正是杠杆**。
 *   ⚠ 但**不能简单删**它 —— 源码注释已写明删了会一路向前装载整本书；改法待定，
 *     下一版方向见 `deliverables/flick-fixB2-2026-10-14/README.md`。
 *
 * ## 枢纽：长章书上预算不生效（量级已按当前载体重测）
 *
 * `budget = SCROLL_WINDOW_KEEP_SCREENS(6) × lpp`。**长章书**上单章行数 ≫ budget ⇒
 * `while (acc < budget)` 一次都不执行 ⇒ 预算集只剩离散三章。
 * ★ 旧文字写「该书单章行数中位 133 > 78 ⇒ 保留集退化为 `{中心章}`」——
 *   133 是**那本已丢失的 epub** 的读数，不是本仓量级常数；当前 77 本内置书实测
 *   （cpl ∈ [10,20]）见 `ReaderScreen` 注释的量级表：跨书中位 52–96，
 *   `tongjian` p50 723–1134、短章书 p50 ≤ 16 ⇒ **双峰分布，没有中间态**。
 * ⚠ 「调 `SCROLL_WINDOW_KEEP_SCREENS` 是碰运气」这句在长章书上依然成立
 *   （单章 ≫ 任何屏数），但**短章书上预算恰恰是必需的** ⇒ 不能一概而论。
 *
 * ## ★覆盖区间的「上方余量」：第一版无效是真事实，但**加了余量也没治好**
 *
 * 第一版把保留集定义为「**视口**覆盖的章」。它无效，这个算例成立（用的是合成行区间，
 * 不依赖任何已丢失载体）：
 * ```
 * A = [0,134)  B = [134,335)
 * 跨章提交瞬间：ownerLine 已是 B ⇒ 视口顶行 top = 134 ⇒ 视口 = [134,147)
 * ⇒ 视口全部落在 B 内 ⇒ A 与视口不相交 ⇒ A 不被保留
 * ```
 * ⇒ 跨章提交那一刻视口里确实已经没有旧章的行，但「已经滚过去」不等于「可以立刻丢」。
 *
 * ⚠⚠ **但「余量 ≥1 屏 ⇒ A 被保留 ⇒ delta = 0」是错的**（2026-10-14 B2 实测）：
 *   余量从 1 屏加到 6 屏，A/B 同起点对照两臂**都出 prepend 且量级相当**
 *   （无下限 err=795 / 三章下限 err=952）⇒ 余量大小**不是**杠杆，
 *   杠杆在 `forcePrev`。上面那句「⇒ delta = 0」只在小样本里成立过一次，
 *   **不足以支撑「这一版修好了」**。
 * ⇒ 上方余量参数目前只是「不引入新量纲」的占位，**不要再靠调它治病**。
 *
 * ## 语义
 *
 * - 基础集 = `retainIdsByBudget(...)`（**逐字沿用** ⇒ 短章书行为零变化）
 * - 追加集 = 与行区间 `[topLineIndex − leadRows, topLineIndex + viewportRows)` **相交**的章
 * - 两者并集；中心章恒保留（由 `retainIdsByBudget` 保证）
 *
 * ★ 为什么按覆盖区间而不是「无条件保 prev」：`getSiblingChapters(prev)` 的邻接关系
 * 在章被裁掉后**依然成立**（关系在书序里，不在窗口里）⇒ 按 prev 判会退化成「无脑保
 * 上一章」，而覆盖区间根本没触及它时保它就是纯浪费。
 *
 * ## 不变式
 *
 * 1. 返回集恒含 `centerId`；
 * 2. 返回集 ⊇ 覆盖区间触及的所有章；
 * 3. `topLineIndex` 越界 / 非有限 / `viewportRows <= 0` ⇒ **退回纯预算集，不猜**。
 *    ★ 方向是「不多留」：几何不可信时多留虽安全，但会让本函数在每次几何抖动时改变
 *    保留集 ⇒ 裁窗行为不可预测 ⇒ 比少留更难排查；
 * 4. 行数前缀和的累计口径**必须与 `buildStitchedLines` 逐行一致**（未就绪的章按 0 行、
 *    不占位），否则覆盖判定会整体偏移。
 *
 * @param centerId 当前提交的中心章
 * @param order 渲染序（含锚章的最长已装载连续章链）
 * @param lineCountOf 章 → 该章行数；取不到按 0（与拼接层同口径：未就绪的章不进序列）
 * @param topLineIndex 视口顶行在**拼接序列**中的全局下标；负或 ≥总行数 ⇒ 几何未就绪
 * @param viewportRows 视口可见行数（一屏 = `floor(viewportH / rowHeight)`）
 * @param budgetLines 行数预算（短章书按它扩张；长章书上它失效，由覆盖约束兜底）
 * @param leadRows 视口上方的保留余量（行）。**跨章场景必须 ≥1 屏**，否则旧章
 *        「视口内无行 ⇒ 不被保留 ⇒ 立刻被补回 ⇒ 自造 prepend 照旧」（见上方推导）。
 *        默认 0 ＝纯视口语义（只保屏内可见的章，供非跨章调用方使用）。
 */
export function retainIdsForViewport(
  centerId: string,
  order: readonly string[],
  lineCountOf: (id: string) => number,
  topLineIndex: number,
  viewportRows: number,
  budgetLines: number,
  leadRows = 0,
): Set<string> {
  const base = retainIdsByBudget(centerId, order, lineCountOf, budgetLines);
  // ── 几何不可信 ⇒ 纯预算集（不猜视口覆盖）
  if (!(viewportRows > 0) || !Number.isFinite(topLineIndex)) {
    return base;
  }
  // 总行数（前缀和口径与 buildStitchedLines 一致）
  let totalLines = 0;
  for (const id of order) {
    totalLines += Math.max(0, lineCountOf(id));
  }
  // ★ 越界（条目 91①：越界样本必须显式构造，否则报出来的是别的成因）
  if (topLineIndex < 0 || topLineIndex >= totalLines) {
    return base;
  }
  // 覆盖区间 = [顶行 − 上方余量, 视口底)
  const coverStart = Math.max(0, topLineIndex - Math.max(0, Math.floor(leadRows)));
  const coverEnd = Math.min(totalLines, topLineIndex + Math.floor(viewportRows));
  // ★ 几何判定本身已抽成 chaptersInRowRange（否则三章下限会遮蔽它的边界鉴别力）
  for (const id of chaptersInRowRange(order, lineCountOf, coverStart, coverEnd)) {
    base.add(id);
  }
  return base;
}

/**
 * ★★ V4（2026-10-14）：跨章提交时`fillNeighbors` 的 `forcePrev` 该不该置位。
 *
 * ## 为什么要抽成纯函数（不是直接写 `scrollDirRef.current < 0`）
 *
 * 初版把条件内联在 `handleScrollCommit` 里，判据只能做**源码文本形状锁**。实测：
 * ```
 * M1 forcePrev 改回无条件 true   ⇒ 红 1条✔（形状锁有鉴别力）
 * M2 方向接反（< 0 写成 > 0）    ⇒ 零红 ✘
 * M3 死常量（&& false）           ⇒ 零红 ✘
 * ```
 * ⇒ 形状锁**只会匹配文本、求不了值**（条目 109/114：变异点在哪一层，判据就得走
 * 哪一层）⇒ 把「方向 → 是否补 prev」这个决策下沉成纯函数，判据**直测函数值**，
 * M2/M3 立刻可红。
 *
 * ## 语义（正负号约定与 `ScrollMode.onScrollDirChange` 一致）
 * - `dir < 0` 用户在**往上滚** ⇒ 上方内容会被看到 ⇒ **补 prev**
 * - `dir > 0` 往下滚 ⇒ 上方内容已在视口内 ⇒ **不补 prev**（补了就是 prepend）
 * - `dir === 0` 未滚过（首屏）⇒ **不补**：首屏的「链首==锚章」由 `fillNeighbors`
 *   自己的 `needPrev` OR 分支负责，本函数不承担（否则首屏就自造 prepend）。
 *
 * ## ⚠⚠⚠ 本函数已**退役**（2026-10-14 V8 真机判决，**保留仅为可追溯**）
 *
 * V4 曾用它驱动 `handleScrollCommit` 的 `forcePrev`；V8 真机判决证明：
 * **只要「补的章」不在 `win.data` 里，补装就必然落链首 = prepend**，
 * 与「补装时机」无关。上滚方向**无论补不补、什么时候补**都闪
 * （除非那一章的 data 早就在窗内，而长章书 IO 实测 6.5 s 做不到）。
 * ⇒ 生产侧已改为 `forcePrev: false`；本函数**当前无生产调用方**。
 * ★**别把它当可用杠杆重新接上**——真机已判决该方向无效（读数见
 *   `deliverables/jump-flick-2026-10-14/jump-v8-run.log`）。
 *
 * @param scrollDir 滚动方向：+1 向下 / -1 向上 / 0 未滚过
 */
export function shouldFillPrevOnCommit(scrollDir: number): boolean {
  return scrollDir < 0;
}
