/**
 * SliderField——设置页「进度条（滑块）」字段（零依赖实现）。
 *
 * 为什么自写：项目未引入 `@react-native-community/slider`；已有的
 * gesture-handler / reanimated / svg 都不适合直接当滑轨（前者要 GestureHandlerRootView 包裹，
 * 后者为画图而引入）。本控件 100 行内可控。
 *
 * 【三个必须踩对的实现点】
 * 1. **触摸目标恒为轨道容器本身**：视觉层（轨/填充/刻度/滑块）统一包在
 *    `pointerEvents="none"` 的子视图里 ⇒ `nativeEvent.locationX` 就是容器内坐标。
 *    若让滑块圆点接收触摸，`locationX` 会相对「被点中的子视图」⇒ 拖动时数值跳变。
 * 2. **坐标换算扣除滑块半径**：轨道可视区左右各留 `THUMB/2`，避免两端圆点被容器裁掉；
 *    换算逻辑在 `sliderMath.valueAtTouchX`（纯函数，可单测），轨道实测宽由 onLayout 给出。
 * 3. **吸附到网格且「值不变不上报」**：拖动一帧最多触发一次 store 写入；
 *    未命中新格时直接 return（否则每帧都写 store + 持久化，长按拖动会卡）。
 *
 * ⚠ 数学部分在 `./sliderMath.ts`（本仓 jest 不转 JSX ⇒ `.tsx` 无法被单测 import，
 *   可执行逻辑一律下沉 `.ts`；本组件只由源码文本断言覆盖）。
 */
import React, { useCallback, useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { SLIDER_THUMB, ratioOfValue, snapToGrid, valueAtTouchX } from './sliderMath';
import type { SliderSpec } from '@/theme/typography';

/** 触点条高度（≥44 易点区的一半；轨道本身只有 4dp） */
const TOUCH_HEIGHT = 40;
/** 刻度点显示上限（档数更多时只画轨道，避免糊成一片） */
const MAX_TICKS = 20;

/** 供设置页传入的最小配色子集（避免耦合 getColors 的完整返回类型） */
export interface SliderFieldColors {
  primary: string;
  border: string;
  text: string;
  textSecondary: string;
  card: string;
}

export interface SliderFieldProps {
  label: string;
  value: number;
  spec: SliderSpec;
  onChange: (v: number) => void;
  colors: SliderFieldColors;
  /** 值文本（默认 `String(值)`） */
  format?: (v: number) => string;
  /** 列表内联使用时画顶部细分隔线 */
  divider?: boolean;
}

export function SliderField({
  label,
  value,
  spec,
  onChange,
  colors,
  format,
  divider = false,
}: SliderFieldProps): React.JSX.Element {
  const snapped = snapToGrid(value, spec);
  const ratio = ratioOfValue(value, spec);
  // 轨道实测宽（onLayout 写入；不触发重渲染 —— 渲染只用百分比）
  const trackWRef = useRef(0);
  // 去重：只有吸附结果变化才上报（拖动一帧最多一次 store 写入）
  const lastRef = useRef(snapped);
  lastRef.current = snapped;

  const emitRef = useRef(onChange);
  emitRef.current = onChange;
  const specRef = useRef(spec);
  specRef.current = spec;

  const applyX = useCallback((locationX: number) => {
    const next = valueAtTouchX(locationX, trackWRef.current, specRef.current);
    if (next === null) return; // 轨道尚未测量
    if (next === lastRef.current) return; // 未换格 ⇒ 不写 store
    lastRef.current = next;
    emitRef.current(next);
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 滑块必须独占手势：否则纵向拖动会被设置页 ScrollView 抢走
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => applyX(e.nativeEvent.locationX),
        onPanResponderMove: (e) => applyX(e.nativeEvent.locationX),
      }),
    [applyX],
  );

  const stepCount = spec.step > 0 ? Math.round((spec.max - spec.min) / spec.step) + 1 : 0;
  const ticks = stepCount >= 2 && stepCount <= MAX_TICKS ? stepCount : 0;

  return (
    <View
      style={[
        styles.wrap,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <Text style={[styles.value, { color: colors.textSecondary }]}>
          {format ? format(snapped) : String(snapped)}
        </Text>
      </View>
      <View
        style={styles.touch}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: spec.min, max: spec.max, now: snapped }}
        {...pan.panHandlers}
      >
        <View style={styles.inner} pointerEvents="none">
          <View
            style={styles.trackArea}
            onLayout={(e) => {
              trackWRef.current = e.nativeEvent.layout.width;
            }}
          >
            <View style={[styles.track, { backgroundColor: colors.border }]} />
            <View
              style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: colors.primary }]}
            />
            {ticks > 0 &&
              Array.from({ length: ticks }, (_, i) => (
                <View
                  key={i}
                  style={[
                    styles.tick,
                    { left: `${(i / (ticks - 1)) * 100}%`, backgroundColor: colors.border },
                  ]}
                />
              ))}
            <View
              style={[
                styles.thumb,
                {
                  left: `${ratio * 100}%`,
                  backgroundColor: colors.primary,
                  borderColor: colors.card,
                },
              ]}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 15,
    fontWeight: '500',
  },
  value: {
    fontSize: 14,
  },
  touch: {
    height: TOUCH_HEIGHT,
    justifyContent: 'center',
  },
  inner: {
    // 轨道左右各留半个滑块，两端圆点不被裁
    marginHorizontal: SLIDER_THUMB / 2,
  },
  trackArea: {
    height: SLIDER_THUMB,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
  },
  tick: {
    position: 'absolute',
    width: 2,
    height: 2,
    marginLeft: -1,
    borderRadius: 1,
    opacity: 0.9,
  },
  thumb: {
    position: 'absolute',
    width: SLIDER_THUMB,
    height: SLIDER_THUMB,
    marginLeft: -SLIDER_THUMB / 2,
    borderRadius: SLIDER_THUMB / 2,
    borderWidth: 2,
  },
});

export default SliderField;
