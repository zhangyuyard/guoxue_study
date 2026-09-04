/**
 * UserBookService FTS 同步回归测试（BugFix：FTS 索引与用户书导入/删除不同步）
 * 用可编程 quick-sqlite mock（按 db 名分流 user_books.db / guoxue.db）+
 * 受控 TextLibraryService 锁定完整调用链：
 *   - 导入成功 → segments_fts 同步写入该书章/段 → 同会话内搜索即可命中
 *     （无需冷启动 ensureFtsIndex 重建）
 *   - 删除成功 → segments_fts 中该书行被清除，其他书行保留
 *   - FTS 写入/清理失败不影响导入/删除的主流程结果（吞错降级）
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = {
    /** user_books.db 行 */
    userBooks: [] as Array<Record<string, unknown>>,
    /** guoxue.db segments_fts 内存行 */
    ftsRows: [] as Array<Record<string, unknown>>,
    /** 置 true 时 guoxue.db 的 segments_fts 相关 SQL 抛错（模拟 FTS 故障） */
    failFts: false,
  };
  const mockUserBookCols = ['id', 'title', 'author', 'data', 'created_at'];
  const mockFtsCols = [
    'segment_id',
    'book_id',
    'chapter_id',
    'book_title',
    'chapter_title',
    'text',
  ];
  const mockRow = (cols: string[], params: unknown[]) => {
    const row: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      row[col] = params[i] ?? null;
    });
    return row;
  };
  return {
    open: (opts: { name: string }) => {
      if (opts.name !== 'user_books.db' && opts.name !== 'guoxue.db') {
        throw new Error(`意外打开数据库：${opts.name}`);
      }
      return {
        execute: (sql: string, params: (string | number | null)[] = []) => {
          if (opts.name === 'user_books.db') {
            if (/INSERT OR REPLACE INTO user_books/.test(sql)) {
              const row = mockRow(mockUserBookCols, params);
              const idx = mockState.userBooks.findIndex((r) => r.id === row.id);
              if (idx >= 0) {
                mockState.userBooks[idx] = row;
              } else {
                mockState.userBooks.push(row);
              }
              return { rows: { _array: [], length: 0 } };
            }
            if (/DELETE FROM user_books WHERE id = \?/.test(sql)) {
              mockState.userBooks = mockState.userBooks.filter(
                (r) => r.id !== params[0],
              );
              return { rows: { _array: [], length: 0 } };
            }
            if (/SELECT data FROM user_books/.test(sql)) {
              return {
                rows: {
                  _array: mockState.userBooks.map((r) => ({ data: r.data })),
                  length: mockState.userBooks.length,
                },
              };
            }
            return { rows: { _array: [], length: 0 } };
          }
          // guoxue.db：模拟 FTS 故障
          if (/segments_fts/.test(sql) && mockState.failFts) {
            throw new Error('FTS 不可用（模拟故障）');
          }
          if (/INSERT OR REPLACE INTO segments_fts/.test(sql)) {
            const row = mockRow(mockFtsCols, params);
            const idx = mockState.ftsRows.findIndex(
              (r) => r.segment_id === row.segment_id,
            );
            if (idx >= 0) {
              mockState.ftsRows[idx] = row;
            } else {
              mockState.ftsRows.push(row);
            }
            return { rows: { _array: [], length: 0 } };
          }
          if (/SELECT DISTINCT book_id FROM segments_fts/.test(sql)) {
            const seen = new Set<string>();
            const arr: Record<string, unknown>[] = [];
            for (const r of mockState.ftsRows) {
              const id = String(r.book_id);
              if (!seen.has(id)) {
                seen.add(id);
                arr.push({ book_id: id });
              }
            }
            return { rows: { _array: arr, length: arr.length } };
          }
          if (/DELETE FROM segments_fts WHERE book_id = \?/.test(sql)) {
            mockState.ftsRows = mockState.ftsRows.filter(
              (r) => r.book_id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          // SearchService 的 instr 子串查询（SELECT … FROM segments_fts WHERE instr(text, ?)）
          if (/FROM segments_fts[\s\S]*WHERE instr\(text, \?\)/.test(sql)) {
            const kw = String(params[0] ?? '');
            const hits = mockState.ftsRows.filter((r) =>
              String(r.text).includes(kw),
            );
            return {
              rows: { _array: hits.map((r) => ({ ...r })), length: hits.length },
            };
          }
          // CREATE TABLE / ALTER TABLE 等一律放行
          return { rows: { _array: [], length: 0 } };
        },
      };
    },
    __ftsSyncState: mockState,
  };
});

