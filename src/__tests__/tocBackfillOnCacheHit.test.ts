/**
 * 【B 档步骤 8】修「存量已导入的大书永远拿不到 `.gxbook.toc`」
 *
 * ★缺陷本体（真机挖出，非推演）：
 *   `.toc` 只在「缓存**不存在**→ 完整解析」路径写。而**存量**已导入的大书
 *   `.gxbook` 早已存在 ⇒ 走「读缓存 + `parseTxtBookChunked` 重建」分支
 *   ⇒ `.toc` 永远不会被生成 ⇒ B 档收益（真机 8072ms → 202ms）对真实用户
 *   **等于零**。真机证据：装 B 臂包后首启 Δ=9247ms（比老路更慢）且 `ls` 无 `.toc`。
 *
 * ★判据形状（刻意）：**以行为为主、形状为辅**。
 *   · 行为组 A1（核心正例）：缓存命中 + `.toc` 缺失 ⇒ 重建后**真的写出了
 *     `.toc`**，且写出的 toc 经 `validateTocShape` + `verifyTocAgainstText`
 *     双重校验通过，且按字节区间切出的每章正文与全量解析逐段相等。
 *     ★对基线（修复前）必红 —— 修复前该分支根本不写 `.toc`。
 *   · 行为组 A2（幂等 / 方向二）：`.toc` **已存在** ⇒ 不重复写（内容不变）。
 *     这条对基线也绿（基线压根不写）⇒ **必须报「红了哪几条」才有意义**。
 *   · 行为组 A3（★拒下类，条目94/100）：`buildTocFromBook` 返回 null
 *     （无标记书按段数切「第N部分」）⇒ **不写 `.toc`**、**不抛错**、
 *     **书仍正常返回**（回退全量读，永远正确）。只跑正例时这条恒绿。
 *   · 行为组 A4（★CR 口径守卫）：缓存含 CRLF ⇒ 不写 toc（偏移口径不一致
 *     ⇒ 宁可不优化，也不能落一份会静默切错章的 toc）。
 *   · 形状组 B：两条落盘路径**共用** `writeTocIfPossible`（不得各写一份
 *     ⇒ 全有或全无语义必须只有一处实现）。
 *
 * ★桩保真度：内存文件系统（真 `RNFS.writeFile`/`read`/`stat` 语义）+
 *   真实 `parseTxtBookChunked` / `buildTocFromBook` / `sliceBytes` / `toParagraphs`。
 *   **只 mock IO 边界，不 mock 被测逻辑**（mock 会把缺陷测成正确，已 3 次）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  buildTocFromBook,
  normalizeForCache,
  sliceBytes,
  validateTocShape,
  verifyTocAgainstText,
  type ChapterToc,
} from '@/services/chapterToc';
import type { Book } from '@/types';

const APP_ROOT = resolve(__dirname, '..');
const ubsSrc = readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8');

// ───────────────────────── RNFS 内存文件系统桩 ─────────────────────────
interface MockFs {
  files: Map<string, string>;
  dirs: Set<string>;
  failWrite: Set<string>;
  writes: string[];
}
const mockFs: MockFs = {
  files: new Map(),
  dirs: new Set(),
  failWrite: new Set(),
  writes: [],
};

jest.mock('react-native-fs', () => {
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  return {
    ExternalDirectoryPath: '/data/user/0/com.guoxue.studyapp/files',
    DocumentDirectoryPath: '/data/user/0/com.guoxue.studyapp/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.studyapp/cache',
    exists: jest.fn(async (p: string) => mockFs.files.has(p) || mockFs.dirs.has(p)),
    mkdir: jest.fn(async (p: string) => {
      let cur = p;
      while (cur.length > 1) {
        mockFs.dirs.add(cur);
        cur = parentOf(cur);
      }
    }),
    readDir: jest.fn(async () => []),
    stat: jest.fn(async (p: string) => {
      const content = mockFs.files.get(p);
      if (content === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return {
        path: p,
        size: Buffer.byteLength(content, 'utf8'),
        isFile: () => true,
        isDirectory: () => false,
        mtime: new Date(1_700_000_000_000),
      };
    }),
    read: jest.fn(async (p: string, length: number, position: number) => {
      const buf = Buffer.from(mockFs.files.get(p) ?? '', 'utf8');
      return buf.subarray(position, position + length).toString('base64');
    }),
    readFile: jest.fn(async (p: string) => {
      const c = mockFs.files.get(p);
      if (c === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return c;
    }),
    readFileAssets: jest.fn(async () => {
      throw new Error('diag: 无随包资产（内置书侧失败路径，不影响本组断言）');
    }),
    writeFile: jest.fn(async (p: string, content: string) => {
      if (mockFs.failWrite.has(p)) {
        throw new Error(`EIO(simulated): ${p}`);
      }
      mockFs.files.set(p, content);
      mockFs.writes.push(p);
    }),
    appendFile: jest.fn(async () => undefined),
    copyFile: jest.fn(async () => undefined),
    unlink: jest.fn(async (p: string) => {
      mockFs.files.delete(p);
    }),
  };
});

// TextLibraryService / StorageService 只需注册表写入成功即可
jest.mock('@/services/TextLibraryService', () => ({
  TextLibraryService: {
    isUserBook: (id: string) => id.startsWith('user-'),
    getBooks: jest.fn(() => ({ data: [] })),
    registerUserBooks: jest.fn(() => ({ success: true, data: 1 })),
  },
}));

jest.mock('@/services/StorageService', () => ({
  StorageService: {
    upsertFtsForBook: jest.fn(() => ({ success: true, data: true })),
    deleteFtsForBook: jest.fn(() => ({ success: true, data: true })),
    isBookIndexedInFts: jest.fn(() => ({ success: true, data: false })),
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
function loadUbs(): {
  __processOversizedBooksForTests: (t: Array<{ path: string; name: string; sig: string; cachePath: string }>) => Promise<Book[]>;
  tocOffsetBaseMatchesCache: (s: string) => boolean;
  toParagraphs: (raw: string) => string[];
  stableBookIdFromPath: (n: string) => string;
} {
  return require('@/services/UserBookService');
}
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = '/data/user/0/com.guoxue.studyapp/files/books';

/** 造一本**带章节标记**的书文本（标记 ⇒ 偏移可表达 ⇒ toc 可生成） */
function markedBookText(chapters = 6): string {
  let s = '';
  for (let c = 1; c <= chapters; c += 1) {
    s += `第${c}章 风雪夜\n`;
    for (let i = 1; i <= 40; i += 1) {
      s += `第${c}章第${i}段：这是用来把正文撑到一定长度以便切出真实字节区间的中文行。\n`;
    }
  }
  return s;
}

