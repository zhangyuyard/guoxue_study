/**
 * 各 store restoreFromBackup 单测（P2-15）：
 *   - useRecitationStore：整体替换、id 重新推导、非法条目跳过、非数组报错
 *   - useBookmarkStore / useNoteStore：同上
 *   - useSettingsStore：白名单逐字段恢复、未提供字段保持现值、越界值 clamp
 * IO 经 jestSetupFile 的 quick-sqlite 内存 mock（写入恒成功，不真跑 SQLite）。
 */
import { useRecitationStore } from '@/store/useRecitationStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAchievementStore } from '@/store/useAchievementStore';
import type { RecitationProgress, Bookmark, Note } from '@/types';

function makeProgress(overrides: Partial<RecitationProgress> = {}): RecitationProgress {
  return {
    id: 'book1:ch1:fillBlank',
    bookId: 'book1',
    chapterId: 'ch1',
    mode: 'fillBlank',
    status: 'mastered',
    progress: 100,
    ...overrides,
  };
}

beforeEach(() => {
  useRecitationStore.setState({ list: [], loading: false, error: undefined });
  useBookmarkStore.setState({ bookmarks: [], loading: false, error: undefined });
  useNoteStore.setState({ notes: [], loading: false, error: undefined });
  useAchievementStore.setState({ unlockedAt: {} });
});

describe('useRecitationStore.restoreFromBackup', () => {
  test('整体替换列表，id 由 bookId:chapterId:mode 重新推导', () => {
    useRecitationStore.setState({ list: [makeProgress({ id: 'old:old:fillBlank', bookId: 'old' })] });
    useRecitationStore.getState().restoreFromBackup([
      { bookId: 'b2', chapterId: 'c2', mode: 'coverHint', status: 'inProgress', progress: 40 },
      { bookId: 'b3', chapterId: 'c3', mode: 'fillBlank', status: 'mastered', progress: 100, completedAt: '2026-03-14T00:00:00.000Z', reviewLevel: 2, nextDueAt: '2026-03-18T00:00:00.000Z' },
    ]);
    const list = useRecitationStore.getState().list;
    expect(list).toHaveLength(2);
    const ids = list.map((r) => r.id).sort();
    expect(ids).toEqual(['b2:c2:coverHint', 'b3:c3:fillBlank']);
    const restored = list.find((r) => r.id === 'b3:c3:fillBlank');
    expect(restored?.completedAt).toBe('2026-03-14T00:00:00.000Z');
    expect(restored?.reviewLevel).toBe(2);
    // 旧数据被整体替换，不再保留
    expect(list.find((r) => r.bookId === 'old')).toBeUndefined();
  });

  test('非法条目（缺 bookId/chapterId/mode、非对象）静默跳过', () => {
    useRecitationStore.getState().restoreFromBackup([
      null,
      'junk',
      { chapterId: 'c', mode: 'fillBlank' }, // 缺 bookId
      { bookId: 'b', chapterId: 'c', mode: 'fillBlank', status: 'inProgress', progress: 10 },
    ]);
    const list = useRecitationStore.getState().list;
    expect(list).toHaveLength(1);
    expect(list[0].bookId).toBe('b');
  });

  test('同键重复记录按后到者覆盖（与 upsert 语义一致）', () => {
    useRecitationStore.getState().restoreFromBackup([
      { bookId: 'b', chapterId: 'c', mode: 'fillBlank', status: 'inProgress', progress: 10 },
      { bookId: 'b', chapterId: 'c', mode: 'fillBlank', status: 'mastered', progress: 100 },
    ]);
    const list = useRecitationStore.getState().list;
    expect(list).toHaveLength(1);
    expect(list[0].progress).toBe(100);
  });

  test('非法入参 progress 容错为 0，status 缺省 notStarted', () => {
    useRecitationStore.getState().restoreFromBackup([
      { bookId: 'b', chapterId: 'c', mode: 'fillBlank', progress: 'oops' },
    ]);
    const row = useRecitationStore.getState().list[0];
    expect(row.status).toBe('notStarted');
    expect(row.progress).toBe(0);
  });

  test('非数组入参 → 设置 error，不改列表', () => {
    const before = useRecitationStore.getState().list;
    useRecitationStore.getState().restoreFromBackup('nope');
    expect(useRecitationStore.getState().error).toContain('格式不正确');
    expect(useRecitationStore.getState().list).toBe(before);
  });
});

