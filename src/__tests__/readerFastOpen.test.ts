/**
 * 阅读器「首开提速」接线断言（源码文本即断言）。
 *
 * 回归背景（2026-10-08 真机实证）：
 * 阅读器 loadChapterData 走的是 ensureBookLoaded —— 它 await
 * loadBuiltinBookBody（**整本读取 + 全文解析**）后才 resolve。实测耗时与书体
 * 字节强线性 ≈1.5 s/MB：
 *   大学 7.5KB→1.38s ／ 史记 1.87MB→4.34s ／ 三国志 2.17MB→4.48s
 *   ／ 汉书 4.22MB→7.60s ／ 资治通鉴 9.47MB→**16.24s**
 * 期间 UI 树只有 3 个节点（顶部章栏+返回），正文区 0 行（整屏空白）。
 * 反证：等 FTS 全库索引队列真正跑完（累计 77 本不再增长）后再点书，白屏仍
 * 15.82s ⇒ 排除 FTS 抢占（数值与 [fts] tongjian +15173ms 吻合只是巧合）。
 *
 * 根因：为阅读器写的「首章优先快速水合」ensureBookReady（meta 按章切片读，
 * 只装配目标章 + 后台填充其余空壳章）**只在测试里被调用**，生产零消费。
 *
 * 修复：阅读器改调 ensureBookReady(bookId, { priorityChapterId: cid })，并对
 * 「后台尚未填充到的空壳章」用 degradeChapterToWholeRead 按需整章直读兜底。
 * 上述两点都不报错不红灯（调用错也照常返回书体），只能靠接线断言锁住。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');
const USER_BOOK_SERVICE_PATH = resolve(APP_ROOT, 'services/UserBookService.ts');

describe('阅读器首开提速：接线断言', () => {
  const readerSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
  const serviceSrc = stripComments(readFileSync(USER_BOOK_SERVICE_PATH, 'utf8'));

  it('阅读器不再走整本解析水合（ensureBookLoaded 在 ReaderScreen 内已 0 引用）', () => {
    // 旧根因：ensureBookLoaded 整本解析完才 resolve ⇒ 9.47MB 书首屏 16s。
    expect(countOf(readerSrc, 'UserBookService.ensureBookLoaded')).toBe(0);
    // 阴性对照（同范围正对照）：该 API 本身必须仍存在且仍导出 —— 证明上面的 0
    // 不是「文件里根本没有这个词」造成的假阴性。
    expect(countOf(serviceSrc, 'export async function ensureBookLoaded(')).toBe(1);
    expect(countOf(serviceSrc, '  ensureBookLoaded,')).toBe(1);
  });

  it('阅读器改走首章优先快速水合，并把目标章 id 传下去', () => {
    expect(countOf(readerSrc, 'UserBookService.ensureBookReady(bookId, {')).toBe(1);
    // priorityChapterId 必须传 cid（当前正要装载的章）——传 null/常量都会让
    // 快路径去装配第一章，跳章首屏依旧空白。
    expect(countOf(readerSrc, 'priorityChapterId: cid')).toBe(1);
    // 服务侧契约：ensureBookReady 仍在聚合导出表内（否则 UserBookService 上取不到）
    expect(countOf(serviceSrc, '  ensureBookReady,')).toBe(1);
  });

  it('空壳章兜底：segments 为空的章走按需整章直读并重取一次', () => {
    // 恰 2 处：①首次判空（决定是否触发兜底）②兜底后复判（仍空 ⇒ 抛错）
    expect(countOf(readerSrc, 'segments.length === 0')).toBe(2);
    expect(countOf(readerSrc, 'UserBookService.degradeChapterToWholeRead(')).toBe(1);
    // 兜底必须**重取**章数据：degradeChapterToWholeRead 是整体替换 segments，
    // 不重取则渲染的还是那份空数组。
    // 剔掉首取那一行后再数：剩下的恰 1 处 = 兜底后的重取（两行文本互为子串，
    // 直接数会得 2，等于没锁住重取）。
    const withoutFirst = readerSrc.replace(
      'let chapterRes = TextLibraryService.getChapter(cid);',
      '',
    );
    expect(countOf(withoutFirst, 'chapterRes = TextLibraryService.getChapter(cid)')).toBe(1);
    // 服务侧契约：该出口在聚合导出表内（漏登记 ⇒ 运行时 TypeError）
    expect(countOf(serviceSrc, '  degradeChapterToWholeRead,')).toBe(1);
  });

  it('兜底失败时给出可感知错误态（不静默渲染空白页）', () => {
    expect(countOf(readerSrc, "throw new Error('章节正文加载失败')")).toBe(1);
  });
});
