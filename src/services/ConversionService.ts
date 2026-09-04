/**
 * 繁简转换服务（ConversionService）
 * 基于 opencc-js（纯 JS，RN 兼容），提供繁↔简双向转换。
 * 转换核心复用 src/utils/conversion.ts（懒加载 + 缓存 Converter 实例）。
 */
import type { ServiceResult } from '@/types';
import {
  toSimplified as convertToSimplified,
  toTraditional as convertToTraditional,
  convertBatch,
  containsTraditional,
} from '@/utils/conversion';

export const ConversionService = {
  /** 繁 → 简 */
  toSimplified(text: string): ServiceResult<string> {
    if (!text) {
      return { success: true, data: '' };
    }
    try {
      return { success: true, data: convertToSimplified(text) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 简 → 繁 */
  toTraditional(text: string): ServiceResult<string> {
    if (!text) {
      return { success: true, data: '' };
    }
    try {
      return { success: true, data: convertToTraditional(text) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 按设置方向批量转换 */
  convert(
    text: string,
    mode: 'simplified' | 'traditional',
  ): ServiceResult<string> {
    return mode === 'traditional'
      ? this.toTraditional(text)
      : this.toSimplified(text);
  },

  /** 批量转换文本数组 */
  convertMany(
    texts: string[],
    mode: 'simplified' | 'traditional',
  ): ServiceResult<string[]> {
    if (!texts || texts.length === 0) {
      return { success: true, data: [] };
    }
    try {
      return { success: true, data: convertBatch(texts, mode) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 判断文本是否含繁体字 */
  hasTraditional(text: string): ServiceResult<boolean> {
    if (!text) {
      return { success: true, data: false };
    }
    try {
      return { success: true, data: containsTraditional(text) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
};

export default ConversionService;
