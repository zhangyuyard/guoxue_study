/**
 * 导航路由参数类型（T05）
 * 层级结构：
 *   RootStack（全局页面 + 主 Tab 容器）
 *     └─ MainTab（书架 / 背诵 / 我的）
 *          ├─ LibraryStack：Library → Search
 *          ├─ ReciteStack：Recitation → RecitationPractice
 *          └─ ProfileStack：Profile → DictLookup / DictManage / DictImport
 *               → Bookmarks / NotesList / Achievements / StudyStats
 * 说明：
 *   - Reader 与 RecitationPractice 挂在 RootStack，供书架、搜索结果、收藏列表、
 *     阅读器工具栏等任意位置进入（navigate 未命中当前 Stack 时由 React Navigation 冒泡至父级）。
 *   - 字典功能不再占用底部 Tab，三屏（DictLookup / DictManage / DictImport）挂载于
 *     ProfileStack，入口统一收敛到「我的」页词典分组；DictLookup 与 DictManage
 *     同时保留在 RootStack（阅读器解析面板「在字典中查看」直达，返回不丢阅读
 *     位置；RootStack 查字页可直达词典管理，返回逐级回退不绕道「我的」Tab）。
 *   - 各页面统一使用 AppStackParamList（应用级全路由表）声明 props，
 *     保证编译期 navigate 的路由名与参数和全局注册一致。
 */
import type { RecitationMode } from '@/types';

/** 阅读器路由参数 */
export interface ReaderRouteParams {
  bookId: string;
  chapterId: string;
  segmentId?: string;
  /**
   * 跳转序号（goToChapter 每次跳转刷新）：目录跳转到「当前章」时，路由
   * 参数与现值完全相同不会触发任何 effect（navigate 浅合并语义），携带
   * 递增序号让切章重置 effect 重新执行，落回章首（重复跳转生效）。
   */
  jumpSeq?: number;
}

/** 背诵练习路由参数 */
export interface RecitationPracticeParams {
  bookId: string;
  chapterId: string;
  mode: RecitationMode;
}

/** 根 Stack：Tab 主容器 + 全局页面（跨 Tab 可达） */
export type RootStackParamList = {
  /** 底部 Tab 主容器 */
  Main: undefined;
  /** 阅读器（书架 / 搜索结果 / 收藏列表均可进入） */
  Reader: ReaderRouteParams;
  /** 背诵练习（背诵 Tab「背诵助手」选章进入） */
  RecitationPractice: RecitationPracticeParams;
  /** 查字页（阅读器解析面板「在字典中查看」直达；任何位置可进入） */
  DictLookup: DictLookupParams;
  /** 词典管理页（RootStack 级注册：RootStack 实例的查字页可直达，
   * 返回逐级回到查字页/阅读器，不再绕道「我的」Tab） */
  DictManage: undefined;
};

/** 查字页路由参数 */
export interface DictLookupParams {
  /** 待查询字头（阅读器跳转时携带） */
  headword?: string;
}

/** 底部 Tab 参数表 */
export type MainTabParamList = {
  /** 书架 */
  Library: undefined;
  /** 背诵（背诵助手 + 背诵练习） */
  Recite: undefined;
  /** 我的 */
  Profile: undefined;
};

/** 书架 Tab Stack：书架首页 + 搜索入口 */
export type LibraryStackParamList = {
  Library: undefined;
  Search: undefined;
};

/** 背诵 Tab Stack：背诵助手页 + 背诵练习页 */
export type ReciteStackParamList = {
  Recitation: undefined;
  RecitationPractice: RecitationPracticeParams;
};

/** 我的 Tab Stack：个人中心、词典三屏、收藏 / 笔记 / 成就页面 */
export type ProfileStackParamList = {
  Profile: undefined;
  /** 查字页（「我的」页词典分组进入；阅读器直达走 RootStack.DictLookup） */
  DictLookup: DictLookupParams;
  /** 词典管理页 */
  DictManage: undefined;
  /** 字典导入页 */
  DictImport: undefined;
  Bookmarks: undefined;
  NotesList: undefined;
  /** 成就页（P2-06） */
  Achievements: undefined;
  /** 学习统计页（P2-14 学习社区本地版） */
  StudyStats: undefined;
};

/**
 * 应用级全路由表：各页面声明 NativeStackScreenProps 时统一使用，
 * 覆盖全部可 navigate 的路由名（实际挂载位置见 RootNavigator）。
 */
export type AppStackParamList = {
  /** 书架页 */
  Library: undefined;
  /** 工具箱入口页 */
  Toolbox: undefined;
  /** 繁简转换页 */
  Conversion: undefined;
  /** 全文搜索页 */
  Search: undefined;
  /** 背诵助手页 */
  Recitation: undefined;
  /** 背诵练习页 */
  RecitationPractice: RecitationPracticeParams;
  /** 我的页 */
  Profile: undefined;
  /** 收藏列表页 */
  Bookmarks: undefined;
  /** 笔记列表页 */
  NotesList: undefined;
  /** 成就页（P2-06） */
  Achievements: undefined;
  /** 学习统计页（P2-14 学习社区本地版） */
  StudyStats: undefined;
  /** 阅读器页 */
  Reader: ReaderRouteParams;
  /** 查字页（字典 Tab） */
  DictLookup: DictLookupParams;
  /** 字典管理页 */
  DictManage: undefined;
  /** 字典导入页 */
  DictImport: undefined;
};
