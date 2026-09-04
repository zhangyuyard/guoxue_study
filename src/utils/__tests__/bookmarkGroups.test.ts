/**
 * 收藏夹分组纯函数测试（P2-09 收藏分组·轻量）
 * 锁定口径：仅按首标签（tags[0]）归组、无标签 → 未分组、
 * 组顺序 = 首次出现顺序、组内保持原顺序、无空组。
 */
import {
  groupBookmarksByFirstTag,
  UNGROUPED_LABEL,
} from '@/utils/filters';
import type { Bookmark } from '@/types';

let seq = 0;

/** 构造一条收藏 */
function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  seq += 1;
  return {
    id: `bm-${seq}`,
    type: 'paragraph',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('groupBookmarksByFirstTag：按首标签分组（P2-09）', () => {
  test('无标签收藏归入「未分组」组', () => {
    const groups = groupBookmarksByFirstTag([makeBookmark({ id: 'a' })]);
    expect(groups.length).toBe(1);
    expect(groups[0].tag).toBe(UNGROUPED_LABEL);
    expect(groups[0].ungrouped).toBe(true);
    expect(groups[0].items.map((b) => b.id)).toEqual(['a']);
  });

  test('多标签收藏只按首标签归组（first-tag 口径）', () => {
    const groups = groupBookmarksByFirstTag([
      makeBookmark({ id: 'a', tags: ['名句', '难点'] }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].tag).toBe('名句');
    expect(groups[0].ungrouped).toBe(false);
    // 不得同时出现在「难点」组
    expect(groups.some((g) => g.tag === '难点')).toBe(false);
  });

  test('组顺序 = 首标签首次出现顺序；未分组按无标签首次出现位置', () => {
    const groups = groupBookmarksByFirstTag([
      makeBookmark({ id: '1', tags: ['名句'] }),
      makeBookmark({ id: '2' }),
      makeBookmark({ id: '3', tags: ['难点'] }),
      makeBookmark({ id: '4', tags: ['名句'] }),
    ]);
    expect(groups.map((g) => g.tag)).toEqual(['名句', UNGROUPED_LABEL, '难点']);
    expect(groups[0].items.map((b) => b.id)).toEqual(['1', '4']);
    expect(groups[1].items.map((b) => b.id)).toEqual(['2']);
    expect(groups[2].items.map((b) => b.id)).toEqual(['3']);
  });

  test('组内保持输入顺序', () => {
    const groups = groupBookmarksByFirstTag([
      makeBookmark({ id: 'c', tags: ['X'] }),
      makeBookmark({ id: 'a', tags: ['X'] }),
      makeBookmark({ id: 'b', tags: ['X'] }),
    ]);
    expect(groups[0].items.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  test('不产生空组（每组至少一条）', () => {
    const groups = groupBookmarksByFirstTag([
      makeBookmark({ id: '1', tags: ['X'] }),
      makeBookmark({ id: '2' }),
    ]);
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  test('空列表 → 空分组', () => {
    expect(groupBookmarksByFirstTag([])).toEqual([]);
  });

  test('tags 缺省（undefined）安全归入未分组', () => {
    const groups = groupBookmarksByFirstTag([makeBookmark({ id: 'a', tags: undefined })]);
    expect(groups.length).toBe(1);
    expect(groups[0].ungrouped).toBe(true);
  });
});
