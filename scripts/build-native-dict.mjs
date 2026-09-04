#!/usr/bin/env node
/**
 * 原生字典构建脚本（build-native-dict.mjs）
 * 读取 scripts/native-dict-sources.json → better-sqlite3 建 dicts + entries →
 * 写出 assets/dictionaries/native_dict.db 与 android/app/src/main/assets/dictionaries/native_dict.db
 *
 * 幂等性：同输入产出的 db 字节级一致（时间戳取 sources.generatedAt，全量重建）。
 *
 * ★ 归一化互指：normalizeHeadword 与 src/services/dict/DictEngine.ts 的导出实现
 *   必须保持一致（§8.4：归一化唯一入口，禁止双实现漂移）。脚本侧因无法在 node
 *   直接复用 DictEngine（其依赖 RN store 链），此处为等价复制；两边修改须同步。
 *
 * ★ 版本互指：NATIVE_DICT_VERSION 必须与 src/services/dict/DictDatabase.ts 的
 *   NATIVE_DICT_VERSION 一致（PRAGMA user_version 比对升级依据）。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as OpenCC_NS from 'opencc-js';
import SQLite3 from 'better-sqlite3';

// opencc-js / better-sqlite3 CJS/ESM 互操作兜底
const OpenCC = OpenCC_NS.default ?? OpenCC_NS;
const Database = SQLite3.default ?? SQLite3;

/** 脚本根目录（仓库内 guoxue_study_app/） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 输入数据源 */
const SOURCES_PATH = resolve(ROOT, 'scripts/native-dict-sources.json');
/** 输出路径（RN 通用 assets + Android 打包 assets） */
const OUTPUTS = [
  resolve(ROOT, 'assets/dictionaries/native_dict.db'),
  resolve(ROOT, 'android/app/src/main/assets/dictionaries/native_dict.db'),
];
/** 批量写入批大小（与 DictDatabase.ENTRY_BATCH_SIZE 一致） */
const ENTRY_BATCH_SIZE = 1000;

/** ★ 与 src/services/dict/DictDatabase.ts 的 NATIVE_DICT_VERSION 互指（修改须同步 +1） */
const NATIVE_DICT_VERSION = 3;

/** 繁→简转换器（与 DictEngine 同参数） */
const t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });

/** 零宽字符（U+200B / U+FEFF）与首尾空白（★ 等价复制自 DictEngine.normalizeHeadword） */
const ZERO_WIDTH_RE = /^[\s\u200b\ufeff]+|[\s\u200b\ufeff]+$/g;

/** ★ 等价复制自 DictEngine.normalizeHeadword（§3.3：trim → 繁转简 → 小写 → 去零宽） */
function normalizeHeadword(hw) {
  return t2sConverter(hw.trim())
    .toLowerCase()
    .replace(ZERO_WIDTH_RE, '');
}

/** DDL（★ 与 DictDatabase.ts 的 CREATE_DICTS / CREATE_ENTRIES 一致） */
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

/**
 * 源数据条目（ParsedEntry 超集，§2.1）
 *
 * @typedef {Object} SourceEntry
 * @property {string} headword
 * @property {string} [pinyin]
 * @property {string[]} [readings]
 * @property {Array<{def: string, pos?: string, label?: string, examples?: string[], citations?: string[]}>} senses
 *
 * @typedef {Object} SourceDict
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {string} format
 * @property {string} [version]
 * @property {string} [license]
 * @property {string} [description]
 * @property {string} [langPair] 语向（如 'zh-en'，CC-CEDICT 用）
 * @property {SourceEntry[]} entries
 *
 * @typedef {Object} Sources
 * @property {string} generatedAt
 * @property {SourceDict[]} dicts
 */

