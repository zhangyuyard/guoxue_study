/**
 * 阅读器底部工具栏（ReaderToolbar）
 * 横排四个操作：划线（展开三色选择）/ 笔记 / 收藏 / 背诵。
 * 划线按钮点击展开黄/绿/蓝三色圆点选择层，选定后回调 onHighlight(color)。
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { HighlightColor } from '@/types';

import { useSettingsStore } from '@/store/useSettingsStore';
import { getPaperColors, type ThemeColors } from '@/theme';

/** 三色圆点的不透明实色（highlightColors 为半透明背景色，不适合作圆点指示） */
const COLOR_DOTS: Record<HighlightColor, string> = {
  yellow: '#F5D742',
  green: '#4CAF50',
  blue: '#2196F3',
};

const COLOR_ORDER: HighlightColor[] = ['yellow', 'green', 'blue'];

export interface ReaderToolbarProps {
  /** 选定划线颜色后回调 */
  onHighlight: (color: HighlightColor) => void;
  /** 笔记按钮回调 */
  onNote: () => void;
  /** 收藏按钮回调 */
  onBookmark: () => void;
  /** 背诵按钮回调 */
  onRecite: () => void;
  /** 当前划线默认色（用于圆点选中态展示） */
  highlightColor?: HighlightColor;
}

/** 工具栏单个按钮 */
function ToolbarButton({
  label,
  active,
  colors,
  onPress,
}: {
  label: string;
  active?: boolean;
  colors: ThemeColors;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.dot, { backgroundColor: active ? colors.primary : colors.border }]} />
      <Text style={[styles.buttonLabel, { color: active ? colors.primary : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function ReaderToolbar({
  onHighlight,
  onNote,
  onBookmark,
  onRecite,
  highlightColor = 'yellow',
}: ReaderToolbarProps): React.JSX.Element {
  const paper = useSettingsStore((s) => s.paper);
  const colors: ThemeColors = getPaperColors(paper);

  const [pickerOpen, setPickerOpen] = useState(false);

  const handlePickColor = (color: HighlightColor): void => {
    setPickerOpen(false);
    onHighlight(color);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
      {/* 划线三色选择层 */}
      {pickerOpen ? (
        <View style={[styles.picker, { backgroundColor: colors.background }]}>
          {COLOR_ORDER.map((color) => (
            <Pressable
              key={color}
              style={({ pressed }) => [styles.colorDotWrap, pressed && styles.buttonPressed]}
              onPress={() => handlePickColor(color)}
              accessibilityRole="button"
              accessibilityLabel={`使用${color}颜色划线`}
            >
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: COLOR_DOTS[color] },
                  highlightColor === color ? { borderColor: colors.text } : { borderColor: 'transparent' },
                ]}
              />
            </Pressable>
          ))}
          <Pressable
            style={({ pressed }) => [styles.pickerClose, pressed && styles.buttonPressed]}
            onPress={() => setPickerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="收起颜色选择"
          >
            <Text style={[styles.pickerCloseText, { color: colors.textSecondary }]}>收起</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.buttonRow}>
        <ToolbarButton
          label="划线"
          active={pickerOpen}
          colors={colors}
          onPress={() => setPickerOpen((open) => !open)}
        />
        <ToolbarButton label="笔记" colors={colors} onPress={onNote} />
        <ToolbarButton label="收藏" colors={colors} onPress={onBookmark} />
        <ToolbarButton label="背诵" colors={colors} onPress={onRecite} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  buttonPressed: {
    opacity: 0.6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginBottom: 4,
  },
  buttonLabel: {
    fontSize: 13,
  },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 16,
  },
  colorDotWrap: {
    padding: 6,
  },
  colorDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
  },
  pickerClose: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pickerCloseText: {
    fontSize: 13,
  },
});

export default ReaderToolbar;
