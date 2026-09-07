/**
 * 文本库管理服务（TextLibraryService）
 * 负责加载与查询内置经典文本与用户导入书籍。
 * 内置数据源：src/data/texts/ 下各 JSON（daodejing、lunyu、daxue、zhongyong、
 * mengzi、zhuangzi、shijing、xunzi、chuci、tangshi 十部 + zhouyi、zuozhuan、
 * shiji、tongjian、mozi、wenxuan 六部扩充，共 16 部）。
 * 用户书籍：由 UserBookService 启动时经 registerUserBooks 注册进来。
 * App 启动时全量加载并缓存，离线可用。
 */
import type {
  Book,
  BookCategory,
  Category,
  Chapter,
  ServiceResult,
  TextSegment,
} from '@/types';

import daodejingData from '@/data/texts/daodejing.json';
import lunyuData from '@/data/texts/lunyu.json';
import daxueData from '@/data/texts/daxue.json';
import zhongyongData from '@/data/texts/zhongyong.json';
import mengziData from '@/data/texts/mengzi.json';
import zhuangziData from '@/data/texts/zhuangzi.json';
import shijingData from '@/data/texts/shijing.json';
import xunziData from '@/data/texts/xunzi.json';
import chuciData from '@/data/texts/chuci.json';
import tangshiData from '@/data/texts/tangshi.json';
import zhouyiData from '@/data/texts/zhouyi.json';
import zuozhuanData from '@/data/texts/zuozhuan.json';
import shijiData from '@/data/texts/shiji.json';
import tongjianData from '@/data/texts/tongjian.json';
import moziData from '@/data/texts/mozi.json';
import wenxuanData from '@/data/texts/wenxuan.json';

/** 内置书籍原始数据（16 部：经部 7 部 + 史部 2 部 + 子部 4 部 + 集部 3 部） */
const RAW_BOOKS = [
  daodejingData,
  lunyuData,
  daxueData,
  zhongyongData,
  mengziData,
  zhuangziData,
  shijingData,
  xunziData,
  chuciData,
  tangshiData,
  zhouyiData,
  zuozhuanData,
  shijiData,
  tongjianData,
  moziData,
  wenxuanData,
];

/** 书籍缓存（惰性构建） */
let booksCache: Book[] | null = null;
/** 章节索引：chapterId -> Chapter */
let chapterIndex: Map<string, Chapter> | null = null;
/** 段落索引：segmentId -> TextSegment */
let segmentIndex: Map<string, TextSegment> | null = null;
/** 用户上传书籍（UserBookService 经 registerUserBooks 注册） */
let userBooks: Book[] = [];

/** 用户书籍前缀（UserBookService 生成的 bookId 约定） */
export const USER_BOOK_PREFIX = 'user-';

/** 分类列表（经/史/子/集 + 用户上传） */
const CATEGORIES: Category[] = [
  { key: 'jing', label: '经' },
  { key: 'shi', label: '史' },
  { key: 'zi', label: '子' },
  { key: 'ji', label: '集' },
  { key: 'user', label: '书' },
];

/** 构建完整书籍列表（内置在前，用户书在后；含缓存） */
function buildBooks(): Book[] {
  if (booksCache) {
    return booksCache;
  }
  booksCache = [...(RAW_BOOKS as Book[]), ...userBooks];
  return booksCache;
}

/** 构建章节/段落索引 */
function buildIndexes(): void {
  if (chapterIndex && segmentIndex) {
    return;
  }
  const chapters = new Map<string, Chapter>();
  const segments = new Map<string, TextSegment>();
  for (const book of buildBooks()) {
    for (const chapter of book.chapters) {
      chapters.set(chapter.id, chapter);
      for (const segment of chapter.segments) {
        segments.set(segment.id, segment);
      }
    }
  }
  chapterIndex = chapters;
  segmentIndex = segments;
}

/** 判定是否用户上传书籍 */
export function isUserBookId(id: string): boolean {
  return id.startsWith(USER_BOOK_PREFIX);
}

