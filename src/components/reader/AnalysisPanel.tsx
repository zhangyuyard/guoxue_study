/**
 * 字词解析面板（AnalysisPanel）
 * 底部半屏弹层：展示选中字词的解析结果。
 * - 单字：优先 DictEngine.lookup（各启用字典，含来源标签与义项），
 *   内置 DictionaryService 字义 / 部首 / 笔画 / 异体字 / 古音为补充；
 *   「在字典中查看」跳转 DictLookupScreen（RootStack 级路由，返回不丢阅读位置）
 * - 词语：词义 / 出处原文 / 用法说明 / 例句（DictionaryService）
 * - 多字：按「实际选中全串」精确查词库（不再固定 4 字前缀上限，长度以选中
 *   内容为准）；全串未收录时改为「逐字解析摘要列表」纵向排列，让用户看到
 *   选区内每个字的解析（替代旧版「仅回退首字」）；选区超长时截断展示并提示
 * 实现说明：@gorhom/bottom-sheet 依赖 BottomSheetModalProvider 与原生手势环境，
 * App 壳尚未集成（T05 集成导航时统一接入），此处按约定采用 Modal 兜底实现。
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { Bookmark, CharAnalysis, WordAnalysis } from '@/types';
import type { DictSense } from '@/types/dict';

import { DictEngine } from '@/services/dict/DictEngine';
import { DictionaryService } from '@/services/DictionaryService';
import { GuyinService, GUYIN_ATTRIBUTION, type GuyinEntry } from '@/services/GuyinService';
import { genId, nowISO } from '@/services/StorageService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';

/** 逐字解析摘要的展示上限：选区超过该字数时截断展示并提示 */
const ANALYSIS_MAX_SHOWN_CHARS = 12;

/** 字典命中信息（单字解析时优先展示） */
interface DictHitInfo {
  dictName: string;
  /** 首个命中字典的义项摘要（structured 取前两条，其余去 HTML 标签截断） */
  def: string;
  pinyin?: string;
}

/** 逐字解析摘要（多字未收录时的单字条目） */
interface CharSummaryItem {
  char: string;
  pinyin: string;
  meaning: string;
}

/** 面板内部解析状态 */
interface AnalysisState {
  loading: boolean;
  /** 是否单字视图 */
  isChar: boolean;
  /** 展示的目标字/词（实际选中内容） */
  displayText: string;
  /** 「在字典中查看」的目标词头（词条命中=全串；逐字回退=首字；单字=该字） */
  dictHeadword: string;
  char?: CharAnalysis;
  word?: WordAnalysis;
  /** 字典域命中（DictEngine.lookup 首个收录字典） */
  dictInfo?: DictHitInfo;
  /** 多字全串未收录：逐字解析摘要列表（纵向排列） */
  charSummaries?: CharSummaryItem[];
  /** 选区超长被截断展示 */
  truncated?: boolean;
  /** 截断时的选区总字数 */
  totalChars?: number;
  /** 完全未收录 */
  notFound?: boolean;
  /** 古音拟音（Baxter-Sagart 命中时填写，中古/上古两行按需展示） */
  guyin?: GuyinEntry;
}

const INITIAL_STATE: AnalysisState = {
  loading: false,
  isChar: false,
  displayText: '',
  dictHeadword: '',
};

