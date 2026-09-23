/**
 * 【R2c 修复验收】超大书后台装载完成 → 书架必须自动出现（无需手动刷新）
 *
 * 背景（真机 2026-09-23 14:55 复现）：超大书（>24MB）在 loadAndRegisterAllInternal
 * 扫描时转入后台队列 processOversizedBooks，该队列在书架渲染**之后**才完成
 * registerUserBooks——修复前无任何通知触发书架重拉，书架 store 永不刷新
 * ⇒ 超大书在本次会话内**永久不可见**（用户报障「大奉打更人我导入后并未显示在书架」）。
 *
 * 修复：UserBookService 注册写回成功后广播 notifyUserBooksChanged()；
 * useLibraryStore 模块级订阅该广播并立即重拉 getBooks 上屏。
 *
 * 本文件锁死：
 *   B1 订阅语义：onUserBooksChanged 订阅即收到广播、退订后不再收到；
 *      单监听器抛错不阻断其余监听器（广播健壮性）。
 *   B2 **主判据**（对应真机复现）：初始书架为空 → 放入 >24MB 文件 → loadBooks
 *      触发扫描转后台队列 → 队列完成注册后，**不再调用 loadBooks**，书架
 *      store（useLibraryStore.getState().books）必须已含该书。
 *      修复前此断言红（store 停留在初始空架，注册表却有书——两读数分离）。
 *
 * 桩保真度：与 importShelfRegistrationGuard.test.ts 同构——react-native-fs
 * 内存文件系统 + react-native-quick-sqlite 可编程 user_books 表 +
 * jest.resetModules() 等价「杀进程重启」；TextLibraryService / UserBookService /
 * useLibraryStore 均为真实实现，断言落在 useLibraryStore.getState().books。
 */
/**
 * 【执行预算】B2 走超大书真实解析链（26MB 文本 chunked 解析 + 6 次全图
 * bootstrap 复用 guard 套件口径），CPU 受限环境下单例可达 ~30s。
 * 放宽的是**预算**而非断言；断言与修复前行为严格区分（B2 修复前必红）。
 */
jest.setTimeout(120000);

const mockExtDir = '/data/user/0/com.guoxue.studyapp/files';
const mockDocDir = '/data/user/0/com.guoxue.studyapp/files';
const mockCacheDir = '/data/user/0/com.guoxue.studyapp/cache';
const mockMtime = 1_700_000_000_000;

jest.mock('react-native-quick-sqlite', () => {
  const state = {
    userBooks: [] as Array<Record<string, unknown>>,
    builtinHidden: [] as string[],
    deletedIds: [] as string[],
  };
  const cols = ['id', 'title', 'author', 'data', 'created_at', 'source_path', 'file_sig', 'content_hash'];
  const toRow = (params: unknown[]) => {
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      row[c] = params[i] === undefined ? null : params[i];
    });
    return row;
  };
  const execute = (sql: string, params: unknown[] = []) => {
    if (/^CREATE TABLE|^ALTER TABLE/i.test(sql)) {
      return { rows: { _array: [], length: 0 } };
    }
    if (/SELECT id FROM builtin_hidden/.test(sql)) {
      return { rows: { _array: state.builtinHidden.map((id) => ({ id })), length: state.builtinHidden.length } };
    }
    if (/SELECT id FROM user_books LIMIT 1/.test(sql)) {
      return { rows: { _array: state.userBooks.slice(0, 1), length: Math.min(1, state.userBooks.length) } };
    }
    if (/INSERT OR REPLACE INTO user_books/.test(sql)) {
      const row = toRow(params);
      const idx = state.userBooks.findIndex((r) => r.id === row.id);
      if (idx >= 0) {
        state.userBooks[idx] = { ...state.userBooks[idx], ...row };
      } else {
        state.userBooks.push(row);
      }
      return { rows: { _array: [], length: 0 } };
    }
    if (/SELECT source_path FROM user_books WHERE id = \?/.test(sql)) {
      const hit = state.userBooks.filter((r) => r.id === params[0]);
      return { rows: { _array: hit.map((r) => ({ source_path: r.source_path ?? null })), length: hit.length } };
    }
    if (/SELECT id, title, author, data, source_path, file_sig, content_hash, created_at FROM user_books/.test(sql)) {
      return {
        rows: {
          _array: state.userBooks.map((r) => ({
            id: r.id,
            title: r.title,
            author: r.author,
            data: r.data,
            source_path: r.source_path ?? null,
            file_sig: r.file_sig ?? null,
            content_hash: r.content_hash ?? null,
            created_at: r.created_at,
          })),
          length: state.userBooks.length,
        },
      };
    }
    if (/SELECT id, title, source_path, file_sig, content_hash FROM user_books/.test(sql)) {
      return {
        rows: {
          _array: state.userBooks.map((r) => ({
            id: r.id,
            title: r.title,
            source_path: r.source_path ?? null,
            file_sig: r.file_sig ?? null,
            content_hash: r.content_hash ?? null,
          })),
          length: state.userBooks.length,
        },
      };
    }
    if (/SELECT data FROM user_books/.test(sql)) {
      return {
        rows: { _array: state.userBooks.map((r) => ({ data: r.data })), length: state.userBooks.length },
      };
    }
    if (/UPDATE user_books SET data = \? WHERE id = \?/.test(sql)) {
      const idx = state.userBooks.findIndex((r) => r.id === params[1]);
      if (idx >= 0) {
        state.userBooks[idx] = { ...state.userBooks[idx], data: params[0] };
      }
      return { rows: { _array: [], length: 0 } };
    }
    if (/DELETE FROM user_books WHERE id = \?/.test(sql)) {
      state.deletedIds.push(String(params[0]));
      state.userBooks = state.userBooks.filter((r) => r.id !== params[0]);
      return { rows: { _array: [], length: 0 } };
    }
    return { rows: { _array: [], length: 0 } };
  };
  return {
    open: () => ({ execute, close: () => undefined, delete: () => undefined }),
    __state: state,
  };
});

