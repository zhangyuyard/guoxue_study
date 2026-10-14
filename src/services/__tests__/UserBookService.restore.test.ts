/**
 * UserBookService.restoreUserBooks 测试（P2-15 补全：用户书纳入备份/恢复）
 * 锁定完整调用链（可编程 quick-sqlite mock 按 db 名分流 + 受控 TextLibraryService）：
 *   - 合法书恢复 → 持久化（INSERT OR REPLACE）+ 注册 + FTS 同步入索引
 *   - 同 id 幂等覆盖（重复恢复不产生重复书）
 *   - 非法条目静默跳过（与五类 restoreFromBackup 的跳过惯例一致）
 *   - 合并语义：设备上存在但备份中没有的用户书 → 保留不被删
 *   - 空数组无副作用；非数组入参报错
 */
jest.mock('@/services/sqliteClient', () => {
  const { createFts5Mock, execFts5Sql } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./fts5Mock.helper') as typeof import('./fts5Mock.helper');
  const mockState = {
    /** user_books.db 行 */
    userBooks: [] as Array<Record<string, unknown>>,
    // 【#29】guoxue.db 的 FTS 语句面（segments_fts + segment_fts_rowid）统一走共享
    // 保真 mock：按语句首词路由 + 真机 rowid 分配（max(rowid)+1，会复用被释放的
    // rowid）。详见 helper 头注释。
    ...createFts5Mock(),
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
      if (opts.name !== 'user_books.db' && opts.name !== 'guoxue.db') {
        throw new Error(`意外打开数据库：${opts.name}`);
      }
      return {
        execute: (sql: string, params: (string | number | null)[] = []) => {
          if (opts.name === 'user_books.db') {
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
            return { rows: { _array: [], length: 0 } };
          }
          const handled = execFts5Sql(mockState, sql, params);
          if (handled) {
            return handled;
          }
          // CREATE TABLE 等一律放行
          return { rows: { _array: [], length: 0 } };
        },
      };
    },
    __restoreState: mockState,
  };
});

