/**
 * 分类标签条组件（CategoryTabs）
 * 横向滚动标签，选中态高亮（圆角胶囊）。用于书架页的分类筛选（全部/经/史/子/集）。
 */
import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { getColors } from '@/theme';
import { useSettingsStore } from '@/store/useSettingsStore';

export interface CategoryTabItem {
  /** 分类 key（空字符串表示「全部」） */
  key: string;
  /** 显示标签，如「经」 */
  label: string;
}

export interface CategoryTabsProps {
  /** 分类条目列表 */
  categories: CategoryTabItem[];
  /** 当前选中 key */
  active: string;
  /** 切换回调 */
  onChange: (key: string) => void;
}

function CategoryTabsInner({
  categories,
  active,
  onChange,
}: CategoryTabsProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
      style={styles.scroll}
    >
      {categories.map((item) => {
        const selected = item.key === active;
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            style={[
              styles.tab,
              { backgroundColor: selected ? colors.primary : 'transparent' },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text
              style={[
                styles.label,
                {
                  color: selected ? colors.background : colors.textSecondary,
                },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  tab: {
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
});

/** 分类标签条 */
export const CategoryTabs = memo(CategoryTabsInner);

/** 便捷工厂：生成「全部 + 分类」条目列表 */
export function buildCategoryTabs(
  categories: { key: string; label: string }[],
): CategoryTabItem[] {
  return [{ key: '', label: '全部' }, ...categories];
}

export default CategoryTabs;
