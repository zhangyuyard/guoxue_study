/**
 * 繁简转换页（ConversionScreen）
 * 顶部方向切换（简→繁 / 繁→简）；多行输入框；转换按钮；
 * 只读结果框 + 操作按钮：复制 / 收藏 / 清空。
 * 收藏保存为 Bookmark（type: paragraph，text 为转换结果，标签「繁简转换」）。
 */
import React, { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { T04StackParamList } from '@/screens/types';
import { ConversionService } from '@/services/ConversionService';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Conversion'>;

/** 转换方向 */
type Direction = 'toTraditional' | 'toSimplified';

/**
 * 复制文本到剪贴板
 * RN 0.74 已移除内置 Clipboard API，此处在运行时按需加载
 * @react-native-clipboard/clipboard（项目依赖中未包含时给出友好提示）。
 * 通过 globalThis.require 访问 Metro 的模块加载器（避免依赖 Node 全局类型）。
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

export default function ConversionScreen(_props: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const addBookmark = useBookmarkStore((s) => s.addBookmark);

  const [direction, setDirection] = useState<Direction>('toTraditional');
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');

  /** 切换转换方向（并清空旧结果） */
  const switchDirection = useCallback((dir: Direction) => {
    setDirection(dir);
    setResult('');
  }, []);

  /** 执行转换 */
  const handleConvert = useCallback(() => {
    if (!input.trim()) {
      Alert.alert('提示', '请先输入要转换的文字');
      return;
    }
    const res =
      direction === 'toTraditional'
        ? ConversionService.toTraditional(input)
        : ConversionService.toSimplified(input);
    if (res.success && res.data !== undefined) {
      setResult(res.data);
    } else {
      Alert.alert('转换失败', res.error ?? '未知错误');
    }
  }, [input, direction]);

  /** 复制结果 */
  const handleCopy = useCallback(() => {
    if (!result) {
      return;
    }
    if (copyToClipboard(result)) {
      Alert.alert('已复制', '转换结果已复制到剪贴板');
    } else {
      Alert.alert('复制失败', '未安装剪贴板组件（@react-native-clipboard/clipboard）');
    }
  }, [result]);

  /** 收藏结果 */
  const handleFavorite = useCallback(() => {
    if (!result) {
      Alert.alert('提示', '请先完成转换');
      return;
    }
    addBookmark({
      type: 'paragraph',
      text: result,
      tags: ['繁简转换'],
    });
    Alert.alert('已收藏', '转换结果已保存到收藏');
  }, [result, addBookmark]);

  /** 清空输入与结果 */
  const handleClear = useCallback(() => {
    setInput('');
    setResult('');
  }, []);

  const directionLabels: Record<Direction, { label: string; hint: string }> = {
    toTraditional: { label: '简 → 繁', hint: '将简体字转换为繁体字' },
    toSimplified: { label: '繁 → 简', hint: '将繁体字转换为简体字' },
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: colors.text }]}>繁简转换</Text>

      {/* 方向切换 */}
      <View style={[styles.directionRow, { backgroundColor: colors.card, borderRadius: 12 }]}>
        {(Object.keys(directionLabels) as Direction[]).map((dir) => {
          const selected = direction === dir;
          return (
            <Pressable
              key={dir}
              onPress={() => switchDirection(dir)}
              style={[
                styles.directionBtn,
                selected && { backgroundColor: colors.primary },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.directionLabel,
                  { color: selected ? '#FFFFFF' : colors.textSecondary },
                ]}
              >
                {directionLabels[dir].label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.directionHint, { color: colors.pinyin }]}>
        {directionLabels[direction].hint}
      </Text>

      {/* 输入框 */}
      <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>输入原文</Text>
      <TextInput
        style={[
          styles.textBox,
          {
            backgroundColor: colors.inputBackground,
            color: colors.text,
            borderColor: colors.border,
          },
        ]}
        value={input}
        onChangeText={setInput}
        placeholder="在此输入需要转换的文字…"
        placeholderTextColor={colors.pinyin}
        multiline
        textAlignVertical="top"
        maxLength={5000}
      />

      {/* 转换按钮 */}
      <Pressable
        onPress={handleConvert}
        style={[styles.convertBtn, { backgroundColor: colors.primary }]}
      >
        <Text style={styles.convertBtnText}>转 换</Text>
      </Pressable>

      {/* 结果框 */}
      <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>转换结果</Text>
      <View
        style={[
          styles.resultBox,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
          },
        ]}
      >
        {result ? (
          <Text style={[styles.resultText, { color: colors.text }]} selectable>
            {result}
          </Text>
        ) : (
          <Text style={[styles.resultPlaceholder, { color: colors.pinyin }]}>
            转换结果将显示在这里…
          </Text>
        )}
      </View>

      {/* 操作按钮 */}
      <View style={styles.actionRow}>
        <Pressable
          onPress={handleCopy}
          style={[styles.actionBtn, { borderColor: colors.border }]}
        >
          <Text style={[styles.actionText, { color: colors.text }]}>复制</Text>
        </Pressable>
        <Pressable
          onPress={handleFavorite}
          style={[styles.actionBtn, { borderColor: colors.border }]}
        >
          <Text style={[styles.actionText, { color: colors.text }]}>收藏</Text>
        </Pressable>
        <Pressable
          onPress={handleClear}
          style={[styles.actionBtn, { borderColor: colors.border }]}
        >
          <Text style={[styles.actionText, { color: colors.textSecondary }]}>清空</Text>
        </Pressable>
      </View>
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
    marginBottom: 12,
  },
  directionRow: {
    flexDirection: 'row',
    padding: 4,
    marginBottom: 6,
  },
  directionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  directionLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  directionHint: {
    fontSize: 12,
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 13,
    marginBottom: 6,
  },
  textBox: {
    minHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    fontSize: 16,
    lineHeight: 24,
  },
  convertBtn: {
    marginVertical: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  convertBtnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 4,
  },
  resultBox: {
    minHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  resultText: {
    fontSize: 16,
    lineHeight: 24,
  },
  resultPlaceholder: {
    fontSize: 14,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