/** 受控文本库：仅含注册进来的用户书（避免内置十部全量入索引拖慢用例） */
jest.mock('@/services/TextLibraryService', () => {
  const mockLibState = { userBooks: [] as unknown[] };
  const mockLib = {
    registerUserBooks: (books: Array<{ id: string; chapters: unknown[] }>) => {
      for (const b of books) {
        if (!String(b.id).startsWith('user-')) {
          return { success: false, error: `用户书籍 ID 必须以 user- 开头：${b.id}` };
        }
        if (!Array.isArray(b.chapters)) {
          return { success: false, error: `书籍章节列表无效：${b.id}` };
        }
      }
      mockLibState.userBooks = books;
      return { success: true, data: null };
    },
    getBooks: () => ({ success: true, data: mockLibState.userBooks }),
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

import type { Book } from '@/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __restoreState } = require('@/services/sqliteClient');
import { UserBookService } from '@/services/UserBookService';
import { __resetBuiltinLazyStateForTests } from '@/services/UserBookService';
import { TextLibraryService } from '@/services/TextLibraryService';
import { resetFts5Mock, ridMapViolations } from './fts5Mock.helper';

/** 构造一本最小合法用户书 */
function makeBook(id: string, title = '备份之书'): Book {
  return {
    id,
    title,
    author: '佚名',
    category: 'user',
    description: '共 1 章 1 段 · 导入自 TXT',
    chapters: [
      {
        id: `${id}-c1`,
        bookId: id,
        title: '全文',
        order: 1,
        segments: [{ id: `${id}-c1-s1`, chapterId: `${id}-c1`, order: 1, text: '温故而知新。' }],
      },
    ],
  };
}

/** 预置一本「设备上已有」的书（直接写 db 行，再经 loadAndRegisterAll 装载） */
async function seedDeviceBook(id: string, title: string): Promise<void> {
  const book = makeBook(id, title);
  __restoreState.userBooks.push({
    id: book.id,
    title: book.title,
    author: book.author,
    data: JSON.stringify(book),
    created_at: 1000,
  });
  await UserBookService.loadAndRegisterAll();
}

describe('UserBookService.restoreUserBooks（用户书备份恢复）', () => {
  beforeEach(async () => {
    __restoreState.userBooks = [];
    // 【#29】FTS 行 + rowid 映射 + 最后插入 rowid 一并重置（只清 ftsRows 会让
    // 「无行映射」跨用例残留）
    resetFts5Mock(__restoreState);
    // 重置 UserBookService 模块级内存列表（loadedBooks 跨用例残留会污染注册断言）
    await UserBookService.loadAndRegisterAll();
  });

  afterEach(async () => {
    // 【R2-3】回收在飞的 FTS 后台索引队列：`loadAndRegisterAll` 在
    // `builtinFtsAutoSchedule`（默认 true）下会 `scheduleBuiltinFtsIndexBuild()`
    // 排一个 10s 起步、逐书 200ms 的长队列（77 本 ≈ 15s+）。本文件用例在此之前
    // 早已结束，队列随后继续解析并 `console.info` → jest 报
    // 「Cannot log after tests are done」（--detectOpenHandles 退出码 1）。
    // 重置会递增队列世代号 → 队列在下一个书间/暂停轮询检查点立即返回。
    __resetBuiltinLazyStateForTests();
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });

  test('合法书恢复：持久化 + 注册 + FTS 同步入索引', async () => {
    const book = makeBook('user-r1');
    const res = await UserBookService.restoreUserBooks([JSON.parse(JSON.stringify(book))]);
    expect(res.success).toBe(true);
    expect((res as { data: { restored: number; skipped: number } }).data).toEqual({
      restored: 1,
      skipped: 0,
    });

    // 持久化：db 中存在该书行，data 为完整 Book JSON
    const row = __restoreState.userBooks.find((r: Record<string, unknown>) => r.id === 'user-r1');
    expect(row).toBeDefined();
    expect((JSON.parse(String(row.data)) as Book).title).toBe('备份之书');

    // 注册：已进文本库
    const registered = (TextLibraryService.getBooks().data as Book[]) ?? [];
    expect(registered.map((b) => b.id)).toContain('user-r1');

    // FTS：该书段落入搜索索引
    const ftsHit = __restoreState.ftsRows.find(
      (r: Record<string, unknown>) => r.book_id === 'user-r1' && r.text === '温故而知新。',
    );
    expect(ftsHit).toBeDefined();
    // 【#29】恢复走整书写入（upsertFtsForBook）：必须登记稳定 rowid 且不留孤儿映射
    expect(__restoreState.ftsRidMap.get('user-r1-c1-s1')).toBe(ftsHit?.rowid);
    expect(ridMapViolations(__restoreState)).toEqual([]);
  });

  test('同 id 幂等覆盖：重复恢复同 id 不产生重复书，内容以备份为准', async () => {
    const first = makeBook('user-r2', '旧标题');
    const second = { ...makeBook('user-r2', '新标题') };
    await UserBookService.restoreUserBooks([JSON.parse(JSON.stringify(first))]);
    await UserBookService.restoreUserBooks([JSON.parse(JSON.stringify(second))]);

    expect(__restoreState.userBooks).toHaveLength(1);
    const row = __restoreState.userBooks[0];
    expect((JSON.parse(String(row.data)) as Book).title).toBe('新标题');
    const registered = (TextLibraryService.getBooks().data as Book[]) ?? [];
    expect(registered).toHaveLength(1);
    expect(registered[0].title).toBe('新标题');
  });

  test('非法条目静默跳过：null / 非对象 / 缺 chapters / 非 user- 前缀 id', async () => {
    const good = makeBook('user-r3');
    const res = await UserBookService.restoreUserBooks([
      null,
      'junk',
      42,
      { id: 'user-r4' }, // 缺 chapters
      { id: 'builtin-book', chapters: [] }, // 非 user- 前缀
      JSON.parse(JSON.stringify(good)),
    ]);
    expect(res.success).toBe(true);
    expect((res as { data: { restored: number; skipped: number } }).data).toEqual({
      restored: 1,
      skipped: 5,
    });
    expect(__restoreState.userBooks.map((r: Record<string, unknown>) => r.id)).toEqual(['user-r3']);
  });

  test('合并语义：设备已有但备份中没有的用户书 → 保留不被删', async () => {
    await seedDeviceBook('user-device-only', '设备独有之书');
    const backupBook = makeBook('user-from-backup', '备份带来的书');
    const res = await UserBookService.restoreUserBooks([JSON.parse(JSON.stringify(backupBook))]);
    expect(res.success).toBe(true);

    // db 中两本书都在（设备独有书未被删）
    const ids = __restoreState.userBooks.map((r: Record<string, unknown>) => r.id).sort();
    expect(ids).toEqual(['user-device-only', 'user-from-backup']);

    // 注册列表同样两本都在
    const registered = (TextLibraryService.getBooks().data as Book[]) ?? [];
    expect(registered.map((b) => b.id).sort()).toEqual([
      'user-device-only',
      'user-from-backup',
    ]);
  });

  test('备份中的书按 id 覆盖设备同 id 书，其余设备书保留', async () => {
    await seedDeviceBook('user-keep', '保留之书');
    await seedDeviceBook('user-overwrite', '将被覆盖');
    const backupBook = makeBook('user-overwrite', '覆盖后的标题');
    await UserBookService.restoreUserBooks([JSON.parse(JSON.stringify(backupBook))]);

    const registered = (TextLibraryService.getBooks().data as Book[]) ?? [];
    expect(registered).toHaveLength(2);
    expect(registered.find((b) => b.id === 'user-keep')?.title).toBe('保留之书');
    expect(registered.find((b) => b.id === 'user-overwrite')?.title).toBe('覆盖后的标题');
  });

  test('空数组无副作用；旧备份（userBooks 缺省传 undefined 视作非数组）报错', async () => {
    await seedDeviceBook('user-keep-empty', '保留之书');

    const empty = await UserBookService.restoreUserBooks([]);
    expect(empty.success).toBe(true);
    expect((empty as { data: { restored: number } }).data.restored).toBe(0);
    expect(__restoreState.userBooks).toHaveLength(1);
    expect(__restoreState.ftsRows).toHaveLength(0);

    const bad = await UserBookService.restoreUserBooks(undefined);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('userBooks 应为数组');
    // 报错路径不改动任何既有状态
    expect(__restoreState.userBooks).toHaveLength(1);
  });
});
