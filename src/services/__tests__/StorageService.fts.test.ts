/**
 * StorageService FTS 全文索引测试（BugFix：FTS 与用户书导入/删除不同步）
 * 用可编程 quick-sqlite mock + 受控 TextLibraryService 数据锁定：
 *   - buildFtsRows 字段映射（含空章节、超长段不特殊处理的一致性）
 *   - ensureFtsIndex 增量构建（已入索引的书跳过，不再全量重插）
 *   - ensureFtsIndex 死索引自愈（不在文本库中的 book_id 残留行被清除）
 *   - upsertFtsForBook / deleteFtsForBook 的 SQL 语义与幂等性
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = {
    /** segments_fts 内存行（模拟 FTS5 表内容） */
    ftsRows: [] as Array<Record<string, unknown>>,
    /** segments_fts 单行 INSERT 调用计数（断言增量构建跳过已入索引书） */
    insertCalls: 0,
  };
  /** FTS INSERT 列序（与 StorageService.FTS_INSERT_SQL 一致） */
  const mockFtsCols = [
    'segment_id',
    'book_id',
    'chapter_id',
    'book_title',
    'chapter_title',
    'text',
  ];
  return {
    open: () => ({
      execute: (sql: string, params: (string | number | null)[] = []) => {
        if (/INSERT OR REPLACE INTO segments_fts/.test(sql)) {
          mockState.insertCalls += 1;
          const row: Record<string, unknown> = {};
          mockFtsCols.forEach((col, i) => {
            row[col] = params[i] ?? null;
          });
          // FTS5 虚拟表无主键，按 segment_id 去重即可模拟 REPLACE 语义
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
          const before = mockState.ftsRows.length;
          mockState.ftsRows = mockState.ftsRows.filter(
            (r) => r.book_id !== params[0],
          );
          return {
            rows: { _array: [], length: before - mockState.ftsRows.length },
          };
        }
        // CREATE TABLE / ALTER TABLE 等一律放行
        return { rows: { _array: [], length: 0 } };
      },
    }),
    __ftsState: mockState,
  };
});

const mockBooks: import('@/types').Book[] = [
  {
    id: 'lunyu',
    title: '论语',
    author: '',
    category: 'jing',
    description: '',
    chapters: [
      {
        id: 'lunyu-c1',
        bookId: 'lunyu',
        title: '学而',
        order: 1,
        segments: [
          { id: 'lunyu-c1-s1', chapterId: 'lunyu-c1', order: 1, text: '学而时习之' },
          { id: 'lunyu-c1-s2', chapterId: 'lunyu-c1', order: 2, text: '有朋自远方来' },
        ],
      },
      {
        id: 'lunyu-c2',
        bookId: 'lunyu',
        title: '为政',
        order: 2,
        segments: [
          { id: 'lunyu-c2-s1', chapterId: 'lunyu-c2', order: 1, text: '温故而知新' },
        ],
      },
    ],
  },
  {
    id: 'daodejing',
    title: '道德经',
    author: '',
    category: 'jing',
    description: '',
    chapters: [
      {
        id: 'daodejing-c1',
        bookId: 'daodejing',
        title: '第一章',
        order: 1,
        segments: [
          { id: 'daodejing-c1-s1', chapterId: 'daodejing-c1', order: 1, text: '道可道非常道' },
        ],
      },
    ],
  },
];

jest.mock('@/services/TextLibraryService', () => ({
  TextLibraryService: {
    getBooks: () => ({ success: true, data: mockBooks }),
    allSegments: () => {
      const segments: import('@/types').TextSegment[] = [];
      for (const b of mockBooks) {
        for (const c of b.chapters) {
          segments.push(...c.segments);
        }
      }
      return { success: true, data: segments };
    },
  },
}));

import type { Book } from '@/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __ftsState } = require('react-native-quick-sqlite');
import {
  StorageService,
  initDatabase,
  ensureFtsIndex,
  upsertFtsForBook,
  upsertFtsForBookChunked,
  deleteFtsForBook,
  buildFtsRows,
} from '@/services/StorageService';

/** 构造测试书（含指定章节/段落文本） */
function makeBook(
  id: string,
  title: string,
  chapters: Array<{ id: string; title: string; segs: string[] }>,
): Book {
  return {
    id,
    title,
    author: '',
    category: 'user',
    description: '',
    chapters: chapters.map((c, ci) => ({
      id: c.id,
      bookId: id,
      title: c.title,
      order: ci + 1,
      segments: c.segs.map((t, si) => ({
        id: `${c.id}-s${si + 1}`,
        chapterId: c.id,
        order: si + 1,
        text: t,
      })),
    })),
  };
}

