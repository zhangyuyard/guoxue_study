/**
 * 学习统计页（StudyStatsScreen，P2-14 学习社区本地版）
 * 「学习社区」的本地落地：本地学习数据总览 + 系统分享出口（零账号、零网络）。
 * 数据只读复用各 store（背诵进度/收藏/笔记/成就/设置），聚合逻辑在 utils/studyStats
 * 纯函数中（IO 与展示分离）；「今天」用一次 useState 初始化，页面内不需要实时时钟。
 * 视觉风格与 AchievementsScreen 保持一致（getColors 主题适配、卡片式列表）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { T04StackParamList } from '@/screens/types';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { buildStudyStats, formatShareText } from '@/utils/studyStats';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'StudyStats'>;

/** 内置书库总书数（与成就系统覆盖书籍口径一致，见 utils/achievements 定义表注释） */
const TOTAL_BOOKS = 10;

/** 统计卡（网格单元：图标 + 数值 + 标签） */
function StatCard({
  icon,
  value,
  label,
  colors,
}: {
  icon: string;
  value: string;
  label: string;
  colors: ReturnType<typeof getColors>;
}): React.JSX.Element {
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.pinyin }]}>{label}</Text>
    </View>
  );
}

export default function StudyStatsScreen(_props: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  // 各数据源（只读复用，订阅列表引用变化触发重算）
  const recitationList = useRecitationStore((s) => s.list);
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const notes = useNoteStore((s) => s.notes);
  const unlockedAt = useAchievementStore((s) => s.unlockedAt);
  const dailyGoalEnabled = useSettingsStore((s) => s.dailyGoalEnabled);
  const dailyGoalCount = useSettingsStore((s) => s.dailyGoalCount);

  // 「今天」初始化一次即可：本页展示学习成果总览，不需要实时时钟
  const [today] = useState<Date>(() => new Date());

  // 首次进入时同步刷新各数据源（SQLite 同步读取，幂等；避免启动后未加载导致 0 值）
  useEffect(() => {
    useRecitationStore.getState().loadRecitationList();
    useBookmarkStore.getState().loadBookmarks();
    useNoteStore.getState().loadNotes();
  }, []);

  // 聚合统计：依赖各列表引用，任一数据变化才重算
  const stats = useMemo(
    () =>
      buildStudyStats(
        {
          recitationItems: recitationList,
          bookmarkCount: bookmarks.length,
          noteCount: notes.length,
          unlockedAt,
          dailyGoalEnabled,
          dailyGoalCount,
        },
        today,
      ),
    [recitationList, bookmarks, notes, unlockedAt, dailyGoalEnabled, dailyGoalCount, today],
  );

  /** 分享学习成果：系统分享面板，用户取消静默（不弹错误提示） */
  const handleShare = useCallback(() => {
    void (async () => {
      try {
        await Share.share({ message: formatShareText(stats, today) });
      } catch {
        // 用户取消分享：静默
      }
    })();
  }, [stats, today]);

  /** 今日进度卡描述（目标关闭时展示「未设置目标」，避免「已达成」歧义） */
  const todayCardDesc =
    stats.dailyGoal > 0
      ? stats.todayAchieved
        ? '今日目标已达成，继续保持 ✅'
        : `距离目标还差 ${stats.dailyGoal - stats.todayRecited} 段`
      : '未设置每日目标，可在设置中开启';

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      testID="study-stats-screen"
    >
      <View
        style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>学习统计</Text>
        <Text style={[styles.subtitle, { color: colors.pinyin }]}>
          本地学习数据总览 · 全部数据仅存于本机
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {/* 今日进度卡 */}
        <View
          style={[
            styles.todayCard,
            { backgroundColor: colors.card, borderColor: colors.border },
            stats.dailyGoal > 0 && stats.todayAchieved && { borderColor: colors.primary },
          ]}
        >
          <Text style={styles.todayIcon}>📅</Text>
          <View style={styles.todayBody}>
            <Text style={[styles.todayTitle, { color: colors.text }]}>
              今日背诵 {stats.todayRecited}
              {stats.dailyGoal > 0 ? `/${stats.dailyGoal}` : ''} 段
            </Text>
            <Text style={[styles.todayDesc, { color: colors.pinyin }]}>{todayCardDesc}</Text>
          </View>
        </View>

        {/* 分享学习成果（系统分享出口） */}
        <Pressable
          onPress={handleShare}
          style={({ pressed }) => [
            styles.shareButton,
            { backgroundColor: colors.primary },
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="分享学习成果"
        >
          <Text style={styles.shareButtonText}>📤 分享学习成果</Text>
        </Pressable>

        {/* 累计统计网格 */}
        <View style={styles.statGrid}>
          <StatCard icon="🧾" value={String(stats.totalRecited)} label="累计背诵（段）" colors={colors} />
          <StatCard icon="🔥" value={String(stats.streakDays)} label="连续打卡（天）" colors={colors} />
          <StatCard
            icon="🏅"
            value={`${stats.unlockedCount}/${stats.achievementTotal}`}
            label="已解锁成就"
            colors={colors}
          />
          <StatCard
            icon="🏛️"
            value={`${stats.coverageBooks}/${TOTAL_BOOKS}`}
            label="覆盖书籍"
            colors={colors}
          />
          <StatCard icon="⭐" value={String(stats.bookmarkCount)} label="收藏（条）" colors={colors} />
          <StatCard icon="📝" value={String(stats.noteCount)} label="笔记（条）" colors={colors} />
        </View>

        <Text style={[styles.footnote, { color: colors.pinyin }]}>
          统计口径与成就系统一致 · 覆盖书籍按完成背诵的书目去重
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
  },
  todayCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  todayIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  todayBody: {
    flex: 1,
  },
  todayTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 2,
  },
  todayDesc: {
    fontSize: 12,
  },
  shareButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  shareButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -5,
  },
  statCard: {
    width: '50%',
    paddingVertical: 16,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  statIcon: {
    fontSize: 22,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 12,
  },
  footnote: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
});
