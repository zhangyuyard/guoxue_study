/**
 * StorageService FTS 全文索引测试（BugFix：FTS 与用户书导入/删除不同步）
 * 用可编程 quick-sqlite mock + 受控 TextLibraryService 数据锁定：
 *   - buildFtsRows 字段映射（含空章节、超长段不特殊处理的一致性）
 *   - ensureFtsIndex 增量构建（已入索引的书跳过，不再全量重插）
 *   - ensureFtsIndex 死索引自愈（不在文本库中的 book_id 残留行被清除）
 *   - upsertFtsForBook / deleteFtsForBook 的 SQL 语义与幂等性
 *
 * 【#29】FTS 语句面的 mock 改为共享的**保真**实现（`./fts5Mock.helper`）：
 *  - 按语句首词路由（SELECT / INSERT / DELETE）⇒ `clearFtsRidMapForBook` 的
 *    「按书清映射」分支**可达**（旧内联 mock 因未锚定语句类型而永不可达）；
 *  - rowid 自动分配 = 真机语义 `max(现存 rowid) + 1`（含复用被释放 rowid）⇒
 *    「映射残留撞车 ⇒ 老书重写顶掉新书行」这一缺陷在 mock 里**可表示**。
 */
jest.mock('@/services/sqliteClient', () => {
  const { createFts5Mock, execFts5Sql } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./fts5Mock.helper') as typeof import('./fts5Mock.helper');
  const mockState = createFts5Mock();
  return {
    open: () => ({
      execute: (sql: string, params: (string | number | null)[] = []) => {
        const handled = execFts5Sql(mockState, sql, params);
        if (handled) {
          return handled;
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
const { __ftsState } = require('@/services/sqliteClient');
import {
  pushFtsRow,
  resetFts5Mock,
  ridMapEntriesFor,
  ridMapViolations,
} from './fts5Mock.helper';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  StorageService,
  initDatabase,
  ensureFtsIndex,
  upsertFtsForBook,
  upsertFtsForBookChunked,
  upsertFtsForChapter,
  isBookFullyIndexedInFts,
  isBookIndexedInFts,
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
    resetFts5Mock(__ftsState);
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
    // 模拟历史残留：已删用户书的死索引（当前文本库中无此书）。
    // 用 pushFtsRow 预置：真机上老行必然占有 rowid（且**无映射**），mock 同构。
    pushFtsRow(__ftsState, {
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
    // 【#29】死索引自愈同样必须清映射（生产不变量：映射 ⊆ 现存行）
    expect(ridMapViolations(__ftsState)).toEqual([]);
  });
});

describe('upsertFtsForBook / deleteFtsForBook', () => {
  beforeEach(() => {
    resetFts5Mock(__ftsState);
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
    // 【#29】整书写入登记 / 复用稳定 rowid，且不产生孤儿映射
    expect(__ftsState.ftsRidMap.get('user-a-c1-s1')).toBe(
      __ftsState.ftsRows[0].rowid,
    );
    expect(ridMapViolations(__ftsState)).toEqual([]);
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
    // 【#29】删书必须同步清该书的 rowid 映射：这是「按书清映射」
    //（`clearFtsRidMapForBook`）分支的可达性断言——旧内联 mock 因分支误路由
    // 而永不可达，等价于在 mock 里植入「删书不清映射」（M-A）却仍全绿。
    expect(ridMapEntriesFor(__ftsState, ['user-b-c1-s1', 'user-b-c1-s2'])).toEqual(
      [],
    );
    // 生产不变量：映射里的每个 rid 都指向一条现存行
    expect(ridMapViolations(__ftsState)).toEqual([]);
    // 其他书的映射未受影响
    expect(ridMapEntriesFor(__ftsState, ['lunyu-c1-s1'])).toEqual([
      'lunyu-c1-s1',
    ]);
  });

  test('【#29】删书必须清该书的 rowid 映射（不变量：映射 ⊆ 现存行）', () => {
    const book = makeBook('user-gone', '已删之书', [
      { id: 'user-gone-c1', title: '第一章', segs: ['甲', '乙'] },
    ]);
    for (const ch of book.chapters) {
      expect(upsertFtsForChapter(book, ch).success).toBe(true);
    }
    // 写入后映射已登记（本书 2 段）
    expect(
      ridMapEntriesFor(__ftsState, ['user-gone-c1-s1', 'user-gone-c1-s2']),
    ).toEqual(['user-gone-c1-s1', 'user-gone-c1-s2']);
    expect(ridMapViolations(__ftsState)).toEqual([]);

    expect(deleteFtsForBook('user-gone').success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(0);

    // ★ 核心断言：删书（删行）必须**同步清映射** —— 这是
    // `clearFtsRidMapForBook`（按书清映射）分支的**可达性**断言。
    // 旧内联 mock 的分支误路由让该 DELETE 永不被执行 ⇒ 此处恒为「Received 2 项」，
    // 即在 mock 内等价于「删书不清映射」（M-A）已生效却仍全绿（零检测力）。
    expect(
      ridMapEntriesFor(__ftsState, ['user-gone-c1-s1', 'user-gone-c1-s2']),
    ).toEqual([]);
    expect(ridMapViolations(__ftsState)).toEqual([]);
  });

  test('【#29】删书释放的 rowid 被新书复用后，老书重写不得顶掉新书的行', () => {
    const oldBook = makeBook('user-old', '老书', [
      { id: 'user-old-c1', title: '第一章', segs: ['老书甲', '老书乙'] },
    ]);
    const newBook = makeBook('user-new', '新书', [
      { id: 'user-new-c1', title: '第一章', segs: ['新书丙', '新书丁'] },
    ]);
    // 老书章级写入（真机常态：装配 READY_FULL 即写）⇒ 自动拿到 rowid 1、2
    for (const ch of oldBook.chapters) {
      expect(upsertFtsForChapter(oldBook, ch).success).toBe(true);
    }
    expect(__ftsState.ftsRows.map((r) => r.rowid)).toEqual([1, 2]);

    // 删书：清映射 + 清行 ⇒ rowid 1、2 被释放
    expect(deleteFtsForBook('user-old').success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(0);

    // 新书自动分配：真机语义 `max(现存 rowid) + 1` ⇒ **复用** 1、2
    for (const ch of newBook.chapters) {
      expect(upsertFtsForChapter(newBook, ch).success).toBe(true);
    }

    // 老书恢复 / 重导入：不得用「记忆 rowid」把新书的行顶掉（静默丢段）。
    // ⚠️ 本用例**只放行为断言**（不夹映射探针）：抓的是**可观测症状**——别人的行
    // 消失。症状只有在 mock 的 rowid 分配与真机一致（复用被释放的 rowid）时才
    // **可能**出现；旧内联 mock 的 `lastRid += 1` 单调不复用 ⇒ 老书会在**空位**
    // 重新落行、新书行毫发无损 ⇒ 症状结构上不可表示（见紧随其后的复用断言）。
    for (const ch of oldBook.chapters) {
      expect(upsertFtsForChapter(oldBook, ch).success).toBe(true);
    }
    expect(
      __ftsState.ftsRows
        .filter((r) => r.book_id === 'user-new')
        .map((r) => r.segment_id)
        .sort(),
    ).toEqual(['user-new-c1-s1', 'user-new-c1-s2']);
    expect(
      __ftsState.ftsRows
        .filter((r) => r.book_id === 'user-old')
        .map((r) => r.segment_id)
        .sort(),
    ).toEqual(['user-old-c1-s1', 'user-old-c1-s2']);
    expect(__ftsState.ftsRows).toHaveLength(4);

    // 分配语义回归钉：新书确实**复用了**被释放的 rowid 1、2
    //（旧 mock 的 `lastRid += 1` 会让这里读到 3、4）
    expect(
      __ftsState.ftsRows
        .filter((r) => r.book_id === 'user-new')
        .map((r) => r.rowid)
        .sort(),
    ).toEqual([1, 2]);

    // 不变量：全流程结束后映射里的每个 rid 都指向一条现存行；
    // 老书被重写后其段映射**合法地**重新登记（指向新落的 rowid 3、4）
    expect(ridMapViolations(__ftsState)).toEqual([]);
    expect(
      __ftsState.ftsRows
        .filter((r) => r.book_id === 'user-old')
        .map((r) => __ftsState.ftsRidMap.get(r.segment_id))
        .sort(),
    ).toEqual([3, 4]);
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
    resetFts5Mock(__ftsState);
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

describe('r38 T03：FTS 章级增量（upsertFtsForChapter）与计数式书级判据', () => {
  const storageSrc = readFileSync(
    resolve(__dirname, '../StorageService.ts'),
    'utf8',
  );

  /** 截取某导出函数源码（到下一个 `\nexport ` 为止，含自身不含后继文档注释） */
  function extractExport(header: string, fallbackLen = 1000): string {
    const start = storageSrc.indexOf(header);
    if (start < 0) {
      return '';
    }
    const next = storageSrc.indexOf('\nexport ', start + 1);
    return next > start ? storageSrc.slice(start, next) : storageSrc.slice(start, start + fallbackLen);
  }

  beforeEach(() => {
    resetFts5Mock(__ftsState);
    initDatabase();
  });

  test('单章 upsert 只插该章行，其余章零动作', () => {
    const book = makeBook('inc-a', '增量甲书', [
      { id: 'inc-a-c1', title: '第一章', segs: ['甲一'] },
      { id: 'inc-a-c2', title: '第二章', segs: ['甲二之一', '甲二之二'] },
      { id: 'inc-a-c3', title: '第三章', segs: ['甲三'] },
    ]);
    const res = upsertFtsForChapter(book, book.chapters[1]);
    expect(res.success).toBe(true);
    expect(__ftsState.insertCalls).toBe(2); // 只写第二章的 2 段
    expect(__ftsState.ftsRows).toHaveLength(2);
    const rows = __ftsState.ftsRows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.segment_id)).toEqual([
      'inc-a-c2-s1',
      'inc-a-c2-s2',
    ]);
    expect(rows.every((r) => r.chapter_id === 'inc-a-c2')).toBe(true);
    // 字段映射与整书路径同口径（书名/章名冗余列 + 段文本）
    expect(rows[0]).toMatchObject({
      book_id: 'inc-a',
      chapter_id: 'inc-a-c2',
      book_title: '增量甲书',
      chapter_title: '第二章',
      text: '甲二之一',
    });
  });

  test('重复写同章幂等（REPLACE 不产生重复行，他章行不被触碰）', () => {
    const book = makeBook('inc-b', '增量乙书', [
      { id: 'inc-b-c1', title: '第一章', segs: ['乙一'] },
      { id: 'inc-b-c2', title: '第二章', segs: ['乙二'] },
    ]);
    expect(upsertFtsForChapter(book, book.chapters[0]).success).toBe(true);
    expect(upsertFtsForChapter(book, book.chapters[1]).success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(2);
    // 同一章重复写（重水合 / 跳章重跑会重复触发）：语句照发，行数不增
    expect(upsertFtsForChapter(book, book.chapters[0]).success).toBe(true);
    expect(__ftsState.insertCalls).toBe(3);
    expect(__ftsState.ftsRows).toHaveLength(2);
    const rows = __ftsState.ftsRows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.segment_id).sort()).toEqual([
      'inc-b-c1-s1',
      'inc-b-c2-s1',
    ]);
    expect(rows.find((r) => r.segment_id === 'inc-b-c2-s1')).toMatchObject({
      text: '乙二',
      book_title: '增量乙书',
    });
  });

  test('空章（无段落）零动作：不产生行、不触发 INSERT', () => {
    const book = makeBook('inc-c', '增量丙书', [
      { id: 'inc-c-c1', title: '空章', segs: [] },
      { id: 'inc-c-c2', title: '非空章', segs: ['丙二'] },
    ]);
    const before = __ftsState.insertCalls;
    expect(upsertFtsForChapter(book, book.chapters[0]).success).toBe(true);
    expect(__ftsState.insertCalls).toBe(before); // 空章不入库（与 buildFtsRows 口径一致）
    expect(__ftsState.ftsRows).toHaveLength(0);
    // 同书非空章不受影响（章级路径相互独立）
    expect(upsertFtsForChapter(book, book.chapters[1]).success).toBe(true);
    expect(__ftsState.ftsRows).toHaveLength(1);
    expect(
      (__ftsState.ftsRows as Array<Record<string, unknown>>)[0].segment_id,
    ).toBe('inc-c-c2-s1');
  });

  test('章级写入复用同一行构造函数，且不做全书字数上限判定', () => {
    // FTS_MAX_BOOK_CHARS 是「整本解析代价」守卫；章级写入单章代价恒定，
    // 引入整本字数门槛只会制造新的静默缺失（已装配章必须可搜）
    const body = extractExport('export function upsertFtsForChapter', 1200);
    expect(body).not.toBe('');
    expect(body).toMatch(/buildAndInsertChapterFts\(instance, book, chapter\);/);
    expect(body).not.toMatch(/FTS_MAX_BOOK_CHARS/);
    expect(body).not.toMatch(/console\.warn/);
    // 复用是唯一路径：不得自行拼 INSERT（口径分叉即字段映射漂移）
    expect(body).not.toMatch(/INSERT OR REPLACE INTO segments_fts/);
  });

  test('isBookFullyIndexedInFts 是计数式判据（章级增量下存在判据会误判整本已索引）', () => {
    const book = makeBook('full-a', '整本甲书', [
      { id: 'full-a-c1', title: '一', segs: ['甲一'] },
      { id: 'full-a-c2', title: '二', segs: ['甲二'] },
      { id: 'full-a-c3', title: '三', segs: ['甲三'] },
    ]);
    expect(upsertFtsForChapter(book, book.chapters[0]).success).toBe(true);
    // 只索引 1 章：存在判据为真，计数判据必须为假
    //（否则整书兜底被永久跳过 → 真·缺章永远搜不到）
    expect(isBookIndexedInFts('full-a')).toBe(true);
    expect(isBookFullyIndexedInFts('full-a', 3)).toBe(false);

    expect(upsertFtsForChapter(book, book.chapters[1]).success).toBe(true);
    expect(isBookFullyIndexedInFts('full-a', 3)).toBe(false);

    expect(upsertFtsForChapter(book, book.chapters[2]).success).toBe(true);
    expect(isBookFullyIndexedInFts('full-a', 3)).toBe(true); // index === total
    // 超集（残留多余章行）亦视为已覆盖
    expect(isBookFullyIndexedInFts('full-a', 2)).toBe(true);
    // 他书行不计入本书
    expect(isBookFullyIndexedInFts('full-b', 3)).toBe(false);
  });

  test('isBookFullyIndexedInFts 非法入参 → false（调用方会尝试补写，重复劳动无害）', () => {
    expect(isBookFullyIndexedInFts('', 3)).toBe(false);
    expect(isBookFullyIndexedInFts('full-c', 0)).toBe(false);
    expect(isBookFullyIndexedInFts('full-c', -1)).toBe(false);
    expect(isBookFullyIndexedInFts('full-c', Number.NaN)).toBe(false);
    expect(
      isBookFullyIndexedInFts('full-c', Number.POSITIVE_INFINITY),
    ).toBe(false);
  });

  test('isBookIndexedInFts 既有语义一字未改（存在即真，队列幂等跳过以它为准）', () => {
    const book = makeBook('exist-a', '存在甲书', [
      { id: 'exist-a-c1', title: '一', segs: ['存在一'] },
      { id: 'exist-a-c2', title: '二', segs: ['存在二'] },
    ]);
    expect(isBookIndexedInFts('exist-a')).toBe(false); // 未写任何章
    expect(upsertFtsForChapter(book, book.chapters[0]).success).toBe(true);
    expect(isBookIndexedInFts('exist-a')).toBe(true); // 写了 1 章即真（语义冻结）

    const body = extractExport('export function isBookIndexedInFts', 800);
    expect(body).not.toBe('');
    expect(body).toMatch(
      /'SELECT 1 AS hit FROM segments_fts WHERE book_id = \? LIMIT 1'/,
    );
    expect(body).toMatch(/return rows\.length > 0;/);
    // 签名与实现均未被计数式判据污染
    expect(body).toMatch(
      /export function isBookIndexedInFts\(bookId: string\): boolean \{/,
    );
    expect(body).not.toMatch(/COUNT\(DISTINCT/);
  });

  test('聚合导出包含章级写入与计数判据两个新 API', () => {
    expect(typeof StorageService.upsertFtsForChapter).toBe('function');
    expect(typeof StorageService.isBookFullyIndexedInFts).toBe('function');
    expect(typeof StorageService.isBookIndexedInFts).toBe('function');
  });
});
