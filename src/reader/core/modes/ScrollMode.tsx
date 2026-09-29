/**
 * ScrollMode——连续画布滚动模式（ReaderCore 的 scroll 渲染策略）。
 * 机制与 legado 对齐依据见注释；分层架构对齐 @tangfeifan/react-native-reader（MIT）。
 *
 * 【为什么是连续画布而不是 legado 的三页块】legado 原生单 View 自绘：页对象常驻、
 * 换页=引用替换+同帧重绘（<1ms）。RN 声明式渲染换页=组件树重建（Hermes 慢 18.6×），
 * 且 translateY（Animated）与内容块（React commit）不同批提交 native ⇒ 跨页大跳变
 * 瞬间「旧内容+新位移」= 闪烁、装载完成替换占位 = 二次闪烁。真机三症状
 * （向上闪/卸载早空白/装载后闪）皆源于此 ⇒ 渲染层改连续画布：
 *
 * - 全部已载窗口章的行按画布 y（基址表 + 行序×rowH）绝对定位；
 * - 滚动只改 translateY（每帧一条轻量 bridge setValue 消息，无逐帧 JS 计算，
 *   滚动中零 React 渲染、零行 diff）；
 * - 装载新章 = 上/下方追加行（基址表墓碑式只加不减 ⇒ 旧行 y 永不变）⇒ 零跳变；
 * - 滚动语义（钳制/页界记账/章 commit/点击翻页/fling）逐条对齐 legado
 *   ContentTextView.scroll L273-301 / PageDelegate / ReadView（行号依据见各处注释）。
 *
 * 行为对齐 docs/scroll-reader-implementation-plan-2026-09-24.md；
 * 渲染坐标系属工程层（legado 无此概念），不构成行为差异。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, PanResponder, PixelRatio, Text, View } from 'react-native';

import { makeFling, makeLinearScroll, type FlingCurve } from '../../flingMath';
import type { Line, LineGeometry } from '../../geometry';
import type { BoundaryDirection } from '../types';

export type NineGridZone = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';

export interface ScrollModeProps {
  /** 已载章窗口（每章 lines 含章首标题行；数组序=书序） */
  chapters: readonly ScrollChapter[];
  /** 书级边界（窗口外未载章方向）——legado hasPrevChapter/hasNextChapter（ReadView L644-650） */
  hasMorePrev: boolean;
  hasMoreNext: boolean;
  /** 初始章 id（= activeChapterId；外部跳章走 listKey 重挂，commit 回流不改它） */
  initialChapterId: string;
  /** 初始章内页号（charOffset/lastRead → 行号 → 页号，ReaderScreen 投影） */
  initialPage: number;
  linesPerPage: number;
  geometry: LineGeometry;
  viewportH: number;
  /**
   * 版心壳左右偏移（reader/contentLayout.ts 唯一真源）。
   * 行容器按 left/right 摆位 ⇒ 内容宽 = 视口宽 − left − right **恒 = 行化 containerWidth**
   * （必须同值：容器比它窄 ⇒ 行化切出的末字被 overflow 裁掉 = 丢字，2026-09-29 真机实证）。
   * left ≠ right 是刻意的：差值 2×shift 把「整字数文字块」摆到版心正中。列命中同用左偏移。
   */
  contentInsets: { left: number; right: number };
  renderLine(line: Line): React.ReactNode;
  /** 跨章提交（legado moveToNextChapter → 进度/预载回流） */
  onChapterCommit(chapterId: string, firstLine: Line | undefined): void;
  /** 每次换页（含章内）进度上报（legado curPageChanged → saveRead，TextPageFactory L36-47） */
  onLineChange?(line: Line | undefined): void;
  /** 列命中字符 → 语义分流（查词/划线/通假/多音）由上层处理 */
  onTapChar?(line: Line, colInLine: number): void;
  onLongPressChar?(line: Line, colInLine: number): void;
  /** 九宫格点击（legado onSingleTapUp L380-411，分区判定按 setRect9x L116-126） */
  onNineGrid?(zone: NineGridZone): void;
  /** 视口临近窗口已载边沿（未载方向）→ 上抛宿主续装邻章（库 onBoundary 语义的滚动近似） */
  onNearBoundary?(dir: BoundaryDirection): void;
  /**
   * 边沿邻章装载失败标记（宿主 ReaderScreen 传入）：next/prev = 该方向最近一次
   * 邻章装载失败。仅改变占位文案（「加载失败，滑动重试」），不阻断重试。
   */
  loadError?: { next?: boolean; prev?: boolean };
  /** 重挂载键（ReaderCore 用作组件 key；切模式/跳章触发全新画布） */
  listKey?: string;
}