/** 造一本**无标记**的书（无标记 + 超`SEGMENTS_PER_PART` ⇒ 按段数切 ⇒ 偏移不可表达） */
function unmarkedBookText(): string {
  let s = '';
  for (let i = 0; i < 20000; i += 1) {
    s += `无标记正文第${i}行，这本书没有章节标记所以只能按段数切分而无法用字节偏移表达。\n`;
  }
  return s;
}

/** ★危险样本：只把**末尾 k 个** `\n` 换成 `\r\n`，前面所有章偏移完全对齐。
 *
 *  这是「显式 CR 守卫为何必要」的**实测反例**（2026-10-13 探针）：
 *  `buildTocFromBook` 的 `verifyTocAgainstText` 在 k=1..41 时**全部通过**，
 *  但按字节切出的正文**已错1/6 章** ⇒ 「靠生成端自检兜住」是**错的**。
 *  k=1 时偏移恰好都对（CR 在末章之后），k≥2 起开始错 ⇒ 边界值也一并钉住。
 */
function crTail(lf: string, k: number): string {
  const idx: number[] = [];
  for (let i = 0; i < lf.length; i += 1) {
    if (lf[i] === '\n') idx.push(i);
  }
  const from = new Set(idx.slice(Math.max(0, idx.length - k)));
  let out = '';
  for (let i = 0; i < lf.length; i += 1) {
    out += lf[i];
    if (from.has(i)) out += '\r';
  }
  return out;
}

