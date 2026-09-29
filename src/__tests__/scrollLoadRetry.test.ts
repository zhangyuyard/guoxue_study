/**
 * 滚动邻章装载「失败可重试」接线断言（源码文本即断言）。
 *
 * 回归背景（2026-09-29）：
 * 旧 fillFailedRef 是「永久黑名单」——邻章装载失败后 add(id) 且永不删除，
 * fillNeighbors 里 `!fillFailedRef.current.has(id)` 直接跳过该章 ⇒ 用户卡死在
 * 「继续滑动加载下一章」占位，零 UI 反馈、零重试入口（窗口层 windowFail 其实
 * 已清 inflight 允许重试，但上层黑名单把它拦死 ⇒ 两层矛盾）。
 *
 * 修复：失败集合从 ref 黑名单改为 state（驱动占位文案），去掉 has() 跳过，
 * 重试去重改由 windowBegin 闸门承担；占位在失败时显示「加载失败，滑动重试」。
 * 「黑名单跳过」与「失败文案」都不报错不红灯，只能靠接线断言锁住。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');
const SCROLL_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/ScrollMode.tsx');

describe('滚动邻章装载失败可重试：接线断言', () => {
  const readerSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
  const scrollSrc = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));

  it('黑名单跳过逻辑已移除（fillFailedRef 及 fillNeighbors 内的 has() 跳过判据不残留）', () => {
    // 旧根因：fillNeighbors 用 fillFailedRef.current.has(id) 跳过失败章 ⇒ 永久卡死。
    // 修复后：① ref 本身消失；② fillNeighbors 内「取 sibling 后 && !失败 跳过」的判据消失
    //   （改为无条件取 sibling，重试去重由 windowBegin 闸门承担）。
    //   ⚠ loadError 的 useMemo 里仍有 fillFailed.has(...) —— 那是「失败态展示」判据，
    //   合法保留，不能误删。
    expect(countOf(readerSrc, 'fillFailedRef')).toBe(0);
    expect(countOf(readerSrc, 'fillFailed.current.has')).toBe(0);
    // fillNeighbors 内取 sibling 后不再跟黑名单跳过（旧：`s.data?.next && !fillFailedRef...`）
    expect(countOf(readerSrc, "s.data?.next && !fillFailed")).toBe(0);
    expect(countOf(readerSrc, "s.data?.prev && !fillFailed")).toBe(0);
    // 新：取 sibling 后直接 push（无跳过）。此判断出现 2 次：
    // fillNeighbors（取目标装载）与 loadError useMemo（取失败态展示）各 1 次。
    expect(countOf(readerSrc, "if (s.success && s.data?.next) {")).toBe(2);
    expect(countOf(readerSrc, "if (s.success && s.data?.prev) {")).toBe(2);
  });

  it('失败集合改为 state 且驱动 loadError（成功删 / 失败增）', () => {
    // 失败态 state 存在（用于占位文案，不阻断重试）
    expect(countOf(readerSrc, 'setFillFailed')).toBeGreaterThanOrEqual(2);
    expect(countOf(readerSrc, 'setFillFailed((prev)')).toBe(2);
  });

  it('占位在失败时显示「加载失败，滑动重试」（next/prev 各 1 处）', () => {
    expect(countOf(scrollSrc, "loadError?.next ? '加载失败，滑动重试'")).toBe(1);
    expect(countOf(scrollSrc, "loadError?.prev ? '加载失败，滑动重试'")).toBe(1);
  });

  it('loadError 接线：ReaderScreen 计算并传入 ScrollMode', () => {
    expect(countOf(readerSrc, 'const loadError = useMemo(')).toBe(1);
    expect(countOf(readerSrc, 'loadError: loadError,')).toBe(1);
    // ScrollMode 侧解构并声明 prop 类型
    expect(countOf(scrollSrc, 'loadError?: { next?: boolean; prev?: boolean };')).toBe(1);
  });

  it('阴性对照：旧文案仍保留正常态（继续滑动 / 加载中），工具有效', () => {
    // 同范围正对照：失败文案在场 ⇒ 计数工具本身有效（防「grep 打偏 = 假 0」）
    expect(countOf(scrollSrc, '加载失败，滑动重试')).toBeGreaterThan(0);
    // 正常态文案仍在（失败时才切换成失败文案）
    expect(countOf(scrollSrc, '继续滑动以加载下一章…')).toBe(1);
    expect(countOf(scrollSrc, '加载中…')).toBe(1);
  });
});
