/**
 * 行间注音文本渲染组件（PinyinText）
 * 逐字渲染：汉字上方显示小号灰色拼音，下方为汉字正文，flexWrap 自动换行。
 * - 通假字：拼音行上方的独立「通」圆标（水平居中于汉字正上方，不与拼音并排、不遮挡拼音、不改变行基线），点击弹出浮窗展示本字/释义/出处
 * - 生僻字：汉字加下划线强调
 * - 多音字：拼音以强调色显示，点击拼音弹出全部候选读音浮窗
 * - 划线：命中段的汉字叠加半透明背景（可选）
 * 性能：React.memo + useMemo 预计算渲染数组；off 模式直接渲染纯文本。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { Highlight, PinyinAnnotation, PinyinMode } from '@/types';

import { usePinyin } from '@/hooks/usePinyin';
import { getPolyphoneReadings } from '@/services/PinyinService';
import { ConversionService } from '@/services/ConversionService';
import { GuyinService, GUYIN_ATTRIBUTION, type GuyinEntry } from '@/services/GuyinService';
import { useReadingOverrideStore } from '@/store/useReadingOverrideStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, highlightColors, withAlpha, type ThemeColors } from '@/theme';
import {
  PINYIN_FONT_RATIO,
  PINYIN_LINE_GAP,
  getLineHeightPx,
} from '@/theme/typography';
import { buildHighlightedSegments } from '@/utils/highlight';
import { clearPinyinCache, getPinyinPairs, isCJKChar } from '@/utils/pinyin';
import { toSimplified } from '@/utils/conversion';

// ---------- 渲染单元数据模型 ----------

/** 单字渲染单元 */
interface CharCellData {
  kind: 'char';
  /** 码点索引（与高亮偏移基准一致） */
  index: number;
  char: string;
  pinyin: string;
  isRare: boolean;
  isPolyphone: boolean;
  /** 通假字信息（用于右上角「通」标识与浮窗） */
  tongjia?: { original: string; note?: string; source?: string; sources?: string[]; verified?: boolean; context?: string };
  /** 语境读音源（多音字浮窗展示） */
  readingSources?: string[];
  /** 语境读音是否校验 */
  readingVerified?: boolean;
  /** 命中的划线（用于背景与点击） */
  highlight?: Highlight;
}

/** 连续非汉字片段（标点/空白等）渲染单元 */
interface RunCellData {
  kind: 'run';
  index: number;
  text: string;
}

type CellData = CharCellData | RunCellData;

/** 预计算样式集合（依赖 fontSize/lineHeight/colors，useMemo 保证引用稳定） */
interface CellStyles {
  row: ViewStyle;
  cell: ViewStyle;
  pinyin: TextStyle;
  char: TextStyle;
  rareChar: TextStyle;
  run: TextStyle;
  tongjiaMark: ViewStyle;
  tongjiaMarkText: TextStyle;
}

/** 拼音字号 */
function getPinyinSize(fontSize: number): number {
  return Math.max(9, Math.round(fontSize * PINYIN_FONT_RATIO));
}

/** 构建渲染单元数组：汉字逐字、非汉字合并为 run */
function buildCells(
  pairs: {
    char: string;
    pinyin: string;
    isRare: boolean;
    isPolyphone: boolean;
    tongjia?: { original: string; note?: string; source?: string; sources?: string[]; verified?: boolean; context?: string };
    readingSources?: string[];
    readingVerified?: boolean;
  }[],
  highlights: Highlight[] | undefined,
): CellData[] {
  // 高亮归属：码点索引 -> Highlight
  let hlByIndex: (Highlight | undefined)[] | null = null;
  if (highlights && highlights.length > 0) {
    const text = pairs.map((p) => p.char).join('');
    hlByIndex = new Array(pairs.length);
    for (const seg of buildHighlightedSegments(text, highlights)) {
      if (seg.highlight) {
        for (let i = seg.start; i < seg.end; i++) {
          hlByIndex[i] = seg.highlight;
        }
      }
    }
  }

  const cells: CellData[] = [];
  let run = '';
  let runStart = -1;
  const flushRun = () => {
    if (run) {
      cells.push({ kind: 'run', index: runStart, text: run });
      run = '';
      runStart = -1;
    }
  };

  pairs.forEach((p, i) => {
    if (isCJKChar(p.char)) {
      flushRun();
      cells.push({
        kind: 'char',
        index: i,
        char: p.char,
        pinyin: p.pinyin,
        isRare: p.isRare,
        isPolyphone: p.isPolyphone,
        tongjia: p.tongjia,
        readingSources: p.readingSources,
        readingVerified: p.readingVerified,
        highlight: hlByIndex ? hlByIndex[i] : undefined,
      });
    } else {
      if (!run) {
        runStart = i;
      }
      run += p.char;
    }
  });
  flushRun();

  return cells;
}

