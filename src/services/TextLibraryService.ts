/**
 * 文本库管理服务（TextLibraryService）
 * 负责加载与查询内置经典文本与用户导入书籍。
 * 内置数据源（2026-09 资产化改造）：APK assets/books/<id>.txt（@@CH@@ 标记
 * 文本，77 部全本，见 scripts/build-builtin-assets.mjs 与 builtinCatalog.ts）。
 * 首启由 UserBookService 物化到 guoxue-books/builtin/ 并解析，
 * 经 registerBuiltinBooks 注册进来；bundle 不再携带任何书体 JSON。
 * 用户书籍：由 UserBookService 启动时经 registerUserBooks 注册进来。
 * App 启动时只注册内置书的目录元数据（书架即刻完整可见），全文按需经
 * UserBookService.ensureBookLoaded 单本水合（hydrateBook，LRU 上限内常驻），
 * 用户书籍由 UserBookService 启动时经 registerUserBooks 全量注册进来。
 * 离线可用；常驻内存与书籍总量解耦（约 8 部书的正文 + 全部目录）。
 */
import type {
  Book,
  BookCategory,
  Category,
  Chapter,
  ServiceResult,
  TextSegment,
} from '@/types';
import { chapterIdOfSegment } from '@/services/chapterIndex';

/** 内置书（UserBookService 启动时经 registerBuiltinBooks 注册，初始为空）。
 * 注册的是「元数据书」：chapters 仅含目录（id/title/order，segments 空），
 * 全文由 ensureBookLoaded 水合（hydrateBook），LRU 超限后卸载回元数据态。 */
let builtinBooks: Book[] = [];

/** 被用户删除（抑制）的内置书 ID 集合（UserBookService 启动时经 setSuppressedBuiltins 注入） */
let suppressedBuiltins: Set<string> = new Set();

/** 元数据章节快照（id -> 目录章节）：卸载（evict）时把该书章节重置回目录态 */
const builtinMetaChapters = new Map<string, Book['chapters']>();

/** 已水合内置书的 LRU 序（尾部最新；超过上限淘汰头部） */
const hydratedOrder: string[] = [];

/** 内存中最多保留多少部「全文已水合」的内置书（单部最大约 2.5MB 文本，
 * 对象膨胀后 ~10MB；8 部上限把常驻内存从全量 ~150MB 压到 ~80MB 以下，
 * 且覆盖「正在读 A 书 + 预取 B 书」的全部真实场景） */
const MAX_HYDRATED_BUILTINS = 8;

/** 书籍缓存（惰性构建） */
let booksCache: Book[] | null = null;
/** 章节索引：chapterId -> Chapter（**只索引章，不索引段**） */
let chapterIndex: Map<string, Chapter> | null = null;
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

/** 构建完整书籍列表（未被删除的内置书在前，用户书在后；含缓存） */
function buildBooks(): Book[] {
  if (booksCache) {
    return booksCache;
  }
  const builtins = builtinBooks.filter((b) => !suppressedBuiltins.has(b.id));
  booksCache = [...builtins, ...userBooks];
  return booksCache;
}

/**
 * 构建章节索引（**章级**：只登记 chapterId -> Chapter）。
 *
 * ★2026-10-12（原 `buildIndexes` 的段级实现已下线）：旧实现在这里额外建
 * `Map<segmentId, TextSegment>`，代价是**每次注册/水合/淘汰/抑制变更都要把
 * 全书 `chapter.segments` 遍历一遍**。而全书段实体数组的存在正是「整本书正文
 * 必须全量驻留内存」的根源（书架冷启读 12.78MB 缓存耗时 6275ms 即由此而来）。
 *
 * 段查询改为**按需在单章内线性查找**（`getSegment`）：段 id 形如
 * `${chapterId}-s${n}` ⇒ 先反解出章 id（`chapterIdOfSegment`），再取该章，
 * 章内段数是几十量级 ⇒ 复杂度 O(章内段数)，**不再要求全书段已物化**。
 * 这为「章节改偏移量」铺路：段未装载时本章退化为空数组，查找只是 miss，
 * 而不会在索引构建阶段就强制整本展开。
 */
