/**
 * 繁简转换辅助函数
 * 基于 opencc-js（纯 JS，RN 兼容），提供繁↔简双向转换。
 * 采用懒加载 + 缓存 Converter 实例，避免重复初始化开销。
 */

import { Converter, type ConverterOptions } from 'opencc-js';

let cn2Tw: ((text: string) => string) | null = null;
let tw2Cn: ((text: string) => string) | null = null;

function getCn2Tw(): (text: string) => string {
  if (!cn2Tw) {
    cn2Tw = Converter({ from: 'cn', to: 'tw' });
  }
  return cn2Tw;
}

function getTw2Cn(): (text: string) => string {
  if (!tw2Cn) {
    tw2Cn = Converter({ from: 'tw', to: 'cn' });
  }
  return tw2Cn;
}

/** 简 → 繁 */
export function toTraditional(text: string): string {
  if (!text) {
    return '';
  }
  return getCn2Tw()(text);
}

/** 繁 → 简 */
export function toSimplified(text: string): string {
  if (!text) {
    return '';
  }
  return getTw2Cn()(text);
}

/**
 * 批量转换：对数组中的每段文本执行转换
 * @param texts 文本数组
 * @param direction 转换方向
 */
export function convertBatch(
  texts: string[],
  direction: 'simplified' | 'traditional',
): string[] {
  const convert = direction === 'traditional' ? toTraditional : toSimplified;
  return texts.map(convert);
}

/** 判断文本是否包含繁体字（粗略，用于 UI 提示） */
export function containsTraditional(text: string): boolean {
  if (!text) {
    return false;
  }
  const converted = toSimplified(text);
  return converted !== text;
}

/** 根据 opencc 配置自定义转换器（供高级用法） */
export function createConverter(options: ConverterOptions): (text: string) => string {
  return Converter(options);
}