/** 提取字典条目的义项摘要 */
function extractDictDef(content: string, contentType: string): string {
  if (contentType === 'structured') {
    try {
      const senses = JSON.parse(content) as DictSense[];
      if (Array.isArray(senses) && senses.length > 0) {
        return senses
          .slice(0, 2)
          .map((s) => s.def)
          .join('；');
      }
    } catch {
      return '';
    }
    return '';
  }
  return content
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 单字查询字典域（引擎未就绪或未命中返回 null） */
function lookupDict(char: string): DictHitInfo | null {
  if (!DictEngine.isReady()) {
    return null;
  }
  try {
    const res = DictEngine.lookup(char);
    if (!res.success || !res.data) {
      return null;
    }
    const hit = res.data.results.find((r) => r.entry !== null);
    if (!hit || !hit.entry) {
      return null;
    }
    const def = extractDictDef(hit.entry.content, hit.entry.contentType);
    if (!def) {
      return null;
    }
    return { dictName: hit.dict.name, def, pinyin: hit.entry.pinyin };
  } catch {
    return null;
  }
}

/** 单字解析摘要（逐字回退用）：内置数据优先，字典域释义兜底 */
function summarizeChar(ch: string): CharSummaryItem {
  const res = DictionaryService.lookupCharacter(ch);
  const dictInfo = lookupDict(ch);
  return {
    char: ch,
    pinyin:
      res.success && res.data?.pinyin
        ? res.data.pinyin
        : dictInfo?.pinyin ?? '',
    meaning:
      res.success && res.data?.meaning
        ? res.data.meaning
        : dictInfo?.def ?? '',
  };
}

/** 同步解析（供延迟调用，保证 loading 状态可见且不阻塞首帧） */
function analyze(text: string): AnalysisState {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);

  if (chars.length === 0) {
    return { ...INITIAL_STATE, notFound: true };
  }

  if (chars.length === 1) {
    // 古音拟音（Baxter-Sagart）：命中才展示，未命中不占位
    const guyin = GuyinService.getGuyin(chars[0]) ?? undefined;
    // 单字：字典域优先（各启用字典，含归一化/异体字扩展命中）
    const dictInfo = lookupDict(chars[0]) ?? undefined;
    const res = DictionaryService.lookupCharacter(chars[0]);
    if (res.success && res.data) {
      return {
        loading: false,
        isChar: true,
        displayText: chars[0],
        dictHeadword: chars[0],
        char: res.data,
        dictInfo,
        guyin,
      };
    }
    if (dictInfo) {
      // 字典收录但内置数据未收录：仅展示字典释义
      return {
        loading: false,
        isChar: true,
        displayText: chars[0],
        dictHeadword: chars[0],
        dictInfo,
        guyin,
      };
    }
    return {
      loading: false,
      isChar: true,
      displayText: chars[0],
      dictHeadword: chars[0],
      notFound: true,
      guyin,
    };
  }

  // 多字：按实际选中全串精确查词库（长度以选中内容为准，不再固定 4 字前缀）
  const exact = DictionaryService.lookupWordExact(trimmed);
  if (exact.success && exact.data) {
    return {
      loading: false,
      isChar: false,
      displayText: trimmed,
      dictHeadword: trimmed,
      word: exact.data,
    };
  }

  // 全串未收录：逐字解析摘要列表（每个字一条，纵向排列）。
  // 选区超长时截断展示前若干字并提示，避免面板被撑爆。
  const truncated = chars.length > ANALYSIS_MAX_SHOWN_CHARS;
  const shown = truncated ? chars.slice(0, ANALYSIS_MAX_SHOWN_CHARS) : chars;
  const summaries = shown.map(summarizeChar);
  // 所有字均无任何解析信息时按未收录的空状态处理
  const allEmpty = summaries.every((s) => !s.pinyin && !s.meaning);
  if (allEmpty) {
    return {
      loading: false,
      isChar: false,
      displayText: trimmed,
      dictHeadword: chars[0],
      notFound: true,
    };
  }
  return {
    loading: false,
    isChar: false,
    displayText: trimmed,
    // 全串未收录时「在字典中查看」跳首字，保持既有单字查询能力
    dictHeadword: chars[0],
    charSummaries: summaries,
    truncated,
    totalChars: chars.length,
  };
}

/** 信息行：标签 + 内容 */
function FieldRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

export interface AnalysisPanelProps {
  /** 是否可见 */
  visible: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 待解析的选中字词 */
  text: string;
  /** 收藏解析回调（Bookmark 的书籍/章节上下文由使用方补充） */
  onBookmark?: (bookmark: Bookmark) => void;
}

