/**
 * 行级行渲染器（架构 L3b，docs/reader-architecture-2026-09-22.md §4）。
 *
 * 一行 = 一个 FlatList item，渲染高度**恒等于** `rowHeight`（INV-G1）：
 * - 容器显式 `height` + `overflow:'hidden'`；
 * - 内容复用 `PinyinText` 的 `charRange` 拆页切片（码点全局基准、跨界 run
 *   文本级切开），切片长度 = L1 `charsPerLine`（字距经 `charGapFor` 同源）
 *   ⇒ 注音开为单视觉行字格、注音关为单行文本；
 * - 断行完全由 L1 决定（保守模型：宁可提前折不可超出）⇒ 内容不因渲染裁剪丢失。
 *
 * 行高恒定的前提（§7.2 前置硬约束）由 PinyinText 内部保证：
 * 正文 Text 全部 `allowFontScaling={false}`、拼音槽定高、字格定宽 1em。
 */
import React, { useCallback } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import PinyinText from './PinyinText';
import type { Highlight, PinyinAnnotation, PinyinMode } from '@/types';

export interface LineRowProps {
  /** 整段原文（charRange 的码点基准） */
  text: string;
  /** 本行渲染的码点区间 [start, end)（章内偏移 - 段起点 = 段内偏移，由上层换算） */
  charRange: [number, number];
  /** 行高（L1 geometry.rowHeight，恒定常量） */
  rowHeight: number;
  fontSize: number;
  lineHeight: number;
  /** 全章统一拼音字号（上层按章最长拼音算好传入；缺省逐字自适应） */
  unifiedPinyinFontSize?: number;
  pinyinMode: PinyinMode;
  conversionMode?: 'simplified' | 'traditional';
  /** 外部注入的注音结果（缺省走 PinyinText 内部注音） */
  annotations?: PinyinAnnotation[];
  highlights?: Highlight[];
  /** 当前篇目 ID（语境化通假/读音判定） */
  workId?: string;
  bookId?: string;
  /** 点按汉字回调（段内码点索引，供上层查字/选区扩展）；pageX = 触点横坐标（翻屏分区判据） */
  onPressChar?: (index: number, pageX: number) => void;
  onLongPressChar?: (index: number) => void;
  /** 点按命中划线回调（透传 PinyinText.onPressHighlight，R2d-2 查看面板入口）；pageX 同上 */
  onPressHighlight?: (h: Highlight, pageX: number) => void;
}

/** INV-G1 运行期探针：行高 ≠ rowHeight 时计数（真机验收须恒 0） */
export let geomMismatchCount = 0;

const LineRow = React.memo(function LineRow({
  text,
  charRange,
  rowHeight,
  fontSize,
  lineHeight,
  unifiedPinyinFontSize,
  pinyinMode,
  conversionMode,
  annotations,
  highlights,
  workId,
  bookId,
  onPressChar,
  onPressHighlight,
  onLongPressChar,
}: LineRowProps) {
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      if (Math.round(h) !== rowHeight) {
        geomMismatchCount += 1;
        console.warn(`[GEOM] mismatch height=${h} expect=${rowHeight} range=${charRange[0]}-${charRange[1]}`);
      }
    },
    [rowHeight, charRange],
  );

  return (
    <View onLayout={handleLayout} style={{ height: rowHeight, overflow: 'hidden' }}>
      <PinyinText
        text={text}
        charRange={charRange}
        fontSize={fontSize}
        lineHeight={lineHeight}
        unifiedPinyinFontSize={unifiedPinyinFontSize}
        pinyinMode={pinyinMode}
        conversionMode={conversionMode}
        annotations={annotations}
        highlights={highlights}
        workId={workId}
        bookId={bookId}
        onPressChar={onPressChar}
        onPressHighlight={onPressHighlight}
        onLongPressChar={onLongPressChar}
      />
    </View>
  );
});

export default LineRow;
