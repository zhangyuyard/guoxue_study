/**
 * 存储操作 Hooks（useStorage）
 * 封装 StorageService 的划线/笔记/收藏读写：
 * 返回操作函数 + 当前列表状态，ServiceResult 错误由 error 状态捕获。
 * 注：底层 SQLite 查询为同步实现，故不设 loading 状态。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bookmark, BookmarkType, Highlight, Note } from '@/types';

import {
  StorageService,
  genId,
  nowISO,
} from '@/services/StorageService';

// ============ 划线 ============

export interface UseHighlightsResult {
  /** 当前过滤条件下的划线列表 */
  highlights: Highlight[];
  /** 重新加载划线 */
  reload: () => void;
  /** 保存划线（成功后自动刷新列表） */
  addHighlight: (h: Highlight) => boolean;
  /** 删除划线 */
  removeHighlight: (id: string) => boolean;
  /** 最近一次操作/加载错误 */
  error?: string;
}

/**
 * 多章节划线列表 + 划线操作。
 * 跨章连续滚动时正文会横跨多章，划线必须按「已拼接章节」整体加载，
 * 否则后续章节的历史划线永远读不到（路由 chapterId 始终停留在入口章）。
 * - 单章：下推 chapter_id 走窄查询
 * - 多章：整本一次查询后按章节集合过滤（一次 SQL，避免 N 次往返）
 */
export function useHighlightsForChapters(
  bookId?: string,
  chapterIds?: readonly string[],
): UseHighlightsResult {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  // 以「连接后的字符串」做依赖键：内容不变时引用稳定，避免 reload 抖动引发重复查询
  const idsKey = chapterIds && chapterIds.length > 0 ? chapterIds.join('\u0000') : '';
  const ids = useMemo(() => (idsKey ? idsKey.split('\u0000') : undefined), [idsKey]);

  const reload = useCallback(() => {
    if (!bookId || !ids) {
      setHighlights([]);
      return;
    }
    if (ids.length === 1) {
      const res = StorageService.getHighlights(bookId, ids[0]);
      if (res.success && res.data) {
        setHighlights(res.data);
        setError(undefined);
      } else {
        setError(res.error ?? '加载划线失败');
      }
      return;
    }
    const scope = new Set(ids);
    const res = StorageService.getHighlights(bookId);
    if (res.success && res.data) {
      setHighlights(res.data.filter((h) => scope.has(h.chapterId)));
      setError(undefined);
    } else {
      setError(res.error ?? '加载划线失败');
    }
  }, [bookId, ids]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addHighlight = useCallback(
    (h: Highlight): boolean => {
      const res = StorageService.saveHighlight(h);
      if (res.success) {
        reload();
      } else {
        setError(res.error ?? '保存划线失败');
      }
      return res.success;
    },
    [reload],
  );

  const removeHighlight = useCallback(
    (id: string): boolean => {
      const res = StorageService.deleteHighlight(id);
      if (res.success) {
        setHighlights((prev) => prev.filter((h) => h.id !== id));
        setError(undefined);
      } else {
        setError(res.error ?? '删除划线失败');
      }
      return res.success;
    },
    [],
  );

  return { highlights, reload, addHighlight, removeHighlight, error };
}

/** 划线列表 + 划线操作（单章便捷封装，行为与 useHighlightsForChapters 单章一致） */
export function useHighlights(bookId?: string, chapterId?: string): UseHighlightsResult {
  const chapterIds = useMemo(() => (chapterId ? [chapterId] : undefined), [chapterId]);
  return useHighlightsForChapters(bookId, chapterIds);
}

// ============ 笔记 ============

/** 新增笔记入参 */
export interface AddNoteInput {
  bookId: string;
  chapterId: string;
  segmentId: string;
  startOffset: number;
  endOffset: number;
  content: string;
  /** 关联划线 ID */
  highlightId?: string;
}

export interface UseNotesResult {
  /** 当前过滤条件下的笔记列表 */
  notes: Note[];
  /** 重新加载笔记 */
  reload: () => void;
  /** 新增笔记（返回构造好的 Note，失败返回 null） */
  addNote: (input: AddNoteInput) => Note | null;
  /** 更新笔记内容 */
  updateNote: (id: string, content: string) => boolean;
  /** 删除笔记 */
  removeNote: (id: string) => boolean;
  error?: string;
}

/**
 * 多章节笔记列表 + 笔记操作。
 * 与 useHighlightsForChapters 同理：跨章连续滚动后，后续章节的既有笔记
 * 也要一并加载，否则点开这些章的划线会重复新建笔记而非编辑原笔记。
 */
export function useNotesForChapters(
  bookId?: string,
  chapterIds?: readonly string[],
): UseNotesResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const idsKey = chapterIds && chapterIds.length > 0 ? chapterIds.join('\u0000') : '';
  const ids = useMemo(() => (idsKey ? idsKey.split('\u0000') : undefined), [idsKey]);

  const reload = useCallback(() => {
    if (!bookId || !ids) {
      setNotes([]);
      return;
    }
    if (ids.length === 1) {
      const res = StorageService.getNotes(bookId, ids[0]);
      if (res.success && res.data) {
        setNotes(res.data);
        setError(undefined);
      } else {
        setError(res.error ?? '加载笔记失败');
      }
      return;
    }
    const scope = new Set(ids);
    const res = StorageService.getNotes(bookId);
    if (res.success && res.data) {
      setNotes(res.data.filter((n) => scope.has(n.chapterId)));
      setError(undefined);
    } else {
      setError(res.error ?? '加载笔记失败');
    }
  }, [bookId, ids]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addNote = useCallback(
    (input: AddNoteInput): Note | null => {
      const ts = nowISO();
      const note: Note = {
        id: genId('note'),
        bookId: input.bookId,
        chapterId: input.chapterId,
        segmentId: input.segmentId,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        content: input.content,
        highlightId: input.highlightId,
        createdAt: ts,
        updatedAt: ts,
      };
      const res = StorageService.saveNote(note);
      if (res.success) {
        setNotes((prev) => [note, ...prev]);
        setError(undefined);
        return note;
      }
      setError(res.error ?? '保存笔记失败');
      return null;
    },
    [],
  );

  const updateNote = useCallback(
    (id: string, content: string): boolean => {
      const res = StorageService.updateNote(id, content);
      if (res.success) {
        const ts = nowISO();
        setNotes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, content, updatedAt: ts } : n)),
        );
        setError(undefined);
      } else {
        setError(res.error ?? '更新笔记失败');
      }
      return res.success;
    },
    [],
  );

  const removeNote = useCallback(
    (id: string): boolean => {
      const res = StorageService.deleteNote(id);
      if (res.success) {
        setNotes((prev) => prev.filter((n) => n.id !== id));
        setError(undefined);
      } else {
        setError(res.error ?? '删除笔记失败');
      }
      return res.success;
    },
    [],
  );

  return { notes, reload, addNote, updateNote, removeNote, error };
}

