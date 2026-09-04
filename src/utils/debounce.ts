/**
 * 防抖函数
 * 用于搜索输入、注音计算等高频触发的场景。
 * 返回一个包装后的函数，并附带 cancel 方法用于手动取消。
 */

export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  cancel: () => void;
}

/**
 * 创建防抖函数
 * @param fn 目标函数
 * @param wait 等待毫秒数，默认 300ms
 * @returns 防抖包装函数（含 cancel 方法）
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait = 300,
): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Args) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}

export default debounce;
