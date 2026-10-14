/**
 * 【P1 验收】导入书未上架 —— 注册写回守卫（三条主判据）
 *
 * 背景（只读诊断结论）：书架的用户书列表来自 TextLibraryService.userBooks，而该
 * 变量只被 `registerUserBooks`（TextLibraryService.ts:98-118）**整体替换**；
 * `loadAndRegisterAllInternal` 传入的是**本轮扫描快照**（UserBookService.ts:4902），
 * 既不是「持久真值 ∪ 本轮新增」，也没有「本轮没看到 ≠ 该书不存在」的保护
 * ⇒ 任何一次「本轮没看到 / 没解析出」，都会把书从书架**静默移除**。
 *
 * 本文件锁死五条用户可见现象（每条当前为**红**，修复后须为绿）：
 *   A1 扫描失败（readDir 抛错）⇒ 书架必须仍含已导入书（现状：全量清空且零提示）
 *   A2 本轮解析失败（文件被截断为 0 字节）⇒ 不得静默丢书（现状：永久消失）
 *   A3 导入成功后的 loadBooks 恰逢在飞同步（join）⇒ 书架必须含新书
 *      ← **本任务验收主判据**（逐字对应用户报障「导入的书籍没有显示在书架上」）
 *   A4 同 A3 的在飞同步：必须留 `stale-skip` 痕迹（不静默），且一律不得改动
 *      db 行（持久证据：背诵进度/收藏/笔记挂在它上面）
 *   A5 书籍根路径漂移（ExternalDirectoryPath 变 null）⇒ 不得丢书、不得删 db 行
 *      （现状：扫另一个根 ⇒ 「本轮没看到」⇒ 误删行 + 级联 ⇒ 永久丢书）
 *   A6 反向护栏（**修复前后都应绿**）：把文件直接放进书籍文件夹 ⇒ 刷新后必须
 *      自动上架。守卫「守过头」（注册写回恒被跳过）会让 A1–A5 全绿却让新书
 *      永远上不了架，故必须有这条反向断言。
 *
 * 桩保真度（与真机同构）：react-native-fs 为可编程内存文件系统（存在/拷贝/
 * 大小/mtime/分块读/目录列举全走它），@/services/sqliteClient 为可编程
 * user_books 表（含 source_path / file_sig / content_hash 三列），
 * `jest.resetModules()` + 重新 require 等价「杀进程重启」（模块级 userBooks /
 * loadedBooks / booksCache / db 单例全部归零）。
 * TextLibraryService / UserBookService / useLibraryStore **均为真实实现**
 * （断言落在 `useLibraryStore.getState().books`，即书架真实数据源）。
 */
/**
 * 【执行预算】本套件每条用例都 `jest.resetModules()` + 重新 `require` 整条模块图
 * （= 等价「杀进程重启」），成本是 **CPU 受限** 的 6 次全图 bootstrap。
 *
 * 量法（2026-09-22，本机）：
 *   · 单独跑该套件：单例 3475–5097 ms，套件墙钟 56 s（默认 5000 ms 下 A1 越界）；
 *   · 单独跑 + `--testTimeout=20000`：6/6 全绿；
 *   · **全量并行**（`jest`，默认 worker 池占满 CPU）：单例 >15000 ms，
 *     5 例越界 ⇒ 成本随并发争抢放大 3–6×，与功能无关。
 *   · 本文件不在 `HEAD`（7ac1157）中、从未在基线上运行过 ⇒ 与本轮清理无关。
 *
 * ⚠ 这是**预算**而非判据：本文件所有断言一字未动，放宽前后断言完全一致。
 * 若要根治，应减少 6 次全图 bootstrap（属独立优化，不在阅读器清理范围内）。
 */
jest.setTimeout(60000);

const mockExtDir = '/data/user/0/com.guoxue.studyapp/files';
const mockDocDir = '/data/user/0/com.guoxue.studyapp/files';
const mockCacheDir = '/data/user/0/com.guoxue.studyapp/cache';
const mockBooksDir = 'guoxue-books';
const mockMtime = 1_700_000_000_000;

