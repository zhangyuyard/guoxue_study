/**
 * `pinyinLenCache.ts` 单测 —— 锁「⑫ 装配空窗」的根因。
 *
 * 被锁的缺陷（2026-10-09 真机）：章级「最长拼音长度」原本在渲染 memo 里**每次
 * `segmentsByChapter` 变更都遍历全部已载章**、且走**无结果缓存**的
 * `PinyinService.annotate` ⇒ 填充循环每追加一章即全链重算，单次同步块 9.2~38s，
 * 表现为换章/开书时正文区长时间空白（同脚本同判据：注音关闭 ⇒ 0/6 轮；
 * 注音开启 ⇒ 6 轮中 4 轮进入空窗，3 轮窗内恢复 12.0 / 16.5 / 3.2 s）。
 *
 * 判据口径：`computedSegments()` —— **注音调用次数**，不是耗时。
 * （耗时是墙钟，会被任何无关 JS 工作撑大；本仓已多次因此得出互相矛盾的结论。）
 */
import {
  chapterSegSignature,
  createChapterMaxPinyinLenStore,
  type ChapterAnnotateFn,
} from '@/reader/pinyinLenCache';
import type { PinyinAnnotation, PinyinMode, TextSegment } from '@/types';

function seg(id: string, text: string): TextSegment {
  // 只用到 id / text 两字段；其余按最小合法夹具补齐（夹具缺字段会让缺陷在 harness 隐身）
  return { id, chapterId: 'c1', order: 0, text } as TextSegment;
}

/** 假注音：每字一条注解，拼音长度 = 1 + (字在串中的序号 % 3) ⇒ 最长拼音可控 */
function makeAnnotate() {
  const calls: {
    text: string;
    mode: PinyinMode;
    salt: string;
    workId: string;
    bookId?: string;
  }[] = [];
  const fn: ChapterAnnotateFn = (text, mode, salt, opts) => {
    calls.push({ text, mode, salt, workId: opts.workId, bookId: opts.bookId });
    const chars = Array.from(text);
    const data: PinyinAnnotation[] = chars.map((ch, i) => ({
      char: ch,
      pinyin: 'a'.repeat(1 + (i % 3)),
      isPolyphone: false,
      isRare: false,
    }));
    return { success: true, data };
  };
  return { fn, calls };
}

const CH1: TextSegment[] = [seg('s1', '甲乙丙'), seg('s2', '丁戊')];
const CH1_SAME: TextSegment[] = [seg('s1', '甲乙丙'), seg('s2', '丁戊')];
const CH1_CHANGED: TextSegment[] = [seg('s1', '甲乙丙'), seg('s2', '丁戊己庚辛')];

describe('chapterSegSignature', () => {
  it('同内容不同数组 ⇒ 同签名（判据不能依赖对象引用）', () => {
    expect(chapterSegSignature(CH1)).toBe(chapterSegSignature(CH1_SAME));
  });

  it('段数变化 / 总长变化 / 首末段 id 变化 ⇒ 签名变化', () => {
    expect(chapterSegSignature(CH1)).not.toBe(chapterSegSignature(CH1_CHANGED));
    expect(chapterSegSignature(CH1)).not.toBe(chapterSegSignature([seg('s1', '甲乙丙')]));
    expect(chapterSegSignature(CH1)).not.toBe(
      chapterSegSignature([seg('x1', '甲乙丙'), seg('s2', '丁戊')]),
    );
    // 同总长、同段数、仅末段 id 变 ⇒ 也必须识别
    expect(chapterSegSignature(CH1)).not.toBe(
      chapterSegSignature([seg('s1', '甲乙丙'), seg('z9', '丁戊')]),
    );
  });

  it('空章 ⇒ 稳定签名且不抛', () => {
    expect(chapterSegSignature([])).toBe('0|0||');
  });
});

