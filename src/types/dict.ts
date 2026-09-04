/**
 * 字典域类型定义（guoxue_dict_engine）
 * 覆盖：字典元数据、词条、义项、导入与查询模型。
 * 详见架构文档 §3.2；与 SQLite DDL（DictDatabase.ts）一一对应。
 */

/** 义项（原生字典 / 结构化导入的目标形态） */
export interface DictSense {
  /** 释义 */
  def: string;
  /** 词性，如「动」「名」 */
  pos?: string;
  /** 义项标注，如「古」「今」「书」 */
  label?: string;
  /** 例句 */
  examples?: string[];
  /** 书证（古汉语字典），如「《论语·学而》：学而时习之」 */
  citations?: string[];
}

/** 词条内容三形态 */
export type DictContentType = 'structured' | 'html' | 'plain';

/** 词条结构化补充信息 */
export interface DictEntryExtra {
  /** 部首 */
  radical?: string;
  /** 笔画数 */
  strokes?: number;
  /** 异体字 */
  yiti?: string[];
  /** 古音（反切/拟音） */
  ancientSound?: string;
}

/** 词条（统一 schema，原生字典与用户导入字典共用） */
export interface DictEntry {
  id: number;
  /** 所属字典 ID */
  dictId: string;
  /** 原始字头（保留繁/简/大小写原貌） */
  headword: string;
  /** 归一化字头（唯一查询入口，见 normalizeHeadword） */
  headwordNorm: string;
  /** 主读音（含声调符号） */
  pinyin?: string;
  /** 多音字候选读音 */
  readings?: string[];
  contentType: DictContentType;
  /** structured→DictSense[] JSON；html→MDX HTML 原文；plain→文本 */
  content: string;
  /** 结构化补充信息 */
  extra?: DictEntryExtra;
}

/** 字典种类：原生（只读） / 用户导入 */
export type DictKind = 'native' | 'user';

/** 字典来源格式 */
export type DictFormat = 'builtin' | 'mdx' | 'csv' | 'tsv' | 'json' | 'txt' | 'stardict';

/** 字典元数据（运行时合并视图：db 不可变信息 + store 可变设置） */
export interface DictMeta {
  id: string;
  name: string;
  kind: DictKind;
  format: DictFormat;
  entryCount: number;
  /** 数据版本（原生 db 部署比对用） */
  version?: string;
  /** 来源许可（原生字典必填） */
  license?: string;
  description?: string;
  /** 语种对（如 zh-en / zh-jp；外文词典展示与过滤用，可空） */
  langPair?: string;
  /** 用户字典文件大小（管理页展示，字节） */
  sizeBytes?: number;
  createdAt?: string;
  /* ---- 以下来自 useDictStore（可变，持久化） ---- */
  enabled: boolean;
  /** 查询优先级，小者先 */
  order: number;
}

/** 单字头部聚合信息（查字页顶部展示） */
export interface DictCharInfo {
  radical?: string;
  strokes?: number;
  yiti: string[];
  /** 通假字信息（来自内置 tongjia-zi.json） */
  tongjia?: { original: string; note: string };
}

/** 查字聚合结果：按字典 order 排列；entry 为 null 表示该字典未收录 */
export interface DictLookupResult {
  headword: string;
  results: Array<{ dict: DictMeta; entry: DictEntry | null }>;
  /** 单字时聚合的头部信息 */
  charInfo?: DictCharInfo;
}

/** 多音字读音来源（持久化） */
export type PolyphoneSource =
  | { type: 'builtin' } // 内置规则库（默认）
  | { type: 'dict'; dictId: string }; // 某个已启用字典

/** 导入报告 */
export interface ImportReport {
  dictId: string;
  totalEntries: number;
  failedCount: number;
  /** 错误明细（上限 100 条，超出聚合计数） */
  errors: Array<{ at?: number | string; reason: string }>;
  /** 非致命提示（如 StarDict 成组导入时被忽略的无关文件），不影响成功/失败语义 */
  warnings?: string[];
  elapsedMs: number;
  cancelled: boolean;
}

/** 导入进度状态 */
export type ImportStatus = 'idle' | 'parsing' | 'writing' | 'done' | 'error' | 'cancelled';
