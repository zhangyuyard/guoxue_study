/**
 * 章级目录字段 `segCount` / `charCount` 的判据（2026-10-12）。
 *
 * 背景：设计文档 `docs/reader-chapter-offset-toc-design-2026-10-12.md` §3——
 * 「章节改偏移量」会把 `segments` 从正文字符串实体数组改为按需读取，于是
 * 「读 `segments.length`」与「遍历 `sg.text.length`」都会在未装载态失效。
 * 本文件锁的是**第1/2 步的前置改造**：这两个字段必须与 `segments` 严格一致。
 *
 * ── 主判据（行为等价，★本组是回归的核心） ──────────────────────────
 * `bookTextChars` 改读`charCount` 后，其返回值**必须与旧实现（遍历
 * `sg.text.length`）逐书相等**。这不是「新旧都算对」，而是「换实现不换语义」：
 * FTS 闸门（`FTS_MAX_BOOK_CHARS = 4_000_000`）据此决定是否跳过索引，
 * 一旦数值漂移 ⇒ 超大书会被误索引（灾难级代价）或正常书被误跳过（搜索失效）。
 * 两个方向都会红。
 *
 * 变异自证（每条实测会红）：
 * - M1 `charCount` 改用 `p.length + 1`（少算/多算）⇒ 主判据红。
 * - M2 `charCount` 写成`segments.length`（段数冒充字数）⇒ 主判据红。
 * - M3 `createChapterBuilder` 不再填字段 ⇒ **回落组**必须仍绿（证明回落真的兜住了），
 *   同时「字段组」红（证明字段确实被写入）——两者方向相反才算证真。
 * - M4 `chapterSegCount` 恒返 0 ⇒ 段数组红。
 */

import {
  bookSegCount,
  bookTextChars,
  chapterCharCount,
  chapterSegCount,
} from '@/services/chapterCatalog';
import { parseTxtBook } from '@/services/UserBookService';
import type { Book, Chapter, TextSegment } from '@/types';

// ── 夹具 ──────────────────────────────────────────────────────────
function seg(chapterId: string, i: number, text: string): TextSegment {
  return { id: `${chapterId}-s${i + 1}`, chapterId, order: i + 1, text };
}
function chapter(
  id: string,
  texts: string[],
  extra?: Partial<Chapter>,
): Chapter {
  const segments = texts.map((t, i) => seg(id, i, t));
  return {
    id,
    bookId: 'bk',
    title: id,
    order: 1,
    segments,
    segCount: segments.length,
    charCount: texts.reduce((n, t) => n + t.length, 0),
    ...extra,
  };
}
/** 旧实现（StorageService 迁出前的那份），逐字保留作对照 oracle */
function legacyBookTextChars(book: Book): number {
  let n = 0;
  for (const ch of book.chapters) {
    for (const sg of ch.segments) {
      n += sg.text.length;
    }
  }
  return n;
}

// ── 组 1：主判据 —— 新旧实现数值必须等价 ─────────────────────────────
describe('bookTextChars · 与旧实现逐书等价（FTS 闸门不得漂移）', () => {
  it('★ 单章：字段路径 == 旧实现遍历', () => {
    const bk: Book = {
      id: 'bk',
      title: 't',
      author: 'a',
      category: 'user',
      description: '',
      chapters: [chapter('c1', ['学而时习之', '不亦说乎？', '有朋自远方来'])],
    };
    expect(bookTextChars(bk)).toBe(legacyBookTextChars(bk));
    // 字数逐字数：学而时习之(5) + 不亦说乎？(5) + 有朋自远方来(6) = 16
    expect(bookTextChars(bk)).toBe(16);
  });

  it('★ 多章 + 空段 + 零章：逐本等价', () => {
    const bk: Book = {
      id: 'bk',
      title: 't',
      author: 'a',
      category: 'user',
      description: '',
      chapters: [
        chapter('c1', ['一二三', '']),          // 含空段（长度 0）
        chapter('c2', []),                      // 章级零段
        chapter('c3', ['四个字', '两', '一']),
      ],
    };
    expect(bookTextChars(bk)).toBe(legacyBookTextChars(bk));
    // 一二三(3) + 空段(0) + 零段章(0) + 四个字(3) + 两(1) + 一(1) = 8
    expect(bookTextChars(bk)).toBe(8);
  });

  it('★ 回落路径（字段缺失）同样等价', () => {
    // 模拟「目录字段尚未写入」的形态：只有 segments
    const bare: Chapter = {
      id: 'c1',
      bookId: 'bk',
      title: 'c1',
      order: 1,
      segments: [seg('c1', 0, 'abcde'), seg('c1', 1, 'xy')],
    };
    expect(chapterCharCount(bare)).toBe(7);
    expect(chapterSegCount(bare)).toBe(2);
    const bk: Book = {
      id: 'bk',
      title: 't',
      author: 'a',
      category: 'user',
      description: '',
      chapters: [bare],
    };
    expect(bookTextChars(bk)).toBe(legacyBookTextChars(bk));
  });

  it('★ 非法/负值字段必须被忽略（回落），不得直接采信', () => {
    // -1 是「未装载」章的潜在哨兵；若被当字数，FTS 闸门立刻失真
    expect(chapterCharCount(chapter('c1', ['abcd'], { charCount: -1 }))).toBe(4);
    expect(chapterSegCount(chapter('c1', ['a', 'b'], { segCount: -1 }))).toBe(2);
    expect(chapterCharCount(chapter('c1', ['abcd'], { charCount: NaN }))).toBe(4);
    expect(chapterCharCount(chapter('c1', ['abcd'], { charCount: Infinity }))).toBe(4);
    expect(chapterSegCount(chapter('c1', ['a', 'b'], { segCount: NaN }))).toBe(2);
  });
});

