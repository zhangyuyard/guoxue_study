/**
 * 背诵进度卡片（RecitationCard）
 * 用于背诵助手页的进度网格。展示书名、章节名、状态徽章与进度条。
 */
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RecitationStatus } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';
import { ProgressBar } from '@/components/common/ProgressBar';

export interface RecitationCardProps {
  /** 书名 */
  bookTitle: string;
  /** 章节名 */
  chapterTitle: string;
  /** 背诵状态 */
  status: RecitationStatus;
  /** 进度 0-100 */
  progress: number;
  /** 点击回调 */
  onPress: () => void;
}

/** 状态徽章样式 */
const STATUS_STYLE: Record<
  RecitationStatus,
  { label: string; bg: string; fg: string }
> = {
  notStarted: { label: '未开始', bg: 'rgba(120, 120, 120, 0.14)', fg: '#8A8A8A' },
  inProgress: { label: '进行中', bg: 'rgba(74, 111, 165, 0.14)', fg: '#4A6FA5' },
  mastered: { label: '已掌握', bg: 'rgba(62, 142, 90, 0.14)', fg: '#3E8E5A' },
};

function RecitationCardInner({
  bookTitle,
  chapterTitle,
  status,
  progress,
  onPress,
}: RecitationCardProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const badge = STATUS_STYLE[status] ?? STATUS_STYLE.notStarted;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
    >
      <View style={styles.headerRow}>
        <View style={styles.textArea}>
          <Text numberOfLines={1} style={[styles.bookTitle, { color: colors.primary }]}>
            {bookTitle}
          </Text>
          <Text numberOfLines={1} style={[styles.chapterTitle, { color: colors.text }]}>
            {chapterTitle}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
        </View>
      </View>

      <View style={styles.progressRow}>
        <ProgressBar progress={progress} color={colors.primary} height={5} />
        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
          {Math.round(progress)}%
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 104,
  },
  pressed: {
    opacity: 0.7,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
  },
  textArea: {
    flex: 1,
  },
  bookTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  chapterTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 'auto',
  },
  progressText: {
    fontSize: 12,
    minWidth: 34,
    textAlign: 'right',
  },
});

/** 背诵进度卡片 */
export const RecitationCard = memo(RecitationCardInner);

export default RecitationCard;