describe('createChapterMaxPinyinLenStore', () => {
  it('取值正确：章内最长拼音码点数', () => {
    const { fn } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    // '甲乙丙' ⇒ 长度 1,2,3；'丁戊' ⇒ 1,2 ⇒ 章内最大 3
    expect(store.of('c1', CH1, 'full', 'builtin')).toBe(3);
  });

  it('★ 必须把 workId/bookId/盐 一并透传给注音（否则与预热、渲染侧缓存键不同参 ⇒ 静默失去缓存）', () => {
    // 变异自证：把 `{ workId: cid, bookId }` 改成 `{ workId: cid }` ⇒ 本用例变红（实测）。
    const { fn, calls } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    store.of('c1', CH1, 'full', 'builtin');
    expect(calls.length).toBe(CH1.length);
    for (const c of calls) {
      expect(c.workId).toBe('c1');
      expect(c.bookId).toBe('bookA');
      expect(c.salt).toBe('builtin');
    }
  });

  it('★ 同章同内容重复取 ⇒ 注音调用 0 次（锁「填充循环重复追加旧章不再重算」）', () => {
    const { fn, calls } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    expect(store.of('c1', CH1, 'full', 'builtin')).toBe(3);
    const first = store.computedSegments();
    expect(first).toBe(CH1.length);

    const before = calls.length;
    expect(store.of('c1', CH1_SAME, 'full', 'builtin')).toBe(3);
    expect(store.of('c1', CH1_SAME, 'full', 'builtin')).toBe(3);
    expect(calls.length).toBe(before);
    expect(store.computedSegments()).toBe(first);
  });

  it('章内容变化 ⇒ 重算并返回新值', () => {
    const { fn } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    expect(store.of('c1', CH1, 'full', 'builtin')).toBe(3);
    // '丁戊己庚辛' ⇒ 长度 1,2,3,1,2 ⇒ 仍为 3；改判「是否重算」用调用计数
    const before = store.computedSegments();
    store.of('c1', CH1_CHANGED, 'full', 'builtin');
    expect(store.computedSegments()).toBe(before + CH1_CHANGED.length);
  });

  it('不同章互不干扰（各自算一次，互不命中）', () => {
    const { fn } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    store.of('c1', CH1, 'full', 'builtin');
    expect(store.computedSegments()).toBe(CH1.length);
    store.of('c2', CH1, 'full', 'builtin');
    expect(store.computedSegments()).toBe(CH1.length * 2);
  });

  it('注音模式变化 / 多音字来源盐变化 ⇒ 均失效重算', () => {
    const { fn } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    store.of('c1', CH1, 'full', 'builtin');
    const base = store.computedSegments();
    store.of('c1', CH1, 'rare', 'builtin');
    expect(store.computedSegments()).toBe(base + CH1.length);
    store.of('c1', CH1, 'rare', 'dict:d1');
    expect(store.computedSegments()).toBe(base + CH1.length * 2);
  });

  it('★ 跨书隔离：一 store 一书 ⇒ 两个 store 必须各算一遍（锁「缓存不得模块级共享」）', () => {
    const { fn } = makeAnnotate();
    const a = createChapterMaxPinyinLenStore(fn, 'bookA');
    const b = createChapterMaxPinyinLenStore(fn, 'bookB');
    a.of('c1', CH1, 'full', 'builtin');
    expect(a.computedSegments()).toBe(CH1.length);
    // b 是新书 ⇒ 不得因 a 已算过而命中（若缓存被提到模块级共享，此断言即为红）
    b.of('c1', CH1, 'full', 'builtin');
    expect(b.computedSegments()).toBe(CH1.length);
    // 且互不污染：再各取一次，两边都应命中、计数不变
    a.of('c1', CH1, 'full', 'builtin');
    b.of('c1', CH1, 'full', 'builtin');
    expect(a.computedSegments()).toBe(CH1.length);
    expect(b.computedSegments()).toBe(CH1.length);
  });

  it('空章 ⇒ 0 且不调用注音', () => {
    const { fn, calls } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    expect(store.of('c1', [], 'full', 'builtin')).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('注音失败 ⇒ 该段不贡献（不抛、结果仍可用）', () => {
    const fn: ChapterAnnotateFn = (text) => {
      if (text === '丁戊') {
        return { success: false, error: 'boom' };
      }
      return {
        success: true,
        data: Array.from(text).map((ch) => ({
          char: ch,
          pinyin: 'ài',
          isPolyphone: false,
          isRare: false,
        })),
      };
    };
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    expect(store.of('c1', CH1, 'full', 'builtin')).toBe(2);
  });

  it('clear() 后重新计算（诊断/测试用）', () => {
    const { fn } = makeAnnotate();
    const store = createChapterMaxPinyinLenStore(fn, 'bookA');
    store.of('c1', CH1, 'full', 'builtin');
    store.clear();
    expect(store.computedSegments()).toBe(0);
    store.of('c1', CH1, 'full', 'builtin');
    expect(store.computedSegments()).toBe(CH1.length);
  });
});
