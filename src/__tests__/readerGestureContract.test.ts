/**
 * 阅读页手势与目录接线契约（源码文本即断言）—— 2026-10-08 用户裁定三条：
 *
 *   ① 滚动翻页模式下**取消点击翻页**；
 *   ② 查字典**不再由点击触发，改由长按**（长按 → 动作菜单）；
 *   ③ 顶栏**点章节名 → 目录弹层 → 点章名跳章**。
 *
 * 为什么必须用源码文本断言：三条都是「删掉一段接线」或「接错回调」型改动——
 * 编译器不报错、既有用例不红灯（本批实测：改动后 98 套 1270 例**全绿**，
 * 即旧行为当时**零检测力**）。只有把「哪个 prop 挂在哪个回调上」写死才锁得住。
 *
 * 不变量（阴性对照集中处）：
 * - 滚动模式不得再出现列表级 touch 处理器与分区判定 API；
 * - 未划线字的点按出口 `onPressChar` 不得再被传入（否则「点」重新带上动作语义）；
 * - 目录行高必须与 `reader/toc.TOC_ROW_H` 同源（各写一份 ⇒ 打开目录停不到当前章）。
 *
 * 变异判据（2026-10-08 我实测；红数 = 失败**用例**数，非断言数）：
 * - M1 `ScrollMode` 加回 `onTouchEnd={onScroll}`（复原点按翻屏的承载面）⇒ **1 红**
 * - M2 `ReaderScreen` 加回 `onPressChar={() => undefined}`（点按重新带动作语义）⇒ **1 红**
 * - M3 `ChapterTocSheet` 删掉 `initialScrollIndex={initialIndex}` ⇒ **2 红**
 * - M4 `offset: TOC_ROW_H * index` 内联成 `offset: 52 * index`（行高不再同源）⇒ **1 红**
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
const SCROLL_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/ScrollMode.tsx');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');
const TOC_SHEET_PATH = resolve(APP_ROOT, 'components/reader/ChapterTocSheet.tsx');
const CHAR_MENU_PATH = resolve(APP_ROOT, 'components/reader/CharActionMenu.tsx');

const scrollSrc = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));
const screenSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
const sheetSrc = stripComments(readFileSync(TOC_SHEET_PATH, 'utf8'));
const menuSrc = stripComments(readFileSync(CHAR_MENU_PATH, 'utf8'));

/** 同范围正对照：证明「0 计数」不是「文件没读到 / 关键词打偏」造出来的假 0 */
function assertSourcesLoaded(): void {
  expect(scrollSrc.length).toBeGreaterThan(1000);
  expect(screenSrc.length).toBeGreaterThan(1000);
  expect(countOf(scrollSrc, 'const fireBoundary = useCallback(')).toBe(1);
  expect(countOf(screenSrc, 'const handleLongPressChar = useCallback(')).toBe(1);
}

describe('① 滚动模式：点击不再翻屏', () => {
  it('列表级 touch 处理器与分区判定 API 全部绝迹', () => {
    // 旧实现三个部件：列表 touchEnd 补判 / 行内 press 回问 / 去重窗
    expect(countOf(scrollSrc, 'onTouchStart')).toBe(0);
    expect(countOf(scrollSrc, 'onTouchEnd')).toBe(0);
    expect(countOf(scrollSrc, 'onTouchCancel')).toBe(0);
    expect(countOf(scrollSrc, 'charTapIntercept')).toBe(0);
    expect(countOf(scrollSrc, 'resolveTapRegion')).toBe(0);
    expect(countOf(scrollSrc, 'isTapGesture')).toBe(0);
    expect(countOf(scrollSrc, 'TAP_SLOP')).toBe(0);
    expect(countOf(scrollSrc, 'PRESS_CONSUMED_DEDUP_MS')).toBe(0);
    // 翻屏是唯一带 `animated: true` 的滚动调用 ⇒ 它消失即「无点按翻屏」
    expect(countOf(scrollSrc, 'animated: true')).toBe(0);
  });

  it('滚动本身仍在（阴性对照：上面不是「把文件删空」换来的 0）', () => {
    expect(countOf(scrollSrc, 'const handleScroll = useCallback(')).toBe(1);
    expect(countOf(scrollSrc, 'const onScroll = useCallback(')).toBe(1);
    expect(countOf(scrollSrc, 'onScroll={onScroll}')).toBe(1);
    // 两个 scrollToOffset：数据位移补偿 + onScrollToIndexFailed 兜底（均非翻屏）
    expect(countOf(scrollSrc, 'scrollToOffset')).toBe(2);
    expect(countOf(scrollSrc, 'onScrollToIndexFailed')).toBe(1);
  });

  it('ReaderScreen：分区问询 ref 与左右 30% 热区样式一并清除', () => {
    expect(countOf(screenSrc, 'charTapIntercept')).toBe(0);
    expect(countOf(screenSrc, 'tapZoneL')).toBe(0);
    expect(countOf(screenSrc, 'tapZoneR')).toBe(0);
    // 同范围正对照：三种模式仍在传版心（证明 screenSrc 读到的就是当前文件）
    expect(countOf(screenSrc, 'contentInsets: { left: content.left, right: content.right },')).toBe(3);
  });

  it('ScrollMode 不再接收分区问询出口（省一次 effect 挂载）', () => {
    expect(countOf(screenSrc, 'charTapIntercept: charTapInterceptRef,')).toBe(0);
    expect(countOf(scrollSrc, 'charTapIntercept?: { current:')).toBe(0);
  });
});

