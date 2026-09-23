/**
 * R2d-1 划线构造纯函数测试。
 *
 * 判据设计（变异下会红）：
 * - M1 变异 endOffset 用 text.length（UTF-16 单位）→ 含代理对用例红
 *   （'😀' 码点 1 个，UTF-16 单位 2 ⇒ 码点口径断言 1、单位口径断言 2）；
 * - M2 变异 startOffset 为 1 → 首偏移断言红；
 * - id 唯一性由 Date.now()+随机后缀，不锁字面（锁会漂），只锁前缀与生成性。
 */
import { buildSegmentHighlight } from '@/reader/highlightFactory';

describe('buildSegmentHighlight（R2d 划线构造）', () => {
  const NOW = '2026-09-23T08:00:00.000Z';

  test('整段区间 [0, 码点长)：普通中文段', () => {
    const h = buildSegmentHighlight('bk1', 'ch1', 'seg1', '学而时习之', 'yellow', NOW);
    expect(h.startOffset).toBe(0);
    expect(h.endOffset).toBe(5); // 5 个汉字 = 5 码点（UTF-16 同值，M1 对此例不敏感）
    expect(h.color).toBe('yellow');
    expect(h.createdAt).toBe(NOW);
    expect(h.id.startsWith('hl-')).toBe(true);
  });

  test('代理对口径：emoji 段码点长 ≠ text.length（M1 变异判据）', () => {
    const text = '甲😀乙'; // 3 码点 / 4 UTF-16 单位
    const h = buildSegmentHighlight('bk1', 'ch1', 'seg1', text, 'green', NOW);
    expect(h.endOffset).toBe(3);
    expect(h.endOffset).not.toBe(text.length);
    expect(Array.from(text).length).toBe(3);
  });

  test('连续两次构造 id 不碰撞（生成性而非字面）', () => {
    const a = buildSegmentHighlight('b', 'c', 's', '同一文本', 'blue', NOW);
    const b = buildSegmentHighlight('b', 'c', 's', '同一文本', 'blue', NOW);
    expect(a.id).not.toBe(b.id);
    // 同输入除 id 外字段全同（纯函数：不携带隐藏状态）
    expect({ ...a, id: '' }).toEqual({ ...b, id: '' });
  });

  test('三色均可承载（HighlightColor 全域）', () => {
    for (const color of ['yellow', 'green', 'blue'] as const) {
      const h = buildSegmentHighlight('b', 'c', 's', '文', color, NOW);
      expect(h.color).toBe(color);
    }
  });
});
