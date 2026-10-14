/**
 * 本地存储服务（StorageService）
 * 基于 sqliteClient 适配层（op-sqlite）的同步 CRUD：
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
import { open } from '@/services/sqliteClient';
// ★ 章级目录字段的唯一读侧真值（2026-10-12）：`bookTextChars` 由本模块提供，
//   见FTS_MAX_BOOK_CHARS 处的迁移说明。
import { bookTextChars } from '@/services/chapterCatalog';

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

/**
 * 初始化数据库：基础表（highlights / notes / bookmarks / recitation_progress）
 * + 旧库迁移 + FTS5 虚拟表。
 *
 * 【#14】基础表与 FTS 建表**解耦**：FTS5 是编译期特性（未定义
 * SQLITE_ENABLE_FTS5 时 SQLite 内核不含该模块，见 android/gradle.properties），
 * 一旦把它和基础 DDL 串在同一个 try 里，`CREATE VIRTUAL TABLE … USING fts5`
 * 抛出的 `no such module: fts5` 会把整个 initDatabase 判为失败——后果是
 * `restoreHighlights` 等「init 失败即早退」的路径被连坐（全文检索缺失却导致
 * 划线/笔记备份恢复整体不可用）。故基础表失败才返回失败，FTS 失败只降级。
 */
export function initDatabase(): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 初始化失败：无法打开数据库' };
  }
  try {
    // 执行失败会抛出异常，由 catch 统一捕获
    for (const sql of [
      CREATE_HIGHLIGHTS,
      CREATE_NOTES,
      CREATE_BOOKMARKS,
      CREATE_RECITATION,
      // 【#16】FTS 行身份映射（真表：FTS5 虚拟表加不上唯一索引，只能外挂映射）
      CREATE_SEGMENT_FTS_ROWID,
    ]) {
      instance.execute(sql);
    }
  } catch (e) {
    return { success: false, error: `建表失败：${(e as Error).message}` };
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
  // FTS 虚拟表：与基础表解耦（失败只降级，不影响基础表初始化结果）
  ensureFtsTable(instance);
  return { success: true, data: true };
}

// ---------- FTS5 可用性（#14：负缓存 + 一次性降级日志）----------

/** FTS5 虚拟表可用性三态：unknown（未探测）/ ready（已就绪）/ unavailable（负缓存） */
type FtsAvailability = 'unknown' | 'ready' | 'unavailable';

/**
 * FTS 可用性负缓存。
 * 「已就绪」与「不可用」都要缓存：DDL 幂等，成功一次后没必要重跑；失败
 * （SQLite 未编译 FTS5 / 建表异常）同样是稳定事实，若只缓存成功态，则每个
 * 装配完成的章都会重跑一遍 initDatabase（4 条 CREATE IF NOT EXISTS + 4 条
 * 必然抛错的旧库迁移 ALTER，异常构造本身就有开销），真机表现为每章一条
 * `[PERF][fts] per-chapter skip` 刷屏且白烧 JS 线程。
 */
let ftsAvailability: FtsAvailability = 'unknown';

/**
 * 读取当前 FTS 可用性。
 * 必须经函数调用读取：模块级 `let` 在同一函数体内被 TS 控制流收窄后，即使
 * 中间调用了会改写它的函数（initDatabase → ensureFtsTable），收窄也不会重置，
 * 直接比较会报 TS2367「无重叠类型」。
 */
function currentFtsAvailability(): FtsAvailability {
  return ftsAvailability;
}

/** 降级日志是否已打过（一次性）：FTS 不可用是稳定事实，不做日志节流会刷屏 */
let ftsDegradeLogged = false;

/** FTS 不可用时的统一错误串（负缓存命中时立即返回，不重跑 initDatabase） */
const FTS_UNAVAILABLE_ERROR =
  'FTS5 不可用：segments_fts 未建立（SQLite 未编译 SQLITE_ENABLE_FTS5），全文检索降级';

/**
 * 建立 FTS 虚拟表（initDatabase 内的唯一 FTS 探测点）。
 *  - ready       → 直接 true，零 SQL；
 *  - unavailable → 直接 false，零 SQL（负缓存核心：绝不重试建表）；
 *  - unknown     → 只尝试一次 CREATE VIRTUAL TABLE：成功置 ready；失败置
 *                  unavailable，并**只打一次**降级日志（保留成功路径静默）。
 * @returns 本进程内 segments_fts 是否可用
 */
