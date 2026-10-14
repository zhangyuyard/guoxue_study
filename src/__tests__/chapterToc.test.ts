/**
 * `.gxbook` 落盘文本归一化 ＋ toc 自洽（2026-10-12 B 档 · 步骤 4 判据）。
 *
 * 锁三件事：
 * ①`normalizeForCache` 的口径与解析层**逐字一致**（不一致 ⇒ toc 偏移与缓存文本错位）
 * ②`processOversizedBooks` 落盘写的是**归一化后**文本（现状缺陷的回归锁）
 * ③`verifyTocAgainstText` 能抓到「非行边界偏移」「不连续」「未归一化文本」
 *
 * ⚠ 判据 ② 用**源码文本即断言**（`parsed.text` 不得直接进 writeFile）：
 *   落盘调用点在 `try` 内、外面包着 catch，真机跑不到单测；而
 *   「写的是不是归一化文本」这件事在运行时**没有可观测信号**
 *   （RNFS.writeFile 的内容不进内存可读面）⇒ 只能锁源码形状 + 锁纯函数口径。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  CHAPTER_TOC_VERSION,
  lineByteRanges,
  normalizeForCache,
  sliceBytes,
  utf8ByteLength,
  verifyTocAgainstText,
  type ChapterToc,
} from '@/services/chapterToc';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('normalizeForCache · 落盘归一化口径', () => {
  it('CRLF 与裸 CR 都收敛为 LF', () => {
    expect(normalizeForCache('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeForCache('无变化')).toBe('无变化');
    expect(normalizeForCache('')).toBe('');
  });

  it('★与解析层口径逐字一致（四处 normalize 必须同式）', () => {
    // 解析层四处：切片读/流式装配/同步解析/分片解析。若其中任一处改成别的口径
    // 而本函数没跟上，toc 偏移必错位（静默显示错章）。
    // ⚠ 计数**实测**得来：初版写 `3`，实测是 `4`（漏了 `UBS:3078` 那处）
    // ⇒ 判据自身写错，按读数改，不迁就实现。
    const APP_ROOT = resolve(__dirname, '..');
    const src = stripComments(
      readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8'),
    );
    const EXPR = "replace(/\\r\\n?/g, '\\n')";
    expect(src.split(EXPR).length - 1).toBe(4);
    // 阴性对照：表达式本身确实在文件里（不是锚点写错导致的假 0）
    expect(src).toContain('\\r\\n?');
  });

  it('归一化幂等（对已归一化文本再跑一次不改变）', () => {
    const raw = '第一章\r\n正文一\r\n\r\n第二章\r\n正文二';
    const once = normalizeForCache(raw);
    expect(normalizeForCache(once)).toBe(once);
  });
});

describe('UTF-8 字节口径', () => {
  it('utf8ByteLength 与 Buffer.byteLength 逐例一致', () => {
    for (const s of ['', 'abc', '中文', 'a中b文', '😀emoji', '混合abc中文😀']) {
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });

  it('★与 string.length 不同（中文一字 3 字节 ⇒ 混算必错位）', () => {
    expect(utf8ByteLength('中文')).toBe(6);
    expect('中文'.length).toBe(2);
  });

  it('行边界表覆盖首行、每行尾、末行', () => {
    const t = 'ab\ncd\n';
    const { starts, byteLen } = lineByteRanges(t);
    expect(byteLen).toBe(6);
    // starts = [0, 3, 6]
    expect(starts).toEqual([0, 3, 6]);
    const t2 = 'ab\ncd';
    const r2 = lineByteRanges(t2);
    expect(r2.byteLen).toBe(5);
    expect(r2.starts).toEqual([0, 3]);
  });

  it('sliceBytes 按字节偏移切出正确子串（多字节文本）', () => {
    const t = '中文\n测试';
    // 字节布局：0-2 中 / 3-5 文 / 6 \n / 7-9 测 / 10-12 试
    expect(sliceBytes(t, 0, 6)).toBe('中文');
    expect(sliceBytes(t, 7, 13)).toBe('测试');
    // ⚠ 这条判据在初版是**红的**，且是**实现错**不是判据错：
    //   初版 `sliceBytes` 用 `normalized.slice(start, end)`（UTF-16 下标）
    //   冒充字节偏移 ⇒ 中文场景直接切空。命名与实现不符，已修实现。
    // 阳性对照：UTF-16 下标口径确实会给出不同结果（证明本判据有鉴别力）
    expect(t.slice(0, 6)).not.toBe('中文');
  });

  it('sliceBytes 在 startByte 不在行边界时抛错（拒绝静默错位）', () => {
    const t = '中文\n测试';
    expect(() => sliceBytes(t, 1, 6)).toThrow(/不在行边界/);
  });

  it('sliceBytes 非法区间返回空串（不抛）', () => {
    const t = '中文\n测试';
    expect(sliceBytes(t, 6, 6)).toBe('');
    expect(sliceBytes(t, -1, 6)).toBe('');
    expect(sliceBytes(t, 0, 9999)).toBe('');
  });
});

describe('verifyTocAgainstText · toc 自洽校验', () => {
  /** 构造一个与 normalized 严丝合缝的 toc（按行边界切 N 章，章间留缝=标题行） */
  function goodToc(normalized: string, chapterCount: number): ChapterToc {
    const { starts, byteLen } = lineByteRanges(normalized);
    // ⚠ 越界下标一律夹到 `byteLen`：**不能**用 `starts[starts.length]`——
    //   `starts` 最后一个合法下标是 `length - 1`，越界读出 `undefined`，
    //   而 `undefined` 会先被「区间非法」拦下 ⇒ 掩盖后面真正要测的成因
    //   （本轮 3 条判据因此报「区间非法」而非本该报的原因，已按读数改）。
    const lineStart = (line: number): number =>
      line < starts.length ? starts[line] : byteLen;
    const chapters = [];
    // 每章占 2 行（1 行标题 + 1 行正文），从第 2 行起 ⇒ 首条 start 非 0
    for (let i = 0; i < chapterCount; i += 1) {
      const titleLine = i * 2;
      chapters.push({
        id: `b-c${i + 1}`,
        title: `第${i + 1}章`,
        order: i + 1,
        start: lineStart(Math.min(titleLine + 1, starts.length - 1)),
        end: lineStart(Math.min(titleLine + 2, starts.length)),
        segCount: 1,
        charCount: 0,
      });
    }
    return { v: CHAPTER_TOC_VERSION, chapters };
  }

  const text = normalizeForCache('第一章\r\n正文一\r\n第二章\r\n正文二\r\n第三章\r\n正文三');

  it('严丝合缝的 toc 通过（正向对照，防「恒失败」假红）', () => {
    expect(verifyTocAgainstText(goodToc(text, 3), text)).toBe('');
  });

  it('★首条 start 不必为 0；末条 end 可 == byteLen，也可 < byteLen（有缝合法）', () => {
    // 这条是 2026-10-13 的一次**判据自身设计错误**修正：初版把
    // 「chapters[0].start === 0」与「末条 end === byteLen」当成不变量，
    // 而 toc 记的是**正文**区间（标题行排除在外）⇒ 首条 start 必然非 0。
    // 末条 end 则**两可**：末章正文一直延伸到文本末尾时 `=== byteLen` 合法
    // （`verifyTocAgainstText` 对此显式跳过行边界检查），后面还有非章内容
    // 时才 `< byteLen`。初版写死 `toBeLessThan` ⇒ 把合法 toc 判成错，按读数改。
    const toc = goodToc(text, 3);
    expect(toc.chapters[0].start).toBeGreaterThan(0);
    const byteLen = lineByteRanges(text).byteLen;
    expect(toc.chapters[toc.chapters.length - 1].end).toBeLessThanOrEqual(byteLen);
    expect(verifyTocAgainstText(toc, text)).toBe('');

    // 末章后面还有**内容行**（不是空行！空行只是行分隔符，仍属本章）
    //   ⇒ end < byteLen，且仍必须通过。此处手工构造，不复用 goodToc
    //   ——goodToc 按「每章 2 行」推算，多出的内容行不在它的假设内。
    const tail = normalizeForCache('第一章\n正文一\n第二章\n正文二\n附录（非章节内容）');
    const l2 = lineByteRanges(tail);
    const toc2: ChapterToc = {
      v: CHAPTER_TOC_VERSION,
      chapters: [
        { id: 'b-c1', title: '第一章', order: 1, start: l2.starts[1], end: l2.starts[2], segCount: 1, charCount: 3 },
        { id: 'b-c2', title: '第二章', order: 2, start: l2.starts[3], end: l2.starts[4], segCount: 1, charCount: 3 },
      ],
    };
    expect(toc2.chapters[1].end).toBeLessThan(l2.byteLen);
    expect(verifyTocAgainstText(toc2, tail)).toBe('');
    // 阳性对照：那行附录确实在 byteLen 之前、且被 toc 排除在外
    expect(l2.byteLen).toBeGreaterThan(toc2.chapters[1].end + 6);
  });

  it('★非行边界的偏移被抓（这正是 CRLF 漂移事故的形态）', () => {
    const toc = goodToc(text, 3);
    toc.chapters[1].start += 1; // 挪 1 字节 ⇒ 切点落在多字节字符中间
    expect(verifyTocAgainstText(toc, text)).toContain('不在行边界上');
  });

  it('★相邻区间「重叠」被抓（有缝是正常的——缝就是标题行）', () => {
    const { starts } = lineByteRanges(text);
    const toc = goodToc(text, 3);
    // 让第 2 条起点退回到第 1 条内部 ⇒ 重叠
    toc.chapters[1].start = starts[1];
    expect(verifyTocAgainstText(toc, text)).toContain('重叠');
  });

  it('末条 end 越界 / 区间非法 均被抓', () => {
    const toc = goodToc(text, 3);
    toc.chapters[2].end = lineByteRanges(text).byteLen + 10;
    expect(verifyTocAgainstText(toc, text)).toContain('区间非法');

    const toc2 = goodToc(text, 3);
    toc2.chapters[1].end = toc2.chapters[1].start; // 空区间
    expect(verifyTocAgainstText(toc2, text)).toContain('区间非法');
  });

  it('版本不兼容 / 无条目 / order 未升序 均被抓', () => {
    const bad1 = goodToc(text, 3);
    bad1.v = 999;
    expect(verifyTocAgainstText(bad1, text)).toContain('版本不兼容');

    expect(verifyTocAgainstText({ v: CHAPTER_TOC_VERSION, chapters: [] }, text)).toContain(
      '无章节条目',
    );

    const bad3 = goodToc(text, 3);
    bad3.chapters[1].order = 1;
    expect(verifyTocAgainstText(bad3, text)).toContain('order 未升序');
  });

  it('★未归一化文本 + 按归一化口径记的 toc ⇒ 必须报错（步骤 4 要防的事故）', () => {
    // 构造事故现场：缓存文本仍是 CRLF，toc 却按 LF 口径记了偏移
    const rawCrlf = '第一章\r\n正文一\r\n第二章\r\n正文二\r\n';
    const normalized = normalizeForCache(rawCrlf);
    const toc = goodToc(normalized, 2); // 按归一化文本记
    // 现在拿「未归一化的文本」去校验 ⇒ 字节长度对不上 ⇒ 必须红
    expect(verifyTocAgainstText(toc, rawCrlf)).not.toBe('');
  });

  it('segCount / charCount 非法值被抓', () => {
    const toc = goodToc(text, 3);
    toc.chapters[0].segCount = 0;
    expect(verifyTocAgainstText(toc, text)).toContain('segCount 非法');

    const toc2 = goodToc(text, 3);
    toc2.chapters[2].charCount = -1;
    expect(verifyTocAgainstText(toc2, text)).toContain('charCount 非法');
  });
});

