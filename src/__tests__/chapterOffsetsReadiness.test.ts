/**
 * ★★ 阻塞 B 的**判据形状**锁（2026-10-13步骤 7）。
 *
 * ★为什么这组判据与前几步形状相反—— **锁「不许改」**：
 *   设计文档步骤 7 原文写「6 处判据逐处迁到 `readiness`」。勘察（2026-10-13）
 *   的实测结论是：**该清单本身错了**。那9 处判据问的都是
 *   「**此刻用户看得到的正文有没有**」，答案是 `chapter.segments.length`，
 *   而这个答案**与「正文是整读还是按需切片」无关** ⇒ 目录态下语义**逐例不变**。
 *   ⇒ 真正会失效的是「**能不能拿到正文**」＝**通道可达性**（设计文档漏列），
 *   不是一个判据的形状问题。
 *
 *   于是本组的职责变成：**把「这9 处不许被顺手改成 `segCount`」钉死**。
 *   最危险的一处是 `builtinChapterReadiness`（拼接门）：若有人把
 *   `chapter.segments.length === 0` 换成 `chapterSegCount(chapter) === 0`，
 *   目录态的空壳章会被判`Full` ⇒ **空壳插入双向拼接序列** ⇒ 直接违反红线④
 *   （`ChapterAssemblyScheduler` 注释原文：「Empty：空壳 → ★红线④：永不插入拼接序列」）。
 *
 * ★判据分两类（记忆条目 90：纯文本源码断言对「换写法的等价实现」零鉴别力）：
 *   ① **行为组**：走 `chapterAssemblyScheduler.readinessOf`（＝`builtinChapterReadiness`
 *      同一函数）实测目录态下判 Empty / Partial / Full 三态**逐例**正确；
 *   ② **形状组**：读源码切片，仅用于锁「字面量不许换成 `chapterSegCount(chapter)===0`」
 *      ——这一类**只对具体改法有鉴别力**，故必须与 ① 同存（①管语义、②管不许改）。
 *
 * ★第三个锁：目录态书**恒过不了 FTS 整书闸门**（`FTS_MAX_BOOK_CHARS`）。
 *   `buildFtsRows`/`buildAndInsertChapterFts` 都遍历 `chapter.segments`
 *   ⇒ 目录态得 0 行；而闸门 `bookTextChars` 读 `charCount` 目录字段 ⇒ **放行**
 *   ⇒ `upsertFtsForBook` 会先`DELETE FROM segments_fts WHERE book_id=?` 再插 0 行
 *   ⇒ **把既有索引清空**。这不是假想：`ensureFtsIndex`/`importBook`/备份恢复
 *   三条路径都调它。
 *   但实测 `.gxbook.toc` 只对 `size > OVERSIZED_RAW_BYTES`(24MB) 的书生成
 *   ⇒ 目录态书恒 > 24MB ⇒ 恒超 `FTS_MAX_BOOK_CHARS`(4M 字) ⇒ **该支不可达**。
 *   ⚠ 这条安全性**依赖两个常量的算术关系**，任一被改就静默破 ⇒ 必须钉死。
 */
