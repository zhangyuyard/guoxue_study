/**
 * L1/L2 纯函数层单测（架构方案 §5：INV-G1 / INV-P1，每条断言「变异下会红」）。
 * 覆盖：24 档行高穷举（12 档 × 注音开/关）、行化切分精确值、章局码点连续性、
 * 位置往返一致、二分边界、Y 钳制、getItemLayoutOf。
 */
import {
  PINYIN_FONT_RATIO,
  PINYIN_LINE_GAP,
  getLineHeightPx,
} from '../theme/typography';
import {
  CHAR_LINE_HEIGHT_RATIO,
  PINYIN_LINE_HEIGHT_RATIO,
  PINYIN_SIZE_FLOOR,
  charGapFor,
  getItemLayoutOf,
  layoutChapter,
  pinyinRowMetrics,
  resolveGeometry,
  type Line,
} from '../reader/geometry';
import {
  charOffsetAtY,
  lineAtCharOffset,
  lineAtY,
  yOfLine,
} from '../reader/position';

const FONT_SIZES = [16, 18, 20, 24] as const;
const LINE_HEIGHTS = [1.4, 1.6, 1.8] as const;

/** 测试用章：多段 + 含 ASCII/标点 + 空段（覆盖段界 / 码点模型 / 空段） */
const SEGMENTS = [
  { id: 's0', text: '学而时习之，不亦说乎？' },
  { id: 's1', text: '有朋自远方来，不亦乐乎？' },
  { id: 's2', text: '' },
  { id: 's3', text: 'The Analects 亡之，命矣夫！' },
];

/** 手工复算的期望行高（与 resolveGeometry 内部公式独立写一遍，防同源漂移） */
function expectedRowHeight(fontSize: number, lineHeight: number, pinyinEnabled: boolean): number {
  if (!pinyinEnabled) {
    return getLineHeightPx(fontSize, lineHeight);
  }
  const pinyinSize = Math.max(PINYIN_SIZE_FLOOR, Math.round(fontSize * PINYIN_FONT_RATIO));
  const pinyinLineHeight = Math.round(pinyinSize * PINYIN_LINE_HEIGHT_RATIO);
  const charLineHeight = Math.round(fontSize * CHAR_LINE_HEIGHT_RATIO);
  const rowGap = Math.max(2, Math.round(fontSize * (lineHeight - 1)));
  return pinyinLineHeight + PINYIN_LINE_GAP + charLineHeight + rowGap;
}

describe('resolveGeometry：24 档穷举（12 档 × 注音开/关）', () => {
  it.each(FONT_SIZES.flatMap((fs) => LINE_HEIGHTS.map((lh) => ({ fs, lh }))))(
    'fs=$fs lh=$lh：注音开/关 rowHeight 均等于独立复算式',
    ({ fs, lh }) => {
      for (const pinyinEnabled of [true, false]) {
        const g = resolveGeometry({ fontSize: fs, lineHeight: lh, pinyinEnabled, containerWidth: 320 });
        expect(g.rowHeight).toBe(expectedRowHeight(fs, lh, pinyinEnabled));
        expect(g.lineHeightPx).toBe(getLineHeightPx(fs, lh));
        expect(g.cellWidth).toBe(fs);
      }
    },
  );

  it('默认档定值：注音开 50（方案 D），注音关 29 —— 不是 48/50 二值', () => {
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320 }).rowHeight).toBe(50);
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: false, containerWidth: 320 }).rowHeight).toBe(29);
    expect(pinyinRowMetrics(18, 1.6)).toMatchObject({ pinyinSize: 10, pinyinLineHeight: 14, charLineHeight: 23, rowGap: 11, pinyinSlot: 16, rowHeight: 50 });
  });

  it('12 档注音开行高全为奇定值（16+23+11 结构，恒 ≥ 注音关同行档）', () => {
    for (const fs of FONT_SIZES) {
      for (const lh of LINE_HEIGHTS) {
        const on = resolveGeometry({ fontSize: fs, lineHeight: lh, pinyinEnabled: true, containerWidth: 320 });
        const off = resolveGeometry({ fontSize: fs, lineHeight: lh, pinyinEnabled: false, containerWidth: 320 });
        const m = pinyinRowMetrics(fs, lh);
        expect(on.rowHeight).toBe(m.pinyinSlot + m.charLineHeight + m.rowGap);
        expect(on.rowHeight).toBeGreaterThan(off.rowHeight);
      }
    }
  });

  it('charsPerLine = max(1, floor(容器宽 / cellAdvance))；容器宽不足 1 格时钳 1', () => {
    // 默认档：advance = 18 + 2×max(2, round(1.08)) = 18 + 4 = 22（注音开/关同 advance 公式）
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320 }).charsPerLine).toBe(Math.floor(320 / 22));
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 10 }).charsPerLine).toBe(1);
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: false, containerWidth: 0 }).charsPerLine).toBe(1);
    // 显式 charGap 参与步进
    expect(resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320, charGap: 4 }).charsPerLine).toBe(Math.floor(320 / 26));
  });
});

