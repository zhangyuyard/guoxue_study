/**
 * PhraseMatcher.mm — iOS 词语拼音词典加载与正向最大匹配标注实现。
 *
 * 实现要点（对齐 JS computePhraseOverlay 与 Android PhraseMatcher.kt）：
 * - 词典分片在 init 时于私有串行后台队列 dispatch_async 加载，
 *   不阻塞 JS 线程；加载完成前 isLoaded 返回 NO、match 返回 []
 * - 分片路径：mainBundle 中 phrase-pinyin/part-%03d.json（part-000 …）
 *   首个分片缺失视为无数据（空词典，loaded=YES）；其余缺失视为分片结束
 * - 合并策略：NSMutableDictionary 逐文件 merge，后载入的分片覆盖同名键
 * - 线程安全：词典仅在串行队列、_loaded 翻转为 YES 之前被写入；
 *   翻转后词典只读，JS 线程读取安全。_loaded 用 atomic 属性 + 串行队列保护
 * - match 算法：按组合字符序列（codepoint 单元）切分；对每个 CJK 字符
 *   由长到短（min(8,剩余) → 2）尝试命中词典，命中则按空格拆分拼音音节并
 *   逐字发射 [index, syllable]，指针整体前移 len；否则单字前进
 *
 * 注意：本机无 Xcode，未做编译验证；Objective-C 逻辑与契约已对齐。
 */
#import "PhraseMatcher.h"

#import <React/RCTLog.h>
#import <React/RCTUtils.h>

/** 词典分片所在 bundle 子目录名（match / isLoaded 经 inDirectory: 读取） */
static NSString * const kPhrasePinyinDir = @"phrase-pinyin";
/** 单个分片文件名模板：part-000.json … */
static NSString * const kShardNameFmt = @"part-%03d";
/** 正向最大匹配的最大词长（与 JS / Android 一致） */
static const NSUInteger kMaxPhraseLen = 8;

/** 取组合字符单元（可能为代理对）的真实 Unicode codepoint（UTF-32） */
static inline UTF32Char codepointOf(NSString *unit) {
  if (unit.length >= 2) {
    unichar hi = [unit characterAtIndex:0];
    unichar lo = [unit characterAtIndex:1];
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) {
      // 高位代理 + 低位代理 → 补充平面 codepoint
      return (UTF32Char)(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00));
    }
    return (UTF32Char)hi;
  }
  return (UTF32Char)[unit characterAtIndex:0];
}

/** 判断 codepoint 是否属于 CJK 字符范围（与 JS isCJKChar 完全一致） */
static inline BOOL isCJKChar(UTF32Char cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) ||
         (cp >= 0x3400 && cp <= 0x4dbf) ||
         (cp >= 0x20000 && cp <= 0x2a6df) ||
         (cp >= 0x2a700 && cp <= 0x2ebef);
}

@interface PhraseMatcher ()

/** 已加载的短语-拼音词典（仅在加载串行队列写入，loaded 翻转后只读） */
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *dict;
/** 加载完成标志（加载完成于串行队列翻转；读取来自 JS 线程，atomic 保证可见性） */
@property (atomic, assign) BOOL loaded;
/** 私有串行后台队列，用于词典加载 */
@property (nonatomic, strong) dispatch_queue_t loadQueue;

@end

@implementation PhraseMatcher

RCT_EXPORT_MODULE(PhraseMatcher)

- (instancetype)init {
  if (self = [super init]) {
    _dict = [NSMutableDictionary dictionary];
    _loaded = NO;
    _loadQueue = dispatch_queue_create("com.guoxue.studyapp.phrase.loader",
                                       DISPATCH_QUEUE_SERIAL);
    [self startLoading];
  }
  return self;
}

#pragma mark - Loading

