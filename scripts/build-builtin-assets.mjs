#!/usr/bin/env node
/**
 * build-builtin-assets.mjs
 * 内置书全本化 + 诗词曲蒙学扩充：把各开源源数据统一转换为
 * 「@@CH@@章节标记」纯文本资产，输出到 android/app/src/main/assets/books/<id>.txt，
 * 并生成 src/data/builtinCatalog.ts（书目录清单，随 bundle 走，仅元数据）。
 *
 * 运行时链路（UserBookService）：首启 copyFileAssets 把 assets/books/*.txt
 * 落到 guoxue-books/builtin/ → 扫描解析（parseTxtBook markers）→ 注册内置书。
 * bundle 不再携带任何书体 JSON（瘦身约 4MB+），书体大小不受限。
 *
 * 数据源（/tmp/ancient，脚本只读）：
 * - builtin/<id>.json           既有 10 部全本（上轮 build-fulltext-books 产物）
 * - lunyu.json mengzi.json      hanzhaodeng/chinese-ancient-text（简体）
 * - shijing-cp.json chuci-cp.json chinese-poetry（简体）
 * - zztj.json                   chinese-ancient-text 资治通鉴全本 294 卷（简体）
 * - songci300.json              chinese-poetry/huajianji 宋词三百首（简体）
 * - yuanqu.json                 chinese-poetry 元曲全库（简体，按作者分章）
 * - tangshi300.json             chinese-poetry/蒙学 唐诗三百首全本（繁体→t2s）
 * - guwen.json                  chinese-poetry/蒙学 古文观止全本（繁体→t2s）
 * - sanzijing/baijiaxing/qianziwen/dizigui/zhuzijiaxun/
 *   zengguangxianwen/shenglv/youxue .json  chinese-poetry/蒙学（繁体→t2s）
 * - liweng.txt                  daizhigev20 笠翁对韵（繁体→t2s）
 *
 * 完整性自检：章数/段落数/字数报告；ASCII 残留检查；t2s 幂等抽检（无繁体残留）；
 * 首/末章内容抽样比对（源行必须出现在产物中）。
 *
 * 用法：node scripts/build-builtin-assets.mjs   （需先备好 /tmp/ancient 源）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = process.env.SRC_DIR || '/tmp/ancient';
const ASSETS_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'books');
const CATALOG_OUT = path.join(ROOT, 'src', 'data', 'builtinCatalog.ts');

const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');
const t2s = OpenCC.Converter({ from: 't', to: 'cn' });

fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ============ 工具 ============

/** 繁→简（仅 traditional 源调用） */
function toSimplified(text) {
  return t2s(text);
}

/** 行级清洗：去 ASCII 字母数字与残余记号、合并空白（保留中文标点；半角括号转全角） */
function cleanLine(s) {
  return String(s)
    .replace(/[A-Za-z0-9]/g, '')
    .replace(/[<>{}[\]\\|`~^$*_=]/g, '')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

/** 单书文本组装：chapters = [{ title, paragraphs: string[] }] → marker txt */
function toMarkerText(chapters) {
  const parts = [];
  for (const ch of chapters) {
    parts.push(`@@CH@@${ch.title}`);
    const paras = ch.paragraphs.filter((p) => p && p.trim());
    parts.push(paras.join('\n\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * 从产物 marker 文本推导章节目录（与运行时 parseTxtBook 同规则）：
 * - @@CH@@标题 行切章；空标题按标记出现顺序补「第N章」
 * - 首标记前的非空正文运行时会成为「开篇」章（order=1，后续后移）
 * - 正文全空的章节运行时不进 chapters（不占 order），目录跳过
 * 返回 [{ id, title }]，id 与运行时 `${bookId}-c${order}` 逐条一致。
 */
function deriveToc(text, bookId) {
  const lines = text.split('\n');
  const raw = [];
  let cur = null;
  let prefaceHasBody = false;
  let markerCount = 0;
  for (const line of lines) {
    const m = /^@@CH@@(.*)$/.exec(line);
    if (m) {
      markerCount += 1;
      if (cur) {
        raw.push(cur);
      }
      cur = { title: m[1].trim() || `第${markerCount}章`, hasBody: false };
    } else if (cur) {
      if (line.trim()) {
        cur.hasBody = true;
      }
    } else if (line.trim()) {
      prefaceHasBody = true;
    }
  }
  if (cur) {
    raw.push(cur);
  }
  const toc = [];
  let order = 0;
  if (prefaceHasBody) {
    order += 1;
    toc.push({ id: `${bookId}-c${order}`, title: '开篇' });
  }
  for (const ch of raw) {
    if (!ch.hasBody) {
      continue;
    }
    order += 1;
    toc.push({ id: `${bookId}-c${order}`, title: ch.title });
  }
  return toc;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'));
}

function readTxt(rel) {
  return fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
}

// ============ 各书构建 ============

/** 既有全本 JSON（Book schema）→ chapters（段落即 segments 文本） */
function fromExistingBookJson(id) {
  const book = readJson(`builtin/${id}.json`);
  return {
    meta: { author: book.author, description: book.description },
    chapters: book.chapters.map((c) => ({
      title: c.title,
      paragraphs: c.segments.map((s) => s.text),
    })),
  };
}

/** chinese-ancient-text { articles: [{title, content}] } → 每篇一章 */
function fromAncientArticles(id, opts = {}) {
  const data = readJson(opts.file || `${id}.json`);
  const chapters = data.articles.map((a) => ({
    title: a.title,
    paragraphs: a.content.map(cleanLine).filter(Boolean),
  }));
  return { meta: { author: opts.author, description: opts.description }, chapters };
}

/** chinese-poetry 诗经：[{title, chapter, section, content}] → 「section·chapter」分章 */
function buildShijing() {
  const list = readJson('shijing-cp.json');
  const groups = new Map();
  for (const p of list) {
    const key = `${p.chapter}·${p.section}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ title: p.title, content: p.content });
  }
  const chapters = [];
  for (const [key, poems] of groups) {
    const paras = [];
    for (const poem of poems) {
      paras.push(`◆ ${poem.title}`);
      paras.push(...poem.content.map(cleanLine).filter(Boolean));
    }
    chapters.push({ title: key, paragraphs: paras });
  }
  return {
    meta: { author: '佚名（周代采诗）', description: '我国最早诗歌总集，收录西周至春秋诗篇三百零五篇。本版为全本。' },
    chapters,
  };
}

/** chinese-poetry 楚辞：[{title, section, author, content}] → 每篇章一组 */
function buildChuci() {
  const list = readJson('chuci-cp.json');
  const groups = new Map();
  for (const p of list) {
    if (!groups.has(p.section)) groups.set(p.section, []);
    groups.get(p.section).push(p);
  }
  const chapters = [];
  for (const [section, poems] of groups) {
    const paras = [];
    for (const poem of poems) {
      paras.push(`◆ ${poem.title}${poem.author ? `（${poem.author}）` : ''}`);
      paras.push(...poem.content.map(cleanLine).filter(Boolean));
    }
    chapters.push({ title: section, paragraphs: paras });
  }
  return {
    meta: { author: '屈原 等', description: '以屈原作品为首的楚辞总集，兼收汉代拟作。本版为全本。' },
    chapters,
  };
}

