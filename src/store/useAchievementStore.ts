/**
 * 成就 Store（useAchievementStore，P2-06 本地版）
 * unlockedAt：achievementId → 解锁时刻（ISO 字符串），经 zustand persist + MMKV 持久化。
 * 设计取舍：
 *   - 成就不可逆：recompute 只新增解锁项，绝不删除/回退已解锁项（即使数据被删）；
 *   - 幂等：重复 recompute 对已解锁项不覆盖时间戳（首次解锁时刻保留）；
 *   - recompute 内部先同步刷新各数据 store（SQLite 读取为同步操作），
 *     保证启动 / 背诵完成两个触发点拿到的都是最新快照。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';

import { evaluateAchievements } from '@/utils/achievements';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useRecitationStore } from '@/store/useRecitationStore';

/** MMKV 实例（与 useSettingsStore 同款加密 KV 存储） */
const storage = new MMKV();

/** zustand persist 所需的 storage adapter */
const mmkvStorage: StateStorage = {
  setItem: (name, value) => {
    storage.set(name, value);
  },
  getItem: (name) => {
    return storage.getString(name) ?? null;
  },
  removeItem: (name) => {
    storage.delete(name);
  },
};

interface AchievementState {
  /** 已解锁成就：achievementId → 解锁时刻 ISO 字符串 */
  unlockedAt: Record<string, string>;

  /**
   * 重算成就：从各数据 store 采集快照 → evaluateAchievements →
   * 仅为新解锁项写入当前时刻（幂等、不可逆）。
   */
  recompute: () => void;

  /**
   * 备份恢复（P2-15）：整体替换 unlockedAt 并持久化。
   * 入参为备份中的 achievements 字段（achievementId → ISO 时间字符串），
   * 非法条目（非对象/值非字符串）静默丢弃；解析/结构校验由 utils/backup 负责。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useAchievementStore = create<AchievementState>()(
  persist(
    (set, get) => ({
      unlockedAt: {},

      recompute: () => {
        // 同步刷新数据源：背诵进度 / 收藏 / 笔记均为 SQLite 同步读取，
        // 保证 App 启动（数据尚未加载）时 recompute 也能拿到全量快照
        useRecitationStore.getState().loadRecitationList();
        useBookmarkStore.getState().loadBookmarks();
        useNoteStore.getState().loadNotes();

        const recitation = useRecitationStore.getState().list;
        const bookmarks = useBookmarkStore.getState().bookmarks;
        const notes = useNoteStore.getState().notes;

        const achieved = evaluateAchievements({
          completedAt: recitation
            .map((r) => r.completedAt)
            .filter((ts): ts is string => typeof ts === 'string'),
          bookIds: recitation.map((r) => r.bookId),
          bookmarkCount: bookmarks.length,
          noteCount: notes.length,
          today: new Date(),
        });

        // 幂等：已解锁项绝不覆盖时间戳；无新解锁时不触发 set（避免无谓持久化写入）
        const current = get().unlockedAt;
        const now = new Date().toISOString();
        const next: Record<string, string> = { ...current };
        let changed = false;
        for (const id of achieved) {
          if (next[id] === undefined) {
            next[id] = now;
            changed = true;
          }
        }
        if (changed) {
          set({ unlockedAt: next });
        }
      },

      restoreFromBackup: (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return;
        }
        const raw = data as Record<string, unknown>;
        const next: Record<string, string> = {};
        for (const [id, ts] of Object.entries(raw)) {
          if (typeof id === 'string' && id !== '' && typeof ts === 'string' && ts !== '') {
            next[id] = ts;
          }
        }
        set({ unlockedAt: next });
      },
    }),
    {
      name: 'guoxue-achievements',
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);

export default useAchievementStore;
