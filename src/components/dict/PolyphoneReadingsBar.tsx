/**
 * 多音字读音条（PolyphoneReadingsBar）
 * 内置规则库 ∪ 字典 readings（经 PinyinService.getPolyphoneReadings）候选展示。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PinyinService } from '@/services/PinyinService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

export interface PolyphoneReadingsBarProps {
  /** 单字（多字/空则不渲染） */
  char: string;
}

function PolyphoneReadingsBar({ char }: PolyphoneReadingsBarProps): React.JSX.Element | null {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const readings = useMemo(() => {
    if (Array.from(char).length !== 1) {
      return [];
    }
    return PinyinService.getPolyphoneReadings(char);
  }, [char]);

  if (readings.length === 0) {
    return null;
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>多音字</Text>
      <View style={styles.chipRow}>
        {readings.map((r) => (
          <View key={r} style={[styles.chip, { backgroundColor: colors.primarySoft }]}>
            <Text style={[styles.chipText, { color: colors.primary }]}>{r}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  label: {
    fontSize: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  chipText: {
    fontSize: 13,
  },
});

export default PolyphoneReadingsBar;
