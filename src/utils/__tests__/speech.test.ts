/**
 * 朗读纯逻辑测试（P2-02 speech utils）
 * 覆盖：语速夹取 / 语速步进（0.25 步进与边界）/ 朗读文本清洗
 * （@@CH@@ 标记去除、空白折叠）。
 */
import {
  clampSpeechRate,
  cleanSpeechText,
  stepSpeechRate,
} from '@/utils/speech';

describe('clampSpeechRate：语速夹取', () => {
  test('合法值原样保留', () => {
    expect(clampSpeechRate(1.0)).toBe(1.0);
    expect(clampSpeechRate(0.5)).toBe(0.5);
    expect(clampSpeechRate(2.0)).toBe(2.0);
    expect(clampSpeechRate(1.25)).toBe(1.25);
  });

  test('越界值夹取到 [0.5, 2.0]', () => {
    expect(clampSpeechRate(0.1)).toBe(0.5);
    expect(clampSpeechRate(3)).toBe(2.0);
    expect(clampSpeechRate(-1)).toBe(0.5);
  });

  test('非有限值回退默认 1.0', () => {
    expect(clampSpeechRate(Number.NaN)).toBe(1.0);
    expect(clampSpeechRate(Number.POSITIVE_INFINITY)).toBe(1.0);
  });
});

describe('stepSpeechRate：语速步进（0.25）', () => {
  test('正向步进', () => {
    expect(stepSpeechRate(1.0, 1)).toBe(1.25);
    expect(stepSpeechRate(1.75, 1)).toBe(2.0);
  });

  test('负向步进', () => {
    expect(stepSpeechRate(1.0, -1)).toBe(0.75);
    expect(stepSpeechRate(0.75, -1)).toBe(0.5);
  });

  test('边界夹取：上限 2.0 / 下限 0.5', () => {
    expect(stepSpeechRate(2.0, 1)).toBe(2.0);
    expect(stepSpeechRate(1.9, 1)).toBe(2.0);
    expect(stepSpeechRate(0.5, -1)).toBe(0.5);
    expect(stepSpeechRate(0.6, -1)).toBe(0.5);
  });

  test('非对齐值直接叠加步进（容错）', () => {
    expect(stepSpeechRate(1.6, 1)).toBe(1.85);
  });
});

describe('cleanSpeechText：朗读文本清洗', () => {
  test('去除 @@CH@@ 章节标记', () => {
    expect(cleanSpeechText('@@CH@@第一章 起点')).toBe('第一章 起点');
    expect(cleanSpeechText('前文@@CH@@后文')).toBe('前文后文');
  });

  test('折叠换行与连续空白为单空格，去除首尾空白', () => {
    expect(cleanSpeechText('  道可道，\n\n非常道。  ')).toBe('道可道， 非常道。');
    expect(cleanSpeechText('名可名\u3000\u3000非常名')).toBe('名可名 非常名');
  });

  test('纯空白 / 纯标记文本清洗后为空串', () => {
    expect(cleanSpeechText('   \n\t ')).toBe('');
    expect(cleanSpeechText('@@CH@@@@CH@@')).toBe('');
  });

  test('正常文本原样返回（无副作用）', () => {
    expect(cleanSpeechText('关关雎鸠，在河之洲。')).toBe('关关雎鸠，在河之洲。');
  });
});
