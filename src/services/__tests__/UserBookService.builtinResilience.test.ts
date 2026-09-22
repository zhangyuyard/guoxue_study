/**
 * UserBookService 内置书按需装载回归测试（2026-09-08 按需装载架构）
 * 锁定防线：
 * 1. 启动只注册目录元数据（77 部卡片 + 章节目录即刻完整可见），37MB 正文不进启动路径
 * 2. 元数据注册每进程一次（书架刷新重入绝不重置已水合书体）
 * 3. 内置书历史 db 解析缓存行清理（37MB JSON 退出 user_books），用户书行绝不误删
 * 4. sizeBytes 指纹不一致 → 覆盖复制（升级换全本资产随包静默生效）
 * 5. ensureBookLoaded 单本水合：文件解析 → hydrate，正文段落就位
 * 6. FTS 后台索引队列：逐书 upsert（幂等），不依赖内存全量注册
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = {
    userBooks: [] as Array<Record<string, unknown>>,
    /** 已执行的 DELETE FROM user_books 参数记录 */
    deletedIds: [] as unknown[],
  };
  const mockUserBookCols = ['id', 'title', 'author', 'data', 'created_at', 'source_path', 'file_sig'];
  const mockRow = (cols: string[], params: unknown[]) => {
    const row: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      row[col] = params[i] ?? null;
    });
    return row;
  };
  return {
    open: (opts: { name: string }) => {
      if (opts.name !== 'user_books.db') {
        throw new Error(`意外打开数据库：${opts.name}`);
      }
      return {
        execute: (sql: string, params: (string | number | null)[] = []) => {
          if (/INSERT OR REPLACE INTO user_books/.test(sql)) {
            const row = mockRow(mockUserBookCols, params);
            const idx = mockState.userBooks.findIndex((r) => r.id === row.id);
            if (idx >= 0) {
              mockState.userBooks[idx] = row;
            } else {
              mockState.userBooks.push(row);
            }
            return { rows: { _array: [], length: 0 } };
          }
          if (/SELECT id, title, author, data, source_path, file_sig, content_hash, created_at FROM user_books/.test(sql)) {
            return {
              rows: {
                _array: mockState.userBooks.map((r) => ({
                  ...r,
                  source_path: r.source_path ?? null,
                  file_sig: r.file_sig ?? null,
                })),
                length: mockState.userBooks.length,
              },
            };
          }
          if (/UPDATE user_books SET data = \? WHERE id = \?/.test(sql)) {
            const idx = mockState.userBooks.findIndex((r) => r.id === params[1]);
            if (idx >= 0) {
              mockState.userBooks[idx] = { ...mockState.userBooks[idx], data: params[0] };
            }
            return { rows: { _array: [], length: 0 } };
          }
          if (/DELETE FROM user_books WHERE id = \?/.test(sql)) {
            mockState.deletedIds.push(params[0]);
            mockState.userBooks = mockState.userBooks.filter((r) => r.id !== params[0]);
            return { rows: { _array: [], length: 0 } };
          }
          return { rows: { _array: [], length: 0 } };
        },
      };
    },
    __builtinResilienceState: mockState,
  };
});

