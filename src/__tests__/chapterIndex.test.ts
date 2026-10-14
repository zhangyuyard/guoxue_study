/**
 * 「章节改偏移量」B 档 · 步骤 3 判据：删全量段索引，`getSegment` 走章级懒查。
 *
 * 要锁的三件事：
 * ①`chapterIdOfSegment` 反解正确（含 bookId 含 `-s<数字>` 子串的刁钻样本）
 * ②`TextLibraryService.getSegment` 行为与旧「全量 Map」实现**逐段等价**
 * ③形状：`allSegments` 已从服务面消失；`buildIndexes` 不再遍历 segments
 *
 * ⚠ 判据 ③ 用「源码文本计数」而非运行时观测——运行时**无法**区分
 * 「建了全量 Map」与「没建」（两者 `getSegment` 结果完全相同，行为等价）。
 * 而这正是本步骤的**唯一**目标（去掉全量物化）⇒ 只能锁源码形状。
 * 为避免「文本锚点在别处也能解释」，每条形状判据都配**同范围阴性对照**
 * （`getChapter` / `getBooks` 仍各 1 处），证明计数口径不是死零。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { chapterIdOfSegment } from '@/services/chapterIndex';
import { TextLibraryService, USER_BOOK_PREFIX } from '@/services/TextLibraryService';
import type { Book, TextSegment } from '@/types';

function seg(chapterId: string, order: number, text: string): TextSegment {
  return { id: `${chapterId}-s${order}`, chapterId, order, text };
}

/** 构造一本用户书：`segCountPerChapter[i]` = 第 i+1 章的段数 */
function makeUserBook(
  id: string,
  segCountPerChapter: number[],
  tag: string,
): Book {
  return {
    id,
    title: `书-${tag}`,
    author: '佚名',
    category: 'user',
    description: '',
    chapters: segCountPerChapter.map((n, ci) => {
      const chapterId = `${id}-c${ci + 1}`;
      return {
        id: chapterId,
        bookId: id,
        title: `第${ci + 1}章`,
        order: ci + 1,
        segments: Array.from({ length: n }, (_, si) =>
          seg(chapterId, si + 1, `${tag}-c${ci + 1}-s${si + 1}`),
        ),
      };
    }),
  } as Book;
}

describe('chapterIdOfSegment · 段 id 反解章 id', () => {
  it('常规形态：剥掉末尾 -s<数字>', () => {
    expect(chapterIdOfSegment('mengzi-c1-s1')).toBe('mengzi-c1');
    expect(chapterIdOfSegment('mengzi-c294-s12345')).toBe('mengzi-c294');
    expect(chapterIdOfSegment(`${USER_BOOK_PREFIX}abc-c12-s7`)).toBe(
      `${USER_BOOK_PREFIX}abc-c12`,
    );
  });

  it('★bookId 含 `-s<数字>` 子串时只剥最后一层（锚定贪婪，防剥错层）', () => {
    // 反例对照：非贪婪 / 非锚定匹配会返回 'user' 或 'user-s3-c1-s1' 之类
    expect(chapterIdOfSegment('user-s3-c1-s1')).toBe('user-s3-c1');
    expect(chapterIdOfSegment('user-s3-c1-s99')).toBe('user-s3-c1');
    expect(chapterIdOfSegment('a-s1-b-s2-c3-s4')).toBe('a-s1-b-s2-c3');
  });

  it('格式非法一律 null（不抛错，与「章不存在」同口径）', () => {
    expect(chapterIdOfSegment('')).toBeNull();
    expect(chapterIdOfSegment('mengzi-c1')).toBeNull(); // 缺 -s
    expect(chapterIdOfSegment('mengzi-c1-s')).toBeNull(); // -s 无数字
    expect(chapterIdOfSegment('mengzi-c1-sx')).toBeNull(); // 非数字
    expect(chapterIdOfSegment('mengzi-c1-s1x')).toBeNull(); // 后缀有残留
    expect(chapterIdOfSegment('-s1')).toBeNull(); // 剥出空串
    expect(chapterIdOfSegment(undefined as unknown as string)).toBeNull();
  });
});

