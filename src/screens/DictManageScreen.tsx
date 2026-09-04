/**
 * 字典管理页（DictManageScreen）
 * - 字典列表：启停 / 上下移排序（立即影响 lookup 顺序）/ 默认字典 / 用户字典删除（确认弹窗）
 * - 多音字读音来源：内置规则库 / 各启用字典（切换后清阅读器注音缓存并重算当前段）
 * - 导入入口 → DictImportScreen
 */
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable } from 'react-native';
import type { AppStackParamList } from '@/navigation/types';
import type { DictMeta, PolyphoneSource } from '@/types/dict';
import { DictEngine } from '@/services/dict/DictEngine';
import DictListItem from '@/components/dict/DictListItem';
import { useDictStore } from '@/store/useDictStore';
import { useReaderStore } from '@/store/useReaderStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

type Props = NativeStackScreenProps<AppStackParamList, 'DictManage'>;

/** CC-CEDICT 系词典（构建期 id 前缀 cedict-；无 readings 注音数据，判音将回退内置规则） */
function isCedictDict(dict: DictMeta): boolean {
  return dict.id.startsWith('cedict-') || dict.name.includes('CC-CEDICT');
}

export default function DictManageScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const [dicts, setDicts] = useState<DictMeta[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const defaultDictId = useDictStore((s) => s.defaultDictId);
  const polyphoneSource = useDictStore((s) => s.polyphoneSource);
  const setEnabled = useDictStore((s) => s.setEnabled);
  const reorder = useDictStore((s) => s.reorder);
  const setDefaultDict = useDictStore((s) => s.setDefaultDict);
  const setPolyphoneSource = useDictStore((s) => s.setPolyphoneSource);

  /** 进入页面 / 本页操作后刷新列表（元数据 × store 设置的合并视图） */
  const refresh = useCallback((): void => {
    const res = DictEngine.listDicts();
    if (res.success && res.data) {
      setDicts(res.data);
    }
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const applyChange = useCallback(
    (mutate: () => void): void => {
      mutate();
      setRefreshTick((t) => t + 1);
      refresh();
    },
    [refresh],
  );

  /** 切换多音字来源：清阅读器注音缓存（阅读器经 usePinyin 的盐值依赖即时重算当前段） */
  const changePolyphoneSource = useCallback(
    (src: PolyphoneSource): void => {
      setPolyphoneSource(src);
      useReaderStore.getState().clearAnnotationCache();
      setRefreshTick((t) => t + 1);
      refresh();
    },
    [refresh, setPolyphoneSource],
  );

  const handleDelete = useCallback(
    (dictId: string): void => {
      const res = DictEngine.deleteDict(dictId);
      if (res.success) {
        refresh();
      }
    },
    [refresh],
  );

  const enabledDicts = dicts.filter((d) => d.enabled);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: colors.text }]}>字典管理</Text>
        <Pressable
          style={({ pressed }) => [
            styles.importButton,
            { backgroundColor: colors.primary },
            pressed && styles.pressed,
          ]}
          onPress={() => navigation.navigate('DictImport')}
          accessibilityRole="button"
          accessibilityLabel="导入字典"
        >
          <Text style={styles.importButtonText}>＋ 导入字典</Text>
        </Pressable>
      </View>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        调整启停与顺序，查询结果按当前顺序展示（排前者优先）
      </Text>

      {/* 字典列表 */}
      <View style={styles.listWrap}>
        {dicts.map((dict, index) => (
          <DictListItem
            key={`${dict.id}-${refreshTick}`}
            dict={dict}
            index={index}
            total={dicts.length}
            isDefault={defaultDictId === dict.id}
            isPolyphoneSource={polyphoneSource.type === 'dict' && polyphoneSource.dictId === dict.id}
            onToggle={(enabled) => applyChange(() => setEnabled(dict.id, enabled))}
            onMove={(direction) => applyChange(() => reorder(dict.id, direction))}
            onSetDefault={() => applyChange(() => setDefaultDict(dict.id))}
            onSetPolyphoneSource={() =>
              changePolyphoneSource(
                polyphoneSource.type === 'dict' && polyphoneSource.dictId === dict.id
                  ? { type: 'builtin' }
                  : { type: 'dict', dictId: dict.id },
              )
            }
            onDelete={() => handleDelete(dict.id)}
          />
        ))}
        {dicts.length === 0 ? (
          <View style={[styles.emptyBox, { borderColor: colors.border }]}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              暂无字典（引擎可能未初始化完成）
            </Text>
          </View>
        ) : null}
      </View>

      {/* 多音字读音来源 */}
      <Text style={[styles.sectionTitle, { color: colors.text }]}>多音字读音来源</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        选择阅读器注音时多音字的判音依据；切换后清空注音缓存并即时重算
      </Text>
      <View style={styles.listWrap}>
        <Pressable
          style={[
            styles.sourceItem,
            { borderColor: colors.border, backgroundColor: colors.card },
            polyphoneSource.type === 'builtin' && { borderColor: colors.primary },
          ]}
          onPress={() => changePolyphoneSource({ type: 'builtin' })}
          accessibilityRole="button"
          accessibilityLabel="使用内置规则库判音"
        >
          <Text style={[styles.sourceName, { color: colors.text }]}>内置规则库</Text>
          <Text style={[styles.sourceDesc, { color: colors.textSecondary }]}>
            polyphone-rules.json 语境规则 + pinyin-pro 兜底（默认）
          </Text>
          <Text style={[styles.sourceState, { color: colors.primary }]}>
            {polyphoneSource.type === 'builtin' ? '✓ 使用中' : ''}
          </Text>
        </Pressable>
        {enabledDicts.map((dict) => (
          <Pressable
            key={dict.id}
            style={[
              styles.sourceItem,
              { borderColor: colors.border, backgroundColor: colors.card },
              polyphoneSource.type === 'dict' && polyphoneSource.dictId === dict.id && { borderColor: colors.primary },
            ]}
            onPress={() => changePolyphoneSource({ type: 'dict', dictId: dict.id })}
            accessibilityRole="button"
            accessibilityLabel={`使用字典 ${dict.name} 判音`}
          >
            <Text style={[styles.sourceName, { color: colors.text }]}>{dict.name}</Text>
            <Text style={[styles.sourceDesc, { color: colors.textSecondary }]}>
              按该字典义项书证/例句语境匹配读音（未命中回退内置规则）
            </Text>
            {isCedictDict(dict) ? (
              <Text style={[styles.sourceHint, { color: colors.textSecondary }]}>
                CC-CEDICT 无注音数据时将自动回退内置判音
              </Text>
            ) : null}
            <Text style={[styles.sourceState, { color: colors.primary }]}>
              {polyphoneSource.type === 'dict' && polyphoneSource.dictId === dict.id ? '✓ 使用中' : ''}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* 授权信息（CC BY-SA 等许可署名要求） */}
      {dicts.some((d) => d.license) ? (
        <>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>授权信息</Text>
          <View style={styles.listWrap}>
            {dicts
              .filter((d) => d.license)
              .map((d) => (
                <View
                  key={`lic-${d.id}`}
                  style={[styles.licenseItem, { borderColor: colors.border }]}
                >
                  <Text style={[styles.licenseName, { color: colors.text }]}>
                    {`${d.name}${d.langPair ? `（${d.langPair}）` : ''}`}
                  </Text>
                  <Text style={[styles.licenseText, { color: colors.textSecondary }]}>
                    {d.license}
                  </Text>
                  {d.description ? (
                    <Text style={[styles.licenseText, { color: colors.textSecondary }]}>
                      {d.description}
                    </Text>
                  ) : null}
                </View>
              ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
  },
  importButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  importButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  listWrap: {
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 8,
  },
  emptyBox: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 2,
  },
  sourceItem: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 2,
  },
  sourceName: {
    fontSize: 14,
    fontWeight: '600',
  },
  sourceDesc: {
    fontSize: 12,
  },
  sourceHint: {
    fontSize: 11,
    lineHeight: 15,
  },
  sourceState: {
    fontSize: 12,
    fontWeight: '600',
  },
  licenseItem: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 4,
  },
  licenseName: {
    fontSize: 13,
    fontWeight: '600',
  },
  licenseText: {
    fontSize: 11,
    lineHeight: 16,
  },
  pressed: {
    opacity: 0.7,
  },
});
