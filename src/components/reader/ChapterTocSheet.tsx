/**
 * 目录弹层（ChapterTocSheet）：阅读页顶栏点章节名 → 半屏目录 → 点章名跳章。
 *
 * 2026-10-08 新增（用户裁定）。要点：
 * - **当前章高亮 + 打开即定位**：`initialScrollIndex` 取 `tocInitialIndex`，
 *   长书（资治通鉴数百章）不必从头翻找。
 * - **列表只在 `visible` 时挂载**：`initialScrollIndex` 只在**挂载时**生效（铁律 63
 *   同源）⇒ 若列表常驻，第二次打开目录会停在上次的位置而不是当前章。
 *   条件挂载是「每次打开都重新定位」的承重件，不是优化。
 * - 行高来自 `reader/toc.TOC_ROW_H`（与 getItemLayout 同源，禁各写一份）。
 */
import React, { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import BottomSheet from '@/components/common/BottomSheet';
import { TOC_ROW_H, tocInitialIndex, type TocItem } from '@/reader/toc';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, withAlpha, type ThemeColors } from '@/theme';

export interface ChapterTocSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 目录条目（上层按书体章列表构建） */
  items: readonly TocItem[];
  /** 当前章 id：高亮 + 打开时定位到它 */
  currentChapterId: string;
  /** 点章名 → 跳章（上层负责就地切换 + 关窗） */
  onSelect: (chapterId: string) => void;
  /** 弹层高度（由宿主按窗高给定，组件不自己猜窗口） */
  height: number;
}

function ChapterTocSheetBase({
  visible,
  onClose,
  items,
  currentChapterId,
  onSelect,
  height,
}: ChapterTocSheetProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors: ThemeColors = getColors(theme);

  const initialIndex = useMemo(
    () => tocInitialIndex(items, currentChapterId),
    [items, currentChapterId],
  );

  /** 行高恒定 ⇒ 纯算式定位（无表） */
  const getItemLayout = useCallback(
    (_data: ArrayLike<TocItem> | null | undefined, index: number) => ({
      length: TOC_ROW_H,
      offset: TOC_ROW_H * index,
      index,
    }),
    [],
  );

  const currentBg = useMemo(() => withAlpha(colors.primary, 0.12), [colors]);

  const renderItem = useCallback(
    ({ item }: { item: TocItem }) => {
      const isCurrent = item.id === currentChapterId;
      return (
        <Pressable
          accessibilityLabel={item.title}
          onPress={() => onSelect(item.id)}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: colors.border },
            isCurrent ? { backgroundColor: currentBg } : null,
            pressed ? { opacity: 0.6 } : null,
          ]}
        >
          <Text
            style={[styles.ordinal, { color: isCurrent ? colors.primary : colors.textSecondary }]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            {String(item.index + 1)}
          </Text>
          <Text
            style={[
              styles.title,
              { color: colors.text },
              isCurrent ? { color: colors.primary, fontWeight: '600' } : null,
            ]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            {item.title}
          </Text>
          {isCurrent ? (
            <Text style={[styles.badge, { color: colors.primary }]} allowFontScaling={false}>
              当前
            </Text>
          ) : null}
        </Pressable>
      );
    },
    [colors, currentChapterId, currentBg, onSelect],
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={`目录 · ${items.length} 章`} height={height}>
      {visible ? (
        <FlatList<TocItem>
          data={items as TocItem[]}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          initialScrollIndex={initialIndex}
          onScrollToIndexFailed={(info) => {
            // 有 getItemLayout ⇒ 正常不会触发；防御式兜底避免异常态下卡死在别处
            void info;
          }}
          style={styles.list}
        />
      ) : (
        <View style={styles.list} />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  row: {
    height: TOC_ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ordinal: {
    width: 44,
    fontSize: 12,
    includeFontPadding: false,
  },
  title: {
    flex: 1,
    fontSize: 15,
    includeFontPadding: false,
  },
  badge: {
    marginLeft: 8,
    fontSize: 11,
    includeFontPadding: false,
  },
});

/** 目录弹层 */
export const ChapterTocSheet = React.memo(ChapterTocSheetBase);

export default ChapterTocSheet;
