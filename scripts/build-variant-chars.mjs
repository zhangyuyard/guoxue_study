#!/usr/bin/env node
/**
 * 异体字关联表构建脚本（build-variant-chars.mjs）
 *
 * 数据源：Unicode 官方 Unihan 数据库（公有领域）Unihan_Variants.txt，
 *   合并以下三个关系字段（注于每组 note，便于溯源）：
 *     1. kZVariant                 —— 互为异体字（双向，最高优先）
 *     2. kSpecializedSemanticVariant —— 语境限定的异体字
 *     3. kTraditionalVariant / kSimplifiedVariant —— 繁体异形（仅当前两类不足
 *        TARGET_GROUPS 时启用；纯繁简对应与 opencc 转换部分重叠，价值较低）
 *
 * 筛选原则（宁缺毋滥）：
 *   - 仅保留 BMP 内 CJK 表意文字（U+3400–U+9FFF），排除兼容区/扩展区生僻形；
 *   - 与 10 部书正文（src/data/texts/*.json）实际出现的字取交集：每组至少一侧
 *     出现在正文中；标准字优先取正文高频侧，两侧均不在正文则丢弃；
 *   - 与人工种子（scripts/yiti-seed.json，47 组）冲突的字符一律跳过；
 *   - 全表内每个异体字只能归属一个标准字（与消费端 yitiReverse 首条命中语义一致）。
 *
 * 输出：src/data/yiti-zi.json（groups = 种子 47 组在前 + Unihan 生成组在后），
 *       格式与旧版完全一致（{ standard, variants, note }），消费端
 *       PinyinService / DictionaryService / DictEngine 无需改动。
 *
 * 幂等：同输入产出一致；本地已有 Unihan_Variants.txt 时可用
 *       YITI_LOCAL_UNIHAN=/path/to/Unihan_Variants.txt 跳过联网。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src/data/yiti-zi.json');
const SEED = resolve(ROOT, 'scripts/yiti-seed.json');
const TEXTS_DIR = resolve(ROOT, 'android/app/src/main/assets/books');

/** 目标组数（种子 47 组 + Unihan 生成组，合计 ≥ 150；留余量取 180） */
const TARGET_GROUPS = 180;
/** Unihan 官方地址（Unihan_Variants.txt 在 Unihan.zip 内） */
const UNIHAN_ZIP_URL = 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip';

/** note 文案（注明来源字段，便于溯源与校对） */
const FIELD_NOTES = {
  kZVariant: 'Unihan kZVariant 互为异体字',
  kSpecializedSemanticVariant: 'Unihan kSpecializedSemanticVariant 语境异体字',
  kTraditionalVariant: 'Unihan kTraditionalVariant 繁体异形（建议校对）',
  kSimplifiedVariant: 'Unihan kSimplifiedVariant 对应异形（建议校对）',
};

/** BMP CJK 统一表意文字（含扩展 A 区）判定 */
function isCJKChar(c) {
  const n = c.codePointAt(0);
  return n >= 0x3400 && n <= 0x9fff;
}

// ----------------------------- 数据获取 -----------------------------

