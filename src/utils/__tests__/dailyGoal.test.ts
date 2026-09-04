/**
 * dailyGoal 纯函数单测（P1-09）：
 *   - countCompletedOnDate：当天 23:59 / 次日 00:01 跨天边界、缺失/非法 completedAt、
 *     恰好 00:00 与次日 00:00 的左闭右开边界
 *   - dailyGoalProgress：remaining 边界（恰好达成 / 超额）、achieved 恰好等于、goal<=0 口径
 * 注意：测试用「无时区后缀」的日期字符串，Date.parse 按**本地时区**解析，
 * 与实现中的 setHours 本地切日口径一致，不受 CI 机器时区影响。
 */
import {
  countCompletedOnDate,
  dailyGoalProgress,
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  DEFAULT_DAILY_GOAL,
} from '@/utils/dailyGoal';

/** 构造统计条目 */
function makeItem(completedAt?: string): { completedAt?: string } {
  return completedAt === undefined ? {} : { completedAt };
}

describe('常量', () => {
  test('目标量边界常量：MIN=1 / MAX=99 / 默认 5', () => {
    expect(DAILY_GOAL_MIN).toBe(1);
    expect(DAILY_GOAL_MAX).toBe(99);
    expect(DEFAULT_DAILY_GOAL).toBe(5);
  });
});

describe('countCompletedOnDate', () => {
  /** 统计基准日：2026-03-15（本地时区）任意时刻，切日只看当天 00:00–24:00 */
  const baseDate = new Date('2026-03-15T10:00:00.000');

  test('空列表 → 0', () => {
    expect(countCompletedOnDate([], baseDate)).toBe(0);
  });

  test('当天 23:59:59 完成 → 计入当天', () => {
    const items = [makeItem('2026-03-15T23:59:59.000')];
    expect(countCompletedOnDate(items, baseDate)).toBe(1);
  });

  test('次日 00:01 完成 → 不计入前一天，计入次日', () => {
    const items = [makeItem('2026-03-16T00:01:00.000')];
    expect(countCompletedOnDate(items, baseDate)).toBe(0);
    expect(countCompletedOnDate(items, new Date('2026-03-16T08:00:00.000'))).toBe(1);
  });

  test('恰好当天 00:00 → 计入当天（左闭）；恰好次日 00:00 → 不计入（右开）', () => {
    const atMidnight = [makeItem('2026-03-15T00:00:00.000')];
    const atNextMidnight = [makeItem('2026-03-16T00:00:00.000')];
    expect(countCompletedOnDate(atMidnight, baseDate)).toBe(1);
    expect(countCompletedOnDate(atNextMidnight, baseDate)).toBe(0);
    expect(countCompletedOnDate(atNextMidnight, new Date('2026-03-16T12:00:00.000'))).toBe(1);
  });

  test('completedAt 缺失 → 跳过不计数', () => {
    const items: { completedAt?: string }[] = [makeItem(), makeItem('2026-03-15T09:00:00.000')];
    expect(countCompletedOnDate(items, baseDate)).toBe(1);
  });

  test('completedAt 非法字符串 → 跳过不计数（不抛异常）', () => {
    const items = [
      makeItem('not-a-date'),
      makeItem(''),
      makeItem('2026-13-99T99:99:99'),
      makeItem('2026-03-15T09:00:00.000'),
    ];
    expect(countCompletedOnDate(items, baseDate)).toBe(1);
  });

  test('前一天完成 → 不计入当天（同格式不同日期）', () => {
    const items = [makeItem('2026-03-14T23:59:59.000'), makeItem('2026-03-15T09:00:00.000')];
    expect(countCompletedOnDate(items, baseDate)).toBe(1);
  });

  test('多条同日完成 → 逐条累加', () => {
    const items = [
      makeItem('2026-03-15T08:00:00.000'),
      makeItem('2026-03-15T12:30:00.000'),
      makeItem('2026-03-15T23:59:59.000'),
      makeItem('2026-03-16T00:00:00.000'),
    ];
    expect(countCompletedOnDate(items, baseDate)).toBe(3);
  });
});

describe('dailyGoalProgress', () => {
  const baseDate = new Date('2026-03-15T10:00:00.000');

  test('基本口径：completed / goal / remaining / achieved', () => {
    const items = [makeItem('2026-03-15T08:00:00.000')];
    expect(dailyGoalProgress(items, baseDate, 5)).toEqual({
      completed: 1,
      goal: 5,
      remaining: 4,
      achieved: false,
    });
  });

  test('恰好等于目标 → achieved=true，remaining=0', () => {
    const items = [
      makeItem('2026-03-15T08:00:00.000'),
      makeItem('2026-03-15T09:00:00.000'),
      makeItem('2026-03-15T10:00:00.000'),
    ];
    const p = dailyGoalProgress(items, baseDate, 3);
    expect(p.completed).toBe(3);
    expect(p.remaining).toBe(0);
    expect(p.achieved).toBe(true);
  });

  test('超额完成 → remaining 下限 0（不为负），achieved=true', () => {
    const items = [
      makeItem('2026-03-15T08:00:00.000'),
      makeItem('2026-03-15T09:00:00.000'),
    ];
    const p = dailyGoalProgress(items, baseDate, 1);
    expect(p.completed).toBe(2);
    expect(p.remaining).toBe(0);
    expect(p.achieved).toBe(true);
  });

  test('goal<=0 → 归一为无目标口径：goal=0 / remaining=0 / achieved=true', () => {
    const items = [makeItem('2026-03-15T08:00:00.000')];
    expect(dailyGoalProgress(items, baseDate, 0)).toEqual({
      completed: 1,
      goal: 0,
      remaining: 0,
      achieved: true,
    });
    expect(dailyGoalProgress(items, baseDate, -3)).toEqual({
      completed: 1,
      goal: 0,
      remaining: 0,
      achieved: true,
    });
  });

  test('goal<=0 且无完成 → completed=0 / achieved=true（无目标不产生压力）', () => {
    expect(dailyGoalProgress([], baseDate, 0)).toEqual({
      completed: 0,
      goal: 0,
      remaining: 0,
      achieved: true,
    });
  });

  test('非整数 goal 向下取整（2.9 → 按 2 段计）', () => {
    const one = [makeItem('2026-03-15T08:00:00.000')];
    const two = [makeItem('2026-03-15T08:00:00.000'), makeItem('2026-03-15T09:00:00.000')];
    const p = dailyGoalProgress(one, baseDate, 2.9);
    expect(p.goal).toBe(2);
    expect(p.achieved).toBe(false);
    expect(dailyGoalProgress(two, baseDate, 2.9).achieved).toBe(true);
  });
});
