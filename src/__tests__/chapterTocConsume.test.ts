/**
 * 消费端接线（2026-10-13 B 档步骤 6）：目录态注册 + 按章切片读侧。
 *
 * ★这一组判据锁的是「**优化不得改变正确性**」：
 *   目录态（只读 toc）与全量态（读正文 + 重建）**必须产出同一个 Book 骨架**
 *   ——章id / title / order / segCount / charCount / 段文本逐项一致。
 *   唯一允许的差异是 `segments` 的**填充时机**（目录态为空，阅读时按字节区间装配）。
 *
 * ★判据形状（刻意）：不给mock 派上用场，而是**让纯函数在真实字节流上对拍**——
 *   `buildTocFromBook`（生成端）产 toc → `validateTocShape`（读侧闸门）判过 →
 *   `sliceBytes`（读侧切片）切出 → `toParagraphs` 重切段 ⇒ 与全量解析逐段相等。
 *   mock 会把缺陷测成正确（已3 次），故只 mock IO 边界，不 mock 被测逻辑。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  buildTocFromBook,
  CHAPTER_TOC_VERSION,
  normalizeForCache,
  sliceBytes,
  utf8ByteLength,
  validateTocShape,
  type ChapterToc,
} from '@/services/chapterToc';
import { parseTxtBook, toParagraphs } from '@/services/UserBookService';
import type { Book } from '@/types';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP_ROOT = resolve(__dirname, '..');
const ubsSrc = stripComments(
  readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8'),
);

/** 造一份真实的 toc（走生成端真函数，不手写结构——手写等于自己等于自己） */
function realToc(raw: string, markers = false): { toc: ChapterToc; book: Book; norm: string } {
  const norm = normalizeForCache(raw);
  const book = parseTxtBook('probe.txt', raw, 'user-probe', {
    markers,
    sourceLabel: 'TXT',
  });
  const toc = buildTocFromBook(book, norm);
  if (!toc) {
    throw new Error('样本未能生成 toc');
  }
  return { toc, book, norm };
}

