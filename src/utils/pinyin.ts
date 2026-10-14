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
    /** 命中的语料例句（canon v3 语境锚定，供浮窗展示） */
    context?: string;
  };
  /** 异体字列表 */
  yiti?: string[];
  /** 语境读音源 */
  readingSources?: string[];
  /** 语境读音是否校验 */
  readingVerified?: boolean;
}

/**
 * 缓存条目上限（超出后淘汰最旧条目，防止长会话内存膨胀）。
 *
 * ★ 2026-10-09 真机实测调整 200 → 2048：本缓存按**整段**正文记条目（一段 = 一个
 *   自然段；实测《资治通鉴》约 155 段/章、~64 字/段），而阅读器同时保有
 *   锚章 + 前后邻章，工作集（≈900~2000 段）**远超 200**。
 *   上限低于工作集时 `prewarmPinyinCache` 会在同一遍预拼中把自己刚写入的条目淘汰
 *   （自我颠簸）⇒ 预热形同虚设，渲染侧 `PinyinText` 与 ReaderScreen 的章级
 *   「统一拼音字号」计算全部退化为全量重算（真机：JS 线程占用 99%、单次无 yield
 *   9.2–38s，表现为换章/开书时正文区长时间空白）。
 *
 * ★★ 2026-10-14 注释勘误，**2026-10-14 晚二次勘误**（三处**过期断言**，勿再照抄）：
 * ① 原文写「滚动提交保留集按 `SCROLL_WINDOW_KEEP_SCREENS`（=6 屏）可达 6~13 章」
 *    —— **实测为假**：该预算 = `6 × lpp`，而长章书单章行数 ≫ 预算
 *    ⇒ `retainIdsByBudget` 的扩张循环**一次都不执行** ⇒ 预算集只剩离散三章，
 *    **不是** 6~13 章。**注意：「单章行数中位 133」这个数字来自那本已删除的 epub
 *    载体，不是本仓量级常数**；当前 77 本内置书实测（cpl ∈ [10,20]）跨书中位
 *    52–96，且呈**双峰**（`tongjian` p50 723–1134 vs `songci` p50=10），
 *    量级表见 `ReaderScreen.retainForScrollCommit` 注释。
 * ② 原文引用的 `CHAPTER_MAX_PINYIN_LEN_CACHE` **常量已不存在**（全仓仅此注释自引用）。
 * ③ ⚠⚠ 原文写「已由 `retainIdsForViewport`（预算 ∪ 覆盖区间）修正」——
 *    **该修正已被真机 A6 / B2 两轮判决为无效**（同起点对照两臂都出 prepend）。
 *    ⇒ 「保留集章数」这个问题**至今没有有效修法**；`retainIdsForViewport` 代码暂留，
 *    但它不是答案。原文本段所在的问题（缓存上限依据）不受影响，见下。
 *
 * ⇒ 本上限的正确依据是「阅读器工作集（锚章 + 邻域，约 900~2000 段）」，
 *   **不再依赖某个具体的保留集章数**。2048 段覆盖该工作集；
 *   单条目为一个自然段的注解数组 ⇒ 量级约 2048 × 64 × ~60B ≈ 7 MB，可接受。
 */
const CACHE_LIMIT = 2048;

/** 注音结果缓存：key = `${mode}::${cacheSalt}::${workId}|${bookId}::${text}`（见 `cacheKey`） */
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
          context: a.tongjia.context,
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

/** 当前缓存条目数（测试/诊断用） */
export function pinyinCacheSize(): number {
  return cache.size;
}

/** 预拼分批大小：每批段数（批间让出 JS 线程，避免预拼阻塞渲染） */
const PREWARM_BATCH = 20;

/**
 * 预热注音缓存（R2b3 预拼）：对预取章的各段按「与渲染侧完全同参」跑一次
 * annotateText 填 LRU，用户切到该章时 PinyinText 首渲染即命中缓存。
 * 分批 + 批间 setTimeout 让出 JS 线程，避免长章预拼阻塞渲染。
 * @returns 实际计算（未命中缓存）的段数
 */
export async function prewarmPinyinCache(
  texts: readonly string[],
  mode: PinyinMode,
  cacheSalt: string,
  opts?: AnnotateTextOptions,
): Promise<number> {
  let computed = 0;
  for (let i = 0; i < texts.length; i += PREWARM_BATCH) {
    for (const text of texts.slice(i, i + PREWARM_BATCH)) {
      if (!text) {
        continue;
      }
      const sizeBefore = cache.size;
      const res = annotateText(text, mode, undefined, cacheSalt, opts);
      if (res.success && cache.size > sizeBefore) {
        computed += 1;
      }
    }
    if (i + PREWARM_BATCH < texts.length) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return computed;
}
