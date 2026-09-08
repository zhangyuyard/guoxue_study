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
} from '@/services/UserBookService';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { getBuiltinSpec } from '@/data/builtinCatalog';

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
    libState().builtinCalls = [];
    libState().builtinLast = [];
    libState().hydratedLast = null;
    libState().hydratedIds = [];
    ftsIndexed = new Set();
    isIndexedSpy = jest
      .spyOn(StorageService, 'isBookIndexedInFts')
      .mockImplementation((id: string) => ftsIndexed.has(id));
    upsertSpy = jest
      .spyOn(StorageService, 'upsertFtsForBook')
      .mockImplementation((book: { id: string }) => {
        ftsIndexed.add(book.id);
        return { success: true, data: true };
      });
  });

  afterEach(() => {
    isIndexedSpy.mockRestore();
    upsertSpy.mockRestore();
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
    // 队列串行逐书 setTimeout(16ms) 让出，轮询等待跑完（上限 5s 防挂死）
    for (let i = 0; i < 250 && upsertSpy.mock.calls.length < 75; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // 只为未入索引的书 upsert；水合注册零调用（不经 TextLibraryService）
    expect(upsertSpy).toHaveBeenCalledTimes(75);
    expect(libState().builtinCalls).toEqual([]);
    expect(libState().hydratedIds).toEqual([]);
  });
});
