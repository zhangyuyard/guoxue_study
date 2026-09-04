/**
 * useSettingsStore.readerMode 单测：默认值与切换 action。
 */
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_TRANSLATION_SETTINGS } from '@/types/translation';

describe('useSettingsStore.readerMode', () => {
  test('默认翻页方式为滚动', () => {
    // 重置到默认
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().readerMode).toBe('scroll');
  });

  test('setReaderMode 可在 滚动 / 仿真翻页 间切换', () => {
    useSettingsStore.getState().setReaderMode('page');
    expect(useSettingsStore.getState().readerMode).toBe('page');
    useSettingsStore.getState().setReaderMode('scroll');
    expect(useSettingsStore.getState().readerMode).toBe('scroll');
  });
});

describe('useSettingsStore.translation reset', () => {
  test('设置 translation 后 reset 应恢复默认翻译配置', () => {
    useSettingsStore.getState().setTranslation({
      provider: 'baidu',
      baiduAppId: '202609030001',
      baiduSecretKey: 'secret-key',
    });
    expect(useSettingsStore.getState().translation.provider).toBe('baidu');

    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().translation).toEqual(DEFAULT_TRANSLATION_SETTINGS);
    expect(useSettingsStore.getState().translation.provider).toBe('deepl');
    expect(useSettingsStore.getState().translation.baiduAppId).toBe('');
  });
});

describe('useSettingsStore.translation preferOffline', () => {
  test('preferOffline 默认 false；setTranslation 可开启并随 reset 恢复（经 persist 写入存储）', () => {
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().translation.preferOffline).toBe(false);

    useSettingsStore.getState().setTranslation({ preferOffline: true });
    expect(useSettingsStore.getState().translation.preferOffline).toBe(true);

    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().translation.preferOffline).toBe(false);
  });
});


describe('useSettingsStore.recitation reminder（B4）', () => {
  test('默认：关闭、时刻 19:00', () => {
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().reminderEnabled).toBe(false);
    expect(useSettingsStore.getState().reminderHour).toBe(19);
    expect(useSettingsStore.getState().reminderMinute).toBe(0);
  });

  test('setRecitationReminder 部分合并，未传字段保持不变', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setRecitationReminder({ reminderEnabled: true });
    expect(useSettingsStore.getState().reminderEnabled).toBe(true);
    expect(useSettingsStore.getState().reminderHour).toBe(19);
    useSettingsStore.getState().setRecitationReminder({ reminderHour: 8, reminderMinute: 30 });
    expect(useSettingsStore.getState().reminderEnabled).toBe(true);
    expect(useSettingsStore.getState().reminderHour).toBe(8);
    expect(useSettingsStore.getState().reminderMinute).toBe(30);
  });

  test('reset 恢复默认提醒设置', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setRecitationReminder({
      reminderEnabled: true,
      reminderHour: 7,
      reminderMinute: 45,
    });
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().reminderEnabled).toBe(false);
    expect(useSettingsStore.getState().reminderHour).toBe(19);
    expect(useSettingsStore.getState().reminderMinute).toBe(0);
  });
});

describe('useSettingsStore.dailyGoal（P1-09）', () => {
  test('默认：开关开启、目标 5 段', () => {
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().dailyGoalEnabled).toBe(true);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(5);
  });

  test('setDailyGoalEnabled 可切换开关', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setDailyGoalEnabled(false);
    expect(useSettingsStore.getState().dailyGoalEnabled).toBe(false);
    useSettingsStore.getState().setDailyGoalEnabled(true);
    expect(useSettingsStore.getState().dailyGoalEnabled).toBe(true);
  });

  test('setDailyGoalCount 正常赋值', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setDailyGoalCount(8);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(8);
  });

  test('setDailyGoalCount clamp 到 1–99（下界 / 上界 / 远超上界）', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setDailyGoalCount(0);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(1);
    useSettingsStore.getState().setDailyGoalCount(100);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(99);
    useSettingsStore.getState().setDailyGoalCount(9999);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(99);
    useSettingsStore.getState().setDailyGoalCount(-5);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(1);
  });

  test('reset 恢复默认每日目标设置', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setDailyGoalEnabled(false);
    useSettingsStore.getState().setDailyGoalCount(20);
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().dailyGoalEnabled).toBe(true);
    expect(useSettingsStore.getState().dailyGoalCount).toBe(5);
  });
});
