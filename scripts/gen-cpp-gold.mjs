/**
 * 从 CPP（Chinese Polyphones with Pinyin, kakaobrain/g2pM, Apache-2.0）评测集
 * 生成多音字金标测试文件 polyphoneGoldCpp.test.ts。
 *
 * - 每个多音字取 1 句（CPP test 集 623 字，约 620 句），保证字级均衡覆盖；
 * - 句中 `▁X▁` 标注目标字；仅保留「目标字首次出现位置 == 标注位置」的句子
 *   （金标查询取该字首次出现，两者必须一致）；
 * - 读音为数字声调（le5/ran2），转换为带调符号（与项目内部格式一致，5=轻声无符号）；
 * - 生成统计报告型断言：准确率 ≥ BASELINE（回归防倒退），失败明细 console 输出。
 *
 * 用法：node scripts/gen-cpp-gold.mjs [sent] [lb] [out]
 * 默认：/tmp/g2p_data/test.sent /tmp/g2p_data/test.lb src/services/__tests__/polyphoneGoldCpp.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SENT_PATH = process.argv[2] ?? '/tmp/g2p_data/test.sent';
const LB_PATH = process.argv[3] ?? '/tmp/g2p_data/test.lb';
const OUT_PATH = process.argv[4] ?? 'src/services/__tests__/polyphoneGoldCpp.test.ts';

/** 数字声调 → 声调符号（规则同 pypinyin：a > o > e > ü > iu 的 u > ui 的 i > 末元音） */
const MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  'ü': ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'], // CPP 数据中 ü 的替身（若有）
  n: ['n', 'ń', 'ň', 'ǹ'],
  m: ['m', 'ḿ', 'm̀', 'm̀'],
};

function numToMark(syll) {
  const m = syll.match(/^([a-züv]+)([1-5])$/);
  if (!m) return syll; // 非纯音节（数字串/英文），原样返回（金标过滤后不会出现）
  const [, base, toneStr] = m;
  const tone = Number(toneStr);
  if (tone === 5) return base; // 轻声：无符号
  const lower = base.toLowerCase();
  const mark = (ch, t) => (MARKS[ch] ? MARKS[ch][t - 1] : ch);
  // 主元音选择：a > o > e > ü/v > (iu→u / ui→i) > 最后一个元音
  let idx = -1;
  for (const vowel of ['a', 'o', 'e', 'ü', 'v']) {
    idx = lower.indexOf(vowel);
    if (idx >= 0) break;
  }
  if (idx < 0) {
    if (lower.endsWith('iu')) {
      idx = lower.length - 1; // liu → liù：标 u
    } else if (lower.endsWith('ui')) {
      idx = lower.length - 1; // hui → huì：标 i（iou/uei 缩写规则）
    } else {
      // 最后一个元音（从右向左找）
      for (let i = lower.length - 1; i >= 0; i -= 1) {
        if ('aeoiuvü'.includes(lower[i])) {
          idx = i;
          break;
        }
      }
    }
  }
  if (idx < 0) return base;
  const ch = lower[idx];
  const marked = mark(ch, tone);
  const chars = Array.from(lower);
  const out = [...chars.slice(0, idx), marked, ...chars.slice(idx + 1)].join('');
  // 项目内部格式使用 ü
  return out.replace(/v/g, 'ü');
}

