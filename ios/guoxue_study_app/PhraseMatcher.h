/**
 * PhraseMatcher — iOS 词语拼音词典加载 + 正向最大匹配标注模块（旧架构）。
 *
 * 对应方案 3d 的 iOS 一半：将短语-拼音词典的加载与「正向最大匹配」标注算法
 * 从 JS 线程迁移到原生 iOS 模块，消除冷启动时 JS 线程上约 34.8s 的冻结。
 *
 * 对齐 Android com.guoxue.studyapp.phrase.PhraseMatcher 契约：
 * JS 侧经 NativeModules.PhraseMatcher 访问：
 * - isLoaded()：词典是否已在后台线程构建完成（阻塞同步方法，返回 Boolean）
 * - match(text)：对 codepoint 对齐的逻辑字符串做正向最大匹配，返回
 *   @[ @(index), syllable ] 形式的数对数组；
 *   未加载完成则返回空数组 []
 *
 * 编译进 App target 后经 RCT_EXPORT_MODULE 的 +load 自动注册（旧架构
 * RCTRegisterModule 运行时扫描），无需在 AppDelegate 手动登记。
 *
 * 数据：词典分片位于 App 主 bundle 的 phrase-pinyin/ 子目录
 * （part-000.json … part-037.json，共 38 个，179406 条），
 * 运行时由本模块从 bundle 读取并合并。
 */
#import <Foundation/Foundation.h>

#import <React/RCTBridgeModule.h>

@interface PhraseMatcher : NSObject <RCTBridgeModule>

@end
