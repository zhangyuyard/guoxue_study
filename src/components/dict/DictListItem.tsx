/**
 * 字典管理列表项（DictListItem）
 * 行内容：字典名 + 元信息（来源/格式/词条数/大小）+ 启停开关 + 排序按钮 +
 * 默认字典单选 + 用户字典删除；多音字读音来源单选。
 */
import React from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { DictMeta } from '@/types/dict';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

export interface DictListItemProps {
  dict: DictMeta;
  index: number;
  total: number;
  isDefault: boolean;
  isPolyphoneSource: boolean;
  onToggle: (enabled: boolean) => void;
  onMove: (direction: 'up' | 'down') => void;
  onSetDefault: () => void;
  onSetPolyphoneSource: () => void;
  onDelete: () => void;
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(0)}KB`;
  }
  return `${sizeBytes}B`;
}

/** 语向标示：zh-en → 中 → 英；en-zh → 英 → 中；缺省 → 中文（单语） */
function langPairLabel(langPair?: string): string {
  if (langPair === 'zh-en') {
    return '中 → 英';
  }
  if (langPair === 'en-zh') {
    return '英 → 中';
  }
  return '中文';
}

function DictListItem({
  dict,
  index,
  total,
  isDefault,
  isPolyphoneSource,
  onToggle,
  onMove,
  onSetDefault,
  onSetPolyphoneSource,
  onDelete,
}: DictListItemProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const confirmDelete = (): void => {
    Alert.alert('删除字典', `确定删除「${dict.name}」？词条数据将被清除，不可恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <View style={[styles.item, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* 第一行：名称 + 启停 */}
      <View style={styles.row}>
        <View style={styles.nameWrap}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: dict.enabled ? colors.text : colors.textSecondary }]} numberOfLines={1}>
              {dict.name}
            </Text>
            <Text style={[styles.langBadge, { color: colors.textSecondary }]}>{langPairLabel(dict.langPair)}</Text>
          </View>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {`${dict.kind === 'native' ? '原生' : '用户'} · ${dict.format.toUpperCase()} · ${dict.entryCount} 词条`}
            {dict.sizeBytes ? ` · ${formatSize(dict.sizeBytes)}` : ''}
          </Text>
        </View>
        <Switch
          value={dict.enabled}
          onValueChange={onToggle}
          trackColor={{ false: colors.border, true: colors.primary }}
          accessibilityLabel={`「${dict.name}」参与查询开关（关闭后该字典不参与查词）`}
        />
      </View>

      {/* 第二行：排序 + 默认 + 多音字来源 + 删除 */}
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.smallButton, { borderColor: colors.border }]}
          disabled={index === 0}
          onPress={() => onMove('up')}
          accessibilityRole="button"
          accessibilityLabel="上移字典"
        >
          <Text style={[styles.smallButtonText, { color: index === 0 ? colors.border : colors.text }]}>上移</Text>
        </Pressable>
        <Pressable
          style={[styles.smallButton, { borderColor: colors.border }]}
          disabled={index === total - 1}
          onPress={() => onMove('down')}
          accessibilityRole="button"
          accessibilityLabel="下移字典"
        >
          <Text style={[styles.smallButtonText, { color: index === total - 1 ? colors.border : colors.text }]}>下移</Text>
        </Pressable>
        <Pressable
          style={[styles.smallButton, isDefault ? { backgroundColor: colors.primarySoft } : { borderColor: colors.border }]}
          onPress={onSetDefault}
          accessibilityRole="button"
          accessibilityLabel="设为默认字典"
        >
          <Text style={[styles.smallButtonText, { color: isDefault ? colors.primary : colors.textSecondary }]}>
            {isDefault ? '✓ 默认' : '设为默认'}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.smallButton,
            isPolyphoneSource ? { backgroundColor: colors.primarySoft } : { borderColor: colors.border },
          ]}
          onPress={onSetPolyphoneSource}
          accessibilityRole="button"
          accessibilityLabel="设为多音字读音来源"
        >
          <Text style={[styles.smallButtonText, { color: isPolyphoneSource ? colors.primary : colors.textSecondary }]}>
            {isPolyphoneSource ? '✓ 读音来源' : '读音来源'}
          </Text>
        </Pressable>
        {dict.kind === 'user' ? (
          <Pressable
            style={[styles.smallButton, { borderColor: colors.accent }]}
            onPress={confirmDelete}
            accessibilityRole="button"
            accessibilityLabel="删除字典"
          >
            <Text style={[styles.smallButtonText, { color: colors.accent }]}>删除</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  nameWrap: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
  },
  langBadge: {
    fontSize: 11,
    lineHeight: 15,
  },
  meta: {
    fontSize: 12,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  smallButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  smallButtonText: {
    fontSize: 12,
  },
});

export default DictListItem;
