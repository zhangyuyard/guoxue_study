/**
 * 版心布局单测（左右边距 + 水平居中 + 容器口径一致）。
 *
 * 锁五条不变量（每条都「变异下会红」）：
 * - INV-C0 ★容器口径一致（**防丢字**）：窗宽 − left − right ≡ contentWidth
 *   —— 行化层按 containerWidth 切行，渲染容器比它窄就会把末字裁掉（2026-09-29 真机实证）；
 * - INV-C1 精确居中：2×left + gridWidth ≡ 窗宽（文字块左右留白严格相等）；
 * - INV-C2 边距下限：left ≥ margin（用户档位只增不减；宽屏/栅格取整时更大）且 right ≤ margin；
 * - INV-C3 版心上限：contentWidth ≤ min(窗宽 − 2×margin, 上限)；
 * - INV-C4 栅格不溢出：gridWidth ≤ contentWidth 且为 cellAdvance 整数倍。
 * 并覆盖非法输入（NaN/负数/极小窗宽/脏 cellAdvance）不产生负宽或非法偏移。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  READER_MAX_CONTENT_WIDTH,
  resolveContentLayout,
} from '@/reader/contentLayout';
import { PAGE_MARGIN_DEFAULT, PAGE_MARGIN_OPTIONS } from '@/theme/typography';

/** 手机竖屏常见窗宽（dp）+ 平板 */
const WIDTHS = [320, 360, 393, 412, 768, 1024] as const;
/** 单格步进：注音关 fontSize=18dp ⇒ cellAdvance = 18dp（真机当前档实测：字格 57px ≈ 18.24dp） */
const ADV_18 = 18;
/** 单格步进：注音开 fontSize=20dp → charGap=2dp ⇒ cellAdvance = 24dp */
const ADV_24 = 24;
/** 真机窗宽（1080px / density 500） */
const DEVICE_W = 345.6;
const EPS = 1e-6;

