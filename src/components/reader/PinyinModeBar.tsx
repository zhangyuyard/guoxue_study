/**
 * 注音模式切换条（PinyinModeBar）
 * 三段式分段按钮：全文注音 / 仅生僻字 / 关闭。选中态高亮。
 * 由使用方决定浮动定位（阅读器中置于底部工具栏上方）。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PinyinMode } from '@/types';

import { useSettingsStore } from '@/store/useSettingsStore';
import { getPaperColors, type ThemeColors } from '@/theme';

const MODES: { key: PinyinMode; label: string }[] = [
  { key: 'full', label: '全文注音' },
  { key: 'rare', label: '仅生僻字' },
  { key: 'off', label: '关闭' },
];

export interface PinyinModeBarProps {
  /** 当前注音模式 */
  mode: PinyinMode;
  /** 切换模式回调 */
  onChange: (mode: PinyinMode) => void;
}

function PinyinModeBar({ mode, onChange }: PinyinModeBarProps): React.JSX.Element {
  const paper = useSettingsStore((s) => s.paper);
  const colors: ThemeColors = getPaperColors(paper);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      accessibilityRole="tablist"
    >
      {MODES.map((item) => {
        const active = item.key === mode;
        return (
          <Pressable
            key={item.key}
            style={({ pressed }) => [
              styles.segment,
              active ? { backgroundColor: colors.primarySoft } : null,
              pressed ? styles.segmentPressed : null,
            ]}
            onPress={() => onChange(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={item.label}
          >
            <Text
              style={[
                styles.segmentLabel,
                { color: active ? colors.primary : colors.textSecondary },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
    alignSelf: 'center',
  },
  segment: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
  },
  segmentPressed: {
    opacity: 0.7,
  },
  segmentLabel: {
    fontSize: 13,
  },
});

export default PinyinModeBar;
