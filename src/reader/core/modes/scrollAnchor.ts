/**
 * 滚动模式「视口锚点 / 头部占位 / 行下标」纯算式（零 RN 依赖，可单测）。
 *
 * 存在理由（2026-10-08 真机实证，两条独立缺陷）：
 *
 * ① **头部占位必须计入 getItemLayout**。ScrollMode 的 `ListHeaderComponent`
 *    （章界提示条）在原生里排在第一个 item 之上，是 content 的一部分；而 RN
 *    的 `ListMetricsAggregator.getCellMetrics` 对已提供 `getItemLayout` 的列表
 *    **直接返回 `getItemLayout` 给出的 offset，不做任何头部补偿**
 *    （node_modules/@react-native/virtualized-lists/Lists/ListMetricsAggregator.js
 *    L211-233）。占位曾是整屏 `viewportH`（≈2254px）⇒ `initialScrollIndex`
 *    与所有 `onScroll` 的 y→行号 换算整体偏一个整屏：真机复现为
 *    「打开第十六章 → 屏上是第十四章正文 + 满屏『加载中…』，顶栏却写第十六章」。
 *    ⇒ 本模块把 `headerHeight` 显式带进每一处换算。
 *
 * ② **窗口前插/前删会搬动全部行下标**，而原生 contentOffset 不会自己跟着变 ⇒
 *    视口跳到位移前的位置（上滚跨章时表现为「倒退两点几章 + 空白」）。
 *    `stitch.compensationDelta` 按**章序**算补偿量，需要调用方持有全部章的
 *    lineCount（含已丢弃章）才能算对；滚动模式的视口锚点是**行**，按行 key
 *    求新下标更直接且天然对「前插 / 前删 / 追加 / 章内重排」成立。
 */

/** 参与锚点键计算的最小行形状（Line 的结构子集） */
export interface AnchorLineLike {
  readonly isTitle?: boolean;
  readonly chapterId: string;
  readonly segmentId: string;
  readonly charStart: number;
}

/**
 * 行身份键。与 ScrollMode 的 keyExtractor 同式（(章, 段, 段内码点)；
 * 标题行特判）——两处必须同源，否则锚点在数据变更后找不到自己。
 */
export function lineKeyOf(line: AnchorLineLike): string {
  return line.isTitle
    ? `${line.chapterId}#title`
    : `${line.chapterId}#${line.segmentId}#${line.charStart}`;
}

/** 锚行在行序列中的下标；不在序列中（被裁窗/换章）返回 -1 */
export function indexOfLineKey(
  lines: readonly AnchorLineLike[],
  key: string,
): number {
  for (let i = 0; i < lines.length; i++) {
    if (lineKeyOf(lines[i]) === key) {
      return i;
    }
  }
  return -1;
}

/**
 * 内容 y（含头部占位）→ 行下标。
 * 越界钳到 `[0, lineCount-1]`；`lineCount === 0` 返回 0。
 * ★ 负 y（落在头部占位里）钳到 0——占位区的触摸由调用方另行判「空白」。
 */
export function lineIndexAtContentY(
  y: number,
  headerHeight: number,
  rowHeight: number,
  lineCount: number,
): number {
  if (lineCount <= 0) {
    return 0;
  }
  const row = Math.max(1, rowHeight);
  const raw = Math.floor((y - headerHeight) / row);
  return Math.min(Math.max(raw, 0), lineCount - 1);
}

/**
 * 章归属行下标 = 几何顶行 + 1，钳到末行。
 *
 * 存在理由（2026-10-09 真机实证，两端观测面互证）：
 * 黑盒轨迹——跳《荀子·致士》后顶栏持续显示上一章『臣道』35s，而屏上正文顶行
 * 确为『致士』；探针序列——挂载锚定 `idx=150 / offRef=6794`，1.79s 后原生回传
 * `y=6794`，`floor((6794−44)/45)` 却得 **149**（落点比 `contentYOfLineIndex(150)`
 * 略小零点几像素）⇒ 顶行被判成上一章末行 ⇒ `onChapterCommit('臣道')`。
 *
 * ⇒ 结论：**用「视口顶行」判章归属，对不到一行的落点误差零容差**，且该误差只在
 *   章边界处才改变归属（章内 ±1 行同章）⇒ 缺陷只在「落章首」时可见；一旦写错
 *   `committedRef`，视口不再移动就不会有下一次提交 ⇒ 永不自愈。
 *
 * 解法是**几何与归属解耦**：几何（锚点 / 补偿 / 翻屏）继续用精确 `idx`，只有
 * 「章归属 + 进度记账」用 `idx+1`。切换点因此整体下移一行：向下滚过章界时提早
 * 一行切章（≈45px，肉眼不可辨），向上滚回时迟一行切章（同样不可辨）。
 */
