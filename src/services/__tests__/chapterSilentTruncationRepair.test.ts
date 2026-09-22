/**
 * 【#22】装配偶发**静默丢段 + 误判 ready-full** 的复现与修复守卫。
 *
 * QA 复验（#21）原始行（两条都打了 ready-full，同章另一次装配却是完整的）：
 *   `ready-full ch=tongjian-c169 bytes=34663 paras=148 steps=2 totalMs=2849 gen=1 pri=2`
 *   `ready-full ch=tongjian-c166 bytes=32940 paras=105 steps=2 totalMs=2173 gen=1 pri=2`
 * oracle = 资产非空行数：c169 = 156、c166 = 106。
 *
 * 本文件用**真实资产字节**做三件事：
 *  ① **字节级复现签名**：低档 32KB 批只推进第 1 批 → `segments` 恰好等于真机
 *     观测到的 148 / 105（不是「约等于」）→ 证明「批 1 已产出 + 批 2 未落盘」
 *     就是那两条原始行的形态；
 *  ② **复现「未证实完整」的生产状态**：走真实路径
 *     `fillBuiltinChapterNow(force)`（它先 `abandonStreamingAssembly` 收回游标，
 *     再整章直读；读失败即返回 false）⇒ 半章留在 `segments`、**无游标、无证明**；
 *  ③ **守修复**：该状态下 `getChapterContentQuality` 必须是 `incomplete`
 *     （旧实现 `'full'` = QA harm ①③：把半章写进 FTS 且本会话不再重装配）、
 *     零 FTS 写入、跳章装配（`assembleChapterToFull`）必须整章直读补全到
 *     **oracle 段数**；补全失败时必须**停 Partial 且有界退避**（零 native 读
 *     = 不做成新空转），退避到期后自动恢复（有出口、不锁存）。
 *
 * RNFS 照真机语义 mock：`read(...,'utf8')` = base64 → binary → `utf8.decode`
 * （`utf8@3` 严格，尾部截断抛 `Invalid byte index`）；`'base64'` 返回真实字节。
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: { android: unknown }) => o.android },
  InteractionManager: { runAfterInteractions: () => null },
}));

jest.mock('react-native-quick-sqlite', () => ({
  open: () => ({ execute: () => ({ rows: { _array: [], length: 0 } }) }),
}));

jest.mock('@/services/TextLibraryService', () => {
  const state = {
    hydrated: null as null | {
      id: string;
      chapters: Array<{
        id: string;
        bookId: string;
        title: string;
        order: number;
        segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
      }>;
    },
    hydratedIds: [] as string[],
  };
  const lib = {
    __libState: state,
    hydrateBook: (book: typeof state.hydrated) => {
      state.hydrated = book;
      if (book && !state.hydratedIds.includes(book.id)) {
        state.hydratedIds.push(book.id);
      }
      return { success: true, data: null };
    },
    getBook: (id: string) =>
      state.hydrated && state.hydrated.id === id
        ? { success: true, data: state.hydrated }
        : { success: false, error: `未找到书籍：${id}` },
    isBookHydrated: (id: string) => state.hydratedIds.includes(id),
    isUserBook: (id: string) => String(id).startsWith('user-'),
    evictBook: () => ({ success: true, data: null }),
  };
  return { TextLibraryService: lib, default: lib };
});

jest.mock('react-native-fs', () => {
  const state = {
    files: new Map<string, Buffer>(),
    assets: new Map<string, string>(),
    reads: [] as Array<{ position: number; length: number; encoding?: string }>,
    failAll: false,
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    exists: jest.fn(async (p: string) => state.files.has(p)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(
      async (p: string, length: number, position: number, encoding?: string) => {
        state.reads.push({ position, length, encoding });
        if (state.failAll) {
          throw new Error('EIO: read failed');
        }
        const buf = state.files.get(p);
        if (!buf) {
          throw new Error(`File does not exist: ${p}`);
        }
        const slice = buf.subarray(position, Math.min(position + length, buf.length));
        if (encoding === 'base64') {
          return slice.toString('base64');
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const utf8 = require('utf8') as { decode: (s: string) => string };
        return utf8.decode(slice.toString('binary'));
      },
    ),
    readFile: jest.fn(async () => ''),
    readFileAssets: jest.fn(async (p: string) => {
      const v = state.assets.get(p);
      if (v === undefined) {
        throw new Error('readFileAssets unavailable');
      }
      return v;
    }),
    writeFile: jest.fn(async () => undefined),
    appendFile: jest.fn(async () => undefined),
    copyFile: jest.fn(async () => undefined),
    copyFileAssets: jest.fn(async () => undefined),
    unlink: jest.fn(async () => undefined),
    stat: jest.fn(async (p: string) => ({
      path: p,
      size: 1024,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    })),
    readDir: jest.fn(async () => []),
    __state: state,
  };
});

jest.mock('react-native-document-picker', () => ({
  pick: jest.fn(),
  types: { allFiles: 0, plainText: 1 },
  isCancel: () => false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RNFSMock = require('react-native-fs') as {
  __state: {
    files: Map<string, Buffer>;
    assets: Map<string, string>;
    reads: Array<{ position: number; length: number; encoding?: string }>;
    failAll: boolean;
  };
};

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import {
  UserBookService,
  assembleChapterStreaming,
  getChapterContentQuality,
  __resetAssemblyStateForTests,
  __resetBuiltinLazyStateForTests,
} from '@/services/UserBookService';
import { getBuiltinSpec } from '@/data/builtinCatalog';

const BOOK = 'tongjian';
const ASSET_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'android',
  'app',
  'src',
  'main',
  'assets',
  'books',
);
const BOOK_BYTES = readFileSync(join(ASSET_DIR, `${BOOK}.txt`));
const META = JSON.parse(
  readFileSync(join(ASSET_DIR, `${BOOK}.meta.json`), 'utf8'),
) as { chapters: Array<{ id: string; t: string; s: number; e: number }> };

/** 低档切片（生产：DeviceTierService low → fillReadChunkBytes = 32 * KB） */
const LOW_TIER_CHUNK = 32 * 1024;
/** 真机观测签名（QA #21 原始行）：批 1 已产出、批 2 未落盘 */
const OBSERVED_INTERRUPTED: Record<string, number> = {
  'tongjian-c169': 148, // oracle 156（批 2 的 7 段 + 批 1 末段）
  'tongjian-c166': 105, // oracle 106（批 2 的 1 段 = 跨批末段）
};
const ORACLE_PARAS: Record<string, number> = {
  'tongjian-c169': 156,
  'tongjian-c166': 106,
};

