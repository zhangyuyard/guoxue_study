/**
 * 古音拟音服务（GuyinService）
 * 数据源：src/data/guyin-zi.json（构建期由 scripts/build-guyin-dict.mjs 生成，
 * 来自 Baxter-Sagart 上古/中古汉语拟音表，学术公开数据，展示时须署名）。
 * 约 3900 条目，运行时懒加载为内存 Map 查询，不进 SQLite、无平台差异。
 *
 * 查询口径：canon 库同款 —— 库内 key 为构建期 opencc 繁→简归一化的简体字，
 * 查询前用 ConversionService.toSimplified 归一化，保证繁体显示模式下同样命中。
 *
 * 版本互指：GUYIN_DICT_VERSION 与构建脚本 scripts/build-guyin-dict.mjs 的
 * GUYIN_VERSION 一致（数据格式/口径变更时同步 +1）。
 */
import guyinData from '@/data/guyin-zi.json';
import { ConversionService } from '@/services/ConversionService';

/** 古音条目：中古音（Baxter 转写）+ 上古音（Baxter-Sagart 拟音）+ 可选英文释义 */
export interface GuyinEntry {
  /** 中古音（Baxter 转写），如 "sywet" */
  mc: string;
  /** 上古汉语拟音（Baxter-Sagart），如 "*l̥ot" */
  oc: string;
  /** 英文释义（数据源自带，可选） */
  gloss?: string;
}

/** guyin-zi.json 的 meta 结构 */
export interface GuyinMeta {
  source: string;
  sourceUrl?: string;
  license: string;
  attribution: string;
  version: number;
  retrievedAt?: string;
  entries: number;
  skipped?: { emptyMc?: number; emptyOc?: number; badKey?: number; duplicated?: number };
}

interface GuyinDataFile {
  _meta: GuyinMeta;
  chars: Record<string, GuyinEntry>;
}

/** ★ 与 scripts/build-guyin-dict.mjs 的 GUYIN_VERSION 互指（修改须同步 +1） */
export const GUYIN_DICT_VERSION = 1;

/** 展示署名（浮窗/解析面板古音区块底部 tiny 小字） */
export const GUYIN_ATTRIBUTION = 'Baxter-Sagart (2014)';

/**
 * 拟音字符串清洗（纯函数，便于单测）：去首尾空白 + 连续空白折叠。
 * 用于运行时兜底清洗 JSON 内可能的异常空白。
 */
export function cleanPhoneticString(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 懒加载的内存查询 Map（首次查询时构建，之后复用） */
let charsMap: Map<string, GuyinEntry> | null = null;

function ensureMap(): Map<string, GuyinEntry> {
  if (!charsMap) {
    const data = guyinData as GuyinDataFile;
    charsMap = new Map<string, GuyinEntry>();
    for (const [key, entry] of Object.entries(data.chars ?? {})) {
      if (!key || !entry) continue;
      charsMap.set(key, {
        mc: cleanPhoneticString(entry.mc ?? ''),
        oc: cleanPhoneticString(entry.oc ?? ''),
        ...(entry.gloss ? { gloss: cleanPhoneticString(entry.gloss) } : {}),
      });
    }
  }
  return charsMap;
}

export const GuyinService = {
  /**
   * 查询单字古音。未收录/非单字输入返回 null（调用方据此隐藏古音区块）。
   * 繁体输入先归一化为简体再查（与库内 key 同口径）。
   */
  getGuyin(char: string): GuyinEntry | null {
    if (!char) {
      return null;
    }
    const chars = Array.from(char);
    if (chars.length !== 1) {
      return null;
    }
    const queryChar = ConversionService.toSimplified(char).data ?? char;
    const entry = ensureMap().get(queryChar);
    if (!entry) {
      return null;
    }
    // 防御：归一化清洗后 mc/oc 皆空视为无效数据
    if (!entry.mc || !entry.oc) {
      return null;
    }
    return entry;
  },

  /** 获取数据 meta（来源/许可/版本，供展示或诊断） */
  getMeta(): GuyinMeta {
    return (guyinData as GuyinDataFile)._meta;
  },

  /** 重置内存 Map（测试用） */
  resetForTest(): void {
    charsMap = null;
  },
};

export default GuyinService;
