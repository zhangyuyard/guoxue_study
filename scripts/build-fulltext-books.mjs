#!/usr/bin/env node
/**
 * build-fulltext-books.mjs
 * 把内置经典从「选本」升级为「全本」：读取 /tmp/ancient/ 下的开源全文源数据，
 * 转换为现有 Book JSON schema（src/types/index.ts），覆盖写入 src/data/texts/*.json。
 *
 * 数据源：
 * - hanzhaodeng/chinese-ancient-text（master）：{ name, description, articles: [{ title, content: string[] }] }
 *   用于：周易、论语、孟子、庄子、史记、左传、荀子
 * - chinese-poetry/chinese-poetry（诗经/楚辞目录）：[{ title, chapter, section, content: string[] }]（楚辞另有 author）
 * - garychowcmu/daizhigev20（子藏/诸子/墨子.txt）：纯文本，卷/篇（「某第N」）/段落结构
 *
 * 产物 schema（与现有文件完全一致）：
 *   Book:     { id, title, author, category, description, chapters }
 *   Chapter:  { id, bookId, title, order, segments }
 *   Segment:  { id, chapterId, order, text }
 *
 * 完整性自检：
 * - 每部书章数与源 articles 数（或分组数）一致
 * - 抽首/中/末 3 处：源 content 文本必须逐条出现在产物段落中
 * - 输出每部书章数 / 段落数 / 字数 / KB
 *
 * 用法：node scripts/build-fulltext-books.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 源数据目录（curl 预先下载） */
const SRC_DIR = process.env.SRC_DIR || '/tmp/ancient';
/** 输出目录 */
const OUT_DIR = path.join(ROOT, 'src', 'data', 'texts');

/** 中文数字（章节标题「第N」用） */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 阿拉伯序数（1 起）转中文数字（支持到 999，足够覆盖各书章数） */
function toCnNum(n) {
  if (n <= 10) return CN_NUM[n];
  if (n < 20) return '十' + CN_NUM[n - 10];
  if (n === 20) return '二十';
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return CN_NUM[tens] + '十' + (ones > 0 ? CN_NUM[ones] : '');
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return CN_NUM[hundreds] + '百' + (rest > 0 ? toCnNum(rest) : '');
}

/** 两位/三位序号补零（章节 id 用） */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * 精简数据源 description 到 100 字内，并注明「全本」。
 * @param {string} raw 源自带介绍（可空）
 * @param {string} fallback 源无介绍时的兜底文案
 */
function buildDescription(raw, fallback) {
  let base = (raw || '').replace(/\s+/g, '').trim();
  if (!base) base = fallback;
  const suffix = '本版为全本。';
  if (base.length > 100 - suffix.length) {
    base = base.slice(0, 100 - suffix.length - 1) + '…';
  }
  return base + suffix;
}

// ============ 源数据清洗 ============

/**
 * 定点替换：源数据的合成字记号 / 扩展区生僻字 → 通行写法（无法确认者以 □ 占位）。
 * - 周易·困卦「臲<臬兀>」→ 通行「臲卼」
 * - 史记「{单心}狐」→「惮狐」、「{艹闾}」→「䕡」、「{此鱼}」→「鮆」（合成字记号）
 * - 庄子·大宗师 𤴯→疣（决疣溃痈）、𨇤→跹（通行简体「跰跹」）
 */
const CHAR_FIXES = new Map([
  ['臲<臬兀>', '臲卼'],
  ['{轻金}', '□'],
  ['{山乙}', '□'],
  ['{单心}', '惮'],
  ['{艹闾}', '䕡'],
  ['{此鱼}', '鮆'],
  ['\u{24D2F}', '疣'],
  ['\u{281E4}', '跹'],
]);

/**
 * 清洗单行正文：
 * 1. 定点替换合成字/生僻字记号；2. 去注音括号（如「中潏(yù)」）；
 * 3. 去页码杂质（如「?102?」）；4. 校勘括注 [x] → x；5. 去残余记号与 ASCII 字符；
 * 6. 去全部空白（源数据中的空格/全角空格为排版产物）。
 * @param {string} s 原始行文本
 */
function cleanLine(s) {
  let t = s;
  for (const [pat, rep] of CHAR_FIXES) {
    t = t.split(pat).join(rep);
  }
  t = t.replace(/\([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǘǚǜ\s]+\)/g, '');
  t = t.replace(/\?\d*\?/g, '');
  t = t.replace(/\[([^[\]]*)\]/g, '$1');
  t = t.replace(/[<>{}[\]\\|]/g, '');
  t = t.replace(/[A-Za-z0-9]/g, '');
  t = t.replace(/[\s\u3000]+/g, '');
  return t;
}