const sents = readFileSync(SENT_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
const labels = readFileSync(LB_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
if (sents.length !== labels.length) {
  throw new Error(`sent(${sents.length}) 与 lb(${labels.length}) 行数不一致`);
}

/** char → GoldCase（每字取 1 句） */
const byChar = new Map();
let skippedMulti = 0;
let skippedMark = 0;
let skippedTone = 0;

for (let i = 0; i < sents.length; i += 1) {
  const sent = sents[i];
  const mark = sent.indexOf('▁');
  const markEnd = sent.indexOf('▁', mark + 1);
  if (mark < 0 || markEnd < 0) {
    skippedMark += 1;
    continue;
  }
  const char = sent[mark + 1];
  if (!char) {
    skippedMark += 1;
    continue;
  }
  // 标注的是单字（▁ 与 ▁ 之间 1 个码点）
  if (markEnd - mark !== 2) {
    skippedMark += 1;
    continue;
  }
  // 目标字必须首次出现于标注位置（金标查询取首次出现）
  const first = sent.indexOf(char);
  if (first !== mark + 1) {
    skippedMulti += 1;
    continue;
  }
  const expected = numToMark(labels[i].trim());
  // 滤掉非纯音节标签（数字/英文Token，如 CPP 中混杂的数字串）
  if (!/^[a-züāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜ]+$/.test(expected)) {
    skippedTone += 1;
    continue;
  }
  const text = sent.replace(/▁/g, '');
  if (!byChar.has(char)) {
    byChar.set(char, { text, char, expected });
  }
}

const GOLD = [...byChar.values()];
console.log(
  `[gen-cpp-gold] 保留 ${GOLD.length} 字 / ${GOLD.length} 句（跳过：标注异常 ${skippedMark}，` +
    `目标字非首现 ${skippedMulti}，非纯音节 ${skippedTone}）`,
);

const cases = GOLD.map(
  (c) => `  { text: ${JSON.stringify(c.text)}, char: ${JSON.stringify(c.char)}, expected: ${JSON.stringify(c.expected)} },`,
).join('\n');

/**
 * BASELINE：判音准确率回归下限（相对当前实现实测值写死）。
 * 首轮生成后按实测基线更新；词组读音层引入后应只升不降。
 */
const BASELINE = 0.85; // 2026-09-07 首轮实测 540/619 = 87.2%（词组层接入前），防回退下限留 2pt 余量

const out = `/**
 * CPP 金标评测集（polyphoneGoldCpp）——现代汉语多音字消歧回归基线。
 *
 * 数据来源：CPP (Chinese Polyphones with Pinyin), kakaobrain/g2pM, Apache-2.0，
 * Interspeech 2020 论文《g2pM》配套评测集；test 集 ${'`'}10,254${'`'} 句 / 623 多音字，
 * 经 scripts/gen-cpp-gold.mjs 按字均衡抽样（每字 1 句）+ 数字声调转符号声调。
 *
 * 与 polyphoneGold（古文名句，要求 100%）不同：本集为统计报告型——
 * 断言准确率 ≥ BASELINE（防回退），失败明细输出 console 供量化改进。
 * 注意：CPP 语料为现代汉语（维基百科），古文异读（如「说」yuè）不在其覆盖内，
 * 古文准确性由 polyphoneGold + canon 体系保证，两套金标互补。
 */
import { annotate } from '@/services/PinyinService';
import type { PinyinAnnotation } from '@/types';

/** 单条金标：text 含目标字 char 的句子，expected 为该字在此句的正确读音（带声调符号） */
interface GoldCase {
  text: string;
  char: string;
  expected: string;
}

const GOLD: GoldCase[] = [
${cases}
];

const BASELINE_ACCURACY = ${BASELINE};

/** 取某字的注音项（取该字在句中的首次出现） */
function pinyinOf(anns: PinyinAnnotation[], char: string): string {
  const hit = anns.find((a) => a.char === char);
  if (!hit) {
    throw new Error(\`未找到「\${char}」的注音项\`);
  }
  return hit.pinyin;
}

describe('CPP 多音字金标（现代汉语回归基线）', () => {
  const failures: string[] = [];
  let passed = 0;

  for (const c of GOLD) {
    const res = annotate(c.text, 'full');
    if (!res.success || !res.data) {
      failures.push(\`[注音失败] \${c.text} | 字=\${c.char} 期望=\${c.expected} 错误=\${res.error}\`);
      continue;
    }
    try {
      const actual = pinyinOf(res.data, c.char);
      if (actual === c.expected) {
        passed++;
      } else {
        failures.push(\`[判错] \${c.text} | 字=\${c.char} 期望=\${c.expected} 实际=\${actual}\`);
      }
    } catch (e) {
      failures.push(\`[异常] \${c.text} | 字=\${c.char} \${(e as Error).message}\`);
    }
  }

  const accuracy = passed / GOLD.length;

  test(\`CPP 基线准确率 ≥ \${(BASELINE_ACCURACY * 100).toFixed(1)}%\`, () => {
    console.info(
      \`[cppGold] 准确率：\${passed}/\${GOLD.length} = \${(accuracy * 100).toFixed(1)}%\` +
        \`（基线下限 \${(BASELINE_ACCURACY * 100).toFixed(1)}%）\`,
    );
    // 失败明细抽样输出（全量过大，前 20 条）
    for (const f of failures.slice(0, 20)) {
      console.info(\`[cppGold] \${f}\`);
    }
    expect(accuracy).toBeGreaterThanOrEqual(BASELINE_ACCURACY);
  });
});
`;

writeFileSync(OUT_PATH, out);
console.log(`[gen-cpp-gold] 已生成 ${OUT_PATH}`);
