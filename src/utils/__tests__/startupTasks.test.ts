/**
 * 启动任务延后调度器测试（BugFix：打开 App 长时间无法响应）
 * 用 fake timers 锁定：延后性、顺序性、任务间让出线程（一任务一 macrotask）、
 * 单任务失败不阻断后续、取消防重入。
 */
import { scheduleStartupTasks, type StartupTaskScheduler } from '@/utils/startupTasks';

describe('scheduleStartupTasks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('任务不同步执行：首帧（当前同步块）不被阻塞', () => {
    const ran: string[] = [];
    scheduleStartupTasks([{ key: 'a', run: () => ran.push('a') }]);

    expect(ran).toEqual([]);
    jest.runAllTimers();
    expect(ran).toEqual(['a']);
  });

  test('按传入顺序串行执行（依赖顺序由调用方排序，此处锁定调度器保序）', () => {
    const ran: string[] = [];
    scheduleStartupTasks([
      { key: 'loadRecitationList', run: () => ran.push('loadRecitationList') },
      { key: 'syncReminderFromStores', run: () => ran.push('syncReminderFromStores') },
      { key: 'recomputeAchievements', run: () => ran.push('recomputeAchievements') },
    ]);

    jest.runAllTimers();
    expect(ran).toEqual(['loadRecitationList', 'syncReminderFromStores', 'recomputeAchievements']);
  });

  test('每个任务独占一个 macrotask：任务之间让出 JS 线程', () => {
    const ran: string[] = [];
    const scheduled: (() => void)[] = [];
    const manual: StartupTaskScheduler = (fn) => {
      scheduled.push(fn);
    };
    scheduleStartupTasks(
      [
        { key: 'a', run: () => ran.push('a') },
        { key: 'b', run: () => ran.push('b') },
        { key: 'c', run: () => ran.push('c') },
      ],
      manual,
    );

    // 逐轮消费调度队列：每轮队列里恰有 1 个回调、只执行 1 个任务，
    // 即「每个任务独占一个 macrotask，任务之间让出 JS 线程」的结构性保证。
    // （默认 setTimeout 实现下该性质等价成立；fake timers 对 0ms 链会一次排空，
    // 无法直接观测，故用手动调度器断言。）
    for (const expected of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      const batch = scheduled.splice(0, scheduled.length);
      expect(batch).toHaveLength(1);
      batch.forEach((fn) => fn());
      expect(ran).toEqual(expected);
    }
    // 链尾不再安排新回调
    expect(scheduled).toHaveLength(0);
  });

  test('单个任务抛错不阻断后续任务', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ran: string[] = [];
    scheduleStartupTasks([
      { key: 'ok1', run: () => ran.push('ok1') },
      {
        key: 'boom',
        run: () => {
          throw new Error('模拟任务失败');
        },
      },
      { key: 'ok2', run: () => ran.push('ok2') },
    ]);

    jest.runAllTimers();
    expect(ran).toEqual(['ok1', 'ok2']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('boom'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  test('取消函数：调用后未执行的任务不再执行', () => {
    const ran: string[] = [];
    const scheduled: (() => void)[] = [];
    const manual: StartupTaskScheduler = (fn) => {
      scheduled.push(fn);
    };
    const cancel = scheduleStartupTasks(
      [
        { key: 'a', run: () => ran.push('a') },
        { key: 'b', run: () => ran.push('b') },
      ],
      manual,
    );

    scheduled.splice(0, scheduled.length).forEach((fn) => fn()); // 执行 a
    expect(ran).toEqual(['a']);
    cancel();
    scheduled.splice(0, scheduled.length).forEach((fn) => fn()); // b 已被取消
    expect(ran).toEqual(['a']);
  });

  test('取消发生在任何任务执行前：整条链不执行（effect 重跑防重入）', () => {
    const ran: string[] = [];
    const cancel = scheduleStartupTasks([{ key: 'a', run: () => ran.push('a') }]);
    cancel();
    jest.runAllTimers();
    expect(ran).toEqual([]);
  });

  test('可注入自定义调度器（解耦 setTimeout，便于宿主环境替换）', () => {
    const ran: string[] = [];
    const scheduled: (() => void)[] = [];
    const manual: StartupTaskScheduler = (fn) => {
      scheduled.push(fn);
    };

    scheduleStartupTasks(
      [
        { key: 'a', run: () => ran.push('a') },
        { key: 'b', run: () => ran.push('b') },
      ],
      manual,
    );
    // 未手动触发前不执行
    expect(ran).toEqual([]);
    // 逐轮消费调度队列：执行 a 时调度器又收到 b 的回调（任务间需再次调度）
    let batch = scheduled.splice(0, scheduled.length);
    batch.forEach((fn) => fn());
    expect(ran).toEqual(['a']);
    batch = scheduled.splice(0, scheduled.length);
    batch.forEach((fn) => fn());
    expect(ran).toEqual(['a', 'b']);
  });

  test('空任务列表：不抛错、不安排多余的调度', () => {
    const scheduled: (() => void)[] = [];
    const manual: StartupTaskScheduler = (fn) => {
      scheduled.push(fn);
    };
    const cancel = scheduleStartupTasks([], manual);
    expect(scheduled).toHaveLength(1); // 首个 runTask 仍会被安排一次（内部自行退出）
    scheduled.forEach((fn) => fn());
    cancel();
  });
});
