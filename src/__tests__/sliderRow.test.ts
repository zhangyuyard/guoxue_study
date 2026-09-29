/**
 * 设置页「进度条（滑块）」单测 —— 09-29 字号/行距/左右边距由分段控件改滑块。
 *
 * 锁四类断言：
 * - 纯函数：吸附/比例/反算的越界、非有限值、**浮点消噪**（0.1 步进不得写出 1.7000000000000002）；
 * - 往返一致：网格上任意值 `valueAtRatio(ratioOfValue(v)) === v`；
 * - ★ **网格覆盖历史档位 + 默认值落在网格上** ⇒ 存量值（18 / 1.6 / 20）拖动不跳变、无需迁移；
 * - 接线：三个字段确实用 Slider（旧 SegmentedRow 字面量绝迹），且组件的**三个实现点**在场
 *   （触点为容器自身 / 扣滑块半径 / 值不变不上报）—— 这三点坏了都不报错，只能靠源码断言锁。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  FONT_SIZE_OPTIONS,
  FONT_SIZE_RANGE,
  LINE_HEIGHT_OPTIONS,
  LINE_HEIGHT_RANGE,
  PAGE_MARGIN_DEFAULT,
  PAGE_MARGIN_OPTIONS,
  PAGE_MARGIN_RANGE,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
} from '@/theme/typography';
import { ratioOfValue, snapToGrid, valueAtRatio, valueAtTouchX, SLIDER_THUMB } from '@/components/sliderMath';
import type { SliderSpec } from '@/theme/typography';

describe('snapToGrid：吸附到网格（含浮点消噪与越界 clamp）', () => {
  it('字号网格（14–30 / 步进 2）：半数进位、网格内保持', () => {
    expect(snapToGrid(18, FONT_SIZE_RANGE)).toBe(18);
    expect(snapToGrid(20, FONT_SIZE_RANGE)).toBe(20);
    expect(snapToGrid(19, FONT_SIZE_RANGE)).toBe(20); // (19−14)/2 = 2.5 ⇒ 进位
    expect(snapToGrid(17, FONT_SIZE_RANGE)).toBe(18); // 1.5 ⇒ 进位
    expect(snapToGrid(23, FONT_SIZE_RANGE)).toBe(24);
  });

  it('★ 浮点消噪：0.1 步进的结果必须是精确网格值（不得写 1.7000000000000002 进 store）', () => {
    expect(snapToGrid(1.7, LINE_HEIGHT_RANGE)).toBe(1.7);
    expect(snapToGrid(1.7000000000000002, LINE_HEIGHT_RANGE)).toBe(1.7);
    expect(snapToGrid(1.4, LINE_HEIGHT_RANGE)).toBe(1.4);
    expect(snapToGrid(2, LINE_HEIGHT_RANGE)).toBe(2);
    // 每个网格点反算后仍逐位相等（toBe = 严格等于，非 toBeCloseTo）
    for (let v = LINE_HEIGHT_RANGE.min; v <= LINE_HEIGHT_RANGE.max + 1e-9; v += LINE_HEIGHT_RANGE.step) {
      expect(snapToGrid(v, LINE_HEIGHT_RANGE)).toBe(Number(v.toFixed(1)));
    }
  });

  it('越界与畸形输入：±Infinity clamp 到端点；NaN / 非法 spec 回落 min', () => {
    expect(snapToGrid(999, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    expect(snapToGrid(-99, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(snapToGrid(Number.POSITIVE_INFINITY, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    expect(snapToGrid(Number.NEGATIVE_INFINITY, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(snapToGrid(Number.NaN, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(ratioOfValue(Number.POSITIVE_INFINITY, FONT_SIZE_RANGE)).toBe(1);
    expect(valueAtRatio(Number.POSITIVE_INFINITY, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    const degenerate: SliderSpec = { min: 5, max: 5, step: 0 };
    expect(snapToGrid(7, degenerate)).toBe(5);
    expect(ratioOfValue(7, degenerate)).toBe(0);
    expect(valueAtRatio(0.5, degenerate)).toBe(5);
  });
});

describe('ratioOfValue / valueAtRatio：位置与值双向换算', () => {
  it('端点映射 0 / 1，中点映射 0.5', () => {
    expect(ratioOfValue(FONT_SIZE_RANGE.min, FONT_SIZE_RANGE)).toBe(0);
    expect(ratioOfValue(FONT_SIZE_RANGE.max, FONT_SIZE_RANGE)).toBe(1);
    expect(ratioOfValue(22, FONT_SIZE_RANGE)).toBe(0.5);
    expect(valueAtRatio(0, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(valueAtRatio(1, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    expect(valueAtRatio(0.5, FONT_SIZE_RANGE)).toBe(22);
  });

  it('比例越界自动 clamp；非有限比例回落 min；非网格值先吸附再算比例', () => {
    expect(valueAtRatio(-1, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(valueAtRatio(2, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    expect(valueAtRatio(Number.NaN, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(ratioOfValue(999, FONT_SIZE_RANGE)).toBe(1);
    expect(ratioOfValue(-999, FONT_SIZE_RANGE)).toBe(0);
    // 19 不在字号网格上 ⇒ 按吸附后的 20 显示位置
    expect(ratioOfValue(19, FONT_SIZE_RANGE)).toBeCloseTo(0.375, 10);
  });

  it('往返一致：网格上每个值 → 比例 → 值 恒等', () => {
    for (const spec of [FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, PAGE_MARGIN_RANGE]) {
      const steps = Math.round((spec.max - spec.min) / spec.step);
      for (let i = 0; i <= steps; i++) {
        const v = Number((spec.min + i * spec.step).toFixed(2));
        expect(valueAtRatio(ratioOfValue(v, spec), spec)).toBe(v);
      }
    }
  });

  it('valueAtTouchX：扣除滑块半径后端点精确命中 min/max；轨道未测量返回 null', () => {
    const w = 300;
    // 触点落在轨道可视区左端（容器内 x = THUMB/2）
    expect(valueAtTouchX(SLIDER_THUMB / 2, w, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    // 触点落在轨道可视区右端
    expect(valueAtTouchX(SLIDER_THUMB / 2 + w, w, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    // 中点位（可视区 0.5）→ 中值
    expect(valueAtTouchX(SLIDER_THUMB / 2 + w / 2, w, FONT_SIZE_RANGE)).toBe(22);
    // 越出容器（拖到轨道外）仍 clamp
    expect(valueAtTouchX(-500, w, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.min);
    expect(valueAtTouchX(5000, w, FONT_SIZE_RANGE)).toBe(FONT_SIZE_RANGE.max);
    // 轨道尚未 onLayout ⇒ 不上报（返回 null，调用方跳过）
    expect(valueAtTouchX(100, 0, FONT_SIZE_RANGE)).toBeNull();
  });
});

describe('★ 网格覆盖历史档位（存量值不跳变、无需数据迁移）', () => {
  const onGrid = (v: number, spec: SliderSpec): boolean =>
    Math.abs(snapToGrid(v, spec) - v) < 1e-9;

  it('旧字号档 16/18/20/24 全在 14–30/步进 2 网格上', () => {
    for (const v of FONT_SIZE_OPTIONS) {
      expect(onGrid(v, FONT_SIZE_RANGE)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(FONT_SIZE_RANGE.min);
      expect(v).toBeLessThanOrEqual(FONT_SIZE_RANGE.max);
    }
  });

  it('旧行距档 1.4/1.6/1.8 全在 1.2–2.0/步进 0.1 网格上', () => {
    for (const v of LINE_HEIGHT_OPTIONS) {
      expect(onGrid(v, LINE_HEIGHT_RANGE)).toBe(true);
    }
  });

  it('旧边距档 12/20/32/48 全在 0–64/步进 4 网格上', () => {
    for (const v of PAGE_MARGIN_OPTIONS) {
      expect(onGrid(v, PAGE_MARGIN_RANGE)).toBe(true);
      expect(v).toBeLessThanOrEqual(PAGE_MARGIN_RANGE.max);
    }
    // 滑块上限刻意窄于 store clamp 上限（120 只可能来自旧备份）
    expect(PAGE_MARGIN_RANGE.max).toBeLessThan(120);
  });

  it('默认值（18 / 1.6 / 20）落在各自网格上且在区间内', () => {
    expect(snapToGrid(DEFAULT_FONT_SIZE, FONT_SIZE_RANGE)).toBe(DEFAULT_FONT_SIZE);
    expect(snapToGrid(DEFAULT_LINE_HEIGHT, LINE_HEIGHT_RANGE)).toBe(DEFAULT_LINE_HEIGHT);
    expect(snapToGrid(PAGE_MARGIN_DEFAULT, PAGE_MARGIN_RANGE)).toBe(PAGE_MARGIN_DEFAULT);
  });
});

// ============================ 渲染层接线（源码文本即断言） ============================

/**
 * 剥注释（先块后行）。
 * ⚠ 必要性：本文件被测源码的注释里出现 `pointerEvents="none"`、`locationX` 等被断言片段，
 * 不剥离 ⇒ 断言可被注释满足 ⇒ 假绿。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const PROFILE_SRC = stripComments(readFileSync(resolve(APP_ROOT, 'screens/ProfileScreen.tsx'), 'utf8'));
const SLIDER_SRC = stripComments(readFileSync(resolve(APP_ROOT, 'components/SliderField.tsx'), 'utf8'));
const MATH_SRC = stripComments(readFileSync(resolve(APP_ROOT, 'components/sliderMath.ts'), 'utf8'));

describe('滑块接线：三个字段用进度条，且三个实现点在场', () => {
  it('ProfileScreen：字号 / 行距 / 左右边距 各接一个 SliderField（共 3 个）', () => {
    expect(countOf(PROFILE_SRC, '<SliderField')).toBe(3);
    expect(countOf(PROFILE_SRC, 'spec={FONT_SIZE_RANGE}')).toBe(1);
    expect(countOf(PROFILE_SRC, 'spec={LINE_HEIGHT_RANGE}')).toBe(1);
    expect(countOf(PROFILE_SRC, 'spec={PAGE_MARGIN_RANGE}')).toBe(1);
  });

  it('阴性对照：旧分段控件字面量已从这三项绝迹，但 SegmentedRow 仍服务其余设置', () => {
    // 同范围正对照：新控件在场 ⇒ 计数工具本身有效（防「grep 打偏 = 假 0」）
    expect(countOf(PROFILE_SRC, 'SliderField')).toBeGreaterThan(0);
    expect(countOf(PROFILE_SRC, 'FONT_SIZE_OPTIONS.map(')).toBe(0);
    expect(countOf(PROFILE_SRC, 'LINE_HEIGHT_OPTIONS.map(')).toBe(0);
    expect(countOf(PROFILE_SRC, 'PAGE_MARGIN_OPTIONS.map(')).toBe(0);
    // 主题/翻页模式/性能档位/注音/繁简仍是分段控件
    expect(countOf(PROFILE_SRC, '<SegmentedRow')).toBeGreaterThanOrEqual(5);
  });

  it('★ 实现点①：视觉层 pointerEvents="none" ⇒ locationX 口徑恒相对轨道容器', () => {
    expect(countOf(SLIDER_SRC, 'pointerEvents="none"')).toBe(1);
  });

  it('★ 实现点②：比例换算走 valueAtTouchX（扣滑块半径的公式在 sliderMath）', () => {
    expect(countOf(SLIDER_SRC, 'valueAtTouchX(locationX, trackWRef.current, specRef.current)')).toBe(1);
    expect(countOf(MATH_SRC, '(locationX - SLIDER_THUMB / 2) / trackWidth')).toBe(1);
  });

  it('★ 实现点③：吸附结果不变则不上报（拖一帧最多一次 store 写入）', () => {
    expect(countOf(SLIDER_SRC, 'if (next === lastRef.current) return;')).toBe(1);
  });
});
