/**
 * 阅读器选区交互的**保留组件**契约（清理后残留面）
 *
 * ── 本文件为何被大幅裁剪（书面理由，逐条对应）────────────────────────────
 * 原始 327 行断言中，**绝大多数是对 `screens/ReaderScreen.tsx` 源码文本的结构
 * 契约**（选区浮动层 / `handleSelectionExtendPress` / 三段式菜单 / `selectionSheet`
 * 样式 / `activeSelection` 透传 / 长按初始选区 / 两步确认删划线 …）。
 *
 * 谁删的、何时、为什么：
 *   · 执行者：cleanup-executor（2026-09-22，团队 software-guoxue-reader）
 *   · 依据：`docs/reader-cleanup-plan-2026-09-22.md` §4/§5/§6 —— 用户裁定
 *     「真零起点」：`ReaderScreen.tsx` 的 5430 行实现（含跳章 / 翻页 / 跨章拼接 /
 *     定位落位 / 视口补偿 / 边缘手势，以及挂在其上的选区交互 UI）**整体移除**，
 *     文件已替换为最小空壳（56 行，仅渲染占位文案）。
 *   · 因此对 `reader` 变量的断言只有两种下场：**假红**（断言具体结构）或
 *     **恒真**（`not.toMatch` 在空壳上必然通过）。二者都不构成回归防护
 *     ⇒ 按 T7 规则「断言锁的是已删实现的形状 ⇒ 随族删除并写明理由」全部移除。
 *   · 选区交互的**行为契约**（浮动层位置、点按扩展、收缩、两步确认删划线）不属于
 *     本次保留范围，将在新阅读器从零重写时**由新实现自己重新立断言**。
 *
 * ── 保留了什么（这些断言锚定的文件**未在清理中改动**，且变异下会红）──────
 *   · `components/reader/PinyinText.tsx` —— per-char 点按 + `selectionRange`
 *   · `components/reader/HighlightText.tsx` —— per-char 点按 + `selectionRange`
 *   · `components/reader/AnalysisPanel.tsx` —— 全串精确查词 / 逐字摘要 / 截断
 *   · `services/DictionaryService.ts` —— `lookupWordExact`
 *   · `theme/colors.ts` —— `withAlpha`
 * 这些是**组件/服务层 API 契约**，与「谁来渲染阅读页」无关，故原样保留。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const pinyinText = readSrc('components/reader/PinyinText.tsx');
const highlightText = readSrc('components/reader/HighlightText.tsx');
const analysisPanel = readSrc('components/reader/AnalysisPanel.tsx');
const dictService = readSrc('services/DictionaryService.ts');

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

describe('④ 活动选区视觉效果（selectionRange 透传链路）', () => {
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
