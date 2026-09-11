/**
 * 阅读器主页面（ReaderScreen）
 * 页面结构：
 * - 顶部：书名 + 章节名 + 返回按钮 + 设置入口（字号/行距/主题）+ 繁简/藏/听/音切换
 * - 正文：FlatList 逐段渲染（注音模式用 PinyinText，关闭注音用 HighlightText）
 * - 底部：固定进度条（第 N/共 M 章 · X% + 细进度条）
 * 交互流程：
 * - 长按正文 → 仅选中长按的单字（初始选区 1 字），阅读页内浮动菜单（底部停靠，非全屏
 *   Modal，不遮挡正文）弹出；菜单打开时点按正文任意字可扩展选区（终点之后向右
 *   扩、起点之前向左扩），点选区内收缩（可缩至 1 字），长按其他字重新选字；
 *   划线/解析/翻译/笔记作用于当前选区，选区与已有划线重叠时面板提供「取消划线」
 * - 点击已有划线 → 弹出笔记编辑器（新建或编辑关联笔记）
 * - 章节前进：滚动模式为滑动窗口连续拼接（无限前进）；翻页模式翻到章边界自动跨章
 * - 与 useReaderStore 联动：openChapter 保存阅读位置，滚动更新当前段落
 * 说明：朗读入口为右上角「听」按钮——未朗读时先弹语速设置弹窗（确认后才播放），
 * 朗读中再点直接停止；背诵练习由首页底部「背诵」Tab 进入，阅读页不再保留直达入口。
 * props 保持宽松路由签名，兼容 RootStack 注入（阅读经书架选书进入）。
 * 正文支持繁简一键切换：转换在「数据层」统一作用于段落文本，渲染、选区码点与
 * 划线偏移均基于转换后文本，保证三者一致、切换不错位。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  LayoutChangeEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { CellRendererProps } from '@react-native/virtualized-lists';
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
import PinyinText from '@/components/reader/PinyinText';
import {
  StorageService,
  genId,
  nowISO,
} from '@/services/StorageService';
import { TextLibraryService } from '@/services/TextLibraryService';
import { UserBookService } from '@/services/UserBookService';
import { TtsService } from '@/services/tts/TtsService';
import { stepSpeechRate } from '@/utils/speech';
import { memoToSimplified, memoToTraditional } from '@/utils/conversionMemo';
import { useReaderBookSettings, useSettingsStore } from '@/store/useSettingsStore';
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
import { computeScrollInitialRows, isWithinPreloadWindow, planHeadDrop } from '@/utils/readerScroll';
import type { ReaderRouteParams } from '@/navigation/types';

// ============ 类型定义 ============

/** ReaderScreen 所需的最小导航能力（RootStack 注入或阅读 Tab 手动构造均可满足） */
interface ReaderScreenProps {
  /** React Navigation 注入的 route（阅读 Tab 复用时由父组件直接传入） */
  route?: { params?: ReaderRouteParams };
  /** React Navigation 注入的 navigation */
  navigation?: {
    goBack: () => void;
    navigate: {
      (name: 'Reader', params: ReaderRouteParams): void;
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
 * 注音模式循环切换顺序（右上角「音」按钮，沿用原底部注音切换条的模式定义与顺序）：
 * 全文注音 → 仅生僻字 → 关闭 → 全文注音 …
 */
const PINYIN_MODE_CYCLE: readonly PinyinMode[] = ['full', 'rare', 'off'];

/** 注音模式标签（无障碍朗读与语义化展示用） */
const PINYIN_MODE_LABELS: Record<PinyinMode, string> = {
  full: '全文注音',
  rare: '仅生僻字',
  off: '关闭',
};

/**
 * 正文容器底部留白（px）：底部固定进度条（文本行 + 细进度条，不含 safe-area，
 * safe-area 由外层 SafeAreaView 处理）约占 42px，另留约 22px 呼吸空隙，
 * 避免末段紧贴进度条。
 */
const CONTENT_BOTTOM_PADDING = 64;

/**
 * 连续滚动「滑动窗口」的最大章节数。
 * 拼接是双向的（向后追加 + 向前插入），长书（如《史记》130 篇）一路滚下去会无限
 * 吃内存，故设窗口上限。语义已从旧版「到达即停」（正文停在章边界、靠翻页条前进）
 * 改为滑动窗口：appendNextChapter 成功后若序列超限，丢弃头部最旧章节腾位
 * （见 maybeDropHeadChapters / utils/readerScroll 的 planHeadDrop），使连续滚动
 * 可无限前进；向前拼接（prependPreviousChapter）仍以窗口满为界——向后的回看范围
 * 即当前窗口内容，更早的章节经目录跳转（goToChapter）可达。
 * 丢头偏移补偿按 rowOffsets 精确计算并在 onContentSizeChange 消费，算不出时
 * 推迟本轮丢弃（宁晚勿扰），避免变高行反推误差造成可见跳页。
 */
const MAX_CONTINUOUS_CHAPTERS = 30;

/**
 * 向前拼接锚点的最长存活时间。
 * 正常情况下「原首章标题行」会在下一两个布局帧内重新 onLayout，锚点随即解析；
 * 若因行回收等极端情况迟迟等不到（如锚点行恰好移出渲染窗口），超时后放弃补偿
 * （视野会跳到上一章开头，属于可接受的降级），确保 appendNextChapter 的
 * prependAnchor 守卫不会被长期卡死、用户滚动不会被陈旧锚点反复拽回。
 * 旧值 2000 被真机实测打穿（r27）：prepend 插入整章后 VirtualizedList 重挂
 * 新表头 initialNumToRender 行（注音行极重），JS 单块阻塞 ~2.2s——阻塞期间
 * 定时器与布局回调都无法执行，锚点在消费前就到期被弃 → 视口跳到上一章开头
 * （跳章后上滚「大幅跳动」根因之一）。放宽到 8000：锚点消费发生在插入的
 * 同一轮渲染提交之后（阻塞一结束即消费），不存在「用户滚走后陈旧锚点拽人」
 * 的窗口——阻塞期间用户根本无法滚动。
 */
const ANCHOR_TIMEOUT_MS = 8000;

/**
 * 模式切换后「定位到当前段」的最长等待时间。
 * 目标行超出初始渲染窗口且 rowOffsets 无历史数据时，onLayout 不会触发，
 * 超时后放弃定位（落回章首属可接受的降级），避免 pendingScroll 守卫
 * 长期阻塞向前拼接。
 */
/**
 * 定位放弃超时。真机实测（华为 ALT-AL10）：meta 水合 ~0.6s + 首屏布局 ~2.3s，
 * 旧值 1500ms 在「水合→布局」期间就到期把 pending 置 done——目标行随后
 * onLayout 时定位已被放弃，视口停在章首（续读恢复失败的根因之一，即使
 * 目标行在初始窗口内也会失败）。超时只兜底「目标段不存在/永不布局」的
 * 异常态，放宽到 8s 不影响正常路径（正常路径秒级落位后 done 即置位）。
 */
const LOCATE_TIMEOUT_MS = 8000;

/**
 * 拆分块二轮再切的容差（px）：块高超出页预算不超过该值时不再细分，
 * 轻微溢出交给页内纵向滚动吸收。避免「线性估算误差 + 换行取整」造成的
 * 微小超高被反复拆分，产生只有一行的碎页。
 */
const CHUNK_RESPLIT_TOLERANCE = 12;

/**
 * 【9】隐藏 sizer 分批量高的批大小与间隔：
 * 每批挂载 6 段、间隔 16ms（约每帧一批），单帧字格挂载量有界，
 * 大书量高期间 JS 线程保持可响应（loading 不再阻塞全部交互）。
 */
const SIZER_BATCH_SEGMENTS = 6;
const SIZER_BATCH_INTERVAL = 16;

/**
 * 滚动模式上下章「预加载窗口」（屏高倍数）：距顶/距底不足该倍数屏高时
 * 即提前拼接上一章/追加下一章。提前拼接让「插入 + 偏移补偿」发生在
 * 用户还远离章节边界时，到边界时内容已就绪，体感上无需等待。
 */
const CONTIGUOUS_PRELOAD_SCREENS = 2;

/**
 * 显式跳章后的「章首驻留期」阈值（屏高倍数）：目录跳章落到章首后，用户尚未把
 * 当前章读出超过该倍数屏高之前，自动向前拼接只保留「章首回弹 offset ≤ 0 的
 * endDrag 放行」一条路径，手势滚动途中的前置拼接全部被驻留期拦截。
 * 背景：跳章落章首时 offset = 0，立即上滑会同时满足手势窗口 + 顶部预载窗口 +
 * 朝顶方向 → 切章过渡态（remeasure / 定位尚未完全收敛）中触发 prepend，锚点
 * 补偿基于过渡态基准，与进行中的拖拽/惯性互相争夺 scrollTo → 落点失准跳章。
 */
const CHAPTER_HEAD_DWELL_SCREENS = 0.5;

/**
 * 滚动模式邻章预取的延时（ms）：跳章落位 / 切章完成后仍处于切章过渡态
 * （列表重挂载、定位落位、contentSize 估算修正），立即预取会与这些工作
 * 争抢 JS 线程。延时一拍（宏任务 + 该间隔）让出线程；间隔远小于用户从
 * 落位滚动到章边界的时间，不构成可感知的等待。
 */
const NEIGHBOR_PREFETCH_DELAY_MS = 400;

/**
 * 【P1 灰度开关】maintainVisibleContentPosition 原生视口保持
 * （docs/paging-implementation-evaluation.md；RN 0.72 起 Android 支持，本项目 0.74.7 可用）。
 * 开启后「头部插入上一章 / 滑动窗口丢头」的滚动偏移保持改由原生层完成：
 * FlatList 下方 ScrollView 在子视图因数据插入/移除整体位移时自动调整 offset，
 * 使视口内第一个可见行保持在原视口位置——等价于手写补偿链路
 * （prependAnchor 登记 → handleRowLayout / onContentSizeChange 消费、
 * headDropCompensation 写入消费）的全部效果，且不存在「contentSize 增量
 * 归因」「补偿基准陈旧」「同 tick 合并污染」三类手写方案固有竞态。
 * 开启时不再登记锚点/补偿量（再执行手写 scrollTo 会双重补偿），相关代码
 * 全部保留作为回退路径：真机若发现异常，改回 false 一行整体回退。
 */
const MVCP_ENABLED = true;
/** 保持视口内第一个可见行稳定；不设 autoscrollToTopThreshold（拼接后不自动跳到新章） */
const MVCP_CONFIG = { minIndexForVisible: 0 } as const;

/**
 * 【P0】滚动模式 FlatList 渲染窗口调参（对齐 legado / RecyclerView 缓存尺度）。
 * RN 默认 windowSize=21 → 渲染窗口约 10 屏，注音行逐字字格成本高，窗口边缘
 * 批量挂载过猛（滚动掉帧）。收敛为前后各约 4 屏 + 更小更密的批量：
 * - windowSize=9：渲染窗口 ≈ 9 屏视口（默认 21），内存与挂载量近乎减半；
 * - maxToRenderPerBatch=8（默认 10）：每批挂载行数下降，单批 JS 阻塞更短；
 * - updateCellsBatchingPeriod=40（默认 50）：批次间隔略缩，追帧能力不降。
 * 数据链路（跨章拼接 / 预取门闩 / 锚点补偿）不受影响：窗口外的行不布局，
 * 由既有 onContentSizeChange contentSize 兜底路径覆盖（MVCP 开启时原生保持）。
 */
const LIST_WINDOW_SIZE = 9;
const LIST_MAX_TO_RENDER_PER_BATCH = 8;
const LIST_UPDATE_CELLS_BATCHING_PERIOD = 40;

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
  /**
   * 繁简显示模式（书籍级设置分层）：传入 PinyinText 覆盖其内部全局读取，
   * 保证通假字浮窗等繁简相关展示与本书生效值一致；缺省回落全局（向后兼容）。
   */
  conversionMode?: 'simplified' | 'traditional';
  segmentHighlights: Highlight[];
  /**
   * 活动选区（整段全局码点区间 [start, end)）：菜单打开期间传入，
   * 渲染时给选区覆盖的字格/字符叠加主色半透明背景（选区视觉反馈）。
   */
  selectionRange?: [number, number];
  onHighlightPress: (h: Highlight) => void;
  /** 长按正文（参数为码点索引）：以该字为起点创建/重建选区 */
  onLongPressIndex: (segmentId: string, index: number) => void;
  /**
   * 点按正文（参数为段内码点索引）：选区打开时的「点按扩展」。
   * 缺省（未处于选区状态）时字符点按回落到划线/笔记点击。
   */
  onPressIndex?: (segmentId: string, index: number) => void;
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
  conversionMode,
  segmentHighlights,
  selectionRange,
  onHighlightPress,
  onLongPressIndex,
  onPressIndex,
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

  // 注音模式（PinyinText）：字格索引即整段全局码点索引，直接上报
  const handlePressChar = useCallback(
    (index: number) => {
      onPressIndex?.(segmentId, index);
    },
    [onPressIndex, segmentId],
  );

  // 'off' 模式（HighlightText）：切出的局部文本分段索引需加上区间起点
  // 还原为整段全局码点索引（长按与点按同基准）
  const handlePressSegment = useCallback(
    (localIndex: number) => {
      onPressIndex?.(segmentId, localIndex + (charRange?.[0] ?? 0));
    },
    [onPressIndex, segmentId, charRange],
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

  // 活动选区在 'off' 模式（HighlightText）渲染坐标系中的区间：
  // 未拆页时即全局区间；拆页时与 charRange 求交集并平移到局部坐标系
  // （与 offModeSlice 的划线偏移平移同型），与拆页无交集则不显示选区视觉。
  const localSelectionRange = useMemo<[number, number] | undefined>(() => {
    if (!selectionRange) {
      return undefined;
    }
    if (!charRange) {
      return selectionRange;
    }
    const [s, e] = charRange;
    const from = Math.max(s, selectionRange[0]);
    const to = Math.min(e, selectionRange[1]);
    return from < to ? [from - s, to - s] : undefined;
  }, [selectionRange, charRange]);

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
            selectionRange={localSelectionRange}
            onPressHighlight={onHighlightPress}
            onLongPressSegment={handleLongPressSegment}
            onPressChar={onPressIndex ? handlePressSegment : undefined}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        ) : (
          <HighlightText
            text={segment.text}
            highlights={segmentHighlights}
            selectionRange={localSelectionRange}
            onPressHighlight={onHighlightPress}
            onLongPressSegment={handleLongPressSegment}
            onPressChar={onPressIndex ? handlePressSegment : undefined}
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
          conversionMode={conversionMode}
          highlights={segmentHighlights}
          selectionRange={selectionRange}
          onPressHighlight={onHighlightPress}
          onLongPressChar={handleLongPressChar}
          onPressChar={onPressIndex ? handlePressChar : undefined}
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
  /**
   * 繁简显示模式：【5】必须与 sizer 量高时一致下发（SegmentItem → PinyinText
   * 的 conversionMode 覆盖）。缺省时 PinyinText 回落全局设置，若本书存在
   * 书籍级繁简覆盖且与全局不同，量高分页与实际渲染文本就会不一致，
   * 表现为页面内容与可视区域错位（填不满/溢出）。
   */
  conversionMode?: 'simplified' | 'traditional';
  highlightsBySegment: Map<string, Highlight[]>;
  /** 活动选区快照（菜单打开期间非空），用于选区视觉反馈 */
  activeSelection?: { segmentId: string; start: number; end: number } | null;
  onHighlightPress: (h: Highlight) => void;
  onLongPressIndex: (segmentId: string, index: number) => void;
  onPressIndex?: (segmentId: string, index: number) => void;
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
  conversionMode,
  highlightsBySegment,
  activeSelection,
  onHighlightPress,
  onLongPressIndex,
  onPressIndex,
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
  // 活动选区命中本段时下发整段全局码点区间（选区/划线基准不随拆页变化）
  const selectionRange: [number, number] | undefined =
    activeSelection && activeSelection.segmentId === segId
      ? [activeSelection.start, activeSelection.end]
      : undefined;
  return (
    <SegmentItem
      segment={segment}
      fontSize={fontSize}
      lineHeight={lineHeight}
      pinyinMode={pinyinMode}
      conversionMode={conversionMode}
      segmentHighlights={highlightsBySegment.get(segId) ?? EMPTY_HIGHLIGHTS}
      selectionRange={selectionRange}
      onHighlightPress={onHighlightPress}
      onLongPressIndex={onLongPressIndex}
      onPressIndex={onPressIndex}
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
  /** 当前繁简显示模式：纳入 measureKey（繁简转换改变文本 → 分页可能变化，需重量测 + 重定位） */
  displayMode: 'simplified' | 'traditional';
  highlightsBySegment: Map<string, Highlight[]>;
  /** 活动选区快照（菜单打开期间非空），透传至分页块做选区视觉反馈 */
  activeSelection?: { segmentId: string; start: number; end: number } | null;
  onHighlightPress: (h: Highlight) => void;
  onLongPressIndex: (segmentId: string, index: number) => void;
  /** 点按正文扩展选区（缺省 = 未处于选区状态，字符点按回落划线点击） */
  onPressIndex?: (segmentId: string, index: number) => void;
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
  displayMode,
  highlightsBySegment,
  activeSelection,
  onHighlightPress,
  onLongPressIndex,
  onPressIndex,
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
  /**
   * 【9】隐藏 sizer 的分批挂载进度（已放入 sizer 的段落数）。
   * 旧实现一次性挂载整章全部段落量高：大书单段 2500 字 × 逐字注音，首帧
   * 数万字格同步挂载把 JS 线程压死 —— 表现为跨章/切换排版时 loading 期间
   * 整页功能全部不可用。改为每帧批量挂载一小段段落（SIZER_BATCH_SEGMENTS），
   * 单帧工作量有界，loading 期间 UI 保持可响应；分页仍等全部段量完收敛后才出页。
   */
  const [sizerLimit, setSizerLimit] = useState(0);
  const locatedRef = useRef(false);
  /**
   * 超高段落的拆分方案：segId -> 码点边界数组（含 0 与码点总数）。
   * 边界数 > 2 表示该段被拆为多个「字符区间块」，每块独立参与分页，
   * 实现「超出一屏的段落跨多页翻页」而非页内滚动。
   */
  const [splitPlan, setSplitPlan] = useState<Record<string, number[]>>({});
  /** 拆分块高度：块 id（`segId#start-end`）-> 实测高度 */
  const [chunkHeights, setChunkHeights] = useState<Record<string, number>>({});
  /**
   * 最新 pages/index 的即时引用：measureKey 重置 effect 需要在清空测量前
   * 捕获「当前页首个真实段落」作为重定位目标，但不能把 pages/index 加进该
   * effect 的依赖（会随分页更新反复触发重置 → 死循环），故经 ref 读取最新值。
   * 赋值位于 pages useMemo 之后（渲染期同步更新，见下）。
   */
  const layoutRef = useRef<{ pages: PaginatedPage[]; index: number }>({ pages: [], index: 0 });
  /**
   * 重量测后的重定位目标段（measureKey 变化时捕获的「当前页所在段」）。
   * 注音/字号等排版因素变化会触发整章重新量测分页，页型全变；若不重定位，
   * 视口会停在原页码上但内容已换（或被 stale 定位目标拽回打开时的段落）。
   * 重定位成功后清空，避免影响后续定位。
   */
  const relocateSegIdRef = useRef<string | null>(null);
  /**
   * 【6】重量测等待门闩：measureKey 重置 effect 与定位 effect 在同一次提交内
   * 依次执行，此刻 pageReady 仍是上一轮的 stale-true —— 若不在重置时立起门闩，
   * 定位 effect 会用旧 pages「提前消费」重定位目标并把 locatedRef 置 true，
   * 量测收敛后的真正重定位被吞掉 → 繁简/注音/字号切换后停在错误页甚至跳页。
   * 门闩在 pageReady 重新计算为 true 时（见 pageReady effect）解除。
   */
  const remeasureGateRef = useRef(false);
  /** 已用 locateSegmentId 完成过定位的目标（防止 measureKey 重置后 stale 目标反复重定位） */
  const locatedSegIdRef = useRef<string | null>(null);

  // 影响「段高测量」的因素：仅排版相关（与 pageHeight 无关，段高只取决于宽度与字号/行距）。
  // 刻意不含 pageHeight：pageHeight 只应随旋转等容器尺寸变化而变化，若纳入则会触发
  // 整段重测（清空 segHeights → 首屏闪白/空白）。pageHeight 变化只重建分页，不清测量。
  // 注意：measureKey 含 pinyinMode（注音开关注音行高变化必然重排）与 displayMode
  // （繁简转换改变文本、行宽随之变化，分页可能变化），两者变化前重置测量时都先
  // 捕获当前页所在段，量测收敛后由定位 effect 回到该段所在页（防切换后章节跳动）。
  const measureKey = `${chapterTitle}|${pinyinMode}|${fontSize}|${lineHeight}|${displayMode}|${Math.round(
    pageWidth,
  )}`;
  useEffect(() => {
    // 重量测前捕获「当前页首个真实段落」：此时 pages/index 仍是旧排版的结果
    const currentPage = layoutRef.current.pages[layoutRef.current.index];
    const firstSeg = currentPage?.blocks.find((b) => b.id !== TITLE_BLOCK_ID);
    relocateSegIdRef.current = firstSeg ? blockSegId(firstSeg.id) : null;
    setSegHeights({});
    setTitleHeight(0);
    setTitleMeasured(false);
    setPageReady(false);
    setSplitPlan({});
    setChunkHeights({});
    locatedRef.current = false;
    // 【6】立起重量测门闩：定位 effect 在本提交内因 stale pageReady 会被跳过，
    // 重定位目标留待量测收敛后（新 pages）消费
    remeasureGateRef.current = true;
    // 【9】sizer 分批挂载进度同步归零（新排版从第一批重新量起）
    setSizerLimit(0);
  }, [measureKey]);

  /**
   * 【9】sizer 分批推进：每 16ms 挂载下一批段落（setTimeout 让出主线程，
   * onLayout 高度在批次间异步回填），直到全部段落进入 sizer。
   * 分页出页仍由 pageReady 门控（全部段量完 + 拆分收敛），批进不影响正确性。
   */
  useEffect(() => {
    if (pageReady || sizerLimit >= segments.length) {
      return;
    }
    const timer = setTimeout(() => {
      setSizerLimit((prev) => Math.min(segments.length, prev + SIZER_BATCH_SEGMENTS));
    }, SIZER_BATCH_INTERVAL);
    return () => clearTimeout(timer);
  }, [pageReady, sizerLimit, segments.length]);

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
   *    页高变化（旋转）时同步增删拆分（段高与页高无关，可复用）。
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
        // 页高变大后（旋转）整段可能不再超高：撤销拆分方案，
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
  // 渲染期同步更新 pages/index 即时引用（供 measureKey 重置 effect 捕获重定位目标）
  layoutRef.current = { pages, index };

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
    // 【6】量测收敛：解除重量测门闩（定位 effect 在 pageReady 状态真正翻转后的
    // 下一轮提交内消费重定位目标，见 remeasureGateRef 注释）
    if (ready) {
      remeasureGateRef.current = false;
    }
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

  // 定位：打开时跳到含目标段落的页（目标段可能被拆成多个区间块）；
  // 重量测（注音/字号切换等）后回到重定位目标段所在页。
  // 目标解析优先级：① 未定位过的显式目标（打开/切章时的 locateSegmentId）；
  // ② 重量测捕获的「当前页所在段」（relocateSegIdRef）。
  // 已定位过的显式目标不得因 measureKey 重置而反复生效——否则注音切换会被
  // 打开时的陈旧目标拽回（注音切换跳章 Bug 的翻页模式根因）。
  useEffect(() => {
    // 【6】重量测等待期跳过定位（含 pageReady stale-true 的当帧，见 remeasureGateRef）
    if (!pageReady || locatedRef.current || remeasureGateRef.current) {
      return;
    }
    const freshExplicit = !!locateSegmentId && locateSegmentId !== locatedSegIdRef.current;
    const target = freshExplicit ? locateSegmentId : relocateSegIdRef.current;
    if (!target) {
      return;
    }
    const idx = pages.findIndex((p) =>
      p.blocks.some((b) => blockSegId(b.id) === target),
    );
    if (idx >= 0) {
      locatedRef.current = true;
      relocateSegIdRef.current = null;
      if (freshExplicit) {
        locatedSegIdRef.current = locateSegmentId;
      }
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
        // 【9】缺页兜底（概率纯空白页的根因）：重分页使 pages 收缩的过渡帧，
        // PageFlipPager 仍按旧 pageCount 渲染越界页，旧实现返回 null →
        // 渲染出一张纯空白纸页。回退为章节标题占位页，保证任何页非空。
        return (
          <ScrollView
            style={[styles.pageScroll, { height: pageHeight }]}
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.pageInner, { width: pageWidth }]}>
              <ChapterTitleText
                title={chapterTitle}
                pinyinMode={pinyinMode}
                conversionMode={displayMode}
                workId={workId}
                bookId={bookId}
              />
            </View>
          </ScrollView>
        );
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
                <ChapterTitleText
                  key={b.id}
                  title={chapterTitle}
                  pinyinMode={pinyinMode}
                  conversionMode={displayMode}
                  workId={workId}
                  bookId={bookId}
                />
              ) : (
                <SegmentBlockItem
                  key={b.id}
                  blockId={b.id}
                  segById={segById}
                  segCharCounts={segCharCounts}
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                  pinyinMode={pinyinMode}
                  conversionMode={displayMode}
                  highlightsBySegment={highlightsBySegment}
                  activeSelection={activeSelection}
                  onHighlightPress={onHighlightPress}
                  onLongPressIndex={onLongPressIndex}
                  onPressIndex={onPressIndex}
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
      displayMode,
      highlightsBySegment,
      activeSelection,
      onHighlightPress,
      onLongPressIndex,
      onPressIndex,
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
          {/* 【5】量测宽度与渲染宽度显式对齐：渲染层 pageInner 宽度为 pageWidth，
              sizer 必须在同一宽度下量高，否则量得高度与实际排版不一致，
              分页结果与可视区域错位（页面内容填不满/溢出的根因之一） */}
          <View style={[styles.pageInner, { width: pageWidth }]}>
            <ChapterTitleText
              title={chapterTitle}
              pinyinMode={pinyinMode}
              conversionMode={displayMode}
              workId={workId}
              bookId={bookId}
              onLayout={(e) => {
                setTitleHeight(e.nativeEvent.layout.height);
                setTitleMeasured(true);
              }}
            />
            {/* 【9】分批挂载：仅渲染前 sizerLimit 段参与量高（见 sizerLimit 注释） */}
            {segments.slice(0, sizerLimit).map((seg) => {
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
                        conversionMode={displayMode}
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
                    conversionMode={displayMode}
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
          {/* 【9】loading 局部化：显示章节名 + 轻量 spinner（不再是一整张无信息的
              空白 loading 页）；量高已分批执行不阻塞 JS，期间顶部/底部功能区可用 */}
          <ChapterTitleText
            title={chapterTitle}
            pinyinMode={pinyinMode}
            conversionMode={displayMode}
            workId={workId}
            bookId={bookId}
          />
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}
    </View>
  );
}

// ============ 章节标题（注音版） ============

/**
 * 章节标题统一渲染（滚动模式标题行 / 翻页模式标题块、sizer、loading 占位共用）。
 * 注音关闭时 PinyinText 自动降级为纯文本（样式经 baseTextStyle 与旧纯 Text
 * 保持一致：加粗 + 居中）；开启时逐字注音。注音开启会使标题高度增加
 * （字格变上下双行结构），翻页模式 sizer 用同一组件量高 → 分页自动适配，
 * 无需额外估算；滚动模式标题行走 handleRowLayout 实测，天然自适应。
 */
function ChapterTitleText({
  title,
  pinyinMode,
  conversionMode,
  workId,
  bookId,
  onLayout,
}: {
  title: string;
  pinyinMode: PinyinMode;
  conversionMode?: 'simplified' | 'traditional';
  workId?: string;
  bookId?: string;
  /** 透传外层 View 的布局事件：翻页 sizer 取 height（量高分页），
   *  滚动模式标题行取 y（rowOffsets 行偏移登记） */
  onLayout?: (e: LayoutChangeEvent) => void;
}): React.JSX.Element {
  return (
    <View style={styles.chapterTitleWrap} onLayout={onLayout}>
      <PinyinText
        text={title}
        fontSize={PAGE_TITLE_FONT_SIZE}
        lineHeight={1.3}
        pinyinMode={pinyinMode}
        conversionMode={conversionMode}
        workId={workId}
        bookId={bookId}
        baseTextStyle={styles.chapterTitleText}
      />
    </View>
  );
}

// ============ 主页面 ============

function ReaderScreen({ route, navigation }: ReaderScreenProps): React.JSX.Element {
  // 设置（阅读纸张/字号/行距/注音模式/繁简）：书籍级分层（settings 分层）。
  // 读：perBookSettings[bookId] 覆盖优先，缺键回落全局默认（「我的-设置」写全局层）；
  // 写：面板内修改仅写书籍层覆盖（无 bookId 的防御路径回落全局层，保持旧行为）。
  const routeBookId = route?.params?.bookId ?? null;
  const {
    paper,
    readerMode,
    fontSize,
    lineHeight,
    pinyinMode,
    conversionMode,
    setPaper,
    setReaderMode,
    setFontSize,
    setLineHeight,
    setPinyinMode,
    setConversionMode,
    hasBookOverrides,
    isPerBook,
    followGlobal,
  } = useReaderBookSettings(routeBookId);
  // 正文朗读（P2-02）：语速（持久化，0.5–2.0）与朗读状态
  const speechRate = useSettingsStore((s) => s.speechRate);
  const setSpeechRate = useSettingsStore((s) => s.setSpeechRate);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  // 「听」按钮语速设置弹窗：visible 控制显隐，tempRate 为弹窗内本地临时值
  // （确认才写回 setSpeechRate 持久化并用于播放；取消不污染持久化设置）
  const [rateModalVisible, setRateModalVisible] = useState(false);
  const [tempSpeechRate, setTempSpeechRate] = useState(speechRate);

  const colors: ThemeColors = getPaperColors(paper);

  /** 连续滚动模式：已拼接的章节序列（首项为当前打开章，滚到末尾向后追加） */
  const [continuousChapters, setContinuousChapters] = useState<Chapter[]>([]);
  /**
   * 当前拼接序列的「种子章」id：切章重置 effect 以路由章重置序列时同步记录。
   * 用于区分「切章过渡帧」（种子章 ≠ 路由章，序列还是旧章的，需以路由章单独成列防闪烁）
   * 与「滑动窗口丢头后的稳态」（种子章 = 路由章但入口章已被丢出窗口，序列仍需原样使用）。
   */
  const [continuousSeedChapterId, setContinuousSeedChapterId] = useState<string | null>(null);
  /** 实际正在阅读的章节（滚动跨章后与路由 chapterId 不同），初值在 chapterId 解析后给出 */
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  /** continuousChapters 的即时引用：滚动回调需读到最新值，避免闭包陈旧 */
  const continuousRef = useRef<Chapter[]>([]);
  /** 当前拼接序列的章 id 集合（滚动回调防串扰：只认序列内的章，见 onViewableItemsChanged） */
  const continuousChapterIdsRef = useRef<Set<string>>(new Set());
  /** activeChapterId 的即时引用（滚动回调内高频读写，避免闭包陈旧） */
  const activeChapterIdRef = useRef<string | null>(null);
  /** 行 id -> 内容内偏移（打开定位 + 章内进度计算共用） */
  const rowOffsets = useRef<Map<string, number>>(new Map());
  /** 追加下一章的并发/重复守卫 */
  const loadingNext = useRef(false);
  /**
   * 最近一次成功 append 的时刻：onContentSizeChange 的锚点兜底补偿用它
   * 区分「本次 contentSize 增量是否混入了 append 高度」。attempt 中
   * append 先于 prepend 执行，二者的渲染在同一帧合并，contentSize 增量
   * = prepend 高度 + append 高度——若不作区分，兜底补偿会把视口向前
   * 多甩出一个 append 章的高度（跳章后连滚多章的根因之一）。
   */
  const lastAppendAtRef = useRef(0);
  /**
   * append 与 prepend 视为「同 tick 合并渲染」的时间窗：attempt 中两者背靠背
   * 执行（毫秒级间隔），其 contentSize 变化合并为一次事件；超过该窗的 append
   * 与 prepend 互不影响，锚点增量兜底可放心使用 contentSize 增量补偿。
   */
  const APPEND_COALESCE_MS = 100;
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
  /** 上一帧滚动偏移（方向判定：仅「朝顶部移动」的滚动才允许触发向前拼接） */
  const lastScrollOffsetRef = useRef(0);
  /**
   * 用户手势窗口（切章防跳动 / 防跳错章节的关键）。
   * true = 用户正在拖拽或惯性滚动（onScrollBeginDrag 开窗，onMomentumScrollEnd
   * 及 onScrollEndDrag 后的短延时关窗）。自动向前拼接只允许发生在该窗口内。
   * 上一版实现是「首次拖拽后永久打开」的门闩——短章内置书（每章约一屏）在
   * 目录切章后向下阅读的头两屏内 offset 恒 < 2 屏预载阈值，向下滑动即误触发
   * 向前拼接：视口上方突然长出一章内容、当帧闪现上一章开头再被锚点补偿拉回，
   * 表现为「上下滚动仍跳动」乃至「打开的却是别的章节」。改为手势窗口 + 方向
   * 判定（见 shouldAutoPrepend）后，向下阅读永不触发拼接。
   */
  const userScrollActiveRef = useRef(false);
  /**
   * 手指是否仍按在屏幕上拖拽（onScrollBeginDrag 开、onScrollEndDrag 关）。
   * 与 userScrollActiveRef 的区别：后者在 endDrag 后还会存活至惯性结束或
   * 500ms 兜底关窗，用于拼接判定；本 ref 专门用于「手指还按着」的判定——
   * 手指按下期间绝不能执行 prepend + 补偿 scrollTo（与原生拖拽争夺视口）。
   */
  const dragActiveRef = useRef(false);
  /**
   * 延迟拼接意图：手势进行中（拖拽/惯性）满足了拼接条件时不立即执行，置位
   * 本标记，待拖拽完全结束（onMomentumScrollEnd / endDrag 后关窗计时器）后
   * 由 consumeDeferredPrepend 统一消费。这保证「插入内容 + 补偿 scrollTo」
   * 永不与进行中的原生滚动争夺视口（跳章根因之一），同时保留手势结束时刻
   * 的拼接意图（章首回弹加载上一章仍可用）。
   */
  const deferredPrependIntentRef = useRef(false);
  /**
   * 显式跳章后的「章首驻留期」守卫：goToChapter 跳章落定（切章 effect 消费
   * explicitChapterJumpRef）时以目标章置位；用户把当前章读出超过
   * CHAPTER_HEAD_DWELL_SCREENS 屏高（handleScroll 观察）或切章/换模式后解除。
   * 驻留期内 shouldAutoPrepend 拦截 offset > 0 的手势拼接（保留 offset ≤ 0
   * 的章首回弹 endDrag 路径），防止「跳章后立即上滑」在切章过渡态触发
   * prepend 导致的跳章。
   */
  const chapterHeadDwellRef = useRef<{ chapterId: string } | null>(null);
  /** 无惯性手势的关窗兜底延时（有惯性时由 onMomentumScrollEnd 先行关窗） */
  const scrollWindowCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 拖拽结束但无惯性时的关窗延时 */
  const SCROLL_WINDOW_CLOSE_MS = 500;
  /**
   * 滑动窗口丢头的滚动补偿量（px）：丢头使保留内容整体上移，onContentSizeChange
   * 消费时把滚动偏移回退该值，使视口仍停留在用户正在阅读的内容上。
   * 写入于 setContinuousChapters 之前，消费于丢头引发的那次 contentSize 变化。
   */
  const headDropCompensation = useRef(0);
  /**
   * maybeDropHeadChapters 的即时引用：onViewableItemsChanged 是一次性创建的
   * useRef 回调（不能安全闭包 useCallback 实例），经此 ref 调用最新实现。
   */
  const maybeDropHeadRef = useRef<() => void>(() => undefined);
  /** 滚动模式列表引用（定位段落 + 向前拼接后的偏移补偿） */
  const listRef = useRef<FlatList<ReaderRow>>(null);
  // 【PERF】诊断打点：组件挂载时刻 + 首次内容布局标记（一次性）
  const readerMountT0Ref = useRef(Date.now());
  const firstContentSizeLoggedRef = useRef(false);
  /** 打开时一次性定位到目标段落：行 id + 是否已完成 */
  const pendingScroll = useRef({ target: '', done: false });
  /** 「打开时定位」的超时放弃计时器（同一时刻至多一个，见 LOCATE_TIMEOUT_MS） */
  const locateGiveUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 段内精确续读（滚动模式）：lastRead.offsetRatio 恢复态。
   * 段级定位只能落到 segment 起点——短章/大段书（如道德经单章单段）的章节
   * 中段位置会退化为章首；此处在段级定位完成后，按「段顶 + 比例 × 段高」
   * 做一次精修落位。anchorOffset 为定位完成时刻的视口偏移，用于检测用户
   * 是否已抢先手动滚动（是则放弃，避免与手势争夺视口）。
   */
  const ratioRefineRef = useRef<{ segmentId: string; ratio: number; anchorOffset: number } | null>(
    null,
  );
  /** 比例精修轮询计时器（定位完成后 300ms 间隔探测段高收敛，见 startRatioRefinePollRef） */
  const ratioRefineTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 比例精修轮询入口（实现体在 scrollInitialRows 之后按需赋值，同 locatePendingRowRef 模式） */
  const startRatioRefinePollRef = useRef<(segmentId: string) => void>(() => undefined);
  /**
   * 向前拼接的「空壳章待填」记录：上一章尚未填充（内置书壳）时 prepend 拒插，
   * 转为按需优先填充；填充完成由进度订阅重试拼接（用户仍在顶部附近时）。
   */
  const pendingPrevPrependRef = useRef<{ chapterId: string; requestedAt: number } | null>(null);
  /** prependPreviousChapter 最新实现的 ref（填充进度订阅闭包安全调用） */
  const prependPrevRef = useRef<() => void>(() => undefined);
  /**
   * 顶端插入补偿（读上一章）：待对齐的旧首章标题行。prepend 后由
   * scrollToIndex(插入行数) 拉到视口顶（估算落点），该行挂载后用
   * cell 级真实 y 一次性修正（见 handleRowLayout 消费点）。
   */
  const topAlignRef = useRef<{ rowId: string; createdAt: number; done: boolean } | null>(null);
  /**
   * 注音切换等「行高整体变化」场景的视口锚点（滚动模式防跳动）。
   * 注音开启/关闭会使正文行高成倍变化（PinyinText 逐字两行 ↔ HighlightText 单行），
   * 视口上方全部内容的高度随之改变，而滚动 offset 数值不变 → 视口内的内容直接
   * 跳变成其它段落。补偿方式：切换前捕获「视口顶部所在行 + 视口顶入该行的深度」，
   * 行重排后该行重新 onLayout 时按「新 y + 深度」一次性落位，使视口停留在
   * 用户正在阅读的位置（同段落，允许行高变化导致的轻微位移）。
   */
  const layoutAnchor = useRef<{ rowId: string; delta: number; createdAt: number } | null>(null);

  /**
   * 目录显式跳章标记：goToChapter（目录/翻页跨章）时置位，由切章 effect 消费。
   * 显式跳章语义 = 落在目标章【章首】，不得恢复该章上次阅读段落（P1-17 续读
   * 仅适用于「打开书」场景）；否则「目录重选刚读过的章」会落到章中间，
   * 被用户感知为「跳错章节」。仅在目标章 ≠ 当前章时置位，防止同章重选
   * 不触发切章 effect 时标记残留、误吞下一次正常打开的续读。
   */
  const explicitChapterJumpRef = useRef(false);

  /**
   * 自动向前拼接上一章的统一触发判定（单一判定源，全部触发点共用）：
   * ①滚动模式 ②处于用户手势窗口（拖拽/惯性中，见 userScrollActiveRef）
   * ③视口在顶部预载窗口内 ④滚动方向朝顶部（offset 较上一帧变小），
   * 或已压在/越过顶部（offset ≤ 0：iOS 回弹为负、Android 压顶恒 0）。
   * ④保证「向下阅读」（offset 增大）永不触发拼接——这是上一版「首拖即永开」
   * 门闩在短章书上把切章后的正常下滑误判为需要拼接、造成跳动/闪现上一章
   * 的根因；程序化 scrollTo（切章复位、补偿落位）则因非手势窗口被排除。
   * 【5】显式跳章后的章首驻留期（chapterHeadDwellRef）：跳章落章首后用户尚未
   * 读出超过阈值屏高时，拦截 offset > 0 的手势拼接——此时切章的 remeasure /
   * 定位可能尚未收敛，prepend 的补偿基于过渡态基准会跳章；「读上一章」入口
   * 保留 offset ≤ 0 的章首回弹路径（endDrag 放行，见 handleScrollEndDrag）。
   */
  const shouldAutoPrepend = useCallback(
    (offset: number): boolean => {
      if (readerMode !== 'scroll' || !userScrollActiveRef.current) {
        return false;
      }
      if (offset > viewH.current * CONTIGUOUS_PRELOAD_SCREENS) {
        return false;
      }
      const dwell = chapterHeadDwellRef.current;
      if (dwell && offset > 0 && dwell.chapterId === activeChapterIdRef.current) {
        return false;
      }
      return offset <= 0 || offset < lastScrollOffsetRef.current;
    },
    [readerMode],
  );

  /**
   * 武装/重新武装「打开时定位」：目标行 onLayout 后由 handleRowLayout 落位。
   * 目标行若超出初始渲染窗口且无历史布局数据，onLayout 永远不会触发；
   * 超时放弃定位（落回章首属可接受降级），同时避免 pendingScroll 未完成的
   * 守卫把向前拼接卡死。重复武装先清旧计时器，保证计时器始终对应最新目标。
   */
  const armScrollLocate = useCallback(
    (target: string) => {
      pendingScroll.current = { target, done: false };
      console.info(`[PERF][locate] arm target=${target || '(empty)'}`);
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
          // 超时放弃段级精调（落回估算位/章首）：比例精修仍可继续探测——
          // 目标行此后挂载时按比例重建位置，好于放任不管
          if (pendingScroll.current.target) {
            startRatioRefinePollRef.current(pendingScroll.current.target);
          }
        }
      }, LOCATE_TIMEOUT_MS);
    },
    [pendingScroll],
  );

  /**
   * 捕获滚动模式视口锚点（注音切换前调用）：
   * 取「y ≤ 当前偏移 + 24」的最大 y 行（即视口顶部所在行，含标题行），
   * 记录该行 id 与视口顶入深度（offset - y）。rowOffsets 中的 y 为行在内容
   * 容器内的绝对偏移，与 scrollOffset 同基准，可直接比较。
   */
  const captureViewportAnchor = useCallback(() => {
    if (readerMode !== 'scroll') {
      return;
    }
    const offset = scrollOffset.current;
    let bestId = '';
    let bestY = -1;
    for (const [id, y] of rowOffsets.current) {
      if (y <= offset + 24 && y > bestY) {
        bestY = y;
        bestId = id;
      }
    }
    if (!bestId || bestY < 0) {
      return;
    }
    layoutAnchor.current = {
      rowId: bestId,
      delta: Math.max(0, offset - bestY),
      createdAt: Date.now(),
    };
  }, [readerMode, rowOffsets]);

  // 交互状态
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionVisible, setSelectionVisible] = useState(false);
  /**
   * 活动选区（选区菜单打开期间）的正文字段快照：仅当菜单可见且存在选区时非空。
   * 用于把 [start, end) 码点区间下发到渲染组件做选区视觉反馈；
   * 菜单收起 / 保存划线 / 打开解析等清空 selectionVisible 后视觉随之消失。
   */
  const activeSelection = useMemo(
    () =>
      selectionVisible && selection
        ? { segmentId: selection.segmentId, start: selection.start, end: selection.end }
        : null,
    [selectionVisible, selection],
  );
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [analysisText, setAnalysisText] = useState('');
  // 选段在线翻译（P0：用户自带 Key 的服务商适配器）
  const [translationVisible, setTranslationVisible] = useState(false);
  const [translationText, setTranslationText] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [noteContent, setNoteContent] = useState('');
  /** 「删除划线」两步确认态：true 表示已点过一次、按钮进入警示色待确认样式 */
  const [confirmDeleteHighlight, setConfirmDeleteHighlight] = useState(false);
  /** 待确认态自动复位计时器（3 秒未再点恢复普通样式） */
  const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 选词面板「取消划线」两步确认态（与笔记编辑器删除划线同一交互范式） */
  const [confirmCancelHighlight, setConfirmCancelHighlight] = useState(false);
  const cancelHlConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // 底部浮动 dock 已删除（UI 精简：进度/朗读/注音/工具栏并入长按弹出菜单与右上角），
  // 仿真翻页可用页高即 pagerArea 完整高度，不再扣除 dock 高度。
  // 仅在 pagerArea 已完成量高后给有效值；首帧 pagerLayout.height=0 时保持 0，
  // 让 PageModeView 走占位/测量态，避免「最小 80」在首帧触发一次错误分页与定位跳页。
  const measured = pagerLayout.height > 0;
  const visiblePageHeight = measured ? Math.max(80, pagerLayout.height) : 0;

  const params = route?.params;
  const bookId = params?.bookId ?? null;
  const chapterId = params?.chapterId ?? null;
  // 提取为原始值参与依赖比较：route/params 为父组件（ContinueReading）每次渲染
  // 新建的对象，若以对象引用作依赖会引发 setState 无限循环（Maximum update depth）
  const segmentId = params?.segmentId ?? null;
  /**
   * 跳转序号：goToChapter 每次跳转都刷新。目录跳到「当前章」时路由参数
   * 其余字段不变（navigate 浅合并不触发任何 effect），携带递增序号让
   * 「切章重置 / 复位」两个 effect 重新执行 → 落回章首（重复跳转生效）。
   */
  const jumpSeq = params?.jumpSeq;

  // 按需水合（性能）：内置书启动只注册目录元数据（书架秒开），进入阅读器
  // 时经 ensureBookReady 首章优先快速水合——只解析当前章（几十 ms）即上屏，
  // 其余章节由后台分批填充（订阅 onBuiltinFillProgress 驱动 hydrateTick
  // 重算：跳到尚未填充完的章时，该章正文就位后自动变为可读）。
  const [hydrateTick, setHydrateTick] = useState(0);
  const [builtinHydrating, setBuiltinHydrating] = useState(false);
  const [builtinHydrateFailed, setBuiltinHydrateFailed] = useState(false);
  // 填充通知的「当前章空→满」边沿基准（见 onBuiltinFillProgress 回调注释）
  const lastCurFilledRef = useRef(false);
  // useLayoutEffect：水合标记必须在首帧绘制前置位——否则「元数据章（正文空）」
  // 会先渲染一帧空内容，effect 落地后才切换到加载中（闪一帧空白）。
  useLayoutEffect(() => {
    if (!bookId || TextLibraryService.isUserBook(bookId)) {
      setBuiltinHydrating(false);
      return;
    }
    let cancelled = false;
    // 空壳目标章按需补装：ensureBookReady 对 early-hydrated 书直接返回当前
    // 书体（不补装新优先章），跳章/续读落到后台填充尚未推进到的章时，该章
    // 保持空壳 → loading 只能等按书序填充慢慢推进（大部头分钟级）。这里用
    // meta 字节切片毫秒级单章装配兜底；完成时经进度订阅驱动 hydrateTick
    // 重算自动解除 loading。幂等（已有正文的章直接 true），与后台填充并发
    // 安全（双方写入内容一致）。
    const fillShellTargetIfNeeded = () => {
      if (!chapterId) {
        return;
      }
      const cur = TextLibraryService.getBook(bookId);
      const ch =
        cur.success && cur.data
          ? cur.data.chapters.find((c) => c.id === chapterId)
          : null;
      if (ch && ch.segments.length === 0) {
        void UserBookService.fillBuiltinChapterNow(bookId, chapterId);
      }
    };
    if (TextLibraryService.isBookHydrated(bookId)) {
      // 已水合（含早期部分水合）：跳章重跑的常态路径——补装空壳目标章
      setBuiltinHydrating(false);
      fillShellTargetIfNeeded();
      return;
    }
    const hydrateT0 = Date.now();
    console.info(`[PERF][reader] mount book=${bookId} ch=${chapterId ?? '-'}`);
    setBuiltinHydrating(true);
    setBuiltinHydrateFailed(false);
    UserBookService.ensureBookReady(bookId, { priorityChapterId: chapterId })
      .then((res) => {
        if (cancelled) {
          return;
        }
        console.info(
          `[PERF][reader] hydrated ok=${res.success} +${
            Date.now() - hydrateT0
          }ms`,
        );
        setBuiltinHydrating(false);
        setBuiltinHydrateFailed(!res.success);
        if (res.success) {
          setHydrateTick((t) => t + 1);
          // 竞争窗口兜底：mount 水合进行中用户已跳章 → ensureBookReady
          // 命中旧优先章的 in-flight promise，新优先章未被装配
          fillShellTargetIfNeeded();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBuiltinHydrating(false);
          setBuiltinHydrateFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterId]);

  // 章节后台填充进度订阅：每批 30 章合并后触发，当前书命中时重算派生
  //（用户跳进空壳章后，该章正文就位即自动渲染，无需重进）
  // 同时把拼接序列中被替换的章节对象同步为新引用：填充合并以新对象
  // 替换原章对象，序列里的旧引用若不同步，effectiveChapters 会渲染陈旧空壳。
  useEffect(() => {
    if (!bookId || TextLibraryService.isUserBook(bookId)) {
      return undefined;
    }
    return UserBookService.onBuiltinFillProgress((filledBookId) => {
      if (filledBookId !== bookId) {
        return;
      }
      const cbT0 = Date.now();
      const fresh = TextLibraryService.getBook(filledBookId);
      if (fresh.success && fresh.data) {
        const byId = new Map(fresh.data.chapters.map((c) => [c.id, c]));
        const current = continuousRef.current;
        let changed = false;
        const merged = current.map((c) => {
          const updated = byId.get(c.id);
          if (updated && updated !== c) {
            changed = true;
            return updated;
          }
          return c;
        });
        // hydrateTick（强制 book/chapter useMemo 重算 → 整树重渲染）仅在
        // 「视图真的受影响」时递增：填充按书序推进，绝大多数批次更新的
        // 是与当前视口无关的远端章——旧实现无条件 tick 使每次通知都全树
        // 重渲染（真机采样：每片同步块 500-800ms，填充期 UI 持续饱和）。
        // 需要渲染的两种情形：
        // ① changed：拼接序列内的章被填充替换（滚动模式内容更新）；
        // ② 当前章「空壳→非空」边沿：页面模式/跳章兜底场景，章对象与库内
        //    同引用（fill mutate 即时可见），仅需一次 render 解除 loading。
        const curCh = chapterRef.current;
        const curFilled = !!curCh && curCh.segments.length > 0;
        const viewDirty = changed || (curFilled && !lastCurFilledRef.current);
        lastCurFilledRef.current = curFilled;
        if (changed) {
          continuousRef.current = merged;
          setContinuousChapters(merged);
        }
        if (viewDirty) {
          setHydrateTick((t) => t + 1);
        }
        // 空壳章待填的向前拼接重试：上一章按需填充完成后，用户若仍在
        // 顶部附近（意图未消失）则自动补拼；已滚走则丢弃意图
        const pending = pendingPrevPrependRef.current;
        if (pending) {
          const filled = fresh.data.chapters.find((c) => c.id === pending.chapterId);
          if (filled && filled.segments.length > 0) {
            pendingPrevPrependRef.current = null;
            if (
              readerMode === 'scroll' &&
              scrollOffset.current <= viewH.current * CONTIGUOUS_PRELOAD_SCREENS
            ) {
              prependPrevRef.current();
            }
          } else if (Date.now() - pending.requestedAt > 30000) {
            pendingPrevPrependRef.current = null; // 兜底过期，防永久挂起
          }
        }
      }
      const cbMs = Date.now() - cbT0;
      if (cbMs >= 50) {
        console.info(`[PERF][fill-cb] heavy=${cbMs}ms`);
      }
    });
  }, [bookId, readerMode]);

  // 切章时重置「当前章已填充」边沿基准：新章（空壳）填充完成时必须触发
  // viewDirty=true 解除 loading，不能沿用上一章的 true 基准（会吞掉 tick）
  useEffect(() => {
    lastCurFilledRef.current = false;
  }, [chapterId]);

  // 文本数据：随路由参数【同步派生】（BugFix：切章时旧章内容多渲染一帧的闪烁）。
  // 旧实现经 init effect 异步 setState 加载：点「下一章」后参数已变、章节状态仍是
  // 旧章，当帧先渲染第一章、等 effect 落地才换新章，产生「先第一章再跳走」的闪烁。
  // getBook/getChapter 均为同步内存索引（内置书 JSON / 已注册用户书），无需异步——
  // 派生后参数一变、当帧即得新章数据；派生失败（无参数/未找到）由 loadError 表达。
  const book = useMemo<Book | null>(() => {
    void hydrateTick; // 水合完成后强制重算（内置书全文就位）
    if (!bookId) {
      return null;
    }
    const res = TextLibraryService.getBook(bookId);
    return res.success ? res.data ?? null : null;
  }, [bookId, hydrateTick]);
  const chapter = useMemo<Chapter | null>(() => {
    void hydrateTick; // 水合完成后强制重算（同上）
    if (!chapterId) {
      return null;
    }
    const res = TextLibraryService.getChapter(chapterId);
    return res.success ? res.data ?? null : null;
  }, [chapterId, hydrateTick]);
  const loadError = useMemo<string | null>(() => {
    if (!bookId || !chapterId) {
      return '缺少书籍或章节参数';
    }
    if (builtinHydrateFailed) {
      return '书籍内容加载失败';
    }
    if (!book) {
      return '加载书籍失败';
    }
    if (!chapter) {
      return '加载章节失败';
    }
    return null;
  }, [bookId, chapterId, book, chapter, builtinHydrateFailed]);

  /**
   * 上一章预热（滚动模式）：内置书后台填充按书序进行，跳到靠后章节时
   * 「上一章」可能长期处于空壳态——用户往上滚触发向前拼接时才临时填充，
   * 期间视口上方无内容（空白/回弹）。本 effect 在章就绪后立即按需优先
   * 填充上一章（meta 切片毫秒级），用户上滚时拼接零等待。
   * 幂等性由 fillBuiltinChapterNow 保证（已有正文直接返回，并发去重）。
   */
  useEffect(() => {
    if (readerMode !== 'scroll' || !bookId || !chapter || !book) {
      return;
    }
    if (TextLibraryService.isUserBook(bookId)) {
      return; // 用户书无空壳概念（整本同时就位）
    }
    const idx = book.chapters.findIndex((c) => c.id === chapter.id);
    const prev = idx > 0 ? book.chapters[idx - 1] : undefined;
    if (prev && prev.segments.length === 0) {
      void UserBookService.fillBuiltinChapterNow(bookId, prev.id);
    }
  }, [readerMode, bookId, book, chapter]);

  /**
   * 滚动拼接序列的「当帧一致视图」（切章闪烁的另一半修复）。
   * 路由切章后、重置 effect 把 continuousChapters 重置为 [chapter] 之前，
   * continuousChapters 仍是上一章的序列，直接渲染会闪现旧章内容。
   * 派生规则：重置 effect 已以当前路由章为种子重置过序列（种子章匹配且序列非空）
   * → 原样使用；否则（切章过渡帧 / 初始帧）→ 以路由章单独成列，当帧即渲染新章。
   * 注意不能用「路由章是否在序列中」作判据：滑动窗口丢头后，入口章可能已被
   * 丢弃出窗口（用户已滚到很远的前方），此时序列必须原样使用。
   */
  const effectiveChapters = useMemo<Chapter[]>(() => {
    if (chapter && continuousSeedChapterId === chapter.id && continuousChapters.length > 0) {
      return continuousChapters;
    }
    return chapter ? [chapter] : [];
  }, [chapter, continuousSeedChapterId, continuousChapters]);

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
   * 段内精确续读：章内滚动比例（滚动模式）。与 restoreSegmentId 同守卫，
   * 另要求比例在开区间 (0.001, 0.999) 内——0/1 意味着章首/章尾，段级定位
   * 已覆盖，无需精修（章尾比例也可能因记录时内容高度不足而虚高，宁可保守）。
   */
  const restoreOffsetRatio = useMemo<number | null>(() => {
    if (segmentId || !bookId || !chapterId) {
      return null;
    }
    const last = useReaderStore.getState().lastRead;
    const ratio = last !== null && last.bookId === bookId && last.chapterId === chapterId
      ? last.offsetRatio
      : undefined;
    return typeof ratio === 'number' && ratio > 0.001 && ratio < 0.999 ? ratio : null;
  }, [segmentId, bookId, chapterId]);

  /**
   * 按当前繁简模式转换文本：正文段落、章标题、书名统一走此入口，
   * 保证「已展示章」与「后续拼接章」视觉一致、切换不错位。
   * 语种自适应（BugFix：导入繁体书在简体模式下不生效）：以单次 tw2cn
   * 探测源文语种——结果与原文一致为简体源，不同为繁体源。简体显示时
   * 仅繁体源转简（简体源直通，避免 opencc 归一化改动原文）；繁体显示
   * 时仅简体源转繁（繁体源直通，切换即直通更快）。
   * 【6】转换走带缓存入口（utils/conversionMemo）：繁简切换需对当前章全部段落
   * 重转一遍（单段可达 2500 字），opencc 直接调用耗时显著；同文本同会话结果
   * 恒定，进程内 LRU 缓存让重复切换/重渲染/邻章预热全部命中，切换耗时大幅下降。
   */
  const toDisplayText = useCallback(
    (text: string): string => {
      const asSimplified = memoToSimplified(text);
      if (asSimplified === text) {
        // 简体源
        if (conversionMode === 'simplified') {
          return text;
        }
        return memoToTraditional(text);
      }
      // 繁体源
      if (conversionMode === 'simplified') {
        return asSimplified;
      }
      return text;
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

  /**
   * 顶部章节名跟随「实际正在阅读的章」：【4】滚动模式连续拼接后路由章停留在
   * 入口章，若标题仍显示路由章，会与底部进度条/目录高亮互相矛盾——用户以
   * 顶部标题/目录高亮为心智基准做导航，感知上就是「选了 A 打开的却是别的章节」。
   * 口径与 progressChapterId 一致（滚动模式取 activeChapterId）。
   */
  const headerChapterId = readerMode === 'scroll' ? activeChapterId ?? chapterId : chapterId;
  const displayChapterTitle = useMemo(() => {
    const headerChapter = headerChapterId
      ? effectiveChapters.find((c) => c.id === headerChapterId)
      : undefined;
    return toDisplayText(headerChapter?.title ?? chapter?.title ?? '');
  }, [headerChapterId, effectiveChapters, chapter, toDisplayText]);

  // 用户数据（划线/笔记/收藏）
  // 滚动模式跨章后路由 chapterId 仍停留在入口章，故按「已拼接章节集合」整体加载，
  // 否则后续章节的历史划线/笔记读不到（表现为划线不显示、点划线重复建笔记）。
  const annotationScope = useMemo<string[] | undefined>(() => {
    if (readerMode === 'scroll') {
      return effectiveChapters.map((c) => c.id);
    }
    return chapterId ? [chapterId] : undefined;
  }, [readerMode, effectiveChapters, chapterId]);
  const { highlights, addHighlight, removeHighlight } = useHighlightsForChapters(
    bookId ?? undefined,
    annotationScope,
  );
  const { notes, addNote, updateNote, removeNote } = useNotesForChapters(
    bookId ?? undefined,
    annotationScope,
  );
  const { bookmarks, addBookmark, removeBookmark } = useBookmarks();

  // 初始化：初始化数据库（幂等）并记录阅读位置。
  // 书籍/章节文本已由上方 useMemo 随路由参数同步派生，本 effect 只保留副作用。
  useEffect(() => {
    if (!bookId || !chapterId) {
      return;
    }
    StorageService.initDatabase();
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

  /**
   * 【9】邻章转换预热（仅翻页模式）：跨章翻页会挂载新章并做全量繁简转换 +
   * 量高分页，opencc 转换是 loading 时长的主要构成之一。这里在当前章阅读
   * 期间分批把下一章文本过一遍 toDisplayText（命中 conversionMemo 缓存），
   * 把转换开销从跨章瞬间挪到闲时分批执行，不阻塞当前帧；
   * 缓存按原文键控，预热与实际打开时的转换结果一致。
   */
  useEffect(() => {
    if (readerMode !== 'page' || !siblings.next || siblings.next.segments.length === 0) {
      return;
    }
    const nextSegments = siblings.next.segments;
    let cursor = 0;
    const timer = setInterval(() => {
      for (const seg of nextSegments.slice(cursor, cursor + SIZER_BATCH_SEGMENTS)) {
        toDisplayText(seg.text);
      }
      cursor += SIZER_BATCH_SEGMENTS;
      if (cursor >= nextSegments.length) {
        clearInterval(timer);
      }
    }, SIZER_BATCH_INTERVAL * 2);
    return () => clearInterval(timer);
  }, [readerMode, siblings, toDisplayText]);

  /** 跳转至指定章节（目录 / 翻页跨章）：显式导航语义 = 落在目标章章首。
   *  【4】两处防「跳错章节」：
   *  ① segmentId 显式置 undefined——navigate 对既有路由做【浅合并】参数，
   *  早前「模式切换跨章跟随」等携带的 segmentId 会残留到新章，使定位武装
   *  指向不属于目标章的段落（1.5s 超时前处于未定态，还会把错误段落写进 lastRead）；
   *  ② 置位 explicitChapterJumpRef（仅目标章 ≠ 当前章时），切章 effect 据此
   *  跳过 P1-17 续读定位，保证目录选章必落章首。 */
  const goToChapter = useCallback(
    (cid: string) => {
      if (!bookId) {
        return;
      }
      // 显式跳章一律置位（含跳到当前章）：跳「当前章」语义 = 放弃拼接
      // 序列现状、落回该章章首。jumpSeq 每次刷新使两个重置 effect 在
      // 同章重复跳转时也会重新执行（否则 navigate 参数相同不触发任何效果）。
      explicitChapterJumpRef.current = true;
      console.info(`[PERF][jump] goToChapter -> ${cid}`);
      navigation?.navigate('Reader', {
        bookId,
        chapterId: cid,
        segmentId: undefined,
        jumpSeq: Date.now(),
      });
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

  /** 仿真翻页：当前页首个真实段落写回阅读位置，便于续读。
   *  【2A】翻页模式换页进度落库：setSegment 只更新内存 segmentId，不写 lastRead，
   *  翻了几页后退出阅读进度仍停在打开时的段落；recordProgress 同步
   *  lastRead.segmentId（store 侧幂等，同段重复上报不产生写入）。
   *  滚动模式的对应写入见 onViewableItemsChanged 的防抖 recordProgress。 */
  const handlePageActiveSegment = useCallback((segId: string | null) => {
    if (segId) {
      useReaderStore.getState().setSegment(segId);
      useReaderStore.getState().recordProgress(segId);
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
    // 【4】模式切换后滚动列表重挂载，与切章同款：重置手势窗口与方向基准，
    // 防止挂载后的 onContentSizeChange 兜底把视口推到上一章再拉回（跳动）
    userScrollActiveRef.current = false;
    dragActiveRef.current = false;
    deferredPrependIntentRef.current = false;
    chapterHeadDwellRef.current = null;
    lastScrollOffsetRef.current = 0;
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

  /**
   * 章节（重新）加载时重置拼接序列：以当前章为起点，向后追加、向前拼接。
   * 仿真翻页模式同样维护该序列（仅含当前章），用于「段落 -> 所属章」反查。
   * 依赖口径（勿改回 chapter 引用）：仅「章节 id 变化 / 空壳→正文就位过渡 /
   * 显式跳章（jumpSeq）」才重置序列——后台填充每批合并会替换章对象引用，
   * 若按引用触发会把用户正在读的列表整体重置（滚动位置清零、拼接章节丢失）。
   * 「空壳→就位」过渡必须重置：首开（首章优先水合）与跳入未填充章时，
   * 序列种子是 segments 为空的壳章，正文就位后必须以新章体重种才能渲染。
   */
  const chapterReady = !!chapter && chapter.segments.length > 0;
  const chapterRef = useRef<Chapter | null>(chapter);
  chapterRef.current = chapter;
  /** 定位目标行超出初始渲染窗口时的 scrollToIndex 拉窗（实现在 scrollInitialRows 之后） */
  const locatePendingRowRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const ch = chapterRef.current;
    const seeded: Chapter[] = ch ? [ch] : [];
    continuousRef.current = seeded;
    continuousChapterIdsRef.current = new Set(seeded.map((c) => c.id));
    loadingNext.current = false;
    loadingPrev.current = false;
    prependAnchor.current = null;
    scrollOffset.current = 0;
    lastScrollOffsetRef.current = 0;
    // 【5】清空延迟拼接意图：旧手势周期的意图不得消费到新章的列表上
    deferredPrependIntentRef.current = false;
    rowOffsets.current.clear();
    // 【4】切章残留清零：旧列表的丢头补偿若跨章遗留，会在新章首次
    // onContentSizeChange 时被消费，把视口拉到错误位置（跳错章节）；
    // 旧章的注音视口锚点行在新列表中不存在，残留只会等到超时。
    headDropCompensation.current = 0;
    layoutAnchor.current = null;
    setContinuousChapters(seeded);
    // 记录种子章（见 continuousSeedChapterId / effectiveChapters 注释）
    setContinuousSeedChapterId(ch?.id ?? null);
    // 数据（重）就位后检查定位目标是否超初始窗口：超窗则拉渲染窗口过去
    locatePendingRowRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, chapterReady, jumpSeq, rowOffsets]);

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
   * 滑动窗口丢头检查：序列超出 MAX_CONTINUOUS_CHAPTERS 时丢弃头部最旧章节腾位。
   * 触发时机：①appendNextChapter 成功后（用户向前进、序列将超限）；
   * ②当前章前移时（onViewableItemsChanged，补丢此前因「当前章在头部」被推迟的丢弃）。
   * 安全规则（宁晚勿扰）：
   * - 丢弃方案由 planHeadDrop 判定——只丢严格位于当前章之前的头部章节，
   *   用户正在回看头部时本轮不丢；末章 / 单章 / 恰好等于上限时不丢、不死循环；
   * - 丢头会使保留内容整体上移，需按 rowOffsets 精确补偿：丢弃高度 =
   *   保留序列首行旧偏移 - 被丢首行旧偏移（两行之间的全部行恰为被丢内容）。
   *   任一偏移未知（行从未布局，如刚被回收）则本轮放弃丢弃、等下次触发再试；
   * - 挂起的向前拼接锚点一并安全放弃（appendNextChapter 已与锚点互斥，此处
   *   双保险）：放弃补偿意味着视野可能跳到保留序列开头，属可接受降级，
   *   绝不能残留锚点阻塞后续拼接。
   */
  const maybeDropHeadChapters = useCallback(() => {
    if (readerMode !== 'scroll') {
      return;
    }
    const loaded = continuousRef.current;
    if (loaded.length <= MAX_CONTINUOUS_CHAPTERS) {
      return;
    }
    const plan = planHeadDrop(
      loaded.map((c) => c.id),
      activeChapterIdRef.current,
      MAX_CONTINUOUS_CHAPTERS,
    );
    if (plan.droppedChapterIds.length === 0) {
      return;
    }
    const keptY = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${plan.keptChapterIds[0]}`);
    const droppedY = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${plan.droppedChapterIds[0]}`);
    if (typeof keptY !== 'number' || typeof droppedY !== 'number' || keptY <= droppedY) {
      // 偏移不可靠（被丢行从未布局 / 数据异常）：推迟本轮丢弃，等下次触发再试
      return;
    }
    // 挂起的向前拼接锚点安全放弃（双保险）：绝不残留锚点阻塞后续拼接
    prependAnchor.current = null;
    // 清理被丢章节的行偏移（标题行 + 段落行），避免 rowOffsets 无限膨胀
    const droppedIds = new Set(plan.droppedChapterIds);
    for (const ch of loaded) {
      if (droppedIds.has(ch.id)) {
        rowOffsets.current.delete(`${TITLE_ROW_PREFIX}${ch.id}`);
        for (const seg of ch.segments) {
          rowOffsets.current.delete(seg.id);
        }
      }
    }
    if (!MVCP_ENABLED) {
      // 手写补偿路径（回退用）：MVCP 开启时原生层在头部行移除后自动保持
      // 视口稳定，再回退 offset 会双重补偿（视口上甩一个丢弃高度）。
      headDropCompensation.current = keptY - droppedY;
    }
    const merged = loaded.filter((c) => !droppedIds.has(c.id));
    continuousRef.current = merged;
    continuousChapterIdsRef.current = new Set(merged.map((c) => c.id));
    setContinuousChapters(merged);
  }, [readerMode]);

  // 把最新实现交给 ref（供一次性创建的 onViewableItemsChanged 回调调用）
  useEffect(() => {
    maybeDropHeadRef.current = maybeDropHeadChapters;
  }, [maybeDropHeadChapters]);

  /**
   * 追加下一章到连续滚动序列。
   * 守卫：①仅滚动模式 ②无并发加载 ③无进行中的向前拼接补偿 ④存在下一章（不越过末章）
   * ⑤未重复追加 ⑥滑动窗口守卫——序列已达上限且「追加后无法丢头腾位」（当前章位于
   * 头部区域，用户正在回看）时停止追加，防止用户停在头部时级联追加无限吃内存；
   * 其余情况超限不再停止拼接，成功后由 maybeDropHeadChapters 丢头腾位。
   */
  const appendNextChapter = useCallback(() => {
    // 正在做「向前拼接」的偏移补偿时不要追加：两者的 contentSize 变化会互相干扰
    if (readerMode !== 'scroll' || loadingNext.current || prependAnchor.current || !book) {
      return;
    }
    const loaded = continuousRef.current;
    if (loaded.length === 0) {
      return;
    }
    // 滑动窗口守卫：追加后超出上限时，仅当当前章位于将被丢弃的头部区间之外
    // （丢头可行）才允许追加；当前章未知（-1）时保守停止
    const activeIdx = activeChapterIdRef.current
      ? loaded.findIndex((c) => c.id === activeChapterIdRef.current)
      : -1;
    const excessAfterAppend = loaded.length + 1 - MAX_CONTINUOUS_CHAPTERS;
    if (loaded.length >= MAX_CONTINUOUS_CHAPTERS && excessAfterAppend > 0 && activeIdx < excessAfterAppend) {
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
    continuousChapterIdsRef.current = new Set(merged.map((c) => c.id));
    lastAppendAtRef.current = Date.now();
    setContinuousChapters(merged);
    // 滑动窗口：追加成功后若序列超限，立即丢头腾位（当前章守卫已保证可行）
    maybeDropHeadChapters();
  }, [book, readerMode, maybeDropHeadChapters]);

  /** 滚至接近末尾：追加下一章（FlatList onEndReached 回调） */
  const handleEndReached = useCallback(() => {
    appendNextChapter();
  }, [appendNextChapter]);

  /**
   * 内容不足预载窗口时追加下一章（BugFix：短章经典滚动模式停在第一章、无法滚动）。
   * 根因：《道德经》等内置经典每章仅一段几十字，打开章的内容不足一屏 → FlatList
   * 没有可滚动区间，物理上产生不了 onScroll；而 RN 的 onEndReached 在内容不满
   * 一屏时不触发（Android 长期已知问题）、追加后仍不满一屏时也不重触发——
   * 「追加下一章」的两个既有触发点全部依赖「先能滚动」，列表永远停在第一章。
   * 向前拼接早有 onContentSizeChange 顶部兜底（顶部同样滚不动），本函数补齐
   * 对称的「向后追加」兜底：由 onContentSizeChange 与 FlatList onLayout 两个
   * 不依赖滚动事件的时机调用，口径与 handleScroll 统一走 isWithinPreloadWindow。
   * 追加引发 contentSize 变化 → 再次触发 → 级联补齐，收敛于窗口填满或没有
   * 下一章（去重 / 上限 / 锚点互斥守卫都在 appendNextChapter 内）。
   */
  const fillShortContentIfNeeded = useCallback(() => {
    if (readerMode !== 'scroll') {
      return;
    }
    if (
      isWithinPreloadWindow(
        contentH.current,
        viewH.current,
        scrollOffset.current,
        CONTIGUOUS_PRELOAD_SCREENS,
      )
    ) {
      appendNextChapter();
    }
  }, [readerMode, appendNextChapter]);

  /**
   * 在连续滚动序列【头部】插入上一章。
   * 五重守卫：①仅滚动模式 ②无并发加载 ③无尚未完成的偏移补偿 ④未达拼接上限
   * ⑤存在上一章（不越过首章）且未重复插入。
   * 【5】补偿单一源：本函数只负责「插入 + 登记 prependAnchor（含插入前
   * offset / rowOffsets 快照）」，实际补偿 scrollTo 只发生在两处锚点消费点
   * （handleRowLayout 的锚点行布局路径 / onContentSizeChange 的增量兜底路径），
   * 二者均由 prependAnchor 守卫且消费后立即置空——一次 prepend 至多执行一处
   * 补偿，触发点不重复补偿。触发时机统一经 requestAutoPrepend：手势进行中
   * 只记延迟意图，手势完全结束后才执行本函数（补偿不与原生滚动争夺视口）。
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
    // 空壳章守卫：内置书后台填充按书序进行，跳章后「上一章」可能尚未填充。
    // 插入空壳会先渲染空白（标题行高度≈0 内容），后台填到该章时整体暴涨
    // （大幅跳动）。拒插 + 按需优先填充（meta 切片毫秒级），填充完成由
    // 进度订阅重试拼接（用户仍在顶部附近时）。
    if (prevChapter.segments.length === 0) {
      void UserBookService.fillBuiltinChapterNow(book.id, prev.id);
      pendingPrevPrependRef.current = { chapterId: prev.id, requestedAt: Date.now() };
      return;
    }
    // 「打开时定位到指定段落」尚未完成时不要插入：两者都会调 scrollToOffset，
    // 会互相覆盖。等定位落位后由滚动事件按需触发（滚到顶部才需要上一章）。
    if (pendingScroll.current.target && !pendingScroll.current.done) {
      return;
    }
    if (!MVCP_ENABLED) {
      // 手写补偿路径（MVCP_ENABLED=false 的回退路径）：登记锚点，由
      // handleRowLayout 的锚点行布局路径 / onContentSizeChange 的增量兜底
      // 消费。MVCP 开启时原生层在头部插入行后自动保持视口稳定，再执行
      // 手写 scrollTo 会双重补偿（视口被前甩一个插入高度）。
      prependAnchor.current = {
        firstRowId: `${TITLE_ROW_PREFIX}${firstId}`,
        baseOffset: scrollOffset.current,
        createdAt: Date.now(),
        snapshot: new Map(rowOffsets.current),
      };
    }
    // 顶端插入补偿（scrollToIndex 法，r28）：offset≈0（章首回弹「读上一章」）
    // 时 MVCP 补偿不可靠（r23 已踩坑），而测量式锚点在窗口化下也会失效——
    // 插入后旧行（原章标题）落在渲染窗口外，onLayout 永不触发、锚点消费不到
    //（prepend 重挂新表头行的 JS 阻塞还会打穿锚点超时，真机 r27 实测仍跳）。
    // 改为按「插入章行数 K」直接把旧首行（原章标题）对齐到视口顶：
    // offset≈0 时「保持视口」⟺「原章标题仍在顶部」，无需测量插入高度。
    // scrollToIndex 的估算落点偏差由标题行挂载后的 onLayout 一次性修正
    // （topAlignRef，见 handleRowLayout）。
    if (scrollOffset.current <= 0) {
      const insertedRows = prevChapter.segments.length + 1;
      topAlignRef.current = {
        rowId: `${TITLE_ROW_PREFIX}${firstId}`,
        createdAt: Date.now(),
        done: false,
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          listRef.current?.scrollToIndex({
            index: insertedRows,
            viewPosition: 0,
            animated: false,
          });
        });
      });
    }
    const merged = [prevChapter, ...continuousRef.current];
    continuousRef.current = merged;
    continuousChapterIdsRef.current = new Set(merged.map((c) => c.id));
    setContinuousChapters(merged);
    pendingPrevPrependRef.current = null;
  }, [book, readerMode, pendingScroll, rowOffsets, expireAnchorIfNeeded]);
  // 填充进度订阅经 ref 调用最新实现（订阅 effect 注册早于本 useCallback）
  prependPrevRef.current = prependPreviousChapter;

  /**
   * 【5】自动向前拼接的统一执行入口（全部触发点共用，触发点只负责判定）：
   * 条件满足但手势仍在进行（手指按住拖拽 / 惯性滚动中）时不立即执行——此时
   * prepend 的补偿 scrollTo 会与原生拖拽/惯性互相争夺视口，落点失准跳章——
   * 置位延迟意图，待手势完全结束后由 consumeDeferredPrepend 消费；
   * 手势已结束（如程序化时机恰逢窗口外）则直接执行。
   */
  const requestAutoPrepend = useCallback(
    (offset: number): void => {
      if (!shouldAutoPrepend(offset)) {
        return;
      }
      if (dragActiveRef.current || userScrollActiveRef.current) {
        deferredPrependIntentRef.current = true;
        return;
      }
      prependPreviousChapter();
    },
    [shouldAutoPrepend, prependPreviousChapter],
  );

  /**
   * 【5】消费延迟拼接意图（手势完全结束后的两个统一出口调用：
   * onMomentumScrollEnd / endDrag 后的关窗计时器）。
   * 消费时刻原生滚动必然已停止（惯性结束或无惯性的关窗兜底），此刻执行
   * prepend + 补偿 scrollTo 不再有争夺；补偿基准 = 解析时刻实测的
   * 「原首章标题行新 y（= 插入内容总高）+ 补偿前实际 offset」，不依赖
   * 切章过渡态的 anchor / contentSize。
   * 重新校验位置与方向：意图置位到消费之间用户可能已改变意图（如拖拽反向
   * 甩出预载窗口），出窗或方向背离顶部则丢弃意图不做拼接。
   */
  const consumeDeferredPrepend = useCallback((): void => {
    if (!deferredPrependIntentRef.current) {
      return;
    }
    deferredPrependIntentRef.current = false;
    if (readerMode !== 'scroll') {
      return;
    }
    const offset = scrollOffset.current;
    if (offset > viewH.current * CONTIGUOUS_PRELOAD_SCREENS) {
      return;
    }
    // 方向校验：惯性收尾帧仍在朝顶部移动，或已压顶/回弹到顶（offset ≤ 0）
    if (!(offset <= 0 || offset < lastScrollOffsetRef.current)) {
      return;
    }
    prependPreviousChapter();
  }, [readerMode, prependPreviousChapter]);

  /** 滚至接近顶部：向前拼接上一章（FlatList onStartReached 回调）。
   *  RN 0.74 尚未实现 onStartReached（0.75+ 才加入），本回调当前为前向兼容
   *  空转路径；一旦升级生效也必须走统一判定（手势窗口 + 方向 + 驻留期）与
   *  统一执行入口（手势进行中只记延迟意图），防止无害化失效后回归
   *  「非用户意图触发拼接 → 跳动/闪现上一章」。 */
  const handleStartReached = useCallback(() => {
    if (shouldAutoPrepend(scrollOffset.current)) {
      requestAutoPrepend(scrollOffset.current);
    }
  }, [shouldAutoPrepend, requestAutoPrepend]);

  /** 已完成邻章预取的「模式:章 id」键：跳章 / 切章后只触发一轮预取（防抖），同键重复触发跳过 */
  const prefetchedKeyRef = useRef<string | null>(null);
  /** 邻章预取的挂起计时器（切章 / 卸载时清理，防止旧章的预取落到新章序列上） */
  const prefetchNeighborsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 【问题4】滚动模式邻章预取：跳章落位 / 切章稳定后，主动把后一章与前一章
   * 拼进 continuousChapters，使用户随后立即向下 / 向上滚动时无需等待拼接。
   * 复用既有追加函数（防重入口不另起炉灶）：loadingNext / loadingPrev 并发守卫、
   * 二次去重、滑动窗口上限、锚点互斥全部在同一入口内生效。
 * 顺序约束：先 append 后 prepend——prepend 会登记 prependAnchor，锚点存活期
 * 内 append 被互斥守卫阻塞，顺序颠倒会导致本轮只预取到上一章。
 * 【BugFix】prepend 为条件执行（视口滚出半屏且非章首驻留期）：跳章落位在
 * offset=0 时 Android MVCP 对头部插入的补偿不可靠，会把视口回推上一章
 * （「跳章后自动前滚一章」根因）；章首向上拼接由滚动路径按需兜底。
   * 静默性：两个追加函数本身不展示 loading；NEIGHBOR_PREFETCH_DELAY_MS 宏任务
   * 延时让出线程，不与切章过渡渲染争抢 JS。
   * 一轮语义（防抖）：按「模式:章 id」记账，每章只预取一轮；若计时器触发时
   * 用户已开始手势滚动（绝不与原生拖拽 / 惯性争夺视口，跳章根因之一），或
   * prepend 因 pendingScroll（打开时定位未完成）被守卫拒绝，则放弃本轮、
   * 交由既有滚动触发路径（requestAutoPrepend / handleEndReached）按需兜底，
   * 不做重试。
   */
  const prefetchNeighborChapters = useCallback(() => {
    if (readerMode !== 'scroll' || !book || !chapterId) {
      return;
    }
    const prefetchKey = `scroll:${chapterId}`;
    if (prefetchedKeyRef.current === prefetchKey) {
      return;
    }
    prefetchedKeyRef.current = prefetchKey;
    if (prefetchNeighborsTimer.current) {
      clearTimeout(prefetchNeighborsTimer.current);
    }
      prefetchNeighborsTimer.current = setTimeout(() => {
      prefetchNeighborsTimer.current = null;
      /** 无进展时有限次重试（见 attempt 尾部校验） */
      const MAX_TRIES = 4;
      const RETRY_MS = 1500;
      const attempt = (tries: number): void => {
        // 用户正在滚动：插入 + 补偿 scrollTo 不得与进行中的原生拖拽 / 惯性
        // 争夺视口（跳章根因，见 requestAutoPrepend 注释）——稍后重试。
        // （原实现直接放弃整轮且不再补：用户开局即滚动时预取静默失效，
        // 之后再拉到顶才现拼——「向上滚动预加载不生效」的根因。）
        if (dragActiveRef.current || userScrollActiveRef.current) {
          if (tries < MAX_TRIES) {
            prefetchNeighborsTimer.current = setTimeout(
              () => attempt(tries + 1),
              RETRY_MS,
            );
          }
          return;
        }
        const beforeFirstId = continuousRef.current[0]?.id ?? null;
        const beforeLen = continuousRef.current.length;
        appendNextChapter();
        // 【BugFix：跳章后自动前滚一章】视口在列表顶部（offset 未滚出半屏）时
        // 跳过预取 prepend：① Android MVCP 对 offset=0 的头部插入补偿不可靠
        // （真机实测：跳章落位 ~7s 后视口被回推到上一章，底部进度从 24 章 8%
        // 变 23 章 8%）；② 用户刚落到章首没有向上阅读意图——真正向上滚时
        // requestAutoPrepend 滚动路径即时拼接（offset>0 时 MVCP 补偿正常），
        // 预取收益为零、风险全在。驻留期（chapterHeadDwellRef）内同样跳过。
        if (!chapterHeadDwellRef.current && scrollOffset.current > viewH.current * 0.5) {
          prependPreviousChapter();
        }
        // 重试条件 = 本轮【零进展】（拼接被 pendingScroll / 锚点占用等暂时挡住）。
        // 勿改成「上一章未就位就重试」：每次成功 prepend 一章后，新首章的
        // 上一章天然未加载（预取语义只拼一章），该条件恒真 → 空转重试，
        // 每轮 append+prepend 各一章，再叠加上锚点补偿与 append 同帧合并
        // 引发的过度前甩（见 onContentSizeChange 锚点兜底），表现为
        // 「跳章后页面不停滚动多章 / 下拉一次翻动好几章」。
        const after = continuousRef.current;
        const progressed =
          after.length > beforeLen || (after[0]?.id ?? null) !== beforeFirstId;
        if (!progressed && tries < MAX_TRIES) {
          prefetchNeighborsTimer.current = setTimeout(
            () => attempt(tries + 1),
            RETRY_MS,
          );
        }
      };
      attempt(0);
    }, NEIGHBOR_PREFETCH_DELAY_MS);
  }, [readerMode, book, chapterId, appendNextChapter, prependPreviousChapter]);

  // 章稳定（打开 / 跳章落位 / 切章重置完成）后触发一轮邻章预取；
  // 依赖变化（切章 / 换模式）时先清掉上一章挂起的计时器再重新调度
  useEffect(() => {
    prefetchNeighborChapters();
    return () => {
      if (prefetchNeighborsTimer.current) {
        clearTimeout(prefetchNeighborsTimer.current);
        prefetchNeighborsTimer.current = null;
      }
    };
  }, [prefetchNeighborChapters]);

  /** 连续滚动行：每章 = 1 个章标题行 + N 个段落行 */
  const continuousRows = useMemo<ReaderRow[]>(() => {
    const rows: ReaderRow[] = [];
    // 用 effectiveChapters（当帧一致视图）而非 continuousChapters 状态：
    // 切章过渡帧不闪现旧章内容（见 effectiveChapters 注释）
    for (const ch of effectiveChapters) {
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
  }, [effectiveChapters, toDisplayText, toDisplaySegment]);

  /**
   * 滚动模式初始渲染行数（BugFix：导入书在滚动模式下无法即时滚动）。
   * 旧实现固定 initialNumToRender=30（按行数）：导入书单段可达 MAX_SEGMENT_CHARS
   * =2500 字，且默认全文注音（PinyinText 逐字渲染，每字一个字格），30 行首帧最多
   * 同步挂载 7.5 万字格，JS 线程被压死 → 打开导入书后长时间无法滚动。
   * 现按「打开章的内容量（码点数）」预算计算：内置书短段落仍渲染 30 行（行为不变），
   * 导入书大段落只渲染预算内行数，其余交给 FlatList 窗口化随滚动增量渲染。
   * 依赖仅 chapter：切章时列表重置、该值随之重算；拼接增删章不影响打开章，
   * 避免中途改变 initialNumToRender 扰动 VirtualizedList 的渲染窗口。
   * 深段落定位超出初始窗口时由 LOCATE_TIMEOUT_MS 超时兜底（既定可接受降级）。
   */
  const scrollInitialRows = useMemo(() => {
    const counts = chapter
      ? [0, ...chapter.segments.map((s) => Array.from(s.text).length)]
      : [];
    return computeScrollInitialRows(counts);
  }, [chapter]);

  /**
   * 【BugFix：续读深段落定位失败落章首】初始渲染窗口按字符预算收缩后（v2），
   * 续读/跳章的定位目标段可能超出初始窗口——FlatList 窗口化下窗口外行不挂载、
   * onLayout 永不触发，LOCATE_TIMEOUT_MS 超时后视口停在章首（真机实测：
   * 庄子·在宥恢复 s8 失败；旧版行长阈值早退使内置书整章渲染故无此问题）。
   * 目标行在窗口外时 scrollToIndex 把渲染窗口拉过去（行高不均导致的估算偏差
   * 由 onScrollToIndexFailed 的平均行高近似修正），目标行进入窗口挂载后由
   * handleRowLayout 的 pendingScroll 路径按 cell 级真实 y 精调（y-24），
   * 超时兜底不变。
   */
  locatePendingRowRef.current = () => {
    const pending = pendingScroll.current;
    if (pending.done || !pending.target) {
      return;
    }
    const ch = chapterRef.current;
    if (!ch || ch.segments.length === 0) {
      return;
    }
    const segIdx = ch.segments.findIndex((s) => s.id === pending.target);
    const rowIndex = segIdx >= 0 ? segIdx + 1 : -1; // +1 标题行
    if (rowIndex < 0 || rowIndex < scrollInitialRows) {
      return; // 窗口内：等 onLayout 精调即可
    }
    console.info(
      `[PERF][jump] locate target row=${rowIndex} beyond initialRows=${scrollInitialRows}, scrollToIndex`,
    );
    // 时序：本调用可能发生在 setContinuousChapters 的同一轮 effect 内，
    // FlatList 的 data 还是旧值——同步 scrollToIndex 会按旧 data 判越界
    // （onScrollToIndexFailed 按旧测量估算，滚不到目标）。等新 data 提交
    // 再滚（双 rAF：一帧 commit + 一帧布局）。落位后目标行挂载，仍由
    // handleRowLayout 的 pendingScroll 路径按 cell 级真实 y 精调（y-24）；
    // 测量异常（脏 y≤0）由该路径的防护跳过，不会拽回章首。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0 });
      });
    });
  };

  /**
   * 段内精确续读（比例精修）：段级定位完成后启动。
   * 【即时优先】先同步尝试一次精修——pending hit 同一批布局里目标段的下一行
   * 通常已完成 cell 级测量（rowOffsets 已有真实 y），当场即可算出
   * 「段顶 − 24 + ratio × 段高」一次落位，与段级定位合并为一次可见滚动，
   * 消除旧版「先落段首、~300-600ms 后再跳到精确位置」的二次延迟。
   * 同帧拿不到下一行（远跳跃窗口刚拉过来、下方行未布局）时退回轮询兜底：
   * 150ms 间隔探测，超 20 tick（~3s）放弃。放弃条件还有：用户已手动滚动
   * （偏离锚点 > 120px，锚定后的首个即时尝试宽免）/ 恢复态被清（切章）。
   * 定位是程序化滚动，用户在打开后立即抢滚的场景极少；宁可少滚不可抢滚。
   */
  startRatioRefinePollRef.current = (segmentId: string) => {
    const refine = ratioRefineRef.current;
    if (!refine || refine.segmentId !== segmentId || ratioRefineTimerRef.current) {
      return;
    }

    /** 单次精修尝试；strict=只认真实测量的下一行 y（不退化为内容高度估算） */
    const attemptRefine = (tick: number, strict: boolean): boolean => {
      const cur = ratioRefineRef.current;
      if (!cur || cur.segmentId !== segmentId) {
        return true; // 恢复态被清：视为已结束
      }
      if (tick > 1 && Math.abs(scrollOffset.current - cur.anchorOffset) > 120) {
        // 用户已手动滚动：放弃精修，绝不与手势争夺视口
        ratioRefineRef.current = null;
        return true;
      }
      const ch = chapterRef.current;
      if (!ch || ch.segments.length === 0) {
        return false;
      }
      const segY = rowOffsets.current.get(segmentId);
      if (typeof segY !== 'number' || segY <= 0) {
        return false; // 目标行未挂载/未完成 cell 级测量
      }
      const segIdx = ch.segments.findIndex((s) => s.id === segmentId);
      const nextSegId = segIdx >= 0 ? ch.segments[segIdx + 1]?.id : undefined;
      const chIdx = continuousRef.current.findIndex((c) => c.id === ch.id);
      const nextChapterId = continuousRef.current[chIdx + 1]?.id;
      const nextMeasuredY =
        (nextSegId ? rowOffsets.current.get(nextSegId) : undefined) ??
        (nextChapterId
          ? rowOffsets.current.get(`${TITLE_ROW_PREFIX}${nextChapterId}`)
          : undefined);
      const nextY = nextMeasuredY ?? (strict ? undefined : contentH.current);
      if (typeof nextY !== 'number') {
        return false; // 下一行未布局且不允许估算
      }
      const segH = nextY - segY;
      if (segH <= 1) {
        return false; // 段高未收敛
      }
      const maxOffset = Math.max(0, contentH.current - viewH.current);
      const target = Math.min(maxOffset, Math.max(0, segY - 24 + cur.ratio * segH));
      ratioRefineRef.current = null;
      // 同步补偿基准：onScroll 到达顺序不保证（同 pending hit 路径）
      scrollOffset.current = target;
      listRef.current?.scrollToOffset({ offset: target, animated: false });
      console.info(
        `[PERF][locate] ratio refine seg=${segmentId} ratio=${cur.ratio.toFixed(3)} -> offset=${Math.round(target)} (tick=${tick})`,
      );
      return true;
    };

    // 即时首试（strict）：与 pending hit 同帧，通常已具备全部测量
    if (attemptRefine(0, true)) {
      return;
    }
    // 轮询兜底：前 4 tick 仍 strict（同帧未就绪多为远跳跃场景，宁缺毋滥），
    // 之后允许内容高度估算兜底（有比例数据总比停在段首好）
    let ticks = 0;
    ratioRefineTimerRef.current = setInterval(() => {
      ticks += 1;
      const timer = ratioRefineTimerRef.current;
      if (!timer || ticks > 20 || attemptRefine(ticks, ticks <= 4)) {
        if (timer) {
          clearInterval(timer);
        }
        ratioRefineTimerRef.current = null;
      }
    }, 150);
  };

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

  /** 朗读当前段（用指定语速）：取阅读位置 store 中的当前段（无则回章首段） */
  const startSpeech = useCallback(
    async (rate: number) => {
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
      const res = await TtsService.speakText(text, rate);
      if (res.success) {
        setTtsSpeaking(true);
      } else {
        Alert.alert('朗读', res.error ?? '朗读启动失败');
      }
    },
    [chapter, speechTextMap],
  );

  /**
   * 「听」按钮点击：
   * - 朗读中 → 直接停止（保留原 toggle 停止分支，不弹窗）
   * - 未朗读 → 先弹语速设置弹窗，确认后才播放
   */
  const handleListenPress = useCallback(() => {
    if (ttsSpeaking) {
      TtsService.stopSpeech();
      setTtsSpeaking(false);
      return;
    }
    setTempSpeechRate(speechRate);
    setRateModalVisible(true);
  }, [ttsSpeaking, speechRate]);

  /** 语速弹窗内临时值步进（−/+ 0.25，边界由 rangeButton disabled 控制） */
  const handleStepTempSpeechRate = useCallback((dir: 1 | -1) => {
    setTempSpeechRate((prev) => stepSpeechRate(prev, dir));
  }, []);

  /** 语速弹窗「确认开始播放」：临时值写回持久化设置，并以确认后的语速开播 */
  const handleConfirmSpeechRate = useCallback(async () => {
    setRateModalVisible(false);
    setSpeechRate(tempSpeechRate);
    await startSpeech(tempSpeechRate);
  }, [tempSpeechRate, setSpeechRate, startSpeech]);

  /** 语速弹窗「取消」：仅关闭，不写回持久化设置（临时值丢弃） */
  const handleCancelSpeechRate = useCallback(() => {
    setRateModalVisible(false);
  }, []);

  // ---------- 定位滚动到指定段落 ----------

  /**
   * 行布局上报：记录该行在内容内的纵向偏移。
   * 三个用途：①打开时一次性定位到目标段落；②计算「当前章内」滚动进度；
   * ③向前拼接的偏移补偿——原首章标题行重新布局后的 y 恰为插入内容总高。
   */
  const handleRowLayout = useCallback(
    (rowId: string, y: number) => {
      rowOffsets.current.set(rowId, y);
      // 顶端插入补偿修正：scrollToIndex 估算落位后，旧首章标题行挂载上报
      // 真实 y——对齐到该 y（标题行贴视口顶）即完成「保持视口」的精确补偿。
      // 超时/已消费/用户已大幅滚动（估算落点附近用户主动移动）则放弃。
      const topAlign = topAlignRef.current;
      if (topAlign && !topAlign.done && rowId === topAlign.rowId) {
        topAlign.done = true;
        topAlignRef.current = null;
        if (
          y > 0 &&
          Date.now() - topAlign.createdAt < 5000 &&
          Math.abs(scrollOffset.current - y) > 2
        ) {
          const estimated = scrollOffset.current;
          scrollOffset.current = y;
          listRef.current?.scrollToOffset({ offset: y, animated: false });
          console.info(
            `[PERF][locate] top align row=${rowId} est=${Math.round(estimated)}->y=${Math.round(y)}`,
          );
        }
      }
      // 注音切换视口锚点：目标行重排后按「新 y + 视口顶入深度」一次性落位。
      // 超时（LOCATE_TIMEOUT_MS）未等到重排则放弃，避免陈旧锚点在后续布局中
      // 突然生效把用户拽走。
      const viewportAnchor = layoutAnchor.current;
      if (viewportAnchor != null && rowId === viewportAnchor.rowId) {
        const expired = Date.now() - viewportAnchor.createdAt > LOCATE_TIMEOUT_MS;
        layoutAnchor.current = null;
        if (!expired) {
          const target = Math.max(0, y + viewportAnchor.delta);
          listRef.current?.scrollToOffset({ offset: target, animated: false });
          // 同步补偿基准：onScroll 事件与本次 scrollTo 的到达顺序不保证，
          // 主动写回保证后续锚点/进度计算用到的是落位后的偏移
          scrollOffset.current = target;
        }
      }
      const pending = pendingScroll.current;
      if (!pending.done && pending.target === rowId) {
        pending.done = true;
        if (y <= 0) {
          // 脏 y 防护：cell 级 y 应恒为内容绝对值（>0，目标行前至少有标题行）。
          // 若仍收到 0/负值（测量基准异常），放弃修正并标记完成——宁可停在
          // scrollToIndex 的估算落位，也不能按 y-24=0 把视口拽回章首（r24 踩坑）。
          console.info(
            `[PERF][locate] pending hit row=${rowId} dirty y=${Math.round(y)}, skip refine`,
          );
        } else {
          const targetOffset = Math.max(0, y - 24);
          console.info(
            `[PERF][locate] pending hit row=${rowId} y=${Math.round(y)} -> offset=${Math.round(targetOffset)}`,
          );
          listRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
          // 定位落点贴近顶部时主动触发一次向前拼接：续读打开在章首附近的场景下，
          // onContentSizeChange 的首次兜底可能被 pendingScroll 未完成的守卫挡掉，
          // 而停在 offset≈0 处不会再产生滚动事件，用户必须「来回滚动」才能触发。
          // 【4】统一走 shouldAutoPrepend：定位落位属程序化滚动（非手势窗口），
          // 正常情况下不会触发；仅当用户恰在此刻手势滚动且朝顶部时才拼接。
          // 【5】经 requestAutoPrepend 统一执行：手势进行中只记意图，待手势
          // 完全结束后再插入 + 补偿，避免与拖拽/惯性争夺视口。
          if (shouldAutoPrepend(targetOffset)) {
            requestAutoPrepend(targetOffset);
          }
        }
        // 段级定位完成（无论是否精确修正）：进入比例精修探测
        const refine = ratioRefineRef.current;
        if (refine && refine.segmentId === rowId && refine.anchorOffset < 0) {
          refine.anchorOffset = scrollOffset.current;
        }
        startRatioRefinePollRef.current(rowId);
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
    [rowOffsets, requestAutoPrepend, shouldAutoPrepend],
  );

  /**
   * 滚动模式 cell 渲染器（BugFix：行高测量基准错误）。
   * 此前行内 onLayout（segment/标题组件内部根 View）的 y 是相对 cell 容器的
   * 恒 ≈0 值——rowOffsets 整个测量基准错误：pending 定位精调按 y-24=0 把视口
   * 拽回章首（续读恢复失败根因之一）、prepend 锚点 y>0 条件永不成立、注音
   * 视口锚点退化为 no-op（全靠 onContentSizeChange/兜底路径掩盖）。
   * cell 根 View 的父节点即滚动内容容器，其 onLayout y = 内容绝对 y。
   * 透传 onLayout 给 VirtualizedList 内部簿记（cellOffsets/填充率）不可省略。
   */
  const scrollCellRenderer = useCallback(
    (props: CellRendererProps<ReaderRow>) => {
      const { item, onLayout, style, children } = props;
      return (
        <View
          style={style}
          onLayout={(e) => {
            onLayout?.(e);
            handleRowLayout(item.id, e.nativeEvent.layout.y);
          }}
        >
          {children}
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleRowLayout],
  );

  /** 行内布局上报 no-op：滚动模式行高测量已由 scrollCellRenderer 在 cell 层接管，
   * 行内 View 的 y 相对 cell 容器恒 ≈0，上报会覆盖 cell 级真实值 */
  const noopRowLayout = useCallback(() => undefined, []);

  /**
   * 章内滚动比例（0~1）：以「章标题行」为起点、「下一章标题行」（未拼接/
   * 未挂载时用内容末尾）为终点，计算当前偏移在章内的相对位置。
   * 与 handleScroll 的底部进度条同一口径（段内精确续读的记录端）。
   * 依赖全为 ref（rowOffsets/contentH/viewH/scrollOffset/continuousRef），
   * 可安全地在防抖回调里读取最新值。
   */
  const computeChapterScrollRatio = useCallback((chapterId: string): number => {
    const contentHeight = contentH.current;
    if (contentHeight <= 0) {
      return 0;
    }
    let start = 0;
    let end = Math.max(0, contentHeight - CONTENT_BOTTOM_PADDING);
    const titleOffset = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${chapterId}`);
    if (typeof titleOffset === 'number' && titleOffset > 0) {
      start = titleOffset;
    }
    const idx = continuousRef.current.findIndex((c) => c.id === chapterId);
    const nextChapter = idx >= 0 ? continuousRef.current[idx + 1] : undefined;
    if (nextChapter) {
      const nextOffset = rowOffsets.current.get(`${TITLE_ROW_PREFIX}${nextChapter.id}`);
      if (typeof nextOffset === 'number' && nextOffset > start) {
        end = nextOffset;
      }
    }
    const denom = Math.max(1, end - start);
    return Math.min(1, Math.max(0, (scrollOffset.current - start) / denom));
  }, []);

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
      // 附带章内滚动比例（段内精确续读的记录端，与底部进度条同一口径）
      store.recordProgress(pending.segmentId, computeChapterScrollRatio(pending.chapterId));
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

  // 卸载时清理防抖计时器与比例精修轮询，避免离屏后误写进度/误滚动
  useEffect(() => {
    return () => {
      if (segmentRecordTimer.current) {
        clearTimeout(segmentRecordTimer.current);
        segmentRecordTimer.current = null;
      }
      if (ratioRefineTimerRef.current) {
        clearInterval(ratioRefineTimerRef.current);
        ratioRefineTimerRef.current = null;
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
      // 【4】防串扰（连续快速切章的跳错章节根因之一）：可见性回调异步派发，
      // 可能携带切章前旧拼接序列的行对象；不设防会把 store 的阅读位置
      // （openChapter/recordProgress）与 activeChapterId 写到错误章节。
      // 只认当前拼接序列内的章（continuousChapterIdsRef 与序列同步更新）。
      if (!continuousChapterIdsRef.current.has(row.chapterId)) {
        return;
      }
      const rowSegmentId = row.segment.id;
      if (row.chapterId !== activeChapterIdRef.current) {
        console.info(
          `[PERF][jump] visible chapter -> ${row.chapterId} (first visible seg=${rowSegmentId})`,
        );
        activeChapterIdRef.current = row.chapterId;
        setActiveChapterId(row.chapterId);
        // 用户向前进（当前章前移）：检查滑动窗口丢头。此前因「当前章位于头部
        // 区间」被推迟的丢弃，在当前章前移后的此刻补丢（经 ref 调最新实现）
        maybeDropHeadRef.current();
        const currentBookId = useReaderStore.getState().bookId;
        if (currentBookId) {
          // openChapter 会一并写入 segmentId，无需再单独 setSegment；
          // 比例传 0（跨章瞬间新章标题行可能尚未布局，测不到真实起点，
          // 后续章内防抖记录会以真实口径覆盖）
          useReaderStore
            .getState()
            .openChapter(currentBookId, row.chapterId, rowSegmentId, 0);
          return;
        }
      }
      scheduleSegmentRecord(rowSegmentId, row.chapterId);
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  /**
   * scrollToIndex 落在未测量区域时的估算修正（VirtualizedList onScrollToIndexFailed）：
   * 行高不均（注音段落行差异大）时 VirtualizedList 的偏移估算可能失败——按
   * 平均行高近似落位，把目标行附近拉进渲染窗口；目标行挂载后的精确落位由
   * handleRowLayout 的 pendingScroll 路径完成（scrollToIndex 不再重试，避免
   * 估算-失败-重试循环；最坏情况由 LOCATE_TIMEOUT_MS 超时兜底落章首）。
   */
  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const approx = Math.max(0, info.averageItemLength * info.index - 24);
      listRef.current?.scrollToOffset({ offset: approx, animated: false });
    },
    [listRef],
  );

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
      // 口径统一走 isWithinPreloadWindow，与 onContentSizeChange / onLayout
      // 的「短内容兜底追加」（fillShortContentIfNeeded）保持完全一致。
      if (isWithinPreloadWindow(contentHeight, viewHeight, offset, CONTIGUOUS_PRELOAD_SCREENS)) {
        appendNextChapter();
      }
      // 距顶部不足预载窗口时提前向前拼接上一章（同上）。
      // （顶部无法产生滚动事件，真正的首次触发由 onContentSizeChange 兜底）
      // 【4】统一判定（手势窗口 + 朝顶部方向）：向下阅读/程序化滚动永不触发，
      // 仅用户主动朝顶部拖拽/惯性时拼接（详见 shouldAutoPrepend）。
      // 【5】显式跳章后的章首驻留期：用户读出超过阈值屏高即解除拦截。
      const dwell = chapterHeadDwellRef.current;
      if (dwell) {
        if (
          (viewH.current > 0 && offset > viewH.current * CHAPTER_HEAD_DWELL_SCREENS) ||
          dwell.chapterId !== activeChapterIdRef.current
        ) {
          chapterHeadDwellRef.current = null;
        }
      }
      // 【5】经 requestAutoPrepend 统一执行：手势进行中只记延迟意图，
      // 待手势完全结束后再插入 + 补偿（单一补偿源，不与原生滚动争夺视口）。
      if (shouldAutoPrepend(offset)) {
        requestAutoPrepend(offset);
      }
      // 方向基准在本帧判定全部完成后更新（shouldAutoPrepend 需要上一帧值）
      lastScrollOffsetRef.current = offset;
    },
    [
      appendNextChapter,
      requestAutoPrepend,
      rowOffsets,
      expireAnchorIfNeeded,
      shouldAutoPrepend,
    ],
  );

  /**
   * 【4】用户开始拖拽：打开手势窗口（见 userScrollActiveRef）。
   * 拼接不再「首拖永开」，而是仅在本窗口内且方向朝顶部时触发。
   * 【5】同步标记手指按住（dragActiveRef）：拖拽进行中满足拼接条件时只记
   * 延迟意图，绝不立即执行 prepend + 补偿 scrollTo（与原生拖拽争夺视口）。
   */
  const handleScrollBeginDrag = useCallback(() => {
    userScrollActiveRef.current = true;
    dragActiveRef.current = true;
    if (scrollWindowCloseTimer.current) {
      clearTimeout(scrollWindowCloseTimer.current);
      scrollWindowCloseTimer.current = null;
    }
    expireAnchorIfNeeded();
  }, [expireAnchorIfNeeded]);

  /**
   * 【4】惯性结束：关闭手势窗口（拖拽结束后的无惯性场景由 endDrag 延时兜底）。
   * 【5】惯性结束 = 原生滚动完全停止，此刻消费延迟拼接意图是安全的：
   * prepend 的插入 + 补偿 scrollTo 不再与惯性滚动互相争夺。
   */
  const handleMomentumScrollEnd = useCallback(() => {
    userScrollActiveRef.current = false;
    dragActiveRef.current = false;
    if (scrollWindowCloseTimer.current) {
      clearTimeout(scrollWindowCloseTimer.current);
      scrollWindowCloseTimer.current = null;
    }
    consumeDeferredPrepend();
  }, [consumeDeferredPrepend]);

  /**
   * 拖拽结束时的顶部触发兜底：在 offset≈0 处向上回弹（Android 拉出 overscroll）
   * 时 contentOffset 不变化，onScroll 可能不产生有效事件，导致「停在顶部向上
   * 滑动」永远触发不了向前拼接。拖拽结束时刻补一次距顶判断。
   * 【5】本路径只记录延迟意图，不立即 prepend：endDrag ≠ 手势完全结束
   * （惯性可能随后进行），补偿 scrollTo 必须等 onMomentumScrollEnd 或关窗
   * 计时器确认滚动停止后再执行（端到端原子性：判定 → 意图 → 无滚动时补偿）。
   */
  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      // 先用「上一帧偏移」做方向判定再写回（顶部压住的回弹拖拽 offset 恒 0
      // 不产生方向差，靠 offset ≤ 0 分支放行——这是停在章首拉出上一章的入口）
      const allow = shouldAutoPrepend(offset);
      dragActiveRef.current = false;
      scrollOffset.current = offset;
      expireAnchorIfNeeded();
      if (allow) {
        // 【5】延迟到手势完全结束后消费（consumeDeferredPrepend）：
        // 补偿将 scrollTo 精确到「当前章首在新列表中的绝对 offset」
        // （插入高度 = 原首章标题行新 y = 新旧 contentSize 差）。
        deferredPrependIntentRef.current = true;
      }
      // 【4】无惯性收尾的手势也要关窗：有惯性时 onMomentumScrollEnd 先到，
      // 本计时器空转；无惯性（如顶部小幅拖拽）时延时 500ms 关窗，
      // 保证本次手势内的拼接判定完整走完
      if (scrollWindowCloseTimer.current) {
        clearTimeout(scrollWindowCloseTimer.current);
      }
      scrollWindowCloseTimer.current = setTimeout(() => {
        userScrollActiveRef.current = false;
        dragActiveRef.current = false;
        scrollWindowCloseTimer.current = null;
        consumeDeferredPrepend();
      }, SCROLL_WINDOW_CLOSE_MS);
    },
    [shouldAutoPrepend, consumeDeferredPrepend, expireAnchorIfNeeded],
  );

  // 切换章节时列表回到顶部（导航跳回 Reader 会复用当前组件实例，offset 需手动复位）
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setScrollFrac(0);
    rowOffsets.current.clear();
    // 【4】切章后重置手势窗口与方向基准：程序化滚动（复位到 0 / 定位落位）
    // 不处于手势窗口，不会触发自动向前拼接（跳动的另一处来源）
    userScrollActiveRef.current = false;
    lastScrollOffsetRef.current = 0;
    if (scrollWindowCloseTimer.current) {
      clearTimeout(scrollWindowCloseTimer.current);
      scrollWindowCloseTimer.current = null;
    }
    // 【4】目录显式跳章：落章首，不恢复该章上次阅读段落（见 explicitChapterJumpRef）
    const explicitJump = explicitChapterJumpRef.current;
    explicitChapterJumpRef.current = false;
    console.info(
      `[PERF][jump] switch effect chapterId=${chapterId ?? 'null'} explicit=${explicitJump} seg=${segmentId ?? 'null'}`,
    );
    // 【5】显式跳章进入「章首驻留期」：落章首后用户尚未读出超过阈值屏高之前，
    // 拦截 offset > 0 的手势自动拼接（只留 offset ≤ 0 的章首回弹 endDrag 路径）。
    // 跳章落点 offset = 0 时立即上滑会同时满足手势窗口 + 预载窗口 + 朝顶方向，
    // 而此刻切章的 remeasure / 定位可能尚未收敛，prepend 补偿基于过渡态基准
    // 会跳章——驻留期内由驻留判定挡掉，驻留期在 handleScroll 读出超过
    // CHAPTER_HEAD_DWELL_SCREENS 屏高后解除。
    chapterHeadDwellRef.current =
      explicitJump && chapterId ? { chapterId } : null;
    // 重新武装「打开时定位」：目标段落变了要重新定位一次
    // （含超时放弃兜底；模式切换跨章跟随也经由本 effect 完成武装）
    armScrollLocate(segmentId ?? '');
    // P1-17：无路由段落参数时恢复该章上次阅读段落（旧数据/无记录为 null → 回章首）；
    // 目录显式跳章除外（显式导航语义 = 章首）
    if (!segmentId && !explicitJump && restoreSegmentId) {
      armScrollLocate(restoreSegmentId);
      // 段内精确续读：滚动模式且有有效比例时武装精修（非恢复场景一律清除，
      // 防止上一次打开的恢复态在切章/显式跳章后残留误触发）
      if (readerMode === 'scroll' && restoreOffsetRatio != null) {
        ratioRefineRef.current = {
          segmentId: restoreSegmentId,
          ratio: restoreOffsetRatio,
          anchorOffset: -1,
        };
      } else {
        ratioRefineRef.current = null;
      }
    } else {
      ratioRefineRef.current = null;
    }
    // 翻页模式定位目标同步（无参数则从章首开始，保持既有行为）
    setLocateTarget(segmentId ?? (explicitJump ? null : restoreSegmentId) ?? null);
    activeChapterIdRef.current = chapterId;
    setActiveChapterId(chapterId);
    // 章已就位（无壳→全文过渡、seed effect 不会再跑）时也要检查目标行是否超窗
    locatePendingRowRef.current();
    // 依赖不含 restoreSegmentId：它仅随 chapterId / segmentId 变化（二者已在依赖中），
    // 变化触发的新一轮渲染闭包中即取到最新值，无需纳入依赖
    // jumpSeq：同章重复跳转（goToChapter 当前章）时参数其余字段不变，
    // 携带递增序号让本 effect 重新执行 → 复位到章首（重复跳转生效）
  }, [chapterId, segmentId, jumpSeq, listRef, rowOffsets, armScrollLocate]);

  // ---------- 选词 ----------

  /**
   * 长按正文：仅选中长按的单字并打开浮动菜单（初始选区 1 字，
   * 后续通过点按其它字自由扩展）。已有选区时再次长按 = 废弃当前选区、
   * 以新位置重新开始（自由选中语义）。
   */
  const handleLongPressIndex = useCallback(
    (segmentId: string, index: number) => {
      const chars = segmentCharsMap.get(segmentId);
      if (!chars || chars.length === 0) {
        return;
      }
      const start = clamp(index, 0, chars.length - 1);
      const end = Math.min(start + 1, chars.length);
      setSelection({ segmentId, start, end, text: chars.slice(start, end).join('') });
      setSelectionVisible(true);
    },
    [segmentCharsMap],
  );

  /**
   * 点按正文扩展/收缩选区（自由选中，替代旧版 ± 逐字步进按钮）：
   * - 点按位置在当前终点之后 → 终点扩展到该字（含）；
   * - 点按位置在起点之前 → 起点扩展到该字（向左扩展）；
   * - 点按选区内部 → 收缩（可连续收缩至 1 字）：点选区端点字 = 把该字从选区移除；
   *   点内部字以中点判定就近收缩——前半段（含起点）→ 起点重设为该字
   *   （选区变为 [tapIdx, end)），后半段 → 终点重设为该字右边界
   *   （选区变为 [start, tapIdx+1)）；收缩后至少保留 1 个字，
   *   单字选区点该字不变（放弃选区走「取消」按钮）；
   * - 点按其它段落 → 单段限制下以新位置重新选 1 字
   *   （与长按新起点行为一致，避免跨段选区破坏 Highlight 存储结构）。
   */
  const handleSelectionExtendPress = useCallback(
    (segmentId: string, index: number) => {
      setSelection((prev) => {
        if (segmentId !== prev?.segmentId) {
          const chars = segmentCharsMap.get(segmentId);
          if (!chars || chars.length === 0) {
            return prev;
          }
          const start = clamp(index, 0, chars.length - 1);
          const end = Math.min(start + 1, chars.length);
          return { segmentId, start, end, text: chars.slice(start, end).join('') };
        }
        const chars = segmentCharsMap.get(prev.segmentId);
        if (!chars) {
          return prev;
        }
        if (index >= prev.end) {
          const end = clamp(index + 1, prev.start + 1, chars.length);
          return { ...prev, end, text: chars.slice(prev.start, end).join('') };
        }
        if (index < prev.start) {
          const start = clamp(index, 0, prev.end - 1);
          return { ...prev, start, text: chars.slice(start, prev.end).join('') };
        }
        // 点按选区内部 → 就近收缩（可连续收缩至 1 字）：
        // 点端点字 = 把该字从选区移除（二字选区由此可缩到单字）；
        // 点内部字以中点判定归入起点侧/终点侧，
        // 边界保持 start < end（tap 在终点字上时 end 收到 tapIdx+1 = 原 end，不越界）
        if (prev.end - prev.start > 1) {
          if (index === prev.start) {
            const start = index + 1;
            return { ...prev, start, text: chars.slice(start, prev.end).join('') };
          }
          if (index === prev.end - 1) {
            return { ...prev, end: index, text: chars.slice(prev.start, index).join('') };
          }
          const mid = (prev.start + prev.end) / 2;
          if (index <= mid) {
            const start = index;
            return { ...prev, start, text: chars.slice(start, prev.end).join('') };
          }
          const end = index + 1;
          return { ...prev, end, text: chars.slice(prev.start, end).join('') };
        }
        // 单字选区：点该字收缩后为空，保持不变
        return prev;
      });
    },
    [segmentCharsMap],
  );

  /** 关闭选区菜单并清空选区（面板「取消」按钮：放弃当前选区） */
  const closeSelection = useCallback(() => {
    setSelectionVisible(false);
    setSelection(null);
  }, []);

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

  /**
   * 与当前选区重叠的已有划线（同段且区间相交，含部分重叠）。
   * 选词面板据此显示「取消划线」入口——选中带划线的字/节时可直接撤销划线。
   */
  const overlappingHighlights = useMemo(() => {
    if (!selection) {
      return [];
    }
    return highlights.filter(
      (h) =>
        h.segmentId === selection.segmentId &&
        h.startOffset < selection.end &&
        selection.start < h.endOffset,
    );
  }, [highlights, selection]);

  /** 「取消划线」两步确认态复位（关闭选区/选区变化时由 effect 调用） */
  const resetCancelHighlightConfirm = useCallback(() => {
    if (cancelHlConfirmTimer.current) {
      clearTimeout(cancelHlConfirmTimer.current);
      cancelHlConfirmTimer.current = null;
    }
    setConfirmCancelHighlight(false);
  }, []);

  // 选区面板关闭或重叠划线清空时复位「取消划线」待确认态
  useEffect(() => {
    if (!selectionVisible || overlappingHighlights.length === 0) {
      resetCancelHighlightConfirm();
    }
  }, [selectionVisible, overlappingHighlights.length, resetCancelHighlightConfirm]);

  // 卸载时清理「取消划线」待确认态计时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (cancelHlConfirmTimer.current) {
        clearTimeout(cancelHlConfirmTimer.current);
      }
    };
  }, []);

  /**
   * 面板「取消划线」：两步确认（首点进入警示色待确认态，3 秒未再点自动复位）。
   * 确认后删除与当前选区重叠的全部划线并关闭选区；任一划线关联了笔记时
   * Alert 二选一——同时删除笔记 / 仅删划线保留笔记（「删旧存新」解绑关联）。
   */
  const handleCancelHighlightPress = useCallback(() => {
    if (overlappingHighlights.length === 0) {
      return;
    }
    if (!confirmCancelHighlight) {
      setConfirmCancelHighlight(true);
      if (cancelHlConfirmTimer.current) {
        clearTimeout(cancelHlConfirmTimer.current);
      }
      cancelHlConfirmTimer.current = setTimeout(() => {
        cancelHlConfirmTimer.current = null;
        setConfirmCancelHighlight(false);
      }, 3000);
      return;
    }
    resetCancelHighlightConfirm();
    const linkedNotes = overlappingHighlights.flatMap((h) =>
      notes.filter((n) => n.highlightId === h.id),
    );
    overlappingHighlights.forEach((h) => removeHighlight(h.id));
    if (linkedNotes.length > 0) {
      Alert.alert('取消划线', '所选划线关联了笔记，如何处理？', [
        {
          text: '仅删划线保留笔记',
          onPress: () => {
            linkedNotes.forEach((linkedNote) => {
              const note = addNote({
                bookId: linkedNote.bookId,
                chapterId: linkedNote.chapterId,
                segmentId: linkedNote.segmentId,
                startOffset: linkedNote.startOffset,
                endOffset: linkedNote.endOffset,
                content: linkedNote.content,
              });
              if (note) {
                removeNote(linkedNote.id);
              }
            });
          },
        },
        {
          text: '同时删除笔记',
          style: 'destructive',
          onPress: () => {
            linkedNotes.forEach((linkedNote) => removeNote(linkedNote.id));
          },
        },
      ]);
    }
    closeSelection();
  }, [
    overlappingHighlights,
    confirmCancelHighlight,
    notes,
    removeHighlight,
    addNote,
    removeNote,
    resetCancelHighlightConfirm,
    closeSelection,
  ]);

  // ---------- 笔记 ----------

  /** 复位「删除划线」待确认态并清理复位计时器 */
  const resetDeleteConfirm = useCallback(() => {
    if (deleteConfirmTimer.current) {
      clearTimeout(deleteConfirmTimer.current);
      deleteConfirmTimer.current = null;
    }
    setConfirmDeleteHighlight(false);
  }, []);

  // 卸载时清理待确认态计时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (deleteConfirmTimer.current) {
        clearTimeout(deleteConfirmTimer.current);
      }
    };
  }, []);

  /** 点击划线：打开笔记编辑器（已有关联笔记则预填），并复位删除确认态 */
  const handleHighlightPress = useCallback(
    (h: Highlight) => {
      const existing = notes.find((n) => n.highlightId === h.id);
      setNoteContent(existing?.content ?? '');
      resetDeleteConfirm();
      setNoteEditor({
        segmentId: h.segmentId,
        start: h.startOffset,
        end: h.endOffset,
        highlightId: h.id,
        noteId: existing?.id,
      });
    },
    [notes, resetDeleteConfirm],
  );

  /** 对当前选区新建笔记 */
  const openNoteEditorForSelection = useCallback(() => {
    if (!selection) {
      Alert.alert('笔记', '请先长按正文选中文字');
      return;
    }
    setNoteContent('');
    resetDeleteConfirm();
    setNoteEditor({
      segmentId: selection.segmentId,
      start: selection.start,
      end: selection.end,
    });
    setSelectionVisible(false);
  }, [selection, resetDeleteConfirm]);

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
    resetDeleteConfirm();
  }, [resetDeleteConfirm]);

  /**
   * 「删除划线」两步确认：
   * 第一次点 → 按钮进入警示色待确认态（3 秒未再点自动复位）；
   * 确认后删除划线并关闭编辑器；若划线关联了笔记，Alert 二选一——
   * 同时删除笔记 / 仅删划线保留笔记（updateNote 仅支持改内容，
   * 解绑关联走「删旧存新」：同内容新记一条不带 highlightId 的笔记再删旧记录）。
   */
  const handleDeleteHighlightPress = useCallback(() => {
    const hlId = noteEditor?.highlightId;
    if (!hlId) {
      return;
    }
    if (!confirmDeleteHighlight) {
      setConfirmDeleteHighlight(true);
      if (deleteConfirmTimer.current) {
        clearTimeout(deleteConfirmTimer.current);
      }
      deleteConfirmTimer.current = setTimeout(() => {
        deleteConfirmTimer.current = null;
        setConfirmDeleteHighlight(false);
      }, 3000);
      return;
    }
    resetDeleteConfirm();
    // removeHighlight 内部成功后同步过滤本地列表，划线背景当帧消失
    removeHighlight(hlId);
    const linkedNote = notes.find((n) => n.highlightId === hlId);
    if (linkedNote) {
      Alert.alert('删除划线', '该划线关联了笔记，如何处理？', [
        {
          text: '仅删划线保留笔记',
          onPress: () => {
            const note = addNote({
              bookId: linkedNote.bookId,
              chapterId: linkedNote.chapterId,
              segmentId: linkedNote.segmentId,
              startOffset: linkedNote.startOffset,
              endOffset: linkedNote.endOffset,
              content: linkedNote.content,
            });
            if (note) {
              removeNote(linkedNote.id);
            }
          },
        },
        {
          text: '同时删除笔记',
          style: 'destructive',
          onPress: () => {
            removeNote(linkedNote.id);
          },
        },
      ]);
    }
    setNoteEditor(null);
    setNoteContent('');
  }, [
    noteEditor,
    confirmDeleteHighlight,
    notes,
    removeHighlight,
    addNote,
    removeNote,
    resetDeleteConfirm,
  ]);

  // ---------- 收藏 ----------

  /** 收藏目标章：滚动模式取实际正在阅读的章（activeChapterId），翻页模式取路由章 */
  const bookmarkChapter = useMemo<Chapter | null>(() => {
    const cid = readerMode === 'scroll' ? activeChapterId ?? chapterId : chapterId;
    if (!cid) {
      return null;
    }
    return effectiveChapters.find((c) => c.id === cid) ?? null;
  }, [readerMode, activeChapterId, chapterId, effectiveChapters]);

  /** 当前章的整篇收藏（article）：右上角「藏」按钮的已收藏态与取消收藏依据 */
  const articleBookmark = useMemo<Bookmark | null>(
    () =>
      bookmarks.find(
        (b) =>
          b.type === 'article' && b.bookId === bookId && b.chapterId === bookmarkChapter?.id,
      ) ?? null,
    [bookmarks, bookId, bookmarkChapter],
  );

  /** 整篇收藏切换（article）：未收藏 → 收藏；已收藏 → 两步确认后取消 */
  const handleToggleArticleBookmark = useCallback(() => {
    if (!bookId || !bookmarkChapter) {
      return;
    }
    if (articleBookmark) {
      Alert.alert(
        '取消收藏',
        `《${toDisplayText(bookmarkChapter.title)}》已收藏，确定取消吗？`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '取消收藏',
            style: 'destructive',
            onPress: () => removeBookmark(articleBookmark.id),
          },
        ],
      );
      return;
    }
    const saved = addBookmark({
      type: 'article',
      bookId,
      chapterId: bookmarkChapter.id,
      text: `${book?.title ?? ''}·${toDisplayText(bookmarkChapter.title)}`,
      tags: [],
    });
    if (saved) {
      Alert.alert('已收藏', `《${toDisplayText(bookmarkChapter.title)}》已加入收藏`);
    }
  }, [bookId, bookmarkChapter, articleBookmark, book, toDisplayText, addBookmark, removeBookmark]);

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

  const goBack = useCallback(() => {
    navigation?.goBack();
  }, [navigation]);

  /**
   * 注音模式循环切换（右上角「音」按钮，原底部注音切换条的功能迁移）：
   * 全文注音 → 仅生僻字 → 关闭 → 全文注音 …。持久化走 setPinyinMode（不变）。
   * 切换前先捕获滚动模式视口锚点：注音行高变化会使既有内容整体重排，
   * 不补偿则视口内容直接跳变（注音切换跳章 Bug 的滚动模式根因）。
   */
  const handleCyclePinyinMode = useCallback(() => {
    captureViewportAnchor();
    const idx = PINYIN_MODE_CYCLE.indexOf(pinyinMode);
    const next = PINYIN_MODE_CYCLE[(idx + 1) % PINYIN_MODE_CYCLE.length] ?? 'full';
    setPinyinMode(next);
  }, [pinyinMode, setPinyinMode, captureViewportAnchor]);

  /**
   * 字号步进（阅读设置弹窗 A− / A＋，范围 14–30）：
   * 与注音切换同款防跳动——滚动模式在 setState 生效前捕获视口锚点，
   * 字号变化使全部行高重排，不补偿则视口内容直接跳变成其它段落。
   * 连续快速点击时锚点按当时布局被覆盖重捕，最后一次捕获生效（可接受）；
   * 目标行若因布局变化未触发 onLayout，由 handleRowLayout 的超时放弃兜底。
   */
  const handleStepFontSize = useCallback(
    (dir: 1 | -1) => {
      captureViewportAnchor();
      setFontSize(dir > 0 ? Math.min(30, fontSize + 2) : Math.max(14, fontSize - 2));
    },
    [fontSize, setFontSize, captureViewportAnchor],
  );

  /** 行距选择（阅读设置弹窗紧凑/标准/宽松）：同款锚点防跳动 */
  const handleSelectLineHeight = useCallback(
    (lh: number) => {
      captureViewportAnchor();
      setLineHeight(lh);
    },
    [setLineHeight, captureViewportAnchor],
  );

  /** 繁简切换（阅读设置弹窗简体/繁體）：同款锚点防跳动 */
  const handleSelectConversionMode = useCallback(
    (mode: 'simplified' | 'traditional') => {
      captureViewportAnchor();
      setConversionMode(mode);
    },
    [setConversionMode, captureViewportAnchor],
  );

  /** 繁简切换（右上角「简/繁」按钮一键切换）：同款锚点防跳动 */
  const handleToggleConversionMode = useCallback(() => {
    captureViewportAnchor();
    setConversionMode(conversionMode === 'traditional' ? 'simplified' : 'traditional');
  }, [conversionMode, setConversionMode, captureViewportAnchor]);

  // ---------- 渲染 ----------

  /** 渲染一行：段落行走 SegmentItem（承载划线 / 长按选词 / 点按扩展选区），标题行走章标题 */
  const renderRow = useCallback(
    ({ item }: { item: ReaderRow }) => {
      if (item.segment) {
        return (
          <SegmentItem
            segment={item.segment}
            fontSize={fontSize}
            lineHeight={lineHeight}
            pinyinMode={pinyinMode}
            conversionMode={conversionMode}
            segmentHighlights={highlightsBySegment.get(item.segment.id) ?? EMPTY_HIGHLIGHTS}
            selectionRange={
              activeSelection && activeSelection.segmentId === item.segment.id
                ? [activeSelection.start, activeSelection.end]
                : undefined
            }
            onHighlightPress={handleHighlightPress}
            onLongPressIndex={handleLongPressIndex}
            onPressIndex={selectionVisible ? handleSelectionExtendPress : undefined}
            onLayoutItem={noopRowLayout}
            workId={item.chapterId}
            bookId={bookId ?? undefined}
          />
        );
      }
      return (
        <ChapterTitleText
          title={item.title ?? ''}
          pinyinMode={pinyinMode}
          conversionMode={conversionMode}
          workId={item.chapterId}
          bookId={bookId ?? undefined}
        />
      );
    },
    [
      fontSize,
      lineHeight,
      pinyinMode,
      conversionMode,
      highlightsBySegment,
      handleHighlightPress,
      handleLongPressIndex,
      handleSelectionExtendPress,
      selectionVisible,
      activeSelection,
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

  // 加载中（含内置书按需水合期：目标章解析通常 <100ms；以及跳入「空壳章」
  // ——首章优先水合后其余章节由后台分批填充，正文就位前保持加载态）
  const chapterPending =
    !!book &&
    !!chapter &&
    !!bookId &&
    !TextLibraryService.isUserBook(bookId) &&
    chapter.segments.length === 0;
  if (!chapter || !book || builtinHydrating || chapterPending) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* 顶部标题栏：【8】右侧功能按钮统一用固定最小热区（headerAction，34×32 +
          hitSlop 4~6），替换旧「纯 Text + hitSlop 8」的小热区——旧热区单字宽约 16px，
          相邻按钮 12px 间距叠加双向 hitSlop 后热区互相重叠（误触根因），
          且小热区在真机上难以点中（触发位置不精确） */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable
          onPress={goBack}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 4 }}
          style={({ pressed }) => [styles.headerActionWide, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="返回"
        >
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
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          onPress={() => setSettingsVisible(true)}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel="阅读设置"
        >
          <Text style={[styles.settingsButton, { color: colors.primary }]}>Aa</Text>
        </Pressable>
        {/* 一键繁简切换：点击在当前书籍简/繁显示间切换 */}
        <Pressable
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          onPress={handleToggleConversionMode}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel={`切换繁简显示（当前：${conversionMode === 'traditional' ? '繁體' : '简体'}）`}
        >
          <Text style={[styles.convButton, { color: colors.primary }]}>
            {conversionMode === 'traditional' ? '繁' : '简'}
          </Text>
        </Pressable>
        {/* 整篇收藏（原长按菜单「收藏全文」迁移）：已收藏主色高亮，再点两步确认取消 */}
        <Pressable
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          onPress={handleToggleArticleBookmark}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel={articleBookmark ? '取消收藏本章' : '收藏本章'}
        >
          <Text
            style={[
              styles.convButton,
              { color: articleBookmark ? colors.primary : colors.pinyin },
            ]}
          >
            藏
          </Text>
        </Pressable>
        {/* 正文朗读开关（右上角「听」）：未朗读 → 先弹语速设置弹窗（确认后播放）；
            朗读中 → 直接停止。朗读中主色高亮 + 图标变停止符，a11y 标签区分两种意图 */}
        <Pressable
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          onPress={handleListenPress}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel={ttsSpeaking ? '停止朗读' : '设置语速并朗读'}
        >
          <Text
            style={[
              styles.convButton,
              { color: ttsSpeaking ? colors.primary : colors.pinyin },
            ]}
          >
            {ttsSpeaking ? '⏹' : '听'}
          </Text>
        </Pressable>
        {/* 注音模式切换（原底部注音条迁移）：循环 全文注音 → 仅生僻字 → 关闭。
            视觉指示：全文注音=主色 / 仅生僻字=正文色 / 关闭=弱化灰，a11y 标签说明当前模式 */}
        <Pressable
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          onPress={handleCyclePinyinMode}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel={`注音模式：${PINYIN_MODE_LABELS[pinyinMode]}，点击切换为${
            PINYIN_MODE_LABELS[
              PINYIN_MODE_CYCLE[
                (PINYIN_MODE_CYCLE.indexOf(pinyinMode) + 1) % PINYIN_MODE_CYCLE.length
              ] ?? 'full'
            ]
          }`}
        >
          <Text
            style={[
              styles.convButton,
              {
                color:
                  pinyinMode === 'full'
                    ? colors.primary
                    : pinyinMode === 'rare'
                      ? colors.text
                      : colors.pinyin,
              },
            ]}
          >
            音
          </Text>
        </Pressable>
      </View>

      {/* 正文区域 + 底部进度条 + 选区浮动菜单（选区菜单以阅读页内浮动层实现，
          box-none 允许点按穿透到正文做「点按扩展选区」，不再用全屏 Modal 遮挡正文） */}
      <View style={styles.readerBody}>
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
              displayMode={conversionMode}
              highlightsBySegment={highlightsBySegment}
              activeSelection={activeSelection}
              onHighlightPress={handleHighlightPress}
              onLongPressIndex={handleLongPressIndex}
              onPressIndex={selectionVisible ? handleSelectionExtendPress : undefined}
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
            // cell 层布局上报：行内 onLayout 的 y 相对 cell 容器恒 ≈0，
            // 必须在 cell 根 View（父节点=滚动内容容器）测量内容绝对 y
            CellRendererComponent={scrollCellRenderer}
            // 目标段落定位：一次性渲染足够多的段落以保证 onLayout 触发。
            // 行数按打开章内容量预算计算（scrollInitialRows）：内置书仍为 30 行，
            // 导入书大段落按字符预算收缩，避免首帧逐字注音渲染压死 JS 线程。
            initialNumToRender={scrollInitialRows}
            // 【P0】渲染窗口收敛与批量调参（见 LIST_WINDOW_SIZE 注释）
            windowSize={LIST_WINDOW_SIZE}
            maxToRenderPerBatch={LIST_MAX_TO_RENDER_PER_BATCH}
            updateCellsBatchingPeriod={LIST_UPDATE_CELLS_BATCHING_PERIOD}
            contentContainerStyle={styles.content}
            // 【P1】头部插入/丢头的视口保持由原生层完成（见 MVCP_ENABLED 注释）；
            // MVCP_ENABLED=false 时回退到手写补偿链路（prependAnchor 等）
            maintainVisibleContentPosition={MVCP_ENABLED ? MVCP_CONFIG : undefined}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            onEndReached={handleEndReached}
            // 预载窗口（屏高倍数）与 handleScroll / onContentSizeChange 的触发条件保持一致
            onEndReachedThreshold={CONTIGUOUS_PRELOAD_SCREENS}
            onStartReached={handleStartReached}
            onStartReachedThreshold={CONTIGUOUS_PRELOAD_SCREENS}
            onScrollToIndexFailed={handleScrollToIndexFailed}
            onContentSizeChange={(_w, h) => {
              // 【PERF】首帧内容量高：水合后正文首次完成布局的时间点
              if (!firstContentSizeLoggedRef.current && h > 0) {
                firstContentSizeLoggedRef.current = true;
                console.info(
                  `[PERF][reader] firstContentH=${Math.round(h)} +${
                    Date.now() - readerMountT0Ref.current
                  }ms`,
                );
              }
              // 锚点兜底补偿（MVCP_ENABLED=false 时的手写回退路径；MVCP 开启时
              // 锚点不登记，本块天然空转）：锚点行若移出渲染窗口，onLayout
              // 永不触发，此时用 contentSize 增量（首次变化恰为插入高度）做
              // 一次性补偿——优于不补偿（那会整屏跳到上一章开头）。增量非正
              // 则等锚点/超时处理。
              const anchorNow = prependAnchor.current;
              if (anchorNow) {
                // 精确路径（优先）：锚点行已重排时直接用「新 y − 旧 y（恒 0，
                // 锚点行是列表首行）」补偿——只含插入高度，与同期 append 的
                // 下方内容无关，绝不受同帧合并的 contentSize 增量污染。
                // 【r28 防误补偿】rowOffsets 是「最近一次 onLayout」的缓存，
                // 锚点行未随插入重新布局时（落入渲染窗口外）读到的是陈旧值——
                // 必须与快照中该行的旧 y 比对：相等即尚未重排，让位给增量
                // 兜底路径，绝不能拿旧 y 当「插入高度」补偿。
                const newY = rowOffsets.current.get(anchorNow.firstRowId);
                const oldY = anchorNow.snapshot.get(anchorNow.firstRowId);
                if (
                  typeof newY === 'number' &&
                  newY > 0 &&
                  newY !== oldY
                ) {
                  anchorNow.snapshot.forEach((oldY, key) => {
                    if (rowOffsets.current.get(key) === oldY) {
                      rowOffsets.current.set(key, oldY + newY);
                    }
                  });
                  listRef.current?.scrollToOffset({
                    // 基准与行布局路径一致：用解析时刻实际偏移（触发到解析
                    // 之间用户可能已滚动，陈旧 baseOffset 会把视野拽回触发点）
                    offset: Math.max(0, scrollOffset.current + newY),
                    animated: false,
                  });
                  prependAnchor.current = null;
                } else if (
                  anchorNow.createdAt - lastAppendAtRef.current >
                  APPEND_COALESCE_MS
                ) {
                  // 增量兜底路径（仅限本次增量纯属 prepend 时）：
                  // attempt 先 append 后 prepend，同 tick 内二者的渲染合并、
                  // contentSize 增量 = 两者之和，混入 append 高度会把视口
                  // 向前多甩一章（跳章后连滚多章根因）——距锚点创建一个
                  // 合并窗口内有过 append 即视为增量可疑，让位给锚点行布局
                  // 路径（handleRowLayout）或超时兜底。
                  // 注：锚点存活期间 appendNextChapter 本就被互斥守卫阻塞，
                  // 因此只可能存在「同 tick 先 append 后 prepend」的污染源。
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
              }
              // 滑动窗口丢头补偿：头部章节被丢弃后保留内容整体上移「丢弃高度」，
              // 把滚动偏移回退相同高度，使视口仍停留在用户正在阅读的内容上。
              // 补偿量在丢头时按 rowOffsets 精确算出（见 maybeDropHeadChapters）。
              const dropDelta = headDropCompensation.current;
              if (dropDelta > 0) {
                headDropCompensation.current = 0;
                listRef.current?.scrollToOffset({
                  offset: Math.max(0, scrollOffset.current - dropDelta),
                  animated: false,
                });
              }
              contentH.current = h;
              // 短内容兜底：内容不足预载窗口时级联追加下一章（道德经级短章的
              // 「停在第一章、无法滚动」死锁的修复点，见 fillShortContentIfNeeded）
              fillShortContentIfNeeded();
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
              // 【4】统一判定（手势窗口 + 朝顶部方向）：切章/打开后的程序化布局
              // 与向下阅读中的追加（fillShort）引发的内容尺寸变化都不满足条件，
              // 不会把视口推到上一章再拉回（跳错章节/跳动的根因）。
              // 【5】经 requestAutoPrepend 统一执行：手势进行中只记延迟意图，
              // 且 onContentSizeChange 兜底不直接做补偿——补偿单一源在
              // handleRowLayout 锚点路径 / 本回调的锚点增量兜底（均由
              // prependAnchor 守卫，一次 prepend 至多执行一处补偿）。
              if (h > 0 && shouldAutoPrepend(scrollOffset.current)) {
                requestAutoPrepend(scrollOffset.current);
              }
            }}
            onLayout={(e) => {
              viewH.current = e.nativeEvent.layout.height;
              // 首帧布局完成即补一次短内容兜底：contentSize 事件可能先于 onLayout
              // 到达（当时 viewH 尚为 0 会被口径函数跳过），错过首次时机则在此补齐
              fillShortContentIfNeeded();
            }}
          />
        )}

        {/* 底部浮动 dock（进度 + 朗读 + 注音模式 + 工具栏）已随 UI 精简删除：
            进度 / 朗读 / 语速 / 收藏 / 背诵并入下方「选词操作面板」（长按正文弹出），
            注音切换迁移至右上角「音」按钮 */}

        {/* 底部固定进度条：第 N/共 M 章 ·（第 i/j 页）· X% + 细进度条。
            滚动模式进度随 activeChapterId 实时更新（progressChapterId），
            翻页模式由当前页/总页数给出章内进度；safe-area 由外层 SafeAreaView 处理 */}
        <View style={[styles.bottomProgress, { borderTopColor: colors.border }]}>
          <Text style={[styles.bottomProgressText, { color: colors.textSecondary }]}>
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

        {/* 选词操作浮动层（阅读页内绝对定位，替代全屏 Modal）：
            容器 pointerEvents="box-none" 不拦截触摸，正文子节点自接收点按
            （选区打开时点按正文 = 扩展选区）；仅面板本体拦截触摸。
            底部停靠于进度条上方。三段式结构根除截断：
            ① 内容区（选中文本独立 ScrollView 限高，短选区自适应/超长内滚）
            ② hairline 分隔线
            ③ 固定操作栏（划线行 + 等宽操作按钮行，脱离滚动区、永不压缩） */}
        {selectionVisible && selection ? (
          <View style={styles.selectionDock} pointerEvents="box-none">
            <View style={[styles.selectionSheet, { backgroundColor: colors.background }]}>
              {/* 第一段 · 内容区：标题 + 选中文本独立限高滚动（固定数值 maxHeight，
                  仅超长选区时该区域内部滚动；短选区自适应高度，不出现空滚动态） */}
              <Text style={[styles.sheetTitle, { color: colors.textSecondary }]}>选中文字</Text>
              {/* 选中文字完整换行显示（不截断）：超长选区经本区 ScrollView 限高滚动查看 */}
              <ScrollView
                nestedScrollEnabled
                alwaysBounceVertical={false}
                showsVerticalScrollIndicator={false}
                style={styles.selectionContentScroll}
              >
                <Text style={[styles.selectionText, { color: colors.text }]}>
                  {selection.text}
                </Text>
              </ScrollView>
              <Text style={[styles.selectionHint, { color: colors.pinyin }]}>
                点按字扩展选区 · 点选区内收缩（可缩至 1 字）· 长按重新选字
              </Text>

              {/* 第二段 · hairline 分隔线：内容区与固定操作栏之间 */}
              <View style={[styles.selectionDivider, { backgroundColor: colors.border }]} />

              {/* 第三段 · 固定操作栏（不参与滚动、任何屏宽均完整显示）：
                  第一行「划线」= 左标签 + 取消划线入口（选区与已有划线重叠时显示，
                  两步确认防误删）+ 三色圆点；第二行 = 4 个 flex:1 等宽按钮。
                  按钮作用于当前选区，实时跟随点按扩展更新 */}
              <View style={styles.selectionHighlightRow}>
                <Text
                  style={[styles.selectionHighlightLabel, { color: colors.textSecondary }]}
                >
                  划线
                </Text>
                {overlappingHighlights.length > 0 ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.cancelHighlightButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={handleCancelHighlightPress}
                    accessibilityRole="button"
                    accessibilityLabel={
                      confirmCancelHighlight ? '确认取消划线' : '取消划线'
                    }
                  >
                    <Text
                      style={[
                        styles.selectionHighlightLabel,
                        {
                          color: confirmCancelHighlight
                            ? DELETE_DANGER_COLOR
                            : colors.textSecondary,
                        },
                      ]}
                    >
                      {confirmCancelHighlight ? '确认取消划线？' : '取消划线'}
                    </Text>
                  </Pressable>
                ) : null}
                <View style={styles.selectionHighlightDots}>
                  {(['yellow', 'green', 'blue'] as HighlightColor[]).map((color) => (
                    <Pressable
                      key={color}
                      style={[styles.colorDotButton, { backgroundColor: DOT_COLORS[color] }]}
                      onPress={() => createHighlight(color)}
                      accessibilityRole="button"
                      accessibilityLabel={`使用${color}颜色划线`}
                    />
                  ))}
                </View>
              </View>
              <View style={styles.selectionActionsRow}>
                <Pressable style={styles.selectionActionButton} onPress={openAnalysis}>
                  <Text style={[styles.actionButtonText, { color: colors.primary }]}>解析</Text>
                </Pressable>
                <Pressable style={styles.selectionActionButton} onPress={openTranslation}>
                  <Text style={[styles.actionButtonText, { color: colors.primary }]}>翻译</Text>
                </Pressable>
                <Pressable style={styles.selectionActionButton} onPress={openNoteEditorForSelection}>
                  <Text style={[styles.actionButtonText, { color: colors.primary }]}>笔记</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.selectionActionButton,
                    pressed && styles.pressed,
                  ]}
                  onPress={closeSelection}
                  accessibilityRole="button"
                  accessibilityLabel="取消选区"
                >
                  <Text style={[styles.actionButtonText, { color: colors.textSecondary }]}>
                    取消
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
      </View>

      {/* 语速设置弹窗（点右上角「听」且未朗读时弹出）：本地临时值步进，
          「确认开始播放」才写回持久化并开播；取消不污染持久化语速 */}
      <Modal
        visible={rateModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCancelSpeechRate}
      >
        <Pressable style={styles.overlay} onPress={handleCancelSpeechRate}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.background }]}
            onPress={() => undefined}
          >
            <Text style={[styles.sheetTitle, { color: colors.textSecondary }]}>朗读语速</Text>
            <Text style={[styles.rateValue, { color: colors.primary }]}>
              {tempSpeechRate.toFixed(2)}x
            </Text>
            <View style={styles.actionRow}>
              <Pressable
                style={[
                  styles.rangeButton,
                  { borderColor: colors.border },
                  tempSpeechRate <= 0.5 && styles.actionDisabled,
                ]}
                onPress={() => handleStepTempSpeechRate(-1)}
                disabled={tempSpeechRate <= 0.5}
                accessibilityRole="button"
                accessibilityLabel="降低语速"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'−'}</Text>
              </Pressable>
              <Text style={[styles.menuRateValue, { color: colors.text }]}>
                {tempSpeechRate.toFixed(2)}x
              </Text>
              <Pressable
                style={[
                  styles.rangeButton,
                  { borderColor: colors.border },
                  tempSpeechRate >= 2.0 && styles.actionDisabled,
                ]}
                onPress={() => handleStepTempSpeechRate(1)}
                disabled={tempSpeechRate >= 2.0}
                accessibilityRole="button"
                accessibilityLabel="提高语速"
              >
                <Text style={[styles.rangeButtonText, { color: colors.textSecondary }]}>{'＋'}</Text>
              </Pressable>
            </View>
            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
                onPress={handleCancelSpeechRate}
                accessibilityRole="button"
                accessibilityLabel="取消语速设置"
              >
                <Text style={[styles.actionButtonText, { color: colors.textSecondary }]}>取消</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
                onPress={handleConfirmSpeechRate}
                accessibilityRole="button"
                accessibilityLabel="确认语速并开始播放"
              >
                <Text style={[styles.actionButtonText, { color: colors.primary }]}>
                  确认开始播放
                </Text>
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
            {/* 删除划线入口：仅「点已有划线打开编辑器」（highlightId 已落库）时显示，
                选区新建笔记路径尚未落划线不显示。两步确认防误删，确认态警示色 */}
            {noteEditor?.highlightId ? (
              <Pressable
                style={({ pressed }) => [
                  styles.deleteHighlightRow,
                  pressed && styles.pressed,
                ]}
                onPress={handleDeleteHighlightPress}
                accessibilityRole="button"
                accessibilityLabel={confirmDeleteHighlight ? '确认删除划线' : '删除划线'}
              >
                <Text
                  style={[
                    styles.deleteHighlightText,
                    {
                      color: confirmDeleteHighlight
                        ? DELETE_DANGER_COLOR
                        : colors.textSecondary,
                    },
                  ]}
                >
                  {confirmDeleteHighlight ? '确认删除划线？' : '删除划线'}
                </Text>
              </Pressable>
            ) : null}
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

            {/* 设置分层说明：面板内修改仅写当前书覆盖层，全局默认在「我的-设置」改 */}
            {isPerBook ? (
              <Text style={[styles.sheetHint, { color: colors.textSecondary }]}>
                当前设置仅对本书生效；前往「我的 → 设置」修改全局默认
              </Text>
            ) : null}
            {/* 「跟随全局」复位入口：存在任一书籍级覆盖键时展示，清空即恢复跟随全局 */}
            {hasBookOverrides ? (
              <Pressable
                style={[styles.followGlobalButton, { borderColor: colors.border }]}
                onPress={() => followGlobal()}
                accessibilityRole="button"
                accessibilityLabel="恢复本书设置跟随全局默认"
              >
                <Text style={[styles.followGlobalText, { color: colors.primary }]}>
                  恢复跟随全局默认
                </Text>
              </Pressable>
            ) : null}

            {/* 字号：A- / A+ 步进，含实时预览 */}
            <SettingsSectionTitle text="字号" colors={colors} />
            <View style={styles.sizeRow}>
              <Pressable
                style={[styles.sizeButton, { borderColor: colors.border }]}
                onPress={() => handleStepFontSize(-1)}
                disabled={fontSize <= 14}
                accessibilityRole="button"
                accessibilityLabel="减小字号"
              >
                <Text style={[styles.sizeButtonText, { color: colors.text }]}>A−</Text>
              </Pressable>
              <Text style={[styles.sizeValue, { color: colors.textSecondary }]}>{fontSize}</Text>
              <Pressable
                style={[styles.sizeButton, { borderColor: colors.border }]}
                onPress={() => handleStepFontSize(1)}
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
                  onPress={() => handleSelectLineHeight(lh)}
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
                  onPress={() => handleSelectConversionMode(mode)}
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
                    // 【4】高亮跟随「实际正在阅读的章」（滚动模式连续拼接后路由章
                    // 停留在入口章，高亮路由章会误导用户对当前位置的判断）
                    item.id === progressChapterId && { backgroundColor: colors.primarySoft },
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
                      { color: item.id === progressChapterId ? colors.primary : colors.text },
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

/** 划线圆点实色（选词面板三色划线，与全 App 划线视觉语言一致） */
const DOT_COLORS: Record<HighlightColor, string> = {
  yellow: '#F5D742',
  green: '#4CAF50',
  blue: '#2196F3',
};

/** 删除划线确认态警示色（主题无 danger 色，固定红以免随纸色失效） */
const DELETE_DANGER_COLOR = '#C0392B';

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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    fontSize: 16,
    // 【8】水平间距由热区容器（headerActionWide）承担，文本自身不再加 margin
  },
  /**
   * 【8】右上角功能按钮统一热区容器：最小 34×32、内容居中。
   * 相邻热区 pitch = 34px + 各 2px hitSlop = 38px，刚好相切不重叠；
   * 旧实现纯 Text 热区单字约 16px 宽，叠加 12px 间距 + 双向 hitSlop 8 后
   * 相邻热区互相覆盖（误触/点不中根因）。
   */
  headerAction: {
    minWidth: 34,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 返回按钮热区：更宽的左右命中（左侧贴屏，向左扩大 slop） */
  headerActionWide: {
    minWidth: 48,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
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
  },
  convButton: {
    fontSize: 16,
    fontWeight: '600',
    minWidth: 20,
    textAlign: 'center',
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
  // 章节标题（注音版）：容器负责间距与水平居中；文字样式经 PinyinText 的
  // baseTextStyle 注入（注音字格/非汉字 run/降级纯文本三路统一生效）
  chapterTitleWrap: {
    marginBottom: 24,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  chapterTitleText: {
    fontWeight: '600',
    textAlign: 'center',
  },
  segment: {
    marginBottom: PARAGRAPH_SPACING,
  },
  /** 拆页续块：去掉段落下边距，页内视觉上仍是同一段的连续行 */
  segmentContinuation: {},
  // 底部固定进度条（原长按菜单进度行回归页底）
  bottomProgress: {
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 16,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomProgressText: {
    fontSize: 12,
  },
  pressed: {
    opacity: 0.7,
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
  // 「听」语速弹窗：当前倍率大字展示 + 步进行倍率展示
  rateValue: {
    fontSize: 40,
    fontWeight: '600',
    textAlign: 'center',
  },
  menuRateValue: {
    fontSize: 14,
    fontWeight: '600',
    minWidth: 56,
    textAlign: 'center',
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
  // 阅读设置抽屉：书籍级分层说明文案（随面板 hint 视觉，弱化灰字）
  sheetHint: {
    fontSize: 12,
    lineHeight: 18,
  },
  // 阅读设置抽屉：「恢复跟随全局默认」复位入口
  followGlobalButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  followGlobalText: {
    fontSize: 13,
    fontWeight: '600',
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
  // 正文区域容器：包裹正文 + 底部进度条 + 选区浮动层，
  // 使选区浮动层可相对于该区域绝对定位（不遮挡顶部栏，停靠进度条上方）
  readerBody: {
    flex: 1,
  },
  // 选词操作浮动层容器：box-none 不拦截触摸（点按穿透到正文做选区扩展），
  // 仅面板本体拦截；满幅覆盖正文区（高度确定，maxHeight 百分比才有基准），
  // 面板经 justifyContent flex-end 底部停靠；paddingBottom 预留底部进度条高度
  selectionDock: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingBottom: 56,
  },
  // 选词面板本体：三段式（内容区 / 分隔线 / 固定操作栏），内容总高有界
  // （选中文本区固定限高 + 操作栏两行定高），maxHeight 65% 仅作外层保险
  selectionSheet: {
    borderRadius: 14,
    padding: 16,
    gap: 10,
    maxHeight: '65%',
    // iOS 阴影
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    // Android 阴影
    elevation: 6,
  },
  selectionText: {
    fontSize: 17,
    // 多行换行时的舒适行高（单行/多行通用，风格不变）
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  // 选中文本独立滚动区：固定数值限高（勿用百分比——Android 上百分比 maxHeight
  // 在 flex-end 容器内测量不稳），仅超长选区时内部滚动，短选区自适应高度；
  // alwaysBounceVertical=false 避免短内容时出现空滚动态
  selectionContentScroll: {
    maxHeight: 140,
  },
  selectionHint: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
  },
  // hairline 分隔线：内容区与固定操作栏之间
  selectionDivider: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  // 划线行（固定操作栏第一行）：左标签 + 右三色圆点，仅 3 圆点必放得下、无需换行
  selectionHighlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 28,
  },
  selectionHighlightLabel: {
    fontSize: 13,
  },
  // 「取消划线」入口（划线行中部，仅选区与已有划线重叠时显示）：
  // 扩大触达面积的 padding，确认态文案由调用处以警示色渲染
  cancelHighlightButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  selectionHighlightDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  // 操作行（固定操作栏第二行）：解析/翻译/笔记/取消 4 按钮 flex:1 等宽
  // （flexBasis 0 均分剩余宽度），任何屏宽均完整显示、永不压缩截断
  selectionActionsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  selectionActionButton: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 40,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
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
  // 删除划线入口行（操作行下方居中，两步确认警示态）
  deleteHighlightRow: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  deleteHighlightText: {
    fontSize: 14,
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