interface RealChapter {
  id: string;
  title: string;
  s: number;
  e: number;
  bytes: Buffer;
  text: string;
  paragraphs: string[];
}

function loadRealChapter(id: string): RealChapter {
  const meta = META.chapters.find((c) => c.id === id);
  expect(meta).toBeDefined();
  const bytes = BOOK_BYTES.subarray(meta!.s, meta!.e);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const paragraphs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { id, title: meta!.t, s: meta!.s, e: meta!.e, bytes, text, paragraphs };
}

function makeChapter(ch: RealChapter): {
  id: string;
  bookId: string;
  title: string;
  order: number;
  segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
} {
  return {
    id: ch.id,
    bookId: BOOK,
    title: ch.title,
    order: 1,
    segments: [],
  };
}

function hydrateWith(chapter: ReturnType<typeof makeChapter>): void {
  (
    TextLibraryService as unknown as { hydrateBook: (b: unknown) => unknown }
  ).hydrateBook({
    id: BOOK,
    title: '资治通鉴',
    author: '司马光',
    category: 'shi',
    description: '',
    chapters: [chapter],
  });
}

/**
 * 只把「该章的字节」当书文件、把章区间设为 [0, len)：读取路径逐字节等价。
 * `loadBuiltinMeta` 会校验 `c.id === `${bookId}-c${i+1}``（1-based 下标），
 * 故用零长度占位条目把真实章顶到它自己的下标上。
 */
