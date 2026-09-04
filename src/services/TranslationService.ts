/**
 * 翻译服务（TranslationService）— P0 在线适配器
 * 三家服务商（DeepL / Google / 百度），用户自带 API Key（经设置页录入）。
 * - detectLang：Unicode 区段粗判源语言（假名 → ja，谚文 → ko，西里尔 → ru，
 *   阿拉伯 → ar，汉字 → zh，其余拉丁/未知 → en）
 * - translateAuto：按 provider 分发适配器；目标语言默认 zh（源为中文时译 en），
 *   可显式指定 target ('zh' | 'en')
 * - 统一 15s 超时（AbortController），错误归一为 ServiceResult
 * 说明：RN 无浏览器 CORS 限制，直接 fetch 即可；Hermes 无 crypto，百度签名
 * 使用内置的纯 JS MD5（Uint8Array 实现，经 crypto 对拍验证）。
 */
import type {
  DetectedLang,
  TranslationProviderId,
  TranslationResult,
  TranslationSettings,
} from '@/types/translation';
import type { ServiceResult } from '@/types';

import {
  ensureModel,
  isNativeAvailable,
  nativeTranslate,
} from './offline/NativeOfflineTranslation';

/** 请求超时（毫秒） */
const TIMEOUT_MS = 15_000;

/** 单次翻译文本长度上限（DeepL ≤50k 字符 / Google v2 ≤5k 字符，统一保守 4000 字符） */
const MAX_TEXT_CHARS = 4000;

/** 百度通用翻译标准版 q ≤ 6000 字节（UTF-8），留余量按 5800 字节校验 */
const BAIDU_MAX_TEXT_BYTES = 5800;

/** 翻译缓存条数上限（超限淘汰最早写入的一条，Map 保持插入序） */
const TRANSLATION_CACHE_LIMIT = 50;

/** 成功结果缓存：key = `${provider}|${from}>${to}|${text}`（仅缓存 success，失败不走缓存） */
const translationCache = new Map<string, TranslationResult>();

/** 本地粗判语种 → ML Kit 语言 tag（离线翻译源语言用） */
const ML_KIT_TAG_BY_LANG: Record<DetectedLang, string> = {
  zh: 'zh',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  ar: 'ar',
  en: 'en',
};

/** 翻译目标语 → ML Kit 语言 tag */
const ML_KIT_TAG_BY_TARGET: Record<'zh' | 'en', string> = {
  zh: 'zh',
  en: 'en',
};

/** 百度通用翻译标准版 QPS=1：两次请求的完成间隔下限（毫秒，留 10% 余量） */
const BAIDU_MIN_INTERVAL_MS = 1100;

/** 百度请求串行队列（promise 链；并发调用排队依次执行） */
let baiduQueue: Promise<void> = Promise.resolve();
/** 上一次百度请求完成时间戳（0 = 尚未发过） */
let lastBaiduFinishAt = 0;

/**
 * 清空翻译缓存并复位百度限流状态（设置变更 / 测试重置用）。
 */
export function clearTranslationCache(): void {
  translationCache.clear();
  lastBaiduFinishAt = 0;
  baiduQueue = Promise.resolve();
}

/**
 * 百度客户端限流：将 task 追加到串行队列，与前一次百度请求的完成间隔不足
 * BAIDU_MIN_INTERVAL_MS 时等待补足后再发出。仅百度调用，DeepL/Google 不经此路径。
 */
function runBaiduSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = baiduQueue.then(async () => {
    const waitMs = BAIDU_MIN_INTERVAL_MS - (Date.now() - lastBaiduFinishAt);
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), waitMs));
    }
    try {
      return await task();
    } finally {
      lastBaiduFinishAt = Date.now();
    }
  });
  // 队列吞掉单次失败，保证后续排队调用不受影响
  baiduQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------- 语种粗判 ----------

/** Unicode 区段粗判源语言（不可判定时返回 'en' 作为拉丁默认） */
export function detectLang(text: string): DetectedLang {
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(text)) {
    return 'ja';
  }
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) {
    return 'ko';
  }
  if (/[\u0400-\u04ff]/.test(text)) {
    return 'ru';
  }
  if (/[\u0600-\u06ff]/.test(text)) {
    return 'ar';
  }
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) {
    return 'zh';
  }
  return 'en';
}

// ---------- 纯 JS MD5（百度签名用；对拍 crypto.createHash('md5') 验证） ----------

