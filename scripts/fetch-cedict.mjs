#!/usr/bin/env node
/**
 * CC-CEDICT 数据抓取与解析（fetch-cedict.mjs）
 * 下载 MDBG CC-CEDICT（CC BY-SA 4.0）→ 解析 → 产出 scripts/cedict-sources.json，
 * 由 build-native-dict.mjs 合并进 native_dict.db。
 *
 * 数据源优先级：
 *   1. 本地 scripts/data/cedict_ts.u8（明文，可手动下载后放置，离线可重复构建）
 *   2. 下载 https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip
 *      到 scripts/data/ 并用系统 unzip 解压（macOS/Linux 自带）
 *
 * 行格式：`繁體 簡體 [pin1 yin1] /def1/def2/`
 *  - headword 取简体列；pinyin 数字声调转调号（与 App 内拼音风格一致）
 *  - senses = 以「/」分隔的释义数组（structured DictSense）
 *  - langPair = 'zh-en'，license/description 按 CC BY-SA 4.0 署名要求写明出处
 *
 * ★ 版本互指：运行本脚本并重建 db 后，NATIVE_DICT_VERSION（build-native-dict.mjs
 *   与 src/services/dict/DictDatabase.ts 两处）必须 +1。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(ROOT, 'scripts/data');
const U8_PATH = resolve(DATA_DIR, 'cedict_ts.u8');
const ZIP_PATH = resolve(DATA_DIR, 'cedict.zip');
const OUT_PATH = resolve(ROOT, 'scripts/cedict-sources.json');
const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip';

/** 语向与署名（CC BY-SA 4.0 要求明确标注来源与许可） */
const DICT_META = {
  id: 'cedict-zh-en',
  name: 'CC-CEDICT 中英词典',
  kind: 'native',
  format: 'builtin',
  version: '1.0',
  license: 'CC BY-SA 4.0 · 数据 © MDBG（CC-CEDICT）',
  description:
    '汉字词 → 英文释义（中文 ↔ 英文语向）。数据来源 CC-CEDICT（mdbg.net），' +
    '以 CC BY-SA 4.0 许可使用，本词典亦需以相同许可共享。',
  langPair: 'zh-en',
};

/** 英文反查索引词典（key = 释义提取的英文词/词组 → 对应汉字字头） */
const REVERSE_META = {
  id: 'cedict-en-zh',
  name: 'CC-CEDICT 英文反查',
  kind: 'native',
  format: 'builtin',
  version: '1.0',
  license: 'CC BY-SA 4.0 · 数据 © MDBG（CC-CEDICT）',
  description:
    '英文 → 汉字词反查索引（由 CC-CEDICT 释义自动提取）。输入英文单词/短语查询对应中文词条。',
  langPair: 'en-zh',
};

/**
 * 英文功能词表：作为反查 key 无区分度的词（全停用词词组与停用词首词不生成 key）。
 * 「variant of / also see / CL:」等指示性开头整体由 leadingEnglishPhrase 的尾词过滤兜底。
 */
const EN_STOPLIST = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'with', 'as', 'by', 'from', 'into', 'if', 'then',
  'also', 'see', 'used', 'use', 'one', 'who', 'whom', 'which', 'what', 'when',
  'variant', 'variants', 'old', 'same', 'such', 'not', 'no', 'any', 'some',
  'cf', 'eg', 'ie', 'etc', 'vs',
]);

/**
 * 提取释义的 leading 英文词组：去掉量词标注（CL:...），从头取连续英文词
 * （字母/空格/连字符/撇号），遇到逗号、冒号、竖线、数字或中文即停。
 * 返回 lowercase 词组或 null（释义以中文/数字开头等）。
 */
