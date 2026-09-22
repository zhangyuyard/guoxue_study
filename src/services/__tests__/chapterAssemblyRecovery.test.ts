/**
 * 【#20 行为级回归】跳多批章永久空白卡死 —— 根因修复 + 用户可见出口 +
 * 失败态自愈 + 截断可见化 + 双链路互踩防护。
 *
 * 与 `builtinSliceUtf8Boundary.test.ts`（真实资产字节级对拍）互补：本文件把
 * RNFS **照真机语义** mock 出来——`read(path,len,pos,'utf8')` 与
 * react-native-fs 的 JS 包装完全一致（native base64 → `utf8.decode`，
 * `utf8@3` **严格**解码：尾部不完整序列抛 `Invalid byte index`），
 * `'base64'` 请求返回真实字节。于是「真机形态的切片读失败」可在 CI 里稳定复现。
 *
 * 覆盖（与派单要求①~⑤逐条对应）：
 *  ① 目标章装配失败必须有用户可见出口 → 见 readerChapterRecoveryWiring（渲染接线）
 *     与本文 `getChapterContentQuality` / `degradeChapterToWholeRead` 行为；
 *  ② `failedTerminal` 不得会话级不可逆 → 重进本书（reportReadingAnchor）自动解除；
 *  ③ 切片读失败原因必须打印真实 message（禁止推理猜因）→ `[PERF][slice]` 探针；
 *  ④ `ready-partial` 静默截断属红线④语义缺口 → `incomplete` 判据 + `[PERF][asm] truncated`；
 *  ⑤ 失败锁定期不得紧循环 → 指数退避 + 有界重试链（见接线测试）。
 *
 * 另含 c166「同一章两条互斥日志」的**并发/重入**归因回归：
 *  - `assembleChapterToFull` 的**孤儿游标**防护（旧登记指向被重建的旧章对象 →
 *    正文推进到孤儿 → 书体里永远为空 → `[PERF][asm] empty … discard`）；
 *  - 整章直读接管后，在飞流式步**不得重复 push** 同一批段号（游标自洽校验）。
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: { android: unknown }) => o.android },
  InteractionManager: { runAfterInteractions: () => null },
}));

jest.mock('react-native-quick-sqlite', () => ({
  open: () => ({ execute: () => ({ rows: { _array: [], length: 0 } }) }),
}));

/** 受控文本库（真实 TextLibraryService 会引入 LRU/持久化，与本题无关） */
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

/**
 * RNFS mock：**字节精确 + 真机严格 utf8 语义**。
 * `state.files` = path → Buffer；`state.assets` = path → 文本；`state.failAll` 注入 IO 失败。
 */
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
        const slice = buf.subarray(
          position,
          Math.min(position + length, buf.length),
        );
        if (encoding === 'base64') {
          return slice.toString('base64');
        }
        // ★ 与 react-native-fs FS.common.js 完全同源：
        //   base64.decode(b64) → binary string → utf8.decode(...)（严格，截断即抛）
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

import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import {
  UserBookService,
  assembleChapterStreaming,
  assembleChapterToFull,
  getChapterContentQuality,
  retryChapterAssembly,
  degradeChapterToWholeRead,
  reportReadingAnchor,
  onChapterReady,
  __resetAssemblyStateForTests,
  __resetBuiltinLazyStateForTests,
} from '@/services/UserBookService';
import {
  chapterAssemblyScheduler,
  ChapterReadiness,
} from '@/services/ChapterAssemblyScheduler';
import { getBuiltinSpec } from '@/data/builtinCatalog';

const BOOK = 'lunyu';
const CH = `${BOOK}-c1`;
const META_ASSET = `books/${BOOK}.meta.json`;

/** 低档切片大小（生产：DeviceTierService low → fillReadChunkBytes） */
const LOW_TIER_CHUNK = 32 * 1024;

