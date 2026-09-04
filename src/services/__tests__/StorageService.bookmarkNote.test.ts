/**
 * StorageService 收藏 note 字段测试（P1-12）
 * 用可编程的 quick-sqlite mock 验证：note 字段写入（INSERT 列序）、读出映射、
 * 旧数据 note 为空时兼容（undefined），以及 updateBookmarkMeta 的 UPDATE 语义。
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = { bookmarks: [] as Record<string, unknown>[] };
  /** saveBookmark INSERT 的列序 */
  const mockInsertCols = [
    'id',
    'type',
    'book_id',
    'chapter_id',
    'segment_id',
    'text',
    'tags_json',
    'note',
    'created_at',
  ];
  return {
    open: () => ({
      execute: (sql: string, params: (string | number | null)[] = []) => {
        if (/INSERT OR REPLACE INTO bookmarks/.test(sql)) {
          const row: Record<string, unknown> = {};
          mockInsertCols.forEach((col, i) => {
            row[col] = params[i] ?? null;
          });
          const idx = mockState.bookmarks.findIndex((r) => r.id === row.id);
          if (idx >= 0) {
            mockState.bookmarks[idx] = row;
          } else {
            mockState.bookmarks.push(row);
          }
          return { rows: { _array: [], length: 0 } };
        }
        if (/SELECT \* FROM bookmarks/.test(sql)) {
          return {
            rows: {
              _array: mockState.bookmarks.map((r) => ({ ...r })),
              length: mockState.bookmarks.length,
            },
          };
        }
        if (/UPDATE bookmarks SET tags_json = \?, note = \?/.test(sql)) {
          const row = mockState.bookmarks.find((r) => r.id === params[2]);
          if (row) {
            row.tags_json = params[0];
            row.note = params[1];
          }
          return { rows: { _array: [], length: 0 } };
        }
        return { rows: { _array: [], length: 0 } };
      },
    }),
  };
});

import {
  StorageService,
  initDatabase,
  saveBookmark,
  getBookmarks,
  updateBookmarkMeta,
} from '@/services/StorageService';
import type { Bookmark } from '@/types';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'bm-1',
    type: 'paragraph',
    bookId: 'lunyu',
    chapterId: 'lunyu-xueer',
    segmentId: 'lunyu-xueer-1',
    text: '学而时习之',
    tags: ['重点'],
    note: '常考句',
    createdAt: '2026-08-26T02:00:00.000Z',
    ...overrides,
  };
}

describe('StorageService 收藏 note 字段（P1-12）', () => {
  beforeEach(() => {
    initDatabase();
  });

  test('saveBookmark 写入 note，getBookmarks 读出 note 与 tags', () => {
    expect(saveBookmark(makeBookmark()).success).toBe(true);

    const res = getBookmarks();
    expect(res.success).toBe(true);
    const list = res.data ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].note).toBe('常考句');
    expect(list[0].tags).toEqual(['重点']);
    expect(list[0].type).toBe('paragraph');
  });

  test('旧数据兼容：note 为空（null）读出为 undefined，不崩溃', () => {
    expect(saveBookmark(makeBookmark({ note: undefined })).success).toBe(true);

    const list = getBookmarks().data ?? [];
    expect(list[0].note).toBeUndefined();
  });

  test('updateBookmarkMeta 同时更新标签与备注', () => {
    saveBookmark(makeBookmark());

    expect(updateBookmarkMeta('bm-1', ['复习', '疑问'], '改为新备注').success).toBe(true);
    const row = (getBookmarks().data ?? [])[0];
    expect(row.tags).toEqual(['复习', '疑问']);
    expect(row.note).toBe('改为新备注');
  });

  test('StorageService 聚合导出包含 updateBookmarkMeta', () => {
    expect(typeof StorageService.updateBookmarkMeta).toBe('function');
  });
});
