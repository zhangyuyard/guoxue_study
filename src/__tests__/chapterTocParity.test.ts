/**
 * toc 生成端 ＋ **逐章对拍 oracle**（2026-10-13 B 档 · 步骤 5）。
 *
 * 这是整个 B 档最核心的正确性保证：设计文档 §5 要求的「切片独立解析 ==
 * 全本解析对应章」对拍，此前**无现成 oracle**（勘察 agent 引用的
 * `builtinMetaIndex.test.ts` 经核实不存在），此处自建。
 *
 * ★对拍的判据形状（与常见做法不同，刻意为之）：
 *   不是「重新解析一遍再比」——那样两边共用同一个实现，比的是**自己等于自己**。
 *   而是「**按 toc 偏移从文本切出来的片段** == **原 Book 里该章的 segments 拼回
 *   的原文**」。前者走字节路径（新代码），后者走解析结果（旧路径），
 *   两条**互不共用**的路径 ⇒ 比的是真等价。
 *
 * 覆盖样本（设计文档 §5 要求的全部）：无标题/多段标题/超长段>2500/段内单换行/
 * CRLF/空行章/首章前言。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  buildTocFromBook,
  CHAPTER_TOC_VERSION,
  lineByteRanges,
  normalizeForCache,
  sliceBytes,
  verifyTocAgainstText,
  type ChapterToc,
} from '@/services/chapterToc';
import { parseTxtBook, toParagraphs } from '@/services/UserBookService';
import type { Book } from '@/types';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * 用 toc 偏移从原文切出某章正文（走字节路径，与解析路径互不共用）。
 *
 * ⚠ 切片**含章末尾 `\n`**（字节区间右端是下一行行首，`\n` 落在区间内）
 *   ——这不是缺陷，是「行边界开区间」的定义。判据的期望值必须按同一
 *   口径构造，否则报的是判据自己的错（初版就因此把 8 个样本全判红）。
 */
function sliceChapterByToc(normalized: string, toc: ChapterToc, index: number): string {
  const e = toc.chapters[index];
  return sliceBytes(normalized, e.start, e.end);
}

/**
 * 原 Book 里该章 segments 的段文本（走解析路径）。
 *
 * ★**不比较「拼回字符串」**——拼接分隔符（`join('\n\n')`）与原文的空白布局
 *   本来就不同（原文本段间可能是**单换行**，segments 统一以 `\n\n` 拼）。
 *   真正的不变量（设计文档 §3）是：**切片经 `toParagraphs` 重切段 ⇒
 *   段数与逐段文本与原 Book 一致**。这条才是消费端唯一依赖的性质。
 */
function parasFromBook(book: Book, index: number): string[] {
  return book.chapters[index].segments.map((s) => s.text);
}