/** 笔记列表 + 笔记操作（单章便捷封装，行为与 useNotesForChapters 单章一致） */
export function useNotes(bookId?: string, chapterId?: string): UseNotesResult {
  const chapterIds = useMemo(() => (chapterId ? [chapterId] : undefined), [chapterId]);
  return useNotesForChapters(bookId, chapterIds);
}

// ============ 收藏 ============

/** 新增收藏入参 */
export interface AddBookmarkInput {
  type: BookmarkType;
  bookId?: string;
  chapterId?: string;
  segmentId?: string;
  text?: string;
  tags?: string[];
}

export interface UseBookmarksResult {
  /** 收藏列表 */
  bookmarks: Bookmark[];
  /** 重新加载收藏 */
  reload: () => void;
  /** 新增收藏（返回构造好的 Bookmark，失败返回 null） */
  addBookmark: (input: AddBookmarkInput) => Bookmark | null;
  /** 删除收藏 */
  removeBookmark: (id: string) => boolean;
  error?: string;
}

/** 收藏列表 + 收藏操作 */
export function useBookmarks(type?: BookmarkType): UseBookmarksResult {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(() => {
    const res = StorageService.getBookmarks(type);
    if (res.success && res.data) {
      setBookmarks(res.data);
      setError(undefined);
    } else {
      setError(res.error ?? '加载收藏失败');
    }
  }, [type]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addBookmark = useCallback(
    (input: AddBookmarkInput): Bookmark | null => {
      const bookmark: Bookmark = {
        id: genId('bookmark'),
        type: input.type,
        bookId: input.bookId,
        chapterId: input.chapterId,
        segmentId: input.segmentId,
        text: input.text,
        tags: input.tags ?? [],
        createdAt: nowISO(),
      };
      const res = StorageService.saveBookmark(bookmark);
      if (res.success) {
        setBookmarks((prev) => [bookmark, ...prev]);
        setError(undefined);
        return bookmark;
      }
      setError(res.error ?? '保存收藏失败');
      return null;
    },
    [],
  );

  const removeBookmark = useCallback(
    (id: string): boolean => {
      const res = StorageService.deleteBookmark(id);
      if (res.success) {
        setBookmarks((prev) => prev.filter((b) => b.id !== id));
        setError(undefined);
      } else {
        setError(res.error ?? '删除收藏失败');
      }
      return res.success;
    },
    [],
  );

  return { bookmarks, reload, addBookmark, removeBookmark, error };
}
