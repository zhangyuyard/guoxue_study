/**
 * 朗读（TTS）纯逻辑工具（speech）
 * 供 TtsService / 阅读页朗读控制使用的纯函数，无 React Native 依赖，可独立单测。
 */

/** 语速下限（Android setSpeechRate 合理范围） */
export const MIN_SPEECH_RATE = 0.5;
/** 语速上限 */
export const MAX_SPEECH_RATE = 2.0;
/** 语速步进（阅读页 −/+ 按钮步长） */
export const SPEECH_RATE_STEP = 0.25;

/** 数值夹取到 [MIN_SPEECH_RATE, MAX_SPEECH_RATE] */
export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return 1.0;
  }
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

/**
 * 语速步进：dir=+1 增 / -1 减，步长 0.25，结果夹取到合法范围，
 * 并按两位小数取整规避浮点累积误差。
 */
export function stepSpeechRate(rate: number, dir: 1 | -1): number {
  const next = clampSpeechRate(rate) + dir * SPEECH_RATE_STEP;
  return Math.round(clampSpeechRate(next) * 100) / 100;
}

/**
 * 清洗朗读文本：
 * - 去掉用户书解析管线的章节标记 @@CH@@（残余标记不应被朗读出来）
 * - 折叠连续空白（换行/多空格 → 单空格），去除首尾空白
 */
export function cleanSpeechText(text: string): string {
  return text.replace(/@@CH@@/g, '').replace(/\s+/g, ' ').trim();
}

export default {
  MIN_SPEECH_RATE,
  MAX_SPEECH_RATE,
  SPEECH_RATE_STEP,
  clampSpeechRate,
  stepSpeechRate,
  cleanSpeechText,
};
