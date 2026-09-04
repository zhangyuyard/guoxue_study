/**
 * 道德经滚动模式「停在第一章无法滚动 + 切章闪烁」回归防护测试（源码结构断言）
 *
 * 现象：打开《道德经》后滚动模式无法滚动、停在第一章；手动点「下一章」
 *   会先闪现第一章再落到第二章，之后滚动才恢复。
 *
 * 根因①（死锁主因）：内置经典每章仅一段几十字，打开章的内容不足一屏 →
 *   FlatList 无可滚动区间，物理上产生不了 onScroll；RN 的 onEndReached 在
 *   内容不满一屏时不触发（Android 长期已知问题）、追加后仍不满一屏时也不
 *   重触发。「追加下一章」的两个既有触发点（onScroll / onEndReached）全部
 *   依赖「先能滚动」→ 永远停在第一章。向前拼接早有 onContentSizeChange
 *   顶部兜底，向后追加没有对称兜底。
 * 修复①：新增 fillShortContentIfNeeded——由 FlatList onContentSizeChange 与
 *   onLayout 两个不依赖滚动事件的时机调用，口径与 onScroll 统一收敛到
 *   utils/readerScroll 的 isWithinPreloadWindow，追加引发 contentSize 变化
 *   后级联补齐，收敛于窗口填满或没有下一章。
 *
 * 根因②（闪烁）：书籍/章节由 init effect 异步 setState 加载——路由切章后
 *   参数已变而章节状态仍是旧章，当帧先渲染第一章、effect 落地才换新章。
 *   getBook/getChapter 本为同步内存索引，无需异步。
 * 修复②：book/chapter/loadError 改为随路由参数同步派生（useMemo）；
 *   effectiveChapters 在「路由章 ∉ 已拼接序列」的切章过渡帧以路由章单独
 *   成列，渲染当帧即得新章内容，消除旧章闪现。
 *
 * 本文件以源码断言锁定各修复点，防止后续改动回退。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const source = readSrc('screens/ReaderScreen.tsx');
const scrollUtil = readSrc('utils/readerScroll.ts');

describe('修复①：向后追加的短内容兜底（fillShortContentIfNeeded）', () => {
  test('存在 fillShortContentIfNeeded，且超预载窗口时调用 appendNextChapter', () => {
    expect(source).toMatch(/const fillShortContentIfNeeded = useCallback/);
    expect(source).toMatch(
      /isWithinPreloadWindow\(\s*contentH\.current,\s*viewH\.current,\s*scrollOffset\.current,\s*CONTIGUOUS_PRELOAD_SCREENS,\s*\)\s*\)\s*\{\s*\n\s*appendNextChapter\(\);/,
    );
  });

  test('onContentSizeChange 在更新 contentH 后调用兜底（不依赖滚动事件的触发点）', () => {
    expect(source).toMatch(
      /contentH\.current = h;\s*\n\s*\/\/ 短内容兜底[\s\S]*?fillShortContentIfNeeded\(\);/,
    );
  });

  test('FlatList onLayout 量出视口高后调用兜底（防 contentSize 事件早于 onLayout 被守卫跳过）', () => {
    expect(source).toMatch(
      /viewH\.current = e\.nativeEvent\.layout\.height;\s*\n[\s\S]*?fillShortContentIfNeeded\(\);\s*\n\s*\}\}/,
    );
  });

  test('仅滚动模式生效（readerMode !== scroll 直接返回，不影响翻页模式）', () => {
    expect(source).toMatch(
      /const fillShortContentIfNeeded = useCallback\(\(\) => \{\s*\n\s*if \(readerMode !== 'scroll'\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
  });

  test('onScroll 追加口径与兜底统一走 isWithinPreloadWindow（口径不漂移）', () => {
    expect(source).toMatch(
      /if \(isWithinPreloadWindow\(contentHeight, viewHeight, offset, CONTIGUOUS_PRELOAD_SCREENS\)\) \{\s*\n\s*appendNextChapter\(\);/,
    );
    // 旧的散写口径表达式必须移除（防止两处口径各改各的）
    expect(source).not.toMatch(
      /contentHeight - viewHeight - offset < viewHeight \* CONTIGUOUS_PRELOAD_SCREENS/,
    );
  });

  test('utils/readerScroll 提供 isWithinPreloadWindow 且对未量出尺寸有守卫', () => {
    expect(scrollUtil).toMatch(/export function isWithinPreloadWindow\(/);
    expect(scrollUtil).toMatch(
      /if \(viewHeight <= 0 \|\| contentHeight <= 0\) \{\s*\n\s*return false;\s*\n\s*\}/,
    );
  });
});

describe('修复②：切章不再闪现旧章（同步派生 + 当帧一致视图）', () => {
  test('book/chapter/loadError 随路由参数同步派生（useMemo），异步 setState 加载已移除', () => {
    expect(source).toMatch(/const book = useMemo<Book \| null>\(\(\) => \{/);
    expect(source).toMatch(/const chapter = useMemo<Chapter \| null>\(\(\) => \{/);
    expect(source).toMatch(/const loadError = useMemo<string \| null>\(\(\) => \{/);
    expect(source).toMatch(/TextLibraryService\.getChapter\(chapterId\)/);
    // 旧的异步 setState 加载必须移除
    expect(source).not.toMatch(/setChapter\(/);
    expect(source).not.toMatch(/setBook\(/);
    expect(source).not.toMatch(/setLoadError\(/);
  });

  test('effectiveChapters：路由章不在拼接序列（切章过渡帧）时以路由章单独成列', () => {
    expect(source).toMatch(/const effectiveChapters = useMemo<Chapter\[\]>\(\(\) => \{/);
    expect(source).toMatch(
      /if \(continuousChapters\.some\(\(c\) => c\.id === chapter\?\.id\)\) \{\s*\n\s*return continuousChapters;/,
    );
    expect(source).toMatch(/return chapter \? \[chapter\] : \[\];/);
  });

  test('渲染数据源使用 effectiveChapters（连续滚动行不再直接吃 continuousChapters 状态）', () => {
    expect(source).toMatch(/for \(const ch of effectiveChapters\) \{/);
    expect(source).toMatch(/return rows;\s*\n\s*\}, \[effectiveChapters, toDisplayText, toDisplaySegment\]\);/);
    expect(source).toMatch(/return effectiveChapters\.map\(\(c\) => c\.id\);/);
  });

  test('init effect 只保留副作用（initDatabase + openChapter），不再承担文本加载', () => {
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*if \(!bookId \|\| !chapterId\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*StorageService\.initDatabase\(\);/,
    );
  });
});
