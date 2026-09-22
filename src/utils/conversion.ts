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

/**
 * 绝不简化的字符（opencc tw→cn 一对多误并白名单）。
 * 这些字在标准中本就不简化，opencc 却把它们并入了读音不同的简字，
 * 会毁掉后续注音查表（toSimplified 仅用于读音归一化，不改显示文本）：
 *   - 乾(qián)：opencc 误并 乾→干；但 乾 从不简化，仅「幹」才简化成「干」。
 *     全库/通例 乾（乾卦/乾坤/乾元/乾道/乾封/乾侯/乾归）恒读 qián，无「乾=干」合法场景。
 * 用法：toSimplified 在 opencc 之后按位还原——仅当原文该位确为受保护字符才还原，
 * 绝不误伤真正的 干/等（长度 1:1，逐码点对齐，错位时回退 opencc 结果）。
 */
const NEVER_SIMPLIFY: Readonly<Record<string, string>> = {
  '乾': '乾',
};

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
  const converted = getTw2Cn()(text);
  // 位置级还原：修正 opencc 一对多误并（如 乾→干）。
  // 仅当原文该位确为受保护字符时才还原，绝不误伤真正应简化的字。
  const src = Array.from(text);
  const res = Array.from(converted);
  if (src.length !== res.length) {
    // 非 1:1（极罕见）时不做还原，避免错位误伤
    return converted;
  }
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const protect = NEVER_SIMPLIFY[src[i]];
    out += protect !== undefined ? protect : res[i];
  }
  return out;
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
