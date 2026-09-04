/**
 * T04 页面共享导航参数类型
 * T05 已将全部路由参数表并入 src/navigation/types.ts，此处保留 re-export
 * 以兼容既有页面的 `@/screens/types` 引用（页面 props 语义不变）。
 */
export type {
  AppStackParamList as T04StackParamList,
  ReaderRouteParams,
  RecitationPracticeParams,
  RootStackParamList,
  MainTabParamList,
} from '@/navigation/types';
