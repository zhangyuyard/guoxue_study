/**
 * 导出内容生成纯函数测试（P1-11）
 * 锁定笔记 / 收藏导出的 Markdown 与纯文本格式、分组规则、时间格式化与分享截断。
 */
import {
  buildBookmarksMarkdown,
  buildBookmarksPlainText,
  buildNotesMarkdown,
  buildNotesPlainText,
  EXPORT_SHARE_MAX_LENGTH,
  formatExportStamp,
  formatExportTime,
  truncateForShare,
  type BookmarkExportEntry,
  type NoteExportEntry,
} from '@/utils/exporters';

/** 固定导出时刻（仅用于文件名时间戳断言，与时区无关） */
const FIXED_AT = new Date(2026, 7, 26, 9, 5); // 2026-08-26 09:05 本地时区

const NOTE_ENTRIES: NoteExportEntry[] = [
  {
    bookTitle: '论语',
    chapterTitle: '学而第一',
    quote: '学而时习之',
    content: '心得一：开篇即言学与习',
    time: '2026-08-26T02:00:00.000Z',
  },
  {
    bookTitle: '论语',
    content: '心得二',
    time: '2026-08-25T02:00:00.000Z',
  },
  {
    bookTitle: '道德经',
    content: '心得三',
    time: '2026-08-24T02:00:00.000Z',
  },
];

const BOOKMARK_ENTRIES: BookmarkExportEntry[] = [
  {
    bookTitle: '论语',
    type: 'paragraph',
    text: '学而时习之，不亦说乎',
    tags: ['重点', '学习'],
    note: '常考句',
    time: '2026-08-26T02:00:00.000Z',
  },
  {
    bookTitle: '论语',
    type: 'article',
    tags: [],
    time: '2026-08-25T02:00:00.000Z',
  },
];

describe('笔记导出格式', () => {
  test('Markdown：文件标题 + 按书分组 + 每条列表项（摘录为子项）', () => {
    const md = buildNotesMarkdown(NOTE_ENTRIES, FIXED_AT);
    const lines = md.split('\n');

    expect(lines[0]).toBe(`# 笔记导出（${formatExportStamp(FIXED_AT)}）`);
    // 按书分组：《论语》一组含两条，《道德经》一组一条，组标题唯一
    expect(lines.filter((l) => l === '## 《论语》')).toHaveLength(1);
    expect(lines.filter((l) => l === '## 《道德经》')).toHaveLength(1);
    // 条目行：内容 + 章节名 + 时间；摘录为缩进子项
    const entryLine = lines.find((l) => l.includes('心得一'));
    expect(entryLine).toMatch(/^- 【笔记】心得一：开篇即言学与习（学而第一）（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/);
    expect(lines).toContain('  - 摘录：学而时习之');
    // 无章节/无摘录的条目不产出空括号与空摘录行
    expect(lines.find((l) => l.includes('心得二'))).toMatch(/^- 【笔记】心得二（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/);
    expect(lines.filter((l) => l.startsWith('  - 摘录'))).toHaveLength(1);
  });

  test('纯文本：平铺不分组，保留时间、来源与摘录', () => {
    const txt = buildNotesPlainText(NOTE_ENTRIES);

    expect(txt).not.toContain('##');
    expect(txt).not.toContain('【笔记】');
    // 平铺顺序保持传入顺序
    const idx1 = txt.indexOf('心得一');
    const idx2 = txt.indexOf('心得二');
    const idx3 = txt.indexOf('心得三');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    // 有章节时来源含书名·章节
    expect(txt).toMatch(/《论语·学而第一》/);
    expect(txt).toContain('摘录：学而时习之');
  });
});

describe('收藏导出格式', () => {
  test('Markdown：类型标签 + 标签后缀 + 备注子项；文章无文本回退书名', () => {
    const md = buildBookmarksMarkdown(BOOKMARK_ENTRIES, FIXED_AT);
    const lines = md.split('\n');

    expect(lines[0]).toBe(`# 收藏导出（${formatExportStamp(FIXED_AT)}）`);
    // 段落条目：类型 + 文本 + 标签 + 时间，备注为子项
    const paraLine = lines.find((l) => l.includes('学而时习之'));
    expect(paraLine).toMatch(/^- 【段落】学而时习之，不亦说乎［重点、学习］（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/);
    expect(lines).toContain('  - 备注：常考句');
    // 文章收藏无文本：回退书名，无标签后缀
    const articleLine = lines.find((l) => l.includes('【文章】'));
    expect(articleLine).toMatch(/^- 【文章】论语（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/);
  });

  test('纯文本：平铺一行一条，备注独立行', () => {
    const txt = buildBookmarksPlainText(BOOKMARK_ENTRIES);
    const lines = txt.split('\n');

    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 《论语》【段落】学而时习之，不亦说乎［重点、学习］$/);
    expect(lines[1]).toBe('备注：常考句');
    expect(lines[2]).toMatch(/《论语》【文章】论语$/);
  });
});

describe('时间与分享工具', () => {
  test('formatExportStamp：YYYYMMDD-HHmm（本地时区）', () => {
    expect(formatExportStamp(FIXED_AT)).toBe('20260826-0905');
  });

  test('formatExportTime：无效时间返回空串', () => {
    expect(formatExportTime('not-a-date')).toBe('');
    expect(formatExportTime('')).toBe('');
  });

  test('truncateForShare：未超长原样返回', () => {
    const text = '短内容';
    expect(truncateForShare(text)).toBe(text);
  });

  test('truncateForShare：超长截断至上限并注明', () => {
    const text = '字'.repeat(EXPORT_SHARE_MAX_LENGTH + 100);
    const out = truncateForShare(text);
    expect(out.startsWith('字'.repeat(EXPORT_SHARE_MAX_LENGTH))).toBe(true);
    expect(out).toContain('已截断');
    expect(out.length).toBeLessThan(text.length + 50);
  });
});
