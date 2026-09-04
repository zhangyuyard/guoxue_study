/**
 * 全文搜索服务（SearchService）
 * 搜索路径：SQLite segments_fts（FTS5 表）instr 子串匹配（规避中文分词问题）→
 * 异常/无库时回退内存遍历搜索。搜索历史存 MMKV（最多 20 条，去重，最新在前）。
 */
import { MMKV } from 'react-native-mmkv';
import { open } from 'react-native-quick-sqlite';
import type { SearchResult, ServiceResult } from '@/types';

import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';

const HISTORY_KEY = 'search_history';
const HISTORY_LIMIT = 20;

/** MMKV 实例（惰性，原生不可用时回退内存；undefined=未初始化，null=已初始化但失败降级） */
let mmkv: InstanceType<typeof MMKV> | null | undefined;
function getStorage(): InstanceType<typeof MMKV> | null {
  if (mmkv !== undefined) {
    return mmkv;
  }
  try {
    mmkv = new MMKV();
  } catch {
    mmkv = null;
  }
  return mmkv;
}

/** 内存态搜索历史（MMKV 不可用时兜底） */
let memHistory: string[] | null = null;

/** FTS 索引是否已构建（模块级标志，避免重复构建） */
let ftsIndexBuilt = false;

/** 确保 FTS 索引可用（幂等） */
function ensureIndex(): void {
  if (ftsIndexBuilt) {
    return;
  }
  const res = StorageService.ensureFtsIndex();
  if (res.success) {
    ftsIndexBuilt = true;
  }
}

/** SQLite 子串搜索（instr 精确子串，无通配符问题） */
function searchInSqlite(kw: string): SearchResult[] | null {
  try {
    ensureIndex();
    const db = open({ name: 'guoxue.db' });
    // quick-sqlite 8.x 无 select 方法，经 execute 取 rows._array
    const res = db.execute(
      `SELECT segment_id, book_id, chapter_id, book_title, chapter_title, text
       FROM segments_fts
       WHERE instr(text, ?) > 0
       ORDER BY rowid ASC`,
      [kw],
    );
    const rawRows = (res.rows?._array ?? []) as Record<string, unknown>[];
    return rawRows.map((row) => {
      const text = String(row.text);
      const count = text.split(kw).length - 1;
      return {
        bookId: String(row.book_id),
        bookTitle: String(row.book_title),
        chapterId: String(row.chapter_id),
        chapterTitle: String(row.chapter_title),
        segmentId: String(row.segment_id),
        text,
        matchCount: count > 0 ? count : 1,
      };
    });
  } catch {
    return null;
  }
}

/** 内存遍历搜索（SQLite 不可用时回退） */
function searchInMemory(kw: string): SearchResult[] {
  const results: SearchResult[] = [];
  const booksRes = TextLibraryService.getBooks();
  if (!booksRes.success || !booksRes.data) {
    return results;
  }
  for (const book of booksRes.data) {
    for (const chapter of book.chapters) {
      for (const seg of chapter.segments) {
        const count = seg.text.split(kw).length - 1;
        if (count > 0) {
          results.push({
            bookId: book.id,
            bookTitle: book.title,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            segmentId: seg.id,
            text: seg.text,
            matchCount: count,
          });
        }
      }
    }
  }
  return results;
}

export const SearchService = {
  /** 全文搜索（按来源书序返回平铺结果，含命中次数） */
  search(keyword: string): ServiceResult<SearchResult[]> {
    const kw = (keyword ?? '').trim();
    if (!kw) {
      return { success: true, data: [] };
    }
    try {
      const sqliteResults = searchInSqlite(kw);
      const results =
        sqliteResults && sqliteResults.length > 0
          ? sqliteResults
          : searchInMemory(kw);

      // 记录搜索历史（去重，最新在前，最多 20 条）
      this.pushHistory(kw);

      return { success: true, data: results };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  /** 获取搜索历史（最近 20 条） */
  getHistory(): ServiceResult<string[]> {
    const s = getStorage();
    if (s) {
      try {
        const raw = s.getString(HISTORY_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        memHistory = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        // 解析失败时使用内存态
      }
    }
    return { success: true, data: memHistory ?? [] };
  },

  /** 写入一条搜索历史 */
  pushHistory(keyword: string): void {
    const kw = (keyword ?? '').trim();
    if (!kw) {
      return;
    }
    const current = this.getHistory().data ?? [];
    const next = [kw, ...current.filter((x) => x !== kw)].slice(0, HISTORY_LIMIT);
    memHistory = next;
    const s = getStorage();
    if (s) {
      try {
        s.set(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // 忽略写入失败
      }
    }
  },

  /** 清空搜索历史 */
  clearHistory(): ServiceResult<boolean> {
    memHistory = [];
    const s = getStorage();
    if (s) {
      try {
        s.delete(HISTORY_KEY);
      } catch {
        // 忽略
      }
    }
    return { success: true, data: true };
  },

  /** 删除单条历史 */
  removeHistoryItem(keyword: string): ServiceResult<boolean> {
    const current = this.getHistory().data ?? [];
    const next = current.filter((x) => x !== keyword);
    memHistory = next;
    const s = getStorage();
    if (s) {
      try {
        s.set(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // 忽略
      }
    }
    return { success: true, data: true };
  },
};

export default SearchService;
