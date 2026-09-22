/**
 * 【#16】幂等 upsert 的**端到端真实验证**：生产代码 × 真实 SQLite/FTS5。
 *
 * 与 `fts5RealSqliteSemantics.test.ts` 的分工：
 *  - 那个文件把 SQL 语句**逐字从源码抽取**后手写执行，锁的是「语句语义」；
 *  - 本文件把 `react-native-quick-sqlite` 换成 **better-sqlite3 适配器**，直接调用
 *    **生产函数**（`upsertFtsForChapter` / `upsertFtsForBook` / `isBookFullyIndexedInFts`
 *    / `deleteFtsForBook`），在真实 SQLite 上验证端到端行为。
 *
 * 为什么必须补这一层：#14 的教训是「mock 全绿 ≠ 真机正确」——旧 mock 自作主张地
 * 按 `segment_id` 去重，把「`INSERT OR REPLACE` 在 FTS5 上退化为普通 INSERT」这一
 * 真实缺陷测成了正确。本文件用真数据库跑真代码，杜绝此类「希望式 mock」。
 *
 * 覆盖（#16 验收）：
 *  ① 同章反复写入 ⇒ 行数恒等于段数（真幂等），检索命中数不重复；
 *  ② 重写覆盖**原位** ⇒ rowid 不变 ⇒ 检索顺序（`ORDER BY rowid ASC` = 首次写入序
 *     = 书序/章序，与内存回退同序）逐字不变；
 *  ③ 内容更新 ⇒ 同段 1 行且为新内容；
 *  ④ 整书写入 = **替换**语义 ⇒ 清理历史残留（重复行/幽灵行）；
 *  ⑤ 不存在幽灵行：写入章后，库中该书的行集合 == 该书的段集合。
 */
jest.mock('react-native-quick-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const real = new Database(':memory:');
  const adapter = {
    __real: real,
    execute: (sql: string, params: (string | number | null)[] = []) => {
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
        const rows = real.prepare(sql).all(...(params as never[])) as Record<
          string,
          unknown
        >[];
        return { rows: { _array: rows, length: rows.length } };
      }
      if (params.length === 0) {
        // DDL 常量可能含多条语句（建表 + 建索引）⇒ 走 exec（quick-sqlite 同语义）
        real.exec(sql);
      } else {
        real.prepare(sql).run(...(params as never[]));
      }
      return { rows: { _array: [], length: 0 } };
    },
  };
  return { open: () => adapter, __adapter: adapter };
});

jest.mock('@/services/TextLibraryService', () => ({
  TextLibraryService: {
    getBooks: () => ({ success: true, data: [] }),
    allSegments: () => ({ success: true, data: [] }),
    isUserBook: () => false,
  },
}));

import type { Book } from '@/types';
import { StorageService, initDatabase } from '@/services/StorageService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = (require('react-native-quick-sqlite') as {
  __adapter: { __real: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } } };
}).__adapter;

const real = adapter.__real;

type Seg = { id: string; chapterId: string; order: number; text: string };
type Ch = { id: string; bookId: string; title: string; order: number; segments: Seg[] };

function makeBook(id: string, title: string, chapters: Array<[string, string[]]>): Book {
  const book: Book = {
    id,
    title,
    author: '测试',
    category: 'test',
    description: '',
    chapters: chapters.map(([chapterId, texts], ci) => {
      const segs: Seg[] = texts.map((t, i) => ({
        id: `${chapterId}-s${i + 1}`,
        chapterId,
        order: i + 1,
        text: t,
      }));
      const ch: Ch = {
        id: chapterId,
        bookId: id,
        title: `第${ci + 1}章`,
        order: ci + 1,
        segments: segs,
      };
      return ch;
    }),
  };
  return book as unknown as Book;
}

