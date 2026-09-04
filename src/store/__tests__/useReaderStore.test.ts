/**
 * useReaderStore 单元测试
 * 重点验证本次 Bug 修复的第 3 点：openChapter 幂等守卫。
 * 背景：ContinueReadingScreen 订阅 lastRead，若 openChapter 每次都写入新引用的
 * lastRead，会造成「订阅更新 → 重渲染 → openChapter 再写入」的级联循环。
 */
import { useReaderStore } from '@/store/useReaderStore';

/** 恢复 store 初始状态，保证用例相互独立 */
function resetStore(): void {
  useReaderStore.setState({
    bookId: null,
    chapterId: null,
    segmentId: null,
    lastRead: null,
  });
}

describe('useReaderStore.openChapter 幂等守卫', () => {
  beforeEach(() => {
    resetStore();
  });

  test('首次调用：写入 bookId/chapterId/segmentId 与 lastRead', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');

    const state = useReaderStore.getState();
    expect(state.bookId).toBe('book-1');
    expect(state.chapterId).toBe('chap-1');
    expect(state.segmentId).toBe('seg-1');
    // P1-17：携带 segmentId 打开时，lastRead 一并持久化段落
    expect(state.lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
    });
  });

  test('重复调用相同位置：lastRead 引用保持稳定（不产生新对象）', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    const first = useReaderStore.getState().lastRead;

    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    const second = useReaderStore.getState().lastRead;

    // 幂等守卫核心断言：同位置重复打开不得替换 lastRead 引用
    expect(second).toBe(first);
  });

  test('幂等调用不触发订阅回调（避免 ContinueReading 级联重渲染）', () => {
    const listener = jest.fn();
    const unsubscribe = useReaderStore.subscribe(listener);

    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    expect(listener).toHaveBeenCalledTimes(1);

    // 同位置重复调用：不应产生任何 set，即不应再次通知订阅者
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  test('segmentId 未传（undefined）按 null 处理，且重复调用仍幂等', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    expect(useReaderStore.getState().segmentId).toBeNull();

    const first = useReaderStore.getState().lastRead;
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    expect(useReaderStore.getState().lastRead).toBe(first);
    expect(useReaderStore.getState().segmentId).toBeNull();
  });

  test('segmentId 变化时不视为幂等，应更新状态', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-2');

    const state = useReaderStore.getState();
    expect(state.segmentId).toBe('seg-2');
    expect(state.lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-2',
    });
  });

  test('setSegment 滚动更新段落位置后，openChapter 同书同章仍会刷新 lastRead 引用', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    useReaderStore.getState().setSegment('seg-9');

    const first = useReaderStore.getState().lastRead;
    // 当前 segmentId 为 'seg-9'，与新调用（归一化为 null）不同 → 应执行写入
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    const second = useReaderStore.getState().lastRead;

    expect(second).not.toBe(first);
    expect(second).toEqual({ bookId: 'book-1', chapterId: 'chap-1' });
  });

  test('lastRead 为 null 时即使其余字段相同也必须写入（重启后恢复场景）', () => {
    // 模拟：运行态残留 bookId/chapterId/segmentId，但持久化的 lastRead 丢失
    useReaderStore.setState({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
      lastRead: null,
    });

    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    expect(useReaderStore.getState().lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
    });
  });

  test('lastRead 与当前 bookId/chapterId 不一致时必须写入（跨书切换场景）', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    useReaderStore.getState().openChapter('book-2', 'chap-2');

    const state = useReaderStore.getState();
    expect(state.bookId).toBe('book-2');
    expect(state.chapterId).toBe('chap-2');
    expect(state.lastRead).toEqual({ bookId: 'book-2', chapterId: 'chap-2' });
  });
});

describe('useReaderStore 其他动作', () => {
  beforeEach(() => {
    resetStore();
  });

  test('setSegment 仅更新当前段落，不改写 lastRead', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    const before = useReaderStore.getState().lastRead;

    useReaderStore.getState().setSegment('seg-5');
    const state = useReaderStore.getState();

    expect(state.segmentId).toBe('seg-5');
    expect(state.lastRead).toBe(before);
  });

  test('clearReader 清空当前阅读位置但不影响 lastRead', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    useReaderStore.getState().clearReader();

    const state = useReaderStore.getState();
    expect(state.bookId).toBeNull();
    expect(state.chapterId).toBeNull();
    expect(state.segmentId).toBeNull();
    expect(state.lastRead).toEqual({ bookId: 'book-1', chapterId: 'chap-1' });
  });
});

