/**
 * ScrollMode——原生 FlatList 连续滚动模式（ReaderCore 的 scroll 渲染策略）。
 *
 * 2026-09-29 重构：由「自绘连续画布 + translateY + 基址表 + PanResponder 手写手势」
 * 改为原生 FlatList 平铺滚动（与 PageMode 同族）。放弃 legado 式自绘滚动语义，
 * 手势/惯性/边界回弹交给系统；仅保留语义层：跨章提交、进度记账、边沿装载。
 *
 * 平铺数据 = stitched.lines（含章标题行，每行自带 chapterId / isTitle / charStart），
 * 直接作为 FlatList data；行高恒等 rowHeight（INV-G1）⇒ getItemLayout 纯算式定位。
 *
 * ── 2026-10-08 真机修复（三条独立缺陷，均由 ScrollMode 承担）──
 * ① **热区吞滚动手势**：左右 30% 的 `Pressable` 覆盖层与 FlatList 是**兄弟**，
 *    Android 不会把落在覆盖层上的触摸再交给 ScrollView ⇒ 只有中间 40% 能拖。
 *    修法：删除覆盖层，分区判定改挂 FlatList 自身 touch 事件（见 tapRegions.ts）。
 * ② **头部占位未计入 getItemLayout**：占位曾是整屏 viewportH，而 RN 的
 *    `ListMetricsAggregator.getCellMetrics` 直接取 getItemLayout 的 offset、不做
 *    头部补偿 ⇒ 打开任意非首章的书都会整体偏一个整屏（真机：打开第十六章，
 *    屏上是第十四章正文 + 满屏「加载中…」，顶栏却写第十六章）。修法：占位降为
 *    44dp 提示条，并把 headerHeight 显式带进每一处 y↔行号 换算（scrollAnchor.ts）。
 * ③ **窗口前插无补偿**：stitched.lines 前插一章会搬动全部行下标，原生 contentOffset
 *    不会跟着变 ⇒ 视口倒退。修法：锚点（视口顶行 key）跨数据变更求新下标，
 *    `scrollToOffset(offset + Δ)`；`onContentSizeChange` 复投（首次投递常被
 *    「旧内容高」钳制——内容比视口还短时 maxScroll=0，补偿会被吞掉）；
 *    补偿未落定期间抑制跨章记账（否则会用错位的 y 把进度覆写成更早的章）。
 *
 * ④ **开书首帧大片空白（2026-10-08 追加实证）**：数据窗口（stitched.lines）在开书
 *    后 ~0.35s 内从 5 行涨到 54 行（邻章陆续并入）。**首次交互之前**，原生不产生
 *    任何 onScroll（真机日志：4 次 `onContentSizeChange` h=233→842→1277→1654dp，
 *    期间 0 条 onScroll；首次 onScroll 出现在用户滑动时），VirtualizedList 拿不到
 *    可见长度 ⇒ 可见窗口停在 bootstrap 区间 ⇒ **只挂载了 mount 期那 5~7 行**
 *    （日志逐行统计：27 次 renderItem 全是 c18/c19，c20 以后一次都没渲染），
 *    其余行保留布局高度但不挂载 = 满屏空白、连页脚提示都不出现。用户手动滑一下
 *    即恢复（有 onScroll 后窗口增长都能正常挂载）。
 *    修法：开书首帧（未交互）窗口稳定后重挂载一次 FlatList（见 BOOT_SETTLE_MS），
 *    以新窗口重算可见区间并按锚行下标定位。
 *
 * ⑤ **点击一律不翻屏（2026-10-08 用户裁定，本批）**：左右 30% 分区的单击翻屏
 *    整体取消。连读场景里点按多用于「重新定位视线」，误触发翻屏会把读者甩出
 *    一屏且没有撤销手段。
 *    原实现拆成三个部件：①列表自身 touchEnd 补判空白区点按；②行内 press 时刻
 *    带 pageX 回问 `charTapIntercept` 抢在查字之前翻屏；③二者之间用
 *    `PRESS_CONSUMED_DEDUP_MS` 去重同一手势。三者是**同一个根因**（同一个「点」
 *    被赋予两种语义，只能靠时序/去重窗缝补），故**整体删除**——不留回退开关：
 *    留开关会造出「`charTapIntercept` 挂着空实现、行内 press 被静默吞掉」的
 *    中间态，且该开关在任何用例里都观察不到（铁律 3「回退开关名≠实」）。
 *    ★ 取消翻屏 ≠ 取消点按：行内点按（查字 / 查看划线）仍由 renderLine 承担
 *      （本组件不感知）；本组件取消的只是对点按的**翻屏解释**。
 *      「上下推进」改由原生滚动本身承担（连读模式下这才是它本来的语义）；
 *      PageMode / FlipMode 的整页翻页不受影响。
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import type { Line, LineGeometry } from '../../geometry';
import { getItemLayoutOf } from '../../geometry';
import type { BoundaryDirection } from '../types';
import {
  anchorCompensationDelta,
  clampScrollTarget,
  contentYOfLineIndex,
  indexOfLineKey,
  lineIndexAtContentY,
  lineKeyOf,
  shouldDeliverCompensation,
  viewportOwnerIndexAtContentY,
} from './scrollAnchor';

export interface ScrollModeProps {
  /** 平铺行流（stitched.lines，含章标题行；数组序=书序） */
  lines: readonly Line[];
  /** 书级边界（窗口外未载章方向） */
  hasMorePrev: boolean;
  hasMoreNext: boolean;
  /** 初始章 id（= activeChapterId；跨章提交起点） */
  initialChapterId: string;
  /** 挂载定位行下标（全局，stitched 序列；charOffset → 行号投影） */
  initialLineIndex: number;
  geometry: LineGeometry;
  viewportH: number;
  /**
   * 版心壳左右偏移（reader/contentLayout.ts 唯一真源）。
   * 作为 FlatList contentContainer 水平内边距 ⇒ 内容宽 = 视口宽 − left − right
   * **恒 = 行化 containerWidth**（同值 ⇒ 行化切出的整行字都能装下）。
   */
  contentInsets: { left: number; right: number };
  renderLine(line: Line): React.ReactNode;
  /** 跨章提交（跨章进度/预载回流） */
  onChapterCommit(chapterId: string, firstLine: Line | undefined): void;
  /** 滚动静止 → 进度上报（码点真值持久化） */
  onLineChange?(line: Line | undefined): void;
  /** 视口临近窗口已载边沿（未载方向）→ 上抛宿主续装邻章 */
  onNearBoundary?(dir: BoundaryDirection): void;
  /**
   * ★★ V3（2026-10-14）：用户滚动方向变化（+1 向下 / -1 向上）。
   * ReaderScreen 用它决定「邻章预取是否补 prev」—— 向下跨章时补 prev
   * 会把上一章插到锚章之上 = prepend = 整章位移闪烁（本仓三轮真机判决的闪烁真因）。
   */
  onScrollDirChange?(dir: number): void;
  /** 边沿邻章装载失败标记（仅改变占位文案，不阻断重试） */
  loadError?: { next?: boolean; prev?: boolean };
  /** 重挂载键（切模式/跳章触发全新列表） */
  listKey?: string;
  /**
   * ★★★ D1（2026-10-15）：**待跳转目标章 id**（scroll 模式去掉重挂载后的落位依据）。
   *
   * ★背景：`initialScrollIndex` 只在 FlatList **挂载**时生效。跳章若靠
   *   `listKey` 变化触发重挂载来落位，代价是 ~117 个带拼音 `TextView` 全部
   *   重建⇒ **1.4s 空窗**（真机：目标章 `emptyShell=false` 数据已就绪仍白屏）。
   * ⇒ 改为「不重挂载 + 数据就绪后显式 `scrollToOffset` 落位」。
   */
  jumpToChapterId?: string;
  /** 落位完成（宿主据此清 `pendingJumpTo`，否则会反复落位） */
  onJumpToSettled?: () => void;
  /**
   * ★ 各章首行在拼接序列里的**全局下标**（`stitched.firstLineOf`）。
   * ★D1 的跳章落位用它把「目标章」翻译成「行下标」——不能靠 `lines.findIndex`
   *   线性扫（每帧 O(n)），也不能靠锚点（跳章时锚行不存在 ⇒ 恒 -1）。
   */
  firstLineOf?: ReadonlyMap<string, number>;
}

