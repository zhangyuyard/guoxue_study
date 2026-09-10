/**
 * 构建 phrase-pinyin 词组读音数据（android/app/src/main/assets/data/phrase-pinyin/part-*.json）。
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
 * 【P0.5 分片化】真机实测：4.9MB 整文件 readFileAssets（native→JS 大字符串跨桥）
 * + JSON.parse + Object.entries + Map 构建 = 启动期 ~6.7s 单块 JS 饱和，
 * 点击书卡被吞（与资治通鉴 9.4MB 整读 11.2s 同一根因家族）。
 * 产物改为 part-000.json 起的有序分片（每片 ~128KB，条目边界切分、裸对象格式），
 * 运行时逐片读+parse+merge，片间 macrotask 让出——单块 <200ms，触摸可穿插。
 * 格式：每片裸 JSON 对象 {"词组":"pīn yīn", ...}（无包裹键，省字节）。
 * 用法：node scripts/build-phrase-pinyin.mjs [src] [outDir]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SRC = process.argv[2] ?? '/tmp/ppd/large_pinyin.txt';
const OUT_DIR =
  process.argv[3] ?? 'android/app/src/main/assets/data/phrase-pinyin';

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

// ---- 分片产出：条目边界 + 单片 UTF-8 字节预算 ----
const PART_BUDGET_BYTES = 128 * 1024;
const entriesJson = Object.entries(phrases).map(
  ([phrase, pinyin]) => `${JSON.stringify(phrase)}:${JSON.stringify(pinyin)}`,
);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let partIndex = 0;
let buf = '';
let bufBytes = 0;
const flushPart = () => {
  if (bufBytes === 0) return;
  const name = `part-${String(partIndex).padStart(3, '0')}.json`;
  writeFileSync(`${OUT_DIR}/${name}`, `{${buf}}\n`);
  partIndex += 1;
  buf = '';
  bufBytes = 0;
};
for (const entry of entriesJson) {
  const entryBytes = Buffer.byteLength(entry, 'utf8') + 1; // +1 逗号
  if (bufBytes > 0 && bufBytes + entryBytes > PART_BUDGET_BYTES) {
    flushPart();
  }
  buf += bufBytes > 0 ? `,${entry}` : entry;
  bufBytes += entryBytes;
}
flushPart();

const totalKb = Math.round(
  entriesJson.reduce((acc, e) => acc + Buffer.byteLength(e, 'utf8'), 0) / 1024,
);
console.log(
  `[build-phrase-pinyin] 全量 ${total} → 保留 ${kept}（剔除：纯汉字外 ${skippedNonHan}，` +
    `长度外 ${skippedShort}，无多音字 ${skippedNoPoly}）；产物 ${totalKb} KB → ${partIndex} 片（~${PART_BUDGET_BYTES / 1024}KB/片）`,
);
console.log(`[build-phrase-pinyin] 已生成 ${OUT_DIR}/part-000.json … part-${String(partIndex - 1).padStart(3, '0')}.json`);
