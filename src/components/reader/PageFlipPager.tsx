/**
 * 仿真翻页容器（PageFlipPager）
 * - 横向 Animated.ScrollView（pagingEnabled）承载各页，支持滑动翻页 / 吸附。
 * - 翻页阴影：基于实时滚动偏移用 SVG 线性渐变绘制方向性暗化（向右翻→右缘变暗，
 *   向左翻→左缘变暗），营造「纸张翻起」的仿真观感（纯 JS，无额外原生依赖）。
 * - 左右边缘点击热区翻页（中部保留给长按选词 / 划线交互）。
 * - 受控组件：index 由父级维护，onIndexChange 回传，跨章边沿通过 onEdgeReached 上报。
 * - 窗口化渲染：只全量渲染当前页附近窗口内的页（问题 3 修复），窗口外页为
 *   同尺寸空占位——整章一次性渲染数百页 PinyinText 会压死 JS 线程（loading 极久）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Svg, { LinearGradient, Rect, Stop } from 'react-native-svg';

import type { ThemeColors } from '@/theme';
import { computePageRenderWindow, PAGE_RENDER_WINDOW_MARGIN } from '@/utils/readerPageWindow';

export interface PageFlipPagerProps {
  /** 当前页索引（受控） */
  index: number;
  /** 总页数 */
  pageCount: number;
  /** 单页宽（px） */
  pageWidth: number;
  /** 单页高（px） */
  pageHeight: number;
  /** 当前纸张配色（取正文色作翻页阴影） */
  colors: ThemeColors;
  /** 翻页后回调（用于父级记录阅读位置） */
  onIndexChange: (i: number) => void;
  /** 已在第一页仍向右翻 / 最后一页仍向左翻时上报，父级用于跨章 */
  onEdgeReached?: (dir: 'prev' | 'next') => void;
  /** 渲染指定页内容 */
  renderPage: (i: number) => React.ReactNode;
}

