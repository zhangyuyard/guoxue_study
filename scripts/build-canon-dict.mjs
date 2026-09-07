#!/usr/bin/env node
/**
 * canon 校验库构建脚本（build-canon-dict.mjs）
 * 读取合规数据源（均已在 PRD 确认授权）生成只读 canon_dict.db：
 *   1. 北师大「通假字资源库」GitHub frederick-wang/tongjiazi-resources（MIT）
 *      —— corpus.zip（解压密码 BEIJING_NORMAL_UNIVERSITY）→ corpus.jsonl → tongjia_judgment
 *   2. chinese-poetry-md（MIT）每首 .md 的 `## 拼音` 段 → reading_selection（诗词语境读音）
 *   3. 本地可选种子 scripts/canon-seed.json（用户手动补充，不联网也可填充）
 *   4. 古今字种子 scripts/canon-seed-gujin.json（人工标注·据训诂常识，建议校对；
 *      type='gujin' 与 BNU 通假区分，verified=0）
 *
 * 产物：assets/dictionaries/canon_dict.db 与
 *       android/app/src/main/assets/dictionaries/canon_dict.db（字节级副本）。
 *
 * v3：tongjia_judgment / reading_selection 增加 context 语料例句列
 * （BNU「语料文本」100% 提供；本地种子从释义引文提取），主键扩为
 * (work_id, char, context)——同一篇同一字的多个通假用例共存，
 * 运行时按「用例级语境锚定」标注，杜绝「甲句通假、全篇误标」。
 *
 * 幂等性：先 DROP 再建，同输入产出一致。
 *
 * ★ 网络兜底：若沙箱无法下载（curl/fetch 被阻断/超时），脚本优雅降级，
 *   仍产出带正确 schema 的空 canon_dict.db，并在控制台明确提示
 *   「种子数据需在可联网环境运行本脚本填充」。绝对不伪造/编造任何通假结论或读音。
 *
 * ★ 版本互指：CANON_DICT_VERSION 必须与 src/services/CanonService.ts 的
 *   CANON_DICT_VERSION 一致（部署/升级比对依据）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import SQLite3 from 'better-sqlite3';

// better-sqlite3 CJS/ESM 互操作兜底
const Database = (SQLite3 && SQLite3.default) ? SQLite3.default : SQLite3;

// opencc-js（与 src/utils/conversion.ts 相同的 CJS 包）用于构建期字头归一化
const requireCjs = createRequire(import.meta.url);

/**
 * 与运行时一致的繁→简转换器（from:'tw' → to:'cn'，同 src/utils/conversion.ts）。
 * CanonService.getTongjia/getReading 查询前会把传入字做 toSimplified 归一化，
 * 因此库内 char 键也必须是同一归一化口径，否则如「輮」(U+8FAE) 会被 opencc
 * 转为「𫐓」(U+2B4D3) 查询，库内仍存「輮」则永远 miss（通假角标静默失效）。
 * 转换器加载失败时退化为恒等映射（不阻断构建，仅提示）。
 */
let tw2cn = null;
try {
  tw2cn = requireCjs('opencc-js').Converter({ from: 'tw', to: 'cn' });
} catch {
  console.warn('[build-canon] ⚠ opencc-js 加载失败，字头归一化退化为恒等映射');
}
function toSimplifiedKey(c) {
  if (!tw2cn || !c) return c;
  try {
    return tw2cn(c);
  } catch {
    return c;
  }
}

/** 脚本根目录（仓库内 guoxue_study_app/） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 输出路径（RN 通用 assets + Android 打包 assets） */
const OUTPUTS = [
  resolve(ROOT, 'assets/dictionaries/canon_dict.db'),
  resolve(ROOT, 'android/app/src/main/assets/dictionaries/canon_dict.db'),
];
/** 可选本地种子（不联网也能填充） */
const LOCAL_SEED = resolve(ROOT, 'scripts/canon-seed.json');
/** 古今字种子（人工标注，据训诂常识；构建期过滤到 10 部书正文实际出现借字的书） */
const GUJIN_SEED = resolve(ROOT, 'scripts/canon-seed-gujin.json');
/** 古今字行的判定源署名（弹窗展示 + 版权溯源） */
const SRC_GUJIN = '人工标注·据训诂常识（古今字），建议校对';

/** ★ 与 src/services/CanonService.ts 的 CANON_DICT_VERSION 互指（修改须同步 +1） */
const CANON_DICT_VERSION = 3;

/** 数据源署名常量（与架构 §4.1 一致） */
const SRC_BNU = '北师大通假字资源库';
const SRC_POETRY = 'chinese-poetry 开源诗词库';

/** DDL（按架构 T03 表结构；sources 存 JSON 字符串数组；type 区分通假/古今字；
 *  v3 起增加 context 语料例句列并把主键扩为 (work_id, char, context)——
 *  同一篇内同一字的多个通假用例共存，运行时按用例级语境锚定标注） */