/** MD5 轮常量 K[i] = floor(abs(sin(i+1)) * 2^32) */
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** 各轮移位量 */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** UTF-8 编码（Hermes 无 TextEncoder，手动码点遍历，兼容增补平面） */
export function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i += 1) {
    const code = str.codePointAt(i) as number;
    if (code > 0xffff) {
      i += 1; // 代理对占两个 UTF-16 单元
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** MD5 摘要（小写 32 位 hex） */
export function md5Hex(input: string): string {
  const bytes = utf8Encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  // 64 位小端长度（本场景 bitLen 远小于 2^32，高位直接算）
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Int32Array(16);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let j = 0; j < 16; j += 1) {
      M[j] = dv.getInt32(off + j * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = MD5_S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------- 通用请求工具 ----------

/** fetch + 超时 + JSON 解析（非 2xx 抛出含状态码的错误） */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    let json: unknown = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${json ? `：${JSON.stringify(json).slice(0, 200)}` : ''}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** form-urlencoded 编码（RFC 3986 保留字符，百度要求 UTF-8 百分号编码） */
function urlencode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ---------- 三家适配器（内部统一返回原文语种代码 + 译文） ----------

/** DeepL 语种映射（target：ZH 简体；source 检测交由服务端） */
function deeplTarget(target: 'zh' | 'en'): string {
  return target === 'zh' ? 'ZH' : 'EN';
}

async function translateDeepL(
  text: string,
  target: 'zh' | 'en',
  apiKey: string,
): Promise<TranslationResult> {
  const endpoint = apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const json = (await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text], target_lang: deeplTarget(target) }),
  })) as { translations?: Array<{ detected_source_lang?: string; text?: string }> };

  const first = json.translations?.[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error('DeepL 返回数据异常');
  }
  return {
    text: first.text,
    sourceLang: first.detected_source_lang?.toLowerCase(),
    targetLang: deeplTarget(target),
    provider: 'deepl',
  };
}

async function translateGoogle(
  text: string,
  target: 'zh' | 'en',
  apiKey: string,
): Promise<TranslationResult> {
  const targetCode = target === 'zh' ? 'zh-CN' : 'en';
  const json = (await fetchJson(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target: targetCode, format: 'text' }),
    },
  )) as { data?: { translations?: Array<{ detectedSourceLanguage?: string; translatedText?: string }> } };

  const first = json.data?.translations?.[0];
  if (!first || typeof first.translatedText !== 'string') {
    throw new Error('Google 返回数据异常');
  }
  return {
    text: first.translatedText,
    sourceLang: first.detectedSourceLanguage,
    targetLang: targetCode,
    provider: 'google',
  };
}

/** 百度语种代码映射（通用翻译标准版） */
function baiduTarget(target: 'zh' | 'en'): string {
  return target === 'zh' ? 'zh' : 'en';
}

async function translateBaidu(
  text: string,
  target: 'zh' | 'en',
  appId: string,
  secretKey: string,
): Promise<TranslationResult> {
  const salt = String(Date.now());
  const sign = md5Hex(appId + text + salt + secretKey);
  const json = (await fetchJson('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlencode({ q: text, from: 'auto', to: baiduTarget(target), appid: appId, salt, sign }),
  })) as {
    trans_result?: Array<{ dst?: string }>;
    from?: string;
    to?: string;
    error_code?: string;
    error_msg?: string;
  };

  if (json.error_code) {
    throw new Error(`百度错误 ${json.error_code}：${json.error_msg ?? '未知'}`);
  }
  const dst = json.trans_result?.map((r) => r.dst ?? '').join('\n');
  if (!dst) {
    throw new Error('百度返回数据异常');
  }
  return {
    text: dst,
    sourceLang: json.from,
    targetLang: json.to ?? baiduTarget(target),
    provider: 'baidu',
  };
}

// ---------- 离线翻译路由（Android ML Kit） ----------

/** 缓存写入统一入口：超限淘汰最早写入的一条 */
function putTranslationCache(key: string, result: TranslationResult): void {
  if (translationCache.size >= TRANSLATION_CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) {
      translationCache.delete(oldest);
    }
  }
  translationCache.set(key, result);
}

/**
 * 尝试设备端离线翻译（ensureModel → nativeTranslate）。
 * 任一步失败（UNSUPPORTED_LANGUAGE / 模型下载失败 / 翻译失败）返回 null，
 * 由调用方自动回落在线服务商。
 */
