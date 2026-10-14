/**
 * ★★ 调度器**主路径**对目录态用户书的端到端行为判据（2026-10-13 步骤 7）。
 *
 * ★为什么必须有这个文件（`chapterOffsetsReadiness.test.ts` 只锁形状与就绪判据）：
 *   步骤 7 的勘察结论是「设计文档的『6 处判据迁移』清单本身错了，真正阻塞是
 *   **通道可达性**」。本文件就是那条通路的**行为证据**。
 *
 * ★被测行为（优化前实测为 false / 无效果）：
 *   `runChapterAssembleToFull` 首行 `getBuiltinSpec(bookId)` 对用户书恒 null
 *   ⇒ 调度器执行器对用户书**恒早退**；
 *   `prefillBuiltinNeighbors` 同样早退 ⇒ 邻章预热对用户书恒失效。
 *   后果：目录态用户书**首开能看**（走 `fillBuiltinChapterNow` 兜底路径），
 *   但**邻章永远装不上** ⇒ 只能一章一章跳、不能连续滚动阅读。
 *
 * ★mock 边界（记忆：mock 会把缺陷测成正确，已 3 次）：
 *   只 mock **IO 边界**（RNFS）。`TextLibraryService` / `UserBookService` /
 *   `parseTxtBook` / `buildTocFromBook` / `ChapterAssemblyScheduler` 全用真实现。
 *   期望值由真 `parseTxtBook` 产出—— oracle 不与被测路径共用代码。
 *
 * ★为什么**不用** `jest.resetModules()`（同 `chapterTocUserFill` 的教训）：
 *   那会让本文件顶层 import 的 `TextLibraryService` 与被测模块内 require 的
 *   **成为两个实例**，判据就会去查一个空注册表。
 */
