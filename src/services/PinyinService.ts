/**
 * 注音服务（PinyinService）
 * 对文本逐字注音。判音策略：pinyin-pro 基础语境判音（禁用变调）+ polyphone-rules.json 规则修正
 * + tongjia-zi.json 通假字标注 + yiti-zi.json 异体字关联 + pinyin-dict.json 兜底。
 * 字典域扩展：支持注入「外部读音提供者」（ReadingProvider，由 DictEngine 实现），
 * 仲裁顺序：用户读音纠正（ReadingOverrideProvider，最高） > 用户显式选择的字典来源 >
 * 内置规则库 > pinyin-pro 语境 / 字典兜底。
 * 注意：PinyinService 不 import DictEngine / store（依赖方向 dict/store → pinyin 单向，避免环依赖）。
 */
import { pinyin } from 'pinyin-pro';
import type {
  CanonProvider,
  CanonReadingResult,
  CanonTongjiaResult,
  PinyinAnnotation,
  PinyinMode,
  ServiceResult,
} from '@/types';

import pinyinDictData from '@/data/pinyin-dict.json';
import polyphoneRulesData from '@/data/polyphone-rules.json';
import yitiData from '@/data/yiti-zi.json';
import RNFS from 'react-native-fs';
import { toSimplified } from '@/utils/conversion';
import {
  buildHanSequence,
  pickContextHit,
  type HanSequence,
} from '@/utils/canonContext';

/**
 * 外部读音提供者接口（DictEngine 实现）：
 * - getReadings：多音字候选读音（并集入 getPolyphoneReadings）
 * - resolve：语境判音（命中时优先级最高；未命中返回 null 走内置规则库）
 */
export interface ReadingProvider {
  getReadings(char: string): string[];
  resolve(char: string, context: string): string | null;
}

/** 外部读音提供者（null 时行为与历史版本完全一致） */
let externalProvider: ReadingProvider | null = null;

/**
 * 注入/移除外部读音提供者。
 * 由 DictEngine.init() 末尾调用完成注入（依赖方向：dict → pinyin，单向）。
 */
export function setExternalReadingProvider(p: ReadingProvider | null): void {
  externalProvider = p;
}

/** 测试辅助：读取当前外部提供者 */
export function getExternalReadingProvider(): ReadingProvider | null {
  return externalProvider;
}

/**
 * 用户读音纠正提供者接口（useReadingOverrideStore 注入）：
 * resolve：用户对该字在该句语境的手动纠正读音（未命中返回 null）。
 * 通过 setter 注入避免 store ← → service 环依赖（依赖方向 store → pinyin 单向）。
 */
export interface ReadingOverrideProvider {
  resolve(char: string, context: string): string | null;
}

/**
 * 用户读音纠正提供者（仲裁链最顶端；null 时行为与无纠正时完全一致）。
 * 注入时机：App 启动延后任务（经 setReadingOverrideProvider 完成，
 * provider 内部在调用时实时读取 store state，注音结果随纠正增删即时生效）。
 */
let readingOverrideProvider: ReadingOverrideProvider | null = null;

/** 注入/移除用户读音纠正提供者（由 App 启动任务调用） */
export function setReadingOverrideProvider(
  p: ReadingOverrideProvider | null,
): void {
  readingOverrideProvider = p;
}

/** 测试辅助：读取当前用户读音纠正提供者 */
export function getReadingOverrideProvider(): ReadingOverrideProvider | null {
  return readingOverrideProvider;
}

// ---------- canon 语境校验提供者（CanonService 注入）----------

/**
 * canon 校验提供者（null 时通假不标角标、读音回退 pinyin-pro 并标未校验）。
 * 通过 setCanonProvider 注入，避免 PinyinService 反向依赖 CanonService。
 */
let canonProvider: CanonProvider | null = null;

/** 注入/移除 canon 校验提供者（由 CanonService.init 之后调用） */
export function setCanonProvider(p: CanonProvider | null): void {
  canonProvider = p;
}

/** 测试辅助：读取当前 canon 提供者 */
export function getCanonProvider(): CanonProvider | null {
  return canonProvider;
}

/** 多音字语境规则 */
interface PolyphoneContext {
  pattern: string;
  pinyin: string;
  note?: string;
}