async function tryOfflineTranslate(
  text: string,
  from: DetectedLang,
  to: 'zh' | 'en',
): Promise<TranslationResult | null> {
  const sourceTag = ML_KIT_TAG_BY_LANG[from];
  const targetTag = ML_KIT_TAG_BY_TARGET[to];
  if (!sourceTag || !targetTag || sourceTag === targetTag) {
    return null;
  }
  try {
    const ready = await ensureModel(sourceTag, targetTag);
    if (!ready) {
      return null;
    }
    const translated = await nativeTranslate(text, sourceTag, targetTag);
    if (!translated) {
      return null;
    }
    return {
      text: translated,
      sourceLang: from,
      targetLang: to,
      provider: 'offline',
    };
  } catch {
    // 离线失败静默回落在线（未配置在线时由调用方给出明确错误）
    return null;
  }
}

// ---------- 对外入口 ----------

/** 校验 provider 配置完整性，缺失返回错误文案（null = 就绪） */
function checkConfig(provider: TranslationProviderId, settings: TranslationSettings): string | null {
  switch (provider) {
    case 'deepl':
      return settings.deeplApiKey.trim() ? null : '未配置 DeepL API Key（我的 → 翻译设置 中录入）';
    case 'google':
      return settings.googleApiKey.trim() ? null : '未配置 Google API Key（我的 → 翻译设置 中录入）';
    case 'baidu':
      if (!settings.baiduAppId.trim() || !settings.baiduSecretKey.trim()) {
        return '未配置百度 APP ID / 密钥（我的 → 翻译设置 中录入）';
      }
      return null;
    default:
      return '未知的翻译服务商';
  }
}

/**
 * 自动翻译入口：
 * - 源语言由 provider 服务端检测（本地粗判仅用于选默认目标语言）
 * - target 缺省：源为中文 → 译英文，否则 → 译中文
 */
export async function translateAuto(
  text: string,
  settings: TranslationSettings,
  target?: 'zh' | 'en',
): Promise<ServiceResult<TranslationResult>> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { success: false, error: '没有可翻译的内容' };
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    return { success: false, error: `选段过长（${trimmed.length} 字符，上限 ${MAX_TEXT_CHARS}），请缩小选区` };
  }
  const from = detectLang(trimmed);
  const to = target ?? (from === 'zh' ? 'en' : 'zh');

  // ---- 离线路由：preferOffline 且原生模块可用时先走设备端翻译（独立缓存 key） ----
  let offlineAttempted = false;
  if (settings.preferOffline && isNativeAvailable()) {
    offlineAttempted = true;
    const offlineKey = `offline|${from}>${to}|${trimmed}`;
    const cachedOffline = translationCache.get(offlineKey);
    if (cachedOffline) {
      return { success: true, data: cachedOffline };
    }
    const offlineResult = await tryOfflineTranslate(trimmed, from, to);
    if (offlineResult) {
      putTranslationCache(offlineKey, offlineResult);
      return { success: true, data: offlineResult };
    }
    // 离线任一步失败 → 落入下方在线路径
  }

  // ---- 在线路径 ----
  const provider = settings.provider;
  // 百度按 UTF-8 字节限长（q ≤ 6000 字节，中文 3 字节/字，字符数上限不安全）
  if (provider === 'baidu') {
    const byteLen = utf8Encode(trimmed).length;
    if (byteLen > BAIDU_MAX_TEXT_BYTES) {
      return {
        success: false,
        error: `选段过长（${byteLen} 字节，百度通道上限 ${BAIDU_MAX_TEXT_BYTES} 字节 ≈ ${Math.floor(BAIDU_MAX_TEXT_BYTES / 3)} 汉字），请缩小选区`,
      };
    }
  }
  const configError = checkConfig(provider, settings);
  if (configError) {
    if (offlineAttempted) {
      return {
        success: false,
        error: `离线翻译不可用且未配置在线服务商：${configError}`,
      };
    }
    return { success: false, error: configError };
  }

  // 缓存命中直接返回（重复选段不重复计费/请求）
  const cacheKey = `${provider}|${from}>${to}|${trimmed}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    return { success: true, data: cached };
  }

  try {
    let result: TranslationResult;
    if (provider === 'deepl') {
      result = await translateDeepL(trimmed, to, settings.deeplApiKey.trim());
    } else if (provider === 'google') {
      result = await translateGoogle(trimmed, to, settings.googleApiKey.trim());
    } else {
      // 百度 QPS=1：客户端串行限流后再发请求
      result = await runBaiduSerialized(() =>
        translateBaidu(trimmed, to, settings.baiduAppId.trim(), settings.baiduSecretKey.trim()),
      );
    }
    // 仅缓存成功结果
    putTranslationCache(cacheKey, result);
    return { success: true, data: result };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? '请求超时，请检查网络后重试' : (e as Error).message;
    return { success: false, error: `翻译失败：${msg}` };
  }
}

export const TranslationService = {
  detectLang,
  translateAuto,
};

export default TranslationService;