function seedTask(name: string, cacheContent: string | null): {
  path: string;
  name: string;
  sig: string;
  cachePath: string;
} {
  const p = `${ROOT}/${name}`;
  mockFs.dirs.add(ROOT);
  if (cacheContent !== null) {
    mockFs.files.set(`${p}.gxbook`, cacheContent);
    mockFs.files.set(
      `${p}.gxbook.meta`,
      JSON.stringify({ v: 1, title: '缓存标题', author: '缓存作者', fileSig: '', contentHash: '' }),
    );
  }
  return { path: p, name, sig: '1700000000000:1', cachePath: `${p}.gxbook` };
}

/**
 * 用**真解析器**造 Book（判据不自己造 Book ⇒ 不会「自己等于自己」）。
 *
 * ⚠ `markers` 必须与真链路一致：`processOversizedBooks` 回退分支传的是
 *   `markers: isStructuredFormat(ext)`，`.txt` ⇒ **false**。
 *   判据曾误传 `true`（结构不同 ⇒ 偏移分布不同 ⇒ 前置探针结论失真），
 *   是判据构造错误而非实现错误（条目 91）。
 */
function parseTxtBookProbe(text: string): Book {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const { parseTxtBook } = require('@/services/UserBookService');
  return parseTxtBook('probe.txt', text, 'user-probe', { markers: false, sourceLabel: 'TXT' });
}

function readToc(cachePath: string): ChapterToc | null {
  const raw = mockFs.files.get(`${cachePath}.toc`);
  return raw === undefined ? null : (JSON.parse(raw) as ChapterToc);
}

