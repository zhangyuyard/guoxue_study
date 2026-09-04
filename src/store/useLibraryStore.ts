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
    // 先装载用户上传书籍（sqlite 异步），再统一读取书目
    await UserBookService.loadAndRegisterAll();
    const booksRes = TextLibraryService.getBooks();
    const catRes = TextLibraryService.getCategories();
    if (booksRes.success && booksRes.data) {
      set({
        books: booksRes.data,
        categories: catRes.success && catRes.data ? catRes.data : [],
        loading: false,
        error: undefined,
      });
    } else {
      set({ loading: false, error: booksRes.error ?? '加载文本库失败' });
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
