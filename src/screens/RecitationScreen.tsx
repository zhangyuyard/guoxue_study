/**
 * 背诵助手页（RecitationScreen）
 * 章节选择（按书分组列表，点击选中）+ 模式选择（填空默写/提示遮盖）
 * + 背诵进度卡片网格 + 「开始背诵」按钮。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RecitationMode } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { TextLibraryService } from '@/services/TextLibraryService';
import { buildReviewItems, REVIEW_INTERVAL_DAYS } from '@/services/ReviewScheduler';
import {
  requestReminderPermission,
  syncReminderFromStores,
} from '@/services/ReviewReminderService';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { dailyGoalProgress, DAILY_GOAL_MAX, DAILY_GOAL_MIN } from '@/utils/dailyGoal';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';
import { RecitationCard } from '@/components/recitation/RecitationCard';

type Props = NativeStackScreenProps<T04StackParamList, 'Recitation'>;

/** 章节索引条目 */
interface ChapterEntry {
  id: string;
  title: string;
  bookId: string;
  bookTitle: string;
}

/** 模式配置 */
const MODES: { key: RecitationMode; label: string; description: string }[] = [
  { key: 'fillBlank', label: '填空默写', description: '遮盖汉字，逐格填写' },
  { key: 'coverHint', label: '提示遮盖', description: '遮盖全文，点击揭示' },
];