beforeEach(() => {
  jest.resetModules();
  mockFs.files.clear();
  mockFs.dirs.clear();
  mockFs.failWrite.clear();
  mockFs.writes.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('B8 行为组：缓存命中回退重建必须补落 .toc（存量书缺陷本体）', () => {
  it('★A1 正例：`.gxbook` 存在 + `.toc` 缺失 ⇒ 重建后写出合法 toc，且切出的正文与全量解析逐段相等', async () => {
    const ubs = loadUbs();
    const norm = markedBookText();
    const task = seedTask('A1存量书.txt', norm);
    // 前置：确认缺陷的起点确实成立（缓存有、toc 无）
    expect(mockFs.files.has(task.cachePath)).toBe(true);
    expect(mockFs.files.has(`${task.cachePath}.toc`)).toBe(false);

    const books = await ubs.__processOversizedBooksForTests([task]);

    //书正常上架（补toc 不能把书弄丢）
    expect(books).toHaveLength(1);
    const book = books[0];
    expect(book.chapters.length).toBeGreaterThan(1);

    // ★核心断言：`.toc` 必须被写出来
    const toc = readToc(task.cachePath);
    expect(toc).not.toBeNull();
    const bookId = ubs.stableBookIdFromPath(task.name);

    //读侧闸门 + 生成端自检，两道都要过
    expect(validateTocShape(toc, bookId, book.chapters.length)).toBe('');
    expect(verifyTocAgainstText(toc as ChapterToc, norm)).toBe('');

    // ★端到端等价：按字节区间切出的每章正文，与全量解析该章逐段相等
    //（此即「切错章」这一最坏缺陷类的直接反证）
    for (const entry of (toc as ChapterToc).chapters) {
      const sliced = sliceBytes(norm, entry.start, entry.end);
      const ref = book.chapters.find((c) => c.id === entry.id);
      expect(ref).toBeDefined();
      const refParas = ubs.toParagraphs(
        (ref as Book['chapters'][number]).segments.map((sg) => sg.text).join('\n'),
      );
      const gotParas = ubs.toParagraphs(sliced);
      expect(gotParas).toEqual(refParas);
    }
  });

  it('A2 幂等：`.toc` 已存在 ⇒ 不重复写（内容逐字不变）', async () => {
    const ubs = loadUbs();
    const norm = markedBookText();
    const task = seedTask('A2已带toc.txt', norm);
    // 先跑一次生成 toc
    await ubs.__processOversizedBooksForTests([task]);
    const first = mockFs.files.get(`${task.cachePath}.toc`);
    expect(first).toBeDefined();
    mockFs.writes.length = 0;

    // 再跑一次（这次命中 toc 快路径，根本不会进回退分支）
    await ubs.__processOversizedBooksForTests([task]);
    expect(mockFs.files.get(`${task.cachePath}.toc`)).toBe(first);
    expect(mockFs.writes.filter((p) => p === `${task.cachePath}.toc`)).toHaveLength(0);
  });

  it('★A3 拒下类：偏移无法表达（无标记书按段数切）⇒ 不写 toc、不抛错、书仍返回', async () => {
    const ubs = loadUbs();
    const task = seedTask('A3无标记.txt', unmarkedBookText());
    const books = await ubs.__processOversizedBooksForTests([task]);
    //书必须正常返回（回退全量读，永远正确）
    expect(books).toHaveLength(1);
    expect(books[0].chapters.length).toBeGreaterThan(1);
    // ★不写 toc（全有或全无）
    expect(mockFs.files.has(`${task.cachePath}.toc`)).toBe(false);
  });

  it('★A4 口径守卫：缓存含 CRLF ⇒ 不写 toc（宁可不优化，也不能落会静默切错章的 toc）', async () => {
    const ubs = loadUbs();
    const norm = markedBookText();
    const crlf = norm.replace(/\n/g, '\r\n');
    expect(normalizeForCache(crlf)).not.toBe(crlf); // 前置：样本确实含 CR
    const task = seedTask('A4CRLF缓存.txt', crlf);

    const books = await ubs.__processOversizedBooksForTests([task]);
    expect(books).toHaveLength(1);
    // ★绝不落 toc
    expect(mockFs.files.has(`${task.cachePath}.toc`)).toBe(false);
  });

  it('A5 偏移基准判定纯函数：LF 缓存通过、CRLF/CR 缓存拒绝（两个方向都有鉴别力）', () => {
    const ubs = loadUbs();
    expect(ubs.tocOffsetBaseMatchesCache(markedBookText())).toBe(true);
    expect(ubs.tocOffsetBaseMatchesCache(markedBookText().replace(/\n/g, '\r\n'))).toBe(false);
    expect(ubs.tocOffsetBaseMatchesCache(markedBookText().replace(/\n/g, '\r'))).toBe(false);
    // 空串是合法缓存内容（不应被误判为含 CR）
    expect(ubs.tocOffsetBaseMatchesCache('')).toBe(true);
  });

  it('A6 toc 写失败（IO 抛错）不冒泡：书仍返回，下次启动退回全量读', async () => {
    const ubs = loadUbs();
    const norm = markedBookText();
    const task = seedTask('A6写失败.txt', norm);
    mockFs.failWrite.add(`${task.cachePath}.toc`);

    const books = await ubs.__processOversizedBooksForTests([task]);
    expect(books).toHaveLength(1);
    expect(mockFs.files.has(`${task.cachePath}.toc`)).toBe(false);
  });
  it('★A7 守卫的真实鉴别力：末尾局部 CR 下`buildTocFromBook` 自检会**误判通过**并切错章⇒ 只能靠显式守卫', async () => {
    const ubs = loadUbs();
    const lf = markedBookText();
    // 危险样本：末尾 10 个 CR（前5 章偏移完全对齐，自检看不出问题）
    const mixed = crTail(lf, 10);
    expect(mixed).not.toBe(lf);
    // 前置：证明「靠生成端自检兜住」这条路**确实不够** —— 自检会过，
    //   但按字节切出的正文已错。这是不设显式守卫的真实后果。
    const probe = parseTxtBookProbe(mixed);
    const selfChecked = buildTocFromBook(probe, mixed);
    expect(selfChecked).not.toBeNull(); // ← 生成端自检**放行**了（这才是危险所在）
    //逐章按字节切，与全量解析的该章正文比（实测：末尾 CR ≥2 个时起开始错）
    let wrong = 0;
    for (const e of (selfChecked as ChapterToc).chapters) {
      const ref = probe.chapters.find((c) => c.id === e.id) as Book['chapters'][number];
      const sliced = sliceBytes(mixed, e.start, e.end);
      const refJoin = ref.segments.map((sg) => sg.text).join('\n');
      if (sliced.replace(/\r\n/g, '\n').trim() !== refJoin.trim()) wrong += 1;
    }
    // ★自检过了，但正文已错 ⇒ 「靠生成端自检兜住」是错的 ⇒ 显式守卫必要
    expect(wrong).toBeGreaterThan(0);
    console.info(`[A7] 自检放行，但按字节切错${wrong}/${(selfChecked as ChapterToc).chapters.length} 章`);

    // ★被测行为：走真链路（缓存含 CR）⇒ 必须不落 toc
    const task = seedTask('A7末尾局部CR.txt', mixed);
    const books = await ubs.__processOversizedBooksForTests([task]);
    expect(books).toHaveLength(1);
    expect(mockFs.files.has(`${task.cachePath}.toc`)).toBe(false);
  });
});

describe('B8 形状组：两条落盘路径共用一份「全有或全无」实现', () => {
  it('B1 `writeTocIfPossible` 是唯一的 toc 落盘入口（不得各写一份）', () => {
    const i = ubsSrc.indexOf('export async function writeTocIfPossible');
    expect(i).toBeGreaterThan(-1);
    const body = ubsSrc.slice(i, ubsSrc.indexOf('async function processOversizedBooks', i));
    // 正例锚点：真的写了 `${cachePath}.toc`
    expect(body).toContain('${cachePath}.toc');
    // ★反向对照：`processOversizedBooks` 体内**不得**再有直接写 toc 的字面量
    //（若有人绕过共用函数自己写一份 ⇒ 全有或全无语义出现第二个实现）
    const j = ubsSrc.indexOf('async function processOversizedBooks');
    expect(j).toBeGreaterThan(-1);
    const q = ubsSrc.slice(j, ubsSrc.indexOf('function notifyUserBooksChanged', j));
    expect(q).not.toContain('${t.cachePath}.toc');
    //阴性对照：`.gxbook.toc` 字面量在全仓确实存在（否则上面的 0 是「压根没实现」）
    expect(ubsSrc).toContain('.gxbook.toc');
  });

  it('B2 回退分支与完整解析分支都调用同一个共用函数（位置 + 调用数 ≥2）', () => {
    const hits = ubsSrc.match(/await writeTocIfPossible\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('B3 CR 守卫用抽出的纯函数，不是散落的内联判断（口径唯一）', () => {
    const j = ubsSrc.indexOf('async function processOversizedBooks');
    const q = ubsSrc.slice(j, ubsSrc.indexOf('function notifyUserBooksChanged', j));
    expect(q).toContain('tocOffsetBaseMatchesCache(raw)');
    // 守卫的「拒下」方向必须成对出现（else 分支），不能只写 if
    expect(q).toMatch(/if \(tocOffsetBaseMatchesCache\(raw\)\) \{/);
  });
});