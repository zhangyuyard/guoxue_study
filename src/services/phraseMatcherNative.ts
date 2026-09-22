/**
 * phraseMatcherNative — 原生 PhraseMatcher 模块（方案 3d）的 JS 访问隔离层。
 *
 * 职责：在 NativeModules 中探测 "PhraseMatcher" 原生模块（Android Kotlin /
 * iOS ObjC，旧架构同步桥），暴露统一只读接口；不存在时返回 null，使上层
 * computePhraseOverlay / ensurePhrasePinyinData 安全回退到原 JS 支。
 *
 * 契约（与原生实现严格对齐）：
 * - isLoaded(): boolean —— 原生 HashMap 是否后台构建完成
 * - match(text): Array<[number, string]> —— 整段正向最大匹配，返回 [[idx, syllable], …]
 *
 * 测试环境（jest）：NativeModules.PhraseMatcher 不存在 → 返回 null → 全走 JS 支，
 * 166 条冻结断言零回归。
 */
import { NativeModules } from 'react-native';

/** 单条匹配结果：[码点下标, 读音音节] */
export type PhraseMatchPair = [number, string];

/** 原生 PhraseMatcher 统一接口 */
export interface NativePhraseMatcher {
  isLoaded(): boolean;
  match(text: string): PhraseMatchPair[];
}

let cached: NativePhraseMatcher | null | undefined;

/**
 * 取原生 matcher（带缓存）。无原生模块 / 接口不完整时返回 null。
 */
export function getNativePhraseMatcher(): NativePhraseMatcher | null {
  if (cached !== undefined) {
    return cached;
  }
  const mod = (NativeModules as Record<string, any> | undefined)?.PhraseMatcher;
  if (!mod || typeof mod.match !== 'function' || typeof mod.isLoaded !== 'function') {
    cached = null;
    return cached;
  }
  cached = {
    isLoaded: () => mod.isLoaded() === true,
    match: (t: string): PhraseMatchPair[] => {
      const raw = mod.match(t);
      return Array.isArray(raw) ? (raw as PhraseMatchPair[]) : [];
    },
  };
  return cached;
}

/** 原生词组层是否已就绪（无原生模块时返回 false） */
export function nativePhraseLoaded(): boolean {
  const m = getNativePhraseMatcher();
  return m ? m.isLoaded() : false;
}
