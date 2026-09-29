/**
 * 多模式翻页（cover/slide/none）接线断言（源码文本即断言）。
 *
 * 背景（2026-09-29）：实现 react-native-reader 五模式中的四种零迁移落地
 * （scroll=上下已有、page=逐页已有，新增 cover 覆盖 / slide 平移 / none 无动画）；
 * 仿真（simulation）依赖 Skia + RN≥0.78 + 新架构，延后——
 * 见 docs/reader-flip-modes-migration-assessment-2026-09-29.md。
 * 「接线断了不报错不红灯」（如 ReaderCore 漏路由、ReaderScreen 漏传 props），
 * 只能靠接线断言锁住。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const READER_CORE_PATH = resolve(APP_ROOT, 'reader/core/ReaderCore.tsx');
const FLIP_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/FlipMode.tsx');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');
const PROFILE_PATH = resolve(APP_ROOT, 'screens/ProfileScreen.tsx');

describe('多模式翻页接线：cover/slide/none → FlipMode', () => {
  const coreSrc = stripComments(readFileSync(READER_CORE_PATH, 'utf8'));
  const flipSrc = stripComments(readFileSync(FLIP_MODE_PATH, 'utf8'));
  const screenSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
  const profileSrc = stripComments(readFileSync(PROFILE_PATH, 'utf8'));

  it('ReaderCore：三模式路由到 FlipMode（1 处）且 animation 由 mode 派生', () => {
    expect(countOf(coreSrc, "mode === 'cover' || mode === 'slide' || mode === 'none'")).toBe(1);
    expect(countOf(coreSrc, '<FlipMode key={flip.listKey} {...flip} animation={mode} />')).toBe(1);
    // flip 类型省 animation（由 mode 派生）
    expect(countOf(coreSrc, "Omit<FlipModeProps, 'animation'>")).toBe(1);
  });

  it('ReaderScreen：flip props 成套传入（含边界跳章与页背景）', () => {
    expect(countOf(screenSrc, 'flip={{')).toBe(1);
    expect(countOf(screenSrc, 'onBoundaryPrev: handleFlipBoundaryPrev,')).toBe(1);
    expect(countOf(screenSrc, 'onBoundaryNext: handleFlipBoundaryNext,')).toBe(1);
    expect(countOf(screenSrc, 'pageBackgroundColor: colors.background,')).toBe(1);
    // 边界 → 章间导航（jumpTo）接线
    expect(countOf(screenSrc, 'jumpTo(siblings.prev.id)')).toBeGreaterThanOrEqual(1);
    expect(countOf(screenSrc, 'jumpTo(siblings.next.id)')).toBeGreaterThanOrEqual(1);
  });

  it('FlipMode：双缓冲动画层 + 边界上抛 + 动画中吞输入', () => {
    // 三种动画的落点插值（bottom 层垫/同步滑）：next 的 to 与 prev 的 from 各 1 次 = 2
    expect(countOf(flipSrc, "animation === 'slide' ? -viewportW : 0")).toBe(2);
    expect(countOf(flipSrc, 'onBoundaryPrev?.()')).toBe(1);
    expect(countOf(flipSrc, 'onBoundaryNext?.()')).toBe(1);
    // 动画锁（防连点叠帧）
    expect(countOf(flipSrc, 'animatingRef.current')).toBeGreaterThanOrEqual(2);
    // 落定记账（码点真值）
    expect(countOf(flipSrc, 'commitRef.current(line)')).toBe(1);
  });

  it('ProfileScreen：五档翻页模式选项（新增覆盖/平移/无动画各 1 次）', () => {
    expect(countOf(profileSrc, "{ value: 'cover' as const, label: '覆盖' }")).toBe(1);
    expect(countOf(profileSrc, "{ value: 'slide' as const, label: '平移' }")).toBe(1);
    expect(countOf(profileSrc, "{ value: 'none' as const, label: '无动画' }")).toBe(1);
  });

  it('阴性对照：仿真（simulation）未混入 UI 与类型（延后状态锁定）', () => {
    // 同范围正对照：新值在场 ⇒ 计数工具有效（防「grep 打偏 = 假 0」）
    expect(countOf(profileSrc, "'cover' as const")).toBeGreaterThan(0);
    // 仿真延后：UI 与 ReaderScreen 不得出现 simulation
    expect(countOf(profileSrc, 'simulation')).toBe(0);
    expect(countOf(screenSrc, 'simulation')).toBe(0);
    expect(countOf(coreSrc, 'simulation')).toBe(0);
  });
});