function buildIndexes(): void {
  if (chapterIndex) {
    return;
  }
  const chapters = new Map<string, Chapter>();
  for (const book of buildBooks()) {
    for (const chapter of book.chapters) {
      chapters.set(chapter.id, chapter);
    }
  }
  chapterIndex = chapters;
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
    buildBooks();
    buildIndexes();
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 注册（整体替换）内置书籍列表，重建缓存与全部索引。
 * 仅供 UserBookService 调用：传入的是「元数据书」（chapters 仅目录、
 * segments 空），全文按需经 hydrateBook 水合。同时重置 LRU 水合态
 * （重注册意味着书体来源整体更换，旧的全文状态全部作废）。
 */
function registerBuiltinBooks(books: Book[]): ServiceResult<null> {
  try {
    for (const b of books) {
      if (isUserBookId(b.id)) {
        return {
          success: false,
          error: `内置书籍 ID 不得使用用户书前缀 ${USER_BOOK_PREFIX}：${b.id}`,
        };
      }
      if (!Array.isArray(b.chapters)) {
        return { success: false, error: `书籍章节列表无效：${b.id}` };
      }
    }
    builtinBooks = books;
    builtinMetaChapters.clear();
    hydratedOrder.length = 0;
    for (const b of books) {
      builtinMetaChapters.set(b.id, b.chapters);
    }
    booksCache = null;
    chapterIndex = null;
    buildBooks();
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 【D3】书体正文被卸载时的释放回调登记（LRU 淘汰 + 显式 evictBook）。
 *
 * 存在的理由：`hydrateBook` 的 LRU 与 `evictBook` 通过「换掉 book.chapters
 * 数组」回收正文——若上层（UserBookService 的流式游标登记 / 空闲扩散上下文）
 * 仍持有壳与 `shell.chapter`，整本 chapters 数组就被钉住，回收实际不生效。
 * 上层在此注册回调清引用；本模块**不反向依赖**上层（避免循环导入）。
 * 回调异常不得影响书体卸载本身。
 */
const bookEvictListeners = new Set<(bookId: string) => void>();

/** 注册「书体被淘汰/卸载」回调；返回取消注册函数 */
function onBookEvicted(cb: (bookId: string) => void): () => void {
  bookEvictListeners.add(cb);
  return () => {
    bookEvictListeners.delete(cb);
  };
}

/** 通知所有回调（单个回调异常不影响其余回调与卸载流程） */
function notifyBookEvicted(bookId: string): void {
  bookEvictListeners.forEach((cb) => {
    try {
      cb(bookId);
    } catch {
      // 释放失败不影响书体卸载（下轮 LRU 会再次触发）
    }
  });
}

/**
 * 水合内置书：用「含全文」的书体替换同 id 的元数据书（章节对象整体
 * 换新，引用类数据无迁移问题）。记录 LRU，超限时淘汰最久未用且非本次
 * 水合的书（其章节重置回目录态——目录仍在，仅正文不可读，再次进入时
 * 由 ensureBookLoaded 重新水合）。用户书不走此路径（始终全量注册）。
 * 淘汰后触发 onBookEvicted 回调（D3：上层释放壳/章引用）。
 */
function hydrateBook(book: Book): ServiceResult<null> {
  try {
    if (isUserBookId(book.id)) {
      return { success: false, error: `用户书不支持水合：${book.id}` };
    }
    if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
      return { success: false, error: `水合书体无效：${book.id}` };
    }
    const meta = builtinMetaChapters.get(book.id);
    if (!meta) {
      return { success: false, error: `水合目标不在内置目录中：${book.id}` };
    }
    const idx = builtinBooks.findIndex((b) => b.id === book.id);
    if (idx < 0) {
      return { success: false, error: `水合目标未注册：${book.id}` };
    }
    builtinBooks[idx] = book;
    // LRU 记账：本次水合置为最新；淘汰最旧的（绝不动刚水合的这本）
    const pos = hydratedOrder.indexOf(book.id);
    if (pos >= 0) {
      hydratedOrder.splice(pos, 1);
    }
    hydratedOrder.push(book.id);
    while (hydratedOrder.length > MAX_HYDRATED_BUILTINS) {
      const evictId = hydratedOrder[0];
      if (evictId === book.id) {
        break;
      }
      const evIdx = builtinBooks.findIndex((b) => b.id === evictId);
      if (evIdx >= 0 && builtinMetaChapters.has(evictId)) {
        builtinBooks[evIdx] = {
          ...builtinBooks[evIdx],
          chapters: builtinMetaChapters.get(evictId)!,
        };
        // 【D3】通知上层释放壳/章引用：否则被淘汰的 chapters 数组仍被钉住
        notifyBookEvicted(evictId);
      }
      hydratedOrder.shift();
    }
    booksCache = null;
    chapterIndex = null;
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * 卸载内置书全文（重置回元数据目录态）。仅对已水合的内置书生效；
 * 用于后台 FTS 索引队列等「用完即走」的批量场景，把批量解析的内存
 * 峰值压回单本级别。目录态书籍的章节仍在（目录/计数可正常展示）。
 */
function evictBook(bookId: string): ServiceResult<null> {
  try {
    const pos = hydratedOrder.indexOf(bookId);
    if (pos < 0) {
      return { success: true, data: null };
    }
    const meta = builtinMetaChapters.get(bookId);
    const idx = builtinBooks.findIndex((b) => b.id === bookId);
    if (idx >= 0 && meta) {
      builtinBooks[idx] = { ...builtinBooks[idx], chapters: meta };
      // 【D3】通知上层释放壳/章引用（与 LRU 淘汰同口径）
      notifyBookEvicted(bookId);
    }
    hydratedOrder.splice(pos, 1);
    booksCache = null;
    chapterIndex = null;
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** 该内置书全文是否已水合（元数据书 segments 为空，正文不可读） */
function isBookHydrated(bookId: string): boolean {
  return hydratedOrder.includes(bookId);
}

/** 按分类过滤书籍 */
function filterByCategory(books: Book[], category?: BookCategory): Book[] {
  if (!category) {
    return books;
  }
  return books.filter((b) => b.category === category);
}

/**
 * 设置被删除（抑制）的内置书 ID 集合，重建缓存与全部索引。
 * 仅供 UserBookService 调用：内置书可被用户删除，删除后从书架移除；
 * 「恢复内置书籍」时传空数组即可全部找回。
 */
function setSuppressedBuiltins(ids: string[]): ServiceResult<null> {
  try {
    suppressedBuiltins = new Set(ids);
    booksCache = null;
    chapterIndex = null;
    buildBooks();
    buildIndexes();
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
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

  /**
   * 获取单个段落（**章级懒查**：段 id 反解章 id → 章内线性查找）。
   *
   * ★2026-10-12：旧实现依赖 `Map<segmentId, TextSegment>` 全书段索引，
   * 那要求全书段落**已全部物化**。现改为先取所属章再在章内找段：
   * 未装载的章其 `segments` 为空数组 ⇒ 查找 miss（`success === false`），
   * 与旧实现在该状态下**行为一致**，但不再要求整本正文在内存。
   */
  getSegment(segmentId: string): ServiceResult<TextSegment> {
    if (!segmentId) {
      return { success: false, error: '段落 ID 不能为空' };
    }
    buildIndexes();
    const chapterId = chapterIdOfSegment(segmentId);
    if (!chapterId) {
      return { success: false, error: `未找到段落：${segmentId}` };
    }
    const chapter = chapterIndex!.get(chapterId);
    if (!chapter) {
      return { success: false, error: `未找到段落：${segmentId}` };
    }
    for (const segment of chapter.segments) {
      if (segment.id === segmentId) {
        return { success: true, data: segment };
      }
    }
    return { success: false, error: `未找到段落：${segmentId}` };
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

  /**
   * 注册（整体替换）用户上传书籍，重建全部索引（含搜索）。
   * 仅供 UserBookService 调用；ID 必须以 user- 开头。
   */
  registerUserBooks,

  /**
   * 注册（整体替换）内置书籍（元数据书，见 registerBuiltinBooks 注释）。
   * 仅供 UserBookService 调用。
   */
  registerBuiltinBooks,

  /** 水合内置书（元数据书 → 全文书体），超限按 LRU 卸载最旧的书 */
  hydrateBook,

  /** 卸载内置书全文（重置回目录态）；后台索引等批量场景用完即走 */
  evictBook,

  /**
   * 【D3】注册「书体被 LRU 淘汰 / 显式卸载」回调（上层释放壳与章引用）；
   * 返回取消注册函数。上层注册前不会有任何行为变化。
   */
  onBookEvicted,

  /** 内置书全文是否已水合 */
  isBookHydrated,

  /**
   * 设置被删除（抑制）的内置书集合，重建全部索引。
   * 仅供 UserBookService 调用；传空数组恢复全部内置书。
   */
  setSuppressedBuiltins,

  /** 判定是否用户上传书籍 */
  isUserBook: isUserBookId,
};

export default TextLibraryService;
