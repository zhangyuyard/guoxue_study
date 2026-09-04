/**
 * 背诵复习到期本地提醒服务（B4，ReviewReminderService）
 * 基于 @notifee/react-native（旧架构 Bridge 兼容、维护活跃；iOS 需 pod install 后真机验证）。
 *
 * 排程策略（v2，含 P1-09 每日目标联动）：
 *   每日重复通知在排程时无法预知未来某天是否真的有到期项，故采用
 *   「开启即每日提醒、打开 App 时按实际到期数同步/取消」：
 *   - reminderEnabled 且 dueCount > 0 → 注册每日重复通知（id 固定，重复创建即覆盖）；
 *   - reminderEnabled 关闭 或 dueCount = 0 → 取消该通知。
 *   P1-09 目标兜底提醒：dueCount = 0 且提醒主开关开启、dailyGoalEnabled 开启、
 *   今日目标未达成时，在提醒时刻注册**单次**目标提醒（不重复）：
 *   单次而非每日重复，因为目标达成与否每天变化，依赖「打开 App 重新 sync」
 *   覆盖/取消；次日状态由下次打开 App 时的 sync 决定，不会残留过时目标提醒。
 *   目标提醒复用提醒主开关（reminderEnabled=false 表示用户明确不要任何通知，
 *   目标提醒同样静默）；dueCount > 0 时复习提醒优先，不发目标提醒。
 *
 * 每日重复实现取舍：
 *   Android 用 notifee 的 TriggerType.TIMESTAMP + repeatFrequency=DAILY
 *   （官方支持的每日重复最简可靠方式；底层走 AlarmManager，Android 12+ 未授予
 *   SCHEDULE_EXACT_ALARM 时自动降级 inexact，不崩溃）。repeatFrequency 为
 *   Android-only：iOS 的 UNNotificationTrigger 不支持 timestamp 重复，因此 iOS
 *   实际只触发一次下次时刻的单次通知，依靠「每次打开 App 触发 syncReminder 重新排程」
 *   形成事实上的每日提醒（下次打开 App 时会以新的 timestamp 覆盖旧通知）。
 *   iOS 行为需 pod install 后真机验证。
 *
 * 依赖方向：本文件 import 两个 store 与 ReviewScheduler（纯函数），
 * store 与 ReviewScheduler 均不反向依赖本文件，无环。
 */
import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  RepeatFrequency,
  TriggerType,
  type TimestampTrigger,
} from '@notifee/react-native';
import { buildReviewItems } from '@/services/ReviewScheduler';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { dailyGoalProgress } from '@/utils/dailyGoal';

/** 通知 channel id（Android 通知渠道） */
export const REMINDER_CHANNEL_ID = 'recitation-reminder';
/** 通知 id（固定 id：重复创建即覆盖，取消即关闭） */
export const REMINDER_NOTIFICATION_ID = 'recitation-review-daily';

/** 提醒设置输入（来自 useSettingsStore 的提醒字段 + P1-09 每日目标进度） */
export interface ReminderSettingsInput {
  reminderEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
  /** 每日目标开关（P1-09）；缺省视为关闭，兼容旧调用方 */
  dailyGoalEnabled?: boolean;
  /** 每日目标量（段）；缺省或 <=0 时不发目标提醒 */
  dailyGoalCount?: number;
  /** 今日已完成段数；缺省视为未知，不发目标提醒（宁可不提醒，不误提醒） */
  dailyGoalCompleted?: number;
}

/**
 * 计算下次提醒时刻（纯函数）：
 * 今天 hour:minute 尚未到达（> now）→ 今天该时刻；否则（已过或恰好等于 now）→ 明天该时刻。
 * 秒/毫秒归零，返回 epoch 毫秒。
 */
