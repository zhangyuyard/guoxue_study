/**
 * 填空默写视图（FillBlankView）
 * 中文段落：按 density 比例随机遮盖汉字为「□」，用户逐格填写（填满即跳：
 * 候选字上屏后自动聚焦下一空格），提交时判分（同音字容错：无声调拼音相同即算对）。
 * 字母语言段落（无汉字且含拉丁字母）：按词遮盖，输入满词长自动跳格，
 * 判分按忽略大小写的整词匹配。支持实时进度、提示（粒度可选：整篇/逐段/逐句，
 * P1-07）、重置。
 *
 * 渲染性能设计（P1-7 修复）：
 * - 全量填写值不再以顶层单一 state 持有，而是下沉到各段落子组件
 *   （ParagraphBlanks）自己的 state；顶层仅以 ref 镜像（valuesRef /
 *   revealedRef）同步持有最新值，供判分、提示、进度统计同步读取。
 * - ParagraphBlanks 用 React.memo 包裹，props 均为稳定引用（段落格子
 *   来自 useMemo、回调来自 useCallback、colors 为模块级单例），因此
 *   某段敲键只重渲该段，其余段落与操作按钮全部跳过。
 * - 顶层因进度统计（filledCount）每键重渲时，仅 StatusBar 真正重渲。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { pinyin } from 'pinyin-pro';
import type { RecitationHintGranularity, TextSegment } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { buildSentenceGroups } from '@/utils/sentenceSplit';
import { getColors, getLineHeightPx } from '@/theme';
import type { ThemeColors } from '@/theme';

/** 判分结果统计 */
export interface FillBlankStats {
  /** 正确数（含提示揭示的格） */
  correct: number;
  /** 总空格数 */
  total: number;
  /** 错误明细：空格索引 / 正确答案 / 用户填写 */
  wrong: { index: number; expected: string; given: string }[];
}

export interface FillBlankViewProps {
  /** 待默写的段落列表 */
  segments: TextSegment[];
  /** 遮盖密度 0-1（如 0.25 / 0.5 / 0.75） */
  density: number;
  /**
   * 提示粒度（P1-07）：whole=逐格（默认，向后兼容）；
   * paragraph=逐段（一次揭示目标空格所在段全部未填空格）；
   * sentence=逐句（一次揭示目标空格所在句组全部未填空格）。
   */
  granularity?: RecitationHintGranularity;
  /** 提交完成回调 */
  onComplete: (stats: FillBlankStats) => void;
  /** 提示回调：参数为首个被揭示空格的索引 */
  onHint: (index: number) => void;
  /** 重置回调（重新随机遮盖） */
  onReset: () => void;
}

/** 单个字格数据 */
interface BlankChar {
  /** 全局唯一索引 */
  index: number;
  /** 原字 */
  char: string;
  /** 是否被遮盖（需要填写） */
  isBlank: boolean;
}

/** 段落渲染数据（保留段落边界） */
interface ParagraphData {
  chars: BlankChar[];
}

/** buildBlanks 产物：段落格子 + 遮盖模式 + 逐句空格分组 */
interface BlankBuildResult {
  paragraphs: ParagraphData[];
  /** 字母语言模式：按词遮盖、满词长跳格、忽略大小写判分 */
  wordMode: boolean;
  /** 逐句空格分组（全局空格索引数组，跨段落拼接，P1-07） */
  sentenceGroups: number[][];
}

/** 提示请求（顶层派发到目标段落子组件；seq 保证同一批格重复提示也能触发 effect） */
interface HintRequest {
  /** 本次揭示的空格集合（P1-07 粒度可能一次揭示多格，均落在同一段落内） */
  targets: { index: number; char: string }[];
  seq: number;
}

/** CJK 汉字（含扩展区）判断 */
function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2ebef)
  );
}

/** 单字无声调拼音（判分容错用） */
function pinyinOf(ch: string): string {
  if (!ch) {
    return '';
  }
  try {
    return pinyin(ch, { toneType: 'none', type: 'string' }).trim();
  } catch {
    return '';
  }
}

/** 同音判定：无声调拼音相同即视为同音 */
function isSameSound(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const pa = pinyinOf(a);
  const pb = pinyinOf(b);
  return pa.length > 0 && pa === pb;
}

/** 段落中是否存在 CJK 汉字 */
function containsCJK(text: string): boolean {
  return Array.from(text).some(isCJKChar);
}

