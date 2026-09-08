/**
 * 内置经典数据完整性测试（B5 → 2026-09 资产化全本）。
 * 锁定五部书（孟子/庄子/诗经/荀子/楚辞）的资产解析产物质量：
 * - 每部书章数与声明一致、每章 ≥1 段、每段非空含汉字
 * - 无残留 HTML 标签 / 抓取杂项 / ASCII 异常字符 / 扩展区生僻字
 * - 总字数落在合理区间（全本口径）；经 TextLibraryService 端到端可加载
 * - 章节首/末段传世开句/收句抽查（防止源数据缺章断尾）
 * 2026-09 资产化：书体在 android assets books/<id>.txt，测试经
 * builtinAssets.helper 直读磁盘解析；章节 id 统一为「书id-cN」。
 */
import { TextLibraryService } from '@/services/TextLibraryService';
import type { Book } from '@/types';
import { loadBuiltinBooks } from './builtinAssets.helper';

/** 五部书清单（id → 期望章数与总字数区间，全本口径） */
const NEW_BOOKS: Array<{ id: string; expectedChapters: number; charRange: [number, number] }> = [
  { id: 'mengzi', expectedChapters: 14, charRange: [38000, 50000] },
  { id: 'zhuangzi', expectedChapters: 33, charRange: [75000, 86000] },
  { id: 'shijing', expectedChapters: 30, charRange: [35000, 42000] },
  { id: 'xunzi', expectedChapters: 32, charRange: [85000, 95000] },
  { id: 'chuci', expectedChapters: 17, charRange: [30000, 35000] },
];

const RAW_BY_ID: Record<string, Book> = Object.fromEntries(
  loadBuiltinBooks(NEW_BOOKS.map((s) => s.id)).map((b) => [b.id, b]),
);

beforeAll(() => {
  const reg = TextLibraryService.registerBuiltinBooks(loadBuiltinBooks());
  expect(reg.success).toBe(true);
});

/** 书内全部段落文本 */
function allTexts(book: Book) {
  return book.chapters.flatMap((c) => c.segments).map((s) => s.text);
}