function installChapterFile(ch: RealChapter): void {
  const index = Number(ch.id.slice(ch.id.lastIndexOf('-c') + 2));
  expect(Number.isFinite(index)).toBe(true);
  const chapters = Array.from({ length: index }, (_, i) => ({
    id: `${BOOK}-c${i + 1}`,
    t: i + 1 === index ? ch.title : '占位',
    s: 0,
    e: i + 1 === index ? ch.bytes.length : 0,
  }));
  RNFSMock.__state.files.set(
    `${UserBookService.getBuiltinDirPath()}/${BOOK}.txt`,
    ch.bytes,
  );
  RNFSMock.__state.assets.set(
    `books/${BOOK}.meta.json`,
    JSON.stringify({ v: 1, bookId: BOOK, sizeBytes: ch.bytes.length, chapters }),
  );
}

/** 推进**恰好第 1 批**（低档 32KB + 充裕时间片 ⇒ 一步 = 一批） */
async function stepOneBatch(
  chapter: ReturnType<typeof makeChapter>,
  totalBytes: number,
): Promise<{ segmentsAfter: number; step: string }> {
  const spec = getBuiltinSpec(BOOK)!;
  const shell = {
    chapter,
    bodyLines: [] as string[],
    range: { s: 0, e: totalBytes },
  };
  const step = await assembleChapterStreaming(shell, {
    spec,
    readChunkBytes: LOW_TIER_CHUNK,
    timeBudgetMs: 1_000_000,
  });
  return { segmentsAfter: chapter.segments.length, step };
}

/**
 * 复现真机的「未证实完整」状态（真实生产路径）：
 *  `fillBuiltinChapterNow(force) 先 abandonStreamingAssembly（收回游标 = 撤销
 *  完整性证明），随后整章直读；此处让 native 读失败 ⇒ 返回 false，半章留在
 *  `segments`、无游标、无证明 —— 与 QA 那两条原始行的状态一致。
 */
async function reproduceUnprovenHalfChapter(
  ch: RealChapter,
  chapter: ReturnType<typeof makeChapter>,
): Promise<ReturnType<typeof makeChapter>> {
  const { segmentsAfter, step } = await stepOneBatch(chapter, ch.bytes.length);
  expect(step).toBe('progress'); // 本章未完成（还有未读批）
  // ★ 字节级签名复现：批 1 产出的段数 == 真机观测值（148 / 105）
  expect(segmentsAfter).toBe(OBSERVED_INTERRUPTED[ch.id]);
  RNFSMock.__state.failAll = true;
  // eslint-disable-next-line no-await-in-loop
  const ok = await UserBookService.fillBuiltinChapterNow(BOOK, ch.id, true);
  RNFSMock.__state.failAll = false;
  expect(ok).toBe(false); // 整章直读失败（全有或全无：不安装部分内容）
  expect(chapter.segments.length).toBe(OBSERVED_INTERRUPTED[ch.id]); // 半章仍在
  return chapter;
}

