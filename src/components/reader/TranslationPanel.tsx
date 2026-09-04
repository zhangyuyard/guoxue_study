/**
 * 翻译面板（TranslationPanel）
 * 底部半屏弹层：展示选中文字的在线翻译结果。
 * - 自动方向：源为中文 → 译英文，否则 → 译中文（面板内可手动切换方向重译）
 * - 服务商与 Key 经「我的 → 翻译设置」录入（DeepL / Google / 百度，用户自带 Key）
 * - 未配置 / 网络失败 / 超时给出友好提示
 * 实现说明：与 AnalysisPanel 一致采用 Modal 兜底（bottom-sheet 待 App 壳集成后统一）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { TranslationResult } from '@/types/translation';
import { TranslationService } from '@/services/TranslationService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';

/** 面板内部状态 */
interface PanelState {
  loading: boolean;
  result?: TranslationResult;
  /** 当前翻译方向（'auto' = 首次自动判定） */
  direction: 'zh' | 'en' | 'auto';
  error?: string;
}

const INITIAL_STATE: PanelState = { loading: false, direction: 'auto' };

/** 语种代码 → 展示名 */
function langLabel(code?: string): string {
  if (!code) {
    return '自动检测';
  }
  const map: Record<string, string> = {
    zh: '中文',
    'zh-CN': '中文',
    'zh-TW': '中文',
    en: '英文',
    'EN-US': '英文',
    'EN-GB': '英文',
    ja: '日文',
    ko: '韩文',
    ru: '俄文',
    ar: '阿拉伯文',
  };
  return map[code] ?? code;
}

export interface TranslationPanelProps {
  /** 是否可见 */
  visible: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 待翻译的选中文字 */
  text: string;
}

function TranslationPanel({ visible, onClose, text }: TranslationPanelProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const colors: ThemeColors = getColors(theme);
  const translationSettings = useSettingsStore((s) => s.translation);

  const [state, setState] = useState<PanelState>(INITIAL_STATE);
  /** 请求序号：任何新请求/重置都会递增，晚到的旧响应按序号丢弃（防换词错配） */
  const seqRef = useRef(0);

  /** 执行翻译（direction='auto' 时按源语言智能定向，否则强制方向） */
  const runTranslate = useCallback(
    async (source: string, direction: PanelState['direction']): Promise<void> => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setState({ loading: true, direction });
      const target = direction === 'auto' ? undefined : direction;
      const res = await TranslationService.translateAuto(source, translationSettings, target);
      if (seq !== seqRef.current) {
        return; // 期间已有更新的请求或面板重置，丢弃过期响应
      }
      if (res.success && res.data) {
        setState({ loading: false, result: res.data, direction });
      } else {
        setState({ loading: false, direction, error: res.error ?? '翻译失败' });
      }
    },
    [translationSettings],
  );

  // 打开/切换选词时自动翻译（延迟一帧展示 loading，不阻塞动画）
  useEffect(() => {
    if (!visible || !text.trim()) {
      seqRef.current += 1; // 重置也递增序号，使在飞请求失效
      setState(INITIAL_STATE);
      return;
    }
    const timer = setTimeout(() => {
      void runTranslate(text.trim(), 'auto');
    }, 120);
    return () => clearTimeout(timer);
    // 依赖数组有意收窄（text 派生自 props，闭包取最新值即可），勿机械补全
  }, [visible, text]);

  /** 切换翻译方向并重译 */
  const handleSwitchDirection = (): void => {
    if (state.loading || !text.trim()) {
      return;
    }
    void runTranslate(text.trim(), state.direction === 'en' ? 'zh' : 'en');
  };

  const hasResult = Boolean(state.result);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.panel, { backgroundColor: colors.background }]}
          onPress={() => undefined}
        >
          {/* 顶部：把手 + 标题 + 关闭 */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                文本翻译
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="关闭翻译面板"
              >
                <Text style={[styles.closeButton, { color: colors.textSecondary }]}>关闭</Text>
              </Pressable>
            </View>
          </View>

          {/* 内容区 */}
          {state.loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.hint, { color: colors.textSecondary }]}>正在翻译…</Text>
            </View>
          ) : !hasResult ? (
            <View style={styles.centerBox}>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                {state.error ?? '没有可翻译的内容'}
              </Text>
              {(state.error ?? '').includes('未配置') ? (
                <Text style={[styles.hintSmall, { color: colors.pinyin }]}>
                  请到「我的 → 翻译设置」录入服务商 API Key
                </Text>
              ) : null}
            </View>
          ) : (
            <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
              {/* 原文 */}
              <View style={[styles.sectionBox, { borderColor: colors.border }]}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                  原文（{langLabel(state.result?.sourceLang)}）
                </Text>
                <Text style={[styles.sectionText, { color: colors.text }]}>
                  {text.trim()}
                </Text>
              </View>

              {/* 译文 */}
              <View style={[styles.sectionBox, { borderColor: colors.primary }]}>
                <Text style={[styles.sectionLabel, { color: colors.primary }]}>
                  译文（{langLabel(state.result?.targetLang)}）
                </Text>
                <Text style={[styles.sectionText, { color: colors.text }]} selectable>
                  {state.result?.text}
                </Text>
              </View>

              {/* 来源与方向切换 */}
              <View style={styles.footerRow}>
                <Text style={[styles.footerText, { color: colors.pinyin }]}>
                  {`由 ${
                    state.result?.provider === 'deepl'
                      ? 'DeepL'
                      : state.result?.provider === 'google'
                        ? 'Google'
                        : state.result?.provider === 'baidu'
                          ? '百度翻译'
                          : '离线（设备内置）'
                  } 提供 · 机器翻译仅供参考`}
                </Text>
                <Pressable
                  onPress={handleSwitchDirection}
                  disabled={state.loading}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="切换翻译方向"
                >
                  <Text style={[styles.switchText, { color: colors.primary }]}>
                    {state.direction === 'en' ? '⇄ 译成中文' : '⇄ 译成英文'}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  panel: {
    maxHeight: '70%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  closeButton: {
    fontSize: 14,
    paddingVertical: 2,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 10,
  },
  hint: {
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  hintSmall: {
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  content: {
    paddingHorizontal: 16,
  },
  contentInner: {
    paddingBottom: 16,
    gap: 12,
  },
  sectionBox: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 6,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionText: {
    fontSize: 15,
    lineHeight: 22,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  footerText: {
    fontSize: 11,
    flexShrink: 1,
  },
  switchText: {
    fontSize: 13,
    fontWeight: '600',
  },
});

export default TranslationPanel;
