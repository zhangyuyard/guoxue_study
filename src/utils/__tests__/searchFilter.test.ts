/**
 * 高级搜索筛选纯函数测试（P2-10 searchFilter）
 * 覆盖：朝代筛选 / 体裁筛选 / 关键词范围（全部/仅书名/仅正文）/
 * 条件 AND 叠加 / 未登记元数据书籍的排除 / 无筛选透传 / 空态判定。
 */
import type { SearchResult } from '@/types';

import { anyFilterActive, filterSearchResults } from '@/utils/searchFilter';

/** 构造最小搜索结果 */
function makeResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    bookId: 'daodejing',
    bookTitle: '道德经',
    chapterId: 'daodejing-1',
    chapterTitle: '第一章',
    segmentId: 'daodejing-1-1',
    text: '道可道，非常道。',
    matchCount: 1,
    ...overrides,
  };
}

/** 样本结果：覆盖 4 部不同朝代 / 体裁的书 + 1 部用户书（无元数据） */
const SAMPLE: SearchResult[] = [
  makeResult({ bookId: 'daodejing', bookTitle: '道德经', text: '道可道，非常道。' }),
  makeResult({
    bookId: 'lunyu',
    bookTitle: '论语',
    text: '子曰：学而时习之。',
    segmentId: 'lunyu-xueer-1',
    chapterId: 'lunyu-xueer',
  }),
  makeResult({
    bookId: 'zhuangzi',
    bookTitle: '庄子',
    text: '北冥有鱼，其名为鲲。',
    segmentId: 'zhuangzi-xiao-yao-you-1',
    chapterId: 'zhuangzi-xiao-yao-you',
  }),
  makeResult({
    bookId: 'tangshi',
    bookTitle: '唐诗三百首',
    text: '床前明月光。',
    segmentId: 'tangshi-jingyesi-1',
    chapterId: 'tangshi-jingyesi',
  }),
  makeResult({
    bookId: 'user-t1',
    bookTitle: '我的摘抄',
    text: '手抄一段。',
    segmentId: 'user-t1-c1-s1',
    chapterId: 'user-t1-c1',
  }),
];

describe('filterSearchResults：朝代 / 体裁维度筛选', () => {
  test('按朝代筛选：先秦只留论语', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: ['先秦'],
      genres: [],
      scope: 'all',
      keyword: '',
    });
    expect(out.map((r) => r.bookId)).toEqual(['lunyu']);
  });

  test('按朝代多选：春秋 + 唐 留道德经与唐诗三百首', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: ['春秋', '唐'],
      genres: [],
      scope: 'all',
      keyword: '',
    });
    expect(out.map((r) => r.bookId)).toEqual(['daodejing', 'tangshi']);
  });

  test('按体裁筛选：诗文选只留唐诗三百首', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: ['诗文选'],
      scope: 'all',
      keyword: '',
    });
    expect(out.map((r) => r.bookId)).toEqual(['tangshi']);
  });

  test('未登记元数据的用户书在启用维度筛选时被排除', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: ['先秦'],
      genres: [],
      scope: 'all',
      keyword: '',
    });
    expect(out.some((r) => r.bookId === 'user-t1')).toBe(false);
  });

  test('维度未启用时用户书照常透传', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'all',
      keyword: '',
    });
    expect(out.some((r) => r.bookId === 'user-t1')).toBe(true);
  });
});

describe('filterSearchResults：关键词范围筛选', () => {
  test('scope=all 不过滤（向后兼容现状）', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'all',
      keyword: '道',
    });
    expect(out).toHaveLength(SAMPLE.length);
  });

  test('scope=title 仅保留书名含关键词的结果', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'title',
      keyword: '论语',
    });
    expect(out.map((r) => r.bookId)).toEqual(['lunyu']);
  });

  test('scope=title 书名不含关键词时结果为空', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'title',
      keyword: '北冥',
    });
    expect(out).toHaveLength(0);
  });

  test('scope=content 仅保留正文含关键词的结果', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'content',
      keyword: '北冥',
    });
    expect(out.map((r) => r.bookId)).toEqual(['zhuangzi']);
  });

  test('scope 筛选不排除无元数据的用户书', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'content',
      keyword: '手抄',
    });
    expect(out.map((r) => r.bookId)).toEqual(['user-t1']);
  });

  test('关键词为空时 scope 不参与过滤', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: [],
      genres: [],
      scope: 'title',
      keyword: '',
    });
    expect(out).toHaveLength(SAMPLE.length);
  });
});

describe('filterSearchResults：条件 AND 叠加', () => {
  test('朝代 + 体裁 + 范围同时满足才保留', () => {
    // 论语：先秦 + 经部 + 书名含「论语」 → 保留
    const hit = filterSearchResults(SAMPLE, {
      dynasties: ['先秦'],
      genres: ['经部'],
      scope: 'title',
      keyword: '论语',
    });
    expect(hit.map((r) => r.bookId)).toEqual(['lunyu']);
  });

  test('朝代匹配但体裁不匹配 → 过滤掉', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: ['先秦'],
      genres: ['子部'],
      scope: 'all',
      keyword: '',
    });
    expect(out).toHaveLength(0);
  });

  test('维度与范围叠加：先秦 + 正文含「学而」 → 仅论语', () => {
    const out = filterSearchResults(SAMPLE, {
      dynasties: ['先秦'],
      genres: [],
      scope: 'content',
      keyword: '学而',
    });
    expect(out.map((r) => r.bookId)).toEqual(['lunyu']);
  });

  test('不修改入参数组（纯函数）', () => {
    const snapshot = JSON.stringify(SAMPLE);
    filterSearchResults(SAMPLE, {
      dynasties: ['唐'],
      genres: ['诗文选'],
      scope: 'title',
      keyword: '唐诗',
    });
    expect(JSON.stringify(SAMPLE)).toBe(snapshot);
  });
});

describe('anyFilterActive', () => {
  test('默认条件 → false', () => {
    expect(anyFilterActive({ dynasties: [], genres: [], scope: 'all' })).toBe(false);
  });

  test('任一条件非默认 → true', () => {
    expect(anyFilterActive({ dynasties: ['唐'], genres: [], scope: 'all' })).toBe(true);
    expect(anyFilterActive({ dynasties: [], genres: ['经部'], scope: 'all' })).toBe(true);
    expect(anyFilterActive({ dynasties: [], genres: [], scope: 'title' })).toBe(true);
  });
});