/** 英文单词：字母/数字串（允许内部撇号/连字符，如 don't / well-known） */
const WORD_TOKEN_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/** 词级判分：忽略大小写整词匹配 */
function isWordMatch(given: string, expected: string): boolean {
  const a = given.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  return a.length > 0 && a === b;
}

/** 按密度生成遮盖数据（保证至少遮盖一个单元：中文为字、字母语言为词） */
function buildBlanks(segments: TextSegment[], density: number): BlankBuildResult {
  const allText = segments.map((s) => s.text).join('');
  // 字母语言模式：全篇无汉字且含拉丁字母 → 按词遮盖（RTL 本期不支持，暂不涉及）
  const wordMode = !containsCJK(allText) && /[A-Za-z]/.test(allText);
  let index = 0;
  let blankCount = 0;

  const paragraphs: ParagraphData[] = wordMode
    ? segments.map((seg) => {
        const chars: BlankChar[] = [];
        const pushPlain = (s: string): void => {
          for (const ch of Array.from(s)) {
            chars.push({ index: index++, char: ch, isBlank: false });
          }
        };
        const re = new RegExp(WORD_TOKEN_RE.source, 'g');
        let m: RegExpExecArray | null;
        let last = 0;
        while ((m = re.exec(seg.text)) !== null) {
          pushPlain(seg.text.slice(last, m.index));
          const isBlank = Math.random() < density;
          if (isBlank) {
            blankCount += 1;
          }
          chars.push({ index: index++, char: m[0], isBlank });
          last = m.index + m[0].length;
        }
        pushPlain(seg.text.slice(last));
        return { chars };
      })
    : segments.map((seg) => {
        const chars = Array.from(seg.text).map((ch) => {
          const isBlank = isCJKChar(ch) && Math.random() < density;
          if (isBlank) {
            blankCount += 1;
          }
          return { index: index++, char: ch, isBlank };
        });
        return { chars };
      });

  // 密度过小或无可遮盖单元时，兜底随机遮盖一个（中文取首个汉字 / 英文取首个单词）
  if (blankCount === 0) {
    for (const paragraph of paragraphs) {
      for (const c of paragraph.chars) {
        const eligible = wordMode ? /[A-Za-z0-9]/.test(c.char) : isCJKChar(c.char);
        if (eligible) {
          c.isBlank = true;
          blankCount += 1;
          break;
        }
      }
      if (blankCount > 0) {
        break;
      }
    }
  }
  // 逐句空格分组（P1-07）：按句末标点切分句组，引号内标点不切断
  // （口径见 src/utils/sentenceSplit.ts）；空组（句内无空格）不保留
  const sentenceGroups: number[][] = [];
  for (const paragraph of paragraphs) {
    for (const group of buildSentenceGroups(paragraph.chars)) {
      sentenceGroups.push(group);
    }
  }
  return { paragraphs, wordMode, sentenceGroups };
}

/** 实时进度条（memo 化：filledCount 不变时跳过重渲） */
const StatusBar = memo(function StatusBar({
  filled,
  total,
  density,
  colors,
}: {
  filled: number;
  total: number;
  density: number;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.statusRow}>
      <Text style={[styles.statusText, { color: colors.textSecondary }]}>
        已填 {filled} / {total}
      </Text>
      <Text style={[styles.statusText, { color: colors.pinyin }]}>
        遮盖密度 {Math.round(density * 100)}%
      </Text>
    </View>
  );
});

/** 操作按钮区（memo 化：回调稳定时跳过重渲） */
const ActionsBar = memo(function ActionsBar({
  colors,
  onReset,
  onHint,
  onSubmit,
}: {
  colors: ThemeColors;
  onReset: () => void;
  onHint: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.actions, { borderTopColor: colors.border }]}>
      <Text
        style={[styles.actionBtn, styles.resetBtn, { color: colors.textSecondary, borderColor: colors.border }]}
        onPress={onReset}
      >
        重置
      </Text>
      <Text
        style={[styles.actionBtn, styles.hintBtn, { color: colors.primary, borderColor: colors.primary }]}
        onPress={onHint}
      >
        提示
      </Text>
      <Text
        style={[styles.actionBtn, styles.submitBtn, { backgroundColor: colors.primary }]}
        onPress={onSubmit}
      >
        提交
      </Text>
    </View>
  );
});

