/**
 * R2c 性能探针：超大章 layout 计时（非 flaky 断言：设保守上限 50ms，
 * 超过才需要分片/增量 layout）。纯 JS 计时，不依赖真机帧率。
 */
import { layoutChapter, resolveGeometry } from '../reader/geometry';
import type { ChapterSegment } from '../types';

function bigChapter(segCount: number, charsPerSeg: number): ChapterSegment[] {
  const segs: ChapterSegment[] = [];
  for (let i = 0; i < segCount; i++) {
    segs.push({ id: `s${i}`, order: i, text: '子曰学而时习之不亦说乎'.repeat(Math.ceil(charsPerSeg / 12)).slice(0, charsPerSeg) } as ChapterSegment);
  }
  return segs;
}

describe('R2c layout 性能探针（超大章）', () => {
  const g = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320 });

  it('1 万字章（50 段 × 200 字）layout < 50ms', () => {
    const segs = bigChapter(50, 200);
    const t0 = Date.now();
    const layout = layoutChapter('ch-perf', segs, g);
    const ms = Date.now() - t0;
    expect(layout.lines.length).toBeGreaterThan(500);
    // 保守上限：超此值才值得做分片/增量 layout（R2c 决策依据）
    expect(ms).toBeLessThan(50);
  });

  it('5 万字巨章（100 段 × 500 字）layout < 150ms', () => {
    const segs = bigChapter(100, 500);
    const t0 = Date.now();
    const layout = layoutChapter('ch-perf-big', segs, g);
    const ms = Date.now() - t0;
    expect(layout.lines.length).toBeGreaterThan(2500);
    expect(ms).toBeLessThan(150);
  });
});
