/**
 * 仿真翻页（PageFlipPager）窗口化渲染的页区间计算（纯函数，供 jest 单测）。
 *
 * 背景（问题 3：仿真翻页模式 loading 极久）：PageFlipPager 旧实现一次性同步
 * 渲染整章所有页，每页都是全量 PinyinText（逐字注音，渲染成本高）——大书单章
 * 2 万+ 字可分出数百页，挂载瞬间把 JS 线程压死，表现为「仿真翻页模式 loading
 * 极久、翻页按钮极慢」。
 *
 * 修复策略：窗口化渲染——只全量渲染「当前页附近窗口」内的页（受控 index 与
 * 落位 settled 的并集前后各 margin 页），窗口外的页渲染同尺寸空占位 View，
 * 保持横向 ScrollView 的内容宽度 / 分页 / 手势吸附完全不变。窗口随 settled
 * 滑动：翻一页只新增 1~2 页的挂载，用户不可感知；滑出窗口的页自然卸载。
 *
 * 取 index 与 settled 的并集原因：点击翻页时受控 index 立即变为目标页、而
 * settled（物理落位页）要到落位才更新，两者短暂不同页——并集保证「正在滚向
 * 的目标页」与「正在离开的原页」始终都在窗口内，滑动过程中不会出现空白页。
 */

/** 窗口边距（当前页前后各保留的实渲染页数）：翻一页至多新增 1 页挂载 */
export const PAGE_RENDER_WINDOW_MARGIN = 2;

/** 窗口区间（闭区间 [start, end]；start > end 表示空窗口，正常不会出现） */
export interface PageRenderWindow {
  /** 窗口起始页（含），已钳制到 [0, pageCount - 1] */
  start: number;
  /** 窗口结束页（含），已钳制到 [0, pageCount - 1] */
  end: number;
}

/**
 * 计算窗口化渲染的页区间。
 * @param index 受控当前页索引（目标页，可能是点击翻页后尚未落位的页）
 * @param settled 已落位页索引（横向 ScrollView 物理正停在的页）
 * @param pageCount 总页数（≤0 视为无有效页）
 * @param margin 窗口边距（前后各 margin 页），缺省 PAGE_RENDER_WINDOW_MARGIN
 * @returns 闭区间窗口；pageCount <= 0 时返回仅含第 0 页的窗口，
 *          兼容 renderPage(0) 的「缺页兜底占位」路径（重分页过渡帧的兜底页）。
 */
export function computePageRenderWindow(
  index: number,
  settled: number,
  pageCount: number,
  margin: number = PAGE_RENDER_WINDOW_MARGIN,
): PageRenderWindow {
  // 无有效页（量测前 / 空章）：给仅含第 0 页的窗口，让 renderPage(0) 走缺页兜底
  if (pageCount <= 0) {
    return { start: 0, end: 0 };
  }
  // 先各自钳制到有效区间（重分页收缩页数的过渡帧两者可能暂时越界）
  const clampedIndex = Math.max(0, Math.min(index, pageCount - 1));
  const clampedSettled = Math.max(0, Math.min(settled, pageCount - 1));
  // 窗口基准：
  // - |index - settled| ≤ margin + 1（正常翻页过渡，逐页至多差 1）→ 取并集，
  //   保证「滚向的目标页」与「离开的原页」滑动过程中都在窗口内、不空白；
  // - 差距更大（定位 / 跨章跳页帧）→ 只以 settled 为基准：此刻物理滚动仍停在
  //   settled，渲染窗口跟着物理位置走是正确的；若按并集渲染会把「起跳页到
  //   目标页」之间的所有页一帧内全部挂载（长距离跳页瞬间卡顿），而目标页要
  //   等外部 index effect 的 setSettled 同步后窗口自然移过去，无需预渲染。
  const nearFlip = Math.abs(clampedIndex - clampedSettled) <= margin + 1;
  const lo = nearFlip ? Math.min(clampedIndex, clampedSettled) : clampedSettled;
  const hi = nearFlip ? Math.max(clampedIndex, clampedSettled) : clampedSettled;
  return {
    start: Math.max(0, lo - margin),
    end: Math.min(pageCount - 1, hi + margin),
  };
}