describe('内置经典数据完整性（资产解析产物）', () => {
  test('五部书均可经 TextLibraryService 端到端加载（id/标题/章数）', () => {
    for (const spec of NEW_BOOKS) {
      const res = TextLibraryService.getBook(spec.id);
      expect(res.success).toBe(true);
      expect(res.data!.id).toBe(spec.id);
      expect(res.data!.title.length).toBeGreaterThan(0);
      expect(res.data!.description.length).toBeGreaterThan(0);
      expect(res.data!.chapters).toHaveLength(spec.expectedChapters);
    }
    // 端到端：章节与段落索引可查询（资产解析 id 规律「书id-cN / -cN-sM」）
    expect(TextLibraryService.getChapter('mengzi-c1').success).toBe(true);
    expect(TextLibraryService.getSegment('zhuangzi-c1-s1').success).toBe(true);
  });

  test('章数与声明一致，且章 id/bookId/order 连续一致', () => {
    for (const spec of NEW_BOOKS) {
      const book = RAW_BY_ID[spec.id];
      expect(book.chapters).toHaveLength(spec.expectedChapters);
      book.chapters.forEach((ch, i) => {
        expect(ch.bookId).toBe(spec.id);
        expect(ch.order).toBe(i + 1);
        expect(ch.title.length).toBeGreaterThan(0);
      });
    }
  });

  test('每章 ≥1 段，段落 id/chapterId/order 严格递增且无重复', () => {
    for (const spec of NEW_BOOKS) {
      const book = RAW_BY_ID[spec.id];
      const seen = new Set<string>();
      for (const ch of book.chapters) {
        expect(ch.segments.length).toBeGreaterThanOrEqual(1);
        ch.segments.forEach((seg, i) => {
          expect(seg.chapterId).toBe(ch.id);
          expect(seg.order).toBe(i + 1);
          expect(seen.has(seg.id)).toBe(false);
          seen.add(seg.id);
        });
      }
    }
  });

  test('每段非空且包含汉字', () => {
    for (const spec of NEW_BOOKS) {
      for (const text of allTexts(RAW_BY_ID[spec.id])) {
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });

  test('无残留 HTML 标签与抓取杂项', () => {
    const junk = /<[^>]+>|<\/?[a-z]+>|姊妹计划|本作品收录于|Publicdomain|返回顶部|^\^/;
    for (const spec of NEW_BOOKS) {
      for (const text of allTexts(RAW_BY_ID[spec.id])) {
        expect(text).not.toMatch(junk);
      }
    }
  });

  test('无 ASCII 字母数字与异常字符残留', () => {
    for (const spec of NEW_BOOKS) {
      for (const text of allTexts(RAW_BY_ID[spec.id])) {
        expect(text).not.toMatch(/[A-Za-z0-9]/);
        expect(text).not.toMatch(/[<>{}[\]\\|]/);
      }
    }
  });

  test('全部文本均为 BMP 内字符（无扩展区生僻字）', () => {
    for (const spec of NEW_BOOKS) {
      for (const text of allTexts(RAW_BY_ID[spec.id])) {
        for (const ch of text) {
          expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xffff);
        }
      }
    }
  });

  test('各书总字数（含标点）落在全本合理区间', () => {
    for (const spec of NEW_BOOKS) {
      const total = allTexts(RAW_BY_ID[spec.id]).reduce((n, t) => n + t.length, 0);
      expect(total).toBeGreaterThanOrEqual(spec.charRange[0]);
      expect(total).toBeLessThanOrEqual(spec.charRange[1]);
    }
  });

  test('诗经 30 章为「风/雅/颂·篇类」式分组且含国风与雅颂', () => {
    const shijing = RAW_BY_ID.shijing;
    expect(shijing.chapters).toHaveLength(30);
    const guofeng = shijing.chapters.filter((c) => c.title.startsWith('国风·'));
    expect(guofeng.length).toBe(15); // 十五国风
    const groups = ['小雅', '大雅', '周颂', '鲁颂', '商颂'];
    for (const g of groups) {
      expect(shijing.chapters.some((c) => c.title.startsWith(`${g}·`))).toBe(true);
    }
    // 关雎为首章首篇（「◆ 关雎」诗题行 + 「关关雎鸠」正文）
    const first = shijing.chapters[0];
    expect(first.title).toBe('国风·周南');
    expect(first.segments.map((s) => s.text).join('\n')).toContain('关关雎鸠');
  });

  test('章节首段以传世开句开头（庄子内篇 7 + 荀子 4 + 孟子/楚辞样本）', () => {
    const OPENINGS: Array<[string, number, string]> = [
      ['zhuangzi', 1, '北冥有鱼，其名为鲲'],
      ['zhuangzi', 2, '南郭子綦'],
      ['zhuangzi', 3, '吾生也有涯'],
      ['zhuangzi', 4, '颜回见仲尼'],
      ['zhuangzi', 5, '鲁有兀者王骀'],
      ['zhuangzi', 6, '知天之所为'],
      ['zhuangzi', 7, '啮缺问于王倪'],
      ['xunzi', 1, '君子曰：学不可以已'],
      ['xunzi', 2, '见善，修然必以自存也'],
      ['xunzi', 3, '君子行不贵苟难'],
      ['xunzi', 4, '憍泄者，人之殃也'],
      ['mengzi', 1, '孟子见梁惠王'],
      ['chuci', 1, '帝高阳之苗裔兮'],
    ];
    for (const [bookId, order, opening] of OPENINGS) {
      const ch = RAW_BY_ID[bookId].chapters[order - 1];
      // 跳过「◆ 诗题」引导段（诗词类资产的首段是篇名行）
      const first = ch.segments.find((sg) => !sg.text.startsWith('◆'))!;
      expect(first.text.startsWith(opening)).toBe(true);
    }
  });

  test('章节末段以传世收句收尾（庄子内篇 7 + 荀子 4 + 离骚）', () => {
    const ENDINGS: Array<[string, number, string]> = [
      ['zhuangzi', 1, '安所困苦哉！”'],
      ['zhuangzi', 2, '此之谓物化。'],
      ['zhuangzi', 3, '不知其尽也。'],
      ['zhuangzi', 4, '无用之用也。'],
      ['zhuangzi', 5, '子以坚白鸣。”'],
      ['zhuangzi', 6, '命也夫！”'],
      ['zhuangzi', 7, '七日而浑沌死。'],
      ['xunzi', 1, '君子贵其全也。'],
      ['xunzi', 2, '以公义胜私欲也。'],
      ['xunzi', 3, '田仲、史鰌不如盗也。'],
      ['xunzi', 4, '此之谓也。'],
      ['chuci', 1, '吾将从彭咸之所居！'],
    ];
    for (const [bookId, order, ending] of ENDINGS) {
      const ch = RAW_BY_ID[bookId].chapters[order - 1];
      const text = ch.segments[ch.segments.length - 1].text;
      expect(text.endsWith(ending)).toBe(true);
    }
  });

  test('逍遥游全章完整（含齐谐/野马/风之积等全部内容），篇幅 ≥ 1000 字', () => {
    const chapter = RAW_BY_ID.zhuangzi.chapters[0];
    const text = chapter.segments.map((s) => s.text).join('');
    expect(text).toContain('《齐谐》者，志怪者也');
    expect(text).toContain('野马也，尘埃也');
    expect(text).toContain('且夫水之积也不厚');
    expect(text).toContain('背负青天');
    expect(text.length).toBeGreaterThanOrEqual(1000);
  });
});
