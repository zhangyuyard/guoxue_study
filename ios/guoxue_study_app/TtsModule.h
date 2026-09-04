/**
 * TtsModule — iOS 正文朗读 Bridge 模块（旧架构）。
 *
 * 对齐 Android com.guoxue.studyapp.tts.TtsModule（名字 "Tts"）契约：
 * JS 侧经 NativeModules.Tts 访问：
 * - isAvailable()：TTS 引擎是否可用（resolve Boolean）
 * - speak(text, rate)：以 zh-CN 朗读，rate 为 0.5–2.0 语速系数（线性映射到
 *   AVSpeechUtteranceMinimumSpeechRate–MaximumSpeechRate）；
 *   正在朗读时先 stop 再 speak（QUEUE_FLUSH 语义）；
 *   朗读入队成功 resolve true，完成/失败经事件回调 JS
 * - stop()：停止当前朗读（幂等空操作）
 *
 * 事件（经 RCTEventEmitter → JS DeviceEventEmitter，与 Android 一致）：
 * - ttsFinished：朗读自然完成
 * - ttsError：朗读失败或被取消（Android stop 会触发 onError，语义对齐）
 *
 * 编译进 App target 后经 RCT_EXPORT_MODULE 的 +load 自动注册（旧架构
 * RCTRegisterModule 运行时扫描），无需在 AppDelegate 手动登记。
 */
#import <Foundation/Foundation.h>

#import <React/RCTEventEmitter.h>

@interface Tts : RCTEventEmitter <RCTBridgeModule>

@end