describe('layoutChapter：行化切分（INV-G1 左半 + 精确值）', () => {
  const g = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320, charGap: 2 });
  // advance = 22 ⇒ charsPerLine = floor(320/22) = 14

  it('每行 ≤ charsPerLine；总高等式 lines.length × rowHeight === totalHeight', () => {
    const { lines, totalHeight } = layoutChapter('c1', SEGMENTS, g);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.charEnd - line.charStart).toBeLessThanOrEqual(g.charsPerLine);
    }
    expect(lines.length * g.rowHeight).toBe(totalHeight);
  });

  it('精确切分：首段 11 码点为 1 行；跨段行号连续；空段产出 0 行', () => {
    const { lines } = layoutChapter('c1', SEGMENTS, g);
    expect(Array.from(SEGMENTS[0].text).length).toBe(11);
    expect(lines[0]).toMatchObject({ index: 0, chapterId: 'c1', segmentId: 's0', charStart: 0, charEnd: 11 });
    // 第二段首行：章局偏移从 11 起
    const s1Lines = lines.filter((l) => l.segmentId === 's1');
    expect(s1Lines[0]).toMatchObject({ index: 1, segmentId: 's1', charStart: 11, charEnd: Math.min(11 + g.charsPerLine, 11 + 12) });
    // 空段 s2 无行；s3 行的段内码点不含 s2 占位
    expect(lines.some((l) => l.segmentId === 's2')).toBe(false);
    const s3First = lines.find((l) => l.segmentId === 's3');
    expect(s3First?.charStart).toBe(23);
  });

  it('章局码点覆盖 [0, N) 连续无缝（段界处累加，无重叠无空洞）', () => {
    const { lines } = layoutChapter('c1', SEGMENTS, g);
    let expectStart = 0;
    for (const line of lines) {
      expect(line.charStart).toBe(expectStart);
      expect(line.charEnd).toBeGreaterThan(line.charStart);
      expectStart = line.charEnd;
    }
    const total = SEGMENTS.reduce((n, s) => n + Array.from(s.text).length, 0);
    expect(expectStart).toBe(total);
  });

  it('单段超长（极端章·段内切分）：行数 = ceil(N / charsPerLine)，仍无缝覆盖', () => {
    const big = { id: 'long', text: '卷'.repeat(1000) };
    const { lines, totalHeight } = layoutChapter('c2', [big], g);
    expect(lines.length).toBe(Math.ceil(1000 / g.charsPerLine));
    expect(lines[lines.length - 1].charEnd).toBe(1000);
    expect(totalHeight).toBe(lines.length * g.rowHeight);
    // 空章
    expect(layoutChapter('c3', [], g)).toEqual({ lines: [], totalHeight: 0 });
  });

  it('同输入同输出（纯函数：几何与注音数据无关，重复调用引用相等语义不变）', () => {
    const a = layoutChapter('c1', SEGMENTS, g);
    const b = layoutChapter('c1', SEGMENTS, g);
    expect(a).toEqual(b);
    // 注音开关不改变行化结果（U7：几何不得等注音 —— 行数/码点切分与 pinyinEnabled 无关）
    const gOff = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: false, containerWidth: 320, charGap: 2 });
    expect(layoutChapter('c1', SEGMENTS, gOff).lines).toEqual(a.lines);
  });
});

