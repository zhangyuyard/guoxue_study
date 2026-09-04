/**
 * 用户读音纠正 Store（useReadingOverrideStore）
 * 用户对「某字在某句中的读音」的手动纠正（用户劳动成果，必须可备份恢复）。
 * 数据形态：overrides 数组，char 为简体逻辑字，context 为归一化到简体的整句原文
 * （与 PinyinService.annotate 的 logicText 同源，保证繁体正文也能命中）。
 * 持久化：zustand persist + MMKV（与 useSettingsStore 同款模式）。
 * 与 PinyinService 的解耦：PinyinService 提供 setReadingOverrideProvider 注入点，
 * 由 App 启动任务把本 store 注入为读音仲裁链最顶端（依赖方向 store → service 单向）。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';

import { genId, nowISO } from '@/services/StorageService';

/** 单条读音纠正 */
export interface ReadingOverride {
  /** 记录 ID（ro- 前缀） */
  id: string;
  /** 简体逻辑字 */
  char: string;
  /** 归一化到简体的整句原文（与 annotate 的 logicText 同源） */
  context: string;
  /** 用户选定的读音（带声调符号，如 "yuè"） */
  reading: string;
  /** 创建/更新时间（ISO） */
  createdAt: string;
}

/** MMKV 实例（加密 KV 存储） */
const storage = new MMKV();

/** zustand persist 所需的 storage adapter（与 useSettingsStore 同款） */
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

/** persist 存储键 */
const PERSIST_KEY = 'reading-override-store';

interface ReadingOverrideState {
  /** 用户读音纠正列表（新条目在前） */
  overrides: ReadingOverride[];

  /**
   * 新增/更新读音纠正：同 char+context 幂等覆盖（保留原 id，更新 reading 与 createdAt）。
   * 空 char / 空 context / 空 reading 防御拒绝（静默忽略，参考 removeByBook 的防御模式）。
   */
  addOverride: (char: string, context: string, reading: string) => void;
  /** 按 ID 删除 */
  removeOverride: (id: string) => void;
  /** 删除某字的所有纠正 */
  removeOverridesByChar: (char: string) => void;
  /** 查询某字在某句的纠正读音（未命中返回 null） */
  getOverride: (char: string, context: string) => string | null;
  /** 查询某字在某句的完整纠正记录（UI 移除用；未命中返回 null） */
  getOverrideEntry: (char: string, context: string) => ReadingOverride | null;
  /**
   * 备份恢复（合并语义，不删用户已有）：合法条目按 char+context 幂等覆盖，
   * 设备独有的记录保留；非法条目（缺 char/context/reading）静默跳过；非数组入参报错。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useReadingOverrideStore = create<ReadingOverrideState>()(
  persist(
    (set, get) => ({
      overrides: [],

      addOverride: (char, context, reading) => {
        // 防御拒绝：空 char / 空 context / 空 reading 一律不落库（参考 removeByBook 短路模式）
        if (!char || !context || !reading) {
          return;
        }
        set((state) => {
          const existing = state.overrides.find(
            (o) => o.char === char && o.context === context,
          );
          if (existing) {
            // 同 char+context 幂等覆盖：保留原 id 与插入位次，更新读音与时间
            return {
              overrides: state.overrides.map((o) =>
                o.id === existing.id
                  ? { ...o, reading, createdAt: nowISO() }
                  : o,
              ),
            };
          }
          const entry: ReadingOverride = {
            id: genId('ro'),
            char,
            context,
            reading,
            createdAt: nowISO(),
          };
          return { overrides: [entry, ...state.overrides] };
        });
      },

      removeOverride: (id) => {
        set((state) => ({
          overrides: state.overrides.filter((o) => o.id !== id),
        }));
      },

      removeOverridesByChar: (char) => {
        // 空 char 直接跳过：避免误删全部
        if (!char) {
          return;
        }
        set((state) => ({
          overrides: state.overrides.filter((o) => o.char !== char),
        }));
      },

      getOverride: (char, context) => {
        const hit = get().overrides.find(
          (o) => o.char === char && o.context === context,
        );
        return hit ? hit.reading : null;
      },

      getOverrideEntry: (char, context) => {
        const hit = get().overrides.find(
          (o) => o.char === char && o.context === context,
        );
        return hit ?? null;
      },

      restoreFromBackup: (data) => {
        if (!Array.isArray(data)) {
          console.warn('[ReadingOverrideStore] 恢复读音纠正失败：备份数据格式不正确');
          return;
        }
        set((state) => {
          // 以现有记录为基底（合并语义：不删用户已有），备份条目按 char+context 幂等覆盖
          const byKey = new Map<string, ReadingOverride>();
          for (const o of state.overrides) {
            byKey.set(`${o.char}\u0000${o.context}`, o);
          }
          for (const raw of data) {
            if (!raw || typeof raw !== 'object') {
              continue;
            }
            const item = raw as Partial<ReadingOverride>;
            if (
              typeof item.char !== 'string' ||
              item.char === '' ||
              typeof item.context !== 'string' ||
              item.context === '' ||
              typeof item.reading !== 'string' ||
              item.reading === ''
            ) {
              continue;
            }
            const key = `${item.char}\u0000${item.context}`;
            const existing = byKey.get(key);
            if (existing) {
              // 覆盖读音但保留原 id（与 addOverride 幂等语义一致）
              byKey.set(key, {
                ...existing,
                reading: item.reading,
                createdAt:
                  typeof item.createdAt === 'string'
                    ? item.createdAt
                    : existing.createdAt,
              });
            } else {
              byKey.set(key, {
                id: typeof item.id === 'string' && item.id !== '' ? item.id : genId('ro'),
                char: item.char,
                context: item.context,
                reading: item.reading,
                createdAt:
                  typeof item.createdAt === 'string' ? item.createdAt : nowISO(),
              });
            }
          }
          return { overrides: Array.from(byKey.values()) };
        });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStorage),
      version: 1,
    },
  ),
);

export default useReadingOverrideStore;
