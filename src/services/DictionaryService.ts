/**
 * 字词句解析服务（DictionaryService）
 * 单字解析（拼音/释义/部首/笔画/异体字）+ 词语解析（词义/出处/用法/例句）。
 * 数据源：word-dict.json（词条）、pinyin-dict.json（拼音）、yiti-zi.json（异体字）。
 */
import type { CharAnalysis, ServiceResult, WordAnalysis } from '@/types';

import wordDictData from '@/data/word-dict.json';
import pinyinDictData from '@/data/pinyin-dict.json';
import yitiData from '@/data/yiti-zi.json';

/** 词条 */
interface WordEntry {
  word: string;
  meaning: string;
  usage?: string;
  examples?: string[];
  source?: string;
}

/** 异体字分组 */
interface YitiGroup {
  standard: string;
  variants: string[];
  note?: string;
}

const WORDS = wordDictData.words as unknown as WordEntry[];
const PINYIN_DICT = pinyinDictData.dict as Record<string, string>;
const YITI_GROUPS = yitiData.groups as unknown as YitiGroup[];

// ---------- 预构建索引 ----------
/** 词条精确索引：word -> entry */
const wordIndex = new Map<string, WordEntry>();
for (const entry of WORDS) {
  if (!wordIndex.has(entry.word)) {
    wordIndex.set(entry.word, entry);
  }
}

/** 标准字 -> 异体字 */
const yitiByStandard = new Map<string, string[]>();
/** 异体字 -> 标准字 */
const yitiReverse = new Map<string, string>();
for (const group of YITI_GROUPS) {
  yitiByStandard.set(group.standard, group.variants);
  for (const v of group.variants) {
    if (!yitiReverse.has(v)) {
      yitiReverse.set(v, group.standard);
    }
  }
}

/**
 * 内置部首/笔画小表（覆盖经典文本高频字）。
 * 部首与笔画以《现代汉语词典》/《通用规范汉字字典》常见归部为准。
 */
const RADICAL_STROKES: Record<string, { radical: string; strokes: number }> = {
  一: { radical: '一', strokes: 1 },
  二: { radical: '二', strokes: 2 },
  三: { radical: '一', strokes: 3 },
  上: { radical: '一', strokes: 3 },
  下: { radical: '一', strokes: 3 },
  中: { radical: '丨', strokes: 4 },
  大: { radical: '大', strokes: 3 },
  小: { radical: '小', strokes: 3 },
  天: { radical: '大', strokes: 4 },
  地: { radical: '土', strokes: 6 },
  人: { radical: '人', strokes: 2 },
  民: { radical: '氏', strokes: 5 },
  道: { radical: '辶', strokes: 12 },
  德: { radical: '彳', strokes: 15 },
  仁: { radical: '亻', strokes: 4 },
  义: { radical: '丶', strokes: 3 },
  礼: { radical: '礻', strokes: 5 },
  智: { radical: '日', strokes: 12 },
  信: { radical: '亻', strokes: 9 },
  孝: { radical: '子', strokes: 7 },
  悌: { radical: '忄', strokes: 10 },
  忠: { radical: '心', strokes: 8 },
  恕: { radical: '心', strokes: 10 },
  君: { radical: '口', strokes: 7 },
  子: { radical: '子', strokes: 3 },
  学: { radical: '子', strokes: 8 },
  习: { radical: '习', strokes: 3 },
  文: { radical: '文', strokes: 4 },
  武: { radical: '止', strokes: 8 },
  王: { radical: '王', strokes: 4 },
  玉: { radical: '玉', strokes: 5 },
  生: { radical: '生', strokes: 5 },
  成: { radical: '戈', strokes: 6 },
  乐: { radical: '丿', strokes: 5 },
  行: { radical: '彳', strokes: 6 },
  知: { radical: '矢', strokes: 8 },
  善: { radical: '口', strokes: 12 },
  恶: { radical: '心', strokes: 10 },
  美: { radical: '羊', strokes: 9 },
  和: { radical: '口', strokes: 8 },
  平: { radical: '干', strokes: 5 },
  正: { radical: '止', strokes: 5 },
  直: { radical: '目', strokes: 8 },
  刚: { radical: '刂', strokes: 6 },
  柔: { radical: '木', strokes: 9 },
  强: { radical: '弓', strokes: 12 },
  弱: { radical: '弓', strokes: 10 },
  无: { radical: '无', strokes: 4 },
  有: { radical: '月', strokes: 6 },
  名: { radical: '口', strokes: 6 },
  实: { radical: '宀', strokes: 8 },
  虚: { radical: '虍', strokes: 11 },
  静: { radical: '青', strokes: 14 },
  动: { radical: '力', strokes: 6 },
  明: { radical: '日', strokes: 8 },
  诚: { radical: '讠', strokes: 8 },
  性: { radical: '忄', strokes: 8 },
  命: { radical: '口', strokes: 8 },
  气: { radical: '气', strokes: 4 },
  神: { radical: '礻', strokes: 9 },
  精: { radical: '米', strokes: 14 },
  形: { radical: '彡', strokes: 7 },
  体: { radical: '亻', strokes: 7 },
  心: { radical: '心', strokes: 4 },
  志: { radical: '心', strokes: 7 },
  意: { radical: '心', strokes: 13 },
  情: { radical: '忄', strokes: 11 },
  欲: { radical: '欠', strokes: 11 },
  理: { radical: '王', strokes: 11 },
  父: { radical: '父', strokes: 4 },
  母: { radical: '毋', strokes: 5 },
  兄: { radical: '儿', strokes: 5 },
  弟: { radical: '弓', strokes: 7 },
  朋: { radical: '月', strokes: 8 },
  友: { radical: '又', strokes: 4 },
  师: { radical: '巾', strokes: 6 },
  贤: { radical: '贝', strokes: 8 },
  圣: { radical: '又', strokes: 5 },
  教: { radical: '攵', strokes: 11 },
  政: { radical: '攵', strokes: 9 },
  国: { radical: '囗', strokes: 8 },
  家: { radical: '宀', strokes: 10 },
  邦: { radical: '阝', strokes: 6 },
  财: { radical: '贝', strokes: 7 },
  富: { radical: '宀', strokes: 12 },
  贵: { radical: '贝', strokes: 9 },
  贱: { radical: '贝', strokes: 9 },
  贫: { radical: '贝', strokes: 8 },
  穷: { radical: '穴', strokes: 7 },
  达: { radical: '辶', strokes: 6 },
  世: { radical: '一', strokes: 5 },
  俗: { radical: '亻', strokes: 9 },
  儒: { radical: '亻', strokes: 16 },
  佛: { radical: '亻', strokes: 7 },
  仙: { radical: '亻', strokes: 5 },
  鬼: { radical: '鬼', strokes: 9 },
  仪: { radical: '亻', strokes: 5 },
};

