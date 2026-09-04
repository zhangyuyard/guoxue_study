/**
 * 字典数据库层（DictDatabase）
 * 双 db 分层（同一套表结构）：
 *   - native_dict.db：只读。构建期由 scripts/build-native-dict.mjs 生成，
 *     随包放在 assets/dictionaries/，首启经 RNFS 拷贝到用户目录，之后只 SELECT。
 *   - user_dict.db：可写。运行时创建，存放全部用户导入字典与 mdd 资源。
 * 严禁触碰 guoxue.db（StorageService 专属）。
 * quick-sqlite 调用沿用 StorageService 的 open({name}) + execute + rows._array 模式。
 */
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { open } from 'react-native-quick-sqlite';
import type { DictEntry, DictEntryExtra, ServiceResult } from '@/types';
import type { DictMeta } from '@/types/dict';

type DB = ReturnType<typeof open>;

/** 字典逻辑库名：native = 原生只读库，user = 用户可写库 */
export type DictDbName = 'native' | 'user';

/** 原生字典数据版本：每次重跑构建脚本必须 +1（PRAGMA user_version 比对） */
export const NATIVE_DICT_VERSION = 3;
/** 原生字典 db 文件名（assets 与用户目录中同名） */
export const NATIVE_DB_FILE = 'native_dict.db';
/** 用户字典 db 文件名 */
export const USER_DB_FILE = 'user_dict.db';
/** quick-sqlite 库目录（子目录；Android=filesDir/dictionaries，iOS=Documents/dictionaries） */
export const DICT_DB_LOCATION = 'dictionaries';
/** assets 内字典目录（Android assets / iOS bundle 内相对路径） */
export const ASSETS_DICT_DIR = 'dictionaries';
/** 批量写入批大小 */
export const ENTRY_BATCH_SIZE = 1000;

/** 库名 → db 文件名映射 */
const DB_FILES: Record<DictDbName, string> = {
  native: NATIVE_DB_FILE,
  user: USER_DB_FILE,
};

/** 已打开的连接（惰性单例） */
const dbs: Partial<Record<DictDbName, DB>> = {};

// ---------- 基础辅助 ----------

/** 获取（或打开）指定字典库连接 */
function getDb(dbName: DictDbName): DB | null {
  const existing = dbs[dbName];
  if (existing) {
    return existing;
  }
  try {
    const instance = open({ name: DB_FILES[dbName], location: DICT_DB_LOCATION });
    dbs[dbName] = instance;
    return instance;
  } catch (e) {
    return null;
  }
}

/** 原生 db 在用户目录中的完整路径 */
function nativeDbDestPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${DICT_DB_LOCATION}/${NATIVE_DB_FILE}`;
}

/** 读取原生 db 的 PRAGMA user_version（无行返回 0） */
function readNativeUserVersion(): number {
  const instance = getDb('native');
  if (!instance) {
    return 0;
  }
  try {
    const res = instance.execute('PRAGMA user_version');
    const rows = (res.rows?._array ?? []) as Array<Record<string, unknown>>;
    const v = rows[0]?.user_version;
    return typeof v === 'number' ? v : Number(v ?? 0);
  } catch {
    return 0;
  }
}

// ---------- DDL（两库同构；resources 仅 user 库使用） ----------

const CREATE_DICTS = `
  CREATE TABLE IF NOT EXISTS dicts (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    format         TEXT NOT NULL,
    entry_count    INTEGER NOT NULL DEFAULT 0,
    version        TEXT,
    license        TEXT,
    description    TEXT,
    lang_pair      TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
`;

const CREATE_ENTRIES = `
  CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dict_id       TEXT NOT NULL,
    headword      TEXT NOT NULL,
    headword_norm TEXT NOT NULL,
    pinyin        TEXT,
    readings_json TEXT,
    content       TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    extra_json    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entries_lookup ON entries (dict_id, headword_norm);
  CREATE INDEX IF NOT EXISTS idx_entries_prefix ON entries (headword_norm);
`;

const CREATE_RESOURCES = `
  CREATE TABLE IF NOT EXISTS resources (
    key         TEXT PRIMARY KEY NOT NULL,
    mime        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    data_base64 TEXT NOT NULL
  );
`;

// ---------- 部署与打开 ----------

/**
 * 部署原生 db（幂等）：不存在或 user_version 落后时从 assets 拷贝覆盖。
 * Android 用 RNFS.copyFileAssets；iOS 用 RNFS.copyFile(MainBundlePath)。
 */
export async function deployNativeDb(): Promise<ServiceResult<boolean>> {
  const dest = nativeDbDestPath();
  try {
    // 1) 确保目录存在（RNFS.mkdir 对已存在目录会 reject，忽略）
    await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/${DICT_DB_LOCATION}`).catch(() => undefined);

    // 2) 不存在 → 首次拷贝
    let exists = await RNFS.exists(dest);
    if (!exists) {
      if (Platform.OS === 'android') {
        await RNFS.copyFileAssets(`${ASSETS_DICT_DIR}/${NATIVE_DB_FILE}`, dest);
      } else {
        await RNFS.copyFile(`${RNFS.MainBundlePath}/${ASSETS_DICT_DIR}/${NATIVE_DB_FILE}`, dest);
      }
      exists = true;
    }

    // 3) 版本比对：落后 → 覆盖重拷（升级路径）
    //    ★ 连接必须先关闭：readNativeUserVersion 已把旧文件连接缓存进 dbs 单例，
    //    若直接 copyFile 覆盖，旧连接仍指向旧 inode，本会话内读到的永远是旧数据。
    if (readNativeUserVersion() < NATIVE_DICT_VERSION) {
      try {
        dbs.native?.close(); // 连接级 close（quick-sqlite 无顶层 close 导出）
      } catch {
        // 未打开或已关闭，忽略
      }
      delete dbs.native;
      // 清理 WAL/journal 残留（拷贝覆盖前清掉，避免旧日志干扰新文件）
      await RNFS.unlink(`${dest}-wal`).catch(() => undefined);
      await RNFS.unlink(`${dest}-shm`).catch(() => undefined);
      await RNFS.unlink(`${dest}-journal`).catch(() => undefined);
      if (Platform.OS === 'android') {
        await RNFS.copyFileAssets(`${ASSETS_DICT_DIR}/${NATIVE_DB_FILE}`, dest);
      } else {
        await RNFS.copyFile(`${RNFS.MainBundlePath}/${ASSETS_DICT_DIR}/${NATIVE_DB_FILE}`, dest);
      }
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `部署原生字典失败：${(e as Error).message}` };
  }
}

