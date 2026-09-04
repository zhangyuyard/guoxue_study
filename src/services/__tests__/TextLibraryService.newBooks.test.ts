/**
 * B5 文本库扩充数据完整性测试
 * 锁定新增五部内置经典（孟子/庄子/诗经/荀子/楚辞）的结构与内容质量：
 * - 每部书章数与声明一致、每章 ≥1 段、每段非空
 * - 无残留 HTML 标签 / 抓取杂项 / ASCII 异常字符 / 扩展区生僻字
 * - 总字数落在合理区间；经 TextLibraryService 端到端可加载
 */
import { TextLibraryService } from '@/services/TextLibraryService';
import type { Book } from '@/types';

import mengziData from '@/data/texts/mengzi.json';
import zhuangziData from '@/data/texts/zhuangzi.json';
import shijingData from '@/data/texts/shijing.json';
import xunziData from '@/data/texts/xunzi.json';
import chuciData from '@/data/texts/chuci.json';

/** 新书清单（id → 期望章数） */
const NEW_BOOKS: Array<{ id: string; expectedChapters: number; charRange: [number, number] }> = [
  { id: 'mengzi', expectedChapters: 5, charRange: [10000, 20000] },
  { id: 'zhuangzi', expectedChapters: 7, charRange: [10000, 18000] },
  { id: 'shijing', expectedChapters: 30, charRange: [3000, 6000] },
  { id: 'xunzi', expectedChapters: 4, charRange: [6000, 11000] },
  { id: 'chuci', expectedChapters: 6, charRange: [2500, 5000] },
];

const RAW_BY_ID: Record<string, Book> = {
  mengzi: mengziData as unknown as Book,
  zhuangzi: zhuangziData as unknown as Book,
  shijing: shijingData as unknown as Book,
  xunzi: xunziData as unknown as Book,
  chuci: chuciData as unknown as Book,
};

/** 收集某书的全部段落 */
function segmentsOf(book: Book) {
  return book.chapters.flatMap((c) => c.segments);
}

/** 书内全部段落文本 */
function allTexts(book: Book) {
  return segmentsOf(book).map((s) => s.text);
}

