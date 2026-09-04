/**
 * 学习统计纯函数单测（P2-14 学习社区本地版）：
 *   - buildStudyStats：聚合口径（completedAt 缺失/非法不计、coverageBooks 去重、
 *     每日目标开关对达成态的影响、unlockedCount / 计数入参清洗）
 *   - 复用对接正确性：streakDays 与 computeStreak 同口径、todayRecited/dailyGoal 与 dailyGoalProgress 同口径
 *   - formatShareText：0 值行不出现空泛表述、含关键数字与尾注、达成态文案
 * 日期口径：测试用本地时区构造日期（正午时刻转 ISO，规避时区切日偏移）。
 */
import { buildStudyStats, formatShareText } from '@/utils/studyStats';
import type { StudyStatsRecitationItem } from '@/utils/studyStats';
import { ACHIEVEMENT_TOTAL } from '@/utils/achievements';

/** 某本地日历日「正午」的 ISO 串（任意时区下都落在同一日历日） */
function isoOn(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

/** 某本地日历日上午的 Date（作为「今天」） */
function todayOn(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 10, 0, 0, 0);
}

/** 构造一条背诵条目（completedAt 可省略模拟未完成） */
function item(bookId: string, completedAt?: string): StudyStatsRecitationItem {
  return completedAt === undefined ? { bookId } : { bookId, completedAt };
}

/** 空快照（全 0 数据 + 目标关闭） */
function emptySnapshot(): Parameters<typeof buildStudyStats>[0] {
  return {
    recitationItems: [],
    bookmarkCount: 0,
    noteCount: 0,
    unlockedAt: {},
    dailyGoalEnabled: false,
    dailyGoalCount: 5,
  };
}

describe('buildStudyStats（聚合口径）', () => {
  test('空快照 → 全 0（目标关闭时 dailyGoal=0、todayAchieved=true）', () => {
    const stats = buildStudyStats(emptySnapshot(), todayOn(2026, 3, 15));
    expect(stats).toEqual({
      totalRecited: 0,
      streakDays: 0,
      todayRecited: 0,
      dailyGoal: 0,
      todayAchieved: true,
      unlockedCount: 0,
      achievementTotal: ACHIEVEMENT_TOTAL,
      bookmarkCount: 0,
      noteCount: 0,
      coverageBooks: 0,
    });
  });

  test('completedAt 缺失/非法的条目不计入 totalRecited 与 coverageBooks', () => {
    const stats = buildStudyStats(
      {
        ...emptySnapshot(),
        dailyGoalEnabled: true,
        recitationItems: [
          item('b1'), // 缺 completedAt：未完成
          item('b2', 'not-a-date'), // 非法时间串
          item('b2', ''), // 空串
          item('b1', isoOn(2026, 3, 15)), // 合法：计入
        ],
      },
      todayOn(2026, 3, 15),
    );
    expect(stats.totalRecited).toBe(1);
    expect(stats.coverageBooks).toBe(1); // 仅 b1（合法条目）参与去重
    expect(stats.todayRecited).toBe(1);
  });

  test('coverageBooks：已完成条目 bookId 去重，同书多段只算一部', () => {
    const stats = buildStudyStats(
      {
        ...emptySnapshot(),
        recitationItems: [
          item('lunyu', isoOn(2026, 3, 13)),
          item('lunyu', isoOn(2026, 3, 14)),
          item('daxue', isoOn(2026, 3, 15)),
          item('daxue', isoOn(2026, 3, 15)),
          item('mengzi'), // 未完成，不计覆盖
        ],
      },
      todayOn(2026, 3, 15),
    );
    expect(stats.totalRecited).toBe(4);
    expect(stats.coverageBooks).toBe(2);
  });

  test('streakDays 复用 computeStreak 宽容口径：昨天+今天连续、今天没背从昨天回数', () => {
    // 今天背了：3/14、3/15 → 连续 2 天
    const withToday = buildStudyStats(
      {
        ...emptySnapshot(),
        recitationItems: [item('b1', isoOn(2026, 3, 14)), item('b1', isoOn(2026, 3, 15))],
      },
      todayOn(2026, 3, 15),
    );
    expect(withToday.streakDays).toBe(2);

    // 今天没背：3/13、3/14 → 从昨天回数，仍为 2（宽容口径不断签）
    const withoutToday = buildStudyStats(
      {
        ...emptySnapshot(),
        recitationItems: [item('b1', isoOn(2026, 3, 13)), item('b1', isoOn(2026, 3, 14))],
      },
      todayOn(2026, 3, 15),
    );
    expect(withoutToday.streakDays).toBe(2);
  });

  test('每日目标：enabled=true 时复用 dailyGoalProgress 口径（completed/goal/achieved）', () => {
    // 今日完成 2 段、目标 5 → 未达成
    const notAchieved = buildStudyStats(
      {
        ...emptySnapshot(),
        dailyGoalEnabled: true,
        dailyGoalCount: 5,
        recitationItems: [item('b1', isoOn(2026, 3, 15)), item('b2', isoOn(2026, 3, 15))],
      },
      todayOn(2026, 3, 15),
    );
    expect(notAchieved.todayRecited).toBe(2);
    expect(notAchieved.dailyGoal).toBe(5);
    expect(notAchieved.todayAchieved).toBe(false);

    // 目标 2 → 达成（completed >= goal）
    const achieved = buildStudyStats(
      {
        ...emptySnapshot(),
        dailyGoalEnabled: true,
        dailyGoalCount: 2,
        recitationItems: [item('b1', isoOn(2026, 3, 15)), item('b2', isoOn(2026, 3, 15))],
      },
      todayOn(2026, 3, 15),
    );
    expect(achieved.todayAchieved).toBe(true);
  });

  test('每日目标关闭 → dailyGoal 归 0、todayAchieved=true，todayRecited 仍统计', () => {
    const stats = buildStudyStats(
      {
        ...emptySnapshot(),
        dailyGoalEnabled: false,
        dailyGoalCount: 5,
        recitationItems: [item('b1', isoOn(2026, 3, 15))],
      },
      todayOn(2026, 3, 15),
    );
    expect(stats.dailyGoal).toBe(0);
    expect(stats.todayAchieved).toBe(true);
    expect(stats.todayRecited).toBe(1);
  });

  test('unlockedCount 取 unlockedAt 非空 key 数；bookmark/note 负数归一为 0', () => {
    const stats = buildStudyStats(
      {
        ...emptySnapshot(),
        bookmarkCount: -3,
        noteCount: 7,
        unlockedAt: { 'streak-3': '2026-03-13T10:00:00.000Z', '': '应被忽略' },
      },
      todayOn(2026, 3, 15),
    );
    expect(stats.unlockedCount).toBe(1);
    expect(stats.achievementTotal).toBe(13);
    expect(stats.bookmarkCount).toBe(0);
    expect(stats.noteCount).toBe(7);
  });
});

