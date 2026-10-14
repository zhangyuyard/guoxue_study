/**
 * sqliteClient 适配层 —— op-sqlite 原生调用「参数形状」回归锁
 *
 * 真机缺陷（2026-10-08，release 冷启日志）：
 *   适配层给可选参数一律显式填 `undefined`（`encryptionKey: params.encryptionKey`），
 *   而 op-sqlite 原生 open 用 `options.hasProperty(rt, "encryptionKey")` 判可选
 *   —— JSI 的 hasProperty 对「键存在、值为 undefined」返回 true ⇒ 紧接着
 *   `asString(undefined)` 抛「Value is undefined, expected a String」。
 *   后果：所有库打开全灭；UserBookService 连删库重建也走同一条 open 失败，
 *   StorageService / DictDatabase 静默降级（getDb 返回 null）。
 *
 * 本用例锁两件事：
 *   ① 可选参数「键缺省」而不是「值为 undefined」（open 的参数对象）；
 *   ② delete 的实参个数契约：无 location 必须 0 参（原生 `count == 1` 才校验 args[1]）。
 *
 * 注：jestSetupFile.js 全局 mock 了本模块（业务测试用内存适配器），故此处
 * 用 jest.requireActual 取回真实实现。
 */
const mockOpen = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

import RNFS from 'react-native-fs';

const { open } = jest.requireActual<typeof import('@/services/sqliteClient')>(
  '@/services/sqliteClient',
);

/** 未传 location 时的锚定基准（jestSetupFile 的 react-native-fs mock） */
const DOC_DIR = RNFS.DocumentDirectoryPath;

/** 原生 DB 句柄桩（只用到适配层消费的三个方法） */
function makeNativeDb() {
  return {
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
    delete: jest.fn(),
  };
}

let nativeDb: ReturnType<typeof makeNativeDb>;

beforeEach(() => {
  mockOpen.mockReset();
  nativeDb = makeNativeDb();
  mockOpen.mockReturnValue(nativeDb);
});

/** 取第 n 次 opOpen 收到的参数对象 */
function openArgs(n = 0): Record<string, unknown> {
  return mockOpen.mock.calls[n][0] as Record<string, unknown>;
}

describe('open → 传给 op-sqlite 原生的参数对象', () => {
  test('只传 name：键集合不含 undefined 值（encryptionKey 必须缺省）', () => {
    open({ name: 'guoxue.db' });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    const args = openArgs();
    expect(args.name).toBe('guoxue.db');
    // 关键判据：无 undefined 值 —— 旧实现此处是 'encryptionKey' in args === true
    expect(Object.keys(args).sort()).toEqual(['location', 'name']);
    expect(Object.values(args).every((v) => v !== undefined)).toBe(true);
    // 无 location 时锚定到 DocumentDirectoryPath（对齐 quick-sqlite 旧库位置）
    expect(args.location).toBe(DOC_DIR);
  });

  test('相对 location：锚定为 DocumentDirectoryPath/<location>（旧库路径不变）', () => {
    open({ name: 'user_books.db', location: 'dictionaries' });

    expect(openArgs().location).toBe(`${DOC_DIR}/dictionaries`);
  });

  test('显式传入 encryptionKey 才透传', () => {
    open({ name: 'x.db', encryptionKey: 'k' });

    expect(openArgs().encryptionKey).toBe('k');
  });
});

describe('delete → 实参个数契约（原生 count==1 才校验 location 类型）', () => {
  test('未传 location：必须 0 参调用，禁传 undefined', () => {
    const db = open({ name: 'user_books.db', location: 'dictionaries' });

    db.delete();

    expect(nativeDb.delete).toHaveBeenCalledTimes(1);
    // ⚠ 用 toHaveLength（而非 toEqual([])）：jest 的 toEqual 视 [undefined] ≡ []，
    // 传 undefined 的旧写法在 toEqual 下不会变红（实测变异不自证）。
    expect(nativeDb.delete.mock.calls[0]).toHaveLength(0);
  });

  test('传 location：锚定后的绝对路径', () => {
    const db = open({ name: 'user_books.db', location: 'dictionaries' });

    db.delete('dictionaries');

    expect(nativeDb.delete.mock.calls[0]).toEqual([`${DOC_DIR}/dictionaries`]);
  });
});
