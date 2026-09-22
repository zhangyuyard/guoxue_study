/**
 * 【#14】真实 SQLite / FTS5 语义契约测试（用 devDependency 里的 better-sqlite3）。
 *
 * 存在理由：本仓库既有的 FTS 用例全部建立在**自研 quick-sqlite mock** 之上，
 * 而 mock 是按「我们希望 FTS5 怎么表现」写的。最典型的一处：mock 的
 * `INSERT OR REPLACE INTO segments_fts` 会按 segment_id 去重（模拟 REPLACE
 * 语义），但真实 FTS5 虚拟表 **没有唯一约束**，`INSERT OR REPLACE` 会退化成
 * 普通 INSERT —— 即「mock 全绿 ≠ 真机正确」。
 *
 * #14 之前 `no such module: fts5` 让 segments_fts 根本建不出来，FTS 写入链路
 * 在真机上从未真正跑通过，上述语义差异被「表不存在」整体掩盖；G1 让 FTS5
 * 第一次真正编译进 SQLite 后，这些真实语义会同时上线 —— 所以必须补这一层。
 *
 * 取值方式：DDL / INSERT / 检索语句均从 **app 源码逐字抽取**（而不是在测试里
 * 另抄一份），保证被测语句就是线上语句；源码改了就必然被这层拦住。
 */
// 【#16】本文件是**纯契约层**：只把 app 源码当文本抽取 SQL，再用真实 SQLite 执行，
// 不运行时导入 StorageService / SearchService（因此无需 mock 原生模块与文本库）。
// 「生产代码 × 真实 SQLite」的端到端幂等验证在 ftsIdempotencyRealSqlite.test.ts。
// 【#29】明确分工：本文件锁「语句语义」，**不构成生产写入路径的回归守卫**——
// 写入形态由文件内手写助手（`insert`）复现，改坏 StorageService 不会让它变红。

import Database from "better-sqlite3";

import { readFileSync } from "fs";
import { resolve } from "path";

const storageSrc = readFileSync(
  resolve(__dirname, "../StorageService.ts"),
  "utf8",
);
const searchSrc = readFileSync(
  resolve(__dirname, "../SearchService.ts"),
  "utf8",
);

/** 从源码中抽取模板字符串常量（逐字，含换行与缩进） */
function extractSql(source: string, decl: string): string {
  // decl 是源码字面量（可能含 `(` 等正则元字符），必须先转义再拼正则
  const escaped = decl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped} = \`([\\s\\S]*?)\`;`);
  const m = re.exec(source);
  expect(m).not.toBeNull();
  const sql = (m as RegExpExecArray)[1];
  expect(sql.trim().length).toBeGreaterThan(20);
  return sql;
}

/** app 真实建表语句（StorageService.CREATE_FTS） */
const CREATE_FTS = extractSql(storageSrc, "const CREATE_FTS");
/** app 真实写入语句（StorageService.FTS_INSERT_SQL） */
const FTS_INSERT_SQL = extractSql(storageSrc, "const FTS_INSERT_SQL");
/** app 真实检索语句（SearchService.searchInSqlite；无常量名，按模板起始字面量抽取） */
const SEARCH_SQL = (() => {
  const m = /`(SELECT segment_id[\s\S]*?)`/.exec(searchSrc);
  expect(m).not.toBeNull();
  const sql = (m as RegExpExecArray)[1];
  expect(sql).toMatch(/FROM segments_fts/);
  expect(sql).toMatch(/ORDER BY rowid ASC/);
  return sql;
})();

/** 字段序（segment_id 起，与 FTS_INSERT_SQL 的**业务列**序一致；rowid 由映射表给） */
type Row = [string, string, string, string, string, string];

let db: typeof Database.prototype;

function openFts(): typeof Database.prototype {
  const instance = new Database(":memory:");
  instance.exec(CREATE_FTS);
  return instance;
}