function AnalysisPanel({ visible, onClose, text, onBookmark }: AnalysisPanelProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors: ThemeColors = getColors(theme);
  // 「在字典中查看」跳转 DictLookupScreen（RootStack 级注册，返回不丢阅读位置）
  const navigation = useNavigation() as unknown as {
    navigate: (name: string, params?: object) => void;
  };

  const [state, setState] = useState<AnalysisState>(INITIAL_STATE);

  // 打开/切换选词时重新解析（延迟一帧执行，展示加载状态且不阻塞动画）
  useEffect(() => {
    if (!visible || !text) {
      setState(INITIAL_STATE);
      return;
    }
    setState({ ...INITIAL_STATE, loading: true });
    const timer = setTimeout(() => {
      setState(analyze(text));
    }, 120);
    return () => clearTimeout(timer);
  }, [visible, text]);

  const handleBookmark = (): void => {
    if (!state.displayText) {
      return;
    }
    const bookmark: Bookmark = {
      id: genId('bookmark'),
      type: 'paragraph',
      text: state.displayText,
      tags: ['解析'],
      createdAt: nowISO(),
    };
    onBookmark?.(bookmark);
  };

  const handleOpenInDict = (): void => {
    // 词条命中跳全串；逐字回退/未收录时跳首字（保持既有单字查询能力）
    const headword = state.dictHeadword || state.displayText;
    if (!headword) {
      return;
    }
    onClose();
    navigation.navigate('DictLookup', { headword });
  };

  const hasResult = Boolean(
    state.char || state.word || state.dictInfo || (state.charSummaries && state.charSummaries.length > 0),
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.panel, { backgroundColor: colors.background }]}
          onPress={() => undefined}
        >
          {/* 顶部：把手 + 标题 + 关闭 */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                {state.displayText || text || '字词解析'}
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="关闭解析面板"
              >
                <Text style={[styles.closeButton, { color: colors.textSecondary }]}>关闭</Text>
              </Pressable>
            </View>
          </View>

          {/* 内容区 */}
          {state.loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.hint, { color: colors.textSecondary }]}>正在解析…</Text>
            </View>
          ) : state.notFound || !hasResult ? (
            <View style={styles.centerBox}>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                「{text.trim()}」暂未收录解析
              </Text>
              <Text style={[styles.hintSmall, { color: colors.pinyin }]}>
                可尝试选中其他字词
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
              {/* 多字全串未收录：逐字解析摘要列表（每个字一条，纵向排列） */}
              {state.charSummaries ? (
                <View>
                  {state.charSummaries.map((item, i) => (
                    <View
                      key={`${item.char}-${i}`}
                      style={[styles.summaryItem, { borderBottomColor: colors.border }]}
                    >
                      <Text style={[styles.summaryChar, { color: colors.primary }]}>
                        {item.char}
                      </Text>
                      <View style={styles.summaryBody}>
                        <Text style={[styles.summaryPinyin, { color: colors.pinyin }]}>
                          {item.pinyin || '—'}
                        </Text>
                        <Text style={[styles.summaryMeaning, { color: colors.text }]}>
                          {item.meaning || '暂未收录该字释义'}
                        </Text>
                      </View>
                    </View>
                  ))}
                  {state.truncated ? (
                    <Text style={[styles.fallbackTip, { color: colors.pinyin }]}>
                      {`选区较长，仅展示前 ${ANALYSIS_MAX_SHOWN_CHARS} 字（共 ${state.totalChars ?? 0} 字）`}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* 字典域释义（来源标签 + 义项摘要） */}
              {state.dictInfo ? (
                <View style={[styles.dictSection, { borderColor: colors.primary }]}>
                  <Text style={[styles.dictSectionLabel, { color: colors.primary }]}>
                    {`字典释义 · 来源：${state.dictInfo.dictName}`}
                  </Text>
                  {state.dictInfo.pinyin ? (
                    <Text style={[styles.dictSectionPinyin, { color: colors.pinyin }]}>
                      {state.dictInfo.pinyin}
                    </Text>
                  ) : null}
                  <Text style={[styles.dictSectionDef, { color: colors.text }]}>
                    {state.dictInfo.def}
                  </Text>
                  <Pressable
                    onPress={handleOpenInDict}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="在字典中查看"
                  >
                    <Text style={[styles.dictSectionLink, { color: colors.primary }]}>
                      在字典中查看 →
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {state.isChar && state.char ? (
                <>
                  <FieldRow label="拼音" value={state.char.pinyin || '—'} colors={colors} />
                  <FieldRow label="字义" value={state.char.meaning || '—'} colors={colors} />
                  <FieldRow label="部首" value={state.char.radical || '—'} colors={colors} />
                  <FieldRow
                    label="笔画"
                    value={state.char.strokes > 0 ? `${state.char.strokes} 画` : '—'}
                    colors={colors}
                  />
                  <FieldRow
                    label="异体字"
                    value={state.char.yiti.length > 0 ? state.char.yiti.join('、') : '—'}
                    colors={colors}
                  />
                  {state.char.ancientSound ? (
                    <FieldRow label="古音" value={state.char.ancientSound} colors={colors} />
                  ) : null}
                  {/* 古音拟音（Baxter-Sagart）：命中才展示中古/上古两行 + tiny 署名 */}
                  {state.guyin ? (
                    <>
                      <FieldRow label="中古" value={state.guyin.mc} colors={colors} />
                      <FieldRow label="上古" value={state.guyin.oc} colors={colors} />
                      <Text style={[styles.guyinAttribution, { color: colors.pinyin }]}>
                        {`拟音 ${GUYIN_ATTRIBUTION}`}
                      </Text>
                    </>
                  ) : null}
                </>
              ) : null}

              {!state.isChar && state.word ? (
                <>
                  <FieldRow label="词义" value={state.word.meaning || '—'} colors={colors} />
                  {state.word.source ? (
                    <FieldRow label="出处" value={state.word.source} colors={colors} />
                  ) : null}
                  {state.word.usage ? (
                    <FieldRow label="用法" value={state.word.usage} colors={colors} />
                  ) : null}
                  {state.word.examples && state.word.examples.length > 0 ? (
                    <View style={styles.fieldRow}>
                      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>例句</Text>
                      <View>
                        {state.word.examples.map((example, i) => (
                          <Text key={`e${i}`} style={[styles.fieldValue, { color: colors.text }]}>
                            {`· ${example}`}
                          </Text>
                        ))}
                      </View>
                    </View>
                  ) : null}
                </>
              ) : null}
            </ScrollView>
          )}

          {/* 底部：收藏解析 + 在字典中查看 */}
          {hasResult ? (
            <View style={[styles.footer, { borderTopColor: colors.border }]}>
              <Pressable
                style={({ pressed }) => [
                  styles.footerButton,
                  { backgroundColor: colors.primary },
                  pressed ? styles.buttonPressed : null,
                ]}
                onPress={handleBookmark}
                accessibilityRole="button"
                accessibilityLabel="收藏解析"
              >
                <Text style={styles.bookmarkButtonText}>收藏解析</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.footerButton,
                  { borderColor: colors.primary, borderWidth: 1 },
                  pressed ? styles.buttonPressed : null,
                ]}
                onPress={handleOpenInDict}
                accessibilityRole="button"
                accessibilityLabel="在字典中查看"
              >
                <Text style={[styles.footerOutlineText, { color: colors.primary }]}>在字典中查看</Text>
              </Pressable>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  panel: {
    maxHeight: '60%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 20,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    flex: 1,
    marginRight: 12,
  },
  closeButton: {
    fontSize: 14,
  },
  content: {
    // flexGrow 0：短内容不拉伸（面板随内容自适应收缩）；
    // flexShrink 1：内容超高、面板触到 maxHeight 时 ScrollView 压缩到剩余
    // 空间并进入滚动（缺省 flexShrink 0 会按内容全高量取——溢出被裁剪且
    // ScrollView 自认为无需滚动，「显示不全且拖不动」的根因）。
    flexGrow: 0,
    flexShrink: 1,
  },
  contentInner: {
    padding: 16,
    gap: 10,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 8,
  },
  hint: {
    fontSize: 15,
  },
  hintSmall: {
    fontSize: 12,
  },
  fallbackTip: {
    fontSize: 12,
    marginBottom: 2,
  },
  // 逐字解析摘要列表（多字全串未收录时）
  summaryItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summaryChar: {
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 28,
    minWidth: 28,
    textAlign: 'center',
  },
  summaryBody: {
    flex: 1,
    gap: 2,
  },
  summaryPinyin: {
    fontSize: 12,
    lineHeight: 16,
  },
  summaryMeaning: {
    fontSize: 14,
    lineHeight: 20,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  fieldLabel: {
    width: 56,
    fontSize: 13,
    marginTop: 2,
  },
  fieldValue: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  guyinAttribution: {
    fontSize: 10,
    lineHeight: 14,
    marginLeft: 56,
    marginTop: -4,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    gap: 10,
  },
  footerButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
  },
  bookmarkButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
  },
  bookmarkButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  footerOutlineText: {
    fontSize: 15,
    fontWeight: '600',
  },
  dictSection: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  dictSectionLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  dictSectionPinyin: {
    fontSize: 13,
  },
  dictSectionDef: {
    fontSize: 14,
    lineHeight: 21,
  },
  dictSectionLink: {
    fontSize: 13,
    fontWeight: '600',
    alignSelf: 'flex-end',
  },
  buttonPressed: {
    opacity: 0.7,
  },
});

export default AnalysisPanel;
