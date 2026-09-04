/**
 * 滚动阅读初始渲染行数计算测试（BugFix：滚动模式下导入书无法即时滚动）
 * 锁定两条行为：内置书（短段落）保持固定 30 行不变；导入书（MAX_SEGMENT_CHARS
 * 级别的大段落）按字符预算收缩初始行数，首帧不再压入数万字格。
 * 另含源码结构断言：ReaderScreen 必须使用预算计算，禁止回退为固定行数。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { parseTxtBook } from '@/services/UserBookService';
import {
  computeScrollInitialRows,
  isWithinPreloadWindow,
  planHeadDrop,
  SCROLL_INITIAL_ROWS_DEFAULTS,
} from '@/utils/readerScroll';

const SRC_ROOT = join(__dirname, '..', '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

/** 标题行计 0 字 + 段落行计各自码点数（与 ReaderScreen 传入方式一致） */
function chapterRowCounts(segments: { text: string }[]): number[] {
  return [0, ...segments.map((s) => Array.from(s.text).length)];
}

describe('computeScrollInitialRows：内置书场景（行为不变）', () => {
  test('短段落（道德经级：每段几十字）维持固定 30 行', () => {
    // 30 行 × 平均 80 字 = 2400 字，平均行长 80 ≤ 300
    const counts = [0, ...Array.from({ length: 30 }, () => 80)];
    expect(computeScrollInitialRows(counts)).toBe(30);
  });

  test('行数不足 30 且均在预算内：返回 maxRows（全量渲染，等同旧版）', () => {
    const counts = [0, 200, 180, 150];
    expect(computeScrollInitialRows(counts)).toBe(SCROLL_INITIAL_ROWS_DEFAULTS.maxRows);
  });

  test('平均行长恰在阈值（300）以内不收缩', () => {
    const counts = Array.from({ length: 30 }, () => 300);
    expect(computeScrollInitialRows(counts)).toBe(30);
  });

  test('空数据返回 maxRows（等同旧版固定值）', () => {
    expect(computeScrollInitialRows([])).toBe(30);
  });
});

describe('computeScrollInitialRows：导入书大段落场景（按预算收缩）', () => {
  test('2500 字大段落：初始只渲染标题行 + 预算内的 2 段（而非 30 行 × 2500 字压死首帧）', () => {
    // 行序列：标题行(0) + 60 段 × 2500 字。累计到第 2 段（5000 字）超出预算 3000
    // → 返回 3 行（标题行 + 2 段）
    const counts = chapterRowCounts(
      Array.from({ length: 60 }, () => ({ text: '字'.repeat(2500) })),
    );
    expect(computeScrollInitialRows(counts)).toBe(3);
  });

  test('单行超出预算时取 minRows 下限', () => {
    const counts = [0, 5000, 5000];
    expect(computeScrollInitialRows(counts, { charBudget: 1000 })).toBe(2);
  });

  test('预算可覆盖多行时按累计边界截断（渲染到恰好超出预算的行为止）', () => {
    // 行序列：标题行(0) + 段落各 900 字。累计到第 4 段为 3600 > 3000
    // → 返回 5 行（标题行 + 4 段，共 3600 字）
    const counts = chapterRowCounts(
      Array.from({ length: 60 }, () => ({ text: '字'.repeat(900) })),
    );
    expect(computeScrollInitialRows(counts)).toBe(5);
  });

  test('自定义选项生效（预算 / 上下限 / 阈值）', () => {
    const counts = Array.from({ length: 30 }, () => 500);
    // 平均 500 > 阈值 100 → 按预算 1200 累计：第 3 行超出 → 3 行
    expect(computeScrollInitialRows(counts, { longRowThreshold: 100, charBudget: 1200 })).toBe(3);
    // minRows 下限抬升
    expect(
      computeScrollInitialRows(counts, { longRowThreshold: 100, charBudget: 100, minRows: 5 }),
    ).toBe(5);
    // maxRows 收紧：预算充足（10000 > 全部行）时返回的正是收紧后的 maxRows
    expect(
      computeScrollInitialRows(counts, { longRowThreshold: 100, charBudget: 10000, maxRows: 10 }),
    ).toBe(10);
  });
});

describe('回归：5 万字无换行 txt → parseTxtBook → 滚动初始行数（Bug② 复现输入）', () => {
  test('无章节标记的超长纯文本：单章 20 段、每段 2500 字（结构锁定）', () => {
    const text = '山'.repeat(50000); // 无任何换行与章节标记
    const book = parseTxtBook('大部头.txt', text, 'user-reg-50000');

    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('全文');
    const segments = book.chapters[0].segments;
    expect(segments).toHaveLength(20); // 50000 / MAX_SEGMENT_CHARS(2500)
    for (const seg of segments) {
      expect(Array.from(seg.text).length).toBeLessThanOrEqual(2500);
    }
    expect(Array.from(segments[0].text).length).toBe(2500);
  });

  test('该结构代入初始行数计算：30 行旧值会压入 7.5 万字格，修复后仅渲染标题行 + 2 段', () => {
    const text = '山'.repeat(50000);
    const book = parseTxtBook('大部头.txt', text, 'user-reg-50000');
    const counts = chapterRowCounts(book.chapters[0].segments);

    // 旧行为：固定 30 行 → 30 × 2500 = 75000 字格同步挂载（Bug 根因量级）
    // 新行为：预算 3000 → 初始 3 行（标题行 + 2 段 = 5000 字），其余随滚动增量渲染
    expect(computeScrollInitialRows(counts)).toBe(3);
  });
});