describe('【#22】静默丢段 + 误判 ready-full：复现与修复守卫', () => {
  let infoSpy: jest.SpyInstance;
  let upsertSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    RNFSMock.__state.files.clear();
    RNFSMock.__state.assets.clear();
    RNFSMock.__state.reads = [];
    RNFSMock.__state.failAll = false;
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    upsertSpy = jest
      .spyOn(StorageService, 'upsertFtsForChapter')
      .mockImplementation(() => ({ success: true, data: true }));
  });

  afterEach(() => {
    infoSpy.mockRestore();
    upsertSpy.mockRestore();
    __resetAssemblyStateForTests();
  });

  for (const id of ['tongjian-c169', 'tongjian-c166']) {
    test(`${id}：半章（无游标 · 无证明）⇒ 质量判 incomplete、零 FTS，跳章装配补全到 oracle ${ORACLE_PARAS[id]}`, async () => {
      const ch = loadRealChapter(id);
      installChapterFile(ch);
      const chapter = makeChapter(ch);
      hydrateWith(chapter);

      const half = await reproduceUnprovenHalfChapter(ch, chapter);

      // ── harm ①③ 的直接守卫：未证实内容**绝不**判 full / 绝不入 FTS 索引 ──
      expect(getChapterContentQuality(BOOK, ch.id)).toBe('incomplete');
      expect(upsertSpy).not.toHaveBeenCalled();

      // ── 跳章（调度器唯一入口）装配：必须整章直读补全到 oracle ──
      const ok = await UserBookService.assembleChapterToFull(BOOK, ch.id);
      expect(ok).toBe(true);
      expect(half.segments.map((s) => s.text)).toEqual(ch.paragraphs); // 156 / 106 段，逐段一致
      expect(half.segments.length).toBe(ORACLE_PARAS[id]);
      expect(getChapterContentQuality(BOOK, ch.id)).toBe('full');
      // 补全成功 ⇒ 用**完整内容**重新入索引（覆盖此前可能存在的半章行）
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      // 证据链（下次真机复验可据此判定走了哪条分支）
      const logs = infoSpy.mock.calls.map((c) => String(c[0]));
      expect(
        logs.some(
          (l) => l.includes('unproven-content') || l.includes('cursor-mismatch'),
        ),
      ).toBe(true);
    });
  }

  test('补全失败：停 Partial（有可见出口）且退避窗口内**零 native 读**（不做成新空转）；到期自动恢复', async () => {
    const ch = loadRealChapter('tongjian-c169');
    installChapterFile(ch);
    const chapter = makeChapter(ch);
    hydrateWith(chapter);

    const half = await reproduceUnprovenHalfChapter(ch, chapter);

    // ① 读通道仍坏 ⇒ 补全失败：不判就绪（阅读器提示条/重试出口生效），且不写 FTS
    RNFSMock.__state.failAll = true;
    expect(await UserBookService.assembleChapterToFull(BOOK, ch.id)).toBe(false);
    expect(getChapterContentQuality(BOOK, ch.id)).toBe('incomplete');
    expect(upsertSpy).not.toHaveBeenCalled();
    const failLogs = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(failLogs.some((l) => l.includes('repair-fail'))).toBe(true);
    expect(
      failLogs.some((l) => l.includes('backoff=') && l.includes('n=1')),
    ).toBe(true);

    // ② 退避窗口内立即重试：**不产生任何 native 读**（廉价失败，不紧循环空转）
    const readsAfterFirst = RNFSMock.__state.reads.length;
    expect(await UserBookService.assembleChapterToFull(BOOK, ch.id)).toBe(false);
    expect(await UserBookService.assembleChapterToFull(BOOK, ch.id)).toBe(false);
    expect(RNFSMock.__state.reads.length).toBe(readsAfterFirst);

    // ③ 退避到期 + 读通道恢复 ⇒ 自动补全（失败态**不锁存**，可自愈）
    RNFSMock.__state.failAll = false;
    const nowSpy = jest.spyOn(Date, 'now');
    const base = nowSpy.getMockImplementation?.() ?? Date.now;
    nowSpy.mockImplementation(() => base() + 10_000);
    const ok = await UserBookService.assembleChapterToFull(BOOK, ch.id);
    nowSpy.mockRestore();
    expect(ok).toBe(true);
    expect(half.segments.map((s) => s.text)).toEqual(ch.paragraphs);
    expect(getChapterContentQuality(BOOK, ch.id)).toBe('full');
  });

  test('正常流式推进中**不得**误报 incomplete（提示条只对「未证实」亮灯）', async () => {
    const ch = loadRealChapter('tongjian-c169');
    installChapterFile(ch);
    const chapter = makeChapter(ch);
    hydrateWith(chapter);

    const { step } = await stepOneBatch(chapter, ch.bytes.length);
    expect(step).toBe('progress');
    // 有游标且未 done、无失败证据 = 正常流式中（首屏可先上屏，用户无需提示）
    expect(getChapterContentQuality(BOOK, ch.id)).toBe('streaming');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  test('入口游标脱钩（同一章、游标被作废但半章仍在）⇒ 走 resolveCursorMismatch 补全，绝不判 done', async () => {
    const ch = loadRealChapter('tongjian-c169');
    installChapterFile(ch);
    const chapter = makeChapter(ch);
    hydrateWith(chapter);

    // 批 1 → 半章 + 有游标（登记在册）
    const { step } = await stepOneBatch(chapter, ch.bytes.length);
    expect(step).toBe('progress');
    expect(chapter.segments.length).toBe(OBSERVED_INTERRUPTED[ch.id]);

    // 游标被作废但**内容与证明都未更新**（真机形态：接管/中止后残留）
    RNFSMock.__state.failAll = true;
    expect(await UserBookService.fillBuiltinChapterNow(BOOK, ch.id, true)).toBe(false);
    RNFSMock.__state.failAll = false;

    // 再次进入流式步：新游标 segCount=0 ≠ segments.length=148 ⇒ 「未证实完整」
    // 必须整章直读补全并判 done（**不得**照旧 `segments.length > 0 ? 'done'`）
    const spec = getBuiltinSpec(BOOK)!;
    const again = await assembleChapterStreaming(
      { chapter, bodyLines: [], range: { s: 0, e: ch.bytes.length } },
      { spec, readChunkBytes: LOW_TIER_CHUNK, timeBudgetMs: 1_000_000 },
    );
    expect(again).toBe('done');
    expect(chapter.segments.map((s) => s.text)).toEqual(ch.paragraphs); // 补全到 oracle
    expect(getChapterContentQuality(BOOK, ch.id)).toBe('full');
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('cursor-mismatch'))).toBe(true);
  });

  test('陈旧壳（章对象已非书体真源）⇒ 拒绝装配：返回 failed 且不写孤儿数组', async () => {
    const ch = loadRealChapter('tongjian-c169');
    installChapterFile(ch);
    const live = makeChapter(ch);
    hydrateWith(live);
    // 重水合重建后的**旧章对象**（书体里已换成 live）
    const stale = makeChapter(ch);

    const spec = getBuiltinSpec(BOOK)!;
    const step = await assembleChapterStreaming(
      { chapter: stale, bodyLines: [], range: { s: 0, e: ch.bytes.length } },
      { spec, readChunkBytes: LOW_TIER_CHUNK, timeBudgetMs: 1_000_000 },
    );
    expect(step).toBe('failed'); // 不装配、不紧循环（调用方据此推进到其他章）
    expect(stale.segments).toHaveLength(0); // 孤儿数组零写入（纯浪费）
    expect(live.segments).toHaveLength(0); // 也没有把别人推进去
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('stale-shell'))).toBe(true);
  });

  test('口径守卫：isShellComplete 必须与 provenance 同口径；补全退避进入选章判据', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'UserBookService.ts'),
      'utf8',
    );
    const slice = (header: string): string => {
      const start = src.indexOf(header);
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf('\n}', start);
      return src.slice(start, end > start ? end : src.length);
    };
    const complete = slice('function isShellComplete(');
    // 旧写法 `segments.length > 0 && !fillCursor ⟹ true` 必须消失
    expect(complete).not.toMatch(
      /segments\.length > 0 && !shell\.fillCursor/,
    );
    expect(complete).toMatch(/chapterWholeReadComplete\.has\(key\)/);
    expect(complete).toMatch(/entry\.cursor\.done === true/);
    const selectable = slice('function isShellSelectable(');
    expect(selectable).toMatch(/chapterRepairBackoffUntil\.get\(/);
  });
});
