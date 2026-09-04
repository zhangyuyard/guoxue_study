/**
 * 全局设置 Store（useSettingsStore）
 * 保存阅读器设置：字号 / 行距 / 主题 / 注音模式 / 繁简转换模式。
 * 使用 zustand persist 中间件 + MMKV 加密 KV 存储持久化。
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';
import type {
  PaperMode,
  PinyinMode,
  ReaderMode,
  ReaderSettings,
  RecitationHintGranularity,
  ThemeMode,
} from '@/types';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  type TranslationSettings,
} from '@/types/translation';
import {
  DEFAULT_DAILY_GOAL,
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
} from '@/utils/dailyGoal';

/** 繁简转换模式（与 ReaderSettings.conversionMode 保持一致） */
type ConversionMode = 'simplified' | 'traditional';

/** MMKV 实例（加密 KV 存储） */
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

/** 阅读器默认设置 */
const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  theme: 'light',
  paper: 'default',
  readerMode: 'scroll',
  pinyinMode: 'full',
  conversionMode: 'simplified',
};

/** 背诵复习提醒设置（B4）：每日本地提醒开关与提醒时刻 */
export interface RecitationReminderSettings {
  /** 是否开启每日复习提醒（默认关闭，需用户显式开启并授予通知权限） */
  reminderEnabled: boolean;
  /** 提醒时刻-小时（0-23，默认 19） */
  reminderHour: number;
  /** 提醒时刻-分钟（0-59，默认 0） */
  reminderMinute: number;
}

/** 复习提醒默认值 */
export const DEFAULT_REMINDER_SETTINGS: RecitationReminderSettings = {
  reminderEnabled: false,
  reminderHour: 19,
  reminderMinute: 0,
};

interface SettingsState extends ReaderSettings {
  /** 翻译服务配置（服务商 + 用户自带 Key） */
  translation: TranslationSettings;
  /** 提示粒度（P1-07，背诵填空模式）：whole=整篇 / paragraph=逐段 / sentence=逐句 */
  recitationHintGranularity: RecitationHintGranularity;
  /** 收藏列表分组视图开关（P2-09）：false=平铺（默认） / true=按首标签分组 */
  bookmarkGroupedView: boolean;
  /** 背诵复习提醒设置（B4）：开关 + 提醒时刻 */
  reminderEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
  /** 每日背诵目标开关（P1-09）：默认开启（不开启仅不展示目标进度，无提醒压力） */
  dailyGoalEnabled: boolean;
  /** 每日背诵目标量（段，1–99，默认 5） */
  dailyGoalCount: number;
  /** 正文朗读语速（P2-02）：0.5–2.0，默认 1.0 */
  speechRate: number;
  /** 更新单一设置项 */
  setSettings: (patch: Partial<ReaderSettings>) => void;
  /** 更新翻译配置（部分合并） */
  setTranslation: (patch: Partial<TranslationSettings>) => void;
  setTheme: (theme: ThemeMode) => void;
  setPaper: (paper: PaperMode) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setFontSize: (fontSize: number) => void;
  setLineHeight: (lineHeight: number) => void;
  setPinyinMode: (mode: PinyinMode) => void;
  setConversionMode: (mode: ConversionMode) => void;
  setRecitationHintGranularity: (granularity: RecitationHintGranularity) => void;
  setBookmarkGroupedView: (grouped: boolean) => void;
  /** 更新朗读语速（P2-02，取值 0.5–2.0） */
  setSpeechRate: (rate: number) => void;
  /** 更新复习提醒设置（部分合并，B4） */
  setRecitationReminder: (patch: Partial<RecitationReminderSettings>) => void;
  /** 更新每日背诵目标开关（P1-09） */
  setDailyGoalEnabled: (enabled: boolean) => void;
  /** 更新每日背诵目标量（P1-09，clamp 到 1–99） */
  setDailyGoalCount: (count: number) => void;
  /** 恢复默认设置 */
  reset: () => void;
  /**
   * 备份恢复（P2-15）：按白名单逐字段恢复，仅覆盖备份中存在的字段，
   * 未提供的字段保持现值（与整体 reset 语义不同）。
   * 非法值（类型不符 / 越界）静默跳过；结构校验由 utils/backup.parseBackup 前置完成。
   */
  restoreFromBackup: (data: unknown) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      translation: { ...DEFAULT_TRANSLATION_SETTINGS },
      recitationHintGranularity: 'whole',
      bookmarkGroupedView: false,
      speechRate: 1.0,
      ...DEFAULT_REMINDER_SETTINGS,
      // P1-09 每日目标：默认开启、默认 5 段（常量统一定义在 utils/dailyGoal）
      dailyGoalEnabled: true,
      dailyGoalCount: DEFAULT_DAILY_GOAL,

      setSettings: (patch) => set((state) => ({ ...state, ...patch })),

      setTranslation: (patch) =>
        set((state) => ({ ...state, translation: { ...state.translation, ...patch } })),

      setTheme: (theme) => set({ theme }),

      setPaper: (paper) => set({ paper }),

      setReaderMode: (readerMode) => set({ readerMode }),

      setFontSize: (fontSize) => set({ fontSize }),