describe('resolveContentLayout：版心解析（边距 + 居中 + 容器口径）', () => {
  it('手机竖屏（360dp / 边距 20 / 步进 18）：版心 320、栅格 306、左 27、右 13', () => {
    const c = resolveContentLayout(360, 20, ADV_18);
    expect(c.margin).toBe(20);
    expect(c.contentWidth).toBe(320);
    expect(c.gridWidth).toBe(306); // floor(320/18)=17 字 ×18
    expect(c.left).toBeCloseTo(27, 6);
    expect(c.right).toBeCloseTo(13, 6);
    // INV-C0：容器宽 = 窗宽 − left − right ≡ contentWidth
    expect(360 - c.left - c.right).toBeCloseTo(c.contentWidth, 6);
    // INV-C1：文字块精确居中
    expect(c.left * 2 + c.gridWidth).toBeCloseTo(360, 6);
  });

  it('真机复现（1080px / density 500 = 345.6dp / 边距 20 / 步进 18）：左 28.8dp=90px、右 11.2dp=35px', () => {
    // 实测 uiautomator 行容器 x=[91,989]：左偏移 90px ✓；容器宽 898px = 287.4dp。
    // ⚠ 旧口径（左右都取 29dp）下容器 = 287.4dp < containerWidth 305.6dp ⇒ 第 16 字被裁：
    //   行墨迹只到第 15 格末 942px，而第 16 格为 [946,1003]（实测）。
    const c = resolveContentLayout(DEVICE_W, 20, ADV_18);
    expect(c.contentWidth).toBeCloseTo(305.6, 6);
    expect(c.gridWidth).toBe(288); // 16 字 × 18dp
    expect(c.left).toBeCloseTo(28.8, 6);
    expect(c.right).toBeCloseTo(11.2, 6);
    expect(c.left * 3.125).toBeCloseTo(90, 3);
    expect(c.right * 3.125).toBeCloseTo(35, 3);
    // ★防丢字：渲染容器宽 = 345.6 − 28.8 − 11.2 = 305.6dp ≡ containerWidth
    expect(DEVICE_W - c.left - c.right).toBeCloseTo(c.contentWidth, 6);
  });

  it('注音开（345.6dp / 边距 20 / 步进 24）：栅格同为 288，容器口径仍一致', () => {
    const c = resolveContentLayout(DEVICE_W, 20, ADV_24);
    expect(c.gridWidth).toBe(288); // 12 字 × 24dp
    expect(DEVICE_W - c.left - c.right).toBeCloseTo(c.contentWidth, 6);
    expect(c.left * 2 + c.gridWidth).toBeCloseTo(DEVICE_W, 6);
  });

  it('INV-C0 容器口径一致（防丢字）：所有窗宽 × 所有档位 × 多种步进', () => {
    for (const w of WIDTHS) {
      for (const m of PAGE_MARGIN_OPTIONS) {
        for (const adv of [ADV_18, ADV_24, 20, 62.5]) {
          const c = resolveContentLayout(w, m, adv);
          expect(w - c.left - c.right).toBeCloseTo(c.contentWidth, 6);
        }
      }
    }
  });

  it('INV-C1 精确居中：所有窗宽 × 所有档位 × 多种步进，2×left + 栅格 ≡ 窗宽', () => {
    for (const w of WIDTHS) {
      for (const m of PAGE_MARGIN_OPTIONS) {
        for (const adv of [ADV_18, ADV_24, 20, 62.5]) {
          const c = resolveContentLayout(w, m, adv);
          expect(c.left * 2 + c.gridWidth).toBeCloseTo(w, 6);
        }
      }
    }
  });

  it('INV-C2 边距下限：左留白 ≥ 生效边距（宽屏触上限时更大），且右留白与之相等', () => {
    for (const w of WIDTHS) {
      for (const m of PAGE_MARGIN_OPTIONS) {
        const c = resolveContentLayout(w, m, ADV_18);
        expect(c.left).toBeGreaterThanOrEqual(c.margin - EPS);
        // 右留白 = 壳偏移 + 文字块余量；与左留白严格相等（= INV-C1 的另一写法）
        const rightWhite = c.right + (c.contentWidth - c.gridWidth);
        expect(rightWhite).toBeCloseTo(c.left, 6);
      }
    }
  });

  it('INV-C3 版心上限：平板/横屏（1024dp）版心 = 640，文字块 630 居中（两侧各 197）', () => {
    const c = resolveContentLayout(1024, PAGE_MARGIN_DEFAULT, ADV_18);
    expect(c.contentWidth).toBe(READER_MAX_CONTENT_WIDTH);
    expect(c.gridWidth).toBe(630); // floor(640/18)=35 字 ×18
    expect(c.contentWidth).toBeLessThanOrEqual(1024 - c.margin * 2);
    expect(c.left).toBeCloseTo((1024 - 630) / 2, 6);
    expect(c.left).toBeCloseTo(c.right + (c.contentWidth - c.gridWidth), 6);
  });

  it('INV-C4 栅格不溢出：gridWidth ≤ contentWidth 且为步进整数倍', () => {
    for (const w of WIDTHS) {
      for (const m of PAGE_MARGIN_OPTIONS) {
        const c = resolveContentLayout(w, m, ADV_24);
        expect(c.gridWidth).toBeLessThanOrEqual(c.contentWidth);
        expect(c.gridWidth).toBeGreaterThan(0);
        expect(Math.round(c.gridWidth / ADV_24) * ADV_24).toBeCloseTo(c.gridWidth, 5);
      }
    }
  });

  it('边距越大版心越窄（未触上限时单调）', () => {
    const widths = PAGE_MARGIN_OPTIONS.map(
      (m) => resolveContentLayout(412, m, ADV_18).contentWidth,
    );
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThan(widths[i - 1]);
    }
  });

  it('边距越界/非有限值：clamp 或回落默认，不产生非法版心', () => {
    expect(resolveContentLayout(360, -50, ADV_18).margin).toBe(0);
    expect(resolveContentLayout(360, 9999, ADV_18).margin).toBe(120);
    expect(resolveContentLayout(360, Number.NaN, ADV_18).margin).toBe(PAGE_MARGIN_DEFAULT);
    // 半窗宽上限：极窄窗宽下边距被二次收敛，版心仍 ≥ 1 且口径一致
    const tight = resolveContentLayout(30, 120, ADV_18);
    expect(tight.contentWidth).toBeGreaterThanOrEqual(1);
    expect(30 - tight.left - tight.right).toBeCloseTo(tight.contentWidth, 6);
  });

  it('脏 cellAdvance（0 / 负 / NaN）：shift 归零（文字块 = 版心），不产生非法版心', () => {
    for (const adv of [0, -20, Number.NaN]) {
      const c = resolveContentLayout(360, 20, adv);
      expect(c.contentWidth).toBe(320);
      expect(c.gridWidth).toBe(320);
      expect(c.left).toBe(20);
      expect(c.right).toBe(20);
    }
  });

  it('退化窗宽（0 / NaN / 负）：版心 ≥ 1，不崩', () => {
    for (const w of [0, Number.NaN, -100]) {
      const c = resolveContentLayout(w, 20, ADV_18);
      expect(c.contentWidth).toBeGreaterThanOrEqual(1);
      expect(c.gridWidth).toBeGreaterThanOrEqual(1);
      expect(c.left).toBeGreaterThanOrEqual(0);
    }
  });

  it('纯函数：同输入同输出（无状态、无缓存）', () => {
    expect(resolveContentLayout(393, 32, ADV_18)).toEqual(
      resolveContentLayout(393, 32, ADV_18),
    );
  });
});