/** 获取单字的异体字列表 */
function getYiti(char: string): string[] {
  const variants = yitiByStandard.get(char);
  if (variants) {
    return variants;
  }
  if (yitiReverse.has(char)) {
    return [yitiReverse.get(char) as string];
  }
  return [];
}

export const DictionaryService = {
  /** 单字解析 */
  lookupCharacter(char: string): ServiceResult<CharAnalysis> {
    if (!char) {
      return { success: false, error: '字符不能为空' };
    }
    const ch = Array.from(char)[0];
    if (!ch) {
      return { success: false, error: '无效字符' };
    }

    // 释义：优先单字词条，其次标准字词条（处理异体字），再次词典内任意包含条目
    let meaning = '';
    const direct = wordIndex.get(ch);
    if (direct) {
      meaning = direct.meaning;
    } else {
      const standard = yitiReverse.get(ch);
      if (standard) {
        const stdEntry = wordIndex.get(standard);
        if (stdEntry) {
          meaning = stdEntry.meaning;
        }
      }
      if (!meaning) {
        let shortest: WordEntry | null = null;
        for (const entry of WORDS) {
          if (entry.word.length > 1 && entry.word.includes(ch)) {
            if (!shortest || entry.word.length < shortest.word.length) {
              shortest = entry;
            }
          }
        }
        if (shortest) {
          meaning = shortest.meaning;
        }
      }
    }

    const rs = RADICAL_STROKES[ch];
    return {
      success: true,
      data: {
        char: ch,
        pinyin: PINYIN_DICT[ch] ?? '',
        meaning,
        radical: rs?.radical ?? '',
        strokes: rs?.strokes ?? 0,
        yiti: getYiti(ch),
      },
    };
  },

  /** 词语解析 */
  lookupWord(word: string): ServiceResult<WordAnalysis> {
    if (!word) {
      return { success: false, error: '词语不能为空' };
    }
    const target = word.trim();

    // 1) 精确匹配
    const exact = wordIndex.get(target);
    if (exact) {
      return {
        success: true,
        data: {
          word: exact.word,
          meaning: exact.meaning,
          source: exact.source,
          usage: exact.usage,
          examples: exact.examples,
        },
      };
    }

    // 2) 单字：用单字解析结果组装
    if (target.length === 1) {
      const res = this.lookupCharacter(target);
      if (res.success && res.data) {
        return {
          success: true,
          data: {
            word: target,
            meaning: res.data.meaning || '暂未收录该字释义',
            usage: undefined,
            examples: undefined,
          },
        };
      }
    }

    // 3) 包含匹配：词条包含目标词时，取最短词条
    let best: WordEntry | null = null;
    for (const entry of WORDS) {
      if (entry.word.includes(target)) {
        if (!best || entry.word.length < best.word.length) {
          best = entry;
        }
      }
    }
    if (best) {
      return {
        success: true,
        data: {
          word: best.word,
          meaning: best.meaning,
          source: best.source,
          usage: best.usage,
          examples: best.examples,
        },
      };
    }

    return { success: false, error: `未找到词条：${target}` };
  },

  /** 词库规模（供 UI 展示/调试） */
  getWordCount(): ServiceResult<number> {
    return { success: true, data: WORDS.length };
  },
};

export default DictionaryService;
