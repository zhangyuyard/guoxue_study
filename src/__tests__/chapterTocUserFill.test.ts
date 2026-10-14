/**
 * ★运行时行为判据：用户书目录态 → 按 `.gxbook.toc` 字节区间切片装配（步骤 6）。
 *
 * ★为什么必须单独一个文件（不并入 `chapterTocConsume.test.ts`）：
 *   这里要**mock `react-native-fs`** 造真实字节流，而那个文件的纯函数组
 *   不需要 mock；且这里**绝不能用 `jest.resetModules()`** —— 那会让本文件
 *   顶层 import 的 `TextLibraryService` 与被测模块内require 的**成为两个实例**，
 *   判据就会去查一个空注册表（我自己先写过一版，正是这个错）。
 *
 * ★M3 变异为什么必须有本组（实测红 0 条的复盘）：
 *   变异「用户书在 `fillBuiltinChapterNow` 里又无条件早退」**保留了**
 *   `isUserBook` 与 `loadUserBookToc` 两个字面量（只是走不到）
 *   ⇒ 任何源码文本断言都测不出差别 ⇒ **只能测行为**。
 *
 * ★mock 边界（记忆：mock 会把缺陷测成正确，已 3 次）：
 *   只 mock **IO 边界**（RNFS）。`TextLibraryService` / `UserBookService` /
 *   `parseTxtBook` / `buildTocFromBook` 全用真实现——
 *   期望值由真 `parseTxtBook` 产出，oracle 不与被测路径共用代码。
 */
/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('react-native-fs', () => {
  // ⚠ 状态**必须**在 mock 模块内自持：`jest.mock` 工厂在业务 import 之前求值，
  //   任何从外部传进来的变量此刻都还没赋值（试过挂globalThis ⇒ 必抛
  //   「mock 未拿到状态」⇒ Tests: 0 total＝仪器坏了，不是判据结果）。
  const state = {
    /** 路径 → 文件文本（真实字节流的来源） */
    files: new Map<string, string>(),
    /** 所有 RNFS.read 调用（path, len, pos, enc） */
    reads: [] as Array<{ path: string; len: number; pos: number; enc: string }>,
    /** 所有 RNFS.readFile 调用 */
    readFiles: [] as string[],
    /** 让 .toc 读取抛错（负例注入） */
    tocUnavailable: false,
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
    // RNFS.read(path, len, pos, enc)：按**字节**区间读（len/pos 是字节，不是字符）
    read: jest.fn(async (p: string, len: number, pos: number, enc: string) => {
      state.reads.push({ path: p, len, pos, enc });
      const b = bufOf(p);
      const slice = b.subarray(pos, pos + len);
      return enc === 'base64' ? slice.toString('base64') : slice.toString('utf8');
    }),
    stat: jest.fn(async (p: string) => ({ path: p, size: bufOf(p).length })),
    readDir: jest.fn(async () => []),
    copyFileAssets: jest.fn(async () => undefined),
    readFileAssets: jest.fn(async () => {
      throw new Error('本用例不涉及内置书资产');
    }),
    __rnfsState: state,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __rnfsState: RNFS_STATE } = require('react-native-fs');

import { buildTocFromBook, normalizeForCache, type ChapterToc } from '@/services/chapterToc';
import { TextLibraryService, USER_BOOK_PREFIX } from '@/services/TextLibraryService';
import {
  __registerOversizedFileForTests,
  __resetAssemblyStateForTests,
  fillBuiltinChapterNow,
  parseTxtBook,
} from '@/services/UserBookService';
import type { Book } from '@/types';

const BOOK = `${USER_BOOK_PREFIX}step6`;
const SRC = '/books/step6.txt';
const CACHE = '/books/step6.txt.gxbook';

/** 三章，覆盖多段章 / CRLF / 空行段三种形态 */
const RAW =
  '前言一句。\n第一章 甲\n内容一。\n\n内容二。\n第二章 乙\r\n内容三。\n第三章 丙\n内容四。\n\n内容五。';

const norm = normalizeForCache(RAW);
const full = parseTxtBook('step6.txt', RAW, BOOK, { sourceLabel: 'TXT' });
const toc = buildTocFromBook(full, norm) as ChapterToc;

/** 目录态书：只有 toc 元数据，`segments` 全空 */
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
  RNFS_STATE.tocUnavailable = false;
  RNFS_STATE.files.clear();
  // 真实字节流：缓存正文（归一化后，与落盘口径一致）+ toc + meta
  RNFS_STATE.files.set(CACHE, norm);
  RNFS_STATE.files.set(`${CACHE}.toc`, JSON.stringify(toc));
  RNFS_STATE.files.set(`${CACHE}.meta`, JSON.stringify({ v: 1, title: '样本书', author: '佚名' }));
  __registerOversizedFileForTests(BOOK, SRC, CACHE);
  const reg = TextLibraryService.registerUserBooks([makeShellBook()]);
  expect(reg.success).toBe(true);
  // 前置：确认样本本身非平凡（否则下面全是「恒真」假绿）
  expect(toc.chapters.length).toBeGreaterThan(1);
  expect(full.chapters.some((c) => c.segments.length > 1)).toBe(true);
});