describe('buildFtsRows（待插行构造纯函数）', () => {
  test('字段映射：segment/book/chapter 逐层对应，书名/章名冗余列正确', () => {
    const book = makeBook('user-x', '测试之书', [
      { id: 'user-x-c1', title: '第一章', segs: ['内容甲', '内容乙'] },
      { id: 'user-x-c2', title: '第二章', segs: ['内容丙'] },
    ]);
    const rows = buildFtsRows(book);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      segmentId: 'user-x-c1-s1',
      bookId: 'user-x',
      chapterId: 'user-x-c1',
      bookTitle: '测试之书',
      chapterTitle: '第一章',
      text: '内容甲',
    });
    expect(rows[1].chapterTitle).toBe('第一章');
    expect(rows[2]).toEqual({
      segmentId: 'user-x-c2-s1',
      bookId: 'user-x',
      chapterId: 'user-x-c2',
      bookTitle: '测试之书',
      chapterTitle: '第二章',
      text: '内容丙',
    });
  });

  test('空章节（无段落）不产生行；全书无段为空数组', () => {
    const empty = makeBook('user-empty', '空书', [
      { id: 'user-empty-c1', title: '第一章', segs: [] },
    ]);
    expect(buildFtsRows(empty)).toEqual([]);

    const noChapters = makeBook('user-none', '无章书', []);
    expect(buildFtsRows(noChapters)).toEqual([]);
  });

  test('空段与超长段不做特殊处理（与全量构建行为一致：原样入行）', () => {
    const longText = '道'.repeat(6000); // 超过导入层 2500 上限的长度
    const book = makeBook('user-long', '长文书', [
      { id: 'user-long-c1', title: '全文', segs: [longText, ''] },
    ]);
    const rows = buildFtsRows(book);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe(longText); // 原样保留，不切分
    expect(rows[1].text).toBe(''); // 空段照常成行
  });
});

