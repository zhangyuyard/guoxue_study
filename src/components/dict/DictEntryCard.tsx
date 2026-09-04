/**
 * 字典词条卡片（DictEntryCard）
 * 查字结果页的字典分节：字典名 + 来源标签（原生/用户）+ 拼音 + EntryContent 三模式内容。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DictEntry, DictMeta } from '@/types/dict';
import EntryContent from '@/components/dict/EntryContent';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

export interface DictEntryCardProps {
  dict: DictMeta;
  /** null 表示该字典未收录 */
  entry: DictEntry | null;
  /** 默认字典（高亮标签） */
  isDefault?: boolean;
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

function DictEntryCard({ dict, entry, isDefault }: DictEntryCardProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.dictName, { color: colors.text }]} numberOfLines={1}>
          {dict.name}
        </Text>
        <View style={styles.badgeRow}>
          {isDefault ? (
            <View style={[styles.badge, { backgroundColor: colors.primary }]}>
              <Text style={styles.badgeText}>默认</Text>
            </View>
          ) : null}
          <View
            style={[
              styles.badge,
              dict.kind === 'native'
                ? { backgroundColor: colors.primarySoft }
                : { backgroundColor: colors.inputBackground },
            ]}
          >
            <Text style={[styles.badgeText, { color: colors.primary }]}>
              {dict.kind === 'native' ? '原生' : '用户'}
            </Text>
          </View>
        </View>
      </View>

      {entry ? (
        <View style={styles.body}>
          {entry.pinyin ? (
            <Text style={[styles.pinyin, { color: colors.pinyin }]}>{entry.pinyin}</Text>
          ) : null}
          <EntryContent contentType={entry.contentType} content={entry.content} />
        </View>
      ) : (
        <Text style={[styles.missText, { color: colors.textSecondary }]}>未收录该字头</Text>
      )}

      <View style={styles.footer}>
        <Text style={[styles.metaText, { color: colors.textSecondary }]}>
          {`${dict.format.toUpperCase()} · ${dict.entryCount} 词条`}
          {dict.sizeBytes ? ` · ${formatSize(dict.sizeBytes)}` : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dictName: {
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: 11,
    color: '#FFFFFF',
  },
  body: {
    gap: 6,
  },
  pinyin: {
    fontSize: 14,
  },
  missText: {
    fontSize: 13,
    paddingVertical: 4,
  },
  footer: {
    alignItems: 'flex-end',
  },
  metaText: {
    fontSize: 11,
  },
});

export default DictEntryCard;
