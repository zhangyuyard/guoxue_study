/**
 * 阅读器体验升级（对标微信读书 / 番茄）源码结构断言
 * 锁定三处关键改造，防止回退：
 *   1) 阅读器配色改用阅读纸张 getPaperColors(paper)，不再耦合全局 theme；
 *   2) 顶部书名可打开目录抽屉（TOC）；
 *   3) 底部存在阅读进度（第 N/共 M 章 + 进度条）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');
const source = readFileSync(join(SRC_ROOT, 'screens/ReaderScreen.tsx'), 'utf-8');

describe('阅读器配色：改用阅读纸张（与全局 theme 解耦）', () => {
  test('colors 由 getPaperColors(paper) 计算', () => {
    expect(source).toMatch(/getPaperColors\(paper\)/);
  });

  test('不再引用全局 setTheme / ThemeMode（换肤已独立为 paper）', () => {
    expect(source).not.toMatch(/setTheme\(/);
    expect(source).not.toMatch(/as ThemeMode/);
    expect(source).not.toMatch(/getColors\(/);
  });
});

describe('目录抽屉（TOC）', () => {
  test('点击顶部书名打开目录（setTocVisible(true)）', () => {
    expect(source).toMatch(/setTocVisible\(true\)/);
  });

  test('目录 Modal 渲染整书章节列表（book?.chapters）', () => {
    expect(source).toMatch(/tocVisible/);
    expect(source).toMatch(/book\?\.chapters/);
  });
});

describe('阅读进度', () => {
  test('计算整体进度 overallProgress 并渲染进度条 progressFill', () => {
    expect(source).toMatch(/overallProgress/);
    expect(source).toMatch(/progressFill/);
  });
});