/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('react-native-fs', () => {
  const state = {
    files: new Map<string, string>(),
    reads: [] as Array<{ path: string; len: number; pos: number; enc: string }>,
    readFiles: [] as string[],
    tocUnavailable: false,
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
      if (p.endsWith('.toc') && state.tocUnavailable) {
        throw new Error('toc unavailable');
      }
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

import { buildTocFromBook, normalizeForCache, type ChapterToc } from '@/services/chapterToc';
import { chapterAssemblyScheduler, ChapterReadiness } from '@/services/ChapterAssemblyScheduler';
import { TextLibraryService, USER_BOOK_PREFIX } from '@/services/TextLibraryService';
import {
  __registerOversizedFileForTests,
  __resetAssemblyStateForTests,
  assembleChapterToFull,
  fillBuiltinChapterNow,
  parseTxtBook,
  prefillBuiltinNeighbors,
} from '@/services/UserBookService';
import type { Book } from '@/types';

const BOOK = `${USER_BOOK_PREFIX}step7sched`;
const SRC = '/books/step7sched.txt';
const CACHE = '/books/step7sched.txt.gxbook';

/** 三章 / 多段章 / CRLF，与步骤 5/6 同一形态（偏移口径一致才谈得上复用通道） */
const RAW =
  '前言一句。\n第一章 甲\n内容一。\n\n内容二。\n第二章 乙\r\n内容三。\n第三章 丙\n内容四。\n\n内容五。';

const norm = normalizeForCache(RAW);
const full = parseTxtBook('step7sched.txt', RAW, BOOK, { sourceLabel: 'TXT' });
const toc = buildTocFromBook(full, norm) as ChapterToc;

function makeShellBook(): Book {
  return {
    id: BOOK,
    title: '调度器样本书',
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
  RNFS_STATE.tocUnavailable = false;
  RNFS_STATE.files.clear();
  RNFS_STATE.assets.clear();
  RNFS_STATE.files.set(CACHE, norm);
  RNFS_STATE.files.set(`${CACHE}.toc`, JSON.stringify(toc));
  RNFS_STATE.files.set(`${CACHE}.meta`, JSON.stringify({ v: 1, title: '调度器样本书', author: '佚名' }));
  __registerOversizedFileForTests(BOOK, SRC, CACHE);
  const reg = TextLibraryService.registerUserBooks([makeShellBook()]);
  expect(reg.success).toBe(true);
  // 前置：样本非平凡且真的是目录态
  expect(toc.chapters.length).toBeGreaterThan(1);
  const shell = TextLibraryService.getBook(BOOK).data as Book;
  expect(shell.chapters.every((c) => c.segments.length === 0)).toBe(true);
  expect(shell.chapters.every((c) => (c.segCount ?? 0) > 0)).toBe(true);
});

describe('★★ 调度器主路径 → 目录态用户书（端到端行为）', () => {
  it('★`assembleChapterToFull`：目录态章**真能被装配**（优化前恒false）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const target = shell.chapters[1]; // 邻章（非首章）：这是「连续滚动」的实际场景
    expect(target.segments.length).toBe(0);

    const ok = await assembleChapterToFull(BOOK, target.id);
    expect(ok).toBe(true);

    const got = TextLibraryService.getChapter(target.id);
    expect(got.success).toBe(true);
    // ★逐段相等 + 段 id 不漂（漂了则 FTS/划线/笔记锚点全部失效）
    expect(got.data?.segments.map((s) => s.text)).toEqual(
      full.chapters[1].segments.map((s) => s.text),
    );
    expect(got.data?.segments.map((s) => s.id)).toEqual(
      full.chapters[1].segments.map((s) => s.id),
    );
    // 就绪级别必须同步转 Full（否则调度器仍会反复重排它）
    expect(chapterAssemblyScheduler.readinessOf(BOOK, target.id)).toBe(ChapterReadiness.Full);
  });

  it('★装配只读该章的字节区间（复用 toc 通道，不整读全文）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const target = shell.chapters[1];
    await assembleChapterToFull(BOOK, target.id);

    const bodyReads = RNFS_STATE.reads.filter((r) => r.path === CACHE);
    expect(bodyReads.length).toBeGreaterThan(0);
    const maxEnd = Math.max(...bodyReads.map((r) => r.pos + r.len));
    const byteLen = Buffer.byteLength(norm, 'utf8');
    expect(maxEnd).toBeLessThanOrEqual(target.byteEnd as number);
    // ★阳性对照：样本后面确实还有别的章正文（否则「小于全长」没有鉴别力）
    expect(byteLen).toBeGreaterThan((target.byteEnd as number) + 20);
    // 读的是缓存而非源文件
    expect(RNFS_STATE.reads.every((r) => r.path === CACHE)).toBe(true);
  });

  it('★`prefillBuiltinNeighbors`：对目录态用户书**提交**邻章并真的装上（双向）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const cur = shell.chapters[1];
    expect(cur.segments.length).toBe(0);

    await prefillBuiltinNeighbors(BOOK, cur.id, 1);

    // ⚠ `prefillBuiltinNeighbors` 是**fire-and-forget**（只 `requestMany` 入队，
    //   执行由调度器 `pump()` 异步驱动）⇒ 判据必须显式 `awaitReadiness` 等待，
    //   否则会在装配完成前就断言（我自己先写了一版'提交即完成'的期望，
    //   读到 0 段 —— 那是**等待方式不对**，不是实现错）。
    await chapterAssemblyScheduler.awaitReadiness(
      BOOK, shell.chapters[0].id, ChapterReadiness.Full, 3000,
    );
    await chapterAssemblyScheduler.awaitReadiness(
      BOOK, shell.chapters[2].id, ChapterReadiness.Full, 3000,
    );

    // 前后邻章都应被装上（这是「能连续滚动」的判据）
    const prev = TextLibraryService.getChapter(shell.chapters[0].id);
    const next = TextLibraryService.getChapter(shell.chapters[2].id);
    expect(prev.data?.segments.length).toBe(full.chapters[0].segments.length);
    expect(next.data?.segments.length).toBe(full.chapters[2].segments.length);
    expect(prev.data?.segments.map((s) => s.text)).toEqual(
      full.chapters[0].segments.map((s) => s.text),
    );
    expect(next.data?.segments.map((s) => s.text)).toEqual(
      full.chapters[2].segments.map((s) => s.text),
    );
    // 中心章**不由预热装配**（prefill 只管邻居；且它是 Empty 才该保持Empty）
    expect(TextLibraryService.getChapter(cur.id).data?.segments.length).toBe(0);
  });

  it('★toc不可用 ⇒ 调度器路径返回 false 且**不写半个章**（全有或全无）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const target = shell.chapters[1];
    RNFS_STATE.tocUnavailable = true;
    const ok = await assembleChapterToFull(BOOK, target.id);
    expect(ok).toBe(false);
    expect(TextLibraryService.getChapter(target.id).data?.segments.length).toBe(0);
  });

  it('★章 id 不在 toc 里 ⇒ 返回 false（不静默读别章）', async () => {
    expect(await assembleChapterToFull(BOOK, `${BOOK}-c999`)).toBe(false);
  });

  it('★未登记缓存位置（`oversizedBookFiles` 缺失）⇒ 返回 false（回退全量读语义）', async () => {
    const orphan = `${USER_BOOK_PREFIX}orphan7`;
    TextLibraryService.registerUserBooks([
      {
        ...makeShellBook(),
        id: orphan,
        chapters: makeShellBook().chapters.map((c) => ({ ...c, bookId: orphan })),
      },
    ]);
    expect(await assembleChapterToFull(orphan, `${orphan}-c1`)).toBe(false);
  });

  it('★已装配章重复调用幂等短路（不重复读、不重复 push 段）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const target = shell.chapters[0];
    expect(await assembleChapterToFull(BOOK, target.id)).toBe(true);
    const before = TextLibraryService.getChapter(target.id).data?.segments.length;
    RNFS_STATE.reads.length = 0;
    expect(await assembleChapterToFull(BOOK, target.id)).toBe(true);
    expect(RNFS_STATE.reads.length).toBe(0);
    expect(TextLibraryService.getChapter(target.id).data?.segments.length).toBe(before);
  });

  it('★兜底路径与调度器路径**产出逐段相等**（两条通道口径必须一致）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    // 第 0 章走调度器，第 2 章走兜底
    await assembleChapterToFull(BOOK, shell.chapters[0].id);
    await fillBuiltinChapterNow(BOOK, shell.chapters[2].id, true);
    const a = TextLibraryService.getChapter(shell.chapters[0].id).data;
    const b = TextLibraryService.getChapter(shell.chapters[2].id).data;
    expect(a?.segments.map((s) => s.text)).toEqual(
      full.chapters[0].segments.map((s) => s.text),
    );
    expect(b?.segments.map((s) => s.text)).toEqual(
      full.chapters[2].segments.map((s) => s.text),
    );
  });
});