describe('TextLibraryService.getSegment · 章级懒查与旧实现逐段等价', () => {
  const A = `${USER_BOOK_PREFIX}zsA`;
  const B = `${USER_BOOK_PREFIX}zsB`;
  // A：3 章 × 段数不等（含空章）；B：单章。bookId 刻意不含 `-s` 歧义，
  // 歧义样本由上方纯函数组覆盖。
  const books = [makeUserBook(A, [3, 0, 2], '甲'), makeUserBook(B, [4], '乙')];

  beforeAll(() => {
    const reg = TextLibraryService.registerUserBooks(books);
    expect(reg.success).toBe(true);
  });

  it('注册后可枚举到的每一个段 id 都能被 getSegment 命中，且 text 一致', () => {
    let checked = 0;
    for (const book of books) {
      for (const chapter of book.chapters) {
        for (const s of chapter.segments) {
          const got = TextLibraryService.getSegment(s.id);
          expect(got.success).toBe(true);
          expect(got.data?.text).toBe(s.text);
          expect(got.data?.chapterId).toBe(chapter.id);
          checked += 1;
        }
      }
    }
    // 阳性对照：确实逐段查到了（若实现退化为「恒返回失败」则此处为 0）
    expect(checked).toBe(9);
  });

  it('跨书不串：甲书的段不会被乙书的章吞掉', () => {
    expect(TextLibraryService.getSegment(`${A}-c1-s1`).data?.text).toBe('甲-c1-s1');
    expect(TextLibraryService.getSegment(`${B}-c1-s1`).data?.text).toBe('乙-c1-s1');
  });

  it('未注册 / 空章 / 越界段一律 success=false（旧实现同口径）', () => {
    expect(TextLibraryService.getSegment(`${A}-c1-s99`).success).toBe(false); // 越界
    expect(TextLibraryService.getSegment(`${A}-c2-s1`).success).toBe(false); // 空章
    expect(TextLibraryService.getSegment(`${USER_BOOK_PREFIX}none-s1`).success).toBe(
      false,
    ); // 书不存在
    expect(TextLibraryService.getSegment('malformed').success).toBe(false); // 格式非法
    expect(TextLibraryService.getSegment('').success).toBe(false); // 空串
  });

  it('getChapter / getSiblingChapters 不因段索引降级而退化', () => {
    expect(TextLibraryService.getChapter(`${A}-c3`).success).toBe(true);
    const sib = TextLibraryService.getSiblingChapters(`${A}-c1`);
    expect(sib.success).toBe(true);
    expect(sib.data?.prev).toBeUndefined();
    expect(sib.data?.next?.id).toBe(`${A}-c2`);
  });
});

describe('运行时判据：注册过程不得触碰 segments（不靠文本，靠 getter 计数）', () => {
  it('registerUserBooks 全程不读任何 chapter.segments', () => {
    // 为什么必须运行时判据：上面的源码文本断言只能锁**字面量**，
    // 一次「忠实实现但换了写法」的物化（如 `Object.values(chapter).flat()`）
    // 就能让文本计数全绿而行为已回退。变异自证 M4 正是这么活下来的（红 0）。
    // ⇒ 这里直接数「`.segments` 属性被读取了几次」。
    let reads = 0;
    const chapter = {
      id: `${USER_BOOK_PREFIX}probe-c1`,
      bookId: `${USER_BOOK_PREFIX}probe`,
      title: '第1章',
      order: 1,
      segCount: 2,
      charCount: 6,
    };
    // 用 getter 替换 data 属性上的 segments：任何读取都会计数
    const payload = [seg(`${USER_BOOK_PREFIX}probe-c1`, 1, '甲'), seg(`${USER_BOOK_PREFIX}probe-c1`, 2, '乙')];
    Object.defineProperty(chapter, 'segments', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return payload;
      },
    });
    const probe = { ...makeBookShell(), chapters: [chapter] } as Book;

    const reg = TextLibraryService.registerUserBooks([probe]);
    expect(reg.success).toBe(true);
    // 注册是「零段读取」的那一步
    expect(reads).toBe(0);

    // 阳性对照：真正读段的那一步（getSegment）**必须**读一次 getter。
    // 没有这条，上面的 0 就可能是「getter 没装上」的假零。
    const got = TextLibraryService.getSegment(`${USER_BOOK_PREFIX}probe-c1-s2`);
    expect(got.success).toBe(true);
    expect(got.data?.text).toBe('乙');
    expect(reads).toBeGreaterThan(0);
  });
});

