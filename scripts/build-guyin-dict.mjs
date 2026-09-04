#!/usr/bin/env node
/**
 * 古音拟音库构建脚本（build-guyin-dict.mjs）
 * 数据源：Baxter-Sagart 上古汉语拟音表（William H. Baxter & Laurent Sagart,
 *   Old Chinese: A New Reconstruction, Oxford University Press, 2014）。
 *   原始 Excel 由作者官网（sites.lsa.umich.edu/ocbaxtersagart/，原
 *   ocbaxtersagart.lsait.lsu.edu）公开发布，为学术公开数据，使用须署名。
 *   本脚本优先使用 scripts/vendor/ 内的忠实 TSV 转写版（逐行对照官方
 *   Excel，仅做空白清理，来源：github.com/yawnoc/baxter-sagart-old-chinese）。
 *
 * 产物：src/data/guyin-zi.json
 *   { _meta: {...}, chars: { [简体字]: { mc, oc, gloss? } } }
 *   运行时由 src/services/GuyinService.ts 懒加载为内存 Map 查询，不进 SQLite
 *   （约五千条目，JSON 体积可控）。
 *
 * ★ 离线优先：设置环境变量 GUYIN_LOCAL_FILE 指向本地 TSV 时直接读取，
 *   跳过联网（照抄 build-canon-dict.mjs 的 CANON_LOCAL_JSONL 模式）。
 *
 * ★ key 归一化：字头在构建期做 繁→简 opencc 转换（from:'tw' → to:'cn'，
 *   与运行时查询同口径），避免繁体显示模式下查询 miss（輮→𫐓 类教训）。
 *
 * ★ 版本互指：GUYIN_VERSION 必须与 src/services/GuyinService.ts 的
 *   GUYIN_DICT_VERSION 一致（修改数据格式/口径时同步 +1）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

/** opencc 繁→简转换器（加载失败退化为恒等映射，仅提示不阻断构建） */
let tw2cn = null;
try {
  tw2cn = requireCjs('opencc-js').Converter({ from: 'tw', to: 'cn' });
} catch {
  console.warn('[build-guyin] ⚠ opencc-js 加载失败，字头归一化退化为恒等映射');
}
function toSimplifiedKey(c) {
  if (!tw2cn || !c) return c;
  try {
    return tw2cn(c);
  } catch {
    return c;
  }
}

/** 脚本根目录（仓库内 guoxue_study_app/） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 本地 vendor 数据（离线优先，仓库内缓存） */
const VENDOR_FILE = resolve(ROOT, 'scripts/vendor/BaxterSagartOC2015-10-13.tsv');
/** 在线来源（vendor 缺失时下载；官方 Excel 的忠实 TSV 转写版） */
const SOURCE_TSV_URL =
  'https://raw.githubusercontent.com/yawnoc/baxter-sagart-old-chinese/master/BaxterSagartOC2015-10-13.tsv';
/** 产物路径 */
const OUTPUT = resolve(ROOT, 'src/data/guyin-zi.json');

/** ★ 与 src/services/GuyinService.ts 的 GUYIN_DICT_VERSION 互指（修改须同步 +1） */
const GUYIN_VERSION = 1;

/** _meta 中写死的来源与许可说明（Baxter-Sagart 数据为学术公开数据，须署名） */
const META_SOURCE =
  'Baxter, William H. & Sagart, Laurent. 2014. Old Chinese: A New Reconstruction. Oxford University Press（Baxter-Sagart 上古/中古汉语拟音，作者官网公开数据）';
const META_LICENSE =
  '学术公开数据（作者官网免费发布，使用须署名）；本仓库经 scripts/vendor/BaxterSagartOC2015-10-13.tsv（github.com/yawnoc/baxter-sagart-old-chinese 忠实 TSV 转写）转换，仅作学习参考';
const META_SOURCE_URL = SOURCE_TSV_URL;

/** CJK 统一表意文字（基本区 + 扩展 A 区）判定 */
function isCJKChar(c) {
  const n = c.codePointAt(0);
  return n >= 0x3400 && n <= 0x9fff;
}

/**
 * 拟音字符串清洗：去首尾空白 + 连续空白折叠为单空格。
 * TSV 中 OC 列常带尾随空格（如 "*qˤə "），MC 列偶有多余空格。
 */