/** 段落子组件 props：全部为稳定引用（保证 memo 生效） */
interface ParagraphBlanksProps {
  /** 该段的字格数据（来自顶层 useMemo，重置前引用不变） */
  chars: BlankChar[];
  fontSize: number;
  lineHeight: number;
  cellSize: number;
  /** 模块级单例主题色（getColors 返回 lightColors/darkColors 单例） */
  colors: ThemeColors;
  /** 各空格容量表（全局共享，顶层 useMemo 稳定引用） */
  capacityOf: Map<number, number>;
  /** 登记输入框引用（顶层 useCallback 稳定引用） */
  registerInput: (index: number, ref: TextInput | null) => void;
  /**
   * 输入变更：由顶层统一做 IME 组合态处理与值规范化（含填满即跳），
   * 返回规范化后的最终值；子组件用该返回值更新本段 state。
   */
  onChange: (index: number, text: string) => string;
  /** 顶层派发的提示请求（仅目标段落响应） */
  hintRequest: HintRequest | null;
}

/**
 * 单段落填空格子组件。
 * 本段的 values / revealed / focused state 全部下沉到这里：
 * 某一格敲键只重渲本段，其它段落与顶层（进度条/按钮区）不受影响。
 */
const ParagraphBlanks = memo(function ParagraphBlanks({
  chars,
  fontSize,
  lineHeight,
  cellSize,
  colors,
  capacityOf,
  registerInput,
  onChange,
  hintRequest,
}: ParagraphBlanksProps): React.JSX.Element {
  /** 本段各格填写值：blankIndex -> 输入文本 */
  const [values, setValues] = useState<Record<number, string>>({});
  /** 本段已揭示的格（提示后自动填入答案） */
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  /** 本段当前聚焦空格索引（高亮提示按钮目标） */
  const [focused, setFocused] = useState<number | null>(null);

  // 响应顶层派发的提示请求：仅当目标格属于本段时，把答案写入本段 state。
  // P1-07 粒度揭示（逐段/逐句）一次可能带来多格，但都落在同一段落内；
  // 设置为幂等操作，StrictMode 下 effect 双跑不会产生副作用累积。
  useEffect(() => {
    if (!hintRequest) {
      return;
    }
    const indexSet = new Set(chars.map((c) => c.index));
    const hits = hintRequest.targets.filter((t) => indexSet.has(t.index));
    if (hits.length === 0) {
      return;
    }
    setValues((prev) => {
      const next = { ...prev };
      for (const h of hits) {
        next[h.index] = h.char;
      }
      return next;
    });
    setRevealed((prev) => {
      const next = { ...prev };
      for (const h of hits) {
        next[h.index] = true;
      }
      return next;
    });
  }, [hintRequest, chars]);

  // 输入：委托顶层规范化（返回最终值）后写入本段 state。
  // onChange 为顶层 useCallback 稳定引用，不会破坏 memo。
  const handleLocalChange = useCallback(
    (index: number, text: string) => {
      const next = onChange(index, text);
      setValues((prev) => ({ ...prev, [index]: next }));
    },
    [onChange],
  );

  const handleFocus = useCallback((index: number) => {
    setFocused(index);
  }, []);

  const handleBlur = useCallback(() => {
    setFocused(null);
  }, []);

  return (
    <View style={[styles.paragraph, { marginBottom: 14 }]}>
      {chars.map((c) => {
        if (!c.isBlank) {
          return (
            <Text
              key={c.index}
              style={[
                styles.plainChar,
                { fontSize, color: colors.text, lineHeight },
              ]}
            >
              {c.char}
            </Text>
          );
        }
        const value = values[c.index] ?? '';
        const isRevealed = revealed[c.index];
        const isFocused = focused === c.index;
        // 该空格容量（中文为 1 个汉字，词级模式为整个单词的字母数）；
        // maxLength 留出组合输入缓冲：Android 拼音 IME 的组合态拼音也
        // 计入 maxLength，若等于容量会在敲拼音时被原生截断、导致无法上屏
        const capacity = capacityOf.get(c.index) ?? 1;
        // 词级空格按字母数加宽（约 0.62em/字母 + 内边距），保证单词完整可见
        const cellWidth =
          capacity > 1
            ? Math.max(cellSize, Math.round(capacity * fontSize * 0.62) + 10)
            : cellSize;
        return (
          <View
            key={c.index}
            style={[
              styles.cell,
              {
                width: cellWidth,
                height: cellSize,
                borderColor: isFocused ? colors.primary : colors.border,
                backgroundColor: isRevealed ? colors.primarySoft : colors.inputBackground,
              },
            ]}
          >
            <TextInput
              ref={(r) => {
                registerInput(c.index, r);
              }}
              style={[
                styles.input,
                { color: colors.text, fontSize },
              ]}
              value={value}
              maxLength={Math.max(capacity, 8)}
              editable={!isRevealed}
              onChangeText={(text) => handleLocalChange(c.index, text)}
              onFocus={() => handleFocus(c.index)}
              onBlur={handleBlur}
              placeholder="□"
              placeholderTextColor={colors.pinyin}
              autoCorrect={false}
              accessibilityLabel={`第 ${c.index + 1} 个空格`}
            />
          </View>
        );
      })}
    </View>
  );
});