const CREATE_TONGJIA = `
  CREATE TABLE IF NOT EXISTS tongjia_judgment (
    work_id  TEXT NOT NULL,
    char     TEXT NOT NULL,
    original TEXT,
    note     TEXT,
    sources  TEXT,
    verified INTEGER,
    type     TEXT NOT NULL DEFAULT 'tongjia',
    context  TEXT,
    PRIMARY KEY (work_id, char, context)
  );
  CREATE INDEX IF NOT EXISTS idx_tj_char ON tongjia_judgment(char);
  CREATE INDEX IF NOT EXISTS idx_tj_work ON tongjia_judgment(work_id);
`;
const CREATE_READING = `
  CREATE TABLE IF NOT EXISTS reading_selection (
    work_id  TEXT NOT NULL,
    char     TEXT NOT NULL,
    reading  TEXT,
    sources  TEXT,
    verified INTEGER,
    context  TEXT,
    PRIMARY KEY (work_id, char, context)
  );
  CREATE INDEX IF NOT EXISTS idx_rd_char ON reading_selection(char);
  CREATE INDEX IF NOT EXISTS idx_rd_work ON reading_selection(work_id);
`;

// ----------------------------- 例句提取（语境锚定 context 列） -----------------------------

/** 汉字判定（与 canonContext.ts 运行时口径一致：CJK 统一表意 + 扩展 A） */
function isHanChar(c) {
  const n = c.codePointAt(0);
  return n >= 0x3400 && n <= 0x9fff;
}

/** 统计字符串中的汉字数 */
function hanCount(s) {
  let n = 0;
  for (const c of String(s ?? '')) {
    if (isHanChar(c)) n += 1;
  }
  return n;
}

/**
 * 从释义文本提取语料例句（语境锚定 context）：
 * 取「含借字的最长引文」（兼容「」『』“”"" 等引号），引文汉字数 ≥3 才可信。
 * 用于本地种子（canon-seed.json / canon-seed-gujin.json）——BNU 语料自带
 * 「语料文本」字段无需提取。提取不到返回 null（该行无语境证据）。
 */
function extractContextFromNote(note, normChar) {
  if (!note) return null;
  const text = String(note);
  const quotes = [];
  const re = /[「『“"']([^」』”"']+)[」』”"']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    quotes.push(m[1]);
  }
  let best = null;
  for (const q of quotes) {
    if (!Array.from(q).includes(normChar)) continue;
    if (hanCount(q) < 3) continue;
    if (!best || hanCount(q) > hanCount(best)) best = q;
  }
  return best;
}

// ----------------------------- 网络辅助 -----------------------------

/** 统一走 curl（沙箱内 node fetch 无法访问 raw.githubusercontent，curl 可用） */

