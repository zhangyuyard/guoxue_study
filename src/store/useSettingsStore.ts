/**
 * 全局设置 Store（useSettingsStore）
 * 保存阅读器设置：字号 / 行距 / 主题 / 注音模式 / 繁简转换模式。
 * 使用 zustand persist 中间件 + MMKV 加密 KV 存储持久化。
 *
 * 设置分层（全局 vs 书籍级）：
 * - 全局层 = 本 store 顶层字段，「我的-设置」页写入，跨所有书生效；
 * - 书籍层 = perBookSettings（bookId -> 已覆盖键值），阅读页设置面板写入，
 *   仅「阅读体验类」白名单键（PER_BOOK_SETTING_KEYS）可覆盖；
 * - 读取经 resolveReaderSetting / useReaderBookSettings：书籍层优先，缺键回落全局层；
 * - 删除书籍层键（clearPerBookSettings）= 恢复「跟随全局」。
 */
import { useCallback } from 'react';
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

// ============ 设置分层：书籍级覆盖（per-book overrides） ============

/**
 * 允许按书籍覆盖的「阅读体验类」设置键白名单。
 * 口径 = 阅读页内可修改的阅读体验项（设置面板五项 + 右上角注音/繁简开关）；
 * 主题 / 翻译 / 字典 / 提醒 / 目标 / 语速等仅保留全局层（阅读页不提供入口）。
 */
export const PER_BOOK_SETTING_KEYS = [
  'fontSize',
  'lineHeight',
  'paper',
  'readerMode',
  'pinyinMode',
  'conversionMode',
] as const;

/** 可按书籍覆盖的设置键类型 */
export type PerBookSettingKey = (typeof PER_BOOK_SETTING_KEYS)[number];

/** 单本书的覆盖值集合：仅含已覆盖键，缺的键 = 跟随全局默认 */
export type PerBookSettings = Partial<Pick<ReaderSettings, PerBookSettingKey>>;

/**
 * 从设置 patch 中挑出允许按书覆盖的键（写入书籍层前的白名单过滤，
 * 防御调用方把 theme / translation 等全局项混入 per-book 层）。
 */
