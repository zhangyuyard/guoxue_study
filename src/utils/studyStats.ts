/**
 * 学习统计纯函数模块（P2-14 学习社区本地版）
 * 「学习社区」本地落地：本地学习数据总览 + 分享文案出口（零账号、零网络）。
 * 与 achievements / dailyGoal 同一套路：只依赖结构化最小接口，
 * 不 import store 类型，避免耦合；纯函数不取系统时间，「今天」由调用方传入。
 *
 * 口径说明：
 *   - totalRecited：completedAt 可解析（非空且 Date.parse 非 NaN）的条目数；
 *   - coverageBooks：completedAt 非空条目的 bookId 去重数（未完成条目不计入覆盖）；
 *   - streakDays / 今日目标进度：分别复用 computeStreak / dailyGoalProgress，
 *     不重复实现，保证全 App 统计口径唯一。
 */

import { ACHIEVEMENT_TOTAL, computeStreak } from '@/utils/achievements';
import { dailyGoalProgress, type CompletedAtItem } from '@/utils/dailyGoal';

/** 参与统计的背诵条目最小结构（在 dailyGoal 的 CompletedAtItem 上补充 bookId） */
export interface StudyStatsRecitationItem extends CompletedAtItem {
  /** 所属书籍 id（覆盖书籍去重口径，仅对已完成的条目计数） */
  bookId: string;
}

/** 学习统计输入快照（最小结构化接口，不耦合 store 类型） */
export interface StudyStatsSnapshot {
  /** 背诵进度条目列表（容错缺失/非法字段） */
  recitationItems: readonly StudyStatsRecitationItem[];
  /** 当前收藏条数 */
  bookmarkCount: number;
  /** 当前笔记条数 */
  noteCount: number;
  /** 已解锁成就：achievementId → 解锁时刻（ISO 字符串） */
  unlockedAt: Readonly<Record<string, string>>;
  /** 每日背诵目标开关（关闭时目标视为 0，不参与达成态判断） */
  dailyGoalEnabled: boolean;
  /** 每日目标段数 */
  dailyGoalCount: number;
}

/** 学习统计结果 */
export interface StudyStats {
  /** 累计背诵完成段数（completedAt 非空条数） */
  totalRecited: number;
  /** 连续打卡天数（复用 computeStreak 宽容口径） */
  streakDays: number;
  /** 今日已完成段数 */
  todayRecited: number;
  /** 每日目标段数（目标关闭时为 0） */
  dailyGoal: number;
  /** 今日目标是否已达成（goal<=0 时按 dailyGoalProgress 口径视为达成） */
  todayAchieved: boolean;
  /** 已解锁成就数 */
  unlockedCount: number;
  /** 成就总数（13） */
  achievementTotal: number;
  /** 收藏条数 */
  bookmarkCount: number;
  /** 笔记条数 */
  noteCount: number;
  /** 覆盖书籍数（completedAt 非空条目的 bookId 去重） */
  coverageBooks: number;
}

/**
 * 聚合学习统计。
 * 「今天」由调用方传入（纯函数不取系统时间，便于测试）。
 * 容错：completedAt 缺失/非法的条目不计入段数与覆盖；bookId 非字符串/空串跳过；
 * 计数类入参（收藏/笔记数）负数与非有限值归一为 0。
 */
export function buildStudyStats(input: StudyStatsSnapshot, today: Date): StudyStats {
  // 清洗：只保留 completedAt 可解析的条目参与段数 / 连击 / 今日进度统计
  const validItems: StudyStatsRecitationItem[] = [];
  for (const item of input.recitationItems) {
    if (
      !item ||
      typeof item.completedAt !== 'string' ||
      item.completedAt === '' ||
      Number.isNaN(Date.parse(item.completedAt))
    ) {
      continue;
    }
    validItems.push(item);
  }

  // 覆盖书籍：已完成条目的 bookId 去重
  const bookIdSet = new Set<string>();
  for (const item of validItems) {
    if (typeof item.bookId === 'string' && item.bookId !== '') {
      bookIdSet.add(item.bookId);
    }
  }

  // 计数入参清洗（负数 / 非有限值归一为 0，防脏数据污染展示与分享）
  const bookmarkCount =
    Number.isFinite(input.bookmarkCount) ? Math.max(0, Math.floor(input.bookmarkCount)) : 0;
  const noteCount =
    Number.isFinite(input.noteCount) ? Math.max(0, Math.floor(input.noteCount)) : 0;

  // 目标关闭 → goalCount 传 0，dailyGoalProgress 口径：goal=0、achieved=true
  const goalCount = input.dailyGoalEnabled ? input.dailyGoalCount : 0;
  const progress = dailyGoalProgress(validItems, today, goalCount);

  // 已解锁成就数：仅统计 key 非空的条目
  let unlockedCount = 0;
  for (const key of Object.keys(input.unlockedAt ?? {})) {
    if (key !== '') {
      unlockedCount += 1;
    }
  }

  return {
    totalRecited: validItems.length,
    streakDays: computeStreak(
      validItems.map((item) => item.completedAt as string),
      today,
    ),
    todayRecited: progress.completed,
    dailyGoal: progress.goal,
    todayAchieved: progress.achieved,
    unlockedCount,
    achievementTotal: ACHIEVEMENT_TOTAL,
    bookmarkCount,
    noteCount,
    coverageBooks: bookIdSet.size,
  };
}

/**
 * 生成分享文案（多行、含 emoji、中文，尾注「来自国学学习 App」）。
 * 设计取舍：数值为 0 的行不输出（streak=0 不写连击行、未解锁成就不写成就行），
 * 避免空泛表述；每日目标关闭（dailyGoal=0）时也不写今日进度行。
 */
export function formatShareText(stats: StudyStats, today: Date): string {
  const lines: string[] = [];

  lines.push('📚 我的国学学习成果');
  lines.push(`📅 ${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`);

  // 今日进度：仅在设置了目标（dailyGoal > 0）时展示
  if (stats.dailyGoal > 0) {
    lines.push(
      stats.todayAchieved
        ? `✅ 今日背诵 ${stats.todayRecited}/${stats.dailyGoal} 段，目标已达成`
        : `📖 今日背诵 ${stats.todayRecited}/${stats.dailyGoal} 段`,
    );
  }
  if (stats.totalRecited > 0) {
    lines.push(`🧾 累计背诵 ${stats.totalRecited} 段`);
  }
  if (stats.streakDays > 0) {
    lines.push(`🔥 连续打卡 ${stats.streakDays} 天`);
  }
  if (stats.coverageBooks > 0) {
    lines.push(`🏛️ 已在 ${stats.coverageBooks} 部书中留下背诵足迹`);
  }
  if (stats.unlockedCount > 0) {
    lines.push(`🏅 已解锁成就 ${stats.unlockedCount}/${stats.achievementTotal}`);
  }
  if (stats.bookmarkCount > 0) {
    lines.push(`⭐ 收藏 ${stats.bookmarkCount} 条`);
  }
  if (stats.noteCount > 0) {
    lines.push(`📝 笔记 ${stats.noteCount} 条`);
  }

  lines.push('—— 来自国学学习 App');
  return lines.join('\n');
}