/** 带超时的文本下载（curl） */
async function fetchText(url, timeoutMs = 30000) {
  return execSync(`curl -s -m ${Math.ceil(timeoutMs / 1000)} -L "${url}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 下载二进制到 Buffer（curl 落临时文件后读取） */
async function fetchBuffer(url, timeoutMs = 60000) {
  const tmpFile = resolve(mkdtempSync(resolve(tmpdir(), 'dl-')), 'blob');
  execSync(`curl -s -m ${Math.ceil(timeoutMs / 1000)} -L -o "${tmpFile}" "${url}"`, {
    stdio: 'ignore',
    maxBuffer: 64 * 1024 * 1024,
  });
  const buf = readFileSync(tmpFile);
  rmSync(tmpFile, { force: true });
  return buf;
}

// ----------------------------- 字段解析辅助 -----------------------------

/** 从对象中取第一个命中的键（兼容不同字段命名） */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return String(obj[k]);
    }
  }
  return undefined;
}

const CHAR_KEYS = ['借字', '字', 'char', '通假字', '通假字字头', 'jiuzi'];
const ORIGINAL_KEYS = ['正字', '本字', '正字字头', 'original', 'zhengzi'];
const NOTE_KEYS = ['释义', '注释', '说明', 'note', 'shiyi'];
const SOURCE_KEYS = ['出处', '书名', 'source', 'work', 'chuji'];
const POS_KEYS = ['标注位置', 'position', 'pos'];
const TEXT_KEYS = ['语料文本', '文本', 'text', 'corpus'];
const PINYIN_KEYS = ['拼音', 'pinyin'];

/** 单个音节拼音校验（避免把整句拼音误当作单字读音写入）；
 *  同时兼容声调数字（mao4）与声调符号（mào）两种写法 */
function isSingleSyllable(py) {
  return /^[a-züvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/i.test(String(py).trim());
}

// ----------------------------- app 典籍键映射（BNU 出处 → app slug） -----------------------------
//
// CanonService 的三级查询直接用 app 的 chapterId / bookId slug（如 lunyu-xueer / lunyu）
// 作为 work_id 查询，而 BNU 语料的「出处」是中文书名（如《论语·学而》）。本映射在构建期
// 把 BNU 出处翻译成 app 可识别的 slug，使 canon 库对 app 直接可用；sources 列仍保留
// 具体出处字符串（「北师大通假字资源库·《论语·学而》」）以做版权溯源。
//
// 粒度的取舍：
//  - 论语：app 仅收录 4 章（学而/为政/八佾/里仁），按「章级」精确映射，避免把甲章的
//    通假误标到乙章；未收录的篇目（阳货/微子等）回落书级（lunyu），供未来扩展复用。
//  - 老子/道德经：BNU 按「道经/德经」分，app 的 81 章无法逐章对应，统一书级 daodejing。
//    例外：《老子·十六经·行守》实为马王堆帛书《十六经》（《黄帝四经》之一），
//    与《道德经》并非一书，按「宁缺毋滥」原则排除，绝不写入。
//  - 大学/中庸：BNU 为《礼记·大学》《礼记·中庸》单条，统一书级 daxue / zhongyong。
//  - 孟子/庄子/荀子/诗经/楚辞：与论语同策略 —— 章级精确映射优先，未收录篇目回落
//    书级（同一部典籍整体成立），无法确认属于该典籍的（如《孟子正义序》《庄子独见》）
//    直接丢弃，绝不把无关典籍的结论写进书。

/** 论语 20 篇名 → app chapterId（app 当前仅收录前 4 篇，其余映射用于未来扩展/书级兜底） */
const LUNYU_CHAPTERS = {
  学而: 'lunyu-xueer',
  为政: 'lunyu-weizheng',
  八佾: 'lunyu-bayi',
  里仁: 'lunyu-liren',
  公冶长: 'lunyu-gongyechang',
  雍也: 'lunyu-yongye',
  述而: 'lunyu-shuer',
  泰伯: 'lunyu-taibo',
  子罕: 'lunyu-zihan',
  乡党: 'lunyu-xiangdang',
  先进: 'lunyu-xianjin',
  颜渊: 'lunyu-yanyuan',
  子路: 'lunyu-zilu',
  宪问: 'lunyu-xianwen',
  卫灵公: 'lunyu-weilinggong',
  季氏: 'lunyu-jishi',
  阳货: 'lunyu-yanghuo',
  微子: 'lunyu-weizi',
  子张: 'lunyu-zizhang',
  尧曰: 'lunyu-yaoyue',
};

/** 孟子 app 收录篇名 → chapterId（未收录篇目如 离娄上/万章下 回落书级 mengzi） */
const MENGZI_CHAPTERS = {
  梁惠王上: 'mengzi-liang-hui-wang-shang',
  公孙丑上: 'mengzi-gong-sun-chou-shang',
  滕文公上: 'mengzi-teng-wen-gong-shang',
  告子上: 'mengzi-gao-zi-shang',
  尽心上: 'mengzi-jin-xin-shang',
};

/** 庄子内篇（app 收录七篇）→ chapterId（外杂篇 回落书级 zhuangzi） */
const ZHUANGZI_CHAPTERS = {
  逍遥游: 'zhuangzi-xiao-yao-you',
  齐物论: 'zhuangzi-qi-wu-lun',
  养生主: 'zhuangzi-yang-sheng-zhu',
  人间世: 'zhuangzi-ren-jian-shi',
  德充符: 'zhuangzi-de-chong-fu',
  大宗师: 'zhuangzi-da-zong-shi',
  应帝王: 'zhuangzi-ying-di-wang',
};

/** 荀子 app 收录篇名 → chapterId（其余篇目 回落书级 xunzi） */
const XUNZI_CHAPTERS = {
  劝学: 'xunzi-quan-xue',
  修身: 'xunzi-xiu-shen',
  不苟: 'xunzi-bu-gou',
  荣辱: 'xunzi-rong-ru',
};

/**
 * 诗经：BNU「部分·篇名」（如 周南·关雎 / 小雅·采薇）→ app chapterId。
 * 键与 app 章节 title 的「部分·篇名」一致（国风部分 app 标题为「国风·X·Y」，
 * 此处以「X·Y」为键，与 BNU 出处《诗·X·Y》直接对应）。未收录篇目回落书级 shijing。
 */
const SHIJING_CHAPTERS = {
  '周南·关雎': 'shijing-guan-ju',
  '周南·桃夭': 'shijing-tao-yao',
  '周南·芣苢': 'shijing-fu-yi',
  '召南·摽有梅': 'shijing-biao-you-mei',
  '邶风·式微': 'shijing-shi-wei',
  '邶风·凯风': 'shijing-kai-feng',
  '邶风·击鼓': 'shijing-ji-gu',
  '卫风·硕人': 'shijing-shuo-ren',
  '卫风·氓': 'shijing-meng',
  '卫风·木瓜': 'shijing-mu-gua',
  '王风·黍离': 'shijing-shu-li',
  '王风·采葛': 'shijing-cai-ge',
  '王风·君子于役': 'shijing-jun-zi-yu-yi',
  '魏风·伐檀': 'shijing-fa-tan',
  '魏风·硕鼠': 'shijing-shuo-shu',
  '陈风·月出': 'shijing-yue-chu',
  '秦风·蒹葭': 'shijing-jian-jia',
  '秦风·无衣': 'shijing-wu-yi',
  '豳风·七月': 'shijing-qi-yue',
  '豳风·东山': 'shijing-dong-shan',
  '小雅·鹿鸣': 'shijing-lu-ming',
  '小雅·采薇': 'shijing-cai-wei',
  '小雅·蓼莪': 'shijing-liao-e',
  '小雅·鹤鸣': 'shijing-he-ming',
  '大雅·文王': 'shijing-wen-wang',
  '大雅·生民': 'shijing-sheng-min',
  '周颂·清庙': 'shijing-qing-miao',
  '周颂·丰年': 'shijing-feng-nian',
  '周颂·噫嘻': 'shijing-yi-xi',
  '商颂·玄鸟': 'shijing-xuan-niao',
};

/** 楚辞 app 收录篇名 → chapterId（其余如 九章/九辩/天问 及 王逸〈九思〉等 回落书级 chuci） */
const CHUCI_CHAPTERS = {
  离骚: 'chuci-li-sao',
  '九歌·东皇太一': 'chuci-dong-huang-tai-yi',
  '九歌·云中君': 'chuci-yun-zhong-jun',
  '九歌·湘君': 'chuci-xiang-jun',
  '九歌·湘夫人': 'chuci-xiang-fu-ren',
  '九歌·国殇': 'chuci-guo-shang',
};

/**
 * 将 BNU 出处字符串解析为 app 内部典籍键。
 * @returns 空数组表示 app 无对应典籍（应丢弃该条目）；
 *          否则返回 [{ workId, bookId, chapterScoped }]，chapterScoped 表示是否为章级精确映射。
 */
function resolveAppKeys(chu) {
  if (!chu) return [];
  // 论语：章级精确（仅当 app 收录该章）；未收录则回落书级
  const lm = chu.match(/^《论语[·・]([^·・》]+)》$/);
  if (lm) {
    const cid = LUNYU_CHAPTERS[lm[1]];
    return cid
      ? [{ workId: cid, bookId: 'lunyu', chapterScoped: true }]
      : [{ workId: 'lunyu', bookId: 'lunyu', chapterScoped: false }];
  }
  // 老子/道德经：全书级；《老子·十六经·行守》为帛书《十六经》（《黄帝四经》），
  // 并非《道德经》，按宁缺毋滥原则排除
  if (/^《老子·十六经/.test(chu)) {
    return [];
  }
  if (/^《老子[·・]/.test(chu) || chu === '《老子》') {
    return [{ workId: 'daodejing', bookId: 'daodejing', chapterScoped: false }];
  }
  // 礼记·大学 / 礼记·中庸：书级
  if (/^《礼记[·・]大学》$/.test(chu)) {
    return [{ workId: 'daxue', bookId: 'daxue', chapterScoped: false }];
  }
  if (/^《礼记[·・]中庸》$/.test(chu)) {
    return [{ workId: 'zhongyong', bookId: 'zhongyong', chapterScoped: false }];
  }
  // 孟子：章级精确；未收录篇目（离娄/万章/告子下 等）回落书级 mengzi；
  // 《孟子正义序》等非孟子本文不匹配（无「·」分隔），自然丢弃
  const mm = chu.match(/^《孟子[·・]([^·・》]+)》$/);
  if (mm) {
    const cid = MENGZI_CHAPTERS[mm[1]];
    return cid
      ? [{ workId: cid, bookId: 'mengzi', chapterScoped: true }]
      : [{ workId: 'mengzi', bookId: 'mengzi', chapterScoped: false }];
  }
  // 庄子：内篇章级精确；外杂篇（让王/天下/秋水 等）回落书级 zhuangzi；
  // 《庄子独见》等注释著作不匹配，丢弃
  const zm = chu.match(/^《庄子[·・]([^·・》]+)》$/);
  if (zm) {
    const cid = ZHUANGZI_CHAPTERS[zm[1]];
    return cid
      ? [{ workId: cid, bookId: 'zhuangzi', chapterScoped: true }]
      : [{ workId: 'zhuangzi', bookId: 'zhuangzi', chapterScoped: false }];
  }
  // 荀子：app 收录四篇章级精确，其余篇目回落书级 xunzi
  const xm = chu.match(/^《荀子[·・]([^·・》]+)》$/);
  if (xm) {
    const cid = XUNZI_CHAPTERS[xm[1]];
    return cid
      ? [{ workId: cid, bookId: 'xunzi', chapterScoped: true }]
      : [{ workId: 'xunzi', bookId: 'xunzi', chapterScoped: false }];
  }
  // 诗经：BNU 出处为《诗》或《诗·部分·篇名》；可精确映射的篇目章级，其余书级 shijing
  if (chu === '《诗》') {
    return [{ workId: 'shijing', bookId: 'shijing', chapterScoped: false }];
  }
  const sm = chu.match(/^《诗[·・]([^·・》]+)[·・]([^·・》]+)》$/);
  if (sm) {
    const cid = SHIJING_CHAPTERS[`${sm[1]}·${sm[2]}`];
    return cid
      ? [{ workId: cid, bookId: 'shijing', chapterScoped: true }]
      : [{ workId: 'shijing', bookId: 'shijing', chapterScoped: false }];
  }
  // 楚辞：内名可精确映射（离骚/九歌六篇）则章级；其余（九章/九辩/天问/王逸〈九思〉
  // 等，含〈〉＜〉全角变体）均属《楚辞》一书，回落书级 chuci
  const cm = chu.match(/^《楚辞[·・](.+?)》$/);
  if (cm) {
    const cid = CHUCI_CHAPTERS[cm[1]];
    return cid
      ? [{ workId: cid, bookId: 'chuci', chapterScoped: true }]
      : [{ workId: 'chuci', bookId: 'chuci', chapterScoped: false }];
  }
  return [];
}

// ----------------------------- 源一：北师大通假库 -----------------------------

async function loadBnu(tongjiaRows, readingRows) {
  // 离线优先：若设置了本地语料（已解压的 corpus.jsonl），直接读取，跳过联网
  const localJsonl = process.env.CANON_LOCAL_JSONL;
  if (localJsonl && existsSync(localJsonl)) {
    const txt = readFileSync(localJsonl, 'utf8');
    parseBnuJsonl(txt, tongjiaRows, readingRows);
    return;
  }
  // 仓库默认分支为 main（非 master），分支名错误会导致 404
  const base = 'https://raw.githubusercontent.com/frederick-wang/tongjiazi-resources/main';
  // 候选 zip 路径（README 说明语料压成 zip 防爬；真实文件名为 tongjiazi_corpus.zip）
  const zipCandidates = [
    `${base}/corpus/tongjiazi_corpus.zip`,
    `${base}/corpus/corpus.zip`,
    `${base}/corpus.zip`,
    `${base}/data/corpus.zip`,
    `${base}/tongjia_corpus.zip`,
  ];
  // 候选 jsonl 直链（部分版本可能未压缩）
  const jsonlCandidates = [
    `${base}/corpus/corpus.jsonl`,
    `${base}/corpus.jsonl`,
    `${base}/data/corpus.jsonl`,
  ];

  const tmp = mkdtempSync(resolve(tmpdir(), 'bnu-'));
  try {
    // 1) 尝试通过 GitHub API 树发现 corpus 目录下的 zip / jsonl（容错：失败则忽略）
    let discovered = [];
    try {
      const treeText = await fetchText(
        'https://api.github.com/repos/frederick-wang/tongjiazi-resources/git/trees/main?recursive=1',
        15000,
      );
      const tree = JSON.parse(treeText);
      discovered = (tree.tree || [])
        .map((n) => n.path)
        .filter((p) => typeof p === 'string' && (p.endsWith('.zip') || p.endsWith('.jsonl')) && /corpus/i.test(p));
    } catch {
      // 忽略：rate-limit 或离线，回落到候选列表
    }
    // 树发现的是相对路径，需补 base 才能下载
    const zipPaths = [
      ...discovered.filter((p) => p.endsWith('.zip')).map((p) => `${base}/${p}`),
      ...zipCandidates,
    ];
    const jsonlPaths = [
      ...discovered.filter((p) => p.endsWith('.jsonl')).map((p) => `${base}/${p}`),
      ...jsonlCandidates,
    ];

    // 2) 优先尝试 zip（解压后取 corpus.jsonl）
    for (const url of zipPaths) {
      try {
        const buf = await fetchBuffer(url, 60000);
        if (!buf || buf.length < 64) continue; // 太小可能是错误页
        const zipPath = resolve(tmp, 'corpus.zip');
        writeFileSync(zipPath, buf);
        execSync(`unzip -P BEIJING_NORMAL_UNIVERSITY -o -q "${zipPath}" -d "${tmp}"`, { stdio: 'ignore' });
        const jsonlPath = resolve(tmp, 'corpus.jsonl');
        console.error(`[debug] zip buf=${buf.length}, jsonl exists=${existsSync(jsonlPath)}`);
        if (existsSync(jsonlPath)) {
          parseBnuJsonl(readFileSync(jsonlPath, 'utf8'), tongjiaRows, readingRows);
          return; // 成功即止
        }
      } catch {
        // 尝试下一个候选
      }
    }

    // 3) 回落 jsonl 直链
    for (const url of jsonlPaths) {
      try {
        const text = await fetchText(url, 15000);
        if (text && text.trim()) {
          parseBnuJsonl(text, tongjiaRows, readingRows);
          return;
        }
      } catch {
        // 尝试下一个候选
      }
    }
    throw new Error('所有候选路径均不可用');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseBnuJsonl(text, tongjiaRows, readingRows) {
  console.error(`[debug] parseBnuJsonl text.length=${text?.length}`);
  let count = 0;
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (Array.isArray(obj)) {
      // 某些语料每行可能是数组，跳过结构不确定项以避免误标
      continue;
    }
    // 解析 char（优先显式「借字」，其次 语料文本[标注位置]）
    let char = pick(obj, CHAR_KEYS);
    if (!char) {
      const t = pick(obj, TEXT_KEYS);
      const pos = pick(obj, POS_KEYS);
      if (t && pos !== undefined && /^\d+$/.test(pos)) {
        const arr = Array.from(t);
        const idx = Number(pos);
        if (idx >= 0 && idx < arr.length) {
          char = arr[idx];
        }
      }
    }
    const original = pick(obj, ORIGINAL_KEYS);
    const work = pick(obj, SOURCE_KEYS);
    if (!char || !original || !work) {
      // 字段不全：宁可丢弃，绝不伪造
      continue;
    }
    // 清洗字头编号：通假字字头「没1」「弟2」→「没」「弟」，否则与正文实际字符（无编号）无法匹配
    const cleanChar = char.replace(/[０-９0-9]+$/u, '').trim();
    if (!cleanChar) continue;
    // 清洗《汉语大词典》凡例字头编号（如「眊1」「耗3」→「眊」「耗」）
    const cleanOriginal = original.replace(/[０-９0-9]+$/u, '').trim();
    if (!cleanOriginal) continue;
    // 字头归一化：与运行时 CanonService 查询键同口径（繁→简，含 輮→𫐓 类 opencc 映射），
    // 保证简体/繁体两种显示模式下查询均能命中；归一化后借字与本字相同则丢弃（无意义）
    const normChar = toSimplifiedKey(cleanChar);
    const normOriginal = toSimplifiedKey(cleanOriginal);
    if (!normChar || !normOriginal || normChar === normOriginal) {
      continue;
    }
    // 解析为 app 内部典籍键（chapterId/bookId slug）；无法映射则丢弃，不写入与 app 无关的结论
    const appKeys = resolveAppKeys(work);
    if (appKeys.length === 0) {
      dropped += 1;
      continue;
    }
    const { workId } = appKeys[0];
    const note = pick(obj, NOTE_KEYS);
    // 判定源保留具体出处（含 BNU 库署名），供浮窗展示「判定源」
    const sources = JSON.stringify([`${SRC_BNU}·${work}`]);
    // v3 用例级语境锚定：语料例句原样入库（繁体原貌，运行时归一化匹配）；
    // BNU 语料 100% 带例句，运行时据此把「字 × 篇」判定收敛到「字 × 用例」
    const corpusText = pick(obj, TEXT_KEYS);
    tongjiaRows.push({
      work_id: workId,
      char: normChar,
      original: normOriginal,
      note: note ?? null,
      sources,
      verified: 1,
      type: 'tongjia',
      context: corpusText ?? null,
    });
    count += 1;

    // 读音：仅当拼音为干净单音节时可信写入（避免误注）；通假字的语境读音即其在典籍中的正确读法
    const py = pick(obj, PINYIN_KEYS);
    if (py && isSingleSyllable(py)) {
      readingRows.push({
        work_id: workId,
        char: normChar,
        reading: py.trim(),
        sources,
        verified: 1,
        context: corpusText ?? null,
      });
    }
  }
  console.log(
    `[build-canon] 北师大语料解析：${count} 条 tongjia（写入）；未映射到 app 典籍跳过 ${dropped} 条`,
  );
}

// ----------------------------- 源二：chinese-poetry-md -----------------------------

/** 严格对齐：正文逐字 vs 拼音逐音节（CJK 与拼音 token 数一致才采用） */
function alignPoem(body, pinyinSection) {
  const chars = Array.from(body).filter((c) => /[一-鿿]/.test(c));
  const syllables = pinyinSection
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[，。、？！；：""''（）…—,.?!;:()]+$/.test(s));
  if (chars.length !== syllables.length || chars.length === 0) {
    return null;
  }
  const map = new Map();
  for (let i = 0; i < chars.length; i += 1) {
    map.set(chars[i], syllables[i]);
  }
  return map;
}

function parsePoemMarkdown(md, readingRows) {
  const lines = md.split(/\r?\n/);
  let title = '';
  let author = '';
  let body = '';
  let pinyinSection = '';
  let mode = 'body';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      const h = line.slice(3).trim();
      if (h === '作者' || h === 'author') {
        mode = 'author';
      } else if (h === '正文' || h === 'content' || h === '原文') {
        mode = 'body';
      } else if (h === '拼音' || h === 'pinyin') {
        mode = 'pinyin';
        // 拼音段可能有多行，合并
        const rest = lines.slice(i + 1).join('\n');
        pinyinSection = rest;
        break;
      } else {
        mode = 'skip';
      }
      continue;
    }
    if (mode === 'author') author = line;
    else if (mode === 'body') body += line;
    else if (mode === 'pinyin') pinyinSection += line + '\n';
  }
  if (!body || !pinyinSection) return;
  const align = alignPoem(body, pinyinSection);
  if (!align) return; // 不对齐则丢弃，绝不编造读音
  const workId = `${author || '佚名'}::${title || '未知'}`;
  for (const [char, reading] of align.entries()) {
    if (!isSingleSyllable(reading)) continue;
    readingRows.push({
      work_id: workId,
      char,
      reading: reading.trim(),
      sources: JSON.stringify([SRC_POETRY]),
      verified: 1,
    });
  }
}

async function loadPoetry(readingRows) {
  // 通过 GitHub API 取树，挑若干 .md（诗经/论语/唐诗等），逐个解析 `## 拼音`
  // 兼容默认分支 main / master
  let mdPaths = [];
  let base = '';
  for (const branch of ['main', 'master']) {
    try {
      const treeUrl = `https://api.github.com/repos/daichangya/chinese-poetry-md/git/trees/${branch}?recursive=1`;
      const tree = JSON.parse(await fetchText(treeUrl, 15000));
      mdPaths = (tree.tree || [])
        .map((n) => n.path)
        .filter((p) => typeof p === 'string' && p.endsWith('.md') && !/README/i.test(p))
        .slice(0, 60); // 控制规模：种子抓取前 60 首
      base = `https://raw.githubusercontent.com/daichangya/chinese-poetry-md/${branch}`;
      if (mdPaths.length) break;
    } catch {
      // 尝试下一分支
    }
  }
  if (!mdPaths.length) return;
  let parsed = 0;
  for (const p of mdPaths) {
    try {
      const md = await fetchText(`${base}/${p}`, 10000);
      const before = readingRows.length;
      parsePoemMarkdown(md, readingRows);
      if (readingRows.length > before) parsed += 1;
    } catch {
      // 单首失败不影响整体
    }
  }
  console.log(`[build-canon] chinese-poetry-md 解析：${parsed} 首含有效拼音`);
}

// ----------------------------- 源三：本地可选种子 -----------------------------

function loadLocalSeed(tongjiaRows, readingRows) {
  if (!existsSync(LOCAL_SEED)) return 0;
  const seed = JSON.parse(readFileSync(LOCAL_SEED, 'utf8'));
  const tj = seed.tongjia || [];
  for (const r of tj) {
    if (!r.work_id || !r.char || !r.original) continue;
    // v3 语境锚定：显式 context 优先；否则从释义引文中提取含借字的例句
    // （如「不亦说乎」），提取不到为 null（该行无语境证据，运行时按旧行为放行）
    const context =
      r.context ?? extractContextFromNote(r.note, toSimplifiedKey(r.char));
    tongjiaRows.push({
      work_id: r.work_id,
      char: r.char,
      original: r.original,
      note: r.note ?? null,
      sources: JSON.stringify(r.sources || [SRC_BNU]),
      verified: r.verified === false ? 0 : 1,
      context: context ?? null,
    });
  }
  const rd = seed.reading || [];
  for (const r of rd) {
    if (!r.work_id || !r.char || !r.reading) continue;
    const context =
      r.context ?? extractContextFromNote(r.note, toSimplifiedKey(r.char));
    readingRows.push({
      work_id: r.work_id,
      char: r.char,
      reading: r.reading,
      sources: JSON.stringify(r.sources || [SRC_POETRY]),
      verified: r.verified === false ? 0 : 1,
      context: context ?? null,
    });
  }
  const total = tj.length + rd.length;
  console.log(`[build-canon] 本地种子：${total} 条`);
  return total;
}

// ----------------------------- 源四：古今字种子（人工标注） -----------------------------

/** CJK 统一表意文字（含扩展 A 区）判定 */
function isCJKChar(c) {
  const n = c.codePointAt(0);
  return (n >= 0x3400 && n <= 0x9fff);
}

/**
 * 扫描 src/data/texts/ 下 10 部书正文，统计每部书出现的单字频次。
 * 用于古今字种子的「宁缺毋滥」过滤：仅当借字在该书正文中实际出现时才写入该书。
 */
function scanBookTexts() {
  const dir = resolve(ROOT, 'src/data/texts');
  const books = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!data?.id || !Array.isArray(data.chapters)) continue;
    const chars = new Map();
    for (const chapter of data.chapters) {
      const segs = Array.isArray(chapter?.segments) ? chapter.segments : [];
      for (const seg of segs) {
        const t = typeof seg?.text === 'string' ? seg.text : '';
        for (const c of t) {
          if (isCJKChar(c)) {
            chars.set(c, (chars.get(c) ?? 0) + 1);
          }
        }
      }
    }
    books.push({ bookId: String(data.id), chars });
  }
  return books;
}