interface PolyphoneRule {
  char: string;
  default: string;
  readings: string[];
  contexts: PolyphoneContext[];
  note?: string;
}

/** 异体字分组 */
interface YitiGroup {
  standard: string;
  variants: string[];
  note?: string;
}

/** pinyin-pro type:'all' 输出项 */
interface PinyinAllItem {
  origin: string;
  pinyin: string;
  isZh: boolean;
  polyphonic: string[];
}

const PINYIN_DICT = pinyinDictData.dict as Record<string, string>;
const POLYPHONE = pinyinDictData.polyphone as Record<string, string[]>;
const RULES = polyphoneRulesData.rules as unknown as PolyphoneRule[];
const YITI_GROUPS = yitiData.groups as unknown as YitiGroup[];

// ---------- 词组读音层（v3.2：phrase-pinyin-data） ----------
// 数据：mozillazg/phrase-pinyin-data（MIT）large_pinyin.txt v0.19.0 = 汉典词典 +
// 汉典成语词典 + CC-CEDICT + 手工纠正；构建脚本 build-phrase-pinyin.mjs 过滤为
// 「2~8 字纯汉字且含至少一个多音字」的词组（约 18 万条）。
//
// 【P0 性能】数据不再静态 import：4.9MB JSON 在 bundle 执行期整块 parse 会拖慢
// 冷启动首帧。现下沉为 Android assets（data/phrase-pinyin.json），运行时经
// RNFS.readFileAssets 异步载入（ensurePhrasePinyinData），App 启动延后任务预热；
// 载入完成前 getPhraseMap 返回空 Map（词组层缺席 → 仲裁链由规则库 / pinyin-pro
// 兜底，行为等同无词库），载入完成后由 PinyinText 晚到失效机制触发重注音。
// 测试环境经 setPhrasePinyinSyncProvider 注入同步 provider（jestSetupFile 惰性
// 读盘），与旧「首次 annotate 时懒建 Map」语义逐字节等价。
const PHRASE_SOURCE_LABEL = 'phrase-pinyin-data（汉典/CC-CEDICT 合并词库）';
const PHRASE_MAX_LEN = 8;
const PHRASE_ASSET_PATH = 'data/phrase-pinyin.json';

/** phrase-pinyin.json 载荷结构（build-phrase-pinyin.mjs 输出） */
interface PhrasePinyinPayload {
  phrases: Record<string, string>;
}

type PhraseSyncProvider = () => PhrasePinyinPayload;
type PhraseAsyncLoader = () => Promise<string>;

let phraseMapCache: Map<string, string> | null = null;
/** 测试环境同步 provider（jest 注入；设置后重置缓存，下次 getPhraseMap 懒调用） */
let phraseSyncProvider: PhraseSyncProvider | null = null;
/** 运行时异步载入器（可注入替换；默认 assets 读取） */
let phraseAsyncLoader: PhraseAsyncLoader | null = null;
/** 单例载入 promise（失败时置 null 允许重试） */
let phraseReadyPromise: Promise<boolean> | null = null;

/** 注入测试同步 provider（jestSetupFile 用；与旧静态 import 懒初始化语义等价） */
export function setPhrasePinyinSyncProvider(p: PhraseSyncProvider | null): void {
  phraseSyncProvider = p;
  phraseMapCache = null;
}

/** 注入异步载入器（返回 JSON 原文；测试/特殊环境可替换） */
export function setPhrasePinyinAsyncLoader(l: PhraseAsyncLoader | null): void {
  phraseAsyncLoader = l;
  phraseReadyPromise = null;
}

/** 测试辅助：复位词组层到未载入态（清缓存与全部注入） */
export function resetPhrasePinyinForTests(): void {
  phraseMapCache = null;
  phraseSyncProvider = null;
  phraseAsyncLoader = null;
  phraseReadyPromise = null;
}

/** 词组层是否已完成载入（Map 已构建且非空） */
export function isPhrasePinyinDataLoaded(): boolean {
  return phraseMapCache !== null && phraseMapCache.size > 0;
}

