/**
 * 成就页（AchievementsScreen，P2-06 本地版）
 * 列表展示全部成就：已解锁（亮色 + 解锁时间）/ 未解锁（灰色 + 达成条件描述）。
 * 解锁记录经 useAchievementStore（MMKV persist）读取；图标用 emoji 兜底。
 */
import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { T04StackParamList } from '@/screens/types';
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_TOTAL,
  type AchievementDef,
} from '@/utils/achievements';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Achievements'>;

/** 解锁时刻格式化（本地时区「YYYY-MM-DD HH:mm」；无效时间回退原始串） */
function formatUnlockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 单条成就行 */
function AchievementRow({
  def,
  unlockedAt,
  colors,
}: {
  def: AchievementDef;
  unlockedAt?: string;
  colors: ReturnType<typeof getColors>;
}): React.JSX.Element {
  const unlocked = unlockedAt !== undefined;
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
        unlocked && { borderColor: colors.primary },
      ]}
    >
      <Text style={[styles.rowIcon, !unlocked && styles.rowIconLocked]}>{def.icon}</Text>
      <View style={styles.rowBody}>
        <Text
          style={[
            styles.rowName,
            { color: unlocked ? colors.text : colors.textSecondary },
          ]}
        >
          {def.name}
          {unlocked && <Text style={{ color: colors.primary }}> · 已解锁</Text>}
        </Text>
        <Text style={[styles.rowDesc, { color: colors.pinyin }]}>
          {unlocked ? `解锁于 ${formatUnlockTime(unlockedAt)}` : def.description}
        </Text>
      </View>
    </View>
  );
}

export default function AchievementsScreen(_props: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const unlockedAt = useAchievementStore((s) => s.unlockedAt);

  const unlockedCount = Object.keys(unlockedAt).length;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      testID="achievements-screen"
    >
      <View
        style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>我的成就</Text>
        <Text style={[styles.subtitle, { color: colors.pinyin }]}>
          已解锁 {unlockedCount}/{ACHIEVEMENT_TOTAL} · 成就不可逆，解锁后永久保留
        </Text>
      </View>

      <FlatList
        data={ACHIEVEMENTS}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: insets.bottom + 24,
        }}
        renderItem={({ item }) => (
          <AchievementRow def={item} unlockedAt={unlockedAt[item.id]} colors={colors} />
        )}
      />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  rowIcon: {
    fontSize: 26,
    marginRight: 12,
  },
  rowIconLocked: {
    opacity: 0.35,
  },
  rowBody: {
    flex: 1,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
  },
  rowDesc: {
    fontSize: 12,
  },
});
