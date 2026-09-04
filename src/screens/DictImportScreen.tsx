/**
 * 字典导入页（DictImportScreen）
 * 三步流转：① 选择文件（pickDictFiles 多选；普通词典单文件、StarDict 三件套成组）→
 * ② 导入中（进度计数 + 可取消）→
 * ③ 完成摘要（总数/失败数/耗时/错误列表 + 设为默认字典 / 立即查一个字）。
 * 免责声明：导入的字典文件由用户自行提供，内容与版权责任由用户自负。
 */
import React, { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppStackParamList } from '@/navigation/types';
import type { ImportReport } from '@/types/dict';
import { DictFileService, type PickedDictFile } from '@/services/dict/DictFileService';
import { DictImportService } from '@/services/dict/DictImportService';
import { useDictStore } from '@/store/useDictStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

type Props = NativeStackScreenProps<AppStackParamList, 'DictImport'>;

/** 支持的格式说明（展示用） */
const FORMAT_HINTS = [
  { format: 'MDX', desc: 'MDict 词典（encrypt 0/1/2、zlib/无压缩）' },
  { format: 'MDD', desc: 'MDict 资源包（图片/音频，单文件 ≤1MB）' },
  { format: 'CSV/TSV', desc: '两列或带表头（字头,拼音,释义,例句…）' },
  { format: 'JSON', desc: '对象数组 [{headword, pinyin, meaning, …}]' },
  { format: 'TXT', desc: '一行一条：`字头：释义`（可选〈拼音〉前缀）' },
  { format: 'StarDict', desc: '.ifo + .idx(.dz) + .dict(.dz) 三件套成组多选导入' },
];

/** 已展示的错误行数上限（其余聚合计数） */
const VISIBLE_ERRORS = 20;

/** 是否为 StarDict 成组选择（含 .ifo 时按三件套成组导入） */
function hasIfo(files: PickedDictFile[]): boolean {
  return files.some((f) => f.fileName.toLowerCase().endsWith('.ifo'));
}