describe('planHeadDrop：滑动窗口丢头（UI 精简后连续滚动可无限前进）', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `ch${i + 1}`);
  const MAX = 30;

  test('未超限（含恰好 = 上限的边界）不丢', () => {
    const chapters = ids(30);
    const plan = planHeadDrop(chapters, 'ch30', MAX);
    expect(plan.droppedChapterIds).toEqual([]);
    expect(plan.keptChapterIds).toEqual(chapters);
  });

  test('超限且当前章在保留区间内：丢弃头部 excess 章，长度收敛回上限', () => {
    const chapters = ids(31); // 追加 ch31 后超限 1
    const plan = planHeadDrop(chapters, 'ch31', MAX);
    expect(plan.droppedChapterIds).toEqual(['ch1']);
    expect(plan.keptChapterIds).toHaveLength(30);
    expect(plan.keptChapterIds[0]).toBe('ch2');
    expect(plan.keptChapterIds[plan.keptChapterIds.length - 1]).toBe('ch31');
  });

  test('连续前进多章后一次性收敛：超限 excess 按头部整段丢弃', () => {
    const chapters = ids(35); // 极端场景：序列膨胀到 35
    const plan = planHeadDrop(chapters, 'ch35', MAX);
    expect(plan.droppedChapterIds).toEqual(ids(5));
    expect(plan.keptChapterIds).toHaveLength(30);
    expect(plan.keptChapterIds[0]).toBe('ch6');
  });

  test('当前章落在将被丢弃的头部区间内（用户正在回看头部）→ 本轮不丢（宁晚勿扰）', () => {
    const chapters = ids(31);
    // 当前章 ch1 位于将被丢弃的头部区间 [ch1]
    expect(planHeadDrop(chapters, 'ch1', MAX).droppedChapterIds).toEqual([]);
    // 当前章未知（-1）同样保守不丢
    expect(planHeadDrop(chapters, '不存在', MAX).droppedChapterIds).toEqual([]);
    expect(planHeadDrop(chapters, null, MAX).droppedChapterIds).toEqual([]);
  });

  test('当前章恰在丢弃边界之上（activeIdx === excess）允许丢头（用户已向前进）', () => {
    const chapters = ids(32); // excess = 2，头部 [ch1, ch2]
    // 当前章 ch3 恰在边界之上 → 丢 ch1、ch2
    const plan = planHeadDrop(chapters, 'ch3', MAX);
    expect(plan.droppedChapterIds).toEqual(['ch1', 'ch2']);
    expect(plan.keptChapterIds[0]).toBe('ch3');
  });

  test('单章序列不丢、不死循环（丢头结果长度恰为上限）', () => {
    expect(planHeadDrop(['only'], 'only', MAX).droppedChapterIds).toEqual([]);
    // 反复对收敛结果再规划是幂等的（不会继续丢）
    const once = planHeadDrop(ids(31), 'ch31', MAX);
    const twice = planHeadDrop(once.keptChapterIds, 'ch31', MAX);
    expect(twice.droppedChapterIds).toEqual([]);
  });

  test('末章收敛：没有下一章时序列不再增长，丢头规划不再触发', () => {
    // 模拟末章：序列停留在上限 30，规划器不丢
    const chapters = ids(30);
    const plan = planHeadDrop(chapters, 'ch30', MAX);
    expect(plan.droppedChapterIds).toEqual([]);
  });
});

describe('源码结构断言：ReaderScreen 初始行数必须按预算计算', () => {
  const source = readSrc('screens/ReaderScreen.tsx');

  test('initialNumToRender 使用 computeScrollInitialRows 结果，而非固定 30', () => {
    expect(source).toMatch(/initialNumToRender=\{scrollInitialRows\}/);
    expect(source).not.toMatch(/initialNumToRender=\{30\}/);
  });

  test('已导入 computeScrollInitialRows 并按首章内容量计算', () => {
    expect(source).toMatch(
      /import \{[^}]*computeScrollInitialRows[^}]*\} from '@\/utils\/readerScroll';/,
    );
    expect(source).toMatch(/computeScrollInitialRows\(counts\)/);
  });
});

describe('isWithinPreloadWindow：距末尾不足预载窗口的统一口径', () => {
  const SCREENS = 2;

  test('内容不足一屏（道德经级短章）→ true（应追加下一章）', () => {
    // 内容 600px、视口 800px：无可滚动区间也必须判定为「距末尾不足窗口」
    expect(isWithinPreloadWindow(600, 800, 0, SCREENS)).toBe(true);
  });

  test('内容恰填满窗口（3 屏）→ false（停止级联追加，收敛）', () => {
    // content - view - offset = 2*view 恰好等于阈值 → 不追加
    expect(isWithinPreloadWindow(2400, 800, 0, SCREENS)).toBe(false);
    expect(isWithinPreloadWindow(2399, 800, 0, SCREENS)).toBe(true);
  });

  test('偏移推进后判定随之变化（滚动中的预加载口径不变）', () => {
    // 距末尾 = 3200 - 800 - 2000 = 400 < 1600 → true
    expect(isWithinPreloadWindow(3200, 800, 2000, SCREENS)).toBe(true);
    // 距末尾 = 5200 - 800 - 2000 = 2400 ≥ 1600 → false
    expect(isWithinPreloadWindow(5200, 800, 2000, SCREENS)).toBe(false);
  });

  test('视口 / 内容未量出（≤0）→ false（守卫，不误触发追加）', () => {
    expect(isWithinPreloadWindow(600, 0, 0, SCREENS)).toBe(false);
    expect(isWithinPreloadWindow(0, 800, 0, SCREENS)).toBe(false);
    expect(isWithinPreloadWindow(-1, 800, 0, SCREENS)).toBe(false);
  });
});