/** 该书的全部行（含幽灵行），按 rowid 序 */
function rowsOfBook(bookId: string): Array<{ rid: number; segment_id: string; text: string }> {
  return real
    .prepare(
      'SELECT rowid AS rid, segment_id, text FROM segments_fts WHERE book_id = ? ORDER BY rowid ASC',
    )
    .all(bookId) as Array<{ rid: number; segment_id: string; text: string }>;
}

function countAll(): number {
  return (real.prepare('SELECT COUNT(*) AS c FROM segments_fts').get() as { c: number }).c;
}

/** 映射表里的全部 segment_id */
function mapIds(): string[] {
  return (
    real
      .prepare('SELECT segment_id FROM segment_fts_rowid ORDER BY rid ASC')
      .all() as Array<{ segment_id: string }>
  ).map((r) => r.segment_id);
}

/** 【#16】真机自查口径：重复行数（交付复测用；应为 0） */
function dupes(): number {
  return (
    real
      .prepare(
        'SELECT COUNT(*) - COUNT(DISTINCT segment_id) AS d FROM segments_fts',
      )
      .get() as { d: number }
  ).d;
}

/** 检索（与 SearchService.searchInSqlite 同语句口径：instr 子串 + rowid 序） */
function search(kw: string): string[] {
  return (
    real
      .prepare(
        `SELECT segment_id FROM segments_fts
         WHERE instr(text, ?) > 0
         ORDER BY rowid ASC`,
      )
      .all(kw) as Array<{ segment_id: string }>
  ).map((r) => r.segment_id);
}

const LUNYU = () =>
  makeBook('lunyu', '论语', [
    ['lunyu-c1', ['学而时习之', '有朋自远方来']],
    ['lunyu-c2', ['温故而知新', '温故而知新，可以为师矣']],
  ]);

