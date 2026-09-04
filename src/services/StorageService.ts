/**
 * 本地存储服务（StorageService）
 * 基于 react-native-quick-sqlite 的同步 CRUD：
 *   - highlights 划线表
 *   - notes 笔记表
 *   - bookmarks 收藏表
 *   - recitation_progress 背诵进度表
 *   - segments_fts FTS5 全文搜索虚拟表
 * 时间戳统一 ISO 8601 UTC；主键 TEXT 类型。
 */
import type {
  Book,
  Bookmark,
  BookmarkType,
  Highlight,
  Note,
  RecitationMode,
  RecitationProgress,
  ServiceResult,
} from '@/types';

import { TextLibraryService } from '@/services/TextLibraryService';
import { open } from 'react-native-quick-sqlite';

type DB = ReturnType<typeof open>;

/** 数据库名（SQLCipher 加密开启） */
const DB_NAME = 'guoxue.db';

/** 数据库单例（惰性初始化） */
let db: DB | null = null;

// ---------- 工具函数 ----------

/** 生成带前缀的 ID */
export function genId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${ts}-${rand}`;
}

/** 当前时间（ISO 8601 UTC） */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 背诵进度记录 ID：bookId:chapterId:mode */
export function recitationKey(
  bookId: string,
  chapterId: string,
  mode: RecitationMode,
): string {
  return `${bookId}:${chapterId}:${mode}`;
}

// ---------- 数据库初始化 ----------

/** 获取数据库实例（不存在则打开并建表） */
function getDb(): DB | null {
  if (db) {
    return db;
  }
  try {
    db = open({ name: DB_NAME });
    return db;
  } catch (e) {
    db = null;
    return null;
  }
}

/**
 * 查询辅助：quick-sqlite 8.x 连接对象无 select 方法，
 * 统一经 execute 执行并取 rows._array 作为行数组。
 * 执行失败时抛出异常，由调用方外层 try-catch 统一捕获。
 */
function selectRows(
  instance: DB,
  sql: string,
  params: (string | number)[] = [],
): Record<string, unknown>[] {
  const res = instance.execute(sql, params);
  return (res.rows?._array ?? []) as Record<string, unknown>[];
}

const CREATE_HIGHLIGHTS = `
  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    color TEXT NOT NULL,
    text TEXT NOT NULL,
    note_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_highlights_segment ON highlights (segment_id);
  CREATE INDEX IF NOT EXISTS idx_highlights_chapter ON highlights (chapter_id);
`;

const CREATE_NOTES = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    content TEXT NOT NULL,
    highlight_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_segment ON notes (segment_id);
  CREATE INDEX IF NOT EXISTS idx_notes_chapter ON notes (chapter_id);
`;

const CREATE_BOOKMARKS = `
  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    book_id TEXT,
    chapter_id TEXT,
    segment_id TEXT,
    text TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks_type ON bookmarks (type);
`;

const CREATE_RECITATION = `
  CREATE TABLE IF NOT EXISTS recitation_progress (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    last_practiced_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recitation_unique
    ON recitation_progress (book_id, chapter_id, mode);
`;

const CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    segment_id UNINDEXED,
    book_id UNINDEXED,
    chapter_id UNINDEXED,
    book_title UNINDEXED,
    chapter_title UNINDEXED,
    text,
    tokenize = 'unicode61'
  );
