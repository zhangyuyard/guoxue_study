/**
 * 章节标题注音回归防护测试（源码结构断言）
 *
 * 背景（真机反馈）：阅读页「章节标识」（章标题）未标注拼音——标题行此前是
 * 纯 <Text>，不参与注音链路。
 *
 * 修复结构：
 * 1. ReaderScreen 新增 ChapterTitleText 统一渲染（滚动模式标题行 / 翻页模式
 *    标题块 / 翻页 sizer / loading 占位 / 缺页兜底共 5 处），内部用 PinyinText；
 * 2. PinyinText 扩展 baseTextStyle prop：注音汉字格 / 非汉字 run / off 降级
 *    纯文本三路统一合并调用方文字样式（fontWeight/textAlign），视觉与旧纯
 *    Text 一致；
 * 3. 翻页模式 sizer 用同一组件量高（setTitleHeight）——注音开启时标题高度
 *    增大（字格上下双行），分页自动适配，量测与渲染必须同源。
 * 本文件锁定上述结构，防止后续改动回退到纯 Text 或量测/渲染不同源。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const readerSource = readFileSync(join(__dirname, '..', 'screens', 'ReaderScreen.tsx'), 'utf-8');
const pinyinSource = readFileSync(
  join(__dirname, '..', 'components', 'reader', 'PinyinText.tsx'),
  'utf-8',
);

describe('章节标题注音（ChapterTitleText 统一渲染）', () => {
  test('ReaderScreen 不再有纯 Text 章节标题（styles.chapterTitle 已退役）', () => {
    expect(readerSource).not.toMatch(/styles\.chapterTitle\b/);
  });

  test('ChapterTitleText 至少覆盖 4 处渲染点（标题块/sizer/loading/滚动标题行）', () => {
    const used = readerSource.match(/<ChapterTitleText/g) ?? [];
    expect(used.length).toBeGreaterThanOrEqual(4);
  });

  test('ChapterTitleText 传 baseTextStyle 与 workId/bookId（语境化判音）', () => {
    expect(readerSource).toMatch(/baseTextStyle=\{styles\.chapterTitleText\}/);
    expect(readerSource).toMatch(/workId=\{(?:item\.chapterId|workId)\}/);
    expect(readerSource).toMatch(/bookId=\{(?:bookId \?\? undefined|bookId)\}/);
  });

  test('翻页 sizer 量高必须走 ChapterTitleText（量测与渲染同源，分页适配注音行高）', () => {
    // setTitleHeight 必须在 ChapterTitleText 的 onLayout 内（而非独立纯 Text）
    expect(readerSource).toMatch(
      /<ChapterTitleText[\s\S]*?onLayout=\{\(e\) => \{\s*\n\s*setTitleHeight\(e\.nativeEvent\.layout\.height\);/,
    );
  });

  test('PinyinText 提供 baseTextStyle 扩展（标题等非正文场景）', () => {
    expect(pinyinSource).toMatch(/baseTextStyle\?: TextStyle;/);
    // 注音汉字格 / 非汉字 run 两路合并
    expect(pinyinSource).toMatch(/char: \{[\s\S]*?\.\.\.baseTextStyle/);
    expect(pinyinSource).toMatch(/run: \{[\s\S]*?\.\.\.baseTextStyle/);
    // off 降级纯文本路径合并（baseTextStyle 在样式数组末位、优先级最高）
    expect(pinyinSource).toMatch(/stylesFallback\.text,[\s\S]*?baseTextStyle,/);
  });
});
