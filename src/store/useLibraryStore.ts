/**
 * 文本库 Store（useLibraryStore）
 * 管理书籍列表、分类列表、当前选中的书籍。
 * 数据通过 TextLibraryService 加载（内置道德经 + 用户上传书籍，离线可用）。
 */
import { create } from 'zustand';
import type { Book, Category } from '@/types';
import { TextLibraryService } from '@/services/TextLibraryService';
import { UserBookService } from '@/services/UserBookService';

interface LibraryState {
  books: Book[];
  categories: Category[];
  currentBookId: string | null;
  loading: boolean;
  error?: string;

  /** 加载书籍与分类列表（含异步装载用户上传书籍） */
  loadBooks: () => Promise<void>;
  /** 选中某本书 */
  selectBook: (id: string) => void;
  /** 清除选中 */
  clearSelection: () => void;
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  books: [],
  categories: [],
  currentBookId: null,
  loading: false,
  error: undefined,

  loadBooks: async () => {
    set({ loading: true });
    // 阶段一（同步、轻量）：先上屏内置书目，书架立即可用（BugFix：启动无响应）。
    // 此时用户书尚未注册进 TextLibraryService，getBooks() 仅返回内置经典；
    // 本会话中已注册过的用户书也会一并返回（重复调用场景，行为幂等）。
    const firstBooksRes = TextLibraryService.getBooks();
    const firstCatRes = TextLibraryService.getCategories();
    if (firstBooksRes.success && firstBooksRes.data) {
      set({
        books: firstBooksRes.data,
        categories: firstCatRes.success && firstCatRes.data ? firstCatRes.data : [],
        error: undefined,
      });
    }
    // 让出 JS 线程（macrotask）：用户书装载为 SQLite 全量读 + JSON 反解，
    // 书多/书大时同步耗时明显，不能阻塞首帧渲染与交互。不用微任务——
    // 微任务仍会在首帧渲染前跑完，起不到让出线程的作用。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // 阶段二：装载用户上传书籍后整体刷新。
    // 按需装载：内置书启动只注册目录元数据（卡片即刻完整可见可点），
    // 全文由打开书时的 ensureBookLoaded 单本水合；装载耗时仅剩用户书。
    const loadRes = await UserBookService.loadAndRegisterAll();
    const booksRes = TextLibraryService.getBooks();
    const catRes = TextLibraryService.getCategories();
    if (booksRes.success && booksRes.data) {
      set({
        books: booksRes.data,
        categories: catRes.success && catRes.data ? catRes.data : [],
        loading: false,
        // 装载失败不再静默（如 db 不可用）：书架显示错误而不是无声空白
        error: loadRes.success ? undefined : loadRes.error ?? '加载书籍失败',
      });
    } else {
      set({
        loading: false,
        error: booksRes.error ?? loadRes.error ?? '加载文本库失败',
      });
    }
  },

  selectBook: (id) => {
    const { books } = useLibraryStore.getState();
    if (books.some((b) => b.id === id)) {
      set({ currentBookId: id });
    }
  },

  clearSelection: () => set({ currentBookId: null }),
}));

export default useLibraryStore;
