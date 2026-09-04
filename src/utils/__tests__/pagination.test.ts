/**
 * paginateBlocks 纯函数单测（与 RN 渲染无关）。
 * 覆盖：基础装箱、段间距累加、单段超高溢出、整页恰好填满、空输入。
 */
import {
  computeChunkBoundaries,
  paginateBlocks,
  type PaginateBlock,
} from '@/utils/pagination';

const B = (id: string, height: number): PaginateBlock => ({ id, height });

describe('paginateBlocks', () => {
  test('按段高贪心装箱，段间距正确累加', () => {
    const blocks = [B('a', 40), B('b', 40), B('c', 40), B('d', 40)];
    const pages = paginateBlocks(blocks, 100, 10);
    // a(40)+b(40)=80；加 c 需 80+10+40=130>100 → 换行
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((x) => x.id)).toEqual(['a', 'b']);
    expect(pages[0].height).toBe(90);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['c', 'd']);
    expect(pages[1].height).toBe(90);
    expect(pages.every((p) => p.overflow === false)).toBe(true);
  });

  test('单段超高 → 独占一页并标记 overflow', () => {
    const blocks = [B('a', 40), B('e', 150), B('d', 40)];
    const pages = paginateBlocks(blocks, 100, 10);
    expect(pages).toHaveLength(3);
    expect(pages[0].blocks.map((x) => x.id)).toEqual(['a']);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['e']);
    expect(pages[1].overflow).toBe(true);
    expect(pages[2].blocks.map((x) => x.id)).toEqual(['d']);
  });

  test('恰好填满整页（含间距）不溢出', () => {
    // 40 + 10 + 40 = 90，预算 90 → 恰好放下
    const blocks = [B('a', 40), B('b', 40)];
    const pages = paginateBlocks(blocks, 90, 10);
    expect(pages).toHaveLength(1);
    expect(pages[0].height).toBe(90);
    expect(pages[0].overflow).toBe(false);
  });

  test('单段高度等于页高 → 不标记 overflow', () => {
    const pages = paginateBlocks([B('a', 100)], 100, 0);
    expect(pages).toHaveLength(1);
    expect(pages[0].overflow).toBe(false);
  });

  test('段间距为 0 时连续装箱', () => {
    const blocks = [B('a', 30), B('b', 30), B('c', 30), B('d', 30)];
    const pages = paginateBlocks(blocks, 60, 0);
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((x) => x.id)).toEqual(['a', 'b']);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['c', 'd']);
  });

  test('空输入返回空页数组', () => {
    expect(paginateBlocks([], 100, 10)).toEqual([]);
  });
});

describe('paginateBlocks keepWithNext（章标题不单独成页）', () => {
  const TITLE = '__title__';
  const keepTitleOnly = (id: string) => id === TITLE;

  test('首段超高时，标题不再独占首页（回归：空白首页）', () => {
    const blocks = [B(TITLE, 40), B('long', 500), B('c', 40)];
    const pages = paginateBlocks(blocks, 300, 0, keepTitleOnly);
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((x) => x.id)).toEqual([TITLE, 'long']);
    expect(pages[0].overflow).toBe(true);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['c']);
    expect(pages[1].overflow).toBe(false);
  });

  test('标题 + 首段超过页高时顺延同页，而非把首段整段挤到下一页', () => {
    const blocks = [B(TITLE, 40), B('a', 280), B('b', 40)];
    const pages = paginateBlocks(blocks, 300, 0, keepTitleOnly);
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((x) => x.id)).toEqual([TITLE, 'a']);
    expect(pages[0].overflow).toBe(true);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['b']);
  });

  test('标题 + 首段放得下时，首页仍按常规贪心装满', () => {
    const blocks = [B(TITLE, 40), B('a', 100), B('b', 100), B('c', 100)];
    const pages = paginateBlocks(blocks, 250, 0, keepTitleOnly);
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((x) => x.id)).toEqual([TITLE, 'a', 'b']);
    expect(pages[0].overflow).toBe(false);
    expect(pages[1].blocks.map((x) => x.id)).toEqual(['c']);
  });

  test('未命中 keepWithNext 的块仍可单独成页（不误伤常规分页）', () => {
    const blocks = [B('a', 40), B('b', 40), B('c', 40)];
    const pages = paginateBlocks(blocks, 50, 0, keepTitleOnly);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.blocks[0].id)).toEqual(['a', 'b', 'c']);
  });
});

describe('computeChunkBoundaries（超高段按码点拆分）', () => {
  test('未超高的段不拆分：返回 [0, charCount]', () => {
    expect(computeChunkBoundaries(100, 300, 50)).toEqual([0, 50]);
    expect(computeChunkBoundaries(300, 300, 50)).toEqual([0, 50]);
  });

  test('非法输入返回整段：预算非正 / 单字符', () => {
    expect(computeChunkBoundaries(500, 0, 50)).toEqual([0, 50]);
    expect(computeChunkBoundaries(500, -1, 50)).toEqual([0, 50]);
    expect(computeChunkBoundaries(500, 100, 1)).toEqual([0, 1]);
    expect(computeChunkBoundaries(500, 100, 0)).toEqual([0, 0]);
  });

  test('贪心填充：每块填满一页预算（floor 取整不超预算）', () => {
    // 700 / 300 → perChar = 7 → 每块 floor(300/7) = 42 个码点
    const bounds = computeChunkBoundaries(700, 300, 100);
    expect(bounds).toEqual([0, 42, 84, 100]);
  });

  test('firstBudget：第一块只填当前页剩余空间，剩余从下一页开始', () => {
    // 段所在页已用 200，剩 100 → 第一块 floor(100/7)=14 个码点，其后每块 42
    const bounds = computeChunkBoundaries(700, 300, 100, 100);
    expect(bounds).toEqual([0, 14, 56, 98, 100]);
    // 每块码点数 × perChar ≤ 对应预算（首块用 firstBudget，其余用整页）
    expect((bounds[1] - bounds[0]) * 7).toBeLessThanOrEqual(100);
    expect((bounds[2] - bounds[1]) * 7).toBeLessThanOrEqual(300);
  });

  test('firstBudget ≤ 0 时按整页预算处理', () => {
    const bounds = computeChunkBoundaries(700, 300, 100, 0);
    expect(bounds).toEqual([0, 42, 84, 100]);
  });

  test('拆分边界严格递增且覆盖全部码点（左闭右开无缝，孤块并入末块）', () => {
    const bounds = computeChunkBoundaries(1000, 250, 97);
    // perChar ≈ 10.31 → 每块 floor(250/10.31) = 24 → 0,24,48,72,96,97；
    // 末块仅 1 个码点 < 2 → 并入前一块 → 末块 25 个码点
    expect(bounds).toEqual([0, 24, 48, 72, 97]);
    expect(bounds[0]).toBe(0);
    expect(bounds[bounds.length - 1]).toBe(97);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    }
  });

  test('k 超过字符数时不产生空块', () => {
    // 高度 5000 / 预算 10 → k=500，但只有 7 个字符
    const bounds = computeChunkBoundaries(5000, 10, 7);
    expect(bounds[bounds.length - 1]).toBe(7);
    expect(bounds.slice(1, -1).every((b) => b > 0 && b < 7)).toBe(true);
    expect(new Set(bounds).size).toBe(bounds.length);
  });
});