/**
 * 与生产 `StorageService.insertFtsRows` 逐句等价的插入辅助：
 * 已知段 → 传映射记住的 rowid（覆盖**原位**，检索顺序因此稳定）；
 * 新段 → `rowid = null`（真实 FTS5 自动分配并追加）→ 记住新 rowid。
 *
 * ⚠️ 【#29】指针（勿删，这行注释有检测力）：本函数是**文件内的手写镜像**，
 * **不是生产代码**——`StorageService` 的写入逻辑改了它不会跟着变（被 QA 实证：
 * 把生产改成「恒以 NULL rowid 追加」本文件**仍全绿**）。故本文件守的是
 * 「**SQL 语句语义**」（语句均从源码逐字抽取），**不是**写入路径的回归守卫。
 * 「生产代码 × 真实 SQLite」的端到端幂等 / 撞车回归在
 * `ftsIdempotencyRealSqlite.test.ts`（直接调用 `StorageService.upsertFtsForChapter`
 * / `upsertFtsForBook` / `deleteFtsForBook`）与 `ftsLegacyMapSeedRealSqlite.test.ts`。
 * 本文件原先的用例名/注释把它读成「已修 ⇒ 已被守卫」，故已按上述分工更正。
 */
const ridOf = new Map<string, number>();
function insert(instance: typeof Database.prototype, rows: Row[]): void {
  const stmt = instance.prepare(FTS_INSERT_SQL);
  const last = instance.prepare("SELECT last_insert_rowid() AS rid");
  for (const r of rows) {
    const known = ridOf.get(r[0]);
    stmt.run(known ?? null, ...r);
    if (known === undefined) {
      ridOf.set(r[0], Number(last.get().rid));
    }
  }
}

function countRows(instance: typeof Database.prototype): number {
  return instance.prepare("SELECT COUNT(*) AS c FROM segments_fts").get().c;
}

const LUNYU: Row = [
  "lunyu-c2-s1",
  "lunyu",
  "lunyu-c2",
  "论语",
  "为政",
  "温故而知新",
];
const YTXY: Row = [
  "ytxy-c1-s1",
  "ytxy",
  "ytxy-c1",
  "玉台新咏",
  "卷第一",
  "山有木兮木有枝",
];

beforeEach(() => {
  db = openFts();
  ridOf.clear();
});

afterEach(() => {
  db.close();
});