jest.mock('react-native-fs', () => {
  const state = {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
    mtimes: new Map<string, number>(),
  };
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  return {
    ExternalDirectoryPath: mockExtDir,
    DocumentDirectoryPath: mockDocDir,
    CachesDirectoryPath: mockCacheDir,
    exists: jest.fn(async (p: string) => state.files.has(p) || state.dirs.has(p)),
    mkdir: jest.fn(async (p: string) => {
      let cur = p;
      while (cur.length > 1) {
        state.dirs.add(cur);
        cur = parentOf(cur);
      }
    }),
    readDir: jest.fn(async (p: string) =>
      [...state.files.keys(), ...state.dirs]
        .filter((f) => parentOf(f) === p && f !== p)
        .map((f) => ({
          name: f.slice(f.lastIndexOf('/') + 1),
          path: f,
          isFile: () => state.files.has(f),
          isDirectory: () => state.dirs.has(f),
        })),
    ),
    stat: jest.fn(async (p: string) => {
      if (state.dirs.has(p) && !state.files.has(p)) {
        return { path: p, size: 0, isFile: () => false, isDirectory: () => true, mtime: new Date(mockMtime) };
      }
      if (!state.files.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return {
        path: p,
        size: Buffer.byteLength(state.files.get(p) as string, 'utf8'),
        isFile: () => true,
        isDirectory: () => false,
        mtime: new Date(state.mtimes.get(p) ?? mockMtime),
      };
    }),
    read: jest.fn(async (p: string, length: number, position: number) => {
      const buf = Buffer.from(state.files.get(p) ?? '', 'utf8');
      return buf.subarray(position, position + length).toString('base64');
    }),
    readFile: jest.fn(async (p: string) => state.files.get(p) ?? ''),
    readFileAssets: jest.fn(async () => {
      throw new Error('diag: 无随包资产（内置书侧失败路径，不影响用户书断言）');
    }),
    writeFile: jest.fn(async (p: string, content: string) => {
      state.files.set(p, content);
    }),
    appendFile: jest.fn(async (p: string, content: string) => {
      state.files.set(p, (state.files.get(p) ?? '') + content);
    }),
    copyFile: jest.fn(async (src: string, dst: string) => {
      if (!state.files.has(src)) {
        throw new Error(`ENOENT: ${src}`);
      }
      state.files.set(dst, state.files.get(src) as string);
    }),
    unlink: jest.fn(async (p: string) => {
      state.files.delete(p);
    }),
    __state: state,
  };
});

interface Session {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lib: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ubs: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tls: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rnfs: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any;
  root: string;
}

/** 等价「杀进程重启」：重置模块注册表并重新 require 全链路 */
function boot(): Session {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rnfsMod = require('react-native-fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sql = require('react-native-quick-sqlite').__state;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ss = require('@/services/StorageService').StorageService;
  for (const m of ['upsertFtsForBook', 'deleteFtsForBook', 'isBookIndexedInFts']) {
    jest.spyOn(ss, m).mockReturnValue({ success: true, data: true });
  }
  jest.spyOn(ss, 'upsertFtsForBookChunked').mockResolvedValue({ success: true, data: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ubs = require('@/services/UserBookService');
  ubs.__resetBuiltinLazyStateForTests();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lib = require('@/store/useLibraryStore').useLibraryStore;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tls = require('@/services/TextLibraryService').TextLibraryService;
  return { lib, ubs, tls, rnfs: rnfsMod.__state, sql, root: ubs.UserBookService.getBooksRootPath() };
}

/** 书架上的用户书 id（= 用户可见列表） */
function userOnShelf(s: Session): string[] {
  return (s.lib.getState().books as Array<{ id: string }>)
    .filter((b) => b.id.startsWith('user-'))
    .map((b) => b.id);
}

/** 注册表内的用户书 id（TextLibraryService.userBooks） */
function userRegistered(s: Session): string[] {
  return (s.tls.getBooks().data as Array<{ id: string }>)
    .filter((b) => b.id.startsWith('user-'))
    .map((b) => b.id);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('R2c 超大书后台装载 → 书架自动出现', () => {
  test('B1a onUserBooksChanged：订阅收到广播，退订后不再收到', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { onUserBooksChanged, notifyUserBooksChanged } = require('@/services/UserBookService');
    let hits = 0;
    const unsub = onUserBooksChanged(() => {
      hits += 1;
    });
    notifyUserBooksChanged();
    expect(hits).toBe(1);
    unsub();
    notifyUserBooksChanged();
    notifyUserBooksChanged();
    expect(hits).toBe(1);
  });

  test('B1b 广播健壮性：单监听器抛错不阻断其余监听器', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { onUserBooksChanged, notifyUserBooksChanged } = require('@/services/UserBookService');
    const seen: string[] = [];
    onUserBooksChanged(() => {
      seen.push('a');
      throw new Error('listener A exploded');
    });
    onUserBooksChanged(() => {
      seen.push('b');
    });
    expect(() => notifyUserBooksChanged()).not.toThrow();
    expect(seen).toEqual(['a', 'b']);
  });

  test('B2 主判据：超大书后台队列注册后，书架 store 无需手动刷新即含该书', async () => {
    const s = boot();
    await s.lib.getState().loadBooks();
    // 初始书架为空（真机复现的起点）
    expect(userOnShelf(s)).toEqual([]);

    // 用户把 >24MB 的书放进书籍文件夹（等价真机「导入超大书」的落盘结果）
    const name = 'B2超大书.txt';
    const line = '这是用来把文件体积顶过二十四兆阈值门槛的超大书正文内容行。'.repeat(8);
    let text = '';
    for (let c = 1; c <= 300; c += 1) {
      text += `第${c}章 风雪夜\n${`${line}\n`.repeat(125)}`;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeGreaterThan(24 * 1024 * 1024); // 过 OVERSIZED_RAW_BYTES 阈值才走后台队列
    s.rnfs.files.set(`${s.root}/${name}`, text);

    // loadBooks：扫描见到超大文件 → 转后台队列（不阻塞书架）→ 同步阶段结束
    await s.lib.getState().loadBooks();

    // 队列异步解析注册。修复前：store 停留空架、注册表却有书（两读数分离）。
    // 轮询等队列完成（processOversizedBooks 片间 setTimeout(0) 让出，宏任务可推进）。
    const bookId = s.ubs.stableBookIdFromPath(name) as string;
    let queueDone = false;
    for (let i = 0; i < 400 && !queueDone; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 50));
      queueDone = userRegistered(s).includes(bookId);
    }
    console.info(
      `[R2c][B2] 注册user=${JSON.stringify(userRegistered(s))} 书架user=${JSON.stringify(
        userOnShelf(s),
      )} db行=${JSON.stringify((s.sql.userBooks as Array<{ id: string }>).map((r) => r.id))}`,
    );
    expect(queueDone).toBe(true);

    // ★ 主判据：**不调 loadBooks**，书架 store 必须已含超大书（通知 → 重拉上屏）
    expect(userOnShelf(s)).toContain(bookId);
    expect(userRegistered(s)).toContain(bookId);
    // 口径注：超大书**有意不落 db**（oversizedBookFiles 注释「不落 db，删除时按
    // 文件清理」）；「重启可见」一层由根目录文件重扫（本文件仍在 root）保证，
    // 故此处**禁**断言 db 行——那是普通用户书的持久化通道。
  });
});
