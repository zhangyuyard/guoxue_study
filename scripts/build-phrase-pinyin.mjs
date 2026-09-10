/**
 * 构建 phrase-pinyin 词组读音数据（android/app/src/main/assets/data/phrase-pinyin.json）。
 *
 * 数据来源：mozillazg/phrase-pinyin-data（MIT）large_pinyin.txt ——
 * 汉典词典 + 汉典成语词典 + CC-CEDICT + 手工纠正的合并词库（v0.19.0，41 万词组）。
 *
 * 过滤策略（控制包体）：
 * - 仅保留 2~8 个汉字的纯汉字词组；
 * - 仅保留含至少一个多音字（pinyin-dict.json 的 polyphone 集，684 字）的词组——
 *   单音字词组不参与读音仲裁，无需收录。
 *
 * 【P0】产物下沉为 Android assets（不再静态 import 进 JS bundle），
 * 运行时 PinyinService.ensurePhrasePinyinData() 经 readFileAssets 异步载入。
 *
 * 输出格式：{ meta: {source, version, count}, phrases: { "词组": "pīn yīn", ... } }
 * 用法：node scripts/build-phrase-pinyin.mjs [src] [out]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.argv[2] ?? '/tmp/ppd/large_pinyin.txt';
const OUT =
  process.argv[3] ?? 'android/app/src/main/assets/data/phrase-pinyin.json';

const dict = JSON.parse(readFileSync('src/data/pinyin-dict.json', 'utf8'));
const POLYPHONE = dict.polyphone;
const isPolyphone = (ch) => Boolean(POLYPHONE[ch] && POLYPHONE[ch].length > 1);

const CJK_RE = /^[\u3400-\u4dbf\u4e00-\u9fff\ufa29\ufa30-\ufa6a\ufa70-\ufad9]+$/;

/**
 * 历史专名黑名单：这些 2 字政权名词组的读音仅在专名场景正确，
 * 在诗文中作为跨词边界子串的概率远高于专名场景
 * （如「堂前燕」被最大匹配吃进「前燕」→ 燕误读 yān，金标实测踩雷）。
 */
const BLACKLIST = new Set(['前燕', '后燕', '西燕', '南燕', '北燕', '大燕', '前赵', '后赵', '前秦', '后秦', '西秦', '前凉', '后凉', '南凉', '北凉', '西凉', '前蜀', '后蜀', '南汉', '北汉', '南唐', '吴越', '闽越']);

const phrases = {};
let total = 0;
let kept = 0;
let skippedNonHan = 0;
let skippedShort = 0;
let skippedNoPoly = 0;

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);
for (const line of lines) {
  if (!line || line.startsWith('#')) continue;
  total += 1;
  const sep = line.indexOf(':');
  if (sep <= 0) continue;
  const phrase = line.slice(0, sep).trim();
  const pinyin = line.slice(sep + 1).trim();
  if (!phrase || !pinyin) continue;
  const chars = Array.from(phrase);
  if (chars.length < 2 || chars.length > 8) {
    skippedShort += 1;
    continue;
  }
  if (!CJK_RE.test(phrase)) {
    skippedNonHan += 1;
    continue;
  }
  if (!chars.some(isPolyphone)) {
    skippedNoPoly += 1;
    continue;
  }
  if (BLACKLIST.has(phrase)) {
    skippedNoPoly += 1;
    continue;
  }
  phrases[phrase] = pinyin;
  kept += 1;
}

const payload = {
  meta: {
    source: 'mozillazg/phrase-pinyin-data large_pinyin.txt v0.19.0（MIT；汉典词典+汉典成语+CC-CEDICT+手工纠正）',
    generated: 'scripts/build-phrase-pinyin.mjs',
    count: kept,
    filter: '2~8 纯汉字词组，且含至少一个多音字（pinyin-dict polyphone 684 字）',
  },
  phrases,
};

writeFileSync(OUT, JSON.stringify(payload, null, 0) + '\n');
const sizeKb = Math.round(JSON.stringify(payload).length / 1024);
console.log(
  `[build-phrase-pinyin] 全量 ${total} → 保留 ${kept}（剔除：纯汉字外 ${skippedNonHan}，` +
    `长度外 ${skippedShort}，无多音字 ${skippedNoPoly}）；产物 ${sizeKb} KB`,
);
console.log(`[build-phrase-pinyin] 已生成 ${OUT}`);