export default function RecitationScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const recitationList = useRecitationStore((s) => s.list);
  const loadRecitationList = useRecitationStore((s) => s.loadRecitationList);
  const removeProgressByBook = useRecitationStore((s) => s.removeProgressByBook);

  /** 全部章节（按书分组） */
  const [chapterGroups, setChapterGroups] = useState<
    { bookId: string; bookTitle: string; chapters: ChapterEntry[] }[]
  >([]);
  /** 当前选中章节 */
  const [selectedChapter, setSelectedChapter] = useState<ChapterEntry | null>(null);
  /** 当前选中模式 */
  const [mode, setMode] = useState<RecitationMode>('fillBlank');

  // 加载书籍章节
  useEffect(() => {
    const res = TextLibraryService.getBooks();
    if (res.success && res.data) {
      const groups = res.data.map((book) => ({
        bookId: book.id,
        bookTitle: book.title,
        chapters: book.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          bookId: book.id,
          bookTitle: book.title,
        })),
      }));
      setChapterGroups(groups);
    }
  }, []);

  // 加载背诵进度
  useEffect(() => {
    loadRecitationList();
  }, [loadRecitationList]);

  /** 进度卡片的标题映射（chapterId -> { bookTitle, chapterTitle }） */
  const progressMeta = useMemo(() => {
    const map = new Map<string, { bookTitle: string; chapterTitle: string }>();
    for (const group of chapterGroups) {
      for (const c of group.chapters) {
        map.set(c.id, { bookTitle: group.bookTitle, chapterTitle: c.title });
      }
    }
    return map;
  }, [chapterGroups]);

  /** 选中章节 */
  const selectChapter = useCallback((chapter: ChapterEntry) => {
    setSelectedChapter(chapter);
  }, []);

  /**
   * 今日到期复习项（P2-07 艾宾浩斯）：due = nextDueAt <= now，
   * 旧数据（无 completedAt）与未到期章节不产生复习项。
   */
  const dueItems = useMemo(
    () => buildReviewItems(recitationList, new Date()),
    [recitationList],
  );

  // ---------- B4 每日复习提醒 ----------

  const reminderEnabled = useSettingsStore((s) => s.reminderEnabled);
  const reminderHour = useSettingsStore((s) => s.reminderHour);
  const reminderMinute = useSettingsStore((s) => s.reminderMinute);
  const setRecitationReminder = useSettingsStore((s) => s.setRecitationReminder);

  /** 到期数或提醒设置变化时同步/取消系统通知（覆盖复习完成后 dueCount 减少的场景） */
  useEffect(() => {
    syncReminderFromStores();
  }, [dueItems.length, reminderEnabled, reminderHour, reminderMinute]);

  /** 开关切换：开启前先请求通知权限，拒绝则不回写开关并提示 */
  const toggleReminder = useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        const granted = await requestReminderPermission();
        if (!granted) {
          setRecitationReminder({ reminderEnabled: false });
          Alert.alert(
            '无法开启提醒',
            '通知权限未授予。请在系统设置中允许本应用发送通知后重试。',
          );
          return;
        }
      }
      setRecitationReminder({ reminderEnabled: enabled });
      syncReminderFromStores();
    },
    [setRecitationReminder],
  );

  /** 提醒时刻步进（deltaMinutes：+15/-15），夹在 00:00–23:45 内 */
  const adjustReminderTime = useCallback(
    (deltaMinutes: number) => {
      const total = reminderHour * 60 + reminderMinute + deltaMinutes;
      const clamped = Math.min(23 * 60 + 45, Math.max(0, total));
      setRecitationReminder({
        reminderHour: Math.floor(clamped / 60),
        reminderMinute: clamped % 60,
      });
    },
    [reminderHour, reminderMinute, setRecitationReminder],
  );

  const reminderTimeText = `${String(reminderHour).padStart(2, '0')}:${String(
    reminderMinute,
  ).padStart(2, '0')}`;

  // ---------- P1-09 每日背诵目标 ----------

  const dailyGoalEnabled = useSettingsStore((s) => s.dailyGoalEnabled);
  const dailyGoalCount = useSettingsStore((s) => s.dailyGoalCount);
  const setDailyGoalEnabled = useSettingsStore((s) => s.setDailyGoalEnabled);
  const setDailyGoalCount = useSettingsStore((s) => s.setDailyGoalCount);

  /** 今日目标进度（completedAt 按本地时区当天统计，背完一章记 1 段） */
  const goalProgress = useMemo(
    () => dailyGoalProgress(recitationList, new Date(), dailyGoalCount),
    [recitationList, dailyGoalCount],
  );

  /** 目标开关切换后同步通知（达成/关闭时取消兜底目标提醒） */
  const toggleDailyGoal = useCallback(
    (enabled: boolean) => {
      setDailyGoalEnabled(enabled);
      syncReminderFromStores();
    },
    [setDailyGoalEnabled],
  );

  /** 目标量步进（delta：+1/-1，store 内 clamp 到 1–99），变更后同步通知 */
  const adjustDailyGoal = useCallback(
    (delta: number) => {
      setDailyGoalCount(dailyGoalCount + delta);
      syncReminderFromStores();
    },
    [dailyGoalCount, setDailyGoalCount],
  );

  /** 进入今日复习（固定 fillBlank 模式，复习即默写检验） */
  const startReview = useCallback(
    (bookId: string, chapterId: string) => {
      navigation.navigate('RecitationPractice', {
        bookId,
        chapterId,
        mode: 'fillBlank',
      });
    },
    [navigation],
  );

  /** 开始背诵 */
  const startRecitation = useCallback(() => {
    if (!selectedChapter) {
      return;
    }
    navigation.navigate('RecitationPractice', {
      bookId: selectedChapter.bookId,
      chapterId: selectedChapter.id,
      mode,
    });
  }, [navigation, selectedChapter, mode]);

  /** 重置当前书籍背诵进度（P1-08）：两步确认后按书籍清空，进度网格随之刷新 */
  const confirmResetProgress = useCallback(() => {
    if (!selectedChapter) {
      return;
    }
    Alert.alert(
      '重置进度',
      `将清空《${selectedChapter.bookTitle}》的背诵进度，且无法恢复。确定继续吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '重置',
          style: 'destructive',
          onPress: () => removeProgressByBook(selectedChapter.bookId),
        },
      ],
    );
  }, [selectedChapter, removeProgressByBook]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <Text style={[styles.title, { color: colors.text }]}>背诵助手</Text>

      {/* 今日复习（P2-07 艾宾浩斯：仅展示到期章节，点击进入填空默写） */}
      {dueItems.length > 0 ? (
        <>
          <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
            今日复习（{dueItems.length}）
          </Text>
          <View style={styles.reviewList}>
            {dueItems.map((item) => {
              const meta = progressMeta.get(item.chapterId);
              if (!meta) {
                return null;
              }
              return (
                <Pressable
                  key={`${item.bookId}:${item.chapterId}`}
                  onPress={() => startReview(item.bookId, item.chapterId)}
                  style={[
                    styles.reviewCard,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`复习${meta.bookTitle}${meta.chapterTitle}`}
                >
                  <Text style={[styles.reviewTitle, { color: colors.text }]} numberOfLines={1}>
                    《{meta.bookTitle}》{meta.chapterTitle}
                  </Text>
                  <Text style={[styles.reviewMeta, { color: colors.textSecondary }]}>
                    第 {item.level + 1} 轮 · 间隔 {REVIEW_INTERVAL_DAYS[item.level]} 天
                    {item.overdueDays > 0 ? ` · 已逾期 ${item.overdueDays} 天` : ' · 今日到期'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {/* 每日复习提醒（B4）：开关 + 时刻步进（无新依赖，简单按钮组） */}
      <View
        style={[styles.reminderCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.reminderRow}>
          <View style={styles.flexOne}>
            <Text style={[styles.reminderTitle, { color: colors.text }]}>每日复习提醒</Text>
            <Text style={[styles.reminderDesc, { color: colors.textSecondary }]}>
              {reminderEnabled
                ? `每天 ${reminderTimeText} 提醒到期复习`
                : '开启后每天固定时刻提醒到期复习'}
            </Text>
          </View>
          <Switch
            value={reminderEnabled}
            onValueChange={(v) => {
              void toggleReminder(v);
            }}
            accessibilityLabel="每日复习提醒开关"
          />
        </View>
        {reminderEnabled ? (
          <View style={styles.reminderRow}>
            <Text style={[styles.reminderTimeLabel, { color: colors.textSecondary }]}>
              提醒时刻
            </Text>
            <View style={styles.timeStepper}>
              <Pressable
                onPress={() => adjustReminderTime(-15)}
                hitSlop={8}
                style={[styles.stepBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="提前 15 分钟"
              >
                <Text style={[styles.stepBtnText, { color: colors.text }]}>−</Text>
              </Pressable>
              <Text style={[styles.timeText, { color: colors.text }]}>{reminderTimeText}</Text>
              <Pressable
                onPress={() => adjustReminderTime(15)}
                hitSlop={8}
                style={[styles.stepBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="推后 15 分钟"
              >
                <Text style={[styles.stepBtnText, { color: colors.text }]}>＋</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      {/* 每日背诵目标（P1-09）：开关 + 目标量 ±1 步进 + 今日进度 */}
      <View
        style={[styles.reminderCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.reminderRow}>
          <View style={styles.flexOne}>
            <Text style={[styles.reminderTitle, { color: colors.text }]}>每日背诵目标</Text>
            <Text style={[styles.reminderDesc, { color: colors.textSecondary }]}>
              {dailyGoalEnabled
                ? `每天目标 ${dailyGoalCount} 段，背完一章记 1 段`
                : '开启后记录每日背诵进度'}
            </Text>
          </View>
          <Switch
            value={dailyGoalEnabled}
            onValueChange={toggleDailyGoal}
            accessibilityLabel="每日背诵目标开关"
          />
        </View>
        {dailyGoalEnabled ? (
          <>
            <View style={styles.reminderRow}>
              <Text style={[styles.reminderTimeLabel, { color: colors.textSecondary }]}>
                每日目标
              </Text>
              <View style={styles.timeStepper}>
                <Pressable
                  onPress={() => adjustDailyGoal(-1)}
                  disabled={dailyGoalCount <= DAILY_GOAL_MIN}
                  hitSlop={8}
                  style={[
                    styles.stepBtn,
                    {
                      borderColor: colors.border,
                      opacity: dailyGoalCount <= DAILY_GOAL_MIN ? 0.4 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="目标减 1 段"
                >
                  <Text style={[styles.stepBtnText, { color: colors.text }]}>−</Text>
                </Pressable>
                <Text style={[styles.timeText, { color: colors.text }]}>{dailyGoalCount} 段</Text>
                <Pressable
                  onPress={() => adjustDailyGoal(1)}
                  disabled={dailyGoalCount >= DAILY_GOAL_MAX}
                  hitSlop={8}
                  style={[
                    styles.stepBtn,
                    {
                      borderColor: colors.border,
                      opacity: dailyGoalCount >= DAILY_GOAL_MAX ? 0.4 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="目标加 1 段"
                >
                  <Text style={[styles.stepBtnText, { color: colors.text }]}>＋</Text>
                </Pressable>
              </View>
            </View>
            {/* 今日进度：达成时用主题色 + 加粗给明确的达成态 */}
            <Text
              style={[
                styles.goalProgressText,
                goalProgress.achieved
                  ? { color: colors.primary, fontWeight: '600' }
                  : { color: colors.textSecondary },
              ]}
            >
              {goalProgress.achieved
                ? `今日已达成：已背 ${goalProgress.completed} / ${goalProgress.goal} 段`
                : `今日已背 ${goalProgress.completed} / ${goalProgress.goal} 段，还差 ${goalProgress.remaining} 段`}
            </Text>
          </>
        ) : null}
      </View>

      {/* 章节选择 */}
      <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
        选择章节
      </Text>
      {chapterGroups.map((group) => (
        <View key={group.bookId} style={styles.bookGroup}>
          <Text style={[styles.bookTitle, { color: colors.primary }]}>
            《{group.bookTitle}》
          </Text>
          <View style={styles.chapterList}>
            {group.chapters.map((chapter) => {
              const selected = selectedChapter?.id === chapter.id;
              return (
                <Pressable
                  key={chapter.id}
                  onPress={() => selectChapter(chapter)}
                  style={[
                    styles.chapterItem,
                    {
                      backgroundColor: selected ? colors.primary : colors.card,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[
                      styles.chapterText,
                      { color: selected ? '#FFFFFF' : colors.text },
                    ]}
                  >
                    {chapter.title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      {/* 模式选择 */}
      <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>选择模式</Text>
      <View style={styles.modeRow}>
        {MODES.map((m) => {
          const selected = mode === m.key;
          return (
            <Pressable
              key={m.key}
              onPress={() => setMode(m.key)}
              style={[
                styles.modeCard,
                {
                  backgroundColor: selected ? colors.primary : colors.card,
                  borderColor: selected ? colors.primary : colors.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.modeLabel,
                  { color: selected ? '#FFFFFF' : colors.text },
                ]}
              >
                {m.label}
              </Text>
              <Text
                style={[
                  styles.modeDesc,
                  { color: selected ? 'rgba(255,255,255,0.85)' : colors.textSecondary },
                ]}
              >
                {m.description}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 开始背诵按钮 */}
      <Pressable
        onPress={startRecitation}
        disabled={!selectedChapter}
        style={[
          styles.startBtn,
          {
            backgroundColor: selectedChapter ? colors.primary : colors.border,
          },
        ]}
      >
        <Text style={styles.startBtnText}>
          {selectedChapter
            ? `开始背诵《${selectedChapter.bookTitle}·${selectedChapter.title}》`
            : '请先选择章节'}
        </Text>
      </Pressable>

      {/* 背诵进度网格 */}
      {recitationList.length > 0 ? (
        <>
          <View style={styles.progressHeaderRow}>
            <Text style={[styles.progressLabel, { color: colors.textSecondary }]}>
              背诵进度
            </Text>
            {/* 重置入口：以当前选中章节所属书籍为单位（次要样式文字按钮） */}
            {selectedChapter ? (
              <Pressable
                onPress={confirmResetProgress}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="重置进度"
              >
                <Text style={[styles.resetBtnText, { color: colors.pinyin }]}>重置进度</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.progressGrid}>
            {recitationList.map((progress) => {
              const meta = progressMeta.get(progress.chapterId);
              if (!meta) {
                return null;
              }
              return (
                <RecitationCard
                  key={progress.id}
                  bookTitle={meta.bookTitle}
                  chapterTitle={meta.chapterTitle}
                  status={progress.status}
                  progress={progress.progress}
                  onPress={() =>
                    navigation.navigate('RecitationPractice', {
                      bookId: progress.bookId,
                      chapterId: progress.chapterId,
                      mode: progress.mode,
                    })
                  }
                />
              );
            })}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 13,
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
  },
  reviewList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  reviewCard: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  reviewTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  reviewMeta: {
    fontSize: 12,
    marginTop: 4,
  },
  reminderCard: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  flexOne: {
    flex: 1,
  },
  reminderTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  reminderDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  reminderTimeLabel: {
    fontSize: 13,
  },
  timeStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginLeft: 'auto',
  },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },
  timeText: {
    fontSize: 16,
    fontWeight: '600',
    minWidth: 52,
    textAlign: 'center',
  },
  goalProgressText: {
    fontSize: 12,
    marginTop: 2,
  },
  bookGroup: {
    marginBottom: 4,
  },
  bookTitle: {
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  chapterList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
    gap: 8,
  },
  chapterItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  chapterText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  modeCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  modeLabel: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  modeDesc: {
    fontSize: 12,
  },
  startBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  startBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  progressGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
  },
  progressHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
  },
  progressLabel: {
    fontSize: 13,
  },
  resetBtnText: {
    fontSize: 13,
  },
});