// ============================ 渲染层接线（源码文本即断言） ============================

/**
 * 剥注释（先块后行）。
 * ⚠ 必要性：本文件与被测源码注释里都出现 `contentInsets` / `left` 这类被断言的片段，
 * 不剥离 ⇒ 断言可被注释满足 ⇒ 假绿。本文件自身的注释亦含被断言串，故断言对象只有别的源码。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 出现次数（按「次数」而非「行数」计，避免同一行多次命中被算成 1） */
function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const SCROLL_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/ScrollMode.tsx');
const PAGE_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/PageMode.tsx');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');

describe('版心接线：几何算出的版心必须真的被渲染层用上（左右各自成对）', () => {
  // 回归背景（2026-09-29 真机）：
  // ① ScrollMode 行容器原为 `left:0 right:0` 全宽 ⇒ 正文贴左、右侧多出 2×margin；
  // ② 用「对称 inset = 居中值」修 ① 时容器变窄（287.4dp < 305.6dp）⇒ 行化切出的末字被裁。
  // 「几何算了、渲染没用」与「左右不成对」都不报错、不红灯，只能靠接线断言锁住。
  const scrollSrc = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));
  const pageSrc = stripComments(readFileSync(PAGE_MODE_PATH, 'utf8'));
  const readerSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));

  it('ScrollMode：行容器左右分别取 contentInsets.left / .right（各 1 次命中）', () => {
    expect(countOf(scrollSrc, 'left: contentInsets.left,')).toBe(1);
    expect(countOf(scrollSrc, 'right: contentInsets.right,')).toBe(1);
  });

  it('ScrollMode：列命中与渲染同一左偏移（locationX − contentInsets.left）', () => {
    expect(countOf(scrollSrc, '(locationX - contentInsets.left)')).toBe(1);
  });

  it('PageMode：FlatList 内容容器左右内边距分别取 contentInsets.left / .right', () => {
    expect(countOf(pageSrc, 'paddingLeft: contentInsets.left,')).toBe(1);
    expect(countOf(pageSrc, 'paddingRight: contentInsets.right,')).toBe(1);
  });

  it('ReaderScreen：版心宽喂几何、左右偏移成对喂两种模式、单格步进喂版心', () => {
    expect(countOf(readerSrc, 'const containerWidth = content.contentWidth;')).toBe(1);
    expect(countOf(readerSrc, 'contentInsets: { left: content.left, right: content.right },')).toBe(2);
    // 版心解析必须拿到与几何同源的 cellAdvance（缺此实参 ⇒ 退化为 shift=0 = 右侧残差回归）
    expect(
      countOf(readerSrc, 'resolveContentLayout(windowWidth, pageMarginSetting, cellAdvance)'),
    ).toBe(1);
    expect(countOf(readerSrc, 'const cellAdvance = cellAdvanceFor(fontSize, charGap);')).toBe(1);
  });

  it('阴性对照：单值命名 contentInset（旧口径）已从模式层绝迹', () => {
    // 同范围正对照：同一份源码里新命名在场 ⇒ 计数工具本身有效（防「grep 打偏 = 假 0」）
    expect(countOf(scrollSrc, 'contentInsets')).toBeGreaterThan(0);
    expect(countOf(pageSrc, 'contentInsets')).toBeGreaterThan(0);
    // 'contentInset' 是 'contentInsets' 的子串 ⇒ 用带分隔符的字面量做阴性对照
    expect(countOf(scrollSrc, 'contentInset:')).toBe(0);
    expect(countOf(scrollSrc, 'contentInset,')).toBe(0);
    expect(countOf(pageSrc, 'contentInset:')).toBe(0);
    expect(countOf(pageSrc, 'contentInset,')).toBe(0);
    expect(countOf(scrollSrc, 'pageMargin')).toBe(0);
    expect(countOf(pageSrc, 'pageMargin')).toBe(0);
  });
});
