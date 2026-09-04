/**
 * 背诵进度 Store（useRecitationStore）
 * 管理各章节背诵进度（模式/状态/百分比）。持久化经 StorageService（SQLite）。
 */
import { create } from 'zustand';
import type {
  RecitationMode,
  RecitationProgress,
  RecitationStatus,
} from '@/types';
import {
  StorageService,
  recitationKey,
} from '@/services/StorageService';

interface RecitationState {
  list: RecitationProgress[];
  loading: boolean;
  error?: string;

  /** 加载全部背诵进度 */
  loadRecitationList: () => void;
  /** 保存/更新一条进度（按 书籍+章节+模式 upsert） */
  saveProgress: (input: {
    bookId: string;
    chapterId: string;
    mode: RecitationMode;
    status: RecitationStatus;
    progress: number;
    lastPracticedAt?: string;
    /** 背诵完成时刻（P2-07，仅 fillBlank 提交时写入） */
    completedAt?: string;
    /** 复习等级（P2-07） */
    reviewLevel?: number;
    /** 下次复习到期时刻（P2-07） */
    nextDueAt?: string;
  }) => void;
  /** 读取某章节某模式的进度（从缓存中查找） */
  getProgress: (
    bookId: string,
    chapterId: string,
    mode: RecitationMode,
  ) => RecitationProgress | null;
  /** 删除一条进度 */
  removeProgress: (id: string) => void;
  /** 清空指定书籍的全部背诵进度（P1-08 重置进度入口） */
  removeProgressByBook: (bookId: string) => void;
  /**
   * 备份恢复（P2-15）：整体替换为备份列表并持久化（SQLite）。
   * 数据结构保持与现有记录一致：id 由 bookId:chapterId:mode 重新推导，
   * 非法条目（缺 bookId/chapterId/mode）静默跳过，避免一条坏数据毁掉整次恢复。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useRecitationStore = create<RecitationState>()((set, get) => ({
  list: [],
  loading: false,
  error: undefined,

  loadRecitationList: () => {
    set({ loading: true });
    const res = StorageService.getRecitationList();
    if (res.success && res.data) {
      set({ list: res.data, loading: false, error: undefined });
    } else {
      set({ loading: false, error: res.error ?? '加载背诵进度失败' });
    }
  },

  saveProgress: (input) => {
    const progress: RecitationProgress = {
      id: recitationKey(input.bookId, input.chapterId, input.mode),
      bookId: input.bookId,
      chapterId: input.chapterId,
      mode: input.mode,
      status: input.status,
      progress: input.progress,
      lastPracticedAt: input.lastPracticedAt,
    };
    const res = StorageService.saveRecitation(progress);
    if (res.success) {
      set((state) => {
        const rest = state.list.filter((r) => r.id !== progress.id);
        return { list: [progress, ...rest] };
      });
    } else {
      set({ error: res.error ?? '保存背诵进度失败' });
    }
  },

  getProgress: (bookId, chapterId, mode) => {
    const id = recitationKey(bookId, chapterId, mode);
    return get().list.find((r) => r.id === id) ?? null;
  },

  removeProgress: (id) => {
    const res = StorageService.deleteRecitation(id);
    if (res.success) {
      set((state) => ({ list: state.list.filter((r) => r.id !== id) }));
    } else {
      set({ error: res.error ?? '删除背诵进度失败' });
    }
  },

  removeProgressByBook: (bookId) => {
    const targets = get().list.filter((r) => r.bookId === bookId);
    if (targets.length === 0) {
      return;
    }
    let allSuccess = true;
    for (const target of targets) {
      const res = StorageService.deleteRecitation(target.id);
      if (!res.success) {
        allSuccess = false;
      }
    }
    if (allSuccess) {
      const removedIds = new Set(targets.map((t) => t.id));
      set((state) => ({ list: state.list.filter((r) => !removedIds.has(r.id)) }));
    } else {
      set({ error: '删除背诵进度失败' });
    }
  },

  restoreFromBackup: (data) => {
    if (!Array.isArray(data)) {
      set({ error: '恢复背诵进度失败：备份数据格式不正确' });
      return;
    }
    // 整体替换：先清空现有记录，再逐条 upsert（INSERT OR REPLACE 幂等写入）
    let allSuccess = true;
    for (const existing of get().list) {
      const delRes = StorageService.deleteRecitation(existing.id);
      if (!delRes.success) {
        allSuccess = false;
      }
    }
    // 按推导 id 去重（同键后到者覆盖先到者，与 SQLite upsert 语义一致）
    const byId = new Map<string, RecitationProgress>();
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as Partial<RecitationProgress>;
      if (
        typeof item.bookId !== 'string' ||
        item.bookId === '' ||
        typeof item.chapterId !== 'string' ||
        item.chapterId === '' ||
        typeof item.mode !== 'string'
      ) {
        continue;
      }
      const progress: RecitationProgress = {
        id: recitationKey(item.bookId, item.chapterId, item.mode as RecitationMode),
        bookId: item.bookId,
        chapterId: item.chapterId,
        mode: item.mode as RecitationMode,
        status: (item.status ?? 'notStarted') as RecitationStatus,
        progress:
          typeof item.progress === 'number' && Number.isFinite(item.progress)
            ? item.progress
            : 0,
        lastPracticedAt: item.lastPracticedAt,
        completedAt: item.completedAt,
        reviewLevel: item.reviewLevel,
        nextDueAt: item.nextDueAt,
      };
      const res = StorageService.saveRecitation(progress);
      if (!res.success) {
        allSuccess = false;
      } else {
        byId.set(progress.id, progress);
      }
    }
    const restored = Array.from(byId.values());
    set({
      list: restored,
      error: allSuccess ? undefined : '恢复背诵进度：部分记录写入失败',
    });
  },
}));

export default useRecitationStore;