function ensureFtsTable(instance: DB): boolean {
  if (ftsAvailability === 'ready') {
    return true;
  }
  if (ftsAvailability === 'unavailable') {
    return false;
  }
  try {
    instance.execute(CREATE_FTS);
    ftsAvailability = 'ready';
    // 【#16】建表就绪后立即做一次老库迁移（播种 rowid 映射 + 清算遗留重复行）。
    // 放在这里的原因：unknown→ready 每个进程只发生一次，且**先于本进程任何 FTS
    // 写入**（所有写入路径都经 initDatabase/ensureFtsSchema 进来），所以老段在
    // 首次被重写前一定已经有映射。
    // 单独 try：迁移失败绝不能让 FTS 被误判为 unavailable（后果只是「老段首次
    // 重写退化为追加一行」+ 遗留重复行仍在，由整书写入的替换语义清算）。
    try {
      migrateLegacyFtsRows(instance);
    } catch {
      // 静默：不影响 FTS 可用性判定
    }
    return true;
  } catch (e) {
    ftsAvailability = 'unavailable';
    if (!ftsDegradeLogged) {
      ftsDegradeLogged = true;
      const reason = (e as Error).message;
      // 只打一次：FTS 不可用是稳定事实；原因里带上**可操作**的修复方向，
      // 避免真机日志只有 `no such module: fts5` 而无从下手。
      console.warn(
        `[StorageService] FTS5 不可用，全文检索降级（搜索无结果；阅读/划线/笔记不受影响）：${reason}${
          /no such module/i.test(reason)
            ? '；原因：SQLite 未编译 FTS5（需在 android/gradle.properties 注入 quickSqliteFlags="-DSQLITE_ENABLE_FTS5=1" 后重新构建）'
            : ''
        }`,
      );
    }
    return false;
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

/**
 * 【#16】FTS 行的**稳定身份**：段 → rowid 映射表（真表，`segment_id` 主键）。
 *
 * 为什么需要它（#14 用真实 SQLite 实测登记的 W1）：`segments_fts` 是 FTS5 虚拟表，
 * **没有主键、也加不上唯一索引**（实测 `CREATE UNIQUE INDEX … ` →
 * `virtual tables may not be indexed`），而 `INSERT OR REPLACE` 的冲突子句只在
 * 主键/唯一约束冲突时触发——不显式给 rowid 时每次插入都自动分配新 rowid、
 * **永不冲突 ⇒ 退化成普通 INSERT**。于是同一段被写两次就留两行：搜索对同一段
 * 重复返回、索引体积随时间膨胀（重试/补全/重水合/两条装配路径都会重写同一章）。
 *
 * 方案选型（全部为 better-sqlite3 真实 SQLite 实测，勿凭直觉改动）：
 *  - ✅ **本方案**：映射表记住每段的 rowid ⇒ 已知段用 `INSERT OR REPLACE` 覆盖
 *    **原位**、未知段以 `rowid=NULL` 追加（自动 rowid）并登记。效果：
 *    ① 真幂等（同段恒 1 行）；② **检索顺序逐字不变**（`ORDER BY rowid ASC` =
 *    首次写入序 = 书序/章序，与内存回退路径同序）；③ 身份精确、**零哈希碰撞**；
 *    ④ 实测代价 ≈ 0（2 万行表上 200 行写入：6ms，与纯追加 6ms 相同——批量点查
 *    走 `segment_id` 主键，非扫描）。
 *  - ❌ 哈希 docid（`segment_id → 52 位 hash`）：写明 rowid 也幂等，但被打散的
 *    rowid 会让 `ORDER BY rowid ASC` 从「书序」变成「哈希序」——检索结果顺序漂移，
 *    与内存回退路径不再同序（真实 FTS5 契约测试当场抓到这个回归）。
 *  - ❌ 两段式 `DELETE … WHERE segment_id = ?` + INSERT：`segment_id` 是 UNINDEXED
 *    列 ⇒ 每行一次**全表扫描**（20 万行实测 20ms/次），章级路径每章都付一次 =
 *    新的卡顿源。
 *  - ❌ 章级 `DELETE … WHERE book_id=? AND chapter_id=?` 清理：同上，全表扫描。
 *
 * 代价与残留（如实登记）：映射表约 40 字节/段（全库量级的一行文本量级）；
 * **修复前已产生的重复行/幽灵行**不由此处清理（按章清理要全表扫描，见上）；
 * 改由「整书写入 = 替换」在下次整书重索引时清算
 *（见 `upsertFtsForBook` / `upsertFtsForBookChunked`）。
 *
 * ---------- 【#16 二轮】不变量：「映射里的 rid 必然指向现存行」----------
 *
 * 只做「查不到就 NULL 追加」是不够的：**FTS5 的自动 rowid 会复用被释放的 rowid**
 * （实测 max(rowid)+1 语义：删掉最后 3 行后再插入，拿到的是 1 而不是 4）。
 * 于是「映射里残留的 rid」会与新段自动分配的 rid **撞车**，此时老段重写会以
 * 「记忆 rid」把**别的书的行顶掉**——真实 SQLite 复现：
 *     bookA 删（rowid 1,2 释放，映射残留）→ bookB 写入（自动拿到 rowid 1,2）
 *     → bookA 重写（用记忆 rid 1）⇒ bookB-s1 那一行**消失**（静默丢段）。
 * 故凡「删行」必须同时删映射，维持不变量：**映射 ⊆ 现存行**。据此：
 *  - 新段自动分配的 rid = max(现存 rowid)+1 > 一切映射中的 rid ⇒ 永不相撞；
 *  - 删行处的清映射口径按「能否被中断」分三类（各有测试锁死）：
 *    · 章级增量写入：**不删行** ⇒ 复用旧 rowid ⇒ 书序/章序稳定（检索顺序契约见
 *      `fts5RealSqliteSemantics.test.ts` 的 `ORDER BY rowid ASC` 断言）；
 *    · 整书**同步**重写：清「库中现存但本次不再写入」的差集（`clearStaleFtsRidMap`，
 *      一次全表扫描 ≈15ms）；仍在写入的段保留原 rowid ⇒ 同样覆盖原位；
 *    · 整书**可暂停**重写：清该书**全部**段的映射（PK 点删，≈0.3ms/千段）——
 *      一旦中途中断，保留「未写入段」的映射会留下无行映射（正是撞车条件）；
 *      代价是全书 rowid 重新分配，对「整本重建」语义可接受；
 *    · 无法枚举段 id 的路径（删书 / 死索引自愈）：子查询清（一次全表扫描
 *      ≈15ms，低频路径可接受）。
 *
 * 另外：老库（#16 之前写入的行）没有映射，若不补齐，老段首次重写会「查不到 rid
 * ⇒ 以 NULL 追加」⇒ 既留重复行，又让读侧去重（`ORDER BY rowid ASC` 保留首行）
 * 返回**更新前的旧文本**；而且遗留重复行本身也不会消失。故进程内首次建表就绪时
 * 做一次迁移（`migrateLegacyFtsRows`：播种 `MIN(rowid)` + 清算重复行；实测
 * 20 万行播种 60ms、去重扫描 15ms，一次性）——迁移后
 * `COUNT(*) - COUNT(DISTINCT segment_id) = 0`（#16 真机自查口径）。
 */
const CREATE_SEGMENT_FTS_ROWID = `
  CREATE TABLE IF NOT EXISTS segment_fts_rowid (
    segment_id TEXT PRIMARY KEY NOT NULL,
    rid INTEGER NOT NULL
  );
`;

/** 映射点查的批量行数（避免占位符超限；主键点查，非扫描） */
const FTS_ROWID_LOOKUP_CHUNK = 200;

/**
 * FTS 单行插入语句（业务列序与 ensureFtsIndex 历史实现保持一致）。
 * 【#16】首列为**显式 rowid**：已知段传映射记住的原 rowid（覆盖原位），
 * 新段传 `null`（实测 FTS5 接受 NULL rowid ⇒ 自动分配并追加到末尾）。
 */
const FTS_INSERT_SQL = `INSERT OR REPLACE INTO segments_fts
  (rowid, segment_id, book_id, chapter_id, book_title, chapter_title, text)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

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
 * 将待插行同步逐条写入 segments_fts（**【#16】真幂等 upsert**）。
 *
 * 幂等由「映射表记住的稳定 rowid + `INSERT OR REPLACE`」提供（见
 * `CREATE_SEGMENT_FTS_ROWID` 注释）：同段重写覆盖**原位**（检索顺序也因此稳定），
 * 新段追加。导入书可能很大（数千段），保持同步逐条插入——与旧实现同级代价
 * （实测 200 行 6ms，与纯追加同），不引入异步复杂度。
 */
function insertFtsRows(instance: DB, rows: FtsRow[]): void {
  if (rows.length === 0) {
    return;
  }
  // ① 批量取已有 rowid：`IN` + 主键点查（每 200 个一条语句，避免占位符超限）
  const ridOf = new Map<string, number>();
  for (let s = 0; s < rows.length; s += FTS_ROWID_LOOKUP_CHUNK) {
    const ids = rows
      .slice(s, s + FTS_ROWID_LOOKUP_CHUNK)
      .map((r) => r.segmentId);
    const placeholders = ids.map(() => '?').join(', ');
    const found = selectRows(
      instance,
      `SELECT segment_id, rid FROM segment_fts_rowid WHERE segment_id IN (${placeholders})`,
      ids,
    );
    for (const row of found) {
      const rid = Number(row.rid);
      if (Number.isFinite(rid) && rid > 0) {
        ridOf.set(String(row.segment_id), rid);
      }
    }
  }
  // ② 逐行写入：已知段覆盖原位；新段以 NULL rowid 追加并立刻登记映射
  for (const r of rows) {
    const known = ridOf.get(r.segmentId);
    instance.execute(FTS_INSERT_SQL, [
      known ?? null,
      r.segmentId,
      r.bookId,
      r.chapterId,
      r.bookTitle,
      r.chapterTitle,
      r.text,
    ]);
    if (known !== undefined) {
      continue;
    }
    const last = selectRows(instance, 'SELECT last_insert_rowid() AS rid');
    const rid = last.length > 0 ? Number(last[0].rid ?? 0) : 0;
    if (Number.isFinite(rid) && rid > 0) {
      instance.execute(
        'INSERT OR REPLACE INTO segment_fts_rowid (segment_id, rid) VALUES (?, ?)',
        [r.segmentId, rid],
      );
      ridOf.set(r.segmentId, rid); // 同批重复段：后续走覆盖分支
    }
  }
}

/**
 * 【#16】清除若干段的 rowid 映射（**PK 点删，无扫描**；实测 1000 段 0.3ms）。
 * 调用契约：**必须在删除对应 FTS 行之前**调用——先解除映射，再删行，
 * 中间不存在「映射指向不存在的行」的窗口（不变量见 `CREATE_SEGMENT_FTS_ROWID`）。
 */
function clearFtsRidMap(instance: DB, segmentIds: string[]): void {
  for (const segmentId of segmentIds) {
    instance.execute('DELETE FROM segment_fts_rowid WHERE segment_id = ?', [
      segmentId,
    ]);
  }
}

/**
 * 【#16】清除**某书**全部段的 rowid 映射（无法枚举段 id 的路径使用）。
 * 代价：子查询要走 `segments_fts` 一次全表扫描（`book_id` 是 UNINDEXED 列，
 * 20 万行实测 ≈15ms），故只用于「删书」「死索引自愈」这类低频路径。
 */
function clearFtsRidMapForBook(instance: DB, bookId: string): void {
  instance.execute(
    `DELETE FROM segment_fts_rowid WHERE segment_id IN (
       SELECT segment_id FROM segments_fts WHERE book_id = ?
     )`,
    [bookId],
  );
}

/**
 * 【#16】老库一次性迁移（触发条件：**映射为空但库中已有行**；每个进程最多一次）。
 *
 * ① **播种** `segment_id → rowid`：取 `MIN(rowid)`——那正是检索
 *    （`ORDER BY rowid ASC` + 读侧去重保留首行）下**用户实际看到**的那一行；
 *    若取到更高的重复行，老段重写就会去覆盖一行用户看不见的行，可见那行仍是旧文本。
 * ② **清算遗留重复行**：#16 之前 `INSERT OR REPLACE` 在真实 FTS5 上退化为普通
 *    INSERT，同段多行是常态产物。此处按映射删掉「非最小 rowid」的同段行，使
 *    **`COUNT(*) - COUNT(DISTINCT segment_id) = 0`**（#16 的真机自查口径；
 *    没有映射时无法判定「该保留哪一行」，所以必须与 ① 同时做）。
 *    按 `rowid` 删（PK 点查），不做 `WHERE segment_id = ?`（UNINDEXED 全表扫描）。
 *
 * 代价（better-sqlite3 实测，20 万行）：探测 O(1) · 播种 60ms · 去重计数扫描
 * ≈15ms + 每删一行 ~1.3µs（半数重复的极端库存 100k 重复行也只 148ms）。
 * 这是**一次性**冷启动成本，与 FTS 冷启动重建同阶段；故打一行 `[PERF][fts]`
 * 供真机核对（含本次清掉的重复行数——正是修复前缺陷的真实规模）。
 *  - 映射非空 ⇒ 已迁移过（或库由新代码写入）⇒ 直接返回（只付 O(1) 探测）；
 *  - 映射空 + 库中无行 ⇒ 全新安装 ⇒ 直接返回（不产生多余语句）。
 */
function migrateLegacyFtsRows(instance: DB): void {
  if (
    selectRows(instance, 'SELECT 1 AS hit FROM segment_fts_rowid LIMIT 1')
      .length > 0
  ) {
    return;
  }
  if (selectRows(instance, 'SELECT 1 AS hit FROM segments_fts LIMIT 1').length === 0) {
    return;
  }
  const startedAt = Date.now();
  instance.execute(
    `INSERT OR REPLACE INTO segment_fts_rowid (segment_id, rid)
       SELECT segment_id, MIN(rowid) FROM segments_fts GROUP BY segment_id`,
  );
  const seededRows = selectRows(
    instance,
    'SELECT COUNT(*) AS c FROM segment_fts_rowid',
  );
  const seeded = seededRows.length > 0 ? Number(seededRows[0].c ?? 0) : 0;

  const dupeRows = selectRows(
    instance,
    'SELECT COUNT(*) - COUNT(DISTINCT segment_id) AS d FROM segments_fts',
  );
  const dupes = dupeRows.length > 0 ? Number(dupeRows[0].d ?? 0) : 0;
  if (dupes > 0) {
    // 同段多行：映射那一行（MIN(rowid)）留下，其余删掉
    instance.execute(
      `DELETE FROM segments_fts WHERE rowid IN (
         SELECT f.rowid FROM segments_fts f
         JOIN segment_fts_rowid m ON m.segment_id = f.segment_id
         WHERE f.rowid <> m.rid
       )`,
    );
  }
  console.info(
    `[PERF][fts] migrate-legacy-fts rows=${seeded} dupes=${dupes} ms=${Date.now() - startedAt}`,
  );
}

/**
 * 【#16】整书**同步**重写前的映射整理：只解除「库中现存、但本次不再写入」的段。
 *
 * 为什么不能只清「本次要写入的段」（那会丢原位）：同段重写要覆盖**原位**才能让
 * 检索顺序（`ORDER BY rowid ASC` = 书序/章序）稳定；只清差集则仍在写入的段保留
 * 原 rowid，同时不再存在的段不留下孤儿映射。
 * 代价：一次 `segments_fts` 全表扫描（`book_id` 是 UNINDEXED 列，20 万行实测
 * ≈15ms；本函数只在整书级路径调用，低频）。
 * 只用于**同步**路径（不可中断，不存在「清了映射却没写成行」的窗口）；
 * 可暂停路径见 `upsertFtsForBookChunked` 的相反取法。
 */
function clearStaleFtsRidMap(
  instance: DB,
  bookId: string,
  incoming: Set<string>,
): void {
  const existing = selectRows(
    instance,
    'SELECT segment_id FROM segments_fts WHERE book_id = ?',
    [bookId],
  );
  const stale = new Set<string>();
  for (const row of existing) {
    const id = String(row.segment_id);
    if (!incoming.has(id)) {
      stale.add(id);
    }
  }
  clearFtsRidMap(instance, Array.from(stale));
}

/** 【#16】该书的全部段 id（整书路径清映射用；不构造行对象，代价 = 段数级循环） */
function segmentIdsOfBook(book: Book): string[] {
  const ids: string[] = [];
  for (const chapter of book.chapters) {
    for (const seg of chapter.segments) {
      ids.push(seg.id);
    }
  }
  return ids;
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
    // ★2026-10-12：此处原有一次 `TextLibraryService.allSegments()` 调用，
    // 其返回的 `data` **从未被读取**（全文只用于判 `success`）⇒ 纯丢弃调用。
    // 而它的副作用是**把全书 segments 物化并拼成一个巨型数组**
    // （161MB / 980 章的书即数万段对象），在冷启路径上白跑一遍。
    // 现改为直接取书籍列表：既能判活（`getBooks` 失败即返回错误），
    // 又不触碰段落。下方循环本来就只按 book 粒度工作，语义等价。
    const booksRes = TextLibraryService.getBooks();
    if (!booksRes.success || !booksRes.data) {
      return { success: false, error: '无法读取文本库' };
    }
    const books = booksRes.data;
    const indexedRows = selectRows(instance, 'SELECT DISTINCT book_id FROM segments_fts');
    const indexed = new Set(indexedRows.map((r) => String(r.book_id)));
    for (const book of books) {
      if (indexed.has(book.id)) {
        continue;
      }
      // 超大书跳过索引（字数超限，索引代价灾难级；章节内阅读不受影响）
      if (bookTextChars(book) > FTS_MAX_BOOK_CHARS) {
        console.warn(`[StorageService] 超大书跳过 FTS 索引：${book.title}`);
        continue;
      }
      insertFtsRows(instance, buildFtsRows(book));
    }
    // 死索引自愈：再次查询现有 book_id，不在当前文本库中的行一律清除
    const libraryIds = new Set(books.map((b) => b.id));
    for (const row of selectRows(instance, 'SELECT DISTINCT book_id FROM segments_fts')) {
      const id = String(row.book_id);
      if (!libraryIds.has(id)) {
        // 【#16】清行同时清映射（否则被释放的 rowid 会与新书自动分配的 rowid 撞车）
        clearFtsRidMapForBook(instance, id);
        instance.execute('DELETE FROM segments_fts WHERE book_id = ?', [id]);
      }
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 单书 FTS 索引字数上限：超大书（如数百 MB epub）不进全文索引——
 * 真机教训：重建库后 3 本超大书全量重索引把 JS 线程占死数十秒。
 * 超限书不参与全文搜索（章节内阅读不受影响），避免灾难级索引代价。
 */
const FTS_MAX_BOOK_CHARS = 4_000_000;

/**
 * 统计单本书全文字数。
 *
 * ★ 2026-10-12：实现已迁至 `chapterCatalog.bookTextChars`（唯一读侧真值）。
 *
 * 迁移理由：原实现内联 `for (const sg of ch.segments) n += sg.text.length`
 * ——**为了做一个判断（是否超 4M 字而跳过索引）而必须遍历全书正文**。
 * 「章节改偏移量」重构（设计文档 §2阻塞 B / §3）会把 `segments` 改为按需读取
 * ⇒ 该实现会**恒返回 ~0** ⇒ `FTS_MAX_BOOK_CHARS` 闸门形同虚设，
 * 中等书被误判为「很小」而全部入索引 ⇒ **反而制造新的索引卡顿**。
 *
 * ⇒ 现读 `Chapter.charCount` 目录字段（构造时算，见 `createChapterBuilder`）。
 *
 * ⚠ 本函数调用点密集（`ensureFtsIndex` / `upsertFtsForBook` /
 *   `upsertFtsForBookChunked` 各一次）⇒ **不允许**在此处改回遍历 `segments`。
 */

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
  if (bookTextChars(book) > FTS_MAX_BOOK_CHARS) {
    // 超大书跳过索引（不阻断导入，仅不可被全文搜索命中）
    console.warn(`[StorageService] 超大书跳过 FTS 索引：${book.title}`);
    return { success: true, data: true };
  }
  try {
    const initRes = initDatabase();
    if (!initRes.success) {
      return initRes;
    }
    const ftsRows = buildFtsRows(book);
    // 【#16】整书写入语义 = **替换**该书索引（先清该书行，再全量写入）。
    // 必要性：旧写入路径在真实 FTS5 上退化为普通 INSERT（同段多行），加上
    // 「游标混合 push」时代可能写入过不存在的段号（幽灵行），这些历史残留
    // 只能靠一次整书重写清掉——而**章级路径做不到**（按章清理要 `WHERE
    // book_id=? AND chapter_id=?` 全表扫描：20 万行实测 20ms/章，章级路径
    // 每章都付一次 = 新的卡顿源，故明确不做）。
    // 代价：一次全表扫描/书（20 万行实测 20ms），相对整书重写本身可忽略。
    // 中断安全性：本函数是**同步**整本写入，不存在中途暂停；即使抛错，调用方
    // （导入后写入 / 侧路重索引）下次会按 `isBookIndexedInFts` 等判据重跑。
    // 同时**先解除「该书不再写入的段」的映射**（不变量：映射 ⊆ 现存行；否则被
    // 释放的 rowid 会被新段自动分配拿走，老段重写时会静默顶掉别的书的行——实测
    // 复现，见 `CREATE_SEGMENT_FTS_ROWID`）。仍在写入的段**保留原 rowid** ⇒ 覆盖
    // 原位 ⇒ 检索顺序不变（`clearStaleFtsRidMap`）。
    clearStaleFtsRidMap(
      instance,
      book.id,
      new Set(ftsRows.map((r) => r.segmentId)),
    );
    instance.execute('DELETE FROM segments_fts WHERE book_id = ?', [book.id]);
    insertFtsRows(instance, ftsRows);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `FTS 索引写入失败：${(e as Error).message}` };
  }
}