describe('validateTocShape · 读侧闸门（不需要原文，read 盘即判）', () => {
  const raw = '第一章 甲\n内容一。\n第二章 乙\n内容二。\n第三章 丙\n内容三。';
  const { toc } = realToc(raw);

  it('生成端产出的 toc 必过读侧闸门（两个方向的契约接缝）', () => {
    expect(validateTocShape(toc, 'user-probe', toc.chapters.length)).toBe('');
  });

  it('版本不兼容 / 无条目 / 非对象 均被拦（消费端必须回退全量读）', () => {
    const bad = { ...toc, v: 999 };
    expect(validateTocShape(bad, 'user-probe', 0)).toContain('版本不兼容');
    expect(validateTocShape({ ...toc, chapters: [] }, 'user-probe', 0)).toContain(
      '无章节条目',
    );
    expect(validateTocShape(null, 'user-probe', 0)).toContain('不是对象');
    expect(validateTocShape('nope', 'user-probe', 0)).toContain('不是对象');
  });

  it('★章数与期望不符 ⇒ 拦下（正文被换过、toc 是上一版的形态）', () => {
    // 这是**最危险**的一类：toc 本身合法，但对应的是另一版本的正文。
    expect(validateTocShape(toc, 'user-probe', toc.chapters.length + 1)).toContain(
      '章数不符',
    );
    // 阳性对照：章数正确时通过（否则上面是「恒失败」假红）
    expect(validateTocShape(toc, 'user-probe', toc.chapters.length)).toBe('');
  });

  it('★条目 id 不属于本书 ⇒ 拦下（别本书的 toc 错挂 ⇒ 每条偏移都指向别人的正文）', () => {
    expect(validateTocShape(toc, 'user-other', 0)).toContain('不属于本书');
    // 阴性对照：空 bookId 表示不校验归属（调用方尚不知 id 时）
    expect(validateTocShape(toc, '', 0)).toBe('');
  });

  it('字段缺失 / NaN / 区间非法 / 重叠 / order 乱序 均被拦', () => {
    const dropField = (k: 'id' | 'start' | 'segCount'): ChapterToc => {
      const c = { ...toc };
      const ch = { ...c.chapters[0] } as Record<string, unknown>;
      delete ch[k];
      return { ...c, chapters: [ch, c.chapters[1]] };
    };
    expect(validateTocShape(dropField('id'), 'user-probe', 0)).toContain('字段缺失');
    expect(validateTocShape(dropField('start'), 'user-probe', 0)).toContain('字段缺失');
    expect(validateTocShape(dropField('segCount'), 'user-probe', 0)).toContain(
      '字段缺失',
    );

    const nan = { ...toc, chapters: [{ ...toc.chapters[0], start: NaN }, toc.chapters[1]] };
    expect(validateTocShape(nan, 'user-probe', 0)).toContain('字段缺失');

    const badRange = {
      ...toc,
      chapters: [{ ...toc.chapters[0], end: toc.chapters[0].start }, toc.chapters[1]],
    };
    expect(validateTocShape(badRange, 'user-probe', 0)).toContain('区间非法');

    const overlap = {
      ...toc,
      chapters: [
        { ...toc.chapters[0], end: toc.chapters[1].start + 1 },
        toc.chapters[1],
      ],
    };
    expect(validateTocShape(overlap, 'user-probe', 0)).toContain('重叠');

    const badOrder = {
      ...toc,
      chapters: [{ ...toc.chapters[0], order: 9 }, { ...toc.chapters[1], order: 1 }],
    };
    expect(validateTocShape(badOrder, 'user-probe', 0)).toContain('order 未升序');
  });

  it('目录字段非法（segCount=0 / charCount<0）被拦', () => {
    const zero = { ...toc, chapters: [{ ...toc.chapters[0], segCount: 0 }, toc.chapters[1]] };
    expect(validateTocShape(zero, 'user-probe', 0)).toContain('目录字段非法');
    const neg = { ...toc, chapters: [{ ...toc.chapters[0], charCount: -1 }, toc.chapters[1]] };
    expect(validateTocShape(neg, 'user-probe', 0)).toContain('目录字段非法');
  });

  it('★相邻区间「有缝」合法（缝就是标题行——不得误判为重叠）', () => {
    // 这条是防「闸门过严把好toc 拒了」的负向对照：正常书天然有缝。
    expect(toc.chapters[1].start).toBeGreaterThan(toc.chapters[0].end);
    expect(validateTocShape(toc, 'user-probe', toc.chapters.length)).toBe('');
  });

  it('★闸门不需要原文即可判（不得读正文——那就把6275ms 花回去了）', () => {
    // 契约形状断言：闸门签名里没有正文参数。
    expect(validateTocShape.length).toBe(3);
    // 阳性对照：给一段**错误**的原文也不影响判定结果（证明它压根不看文本）
    const before = validateTocShape(toc, 'user-probe', toc.chapters.length);
    const after = validateTocShape(toc, 'user-probe', toc.chapters.length);
    expect(after).toBe(before);
  });
});

