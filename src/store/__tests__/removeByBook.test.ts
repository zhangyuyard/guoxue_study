/**
 * 删书级联清理 Store 方法单测（BugFix 孤儿数据）：
 *   - useBookmarkStore.removeByBook：删除指定书收藏、保留他书、空 bookId 安全、
 *     SQLite 删除失败 → error 且列表不变
 *   - useNoteStore.removeByBook：同上
 *   - useReaderStore.clearLastReadForBook：指向该书的 lastRead 置 null、
 *     他书/无位置不受影响
 * IO 经 jestSetupFile 的 quick-sqlite 内存 mock（写入恒成功），
 * StorageService 以 spy 记录/接管调用。
 */
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useReaderStore } from '@/store/useReaderStore';
import { StorageService } from '@/services/StorageService';
import type { Bookmark, Note } from '@/types';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'bm-1',
    type: 'paragraph',
    bookId: 'book1',
    chapterId: 'c1',
    segmentId: 's1',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    bookId: 'book1',
    chapterId: 'c1',
    segmentId: 's1',
    startOffset: 0,
    endOffset: 2,
    content: '批注',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let deleteBookmarksByBookSpy: jest.SpyInstance;
let deleteNotesByBookSpy: jest.SpyInstance;

beforeEach(() => {
  useBookmarkStore.setState({ bookmarks: [], loading: false, error: undefined });
  useNoteStore.setState({ notes: [], loading: false, error: undefined });
  useReaderStore.setState({ lastRead: null });
  deleteBookmarksByBookSpy = jest.spyOn(StorageService, 'deleteBookmarksByBook');
  deleteNotesByBookSpy = jest.spyOn(StorageService, 'deleteNotesByBook');
});

afterEach(() => {
  deleteBookmarksByBookSpy.mockRestore();
  deleteNotesByBookSpy.mockRestore();
});

describe('useBookmarkStore.removeByBook（删书级联清理）', () => {
  test('删除指定书的全部收藏，保留他书收藏', () => {
    useBookmarkStore.setState({
      bookmarks: [
        makeBookmark({ id: 'bm-a', bookId: 'gone' }),
        makeBookmark({ id: 'bm-b', bookId: 'kept' }),
        makeBookmark({ id: 'bm-c', bookId: 'gone' }),
        // article 型收藏也可能带 bookId，一并清理
        makeBookmark({ id: 'bm-d', type: 'article', bookId: 'gone' }),
      ],
    });
    useBookmarkStore.getState().removeByBook('gone');
    const ids = useBookmarkStore.getState().bookmarks.map((b) => b.id);
    expect(ids).toEqual(['bm-b']);
    expect(deleteBookmarksByBookSpy).toHaveBeenCalledWith('gone');
  });

  test('空 bookId 直接短路，不触库、列表不变', () => {
    const seeded = [makeBookmark({ id: 'bm-a', bookId: 'b1' })];
    useBookmarkStore.setState({ bookmarks: seeded });
    useBookmarkStore.getState().removeByBook('');
    expect(deleteBookmarksByBookSpy).not.toHaveBeenCalled();
    expect(useBookmarkStore.getState().bookmarks).toEqual(seeded);
    expect(useBookmarkStore.getState().error).toBeUndefined();
  });

  test('SQLite 删除失败 → 设置 error，内存列表不变', () => {
    const seeded = [makeBookmark({ id: 'bm-a', bookId: 'b1' })];
    useBookmarkStore.setState({ bookmarks: seeded });
    deleteBookmarksByBookSpy.mockReturnValue({
      success: false,
      error: 'SQLite 故障',
    });
    useBookmarkStore.getState().removeByBook('b1');
    expect(useBookmarkStore.getState().error).toBe('SQLite 故障');
    expect(useBookmarkStore.getState().bookmarks).toEqual(seeded);
  });
});

describe('useNoteStore.removeByBook（删书级联清理）', () => {
  test('删除指定书的全部笔记，保留他书笔记', () => {
    useNoteStore.setState({
      notes: [
        makeNote({ id: 'note-a', bookId: 'gone' }),
        makeNote({ id: 'note-b', bookId: 'kept' }),
        makeNote({ id: 'note-c', bookId: 'gone' }),
      ],
    });
    useNoteStore.getState().removeByBook('gone');
    const ids = useNoteStore.getState().notes.map((n) => n.id);
    expect(ids).toEqual(['note-b']);
    expect(deleteNotesByBookSpy).toHaveBeenCalledWith('gone');
  });

  test('空 bookId 直接短路，不触库、列表不变', () => {
    const seeded = [makeNote({ id: 'note-a', bookId: 'b1' })];
    useNoteStore.setState({ notes: seeded });
    useNoteStore.getState().removeByBook('');
    expect(deleteNotesByBookSpy).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notes).toEqual(seeded);
    expect(useNoteStore.getState().error).toBeUndefined();
  });

  test('SQLite 删除失败 → 设置 error，内存列表不变', () => {
    const seeded = [makeNote({ id: 'note-a', bookId: 'b1' })];
    useNoteStore.setState({ notes: seeded });
    deleteNotesByBookSpy.mockReturnValue({
      success: false,
      error: 'SQLite 故障',
    });
    useNoteStore.getState().removeByBook('b1');
    expect(useNoteStore.getState().error).toBe('SQLite 故障');
    expect(useNoteStore.getState().notes).toEqual(seeded);
  });
});

describe('useReaderStore.clearLastReadForBook（删书级联清理）', () => {
  test('lastRead 指向该书 → 置 null', () => {
    useReaderStore.setState({
      lastRead: { bookId: 'gone', chapterId: 'c1', segmentId: 's2' },
    });
    useReaderStore.getState().clearLastReadForBook('gone');
    expect(useReaderStore.getState().lastRead).toBeNull();
  });

  test('lastRead 指向他书 → 不受影响', () => {
    const lastRead = { bookId: 'kept', chapterId: 'c1', segmentId: 's1' };
    useReaderStore.setState({ lastRead: { ...lastRead } });
    useReaderStore.getState().clearLastReadForBook('gone');
    expect(useReaderStore.getState().lastRead).toEqual(lastRead);
  });

  test('lastRead 本身为 null → 安全无副作用', () => {
    useReaderStore.setState({ lastRead: null });
    expect(() => useReaderStore.getState().clearLastReadForBook('gone')).not.toThrow();
    expect(useReaderStore.getState().lastRead).toBeNull();
  });
});