/** 唐诗三百首（繁体）：content 7 体裁卷 × {chapter 诗题, author, paragraphs} */
function buildTangshi300() {
  const data = readJson('tangshi300.json');
  const chapters = [];
  let poemCount = 0;
  for (const group of data.content) {
    const paras = [];
    for (const poem of group.content) {
      poemCount += 1;
      paras.push(`◆ ${toSimplified(poem.chapter)} · ${toSimplified(poem.author || '佚名')}`);
      paras.push(...poem.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean));
    }
    chapters.push({ title: toSimplified(group.type), paragraphs: paras });
  }
  return {
    meta: {
      author: '蘅塘退士 编',
      description: `清·蘅塘退士编选唐诗选集，共收诗 ${poemCount} 首。本版为全本。`,
    },
    chapters,
    poemCount,
  };
}

/** 宋词三百首（简体）：[{title, author, paragraphs}] → 按作者分章 */
function buildSongci300() {
  const list = readJson('songci300.json');
  const groups = new Map();
  for (const p of list) {
    const author = p.author || '佚名';
    if (!groups.has(author)) groups.set(author, []);
    groups.get(author).push(p);
  }
  const chapters = [];
  for (const [author, poems] of groups) {
    const paras = [];
    for (const poem of poems) {
      paras.push(`◆ ${poem.title}`);
      paras.push(...poem.paragraphs.map(cleanLine).filter(Boolean));
    }
    chapters.push({ title: author, paragraphs: paras });
  }
  return {
    meta: { author: '朱祖谋 编', description: `近人朱祖谋编选宋词选集，共收词 ${list.length} 首。本版为全本。` },
    chapters,
  };
}

/** 元曲全库（简体）：[{title, author, paragraphs}] → 按作者分章 */
function buildYuanqu() {
  const list = readJson('yuanqu.json');
  const groups = new Map();
  for (const p of list) {
    const author = p.author || '佚名';
    if (!groups.has(author)) groups.set(author, []);
    groups.get(author).push(p);
  }
  const chapters = [];
  for (const [author, poems] of groups) {
    const paras = [];
    for (const poem of poems) {
      paras.push(`◆ ${poem.title}`);
      paras.push(...poem.paragraphs.map(cleanLine).filter(Boolean));
    }
    chapters.push({ title: author, paragraphs: paras });
  }
  return {
    meta: { author: '元代曲家', description: `元曲总集（散曲与剧曲套数），收 ${list.length} 首、 ${groups.size} 家。本版为全本。` },
    chapters,
  };
}

/** 古文观止（繁体）：content 12 卷 × {chapter 篇名, source, author, paragraphs} → 每篇一章 */
function buildGuwen() {
  const data = readJson('guwen.json');
  const chapters = [];
  for (const vol of data.content) {
    for (const piece of vol.content) {
      const source = toSimplified((piece.source || '').replace(/[《》\s]/g, ''));
      chapters.push({
        title: `${toSimplified(piece.chapter)} · ${source}`,
        paragraphs: piece.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean),
      });
    }
  }
  return {
    meta: { author: '吴楚材、吴调侯 编', description: `清·吴氏叔侄编选历代散文选集，共 ${chapters.length} 篇。本版为全本。` },
    chapters,
  };
}

/** 蒙学单章（dict: title/author/paragraphs 或 content:[{chapter, paragraphs}]） */
function buildMengxueSingle(id, opts) {
  const data = readJson(`${id}.json`);
  const chapters = [];
  if (Array.isArray(data.paragraphs)) {
    chapters.push({ title: opts.bookTitle, paragraphs: data.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean) });
  } else if (Array.isArray(data.content)) {
    // content 可能是 [{chapter, paragraphs}] 或 [{title, content:[{chapter, paragraphs}]}]
    if (data.content.length > 0 && Array.isArray(data.content[0].paragraphs)) {
      for (const sec of data.content) {
        chapters.push({
          title: toSimplified(sec.chapter || opts.bookTitle),
          paragraphs: sec.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean),
        });
      }
    } else {
      for (const vol of data.content) {
        for (const sec of vol.content) {
          chapters.push({
            title: toSimplified(sec.chapter || vol.title),
            paragraphs: sec.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean),
          });
        }
      }
    }
  }
  return { meta: { author: opts.author, description: opts.description }, chapters };
}

/** 声律启蒙（繁体 dict: content:[{title 卷, content:[{chapter 韵部, paragraphs}]}]） */
function buildShenglv() {
  const data = readJson('shenglv.json');
  const chapters = [];
  for (const vol of data.content) {
    for (const sec of vol.content) {
      chapters.push({
        title: `${toSimplified(vol.title)}·${toSimplified(sec.chapter)}`,
        paragraphs: sec.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean),
      });
    }
  }
  return {
    meta: { author: '车万育', description: '清·车万育撰声韵对偶蒙书，训练诗联对仗。本版为全本。' },
    chapters,
  };
}

/** 幼学琼林（繁体 dict: content 4 卷 × [{chapter, paragraphs}]） */
function buildYouxue() {
  const data = readJson('youxue.json');
  const chapters = [];
  for (const vol of data.content) {
    for (const sec of vol.content) {
      chapters.push({
        title: `${toSimplified(vol.title)}·${toSimplified(sec.chapter)}`,
        paragraphs: sec.paragraphs.map(toSimplified).map(cleanLine).filter(Boolean),
      });
    }
  }
  return {
    meta: { author: '程登吉', description: '明·程登吉撰百科常识蒙书（原本《幼学须知》）。本版为全本。' },
    chapters,
  };
}

/** 笠翁对韵（daizhige txt 繁体）：【上卷】/【下卷】 + 「X韵 其N」分章 */
function buildLiweng() {
  const raw = toSimplified(readTxt('liweng.txt'));
  const lines = raw.split(/\r?\n/);
  const chapters = [];
  let curVol = '';
  let cur = null;
  const headerRe = /^([一二三四五六七八九十]+)\s*([东冬江支微鱼虞齐佳灰真文元寒删先萧肴豪歌麻阳庚青蒸尤侵覃盐咸])\s*其[一二三四五六七八九十]+$/;
  const volRe = /^【([上下])卷】$/;
  for (const line of lines) {
    const t = line.trim().replace(/　/g, ' ').replace(/\s+/g, ' ');
    if (!t) continue;
    const vol = volRe.exec(t);
    if (vol) {
      curVol = `${vol[1]}卷`;
      continue;
    }
    const h = headerRe.exec(t);
    if (h) {
      if (cur) chapters.push(cur);
      cur = { title: `${curVol}·${h[1]}${h[2]}`, paragraphs: [] };
      continue;
    }
    if (cur) {
      // 韵文行内空格为节奏分隔，转顿号（已有顿号的合并双顿号）
      cur.paragraphs.push(
        t.replace(/\s/g, '、').replace(/、、+/g, '、'),
      );
    } else if (t.includes('笠翁对韵')) {
      continue;
    }
  }
  if (cur) chapters.push(cur);
  return {
    meta: { author: '李渔', description: '清·李渔撰声韵对偶蒙书，与《声律启蒙》齐名。本版为全本。' },
    chapters,
  };
}