describe('② 查字典改由长按触发（点击一律无动作）', () => {
  it('未划线字的点按出口 onPressChar 不再被传入', () => {
    expect(countOf(screenSrc, 'onPressChar=')).toBe(0);
    // 旧链路整体删除（点按查字 + 分区问询）
    expect(countOf(screenSrc, 'handlePressChar')).toBe(0);
    // 同范围正对照：另外两个行内出口仍在 ⇒ 证明上两行的 0 不是「整块删掉」
    expect(countOf(screenSrc, 'onLongPressChar={handleLongPressChar(seg, item.chapterId)}')).toBe(1);
    expect(countOf(screenSrc, 'onPressHighlight={handleViewHighlight}')).toBe(1);
  });

  it('点按仍有唯一保留语义：点已划线字 → 查看/编辑面板', () => {
    expect(countOf(screenSrc, 'const handleViewHighlight = useCallback((h: Highlight)')).toBe(1);
  });

  it('查字导航收敛到菜单单一入口', () => {
    // 全文件只剩 1 处 navigate('DictLookup'，且落在菜单回调里
    expect(countOf(screenSrc, "navigate('DictLookup'")).toBe(1);
    expect(countOf(screenSrc, 'const handleCharMenuLookup = useCallback(')).toBe(1);
  });

  it('长按成为唯一入口：动作菜单接线 + 三动作在场', () => {
    expect(countOf(screenSrc, 'handleLongPressChar')).toBeGreaterThanOrEqual(3);
    expect(countOf(screenSrc, 'setCharMenu({')).toBe(1);
    expect(countOf(screenSrc, '<CharActionMenu')).toBe(1);
    expect(countOf(screenSrc, 'visible={charMenu !== null}')).toBe(1);
    expect(countOf(screenSrc, 'onLookup={handleCharMenuLookup}')).toBe(1);
    expect(countOf(screenSrc, 'onHighlight={handleCharMenuHighlight}')).toBe(1);
    // 菜单侧三动作（缺任一 ⇒ 该动作失去入口且不红灯）
    expect(countOf(menuSrc, 'accessibilityLabel="查字典"')).toBe(1);
    expect(countOf(menuSrc, 'accessibilityLabel="划线本段"')).toBe(1);
    expect(countOf(menuSrc, 'accessibilityLabel={speaking ? \'停止朗读\' : \'朗读本段\'}')).toBe(1);
  });

  it('★ 否定对照：旧的「长按直开划线面板」形态不得回潮', () => {
    // 旧形态（长按 → 直接 setHighlightSheet）会让长按仍是「划线段」，菜单收不到入口
    expect(
      countOf(screenSrc, "setHighlightSheet({ mode: 'create', chapterId, segmentId: seg.id, text: seg.text })"),
    ).toBe(0);
    // 新形态：划线改由菜单回调触发，且段信息取自 charMenu
    // （★ 用单行可命中的锚点：「setHighlightSheet({」与字段名被 prettier 折行，
    //   拼成一行的 needle 会**假 0**——本断言首版就踩过，见 §④ 的正对照纪律）
    expect(countOf(screenSrc, 'text: charMenu.text,')).toBe(1);
    expect(countOf(screenSrc, 'setCharMenu({')).toBe(1);
  });
});

