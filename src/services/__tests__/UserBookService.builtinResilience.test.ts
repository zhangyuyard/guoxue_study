/**
 * UserBookService 内置书韧性回归测试（2026-09-08 真机「内置书全部消失」修复）
 * 锁定三条防线：
 * 1. 内置书 db 行绝不参与下架清扫（文件暂缺/目录读取失败时背诵/笔记不丢）
 * 2. 根目录扫描失败（scanOk=false）→ 内置书注册保留上一轮结果，
 *    绝不用空列表整体替换（防「一次瞬时 IO 异常清空书架」）
 * 3. 首轮资产复制整体失败 → 内置目录为空时自愈重物化，同轮找回全部内置书，
 *    且 assetCopyFailures 诊断随之收敛
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
          if (/SELECT id, title, author, data, source_path, file_sig, created_at FROM user_books/.test(sql)) {
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

/** 受控文本库：记录 registerBuiltinBooks 调用（断言不用空列表整体替换） */
jest.mock('@/services/TextLibraryService', () => {
  const mockLibState = {
    builtinCalls: [] as number[],
    userBooks: [] as unknown[],
  };
  const mockLib = {
    __libState: mockLibState,
    registerBuiltinBooks: (books: unknown[]) => {
      mockLibState.builtinCalls.push(books.length);
      return { success: true, data: null };
    },
    setSuppressedBuiltins: () => ({ success: true, data: null }),
    registerUserBooks: (books: unknown[]) => {
      mockLibState.userBooks = books;
      return { success: true, data: null };
    },
    getBooks: () => ({ success: true, data: [...mockLibState.userBooks] }),
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

/** 可编程 RNFS：readDir 显式注入优先，否则从已存在文件动态派生目录列表 */
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
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    exists: jest.fn(async (path: string) => state.files.has(path)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(async () => state.readReply),
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
      size: 128,
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
} from '@/services/UserBookService';
import { TextLibraryService } from '@/services/TextLibraryService';

/** 取受控文本库的记录状态（mock 注入，真实类型上不存在） */
interface MockLibState {
  builtinCalls: number[];
  userBooks: unknown[];
}
function libState(): MockLibState {
  return (TextLibraryService as unknown as { __libState: MockLibState }).__libState;
}

const BUILTIN_ROW_ID = 'lunyu';

/** 预置一行内置书解析缓存（模拟上一轮成功解析后的 db 状态） */
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

describe('UserBookService 内置书韧性（真机消失回归）', () => {
  beforeEach(() => {
    __builtinResilienceState.userBooks = [];
    __builtinResilienceState.deletedIds = [];
    __rnfsState.files = new Set();
    __rnfsState.assetsCopied = [];
    __rnfsState.readDirResults = {};
    __rnfsState.assetCopyFailLeft = 0;
    __rnfsState.readReply = '';
    libState().builtinCalls = [];
  });

  test('内置书 db 行不参与下架：builtin 目录读不到文件时行保留、学习数据不级联清理', async () => {
    seedBuiltinRow();
    // 根目录与 builtin 目录都返回空（文件暂缺/目录读取异常场景）
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
    __rnfsState.readDirResults[UserBookService.getBuiltinDirPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);

    // 关键断言：内置行未被删除（旧实现会在此 DELETE + 级联清理学习数据）
    expect(__builtinResilienceState.deletedIds).toEqual([]);
    const row = __builtinResilienceState.userBooks.find(
      (r: Record<string, unknown>) => r.id === BUILTIN_ROW_ID,
    );
    expect(row).toBeDefined();
  });

  test('根目录扫描失败（scanOk=false）：本轮不更新内置书注册，db 行保留', async () => {
    seedBuiltinRow();
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = new Error('EIO');
    __rnfsState.readDirResults[UserBookService.getBuiltinDirPath()] = [];

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);

    // scanOk=false：本轮不整体替换内置书注册（无新调用），db 行保留
    expect(libState().builtinCalls).toEqual([]);
    const row = __builtinResilienceState.userBooks.find(
      (r: Record<string, unknown>) => r.id === BUILTIN_ROW_ID,
    );
    expect(row).toBeDefined();
    expect(getLibrarySyncDiagnostics().scanInterrupted).toBe(false);
  });

  test('首轮资产复制整体失败：同轮自愈重物化找回全部内置书，诊断收敛', async () => {
    // 不显式注入 readDir：由 files 集合动态派生（复制成功即出现在目录里）
    // 前 28 次 copyFileAssets 全部失败（首轮物化整体失败，
    // readFileAssets 回落同样不可用），自愈轮成功
    __rnfsState.assetCopyFailLeft = 28;
    // 提供可解析的资产内容（@@CH@@ 标记文本 → base64），让 28 部全部解析成功
    __rnfsState.readReply = Buffer.from('@@CH@@第一篇\n\n正文内容。', 'utf8').toString('base64');

    const res = await UserBookService.loadAndRegisterAll();
    expect(res.success).toBe(true);

    // 自愈把 28 部全部复制成功
    expect(__rnfsState.assetsCopied).toHaveLength(28);
    // 诊断随自愈收敛（不再残留失败名单）
    expect(getLibrarySyncDiagnostics().assetCopyFailures).toEqual([]);
    // 内置书注册以完整清单发生（28 部）
    expect(libState().builtinCalls).toEqual([28]);
  });
});
