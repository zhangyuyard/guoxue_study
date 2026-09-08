/**
 * 带进程内缓存的繁简转换（纯函数，供阅读器等高频转换场景复用）。
 *
 * 背景（真机问题 6：仿真模式切换繁简耗时过长）：阅读器每次切换繁简都要对
 * 当前章全部段落重新走 opencc 转换（语种探测 + 目标语转换，单段可达 2500 字），
 * 连续滚动模式拼接/丢头时也会对已加载章节整章重转。opencc 单次调用并不便宜，
 * 同一文本在同一会话内结果恒定（纯函数），故按原文做进程内 LRU 缓存：
 * 重复切换、章节重渲染、邻章预热全部命中缓存，摊平转换开销。
 *
 * 缓存有界（命中前置刷新近似 LRU），防止长书阅读会话内存无界增长；
 * 转换异常时回落为「返回原文」，与 ConversionService 失败回落语义一致。
 */
import { toSimplified as convertToSimplified, toTraditional as convertToTraditional } from './conversion';

/** 缓存上限（条目数）：单条最大约 2500 字，2000 条最坏约 20MB 级，可接受 */
const CONVERSION_CACHE_LIMIT = 2000;

/** 简体结果缓存：原文 -> 简体 */
const toSimplifiedCache = new Map<string, string>();
/** 繁体结果缓存：原文 -> 繁体 */
const toTraditionalCache = new Map<string, string>();

/** 命中后把键移动到 Map 尾部（近似 LRU），超限时淘汰最旧条目 */
function touchAndTrim(cache: Map<string, string>, key: string, value: string): string {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CONVERSION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return value;
}

/** 繁 → 简（带缓存；转换异常回落原文） */
export function memoToSimplified(text: string): string {
  if (!text) {
    return text;
  }
  const cached = toSimplifiedCache.get(text);
  if (cached !== undefined) {
    return touchAndTrim(toSimplifiedCache, text, cached);
  }
  let out: string;
  try {
    out = convertToSimplified(text);
  } catch {
    return text;
  }
  return touchAndTrim(toSimplifiedCache, text, out);
}

/** 简 → 繁（带缓存；转换异常回落原文） */
export function memoToTraditional(text: string): string {
  if (!text) {
    return text;
  }
  const cached = toTraditionalCache.get(text);
  if (cached !== undefined) {
    return touchAndTrim(toTraditionalCache, text, cached);
  }
  let out: string;
  try {
    out = convertToTraditional(text);
  } catch {
    return text;
  }
  return touchAndTrim(toTraditionalCache, text, out);
}

/** 当前缓存条目数（测试与诊断用） */
export function conversionMemoSize(): { simplified: number; traditional: number } {
  return { simplified: toSimplifiedCache.size, traditional: toTraditionalCache.size };
}

/** 清空缓存（测试用） */
export function clearConversionMemo(): void {
  toSimplifiedCache.clear();
  toTraditionalCache.clear();
}
