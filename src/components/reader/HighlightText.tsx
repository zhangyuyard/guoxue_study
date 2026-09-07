/**
 * 划线高亮文本渲染组件（HighlightText）
 * 按 highlights 的偏移量将文本分段渲染：命中段叠加半透明颜色背景，
 * 支持点击高亮片段、长按任意片段（供上层扩展选词/解析）。
 * 自由选区扩展：提供 onPressChar 时文本按「逐字 Text 节点」渲染，
 * 每个字符可独立点按并上报自己的码点索引（选区扩展期间优先于划线点击）。
 * 使用 React.memo 优化，分段结果经 useMemo 缓存。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import type { Highlight } from '@/types';

import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, highlightColors, type ThemeColors } from '@/theme';
import { getLineHeightPx } from '@/theme/typography';
import { buildHighlightedSegments, type HighlightedSegment } from '@/utils/highlight';

export interface HighlightTextProps {
  /** 段落原文 */
  text: string;
  /** 本段划线列表 */
  highlights: Highlight[];
  /** 点击高亮片段回调 */
  onPressHighlight?: (h: Highlight) => void;
  /** 长按片段回调（含未高亮片段，用于上层扩展选词） */
  onLongPressSegment?: (segment: HighlightedSegment) => void;
  /**
   * 点按单字回调（参数为该字在 text 中的码点索引，供自由选区扩展）。
   * 提供时逐字渲染（每字独立 Text 节点），并优先于划线点击生效。
   */
  onPressChar?: (index: number) => void;
  /** 正文字号 */
  fontSize: number;
  /** 行距倍数 */
  lineHeight: number;
}

function HighlightTextBase({
  text,
  highlights,
  onPressHighlight,
  onLongPressSegment,
  onPressChar,
  fontSize,
  lineHeight,
}: HighlightTextProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors: ThemeColors = getColors(theme);

  const segments = useMemo(
    () => buildHighlightedSegments(text, highlights),
    [text, highlights],
  );

  const baseStyle: TextStyle = useMemo(
    () => ({
      fontSize,
      lineHeight: getLineHeightPx(fontSize, lineHeight),
      color: colors.text,
    }),
    [fontSize, lineHeight, colors],
  );

  if (onPressChar) {
    // 自由选区扩展模式：逐字渲染，每字可独立点按上报码点索引；
    // 长按仍按片段粒度回调（与选区起点创建语义一致）。
    return (
      <Text style={[styles.text, baseStyle]}>
        {segments.map((seg) => {
          const chars = Array.from(seg.text);
          const segStyle = seg.highlight
            ? [
                styles.span,
                { backgroundColor: highlightColors[seg.highlight.color] },
                seg.highlight.noteId ? styles.noted : null,
              ]
            : null;
          return chars.map((ch, i) => {
            const globalIndex = seg.start + i;
            return (
              <Text
                key={`c${globalIndex}`}
                style={segStyle ?? undefined}
                onPress={() => onPressChar(globalIndex)}
                onLongPress={
                  onLongPressSegment ? () => onLongPressSegment(seg) : undefined
                }
              >
                {ch}
              </Text>
            );
          });
        })}
      </Text>
    );
  }

  return (
    <Text style={[styles.text, baseStyle]}>
      {segments.map((seg) => {
        const highlight = seg.highlight;
        if (highlight) {
          return (
            <Text
              key={`h${seg.start}`}
              style={[
                styles.span,
                { backgroundColor: highlightColors[highlight.color] },
                highlight.noteId ? styles.noted : null,
              ]}
              onPress={onPressHighlight ? () => onPressHighlight(highlight) : undefined}
              onLongPress={onLongPressSegment ? () => onLongPressSegment(seg) : undefined}
            >
              {seg.text}
            </Text>
          );
        }
        return (
          <Text
            key={`p${seg.start}`}
            onLongPress={onLongPressSegment ? () => onLongPressSegment(seg) : undefined}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    flex: 1,
  },
  span: {
    borderRadius: 2,
  },
  /** 已关联笔记的划线加下划线提示 */
  noted: {
    textDecorationLine: 'underline',
  },
});

const HighlightText = React.memo(HighlightTextBase);
export default HighlightText;
