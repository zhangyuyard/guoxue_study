/**
 * 逐句分组纯函数（P1-07 提示粒度：逐句揭示）
 * 依句末标点把一段文本切分为句组，引号内的句末标点不切断句子
 * （如 王曰：“……乎？” 整体为一句，？在 “” 内不切、收口引号处整句结束）。
 * 独立于 UI 与组件层，便于单元测试锁定切分口径。
 */

/** 句末标点（中文全角 + 西文半角；顿号 、 按口径计入句末） */
const SENTENCE_END_RE = /[。！？；、.!?,]/;

/** 引号/括号开符号（含中文弯引号、直角引号、圆括号，向前兼容） */
const QUOTE_OPENERS = new Set(['“', '‘', '「', '『', '（', '(']);

/** 引号/括号闭符号 */
const QUOTE_CLOSERS = new Set(['”', '’', '」', '』', '）', ')']);

/** 逐句分组的字格数据（与 FillBlankView 的 BlankChar 结构兼容） */
export interface SplitChar {
  /** 全局唯一索引 */
  index: number;
  /** 原字（词级模式下为整个单词） */
  char: string;
  /** 是否为待填写空格 */
  isBlank: boolean;
}

/**
 * 标记每个字符是否为「句组结尾字符」。
 * 规则：
 * - 句末标点（。！？；、.!?,）在引号深度为 0 时结束当前句组；
 * - 引号内的句末标点不切断（引号深度 > 0）；
 * - 收口引号使深度归 0 且前一字符为句末标点时，句组在收口引号处结束
 *   （覆盖 “……乎？” / 「曰："……。"」 形态，保证闭引号归属前句）；
 * - 《》书名号不参与引号计数（书名内一般无句末标点）。
 * 返回数组与 Array.from(text) 等长，逐字符对应。
 */
export function markSentenceEnds(text: string): boolean[] {
  const chars = Array.from(text);
  const ends = new Array<boolean>(chars.length).fill(false);
  let depth = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (QUOTE_OPENERS.has(ch)) {
      depth += 1;
      continue;
    }
    if (QUOTE_CLOSERS.has(ch)) {
      depth = Math.max(0, depth - 1);
      // 收口后归零且前一字符为句末标点 → 整句在此收束
      if (depth === 0 && i > 0 && SENTENCE_END_RE.test(chars[i - 1])) {
        ends[i] = true;
      }
      continue;
    }
    if (depth === 0 && SENTENCE_END_RE.test(ch)) {
      ends[i] = true;
    }
  }
  return ends;
}

/**
 * 把一段字格切分为句组，返回「全局空格索引数组」的列表。
 * - 句组按文本顺序排列，组内空格保持原顺序；
 * - 不含空格的句组不产生条目（空组隐藏）；
 * - 文本末尾未遇句末标点时，剩余空格归入最后一组。
 */
export function buildSentenceGroups(chars: SplitChar[]): number[][] {
  const text = chars.map((c) => c.char).join('');
  const ends = markSentenceEnds(text);
  const groups: number[][] = [];
  let current: number[] = [];
  chars.forEach((c, i) => {
    if (c.isBlank) {
      current.push(c.index);
    }
    if (ends[i] && current.length > 0) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}
