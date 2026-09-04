/**
 * 逐句分组纯函数测试（P1-07 提示粒度：逐句揭示）
 * 锁定句末标点切分口径：引号内句末标点不切断、收口引号归属前句、
 * 空组隐藏、末尾未闭合兜底归最后一组。
 * 测试文本中「@」字符代表待填写空格。
 */
import { buildSentenceGroups, markSentenceEnds } from '@/utils/sentenceSplit';

/** 便捷构造字格：text 逐码点展开，「@」标记 isBlank（@ 本身作为占位字） */
function makeChars(text: string): { index: number; char: string; isBlank: boolean }[] {
  return Array.from(text).map((char, i) => ({
    index: i,
    char,
    isBlank: char === '@',
  }));
}

describe('markSentenceEnds：句末标记（P1-07）', () => {
  test('句末标点（。！？；）在引号外切断', () => {
    const ends = markSentenceEnds('学而时习之。不亦说乎？有朋自远方来！');
    expect(ends.filter(Boolean).length).toBe(3);
    expect(ends[5]).toBe(true); // 。
    expect(ends[10]).toBe(true); // ？
    expect(ends[ends.length - 1]).toBe(true); // ！
  });

  test('引号内的句末标点不切断，收口引号处整句结束（语料典型形态）', () => {
    const text = '孟子见梁惠王。王曰：“叟！不远千里而来，亦将有以利吾国乎？”孟子对曰：“王！何必曰利？”';
    const chars = Array.from(text);
    const ends = markSentenceEnds(text);
    const breakIdx: number[] = [];
    ends.forEach((e, i) => {
      if (e) {
        breakIdx.push(i);
      }
    });
    expect(breakIdx.length).toBe(3);
    // 每个断点都是收口引号或句号
    for (const i of breakIdx) {
      expect(['”', '。']).toContain(chars[i]);
    }
    // 引号内的 ！ 与 ？ 不产生断点
    const exclaimInside = chars.indexOf('！');
    expect(ends[exclaimInside]).toBe(false);
    const questionInside = chars.indexOf('？');
    expect(ends[questionInside]).toBe(false);
  });

  test('顿号按口径切断', () => {
    const ends = markSentenceEnds('齐宣、晋文之事。');
    expect(ends[2]).toBe(true); // 、
    expect(ends[7]).toBe(true); // 。
  });

  test('收口引号前一字符非句末标点时不切断（如 “仁”政。）', () => {
    const ends = markSentenceEnds('“仁”政。');
    expect(ends[2]).toBe(false); // ” 前是 仁，不切断
    expect(ends[3]).toBe(false); // 政
    expect(ends[4]).toBe(true); // 。
  });

  test('西文句末标点（. ! ? ,）同样切断', () => {
    const ends = markSentenceEnds('Hello world. Hi! Bye, ok?');
    expect(ends.filter(Boolean).length).toBe(4);
  });

  test('《》书名号不参与引号计数', () => {
    const text = '《诗》云：“邦有道。”';
    const chars = Array.from(text);
    const ends = markSentenceEnds(text);
    // 《 与 》 不产生断点
    expect(ends[0]).toBe(false);
    expect(ends[2]).toBe(false);
    // 断点只有末尾收口引号
    expect(ends.filter(Boolean).length).toBe(1);
    expect(chars[ends.indexOf(true)]).toBe('”');
  });

  test('返回数组长度与码点数一致（含增补平面字符）', () => {
    const text = '𠀀曰：巧言令色。';
    const ends = markSentenceEnds(text);
    expect(ends.length).toBe(Array.from(text).length);
  });
});

describe('buildSentenceGroups：空格句组（P1-07）', () => {
  test('无空格文本不产生句组（空组隐藏）', () => {
    const groups = buildSentenceGroups(makeChars('子曰：学而时习之。人不知而不愠。'));
    expect(groups).toEqual([]);
  });

  test('引号整体为一句，句内空格归同组', () => {
    const groups = buildSentenceGroups(makeChars('王曰：“@乎？”'));
    expect(groups).toEqual([[4]]); // 唯一空格在收口引号结尾的句组内
  });

  test('多句多空格分组且索引保持全局顺序', () => {
    const groups = buildSentenceGroups(makeChars('@。@。'));
    expect(groups).toEqual([[0], [2]]);
  });

  test('末尾无句末标点时剩余空格归最后一组', () => {
    const groups = buildSentenceGroups(makeChars('子曰：@'));
    expect(groups).toEqual([[3]]);
  });

  test('引号内多个空格不因句末标点切断', () => {
    const groups = buildSentenceGroups(makeChars('“@！@？”'));
    expect(groups).toEqual([[1, 3]]);
  });

  test('跨句空格严格分组的索引不重叠、并集完整', () => {
    const text = '@曰：“@乎？”@也。';
    const groups = buildSentenceGroups(makeChars(text));
    // 第一组：句组跨 "曰：" 与引号内文本，在收口引号处结束 → 含空格 0、4
    // 第二组：句组 "@也。" → 含空格 8
    expect(groups.length).toBe(2);
    const flat = groups.flat();
    expect(flat).toEqual([0, 4, 8]);
    expect(new Set(flat).size).toBe(flat.length);
  });
});