/** 注册（整体替换）用户书籍列表，并重建缓存与全部索引 */
function registerUserBooks(books: Book[]): ServiceResult<null> {
  try {
    for (const b of books) {
      if (!isUserBookId(b.id)) {
        return { success: false, error: `用户书籍 ID 必须以 ${USER_BOOK_PREFIX} 开头：${b.id}` };
      }
      if (!Array.isArray(b.chapters)) {
        return { success: false, error: `书籍章节列表无效：${b.id}` };
      }
    }
    userBooks = books;
    booksCache = null;
    chapterIndex = null;
    segmentIndex = null;
    buildBooks();
    buildIndexes();
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** 按分类过滤书籍 */
function filterByCategory(books: Book[], category?: BookCategory): Book[] {
  if (!category) {
    return books;
  }
  return books.filter((b) => b.category === category);
}

export const TextLibraryService = {
  /** 获取全部书籍（可按分类过滤） */
  getBooks(category?: BookCategory): ServiceResult<Book[]> {
    try {
      const books = filterByCategory(buildBooks(), category);
      return { success: true, data: books };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 获取单本书籍 */
  getBook(id: string): ServiceResult<Book> {
    if (!id) {
      return { success: false, error: '书籍 ID 不能为空' };
    }
    const book = buildBooks().find((b) => b.id === id);
    if (!book) {
      return { success: false, error: `未找到书籍：${id}` };
    }
    return { success: true, data: book };
  },

  /** 获取章节（含全部段落） */
  getChapter(chapterId: string): ServiceResult<Chapter> {
    if (!chapterId) {
      return { success: false, error: '章节 ID 不能为空' };
    }
    buildIndexes();
    const chapter = chapterIndex!.get(chapterId);
    if (!chapter) {
      return { success: false, error: `未找到章节：${chapterId}` };
    }
    return { success: true, data: chapter };
  },

  /** 获取单个段落 */
  getSegment(segmentId: string): ServiceResult<TextSegment> {
    if (!segmentId) {
      return { success: false, error: '段落 ID 不能为空' };
    }
    buildIndexes();
    const segment = segmentIndex!.get(segmentId);
    if (!segment) {
      return { success: false, error: `未找到段落：${segmentId}` };
    }
    return { success: true, data: segment };
  },

  /** 获取章节在书籍中的相邻章节（用于上一篇/下一篇） */
  getSiblingChapters(
    chapterId: string,
  ): ServiceResult<{ prev?: Chapter; next?: Chapter }> {
    try {
      const res = this.getChapter(chapterId);
      if (!res.success || !res.data) {
        return { success: false, error: res.error };
      }
      const chapter = res.data;
      const bookRes = this.getBook(chapter.bookId);
      if (!bookRes.success || !bookRes.data) {
        return { success: false, error: bookRes.error };
      }
      const chapters = bookRes.data.chapters;
      const idx = chapters.findIndex((c) => c.id === chapterId);
      if (idx < 0) {
        return { success: false, error: '章节不在所属书籍中' };
      }
      return {
        success: true,
        data: {
          prev: idx > 0 ? chapters[idx - 1] : undefined,
          next: idx < chapters.length - 1 ? chapters[idx + 1] : undefined,
        },
      };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 获取分类列表 */
  getCategories(): ServiceResult<Category[]> {
    return { success: true, data: CATEGORIES };
  },

  /** 按关键词遍历全部段落（供 SearchService 内存搜索回退使用） */
  allSegments(): ServiceResult<TextSegment[]> {
    try {
      const segments: TextSegment[] = [];
      for (const book of buildBooks()) {
        for (const chapter of book.chapters) {
          segments.push(...chapter.segments);
        }
      }
      return { success: true, data: segments };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /**
   * 注册（整体替换）用户上传书籍，重建全部索引（含搜索）。
   * 仅供 UserBookService 调用；ID 必须以 user- 开头。
   */
  registerUserBooks,

  /** 判定是否用户上传书籍 */
  isUserBook: isUserBookId,
};

export default TextLibraryService;