/**
 * 通用转换：articles 逐篇一章，content 逐条一段。
 * @param {object} opts
 * @param {string} opts.bookId 书籍 id（不动）
 * @param {string[]} opts.sourceLines 源 content 文本（用于自检）
 * @param {Array<{title: string, content: string[]}>} opts.articles 源篇目
 * @param {(i: number, article: object) => {id: string, title: string}} opts.chapterNamer 章节命名器
 * @param {string} opts.author 作者（沿用现值）
 * @param {string} opts.category 分类（沿用现值）
 * @param {string} opts.title 书名（去「（选）」后）
 * @param {string} opts.description 简介（≤100 字，注明全本）
 * @param {number} [opts.mergeMinChars] 把相邻短行合并为自然段的阈值（仅大部头史书使用；
 *   源 content 行常为显示换行而非语义段落，合并可显著降低 JSON 结构开销）
 */
function articlesToBook({ bookId, articles, chapterNamer, author, category, title, description, mergeMinChars = 0 }) {
  const chapters = articles.map((article, i) => {
    const { id: chapterId, title: chapterTitle } = chapterNamer(i + 1, article);
    const lines = (article.content || []).map((s) => cleanLine(String(s))).filter((s) => s.length > 0);
    const mergedLines = [];
    if (mergeMinChars > 0) {
      // 相邻短行累计合并到 mergeMinChars 以上，避免碎片段落
      let buf = '';
      for (const line of lines) {
        buf = buf ? buf + line : line;
        if (buf.length >= mergeMinChars) {
          mergedLines.push(buf);
          buf = '';
        }
      }
      if (buf) mergedLines.push(buf);
    } else {
      mergedLines.push(...lines);
    }
    const segments = mergedLines.map((text, j) => ({
      id: `${chapterId}-${j + 1}`,
      chapterId,
      order: j + 1,
      text,
    }));
    return { id: chapterId, bookId, title: chapterTitle, order: i + 1, segments };
  });
  return { id: bookId, title, author, category, description, chapters };
}

// ============ 各书章节命名器（id 规则与现有一致：书id-拼音 或 书id-序号） ============
// 默认命名器：书id-两位序号（周易/庄子等章名拼音过长或无拼音映射需求的书）

/** 论语：20 篇拼音 id（前 4 篇与现有 id 完全一致），标题「学而第一」式 */
const LUNYU_PINYIN = [
  'xueer', 'weizheng', 'bayi', 'liren', 'gongye-chang', 'yongye', 'shuer',
  'taibo', 'zihan', 'xiangdang', 'xianjin', 'yanyuan', 'zilu', 'xianwen',
  'weiling-gong', 'jishi', 'yanghuo', 'weizi', 'zizhang', 'yaoyue',
];
function lunyuNamer(i, article) {
  const name = String(article.title).replace(/篇$/, '');
  return { id: `lunyu-${LUNYU_PINYIN[i - 1] ?? pad(i, 2)}`, title: `${name}第${toCnNum(i)}` };
}

/** 孟子：261 节按「某章句上/下」聚合为 14 章（与现有 5 章粒度一致），拼音 id */
const MENZI_GROUPS = {
  梁惠王章句上: { title: '梁惠王上', pinyin: 'liang-hui-wang-shang' },
  梁惠王章句下: { title: '梁惠王下', pinyin: 'liang-hui-wang-xia' },
  公孙丑章句上: { title: '公孙丑上', pinyin: 'gong-sun-chou-shang' },
  公孙丑章句下: { title: '公孙丑下', pinyin: 'gong-sun-chou-xia' },
  滕文公章句上: { title: '滕文公上', pinyin: 'teng-wen-gong-shang' },
  滕文公章句下: { title: '滕文公下', pinyin: 'teng-wen-gong-xia' },
  离娄章句上: { title: '离娄上', pinyin: 'li-lou-shang' },
  离娄章句下: { title: '离娄下', pinyin: 'li-lou-xia' },
  万章章句上: { title: '万章上', pinyin: 'wan-zhang-shang' },
  万章章句下: { title: '万章下', pinyin: 'wan-zhang-xia' },
  告子章句上: { title: '告子上', pinyin: 'gao-zi-shang' },
  告子章句下: { title: '告子下', pinyin: 'gao-zi-xia' },
  尽心章句上: { title: '尽心上', pinyin: 'jin-xin-shang' },
  尽心章句下: { title: '尽心下', pinyin: 'jin-xin-xia' },
};
function mengziToArticles(rawArticles) {
  const groups = []; // 有序分组
  const byKey = new Map();
  for (const article of rawArticles) {
    const key = String(article.title).split('·')[0];
    if (!MENZI_GROUPS[key]) {
      throw new Error(`孟子：未知分组「${key}」（源篇目：${article.title}）`);
    }
    if (!byKey.has(key)) {
      byKey.set(key, { title: key, content: [] });
      groups.push(byKey.get(key));
    }
    byKey.get(key).content.push(...article.content.map((s) => String(s).trim()).filter(Boolean));
  }
  return groups;
}
function mengziNamer(i, article) {
  const meta = MENZI_GROUPS[article.title];
  return { id: `mengzi-${meta.pinyin}`, title: meta.title };
}

