/**
 * ScrollMode——原生 FlatList 连续滚动模式（ReaderCore 的 scroll 渲染策略）。
 *
 * 2026-09-29 重构：由「自绘连续画布 + translateY + 基址表 + PanResponder 手写手势」
 * 改为原生 FlatList 平铺滚动（与 PageMode 同族）。放弃 legado 式自绘滚动语义，
 * 手势/惯性/边界回弹交给系统；仅保留语义层：跨章提交、进度记账、边沿装载。
 *
 * 保留语义（与滚动实现无关）：
 * - 跨章提交：onScroll 里 contentOffset.y → 视口顶行 → line.chapterId，与 committed
 *   章比对，变了则 onChapterCommit（跨章进度/预载回流）；
 * - 进度记账：滚动静止（MomentumEnd / DragEnd 静置）→ onLineChange（码点真值）；
 * - 边沿装载：onScroll 检测临近 contentSize 两端 → onNearBoundary（宿主续装邻章）。
 *
 * 平铺数据 = stitched.lines（含章标题行，每行自带 chapterId / isTitle / charStart），
 * 直接作为 FlatList data；行高恒等 rowHeight（INV-G1）⇒ getItemLayout 纯算式定位。
 * 查词/划线交互已下沉到 renderLine（LineRow 的 onPressChar / onLongPressChar），
 * 本组件不感知；点击翻页由左右热区 scrollToOffset 承担（复用 PageMode 取舍）。
 */
import React, { memo, useCallback, useMemo, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Line, LineGeometry } from '../../geometry';
import { getItemLayoutOf } from '../../geometry';
import type { BoundaryDirection } from '../types';

export interface ScrollModeProps {
  /** 平铺行流（stitched.lines，含章标题行；数组序=书序） */
  lines: readonly Line[];
  /** 书级边界（窗口外未载章方向） */
  hasMorePrev: boolean;
  hasMoreNext: boolean;
  /** 初始章 id（= activeChapterId；跨章提交起点） */
  initialChapterId: string;
  /** 挂载定位行下标（全局，stitched 序列；charOffset → 行号投影） */
  initialLineIndex: number;
  geometry: LineGeometry;
  viewportH: number;
  /**
   * 版心壳左右偏移（reader/contentLayout.ts 唯一真源）。
   * 作为 FlatList contentContainer 水平内边距 ⇒ 内容宽 = 视口宽 − left − right
   * **恒 = 行化 containerWidth**（同值 ⇒ 行化切出的整行字都能装下）。
   */
  contentInsets: { left: number; right: number };
  renderLine(line: Line): React.ReactNode;
  /** 跨章提交（跨章进度/预载回流） */
  onChapterCommit(chapterId: string, firstLine: Line | undefined): void;
  /** 滚动静止 → 进度上报（码点真值持久化） */
  onLineChange?(line: Line | undefined): void;
  /** 视口临近窗口已载边沿（未载方向）→ 上抛宿主续装邻章 */
  onNearBoundary?(dir: BoundaryDirection): void;
  /** 边沿邻章装载失败标记（仅改变占位文案，不阻断重试） */
  loadError?: { next?: boolean; prev?: boolean };
  /** 重挂载键（切模式/跳章触发全新列表） */
  listKey?: string;
}

/** 章内页首若为标题行（stitch 注入 segmentId='__title__'），进度取首个正文行 */
function firstContentLineOf(lines: readonly Line[], startIdx: number): Line | undefined {
  for (let i = Math.max(0, startIdx); i < lines.length; i++) {
    if (!lines[i].isTitle) return lines[i];
  }
  return lines.length > 0 ? lines[0] : undefined;
}

