/**
 * TtsModule.mm — iOS AVSpeechSynthesizer 正文朗读实现。
 *
 * 实现要点（对齐 Android TtsModule.kt）：
 * - AVSpeechSynthesizer 惰性创建并复用，invalidate 时 stop + 释放
 * - 语速映射（RN 0.5–2.0 → AVSpeechRate 分段线性）：
 *   [0.5, 1.0] → [MinimumSpeechRate, DefaultSpeechRate]
 *   (1.0, 2.0] → (DefaultSpeechRate, MaximumSpeechRate]
 *   即 1.0 对应系统默认语速，与 Android setSpeechRate(1.0) 语义一致
 * - 中文语音固定 AVSpeechSynthesisVoice(language:@"zh-CN")，无匹配语音时
 *   speak 按 TTS_SPEAK_FAILED reject
 * - 事件经 RCTEventEmitter 发出，仅在 JS 已挂监听（hasListeners）时发送，
 *   supportedEvents 声明 ttsFinished / ttsError
 */
#import "TtsModule.h"

#import <AVFoundation/AVFoundation.h>
#import <React/RCTUtils.h>

/** 原生完成事件名（与 TtsModule.kt 中 EVENT_FINISHED 一致） */
static NSString * const kEventFinished = @"ttsFinished";
/** 原生失败事件名（与 TtsModule.kt 中 EVENT_ERROR 一致） */
static NSString * const kEventError = @"ttsError";

/** 语速范围（与 JS 侧 utils/speech.ts 保持一致） */
static const double kMinRate = 0.5;
static const double kMaxRate = 2.0;

@interface Tts () <AVSpeechSynthesizerDelegate>
@end

@implementation Tts {
  /** AVSpeechSynthesizer 实例（惰性创建，主队列访问） */
  AVSpeechSynthesizer *_synthesizer;
  /** JS 侧是否已挂事件监听（RCTEventEmitter 维护） */
  BOOL _hasListeners;
  /** 自增 utterance id（同一时刻至多一段朗读，仍保证 id 唯一便于排查） */
  NSUInteger _utteranceCounter;
}

RCT_EXPORT_MODULE(Tts)

- (instancetype)init {
  if (self = [super init]) {
    _utteranceCounter = 0;
  }
  return self;
}

- (void)dealloc {
  [_synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  _synthesizer.delegate = nil;
}

/** 惰性创建 AVSpeechSynthesizer（已创建直接复用） */
- (AVSpeechSynthesizer *)ensureSynthesizer {
  if (_synthesizer == nil) {
    _synthesizer = [[AVSpeechSynthesizer alloc] init];
    _synthesizer.delegate = self;
  }
  return _synthesizer;
}

/** RN 语速系数（0.5–2.0）→ AVSpeech 语速（分段线性映射） */
- (double)mappedRateForRate:(double)rate {
  double clamped = MIN(MAX(rate, kMinRate), kMaxRate);
  double minRate = AVSpeechUtteranceMinimumSpeechRate;
  double maxRate = AVSpeechUtteranceMaximumSpeechRate;
  double defaultRate = AVSpeechUtteranceDefaultSpeechRate;
  if (clamped <= 1.0) {
    // [0.5, 1.0] → [min, default]
    double t = (clamped - kMinRate) / (1.0 - kMinRate);
    return minRate + t * (defaultRate - minRate);
  }
  // (1.0, 2.0] → (default, max]
  double t = (clamped - 1.0) / (kMaxRate - 1.0);
  return defaultRate + t * (maxRate - defaultRate);
}

#pragma mark - Exported methods

RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  AVSpeechSynthesizer *synthesizer = [self ensureSynthesizer];
  if (synthesizer == nil) {
    reject(@"TTS_INIT_FAILED", @"Failed to create AVSpeechSynthesizer", nil);
    return;
  }
  // 引擎可用性以 zh-CN 语音是否存在为准（对齐 Android 引擎初始化成功语义）
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:@"zh-CN"];
  resolve(@(voice != nil));
}

RCT_EXPORT_METHOD(speak:(NSString *)text
                  rate:(double)rate
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  AVSpeechSynthesizer *synthesizer = [self ensureSynthesizer];
  if (synthesizer == nil) {
    reject(@"TTS_INIT_FAILED", @"Failed to create AVSpeechSynthesizer", nil);
    return;
  }
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:@"zh-CN"];
  if (voice == nil) {
    reject(@"TTS_SPEAK_FAILED", @"zh-CN language data is missing or unsupported", nil);
    return;
  }
  // 正在朗读时先 stop 再 speak（显式 stop，等价 Android QUEUE_FLUSH 双保险）
  if ([synthesizer isSpeaking]) {
    [synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  AVSpeechUtterance *utterance =
      [[AVSpeechUtterance alloc] initWithString:text ?: @""];
  utterance.voice = voice;
  utterance.rate = (float)[self mappedRateForRate:rate];
  _utteranceCounter += 1;
  // AVSpeechSynthesizer speakUtterance: 无返回值（异步入队）；
  // 完成/失败经 didFinish/didCancel 代理回调通知 JS
  [synthesizer speakUtterance:utterance];
  resolve(@(YES));
}

RCT_EXPORT_METHOD(stop) {
  if (_synthesizer != nil) {
    [_synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
}

#pragma mark - RCTEventEmitter

- (NSArray<NSString *> *)supportedEvents {
  return @[ kEventFinished, kEventError ];
}

- (void)startObserving {
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

/** 向 JS 发射事件（无监听时安全忽略） */
- (void)sendEventName:(NSString *)name body:(nullable id)body {
  if (_hasListeners) {
    [self sendEventWithName:name body:body];
  }
}

#pragma mark - AVSpeechSynthesizerDelegate

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
    didFinishSpeechUtterance:(AVSpeechUtterance *)utterance {
  [self sendEventName:kEventFinished body:nil];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
    willCancelSpeechUtterance:(AVSpeechUtterance *)utterance {
  // 取消语义对齐 Android：stop 触发 onError 回调（发 ttsError）
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
    didCancelSpeechUtterance:(AVSpeechUtterance *)utterance {
  [self sendEventName:kEventError body:nil];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
     didPauseSpeechUtterance:(AVSpeechUtterance *)utterance {
  // 未实现暂停/恢复能力，空实现以满足协议完整性
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
   didContinueSpeechUtterance:(AVSpeechUtterance *)utterance {
  // 未实现暂停/恢复能力，空实现以满足协议完整性
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
   willSpeakRangeOfSpeechString:(NSRange)characterRange
                      utterance:(AVSpeechUtterance *)utterance {
  // 高亮进度能力未启用，空实现以满足协议完整性
}

@end
