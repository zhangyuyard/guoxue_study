import type { PaperMode, ThemeMode } from '@/types';

/**
 * 颜色调色板
 * 日间 / 夜间两套语义色（全局 UI 暗色开关），以及阅读器专属的「纸张」配色
 * （阅读背景换肤，对标微信读书 / 番茄小说）。
 */

/** 日间模式颜色 */
export const lightColors = {
  /** 页面背景 */
  background: '#FFFFFF',
  /** 卡片背景 */
  card: '#F7F7F7',
  /** 正文 */
  text: '#333333',
  /** 次要文本 */
  textSecondary: '#666666',
  /** 注音 */
  pinyin: '#999999',
  /** 分割线 / 边框 */
  border: '#E5E5E5',
  /** 主色（品牌） */
  primary: '#8B5E3C',
  /** 主色浅底 */
  primarySoft: '#F5EFE9',
  /** 强调 / 链接 */
  accent: '#C62828',
  /** 输入框背景 */
  inputBackground: '#F2F2F2',
  /** 遮罩 */
  overlay: 'rgba(0, 0, 0, 0.5)',
};

/** 夜间模式颜色 */
export const darkColors = {
  background: '#1A1A1A',
  card: '#242424',
  text: '#E0E0E0',
  textSecondary: '#B0B0B0',
  pinyin: '#666666',
  border: '#333333',
  primary: '#C9A16E',
  primarySoft: '#2B231A',
  accent: '#EF9A9A',
  inputBackground: '#2A2A2A',
  overlay: 'rgba(0, 0, 0, 0.7)',
};

/** 划线颜色（两种主题共用） */
export const highlightColors = {
  yellow: 'rgba(255, 235, 59, 0.3)',
  green: 'rgba(76, 175, 80, 0.3)',
  blue: 'rgba(33, 150, 243, 0.3)',
} as const;

/** 按主题获取色板 */
export function getColors(theme: ThemeMode) {
  return theme === 'dark' ? darkColors : lightColors;
}

export type ThemeColors = typeof lightColors;

// ============ 阅读纸张（阅读器专属背景换肤） ============
/**
 * 5 套纸张对标主流阅读器：
 * - default 默认白：经典白底
 * - green   护眼绿：豆绿色，久读不刺眼
 * - sepia   羊皮纸：米黄纸感，仿实体书
 * - dark    夜间黑：暗色护眼
 * - cyan    淡青：  浅青蓝，清爽
 * 主色（品牌棕）在浅色纸张保持一致；夜间纸张改用暖金主色以契合暗底。
 */

/** 纸张选项（供设置面板渲染色块与标签） */
export const PAPER_OPTIONS: { key: PaperMode; label: string; swatch: string }[] = [
  { key: 'default', label: '默认', swatch: '#FFFFFF' },
  { key: 'green', label: '护眼', swatch: '#C7EDCC' },
  { key: 'sepia', label: '羊皮纸', swatch: '#F7EED8' },
  { key: 'dark', label: '夜间', swatch: '#1A1A1A' },
  { key: 'cyan', label: '淡青', swatch: '#E8F4F8' },
];

const paperDefault: ThemeColors = {
  background: '#FFFFFF',
  card: '#F7F7F7',
  text: '#333333',
  textSecondary: '#666666',
  pinyin: '#999999',
  border: '#E5E5E5',
  primary: '#8B5E3C',
  primarySoft: '#F5EFE9',
  accent: '#C62828',
  inputBackground: '#F2F2F2',
  overlay: 'rgba(0, 0, 0, 0.5)',
};

const paperGreen: ThemeColors = {
  background: '#C7EDCC',
  card: '#BCE3C1',
  text: '#2E3B2E',
  textSecondary: '#4A5A4A',
  pinyin: '#7A8A7A',
  border: '#A9D6AE',
  primary: '#5B8C5A',
  primarySoft: '#E3F3E5',
  accent: '#C0622B',
  inputBackground: '#D8EFDB',
  overlay: 'rgba(20, 40, 20, 0.45)',
};

const paperSepia: ThemeColors = {
  background: '#F7EED8',
  card: '#EFE3C8',
  text: '#5B4636',
  textSecondary: '#8A7355',
  pinyin: '#B09A7A',
  border: '#E0D2B4',
  primary: '#8B5E3C',
  primarySoft: '#EDE0C8',
  accent: '#B5651D',
  inputBackground: '#EFE3C8',
  overlay: 'rgba(60, 40, 20, 0.5)',
};

const paperDark: ThemeColors = {
  background: '#1A1A1A',
  card: '#242424',
  text: '#E0E0E0',
  textSecondary: '#B0B0B0',
  pinyin: '#666666',
  border: '#333333',
  primary: '#C9A16E',
  primarySoft: '#2B231A',
  accent: '#EF9A9A',
  inputBackground: '#2A2A2A',
  overlay: 'rgba(0, 0, 0, 0.7)',
};

const paperCyan: ThemeColors = {
  background: '#E8F4F8',
  card: '#D9ECF2',
  text: '#2C3E45',
  textSecondary: '#4A626B',
  pinyin: '#7E98A0',
  border: '#B6D4DE',
  primary: '#2E7D8A',
  primarySoft: '#DDEFF4',
  accent: '#C0622B',
  inputBackground: '#D9ECF2',
  overlay: 'rgba(10, 30, 40, 0.45)',
};

/** 纸张配色表 */
export const PAPER_THEMES: Record<PaperMode, ThemeColors> = {
  default: paperDefault,
  green: paperGreen,
  sepia: paperSepia,
  dark: paperDark,
  cyan: paperCyan,
};

/** 按阅读纸张获取色板 */
export function getPaperColors(paper: PaperMode): ThemeColors {
  return PAPER_THEMES[paper] ?? paperDefault;
}