/** 受控文本库：记录 registerBuiltinBooks / hydrateBook 调用（元数据 + 水合断言） */
jest.mock('@/services/TextLibraryService', () => {
  const mockLibState = {
    builtinCalls: [] as number[],
    userBooks: [] as unknown[],
    /** 最近一次 registerBuiltinBooks 注册的元数据书数组 */
    builtinLast: [] as Array<{ id: string; chapters: Array<{ id: string; segments: unknown[] }> }>,
    /** 最近一次 hydrateBook 的水合书体 */
    hydratedLast: null as { id: string; chapters: Array<{ id: string; segments: unknown[] }> } | null,
    hydratedIds: [] as string[],
  };
  const mockLib = {
    __libState: mockLibState,
    registerBuiltinBooks: (books: unknown[]) => {
      mockLibState.builtinLast = books as typeof mockLibState.builtinLast;
      mockLibState.builtinCalls.push(books.length);
      return { success: true, data: null };
    },
    hydrateBook: (book: { id: string; chapters: Array<{ id: string; segments: unknown[] }> }) => {
      mockLibState.hydratedLast = book;
      mockLibState.hydratedIds.push(book.id);
      return { success: true, data: null };
    },
    isBookHydrated: (id: string) => mockLibState.hydratedIds.includes(id),
    evictBook: () => ({ success: true, data: null }),
    setSuppressedBuiltins: () => ({ success: true, data: null }),
    registerUserBooks: (books: unknown[]) => {
      mockLibState.userBooks = books;
      return { success: true, data: null };
    },
    getBooks: () => ({ success: true, data: [...mockLibState.userBooks] }),
    getBook: (id: string) => {
      const hydrated = mockLibState.hydratedIds.includes(id)
        ? mockLibState.hydratedLast
        : mockLibState.builtinLast.find((b) => b.id === id);
      if (hydrated && hydrated.id === id) {
        return { success: true, data: hydrated };
      }
      const user = (mockLibState.userBooks as Array<{ id: string }>).find((b) => b.id === id);
      return user
        ? { success: true, data: user }
        : { success: false, error: `未找到书籍：${id}` };
    },
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

/** FTS 方法 spy 目标（真实 StorageService 的行为由用例内 spyOn 控制） */
jest.mock('react-native-fs', () => {
  const state = {
    files: new Set<string>(),
    assetsCopied: [] as string[],
    /** path -> 条目数组；值为 Error 实例时该次 readDir 抛错 */
    readDirResults: {} as Record<string, unknown[] | Error>,
    /** copyFileAssets 前 N 次调用抛错（模拟首启资产复制整体失败） */
    assetCopyFailLeft: 0,
    /** RNFS.read 的 base64 返回（内置资产分块读取内容） */
    readReply: '',
    /** path -> RNFS.read 覆盖返回（模拟单书内容损坏/空内容） */
    readReplies: {} as Record<string, string>,
    /** path -> stat.size 覆盖值（默认 128，模拟落盘文件大小指纹） */
    sizes: {} as Record<string, number>,
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    exists: jest.fn(async (path: string) => state.files.has(path)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(async (path: string) => state.readReplies[path] ?? state.readReply),
    readFile: jest.fn(async () => ''),
    readFileAssets: jest.fn(async () => {
      throw new Error('readFileAssets unavailable');
    }),
    writeFile: jest.fn(async (p: string) => {
      state.files.add(p);
    }),
    copyFileAssets: jest.fn(async (src: string, dst: string) => {
      if (state.assetCopyFailLeft > 0) {
        state.assetCopyFailLeft -= 1;
        throw new Error(`Asset '${src}' could not be opened`);
      }
      state.assetsCopied.push(src);
      state.files.add(dst);
    }),
    unlink: jest.fn(async (path: string) => {
      state.files.delete(path);
    }),
    stat: jest.fn(async (path: string) => ({
      path,
      size: state.sizes[path] ?? 128,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    })),
    readDir: jest.fn(async (path: string) => {
      const explicit = state.readDirResults[path];
      if (explicit instanceof Error) {
        throw explicit;
      }
      if (explicit) {
        return explicit;
      }
      // 动态派生：目录列表 = 已存在文件中位于该目录下的项
      return Array.from(state.files)
        .filter((f) => f.startsWith(`${path}/`))
        .map((f) => ({
          name: f.slice(f.lastIndexOf('/') + 1),
          path: f,
          isFile: () => true,
        }));
    }),
    __rnfsState: state,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __builtinResilienceState } = require('react-native-quick-sqlite');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __rnfsState } = require('react-native-fs');
import {
  UserBookService,
  getLibrarySyncDiagnostics,
  __resetBuiltinLazyStateForTests,
  __setFtsQueueYieldForTests,
  __resetAssemblyStateForTests,
  assembleChapterStreaming,
  assembleChapterToFull,
} from '@/services/UserBookService';
import {
  chapterAssemblyScheduler,
  ChapterReadiness,
} from '@/services/ChapterAssemblyScheduler';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { BUILTIN_CATALOG, getBuiltinSpec } from '@/data/builtinCatalog';

/** 取受控文本库的记录状态（mock 注入，真实类型上不存在） */
interface MockLibState {
  builtinCalls: number[];
  userBooks: unknown[];
  builtinLast: Array<{ id: string; chapters: Array<{ id: string; segments: unknown[] }> }>;
  hydratedLast: { id: string; chapters: Array<{ id: string; segments: unknown[] }> } | null;
  hydratedIds: string[];
}
function libState(): MockLibState {
  return (TextLibraryService as unknown as { __libState: MockLibState }).__libState;
}

const BUILTIN_ROW_ID = 'lunyu';
const SAMPLE_BODY = '@@CH@@学而篇\n\n子曰学而时习之。';

/** 预置一行内置书历史解析缓存（按需装载前的旧 db 状态） */
function seedBuiltinRow(): void {
  const dir = UserBookService.getBuiltinDirPath();
  __builtinResilienceState.userBooks.push({
    id: BUILTIN_ROW_ID,
    title: '论语',
    author: '佚名',
    data: JSON.stringify({
      id: BUILTIN_ROW_ID,
      title: '论语',
      author: '佚名',
      category: 'jing',
      description: '',
      chapters: [],
    }),
    created_at: 1000,
    source_path: `${dir}/${BUILTIN_ROW_ID}.txt`,
    file_sig: '123:456',
  });
}

/** 预置一行用户书缓存（清理内置行时绝不能误删） */
function seedUserRow(): void {
  __builtinResilienceState.userBooks.push({
    id: 'user-abc',
    title: '我的书',
    author: '佚名',
    data: JSON.stringify({
      id: 'user-abc',
      title: '我的书',
      author: '佚名',
      category: 'user',
      description: '',
      chapters: [],
    }),
    created_at: 2000,
    source_path: null,
    file_sig: null,
  });
}

describe('UserBookService 内置书按需装载（性能架构回归）', () => {
  let ftsIndexed: Set<string>;
  let isIndexedSpy: jest.SpyInstance;
  let upsertSpy: jest.SpyInstance;

  beforeEach(() => {
    __builtinResilienceState.userBooks = [];
    __builtinResilienceState.deletedIds = [];
    __rnfsState.files = new Set();
    __rnfsState.assetsCopied = [];
    __rnfsState.readDirResults = {};
    __rnfsState.assetCopyFailLeft = 0;
    __rnfsState.readReply = '';
    __rnfsState.readReplies = {};
    __rnfsState.sizes = {};
    __resetBuiltinLazyStateForTests();
    // 队列书间让出注入 0ms：默认 200ms×77 本会把既有队列用例拖到 15s+；
    // 注入只改节奏，门闩/竞速/逐书语义不变（默认值与注入生效由下方专用用例验证）
    __setFtsQueueYieldForTests(0);
    libState().builtinCalls = [];
    libState().builtinLast = [];
    libState().hydratedLast = null;
    libState().hydratedIds = [];
    ftsIndexed = new Set();
    isIndexedSpy = jest
      .spyOn(StorageService, 'isBookIndexedInFts')
      .mockImplementation((id: string) => ftsIndexed.has(id));
    // 生产代码走分片异步索引（同步版仅导入路径使用）：spy 分片版
    upsertSpy = jest
      .spyOn(StorageService, 'upsertFtsForBookChunked')
      .mockImplementation((book: { id: string }) => {
        ftsIndexed.add(book.id);
        return Promise.resolve({ success: true, data: true });
      });
  });

  afterEach(async () => {
    // 门闩用例启用 fake timers，此处兜底恢复，防断言失败污染后续用例
    jest.useRealTimers();
    isIndexedSpy.mockRestore();
    upsertSpy.mockRestore();
    // 【R2-3】回收在飞的 FTS 后台队列。本文件多个用例
    // `scheduleBuiltinFtsIndexBuild(0)` 启动 77 本长循环，若不清会越过
    // teardown 继续解析并 console.info → jest 报
    // 「Cannot log after tests are done」且 --detectOpenHandles 退出码 1。
    // 重置会递增队列世代号 → 队列在下一个书间/暂停轮询检查点立即返回。
    __resetBuiltinLazyStateForTests();
    // 排空已入队的微任务/0ms 定时器，确保「取消返回」在 teardown 内完成
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });

  test('启动只注册目录元数据：77 部卡片可见，目录章节 segments 为空（正文不进内存）', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);

    expect(libState().builtinCalls).toEqual([77]);
    expect(libState().builtinLast).toHaveLength(77);
    // 目录章节就位（章节计数/目录可展示），segments 全空（正文不进内存）
    for (const b of libState().builtinLast) {
      expect(b.chapters.length).toBeGreaterThan(0);
      for (const ch of b.chapters) {
        expect(ch.segments).toEqual([]);
      }
    }
    // 目录 id 与运行时解析一致（${id}-c${order} 连续编号）
    const lunyu = libState().builtinLast.find((b) => b.id === 'lunyu');
    expect(lunyu?.chapters[0]).toMatchObject({ id: 'lunyu-c1', title: '学而篇' });
  });

  test('元数据注册每进程一次：书架刷新重入不重注册、不重置已水合书体', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    await UserBookService.loadAndRegisterAll();
    await UserBookService.loadAndRegisterAll();
    expect(libState().builtinCalls).toEqual([77]);
  });

  test('内置书 db 缓存瘦身：data 清空但行保留（查重指纹不丢），用户书行不动', async () => {
    seedBuiltinRow();
    seedUserRow();
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);

    // 内置缓存行的 37MB JSON 已清空（不再拖累启动 SELECT/反解）
    const row = __builtinResilienceState.userBooks.find(
      (r: Record<string, unknown>) => r.id === BUILTIN_ROW_ID,
    );
    expect(row).toBeDefined();
    expect(row?.data).toBe('');
    // 行保留（content_hash 供导入查重：与内置书同内容的文件拒绝导入）
    expect(row?.content_hash ?? row?.file_sig).toBeDefined();
    // 无任何 DELETE（内置行不参与下架清扫，用户书行也保留）
    expect(__builtinResilienceState.deletedIds).toEqual([]);
    expect(
      __builtinResilienceState.userBooks.find((r: Record<string, unknown>) => r.id === 'user-abc'),
    ).toBeDefined();
  });

  test('sizeBytes 指纹不一致：materializeBuiltins 覆盖复制（升级换全本资产随包生效）', async () => {
    const lunyuPath = `${UserBookService.getBuiltinDirPath()}/${BUILTIN_ROW_ID}.txt`;
    __rnfsState.files.add(lunyuPath);
    __rnfsState.sizes[lunyuPath] = 8023;
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);
    expect(__rnfsState.assetsCopied).toContain(`books/${BUILTIN_ROW_ID}.txt`);
  });

  test('sizeBytes 指纹一致：不重复复制（其余 76 部缺文件仍正常物化）', async () => {
    const lunyuPath = `${UserBookService.getBuiltinDirPath()}/${BUILTIN_ROW_ID}.txt`;
    __rnfsState.files.add(lunyuPath);
    const spec = getBuiltinSpec(BUILTIN_ROW_ID);
    __rnfsState.sizes[lunyuPath] = spec ? spec.sizeBytes : 0;
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);
    expect(__rnfsState.assetsCopied).not.toContain(`books/${BUILTIN_ROW_ID}.txt`);
    expect(__rnfsState.assetsCopied).toHaveLength(76);
  });

  test('ensureBookLoaded：单本文件解析 → hydrate 正文段落就位', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    __rnfsState.readReply = Buffer.from(SAMPLE_BODY, 'utf8').toString('base64');

    const res = await UserBookService.ensureBookLoaded(BUILTIN_ROW_ID);
    expect(res.success).toBe(true);

    expect(libState().hydratedLast).not.toBeNull();
    expect(libState().hydratedLast?.id).toBe(BUILTIN_ROW_ID);
    const chapters = libState().hydratedLast?.chapters ?? [];
    expect(chapters).toHaveLength(1);
    expect(chapters[0].id).toBe(`${BUILTIN_ROW_ID}-c1`);
    expect(chapters[0].segments.length).toBeGreaterThan(0);
    expect(getLibrarySyncDiagnostics().builtinParseFailures).toEqual([]);
  });

  test('ensureBookLoaded：落盘文件指纹不一致先覆盖补写再解析（自愈）', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    const lunyuPath = `${UserBookService.getBuiltinDirPath()}/${BUILTIN_ROW_ID}.txt`;
    __rnfsState.files.add(lunyuPath);
    __rnfsState.sizes[lunyuPath] = 8023;
    __rnfsState.readReply = Buffer.from(SAMPLE_BODY, 'utf8').toString('base64');

    const res = await UserBookService.ensureBookLoaded(BUILTIN_ROW_ID);
    expect(res.success).toBe(true);
    // 指纹不一致触发了覆盖复制，随后解析成功水合
    expect(__rnfsState.assetsCopied).toContain(`books/${BUILTIN_ROW_ID}.txt`);
    expect(libState().hydratedIds).toContain(BUILTIN_ROW_ID);
  });

  test('FTS 后台索引队列：逐书解析 upsert（已入索引跳过），不经内存注册', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    __rnfsState.readReply = Buffer.from(SAMPLE_BODY, 'utf8').toString('base64');
    // 预置两本已入索引（应被跳过）
    ftsIndexed.add('lunyu');
    ftsIndexed.add('daodejing');

    UserBookService.scheduleBuiltinFtsIndexBuild(0);
    // 队列串行逐书让出（beforeEach 已注入 0ms），轮询等待跑完（上限 5s 防挂死）
    for (let i = 0; i < 250 && upsertSpy.mock.calls.length < 75; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // 只为未入索引的书 upsert；水合注册零调用（不经 TextLibraryService）
    expect(upsertSpy).toHaveBeenCalledTimes(75);
    expect(libState().builtinCalls).toEqual([]);
    expect(libState().hydratedIds).toEqual([]);
  });

  test('用户优先门闩：水合期间 FTS 队列暂停（书间检查点等待），越过门闩后恢复索引', async () => {
    jest.useFakeTimers();
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    __rnfsState.readReply = Buffer.from(SAMPLE_BODY, 'utf8').toString('base64');

    // 用户先点卡片：ensureBookLoaded 任务体同步置位门闩（Date.now()+30s）
    const hydrate = UserBookService.ensureBookLoaded(BUILTIN_ROW_ID);
    // fake timers 下放行 yieldToJs 的 setTimeout(0) 与 RNFS mock 的微任务链
    await jest.advanceTimersByTimeAsync(0);
    await hydrate;
    expect(libState().hydratedIds).toContain(BUILTIN_ROW_ID);

    // loadAndRegisterAll 的自动排队被重置钩子关闭（防 10s 挂起定时器），
    // 这里显式 0 延迟排队（与既有 FTS 队列用例同口径）
    UserBookService.scheduleBuiltinFtsIndexBuild(0);

    // 推进 15s：队列已进入首本书的书间检查点，
    // 但门闩（t≈0s 置位的 +30s）未过期 → 零解析零 upsert
    await jest.advanceTimersByTimeAsync(15_000);
    expect(upsertSpy).not.toHaveBeenCalled();

    // 再推进 30s（t=45s > 门闩过期点 30s）：检查点轮询解禁，队列恢复逐书索引
    await jest.advanceTimersByTimeAsync(30_000);
    expect(upsertSpy).toHaveBeenCalledTimes(77);
    expect(libState().hydratedIds).toEqual([BUILTIN_ROW_ID]);
  });

  test('队列书间让出注入生效：__setFtsQueueYieldForTests(50) 后书间隔 ≥50ms', async () => {
    // 覆写 beforeEach 注入的 0ms：若注入不生效，书间隔≈0 会让断言失败
    __setFtsQueueYieldForTests(50);
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    __rnfsState.readReply = Buffer.from(SAMPLE_BODY, 'utf8').toString('base64');

    // 只留两本未入索引，测量一次真实的书间让出间隔
    for (const spec of BUILTIN_CATALOG) {
      if (spec.id !== 'lunyu' && spec.id !== 'daodejing') {
        ftsIndexed.add(spec.id);
      }
    }
    const upsertStamps: number[] = [];
    upsertSpy.mockImplementation((book: { id: string }) => {
      upsertStamps.push(Date.now());
      ftsIndexed.add(book.id);
      return Promise.resolve({ success: true, data: true });
    });

    UserBookService.scheduleBuiltinFtsIndexBuild(0);
    for (let i = 0; i < 100 && upsertStamps.length < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    expect(upsertStamps).toHaveLength(2);
    // 两本书之间必须隔 ≥50ms（注入的下限；setTimeout 竞速只会更晚不更早）
    expect(upsertStamps[1] - upsertStamps[0]).toBeGreaterThanOrEqual(45);

    // 排空残余队列：剩余 75 本虽被 ftsIndexed 跳过解析，但仍逐书让出
    //（50ms×75 真实定时器会拖住 jest worker 触发 force-exit 警告）——
    // 注入回 0ms 让队列立刻跑完
    __setFtsQueueYieldForTests(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });

  test('ensureBookReady 首章优先：只装配目标章即上屏，其余空壳由后台填充补齐并入索引', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    const multiBody =
      '@@CH@@第一篇\n\n甲内容。\n\n@@CH@@第二篇\n\n乙内容。\n\n@@CH@@第三篇\n\n丙内容。';
    __rnfsState.readReply = Buffer.from(multiBody, 'utf8').toString('base64');
    const fillTicks: string[] = [];
    const off = UserBookService.onBuiltinFillProgress((id) => fillTicks.push(id));

    const res = await UserBookService.ensureBookReady(BUILTIN_ROW_ID, {
      priorityChapterId: `${BUILTIN_ROW_ID}-c2`,
    });
    expect(res.success).toBe(true);

    // 首屏书体：目录完整（3 章），只有目标章 c2 有正文，c1/c3 为空壳
    expect(libState().hydratedLast?.id).toBe(BUILTIN_ROW_ID);
    const chapters = libState().hydratedLast?.chapters ?? [];
    expect(chapters).toHaveLength(3);
    expect(chapters[1].id).toBe(`${BUILTIN_ROW_ID}-c2`);
    expect(chapters[1].segments.length).toBeGreaterThan(0);
    expect(chapters[0].segments).toHaveLength(0);
    expect(chapters[2].segments).toHaveLength(0);

    // 后台填充：全部章节正文就位、进度回调触发、顺带入 FTS 索引
    for (
      let i = 0;
      i < 50 &&
      (libState().hydratedLast?.chapters ?? []).some((c) => c.segments.length === 0);
      i += 1
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(
      (libState().hydratedLast?.chapters ?? []).every((c) => c.segments.length > 0),
    ).toBe(true);
    expect(fillTicks).toContain(BUILTIN_ROW_ID);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: BUILTIN_ROW_ID }),
      // 分片版第二参数：用户优先门闩片间生效
      expect.objectContaining({ shouldPause: expect.any(Function) }),
    );
    off();
  });

  test('ensureBookReady 填充完成顺带入 FTS 索引恰一次（多批填充全量就位）', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    // 31 章：填充分两批（30+1），覆盖多批合并路径
    const parts: string[] = [];
    for (let i = 1; i <= 31; i += 1) {
      parts.push(`@@CH@@第${i}篇\n\n这是第${i}篇的正文内容。`);
    }
    __rnfsState.readReply = Buffer.from(parts.join('\n\n'), 'utf8').toString('base64');

    const p = UserBookService.ensureBookReady(BUILTIN_ROW_ID, {
      priorityChapterId: `${BUILTIN_ROW_ID}-c1`,
    });
    const res = await p;
    expect(res.success).toBe(true);
    expect(libState().hydratedIds).toContain(BUILTIN_ROW_ID);

    // 等后台填充收尾（31 章两批，0ms 让出，真实计时器毫秒级；上限 5s 防挂死）
    for (
      let i = 0;
      i < 250 &&
      (libState().hydratedLast?.chapters ?? []).some((c) => c.segments.length === 0);
      i += 1
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    // 填充完成后书体已在内存：顺带入 FTS 索引恰一次（省队列重复解析；
    // 队列侧 isBookIndexedInFts 已索引跳过的幂等守卫由既有队列用例覆盖）
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ id: BUILTIN_ROW_ID });
    // 全部章节正文就位（多批填充完成）
    expect(
      (libState().hydratedLast?.chapters ?? []).every((c) => c.segments.length > 0),
    ).toBe(true);
  });
});