export function nextReminderTimestamp(now: Date, hour: number, minute: number): number {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/**
 * 请求通知权限（开启提醒开关时调用）。
 * Android 13+ 映射 POST_NOTIFICATIONS 运行时权限；iOS 请求 alert + sound。
 * 授权（含 provisional 临时授权）返回 true；拒绝或异常返回 false（UI 层据此回写
 * reminderEnabled=false 并提示用户去系统设置开启）。
 */
export async function requestReminderPermission(): Promise<boolean> {
  try {
    const settings = await notifee.requestPermission({
      alert: true,
      sound: true,
    });
    return (
      settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  } catch {
    return false;
  }
}

/**
 * 按设置与到期数同步提醒通知（幂等）：
 * - 关闭 或（dueCount <= 0 且无目标提醒条件）→ 取消固定 id 通知；
 * - 开启 且 dueCount > 0 → 确保 channel 存在并注册/覆盖每日重复通知（正文含到期篇数）；
 * - 开启 且 dueCount = 0 且目标开启且今日未达成 → 注册单次目标提醒（见文件头策略说明）。
 * 任何异常吞掉（通知失败不阻断主流程）。
 */
export async function syncReminder(
  settings: ReminderSettingsInput,
  dueCount: number,
): Promise<void> {
  try {
    // 目标兜底提醒条件（P1-09）：主开关开启 + 目标开启 + 有效目标 + 今日进度已知且未达成
    const goalRemaining =
      settings.reminderEnabled &&
      settings.dailyGoalEnabled === true &&
      settings.dailyGoalCount !== undefined &&
      settings.dailyGoalCount > 0 &&
      settings.dailyGoalCompleted !== undefined
        ? Math.max(0, settings.dailyGoalCount - settings.dailyGoalCompleted)
        : 0;

    if (!settings.reminderEnabled || (dueCount <= 0 && goalRemaining <= 0)) {
      await notifee.cancelNotification(REMINDER_NOTIFICATION_ID);
      return;
    }
    // Android 通知渠道（幂等：同 id 重复创建为无操作/更新；iOS 自动忽略）
    await notifee.createChannel({
      id: REMINDER_CHANNEL_ID,
      name: '背诵复习提醒',
      importance: AndroidImportance.HIGH,
    });
    const timestamp = nextReminderTimestamp(
      new Date(),
      settings.reminderHour,
      settings.reminderMinute,
    );
    // 复习提醒 → 每日重复；目标提醒 → 单次（次日状态由下次打开 App 的 sync 决定）
    const trigger: TimestampTrigger = {
      type: TriggerType.TIMESTAMP,
      timestamp,
      repeatFrequency: dueCount > 0 ? RepeatFrequency.DAILY : undefined,
    };
    await notifee.createTriggerNotification(
      {
        id: REMINDER_NOTIFICATION_ID,
        title: dueCount > 0 ? '今日复习提醒' : '今日背诵目标',
        body:
          dueCount > 0
            ? `有 ${dueCount} 篇背诵内容到期复习，趁热打铁，打开 App 开始今日复习吧！`
            : `今日背诵目标还差 ${goalRemaining} 段，继续加油！`,
        android: {
          channelId: REMINDER_CHANNEL_ID,
          smallIcon: 'ic_launcher',
          pressAction: { id: 'default' },
        },
      },
      trigger,
    );
  } catch {
    // 静默降级：提醒属增值功能，失败不影响核心背诵流程
  }
}

/** 防重入标记（App 启动与页面 effect 可能并发触发） */
let syncing = false;

/**
 * 便捷入口：读取两个 store 的当前状态（到期数由背诵进度实时计算）并 syncReminder。
 * 进行中的同步未完成时直接跳过（防重入）。App 启动与复习完成/设置变更处调用。
 */
export async function syncReminderFromStores(): Promise<void> {
  if (syncing) {
    return;
  }
  syncing = true;
  try {
    const s = useSettingsStore.getState();
    const now = new Date();
    const recitationList = useRecitationStore.getState().list;
    const dueCount = buildReviewItems(recitationList, now).length;
    // P1-09：目标提醒用「今日已完成段数」判断，与 dueCount 同一次列表快照计算
    const goalProgress = dailyGoalProgress(recitationList, now, s.dailyGoalCount);
    await syncReminder(
      {
        reminderEnabled: s.reminderEnabled,
        reminderHour: s.reminderHour,
        reminderMinute: s.reminderMinute,
        dailyGoalEnabled: s.dailyGoalEnabled,
        dailyGoalCount: s.dailyGoalCount,
        dailyGoalCompleted: goalProgress.completed,
      },
      dueCount,
    );
  } finally {
    syncing = false;
  }
}
