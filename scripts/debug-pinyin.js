/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 「三个红点」调查脚本：复现 annotate 逻辑，输出所有可疑拼音。
 * 用法：node scripts/debug-pinyin.js
 */
const { pinyin } = require('pinyin-pro');
const dict = require('../src/data/pinyin-dict.json');
const rules = require('../src/data/polyphone-rules.json');
const ddj = require('../src/data/texts/daodejing.json');

const PINYIN_DICT = dict.dict;
const POLYPHONE = dict.polyphone;

// ---------- 1. 扫描字典数据本身找异常 ----------
console.log('===== 1. 字典数据异常扫描 =====');
const anomalies = [];
for (const [ch, py] of Object.entries(PINYIN_DICT)) {
  if (typeof py !== 'string' || !py) {
    anomalies.push([ch, JSON.stringify(py), 'dict 空值/非字符串']);
    continue;
  }
  if (/[.,;:!?·…]/.test(py)) anomalies.push([ch, py, '含标点']);
  if (py.length > 7) anomalies.push([ch, py, '过长 >7']);
  if (/\d/.test(py)) anomalies.push([ch, py, '含数字（编号式拼音）']);
  if (/\s/.test(py)) anomalies.push([ch, py, '含空白']);
}
for (const [ch, arr] of Object.entries(POLYPHONE)) {
  if (!Array.isArray(arr)) anomalies.push([ch, JSON.stringify(arr), 'polyphone 非数组']);
  else for (const py of arr) {
    if (typeof py !== 'string' || !py) anomalies.push([ch, JSON.stringify(py), 'polyphone 空值']);
    else if (py.length > 7 || /[.,\d\s]/.test(py)) anomalies.push([ch, py, 'polyphone 异常值']);
  }
}
console.log('异常条目数:', anomalies.length);
for (const [ch, py, reason] of anomalies.slice(0, 40)) {
  console.log(`  ${JSON.stringify(ch)} -> ${JSON.stringify(py)}  [${reason}]`);
}

// ---------- 2. 复现 annotate：道德经第一章 ----------
console.log('\n===== 2. 道德经第一章注音复现 =====');
function isCJKChar(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x4e00 && cp <= 0x9fff;
}
const NARROW = new Set(['i', 'l', 'j', 't', 'r', 'f']);
function em(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x100) return 0.78;
  if (NARROW.has(ch)) return 0.42;
  return 0.68;
}
function estimateWidth(py, pinyinSize) {
  let total = 0;
  for (const ch of py) total += em(ch);
  return Math.ceil(total * pinyinSize) + 2;
}

const PINYIN_FONT_RATIO = 0.55; // typography.ts 中的真实值
for (const fontSize of [16, 20, 24]) {
  const pinyinSize = Math.max(9, Math.round(fontSize * PINYIN_FONT_RATIO));
  console.log(`\n--- fontSize=${fontSize}, pinyinSize=${pinyinSize} ---`);
  for (const chapter of ddj.chapters.slice(0, 1)) {
    for (const seg of chapter.segments) {
      const text = seg.text;
      const chars = Array.from(text);
      const baseArr = pinyin(text, { toneType: 'symbol', toneSandhi: false, type: 'all' });
      const aligned = Array.isArray(baseArr) && baseArr.length === chars.length;
      chars.forEach((ch, idx) => {
        if (!isCJKChar(ch)) return;
        let py = aligned ? (baseArr[idx] && baseArr[idx].pinyin) || '' : '';
        if (!py) py = PINYIN_DICT[ch] || '';
        if (!py) py = pinyin(ch, { toneType: 'symbol', toneSandhi: false, type: 'string' });
        const isPoly = Boolean(POLYPHONE[ch] && POLYPHONE[ch].length > 1);
        const w = estimateWidth(py, pinyinSize);
        // 打印多音字 + 宽拼音（估算 >= 5 字符或含声调字符 >= 2）
        if (isPoly && py.length >= 6) {
          console.log(`  [多音/长] ${ch} -> ${py}  est=${w}px  (POLYPHONE=${JSON.stringify(POLYPHONE[ch])})`);
        }
      });
    }
  }
}

// ---------- 3. 找出全部含声调字符的字符集（确认是否预组合） ----------
console.log('\n===== 3. 声调字符形态检查 =====');
const toneChars = new Set();
for (const py of Object.values(PINYIN_DICT)) {
  for (const ch of py) if (ch.codePointAt(0) >= 0x100) toneChars.add(ch);
}
console.log('字典中出现的非 ASCII 拼音字符:', [...toneChars].join(' '));

// ---------- 4. pinyin-pro 实际输出形态（道德经第一章前 30 字） ----------
console.log('\n===== 4. pinyin-pro 输出示例（前30字） =====');
const t1 = ddj.chapters[0].segments[0].text.slice(0, 30);
const arr = pinyin(t1, { toneType: 'symbol', toneSandhi: false, type: 'all' });
console.log(t1);
console.log(arr.map((x) => x.pinyin).join(' '));