// ---------- 子组件（memo 化） ----------

interface CharCellProps {
  cell: CharCellData;
  styles: CellStyles;
  /** 多音字拼音色 */
  accentColor: string;
  /** 活动选区背景色（主色半透明），仅选中字格着色 */
  selectionBg: string;
  /** 该字格是否处于活动选区内 */
  selected: boolean;
  onHighlightPress?: (h: Highlight) => void;
  onLongPressChar?: (index: number) => void;
  /** 点按汉字回调（自由选区扩展用；提供时优先于划线点击） */
  onPressChar?: (index: number) => void;
  /** 点击多音字拼音回调（弹出全部读音浮窗），仅多音字生效 */
  onPressPinyin?: (cell: CharCellData) => void;
  /** 点击通假字「通」标识回调（弹出通假字浮窗），仅通假字生效 */
  onPressTongjia?: (cell: CharCellData) => void;
}

/** 单字单元：拼音行 + 汉字行 + 通假字「通」标识 */
const CharCell = React.memo(function CharCell({
  cell,
  styles,
  accentColor,
  selectionBg,
  selected,
  onHighlightPress,
  onLongPressChar,
  onPressChar,
  onPressPinyin,
  onPressTongjia,
}: CharCellProps) {
  const highlight = cell.highlight;
  // 汉字点按：选区扩展中（onPressChar 存在）→ 点按扩展选区；
  // 否则保持原行为——点已划线字符打开关联笔记
  const pressChar = onPressChar
    ? () => onPressChar(cell.index)
    : highlight && onHighlightPress
      ? () => onHighlightPress(highlight)
      : undefined;
  // 仅多音字拼音响应点击（弹出全部读音），不占用汉字的划线点击与长按手势
  const pressPinyin =
    cell.isPolyphone && onPressPinyin ? () => onPressPinyin(cell) : undefined;
  // 通假字「通」标识响应点击（弹出本字/释义/出处）
  const pressTongjia =
    cell.tongjia && onPressTongjia ? () => onPressTongjia(cell) : undefined;
  return (
    <View style={styles.cell}>
      {cell.tongjia ? (
        <Pressable
          style={styles.tongjiaMark}
          onPress={pressTongjia}
          hitSlop={6}
          accessibilityLabel={`通假字：${cell.char} 通 ${cell.tongjia.original}`}
        >
          <Text style={styles.tongjiaMarkText} numberOfLines={1}>
            通
          </Text>
        </Pressable>
      ) : null}
      <Text
        style={[styles.pinyin, cell.isPolyphone ? { color: accentColor } : null]}
        numberOfLines={1}
        ellipsizeMode="clip"
        onPress={pressPinyin}
      >
        {cell.pinyin}
      </Text>
      <Text
        style={[
          styles.char,
          cell.isRare ? styles.rareChar : null,
          // 已保存划线背景：未被活动选区覆盖时显示（选区样式优先，保证选区在
          // 三色划线上仍以主色半透明可辨识，而非与划线色混叠）
          highlight && !selected
            ? { backgroundColor: highlightColors[highlight.color] }
            : null,
          // 活动选区视觉反馈：主色半透明背景（菜单打开期间实时跟随扩展更新）
          selected ? { backgroundColor: selectionBg } : null,
        ]}
        onPress={pressChar}
        onLongPress={onLongPressChar ? () => onLongPressChar(cell.index) : undefined}
      >
        {cell.char}
      </Text>
    </View>
  );
});