describe('ensureFtsIndex（增量构建 + 死索引自愈）', () => {
  beforeEach(() => {
    // 防止增量用例 push 的新书泄漏到其他用例
    const idx = mockBooks.findIndex((b) => b.id === 'mengzi-new');
    if (idx >= 0) {
      mockBooks.splice(idx, 1);
    }
    __ftsState.ftsRows = [];
    __ftsState.insertCalls = 0;
    initDatabase();
  });

  test('首次调用全量插入所有书；再次调用不再重插（insertCalls 不增）', () => {
    expect(ensureFtsIndex().success).toBe(true);
    expect(__ftsState.insertCalls).toBe(4); // lunyu 3 段 + daodejing 1 段
    expect(__ftsState.ftsRows).toHaveLength(4);

    const callsBefore = __ftsState.insertCalls;
    expect(ensureFtsIndex().success).toBe(true);
    expect(__ftsState.insertCalls).toBe(callsBefore); // 全部书已入索引，零插入
    expect(__ftsState.ftsRows).toHaveLength(4);
  });

  test('增量：文本库新增书后仅补新书，已入索引的书跳过', () => {
    expect(ensureFtsIndex().success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(4);

    const before = __ftsState.insertCalls;
    mockBooks.push(
      makeBook('mengzi-new', '孟子', [
        { id: 'mengzi-new-c1', title: '梁惠王', segs: ['王何必曰利'] },
      ]),
    );
    expect(ensureFtsIndex().success).toBe(true);
    // 仅插新书的 1 段
    expect(__ftsState.insertCalls).toBe(before + 1);
    expect(__ftsState.ftsRows).toHaveLength(5);
    expect(
      __ftsState.ftsRows.some((r) => r.book_id === 'mengzi-new'),
    ).toBe(true);
    // 原有书行未被触碰（segment 集合不变）
    const segIds = __ftsState.ftsRows.map((r) => r.segment_id).sort();
    expect(segIds).toEqual([
      'daodejing-c1-s1',
      'lunyu-c1-s1',
      'lunyu-c1-s2',
      'lunyu-c2-s1',
      'mengzi-new-c1-s1',
    ]);
  });

  test('死索引自愈：不在文本库中的 book_id 残留行被清除', () => {
    expect(ensureFtsIndex().success).toBe(true);
    // 模拟历史残留：已删用户书的死索引（当前文本库中无此书）
    __ftsState.ftsRows.push({
      segment_id: 'user-dead-c1-s1',
      book_id: 'user-dead',
      chapter_id: 'user-dead-c1',
      book_title: '已删除的书',
      chapter_title: '第一章',
      text: '死索引内容',
    });
    expect(ensureFtsIndex().success).toBe(true);
    expect(__ftsState.ftsRows.some((r) => r.book_id === 'user-dead')).toBe(
      false,
    );
    // 库内书不受影响
    expect(__ftsState.ftsRows).toHaveLength(4);
  });
});

describe('upsertFtsForBook / deleteFtsForBook', () => {
  beforeEach(() => {
    __ftsState.ftsRows = [];
    __ftsState.insertCalls = 0;
    initDatabase();
  });

  test('upsertFtsForBook 单本书入索引，重复调用幂等', () => {
    const book = makeBook('user-a', '甲书', [
      { id: 'user-a-c1', title: '第一章', segs: ['甲书内容'] },
    ]);
    expect(upsertFtsForBook(book).success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(1);
    expect(__ftsState.ftsRows[0]).toMatchObject({
      segment_id: 'user-a-c1-s1',
      book_id: 'user-a',
      book_title: '甲书',
      text: '甲书内容',
    });

    expect(upsertFtsForBook(book).success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(1); // REPLACE 不产生重复行
  });

  test('deleteFtsForBook 按 bookId 精确清理，其他书行保留', () => {
    expect(ensureFtsIndex().success).toBe(true);
    const book = makeBook('user-b', '乙书', [
      { id: 'user-b-c1', title: '全文', segs: ['乙书一', '乙书二'] },
    ]);
    expect(upsertFtsForBook(book).success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(6);

    expect(deleteFtsForBook('user-b').success).toBe(true);
    expect(__ftsState.ftsRows.some((r) => r.book_id === 'user-b')).toBe(false);
    expect(__ftsState.ftsRows).toHaveLength(4);
    expect(__ftsState.ftsRows.every((r) => r.book_id !== 'user-b')).toBe(true);
  });

  test('聚合导出包含新增 FTS API', () => {
    expect(typeof StorageService.upsertFtsForBook).toBe('function');
    expect(typeof StorageService.deleteFtsForBook).toBe('function');
    expect(typeof StorageService.buildFtsRows).toBe('function');
    expect(typeof StorageService.ensureFtsIndex).toBe('function');
  });
});

describe('upsertFtsForBookChunked（分片异步索引：初次启动 UI 无响应 BugFix）', () => {
  beforeEach(() => {
    __ftsState.ftsRows = [];
    __ftsState.insertCalls = 0;
    initDatabase();
  });

  test('写入结果与同步版一致（全部段落入索引，字段映射相同）', async () => {
    const book = makeBook('chunky-a', '分片甲书', [
      { id: 'chunky-a-c1', title: '第一章', segs: ['甲一分片'] },
      { id: 'chunky-a-c2', title: '第二章', segs: ['甲二分片', '甲三生辉'] },
    ]);
    const res = await upsertFtsForBookChunked(book, { chunkChapters: 1 });
    expect(res.success).toBe(true);
    const rows = __ftsState.ftsRows.filter((r: { book_id: unknown }) => r.book_id === 'chunky-a');
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { segment_id: unknown }) => r.segment_id)).toEqual([
      'chunky-a-c1-s1',
      'chunky-a-c2-s1',
      'chunky-a-c2-s2',
    ]);
  });

  test('重复调用幂等（INSERT OR REPLACE 不产生重复行）', async () => {
    const book = makeBook('chunky-b', '分片乙书', [
      { id: 'chunky-b-c1', title: '第一章', segs: ['乙一分片'] },
    ]);
    await upsertFtsForBookChunked(book, { chunkChapters: 1 });
    await upsertFtsForBookChunked(book, { chunkChapters: 1 });
    expect(__ftsState.ftsRows).toHaveLength(1);
  });

  test('shouldPause 挂起：门闩解除后断点续写，最终完整入索引', async () => {
    const book = makeBook('chunky-c', '暂停书', [
      { id: 'chunky-c-c1', title: '一', segs: ['丙一分片'] },
      { id: 'chunky-c-c2', title: '二', segs: ['丙二分片'] },
    ]);
    let paused = true;
    // 门闩 300ms 后解除：片间检查挂起（250ms 轮询），解除后完成剩余片
    setTimeout(() => {
      paused = false;
    }, 300);
    const res = await upsertFtsForBookChunked(book, {
      chunkChapters: 1,
      shouldPause: () => paused,
    });
    expect(res.success).toBe(true);
    const rows = __ftsState.ftsRows.filter((r: { book_id: unknown }) => r.book_id === 'chunky-c');
    expect(rows).toHaveLength(2);
  });

  test('聚合导出包含分片版', () => {
    expect(typeof StorageService.upsertFtsForBookChunked).toBe('function');
  });
});
