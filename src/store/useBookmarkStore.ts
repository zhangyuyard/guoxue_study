/**
 * 收藏 Store（useBookmarkStore）
 * 管理文章/段落收藏，标签管理。持久化经 StorageService（SQLite）。
 */
import { create } from 'zustand';
import type { Bookmark, BookmarkType } from '@/types';
import {
  StorageService,
  genId,
  nowISO,
} from '@/services/StorageService';

interface BookmarkState {
  bookmarks: Bookmark[];
  loading: boolean;
  error?: string;

  /** 加载收藏（可按类型过滤） */
  loadBookmarks: (type?: BookmarkType) => void;
  /** 新增收藏 */
  addBookmark: (input: {
    type: BookmarkType;
    bookId?: string;
    chapterId?: string;
    segmentId?: string;
    text?: string;
    tags?: string[];
    note?: string;
  }) => void;
  /** 删除收藏 */
  removeBookmark: (id: string) => void;
  /** 更新收藏标签 */
  updateTags: (id: string, tags: string[]) => void;
  /** 更新收藏标签与备注（P1-12 收藏编辑弹层保存入口） */
  updateBookmark: (id: string, meta: { tags?: string[]; note?: string }) => void;
  /**
   * 备份恢复（P2-15）：整体替换为备份列表并持久化（SQLite）。
   * 非法条目（缺 id / type 不合法）静默跳过。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useBookmarkStore = create<BookmarkState>()((set, get) => ({
  bookmarks: [],
  loading: false,
  error: undefined,

  loadBookmarks: (type) => {
    set({ loading: true });
    const res = StorageService.getBookmarks(type);
    if (res.success && res.data) {
      set({ bookmarks: res.data, loading: false, error: undefined });
    } else {
      set({ loading: false, error: res.error ?? '加载收藏失败' });
    }
  },

  addBookmark: (input) => {
    const bookmark: Bookmark = {
      id: genId('bm'),
      type: input.type,
      bookId: input.bookId,
      chapterId: input.chapterId,
      segmentId: input.segmentId,
      text: input.text,
      tags: input.tags ?? [],
      note: input.note,
      createdAt: nowISO(),
    };
    const res = StorageService.saveBookmark(bookmark);
    if (res.success) {
      set((state) => ({ bookmarks: [bookmark, ...state.bookmarks] }));
    } else {
      set({ error: res.error ?? '保存收藏失败' });
    }
  },

  removeBookmark: (id) => {
    const res = StorageService.deleteBookmark(id);
    if (res.success) {
      set((state) => ({
        bookmarks: state.bookmarks.filter((b) => b.id !== id),
      }));
    } else {
      set({ error: res.error ?? '删除收藏失败' });
    }
  },

  updateTags: (id, tags) => {
    const res = StorageService.updateBookmarkTags(id, tags);
    if (res.success) {
      set((state) => ({
        bookmarks: state.bookmarks.map((b) =>
          b.id === id ? { ...b, tags } : b,
        ),
      }));
    } else {
      set({ error: res.error ?? '更新标签失败' });
    }
  },

  updateBookmark: (id, meta) => {
    const current = get().bookmarks.find((b) => b.id === id);
    if (!current) {
      set({ error: '收藏不存在' });
      return;
    }
    const tags = meta.tags ?? current.tags;
    // note 传空串表示清空备注；undefined 表示保持不变
    const note = meta.note !== undefined ? meta.note : current.note;
    const res = StorageService.updateBookmarkMeta(id, tags, note);
    if (res.success) {
      set((state) => ({
        bookmarks: state.bookmarks.map((b) =>
          b.id === id ? { ...b, tags, note } : b,
        ),
      }));
    } else {
      set({ error: res.error ?? '更新收藏失败' });
    }
  },

  restoreFromBackup: (data) => {
    if (!Array.isArray(data)) {
      set({ error: '恢复收藏失败：备份数据格式不正确' });
      return;
    }
    // 整体替换：先清空现有收藏，再逐条写入
    let allSuccess = true;
    for (const existing of get().bookmarks) {
      const delRes = StorageService.deleteBookmark(existing.id);
      if (!delRes.success) {
        allSuccess = false;
      }
    }
    const byId = new Map<string, Bookmark>();
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as Partial<Bookmark>;
      if (
        typeof item.id !== 'string' ||
        item.id === '' ||
        (item.type !== 'article' && item.type !== 'paragraph')
      ) {
        continue;
      }
      const bookmark: Bookmark = {
        id: item.id,
        type: item.type,
        bookId: item.bookId,
        chapterId: item.chapterId,
        segmentId: item.segmentId,
        text: item.text,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        note: item.note,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowISO(),
      };
      const res = StorageService.saveBookmark(bookmark);
      if (!res.success) {
        allSuccess = false;
      } else {
        byId.set(bookmark.id, bookmark);
      }
    }
    set({
      bookmarks: Array.from(byId.values()),
      error: allSuccess ? undefined : '恢复收藏：部分记录写入失败',
    });
  },
}));

export default useBookmarkStore;
