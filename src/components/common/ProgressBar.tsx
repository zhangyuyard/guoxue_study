/**
 * 通用进度条组件（ProgressBar）
 * 圆角进度条，progress 支持 0-100（越界自动钳制）。
 */
import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

export interface ProgressBarProps {
  /** 进度百分比 0-100 */
  progress: number;
  /** 填充颜色（默认使用主题主色，由调用方传入） */
  color?: string;
  /** 轨道背景色（可选，默认半透明灰） */
  trackColor?: string;
  /** 高度（默认 6） */
  height?: number;
  /** 圆角半径（默认取高度一半） */
  radius?: number;
}

function ProgressBarInner({
  progress,
  color = '#8B5E3C',
  trackColor = 'rgba(120, 120, 120, 0.18)',
  height = 6,
  radius,
}: ProgressBarProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));
  const borderRadius = radius ?? height / 2;

  return (
    <View
      style={[
        styles.track,
        { height, borderRadius, backgroundColor: trackColor },
      ]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
    >
      <View
        style={[
          styles.fill,
          {
            width: `${clamped}%`,
            height,
            borderRadius,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    overflow: 'hidden',
  },
});

/** 进度条（memo 优化：仅 progress/color 变化时重渲染） */
export const ProgressBar = memo(ProgressBarInner);

export default ProgressBar;