/** 造一个除 chapters 外的最小 Book 壳 */
function makeBookShell(): Omit<Book, 'chapters'> {
  return {
    id: `${USER_BOOK_PREFIX}probe`,
    title: '探针书',
    author: '佚名',
    category: 'user',
    description: '',
  } as unknown as Omit<Book, 'chapters'>;
}

describe('形状：全量段聚合器已下线（源码文本即断言）', () => {
  const APP_ROOT = resolve(__dirname, '..');
  // ⚠ 计数一律基于**去注释后**的源码：本步骤在实现里写了大量解释性注释
  // （含 `allSegments` 这个词），若按原始文本计数，注释里的字样会把判据数红，
  // 逼着后人删注释或改判据——那是本末倒置（判据应锁**代码**，不锁注释）。
  // 与 `readerFastOpen.test.ts` 同口径。
  const libSrc = stripComments(
    readFileSync(resolve(APP_ROOT, 'services/TextLibraryService.ts'), 'utf8'),
  );
  const storeSrc = stripComments(
    readFileSync(resolve(APP_ROOT, 'services/StorageService.ts'), 'utf8'),
  );
  const chapterIndexSrc = stripComments(
    readFileSync(resolve(APP_ROOT, 'services/chapterIndex.ts'), 'utf8'),
  );
  const both = libSrc + storeSrc;

  const countOf = (src: string, needle: string) => src.split(needle).length - 1;

  it('allSegments 在服务面与调用面同时消失', () => {
    expect(countOf(libSrc, 'allSegments')).toBe(0);
    // StorageService 那次调用是**丢弃调用**（返回的 data 从未被读，只判 success）
    expect(countOf(storeSrc, 'allSegments')).toBe(0);
    // 阴性对照：同文件同范围，`getChapter`（1 处定义 + 1 处内部调用 = 2）与
    // `getBooks`（1 处定义）仍在 ⇒ 上面两个 0 不是「文件里根本没有这个词」
    // 造成的假阴性。⚠ 对照锚点必须**实测**过：初版用 `getBooks > 1`，实测
    // 去注释后只有 1 处（服务内部不自调 getBooks）⇒ 判据自身写错，已按读数改。
    expect(countOf(libSrc, 'getChapter')).toBe(2);
    expect(countOf(libSrc, 'getBooks')).toBe(1);
    expect(countOf(storeSrc, 'TextLibraryService.getBooks')).toBeGreaterThan(0);
    expect(countOf(storeSrc, '无法读取文本库')).toBe(1);
  });

  it('buildIndexes 不再遍历 segments（段 Map 已删）', () => {
    // 只建章索引：函数体内不应再有 segments
    const fnStart = libSrc.indexOf('function buildIndexes()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = libSrc.slice(fnStart, libSrc.indexOf('\n}', fnStart));
    expect(countOf(fnBody, 'segments')).toBe(0);
    expect(countOf(libSrc, 'segmentIndex')).toBe(0);
    // 阴性对照：章索引仍在（否则 getChapter/getSegment 都无从查起）
    expect(countOf(fnBody, 'chapterIndex = chapters')).toBe(1);
  });

  it('章 id 反解已接线到 getSegment（不是只写了纯函数没用）', () => {
    expect(countOf(libSrc, 'chapterIdOfSegment')).toBe(2); // import + 调用
    expect(countOf(libSrc, 'import { chapterIdOfSegment }')).toBe(1);
    // 阴性对照：纯函数模块本身确实存在且导出该函数
    expect(countOf(chapterIndexSrc, 'export function chapterIdOfSegment')).toBe(1);
  });

  it('StorageService 侧：FTS 索引不再依赖「先物化全书段」', () => {
    // ensureFtsIndex 内不得再有 allSegments 触发的全量物化
    const f = storeSrc.slice(
      storeSrc.indexOf('export function ensureFtsIndex'),
      storeSrc.indexOf('export function upsertFtsForBook'),
    );
    expect(countOf(f, 'allSegments')).toBe(0);
    // 阴性对照：该函数仍在、且仍按 book 逐本建 FTS 行（口径未变）
    expect(countOf(f, 'buildFtsRows(book)')).toBe(1);
    expect(both).toContain('FTS_MAX_BOOK_CHARS');
  });
});

/** 去掉块注释与行注释，避免注释里的字样被计入形状计数 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
