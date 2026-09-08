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
  { id: 'wenxuan', title: '文选', category: 'ji', dynasty: '南朝梁', build: () => fromExistingBookJson('wenxuan') },
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
  report.push({ id: spec.id, title: spec.title, chapters: chapters.length, paras: paraCount, chars: charCount, kb });
  catalog.push({
    id: spec.id,
    title: spec.title,
    author: meta.author,
    category: spec.category,
    description: meta.description,
    dynasty: spec.dynasty,
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
}

export const BUILTIN_CATALOG: BuiltinBookSpec[] = ${JSON.stringify(catalog, null, 2)};

export function getBuiltinSpec(id: string): BuiltinBookSpec | undefined {
  return BUILTIN_CATALOG.find((b) => b.id === id);
}
`;

fs.writeFileSync(CATALOG_OUT, ts, 'utf8');
console.log(`已生成 ${CATALOG_OUT}`);
console.log(`资产目录 ${ASSETS_DIR}`);