/** 时间片预算（ms）：默认路径逐章构建行+插入，每章完成检查耗时，超预算
 * 即让出。固定 8 章/片对资治通鉴级（章均 1.5 万字）单片约 25 万字，
 * tokenize+逐行 execute 仍可秒级——时间片把块上限压到单章量级（约 10-30ms）。
 * （真机教训：同步版对资治通鉴级约 300 万字的书单块执行占死 JS 数秒至
 * 数十秒，初次启动建索引期间全 UI 无响应） */
const FTS_TIME_BUDGET_MS = 8;

/** 分片异步索引的单片让出间隔（ms）：macrotask，触摸/渲染事件可在片间插队 */
const FTS_CHUNK_YIELD_MS = 0;

/** 分片异步索引的暂停轮询间隔（ms）：shouldPause 为 true 期间挂起等待 */
const FTS_CHUNK_PAUSE_POLL_MS = 250;

/** 单章 FTS 行构建+插入（供时间片路径复用） */
function buildAndInsertChapterFts(
  instance: DB,
  book: Book,
  chapter: Book['chapters'][number],
): void {
  const rows: FtsRow[] = chapter.segments.map((seg) => ({
    segmentId: seg.id,
    bookId: book.id,
    chapterId: chapter.id,
    bookTitle: book.title,
    chapterTitle: chapter.title,
    text: seg.text,
  }));
  insertFtsRows(instance, rows);
}