jest.mock('@/services/sqliteClient', () => {
  const state = {
    /** user_books 行（列名与 UserBookService.createUserBooksSchema 逐字一致） */
    userBooks: [] as Array<Record<string, unknown>>,
    /** builtin_hidden 行 */
    builtinHidden: [] as string[],
    /** 已执行 DELETE FROM user_books 的 id（下架清扫证据） */
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
    /** path -> 文件内容（utf8） */
    files: new Map<string, string>(),
    /** path -> 目录标记 */
    dirs: new Set<string>(),
    /** path -> mtime（epoch ms），缺省 mockMtime */
    mtimes: new Map<string, number>(),
    /** 这些目录的 readDir 抛错（模拟瞬时 IO 故障） */
    failReadDir: new Set<string>(),
    /** path -> 门控（readDir 调用瞬间取快照，但延迟到 release 才返回） */
    gates: new Map<string, { promise: Promise<void>; release: () => void }>(),
    /** readDir 调用记录 */
    readDirCalls: [] as string[],
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
    readDir: jest.fn(async (p: string) => {
      state.readDirCalls.push(p);
      if (state.failReadDir.has(p)) {
        throw new Error('EACCES (simulated readDir failure)');
      }
      // 快照在**调用瞬间**取得——等价真机 readDir 立即返回「当时的目录项」
      const snapshot = [...state.files.keys(), ...state.dirs]
        .filter((f) => parentOf(f) === p && f !== p)
        .map((f) => ({
          name: f.slice(f.lastIndexOf('/') + 1),
          path: f,
          isFile: () => state.files.has(f),
          isDirectory: () => state.dirs.has(f),
        }));
      const gate = state.gates.get(p);
      if (gate) {
        await gate.promise;
      }
      return snapshot;
    }),
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
    copyFileAssets: jest.fn(async () => {
      throw new Error('diag: 无随包资产（内置书侧失败路径，不影响用户书断言）');
    }),
    unlink: jest.fn(async (p: string) => {
      state.files.delete(p);
    }),
    __state: state,
    /** 测试辅助：为某目录装门控（readDir 挂起直到 release） */
    __gateReadDir: (p: string) => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.gates.set(p, { promise, release });
      return {
        release: () => {
          state.gates.delete(p);
          release();
        },
      };
    },
  };
});

/** 会话句柄：一次 boot = 一次「进程」 */
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
  const sql = require('@/services/sqliteClient').__state;
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

/** 书架上的用户书 id（= 用户可见列表，LibraryScreen:52 读的就是这个字段） */
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

const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0));
const drain = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep0();
  }
};

/** 造一个「用户刚在导入 UI 选中的文件」（DocumentPicker copyTo cachesDirectory 的产物） */
function cachePickedFile(s: Session, name: string, text: string): { uri: string; fileName: string; size: number } {
  s.rnfs.files.set(`${mockCacheDir}/${name}`, text);
  return {
    uri: `file://${encodeURIComponent(`${mockCacheDir}/${name}`)}`,
    fileName: name,
    size: Buffer.byteLength(text, 'utf8'),
  };
}

/** 基线：启动 → 导入一本内容唯一的书 → 刷新上架（确认「书确实在架上」） */
async function seedImportedBook(s: Session, tag: string): Promise<{ id: string; name: string }> {
  await s.lib.getState().loadBooks();
  expect(userOnShelf(s)).toEqual([]);
  const name = `${tag}.txt`;
  const text = `第一章 ${tag}\n${tag} 正文甲。\n\n第二章 收束\n${tag} 正文乙。`;
  const res = await s.ubs.UserBookService.importBook(cachePickedFile(s, name, text));
  expect(res.success).toBe(true);
  await s.lib.getState().loadBooks();
  expect(userOnShelf(s)).toEqual([res.data.id]);
  return { id: res.data.id as string, name };
}