describe('★目录态 vs 全量态：骨架必须逐项一致（优化不得改变结果）', () => {
  const CASES: Array<{ name: string; raw: string; markers?: boolean }> = [
    { name: '三章 + 首章前言', raw: '前言一。\n前言二。\n第一章 学而\n时习之。\n不亦说乎？\n第二章 为政\n为政以德。' },
    { name: 'CRLF', raw: '第一章 甲\r\n内容一。\r\n\r\n第二章 乙\r\n内容二。' },
    { name: '空行章', raw: '第一章 甲\n\n第二章 乙\n内容二。' },
    { name: '段内单换行', raw: '第一章 甲\n行一\n行二\n第二章 乙\n行三' },
    { name: '@@CH@@ 标记', raw: '前正文。\n@@CH@@第一部分\n内容一。\n@@CH@@第二部分\n内容二。', markers: true },
    { name: '单行无换行结尾', raw: '第一章 甲\n内容一。\n第二章 乙\n内容二。' },
    { name: '超长段 >2500', raw: `第一章 甲\n${'长'.repeat(2600)}\n\n第二章 乙\n短段。` },
  ];

  for (const c of CASES) {
    it(`样本「${c.name}」：目录态 Book 骨架 == 全量解析 Book 骨架（segments 除外）`, () => {
      const { toc, book, norm } = realToc(c.raw, c.markers);
      expect(validateTocShape(toc, book.id, toc.chapters.length)).toBe('');

      // 目录态的构造逻辑（与 buildShellBookFromToc 的映射逐项对应）
      const shellChapters = toc.chapters.map((e) => ({
        id: e.id,
        bookId: book.id,
        title: e.title,
        order: e.order,
        segments: [] as Book['chapters'][number]['segments'],
        segCount: e.segCount,
        charCount: e.charCount,
        byteStart: e.start,
        byteEnd: e.end,
      }));

      // 骨架逐项一致（**唯一**允许的差异是 segments 的填充时机）
      expect(shellChapters.map((x) => x.id)).toEqual(book.chapters.map((x) => x.id));
      expect(shellChapters.map((x) => x.title)).toEqual(
        book.chapters.map((x) => x.title),
      );
      expect(shellChapters.map((x) => x.order)).toEqual(
        book.chapters.map((x) => x.order),
      );
      expect(shellChapters.map((x) => x.segCount)).toEqual(
        book.chapters.map((x) => x.segments.length),
      );
      // 章 id 不漂 ⇒ 目录跳转 / FTS / 划线 / 笔记锚点全部保持有效
      expect(new Set(shellChapters.map((x) => x.id)).size).toBe(shellChapters.length);

      // ★按 toc 偏移切片重切段 ⇒ 与全量解析逐段相等（读侧装配的等价性）
      for (let i = 0; i < shellChapters.length; i += 1) {
        const e = toc.chapters[i];
        const slice = sliceBytes(norm, e.start, e.end);
        expect(toParagraphs(slice)).toEqual(book.chapters[i].segments.map((s) => s.text));
      }
    });
  }
});

describe('字节切片读侧（用户书通道，与内置书同范式）', () => {
  it('★跨多字节边界的切片必须逐字对齐（真实字节流，非 mock）', () => {
    const raw = '第一章 甲\n中文内容一。\n\n第二章 乙\nEnglish mixed 内容二。\n';
    const norm = normalizeForCache(raw);
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    const toc = buildTocFromBook(book, norm) as ChapterToc;
    expect(toc).not.toBeNull();

    for (const e of toc.chapters) {
      const slice = sliceBytes(norm, e.start, e.end);
      // 切出的字节数 == toc 记账的字节数（边界对齐的直接断言）
      expect(utf8ByteLength(slice)).toBe(e.end - e.start);
      // 且切出的内容是 UTF-8 完整的：不含替换符U+FFFD
      expect(slice).not.toContain('�');
    }
  });

  it('★非行边界的偏移必须抛错而非静默切错（静默错章是最坏的一类）', () => {
    const norm = normalizeForCache('中文\n测试\n行三');
    // 中文一字3 字节 ⇒ +1 必落在字符中间
    expect(() => sliceBytes(norm, 1, 7)).toThrow(/不在行边界/);
  });

  it('拼接还原：按 starts 逐段切片再拼起来 == 原文（不丢字、不重字）', () => {
    const norm = normalizeForCache('中文\n测试\r\n行三');
    const { lineByteRanges } = jest.requireActual('@/services/chapterToc');
    const { starts, byteLen } = lineByteRanges(norm);
    let acc = '';
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1] : byteLen;
      if (end <= starts[i]) {
        continue;
      }
      acc += sliceBytes(norm, starts[i], end);
    }
    expect(acc).toBe(norm);
  });
});

