/**
 * 工具箱入口页（ToolboxScreen）
 * 4 个工具入口卡片：繁简转换 / 全文搜索 / 背诵助手 / 注音工具。
 * 注音工具跳转书架，由用户任选经典章节阅读（阅读时自动行间注音）。
 */
import React, { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { T04StackParamList } from '@/screens/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Toolbox'>;

/** 工具入口配置 */
interface ToolEntry {
  key: string;
  icon: string;
  name: string;
  description: string;
  screen: 'Conversion' | 'Search' | 'Recitation' | 'Library';
}

const TOOLS: ToolEntry[] = [
  {
    key: 'conversion',
    icon: '繁⇄简',
    name: '繁简转换',
    description: '简↔繁双向转换，一键复制收藏',
    screen: 'Conversion',
  },
  {
    key: 'search',
    icon: '🔍',
    name: '全文搜索',
    description: '跨五部经典全文检索，命中高亮',
    screen: 'Search',
  },
  {
    key: 'recitation',
    icon: '📖',
    name: '背诵助手',
    description: '填空默写与提示遮盖，科学巩固记忆',
    screen: 'Recitation',
  },
  {
    key: 'pinyin',
    icon: '注',
    name: '注音工具',
    description: '任选经典章节，行间注音辅助诵读',
    screen: 'Library',
  },
];

export default function ToolboxScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const openTool = useCallback(
    (screen: ToolEntry['screen']) => {
      navigation.navigate(screen);
    },
    [navigation],
  );

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}
    >
      <Text style={[styles.title, { color: colors.text }]}>工具箱</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        国学学习实用小工具
      </Text>

      <View style={styles.grid}>
        {TOOLS.map((tool) => (
          <Pressable
            key={tool.key}
            onPress={() => openTool(tool.screen)}
            style={({ pressed }) => [
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={tool.name}
          >
            <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
              <Text style={[styles.icon, { color: colors.primary }]}>{tool.icon}</Text>
            </View>
            <Text style={[styles.name, { color: colors.text }]}>{tool.name}</Text>
            <Text style={[styles.desc, { color: colors.textSecondary }]}>
              {tool.description}
            </Text>
          </Pressable>
        ))}
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
    paddingHorizontal: 16,
  },
  subtitle: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
  },
  card: {
    width: '50%',
    padding: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressed: {
    opacity: 0.7,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  icon: {
    fontSize: 20,
    fontWeight: '700',
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  desc: {
    fontSize: 12,
    lineHeight: 17,
  },
});