/** 每行 120 个 3 字节汉字（360B）+ `\n\n` 段分隔：总量 > 32KB ⇒ 必然多批 */
const LINE = '甲'.repeat(120);
const TOTAL_LINES = 100;
const BODY = Array.from({ length: TOTAL_LINES }, () => LINE).join('\n\n') + '\n\n';
const BODY_BYTES = Buffer.from(BODY, 'utf8');
const EXPECTED_TEXTS = Array.from({ length: TOTAL_LINES }, () => LINE);
const EXPECTED_IDS = Array.from(
  { length: TOTAL_LINES },
  (_, i) => `${CH}-s${i + 1}`,
);

interface TestChapter {
  id: string;
  bookId: string;
  title: string;
  order: number;
  segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
}

function makeChapter(): TestChapter {
  return { id: CH, bookId: BOOK, title: '学而篇', order: 1, segments: [] };
}

function makeShell(chapter: TestChapter): {
  chapter: TestChapter;
  bodyLines: string[];
  range: { s: number; e: number };
} {
  return { chapter, bodyLines: [], range: { s: 0, e: BODY_BYTES.length } };
}

/** 清空受控文本库（用例隔离：陈旧壳判定依赖「书体内是否有同名章对象」） */
function resetLibrary(): void {
  const state = (TextLibraryService as unknown as {
    __libState: { hydrated: unknown; hydratedIds: string[] };
  }).__libState;
  state.hydrated = null;
  state.hydratedIds.length = 0;
}

/** 把受控章挂进受控文本库（就绪判定 / 内容落在书内章对象上） */
function hydrate(chapter: TestChapter): void {
  (TextLibraryService as unknown as {
    hydrateBook: (b: unknown) => unknown;
  }).hydrateBook({
    id: BOOK,
    title: '论语',
    author: '佚名',
    category: 'jing',
    description: '',
    chapters: [chapter],
  });
}

/** 单章装配到完成（有界步数护栏） */
async function assembleUntilDone(
  shell: ReturnType<typeof makeShell>,
  readChunkBytes = LOW_TIER_CHUNK,
): Promise<{ steps: number; last: string }> {
  const spec = getBuiltinSpec(BOOK)!;
  let last = 'progress';
  let steps = 0;
  for (; steps < 100 && last !== 'done'; steps += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes,
      timeBudgetMs: 1_000_000,
    });
  }
  return { steps, last };
}