describe('position：位置模型（INV-P1 往返一致 + 边界）', () => {
  const g = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320, charGap: 2 });
  const { lines } = layoutChapter('c1', SEGMENTS, g);

  it('INV-P1：码点 → 行 → Y → 行 → 码点，保行不变；行首码点精确相等', () => {
    const total = SEGMENTS.reduce((n, s) => n + Array.from(s.text).length, 0);
    for (let c = 0; c < total; c++) {
      const li = lineAtCharOffset(lines, c);
      expect(li).toBeGreaterThanOrEqual(0);
      const pos = charOffsetAtY(lines, g, yOfLine(g, li));
      expect(pos.lineIndex).toBe(li);
      expect(lineAtCharOffset(lines, pos.charOffset)).toBe(li);
      if (lines[li].charStart === c) {
        expect(pos.charOffset).toBe(c);
      }
    }
  });

  it('二分精确值：段界 / 行界 / 末行 / 越界', () => {
    expect(lineAtCharOffset(lines, 0)).toBe(0);
    expect(lineAtCharOffset(lines, 10)).toBe(0); // 首段末码点
    expect(lineAtCharOffset(lines, 11)).toBe(1); // 段界 → 下一段首行
    const last = lines[lines.length - 1];
    expect(lineAtCharOffset(lines, last.charEnd - 1)).toBe(last.index);
    expect(lineAtCharOffset(lines, last.charEnd)).toBe(last.index); // 章末（续读钳末行）
    expect(lineAtCharOffset([], 0)).toBe(-1);
    expect(lineAtCharOffset(lines, -1)).toBe(-1);
  });

  it('Y 钳制：负 Y → 第 0 行（圆标溢出区）；超出章底 → 末行', () => {
    expect(lineAtY(g, -50)).toBe(0);
    expect(lineAtY(g, 0)).toBe(0);
    expect(lineAtY(g, yOfLine(g, 3))).toBe(3);
    const beyond = charOffsetAtY(lines, g, lines.length * g.rowHeight + 9999);
    expect(beyond.lineIndex).toBe(lines.length - 1);
    expect(charOffsetAtY([], g, 0)).toEqual({ lineIndex: -1, charOffset: -1 });
  });

  it('yOfLine/lineAtY 互逆（行级）', () => {
    for (let i = 0; i < lines.length; i++) {
      expect(lineAtY(g, yOfLine(g, i))).toBe(i);
    }
  });
});

describe('charGapFor：字距唯一真源（几何 cellAdvance 与渲染器 marginHorizontal 同源）', () => {
  it('默认档定值：full=4（max(4, round(2.88))）、rare=2（max(2, round(1.08))）、off 同 rare', () => {
    expect(charGapFor('full', 18)).toBe(4);
    expect(charGapFor('rare', 18)).toBe(2);
    expect(charGapFor('off', 18)).toBe(2);
  });

  it('大字号 full 档由公式主导（fs=24：round(3.84)=4）；小字号钳下限', () => {
    expect(charGapFor('full', 24)).toBe(4);
    expect(charGapFor('full', 32)).toBe(5);
    expect(charGapFor('rare', 12)).toBe(2);
  });
});

describe('getItemLayoutOf：无表纯算式（L1/L3 唯一入口）', () => {
  it('offset/length 逐行精确且引用无关', () => {
    const g = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: true, containerWidth: 320 });
    const fn = getItemLayoutOf(g);
    expect(fn(null, 0)).toEqual({ length: 50, offset: 0, index: 0 });
    expect(fn({} as Line, 7)).toEqual({ length: 50, offset: 350, index: 7 });
    const gOff = resolveGeometry({ fontSize: 18, lineHeight: 1.6, pinyinEnabled: false, containerWidth: 320 });
    expect(getItemLayoutOf(gOff)(null, 3)).toEqual({ length: 29, offset: 87, index: 3 });
  });
});