/**
 * D1 截断防护 / G1「FTS 仅 READY_FULL 后写」的行为级守卫。
 *
 * 缺陷复现（D1）：切片读失败时旧实现置 `cur.done = true` 并返回 failed，
 * 于是「已产出但截断」的章被 `isShellComplete` / `builtinChapterReadiness`
 * 判为 READY_FULL（Full）——调度器 `request()` 短路、后台填充跳过，
 * **永不重试** = 不可逆截断章。
 *
 * 变异捕获（G1）：把 `assembleChapterToFull` 的 `if (full)` 改成 `if (true)`
 * 时，本文件「失败后不得写 FTS」的断言必须失败（此前 94 个用例全绿）。
 */
describe('D1/G1：切片读失败不得标记 READY_FULL（截断防护 + FTS 门控 + 可重试）', () => {
  const BOOK = 'lunyu';
  const CH = `${BOOK}-c1`;
  /** 单批读失败注入：第 N 次 RNFS.read 返回非字符串 → readBuiltinChapterSlice 判失败 */
  let readMock: jest.Mock;
  let readFileAssetsMock: jest.Mock;
  let restoreRead: (() => void) | null;
  let restoreReadFileAssets: (() => void) | null;

  /** 受控正文：每行 200 字符，总长 > 单批上限（低/中档 32~64KB）→ 必然多批 */
  const LINE = '甲'.repeat(200);
  const TOTAL_LINES = 400;
  const BODY = Array.from({ length: TOTAL_LINES }, () => LINE).join('\n') + '\n';

  /** 手搓流式壳（与 buildBuiltinChapterShells 同形：chapter + range） */
  function makeShell(): {
    chapter: {
      id: string;
      bookId: string;
      title: string;
      order: number;
      segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
    };
    bodyLines: string[];
    range: { s: number; e: number };
  } {
    return {
      chapter: {
        id: CH,
        bookId: BOOK,
        title: '学而篇',
        order: 1,
        segments: [],
      },
      bodyLines: [],
      range: { s: 0, e: BODY.length },
    };
  }

  /** 把受控章体挂进「受控文本库」的书体（就绪判定读的是书内章对象） */
  function hydrateWithChapter(chapter: unknown): void {
    libState().hydratedIds.push(BOOK);
    libState().hydratedLast = {
      id: BOOK,
      chapters: [chapter as { id: string; segments: unknown[] }],
    };
  }

  beforeEach(() => {
    __builtinResilienceState.userBooks = [];
    __builtinResilienceState.deletedIds = [];
    __rnfsState.readDirResults = {};
    __rnfsState.readReply = '';
    __rnfsState.readReplies = {};
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    libState().builtinCalls = [];
    libState().builtinLast = [];
    libState().hydratedLast = null;
    libState().hydratedIds = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfs = require('react-native-fs') as {
      read: jest.Mock;
      readFileAssets: jest.Mock;
    };
    readMock = rnfs.read;
    readFileAssetsMock = rnfs.readFileAssets;
    const readImpl = readMock.getMockImplementation();
    const assetsImpl = readFileAssetsMock.getMockImplementation();
    restoreRead = readImpl
      ? () => {
          readMock.mockReset();
          readMock.mockImplementation(readImpl);
        }
      : null;
    restoreReadFileAssets = assetsImpl
      ? () => {
          readFileAssetsMock.mockReset();
          readFileAssetsMock.mockImplementation(assetsImpl);
        }
      : null;
  });

  afterEach(() => {
    // 恢复模块工厂给的默认实现（后续用例仍按 readReply / readFileAssets 抛错工作）
    restoreRead?.();
    restoreReadFileAssets?.();
    __resetAssemblyStateForTests();
  });

  test('D1 读失败：返回 failed 且游标未 done；readiness 不进 Full，可自同位置续作', async () => {
    const spec = getBuiltinSpec(BOOK)!;
    const shell = makeShell();
    hydrateWithChapter(shell.chapter);

    const okRead = async (_p: string, len: number, pos: number) =>
      BODY.slice(pos, pos + len);
    const failRead = async () => undefined; // 非字符串 → 切片读失败
    readMock
      .mockImplementationOnce(okRead) // 批 1：成功（产出若干段，返回 progress）
      .mockImplementationOnce(failRead) // 批 2：读失败
      .mockImplementation(okRead); // 此后恢复（模拟瞬时失败自愈）

    // 批 1：进度推进（多批正文 → 不可能一步到章尾）
    const step1 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: 4096,
      timeBudgetMs: 1_000_000,
    });
    expect(step1).toBe('progress');
    const segsAfterBatch1 = shell.chapter.segments.length;
    expect(segsAfterBatch1).toBeGreaterThan(0);

    // 批 2：读失败 —— ★ 核心：不得置 done（旧实现置 done → 不可逆截断章）
    const step2 = await assembleChapterStreaming(shell, {
      spec,
      readChunkBytes: 4096,
      timeBudgetMs: 1_000_000,
    });
    expect(step2).toBe('failed');
    expect(shell.fillCursor?.done).toBe(false);
    expect(shell.chapter.segments).toHaveLength(segsAfterBatch1); // 已产出保留
    // ★ readiness 不得进 Full（Partial 才可被调度器/兜底重试）
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Partial,
    );

    // 批 3+：读恢复 → 自同一 bytePos 续作到章尾（进度不丢、段落不重/不截断）
    let step = step2;
    for (let i = 0; i < 200 && step !== 'done'; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      step = await assembleChapterStreaming(shell, {
        spec,
        readChunkBytes: 4096,
        timeBudgetMs: 1_000_000,
      });
      expect(step).not.toBe('failed');
    }
    expect(step).toBe('done');
    expect(shell.fillCursor?.done).toBe(true);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Full,
    );
    // 段落完整且无重复（段号续编 = 不重不截）
    expect(shell.chapter.segments.map((s) => s.text)).toEqual(
      Array.from({ length: TOTAL_LINES }, () => LINE),
    );
    expect(shell.chapter.segments.map((s) => s.id)).toEqual(
      Array.from({ length: TOTAL_LINES }, (_, i) => `${CH}-s${i + 1}`),
    );
  });

  test('G1/D1 调度器路径：装配失败（Partial）绝不写 FTS；跑到 READY_FULL 才写且恰一次', async () => {
    // 注入受控 meta：单章覆盖整个正文区间（loadBuiltinMeta 校验 1-based id）
    readFileAssetsMock.mockImplementation(async (p: string) => {
      if (p === `books/${BOOK}.meta.json`) {
        return JSON.stringify({
          v: 1,
          bookId: BOOK,
          sizeBytes: BODY.length,
          chapters: [{ id: CH, t: '学而篇', s: 0, e: BODY.length }],
        });
      }
      throw new Error('readFileAssets unavailable');
    });
    // 书体已水合，目标章为空壳（segments 空 → 走流式装配）
    const shell = makeShell();
    hydrateWithChapter(shell.chapter);
    const upsertChapterSpy = jest
      .spyOn(StorageService, 'upsertFtsForChapter')
      .mockImplementation(() => ({ success: true, data: true }));

    const okRead = async (_p: string, len: number, pos: number) =>
      BODY.slice(pos, pos + len);
    readMock
      .mockImplementationOnce(okRead) // 批 1：成功
      .mockImplementationOnce(async () => undefined) // 批 2：失败
      .mockImplementation(okRead);

    // ① 失败路径：不得进 READY_FULL，且 **绝不写 FTS**（G1 变异捕获点）
    const ok1 = await assembleChapterToFull(BOOK, CH);
    expect(ok1).toBe(false);
    // 已产出段落保留（证明失败发生在流式装配**中途**，而非空壳早退）：
    // 若失败被误判为 READY_FULL，被截断的章会带着这半份正文冻结。
    // 注：调度器路径自建内部壳（`{ chapter, bodyLines, range }`），
    // `shell.fillCursor` 不在本用例持有的壳对象上；就绪真源是内部游标，
    // 由 `readinessOf`（`builtinChapterReadiness`：游标未 done → Partial）
    // 间接观测，等价且是本层唯一对外可观测信号。
    expect(shell.chapter.segments.length).toBeGreaterThan(0);
    expect(shell.chapter.segments.length).toBeLessThan(TOTAL_LINES);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Partial,
    );
    expect(upsertChapterSpy).not.toHaveBeenCalled();

    // ② 重试成功：READY_FULL 之后才写 FTS，且恰一次
    const ok2 = await assembleChapterToFull(BOOK, CH);
    expect(ok2).toBe(true);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CH)).toBe(
      ChapterReadiness.Full,
    );
    expect(upsertChapterSpy).toHaveBeenCalledTimes(1);
    expect(upsertChapterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: BOOK }),
      expect.objectContaining({ id: CH }),
    );
    // 装配结果完整（重试后不截断、不重复）
    expect(shell.chapter.segments).toHaveLength(TOTAL_LINES);

    upsertChapterSpy.mockRestore();
  });
});

