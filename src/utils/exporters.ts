/**
 * 导出内容生成（P1-11，纯函数）
 * 笔记 / 收藏导出的 Markdown 与纯文本格式化，独立于 RNFS / Share 实现，
 * 便于单元测试锁定格式。时间格式化统一为本地时区「YYYY-MM-DD HH:mm」。
 */

/** pad2 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO 时间 → 「YYYY-MM-DD HH:mm」（本地时区）；无效时间返回空串 */
export function formatExportTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** 导出文件名时间戳：YYYYMMDD-HHmm（本地时区） */
export function formatExportStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
    now.getHours(),
  )}${pad2(now.getMinutes())}`;
}

/** 笔记导出条目 */
export interface NoteExportEntry {
  /** 书名（分组标题） */
  bookTitle: string;
  /** 章节名（可选，随条目展示） */
  chapterTitle?: string;
  /** 关联原文摘录（可选） */
  quote?: string;
  /** 笔记内容 */
  content: string;
  /** 笔记时间（ISO 字符串） */
  time: string;
}

/** 收藏导出条目 */
export interface BookmarkExportEntry {
  /** 书名（分组标题） */
  bookTitle: string;
  type: 'article' | 'paragraph';
  /** 收藏文本（文章收藏可能为空，回退为书名） */
  text?: string;
  /** 标签列表 */
  tags: string[];
  /** 备注（可选） */
  note?: string;
  /** 收藏时间（ISO 字符串） */
  time: string;
}

/** 按书名分组（保持首次出现顺序） */
function groupByBook<T extends { bookTitle: string }>(): {
  groups: { bookTitle: string; items: T[] }[];
  push: (entry: T) => void;
} {
  const groups: { bookTitle: string; items: T[] }[] = [];
  const index = new Map<string, number>();
  return {
    groups,
    push: (entry: T) => {
      const key = entry.bookTitle || '未知书籍';
      const i = index.get(key);
      if (i === undefined) {
        index.set(key, groups.length);
        groups.push({ bookTitle: key, items: [entry] });
      } else {
        groups[i].items.push(entry);
      }
    },
  };
}

/**
 * 笔记 Markdown：文件标题（含导出时间）+ 按书分组的一级小节 + 每条列表项
 * 「- 【笔记】内容（章节名）（时间）」，摘录作为子列表项。
 */
export function buildNotesMarkdown(
  entries: NoteExportEntry[],
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [`# 笔记导出（${formatExportStamp(exportedAt)}）`, ''];
  const grouped = groupByBook<NoteExportEntry>();
  for (const e of entries) {
    grouped.push(e);
  }
  for (const group of grouped.groups) {
    lines.push(`## 《${group.bookTitle}》`, '');
    for (const e of group.items) {
      const chapter = e.chapterTitle ? `（${e.chapterTitle}）` : '';
      lines.push(`- 【笔记】${e.content}${chapter}（${formatExportTime(e.time)}）`);
      if (e.quote) {
        lines.push(`  - 摘录：${e.quote}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 笔记纯文本：平铺（不分组），每条 = 时间行 + 来源行 + 摘录行 + 内容 */
export function buildNotesPlainText(entries: NoteExportEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const src = e.chapterTitle
      ? `《${e.bookTitle}·${e.chapterTitle}》`
      : `《${e.bookTitle}》`;
    lines.push(`[${formatExportTime(e.time)}] ${src}`);
    if (e.quote) {
      lines.push(`摘录：${e.quote}`);
    }
    lines.push(e.content);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 收藏 Markdown：文件标题（含导出时间）+ 按书分组的一级小节 + 每条列表项
 * 「- 【文章/段落】内容［标签］（时间）」，备注作为子列表项。
 */
export function buildBookmarksMarkdown(
  entries: BookmarkExportEntry[],
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [`# 收藏导出（${formatExportStamp(exportedAt)}）`, ''];
  const grouped = groupByBook<BookmarkExportEntry>();
  for (const e of entries) {
    grouped.push(e);
  }
  for (const group of grouped.groups) {
    lines.push(`## 《${group.bookTitle}》`, '');
    for (const e of group.items) {
      const typeLabel = e.type === 'article' ? '文章' : '段落';
      const body = e.text || group.bookTitle;
      const tagSuffix = e.tags.length > 0 ? `［${e.tags.join('、')}］` : '';
      lines.push(`- 【${typeLabel}】${body}${tagSuffix}（${formatExportTime(e.time)}）`);
      if (e.note) {
        lines.push(`  - 备注：${e.note}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 收藏纯文本：平铺（不分组），每条一行（备注换行缩进） */
export function buildBookmarksPlainText(entries: BookmarkExportEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const typeLabel = e.type === 'article' ? '文章' : '段落';
    const body = e.text || e.bookTitle;
    const tagSuffix = e.tags.length > 0 ? `［${e.tags.join('、')}］` : '';
    lines.push(`[${formatExportTime(e.time)}] 《${e.bookTitle}》【${typeLabel}】${body}${tagSuffix}`);
    if (e.note) {
      lines.push(`备注：${e.note}`);
    }
  }
  return lines.join('\n');
}

/** 系统分享内容长度上限（保守值，超长文本在部分机型分享面板会失败） */
export const EXPORT_SHARE_MAX_LENGTH = 20000;

/** 分享内容截断：超长截断至上限并注明 */
export function truncateForShare(
  text: string,
  maxLength: number = EXPORT_SHARE_MAX_LENGTH,
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n（内容过长，已截断前 ${maxLength} 字；完整内容请使用「导出文件」）`;
}