export function chapterOwnerIndex(topLineIndex: number, lineCount: number): number {
  if (lineCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(topLineIndex + 1, 0), lineCount - 1);
}

/**
 * 补偿目标 → 原生**实落点**（px）。`maxScroll = contentHeight − viewportHeight`。
 *
 * 存在理由（2026-10-09 真机实证）：补偿目标按「锚行位移」算，可能超过当前原生的
 * `maxScroll`（内容尚未长到目标所需高度）⇒ 原生**钳制**落点；而旧实现把
 * `offsetRef` 记成**意图值** ⇒ 与实落点的偏差永久带入下一次补偿的基线。
 *
 * ★ `contentHeight <= 0`（首次投递、或内容高尚未对应当前数据）⇒ **不钳制**，
 *   交由随后的 `onContentSizeChange` 复投收敛；此处提前钳到 0 会把补偿整段吞掉，
 *   或（更糟）拿**旧数据**的内容高把新目标错误降级。
 */
export function clampScrollTarget(
  target: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const t = Math.max(0, target);
  // ★★ RB4-PROBE（可移除）：钳制的入参/出参/是否被钳。
  //   动机：实测出现「补偿按 contentH=46288 投出 target=23444，1.8s 后裁窗令
  //   contentH 降到 35738」⇒ 需判定当时 target 是否**已超出新的可滚动上限**。
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const clamped = t > maxScroll;
  console.info(
    `[RB4][CLAMP] target=${Math.round(t)} contentH=${Math.round(contentHeight)} ` +
      `viewportH=${Math.round(viewportHeight)} maxScroll=${Math.round(maxScroll)} ` +
      `⇒${clamped ? `★被钳 ${Math.round(t - maxScroll)}px` : '未钳'}`,
  );
  if (!(contentHeight > 0)) {
    return t;
  }
  return Math.min(t, maxScroll);
}

/**
 * 视口顶行 → **章归属行下标**；几何不可信时返回 `null`（调用方**不得**提交/记账）。
 *
 * 这是 `chapterOwnerIndex` 的**严格版**，把两个独立机理一起堵住：
 *
 * ① **亚像素落点误差**（2026-10-09 探针实测）：挂载锚定 `idx=150 / offRef=6794`，
 *    1.79s 后原生回传 `y=6794`，而 `floor((6794−44)/45) = 149`（落点比
 *    `contentYOfLineIndex(150)` 略小零点几像素）⇒ 顶行判成**上一章末行** ⇒ 顶栏错章。
 *    ⇒ 归属行取 `idx + 1`。
 *
 * ② **越界钳制**（2026-10-09 干净包复现，`body_n=0` 后顶栏变上一章）：
 *    跳章后**装配空窗期**，`lines` 只含刚并入的上一章，而原生 `y` 仍指向目标章
 *    （尚未布局到那个高度）⇒ `lineIndexAtContentY` 把 y **钳到 `lineCount-1`**
 *    ⇒ 末行属于上一章 ⇒ 提交上一章，且此后视口不再移动 ⇒ 永不自愈。
 *    ⚠ 与 ① 反向：`+1` 对钳制**无效**（`min(idx+1, len-1)` 仍等于 `len-1`）。
 *    ⇒ 一旦发生钳制（`raw > lineCount-1`），几何前提不成立，**必须返回 null**
 *      放弃本次归属提交，等数据装齐后由下一次 onScroll 正常判定。
 *
 * 返回 null 的三种情形：`lineCount<=0`（无数据）／`raw < 0`（落在头部占位里）／
 * `raw > lineCount-1`（**越界钳制**）。
 */
export function viewportOwnerIndexAtContentY(
  y: number,
  headerHeight: number,
  rowHeight: number,
  lineCount: number,
): number | null {
  if (lineCount <= 0) {
    return null;
  }
  const row = Math.max(1, rowHeight);
  const raw = Math.floor((y - headerHeight) / row);
  if (raw < 0 || raw > lineCount - 1) {
    return null;
  }
  return chapterOwnerIndex(raw, lineCount);
}