/**
 * 打开双连接并建 user 库表（幂等，惰性单例）。
 * 注意：原生库为只读语义，本方法不向其写入任何数据。
 */
export function openDictDatabases(): ServiceResult<boolean> {
  const nativeDb = getDb('native');
  const userDb = getDb('user');
  if (!nativeDb || !userDb) {
    return { success: false, error: '字典数据库初始化失败：无法打开数据库连接' };
  }
  try {
    for (const sql of [CREATE_DICTS, CREATE_ENTRIES, CREATE_RESOURCES]) {
      userDb.execute(sql);
    }
    // 旧库幂等迁移：lang_pair 列（已存在时 ALTER 报错，忽略）
    try {
      userDb.execute('ALTER TABLE dicts ADD COLUMN lang_pair TEXT');
    } catch {
      // 列已存在
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `字典数据库建表失败：${(e as Error).message}` };
  }
}

/** 关闭并清空连接（测试用；正常生命周期不需要） */
export function closeDictDatabases(): void {
  dbs.native = undefined;
  dbs.user = undefined;
}

// ---------- 查询辅助 ----------

/** 统一 SELECT 辅助（沿用 StorageService.selectRows 模式），失败抛异常由调用方捕获 */
export function selectRows(
  dbName: DictDbName,
  sql: string,
  params: (string | number)[] = [],
): Record<string, unknown>[] {
  const instance = getDb(dbName);
  if (!instance) {
    throw new Error('字典数据库不可用');
  }
  const res = instance.execute(sql, params);
  return (res.rows?._array ?? []) as Record<string, unknown>[];
}

/** 解析 TEXT 列中的 JSON（空/坏数据返回 undefined） */
function parseJsonArray<T>(raw: unknown): T[] | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseExtra(raw: unknown): DictEntryExtra | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? (parsed as DictEntryExtra) : undefined;
  } catch {
    return undefined;
  }
}

/** 行 → DictEntry 映射（导出供引擎与测试复用） */
export function rowToEntry(row: Record<string, unknown>): DictEntry {
  return {
    id: Number(row.id),
    dictId: String(row.dict_id),
    headword: String(row.headword),
    headwordNorm: String(row.headword_norm),
    pinyin: row.pinyin ? String(row.pinyin) : undefined,
    readings: parseJsonArray<string>(row.readings_json),
    contentType: String(row.content_type) as DictEntry['contentType'],
    content: String(row.content),
    extra: parseExtra(row.extra_json),
  };
}

/** 行 → 字典元数据（db 内不可变部分；enabled/order 由 store 合并） */
export function rowToDictMeta(row: Record<string, unknown>): Omit<DictMeta, 'enabled' | 'order'> {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as DictMeta['kind'],
    format: String(row.format) as DictMeta['format'],
    entryCount: Number(row.entry_count ?? 0),
    version: row.version ? String(row.version) : undefined,
    license: row.license ? String(row.license) : undefined,
    description: row.description ? String(row.description) : undefined,
    langPair: row.lang_pair ? String(row.lang_pair) : undefined,
    sizeBytes: row.size_bytes !== undefined && row.size_bytes !== null ? Number(row.size_bytes) : undefined,
    createdAt: row.created_at ? String(row.created_at) : undefined,
  };
}

