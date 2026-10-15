/**
 * 阅读器 Store（useReaderStore）
 * 管理当前阅读位置（书籍/章节/段落）与注音结果缓存。
 * 上次阅读位置（lastRead）通过 persist + MMKV 持久化，下次启动可续读。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createMMKV } from 'react-native-mmkv';
import type { PinyinAnnotation } from '@/types';

import { PinyinService } from '@/services/PinyinService';
import { useSettingsStore } from '@/store/useSettingsStore';

const storage = createMMKV();

const mmkvStorage: StateStorage = {
  setItem: (name, value) => storage.set(name, value),
  getItem: (name) => storage.getString(name) ?? null,
  removeItem: (name) => storage.remove(name),
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
    /**
     * 章内滚动比例（0~1，滚动模式专用；段内精确续读）。
     * 记录「退出时视口在章内的相对位置」（以章标题行为起点、下一章标题行/
     * 章末为终点）。段级恢复只能落到 segment 起点——短章/大段书（如道德经
     * 单章单段）的中段位置会退化为章首；比例恢复在其上做一次精修落点。
     * 字体/注音设置变更后为近似值；缺失（旧数据/翻页模式）= 不精修。
     */
    offsetRatio?: number;
    /**
     * 章内字符偏移（码点，0 起；跨段累计，不含标题行）—— legado `durChapterPos`
     * 本地化后的**位置真值**。
     *
     * 为什么升级：段级恢复只能落到段首，短章 / 大段书（单章单段）的段内位置会
     * 退化为章首；比例恢复是像素近似值，字号 / 注音变更后即失真。字符偏移是
     * 内容坐标，与排版无关 —— 任何字号 / 行距 / 注音模式下都能精确回到同一处。
     * 旧持久化数据无该字段（undefined）⇒ 回退 `segmentId` 段级续读。
     */
    charOffset?: number;
  } | null;
  /**
   * 每本书最近一次打开/阅读的时间戳（bookId -> epoch ms）。
   * 书架「最近」分类的数据源：按时间倒序展示最近读过的书。
   * 上限 RECENT_BOOKS_MAX 本（超出淘汰最旧的），旧版本数据缺失视为无记录。
   */
  recentBooks: Record<string, number>;
}

/** 最近阅读记录上限：超出后淘汰最旧的记录（防止长期使用无限膨胀） */
const RECENT_BOOKS_MAX = 100;

interface ReaderState extends ReaderPersist {
  /** 当前书籍 ID */
  bookId: string | null;
  /** 当前章节 ID */
  chapterId: string | null;
  /** 当前段落 ID（精确到段） */
  segmentId: string | null;
  /** 注音缓存：segmentId -> PinyinAnnotation[] */
  annotationCache: Record<string, PinyinAnnotation[]>;

