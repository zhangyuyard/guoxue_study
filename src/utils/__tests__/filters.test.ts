/**
 * 列表筛选纯函数测试（P1-10 时间范围 / P1-13 收藏标签筛选 / P1-05 解析收藏筛选）
 */
import {
  ANALYSIS_TAG,
  filterBookmarks,
  filterByTimeRange,
  hasAnalysisBookmarks,
  timeRangeStartMs,
} from '@/utils/filters';
import type { Bookmark } from '@/types';

/** 固定「现在」：2026-08-26 12:00（周三）本地时区 */
const NOW = new Date(2026, 7, 26, 12, 0, 0);

describe('filterBookmarks：类型 × 标签 AND 语义（P1-13）', () => {
  const items: Bookmark[] = [
    { id: '1', type: 'article', tags: ['重点'], createdAt: '' },
    { id: '2', type: 'paragraph', tags: ['重点', '疑问'], createdAt: '' },
    { id: '3', type: 'paragraph', tags: [], createdAt: '' },
  ];

  test('仅类型筛选', () => {
    expect(filterBookmarks(items, 'paragraph', '').map((b) => b.id)).toEqual(['2', '3']);
  });

  test('仅标签筛选', () => {
    expect(filterBookmarks(items, '', '重点').map((b) => b.id)).toEqual(['1', '2']);
  });

  test('类型 + 标签叠加为 AND（仅命两者交集）', () => {
    expect(filterBookmarks(items, 'paragraph', '重点').map((b) => b.id)).toEqual(['2']);
  });

  test('无交集时返回空', () => {
    expect(filterBookmarks(items, 'article', '疑问')).toEqual([]);
  });

  test('标签筛选空串表示全部标签', () => {
    expect(filterBookmarks(items, '', '')).toHaveLength(3);
  });
});

describe('filterBookmarks：解析收藏独立筛选档（P1-05）', () => {
  const items: Bookmark[] = [
    { id: '1', type: 'article', tags: ['重点'], createdAt: '' },
    { id: '2', type: 'paragraph', tags: [ANALYSIS_TAG], createdAt: '' },
    { id: '3', type: 'paragraph', tags: ['疑问'], createdAt: '' },
    { id: '4', type: 'paragraph', tags: [ANALYSIS_TAG, '重点'], createdAt: '' },
  ];

  test('analysisOnly=true 仅保留带解析标签的收藏（跨 article/paragraph 类型）', () => {
    expect(filterBookmarks(items, '', '', true).map((b) => b.id)).toEqual(['2', '4']);
  });

  test('解析档与标签筛选 AND 叠加', () => {
    expect(filterBookmarks(items, '', '重点', true).map((b) => b.id)).toEqual(['4']);
    expect(filterBookmarks(items, '', '疑问', true)).toEqual([]);
  });

  test('解析档与类型筛选 AND 叠加', () => {
    expect(filterBookmarks(items, 'article', '', true)).toEqual([]);
    expect(filterBookmarks(items, 'paragraph', '', true).map((b) => b.id)).toEqual(['2', '4']);
  });

  test('analysisOnly=false 时行为与旧版完全一致（回归守卫）', () => {
    expect(filterBookmarks(items, '', ANALYSIS_TAG, false).map((b) => b.id)).toEqual(['2', '4']);
    expect(filterBookmarks(items, 'paragraph', '')).toHaveLength(3);
  });

  test('hasAnalysisBookmarks：存在/不存在解析收藏', () => {
    expect(hasAnalysisBookmarks(items)).toBe(true);
    expect(hasAnalysisBookmarks([{ id: 'x', type: 'paragraph', tags: ['疑问'], createdAt: '' }])).toBe(false);
    expect(hasAnalysisBookmarks([])).toBe(false);
  });
});

describe('filterByTimeRange：笔记时间范围筛选（P1-10）', () => {
  interface Item {
    id: string;
    time: string;
  }
  const items: Item[] = [
    { id: 'today', time: new Date(2026, 7, 26, 9, 0).toISOString() }, // 今天上午
    { id: 'monday', time: new Date(2026, 7, 24, 8, 0).toISOString() }, // 本周一
    { id: 'lastWeek', time: new Date(2026, 7, 20, 8, 0).toISOString() }, // 本周之前、本月之内
    { id: 'monthStart', time: new Date(2026, 7, 1, 8, 0).toISOString() }, // 本月 1 日
    { id: 'lastMonth', time: new Date(2026, 6, 31, 8, 0).toISOString() }, // 上月
    { id: 'invalid', time: 'not-a-date' }, // 无效时间
  ];

  test("timeRangeStartMs('all') 返回 null（不过滤）", () => {
    expect(timeRangeStartMs('all', NOW)).toBeNull();
  });

  test("'all' 恒通过（含无效时间）", () => {
    expect(filterByTimeRange(items, (i) => i.time, 'all', NOW)).toHaveLength(6);
  });

  test("'today'：仅本地今天 00:00 起", () => {
    const start = timeRangeStartMs('today', NOW);
    expect(start).toBe(new Date(2026, 7, 26).getTime());
    expect(filterByTimeRange(items, (i) => i.time, 'today', NOW).map((i) => i.id)).toEqual([
      'today',
    ]);
  });

  test("'week'：以本周一 00:00 为起点（2026-08-26 为周三）", () => {
    const start = timeRangeStartMs('week', NOW);
    expect(start).toBe(new Date(2026, 7, 24).getTime());
    expect(filterByTimeRange(items, (i) => i.time, 'week', NOW).map((i) => i.id)).toEqual([
      'today',
      'monday',
    ]);
  });

  test("'month'：本月 1 日 00:00 起（无效时间不命中）", () => {
    const start = timeRangeStartMs('month', NOW);
    expect(start).toBe(new Date(2026, 7, 1).getTime());
    expect(filterByTimeRange(items, (i) => i.time, 'month', NOW).map((i) => i.id)).toEqual([
      'today',
      'monday',
      'lastWeek',
      'monthStart',
    ]);
  });
});