describe('形状：.gxbook 落盘写的是归一化文本（源码即断言）', () => {
  it('writeFile(cachePath) 不得直接写 parsed.text', () => {
    const APP_ROOT = resolve(__dirname, '..');
    const src = stripComments(
      readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8'),
    );
    const i = src.indexOf('async function processOversizedBooks');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf('loadAndRegisterAll', i));
    // parsed.text 只能经过归一化函数才可落盘
    expect(body).not.toContain('writeFile(t.cachePath, parsed.text');
    expect(body).toContain('normalizeForCache(parsed.text)');
    // 阴性对照：同一函数体内 writeFile 仍存在（上面的 0 不是「没写缓存」造成的）
    expect(body).toContain('writeFile(t.cachePath');
    expect(body).toContain('.meta');
  });

  it('normalizeForCache 已 import 进 UserBookService（不是只写了纯函数）', () => {
    const APP_ROOT = resolve(__dirname, '..');
    const src = stripComments(
      readFileSync(resolve(APP_ROOT, 'services/UserBookService.ts'), 'utf8'),
    );
    // ⚠ 锚点不能写死成单符号 import 语句：步骤 5 又加了 `buildTocFromBook` /
    //   `lineByteRanges`，import 已变成多符号 ⇒ 写死单符号会**锚点过期假红**。
    //   改为「同一 import 语句里含 normalizeForCache」。
    expect(src).toMatch(
      /import \{[^}]*\bnormalizeForCache\b[^}]*\} from '@\/services\/chapterToc'/,
    );
    // 阴性对照：纯函数模块确实导出它
    const tocSrc = readFileSync(resolve(APP_ROOT, 'services/chapterToc.ts'), 'utf8');
    expect(tocSrc).toContain('export function normalizeForCache');
  });

  it('★行数自洽：starts 条数 == split("\\n").length（否则按行切章会漏末行）', () => {
    // 实测口径：`starts` 含「每个 \n 之后」的位置，故末尾空串项也算一行
    // ⇒ 两者**相等**（初版断言 `lines - 1`，实测是错的 ⇒ 按读数改）。
    const t = 'a\nb\nc\n';
    expect(lineByteRanges(t).starts.length).toBe(t.split('\n').length);
    const t2 = 'a\nb\nc';
    expect(lineByteRanges(t2).starts.length).toBe(t2.split('\n').length);
    // 多字节同样成立（防「按字节算行数时把中文算错」）
    const t3 = '中\n文\n';
    expect(lineByteRanges(t3).starts.length).toBe(t3.split('\n').length);
    expect(lineByteRanges(t3).byteLen).toBe(Buffer.byteLength(t3, 'utf8'));
    // 阳性对照：这些文本确有多个换行（断言非平凡）
    expect(t.split('\n').length).toBeGreaterThan(3);
  });
});
