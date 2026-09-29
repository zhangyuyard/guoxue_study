/**
 * useSettingsStore.readerMode 单测：默认值与切换 action。
 */
import {
  DEFAULT_READER_PERF_TIER,
  READER_PERF_TIER_OPTIONS,
  resolveReaderSetting,
  useSettingsStore,
} from '@/store/useSettingsStore';
import { DeviceTierService } from '@/services/DeviceTierService';
import { DEFAULT_TRANSLATION_SETTINGS } from '@/types/translation';

describe('useSettingsStore.readerMode', () => {
  test('默认翻页方式为滚动', () => {
    // 重置到默认
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().readerMode).toBe('scroll');
  });

  test('setReaderMode 可在 滚动 / 翻页 间切换', () => {
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

/**
 * r38 T01 性能档位（G6）：D5 设置页「性能档位」行的 store 行为与持久化。
 * 覆盖：默认 auto / 写入镜像 + 档位真源同步 / 跨会话持久化保持 /
 * 备份恢复（含旧版缺字段与非法值）。
 */
describe('useSettingsStore.readerPerfTier（r38 T01 / G6：档位入口行为与持久化）', () => {
  let setOverrideSpy: jest.SpyInstance;

  beforeEach(() => {
    setOverrideSpy = jest
      .spyOn(DeviceTierService, 'setOverride')
      .mockImplementation(() => undefined);
    useSettingsStore.getState().reset();
  });

  afterEach(() => {
    setOverrideSpy.mockRestore();
    useSettingsStore.getState().reset();
  });

  test('默认 auto；setReaderPerfTier 镜像到 state 并同步档位真源（auto → 清空覆盖）', () => {
    expect(DEFAULT_READER_PERF_TIER).toBe('auto');
    expect(useSettingsStore.getState().readerPerfTier).toBe('auto');
    // 选项与设置页 SegmentedRow 顺序一致：自动 → 低 → 中 → 高
    expect([...READER_PERF_TIER_OPTIONS]).toEqual(['auto', 'low', 'mid', 'high']);

    useSettingsStore.getState().setReaderPerfTier('mid');
    expect(useSettingsStore.getState().readerPerfTier).toBe('mid');
    expect(setOverrideSpy).toHaveBeenLastCalledWith('mid');

    useSettingsStore.getState().setReaderPerfTier('high');
    expect(setOverrideSpy).toHaveBeenLastCalledWith('high');

    // auto = 交还设备自动探测（清空档位覆盖）
    useSettingsStore.getState().setReaderPerfTier('auto');
    expect(useSettingsStore.getState().readerPerfTier).toBe('auto');
    expect(setOverrideSpy).toHaveBeenLastCalledWith(null);
  });

  test('持久化：写盘载荷含档位，冷启动 rehydrate 后仍保持', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MMKV } = require('react-native-mmkv') as {
      MMKV: { prototype: { set: (key: string, value: string) => void } };
    };
    const setSpy = jest.spyOn(MMKV.prototype, 'set');

    useSettingsStore.getState().setReaderPerfTier('low');

    // 落盘载荷（persist name = guoxue-settings）必须含 readerPerfTier
    const writes = setSpy.mock.calls.filter((c) => c[0] === 'guoxue-settings');
    expect(writes.length).toBeGreaterThan(0);
    const payload = JSON.parse(String(writes[writes.length - 1][1])) as {
      state: { readerPerfTier?: string };
    };
    expect(payload.state.readerPerfTier).toBe('low');

    // 重新读取（模拟冷启动 rehydrate）→ 档位不丢
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().readerPerfTier).toBe('low');

    setSpy.mockRestore();
  });

  test('restoreFromBackup：合法档位恢复并同步真源；旧版缺字段 / 非法值 → 保持现值且不崩', () => {
    useSettingsStore.getState().restoreFromBackup({
      readerPerfTier: 'high',
      fontSize: 20,
    });
    expect(useSettingsStore.getState().readerPerfTier).toBe('high');
    expect(useSettingsStore.getState().fontSize).toBe(20);
    expect(setOverrideSpy).toHaveBeenLastCalledWith('high');

    // 旧版备份（该字段为 v1 可选扩展）：缺字段不抛错、保持现值
    useSettingsStore.getState().restoreFromBackup({ fontSize: 22 });
    expect(useSettingsStore.getState().readerPerfTier).toBe('high');
    expect(useSettingsStore.getState().fontSize).toBe(22);

    // 非法档位值 → 校验拦下，保持现值（不被污染）
    useSettingsStore.getState().restoreFromBackup({ readerPerfTier: 'ultra' });
    expect(useSettingsStore.getState().readerPerfTier).toBe('high');

    // reset 一并恢复自动并清空档位覆盖
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().readerPerfTier).toBe('auto');
    expect(setOverrideSpy).toHaveBeenLastCalledWith(null);
  });
});

describe('useSettingsStore.pageMargin 书籍级覆盖（PER_BOOK_SETTING_KEYS）', () => {
  test('pageMargin 在白名单内，setPerBookSettings 可写入书籍层覆盖', () => {
    useSettingsStore.getState().reset();
    const bookId = 'book-xyz';

    // 全局默认 20；书籍层写入 48 后 resolveReaderSetting 应返回 48
    expect(useSettingsStore.getState().pageMargin).toBe(20);
    useSettingsStore.getState().setPerBookSettings(bookId, { pageMargin: 48 });
    expect(
      resolveReaderSetting(useSettingsStore.getState(), 'pageMargin', bookId),
    ).toBe(48);
    // 其他书仍跟随全局
    expect(
      resolveReaderSetting(useSettingsStore.getState(), 'pageMargin', 'other-book'),
    ).toBe(20);
  });

  test('书籍层缺 pageMargin 覆盖时回落全局层', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().setPageMargin(32);
    expect(
      resolveReaderSetting(useSettingsStore.getState(), 'pageMargin', 'no-override-book'),
    ).toBe(32);
  });

  test('备份恢复：per-book 条目里的 pageMargin 数值被保留，非数值被丢弃', () => {
    useSettingsStore.getState().reset();
    useSettingsStore.getState().restoreFromBackup({
      perBookSettings: {
        b1: { pageMargin: 48, fontSize: 18 },
        b2: { pageMargin: 'bad' },
      } as unknown as Record<string, unknown>,
    });
    const per = useSettingsStore.getState().perBookSettings;
    expect(per.b1?.pageMargin).toBe(48);
    expect(per.b1?.fontSize).toBe(18);
    // 非法 pageMargin（字符串）被 sanitize 丢弃，b2 为空覆盖
    expect(per.b2?.pageMargin).toBeUndefined();
  });
});