/** 受控文本库：仅含注册进来的用户书（避免内置十部全量入索引拖慢用例） */
jest.mock('@/services/TextLibraryService', () => {
  const mockLibState = { userBooks: [] as unknown[] };
  const mockLib = {
    registerUserBooks: (books: Array<{ id: string; chapters: unknown[] }>) => {
      for (const b of books) {
        if (!String(b.id).startsWith('user-')) {
          return { success: false, error: `用户书籍 ID 必须以 user- 开头：${b.id}` };
        }
        if (!Array.isArray(b.chapters)) {
          return { success: false, error: `书籍章节列表无效：${b.id}` };
        }
      }
      mockLibState.userBooks = books;
      return { success: true, data: null };
    },
    getBooks: () => ({ success: true, data: mockLibState.userBooks }),
    allSegments: () => {
      const segments: unknown[] = [];
      for (const b of mockLibState.userBooks as Array<{
        chapters: Array<{ segments: unknown[] }>;
      }>) {
        for (const c of b.chapters) {
          segments.push(...c.segments);
        }
      }
      return { success: true, data: segments };
    },
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

import type { Book, SearchResult } from '@/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __ftsSyncState } = require('react-native-quick-sqlite');
import { UserBookService } from '@/services/UserBookService';
import { SearchService } from '@/services/SearchService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RNFSMock = require('react-native-fs');

/** 导入用的文件内容（含中文章节与正文，UTF-8 单块可读完） */
const BOOK_TEXT = '第一章 试炼\n山有木兮木有枝。\n\n第二章 归途\n心悦君兮君不知。';
const SEARCH_KW = '山有木兮';

/** 注入 RNFS mock 的分块读取结果（base64） */
function mockFileContent(text: string): void {
  RNFSMock.__state.readResults = [Buffer.from(text, 'utf-8').toString('base64')];
}

async function importSampleBook(): Promise<Book> {
  mockFileContent(BOOK_TEXT);
  const res = await UserBookService.importBook({
    uri: 'file:///data/user/0/com.guoxue.app/cache/import-book.txt',
    fileName: '试炼之书.txt',
    size: Buffer.byteLength(BOOK_TEXT),
  });
  expect(res.success).toBe(true);
  return (res as { data: Book }).data;
}

describe('UserBookService 与 FTS 索引同步（导入/删除）', () => {
  beforeEach(() => {
    __ftsSyncState.userBooks = [];
    __ftsSyncState.ftsRows = [];
    __ftsSyncState.failFts = false;
    RNFSMock.__state.readResults = [];
  });

  test('导入成功 → segments_fts 同步写入该书章/段（字段完整）', async () => {
    const book = await importSampleBook();

    const rows = __ftsSyncState.ftsRows.filter(
      (r: Record<string, unknown>) => r.book_id === book.id,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r: Record<string, unknown>) => r.text)).toContain(
      '山有木兮木有枝。',
    );
    expect(rows[0]).toMatchObject({
      book_id: book.id,
      book_title: '试炼之书',
      chapter_title: '第一章 试炼',
    });
  });

  test('回归锁定：导入后无需冷启动，同会话内搜索路径即命中该书', async () => {
    const book = await importSampleBook();
    // 未做任何冷启动重建（此前无搜索、ftsIndexBuilt 尚未触发）
    const res = SearchService.search(SEARCH_KW);
    expect(res.success).toBe(true);
    const hit = (res.data ?? []).find(
      (r: SearchResult) => r.bookId === book.id,
    );
    expect(hit).toBeDefined();
    expect(hit?.chapterTitle).toBe('第一章 试炼');
    expect(hit?.text).toBe('山有木兮木有枝。');
    expect(hit?.matchCount).toBe(1);
  });

  test('删除成功 → 该书 FTS 行全部清除，其他书行保留', async () => {
    const book = await importSampleBook();
    // 预置另一本书的 FTS 行（模拟内置经典已入索引）
    __ftsSyncState.ftsRows.push({
      segment_id: 'lunyu-c1-s1',
      book_id: 'lunyu',
      chapter_id: 'lunyu-c1',
      book_title: '论语',
      chapter_title: '学而',
      text: '学而时习之',
    });

    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);
    expect(
      __ftsSyncState.ftsRows.some(
        (r: Record<string, unknown>) => r.book_id === book.id,
      ),
    ).toBe(false);
    // 其他书的索引行不受影响
    expect(
      __ftsSyncState.ftsRows.some(
        (r: Record<string, unknown>) => r.book_id === 'lunyu',
      ),
    ).toBe(true);
  });

  test('FTS 写入失败不阻断导入（主流程结果不变，错误降级）', async () => {
    __ftsSyncState.failFts = true;
    mockFileContent(BOOK_TEXT);
    const res = await UserBookService.importBook({
      uri: 'file:///data/user/0/com.guoxue.app/cache/import-book2.txt',
      fileName: '降级之书.txt',
      size: Buffer.byteLength(BOOK_TEXT),
    });
    // 导入仍成功：书已持久化并注册，FTS 缺失留给冷启动增量构建补齐
    expect(res.success).toBe(true);
    expect((res as { data: Book }).data.chapters.length).toBeGreaterThan(0);
  });

  test('FTS 清理失败不阻断删除（主流程结果不变）', async () => {
    const book = await importSampleBook();
    __ftsSyncState.failFts = true;
    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);
  });

  test('内置经典不可删除（FTS 清理不越界触发）', async () => {
    const del = await UserBookService.deleteBook('lunyu');
    expect(del.success).toBe(false);
    expect(del.error).toBe('内置经典不可删除');
  });
});
