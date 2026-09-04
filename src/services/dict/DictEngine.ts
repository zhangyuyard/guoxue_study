/**
 * 统一字典查询引擎（DictEngine）
 * 职责：
 *   - init：部署原生 db → 打开双库 → 同步 store 元数据 → 注册多音字外部提供者
 *   - lookup / lookupInDict / searchPrefix / listDicts / deleteDict
 *   - ReadingProvider 实现（注入 PinyinService，依赖方向 dict → pinyin 单向）
 * 归一化唯一入口 normalizeHeadword()（§8.4：导入与查询共用，禁止双实现）。
 */
import * as OpenCC from 'opencc-js';
import type { DictEntry, DictLookupResult, DictMeta, ServiceResult } from '@/types';
import type { DictSense } from '@/types/dict';

import tongjiaData from '@/data/tongjia-zi.json';
import yitiData from '@/data/yiti-zi.json';
import { setExternalReadingProvider, setCanonProvider } from '@/services/PinyinService';
import * as DictDatabase from '@/services/dict/DictDatabase';
import CanonService from '@/services/CanonService';
import { useDictStore } from '@/store/useDictStore';

// ---------- 归一化（§3.3，唯一入口；scripts/build-native-dict.mjs 内有等价复制并互指注释） ----------

/** 繁→简转换器（仅汉字，字母数字不动） */
const t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });

/** 零宽字符（U+200B / U+FEFF）与首尾空白 */
const ZERO_WIDTH_RE = /^[\s\u200b\ufeff]+|[\s\u200b\ufeff]+$/g;

/** 字头归一化：trim → 繁转简 → 拉丁小写 → 去零宽字符 */
export function normalizeHeadword(hw: string): string {
  return t2sConverter(hw.trim())
    .toLowerCase()
    .replace(ZERO_WIDTH_RE, '');
}

// ---------- 异体字 / 通假字索引（复用现有数据，与 PinyinService 同构） ----------

interface YitiGroup {
  standard: string;
  variants: string[];
}

interface TongjiaEntry {
  char: string;
  original: string;
  note: string;
}

const YITI_GROUPS = yitiData.groups as unknown as YitiGroup[];
const TONGJIA_ENTRIES = tongjiaData.entries as unknown as TongjiaEntry[];

/** 标准字 -> 异体字列表 */
const yitiByStandard = new Map<string, string[]>();
/** 异体字 -> 标准字（反向） */
const yitiReverse = new Map<string, string>();
for (const group of YITI_GROUPS) {
  yitiByStandard.set(group.standard, group.variants);
  for (const v of group.variants) {
    if (!yitiReverse.has(v)) {
      yitiReverse.set(v, group.standard);
    }
  }
}

const tongjiaByChar = new Map<string, TongjiaEntry>();
for (const entry of TONGJIA_ENTRIES) {
  if (!tongjiaByChar.has(entry.char)) {
    tongjiaByChar.set(entry.char, entry);
  }
}

/** 获取某字的异体字关联（正向优先，反向映射回标准字） */
function getYiti(char: string): string[] {
  const variants = yitiByStandard.get(char);
  if (variants) {
    return variants;
  }
  const standard = yitiReverse.get(char);
  return standard ? [standard] : [];
}

/** 单字查询的归一化候选（含异体字扩展） */
function normCandidates(hw: string): string[] {
  const norm = normalizeHeadword(hw);
  const cands = [norm];
  const chars = Array.from(norm);
  if (chars.length === 1) {
    for (const v of getYiti(chars[0])) {
      const n = normalizeHeadword(v);
      if (n && !cands.includes(n)) {
        cands.push(n);
      }
    }
  }
  return cands;
}

// ---------- 引擎状态 ----------

/** dictId → 所在逻辑库 */
const dictDbMap = new Map<string, DictDatabase.DictDbName>();
/** 初始化是否已完成 */
let initialized = false;

/**
 * dicts 表行缓存（native/user，按逻辑库各一份）。
 * lookup 每次只需元数据 × store 设置的合并视图，无需每次重读 db；
 * 缓存仅在 refreshDictDbMap()（增删字典 / init / listDicts / 导入后 syncFromEngine 的必经路径）时失效，
 * enabled/order 合并仍实时读 store，不受缓存影响。
 */
const dictRowsCache: Partial<Record<DictDatabase.DictDbName, Record<string, unknown>[]>> = {};

/** 清空 dicts 表行缓存（元数据变更点调用） */
function invalidateDictRowsCache(): void {
  dictRowsCache.native = undefined;
  dictRowsCache.user = undefined;
}

