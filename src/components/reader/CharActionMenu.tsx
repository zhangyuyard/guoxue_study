/**
 * 长按动作菜单（CharActionMenu）：长按正文一个字 → 底部弹层三动作。
 *
 * 2026-10-08 新增（用户裁定）。手势语义重排：
 * - **点击一律不再触发任何动作**（滚动模式原先的「点左右 30% 翻屏」与
 *   「点字查字典」两个入口都已取消，见 `ScrollMode.tsx` 文件头 ⑤）；
 * - 长按成为唯一的显式入口，弹出本菜单承载原「点击查字典」与「长按划线」
 *   两个被腾出来的动作，**零功能损失**。
 *
 * 为什么把三个动作收进菜单而不是让长按直进查字典：长按原先 = 新建划线，
 * 直接改成查字典会让「新建划线」失去全部入口（选区 UI 已在 2026-09-22 清理中
 * 整体移除，见 `__tests__/readerFreeSelection.test.ts` 文件头）。
 *
 * 朗读状态自包含于本组件（订阅 speak/finish/error），宿主不感知 TTS —— 与
 * `HighlightActionSheet` 同一范式。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import BottomSheet from '@/components/common/BottomSheet';
import { onSpeechError, onSpeechFinish, speakText, stopSpeech } from '@/services/tts/TtsService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';

export interface CharActionMenuProps {
  visible: boolean;
  onClose: () => void;
  /** 被长按的字（标题展示；空串时不渲染标题字） */
  char: string;
  /** 查字典（宿主导航到查字页） */
  onLookup: () => void;
  /** 划线本段（宿主打开划线面板） */
  onHighlight: () => void;
  /** 本段全文（朗读对象；划线粒度也是整段，二者同粒度） */
  text: string;
}

const MENU_HEIGHT = 260;

function CharActionMenuBase({
  visible,
  onClose,
  char,
  onLookup,
  onHighlight,
  text,
}: CharActionMenuProps): React.JSX.Element {
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

  // 关窗即停朗读（与 HighlightActionSheet 同口径：面板消失后不该还在念）
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

  const itemStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.item,
      { borderBottomColor: colors.border },
      pressed ? { backgroundColor: colors.card } : null,
    ],
    [colors],
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={char ? `「${char}」` : '文字操作'}
      height={MENU_HEIGHT}
    >
      <View style={styles.container}>
        <Pressable accessibilityLabel="查字典" onPress={onLookup} style={itemStyle}>
          <Text style={[styles.itemText, { color: colors.text }]} allowFontScaling={false}>
            查字典
          </Text>
        </Pressable>
        <Pressable accessibilityLabel="划线本段" onPress={onHighlight} style={itemStyle}>
          <Text style={[styles.itemText, { color: colors.text }]} allowFontScaling={false}>
            划线本段
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={speaking ? '停止朗读' : '朗读本段'}
          onPress={handleToggleSpeak}
          style={itemStyle}
        >
          <Text style={[styles.itemText, { color: colors.text }]} allowFontScaling={false}>
            {speaking ? '停止朗读' : '朗读本段'}
          </Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 4 },
  item: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemText: { fontSize: 16, includeFontPadding: false },
});

/** 长按动作菜单 */
export const CharActionMenu = React.memo(CharActionMenuBase);

export default CharActionMenu;