  /** 打开章节（可指定初始段落、章内滚动比例与章内字符偏移） */
  openChapter: (
    bookId: string,
    chapterId: string,
    segmentId?: string,
    offsetRatio?: number,
    charOffset?: number,
  ) => void;
  /** 切换当前段落 */
  setSegment: (segmentId: string) => void;
  /**
   * 记录当前阅读段落（P1-17）：滚动停止（防抖 300ms）/ 翻页换页时提交，
   * 同时同步 lastRead.segmentId 供续读恢复；滚动模式附带章内滚动比例
   * （offsetRatio，段内精确续读），翻页模式不传（清除陈旧比例）。
   */
  recordProgress: (segmentId: string, offsetRatio?: number, charOffset?: number) => void;
  /** 对某段文本执行注音并缓存（按设置里的注音模式） */
  annotateSegment: (segmentId: string, text: string) => void;
  /** 读取某段缓存注音 */
  getAnnotation: (segmentId: string) => PinyinAnnotation[] | undefined;
  /** 清除全部注音缓存 */
  clearAnnotationCache: () => void;
  /**
   * 备份恢复：写入已校验的续读位置（persist 中间件自动同步持久化）。
   * 仅恢复流程调用；null 表示备份无续读位置（旧备份兼容，清空现值）。
   */
  restoreLastRead: (lastRead: ReaderPersist['lastRead']) => void;
  /**
   * 清除指向指定书籍的续读位置（删书级联清理，BugFix 孤儿数据）：
   * lastRead 指向已删书时，书架「继续阅读」点击后会加载失败。
   * 仅当 lastRead 属于该书时置 null，他书/无位置不受影响。
   */
  clearLastReadForBook: (bookId: string) => void;
  /** 清空阅读器状态 */
  clearReader: () => void;
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set, get) => ({
      lastRead: null,
      recentBooks: {},
      bookId: null,
      chapterId: null,
      segmentId: null,
      annotationCache: {},

      openChapter: (bookId, chapterId, segmentId, offsetRatio, charOffset) => {
        const nextSegmentId = segmentId ?? null;
        const state = get();
        // 幂等：位置未变化时不写入，避免 lastRead 生成新引用、
        // 触发阅读记录订阅方级联重渲染
        const nextRatio =
          nextSegmentId && typeof offsetRatio === 'number' ? offsetRatio : undefined;
        // 字符偏移是位置真值（legado `durChapterPos` 本地化）：非负有限值即接受，
        // `0` 是合法值（章首），不得被真值判断吃掉
        const nextCharOffset =
          typeof charOffset === 'number' && Number.isFinite(charOffset) && charOffset >= 0
            ? Math.floor(charOffset)
            : undefined;
        if (
          state.bookId === bookId &&
          state.chapterId === chapterId &&
          state.segmentId === nextSegmentId &&
          state.lastRead !== null &&
          state.lastRead.bookId === bookId &&
          state.lastRead.chapterId === chapterId &&
          state.lastRead.segmentId === (nextSegmentId ?? undefined) &&
          state.lastRead.offsetRatio === nextRatio &&
          state.lastRead.charOffset === nextCharOffset
        ) {
          return;
        }
        set({
          bookId,
          chapterId,
          segmentId: nextSegmentId,
          // 进度持久化口径：段级或字符级任一在场即写（旧数据只有段级，
          // 新版两者同写以便双向兼容）；皆无则只留章级（续读语义 = 回章首）
          //
          // ★★ E1（2026-10-15 真机判决 `e1c-run.log`）：**同章重复装载时不得
          //   抹掉已记录的位置**。原实现是「整体重写」，于是：
          //   ```
          //   16:13:50.202 lastRead={c1, charOffset:134, segmentId:s5}  ✔ 滚动记上了
          //   16:13:52.518 lastRead={c1, charOffset:0}                ★★ 被抹回 0
          //   16:13:52.519 lastRead={c1, charOffset:211}               ✔ 又记上
          //   ```
          //   某个重复触发的装载（预装落地 → win 变化 → effect 重跑）带着
          //   `charOffset=0` 回来 ⇒ **把用户已滚到的位置清零** ⇒
          //   退出后再进书回到章首（用户报障「没记住进度」）。
          // ★修法：同章 + 调用方未给位置（两者皆空）⇒ **沿用 lastRead 现值**。
          lastRead: (() => {
            if (nextSegmentId || nextCharOffset !== undefined) {
              return {
                bookId,
                chapterId,
                ...(nextSegmentId ? { segmentId: nextSegmentId } : null),
                ...(nextRatio !== undefined ? { offsetRatio: nextRatio } : null),
                ...(nextCharOffset !== undefined ? { charOffset: nextCharOffset } : null),
              };
            }
            // ★同章且无新位置 ⇒ 保留原位置（不回退章首）
            if (
              state.lastRead !== null &&
              state.lastRead.bookId === bookId &&
              state.lastRead.chapterId === chapterId
            ) {
              return state.lastRead;
            }
            return { bookId, chapterId };
          })(),
          // 最近阅读记录：书架「最近」分类按此时间倒序。写入时同步裁剪，
          // 防止长期使用无限膨胀（旧记录时间戳不变，按时间淘汰最旧的）
          recentBooks: (() => {
            const next: Record<string, number> = {
              ...state.recentBooks,
              [bookId]: Date.now(),
            };
            const ids = Object.keys(next);
            if (ids.length <= RECENT_BOOKS_MAX) {
              return next;
            }
            ids
              .sort((a, b) => next[a] - next[b])
              .slice(0, ids.length - RECENT_BOOKS_MAX)
              .forEach((id) => {
                delete next[id];
              });
            return next;
          })(),
        });
      },

      setSegment: (segmentId) => set({ segmentId }),

      recordProgress: (segmentId, offsetRatio, charOffset) => {
        const state = get();
        const last = state.lastRead;
        // 仅当 lastRead 属于当前阅读的书 + 章时才同步段落（跨章由 openChapter 负责）；
        // 段落 / 比例 / 字符偏移均未变化时保持 lastRead 原引用（幂等，防高频滚动产生
        // 冗余通知）
        const nextRatio = typeof offsetRatio === 'number' ? offsetRatio : undefined;
        const nextCharOffset =
          typeof charOffset === 'number' && Number.isFinite(charOffset) && charOffset >= 0
            ? Math.floor(charOffset)
            : undefined;
        let nextLastRead = last;
        if (
          last !== null &&
          last.bookId === state.bookId &&
          last.chapterId === state.chapterId
        ) {
          if (
            last.segmentId !== segmentId ||
            last.offsetRatio !== nextRatio ||
            last.charOffset !== nextCharOffset
          ) {
            nextLastRead = {
              ...last,
              segmentId,
              ...(nextRatio !== undefined ? { offsetRatio: nextRatio } : { offsetRatio: undefined }),
              ...(nextCharOffset !== undefined
                ? { charOffset: nextCharOffset }
                : { charOffset: undefined }),
            };
          }
        }
        if (state.segmentId === segmentId && nextLastRead === last) {
          return;
        }
        set({
          segmentId,
          lastRead: nextLastRead,
          // 实际阅读进展也刷新最近记录（重开同一书同位置时 openChapter
          // 幂等返回不写时间戳，由这里兜底刷新「最近」排序）
          ...(state.bookId
            ? { recentBooks: { ...state.recentBooks, [state.bookId]: Date.now() } }
            : null),
        });
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

      restoreLastRead: (lastRead: ReaderPersist['lastRead']) => set({ lastRead }),

      clearLastReadForBook: (bookId) => {
        if (get().lastRead?.bookId === bookId) {
          set({ lastRead: null });
        }
      },

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
      partialize: (state) => ({ lastRead: state.lastRead, recentBooks: state.recentBooks }),
    },
  ),
);

export default useReaderStore;