/** 章界提示条高度（dp）。★ 旧值 = 视口高（整屏），见文件头 ②：占位高度直接
 *  决定 getItemLayout 的头部补偿量，整屏占位会把偏移算错一个整屏。 */
const BOUNDARY_HINT_H = 44;
/** 补偿抑制上限（ms）：超时强制解除，防「补偿永不落定 ⇒ 跨章记账被永久抑制」 */
const COMP_PENDING_MAX_MS = 500;
/**
 * 目标态化复投上限（次）：`onContentSizeChange` 每次带未落定目标时 +1，达上限即放弃。
 * ★ 用**次数**而非「内容高是否增长」作放弃判据（2026-10-09 真机实证）：跳章时
 *   `lines` 一步到位后 `contentH` 不再增长，用「未增长」判「不可达」会在第一次回调
 *   就丢弃补偿 ⇒ 原生把 `scrollTo(8900)` 截到 4316 ⇒ 顶栏错章（`b29_probe.log`）。
 */
const COMP_TARGET_MAX_RETRY = 8;
/**
 * 开书首帧「窗口稳定」去抖（ms）：数据窗口（stitched.lines）在开书后 0.3s 内会从
 * 数行涨到几十行，此期间原生尚未产生任何 onScroll ⇒ VirtualizedList 的可见窗口
 * 停在 bootstrap 区间（真机实证：只挂载了 mount 期的 5~7 行，其余行不挂载 ⇒ 屏幕
 * 大片空白，必须手动滑一次才出内容）。等窗口稳定后重挂载一次即可一次性解决。
 */
const BOOT_SETTLE_MS = 200;
/** 首帧重挂载最多尝试次数（防「数据永远在涨」时反复重挂载） */
const BOOT_MAX_REMOUNT = 4;

/** 章内页首若为标题行（stitch 注入 segmentId='__title__'），进度取首个正文行 */
function firstContentLineOf(lines: readonly Line[], startIdx: number): Line | undefined {
  for (let i = Math.max(0, startIdx); i < lines.length; i++) {
    if (!lines[i].isTitle) return lines[i];
  }
  return lines.length > 0 ? lines[0] : undefined;
}

/**
 * ★ 滚动事件的**空安全**读取（2026-10-12 真机崩溃实证）。
 *
 * 崩溃原文（logcat `E/AndroidRuntime`，release 包）：
 * ```
 * FATAL EXCEPTION: mqt_v_native
 * com.facebook.react.common.JavascriptException:
 *   TypeError: Cannot read property 'contentOffset' of null
 *     at anonymous@1:2066620        ← onScroll 的事件处理器
 * ```
 *
 * 机理：FlatList **换 key 重挂载 / 数据整体替换**的瞬间，旧 cell 已卸载而
 * 原生仍会把在途的滚动事件派发到 JS，此时 `nativeEvent` 为 `null`。
 * 原实现在 4 处直接写 `e.nativeEvent.contentOffset.y`（`onScroll` /
 * `handleScrollEnd` / `handleMomentumEnd` / `handleDragEnd`）
 * ⇒ 任意一处收到空事件即**整个 JS 线程抛异常 ⇒ 红屏/退出**。
 *
 * ⇒ 本函数是**唯一**读取口：读不到有限数值就返回 `null`，
 * 各调用点按「本次事件无意义」直接放行（不记账、不推进状态）。
 *
 * ⚠ 不可用 `e?.nativeEvent?.contentOffset?.y ?? 0` 兜底成 0：
 *   0 是**合法视口位置**，会把视口误判为跳到顶部并触发错误的跨章提交。
 *   必须区分「无事件」与「y=0」⇒ 返回 `null`。
 */
function scrollOffsetYOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') {
    return null;
  }
  const ne = (e as { nativeEvent?: unknown }).nativeEvent;
  if (!ne || typeof ne !== 'object') {
    return null;
  }
  const off = (ne as { contentOffset?: unknown }).contentOffset;
  if (!off || typeof off !== 'object') {
    return null;
  }
  const y = (off as { y?: unknown }).y;
  return typeof y === 'number' && Number.isFinite(y) ? y : null;
}

const ScrollMode = memo(function ScrollMode({
  lines,
  hasMorePrev,
  hasMoreNext,
  initialChapterId,
  initialLineIndex,
  geometry,
  viewportH,
  contentInsets,
  renderLine,
  onChapterCommit,
  onLineChange,
  onNearBoundary,
  onScrollDirChange,
  loadError,
  listKey,
  jumpToChapterId,
  onJumpToSettled,
  firstLineOf,
}: ScrollModeProps) {
  const listRef = useRef<FlatList<Line> | null>(null);
  const rowH = Math.max(1, geometry.rowHeight);

  // ── 占位高度（头部占位计入内容几何，见文件头 ②）──
  // 尾部占位在全部 item 之下 ⇒ 不影响任何 item 的 offset，无需进算式；
  // 头部占位在 item 之上 ⇒ 必须进 getItemLayout 与 y↔行号 换算。
  const headerH = hasMorePrev ? BOUNDARY_HINT_H : 0;

  // ── 跨章记账真值源（ref；onScroll 高频更新，不触发重渲染）──
  const committedRef = useRef(initialChapterId);
  /** 视口顶行下标（onScroll 更新，供翻屏用） */
  const topLineRef = useRef(0);
  const nearStateRef = useRef<{ next: boolean; prev: boolean }>({ next: false, prev: false });
  /** 当前滚动偏移（onScroll 更新；补偿算式与触摸分区都读它） */
  const offsetRef = useRef(0);
  /** 视口锚点（顶行的身份键 + 下标）：数据变更后按 key 求新下标算补偿 */
  const anchorRef = useRef<{ key: string; index: number } | null>(null);
  const pendingCompRef = useRef<number | null>(null);
  const pendingCompAtRef = useRef(0);
  /**
   * 最近一次原生内容高（onContentSizeChange 写入；0 = 尚未收到）。
   * ★ 补偿记账的必需输入：没有它就只能记「意图值」。
   */
  const contentHRef = useRef(0);
  /**
   * ★ `contentHRef` 的**新鲜度闸门**（2026-10-09 真机 A 臂实测）。
   *
   * 记录最近一次 `onContentSizeChange` 到达时的 `lines.length`。数据刚变更而
   * contentSize 回调还没到 ⇒ `contentHRef` 描述的是**旧数据** ⇒ 拿它算
   * `maxScroll` 会把新目标**主动降级**。真机实录（A 臂）：
   *   `COMP … delta=15840 target=22006`
   *   `APPLY target=22006 real=6166 contentH=6838`   ← 6838 是**旧**内容高
   *   （14ms 后才来 `CONTENT-SIZE h=22678`）
   * 即钳制并非原生所为，而是我们用陈旧值自造的 ⇒ 白跳一次 15840px（4.4 屏）。
   * ⇒ 内容高不新鲜时一律按「未知」处理（`clampScrollTarget` 对 `height<=0`
   *   不钳制），由随后的 contentSize 回调复投对齐。
   */
  const contentLinesRef = useRef(-1);
  /**
   * ★ 待达成的补偿目标（意图值，px），与上面两个「记账抑制闸门」**必须分开**。
   *
   * 背景（2026-10-09 真机实证）：补偿目标可能超过当前原生 `maxScroll`
   * （contentH 尚未长到目标所需高度）⇒ 落点被钳制。原实现 `onContentSizeChange`
   * 只复投**一次**就清 `pendingCompRef`，若这一次仍在钳制区间内，目标就永久丢失
   * ⇒ 顶行落在**距目标上千 px（数十行）**处，用户看到「章节加载完成后跳一下」。
   *
   * 目标态化：只要「意图目标 > 当前 maxScroll」（即还没真正到位）就一直保留，
   * 由每次 `onContentSizeChange`（内容长高）复投；落定条件用**实落点 == 目标**。
   */
  const compTargetRef = useRef<number | null>(null);
  /** 目标态化复投次数（放弃判据用次数，不用「内容高是否增长」，见 onContentSizeChange） */
  const compRetryRef = useRef(0);
  /** applyCompensation 的 ref 转发：让上方「续投节拍」不依赖它的声明顺序 */
  const applyCompRef = useRef<((t: number) => void) | null>(null);

/**
   * ★ 补偿续投节拍（2026-10-09 真机实证 `b31_v4.log` 必需）。
   *
   * 原生 `scrollToOffset` 在布局未稳时可被**静默丢弃**，而**用户不动 ⇒ 再无
   * `onScroll`** ⇒ 「靠下一次 onScroll 再投一次」这条路在真机上根本不会触发。
   * 实录：`APPLY target=8900 real=8900` → `CS h=35388`（复投 1 次）→ 之后
   * `SCROLL y=4316`（原生丢弃）⇒ **再无事件** ⇒ 视口永远停在上一章。
   *
   * ⇒ 必须由**定时器**按固定节拍续投，直到 `handleScroll` 落定（清 `compTargetRef`）
   *   或次数用尽。节拍取 `COMP_PENDING_MAX_MS / 2`，与抑制期同量级。
   */
  const compTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCompRetry = useCallback(() => {
    if (compTimerRef.current) {
      return;
    }
    compTimerRef.current = setTimeout(() => {
      compTimerRef.current = null;
      const t = compTargetRef.current;
      if (t == null) {
        return;
      }
      compRetryRef.current += 1;
      if (compRetryRef.current > COMP_TARGET_MAX_RETRY) {
        compTargetRef.current = null;
        pendingCompRef.current = null;
        return;
      }
      pendingCompRef.current = t;
      pendingCompAtRef.current = Date.now();
      applyCompRef.current?.(t);
      scheduleCompRetry();
    }, COMP_PENDING_MAX_MS / 2);
  }, []);

  /** 落定/放弃时停掉续投节拍，避免补偿已结束仍在空转 */
  const stopCompRetry = useCallback(() => {
    if (compTimerRef.current) {
      clearTimeout(compTimerRef.current);
      compTimerRef.current = null;
    }
  }, []);
  useEffect(() => stopCompRetry, [stopCompRetry]);

  /**
   * 是否已发生过**原生滚动事件**。★ 真机实证：首次交互之前，`scrollToOffset`
   * 会被原生静默忽略且不产生 onScroll ⇒ VirtualizedList 拿不到可见长度、
   * 可见窗口停在 bootstrap 区间（大片空白）。一旦有过一次真实 onScroll，
   * 之后的窗口增长都会正常挂载（实测 len 54→64→79 均正常）。
   */
  const userScrolledRef = useRef(false);
  /**
   * ★★ V3（2026-10-14）：用户滚动方向（+1 向下 / -1 向上 / 0 未知）。
   * 用途：邻章预取**只在用户真的往上滚时**才补 prev —— 向下跨章时补prev
   * 会把上一章 `windowPut` 到锚章**之上** = prepend = 整章位移闪烁。
   * ★ 为什么必须实测方向而不能用「链首==锚章」代替：真机B2 实测该判据
   *   **从来没为真过**（chainEqActive 恒 false），三轮改`fillNeighbors` 全白改。
   *   ⇒ 真因在邻章预取 effect（它由 activeChapterId 变化驱动，绕过全部 fillNeighbors 判据）。
   */
  const scrollDirRef = useRef(0);
  /** 已按哪个窗口长度做过首帧重挂载（避免无谓重挂载） */
  const bootMountedLenRef = useRef(lines.length);
  const bootAttemptsRef = useRef(0);
  const bootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 首帧重挂载序号：仅开书首帧（未交互）期间递增，用于给 FlatList 换 key */
  const [bootSeq, setBootSeq] = useState(0);

  // ── 回调 ref 化（onScroll 高频，防 stale closure）──
  const linesRef = useRef(lines);
  linesRef.current = lines;
  /** 取「新鲜」的原生内容高：数据长度与上次 contentSize 不一致 ⇒ 视为未知（0） */
  const freshContentH = useCallback(
    () => (contentLinesRef.current === linesRef.current.length ? contentHRef.current : 0),
    [],
  );
  const headerHRef = useRef(headerH);
  headerHRef.current = headerH;
  const commitRef = useRef(onChapterCommit);
  commitRef.current = onChapterCommit;
  const lineChangeRef = useRef(onLineChange);
  lineChangeRef.current = onLineChange;
  const nearBoundaryRef = useRef(onNearBoundary);
  nearBoundaryRef.current = onNearBoundary;
  // ★★ V3：方向回调同样 ref 化（onScroll 高频，防 stale closure）
  const scrollDirCbRef = useRef(onScrollDirChange);
  scrollDirCbRef.current = onScrollDirChange;
  const lastNotifiedDirRef = useRef(0);

  // ── 挂载锚点初始化（initialScrollIndex 的落点 = 该行的内容 y）──
  // ★ 必须在首个 onScroll 之前落定，否则「打开即被邻章前插」这次补偿没有基准行。
  const anchorInitRef = useRef(false);
  if (!anchorInitRef.current && lines.length > 0) {
    anchorInitRef.current = true;
    const idx = Math.min(Math.max(initialLineIndex, 0), lines.length - 1);
    topLineRef.current = idx;
    // initialScrollIndex=0 时上层传 undefined（原生 offset 为 0，头部占位仍在
    // 内容顶部）⇒ 此处不能按 contentYOfLineIndex 记基准，否则基准偏一个 headerH。
    offsetRef.current = initialLineIndex > 0 ? contentYOfLineIndex(idx, headerH, rowH) : 0;
    anchorRef.current = { key: lineKeyOf(lines[idx]), index: idx };
  }

  // ── getItemLayout：offset 含头部占位（RN 不做头部补偿，见文件头 ②）──
  const getItemLayout = useMemo(() => {
    const base = getItemLayoutOf(geometry);
    if (headerH === 0) {
      return base;
    }
    return (data: ArrayLike<Line> | null | undefined, index: number) => {
      const f = base(data, index);
      return { length: f.length, offset: f.offset + headerH, index };
    };
  }, [geometry, headerH]);

  /**
   * 边沿装载触发（上抛 `nearBoundaryRef`）。两条纪律均由真机实证换来：
   *
   * ① **必须由「滚动中」与「拖拽/动量结束」两条路径共同驱动**。位置到达内容
   *    末端后再滑**不再产生 `onScroll`**（真机：连滑 8 次 `[end]` 的 `y` 恒
   *    3505.3，画面零变化、占位恒「继续滑动以加载下一章…」）⇒ 只在 `handleScroll`
   *    里判 = 「到末章后永不装载」的死锁。
   * ② **「已在末端」是可重复条件**，不能只做「进区一次、出区重置」的去重：
   *    装载成功只把末端下推约一章（≈200dp），而用户一次滑动 >1000dp ⇒
   *    「临近末端」判据恒为真、永不出现「出区」⇒ 同样的死锁。⇒ 末端另设
   *    `atEnd` 判据，每次拖拽结束都可重试；重复发起由窗口层 `windowBegin`
   *    去重闸门保证（不在本层设「已发起」旗标——那正是第二层拦截的老毛病）。
   */
  const fireBoundary = useCallback(
    (y: number) => {
      const cur = linesRef.current;
      if (!nearBoundaryRef.current || cur.length === 0) {
        return;
      }
      const totalH = headerHRef.current + cur.length * rowH;
      // 已到内容末端 / 起点（无可滚余地）：原生不再派发 onScroll，只能靠拖拽结束重试
      const atEnd = hasMoreNext && y >= totalH - viewportH - 1;
      const atTop = hasMorePrev && y <= 1;
      const nearNext = hasMoreNext && y > totalH - viewportH * 3;
      const nearPrev = hasMorePrev && y < viewportH;
      if (atEnd) {
        nearBoundaryRef.current('next');
      }
      if (atTop) {
        nearBoundaryRef.current('prev');
      }
      if (nearNext !== nearStateRef.current.next) {
        nearStateRef.current.next = nearNext;
        if (nearNext) nearBoundaryRef.current('next');
      }
      if (nearPrev !== nearStateRef.current.prev) {
        nearStateRef.current.prev = nearPrev;
        if (nearPrev) nearBoundaryRef.current('prev');
      }
    },
    [rowH, viewportH, hasMoreNext, hasMorePrev],
  );

  /**
   * contentOffset.y → 视口顶行定位：更新 offsetRef/topLineRef/锚点 + 跨章提交
   * （章变化去重）+ 边沿装载（状态沿去重）。★ 进度记账不在此（onScroll 每 16ms
   * 一次，recordProgress 写 MMKV 不能每帧写）——只在滚动静止 handleScrollEnd 上报。
   *
   * ★ 补偿未落定期间只记 offset，不参与记账：此时 lines 已是新数组而原生 offset
   *   仍是旧值，y→行号 会指到更早的章（真机表现为上滚一次顶栏从第十六章跳到
   *   第十三章、并把进度覆写过去）。
   */
  const handleScroll = useCallback(
    (y: number) => {
      // ★★ V3：先记方向（必须在任何早退之前，否则空列表时不更新）
      const prevY = offsetRef.current;
      if (Math.abs(y - prevY) > 0.5) {
        const dir = y > prevY ? 1 : -1;
        scrollDirRef.current = dir;
        // ★ 只在**方向翻转**时回调（onScroll 每 16ms 一次，逐帧回调会把
        //   ReaderScreen 的 ref 写爆在无意义的位置上；翻转才是有信息量的时刻）
        if (dir !== lastNotifiedDirRef.current) {
          lastNotifiedDirRef.current = dir;
          scrollDirCbRef.current?.(dir);
        }
      }
      offsetRef.current = y;
      const cur = linesRef.current;
      if (cur.length === 0) return;
      userScrolledRef.current = true;

      const pending = pendingCompRef.current;
      if (pending != null) {
        // ★ 必须与**实落点**比，不是与意图值比：pendingCompRef 记的是意图 target，
        //   而落点可能被 `maxScroll` 钳制到比它小上千 px ⇒ 拿意图值比会「永不落定」，
        //   只能等 COMP_PENDING_MAX_MS 超白挨 500ms 抑制期（此间跨章记账被冻结）。
        //   同 500ms 超时兜底保留。
        const expect = clampScrollTarget(pending, freshContentH(), viewportH);
        const landed = Math.abs(y - expect) <= rowH;
        if (landed || Date.now() - pendingCompAtRef.current > COMP_PENDING_MAX_MS) {
          pendingCompRef.current = null;
          if (landed) {
            compTargetRef.current = null;
            compRetryRef.current = 0;
            stopCompRetry();
          } else if (compTargetRef.current != null) {
            // ★★ 抑制期已过但**没到位**（原生丢弃/截断了投递，`b31_v4.log` 实录
            //   y=4316 vs target=8900）⇒ 必须**再投一次**，且保留目标继续复投。
            //   旧实现在此直接放行（只清 pending）⇒ 目标丢失 ⇒ 视口停在上一章。
            compRetryRef.current += 1;
            if (compRetryRef.current > COMP_TARGET_MAX_RETRY) {
              compTargetRef.current = null;
              offsetRef.current = y;
              stopCompRetry();
            } else {
              applyCompensation(compTargetRef.current);
              pendingCompRef.current = compTargetRef.current;
              pendingCompAtRef.current = Date.now();
            }
          }
        } else {
          return;
        }
      }

      const idx = lineIndexAtContentY(y, headerHRef.current, rowH, cur.length);
      topLineRef.current = idx;
      const line = cur[idx];
      if (!line) return;
      anchorRef.current = { key: lineKeyOf(line), index: idx };

      // ★ 章归属行 = 几何顶行 +1，且**越界钳制时放弃提交**（viewportOwnerIndexAtContentY）。
      //   两个独立机理（见 scrollAnchor.ts 注释）：
      //   ① 亚像素落点误差 ⇒ 顶行比锚定少一行 ⇒ 落章首时错判成上一章末行；
      //   ② 装配空窗期 y 超出已装数据 ⇒ 旧实现把 y 钳到末行（末行属上一章）⇒ 错章，
      //      且此后视口不再移动 ⇒ 永不自愈。②对「+1」免疫，必须靠 null 判定挡住。
      //   几何（锚点/补偿/翻屏）继续用精确 idx，只有归属与记账用 owner 行。
      const ownerIdx = viewportOwnerIndexAtContentY(
        y,
        headerHRef.current,
        rowH,
        cur.length,
      );

      // 跨章提交：归属行所属章变化 → onChapterCommit（页首标题行跳过取正文行）
      // ★ ownerIdx === null（几何不可信）⇒ 只更新上方锚点、**跳过提交**，
      //   等数据装齐后的下一次 onScroll 正常判定。
      if (ownerIdx != null) {
        const ownerLine = cur[ownerIdx];
        if (ownerLine && ownerLine.chapterId !== committedRef.current) {
          committedRef.current = ownerLine.chapterId;
          commitRef.current(ownerLine.chapterId, firstContentLineOf(cur, ownerIdx));
        }
      }

      // 边沿装载：临近已载窗口两端 → 上抛续装（详见 fireBoundary 两条纪律）
      fireBoundary(y);
    },
    [rowH, viewportH, hasMoreNext, hasMorePrev, fireBoundary, stopCompRetry],
  );

  const onScroll = useCallback(
    (e: unknown) => {
      const y = scrollOffsetYOf(e);
      if (y == null) {
        return;
      }
      handleScroll(y);
    },
    [handleScroll],
  );

  // ── 数据位移补偿（文件头 ③）：lines / 头部占位变化 → 按锚行位移补 offset ──
  const prevLinesRef = useRef(lines);
  const prevHeaderHRef = useRef(headerH);
  /**
   * ★ 记账必须用**实落点**而非意图值（2026-10-09 真机实证）：
   * 补偿目标超过当前原生 `maxScroll` 时，落点被钳制；旧实现把 `offsetRef` 记成
   * 意图 target ⇒ 与实落点的偏差永久进入下一次补偿的基线，表现为「加载完成后跳一下」。
   * ★ `contentH` 不新鲜时的处理**已改**（2026-10-12）：旧实现是「按未知处理 ⇒
   *   `ch=0` ⇒ `clampScrollTarget` 不钳制 ⇒ **照投**」，而这正是残余闪烁的根因
   *   （真机 `flick2.log`：首投 42991 被原生钳到 30194，画面停在中间位 403ms）。
   *   现改为「按未知处理 ⇒ **本次不投**」，等 `onContentSizeChange` 带来与当前数据
   *   对应的高度后由下方守卫放行、一次投到位。
   */
  const applyCompensation = useCallback(
    (target: number) => {
      const cur = linesRef.current;
      const fresh = contentLinesRef.current === cur.length;
      const ch = fresh ? contentHRef.current : 0;
      const real = clampScrollTarget(target, ch, viewportH);
      // ★ 单向逼近守卫（2026-10-12 真机闪烁读数）：跳过「零位移冗余」「反向投递」
      //   以及**内容高陈旧时的首投**（目标此刻不可达 ⇒ 必被原生钳到中间位 ⇒ 闪）。
      //   ⚠ 第三条是主体：`flick2.log` 残余闪烁 403ms 窗口就发生在**首投**上，
      //   往返（后两条）只是它的次生现象。
      if (
        !shouldDeliverCompensation(
          offsetRef.current,
          target,
          real,
          rowH,
          contentLinesRef.current,
          cur.length,
        )
      ) {
        return;
      }
      listRef.current?.scrollToOffset({ offset: real, animated: false });
      offsetRef.current = real;
      const idx = lineIndexAtContentY(real, headerHRef.current, rowH, cur.length);
      topLineRef.current = idx;
      const l = cur[idx];
      anchorRef.current = l ? { key: lineKeyOf(l), index: idx } : null;
    },
    [rowH, viewportH],
  );
    applyCompRef.current = applyCompensation;
  useLayoutEffect(() => {
    const prevLines = prevLinesRef.current;
    const prevHeaderH = prevHeaderHRef.current;
    prevLinesRef.current = lines;
    prevHeaderHRef.current = headerH;
    if (prevLines === lines && prevHeaderH === headerH) {
      return;
    }
    const a = anchorRef.current;
    if (!a) {
      return;
    }
    const nextIndex = indexOfLineKey(lines, a.key);
    const delta = anchorCompensationDelta(a.index, nextIndex, rowH, prevHeaderH, headerH);
    if (delta === 0) {
      return;
    }
    const target = Math.max(0, offsetRef.current + delta);
    // ★ 记**意图值**（clampScrollTarget 的入参），不是实落点：onContentSizeChange
    //   的目标态化复投要比「是否已真正到位」，用实落点会立刻判成已落定而不再复投。
    compTargetRef.current = target;
    compRetryRef.current = 0;
    pendingCompRef.current = target;
    pendingCompAtRef.current = Date.now();
    applyCompensation(target);
    scheduleCompRetry();
  }, [lines, headerH, rowH, applyCompensation, scheduleCompRetry]);

  /**
   * 开书首帧：数据窗口稳定后**重挂载一次 FlatList**。
   *
   * 触发条件（三者同时）：① 尚未发生过原生 onScroll；② stitched.lines 长度变了；
   * ③ 去抖窗内不再变化。重挂载让 VirtualizedList 以**新窗口**重新计算可见区间，
   * 并按 `bootScrollIndex`（锚行在当前数据里的下标）一次性定位 ⇒ 一次性解决
   * 「只挂载 mount 期那几行、其余空白」。
   *
   * ★ 只在首交互前做：一旦有过真实 onScroll，窗口增长本就会正常挂载
   *   （真机实测 len 54→64→79 均正常），此时重挂载只会打断惯性/丢位置。
   */
  useEffect(() => {
    if (userScrolledRef.current || lines.length === bootMountedLenRef.current) {
      return undefined;
    }
    bootMountedLenRef.current = lines.length;
    if (bootTimerRef.current) {
      clearTimeout(bootTimerRef.current);
    }
    bootTimerRef.current = setTimeout(() => {
      bootTimerRef.current = null;
      if (userScrolledRef.current || bootAttemptsRef.current >= BOOT_MAX_REMOUNT) {
        return;
      }
      bootAttemptsRef.current += 1;
      // 重挂载会丢掉「待复投」的目标（原生定位由 initialScrollIndex 接管）
      compTargetRef.current = null;
      pendingCompRef.current = null;
      setBootSeq((v) => v + 1);
    }, BOOT_SETTLE_MS);
    return () => {
      if (bootTimerRef.current) {
        clearTimeout(bootTimerRef.current);
        bootTimerRef.current = null;
      }
    };
  }, [lines]);

  /**
   * 内容高度生效 → **目标态化**复投（2026-10-09 改，同日两次修正判据）。
   *
   * 旧行为「复投一次就清 pending」在「目标超出 maxScroll」时会永久丢目标。
   *
   * ★ 修正一（`b29_probe.log` 16:49:57）：**`!grew`（内容高未变）不是「目标不可达」
   *   的判据**。跳章时 `lines` 一步到位（98 → 706），此后 `contentH` 不再增长 ⇒
   *   旧判据第一次回调就丢弃补偿 ⇒ 原生把 `scrollTo(8900)` 截到 4316 ⇒ 顶栏错章。
   *
   * ★★ 修正二（`b31_v4.log` 16:54，**决定性**）：`real >= target` **也不能作为落定
   *   判据**——它只证明「原生**能容纳**目标」，不证明「offset **已**到位」。实录：
   *     APPLY target=8900 real=8900 contentH=35388 fresh=true   ← JS 投递 8900
   *     CS   h=35388 … retry=1 ⇒ real>=target ⇒ 立刻清 compTarget/pending
   *     SCROLL y=4316.4799 geoIdx=85                             ← 原生**只落到 4316**
   *   JS 侧投递成功、原生侧丢弃（`scrollToOffset` 在布局未稳时可被静默忽略，
   *   与文件头 `userScrolledRef` 注释里的既有实证同源）⇒ 目标被清 ⇒ 永不重投。
   *
   * ⇒ 职责切分：**`onContentSizeChange` 只负责「再投一次」，绝不宣告落定**；
   *   落定权只在 `handleScroll`（实测 `y` 与 `expect` 相差 ≤ rowH）。
   *   放弃判据＝重投次数用尽（`COMP_TARGET_MAX_RETRY`），因为「原生会不会接受
   *   这次投递」无法由 JS 预知。
   */
  const onContentSizeChange = useCallback((_w?: number, h?: number) => {
    if (typeof h !== 'number') {
      return;
    }
    contentHRef.current = h;
    // ★ 内容高与「当前数据长度」绑定 ⇒ 此后才算新鲜（见 contentLinesRef 闸门）
    contentLinesRef.current = linesRef.current.length;
    const target = compTargetRef.current;
    if (target == null) {
      return;
    }
    const real = clampScrollTarget(target, h, viewportH);
    compRetryRef.current += 1;
    if (compRetryRef.current > COMP_TARGET_MAX_RETRY) {
      // 重投次数用尽（尾部章几何前提不成立，原生怎么都不接受）⇒ 放弃并对齐实落点
      compTargetRef.current = null;
      pendingCompRef.current = null;
      offsetRef.current = real;
      stopCompRetry();
    } else {
      // ★★ 原生**可能静默丢弃** `scrollToOffset`（布局未稳时），而用户不动就
      //   **再无 onScroll** ⇒ 只靠 CS 回调复投次数不够（`b31_v4.log`：CS 只来 1 次，
      //   之后视口永远停在 4316）。故按**固定节拍**续投，直到 handleScroll 落定或
      //   次数用尽——这是「无输入也能收敛」的唯一途径。
      scheduleCompRetry();
    }
    applyCompensation(target);
  }, [applyCompensation, viewportH, scheduleCompRetry]);

  // 滚动静止 → 进度真值持久化（复用 PageMode 静止门控：动量/慢拖防双派发）
  const momentumRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScrollEnd = useCallback(
    (e: unknown) => {
      const y = scrollOffsetYOf(e);
      if (y == null) {
        return;
      }
      const cur = linesRef.current;
      if (cur.length === 0) return;
      // ★ 末端续装必须在此重试：到达内容末端后原生不再派发 onScroll
      //   （见 fireBoundary 纪律 ①），拖拽/动量结束是唯一的再触发点。
      fireBoundary(y);
      if (pendingCompRef.current != null) return;
      // ★ 与 handleScroll 同源：进度记账也须走归属行（顶行 +1），且**越界钳制时
      //   不记账**——否则装配空窗期会把进度写成上一章末行 ⇒ 续读位置一起漂。
      const ownerIdx = viewportOwnerIndexAtContentY(
        y,
        headerHRef.current,
        rowH,
        cur.length,
      );
      if (ownerIdx == null) return;
      lineChangeRef.current?.(firstContentLineOf(cur, ownerIdx));
    },
    [rowH, fireBoundary],
  );
  const handleMomentumBegin = useCallback(() => {
    momentumRef.current = true;
    if (dragEndTimerRef.current) {
      clearTimeout(dragEndTimerRef.current);
      dragEndTimerRef.current = null;
    }
  }, []);
  const handleMomentumEnd = useCallback(
    (e: unknown) => {
      momentumRef.current = false;
      handleScrollEnd(e);
    },
    [handleScrollEnd],
  );
  const handleDragEnd = useCallback(
    (e: unknown) => {
      if (dragEndTimerRef.current) {
        clearTimeout(dragEndTimerRef.current);
      }
      dragEndTimerRef.current = setTimeout(() => {
        dragEndTimerRef.current = null;
        if (!momentumRef.current) {
          handleScrollEnd(e);
        }
      }, 120);
    },
    [handleScrollEnd],
  );

  const keyExtractor = useCallback((item: Line) => lineKeyOf(item), []);

  /**
   * 挂载定位行下标：bootSeq=0（首次挂载）用上层给的全局下标；重挂载时用
   * **锚行 key 在当前数据里的下标**——数据可能已前插/后插，key 是唯一稳定真值。
   */
  /**
   * ★★★ D1（2026-10-15）：**跳章落位**（不重挂载路线的定位实现）。
   *
   * ## 为什么需要它
   * `initialScrollIndex` 只在 FlatList 挂载时生效；D1 把 scroll 模式的
   * `listKey` 改成常量（不再随 `switchSeq` 变）⇒ 跳章**不再重挂载**
   * ⇒ 必须在这里显式 `scrollToOffset` 落到目标章首行。
   *
   * ## 为什么能落在正确位置
   * `firstLineOf` 由宿主（`buildStitchedLines`）给出「每章首行在拼接序列里的
   * 全局下标」⇒ 目标 offset = `contentYOfLineIndex(firstLineOf.get(cid), …)`，
   * 与 `initialLineIndex` 走的是**同一个算式**（`ReaderScreen` 里
   * `first + clampWithin`）⇒ 两条路径的落点一致。
   *
   * ## 时序
   * 1. `jumpTo` → `setPendingJumpTo({cid})` → 本 prop 变化
   * 2. 目标章数据未就绪 ⇒ `firstLineOf.get(cid)` 为 undefined ⇒ **不投**（等）
   * 3. 数据就绪（win 装好、`stitched` 重算）⇒ 本 effect 重跑 ⇒ 落位 + 回调清pending
   *
   * ★落位后必须 `onJumpToSettled()`，否则 prop 不变 ⇒ 本 effect 不会再跑，
   *   但若因任何原因重跑会**二次跳回**同一位置（用户已滚走就被拽回）。
   */
  const jumpSettledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToChapterId || !onJumpToSettled) {
      return;
    }
    // 同一目标只落位一次（防「lines 再变 ⇒ 又跳回去」）
    if (jumpSettledRef.current === jumpToChapterId) {
      return;
    }
    const firstIdx = firstLineOf?.get(jumpToChapterId);
    if (firstIdx === undefined) {
      return; // 目标章还没进拼接序列 ⇒ 等
    }
    const target = contentYOfLineIndex(firstIdx, headerHRef.current, rowH);
    listRef.current?.scrollToOffset({ offset: target, animated: false });
    offsetRef.current = target;
    topLineRef.current = firstIdx;
    const l = linesRef.current[firstIdx];
    anchorRef.current = l ? { key: lineKeyOf(l), index: firstIdx } : null;
    jumpSettledRef.current = jumpToChapterId;
    onJumpToSettled();
  }, [jumpToChapterId, onJumpToSettled, firstLineOf, lines, headerH, rowH]);

  const bootScrollIndex = useMemo(() => {
    if (bootSeq === 0) {
      return initialLineIndex > 0 ? initialLineIndex : undefined;
    }
    const a = anchorRef.current;
    const idx = a ? indexOfLineKey(lines, a.key) : -1;
    return idx > 0 ? idx : undefined;
  }, [bootSeq, lines, initialLineIndex]);

  return (
    <View style={styles.wrap}>
      <FlatList<Line>
        key={`${listKey ?? ''}#${bootSeq}`}
        data={lines as Line[]}
        renderItem={({ item }) => renderLine(item) as React.ReactElement}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        onScrollEndDrag={handleDragEnd}
        onMomentumScrollBegin={handleMomentumBegin}
        onMomentumScrollEnd={handleMomentumEnd}
        onContentSizeChange={onContentSizeChange}
        initialScrollIndex={bootScrollIndex}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: contentYOfLineIndex(info.index, headerHRef.current, rowH),
            animated: false,
          });
        }}
        scrollEventThrottle={16}
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        windowSize={9}
        ListHeaderComponent={
          hasMorePrev ? (
            <View style={[styles.hint, { height: BOUNDARY_HINT_H }]}>
              <Text style={styles.hintText}>
                {loadError?.prev ? '加载失败，滑动重试' : '上一章加载中…'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          hasMoreNext ? (
            <View style={[styles.hint, { height: BOUNDARY_HINT_H }]}>
              <Text style={styles.hintText}>
                {loadError?.next ? '加载失败，滑动重试' : '继续滑动以加载下一章…'}
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={{
          paddingLeft: contentInsets.left,
          paddingRight: contentInsets.right,
        }}
        style={styles.list}
        ref={listRef}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  list: { flex: 1 },
  hint: { alignItems: 'center', justifyContent: 'center' },
  hintText: { color: '#888', fontSize: 13 },
});

export default ScrollMode;
export { ScrollMode };