/** 在私有串行后台队列异步加载所有词典分片 */
- (void)startLoading {
  dispatch_async(self.loadQueue, ^{
    NSMutableDictionary<NSString *, NSString *> *merged =
        [NSMutableDictionary dictionary];
    NSInteger i = 0;
    BOOL ended = NO;
    while (!ended) {
      NSString *name =
          [NSString stringWithFormat:kShardNameFmt, (int)i];
      NSString *path = [[NSBundle mainBundle] pathForResource:name
                                                       ofType:@"json"
                                                  inDirectory:kPhrasePinyinDir];
      if (path == nil) {
        if (i == 0) {
          // 首个分片缺失：无数据，空词典直接标记完成
          RCTLogInfo(@"[PhraseMatcher] 未找到词典分片，使用空词典");
        } else {
          // 其余缺失：分片结束
          RCTLogInfo(@"[PhraseMatcher] 词典分片加载至 part-%03d 结束", (int)(i - 1));
        }
        ended = YES;
        break;
      }
      NSData *data = [NSData dataWithContentsOfFile:path];
      if (data != nil) {
        NSError *err = nil;
        NSDictionary *shard =
            [NSJSONSerialization JSONObjectWithData:data
                                           options:0
                                             error:&err];
        if (err == nil && [shard isKindOfClass:[NSDictionary class]]) {
          [merged addEntriesFromDictionary:shard];
        } else {
          RCTLogInfo(@"[PhraseMatcher] 分片 %@ 解析失败: %@", name,
                     err.localizedDescription);
        }
      }
      i += 1;
    }
    // 写入词典后，原子翻转 loaded（此后词典只读，JS 线程读取安全）
    self.dict = merged;
    self.loaded = YES;
    RCTLogInfo(@"[PhraseMatcher] 词典加载完成，共 %lu 条",
               (unsigned long)merged.count);
  });
}

#pragma mark - Exported methods (blocking synchronous)

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(isLoaded) {
  return @(self.loaded);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(match:(NSString *)text) {
  // 未加载完成返回空数组（JS 侧会回退到 JS 路径）
  if (!self.loaded || text.length == 0) {
    return @[];
  }

  NSMutableArray<NSArray *> *result = [NSMutableArray array];

  // 按组合字符序列切分为 codepoint 单元，并记录各自起始索引
  NSMutableArray<NSString *> *units = [NSMutableArray array];
  NSMutableArray<NSNumber *> *unitIndices = [NSMutableArray array];
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length)
                           options:NSStringEnumerationByComposedCharacterSequences
                        usingBlock:^(NSString *substring,
                                     NSRange substringRange,
                                     NSRange enclosingRange,
                                     BOOL *stop) {
    [units addObject:substring];
    [unitIndices addObject:@(substringRange.location)];
  }];

  NSUInteger count = units.count;
  NSUInteger i = 0;
  while (i < count) {
    NSString *unit = units[i];
    // 取组合字符单元的真实 codepoint 判断是否为 CJK（含补充平面代理对）
    UTF32Char cp = codepointOf(unit);
    if (!isCJKChar(cp)) {
      i += 1;
      continue;
    }
    BOOL hit = NO;
    NSUInteger maxLen = MIN(kMaxPhraseLen, count - i);
    for (NSUInteger len = maxLen; len >= 2; len -= 1) {
      // 拼接 units[i .. i+len-1]
      NSMutableString *phrase = [NSMutableString string];
      for (NSUInteger j = 0; j < len; j += 1) {
        [phrase appendString:units[i + j]];
      }
      NSString *pinyin = self.dict[phrase];
      if (pinyin != nil) {
        NSArray<NSString *> *syllables =
            [pinyin componentsSeparatedByCharactersInSet:
                        [NSCharacterSet whitespaceCharacterSet]];
        for (NSUInteger j = 0; j < len; j += 1) {
          if (j < syllables.count && syllables[j].length > 0) {
            // 返回码点下标（与 Android / JS Array.from 下标严格对齐）
            [result addObject:@[ @(i + j), syllables[j] ]];
          }
        }
        i += len;
        hit = YES;
        break;
      }
    }
    if (!hit) {
      i += 1;
    }
  }
  return result;
}

@end