export interface ScrollReaderHandle {
  /** 章内定页跳转（菜单跳页预留；外部跳章走 listKey 重挂） */
  seekToPage(page: number): void;
}

export interface ScrollChapter {
  chapterId: string;
  lines: readonly Line[];
}

interface WinRow {
  key: string;
  top: number;
  line: Line;
}

const LONG_PRESS_MS = 600; // legado ReadView L77
const TAP_SLOP = 10;
/** fling 速度采样窗（Android VelocityTracker 有效历史 ≈100ms 同量级） */
const VELOCITY_WINDOW_MS = 100;
/** 行渲染窗口上/下缓冲（屏数）：重算阈值=1 屏，pad>阈值 ⇒ React 重算间隙仍有行兜底 */
const WIN_PAD_UP_SCREENS = 2;
const WIN_PAD_DOWN_SCREENS = 4;

function firstContentLineOf(lines: readonly Line[], startIdx: number): Line | undefined {
  // N1：页首若是标题行（stitch 注入，segmentId='__title__'），进度取首个正文行
  // （legado durChapterPos = getReadLength(pageIndex) char 真值天然无此坑）
  for (let i = Math.max(0, startIdx); i < lines.length; i++) {
    if (!lines[i].isTitle) return lines[i];
  }
  return lines.length > 0 ? lines[0] : undefined;
}

function nineGridZone(x: number, y: number, w: number, h: number): NineGridZone {
  // legado setRect9x（L116-126）：33% 三分，tr 左界 36%（tc 右伸特判）；判定顺序同 onSingleTapUp
  const row = y < h * 0.33 ? 0 : y < h * 0.66 ? 1 : 2;
  const col = x < w * 0.33 ? 0 : x < w * 0.66 ? 1 : 2;
  if (row === 0) {
    if (col === 0) return 'tl';
    if (x < w * 0.36) return 'tc'; // tc 实际右界覆盖到 tr 左界
    return 'tr';
  }
  if (row === 1) return col === 0 ? 'ml' : col === 1 ? 'mc' : 'mr';
  return col === 0 ? 'bl' : col === 1 ? 'bc' : 'br';
}

