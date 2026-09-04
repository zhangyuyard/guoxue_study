/**
 * 背诵练习界面（RecitationPracticeScreen）
 * 路由参数：{ bookId, chapterId, mode }。
 * fillBlank 模式渲染 FillBlankView（填空默写 + 同音容错判分）；
 * coverHint 模式为逐步遮盖点击揭示（辅助记忆）。
 * 遮盖密度可选（25% / 50% / 75%）；提交后展示正确率与错误详情，
 * 并调用 useRecitationStore.saveProgress 持久化进度。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RecitationHintGranularity, TextSegment } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { TextLibraryService } from '@/services/TextLibraryService';
import { scheduleNext } from '@/services/ReviewScheduler';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, getLineHeightPx, PAGE_TITLE_FONT_SIZE } from '@/theme';
import { FillBlankView, type FillBlankStats } from '@/components/recitation/FillBlankView';

type Props = NativeStackScreenProps<T04StackParamList, 'RecitationPractice'>;

/** 遮盖密度档位 */
const DENSITIES = [
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
];

/** 提示粒度档位（P1-07） */
const GRANULARITIES: { value: RecitationHintGranularity; label: string }[] = [
  { value: 'whole', label: '整篇' },
  { value: 'paragraph', label: '逐段' },
  { value: 'sentence', label: '逐句' },
];

/** CJK 汉字判断 */
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

/** 遮盖字格 */
interface CoverChar {
  index: number;
  char: string;
  isCJK: boolean;
  revealed: boolean;
}

/** 构建初始遮盖数据（汉字全部遮盖，标点可见） */
function buildCoverChars(segments: TextSegment[]): CoverChar[] {
  let index = 0;
  const result: CoverChar[] = [];
  for (const seg of segments) {
    for (const ch of Array.from(seg.text)) {
      const isCJK = isCJKChar(ch);
      result.push({ index: index++, char: ch, isCJK, revealed: !isCJK });
    }
  }
  return result;
}