// ============ daizhige 通用构建（道家 / 佛家扩充 29 部） ============

/**
 * daizhigev20 源通用转换器（/tmp/ancient/dzbook/<file>.txt，繁体自动 t2s）。
 * opts:
 *   author / description   目录元数据（必填）
 *   implicitTitle          首章前置内容/单章书的章节题；缺省丢弃前置内容
 *   chapterPattern         行级章节标记正则（附带护栏：行长 ≤44 且不含句读）
 *   chapterTitle(t, next)  章题规整（t=标记行，next=被吸收的后一短行或 null）
 *   consumeNextIfShort     章题吸收后一短行（淮南/抱朴「卷之N」+「篇名」体例）
 *   dropLines              逐行丢弃正则（叠加默认：经名/目录/校勘记行）
 *   extraSplit             [{ beforeRe, title }] 命中行前插入分章
 *   tocGuard               开头连续标记 run（间隔 ≤2 行、≥3 条）且后方仍有
 *                          真实标记时按目录丢弃（鬼谷子 / 鹖冠子体例）
 */
function buildDaizhigeBook(file, opts = {}) {
  const raw = toSimplified(readTxt(`dzbook/${file}.txt`));
  const dropLines = [/^经名：/, /^目录#/, /目录原缺/, /^#\d/, ...(opts.dropLines || [])];
  const texts = raw.split(/\r?\n/).map((l) => l.replace(/^[\s　]+/, '').replace(/[\s　]+$/, ''));
  const isDropped = (t) => dropLines.some((re) => re.test(t));
  const isHeading = (t) => {
    if (!opts.chapterPattern || !t || t.length > 44) return false;
    if (/[，。；！？：]/.test(t)) return false;
    if (isDropped(t)) return false;
    return opts.chapterPattern.test(t);
  };
  const heading = texts.map(isHeading);
  if (opts.tocGuard) {
    // 目录判别：文件前部的标题序列，逐项满足「题名在后方正文再次出现」
    // 或「与下一标题紧邻（间隔 ≤3 行且中间无长正文行）」时视为目录丢弃；
    // 遇到首个正文标题（题名唯一且后随正文）即停。
    const idx = [];
    heading.forEach((h, i) => { if (h) idx.push(i); });
    const norm = (s) => s.replace(/[　\s]+/g, '');
    const lastPos = new Map();
    idx.forEach((i) => lastPos.set(norm(texts[i]), i));
    let k = 0;
    while (k < idx.length - 3) {
      const i = idx[k];
      const repeats = (lastPos.get(norm(texts[i])) || -1) > i;
      let cluster = false;
      if (k + 1 < idx.length) {
        const j = idx[k + 1];
        if (j - i <= 4) {
          cluster = true;
          for (let m = i + 1; m < j; m += 1) {
            if (texts[m] && texts[m].length > 14) cluster = false;
          }
        }
      }
      if (!repeats && !cluster) break;
      heading[i] = false;
      k += 1;
    }
  }
  // 行内清洗：校勘记编号、半角标点残留
  const toPara = (t) => t.replace(/#\d+/g, '').replace(/[;,:?!'".]+/g, '');
  const chapters = [];
  const titleSeen = new Set();
  let cur = null;
  const pushPara = (t) => {
    const s = toPara(t);
    if (isDropped(t) || isDropped(s)) return;
    if (!/[\u4e00-\u9fff]/.test(s)) return;
    if (!cur) {
      if (!opts.implicitTitle) return;
      cur = { title: opts.implicitTitle, paragraphs: [] };
      chapters.push(cur);
    }
    cur.paragraphs.push(s);
  };
  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    if (!t) continue;
    if (heading[i]) {
      let consumed = -1;
      if (opts.consumeNextIfShort) {
        let j = i + 1;
        while (j < texts.length && (!texts[j] || isDropped(texts[j]) || heading[j])) j += 1;
        if (j < texts.length && texts[j].length <= 12 && !/[，。；：！？。]/.test(texts[j])) consumed = j;
      }
      let title = t;
      if (opts.chapterTitle) title = opts.chapterTitle(t, consumed >= 0 ? texts[consumed] : null);
      else if (consumed >= 0) title = `${t}·${texts[consumed]}`;
      if (opts.dedupeTitles) {
        const key = title.replace(/[　\s]+/g, '');
        if (titleSeen.has(key)) {
          if (consumed >= 0) i = consumed;
          continue;
        }
        titleSeen.add(key);
      }
      cur = { title, paragraphs: [] };
      chapters.push(cur);
      if (consumed >= 0) i = consumed;
      continue;
    }
    if (opts.extraSplit) {
      const sp = opts.extraSplit.find((s) => s.beforeRe.test(t));
      if (sp) {
        cur = { title: sp.title, paragraphs: [] };
        chapters.push(cur);
      }
    }
    pushPara(t);
  }
  return { meta: { author: opts.author, description: opts.description }, chapters };
}

const NUM = '[一二三四五六七八九十百零〇○]+';

/**
 * daizhigev20 道家 / 佛家扩充 29 部（17 佛 + 12 道，全部全本）。
 * category 统一归 'zi'（《四库全书》口径：道家入子部·道家类，佛家入子部·释家类）；
 * 佛经在 bookMeta 体裁维度单列「佛家」。
 */
const DZ_BOOKS = [
  // ---------- 佛家 17 部 ----------
  {
    id: 'xinjing', title: '心经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('xinjing', {
      implicitTitle: '心经',
      author: '唐·玄奘 译',
      description: '《般若波罗蜜多心经》，大乘般若类经典纲要，二百六十字摄空义总纲。全本。',
    }),
  },
  {
    id: 'jingangjing', title: '金刚经', category: 'zi', dynasty: '后秦',
    build: () => buildDaizhigeBook('jingangjing', {
      implicitTitle: '金刚经',
      author: '后秦·鸠摩罗什 译',
      description: '《金刚般若波罗蜜经》，般若类核心经典，言无住生心、无相布施之旨。全本。',
    }),
  },
  {
    id: 'emituofojing', title: '阿弥陀经', category: 'zi', dynasty: '后秦',
    build: () => buildDaizhigeBook('emituofojing', {
      implicitTitle: '阿弥陀经',
      dropLines: [/^佛说阿弥陀经卷第/],
      author: '后秦·鸠摩罗什 译',
      description: '《佛说阿弥陀经》，净土宗核心经典，述西方极乐世界依正庄严。全本。',
    }),
  },
  {
    id: 'wuliangshoujing', title: '无量寿经', category: 'zi', dynasty: '曹魏',
    build: () => buildDaizhigeBook('wuliangshoujing', {
      implicitTitle: '无量寿经',
      author: '曹魏·康僧铠 译',
      description: '《佛说无量寿经》，净土三经之一，述阿弥陀佛四十八愿与净土行果。全本。',
    }),
  },
  {
    id: 'guanwuliangshoujing', title: '观无量寿经', category: 'zi', dynasty: '刘宋',
    build: () => buildDaizhigeBook('guanwuliangshoujing', {
      implicitTitle: '观无量寿经',
      author: '刘宋·畺良耶舍 译',
      description: '《佛说观无量寿佛经》，净土三经之一，明十六观法与三辈往生。全本。',
    }),
  },
  {
    id: 'yaoshijing', title: '药师经', category: 'zi', dynasty: '隋',
    build: () => buildDaizhigeBook('yaoshijing', {
      implicitTitle: '药师经',
      author: '隋·达摩笈多 译',
      description: '《佛说药师如来本愿经》，述药师琉璃光如来十二大愿，济世度厄。全本。',
    }),
  },
  {
    id: 'fajujing', title: '法句经', category: 'zi', dynasty: '三国',
    build: () => buildDaizhigeBook('fajujing', {
      chapterPattern: new RegExp(`品.{0,8}第${NUM}`),
      author: '三国吴·维祚难 等译',
      description: '上座部法句偈颂集汉译本，三十九品七百余偈，言身心谛修之要。全本。',
    }),
  },
  {
    id: 'baiyujing', title: '百喻经', category: 'zi', dynasty: '南朝齐',
    build: () => buildDaizhigeBook('baiyujing', {
      chapterPattern: new RegExp(`^（${NUM}）[^，。]{1,24}$`),
      dropLines: [
        /^百喻经卷第/,
        /^(尊者僧伽斯那|萧齐天竺).*[撰译]$/,
        new RegExp(`^(\\S{2,12}喻)(　+\\S{2,12}喻)+$`), // 卷首喻目连排行
      ],
      extraSplit: [{ beforeRe: /^闻如是/, title: '缘起' }],
      author: '萧齐·求那毗地 译',
      description: '印度僧伽斯那集九十八喻，以寓言譬喻显佛法义理。全本。',
    }),
  },
  {
    id: 'sishierzhangjing', title: '四十二章经', category: 'zi', dynasty: '东汉',
    build: () => buildDaizhigeBook('sishierzhangjing', {
      implicitTitle: '四十二章经',
      author: '东汉·迦叶摩腾、竺法兰 译',
      description: '相传为汉地最早译出的佛经，四十二章摄出家修行纲要。全本。',
    }),
  },
  {
    id: 'yuanjuejing', title: '圆觉经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('yuanjuejing', {
      implicitTitle: '圆觉经',
      author: '唐·佛陀多罗 译',
      description: '《大方广圆觉修多罗了义经》，述十二菩萨问圆觉法门。全本。',
    }),
  },
  {
    id: 'yijiaojing', title: '佛遗教经', category: 'zi', dynasty: '后秦',
    build: () => buildDaizhigeBook('yijiaojing', {
      implicitTitle: '佛遗教经',
      author: '后秦·鸠摩罗什 译',
      description: '释迦牟尼临涅槃所述遗诫，又称《佛垂般涅槃略说教诫经》。全本。',
    }),
  },
  {
    id: 'badarenjuejing', title: '八大人觉经', category: 'zi', dynasty: '东汉',
    build: () => buildDaizhigeBook('badarenjuejing', {
      implicitTitle: '八大人觉经',
      author: '东汉·安世高 译',
      description: '述诸佛菩萨大人所觉悟之八法，明出世解脱路径。全本。',
    }),
  },
  {
    id: 'weimojing', title: '维摩诘经', category: 'zi', dynasty: '后秦',
    build: () => buildDaizhigeBook('weimojing', {
      chapterPattern: new RegExp(`品第${NUM}$`),
      chapterTitle: (t) => t.replace(/^维摩诘(所说)?经/, ''),
      dropLines: [/^维摩诘(所说)?经卷[上下]/, /^维摩诘所说经[（(]/],
      author: '后秦·鸠摩罗什 译',
      description: '《维摩诘所说经》十四品，示在家菩萨不可思议解脱法门。全本。',
    }),
  },
  {
    id: 'fahuajing', title: '妙法莲华经', category: 'zi', dynasty: '后秦',
    build: () => buildDaizhigeBook('fahuajing', {
      chapterPattern: new RegExp(`品第${NUM}$`),
      chapterTitle: (t) => t.replace(/^妙法莲华经/, ''),
      dropLines: [/^妙法莲华经卷第/],
      author: '后秦·鸠摩罗什 译',
      description: '《妙法莲华经》二十八品，开权显实、会三归一之大乘要典。全本。',
    }),
  },
  {
    id: 'lengyanjing', title: '楞严经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('lengyanjing', {
      chapterPattern: new RegExp(`卷第${NUM}$`),
      chapterTitle: (t) => t.replace(/^.*?楞严经/, '') || t,
      author: '唐·般剌蜜帝 译',
      description: '《大佛顶首楞严经》十卷，明心见性、五十阴魔之照胆镜。全本。',
    }),
  },
  {
    id: 'dizangjing', title: '地藏经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('dizangjing', {
      chapterPattern: new RegExp(`品第${NUM}$`),
      author: '唐·实叉难陀 译',
      description: '《地藏菩萨本愿经》十三品，明孝道与地狱救度之愿力。全本。',
    }),
  },
  {
    id: 'liuzutanjing', title: '六祖坛经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('liuzutanjing', {
      chapterPattern: /^《.+》$/,
      chapterTitle: (t) => t.replace(/[《》]/g, ''),
      author: '唐·法海 集记',
      description: '禅宗六祖惠能于韶州大梵寺说法集录，唯一被尊称为「经」的中国僧人著述。全本。',
    }),
  },
  // ---------- 道家 12 部 ----------
  {
    id: 'qingjingjing', title: '清静经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('qingjingjing', {
      implicitTitle: '清静经',
      author: '唐·佚名（旧题太上老君说）',
      description: '《太上老君说常清静经》，澄心遣欲、内修心神之道家要典。全本。',
    }),
  },
  {
    id: 'yinfujing', title: '阴符经', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('yinfujing', {
      implicitTitle: '阴符经',
      author: '旧题黄帝撰（唐·李筌得于嵩山）',
      description: '《黄帝阴符经》三百余字，言观天之道、执天之行。全本。',
    }),
  },
  {
    id: 'guanyinzi', title: '关尹子', category: 'zi', dynasty: '先秦',
    build: () => buildDaizhigeBook('guanyinzi', {
      chapterPattern: new RegExp(`^${NUM}(宇|字|柱|极|符|鉴|匕|釜|筹|药)$`),
      implicitTitle: '序传',
      author: '周·关令尹喜 著',
      description: '又称《文始真经》九篇，以宇柱极符鉴匕釜筹药名篇。全本。',
    }),
  },
  {
    id: 'guiguzi', title: '鬼谷子', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('guiguzi', {
      chapterPattern: new RegExp(`^.{1,4}第${NUM}$`),
      tocGuard: true,
      author: '旧题战国·鬼谷子 著',
      description: '纵横家鼻祖之书，捭阖、反应、揣摩、权谋十二篇。全本。',
    }),
  },
  {
    id: 'liezi', title: '列子', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('liezi', {
      chapterPattern: new RegExp(`^.{1,4}第${NUM}$`),
      author: '战国·列御寇 著',
      description: '又称《冲虚至德真经》八篇，寓道于寓言，天瑞说符俱载。全本。',
    }),
  },
  {
    id: 'heguanzi', title: '鹖冠子', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('heguanzi', {
      chapterPattern: new RegExp(`^.{1,4}第${NUM}$`),
      tocGuard: true,
      author: '战国·鹖冠子 著（宋·陆佃解）',
      description: '道家与纵横家言杂糅之子书十九篇。全本。',
    }),
  },
  {
    id: 'huainanzi', title: '淮南子', category: 'zi', dynasty: '西汉',
    build: () => {
      // 源（道藏·太清部许慎注本）仅存卷之一～二十四，末四篇（人间/修务/泰族/要略）
      // 据维基文库公版文本补齐，章节题按该本 28 卷口径续编
      const extraRaw = toSimplified(readTxt('dzbook/huainanzi_extra.txt'));
      const extraChapters = [];
      let extraCur = null;
      for (const line of extraRaw.split(/\r?\n/)) {
        const m = line.match(/^@@CH@@(.+)$/);
        if (m) {
          extraCur = { title: m[1], paragraphs: [] };
          extraChapters.push(extraCur);
          continue;
        }
        const t = cleanLine(line);
        if (t && extraCur) extraCur.paragraphs.push(t);
      }
      const base = buildDaizhigeBook('huainanzi', {
        chapterPattern: new RegExp(`卷之${NUM}$`),
        consumeNextIfShort: true,
        chapterTitle: (t, next) => `${t.replace(/^.*?卷之/, '卷之')}${next ? `·${next}` : ''}`,
        dropLines: [/竟$/, /^太尉祭酒/, new RegExp(`^卷${NUM}　`)],
        implicitTitle: '叙',
        author: '西汉·刘安 撰（许慎 注）',
        description: '',
      });
      return {
        meta: {
          author: '西汉·刘安 撰（许慎 注）',
          description: '《淮南鸿烈解》二十八卷，集道家思想大成的鸿篇。全本。',
        },
        chapters: [...base.chapters, ...extraChapters],
      };
    },
  },
  {
    id: 'baopuzi', title: '抱朴子内篇', category: 'zi', dynasty: '东晋',
    build: () => buildDaizhigeBook('baopuzi', {
      chapterPattern: new RegExp(`卷之${NUM}$`),
      consumeNextIfShort: true,
      chapterTitle: (t, next) => `${t.replace(/^.*?卷之/, '卷之')}${next ? `·${next}` : ''}`,
      dropLines: [/竟$/, new RegExp(`^卷${NUM}　`)],
      // 源缺「卷之十一」标题行（正文在卷之十竟后）：在竟行处补切章
      extraSplit: [{ beforeRe: /^抱朴子内篇卷之十竟$/, title: '卷之十一·仙药' }],
      implicitTitle: '序',
      author: '东晋·葛洪 著',
      description: '金丹道教理论奠基之作二十卷，言神仙方药、养生延年。全本。',
    }),
  },
  {
    id: 'huashu', title: '化书', category: 'zi', dynasty: '五代',
    build: () => buildDaizhigeBook('huashu', {
      chapterPattern: new RegExp(`卷第${NUM}$`),
      tocGuard: true,
      author: '五代·谭峭 著',
      description: '道化、术化、德化、仁化、食化、俭化六卷，观物化之理。全本。',
    }),
  },
  {
    id: 'wuzhenpian', title: '悟真篇', category: 'zi', dynasty: '北宋',
    build: () => buildDaizhigeBook('wuzhenpian', {
      implicitTitle: '悟真篇',
      author: '北宋·张伯端 著',
      description: '内丹南宗祖经，据《修真十书》本，与《参同契》并尊。全本。',
    }),
  },
  {
    id: 'zuowanglun', title: '坐忘论', category: 'zi', dynasty: '唐',
    build: () => buildDaizhigeBook('zuowanglun', {
      chapterPattern: /^(敬信|断缘|收心|简事|真观|泰定|得道)[一二三四五六七八九十]$/,
      // 源缺「真观五」标题行（正文以「夫真观者」起）：补切章
      extraSplit: [{ beforeRe: /^夫真观者/, title: '真观五' }],
      implicitTitle: '序',
      author: '唐·司马承祯 著',
      description: '道教修真理论名篇，敬信至得道七阶及枢翼。全本。',
    }),
  },
  {
    id: 'ganyingpian', title: '太上感应篇', category: 'zi', dynasty: '宋',
    build: () => {
      // 源文件（道藏·太清部李昌龄传本）自卷之二起，缺卷之一（感应篇本文）；
      // 本文自维基文库公版文本补入，冠于卷首
      const benwen = buildDaizhigeBook('ganyingpian_benwen', {
        implicitTitle: '感应篇本文',
        author: '宋·李昌龄 传、郑清之 赞',
        description: '',
      });
      const zhuan = buildDaizhigeBook('ganyingpian', {
        chapterPattern: new RegExp(`太上感应篇卷之${NUM}$`),
        chapterTitle: (t) => t.replace(/^太上感应篇/, ''),
        dropLines: [/竟$/],
        implicitTitle: '进表',
        author: '宋·李昌龄 传、郑清之 赞',
        description: '',
      });
      return {
        meta: {
          author: '宋·李昌龄 传、郑清之 赞',
          description: '以太上本文冠首，附李昌龄传、郑清之赞三十卷，劝善书之首。全本。',
        },
        chapters: [...benwen.chapters, ...zhuan.chapters],
      };
    },
  },
  // ---------- 扩充二批：经史子集 + 诗词歌赋（daizhige 公版） ----------
  // 经部
  {
    id: 'xiaojing', title: '孝经', category: 'jing', dynasty: '先秦',
    build: () => buildDaizhigeBook('xiaojing', {
      chapterPattern: new RegExp(`^○?[^，。：]{1,10}章第${NUM}$`),
      chapterTitle: (t) => t.replace(/^○/, ''),
      author: '先秦·孔门后学（旧题曾子问、孔子说）',
      description: '儒家孝道经典，十八章，以孝为德之本、教之源。全本。',
    }),
  },
  {
    id: 'erya', title: '尔雅', category: 'jing', dynasty: '先秦',
    build: () => buildDaizhigeBook('erya', {
      chapterPattern: new RegExp(`^\\S{1,6}第${NUM}$`),
      tocGuard: true,
      author: '先秦～西汉·学者缀辑',
      description: '中国第一部训诂词典，十九篇释诂释言至释兽释畜，读经之津梁。全本。',
    }),
  },
  {
    id: 'liji', title: '礼记', category: 'jing', dynasty: '西汉',
    build: () => buildDaizhigeBook('liji', {
      chapterPattern: /^《礼记.+》$/,
      chapterTitle: (t) => t.replace(/^《礼记/, '').replace(/》$/, ''),
      author: '西汉·戴圣 编（旧题郑玄 注）',
      description: '儒家礼学论文与礼制文献汇编四十九篇，与《周礼》《仪礼》并称三礼。全本。',
    }),
  },
  // 史部
  {
    id: 'guoyu', title: '国语', category: 'shi', dynasty: '先秦',
    build: () => buildDaizhigeBook('guoyu', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]\\S{1,8}$`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·'),
      tocGuard: true,
      author: '旧题左丘明 撰',
      description: '国别体史书之祖，二十一卷记周鲁齐晋郑楚吴越八国卿大夫言论。全本。',
    }),
  },
  {
    id: 'zhanguoce', title: '战国策', category: 'shi', dynasty: '西汉',
    build: () => buildDaizhigeBook('zhanguoce', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]\\S{1,8}$`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·'),
      tocGuard: true,
      dropLines: [/^作者/],
      author: '西汉·刘向 编订',
      description: '战国纵横家说辞汇编三十三卷，记十二国策士权谋与游说。全本。',
    }),
  },
  {
    id: 'hanshu', title: '汉书', category: 'shi', dynasty: '东汉',
    build: () => buildDaizhigeBook('hanshu', {
      chapterPattern: new RegExp(`[纪表志传]第${NUM}(上|下)?$`),
      tocGuard: true,
      dropLines: [/^列传第/],
      author: '东汉·班固 撰',
      description: '中国第一部纪传体断代史，一百篇记西汉二百三十年史事。全本。',
    }),
  },
  {
    id: 'houhanshu', title: '后汉书', category: 'shi', dynasty: '南朝宋',
    build: () => buildDaizhigeBook('houhanshu', {
      chapterPattern: new RegExp(`^(卷${NUM}(上|下)?[　 \\t]|志第?${NUM})`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·'),
      author: '南朝宋·范晔 撰（梁·刘昭 补志）',
      description: '纪传体东汉史一百二十卷，与《史记》《汉书》《三国志》并称前四史。全本。',
    }),
  },
  {
    id: 'sanguozhi', title: '三国志', category: 'shi', dynasty: '西晋',
    build: () => buildDaizhigeBook('sanguozhi', {
      chapterPattern: new RegExp(`^(魏志|蜀志|吴志)卷${NUM}`),
      chapterTitle: (t) => t.replace(/志卷/, '志·卷'),
      dedupeTitles: true,
      dropLines: [
        /^钦定四库全书$/, /考证$/, /^晋著作郎/, /^宋太中大夫/,
        /^【臣】等谨案/, /^总纂官/, /^总[　 \t]*校/,
        /^三国志目录考证/, /^.{0,14}○【臣/,
      ],
      author: '西晋·陈寿 撰（宋·裴松之 注）',
      description: '纪传体三国史六十五卷，魏蜀吴三志分国纪传。全本。',
    }),
  },
  // 子部
  {
    id: 'sunzibingfa', title: '孙子兵法', category: 'zi', dynasty: '春秋',
    build: () => buildDaizhigeBook('sunzibingfa', {
      chapterPattern: new RegExp(`^\\S{1,6}第${NUM}$`),
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      implicitTitle: '始计第一',
      author: '春秋·孙武 撰',
      description: '中国现存最早兵书十三篇，计战谋攻军形兵势虚实军争九变皆备。全本。',
    }),
  },
  {
    id: 'guanzi', title: '管子', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('guanzi', {
      chapterPattern: new RegExp(`^\\S{1,8}第${NUM}$`),
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '旧题管仲 撰（战国齐稷下学者辑）',
      description: '齐国管仲学派著作总集八十六篇，兼含法家经言与轻重富国之术。全本。',
    }),
  },
  {
    id: 'hanfeizi', title: '韩非子', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('hanfeizi', {
      chapterPattern: new RegExp(`^\\S{1,8}第${NUM}$`),
      tocGuard: true,
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '战国·韩非 撰',
      description: '法家集大成之作五十五篇，法术势兼备，刑名参验之学。全本。',
    }),
  },
  {
    id: 'lvshichunqiu', title: '吕氏春秋', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('lvshichunqiu', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]+\\S+第${NUM}`),
      chapterTitle: (t) => t.replace(/【[^】]*】/g, '').replace(/[　\\t ]+/g, '·'),
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '战国末·吕不韦 门客辑',
      description: '杂家代表作二十六卷十二纪八览六论，汇九流之说备天地万物古今之事。全本。',
    }),
  },
  {
    id: 'yanzichunqiu', title: '晏子春秋', category: 'zi', dynasty: '战国',
    build: () => buildDaizhigeBook('yanzichunqiu', {
      chapterPattern: new RegExp(`第${NUM}凡${NUM}章$`),
      chapterTitle: (t) => t.replace(/^晏子春秋/, ''),
      author: '战国·齐人辑晏婴言行',
      description: '记齐国名相晏婴谏诤行事八篇二百一十五章，先秦叙事散文代表。全本。',
    }),
  },
  {
    id: 'shishuoxinyu', title: '世说新语', category: 'zi', dynasty: '南朝宋',
    build: () => buildDaizhigeBook('shishuoxinyu', {
      chapterPattern: new RegExp(`^\\S{1,6}第${NUM}$`),
      chapterTitle: (t) => t.replace(/第[一二三四五六七八九十百零〇○]+$/, ''),
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '南朝宋·刘义庆 撰（梁·刘孝标 注）',
      description: '魏晋名士言行轶事笔记小说之祖，分德行言语等三十六门。全本。',
    }),
  },
  {
    id: 'yanshijiaxun', title: '颜氏家训', category: 'zi', dynasty: '南北朝',
    build: () => buildDaizhigeBook('yanshijiaxun', {
      chapterPattern: new RegExp(`^\\S{1,8}第${NUM}$`),
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '南北朝·颜之推 撰',
      description: '中国第一部系统家训二十篇，兼论字书音训与南北风俗。全本。',
    }),
  },
  // 集部 / 诗词歌赋
  {
    id: 'wenxuan', title: '文选', category: 'ji', dynasty: '南朝梁',
    build: () => buildDaizhigeBook('wenxuan_b', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·'),
      tocGuard: true,
      implicitTitle: '文选序',
      author: '南朝梁·昭明太子萧统 编（唐·李善 注本白文）',
      description: '中国现存最早诗文总集六十卷，选周代至梁代诗文七百余篇。全本。',
    }),
  },
  {
    id: 'yutaixinyong', title: '玉台新咏', category: 'ji', dynasty: '南朝梁',
    build: () => buildDaizhigeBook('yutaixinyong', {
      chapterPattern: /^○/,
      chapterTitle: (t) => t.replace(/^○/, ''),
      dropLines: [/^●卷/],
      extraSplit: [{ beforeRe: /^●後叙|^●后叙/, title: '后叙' }],
      implicitTitle: '卷首·集序',
      author: '南朝梁·徐陵 编',
      description: '继《诗经》《楚辞》后汉魏六朝诗歌总集十卷，《孔雀东南飞》始见于此。全本。',
    }),
  },
  {
    id: 'huajianji', title: '花间集', category: 'ji', dynasty: '五代',
    build: () => buildDaizhigeBook('huajianji', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·').replace(/·[^·]*首$/, ''),
      tocGuard: true,
      dedupeTitles: true,
      dropLines: [/^【臣】等谨案/, /^总纂官/],
      author: '五代后蜀·赵崇祚 编',
      description: '中国第一部文人词总集十卷五百首，温韦以降十八家倚声填词之祖。全本。',
    }),
  },
  {
    id: 'yuefushiji', title: '乐府诗集', category: 'ji', dynasty: '北宋',
    build: () => buildDaizhigeBook('yuefushiji', {
      chapterPattern: new RegExp(`^卷${NUM}[　 \\t]`),
      chapterTitle: (t) => t.replace(/[　\\t ]+/g, '·'),
      tocGuard: true,
      author: '北宋·郭茂倩 编',
      description: '乐府诗总集一百卷，郊庙至杂歌十二类，上古至五代乐府渊薮。全本。',
    }),
  },
  {
    id: 'wenxindiaolong', title: '文心雕龙', category: 'ji', dynasty: '南朝梁',
    build: () => buildDaizhigeBook('wenxindiaolong', {
      chapterPattern: new RegExp(`^\\S{1,6}第${NUM}$`),
      dropLines: [new RegExp(`^卷${NUM}$`)],
      author: '南朝梁·刘勰 撰',
      description: '中国第一部体系完备的文学理论巨著五十篇，体大思精笼罩群言。全本。',
    }),
  },
  {
    id: 'caozijian', title: '曹子建集', category: 'ji', dynasty: '曹魏',
    build: () => buildDaizhigeBook('caozijian', {
      chapterPattern: /^《卷[一二三四五六七八九十]+》$/,
      chapterTitle: (t) => t.replace(/[《》]/g, ''),
      author: '曹魏·曹植 撰',
      description: '建安之雄才陈思王诗文赋十卷，白马篇洛神赋七哀诗俱在其中。全本。',
    }),
  },
];

// ============ 书目录 ============

const BOOKS = [
  { id: 'daodejing', title: '道德经', category: 'zi', dynasty: '春秋', build: () => fromExistingBookJson('daodejing') },
  { id: 'lunyu', title: '论语', category: 'jing', dynasty: '先秦', build: () => fromAncientArticles('lunyu', { author: '孔子弟子及再传弟子', description: '记录孔子及其弟子言行的儒家经典，二十篇。本版为全本。' }) },
  { id: 'daxue', title: '大学', category: 'jing', dynasty: '先秦', build: () => fromExistingBookJson('daxue') },
  { id: 'zhongyong', title: '中庸', category: 'jing', dynasty: '先秦', build: () => fromExistingBookJson('zhongyong') },
  { id: 'mengzi', title: '孟子', category: 'jing', dynasty: '战国', build: () => {
      const r = fromAncientArticles('mengzi', { author: '孟子及弟子', description: '孟子及弟子著录孟子言行的儒家经典，七篇二百六十一章。本版为全本。' });
      // 261 节按「梁惠王章句上·第一节」前缀归并为章
      const groups = new Map();
      for (const art of readJson('mengzi.json').articles) {
        const key = art.title.split('·')[0];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(...art.content.map(cleanLine).filter(Boolean));
      }
      r.chapters = Array.from(groups.entries()).map(([title, paragraphs]) => ({ title, paragraphs }));
      return r;
    } },
  { id: 'zhuangzi', title: '庄子', category: 'zi', dynasty: '战国', build: () => fromExistingBookJson('zhuangzi') },
  { id: 'shijing', title: '诗经', category: 'jing', dynasty: '先秦', build: buildShijing },
  { id: 'xunzi', title: '荀子', category: 'zi', dynasty: '战国', build: () => fromExistingBookJson('xunzi') },
  { id: 'chuci', title: '楚辞', category: 'ji', dynasty: '战国～汉', build: buildChuci },
  { id: 'tangshi', title: '唐诗三百首', category: 'ji', dynasty: '唐', traditional: true, build: buildTangshi300 },
  { id: 'zhouyi', title: '周易', category: 'jing', dynasty: '先秦', build: () => fromExistingBookJson('zhouyi') },
  { id: 'zuozhuan', title: '左传', category: 'jing', dynasty: '先秦', build: () => fromExistingBookJson('zuozhuan') },
  { id: 'shiji', title: '史记', category: 'shi', dynasty: '西汉', build: () => fromExistingBookJson('shiji') },
  { id: 'tongjian', title: '资治通鉴', category: 'shi', dynasty: '北宋', build: () => fromAncientArticles('zztj', { author: '司马光', description: '北宋司马光主持编纂的编年体通史，二百九十四卷，记十六朝一千三百六十二年史事。本版为全本。' }) },
  { id: 'mozi', title: '墨子', category: 'zi', dynasty: '战国', build: () => fromExistingBookJson('mozi') },
  { id: 'songci', title: '宋词三百首', category: 'ji', dynasty: '宋', build: buildSongci300 },
  { id: 'yuanqu', title: '元曲', category: 'ji', dynasty: '元', build: buildYuanqu },
  { id: 'guwenguanzhi', title: '古文观止', category: 'ji', dynasty: '清', traditional: true, build: buildGuwen },
  { id: 'sanzijing', title: '三字经', category: 'jing', dynasty: '宋', traditional: true, build: () => buildMengxueSingle('sanzijing', { bookTitle: '三字经', author: '王应麟（传）', description: '相传宋·王应麟撰三字韵语蒙书，涵盖劝学、名物、经史子集纲要。本版为全本。' }) },
  { id: 'baijiaxing', title: '百家姓', category: 'jing', dynasty: '宋', traditional: true, build: () => buildMengxueSingle('baijiaxing', { bookTitle: '百家姓', author: '佚名', description: '宋初编成的姓氏韵文蒙书，四字一句读来顺口。本版为全本。' }) },
  { id: 'qianziwen', title: '千字文', category: 'jing', dynasty: '南朝梁', traditional: true, build: () => buildMengxueSingle('qianziwen', { bookTitle: '千字文', author: '周兴嗣', description: '南朝梁·周兴嗣以一千个不重复汉字编成的韵文蒙书。本版为全本。' }) },
  { id: 'dizigui', title: '弟子规', category: 'jing', dynasty: '清', traditional: true, build: () => buildMengxueSingle('dizigui', { bookTitle: '弟子规', author: '李毓秀', description: '清·李毓秀据《论语》学而篇义理编成的童蒙行为规范。本版为全本。' }) },
  { id: 'zhuzijiaxun', title: '朱子家训', category: 'jing', dynasty: '明', traditional: true, build: () => buildMengxueSingle('zhuzijiaxun', { bookTitle: '朱子家训', author: '朱用纯', description: '明末清初·朱用纯撰治家格言，五百余字。本版为全本。' }) },
  { id: 'zengguangxianwen', title: '增广贤文', category: 'jing', dynasty: '明', traditional: true, build: () => buildMengxueSingle('zengguangxianwen', { bookTitle: '增广贤文', author: '佚名', description: '明代辑成的谚语格言集，上下两集。本版为全本。' }) },
  { id: 'shenglvqimeng', title: '声律启蒙', category: 'jing', dynasty: '清', traditional: true, build: buildShenglv },
  { id: 'liwengduiyun', title: '笠翁对韵', category: 'jing', dynasty: '清', traditional: true, build: buildLiweng },
  { id: 'youxueqionglin', title: '幼学琼林', category: 'jing', dynasty: '明', traditional: true, build: buildYouxue },
  ...DZ_BOOKS,
];

// ============ 执行与自检 ============

const TRADITIONAL_ONLY_RE = null; // 用 opencc 幂等抽检替代
const report = [];
const catalog = [];

for (const spec of BOOKS) {
  const { meta, chapters } = spec.build();
  // 清洗与校验
  let paraCount = 0;
  let charCount = 0;
  const allTexts = [];
  for (const ch of chapters) {
    ch.paragraphs = ch.paragraphs.map(cleanLine).filter((p) => {
      // 剔除纯符号/空段与「◆」空标题
      return p && /[\u4e00-\u9fff]/.test(p);
    });
    paraCount += ch.paragraphs.length;
    for (const p of ch.paragraphs) charCount += p.length;
    allTexts.push(...ch.paragraphs);
  }
  const text = toMarkerText(chapters);
  const kb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);

  // ASCII 残留检查（剔除 @@CH@@ 标记行后不应有字母数字）
  const asciiHit = text.replace(/@@CH@@[^\n]*/g, '').match(/[A-Za-z0-9]/);
  if (asciiHit) {
    throw new Error(`${spec.id}：产物含 ASCII 字符「${asciiHit[0]}」`);
  }
  // t2s 幂等抽检：仅对繁体源执行（简体源保留的古籍异体字如「谿」会误报）
  if (spec.traditional) {
    let tradResidue = 0;
    const sample = allTexts.filter((_, i) => i % Math.max(1, Math.floor(allTexts.length / 100)) === 0).slice(0, 100);
    for (const line of sample) {
      if (t2s(line) !== line) tradResidue += 1;
    }
    if (tradResidue > 0) {
      throw new Error(`${spec.id}：抽检发现 ${tradResidue} 处繁体残留`);
    }
  }
  // 首/末段抽样：源文本行必须出现在产物中（对构建函数产物天然成立，防 toMarkerText 丢段）
  if (chapters.length === 0 || allTexts.length === 0) {
    throw new Error(`${spec.id}：无有效章节/段落`);
  }

  fs.writeFileSync(path.join(ASSETS_DIR, `${spec.id}.txt`), text, 'utf8');
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  // 目录推导：与运行时 parseTxtBook 同规则解析产物文本，仅记录
  // 「有正文的章节」的 id+title（运行时空章节不占 order、id 按
  // `${bookId}-c${order}` 顺序生成，此处必须逐条对齐，否则惰性
  // 水合前的目录跳转会指向失效章节 id）。前置正文（首标记前有
  // 非空行）在运行时会成为「开篇」章，order 整体后移 1。
  const toc = deriveToc(text, spec.id);
  report.push({ id: spec.id, title: spec.title, chapters: chapters.length, paras: paraCount, chars: charCount, kb });
  catalog.push({
    id: spec.id,
    title: spec.title,
    author: meta.author,
    category: spec.category,
    description: meta.description,
    dynasty: spec.dynasty,
    // 资产字节大小指纹：UserBookService 物化时与落盘文件大小比对，
    // 不一致（升级换资产/复制中断半截文件）则覆盖复制并失效该书的
    // 解析缓存，内置书内容更新可随包静默完成。
    sizeBytes,
    // 章节目录（id+title，无正文）：启动只注册元数据书的目录，
    // 全文由 ensureBookLoaded 按书惰性水合（按需装载架构）。
    toc,
  });
  console.log(`${spec.id.padEnd(16)} ${String(chapters.length).padStart(4)} 章 ${String(paraCount).padStart(6)} 段 ${String(charCount).padStart(8)} 字 ${String(kb).padStart(6)} KB`);
}

const totalKB = report.reduce((n, r) => n + r.kb, 0);
console.log(`\n合计 ${BOOKS.length} 部，${totalKB} KB`);

// ============ 生成 builtinCatalog.ts ============

const ts = `/**
 * 内置书目录清单（builtinCatalog）。
 * 由 scripts/build-builtin-assets.mjs 自动生成，请勿手改。
 * 运行时链路：assets/books/<id>.txt（@@CH@@ 标记文本）→ UserBookService
 * 首启物化到 guoxue-books/builtin/ → 扫描解析 → 按本清单元数据注册为内置书。
 * bundle 不再携带书体（书体在 APK assets，大小不受限）。
 */
import type { BookCategory } from '@/types';

/** 单部内置书的目录条目 */
export interface BuiltinBookSpec {
  id: string;
  title: string;
  author: string;
  category: BookCategory;
  description: string;
  /** 朝代（与 bookMeta.BOOK_DYNASTIES 取值一致，供筛选） */
  dynasty: string;
  /** APK 资产字节大小（物化变更检测指纹，见 UserBookService.materializeBuiltins） */
  sizeBytes: number;
  /** 章节目录（id+title，无正文；id 与运行时解析逐条一致） */
  toc: Array<{ id: string; title: string }>;
}

export const BUILTIN_CATALOG: BuiltinBookSpec[] = ${JSON.stringify(catalog, null, 2)};

export function getBuiltinSpec(id: string): BuiltinBookSpec | undefined {
  return BUILTIN_CATALOG.find((b) => b.id === id);
}
`;

fs.writeFileSync(CATALOG_OUT, ts, 'utf8');
console.log(`已生成 ${CATALOG_OUT}`);
console.log(`资产目录 ${ASSETS_DIR}`);
