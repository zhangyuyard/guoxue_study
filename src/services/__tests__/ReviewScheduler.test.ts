/**
 * 间隔复习调度测试（P2-07 艾宾浩斯，纯函数层）
 * 锁定：1/2/4/7/15 序列、全对升级/有错降级、边界（底部降级停留、顶部升级封顶）、
 * 到期判定（nextDueAt <= now，旧数据不产生）、多日逾期按实际完成时间重排。
 */
import {
  advanceLevel,
  buildReviewItems,
  clampLevel,
  isDue,
  MAX_REVIEW_LEVEL,
  MIN_REVIEW_LEVEL,
  nextDueAt,
  REVIEW_INTERVAL_DAYS,
  scheduleNext,
} from '@/services/ReviewScheduler';
import type { RecitationProgress } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造一条背诵进度 */
function makeProgress(overrides: Partial<RecitationProgress> = {}): RecitationProgress {
  return {
    id: 'lunyu:xue-er:fillBlank',
    bookId: 'lunyu',
    chapterId: 'xue-er',
    mode: 'fillBlank',
    status: 'mastered',
    progress: 100,
    ...overrides,
  };
}

describe('REVIEW_INTERVAL_DAYS：间隔序列', () => {
  test('序列为 1/2/4/7/15 天，等级边界与序列下标一致', () => {
    expect([...REVIEW_INTERVAL_DAYS]).toEqual([1, 2, 4, 7, 15]);
    expect(MIN_REVIEW_LEVEL).toBe(0);
    expect(MAX_REVIEW_LEVEL).toBe(REVIEW_INTERVAL_DAYS.length - 1);
  });
});

describe('advanceLevel：升级 / 降级 / 边界', () => {
  test('全对升级一级', () => {
    expect(advanceLevel(0, true)).toBe(1);
    expect(advanceLevel(2, true)).toBe(3);
  });

  test('有错降级一级', () => {
    expect(advanceLevel(3, false)).toBe(2);
    expect(advanceLevel(1, false)).toBe(0);
  });

  test('底部边界：等级 0 有错停留 0（不产生负数）', () => {
    expect(advanceLevel(0, false)).toBe(0);
  });

  test('顶部边界：最高级全对封顶停留', () => {
    expect(advanceLevel(MAX_REVIEW_LEVEL, true)).toBe(MAX_REVIEW_LEVEL);
  });

  test('clampLevel 收敛非法输入', () => {
    expect(clampLevel(-5)).toBe(0);
    expect(clampLevel(99)).toBe(MAX_REVIEW_LEVEL);
    expect(clampLevel(Number.NaN)).toBe(0);
  });
});

describe('nextDueAt / scheduleNext：到期时间计算', () => {
  test('等级 0 → 完成后隔 1 天到期', () => {
    const done = new Date('2026-01-01T08:00:00.000Z');
    expect(nextDueAt(done, 0).getTime()).toBe(done.getTime() + 1 * DAY_MS);
  });

  test('等级 4 → 隔 15 天到期', () => {
    const done = new Date('2026-01-01T08:00:00.000Z');
    expect(nextDueAt(done, 4).getTime()).toBe(done.getTime() + 15 * DAY_MS);
  });

  test('全对：等级 +1 且按新等级间隔排期', () => {
    const done = new Date('2026-01-01T08:00:00.000Z');
    const next = scheduleNext(1, true, done);
    expect(next.level).toBe(2);
    expect(next.nextDueAt.getTime()).toBe(done.getTime() + 4 * DAY_MS);
  });

  test('有错：等级 -1 且按新等级间隔排期', () => {
    const done = new Date('2026-01-01T08:00:00.000Z');
    const next = scheduleNext(3, false, done);
    expect(next.level).toBe(2);
    expect(next.nextDueAt.getTime()).toBe(done.getTime() + 4 * DAY_MS);
  });

  test('多日逾期完成：按实际完成时刻重排（不叠加惩罚）', () => {
    const originalDue = new Date('2026-01-02T08:00:00.000Z');
    const actualDone = new Date(originalDue.getTime() + 10 * DAY_MS); // 逾期 10 天
    const next = scheduleNext(1, true, actualDone);
    expect(next.level).toBe(2);
    expect(next.nextDueAt.getTime()).toBe(actualDone.getTime() + 4 * DAY_MS);
  });
});