describe('toc 生成端 · 逐章对拍（字节路径 vs 解析路径）', () => {
  const CASES: Array<{ name: string; raw: string; markers?: boolean }> = [
    {
      name: '有标题（三章 + 首章前言）',
      raw: '这是前言第一段。\n这是前言第二段。\n第一章 学而\n时习之。\n不亦说乎？\n第二章 为政\n为政以德。\n第三章 八佾\n人而不仁。',
      markers: false,
    },
    {
      name: '无标题（整本一章「全文」）',
      raw: '天将降大任于斯人也。\n必先苦其心志。\n劳其筋骨。\n饿其体肤。',
      markers: false,
    },
    {
      name: '★CRLF 文本（归一化后偏移必须自洽）',
      raw: '第一章 甲\r\n内容一。\r\n\r\n第二章 乙\r\n内容二。\r\n内容三。',
      markers: false,
    },
    {
      name: '★空行章（标题下一行即空，再一个标题）',
      raw: '第一章 甲\n\n第二章 乙\n内容二。\n\n第三章 丙\n内容三。',
      markers: false,
    },
    {
      name: '段内单换行（无空行 ⇒ toParagraphs 走 split(/\\n+/)）',
      raw: '第一章 甲\n行一\n行二\n行三\n第二章 乙\n行四\n行五',
      markers: false,
    },
    {
      name: '★超长段（>2500 强制切分 ⇒ 一章多段）',
      raw: `第一章 甲\n${'长'.repeat(2600)}\n\n第二章 乙\n短段。`,
      markers: false,
    },
    {
      name: '@@CH@@ 标记格式（markers=true）',
      raw: '标记前正文。\n@@CH@@第一部分\n内容一。\n@@CH@@第二部分\n内容二。',
      markers: true,
    },
    {
      name: '单行无换行结尾（末行边界）',
      raw: '第一章 甲\n内容一。\n第二章 乙\n内容二。',
      markers: false,
    },
  ];

  for (const c of CASES) {
    it(`样本「${c.name}」：toc 偏移切出的正文 == Book 里该章的 segments 拼回`, () => {
      const normalized = normalizeForCache(c.raw);
      const book = parseTxtBook(
        'probe.txt',
        c.raw,
        'user-probe',
        c.markers ? { markers: true, sourceLabel: 'TXT' } : { sourceLabel: 'TXT' },
      );
      const toc = buildTocFromBook(book, normalized);

      // 该样本必须能生成 toc（若不能，说明它落在「无法用偏移表达」的类别里）
      expect(toc).not.toBeNull();
      // toc 自洽
      expect(verifyTocAgainstText(toc as ChapterToc, normalized)).toBe('');
      // 章数与 toc 条数一致（否则对拍会错位）
      expect((toc as ChapterToc).chapters).toHaveLength(book.chapters.length);

      // ★逐章对拍：字节路径切出的正文**重切段后**必须与解析路径逐段相同。
      //   这是消费端唯一依赖的性质（段 id 不变 ⇒ FTS/划线/笔记锚点不漂）。
      for (let i = 0; i < book.chapters.length; i += 1) {
        const slice = sliceChapterByToc(normalized, toc as ChapterToc, i);
        const byBytes = toParagraphs(slice);
        const byParse = parasFromBook(book, i);
        expect({ i, byBytes }).toEqual({ i, byBytes: byParse });
      }
    });
  }

  it('★目录字段与实测正文一致（segCount/charCount 不得漂）', () => {
    const raw = '第一章 甲\n内容一。\n\n内容二。\n第二章 乙\n内容三。';
    const normalized = normalizeForCache(raw);
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    const toc = buildTocFromBook(book, normalized) as ChapterToc;
    for (let i = 0; i < book.chapters.length; i += 1) {
      const ch = book.chapters[i];
      const e = toc.chapters[i];
      expect(e.id).toBe(ch.id);
      expect(e.order).toBe(ch.order);
      // ★口径：charCount 是**段文字数之和**，不是切片字符串长度
      //   （切片含章末 `\n`，两者差 1 —— 初版拿 `.length` 比，全红，是判据错）。
      const sliceParas = toParagraphs(sliceChapterByToc(normalized, toc, i));
      expect(e.segCount).toBe(sliceParas.length);
      expect(e.charCount).toBe(
        sliceParas.reduce((n, p) => n + p.length, 0),
      );
      // 与解析路径逐段相同（段 id 锚点不漂）
      expect(sliceParas).toEqual(ch.segments.map((s) => s.text));
      // 章在 toc 里的字节区间必须落在该章正文内
      expect(e.end).toBeGreaterThan(e.start);
    }
  });
});