`;

/** 初始化数据库：建表 + 全文索引 */
export function initDatabase(): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 初始化失败：无法打开数据库' };
  }
  try {
    // 执行失败会抛出异常，由 catch 统一捕获
    for (const sql of [CREATE_HIGHLIGHTS, CREATE_NOTES, CREATE_BOOKMARKS, CREATE_RECITATION, CREATE_FTS]) {
      instance.execute(sql);
    }
    // 旧库迁移（P1-12）：bookmarks 补 note 列；列已存在时 ALTER 会抛错，忽略即可
    try {
      instance.execute('ALTER TABLE bookmarks ADD COLUMN note TEXT');
    } catch {
      // 列已存在：静默跳过
    }
    // 旧库迁移（P2-07 间隔复习）：recitation_progress 补 completed_at /
    // review_level / next_due_at 三列；列已存在时静默跳过
    for (const sql of [
      'ALTER TABLE recitation_progress ADD COLUMN completed_at TEXT',
      'ALTER TABLE recitation_progress ADD COLUMN review_level INTEGER',
      'ALTER TABLE recitation_progress ADD COLUMN next_due_at TEXT',
    ]) {
      try {
        instance.execute(sql);
      } catch {
        // 列已存在：静默跳过
      }
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `建表失败：${(e as Error).message}` };
  }
}

// ---------- FTS5 全文索引 ----------

/** segments_fts 待插行（字段与 FTS 建表列一一对应） */
export interface FtsRow {
  segmentId: string;
  bookId: string;
  chapterId: string;
  bookTitle: string;
  chapterTitle: string;
  text: string;
}

/** FTS 单行插入语句（列序与 ensureFtsIndex 历史实现保持一致） */
const FTS_INSERT_SQL = `INSERT OR REPLACE INTO segments_fts
  (segment_id, book_id, chapter_id, book_title, chapter_title, text)
  VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * 将一本书的章/段展开为 FTS 待插行（纯函数，便于单测锁定字段映射）。
 * 空段与超长段不做任何特殊处理——与原全量构建行为完全一致：
 * 空段 text 为 ''（instr 匹配不上非空关键词，不影响搜索语义），
 * 超长段按段落切分后的结果原样入索引（切分发生在导入解析层）。
 */
export function buildFtsRows(book: Book): FtsRow[] {
  const rows: FtsRow[] = [];
  for (const chapter of book.chapters) {
    for (const seg of chapter.segments) {
      rows.push({
        segmentId: seg.id,
        bookId: book.id,
        chapterId: chapter.id,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        text: seg.text,
      });
    }
  }
  return rows;
}

/**
 * 将待插行同步逐条写入 segments_fts。
 * 导入书可能很大（数千段），保持同步逐条插入即可——
 * 与原 ensureFtsIndex 全量构建同级代价，不引入异步复杂度。
 */
function insertFtsRows(instance: DB, rows: FtsRow[]): void {
  for (const r of rows) {
    instance.execute(FTS_INSERT_SQL, [
      r.segmentId,
      r.bookId,
      r.chapterId,
      r.bookTitle,
      r.chapterTitle,
      r.text,
    ]);
  }
}

/**
 * 确保内置经典全部进入 FTS 索引（幂等，可重复调用；对外签名不变）。
 * 增量构建：先查 segments_fts 已有的 book_id 集合，跳过已入索引的书——
 * 冷启动重复调用由「全量重插所有书」降为「仅补缺失的书」，
 * 消除首次搜索时万级段落重插带来的一次性卡顿。
 * 同时做死索引自愈：清除不在当前文本库中的 book_id 残留行
 * （如删除用户书时 FTS 清理曾失败的残留），防止搜索命中已删书。
 */
export function ensureFtsIndex(): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    // 确保表存在
    const initRes = initDatabase();
    if (!initRes.success) {
      return initRes;
    }
    const segRes = TextLibraryService.allSegments();
    if (!segRes.success || !segRes.data) {
      return { success: false, error: '无法读取文本库' };
    }
    const indexedRows = selectRows(instance, 'SELECT DISTINCT book_id FROM segments_fts');
    const indexed = new Set(indexedRows.map((r) => String(r.book_id)));
    for (const book of TextLibraryService.getBooks().data ?? []) {
      if (indexed.has(book.id)) {
        continue;
      }
      insertFtsRows(instance, buildFtsRows(book));
    }
    // 死索引自愈：再次查询现有 book_id，不在当前文本库中的行一律清除
    const libraryIds = new Set(
      (TextLibraryService.getBooks().data ?? []).map((b) => b.id),
    );
    for (const row of selectRows(instance, 'SELECT DISTINCT book_id FROM segments_fts')) {
      const id = String(row.book_id);
      if (!libraryIds.has(id)) {
        instance.execute('DELETE FROM segments_fts WHERE book_id = ?', [id]);
      }
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 将单本书（用户导入书）的章/段同步写入 FTS 索引（幂等 upsert）。
 * 供 UserBookService.importBook 在导入成功后调用，使该书
 * 无需等待冷启动重建、同会话内即可被搜索路径命中。
 * 导入书可能很大（数千段），保持同步逐条插入——与 ensureFtsIndex
 * 全量构建同级代价，换取立即可搜。
 */
export function upsertFtsForBook(book: Book): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const initRes = initDatabase();
    if (!initRes.success) {
      return initRes;
    }
    insertFtsRows(instance, buildFtsRows(book));
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `FTS 索引写入失败：${(e as Error).message}` };
  }
}