/**
 * FTS 表结构就绪守卫（章级增量写入的热路径）。
 * `initDatabase()` 每次调用都会执行 4 条 CREATE IF NOT EXISTS + 4 条必然
 * 抛错的 ALTER（旧库迁移），被章级写入按章调用会引入无谓的异常构造开销；
 * DDL 幂等，故**成功一次即置位跳过**。
 *
 * 【#14】失败也缓存（负缓存）：FTS5 未编译时 `CREATE VIRTUAL TABLE … USING
 * fts5` 必然失败，且是稳定事实——只缓存成功态会让每个装配完成的章都重跑一遍
 * initDatabase，并使 UserBookService 侧按章打印降级日志（真机刷屏）。
 * 一旦判定不可用即**立即返回失败，绝不重跑 initDatabase**（零 SQL 零异常）。
 */
function ensureFtsSchema(): ServiceResult<boolean> {
  if (ftsAvailability === 'ready') {
    return { success: true, data: true };
  }
  if (ftsAvailability === 'unavailable') {
    return { success: false, error: FTS_UNAVAILABLE_ERROR };
  }
  // unknown：仅此一次探测（initDatabase 内部经 ensureFtsTable 写回可用性）
  const res = initDatabase();
  if (!res.success) {
    return res;
  }
  // 注意：必须经函数调用读取——否则 TS 控制流会把「探测过程中被写入的新状态」
  // 收窄成死分支（TS2367）。探测成功且非 unavailable ⇒ 只能是 ready。
  if (currentFtsAvailability() === 'unavailable') {
    return { success: false, error: FTS_UNAVAILABLE_ERROR };
  }
  return { success: true, data: true };
}

