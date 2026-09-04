/**
 * UserBookService.deleteBook 级联清理回归测试（BugFix 孤儿数据）：
 * 删书成功后，该书的背诵进度 / 收藏 / 笔记 / 续读位置必须一并清理
 * （重导入同文件生成新 bookId，残留数据永远挂不回，属永久死数据）。
 * 用可编程 quick-sqlite mock（按 db 名分流 user_books.db / guoxue.db）+
 * 真实 store（内存列表 + SQLite 持久层双断言）：
 *   - 删书成功 → 四类数据被清，他书数据保留
 *   - 内置书拒绝删除 → 无任何级联清理副作用
 *   - 某一步清理失败 → 不阻断删除成功结果，其余步骤照常执行
 * 划线（highlights）刻意不在清理范围（阅读页按段落渲染，删书后自然
 * 不显示且无独立展示页），本套件不对其做断言。
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = {
    /** user_books.db 行 */
    userBooks: [] as Array<Record<string, unknown>>,
    /** guoxue.db segments_fts 内存行 */
    ftsRows: [] as Array<Record<string, unknown>>,
    /** guoxue.db bookmarks 内存行 */
    bookmarkRows: [] as Array<Record<string, unknown>>,
    /** guoxue.db notes 内存行 */
    noteRows: [] as Array<Record<string, unknown>>,
    /** guoxue.db recitation_progress 内存行 */
    recitationRows: [] as Array<Record<string, unknown>>,
    /** 置为某 SQL 片段时，guoxue.db 命中该片段的语句抛错（模拟清理故障） */
    failSql: null as string | null,
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
          // guoxue.db：模拟级联清理故障
          if (mockState.failSql && sql.includes(mockState.failSql)) {
            throw new Error('级联清理故障（模拟）');
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
          if (/DELETE FROM bookmarks WHERE book_id = \?/.test(sql)) {
            mockState.bookmarkRows = mockState.bookmarkRows.filter(
              (r) => r.book_id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          if (/DELETE FROM bookmarks WHERE id = \?/.test(sql)) {
            mockState.bookmarkRows = mockState.bookmarkRows.filter(
              (r) => r.id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          if (/DELETE FROM notes WHERE book_id = \?/.test(sql)) {
            mockState.noteRows = mockState.noteRows.filter(
              (r) => r.book_id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          if (/DELETE FROM notes WHERE id = \?/.test(sql)) {
            mockState.noteRows = mockState.noteRows.filter(
              (r) => r.id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          if (/DELETE FROM recitation_progress WHERE id = \?/.test(sql)) {
            mockState.recitationRows = mockState.recitationRows.filter(
              (r) => r.id !== params[0],
            );
            return { rows: { _array: [], length: 0 } };
          }
          // CREATE TABLE / ALTER TABLE / SELECT 等一律放行
          return { rows: { _array: [], length: 0 } };
        },
      };
    },
    __cascadeState: mockState,
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
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

import type { Bookmark, Book, Note, RecitationProgress } from '@/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __cascadeState } = require('react-native-quick-sqlite');
import { UserBookService } from '@/services/UserBookService';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useReaderStore } from '@/store/useReaderStore';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RNFSMock = require('react-native-fs');

const BOOK_TEXT = '第一章 山中\n空山不见人。\n\n第二章 归途\n但闻人语响。';

/** 导入用的文件内容注入（base64 分块） */
function mockFileContent(text: string): void {
  RNFSMock.__state.readResults = [Buffer.from(text, 'utf-8').toString('base64')];
}

async function importSampleBook(): Promise<Book> {
  mockFileContent(BOOK_TEXT);
  const res = await UserBookService.importBook({
    uri: 'file:///data/user/0/com.guoxue.app/cache/cascade-book.txt',
    fileName: '级联之书.txt',
    size: Buffer.byteLength(BOOK_TEXT),
  });
  expect(res.success).toBe(true);
  return (res as { data: Book }).data;
}

function makeProgress(
  bookId: string,
  chapterId: string,
  mode: RecitationProgress['mode'],
): RecitationProgress {
  return {
    id: `${bookId}:${chapterId}:${mode}`,
    bookId,
    chapterId,
    mode,
    status: 'mastered',
    progress: 100,
  };
}

function makeBookmark(id: string, bookId: string): Bookmark {
  return {
    id,
    type: 'paragraph',
    bookId,
    chapterId: 'c1',
    segmentId: 's1',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeNote(id: string, bookId: string): Note {
  return {
    id,
    bookId,
    chapterId: 'c1',
    segmentId: 's1',
    startOffset: 0,
    endOffset: 2,
    content: '批注',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 为两本书（待删书 gone / 保留书 kept）预置四类数据：内存列表 + SQLite mock 行 */
function seedCascadeData(goneId: string, keptId: string): void {
  useRecitationStore.setState({
    list: [
      makeProgress(goneId, 'c1', 'fillBlank'),
      makeProgress(keptId, 'c1', 'fillBlank'),
    ],
  });
  useBookmarkStore.setState({
    bookmarks: [makeBookmark('bm-gone', goneId), makeBookmark('bm-kept', keptId)],
  });
  useNoteStore.setState({
    notes: [makeNote('note-gone', goneId), makeNote('note-kept', keptId)],
  });
  useReaderStore.setState({ lastRead: { bookId: goneId, chapterId: 'c1' } });
  __cascadeState.recitationRows.push(
    { id: `${goneId}:c1:fillBlank`, book_id: goneId },
    { id: `${keptId}:c1:fillBlank`, book_id: keptId },
  );
  __cascadeState.bookmarkRows.push(
    { id: 'bm-gone', book_id: goneId },
    { id: 'bm-kept', book_id: keptId },
  );
  __cascadeState.noteRows.push(
    { id: 'note-gone', book_id: goneId },
    { id: 'note-kept', book_id: keptId },
  );
}

describe('UserBookService.deleteBook 级联清理（孤儿数据 BugFix）', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __cascadeState.userBooks = [];
    __cascadeState.ftsRows = [];
    __cascadeState.bookmarkRows = [];
    __cascadeState.noteRows = [];
    __cascadeState.recitationRows = [];
    __cascadeState.failSql = null;
    RNFSMock.__state.readResults = [];
    useRecitationStore.setState({ list: [], loading: false, error: undefined });
    useBookmarkStore.setState({ bookmarks: [], loading: false, error: undefined });
    useNoteStore.setState({ notes: [], loading: false, error: undefined });
    useReaderStore.setState({ lastRead: null });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('删书成功 → 四类数据级联清理（内存 + SQLite 双层），他书数据保留', async () => {
    const book = await importSampleBook();
    const keptId = 'shijing';
    seedCascadeData(book.id, keptId);

    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);

    // 背诵进度：待删书清空，他书保留
    expect(useRecitationStore.getState().list.map((r) => r.bookId)).toEqual([keptId]);
    expect(
      __cascadeState.recitationRows.some((r: Record<string, unknown>) => r.book_id === book.id),
    ).toBe(false);
    expect(
      __cascadeState.recitationRows.some((r: Record<string, unknown>) => r.book_id === keptId),
    ).toBe(true);

    // 收藏
    expect(useBookmarkStore.getState().bookmarks.map((b) => b.id)).toEqual(['bm-kept']);
    expect(
      __cascadeState.bookmarkRows.some((r: Record<string, unknown>) => r.book_id === book.id),
    ).toBe(false);
    expect(
      __cascadeState.bookmarkRows.some((r: Record<string, unknown>) => r.book_id === keptId),
    ).toBe(true);

    // 笔记
    expect(useNoteStore.getState().notes.map((n) => n.id)).toEqual(['note-kept']);
    expect(
      __cascadeState.noteRows.some((r: Record<string, unknown>) => r.book_id === book.id),
    ).toBe(false);
    expect(
      __cascadeState.noteRows.some((r: Record<string, unknown>) => r.book_id === keptId),
    ).toBe(true);

    // 续读位置：指向已删书 → 置 null
    expect(useReaderStore.getState().lastRead).toBeNull();
  });

  test('lastRead 指向他书时保留，仅清理指向待删书的位置', async () => {
    const book = await importSampleBook();
    const keptLastRead = { bookId: 'shijing', chapterId: 'c1', segmentId: 's2' };
    useRecitationStore.setState({ list: [] });
    useBookmarkStore.setState({ bookmarks: [] });
    useNoteStore.setState({ notes: [] });
    useReaderStore.setState({ lastRead: { ...keptLastRead } });

    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);
    expect(useReaderStore.getState().lastRead).toEqual(keptLastRead);
  });

  test('内置书拒绝删除 → 无任何级联清理副作用', async () => {
    const keptId = 'shijing';
    seedCascadeData('user-pending', keptId);

    const del = await UserBookService.deleteBook('lunyu');
    expect(del.success).toBe(false);
    expect(del.error).toBe('内置经典不可删除');

    // 四类数据原样保留（含指向待删书的 lastRead）
    expect(useRecitationStore.getState().list).toHaveLength(2);
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(2);
    expect(useNoteStore.getState().notes).toHaveLength(2);
    expect(useReaderStore.getState().lastRead).toEqual({
      bookId: 'user-pending',
      chapterId: 'c1',
    });
    expect(__cascadeState.recitationRows).toHaveLength(2);
    expect(__cascadeState.bookmarkRows).toHaveLength(2);
    expect(__cascadeState.noteRows).toHaveLength(2);
  });

  test('某一步清理失败（收藏）不阻断删除成功结果，其余步骤照常执行', async () => {
    const book = await importSampleBook();
    seedCascadeData(book.id, 'shijing');

    // 收藏清理步骤抛错（模拟 store 方法异常）
    const spy = jest
      .spyOn(useBookmarkStore.getState(), 'removeByBook')
      .mockImplementation(() => {
        throw new Error('收藏清理故障（模拟）');
      });

    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);
    // 书本体已删
    expect(
      __cascadeState.userBooks.some((r: Record<string, unknown>) => r.id === book.id),
    ).toBe(false);
    // 失败步骤被吞错降级（warn 日志），不影响后续步骤
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('删书级联清理失败（收藏'),
    );
    // 其余步骤照常：背诵进度（仅剩他书）/笔记已清，lastRead 已置 null
    expect(useRecitationStore.getState().list.map((r) => r.bookId)).toEqual(['shijing']);
    expect(useNoteStore.getState().notes.map((n) => n.id)).toEqual(['note-kept']);
    expect(useReaderStore.getState().lastRead).toBeNull();
    spy.mockRestore();
  });

  test('SQLite 收藏清理失败（持久层抛错）同样不阻断删除成功结果', async () => {
    const book = await importSampleBook();
    seedCascadeData(book.id, 'shijing');
    __cascadeState.failSql = 'DELETE FROM bookmarks';

    const del = await UserBookService.deleteBook(book.id);
    expect(del.success).toBe(true);
    // 持久层失败由 StorageService 捕获 → store 吞错仅设置 error（既有失败语义），
    // 内存列表保留（持久层仍有残留，下次冷启动加载后属可容忍的已知现状）
    expect(useBookmarkStore.getState().error).toBe('删除收藏失败：级联清理故障（模拟）');
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(2);
    // 其余步骤照常执行：背诵进度（仅剩他书）已清，lastRead 已置 null
    expect(useRecitationStore.getState().list.map((r) => r.bookId)).toEqual(['shijing']);
    expect(useReaderStore.getState().lastRead).toBeNull();
  });
});