describe('isDue：到期判定', () => {
  const now = new Date('2026-01-05T00:00:00.000Z');

  test('nextDueAt <= now 即到期（含同秒）', () => {
    expect(isDue('2026-01-05T00:00:00.000Z', now)).toBe(true);
    expect(isDue('2026-01-04T23:59:59.999Z', now)).toBe(true);
  });

  test('未到期不产生复习项', () => {
    expect(isDue('2026-01-05T00:00:00.001Z', now)).toBe(false);
  });

  test('无记录或非法时间不产生复习项（兼容旧数据）', () => {
    expect(isDue(undefined, now)).toBe(false);
    expect(isDue('', now)).toBe(false);
    expect(isDue('not-a-date', now)).toBe(false);
  });
});

describe('buildReviewItems：今日复习列表', () => {
  const now = new Date('2026-01-05T00:00:00.000Z');

  test('旧数据（无 completedAt / nextDueAt）不产生复习项', () => {
    const items = buildReviewItems([makeProgress()], now);
    expect(items).toEqual([]);
  });

  test('到期章节产生复习项并携带等级与逾期信息', () => {
    const items = buildReviewItems(
      [
        makeProgress({
          completedAt: '2026-01-04T00:00:00.000Z',
          reviewLevel: 1,
          nextDueAt: '2026-01-05T00:00:00.000Z',
        }),
      ],
      now,
    );
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      bookId: 'lunyu',
      chapterId: 'xue-er',
      level: 1,
      overdueDays: 0,
    });
  });

  test('未到期章节不产生复习项', () => {
    const items = buildReviewItems(
      [
        makeProgress({
          completedAt: '2026-01-04T00:00:00.000Z',
          reviewLevel: 0,
          nextDueAt: '2026-01-06T00:00:00.000Z',
        }),
      ],
      now,
    );
    expect(items).toEqual([]);
  });

  test('同书同章多条记录（不同模式）按 completedAt 最新去重', () => {
    const items = buildReviewItems(
      [
        makeProgress({
          id: 'lunyu:xue-er:fillBlank',
          mode: 'fillBlank',
          completedAt: '2026-01-03T00:00:00.000Z',
          reviewLevel: 2,
          nextDueAt: '2026-01-05T00:00:00.000Z',
        }),
        makeProgress({
          id: 'lunyu:xue-er:coverHint',
          mode: 'coverHint',
          completedAt: '2026-01-04T00:00:00.000Z',
          reviewLevel: 0,
          nextDueAt: '2026-01-04T00:00:00.000Z',
        }),
      ],
      now,
    );
    expect(items.length).toBe(1);
    expect(items[0].level).toBe(0);
    expect(items[0].nextDueAt).toBe('2026-01-04T00:00:00.000Z');
  });

  test('多章节按到期时刻升序排列（逾期最久在前）', () => {
    const items = buildReviewItems(
      [
        makeProgress({
          id: 'a:a1:fillBlank',
          chapterId: 'a1',
          completedAt: '2026-01-04T00:00:00.000Z',
          nextDueAt: '2026-01-05T00:00:00.000Z',
        }),
        makeProgress({
          id: 'b:b1:fillBlank',
          chapterId: 'b1',
          completedAt: '2026-01-01T00:00:00.000Z',
          nextDueAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
      now,
    );
    expect(items.map((i) => i.chapterId)).toEqual(['b1', 'a1']);
    expect(items[0].overdueDays).toBe(3);
  });

  test('空列表 → 空复习列表', () => {
    expect(buildReviewItems([], now)).toEqual([]);
  });
});
