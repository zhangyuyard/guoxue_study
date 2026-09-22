/**
 * 测试共享 helper：**保真的内存版 FTS5 写入面**（`segments_fts` + `segment_fts_rowid`）。
 *
 * 存在理由（【#29】）：四个套件（`StorageService.fts` / `UserBookService.ftsSync`
 * / `UserBookService.restore` / `UserBookService.cascade`）此前各自内联了一份
 * quick-sqlite mock，其中**两处保真度缺陷互相抵消**，使得「mock 全绿」在真实
 * SQLite 上并不成立——正是 #14 的 W1 教训（「希望式 mock」）：
 *
 *  ① **分支误路由**：内联 mock 用「子串顺序匹配」分派，把
 *     `/SELECT segment_id FROM segments_fts WHERE book_id = \?/` 排在
 *     `/DELETE FROM segment_fts_rowid WHERE segment_id IN/` **之前**且未锚定语句
 *     类型。而 `clearFtsRidMapForBook` 的 SQL（见 `StorageService`）正是
 *     `DELETE … WHERE segment_id IN (SELECT segment_id FROM segments_fts WHERE
 *     book_id = ?)`——它内嵌了同一条 SELECT 子查询 ⇒ SELECT 处理器先命中 ⇒
 *     **「按书清映射」分支永不可达**。后果：删书在 mock 里**从不清映射**，
 *     等价于生产被植入了「删书不清映射」缺陷（M-A）而 mock 依然全绿 ⇒ 零检测力。
 *  ② **rowid 分配语义不符**：内联 mock 用 `lastRid += 1`（单调不复用），而真实
 *     FTS5 的自动 rowid 是 **`max(rowid) + 1`**（**会复用被释放的 rowid**，实测：
 *     删掉最后 3 行后再插入拿到该 rowid 本身）。于是「映射残留的 rid 撞上新段
 *     自动分配的 rid ⇒ 老段重写静默顶掉别的书的行」这一缺陷在 mock 里
 *     **结构上不可表示**（撞车不可发生）。
 *
 * 本 helper 把这两点按真机语义修正，并集中一份实现供四个套件复用
 * （jest.config 的 `testPathIgnorePatterns` 已为 `*.helper.ts` 预留，不会被当套件收集）：
 *
 *  - **按语句首词路由**（`SELECT` / `INSERT` / `DELETE`）后再精确匹配形态 ⇒ 子查询
 *    不再泄漏到别的语句分组，`clearFtsRidMapForBook` 分支可达；
 *  - **rowid 自动分配 = `max(现存 rowid) + 1`**（含复用被释放 rowid）；
 *  - 显式 rowid ⇒ `INSERT OR REPLACE` 按 rowid **覆盖原位**；NULL ⇒ 自动分配并追加；
 *  - 完整承载 `migrateLegacyFtsRows` 的语句面（存在性探测 / 计数 / 播种 `MIN(rowid)`
 *    / 重复行清算 / `dupes` 口径），使老库迁移路径在 mock 层也可被驱动；
 *  - 暴露**不变量探针** `ridMapViolations`（「映射 ⊆ 现存行」，生产注释里的核心
 *    不变量）：删行未清映射时可被断言直接抓住。
 *
 * 边界：本 helper 只覆盖 **guoxue.db 的 FTS 两句语句面**；各套件的
 * `user_books.db` / `bookmarks` / `notes` / `recitation_progress` 等语句仍由套件
 * 自行处理（helper 返回 `null` 表示「不是 FTS 语句，请套件继续处理」）。
 */

