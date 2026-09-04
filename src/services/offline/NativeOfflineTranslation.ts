/**
 * ML Kit 离线翻译原生模块封装（services/offline/NativeOfflineTranslation）
 *
 * - 在 Android / iOS 且 NativeModules.OfflineTranslation 已注册时可用：
 *   Android 为 ML Kit translate（com.guoxue.studyapp.offlinetranslation），
 *   iOS 为 ML Kit translate（ios/guoxue_study_app/OfflineTranslationModule），
 *   两侧同名三方法 + 同名错误码，契约一致
 * - 语言 tag 使用 ML Kit 支持列表白名单（BCP-47 主子标签），非法 tag 快速失败
 * - 原生侧 reject 的错误统一归一为 { code, message } 结构
 */

import { NativeModules, Platform } from 'react-native';

/** ML Kit 翻译支持的语言 tag 白名单（至少覆盖本项目使用的 en/zh/ja/ko/ru/ar） */
export const ML_KIT_LANGUAGE_TAGS = [
  'en',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
  'pt',
  'it',
  'ar',
  'th',
  'vi',
  'id',
  'tr',
  'hi',
] as const;

export type MlKitLanguageTag = (typeof ML_KIT_LANGUAGE_TAGS)[number];

/** 原生模块错误（reject 归一结构） */
export interface NativeTranslationError {
  code: string;
  message: string;
}

/** 原生 OfflineTranslation 模块接口（与 Kotlin @ReactMethod 签名一一对应） */
interface OfflineTranslationNativeModule {
  isModelDownloaded(sourceTag: string, targetTag: string): Promise<boolean>;
  ensureModel(sourceTag: string, targetTag: string): Promise<boolean>;
  translate(text: string, sourceTag: string, targetTag: string): Promise<string>;
}

/** 动态读取原生模块：仅 Android / iOS 读取，其他平台恒为 undefined；测试可注入 NativeModules.OfflineTranslation */
function getNativeModule(): OfflineTranslationNativeModule | undefined {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return undefined;
  }
  return (NativeModules as unknown as { OfflineTranslation?: OfflineTranslationNativeModule })
    .OfflineTranslation;
}

/** 离线翻译原生模块是否可用（Android / iOS 且原生包已注册） */
export function isNativeAvailable(): boolean {
  return getNativeModule() !== undefined;
}

/** 语言 tag 是否在 ML Kit 支持白名单内 */
function isSupportedTag(tag: string): boolean {
  return (ML_KIT_LANGUAGE_TAGS as readonly string[]).includes(tag);
}

/** 将原生侧 reject 的任意错误归一为 { code, message } */
function normalizeError(e: unknown, fallbackCode: string): NativeTranslationError {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    const message = (e as { message?: unknown }).message;
    return {
      code: typeof code === 'string' && code ? code : fallbackCode,
      message: typeof message === 'string' && message ? message : '离线翻译原生模块调用失败',
    };
  }
  return { code: fallbackCode, message: String(e ?? '离线翻译原生模块调用失败') };
}

/** 前置校验：模块可用 + 语言 tag 在白名单内；不满足抛出归一错误 */
function requireNative(sourceTag: string, targetTag: string): OfflineTranslationNativeModule {
  const mod = getNativeModule();
  if (!mod) {
    throw { code: 'NATIVE_UNAVAILABLE', message: '离线翻译原生模块不可用' };
  }
  if (!isSupportedTag(sourceTag) || !isSupportedTag(targetTag)) {
    throw { code: 'UNSUPPORTED_LANGUAGE', message: `不支持的语言：${sourceTag} → ${targetTag}` };
  }
  return mod;
}

/** 两个语言模型是否均已下载（不触发下载） */
export async function isModelDownloaded(
  sourceTag: string,
  targetTag: string,
): Promise<boolean> {
  const mod = requireNative(sourceTag, targetTag);
  try {
    return await mod.isModelDownloaded(sourceTag, targetTag);
  } catch (e) {
    throw normalizeError(e, 'MODEL_DOWNLOAD_FAILED');
  }
}

/** 按需下载缺失的语言模型（已下载时立即返回 true） */
export async function ensureModel(sourceTag: string, targetTag: string): Promise<boolean> {
  const mod = requireNative(sourceTag, targetTag);
  try {
    return await mod.ensureModel(sourceTag, targetTag);
  } catch (e) {
    throw normalizeError(e, 'MODEL_DOWNLOAD_FAILED');
  }
}

/** 设备端离线翻译，返回译文 */
export async function nativeTranslate(
  text: string,
  sourceTag: string,
  targetTag: string,
): Promise<string> {
  const mod = requireNative(sourceTag, targetTag);
  try {
    return await mod.translate(text, sourceTag, targetTag);
  } catch (e) {
    throw normalizeError(e, 'TRANSLATE_FAILED');
  }
}