describe('③ 顶栏点章节名 → 目录 → 点章名跳章', () => {
  it('顶栏章节名可点，且唤起目录', () => {
    expect(countOf(screenSrc, 'const openToc = useCallback(')).toBe(1);
    expect(countOf(screenSrc, 'onPress={openToc}')).toBe(1);
    expect(countOf(screenSrc, 'accessibilityLabel={`打开目录：')).toBe(1);
  });

  it('目录数据源＝书体章列表（不依赖当前滑动窗口）', () => {
    expect(countOf(screenSrc, 'TextLibraryService.getBook(bookId)')).toBe(1);
    expect(countOf(screenSrc, 'buildTocItems(res.data.chapters)')).toBe(1);
  });

  it('弹层成套接线（可见性 / 当前章 / 跳章 / 高度）', () => {
    expect(countOf(screenSrc, '<ChapterTocSheet')).toBe(1);
    expect(countOf(screenSrc, 'visible={tocVisible}')).toBe(1);
    expect(countOf(screenSrc, 'currentChapterId={activeChapterId}')).toBe(1);
    expect(countOf(screenSrc, 'onSelect={handleTocSelect}')).toBe(1);
    expect(countOf(screenSrc, 'height={tocHeight}')).toBe(1);
  });

  it('★ 点章名复用 jumpTo（不另造一套切章路径）', () => {
    // 唯一一处 `jumpTo(cid);` ＝ handleTocSelect 内；周围两处按钮用 siblings.*.id
    expect(countOf(screenSrc, 'jumpTo(cid);')).toBe(1);
    expect(countOf(screenSrc, 'const handleTocSelect = useCallback(')).toBe(1);
  });

  it('打开目录即定位到当前章（initialScrollIndex + 纯逻辑同源）', () => {
    expect(countOf(sheetSrc, 'tocInitialIndex(')).toBe(1);
    expect(countOf(sheetSrc, 'initialScrollIndex={initialIndex}')).toBe(1);
  });

  it('★ 行高与渲染层同源（各写一份 ⇒ 打开目录停不到当前章，不报错不红灯）', () => {
    // getItemLayout 的 offset 与条目真实高度必须同源
    expect(countOf(sheetSrc, 'offset: TOC_ROW_H * index')).toBe(1);
    expect(countOf(sheetSrc, 'height: TOC_ROW_H')).toBe(1);
    // 不得内联魔数行高
    expect(countOf(sheetSrc, 'height: 52')).toBe(0);
    expect(countOf(sheetSrc, 'offset: 52')).toBe(0);
  });

  it('★ 列表只在 visible 时挂载（initialScrollIndex 仅挂载时生效 ⇒ 第二次打开仍定位当前章）', () => {
    const guard = sheetSrc.indexOf('visible ? (');
    const list = sheetSrc.indexOf('<FlatList');
    expect(guard).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(list);
    expect(countOf(sheetSrc, 'visible ? (')).toBe(1);
  });

  it('★ 否定对照：目录不得自己再数一份行高 / 不得常驻挂载列表', () => {
    // 同范围正对照：TOC_ROW_H 在场 ⇒ 计数工具有效
    expect(countOf(sheetSrc, 'TOC_ROW_H')).toBeGreaterThanOrEqual(3);
    // 常驻挂载（不条件渲染）会让第二次打开目录停在上次位置
    expect(countOf(sheetSrc, 'initialScrollIndex={initialIndex}')).toBe(1);
    expect(countOf(sheetSrc, 'data={items as TocItem[]}')).toBe(1);
  });
});

describe('④ 同范围正对照总表（防「假 0」）', () => {
  it('三个源文件均含各自的特征常量 ⇒ 上面的 0 是真 0', () => {
    assertSourcesLoaded();
    expect(countOf(scrollSrc, 'BOUNDARY_HINT_H')).toBeGreaterThan(0);
    expect(countOf(screenSrc, 'SCROLL_WINDOW_KEEP_SCREENS')).toBeGreaterThan(0);
    expect(countOf(sheetSrc, 'TOC_ROW_H')).toBeGreaterThan(0);
    expect(countOf(menuSrc, 'MENU_HEIGHT')).toBeGreaterThan(0);
  });
});