export function PageFlipPager({
  index,
  pageCount,
  pageWidth,
  pageHeight,
  colors,
  onIndexChange,
  onEdgeReached,
  renderPage,
}: PageFlipPagerProps): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(index * pageWidth)).current;
  /**
   * 【7】翻页阴影基准（动画值）：落位页的起始 x。
   * 旧实现把受控 index 派生的 settled*pageWidth（普通数值）直接编进插值表达式，
   * 表达式里记录的是「创建那一刻的 settled」，落位时仅 setValue scrollX——
   * 新 scrollX × 旧 settled 会在 React 提交新表达式前的若干帧内被求值为 ±1，
   * clamp 后阴影满档 → 左/右半屏黑影闪现（JS 繁忙时持续多帧，即真机黑影根因）。
   * 改为 Animated 值后，落位时与 scrollX 在同一 JS tick 内先后 setValue，
   * 插值图当帧即收敛回 0，不依赖重渲染时机。
   */
  const baseX = useRef(new Animated.Value(index * pageWidth)).current;
  const lastIndex = useRef(index);
  /**
   * 已「落位」的页 = 横向 ScrollView 物理上正停在的那一页。
   * 翻页阴影必须以它为基准：若改用受控 index（点击后会立刻变成【目标页】）作基准，
   * 而物理滚动还没跟上，norm 会算成 -1，于是本该「向右翻」的阴影被渲染成
   * 左侧半屏黑影，且内容停在原页 —— 即「点了翻页没反应还多出一块黑影」。
   */
  const [settled, setSettled] = useState(index);

  // 外部 index 变化（定位 / 跨章回来）时，无动画滚动到对应页并同步落位
  useEffect(() => {
    if (index !== lastIndex.current) {
      lastIndex.current = index;
      setSettled(index);
      baseX.setValue(index * pageWidth);
      scrollX.setValue(index * pageWidth);
      scrollRef.current?.scrollTo({ x: index * pageWidth, animated: false });
    }
  }, [index, pageWidth, scrollX, baseX]);

  // 页数变化（重分页 / 超高段拆分块落地 / 切章）后统一重对齐物理落位：
  // contentContainerStyle 宽度随之变化，此前设置的 scrollTo 可能因内容尺寸
  // 未提交而失效，导致 scrollX 与 settled 失步。把落位钳回有效区间并强制
  // 滚动/赋值到 settled*pageWidth，消除失步（钳制越界落位也一并覆盖）。
  useEffect(() => {
    if (pageCount <= 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(lastIndex.current, pageCount - 1));
    const x = clamped * pageWidth;
    lastIndex.current = clamped;
    setSettled((prev) => (prev === clamped ? prev : clamped));
    baseX.setValue(x);
    scrollX.setValue(x);
    scrollRef.current?.scrollTo({ x, animated: false });
  }, [pageCount, pageWidth, scrollX, baseX]);

  /** 落位到指定页：同时同步「物理滚动位置 + 落位页 + 阴影基准」三者。
   *  点击翻页采用无动画直接落位——程序化动画滚动的结束时机在 iOS/Android 上并不可靠，
   *  若延后同步 settled 就会残留半屏阴影；手势滑动的阴影仍由 onScroll 实时驱动。
   *  【7】baseX 与 scrollX 必须在同一 JS tick 内先后 setValue（阴影基准先行），
   *  插值图最终 norm=0，不再等待 settled 重渲染提交（黑影闪烁根因，见 baseX 注释）。 */
  const goTo = useCallback(
    (i: number) => {
      const target = Math.max(0, Math.min(pageCount - 1, i));
      setSettled(target);
      onIndexChange(target);
      lastIndex.current = target;
      baseX.setValue(target * pageWidth);
      scrollX.setValue(target * pageWidth);
      scrollRef.current?.scrollTo({ x: target * pageWidth, animated: false });
    },
    [pageCount, onIndexChange, pageWidth, scrollX, baseX],
  );

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      let target = Math.round(x / pageWidth);
      if (target < 0) {
        onEdgeReached?.('prev');
        target = 0;
      } else if (target > pageCount - 1) {
        onEdgeReached?.('next');
        target = pageCount - 1;
      }
      goTo(target);
    },
    [pageWidth, pageCount, onEdgeReached, goTo],
  );

  const handleTapPrev = useCallback(() => {
    if (settled > 0) {
      goTo(settled - 1);
    } else {
      onEdgeReached?.('prev');
    }
  }, [settled, goTo, onEdgeReached]);

  const handleTapNext = useCallback(() => {
    if (settled < pageCount - 1) {
      goTo(settled + 1);
    } else {
      onEdgeReached?.('next');
    }
  }, [settled, pageCount, goTo, onEdgeReached]);

  // 翻页进度：相对「阴影基准页起始 x」的偏移 / 页宽，约 [-1, 1]
  // 【7】基准为动画值 baseX（落位时同步 setValue），不再依赖 settled 重渲染
  const norm = Animated.divide(Animated.subtract(scrollX, baseX), pageWidth);
  // 向右翻（next）：norm ∈ [0,1]；向左翻（prev）：norm ∈ [-1,0]。
  // 用「直接 clamp 插值」而非 diffClamp：diffClamp 跟踪的是增量，scrollX 一旦
  // 与 settled 瞬时失步（如重分页时 scrollTo 因内容尺寸未提交而失效），norm 会
  // 跳到 ±1 且阴影被锁存在满档不回零 —— 即「翻页后残留黑色半屏阴影」；
  // 直接 clamp 在 scrollX 恢复对齐的瞬间自动归零，失步只产生一帧过渡阴影。
  const nextOpacity = norm.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const prevOpacity = Animated.multiply(norm, -1).interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const shadowColor = colors.text;

  // 窗口化渲染区间（问题 3：整章一次性渲染把 JS 线程压死）：只全量渲染落在
  // 「受控 index ∪ 落位 settled」前后各 PAGE_RENDER_WINDOW_MARGIN 页窗口内的页，
  // 窗口外页渲染同尺寸空占位。窗口随 settled / index 翻页滑动——翻一页至多新增
  // 1~2 页挂载（PinyinText 全量注音成本高），滑出窗口的页卸载、滑入的页挂载，
  // 横向 ScrollView 的内容宽度与分页完全不变（占位 View 同宽同高）。
  // 取 index 与 settled 并集：点击翻页后 index 立即变目标页、settled 落位才更新，
  // 并集保证「滚向的目标页」与「离开的原页」滑动过程中都不空白。
  const renderWindow = useMemo(
    () => computePageRenderWindow(index, settled, pageCount, PAGE_RENDER_WINDOW_MARGIN),
    [index, settled, pageCount],
  );

  return (
    <View style={styles.container} pointerEvents="box-none">
      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false },
        )}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        contentContainerStyle={{ width: pageWidth * Math.max(1, pageCount) }}
        style={{ width: pageWidth, height: pageHeight }}
      >
        {Array.from({ length: Math.max(1, pageCount) }).map((_, i) => (
          <View key={i} style={{ width: pageWidth, height: pageHeight }}>
            {/* 窗口内全量渲染；窗口外同尺寸空占位（宽度/分页不变）。
                renderPage 返回 null / 兜底占位时自然退化为空页，无需特殊处理。 */}
            {i >= renderWindow.start && i <= renderWindow.end ? renderPage(i) : null}
          </View>
        ))}
      </Animated.ScrollView>

      {/* 仿真翻页阴影：向右翻时右缘暗化，向左翻时左缘暗化 */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: nextOpacity, pointerEvents: 'none' }]}
      >
        <Svg height={pageHeight} width={pageWidth} style={StyleSheet.absoluteFill}>
          <LinearGradient id="flipNext" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0%" stopColor={shadowColor} stopOpacity="0" />
            <Stop offset="100%" stopColor={shadowColor} stopOpacity="0.35" />
          </LinearGradient>
          <Rect x={pageWidth * 0.55} y={0} width={pageWidth * 0.45} height={pageHeight} fill="url(#flipNext)" />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: prevOpacity, pointerEvents: 'none' }]}
      >
        <Svg height={pageHeight} width={pageWidth} style={StyleSheet.absoluteFill}>
          <LinearGradient id="flipPrev" x1="1" y1="0" x2="0" y2="0">
            <Stop offset="0%" stopColor={shadowColor} stopOpacity="0" />
            <Stop offset="100%" stopColor={shadowColor} stopOpacity="0.35" />
          </LinearGradient>
          <Rect x={0} y={0} width={pageWidth * 0.45} height={pageHeight} fill="url(#flipPrev)" />
        </Svg>
      </Animated.View>

      {/* 点击翻页热区：左右边缘（中部保留给长按选词 / 划线） */}
      <View style={[StyleSheet.absoluteFill, { pointerEvents: 'box-none' }]}>
        <Pressable
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pageWidth * 0.16 }}
          onPress={handleTapPrev}
          accessibilityRole="button"
          accessibilityLabel="上一页"
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: pageWidth * 0.16 }}
          onPress={handleTapNext}
          accessibilityRole="button"
          accessibilityLabel="下一页"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
});

export default PageFlipPager;