/**
 * 加载古今字种子（scripts/canon-seed-gujin.json）。
 * 北师大库无古今字分区；本种子据训诂常识人工标注常见古今字对（古字 → 今字），
 * sources 标注「人工标注·据训诂常识（古今字），建议校对」，verified=0（未权威校验）。
 * 映射策略：为每部「正文中实际出现该古字」的书写一条书级记录（borrowed char 出现才标注，
 * 绝不写入与该书无关的结论）；与 BNU/种子条目同 work_id+char 时靠主流程去重保留首条，
 * 故古今字仅填充既有权威结论未覆盖的空缺。
 */
function loadGujinSeed(tongjiaRows) {
  if (!existsSync(GUJIN_SEED)) return 0;
  const seed = JSON.parse(readFileSync(GUJIN_SEED, 'utf8'));
  const pairs = Array.isArray(seed.pairs) ? seed.pairs : [];
  const books = scanBookTexts();
  const sources = JSON.stringify([SRC_GUJIN]);
  let rows = 0;
  for (const p of pairs) {
    const char = String(p?.char ?? '').trim();
    const original = String(p?.original ?? '').trim();
    const note = String(p?.note ?? '').trim();
    if (char.length !== 1 || !original || !isCJKChar(char) || !isCJKChar(original)) {
      continue; // 字段不全/非法：宁可丢弃，绝不伪造
    }
    // 与运行时查询键同口径归一化；归一化后借字=本字（如 倖→幸）说明该对属
    // 繁简/异体关系而非古今字，按宁缺毋滥丢弃
    const normChar = toSimplifiedKey(char);
    const normOriginal = toSimplifiedKey(original);
    if (!normChar || !normOriginal || normChar === normOriginal || !isCJKChar(normChar)) {
      continue;
    }
    const fullNote = note
      ? `${note}（古今字·人工标注，据训诂常识，建议校对）`
      : '古今字，此处同本字。（人工标注，据训诂常识，建议校对）';
    // v3 语境锚定：从人工标注引文提取例句（如「学而时习之，不亦说乎」）；
    // 引文过短/缺失为 null（书级行已按「正文实际出现借字」过滤，运行时放行）
    const context = extractContextFromNote(note, normChar);
    for (const b of books) {
      if (!b.chars.has(normChar) && !b.chars.has(char)) continue; // 该书正文未出现此古字 → 不写
      tongjiaRows.push({
        work_id: b.bookId,
        char: normChar,
        original: normOriginal,
        note: fullNote,
        sources,
        verified: 0,
        type: 'gujin',
        context: context ?? null,
      });
      rows += 1;
    }
  }
  console.log(`[build-canon] 古今字种子：${pairs.length} 对 → ${rows} 条书级记录（仅写入正文实际出现借字的书）`);
  return rows;
}

