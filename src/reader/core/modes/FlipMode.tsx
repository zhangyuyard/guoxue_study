/**
 * FlipMode——横向翻页模式（ReaderCore 的 cover / slide / none 渲染策略）。
 *
 * 对齐 @tangfeifan/react-native-reader 的三种横向 FlipMode（MIT，行为参照非代码复制）：
 * - cover 覆盖：next = 新页从右滑入盖住当前页；prev = 当前页向右滑出露出下页；
 * - slide 平移：前后两页同步平移（旧页出、新页进，等速）；
 * - none 无动画：点击直接切页。
 *
 * 实现（纯 RN Animated，零新依赖；仿真 simulation 依赖 Skia 延后——
 * 见 docs/reader-flip-modes-migration-assessment-2026-09-29.md）：
 * - 页 = 定长行区间（复用 pagination.paginateChapter + chunkLines，行对齐不裁半行）；
 * - 双缓冲：动画期间渲染 top/bottom 两层（各带不透明背景），单一 progress 0→1
 *   经 interpolate 驱动两层 translateX；结束回切单页渲染；
 * - 边界（第 0 页向前 / 末页向后）上抛 onBoundaryPrev/onBoundaryNext 由宿主跳章；
 * - 进度记账：翻页落定 → onProgressCommit(页首行)（码点真值，与 PageMode 同口径）；
 * - 热区：左右 30% 翻页、中间保留点字查词/长按划线（renderItem 注入，组件不感知）；
 *   bottom 让位 footerInset 防透明热区吞 footer 按钮（真机实证）。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { chunkLines, paginateChapter } from '../../pagination';
import type { ChapterLayout, Line, LineGeometry } from '../../geometry';

export type FlipAnimation = 'cover' | 'slide' | 'none';

export interface FlipModeProps {
  /** 当前章排版结果（含章首标题行；与 PageMode 同源） */
  layout: ChapterLayout;
  geometry: LineGeometry;
  /** 视口高（分页） */
  viewportH: number;
  /** 视口宽（translateX 行程 = 视口宽） */
  viewportW: number;
  /**
   * 版心壳左右偏移（与 PageMode 同口径）：页内容水平内边距
   * ⇒ 内容宽 = 视口宽 − left − right = 行化 containerWidth。
   */
  contentInsets: { left: number; right: number };
  /** 底栏高度（热区 bottom 让位，防透明热区吞 footer 按钮） */
  footerInset: number;
  /** 翻页动画：覆盖 / 平移 / 无动画 */
  animation: FlipAnimation;
  /** 页背景色（横向翻页两页重叠，页必须不透明，否则下层透出） */
  pageBackgroundColor: string;
  /** 行渲染（拼音逐字交互由上层注入） */
  renderItem(line: Line): React.ReactNode;
  /** 挂载定位页号（charOffset → 行号 → 页号投影） */
  initialPage: number;
  /** 重挂载键（切章/跳章/切模式） */
  listKey: string;
  /** 翻页落定 → 位置真值持久化（页首行，码点） */
  onProgressCommit(line: Line): void;
  /** 第 0 页向前翻（宿主跳上一章） */
  onBoundaryPrev?(): void;
  /** 末页向后翻（宿主跳下一章） */
  onBoundaryNext?(): void;
}

const FLIP_DURATION_MS = 220;

