/**
 * 根导航（T05）
 * 结构：RootStack（Native Stack）
 *   ├─ Main：底部 3 Tab（书架 | 字典 | 我的），各 Tab 内 Native Stack
 *   ├─ Reader：全局阅读器（书架 / 搜索结果 / 收藏列表等任意位置可进入）
 *   └─ RecitationPractice：背诵练习（阅读器工具栏「背诵」直达）
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
  DictStackParamList,
  LibraryStackParamList,
  MainTabParamList,
  ProfileStackParamList,
  RootStackParamList,
} from '@/navigation/types';

// ============ Navigator 实例 ============

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const LibraryStack = createNativeStackNavigator<LibraryStackParamList>();
const DictStack = createNativeStackNavigator<DictStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();

/** Tab 展示配置（emoji 图标兜底） */
const TAB_META: Record<keyof MainTabParamList, { icon: string; label: string }> = {
  Library: { icon: '📚', label: '书架' },
  Dict: { icon: '📕', label: '字典' },
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

/** 字典 Tab：查字页 + 管理页 + 导入页 */
function DictStackScreens(): React.JSX.Element {
  return (
    <DictStack.Navigator screenOptions={{ headerShown: false }}>
      <DictStack.Screen name="DictLookup" component={DictLookupScreen} />
      <DictStack.Screen name="DictManage" component={DictManageScreen} />
      <DictStack.Screen name="DictImport" component={DictImportScreen} />
    </DictStack.Navigator>
  );
}

/** 我的 Tab：个人中心 + 收藏 / 笔记 / 背诵进度 / 背诵练习 / 成就 */
function ProfileStackScreens(): React.JSX.Element {
  return (
    <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
      <ProfileStack.Screen name="Profile" component={ProfileScreen} />
      <ProfileStack.Screen name="Bookmarks" component={BookmarksScreen} />
      <ProfileStack.Screen name="NotesList" component={NotesListScreen} />
      <ProfileStack.Screen name="Recitation" component={RecitationScreen} />
      <ProfileStack.Screen
        name="RecitationPractice"
        component={RecitationPracticeScreen}
      />
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
        name="Dict"
        component={DictStackScreens}
        options={{ title: TAB_META.Dict.label }}
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
