/**
 * canon v3 用例级语境锚定匹配工具的单元测试。
 * 覆盖：汉字序列归一化（繁简/标点/空白）、例句跨度定位、
 * 候选选择（无 context 放行 / 有 context 锚定 / 全 miss 返回 null）、
 * 缓存语义与多候选最长用例共存。
 */
import {
  buildHanSequence,
  findContextSpan,
  pickContextHit,
  MIN_CONTEXT_HAN,
} from '@/utils/canonContext';

describe('buildHanSequence 汉字序列归一化', () => {
  test('繁体→简体、去标点空白，保留原始码点下标映射', () => {
    // 原文：「不亦說乎！」→ 归一化 [不,亦,说,乎]
    const info = buildHanSequence('不亦說乎！');
    expect(info.chars).toEqual(['不', '亦', '说', '乎']);
    expect(info.origIdx).toEqual([0, 1, 2, 3]);
  });

  test('标点穿插不影响映射：下标跳过非汉字字符', () => {
    const info = buildHanSequence('学而时习之，不亦说乎');
    // 「，」位于码点 5，其后汉字下标从 6 继续
    expect(info.chars).toEqual(['学', '而', '时', '习', '之', '不', '亦', '说', '乎']);
    expect(info.origIdx).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
  });
});

describe('findContextSpan 例句跨度定位', () => {
  test('例句命中：返回覆盖借字的原始码点跨度', () => {
    const info = buildHanSequence('子曰：学而时习之，不亦说乎！');
    const span = findContextSpan(info, '学而时习之，不亦说乎');
    expect(span).not.toBeNull();
    // 码点布局：子0 曰1 ：2 学3 而4 时5 习6 之7 ，8 不9 亦10 说11 乎12 ！13
    // 跨度应覆盖「学」(3) 到「乎」(12)
    expect(span![0]).toBe(3);
    expect(span![1]).toBe(12);
  });

  test('异文不命中（宁缺毋滥）：例句与正文文本对不上返回 null', () => {
    const info = buildHanSequence('成事不说，遂事不谏');
    expect(findContextSpan(info, '学而时习之，不亦说乎')).toBeNull();
  });

  test('例句过短（< 3 汉字）不参与匹配', () => {
    const info = buildHanSequence('不亦说乎');
    expect(findContextSpan(info, '说乎')).toBeNull();
    expect(MIN_CONTEXT_HAN).toBe(3);
  });
});

describe('pickContextHit 候选选择', () => {
  const seq = buildHanSequence('子曰：学而时习之，不亦说乎！');

  test('候选行无 context：跳过（无用例级证据，宁缺毋滥）——v3.1 行为', () => {
    // 「其→箕」人工种子教训：无例句的字级断言会让全书每个高频虚词都被误标
    expect(pickContextHit([{ original: '悦' }], 9, seq, new Map())).toBeNull();
  });

  test('无 context 高优先行被跳过后，带 context 的低优先行仍可命中', () => {
    const noCtxRow = { original: '墟', tier: 'book' };
    const ctxRow = { original: '悦', context: '学而时习之，不亦说乎', tier: 'chapter' };
    // 「说」在码点 11：无例句行跳过 → 例句行命中
    const hit = pickContextHit([noCtxRow, ctxRow], 11, seq, new Map());
    expect(hit).toBe(ctxRow);
  });

  test('有 context 且字符在跨度内：命中该行', () => {
    const cand = { original: '悦', context: '学而时习之，不亦说乎' };
    // 「说」在码点 11（不亦说乎的 说）
    const hit = pickContextHit([cand], 11, seq, new Map());
    expect(hit).toBe(cand);
  });

  test('有 context 但字符不在跨度内：继续下一候选，全 miss 返回 null', () => {
    const cand = { original: '悦', context: '学而时习之，不亦说乎' };
    // 「曰」在码点 2，不在例句跨度内
    expect(pickContextHit([cand], 2, seq, new Map())).toBeNull();
  });

  test('多候选共存：例句未命中的高优先行让位给命中的低优先行', () => {
    const chapterRow = { original: '悦', context: '不亦说乎', tier: 'chapter' };
    const bookRow = { original: '阅', context: '学而时习之', tier: 'book' };
    // 「时」在码点 5：不在「不亦说乎」(9-12) 内 → 章级行 miss，书级行命中
    const hit = pickContextHit([chapterRow, bookRow], 5, seq, new Map());
    expect(hit).toBe(bookRow);
  });

  test('跨度缓存：同一例句只计算一次', () => {
    const cache = new Map<string, [number, number] | null>();
    const cand = { original: '悦', context: '学而时习之，不亦说乎' };
    pickContextHit([cand], 11, seq, cache);
    expect(cache.size).toBe(1);
    pickContextHit([cand], 11, seq, cache);
    expect(cache.size).toBe(1);
  });
});
