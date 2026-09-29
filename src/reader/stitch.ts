/**
 * 跨章连续拼接层（R3-stitch，scroll 模式专属）。
 *
 * 纯函数、零 RN 依赖、可单测。消费 L1 的 ChapterLayout / Line，
 * 产出「拼接后的全局行序列」与「渲染序变更时的滚动补偿量」。
 *
 * 不变量：
 * - 拼接后每行仍带原 chapterId；全局下标 = 在拼接序列中的位置；
 *   getItemLayout 纯算式 offset = rowHeight × 全局下标 依旧成立
 *   （所有章共用同一 geometry，rowHeight 恒定）。
 * - 锚章（activeChapterId）自身行不随渲染序变化而重排；仅其上方的
 *   行数变化（前插/前删）导致锚章首行全局下标位移 ⇒ 该位移 × rowHeight
 *   即维持视觉位置所需的滚动补偿量。
 */
import type { ChapterLayout, Line } from './geometry';

/** 章序查询返回的单条邻接引用 */
export interface SiblingRef {
  id: string;
  title?: string;
}
/** getSiblingChapters 的兼容形态 */
export interface SiblingMap {
  prev?: SiblingRef;
  next?: SiblingRef;
}

/**
 * 含锚章的最长「已装载」连续章链（渲染序）。
 * 只纳入 data 中已有的章；未装载的邻章不进序，待其装载滑入后再补齐。
 * 锚章不在 data 中 → 返回空（无锚则无渲染）。
 */
export function orderedRenderChapters(
  dataIds: ReadonlySet<string>,
  anchorId: string,
  getSibling: (id: string) => SiblingMap,
): string[] {
  if (!dataIds.has(anchorId)) {
    return [];
  }
  const order: string[] = [anchorId];
  // 向上游（prev）延伸，遇未装载/无 prev 即止
  let cur = anchorId;
  for (;;) {
    const prev = getSibling(cur).prev;
    if (!prev || !dataIds.has(prev.id)) {
      break;
    }
    order.unshift(prev.id);
    cur = prev.id;
  }
  // 向下游（next）延伸
  cur = anchorId;
  for (;;) {
    const next = getSibling(cur).next;
    if (!next || !dataIds.has(next.id)) {
      break;
    }
    order.push(next.id);
    cur = next.id;
  }
  return order;
}

export interface StitchedResult {
  /** 拼接后的全局行序列（每行 chapterId 保留） */
  readonly lines: Line[];
  /** 章 id → 该章首行在全局序列中的下标 */
  readonly firstLineOf: ReadonlyMap<string, number>;
  /** 章 id → 该章行数 */
  readonly lineCountOf: ReadonlyMap<string, number>;
}

/**
 * 按渲染序拼接各章 layout。layoutOf(id) 缺失（未就绪）的章跳过，
 * 保证返回的 lines 与 firstLineOf/lineCountOf 自洽。
 */
export function buildStitchedLines(
  order: readonly string[],
  layoutOf: (id: string) => ChapterLayout | undefined,
  /** scroll 模式：章界插入标题行（返回该章标题；undefined 不插）。page 模式不传 */
  titleOf?: (id: string) => string | undefined,
): StitchedResult {
  const lines: Line[] = [];
  const firstLineOf = new Map<string, number>();
  const lineCountOf = new Map<string, number>();
  for (const id of order) {
    const lay = layoutOf(id);
    if (!lay) {
      continue;
    }
    firstLineOf.set(id, lines.length);
    let count = 0;
    if (titleOf) {
      const t = titleOf(id);
      if (t !== undefined) {
        lines.push({ index: lines.length, chapterId: id, segmentId: '__title__', charStart: 0, charEnd: 0, isTitle: true } as Line);
        count += 1;
      }
    }
    for (const ln of lay.lines) {
      // ★ 全局重编 index：layoutChapter 的 index 是章内局部（每章从 0 起），
      //   与标题行的全局 index 在 keyExtractor（chapterId#index）上必然撞 key
      //   ⇒ React 复用错 cell（标题重复/正文被顶/内容错位）。拼接序列内
      //   index 一律 = 全局下标；渲染层定位全走数组位置/charOffset，不依赖旧值。
      lines.push({ ...ln, index: lines.length });
      count += 1;
    }
    lineCountOf.set(id, count);
  }
  return { lines, firstLineOf, lineCountOf };
}

/**
 * 渲染序变更后的滚动补偿量（px）。
 *
 * 锚章首行在 prevOrder / nextOrder 中的全局下标差 × rowHeight。
 * - 正值：锚章被下推（其上方插入了章）⇒ 需 scrollToOffset(+delta) 维持视觉位置；
 * - 负值：锚章被上提（其上方删除了章）⇒ scrollToOffset(+delta)（即减）维持；
 * - 锚章在某一侧序中缺失 ⇒ 返回 0（退化，正常滑动不应发生）。
 *
 * lineCountOf 须覆盖两侧序的全部章（含已丢弃章，调用方用持久缓存兜底），
 * 否则前删场景会算错。
 */
export function compensationDelta(
  prevOrder: readonly string[],
  nextOrder: readonly string[],
  lineCountOf: ReadonlyMap<string, number>,
  anchorId: string,
  rowHeight: number,
): number {
  const firstIndexOf = (order: readonly string[], id: string): number => {
    let acc = 0;
    for (const cid of order) {
      if (cid === id) {
        return acc;
      }
      acc += lineCountOf.get(cid) ?? 0;
    }
    return -1;
  };
  const pi = firstIndexOf(prevOrder, anchorId);
  const ni = firstIndexOf(nextOrder, anchorId);
  if (pi < 0 || ni < 0) {
    return 0;
  }
  return (ni - pi) * rowHeight;
}

/** 全局行 → 所属章 id（拼接行自带 chapterId，此处语义封装） */
export function chapterOfLine(line: Line): string {
  return line.chapterId;
}
