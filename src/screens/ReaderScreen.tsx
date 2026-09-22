/**
 * 阅读器主页面（ReaderScreen）— 清理后的最小空壳
 *
 * ⚠ 本文件为「真零起点」清理后的空壳：旧实现（跳章 / 翻页 / 跨章拼接 / 定位落位 /
 * 视口高度补偿 / 边缘手势）已**整体移除**，约 50 轮修补累积的 5430 行实现全部删除。
 * 依据：`docs/reader-cleanup-plan-2026-09-22.md`（§4 / §5 / §6 方案 (a)）。
 *
 * 保留该文件的目的＝把「谁来渲染阅读页」隔离在单文件内：导航层（`RootStack` 的
 * `Reader` 路由与 7 处 `navigate('Reader')` 入口）零改动，新实现直接在后续轮次
 * 从零重写本文件即可。
 *
 * 本文件**不含**任何滚动窗口、翻页、跨章拼接、锚点定位、视口补偿或边缘手势逻辑。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ReaderRouteParams } from '@/navigation/types';

/** ReaderScreen 所需的最小导航能力（RootStack 注入或阅读 Tab 手动构造均可满足） */
interface ReaderScreenProps {
  /** React Navigation 注入的 route（阅读 Tab 复用时由父组件直接传入） */
  route?: { params?: ReaderRouteParams };
  /** React Navigation 注入的 navigation */
  navigation?: {
    goBack: () => void;
    navigate: {
      (name: 'Reader', params: ReaderRouteParams): void;
    };
  };
}

function ReaderScreen({ route, navigation }: ReaderScreenProps): React.JSX.Element {
  // 空壳期间不接受任何导航行为；保留形参以维持与 RootStack 注入的签名兼容。
  void route;
  void navigation;

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>阅读器重写中</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    fontSize: 16,
    opacity: 0.6,
  },
});

export default ReaderScreen;