      setLineHeight: (lineHeight) => set({ lineHeight }),

      setPinyinMode: (pinyinMode) => set({ pinyinMode }),

      setConversionMode: (conversionMode) => set({ conversionMode }),

      setRecitationHintGranularity: (recitationHintGranularity) =>
        set({ recitationHintGranularity }),

      setBookmarkGroupedView: (bookmarkGroupedView) => set({ bookmarkGroupedView }),

      setSpeechRate: (speechRate) => set({ speechRate }),

      setRecitationReminder: (patch) =>
        set((state) => ({
          reminderEnabled: patch.reminderEnabled ?? state.reminderEnabled,
          reminderHour: patch.reminderHour ?? state.reminderHour,
          reminderMinute: patch.reminderMinute ?? state.reminderMinute,
        })),

      setDailyGoalEnabled: (dailyGoalEnabled) => set({ dailyGoalEnabled }),

      // 目标量 clamp 到 1–99；Math.round 兜底非整数输入（步进器只会传整数）
      setDailyGoalCount: (count) =>
        set({
          dailyGoalCount: Math.min(DAILY_GOAL_MAX, Math.max(DAILY_GOAL_MIN, Math.round(count))),
        }),

      reset: () =>
        set({
          ...DEFAULT_SETTINGS,
          translation: { ...DEFAULT_TRANSLATION_SETTINGS },
          recitationHintGranularity: 'whole',
          bookmarkGroupedView: false,
          speechRate: 1.0,
          ...DEFAULT_REMINDER_SETTINGS,
          dailyGoalEnabled: true,
          dailyGoalCount: DEFAULT_DAILY_GOAL,
        }),

      restoreFromBackup: (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return;
        }
        const d = data as Record<string, unknown>;
        // 取值辅助：类型不符一律 undefined（该字段保持现值）
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        const bool = (v: unknown): boolean | undefined =>
          typeof v === 'boolean' ? v : undefined;
        const str = (v: unknown): string | undefined =>
          typeof v === 'string' ? v : undefined;

        set((state) => {
          const patch: Partial<SettingsState> = {};
          const fontSize = num(d.fontSize);
          if (fontSize !== undefined) patch.fontSize = fontSize;
          const lineHeight = num(d.lineHeight);
          if (lineHeight !== undefined) patch.lineHeight = lineHeight;
          const theme = str(d.theme);
          if (theme === 'light' || theme === 'dark') patch.theme = theme;
          const paper = str(d.paper);
          if (paper !== undefined) patch.paper = paper as PaperMode;
          const readerMode = str(d.readerMode);
          if (readerMode !== undefined) patch.readerMode = readerMode as ReaderMode;
          const pinyinMode = str(d.pinyinMode);
          if (pinyinMode !== undefined) patch.pinyinMode = pinyinMode as PinyinMode;
          const conversionMode = str(d.conversionMode);
          if (conversionMode === 'simplified' || conversionMode === 'traditional') {
            patch.conversionMode = conversionMode;
          }
          const granularity = str(d.recitationHintGranularity);
          if (granularity !== undefined) {
            patch.recitationHintGranularity = granularity as RecitationHintGranularity;
          }
          const grouped = bool(d.bookmarkGroupedView);
          if (grouped !== undefined) patch.bookmarkGroupedView = grouped;
          // 提醒时刻 clamp 到合法区间（与 setRecitationReminder 口径一致）
          const reminderEnabled = bool(d.reminderEnabled);
          if (reminderEnabled !== undefined) patch.reminderEnabled = reminderEnabled;
          const reminderHour = num(d.reminderHour);
          if (reminderHour !== undefined) {
            patch.reminderHour = Math.min(23, Math.max(0, Math.round(reminderHour)));
          }
          const reminderMinute = num(d.reminderMinute);
          if (reminderMinute !== undefined) {
            patch.reminderMinute = Math.min(59, Math.max(0, Math.round(reminderMinute)));
          }
          // 每日目标 clamp 到 1–99（与 setDailyGoalCount 口径一致）
          const dailyGoalEnabled = bool(d.dailyGoalEnabled);
          if (dailyGoalEnabled !== undefined) patch.dailyGoalEnabled = dailyGoalEnabled;
          const dailyGoalCount = num(d.dailyGoalCount);
          if (dailyGoalCount !== undefined) {
            patch.dailyGoalCount = Math.min(
              DAILY_GOAL_MAX,
              Math.max(DAILY_GOAL_MIN, Math.round(dailyGoalCount)),
            );
          }
          // 语速 clamp 到 0.5–2.0（与朗读服务口径一致）
          const speechRate = num(d.speechRate);
          if (speechRate !== undefined) {
            patch.speechRate = Math.min(2.0, Math.max(0.5, speechRate));
          }
          // translation 嵌套对象：与现值合并（备份缺的字段保持现值）
          if (d.translation && typeof d.translation === 'object' && !Array.isArray(d.translation)) {
            patch.translation = {
              ...state.translation,
              ...(d.translation as Partial<TranslationSettings>),
            };
          }
          return patch;
        });
      },
    }),
    {
      name: 'guoxue-settings',
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);

export default useSettingsStore;
