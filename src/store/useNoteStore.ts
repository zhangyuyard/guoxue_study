/**
 * 笔记 Store（useNoteStore）
 * 管理文字笔记。持久化经 StorageService（SQLite），支持按书籍/章节过滤。
 */
import { create } from 'zustand';
import type { Note } from '@/types';
import {
  StorageService,
  genId,
  nowISO,
} from '@/services/StorageService';

interface NoteState {
  notes: Note[];
  loading: boolean;
  error?: string;

  /** 加载笔记（可按书籍/章节过滤） */
  loadNotes: (bookId?: string, chapterId?: string) => void;
  /** 新增笔记 */
  addNote: (input: {
    bookId: string;
    chapterId: string;
    segmentId: string;
    startOffset: number;
    endOffset: number;
    content: string;
    highlightId?: string;
  }) => void;
  /** 更新笔记内容 */
  updateNoteContent: (id: string, content: string) => void;
  /** 删除笔记 */
  removeNote: (id: string) => void;
  /**
   * 备份恢复（P2-15）：整体替换为备份列表并持久化（SQLite）。
   * 非法条目（缺 id / 定位字段 / content）静默跳过。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useNoteStore = create<NoteState>()((set, get) => ({
  notes: [],
  loading: false,
  error: undefined,

  loadNotes: (bookId, chapterId) => {
    set({ loading: true });
    const res = StorageService.getNotes(bookId, chapterId);
    if (res.success && res.data) {
      set({ notes: res.data, loading: false, error: undefined });
    } else {
      set({ loading: false, error: res.error ?? '加载笔记失败' });
    }
  },

  addNote: (input) => {
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
      set((state) => ({ notes: [note, ...state.notes] }));
    } else {
      set({ error: res.error ?? '保存笔记失败' });
    }
  },

  updateNoteContent: (id, content) => {
    const res = StorageService.updateNote(id, content);
    if (res.success) {
      const ts = nowISO();
      set((state) => ({
        notes: state.notes.map((n) =>
          n.id === id ? { ...n, content, updatedAt: ts } : n,
        ),
      }));
    } else {
      set({ error: res.error ?? '更新笔记失败' });
    }
  },

  removeNote: (id) => {
    const res = StorageService.deleteNote(id);
    if (res.success) {
      set((state) => ({ notes: state.notes.filter((n) => n.id !== id) }));
    } else {
      set({ error: res.error ?? '删除笔记失败' });
    }
  },

  restoreFromBackup: (data) => {
    if (!Array.isArray(data)) {
      set({ error: '恢复笔记失败：备份数据格式不正确' });
      return;
    }
    // 整体替换：先清空现有笔记，再逐条写入
    let allSuccess = true;
    for (const existing of get().notes) {
      const delRes = StorageService.deleteNote(existing.id);
      if (!delRes.success) {
        allSuccess = false;
      }
    }
    const byId = new Map<string, Note>();
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as Partial<Note>;
      if (
        typeof item.id !== 'string' ||
        item.id === '' ||
        typeof item.bookId !== 'string' ||
        typeof item.chapterId !== 'string' ||
        typeof item.segmentId !== 'string' ||
        typeof item.content !== 'string'
      ) {
        continue;
      }
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : nowISO();
      const note: Note = {
        id: item.id,
        bookId: item.bookId,
        chapterId: item.chapterId,
        segmentId: item.segmentId,
        startOffset:
          typeof item.startOffset === 'number' && Number.isFinite(item.startOffset)
            ? item.startOffset
            : 0,
        endOffset:
          typeof item.endOffset === 'number' && Number.isFinite(item.endOffset)
            ? item.endOffset
            : 0,
        content: item.content,
        highlightId: item.highlightId,
        createdAt,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
      };
      const res = StorageService.saveNote(note);
      if (!res.success) {
        allSuccess = false;
      } else {
        byId.set(note.id, note);
      }
    }
    set({
      notes: Array.from(byId.values()),
      error: allSuccess ? undefined : '恢复笔记：部分记录写入失败',
    });
  },
}));

export default useNoteStore;