describe("#14 真实 SQLite/FTS5 契约（mock 无法覆盖的语义）", () => {
  test("前置：本机 SQLite 已编译 FTS5（不满足则本文件全部无意义）", () => {
    const version = db.prepare("SELECT sqlite_version() AS v").get().v;
    expect(typeof version).toBe("string");
    // 真实建表能通过即证明 FTS5 可用（前置断言失败会连带整组无意义，故显式声明）
    expect(db.prepare("SELECT COUNT(*) AS c FROM segments_fts").get().c).toBe(
      0,
    );
  });

  test("CREATE_FTS 列定义与分词器逐字生效（app 语句可被真实 FTS5 接受）", () => {
    const cols = db
      .prepare("PRAGMA table_info(segments_fts)")
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).toEqual([
      "segment_id",
      "book_id",
      "chapter_id",
      "book_title",
      "chapter_title",
      "text",
    ]);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'segments_fts'")
      .get().sql as string;
    expect(ddl).toMatch(/USING fts5\(/);
    expect(ddl).toMatch(/tokenize = 'unicode61'/);
    // UNINDEXED 列也必须落在真实 DDL 上（否则书/章冗余列会被分词，浪费索引）
    expect((ddl.match(/UNINDEXED/g) ?? []).length).toBe(5);
  });

  test("SearchService 的真实检索语句可执行并命中（instr 子串匹配，规避中文分词）", () => {
    insert(db, [LUNYU, YTXY]);

    const hit = db.prepare(SEARCH_SQL).all("温故");
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({
      segment_id: "lunyu-c2-s1",
      book_id: "lunyu",
      book_title: "论语",
      chapter_title: "为政",
      text: "温故而知新",
    });

    // 中文子串命中（FTS5 默认分词器对中文按字符切分，instr 规避该问题）
    expect(db.prepare(SEARCH_SQL).all("木有枝")).toHaveLength(1);
    // 未命中关键词不返回行（原实现依赖 rows.length === 0 触发内存回退）
    expect(db.prepare(SEARCH_SQL).all("不存在的词")).toHaveLength(0);
  });

  test("ORDER BY rowid ASC 在虚拟表上可用（结果稳定按插入序 = 书序）", () => {
    const third: Row = [
      "lunyu-c3-s1",
      "lunyu",
      "lunyu-c3",
      "论语",
      "里仁",
      "知之为知之",
    ];
    insert(db, [LUNYU, YTXY, third]);
    // 跨书命中按插入序返回（rowid 单调递增）
    expect(
      db
        .prepare(SEARCH_SQL)
        .all("知")
        .map((r: { segment_id: string }) => r.segment_id),
    ).toEqual(["lunyu-c2-s1", "lunyu-c3-s1"]);
    // 同一段内多次命中仍只返回一行（去重靠 segment 行数，不靠 text 内容）
    expect(
      db
        .prepare(SEARCH_SQL)
        .all("之")
        .map((r: { segment_id: string }) => r.segment_id),
    ).toEqual(["lunyu-c3-s1"]);
  });

  test("写入语句字段完整落库（6 列一一对应，含书名/章名冗余列）", () => {
    insert(db, [YTXY]);
    const row = db.prepare("SELECT * FROM segments_fts").get();
    expect(row).toMatchObject({
      segment_id: "ytxy-c1-s1",
      book_id: "ytxy",
      chapter_id: "ytxy-c1",
      book_title: "玉台新咏",
      chapter_title: "卷第一",
      text: "山有木兮木有枝",
    });
  });

  test("书级判据：计数式与存在判据均可执行且语义正确", () => {
    insert(db, [LUNYU, YTXY]);
    // isBookFullyIndexedInFts 的计数判据
    const counted = db
      .prepare(
        "SELECT COUNT(DISTINCT chapter_id) AS indexed FROM segments_fts WHERE book_id = ?",
      )
      .get("lunyu");
    expect(counted.indexed).toBe(1);
    // 未索引的书 → 0（调用方据此判定需要补写）
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT chapter_id) AS indexed FROM segments_fts WHERE book_id = ?",
        )
        .get("nope").indexed,
    ).toBe(0);
    // isBookIndexedInFts 的存在判据（LIMIT 1）
    expect(
      db
        .prepare("SELECT 1 AS hit FROM segments_fts WHERE book_id = ? LIMIT 1")
        .get("lunyu"),
    ).toMatchObject({ hit: 1 });
    expect(
      db
        .prepare("SELECT 1 AS hit FROM segments_fts WHERE book_id = ? LIMIT 1")
        .get("nope"),
    ).toBeUndefined();
  });

  test("deleteFtsForBook 的 DELETE 只清目标书，其他书行保留", () => {
    insert(db, [LUNYU, YTXY]);
    db.prepare("DELETE FROM segments_fts WHERE book_id = ?").run("lunyu");
    expect(countRows(db)).toBe(1);
    expect(
      db
        .prepare("SELECT book_id FROM segments_fts")
        .all()
        .map((r: { book_id: string }) => r.book_id),
    ).toEqual(["ytxy"]);
  });

  test("死索引自愈语句可用：DISTINCT book_id 枚举结果与写入一致", () => {
    insert(db, [LUNYU, YTXY]);
    expect(
      db
        .prepare("SELECT DISTINCT book_id FROM segments_fts")
        .all()
        .map((r: { book_id: string }) => r.book_id)
        .sort(),
    ).toEqual(["lunyu", "ytxy"]);
  });
});

