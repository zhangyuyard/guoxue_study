/**
 * ReviewReminderService 单测（B4）：
 *   - nextReminderTimestamp 纯函数（今天未到 → 今天；已过/恰等于 → 明天；秒归零）
 *   - requestReminderPermission（授权 / 拒绝 / 异常）
 *   - syncReminder（关闭或 0 到期 → 取消；开启且有到期 → 注册每日重复通知）
 *   - syncReminderFromStores（store 驱动的端到端口径）
 * notifee 用 jest.mock 桩（node 环境，无原生模块）。
 */
import notifee, { AuthorizationStatus, RepeatFrequency, TriggerType } from '@notifee/react-native';
import {
  nextReminderTimestamp,
  requestReminderPermission,
  syncReminder,
  syncReminderFromStores,
  REMINDER_CHANNEL_ID,
  REMINDER_NOTIFICATION_ID,
} from '@/services/ReviewReminderService';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useRecitationStore } from '@/store/useRecitationStore';
import type { RecitationProgress } from '@/types';

const mockRequestPermission = notifee.requestPermission as jest.Mock;
const mockCreateChannel = notifee.createChannel as jest.Mock;
const mockCreateTrigger = notifee.createTriggerNotification as jest.Mock;
const mockCancel = notifee.cancelNotification as jest.Mock;

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    requestPermission: jest.fn(),
    createChannel: jest.fn(),
    createTriggerNotification: jest.fn(),
    cancelNotification: jest.fn(),
  },
  AndroidImportance: { HIGH: 4 },
  AuthorizationStatus: { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 },
  RepeatFrequency: { DAILY: 0, WEEKLY: 1 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
}));

/** 构造一条背诵进度记录 */
function makeProgress(overrides: Partial<RecitationProgress> = {}): RecitationProgress {
  return {
    id: 'book1:ch1:fillBlank',
    bookId: 'book1',
    chapterId: 'ch1',
    mode: 'fillBlank',
    status: 'mastered',
    progress: 100,
    ...overrides,
  };
}

