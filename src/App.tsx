/**
 * 应用根组件（T05 完整应用壳）
 * 结构：GestureHandlerRootView → SafeAreaProvider → NavigationContainer（日/夜主题）→ RootNavigator
 * 启动初始化（BugFix：打开 App 长时间无法响应——启动时序策略）：
 * 分为「首屏必需」与「可延后」两级，核心原则是 JS 线程在首帧前只做轻量同步工作：
 * 1) 首屏必需（effect 内同步、轻量）：
 *    - StorageService.initDatabase()：SQLite 建表（幂等 DDL，含 FTS 虚拟表；
 *      FTS 数据由 SearchService 首次搜索时惰性填充）；
 *    - useLibraryStore.loadBooks()：两段式装载——内置书目同步上屏（书架立即可用），
 *      用户书装载在其内部让出线程（macrotask）后才执行，不阻塞首帧；
 *    - DictEngine.init()：字典双 db 部署（assets → native_dict.db 拷贝与 user_version
 *      比对升级；异步，不阻断启动；失败降级为字典 Tab「引擎未就绪」态，仅 console.warn）。
 * 2) 可延后任务（scheduleStartupTasks 逐个延后，每个任务独占一个 macrotask，
 *    任务间让出 JS 线程给渲染与触摸事件）：用户读音纠正注入 → 背诵列表 → 复习提醒同步 → 成就重算。
 *    顺序即依赖顺序：提醒同步读背诵列表；成就重算内部自刷背诵/收藏/笔记三个
 *    SQLite store（设计为自刷新，可整体延后）。最终状态与旧「同步串行」实现
 *    完全一致——数据全量加载、提醒照常同步、成就照常重算，只是不再阻塞首帧交互。
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
import {
  ensurePhrasePinyinData,
  setReadingOverrideProvider,
} from '@/services/PinyinService';
import { StorageService } from '@/services/StorageService';
import { syncReminderFromStores } from '@/services/ReviewReminderService';
import { useAchievementStore } from '@/store/useAchievementStore';
import { useLibraryStore } from '@/store/useLibraryStore';
import { useReadingOverrideStore } from '@/store/useReadingOverrideStore';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';
import type { ThemeMode } from '@/types';
import { scheduleStartupTasks } from '@/utils/startupTasks';

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

  // 启动初始化：见文件头「启动初始化」说明（首屏必需同步做，重活逐个延后）
  useEffect(() => {
    // —— 首屏必需（同步、轻量）——
    let t0 = Date.now();
    StorageService.initDatabase();
    console.info(`[PERF][startup] initDatabase=${Date.now() - t0}ms`);
    t0 = Date.now();
    loadBooks();
    console.info(`[PERF][startup] loadBooks=${Date.now() - t0}ms`);
    t0 = Date.now();
    DictEngine.init().catch((err: unknown) => {
      // 降级：字典 Tab 显示「引擎未就绪」态，应用其余功能不受影响
      console.warn('[App] 字典引擎初始化失败：', err);
    });
    console.info(`[PERF][startup] dictEngineSyncPrefix=${Date.now() - t0}ms`);
    // 首屏必需项已就绪（同步部分均为轻量操作），立即放行首帧；
    // 重活不再挡在 setReady 之前（旧实现的卡死根因）
    setReady(true);
    // 【PERF】JS 线程心跳探针：50ms 心跳，间隔 ≥300ms 记一次阻塞窗口，
    // 用于在 logcat 时间线上定位「点击无响应」期间的 JS 饱和段
    let lastBeat = Date.now();
    const heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastBeat;
      lastBeat = now;
      if (gap >= 300) {
        console.info(`[PERF][jank] jsBlocked=${gap}ms`);
      }
    }, 50);
    // —— 可延后任务（每个任务独占一个 macrotask，任务间让出 JS 线程）——
    // ① 背诵列表（SQLite 同步读）→ ② 复习提醒同步（读背诵/设置/目标数据，
    //    内部防重入）→ ③ 成就重算（内部自刷背诵/收藏/笔记，幂等，仅新解锁项落账）。
    // 卸载/effect 重跑时取消未执行任务，避免重复调度。
    const cancelTasks = scheduleStartupTasks([
      {
        // 词组读音数据（phrase-pinyin，~4.5MB 分片资产）预热：P0 下沉后运行时
        // 首次注音前需异步载入；放在延后任务首位，用户点进阅读器前大概率
        // 已就绪。P0.5 分片化后逐片读+parse（~128KB/片，片间 macrotask 让出），
        // 单块 <200ms，不再出现旧整文件载入的启动期 ~6.7s JS 饱和块。
        // 幂等单例；失败由阅读器 PinyinText 晚到机制兜底重试。
        key: 'warmPhrasePinyin',
        run: () => {
          void ensurePhrasePinyinData();
        },
      },
      {
        // 用户读音纠正注入读音仲裁链最顶端（provider 内部实时读 store state，
        // persist 水合后自动生效；重复注入幂等，effect 重跑无副作用）
        key: 'injectReadingOverrideProvider',
        run: () => {
          setReadingOverrideProvider({
            resolve: (char, context) =>
              useReadingOverrideStore.getState().getOverride(char, context),
          });
        },
      },
      {
        key: 'loadRecitationList',
        run: () => useRecitationStore.getState().loadRecitationList(),
      },
      {
        key: 'syncReminderFromStores',
        run: () => {
          void syncReminderFromStores();
        },
      },
      {
        key: 'recomputeAchievements',
        run: () => useAchievementStore.getState().recompute(),
      },
    ]);
    return () => {
      clearInterval(heartbeatTimer);
      cancelTasks();
    };
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
