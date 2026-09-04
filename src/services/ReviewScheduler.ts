/**
 * 间隔复习调度（P2-07 艾宾浩斯，纯函数层）
 * 复习间隔序列 1 / 2 / 4 / 7 / 15 天；一次背诵完成（fillBlank 提交）视为一次复习事件：
 * 全对 → 等级 +1（封顶最高级），有错 → 等级 -1（保底 0，即隔 1 天再复习）。
 * 下次到期时间 = 本次完成时刻 + 新等级对应间隔（与原到期时间无关：
 * 逾期多日完成不会额外惩罚，逾期本身已通过「有错降级」体现）。
 * 独立于 UI 与存储层，便于单元测试锁定调度语义。
 */
import type { RecitationProgress } from '@/types';

/** 艾宾浩斯复习间隔序列（天），下标即复习等级 */
export const REVIEW_INTERVAL_DAYS = [1, 2, 4, 7, 15] as const;

/** 最低复习等级（保底，降级到此为止） */
export const MIN_REVIEW_LEVEL = 0;

/** 最高复习等级（封顶，停留在 15 天间隔循环复习） */
export const MAX_REVIEW_LEVEL = REVIEW_INTERVAL_DAYS.length - 1;

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 等级收敛到 [MIN, MAX] 区间 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return MIN_REVIEW_LEVEL;
  }
  return Math.min(MAX_REVIEW_LEVEL, Math.max(MIN_REVIEW_LEVEL, Math.floor(level)));
}

/**
 * 依据本次作答结果推进/回退等级：
 * 全对 +1（封顶 MAX），有错 -1（保底 MIN）。
 */
export function advanceLevel(level: number, allCorrect: boolean): number {
  const current = clampLevel(level);
  return allCorrect
    ? Math.min(MAX_REVIEW_LEVEL, current + 1)
    : Math.max(MIN_REVIEW_LEVEL, current - 1);
}

/** 由完成时刻与等级计算下次到期时刻：completedAt + 间隔天数 */
export function nextDueAt(completedAt: Date, level: number): Date {
  const days = REVIEW_INTERVAL_DAYS[clampLevel(level)];
  return new Date(completedAt.getTime() + days * DAY_MS);
}

/**
 * 完成一次复习事件：返回新等级与下次到期时刻。
 * allCorrect 判定由调用方完成（total > 0 且 correct === total）。
 */
export function scheduleNext(
  level: number,
  allCorrect: boolean,
  completedAt: Date,
): { level: number; nextDueAt: Date } {
  const newLevel = advanceLevel(level, allCorrect);
  return { level: newLevel, nextDueAt: nextDueAt(completedAt, newLevel) };
}

/**
 * 到期判定（口径：nextDueAt <= now 即到期，含同秒）。
 * 无记录（undefined）或非法时间 → 不产生复习项（兼容旧数据）。
 */
export function isDue(nextDueAtIso: string | undefined, now: Date): boolean {
  if (!nextDueAtIso) {
    return false;
  }
  const t = new Date(nextDueAtIso).getTime();
  if (Number.isNaN(t)) {
    return false;
  }
  return t <= now.getTime();
}

/** 今日复习项（已按 bookId+chapterId 去重） */
export interface ReviewItem {
  bookId: string;
  chapterId: string;
  /** 当前复习等级（REVIEW_INTERVAL_DAYS 下标） */
  level: number;
  /** 最近一次完成时刻（ISO） */
  completedAt: string;
  /** 下次到期时刻（ISO） */
  nextDueAt: string;
  /** 已逾期天数（向下取整，可为 0） */
  overdueDays: number;
}

/**
 * 由背诵进度列表构建今日复习项。
 * 口径：
 * - 仅纳入含 completedAt 的记录（旧数据无该字段不产生复习项）；
 * - 同一 bookId+chapterId 多条记录（不同模式）取 completedAt 最新一条；
 * - 仅保留到期项（nextDueAt <= now）；
 * - 按到期时刻升序（逾期最久的排最前）。
 */
export function buildReviewItems(
  list: RecitationProgress[],
  now: Date = new Date(),
): ReviewItem[] {
  const latest = new Map<string, RecitationProgress>();
  for (const r of list) {
    if (!r.completedAt) {
      continue;
    }
    const key = `${r.bookId}:${r.chapterId}`;
    const prev = latest.get(key);
    if (!prev || (r.completedAt ?? '') > (prev.completedAt ?? '')) {
      latest.set(key, r);
    }
  }
  const items: ReviewItem[] = [];
  for (const r of latest.values()) {
    if (!isDue(r.nextDueAt, now)) {
      continue;
    }
    const level = clampLevel(r.reviewLevel ?? 0);
    const dueMs = new Date(r.nextDueAt as string).getTime();
    items.push({
      bookId: r.bookId,
      chapterId: r.chapterId,
      level,
      completedAt: r.completedAt as string,
      nextDueAt: r.nextDueAt as string,
      overdueDays: Math.max(0, Math.floor((now.getTime() - dueMs) / DAY_MS)),
    });
  }
  items.sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
  return items;
}