export default function RecitationPracticeScreen({
  route,
  navigation,
}: Props): React.JSX.Element {
  const { bookId, chapterId, mode } = route.params;
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const fontSize = useSettingsStore((s) => s.fontSize);

  const saveProgress = useRecitationStore((s) => s.saveProgress);
  const getProgress = useRecitationStore((s) => s.getProgress);
  /** 提示粒度（P1-07，持久化于设置 Store） */
  const granularity = useSettingsStore((s) => s.recitationHintGranularity);
  const setRecitationHintGranularity = useSettingsStore(
    (s) => s.setRecitationHintGranularity,
  );

  /** 章节段落 */
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loadError, setLoadError] = useState<string | undefined>();

  /** 遮盖密度 */
  const [density, setDensity] = useState(0.5);
  /** 练习尝试次数（用作 FillBlankView 的 key，重新出题） */
  const [attempt, setAttempt] = useState(0);

  /** 提交结果（仅 fillBlank 模式） */
  const [result, setResult] = useState<FillBlankStats | null>(null);

  // coverHint 模式内部状态
  const [coverChars, setCoverChars] = useState<CoverChar[]>([]);
  /** coverChars 同步 ref（在事件回调中读取最新快照，避免 setState 闭包过期） */
  const coverCharsRef = useRef<CoverChar[]>([]);
  coverCharsRef.current = coverChars;

  useEffect(() => {
    const res = TextLibraryService.getChapter(chapterId);
    if (res.success && res.data) {
      setSegments(res.data.segments);
      setChapterTitle(res.data.title);
      setCoverChars(buildCoverChars(res.data.segments));
    } else {
      setLoadError(res.error ?? '加载章节失败');
    }
  }, [chapterId]);

  /** 保存背诵进度（根据正确率推导状态） */
  const persistProgress = useCallback(
    (
      progress: number,
      lastPracticedAt?: string,
      completedAt?: string,
      reviewLevel?: number,
      nextDueAt?: string,
    ) => {
      const status =
        progress >= 90 ? 'mastered' : progress > 0 ? 'inProgress' : 'notStarted';
      saveProgress({
        bookId,
        chapterId,
        mode,
        status,
        progress: Math.round(progress),
        lastPracticedAt,
        completedAt,
        reviewLevel,
        nextDueAt,
      });
    },
    [saveProgress, bookId, chapterId, mode],
  );

  /** fillBlank 提交完成：记录完成时刻并按艾宾浩斯规则推进/回退复习等级（P2-07） */
  const handleComplete = useCallback(
    (stats: FillBlankStats) => {
      setResult(stats);
      const rate = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
      const now = new Date();
      const completedAtIso = now.toISOString();
      const existing = getProgress(bookId, chapterId, mode);
      // 口径：全对（correct === total 且 total > 0）→ 升一级；有错 → 降一级
      const allCorrect = stats.total > 0 && stats.correct === stats.total;
      const next = scheduleNext(existing?.reviewLevel ?? 0, allCorrect, now);
      persistProgress(
        rate,
        completedAtIso,
        completedAtIso,
        next.level,
        next.nextDueAt.toISOString(),
      );
      // P2-06 成就：背诵完成即重算（幂等，仅新解锁项落账）
      useAchievementStore.getState().recompute();
    },
    [persistProgress, getProgress, bookId, chapterId, mode],
  );

  /** 根据最新字格快照计算揭示进度并持久化 */
  const persistCoverProgress = useCallback(
    (chars: CoverChar[]) => {
      const total = chars.filter((c) => c.isCJK).length;
      const revealed = chars.filter((c) => c.isCJK && c.revealed).length;
      const rate = total > 0 ? (revealed / total) * 100 : 0;
      persistProgress(rate, new Date().toISOString());
    },
    [persistProgress],
  );

  /** coverHint：点击揭示一个字 */
  const revealChar = useCallback(
    (index: number) => {
      const current = coverCharsRef.current;
      const target = current[index];
      if (!target || target.revealed) {
        return;
      }
      const next = current.map((c) => (c.index === index ? { ...c, revealed: true } : c));
      setCoverChars(next);
      persistCoverProgress(next);
    },
    [persistCoverProgress],
  );

  /** coverHint：提示（揭示一个随机未揭示汉字） */
  const hintCoverChar = useCallback(() => {
    const current = coverCharsRef.current;
    const hidden = current.filter((c) => c.isCJK && !c.revealed);
    if (hidden.length === 0) {
      return;
    }
    const target = hidden[Math.floor(Math.random() * hidden.length)];
    const next = current.map((c) =>
      c.index === target.index ? { ...c, revealed: true } : c,
    );
    setCoverChars(next);
    persistCoverProgress(next);
  }, [persistCoverProgress]);

  /** coverHint：重置 */
  const resetCover = useCallback(() => {
    setCoverChars(buildCoverChars(segments));
  }, [segments]);

  /** 再来一次 */
  const retry = useCallback(() => {
    setResult(null);
    setAttempt((a) => a + 1);
    setCoverChars(buildCoverChars(segments));
  }, [segments]);

  /** coverHint 揭示统计 */
  const coverStats = useMemo(() => {
    const total = coverChars.filter((c) => c.isCJK).length;
    const revealed = coverChars.filter((c) => c.isCJK && c.revealed).length;
    return { total, revealed, rate: total > 0 ? (revealed / total) * 100 : 0 };
  }, [coverChars]);

  if (loadError) {
    return (
      <View style={[styles.emptyWrap, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{loadError}</Text>
        <Pressable
          onPress={() => navigation.goBack()}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.primaryBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  const lineHeight = getLineHeightPx(fontSize, 1.6);
  const rate = result ? (result.total > 0 ? Math.round((result.correct / result.total) * 100) : 0) : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* 顶部标题 */}
      <View style={styles.header}>
        <View style={styles.headerTextWrap}>
          <Text style={[styles.title, { color: colors.text }]}>{chapterTitle || '背诵练习'}</Text>
          <Text style={[styles.modeLabel, { color: colors.textSecondary }]}>
            {mode === 'fillBlank' ? '填空默写' : '提示遮盖'}
          </Text>
        </View>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <Text style={[styles.closeText, { color: colors.textSecondary }]}>返回</Text>
        </Pressable>
      </View>

      {/* 遮盖密度选择 */}
      <View style={styles.densityRow}>
        <Text style={[styles.densityHint, { color: colors.textSecondary }]}>遮盖密度</Text>
        {DENSITIES.map((d) => {
          const selected = density === d.value;
          return (
            <Pressable
              key={d.label}
              onPress={() => {
                setDensity(d.value);
                setResult(null);
                setAttempt((a) => a + 1);
              }}
              style={[
                styles.densityBtn,
                {
                  backgroundColor: selected ? colors.primary : colors.card,
                  borderColor: selected ? colors.primary : colors.border,
                },
              ]}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.densityText,
                  { color: selected ? '#FFFFFF' : colors.text },
                ]}
              >
                {d.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 提示粒度选择（P1-07，仅填空默写模式；切换不影响已出题目，无需重置） */}
      {mode === 'fillBlank' ? (
        <View style={styles.densityRow}>
          <Text style={[styles.densityHint, { color: colors.textSecondary }]}>
            提示粒度
          </Text>
          {GRANULARITIES.map((g) => {
            const selected = granularity === g.value;
            return (
              <Pressable
                key={g.value}
                onPress={() => setRecitationHintGranularity(g.value)}
                style={[
                  styles.densityBtn,
                  {
                    backgroundColor: selected ? colors.primary : colors.card,
                    borderColor: selected ? colors.primary : colors.border,
                  },
                ]}
                accessibilityState={{ selected }}
                accessibilityLabel={`提示粒度${g.label}`}
              >
                <Text
                  style={[
                    styles.densityText,
                    { color: selected ? '#FFFFFF' : colors.text },
                  ]}
                >
                  {g.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* 主体内容 */}
      {result ? (
        /* 提交结果面板 */
        <ScrollView style={styles.resultPanel} contentContainerStyle={styles.resultContent}>
          <Text style={[styles.resultTitle, { color: colors.text }]}>练习结果</Text>
          <View style={[styles.rateCircle, { borderColor: colors.primary }]}>
            <Text style={[styles.rateText, { color: colors.primary }]}>{rate}%</Text>
            <Text style={[styles.rateCaption, { color: colors.textSecondary }]}>正确率</Text>
          </View>
          <Text style={[styles.rateDetail, { color: colors.textSecondary }]}>
            答对 {result.correct} / {result.total} 题
          </Text>

          {result.wrong.length > 0 ? (
            <>
              <Text style={[styles.resultSectionTitle, { color: colors.text }]}>错误详情</Text>
              {result.wrong.map((w, idx) => (
                <View
                  key={idx}
                  style={[styles.wrongCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <Text style={[styles.wrongText, { color: colors.text }]}>
                    原文：{w.expected}
                  </Text>
                  <Text style={[styles.wrongText, { color: colors.accent }]}>
                    你的答案：{w.given || '（未填写）'}
                  </Text>
                </View>
              ))}
            </>
          ) : (
            <Text style={[styles.perfectText, { color: colors.primary }]}>
              全部正确，太棒了！
            </Text>
          )}

          <View style={styles.resultActions}>
            <Pressable
              onPress={retry}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.primaryBtnText}>再来一次</Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.goBack()}
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>返回</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : mode === 'fillBlank' ? (
        /* 填空默写 */
        <FillBlankView
          key={attempt}
          segments={segments}
          density={density}
          granularity={granularity}
          onComplete={handleComplete}
          onHint={() => {
            // 提示揭示由 FillBlankView 内部完成；进度在提交时统一持久化
          }}
          onReset={() => setResult(null)}
        />
      ) : (
        /* 提示遮盖 */
        <View style={styles.coverWrap}>
          <View style={styles.coverProgressRow}>
            <Text style={[styles.coverProgressText, { color: colors.textSecondary }]}>
              已揭示 {coverStats.revealed} / {coverStats.total}
            </Text>
            <Text style={[styles.coverRateText, { color: colors.pinyin }]}>
              {Math.round(coverStats.rate)}%
            </Text>
          </View>
          <ScrollView style={styles.coverScroll} contentContainerStyle={styles.coverContent}>
            <View style={styles.coverTextRow}>
              {coverChars.map((c) => {
                if (!c.isCJK) {
                  return (
                    <Text
                      key={c.index}
                      style={[styles.plainChar, { fontSize, color: colors.text, lineHeight }]}
                    >
                      {c.char}
                    </Text>
                  );
                }
                return (
                  <Pressable
                    key={c.index}
                    onPress={() => revealChar(c.index)}
                    style={[
                      styles.coverCell,
                      {
                        backgroundColor: c.revealed ? colors.primarySoft : colors.card,
                        borderColor: colors.border,
                      },
                    ]}
                    accessibilityRole="button"
                  >
                    <Text
                      style={[
                        styles.coverChar,
                        {
                          fontSize,
                          color: c.revealed ? colors.text : colors.pinyin,
                          lineHeight,
                        },
                      ]}
                    >
                      {c.revealed ? c.char : '□'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
          <View style={styles.coverActions}>
            <Pressable
              onPress={resetCover}
              style={[styles.secondaryBtn, styles.coverActionBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>重置</Text>
            </Pressable>
            <Pressable
              onPress={hintCoverChar}
              style={[styles.primaryBtn, styles.coverActionBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.primaryBtnText}>提示</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  headerTextWrap: {
    flex: 1,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
  },
  modeLabel: {
    fontSize: 13,
    marginTop: 2,
  },
  closeText: {
    fontSize: 15,
    fontWeight: '600',
  },
  densityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  densityHint: {
    fontSize: 13,
    marginRight: 4,
  },
  densityBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  densityText: {
    fontSize: 13,
    fontWeight: '600',
  },
  resultPanel: {
    flex: 1,
  },
  resultContent: {
    padding: 16,
    alignItems: 'center',
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  rateCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },
  rateText: {
    fontSize: 32,
    fontWeight: '800',
  },
  rateCaption: {
    fontSize: 12,
  },
  rateDetail: {
    fontSize: 14,
    marginBottom: 16,
  },
  resultSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  wrongCard: {
    alignSelf: 'stretch',
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    gap: 4,
  },
  wrongText: {
    fontSize: 15,
    lineHeight: 22,
  },
  perfectText: {
    fontSize: 16,
    fontWeight: '700',
    marginVertical: 16,
  },
  resultActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  primaryBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  coverWrap: {
    flex: 1,
  },
  coverProgressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  coverProgressText: {
    fontSize: 13,
  },
  coverRateText: {
    fontSize: 13,
  },
  coverScroll: {
    flex: 1,
  },
  coverContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  coverTextRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  plainChar: {
    marginRight: 1,
  },
  coverCell: {
    borderWidth: 1,
    borderRadius: 4,
    marginRight: 3,
    marginBottom: 4,
    paddingHorizontal: 2,
    minWidth: 30,
    alignItems: 'center',
  },
  coverChar: {
    textAlign: 'center',
  },
  coverActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  coverActionBtn: {
    flex: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  emptyText: {
    fontSize: 15,
  },
});
