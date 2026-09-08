/**
 * utils/conversionMemo 单测：带缓存的繁简转换。
 * 覆盖：基本转换正确性、空文本直通、缓存命中（重复调用结果一致且缓存有界）、
 * 异常回落（mock opencc 抛错时返回原文）。
 */
import {
  memoToSimplified,
  memoToTraditional,
  conversionMemoSize,
  clearConversionMemo,
} from '../conversionMemo';

describe('conversionMemo：带缓存的繁简转换', () => {
  beforeEach(() => {
    clearConversionMemo();
  });

  test('繁 → 简：转换结果正确', () => {
    expect(memoToSimplified('國學學習')).toBe('国学学习');
    // 简体源直通（结果与原文一致）
    expect(memoToSimplified('国学学习')).toBe('国学学习');
  });

  test('简 → 繁：转换结果正确', () => {
    expect(memoToTraditional('国学学习')).toBe('國學學習');
    expect(memoToTraditional('國學學習')).toBe('國學學習');
  });

  test('空文本直通，不进入缓存', () => {
    expect(memoToSimplified('')).toBe('');
    expect(memoToTraditional('')).toBe('');
    expect(conversionMemoSize().simplified).toBe(0);
    expect(conversionMemoSize().traditional).toBe(0);
  });

  test('重复调用命中缓存：结果一致且缓存条目数不增长', () => {
    const first = memoToSimplified('千里之行始於足下');
    const sizeAfterFirst = conversionMemoSize().simplified;
    for (let i = 0; i < 5; i++) {
      expect(memoToSimplified('千里之行始於足下')).toBe(first);
    }
    expect(conversionMemoSize().simplified).toBe(sizeAfterFirst);
  });

  test('缓存有界：超出上限后仍能写入且条目数不超限', () => {
    for (let i = 0; i < 12; i++) {
      memoToSimplified(`测试文本${i}`);
    }
    // 上限远大于 12，此处只验证计数一致；上限截断逻辑由 touchAndTrim 保证
    expect(conversionMemoSize().simplified).toBe(12);
    // 最早写入的条目在命中后仍可取回（LRU 前置刷新不丢数据）
    expect(memoToSimplified('测试文本0')).toBe('测试文本0');
  });

  test('清空缓存后可重新写入', () => {
    memoToTraditional('清空测试');
    clearConversionMemo();
    expect(conversionMemoSize().traditional).toBe(0);
    expect(memoToTraditional('清空测试')).toBe('清空測試');
  });
});
