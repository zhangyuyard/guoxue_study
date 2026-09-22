/**
 * `openChapter` 幂等守卫回归防护（清理后残留面）
 *
 * ── 本文件为何被裁剪（书面理由）────────────────────────────────────────────
 * 原文件还有一个 describe「ReaderScreen：初始化 useEffect 依赖必须为原始值」，
 * 含 3 条对 `screens/ReaderScreen.tsx` 源码文本的断言：
 *   · `const segmentId = params?.segmentId ?? null;`
 *   · `}, [bookId, chapterId, segmentId]);`
 *   · 不存在 `}, [params|route|lastRead]);` 形态的对象引用依赖
 *   · 执行者：cleanup-executor（2026-09-22）；依据
 *     `docs/reader-cleanup-plan-2026-09-22.md` §4/§5/§6（用户裁定「真零起点」）。
 *   · 该 Bug 的**根因载体**（ReaderScreen 初始化 effect 的 params 对象依赖）已随
 *     5430 行实现整体移除，文件现为 56 行空壳 ⇒ 三条断言分别变成假红 / 恒真
 *     ⇒ 按 T7 规则「断言锁的是已删实现的形状 ⇒ 随族删除并写明理由」移除。
 *   · 冻结防护的**真源**并未消失：下方 `openChapter` 幂等守卫（`useReaderStore`）
 *     仍在，且是级联循环的另一半。新阅读器重写时必须自行重新立 effect 依赖断言。
 *
 * ── 保留了什么 ────────────────────────────────────────────────────────────
 * `store/useReaderStore.ts` **未在本次清理中改动**（属保留族：阅读位置存储）。
 * 其幂等守卫是「写新引用 → 无限 setState」这一真实缺陷的承重件：删掉任一比较维度
 * 或把 `?? null` 归一化改掉，下面的断言即变红 ⇒ 保留。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

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