/**
 * 分片异步版单书 FTS 索引写入（幂等 upsert，语义与 upsertFtsForBook 一致）。
 * 默认时间片驱动：逐章「构建行 + 插入」，每章完成检查耗时，超
 * FTS_TIME_BUDGET_MS 即让出 JS 线程（macrotask）；显式传入 opts.chunkChapters
 * 时退回固定章数分片（测试注入用）。用户优先门闩在章级检查——shouldPause()
 * 为 true 时挂起轮询等待（用户水合/交互时暂停建索引，门闩解除后从断点
 * 续写——INSERT OR REPLACE 幂等，重叠无副作用）。
 * 超大书跳过（与同步版同口径，仅不可被全文搜索命中）。
 * 供后台索引队列 / 填充完成顺带入索引等非交互关键路径调用；
 * 导入书同会话立即可搜的路径仍用同步版（导入自身有明确的一次性等待语义）。
 */
export async function upsertFtsForBookChunked(
  book: Book,
  opts?: { shouldPause?: () => boolean; chunkChapters?: number },
): Promise<ServiceResult<boolean>> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  if (bookTextChars(book) > FTS_MAX_BOOK_CHARS) {
    console.warn(`[StorageService] 超大书跳过 FTS 索引：${book.title}`);
    return { success: true, data: true };
  }
  try {
    const initRes = initDatabase();
    if (!initRes.success) {
      return initRes;
    }
    // 【#16】整书重写语义 = **替换**（先清该书行）——理由与中断安全性分析见
    // `upsertFtsForBook` 同处注释。此处额外说明「可暂停」路径的后果：若在
    // shouldPause 挂起期间被取消，本次只写了部分章 → 但调用方（填充完成 /
    // 后台索引队列）以 `isBookFullyIndexedInFts` 计数判据复核，未达标即重跑，
    // 故为「短暂不完整 + 自愈」，不会留下永久缺章（对比：不清理则永久多行）。
    // 映射同样**先清该书全部段的映射**（不变量：映射 ⊆ 现存行）。此处与同步路径
    // 刻意取不同口径——同步路径只清「不再写入的段」以保住原位，而本路径**可暂停**：
    // 一旦中途抛错/被取消，只写了部分章，若保留未写入段的映射就留下「无行映射」，
    // 正是让别的书被自动分配的 rowid 撞车后顶掉的条件（详见
    // `CREATE_SEGMENT_FTS_ROWID`）。清光代价是该书 rowid 全部重新分配（位置可能
    // 变化），对「整本重建」语义而言可接受。
    clearFtsRidMap(instance, segmentIdsOfBook(book));
    instance.execute('DELETE FROM segments_fts WHERE book_id = ?', [book.id]);
    if (opts?.chunkChapters !== undefined) {
      // 固定章数分片（测试/兼容路径）：与旧实现逐语句一致
      const chunkSize = Math.max(1, opts.chunkChapters);
      for (let i = 0; i < book.chapters.length; i += chunkSize) {
        // 用户优先门闩：片间检查，挂起时轮询等待（250ms 一次）
        // eslint-disable-next-line no-await-in-loop
        while (opts.shouldPause?.()) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => setTimeout(resolve, FTS_CHUNK_PAUSE_POLL_MS));
        }
        const chunk = book.chapters.slice(i, i + chunkSize);
        const rows: FtsRow[] = [];
        for (const chapter of chunk) {
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
        insertFtsRows(instance, rows);
        // 片间让出：最后一个片也不用额外让出（循环自然结束）
        // eslint-disable-next-line no-await-in-loop
        if (i + chunkSize < book.chapters.length) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => setTimeout(resolve, FTS_CHUNK_YIELD_MS));
        }
      }
      return { success: true, data: true };
    }
    // 默认时间片路径（生产）：逐章构建+插入，章级门闩检查，超预算让出
    let sliceStart = Date.now();
    for (let i = 0; i < book.chapters.length; i += 1) {
      // 用户优先门闩：章级检查（粒度比旧片间更细，水合响应更快）
      // eslint-disable-next-line no-await-in-loop
      while (opts?.shouldPause?.()) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, FTS_CHUNK_PAUSE_POLL_MS));
      }
      buildAndInsertChapterFts(instance, book, book.chapters[i]);
      if (Date.now() - sliceStart >= FTS_TIME_BUDGET_MS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, FTS_CHUNK_YIELD_MS));
        sliceStart = Date.now();
      }
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `FTS 索引写入失败：${(e as Error).message}` };
  }
}

