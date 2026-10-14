/**
 * 目录（TOC）纯逻辑：章列表 → 弹层条目 / 当前章定位。
 *
 * 为什么单独成 `.ts`：jest 未配 react-native preset ⇒ 单测不能 import `.tsx`
 * （铁律 67③），把**可判定**的部分下沉到纯模块才能被用例锁住；
 * 弹层组件（`components/reader/ChapterTocSheet.tsx`）只负责渲染与手势。
 *
 * ★ 行高必须与渲染层**同源**：FlatList 的 `initialScrollIndex` 依赖
 *   `getItemLayout` 的精确性——行高与真实条目高度不一致时，打开目录不会停在
 *   当前章（**不报错、不红灯**，只是停在别处）。故 `TOC_ROW_H` 由此导出、
 *   组件 import，禁各写一份常量。
 */

import type { Chapter } from '@/types';

/** 目录条目行高（dp）。★ 组件渲染高度必须**恰好等于**它（差 1dp 即落点漂移）。 */
export const TOC_ROW_H = 52;

export interface TocItem {
  /** 章 id（跳章的唯一键） */
  readonly id: string;
  readonly title: string;
  /** 书内序号（0 起；仅用于展示，不作为键） */
  readonly index: number;
}

/** 章列表 → 目录条目（标题缺失时用空串，不猜「第 N 章」） */
export function buildTocItems(chapters: readonly Chapter[]): TocItem[] {
  return chapters.map((c, i) => ({ id: c.id, title: c.title ?? '', index: i }));
}

/** 当前章在目录中的下标；不在列表内（换书 / 章被删）⇒ -1 */
export function tocIndexOf(items: readonly TocItem[], chapterId: string): number {
  if (!chapterId) {
    return -1;
  }
  return items.findIndex((it) => it.id === chapterId);
}

/**
 * `initialScrollIndex` 的取值。★ 当前章不在列表内时**必须返回 `undefined`**，
 * 不能返回 0：返回 0 会让「书被换成另一本 / 当前章已删」这种异常态把用户
 * 强行送到第一章——把「不知道你在哪」变成「你被送到第一章了」，后者更糟。
 * `undefined` = 不定位，由列表自然停在顶部。
 */
export function tocInitialIndex(
  items: readonly TocItem[],
  chapterId: string,
): number | undefined {
  const i = tocIndexOf(items, chapterId);
  return i >= 0 ? i : undefined;
}
