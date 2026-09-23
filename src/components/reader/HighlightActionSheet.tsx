/**
 * 划线操作面板（R2d-1/2）：底部弹层，两态复用同一组件。
 *
 * create 态（长按正文触发）：段全文预览 + 三色划线选择 + 朗读本段；
 * view 态（点按已有划线触发）：划线文本预览 + 颜色标识 + 朗读 + 删除。
 *
 * 口径注：MVP 划线粒度 = 整段（startOffset=0 / endOffset=段码点长），
 * 精确选区（selectionRange 点按扩展）为后续迭代——长按 index 参数已预留。
 * 朗读状态自包含于本组件（speak/stop/finish 订阅），ReaderScreen 不感知 TTS。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import BottomSheet from '@/components/common/BottomSheet';
import { speakText, stopSpeech, onSpeechFinish, onSpeechError } from '@/services/tts/TtsService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';
import type { Highlight, HighlightColor } from '@/types';

export interface HighlightActionSheetProps {
  visible: boolean;
  onClose: () => void;
  mode: 'create' | 'view';
  /** create：长按所在段全文；view：划线文本 */
  text: string;
  /** view 态必传：被查看的划线 */
  highlight?: Highlight;
  /** create：选定颜色提交划线 */
  onCreate: (color: HighlightColor) => void;
  /** view：删除该划线 */
  onDelete: (id: string) => void;
}

/** 三色选择按钮展示色（划线上屏用半透明 highlightColors，按钮需不透明可辨） */
const SWATCH_COLORS: Record<HighlightColor, string> = {
  yellow: '#FFD54F',
  green: '#81C784',
  blue: '#64B5F6',
};

const SWATCH_ORDER: HighlightColor[] = ['yellow', 'green', 'blue'];

const SWATCH_LABELS: Record<HighlightColor, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
};

function HighlightActionSheetBase({
  visible,
  onClose,
  mode,
  text,
  highlight,
  onCreate,
  onDelete,
}: HighlightActionSheetProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors: ThemeColors = getColors(theme);
  const [speaking, setSpeaking] = useState(false);

  // 朗读完成/出错 → 按钮复位（onSpeechFinish 返回 {remove} 句柄，卸载时退订）
  useEffect(() => {
    const finishSub = onSpeechFinish(() => setSpeaking(false));
    const errorSub = onSpeechError(() => setSpeaking(false));
    return () => {
      finishSub.remove();
      errorSub.remove();
    };
  }, []);

  // 面板关闭时停朗读，避免后台继续读（QueueFlush 语义下新朗读会顶掉旧朗读，
  // 但「关面板即停」是更符合直觉的行为）
  useEffect(() => {
    if (!visible && speaking) {
      stopSpeech();
      setSpeaking(false);
    }
  }, [visible, speaking]);

  const handleToggleSpeak = useCallback(() => {
    if (speaking) {
      stopSpeech();
      setSpeaking(false);
      return;
    }
    void speakText(text, 1.0).then((r) => {
      if (r.success) {
        setSpeaking(true);
      }
    });
  }, [speaking, text]);

  const title = mode === 'create' ? '划线本段' : '划线';

  const swatchRow = useMemo(
    () =>
      SWATCH_ORDER.map((color) => (
        <Pressable
          key={color}
          accessibilityLabel={`划线颜色-${SWATCH_LABELS[color]}`}
          onPress={() => onCreate(color)}
          style={({ pressed }) => [
            sheetStyles.swatchWrap,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <View style={[sheetStyles.swatch, { backgroundColor: SWATCH_COLORS[color] }]} />
          <Text style={[sheetStyles.swatchLabel, { color: colors.text }]} allowFontScaling={false}>
            {SWATCH_LABELS[color]}
          </Text>
        </Pressable>
      )),
    [colors.text, onCreate],
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} height={300}>
      <View style={sheetStyles.container}>
        <Text
          style={[sheetStyles.preview, { color: colors.textSecondary }]}
          numberOfLines={4}
          allowFontScaling={false}
        >
          {text}
        </Text>

        {mode === 'create' ? (
          <View style={sheetStyles.actionRow}>
            {swatchRow}
          </View>
        ) : (
          <View
            style={[sheetStyles.colorBar, { backgroundColor: highlight ? SWATCH_COLORS[highlight.color] : colors.border }]}
          />
        )}

        <View style={sheetStyles.buttonRow}>
          <Pressable
            accessibilityLabel={speaking ? '停止朗读' : '朗读'}
            onPress={handleToggleSpeak}
            style={({ pressed }) => [
              sheetStyles.button,
              { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[sheetStyles.buttonText, { color: colors.primary }]} allowFontScaling={false}>
              {speaking ? '停止' : '朗读'}
            </Text>
          </Pressable>
          {mode === 'view' && highlight ? (
            <Pressable
              accessibilityLabel="删除划线"
              onPress={() => onDelete(highlight.id)}
              style={({ pressed }) => [
                sheetStyles.button,
                { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[sheetStyles.buttonText, { color: '#E57373' }]} allowFontScaling={false}>
                删除
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </BottomSheet>
  );
}


const sheetStyles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 4,
    gap: 16,
  },
  preview: {
    fontSize: 14,
    lineHeight: 22,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  swatchWrap: {
    alignItems: 'center',
    gap: 6,
    padding: 8,
  },
  swatch: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  swatchLabel: {
    fontSize: 12,
  },
  colorBar: {
    height: 4,
    borderRadius: 2,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});

/** 划线操作面板 */
export const HighlightActionSheet = React.memo(HighlightActionSheetBase);

export default HighlightActionSheet;
