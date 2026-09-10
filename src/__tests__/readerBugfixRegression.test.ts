/**
 * 阅读器三个真机反馈 Bug 的回归防护测试（源码结构断言）
 * Bug 1：仿真翻页模式下，超出一屏的内容没有加载出来。
 *   根因：PageModeView 的 pageReady 是单向闩锁（只置 true 不置 false）。
 *   超高段拆分方案落地后 blocks.length < expectedBlockCount，但 pageReady
 *   仍为 true → 隐藏 sizer 被卸载，拆分块高度永远量不到 → 超高段内容从
 *   分页中彻底消失。
 * Bug 2：滚动模式向上加载生硬，且需要来回滚动才能触发加载上一章节。
 *   根因：①补偿基准用触发时的陈旧 baseOffset，触发→解析间用户继续滚动
 *   会被拽回触发点；②触发全部依赖滚动事件，停在 offset≈0（Android 顶部
 *   回弹不产生有效 onScroll / 续读打开在章首时 contentSize 兜底被
 *   pendingScroll 守卫挡掉）时永远触发不了。
 * Bug 3：仿真/滚动模式切换后不落在切换前的阅读位置。
 *   根因：scroll→page 的 locateSegmentId 只取路由参数；page→scroll 的
 *   pendingScroll 只在章节变化时武装，模式切换不武装 → 落回章首。
 * 本文件以源码断言锁定各修复点，防止后续改动回退。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const source = readSrc('screens/ReaderScreen.tsx');

describe('Bug 1：pageReady 必须双向门控且要求拆分决策收敛', () => {
  test('pageReady 以 ready 双向赋值（不再只置 true）', () => {
    expect(source).toMatch(/const ready =/);
    expect(source).toMatch(/setPageReady\(ready\);/);
    // 旧的单向闩锁写法必须移除
    expect(source).not.toMatch(/setPageReady\(true\)/);
  });

  test('出页条件包含 blocks.length === expectedBlockCount 与拆分收敛 splitSettled', () => {
    expect(source).toMatch(/blocks\.length === expectedBlockCount/);
    expect(source).toMatch(/splitSettled &&/);
  });

  test('splitSettled 要求「需要拆分 ⇔ 已有拆分方案」', () => {
    expect(source).toMatch(
      /return needsSplit \? !!plan : !plan;/,
    );
  });
});

describe('Bug 2：向前拼接的触发与补偿', () => {
  test('锚点补偿使用解析时刻的实际偏移（scrollOffset.current + y）', () => {
    // 陈旧的 anchor.baseOffset + y 会把用户拽回触发点
    expect(source).toMatch(/Math\.max\(0, scrollOffset\.current \+ y\)/);
    expect(source).not.toMatch(/anchor\.baseOffset \+ y/);
  });

  test('FlatList 挂载 onScrollEndDrag 触发（顶部回弹手势兜底）', () => {
    expect(source).toMatch(/onScrollEndDrag=\{handleScrollEndDrag\}/);
    expect(source).toMatch(/const handleScrollEndDrag = useCallback/);
  });

  test('定位落位贴近顶部时主动触发一次向前拼接（统一走 shouldAutoPrepend 判定）', () => {
    // 【4】切章防跳动：定位落位属程序化滚动（非手势窗口），正常不触发拼接；
    // 仅当用户恰在此刻手势滚动且朝顶部移动时才拼接
    // 【5】执行统一收敛到 requestAutoPrepend（手势进行中只记延迟意图）
    expect(source).toMatch(
      /if \(shouldAutoPrepend\(targetOffset\)\) \{\s*\n\s*requestAutoPrepend\(targetOffset\);/,
    );
  });

  test('onContentSizeChange 保留顶部主动拼接兜底（统一走 shouldAutoPrepend 判定）', () => {
    // 【4】同上：兜底保留，仅在用户手势窗口内且朝顶部方向时触发
    // 【5】执行统一收敛到 requestAutoPrepend（手势进行中只记延迟意图）
    expect(source).toMatch(
      /if \(h > 0 && shouldAutoPrepend\(scrollOffset\.current\)\) \{\s*\n\s*requestAutoPrepend\(scrollOffset\.current\);/,
    );
  });

  test('自动向前拼接统一判定：手势窗口 + 朝顶部方向（向下阅读永不触发）', () => {
    // shouldAutoPrepend：滚动模式 + 手势窗口 + 顶部预载窗口内 + 方向朝顶部/压顶
    expect(source).toMatch(/const shouldAutoPrepend = useCallback/);
    expect(source).toMatch(/readerMode !== 'scroll' \|\| !userScrollActiveRef\.current/);
    expect(source).toMatch(
      /offset > viewH\.current \* CONTIGUOUS_PRELOAD_SCREENS/,
    );
    expect(source).toMatch(
      /return offset <= 0 \|\| offset < lastScrollOffsetRef\.current;/,
    );
  });

  test('统一执行入口 requestAutoPrepend：手势进行中只记延迟意图不立即 prepend', () => {
    expect(source).toMatch(/const requestAutoPrepend = useCallback/);
    // 手指按住拖拽（dragActiveRef）或惯性滚动中（userScrollActiveRef）时
    // 置位 deferredPrependIntentRef，待手势完全结束后消费
    expect(source).toMatch(
      /if \(dragActiveRef\.current \|\| userScrollActiveRef\.current\) \{\s*\n\s*deferredPrependIntentRef\.current = true;/,
    );
  });

  test('手势窗口：beginDrag 开窗、momentumScrollEnd 关窗、endDrag 延时兜底关窗', () => {
    expect(source).toMatch(/onScrollBeginDrag=\{handleScrollBeginDrag\}/);
    expect(source).toMatch(/const handleScrollBeginDrag = useCallback/);
    expect(source).toMatch(/userScrollActiveRef\.current = true;/);
    expect(source).toMatch(/onMomentumScrollEnd=\{handleMomentumScrollEnd\}/);
    expect(source).toMatch(/const handleMomentumScrollEnd = useCallback/);
    expect(source).toMatch(/SCROLL_WINDOW_CLOSE_MS/);
  });

  test('连续快速切章防串扰：可见性回调只认当前拼接序列内的章', () => {
    // 事件异步派发可能携带切章前旧列表的行对象，不设防会把阅读位置写到错误章节
    expect(source).toMatch(/const continuousChapterIdsRef = useRef<Set<string>>\(new Set\(\)\);/);
    expect(source).toMatch(
      /if \(!continuousChapterIdsRef\.current\.has\(row\.chapterId\)\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
    // 拼接序列变更处同步维护章 id 集合（种子重置 / 追加 / 前拼 / 丢头共 4 处）
    expect(source).toMatch(/continuousChapterIdsRef\.current = new Set\(seeded\.map\(\(c\) => c\.id\)\);/);
    expect(
      (source.match(/continuousChapterIdsRef\.current = new Set\(merged\.map\(\(c\) => c\.id\)\);/g) ?? [])
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('切章残留清零：丢头补偿与视口锚点不跨章消费', () => {
    expect(source).toMatch(
      /headDropCompensation\.current = 0;\s*\n\s*layoutAnchor\.current = null;/,
    );
  });

  test('目录导航确定性：显式跳章清除残留 segmentId 参数并落章首', () => {
    // navigate 对既有路由浅合并参数：残留 segmentId 会让定位武装指向错误章的段落；
    // jumpSeq 每次跳转刷新——同章重复跳转（参数其余字段不变）也能触发重置 effect 落回章首
    expect(source).toMatch(
      /navigation\?\.navigate\('Reader', \{\s*\n\s*bookId,\s*\n\s*chapterId: cid,\s*\n\s*segmentId: undefined,\s*\n\s*jumpSeq: Date\.now\(\),\s*\n\s*\}\);/,
    );
    expect(source).toMatch(/const explicitChapterJumpRef = useRef\(false\);/);
    expect(source).toMatch(
      /if \(!segmentId && !explicitJump && restoreSegmentId\) \{\s*\n\s*armScrollLocate\(restoreSegmentId\);/,
    );
  });

  test('顶部章节名/目录高亮跟随实际阅读章（progressChapterId 口径）', () => {
    expect(source).toMatch(
      /const headerChapterId = readerMode === 'scroll' \? activeChapterId \?\? chapterId : chapterId;/,
    );
    expect(source).toMatch(/item\.id === progressChapterId && \{ backgroundColor: colors\.primarySoft \}/);
    expect(source).toMatch(/item\.id === progressChapterId \? colors\.primary : colors\.text/);
  });
});

describe('第四轮：贪心填充拆分 + 黑影自愈 + 预加载与触发可靠性', () => {
  const pagination = readSrc('utils/pagination.ts');
  const pager = readSrc('components/reader/PageFlipPager.tsx');

  test('超高段拆分按贪心填充：第一块吃满当前页剩余空间（firstBudget）', () => {
    // 均分码点的旧实现已被替换；split 决策须用 paginateBlocks 反查所在页已用高度
    expect(pagination).toMatch(
      /firstBudget: number = pageBudget,/,
    );
    expect(pagination).toMatch(/const take = Math\.max\(1, Math\.floor\(budget \/ perChar\)\);/);
    expect(source).toMatch(
      /const firstBudget = Math\.max\(0, pageBudget - \(usedBefore\.get\(s\.id\) \?\? 0\)\);/,
    );
  });

  test('二轮再切带容差（CHUNK_RESPLIT_TOLERANCE），避免碎页震荡', () => {
    expect(source).toMatch(/const CHUNK_RESPLIT_TOLERANCE = 12;/);
    expect(source).toMatch(/chunkH > pageBudget \+ CHUNK_RESPLIT_TOLERANCE/);
  });

  test('翻页阴影不再用 diffClamp（瞬时失步不再锁存为常驻黑影）', () => {
    expect(pager).not.toMatch(/Animated\.diffClamp/);
    expect(pager).toMatch(/extrapolate: 'clamp',/);
  });

  test('页数变化后强制重对齐物理落位（防止 scrollX 与 settled 失步）', () => {
    expect(pager).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*if \(pageCount <= 0\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*const clamped = Math\.max\(0, Math\.min\(lastIndex\.current, pageCount - 1\)\);/,
    );
  });

  test('prepend 入口先做锚点超时清理（停在顶部无滚动事件也能解除残留锚点）', () => {
    expect(source).toMatch(
      /const prependPreviousChapter = useCallback\(\(\) => \{\s*\n\s*\/\/ 入口先做锚点超时清理[\s\S]*?expireAnchorIfNeeded\(\);/,
    );
  });

  test('onContentSizeChange 有 contentSize 增量兜底补偿（锚点行移出渲染窗口时）', () => {
    expect(source).toMatch(/const delta = h - contentH\.current;/);
    expect(source).toMatch(/offset: Math\.max\(0, scrollOffset\.current \+ delta\),/);
  });

  test('上下章预加载窗口为 2 屏（CONTIGUOUS_PRELOAD_SCREENS）', () => {
    expect(source).toMatch(/const CONTIGUOUS_PRELOAD_SCREENS = 2;/);
    // 预载窗口口径统一：滚动判定与自动拼接判定均以 2 屏为阈值
    expect(source).toMatch(/viewH\.current \* CONTIGUOUS_PRELOAD_SCREENS/);
    expect(source).toMatch(/onStartReachedThreshold=\{CONTIGUOUS_PRELOAD_SCREENS\}/);
    expect(source).toMatch(/onEndReachedThreshold=\{CONTIGUOUS_PRELOAD_SCREENS\}/);
  });
});

describe('第五轮：跳章后立即上滑防跳章（章首驻留期 + 手势结束后置补偿）', () => {
  test('显式跳章进入章首驻留期：切章 effect 消费 explicitChapterJumpRef 时置位', () => {
    expect(source).toMatch(
      /const chapterHeadDwellRef = useRef<\{ chapterId: string \} \| null>\(null\);/,
    );
    expect(source).toMatch(
      /chapterHeadDwellRef\.current =\s*\n\s*explicitJump && chapterId \? \{ chapterId \} : null;/,
    );
  });

  test('驻留期内 shouldAutoPrepend 拦截 offset > 0 的手势拼接（保留 offset ≤ 0 回弹路径）', () => {
    // 驻留判定在方向判定之前：仅拦截「未压顶/回弹」的手势滚动，
    // 章首回弹（offset ≤ 0，endDrag 放行）的读上一章入口不受影响
    expect(source).toMatch(
      /const dwell = chapterHeadDwellRef\.current;\s*\n\s*if \(dwell && offset > 0 && dwell\.chapterId === activeChapterIdRef\.current\) \{\s*\n\s*return false;\s*\n\s*\}\s*\n\s*return offset <= 0 \|\| offset < lastScrollOffsetRef\.current;/,
    );
  });

  test('驻留期解除：读出超过 CHAPTER_HEAD_DWELL_SCREENS 屏高或当前章已前移', () => {
    expect(source).toMatch(/const CHAPTER_HEAD_DWELL_SCREENS = 0\.5;/);
    expect(source).toMatch(
      /\(viewH\.current > 0 && offset > viewH\.current \* CHAPTER_HEAD_DWELL_SCREENS\) \|\|\s*\n\s*dwell\.chapterId !== activeChapterIdRef\.current/,
    );
    expect(source).toMatch(/chapterHeadDwellRef\.current = null;/);
  });

  test('endDrag offset ≤ 0 路径只记延迟意图，不在拖拽刚结束时刻立即 prepend', () => {
    // endDrag ≠ 手势完全结束（惯性可能随后进行）：补偿 scrollTo 必须等
    // onMomentumScrollEnd / 关窗计时器确认原生滚动停止后执行（原子性）
    expect(source).toMatch(
      /const allow = shouldAutoPrepend\(offset\);\s*\n\s*dragActiveRef\.current = false;[\s\S]*?if \(allow\) \{\s*\n\s*\/\/ 【5】延迟到手势完全结束后消费[\s\S]*?deferredPrependIntentRef\.current = true;\s*\n\s*\}/,
    );
    // endDrag 的直接 prepend 调用必须移除（改经 consumeDeferredPrepend）
    const endDragBody = source.match(
      /const handleScrollEndDrag = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
    );
    expect(endDragBody).toBeTruthy();
    expect(endDragBody![0]).not.toMatch(/prependPreviousChapter\(\);/);
  });

  test('延迟意图的两个统一消费出口：onMomentumScrollEnd 与 endDrag 关窗计时器', () => {
    expect(source).toMatch(/const consumeDeferredPrepend = useCallback/);
    // 惯性结束 + 无惯性关窗兜底两处都要消费（各自原生滚动已停止）
    expect(
      (source.match(/consumeDeferredPrepend\(\);/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    // 消费前重新校验位置（预载窗口内）与方向（朝顶部/压顶），意图过期即丢弃
    expect(source).toMatch(
      /if \(offset > viewH\.current \* CONTIGUOUS_PRELOAD_SCREENS\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*\/\/ 方向校验[\s\S]*?if \(!\(offset <= 0 \|\| offset < lastScrollOffsetRef\.current\)\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*prependPreviousChapter\(\);/,
    );
  });

  test('拖拽开/关标记 dragActiveRef 与手势窗口生命周期同步', () => {
    expect(source).toMatch(/const dragActiveRef = useRef\(false\);/);
    expect(source).toMatch(
      /const handleScrollBeginDrag = useCallback\(\(\) => \{\s*\n\s*userScrollActiveRef\.current = true;\s*\n\s*dragActiveRef\.current = true;/,
    );
  });

  test('补偿单一源：补偿 scrollTo 仅存在于 prependAnchor 守卫的两处消费点', () => {
    // handleRowLayout 锚点行路径 + onContentSizeChange 增量兜底路径，
    // 均以 prependAnchor 非空为前提且消费后立即置空（一次 prepend 至多一处补偿）
    expect(source).toMatch(
      /const anchor = prependAnchor\.current;\s*\n\s*if \(anchor != null && rowId === anchor\.firstRowId && y > 0\) \{/,
    );
    expect(source).toMatch(
      /const anchorNow = prependAnchor\.current;\s*\n\s*if \(anchorNow\) \{/,
    );
    // 锚点置空点：种子重置 / 丢头放弃 / 行布局消费 / contentSize 兜底消费 ≥ 4 处
    expect(
      (source.match(/prependAnchor\.current = null;/g) ?? []).length,
    ).toBeGreaterThanOrEqual(4);
  });

  test('切章/换模式残留清零：延迟意图与驻留期不得跨章消费', () => {
    // 模式切换 effect（列表重挂载）清空手势窗口 + 延迟意图 + 驻留期
    expect(source).toMatch(
      /userScrollActiveRef\.current = false;\s*\n\s*dragActiveRef\.current = false;\s*\n\s*deferredPrependIntentRef\.current = false;\s*\n\s*chapterHeadDwellRef\.current = null;/,
    );
    // 拼接种子重置 effect 清空延迟意图（旧手势周期不得消费到新章列表）
    expect(source).toMatch(
      /\/\/ 【5】清空延迟拼接意图：旧手势周期的意图不得消费到新章的列表上\s*\n\s*deferredPrependIntentRef\.current = false;/,
    );
  });
});

describe('Bug 3：模式切换后定位到当前阅读位置', () => {
  test('滚动/翻页模式均以 useReaderStore 的当前段为切换定位目标', () => {
    expect(source).toMatch(
      /const seg = useReaderStore\.getState\(\)\.segmentId;/,
    );
    expect(source).toMatch(
      /pendingScroll\.current = \{ target, done: false \};/,
    );
    expect(source).toMatch(/setLocateTarget\(seg \?\? null\);/);
  });

  test('翻页模式定位目标走 locateTarget 状态（不再直接用路由参数）', () => {
    expect(source).toMatch(/locateSegmentId=\{locateTarget\}/);
    expect(source).not.toMatch(/locateSegmentId=\{segmentId\}/);
  });

  test('模式切换定位有超时放弃兜底（防止 pendingScroll 守卫卡死向前拼接）', () => {
    // 8000：真机水合(~0.6s)+首屏布局(~2.3s) 超过旧值 1500，定位在布局完成前
    // 就被超时放弃——续读恢复失败根因之一（r24 放宽，见 LOCATE_TIMEOUT_MS 注释）
    expect(source).toMatch(/const LOCATE_TIMEOUT_MS = 8000;/);
    expect(source).toMatch(/if \(!pendingScroll\.current\.done\) \{\s*\n\s*pendingScroll\.current\.done = true;/);
  });
});

describe('Bug 3 边界：模式切换跨章跟随定位', () => {
  test('模式切换前检测当前段所属章，跨章则携带 segmentId 导航到该章', () => {
    expect(source).toMatch(
      /const segChapter = seg \? segmentChapterMap\.get\(seg\) : undefined;/,
    );
    expect(source).toMatch(
      /navigation\?\.navigate\('Reader', \{ bookId, chapterId: segChapter, segmentId: seg \}\);/,
    );
  });

  test('跨章跟随走既有「切章 effect → 定位武装」链路（armScrollLocate 统一武装）', () => {
    // 模式切换滚动分支与切章 effect 都必须经由 armScrollLocate 武装，
    // 保证跨章导航后定位仍被重新武装且超时计时器始终对应最新目标
    expect(source).toMatch(/const armScrollLocate = useCallback/);
    expect(source).toMatch(/armScrollLocate\(segmentId \?\? ''\);/);
    expect(source).toMatch(/armScrollLocate\(seg \?\? ''\);/);
  });

  test('切章 effect 依赖含 armScrollLocate 与 jumpSeq（不再直接写 pendingScroll；同章重跳可复位）', () => {
    expect(source).toMatch(
      /\}, \[chapterId, segmentId, jumpSeq, listRef, rowOffsets, armScrollLocate\]\);/,
    );
  });
});

describe('跳章后连滚多章 / 下拉一次翻多章回归防护（attempt 零进展重试 + 锚点补偿防污染）', () => {
  test('attempt 重试条件必须是「零进展」而非「上一章未就位」', () => {
    // 「上一章未就位就重试」恒真（预取只拼一章，新首章的上一章天然未加载）
    // → 空转重试把一轮预取放大成 4 轮 append+prepend，叠补偿失准即连滚多章
    expect(source).toMatch(/const progressed =/);
    expect(source).toMatch(/if \(!progressed && tries < MAX_TRIES\) \{/);
    expect(source).not.toMatch(/const hasPrevToLoad =/);
  });

  test('append 成功必须记录 lastAppendAtRef（锚点增量兜底防污染依据）', () => {
    expect(source).toMatch(/const lastAppendAtRef = useRef\(0\);/);
    expect(source).toMatch(/lastAppendAtRef\.current = Date\.now\(\);/);
  });

  test('onContentSizeChange 锚点兜底：精确 y 路径优先 + append 同 tick 污染门控', () => {
    // 同 tick 的 append+prepend 渲染合并，contentSize 增量 = 两者之和，
    // 直接拿增量补偿会把视口向前多甩一个 append 章的高度（连滚多章根因）
    expect(source).toMatch(/const newY = rowOffsets\.current\.get\(anchorNow\.firstRowId\);/);
    expect(source).toMatch(
      /anchorNow\.createdAt - lastAppendAtRef\.current >\s*\n?\s*APPEND_COALESCE_MS/,
    );
    expect(source).toMatch(/const APPEND_COALESCE_MS = 100;/);
  });
});