interface RunCellProps {
  cell: RunCellData;
  styles: CellStyles;
}

/** 非汉字片段单元（顶部留出拼音行高度以对齐正文基线） */
const RunCell = React.memo(function RunCell({ cell, styles }: RunCellProps) {
  return <Text style={styles.run}>{cell.text}</Text>;
});

// ---------- 多音字读音浮窗 ----------

/** 浮窗数据：字 + 全部候选读音 + 当前语境读音 */
interface PolyphonePopupData {
  char: string;
  readings: string[];
  current: string;
  /** 当前语境读音来源（canon 命中时填写） */
  readingSources?: string[];
  /** 当前语境读音是否经校验（false=系统默认·未校验） */
  readingVerified?: boolean;
  /** 古音拟音（Baxter-Sagart 命中时填写，展示中古/上古两行） */
  guyin?: GuyinEntry;
  /** 用户已纠正的读音（char+context 命中时填写，浮窗展示「恢复默认」入口） */
  overrideReading?: string;
}

/** 浮窗样式（依赖主题与字号） */
interface PopupStyles {
  backdrop: ViewStyle;
  card: ViewStyle;
  title: TextStyle;
  char: TextStyle;
  readingsRow: ViewStyle;
  reading: TextStyle;
  readingDivider: TextStyle;
  currentReading: TextStyle;
  hint: TextStyle;
  tongjiaRow: ViewStyle;
  tongjiaChar: TextStyle;
  tongjiaArrow: TextStyle;
  tongjiaNote: TextStyle;
  tongjiaSource: TextStyle;
  guyinRow: ViewStyle;
  guyinLine: ViewStyle;
  guyinLabel: TextStyle;
  guyinValue: TextStyle;
  guyinAttribution: TextStyle;
}

/** 拟音展示上限：拟音串极长时截断，防止浮窗被撑破 */
const GUYIN_MAX_LEN = 60;

/** 拟音串截断（超长时截前 60 字符并加省略号） */
function truncatePhonetic(s: string): string {
  const chars = Array.from(s);
  return chars.length > GUYIN_MAX_LEN
    ? `${chars.slice(0, GUYIN_MAX_LEN).join('')}…`
    : s;
}

interface PolyphonePopupProps {
  data: PolyphonePopupData;
  styles: PopupStyles;
  accentColor: string;
  onClose: () => void;
  /** 点选候选读音回调（用户读音纠正；未提供则读音只读展示） */
  onSelectReading?: (reading: string) => void;
  /** 恢复系统默认（删除该字该句的读音纠正；仅存在纠正时展示） */
  onResetReading?: () => void;
}

/**
 * 多音字读音浮窗：透明 Modal 居中小卡片，展示「字 + 全部候选读音」。
 * 当前语境读音用强调色加粗标识；点击卡片外任意区域关闭。
 * 提供 onSelectReading 时候选读音可点选（用户读音纠正闭环入口）。
 */
