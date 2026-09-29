/**
 * PageMode——逐页滚动模式（ReaderCore 的 page 渲染策略）。
 * 自 ReaderScreen 内联分支拆出（原 FlatList + 翻页热区 + 滚动静止门控）；
 * 分层架构对齐 @tangfeifan/react-native-reader（MIT）的模式可插拔思想。
 * 排版/分页为本仓自研（layout/pagination：定行高 + getItemLayout 纯算式）。
 */
import React, { useCallback, useMemo, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { charOffsetAtY } from '../../position';
import { offsetOfPage, pageAtOffset, paginateChapter } from '../../pagination';
import {
  getItemLayoutOf,
  type ChapterLayout,
  type Line,
  type LineGeometry,
} from '../../geometry';

export interface PageModeProps {
  /** 当前章排版结果（含章首标题行） */
  layout: ChapterLayout;
  geometry: LineGeometry;
  /**
   * 版心壳左右偏移（与 scroll 模式同口径，见 reader/contentLayout.ts）。
   * 作为 FlatList contentContainer 的水平内边距 ⇒ 页内容宽 = 视口宽 − left − right
   * **恒 = 行化 containerWidth**（二者必须同值，否则行化切出的字数装不下被裁）。
   * left ≠ right 是刻意的：差值 2×shift 把「整字数文字块」摆到版心正中。
   */
  contentInsets: { left: number; right: number };
  /** 视口高（分页截断与页步长计算） */
  viewportH: number;
  /** 底栏高度（热区 bottom 让位，防透明热区吞 footer 按钮） */
  footerInset: number;
  /** 行渲染（拼音逐字交互由上层注入） */
  renderItem(line: Line): React.ReactNode;
  /** 挂载定位行号（FlatList initialScrollIndex） */
  initialLineIndex: number;
  /** 重挂载键（切章/跳章/切模式） */
  listKey: string;
  /** 滚动真静止 → 位置真值持久化（码点，非像素） */
  onProgressCommit(line: Line): void;
}

export const PageMode = React.memo(function PageMode({
  layout,
  geometry,
  contentInsets,
  viewportH,
  footerInset,
  renderItem,
  initialLineIndex,
  listKey,
  onProgressCommit,
}: PageModeProps) {
  const listRef = useRef<FlatList | null>(null);
  const rowH = Math.max(1, geometry.rowHeight);

  const pagination = useMemo(
    () => paginateChapter(layout, geometry, viewportH),
    [layout, geometry, viewportH],
  );

  // ── 滚动静止门控：动量与慢拖打架时避免双派发（真机实录：视觉跳动/楔死 FlatList）──
  const momentumRef = useRef(false);
  const draggingRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 滚动停止 → 位置真值持久化（章内；码点真值）+ R3 互切页号单源同步
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;
  const linesRef = useRef(layout.lines);
  linesRef.current = layout.lines;
  const progressRef = useRef(onProgressCommit);
  progressRef.current = onProgressCommit;

  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const y = e.nativeEvent.contentOffset.y;
      const cur = linesRef.current;
      if (cur.length === 0) {
        return;
      }
      const pos = charOffsetAtY(cur, geometry, y);
      const line = cur[pos.lineIndex];
      if (!line) {
        return;
      }
      progressRef.current(line);
      // R3 互切：滚动位置 → 页号单源同步（翻页落点由同一 offset 系推导）
      if (paginationRef.current.pageCount > 0) {
        curPageRef.current = pageAtOffset(paginationRef.current, y);
      }
    },
    [geometry],
  );

  const handleMomentumBegin = useCallback(() => {
    momentumRef.current = true;
    if (dragEndTimerRef.current) {
      clearTimeout(dragEndTimerRef.current);
      dragEndTimerRef.current = null;
    }
  }, []);
  const handleMomentumEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      momentumRef.current = false;
      handleScrollEnd(e);
    },
    [handleScrollEnd],
  );
  const handleDragEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      draggingRef.current = false;
      // 慢拖（无动量）路径：稍候确认真静止再派发；动量接管则由 MomentumEnd 派发
      if (dragEndTimerRef.current) {
        clearTimeout(dragEndTimerRef.current);
      }
      dragEndTimerRef.current = setTimeout(() => {
        dragEndTimerRef.current = null;
        if (!momentumRef.current) {
          handleScrollEnd(e);
        }
      }, 120);
    },
    [handleScrollEnd],
  );
  const handleScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);

  // ── 翻页热区（R3-2 MVP）：左右 30% 翻页、中间 40% 保留点字查词/长按划线（legado 同款取舍）──
  const curPageRef = useRef(0);
  const flipPage = useCallback((dir: 1 | -1) => {
    const pg = paginationRef.current;
    if (pg.pageCount === 0) {
      return;
    }
    const next = Math.min(Math.max(curPageRef.current + dir, 0), pg.pageCount - 1);
    listRef.current?.scrollToOffset({ offset: offsetOfPage(pg, next), animated: true });
    curPageRef.current = next;
  }, []);

  const getItemLayout = useMemo(() => getItemLayoutOf(geometry), [geometry]);

  return (
    <View style={styles.wrap}>
      <FlatList
        key={listKey}
        data={layout.lines}
        renderItem={({ item }): React.ReactElement => renderItem(item) as React.ReactElement}
        keyExtractor={(item) =>
          // ★ 稳定逻辑键：位置敏感键在装/裁章时全体漂移 ⇒ FlatList 全量重挂 ⇒ 闪烁。
          //   行身份 = (章, 段, 段内码点)。
          item.isTitle
            ? `${item.chapterId}#title`
            : `${item.chapterId}#${item.segmentId}#${item.charStart}`
        }
        getItemLayout={getItemLayout}
        onScrollEndDrag={handleDragEnd}
        onMomentumScrollBegin={handleMomentumBegin}
        onMomentumScrollEnd={handleMomentumEnd}
        onScrollBeginDrag={handleScrollBeginDrag}
        initialScrollIndex={initialLineIndex > 0 ? initialLineIndex : undefined}
        onScrollToIndexFailed={(info) => {
          // getItemLayout 纯算式下理论不触发；兜底 = 开环 offset 直写
          listRef.current?.scrollToOffset({ offset: info.index * rowH, animated: false });
        }}
        scrollEventThrottle={16}
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        windowSize={9}
        contentContainerStyle={{
          paddingLeft: contentInsets.left,
          paddingRight: contentInsets.right,
        }}
        style={styles.list}
        ref={listRef}
      />
      {pagination.pageCount > 0 ? (
        <>
          <Pressable
            style={[styles.tapZoneL, { bottom: footerInset }]}
            accessibilityLabel="上一页"
            onPress={() => flipPage(-1)}
          />
          <Pressable
            style={[styles.tapZoneR, { bottom: footerInset }]}
            accessibilityLabel="下一页"
            onPress={() => flipPage(1)}
          />
        </>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  tapZoneL: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '30%',
    zIndex: 10,
  },
  tapZoneR: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '30%',
    zIndex: 10,
  },
});
