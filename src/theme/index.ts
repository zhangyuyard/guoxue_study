/**
 * 主题聚合导出
 * 提供 getTheme(theme) 便捷入口，返回当前主题完整配置。
 */
import { getColors, highlightColors, lightColors, darkColors, getPaperColors, PAPER_THEMES, PAPER_OPTIONS, withAlpha } from './colors';
import * as typography from './typography';
import type { ThemeColors } from './colors';
import type { ThemeMode } from '@/types';

export {
  getColors,
  highlightColors,
  lightColors,
  darkColors,
  getPaperColors,
  PAPER_THEMES,
  PAPER_OPTIONS,
  withAlpha,
};
export type { ThemeColors };
export * from './typography';
export { typography };

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
}

/** 获取指定模式的完整主题对象 */
export function getTheme(mode: ThemeMode = 'light'): Theme {
  return {
    mode,
    colors: getColors(mode),
  };
}
