/**
 * maxPinyinLength 纯函数单测（拼音字号全章统一的输入，架构 §7.2 观感统一）。
 * 断言「变异下会红」：乱序输入锁「取最大」语义，空结果锁 0 兜底。
 */
import { maxPinyinLength } from '../services/PinyinService';
import type { PinyinAnnotation } from '../types';

function ann(pinyin: string): PinyinAnnotation {
  return {
    char: '字',
    pinyin,
    isRare: false,
    isPolyphone: false,
  } as PinyinAnnotation;
}

describe('maxPinyinLength', () => {
  it('空数组返回 0（调用方据此走缺省兜底）', () => {
    expect(maxPinyinLength([])).toBe(0);
  });

  it('全空拼音返回 0', () => {
    expect(maxPinyinLength([ann(''), ann('')])).toBe(0);
  });

  it('乱序取最大：最长拼音不在首位也不在末位', () => {
    // 若变异为「取首个」→ 3 红；「取末个」→ 2 红
    expect(maxPinyinLength([ann('yǒu'), ann('zhěng'), ann('gé')])).toBe(5);
    expect(maxPinyinLength([ann('gé'), ann('yǒu'), ann('zhěng')])).toBe(5);
    expect(maxPinyinLength([ann('zhěng'), ann('gé'), ann('yǒu')])).toBe(5);
  });

  it('声调字符按码点计：zhuǎng = 6（非字节/非 UTF-16 代理对口径）', () => {
    expect(maxPinyinLength([ann('gé'), ann('zhuǎng')])).toBe(6);
  });

  it('空拼音与长拼音混排不受空项干扰', () => {
    expect(maxPinyinLength([ann(''), ann('chén'), ann('')])).toBe(4);
  });
});
