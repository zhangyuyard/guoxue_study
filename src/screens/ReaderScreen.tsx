/**
 * 阅读器主页面（ReaderScreen）
 * 页面结构：
 * - 顶部：书名 + 章节名 + 返回按钮 + 设置入口（字号/行距/主题）
 * - 正文：FlatList 逐段渲染（注音模式用 PinyinText，关闭注音用 HighlightText）
 * - 底部：PinyinModeBar（浮动注音模式切换）+ ReaderToolbar（划线/笔记/收藏/背诵）
 * 交互流程：
 * - 长按正文 → 弹出选词面板（可调整范围）→ 解析 / 选色划线 / 笔记
 * - 点击已有划线 → 弹出笔记编辑器（新建或编辑关联笔记）
 * - 与 useReaderStore 联动：openChapter 保存阅读位置，滚动更新当前段落
 * 说明：T05 已接入导航——「背诵」跳转 RecitationPracticeScreen；
 * props 保持宽松路由签名，兼容 RootStack 注入（阅读经书架选书进入）。
 * 正文支持繁简一键切换：转换在「数据层」统一作用于段落文本，渲染、选区码点与
 * 划线偏移均基于转换后文本，保证三者一致、切换不错位。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  Book,
  Bookmark,
  Chapter,
  Highlight,
  HighlightColor,
  PinyinMode,
  ReaderMode,
  TextSegment,
} from '@/types';

import AnalysisPanel from '@/components/reader/AnalysisPanel';
import TranslationPanel from '@/components/reader/TranslationPanel';
import HighlightText from '@/components/reader/HighlightText';
import PageFlipPager from '@/components/reader/PageFlipPager';
import PinyinModeBar from '@/components/reader/PinyinModeBar';
import PinyinText from '@/components/reader/PinyinText';
import ReaderToolbar from '@/components/reader/ReaderToolbar';
import type { RecitationPracticeParams } from '@/navigation/types';
import {
  StorageService,
  genId,
  nowISO,
} from '@/services/StorageService';
import { TextLibraryService } from '@/services/TextLibraryService';
import { ConversionService } from '@/services/ConversionService';
import { TtsService } from '@/services/tts/TtsService';
import { stepSpeechRate } from '@/utils/speech';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useReaderStore } from '@/store/useReaderStore';
import {
  useBookmarks,
  useHighlightsForChapters,
  useNotesForChapters,
} from '@/hooks/useStorage';
import {
  LINE_HEIGHT_OPTIONS,
  PAGE_TITLE_FONT_SIZE,
  PARAGRAPH_SPACING,
} from '@/theme/typography';
import { getPaperColors, PAPER_OPTIONS, type ThemeColors } from '@/theme';
import {
  computeChunkBoundaries,
  paginateBlocks,
  type PaginateBlock,
  type PaginatedPage,
} from '@/utils/pagination';
import type { HighlightedSegment } from '@/utils/highlight';

// ============ 类型定义 ============

/** 路由参数 */
export interface ReaderRouteParams {
  bookId: string;
  chapterId: string;
  segmentId?: string;
}

/** ReaderScreen 所需的最小导航能力（RootStack 注入或阅读 Tab 手动构造均可满足） */
interface ReaderScreenProps {
  /** React Navigation 注入的 route（阅读 Tab 复用时由父组件直接传入） */
  route?: { params?: ReaderRouteParams };
  /** React Navigation 注入的 navigation */
  navigation?: {
    goBack: () => void;
    /** 跳转背诵练习（未命中当前 Stack 时由 React Navigation 冒泡至根 Stack） */
    navigate: {
      (name: 'Reader', params: ReaderRouteParams): void;
      (name: 'RecitationPractice', params: RecitationPracticeParams): void;
    };
  };
}

/** 当前选中范围（码点索引，与划线偏移基准一致） */
interface Selection {
  segmentId: string;
  start: number;
  end: number;
  text: string;
}

/** 笔记编辑器状态（null 表示关闭） */
interface NoteEditorState {
  segmentId: string;
  start: number;
  end: number;
  highlightId?: string;
  noteId?: string;
}

const EMPTY_HIGHLIGHTS: Highlight[] = [];

/** 连续滚动模式：章标题行的 key 前缀（与段落 id 区分，保证 keyExtractor 唯一） */
const TITLE_ROW_PREFIX = '__title__:';

/**
 * 正文容器底部留白：底部 dock（进度+朗读+注音+工具栏）悬浮于正文之上，需留出等高空档。
 * P2-02 起新增朗读条（约 40px），由 180 上调至 220。
 */
const CONTENT_BOTTOM_PADDING = 220;

/**
 * 连续滚动「单次会话最多拼接的章节数」。
 * 拼接是双向的（向后追加 + 向前插入），长书（如《史记》130 篇）一路滚下去会无限吃
 * 内存，故设上限：到达上限后停止自动拼接（正文停在该章边界，仍可用「上一章 /
 * 下一章」按钮继续）。
 * 之所以不做「从两端裁剪 + 补偿滚动偏移」的滑动窗口：变高行的偏移补偿需按 rowOffsets
 * 反推并在数据变更后立刻 scrollToOffset，跨端时机不可靠，一旦算错会造成可见跳页，
 * 风险远大于收益。真机确认内存吃紧时再考虑滑动窗口。
 */
const MAX_CONTINUOUS_CHAPTERS = 30;

/**
 * 向前拼接锚点的最长存活时间。
 * 正常情况下「原首章标题行」会在下一两个布局帧内重新 onLayout，锚点随即解析；
 * 若因行回收等极端情况迟迟等不到（如锚点行恰好移出渲染窗口），超时后放弃补偿
 * （视野会跳到上一章开头，属于可接受的降级），确保 appendNextChapter 的
 * prependAnchor 守卫不会被长期卡死、用户滚动不会被陈旧锚点反复拽回。
 */
const ANCHOR_TIMEOUT_MS = 2000;

/**
 * 模式切换后「定位到当前段」的最长等待时间。
 * 目标行超出初始渲染窗口且 rowOffsets 无历史数据时，onLayout 不会触发，
 * 超时后放弃定位（落回章首属可接受的降级），避免 pendingScroll 守卫
 * 长期阻塞向前拼接。
 */
const LOCATE_TIMEOUT_MS = 1500;

/**
 * 拆分块二轮再切的容差（px）：块高超出页预算不超过该值时不再细分，
 * 轻微溢出交给页内纵向滚动吸收。避免「线性估算误差 + 换行取整」造成的
 * 微小超高被反复拆分，产生只有一行的碎页。
 */
const CHUNK_RESPLIT_TOLERANCE = 12;

/**
 * 滚动模式上下章「预加载窗口」（屏高倍数）：距顶/距底不足该倍数屏高时
 * 即提前拼接上一章/追加下一章。提前拼接让「插入 + 偏移补偿」发生在
 * 用户还远离章节边界时，到边界时内容已就绪，体感上无需等待。
 */
const CONTIGUOUS_PRELOAD_SCREENS = 2;

/**
 * 阅读行（滚动模式 FlatList 的数据单元）
 * 连续滚动时正文跨章拼接：每章先渲染一个「标题行」，再渲染该章的若干「段落行」。
 */
interface ReaderRow {
  /** 行 id：段落行用 segment.id，标题行用 `TITLE_ROW_PREFIX + chapterId` */
  id: string;
  /** 本行所属章节 ID（跨章后用于定位阅读位置与上下文判音） */
  chapterId: string;
  /** 章标题文本（段落行为 null） */
  title: string | null;
  /** 段落数据（已按繁简模式转换；标题行为 null） */
  segment: TextSegment | null;
}

/** 数值 clamp */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ============ 通用小组件 ============