describe('useBookmarkStore.restoreFromBackup', () => {
  test('整体替换，tags 缺省空数组，createdAt 缺省当前时间', () => {
    useBookmarkStore.setState({
      bookmarks: [
        {
          id: 'bm-old',
          type: 'paragraph',
          tags: [],
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    useBookmarkStore.getState().restoreFromBackup([
      { id: 'bm-1', type: 'article', bookId: 'b1', text: '学而时习之', tags: ['论语'] },
      { id: 'bm-2', type: 'paragraph' },
    ]);
    const bookmarks = useBookmarkStore.getState().bookmarks;
    expect(bookmarks).toHaveLength(2);
    const bm1 = bookmarks.find((b) => b.id === 'bm-1');
    expect(bm1?.tags).toEqual(['论语']);
    const bm2 = bookmarks.find((b) => b.id === 'bm-2');
    expect(bm2?.tags).toEqual([]);
    expect(new Date(bm2?.createdAt ?? '').getTime()).not.toBeNaN();
  });

  test('非法条目（缺 id / type 不合法）跳过；非数组入参 → error', () => {
    useBookmarkStore.getState().restoreFromBackup([
      { type: 'paragraph' }, // 缺 id
      { id: 'bm-x', type: 'weird' }, // type 非法
      { id: 'bm-ok', type: 'paragraph' },
    ]);
    expect(useBookmarkStore.getState().bookmarks.map((b) => b.id)).toEqual(['bm-ok']);

    const before = useBookmarkStore.getState().bookmarks;
    useBookmarkStore.getState().restoreFromBackup(42);
    expect(useBookmarkStore.getState().error).toContain('格式不正确');
    expect(useBookmarkStore.getState().bookmarks).toBe(before);
  });
});

describe('useNoteStore.restoreFromBackup', () => {
  const makeNote = (overrides: Partial<Note> = {}): Note => ({
    id: 'note-1',
    bookId: 'b',
    chapterId: 'c',
    segmentId: 's',
    startOffset: 0,
    endOffset: 3,
    content: '温故知新',
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    ...overrides,
  });

  test('整体替换，updatedAt 缺省回退 createdAt', () => {
    useNoteStore.setState({ notes: [makeNote({ id: 'note-old' })] });
    useNoteStore.getState().restoreFromBackup([
      { id: 'note-1', bookId: 'b', chapterId: 'c', segmentId: 's', content: '新笔记', createdAt: '2026-03-16T00:00:00.000Z' },
    ]);
    const notes = useNoteStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('新笔记');
    expect(notes[0].updatedAt).toBe('2026-03-16T00:00:00.000Z');
    // startOffset/endOffset 缺省 0
    expect(notes[0].startOffset).toBe(0);
    expect(notes[0].endOffset).toBe(0);
  });

  test('非法条目（缺 content/定位字段）跳过；非数组入参 → error', () => {
    useNoteStore.getState().restoreFromBackup([
      { id: 'n1', bookId: 'b', chapterId: 'c', segmentId: 's', content: 'ok' },
      { id: 'n2', bookId: 'b', chapterId: 'c', segmentId: 's' }, // 缺 content
      { id: 'n3', content: 'x' }, // 缺定位字段
    ]);
    expect(useNoteStore.getState().notes.map((n) => n.id)).toEqual(['n1']);

    useNoteStore.getState().restoreFromBackup(undefined);
    expect(useNoteStore.getState().error).toContain('格式不正确');
  });
});

describe('useSettingsStore.restoreFromBackup', () => {
  test('逐字段恢复：提供的字段覆盖，未提供的保持现值', () => {
    const s = useSettingsStore.getState();
    // 基线：默认 fontSize=18 / lineHeight=1.6 / theme=light
    useSettingsStore.getState().restoreFromBackup({
      fontSize: 22,
      theme: 'dark',
    });
    const after = useSettingsStore.getState();
    expect(after.fontSize).toBe(22);
    expect(after.theme).toBe('dark');
    // 未提供字段保持现值
    expect(after.lineHeight).toBe(s.lineHeight);
    expect(after.pinyinMode).toBe(s.pinyinMode);
    expect(after.dailyGoalEnabled).toBe(s.dailyGoalEnabled);
  });

  test('非法值跳过（类型不符不改），枚举值校验', () => {
    const before = useSettingsStore.getState();
    useSettingsStore.getState().restoreFromBackup({
      fontSize: 'big', // 类型不符 → 跳过
      theme: 'sepia', // theme 仅 light/dark → 跳过
      paper: 'green', // 合法枚举 → 恢复
      pinyinMode: 'rare',
      conversionMode: 'traditional',
    });
    const after = useSettingsStore.getState();
    expect(after.fontSize).toBe(before.fontSize);
    expect(after.theme).toBe(before.theme);
    expect(after.paper).toBe('green');
    expect(after.pinyinMode).toBe('rare');
    expect(after.conversionMode).toBe('traditional');
  });

  test('越界数值 clamp：提醒时刻 0-23/0-59、目标量 1-99、语速 0.5-2.0', () => {
    useSettingsStore.getState().restoreFromBackup({
      reminderHour: 30,
      reminderMinute: -5,
      dailyGoalCount: 5000,
      speechRate: 9.9,
    });
    const after = useSettingsStore.getState();
    expect(after.reminderHour).toBe(23);
    expect(after.reminderMinute).toBe(0);
    expect(after.dailyGoalCount).toBe(99);
    expect(after.speechRate).toBe(2.0);
  });

  test('translation 嵌套对象与现值合并，缺失键保持现值', () => {
    useSettingsStore.getState().restoreFromBackup({
      translation: { provider: 'google', googleApiKey: 'g-key' },
    });
    const t = useSettingsStore.getState().translation;
    expect(t.provider).toBe('google');
    expect(t.googleApiKey).toBe('g-key');
  });

  test('非对象入参静默忽略', () => {
    const snapshot = useSettingsStore.getState();
    useSettingsStore.getState().restoreFromBackup(null);
    useSettingsStore.getState().restoreFromBackup([1, 2]);
    useSettingsStore.getState().restoreFromBackup('x');
    const after = useSettingsStore.getState();
    expect(after.fontSize).toBe(snapshot.fontSize);
    expect(after.theme).toBe(snapshot.theme);
  });
});