describe("【#16】生产代码 × 真实 SQLite：upsert 真幂等", () => {
  beforeAll(() => {
    // 建表走**生产 DDL**（含 #16 新增的 segment_fts_rowid 映射表）
    expect(initDatabase()).toEqual({ success: true, data: true });
  });

  beforeEach(() => {
    real.exec('DELETE FROM segments_fts');
    real.exec('DELETE FROM segment_fts_rowid');
  });

  test("① 同章反复写入（3 次）⇒ 行数恒等于段数，检索无重复条目", () => {
    const book = LUNYU();
    const chapter = (book as unknown as { chapters: Ch[] }).chapters[1];
    for (let i = 0; i < 3; i += 1) {
      expect(StorageService.upsertFtsForChapter(book, chapter).success).toBe(true);
    }
    expect(countAll()).toBe(2); // 该章 2 段 → 2 行（旧实现会是 6 行）
    expect(search('温故')).toEqual(['lunyu-c2-s1', 'lunyu-c2-s2']);
  });

  test("② 重写覆盖原位：rowid 逐行不变 ⇒ 检索顺序（书序/章序）不变", () => {
    const book = LUNYU();
    const chapters = (book as unknown as { chapters: Ch[] }).chapters;
    StorageService.upsertFtsForChapter(book, chapters[0]);
    StorageService.upsertFtsForChapter(book, chapters[1]);
    const before = rowsOfBook('lunyu');
    expect(before.map((r) => r.segment_id)).toEqual([
      'lunyu-c1-s1',
      'lunyu-c1-s2',
      'lunyu-c2-s1',
      'lunyu-c2-s2',
    ]);

    // 重水合 / 重试 / 两条装配路径先后写同一章（真机常见）
    StorageService.upsertFtsForChapter(book, chapters[0]);
    StorageService.upsertFtsForChapter(book, chapters[1]);

    expect(rowsOfBook('lunyu')).toEqual(before); // rowid 与内容序都逐字不变
    expect(countAll()).toBe(4);
  });

  test("③ 内容更新：同段恒 1 行，且检索到的是新文本", () => {
    const book = LUNYU();
    const chapters = (book as unknown as { chapters: Ch[] }).chapters;
    StorageService.upsertFtsForChapter(book, chapters[1]);
    // 章节内容被重新装配（例如 #22 的整章直读补全）
    chapters[1].segments[0].text = '温故而知新（补全后）';
    StorageService.upsertFtsForChapter(book, chapters[1]);
    expect(countAll()).toBe(2);
    expect(search('补全后')).toEqual(['lunyu-c2-s1']);
  });

  test("④ 整书写入 = 替换：历史重复行/幽灵行被清理（老库自愈）", () => {
    const book = LUNYU();
    // 伪历史污染：同段两行 + 一个不存在的段号（旧版「游标混合 push」的幽灵行）
    real
      .prepare(
        `INSERT INTO segments_fts(segment_id, book_id, chapter_id, book_title, chapter_title, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('lunyu-c2-s1', 'lunyu', 'lunyu-c2', '论语', '第2章', '温故而知新');
    real
      .prepare(
        `INSERT INTO segments_fts(segment_id, book_id, chapter_id, book_title, chapter_title, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('lunyu-c2-s1', 'lunyu', 'lunyu-c2', '论语', '第2章', '温故而知新');
    real
      .prepare(
        `INSERT INTO segments_fts(segment_id, book_id, chapter_id, book_title, chapter_title, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('lunyu-c2-s999', 'lunyu', 'lunyu-c2', '论语', '第2章', '幽灵段');
    expect(countAll()).toBe(3);

    expect(StorageService.upsertFtsForBook(book).success).toBe(true);

    // 该书行集合 == 该书的段集合（无重复、无幽灵）
    expect(rowsOfBook('lunyu').map((r) => r.segment_id)).toEqual([
      'lunyu-c1-s1',
      'lunyu-c1-s2',
      'lunyu-c2-s1',
      'lunyu-c2-s2',
    ]);
  });

  test("⑤ 整书写入两次：行数与 rowid 都不变（整书路径同样幂等）", () => {
    const book = LUNYU();
    StorageService.upsertFtsForBook(book);
    const first = rowsOfBook('lunyu');
    StorageService.upsertFtsForBook(book);
    expect(rowsOfBook('lunyu')).toEqual(first);
    expect(countAll()).toBe(4);
    // 计数判据（整本覆盖）在两次写入后仍成立
    expect(StorageService.isBookFullyIndexedInFts('lunyu', 2)).toBe(true);
  });

  test("⑥ 映射表是身份真源：重写后 rid 与 fts rowid 一致，且映射不增长", () => {
    const book = LUNYU();
    StorageService.upsertFtsForBook(book);
    const mapRows = real
      .prepare('SELECT segment_id, rid FROM segment_fts_rowid ORDER BY rid ASC')
      .all() as Array<{ segment_id: string; rid: number }>;
    expect(mapRows.map((r) => r.segment_id)).toEqual([
      'lunyu-c1-s1',
      'lunyu-c1-s2',
      'lunyu-c2-s1',
      'lunyu-c2-s2',
    ]);
    expect(mapRows.map((r) => r.rid)).toEqual(rowsOfBook('lunyu').map((r) => r.rid));
    StorageService.upsertFtsForBook(book);
    expect(
      (real.prepare('SELECT COUNT(*) AS c FROM segment_fts_rowid').get() as { c: number }).c,
    ).toBe(4); // 映射不随重写增长
  });

  test("⑦ 删除该书：只清该书行，其他书不受影响", () => {
    const lunyu = LUNYU();
    const other = makeBook('other', '别的书', [['other-c1', ['别的内容']]]);
    StorageService.upsertFtsForBook(lunyu);
    StorageService.upsertFtsForBook(other);
    expect(countAll()).toBe(5);

    expect(StorageService.deleteFtsForBook('lunyu').success).toBe(true);
    expect(rowsOfBook('lunyu')).toHaveLength(0);
    expect(rowsOfBook('other').map((r) => r.segment_id)).toEqual(['other-c1-s1']);
  });

  test("⑧ 删书释放的 rowid 被新书复用后，老书重写**不会**顶掉新书的行（映射随删行解除）", () => {
    const oldBook = makeBook('bookA', '老书', [['A-c1', ['老书甲']]]);
    const newBook = makeBook('bookB', '新书', [['B-c1', ['新书丙']]]);

    StorageService.upsertFtsForBook(oldBook);
    expect(StorageService.deleteFtsForBook('bookA').success).toBe(true); // 释放 rowid
    StorageService.upsertFtsForBook(newBook); // 新书自动拿到**被复用**的 rowid
    const newBefore = rowsOfBook('bookB');
    expect(newBefore.map((r) => r.segment_id)).toEqual(['B-c1-s1']);

    StorageService.upsertFtsForBook(oldBook); // 老书恢复 / 重导入（老实现用「记忆 rowid」写入）

    // 新书的行必须原样在位——修复前这里会被老书顶掉（实测复现：B-c1-s1 消失）
    expect(rowsOfBook('bookB')).toEqual(newBefore);
    expect(rowsOfBook('bookA').map((r) => r.segment_id)).toEqual(['A-c1-s1']);
    expect(countAll()).toBe(2);
  });

  test("⑨ 不变量：映射里的每个 rid 都指向一条现存行（无孤儿映射）", () => {
    const lunyu = LUNYU();
    const other = makeBook('other', '别的书', [['other-c1', ['别的内容']]]);
    StorageService.upsertFtsForBook(lunyu);
    StorageService.upsertFtsForChapter(lunyu, (lunyu as unknown as { chapters: Ch[] }).chapters[0]);
    StorageService.upsertFtsForBook(other);
    StorageService.deleteFtsForBook('lunyu');
    StorageService.upsertFtsForBook(other); // 重写：先清映射再清行再写
    StorageService.upsertFtsForBook(lunyu); // 老书回来

    const orphans = real
      .prepare(
        `SELECT m.segment_id AS sid FROM segment_fts_rowid m
          WHERE NOT EXISTS (SELECT 1 FROM segments_fts f WHERE f.rowid = m.rid)`,
      )
      .all();
    expect(orphans).toEqual([]);
    // 反向：每条现存行都有映射（写入路径必然登记）
    const unmapped = real
      .prepare(
        `SELECT f.segment_id AS sid FROM segments_fts f
          WHERE NOT EXISTS (SELECT 1 FROM segment_fts_rowid m WHERE m.rid = f.rowid)`,
      )
      .all();
    expect(unmapped).toEqual([]);
  });

  test("⑩ 整书重写后「不再存在的段」不留孤儿映射，其 rowid 被别书复用也不会反噬", () => {
    const v1 = makeBook('bookA', '老书', [['A-c1', ['甲', '乙', '丙']]]);
    const v2 = makeBook('bookA', '老书', [['A-c1', ['甲']]]); // 内容变少：只剩 1 段
    const other = makeBook('bookB', '别的书', [['B-c1', ['别的内容']]]);

    StorageService.upsertFtsForBook(v1);
    StorageService.upsertFtsForBook(v2); // A-c1-s2 / A-c1-s3 的行被删
    // 映射必须随之解除——否则它们指向已不存在的行，而 FTS5 会自动复用被释放的 rowid
    expect(mapIds()).not.toContain('A-c1-s2');
    expect(mapIds()).not.toContain('A-c1-s3');

    StorageService.upsertFtsForBook(other); // 新书拿到被释放的 rowid
    const otherBefore = rowsOfBook('bookB');
    expect(otherBefore.map((r) => r.segment_id)).toEqual(['B-c1-s1']);

    StorageService.upsertFtsForBook(v1); // 内容又变回 3 段（== 备份恢复 / 资产回滚）
    // 别书的行必须原样在位（孤儿映射会让 A-c1-s2 用记忆 rowid 把它顶掉）
    expect(rowsOfBook('bookB')).toEqual(otherBefore);
    expect(rowsOfBook('bookA').map((r) => r.segment_id)).toEqual([
      'A-c1-s1',
      'A-c1-s2',
      'A-c1-s3',
    ]);
    expect(countAll()).toBe(4);
  });

  test("⑪ 可暂停整书路径：中途中断也不留孤儿映射（不变量在中断窗口内同样成立）", async () => {
    const book = makeBook('bookA', '老书', [
      ['A-c1', ['甲']],
      ['A-c2', ['乙']],
      ['A-c3', ['丙']],
    ]);
    const other = makeBook('bookB', '别的书', [['B-c1', ['别的内容']]]);
    StorageService.upsertFtsForBook(book); // 先让三章都有映射与行
    expect(mapIds()).toHaveLength(3);

    // 第 1 片之后中断：shouldPause 抛错 ⇒ 外层 catch ⇒ 本次判失败，只写了第 1 章
    let calls = 0;
    const aborted = await StorageService.upsertFtsForBookChunked(book, {
      chunkChapters: 1,
      shouldPause: () => {
        calls += 1;
        if (calls > 1) {
          throw new Error('模拟索引中断');
        }
        return false;
      },
    });
    expect(aborted.success).toBe(false);
    expect(rowsOfBook('bookA').map((r) => r.segment_id)).toEqual(['A-c1-s1']); // 半册在库
    // 关键：未写入的段不得留下映射——它们的 rowid 已被删行释放，会被别书自动分配拿走
    expect(mapIds()).toEqual(['A-c1-s1']);

    StorageService.upsertFtsForBook(other); // 复用被释放的 rowid
    const otherBefore = rowsOfBook('bookB');
    expect(otherBefore.map((r) => r.segment_id)).toEqual(['B-c1-s1']);

    // 本书重跑整本（自愈路径）：别书的行必须完好，本书补齐
    expect(
      await StorageService.upsertFtsForBookChunked(book, { chunkChapters: 1 }),
    ).toEqual({ success: true, data: true });
    expect(rowsOfBook('bookB')).toEqual(otherBefore);
    expect(rowsOfBook('bookA').map((r) => r.segment_id)).toEqual([
      'A-c1-s1',
      'A-c2-s1',
      'A-c3-s1',
    ]);
  });

  test("⑫ 章级写入与整书分片写入重叠（真机常态）：同段恒 1 行、身份与检索序都不漂", async () => {
    const book = LUNYU();
    const chapters = (book as unknown as { chapters: Ch[] }).chapters;
    // 真机时序：装配完成即章级写入，随后整书分片兜底写入又盖一遍
    StorageService.upsertFtsForChapter(book, chapters[0]);
    expect(
      await StorageService.upsertFtsForBookChunked(book, { chunkChapters: 1 }),
    ).toEqual({ success: true, data: true });
    StorageService.upsertFtsForChapter(book, chapters[1]);
    expect(
      await StorageService.upsertFtsForBookChunked(book, { chunkChapters: 1 }),
    ).toEqual({ success: true, data: true });
    // 再交叉一次（重水合 / 跳章重跑）
    StorageService.upsertFtsForChapter(book, chapters[0]);

    expect(countAll()).toBe(4);
    expect(dupes()).toBe(0); // 【#16】真机自查口径
    const rows = rowsOfBook('lunyu');
    expect(rows.map((r) => r.segment_id)).toEqual([
      'lunyu-c1-s1',
      'lunyu-c1-s2',
      'lunyu-c2-s1',
      'lunyu-c2-s2',
    ]);
    expect(new Set(rows.map((r) => r.rid)).size).toBe(4); // 无 rowid 复用冲突
    expect(search('温故')).toEqual(['lunyu-c2-s1', 'lunyu-c2-s2']); // 检索无重复条目
    expect(mapIds()).toHaveLength(4); // 映射不随重叠写入增长
    expect(StorageService.isBookFullyIndexedInFts('lunyu', 2)).toBe(true);
  });
});