/** 读取 dicts 表行（带缓存；缓存未命中时回源 db） */
function cachedSelectDictRows(dbName: DictDatabase.DictDbName): Record<string, unknown>[] {
  const hit = dictRowsCache[dbName];
  if (hit) {
    return hit;
  }
  const rows = DictDatabase.selectDictRows(dbName);
  dictRowsCache[dbName] = rows;
  return rows;
}

/** 刷新 dictId → 逻辑库映射（同时失效 dicts 行缓存） */
function refreshDictDbMap(): void {
  invalidateDictRowsCache();
  dictDbMap.clear();
  for (const row of cachedSelectDictRows('native')) {
    dictDbMap.set(String(row.id), 'native');
  }
  for (const row of cachedSelectDictRows('user')) {
    dictDbMap.set(String(row.id), 'user');
  }
}

/** 合并 db 元数据 × store 设置为 DictMeta 列表（enabled/order） */
function mergeDictMetas(): DictMeta[] {
  const settings = useDictStore.getState().dictSettings;
  const metas: DictMeta[] = [];
  const seen = new Set<string>();
  for (const dbName of ['native', 'user'] as const) {
    for (const row of cachedSelectDictRows(dbName)) {
      const base = DictDatabase.rowToDictMeta(row);
      if (seen.has(base.id)) {
        continue;
      }
      seen.add(base.id);
      const s = settings[base.id];
      metas.push({
        ...base,
        enabled: s ? s.enabled : true,
        order: s ? s.order : Number.MAX_SAFE_INTEGER,
      });
    }
  }
  metas.sort((a, b) => a.order - b.order || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return metas;
}

// ---------- 公开 API ----------

/** LIKE 通配符转义（配合 ESCAPE '\'）：\ → \\、% → \%、_ → \_，用户输入按字面匹配 */
function escapeLikePattern(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

// ---------- 查询语向粗判（lang_pair 消费端；仅服务 searchPrefix 排序，不与 TranslationService 耦合） ----------

/** 查询语种粗判结果 */
type QueryScript = 'latin' | 'cjk';

/** 拉丁字母（含扩展拉丁区：Latin-1 Supplement / Extended-A / Extended-B / Extended Additional） */
const LATIN_CHAR_RE = /[a-z\u00c0-\u024f\u1e00-\u1eff]/i;
/** CJK 汉字（扩展 A 0x3400-0x4DBF / 基本区 0x4E00-0x9FFF / 兼容表意区 0xF900-0xFAFF） */
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 查询语种粗判：
 *   1. 首字符即「有效字符」（拉丁 / CJK）时，由其直接决定语向；
 *   2. 数字 / 标点开头时，按整串拉丁 vs CJK 字符占比判定（默认 cjk）；
 *   3. 整串无任何有效字符时，默认 cjk。
 */
function detectQueryScript(query: string): QueryScript {
  let latin = 0;
  let cjk = 0;
  for (const ch of query) {
    if (LATIN_CHAR_RE.test(ch)) {
      latin += 1;
    } else if (CJK_CHAR_RE.test(ch)) {
      cjk += 1;
    }
  }
  const first = Array.from(query).find((ch) => LATIN_CHAR_RE.test(ch) || CJK_CHAR_RE.test(ch));
  if (first) {
    // 首字符即有效字符：直接决定语向；否则（数字/标点开头）按整串占比
    if (first === query.charAt(0)) {
      return LATIN_CHAR_RE.test(first) ? 'latin' : 'cjk';
    }
    return cjk >= latin ? 'cjk' : 'latin';
  }
  return 'cjk';
}

/**
 * 语向感知的字典分批顺序（稳定，不改变结果集内容，只调查询顺序）：
 *   - latin 查询：en-zh（英→中）字典排前；
 *   - cjk 查询：非 en-zh（zh-en 与无 langPair 的中文单语）排前；
 *   - 两批内部均保持 mergeDictMetas 的用户启用顺序。
 */
function orderDictsByLangPair(metas: DictMeta[], script: QueryScript): DictMeta[] {
  const preferred = (m: DictMeta): boolean =>
    script === 'latin' ? m.langPair === 'en-zh' : m.langPair !== 'en-zh';
  return [...metas.filter(preferred), ...metas.filter((m) => !preferred(m))];
}

export const DictEngine = {
  /**
   * App 启动调用（异步，不阻塞渲染）：
   * deployNativeDb → openDictDatabases → 同步 useDictStore 元数据 → 注册多音字提供者。
   */
  async init(): Promise<ServiceResult<boolean>> {
    try {
      const deployRes = await DictDatabase.deployNativeDb();
      if (!deployRes.success) {
        return deployRes;
      }
      const openRes = DictDatabase.openDictDatabases();
      if (!openRes.success) {
        return openRes;
      }
      refreshDictDbMap();
      useDictStore.getState().syncFromEngine();
      setExternalReadingProvider(DictEngine);
      // canon 语境校验注入（依赖单向：PinyinService 仅依赖 CanonProvider 接口）
      try {
        const canonReady = await CanonService.getInstance().init();
        if (canonReady) {
          setCanonProvider(CanonService.getInstance());
        }
      } catch {
        // canon 不可用：降级为「无证据」（通假不标、读音回退未校验）
      }
      initialized = true;
      return { success: true, data: true };
    } catch (e) {
      return { success: false, error: `字典引擎初始化失败：${(e as Error).message}` };
    }
  },

  /** 是否已初始化完成（UI 兜底态判断） */
  isReady(): boolean {
    return initialized;
  },

  /** 聚合查字：按 store 中 enabled + order 的字典依次查，合并为 DictLookupResult */
  lookup(headword: string, opts?: { dictIds?: string[] }): ServiceResult<DictLookupResult> {
    const target = headword.trim();
    if (!target) {
      return { success: false, error: '查询字头不能为空' };
    }
    try {
      const allMetas = mergeDictMetas();
      const metas = allMetas.filter((m) => {
        if (opts?.dictIds) {
          return opts.dictIds.includes(m.id);
        }
        return m.enabled;
      });
      const candidates = normCandidates(target);
      const placeholders = candidates.map(() => '?').join(', ');

      const results: DictLookupResult['results'] = metas.map((dict) => {
        const dbName = dictDbMap.get(dict.id);
        let entry: DictEntry | null = null;
        if (dbName) {
          const rows = DictDatabase.selectRows(
            dbName,
            `SELECT * FROM entries WHERE dict_id = ? AND headword_norm IN (${placeholders})
             ORDER BY id ASC LIMIT 1`,
            [dict.id, ...candidates],
          );
          if (rows.length > 0) {
            entry = DictDatabase.rowToEntry(rows[0]);
          }
        }
        return { dict, entry };
      });

      // 单字时聚合头部信息（radical/strokes 取首个命中字典；yiti/tongjia 来自内置数据）
      let charInfo: DictLookupResult['charInfo'];
      const chars = Array.from(target);
      if (chars.length === 1) {
        const firstHit = results.find((r) => r.entry !== null)?.entry ?? null;
        const tongjia = tongjiaByChar.get(chars[0]);
        charInfo = {
          radical: firstHit?.extra?.radical,
          strokes: firstHit?.extra?.strokes,
          yiti: getYiti(chars[0]),
          tongjia: tongjia ? { original: tongjia.original, note: tongjia.note } : undefined,
        };
      }

      return { success: true, data: { headword: target, results, charInfo } };
    } catch (e) {
      return { success: false, error: `查字失败：${(e as Error).message}` };
    }
  },

  /** 单字典查询（查字页切换来源标签用）；未收录返回 null */
  lookupInDict(headword: string, dictId: string): ServiceResult<DictEntry | null> {
    const target = headword.trim();
    if (!target || !dictId) {
      return { success: false, error: '查询字头与字典 ID 不能为空' };
    }
    try {
      refreshDictDbMap();
      const dbName = dictDbMap.get(dictId);
      if (!dbName) {
        return { success: true, data: null };
      }
      const candidates = normCandidates(target);
      const placeholders = candidates.map(() => '?').join(', ');
      const rows = DictDatabase.selectRows(
        dbName,
        `SELECT * FROM entries WHERE dict_id = ? AND headword_norm IN (${placeholders})
         ORDER BY id ASC LIMIT 1`,
        [dictId, ...candidates],
      );
      return { success: true, data: rows.length > 0 ? DictDatabase.rowToEntry(rows[0]) : null };
    } catch (e) {
      return { success: false, error: `查字失败：${(e as Error).message}` };
    }
  },

  /**
   * 前缀联想（搜索框建议；跨双库去重，limit 默认 20）。
   * 语向感知：按查询语种粗判将启用字典分两批（匹配语向在前），逐字典查询并去重，
   * 填满 limit 后不再查其余批次；返回结构保持 string[]，不影响查字页消费方式。
   */
  searchPrefix(prefix: string, limit = 20): ServiceResult<string[]> {
    const target = normalizeHeadword(prefix);
    if (!target) {
      return { success: true, data: [] };
    }
    try {
      // 引擎未走任何 refresh 路径时兜底建映射（init 后恒非空，正常不触发）
      if (dictDbMap.size === 0) {
        refreshDictDbMap();
      }
      const enabled = mergeDictMetas().filter((m) => m.enabled);
      const ordered = orderDictsByLangPair(enabled, detectQueryScript(target));

      const found: string[] = [];
      const pattern = `${escapeLikePattern(target)}%`;
      for (const meta of ordered) {
        if (found.length >= limit) {
          break;
        }
        const dbName = dictDbMap.get(meta.id);
        if (!dbName) {
          continue;
        }
        const rows = DictDatabase.selectRows(
          dbName,
          `SELECT DISTINCT headword FROM entries WHERE dict_id = ? AND headword_norm LIKE ? ESCAPE '\\' ORDER BY headword ASC LIMIT ?`,
          [meta.id, pattern, limit * 2],
        );
        for (const row of rows) {
          const hw = String(row.headword);
          if (!found.includes(hw)) {
            found.push(hw);
          }
          if (found.length >= limit) {
            break;
          }
        }
      }
      return { success: true, data: found.slice(0, limit) };
    } catch (e) {
      return { success: false, error: `前缀查询失败：${(e as Error).message}` };
    }
  },

  /** 合并视图：db 元数据 × store 设置（enabled/order） */
  listDicts(): ServiceResult<DictMeta[]> {
    try {
      refreshDictDbMap();
      return { success: true, data: mergeDictMetas() };
    } catch (e) {
      return { success: false, error: `字典列表查询失败：${(e as Error).message}` };
    }
  },

  /** 删除用户字典（清 entries + dicts 行 + VACUUM；多音字来源指向它则回退 builtin） */
  deleteDict(dictId: string): ServiceResult<boolean> {
    try {
      const dbName = dictDbMap.get(dictId) ?? (refreshDictDbMap(), dictDbMap.get(dictId));
      if (!dbName) {
        return { success: false, error: `字典不存在：${dictId}` };
      }
      if (dbName === 'native') {
        return { success: false, error: '原生字典为只读，不支持删除' };
      }
      DictDatabase.deleteEntriesByDict(dictId);
      DictDatabase.deleteDictRow(dictId);
      DictDatabase.vacuumUserDb();
      refreshDictDbMap();
      // store 清残留（含 defaultDictId / polyphoneSource 回退 builtin）
      useDictStore.getState().removeSetting(dictId);
      return { success: true, data: true };
    } catch (e) {
      return { success: false, error: `删除字典失败：${(e as Error).message}` };
    }
  },

  // ---- ReadingProvider 实现（注入 PinyinService；§4.3 仲裁） ----

  /** 多音字候选：各启用字典 readings 并集 */
  getReadings(char: string): string[] {
    if (Array.from(char).length !== 1) {
      return [];
    }
    const readings: string[] = [];
    try {
      const norm = normalizeHeadword(char);
      for (const dbName of ['native', 'user'] as const) {
        const rows = DictDatabase.selectRows(
          dbName,
          'SELECT readings_json FROM entries WHERE headword_norm = ? AND readings_json IS NOT NULL',
          [norm],
        );
        for (const row of rows) {
          try {
            const arr = JSON.parse(String(row.readings_json));
            if (Array.isArray(arr)) {
              for (const r of arr) {
                const s = String(r);
                if (s && !readings.includes(s)) {
                  readings.push(s);
                }
              }
            }
          } catch {
            // 单行坏数据跳过
          }
        }
      }
    } catch {
      // 引擎未就绪（如启动前调用）静默返回空
    }
    return readings;
  },

  /**
   * 语境判音（仅当 store.polyphoneSource 指向某字典时尝试）：
   * 在该字典该字条目的义项书证/例句中做子串包含匹配，命中且
   * 义项数与候选读音数一致时返回对应读音（朴素实现，§9.4）。
   */
  resolve(char: string, context: string): string | null {
    if (Array.from(char).length !== 1 || !context) {
      return null;
    }
    const source = useDictStore.getState().polyphoneSource;
    if (source.type !== 'dict') {
      return null;
    }
    const dbName = dictDbMap.get(source.dictId);
    if (!dbName) {
      return null;
    }
    try {
      const norm = normalizeHeadword(char);
      const rows = DictDatabase.selectRows(
        dbName,
        'SELECT * FROM entries WHERE dict_id = ? AND headword_norm = ? ORDER BY id ASC LIMIT 1',
        [source.dictId, norm],
      );
      if (rows.length === 0) {
        return null;
      }
      const entry = DictDatabase.rowToEntry(rows[0]);
      if (!entry.readings || entry.readings.length === 0 || entry.contentType !== 'structured') {
        return null;
      }
      let senses: DictSense[] = [];
      try {
        senses = JSON.parse(entry.content) as DictSense[];
      } catch {
        return null;
      }
      if (!Array.isArray(senses) || senses.length !== entry.readings.length) {
        return null;
      }
      for (let i = 0; i < senses.length; i += 1) {
        const texts = [...(senses[i].examples ?? []), ...(senses[i].citations ?? [])];
        for (const text of texts) {
          if (text && text.includes(context)) {
            return entry.readings[i] ?? null;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  },
};

export default DictEngine;