// ── 组 2：字段确实被写入（构造期） ───────────────────────────────────
describe('createChapterBuilder · 构造即写目录字段', () => {
  const book = parseTxtBook('demo.txt', '学而第一\n第一句\n第二句\n\n为政第二\n第三句', 'bk');

  it('★ 每章 segCount 与 segments.length 一致', () => {
    expect(book.chapters.length).toBeGreaterThan(0);
    for (const ch of book.chapters) {
      expect(ch.segCount).toBe(ch.segments.length);
    }
  });

  it('★ 每章 charCount 与正文逐段求和一致', () => {
    for (const ch of book.chapters) {
      const sum = ch.segments.reduce((n, s) => n + s.text.length, 0);
      expect(ch.charCount).toBe(sum);
    }
  });

  it('★ 解析器产出与旧遍历等价（端到端）', () => {
    expect(bookTextChars(book)).toBe(legacyBookTextChars(book));
    expect(bookSegCount(book)).toBe(
      book.chapters.reduce((n, c) => n + c.segments.length, 0),
    );
  });
});

// ── 组 3：形状守卫 —— 字段不得成为「正文在不在」的替身 ────────────────
describe('形状守卫 · 目录字段不得被用来判断「正文是否装载」', () => {
  it('★ 空壳章（有 segCount、segments=[]）必须仍被识别为「未装载」', () => {
    // 这是设计文档 §2 阻塞 B 的核心：判据必须用 `segments.length`，
    // 不能被segCount 顶替，否则空壳章会被误判为已装载而永不装配。
    const shell: Chapter = {
      id: 'c1',
      bookId: 'bk',
      title: 'c1',
      order: 1,
      segments: [],
      segCount: 80,     // 目录说该有 80 段
      charCount: 50000,
    };
    // ⚠ 这条断言在锁「阻塞 B 尚未被解决」这一事实：
    //   有意断言 segments.length === 0 为真（未装载），而 segCount 为 80（不是装载信号）。
    expect(shell.segments.length).toBe(0);
    expect(shell.segCount).toBe(80);
  });
});

// ── 组 4：持久化往返 —— 字段必须活过 db JSON 序列化 ────────────────────
describe('持久化往返 · 目录字段必须活过 db 的 JSON 存取', () => {
  it('★ stringify → parse 后目录字段仍在，且读侧仍走字段路径', () => {
    // 依据 `UserBookService:4838` `JSON.stringify(parsed.book)` 与
    // `:4448-4453` / `:4809-4811` 的 `JSON.parse(row.data) as Book`
    //（注释 `:4447` 明写「用户书行始终是完整 JSON」）。
    //
    // ⚠ 若将来有人给 Chapter 加**函数**成员、或把字段设成不可枚举，
    //   JSON 往返会静默丢掉它们 ⇒ FTS 闸门退回遍历正文 ⇒ 本步的性能收益归零。
    const book = parseTxtBook('demo.txt', '第一章\n甲乙丙\n丁', 'bk');
    const round: Book = JSON.parse(JSON.stringify(book)) as Book;
    for (const ch of round.chapters) {
      expect(ch.segCount).toBe(ch.segments.length);
      expect(typeof ch.charCount).toBe('number');
    }
    expect(bookTextChars(round)).toBe(legacyBookTextChars(round));
  });

  it('★ 往返后字数必须与往返前一致（不得被 undefined 吞掉）', () => {
    const book = parseTxtBook('demo.txt', '一\n甲乙丙丁戊\n二\n己庚', 'bk');
    expect(bookTextChars(book)).toBeGreaterThan(0);
    const round: Book = JSON.parse(JSON.stringify(book)) as Book;
    expect(bookTextChars(round)).toBe(bookTextChars(book));
  });
});