/** 获取 Unihan_Variants.txt 文本：本地缓存优先，否则联网下载 Unihan.zip */
function obtainUnihanText() {
  const local = process.env.YITI_LOCAL_UNIHAN;
  if (local && existsSync(local)) {
    console.log(`[build-yiti] 使用本地 Unihan：${local}`);
    return readFileSync(local, 'utf8');
  }
  console.log('[build-yiti] 下载 Unihan.zip（Unicode 官方，公有领域）…');
  const tmp = mkdtempSync(resolve(tmpdir(), 'unihan-'));
  try {
    const zipPath = resolve(tmp, 'Unihan.zip');
    execSync(`curl -s -m 120 -L -o "${zipPath}" "${UNIHAN_ZIP_URL}"`, { stdio: 'ignore' });
    const buf = readFileSync(zipPath);
    if (buf.length < 65536) {
      throw new Error('Unihan.zip 下载异常（文件过小，可能是错误页）');
    }
    execSync(`unzip -o -q "${zipPath}" Unihan_Variants.txt -d "${tmp}"`, { stdio: 'ignore' });
    return readFileSync(resolve(tmp, 'Unihan_Variants.txt'), 'utf8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ----------------------------- 解析与筛选 -----------------------------

/**
 * 解析 Unihan_Variants.txt，提取指定字段的无序字对（去重、BMP 过滤）。
 * @returns Map<string, Set<string>> key = 双侧按码点排序的 pairKey，value = { a, b, fields:Set }
 */
function parsePairs(text, fields) {
  const pairs = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 3 || !fields.includes(parts[1])) continue;
    let src;
    try {
      src = String.fromCodePoint(parseInt(parts[0].slice(2), 16));
    } catch {
      continue;
    }
    for (const tgtHex of parts[2].split(/\s+/)) {
      let tgt;
      try {
        tgt = String.fromCodePoint(parseInt(tgtHex.slice(2), 16));
      } catch {
        continue;
      }
      if (!isCJKChar(src) || !isCJKChar(tgt) || src === tgt) continue;
      const key = [src, tgt].sort((x, y) => x.codePointAt(0) - y.codePointAt(0)).join('');
      if (!pairs.has(key)) {
        pairs.set(key, { a: src, b: tgt, fields: new Set() });
      }
      pairs.get(key).fields.add(parts[1]);
    }
  }
  return pairs;
}

/**
 * 语料清单：与 src/data/__tests__/yitiData.test.ts 的 collectTextChars 完全一致
 * （10 部书 + 章节标题）。全本化后其余大部头（史记/左传/周易/墨子等）不参与
 * 语料交集，保证「构建期筛选项不回退」不变量在测试口径下严格成立。
 */
const CORPUS_FILES = [
  'lunyu.json',
  'daodejing.json',
  'daxue.json',
  'zhongyong.json',
  'tangshi.json',
  'mengzi.json',
  'zhuangzi.json',
  'shijing.json',
  'xunzi.json',
  'chuci.json',
];

/** 扫描语料正文（assets/books/<id>.txt 标记文本，剔除章节标记行），返回 { set,freq } */
function scanBookChars() {
  const set = new Set();
  const freq = new Map();
  for (const f of readdirSync(TEXTS_DIR)) {
    if (!f.endsWith('.txt')) continue;
    let raw;
    try {
      raw = readFileSync(resolve(TEXTS_DIR, f), 'utf8').replace(/^@@CH@@.*$/gm, '');
    } catch {
      continue;
    }
    for (const c of raw) {
      if (isCJKChar(c)) {
        set.add(c);
        freq.set(c, (freq.get(c) ?? 0) + 1);
      }
    }
  }
  return { set, freq };
}

// ----------------------------- 主流程 -----------------------------

function main() {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'));
  const seedGroups = seed.groups;

  // 种子占用的字符（标准/异体两侧都算），生成部分与之冲突则跳过
  const occupied = new Set();
  for (const g of seedGroups) {
    occupied.add(g.standard);
    for (const v of g.variants) occupied.add(v);
  }

  const { set: textChars, freq } = scanBookChars();

  const unihanText = obtainUnihanText();

  // 分批：优先 ZVariant / SpecializedSemanticVariant，不足再补 Traditional/Simplified
  const primary = parsePairs(unihanText, ['kZVariant', 'kSpecializedSemanticVariant']);
  const secondary = parsePairs(unihanText, ['kTraditionalVariant', 'kSimplifiedVariant']);

  // 生成组的去重簿：异体字 → 标准字（全表唯一），标准字 → true
  const variantOwner = new Map();
  const usedStandards = new Set();
  const generated = [];
  const countByField = new Map();

  /** 尝试写入一对字（按字段优先级逐对处理） */
  function addPair(pair) {
    const { a, b, fields } = pair;
    if (occupied.has(a) || occupied.has(b)) return;      // 与种子冲突
    if (variantOwner.has(a) || variantOwner.has(b)) return; // 已归属其他组
    if (usedStandards.has(a) || usedStandards.has(b)) return;

    // 选标准字：正文高频侧；仅一侧在正文则取该侧；两侧均不在正文则丢弃
    const fa = freq.get(a) ?? 0;
    const fb = freq.get(b) ?? 0;
    const inA = textChars.has(a);
    const inB = textChars.has(b);
    if (!inA && !inB) return;
    let standard;
    let variant;
    if (inA && (!inB || fa >= fb)) {
      standard = a;
      variant = b;
    } else {
      standard = b;
      variant = a;
    }

    const primaryField = ['kZVariant', 'kSpecializedSemanticVariant', 'kTraditionalVariant', 'kSimplifiedVariant']
      .find((f) => fields.has(f));
    const note = FIELD_NOTES[primaryField];
    generated.push({ standard, variants: [variant], note });
    variantOwner.set(variant, standard);
    usedStandards.add(standard);
    countByField.set(primaryField, (countByField.get(primaryField) ?? 0) + 1);
  }

  // 主批次（ZVariant + SpecializedSemanticVariant）
  for (const pair of primary.values()) {
    if (seedGroups.length + generated.length >= TARGET_GROUPS) break;
    addPair(pair);
  }
  // 兜底批次（Traditional/Simplified，仅当不足目标时）
  if (seedGroups.length + generated.length < TARGET_GROUPS) {
    for (const pair of secondary.values()) {
      if (seedGroups.length + generated.length >= TARGET_GROUPS) break;
      addPair(pair);
    }
  }

  const groups = [...seedGroups, ...generated];
  const output = {
    description:
      '异体字关联表：标准字与其异体字（旧字形/变体/繁体异形）的对应关系，用于注音和显示。' +
      '前 47 组为人工校订种子；其余由 scripts/build-variant-chars.mjs 依据 Unicode 官方 ' +
      'Unihan 数据库（kZVariant / kSpecializedSemanticVariant / kTraditionalVariant，' +
      '公有领域）生成并经 10 部书正文交集筛选，note 注明来源字段，建议专业校对。',
    groups,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const fieldStat = [...countByField.entries()].map(([f, n]) => `${f}=${n}`).join(', ');
  console.log(
    `[build-yiti] 完成：种子 ${seedGroups.length} 组 + Unihan 生成 ${generated.length} 组 = ${groups.length} 组（目标 ≥ ${TARGET_GROUPS}）。来源分布：${fieldStat}`,
  );
  console.log(`[build-yiti] 输出：${OUTPUT}`);
}

main();