// ----------------------------- 主流程 -----------------------------

async function main() {
  const startedAt = Date.now();
  const tongjiaRows = [];
  const readingRows = [];

  // 源一：北师大通假库（联网）
  try {
    await loadBnu(tongjiaRows, readingRows);
  } catch (e) {
    console.warn(`[build-canon] 北师大语料获取失败（跳过，降级为空库）：${e?.message ?? e}`);
  }

  // 源二：chinese-poetry-md（联网，默认关闭：其递归树体量巨大易 OOM；
  //       如需诗词语境读音，设环境变量 CANON_POETRY=1 再运行，或改用 scripts/canon-seed.json 本地种子）
  if (process.env.CANON_POETRY === '1') {
    try {
      await loadPoetry(readingRows);
    } catch (e) {
      console.warn(`[build-canon] chinese-poetry-md 获取失败（跳过）：${e?.message ?? e}`);
    }
  } else {
    console.log('[build-canon] 跳过诗词源（默认关闭；CANON_POETRY=1 可开启，或用 canon-seed.json 补充读音）');
  }

  // 源三：本地种子（离线可用）
  loadLocalSeed(tongjiaRows, readingRows);

  // 源四：古今字种子（人工标注；写入范围按 10 部书正文实际出现借字过滤）
  loadGujinSeed(tongjiaRows);

  // 去重（同 work_id+char+context 仅保留首条，避免主键冲突；
  // v3 起同字的不同语料用例（context 不同）共存）
  const tjSeen = new Set();
  const tjUnique = [];
  for (const r of tongjiaRows) {
    const k = `${r.work_id}::${r.char}::${r.context ?? ''}`;
    if (tjSeen.has(k)) continue;
    tjSeen.add(k);
    tjUnique.push(r);
  }
  const rdSeen = new Set();
  const rdUnique = [];
  for (const r of readingRows) {
    const k = `${r.work_id}::${r.char}::${r.context ?? ''}`;
    if (rdSeen.has(k)) continue;
    rdSeen.add(k);
    rdUnique.push(r);
  }

  // 构建到首个输出路径，再字节级复制
  const [primary, ...rest] = OUTPUTS;
  mkdirSync(dirname(primary), { recursive: true });
  rmSync(primary, { force: true });
  const db = new Database(primary);

  try {
    db.pragma('journal_mode = DELETE');
    db.exec('DROP TABLE IF EXISTS tongjia_judgment;');
    db.exec('DROP TABLE IF EXISTS reading_selection;');
    db.exec(CREATE_TONGJIA);
    db.exec(CREATE_READING);

    const insTj = db.prepare(
      `INSERT OR REPLACE INTO tongjia_judgment
       (work_id, char, original, note, sources, verified, type, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRd = db.prepare(
      `INSERT OR REPLACE INTO reading_selection
       (work_id, char, reading, sources, verified, context) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const txTj = db.transaction((rows) => {
      for (const r of rows) {
        insTj.run(r.work_id, r.char, r.original, r.note, r.sources, r.verified, r.type ?? 'tongjia', r.context ?? null);
      }
    });
    const txRd = db.transaction((rows) => {
      for (const r of rows) {
        insRd.run(r.work_id, r.char, r.reading, r.sources, r.verified, r.context ?? null);
      }
    });
    txTj(tjUnique);
    txRd(rdUnique);

    db.pragma(`user_version = ${CANON_DICT_VERSION}`);
    db.close();

    for (const dest of rest) {
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      copyFileSync(primary, dest);
    }

    const total = tjUnique.length + rdUnique.length;
    console.log(
      `[build-canon] 完成：${tjUnique.length} 条 tongjia / ${rdUnique.length} 条 reading，共 ${total} 条，` +
        `${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
    );
    console.log(`[build-canon] 主产物：${primary}`);
    if (total === 0) {
      console.log(
        '[build-canon] ⚠ 当前为带正确 schema 的空库：种子数据需在可联网环境运行本脚本填充' +
          '（或放置 scripts/canon-seed.json 本地种子）。脚本未伪造任何通假/读音结论。',
      );
    }
    for (const dest of rest) {
      console.log(`[build-canon] 副本：${dest}`);
    }
  } catch (e) {
    db.close();
    console.error(`[build-canon] 构建失败：${e?.message ?? String(e)}`);
    process.exit(1);
  }
}

main();
