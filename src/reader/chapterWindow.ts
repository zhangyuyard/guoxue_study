/**
 * 章滑窗缓存状态机（R2b1，架构 L3c 预取层；对齐 legado 三章滑窗行为的
 * 合规重写：只取「预取前后章 + 跳章不清屏」行为，零代码/零资源引用）。
 *
 * 设计约束：
 * - 纯函数 + 不可变更新：每次操作返回新窗，调用方持单一 state 引用；
 * - 本层不知道章序（prev/next 链属于 TextLibraryService）：裁剪时由调用方
 *   传入应保留的 id 集合（retainIds），避免在本层复制章序逻辑；
 * - 去重判据 = windowBegin 返回 null：已有数据或已在加载都不得重复发起。
 *   对应铁律「绕门直调=一次手势多次推进」：配平式 windowBegin 成功次数
 *   ≤ 发起源次数，调用方不得绕过 begin 直接 put。
 */

export interface ChapterWindow<T> {
  /** 当前中心章（null = 未定位，初始态） */
  readonly centerId: string | null;
  /** 已就绪的章数据（id → 数据） */
  readonly data: ReadonlyMap<string, T>;
  /** 加载中的章 id 集合 */
  readonly inflight: ReadonlySet<string>;
}

export function createChapterWindow<T>(): ChapterWindow<T> {
  return { centerId: null, data: new Map(), inflight: new Set() };
}

/** 章数据是否已就绪 */
export function windowHas<T>(w: ChapterWindow<T>, id: string): boolean {
  return w.data.has(id);
}

/** 章是否加载中 */
export function windowIsLoading<T>(w: ChapterWindow<T>, id: string): boolean {
  return w.inflight.has(id);
}

export function windowGet<T>(w: ChapterWindow<T>, id: string): T | undefined {
  return w.data.get(id);
}

/**
 * 声明开始加载某章。去重闸门：已有数据或已在加载 → 返回 null（调用方
 * 不得发起）；否则该章进入 inflight。inflight 的章 recenter 时按保留集裁剪。
 */
export function windowBegin<T>(w: ChapterWindow<T>, id: string): ChapterWindow<T> | null {
  if (w.data.has(id) || w.inflight.has(id)) {
    return null;
  }
  const inflight = new Set(w.inflight);
  inflight.add(id);
  return { centerId: w.centerId, data: w.data, inflight };
}

/** 加载成功：数据入窗、清除 inflight。 */
export function windowPut<T>(w: ChapterWindow<T>, id: string, data: T): ChapterWindow<T> {
  const nextData = new Map(w.data);
  nextData.set(id, data);
  const inflight = new Set(w.inflight);
  inflight.delete(id);
  return { centerId: w.centerId, data: nextData, inflight };
}

/** 加载失败：仅清除 inflight（允许后续重试），窗内容不变。 */
export function windowFail<T>(w: ChapterWindow<T>, id: string): ChapterWindow<T> {
  const inflight = new Set(w.inflight);
  inflight.delete(id);
  return { centerId: w.centerId, data: w.data, inflight };
}

/**
 * 换中心（跳章/初始化）：更新 centerId；data 与 inflight 只保留
 * retainIds ∪ {centerId}（跳章清窗语义：中心与保留邻域之外的全部丢弃，
 * 与被跳离章相关的加载也作废——陈旧丢弃）。
 */
export function windowRecenter<T>(
  w: ChapterWindow<T>,
  centerId: string,
  retainIds: ReadonlySet<string>,
): ChapterWindow<T> {
  const keep = new Set(retainIds);
  keep.add(centerId);
  const data = new Map<string, T>();
  for (const [id, v] of w.data) {
    if (keep.has(id)) {
      data.set(id, v);
    }
  }
  const inflight = new Set<string>();
  for (const id of w.inflight) {
    if (keep.has(id)) {
      inflight.add(id);
    }
  }
  return { centerId, data, inflight };
}
