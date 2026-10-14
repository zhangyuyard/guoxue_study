/**
 * 目录（TOC）纯逻辑单测（2026-10-08）。
 *
 * 背景：阅读页顶栏「点章节名 → 目录弹层 → 点章名跳章」为新增功能。可判定的
 * 部分下沉到纯 `.ts`（`reader/toc.ts`）——jest 未配 react-native preset ⇒
 * 单测不能 import `.tsx`（铁律 67③），弹层组件（ChapterTocSheet.tsx）只做渲染，
 * 接线由 `readerGestureContract.test.ts` 的源码文本断言守。
 *
 * 变异判据（2026-10-08 我实测；红数 = 失败**用例**数，非断言数）：
 * - M1 `TOC_ROW_H` 改 53 ⇒ **1 红**：`TOC_ROW_H 常量契约`。
 * - M2 `tocIndexOf` 删掉空 chapterId 兜底 ⇒ **1 红**（仅当列表内存在 id==='' 的
 *   条目时才有判别点，故专门写了「病态输入」用例）。★ 未加该用例时实测
 *   **0 红** —— 该分支当时是**无法判别的假判据**（铁律 24），补用例后才立住。
 * - M3 `tocInitialIndex` 未命中分支改 `return i >= 0 ? i : 0;` ⇒ **2 红**：
 *   「当前章不在列表内 ⇒ undefined」「空目录 ⇒ undefined」（把「不知道你在哪」
 *   变成「你被送到第一章」，是本文件唯一的语义判别点）。
 */
import type { Chapter } from '@/types';
import { TOC_ROW_H, buildTocItems, tocIndexOf, tocInitialIndex } from '@/reader/toc';

/** 造章：segments 空（目录只用 id/title/order，与「内置书目录元数据」同态） */
function ch(id: string, title: string, order: number): Chapter {
  return { id, bookId: 'b1', title, order, segments: [] };
}

const BOOK = [ch('b1-c1', '学而第一', 1), ch('b1-c2', '为政第二', 2), ch('b1-c3', '八佾第三', 3)];

describe('TOC_ROW_H 常量契约', () => {
  it('行高 52dp（渲染高度与 getItemLayout 同源，改动须同步弹层与用例）', () => {
    expect(TOC_ROW_H).toBe(52);
    // 行高必须是正整数：0/负数会让「第 N 项」与「第 N+1 项」落在同一 y 上
    expect(Number.isInteger(TOC_ROW_H)).toBe(true);
    expect(TOC_ROW_H).toBeGreaterThan(0);
  });
});

describe('buildTocItems', () => {
  it('按书序映射 id/title/index（index 从 0 起，与 initialScrollIndex 同基准）', () => {
    const items = buildTocItems(BOOK);
    expect(items).toEqual([
      { id: 'b1-c1', title: '学而第一', index: 0 },
      { id: 'b1-c2', title: '为政第二', index: 1 },
      { id: 'b1-c3', title: '八佾第三', index: 2 },
    ]);
  });

  it('标题缺失 ⇒ 空串（不猜「第 N 章」占位，避免与真实章名混淆）', () => {
    const items = buildTocItems([{ ...ch('b1-c9', '', 9), title: undefined as unknown as string }]);
    expect(items[0].title).toBe('');
  });

  it('空章列表 ⇒ 空目录（不抛错）', () => {
    expect(buildTocItems([])).toEqual([]);
  });
});

describe('tocIndexOf', () => {
  const items = buildTocItems(BOOK);

  it('命中 ⇒ 0 起下标', () => {
    expect(tocIndexOf(items, 'b1-c2')).toBe(1);
  });

  it('不在列表内（换书 / 章被删）⇒ -1', () => {
    expect(tocIndexOf(items, 'other-c1')).toBe(-1);
    expect(tocIndexOf(items, '')).toBe(-1);
  });

  it('病态输入：列表内存在 id 为空串的条目时，空 chapterId 仍不得命中', () => {
    // ★ 本用例是「空 chapterId 兜底」分支的**唯一判别点**：只有列表里真的存在
    //   id==='' 的条目，删掉兜底才会表现为「空 chapterId 命中第 0 项」。
    //   实测：删掉 `if (!chapterId) return -1;` ⇒ 本用例红（不加本用例则 0 红，
    //   该守卫就成了无法判别的假判据，见铁律 24）。
    //   可达性：目录数据来自书体（用户书解析结果），畸形条目会让「无 chapterId
    //   的阅读页」（activeChapterId=''）打开目录即被送到那一章。
    const evil = buildTocItems([{ ...ch('', '', 1) }, ch('b1-c2', '为政第二', 2)]);
    expect(evil[0].id).toBe('');
    expect(tocIndexOf(evil, '')).toBe(-1);
  });
});

describe('tocInitialIndex（initialScrollIndex 取值）', () => {
  const items = buildTocItems(BOOK);

  it('当前章在场 ⇒ 返回其下标（打开目录即停到当前章）', () => {
    expect(tocInitialIndex(items, 'b1-c3')).toBe(2);
  });

  it('★ 当前章不在列表内 ⇒ undefined，不得退化成 0', () => {
    // 语义：异常态下「不定位」优于「强行送到第一章」——后者把「我不知道你在哪」
    // 变成「你被送到第一章了」，用户会在毫无预期处丢位置。
    expect(tocInitialIndex(items, 'other-c1')).toBeUndefined();
    // 否定对照（变异自证）：0 是错误答案，必须显式排除
    expect(tocInitialIndex(items, 'other-c1')).not.toBe(0);
  });

  it('空目录 ⇒ undefined（不定位）', () => {
    expect(tocInitialIndex([], 'b1-c1')).toBeUndefined();
  });
});