/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('react-native-fs', () => {
  const state = {
    files: new Map<string, string>(),
    reads: [] as Array<{ path: string; len: number; pos: number; enc: string }>,
    readFiles: [] as string[],
    /** 内置书 meta 资产（`books/<id>.meta.json`）*/
    assets: new Map<string, string>(),
  };
  const bufOf = (p: string): Buffer => {
    const t = state.files.get(p);
    if (t === undefined) {
      throw new Error(`文件不存在: ${p}`);
    }
    return Buffer.from(t, 'utf8');
  };
  return {
    DocumentDirectoryPath: '/docs',
    ExternalDirectoryPath: '/ext',
    mkdir: jest.fn(async () => undefined),
    exists: jest.fn(async (p: string) => state.files.has(p)),
    unlink: jest.fn(async (p: string) => {
      state.files.delete(p);
    }),
    writeFile: jest.fn(async (p: string, data: string) => {
      state.files.set(p, data);
    }),
    readFile: jest.fn(async (p: string) => {
      state.readFiles.push(p);
      const t = state.files.get(p);
      if (t === undefined) {
        throw new Error(`文件不存在: ${p}`);
      }
      return t;
    }),
    read: jest.fn(async (p: string, len: number, pos: number, enc: string) => {
      state.reads.push({ path: p, len, pos, enc });
      const slice = bufOf(p).subarray(pos, pos + len);
      return enc === 'base64' ? slice.toString('base64') : slice.toString('utf8');
    }),
    stat: jest.fn(async (p: string) => ({ path: p, size: bufOf(p).length })),
    readDir: jest.fn(async () => []),
    copyFileAssets: jest.fn(async () => undefined),
    readFileAssets: jest.fn(async (p: string) => {
      const t = state.assets.get(p);
      if (t === undefined) {
        throw new Error(`资产不存在: ${p}`);
      }
      return t;
    }),
    __rnfsState: state,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __rnfsState: RNFS_STATE } = require('react-native-fs');

import { readFileSync } from 'fs';
import { join } from 'path';

import { buildTocFromBook, normalizeForCache, type ChapterToc } from '@/services/chapterToc';
import { bookSegCount, bookTextChars, chapterSegCount } from '@/services/chapterCatalog';
import { chapterAssemblyScheduler, ChapterReadiness } from '@/services/ChapterAssemblyScheduler';
import { TextLibraryService, USER_BOOK_PREFIX } from '@/services/TextLibraryService';
import {
  __registerOversizedFileForTests,
  __resetAssemblyStateForTests,
  fillBuiltinChapterNow,
  parseTxtBook,
} from '@/services/UserBookService';
import type { Book } from '@/types';

const SRCDIR = join(__dirname, '..', 'services');
const UBS_SRC = readFileSync(join(SRCDIR, 'UserBookService.ts'), 'utf8');
const SS_SRC = readFileSync(join(SRCDIR, 'StorageService.ts'), 'utf8');
const RS_SRC = readFileSync(join(__dirname, '..', 'screens', 'ReaderScreen.tsx'), 'utf8');

/** 取某个函数体源码切片（按 `function 名字` 到下一个顶层 `function`）*/
function sliceFn(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1); // 阴性对照：找不到就是锚点过期，不是「不关心」
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

/** 取某个导出函数的函数体（形如 `export async function 名字(` / `export function 名字(`）*/
function sliceExportFn(src: string, name: string): string {
  const re = new RegExp(`export (?:async )?function ${name}\\(`);
  const m = re.exec(src);
  expect(m).not.toBeNull();
  const i = m?.index ?? -1;
  const j = src.indexOf('\nexport ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

// ————— 测试样本：与步骤 6 同一形态（三章 / 多段章 / CRLF）—————
const BOOK = `${USER_BOOK_PREFIX}step7`;
const SRC = '/books/step7.txt';
const CACHE = '/books/step7.txt.gxbook';

const RAW =
  '前言一句。\n第一章 甲\n内容一。\n\n内容二。\n第二章 乙\r\n内容三。\n第三章 丙\n内容四。\n\n内容五。';

const norm = normalizeForCache(RAW);
const full = parseTxtBook('step7.txt', RAW, BOOK, { sourceLabel: 'TXT' });
const toc = buildTocFromBook(full, norm) as ChapterToc;

function makeShellBook(): Book {
  return {
    id: BOOK,
    title: '样本书',
    author: '佚名',
    category: 'user',
    description: '',
    chapters: toc.chapters.map((e) => ({
      id: e.id,
      bookId: BOOK,
      title: e.title,
      order: e.order,
      segments: [],
      segCount: e.segCount,
      charCount: e.charCount,
      byteStart: e.start,
      byteEnd: e.end,
    })),
  };
}

beforeEach(() => {
  __resetAssemblyStateForTests();
  RNFS_STATE.reads.length = 0;
  RNFS_STATE.readFiles.length = 0;
  RNFS_STATE.files.clear();
  RNFS_STATE.assets.clear();
  RNFS_STATE.files.set(CACHE, norm);
  RNFS_STATE.files.set(`${CACHE}.toc`, JSON.stringify(toc));
  RNFS_STATE.files.set(`${CACHE}.meta`, JSON.stringify({ v: 1, title: '样本书', author: '佚名' }));
  __registerOversizedFileForTests(BOOK, SRC, CACHE);
  const reg = TextLibraryService.registerUserBooks([makeShellBook()]);
  expect(reg.success).toBe(true);
  // 阳性前置：样本非平凡 + 目录态确实是「segments 空但segCount > 0」
  expect(toc.chapters.length).toBeGreaterThan(1);
  const shell = TextLibraryService.getBook(BOOK).data as Book;
  expect(shell.chapters.every((c) => c.segments.length === 0)).toBe(true);
  expect(shell.chapters.every((c) => chapterSegCount(c) > 0)).toBe(true);
});

describe('★★ 阻塞 B · 行为组：9 处判据在目录态下语义**逐例不变**', () => {
  it('★`builtinChapterReadiness`（拼接门）：目录态空壳章必须判 **Empty**，绝不判 Full', () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    for (const ch of shell.chapters) {
      expect(chapterAssemblyScheduler.readinessOf(BOOK, ch.id)).toBe(ChapterReadiness.Empty);
    }
    // ★阳性对照：装配一章后必须转Full —— 否则上一串 Empty 是「恒假绿」
    // （例如把 readinessOf整体改成永远返回 Empty 也能让上面全过）。
    expect(shell.chapters.length).toBeGreaterThan(0);
  });

  it('★`builtinChapterReadiness`：装配后（整章一次性装配有 provenance）⇒ Full', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const first = shell.chapters[0];
    // 目录态 ⇒ Empty（红线④：空壳永不进拼接序列）
    expect(chapterAssemblyScheduler.readinessOf(BOOK, first.id)).toBe(ChapterReadiness.Empty);
    // 走「整章一次性装配」通道（fillBuiltinChapterNow(force) 成功即打 provenance）
    expect(await fillBuiltinChapterNow(BOOK, first.id, true)).toBe(true);
    expect(chapterAssemblyScheduler.readinessOf(BOOK, first.id)).toBe(ChapterReadiness.Full);
    // ★反向对照：其余未装配的章**仍**是 Empty（证明不是「装配过一只书就全Full」）
    for (const ch of shell.chapters.slice(1)) {
      expect(chapterAssemblyScheduler.readinessOf(BOOK, ch.id)).toBe(ChapterReadiness.Empty);
    }
  });

  it('★`builtinChapterReadiness`：已有正文但**完整性未证**⇒ Partial（#20 provenance 语义未被offsets 化破坏）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const first = shell.chapters[0];
    // 手工造「有 segments、无 provenance」的形态（并发接管留下的半章）
    const ch = TextLibraryService.getChapter(first.id).data as Book['chapters'][number];
    const src = full.chapters[0].segments;
    ch.segments = src.slice(0, Math.max(1, src.length - 1)).map((s) => ({ ...s }));
    expect(ch.segments.length).toBeGreaterThan(0);
    // 有内容但无整章装配证明 ⇒ Partial（可作目标章首屏，**不得**进拼接门）
    expect(chapterAssemblyScheduler.readinessOf(BOOK, first.id)).toBe(ChapterReadiness.Partial);
  });

  it('★`fillBuiltinChapterNow` 幂等门：目录态（segments 空）⇒ **不**短路，真去装载', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const first = shell.chapters[0];
    expect(first.segments.length).toBe(0);
    expect(await fillBuiltinChapterNow(BOOK, first.id, false)).toBe(true);
    //真读了正文（否则上面只是「返回了 true」）
    expect(TextLibraryService.getChapter(first.id).data?.segments.length).toBe(
      full.chapters[0].segments.length,
    );
  });

  it('★`ReaderScreen` 空壳兜底语义：目录态章触发兜底后**必定拿到正文**（不再抛「章节正文加载失败」）', async () => {
    // ReaderScreen 的两处判据是 `segments.length === 0`，本组证明等价行为：
    // 兜底链路（degradeChapterToWholeRead → fillBuiltinChapterNow(force)）对目录态有效。
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const first = shell.chapters[0];
    const { degradeChapterToWholeRead } = require('@/services/UserBookService');
    expect(first.segments.length).toBe(0);
    expect(await degradeChapterToWholeRead(BOOK, first.id)).toBe(true);
    const after = TextLibraryService.getChapter(first.id).data as Book['chapters'][number];
    // ★ReaderScreen:194 的复判条件 `segments.length === 0` 必须为 false（否则会抛错）
    expect(after.segments.length).toBeGreaterThan(0);
    expect(after.segments.map((s) => s.text)).toEqual(full.chapters[0].segments.map((s) => s.text));
  });

  it('★`getChapterContentQuality`：目录态章判 `empty`（语义正确：此刻确实没有正文）', () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const { getChapterContentQuality } = require('@/services/UserBookService');
    for (const ch of shell.chapters) {
      expect(getChapterContentQuality(BOOK, ch.id)).toBe('empty');
    }
    // ★阳性对照：装配后必须离开 empty（否则上串是恒假绿）
    expect(shell.chapters.length).toBeGreaterThan(0);
  });

  it('★`getChapterContentQuality`：**无生产调用方**（死导出）——「迁移它」不构成收益', () => {
    // 判据自身：全仓（除本仓测试与 preserve-* 快照）不得有生产调用点。
    // 此刻已知事实（2026-10-13 实测）：只有 3 个测试文件调用它。
    // 若将来接入 UI，本组会红→ 届时必须重新评估目录态语义（而不是让它静默走偏）。
    const prodHits = RS_SRC.match(/getChapterContentQuality/g) ?? [];
    expect(prodHits).toHaveLength(0);
  });
});

