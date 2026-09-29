/**
 * ReaderCore——阅读器核心容器（分层架构）。
 *
 * 对齐 @tangfeifan/react-native-reader（MIT）的 Reader + ReaderFlip 容器/路由角色：
 * 模式路由（渲染策略可插拔）+ 章变化统一监听 + 边界事件收口。
 * 渲染模式：scroll=连续画布（ScrollMode）；page=逐页（PageMode）；
 * 后续 cover/slide/simulation 等（依赖 Skia/RN 升级）按 modes/ 目录追加。
 * 字符交互（查词/划线/拼音）由各模式经 renderLine/renderItem 注入，容器不感知。
 */
import React, { memo } from 'react';

import type { ReaderMode } from './types';
import { useChapterChange } from './useChapterChange';
import { ScrollMode, type ScrollModeProps } from './modes/ScrollMode';
import { PageMode, type PageModeProps } from './modes/PageMode';

export interface ReaderCoreProps {
  mode: ReaderMode;
  scroll?: ScrollModeProps;
  page?: PageModeProps;
  /** 当前章 id（章变化监听输入；null/undefined 时监听不生效） */
  chapterId?: string | null;
  /** 首个可读章（onPrepare）/ 后续章变化（onChapterChange） */
  onChapterPrepare?(event: { chapterId: string }): void;
  onChapterChange?(event: { chapterId: string }): void;
  /** 章监听暂停（VIP/统计暂停等场景；恢复后重建起点） */
  chapterTrackingDisabled?: boolean;
}

export const ReaderCore = memo(function ReaderCore({
  mode,
  scroll,
  page,
  chapterId,
  onChapterPrepare,
  onChapterChange,
  chapterTrackingDisabled,
}: ReaderCoreProps) {
  useChapterChange({
    chapterId,
    disabled: chapterTrackingDisabled,
    onPrepare: onChapterPrepare,
    onChapterChange,
  });

  if (mode === 'scroll') {
    // key = listKey：切章/跳章/切模式重挂载语义由上层 listKey 驱动（scroll 模式不含章 id）
    return scroll ? <ScrollMode key={scroll.listKey} {...scroll} /> : null;
  }
  return page ? <PageMode key={page.listKey} {...page} /> : null;
});
