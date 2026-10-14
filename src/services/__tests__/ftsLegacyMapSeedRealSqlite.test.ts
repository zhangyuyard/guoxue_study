/**
 * 【#16·二轮】老库迁移：`segment_fts_rowid` 映射的**播种**（生产代码 × 真实 SQLite）。
 *
 * 为什么需要这一层：#16 的「稳定 rowid」依赖映射表，而 #16 之前写入的库**只有
 * `segments_fts` 行、没有任何映射**。若不补齐：
 *  - 老段首次重写会「查不到 rid ⇒ 以 NULL 追加」⇒ 同段两行；
 *  - 更糟的是读侧去重按 `ORDER BY rowid ASC` **保留首行** ⇒ 保留的是**改内容之前
 *    的老行**，搜索会返回过期文本（内置书资产更新后即可见）。
 * 故 `ensureFtsTable` 在「进程内首次就绪」时调用 `seedFtsRidMapIfEmpty` 播种。
 *
 * 本文件的关键在于**时序**：老库状态必须在**任何一次 initDatabase 之前**造好——
 * 所以才单独成文件（本文件是独立的 jest 模块实例，`ftsAvailability` 从 unknown
 * 起算，能真正走到 unknown→ready 的播种分支；在已 init 过的套件里无法复现）。
 */
jest.mock('@/services/sqliteClient', () => {
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

import { readFileSync } from 'fs';
import { resolve } from 'path';

import type { Book } from '@/types';
import { StorageService, initDatabase } from '@/services/StorageService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = (require('@/services/sqliteClient') as {
  __adapter: {
    __real: {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        all: (...a: unknown[]) => unknown[];
        get: (...a: unknown[]) => unknown;
        run: (...a: unknown[]) => unknown;
      };
    };
  };
}).__adapter;

const real = adapter.__real;

/** 生产建表语句（逐字抽取，保证老库结构与线上一致） */
const CREATE_FTS = (() => {
  const src = readFileSync(resolve(__dirname, '../StorageService.ts'), 'utf8');
  const m = /const CREATE_FTS = `([\s\S]*?)`;/.exec(src);
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1];
})();

/** 老库时间线（#16 之前）：只有 segments_fts 行，没有映射表 */
const LEGACY_ROWS: Array<[string, string, string, string, string, string]> = [
  ['lunyu-c1-s1', 'lunyu', 'lunyu-c1', '论语', '学而', '学而时习之'],
  ['lunyu-c1-s2', 'lunyu', 'lunyu-c1', '论语', '学而', '有朋自远方来'],
  ['lunyu-c2-s1', 'lunyu', 'lunyu-c2', '论语', '为政', '温故而知新'],
  // 老库历史重复行（#16 修复前「INSERT OR REPLACE 退化为普通 INSERT」的产物）；
  // 它的 rowid 更高 ⇒ 一旦映射落到这一行，读侧去重就会返回**这一行**的文本
  ['lunyu-c1-s1', 'lunyu', 'lunyu-c1', '论语', '学而', '学而时习之（旧重复行）'],
];

type Seg = { id: string; chapterId: string; order: number; text: string };

function makeBook(id: string, chapters: Array<[string, string[]]>): Book {
  return {
    id,
    title: '论语',
    author: '',
    category: 'jing',
    description: '',
    chapters: chapters.map(([chapterId, texts], ci) => ({
      id: chapterId,
      bookId: id,
      title: `第${ci + 1}章`,
      order: ci + 1,
      segments: texts.map(
        (t, i): Seg => ({
          id: `${chapterId}-s${i + 1}`,
          chapterId,
          order: i + 1,
          text: t,
        }),
      ),
    })),
  } as unknown as Book;
}

/** 映射表内容（segment_id → rid） */
function mapRows(): Array<{ segment_id: string; rid: number }> {
  return real
    .prepare('SELECT segment_id, rid FROM segment_fts_rowid ORDER BY rid ASC')
    .all() as Array<{ segment_id: string; rid: number }>;
}

/** 【#16】真机自查口径：重复行数（应为 0） */
function dupes(): number {
  return (
    real
      .prepare(
        'SELECT COUNT(*) - COUNT(DISTINCT segment_id) AS d FROM segments_fts',
      )
      .get() as { d: number }
  ).d;
}

/** 某段在 FTS 中的所有行（含重复/幽灵行） */
function rowsOfSegment(segmentId: string): Array<{ rid: number; text: string }> {
  return real
    .prepare(
      'SELECT rowid AS rid, text FROM segments_fts WHERE segment_id = ? ORDER BY rowid ASC',
    )
    .all(segmentId) as Array<{ rid: number; text: string }>;
}

let seeded = false;

