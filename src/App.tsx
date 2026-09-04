/**
 * 应用根组件（T05 完整应用壳）
 * 结构：GestureHandlerRootView → SafeAreaProvider → NavigationContainer（日/夜主题）→ RootNavigator
 * 启动初始化：StorageService.initDatabase()（SQLite 建表，含 FTS 虚拟表；
 * FTS 数据由 SearchService 首次搜索时惰性填充）+ useLibraryStore.loadBooks()（预载文本库）
 * + DictEngine.init()（字典双 db 部署：assets → native_dict.db 拷贝与 user_version 比对升级）。
 * 字典初始化失败不阻断启动（降级为字典 Tab 显示「引擎未就绪」态，仅 console.warn）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme as NavigationTheme,
} from '@react-navigation/native';

import RootNavigator from '@/navigation/RootNavigator';
import { DictEngine } from '@/services/dict/DictEngine';
import { StorageService } from '@/services/StorageService';
import { syncReminderFromStores } from '@/services/ReviewReminderService';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useLibraryStore } from '@/store/useLibraryStore';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';
import type { ThemeMode } from '@/types';

/** 由应用主题色生成 React Navigation 主题 */
function buildNavigationTheme(mode: ThemeMode): NavigationTheme {
  const colors = getColors(mode);
  const base = mode === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.border,
      notification: colors.accent,
    },
  };
}

function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const loadBooks = useLibraryStore((s) => s.loadBooks);
  const [ready, setReady] = useState(false);

  // 启动初始化：SQLite 建表 + 预载文本库（同步）+ 字典引擎部署（异步，不阻断启动）
  useEffect(() => {
    StorageService.initDatabase();
    loadBooks();
    DictEngine.init().catch((err: unknown) => {
      // 降级：字典 Tab 显示「引擎未就绪」态，应用其余功能不受影响
      console.warn('[App] 字典引擎初始化失败：', err);
    });
    // B4 复习提醒：启动时按当前设置与到期数同步/取消每日提醒
    // （loadRecitationList 为同步读取，随后 syncReminderFromStores 内部防重入）
    useRecitationStore.getState().loadRecitationList();
    syncReminderFromStores();
    // P2-06 成就：启动时重算（内部幂等，仅新解锁项落账；成就不可逆）
    useAchievementStore.getState().recompute();
    setReady(true);
  }, [loadBooks]);

  const navigationTheme = useMemo(() => buildNavigationTheme(theme), [theme]);
  const splashColors = getColors(theme);

  // 启动 Loading
  if (!ready) {
    return (
      <View style={[styles.splash, { backgroundColor: splashColors.background }]}>
        <Text style={[styles.splashTitle, { color: splashColors.primary }]}>国学学习</Text>
        <ActivityIndicator color={splashColors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <NavigationContainer theme={navigationTheme}>
          <RootNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  splashTitle: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 4,
  },
});

export default App;