/**
 * 按 bookId 清除 FTS 索引行。
 * 供 UserBookService.deleteBook 在删除成功后调用，
 * 防止已删书在 segments_fts 中残留死索引、搜索命中后加载失败。
 */
export function deleteFtsForBook(bookId: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const initRes = initDatabase();
    if (!initRes.success) {
      return initRes;
    }
    instance.execute('DELETE FROM segments_fts WHERE book_id = ?', [bookId]);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `FTS 索引清理失败：${(e as Error).message}` };
  }
}

// ---------- 划线 ----------

function rowToHighlight(row: Record<string, unknown>): Highlight {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    chapterId: String(row.chapter_id),
    segmentId: String(row.segment_id),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    color: String(row.color) as Highlight['color'],
    text: String(row.text),
    noteId: row.note_id ? String(row.note_id) : undefined,
    createdAt: String(row.created_at),
  };
}

export function saveHighlight(h: Highlight): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      `INSERT OR REPLACE INTO highlights
       (id, book_id, chapter_id, segment_id, start_offset, end_offset, color, text, note_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.id,
        h.bookId,
        h.chapterId,
        h.segmentId,
        h.startOffset,
        h.endOffset,
        h.color,
        h.text,
        h.noteId ?? null,
        h.createdAt,
      ],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `保存划线失败：${(e as Error).message}` };
  }
}

/** 获取划线列表（可按 bookId / chapterId 过滤） */
export function getHighlights(
  bookId?: string,
  chapterId?: string,
): ServiceResult<Highlight[]> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    let sql = 'SELECT * FROM highlights WHERE 1 = 1';
    const params: (string | number)[] = [];
    if (bookId) {
      sql += ' AND book_id = ?';
      params.push(bookId);
    }
    if (chapterId) {
      sql += ' AND chapter_id = ?';
      params.push(chapterId);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = selectRows(instance, sql, params);
    return {
      success: true,
      data: rows.map((r) => rowToHighlight(r)),
    };
  } catch (e) {
    return { success: false, error: `查询划线失败：${(e as Error).message}` };
  }
}

export function deleteHighlight(id: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM highlights WHERE id = ?', [id]);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `删除划线失败：${(e as Error).message}` };
  }
}

/** 划线颜色合法值（备份恢复逐条校验用） */
const HIGHLIGHT_COLORS: readonly string[] = ['yellow', 'green', 'blue'];

/**
 * restoreHighlights 单条恢复的最小校验与归一化：
 * id/bookId/chapterId/segmentId 须为非空字符串，偏移须为有限数且 0 ≤ start ≤ end，
 * color 须为合法枚举，text 须为字符串；noteId 缺失归一化为 undefined，
 * createdAt 缺失补当前时间。非法条目返回 null（由调用方跳过计数）。
 */
function normalizeRestoreHighlight(item: unknown): Highlight | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return null;
  }
  const raw = item as Record<string, unknown>;
  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0;
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.bookId) ||
    !isNonEmptyString(raw.chapterId) ||
    !isNonEmptyString(raw.segmentId)
  ) {
    return null;
  }
  const startOffset = Number(raw.startOffset);
  const endOffset = Number(raw.endOffset);
  if (
    !Number.isFinite(startOffset) ||
    !Number.isFinite(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset
  ) {
    return null;
  }
  if (!HIGHLIGHT_COLORS.includes(String(raw.color))) {
    return null;
  }
  if (typeof raw.text !== 'string') {
    return null;
  }
  return {
    id: raw.id,
    bookId: raw.bookId,
    chapterId: raw.chapterId,
    segmentId: raw.segmentId,
    startOffset,
    endOffset,
    color: raw.color as Highlight['color'],
    text: raw.text,
    noteId: typeof raw.noteId === 'string' ? raw.noteId : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowISO(),
  };
}

/**
 * 批量恢复划线（备份导入）：逐条最小校验 → INSERT OR REPLACE 幂等写入。
 * 非法条目静默跳过并计数（与五类 restoreFromBackup 的跳过惯例一致）；
 * 同 id 重复恢复按备份内容覆盖（幂等），不产生重复行。
 * 划线全量读取复用 getHighlights()（无参 = 全表），不另设 API。
 */
export function restoreHighlights(
  items: unknown[],
): ServiceResult<{ restored: number; skipped: number }> {
  if (!Array.isArray(items)) {
    return { success: false, error: 'highlights 应为数组' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const initRes = initDatabase();
    if (!initRes.success) {
      return { success: false, error: initRes.error ?? '初始化数据库失败' };
    }
    let restored = 0;
    let skipped = 0;
    for (const item of items) {
      const h = normalizeRestoreHighlight(item);
      if (!h) {
        skipped += 1;
        continue;
      }
      instance.execute(
        `INSERT OR REPLACE INTO highlights
         (id, book_id, chapter_id, segment_id, start_offset, end_offset, color, text, note_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          h.id,
          h.bookId,
          h.chapterId,
          h.segmentId,
          h.startOffset,
          h.endOffset,
          h.color,
          h.text,
          h.noteId ?? null,
          h.createdAt,
        ],
      );
      restored += 1;
    }
    return { success: true, data: { restored, skipped } };
  } catch (e) {
    return { success: false, error: `恢复划线失败：${(e as Error).message}` };
  }
}

