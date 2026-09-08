#!/usr/bin/env node
/**
 * fetch-dzbooks.mjs
 * 从 daizhigev20（殆知阁古代文献 v2.0，GitHub 公开仓库）拉取道家/佛家公版全本源文本，
 * 输出到 /tmp/ancient/dzbook/<id>.txt（繁体，build-builtin-assets.mjs 做 t2s）。
 * 用法：node scripts/fetch-dzbooks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = '/tmp/ancient/dzbook';
const BASE = 'https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/';

/** id → 仓库相对路径（文件名可能与 id 不同） */
const MANIFEST = [
  // ===== 佛家 =====
  ['xinjing', '佛藏/大藏经/经藏/般若部/般若波罗蜜多心经-唐-玄奘.txt'],
  ['jingangjing', '佛藏/大藏经/经藏/般若部/金刚般若波罗蜜经-姚秦-鸠摩罗什.txt'],
  ['liuzutanjing', '佛藏/藏外/六组坛经.txt'],
  ['lengyanjing', '佛藏/大藏经/经藏/密教部/大佛顶如来密因修证了义诸菩萨万行首楞严经.txt'],
  ['fahuajing', '佛藏/大藏经/经藏/法华部/妙法莲华经.txt'],
  ['weimojing', '佛藏/大藏经/经藏/经集部/维摩诘所说经.txt'],
  ['yuanjuejing', '佛藏/大藏经/经藏/经集部/大方广圆觉修多罗了义经.txt'],
  ['yaoshijing', '佛藏/大藏经/经藏/经集部/药师琉璃光如来本愿功德经.txt'],
  ['emituofojing', '佛藏/大藏经/经藏/宝积部/佛说阿弥陀经.txt'],
  ['wuliangshoujing', '佛藏/大藏经/经藏/宝积部/佛说无量寿经.txt'],
  ['guanwuliangshoujing', '佛藏/大藏经/经藏/宝积部/佛说观无量寿佛经.txt'],
  ['dizangjing', '佛藏/大藏经/经藏/大集部/地藏菩萨本愿经.txt'],
  ['sishierzhangjing', '佛藏/藏外/四十二章经.txt'],
  ['badarenjuejing', '佛藏/大藏经/经藏/经集部/佛说八大人觉经.txt'],
  ['baiyujing', '佛藏/大藏经/经藏/本缘部/百喻经.txt'],
  ['fajujing', '佛藏/大藏经/经藏/本缘部/法句经.txt'],
  ['yijiaojing', '佛藏/大藏经/经藏/涅槃部/佛垂般涅槃略说教诫经.txt'],
  // ===== 道家 =====
  ['liezi', '道藏/正统道藏洞神部/本文类/冲虚至德真经.txt'],
  ['guanyinzi', '道藏/正统道藏洞神部/本文类/无上妙道文始真经.txt'],
  ['yinfujing', '道藏/正统道藏洞真部/本文类/黄帝阴符经.txt'],
  ['qingjingjing', '道藏/正统道藏洞神部/本文类/太上老君说常清静妙经.txt'],
  ['zuowanglun', '道藏/正统道藏太玄部/坐忘论.txt'],
  ['huashu', '道藏/正统道藏太玄部/化书.txt'],
  ['guiguzi', '道藏/正统道藏太玄部/鬼谷子.txt'],
  ['ganyingpian', '道藏/正统道藏太清部/太上感应篇.txt'],
  ['baopuzi', '道藏/正统道藏太清部/抱朴子内篇.txt'],
  ['huainanzi', '道藏/正统道藏太清部/淮南鸿烈解.txt'],
  ['heguanzi', '道藏/正统道藏太清部/鹖冠子.txt'],
  ['wuzhenpian', '道藏/正统道藏洞真部/方法类/修真十书悟真篇卷.txt'],
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let ok = 0;
const failed = [];
for (const [id, rel] of MANIFEST) {
  const out = path.join(OUT_DIR, `${id}.txt`);
  if (fs.existsSync(out) && fs.statSync(out).size > 100) {
    ok += 1;
    continue;
  }
  const url = BASE + encodeURI(rel);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      failed.push(`${id}: HTTP ${res.status}`);
      console.warn(`FAIL ${id} HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    fs.writeFileSync(out, text, 'utf8');
    ok += 1;
    console.log(`OK   ${id} ${(text.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    failed.push(`${id}: ${e.message}`);
    console.warn(`FAIL ${id} ${e.message}`);
  }
}
console.log(`\ndone: ${ok}/${MANIFEST.length}, failed: ${failed.length}`);
if (failed.length > 0) {
  console.log(failed.join('\n'));
}