/** 将 store 重置为「提醒关闭 19:00 + 无进度 + 每日目标默认值」基线 */
function resetStores() {
  useSettingsStore.setState({
    reminderEnabled: false,
    reminderHour: 19,
    reminderMinute: 0,
    dailyGoalEnabled: true,
    dailyGoalCount: 5,
  });
  useRecitationStore.setState({ list: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestPermission.mockResolvedValue({ authorizationStatus: AuthorizationStatus.AUTHORIZED });
  mockCreateChannel.mockResolvedValue(undefined);
  mockCreateTrigger.mockResolvedValue(REMINDER_NOTIFICATION_ID);
  mockCancel.mockResolvedValue(undefined);
  resetStores();
});

describe('nextReminderTimestamp（纯函数）', () => {
  test('今天提醒时刻未到 → 返回今天该时刻（秒/毫秒归零）', () => {
    const now = new Date('2026-03-15T10:00:00.000');
    const ts = nextReminderTimestamp(now, 19, 0);
    expect(new Date(ts)).toEqual(new Date('2026-03-15T19:00:00.000'));
  });

  test('今天提醒时刻已过 → 返回明天该时刻', () => {
    const now = new Date('2026-03-15T20:30:00.000');
    const ts = nextReminderTimestamp(now, 19, 0);
    expect(new Date(ts)).toEqual(new Date('2026-03-16T19:00:00.000'));
  });

  test('恰好等于提醒时刻 → 视为已过，返回明天（同秒不重复提醒）', () => {
    const now = new Date('2026-03-15T19:00:00.000');
    const ts = nextReminderTimestamp(now, 19, 0);
    expect(new Date(ts)).toEqual(new Date('2026-03-16T19:00:00.000'));
  });

  test('now 带秒/毫秒时目标时刻归零（18:59:59.999 → 今天 19:00:00.000）', () => {
    const now = new Date('2026-03-15T18:59:59.999');
    const ts = nextReminderTimestamp(now, 19, 30);
    expect(new Date(ts)).toEqual(new Date('2026-03-15T19:30:00.000'));
  });

  test('跨月边界正常（3 月 31 日晚于提醒时刻 → 4 月 1 日）', () => {
    const now = new Date('2026-03-31T23:00:00.000');
    const ts = nextReminderTimestamp(now, 8, 0);
    expect(new Date(ts)).toEqual(new Date('2026-04-01T08:00:00.000'));
  });
});

describe('requestReminderPermission', () => {
  test('授权（AUTHORIZED）→ true', async () => {
    mockRequestPermission.mockResolvedValueOnce({
      authorizationStatus: AuthorizationStatus.AUTHORIZED,
    });
    await expect(requestReminderPermission()).resolves.toBe(true);
  });

  test('临时授权（PROVISIONAL）→ true', async () => {
    mockRequestPermission.mockResolvedValueOnce({
      authorizationStatus: AuthorizationStatus.PROVISIONAL,
    });
    await expect(requestReminderPermission()).resolves.toBe(true);
  });

  test('拒绝（DENIED）→ false', async () => {
    mockRequestPermission.mockResolvedValueOnce({
      authorizationStatus: AuthorizationStatus.DENIED,
    });
    await expect(requestReminderPermission()).resolves.toBe(false);
  });

  test('原生模块异常 → false（不向上抛）', async () => {
    mockRequestPermission.mockRejectedValueOnce(new Error('bridge error'));
    await expect(requestReminderPermission()).resolves.toBe(false);
  });
});

describe('syncReminder', () => {
  const enabled = { reminderEnabled: true, reminderHour: 19, reminderMinute: 0 };
  const disabled = { reminderEnabled: false, reminderHour: 19, reminderMinute: 0 };

  test('开关关闭 → 取消通知，不排程', async () => {
    await syncReminder(disabled, 5);
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('开启但到期数为 0 → 取消通知（避免空提醒）', async () => {
    await syncReminder(enabled, 0);
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('开启且到期数 > 0 → 建 channel 并注册每日重复通知（正文含到期篇数）', async () => {
    await syncReminder(enabled, 3);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: REMINDER_CHANNEL_ID }),
    );
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    const [notif, trigger] = mockCreateTrigger.mock.calls[0];
    expect(notif.id).toBe(REMINDER_NOTIFICATION_ID);
    expect(notif.body).toContain('3');
    expect(trigger.type).toBe(TriggerType.TIMESTAMP);
    expect(trigger.repeatFrequency).toBe(RepeatFrequency.DAILY);
  });

  test('排程时刻等于下一次 hour:minute（今天或明天，秒归零）', async () => {
    await syncReminder(enabled, 1);
    const [, trigger] = mockCreateTrigger.mock.calls[0];
    const scheduled = new Date(trigger.timestamp as number);
    expect(scheduled.getSeconds()).toBe(0);
    expect(scheduled.getMinutes()).toBe(0);
    expect(scheduled.getHours()).toBe(19);
    // 时刻只能是今天 19:00 或明天 19:00
    const today = new Date();
    today.setHours(19, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ok =
      scheduled.getTime() === today.getTime() || scheduled.getTime() === tomorrow.getTime();
    expect(ok).toBe(true);
  });

  test('自定义提醒时刻生效（08:30）', async () => {
    await syncReminder({ ...enabled, reminderHour: 8, reminderMinute: 30 }, 1);
    const [, trigger] = mockCreateTrigger.mock.calls[0];
    const scheduled = new Date(trigger.timestamp as number);
    expect(scheduled.getHours()).toBe(8);
    expect(scheduled.getMinutes()).toBe(30);
  });

  test('notifee 异常被吞掉（不向上抛）', async () => {
    mockCreateTrigger.mockRejectedValueOnce(new Error('scheduler error'));
    await expect(syncReminder(enabled, 2)).resolves.toBeUndefined();
  });
});

describe('syncReminderFromStores（store 端到端）', () => {
  test('设置开启 + 存在到期项 → 排程每日提醒', async () => {
    useSettingsStore.setState({ reminderEnabled: true, reminderHour: 19, reminderMinute: 0 });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    useRecitationStore.setState({
      list: [makeProgress({ nextDueAt: past, completedAt: past, reviewLevel: 1 })],
    });
    await syncReminderFromStores();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  test('设置开启但无到期项 → 取消通知', async () => {
    // P1-09 后：目标提醒有自己的触发条件，此处显式关掉目标以验证「纯复习口径」取消行为
    useSettingsStore.setState({ reminderEnabled: true, dailyGoalEnabled: false });
    useRecitationStore.setState({ list: [] });
    await syncReminderFromStores();
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('设置关闭 → 取消通知（即便有到期项）', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    useRecitationStore.setState({
      list: [makeProgress({ nextDueAt: past, completedAt: past })],
    });
    await syncReminderFromStores();
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });
});

describe('syncReminderFromStores 每日目标提醒（P1-09）', () => {
  /** 今日已完成 1 段且不产生到期项的进度记录（nextDueAt 在未来） */
  function makeTodayProgress(count: number): RecitationProgress[] {
    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    return Array.from({ length: count }, (_, i) =>
      makeProgress({
        id: `book1:ch${i + 1}:fillBlank`,
        chapterId: `ch${i + 1}`,
        completedAt: nowIso,
        nextDueAt: futureIso,
      }),
    );
  }

  test('dueCount=0 + 目标开启 + 未达成 → 注册单次目标提醒（正文含差额）', async () => {
    useSettingsStore.setState({ reminderEnabled: true, dailyGoalEnabled: true, dailyGoalCount: 5 });
    useRecitationStore.setState({ list: makeTodayProgress(1) });
    await syncReminderFromStores();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    const [notif, trigger] = mockCreateTrigger.mock.calls[0];
    expect(notif.id).toBe(REMINDER_NOTIFICATION_ID);
    expect(notif.title).toBe('今日背诵目标');
    expect(notif.body).toContain('还差 4 段');
    // 目标提醒为单次：不设 repeatFrequency（次日状态由下次打开 App 的 sync 决定）
    expect(trigger.repeatFrequency).toBeUndefined();
  });

  test('dueCount=0 + 目标已达成（恰好等于）→ 取消通知', async () => {
    useSettingsStore.setState({ reminderEnabled: true, dailyGoalEnabled: true, dailyGoalCount: 2 });
    useRecitationStore.setState({ list: makeTodayProgress(2) });
    await syncReminderFromStores();
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('dueCount=0 + 目标关闭 → 取消通知', async () => {
    useSettingsStore.setState({
      reminderEnabled: true,
      dailyGoalEnabled: false,
      dailyGoalCount: 5,
    });
    useRecitationStore.setState({ list: makeTodayProgress(1) });
    await syncReminderFromStores();
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('提醒主开关关闭 + 目标未达成 → 取消（目标提醒复用主开关，不越权打扰）', async () => {
    useSettingsStore.setState({ reminderEnabled: false, dailyGoalEnabled: true, dailyGoalCount: 5 });
    useRecitationStore.setState({ list: makeTodayProgress(1) });
    await syncReminderFromStores();
    expect(mockCancel).toHaveBeenCalledWith(REMINDER_NOTIFICATION_ID);
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });

  test('有到期项时复习提醒优先（即使目标未达成，正文仍为复习文案）', async () => {
    useSettingsStore.setState({ reminderEnabled: true, dailyGoalEnabled: true, dailyGoalCount: 5 });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    useRecitationStore.setState({
      list: [
        // 1 条到期（触发复习提醒）+ 1 条今日完成（计入目标进度）
        makeProgress({ id: 'b:c1', chapterId: 'c1', nextDueAt: past, completedAt: past, reviewLevel: 1 }),
        ...makeTodayProgress(1).map((p, i) => ({ ...p, id: `b:c${i + 10}`, chapterId: `c${i + 10}` })),
      ],
    });
    await syncReminderFromStores();
    expect(mockCreateTrigger).toHaveBeenCalledTimes(1);
    const [notif] = mockCreateTrigger.mock.calls[0];
    expect(notif.title).toBe('今日复习提醒');
    expect(notif.body).toContain('到期复习');
  });
});
