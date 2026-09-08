/**
 * 仿真翻页窗口化渲染测试（问题 3：仿真翻页模式 loading 极久 / 按钮极慢）
 *
 * 根因：PageFlipPager 旧实现一次性同步渲染整章所有页（每页全量 PinyinText），
 * 大书单章数百页直接把 JS 线程压死。
 * 修复：窗口化渲染——只全量渲染当前页附近窗口（受控 index ∪ 落位 settled 的
 * 并集前后各 2 页）内的页，窗口外渲染同尺寸空占位（分页宽度不变）。
 *
 * 本文件锁定窗口区间计算（纯函数）的行为边界，并以源码结构断言锁定
 * PageFlipPager 的接线，防止回退为整章全量渲染。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  computePageRenderWindow,
  PAGE_RENDER_WINDOW_MARGIN,
} from '@/utils/readerPageWindow';

const SRC_ROOT = join(__dirname, '..', '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

describe('computePageRenderWindow：基本窗口（并集前后各 margin 页）', () => {
  test('index 与 settled 一致：窗口 = [i - margin, i + margin]', () => {
    expect(computePageRenderWindow(5, 5, 100)).toEqual({ start: 3, end: 7 });
    expect(computePageRenderWindow(50, 50, 100)).toEqual({ start: 48, end: 52 });
  });

  test('index 与 settled 不同页（点击翻页过渡帧）：取两者并集再扩 margin', () => {
    // index=4（目标页）settled=2（落位页）：逐页过渡，并集 [2,4] 扩 margin → [0,6]
    expect(computePageRenderWindow(4, 2, 100)).toEqual({ start: 0, end: 6 });
    // 反向同样成立（参数顺序无关）
    expect(computePageRenderWindow(2, 4, 100)).toEqual({ start: 0, end: 6 });
  });

  test('长距离跳页帧（定位 / 跨章回来，|index - settled| 远大于窗口）：只以 settled 为基准', () => {
    // 此刻物理滚动仍停在 settled=0，若按并集渲染会把 0~40 页一帧全部挂载；
    // 目标页等外部 index effect 落位（setSettled）后窗口自然移过去
    expect(computePageRenderWindow(40, 0, 100)).toEqual({ start: 0, end: 2 });
    expect(computePageRenderWindow(0, 40, 100)).toEqual({ start: 38, end: 42 });
  });

  test('margin 可自定义', () => {
    expect(computePageRenderWindow(10, 10, 100, 1)).toEqual({ start: 9, end: 11 });
    expect(computePageRenderWindow(10, 10, 100, 0)).toEqual({ start: 10, end: 10 });
  });

  test('缺省 margin 为 PAGE_RENDER_WINDOW_MARGIN = 2（翻一页至多新增 1 页挂载）', () => {
    expect(PAGE_RENDER_WINDOW_MARGIN).toBe(2);
  });
});

describe('computePageRenderWindow：边界钳制', () => {
  test('章首页（0）：窗口不越出左边界', () => {
    expect(computePageRenderWindow(0, 0, 100)).toEqual({ start: 0, end: 2 });
  });

  test('章尾页（pageCount - 1）：窗口不越出右边界', () => {
    expect(computePageRenderWindow(99, 99, 100)).toEqual({ start: 97, end: 99 });
  });

  test('页数少于窗口宽度：覆盖全部页', () => {
    expect(computePageRenderWindow(1, 1, 3)).toEqual({ start: 0, end: 2 });
    expect(computePageRenderWindow(0, 0, 1)).toEqual({ start: 0, end: 0 });
  });

  test('越界 index / settled（重分页收缩过渡帧）：钳制到有效区间', () => {
    expect(computePageRenderWindow(150, 0, 100)).toEqual({ start: 0, end: 2 });
    expect(computePageRenderWindow(0, 150, 100)).toEqual({ start: 97, end: 99 });
  });

  test('负数 index / settled：钳制到 0', () => {
    expect(computePageRenderWindow(-3, 0, 100)).toEqual({ start: 0, end: 2 });
    expect(computePageRenderWindow(0, -3, 100)).toEqual({ start: 0, end: 2 });
    expect(computePageRenderWindow(-3, -3, 100)).toEqual({ start: 0, end: 2 });
  });

  test('pageCount <= 0（量测前 / 空章）：返回仅含第 0 页的窗口（兼容缺页兜底占位）', () => {
    expect(computePageRenderWindow(0, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(computePageRenderWindow(5, 5, -1)).toEqual({ start: 0, end: 0 });
  });
});

describe('PageFlipPager 接线（源码结构断言，防止回退为整章全量渲染）', () => {
  const pagerSource = readSrc('components/reader/PageFlipPager.tsx');

  test('PageFlipPager 使用 computePageRenderWindow 计算窗口', () => {
    expect(pagerSource).toMatch(/import \{ computePageRenderWindow, PAGE_RENDER_WINDOW_MARGIN \} from '@\/utils\/readerPageWindow';/);
    expect(pagerSource).toMatch(
      /computePageRenderWindow\(index, settled, pageCount, PAGE_RENDER_WINDOW_MARGIN\)/,
    );
  });

  test('窗口外页渲染同尺寸空占位（宽度 / 分页保持不变），不做整章条件外全量渲染', () => {
    // 逐页 View 仍按 pageCount 全量产出（保持横向内容宽度与分页）
    expect(pagerSource).toMatch(/Array\.from\(\{ length: Math\.max\(1, pageCount\) \}\)\.map/);
    // 但页内容仅在窗口内渲染（窗口外 null 占位）
    expect(pagerSource).toMatch(
      /i >= renderWindow\.start && i <= renderWindow\.end \? renderPage\(i\) : null/,
    );
  });

  test('窗口计算在 useMemo 中（不随阴影 / 手势重渲染重复计算）', () => {
    expect(pagerSource).toMatch(/const renderWindow = useMemo\(/);
  });

  test('阴影 / 手势 / 落位逻辑未被窗口化改动回归（黑影 bug 修复保持原样）', () => {
    expect(pagerSource).toMatch(/const \[settled, setSettled\] = useState\(index\);/);
    expect(pagerSource).toMatch(/const baseX = useRef\(new Animated\.Value\(index \* pageWidth\)\)\.current;/);
    expect(pagerSource).toMatch(/onMomentumScrollEnd=\{handleMomentumScrollEnd\}/);
  });
});
