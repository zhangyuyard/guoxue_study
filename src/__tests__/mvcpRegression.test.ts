/**
 * P1 方案（maintainVisibleContentPosition 原生视口保持）回归防护测试（源码结构断言）
 *
 * 背景（docs/paging-implementation-evaluation.md）：滚动模式「头部插入上一章 /
 * 滑动窗口丢头」的滚动偏移保持，原为约 300 行手写补偿链路（prependAnchor 登记 →
 * handleRowLayout / onContentSizeChange 双消费点、headDropCompensation 写入消费），
 * 已先后爆出 3 起补偿竞态 Bug（跳章 / 连滚多章）。RN 0.72 起 Android 支持
 * maintainVisibleContentPosition——原生层在子视图因数据插入/移除整体位移时
 * 自动调整 offset，等价于整条手写链路的效果且无增量归因类竞态。
 *
 * 本文件锁定 P1 灰度结构：
 * 1. FlatList 必须挂 maintainVisibleContentPosition（由 MVCP_ENABLED 门控）；
 * 2. MVCP_CONFIG 保持第一个可见行稳定，且【不得】设置 autoscrollToTopThreshold
 *    （拼接上一章后视口应停留在用户正在阅读的内容上，由用户继续上滑进入新内容，
 *    自动跳顶会把视口甩到新章开头——非阅读器预期）；
 * 3. MVCP 开启时手写补偿不得再登记（锚点 / 丢头补偿写入必须由 !MVCP_ENABLED
 *    守卫）——否则原生调整 + 手写 scrollTo 双重补偿，视口前甩一个插入高度；
 * 4. 手写补偿链路代码必须保留（回退路径）：真机异常时改 MVCP_ENABLED=false
 *    一行整体回退，不允许删除链路代码。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', 'screens', 'ReaderScreen.tsx'), 'utf-8');

describe('P1 灰度：maintainVisibleContentPosition 原生视口保持', () => {
  test('灰度开关与配置：MVCP_ENABLED=true + minIndexForVisible:0', () => {
    expect(source).toMatch(/const MVCP_ENABLED = true;/);
    expect(source).toMatch(
      /const MVCP_CONFIG = \{ minIndexForVisible: 0 \} as const;/,
    );
  });

  test('FlatList 挂载 MVCP prop，且由 MVCP_ENABLED 门控', () => {
    expect(source).toMatch(
      /maintainVisibleContentPosition=\{MVCP_ENABLED \? MVCP_CONFIG : undefined\}/,
    );
  });

  test('MVCP_CONFIG 不得设置 autoscrollToTopThreshold（不自动跳到新章）', () => {
    // 仅匹配实际属性赋值（注释中的文字说明不构成配置）
    expect(source).not.toMatch(/autoscrollToTopThreshold\s*:/);
  });

  test('锚点登记必须由 !MVCP_ENABLED 守卫（防双重补偿）', () => {
    // prependPreviousChapter 中的登记块
    expect(source).toMatch(
      /if \(!MVCP_ENABLED\) \{\s*\n\s*\/\/ 手写补偿路径（MVCP_ENABLED=false 的回退路径）[\s\S]*?prependAnchor\.current = \{/,
    );
  });

  test('丢头补偿写入必须由 !MVCP_ENABLED 守卫（防双重补偿）', () => {
    expect(source).toMatch(
      /if \(!MVCP_ENABLED\) \{\s*\n\s*\/\/ 手写补偿路径（回退用）[\s\S]*?headDropCompensation\.current = keptY - droppedY;/,
    );
  });

  test('手写补偿链路必须保留作为回退路径（不允许删除）', () => {
    // 双消费点 + 超时兜底 + 增量污染门控，全部保留
    expect(source).toMatch(/const prependAnchor = useRef</);
    expect(source).toMatch(/const APPEND_COALESCE_MS = 100;/);
    expect(source).toMatch(/const ANCHOR_TIMEOUT_MS = 2000;/);
    expect(source).toMatch(/const headDropCompensation = useRef\(0\);/);
    expect(source).toMatch(/rowId === anchor\.firstRowId && y > 0/);
  });
});