/** 行下标 → 内容 y（含头部占位）。getItemLayout 的 offset 同式。 */
export function contentYOfLineIndex(
  index: number,
  headerHeight: number,
  rowHeight: number,
): number {
  return headerHeight + Math.max(0, index) * Math.max(1, rowHeight);
}

/**
 * 数据变更所需的滚动补偿量（px）= 锚行新下标 − 旧下标 的位移 × 行高
 * + 头部占位高度差（占位显隐同样会整体搬动内容）。
 *
 * 正值 ⇒ 锚行被下推（上方插入了章）⇒ `scrollToOffset(当前 offset + Δ)` 维持视觉位置；
 * 负值 ⇒ 锚行被上提（上方删除了章）⇒ 同式（减）。
 * 锚行任一侧缺失（`prevIndex < 0` 或 `nextIndex < 0`）⇒ 返回 0（退化，不补偿）。
 */
export function anchorCompensationDelta(
  prevIndex: number,
  nextIndex: number,
  rowHeight: number,
  prevHeaderHeight: number,
  nextHeaderHeight: number,
): number {
  if (prevIndex < 0 || nextIndex < 0) {
    return 0;
  }
  return (
    (nextIndex - prevIndex) * Math.max(1, rowHeight) +
    (nextHeaderHeight - prevHeaderHeight)
  );
}

/**
 /**
 * ★ 补偿投递的**内容高权威性闸门**（2026-10-12 真机闪烁读数 `flick2.log` 判决性四行）：
 * ```
 * 15:20:25.175 APPLY target=42991 from=29691 d=+13300   ← 投递
 * 15:20:25.200 JUMP  y=30194  d=-12797                 ← 25ms 后原生只走到 30194（仅 +503px）
 * 15:20:25.200 APPLY from=30194 d=+12797                ← 同毫秒复投
 * 15:20:25.578 JUMP  y=43299                            ← 403ms 后才真正到位
 * ```
 * ⇒ 残余闪烁**不是往返投递**（往返已被 `shouldDeliverCompensation` 拦掉），而是
 *   「**首投投了一个此刻原生够不着的目标**」：原生当时的 `maxScroll` 只有 30194
 *   （内容高仍是**旧数据**的），投递 42991 被原生钳到 30194 ⇒ 画面停在中间位
 *   **403ms** ⇒ 肉眼读作「闪一下」。
 *
 * 旧实现把「内容高不新鲜」处理成 `ch = 0` ⇒ `clampScrollTarget` 不钳制 ⇒ **照投**
 * （见 `ScrollMode.tsx` 的 `applyCompensation`）。这是对「未知」的误读：「未知」的
 * 正确含义是「**无法保证目标可达 ⇒ 本次不投**」，等 `onContentSizeChange` 带来与
 * 当前数据对应的高度后再投；而不是「原样投出去让原生钳」。
 *
 * ★ 双向理由（不只「变高」这一种）：
 *   · 数据**变高**（窗口前插）：陈旧高度 < 真实高度 ⇒ 目标超出陈旧 `maxScroll`
 *     ⇒ 被钳到中间位（上面读数）。
 *   · 数据**变矮**（窗口裁剪）：陈旧高度 > 真实高度 ⇒ 目标虽在陈旧 `maxScroll`
 *     之内，原生仍会按**真实**高度钳一次 ⇒ 同样停在中间位。
 *   ⇒ 无论方向，只要高度不权威就**不投**，两个方向的闪烁一起堵住。
 *
 * ★ 为什么不会死锁（`false` 时谁来投）：
 *   `lines.length` 变化 ⇒ `getItemLayout` 给出的内容高必变 ⇒ 原生**必然**派发
 *   `onContentSizeChange`；该回调把 `recordedLines` 置为当前长度（转为权威）后再调
 *   `applyCompensation` ⇒ 目标仍由 `compTargetRef` 保留，不会丢。另有
 *   `scheduleCompRetry` 的定时续投兜底（250ms 节拍，上限 8 次）。
 *
 * @param recordedLines 最近一次 `onContentSizeChange` 到达时的 `lines.length`
 *                      （`-1` = 从未收到过）
 * @param currentLines 当前数据长度
 * @returns true = 内容高与当前数据对应，可安全投递
 */
