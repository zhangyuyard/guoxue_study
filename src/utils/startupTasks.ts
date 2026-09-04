/**
 * 启动任务延后调度器（BugFix：打开 App 长时间无法响应）
 *
 * 旧实现：App 启动 useEffect 里同步串行执行全部重活（书目装载、背诵列表、
 * 复习提醒同步、成就重算），最后一个 setReady(true) 才放行首帧——JS 线程整段
 * 阻塞，书越多/导入书越多卡得越久，期间用户完全无法交互。
 *
 * 新策略：首屏仅保留「必需且轻量」的同步初始化（建表 + 内置书目上屏），
 * 其余任务经本调度器逐个延后执行：
 * - 每个任务独占一个 macrotask（默认 setTimeout 0），任务之间让出 JS 线程，
 *   渲染与触摸事件得以穿插处理，首帧不再被阻塞；
 * - 任务按传入顺序串行执行，调用方负责排序（依赖在前的任务先传入）；
 * - 单个任务抛错不阻断后续任务（console.warn 降级，优于中断整条延后链）；
 * - 返回取消函数：组件卸载 / effect 重跑时可取消未执行的任务（防重入）。
 */

/** 单个延后启动任务 */
export interface StartupTask {
  /** 任务名（日志与测试定位用） */
  key: string;
  /** 任务体（同步函数；内部的异步部分自行管理） */
  run: () => void;
}

/** 调度函数：把回调安排到当前同步块之后执行（测试可注入 fake 版本） */
export type StartupTaskScheduler = (fn: () => void) => void;

/** 默认调度：macrotask（setTimeout 0）。不用微任务——微任务仍会在首帧渲染前跑完，起不到让出线程的作用 */
function defaultSchedule(fn: () => void): void {
  setTimeout(fn, 0);
}

/**
 * 顺序延后执行启动任务。
 * @param tasks 任务列表（顺序即执行顺序，依赖关系由调用方排序）
 * @param schedule 调度函数（默认 setTimeout 0；测试可注入同步/受控版本）
 * @returns 取消函数：调用后所有未执行的任务不再执行
 */
export function scheduleStartupTasks(
  tasks: readonly StartupTask[],
  schedule: StartupTaskScheduler = defaultSchedule,
): () => void {
  let cancelled = false;

  const runTask = (index: number): void => {
    if (cancelled || index >= tasks.length) {
      return;
    }
    const task = tasks[index];
    try {
      task.run();
    } catch (e) {
      // 单个任务失败不阻断后续任务：启动期功能降级优于整条延后链中断
      console.warn(`[startup] 延后任务「${task.key}」执行失败：`, e);
    }
    if (index + 1 < tasks.length) {
      schedule(() => runTask(index + 1));
    }
  };

  // 第一个任务同样延后：让当前同步块（React 提交 / 首帧渲染）先完成
  schedule(() => runTask(0));

  return () => {
    cancelled = true;
  };
}