/**
 * 【#16 已修】W1（`INSERT OR REPLACE` 在真实 FTS5 上不幂等）在本文件锁的是
 * **语句语义**（用上面的本地 `insert` 助手复现生产写入形态）。
 *
 * ⚠️ 【#29】更正：本用例此前自称「**是回归守卫**」，这是**过度声明**——它跑的是
 * 文件内的 `insert` 助手而非生产函数，改坏 `StorageService` 它不会变红（QA 已
 * 实证）。真正的「生产 × 真实 SQLite」回归守卫在 `ftsIdempotencyRealSqlite.test.ts`
 * （① 同章反复写入恒 N 行、② 覆盖原位 rowid 不变、⑧ 删书 rowid 复用后老书重写
 * 不顶掉新书 ……）。本文件的价值是**独立的第二层**：用「源码逐字抽取的语句」在
 * 真实 SQLite 上把语义钉死，生产若改了 SQL 文本，抽取会先变（`extractSql` 断言）
 * 或语义断言变红。
 *
 * 修复方式（**映射表方案**，实测依据见 `StorageService.CREATE_SEGMENT_FTS_ROWID`
 * 注释）：`FTS_INSERT_SQL` 首列改为**显式 rowid**——已入索引的段传
 * `segment_fts_rowid` 里记住的稳定 rowid（覆盖**原位**），新段传 `null`
 * （真实 FTS5 自动分配并追加）。FTS5 虽无唯一约束，但 rowid 是隐式主键 ⇒
 * `INSERT OR REPLACE` 的冲突子句终于能触发 ⇒ 同段重写覆盖同一行，
 * 且 `ORDER BY rowid ASC` 的检索顺序逐字不变。
 *
 * 被否决的替代方案（都用真实 SQLite 量过，勿重复踩）：
 *  - ❌ 哈希 docid（segment_id 派生定值）：幂等但打散 rowid ⇒ 检索顺序从
 *    书序漂移成哈希序（被本文件的 `ORDER BY rowid ASC` 断言当场抓住）。
 *  - ❌ 两段式 `DELETE WHERE segment_id` + INSERT：删除走 UNINDEXED 列
 *    全表扫描（20 万行实测 20ms/次）。
 *
 * 本用例此前是 `test.failing`（如实登记缺陷、拒绝假绿）。修复落地后必须翻成
 * 正常用例——这正是 #14 留下它的用意：谁修好了，谁就得把断言改成正向的，
 * 不能靠「把测试删掉」或「让 mock 去重」糊过去。
 */
test("#16 语句语义（本地 insert 助手）：同一段重复写入恒 1 行（显式稳定 rowid + INSERT OR REPLACE 真幂等）", () => {
  insert(db, [LUNYU]);
  insert(db, [LUNYU]); // 重水合 / 断点续写 / 两条装配路径先后写同章
  insert(db, [LUNYU]);
  expect(countRows(db)).toBe(1);
  expect(db.prepare(SEARCH_SQL).all("温故")).toHaveLength(1);
});

