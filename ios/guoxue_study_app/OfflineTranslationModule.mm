/**
 * OfflineTranslationModule.mm — iOS ML Kit 离线翻译实现。
 *
 * 实现要点（对齐 Android OfflineTranslationModule.kt）：
 * - 全部 ML Kit 调用派发到专用串行队列（等价 Android 单线程 Executor），
 *   信号量等待只在后台队列上进行，绝不阻塞主线程
 * - 同一语言对的模型查询/下载经串行队列 + 语言对锁互斥（等价 Android 语言对锁）
 * - MLKTranslateLanguage 在 iOS 上是 NSString typedef（NS_TYPED_ENUM），
 *   语言 tag 校验 = 在 MLKTranslateAllLanguages() 集合中匹配
 *   （先整 tag 匹配，再退回 BCP-47 主子标签，等价 Android
 *   TranslateLanguage.fromLanguageTag 的行为）；命中后使用集合中的
 *   规范值参与后续调用
 * - 模型状态查询：MLKModelManager isModelDownloaded:（同步 BOOL）+
 *   downloadedTranslateModels 属性；模型下载：MLKTranslator 的
 *   downloadModelIfNeededWithConditions:completion:（同时确保源/目标模型）
 * - 网络等待上限 60s，超时按对应错误码 reject
 */
#import "OfflineTranslationModule.h"

#import <MLKitCommon/MLKitCommon.h>
#import <MLKitTranslate/MLKitTranslate.h>
#import <React/RCTLog.h>
#import <React/RCTUtils.h>

/** Tasks.await 等价超时（秒）：语言模型约 30MB，留足余量 */
static const NSTimeInterval kModelAwaitTimeoutSeconds = 60.0;

static NSString * const kErrorUnsupportedLanguage = @"UNSUPPORTED_LANGUAGE";
static NSString * const kErrorModelDownloadFailed = @"MODEL_DOWNLOAD_FAILED";
static NSString * const kErrorTranslateFailed = @"TRANSLATE_FAILED";

@implementation OfflineTranslation {
  /** 串行执行 ML Kit 调用的专用队列（禁止在主线程做信号量等待） */
  dispatch_queue_t _workQueue;
  /** 语言对 → 互斥锁（避免并发重复下载同一模型） */
  NSMutableDictionary<NSString *, NSLock *> *_downloadLocks;
  /** 支持语言集合（懒加载缓存，集合内容运行期不变） */
  NSSet<MLKTranslateLanguage> *_allLanguages;
}

RCT_EXPORT_MODULE(OfflineTranslation)

- (instancetype)init {
  if (self = [super init]) {
    _workQueue = dispatch_queue_create("com.guoxue.studyapp.offlinetranslation",
                                       DISPATCH_QUEUE_SERIAL);
    _downloadLocks = [NSMutableDictionary dictionary];
    _allLanguages = MLKTranslateAllLanguages();
  }
  return self;
}

- (void)invalidate {
  // 旧架构桥销毁回调：GCD 队列无需显式释放，仅清理锁表
  [_downloadLocks removeAllObjects];
}

#pragma mark - Internal helpers

/** 已缓存的支持语言集合（首次调用时懒加载） */
- (NSSet<MLKTranslateLanguage> *)allLanguages {
  if (_allLanguages == nil) {
    _allLanguages = MLKTranslateAllLanguages();
  }
  return _allLanguages;
}

/**
 * 语言 tag → MLKTranslateLanguage（NSString 规范值）。
 * 先整 tag 匹配，再退回 BCP-47 主子标签（如 zh-CN → zh）；
 * 非法时 reject（UNSUPPORTED_LANGUAGE）并返回 nil。
 */