/** 默认载入器：Android assets 直读；iOS 预留 MainBundlePath 兜底（未打包则降级） */
function defaultPhraseAssetLoader(): Promise<string> {
  const fs = RNFS as unknown as {
    readFileAssets?: (path: string, encoding: string) => Promise<string>;
    readFile?: (path: string, encoding: string) => Promise<string>;
    MainBundlePath?: string;
  };
  if (typeof fs.readFileAssets === 'function') {
    return fs.readFileAssets(PHRASE_ASSET_PATH, 'utf8');
  }
  if (fs.MainBundlePath && typeof fs.readFile === 'function') {
    return fs.readFile(`${fs.MainBundlePath}/${PHRASE_ASSET_PATH}`, 'utf8');
  }
  return Promise.reject(new Error('phrase-pinyin assets unavailable'));
}

/**
 * 确保词组数据就绪（幂等单例）。resolve true = 词组层可用；false = 载入失败
 * （降级为无词库，规则库 / pinyin-pro 兜底；可再次调用重试）。
 * 同步 provider 存在时（测试环境）直接走同步路径。
 */
export function ensurePhrasePinyinData(): Promise<boolean> {
  if (isPhrasePinyinDataLoaded()) {
    return Promise.resolve(true);
  }
  if (phraseSyncProvider) {
    return Promise.resolve(getPhraseMap().size > 0);
  }
  if (!phraseReadyPromise) {
    const loader = phraseAsyncLoader ?? defaultPhraseAssetLoader;
    phraseReadyPromise = loader()
      .then((text) => {
        const payload = JSON.parse(text) as PhrasePinyinPayload;
        phraseMapCache = new Map(Object.entries(payload.phrases));
        return phraseMapCache.size > 0;
      })
      .catch(() => {
        // 载入失败：清空 promise 允许下次调用重试；期间词组层缺席（空 Map）
        phraseMapCache = phraseMapCache ?? new Map();
        phraseReadyPromise = null;
        return false;
      });
  }
  return phraseReadyPromise;
}

function getPhraseMap(): Map<string, string> {
  if (!phraseMapCache) {
    if (phraseSyncProvider) {
      phraseMapCache = new Map(Object.entries(phraseSyncProvider().phrases));
    } else {
      // 运行时数据尚未异步载入：空覆盖（不阻塞同步注音路径），
      // ensurePhrasePinyinData 完成后整体替换，PinyinText 晚到机制触发重算
      phraseMapCache = new Map();
    }
  }
  return phraseMapCache;
}

/**
 * 对逻辑字符序列做正向最大匹配，得到「下标 → 词组读音」覆盖表。
 * 词组内每个字（含单音字）都采用词典读音——词典条目整体可信；
 * 与 canon 语境、规则库的冲突由仲裁链顺序保证（canon > 规则库 > 词组层）。
 *
 * @param logicChars 与原文码点严格对齐的简体逻辑字序列
 * @returns Map<原文码点下标, 读音>
 */
export function computePhraseOverlay(logicChars: readonly string[]): Map<number, string> {
  const map = getPhraseMap();
  const overlay = new Map<number, string>();
  let i = 0;
  while (i < logicChars.length) {
    if (!isCJKChar(logicChars[i])) {
      i += 1;
      continue;
    }
    let hit = false;
    const maxLen = Math.min(PHRASE_MAX_LEN, logicChars.length - i);
    for (let len = maxLen; len >= 2; len -= 1) {
      const phrase = logicChars.slice(i, i + len).join('');
      const pinyin = map.get(phrase);
      if (pinyin) {
        const syllables = pinyin.split(/\s+/);
        for (let j = 0; j < len; j += 1) {
          if (syllables[j]) {
            overlay.set(i + j, syllables[j]);
          }
        }
        i += len;
        hit = true;
        break;
      }
    }
    if (!hit) {
      i += 1;
    }
  }
  return overlay;
}

// ---------- 预构建索引 ----------
const rulesByChar = new Map<string, PolyphoneRule>();
for (const rule of RULES) {
  if (!rulesByChar.has(rule.char)) {
    rulesByChar.set(rule.char, rule);
  }
}

