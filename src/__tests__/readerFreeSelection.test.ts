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
 *   5) 菜单限高 + ScrollView 防溢出，不遮挡底部进度条。
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

describe('③ 菜单溢出修复', () => {
  test('面板限高（maxHeight 65%）+ 内容 ScrollView，底部停靠不遮挡进度条', () => {
    expect(reader).toMatch(/maxHeight: '65%'/);
    expect(reader).toMatch(
      /selectionSheet[\s\S]*?<ScrollView nestedScrollEnabled showsVerticalScrollIndicator=\{false\}>/,
    );
    // 面板底部预留进度条高度，避免遮挡
    expect(reader).toMatch(/paddingBottom: 56/);
  });
});
