/**
 * 阅读器选区交互重构的回归防护测试（源码结构断言）
 * 需求：优化长按选中方式——废 ± 逐字步进，改为「长按起点 + 点按扩展」自由选中；
 *       解析按实际选中内容（不再固定 4 字前缀、逐字回退）；长按菜单溢出修复。
 * 锁定点：
 *   1) 选区面板为阅读页内浮动层（box-none 允许点按穿透正文扩展选区），非全屏 Modal；
 *   2) ± 按钮 / adjustSelection 已删除，新增 handleSelectionExtendPress（点按扩展）；
 *   3) 两渲染模式（PinyinText / HighlightText）均支持 per-char 点按上报；
 *   4) 解析：多字按实际选中全串精确查词（lookupWordExact），全串未收录逐字解析列表，
 *      超长截断展示；「在字典中查看」目标词头 dictHeadword；
 *   5) 菜单三段式重构：内容区（选中文本独立限高滚动）+ hairline 分隔线 +
 *      固定操作栏（划线行 + flex:1 等宽按钮行），操作栏脱离滚动区永不截断。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const reader = readSrc('screens/ReaderScreen.tsx');
const pinyinText = readSrc('components/reader/PinyinText.tsx');
const highlightText = readSrc('components/reader/HighlightText.tsx');
const analysisPanel = readSrc('components/reader/AnalysisPanel.tsx');
const dictService = readSrc('services/DictionaryService.ts');

describe('① 选区自由化：浮动层 + 点按扩展（废 ± 步进）', () => {
  test('± 按钮与 adjustSelection 已彻底删除（无死代码/死样式）', () => {
    expect(reader).not.toMatch(/adjustSelection/);
    expect(reader).not.toMatch(/起点后移|起点前移|终点后移|终点前移/);
    expect(reader).not.toMatch(/styles\.selectionRow/);
  });

  test('选区面板不再是全屏 Modal，改为阅读页内浮动层（box-none 穿透正文）', () => {
    expect(reader).toMatch(
      /styles\.selectionDock} pointerEvents="box-none"/,
    );
    // 选区面板本体不再包在 <Modal> 内（Modal 仍用于语速/笔记/设置/目录弹窗）
    expect(reader).not.toMatch(
      /<Modal[^>]*>\s*\n\s*<Pressable style=\{styles\.overlay\}[^>]*>\s*\n\s*<Pressable\s*\n\s*style=\{\[styles\.sheet, \{ backgroundColor: colors\.background \}\]\}\s*\n\s*onPress=\{\(\) => undefined\}\s*\n\s*>\s*\n\s*\{\/\* 阅读进度已固定/,
    );
    expect(reader).toMatch(/selectionVisible && selection \? \(/);
  });

  test('存在点按扩展回调：终点之后向右扩 / 起点之前向左扩 / 跨段重开 4 字窗口', () => {
    expect(reader).toMatch(/const handleSelectionExtendPress = useCallback/);
    expect(reader).toMatch(/if \(index >= prev\.end\) \{/);
    expect(reader).toMatch(/if \(index < prev\.start\) \{/);
    expect(reader).toMatch(/segmentId !== prev\?\.segmentId/);
    expect(reader).toMatch(/const end = Math\.min\(start \+ 4, chars\.length\);/);
  });

  test('滚动/翻页两模式均传入点按扩展（仅选区打开时生效，回落划线点击）', () => {
    expect(reader).toMatch(
      /onPressIndex=\{selectionVisible \? handleSelectionExtendPress : undefined\}/,
    );
    expect(reader).toMatch(/onPressIndex\?: \(segmentId: string, index: number\) => void;/);
  });

  test('菜单含「收起」入口（清选区），长按其他字重新选字语义保留', () => {
    expect(reader).toMatch(/const closeSelection = useCallback/);
    expect(reader).toMatch(/accessibilityLabel="收起选区菜单"/);
    expect(reader).toMatch(/点按正文任意字可扩展选区/);
  });
});

describe('① 两渲染模式的 per-char 点按支持', () => {
  test('PinyinText：字格支持 onPressChar（优先于划线点击），长按保留', () => {
    expect(pinyinText).toMatch(/onPressChar\?: \(index: number\) => void;/);
    expect(pinyinText).toMatch(/const pressChar = onPressChar/);
    expect(pinyinText).toMatch(/onPressChar\(cell\.index\)/);
  });

  test('HighlightText：提供 onPressChar 时逐字渲染并按码点索引上报', () => {
    expect(highlightText).toMatch(/onPressChar\?: \(index: number\) => void;/);
    expect(highlightText).toMatch(/if \(onPressChar\) \{/);
    expect(highlightText).toMatch(/const globalIndex = seg\.start \+ i;/);
    expect(highlightText).toMatch(/onPress=\{\(\) => onPressChar\(globalIndex\)\}/);
  });

  test('SegmentItem：off 模式点按索引加 charRange 起点还原全局码点基准', () => {
    expect(reader).toMatch(
      /onPressIndex\?\.\(segmentId, localIndex \+ \(charRange\?\.\[0\] \?\? 0\)\);/,
    );
  });
});

describe('② 解析跟随实际选中内容', () => {
  test('DictionaryService 提供 lookupWordExact（仅精确命中，不做包含回退）', () => {
    expect(dictService).toMatch(/lookupWordExact\(word: string\): ServiceResult<WordAnalysis>/);
    expect(dictService).toMatch(/const exact = wordIndex\.get\(word\.trim\(\)\);/);
  });

  test('AnalysisPanel 废弃 4 字前缀上限，按全串精确查词', () => {
    expect(analysisPanel).not.toMatch(/MAX_WORD_PREFIX/);
    expect(analysisPanel).toMatch(/DictionaryService\.lookupWordExact\(trimmed\)/);
  });

  test('全串未收录时逐字解析摘要列表（纵向排列），不再仅回退首字', () => {
    expect(analysisPanel).toMatch(/charSummaries\?: CharSummaryItem\[\];/);
    expect(analysisPanel).toMatch(/const summaries = shown\.map\(summarizeChar\);/);
    expect(analysisPanel).toMatch(/styles\.summaryItem/);
    expect(analysisPanel).not.toMatch(/fallbackToChar/);
  });

  test('选区超长截断展示（ANALYSIS_MAX_SHOWN_CHARS）并提示总字数', () => {
    expect(analysisPanel).toMatch(/const ANALYSIS_MAX_SHOWN_CHARS = 12;/);
    expect(analysisPanel).toMatch(/chars\.length > ANALYSIS_MAX_SHOWN_CHARS/);
    expect(analysisPanel).toMatch(/truncated \? \(/);
  });

  test('「在字典中查看」目标词头：词条命中跳全串，逐字回退跳首字', () => {
    expect(analysisPanel).toMatch(/dictHeadword: string;/);
    expect(analysisPanel).toMatch(/const headword = state\.dictHeadword \|\| state\.displayText;/);
  });
});

describe('③ 菜单三段式重构：内容区可滚动 + 固定操作栏（根除截断）', () => {
  test('面板底部停靠（paddingBottom 56 预留进度条），maxHeight 65% 外层保险保留', () => {
    expect(reader).toMatch(/maxHeight: '65%'/);
    // 面板底部预留进度条高度，避免遮挡
    expect(reader).toMatch(/paddingBottom: 56/);
  });

  test('内容区：选中文本独立 ScrollView 固定数值限高（短选区自适应、超长内滚）', () => {
    // 面板内首个 ScrollView 即选中文本滚动区（操作栏在 ScrollView 之外）
    expect(reader).toMatch(
      /selectionSheet[\s\S]*?<ScrollView\s*\n\s*nestedScrollEnabled/,
    );
    // 固定数值限高（勿用百分比——Android 上百分比 maxHeight 测量不稳导致裁切）
    expect(reader).toMatch(/selectionContentScroll: \{\s*\n\s*maxHeight: 140,/);
    // 选中文字完整换行，不 numberOfLines 截断
    expect(reader).not.toMatch(/styles\.selectionText[^\n]*numberOfLines/);
  });

  test('分隔线：内容区与固定操作栏之间 hairline 线（colors.border）', () => {
    expect(reader).toMatch(
      /styles\.selectionDivider, \{ backgroundColor: colors\.border \}/,
    );
  });

  test('划线行独立成行：左「划线」标签 + 三色圆点，不再与操作按钮同行挤爆', () => {
    expect(reader).toMatch(/styles\.selectionHighlightRow/);
    expect(reader).toMatch(/styles\.selectionHighlightDots/);
    expect(reader).toMatch(/使用\$\{color\}颜色划线/);
  });

  test('操作栏固定：解析/翻译/笔记/收起 4 按钮 flex:1 等宽（flexBasis 0）永不压缩', () => {
    expect(reader).toMatch(/selectionActionsRow: \{/);
    expect(reader).toMatch(
      /selectionActionButton: \{[\s\S]*?flex: 1,[\s\S]*?flexBasis: 0,/,
    );
    expect(reader).toMatch(/accessibilityLabel="收起选区菜单"/);
  });

  test('旧整板 ScrollView 结构与死样式已删除：操作行必须位于 ScrollView 之外', () => {
    // actionDivider 仅旧单行菜单使用，应删除（无死样式）
    expect(reader).not.toMatch(/actionDivider/);
    // 结构断言：selectionSheet 内的选中文本 ScrollView 先出现并闭合，
    // 操作行（selectionActionsRow）位于其之后（滚动区外、固定底部）
    const sheetStart = reader.indexOf(
      'styles.selectionSheet, { backgroundColor: colors.background }',
    );
    expect(sheetStart).toBeGreaterThan(-1);
    const scrollStart = reader.indexOf('<ScrollView', sheetStart);
    const scrollEnd = reader.indexOf('</ScrollView>', scrollStart);
    const actionsRow = reader.indexOf('styles.selectionActionsRow', scrollEnd);
    expect(scrollStart).toBeGreaterThan(sheetStart);
    expect(scrollEnd).toBeGreaterThan(scrollStart);
    expect(actionsRow).toBeGreaterThan(scrollEnd);
  });
});

describe('④ 活动选区视觉效果（selectionRange 透传链路）', () => {
  test('ReaderScreen：菜单打开期间派生活动选区快照（activeSelection）', () => {
    expect(reader).toMatch(
      /selectionVisible && selection\s*\?\s*\{ segmentId: selection\.segmentId, start: selection\.start, end: selection\.end \}/,
    );
  });

  test('ReaderScreen：滚动模式 renderRow 按段匹配下发 selectionRange', () => {
    expect(reader).toMatch(
      /activeSelection && activeSelection\.segmentId === item\.segment\.id\s*\?\s*\[activeSelection\.start, activeSelection\.end\]\s*:\s*undefined/,
    );
  });

  test('ReaderScreen：翻页模式经 PageModeView → SegmentBlockItem 透传 activeSelection', () => {
    expect(reader).toMatch(
      /activeSelection\?: \{ segmentId: string; start: number; end: number \} \| null;/,
    );
    expect(reader).toMatch(
      /activeSelection\.segmentId === segId\s*\?\s*\[activeSelection\.start, activeSelection\.end\]\s*:\s*undefined/,
    );
  });

  test('SegmentItem：off 模式拆页路径对选区区间求交集并平移到局部坐标系', () => {
    expect(reader).toMatch(/const localSelectionRange = useMemo<\[number, number\] \| undefined>\(/);
    expect(reader).toMatch(/const from = Math\.max\(s, selectionRange\[0\]\);/);
    expect(reader).toMatch(/const to = Math\.min\(e, selectionRange\[1\]\);/);
    expect(reader).toMatch(/return from < to \? \[from - s, to - s\] : undefined;/);
    // PinyinText 用全局码点基准，HighlightText 用局部（切片平移后）基准
    expect(reader).toMatch(/selectionRange=\{selectionRange\}/);
    expect(reader).toMatch(/selectionRange=\{localSelectionRange\}/);
  });

  test('PinyinText：字格支持 selectionRange 叠加主色半透明选区背景', () => {
    expect(pinyinText).toMatch(/selectionRange\?: \[number, number\];/);
    expect(pinyinText).toMatch(/withAlpha\(colors\.primary, 0\.25\)/);
    expect(pinyinText).toMatch(/selected \? \{ backgroundColor: selectionBg \} : null/);
    // 选区样式优先于已保存划线背景，保证选区可辨识
    expect(pinyinText).toMatch(/highlight && !selected/);
  });

  test('HighlightText：两渲染路径均支持 selectionRange 选区背景', () => {
    expect(highlightText).toMatch(/selectionRange\?: \[number, number\];/);
    expect(highlightText).toMatch(/withAlpha\(colors\.primary, 0\.25\)/);
    // 逐字路径：选区内字符着选区背景
    expect(highlightText).toMatch(
      /selected \? \[styles\.span, \{ backgroundColor: selectionBg \}\] : \(segStyle \?\? undefined\)/,
    );
    // 片段路径：与选区相交的片段按交集切分着色
    expect(highlightText).toMatch(/pieces\.push\(\{ from: selFrom, to: selTo, selected: true \}\);/);
  });

  test('主题提供 withAlpha 派生半透明主色（选区背景随主题换色）', () => {
    expect(readSrc('theme/colors.ts')).toMatch(
      /export function withAlpha\(hex: string, alpha: number\): string/,
    );
  });
});