describe('【#20】跳多批章永久空白卡死：根因（UTF-8 切点）修复后的装配行为', () => {
  let upsertChapterSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    resetLibrary(); // 文本库清空：避免上一用例的水合书体把本用例的壳判成「陈旧壳」
    RNFSMock.__state.files.clear();
    RNFSMock.__state.assets.clear();
    RNFSMock.__state.reads = [];
    RNFSMock.__state.failAll = false;
    RNFSMock.__state.files.set(
      `${UserBookService.getBuiltinDirPath()}/${BOOK}.txt`,
      BODY_BYTES,
    );
    RNFSMock.__state.assets.set(
      META_ASSET,
      JSON.stringify({
        v: 1,
        bookId: BOOK,
        sizeBytes: BODY_BYTES.length,
        chapters: [{ id: CH, t: '学而篇', s: 0, e: BODY_BYTES.length }],
      }),
    );
    upsertChapterSpy = jest
      .spyOn(StorageService, 'upsertFtsForChapter')
      .mockImplementation(() => ({ success: true, data: true }));
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    upsertChapterSpy.mockRestore();
    infoSpy.mockRestore();
    __resetAssemblyStateForTests();
  });

  test('测试前提成立：32KB 切点确实落在字符中间（真机形态可复现）', () => {
    expect(BODY_BYTES.length).toBeGreaterThan(LOW_TIER_CHUNK);
    // 非 0b10xxxxxx 才是字符边界；此处必须是 continuation 字节
    expect((BODY_BYTES[LOW_TIER_CHUNK] & 0xc0) === 0x80).toBe(true);
    expect((BODY_BYTES[LOW_TIER_CHUNK] & 0xff).toString(2)).toMatch(/^10/);
  });

  test('核心回归：低档 32KB 切片穿过多批章 → 装配到章尾、逐段完整（不丢不重）', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);

    const { last, steps } = await assembleUntilDone(shell);
    expect(last).toBe('done');
    expect(steps).toBeGreaterThan(1); // 确实多批
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(chapter.segments.map((s) => s.id)).toEqual(EXPECTED_IDS);
    expect(shell.fillCursor?.done).toBe(true);
    expect(shell.fillCursor?.failCount).toBe(0);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Full,
    );
    // 失败探针**不得**把「恢复成功」的批记为失败（只有真失败才打点）
    const failLines = infoSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[PERF][slice]'),
    );
    // 真机形态：首个 32KB 批的 utf8 解码必然抛 → 探针记录一次（且带去重）
    expect(failLines).toHaveLength(1);
    expect(String(failLines[0][0])).toMatch(/Invalid byte index/);
    // 边界对齐回落只对该批付出一次额外 native read（其余批走快路径）
    const base64Reads = RNFSMock.__state.reads.filter(
      (r) => r.encoding === 'base64',
    );
    expect(base64Reads).toHaveLength(1);
  });

  test('边界对齐回落不改变「真 IO 失败」语义：非字符串/抛错仍判失败（D1/R2-1 不变）', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    RNFSMock.__state.failAll = true;
    for (let n = 1; n <= 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const step = await assembleChapterStreaming(shell, {
        spec,
        readChunkBytes: LOW_TIER_CHUNK,
        timeBudgetMs: 1_000_000,
      });
      expect(step).toBe('failed');
      expect(shell.fillCursor?.done).toBe(false); // D1：绝不置 done
      // eslint-disable-next-line no-await-in-loop
    }
    expect(shell.fillCursor?.failCount).toBe(3);
    expect(shell.failedTerminal).toBe(true); // R2-1 阈值 3
    // 真失败探针记录的是**原始 message**（禁止推理猜因）
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes('[PERF][slice]') &&
        String(c[0]).includes('EIO: read failed'),
      ),
    ).toBe(true);
  });

  test('【②失败态自愈】重进本书（reportReadingAnchor）解除流式壳的 failedTerminal → 重试成功', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    // 打到失败终态（旧实现只清 ctx.shells，**流的壳永不解锁** = 会话级锁存）
    RNFSMock.__state.failAll = true;
    for (let n = 0; n < 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await assembleChapterStreaming(shell, {
        spec,
        readChunkBytes: LOW_TIER_CHUNK,
        timeBudgetMs: 1_000_000,
      });
    }
    expect(shell.failedTerminal).toBe(true);
    expect(getChapterContentQuality(BOOK, CH)).toBe('empty'); // 尚无正文

    // 读通道恢复 + 用户重进本书/切章（阅读器每次都会上报锚点）
    RNFSMock.__state.failAll = false;
    reportReadingAnchor(BOOK, CH, 1);
    expect(shell.failedTerminal).toBe(false);
    expect(shell.fillCursor?.failCount).toBe(0);

    // 重试即可装配完成（不必杀进程——缺陷要求②）
    const ok = await assembleChapterToFull(BOOK, CH);
    expect(ok).toBe(true);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(getChapterContentQuality(BOOK, CH)).toBe('full');
  });

  test('【④截断可见化】中途失败：保留已产出（不静默）· 就绪停 Partial · 判 incomplete · 重试可补全', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    // 批 1 成功（产出若干段），批 2 起 IO 失败
    const step1 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(step1).toBe('progress');
    const produced = chapter.segments.length;
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(TOTAL_LINES);
    // 正在流式推进（无失败证据）→ streaming（阅读器**不**提示）
    expect(getChapterContentQuality(BOOK, CH)).toBe('streaming');

    RNFSMock.__state.failAll = true;
    const ok1 = await assembleChapterToFull(BOOK, CH);
    expect(ok1).toBe(false); // 不得当 full（D1）
    expect(getChapterContentQuality(BOOK, CH)).toBe('incomplete'); // ★ 静默截断可见化
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Partial,
    );
    expect(
      infoSpy.mock.calls.some((c) => String(c[0]).includes('[PERF][asm] truncated')),
    ).toBe(true);
    // 截断章不写 FTS（搜索不得命中未上屏内容）
    expect(upsertChapterSpy).not.toHaveBeenCalled();

    // 读通道恢复 → 显式重试：清锁存 → 就绪判定回到「流式推进中」→ 补全到章尾
    RNFSMock.__state.failAll = false;
    retryChapterAssembly(BOOK, CH);
    expect(getChapterContentQuality(BOOK, CH)).toBe('streaming');
    const ok2 = await assembleChapterToFull(BOOK, CH);
    expect(ok2).toBe(true);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(getChapterContentQuality(BOOK, CH)).toBe('full');
    expect(upsertChapterSpy).toHaveBeenCalledTimes(1);
  });

  test('【降级整章直读】degradeChapterToWholeRead 用整章区间（64KB 批）一次装配完成', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    // 先流式推进一批（留下游标，模拟"卡住的半截装配"）
    await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(chapter.segments.length).toBeGreaterThan(0);

    const ok = await degradeChapterToWholeRead(BOOK, CH);
    expect(ok).toBe(true);
    // 整体替换：完整、无重复、无重复段号
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(new Set(chapter.segments.map((s) => s.id)).size).toBe(TOTAL_LINES);
    // 所有权已收回：就绪判定回到「无游标 ⟹ READY_FULL」
    expect(shell.fillCursor).toBeUndefined();
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Full,
    );
    expect(getChapterContentQuality(BOOK, CH)).toBe('full');
  });

  test('【双链路互踩防护】整章直读接管后，在飞流式步不得重复 push 同一批段号', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    await degradeChapterToWholeRead(BOOK, CH);
    const afterDegrade = chapter.segments.length;
    expect(afterDegrade).toBe(TOTAL_LINES);

    // 旧壳续作：游标自洽校验必须判其失效 → 自弃（'done'）且不新增段落
    const step = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(step).toBe('done');
    expect(chapter.segments.length).toBe(afterDegrade);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
  });

  test('【孤儿游标防护】旧登记指向被重建的旧章对象 → 装配写进**书体内**的新章对象（c166 empty-discard 归因）', async () => {
    const spec = getBuiltinSpec(BOOK)!;

    // ① 用「游离章对象」建壳并装配一批 → 登记表里留下指向游离对象的游标
    const orphanChapter = makeChapter();
    const orphanShell = makeShell(orphanChapter);
    await assembleChapterStreaming(orphanShell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(orphanChapter.segments.length).toBeGreaterThan(0);

    // ② 书体重建（重水合 / LRU 换形）：书体内是**全新**章对象且为空
    const liveChapter = makeChapter();
    hydrate(liveChapter);

    // ③ 调度器路径必须丢弃孤儿登记、装配进书体章对象
    const ok = await assembleChapterToFull(BOOK, CH);
    expect(ok).toBe(true);
    expect(liveChapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    // 未出现「empty … discard」（旧实现：推进孤儿 → 书体里永远为空）
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes('[PERF][asm] empty'),
      ),
    ).toBe(false);
  });

  test('【质量判据】empty / streaming / incomplete / full 四态互不混淆', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    expect(getChapterContentQuality(BOOK, CH)).toBe('empty'); // 空壳
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Empty,
    );

    await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(getChapterContentQuality(BOOK, CH)).toBe('streaming');

    RNFSMock.__state.failAll = true;
    await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(getChapterContentQuality(BOOK, CH)).toBe('incomplete');

    RNFSMock.__state.failAll = false;
    const { last } = await assembleUntilDone(shell);
    expect(last).toBe('done');
    expect(getChapterContentQuality(BOOK, CH)).toBe('full');
  });

  test('【⑥其他链路不受影响】fillBuiltinChapterNow（64KB 常量批）同章一次读完成、内容一致', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const ok = await UserBookService.fillBuiltinChapterNow(BOOK, CH);
    expect(ok).toBe(true);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    // 64KB > 章长 → 恰好一次 native read（无对齐回落开销）
    expect(RNFSMock.__state.reads).toHaveLength(1);
    expect(RNFSMock.__state.reads[0].encoding).toBe('utf8');
  });

  test('【重入合并·单步】同章两个并发流式步不得各 push 一遍（段号唯一、进度只推进一次）', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;
    const opts = {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    };

    // 并发两次（模拟调度器 pump 与兜底填充主循环同时命中同一章同一壳）
    const [s1, s2] = await Promise.all([
      assembleChapterStreaming(shell, opts),
      assembleChapterStreaming(shell, opts),
    ]);
    expect(s1).toBe(s2); // 同一 Promise 的执行结果
    const after = chapter.segments.length;
    expect(after).toBeGreaterThan(0);
    expect(shell.fillCursor?.segCount).toBe(after); // 游标与实际段数严格一致（无超编）
    expect(new Set(chapter.segments.map((s) => s.id)).size).toBe(after);
    // 未合并时：两个在飞步各 push 一遍 → segCount 超编（段号重复）
    expect(shell.fillCursor?.segCount).not.toBe(after * 2);
  });

  test('【游标自洽·入口】时间片让出（pendingLines 续作）后章被整体替换 → 自弃，绝不重复 push', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    // ① 让行级时间片「一产即超」：Date.now 每次调用前进 1s（restore 在 finally）
    const realNow = Date.now;
    let tick = realNow();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      tick += 1000;
      return tick;
    });
    let step1: string;
    try {
      step1 = await assembleChapterStreaming(shell, {
        spec,
        readChunkBytes: LOW_TIER_CHUNK,
        timeBudgetMs: 1,
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(step1).toBe('progress');
    const produced = chapter.segments.length;
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(TOTAL_LINES);
    expect(shell.fillCursor?.pendingLines).not.toBeNull(); // 余行留待下批

    // ② 白盒模拟：同一章对象上的 segments 被**整体替换**，而游标未收回。
    //    在产代码里这个形态的来源是慢路径壳分支（`shell.chapter.segments =
    //    paras.map(...)`，:2742）——无 range 的壳不参与流式装配、不会清游标。
    //    本用例锁定的是**不变量本身**：续作前必须先校验游标自洽
    //    （`segCount ≠ 实际段数` ⟹ 自弃），而不是「替换者一定记得清游标」。
    //    ★ 关键：此路径**不读新批**（直接吃 pendingLines），故只有入口校验能拦住它。
    chapter.segments = EXPECTED_IDS.map((id, i) => ({
      id,
      chapterId: CH,
      order: i + 1,
      text: LINE,
    }));

    const step2 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(step2).toBe('done'); // 自弃：内容已整体就位
    // 未重复 push（缺入口校验时会把 pendingLines 按旧段号续编一遍 → 190 段）
    expect(chapter.segments).toHaveLength(TOTAL_LINES);
    expect(new Set(chapter.segments.map((s) => s.id)).size).toBe(TOTAL_LINES);
    expect(shell.fillCursor).toBeUndefined(); // 陈旧游标已注销
  });

  test('【游标自洽·入口】陈旧游标绝不静默判完成：整章直读补全为完整内容', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const shell = makeShell(chapter);
    const spec = getBuiltinSpec(BOOK)!;

    const step1 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    expect(step1).toBe('progress');
    const produced = chapter.segments.length;
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(TOTAL_LINES);
    // 整体替换（白盒前提：章内容被另一条链路整体安装，而游标仍在）
    chapter.segments = EXPECTED_IDS.map((id, i) => ({
      id,
      chapterId: CH,
      order: i + 1,
      text: LINE,
    }));
    const readsBefore = RNFSMock.__state.reads.length;

    const step2 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: LOW_TIER_CHUNK,
      timeBudgetMs: 1_000_000,
    });
    // ★ 新语义（复验追加）：陈旧游标 = **完整性未证** ⇒ 绝不静默 `'done'`。
    //   这里整体替换的内容本身是完整的，但「未证」就要么走整章直读补全、
    //   要么停 Partial —— 绝不能靠「segments 非空」判完成（真机 c169 paras=148
    //   被标 ready-full 的直接原因）。
    //
    // ★★ 本条用例**删掉的旧断言**（#22 修复时替换，勿再写回）：
    //     `expect(RNFSMock.__state.reads.length).toBe(readsBefore);`
    //   出处：旧用例「【游标自洽·入口】陈旧游标续作不得再付出一次 native 读
    //   （所有权已失效）」，其注释原文为「入口校验命中即自弃：不得为『已整体就位』
    //   的章再读一次切片」。
    //   它为什么错：该断言把「陈旧游标 ⇒ 自弃 + **不读** + 直接判 done」锁成了
    //   正确行为——而「自弃」只解除游标所有权、**并不证明内容完整**。它与当时的
    //   判定句 **`segments.length > 0 && !fillCursor ⟹ 已就绪`**（`isShellComplete`
    //   旧口径）合成一个封闭的错误闭环：脱钩 ⇒ 自弃 ⇒ 无游标 + 段非空 ⇒ 判
    //   READY_FULL ⇒ 兜底填充**永久跳过**这个从未被证实的章 ⇒ 静默截断**不可自愈**
    //   （真机 `ready-full ch=tongjian-c169 paras=148`（oracle 156）正是此闭环产物）。
    //   现口径靠「整章一次性装配」的 provenance 判定，无证明就补全；故本断言反向：
    //   必须**付出**这一次整章读（`after.length === 1`），而不是「一次都不读」。
    expect(step2).toBe('done');
    expect(
      infoSpy.mock.calls.some((c) => String(c[0]).includes('[PERF][asm] cursor-mismatch')),
    ).toBe(true); // 证据链：脱钩必须留原始行
    // 补全为**完整**内容（不是停在半截）
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(chapter.segments.map((s) => s.id)).toEqual(EXPECTED_IDS);
    expect(shell.fillCursor).toBeUndefined(); // 游标已注销（所有权收回）
    expect(getChapterContentQuality(BOOK, CH)).toBe('full'); // 有「整章装配」证明
    // 补全走的是整章区间读（一次覆盖全章），而不是继续按切片续作
    const after = RNFSMock.__state.reads.slice(readsBefore);
    // ★ 收敛为**恰好一次**（本轮调整：原为 `toBeGreaterThan(0)`，只证明「读过」）：
    //   同一次脱钩只允许触发**一次**整章直读补全。若补全被反复触发（例如补全失败后
    //   仍被判就绪、或退避窗口失效），这里会 >1；这正是「选它→廉价失败→再选它」
    //   紧循环在单测层的唯一雷达。
    expect(after.length).toBe(1);
    expect(after[after.length - 1].length).toBe(BODY_BYTES.length);
  });

  test('【降级接管在飞装配】整章直读中途接管 → 在飞执行体必须判「已就绪（有内容）」而非 false', async () => {
    const chapter = makeChapter();
    hydrate(chapter);

    // 在飞装配（调度器路径）与降级整章直读并发：真实的「卡住半截 → 用户点重新加载」形态
    const inflight = assembleChapterToFull(BOOK, CH);
    const degraded = await degradeChapterToWholeRead(BOOK, CH);
    const ok = await inflight;

    expect(degraded).toBe(true);
    // ★ 语义：内容已完整（无游标 ⟹ 一次性装配完成）就必须判 READY_FULL。
    //   旧写法（`fillCursor?.done === true`）在此返回 false → 调度器记「not-ready」
    //   → 已完整的章被判非就绪 → 反复重请求（空转）。
    expect(ok).toBe(true);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(new Set(chapter.segments.map((s) => s.id)).size).toBe(TOTAL_LINES);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Full,
    );
    expect(getChapterContentQuality(BOOK, CH)).toBe('full');
  });

  test('【重入合并·整章】并发两次 assembleChapterToFull：正文不重复、FTS 与事件恰一次', async () => {
    const chapter = makeChapter();
    hydrate(chapter);
    const events: string[] = [];
    const off = onChapterReady((e) => events.push(`${e.chapterId}:${e.readiness}`));

    // 并发两个执行体（调度器 host.assemble + 显式调用方，例如用户「重新加载」）
    const [a, b] = await Promise.all([
      assembleChapterToFull(BOOK, CH),
      assembleChapterToFull(BOOK, CH),
    ]);
    off();

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(chapter.segments.map((s) => s.text)).toEqual(EXPECTED_TEXTS);
    expect(chapter.segments.map((s) => s.id)).toEqual(EXPECTED_IDS);
    expect(upsertChapterSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([`${CH}:2`]); // 恰一次 READY_FULL 事件（2 = ChapterReadiness.Full）
  });
});
