/**
 * useSettingsStore.speechRate 单测（P2-02）：
 * 默认值 1.0、setter 更新、reset 恢复默认（zustand persist 约定：
 * 新设置字段给默认值、reset 恢复默认，不手动同步持久化状态）。
 */
import { useSettingsStore } from '@/store/useSettingsStore';

describe('useSettingsStore.speechRate', () => {
  test('默认语速为 1.0', () => {
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().speechRate).toBe(1.0);
  });

  test('setSpeechRate 可更新语速', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setSpeechRate(1.5);
    expect(useSettingsStore.getState().speechRate).toBe(1.5);
    useSettingsStore.getState().setSpeechRate(0.75);
    expect(useSettingsStore.getState().speechRate).toBe(0.75);
  });

  test('reset 恢复默认语速 1.0', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setSpeechRate(2.0);
    expect(useSettingsStore.getState().speechRate).toBe(2.0);
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().speechRate).toBe(1.0);
  });

  test('语速更新不影响其他设置字段（reset 后互不干扰）', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setSpeechRate(1.25);
    expect(useSettingsStore.getState().fontSize).toBe(18);
    expect(useSettingsStore.getState().readerMode).toBe('scroll');
  });
});
