/**
 * 字典设置 Store（useDictStore）
 * 持久化（MMKV，key = 'guoxue-dict-settings'）：
 *   - dictSettings：dictId → { enabled, order }（启用/排序）
 *   - defaultDictId：查字页默认聚焦字典
 *   - polyphoneSource：多音字读音来源（内置 / 某启用字典）
 * 瞬态（partialize 排除）：导入进度 importStatus / importProgress。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';
import type { DictMeta, ImportStatus, PolyphoneSource } from '@/types/dict';

const storage = new MMKV();

const mmkvStorage: StateStorage = {
  setItem: (name, value) => storage.set(name, value),
  getItem: (name) => storage.getString(name) ?? null,
  removeItem: (name) => storage.delete(name),
};

export interface DictImportProgress {
  fileName: string;
  entryCount: number;
  error?: string;
}

export interface DictState {
  /** dictId → 可变设置（启用 + 查询优先级，小者先） */
  dictSettings: Record<string, { enabled: boolean; order: number }>;
  /** 查字页默认聚焦字典 */
  defaultDictId: string | null;
  /** 多音字读音来源（默认内置规则库） */
  polyphoneSource: PolyphoneSource;

  setEnabled(dictId: string, enabled: boolean): void;
  reorder(dictId: string, direction: 'up' | 'down'): void;
  setDefaultDict(dictId: string): void;
  setPolyphoneSource(src: PolyphoneSource): void;
  /** 以 DictEngine.listDicts() 结果写回 settings（新增字典默认 enabled:true，已存在保留） */
  syncFromEngine(): void;
  /** 清除某字典的设置残留（删除字典时调用） */
  removeSetting(dictId: string): void;

  /* ---- 瞬态（不持久化） ---- */
  importStatus: ImportStatus;
  importProgress: DictImportProgress;
  setImportStatus(s: ImportStatus, p?: Partial<DictImportProgress>): void;
  resetImportStatus(): void;
}

/** 依据引擎字典列表计算带默认值的顺序 */
function computeSettings(
  dicts: DictMeta[],
  prev: Record<string, { enabled: boolean; order: number }>,
): Record<string, { enabled: boolean; order: number }> {
  const next: Record<string, { enabled: boolean; order: number }> = {};
  // 已有 order 的字典按原 order 排；新字典排在尾部
  const withOrder = dicts.filter((d) => prev[d.id]);
  const withoutOrder = dicts.filter((d) => !prev[d.id]);
  withOrder.sort((a, b) => prev[a.id].order - prev[b.id].order);
  const ordered = [...withOrder, ...withoutOrder];
  ordered.forEach((d, idx) => {
    const p = prev[d.id];
    next[d.id] = p ? { enabled: p.enabled, order: idx } : { enabled: true, order: idx };
  });
  return next;
}

export const useDictStore = create<DictState>()(
  persist(
    (set, get) => ({
      dictSettings: {},
      defaultDictId: null,
      polyphoneSource: { type: 'builtin' },

      setEnabled: (dictId, enabled) =>
        set((state) => ({
          dictSettings: {
            ...state.dictSettings,
            [dictId]: { enabled, order: state.dictSettings[dictId]?.order ?? 0 },
          },
        })),

      reorder: (dictId, direction) => {
        const settings = { ...get().dictSettings };
        const ids = Object.keys(settings).sort((a, b) => settings[a].order - settings[b].order);
        const idx = ids.indexOf(dictId);
        const swapWith = direction === 'up' ? idx - 1 : idx + 1;
        if (idx < 0 || swapWith < 0 || swapWith >= ids.length) {
          return;
        }
        [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
        const next: Record<string, { enabled: boolean; order: number }> = {};
        ids.forEach((id, order) => {
          next[id] = { enabled: settings[id].enabled, order };
        });
        set({ dictSettings: next });
      },

      setDefaultDict: (dictId) => set({ defaultDictId: dictId }),

      setPolyphoneSource: (polyphoneSource) => set({ polyphoneSource }),

      syncFromEngine: () => {
        // 惰性 require 规避 store → engine 的模块环（engine 顶层 import 本 store）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DictEngine } = require('@/services/dict/DictEngine') as typeof import('@/services/dict/DictEngine');
        const res = DictEngine.listDicts();
        if (!res.success || !res.data) {
          return;
        }
        set((state) => ({
          dictSettings: computeSettings(res.data as DictMeta[], state.dictSettings),
        }));
      },

      removeSetting: (dictId) =>
        set((state) => {
          const next = { ...state.dictSettings };
          delete next[dictId];
          const patch: Partial<DictState> = { dictSettings: next };
          if (state.defaultDictId === dictId) {
            patch.defaultDictId = null;
          }
          if (state.polyphoneSource.type === 'dict' && state.polyphoneSource.dictId === dictId) {
            patch.polyphoneSource = { type: 'builtin' };
          }
          return patch;
        }),

      importStatus: 'idle',
      importProgress: { fileName: '', entryCount: 0 },

      setImportStatus: (s, p) =>
        set((state) => ({
          importStatus: s,
          importProgress: { ...state.importProgress, ...p },
        })),

      resetImportStatus: () =>
        set({ importStatus: 'idle', importProgress: { fileName: '', entryCount: 0 } }),
    }),
    {
      name: 'guoxue-dict-settings',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        dictSettings: state.dictSettings,
        defaultDictId: state.defaultDictId,
        polyphoneSource: state.polyphoneSource,
      }),
    },
  ),
);

export default useDictStore;