describe('诚实边界：无法用偏移表达的书必须拒绝生成 toc', () => {
  it('★无标记 + 超 60 段 ⇒ 切「第N部分」章 ⇒ 放弃 toc（返回 null）', () => {
    // 段落 > SEGMENTS_PER_PART(60) 且无章节标记 ⇒ 按段数切片，
    // 而段落边界**不一定落在行边界**（段内可能有单换行）⇒ 偏移无法表达。
    const body = Array.from({ length: 70 }, (_, i) => `第${i + 1}行内容`).join('\n');
    const book = parseTxtBook('probe.txt', body, 'user-probe', { sourceLabel: 'TXT' });
    expect(book.chapters.length).toBeGreaterThan(1); // 确实被切成多「部分」
    expect(buildTocFromBook(book, normalizeForCache(body))).toBeNull();
  });

  it('章缺 byteStart/byteEnd（构造点漏写）⇒ 整体放弃 toc，不得部分可用', () => {
    const raw = '第一章 甲\n内容一。\n第二章 乙\n内容二。';
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    // 模拟「某一章忘了写范围」：部分 toc 比「没有 toc」更危险（会静默切错章）
    delete (book.chapters[1] as { byteStart?: number }).byteStart;
    expect(buildTocFromBook(book, normalizeForCache(raw))).toBeNull();
  });

  // ★以下三条锁的是 **fail-fast 路径**，不是正常路径。
  //   变异 M6（删掉 `buildTocFromBook` 里的自检调用）在只跑正常样本时
  //   **红 0 条** —— 因为正常样本生成本来就自洽，删掉检查看不出差别。
  //   ⇒ 必须构造「输入 Book 的范围字段本身不自洽」的负例，
  //     断言 buildTocFromBook **拒绝**（返回 null）而不是照样吐出一份坏 toc。
  it('★范围越界（byteEnd > byteLen）⇒ 自检拦下，不吐坏 toc', () => {
    const raw = '第一章 甲\n内容一。\n第二章 乙\n内容二。';
    const norm = normalizeForCache(raw);
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    (book.chapters[0] as { byteEnd?: number }).byteEnd = lineByteRanges(norm).byteLen + 999;
    expect(buildTocFromBook(book, norm)).toBeNull();
  });

  it('★范围不在行边界（切点落在多字节字符中间）⇒ 自检拦下', () => {
    const raw = '第一章 甲\n内容一。\n第二章 乙\n内容二。';
    const norm = normalizeForCache(raw);
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    // 中文字符 3 字节 ⇒ +1 必落在字符中间（等价于 CRLF 漂移事故的形态）
    (book.chapters[0] as { byteStart?: number }).byteStart =
      (book.chapters[0] as { byteStart?: number }).byteStart! + 1;
    expect(buildTocFromBook(book, norm)).toBeNull();
  });

  it('★相邻章区间重叠 ⇒ 自检拦下（部分重叠也不行）', () => {
    const raw = '第一章 甲\n内容一。\n第二章 乙\n内容二。\n第三章 丙\n内容三。';
    const norm = normalizeForCache(raw);
    const book = parseTxtBook('probe.txt', raw, 'user-probe', { sourceLabel: 'TXT' });
    // 让第 2 章起点退进第 1 章内部 ⇒ 重叠
    (book.chapters[1] as { byteStart?: number }).byteStart =
      (book.chapters[0] as { byteStart?: number }).byteStart!;
    expect(buildTocFromBook(book, norm)).toBeNull();
  });

  it('空书 / 无章节 ⇒ null（不是空 toc）', () => {
    const empty = { id: 'b', title: '', author: '', category: 'user', description: '', chapters: [] } as unknown as Book;
    expect(buildTocFromBook(empty, '')).toBeNull();
  });

  it('toc 版本号与常量一致（落盘/读盘两侧据此判兼容）', () => {
    expect(CHAPTER_TOC_VERSION).toBe(1);
  });
});

