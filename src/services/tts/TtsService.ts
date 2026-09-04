/**
 * 正文朗读服务（TtsService，P2-02）
 * 封装原生 TTS 模块（Android: com.guoxue.studyapp.tts.TtsModule，名字 "Tts"；
 * iOS: ios/guoxue_study_app/TtsModule，AVSpeechSynthesizer 实现，同名 "Tts"）：
 * - isTtsAvailable()：TTS 引擎是否可用
 * - speakText(text, rate)：以指定语速朗读中文文本（rate 0.5–2.0）
 * - stopSpeech()：停止朗读
 * - onSpeechFinish / onSpeechError：朗读完成 / 失败事件订阅（原生经
 *   RCTDeviceEventEmitter 发出，JS 用 DeviceEventEmitter 接收）
 *
 * iOS 侧 AVSpeechSynthesizer 已实现并编译验证；语速经分段线性映射到
 * AVSpeechUtterance 语速范围，事件名与错误码与 Android 对齐。
 */
import { DeviceEventEmitter, NativeModules } from 'react-native';

import { cleanSpeechText, clampSpeechRate } from '@/utils/speech';

/** 原生模块接口（Android TtsModule 桥接） */
interface TtsNativeModule {
  /** 查询 TTS 引擎是否初始化成功（resolve Boolean） */
  isAvailable(): Promise<boolean>;
  /**
   * 朗读中文文本（zh-CN）。rate 为 0.5–2.0 的语速系数；
   * 正在朗读时原生侧先 stop 再 speak（QUEUE_FLUSH 语义）。
   * 成功 resolve true（朗读已入队，完成/失败经事件回调），
   * 失败 reject（code: TTS_INIT_FAILED / TTS_NOT_READY / TTS_SPEAK_FAILED）。
   */
  speak(text: string, rate: number): Promise<boolean>;
  /** 停止当前朗读（未在朗读时为幂等空操作） */
  stop(): void;
}

/** 动态读取原生模块（旧架构 Bridge，未注册时为 undefined；测试可注入 NativeModules.Tts） */
function getNativeTts(): TtsNativeModule | undefined {
  return (NativeModules as {
    Tts?: TtsNativeModule;
  }).Tts;
}

/** 原生完成事件名（与 TtsModule.kt 中 EVENT_FINISHED 一致） */
const EVENT_FINISHED = 'ttsFinished';
/** 原生失败事件名（与 TtsModule.kt 中 EVENT_ERROR 一致） */
const EVENT_ERROR = 'ttsError';

/** 朗读结果（ServiceResult 风格） */
export interface SpeakResult {
  success: boolean;
  error?: string;
}

/**
 * TTS 是否可用。
 * - Android / iOS：原生模块缺失（如旧安装包）或引擎初始化失败 → false
 */
export async function isTtsAvailable(): Promise<boolean> {
  if (!getNativeTts()) {
    return false;
  }
  try {
    return await getNativeTts()!.isAvailable();
  } catch {
    return false;
  }
}

/**
 * 朗读一段文本（内部完成语速夹取与文本清洗）。
 * 文本清洗后为空（纯空白/纯标记）时不发起朗读。
 */
export async function speakText(text: string, rate: number): Promise<SpeakResult> {
  if (!getNativeTts()) {
    return { success: false, error: '当前设备不支持语音朗读' };
  }
  const cleaned = cleanSpeechText(text);
  if (!cleaned) {
    return { success: false, error: '没有可朗读的文本' };
  }
  try {
    await getNativeTts()!.speak(cleaned, clampSpeechRate(rate));
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message ?? '朗读启动失败' };
  }
}

/** 停止朗读（幂等；未在朗读时为空操作） */
export function stopSpeech(): void {
  const tts = getNativeTts();
  if (tts) {
    try {
      tts.stop();
    } catch {
      // 原生侧异常（如模块已失效）时静默忽略
    }
  }
}

/** 订阅「朗读完成」事件；返回含 remove() 的订阅句柄 */
export function onSpeechFinish(cb: () => void): { remove: () => void } {
  const sub = DeviceEventEmitter.addListener(EVENT_FINISHED, cb);
  return { remove: () => sub.remove() };
}

/** 订阅「朗读失败」事件；返回含 remove() 的订阅句柄 */
export function onSpeechError(cb: () => void): { remove: () => void } {
  const sub = DeviceEventEmitter.addListener(EVENT_ERROR, cb);
  return { remove: () => sub.remove() };
}

export const TtsService = {
  isTtsAvailable,
  speakText,
  stopSpeech,
  onSpeechFinish,
  onSpeechError,
};

export default TtsService;