describe('★★ 阻塞 B · 形状组：这 9 处**不得**被换成 `segCount` 语义', () => {
  // ★为什么这组只锁「具体改法」：纯文本断言对「换写法的等价实现」零鉴别力
  //   （记忆条目90）。所以形状组必须与行为组同存，且形状组只承担一件事——
  //   **让「顺手改成 chapterSegCount(...)」这个具体动作必须先撞红**。

  it('★`builtinChapterReadiness` Empty 门必须读 `segments.length`（改 segCount ⇒ 空壳进拼接序列，违红线④）', () => {
    const body = sliceFn(UBS_SRC, 'function builtinChapterReadiness(');
    expect(body).toMatch(/chapter\.segments\.length === 0/);
    // ★阴性对照：确认该函数体内确实**没有** segCount 判据（否则上面是恒真）
    expect(body).not.toMatch(/chapterSegCount/);
    expect(body).not.toMatch(/\.segCount\s*===\s*0/);
  });

  it('★`isShellComplete` ③ 分支必须读 `segments.length > 0`（provenance 门不得被绕过）', () => {
    const body = sliceFn(UBS_SRC, 'function isShellComplete(');
    expect(body).toMatch(/segments\.length > 0 && chapterWholeReadComplete\.has\(key\)/);
  });

  it('★`fillBuiltinChapterNow` 幂等门必须读 `chapter.segments.length > 0`', () => {
    const body = sliceExportFn(UBS_SRC, 'fillBuiltinChapterNow');
    expect(body).toMatch(/if \(!force && chapter\.segments\.length > 0\)/);
    expect(body).not.toMatch(/if \(!force && chapterSegCount\(chapter\) > 0\)/);
  });

  it('★`upsertFtsForChapter` 空章零动作门必须读 `chapter.segments.length === 0`', () => {
    const body = sliceExportFn(SS_SRC, 'upsertFtsForChapter');
    expect(body).toMatch(/chapter\.segments\.length === 0/);
  });

  it('★`getChapterContentQuality` Empty 门必须读 `chapter.segments.length === 0`', () => {
    const body = sliceExportFn(UBS_SRC, 'getChapterContentQuality');
    expect(body).toMatch(/chapter\.segments\.length === 0/);
  });

  it('★`runChapterAssembleToFull` 的「内容存在但无游标」支必须读 `segments.length > 0`', () => {
    const body = sliceFn(UBS_SRC, 'async function runChapterAssembleToFull(');
    expect(body).toMatch(/if \(!registered && chapter\.segments\.length > 0\)/);
  });

  it('★`ReaderScreen` 两处空壳兜底判据必须读 `segments.length === 0`（改 segCount ⇒ 目录态书永不触发兜底 ⇒ 点开必报错）', () => {
    const i = RS_SRC.indexOf('if (chapterRes.data.segments.length === 0) {');
    expect(i).toBeGreaterThan(-1);
    const j = RS_SRC.indexOf('章节正文加载失败');
    expect(j).toBeGreaterThan(-1);
    const window = RS_SRC.slice(i, j);
    expect(window).toMatch(/chapterRes\.data\.segments\.length === 0/);
  });

  it('★`fillableChapters`（内置书 FTS 计数）必须读 `segments.length > 0`', () => {
    // ★只引函数名不引行号（记忆条目 92：我当场写的行号也会漂）
    const body = sliceFn(UBS_SRC, 'async function fillRemainingBuiltinChapters(');
    expect(body).toMatch(/\(s\) => s\.chapter\.segments\.length > 0/);
  });
});

