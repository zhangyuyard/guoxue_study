/**
 * 翻译相关类型（types/translation.ts）
 * P0 在线翻译：Provider 适配器接口 + 用户自带 key 的配置 + 翻译结果。
 * 离线翻译（ML Kit / Translation 框架）为 P1，后续以 provider 形式扩展。
 */

/** 支持的在线翻译服务商 */
export type TranslationProviderId = 'deepl' | 'google' | 'baidu';

/** 服务商展示信息 */
export const TRANSLATION_PROVIDERS: Array<{
  id: TranslationProviderId;
  label: string;
  /** key 录入说明 */
  keyHint: string;
}> = [
  {
    id: 'deepl',
    label: 'DeepL',
    keyHint: 'DeepL API Key（以 :fx 结尾为免费版，自动切换 free 端点）',
  },
  {
    id: 'google',
    label: 'Google',
    keyHint: 'Google Cloud Translation API Key（Cloud Translation - Basic）',
  },
  {
    id: 'baidu',
    label: '百度',
    keyHint: '百度翻译开放平台 APP ID + 密钥（通用翻译标准版）',
  },
];

/** 用户自带的翻译服务凭证（经 useSettingsStore 持久化） */
export interface TranslationSettings {
  provider: TranslationProviderId;
  deeplApiKey: string;
  googleApiKey: string;
  baiduAppId: string;
  baiduSecretKey: string;
  /** 优先离线翻译（Android ML Kit 设备端模型；不可用时自动回落在线服务） */
  preferOffline: boolean;
}

/** 默认配置（全部留空 = 未配置，翻译时给出友好提示；离线翻译默认关闭） */
export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  provider: 'deepl',
  deeplApiKey: '',
  googleApiKey: '',
  baiduAppId: '',
  baiduSecretKey: '',
  preferOffline: false,
};

/** 语种粗判结果（Unicode 区段推断，仅用于选目标语言） */
export type DetectedLang = 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'en';

/** 翻译结果 */
export interface TranslationResult {
  /** 译文 */
  text: string;
  /** 源语言（服务端检测或本地粗判） */
  sourceLang?: string;
  /** 目标语种（服务端代码） */
  targetLang: string;
  /** 实际使用的服务商（'offline' = Android ML Kit 设备端离线翻译，展示名「离线（设备内置）」） */
  provider: TranslationProviderId | 'offline';
}
