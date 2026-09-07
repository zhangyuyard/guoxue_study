/**
 * 根导航（T05）
 * 结构：RootStack（Native Stack）
 *   ├─ Main：底部 3 Tab（书架 | 背诵 | 我的），各 Tab 内 Native Stack
 *   ├─ Reader：全局阅读器（书架 / 搜索结果 / 收藏列表等任意位置可进入）
 *   └─ RecitationPractice：背诵练习（背诵 Tab「背诵助手」选章进入；阅读器不再直达）
 * 字典功能不再占用底部 Tab：三屏（DictLookup / DictManage / DictImport）挂载于
 * ProfileStack，入口收敛到「我的」页词典分组；DictLookup 同时保留在 RootStack，
 * 供阅读器解析面板「在字典中查看」直达（返回不丢阅读位置）。
 * Tab 图标使用 emoji 兜底，避免 react-native-vector-icons 原生字体未链接时显示问号。
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import BookmarksScreen from '@/screens/BookmarksScreen';
import AchievementsScreen from '@/screens/AchievementsScreen';
import DictImportScreen from '@/screens/DictImportScreen';
import DictLookupScreen from '@/screens/DictLookupScreen';
import DictManageScreen from '@/screens/DictManageScreen';
import LibraryScreen from '@/screens/LibraryScreen';
import NotesListScreen from '@/screens/NotesListScreen';
import ProfileScreen from '@/screens/ProfileScreen';
import ReaderScreen from '@/screens/ReaderScreen';
import RecitationPracticeScreen from '@/screens/RecitationPracticeScreen';
import RecitationScreen from '@/screens/RecitationScreen';
import SearchScreen from '@/screens/SearchScreen';
import StudyStatsScreen from '@/screens/StudyStatsScreen';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';
import type {
  LibraryStackParamList,
  MainTabParamList,
  ProfileStackParamList,
  ReciteStackParamList,
  RootStackParamList,
} from '@/navigation/types';

// ============ Navigator 实例 ============

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const LibraryStack = createNativeStackNavigator<LibraryStackParamList>();
const ReciteStack = createNativeStackNavigator<ReciteStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();

/** Tab 展示配置（emoji 图标兜底） */
const TAB_META: Record<keyof MainTabParamList, { icon: string; label: string }> = {
  Library: { icon: '📚', label: '书架' },
  Recite: { icon: '🧠', label: '背诵' },
  Profile: { icon: '👤', label: '我的' },
};

// ============ 各 Tab 内 Stack ============

/** 书架 Tab：书架首页 + 搜索入口 */
function LibraryStackScreens(): React.JSX.Element {
  return (
    <LibraryStack.Navigator screenOptions={{ headerShown: false }}>
      <LibraryStack.Screen name="Library" component={LibraryScreen} />
      <LibraryStack.Screen name="Search" component={SearchScreen} />
    </LibraryStack.Navigator>
  );
}

/** 背诵 Tab：背诵助手页 + 背诵练习页 */
function ReciteStackScreens(): React.JSX.Element {
  return (
    <ReciteStack.Navigator screenOptions={{ headerShown: false }}>
      <ReciteStack.Screen name="Recitation" component={RecitationScreen} />
      <ReciteStack.Screen
        name="RecitationPractice"
        component={RecitationPracticeScreen}
      />
    </ReciteStack.Navigator>
  );
}

/** 我的 Tab：个人中心 + 词典三屏（原字典 Tab 入口迁移至此）+ 收藏 / 笔记 / 成就 */
function ProfileStackScreens(): React.JSX.Element {
  return (
    <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
      <ProfileStack.Screen name="Profile" component={ProfileScreen} />
      <ProfileStack.Screen name="DictLookup" component={DictLookupScreen} />
      <ProfileStack.Screen name="DictManage" component={DictManageScreen} />
      <ProfileStack.Screen name="DictImport" component={DictImportScreen} />
      <ProfileStack.Screen name="Bookmarks" component={BookmarksScreen} />
      <ProfileStack.Screen name="NotesList" component={NotesListScreen} />
      <ProfileStack.Screen name="Achievements" component={AchievementsScreen} />
      <ProfileStack.Screen name="StudyStats" component={StudyStatsScreen} />
    </ProfileStack.Navigator>
  );
}

// ============ 主 Tab 容器 ============

function MainTabs(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
        tabBarIcon: ({ focused }) => (
          <Text style={[styles.tabIcon, !focused && styles.tabIconInactive]}>
            {TAB_META[route.name].icon}
          </Text>
        ),
      })}
    >
      <Tab.Screen
        name="Library"
        component={LibraryStackScreens}
        options={{ title: TAB_META.Library.label }}
      />
      <Tab.Screen
        name="Recite"
        component={ReciteStackScreens}
        options={{ title: TAB_META.Recite.label }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileStackScreens}
        options={{ title: TAB_META.Profile.label }}
      />
    </Tab.Navigator>
  );
}

// ============ 根导航 ============

function RootNavigator(): React.JSX.Element {
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="Main" component={MainTabs} />
      <RootStack.Screen name="Reader" component={ReaderScreen} />
      <RootStack.Screen
        name="RecitationPractice"
        component={RecitationPracticeScreen}
      />
      <RootStack.Screen name="DictLookup" component={DictLookupScreen} />
    </RootStack.Navigator>
  );
}

export default RootNavigator;

// ============ 样式 ============

const styles = StyleSheet.create({
  tabIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  tabIconInactive: {
    opacity: 0.55,
  },
});
