/**
 * 全局类型定义
 * 覆盖：文本库模型、注音模型、用户数据模型（划线/笔记/收藏）、背诵模型、搜索模型、设置模型
 */

// ============ 字典域模型 ============
// （独立文件维护，此处统一 re-export 供 `@/types` 引用）
export * from './dict';

// ============ 文本库数据模型 ============

/** 书籍分类：经 / 史 / 子 / 集 */
export type BookCategory = 'jing' | 'shi' | 'zi' | 'ji' | 'user';

/** 经典书籍 */
export interface Book {
  /** 唯一 ID，如 "lunyu" */
  id: string;
  /** 书名，如 "论语" */
  title: string;
  /** 作者，如 "孔子弟子及再传弟子" */
  author: string;
  /** 分类 */
  category: BookCategory;
  /** 简介 */
  description: string;
  /** 章节列表 */
  chapters: Chapter[];
}

/** 章节 */
export interface Chapter {
  /** 如 "lunyu-xueer" */
  id: string;
  /** 所属书籍 ID */
  bookId: string;
  /** 如 "学而第一" */
  title: string;
  /** 章节顺序（1 起） */
  order: number;
  /** 段落列表 */
  segments: TextSegment[];
}

/** 文本段落（最小阅读单元） */
export interface TextSegment {
  /** 如 "lunyu-xueer-1" */
  id: string;
  /** 所属章节 ID */
  chapterId: string;
  /** 段落顺序（1 起） */
  order: number;
  /** 原文文本 */
  text: string;
}

// ============ 注音数据模型 ============

/** 单字注音结果 */
export interface PinyinAnnotation {
  /** 原字 */
  char: string;
  /** 拼音（含声调），如 "zǐ" */
  pinyin: string;
  /** 是否多音字 */
  isPolyphone: boolean;
  /** 是否生僻字 */
  isRare: boolean;
  /** 通假字信息（可选） */
  tongjia?: {
    /** 本字，如 "悦" */
    original: string;
    /** 说明，如 "通'悦'，喜悦" */
    note?: string;
    /** 出处（旧字段，保留向后兼容） */
    source?: string;
    /** 判定源列表（多源合并；canon 命中时优先使用） */
    sources?: string[];
    /** 是否经 canon 校验（true=权威校验；false=兜底/未校验） */
    verified?: boolean;
    /**
     * 命中的语料例句（canon v3 语境锚定）：标注仅在当前段落
     * 实际命中该例句时给出，可用于浮窗展示「例：不亦说乎」。
     */
    context?: string;
  };
  /** 异体字列表 */
  yiti?: string[];
  /** 语境读音源（多音字浮窗展示「读音源」） */
  readingSources?: string[];
  /** 语境读音是否经 canon 校验（false=系统默认·未校验） */
  readingVerified?: boolean;
}

/** 注音模式：全文注音 / 仅生僻字 / 关闭 */
export type PinyinMode = 'full' | 'rare' | 'off';

// ============ 用户数据模型 ============

/** 划线颜色 */
export type HighlightColor = 'yellow' | 'green' | 'blue';

/** 划线高亮 */
export interface Highlight {
  id: string;
  bookId: string;
  chapterId: string;
  segmentId: string;
  /** 文本起始偏移（相对 segment.text） */
  startOffset: number;
  /** 文本结束偏移 */
  endOffset: number;
  /** 划线颜色 */
  color: HighlightColor;
  /** 划线文本内容 */
  text: string;
  /** 关联笔记 ID（可选） */
  noteId?: string;
  /** ISO 8601 时间 */
  createdAt: string;
}