describe("#16 幂等 upsert 语句语义（本地 insert 助手，非生产代码）", () => {
  test("覆盖语义：内容更新后仍是同一行，且检索返回新内容", () => {
    insert(db, [LUNYU]);
    const edited: Row = [...LUNYU];
    edited[5] = "温故而知新（改）";
    insert(db, [edited]);
    expect(countRows(db)).toBe(1);
    expect(db.prepare("SELECT text FROM segments_fts").get().text).toBe(
      "温故而知新（改）",
    );
  });

  test("重写覆盖原位 ⇒ rowid 不变（检索顺序因此逐字不变）", () => {
    insert(db, [LUNYU, YTXY]);
    const before = db
      .prepare("SELECT rowid AS rid, segment_id FROM segments_fts ORDER BY rowid ASC")
      .all();
    insert(db, [LUNYU, YTXY]); // 重水合 / 两条装配路径先后写
    const after = db
      .prepare("SELECT rowid AS rid, segment_id FROM segments_fts ORDER BY rowid ASC")
      .all();
    expect(after).toEqual(before);
    expect(countRows(db)).toBe(2);
  });

  test("整章重写（40 段 → 44 段）不产生重复行，追加段落在末尾（章内序）", () => {
    const chapter = (n: number): Row[] =>
      Array.from({ length: n }, (_, i) => [
        `lunyu-c9-s${i + 1}`,
        "lunyu",
        "lunyu-c9",
        "论语",
        "子罕",
        `第${i + 1}段 温故`,
      ]);
    insert(db, chapter(40));
    insert(db, chapter(44)); // 重试/补全后段数变多（#22 修复场景）
    expect(countRows(db)).toBe(44);
    expect(db.prepare(SEARCH_SQL).all("温故")).toHaveLength(44);
    // 段序 = 追加序（章内顺序保持）
    expect(
      db
        .prepare("SELECT segment_id FROM segments_fts ORDER BY rowid ASC LIMIT 1")
        .get().segment_id,
    ).toBe("lunyu-c9-s1");
  });

  test("身份只由 segment_id 决定：书名/章名/文本变化不影响行身份（覆盖而非新增）", () => {
    insert(db, [LUNYU]);
    const renamed: Row = [
      "lunyu-c2-s1",
      "lunyu",
      "lunyu-c2",
      "论语（新装帧）",
      "为政（修订）",
      "温故而知新，可以为师矣",
    ];
    insert(db, [renamed]);
    expect(countRows(db)).toBe(1);
  });
});

describe("#14 候选修复方案的正向验证（供后续修复任务直接复用）", () => {
  test("方案 A（本次采用）：显式 rowid + INSERT OR REPLACE 在真实 FTS5 下确实幂等", () => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO segments_fts
       (rowid, segment_id, book_id, chapter_id, book_title, chapter_title, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // 任意显式 rowid：生产侧由 `segment_fts_rowid` 映射表回给「该段上次用的 rowid」
    const rid = 987654321;
    stmt.run(rid, ...LUNYU);
    stmt.run(
      rid,
      "lunyu-c2-s1",
      "lunyu",
      "lunyu-c2",
      "论语",
      "为政",
      "温故而知新（改）",
    );

    expect(countRows(db)).toBe(1);
    const row = db.prepare("SELECT text FROM segments_fts").get();
    expect(row.text).toBe("温故而知新（改）");
    expect(db.prepare(SEARCH_SQL).all("温故")).toHaveLength(1);
  });

  test("方案 B（未采用）：两段式 DELETE + INSERT 亦幂等，但章级清理要走 UNINDEXED 全表扫描", () => {
    const del = db.prepare("DELETE FROM segments_fts WHERE segment_id = ?");
    const ins = db.prepare(FTS_INSERT_SQL.replace("INSERT OR REPLACE", "INSERT"));
    const upsert = (id: string, text: string) => {
      del.run(id);
      ins.run(ridOf.get(id) ?? null, id, "lunyu", "lunyu-c2", "论语", "为政", text);
    };
    upsert("lunyu-c2-s1", "温故而知新");
    upsert("lunyu-c2-s1", "温故而知新（改）");

    expect(countRows(db)).toBe(1);
    expect(db.prepare("SELECT text FROM segments_fts").get().text).toBe(
      "温故而知新（改）",
    );
  });

  test("唯一索引在 FTS5 上真的加不上（方案 C 被否决的实测依据）", () => {
    // 若哪天 SQLite 允许了，说明写入路径可以改回单语句 + UNIQUE 约束
    expect(() =>
      db.exec("CREATE UNIQUE INDEX ux_seg ON segments_fts(segment_id)"),
    ).toThrow(/virtual tables may not be indexed/);
  });
});