/** 内存版 `segments_fts` 行（`rowid` 为隐式主键，真机上恒存在） */
export interface FtsMockRow {
  rowid?: number;
  segment_id?: unknown;
  book_id?: unknown;
  chapter_id?: unknown;
  book_title?: unknown;
  chapter_title?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

/** 内存版 FTS 写入面状态（各套件把它展开进自己的 mockState） */
export interface FtsMockState {
  /** `segments_fts` 行（顺序 = 追加序；覆盖原位不改变位置） */
  ftsRows: FtsMockRow[];
  /** `segment_fts_rowid` 映射表（段 id → 稳定 rowid；真机为 PK 真表） */
  ftsRidMap: Map<string, number>;
  /** 最近一次 `segments_fts` 插入的 rowid（`SELECT last_insert_rowid()`） */
  lastInsertRid: number;
  /** `segments_fts` 单行 INSERT 调用计数（断言增量构建跳过已入索引书） */
  insertCalls: number;
}

/** quick-sqlite `execute` 的返回形状（只用到 `rows._array` / `rows.length`） */
export interface MockRows {
  rows: { _array: Array<Record<string, unknown>>; length: number };
}

/** `FTS_INSERT_SQL` 的业务列序（与 `StorageService` 逐列一致；rowid 由首列单独给） */
export const FTS_MOCK_COLS = [
  'segment_id',
  'book_id',
  'chapter_id',
  'book_title',
  'chapter_title',
  'text',
] as const;

/** 构造一份全新的内存 FTS 状态 */
export function createFts5Mock(): FtsMockState {
  return {
    ftsRows: [],
    ftsRidMap: new Map<string, number>(),
    lastInsertRid: 0,
    insertCalls: 0,
  };
}

/**
 * 重置状态（`beforeEach` 用）。
 * 必须同时清 `ftsRidMap` / `lastInsertRid`——只清 `ftsRows` 会让映射跨用例残留，
 * 于是「无行映射」（撞车条件）被上一个用例悄悄种进下一个用例，断言不再可信。
 */
export function resetFts5Mock(state: FtsMockState): void {
  state.ftsRows = [];
  state.ftsRidMap.clear();
  state.lastInsertRid = 0;
  state.insertCalls = 0;
}

/**
 * 真实 FTS5 的自动 rowid 分配：`max(现存 rowid) + 1`（空表为 1）。
 * **会复用被释放的 rowid**——这正是「映射残留就会撞车」的机制来源，勿改回单调递增。
 */
export function nextAutoRid(state: FtsMockState): number {
  let max = 0;
  for (const row of state.ftsRows) {
    const rid = Number(row.rowid);
    if (Number.isFinite(rid) && rid > max) {
      max = rid;
    }
  }
  return max + 1;
}

/**
 * 预置一条**历史行**（模拟「库中已有、但映射表里没有」的写入）：真机上老行必然
 * 占有 rowid，故此处按真机语义补一个自动 rowid。**不登记映射**——老库迁移
 * （`migrateLegacyFtsRows`）要播种的正是这种行。
 */
export function pushFtsRow(
  state: FtsMockState,
  row: FtsMockRow,
): FtsMockRow {
  const stored: FtsMockRow = { ...row };
  if (stored.rowid === undefined || stored.rowid === null) {
    stored.rowid = nextAutoRid(state);
  }
  state.ftsRows.push(stored);
  return stored;
}

/**
 * 不变量探针：「映射 ⊆ 现存行」的**违反项**（映射里的 rid 找不到对应行）。
 * 生产注释（`CREATE_SEGMENT_FTS_ROWID`）把该不变量作为写入路径的正确性核心：
 * 凡删行必须同步清映射，否则被释放的 rowid 会被新段自动分配拿走 ⇒ 老段重写时
 * 以「记忆 rid」静默顶掉别的书的行。断言 `ridMapViolations(state) === []` 即可
 * 抓住「删书不清映射」（M-A）。
 */
export function ridMapViolations(
  state: FtsMockState,
): Array<{ segment_id: string; rid: number }> {
  const live = new Set<number>();
  for (const row of state.ftsRows) {
    const rid = Number(row.rowid);
    if (Number.isFinite(rid)) {
      live.add(rid);
    }
  }
  const violations: Array<{ segment_id: string; rid: number }> = [];
  for (const [segmentId, rid] of state.ftsRidMap) {
    if (!live.has(rid)) {
      violations.push({ segment_id: segmentId, rid });
    }
  }
  return violations;
}

/** 映射表中仍存在的段 id（「删书后该书段的映射必须为空」直接断言用） */
export function ridMapEntriesFor(
  state: FtsMockState,
  segmentIds: string[],
): string[] {
  return segmentIds.filter((id) => state.ftsRidMap.has(id));
}

/** 构造 quick-sqlite 形状的 SELECT 结果 */
function ok(rows: Array<Record<string, unknown>>): MockRows {
  return { rows: { _array: rows, length: rows.length } };
}

/** 语句首词（分派依据；`null` = 与 FTS 无关的语句） */
function statementHead(sql: string): 'SELECT' | 'INSERT' | 'DELETE' | null {
  const head = sql.trimStart().slice(0, 6).toUpperCase();
  if (head === 'SELECT') {
    return 'SELECT';
  }
  if (head === 'INSERT') {
    return 'INSERT';
  }
  if (head === 'DELETE') {
    return 'DELETE';
  }
  return null;
}

/**
 * 执行一条 guoxue.db 语句（FTS 语句面）。
 * @returns 命中的语句 → 结果；**未命中（非 FTS 语句）→ `null`**，由调用方继续处理。
 */
export function execFts5Sql(
  state: FtsMockState,
  sql: string,
  params: Array<string | number | null> = [],
): MockRows | null {
  switch (statementHead(sql)) {
    case 'SELECT':
      return execSelect(state, sql.trimStart(), params);
    case 'INSERT':
      return execInsert(state, sql.trimStart(), params);
    case 'DELETE':
      return execDelete(state, sql.trimStart(), params);
    default:
      return null;
  }
}

/** SELECT 组（分派前已确认首词为 SELECT；故 DELETE 内嵌的子查询不会再命中此处） */
function execSelect(
  state: FtsMockState,
  sql: string,
  params: Array<string | number | null>,
): MockRows | null {
  // ① 映射点查（批量 IN；主键点查，非扫描）
  if (
    /^SELECT segment_id, rid FROM segment_fts_rowid WHERE segment_id IN/.test(sql)
  ) {
    const rows = params
      .map((id) => ({
        segment_id: id,
        rid: state.ftsRidMap.get(String(id)),
      }))
      .filter((r) => r.rid !== undefined);
    return ok(rows as Array<Record<string, unknown>>);
  }
  // ② 整书同步重写前取「该书现存段 id」（`clearStaleFtsRidMap` 算差集用）
  if (/^SELECT segment_id FROM segments_fts WHERE book_id = \?/.test(sql)) {
    const rows = state.ftsRows
      .filter((r) => String(r.book_id) === String(params[0]))
      .map((r) => ({ segment_id: r.segment_id }));
    return ok(rows);
  }
  // ③ 迁移探测：映射非空？库中已有行？（O(1) 存在性）
  if (/^SELECT 1 AS hit FROM segment_fts_rowid LIMIT 1/.test(sql)) {
    return ok(state.ftsRidMap.size > 0 ? [{ hit: 1 }] : []);
  }
  if (/^SELECT 1 AS hit FROM segments_fts LIMIT 1/.test(sql)) {
    return ok(state.ftsRows.length > 0 ? [{ hit: 1 }] : []);
  }
  // ④ 迁移计数：播种后映射行数
  if (/^SELECT COUNT\(\*\) AS c FROM segment_fts_rowid/.test(sql)) {
    return ok([{ c: state.ftsRidMap.size }]);
  }
  // ⑤ 迁移计数：#16 真机自查口径 `dupes = 行数 − 去重段数`
  if (
    /^SELECT COUNT\(\*\) - COUNT\(DISTINCT segment_id\) AS d FROM segments_fts/.test(
      sql,
    )
  ) {
    const total = state.ftsRows.length;
    const distinct = new Set(state.ftsRows.map((r) => String(r.segment_id)))
      .size;
    return ok([{ d: total - distinct }]);
  }
  // ⑥ 最后一次插入的 rowid（新段登记映射用）
  if (/^SELECT last_insert_rowid\(\) AS rid/.test(sql)) {
    return ok([{ rid: state.lastInsertRid }]);
  }
  // ⑦ 计数式「整本已入索引」判据
  if (
    /^SELECT COUNT\(DISTINCT chapter_id\) AS indexed FROM segments_fts/.test(sql)
  ) {
    const chapters = new Set<string>();
    for (const r of state.ftsRows) {
      if (String(r.book_id) === String(params[0])) {
        chapters.add(String(r.chapter_id));
      }
    }
    return ok([{ indexed: chapters.size }]);
  }
  // ⑧ 存在式「该书已入索引」判据（LIMIT 1）
  if (/^SELECT 1 AS hit FROM segments_fts WHERE book_id = \? LIMIT 1/.test(sql)) {
    const hit = state.ftsRows.some(
      (r) => String(r.book_id) === String(params[0]),
    );
    return ok(hit ? [{ hit: 1 }] : []);
  }
  // ⑨ 死索引自愈：枚举现存书 id
  if (/^SELECT DISTINCT book_id FROM segments_fts/.test(sql)) {
    const seen = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const r of state.ftsRows) {
      const id = String(r.book_id);
      if (!seen.has(id)) {
        seen.add(id);
        rows.push({ book_id: id });
      }
    }
    return ok(rows);
  }
  // ⑩ SearchService 的 instr 子串检索（`ORDER BY rowid ASC` = 书序/章序）
  if (/^SELECT[\s\S]*FROM segments_fts[\s\S]*WHERE instr\(text, \?\)/.test(sql)) {
    const kw = String(params[0] ?? '');
    const hits = state.ftsRows
      .filter((r) => String(r.text ?? '').includes(kw))
      .slice()
      .sort((a, b) => Number(a.rowid ?? 0) - Number(b.rowid ?? 0))
      .map((r) => ({ ...r }));
    return ok(hits);
  }
  return null;
}

