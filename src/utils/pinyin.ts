/**
 * 拼音处理辅助工具
 * - annotateText：对 PinyinService.annotate 的便捷封装，带 LRU 缓存
 * - getPinyinPairs：将 PinyinAnnotation[] 转换为渲染友好的 PinyinPair[]
 */
import type { PinyinAnnotation, PinyinMode, ServiceResult } from '@/types';

import { PinyinService } from '@/services/PinyinService';

/** 注音服务最小接口（便于替换/测试） */
export interface PinyinServiceLike {
  annotate: (
    text: string,
    mode: PinyinMode,
    opts?: { workId?: string; bookId?: string },
  ) => ServiceResult<PinyinAnnotation[]>;
}

/** 注音上下文选项（透传到服务层，用于 canon 语境校验） */
export interface AnnotateTextOptions {
  workId?: string;
  bookId?: string;
}

/** 渲染友好的注音单元 */
export interface PinyinPair {
  /** 原字 */
  char: string;
  /** 拼音（含声调，可为空） */
  pinyin: string;
  /** 是否生僻字 */
  isRare: boolean;
  /** 是否多音字 */
  isPolyphone: boolean;
  /** 通假字信息 */
  tongjia?: {
    original: string;
    note?: string;
    source?: string;
    sources?: string[];
    verified?: boolean;
  };
  /** 异体字列表 */
  yiti?: string[];
  /** 语境读音源 */
  readingSources?: string[];
  /** 语境读音是否校验 */
  readingVerified?: boolean;
}

/** 缓存条目上限（超出后淘汰最旧条目，防止长会话内存膨胀） */
const CACHE_LIMIT = 200;

/** 注音结果缓存：key = `${mode}::${text}` */
const cache = new Map<string, PinyinAnnotation[]>();

/** 判断单个字符是否汉字（含扩展区），与 PinyinService 的判定范围保持一致 */
export function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
    (cp >= 0x2a700 && cp <= 0x2ebef) // 扩展 C-F
  );
}

/**
 * 生成缓存 key（cacheSalt 用于字典域：多音字读音来源切换后强制失效旧缓存；
 * opts 的 workId|bookId 作为 canon 盐，避免换篇目命中旧缓存） */
function cacheKey(
  text: string,
  mode: PinyinMode,
  cacheSalt: string,
  opts?: AnnotateTextOptions,
): string {
  const canonSalt = `${opts?.workId ?? ''}|${opts?.bookId ?? ''}`;
  return `${mode}::${cacheSalt}::${canonSalt}::${text}`;
}

/**
 * 对文本注音（便捷封装，带缓存）。
 * 同一段文本 + 同一注音模式 + 同一上下文（workId/bookId）只计算一次。
 * @param text 原文
 * @param mode 注音模式（off 时返回空数组）
 * @param pinyinService 注音服务实例，默认使用内置 PinyinService
 * @param cacheSalt 缓存盐值（多音字读音来源标识，来源切换后不命中旧缓存）
 * @param opts 注音上下文（workId/bookId），用于 canon 语境校验，并入缓存盐
 */
export function annotateText(
  text: string,
  mode: PinyinMode,
  pinyinService: PinyinServiceLike = PinyinService,
  cacheSalt = '',
  opts?: AnnotateTextOptions,
): ServiceResult<PinyinAnnotation[]> {
  if (!text || mode === 'off') {
    return { success: true, data: [] };
  }

  const key = cacheKey(text, mode, cacheSalt, opts);
  const hit = cache.get(key);
  if (hit) {
    // 命中则移到 Map 尾部（最近使用）
    cache.delete(key);
    cache.set(key, hit);
    return { success: true, data: hit };
  }

  const res = pinyinService.annotate(text, mode, opts);
  if (!res.success || !res.data) {
    return { success: false, error: res.error };
  }

  if (cache.size >= CACHE_LIMIT) {
    // 淘汰最旧条目（Map 首个 key）
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, res.data);
  return { success: true, data: res.data };
}

/**
 * 将 PinyinAnnotation[] 转换为渲染友好格式。
 * 剥离服务层细节，仅保留渲染所需字段。
 */
export function getPinyinPairs(annotations: PinyinAnnotation[]): PinyinPair[] {
  return annotations.map((a) => ({
    char: a.char,
    pinyin: a.pinyin,
    isRare: a.isRare,
    isPolyphone: a.isPolyphone,
    tongjia: a.tongjia
      ? {
          original: a.tongjia.original,
          note: a.tongjia.note,
          source: a.tongjia.source,
          sources: a.tongjia.sources,
          verified: a.tongjia.verified,
        }
      : undefined,
    yiti: a.yiti ? [...a.yiti] : undefined,
    readingSources: a.readingSources,
    readingVerified: a.readingVerified,
  }));
}

/** 清空注音缓存（切换注音模式/内存吃紧时调用） */
export function clearPinyinCache(): void {
  cache.clear();
}