- (MLKTranslateLanguage )resolveLanguageTag:(NSString *)tag
                                     promise:(RCTPromiseResolveBlock)resolve
                                    rejecter:(RCTPromiseRejectBlock)reject {
  NSString *normalized = [tag stringByTrimmingCharactersInSet:
    [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (normalized.length == 0) {
    reject(kErrorUnsupportedLanguage, @"Unsupported language tag: empty string", nil);
    return nil;
  }
  NSSet<MLKTranslateLanguage> *all = [self allLanguages];
  // 1) 整 tag 匹配（大小写不敏感）
  for (MLKTranslateLanguage lang in all) {
    if ([lang caseInsensitiveCompare:normalized] == NSOrderedSame) {
      return lang;
    }
  }
  // 2) BCP-47 主子标签回退（zh-CN → zh）
  NSRange hyphen = [normalized rangeOfString:@"-"];
  if (hyphen.location != NSNotFound && hyphen.location > 0) {
    NSString *primary = [normalized substringToIndex:hyphen.location];
    for (MLKTranslateLanguage lang in all) {
      if ([lang caseInsensitiveCompare:primary] == NSOrderedSame) {
        return lang;
      }
    }
  }
  reject(kErrorUnsupportedLanguage,
         [NSString stringWithFormat:@"Unsupported language tag: %@", normalized], nil);
  return nil;
}

/** 语言对 → 互斥锁（不存在则创建，访问仅在串行队列内发生） */
- (NSLock *)lockForLanguagePair:(NSString *)pair {
  NSLock *lock = _downloadLocks[pair];
  if (lock == nil) {
    lock = [[NSLock alloc] init];
    _downloadLocks[pair] = lock;
  }
  return lock;
}

/** 单个语言模型是否已下载（同步查询，需在后台队列调用） */
- (BOOL)isModelDownloaded:(MLKTranslateLanguage )language {
  MLKModelManager *modelManager = [MLKModelManager modelManager];
  MLKTranslateRemoteModel *model = [MLKTranslateRemoteModel translateRemoteModelWithLanguage:language];
  if (model == nil) {
    return NO;
  }
  return [modelManager isModelDownloaded:model];
}

/** 两个语言模型是否均已下载 */
- (BOOL)bothModelsDownloaded:(MLKTranslateLanguage )sourceLang
                  targetLang:(MLKTranslateLanguage )targetLang {
  return [self isModelDownloaded:sourceLang] && [self isModelDownloaded:targetLang];
}

/**
 * 确保源/目标语言模型就绪（已下载立即返回 YES，缺失时触发下载并等待完成）。
 * 信号量等待发生在专用后台队列上（completion 回调在主队列），不阻塞主线程。
 */
- (BOOL)ensureModelsForTranslator:(MLKTranslator *)translator error:(NSError **)error {
  MLKModelDownloadConditions *conditions = [[MLKModelDownloadConditions alloc]
      initWithAllowsCellularAccess:YES allowsBackgroundDownloading:YES];
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSError *downloadError = nil;
  // downloadModelIfNeeded 同时确保源/目标两个语言模型各就绪一次；
  // 已存在时立即完成回调
  [translator downloadModelIfNeededWithConditions:conditions
                                       completion:^(NSError *completionError) {
    downloadError = completionError;
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW,
      (int64_t)(kModelAwaitTimeoutSeconds * NSEC_PER_SEC));
  if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
    if (error != nil) {
      *error = [NSError errorWithDomain:kErrorModelDownloadFailed
                                   code:-1
                               userInfo:@{NSLocalizedDescriptionKey:
                               @"Model download timed out"}];
    }
    return NO;
  }
  if (downloadError != nil) {
    if (error != nil) {
      *error = downloadError;
    }
    return NO;
  }
  return YES;
}

#pragma mark - Exported methods

RCT_EXPORT_METHOD(isModelDownloaded:(NSString *)sourceTag
                  targetTag:(NSString *)targetTag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_workQueue, ^{
    MLKTranslateLanguage sourceLang =
        [self resolveLanguageTag:sourceTag promise:resolve rejecter:reject];
    if (sourceLang == nil) {
      return;
    }
    MLKTranslateLanguage targetLang =
        [self resolveLanguageTag:targetTag promise:resolve rejecter:reject];
    if (targetLang == nil) {
      return;
    }
    resolve(@([self bothModelsDownloaded:sourceLang targetLang:targetLang]));
  });
}

RCT_EXPORT_METHOD(ensureModel:(NSString *)sourceTag
                  targetTag:(NSString *)targetTag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_workQueue, ^{
    MLKTranslateLanguage sourceLang =
        [self resolveLanguageTag:sourceTag promise:resolve rejecter:reject];
    if (sourceLang == nil) {
      return;
    }
    MLKTranslateLanguage targetLang =
        [self resolveLanguageTag:targetTag promise:resolve rejecter:reject];
    if (targetLang == nil) {
      return;
    }
    NSLock *lock = [self lockForLanguagePair:
        [NSString stringWithFormat:@"%@>%@", sourceLang, targetLang]];
    [lock lock];
    NSError *error = nil;
    BOOL ok = NO;
    if ([self bothModelsDownloaded:sourceLang targetLang:targetLang]) {
      ok = YES;
    } else {
      MLKTranslatorOptions *options =
          [[MLKTranslatorOptions alloc] initWithSourceLanguage:sourceLang
                                                targetLanguage:targetLang];
      MLKTranslator *translator = [MLKTranslator translatorWithOptions:options];
      ok = [self ensureModelsForTranslator:translator error:&error];
    }
    [lock unlock];
    if (ok) {
      resolve(@(YES));
    } else {
      reject(kErrorModelDownloadFailed,
             [NSString stringWithFormat:@"Failed to download translation model: %@",
              error.localizedDescription ?: @"unknown"], error);
    }
  });
}

RCT_EXPORT_METHOD(translate:(NSString *)text
                  sourceTag:(NSString *)sourceTag
                  targetTag:(NSString *)targetTag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_workQueue, ^{
    MLKTranslateLanguage sourceLang =
        [self resolveLanguageTag:sourceTag promise:resolve rejecter:reject];
    if (sourceLang == nil) {
      return;
    }
    MLKTranslateLanguage targetLang =
        [self resolveLanguageTag:targetTag promise:resolve rejecter:reject];
    if (targetLang == nil) {
      return;
    }
    MLKTranslatorOptions *options =
        [[MLKTranslatorOptions alloc] initWithSourceLanguage:sourceLang
                                                targetLanguage:targetLang];
    MLKTranslator *translator = [MLKTranslator translatorWithOptions:options];

    // 模型缺失时先确保下载（已下载则立即完成），再执行翻译
    NSError *modelError = nil;
    if (![self ensureModelsForTranslator:translator error:&modelError]) {
      reject(kErrorTranslateFailed,
             [NSString stringWithFormat:@"Offline translation failed: %@",
              modelError.localizedDescription ?: @"model not ready"], modelError);
      return;
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSString *translated = nil;
    __block NSError *translateError = nil;
    [translator translateText:text ?: @"" completion:^(NSString *result, NSError *error) {
      translated = result;
      translateError = error;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW,
        (int64_t)(kModelAwaitTimeoutSeconds * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
      reject(kErrorTranslateFailed, @"Offline translation failed: timed out", nil);
      return;
    }
    if (translateError != nil) {
      reject(kErrorTranslateFailed,
             [NSString stringWithFormat:@"Offline translation failed: %@",
              translateError.localizedDescription], translateError);
      return;
    }
    resolve(translated ?: [NSString string]);
  });
}

@end