/** 主流程 */
function main() {
  const startedAt = Date.now();
  if (!statSync(SOURCES_PATH, { throwIfNoEntry: false })) {
    console.error(`[build-native-dict] 数据源不存在：${SOURCES_PATH}`);
    process.exit(1);
  }
  const sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  // 合并 CC-CEDICT 数据源（fetch-cedict.mjs 生成；不存在时仅构建内置样例）
  const CEDICT_PATH = resolve(ROOT, 'scripts/cedict-sources.json');
  if (statSync(CEDICT_PATH, { throwIfNoEntry: false })) {
    const cedict = JSON.parse(readFileSync(CEDICT_PATH, 'utf8'));
    sources.dicts = [...(sources.dicts ?? []), ...(cedict.dicts ?? [])];
    console.log('[build-native-dict] 已合并 CC-CEDICT 数据源');
  }
  if (!Array.isArray(sources.dicts) || sources.dicts.length === 0) {
    console.error('[build-native-dict] 数据源 dicts 为空');
    process.exit(1);
  }
  const timestamp = sources.generatedAt ?? new Date(0).toISOString();

  // 构建到首个输出路径，再字节级复制到其余路径（保证产物一致）
  const [primary, ...rest] = OUTPUTS;
  mkdirSync(dirname(primary), { recursive: true });
  // 全量重建：删除旧文件（幂等）
  rmSync(primary, { force: true });
  const db = new Database(primary);

  try {
    db.pragma('journal_mode = DELETE');
    db.exec(CREATE_DICTS);
    db.exec(CREATE_ENTRIES);

    const insertDict = db.prepare(
      `INSERT OR REPLACE INTO dicts
       (id, name, kind, format, entry_count, version, license, description, lang_pair, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEntry = db.prepare(
      `INSERT INTO entries
       (dict_id, headword, headword_norm, pinyin, readings_json, content, content_type, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let totalEntries = 0;
    for (const dict of sources.dicts) {
      if (!Array.isArray(dict.entries) || dict.entries.length === 0) {
        console.error(`[build-native-dict] 字典 ${dict.id} 无条目，跳过`);
        continue;
      }
      insertDict.run(
        dict.id,
        dict.name,
        dict.kind,
        dict.format,
        dict.entries.length,
        dict.version ?? null,
        dict.license ?? null,
        dict.description ?? null,
        dict.langPair ?? null,
        timestamp,
        timestamp,
      );

      const insertBatch = db.transaction((entries) => {
        for (const entry of entries) {
          const headwordNorm = normalizeHeadword(entry.headword);
          if (!headwordNorm) {
            throw new Error(`字典 ${dict.id} 存在空字头：${JSON.stringify(entry.headword)}`);
          }
          // 源数据 senses → structured DictSense[] JSON（与 DictContentType='structured' 对应）
          insertEntry.run(
            dict.id,
            entry.headword,
            headwordNorm,
            entry.pinyin ?? null,
            entry.readings && entry.readings.length > 0
              ? JSON.stringify(entry.readings)
              : null,
            JSON.stringify(entry.senses),
            'structured',
            null,
          );
        }
      });

      for (let start = 0; start < dict.entries.length; start += ENTRY_BATCH_SIZE) {
        insertBatch(dict.entries.slice(start, start + ENTRY_BATCH_SIZE));
      }
      totalEntries += dict.entries.length;
      console.log(`[build-native-dict] ${dict.id}（${dict.name}）：${dict.entries.length} 条`);
    }

    // 版本号（首启 user_version 比对依据）
    db.pragma(`user_version = ${NATIVE_DICT_VERSION}`);
    db.close();

    // 复制到其余输出路径（Android assets 等）
    for (const dest of rest) {
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      copyFileSync(primary, dest);
    }

    // 幂等性校验输出：主产物 sha256，便于 CI 比对
    const hash = createHash('sha256').update(readFileSync(primary)).digest('hex');
    console.log(
      `[build-native-dict] 完成：${totalEntries} 条 / ${sources.dicts.length} 字典，` +
        `${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
    );
    console.log(`[build-native-dict] 主产物：${primary}`);
    console.log(`[build-native-dict] sha256：${hash}`);
    for (const dest of rest) {
      console.log(`[build-native-dict] 副本：${dest}`);
    }
  } catch (e) {
    db.close();
    console.error(`[build-native-dict] 构建失败：${e?.message ?? String(e)}`);
    process.exit(1);
  }
}

main();