/**
 * R2-1 填充失败终止条件（高危回归修复）/ R2-2+G7 填充路径 FTS 门控行为断言 /
 * G5 §4.4 双检查点（`ftsCheckpointPaused`）接线行为断言。
 *
 * R2-1 缺陷复现：D1 去掉失败路径的 `cur.done = true`（截断防护）之后，填充
 * 主循环的选章判据仍是「未就绪即候选」——失败章永不就绪 → **每轮都被重新
 * 选中**，且 `step === 'failed'` 之后 `inProgress` 复位 → 无退避、无上限的
 * 紧循环（QA 实证：700ms 内 read 调用 175271 → 344932 → 510500，不收敛；
 * `ctx.running` 永不复位、后续章永不填充）。
 *
 * R2-2 缺陷复现：填充路径 `if (step !== 'progress')` 把 `'failed'` 也当作
 * 就绪写章级 FTS，而调度器路径是严格 `if (full)` —— 两条路径语义不一致，
 * 搜索会命中「尚未上屏的整章」，且会让整书计数判据误判为已索引完成。
 */
describe('R2-1/R2-2：填充失败终止条件 + FTS 仅 READY_FULL 后写', () => {
  const BOOK = 'lunyu';
  const CHS = [`${BOOK}-c1`, `${BOOK}-c2`, `${BOOK}-c3`];
  /** 每章 2 行；单章区间远小于单批读取上限 → 一次装配即到章尾 */
  const LINE = '甲'.repeat(120);
  const BLOCK = `${LINE}\n${LINE}\n`;
  /** 三章受控正文（mock 切片单位 = 本字符串下标，与实际编码无关） */
  const BODY3 = BLOCK + BLOCK + BLOCK;
  const RANGES = [0, 1, 2].map((i) => ({
    s: i * BLOCK.length,
    e: (i + 1) * BLOCK.length,
  }));
  /** R2-1 阈值（生产常量）：连续失败达此值 → failedTerminal */
  const FAIL_TERMINAL_THRESHOLD = 3;

  let readMock: jest.Mock;
  let readFileAssetsMock: jest.Mock;
  let restoreRead: (() => void) | null;
  let restoreReadFileAssets: (() => void) | null;

  beforeEach(() => {
    __builtinResilienceState.userBooks = [];
    __builtinResilienceState.deletedIds = [];
    __rnfsState.readDirResults = {};
    __rnfsState.readReply = '';
    __rnfsState.readReplies = {};
    __rnfsState.sizes = {};
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    libState().builtinCalls = [];
    libState().builtinLast = [];
    libState().hydratedLast = null;
    libState().hydratedIds = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfs = require('react-native-fs') as {
      read: jest.Mock;
      readFileAssets: jest.Mock;
    };
    readMock = rnfs.read;
    readFileAssetsMock = rnfs.readFileAssets;
    const readImpl = readMock.getMockImplementation();
    const assetsImpl = readFileAssetsMock.getMockImplementation();
    restoreRead = readImpl
      ? () => {
          readMock.mockReset();
          readMock.mockImplementation(readImpl);
        }
      : null;
    restoreReadFileAssets = assetsImpl
      ? () => {
          readFileAssetsMock.mockReset();
          readFileAssetsMock.mockImplementation(assetsImpl);
        }
      : null;
  });

  afterEach(async () => {
    restoreRead?.();
    restoreReadFileAssets?.();
    __resetAssemblyStateForTests();
    // 【R2-3】G5 用例会真实启动 FTS 后台索引队列（delay=0、书间 200ms、77 本
    // ≈ 15s+），若不清会越过本文件 teardown 继续解析并 console.info
    //（jest 报「Cannot log after tests are done」、--detectOpenHandles 退出码 1）。
    // 重置递增队列世代号 → 队列在下一个书间/暂停轮询检查点立即返回。
    __resetBuiltinLazyStateForTests();
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });

  test('R2-1⑤：连续失败 3 次 → 失败终态（非就绪）；1/2 次记递增退避，不紧循环', async () => {
    const spec = getBuiltinSpec(BOOK)!;
    // 该章字节区间**持续读失败**
    readMock.mockImplementation(async () => undefined);
    const shell = {
      chapter: {
        id: CHS[0],
        bookId: BOOK,
        title: '一',
        order: 1,
        segments: [] as Array<{ id: string; text: string }>,
      },
      bodyLines: [] as string[],
      range: { ...RANGES[0] },
    };

    // 第 1、2 次失败：未达上限 → 只记失败计数 + 退避截止（失败之间不空转）
    for (const n of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const step = await assembleChapterStreaming(shell, { spec });
      expect(step).toBe('failed');
      expect(shell.fillCursor?.done).toBe(false); // D1：绝不置 done
      expect(shell.fillCursor?.failCount).toBe(n);
      expect(shell.failedTerminal).toBeUndefined(); // 未达上限不放弃
      expect(shell.fillCursor?.failBackoffUntil ?? 0).toBeGreaterThan(
        Date.now(),
      );
    }

    // 第 3 次：达阈值 → 失败终态（本批跳过该壳，主循环因此必然推进并返回）
    const step3 = await assembleChapterStreaming(shell, { spec });
    expect(step3).toBe('failed');
    expect(shell.fillCursor?.failCount).toBe(FAIL_TERMINAL_THRESHOLD);
    expect(shell.failedTerminal).toBe(true);
    // ★ 语义区分（R2-1 核心要求）：终态**不等于**就绪 ——
    //   就绪真源 `done` 仍为 false，故 isShellComplete / 就绪判定 / FTS 写入
    //   均不会把该章当 Full（失败章不得被当成就绪）。
    expect(shell.fillCursor?.done).toBe(false);
  });

  test('R2-1①②③④ + R2-2/G7：持续读失败的主循环必然返回（不烧 CPU）、其余章继续填充、失败章不写 FTS', async () => {
    const spec = getBuiltinSpec(BOOK)!;
    const canonicalPath = `${UserBookService.getBuiltinDirPath()}/${BOOK}.txt`;
    // 大小指纹对齐 → ensureBookReady 走 meta 快路径（产生带 range 的壳）
    __rnfsState.sizes[canonicalPath] = spec.sizeBytes;
    readFileAssetsMock.mockImplementation(async (p: string) => {
      if (p === `books/${BOOK}.meta.json`) {
        return JSON.stringify({
          v: 1,
          bookId: BOOK,
          sizeBytes: spec.sizeBytes,
          chapters: [
            { id: CHS[0], t: '一', s: RANGES[0].s, e: RANGES[0].e },
            { id: CHS[1], t: '二', s: RANGES[1].s, e: RANGES[1].e },
            { id: CHS[2], t: '三', s: RANGES[2].s, e: RANGES[2].e },
          ],
        });
      }
      throw new Error('readFileAssets unavailable');
    });
    // c1 区间**持续失败**；c2/c3 正常切片（G7：注入读失败的核心手段）
    let readCalls = 0;
    let failCalls = 0;
    readMock.mockImplementation(async (_p: string, len: number, pos: number) => {
      readCalls += 1;
      if (pos >= RANGES[0].s && pos < RANGES[0].e) {
        failCalls += 1;
        return undefined; // 非字符串 → readBuiltinChapterSlice 判失败
      }
      return BODY3.slice(pos, pos + len);
    });
    const upsertChapterSpy = jest
      .spyOn(StorageService, 'upsertFtsForChapter')
      .mockImplementation(() => ({ success: true, data: true }));

    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    const res = await UserBookService.ensureBookReady(BOOK, {
      priorityChapterId: CHS[1],
    });
    expect(res.success).toBe(true);
    // 后台填充是 `void fillRemainingBuiltinChapters(...)`（内部先 yieldToJs 让出
    // 一拍再开跑）→ ensureBookReady resolve 时填充尚未开始，先轮询等首次失败
    for (let i = 0; i < 40 && failCalls === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(failCalls).toBeGreaterThanOrEqual(1); // 持续失败确实被触发

    // 收敛窗口：给「死循环版本」充分的暴露时间（QA 实证 700ms 可烧 17 万次读）
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 25));
    }

    // ① 有限次调用内退出：本轮总读取次数有界（死循环版本为 10^5 量级）
    //    本轮理论值 ≈ 3（c2 目标章 1 + c1 失败 1 + c3 填充 1）；
    //    无锚点 → 不排空闲心跳（armIdleHeartbeatIfNeeded 要求 anchorIdx >= 0）
    expect(readCalls).toBeLessThanOrEqual(10);
    expect(failCalls).toBe(1); // 失败一次即退避让位，不反复重试同一章

    // ② 失败章不进 READY_FULL（终态 ≠ 就绪）
    expect(chapterAssemblyScheduler.readinessOf(BOOK, CHS[0])).not.toBe(
      ChapterReadiness.Full,
    );
    // ③ 不写该章 FTS（G7 行为断言：与调度器路径 `if (full)` 语义一致）
    expect(
      upsertChapterSpy.mock.calls.filter(
        (c) => (c[1] as { id: string }).id === CHS[0],
      ),
    ).toHaveLength(0);

    // ④ 其他章仍能继续填充（主循环越过失败章继续工作）
    const chapters = libState().hydratedLast?.chapters ?? [];
    expect(
      chapters.find((c) => c.id === CHS[2])?.segments.length ?? 0,
    ).toBeGreaterThan(0);
    // 目标章本身也就绪
    expect(
      chapters.find((c) => c.id === CHS[1])?.segments.length ?? 0,
    ).toBeGreaterThan(0);

    upsertChapterSpy.mockRestore();
  });

  test('G5：FTS 队列在装配调度器活跃时让路（§4.4 双检查点接线生效）', async () => {
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    const indexedSpy = jest.spyOn(StorageService, 'isBookIndexedInFts');
    const activeSpy = jest
      .spyOn(chapterAssemblyScheduler, 'isUserActive')
      .mockReturnValue(true);

    UserBookService.scheduleBuiltinFtsIndexBuild(0);
    await new Promise<void>((r) => setTimeout(r, 150));

    // 调度器活跃 → 队列停在书间/暂停检查点：**不曾开始解析任何书**
    // （变异 M3「未接线」时该断言失败：队列会立刻查询索引并解析首书）
    expect(indexedSpy).not.toHaveBeenCalled();

    // 调度器转为空闲 → 队列立即恢复推进（接线确实在读该判据）
    activeSpy.mockReturnValue(false);
    for (
      let i = 0;
      i < 40 && indexedSpy.mock.calls.length === 0;
      i += 1
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    expect(indexedSpy.mock.calls.length).toBeGreaterThan(0);

    activeSpy.mockRestore();
    indexedSpy.mockRestore();
  });
});
