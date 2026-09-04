/**
 * useAchievementStore 单测（P2-06）：
 *   - recompute：依据数据 store 快照解锁成就，落账解锁时刻
 *   - 幂等：重复 recompute 不覆盖已解锁时间戳；无新解锁不触发持久化写入
 *   - 不可逆：数据被清空后已解锁成就不回退
 *   - restoreFromBackup：整体替换 + 非法条目丢弃
 * StorageService 用可编程 mock（recompute 内部会同步 load 各数据 store）。
 */
import { useAchievementStore } from '@/store/useAchievementStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useRecitationStore } from '@/store/useRecitationStore';

/** 可编程「数据库」状态（mock 工厂引用，命名以 mock 开头规避 jest 提升限制） */
const mockDbState = {
  recitation: [] as Array<Record<string, unknown>>,
  bookmarks: [] as Array<Record<string, unknown>>,
  notes: [] as Array<Record<string, unknown>>,
};

jest.mock('@/services/StorageService', () => ({
  StorageService: {
    getRecitationList: jest.fn(() => ({
      success: true,
      data: mockDbState.recitation,
    })),
    getBookmarks: jest.fn(() => ({ success: true, data: mockDbState.bookmarks })),
    getNotes: jest.fn(() => ({ success: true, data: mockDbState.notes })),
  },
  genId: (prefix: string) => `${prefix}-test`,
  nowISO: () => new Date().toISOString(),
  recitationKey: (bookId: string, chapterId: string, mode: string) =>
    `${bookId}:${chapterId}:${mode}`,
}));

/** 构造一条背诵进度（当天完成） */
function makeProgress(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'book1:ch1:fillBlank',
    bookId: 'book1',
    chapterId: 'ch1',
    mode: 'fillBlank',
    status: 'mastered',
    progress: 100,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 重置全部相关 store 到空基线 */
function resetStores() {
  mockDbState.recitation = [];
  mockDbState.bookmarks = [];
  mockDbState.notes = [];
  useAchievementStore.setState({ unlockedAt: {} });
  useRecitationStore.setState({ list: [], loading: false, error: undefined });
  useBookmarkStore.setState({ bookmarks: [], loading: false, error: undefined });
  useNoteStore.setState({ notes: [], loading: false, error: undefined });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
});

describe('recompute', () => {
  test('累计背诵 10 段（同一天）→ 解锁 recite-10，落账 ISO 时刻；连击不足不解锁', () => {
    mockDbState.recitation = Array.from({ length: 10 }, (_, i) =>
      makeProgress({ id: `b:ch${i}:fillBlank`, chapterId: `ch${i}` }),
    );
    useAchievementStore.getState().recompute();
    const unlockedAt = useAchievementStore.getState().unlockedAt;
    expect(unlockedAt['recite-10']).toBeDefined();
    expect(new Date(unlockedAt['recite-10']).getTime()).not.toBeNaN();
    // 同一天完成 → 连击为 1，不足 streak-3 阈值
    expect(unlockedAt['streak-3']).toBeUndefined();
  });

  test('未达阈值不解锁', () => {
    mockDbState.recitation = [makeProgress()];
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt).toEqual({});
  });

  test('收藏/笔记计数进快照：10 条收藏解锁 bookmark-10', () => {
    mockDbState.bookmarks = Array.from({ length: 10 }, (_, i) => ({
      id: `bm-${i}`,
      type: 'paragraph',
      tags: [],
      createdAt: new Date().toISOString(),
    }));
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt['bookmark-10']).toBeDefined();
  });

  test('覆盖书籍数：去重 bookId（5 本书解锁 coverage-5）', () => {
    mockDbState.recitation = Array.from({ length: 5 }, (_, i) =>
      makeProgress({ id: `book${i}:ch1:fillBlank`, bookId: `book${i}` }),
    );
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt['coverage-5']).toBeDefined();
    expect(useAchievementStore.getState().unlockedAt['coverage-10']).toBeUndefined();
  });

  test('幂等：已解锁项时间戳不被覆盖（预设固定解锁时刻后重算）', () => {
    mockDbState.recitation = Array.from({ length: 10 }, (_, i) =>
      makeProgress({ id: `b:ch${i}:fillBlank`, chapterId: `ch${i}` }),
    );
    useAchievementStore.setState({
      unlockedAt: { 'recite-10': '2020-01-01T00:00:00.000Z' },
    });
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt['recite-10']).toBe(
      '2020-01-01T00:00:00.000Z',
    );
  });

  test('不可逆：解锁后清空背诵数据，成就不回退', () => {
    mockDbState.recitation = Array.from({ length: 10 }, (_, i) =>
      makeProgress({ id: `b:ch${i}:fillBlank`, chapterId: `ch${i}` }),
    );
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt['recite-10']).toBeDefined();
    mockDbState.recitation = [];
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt['recite-10']).toBeDefined();
  });

  test('无新解锁时不改变 state（引用稳定，避免无谓持久化写入）', () => {
    useAchievementStore.getState().recompute();
    const before = useAchievementStore.getState().unlockedAt;
    useAchievementStore.getState().recompute();
    expect(useAchievementStore.getState().unlockedAt).toBe(before);
  });
});

describe('restoreFromBackup', () => {
  test('整体替换解锁记录并持久化结构可用', () => {
    useAchievementStore.setState({
      unlockedAt: { 'recite-10': '2020-01-01T00:00:00.000Z' },
    });
    useAchievementStore.getState().restoreFromBackup({
      'streak-3': '2026-03-01T08:00:00.000Z',
      'bookmark-10': '2026-03-02T08:00:00.000Z',
    });
    expect(useAchievementStore.getState().unlockedAt).toEqual({
      'streak-3': '2026-03-01T08:00:00.000Z',
      'bookmark-10': '2026-03-02T08:00:00.000Z',
    });
  });

  test('非法条目（非字符串值/空 id）丢弃', () => {
    useAchievementStore.getState().restoreFromBackup({
      'recite-10': 123,
      '': '2026-03-01T00:00:00.000Z',
      'streak-3': '2026-03-01T08:00:00.000Z',
    });
    expect(useAchievementStore.getState().unlockedAt).toEqual({
      'streak-3': '2026-03-01T08:00:00.000Z',
    });
  });

  test('非对象入参（null/数组/字符串）静默忽略', () => {
    const before = useAchievementStore.getState().unlockedAt;
    useAchievementStore.getState().restoreFromBackup(null);
    useAchievementStore.getState().restoreFromBackup([['a', 'b']]);
    useAchievementStore.getState().restoreFromBackup('x');
    expect(useAchievementStore.getState().unlockedAt).toBe(before);
  });
});
