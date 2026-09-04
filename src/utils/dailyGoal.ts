/**
 * 每日背诵目标进度统计（P1-09，纯函数模块）
 * 只依赖结构化最小接口（completedAt?: string），不 import store 类型，避免耦合。
 * 口径：背诵进度列表中每条「当天完成背诵」的记录记 1 段（completedAt 为完成时间戳）。
 *
 * 时区口径：所有日期边界按「本地时区」的 00:00–24:00 计算（Date.setHours 归零），
 * 与用户感知的「今天」一致；不使用 UTC 切日，避免跨时区设备上「今天」错位。
 */

/** 目标量合法下界 */
export const DAILY_GOAL_MIN = 1;
/** 目标量合法上界 */
export const DAILY_GOAL_MAX = 99;
/** 目标量默认值 */
export const DEFAULT_DAILY_GOAL = 5;

/** 参与统计的条目最小结构（只要 completedAt，容错缺失/非法值） */
export interface CompletedAtItem {
  /** 完成背诵的 ISO 时间戳；缺失或非法时该条目不计入统计 */
  completedAt?: string;
}

/** 每日目标进度结果 */
export interface DailyGoalProgress {
  /** 今日已完成段数 */
  completed: number;
  /** 目标段数（<=0 时归一为 0，见 dailyGoalProgress 注释） */
  goal: number;
  /** 距目标还差段数（下限 0，超额不产生负数） */
  remaining: number;
  /** 是否已达成（completed >= goal） */
  achieved: boolean;
}

/**
 * 统计 items 中 completedAt 落在 date 当天（本地时区 00:00–24:00，左闭右开）的条目数。
 * 容错：completedAt 缺失、或 Date.parse 解析为 NaN（非法字符串）时跳过该条目。
 */
export function countCompletedOnDate(items: readonly CompletedAtItem[], date: Date): number {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const startMs = dayStart.getTime();
  const endMs = dayEnd.getTime();

  let count = 0;
  for (const item of items) {
    if (!item.completedAt) {
      continue;
    }
    const ts = Date.parse(item.completedAt);
    // 左闭右开 [00:00, 次日 00:00)：恰好 00:00 属于当天，恰好次日 00:00 属于次日
    if (!Number.isNaN(ts) && ts >= startMs && ts < endMs) {
      count += 1;
    }
  }
  return count;
}

/**
 * 计算每日目标进度。
 * goal<=0 的口径：无有效目标 → goal 归一为 0、remaining=0、achieved=true，
 * 即「没设目标视为已达成」，不会产生目标提醒压力（与提醒联动策略一致）。
 * 非整数 goal 向下取整（按整段计数）。
 */
export function dailyGoalProgress(
  items: readonly CompletedAtItem[],
  date: Date,
  goalCount: number,
): DailyGoalProgress {
  const completed = countCompletedOnDate(items, date);
  const goal = goalCount > 0 ? Math.floor(goalCount) : 0;
  const remaining = Math.max(0, goal - completed);
  return { completed, goal, remaining, achieved: completed >= goal };
}
