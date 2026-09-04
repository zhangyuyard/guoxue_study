/**
 * 全文搜索 Hook（useSearch）
 * 封装搜索输入 → 防抖 300ms → SearchService.search 的完整链路，
 * 并对外暴露搜索结果、按书分组的结构、搜索历史与清空操作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@/types';
import { SearchService } from '@/services/SearchService';
import { debounce, type DebouncedFunction } from '@/utils/debounce';

/** 按书名分组后的搜索结果 */
export interface GroupedSearchResult {
  /** 书籍 ID */
  bookId: string;
  /** 书名 */
  bookTitle: string;
  /** 该书下的全部命中段落 */
  results: SearchResult[];
}

export interface UseSearchReturn {
  /** 当前输入关键词 */
  query: string;
  /** 更新关键词（内部自动防抖触发搜索） */
  setQuery: (keyword: string) => void;
  /** 平铺搜索结果 */
  results: SearchResult[];
  /** 按书名分组的结果 */
  groupedResults: GroupedSearchResult[];
  /** 搜索历史（最近 20 条，最新在前） */
  history: string[];
  /** 清空搜索历史 */
  clearHistory: () => void;
  /** 是否正在搜索 */
  isSearching: boolean;
  /** 立即执行一次搜索（点击历史标签时使用） */
  search: (keyword: string) => void;
}

/** 防抖延迟（毫秒） */
const SEARCH_DELAY = 300;

export function useSearch(): UseSearchReturn {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  /** 刷新搜索历史（从服务读取） */
  const refreshHistory = useCallback(() => {
    const res = SearchService.getHistory();
    setHistory(res.success && res.data ? res.data : []);
  }, []);

  /** 实际执行搜索（同步服务，状态即时更新） */
  const doSearch = useCallback(
    (keyword: string) => {
      const kw = keyword.trim();
      if (!kw) {
        setResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      const res = SearchService.search(kw);
      setResults(res.success && res.data ? res.data : []);
      setIsSearching(false);
      refreshHistory();
    },
    [refreshHistory],
  );

  /** 防抖包装（组件卸载时取消防抖定时器，避免泄漏） */
  const debouncedSearch = useRef<DebouncedFunction<[string]>>(
    debounce((keyword: string) => doSearch(keyword), SEARCH_DELAY),
  );
  useEffect(() => {
    const current = debouncedSearch.current;
    return () => current.cancel();
  }, []);

  /** 更新输入并触发防抖搜索 */
  const setQuery = useCallback((keyword: string) => {
    setQueryState(keyword);
    debouncedSearch.current(keyword);
  }, []);

  const search = useCallback(
    (keyword: string) => {
      setQueryState(keyword);
      doSearch(keyword);
    },
    [doSearch],
  );

  const clearHistory = useCallback(() => {
    SearchService.clearHistory();
    setHistory([]);
  }, []);

  /** 按书名分组（保持书籍出现顺序） */
  const groupedResults = useMemo<GroupedSearchResult[]>(() => {
    const groups = new Map<string, GroupedSearchResult>();
    for (const r of results) {
      let group = groups.get(r.bookId);
      if (!group) {
        group = { bookId: r.bookId, bookTitle: r.bookTitle, results: [] };
        groups.set(r.bookId, group);
      }
      group.results.push(r);
    }
    return Array.from(groups.values());
  }, [results]);

  // 首次挂载时读取历史
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  return {
    query,
    setQuery,
    results,
    groupedResults,
    history,
    clearHistory,
    isSearching,
    search,
  };
}

export default useSearch;
