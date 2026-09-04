/**
 * StorageService.restoreHighlights 测试（备份终审：划线纳入备份/恢复）
 * 用可编程的 quick-sqlite mock 验证：
 *   - 合法条目恢复 → INSERT OR REPLACE 写入（列序 / 参数映射断言）
 *   - 同 id 幂等覆盖（重复恢复不产生重复行，内容以备份为准）
 *   - 非法条目静默跳过并计数（与五类 restoreFromBackup 的跳过惯例一致）
 *   - noteId / createdAt 缺省归一化
 *   - 空数组无副作用；非数组入参报错
 *   - getHighlights() 无参全量读取（导出采集复用入口）
 */
jest.mock('react-native-quick-sqlite', () => {
  const mockState = { highlights: [] as Record<string, unknown>[] };
  /** restoreHighlights INSERT 的列序（与 saveHighlight 一致） */
  const mockInsertCols = [
    'id',
    'book_id',
    'chapter_id',
    'segment_id',
    'start_offset',
    'end_offset',
    'color',
    'text',
    'note_id',
    'created_at',
  ];
  return {
    open: () => ({
      execute: (sql: string, params: (string | number | null)[] = []) => {
        if (/INSERT OR REPLACE INTO highlights/.test(sql)) {
          const row: Record<string, unknown> = {};
          mockInsertCols.forEach((col, i) => {
            row[col] = params[i] ?? null;
          });
          const idx = mockState.highlights.findIndex((r) => r.id === row.id);
          if (idx >= 0) {
            mockState.highlights[idx] = row;
          } else {
            mockState.highlights.push(row);
          }
          return { rows: { _array: [], length: 0 } };
        }
        if (/SELECT \* FROM highlights/.test(sql)) {
          return {
            rows: {
              _array: mockState.highlights.map((r) => ({ ...r })),
              length: mockState.highlights.length,
            },
          };
        }
        // CREATE TABLE 等一律放行
        return { rows: { _array: [], length: 0 } };
      },
    }),
    __restoreState: mockState,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __restoreState } = require('react-native-quick-sqlite');
import {
  StorageService,
  getHighlights,
  initDatabase,
  restoreHighlights,
} from '@/services/StorageService';

/** 构造一条最小合法划线（与备份 JSON 中透传的 Highlight 结构同形） */
function makeHighlight(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hl-1',
    bookId: 'lunyu',
    chapterId: 'lunyu-xueer',
    segmentId: 'lunyu-xueer-1',
    startOffset: 0,
    endOffset: 5,
    color: 'yellow',
    text: '学而时习之',
    noteId: 'note-1',
    createdAt: '2026-03-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('StorageService.restoreHighlights（划线备份恢复）', () => {
  beforeEach(() => {
    __restoreState.highlights = [];
    initDatabase();
  });

  test('合法条目恢复：INSERT OR REPLACE 写入 + 列映射正确 + 计数', () => {
    const res = restoreHighlights([makeHighlight()]);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ restored: 1, skipped: 0 });

    const row = __restoreState.highlights[0];
    expect(row).toEqual({
      id: 'hl-1',
      book_id: 'lunyu',
      chapter_id: 'lunyu-xueer',
      segment_id: 'lunyu-xueer-1',
      start_offset: 0,
      end_offset: 5,
      color: 'yellow',
      text: '学而时习之',
      note_id: 'note-1',
      created_at: '2026-03-15T00:00:00.000Z',
    });
  });

  test('同 id 幂等覆盖：重复恢复不产生重复行，内容以备份为准', () => {
    expect(restoreHighlights([makeHighlight({ text: '旧文本' })]).success).toBe(true);
    expect(restoreHighlights([makeHighlight({ text: '新文本' })]).success).toBe(true);

    expect(__restoreState.highlights).toHaveLength(1);
    expect(__restoreState.highlights[0].text).toBe('新文本');
  });

  test('非法条目静默跳过并计数：null / 非对象 / 缺字段 / 偏移非法 / 颜色非法', () => {
    const res = restoreHighlights([
      null,
      'junk',
      42,
      { id: 'hl-2', bookId: 'lunyu', chapterId: 'ch1' }, // 缺 segmentId
      makeHighlight({ id: 'hl-3', segmentId: '' }), // 空 segmentId
      makeHighlight({ id: 'hl-4', startOffset: 5, endOffset: 2 }), // start > end
      makeHighlight({ id: 'hl-5', startOffset: -1 }), // 负偏移
      makeHighlight({ id: 'hl-6', color: 'purple' }), // 非法颜色
      makeHighlight({ id: 'hl-7', text: 123 }), // text 非字符串
      makeHighlight({ id: 'hl-8' }), // 合法
    ]);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ restored: 1, skipped: 9 });
    expect(__restoreState.highlights.map((r: Record<string, unknown>) => r.id)).toEqual(['hl-8']);
  });

  test('缺省归一化：noteId 缺省为 null，createdAt 缺省补当前 ISO 时间', () => {
    const res = restoreHighlights([
      makeHighlight({ id: 'hl-no-meta', noteId: undefined, createdAt: undefined }),
    ]);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ restored: 1, skipped: 0 });

    const row = __restoreState.highlights[0];
    expect(row.note_id).toBeNull();
    expect(typeof row.created_at).toBe('string');
    expect(String(row.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('空数组无副作用', () => {
    const res = restoreHighlights([]);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ restored: 0, skipped: 0 });
    expect(__restoreState.highlights).toHaveLength(0);
  });

  test('非数组入参 → 报错且不改任何状态', () => {
    const res = restoreHighlights(undefined as unknown as unknown[]);
    expect(res.success).toBe(false);
    expect(res.error).toContain('highlights 应为数组');
    expect(__restoreState.highlights).toHaveLength(0);
  });

  test('getHighlights() 无参全量读取（导出采集复用入口）', () => {
    restoreHighlights([
      makeHighlight({ id: 'hl-a', createdAt: '2026-03-15T00:00:00.000Z' }),
      makeHighlight({ id: 'hl-b', createdAt: '2026-03-16T00:00:00.000Z' }),
    ]);
    const res = getHighlights();
    expect(res.success).toBe(true);
    expect((res.data ?? []).map((h) => h.id).sort()).toEqual(['hl-a', 'hl-b']);
  });

  test('StorageService 聚合导出包含 restoreHighlights', () => {
    expect(typeof StorageService.restoreHighlights).toBe('function');
  });
});
