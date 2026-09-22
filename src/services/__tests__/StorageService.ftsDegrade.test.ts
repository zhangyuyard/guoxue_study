/**
 * 【#14】FTS5 未编译（android/gradle.properties 未注入 quickSqliteFlags）时的
 * 降级行为回归测试。
 *
 * 真机现象：`CREATE VIRTUAL TABLE … USING fts5` 抛 `no such module: fts5`，
 * 而旧 `ensureFtsSchema` **只缓存成功态** → 每个 READY_FULL 章都会重跑一遍
 * `initDatabase()`（4 条 CREATE IF NOT EXISTS + 4 条必然抛错的旧库迁移 ALTER，
 * 异常构造本身就有 JS 线程开销），并在 UserBookService 侧按章打印
 * `[PERF][fts] per-chapter skip`（玉台新咏级 390 章 = 390 条刷屏）。
 *
 * 本文件用「FTS 编译位可切换」的 quick-sqlite mock 锁定五条不变量：
 *   ① 正缓存：FTS 可用时结构守卫仍只探测一次（原有行为不退化）；
 *   ② 负缓存：FTS 不可用时 N 次章级写入只探测一次，initDatabase 全局只被
 *      **真实执行一次**（变异反证点：去掉负缓存后该断言必红）；
 *   ③ 解耦：FTS 建表失败不得拖累基础表 → initDatabase 仍 success、
 *      restoreHighlights 仍可用（旧实现此处会被 `建表失败` 连坐）；
 *   ④ 降级日志**一次性**（成功路径零噪音）；
 *   ⑤ 语义冻结：isBookIndexedInFts 一字未改、upsertFtsForBook / ensureFtsIndex
 *      在不可用时仍如实返回失败（不得把「没索引」伪装成成功）。
 *
 * 隔离方式：StorageService 的 FTS 可用性是**进程级模块状态**，故每个用例都用
 * `jest.resetModules()` + 重新 require 取全新模块实例，用例之间互不污染
 * （否则某个不可用用例会把后续用例一并毒化）。
 */
jest.mock("react-native-quick-sqlite", () => {
  const mockState = {
    /** FTS5 是否编译进 SQLite（false = 真机未注入 quickSqliteFlags 的现状） */
    ftsCompiled: false,
    /** 基础表 DDL（CREATE_HIGHLIGHTS）执行次数：initDatabase 基础段的执行代理 */
    baseDdlCalls: 0,
    /** 旧库迁移 ALTER 尝试次数（每次 initDatabase 固定 4 条） */
    alterAttempts: 0,
    /** `CREATE VIRTUAL TABLE … segments_fts` 尝试次数（负缓存核心观测量） */
    ftsDdlCalls: 0,
    /** segments_fts 相关业务 SQL 次数（判定不可用后必须为 0） */
    ftsSqlCalls: 0,
  };
  const ok = () => ({ rows: { _array: [], length: 0 } });
  return {
    open: () => ({
      execute: (sql: string) => {
        if (/CREATE TABLE IF NOT EXISTS highlights/.test(sql)) {
          mockState.baseDdlCalls += 1;
          return ok();
        }
        if (/ALTER TABLE/.test(sql)) {
          mockState.alterAttempts += 1;
          if (/ALTER TABLE bookmarks/.test(sql)) {
            // 真实库语义：bookmarks.note 已由 CREATE_BOOKMARKS 建出 → 该条必然抛错
            throw new Error("duplicate column name: note");
          }
          return ok();
        }
        if (/CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts/.test(sql)) {
          mockState.ftsDdlCalls += 1;
          if (!mockState.ftsCompiled) {
            // 与真机一致：SQLite 内核不含 fts5 模块
            throw new Error("no such module: fts5");
          }
          return ok();
        }
        if (/segments_fts/.test(sql)) {
          mockState.ftsSqlCalls += 1;
          if (!mockState.ftsCompiled) {
            throw new Error("no such table: segments_fts");
          }
          return ok();
        }
        return ok();
      },
    }),
    __ftsDegradeState: mockState,
  };
});

import type { Book } from "@/types";
import { readFileSync } from "fs";
import { resolve } from "path";

type StorageModule = typeof import("@/services/StorageService");

interface FtsDegradeState {
  ftsCompiled: boolean;
  baseDdlCalls: number;
  alterAttempts: number;
  ftsDdlCalls: number;
  ftsSqlCalls: number;
}

/** 取全新模块实例并按需设置「FTS5 是否已编译」 */
function loadFreshStorage(ftsCompiled: boolean): {
  storage: StorageModule;
  state: FtsDegradeState;
} {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqlite = require("react-native-quick-sqlite") as {
    __ftsDegradeState: FtsDegradeState;
  };
  sqlite.__ftsDegradeState.ftsCompiled = ftsCompiled;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const storage = require("@/services/StorageService") as StorageModule;
  return { storage, state: sqlite.__ftsDegradeState };
}