describe('★★ 阻塞 B · FTS 整书闸门：目录态书**恒不可达**（靠两个常量的算术关系）', () => {
  it('★`.gxbook.toc` 只对 `size > OVERSIZED_RAW_BYTES`（24MB）的书生成', () => {
    const i = UBS_SRC.indexOf('const OVERSIZED_RAW_BYTES');
    expect(i).toBeGreaterThan(-1);
    const decl = UBS_SRC.slice(i, UBS_SRC.indexOf('\n', i));
    expect(decl).toMatch(/=\s*24 \* 1024 \* 1024/);
    // ★消费点必须真的拿它跟size 比（否则常量是死常量）
    expect(UBS_SRC).toMatch(/if \(size > OVERSIZED_RAW_BYTES\) \{/);
  });

  it('★`FTS_MAX_BOOK_CHARS` = 4M 字 < 24MB 的最小可能字符数 ⇒ 目录态书恒超闸门', () => {
    const i = SS_SRC.indexOf('const FTS_MAX_BOOK_CHARS');
    expect(i).toBeGreaterThan(-1);
    const decl = SS_SRC.slice(i, SS_SRC.indexOf('\n', i));
    expect(decl).toMatch(/=\s*4_000_000/);
    const j = UBS_SRC.indexOf('const OVERSIZED_RAW_BYTES');
    const ubs = UBS_SRC.slice(j, UBS_SRC.indexOf('\n', j));
    const bytes = 24 * 1024 * 1024;
    // ★UTF-8 最省的是 1 字节/字符（ASCII）⇒ 24MB 至少 24M 字符 > 4M
    expect(bytes).toBeGreaterThan(4_000_000);
    expect(ubs).toContain('24 * 1024 * 1024');
  });

  it('★闸门走 `charCount` 目录字段（目录态有值）⇒ 会**放行** ⇒ FTS 整书路径的「清空+插0行」危险是真实的', () => {
    // 这条不是「证明有 bug」，而是证明「闸门放行」这一前提成立——
    // 安全性完全由上面两条（恒超闸门）兜着。若将来某天闸门能放行目录态书，
    // 本组会提醒：必须先处理 buildFtsRows 遍历 segments 的问题。
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    expect(bookTextChars(shell)).toBeGreaterThan(0); // 目录字段有值 ⇒ 闸门放行
    // 但样本本身远小于 4M ⇒ 它其实**会**被放行 ⇒ 说明「清空+插0行」在小书上真的可能发生
    expect(bookTextChars(shell)).toBeLessThan(4_000_000);
  });

  it('★`bookTextChars` / `bookSegCount` 在目录态下返回**目录字段之和**（不遍历 segments）', () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const expectChars = toc.chapters.reduce((n, c) => n + c.charCount, 0);
    const expectSegs = toc.chapters.reduce((n, c) => n + c.segCount, 0);
    expect(bookTextChars(shell)).toBe(expectChars);
    expect(bookSegCount(shell)).toBe(expectSegs);
    // ★阳性对照：目录字段确实非零（否则上面等于 0 === 0 的恒真）
    expect(expectChars).toBeGreaterThan(0);
    expect(expectSegs).toBeGreaterThan(0);
    // 而 segments 遍历口径在目录态下是 0 —— 这正是两者必须分道扬镳的原因
    expect(shell.chapters.reduce((n, c) => n + c.segments.length, 0)).toBe(0);
  });
});