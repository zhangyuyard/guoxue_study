/**
 * 高级搜索筛选（searchFilter，P2-10）
 * 纯函数层：对 SearchService 返回的段落结果做「朝代 / 体裁 / 关键词范围」筛选。
 * 筛选与关键词 AND 叠加：各条件同时满足才保留。
 *
 * 关键词范围口径（scope）：
 * - all：不过滤（默认，与现状完全一致，向后兼容）
 * - title：仅保留「书名包含关键词」的结果（对已有结果做后置过滤）
 * - content：仅保留「段落正文包含关键词」的结果（与搜索本身的命中条件一致，
 *   显式选择后语义不变，仅为表达「只要正文命中」的用户意图）
 *
 * 未登记元数据的书籍（如用户上传书 user-*）：在启用朝代/体裁筛选时被排除
 * （无法判定维度），scope 筛选不受影响。
 */
import type { SearchResult } from '@/types';

import { getBookMeta, type BookGenre } from '@/data/bookMeta';

/** 关键词范围：全部 / 仅书名 / 仅正文 */
export type SearchScope = 'all' | 'title' | 'content';

/** 筛选条件（与搜索关键词 AND 叠加） */
export interface SearchFilterOptions {
  /** 选中的朝代列表（空 = 不限） */
  dynasties: string[];
  /** 选中的体裁列表（空 = 不限） */
  genres: BookGenre[];
  /** 关键词范围 */
  scope: SearchScope;
  /** 当前搜索关键词（scope 筛选使用；空关键词时 scope 不过滤） */
  keyword: string;
}

/** 朝代 / 体裁 / 范围任一非默认即视为「筛选生效中」 */
export function anyFilterActive(
  opts: Pick<SearchFilterOptions, 'dynasties' | 'genres' | 'scope'>,
): boolean {
  return opts.dynasties.length > 0 || opts.genres.length > 0 || opts.scope !== 'all';
}

/**
 * 按筛选条件过滤搜索结果（纯函数，不修改入参）。
 * 条件间 AND 叠加：朝代、体裁、范围需同时满足。
 */
export function filterSearchResults(
  results: SearchResult[],
  opts: SearchFilterOptions,
): SearchResult[] {
  const kw = opts.keyword.trim().toLowerCase();
  return results.filter((r) => {
    // ① 朝代 / 体裁筛选（基于 bookMeta 注册表）
    if (opts.dynasties.length > 0 || opts.genres.length > 0) {
      const meta = getBookMeta(r.bookId);
      // 未登记元数据的书（用户上传书等）无法判定维度，启用维度筛选时排除
      if (!meta) {
        return false;
      }
      if (opts.dynasties.length > 0 && !opts.dynasties.includes(meta.dynasty)) {
        return false;
      }
      if (opts.genres.length > 0 && !opts.genres.includes(meta.genre)) {
        return false;
      }
    }
    // ② 关键词范围筛选
    if (kw && opts.scope === 'title') {
      if (!r.bookTitle.toLowerCase().includes(kw)) {
        return false;
      }
    }
    if (kw && opts.scope === 'content') {
      if (!r.text.toLowerCase().includes(kw)) {
        return false;
      }
    }
    return true;
  });
}

export default {
  filterSearchResults,
  anyFilterActive,
};
