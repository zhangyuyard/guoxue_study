/**
 * stitch.ts 单测（R3-stitch 纯逻辑）。
 * 覆盖：渲染序（双边/单边/锚缺失）、拼接行（首行下标/行数/章归属）、
 * 滚动补偿量（前插正/前删负/后插0/锚缺失0）。
 *
 * 变异判据：若 compensationDelta 恒返 0（死常量），prepend/drop 用例必红；
 * 若 buildStitchedLines 不累加首行下标，firstLineOf 用例必红。
 */
import { ChapterLayout, Line } from '@/reader/geometry';
import {
  buildStitchedLines,
  compensationDelta,
  orderedRenderChapters,
  type SiblingMap,
} from '@/reader/stitch';

const RH = 24;

function makeLayout(chapterId: string, n: number): ChapterLayout {
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    lines.push({
      index: i,
      chapterId,
      segmentId: `${chapterId}-s0`,
      charStart: i * 10,
      charEnd: (i + 1) * 10,
    });
  }
  return { lines, totalHeight: n * RH };
}

/** 线性章链 A<->B<->C<->D 的章序查询 */
function chainSibling(adj: Record<string, SiblingMap>) {
  return (id: string): SiblingMap => adj[id] ?? {};
}

const CHAIN: Record<string, SiblingMap> = {
  A: { next: { id: 'B' } },
  B: { prev: { id: 'A' }, next: { id: 'C' } },
  C: { prev: { id: 'B' }, next: { id: 'D' } },
  D: { prev: { id: 'C' } },
};

describe('orderedRenderChapters', () => {
  it('锚章两边均已装载 → 连续三章', () => {
    const ids = new Set(['A', 'B', 'C']);
    expect(orderedRenderChapters(ids, 'B', chainSibling(CHAIN))).toEqual(['A', 'B', 'C']);
  });

  it('仅锚章装载（邻章未就绪）→ 单章', () => {
    const ids = new Set(['B']);
    expect(orderedRenderChapters(ids, 'B', chainSibling(CHAIN))).toEqual(['B']);
  });

  it('仅上游装载 → [A,B]', () => {
    const ids = new Set(['A', 'B']);
    expect(orderedRenderChapters(ids, 'B', chainSibling(CHAIN))).toEqual(['A', 'B']);
  });

  it('仅下游装载 → [B,C]', () => {
    const ids = new Set(['B', 'C']);
    expect(orderedRenderChapters(ids, 'B', chainSibling(CHAIN))).toEqual(['B', 'C']);
  });

  it('锚章不在 data → 空', () => {
    const ids = new Set(['A', 'C']);
    expect(orderedRenderChapters(ids, 'B', chainSibling(CHAIN))).toEqual([]);
  });

  it('孤立章（无邻接）→ 单章', () => {
    const ids = new Set(['X']);
    expect(orderedRenderChapters(ids, 'X', chainSibling({}))).toEqual(['X']);
  });
});

describe('buildStitchedLines', () => {
  const layouts: Record<string, ChapterLayout> = {
    A: makeLayout('A', 3),
    B: makeLayout('B', 2),
    C: makeLayout('C', 4),
  };
  const layoutOf = (id: string) => layouts[id];

  it('拼接行数与首行下标自洽', () => {
    const r = buildStitchedLines(['A', 'B', 'C'], layoutOf);
    expect(r.lines.length).toBe(9);
    expect(r.firstLineOf.get('A')).toBe(0);
    expect(r.firstLineOf.get('B')).toBe(3);
    expect(r.firstLineOf.get('C')).toBe(5);
    expect(r.lineCountOf.get('A')).toBe(3);
    expect(r.lineCountOf.get('B')).toBe(2);
    expect(r.lineCountOf.get('C')).toBe(4);
  });

  it('每行保留原 chapterId', () => {
    const r = buildStitchedLines(['A', 'B'], layoutOf);
    expect(r.lines[0].chapterId).toBe('A');
    expect(r.lines[3].chapterId).toBe('B');
    expect(r.lines[3].charStart).toBe(0);
  });

  it('layoutOf 缺失的章被跳过', () => {
    const r = buildStitchedLines(['A', 'X', 'C'], (id) => (id === 'X' ? undefined : layoutOf(id)));
    expect(r.lines.length).toBe(7);
    expect(r.firstLineOf.has('X')).toBe(false);
    expect(r.firstLineOf.get('C')).toBe(3);
  });
});

describe('compensationDelta', () => {
  const counts = new Map<string, number>([
    ['A', 3],
    ['B', 2],
    ['C', 4],
    ['D', 5],
  ]);

  it('序未变 → 0', () => {
    expect(compensationDelta(['A', 'B', 'C'], ['A', 'B', 'C'], counts, 'B', RH)).toBe(0);
  });

  it('锚章上方前插章 → 正（锚被下推）', () => {
    // 原 [B,C]；新 [A,B,C]：锚 B 首行 0 → 3，delta = +3*RH
    expect(compensationDelta(['B', 'C'], ['A', 'B', 'C'], counts, 'B', RH)).toBe(3 * RH);
  });

  it('锚章上方前删章 → 负（锚被上提）', () => {
    // 原 [A,B,C]；新 [B,C]：锚 B 首行 3 → 0，delta = -3*RH
    expect(compensationDelta(['A', 'B', 'C'], ['B', 'C'], counts, 'B', RH)).toBe(-3 * RH);
  });

  it('锚章下方追加章 → 0（不位移）', () => {
    // [A,B] → [A,B,C]：锚 B 首行均为 3
    expect(compensationDelta(['A', 'B'], ['A', 'B', 'C'], counts, 'B', RH)).toBe(0);
  });

  it('锚章在 prevOrder 缺失 → 0（退化）', () => {
    expect(compensationDelta(['A', 'C'], ['A', 'B', 'C'], counts, 'B', RH)).toBe(0);
  });

  it('锚章在 nextOrder 缺失 → 0（退化）', () => {
    expect(compensationDelta(['A', 'B', 'C'], ['A', 'C'], counts, 'B', RH)).toBe(0);
  });

  it('随行高线性缩放', () => {
    expect(compensationDelta(['B', 'C'], ['A', 'B', 'C'], counts, 'B', 30)).toBe(3 * 30);
  });
});