function pickPerBookKeys(patch: Partial<ReaderSettings>): PerBookSettings {
  const out: PerBookSettings = {};
  for (const key of PER_BOOK_SETTING_KEYS) {
    const value = patch[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * 备份恢复用：对 unknown 入参逐键类型校验后挑出合法覆盖值
 * （口径与 restoreFromBackup 既有风格一致：非法值静默跳过）。
 */
function sanitizePerBookEntry(input: unknown): PerBookSettings {
  const out: PerBookSettings = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return out;
  }
  const d = input as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const fontSize = num(d.fontSize);
  if (fontSize !== undefined) out.fontSize = fontSize;
  const lineHeight = num(d.lineHeight);
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  const paper = str(d.paper);
  if (paper !== undefined) out.paper = paper as PaperMode;
  const readerMode = str(d.readerMode);
  if (readerMode !== undefined) out.readerMode = readerMode as ReaderMode;
  const pinyinMode = str(d.pinyinMode);
  if (pinyinMode !== undefined) out.pinyinMode = pinyinMode as PinyinMode;
  const conversionMode = str(d.conversionMode);
  if (conversionMode === 'simplified' || conversionMode === 'traditional') {
    out.conversionMode = conversionMode;
  }
  return out;
}

interface SettingsState extends ReaderSettings {
  /** 翻译服务配置（服务商 + 用户自带 Key） */
  translation: TranslationSettings;
  /** 提示粒度（P1-07，背诵填空模式）：whole=整篇 / paragraph=逐段 / sentence=逐句 */
  recitationHintGranularity: RecitationHintGranularity;
  /** 收藏列表分组视图开关（P2-09）：false=平铺（默认） / true=按首标签分组 */
  bookmarkGroupedView: boolean;
  /** 书架展示方式：grid=2 列网格（默认）/ list=单列列表 */
  libraryLayout: 'grid' | 'list';
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
  /**
   * 书籍级设置覆盖（设置分层）：bookId -> 已覆盖键值。
   * 仅「阅读体验类」（PER_BOOK_SETTING_KEYS 白名单）；缺键 = 跟随全局默认。
   * 「我的-设置」写全局层（原有 setter），阅读页设置面板写本层，互不干扰。
   */
  perBookSettings: Record<string, PerBookSettings>;
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
  /** 切换书架展示方式（网格/列表） */
  setLibraryLayout: (layout: 'grid' | 'list') => void;
  /** 更新朗读语速（P2-02，取值 0.5–2.0） */
  setSpeechRate: (rate: number) => void;
  /** 更新复习提醒设置（部分合并，B4） */
  setRecitationReminder: (patch: Partial<RecitationReminderSettings>) => void;
  /** 更新每日背诵目标开关（P1-09） */
  setDailyGoalEnabled: (enabled: boolean) => void;
  /** 更新每日背诵目标量（P1-09，clamp 到 1–99） */
  setDailyGoalCount: (count: number) => void;
  /**
   * 写入某本书的覆盖值（设置分层）：仅白名单键落库，未提及键保持不变。
   * 空 patch（白名单过滤后无合法键）静默忽略。
   */
  setPerBookSettings: (bookId: string, patch: Partial<ReaderSettings>) => void;
  /**
   * 清空某本书的覆盖，恢复「跟随全局」：不传 keys 清空本书全部覆盖
   * （删除整个 bookId 条目）；传 keys 仅删除指定键，键清空后条目一并移除。
   */
  clearPerBookSettings: (bookId: string, keys?: PerBookSettingKey[]) => void;
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
      libraryLayout: 'grid',
      speechRate: 1.0,
      ...DEFAULT_REMINDER_SETTINGS,
      // P1-09 每日目标：默认开启、默认 5 段（常量统一定义在 utils/dailyGoal）
      dailyGoalEnabled: true,
      dailyGoalCount: DEFAULT_DAILY_GOAL,
      // 书籍级覆盖层（设置分层）：初始为空 = 全部跟随全局
      perBookSettings: {},

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

      setLibraryLayout: (libraryLayout) => set({ libraryLayout }),

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

      // 设置分层：白名单过滤后合并进本书覆盖层（未提及键保持不变）
      setPerBookSettings: (bookId, patch) => {
        if (!bookId) {
          return;
        }
        const filtered = pickPerBookKeys(patch);
        if (Object.keys(filtered).length === 0) {
          return;
        }
        set((state) => ({
          perBookSettings: {
            ...state.perBookSettings,
            [bookId]: { ...(state.perBookSettings[bookId] ?? {}), ...filtered },
          },
        }));
      },

      // 设置分层：清覆盖恢复「跟随全局」。keys 缺省 = 删整本书条目；
      // 指定 keys 时逐键删除，删空后条目一并移除（避免留空壳对象）。
      clearPerBookSettings: (bookId, keys) => {
        if (!bookId) {
          return;
        }
        set((state) => {
          const prev = state.perBookSettings[bookId];
          if (!prev) {
            return state;
          }
          if (!keys || keys.length === 0) {
            const next = { ...state.perBookSettings };
            delete next[bookId];
            return { perBookSettings: next };
          }
          const rest = { ...prev };
          for (const key of keys) {
            delete rest[key];
          }
          const next = { ...state.perBookSettings };
          if (Object.keys(rest).length === 0) {
            delete next[bookId];
          } else {
            next[bookId] = rest;
          }
          return { perBookSettings: next };
        });
      },

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
          // perBookSettings（书籍级覆盖，v1 可选扩展字段）：旧备份缺失 = 不动现值；
          // 新备份提供时逐书逐键类型校验后与现值合并（备份值覆盖同键现值）
          if (
            d.perBookSettings &&
            typeof d.perBookSettings === 'object' &&
            !Array.isArray(d.perBookSettings)
          ) {
            const restored: Record<string, PerBookSettings> = {};
            for (const [bid, entry] of Object.entries(
              d.perBookSettings as Record<string, unknown>,
            )) {
              if (typeof bid !== 'string' || bid === '') {
                continue;
              }
              const sanitized = sanitizePerBookEntry(entry);
              if (Object.keys(sanitized).length > 0) {
                restored[bid] = sanitized;
              }
            }
            if (Object.keys(restored).length > 0) {
              patch.perBookSettings = { ...state.perBookSettings, ...restored };
            }
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

/**
 * 设置分层取值（纯函数）：某键在某书的生效值。
 * 解析顺序：perBookSettings[bookId]?.[key]（书籍层覆盖）→ 全局层（state[key]）。
 * bookId 为空（无路由参数等防御场景）直接取全局层。
 */
export function resolveReaderSetting<K extends PerBookSettingKey>(
  settings: SettingsState,
  key: K,
  bookId?: string | null,
): ReaderSettings[K] {
  if (bookId) {
    const overridden = settings.perBookSettings[bookId]?.[key];
    if (overridden !== undefined) {
      return overridden;
    }
  }
  return settings[key];
}

/** useReaderBookSettings 返回值（阅读页设置消费视图） */
export interface UseReaderBookSettingsResult {
  /** 解析后的生效值（书籍层覆盖 → 全局默认） */
  fontSize: number;
  lineHeight: number;
  paper: PaperMode;
  readerMode: ReaderMode;
  pinyinMode: PinyinMode;
  conversionMode: ConversionMode;
  /** 写入 setter：有 bookId 时写书籍层（perBookSettings），否则写全局层（防御旧路由） */
  setFontSize: (v: number) => void;
  setLineHeight: (v: number) => void;
  setPaper: (v: PaperMode) => void;
  setReaderMode: (v: ReaderMode) => void;
  setPinyinMode: (v: PinyinMode) => void;
  setConversionMode: (v: ConversionMode) => void;
  /** 当前书已生效的覆盖值（仅含已覆盖键）；空对象 = 完全跟随全局 */
  bookOverrides: PerBookSettings;
  /** 当前书是否存在任一覆盖键（控制「恢复跟随全局」入口显隐） */
  hasBookOverrides: boolean;
  /** 是否处于书籍分层模式（有 bookId 即分层；设置面板据此显示分层说明文案） */
  isPerBook: boolean;
  /** 复位为「跟随全局」：不传 keys 清空本书全部覆盖，传 keys 仅清指定键 */
  followGlobal: (keys?: PerBookSettingKey[]) => void;
}

/**
 * 阅读页设置消费 Hook（设置分层）。
 * 读：书籍层覆盖优先，缺键回落全局默认（resolveReaderSetting 同语义）；
 * 写：有 bookId 时仅写书籍层（「我的-设置」写全局层，互不污染），
 * 无 bookId（理论不出现的防御路径）回落写全局层，保持旧行为。
 * 返回的 setter 与 useSettingsStore 同名 action 签名一致，
 * ReaderScreen 消费侧无需改动调用点即可切换到分层语义。
 */
export function useReaderBookSettings(
  bookId?: string | null,
): UseReaderBookSettingsResult {
  const bookKey = bookId ?? '';

  // 书籍层覆盖（未覆盖书恒为 undefined 引用，不触发多余重渲染）
  const override = useSettingsStore((s) =>
    bookKey ? s.perBookSettings[bookKey] : undefined,
  );
  // 全局层基准值
  const gFontSize = useSettingsStore((s) => s.fontSize);
  const gLineHeight = useSettingsStore((s) => s.lineHeight);
  const gPaper = useSettingsStore((s) => s.paper);
  const gReaderMode = useSettingsStore((s) => s.readerMode);
  const gPinyinMode = useSettingsStore((s) => s.pinyinMode);
  const gConversionMode = useSettingsStore((s) => s.conversionMode);
  // 写入路径：书籍层 action + 全局层 setter（无 bookId 防御回落用）
  const setPerBook = useSettingsStore((s) => s.setPerBookSettings);
  const clearPerBook = useSettingsStore((s) => s.clearPerBookSettings);
  const gSetFontSize = useSettingsStore((s) => s.setFontSize);
  const gSetLineHeight = useSettingsStore((s) => s.setLineHeight);
  const gSetPaper = useSettingsStore((s) => s.setPaper);
  const gSetReaderMode = useSettingsStore((s) => s.setReaderMode);
  const gSetPinyinMode = useSettingsStore((s) => s.setPinyinMode);
  const gSetConversionMode = useSettingsStore((s) => s.setConversionMode);

  // 解析生效值：覆盖优先，缺键回落全局
  const fontSize = override?.fontSize ?? gFontSize;
  const lineHeight = override?.lineHeight ?? gLineHeight;
  const paper = override?.paper ?? gPaper;
  const readerMode = override?.readerMode ?? gReaderMode;
  const pinyinMode = override?.pinyinMode ?? gPinyinMode;
  const conversionMode = override?.conversionMode ?? gConversionMode;

  /** 统一写入：有书 → 书籍层；无书 → 全局层（防御回落） */
  const write = useCallback(
    (patch: Partial<ReaderSettings>) => {
      if (bookKey) {
        setPerBook(bookKey, patch);
      } else {
        if (patch.fontSize !== undefined) gSetFontSize(patch.fontSize);
        if (patch.lineHeight !== undefined) gSetLineHeight(patch.lineHeight);
        if (patch.paper !== undefined) gSetPaper(patch.paper);
        if (patch.readerMode !== undefined) gSetReaderMode(patch.readerMode);
        if (patch.pinyinMode !== undefined) gSetPinyinMode(patch.pinyinMode);
        if (patch.conversionMode !== undefined) gSetConversionMode(patch.conversionMode);
      }
    },
    [
      bookKey,
      setPerBook,
      gSetFontSize,
      gSetLineHeight,
      gSetPaper,
      gSetReaderMode,
      gSetPinyinMode,
      gSetConversionMode,
    ],
  );

  const setFontSize = useCallback((v: number) => write({ fontSize: v }), [write]);
  const setLineHeight = useCallback((v: number) => write({ lineHeight: v }), [write]);
  const setPaper = useCallback((v: PaperMode) => write({ paper: v }), [write]);
  const setReaderMode = useCallback((v: ReaderMode) => write({ readerMode: v }), [write]);
  const setPinyinMode = useCallback((v: PinyinMode) => write({ pinyinMode: v }), [write]);
  const setConversionMode = useCallback(
    (v: ConversionMode) => write({ conversionMode: v }),
    [write],
  );

  const bookOverrides = override ?? EMPTY_PER_BOOK_SETTINGS;
  const hasBookOverrides = Object.keys(bookOverrides).length > 0;
  const followGlobal = useCallback(
    (keys?: PerBookSettingKey[]) => {
      if (bookKey) {
        clearPerBook(bookKey, keys);
      }
    },
    [bookKey, clearPerBook],
  );

  return {
    fontSize,
    lineHeight,
    paper,
    readerMode,
    pinyinMode,
    conversionMode,
    setFontSize,
    setLineHeight,
    setPaper,
    setReaderMode,
    setPinyinMode,
    setConversionMode,
    bookOverrides,
    hasBookOverrides,
    isPerBook: bookKey !== '',
    followGlobal,
  };
}

/** 空覆盖层常量（引用稳定，避免每次渲染新建空对象触发订阅方重渲染） */
const EMPTY_PER_BOOK_SETTINGS: PerBookSettings = {};

export default useSettingsStore;