const FlipMode = memo(function FlipMode({
  layout,
  geometry,
  viewportH,
  viewportW,
  contentInsets,
  footerInset,
  animation,
  pageBackgroundColor,
  renderItem,
  initialPage,
  onProgressCommit,
  onBoundaryPrev,
  onBoundaryNext,
}: FlipModeProps) {
  const pagination = useMemo(
    () => paginateChapter(layout, geometry, viewportH),
    [layout, geometry, viewportH],
  );
  const pages = useMemo(
    () => chunkLines(layout.lines, pagination.linesPerPage),
    [layout.lines, pagination.linesPerPage],
  );
  const pageCount = Math.max(1, pages.length);

  const rowH = Math.max(1, geometry.rowHeight);

  const [curPage, setCurPage] = useState(() =>
    Math.min(Math.max(initialPage, 0), pageCount - 1),
  );
  // 页数收缩 clamp：字号/边距变化 ⇒ linesPerPage 变 ⇒ pageCount 变，组件不重挂
  // （listKey 不含几何版本）⇒ curPage 可能越界 ⇒ renderPage 返回 null = 白屏。
  // PageMode 有 FlatList 滚动 clamp 自愈，FlipMode 必须显式 clamp。
  useEffect(() => {
    setCurPage((p) => Math.min(Math.max(p, 0), pageCount - 1));
  }, [pageCount]);

  // ── 双缓冲动画层（动画期间非 null）──
  interface Layer {
    page: number;
    /** translateX 起止：from + (to − from) × progress */
    from: number;
    to: number;
  }
  const [layers, setLayers] = useState<{ top: Layer; bottom: Layer } | null>(null);
  const progressRef = useRef(new Animated.Value(0));
  const animatingRef = useRef(false);
  const curPageRef = useRef(curPage);
  curPageRef.current = curPage;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const commitRef = useRef(onProgressCommit);
  commitRef.current = onProgressCommit;

  /** 页号 → 该页首行（记账用；跳过标题行取首个正文行） */
  const firstContentLineOfPage = useCallback(
    (page: number): Line | undefined => {
      const pageLines = pagesRef.current[Math.min(Math.max(page, 0), pagesRef.current.length - 1)];
      if (!pageLines || pageLines.length === 0) {
        return undefined;
      }
      for (const l of pageLines) {
        if (!l.isTitle) {
          return l;
        }
      }
      return pageLines[0];
    },
    [],
  );

  const renderPage = useCallback(
    (page: number) => {
      const pageLines = pagesRef.current[page];
      if (!pageLines) {
        return null;
      }
      return (
        <View
          style={[
            styles.page,
            {
              backgroundColor: pageBackgroundColor,
              paddingLeft: contentInsets.left,
              paddingRight: contentInsets.right,
            },
          ]}
        >
          {pageLines.map((line) => (
            <View key={`${line.chapterId}#${line.isTitle ? 'title' : `${line.segmentId}#${line.charStart}`}`} style={{ height: rowH }}>
              {renderItem(line) as React.ReactNode}
            </View>
          ))}
        </View>
      );
    },
    [pageBackgroundColor, contentInsets.left, contentInsets.right, rowH, renderItem],
  );

  const finishFlip = useCallback(
    (target: number) => {
      animatingRef.current = false;
      setLayers(null);
      setCurPage(target);
      const line = firstContentLineOfPage(target);
      if (line) {
        commitRef.current(line);
      }
    },
    [firstContentLineOfPage],
  );

  /** 翻页入口：dir=1 下一页 / -1 上一页（与 PageMode 热区同签名） */
  const flipPage = useCallback(
    (dir: 1 | -1) => {
      if (animatingRef.current) {
        return; // 动画中吞输入（防连点叠帧）
      }
      const from = curPageRef.current;
      const target = from + dir;
      if (target < 0) {
        onBoundaryPrev?.();
        return;
      }
      if (target > pageCount - 1) {
        onBoundaryNext?.();
        return;
      }
      if (animation === 'none' || viewportW <= 0) {
        finishFlip(target);
        return;
      }
      // 双缓冲布局：top 层滑、bottom 层垫（cover）或同步滑（slide）
      const top: Layer =
        dir === 1
          ? { page: target, from: viewportW, to: 0 } // next：新页从右滑入（上层）
          : { page: from, from: 0, to: viewportW }; // prev：旧页向右滑出（上层）
      const bottom: Layer =
        dir === 1
          ? { page: from, from: 0, to: animation === 'slide' ? -viewportW : 0 }
          : { page: target, from: animation === 'slide' ? -viewportW : 0, to: animation === 'slide' ? 0 : 0 };
      animatingRef.current = true;
      const p = progressRef.current;
      p.setValue(0);
      setLayers({ top, bottom });
      // 等 layers 真正挂载后再启动（同帧启动会打在空树上）
      requestAnimationFrame(() => {
        Animated.timing(p, {
          toValue: 1,
          duration: FLIP_DURATION_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) {
            finishFlip(target);
          }
        });
      });
    },
    [animation, finishFlip, onBoundaryNext, onBoundaryPrev, pageCount, viewportW],
  );

  // 两层 translateX 插值（layers 变化时重算 range）
  const topX = layers
    ? progressRef.current.interpolate({
        inputRange: [0, 1],
        outputRange: [layers.top.from, layers.top.to],
      })
    : 0;
  const bottomX = layers
    ? progressRef.current.interpolate({
        inputRange: [0, 1],
        outputRange: [layers.bottom.from, layers.bottom.to],
      })
    : 0;

  return (
    <View style={styles.wrap}>
      {layers ? (
        <>
          <Animated.View style={[styles.layer, { transform: [{ translateX: bottomX }] }]}>
            {renderPage(layers.bottom.page)}
          </Animated.View>
          <Animated.View style={[styles.layer, { transform: [{ translateX: topX }] }]}>
            {renderPage(layers.top.page)}
          </Animated.View>
        </>
      ) : (
        renderPage(curPage)
      )}
      {/* 左右热区（与 PageMode 同取舍：左/右 30% 翻页，中间保留点字查词/长按划线） */}
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
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    overflow: 'hidden',
  },
  page: {
    flex: 1,
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
  },
  tapZoneL: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '30%',
    zIndex: 10,
  },
  tapZoneR: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: '30%',
    zIndex: 10,
  },
});

export default FlipMode;
export { FlipMode };