describe('★用户书目录态 → 按 toc 切片装配（端到端行为）', () => {
  it('★逐章装配：正文与全量解析**逐段相等**（段 id 不漂 ⇒ FTS/划线/笔记锚点有效）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    expect(shell.chapters.every((c) => c.segments.length === 0)).toBe(true);

    for (let i = 0; i < shell.chapters.length; i += 1) {
      const cid = shell.chapters[i].id;
      // eslint-disable-next-line no-await-in-loop
      const ok = await fillBuiltinChapterNow(BOOK, cid, true);
      expect(ok).toBe(true);
      const got = TextLibraryService.getChapter(cid);
      expect(got.success).toBe(true);
      expect(got.data?.segments.map((s) => s.text)).toEqual(
        full.chapters[i].segments.map((s) => s.text),
      );
      // 段号 1..N 连续（不重不截）
      expect(got.data?.segments.map((s) => s.id)).toEqual(
        full.chapters[i].segments.map((s) => s.id),
      );
    }
    expect(TextLibraryService.getBook(BOOK).data?.chapters.every(
      (c) => c.segments.length > 0,
    )).toBe(true);
  });

  it('★装配只读该章的字节区间（不整读全文——收益点）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const first = shell.chapters[0];
    await fillBuiltinChapterNow(BOOK, first.id, true);

    const bodyReads = RNFS_STATE.reads.filter((r) => r.path === CACHE);
    expect(bodyReads.length).toBeGreaterThan(0);
    // ★读到的最大字节必须**远小于**整个正文长度（整读就是白改）
    const maxEnd = Math.max(...bodyReads.map((r) => r.pos + r.len));
    const byteLen = Buffer.byteLength(norm, 'utf8');
    expect(maxEnd).toBeLessThanOrEqual(first.byteEnd as number);
    expect(maxEnd).toBeLessThan(byteLen);
    // 阳性对照：样本确实有第二、三章的正文（否则上面「小于全长」没有鉴别力）
    expect(byteLen).toBeGreaterThan((first.byteEnd as number) + 20);
  });

  it('★装配读的是 `.gxbook` 缓存而非源文件（口径一致 ⇒ 偏移不错位）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    await fillBuiltinChapterNow(BOOK, shell.chapters[0].id, true);
    expect(RNFS_STATE.reads.every((r) => r.path === CACHE)).toBe(true);
    // 曾经读过 `.toc`（证明走的是 toc 通道而非别处）
    expect(RNFS_STATE.readFiles.some((p) => p === `${CACHE}.toc`)).toBe(true);
  });

  it('★toc 不可用 ⇒ 返回 false 且**不写半个章**（全有或全无，防永久截断章）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const cid = shell.chapters[0].id;
    RNFS_STATE.tocUnavailable = true;
    const ok = await fillBuiltinChapterNow(BOOK, cid, true);
    expect(ok).toBe(false);
    // 关键：不得留下部分正文（否则 `segments.length > 0` 判据会当成已就绪）
    expect(TextLibraryService.getChapter(cid).data?.segments.length).toBe(0);
  });

  it('★章id 不在 toc 里 ⇒ 返回 false（不静默读别章）', async () => {
    expect(await fillBuiltinChapterNow(BOOK, `${BOOK}-c999`, true)).toBe(false);
  });

  it('未登记缓存位置（`oversizedBookFiles` 缺失）⇒ 返回 false（回退全量读语义）', async () => {
    const orphan = `${USER_BOOK_PREFIX}orphan6`;
    TextLibraryService.registerUserBooks([
      {
        ...makeShellBook(),
        id: orphan,
        chapters: makeShellBook().chapters.map((c) => ({ ...c, bookId: orphan })),
      },
    ]);
    expect(await fillBuiltinChapterNow(orphan, `${orphan}-c1`, true)).toBe(false);
  });

  it('force=false 且已有正文 ⇒ 幂等短路（不重复装配）', async () => {
    const shell = TextLibraryService.getBook(BOOK).data as Book;
    const cid = shell.chapters[0].id;
    expect(await fillBuiltinChapterNow(BOOK, cid, true)).toBe(true);
    const before = TextLibraryService.getChapter(cid).data?.segments.length;
    RNFS_STATE.reads.length = 0;
    expect(await fillBuiltinChapterNow(BOOK, cid, false)).toBe(true);
    expect(RNFS_STATE.reads.length).toBe(0);
    expect(TextLibraryService.getChapter(cid).data?.segments.length).toBe(before);
  });
});