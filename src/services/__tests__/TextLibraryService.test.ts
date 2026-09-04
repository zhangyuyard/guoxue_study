/**
 * TextLibraryService 章节翻页数据路径回归测试
 * 阅读页「上一章 / 下一章」依赖 getSiblingChapters 返回正确的相邻章节，
 * 此测试锁定该数据路径，避免回归导致「只显示第一章、无法翻页」。
 * 另锁定：内置书目清单（道德经 + B5 批次孟子/庄子/诗经/荀子/楚辞）；
 * 用户书注册后可读、可被 getBooks 枚举。
 */
import {
  TextLibraryService,
  USER_BOOK_PREFIX,
} from '@/services/TextLibraryService';
import type { Book } from '@/types';

/** 构造最小用户书（供注册用例） */
function makeUserBook(id: string): Book {
  return {
    id,
    title: '测试用户书',
    author: '佚名',
    category: 'user',
    description: '测试',
    chapters: [
      {
        id: `${id}-c1`,
        bookId: id,
        title: '第一章',
        order: 1,
        segments: [
          { id: `${id}-c1-s1`, chapterId: `${id}-c1`, order: 1, text: '学而时习之。' },
        ],
      },
    ],
  };
}

describe('TextLibraryService.getSiblingChapters（章节翻页数据路径）', () => {
  test('第一章：无上一章，下一章为第二章', () => {
    const res = TextLibraryService.getSiblingChapters('daodejing-1');
    expect(res.success).toBe(true);
    expect(res.data?.prev).toBeUndefined();
    expect(res.data?.next?.id).toBe('daodejing-2');
  });

  test('中间章：上一章与下一章均存在', () => {
    const res = TextLibraryService.getSiblingChapters('daodejing-2');
    expect(res.data?.prev?.id).toBe('daodejing-1');
    expect(res.data?.next?.id).toBe('daodejing-3');
  });

  test('末章：无下一章，上一章为倒数第二章', () => {
    const bookRes = TextLibraryService.getBook('daodejing');
    const chapters = bookRes.data!.chapters;
    const last = chapters[chapters.length - 1];
    const prev = chapters[chapters.length - 2];
    const res = TextLibraryService.getSiblingChapters(last.id);
    expect(res.success).toBe(true);
    expect(res.data?.prev?.id).toBe(prev.id);
    expect(res.data?.next).toBeUndefined();
  });

  test('未知章节 ID 返回失败', () => {
    const res = TextLibraryService.getSiblingChapters('not-exist-chapter');
    expect(res.success).toBe(false);
  });
});

describe('TextLibraryService 初始内置书目', () => {
  /** 内置书单顺序：道德经 + 论语/大学/中庸 + B5 批次五部 + 唐诗三百首（P2-10 起 10 部全量注册） */
  const BUILTIN_IDS = [
    'daodejing',
    'lunyu',
    'daxue',
    'zhongyong',
    'mengzi',
    'zhuangzi',
    'shijing',
    'xunzi',
    'chuci',
    'tangshi',
  ];

  test('内置书目为 10 部（道德经/论语/大学/中庸/孟子/庄子/诗经/荀子/楚辞/唐诗三百首）', () => {
    const res = TextLibraryService.getBooks();
    expect(res.success).toBe(true);
    expect(res.data!.map((b) => b.id)).toEqual(BUILTIN_IDS);
    expect(res.data![0].chapters).toHaveLength(81);
  });
});

describe('TextLibraryService.registerUserBooks（用户上传书籍注册）', () => {
  test('注册后 getBook/getChapter 可读，且并入 getBooks', () => {
    const book = makeUserBook(`${USER_BOOK_PREFIX}t1`);
    const reg = TextLibraryService.registerUserBooks([book]);
    expect(reg.success).toBe(true);

    const got = TextLibraryService.getBook(`${USER_BOOK_PREFIX}t1`);
    expect(got.success).toBe(true);
    expect(got.data?.title).toBe('测试用户书');
    const seg = TextLibraryService.getSegment(`${USER_BOOK_PREFIX}t1-c1-s1`);
    expect(seg.success).toBe(true);
    expect(seg.data?.text).toBe('学而时习之。');

    const all = TextLibraryService.getBooks();
    expect(all.data!.some((b) => b.id === `${USER_BOOK_PREFIX}t1`)).toBe(true);
  });

  test('非法前缀的书籍拒绝注册且不破坏既有缓存', () => {
    const bad = makeUserBook('bad-prefix');
    const reg = TextLibraryService.registerUserBooks([bad]);
    expect(reg.success).toBe(false);
    // 上一条用例已注册的合法用户书仍可读（整体替换仅在成功时生效）
    expect(TextLibraryService.getBook(`${USER_BOOK_PREFIX}t1`).success).toBe(true);
  });

  test('整体替换：再次注册只保留最新列表', () => {
    const reg = TextLibraryService.registerUserBooks([
      makeUserBook(`${USER_BOOK_PREFIX}t2`),
    ]);
    expect(reg.success).toBe(true);
    expect(TextLibraryService.getBook(`${USER_BOOK_PREFIX}t1`).success).toBe(false);
    expect(TextLibraryService.getBook(`${USER_BOOK_PREFIX}t2`).success).toBe(true);
    // 还原为空列表，避免影响其他用例
    TextLibraryService.registerUserBooks([]);
    expect(TextLibraryService.getBooks().data!.map((b) => b.id)).toEqual([
      'daodejing',
      'lunyu',
      'daxue',
      'zhongyong',
      'mengzi',
      'zhuangzi',
      'shijing',
      'xunzi',
      'chuci',
      'tangshi',
    ]);
  });
});
