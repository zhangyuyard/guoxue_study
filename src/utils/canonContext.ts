/**
 * 通假判定「用例级语境锚定」匹配工具（canon v3）。
 *
 * 背景：通假是「用例级」属性——同一个字在同一篇内可能一处用通假义（说→悦）、
 * 另一处用本义（成事不说=说）。canon v2 只按「字 × 篇」记录判定，
 * 会把甲句的通假结论错误标注到同篇其它出现位置（误导）。
 *
 * v3 数据层为每条判定补充 context（权威语料例句，BNU 库 100% 提供）；
 * 运行时把例句与当前段落做「汉字序列匹配」：只有字符出现位置落在例句
 * 命中跨度内才标注。匹配口径：繁→简归一化（与 canon 字键同口径）+
 * 去除一切非汉字字符（标点/空白全角半角差异免疫）。
 *
 * 例句对不上正文（版本异文）或长度不足时判为不命中（宁缺毋滥）；
 * context 缺失的行（诗词粒度读音/人工种子无引文）按旧行为放行——
 * 这类行的粒度本身已足够（诗级）或已做书级过滤（古今字种子）。
 */
import { toSimplified } from '@/utils/conversion';

/** 判断是否汉字（含扩展区；与 PinyinService / 构建脚本同口径） */
function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
    (cp >= 0x2a700 && cp <= 0x2ebef) // 扩展 C-F
  );
}

/** 例句参与匹配所需的最少汉字数（低于此值区分度不足，直接判不命中） */
export const MIN_CONTEXT_HAN = 3;

/** 段落/例句归一化结果：汉字序列 + 每个汉字回指原始码点下标的映射 */
export interface HanSequence {
  /** 归一化后的汉字序列（每项一个码点） */
  chars: string[];
  /** chars[i] 来自原始文本的第 origIdx[i] 个码点 */
  origIdx: number[];
}

/**
 * 把文本归一化为汉字序列：逐码点繁→简转换（与 canon 字键查询同口径），
 * 丢弃一切非汉字字符（标点/空白/字母数字），并保留原始码点下标映射。
 */
export function buildHanSequence(text: string): HanSequence {
  const chars: string[] = [];
  const origIdx: number[] = [];
  const points = Array.from(text ?? '');
  for (let i = 0; i < points.length; i += 1) {
    const normalized = toSimplified(points[i]);
    for (const c of Array.from(normalized)) {
      if (isCJKChar(c)) {
        chars.push(c);
        origIdx.push(i);
      }
    }
  }
  return { chars, origIdx };
}

/**
 * 在段落汉字序列中定位例句（同样归一化为汉字序列）：
 * 命中返回其在原始文本中的码点跨度 [start, end]（含端点，均指向借字所在
 * 例句覆盖的字符范围），未命中/例句过短返回 null。
 */
export function findContextSpan(
  seqInfo: HanSequence,
  context: string,
): [number, number] | null {
  const needle = buildHanSequence(context).chars;
  if (needle.length < MIN_CONTEXT_HAN || needle.length > seqInfo.chars.length) {
    return null;
  }
  const hay = seqInfo.chars;
  const first = needle[0];
  for (let s = 0; s <= hay.length - needle.length; s += 1) {
    if (hay[s] !== first) {
      continue;
    }
    let matched = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (hay[s + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return [seqInfo.origIdx[s], seqInfo.origIdx[s + needle.length - 1]];
    }
  }
  return null;
}

/** 候选行的最小约束：带可选 context（canon v3 行有，v2/诗词行无） */
export interface ContextBearingCandidate {
  context?: string | null;
}

/**
 * 从候选行中选出当前字符位置的命中行（候选已按层级优先排序）：
 * - 行无 context → 视为「无语境证据」，维持旧行为直接命中（粒度已足够）；
 * - 行有 context → 例句在段落中定位成功且字符落点在跨度内才命中；
 * - 例句未命中 → 继续看下一候选（更宽层级 / 其它用例行）；
 * - 全部未命中 → 返回 null（宁缺毋滥：不标注/读音回退仲裁链）。
 *
 * @param charIdx 字符在原始文本中的码点下标
 * @param spanCache 例句 → 跨度 的段落内缓存（同一例句只定位一次）
 */
export function pickContextHit<T extends ContextBearingCandidate>(
  candidates: readonly T[],
  charIdx: number,
  seqInfo: HanSequence,
  spanCache: Map<string, [number, number] | null>,
): T | null {
  for (const cand of candidates) {
    const context = cand.context;
    if (!context) {
      return cand;
    }
    let span = spanCache.get(context);
    if (span === undefined) {
      span = findContextSpan(seqInfo, context);
      spanCache.set(context, span);
    }
    if (span && charIdx >= span[0] && charIdx <= span[1]) {
      return cand;
    }
  }
  return null;
}