/** 序号命名器（庄子/史记/左传/荀子/诗经/楚辞等，章数多或篇名拼音过长时用） */
function makeIndexNamer(bookId, width, titleFn) {
  return (i, article) => ({
    id: `${bookId}-${pad(i, width)}`,
    title: titleFn ? titleFn(article, i) : article.title,
  });
}

/** 诗经标题：「国风·周南·关雎」式（与现有命名一致） */
function shijingTitle(article) {
  const a = article;
  return [a.chapter, a.section, a.title].filter(Boolean).join('·');
}

/** 楚辞标题：独立篇（section 与 title 相同）用 title，否则「九歌·东皇太一」式 */
function chuciTitle(article) {
  return article.section && article.section !== article.title
    ? `${article.section}·${article.title}`
    : article.title;
}

/**
 * 墨子（daizhige 纯文本）：解析 卷/篇（「亲士第一」）/段落 结构为 articles。
 * 特殊处理：
 * - 篇名与首段可能粘在同一行（如「节用中第二十一子墨子言曰：…」）
 * - 亡佚篇目（节用下、节葬上/中、非乐中/下 等）只有篇名无正文 → 跳过并记录
 * - 正文中的「----」分隔线丢弃
 * @param {string} text 原文全文
 * @returns {Array<{title: string, content: string[]}>}
 */
function parseMoziText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u3000 \t]+/g, '').trim())
    .filter((l) => l.length > 0 && !/^[-—─=_*0-9\s]+$/.test(l));
  const articles = [];
  const skipped = [];
  // 篇名行：形如「亲士第一」「经说上第四十二」，标题段 ≤12 字、无标点，
  // 也可与首段粘连（标题段后紧跟正文）
  const chapterRe = /^(.{1,12}第[一二三四五六七八九十百]+)(.*)$/;
  for (const line of lines) {
    if (line === '墨子') continue; // 书名头
    if (/^卷[一二三四五六七八九十]+$/.test(line)) continue; // 卷标记
    const m = line.match(chapterRe);
    if (m && !/[，。；：！？、《》（）「」『』""'']/.test(m[1])) {
      const title = m[1].replace(/第[一二三四五六七八九十百]+$/, '');
      const rest = m[2].trim();
      articles.push({ title, content: rest ? [rest] : [] });
      continue;
    }
    if (articles.length === 0) {
      throw new Error(`墨子：篇名前出现正文行「${line.slice(0, 20)}」`);
    }
    const cleaned = cleanLine(line);
    if (cleaned.length > 0) {
      articles[articles.length - 1].content.push(cleaned);
    }
  }
  // 丢掉亡佚（无正文）的篇目，仅保留有内容者
  const kept = [];
  for (const a of articles) {
    if (a.content.length === 0) {
      skipped.push(a.title);
    } else {
      kept.push(a);
    }
  }
  if (skipped.length > 0) {
    console.warn(`[mozi] 跳过亡佚篇目（源仅存篇名）：${skipped.join('、')}`);
  }
  if (kept.length === 0) {
    throw new Error('墨子：未解析出任何有效篇目');
  }
  return kept;
}

// ============ 书目配置 ============

/**
 * 每部书：id（不动）、源文件、保留 author/category（读现有 JSON）、
 * 标题去「（选）」、描述取源介绍精简并注明全本、章节命名器、可选 articles 预处理。
 */