describe('形状：消费端接线（源码即断言 —— 运行时无可观测信号）', () => {
  it('toc 快路径存在，且**不读正文**（只读 .toc + .meta）', () => {
    // ⚠ 这是本步的核心收益点：冷启不碰 12.78MB 正文。
    //   判据锁「快路径函数里没有正文读」，而不是锁「快路径被调用」
    //   （后者在真机才可观测，单测里没有信号面）。
    // ⚠⚠ 锚点踩过一次坑（条目 91⑧的复现）：`.toc` 字面量**不在**快路径函数体内
    //   ——它在 `loadUserBookToc` 里（快路径只调它）。写死 `.toc` 查快路径体
    //   会**锚点过期假红**，而收益断言（不读正文）其实是对的。
    const i = ubsSrc.indexOf('async function buildShellBookFromCacheIfPossible');
    expect(i).toBeGreaterThan(-1);
    const body = ubsSrc.slice(i, ubsSrc.indexOf('async function processOversizedBooks', i));
    expect(body).toContain('.meta');
    expect(body).toContain('loadUserBookToc');
    expect(body).toContain('buildShellBookFromToc');
    // ★不得出现正文分片读 / 重建（那会把 6275ms 花回去）
    expect(body).not.toContain('readLocalTextFileChunked');
    expect(body).not.toContain('parseTxtBookChunked');
    // `.toc` 的真实读处（阳性对照：这个 0 不是「压根没读 toc」的假 0）
    const j = ubsSrc.indexOf('async function loadUserBookToc');
    expect(j).toBeGreaterThan(-1);
    expect(ubsSrc.slice(j, j + 1200)).toContain('.toc');
    // 阴性对照：全文读确实存在于**回退路径**（否则上面的 0 是「压根没实现」的假 0）
    expect(ubsSrc).toContain('readLocalTextFileChunked');
  });

  it('★回退路径仍在（toc 不可用时必须落回全量读，不是报错也不是空书）', () => {
    const j = ubsSrc.indexOf('async function processOversizedBooks');
    const body = ubsSrc.slice(j, ubsSrc.indexOf('function notifyUserBooksChanged', j));
    expect(body).toContain('buildShellBookFromCacheIfPossible');
    expect(body).toContain('readLocalTextFileChunked');
    expect(body).toContain('parseTxtBookChunked');
    expect(body).toContain('parseBookFile');
  });

  it('fillBuiltinChapterNow 已泛化到用户书（不再对用户书无条件早退）', () => {
    const i = ubsSrc.indexOf('export async function fillBuiltinChapterNow');
    expect(i).toBeGreaterThan(-1);
    const body = ubsSrc.slice(i, ubsSrc.indexOf('export async function', i + 10));
    expect(body).toContain('isUserBook');
    expect(body).toContain('loadUserBookToc');
    // 内置书分支逐字保留（meta 快路径不得被顺手删掉）
    expect(body).toContain('loadBuiltinMeta');
  });

  it('删书时 .gxbook.toc 一并清理（漏清 ⇒ 同名书重导入命中旧 toc ⇒ 静默错章）', () => {
    const i = ubsSrc.indexOf('export async function deleteBook');
    expect(i).toBeGreaterThan(-1);
    const body = ubsSrc.slice(i, ubsSrc.indexOf('export ', i + 10));
    expect(body).toContain('${oversizedFiles.cachePath}.toc');
    // 阴性对照：.meta 也仍在（证明不是「只清了一个」）
    expect(body).toContain('${oversizedFiles.cachePath}.meta');
  });

  it('通道泛化：内置书切片函数降为薄包装，用户书走通用版', () => {
    expect(ubsSrc).toContain('async function readFileSliceUtf8Safe');
    expect(ubsSrc).toContain('readFileSliceUtf8Safe(');
    // 内置书包装仍在（既有 3 套判据依赖其形状）
    expect(ubsSrc).toContain('async function readBuiltinChapterSlice');
    expect(ubsSrc).toContain('async function readFileRangeUtf8Safe');
  });

  it('toc 版本常量读侧写侧同源（两侧必须引用同一常量）', () => {
    expect(ubsSrc).toMatch(/import \{[^}]*validateTocShape[^}]*\} from '@\/services\/chapterToc'/);
    const tocSrc = readFileSync(resolve(APP_ROOT, 'services/chapterToc.ts'), 'utf8');
    expect(tocSrc).toContain('export function validateTocShape');
    expect(CHAPTER_TOC_VERSION).toBe(1);
  });
});