export function hasAuthoritativeContentHeight(
  recordedLines: number,
  currentLines: number,
): boolean {
  // ⚠ `recordedLines >= 0` 是**哨兵值判据**，不是「不可能发生的分支」：
  //   `-1` = 「从未收到过 onContentSizeChange」（见 ScrollMode 的 `contentLinesRef`
  //   初值）。若只比相等，`(-1, -1)` 会被判成「权威」——那正是「拿从没有过的高度
  //   当真值」。`currentLines` 恒 ≥ 0（数组长度），故这一个不等式即可挡住哨兵。
  return (
    Number.isFinite(recordedLines) && recordedLines >= 0 && recordedLines === currentLines
  );
}

/**
 * ★ 单向逼近守卫：这次补偿投递是否**应该**执行（2026-10-12 真机闪烁读数 `flick2.log`）。
 *
 * 背景（判决性读数，初载场景）：
 * ```
 * APPLY  target=26594 from=11244 d=+15350   ← 首投（正确）
 * APPLY  target=26594 from=26594 d=0        ← 冗余重投（零位移）
 * JUMP   y=12316 d=-14277                   ← 原生首投被静默丢弃/钳制到中间位
 * JUMP   y=26594 d=+14277                   ← 复投把它拽回目标
 * ```
 * 首投与复投之间隔 119 ms（跨章场景 378 ms），期间画面停在 12316 ——
 * 与目标差 14277 px。肉眼读作「闪一下」。
 *
 * 跨章场景更严重：`flick2.log` 实录**三轮往返**
 * （+13300 → −12797 → +12797 → +308 → −308）。
 *
 * ⚠ **归因修正（2026-10-12，同一批读数）**：上面把闪烁归因为「往返投递」是**不完整**的。
 *   本守卫只拦「重复/反向的**后续**投递」；真正的**首投**被原生钳到中间位（因为内容高
 *   陈旧 ⇒ 目标此刻不可达），本守卫对此**无能为力**——首投时 `current` 就是当前真实
 *   offset，`real` 是目标，误差只会变小 ⇒ 规则②必然放行。⇒ 首投那一段的错位窗口由
 *   `hasAuthoritativeContentHeight` 堵（先判权威性，再谈本守卫）。
 * ⇒ 每次闪烁的本质都是「正向 → 反向 → 正向」的往返。
 *
 * 本守卫三条规则，**任一命中即跳过本次投递**：
 * ⓪ **内容高不权威**（2026-10-12 新增，见 `hasAuthoritativeContentHeight`）：
 *   `recordedLines !== currentLines` ⇒ 目标此刻**不可达**，投了必被原生钳到中间位。
 * ① **已到位**：`|real - current| <= tolerance` ⇒ 再投零位移，纯冗余（上面第 2 条）。
 * ② **反向**：`|real - current| > |target - current|` ⇒ 这次投递让误差**变大**。
 *
 * ★ 规则①②只拦「比现状更差」的**后续**投递，**不拦首次投递**（`current` 初值即当前
 *   真实 offset，首投的 `|real-current|` 就是它要走的距离，必然 ≤ `|target-current|`
 *   的旧值…实际上首投时 current=11244、real=26594，误差**变小** ⇒ 规则②放行）。
 *   ⇒ 规则⓪ 才是首投那一段错位窗口的真正闸门。
 *
 * @param current 当前真实 offset（px）
 * @param target 本次意图目标（未钳制）
 * @param real 钳制后的实际落点（`clampScrollTarget` 的返回值）
 * @param tolerance 落定容差（通常传 `rowH`）
 * @param authoritativeLines 最近一次 `onContentSizeChange` 到达时的 `lines.length`
 * @param currentLines 当前数据长度
 * @returns true = 应当投递；false = 跳过（本次投递对画面无益或有害）
 */
export function shouldDeliverCompensation(
  current: number,
  target: number,
  real: number,
  tolerance: number,
  authoritativeLines: number,
  currentLines: number,
): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(real)) {
    return false;
  }
  // ★ 规则⓪：内容高不权威 ⇒ 本次不投。放最前面：本函数只拿到像素值，
  //   无法自己判断「这个目标此刻是否可达」。
  if (!hasAuthoritativeContentHeight(authoritativeLines, currentLines)) {
    return false;
  }
  const move = Math.abs(real - current);
  if (move <= Math.max(0, tolerance)) {
    return false; // 规则①：已在落定容差内 ⇒ 零位移，冗余
  }
  const curErr = Math.abs(target - current);
  const newErr = Math.abs(target - real);
  if (newErr > curErr) {
    return false; // 规则②：误差变大 ⇒ 反向投递，画面会先错后对 ⇒ 闪
  }
  return true;
}