/** 文字笔记 */
export interface Note {
  id: string;
  bookId: string;
  chapterId: string;
  segmentId: string;
  startOffset: number;
  endOffset: number;
  /** 笔记内容（长文本） */
  content: string;
  /** 关联划线 ID（可选） */
  highlightId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 收藏类型 */
export type BookmarkType = 'article' | 'paragraph';

/** 收藏 */
export interface Bookmark {
  id: string;
  /** article 文章收藏 / paragraph 段落收藏 */
  type: BookmarkType;
  bookId?: string;
  chapterId?: string;
  segmentId?: string;
  /** 收藏的段落文本 */
  text?: string;
  /** 标签列表 */
  tags: string[];
  /** 独立备注（P1-12，可空） */
  note?: string;
  createdAt: string;
}

// ============ 背诵数据模型 ============

/** 背诵模式：填空默写 / 提示遮盖 */
export type RecitationMode = 'fillBlank' | 'coverHint';

/**
 * 提示粒度（P1-07）：点击「提示」时一次揭示的遮盖范围。
 * - whole：整篇模式下逐格揭示（默认，向后兼容）
 * - paragraph：逐段——一次揭示目标空格所在段的全部未填空格
 * - sentence：逐句——一次揭示目标空格所在句组的全部未填空格
 */
export type RecitationHintGranularity = 'whole' | 'paragraph' | 'sentence';

/** 背诵状态：未开始 / 进行中 / 已掌握 */
export type RecitationStatus = 'notStarted' | 'inProgress' | 'mastered';

/** 背诵进度 */
export interface RecitationProgress {
  id: string;
  bookId: string;
  chapterId: string;
  mode: RecitationMode;
  status: RecitationStatus;
  /** 0-100 */
  progress: number;
  lastPracticedAt?: string;
  /**
   * 最近一次「背诵完成」（fillBlank 提交）时刻，ISO 8601（P2-07）。
   * 旧数据无此字段 → 不产生复习项。
   */
  completedAt?: string;
  /**
   * 艾宾浩斯复习等级（0 起，对应 REVIEW_INTERVAL_DAYS 下标）（P2-07）。
   * 全对 +1（封顶），有错 -1（保底 0）。
   */
  reviewLevel?: number;
  /** 下次复习到期时刻，ISO 8601；到期判定 nextDueAt <= now（P2-07） */
  nextDueAt?: string;
}

// ============ 搜索数据模型 ============

/** 搜索结果项 */
export interface SearchResult {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  segmentId: string;
  /** 包含关键词的段落文本 */
  text: string;
  /** 匹配次数 */
  matchCount: number;
}

// ============ 设置模型 ============

/** 主题模式（全局 UI 暗色开关，App 导航 / 我的页等共用） */
export type ThemeMode = 'light' | 'dark';

/**
 * 阅读纸张模式（阅读器专属背景换肤，对标微信读书 / 番茄小说）。
 * 与全局 ThemeMode 解耦：切换纸张只改变阅读页配色，不影响 App 其它界面。
 */
export type PaperMode = 'default' | 'green' | 'sepia' | 'dark' | 'cyan';

/**
 * 阅读翻页方式。
 * - scroll：纵向滚动（与注音行 / 长按选区 / 划线偏移兼容性最佳）。
 * - page：仿真翻页（横向分页 + 翻页阴影动画），对标微信读书 / 番茄小说。
 */
export type ReaderMode = 'scroll' | 'page';

/** 阅读器设置 */
export interface ReaderSettings {
  /** 字号档位（16/18/20/24） */
  fontSize: number;
  /** 行距倍数（1.4/1.6/1.8） */
  lineHeight: number;
  /** 主题（全局 UI 暗色开关） */
  theme: ThemeMode;
  /** 阅读纸张（阅读器专属背景换肤） */
  paper: PaperMode;
  /** 翻页方式（滚动 / 仿真翻页） */
  readerMode: ReaderMode;
  /** 注音模式 */
  pinyinMode: PinyinMode;
  /** 繁简转换模式 */
  conversionMode: 'simplified' | 'traditional';
}

// ============ 解析数据模型 ============

/** 单字解析结果 */
export interface CharAnalysis {
  char: string;
  /** 拼音（含声调） */
  pinyin: string;
  /** 释义 */
  meaning: string;
  /** 部首 */
  radical: string;
  /** 笔画数 */
  strokes: number;
  /** 异体字 */
  yiti: string[];
  /** 古音（可选） */
  ancientSound?: string;
}

/** 词语解析结果 */
export interface WordAnalysis {
  word: string;
  /** 释义 */
  meaning: string;
  /** 出处 */
  source?: string;
  /** 用法说明 */
  usage?: string;
  /** 例句 */
  examples?: string[];
}

// ============ 服务统一返回格式 ============

/** Service 方法统一返回格式 */
export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============ 文本库分类 ============

/** 分类条目（含中文标签） */
export interface Category {
  key: BookCategory;
  label: string;
}

// ============ Canon（通假/读音语境校验）============

/** canon 通假判定结果 */
export interface CanonTongjiaResult {
  /** 正字字头 */
  original: string;
  /** 释义 */
  note?: string;
  /** 判定源列表 */
  sources: string[];
  /** 是否经权威校验 */
  verified: boolean;
  /**
   * 用字关系类型（canon_dict v2 起提供）：
   * 'tongjia' = 通假字（默认，旧库无 type 列时视为通假）；
   * 'gujin' = 古今字（人工标注·据训诂常识，建议校对）。
   * 古今字广义属用字通假，UI 可统一按「通」展示，也可据此区分角标文案。
   */
  kind?: 'tongjia' | 'gujin';
  /**
   * 语料例句（canon v3 起）：判定所依据的原文用例（如「不亦说乎」）。
   * 运行时据此做用例级语境锚定——同一篇内该字多处出现时，
   * 只有落在例句跨度内的出现位置才标注（杜绝「甲句通假、全篇误标」）。
   */
  context?: string;
}

/** canon 语境读音结果 */
export interface CanonReadingResult {
  /** 正确语境拼音 */
  reading: string;
  /** 读音源列表 */
  sources: string[];
  /** 是否经权威校验 */
  verified: boolean;
  /** 语料例句（canon v3 起，语义同 CanonTongjiaResult.context） */
  context?: string;
}

/**
 * canon 校验提供者（由 CanonService 实现，注入 PinyinService）。
 * 依赖方向：PinyinService 仅依赖本接口，不 import 实现，保持单向依赖。
 */
export interface CanonProvider {
  /** 通假判定：命中返回权威结论，否则返回 null（不标角标） */
  getTongjia(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonTongjiaResult | null;
  /** 语境读音：命中返回正确读音，否则返回 null（回退内置/pinyin-pro 并标未校验） */
  getReading(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonReadingResult | null;
  /**
   * 通假判定候选（canon v3 起，可选实现）：按层级优先序返回该字全部判定行
   * （含各自行 context），供运行时做用例级语境锚定。未实现时调用方回退
   * getTongjia 单行结果（旧行为：无语境校验）。
   */
  getTongjiaCandidates?(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonTongjiaResult[];
  /** 语境读音候选（canon v3 起，可选实现，语义同上） */
  getReadingCandidates?(
    workId: string | undefined,
    bookId: string | undefined,
    char: string,
  ): CanonReadingResult[];
}