const PolyphonePopup = React.memo(function PolyphonePopup({
  data,
  styles,
  accentColor,
  onClose,
  onSelectReading,
  onResetReading,
}: PolyphonePopupProps) {
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 内层可点区域拦截触摸，防止点卡片本身时误关闭 */}
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title} numberOfLines={1}>
            {`${data.char} · 多音字`}
          </Text>
          <Text style={styles.char} numberOfLines={1}>
            {data.char}
          </Text>
          <View style={styles.readingsRow}>
            {data.readings.map((reading, i) => (
              <React.Fragment key={reading}>
                {i > 0 ? <Text style={styles.readingDivider}>·</Text> : null}
                <Text
                  style={[
                    styles.reading,
                    reading === data.current ? styles.currentReading : null,
                    reading === data.current ? { color: accentColor } : null,
                  ]}
                  onPress={onSelectReading ? () => onSelectReading(reading) : undefined}
                >
                  {reading}
                </Text>
              </React.Fragment>
            ))}
          </View>
          {data.readingVerified === false ? (
            <Text style={styles.tongjiaSource} numberOfLines={2}>
              {'读音：系统默认·未校验'}
            </Text>
          ) : data.readingSources && data.readingSources.length > 0 ? (
            <Text style={styles.tongjiaSource} numberOfLines={3}>
              {`读音源：${data.readingSources.join(' · ')}`}
            </Text>
          ) : null}
          {data.overrideReading ? (
            <Text
              style={[styles.tongjiaSource, { color: accentColor }]}
              onPress={onResetReading}
            >
              {`已按你的纠正读作 ${data.overrideReading} · 点此恢复默认`}
            </Text>
          ) : onSelectReading ? (
            <Text style={styles.tongjiaSource}>
              点选读音纠正本句注音
            </Text>
          ) : null}
          {data.guyin ? (
            <View style={styles.guyinRow}>
              <View style={styles.guyinLine}>
                <Text style={styles.guyinLabel}>中古</Text>
                <Text style={styles.guyinValue} numberOfLines={1}>
                  {truncatePhonetic(data.guyin.mc)}
                </Text>
              </View>
              <View style={styles.guyinLine}>
                <Text style={styles.guyinLabel}>上古</Text>
                <Text style={styles.guyinValue} numberOfLines={1}>
                  {truncatePhonetic(data.guyin.oc)}
                </Text>
              </View>
              <Text style={styles.guyinAttribution}>{GUYIN_ATTRIBUTION}</Text>
            </View>
          ) : null}
          <Text style={styles.hint}>点击空白处关闭</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
});

// ---------- 通假字浮窗 ----------

/** 浮窗数据：字 + 本字 + 释义 + 出处 */
interface TongjiaPopupData {
  char: string;
  original: string;
  note: string;
  source?: string;
  /** 判定源列表（多源合并） */
  sources?: string[];
  /** 是否经 canon 校验 */
  verified?: boolean;
  /** 命中的语料例句（canon v3 用例级锚定） */
  context?: string;
}

interface TongjiaPopupProps {
  data: TongjiaPopupData;
  styles: PopupStyles;
  accentColor: string;
  onClose: () => void;
}

/**
 * 通假字浮窗：透明 Modal 居中小卡片，展示「借字 通 本字」+ 释义 + 出处。
 * 点击卡片外任意区域关闭。
 */
const TongjiaPopup = React.memo(function TongjiaPopup({
  data,
  styles,
  accentColor,
  onClose,
}: TongjiaPopupProps) {
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 内层可点区域拦截触摸，防止点卡片本身时误关闭 */}
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title} numberOfLines={1}>
            {`${data.char} · 通假字`}
          </Text>
          <View style={styles.tongjiaRow}>
            <Text style={styles.tongjiaChar} numberOfLines={1}>
              {data.char}
            </Text>
            <Text style={[styles.tongjiaArrow, { color: accentColor }]}>通</Text>
            <Text style={styles.tongjiaChar} numberOfLines={1}>
              {data.original}
            </Text>
          </View>
          <Text style={styles.tongjiaNote}>{data.note}</Text>
          {data.context ? (
            <Text style={styles.tongjiaSource} numberOfLines={3}>
              {`例：${data.context}`}
            </Text>
          ) : null}
          {data.sources && data.sources.length > 0 ? (
            <Text style={styles.tongjiaSource} numberOfLines={3}>
              {`判定源：${data.sources.join(' · ')}${data.verified === false ? '（未校验）' : ''}`}
            </Text>
          ) : data.source ? (
            <Text style={styles.tongjiaSource} numberOfLines={2}>
              {`出处：${data.source}`}
            </Text>
          ) : null}
          <Text style={styles.hint}>点击空白处关闭</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
});

// ---------- 主组件 ----------