/** 构造章数可控的测试书（每章 1 段，保证章级写入非空章） */
function makeBook(id: string, chapterCount: number): Book {
  return {
    id,
    title: `测试书-${id}`,
    author: "",
    category: "user",
    description: "",
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-c${i + 1}`,
      bookId: id,
      title: `第${i + 1}章`,
      order: i + 1,
      segments: [
        {
          id: `${id}-c${i + 1}-s1`,
          chapterId: `${id}-c${i + 1}`,
          order: 1,
          text: `正文-${i + 1}`,
        },
      ],
    })),
  };
}

/** 一次 initDatabase 固定执行的旧库迁移语句条数 */
const ALTER_PER_INIT = 4;

const storageSrc = readFileSync(
  resolve(__dirname, "../StorageService.ts"),
  "utf8",
);
const usSrc = readFileSync(resolve(__dirname, "../UserBookService.ts"), "utf8");

/** 截取源码片段（从 header 起，到下一个顶层 `}` 或下一个 `\nexport ` 为止） */
function sliceFrom(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  const candidates = [
    source.indexOf("\n}", start),
    source.indexOf("\nexport ", start + 1),
  ]
    .filter((i) => i > start)
    .sort((a, b) => a - b);
  const end = candidates.length > 0 ? candidates[0] : source.length;
  const body = source.slice(start, end);
  expect(body.length).toBeGreaterThan(80);
  return body;
}

/** console.warn 采集器（降级日志断言 + 静音测试输出） */
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("#14 ① 正缓存：FTS 可用时结构守卫仍只探测一次（不退化）", () => {
  test("FTS5 已编译（对照组）：3 次章级写入全部成功，initDatabase 只跑一轮", () => {
    const { storage, state } = loadFreshStorage(true);

    const book = makeBook("ok-a", 3);
    const results = book.chapters.map((ch) =>
      storage.upsertFtsForChapter(book, ch),
    );

    expect(results.map((r) => r.success)).toEqual([true, true, true]);
    expect(state.ftsDdlCalls).toBe(1);
    expect(state.baseDdlCalls).toBe(1);
    expect(state.alterAttempts).toBe(ALTER_PER_INIT);
    // 成功路径零降级噪音
    expect(
      warnSpy.mock.calls.filter((c) => String(c[0]).includes("FTS5 不可用")),
    ).toHaveLength(0);
  });
});

describe("#14 ② 负缓存：FTS 不可用时只探测一次（变异反证点）", () => {
  test("3 次章级写入全部失败，但 initDatabase 只被真实执行一次、FTS DDL 只试一次", () => {
    const { storage, state } = loadFreshStorage(false);
    const book = makeBook("bad-a", 3);

    const results = book.chapters.map((ch) =>
      storage.upsertFtsForChapter(book, ch),
    );

    // 失败是不可用态的正常语义（调用方静默降级），错误串统一可识别
    expect(results.map((r) => r.success)).toEqual([false, false, false]);
    expect(results.every((r) => /FTS5 不可用/.test(r.error ?? ""))).toBe(true);

    // ⚠️ 变异反证锚点：去掉负缓存（unavailable 态不缓存 → 每次都 initDatabase）
    //    后这两条必红（baseDdlCalls → 3，ftsDdlCalls → 3）。
    expect(state.baseDdlCalls).toBe(1);
    expect(state.ftsDdlCalls).toBe(1);
    expect(state.alterAttempts).toBe(ALTER_PER_INIT);
    // 判定不可用后零 FTS 业务语句：不白烧 JS 线程
    expect(state.ftsSqlCalls).toBe(0);
  });

  test("章数放大到 40 章：探测次数恒为 1（真机 390 章刷屏的直接根因）", () => {
    const { storage, state } = loadFreshStorage(false);
    const book = makeBook("bad-bulk", 40);

    for (const ch of book.chapters) {
      expect(storage.upsertFtsForChapter(book, ch).success).toBe(false);
    }

    expect(state.baseDdlCalls).toBe(1);
    expect(state.ftsDdlCalls).toBe(1);
    expect(state.alterAttempts).toBe(ALTER_PER_INIT);
  });
});

describe("#14 ③ 解耦：FTS 建表失败不拖累基础表初始化", () => {
  test("initDatabase 仍 success，且 restoreHighlights 可用（旧实现被连通连坐）", () => {
    const { storage, state } = loadFreshStorage(false);

    expect(storage.initDatabase().success).toBe(true);
    expect(state.baseDdlCalls).toBe(1);

    // 备份恢复路径「init 失败即早退」：旧实现下 FTS 缺失会让整条链路不可用
    const res = storage.restoreHighlights([
      {
        id: "h-1",
        bookId: "lunyu",
        chapterId: "lunyu-c1",
        segmentId: "lunyu-c1-s1",
        startOffset: 0,
        endOffset: 4,
        color: "yellow",
        text: "学而时习之",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ restored: 1, skipped: 0 });
  });

  test("多次 initDatabase：FTS 探测只一次（基础 DDL 仍按调用次数执行）", () => {
    const { storage, state } = loadFreshStorage(false);

    storage.initDatabase();
    storage.initDatabase();
    storage.initDatabase();

    // 负缓存只作用于 FTS 探测：`CREATE VIRTUAL TABLE` 只尝试一次
    expect(state.ftsDdlCalls).toBe(1);
    // 基础段 DDL / 旧库迁移仍随显式调用执行（幂等 IF NOT EXISTS，既有语义不变；
    // 刷屏与热路径开销的根因是「按章经 ensureFtsSchema 重跑」，不是显式 init）
    expect(state.baseDdlCalls).toBe(3);
    expect(state.alterAttempts).toBe(3 * ALTER_PER_INIT);

    const degrade = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("FTS5 不可用"),
    );
    expect(degrade).toHaveLength(1);
    // 日志必须给出原始原因 + 可操作修复方向（编译期开关），而不是只报「失败」
    expect(String(degrade[0][0])).toMatch(/no such module: fts5/);
    expect(String(degrade[0][0])).toMatch(/SQLITE_ENABLE_FTS5/);
    // 且必须解释影响面（阅读不受影响），避免误判为致命错误
    expect(String(degrade[0][0])).toMatch(/阅读/);
  });
});

describe("#14 ④ 一次性跳过日志：不再按章刷屏", () => {
  test("writeFtsForReadyChapter 的跳过日志受一次性开关约束（接线守卫）", () => {
    expect(usSrc).toMatch(/let ftsPerChapterSkipLogged = false;/);
    // 【#22】写入体在 writeFtsForChapter（壳版本只是薄委托，补全链路按章直写）
    const shellBody = sliceFrom(usSrc, "function writeFtsForReadyChapter(");
    expect(shellBody).toMatch(/writeFtsForChapter\(spec, shell\.chapter\);/);
    const body = sliceFrom(usSrc, "function writeFtsForChapter(");
    expect(body).toMatch(/if \(!res\.success && !ftsPerChapterSkipLogged\) \{/);
    // 仍是静默降级：不得在装配链路抛错
    expect(body).not.toMatch(/\bthrow\b/);
    // 成功路径日志与灰度开关未被改动
    expect(body).toMatch(/if \(!R38_FTS_PER_CHAPTER\) \{\s*\n\s*return;/);
    expect(body).toMatch(
      /StorageService\.upsertFtsForChapter\(book\.data, chapter\);/,
    );
  });
});

describe("#14 ⑤ 语义冻结：既有对外行为一字未改", () => {
  test("isBookIndexedInFts 不被可用性负缓存短路（仍按原查询路径执行）", () => {
    const { storage, state } = loadFreshStorage(false);
    const before = state.ftsSqlCalls;

    expect(storage.isBookIndexedInFts("lunyu")).toBe(false);
    // 关键：函数**照旧发出了自己的 SELECT**（未被提前 return 掉）
    expect(state.ftsSqlCalls).toBe(before + 1);

    const body = sliceFrom(storageSrc, "export function isBookIndexedInFts(");
    expect(body).toMatch(
      /'SELECT 1 AS hit FROM segments_fts WHERE book_id = \? LIMIT 1'/,
    );
    expect(body).toMatch(/return rows\.length > 0;/);
    // 可用性判断不得泄漏进红线函数
    expect(body).not.toMatch(/ftsAvailability/);
    expect(body).not.toMatch(/ensureFtsSchema/);
    expect(body).not.toMatch(/FTS_UNAVAILABLE_ERROR/);
  });

  test("FTS 不可用时 upsertFtsForBook / ensureFtsIndex 仍如实返回失败（不伪装成功）", () => {
    const { storage } = loadFreshStorage(false);

    expect(storage.upsertFtsForBook(makeBook("bad-c", 1)).success).toBe(false);
    expect(storage.ensureFtsIndex().success).toBe(false);
    expect(storage.deleteFtsForBook("bad-c").success).toBe(false);
  });

  test("章级写入仍在结构就绪后单次插入该章（成功路径语义不变）", () => {
    const { storage, state } = loadFreshStorage(true);
    const book = makeBook("ok-b", 2);

    const res = storage.upsertFtsForChapter(book, book.chapters[1]);
    expect(res.success).toBe(true);
    // 结构就绪的判定发生在本章写入之前（一次 initDatabase），此后不再重跑
    expect(state.baseDdlCalls).toBe(1);
    expect(state.ftsSqlCalls + state.ftsDdlCalls).toBeGreaterThanOrEqual(1);
  });
});
