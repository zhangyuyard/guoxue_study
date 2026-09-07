/**
 * canon 校验服务（CanonService）
 * 单例，打开随包只读库 canon_dict.db（构建期由 scripts/build-canon-dict.mjs 生成，
 * 部署范式复用 DictDatabase 的 assets → 用户目录拷贝）。仅作只读 SELECT。
 *
 * 依赖方向：本文件 import PinyinService 的类型与注入函数（setCanonProvider），
 * 但 PinyinService 不 import 本文件 —— 注入由 DictEngine.init 完成，
 * 从而保持「pinyin → canon(通过接口)」单向依赖，避免环依赖。
 *
 * 查询三级策略（优先级高→低）：work_id = 精确篇目 → work_id = 书级(bookId) → work_id = '*' 全局。
 */
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { open } from 'react-native-quick-sqlite';
import { ConversionService } from '@/services/ConversionService';
import type {
  CanonProvider,
  CanonReadingResult,
  CanonTongjiaResult,
} from '@/types';

type DB = ReturnType<typeof open>;

/** canon 库文件名（assets 与用户目录中同名） */
export const CANON_DB_FILE = 'canon_dict.db';
/** canon 库版本（随数据更新 +1；与构建脚本互指；v3：两表增加 context 语料例句列，通假判定升级为用例级语境锚定；v4：无例句行不再放行，删除「其→箕」「虚→墟」误导弹性条目） */
export const CANON_DICT_VERSION = 4;
/** quick-sqlite 库目录（与 DictDatabase.DICT_DB_LOCATION 一致） */
export const CANON_DB_LOCATION = 'dictionaries';
/** assets 内字典目录 */
const ASSETS_DICT_DIR = 'dictionaries';

/** 已打开的连接（惰性单例） */
let db: DB | null = null;
/** 单例实例 */
let instance: CanonService | null = null;

