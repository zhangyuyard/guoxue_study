/**
 * SQLite 客户端适配层（sqliteClient）
 * ------------------------------------------------------------------
 * 统一桥接点：生产用 @op-engineering/op-sqlite（新架构 TurboModule），
 * 测试经 `jest.mock('@/services/sqliteClient', ...)` 注入与旧
 * react-native-quick-sqlite 同形的内存适配器。
 *
 * 引入原因：op-sqlite v15 的 `execute` 已是 async（返回 Promise），
 * 同步版为 `executeSync` 且返回 `QueryResult.rows`（扁平数组），与旧
 * quick-sqlite 的「同步 execute + { rows: { _array } }」形状不兼容。
 * 本层把 op-sqlite 包成旧同步契约，使 StorageService / UserBookService /
 * CanonService / DictDatabase / SearchService 以及全部测试 mock 零改动。
 *
 * 适配层是唯一桥接点：原生能力变化只改此处，不动业务 SQL。
 *
 * ⚠ 路径锚定（数据迁移关键）：op-sqlite 的 `location` 基准目录与原
 * quick-sqlite / 应用 `RNFS.DocumentDirectoryPath` 不一致——
 *   - Android：`_base_path` = `context.getDatabasePath("").absolutePath`
 *     （`.../databases/`），而 quick-sqlite 与应用用 `getFilesDir()`
 *     （`.../files/`，即 `RNFS.DocumentDirectoryPath`）。
 *   - iOS：`_base_path` = `NSLibraryDirectory`（`.../Library/`），而应用用
 *     `NSDocumentDirectory`（`.../Documents/`，即 `RNFS.DocumentDirectoryPath`）。
 * 若不修正，op-sqlite 会在错误目录新建空库，找不到旧数据 = 升级丢数据。
 * 故本层把 `location` 一律锚定到 `RNFS.DocumentDirectoryPath`：
 *   - 无 location → `DocumentDirectoryPath`（对齐 quick-sqlite 默认）
 *   - 相对 location（如 'dictionaries'）→ `DocumentDirectoryPath/location`
 *   - 绝对路径 / ':memory:' → 透传
 * 最终文件 = `锚定目录/name`（op-sqlite 不加扩展名），与旧库文件名一致。
 */
import RNFS from 'react-native-fs';
import { open as opOpen, type DB as OpDB } from '@op-engineering/op-sqlite';

/** 行（quick-sqlite 形状：列名 → 标量） */
export type SqliteRow = Record<string, unknown>;

/** 查询结果（quick-sqlite 形状） */
export interface SqliteQueryResult {
  rows: { _array: SqliteRow[]; length: number };
  rowsAffected: number;
  insertId?: number;
}

/** 适配后的数据库句柄（与旧 quick-sqlite 同形） */
export interface SqliteDB {
  /** 同步执行（SELECT/INSERT/UPDATE/DELETE/DDL），返回 { rows: { _array } } */
  execute(sql: string, params?: (string | number | null)[]): SqliteQueryResult;
  /** 同步批量执行（op-sqlite 无 sync 版，此处用 executeSync 循环实现） */
  executeBatch(commands: Array<[string] | [string, (string | number | null)[]]>): void;
  /** 关闭连接 */
  close(): void;
  /** 删除数据库文件 */
  delete(location?: string): void;
}

/** 打开参数（沿用旧 open 形状） */
export interface SqliteOpenParams {
  name: string;
  location?: string;
  encryptionKey?: string;
}

/**
 * 把 location 锚定到 `RNFS.DocumentDirectoryPath`，对齐 quick-sqlite / 应用
 * 手动路径约定（详见文件头注释的「路径锚定」说明）。返回给 op-sqlite 的
 * 绝对目录（op-sqlite 对以 `/` 开头的 location 直接作为目录使用）。
 */
function resolveLocation(location?: string): string | undefined {
  if (!location) {
    // 无 location：对齐 quick-sqlite 默认（DocumentDirectoryPath）
    return RNFS.DocumentDirectoryPath;
  }
  if (location === ':memory:') {
    return ':memory:';
  }
  if (location.startsWith('/')) {
    // 已是绝对路径，直接透传
    return location;
  }
  // 相对 location：锚定到 DocumentDirectoryPath
  return `${RNFS.DocumentDirectoryPath}/${location}`;
}

/**
 * 打开数据库连接（适配层门面）。
 *
 * ⚠ 可选参数必须「键缺省」，禁写 `键: undefined`：op-sqlite 原生 open 用
 * `options.hasProperty(rt, "location"/"encryptionKey")` 判可选
 * （cpp/OPSqlite.cpp `open` 内），而 hasProperty 对「键在、值为 undefined」
 * 返回 true ⇒ 紧接着 `asString(undefined)` 抛
 * 「Value is undefined, expected a String」。
 * 真机症状（2026-10-08）：调用方全部只传 name（+location），适配层却补了
 * `encryptionKey: undefined` ⇒ **所有库打开全灭**，UserBookService 走
 * 删库重建也失败（同一条报错），StorageService/DictDatabase 静默降级。
 */
export function open(params: SqliteOpenParams): SqliteDB {
  const nativeParams: { name: string; location?: string; encryptionKey?: string } = {
    name: params.name,
  };
  const location = resolveLocation(params.location);
  if (location !== undefined) {
    nativeParams.location = location;
  }
  if (params.encryptionKey !== undefined) {
    nativeParams.encryptionKey = params.encryptionKey;
  }
  const db: OpDB = opOpen(nativeParams);
  return {
    execute(sql, params_) {
      const res = db.executeSync(sql, params_);
      const rows = res.rows as unknown as SqliteRow[];
      return {
        rows: { _array: rows, length: rows.length },
        rowsAffected: res.rowsAffected ?? 0,
        insertId: res.insertId,
      };
    },
    executeBatch(commands) {
      for (const cmd of commands) {
        const sql = cmd[0];
        const params_ = cmd.length > 1 ? (cmd[1] as (string | number | null)[] | undefined) : undefined;
        db.executeSync(sql, params_);
      }
    },
    close() {
      db.close();
    },
    delete(location) {
      // 未传 location 时让 op-sqlite 删除已打开的库（其路径即锚定后的绝对路径）；
      // 传入 location 时同样锚定，确保删除的是同一绝对目录下的库文件。
      //
      // ⚠ 原生 delete 按「实参个数」分派（cpp/DBHostObject.cpp `delete` 内
      // `if (count == 1)` 才校验 args[1].isString()）⇒ 无 location 时必须
      // **0 参调用**，显式传 undefined 会被判「database location must be a string」。
      const resolved = location === undefined ? undefined : resolveLocation(location);
      if (resolved === undefined) {
        db.delete();
        return;
      }
      db.delete(resolved);
    },
  };
}

export default { open };