// ---------- 写入（仅 user 库） ----------

/** 确保 user 库连接可用，返回连接（写入专用） */
function getUserDb(): DB {
  const instance = getDb('user');
  if (!instance) {
    throw new Error('用户字典数据库不可用');
  }
  return instance;
}

/** 插入字典元数据行（INSERT OR REPLACE，幂等） */
export function insertDictRow(meta: Omit<DictMeta, 'enabled' | 'order'>): void {
  getUserDb().execute(
    `INSERT OR REPLACE INTO dicts
     (id, name, kind, format, entry_count, version, license, description, lang_pair, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.id,
      meta.name,
      meta.kind,
      meta.format,
      meta.entryCount,
      meta.version ?? null,
      meta.license ?? null,
      meta.description ?? null,
      meta.langPair ?? null,
      meta.createdAt ?? new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
}

/** 回填词条数（导入完成后调用） */
export function updateEntryCount(dictId: string, entryCount: number): void {
  getUserDb().execute(
    'UPDATE dicts SET entry_count = ?, updated_at = ? WHERE id = ?',
    [entryCount, new Date().toISOString(), dictId],
  );
}

/**
 * 分批写词条（内部事务 + executeBatch，batchSize=1000），返回写入条数。
 * 仅写入 user 库。
 */
export function insertEntries(dictId: string, entries: DictEntry[]): number {
  if (entries.length === 0) {
    return 0;
  }
  const db = getUserDb();
  let written = 0;
  for (let start = 0; start < entries.length; start += ENTRY_BATCH_SIZE) {
    const slice = entries.slice(start, start + ENTRY_BATCH_SIZE);
    const commands = slice.map(
      (e) =>
        [
          `INSERT INTO entries
           (dict_id, headword, headword_norm, pinyin, readings_json, content, content_type, extra_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dictId,
            e.headword,
            e.headwordNorm,
            e.pinyin ?? null,
            e.readings ? JSON.stringify(e.readings) : null,
            e.content,
            e.contentType,
            e.extra ? JSON.stringify(e.extra) : null,
          ],
        ] as [string, (string | number | null)[]],
    );
    db.execute('BEGIN IMMEDIATE');
    try {
      db.executeBatch(commands);
      db.execute('COMMIT');
      written += slice.length;
    } catch (e) {
      db.execute('ROLLBACK');
      throw e;
    }
  }
  return written;
}

/** 删除用户字典全部词条（dicts 行由调用方决定是否一并删除） */
export function deleteEntriesByDict(dictId: string): void {
  getUserDb().execute('DELETE FROM entries WHERE dict_id = ?', [dictId]);
}

/** 删除字典元数据行 */
export function deleteDictRow(dictId: string): void {
  getUserDb().execute('DELETE FROM dicts WHERE id = ?', [dictId]);
}

/** 收缩 user 库（删除字典后回收空间） */
export function vacuumUserDb(): void {
  getUserDb().execute('VACUUM');
}

/** 写入 mdd 资源（仅 user 库） */
export function insertResource(key: string, mime: string, sizeBytes: number, dataBase64: string): void {
  getUserDb().execute(
    `INSERT OR REPLACE INTO resources (key, mime, size_bytes, data_base64) VALUES (?, ?, ?, ?)`,
    [key, mime, sizeBytes, dataBase64],
  );
}

/** 读取 mdd 资源 */
export function getResource(key: string): { mime: string; dataBase64: string } | null {
  try {
    const rows = selectRows('user', 'SELECT * FROM resources WHERE key = ?', [key]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { mime: String(row.mime), dataBase64: String(row.data_base64) };
  } catch {
    return null;
  }
}

/** mdd 资源总量（字节，用于 50MB 上限判断） */
export function getResourcesTotalSize(): number {
  try {
    const rows = selectRows('user', 'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM resources');
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

/** 查询某库全部字典元数据行 */
export function selectDictRows(dbName: DictDbName): Record<string, unknown>[] {
  return selectRows(dbName, 'SELECT * FROM dicts ORDER BY created_at ASC, id ASC');
}

export const DictDatabase = {
  NATIVE_DICT_VERSION,
  NATIVE_DB_FILE,
  USER_DB_FILE,
  DICT_DB_LOCATION,
  deployNativeDb,
  openDictDatabases,
  closeDictDatabases,
  selectRows,
  rowToEntry,
  rowToDictMeta,
  insertDictRow,
  insertEntries,
  updateEntryCount,
  deleteEntriesByDict,
  deleteDictRow,
  vacuumUserDb,
  insertResource,
  getResource,
  getResourcesTotalSize,
  selectDictRows,
};

export default DictDatabase;