const BOOK_JOBS = [
  // —— 优先级 1：周易（全本）——
  {
    bookId: 'zhouyi',
    sourceFile: 'zhouyi.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '群经之首，占筮与哲理合一的经典，含六十四卦卦爻辞。',
  },
  // —— 优先级 2：左传（全本；大部头，短行合并为自然段控制体积）——
  {
    bookId: 'zuozhuan',
    sourceFile: 'zuozhuan.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '相传左丘明作，编年为《春秋》传，记春秋二百余年史事。',
    namer: makeIndexNamer('zuozhuan', 3),
    mergeMinChars: 80,
  },
  // —— 优先级 3：墨子（全本；daizhige 纯文本源）——
  {
    bookId: 'mozi',
    sourceFile: 'mozi-dg.txt',
    sourceKind: 'daizhige-text',
    fallbackDesc: '墨家创始经典，墨翟及后学所著，主张兼爱、非攻、尚贤、节用。',
    namer: makeIndexNamer('mozi', 2),
  },
  // —— 优先级 4：史记（全本；大部头，短行合并为自然段控制体积）——
  {
    bookId: 'shiji',
    sourceFile: 'shiji.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '我国第一部纪传体通史，被鲁迅誉为「史家之绝唱，无韵之《离骚》」。',
    namer: makeIndexNamer('shiji', 3),
    mergeMinChars: 80,
  },
  // —— 优先级 5：庄子（全本，33 篇）——
  {
    bookId: 'zhuangzi',
    sourceFile: 'zhuangzi.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '庄周及后学所著，道家经典，想象瑰奇、文风恣肆。',
  },
  // —— 优先级 6：荀子（全本，32 篇）——
  {
    bookId: 'xunzi',
    sourceFile: 'xunzi.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '荀况所著，主张性恶、隆礼重法，先秦儒家集大成之作。',
    namer: makeIndexNamer('xunzi', 2),
  },
  // —— 优先级 7-10：预算允许时才升级为全本 ——
  {
    bookId: 'lunyu',
    sourceFile: 'lunyu.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '孔子及其弟子言行的记录，儒家最重要的经典之一。',
    namer: lunyuNamer,
  },
  {
    bookId: 'shijing',
    sourceFile: 'shijing-cp.json',
    sourceKind: 'poetry',
    fallbackDesc: '我国最早的诗歌总集，收西周至春秋诗篇三百零五篇，分风、雅、颂。',
    namer: makeIndexNamer('shijing', 3, shijingTitle),
  },
  {
    bookId: 'chuci',
    sourceFile: 'chuci-cp.json',
    sourceKind: 'poetry',
    fallbackDesc: '西汉刘向辑录的楚辞总集，以屈原作品为主，兼收宋玉及汉代拟作。',
    namer: makeIndexNamer('chuci', 3, chuciTitle),
  },
  {
    bookId: 'mengzi',
    sourceFile: 'mengzi.json',
    sourceKind: 'ancient-text',
    fallbackDesc: '孟子及弟子语录，阐扬仁政与性善之学。',
    preprocess: mengziToArticles,
    namer: mengziNamer,
  },
];

/** 读取源 articles（按 sourceKind 分派） */
function loadArticles(job) {
  const raw = fs.readFileSync(path.join(SRC_DIR, job.sourceFile), 'utf-8');
  if (job.sourceKind === 'ancient-text') {
    const data = JSON.parse(raw);
    return { articles: data.articles, description: data.description || '' };
  }
  if (job.sourceKind === 'poetry') {
    const data = JSON.parse(raw);
    return { articles: data, description: '' };
  }
  if (job.sourceKind === 'daizhige-text') {
    return { articles: parseMoziText(raw), description: '' };
  }
  throw new Error(`未知 sourceKind：${job.sourceKind}`);
}

/**
 * 自检：抽首/中/末 3 章比对源文本。
 * 每条源 content 行必须在对应章节的段落拼接文本中出现（兼容短行合并场景）。
 */
function spotCheck(book, sourceArticles) {
  const n = sourceArticles.length;
  const picks = [0, Math.floor(n / 2), n - 1];
  for (const idx of picks) {
    const chapter = book.chapters[idx];
    if (!chapter) throw new Error(`${book.id}: 缺少第 ${idx + 1} 章`);
    const joined = chapter.segments.map((s) => s.text).join('');
    for (const line of sourceArticles[idx].content) {
      const t = cleanLine(String(line));
      if (t && !joined.includes(t)) {
        throw new Error(
          `${book.id}: 第 ${idx + 1} 章《${chapter.title}》缺源片段「${t.slice(0, 30)}…」`,
        );
      }
    }
  }
}