const dump = (label: string, s: Session): void => {
  console.info(
    `[P1][${label}] 书架user=${JSON.stringify(userOnShelf(s))} 注册user=${JSON.stringify(
      userRegistered(s),
    )} db行=${JSON.stringify(
      (s.sql.userBooks as Array<{ id: string }>).map((r) => r.id),
    )} 删行记录=${JSON.stringify(s.sql.deletedIds)} storeError=${JSON.stringify(
      s.lib.getState().error,
    )} 诊断=${JSON.stringify(s.ubs.getLibrarySyncDiagnostics().scanInterrupted)}`,
  );
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('P1 导入书未上架 —— 注册写回守卫', () => {
  test('A1 扫描失败（readDir 抛错）后：书架必须仍含已导入书', async () => {
    const s = boot();
    const { id } = await seedImportedBook(s, 'A1书');

    s.rnfs.failReadDir.add(s.root);
    await s.lib.getState().loadBooks();
    dump('A1 扰动后', s);

    expect(userOnShelf(s)).toEqual([id]);
  });

  test('A2 本轮解析失败（文件被截断为 0 字节）：不得静默丢书', async () => {
    const s = boot();
    const { id, name } = await seedImportedBook(s, 'A2书');

    s.rnfs.files.set(`${s.root}/${name}`, '');
    s.rnfs.mtimes.set(`${s.root}/${name}`, mockMtime + 1000);
    await s.lib.getState().loadBooks();
    dump('A2 扰动后', s);

    expect(userOnShelf(s)).toEqual([id]);
  });

  test('A3 导入成功后的刷新恰逢在飞同步（join）：书架必须含新书', async () => {
    const s = boot();
    const { id: firstId } = await seedImportedBook(s, 'A3书一');

    // ① 一次同步在飞，且被门控卡在「已列目录、尚未注册」——建模真机上
    //    「启动/上一次刷新的同步仍在飞」
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfsMod = require('react-native-fs') as {
      __gateReadDir: (p: string) => { release: () => void };
    };
    const gate = rnfsMod.__gateReadDir(s.root);
    const syncP = s.ubs.UserBookService.loadAndRegisterAll();
    await drain(3);
    console.info(`[P1][A3] 在飞同步已列目录=${JSON.stringify(s.rnfs.readDirCalls)}`);

    // ② 用户此刻导入第二本（内容唯一，避免内容去重拦截）
    const name2 = 'A3书二.txt';
    const text2 = `第一章 竞争\n${name2} 甲。\n\n第二章 收束\n${name2} 乙。`;
    const res2 = await s.ubs.UserBookService.importBook(cachePickedFile(s, name2, text2));
    expect(res2.success).toBe(true);
    const secondId = res2.data.id as string;
    console.info(`[P1][A3] 导入成功 → 注册user=${JSON.stringify(userRegistered(s))}`);

    // ③ handleImport 的真实时序：成功后 loadBooks()，其 stage2 会 join 到在飞同步
    const loadP = s.lib.getState().loadBooks();
    await drain(5);
    gate.release();
    await loadP;
    dump('A3 刷新结束后', s);
    console.info(`[P1][A3] 根目录=${JSON.stringify(s.rnfs.readDirCalls.slice(-1))}`);

    expect(userOnShelf(s)).toContain(secondId);
    expect(firstId.startsWith('user-')).toBe(true);
  });

  test('A4 陈旧同步：不得改动 db 行，且必须留 stale-skip 痕迹（不静默）', async () => {
    const s = boot();
    await seedImportedBook(s, 'A4书一');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfsMod = require('react-native-fs') as {
      __gateReadDir: (p: string) => { release: () => void };
    };
    const gate = rnfsMod.__gateReadDir(s.root);
    const syncP = s.ubs.UserBookService.loadAndRegisterAll();
    await drain(3);

    const name2 = 'A4书二.txt';
    const text2 = `第一章 竞争\n${name2} 甲。\n\n第二章 收束\n${name2} 乙。`;
    const res2 = await s.ubs.UserBookService.importBook(cachePickedFile(s, name2, text2));
    expect(res2.success).toBe(true);
    const secondId = res2.data.id as string;

    // 在飞同步继续跑完（它的扫描快照里没有书二）
    const loadP = s.lib.getState().loadBooks();
    await drain(5);
    gate.release();
    await loadP;
    await syncP;
    const markers = infoSpy.mock.calls.map((c) => String(c[0]));
    infoSpy.mockRestore();
    dump('A4 同步跑完后', s);
    const staleMarkers = markers.filter((m) => m.includes('[PERF][library-sync] stale-skip'));
    console.info(`[P1][A4] stale-skip 标记=${JSON.stringify(staleMarkers)}`);

    // ① F1 硬要求：陈旧轮必须**留痕**（裸字面量标记，真机可直接查日志），
    //    绝不静默跳过——两条变更阶段各一条。
    expect(staleMarkers).toContain('[PERF][library-sync] stale-skip register');
    expect(staleMarkers).toContain('[PERF][library-sync] stale-skip purge');
    // ② 诊断如实反映「本轮跳过了哪些变更阶段」（下架清扫先执行 ⇒ 顺序固定）
    expect(s.ubs.getLibrarySyncDiagnostics().staleSkippedStages).toEqual(['purge', 'register']);
    // ③ db 行是持久证据（背诵进度/收藏/笔记挂在它上面）：陈旧轮一律不得改动。
    //    注：此处是**守恒不变量**而非可达缺陷——「SELECT 见到该行 ∧ 本轮
    //    readDir 没见到其文件」在时序上不可达（copyFile:5292 先于 INSERT:5345，
    //    而 SELECT:4757 先于 readDir:4815），故下架清扫的陈旧守卫属纵深防御。
    expect(s.sql.userBooks.map((r) => r.id)).toContain(secondId);
    expect(s.sql.deletedIds).toEqual([]);
  });

  test('A5 书籍根路径漂移（ExternalDirectoryPath 变 null）：不得丢书、不得删 db 行', async () => {
    const s = boot();
    const { id, name } = await seedImportedBook(s, 'A5书');
    const realRoot = s.root;

    // 扰动：模拟 getExternalFilesDir() 返回 null（外置存储未挂载）⇒
    // getBooksRootPath() 回落到另一个目录，与本会话写入位置不同。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfsMod = require('react-native-fs') as {
      ExternalDirectoryPath: string | null;
      DocumentDirectoryPath: string;
    };
    rnfsMod.DocumentDirectoryPath = '/data/user/0/com.guoxue.studyapp/internal';
    rnfsMod.ExternalDirectoryPath = null;
    expect(s.ubs.UserBookService.getBooksRootPath()).not.toBe(realRoot);

    await s.lib.getState().loadBooks();
    dump('A5 漂移轮后', s);

    // ① 书架不得因「本轮看的是另一个根」而丢书（F4：漂移轮禁用变更阶段）
    expect(userOnShelf(s)).toEqual([id]);
    // ② 旧根的 db 行必须保留（根恢复后能自动找回；删掉即永久丢书）
    expect(s.sql.userBooks.map((r) => r.id)).toEqual([id]);
    expect(s.sql.deletedIds).toEqual([]);
    // ③ 原根的文件未被这次扰动影响
    expect(s.rnfs.files.has(`${realRoot}/${name}`)).toBe(true);

    // 稳定轮（root 未再变 ⇒ rootDrift=false）：本轮 F4b「异根行绝不下架」才是
    // 唯一防线——db 行若被删即**永久**丢书（文件仍在旧根，信息却没了）。
    // 口径注：稳定轮的书架读数为空属**既有**「本轮扫描所见为空」口径（外置存储
    // 未挂载时确实读不到文件）；db 行仍在 ⇒ 根恢复后两轮内自动找回，非永久丢书。
    // 若要连书架也一起保留，需另立「db 存在异根行时禁用写回」的守卫（**未落码**，
    // 超出本任务书授权面，已在交付说明中标记）。
    await s.lib.getState().loadBooks();
    dump('A5 稳定轮后', s);
    expect(s.sql.userBooks.map((r) => r.id)).toEqual([id]);
    expect(s.sql.deletedIds).toEqual([]);
  });

  test('A6 反向护栏：直接放入书籍文件夹的文件，刷新后必须自动上架', async () => {
    const s = boot();
    await s.lib.getState().loadBooks();
    expect(userOnShelf(s)).toEqual([]);

    // 模拟用户把文件拷进书籍文件夹——LibraryScreen 页脚承诺的用法：
    // 「将书籍文件放入该文件夹，刷新后自动上架」
    const name = 'A6手放书.txt';
    const text = `第一章 手放\n${name} 甲。\n\n第二章 收束\n${name} 乙。`;
    s.rnfs.files.set(`${s.root}/${name}`, text);

    await s.lib.getState().loadBooks();
    dump('A6 刷新后', s);

    // 守「陈旧/失败/漂移」不得守过头：正常刷新路径必须仍然把新文件注册上架
    //（注册写回是新书进入 TextLibraryService 的唯一通道；守卫若恒真，
    // 外部放入的书就再也上不了架，而断言面会全绿——故必须有此反向护栏）
    expect(userOnShelf(s)).toHaveLength(1);
    expect(s.sql.userBooks).toHaveLength(1);
  });
});