export default function DictImportScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const [picked, setPicked] = useState<PickedDictFile[]>([]);
  const [running, setRunning] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const cancelledRef = useRef(false);
  const setDefaultDict = useDictStore((s) => s.setDefaultDict);

  /** 第一步：选择文件（多选；单文件=普通词典，.ifo+.idx+.dict=StarDict 成组） */
  const handlePick = useCallback(async (): Promise<void> => {
    const res = await DictFileService.pickDictFiles();
    if (!res.success || !res.data || res.data.length === 0) {
      if (res.error && res.error !== '已取消选择文件') {
        Alert.alert('选择文件失败', res.error);
      }
      return;
    }
    setPicked(res.data);
    setReport(null);
    setEntryCount(0);
    setShowErrors(false);
  }, []);

  /** 第二步：执行导入（含 .ifo 走 StarDict 成组，否则单文件分发） */
  const handleImport = useCallback(async (): Promise<void> => {
    if (picked.length === 0 || running) {
      return;
    }
    cancelledRef.current = false;
    setRunning(true);
    setEntryCount(0);
    setReport(null);

    const opts = {
      onProgress: (count: number) => setEntryCount(count),
      isCancelled: () => cancelledRef.current,
    };
    const res = hasIfo(picked)
      ? await DictImportService.importStarDict(picked, opts)
      : await DictImportService.importFromFile(picked[0], opts);

    setRunning(false);
    if (res.success && res.data) {
      setReport(res.data);
    } else {
      // 取消或失败：展示原因（data 可能携带报告）
      if (res.data) {
        setReport(res.data);
      }
      Alert.alert(
        res.data?.cancelled ? '导入已取消' : '导入失败',
        res.error ?? '未知错误（半成品数据已清理）',
      );
    }
  }, [picked, running]);

  const handleCancel = useCallback((): void => {
    cancelledRef.current = true;
  }, []);

  /** 第三步：完成摘要动作 */
  const handleSetDefault = useCallback((): void => {
    if (report) {
      setDefaultDict(report.dictId);
      Alert.alert('已设为默认', '查字页将优先聚焦该字典的释义分节');
    }
  }, [report, setDefaultDict]);

  const handleLookupNow = useCallback((): void => {
    navigation.navigate('DictLookup', { headword: '学' });
  }, [navigation]);

  const handleReset = useCallback((): void => {
    setPicked([]);
    setReport(null);
    setEntryCount(0);
    setShowErrors(false);
  }, []);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <Text style={[styles.title, { color: colors.text }]}>导入字典</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        从本地文件导入自定义词典，导入后可在管理页启停与排序
      </Text>

      {/* 支持格式说明 */}
      <View style={[styles.hintBox, { backgroundColor: colors.card }]}>
        <Text style={[styles.hintTitle, { color: colors.text }]}>支持的格式</Text>
        {FORMAT_HINTS.map((h) => (
          <Text key={h.format} style={[styles.hintLine, { color: colors.textSecondary }]}>
            <Text style={{ fontWeight: '700' }}>{h.format}</Text>
            {`　${h.desc}`}
          </Text>
        ))}
        <Text style={[styles.disclaimer, { color: colors.pinyin }]}>
          免责声明：导入文件由您自行提供，其内容与版权责任由您自负；请仅导入有权使用的词典数据。
        </Text>
      </View>

      {/* 第一步：选择文件 */}
      {!running && !report ? (
        <View style={styles.section}>
          {picked.length > 0 ? (
            <View style={[styles.fileBox, { borderColor: colors.primary }]}>
              <Text style={[styles.fileIcon, { color: colors.primary }]}>
                {hasIfo(picked) ? '📚' : '📄'}
              </Text>
              <View style={styles.fileMeta}>
                {picked.map((f) => (
                  <Text key={f.uri} style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
                    {f.fileName}
                  </Text>
                ))}
                <Text style={[styles.fileSize, { color: colors.textSecondary }]}>
                  {picked.length > 1
                    ? `${picked.length} 个文件 · 共 ${(picked.reduce((sum, f) => sum + f.size, 0) / 1024).toFixed(1)} KB`
                    : picked[0].size > 0
                      ? `${(picked[0].size / 1024).toFixed(1)} KB`
                      : '大小未知'}
                </Text>
              </View>
              <Pressable onPress={handlePick} hitSlop={8} accessibilityRole="button" accessibilityLabel="重新选择文件">
                <Text style={[styles.repick, { color: colors.primary }]}>重选</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
            ]}
            onPress={handlePick}
            accessibilityRole="button"
            accessibilityLabel="选择字典文件"
          >
            <Text style={styles.primaryButtonText}>
              {picked.length > 0 ? '选择其他文件' : '选择字典文件'}
            </Text>
          </Pressable>
          {picked.length > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                { borderColor: colors.primary, borderWidth: 1, backgroundColor: 'transparent' },
                pressed && styles.pressed,
              ]}
              onPress={handleImport}
              accessibilityRole="button"
              accessibilityLabel="开始导入"
            >
              <Text style={[styles.primaryButtonText, { color: colors.primary }]}>开始导入</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* 第二步：导入中 */}
      {running ? (
        <View style={[styles.progressBox, { borderColor: colors.border }]}>
          <Text style={[styles.progressTitle, { color: colors.text }]} numberOfLines={2}>
            正在导入 {picked.length > 1 ? `${picked[0].fileName} 等 ${picked.length} 个文件` : (picked[0]?.fileName ?? '')}
          </Text>
          <Text style={[styles.progressCount, { color: colors.primary }]}>
            已解析 {entryCount} 词条
          </Text>
          <Text style={[styles.progressHint, { color: colors.textSecondary }]}>
            大文件导入可能需要数十秒，请保持应用在前台
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.cancelButton,
              { borderColor: colors.accent },
              pressed && styles.pressed,
            ]}
            onPress={handleCancel}
            accessibilityRole="button"
            accessibilityLabel="取消导入"
          >
            <Text style={[styles.cancelButtonText, { color: colors.accent }]}>取消导入</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 第三步：完成摘要 */}
      {report ? (
        <View style={[styles.reportBox, { borderColor: colors.border }]}>
          <Text style={[styles.reportTitle, { color: colors.text }]}>
            {report.cancelled ? '导入已取消' : '导入完成'}
          </Text>
          <View style={styles.reportRow}>
            <Text style={[styles.reportLabel, { color: colors.textSecondary }]}>词条总数</Text>
            <Text style={[styles.reportValue, { color: colors.text }]}>{report.totalEntries}</Text>
          </View>
          <View style={styles.reportRow}>
            <Text style={[styles.reportLabel, { color: colors.textSecondary }]}>失败条数</Text>
            <Text style={[styles.reportValue, { color: colors.text }]}>{report.failedCount}</Text>
          </View>
          <View style={styles.reportRow}>
            <Text style={[styles.reportLabel, { color: colors.textSecondary }]}>耗时</Text>
            <Text style={[styles.reportValue, { color: colors.text }]}>
              {`${(report.elapsedMs / 1000).toFixed(1)} 秒`}
            </Text>
          </View>

          {report.warnings && report.warnings.length > 0 ? (
            <View style={styles.warningSection}>
              {report.warnings.map((w, i) => (
                <Text key={`warn-${i}`} style={[styles.warningLine, { color: colors.pinyin }]}>
                  {`⚠ ${w}`}
                </Text>
              ))}
            </View>
          ) : null}

          {report.errors.length > 0 ? (
            <View style={styles.errorSection}>
              <Pressable
                onPress={() => setShowErrors((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel="展开错误列表"
              >
                <Text style={[styles.errorToggle, { color: colors.accent }]}>
                  {showErrors ? '收起错误列表' : `展开错误列表（${report.errors.length} 条）`}
                </Text>
              </Pressable>
              {showErrors ? (
                <View style={[styles.errorList, { borderColor: colors.border }]}>
                  {report.errors.slice(0, VISIBLE_ERRORS).map((e, i) => (
                    <Text key={`err-${i}`} style={[styles.errorLine, { color: colors.textSecondary }]}>
                      {`${e.at !== undefined ? `[${e.at}] ` : ''}${e.reason}`}
                    </Text>
                  ))}
                  {report.errors.length > VISIBLE_ERRORS ? (
                    <Text style={[styles.errorLine, { color: colors.textSecondary }]}>
                      {`… 其余 ${report.errors.length - VISIBLE_ERRORS} 条略`}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.reportActions}>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary },
                pressed && styles.pressed,
              ]}
              onPress={handleSetDefault}
              accessibilityRole="button"
              accessibilityLabel="设为默认字典"
            >
              <Text style={styles.primaryButtonText}>设为默认字典</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                { borderColor: colors.primary, borderWidth: 1, backgroundColor: 'transparent' },
                pressed && styles.pressed,
              ]}
              onPress={handleLookupNow}
              accessibilityRole="button"
              accessibilityLabel="立即查一个字"
            >
              <Text style={[styles.primaryButtonText, { color: colors.primary }]}>立即查一个字</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
              onPress={handleReset}
              accessibilityRole="button"
              accessibilityLabel="继续导入下一个"
            >
              <Text style={[styles.linkButtonText, { color: colors.textSecondary }]}>
                继续导入下一个
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    paddingHorizontal: 16,
  },
  subtitle: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  hintBox: {
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  hintTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  hintLine: {
    fontSize: 12,
    lineHeight: 18,
  },
  disclaimer: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 10,
  },
  fileBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  fileIcon: {
    fontSize: 24,
  },
  fileMeta: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
  },
  fileSize: {
    fontSize: 12,
    marginTop: 2,
  },
  repick: {
    fontSize: 13,
    padding: 4,
  },
  primaryButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  progressBox: {
    marginHorizontal: 16,
    marginTop: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 8,
  },
  progressTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  progressCount: {
    fontSize: 20,
    fontWeight: '700',
  },
  progressHint: {
    fontSize: 12,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 4,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  reportBox: {
    marginHorizontal: 16,
    marginTop: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 10,
  },
  reportTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  reportRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  reportLabel: {
    fontSize: 13,
  },
  reportValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  warningSection: {
    gap: 4,
  },
  warningLine: {
    fontSize: 12,
    lineHeight: 17,
  },
  errorSection: {
    gap: 6,
  },
  errorToggle: {
    fontSize: 13,
    fontWeight: '600',
  },
  errorList: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    gap: 2,
  },
  errorLine: {
    fontSize: 11,
    lineHeight: 16,
  },
  reportActions: {
    gap: 10,
    marginTop: 4,
  },
  linkButton: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  linkButtonText: {
    fontSize: 13,
  },
  pressed: {
    opacity: 0.7,
  },
});