// ---------- 笔记 ----------

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    chapterId: String(row.chapter_id),
    segmentId: String(row.segment_id),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    content: String(row.content),
    highlightId: row.highlight_id ? String(row.highlight_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function saveNote(n: Note): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      `INSERT OR REPLACE INTO notes
       (id, book_id, chapter_id, segment_id, start_offset, end_offset, content, highlight_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        n.id,
        n.bookId,
        n.chapterId,
        n.segmentId,
        n.startOffset,
        n.endOffset,
        n.content,
        n.highlightId ?? null,
        n.createdAt,
        n.updatedAt,
      ],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `保存笔记失败：${(e as Error).message}` };
  }
}

/** 更新笔记内容 */
export function updateNote(id: string, content: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      'UPDATE notes SET content = ?, updated_at = ? WHERE id = ?',
      [content, nowISO(), id],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `更新笔记失败：${(e as Error).message}` };
  }
}

/** 获取笔记列表（可按 bookId / chapterId 过滤） */
export function getNotes(
  bookId?: string,
  chapterId?: string,
): ServiceResult<Note[]> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    let sql = 'SELECT * FROM notes WHERE 1 = 1';
    const params: (string | number)[] = [];
    if (bookId) {
      sql += ' AND book_id = ?';
      params.push(bookId);
    }
    if (chapterId) {
      sql += ' AND chapter_id = ?';
      params.push(chapterId);
    }
    sql += ' ORDER BY updated_at DESC';
    const rows = selectRows(instance, sql, params);
    return {
      success: true,
      data: rows.map((r) => rowToNote(r)),
    };
  } catch (e) {
    return { success: false, error: `查询笔记失败：${(e as Error).message}` };
  }
}

export function deleteNote(id: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM notes WHERE id = ?', [id]);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `删除笔记失败：${(e as Error).message}` };
  }
}

// ---------- 收藏 ----------

function rowToBookmark(row: Record<string, unknown>): Bookmark {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tags_json ?? '[]'));
    if (Array.isArray(parsed)) {
      tags = parsed.map(String);
    }
  } catch {
    tags = [];
  }
  return {
    id: String(row.id),
    type: String(row.type) as BookmarkType,
    bookId: row.book_id ? String(row.book_id) : undefined,
    chapterId: row.chapter_id ? String(row.chapter_id) : undefined,
    segmentId: row.segment_id ? String(row.segment_id) : undefined,
    text: row.text ? String(row.text) : undefined,
    tags,
    note: row.note ? String(row.note) : undefined,
    createdAt: String(row.created_at),
  };
}

export function saveBookmark(b: Bookmark): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      `INSERT OR REPLACE INTO bookmarks
       (id, type, book_id, chapter_id, segment_id, text, tags_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.id,
        b.type,
        b.bookId ?? null,
        b.chapterId ?? null,
        b.segmentId ?? null,
        b.text ?? null,
        JSON.stringify(b.tags ?? []),
        b.note ?? null,
        b.createdAt,
      ],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `保存收藏失败：${(e as Error).message}` };
  }
}

/** 获取收藏列表（可按 type 过滤） */
export function getBookmarks(type?: BookmarkType): ServiceResult<Bookmark[]> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    let sql = 'SELECT * FROM bookmarks';
    const params: (string | number)[] = [];
    if (type) {
      sql += ' WHERE type = ?';
      params.push(type);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = selectRows(instance, sql, params);
    return {
      success: true,
      data: rows.map((r) => rowToBookmark(r)),
    };
  } catch (e) {
    return { success: false, error: `查询收藏失败：${(e as Error).message}` };
  }
}