export interface PinyinTextProps {
  /** 段落原文 */
  text: string;
  /** 外部注入的注音结果（缺省时组件内部自动注音） */
  annotations?: PinyinAnnotation[];
  /** 正文字号 */
  fontSize: number;
  /** 行距倍数 */
  lineHeight: number;
  /** 注音模式：off 时直接渲染纯文本 */
  pinyinMode: PinyinMode;
  /** 本段划线（可选，注音模式下叠加高亮背景） */
  highlights?: Highlight[];
  /**
   * 活动选区（段内码点区间 [start, end)，与划线偏移同一坐标系）。
   * 选区菜单打开期间传入：区间内字格叠加主色半透明背景作为视觉反馈，
   * 点按扩展后随 selection state 更新实时跟随；菜单关闭后传入 undefined 即消失。
   */
  selectionRange?: [number, number];
  /** 点击命中划线回调 */
  onPressHighlight?: (h: Highlight) => void;
  /** 长按汉字回调（参数为码点索引，供上层扩展选词） */
  onLongPressChar?: (index: number) => void;
  /**
   * 点按汉字回调（码点索引，供自由选区「点按扩展」；提供时优先于划线点击）。
   * 仅覆盖汉字格，非汉字 run（标点/空白）不响应点按扩展。
   */
  onPressChar?: (index: number) => void;
  /** 当前篇目 ID（Chapter.id），用于语境化通假/读音判定；缺省则降级 */
  workId?: string;
  /** 当前书籍 ID（Book.id），作为通配兜底层；缺省仅用 workId + 全局 '*' */
  bookId?: string;
  /**
   * 仅渲染 [start, end) 码点区间的字格（仿真翻页超高段落拆页用）。
   * 注音仍按全文计算（保住多音字语境判音），划线/长按索引保持全局码点基准，
   * 跨界的非汉字 run 会在边界处文本级切开，两块各渲染属于自己的部分。
   */
  charRange?: [number, number];
}