function FillBlankViewInner({
  segments,
  density,
  granularity = 'whole',
  onComplete,
  onHint,
  onReset,
}: FillBlankViewProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const fontSize = useSettingsStore((s) => s.fontSize);

  /** 重生成触发器（重置时 +1；同时作为段落 key 的一部分强制子组件重挂载清空状态） */
  const [generation, setGeneration] = useState(0);
  /** 已填写/已揭示的空格数（顶层唯一随输入变化的 state，仅驱动 StatusBar） */
  const [filledCount, setFilledCount] = useState(0);
  /** 提示请求（派发到目标段落子组件） */
  const [hintRequest, setHintRequest] = useState<HintRequest | null>(null);
  const hintSeqRef = useRef(0);

  /**
   * 全量填写值镜像（blankIndex -> 文本）：判分/提示/进度的同步数据源。
   * 每次输入在 handleChange 内同步更新，避免 setState 异步导致的状态过期；
   * 子组件持有的分段 state 仅用于渲染，二者写入同一份规范化结果，保持一致。
   */
  const valuesRef = useRef<Record<number, string>>({});
  /** 已揭示格镜像（提示判分用） */
  const revealedRef = useRef<Record<number, boolean>>({});
  /** 各空格输入框引用（blankIndex -> TextInput），用于填满即跳 */
  const inputRefs = useRef<Record<number, TextInput | null>>({});

  const registerInput = useCallback((index: number, ref: TextInput | null) => {
    inputRefs.current[index] = ref;
  }, []);

  const { paragraphs, wordMode, sentenceGroups } = useMemo(
    () => buildBlanks(segments, density),
    // 依赖数组有意收窄（generation 变更触发重出题；grain 相关经派发承载），勿机械补全
    [segments, density, generation],
  );

  /** 逐段空格分组（全局空格索引数组，按段落顺序，P1-07 粒度揭示用） */
  const paragraphGroups = useMemo(
    () => paragraphs.map((p) => p.chars.filter((c) => c.isBlank).map((c) => c.index)),
    [paragraphs],
  );

  /** 全部空格（扁平，供判分/统计） */
  const allBlanks = useMemo(
    () => paragraphs.flatMap((p) => p.chars).filter((c) => c.isBlank),
    [paragraphs],
  );

  /**
   * 各空格容量（期望答案的字符数，按 Unicode 码点计数）。
   * 中文按单字遮盖，容量恒为 1；词级模式为整词字母数。maxLength 依据它
   * 动态设置（只泄露长度，原文排版本身可见长度，无泄题问题）。
   */
  const capacityOf = useMemo(() => {
    const map = new Map<number, number>();
    for (const b of allBlanks) {
      map.set(b.index, Array.from(b.char).length);
    }
    return map;
  }, [allBlanks]);

  /** 依据镜像重算已填数并同步到进度 state（值不变时 React 自动跳过重渲） */
  const syncFilledCount = useCallback(() => {
    let n = 0;
    for (const b of allBlanks) {
      if (
        revealedRef.current[b.index] ||
        Boolean((valuesRef.current[b.index] ?? '').trim())
      ) {
        n += 1;
      }
    }
    setFilledCount(n);
  }, [allBlanks]);

  /** 跳到下一个空格；已是最后一个则收起键盘 */
  const focusNextBlank = useCallback(
    (index: number) => {
      const pos = allBlanks.findIndex((b) => b.index === index);
      if (pos === -1) {
        return;
      }
      const next = allBlanks[pos + 1];
      if (next) {
        inputRefs.current[next.index]?.focus();
      } else {
        // 最后一个空格：blur 当前框收起键盘（不自动提交，保持用户手动点「提交」）
        inputRefs.current[index]?.blur();
      }
    },
    [allBlanks],
  );

  /**
   * 填写输入：剔除空白字符；「填满即跳」——候选字上屏后截取并跳到下一空格。
   * 返回规范化后的最终值，由目标段落子组件写入其本地 state。
   *
   * 中文 IME 组合输入（composition）策略：
   * Android 拼音键盘敲拼音时，onChangeText 会被组合态文本（纯 ASCII 拼音
   * 字母）回调，此时【不截断、不跳格】，原样暂存，否则会截断拼音、提前误跳。
   * 判定"候选字已上屏"的条件是：文本以非 ASCII 字符结尾（拼音是 ASCII，
   * 永远不会触发）。满足时剥离 ASCII 拼音、取末尾 capacity 个字符存入并
   * 跳格。取「末尾」是为兼容部分输入法上屏时把拼音与汉字拼接回调（如
   * "ni你"）的情况；粘贴多字中文文本同样走此分支（含空格粘贴先被清洗），
   * 只保留最后一字并跳一次。
   *
   * 已填格上继续敲拼音（如已存 "你" 再敲 "ha"，回调 "你ha"）：以 ASCII
   * 结尾，视为组合态进行中，原样暂存不截断，待候选字上屏后统一截取跳格。
   *
   * 注意：中文 IME 的空格键用于上屏候选字，不会产生空格字符事件，因此
   * 不依赖空格检测跳格（上一版缺陷）。
   */
  const handleChange = useCallback(
    (index: number, text: string): string => {
      // 空白不计入答案：与判分处 trim 行为一致，这里直接从存储值中剔除
      const cleaned = text.replace(/\s+/g, '');
      const capacity = capacityOf.get(index) ?? 1;

      // 词级模式（字母语言）：无 IME 组合态问题，逐字母输入，
      // 填满词长自动截取并跳格（判分忽略大小写，无需预处理）
      if (wordMode) {
        const next = cleaned.slice(0, capacity);
        const prev = valuesRef.current[index] ?? '';
        valuesRef.current = { ...valuesRef.current, [index]: next };
        syncFilledCount();
        if (next.length >= capacity && prev !== next) {
          focusNextBlank(index);
        }
        return next;
      }

      // 候选字已上屏：文本以非 ASCII 字符结尾（拼音字母是 ASCII，不会误判）
      const isCommitted = /[^\x00-\x7f]$/.test(cleaned);

      if (isCommitted) {
        // 剥离 ASCII 拼音后按 Unicode 码点取末尾 capacity 个字符
        // （避免切断增补平面汉字）
        const committed = Array.from(cleaned.replace(/[\x00-\x7f]/g, ''))
          .slice(-capacity)
          .join('');
        // 上一份已存值中已上屏的部分（从同步镜像读取，避免 setState 异步）
        const prevCommitted = (valuesRef.current[index] ?? '').replace(
          /[\x00-\x7f]/g,
          '',
        );
        valuesRef.current = { ...valuesRef.current, [index]: committed };
        syncFilledCount();
        // 仅在已上屏内容发生变化（新填入/替换）时跳格；
        // 值未变化则跳过，防止受控值同步引发的重复事件造成连跳
        if (prevCommitted !== committed) {
          focusNextBlank(index);
        }
        return committed;
      }

      // 组合态进行中（纯拼音，或已填格上继续敲拼音）：原样暂存，
      // 不截断、不跳格，避免破坏 IME 组合输入
      valuesRef.current = { ...valuesRef.current, [index]: cleaned };
      syncFilledCount();
      return cleaned;
    },
    [capacityOf, focusNextBlank, wordMode, syncFilledCount],
  );

  /**
   * 提示：揭示目标空格并按粒度扩展范围（P1-07）：
   * - whole：仅揭示首个未填空格（默认，向后兼容）；
   * - paragraph：揭示目标空格所在段的全部未填空格；
   * - sentence：揭示目标空格所在句组的全部未填空格。
   * 镜像同步更新 + 派发到目标段落（粒度揭示的多格恒落在同一段落内，
   * 单次 hintRequest 即可承载）；判分逻辑零改动（揭示格按原规则判对）。
   */
  const handleHintPress = useCallback(() => {
    const target = allBlanks.find(
      (b) =>
        !revealedRef.current[b.index] &&
        !(valuesRef.current[b.index] ?? '').trim(),
    );
    if (!target) {
      Alert.alert('提示', '所有空格都已填写完成，无需提示。');
      return;
    }
    // 依粒度确定本次揭示范围：找不到所属组（理论不可达）时退化为单格揭示
    let scope: number[] | undefined;
    if (granularity === 'paragraph') {
      scope = paragraphGroups.find((g) => g.includes(target.index));
    } else if (granularity === 'sentence') {
      scope = sentenceGroups.find((g) => g.includes(target.index));
    }
    const indices = scope ?? [target.index];
    const charByIdx = new Map(allBlanks.map((b) => [b.index, b.char]));
    const targets = indices
      .filter(
        (i) => !revealedRef.current[i] && !(valuesRef.current[i] ?? '').trim(),
      )
      .map((i) => ({ index: i, char: charByIdx.get(i) ?? '' }));
    for (const t of targets) {
      valuesRef.current = { ...valuesRef.current, [t.index]: t.char };
      revealedRef.current = { ...revealedRef.current, [t.index]: true };
    }
    // seq 自增：同一批格被再次提示时也能触发子组件 effect（引用不同）
    hintSeqRef.current += 1;
    setHintRequest({ targets, seq: hintSeqRef.current });
    syncFilledCount();
    onHint(target.index);
  }, [allBlanks, granularity, paragraphGroups, sentenceGroups, syncFilledCount, onHint]);

  /** 提交判分（读取镜像，与子组件 state 保持一致） */
  const handleSubmit = useCallback(() => {
    Keyboard.dismiss();
    const total = allBlanks.length;
    if (total === 0) {
      onComplete({ correct: 0, total: 0, wrong: [] });
      return;
    }
    let correct = 0;
    const wrong: FillBlankStats['wrong'] = [];
    for (const b of allBlanks) {
      const given = (valuesRef.current[b.index] ?? '').trim();
      const ok =
        revealedRef.current[b.index] ||
        (wordMode ? isWordMatch(given, b.char) : isSameSound(given, b.char));
      if (ok) {
        correct += 1;
      } else {
        wrong.push({ index: b.index, expected: b.char, given });
      }
    }
    onComplete({ correct, total, wrong });
  }, [allBlanks, onComplete, wordMode]);

  /** 重置：重新随机遮盖并清空输入（镜像清空 + 段落 key 变化强制重挂载子组件） */
  const handleReset = useCallback(() => {
    Keyboard.dismiss();
    valuesRef.current = {};
    revealedRef.current = {};
    setHintRequest(null);
    setFilledCount(0);
    setGeneration((g) => g + 1);
    onReset();
  }, [onReset]);

  const lineHeight = getLineHeightPx(fontSize, 1.5);
  const cellSize = fontSize + 8;

  return (
    <View style={styles.container}>
      {/* 实时进度（memo 化，仅 filledCount 变化时重渲） */}
      <StatusBar
        filled={filledCount}
        total={allBlanks.length}
        density={density}
        colors={colors}
      />

      {/* 正文填空区：每段一个 memo 化子组件；重置时 key 变化强制重挂载清空本段状态 */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {paragraphs.map((paragraph, pIdx) => (
          <ParagraphBlanks
            key={`${generation}-${pIdx}`}
            chars={paragraph.chars}
            fontSize={fontSize}
            lineHeight={lineHeight}
            cellSize={cellSize}
            colors={colors}
            capacityOf={capacityOf}
            registerInput={registerInput}
            onChange={handleChange}
            hintRequest={hintRequest}
          />
        ))}
      </ScrollView>

      {/* 操作按钮区（memo 化，回调稳定时跳过重渲） */}
      <ActionsBar
        colors={colors}
        onReset={handleReset}
        onHint={handleHintPress}
        onSubmit={handleSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  statusText: {
    fontSize: 12,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  paragraph: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  plainChar: {
    marginRight: 1,
  },
  cell: {
    borderWidth: 1,
    borderRadius: 4,
    marginRight: 3,
    marginBottom: 4,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  input: {
    width: '100%',
    height: '100%',
    textAlign: 'center',
    padding: 0,
    margin: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    textAlign: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    fontWeight: '600',
    overflow: 'hidden',
  },
  resetBtn: {
    backgroundColor: 'transparent',
  },
  hintBtn: {
    backgroundColor: 'transparent',
  },
  submitBtn: {
    color: '#FFFFFF',
    borderColor: 'transparent',
  },
});

/** 填空默写视图 */
export const FillBlankView = memo(FillBlankViewInner);

export default FillBlankView;