/** 更新收藏标签 */
export function updateBookmarkTags(id: string, tags: string[]): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      'UPDATE bookmarks SET tags_json = ? WHERE id = ?',
      [JSON.stringify(tags ?? []), id],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `更新收藏标签失败：${(e as Error).message}` };
  }
}

/** 更新收藏标签与备注（P1-12 收藏编辑弹层保存入口） */
export function updateBookmarkMeta(
  id: string,
  tags: string[],
  note?: string,
): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute(
      'UPDATE bookmarks SET tags_json = ?, note = ? WHERE id = ?',
      [JSON.stringify(tags ?? []), note ?? null, id],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `更新收藏失败：${(e as Error).message}` };
  }
}

export function deleteBookmark(id: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM bookmarks WHERE id = ?', [id]);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `删除收藏失败：${(e as Error).message}` };
  }
}

// ---------- 背诵进度 ----------

function rowToRecitation(row: Record<string, unknown>): RecitationProgress {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    chapterId: String(row.chapter_id),
    mode: String(row.mode) as RecitationMode,
    status: String(row.status) as RecitationProgress['status'],
    progress: Number(row.progress),
    lastPracticedAt: row.last_practiced_at
      ? String(row.last_practiced_at)
      : undefined,
    // P2-07 复习调度字段：旧数据（列不存在 / 值为 NULL）保持 undefined
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    reviewLevel:
      row.review_level === null || row.review_level === undefined
        ? undefined
        : Number(row.review_level),
    nextDueAt: row.next_due_at ? String(row.next_due_at) : undefined,
  };
}

/** 保存背诵进度（按 bookId:chapterId:mode 幂等 upsert） */
export function saveRecitation(r: RecitationProgress): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const id = recitationKey(r.bookId, r.chapterId, r.mode);
    instance.execute(
      `INSERT OR REPLACE INTO recitation_progress
       (id, book_id, chapter_id, mode, status, progress, last_practiced_at,
        completed_at, review_level, next_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        r.bookId,
        r.chapterId,
        r.mode,
        r.status,
        r.progress,
        r.lastPracticedAt ?? null,
        r.completedAt ?? null,
        r.reviewLevel ?? null,
        r.nextDueAt ?? null,
      ],
    );
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `保存背诵进度失败：${(e as Error).message}` };
  }
}

/** 获取某章节的背诵进度 */
export function getRecitation(
  bookId: string,
  chapterId: string,
  mode: RecitationMode,
): ServiceResult<RecitationProgress | null> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const id = recitationKey(bookId, chapterId, mode);
    const rows = selectRows(instance, 'SELECT * FROM recitation_progress WHERE id = ?', [id]);
    const row = rows[0];
    return {
      success: true,
      data: row ? rowToRecitation(row) : null,
    };
  } catch (e) {
    return { success: false, error: `查询背诵进度失败：${(e as Error).message}` };
  }
}

/** 获取全部背诵进度 */
export function getRecitationList(): ServiceResult<RecitationProgress[]> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    const rows = selectRows(
      instance,
      'SELECT * FROM recitation_progress ORDER BY last_practiced_at DESC',
    );
    return {
      success: true,
      data: rows.map((r) => rowToRecitation(r)),
    };
  } catch (e) {
    return { success: false, error: `查询背诵进度失败：${(e as Error).message}` };
  }
}

export function deleteRecitation(id: string): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM recitation_progress WHERE id = ?', [id]);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `删除背诵进度失败：${(e as Error).message}` };
  }
}

export const StorageService = {
  initDatabase,
  ensureFtsIndex,
  upsertFtsForBook,
  deleteFtsForBook,
  buildFtsRows,
  genId,
  nowISO,
  saveHighlight,
  getHighlights,
  deleteHighlight,
  restoreHighlights,
  saveNote,
  updateNote,
  getNotes,
  deleteNote,
  saveBookmark,
  getBookmarks,
  updateBookmarkTags,
  updateBookmarkMeta,
  deleteBookmark,
  saveRecitation,
  getRecitation,
  getRecitationList,
  deleteRecitation,
};

export default StorageService;