function PinyinTextBase({
  text,
  annotations,
  fontSize,
  lineHeight,
  pinyinMode,
  highlights,
  selectionRange,
  onPressHighlight,
  onLongPressChar,
  onPressChar,
  workId,
  bookId,
  charRange,
}: PinyinTextProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const conversionMode = useSettingsStore((s) => s.conversionMode);
  const colors: ThemeColors = getColors(theme);

  // 活动选区背景：主题主色叠 25% 透明度（随主题换色，引用稳定缓存）。
  // 只影响渲染样式层，不参与注音计算，不会触发 pinyinCache 失效。
  const selectionBg = useMemo(() => withAlpha(colors.primary, 0.25), [colors]);

  // 内部自动注音（外部传入 annotations 时优先生效）
  const { annotations: selfAnnotations, annotate } = usePinyin(text, pinyinMode, {
    workId,
    bookId,
  });
  const source = annotations ?? selfAnnotations;

  const pairs = useMemo(() => getPinyinPairs(source), [source]);

  // off 模式或注音结果与文本不对齐时，降级为纯文本渲染
  const chars = useMemo(() => Array.from(text), [text]);
  const usable = pinyinMode !== 'off' && pairs.length > 0 && pairs.length === chars.length;

  // 预计算渲染数组与样式（依赖变化时才重建，其余渲染直接复用）
  const pinyinSize = getPinyinSize(fontSize);
  const cells = useMemo(
    () => (usable ? buildCells(pairs, highlights) : []),
    [usable, pairs, highlights],
  );

  // 拆页过滤：仅保留 [start, end) 区间内的渲染单元，跨界的 run 按码点切开
  const visibleCells = useMemo(() => {
    if (!charRange) {
      return cells;
    }
    const [start, end] = charRange;
    const out: CellData[] = [];
    for (const c of cells) {
      if (c.kind === 'char') {
        if (c.index >= start && c.index < end) {
          out.push(c);
        }
      } else {
        const runLen = Array.from(c.text).length;
        const runEnd = c.index + runLen;
        if (runEnd <= start || c.index >= end) {
          continue;
        }
        const from = Math.max(0, start - c.index);
        const to = Math.min(runLen, end - c.index);
        const sliced = Array.from(c.text).slice(from, to).join('');
        if (sliced) {
          out.push({ ...c, text: sliced });
        }
      }
    }
    return out;
  }, [cells, charRange]);

  const styles = useMemo<CellStyles>(() => {
    const pinyinLineHeight = Math.round(pinyinSize * 1.35);
    const charLineHeight = Math.round(fontSize * 1.3);
    // flexWrap 行间距以 paddingBottom 模拟
    const rowGap = Math.max(2, Math.round(fontSize * (lineHeight - 1)));
    // 通假字「通」圆标边长与字号联动；悬浮于拼音行上方（独立一行，不占布局高度 → 不改变行基线）
    const markSize = Math.max(14, Math.round(pinyinSize * 1.15));
    const markFont = Math.max(8, Math.round(markSize * 0.6));
    // 水平字间距：全文注音模式加大，避免相邻拼音左右相贴/重叠；
    // 生僻字注音等其余模式取较小值，保持正文紧凑、阅读自然。
    const isFull = pinyinMode === 'full';
    const charGap = isFull
      ? Math.max(4, Math.round(fontSize * 0.16))
      : Math.max(2, Math.round(fontSize * 0.06));
    // 标点间距略小，避免中文标点两侧过于空旷
    const runGap = Math.max(1, Math.round(fontSize * 0.04));
    return {
      row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        // 通假字圆标悬浮于字格上方，需允许溢出渲染
        overflow: 'visible',
      },
      cell: {
        alignItems: 'center',
        paddingBottom: rowGap,
        // 水平字间距：使相邻字格（及其拼音）之间留出空隙，全文注音模式下更宽
        marginHorizontal: charGap,
        // 圆标悬浮在字格上方，需允许内容溢出边界渲染
        overflow: 'visible',
      },
      pinyin: {
        fontSize: pinyinSize,
        lineHeight: pinyinLineHeight,
        height: pinyinLineHeight,
        color: colors.pinyin,
        textAlign: 'center',
        includeFontPadding: false,
      },
      char: {
        fontSize,
        lineHeight: charLineHeight,
        color: colors.text,
        textAlign: 'center',
        includeFontPadding: false,
      },
      rareChar: {
        textDecorationLine: 'underline',
      },
      run: {
        paddingTop: pinyinLineHeight + PINYIN_LINE_GAP,
        paddingBottom: rowGap,
        marginHorizontal: runGap,
        fontSize,
        lineHeight: charLineHeight,
        color: colors.text,
        includeFontPadding: false,
      },
      // 通假字「通」标识：悬浮于拼音行上方的独立圆形描边小标，水平居中于汉字正上方
      // top=-(markSize)：底部紧贴拼音行顶部（仍在拼音上方，但尽量压低以减少与上一行的重叠）
      tongjiaMark: {
        position: 'absolute',
        top: -markSize,
        alignSelf: 'center',
        zIndex: 3,
        elevation: 3,
        width: markSize,
        height: markSize,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.background,
        borderRadius: markSize / 2,
        borderWidth: 1,
        borderColor: colors.accent,
      },
      // 字内居中：lineHeight = 字号（不额外加行高，否则 Android 把多出的行高加到字上方导致字面下沉偏下）；
      // includeFontPadding 保留 CJK 字面上下留白，配合容器 flex 双轴居中 → 字面落在正中央
      tongjiaMarkText: {
        fontSize: markFont,
        lineHeight: markFont,
        color: colors.accent,
        textAlign: 'center',
        textAlignVertical: 'center',
        includeFontPadding: true,
      },
    };
  }, [fontSize, lineHeight, pinyinSize, pinyinMode, colors]);

  // 浮窗状态（置于主组件层，弹窗开闭不触发 buildCells/styles 重建）
  const [polyphonePopup, setPolyphonePopup] = useState<PolyphonePopupData | null>(null);
  const [tongjiaPopup, setTongjiaPopup] = useState<TongjiaPopupData | null>(null);
  const closePolyphonePopup = useCallback(() => setPolyphonePopup(null), []);
  const closeTongjiaPopup = useCallback(() => setTongjiaPopup(null), []);

  // ---------- 用户读音纠正闭环 ----------
  // 订阅纠正列表（引用变化触发重渲染 + 重注音；纠正增删为低频操作）
  const overrides = useReadingOverrideStore((s) => s.overrides);
  const prevOverrideRef = useRef(overrides);
  useEffect(() => {
    // 跳过首挂载；纠正列表变化后清注音缓存并强制重算（useMemo 版本号 bump）
    if (prevOverrideRef.current === overrides) {
      return;
    }
    prevOverrideRef.current = overrides;
    clearPinyinCache();
    annotate();
  }, [overrides, annotate]);

  const handlePolyphonePress = useCallback((cell: CharCellData) => {
    const readings = getPolyphoneReadings(cell.char);
    if (readings.length === 0) {
      return;
    }
    // 语境判音结果不在候选表中时（如通假读音），补充为第一项以保证高亮可见
    const list = readings.includes(cell.pinyin) ? readings : [cell.pinyin, ...readings];
    // 古音拟音（Baxter-Sagart）：命中才附带，浮窗古音区块按需显示
    const guyin = GuyinService.getGuyin(cell.char) ?? undefined;
    // 用户已纠正的读音（按简体逻辑字 + 简体整句语境查询）
    const logicChar = toSimplified(cell.char);
    const context = toSimplified(text);
    const overrideReading =
      useReadingOverrideStore.getState().getOverride(logicChar, context) ?? undefined;
    setPolyphonePopup({
      char: cell.char,
      readings: list,
      current: cell.pinyin,
      readingSources: cell.readingSources,
      readingVerified: cell.readingVerified,
      guyin,
      overrideReading,
    });
  }, [text]);
  /** 点选候选读音：写入纠正（同 char+context 幂等覆盖）并触发重注音 */
  const handleSelectReading = useCallback(
    (reading: string) => {
      const logicChar = toSimplified(polyphonePopup?.char ?? '');
      if (!logicChar) {
        return;
      }
      useReadingOverrideStore
        .getState()
        .addOverride(logicChar, toSimplified(text), reading);
      // store 订阅 effect 会清缓存并重注音；此处立即关闭浮窗
      setPolyphonePopup(null);
    },
    [polyphonePopup, text],
  );
  /** 恢复系统默认：删除该字该句的读音纠正并触发重注音 */
  const handleResetReading = useCallback(() => {
    const logicChar = toSimplified(polyphonePopup?.char ?? '');
    if (!logicChar) {
      return;
    }
    const store = useReadingOverrideStore.getState();
    const entry = store.getOverrideEntry(logicChar, toSimplified(text));
    if (entry) {
      store.removeOverride(entry.id);
    }
    setPolyphonePopup(null);
  }, [polyphonePopup, text]);
  const handleTongjiaPress = useCallback((cell: CharCellData) => {
    if (!cell.tongjia) {
      return;
    }
    // 繁体显示时，把「通 X」目标字与释义也转繁体，保持与正文视觉一致
    // （canon 库按简体存储 original；char 已是正文原字符，无需转换）。
    const toTrad = (s: string) =>
      conversionMode === 'traditional'
        ? ConversionService.toTraditional(s).data ?? s
        : s;
    setTongjiaPopup({
      char: cell.char,
      original: toTrad(cell.tongjia.original),
      note: toTrad(cell.tongjia.note ?? ''),
      source: cell.tongjia.source,
      sources: cell.tongjia.sources,
      verified: cell.tongjia.verified,
      context: cell.tongjia.context
        ? toTrad(cell.tongjia.context)
        : undefined,
    });
  }, [conversionMode]);

  const popupStyles = useMemo<PopupStyles>(() => {
    return {
      backdrop: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.overlay,
      },
      card: {
        alignItems: 'center',
        minWidth: 180,
        maxWidth: 300,
        paddingHorizontal: 24,
        paddingTop: 16,
        paddingBottom: 14,
        borderRadius: 14,
        backgroundColor: colors.background,
        // iOS 阴影
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
        // Android 阴影
        elevation: 8,
      },
      title: {
        fontSize: 11,
        lineHeight: 15,
        color: colors.textSecondary,
        includeFontPadding: false,
      },
      char: {
        marginTop: 6,
        fontSize: Math.max(28, Math.round(fontSize * 1.6)),
        lineHeight: Math.max(38, Math.round(fontSize * 1.6) + 8),
        color: colors.text,
        fontWeight: '600',
        includeFontPadding: false,
      },
      readingsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 10,
      },
      reading: {
        fontSize: 16,
        lineHeight: 22,
        color: colors.text,
        includeFontPadding: false,
      },
      readingDivider: {
        fontSize: 16,
        lineHeight: 22,
        marginHorizontal: 8,
        color: colors.border,
        includeFontPadding: false,
      },
      currentReading: {
        fontWeight: '700',
        fontSize: 18,
      },
      tongjiaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 10,
      },
      tongjiaChar: {
        fontSize: Math.max(28, Math.round(fontSize * 1.6)),
        lineHeight: Math.max(38, Math.round(fontSize * 1.6) + 8),
        color: colors.text,
        fontWeight: '600',
        includeFontPadding: false,
      },
      tongjiaArrow: {
        fontSize: 16,
        lineHeight: 22,
        fontWeight: '700',
        marginHorizontal: 12,
        includeFontPadding: false,
      },
      tongjiaNote: {
        marginTop: 12,
        fontSize: 13,
        lineHeight: 19,
        color: colors.text,
        textAlign: 'center',
        includeFontPadding: false,
      },
      tongjiaSource: {
        marginTop: 6,
        fontSize: 11,
        lineHeight: 16,
        color: colors.textSecondary,
        textAlign: 'center',
        includeFontPadding: false,
      },
      // 古音区块：读音行下方的「中古/上古」两行 + tiny 署名（命中才渲染，不占位）
      guyinRow: {
        marginTop: 10,
        alignSelf: 'stretch',
      },
      guyinLine: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: 8,
      },
      guyinLabel: {
        fontSize: 11,
        lineHeight: 16,
        color: colors.textSecondary,
        includeFontPadding: false,
      },
      guyinValue: {
        flexShrink: 1,
        fontSize: 11,
        lineHeight: 16,
        color: colors.textSecondary,
        includeFontPadding: false,
      },
      guyinAttribution: {
        marginTop: 4,
        fontSize: 9,
        lineHeight: 12,
        color: colors.pinyin,
        textAlign: 'center',
        includeFontPadding: false,
      },
      hint: {
        marginTop: 12,
        fontSize: 10,
        lineHeight: 14,
        color: colors.pinyin,
        includeFontPadding: false,
      },
    };
  }, [fontSize, colors]);

  if (!usable) {
    // 降级纯文本：charRange 场景下按码点切片（拆页时每块只渲染自己的区间）
    const plainText = charRange
      ? Array.from(text)
          .slice(charRange[0], charRange[1])
          .join('')
      : text;
    return (
      <Text
        style={[
          stylesFallback.text,
          {
            fontSize,
            lineHeight: getLineHeightPx(fontSize, lineHeight),
            color: colors.text,
          },
        ]}
      >
        {plainText}
      </Text>
    );
  }

  return (
    <View style={styles.row}>
      {visibleCells.map((cell) =>
        cell.kind === 'char' ? (
          <CharCell
            key={`c${cell.index}`}
            cell={cell}
            styles={styles}
            accentColor={colors.accent}
            selectionBg={selectionBg}
            selected={
              selectionRange !== undefined &&
              cell.index >= selectionRange[0] &&
              cell.index < selectionRange[1]
            }
            onHighlightPress={onPressHighlight}
            onLongPressChar={onLongPressChar}
            onPressChar={onPressChar}
            onPressPinyin={handlePolyphonePress}
            onPressTongjia={handleTongjiaPress}
          />
        ) : (
          <RunCell key={`r${cell.index}`} cell={cell} styles={styles} />
        ),
      )}
      {polyphonePopup ? (
        <PolyphonePopup
          data={polyphonePopup}
          styles={popupStyles}
          accentColor={colors.accent}
          onClose={closePolyphonePopup}
          onSelectReading={handleSelectReading}
          onResetReading={handleResetReading}
        />
      ) : null}
      {tongjiaPopup ? (
        <TongjiaPopup
          data={tongjiaPopup}
          styles={popupStyles}
          accentColor={colors.accent}
          onClose={closeTongjiaPopup}
        />
      ) : null}
    </View>
  );
}

const stylesFallback = StyleSheet.create({
  text: {
    flex: 1,
  },
});

const PinyinText = React.memo(PinyinTextBase);
export default PinyinText;
