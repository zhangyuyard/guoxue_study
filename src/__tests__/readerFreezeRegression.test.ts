/**
 * 阅读器冻结 Bug 回归防护测试（源码结构断言）
 * Bug：点击底部「阅读」Tab 后 ReaderScreen 陷入 setState 无限循环。
 * 根因：
 *   1) ContinueReadingScreen 每次渲染内联新建 route 对象；
 *   2) ReaderScreen 初始化 useEffect 以对象引用 params 作依赖；
 *   3) openChapter 无幂等守卫，lastRead 每次写入新引用形成级联循环。
 * 本文件以源码断言锁定三处修复点，防止后续改动回退。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

describe('ReaderScreen：初始化 useEffect 依赖必须为原始值', () => {
  const source = readSrc('screens/ReaderScreen.tsx');

  test('segmentId 已从 params 提取为原始值变量', () => {
    expect(source).toMatch(
      /const segmentId = params\?\.segmentId \?\? null;/,
    );
  });

  test('初始化 useEffect 依赖数组为 [bookId, chapterId, segmentId]', () => {
    // openChapter 调用所在的初始化 effect，其依赖必须是三个原始值
    expect(source).toMatch(
      /\}, \[bookId, chapterId, segmentId\]\);/,
    );
  });

  test('不存在以对象引用作依赖的 useEffect（params / route / lastRead）', () => {
    const objectRefDeps = source.match(/\}, \[(?:params|route|lastRead)\]\);/g);
    expect(objectRefDeps).toBeNull();
  });
});

// ContinueReadingScreen 已随「阅读」Tab 移除；其冻结防护由 ReaderScreen
// 与 openChapter 两处断言覆盖（见上方 describe 块）。

describe('openChapter：幂等守卫逻辑', () => {
  const source = readSrc('store/useReaderStore.ts');

  test('守卫覆盖 bookId / chapterId / segmentId / lastRead 四个维度', () => {
    expect(source).toMatch(/state\.bookId === bookId/);
    expect(source).toMatch(/state\.chapterId === chapterId/);
    expect(source).toMatch(/state\.segmentId === nextSegmentId/);
    expect(source).toMatch(/state\.lastRead !== null/);
    expect(source).toMatch(/state\.lastRead\.bookId === bookId/);
    expect(source).toMatch(/state\.lastRead\.chapterId === chapterId/);
  });

  test('segmentId 归一化：undefined 统一为 null 后再参与比较', () => {
    // 保证 openChapter(book, chap) 与 openChapter(book, chap, undefined)
    // 不会因 undefined !== null 而绕过幂等守卫
    expect(source).toMatch(/const nextSegmentId = segmentId \?\? null;/);
  });
});