beforeAll(() => {
  // ① 造老库：先建 FTS 表并写入历史行（此时**没有** segment_fts_rowid 表）
  real.exec(CREATE_FTS);
  const ins = real.prepare(
    `INSERT INTO segments_fts (segment_id, book_id, chapter_id, book_title, chapter_title, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of LEGACY_ROWS) {
    ins.run(...row);
  }
  const legacyRows = (
    real.prepare('SELECT COUNT(*) AS c FROM segments_fts').get() as { c: number }
  ).c;
  const legacyMaxRid = (
    real.prepare('SELECT MAX(rowid) AS m FROM segments_fts').get() as { m: number }
  ).m;
  expect(legacyRows).toBe(4);
  expect(legacyMaxRid).toBe(4); // 老库确实存在更高 rowid 的重复行

  // ② 生产 initDatabase：建表（含映射表）+ 走到 unknown→ready 并做老库迁移
  expect(initDatabase()).toEqual({ success: true, data: true });

  // ③ 迁移结果：映射与老行的 rowid 逐行一致（取 MIN(rowid) ⇒ 用户实际看到的那行）
  const rows = mapRows();
  expect(rows).toHaveLength(3); // 4 行老数据里有 1 条是同段重复 ⇒ 映射按主键去重
  expect(rows.map((r) => r.segment_id)).toEqual([
    'lunyu-c1-s1',
    'lunyu-c1-s2',
    'lunyu-c2-s1',
  ]);
  expect(rows[2].rid).toBe(3);
  expect(new Set(rows.map((r) => r.rid)).size).toBe(3);
  seeded = true;
});

test("前置：老库已迁移（映射非空）", () => {
  expect(seeded).toBe(true);
});

test("老库迁移同时清算遗留重复行：重复行数 = 0（#16 真机自查口径），且只删非映射行", () => {
  expect(dupes()).toBe(0); // `COUNT(*) - COUNT(DISTINCT segment_id) = 0`
  // 只删了「同段里非映射 rowid」的那一行：映射行（rid 1）与两个正常段都在
  expect(
    (real.prepare('SELECT COUNT(*) AS c FROM segments_fts').get() as { c: number }).c,
  ).toBe(3);
  expect(rowsOfSegment('lunyu-c1-s1')).toHaveLength(1);
  expect(rowsOfSegment('lunyu-c1-s1')[0].rid).toBe(1);
  expect(mapRows().map((r) => r.rid)).toEqual([1, 2, 3]);
});

test("老段重写覆盖**原位**：读侧去重看到的那一行（最小 rowid）拿到新文本", () => {
  const before = rowsOfSegment('lunyu-c1-s1');
  expect(before).toHaveLength(1);

  // 老段被重新装配（例：内置书资产内容更新后章级写入）
  const book = makeBook('lunyu', [['lunyu-c1', ['学而时习之（新）', '有朋自远方来']]]);
  expect(
    StorageService.upsertFtsForChapter(book, book.chapters[0]).success,
  ).toBe(true);

  const after = rowsOfSegment('lunyu-c1-s1');
  // 关键：检索 `ORDER BY rowid ASC` + 读侧去重保留的**首行**就是新文本。
  // 不迁移时这里会是「老行在前（旧文本）+ 追加的新行在后（新文本）」⇒ 用户读到旧文本
  expect(after).toHaveLength(1);
  expect(after[0].text).toBe('学而时习之（新）');
  expect(after[0].rid).toBe(before[0].rid); // 覆盖原位（rowid 逐字不变）
  expect(dupes()).toBe(0); // 章级写入不制造重复
  // 未触碰的段一字未动
  expect(rowsOfSegment('lunyu-c2-s1').map((r) => r.text)).toEqual(['温故而知新']);
});

test("整书写入把老库残留的重复行/幽灵行清算掉（替换语义）", () => {
  const book = makeBook('lunyu', [
    ['lunyu-c1', ['学而时习之（新）', '有朋远方来（新）']],
    ['lunyu-c2', ['温故而知新']],
  ]);
  expect(StorageService.upsertFtsForBook(book).success).toBe(true);

  const all = real
    .prepare('SELECT segment_id FROM segments_fts ORDER BY rowid ASC')
    .all() as Array<{ segment_id: string }>;
  expect(all.map((r) => r.segment_id)).toEqual([
    'lunyu-c1-s1',
    'lunyu-c1-s2',
    'lunyu-c2-s1',
  ]);
  // 行集合与段集合一致 ⇒ 无重复、无幽灵
  expect(rowsOfSegment('lunyu-c1-s1')).toHaveLength(1);
  expect(mapRows()).toHaveLength(3);
});

test("播种幂等：再次 initDatabase 不重复播种、不改动既有 rid", () => {
  const before = mapRows();
  expect(initDatabase()).toEqual({ success: true, data: true });
  expect(mapRows()).toEqual(before);
});