/** 自检：结构合法性（id 唯一、order 连续、段落非空、字段齐全） */
function structuralCheck(book) {
  const seenCh = new Set();
  const seenSeg = new Set();
  book.chapters.forEach((ch, i) => {
    if (ch.order !== i + 1) throw new Error(`${book.id}: 章 order 不连续（${ch.title}）`);
    if (ch.bookId !== book.id) throw new Error(`${book.id}: 章 bookId 错误（${ch.id}）`);
    if (seenCh.has(ch.id)) throw new Error(`${book.id}: 章 id 重复（${ch.id}）`);
    seenCh.add(ch.id);
    if (!Array.isArray(ch.segments) || ch.segments.length === 0) {
      throw new Error(`${book.id}: 章无段落（${ch.title}）`);
    }
    ch.segments.forEach((seg, j) => {
      if (seg.order !== j + 1) throw new Error(`${book.id}: 段 order 不连续（${ch.id}）`);
      if (seg.chapterId !== ch.id) throw new Error(`${book.id}: 段 chapterId 错误（${seg.id}）`);
      if (!seg.text || seg.text.length === 0) throw new Error(`${book.id}: 空段落（${seg.id}）`);
      if (seenSeg.has(seg.id)) throw new Error(`${book.id}: 段 id 重复（${seg.id}）`);
      seenSeg.add(seg.id);
      if (/[A-Za-z0-9<>{}[\]\\|]/.test(seg.text)) {
        throw new Error(`${book.id}: 残留 ASCII/记号（${seg.id}: ${seg.text.slice(0, 20)}）`);
      }
      for (const ch of seg.text) {
        if (ch.codePointAt(0) > 0xffff) {
          throw new Error(`${book.id}: 扩展区字符（${seg.id}: ${seg.text.slice(0, 20)}）`);
        }
      }
    });
  });
  if (book.description.length > 100) {
    throw new Error(`${book.id}: description 超 100 字（${book.description.length}）`);
  }
}

// ============ 主流程 ============
// 处理顺序 = 全本化优先级（任务口径：超预算时优先保证 1-6 项）：
// 周易→左传→墨子→史记→庄子→荀子→论语→诗经→楚辞→孟子

/** 目录字节预算（4MB） */
const DIR_BUDGET_BYTES = 4 * 1024 * 1024;

const dirFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
let dirBytes = dirFiles.reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0);

const report = [];
const skippedBooks = [];

for (const job of BOOK_JOBS) {
  const outPath = path.join(OUT_DIR, `${job.bookId}.json`);
  const current = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const { articles: rawArticles, description } = loadArticles(job);
  const articles = job.preprocess ? job.preprocess(rawArticles) : rawArticles;

  const title = current.title.replace(/（选）$/, '');
  const book = articlesToBook({
    bookId: job.bookId,
    articles,
    chapterNamer: job.namer ?? makeIndexNamer(job.bookId, 2),
    author: current.author,
    category: current.category,
    title,
    description: buildDescription(description, job.fallbackDesc),
    mergeMinChars: job.mergeMinChars ?? 0,
  });

  // 完整性自检
  structuralCheck(book);
  spotCheck(book, articles);
  if (book.chapters.length !== articles.length) {
    throw new Error(`${book.id}: 章数 ${book.chapters.length} ≠ 源篇数 ${articles.length}`);
  }

  // 预算检查：替换后目录总量不得超预算，超了则保留现有选本
  const json = JSON.stringify(book);
  const newBytes = Buffer.byteLength(json, 'utf-8');
  const oldBytes = fs.statSync(outPath).size;
  const projected = dirBytes - oldBytes + newBytes;
  if (projected > DIR_BUDGET_BYTES) {
    skippedBooks.push(job.bookId);
    console.warn(
      `[skip] ${job.bookId}: 全本需 ${oldBytes > 0 ? '' : ''}${(newBytes / 1024).toFixed(1)} KB，` +
        `替换后目录将达 ${(projected / 1024).toFixed(1)} KB（超 4MB），保留现有选本。`,
    );
    continue;
  }

  fs.writeFileSync(outPath, json, 'utf-8');
  dirBytes = projected;

  const chars = book.chapters.reduce(
    (sum, ch) => sum + ch.segments.reduce((s, seg) => s + seg.text.length, 0),
    0,
  );
  report.push({
    bookId: job.bookId,
    chapters: book.chapters.length,
    segments: book.chapters.reduce((s, c) => s + c.segments.length, 0),
    chars,
    kb: newBytes / 1024,
  });
}

console.log('=== 全本化结果 ===');
for (const r of report) {
  console.log(
    `${r.bookId}: ${r.chapters} 章 / ${r.segments} 段 / ${r.chars} 字 / ${r.kb.toFixed(1)} KB`,
  );
}
if (skippedBooks.length > 0) {
  console.log(`因预算保留选本: ${skippedBooks.join('、')}（标题仍带「（选）」）`);
}
console.log(`texts 目录合计: ${(dirBytes / 1024).toFixed(1)} KB（预算 ≤ 4096 KB）`);
console.log('自检通过：章数与源一致、抽 3 处原文比对无误、结构合法。');