/** 标准字 -> 异体字列表 */
const yitiByStandard = new Map<string, string[]>();
/** 异体字 -> 标准字（反向） */
const yitiReverse = new Map<string, string>();
for (const group of YITI_GROUPS) {
  yitiByStandard.set(group.standard, group.variants);
  for (const v of group.variants) {
    if (!yitiReverse.has(v)) {
      yitiReverse.set(v, group.standard);
    }
  }
}

// ---------- 工具函数 ----------

/** 判断是否汉字（含扩展区） */
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

/**
 * 从规则库中解析单个汉字在指定语境下的读音。
 * 规则匹配策略（位置感知，向后兼容）：
 * - 无锚定 pattern：全句子串匹配（存量 pattern 语义不变，与出现位置无关）；
 * - `^` 前缀锚定：pattern 形如 `^匕首`，表示该字**之前**紧邻的文本以「匕首」结尾
 *   （即 context.slice(0, charIdx).endsWith('匕首')）；
 * - `$` 后缀锚定：pattern 形如 `天下$`，表示该字**之后**紧邻的文本以「天下」开头
 *   （即 context.slice(charIdx + 1).startsWith('天下')）；
 * - 一个 char 在句中可能出现多次——对每次出现位置分别尝试，任一位置命中即算命中
 *   （如「学而时习之，不亦说乎」的「说」）；
 * - 同时命中多个时按「最长 pattern 胜出」（长度按锚定后内容码点数计）；
 *   锚定 pattern 与非锚定 pattern 同长时锚定优先。
 * charIdx 按码点定位（Array.from），保证扩展区汉字不串位。
 */
export function resolvePolyphone(char: string, context: string): string {
  return resolvePolyphoneMatched(char, context).pinyin;
}

/**
 * resolvePolyphone 的带命中标志版本（内部使用）：
 * matched=false 表示规则库无 pattern 命中、读音仅为 default 兜底——
 * 该弱证据结论应让位于词组层词典事实（v3.2 仲裁链），但不能替换原导出签名。
 */
function resolvePolyphoneMatched(
  char: string,
  context: string,
): { pinyin: string; matched: boolean } {
  const rule = rulesByChar.get(char);
  if (!rule) {
    return { pinyin: PINYIN_DICT[char] ?? '', matched: false };
  }
  let best: PolyphoneContext | null = null;
  let bestLen = -1;
  let bestAnchored = false;

  /** 候选纳入：最长内容胜出；同长时锚定优先 */
  const consider = (ctx: PolyphoneContext, contentLen: number, anchored: boolean): void => {
    if (
      !best ||
      contentLen > bestLen ||
      (contentLen === bestLen && anchored && !bestAnchored)
    ) {
      best = ctx;
      bestLen = contentLen;
      bestAnchored = anchored;
    }
  };

  // 1) 无锚定 pattern：全句子串匹配（向后兼容，与出现位置无关）
  for (const ctx of rule.contexts) {
    const p = ctx.pattern;
    if (p && !p.startsWith('^') && !p.endsWith('$') && context.includes(p)) {
      consider(ctx, Array.from(p).length, false);
    }
  }

  // 2) 锚定 pattern：按 char 的每个码点出现位置分别判定，任一位置命中即算命中
  if (rule.contexts.some((c) => c.pattern.startsWith('^') || c.pattern.endsWith('$'))) {
    const chars = Array.from(context);
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== char) {
        continue;
      }
      const prefix = chars.slice(0, i).join('');
      const suffix = chars.slice(i + 1).join('');
      for (const ctx of rule.contexts) {
        const p = ctx.pattern;
        if (!p) {
          continue;
        }
        if (p.startsWith('^')) {
          const content = p.slice(1);
          if (content && prefix.endsWith(content)) {
            consider(ctx, Array.from(content).length, true);
          }
        } else if (p.endsWith('$')) {
          const content = p.slice(0, -1);
          if (content && suffix.startsWith(content)) {
            consider(ctx, Array.from(content).length, true);
          }
        }
      }
    }
  }

  return {
    pinyin: best ? (best as PolyphoneContext).pinyin : rule.default || (rule.readings[0] ?? ''),
    matched: Boolean(best),
  };
}

