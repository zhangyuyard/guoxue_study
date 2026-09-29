/**
 * R3-1 翻页纯函数测试——「滚动↔翻页互切位置往返」判据承载（纪律 §4.3）。
 *
 * 变异判据（判据必须会红）：
 * - M1 pageAtOffset 用 round ⇒ T2 往返红（页首前半屏误归下页）；
 * - M2 pageCount 用 ceil(lineCount/linesPerPage) ⇒ T3 红（末页 offset 超过
 *   maxScroll 滚不到 ⇒ 越界页永远无法抵达 = 死页）。
 */
import { chunkLines, offsetOfPage, pageAtOffset, paginateChapter } from '@/reader/pagination';
import { layoutChapter, resolveGeometry } from '@/reader/geometry';

/** 默认档几何 + 注音开（ResolveGeometryInput 真值字段） */
const G = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 350 });

/** 单段长文 → N 行布局（一行 = charsPerLine 码点） */
function makeLayout(lineCount: number) {
  const text = '字'.repeat(lineCount * G.charsPerLine);
  return layoutChapter('ch1', [{ id: 'seg1', text }], G);
}

const VP = 800; // 视口 800px；注音开 rowHeight=50 ⇒ 16 行/页，pageStride=800

describe('paginateChapter（R3-1 章分页）', () => {
  test('T1 行对齐：普通页 offset 均为 rowHeight 整数倍；末页 = maxScroll 特判', () => {
    const layout = makeLayout(100);
    const p = paginateChapter(layout, G, VP);
    expect(p.linesPerPage).toBe(Math.floor(VP / G.rowHeight));
    for (let page = 0; page < p.pageCount - 1; page += 1) {
      const y = offsetOfPage(p, page);
      expect(y % G.rowHeight).toBe(0);
      expect(y).toBeLessThanOrEqual(p.maxScroll); // 滚动可达
    }
    // 末页特判 = maxScroll（滚到底；viewport 非 stride 倍数时允许非行对齐）
    expect(offsetOfPage(p, p.pageCount - 1)).toBe(p.maxScroll);
  });

  test('T2 往返判据：pageAtOffset(offsetOfPage(p)) === p 对全可达页域成立（M1 判据）', () => {
    for (const lineCount of [100, 105, 128, 129]) {
      const layout = makeLayout(lineCount);
      const p = paginateChapter(layout, G, VP);
      expect(p.pageCount).toBeGreaterThan(1);
      for (let page = 0; page < p.pageCount; page += 1) {
        const y = offsetOfPage(p, page);
        expect(pageAtOffset(p, y)).toBe(page);
      }
      // 末页 = 滚到底（余数行模型）：pageAtOffset(maxScroll) 也落在末页
      expect(pageAtOffset(p, p.maxScroll)).toBe(p.pageCount - 1);
      // 页中间归当前页（floor 语义；round 变异在半页点向上跳页即红）
      expect(pageAtOffset(p, Math.floor(p.pageStride / 2))).toBe(0);
      expect(pageAtOffset(p, p.pageStride + Math.floor(p.pageStride / 2))).toBe(1);
    }
  });

  test('T3 末页可达且见尾行：越界翻页 clamp 到 maxScroll，起点行 = lineCount−linesPerPage（M2 判据）', () => {
    // 105 行 / 16 行每页：maxScroll = 105×50−800 = 4450；余数 9 行并入末页视口
    const layout = makeLayout(105);
    const p = paginateChapter(layout, G, VP);
    expect(p.maxScroll).toBe(105 * G.rowHeight - VP);
    // 越界请求（page = pageCount）clamp 到 maxScroll —— 与「滚到底」同落点
    const yBeyond = offsetOfPage(p, p.pageCount);
    expect(yBeyond).toBe(p.maxScroll);
    // 该落点能看到最后一行：startLine = maxScroll/rowHeight = 105−16
    expect(yBeyond / G.rowHeight).toBe(105 - p.linesPerPage);
    // 落点页号不越界（floor 语义共享页号 = 模型性质，legado 同口径）
    expect(pageAtOffset(p, yBeyond)).toBe(p.pageCount - 1);
  });

  test('T4 边界：空章 / 零视口 → pageCount 0；单页章 → 1 页', () => {
    expect(paginateChapter(makeLayout(0), G, VP).pageCount).toBe(0);
    expect(paginateChapter(makeLayout(10), G, 0).pageCount).toBe(0);
    expect(paginateChapter(makeLayout(10), G, VP).pageCount).toBe(1);
    expect(paginateChapter(makeLayout(10), G, -5).pageCount).toBe(0);
  });

  test('T5 互切不变量：任意滚动 y（含页中间）向前翻页，落点单调不回退', () => {
    const layout = makeLayout(200);
    const p = paginateChapter(layout, G, VP);
    let prevY = 0;
    for (let y = 0; y <= p.maxScroll; y += G.rowHeight * 3) {
      const page = pageAtOffset(p, y);
      const nextY = offsetOfPage(p, Math.min(page + 1, p.pageCount - 1));
      expect(nextY).toBeGreaterThanOrEqual(prevY);
      prevY = nextY;
    }
  });
});

describe('chunkLines（R3-scroll 离散页切块）', () => {
  it('定长切块；末页 = 余数行', () => {
    const lines = Array.from({ length: 25 }, (_, i) => i);
    const pages = chunkLines(lines, 10);
    expect(pages.length).toBe(3);
    expect(pages[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pages[2]).toEqual([20, 21, 22, 23, 24]);
  });

  it('整除 → 无余数页；size ≤ 0 / 空输入 → 空', () => {
    expect(chunkLines([1, 2, 3, 4], 2).length).toBe(2);
    expect(chunkLines([1], 0)).toEqual([]);
    expect(chunkLines([], 10)).toEqual([]);
  });

  it('切块保序且不丢不重（拼接行全局恒等）', () => {
    const lines = Array.from({ length: 103 }, (_, i) => i);
    const pages = chunkLines(lines, 13);
    expect(pages.flat()).toEqual(lines);
  });
});