function cleanPhonetic(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 下载文本（统一走 curl，与 build-canon-dict.mjs 相同的沙箱网络通道） */
function fetchText(url, timeoutSec = 30) {
  return execSync(`curl -s -m ${timeoutSec} -L "${url}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 获取 TSV 原文：vendor 离线优先，缺失时联网下载到 vendor（缓存供下次离线使用） */
function loadTsvText() {
  const local = process.env.GUYIN_LOCAL_FILE;
  if (local && existsSync(local)) {
    console.log(`[build-guyin] 离线模式（GUYIN_LOCAL_FILE）：${local}`);
    return { text: readFileSync(local, 'utf8'), from: local };
  }
  if (existsSync(VENDOR_FILE)) {
    console.log(`[build-guyin] 使用仓库内 vendor 缓存：${VENDOR_FILE}`);
    return { text: readFileSync(VENDOR_FILE, 'utf8'), from: VENDOR_FILE };
  }
  console.log(`[build-guyin] vendor 缺失，联网下载：${SOURCE_TSV_URL}`);
  const text = fetchText(SOURCE_TSV_URL);
  if (!text || !text.includes('\t')) {
    throw new Error('下载内容异常（非 TSV），已中止，不写入任何产物');
  }
  mkdirSync(dirname(VENDOR_FILE), { recursive: true });
  writeFileSync(VENDOR_FILE, text, 'utf8');
  console.log(`[build-guyin] 已缓存到 vendor：${VENDOR_FILE}`);
  return { text, from: SOURCE_TSV_URL };
}

/**
 * 解析 TSV 正文行。
 * 列：zi, py, MC, (语音细节注), OC, gloss, GSR, HYDZD, rad, str, Unicode
 * 明显异常行（空 MC/空 OC/非单汉字 key）跳过并计数，绝不写入残缺数据。
 */
function parseTsv(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let skippedEmptyMc = 0;
  let skippedEmptyOc = 0;
  let skippedBadKey = 0;
  let parsed = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split('\t');
    const zi = (cols[0] ?? '').trim();
    const mc = cleanPhonetic(cols[2]);
    const oc = cleanPhonetic(cols[4]);
    const gloss = cleanPhonetic(cols[5]);

    // key 校验：必须为单个 CJK 汉字（多字 key / 空行 / 表头残留一律丢弃）
    if (Array.from(zi).length !== 1 || !isCJKChar(zi)) {
      skippedBadKey += 1;
      continue;
    }
    if (!mc) {
      skippedEmptyMc += 1;
      continue;
    }
    if (!oc) {
      skippedEmptyOc += 1;
      continue;
    }

    // key 归一化：繁→简（与运行时 GuyinService 查询键同口径）
    const key = toSimplifiedKey(zi);
    if (!key || Array.from(key).length !== 1 || !isCJKChar(key)) {
      skippedBadKey += 1;
      continue;
    }

    rows.push({ key, py: cleanPhonetic(cols[1]), mc, oc, gloss });
    parsed += 1;
  }

  console.log(
    `[build-guyin] 解析统计：有效 ${parsed} 行；跳过 空 MC=${skippedEmptyMc}、` +
      `空 OC=${skippedEmptyOc}、非法字头=${skippedBadKey}`,
  );
  return { rows, parsed, skippedEmptyMc, skippedEmptyOc, skippedBadKey };
}

/** 同 key 去重：同字多读音时优先保留「主读音」行 —— 以 pinyin-dict.json
 *  （app 内置拼音库，char → 默认带调拼音）命中的 py 为准；无匹配或字不在
 *  拼音库时退化为保留首条（TSV 按拼音字母序，首条无特殊语义）。
 *  这保证如「说」存 shuō（sywet）而非字母序靠前的 shuì（sywejH）。 */
function dedupe(rows) {
  let primaryDict = {};
  try {
    primaryDict = requireCjs(resolve(ROOT, 'src/data/pinyin-dict.json')).dict ?? {};
  } catch {
    console.warn('[build-guyin] ⚠ pinyin-dict.json 读取失败，去重退化为保留首条');
  }
  const map = new Map();
  const candidates = new Map();
  let duplicated = 0;
  let primaryPicked = 0;
  for (const r of rows) {
    if (!candidates.has(r.key)) {
      candidates.set(r.key, [r]);
    } else {
      candidates.get(r.key).push(r);
    }
  }
  for (const [key, group] of candidates) {
    duplicated += group.length - 1;
    const primaryPy = primaryDict[key];
    const picked =
      (primaryPy && group.find((r) => r.py === primaryPy)) || group[0];
    if (primaryPy && picked.py === primaryPy && group.length > 1) {
      primaryPicked += 1;
    }
    map.set(key, picked);
  }
  console.log(
    `[build-guyin] 去重：重复字头 ${duplicated} 个，其中按主读音(pinyin-dict)选取 ${primaryPicked} 个，其余保留首条`,
  );
  return { chars: map, duplicated };
}

function main() {
  const startedAt = Date.now();
  const { text, from } = loadTsvText();
  const { rows, skippedEmptyMc, skippedEmptyOc, skippedBadKey } = parseTsv(text);
  const { chars, duplicated } = dedupe(rows);

  const charsJson = {};
  for (const [key, r] of chars) {
    charsJson[key] = r.gloss
      ? { mc: r.mc, oc: r.oc, gloss: r.gloss }
      : { mc: r.mc, oc: r.oc };
  }

  const out = {
    _meta: {
      source: META_SOURCE,
      sourceUrl: META_SOURCE_URL,
      license: META_LICENSE,
      attribution: 'Baxter-Sagart (2014)',
      version: GUYIN_VERSION,
      retrievedAt: new Date().toISOString().slice(0, 10),
      dataFrom: from,
      entries: Object.keys(charsJson).length,
      skipped: { emptyMc: skippedEmptyMc, emptyOc: skippedEmptyOc, badKey: skippedBadKey, duplicated },
    },
    chars: charsJson,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  console.log(
    `[build-guyin] 完成：${out._meta.entries} 条 → ${OUTPUT}（${((Date.now() - startedAt) / 1000).toFixed(2)}s）`,
  );
  console.log(`[build-guyin] 版本：GUYIN_VERSION=${GUYIN_VERSION}（与 src/services/GuyinService.ts 互指）`);
}

main();