/** 获取多音字的全部候选读音（内置 ∪ 外部字典来源，去重；非多音字或未知字返回空数组），返回副本避免外部篡改内部数据 */
export function getPolyphoneReadings(char: string): string[] {
  const builtin = POLYPHONE[char];
  const readings = builtin && builtin.length > 0 ? [...builtin] : [];
  const external = externalProvider?.getReadings(char);
  if (external && external.length > 0) {
    for (const r of external) {
      if (!readings.includes(r)) {
        readings.push(r);
      }
    }
  }
  return readings;
}

/** 是否生僻字：不在内置拼音字典中，或属于扩展区汉字 */
export function isRareChar(char: string): boolean {
  if (!isCJKChar(char)) {
    return false;
  }
  // 归一化到简体再查字典：字典为简体键，繁体字直接查会误判为生僻字（繁体模式满屏下划线）
  const logic = toSimplified(char);
  const cp = logic.codePointAt(0) ?? 0;
  if (cp > 0x2a6df) {
    return true;
  }
  return !PINYIN_DICT[logic];
}

/** 单字兜底注音（pinyin-pro 单字模式） */
function singleCharPinyin(ch: string): string {
  return pinyin(ch, { toneType: 'symbol', toneSandhi: false, type: 'string' });
}

/**
 * 注音上下文选项（含篇目级/书级 scope，供 canon 语境校验查询）。
 */
export interface AnnotateOptions {
  /** 篇目级 ID（Chapter.id），精确匹配键 */
  workId?: string;
  /** 书级 ID（Book.id），通配兜底层 */
  bookId?: string;
}

/**
 * 对文本逐字注音。
 * @param text 原文
 * @param mode full 全文注音 / rare 仅生僻字 / off 关闭
 * @param opts 上下文选项（workId/bookId），用于 canon 语境化通假判定与多音字读音选择
 */
