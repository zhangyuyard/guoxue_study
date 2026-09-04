/**
 * 阅读纸张（阅读背景换肤）配色单测
 * 锁定 getPaperColors 与 PAPER_OPTIONS，避免回归导致阅读器换肤失效。
 */
import { getColors, getPaperColors, PAPER_OPTIONS, PAPER_THEMES } from '@/theme';
import type { PaperMode } from '@/types';

const PAPERS: PaperMode[] = ['default', 'green', 'sepia', 'dark', 'cyan'];

describe('PAPER_OPTIONS', () => {
  test('提供 5 套纸张且 key 与 PAPER_THEMES 一一对应', () => {
    expect(PAPER_OPTIONS).toHaveLength(5);
    for (const opt of PAPER_OPTIONS) {
      expect(PAPER_THEMES[opt.key]).toBeDefined();
    }
  });
});

describe('getPaperColors', () => {
  test('每套纸张返回完整色板（背景/正文/主色/边框等）', () => {
    for (const p of PAPERS) {
      const c = getPaperColors(p);
      expect(c.background).toBeTruthy();
      expect(c.text).toBeTruthy();
      expect(c.primary).toBeTruthy();
      expect(c.border).toBeTruthy();
      expect(c.overlay).toBeTruthy();
    }
  });

  test('夜间纸张背景为深色，区别于默认白', () => {
    expect(getPaperColors('dark').background).not.toBe(getPaperColors('default').background);
    expect(getPaperColors('dark').background).toMatch(/^#1/);
  });

  test('未知纸张回退到默认白', () => {
    // @ts-expect-error 故意传入非法值验证回退
    expect(getPaperColors('unknown').background).toBe(getPaperColors('default').background);
  });
});

describe('getColors（全局暗色开关，保持独立）', () => {
  test('light / dark 与纸张体系解耦，仍按原逻辑返回', () => {
    expect(getColors('light').background).toBe('#FFFFFF');
    expect(getColors('dark').background).toBe('#1A1A1A');
  });
});
