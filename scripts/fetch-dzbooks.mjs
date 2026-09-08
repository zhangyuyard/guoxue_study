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
  // ===== 扩充二批：经史子集 + 诗词歌赋 =====
  ['xiaojing', '儒藏/孝经/孝经.txt'],
  ['erya', '儒藏/小学/尔雅.txt'],
  ['liji', '儒藏/礼经/礼记.txt'],
  ['guoyu', '史藏/别史/国语.txt'],
  ['zhanguoce', '史藏/志存记录/战国策.txt'],
  ['hanshu', '史藏/正史/前汉书.txt'],
  ['houhanshu', '史藏/正史/后汉书.txt'],
  ['sanguozhi', '史藏/正史/三国志.txt'],
  ['sunzibingfa', '子藏/兵家/孙子.txt'],
  ['guanzi', '子藏/法家/管子.txt'],
  ['hanfeizi', '子藏/法家/韩非子.txt'],
  ['lvshichunqiu', '子藏/诸子/吕氏春秋.txt'],
  ['yanzichunqiu', '史藏/传记/晏子春秋.txt'],
  ['shishuoxinyu', '子藏/笔记/世说新语.txt'],
  ['yanshijiaxun', '子藏/诸子/颜氏家训.txt'],
  ['yutaixinyong', '诗藏/诗集/玉台新咏.txt'],
  ['huajianji', '诗藏/词集/花间集.txt'],
  ['yuefushiji', '诗藏/诗集/乐府诗集.txt'],
  ['wenxindiaolong', '集藏/文评/文心雕龙.txt'],
  ['caozijian', '集藏/四库别集/曹子建集.txt'],
  ['wenxuan_b', '集藏/文总集/文选昭明文选.txt'],
];

/** 维基文库补充源（daizhige 源缺卷）：clean 脚本另见 build-builtin-assets.mjs 注释 */
const WIKISOURCE = [
  // 淮南鸿烈解末四篇（源文件止于卷之二十四）
  ['huainanzi_25.txt', '淮南子/人間訓'],
  ['huainanzi_26.txt', '淮南子/脩務訓'],
  ['huainanzi_27.txt', '淮南子/泰族訓'],
  ['huainanzi_28.txt', '淮南子/要略'],
  // 太上感应篇本文（道藏汇编本自卷之二起，缺卷之一正文）
  ['ganyingpian_benwen.txt', '太上感應篇'],
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