describe('P1-17 段落级续读（lastRead.segmentId 持久化与兼容）', () => {
  beforeEach(() => {
    resetStore();
  });

  test('recordProgress 同步当前段与 lastRead.segmentId（滚动停止防抖提交）', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');

    useReaderStore.getState().recordProgress('seg-5');

    const state = useReaderStore.getState();
    expect(state.segmentId).toBe('seg-5');
    expect(state.lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-5',
    });
  });

  test('recordProgress 幂等：同段落重复提交不产生新 lastRead 引用', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');
    useReaderStore.getState().recordProgress('seg-5');
    const before = useReaderStore.getState().lastRead;

    useReaderStore.getState().recordProgress('seg-5');

    expect(useReaderStore.getState().lastRead).toBe(before);
  });

  test('recordProgress：lastRead 属于其它书/章时不误写（跨章由 openChapter 负责）', () => {
    useReaderStore.getState().openChapter('book-1', 'chap-1');
    // 模拟 lastRead 滞后于当前阅读位置的极端时序（如跨章切换瞬间）
    useReaderStore.setState({
      lastRead: { bookId: 'book-2', chapterId: 'chap-2', segmentId: 'other' },
    });

    useReaderStore.getState().recordProgress('seg-9');

    const state = useReaderStore.getState();
    expect(state.segmentId).toBe('seg-9');
    expect(state.lastRead).toEqual({
      bookId: 'book-2',
      chapterId: 'chap-2',
      segmentId: 'other',
    });
  });

  test('兼容旧持久化数据：lastRead 缺失 segmentId 时 openChapter 不崩溃并正常补齐', () => {
    // 模拟旧版本持久化数据反序列化后的形态（无 segmentId 字段）
    useReaderStore.setState({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: null,
      lastRead: { bookId: 'book-1', chapterId: 'chap-1' },
    });

    useReaderStore.getState().openChapter('book-1', 'chap-1', 'seg-1');

    const state = useReaderStore.getState();
    expect(state.segmentId).toBe('seg-1');
    expect(state.lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
    });
  });

  test('兼容旧持久化数据：无段落进度时续读打开（不携带段落）仍回章首语义', () => {
    useReaderStore.setState({
      bookId: null,
      chapterId: null,
      segmentId: null,
      lastRead: { bookId: 'book-1', chapterId: 'chap-1' },
    });

    // 续读打开：不携带 segmentId → lastRead 不写入段落字段（回章首）
    useReaderStore.getState().openChapter('book-1', 'chap-1');

    const state = useReaderStore.getState();
    expect(state.segmentId).toBeNull();
    expect(state.lastRead).toEqual({ bookId: 'book-1', chapterId: 'chap-1' });
    expect(state.lastRead && 'segmentId' in state.lastRead).toBe(false);
  });
});

describe('restoreLastRead（备份恢复续读位置）', () => {
  beforeEach(() => {
    resetStore();
  });

  test('写入校验过的续读位置（含 segmentId），运行态 bookId/chapterId 不受影响', () => {
    useReaderStore.setState({ bookId: 'book-x', chapterId: 'chap-x', segmentId: 'seg-x' });

    useReaderStore.getState().restoreLastRead({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
    });

    const state = useReaderStore.getState();
    expect(state.lastRead).toEqual({
      bookId: 'book-1',
      chapterId: 'chap-1',
      segmentId: 'seg-1',
    });
    // 恢复仅写 lastRead 持久化字段，不触碰当前阅读运行态
    expect(state.bookId).toBe('book-x');
    expect(state.chapterId).toBe('chap-x');
    expect(state.segmentId).toBe('seg-x');
  });

  test('写入无段落进度（回章首语义）的续读位置', () => {
    useReaderStore.getState().restoreLastRead({ bookId: 'book-2', chapterId: 'chap-2' });

    const state = useReaderStore.getState();
    expect(state.lastRead).toEqual({ bookId: 'book-2', chapterId: 'chap-2' });
    expect(state.lastRead && 'segmentId' in state.lastRead).toBe(false);
  });

  test('传 null 清空续读位置（旧备份兼容语义）', () => {
    useReaderStore.setState({
      lastRead: { bookId: 'book-1', chapterId: 'chap-1', segmentId: 'seg-1' },
    });

    useReaderStore.getState().restoreLastRead(null);

    expect(useReaderStore.getState().lastRead).toBeNull();
  });
});