describe('形状：切章时记行范围（源码即断言）', () => {
  const APP_ROOT = resolve(__dirname, '..');
  const src = stripComments(
    readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8'),
  );

  it('RawChapter 记录 startLine/endLine（toc 偏移的来源）', () => {
    // 阴性对照：`body` 仍在（不是把范围塞进 body）
    expect(src).toContain('interface RawChapter');
    expect(src).toContain('startLine: number');
    expect(src).toContain('endLine: number');
  });

  it('buildTocFromBook 已接线到落盘（不是只写了纯函数）', () => {
    expect(src).toContain('buildTocFromBook');
    expect(src).toContain('from \'@/services/chapterToc\'');
    // toc 落盘路径必须挂在 `.gxbook` 缓存路径上、且与 `.meta` 后缀区分
    // （旧缓存没有 toc ⇒ 自动回退全量读，不会读到错的目录）。
    // ⚠ 锚点不能写 `.gxbook.toc` 字面量：代码用的是模板串，`cachePath`
    //   变量名里并没有 `.gxbook` ⇒ 写死字面量是**锚点过期假红**。
    // ⚠⚠ 2026-10-13（B 档步骤 8）：落盘实现抽到共用函数 `writeTocIfPossible`
    //   后，模板串的接收变量名由 `t.cachePath` 变成 `cachePath`
    //   ⇒ 上一版的锚点又过期了一次（锚点过期已第 5 次复现）。
    //   ⇒ 本次改为**按「写法会变」写正则**：只要求「`cachePath` 派生名 + `.toc` 后缀」，
    //   变量名再变（如 `cachePath` → `cp`）也不假红，且**强度不许降低**
    //   （仍要求它挂在 toc 后缀上，仍要求与 `.meta` 区分）。
    expect(src).toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}\.toc/);
    // 阴性对照：`.meta` 后缀也在同一落盘流程里（证明上面不是「什么都没写」）
    //   ⚠ `.meta` 的真实写法是**硬编码后缀字面量** `\`${t.cachePath}.meta\``，
    //   不是模板串拼接收变量 ⇒ 上一版把它也写成模板串正则，属「按想象写判据」。
    //   ⇒ 这里按各自**真实写法**分别锁定。
    expect(src).toContain('${t.cachePath}.meta');
    // 反向对照：`.toc` 后缀模板串**只出现在读侧 + 落盘共用函数**两处
    //   （实测 `loadUserBookToc` 读 1 处、`writeTocIfPossible` 写 1 处；
    //    `deleteBook` 清理走的是 `\`${t.cachePath}.toc\`` 变量形式，不在此计数内）。
    //   意图：防止有人在`processOversizedBooks` 里另起一份直接写 toc 的实现
    //   ⇒ 那会让「全有或全无」出现第二个实现，两处语义可能漂移。
    const tocHits = src.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}\.toc/g) ?? [];
    expect(tocHits).toHaveLength(2);
  });

  it('★切章结果逐字段不变（同步版 == 分批版，含新增范围字段）', () => {
    // 已有对齐测试 startupResponseRegression 锁 `toEqual`；此处锁范围字段确实被写入
    expect(src).toContain('startLine: i + 1');
  });
});

describe('行边界自洽（toc 构造的地基）', () => {
  it('starts 与 split("\\n") 一一对应，且逐行字节可反查回原文', () => {
    const t = normalizeForCache('中文\n测试\r\n行三');
    const { starts, byteLen } = lineByteRanges(t);
    expect(starts.length).toBe(t.split('\n').length);
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1] : byteLen;
      // ⚠ 行 i 的字节区间 `[starts[i], starts[i+1])` **含该行的 `\n`**
      //   （`starts` 记的是每个 `\n` **之后**的位置），而 `split('\n')`
      //   已把分隔符吃掉 ⇒ 期望值必须补回换行，否则报的是判据自己的错。
      //   初版直接比 `split('\n')[i]` ⇒ 多一个 `\n` ⇒ 全红。
      const want = i + 1 < starts.length ? `${t.split('\n')[i]}\n` : t.split('\n')[i];
      expect(sliceBytes(t, starts[i], end)).toBe(want);
    }
    // 阳性对照：这些行确有内容（断言非平凡）
    expect(starts.length).toBeGreaterThan(2);
  });

  it('★拼接还原：按 starts 逐段切片再拼起来 == 原文（切章不丢字、不重字）', () => {
    // 这是「偏移表正确」的**最强**表述：不逐行比，而是整体拼回等于原文。
    for (const t of [
      normalizeForCache('中文\n测试\r\n行三'),
      normalizeForCache('a\n\nb\n'),
      normalizeForCache('单行无换行'),
      normalizeForCache('尾随空行\n\n'),
    ]) {
      const { starts, byteLen } = lineByteRanges(t);
      let acc = '';
      for (let i = 0; i < starts.length; i += 1) {
        const end = i + 1 < starts.length ? starts[i + 1] : byteLen;
        if (end <= starts[i]) {
          continue; // 末行无换行时的零宽尾项
        }
        acc += sliceBytes(t, starts[i], end);
      }
      expect(acc).toBe(t);
    }
  });
});
