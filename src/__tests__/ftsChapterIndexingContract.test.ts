/**
 * FTS 章级索引契约（从 readerBugfixRegression.test.ts 迁出）
 *
 * 迁移背景：`readerBugfixRegression.test.ts` 整体属于「跳章 / 翻页 / 跨章拼接 /
 * 定位落位 / 视口补偿」已删族，随该族一并删除（依据
 * `docs/reader-cleanup-plan-2026-09-22.md` §4.4）。其中用例 ④ / ⑤ 覆盖的是
 * **保留族 FTS 章级增量**（`R38_FTS_PER_CHAPTER` / `writeFtsForReadyChapter` /
 * `isBookFullyIndexedInFts`），与阅读器视口无关 ⇒ 逐字迁出到本文件，避免
 * 「FTS 写入门控」这条真实契约随族删除而失去回归防护。
 *
 * 用例名与断言逐字保留（仅做了 import / helper 的必要适配：不再读取
 * `screens/ReaderScreen.tsx`，只读取 `services/UserBookService.ts`）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const usSource = readSrc('services/UserBookService.ts');

/** 截取从 header 起、到下一个顶格 `}` 为止的函数源码（含两端） */
function extractBlock(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) {
    return '';
  }
  const end = src.indexOf('\n}', start);
  return end > start ? src.slice(start, end + 2) : src.slice(start);
}

describe('FTS 章级索引契约（保留族 FTS，非阅读器视口）', () => {
  test('④ 章 READY_FULL 之后才调 upsertFtsForChapter（章级增量，失败静默降级）', () => {
    const fillBody = extractBlock(
      usSource,
      'async function fillRemainingBuiltinChapters(',
    );
    // 【R2-2/G7】此处**不再用字面文本锁死**「READY_FULL 判定点」的位置——
    // 旧断言 `indexOf("if (step !== 'progress') {")` 把「failed 也写 FTS」的
    // 缺陷锁死成了「正确」（G7 指出的问题）。
    // 行为级守卫改在 UserBookService.builtinResilience.test.ts 的
    // 「R2-1/R2-2/G7」用例：注入切片段读失败 + spy upsertFtsForChapter，
    // 断言 Partial/失败章**未被写 FTS**。此处仅保留接口契约断言：
    // 填充路径必须显式经 ready 判据调用 writeFtsForReadyChapter（不得旁路）。
    expect(fillBody).toMatch(/writeFtsForReadyChapter\(spec, shell\);/);
    expect(fillBody).toMatch(/if \(\s*\n\s*step === 'done' &&/);
    expect(fillBody).toMatch(/shell\.failedTerminal !== true/);

    const wBody = extractBlock(usSource, 'function writeFtsForReadyChapter(');
    expect(wBody).not.toBe('');
    // 【#22】写入实现提炼到 writeFtsForChapter（补全链路只有章对象、无壳）：
    //   ready 壳路径仍以「章对象」为唯一写入漏斗（不得旁路 upsertFtsForChapter）
    expect(wBody).toMatch(/writeFtsForChapter\(spec, shell\.chapter\);/);
    const wChapterBody = extractBlock(usSource, 'function writeFtsForChapter(');
    expect(wChapterBody).not.toBe('');
    // 灰度关：整体不写（回落整书分片路径 upsertFtsForBookChunked）
    expect(wChapterBody).toMatch(/if \(!R38_FTS_PER_CHAPTER\) \{\s*\n\s*return;/);
    expect(wChapterBody).toMatch(
      /StorageService\.upsertFtsForChapter\(book\.data, chapter\);/,
    );
    // 写失败静默降级：装配链路不得因检索索引受影响（不得抛错）
    expect(wChapterBody).toMatch(/FTS 写失败静默降级/);
    expect(wChapterBody).not.toMatch(/\bthrow\b/);
  });

  test('⑤ 书级判据切计数式，isBookIndexedInFts（存在即真）语义保留', () => {
    // 章级增量下「写了 1 章」就存在行 → 存在判据会把「只索引了 1 章」
    // 误判为整本已索引，使整书兜底被永久跳过（真·缺章）
    expect(usSource).toMatch(
      /const ftsComplete = R38_FTS_PER_CHAPTER\s*\n\s*\? StorageService\.isBookFullyIndexedInFts\(spec\.id, fillableChapters\)\s*\n\s*: StorageService\.isBookIndexedInFts\(spec\.id\);/,
    );
    // 计数门槛入参必须是「有正文的章数」（空章永不入库，否则计数恒不达标）
    expect(usSource).toMatch(
      /const fillableChapters = shells\.filter\(\s*\n\s*\(s\) => s\.chapter\.segments\.length > 0,\s*\n\s*\)\.length;/,
    );
  });
});