/** 解析 sources 列（JSON 字符串数组） */
function parseSources(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

/** 解析三级查询层级（去重，末尾恒为 '*' 全局兜底） */
function resolveTiers(workId?: string, bookId?: string): string[] {
  const tiers: string[] = [];
  if (workId) {
    tiers.push(workId);
  }
  if (bookId && bookId !== workId) {
    tiers.push(bookId);
  }
  tiers.push('*');
  return tiers;
}

/**
 * 版本比对（纯函数，便于单测）：已部署库的 user_version 落后于目标版本时需要覆盖重拷。
 * 无版本标记（null/undefined）或非法值按 0 处理 → 视为最旧，触发升级
 * （兼容 v1 时代未写 user_version 的旧库）。
 */
export function isCanonDbOutdated(currentVersion: number | null | undefined): boolean {
  const v =
    typeof currentVersion === 'number' && Number.isFinite(currentVersion)
      ? currentVersion
      : 0;
  return v < CANON_DICT_VERSION;
}

class CanonService implements CanonProvider {
  /** 获取单例 */
  static getInstance(): CanonService {
    if (!instance) {
      instance = new CanonService();
    }
    return instance;
  }

  /**
   * 部署（从 assets 拷贝）并打开只读库。
   * 升级路径（v1→v2）：已存在库先打开读 user_version，落后于 CANON_DICT_VERSION 时
   * 关闭连接 → 覆盖重拷 assets 库 → 重新打开（幂等；任何失败均返回 false，
   * 调用方据此降级为「无 canon 证据」：通假不标角标、读音回退 pinyin-pro 并标未校验）。
   */
  async init(): Promise<boolean> {
    try {
      await CanonService.deployCanonDb();
      const dest = `${RNFS.DocumentDirectoryPath}/${CANON_DB_LOCATION}/${CANON_DB_FILE}`;
      if (!(await RNFS.exists(dest))) {
        return false;
      }
      db = open({ name: CANON_DB_FILE, location: CANON_DB_LOCATION });
      // 版本比对升级：旧版本触发覆盖重拷（★ 连接必须先关闭：open 按 name 单例，
      // 直接覆盖文件会让旧连接仍指向旧数据）
      if (isCanonDbOutdated(this.readUserVersion())) {
        try {
          db.close();
        } catch {
          // 未打开或已关闭，忽略
        }
        db = null;
        await CanonService.recopyCanonDb(dest);
        if (!(await RNFS.exists(dest))) {
          return false;
        }
        db = open({ name: CANON_DB_FILE, location: CANON_DB_LOCATION });
      }
      const rows = this.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['tongjia_judgment'],
      );
      if (rows.length === 0) {
        db = null;
        return false;
      }
      return true;
    } catch {
      db = null;
      return false;
    }
  }

  /** 关闭（测试/重置用） */
  close(): void {
    db = null;
  }

  /**
   * 读取当前已打开库的 PRAGMA user_version。
   * 无连接/读取失败返回 null（isCanonDbOutdated 内按 0 → 触发升级，保守取新库）。
   */
  private readUserVersion(): number | null {
    if (!db) {
      return null;
    }
    try {
      const res = db.execute('PRAGMA user_version');
      const rows = (res.rows?._array ?? []) as Record<string, unknown>[];
      const v = rows[0]?.user_version;
      return typeof v === 'number' ? v : Number(v ?? 0);
    } catch {
      return null;
    }
  }

  // ---------- 内部查询 ----------

  private query(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
    if (!db) {
      return [];
    }
    try {
      const res = db.execute(sql, params);
      return (res.rows?._array ?? []) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  /**
   * 三级查询候选解析：按 pri(命中层级) 升序返回全部候选行（调用方取首条即为
   * 最高优先级行）。CASE 的 WHEN 分支数随 tiers 数量动态生成，使 SQL 的 `?`
   * 数量与 params（[...tiers, char, ...tiers]）严格对齐——否则 quick-sqlite 会抛
   * 「Too many parameter values」导致查询静默失败、角标永不显示。
   * params 结构：前半 tiers 个用于 CASE 赋值，中间 1 个 char，后半 tiers 个用于 IN 匹配。
   */
  private selectAll(
    table: string,
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): Record<string, unknown>[] {
    const tiers = resolveTiers(workId, bookId);
    const placeholders = tiers.map(() => '?').join(', ');
    const caseBranches = tiers.map((_, i) => `WHEN ? THEN ${i}`).join(' ');
    // 排序：层级优先（章级 > 书级 > '*'）；同层级内有语料例句（context 非空）的行优先
    // （v3 用例级锚定行比粒度粗的旧行更精确）；同序保持插入顺序（rowid）
    const sql = `
      SELECT *,
        CASE work_id
          ${caseBranches}
          ELSE ${tiers.length}
        END AS pri
      FROM ${table}
      WHERE char = ? AND work_id IN (${placeholders})
      ORDER BY pri ASC, CASE WHEN context IS NULL THEN 1 ELSE 0 END ASC, rowid ASC`;
    const params = [...tiers, char, ...tiers];
    return this.query(sql, params);
  }

  /** 行 → CanonTongjiaResult（context 为 v3 新列，旧库无此列时为 undefined） */
  private rowToTongjia(row: Record<string, unknown>): CanonTongjiaResult {
    return {
      original: String(row.original),
      note: row.note ? String(row.note) : undefined,
      sources: parseSources(row.sources),
      verified: Number(row.verified) === 1,
      // 用字关系类型：通假 / 古今字（v2 库起有 type 列；旧库无此列时回退通假）
      kind: row.type === 'gujin' ? 'gujin' : 'tongjia',
      context: row.context ? String(row.context) : undefined,
    };
  }

  /** 行 → CanonReadingResult（context 为 v3 新列，旧库无此列时为 undefined） */
  private rowToReading(row: Record<string, unknown>): CanonReadingResult {
    return {
      reading: String(row.reading),
      sources: parseSources(row.sources),
      verified: Number(row.verified) === 1,
      context: row.context ? String(row.context) : undefined,
    };
  }

  // ---------- CanonProvider 实现 ----------

  getTongjiaCandidates(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonTongjiaResult[] {
    if (!db || !char) {
      return [];
    }
    // 归一化到简体：canon 库按简体字建索引（如「说通悦」）。
    // 阅读页开启繁体显示时传入的是繁体字符（如「說」），若不归一化会查询 miss、
    // 导致通假角标在繁体下不显示。繁体→简体转换幂等，简体字符原样返回。
    const queryChar = ConversionService.toSimplified(char).data ?? char;
    return this.selectAll('tongjia_judgment', workId, bookId, queryChar).map((r) =>
      this.rowToTongjia(r),
    );
  }

  getReadingCandidates(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonReadingResult[] {
    if (!db || !char) {
      return [];
    }
    // 同上：读音选择也按简体字符索引，繁体传入需归一化后再查。
    const queryChar = ConversionService.toSimplified(char).data ?? char;
    return this.selectAll('reading_selection', workId, bookId, queryChar).map((r) =>
      this.rowToReading(r),
    );
  }

  getTongjia(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonTongjiaResult | null {
    // 单行判定 = 候选首条（层级优先 + 有语境证据优先；语境校验由 PinyinService 层做）
    return this.getTongjiaCandidates(workId, bookId, char)[0] ?? null;
  }

  getReading(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonReadingResult | null {
    // 单行判定 = 候选首条（语境校验由 PinyinService 层做）
    return this.getReadingCandidates(workId, bookId, char)[0] ?? null;
  }

  // ---------- 部署 ----------

  /** 部署 canon 库（幂等）：不存在时从 assets 拷贝；已存在时由 init 的版本比对决定是否覆盖 */
  private static async deployCanonDb(): Promise<void> {
    const dest = `${RNFS.DocumentDirectoryPath}/${CANON_DB_LOCATION}/${CANON_DB_FILE}`;
    await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/${CANON_DB_LOCATION}`).catch(() => undefined);
    const exists = await RNFS.exists(dest);
    if (exists) {
      return;
    }
    await CanonService.copyFromAssets(dest);
  }

  /**
   * 覆盖重拷 assets 库（升级路径）。
   * 先清理 WAL/journal 残留，避免旧库日志干扰新文件（沿用 DictDatabase.deployNativeDb 模式）。
   */
  private static async recopyCanonDb(dest: string): Promise<void> {
    await RNFS.unlink(`${dest}-wal`).catch(() => undefined);
    await RNFS.unlink(`${dest}-shm`).catch(() => undefined);
    await RNFS.unlink(`${dest}-journal`).catch(() => undefined);
    await CanonService.copyFromAssets(dest);
  }

  /** 从 assets / iOS bundle 拷贝 canon 库到目标路径 */
  private static async copyFromAssets(dest: string): Promise<void> {
    if (Platform.OS === 'android') {
      await RNFS.copyFileAssets(`${ASSETS_DICT_DIR}/${CANON_DB_FILE}`, dest);
    } else {
      await RNFS.copyFile(`${RNFS.MainBundlePath}/${ASSETS_DICT_DIR}/${CANON_DB_FILE}`, dest);
    }
  }
}

export default CanonService;
