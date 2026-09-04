/**
 * 书籍卡片组件（BookCard）
 * 用于书架页 2 列网格。展示书名、作者、分类角标、简介与阅读进度。
 * 布局对网格友好：外层 flex:1，minWidth 保证双列均分。
 */
import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Book, BookCategory } from '@/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';
import { ProgressBar } from '@/components/common/ProgressBar';

export interface BookCardProps {
  /** 书籍数据 */
  book: Book;
  /** 点击回调（进入阅读器） */
  onPress?: () => void;
  /** 长按回调（用户书删除入口） */
  onLongPress?: () => void;
  /** 阅读进度 0-100（可选，无进度时不展示进度条） */
  progress?: number;
}

/** 分类角标样式（固定配色，两种主题下均清晰可辨） */
const CATEGORY_STYLE: Record<BookCategory, { label: string; bg: string; fg: string }> = {
  jing: { label: '经', bg: 'rgba(139, 94, 60, 0.14)', fg: '#8B5E3C' },
  shi: { label: '史', bg: 'rgba(74, 111, 165, 0.14)', fg: '#4A6FA5' },
  zi: { label: '子', bg: 'rgba(62, 142, 90, 0.14)', fg: '#3E8E5A' },
  ji: { label: '集', bg: 'rgba(142, 74, 111, 0.14)', fg: '#8E4A6F' },
  user: { label: '书', bg: 'rgba(120, 110, 200, 0.14)', fg: '#786EC8' },
};

function BookCardInner({
  book,
  onPress,
  onLongPress,
  progress,
}: BookCardProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const cat = CATEGORY_STYLE[book.category];

  /** 简介截断为两行（约 42 字） */
  const description = useMemo(
    () => (book.description.length > 42 ? `${book.description.slice(0, 42)}…` : book.description),
    [book.description],
  );

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${book.title}，${book.author}`}
    >
      <View style={styles.headerRow}>
        <View
          style={[styles.categoryBadge, { backgroundColor: cat.bg }]}
          testID={`book-category-${book.category}`}
        >
          <Text style={[styles.categoryText, { color: cat.fg }]}>{cat.label}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {book.title}
        </Text>
      </View>

      <Text numberOfLines={1} style={[styles.author, { color: colors.textSecondary }]}>
        {book.author}
      </Text>

      <Text numberOfLines={2} style={[styles.description, { color: colors.textSecondary }]}>
        {description}
      </Text>

      <View style={styles.progressArea}>
        {typeof progress === 'number' && progress > 0 ? (
          <>
            <ProgressBar progress={progress} color={colors.primary} height={4} />
            <Text style={[styles.progressText, { color: colors.pinyin }]}>
              已读 {Math.round(progress)}%
            </Text>
          </>
        ) : (
          <Text style={[styles.progressText, { color: colors.pinyin }]}>
            {book.chapters.length} 篇
          </Text>
        )}
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
    minHeight: 132,
  },
  pressed: {
    opacity: 0.7,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  categoryText: {
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
  },
  author: {
    fontSize: 12,
    marginBottom: 6,
  },
  description: {
    fontSize: 12,
    lineHeight: 17,
  },
  progressArea: {
    marginTop: 'auto',
    paddingTop: 10,
  },
  progressText: {
    fontSize: 11,
    marginTop: 4,
  },
});

/** 书籍卡片 */
export const BookCard = memo(BookCardInner);

export default BookCard;
