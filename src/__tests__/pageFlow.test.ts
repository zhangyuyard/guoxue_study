/**
 * pageFlow 页流解析测试（legado TextPageFactory 机制对齐）。
 * 覆盖：章内跨页 / 跨章 p0 / 上章末页 / 书首书尾封口 / 空章 / 末页余数 / resolveN 跨章步进 / 窗口外 ref。
 */
import {
  pageCountOf,
  pageLinesOf,
  resolvePage,
  resolveN,
  type ScrollChapter,
  type PageRef,
} from '../reader/pageFlow';
import type { Line } from '../reader/geometry';

function mkLine(chapterId: string, seg: string, charStart: number): Line {
  return {
    chapterId,
    segmentId: seg,
    charStart,
    charEnd: charStart + 1,
    index: 0,
  };
}

function mkChapter(chapterId: string, lineCount: number): ScrollChapter {
  const lines: Line[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(mkLine(chapterId, `seg-${i}`, i * 10));
  }
  return { chapterId, lines };
}

const LPP = 3;
const RH = 20;

// 3 章：A 7 行(3 页: 3+3+1)、B 6 行(2 页)、C 2 行(1 页)
const chapters: ScrollChapter[] = [mkChapter('A', 7), mkChapter('B', 6), mkChapter('C', 2)];

describe('pageCountOf', () => {
  test('满页与余数页', () => {
    expect(pageCountOf(chapters[0], LPP)).toBe(3);
    expect(pageCountOf(chapters[2], LPP)).toBe(1);
  });

  test('空章 = 1 页（legado 空内容标题页）', () => {
    expect(pageCountOf({ chapterId: 'E', lines: [] }, LPP)).toBe(1);
  });

  test('linesPerPage 非法值防御', () => {
    expect(pageCountOf(chapters[0], 0)).toBe(7);
  });
});

describe('pageLinesOf', () => {
  test('末页 = 余数行', () => {
    const lines = pageLinesOf(chapters[0], LPP, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0].segmentId).toBe('seg-6');
  });

  test('整页切片', () => {
    const lines = pageLinesOf(chapters[0], LPP, 0);
    expect(lines).toHaveLength(3);
    expect(lines[0].charStart).toBe(0);
    expect(lines[2].charStart).toBe(20);
  });
});

describe('resolvePage', () => {
  const ref = (chapterId: string, page: number): PageRef => ({ chapterId, page });

  test('章内下一页', () => {
    const r = resolvePage(chapters, LPP, RH, ref('A', 0), 1);
    expect(r).not.toBeNull();
    expect(r!.ref).toEqual(ref('A', 1));
    expect(r!.height).toBe(3 * RH);
  });

  test('章尾 → 下一章 p0（含标题行的章首，legado nextPage L86-90）', () => {
    const r = resolvePage(chapters, LPP, RH, ref('A', 2), 1);
    expect(r!.ref).toEqual(ref('B', 0));
    expect(r!.lines[0].chapterId).toBe('B');
  });

  test('书尾封口 → null（末章末页）', () => {
    expect(resolvePage(chapters, LPP, RH, ref('C', 0), 1)).toBeNull();
  });

  test('书首封口 → null（首章 p0 向上）', () => {
    expect(resolvePage(chapters, LPP, RH, ref('A', 0), -1)).toBeNull();
  });

  test('章首向上 → 上章末页（legado prevPage L104-108）', () => {
    const r = resolvePage(chapters, LPP, RH, ref('B', 0), -1);
    expect(r!.ref).toEqual(ref('A', 2));
    expect(r!.lines[0].segmentId).toBe('seg-6');
  });

  test('当前页解析（dir=0）', () => {
    const r = resolvePage(chapters, LPP, RH, ref('B', 1), 0);
    expect(r!.ref).toEqual(ref('B', 1));
    expect(r!.height).toBe(3 * RH);
  });

  test('ref 不在窗口 → null（调用方以 hasMore 区分 loading/书尾）', () => {
    expect(resolvePage(chapters, LPP, RH, ref('X', 0), 1)).toBeNull();
  });
});

describe('resolveN（legado nextPlusPage 跨章规则）', () => {
  test('章内步进 2', () => {
    const r = resolveN(chapters, LPP, RH, { chapterId: 'A', page: 0 }, 2);
    expect(r!.ref).toEqual({ chapterId: 'A', page: 2 });
  });

  test('跨章步进：A 末页 +2 = B p1（legado TextPageFactory L120-124）', () => {
    const r = resolveN(chapters, LPP, RH, { chapterId: 'A', page: 2 }, 2);
    expect(r!.ref).toEqual({ chapterId: 'B', page: 1 });
  });

  test('中途书尾 → null', () => {
    expect(resolveN(chapters, LPP, RH, { chapterId: 'C', page: 0 }, 2)).toBeNull();
  });

  test('n=1 等价 resolvePage(+1)', () => {
    const r = resolveN(chapters, LPP, RH, { chapterId: 'A', page: 1 }, 1);
    expect(r!.ref).toEqual({ chapterId: 'A', page: 2 });
  });
});