/**
 * 该书是否已进入 FTS 索引（供 UserBookService 后台索引队列幂等跳过；
 * db 不可用时返回 false，队列会尝试重建——重建失败也只是重复劳动）。
 */
export function isBookIndexedInFts(bookId: string): boolean {
  try {
    const instance = getDb();
    if (!instance) {
      return false;
    }
    const rows = selectRows(
      instance,
      'SELECT 1 AS hit FROM segments_fts WHERE book_id = ? LIMIT 1',
      [bookId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 【r38 T03】FTS 章级增量写入：单章装配完成（READY_FULL）即写该章行。
 *
 * 背景（PRD 待确认问题 ①「全文检索是否必须依赖整本装配」）：旧链路是
 * 「整本书装配完成后 `upsertFtsForBookChunked(整本)`」——大部头（玉台新咏
 * 390 章）在装配推进到搜索所需章之前，该书完全搜不到；且整本写入必然
 * 等到全书就位。改为章级增量后，**已装配章立即可被搜到**，
 * 「FTS 可用性」不再与「整本装配完成」耦合。
 *
 * 实现复用私有 `buildAndInsertChapterFts`（与分片整书路径**同一行构造口径**，
 * 字段映射逐列一致：segment/book/chapter id + 书名/章名冗余列 + 段文本）。
 *  - **幂等来自映射表，不来自 `INSERT OR REPLACE`**（【#16】更正旧注释，勿写回）：
 *    FTS5 虚拟表**加不上唯一索引**（`CREATE UNIQUE INDEX` 直接抛
 *    `virtual tables may not be indexed`）⇒ 不给显式 rowid 时该语句**永不冲突**，
 *    在真实 FTS5 上**退化为普通 INSERT**（同段多行；历史库里的重复行即由此产生）。
 *    旧注释「幂等：`INSERT OR REPLACE`（FTS5 无主键 → 按 segment_id 覆盖同段行）」
 *    是错的判定：`INSERT OR REPLACE` 从不按 `segment_id` 覆盖。
 *    真幂等由 `segment_fts_rowid` 映射表（段 → 稳定 rowid）保证：**已知段**传映射
 *    记住的原 rowid ⇒ **覆盖原位**（检索顺序因此稳定）；**新段**才由 FTS5 自动分配
 *    rowid 并登记；删行必须同步清映射（不变量与四档口径见
 *    `CREATE_SEGMENT_FTS_ROWID` 注释）。回归由 `ftsIdempotencyRealSqlite.test.ts`
 *    / `fts5RealSqliteSemantics.test.ts`（真实 SQLite 驱动生产函数）在 CI 层拦截。
 *  - 空章（无段落）零动作，不产生行（与 buildFtsRows 口径一致）；
 *  - **不做全书字数上限判定**：`FTS_MAX_BOOK_CHARS` 是「整本解析代价」的
 *    守卫，章级写入的单章代价恒为单章量级；超限书由调用方（整书路径）
 *    自行跳过，章级写入不回退（宁可多几章可搜，也不引入新的静默缺失）。
 */
export function upsertFtsForChapter(
  book: Book,
  chapter: Book['chapters'][number],
): ServiceResult<boolean> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  if (!book || !chapter || !Array.isArray(chapter.segments) || chapter.segments.length === 0) {
    return { success: true, data: true };
  }
  try {
    const initRes = ensureFtsSchema();
    if (!initRes.success) {
      return initRes;
    }
    buildAndInsertChapterFts(instance, book, chapter);
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `FTS 单章写入失败：${(e as Error).message}` };
  }
}

/**
 * 【r38 T03】计数式「整本已入索引」判据（已索引章数 ≥ totalChapters）。
 *
 * 与既有 `isBookIndexedInFts`（存在即真）的区别：章级增量写入下，
 * 「写了 1 章」就存在行——存在判据会把「只索引了 1 章」误判为整本已索引，
 * 使整书兜底路径被永久跳过（真·缺章）。计数判据把「整本覆盖」作为门槛，
 * 超集（残留多余章行）亦视为已覆盖。
 *  - db 不可用 / totalChapters 非法 → false（调用方会尝试补写，重复劳动无害）；
 *  - **不改** `isBookIndexedInFts` 既有语义（队列幂等跳过仍以它为准）。
 */
export function isBookFullyIndexedInFts(
  bookId: string,
  totalChapters: number,
): boolean {
  if (!bookId) {
    return false;
  }
  if (!Number.isFinite(totalChapters) || totalChapters <= 0) {
    return false;
  }
  try {
    const instance = getDb();
    if (!instance) {
      return false;
    }
    const rows = selectRows(
      instance,
      'SELECT COUNT(DISTINCT chapter_id) AS indexed FROM segments_fts WHERE book_id = ?',
      [bookId],
    );
    const indexed = rows.length > 0 ? Number(rows[0].indexed ?? 0) : 0;
    if (!Number.isFinite(indexed)) {
      return false;
    }
    return indexed >= totalChapters;
  } catch {
    return false;
  }
}

/**
 * 按 bookId 清除 FTS 索引行。
 * 供 UserBookService.deleteBook 在删除成功后调用，
 * 防止已删书在 segments_fts 中残留死索引、搜索命中后加载失败。
 * 【#16】同时清掉该书的 rowid 映射：删行会**释放 rowid**，而 FTS5 的自动分配会
 * 复用被释放的 rowid（实测），映射若残留，该书日后被恢复/重导入时就会用「记忆
 * rowid」把别的书占了同一 rowid 的行顶掉（静默丢段）。此路径无法枚举段 id，
 * 故走子查询形式（多一次全表扫描，20 万行 ≈15ms；删书是低频用户动作）。
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
    clearFtsRidMapForBook(instance, bookId);
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

/**
 * 删除指定书籍的全部笔记（按 book_id 级联清理）。
 * BugFix：用户书删除后其笔记会成为孤儿——重导入同一文件会生成新 bookId
 * （时间戳），旧笔记永远无法重新挂接，只会在笔记列表页形成死条目。
 * 供 UserBookService.deleteBook 在书籍删除成功后调用。
 * 空 bookId 直接拒绝（防御 DELETE ... WHERE book_id = '' 误删）。
 */
export function deleteNotesByBook(bookId: string): ServiceResult<boolean> {
  if (!bookId) {
    return { success: false, error: 'bookId 不能为空' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM notes WHERE book_id = ?', [bookId]);
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

/**
 * 删除指定书籍的全部收藏（按 book_id 级联清理）。
 * BugFix：用户书删除后其收藏会成为孤儿——重导入同一文件会生成新 bookId
 * （时间戳），旧收藏永远无法重新挂接，只会在收藏列表页形成死条目。
 * 供 UserBookService.deleteBook 在书籍删除成功后调用。
 * 空 bookId 直接拒绝（防御 DELETE ... WHERE book_id = '' 误删）。
 */
export function deleteBookmarksByBook(bookId: string): ServiceResult<boolean> {
  if (!bookId) {
    return { success: false, error: 'bookId 不能为空' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: 'SQLite 不可用' };
  }
  try {
    instance.execute('DELETE FROM bookmarks WHERE book_id = ?', [bookId]);
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
  upsertFtsForBookChunked,
  isBookIndexedInFts,
  // —— r38 T03 新增（FTS 章级增量 + 计数式书级判据）——
  upsertFtsForChapter,
  isBookFullyIndexedInFts,
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
  deleteNotesByBook,
  saveBookmark,
  getBookmarks,
  updateBookmarkTags,
  updateBookmarkMeta,
  deleteBookmark,
  deleteBookmarksByBook,
  saveRecitation,
  getRecitation,
  getRecitationList,
  deleteRecitation,
};

export default StorageService;
