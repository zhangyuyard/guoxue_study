/**
 * 我的页（ProfileScreen）
 * 功能入口卡片（收藏/笔记/背诵进度/导出数据）+ 设置列表
 * （字号 4 档 / 行距 3 档 / 日夜间主题 / 注音模式 / 繁简偏好 / 关于）。
 * 设置项全部经 useSettingsStore 持久化（zustand persist + MMKV）。
 */
import React, { useCallback, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { PinyinMode } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import type { MainTabParamList } from '@/navigation/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { TRANSLATION_PROVIDERS } from '@/types/translation';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useLibraryStore } from '@/store/useLibraryStore';
import { useReaderStore } from '@/store/useReaderStore';
import { useReadingOverrideStore } from '@/store/useReadingOverrideStore';
import { StorageService } from '@/services/StorageService';
import { UserBookService } from '@/services/UserBookService';
import {
  buildBackup,
  formatBackupStamp,
  parseBackup,
  pickSettingsSnapshot,
  summarizeBackup,
  type ParsedBackup,
} from '@/utils/backup';
import { ACHIEVEMENT_TOTAL } from '@/utils/achievements';
import { getColors, FONT_SIZE_OPTIONS, LINE_HEIGHT_OPTIONS, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Profile'>;

/**
 * 复制文本到剪贴板（运行时按需加载 @react-native-clipboard/clipboard）。
 * 通过 globalThis.require 访问 Metro 模块加载器（避免依赖 Node 全局类型）。
 */
function copyToClipboard(text: string): boolean {
  try {
    const g = globalThis as { require?: (id: string) => unknown };
    if (!g.require) {
      return false;
    }
    const mod = g.require('@react-native-clipboard/clipboard') as
      | { default?: { setString: (s: string) => void } }
      | { setString: (s: string) => void };
    const api =
      'default' in mod && mod.default
        ? mod.default
        : (mod as { setString: (s: string) => void });
    if (api?.setString) {
      api.setString(text);
      return true;
    }
  } catch {
    // 模块未安装
  }
  return false;
}

/** 分段选择行 */
function SegmentedRow<T extends string | number>({
  options,
  value,
  onChange,
  colors,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  colors: ReturnType<typeof getColors>;
}): React.JSX.Element {
  return (
    <View style={styles.segmentedRow}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={String(opt.value)}
            onPress={() => onChange(opt.value)}
            style={[
              styles.segmentedBtn,
              { backgroundColor: selected ? colors.primary : colors.card },
            ]}
            accessibilityState={{ selected }}
          >
            <Text
              style={[
                styles.segmentedText,
                { color: selected ? '#FFFFFF' : colors.textSecondary },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 设置分组标题 */
function SectionTitle({ title, colors }: { title: string; colors: ReturnType<typeof getColors> }): React.JSX.Element {
  return <Text style={[styles.sectionTitle, { color: colors.primary }]}>{title}</Text>;
}

export default function ProfileScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const tabNavigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();

  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const pinyinMode = useSettingsStore((s) => s.pinyinMode);
  const conversionMode = useSettingsStore((s) => s.conversionMode);
  const translation = useSettingsStore((s) => s.translation);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setLineHeight = useSettingsStore((s) => s.setLineHeight);
  const setPinyinMode = useSettingsStore((s) => s.setPinyinMode);
  const setConversionMode = useSettingsStore((s) => s.setConversionMode);
  const setTranslation = useSettingsStore((s) => s.setTranslation);

  /** 翻译设置弹层 */
  const [translationModal, setTranslationModal] = useState(false);

  /** 当前服务商的 Key 是否已配置（入口卡片角标展示） */
  const translationReady = TRANSLATION_PROVIDERS.some((p) => {
    if (p.id !== translation.provider) {
      return false;
    }
    if (p.id === 'baidu') {
      return Boolean(translation.baiduAppId.trim() && translation.baiduSecretKey.trim());
    }
    if (p.id === 'google') {
      return Boolean(translation.googleApiKey.trim());
    }
    return Boolean(translation.deeplApiKey.trim());
  });

  const bookmarkCount = useBookmarkStore((s) => s.bookmarks.length);
  const noteCount = useNoteStore((s) => s.notes.length);
  const recitationCount = useRecitationStore((s) => s.list.length);
  /** 已解锁成就数（P2-06，「我的成就」入口角标） */
  const unlockedCount = useAchievementStore((s) => Object.keys(s.unlockedAt).length);

  /** 导出数据：拼接收藏/笔记/背诵进度为 JSON 并复制 */
  const handleExport = useCallback(() => {
    const bookmarkStore = useBookmarkStore.getState();
    const noteStore = useNoteStore.getState();
    const recitationStore = useRecitationStore.getState();
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'guoxue_study_app',
      bookmarks: bookmarkStore.bookmarks,
      notes: noteStore.notes,
      recitation: recitationStore.list,
    };
    const text = JSON.stringify(payload, null, 2);
    if (copyToClipboard(text)) {
      Alert.alert(
        '导出成功',
        `共导出收藏 ${payload.bookmarks.length} 条、笔记 ${payload.notes.length} 条、背诵进度 ${payload.recitation.length} 条，已复制到剪贴板。`,
      );
    } else {
      Alert.alert(
        '导出预览',
        text.slice(0, 300) + '…（未安装剪贴板组件，请在收藏/笔记页查看明细）',
      );
    }
  }, []);

  // ---------- 备份与恢复（P2-15 本地版） ----------

  /**
   * 执行恢复：各 store restoreFromBackup（整体替换并持久化）→
   * 用户书恢复（合并语义：只增改不删）→ 刷新书架 → 成就重算 →
   * 划线恢复（幂等写入，非法条目跳过）→ 续读位置恢复 → 完成提示。
   * IO 异常不崩溃（try-catch 兜底提示）；划线/续读恢复失败降级，不阻断其它类目。
   */
  const applyBackupRestore = useCallback((parsed: ParsedBackup) => {
    void (async () => {
      let restoreWarning = '';
      try {
        useSettingsStore.getState().restoreFromBackup(parsed.data.settings);
        useRecitationStore.getState().restoreFromBackup(parsed.data.recitation);
        useBookmarkStore.getState().restoreFromBackup(parsed.data.bookmarks);
        useNoteStore.getState().restoreFromBackup(parsed.data.notes);
        useAchievementStore.getState().restoreFromBackup(parsed.data.achievements);
        // 用户读音纠正恢复（合并语义：按 char+context 幂等覆盖，设备独有的纠正保留）
        useReadingOverrideStore.getState().restoreFromBackup(
          parsed.data.readingOverrides,
        );
        // 用户书恢复：备份中的书按 id 幂等覆盖，设备独有的书保留（合并语义）
        await UserBookService.restoreUserBooks(parsed.data.userBooks);
        // 恢复后刷新书架（新增/覆盖的用户书需重新上屏；两段式装载，内置书目先立即可用）
        await useLibraryStore.getState().loadBooks();
        // 恢复后按新数据重算成就（幂等；备份里没有的成就按当前数据补齐解锁）
        useAchievementStore.getState().recompute();
      } catch (e) {
        Alert.alert('导入失败', `恢复数据时出错：${(e as Error).message ?? '未知错误'}`);
        return;
      }
      // 划线恢复：逐条幂等写入（非法条目已在 Service 内跳过计数）；失败降级提示
      try {
        const hlRes = StorageService.restoreHighlights(parsed.data.highlights);
        if (!hlRes.success) {
          restoreWarning = `\n\n划线恢复失败：${hlRes.error ?? '未知错误'}`;
        }
      } catch {
        restoreWarning = '\n\n划线恢复失败：未知错误';
      }
      // 续读位置恢复：解析层已校验，仅非 null 时写入（旧备份缺失则保留设备现值）；
      // 阅读页下次打开时生效，不强制跳转。失败降级，不阻断完成弹窗
      if (parsed.data.lastRead) {
        try {
          useReaderStore.getState().restoreLastRead(parsed.data.lastRead);
        } catch {
          // 降级：续读位置恢复失败不影响其它类目
        }
      }
      Alert.alert('导入成功', `已恢复数据：\n${summarizeBackup(parsed.data)}${restoreWarning}`);
    })();
  }, []);

  /** 导出备份：聚合五类数据写入 Documents 目录 JSON，成功后提示路径并复制到剪贴板 */
  const handleBackupExport = useCallback(() => {
    void (async () => {
      try {
        // 采集快照：设置走白名单函数字段（避免把方法序列化进备份）；
        // 用户书经 UserBookService 读取（内存列表与 db 一致，见 getAllBooks 注释）；
        // 划线经 StorageService 全量读取（getHighlights 无参 = 全表）；
        // 续读位置取 useReaderStore 持久化字段 lastRead；
        // 读音纠正取 useReadingOverrideStore（用户劳动成果，随备份走）
        const settingsState = useSettingsStore.getState();
        const snapshot = {
          settings: pickSettingsSnapshot(settingsState as unknown as Record<string, unknown>),
          recitation: useRecitationStore.getState().list,
          bookmarks: useBookmarkStore.getState().bookmarks,
          notes: useNoteStore.getState().notes,
          achievements: useAchievementStore.getState().unlockedAt,
          userBooks: UserBookService.getAllBooks(),
          highlights: StorageService.getHighlights().data ?? [],
          lastRead: useReaderStore.getState().lastRead,
          readingOverrides: useReadingOverrideStore.getState().overrides,
        };
        const text = buildBackup(snapshot);
        const fileName = `guoxue-backup-${formatBackupStamp(new Date())}.json`;
        const path = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        await RNFS.writeFile(path, text, 'utf8');
        copyToClipboard(path);
        Alert.alert(
          '备份成功',
          `备份文件已保存：\n${path}\n\n${summarizeBackup(snapshot)}\n\n文件路径已复制到剪贴板。`,
        );
      } catch (e) {
        Alert.alert('备份失败', `写入备份文件时出错：${(e as Error).message ?? '未知错误'}`);
      }
    })();
  }, []);

  /** 导入备份：选文件 → 读文件 → 解析校验 → 确认弹窗（覆盖警示）→ 恢复 */
  const handleBackupImport = useCallback(() => {
    void (async () => {
      let text = '';
      try {
        const res = await DocumentPicker.pick({
          // json 在部分机型会被归为文本 MIME，两个类型都放行
          type: ['application/json', 'text/plain'],
        });
        // v9 返回数组；兼容 mock/旧版返回单对象（与 DictFileService 同款兜底）
        const first = (Array.isArray(res) ? res[0] : res) as { uri?: string } | undefined;
        if (!first || !first.uri) {
          Alert.alert('导入失败', '未获取到所选文件');
          return;
        }
        text = await RNFS.readFile(first.uri, 'utf8');
      } catch (e) {
        // 用户取消选择：静默返回
        if (DocumentPicker.isCancel(e)) {
          return;
        }
        Alert.alert('导入失败', `读取备份文件时出错：${(e as Error).message ?? '未知错误'}`);
        return;
      }

      let parsed: ParsedBackup;
      try {
        parsed = parseBackup(text);
      } catch (e) {
        // 解析/校验失败：提示明确中文原因，不进入恢复流程
        Alert.alert('导入失败', (e as Error).message ?? '备份文件格式不正确');
        return;
      }

      Alert.alert(
        '确认导入',
        `将导入以下数据：\n\n${summarizeBackup(parsed.data)}\n\n导入会覆盖现有同类数据（设置、背诵进度、收藏、笔记、成就、划线、续读位置），且无法撤销。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认导入',
            style: 'destructive',
            onPress: () => applyBackupRestore(parsed),
          },
        ],
      );
    })();
  }, [applyBackupRestore]);

  /** 功能入口 */
  const entries = [
    { key: 'bookmarks', icon: '⭐', label: '收藏', desc: `${bookmarkCount} 条`, onPress: () => navigation.navigate('Bookmarks') },
    { key: 'notes', icon: '📝', label: '笔记', desc: `${noteCount} 条`, onPress: () => navigation.navigate('NotesList') },
    { key: 'recitation', icon: '📖', label: '背诵进度', desc: `${recitationCount} 条`, onPress: () => navigation.navigate('Recitation') },
    { key: 'achievements', icon: '🏅', label: '我的成就', desc: `已解锁 ${unlockedCount}/${ACHIEVEMENT_TOTAL}`, onPress: () => navigation.navigate('Achievements') },
    { key: 'studyStats', icon: '📊', label: '学习统计', desc: '总览学习成果并分享', onPress: () => navigation.navigate('StudyStats') },
    { key: 'export', icon: '📤', label: '导出数据', desc: '复制 JSON 到剪贴板', onPress: handleExport },
    { key: 'dictUpload', icon: '📥', label: '字典上传', desc: '导入自定义字典', onPress: () => (tabNavigation.navigate as (name: string, params: object) => void)('Dict', { screen: 'DictImport' }) },
  ];

  const pinyinOptions: { value: PinyinMode; label: string }[] = [
    { value: 'full', label: '全文' },
    { value: 'rare', label: '仅生僻' },
    { value: 'off', label: '关闭' },
  ];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <Text style={[styles.title, { color: colors.text }]}>我的</Text>

      {/* 功能入口卡片 */}
      <View style={styles.entryGrid}>
        {entries.map((entry) => (
          <Pressable
            key={entry.key}
            onPress={entry.onPress}
            style={({ pressed }) => [
              styles.entryCard,
              { backgroundColor: colors.card, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.entryIcon, { color: colors.primary }]}>{entry.icon}</Text>
            <Text style={[styles.entryLabel, { color: colors.text }]}>{entry.label}</Text>
            <Text style={[styles.entryDesc, { color: colors.pinyin }]}>{entry.desc}</Text>
          </Pressable>
        ))}
      </View>

      {/* 阅读设置 */}
      <SectionTitle title="阅读设置" colors={colors} />
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>字号</Text>
          <SegmentedRow
            options={FONT_SIZE_OPTIONS.map((v) => ({ value: v, label: `${v}px` }))}
            value={fontSize}
            onChange={setFontSize}
            colors={colors}
          />
        </View>
        <View style={[styles.settingRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>行距</Text>
          <SegmentedRow
            options={LINE_HEIGHT_OPTIONS.map((v) => ({ value: v, label: String(v) }))}
            value={lineHeight}
            onChange={setLineHeight}
            colors={colors}
          />
        </View>
        <View style={[styles.settingRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>主题</Text>
          <SegmentedRow
            options={[
              { value: 'light' as const, label: '日间' },
              { value: 'dark' as const, label: '夜间' },
            ]}
            value={theme}
            onChange={(v) => setTheme(v)}
            colors={colors}
          />
        </View>
      </View>

      {/* 注音与繁简 */}
      <SectionTitle title="朗读偏好" colors={colors} />
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>注音模式</Text>
          <SegmentedRow
            options={pinyinOptions}
            value={pinyinMode}
            onChange={setPinyinMode}
            colors={colors}
          />
        </View>
        <View style={[styles.settingRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>繁简偏好</Text>
          <SegmentedRow
            options={[
              { value: 'simplified' as const, label: '简体' },
              { value: 'traditional' as const, label: '繁体' },
            ]}
            value={conversionMode}
            onChange={setConversionMode}
            colors={colors}
          />
        </View>
      </View>

      {/* 翻译设置 */}
      <SectionTitle title="翻译设置" colors={colors} />
      <Pressable
        onPress={() => setTranslationModal(true)}
        style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.settingRow}>
          <View style={styles.settingLabelBox}>
            <Text style={[styles.settingLabel, { color: colors.text }]}>在线翻译服务</Text>
            <Text style={[styles.settingHint, { color: colors.pinyin }]}>
              阅读时长按选段可翻译 · 自带 API Key
            </Text>
          </View>
          <Text style={[styles.settingValue, { color: colors.textSecondary }]}>
            {`${
              TRANSLATION_PROVIDERS.find((p) => p.id === translation.provider)?.label ?? 'DeepL'
            }${translationReady ? ' 已配置 ›' : ' 未配置 ›'}`}
          </Text>
        </View>
      </Pressable>

      {/* 备份与恢复（P2-15 本地版） */}
      <SectionTitle title="备份与恢复" colors={colors} />
      <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Pressable
          onPress={handleBackupExport}
          style={({ pressed }) => [styles.backupRow, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="导出备份文件"
        >
          <View style={styles.settingLabelBox}>
            <Text style={[styles.settingLabel, { color: colors.text }]}>导出备份</Text>
            <Text style={[styles.settingHint, { color: colors.pinyin }]}>
              设置 / 背诵进度 / 收藏 / 笔记 / 成就 / 用户书籍 / 划线 / 续读位置 → 本地 JSON 文件
            </Text>
          </View>
          <Text style={[styles.settingValue, { color: colors.textSecondary }]}>导出 ›</Text>
        </Pressable>
        <Pressable
          onPress={handleBackupImport}
          style={({ pressed }) => [
            styles.backupRow,
            styles.backupRowBordered,
            { borderTopColor: colors.border },
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="从备份文件恢复数据"
        >
          <View style={styles.settingLabelBox}>
            <Text style={[styles.settingLabel, { color: colors.text }]}>导入备份</Text>
            <Text style={[styles.settingHint, { color: colors.pinyin }]}>
              选择备份 JSON 文件恢复 · 会覆盖现有同类数据
            </Text>
          </View>
          <Text style={[styles.settingValue, { color: colors.textSecondary }]}>导入 ›</Text>
        </Pressable>
      </View>

      {/* 关于 */}
      <SectionTitle title="关于" colors={colors} />
      <Pressable
        onPress={() =>
          Alert.alert(
            '国学学习助手',
            '版本 1.0.0\n\n行间注音 · 多音字判音 · 全文搜索 · 背诵辅助\n全部功能离线可用',
          )
        }
        style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>版本信息</Text>
          <Text style={[styles.settingValue, { color: colors.textSecondary }]}>v1.0.0 ›</Text>
        </View>
      </Pressable>

      {/* 翻译设置弹层 */}
      <Modal
        visible={translationModal}
        transparent
        animationType="fade"
        onRequestClose={() => setTranslationModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setTranslationModal(false)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.background }]}
            onPress={() => undefined}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>翻译设置</Text>
            <Text style={[styles.modalHint, { color: colors.pinyin }]}>
              使用您自己申请的服务商 Key，请求直接由 App 发往服务商，不经过任何中转服务器。
            </Text>

            {/* 服务商选择 */}
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>服务商</Text>
            <SegmentedRow
              options={TRANSLATION_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
              value={translation.provider}
              onChange={(v) => setTranslation({ provider: v })}
              colors={colors}
            />

            {/* Key 录入（按服务商展示对应字段） */}
            {TRANSLATION_PROVIDERS.filter((p) => p.id === translation.provider).map((p) => (
              <View key={p.id} style={styles.keyFields}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{p.keyHint}</Text>
                {p.id === 'baidu' ? (
                  <>
                    <TextInput
                      style={[
                        styles.keyInput,
                        {
                          color: colors.text,
                          backgroundColor: colors.inputBackground,
                          borderColor: colors.border,
                        },
                      ]}
                      value={translation.baiduAppId}
                      onChangeText={(v) => setTranslation({ baiduAppId: v.trim() })}
                      placeholder="APP ID"
                      placeholderTextColor={colors.pinyin}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TextInput
                      style={[
                        styles.keyInput,
                        {
                          color: colors.text,
                          backgroundColor: colors.inputBackground,
                          borderColor: colors.border,
                        },
                      ]}
                      value={translation.baiduSecretKey}
                      onChangeText={(v) => setTranslation({ baiduSecretKey: v.trim() })}
                      placeholder="密钥（Secret Key）"
                      placeholderTextColor={colors.pinyin}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                    />
                  </>
                ) : (
                  <TextInput
                    style={[
                      styles.keyInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.inputBackground,
                        borderColor: colors.border,
                      },
                    ]}
                    value={p.id === 'google' ? translation.googleApiKey : translation.deeplApiKey}
                    onChangeText={(v) =>
                      setTranslation(
                        p.id === 'google' ? { googleApiKey: v.trim() } : { deeplApiKey: v.trim() },
                      )
                    }
                    placeholder="API Key"
                    placeholderTextColor={colors.pinyin}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                )}
              </View>
            ))}

            <Pressable
              style={({ pressed }) => [
                styles.modalDoneButton,
                { backgroundColor: colors.primary },
                pressed && styles.pressed,
              ]}
              onPress={() => setTranslationModal(false)}
              accessibilityRole="button"
              accessibilityLabel="完成翻译设置"
            >
              <Text style={styles.modalDoneText}>完成</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  entryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  entryCard: {
    width: '50%',
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  pressed: {
    opacity: 0.7,
  },
  entryIcon: {
    fontSize: 22,
    marginBottom: 6,
  },
  entryLabel: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
  },
  entryDesc: {
    fontSize: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 6,
  },
  settingsCard: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopWidth: 0,
    gap: 12,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  settingLabelBox: {
    flexShrink: 1,
    gap: 2,
  },
  settingHint: {
    fontSize: 11,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalSheet: {
    borderRadius: 14,
    padding: 18,
    gap: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  modalHint: {
    fontSize: 12,
    lineHeight: 17,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  keyFields: {
    gap: 8,
  },
  keyInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  offlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: 12,
  },
  modalDoneButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 8,
  },
  modalDoneText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  settingValue: {
    fontSize: 14,
  },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 12,
  },
  backupRowBordered: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  segmentedRow: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 1,
  },
  segmentedBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
  },
  segmentedText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