function leadingEnglishPhrase(def) {
  const s = def.replace(/^CL:?/i, '').trim();
  const m = s.match(/^[A-Za-z][A-Za-z' \-]*/);
  if (!m) {
    return null;
  }
  return m[0].trim().replace(/[\s'\-]+$/, '').toLowerCase();
}

/**
 * 词组整理：截掉尾部停用词（"variant of"→"variant"、"believe in"→"believe"），
 * 截完为空（全停用词）返回 null。截断后首词若仍有效则由调用方决定是否生成首词 key。
 */
function trimPhrase(phrase) {
  if (!phrase || phrase.length < 2) {
    return null;
  }
  const words = phrase.split(/\s+/);
  while (words.length > 0 && EN_STOPLIST.has(words[words.length - 1])) {
    words.pop();
  }
  if (words.length === 0) {
    return null;
  }
  return words.join(' ');
}

/**
 * 反查索引聚合：key → 字头列表。
 * CC-CEDICT 行序是拼音序，直接「先到先得」会让同 key 的英文专名词条
 * （China CITIC Bank 等）占满名额、把最直接的对应字头（中国）挤出。
 * 因此聚合时不截断，输出时按权重排序后再取前 8：
 *   ① 字头拼音（去声调）与 key 匹配 → 最优先（beijing→北京）
 *   ② 字头长度升序（中国 2 字优于 中国中央电视台 8 字）
 *   ③ 添加顺序
 */
function makeReverseIndex() {
  const map = new Map();
  return {
    /** pinyinKey：字头数字拼音去数字与空格（如 'bei3jing1'→'beijing'），供权重比对 */
    add(key, headword, pinyinKey) {
      if (!key) {
        return;
      }
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      if (!arr.some((it) => it.hw === headword)) {
        arr.push({ hw: headword, py: pinyinKey, seq: arr.length });
      }
    },
    entries() {
      return [...map.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, items]) => {
          const flat = key.replace(/\s+/g, '');
          items.sort(
            (a, b) =>
              Number(b.py === flat || b.py.startsWith(flat)) -
                Number(a.py === flat || a.py.startsWith(flat)) ||
              a.hw.length - b.hw.length ||
              a.seq - b.seq,
          );
          return {
            headword: key,
            senses: [{ def: `→ ${items.slice(0, 8).map((it) => it.hw).join('、')}` }],
          };
        });
    },
    size() {
      return map.size;
    },
  };
}

/** 数字声调 → 调号元音表（键含 'ü'） */
const TONE_MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

/**
 * CC-CEDICT 数字声调 → 调号（与主流词典风格一致）：
 * 含 a 标 a；否则含 e 标 e；否则 ou 标 o；否则标最后一个元音；
 * 鼻音尾 n/儿化 r 不参与；轻声（5）不标。
 * CC-CEDICT 以 'u:' 表示 ü，先归一为 'ü' 再处理。
 */
function numberedToMarks(syllable) {
  const m = syllable.match(/^([a-züv:]+)([1-5])$/i);
  if (!m) {
    return syllable;
  }
  const base = m[1].toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');
  const tone = Number(m[2]);
  if (tone === 5) {
    return base;
  }
  let target = null;
  if (base.includes('a')) {
    target = 'a';
  } else if (base.includes('e')) {
    target = 'e';
  } else if (base.includes('ou')) {
    target = 'o';
  } else {
    // 从后往前找最后一个可标调元音（iu 标 u、ui 标 i 恰好符合此规则）
    for (let i = base.length - 1; i >= 0; i--) {
      if (TONE_MARKS[base[i]]) {
        target = base[i];
        break;
      }
    }
  }
  if (!target) {
    return base;
  }
  const marked = TONE_MARKS[target][tone - 1];
  const idx = base.lastIndexOf(target);
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}

/** `[pin1 yin2]` → 'pīn yīn' */
function convertPinyin(bracket) {
  return bracket
    .split(/\s+/)
    .filter(Boolean)
    .map(numberedToMarks)
    .join(' ');
}

/** CC-CEDICT 行 → SourceEntry（注释行/无法解析返回 null） */
function parseLine(line) {
  if (!line || line.startsWith('#')) {
    return null;
  }
  // 繁体 简体 [pinyin] /defs/（defs 内不允许换行）
  const m = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.*)\/\s*$/);
  if (!m) {
    return null;
  }
  const [, , simplified, pinyinNum, defsRaw] = m;
  const defs = defsRaw.split('/').map((d) => d.trim()).filter(Boolean);
  if (defs.length === 0) {
    return null;
  }
  return {
    headword: simplified,
    pinyin: convertPinyin(pinyinNum),
    /** 数字拼音去声调去空格（'bei3 jing1'→'beijing'），反查索引权重比对用 */
    pinyinKey: pinyinNum.split(/\s+/).map((s) => s.replace(/[1-5]$/, '')).join('').toLowerCase(),
    senses: defs.map((def) => ({ def })),
  };
}

/** 确保本地存在 cedict_ts.u8（无则下载并解压） */
function ensureSourceFile() {
  if (existsSync(U8_PATH)) {
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[fetch-cedict] 下载数据包：${CEDICT_URL}`);
  execSync(`curl -L --fail --retry 3 -o "${ZIP_PATH}" "${CEDICT_URL}"`, { stdio: 'inherit' });
  console.log('[fetch-cedict] 解压（系统 unzip）…');
  execSync(`unzip -o -j "${ZIP_PATH}" -d "${DATA_DIR}"`, { stdio: 'inherit' });
  if (!existsSync(U8_PATH)) {
    // 解压出的文件名可能带日期后缀，取首个 .u8
    const u8 = readdirSync(DATA_DIR).find((f) => f.endsWith('.u8'));
    if (!u8) {
      throw new Error('解压后未找到 cedict_ts.u8');
    }
    execSync(`mv "${resolve(DATA_DIR, u8)}" "${U8_PATH}"`);
  }
}

function main() {
  ensureSourceFile();
  const startedAt = Date.now();
  const lines = readFileSync(U8_PATH, 'utf8').split(/\r?\n/);
  const entries = [];
  const reverse = makeReverseIndex();
  let skipped = 0;
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) {
      if (line && !line.startsWith('#')) {
        skipped += 1;
      }
      continue;
    }
    entries.push(entry);
    // 英文反查索引：每条释义取 leading 词组 + 首词（实义、非停用词）
    for (const sense of entry.senses) {
      const phrase = trimPhrase(leadingEnglishPhrase(sense.def));
      if (!phrase) {
        continue;
      }
      reverse.add(phrase, entry.headword, entry.pinyinKey);
      const first = phrase.split(' ')[0];
      if (first !== phrase && first.length >= 3 && !EN_STOPLIST.has(first)) {
        reverse.add(first, entry.headword, entry.pinyinKey);
      }
    }
  }
  if (entries.length === 0) {
    console.error('[fetch-cedict] 解析结果为空，请检查数据文件');
    process.exit(1);
  }

  const sources = {
    generatedAt: new Date().toISOString(),
    dicts: [{ ...DICT_META, entries }, { ...REVERSE_META, entries: reverse.entries() }],
  };
  writeFileSync(OUT_PATH, JSON.stringify(sources), 'utf8');
  console.log(
    `[fetch-cedict] 完成：中英 ${entries.length} 条 + 英文反查 ${reverse.size()} 条` +
      (skipped > 0 ? `（跳过无法解析行 ${skipped}）` : '') +
      `，${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
  );
  console.log(`[fetch-cedict] 输出：${OUT_PATH}`);
}

main();