/** INSERT 组 */
function execInsert(
  state: FtsMockState,
  sql: string,
  params: Array<string | number | null>,
): MockRows | null {
  // ① 老库播种（**SELECT 形式，必须先于 VALUES 形式判定**）：
  //    每段取 `MIN(rowid)`——那正是检索（`ORDER BY rowid ASC` + 读侧保留首行）下
  //    用户实际看到的那一行
  if (
    /^INSERT OR REPLACE INTO segment_fts_rowid[\s\S]*SELECT segment_id, MIN\(rowid\) FROM segments_fts GROUP BY segment_id/.test(
      sql,
    )
  ) {
    const minRid = new Map<string, number>();
    for (const r of state.ftsRows) {
      const id = String(r.segment_id);
      const rid = Number(r.rowid);
      if (!Number.isFinite(rid)) {
        continue;
      }
      const cur = minRid.get(id);
      if (cur === undefined || rid < cur) {
        minRid.set(id, rid);
      }
    }
    for (const [id, rid] of minRid) {
      state.ftsRidMap.set(id, rid);
    }
    return ok([]);
  }
  // ② 映射表写入（VALUES 形式）：段 → rowid
  if (/^INSERT OR REPLACE INTO segment_fts_rowid/.test(sql)) {
    state.ftsRidMap.set(String(params[0]), Number(params[1]));
    return ok([]);
  }
  // ③ `segments_fts` 写入（真幂等 upsert）
  if (/^INSERT OR REPLACE INTO segments_fts/.test(sql)) {
    state.insertCalls += 1;
    const hasRowid = /\(rowid\s*,/.test(sql);
    const offset = hasRowid ? 1 : 0;
    const row: FtsMockRow = {};
    FTS_MOCK_COLS.forEach((col, i) => {
      row[col] = params[i + offset] ?? null;
    });
    if (hasRowid) {
      // 真实 FTS5：rowid=NULL ⇒ 自动分配（max+1）并追加；显式 ⇒ 冲突覆盖原位
      const given = params[0];
      const rid =
        given === null || given === undefined
          ? nextAutoRid(state)
          : Number(given);
      row.rowid = rid;
      state.lastInsertRid = rid;
      const idx = state.ftsRows.findIndex((r) => Number(r.rowid) === rid);
      if (idx >= 0) {
        state.ftsRows[idx] = row;
      } else {
        state.ftsRows.push(row);
      }
    } else {
      // 旧式（无 rowid 列）写入：真机上等于「恒追加」，此处按 segment_id 覆盖以
      // 保留历史 mock 的兼容分支（生产已不使用该形态）
      const idx = state.ftsRows.findIndex(
        (r) => r.segment_id === row.segment_id,
      );
      if (idx >= 0) {
        state.ftsRows[idx] = row;
      } else {
        state.ftsRows.push(row);
      }
    }
    return ok([]);
  }
  return null;
}

/** DELETE 组（分派前已确认首词为 DELETE ⇒ 不再与 SELECT/INSERT 处理器互相误命中） */
function execDelete(
  state: FtsMockState,
  sql: string,
  params: Array<string | number | null>,
): MockRows | null {
  // ① 映射**按书清**（删书 / 死索引自愈）。真机上是子查询
  //    `… IN (SELECT segment_id FROM segments_fts WHERE book_id = ?)`，mock 用
  //    ftsRows 复现该子查询语义：先算出该书现存段的 id，再逐个解除
  if (/^DELETE FROM segment_fts_rowid WHERE segment_id IN/.test(sql)) {
    const doomed = new Set(
      state.ftsRows
        .filter((r) => String(r.book_id) === String(params[0]))
        .map((r) => String(r.segment_id)),
    );
    for (const id of doomed) {
      state.ftsRidMap.delete(id);
    }
    return ok([]);
  }
  // ② 映射**点删**（PK 点删，无扫描）
  if (/^DELETE FROM segment_fts_rowid WHERE segment_id = \?/.test(sql)) {
    state.ftsRidMap.delete(String(params[0]));
    return ok([]);
  }
  // ③ 迁移清算遗留重复行：删「rowid ≠ 映射 rid」的同段行（真机为
  //    `WHERE rowid IN (SELECT f.rowid … JOIN segment_fts_rowid m … WHERE f.rowid <> m.rid)`；
  //    无映射的行不被 JOIN 命中 ⇒ **保留**）
  if (/^DELETE FROM segments_fts WHERE rowid IN/.test(sql)) {
    state.ftsRows = state.ftsRows.filter((r) => {
      const mapped = state.ftsRidMap.get(String(r.segment_id));
      if (mapped === undefined) {
        return true;
      }
      return Number(r.rowid) === mapped;
    });
    return ok([]);
  }
  // ④ 按书删行
  if (/^DELETE FROM segments_fts WHERE book_id = \?/.test(sql)) {
    state.ftsRows = state.ftsRows.filter(
      (r) => String(r.book_id) !== String(params[0]),
    );
    return ok([]);
  }
  return null;
}