const ScrollMode = forwardRef<ScrollReaderHandle, ScrollModeProps>(function ScrollMode(
  props,
  ref,
) {
  const {
    chapters,
    hasMorePrev,
    hasMoreNext,
    initialChapterId,
    initialPage,
    linesPerPage,
    geometry,
    viewportH,
    contentInsets,
    renderLine,
    onChapterCommit,
    onLineChange,
    onTapChar,
    onLongPressChar,
    onNineGrid,
    loadError,
  } = props;

  const rowH = Math.max(1, geometry.rowHeight);
  const lpp = Math.max(1, linesPerPage);

  // ── 画布模型真值源（ref；setState 仅渲染窗口镜像）──
  // scrollY = 视口顶在画布中的 y（正向下）。画布 y = 每章基址 + 行序×rowH。
  const scrollYRef = useRef(0);
  const offset = useRef(new Animated.Value(0)).current; // translateY = -scrollY
  // 基址表：墓碑式（裁掉的章条目保留，只加不减）⇒ 存活行 y 永不回退 ⇒ 裁章零补偿零跳变
  const baseMapRef = useRef(new Map<string, number>());
  const committedRef = useRef(initialChapterId);
  const lastPageRef = useRef<{ chapterId: string; page: number } | null>(null);
  const winYRef = useRef(Number.NaN); // 已渲染窗口的锚 y

  // ── 基址维护：新章方向由邻接已锚定章推导；锚定优先 initialChapterId ──
  const ensureBases = useCallback(
    (chs: readonly ScrollChapter[]) => {
      const bases = baseMapRef.current;
      if (chs.length === 0) return;
      if (bases.size === 0) {
        const anchor = chs.find((c) => c.chapterId === initialChapterId) ?? chs[0];
        bases.set(anchor.chapterId, 0);
      }
      // 前向：已锚定章之后的新章依序顺推
      let acc: number | null = null;
      for (const c of chs) {
        const known = bases.get(c.chapterId);
        if (known !== undefined) {
          acc = known + c.lines.length * rowH;
        } else if (acc !== null) {
          bases.set(c.chapterId, acc);
          acc += c.lines.length * rowH;
        }
      }
      // 后向：锚定区之前的新章逆推（首部装载邻章场景）
      let acc2: number | null = null;
      for (let i = chs.length - 1; i >= 0; i--) {
        const c = chs[i];
        const known = bases.get(c.chapterId);
        if (known !== undefined) {
          acc2 = known;
        } else if (acc2 !== null) {
          acc2 -= c.lines.length * rowH;
          bases.set(c.chapterId, acc2);
        }
      }
    },
    [initialChapterId, rowH],
  );

  // ── 钳制边界（legado ContentTextView.scroll L279-286 顶/尾钳 + 未载方向 msg 页占位）──
  const boundsOf = useCallback(
    (chs: readonly ScrollChapter[]) => {
      const bases = baseMapRef.current;
      const first = chs[0];
      const last = chs[chs.length - 1];
      const topBase = first ? (bases.get(first.chapterId) ?? 0) : 0;
      const botBase = last ? (bases.get(last.chapterId) ?? 0) + last.lines.length * rowH : 0;
      const loadingH = Math.max(viewportH, lpp * rowH);
      return {
        min: hasMorePrev ? topBase - loadingH : topBase, // 书首硬钳 / 未载 prev 露占位一屏
        max: hasMoreNext ? botBase + loadingH - viewportH : Math.max(topBase, botBase - viewportH),
        topBase,
        botBase,
        loadingH,
      };
    },
    [hasMorePrev, hasMoreNext, viewportH, lpp, rowH],
  );

  // 视口顶行定位：画布 y → {章, 章内行 idx}（legado 页记账 = durChapterPos 投影同构）
  const locate = useCallback(
    (y: number, chs: readonly ScrollChapter[]) => {
      const bases = baseMapRef.current;
      for (let i = 0; i < chs.length; i++) {
        const c = chs[i];
        const base = bases.get(c.chapterId);
        if (base === undefined) continue;
        const nextBase = i + 1 < chs.length ? bases.get(chs[i + 1].chapterId) ?? Infinity : Infinity;
        if (y >= base && y < nextBase) {
          const idx = Math.min(Math.max(Math.floor((y - base) / rowH), 0), c.lines.length - 1);
          return { chapter: c, base, idx };
        }
      }
      return null;
    },
    [rowH],
  );

  // ── 行渲染窗口（绝对定位行切片；滚动中零 setState，窗口锚越一屏才重算）──
  const computeRows = useCallback(
    (y: number, chs: readonly ScrollChapter[]): WinRow[] => {
      const bases = baseMapRef.current;
      const rows: WinRow[] = [];
      const yTop = y - WIN_PAD_UP_SCREENS * viewportH;
      const yBot = y + WIN_PAD_DOWN_SCREENS * viewportH;
      for (const c of chs) {
        const base = bases.get(c.chapterId);
        if (base === undefined) continue;
        const from = Math.max(0, Math.floor((yTop - base) / rowH));
        const to = Math.min(c.lines.length - 1, Math.ceil((yBot - base) / rowH));
        for (let i = from; i <= to; i++) {
          const line = c.lines[i];
          if (!line) continue;
          rows.push({
            key: `${line.chapterId}#${line.isTitle ? 'title' : `${line.segmentId}#${line.charStart}`}`,
            top: base + i * rowH,
            line,
          });
        }
      }
      return rows;
    },
    [rowH, viewportH],
  );

  const [winRows, setWinRows] = useState<WinRow[]>([]);

  // ── 回调 ref 化（rAF/手势防 stale closure，预演 U）──
  const scrollByRef = useRef<(dy: number) => void>(() => undefined);
  const tapCharRef = useRef(props.onTapChar);
  const longPressCharRef = useRef(props.onLongPressChar);
  const nineGridRef = useRef(props.onNineGrid);
  const lineChangeRef = useRef(onLineChange);
  const chapterCommitRef = useRef(onChapterCommit);
  tapCharRef.current = onTapChar;
  longPressCharRef.current = onLongPressChar;
  nineGridRef.current = onNineGrid;
  lineChangeRef.current = onLineChange;
  chapterCommitRef.current = onChapterCommit;
  const nearBoundaryRef = useRef(props.onNearBoundary);
  nearBoundaryRef.current = props.onNearBoundary;
  const nearStateRef = useRef<{ next: boolean; prev: boolean }>({ next: false, prev: false });

  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const boundsRef = useRef(boundsOf);
  boundsRef.current = boundsOf;
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const computeRowsRef = useRef(computeRows);
  computeRowsRef.current = computeRows;

  const syncWindow = useCallback(
    (force: boolean) => {
      const y = scrollYRef.current;
      if (!force && !Number.isNaN(winYRef.current) && Math.abs(y - winYRef.current) <= viewportH) {
        return;
      }
      winYRef.current = y;
      setWinRows(computeRowsRef.current(y, chaptersRef.current));
    },
    [viewportH],
  );

  // ── 滚动状态机：滚动语义 = ContentTextView.scroll L273-301 的画布坐标等价式 ──
  // 三页块版的对账跳变（off±curH）在此消失：画布 y 连续，跨页仅记账。
  scrollByRef.current = (dy: number) => {
    const chs = chaptersRef.current;
    if (chs.length === 0) return;
    const b = boundsRef.current(chs);
    let y = scrollYRef.current + dy;
    if (y < b.min) y = b.min;
    if (y > b.max) y = b.max;

    // 记账：视口顶行 → 章 + 页号（legado 跨页换页的画布等价：页界即 lpp 行界）
    const loc = locateRef.current(y, chs);
    if (loc) {
      const page = Math.floor(loc.idx / lpp);
      const lastP = lastPageRef.current;
      if (!lastP || lastP.chapterId !== loc.chapter.chapterId || lastP.page !== page) {
        lastPageRef.current = { chapterId: loc.chapter.chapterId, page };
        const firstLine = firstContentLineOf(loc.chapter.lines, page * lpp);
        if (loc.chapter.chapterId !== committedRef.current) {
          committedRef.current = loc.chapter.chapterId;
          chapterCommitRef.current(loc.chapter.chapterId, firstLine);
        }
        lineChangeRef.current?.(firstLine);
      }
    }

    scrollYRef.current = y;
    offset.setValue(-y);
    syncWindow(false);

    // 边沿前瞻上抛（状态沿去重：进区报一次，出区重置）——宿主续装邻章
    if (nearBoundaryRef.current) {
      const nearNext = hasMoreNext && y > b.botBase - viewportH * 2;
      const nearPrev = hasMorePrev && y < b.topBase + viewportH;
      if (nearNext !== nearStateRef.current.next) {
        nearStateRef.current.next = nearNext;
        if (nearNext) nearBoundaryRef.current('next');
      }
      if (nearPrev !== nearStateRef.current.prev) {
        nearStateRef.current.prev = nearPrev;
        if (nearPrev) nearBoundaryRef.current('prev');
      }
    }
  };

  // chapters/几何变化 → 基址维护 + 边界校正（dy=0 跑钳制；装载完成自动放行）
  useEffect(() => {
    ensureBases(chapters);
    scrollByRef.current(0);
  }, [chapters, ensureBases, lpp, viewportH]);

  // ── 动画引擎：rAF 循环（fling = Scroller spline；点击翻页 = startScroll 定速）──
  const animRef = useRef<{ curve: FlingCurve; startTime: number; lastPos: number; raf: number } | null>(null);
  const stopAnim = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current.raf);
      animRef.current = null;
    }
  }, []);

  const startAnim = useCallback((curve: FlingCurve & { done?: boolean }) => {
    stopAnim();
    if (curve.done) return;
    const startTime = Date.now();
    const lastPos = curve.distanceAt(0);
    const step = () => {
      const anim = animRef.current;
      if (!anim) return;
      const elapsed = Date.now() - startTime;
      const pos = curve.distanceAt(elapsed);
      const dy = pos - anim.lastPos;
      anim.lastPos = pos;
      scrollByRef.current(dy);
      if (elapsed >= curve.durationMs) {
        // 末帧补齐：legado Scroller.computeScroll 结束帧仍取精确 finalY
        // （startScroll/fling 终点不丢最后一段），否则落点差几十 px 校正 = 跳动
        const finalPos = curve.distanceAt(curve.durationMs);
        const rest = finalPos - pos;
        if (rest !== 0) {
          scrollByRef.current(rest);
        }
        animRef.current = null; // onAnimStop：滚动模式 nothing（L31-33，无吸附对齐）
        return;
      }
      anim.raf = requestAnimationFrame(step);
    };
    animRef.current = { curve, startTime, lastPos, raf: requestAnimationFrame(step) };
  }, [stopAnim]);

  useEffect(() => stopAnim, [stopAnim]);

  // ── 点击翻页锚点（calcNextPageOffset/calcPrevPageOffset L131-161 精确式画布版；
  //    下翻 = 滚一屏保留一行；上翻 = 首可见行滚到视口底）──
  const flipNext = useCallback(() => {
    const y = scrollYRef.current;
    const lastVisibleRowTop = Math.floor((y + viewportH - 1) / rowH) * rowH;
    startAnim(makeLinearScroll(lastVisibleRowTop - y, y, viewportH));
  }, [viewportH, rowH, startAnim]);

  const flipPrev = useCallback(() => {
    const y = scrollYRef.current;
    const firstVisibleRowTop = Math.floor(y / rowH) * rowH;
    const target = firstVisibleRowTop + rowH - viewportH;
    startAnim(makeLinearScroll(target - y, y, viewportH));
  }, [viewportH, rowH, startAnim]);

  // ── tap / 长按 / 九宫格（ContentTextView.touch + ReadView.onSingleTapUp 同构）──
  const viewportWRef = useRef(0);
  const tapSuppressedRef = useRef(false); // M4：动画中 tap 吞一次（isAbortAnim L91-106）
  const lastDyRef = useRef(0);
  const movedRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef({ x: 0, y: 0 });
  const moveSamplesRef = useRef<{ t: number; y: number }[]>([]);

  // fling 速度：最近 ~100ms 样本首尾差/时长（VelocityTracker 同构多点加权；
  // g.vy 只看最后两个 move 样本，快离手瞬间严重低估 → 弃用）
  // 方向：pageY 手指位移（向下正）⇒ 返回值取反 = 内容方向速度（正=向下滚动）。
  const flingVelocity = useCallback((): number => {
    const samples = moveSamplesRef.current;
    const now = Date.now();
    let first = samples[0];
    for (const s of samples) {
      if (now - s.t <= VELOCITY_WINDOW_MS) {
        first = s;
        break;
      }
    }
    const last = samples[samples.length - 1];
    if (!first || !last || last === first) return 0;
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return -(last.y - first.y) / dt;
  }, []);

  // 列命中（画布 y 版）：yCanvas = 视口 y + scrollY → 章行
  const hitTest = useCallback(
    (locationX: number, locationY: number): { line: Line; col: number } | null => {
      const loc = locateRef.current(scrollYRef.current + locationY, chaptersRef.current);
      if (!loc) return null;
      const line = loc.chapter.lines[loc.idx];
      if (!line || line.isTitle) return null; // 标题行无字符语义（legado 列命中无查词目标）
      const col = Math.floor((locationX - contentInsets.left) / Math.max(1, geometry.cellAdvance));
      return { line, col: Math.max(0, col) };
    },
    [geometry.cellAdvance, contentInsets.left],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // capture 统一接管：legado 单 View 自绘 click/touch 判定的 RN 翻译（预演难点 T）
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (e) => {
          // DOWN → abortAnim（ScrollPageDelegate L45-49）；动画中 tap 吞一次（M4）
          tapSuppressedRef.current = animRef.current !== null;
          stopAnim();
          lastDyRef.current = 0;
          movedRef.current = false;
          moveSamplesRef.current = []; // VelocityTracker 样本重置
          const { locationX, locationY } = e.nativeEvent;
          pressStartRef.current = { x: locationX, y: locationY };
          if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
          if (longPressCharRef.current) {
            // 长按 600ms（legado ReadView L77-81 postDelayed）
            longPressTimerRef.current = setTimeout(() => {
              longPressTimerRef.current = null;
              const hit = hitTest(pressStartRef.current.x, pressStartRef.current.y);
              if (hit) longPressCharRef.current?.(hit.line, hit.col);
            }, LONG_PRESS_MS);
          }
        },
        onPanResponderMove: (e, g) => {
          const dy = g.dy - lastDyRef.current;
          lastDyRef.current = g.dy;
          if (!movedRef.current && Math.abs(g.dx) + Math.abs(g.dy) > TAP_SLOP) {
            movedRef.current = true;
            if (longPressTimerRef.current) {
              clearTimeout(longPressTimerRef.current);
              longPressTimerRef.current = null;
            }
          }
          // VelocityTracker 样本（release 自算速度）
          const samples = moveSamplesRef.current;
          samples.push({ t: Date.now(), y: e.nativeEvent.pageY });
          if (samples.length > 24) samples.shift();
          // 方向：画布 scrollY 正=向下滚动（内容上移）；g.dy 正=手指向下 ⇒ 取反。
          // legado 用 Android GestureDetector.onScroll 的 distanceY（=旧位-新位，
          // 天然是内容方向）⇒ 此处取反即等价。
          scrollByRef.current(-dy); // setTouchPoint → onScroll → scroll(dy)（ReadView L289-298）
        },
        onPanResponderRelease: (e, _g) => {
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
          if (!movedRef.current) {
            if (tapSuppressedRef.current) return; // M4：动画中 tap 吞一次
            const { locationX, locationY } = e.nativeEvent;
            const hit = hitTest(locationX, locationY);
            if (hit) {
              tapCharRef.current?.(hit.line, hit.col);
              return;
            }
            const zone = nineGridZone(locationX, locationY, viewportWRef.current, viewportH);
            if (zone === 'bl' || zone === 'bc' || zone === 'br' || zone === 'mr' || zone === 'tr') {
              flipNext(); // legado 默认 clickAction：下区/右中/右上 = 下一页（AppConfig L19-27）
            } else if (zone === 'tl' || zone === 'tc' || zone === 'ml') {
              flipPrev(); // 上区/左中 = 上一页
            } else {
              nineGridRef.current?.(zone); // mc = 菜单
            }
            return;
          }
          // UP → fling（ScrollPageDelegate L53-55 → onAnimStart L23-29）
          // 速度：最近 ~100ms 样本线性平均（VelocityTracker.computeCurrentVelocity(1000) 同构，px/s）
          const v = flingVelocity();
          if (Math.abs(v) > 50) {
            const ppi = PixelRatio.get() * 160;
            startAnim(makeFling(Math.max(-8000, Math.min(8000, v)), scrollYRef.current, ppi));
          }
        },
        onPanResponderTerminate: () => {
          stopAnim();
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        },
      }),
    [flipNext, flipPrev, hitTest, startAnim, stopAnim, viewportH, flingVelocity],
  );

  // 挂载首定位：initial 章 base=0（ensureBases 锚定），页号 → scrollY
  useImperativeHandle(
    ref,
    () => ({
      seekToPage(page: number) {
        stopAnim();
        const chs = chaptersRef.current;
        const base = baseMapRef.current.get(committedRef.current) ?? 0;
        const y = base + page * lpp * rowH;
        const b = boundsRef.current(chs);
        scrollYRef.current = Math.min(Math.max(y, b.min), b.max);
        offset.setValue(-scrollYRef.current);
        lastPageRef.current = null;
        syncWindow(true);
        const loc = locateRef.current(scrollYRef.current, chs);
        const firstLine = loc ? firstContentLineOf(loc.chapter.lines, Math.floor(loc.idx / lpp) * lpp) : undefined;
        lineChangeRef.current?.(firstLine);
      },
    }),
    [stopAnim, lpp, rowH, locateRef, syncWindow],
  );

  // 挂载首定位 effect（initialPage → scrollY；确保基址已铺）
  useEffect(() => {
    ensureBases(chaptersRef.current);
    const b = boundsRef.current(chaptersRef.current);
    const y = Math.min(Math.max(initialPage * lpp * rowH, b.min), b.max);
    scrollYRef.current = y;
    lastPageRef.current = null; // 首定位强制记账一次
    offset.setValue(-y);
    syncWindow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 渲染：连续画布（绝对定位行 + translateY；滚动中仅 transform 变化）──
  const b = boundsOf(chapters);
  const topLoadingTop = b.topBase - b.loadingH;

  return (
    <View
      style={{ flex: 1, overflow: 'hidden' }}
      onLayout={(e) => {
        viewportWRef.current = e.nativeEvent.layout.width;
      }}
      {...panResponder.panHandlers}
    >
      <Animated.View style={{ flex: 1, transform: [{ translateY: offset }] }}>
        {/* 顶部装载占位（legado msg 页「加载中…」；未载 prev 方向） */}
        {hasMorePrev && (
          <View
            style={{
              position: 'absolute',
              top: topLoadingTop,
              left: 0,
              right: 0,
              height: b.loadingH,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text>{loadError?.prev ? '加载失败，滑动重试' : '加载中…'}</Text>
          </View>
        )}
        {winRows.map((r) => (
          // ★ left/right = 版心壳（contentInsets）：容器宽 = 视口宽 − left − right = 行化 containerWidth
          //   （同值 ⇒ 行化切出的整行字都能装下；缺此定位则正文贴左、右侧多出 2×inset，2026-09-29 真机实证）
          <View
            key={r.key}
            style={{
              position: 'absolute',
              top: r.top,
              left: contentInsets.left,
              right: contentInsets.right,
            }}
          >
            {renderLine(r.line)}
          </View>
        ))}
        {/* 尾部装载占位（未载 next 方向；legado「继续滑动以加载下一章…」语义） */}
        {hasMoreNext && (
          <View
            style={{
              position: 'absolute',
              top: b.botBase,
              left: 0,
              right: 0,
              height: b.loadingH,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text>{loadError?.next ? '加载失败，滑动重试' : '继续滑动以加载下一章…'}</Text>
          </View>
        )}
      </Animated.View>
    </View>
  );
});

export default ScrollMode;

export { ScrollMode };