const ScrollMode = memo(function ScrollMode({
  lines,
  hasMorePrev,
  hasMoreNext,
  initialChapterId,
  initialLineIndex,
  geometry,
  viewportH,
  contentInsets,
  renderLine,
  onChapterCommit,
  onLineChange,
  onNearBoundary,
  loadError,
  listKey,
}: ScrollModeProps) {
  const listRef = useRef<FlatList<Line> | null>(null);
  const rowH = Math.max(1, geometry.rowHeight);
  const lpp = Math.max(1, Math.floor(viewportH / rowH));

  // ── 跨章记账真值源（ref；onScroll 高频更新，不触发重渲染）──
  const committedRef = useRef(initialChapterId);
  // 视口顶行下标（onScroll 更新，供翻页用）
  const topLineRef = useRef(0);
  const nearStateRef = useRef<{ next: boolean; prev: boolean }>({ next: false, prev: false });

  // 回调 ref 化（onScroll 高频，防 stale closure）
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const commitRef = useRef(onChapterCommit);
  commitRef.current = onChapterCommit;
  const lineChangeRef = useRef(onLineChange);
  lineChangeRef.current = onLineChange;
  const nearBoundaryRef = useRef(onNearBoundary);
  nearBoundaryRef.current = onNearBoundary;

  const getItemLayout = useMemo(() => getItemLayoutOf(geometry), [geometry]);

  /**
   * contentOffset.y → 视口顶行定位：更新 topLineRef + 跨章提交（章变化去重）
   * + 边沿装载（状态沿去重）。★ 进度记账不在此（onScroll 每 16ms 一次，
   * recordProgress 写 MMKV 不能每帧写）——只在滚动静止 handleScrollEnd 上报。
   */
  const handleScroll = useCallback(
    (y: number) => {
      const cur = linesRef.current;
      if (cur.length === 0) return;
      const idx = Math.min(Math.max(Math.floor(y / rowH), 0), cur.length - 1);
      topLineRef.current = idx;
      const line = cur[idx];
      if (!line) return;

      // 跨章提交：视口顶行所属章变化 → onChapterCommit（页首标题行跳过取正文行）
      if (line.chapterId !== committedRef.current) {
        committedRef.current = line.chapterId;
        commitRef.current(line.chapterId, firstContentLineOf(cur, idx));
      }

      // 边沿装载：临近已载窗口两端 → 上抛续装（进区报一次，出区重置）
      if (nearBoundaryRef.current) {
        const totalH = cur.length * rowH;
        const nearNext = hasMoreNext && y > totalH - viewportH * 3;
        const nearPrev = hasMorePrev && y < viewportH;
        if (nearNext !== nearStateRef.current.next) {
          nearStateRef.current.next = nearNext;
          if (nearNext) nearBoundaryRef.current('next');
        }
        if (nearPrev !== nearStateRef.current.prev) {
          nearStateRef.current.prev = nearPrev;
          if (nearPrev) nearBoundaryRef.current('prev');
        }
      }
    },
    [rowH, viewportH, hasMoreNext, hasMorePrev],
  );

  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      handleScroll(e.nativeEvent.contentOffset.y);
    },
    [handleScroll],
  );

  // 滚动静止 → 进度真值持久化（复用 PageMode 静止门控：动量/慢拖防双派发）
  const momentumRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const y = e.nativeEvent.contentOffset.y;
      const cur = linesRef.current;
      if (cur.length === 0) return;
      const idx = Math.min(Math.max(Math.floor(y / rowH), 0), cur.length - 1);
      lineChangeRef.current?.(firstContentLineOf(cur, idx));
    },
    [rowH],
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

  // 点击翻页：滚一屏（下翻前进一屏、上翻后退一屏）
  const flipNext = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: (topLineRef.current + lpp) * rowH, animated: true });
  }, [lpp, rowH]);
  const flipPrev = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: Math.max(0, topLineRef.current - lpp) * rowH, animated: true });
  }, [lpp, rowH]);

  const keyExtractor = useCallback(
    (item: Line) =>
      item.isTitle
        ? `${item.chapterId}#title`
        : `${item.chapterId}#${item.segmentId}#${item.charStart}`,
    [],
  );

  return (
    <View style={styles.wrap}>
      <FlatList<Line>
        key={listKey}
        data={lines as Line[]}
        renderItem={({ item }) => renderLine(item) as React.ReactElement}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        onScrollEndDrag={handleDragEnd}
        onMomentumScrollBegin={handleMomentumBegin}
        onMomentumScrollEnd={handleMomentumEnd}
        initialScrollIndex={initialLineIndex > 0 ? initialLineIndex : undefined}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({ offset: info.index * rowH, animated: false });
        }}
        scrollEventThrottle={16}
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        windowSize={9}
        ListHeaderComponent={
          hasMorePrev ? (
            <View style={[styles.loading, { height: viewportH }]}>
              <Text style={styles.loadingText}>{loadError?.prev ? '加载失败，滑动重试' : '加载中…'}</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          hasMoreNext ? (
            <View style={[styles.loading, { height: viewportH }]}>
              <Text style={styles.loadingText}>
                {loadError?.next ? '加载失败，滑动重试' : '继续滑动以加载下一章…'}
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={{
          paddingLeft: contentInsets.left,
          paddingRight: contentInsets.right,
        }}
        style={styles.list}
        ref={listRef}
      />
      {/* 左右热区翻页（复用 PageMode 取舍：左/右 30% 翻页，中间保留点字查词） */}
      <Pressable
        style={[styles.tapZoneL, { bottom: 0 }]}
        accessibilityLabel="上一屏"
        onPress={flipPrev}
      />
      <Pressable
        style={[styles.tapZoneR, { bottom: 0 }]}
        accessibilityLabel="下一屏"
        onPress={flipNext}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  list: { flex: 1 },
  loading: { alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#888' },
  tapZoneL: { position: 'absolute', left: 0, top: 0, width: '30%', zIndex: 10 },
  tapZoneR: { position: 'absolute', right: 0, top: 0, width: '30%', zIndex: 10 },
});

export default ScrollMode;
export { ScrollMode };
