/**
 * OfflineTranslationModule — iOS ML Kit 离线翻译 Bridge 模块（旧架构）。
 *
 * 对齐 Android com.guoxue.studyapp.offlinetranslation.OfflineTranslationModule 契约：
 * JS 侧经 NativeModules.OfflineTranslation 访问，三个 Promise 方法：
 * - isModelDownloaded(sourceTag, targetTag)：两个语言模型是否均已下载（resolve Boolean）
 * - ensureModel(sourceTag, targetTag)：按需下载缺失的语言模型，成功 resolve true，
 *   失败 reject（code: MODEL_DOWNLOAD_FAILED）
 * - translate(text, sourceTag, targetTag)：离线翻译，成功 resolve 译文，
 *   失败 reject（code: TRANSLATE_FAILED）
 * - 语言 tag 非法（MLKTranslateLanguage languageForLanguageTag 返回 nil）时
 *   reject（code: UNSUPPORTED_LANGUAGE）
 *
 * 编译进 App target 后经 RCT_EXPORT_MODULE 的 +load 自动注册（旧架构
 * RCTRegisterModule 运行时扫描），无需在 AppDelegate 手动登记。
 */
#import <Foundation/Foundation.h>

#import <React/RCTBridgeModule.h>

@interface OfflineTranslation : NSObject <RCTBridgeModule>

@end