describe('formatShareText（分享文案）', () => {
  test('全 0 数据：无空泛行，仅标题、日期与尾注', () => {
    const text = formatShareText(buildStudyStats(emptySnapshot(), todayOn(2026, 3, 15)), todayOn(2026, 3, 15));
    expect(text).toContain('📚 我的国学学习成果');
    expect(text).toContain('2026年3月15日');
    expect(text).toContain('—— 来自国学学习 App');
    // 0 值行不出现
    expect(text).not.toContain('累计背诵');
    expect(text).not.toContain('连续打卡');
    expect(text).not.toContain('成就');
    expect(text).not.toContain('收藏');
    expect(text).not.toContain('笔记');
    expect(text).not.toContain('今日背诵');
  });

  test('有数据：包含关键数字与尾注，多行输出', () => {
    const snapshot: Parameters<typeof buildStudyStats>[0] = {
      recitationItems: [
        item('lunyu', isoOn(2026, 3, 13)),
        item('lunyu', isoOn(2026, 3, 14)),
        item('daxue', isoOn(2026, 3, 15)),
        item('daxue', isoOn(2026, 3, 15)),
      ],
      bookmarkCount: 8,
      noteCount: 3,
      unlockedAt: { 'streak-3': 'x', 'recite-10': 'x' },
      dailyGoalEnabled: true,
      dailyGoalCount: 5,
    };
    const today = todayOn(2026, 3, 15);
    const text = formatShareText(buildStudyStats(snapshot, today), today);

    // 今日进度（2/5 未达成）
    expect(text).toContain('📖 今日背诵 2/5 段');
    // 累计与连击（3/13–3/15 连续 3 天）
    expect(text).toContain('🧾 累计背诵 4 段');
    expect(text).toContain('🔥 连续打卡 3 天');
    // 覆盖 2 部书
    expect(text).toContain('已在 2 部书中留下背诵足迹');
    // 成就 2/13
    expect(text).toContain('🏅 已解锁成就 2/13');
    // 收藏 / 笔记
    expect(text).toContain('⭐ 收藏 8 条');
    expect(text).toContain('📝 笔记 3 条');
    // 尾注
    expect(text).toContain('—— 来自国学学习 App');
    // 多行
    expect(text.split('\n').length).toBeGreaterThanOrEqual(8);
  });

  test('今日目标达成 → 使用「目标已达成」表述', () => {
    const snapshot: Parameters<typeof buildStudyStats>[0] = {
      recitationItems: [item('b1', isoOn(2026, 3, 15)), item('b2', isoOn(2026, 3, 15))],
      bookmarkCount: 0,
      noteCount: 0,
      unlockedAt: {},
      dailyGoalEnabled: true,
      dailyGoalCount: 2,
    };
    const today = todayOn(2026, 3, 15);
    const text = formatShareText(buildStudyStats(snapshot, today), today);
    expect(text).toContain('✅ 今日背诵 2/2 段，目标已达成');
  });

  test('每日目标关闭 → 不出现今日进度行', () => {
    const snapshot: Parameters<typeof buildStudyStats>[0] = {
      recitationItems: [item('b1', isoOn(2026, 3, 15))],
      bookmarkCount: 0,
      noteCount: 0,
      unlockedAt: {},
      dailyGoalEnabled: false,
      dailyGoalCount: 5,
    };
    const today = todayOn(2026, 3, 15);
    const text = formatShareText(buildStudyStats(snapshot, today), today);
    expect(text).not.toContain('今日背诵');
    expect(text).toContain('🧾 累计背诵 1 段');
  });
});
