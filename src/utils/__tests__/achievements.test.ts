/**
 * 成就纯函数单测（P2-06）：
 *   - computeStreak：连续打卡口径（今天背了看今天 / 没背看昨天）、容错、跨月边界
 *   - evaluateAchievements：各分类阈值判定与快照清洗
 *   - 定义表自检：id 唯一、同分类阈值递增
 * 日期口径：测试用本地时区构造日期（正午时刻转 ISO，规避时区切日偏移）。
 */
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_TOTAL,
  computeStreak,
  evaluateAchievements,
} from '@/utils/achievements';

/** 某本地日历日「正午」的 ISO 串（任意时区下都落在同一日历日） */
function isoOn(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

/** 某本地日历日上午的 Date（作为「今天」） */
function todayOn(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 10, 0, 0, 0);
}

describe('定义表自检', () => {
  test('成就总数为 13（4 背诵 + 4 连击 + 2 收藏 + 1 笔记 + 2 覆盖）', () => {
    expect(ACHIEVEMENT_TOTAL).toBe(13);
    expect(ACHIEVEMENTS).toHaveLength(13);
  });

  test('成就 id 唯一', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('同分类阈值严格递增（保证解锁顺序稳定）', () => {
    const byCategory = new Map<string, number[]>();
    for (const a of ACHIEVEMENTS) {
      const list = byCategory.get(a.category) ?? [];
      list.push(a.threshold);
      byCategory.set(a.category, list);
    }
    for (const [, thresholds] of byCategory) {
      const sorted = [...thresholds].sort((x, y) => x - y);
      expect(thresholds).toEqual(sorted);
      expect(new Set(thresholds).size).toBe(thresholds.length);
    }
  });
});

describe('computeStreak（连续打卡天数）', () => {
  test('空列表 → 0', () => {
    expect(computeStreak([], todayOn(2026, 3, 15))).toBe(0);
  });

  test('连续到今天：3/13、3/14、3/15，今天 3/15 → 3 天', () => {
    const dates = [isoOn(2026, 3, 13), isoOn(2026, 3, 14), isoOn(2026, 3, 15)];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(3);
  });

  test('宽容口径：今天没背不断签，从昨天往回数（3/12–3/14，今天 3/15 → 3 天）', () => {
    const dates = [isoOn(2026, 3, 12), isoOn(2026, 3, 13), isoOn(2026, 3, 14)];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(3);
  });

  test('今天昨天都没背 → 0（断签）', () => {
    const dates = [isoOn(2026, 3, 10), isoOn(2026, 3, 11)];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(0);
  });

  test('中间断一天：只数到断点（3/11、3/12、3/14、3/15 → 2 天）', () => {
    const dates = [
      isoOn(2026, 3, 11),
      isoOn(2026, 3, 12),
      isoOn(2026, 3, 14),
      isoOn(2026, 3, 15),
    ];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(2);
  });

  test('同一天背多段只算一天（去重）', () => {
    const dates = [
      isoOn(2026, 3, 14),
      isoOn(2026, 3, 14),
      isoOn(2026, 3, 15),
      isoOn(2026, 3, 15),
    ];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(2);
  });

  test('跨月边界（2/28、3/1 连续，今天 3/1 → 2 天，2026 非闰年）', () => {
    const dates = [isoOn(2026, 2, 28), isoOn(2026, 3, 1)];
    expect(computeStreak(dates, todayOn(2026, 3, 1))).toBe(2);
  });

  test('非法/空字符串日期跳过，不参与连击', () => {
    const dates = ['', 'not-a-date', isoOn(2026, 3, 15)];
    expect(computeStreak(dates, todayOn(2026, 3, 15))).toBe(1);
  });
});

describe('evaluateAchievements（成就评估）', () => {
  const today = todayOn(2026, 3, 15);

  test('全部指标为空 → 无达成', () => {
    const achieved = evaluateAchievements({
      completedAt: [],
      bookIds: [],
      bookmarkCount: 0,
      noteCount: 0,
      today,
    });
    expect(achieved).toEqual([]);
  });

  test('累计背诵 10 段 → 仅解锁 recite-10', () => {
    const dates = Array.from({ length: 10 }, (_, i) => isoOn(2026, 3, 1 + (i % 10)));
    const achieved = evaluateAchievements({
      completedAt: dates,
      bookIds: ['book1'],
      bookmarkCount: 0,
      noteCount: 0,
      today,
    });
    expect(achieved).toEqual(['recite-10']);
  });

  test('累计背诵 11 段且连续 3 天 → recite-10 + streak-3', () => {
    // 3/13、3/14、3/15 各背若干段，共 11 段
    const dates = [
      ...Array.from({ length: 4 }, () => isoOn(2026, 3, 13)),
      ...Array.from({ length: 4 }, () => isoOn(2026, 3, 14)),
      ...Array.from({ length: 3 }, () => isoOn(2026, 3, 15)),
    ];
    const achieved = evaluateAchievements({
      completedAt: dates,
      bookIds: ['book1'],
      bookmarkCount: 0,
      noteCount: 0,
      today,
    });
    expect(achieved).toContain('recite-10');
    expect(achieved).toContain('streak-3');
    expect(achieved).not.toContain('recite-50');
    expect(achieved).not.toContain('streak-7');
  });

  test('收藏数与笔记数达标 → bookmark-10 / note-10（恰好等于阈值也算达成）', () => {
    const achieved = evaluateAchievements({
      completedAt: [],
      bookIds: [],
      bookmarkCount: 10,
      noteCount: 10,
      today,
    });
    expect(achieved).toEqual(['bookmark-10', 'note-10']);
  });

  test('覆盖书籍数：bookId 去重计数（7 条记录 5 本书 → 仅 coverage-5）', () => {
    const bookIds = ['b1', 'b1', 'b2', 'b3', 'b3', 'b4', 'b5'];
    const achieved = evaluateAchievements({
      completedAt: bookIds.map(() => isoOn(2026, 3, 15)),
      bookIds,
      bookmarkCount: 0,
      noteCount: 0,
      today,
    });
    // 7 段未到 recite-10 阈值；同日 1 连击未到 streak-3
    expect(achieved).toEqual(['coverage-5']);
    expect(achieved).not.toContain('coverage-10');
  });

  test('非法 completedAt 既不计入段数也不参与连击', () => {
    const achieved = evaluateAchievements({
      completedAt: ['bad-date', ''],
      bookIds: [],
      bookmarkCount: 0,
      noteCount: 0,
      today,
    });
    expect(achieved).toEqual([]);
  });

  test('负数/非有限计数容错为 0', () => {
    const achieved = evaluateAchievements({
      completedAt: [],
      bookIds: [],
      bookmarkCount: -5,
      noteCount: Number.NaN,
      today,
    });
    expect(achieved).toEqual([]);
  });

  test('达成列表保持定义表顺序', () => {
    // 构造同时达成 recite-10 / streak-3 / bookmark-10 的快照
    const dates = [
      isoOn(2026, 3, 13),
      isoOn(2026, 3, 14),
      isoOn(2026, 3, 15),
      isoOn(2026, 3, 12),
      isoOn(2026, 3, 11),
      isoOn(2026, 3, 10),
      isoOn(2026, 3, 9),
      isoOn(2026, 3, 8),
      isoOn(2026, 3, 7),
      isoOn(2026, 3, 6),
    ];
    const achieved = evaluateAchievements({
      completedAt: dates,
      bookIds: ['b1'],
      bookmarkCount: 12,
      noteCount: 0,
      today,
    });
    const orderOf = (id: string) => ACHIEVEMENTS.findIndex((a) => a.id === id);
    const indices = achieved.map(orderOf);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});