/** 选项按钮（设置弹层用） */
function OptionButton({
  label,
  active,
  colors,
  onPress,
}: {
  label: string;
  active: boolean;
  colors: ThemeColors;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={[
        styles.optionButton,
        {
          borderColor: active ? colors.primary : colors.border,
          backgroundColor: active ? colors.primarySoft : 'transparent',
        },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.optionLabel, { color: active ? colors.primary : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 设置分组标题 */
function SettingsSectionTitle({
  text,
  colors,
}: {
  text: string;
  colors: ThemeColors;
}): React.JSX.Element {
  return <Text style={[styles.settingsSection, { color: colors.textSecondary }]}>{text}</Text>;
}

// ============ 段落渲染组件 ============

interface SegmentItemProps {
  segment: TextSegment;
  fontSize: number;
  lineHeight: number;
  pinyinMode: PinyinMode;
  segmentHighlights: Highlight[];
  onHighlightPress: (h: Highlight) => void;
  /** 长按正文（参数为码点索引） */
  onLongPressIndex: (segmentId: string, index: number) => void;
  /** 上报段落布局位置（用于定位滚动） */
  onLayoutItem: (segmentId: string, y: number) => void;
  /** 当前篇目 ID（Chapter.id），语境化通假/读音判定 */
  workId?: string;
  /** 当前书籍 ID（Book.id），通配兜底层 */
  bookId?: string;
  /**
   * 仅渲染 [start, end) 码点区间（仿真翻页超高段落拆页用）。
   * 划线与长按回调仍以整段全局码点为基准，选区/笔记不受拆页影响。
   */
  charRange?: [number, number];
  /** 是否为拆页续块（非末块）：去掉段落下边距，保持段内行距连续 */
  isContinuation?: boolean;
}

/** 单个段落：按注音模式选择渲染器，同时承载划线/长按交互 */
const SegmentItem = React.memo(function SegmentItem({
  segment,
  fontSize,
  lineHeight,
  pinyinMode,
  segmentHighlights,
  onHighlightPress,
  onLongPressIndex,
  onLayoutItem,
  workId,
  bookId,
  charRange,
  isContinuation,
}: SegmentItemProps): React.JSX.Element {
  const segmentId = segment.id;

  const handleLongPressChar = useCallback(
    (index: number) => {
      onLongPressIndex(segmentId, index);
    },
    [onLongPressIndex, segmentId],
  );

  const handleLongPressSegment = useCallback(
    (seg: HighlightedSegment) => {
      // 'off' 模式（HighlightText）按切出的局部文本分段，
      // 长按索引需加上区间起点还原为整段全局码点索引
      onLongPressIndex(segmentId, seg.start + (charRange?.[0] ?? 0));
    },
    [onLongPressIndex, segmentId, charRange],
  );

  // 'off' 模式拆页：切出区间文本，划线偏移平移到局部坐标系
  const offModeSlice = useMemo(() => {
    if (pinyinMode !== 'off' || !charRange) {
      return null;
    }
    const [start, end] = charRange;
    const chars = Array.from(segment.text);
    const localText = chars.slice(start, end).join('');
    const localHighlights = segmentHighlights
      .map((h) => ({
        ...h,
        startOffset: h.startOffset - start,
        endOffset: h.endOffset - start,
      }))
      .filter((h) => h.endOffset > 0 && h.startOffset < end - start);
    return { localText, localHighlights };
  }, [pinyinMode, charRange, segment.text, segmentHighlights]);

  return (
    <View
      style={isContinuation ? styles.segmentContinuation : styles.segment}
      onLayout={(e) => onLayoutItem(segmentId, e.nativeEvent.layout.y)}
    >
      {pinyinMode === 'off' ? (
        offModeSlice ? (
          <HighlightText
            text={offModeSlice.localText}
            highlights={offModeSlice.localHighlights}
            onPressHighlight={onHighlightPress}
            onLongPressSegment={handleLongPressSegment}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        ) : (
          <HighlightText
            text={segment.text}
            highlights={segmentHighlights}
            onPressHighlight={onHighlightPress}
            onLongPressSegment={handleLongPressSegment}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        )
      ) : (
        <PinyinText
          text={segment.text}
          fontSize={fontSize}
          lineHeight={lineHeight}
          pinyinMode={pinyinMode}
          highlights={segmentHighlights}
          onPressHighlight={onHighlightPress}
          onLongPressChar={handleLongPressChar}
          workId={workId}
          bookId={bookId}
          charRange={charRange}
        />
      )}
    </View>
  );
});

// ============ 仿真翻页子视图 ============

/** 章标题伪块 id（分页时占位，渲染时替换为章标题文本） */
const TITLE_BLOCK_ID = '__chapter_title__';

/** 章标题块「不允许单独成页」：必须与紧随其后的段落同页（见 paginateBlocks） */
const isTitleBlock = (id: string): boolean => id === TITLE_BLOCK_ID;

/** 拆分块 id：`segId#start-end`（start/end 为该段内的码点区间，左闭右开） */
function chunkBlockId(segId: string, start: number, end: number): string {
  return `${segId}#${start}-${end}`;
}

/** 块 id -> 所属段 id（拆分块剥离 `#start-end` 后缀；普通块原样返回） */
function blockSegId(blockId: string): string {
  const hash = blockId.indexOf('#');
  return hash >= 0 ? blockId.slice(0, hash) : blockId;
}

/** 解析拆分块 id -> 码点区间；普通块返回 null */
function parseChunkRange(blockId: string): [number, number] | null {
  const hash = blockId.indexOf('#');
  if (hash < 0) {
    return null;
  }
  const rest = blockId.slice(hash + 1);
  const dash = rest.indexOf('-');
  if (dash < 0) {
    return null;
  }
  const start = Number(rest.slice(0, dash));
  const end = Number(rest.slice(dash + 1));
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
}

interface SegmentBlockItemProps {
  /** 分页块 id：普通段 id 或 `segId#start-end` 拆分块 id */
  blockId: string;
  segById: Map<string, TextSegment>;
  segCharCounts: Map<string, number>;
  fontSize: number;
  lineHeight: number;
  pinyinMode: PinyinMode;
  highlightsBySegment: Map<string, Highlight[]>;
  onHighlightPress: (h: Highlight) => void;
  onLongPressIndex: (segmentId: string, index: number) => void;
  workId?: string;
  bookId?: string;
}

/** 分页块渲染：拆分块按码点区间渲染所属段的局部（选区/划线仍按整段全局基准） */
const SegmentBlockItem = React.memo(function SegmentBlockItem({
  blockId,
  segById,
  segCharCounts,
  fontSize,
  lineHeight,
  pinyinMode,
  highlightsBySegment,
  onHighlightPress,
  onLongPressIndex,
  workId,
  bookId,
}: SegmentBlockItemProps): React.JSX.Element | null {
  const segId = blockSegId(blockId);
  const segment = segById.get(segId);
  if (!segment) {
    return null;
  }
  const range = parseChunkRange(blockId);
  const total = segCharCounts.get(segId) ?? 0;
  return (
    <SegmentItem
      segment={segment}
      fontSize={fontSize}
      lineHeight={lineHeight}
      pinyinMode={pinyinMode}
      segmentHighlights={highlightsBySegment.get(segId) ?? EMPTY_HIGHLIGHTS}
      onHighlightPress={onHighlightPress}
      onLongPressIndex={onLongPressIndex}
      onLayoutItem={() => undefined}
      workId={workId}
      bookId={bookId}
      charRange={range ?? undefined}
      isContinuation={range != null && range[1] < total}
    />
  );
});

interface PageModeViewProps {
  segments: TextSegment[];
  chapterTitle: string;
  colors: ThemeColors;
  fontSize: number;
  lineHeight: number;
  pinyinMode: PinyinMode;
  highlightsBySegment: Map<string, Highlight[]>;
  onHighlightPress: (h: Highlight) => void;
  onLongPressIndex: (segmentId: string, index: number) => void;
  workId?: string;
  bookId?: string;
  pageWidth: number;
  pageHeight: number;
  index: number;
  onIndexChange: (i: number) => void;
  onPageCountChange: (n: number) => void;
  onActiveSegmentChange: (segmentId: string | null) => void;
  onEdgeReached: (dir: 'prev' | 'next') => void;
  locateSegmentId?: string | null;
}

/**
 * 仿真翻页阅读视图：先量取每段高度（隐藏 sizer），再贪心分页，
 * 最后用 PageFlipPager 横向翻页。整段渲染，选区 / 划线偏移基准不变。
 */
function PageModeView({
  segments,
  chapterTitle,
  colors,
  fontSize,
  lineHeight,
  pinyinMode,
  highlightsBySegment,
  onHighlightPress,
  onLongPressIndex,
  workId,
  bookId,
  pageWidth,
  pageHeight,
  index,
  onIndexChange,
  onPageCountChange,
  onActiveSegmentChange,
  onEdgeReached,
  locateSegmentId,
}: PageModeViewProps): React.JSX.Element {
  const [segHeights, setSegHeights] = useState<Record<string, number>>({});
  const [titleHeight, setTitleHeight] = useState(0);
  const [titleMeasured, setTitleMeasured] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const locatedRef = useRef(false);
  /**
   * 超高段落的拆分方案：segId -> 码点边界数组（含 0 与码点总数）。
   * 边界数 > 2 表示该段被拆为多个「字符区间块」，每块独立参与分页，
   * 实现「超出一屏的段落跨多页翻页」而非页内滚动。
   */
  const [splitPlan, setSplitPlan] = useState<Record<string, number[]>>({});
  /** 拆分块高度：块 id（`segId#start-end`）-> 实测高度 */
  const [chunkHeights, setChunkHeights] = useState<Record<string, number>>({});

  // 影响「段高测量」的因素：仅排版相关（与 pageHeight 无关，段高只取决于宽度与字号/行距）。
  // 刻意不含 pageHeight：pageHeight 会因底部 dock 量高而由大变小，若纳入则会触发
  // 整段重测（清空 segHeights → 首屏闪白/空白）。pageHeight 变化只重建分页，不清测量。
  const measureKey = `${chapterTitle}|${pinyinMode}|${fontSize}|${lineHeight}|${Math.round(
    pageWidth,
  )}`;
  useEffect(() => {
    setSegHeights({});
    setTitleHeight(0);
    setTitleMeasured(false);
    setPageReady(false);
    setSplitPlan({});
    setChunkHeights({});
    locatedRef.current = false;
  }, [measureKey]);

  const recordHeight = useCallback((id: string, h: number) => {
    setSegHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  const recordChunkHeight = useCallback((id: string, h: number) => {
    setChunkHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  const segById = useMemo(() => {
    const m = new Map<string, TextSegment>();
    for (const s of segments) m.set(s.id, s);
    return m;
  }, [segments]);

  /** 各段码点数（拆分边界与选区/划线的偏移基准一致） */
  const segCharCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of segments) {
      m.set(s.id, Array.from(s.text).length);
    }
    return m;
  }, [segments]);

  // 可用页高预算：扣除页内上下 padding（pageInner 顶部 16 + 底部 16 = 32）。
  // 必须与渲染层实际的 padding 一致，否则贪心分页会把内容装到「看起来」刚好
  // 放下、实际却超出可视区，导致底部截断且无法滚动。
  const pageBudget = Math.max(80, pageHeight - 32);

  // 分页块：章标题伪块（含其底部 margin 24）+ 各段（整段或其拆分块，仅已量得高度的参与）
  // （声明在拆分决策 effect 之前：effect 需用当前 blocks 跑分页以定位超高段所在页）
  const blocks = useMemo<PaginateBlock[]>(() => {
    const list: PaginateBlock[] = [{ id: TITLE_BLOCK_ID, height: titleHeight + 24 }];
    for (const s of segments) {
      const plan = splitPlan[s.id];
      if (plan && plan.length > 2) {
        for (let i = 0; i < plan.length - 1; i++) {
          const id = chunkBlockId(s.id, plan[i], plan[i + 1]);
          const h = chunkHeights[id];
          if (typeof h === 'number') {
            list.push({ id, height: h });
          }
        }
      } else {
        const h = segHeights[s.id];
        if (typeof h === 'number') list.push({ id: s.id, height: h });
      }
    }
    return list;
  }, [segments, segHeights, chunkHeights, splitPlan, titleHeight]);

  /**
   * 拆分决策（贪心填充 + 两轮收敛）：
   * ① 整段实测高度 > pageBudget 的段 → 先用当前 blocks 跑一次分页，找到该段
   *    所在页的「已用高度」，剩余空间作为 firstBudget 传给 computeChunkBoundaries：
   *    第一块填满当前页剩余部分、后续每块填满一整页（而非均分码点导致每页都不满）。
   *    页高变化（dock 量高 / 旋转）时同步增删拆分（段高与页高无关，可复用）。
   * ② 某个已测块仍超高（线性估算误差 / 换行取整导致）→ 对该块区间递归再切；
   *    带 CHUNK_RESPLIT_TOLERANCE 容差，轻微超页交给页内纵向滚动吸收，避免碎页震荡。
   * 块边界处会强制换行（flexWrap 每字一格，视觉上与自然换行一致），
   * 块高由 sizer 实测，不依赖行高估算。
   */
  useEffect(() => {
    if (pageBudget <= 0) {
      return;
    }
    let changed = false;
    const next: Record<string, number[]> = { ...splitPlan };
    // 一轮：未拆分的超高段。用当前分页结果定位该段所在页的已用高度 → 剩余预算
    const pagesNow = paginateBlocks(blocks, pageBudget, 0, isTitleBlock);
    const usedBefore = new Map<string, number>();
    for (const p of pagesNow) {
      let used = 0;
      for (const b of p.blocks) {
        usedBefore.set(b.id, used);
        used += b.height;
      }
    }
    for (const s of segments) {
      const h = segHeights[s.id];
      if (typeof h !== 'number') {
        continue;
      }
      if (splitPlan[s.id]) {
        // 页高变大后（旋转 / dock 量高变化）整段可能不再超高：撤销拆分方案，
        // 否则 splitSettled 的「需拆分 ⇔ 已有方案」判定永久失衡卡 loading。
        if (h <= pageBudget) {
          delete next[s.id];
          changed = true;
        }
        continue;
      }
      if (h <= pageBudget) {
        continue;
      }
      const count = segCharCounts.get(s.id) ?? 0;
      const firstBudget = Math.max(0, pageBudget - (usedBefore.get(s.id) ?? 0));
      const bounds = computeChunkBoundaries(h, pageBudget, count, firstBudget);
      if (bounds.length > 2) {
        next[s.id] = bounds;
        changed = true;
      }
    }
    // 二轮：已测块仍超高（超出容差）的，在既有边界内贪心再切（firstBudget = 整页）
    for (const [segId, bounds] of Object.entries(next)) {
      const merged: number[] = [0];
      for (let i = 0; i < bounds.length - 1; i++) {
        const start = bounds[i];
        const end = bounds[i + 1];
        const chunkH = chunkHeights[chunkBlockId(segId, start, end)];
        const sub =
          typeof chunkH === 'number' && chunkH > pageBudget + CHUNK_RESPLIT_TOLERANCE
            ? computeChunkBoundaries(chunkH, pageBudget, end - start)
            : null;
        if (sub && sub.length > 2) {
          for (let j = 1; j < sub.length - 1; j++) {
            merged.push(start + sub[j]);
          }
        }
        merged.push(end);
      }
      if (merged.join(',') !== bounds.join(',')) {
        next[segId] = merged;
        changed = true;
      }
    }
    if (changed) {
      setSplitPlan(next);
    }
  }, [segments, segHeights, chunkHeights, pageBudget, segCharCounts, splitPlan, blocks]);

  /** 期望分页块总数（title + 每段的块数）：全部块量完高才允许出页 */
  const expectedBlockCount = useMemo(() => {
    let n = 1;
    for (const s of segments) {
      const plan = splitPlan[s.id];
      n += plan && plan.length > 2 ? plan.length - 1 : 1;
    }
    return n;
  }, [segments, splitPlan]);

  // 段间距传 0：blocks[].height 来自 onLayout，已包含各块自身的下外边距
  // （章标题 marginBottom 24 / 段落 marginBottom PARAGRAPH_SPACING），
  // 再传 PARAGRAPH_SPACING 会把间距算两遍 → 每页底部白空一段、首段易被挤到第二页。
  // keepWithNext：章标题不允许单独成页，否则「标题 + 长首段」超页高时会产出
  // 只有标题的空白首页（表现为「第一页没有显示本章节内容」）。
  const pages = useMemo<PaginatedPage[]>(
    () => paginateBlocks(blocks, pageBudget, 0, isTitleBlock),
    [blocks, pageBudget],
  );

  /**
   * 拆分决策是否已收敛：每个段「需要拆分 ⇔ 已有拆分方案」。
   * 若不要求此项，整段量完高的瞬间会先以「超高段独占一页（overflow）」的页型
   * 短暂出页；随后拆分方案落地、块数增加，若 pageReady 是单向闩锁（只置 true
   * 不置 false），sizer 会在拆分块高度尚未量出时被卸载，块高永远拿不到 →
   * 超高段的内容从分页中彻底消失（表现为「超出一屏的内容没有加载出来」）。
   */
  const splitSettled = useMemo(() => {
    return segments.every((s) => {
      const h = segHeights[s.id];
      if (typeof h !== 'number') {
        return false;
      }
      const needsSplit =
        computeChunkBoundaries(h, pageBudget, segCharCounts.get(s.id) ?? 0).length > 2;
      const plan = splitPlan[s.id];
      return needsSplit ? !!plan : !plan;
    });
  }, [segments, segHeights, segCharCounts, splitPlan, pageBudget]);

  // 全部段（含标题与拆分块）均完成测量、拆分决策收敛后再出页。
  // pageReady 必须双向：条件被打破（如拆分方案落地导致块数增加）时置回 false，
  // 让隐藏 sizer 重新挂载量取新块的高度，收敛后再次出页。
  useEffect(() => {
    const ready =
      pageWidth > 0 &&
      pageHeight > 0 &&
      titleMeasured &&
      splitSettled &&
      blocks.length === expectedBlockCount;
    setPageReady(ready);
  }, [pageWidth, pageHeight, titleMeasured, splitSettled, blocks.length, expectedBlockCount]);

  // 上报总页数（供进度条使用）
  useEffect(() => {
    if (pageReady) onPageCountChange(pages.length);
  }, [pageReady, pages.length, onPageCountChange]);

  // 页数收缩（如切到更短的章）时钳制当前页
  useEffect(() => {
    if (pageReady && pages.length > 0 && index > pages.length - 1) {
      onIndexChange(Math.max(0, pages.length - 1));
    }
  }, [pageReady, pages.length, index, onIndexChange]);

  // 定位：打开时跳到含目标段落的页（仅一次；目标段可能被拆成多个区间块）
  useEffect(() => {
    if (!pageReady || locatedRef.current || !locateSegmentId) {
      return;
    }
    const idx = pages.findIndex((p) =>
      p.blocks.some((b) => blockSegId(b.id) === locateSegmentId),
    );
    if (idx >= 0) {
      locatedRef.current = true;
      onIndexChange(idx);
    }
  }, [pageReady, locateSegmentId, pages, onIndexChange]);

  // 当前页首个真实段落写回阅读位置（便于续读；拆分块还原为所属段 id）
  useEffect(() => {
    if (!pageReady) {
      return;
    }
    const page = pages[index];
    const first = page?.blocks.find((b) => b.id !== TITLE_BLOCK_ID);
    onActiveSegmentChange(first ? blockSegId(first.id) : null);
  }, [pageReady, pages, index, onActiveSegmentChange]);

  const renderPageContent = useCallback(
    (pageIndex: number) => {
      const page = pages[pageIndex];
      if (!page) {
        return null;
      }
      // 页内纵向滚动始终开启：正常分页因字号 / 行距 / 测量误差导致本页内容
      // 略超页高时，仍可在页内纵向滚动阅读（超高段已按码点区间拆块，不再依赖此兜底）。
      // 横向翻页由外层 PageFlipPager 的横向 ScrollView 处理，与本层纵向滚动方向正交。
      return (
        <ScrollView
          style={[styles.pageScroll, { height: pageHeight }]}
          scrollEnabled
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <View style={[styles.pageInner, { width: pageWidth }]}>
            {page.blocks.map((b) =>
              b.id === TITLE_BLOCK_ID ? (
                <Text key={b.id} style={[styles.chapterTitle, { color: colors.text }]}>
                  {chapterTitle}
                </Text>
              ) : (
                <SegmentBlockItem
                  key={b.id}
                  blockId={b.id}
                  segById={segById}
                  segCharCounts={segCharCounts}
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                  pinyinMode={pinyinMode}
                  highlightsBySegment={highlightsBySegment}
                  onHighlightPress={onHighlightPress}
                  onLongPressIndex={onLongPressIndex}
                  workId={workId}
                  bookId={bookId}
                />
              ),
            )}
          </View>
        </ScrollView>
      );
    },
    [
      pages,
      chapterTitle,
      colors,
      segById,
      segCharCounts,
      fontSize,
      lineHeight,
      pinyinMode,
      highlightsBySegment,
      onHighlightPress,
      onLongPressIndex,
      workId,
      bookId,
      pageWidth,
      pageHeight,
    ],
  );

  if (pageWidth <= 0 || pageHeight <= 0) {
    return <View style={styles.pageModeRoot} />;
  }

  return (
    <View style={styles.pageModeRoot}>
      {!pageReady && (
        <View style={styles.sizer} pointerEvents="none">
          <View style={styles.pageInner}>
            <Text
              onLayout={(e) => {
                setTitleHeight(e.nativeEvent.layout.height);
                setTitleMeasured(true);
              }}
              style={[styles.chapterTitle, { color: colors.text }]}
            >
              {chapterTitle}
            </Text>
            {segments.map((seg) => {
              const plan = splitPlan[seg.id];
              const total = segCharCounts.get(seg.id) ?? 0;
              // 已拆分的段：渲染各码点区间块（供 recordChunkHeight 量高），
              // 形成「整段量高 → 定超高 → 拆块 → 块量高 → 出页」的闭环；
              // 未拆分的段：整段渲染（供 recordHeight 量高）。
              if (plan && plan.length > 2) {
                return plan.slice(0, -1).map((start, i) => {
                  const end = plan[i + 1];
                  const chunkId = chunkBlockId(seg.id, start, end);
                  return (
                    <View
                      key={chunkId}
                      onLayout={(e) =>
                        recordChunkHeight(chunkId, e.nativeEvent.layout.height)
                      }
                    >
                      <SegmentItem
                        segment={seg}
                        fontSize={fontSize}
                        lineHeight={lineHeight}
                        pinyinMode={pinyinMode}
                        segmentHighlights={
                          highlightsBySegment.get(seg.id) ?? EMPTY_HIGHLIGHTS
                        }
                        onHighlightPress={onHighlightPress}
                        onLongPressIndex={onLongPressIndex}
                        onLayoutItem={() => undefined}
                        workId={workId}
                        bookId={bookId}
                        charRange={[start, end]}
                        isContinuation={end < total}
                      />
                    </View>
                  );
                });
              }
              return (
                <View
                  key={seg.id}
                  onLayout={(e) => recordHeight(seg.id, e.nativeEvent.layout.height)}
                >
                  <SegmentItem
                    segment={seg}
                    fontSize={fontSize}
                    lineHeight={lineHeight}
                    pinyinMode={pinyinMode}
                    segmentHighlights={highlightsBySegment.get(seg.id) ?? EMPTY_HIGHLIGHTS}
                    onHighlightPress={onHighlightPress}
                    onLongPressIndex={onLongPressIndex}
                    onLayoutItem={() => undefined}
                    workId={workId}
                    bookId={bookId}
                  />
                </View>
              );
            })}
          </View>
        </View>
      )}
      {pageReady ? (
        <PageFlipPager
          index={index}
          pageCount={pages.length}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          colors={colors}
          onIndexChange={onIndexChange}
          onEdgeReached={onEdgeReached}
          renderPage={renderPageContent}
        />
      ) : (
        <View style={styles.pageLoading}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}
    </View>
  );
}

// ============ 主页面 ============

function ReaderScreen({ route, navigation }: ReaderScreenProps): React.JSX.Element {
  // 设置（阅读纸张/字号/行距/注音模式）
  const paper = useSettingsStore((s) => s.paper);
  const setPaper = useSettingsStore((s) => s.setPaper);
  const readerMode = useSettingsStore((s) => s.readerMode);
  const setReaderMode = useSettingsStore((s) => s.setReaderMode);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const pinyinMode = useSettingsStore((s) => s.pinyinMode);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setLineHeight = useSettingsStore((s) => s.setLineHeight);
  const setPinyinMode = useSettingsStore((s) => s.setPinyinMode);
  const conversionMode = useSettingsStore((s) => s.conversionMode);
  const setConversionMode = useSettingsStore((s) => s.setConversionMode);
  // 正文朗读（P2-02）：语速（持久化，0.5–2.0）与朗读状态
  const speechRate = useSettingsStore((s) => s.speechRate);
  const setSpeechRate = useSettingsStore((s) => s.setSpeechRate);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);

  const colors: ThemeColors = getPaperColors(paper);

  // 文本数据
  const [book, setBook] = useState<Book | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 连续滚动模式：已拼接的章节序列（首项为当前打开章，滚到末尾向后追加） */
  const [continuousChapters, setContinuousChapters] = useState<Chapter[]>([]);
  /** 实际正在阅读的章节（滚动跨章后与路由 chapterId 不同），初值在 chapterId 解析后给出 */
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  /** continuousChapters 的即时引用：滚动回调需读到最新值，避免闭包陈旧 */
  const continuousRef = useRef<Chapter[]>([]);
  /** activeChapterId 的即时引用（滚动回调内高频读写，避免闭包陈旧） */
  const activeChapterIdRef = useRef<string | null>(null);
  /** 行 id -> 内容内偏移（打开定位 + 章内进度计算共用） */
  const rowOffsets = useRef<Map<string, number>>(new Map());
  /** 追加下一章的并发/重复守卫 */
  const loadingNext = useRef(false);
  /** 向前拼接上一章的并发/重复守卫 */
  const loadingPrev = useRef(false);
  /**
   * 向前拼接时的滚动锚点。
   * 在列表【头部】插入行会让既有内容整体下移，若不补偿偏移，视觉上会瞬间跳到
   * 上一章。补偿方式：插入后监听「原首章标题行」的 onLayout —— 它的新 y 值
   * 恰好等于插入内容的高度（插入章的行都在它上面），据此一次性精确落位。
   *
   * 不再用「onContentSizeChange 增量累加」方案：VirtualizedList 的 contentSize
   * 在滚动 / 窗口化过程中会因估算修正反复变化，锚点若迟迟不收敛（如 scrollToOffset
   * 被钳制导致 onScroll 永远对不上目标），会同时造成两个严重后果——
   * ① 阻塞 appendNextChapter（守卫 prependAnchor.current）→ 再也加载不了下一章；
   * ② 每次 contentSize 变化都把用户拽回陈旧偏移 → 完全无法滚动。
   * 精确锚点 + 超时兜底（ANCHOR_TIMEOUT_MS）保证锚点存活期最多一两个布局帧。
   */
  const prependAnchor = useRef<{
    /** 原首章标题行 id：其重新布局后的 y = 插入内容总高 */
    firstRowId: string;
    /** 插入时的滚动偏移（补偿基准） */
    baseOffset: number;
    /** 创建时间：超时未解析则放弃补偿（防卡死） */
    createdAt: number;
    /** 插入前的 rowOffsets 快照：解析时把未重新布局的旧行偏移整体下移 */
    snapshot: Map<string, number>;
  } | null>(null);
  /** 最近一次滚动偏移（向前拼接的补偿起点） */
  const scrollOffset = useRef(0);
  /** 滚动模式列表引用（定位段落 + 向前拼接后的偏移补偿） */
  const listRef = useRef<FlatList<ReaderRow>>(null);
  /** 打开时一次性定位到目标段落：行 id + 是否已完成 */
  const pendingScroll = useRef({ target: '', done: false });
  /** 「打开时定位」的超时放弃计时器（同一时刻至多一个，见 LOCATE_TIMEOUT_MS） */
  const locateGiveUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 武装/重新武装「打开时定位」：目标行 onLayout 后由 handleRowLayout 落位。
   * 目标行若超出初始渲染窗口且无历史布局数据，onLayout 永远不会触发；
   * 超时放弃定位（落回章首属可接受降级），同时避免 pendingScroll 未完成的
   * 守卫把向前拼接卡死。重复武装先清旧计时器，保证计时器始终对应最新目标。
   */
  const armScrollLocate = useCallback(
    (target: string) => {
      pendingScroll.current = { target, done: false };
      if (locateGiveUpTimer.current) {
        clearTimeout(locateGiveUpTimer.current);
      }
      if (!target) {
        locateGiveUpTimer.current = null;
        return;
      }
      locateGiveUpTimer.current = setTimeout(() => {
        if (!pendingScroll.current.done) {
          pendingScroll.current.done = true;
        }
      }, LOCATE_TIMEOUT_MS);
    },
    [pendingScroll],
  );

  // 交互状态
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionVisible, setSelectionVisible] = useState(false);
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [analysisText, setAnalysisText] = useState('');
  // 选段在线翻译（P0：用户自带 Key 的服务商适配器）
  const [translationVisible, setTranslationVisible] = useState(false);
  const [translationText, setTranslationText] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [tocVisible, setTocVisible] = useState(false);
  /** 当前章节内滚动进度（0~1），用于阅读进度条（滚动模式） */
  const [scrollFrac, setScrollFrac] = useState(0);
  const contentH = useRef(0);
  const viewH = useRef(0);
  // 仿真翻页模式状态
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [pagerLayout, setPagerLayout] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  /**
   * 翻页模式的定位目标段（PageModeView.locateSegmentId）。
   * 打开/切章时取路由参数；模式切换时取 useReaderStore 里的当前段（Bug 3）。
   */
  const [locateTarget, setLocateTarget] = useState<string | null>(null);
  // 底部浮动 dock（进度 + 注音模式 + 工具栏）为绝对定位，悬浮在正文之上。
  // 若不扣除其高度，仿真翻页会把整页当成「铺满 pagerArea（含 dock 区域）」来分页，
  // 导致正文底部被 dock 遮挡、且因内容「恰好放下」而没有任何可滚动空间 → 看起来像卡死。
  const [dockHeight, setDockHeight] = useState(0);
  // 仿真翻页可用页高 = pagerArea 高度 - 底部 dock 高度（可见区域）。
  // 仅在 pagerArea 已完成量高后给有效值；首帧 pagerLayout.height=0 时保持 0，
  // 让 PageModeView 走占位/测量态，避免「最小 80」在首帧触发一次错误分页与定位跳页。
  const measured = pagerLayout.height > 0;
  const visiblePageHeight = measured ? Math.max(80, pagerLayout.height - dockHeight) : 0;

  const params = route?.params;
  const bookId = params?.bookId ?? null;
  const chapterId = params?.chapterId ?? null;
  // 提取为原始值参与依赖比较：route/params 为父组件（ContinueReading）每次渲染
  // 新建的对象，若以对象引用作依赖会引发 setState 无限循环（Maximum update depth）
  const segmentId = params?.segmentId ?? null;

  /**
   * P1-17 段落级续读：路由未携带 segmentId 时，从持久化 lastRead 恢复该章
   * 上次阅读到的段落；旧数据无 segmentId / 跨章跳转时为 null（回章首，同现状）。
   * 定位失败（段落不存在或数据越界）由既有 LOCATE_TIMEOUT_MS 超时机制兜底回章首。
   */
  const restoreSegmentId = useMemo<string | null>(() => {
    if (segmentId || !bookId || !chapterId) {
      return null;
    }
    const last = useReaderStore.getState().lastRead;
    return last !== null &&
      last.bookId === bookId &&
      last.chapterId === chapterId
      ? last.segmentId ?? null
      : null;
  }, [segmentId, bookId, chapterId]);

  /**
   * 按当前繁简模式转换文本：正文段落、章标题、书名统一走此入口，
   * 保证「已展示章」与「后续拼接章」视觉一致、切换不错位。
   */
  const toDisplayText = useCallback(
    (text: string): string => {
      if (conversionMode === 'simplified') {
        return text;
      }
      return ConversionService.toTraditional(text).data ?? text;
    },
    [conversionMode],
  );

  /** 按当前繁简模式转换段落（文本无变化时复用原对象，保持引用稳定） */
  const toDisplaySegment = useCallback(
    (seg: TextSegment): TextSegment => {
      const text = toDisplayText(seg.text);
      return text === seg.text ? seg : { ...seg, text };
    },
    [toDisplayText],
  );

  /** 标题按当前繁简模式显示（整本书视觉统一） */
  const displayBookTitle = useMemo(() => {
    if (!book) return '';
    return toDisplayText(book.title);
  }, [book, toDisplayText]);

  const displayChapterTitle = useMemo(() => {
    if (!chapter) return '';
    return toDisplayText(chapter.title);
  }, [chapter, toDisplayText]);

  // 用户数据（划线/笔记/收藏）
  // 滚动模式跨章后路由 chapterId 仍停留在入口章，故按「已拼接章节集合」整体加载，
  // 否则后续章节的历史划线/笔记读不到（表现为划线不显示、点划线重复建笔记）。
  const annotationScope = useMemo<string[] | undefined>(() => {
    if (readerMode === 'scroll') {
      return continuousChapters.map((c) => c.id);
    }
    return chapterId ? [chapterId] : undefined;
  }, [readerMode, continuousChapters, chapterId]);
  const { highlights, addHighlight } = useHighlightsForChapters(
    bookId ?? undefined,
    annotationScope,
  );
  const { notes, addNote, updateNote } = useNotesForChapters(bookId ?? undefined, annotationScope);
  const { addBookmark } = useBookmarks();

  // 初始化：加载书籍与章节，记录阅读位置，初始化数据库（幂等）
  useEffect(() => {
    if (!bookId || !chapterId) {
      setLoadError('缺少书籍或章节参数');
      return;
    }
    const bookRes = TextLibraryService.getBook(bookId);
    const chapterRes = TextLibraryService.getChapter(chapterId);
    if (!bookRes.success || !bookRes.data) {
      setLoadError(bookRes.error ?? '加载书籍失败');
      return;
    }
    if (!chapterRes.success || !chapterRes.data) {
      setLoadError(chapterRes.error ?? '加载章节失败');
      return;
    }
    StorageService.initDatabase();
    setBook(bookRes.data);
    setChapter(chapterRes.data);
    // P1-17：路由携带 segmentId（书架/收藏跳转）优先；否则用持久化的段落级进度续读
    useReaderStore
      .getState()
      .openChapter(bookId, chapterId, (segmentId ?? restoreSegmentId) ?? undefined);
    // 依赖不含 restoreSegmentId：它仅随 bookId / chapterId / segmentId 变化（均在依赖中），
    // 变化触发的新一轮渲染闭包中即取到最新值，无需纳入依赖
  }, [bookId, chapterId, segmentId]);

  // 相邻章节（用于上一章 / 下一章翻页）
  const siblings = useMemo<{ prev?: Chapter; next?: Chapter }>(() => {
    if (!chapterId) {
      return {};
    }
    const res = TextLibraryService.getSiblingChapters(chapterId);
    return res.success && res.data ? res.data : {};
  }, [chapterId]);

  /** 跳转至指定章节（翻页） */
  const goToChapter = useCallback(
    (cid: string) => {
      if (!bookId) {
        return;
      }
      navigation?.navigate('Reader', { bookId, chapterId: cid });
    },
    [navigation, bookId],
  );

  /** 仿真翻页：翻到章尾继续翻 → 跨到下一章；翻到章首继续翻 → 跨到上一章。
   *  PageFlipPager 仅在第 0 / 最后一页继续翻时才回调 onEdgeReached，
   *  故章内正常翻页不会跨章，只有翻到边界才会进下一章（贴近实体书翻页语义）。 */
  const handlePageEdge = useCallback(
    (dir: 'prev' | 'next') => {
      if (dir === 'prev' && siblings.prev) {
        goToChapter(siblings.prev.id);
      } else if (dir === 'next' && siblings.next) {
        goToChapter(siblings.next.id);
      }
    },
    [siblings, goToChapter],
  );

  /** 仿真翻页：当前页首个真实段落写回阅读位置，便于续读 */
  const handlePageActiveSegment = useCallback((segId: string | null) => {
    if (segId) {
      useReaderStore.getState().setSegment(segId);
    }
  }, []);

  // 切换到仿真翻页 / 切换章节时，回到第一页（定位会在 PageModeView 内生效）
  useEffect(() => {
    if (readerMode === 'page') {
      setPageIndex(0);
    }
  }, [readerMode, chapterId]);

  // 切换阅读模式：滚动列表会重新挂载，上一轮的 contentSize / 偏移度量已失效，
  // 必须清零重取，否则「向前拼接」会拿陈旧高度当基准做出错误的偏移补偿。
  useEffect(() => {
    contentH.current = 0;
    viewH.current = 0;
    scrollOffset.current = 0;
    prependAnchor.current = null;
    loadingNext.current = false;
    loadingPrev.current = false;
    // 模式切换定位：两种模式都会把当前段上报到 useReaderStore（滚动模式经
    // onViewableItemsChanged、翻页模式经 onActiveSegmentChange），切换后以它
    // 为定位目标，而不是跳回章首。
    const seg = useReaderStore.getState().segmentId;
    // 跨章跟随：连续滚动拼接后，当前段可能属于其它章（store 段 ∉ 路由章）。
    // 此时不能把「其它章的段」交给单章视图定位——page 模式按路由章渲染、
    // scroll 模式仅以路由章为拼接起点，定位都会静默失败回退章首。
    // 改为携带 segmentId 导航到该段真实所属章，走既有「打开 → 切章 effect
    // → 定位武装」链路：切章 effect 会把 locateTarget / pendingScroll 指向
    // 路由 segmentId，新章量高完成后定位依然有效（measureKey 重置不会吞掉它）。
    const segChapter = seg ? segmentChapterMap.get(seg) : undefined;
    if (seg && segChapter && segChapter !== chapterId && bookId) {
      navigation?.navigate('Reader', { bookId, chapterId: segChapter, segmentId: seg });
      return undefined;
    }
    if (readerMode === 'scroll') {
      // 武装「打开时定位」：目标行布局后由 handleRowLayout 落位，超时放弃兜底
      armScrollLocate(seg ?? '');
      return () => {
        if (locateGiveUpTimer.current) {
          clearTimeout(locateGiveUpTimer.current);
          locateGiveUpTimer.current = null;
        }
      };
    }
    setLocateTarget(seg ?? null);
    return undefined;
    // 依赖仅 readerMode：切章 / 拼接更新不得重跑本 effect（会重新武装定位把
    // 用户拽离当前位置）；跨章判断所需的 segmentChapterMap / chapterId 在
    // readerMode 变化的那次渲染闭包中即已是最新值。
  }, [readerMode]);

  // 阅读进度（目录抽屉与底部进度条共用）
  const totalChapters = book?.chapters?.length ?? 0;
  // 滚动模式可跨章连续阅读：进度按「实际正在阅读的章」计算，而非路由打开的章。
  // 仿真翻页模式一屏仍只呈现一章，保持按打开章计算。
  const progressChapterId = readerMode === 'scroll' ? activeChapterId ?? chapterId : chapterId;
  const chapterIndex = book?.chapters?.findIndex((c) => c.id === progressChapterId) ?? -1;
  // 仿真翻页模式下，章内进度由「当前页 / 总页数」给出；滚动模式由滚动偏移给出
  const pageFrac = readerMode === 'page' && pageCount > 0 ? (pageIndex + 0.5) / pageCount : scrollFrac;
  const overallProgress =
    totalChapters > 0
      ? clamp((Math.max(0, chapterIndex) + pageFrac) / totalChapters, 0, 1)
      : 0;

  // 段落显示文本：在「数据层」统一按当前繁简模式转换，
  // 渲染 / 选区码点 / 划线偏移三者均基于此处转换后的文本，保证一致、切换不错位。
  const displaySegments = useMemo<TextSegment[]>(() => {
    if (!chapter) return [];
    return chapter.segments.map(toDisplaySegment);
  }, [chapter, toDisplaySegment]);

  // ---------- 连续滚动：跨章拼接（仅滚动模式使用） ----------

  // 章节（重新）加载时重置拼接序列：以当前章为起点，向后追加、向前拼接。
  // 仿真翻页模式同样维护该序列（仅含当前章），用于「段落 -> 所属章」反查。
  useEffect(() => {
    const seeded: Chapter[] = chapter ? [chapter] : [];
    continuousRef.current = seeded;
    loadingNext.current = false;
    loadingPrev.current = false;
    prependAnchor.current = null;
    scrollOffset.current = 0;
    rowOffsets.current.clear();
    setContinuousChapters(seeded);
  }, [chapter, rowOffsets]);

  /**
   * 锚点超时检查：超过 ANCHOR_TIMEOUT_MS 仍未解析（锚点行未重新布局）则放弃补偿。
   * 放弃仅意味着视野可能跳到上一章开头（可接受的降级），但换回两件更重要的事：
   * ① appendNextChapter 的锚点守卫解除，向后追加恢复；② 用户滚动不再被拽回。
   * 注意：本函数必须在每次「尝试向前拼接」的入口处也被调用——用户停在顶部时
   * 不产生滚动事件，超时清理若只挂在 onScroll/onContentSizeChange 上，
   * 残留锚点会永久阻塞后续拼接（表现为「要再下拉一次才能加载上一章」）。
   */
  const expireAnchorIfNeeded = useCallback(() => {
    const anchor = prependAnchor.current;
    if (anchor != null && Date.now() - anchor.createdAt > ANCHOR_TIMEOUT_MS) {
      prependAnchor.current = null;
    }
  }, []);

  /**
   * 追加下一章到连续滚动序列。
   * 五重守卫：①仅滚动模式 ②无并发加载 ③未达拼接上限 ④存在下一章（不越过末章） ⑤未重复追加。
   */
  const appendNextChapter = useCallback(() => {
    // 正在做「向前拼接」的偏移补偿时不要追加：两者的 contentSize 变化会互相干扰
    if (readerMode !== 'scroll' || loadingNext.current || prependAnchor.current || !book) {
      return;
    }
    const loaded = continuousRef.current;
    if (loaded.length === 0 || loaded.length >= MAX_CONTINUOUS_CHAPTERS) {
      return;
    }
    const lastId = loaded[loaded.length - 1].id;
    const chapters = book.chapters;
    const idx = chapters.findIndex((c) => c.id === lastId);
    const next = idx >= 0 ? chapters[idx + 1] : undefined;
    if (!next || loaded.some((c) => c.id === next.id)) {
      return;
    }
    loadingNext.current = true;
    const res = TextLibraryService.getChapter(next.id);
    loadingNext.current = false;
    if (!res.success || !res.data) {
      return;
    }
    const loadedChapter = res.data;
    // 二次去重：避免同一章在状态提交前被重复追加
    if (continuousRef.current.some((c) => c.id === loadedChapter.id)) {
      return;
    }
    const merged = [...continuousRef.current, loadedChapter];
    continuousRef.current = merged;
    setContinuousChapters(merged);
  }, [book, readerMode]);

  /** 滚至接近末尾：追加下一章（FlatList onEndReached 回调） */
  const handleEndReached = useCallback(() => {
    appendNextChapter();
  }, [appendNextChapter]);

  /**
   * 在连续滚动序列【头部】插入上一章。
   * 五重守卫：①仅滚动模式 ②无并发加载 ③无尚未完成的偏移补偿 ④未达拼接上限
   * ⑤存在上一章（不越过首章）且未重复插入。
   */
  const prependPreviousChapter = useCallback(() => {
    // 入口先做锚点超时清理：停在顶部无滚动事件时，残留锚点若不在此处过期，
    // 会永久阻塞向前拼接（「再下拉一次才行」的根因）。
    expireAnchorIfNeeded();
    if (
      readerMode !== 'scroll' ||
      loadingPrev.current ||
      prependAnchor.current != null ||
      !book
    ) {
      return;
    }
    const loaded = continuousRef.current;
    if (loaded.length === 0 || loaded.length >= MAX_CONTINUOUS_CHAPTERS) {
      return;
    }
    const firstId = loaded[0].id;
    const chapters = book.chapters;
    const idx = chapters.findIndex((c) => c.id === firstId);
    const prev = idx > 0 ? chapters[idx - 1] : undefined;
    if (!prev || loaded.some((c) => c.id === prev.id)) {
      return;
    }
    loadingPrev.current = true;
    const res = TextLibraryService.getChapter(prev.id);
    loadingPrev.current = false;
    if (!res.success || !res.data) {
      return;
    }
    const prevChapter = res.data;
    // 二次去重：避免同一章在状态提交前被重复插入
    if (continuousRef.current.some((c) => c.id === prevChapter.id)) {
      return;
    }
    // 「打开时定位到指定段落」尚未完成时不要插入：两者都会调 scrollToOffset，
    // 会互相覆盖。等定位落位后由滚动事件按需触发（滚到顶部才需要上一章）。
    if (pendingScroll.current.target && !pendingScroll.current.done) {
      return;
    }
    prependAnchor.current = {
      firstRowId: `${TITLE_ROW_PREFIX}${firstId}`,
      baseOffset: scrollOffset.current,
      createdAt: Date.now(),
      snapshot: new Map(rowOffsets.current),
    };
    const merged = [prevChapter, ...continuousRef.current];
    continuousRef.current = merged;
    setContinuousChapters(merged);
  }, [book, readerMode, pendingScroll, rowOffsets, expireAnchorIfNeeded]);

  /** 滚至接近顶部：向前拼接上一章（FlatList onStartReached 回调） */
  const handleStartReached = useCallback(() => {
    prependPreviousChapter();
  }, [prependPreviousChapter]);

  /** 连续滚动行：每章 = 1 个章标题行 + N 个段落行 */
  const continuousRows = useMemo<ReaderRow[]>(() => {
    const rows: ReaderRow[] = [];
    for (const ch of continuousChapters) {
      rows.push({
        id: `${TITLE_ROW_PREFIX}${ch.id}`,
        chapterId: ch.id,
        title: toDisplayText(ch.title),
        segment: null,
      });
      for (const seg of ch.segments) {
        rows.push({
          id: seg.id,
          chapterId: ch.id,
          title: null,
          segment: toDisplaySegment(seg),
        });
      }
    }
    return rows;
  }, [continuousChapters, toDisplayText, toDisplaySegment]);

  /** 连续滚动涉及的全部段落（供选词码点基准覆盖后续章节） */
  const continuousSegments = useMemo<TextSegment[]>(() => {
    const list: TextSegment[] = [];
    for (const row of continuousRows) {
      if (row.segment) {
        list.push(row.segment);
      }
    }
    return list;
  }, [continuousRows]);

  /**
   * 段落 -> 所属章节 ID。
   * 跨章连续滚动后，选区可能落在后续章节，划线 / 笔记必须按「段落真实所属章」归档，
   * 否则会写错 chapterId 导致划线永不渲染。
   */
  const segmentChapterMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of continuousRows) {
      if (row.segment) {
        map.set(row.segment.id, row.chapterId);
      }
    }
    return map;
  }, [continuousRows]);

  // 段落码点数组缓存（选词范围计算基准，基于转换后文本）
  const segmentCharsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    // 滚动模式正文跨章，码点基准需覆盖全部已拼接段落
    const source = readerMode === 'scroll' ? continuousSegments : displaySegments;
    for (const seg of source) {
      map.set(seg.id, Array.from(seg.text));
    }
    return map;
  }, [readerMode, continuousSegments, displaySegments]);

  // 划线按段落分组（引用稳定，保证 SegmentItem memo 生效）
  const highlightsBySegment = useMemo(() => {
    const map = new Map<string, Highlight[]>();
    for (const h of highlights) {
      const arr = map.get(h.segmentId);
      if (arr) {
        arr.push(h);
      } else {
        map.set(h.segmentId, [h]);
      }
    }
    return map;
  }, [highlights]);

  // ---------- 正文朗读（P2-02） ----------

  /** 段落 id -> 展示文本（经繁简转换，与正文渲染一致；标题行走不含） */
  const speechTextMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of continuousRows) {
      if (row.segment) {
        map.set(row.segment.id, row.segment.text);
      }
    }
    return map;
  }, [continuousRows]);

  /**
   * 切章 / 卸载时停止朗读：避免上一章的朗读串音到新章；
   * 段内滚动不中断朗读（仅提示当前段为按下「朗读」时锁定的段落）。
   */
  useEffect(() => {
    TtsService.stopSpeech();
    setTtsSpeaking(false);
  }, [chapterId]);

  /** 朗读完成 / 失败事件：复位朗读状态（事件由原生 TtsModule 发出） */
  useEffect(() => {
    const finishSub = TtsService.onSpeechFinish(() => setTtsSpeaking(false));
    const errorSub = TtsService.onSpeechError(() => setTtsSpeaking(false));
    return () => {
      finishSub.remove();
      errorSub.remove();
    };
  }, []);

  /** 朗读 / 停止当前段落：取阅读位置 store 中的当前段（无则回章首段） */
  const handleToggleSpeech = useCallback(async () => {
    if (ttsSpeaking) {
      TtsService.stopSpeech();
      setTtsSpeaking(false);
      return;
    }
    const store = useReaderStore.getState();
    const segId = store.segmentId ?? chapter?.segments[0]?.id ?? null;
    const text = segId ? speechTextMap.get(segId) : null;
    if (!segId || !text) {
      Alert.alert('朗读', '当前没有可朗读的段落');
      return;
    }
    const available = await TtsService.isTtsAvailable();
    if (!available) {
      Alert.alert('朗读', '当前设备不支持语音朗读');
      return;
    }
    const res = await TtsService.speakText(text, speechRate);
    if (res.success) {
      setTtsSpeaking(true);
    } else {
      Alert.alert('朗读', res.error ?? '朗读启动失败');
    }
  }, [ttsSpeaking, chapter, speechTextMap, speechRate]);

  /** 语速步进（−/+ 0.25，范围 0.5–2.0，持久化到设置） */
  const handleStepSpeechRate = useCallback(
    (dir: 1 | -1) => {
      setSpeechRate(stepSpeechRate(speechRate, dir));
    },
    [speechRate, setSpeechRate],
  );

  // ---------- 定位滚动到指定段落 ----------

  /**
   * 行布局上报：记录该行在内容内的纵向偏移。
   * 三个用途：①打开时一次性定位到目标段落；②计算「当前章内」滚动进度；
   * ③向前拼接的偏移补偿——原首章标题行重新布局后的 y 恰为插入内容总高。
   */
  const handleRowLayout = useCallback(
    (rowId: string, y: number) => {
      rowOffsets.current.set(rowId, y);
      const pending = pendingScroll.current;
      if (!pending.done && pending.target === rowId) {
        const targetOffset = Math.max(0, y - 24);
        pending.done = true;
        listRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
        // 定位落点贴近顶部时主动触发一次向前拼接：续读打开在章首附近的场景下，
        // onContentSizeChange 的首次兜底可能被 pendingScroll 未完成的守卫挡掉，
        // 而停在 offset≈0 处不会再产生滚动事件，用户必须「来回滚动」才能触发。
        if (viewH.current <= 0 || targetOffset <= viewH.current * CONTIGUOUS_PRELOAD_SCREENS) {
          prependPreviousChapter();
        }
      }
      const anchor = prependAnchor.current;
      if (anchor != null && rowId === anchor.firstRowId && y > 0) {
        // 原首章标题行落位：y = 插入内容总高，一次性精确补偿。
        // 未重新布局的旧行（不在当前渲染窗口内）按快照整体下移 y，
        // 已重新布局的行（值 != 快照）保持新值，避免二次偏移。
        anchor.snapshot.forEach((oldY, key) => {
          if (rowOffsets.current.get(key) === oldY) {
            rowOffsets.current.set(key, oldY + y);
          }
        });
        // 补偿基准用「解析时刻」的实际偏移而非触发时的快照（baseOffset）：
        // 从触发到锚点行重新布局之间用户可能仍在滚动，用陈旧基准会把视野
        // 拽回触发点，造成可见的回跳生硬感。
        listRef.current?.scrollToOffset({
          offset: Math.max(0, scrollOffset.current + y),
          animated: false,
        });
        prependAnchor.current = null;
      }
    },
    [rowOffsets, prependPreviousChapter],
  );

  /**
   * P1-17 滚动进度防抖记录：滚动/视口变化时只暂存候选段落，滚动停止
   * 300ms 后才提交到 useReaderStore（recordProgress 同步 lastRead.segmentId），
   * 避免连续滚动期间高频写持久化。跨章切换仍由 openChapter 即时提交。
   */
  const SEGMENT_RECORD_DEBOUNCE_MS = 300;
  const segmentRecordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSegmentRecord = useRef<{ segmentId: string; chapterId: string } | null>(null);

  /** 提交暂存的段落进度（暂存章与当前章不一致时丢弃，防止跨章后误写旧段） */
  const flushSegmentRecord = useCallback(() => {
    if (segmentRecordTimer.current) {
      clearTimeout(segmentRecordTimer.current);
      segmentRecordTimer.current = null;
    }
    const pending = pendingSegmentRecord.current;
    pendingSegmentRecord.current = null;
    if (!pending) {
      return;
    }
    const store = useReaderStore.getState();
    if (pending.chapterId === store.chapterId) {
      store.recordProgress(pending.segmentId);
    }
  }, []);

  /** 暂存并重置 300ms 防抖计时器 */
  const scheduleSegmentRecord = useCallback(
    (rowSegmentId: string, rowChapterId: string) => {
      pendingSegmentRecord.current = { segmentId: rowSegmentId, chapterId: rowChapterId };
      if (segmentRecordTimer.current) {
        clearTimeout(segmentRecordTimer.current);
      }
      segmentRecordTimer.current = setTimeout(flushSegmentRecord, SEGMENT_RECORD_DEBOUNCE_MS);
    },
    [flushSegmentRecord],
  );

  // 卸载时清理防抖计时器，避免离屏后误写进度
  useEffect(() => {
    return () => {
      if (segmentRecordTimer.current) {
        clearTimeout(segmentRecordTimer.current);
        segmentRecordTimer.current = null;
      }
    };
  }, []);

  /**
   * 滚动时更新当前阅读段落，并在跨章时同步「实际所在章」：
   * - 段内位置：防抖 300ms 后 recordProgress（P1-17，同步 lastRead.segmentId）
   * - 跨章：openChapter 连同 segmentId 一起即时持久化，保证续读落在正确章节
   */
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: { item: ReaderRow }[] }) => {
      const row = viewableItems.find((v) => v.item.segment !== null)?.item;
      if (!row || !row.segment) {
        return;
      }
      const rowSegmentId = row.segment.id;
      if (row.chapterId !== activeChapterIdRef.current) {
        activeChapterIdRef.current = row.chapterId;
        setActiveChapterId(row.chapterId);
        const currentBookId = useReaderStore.getState().bookId;
        if (currentBookId) {
          // openChapter 会一并写入 segmentId，无需再单独 setSegment
          useReaderStore.getState().openChapter(currentBookId, row.chapterId, rowSegmentId);
          return;
        }
      }
      scheduleSegmentRecord(rowSegmentId, row.chapterId);
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  /**
   * 滚动时更新「当前章内」进度（用于底部进度条），并在接近末尾时预加载下一章。
   * 跨章拼接后内容变长，若仍用「整体偏移 / 整体可滚区间」会把进度摊薄，
   * 故以「当前章标题行」为起点、「下一章标题行」（末章为内容末尾）为终点计章内比例。
   */
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const offset = contentOffset.y;
      const viewHeight = layoutMeasurement.height > 0 ? layoutMeasurement.height : viewH.current;
      const contentHeight = contentSize.height > 0 ? contentSize.height : contentH.current;
      contentH.current = contentHeight;
      scrollOffset.current = offset;

      // 向前拼接的锚点超时检查：超时未解析则放弃补偿（防卡死，见 expireAnchorIfNeeded）
      expireAnchorIfNeeded();

      const activeId = activeChapterIdRef.current;
      let start = 0;
      let end = Math.max(0, contentHeight - CONTENT_BOTTOM_PADDING);
      if (activeId) {
        const loaded = continuousRef.current;
        const titleOffset = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${activeId}`);
        if (typeof titleOffset === 'number') {
          start = titleOffset;
        }
        const idx = loaded.findIndex((c) => c.id === activeId);
        const nextChapter = idx >= 0 ? loaded[idx + 1] : undefined;
        if (nextChapter) {
          const nextOffset = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${nextChapter.id}`);
          if (typeof nextOffset === 'number') {
            end = nextOffset;
          }
        }
      }
      // 可滚区间 = [章首, 章尾 - 一屏]，再 clamp 到 0~1，保证任何拼接状态下进度都 sane
      const span = Math.max(1, end - viewHeight - start);
      setScrollFrac(clamp((offset - start) / span, 0, 1));

      // 距底部不足预载窗口（默认 2 屏）时提前追加下一章：
      // 「预加载」让拼接发生在用户远离章节边界处，到边界时内容已就绪。
      if (contentHeight - viewHeight - offset < viewHeight * CONTIGUOUS_PRELOAD_SCREENS) {
        appendNextChapter();
      }
      // 距顶部不足预载窗口时提前向前拼接上一章（同上）。
      // （顶部无法产生滚动事件，真正的首次触发由 onContentSizeChange 兜底）
      if (offset < viewHeight * CONTIGUOUS_PRELOAD_SCREENS) {
        prependPreviousChapter();
      }
    },
    [appendNextChapter, prependPreviousChapter, rowOffsets, expireAnchorIfNeeded],
  );

  /**
   * 拖拽结束时的顶部触发兜底：在 offset≈0 处向上回弹（Android 拉出 overscroll）
   * 时 contentOffset 不变化，onScroll 可能不产生有效事件，导致「停在顶部向上
   * 滑动」永远触发不了向前拼接。拖拽结束时刻补一次距顶判断。
   */
  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      scrollOffset.current = offset;
      expireAnchorIfNeeded();
      if (offset <= viewH.current * CONTIGUOUS_PRELOAD_SCREENS) {
        prependPreviousChapter();
      }
    },
    [prependPreviousChapter, expireAnchorIfNeeded],
  );

  // 切换章节时列表回到顶部（导航跳回 Reader 会复用当前组件实例，offset 需手动复位）
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setScrollFrac(0);
    rowOffsets.current.clear();
    // 重新武装「打开时定位」：目标段落变了要重新定位一次
    // （含超时放弃兜底；模式切换跨章跟随也经由本 effect 完成武装）
    armScrollLocate(segmentId ?? '');
    // P1-17：无路由段落参数时恢复该章上次阅读段落（旧数据/无记录为 null → 回章首）
    if (!segmentId && restoreSegmentId) {
      armScrollLocate(restoreSegmentId);
    }
    // 翻页模式定位目标同步（无参数则从章首开始，保持既有行为）
    setLocateTarget(segmentId ?? restoreSegmentId ?? null);
    activeChapterIdRef.current = chapterId;
    setActiveChapterId(chapterId);
    // 依赖不含 restoreSegmentId：它仅随 chapterId / segmentId 变化（二者已在依赖中），
    // 变化触发的新一轮渲染闭包中即取到最新值，无需纳入依赖
  }, [chapterId, segmentId, listRef, rowOffsets, armScrollLocate]);

  // ---------- 选词 ----------

  /** 长按正文：以起点向后取 4 字窗口作为初始选区 */
  const handleLongPressIndex = useCallback(
    (segmentId: string, index: number) => {
      const chars = segmentCharsMap.get(segmentId);
      if (!chars || chars.length === 0) {
        return;
      }
      const start = clamp(index, 0, chars.length - 1);
      const end = Math.min(start + 4, chars.length);
      setSelection({ segmentId, start, end, text: chars.slice(start, end).join('') });
      setSelectionVisible(true);
    },
    [segmentCharsMap],
  );

  /** 调整选区边界 */
  const adjustSelection = useCallback(
    (side: 'start' | 'end', delta: 1 | -1) => {
      setSelection((prev) => {
        if (!prev) {
          return prev;
        }
        const chars = segmentCharsMap.get(prev.segmentId);
        if (!chars) {
          return prev;
        }
        if (side === 'start') {
          const start = clamp(prev.start + delta, 0, prev.end - 1);
          return { ...prev, start, text: chars.slice(start, prev.end).join('') };
        }
        const end = clamp(prev.end + delta, prev.start + 1, chars.length);
        return { ...prev, end, text: chars.slice(prev.start, end).join('') };
      });
    },
    [segmentCharsMap],
  );

  // ---------- 划线 ----------

  /** 选色划线：保存 Highlight 后列表自动刷新，正文重渲染出现高亮 */
  const createHighlight = useCallback(
    (color: HighlightColor) => {
      if (!selection || !bookId) {
        return;
      }
      // 跨章连续滚动后选区可能属于后续章节，归档到段落真实所属章，避免写错 chapterId
      const targetChapterId = segmentChapterMap.get(selection.segmentId) ?? chapterId;
      if (!targetChapterId) {
        return;
      }
      const highlight: Highlight = {
        id: genId('hl'),
        bookId,
        chapterId: targetChapterId,
        segmentId: selection.segmentId,
        startOffset: selection.start,
        endOffset: selection.end,
        color,
        text: selection.text,
        createdAt: nowISO(),
      };
      if (addHighlight(highlight)) {
        setSelectionVisible(false);
      }
    },
    [selection, bookId, chapterId, segmentChapterMap, addHighlight],
  );

  /** 工具栏划线：无选区时提示先选择文字 */
  const handleToolbarHighlight = useCallback(
    (color: HighlightColor) => {
      if (!selection) {
        Alert.alert('划线', '请先长按正文选中文字');
        return;
      }
      createHighlight(color);
    },
    [selection, createHighlight],
  );

  // ---------- 笔记 ----------

  /** 点击划线：打开笔记编辑器（已有关联笔记则预填） */
  const handleHighlightPress = useCallback(
    (h: Highlight) => {
      const existing = notes.find((n) => n.highlightId === h.id);
      setNoteContent(existing?.content ?? '');
      setNoteEditor({
        segmentId: h.segmentId,
        start: h.startOffset,
        end: h.endOffset,
        highlightId: h.id,
        noteId: existing?.id,
      });
    },
    [notes],
  );

  /** 对当前选区新建笔记 */
  const openNoteEditorForSelection = useCallback(() => {
    if (!selection) {
      Alert.alert('笔记', '请先长按正文选中文字');
      return;
    }
    setNoteContent('');
    setNoteEditor({
      segmentId: selection.segmentId,
      start: selection.start,
      end: selection.end,
    });
    setSelectionVisible(false);
  }, [selection]);

  /** 保存笔记编辑器内容 */
  const saveNoteEditor = useCallback(() => {
    const content = noteContent.trim();
    if (!noteEditor || !content || !bookId) {
      return;
    }
    // 与划线一致：按段落真实所属章归档（跨章连续滚动后可能不是路由打开的章）
    const targetChapterId = segmentChapterMap.get(noteEditor.segmentId) ?? chapterId;
    if (!targetChapterId) {
      return;
    }
    if (noteEditor.noteId) {
      updateNote(noteEditor.noteId, content);
    } else {
      const note = addNote({
        bookId,
        chapterId: targetChapterId,
        segmentId: noteEditor.segmentId,
        startOffset: noteEditor.start,
        endOffset: noteEditor.end,
        content,
        highlightId: noteEditor.highlightId,
      });
      // 关联划线：回写 noteId，划线渲染下划线提示
      if (note?.id && noteEditor.highlightId) {
        const target = highlights.find((h) => h.id === noteEditor.highlightId);
        if (target) {
          addHighlight({ ...target, noteId: note.id });
        }
      }
    }
    setNoteEditor(null);
    setNoteContent('');
  }, [
    noteEditor,
    noteContent,
    bookId,
    chapterId,
    segmentChapterMap,
    updateNote,
    addNote,
    highlights,
    addHighlight,
  ]);

  const closeNoteEditor = useCallback(() => {
    setNoteEditor(null);
    setNoteContent('');
  }, []);

  // ---------- 收藏 ----------

  /** 整篇收藏（article） */
  const handleBookmarkArticle = useCallback(() => {
    if (!bookId || !chapterId || !chapter) {
      return;
    }
    const saved = addBookmark({
      type: 'article',
      bookId,
      chapterId,
      text: `${book?.title ?? ''}·${chapter.title}`,
      tags: [],
    });
    if (saved) {
      Alert.alert('已收藏', `《${chapter.title}》已加入收藏`);
    }
  }, [bookId, chapterId, chapter, book, addBookmark]);

  /** 解析面板收藏（paragraph，补充书籍/章节上下文） */
  const handleAnalysisBookmark = useCallback(
    (b: Bookmark) => {
      const saved = addBookmark({
        type: b.type,
        bookId: bookId ?? undefined,
        chapterId: chapterId ?? undefined,
        segmentId: selection?.segmentId,
        text: b.text,
        tags: b.tags,
      });
      if (saved) {
        Alert.alert('已收藏', `「${b.text ?? ''}」解析已收藏`);
      }
    },
    [bookId, chapterId, selection, addBookmark],
  );

  // ---------- 解析 / 背诵 ----------

  /** 打开字词解析面板 */
  const openAnalysis = useCallback(() => {
    if (!selection) {
      return;
    }
    setAnalysisText(selection.text);
    setAnalysisVisible(true);
    setSelectionVisible(false);
  }, [selection]);

  /** 打开选段翻译面板 */
  const openTranslation = useCallback(() => {
    if (!selection) {
      return;
    }
    setTranslationText(selection.text);
    setTranslationVisible(true);
    setSelectionVisible(false);
  }, [selection]);

  /** 背诵入口：跳转背诵练习页（默认填空默写模式） */
  const handleRecite = useCallback(() => {
    if (!bookId || !chapterId) {
      return;
    }
    navigation?.navigate('RecitationPractice', {
      bookId,
      chapterId,
      mode: 'fillBlank',
    });
  }, [navigation, bookId, chapterId]);

  const goBack = useCallback(() => {
    navigation?.goBack();
  }, [navigation]);

  // ---------- 渲染 ----------

  /** 渲染一行：段落行走 SegmentItem（承载划线 / 长按选词 / 注音），标题行走章标题 */
  const renderRow = useCallback(
    ({ item }: { item: ReaderRow }) => {
      if (item.segment) {
        return (
          <SegmentItem
            segment={item.segment}
            fontSize={fontSize}
            lineHeight={lineHeight}
            pinyinMode={pinyinMode}
            segmentHighlights={highlightsBySegment.get(item.segment.id) ?? EMPTY_HIGHLIGHTS}
            onHighlightPress={handleHighlightPress}
            onLongPressIndex={handleLongPressIndex}
            onLayoutItem={handleRowLayout}
            workId={item.chapterId}
            bookId={bookId ?? undefined}
          />
        );
      }
      return (
        <View onLayout={(e) => handleRowLayout(item.id, e.nativeEvent.layout.y)}>
          <Text style={[styles.chapterTitle, { color: colors.text }]}>{item.title}</Text>
        </View>
      );
    },
    [
      fontSize,
      lineHeight,
      pinyinMode,
      highlightsBySegment,
      handleHighlightPress,
      handleLongPressIndex,
      handleRowLayout,
      bookId,
      colors,
    ],
  );

  // 加载失败视图
  if (loadError) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>{loadError}</Text>
        <Pressable style={[styles.errorButton, { backgroundColor: colors.primary }]} onPress={goBack}>
          <Text style={styles.errorButtonText}>返回</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // 加载中
  if (!chapter || !book) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* 顶部标题栏 */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={goBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={[styles.backButton, { color: colors.primary }]}>{'‹ 返回'}</Text>
        </Pressable>
        <Pressable
          style={styles.headerTitles}
          onPress={() => setTocVisible(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="打开目录"
        >
          <Text style={[styles.headerBook, { color: colors.textSecondary }]} numberOfLines={1}>
            {displayBookTitle}
          </Text>
          <View style={styles.headerChapterRow}>
            <Text style={[styles.headerChapter, { color: colors.text }]} numberOfLines={1}>
              {displayChapterTitle}
            </Text>
            <Text style={[styles.headerCaret, { color: colors.textSecondary }]}>{'▾'}</Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => setSettingsVisible(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="阅读设置"
        >
          <Text style={[styles.settingsButton, { color: colors.primary }]}>Aa</Text>
        </Pressable>
        {/* 一键繁简切换：点击在当前书籍简/繁显示间切换 */}
        <Pressable
          onPress={() =>
            setConversionMode(conversionMode === 'traditional' ? 'simplified' : 'traditional')
          }
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`切换繁简显示（当前：${conversionMode === 'traditional' ? '繁體' : '简体'}）`}
        >
          <Text style={[styles.convButton, { color: colors.primary }]}>
            {conversionMode === 'traditional' ? '繁' : '简'}
          </Text>
        </Pressable>
      </View>

      {/* 章节翻页：上一章 / 当前章 / 下一章 */}
      {(siblings.prev || siblings.next) && (
        <View style={[styles.pager, { borderBottomColor: colors.border }]}>
          <Pressable
            onPress={() => siblings.prev && goToChapter(siblings.prev.id)}
            disabled={!siblings.prev}
            style={[styles.pagerBtn, !siblings.prev && styles.pagerBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel="上一章"
          >
            <Text
              style={[
                styles.pagerText,
                { color: siblings.prev ? colors.primary : colors.pinyin },
              ]}
            >
              {'‹ 上一章'}
            </Text>
          </Pressable>
          <Text
            style={[styles.pagerInfo, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {displayChapterTitle}
          </Text>
          <Pressable
            onPress={() => siblings.next && goToChapter(siblings.next.id)}
            disabled={!siblings.next}
            style={[styles.pagerBtn, !siblings.next && styles.pagerBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel="下一章"
          >
            <Text
              style={[
                styles.pagerText,
                { color: siblings.next ? colors.primary : colors.pinyin },
              ]}
            >
              {'下一章 ›'}
            </Text>
          </Pressable>
        </View>
      )}

      {/* 正文：滚动模式用 FlatList，仿真翻页模式用分页容器 */}
      {readerMode === 'page' ? (
        <View
          style={styles.pagerArea}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setPagerLayout((prev) =>
              prev.width === width && prev.height === height ? prev : { width, height },
            );
          }}
        >
          <PageModeView
            segments={displaySegments}
            chapterTitle={displayChapterTitle}
            colors={colors}
            fontSize={fontSize}
            lineHeight={lineHeight}
            pinyinMode={pinyinMode}
            highlightsBySegment={highlightsBySegment}
            onHighlightPress={handleHighlightPress}
            onLongPressIndex={handleLongPressIndex}
            workId={chapterId ?? undefined}
            bookId={bookId ?? undefined}
            pageWidth={pagerLayout.width}
            pageHeight={visiblePageHeight}
            index={pageIndex}
            onIndexChange={setPageIndex}
            onPageCountChange={setPageCount}
            onActiveSegmentChange={handlePageActiveSegment}
            onEdgeReached={handlePageEdge}
            locateSegmentId={locateTarget}
          />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          // 连续滚动：正文跨章拼接（前面的章 + 当前章 + 后续已加载章），
          // 滚到末尾自动追加下一章，滚到开头自动向前拼接上一章
          data={continuousRows}
          keyExtractor={(item) => item.id}
          renderItem={renderRow}
          // 目标段落定位：一次性渲染足够多的段落以保证 onLayout 触发
          initialNumToRender={30}
          contentContainerStyle={styles.content}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onScroll={handleScroll}
          onScrollEndDrag={handleScrollEndDrag}
          scrollEventThrottle={16}
          onEndReached={handleEndReached}
          // 预载窗口（屏高倍数）与 handleScroll / onContentSizeChange 的触发条件保持一致
          onEndReachedThreshold={CONTIGUOUS_PRELOAD_SCREENS}
          onStartReached={handleStartReached}
          onStartReachedThreshold={CONTIGUOUS_PRELOAD_SCREENS}
          onContentSizeChange={(_w, h) => {
            // 锚点兜底补偿：锚点行若移出渲染窗口，onLayout 永不触发，此时用
            // contentSize 增量（首次变化恰为插入高度）做一次性补偿——
            // 优于不补偿（那会整屏跳到上一章开头）。增量非正则等锚点/超时处理。
            const anchorNow = prependAnchor.current;
            if (anchorNow) {
              const delta = h - contentH.current;
              if (delta > 0 && contentH.current > 0) {
                anchorNow.snapshot.forEach((oldY, key) => {
                  if (rowOffsets.current.get(key) === oldY) {
                    rowOffsets.current.set(key, oldY + delta);
                  }
                });
                listRef.current?.scrollToOffset({
                  offset: Math.max(0, scrollOffset.current + delta),
                  animated: false,
                });
                prependAnchor.current = null;
              }
            }
            contentH.current = h;
            // 锚点超时兜底：正常情况下锚点在行布局回调中已解析，这里只是保险
            expireAnchorIfNeeded();
            // 定位快速通道：模式切换会重挂载滚动列表，目标行若超出初始渲染窗口，
            // onLayout 不会再触发；此时 rowOffsets 仍保有同一内容上一次会话的
            // 真实布局偏移（onLayout 的 y 是相对内容容器的绝对偏移），直接落位。
            const pending = pendingScroll.current;
            if (!pending.done && pending.target) {
              const known = rowOffsets.current.get(pending.target);
              // 仅当估算内容高覆盖目标偏移时才落位，避免被钳制到错误位置
              if (typeof known === 'number' && h > known) {
                pending.done = true;
                listRef.current?.scrollToOffset({
                  offset: Math.max(0, known - 24),
                  animated: false,
                });
              }
            }
            // 顶部无法产生滚动事件（已到 offset 0，物理上滚不动），
            // 故在内容首次量出高度后主动向前拼接上一章，打通「向上滚动」的入口。
            if (h > 0 && scrollOffset.current <= viewH.current * CONTIGUOUS_PRELOAD_SCREENS) {
              prependPreviousChapter();
            }
          }}
          onLayout={(e) => {
            viewH.current = e.nativeEvent.layout.height;
          }}
        />
      )}

      {/* 底部浮动：进度 + 注音模式切换 + 工具栏 */}
      <View
        style={styles.bottomDock}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setDockHeight((prev) => (prev === h ? prev : h));
        }}
      >
        {/* 阅读进度：第 N / 共 M 章 · 百分比 */}
        {totalChapters > 0 && (
          <View
            style={[styles.progressWrap, { backgroundColor: colors.card, borderTopColor: colors.border }]}
          >
            <Text style={[styles.progressText, { color: colors.textSecondary }]}>
              {readerMode === 'page' && pageCount > 0
                ? `第 ${Math.max(1, chapterIndex + 1)}/${totalChapters} 章 · 第 ${
                    pageIndex + 1
                  }/${pageCount} 页 · ${Math.round(overallProgress * 100)}%`
                : `第 ${Math.max(1, chapterIndex + 1)} / ${totalChapters} 章 · ${Math.round(
                    overallProgress * 100,
                  )}%`}
            </Text>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.round(overallProgress * 100)}%`,
                    backgroundColor: colors.primary,
                  },
                ]}
              />
            </View>
          </View>
        )}
        {/* 正文朗读（P2-02）：当前段落 朗读/停止 + 语速步进（−/+ 0.25） */}
        <View
          style={[styles.ttsBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}
        >
          <Pressable
            onPress={handleToggleSpeech}
            hitSlop={6}
            style={({ pressed }) => [styles.ttsSpeakBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={ttsSpeaking ? '停止朗读' : '朗读当前段落'}
          >
            <Text
              style={[
                styles.ttsSpeakText,
                { color: ttsSpeaking ? colors.primary : colors.textSecondary },
              ]}
            >
              {ttsSpeaking ? '⏹ 停止' : '▶ 朗读'}
            </Text>
          </Pressable>
          <View style={styles.ttsRateGroup}>
            <Pressable
              onPress={() => handleStepSpeechRate(-1)}
              disabled={speechRate <= 0.5}
              style={[styles.ttsRateBtn, speechRate <= 0.5 && styles.pagerBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="降低语速"
            >
              <Text style={[styles.ttsRateBtnText, { color: colors.textSecondary }]}>{'−'}</Text>
            </Pressable>
            <Text style={[styles.ttsRateValue, { color: colors.text }]}>
              {speechRate.toFixed(2)}x
            </Text>
            <Pressable
              onPress={() => handleStepSpeechRate(1)}
              disabled={speechRate >= 2.0}
              style={[styles.ttsRateBtn, speechRate >= 2.0 && styles.pagerBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="提高语速"
            >
              <Text style={[styles.ttsRateBtnText, { color: colors.textSecondary }]}>{'＋'}</Text>
            </Pressable>
          </View>
        </View>
        <PinyinModeBar mode={pinyinMode} onChange={setPinyinMode} />
        <ReaderToolbar
          onHighlight={handleToolbarHighlight}
          onNote={openNoteEditorForSelection}
          onBookmark={handleBookmarkArticle}
          onRecite={handleRecite}
        />
      </View>

      {/* 选词操作面板 */}
      <Modal
        visible={selectionVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectionVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setSelectionVisible(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.background }]}
            onPress={() => undefined}
          >
            <Text style={[styles.sheetTitle, { color: colors.textSecondary }]}>选中文字</Text>
            <View style={styles.selectionRow}>
              <Pressable
                style={[styles.rangeButton, { borderColor: colors.border }]}
                onPress={() => adjustSelection('start', 1)}
                disabled={!selection || selection.start >= selection.end - 1}
                accessibilityRole="button"
                accessibilityLabel="起点后移"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'−'}</Text>
              </Pressable>
              <Pressable
                style={[styles.rangeButton, { borderColor: colors.border }]}
                onPress={() => adjustSelection('start', -1)}
                disabled={!selection || selection.start <= 0}
                accessibilityRole="button"
                accessibilityLabel="起点前移"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'＋'}</Text>
              </Pressable>
              <Text style={[styles.selectionText, { color: colors.text }]} numberOfLines={1}>
                {selection?.text ?? ''}
              </Text>
              <Pressable
                style={[styles.rangeButton, { borderColor: colors.border }]}
                onPress={() => adjustSelection('end', 1)}
                disabled={
                  !selection ||
                  !segmentCharsMap.get(selection.segmentId) ||
                  selection.end >= (segmentCharsMap.get(selection.segmentId)?.length ?? 0)
                }
                accessibilityRole="button"
                accessibilityLabel="终点后移"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'＋'}</Text>
              </Pressable>
              <Pressable
                style={[styles.rangeButton, { borderColor: colors.border }]}
                onPress={() => adjustSelection('end', -1)}
                disabled={!selection || selection.end <= selection.start + 1}
                accessibilityRole="button"
                accessibilityLabel="终点前移"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'−'}</Text>
              </Pressable>
            </View>

            {/* 划线三色 */}
            <View style={styles.actionRow}>
              {(['yellow', 'green', 'blue'] as HighlightColor[]).map((color) => (
                <Pressable
                  key={color}
                  style={[styles.colorDotButton, { backgroundColor: DOT_COLORS[color] }]}
                  onPress={() => createHighlight(color)}
                  accessibilityRole="button"
                  accessibilityLabel={`使用${color}颜色划线`}
                />
              ))}
              <View style={styles.actionDivider} />
              <Pressable style={styles.actionButton} onPress={openAnalysis}>
                <Text style={[styles.actionButtonText, { color: colors.primary }]}>解析</Text>
              </Pressable>
              <Pressable style={styles.actionButton} onPress={openTranslation}>
                <Text style={[styles.actionButtonText, { color: colors.primary }]}>翻译</Text>
              </Pressable>
              <Pressable style={styles.actionButton} onPress={openNoteEditorForSelection}>
                <Text style={[styles.actionButtonText, { color: colors.primary }]}>笔记</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 字词解析面板 */}
      <AnalysisPanel
        visible={analysisVisible}
        onClose={() => setAnalysisVisible(false)}
        text={analysisText}
        onBookmark={handleAnalysisBookmark}
      />

      {/* 选段翻译面板 */}
      <TranslationPanel
        visible={translationVisible}
        onClose={() => setTranslationVisible(false)}
        text={translationText}
      />

      {/* 笔记编辑器 */}
      <Modal
        visible={noteEditor !== null}
        transparent
        animationType="fade"
        onRequestClose={closeNoteEditor}
      >
        <Pressable style={styles.overlay} onPress={closeNoteEditor}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.background }]}
            onPress={() => undefined}
          >
            <Text style={[styles.sheetTitle, { color: colors.textSecondary }]}>
              {noteEditor?.noteId ? '编辑笔记' : '新建笔记'}
            </Text>
            <TextInput
              style={[
                styles.noteInput,
                {
                  color: colors.text,
                  backgroundColor: colors.inputBackground,
                  borderColor: colors.border,
                },
              ]}
              value={noteContent}
              onChangeText={setNoteContent}
              placeholder="记录你的心得…"
              placeholderTextColor={colors.pinyin}
              multiline
              textAlignVertical="top"
            />
            <View style={styles.actionRow}>
              <Pressable style={styles.actionButton} onPress={closeNoteEditor}>
                <Text style={[styles.actionButtonText, { color: colors.textSecondary }]}>取消</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.actionButton,
                  { backgroundColor: colors.primarySoft },
                  !noteContent.trim() ? styles.actionDisabled : null,
                ]}
                onPress={saveNoteEditor}
                disabled={!noteContent.trim()}
                accessibilityRole="button"
                accessibilityLabel="保存笔记"
              >
                <Text style={[styles.actionButtonText, { color: colors.primary }]}>保存</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 阅读设置：微信读书式底部抽屉 */}
      <Modal
        visible={settingsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <Pressable style={styles.sheetMask} onPress={() => setSettingsVisible(false)}>
          <Pressable
            style={[styles.sheetBottom, { backgroundColor: colors.background }]}
            onPress={() => undefined}
          >
            <View style={[styles.sheetGrabber, { backgroundColor: colors.border }]} />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>阅读设置</Text>

            {/* 字号：A- / A+ 步进，含实时预览 */}
            <SettingsSectionTitle text="字号" colors={colors} />
            <View style={styles.sizeRow}>
              <Pressable
                style={[styles.sizeButton, { borderColor: colors.border }]}
                onPress={() => setFontSize(Math.max(14, fontSize - 2))}
                disabled={fontSize <= 14}
                accessibilityRole="button"
                accessibilityLabel="减小字号"
              >
                <Text style={[styles.sizeButtonText, { color: colors.text }]}>A−</Text>
              </Pressable>
              <Text style={[styles.sizeValue, { color: colors.textSecondary }]}>{fontSize}</Text>
              <Pressable
                style={[styles.sizeButton, { borderColor: colors.border }]}
                onPress={() => setFontSize(Math.min(30, fontSize + 2))}
                disabled={fontSize >= 30}
                accessibilityRole="button"
                accessibilityLabel="增大字号"
              >
                <Text style={[styles.sizeButtonText, { color: colors.text }]}>A＋</Text>
              </Pressable>
              <View style={styles.sizePreviewWrap}>
                <Text
                  style={[styles.sizePreview, { color: colors.text, fontSize: Math.min(fontSize, 22) }]}
                >
                  国学
                </Text>
              </View>
            </View>

            {/* 翻页方式：滚动 / 仿真翻页 */}
            <SettingsSectionTitle text="翻页方式" colors={colors} />
            <View style={styles.optionRow}>
              {(['scroll', 'page'] as ReaderMode[]).map((mode) => (
                <OptionButton
                  key={mode}
                  label={mode === 'scroll' ? '滚动' : '仿真翻页'}
                  active={readerMode === mode}
                  colors={colors}
                  onPress={() => setReaderMode(mode)}
                />
              ))}
            </View>

            {/* 背景：纸张色块（对标微信读书 / 番茄） */}
            <SettingsSectionTitle text="背景" colors={colors} />
            <View style={styles.swatchRow}>
              {PAPER_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.key}
                  style={styles.swatchItem}
                  onPress={() => setPaper(opt.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`切换背景为${opt.label}`}
                >
                  <View
                    style={[
                      styles.swatch,
                      { backgroundColor: opt.swatch, borderColor: colors.border },
                      paper === opt.key && { borderColor: colors.primary, borderWidth: 2 },
                    ]}
                  />
                  <Text
                    style={[
                      styles.swatchLabel,
                      { color: paper === opt.key ? colors.primary : colors.textSecondary },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* 行距 */}
            <SettingsSectionTitle text="行距" colors={colors} />
            <View style={styles.optionRow}>
              {LINE_HEIGHT_OPTIONS.map((lh) => (
                <OptionButton
                  key={lh}
                  label={lh === 1.4 ? '紧凑' : lh === 1.6 ? '标准' : '宽松'}
                  active={lineHeight === lh}
                  colors={colors}
                  onPress={() => setLineHeight(lh)}
                />
              ))}
            </View>

            {/* 正文繁简 */}
            <SettingsSectionTitle text="正文繁简" colors={colors} />
            <View style={styles.optionRow}>
              {(['simplified', 'traditional'] as const).map((mode) => (
                <OptionButton
                  key={mode}
                  label={mode === 'simplified' ? '简体' : '繁體'}
                  active={conversionMode === mode}
                  colors={colors}
                  onPress={() => setConversionMode(mode)}
                />
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 目录抽屉（点击顶部书名 / 章节打开） */}
      <Modal
        visible={tocVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTocVisible(false)}
      >
        <Pressable style={styles.tocOverlay} onPress={() => setTocVisible(false)}>
          <View
            style={[styles.tocPanel, { backgroundColor: colors.background, borderLeftColor: colors.border }]}
          >
            <Text style={[styles.tocTitle, { color: colors.text }]}>{displayBookTitle}</Text>
            <FlatList
              data={book?.chapters ?? []}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => (
                <Pressable
                  style={[
                    styles.tocItem,
                    item.id === chapterId && { backgroundColor: colors.primarySoft },
                  ]}
                  onPress={() => {
                    setTocVisible(false);
                    goToChapter(item.id);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`跳转至${item.title}`}
                >
                  <Text
                    style={[
                      styles.tocItemText,
                      { color: item.id === chapterId ? colors.primary : colors.text },
                    ]}
                    numberOfLines={1}
                  >
                    {`${index + 1}. ${item.title}`}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/** 划线圆点实色（与 ReaderToolbar 保持一致的视觉语言） */
const DOT_COLORS: Record<HighlightColor, string> = {
  yellow: '#F5D742',
  green: '#4CAF50',
  blue: '#2196F3',
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  // 顶部标题栏
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    fontSize: 16,
    marginRight: 8,
  },
  headerTitles: {
    flex: 1,
    alignItems: 'center',
  },
  headerBook: {
    fontSize: 12,
  },
  headerChapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerChapter: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerCaret: {
    fontSize: 12,
  },
  settingsButton: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 12,
  },
  convButton: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 12,
    minWidth: 20,
    textAlign: 'center',
  },
  // 章节翻页条
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pagerBtn: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  pagerBtnDisabled: {
    opacity: 0.4,
  },
  pagerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  pagerInfo: {
    flex: 1,
    textAlign: 'center',
    fontSize: 13,
    marginHorizontal: 8,
  },
  // 正文
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: CONTENT_BOTTOM_PADDING,
  },
  // 仿真翻页：正文容器（承载测量 onLayout 与分页器）
  pagerArea: {
    flex: 1,
    overflow: 'hidden',
  },
  pageModeRoot: {
    flex: 1,
  },
  // 隐藏测量层：量取每段高度，量完即卸载
  sizer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
    zIndex: -1,
  },
  pageInner: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
  },
  pageScroll: {
    flex: 1,
  },
  pageLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chapterTitle: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 24,
  },
  segment: {
    marginBottom: PARAGRAPH_SPACING,
  },
  /** 拆页续块：去掉段落下边距，页内视觉上仍是同一段的连续行 */
  segmentContinuation: {},
  // 底部浮动
  bottomDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 8,
  },
  // 阅读进度（底部浮动顶部）
  progressWrap: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // 正文朗读条（P2-02）
  ttsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ttsSpeakBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  pressed: {
    opacity: 0.7,
  },
  ttsSpeakText: {
    fontSize: 14,
    fontWeight: '600',
  },
  ttsRateGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ttsRateBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  ttsRateBtnText: {
    fontSize: 15,
  },
  ttsRateValue: {
    fontSize: 13,
    fontWeight: '600',
    minWidth: 48,
    textAlign: 'center',
  },
  progressText: {
    fontSize: 12,
    marginBottom: 4,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
  },
  // 弹层通用
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheet: {
    width: '88%',
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  // 阅读设置：底部抽屉
  sheetMask: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  sheetBottom: {
    width: '100%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
    gap: 12,
  },
  sheetGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 4,
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sizeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  sizeButtonText: {
    fontSize: 18,
    fontWeight: '600',
  },
  sizeValue: {
    fontSize: 15,
    minWidth: 24,
    textAlign: 'center',
  },
  sizePreviewWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
  sizePreview: {
    fontWeight: '600',
  },
  // 背景纸张色块
  swatchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  swatchItem: {
    alignItems: 'center',
    gap: 4,
    flex: 1,
  },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
  },
  swatchLabel: {
    fontSize: 12,
  },
  // 目录抽屉
  tocOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  tocPanel: {
    width: '80%',
    height: '100%',
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingTop: 16,
  },
  tocTitle: {
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  tocItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  tocItemText: {
    fontSize: 15,
  },
  // 选词面板
  selectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectionText: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginHorizontal: 4,
  },
  rangeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  rangeButtonText: {
    fontSize: 16,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  colorDotButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  actionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: 'rgba(0,0,0,0.15)',
    marginHorizontal: 4,
  },
  actionButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    fontSize: 15,
  },
  actionDisabled: {
    opacity: 0.4,
  },
  // 笔记编辑器
  noteInput: {
    height: 120,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
  },
  // 设置弹层
  settingsSection: {
    fontSize: 13,
  },
  optionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  optionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  optionLabel: {
    fontSize: 14,
  },
  // 错误视图
  errorText: {
    fontSize: 15,
    textAlign: 'center',
  },
  errorButton: {
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 8,
  },
  errorButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
  },
});

export default ReaderScreen;
