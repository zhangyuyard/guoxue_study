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

  test('effectiveChapters：以「种子章匹配」判定稳态（切章过渡帧以路由章单独成列防闪烁）', () => {
    expect(source).toMatch(/const effectiveChapters = useMemo<Chapter\[\]>\(\(\) => \{/);
    // 滑动窗口丢头后入口章可能已不在序列中，故不能用「路由章是否在序列中」作判据，
    // 必须以重置 effect 记录的种子章（continuousSeedChapterId）判定
    expect(source).toMatch(
      /if \(chapter && continuousSeedChapterId === chapter\.id && continuousChapters\.length > 0\) \{\s*\n\s*return continuousChapters;/,
    );
    expect(source).toMatch(/return chapter \? \[chapter\] : \[\];/);
    // 重置 effect 必须同步记录种子章（经 chapterRef 取当前章对象，避免按引用依赖）
    expect(source).toMatch(/setContinuousSeedChapterId\(ch\?\.id \?\? null\);/);
    // 重置 effect 依赖口径：仅「chapterId / 空壳→正文就位 / jumpSeq」触发，
    // 禁止按 chapter 对象引用依赖（后台填充每批合并替换章对象引用，
    // 按引用触发会把正在阅读的拼接序列整体重置——滚动清零、拼接章节丢失）
    expect(source).toMatch(/\}, \[chapterId, chapterReady, jumpSeq, rowOffsets\]\);/);
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

describe('阅读器 UI 精简：翻页条 / 底部 dock 删除 + 注音按钮迁移 + 滑动窗口', () => {
  test('章节翻页条已删除（不再渲染「上一章 / 下一章」pager 条）', () => {
    expect(source).not.toMatch(/styles\.pager,/);
    expect(source).not.toMatch(/styles\.pagerBtn/);
    expect(source).not.toMatch(/'‹ 上一章'/);
    expect(source).not.toMatch(/'下一章 ›'/);
    // goToChapter 保留（目录跳章与仿真翻页跨章仍用）
    expect(source).toMatch(/const goToChapter = useCallback/);
  });

  test('底部 dock 已删除（进度/朗读/注音条/工具栏并入长按菜单）', () => {
    expect(source).not.toMatch(/styles\.bottomDock/);
    expect(source).not.toMatch(/styles\.ttsBar/);
    expect(source).not.toMatch(/styles\.progressWrap/);
    expect(source).not.toMatch(/PinyinModeBar/);
    expect(source).not.toMatch(/ReaderToolbar/);
    // dockHeight/visiblePageHeight 扣高机制同步清理
    expect(source).not.toMatch(/dockHeight/);
    expect(source).toMatch(/const visiblePageHeight = measured \? Math\.max\(80, pagerLayout\.height\) : 0;/);
    // 正文底部留白为固定底部进度条让位（64：进度条约 42px + 呼吸空隙，不含 safe-area）
    expect(source).toMatch(/const CONTENT_BOTTOM_PADDING = 64;/);
  });

  test('底部固定进度条回归阅读页底部（复用 progressFill，长按菜单进度行删除）', () => {
    expect(source).toMatch(/styles\.bottomProgress/);
    expect(source).toMatch(/styles\.bottomProgressText/);
    expect(source).toMatch(/styles\.progressFill/);
    expect(source).toMatch(/styles\.progressTrack/);
    // 长按菜单内的进度行与死样式必须移除（避免与底部进度条重复展示）
    expect(source).not.toMatch(/styles\.menuProgressWrap/);
    expect(source).not.toMatch(/styles\.progressText/);
    // 进度文本随阅读模式给出页码信息（翻页模式含第 i/j 页）
    expect(source).toMatch(/第 \$\{Math\.max\(1, chapterIndex \+ 1\)\}\/\$\{totalChapters\} 章/);
  });

  test('收藏/朗读上移右上角「藏/听」按钮（听=语速弹窗→确认播放，长按菜单背诵/语速删除）', () => {
    // 藏：已收藏态 + 两步确认取消（handleToggleArticleBookmark）
    expect(source).toMatch(/const handleToggleArticleBookmark = useCallback/);
    expect(source).toMatch(/articleBookmark \? '取消收藏本章' : '收藏本章'/);
    expect(source).toMatch(/articleBookmark \? colors\.primary : colors\.pinyin/);
    // 听：朗读中主色高亮 + 状态化无障碍标签（设置语速并朗读 / 停止朗读）
    expect(source).toMatch(/const handleListenPress = useCallback/);
    expect(source).toMatch(/onPress=\{handleListenPress\}/);
    expect(source).toMatch(/ttsSpeaking \? '停止朗读' : '设置语速并朗读'/);
    expect(source).toMatch(/ttsSpeaking \? colors\.primary : colors\.pinyin/);
    expect(source).toMatch(/\{ttsSpeaking \? '⏹' : '听'\}/);
    // 长按菜单中的「收藏全文」「朗读/停止」「背诵练习」「语速步进」全部删除
    expect(source).not.toMatch(/accessibilityLabel="收藏本章全文"/);
    expect(source).not.toMatch(/▶ 朗读/);
    expect(source).not.toMatch(/accessibilityLabel="背诵练习"/);
    expect(source).not.toMatch(/handleRecite/);
    // 语速融入「听」：弹窗内本地临时值（确认才写回 setSpeechRate 持久化并开播）
    expect(source).toMatch(/const \[rateModalVisible, setRateModalVisible\] = useState\(false\);/);
    expect(source).toMatch(/const \[tempSpeechRate, setTempSpeechRate\] = useState\(speechRate\);/);
    expect(source).toMatch(/onRequestClose=\{handleCancelSpeechRate\}/);
    expect(source).toMatch(/disabled=\{tempSpeechRate <= 0\.5\}/);
    expect(source).toMatch(/disabled=\{tempSpeechRate >= 2\.0\}/);
    expect(source).toMatch(/tempSpeechRate\.toFixed\(2\)\}x/);
    expect(source).toMatch(/accessibilityLabel="确认语速并开始播放"/);
    expect(source).toMatch(/确认开始播放/);
    expect(source).toMatch(/const handleConfirmSpeechRate = useCallback/);
    expect(source).toMatch(/setSpeechRate\(tempSpeechRate\);/);
  });

  test('注音切换迁移右上角「音」按钮（循环切换 + 当前模式无障碍说明）', () => {
    expect(source).toMatch(/const PINYIN_MODE_CYCLE: readonly PinyinMode\[\] = \['full', 'rare', 'off'\];/);
    expect(source).toMatch(/const PINYIN_MODE_LABELS: Record<PinyinMode, string>/);
    expect(source).toMatch(/const handleCyclePinyinMode = useCallback/);
    expect(source).toMatch(/accessibilityLabel=\{`注音模式：\$\{PINYIN_MODE_LABELS\[pinyinMode\]\}/);
  });

  test('滑动窗口：序列超限丢头而非停止拼接（appendNextChapter 成功后丢头腾位）', () => {
    expect(source).toMatch(/const maybeDropHeadChapters = useCallback/);
    // 追加成功后立即检查丢头
    expect(source).toMatch(
      /setContinuousChapters\(merged\);\s*\n\s*\/\/ 滑动窗口：追加成功后若序列超限，立即丢头腾位（当前章守卫已保证可行）\s*\n\s*maybeDropHeadChapters\(\);/,
    );
    // 追加守卫改为「超限且无法丢头才停」（当前章在头部区域时保守停止）
    expect(source).toMatch(/excessAfterAppend > 0 && activeIdx < excessAfterAppend/);
    // 丢头后挂起的向前拼接锚点安全放弃
    expect(source).toMatch(
      /\/\/ 挂起的向前拼接锚点安全放弃（双保险）：绝不残留锚点阻塞后续拼接\s*\n\s*prependAnchor\.current = null;/,
    );
    // 丢头偏移补偿在 onContentSizeChange 消费
    expect(source).toMatch(/const dropDelta = headDropCompensation\.current;/);
    expect(source).toMatch(/offset: Math\.max\(0, scrollOffset\.current - dropDelta\),/);
    // 当前章前移时补丢（经 ref 调最新实现）
    expect(source).toMatch(/maybeDropHeadRef\.current\(\);/);
  });

  test('utils/readerScroll 提供 planHeadDrop 且只丢当前章之前的头部章节', () => {
    expect(scrollUtil).toMatch(/export function planHeadDrop\(/);
    expect(scrollUtil).toMatch(/keptChapterIds: chapterIds\.slice\(excess\),/);
    expect(scrollUtil).toMatch(/droppedChapterIds: chapterIds\.slice\(0, excess\),/);
  });
});

describe('注音切换不跳章回归（Bug：切「音」后章节跳动）', () => {
  test('滚动模式：注音切换前捕获视口锚点（captureViewportAnchor 仅 scroll 模式生效）', () => {
    expect(source).toMatch(/const captureViewportAnchor = useCallback/);
    expect(source).toMatch(
      /const captureViewportAnchor = useCallback\(\(\) => \{\s*\n\s*if \(readerMode !== 'scroll'\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
    // 锚点记录「视口顶部所在行 + 视口顶入深度」，按旧布局偏移计算
    expect(source).toMatch(
      /layoutAnchor\.current = \{\s*\n\s*rowId: bestId,\s*\n\s*delta: Math\.max\(0, offset - bestY\),\s*\n\s*createdAt: Date\.now\(\),\s*\n\s*\};/,
    );
  });

  test('handleCyclePinyinMode 在 setPinyinMode 前捕获锚点（补偿基准必须取切换前的旧布局）', () => {
    expect(source).toMatch(
      /const handleCyclePinyinMode = useCallback\(\(\) => \{\s*\n\s*captureViewportAnchor\(\);/,
    );
  });

  test('handleRowLayout 消费视口锚点：目标行重排后按「新 y + 深度」落位，超时放弃', () => {
    expect(source).toMatch(/const viewportAnchor = layoutAnchor\.current;/);
    expect(source).toMatch(
      /if \(viewportAnchor != null && rowId === viewportAnchor\.rowId\) \{[\s\S]*?listRef\.current\?\.scrollToOffset\(\{ offset: target, animated: false \}\);/,
    );
    // 超时未等到重排则放弃，避免陈旧锚点事后把用户拽走
    expect(source).toMatch(/Date\.now\(\) - viewportAnchor\.createdAt > LOCATE_TIMEOUT_MS/);
  });

  test('翻页模式：measureKey 重量测前捕获「当前页所在段」作为重定位目标', () => {
    // pages/index 经 layoutRef 供重置 effect 读取（不得加入重置 effect 依赖）
    expect(source).toMatch(/layoutRef\.current = \{ pages, index \};/);
    expect(source).toMatch(
      /relocateSegIdRef\.current = firstSeg \? blockSegId\(firstSeg\.id\) : null;/,
    );
  });

  test('翻页模式定位目标解析：stale 显式目标不重复生效，重量测后回当前页所在段', () => {
    // 打开时的显式目标只定位一次，防止 measureKey 重置后被陈旧目标拽回（跳动根因）
    expect(source).toMatch(
      /const freshExplicit = !!locateSegmentId && locateSegmentId !== locatedSegIdRef\.current;/,
    );
    expect(source).toMatch(
      /const target = freshExplicit \? locateSegmentId : relocateSegIdRef\.current;/,
    );
    // 重定位成功后清空，不影响后续定位
    expect(source).toMatch(/relocateSegIdRef\.current = null;/);
  });
});

describe('字号/行距/繁简切换不跳章回归（视口锚定与注音切换同路径）', () => {
  test('滚动模式：字号步进 handler 在 setFontSize 前捕获视口锚点（范围 14–30）', () => {
    expect(source).toMatch(
      /const handleStepFontSize = useCallback\(\s*\n\s*\(dir: 1 \| -1\) => \{\s*\n\s*captureViewportAnchor\(\);/,
    );
    expect(source).toMatch(
      /setFontSize\(dir > 0 \? Math\.min\(30, fontSize \+ 2\) : Math\.max\(14, fontSize - 2\)\);/,
    );
    // 弹窗按钮接入 handler，不允许散写裸 setFontSize（会绕过锚点捕获）
    expect(source).toMatch(/onPress=\{\(\) => handleStepFontSize\(-1\)\}/);
    expect(source).toMatch(/onPress=\{\(\) => handleStepFontSize\(1\)\}/);
    expect(source).not.toMatch(/onPress=\{\(\) => setFontSize\(/);
  });

  test('滚动模式：行距选择 handler 在 setLineHeight 前捕获视口锚点', () => {
    expect(source).toMatch(
      /const handleSelectLineHeight = useCallback\(\s*\n\s*\(lh: number\) => \{\s*\n\s*captureViewportAnchor\(\);/,
    );
    expect(source).toMatch(/onPress=\{\(\) => handleSelectLineHeight\(lh\)\}/);
    expect(source).not.toMatch(/onPress=\{\(\) => setLineHeight\(/);
  });

  test('滚动模式：繁简切换（设置弹窗 + 右上角按钮）在 setConversionMode 前捕获视口锚点', () => {
    expect(source).toMatch(
      /const handleSelectConversionMode = useCallback\(\s*\n\s*\(mode: 'simplified' \| 'traditional'\) => \{\s*\n\s*captureViewportAnchor\(\);/,
    );
    expect(source).toMatch(/const handleToggleConversionMode = useCallback\(\(\) => \{\s*\n\s*captureViewportAnchor\(\);/);
    expect(source).toMatch(/onPress=\{handleToggleConversionMode\}/);
    expect(source).toMatch(/onPress=\{\(\) => handleSelectConversionMode\(mode\)\}/);
    // 不允许散写裸 setConversionMode 调用（会绕过锚点捕获）
    expect(source).not.toMatch(/onPress=\{\(\) =>\s*\n\s*setConversionMode\(/);
  });

  test('锚点捕获与消费逻辑不回归（与注音切换共用同一条重排路径）', () => {
    // 捕获：仅滚动模式生效（翻页模式走 relocateSegIdRef，不走视口锚点）
    expect(source).toMatch(
      /const captureViewportAnchor = useCallback\(\(\) => \{\s*\n\s*if \(readerMode !== 'scroll'\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
    // 消费：目标行重排后按「新 y + 深度」落位，超时放弃（rowId 不存在即不拽人）
    expect(source).toMatch(/const viewportAnchor = layoutAnchor\.current;/);
    expect(source).toMatch(/Date\.now\(\) - viewportAnchor\.createdAt > LOCATE_TIMEOUT_MS/);
  });

  test('翻页模式：繁简切换纳入 measureKey（重量测 + relocateSegIdRef 重定位覆盖）', () => {
    // measureKey 含 displayMode：繁简转换改变文本 → 分页可能变化，
    // 重量测前由重置 effect 捕获当前页首段（relocateSegIdRef）防跳动。
    // 段落 id 不随繁简转换变化（toDisplaySegment 仅换文本不改 id），重定位目标稳定。
    expect(source).toMatch(
      /const measureKey = `\$\{chapterTitle\}\|\$\{pinyinMode\}\|\$\{fontSize\}\|\$\{lineHeight\}\|\$\{displayMode\}\|\$\{Math\.round/,
    );
    expect(source).toMatch(/displayMode=\{conversionMode\}/);
    expect(source).toMatch(
      /relocateSegIdRef\.current = firstSeg \? blockSegId\(firstSeg\.id\) : null;/,
    );
  });
});