export function annotate(
  text: string,
  mode: PinyinMode,
  opts?: AnnotateOptions,
): ServiceResult<PinyinAnnotation[]> {
  if (!text || mode === 'off') {
    return { success: true, data: [] };
  }
    const { workId, bookId } = opts ?? {};
    try {
      const chars = Array.from(text);
      // 逻辑语境：整句归一化到简体，供规则 / 外部字典的语境匹配使用。
      // 规则 pattern 与字典语境均为简体，繁体正文直接匹配会全部 miss（如「說乎」匹配不到「说乎」）。
      const logicText = toSimplified(text);
      // 用例级语境锚定（canon v3）：段落汉字序列 + 例句跨度缓存。
      // 同一例句在段落内只定位一次，逐字符判定「是否落在例句跨度内」。
      const seqInfo: HanSequence = buildHanSequence(text);
      const tjSpanCache = new Map<string, [number, number] | null>();
      const rdSpanCache = new Map<string, [number, number] | null>();
      // 词组读音覆盖表（v3.2）：与 chars 严格对齐的简体逻辑字序列上做正向最大匹配
      const phraseOverlay = computePhraseOverlay(chars.map((c) => toSimplified(c)));
    // 整句语境注音（禁用变调，保持原调）
    const baseArr = pinyin(text, {
      toneType: 'symbol',
      toneSandhi: false,
      type: 'all',
    }) as unknown as PinyinAllItem[];

    // 对齐检查：若 pinyin-pro 返回项数与字符数不一致，回退逐字注音
    const aligned = baseArr && baseArr.length === chars.length;

    const result: PinyinAnnotation[] = chars.map((ch, idx) => {
      if (!isCJKChar(ch)) {
        return {
          char: ch,
          pinyin: '',
          isPolyphone: false,
          isRare: false,
        };
      }

      // 逻辑字：归一化到简体，用于一切字典查询（字典/规则/异体字/通假均为简体键）。
      // 显示字 char 保持原文（可能为繁体）字形，保证繁简两态渲染一致、字间距/选区偏移不变。
      const logic = toSimplified(ch);

      // 1) 基础读音：整句语境注音（对繁体同样有效）> 字典（按简体查）> 单字兜底
      let py = '';
      if (aligned) {
        py = baseArr[idx]?.pinyin ?? '';
      }
      if (!py) {
        py = PINYIN_DICT[logic] ?? '';
      }
      if (!py) {
        py = singleCharPinyin(ch);
      }

      // 2) 读音仲裁（优先级：用户读音纠正 > 用户字典 > canon语境 > 内置规则 > pinyin-pro）
      let readingSources: string[] | undefined;
      let readingVerified = false;
      const overrideReading = readingOverrideProvider
        ? readingOverrideProvider.resolve(logic, logicText)
        : null;
      const extReading = overrideReading
        ? overrideReading
        : externalProvider?.resolve(logic, logicText);
      if (extReading) {
        // 用户读音纠正 / 用户显式选择，最高优先，已校验（源未知，不写 sources）
        py = extReading;
        readingVerified = true;
      } else {
        // canon 语境读音（v3.1：候选行经用例级语境锚定后采用；无 context 行
        // 一律跳过——无例句即无用例级证据，回退仲裁链下一层）
        const rdCands = canonProvider
          ? canonProvider.getReadingCandidates
            ? canonProvider.getReadingCandidates(workId, bookId, logic)
            : [canonProvider.getReading(workId, bookId, logic)].filter(
                (r): r is CanonReadingResult => r !== null,
              )
          : [];
        const canonReading: CanonReadingResult | null = pickContextHit(
          rdCands,
          idx,
          seqInfo,
          rdSpanCache,
        );
        if (canonReading) {
          py = canonReading.reading;
          readingSources = canonReading.sources;
          readingVerified = true;
        } else {
          // 规则库：pattern 真命中才短路；仅 default 兜底（matched=false）时
          // 落词组层——词典事实强于「取首个读音」的弱兜底（v3.2 仲裁链）
          let ruleHandled = false;
          if (rulesByChar.has(logic)) {
            const ruleResult = resolvePolyphoneMatched(logic, logicText);
            if (ruleResult.matched) {
              py = ruleResult.pinyin;
              ruleHandled = true;
            }
          }
          if (!ruleHandled) {
            // 词组精确匹配（v3.2）：位于古文规则库之后——通用词典对古文异读
            // 可能误导（如「地道」词典为名词 dì dào），规则库优先守古文
            const phrasePy = phraseOverlay.get(idx);
            if (phrasePy) {
              py = phrasePy;
              readingSources = [PHRASE_SOURCE_LABEL];
              readingVerified = true;
            }
          }
        }
      }

      // 3) 通假标注：canon 是通假展示的唯一权威。
      //    仅当 canon 命中且通过用例级语境锚定时才设置 tongjia（v3：
      //    候选行带语料例句，字符出现位置须落在例句跨度内；例句对不上
      //    正文的异文场景宁缺毋滥不标注），否则绝不设置。
      const annotation: PinyinAnnotation = {
        char: ch,
        pinyin: mode === 'rare' && !isRareChar(logic) ? '' : py,
        isPolyphone: Boolean(POLYPHONE[logic] && POLYPHONE[logic].length > 1),
        isRare: isRareChar(logic),
        readingSources,
        readingVerified,
      };
      // canon 通假候选（v3.1：多候选含各自 context；无 context 行跳过不标注，
      // 根治「其→箕」「虚→墟」类无例句字级断言的全书误标）
      const tjCands = canonProvider
        ? canonProvider.getTongjiaCandidates
          ? canonProvider.getTongjiaCandidates(workId, bookId, logic)
          : [canonProvider.getTongjia(workId, bookId, logic)].filter(
              (r): r is CanonTongjiaResult => r !== null,
            )
        : [];
      const canonTj: CanonTongjiaResult | null = pickContextHit(
        tjCands,
        idx,
        seqInfo,
        tjSpanCache,
      );
      if (canonTj) {
        annotation.tongjia = {
          original: canonTj.original,
          note: canonTj.note,
          source: canonTj.sources[0],
          sources: canonTj.sources,
          verified: canonTj.verified,
          context: canonTj.context,
        };
      }

      // 4) 异体字关联
      const variants = yitiByStandard.get(logic);
      if (variants) {
        annotation.yiti = variants;
      } else if (yitiReverse.has(logic)) {
        annotation.yiti = [yitiReverse.get(logic) as string];
      }

      return annotation;
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export const PinyinService = {
  annotate,
  resolvePolyphone,
  getPolyphoneReadings,
  isRareChar,
  setExternalReadingProvider,
  setCanonProvider,
  setReadingOverrideProvider,
};

export default PinyinService;
