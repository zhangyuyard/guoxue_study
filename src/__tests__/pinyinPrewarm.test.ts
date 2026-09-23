/**
 * 预拼（prewarmPinyinCache）单测（R2b3）。
 * 判据「变异下会红」：预热后缓存条目必须增加（未命中才计数的口径由
 * size 差值锁定）；重复预热不得再增（命中不膨胀）；off 模式不进缓存。
 */
import {
  clearPinyinCache,
  pinyinCacheSize,
  prewarmPinyinCache,
} from '../utils/pinyin';

const SALT = 'builtin';

describe('prewarmPinyinCache', () => {
  beforeEach(() => {
    clearPinyinCache();
  });

  it('空文本列表：返回 0，缓存不增', async () => {
    const size0 = pinyinCacheSize();
    const n = await prewarmPinyinCache([], 'full', SALT, { workId: 'w1', bookId: 'b1' });
    expect(n).toBe(0);
    expect(pinyinCacheSize()).toBe(size0);
  });

  it('预热多段：返回计算段数，缓存条目对应增加', async () => {
    const size0 = pinyinCacheSize();
    const n = await prewarmPinyinCache(
      ['学而时习之', '有朋自远方来'],
      'full',
      SALT,
      { workId: 'w1', bookId: 'b1' },
    );
    expect(n).toBe(2);
    expect(pinyinCacheSize() - size0).toBe(2);
  });

  it('重复预热同参：命中缓存，条目不再增加（不膨胀）', async () => {
    const args = [['不亦说乎'], ['人不知而不愠']] as const;
    await prewarmPinyinCache([...args[0], ...args[1]], 'full', SALT, { workId: 'w1', bookId: 'b1' });
    const size1 = pinyinCacheSize();
    const n2 = await prewarmPinyinCache([...args[0], ...args[1]], 'full', SALT, { workId: 'w1', bookId: 'b1' });
    // 第二次全部命中 ⇒ 返回 0，size 不变
    expect(n2).toBe(0);
    expect(pinyinCacheSize()).toBe(size1);
  });

  it('off 模式：不进缓存', async () => {
    const size0 = pinyinCacheSize();
    const n = await prewarmPinyinCache(['子曰'], 'off', SALT, { workId: 'w1', bookId: 'b1' });
    expect(n).toBe(0);
    expect(pinyinCacheSize()).toBe(size0);
  });

  it('缓存盐不同视为不同条目（字典域切换后预热不互相污染）', async () => {
    const size0 = pinyinCacheSize();
    await prewarmPinyinCache(['子曰'], 'full', 'builtin', { workId: 'w1', bookId: 'b1' });
    await prewarmPinyinCache(['子曰'], 'full', 'dict:d9', { workId: 'w1', bookId: 'b1' });
    expect(pinyinCacheSize() - size0).toBe(2);
  });
});