describe('B5 新增五部经典数据完整性', () => {
  test('五部书均可经 TextLibraryService 端到端加载（id/标题/分类/章数）', () => {
    for (const spec of NEW_BOOKS) {
      const res = TextLibraryService.getBook(spec.id);
      expect(res.success).toBe(true);
      expect(res.data!.id).toBe(spec.id);
      expect(res.data!.title.length).toBeGreaterThan(0);
      expect(res.data!.description.length).toBeGreaterThan(0);
      expect(res.data!.chapters).toHaveLength(spec.expectedChapters);
    }
    // 端到端：章节与段落索引可查询（各取一个样本）
    expect(TextLibraryService.getChapter('mengzi-liang-hui-wang-shang').success).toBe(true);
    expect(TextLibraryService.getSegment('zhuangzi-xiao-yao-you-1').success).toBe(true);
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

  test('无残留 HTML 标签与抓取杂项（编辑/姊妹计划/一作/毛诗序等）', () => {
    const junk = /<[^>]+>|<\/?[a-z]+>|姊妹计划|本作品收录于|一作[“「]|毛诗序|Publicdomain|返回顶部|^\^/;
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

  test('各书总字数（含标点）落在合理区间', () => {
    for (const spec of NEW_BOOKS) {
      const total = allTexts(RAW_BY_ID[spec.id]).reduce((n, t) => n + t.length, 0);
      expect(total).toBeGreaterThanOrEqual(spec.charRange[0]);
      expect(total).toBeLessThanOrEqual(spec.charRange[1]);
    }
    // 五部合计约 2.5-5 万字（含标点）
    const grandTotal = NEW_BOOKS.reduce(
      (n, spec) => n + allTexts(RAW_BY_ID[spec.id]).reduce((m, t) => m + t.length, 0),
      0,
    );
    expect(grandTotal).toBeGreaterThanOrEqual(25000);
    expect(grandTotal).toBeLessThanOrEqual(50000);
  });

  test('诗经 30 章均为「风/雅/颂·篇名」式标题且 20 首来自国风', () => {
    const shijing = RAW_BY_ID.shijing;
    expect(shijing.chapters).toHaveLength(30);
    const guofeng = shijing.chapters.filter((c) => c.title.startsWith('国风·'));
    expect(guofeng.length).toBe(20);
    const groups = ['小雅', '大雅', '周颂', '商颂'];
    for (const g of groups) {
      expect(shijing.chapters.some((c) => c.title.startsWith(`${g}·`))).toBe(true);
    }
    // 抽查代表篇目存在
    expect(shijing.chapters.map((c) => c.title)).toContain('国风·周南·关雎');
    expect(shijing.chapters.map((c) => c.title)).toContain('小雅·采薇');
  });
});

// ============ B5 打回修复回归：导航残留清洗与权威开句锁定 ============

/** 五部书全部段落文本（从源 JSON 读取，含新增回归用） */
function allSegmentsAllBooks(): Array<{ book: string; chapterId: string; text: string }> {
  const out: Array<{ book: string; chapterId: string; text: string }> = [];
  for (const spec of NEW_BOOKS) {
    for (const ch of RAW_BY_ID[spec.id].chapters) {
      for (const seg of ch.segments) {
        out.push({ book: spec.id, chapterId: ch.id, text: seg.text });
      }
    }
  }
  return out;
}

describe('B5 打回修复回归（导航残留清洗）', () => {
  test('任意段不得以翻页箭头（←/→）或「篇第X」目录行开头', () => {
    const leadNav = /^.{0,4}(←|→)/;
    const tocLine = /^[^，。！？；]{0,6}第[一二三四五六七八九十]+篇/;
    for (const seg of allSegmentsAllBooks()) {
      expect(leadNav.test(seg.text) ? `${seg.book}/${seg.chapterId}: ${seg.text.slice(0, 30)}` : '').toBe('');
      expect(tocLine.test(seg.text) ? `${seg.book}/${seg.chapterId}: ${seg.text.slice(0, 30)}` : '').toBe('');
    }
  });

  test('任意段不得以「篇第X」目录行或箭头结尾（短段判定）', () => {
    const tailNav = /第[一二三四五六七八九十]+篇$|^.{0,4}(←|→)/;
    for (const seg of allSegmentsAllBooks()) {
      if (seg.text.length < 40) {
        expect(tailNav.test(seg.text) ? `${seg.book}/${seg.chapterId}: ${seg.text}` : '').toBe('');
      }
    }
  });

  test('各章首段以传世开句开头（庄子内篇 7 + 荀子 4 + 孟子/诗经/楚辞样本）', () => {
    const OPENINGS: Array<[string, string]> = [
      ['zhuangzi-xiao-yao-you', '北冥有鱼，其名为鲲'],
      ['zhuangzi-qi-wu-lun', '南郭子綦'],
      ['zhuangzi-yang-sheng-zhu', '吾生也有涯'],
      ['zhuangzi-ren-jian-shi', '颜回见仲尼'],
      ['zhuangzi-de-chong-fu', '鲁有兀者王骀'],
      ['zhuangzi-da-zong-shi', '知天之所为'],
      ['zhuangzi-ying-di-wang', '啮缺问于王倪'],
      ['xunzi-quan-xue', '君子曰：学不可以已'],
      ['xunzi-xiu-shen', '见善，修然必以自存也'],
      ['xunzi-bu-gou', '君子行不贵苟难'],
      ['xunzi-rong-ru', '憍泄者，人之殃也'],
      ['mengzi-liang-hui-wang-shang', '孟子见梁惠王'],
      ['chuci-li-sao', '帝高阳之苗裔兮'],
    ];
    const firstSegments = new Map<string, string>();
    for (const spec of NEW_BOOKS) {
      for (const ch of RAW_BY_ID[spec.id].chapters) {
        firstSegments.set(ch.id, ch.segments[0].text);
      }
    }
    for (const [chapterId, opening] of OPENINGS) {
      const text = firstSegments.get(chapterId);
      expect(text).toBeDefined();
      expect(text!.startsWith(opening)).toBe(true);
    }
    // 诗经样本：关雎首段以「关关雎鸠」开头
    const guanju = RAW_BY_ID.shijing.chapters.find((c) => c.id === 'shijing-guan-ju')!;
    expect(guanju.segments[0].text.startsWith('关关雎鸠')).toBe(true);
  });

  test('各章末段以传世收句收尾（庄子内篇 7 + 荀子 4 + 离骚）', () => {
    const ENDINGS: Array<[string, string]> = [
      // 庄子三处以引语收尾，末段含传世文本的收引号（”）
      ['zhuangzi-xiao-yao-you', '安所困苦哉！”'],
      ['zhuangzi-qi-wu-lun', '此之谓物化。'],
      ['zhuangzi-yang-sheng-zhu', '不知其尽也。'],
      ['zhuangzi-ren-jian-shi', '无用之用也。'],
      ['zhuangzi-de-chong-fu', '子以坚白鸣！”'],
      ['zhuangzi-da-zong-shi', '命也夫！”'],
      ['zhuangzi-ying-di-wang', '七日而浑沌死。'],
      ['xunzi-quan-xue', '君子贵其全也。'],
      ['xunzi-xiu-shen', '以公义胜私欲也。'],
      ['xunzi-bu-gou', '田仲、史䲡不如盗也。'],
      ['xunzi-rong-ru', '此之谓也。'],
      ['chuci-li-sao', '吾将从彭咸之所居。'],
    ];
    const lastSegments = new Map<string, string>();
    for (const spec of NEW_BOOKS) {
      for (const ch of RAW_BY_ID[spec.id].chapters) {
        lastSegments.set(ch.id, ch.segments[ch.segments.length - 1].text);
      }
    }
    for (const [chapterId, ending] of ENDINGS) {
      const text = lastSegments.get(chapterId);
      expect(text).toBeDefined();
      expect(text!.endsWith(ending)).toBe(true);
    }
  });

  test('逍遥游开头段完整（含齐谐/野马/风之积等全部内容），篇幅 ≥ 250 字', () => {
    const seg = RAW_BY_ID.zhuangzi.chapters.find((c) => c.id === 'zhuangzi-xiao-yao-you')!.segments[0];
    expect(seg.text).toContain('《齐谐》者，志怪者也');
    expect(seg.text).toContain('野马也，尘埃也');
    expect(seg.text).toContain('且夫水之积也不厚');
    expect(seg.text).toContain('背负青天');
    expect(seg.text.length).toBeGreaterThanOrEqual(250);
  });
});
