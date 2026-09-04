/**
 * 阅读器 Store（useReaderStore）
 * 管理当前阅读位置（书籍/章节/段落）与注音结果缓存。
 * 上次阅读位置（lastRead）通过 persist + MMKV 持久化，下次启动可续读。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';
import type { PinyinAnnotation } from '@/types';

import { PinyinService } from '@/services/PinyinService';
import { useSettingsStore } from '@/store/useSettingsStore';

const storage = new MMKV();

const mmkvStorage: StateStorage = {
  setItem: (name, value) => storage.set(name, value),
  getItem: (name) => storage.getString(name) ?? null,
  removeItem: (name) => storage.delete(name),
};

/** 持久化字段 */
interface ReaderPersist {
  lastRead: {
    bookId: string;
    chapterId: string;
    /**
     * 上次阅读到的段落（P1-17 段落级续读）。
     * 旧版本持久化数据可能缺失该字段（undefined），续读时行为同现状（回章首）。
     */
    segmentId?: string;
  } | null;
}

interface ReaderState extends ReaderPersist {
  /** 当前书籍 ID */
  bookId: string | null;
  /** 当前章节 ID */
  chapterId: string | null;
  /** 当前段落 ID（精确到段） */
  segmentId: string | null;
  /** 注音缓存：segmentId -> PinyinAnnotation[] */
  annotationCache: Record<string, PinyinAnnotation[]>;

  /** 打开章节（可指定初始段落） */
  openChapter: (bookId: string, chapterId: string, segmentId?: string) => void;
  /** 切换当前段落 */
  setSegment: (segmentId: string) => void;
  /**
   * 记录当前阅读段落（P1-17）：滚动停止（防抖 300ms）/ 翻页换页时提交，
   * 同时同步 lastRead.segmentId 供续读恢复。
   */
  recordProgress: (segmentId: string) => void;
  /** 对某段文本执行注音并缓存（按设置里的注音模式） */
  annotateSegment: (segmentId: string, text: string) => void;
  /** 读取某段缓存注音 */
  getAnnotation: (segmentId: string) => PinyinAnnotation[] | undefined;
  /** 清除全部注音缓存 */
  clearAnnotationCache: () => void;
  /** 清空阅读器状态 */
  clearReader: () => void;
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set, get) => ({
      lastRead: null,
      bookId: null,
      chapterId: null,
      segmentId: null,
      annotationCache: {},

      openChapter: (bookId, chapterId, segmentId) => {
        const nextSegmentId = segmentId ?? null;
        const state = get();
        // 幂等：位置未变化时不写入，避免 lastRead 生成新引用、
        // 触发阅读记录订阅方级联重渲染
        if (
          state.bookId === bookId &&
          state.chapterId === chapterId &&
          state.segmentId === nextSegmentId &&
          state.lastRead !== null &&
          state.lastRead.bookId === bookId &&
          state.lastRead.chapterId === chapterId &&
          state.lastRead.segmentId === (nextSegmentId ?? undefined)
        ) {
          return;
        }
        set({
          bookId,
          chapterId,
          segmentId: nextSegmentId,
          // 段落级进度：携带 segmentId 时持久化；未携带则不写入该字段
          // （与旧版持久化数据形态一致，续读语义为回章首）
          lastRead: nextSegmentId
            ? { bookId, chapterId, segmentId: nextSegmentId }
            : { bookId, chapterId },
        });
      },

      setSegment: (segmentId) => set({ segmentId }),

      recordProgress: (segmentId) => {
        const state = get();
        const last = state.lastRead;
        // 仅当 lastRead 属于当前阅读的书 + 章时才同步段落（跨章由 openChapter 负责）；
        // 段落未变化时保持 lastRead 原引用（幂等，防高频滚动产生冗余通知）
        const nextLastRead =
          last !== null &&
          last.bookId === state.bookId &&
          last.chapterId === state.chapterId
            ? last.segmentId === segmentId
              ? last
              : { ...last, segmentId }
            : last;
        if (state.segmentId === segmentId && nextLastRead === last) {
          return;
        }
        set({ segmentId, lastRead: nextLastRead });
      },

      annotateSegment: (segmentId, text) => {
        const mode = useSettingsStore.getState().pinyinMode;
        const res = PinyinService.annotate(text, mode);
        if (res.success && res.data) {
          set((state) => ({
            annotationCache: {
              ...state.annotationCache,
              [segmentId]: res.data as PinyinAnnotation[],
            },
          }));
        }
      },

      getAnnotation: (segmentId) => {
        return get().annotationCache[segmentId];
      },

      clearAnnotationCache: () => set({ annotationCache: {} }),

      clearReader: () =>
        set({
          bookId: null,
          chapterId: null,
          segmentId: null,
          annotationCache: {},
        }),
    }),
    {
      name: 'guoxue-reader',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ lastRead: state.lastRead }),
    },
  ),
);

export default useReaderStore;
