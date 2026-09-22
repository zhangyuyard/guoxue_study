/**
 * 章节标题注音回归防护测试（清理后残留面）
 *
 * 背景（真机反馈）：阅读页「章节标识」（章标题）未标注拼音——标题行此前是
 * 纯 <Text>，不参与注音链路。
 *
 * ── 本文件为何被裁剪（书面理由）────────────────────────────────────────────
 * 原 5 条断言中有 4 条是对 `screens/ReaderScreen.tsx` 源码文本的契约：
 *   · 「不再有纯 `styles.chapterTitle` / `<ChapterTitleText>` 至少 4 处渲染点 /
 *     传 `baseTextStyle`+`workId`+`bookId` / 翻页 sizer 的 `setTitleHeight`」
 *   · 执行者：cleanup-executor（2026-09-22）；依据
 *     `docs/reader-cleanup-plan-2026-09-22.md` §4/§5/§6（用户裁定「真零起点」）。
 *   · `ReaderScreen.tsx` 已整体替换为 56 行空壳（旧 5430 行含跳章/翻页/跨章拼接/
 *     定位落位/视口补偿全部移除）⇒ 这 4 条只剩两种下场：假红（断言具体结构）或
 *     恒真（`not.toMatch`）。二者都不构成回归防护 ⇒ 随族删除。
 *   · `ChapterTitleText` 的渲染点数量 / `setTitleHeight` 量测属于已删的翻页 sizer
 *     与滚动行模型，将在新阅读器从零重写时由新实现自己重新立断言。
 *
 * ── 保留了什么 ────────────────────────────────────────────────────────────
 * `components/reader/PinyinText.tsx` **未在本次清理中改动**（属保留族：正文/标题
 * 注音渲染本体）。其 `baseTextStyle` 扩展是**组件层 API 契约**——删掉该 prop 或
 * 任一合并点，下面的断言即变红 ⇒ 保留。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const pinyinSource = readFileSync(
  join(__dirname, '..', 'components', 'reader', 'PinyinText.tsx'),
  'utf-8',
);

describe('章节标题注音（PinyinText baseTextStyle 扩展）', () => {
  test('PinyinText 提供 baseTextStyle 扩展（标题等非正文场景）', () => {
    expect(pinyinSource).toMatch(/baseTextStyle\?: TextStyle;/);
    // 注音汉字格 / 非汉字 run 两路合并
    expect(pinyinSource).toMatch(/char: \{[\s\S]*?\.\.\.baseTextStyle/);
    expect(pinyinSource).toMatch(/run: \{[\s\S]*?\.\.\.baseTextStyle/);
    // off 降级纯文本路径合并（baseTextStyle 在样式数组末位、优先级最高）
    expect(pinyinSource).toMatch(/stylesFallback\.text,[\s\S]*?baseTextStyle,/);
  });
});
