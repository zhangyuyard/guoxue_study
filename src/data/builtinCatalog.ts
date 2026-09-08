/**
 * 内置书目录清单（builtinCatalog）。
 * 由 scripts/build-builtin-assets.mjs 自动生成，请勿手改。
 * 运行时链路：assets/books/<id>.txt（@@CH@@ 标记文本）→ UserBookService
 * 首启物化到 guoxue-books/builtin/ → 扫描解析 → 按本清单元数据注册为内置书。
 * bundle 不再携带书体（书体在 APK assets，大小不受限）。
 */
import type { BookCategory } from '@/types';

/** 单部内置书的目录条目 */
export interface BuiltinBookSpec {
  id: string;
  title: string;
  author: string;
  category: BookCategory;
  description: string;
  /** 朝代（与 bookMeta.BOOK_DYNASTIES 取值一致，供筛选） */
  dynasty: string;
}

export const BUILTIN_CATALOG: BuiltinBookSpec[] = [
  {
    "id": "daodejing",
    "title": "道德经",
    "author": "老子",
    "category": "zi",
    "description": "道家哲学经典，又称《老子》，共八十一章，阐述道与德的思想体系。",
    "dynasty": "春秋"
  },
  {
    "id": "lunyu",
    "title": "论语",
    "author": "孔子弟子及再传弟子",
    "category": "jing",
    "description": "记录孔子及其弟子言行的儒家经典，二十篇。本版为全本。",
    "dynasty": "先秦"
  },
  {
    "id": "daxue",
    "title": "大学",
    "author": "曾子（传）",
    "category": "jing",
    "description": "《礼记》篇目，四书之一，相传为曾子所作，论述格物致知、诚意正心、修身齐家治国平天下之道。",
    "dynasty": "先秦"
  },
  {
    "id": "zhongyong",
    "title": "中庸",
    "author": "子思（传）",
    "category": "jing",
    "description": "《礼记》篇目，四书之一，相传为孔子之孙子思所作，阐述中庸之道与诚的哲学体系，共三十三章。",
    "dynasty": "先秦"
  },
  {
    "id": "mengzi",
    "title": "孟子",
    "author": "孟子及弟子",
    "category": "jing",
    "description": "孟子及弟子著录孟子言行的儒家经典，七篇二百六十一章。本版为全本。",
    "dynasty": "战国"
  },
  {
    "id": "zhuangzi",
    "title": "庄子",
    "author": "庄周及后学",
    "category": "zi",
    "description": "《庄子》又名《南华经》，是战国中期庄子及其后学所著道家经文。到了汉代以后，尊庄子为南华真人，因此《庄子》亦称《南华经》。其书与《老子》《周易》合称“三玄”。《庄子》书分内、外、杂篇，原有…本版为全本。",
    "dynasty": "战国"
  },
  {
    "id": "shijing",
    "title": "诗经",
    "author": "佚名（周代采诗）",
    "category": "jing",
    "description": "我国最早诗歌总集，收录西周至春秋诗篇三百零五篇。本版为全本。",
    "dynasty": "先秦"
  },
  {
    "id": "xunzi",
    "title": "荀子",
    "author": "荀况",
    "category": "zi",
    "description": "《荀子》是战国末年著名唯物主义思想家的著作。该书旨在总结当时学术界的百家争鸣和自己的学术思想，反映唯物主义自然观、认识论思想以及荀况的伦理、政治和经济思想。本版为全本。",
    "dynasty": "战国"
  },
  {
    "id": "chuci",
    "title": "楚辞",
    "author": "屈原 等",
    "category": "ji",
    "description": "以屈原作品为首的楚辞总集，兼收汉代拟作。本版为全本。",
    "dynasty": "战国～汉"
  },
  {
    "id": "tangshi",
    "title": "唐诗三百首",
    "author": "蘅塘退士 编",
    "category": "ji",
    "description": "清·蘅塘退士编选唐诗选集，共收诗 320 首。本版为全本。",
    "dynasty": "唐"
  },
  {
    "id": "zhouyi",
    "title": "周易",
    "author": "佚名",
    "category": "jing",
    "description": "《周易》即《易经》，《三易》之一（另有观点：认为易经即三易，而非周易），是传统经典之一，相传系周文王姬昌所作，内容包括《经》和《传》两个部分。《经》主要是六十四卦和三百八十四爻，卦和爻各…本版为全本。",
    "dynasty": "先秦"
  },
  {
    "id": "zuozhuan",
    "title": "左传",
    "author": "左丘明",
    "category": "jing",
    "description": "《左传》，全称《春秋左氏传》，原名《左氏春秋》，汉朝时又名《春秋左氏》《春秋内传》《左氏》，汉朝以后才多称《左传》。《左传》相传是春秋末年鲁国的为《春秋》做注解的一部史书，与《公羊传》、…本版为全本。",
    "dynasty": "先秦"
  },
  {
    "id": "shiji",
    "title": "史记",
    "author": "司马迁",
    "category": "shi",
    "description": "《史记》是由撰写的中国第一部纪传体通史。记载了上自上古传说中的黄帝时代，下至汉武帝元狩元年间共3000多年的历史（哲学、政治、经济、军事等）。《史记》最初没有固定书名，或称“太史公书”，…本版为全本。",
    "dynasty": "西汉"
  },
  {
    "id": "tongjian",
    "title": "资治通鉴",
    "author": "司马光",
    "category": "shi",
    "description": "北宋司马光主持编纂的编年体通史，二百九十四卷，记十六朝一千三百六十二年史事。本版为全本。",
    "dynasty": "北宋"
  },
  {
    "id": "mozi",
    "title": "墨子",
    "author": "墨翟",
    "category": "zi",
    "description": "墨家创始经典，墨翟及后学所著，主张兼爱、非攻、尚贤、节用。本版为全本。",
    "dynasty": "战国"
  },
  {
    "id": "wenxuan",
    "title": "文选",
    "author": "萧统编",
    "category": "ji",
    "description": "南朝梁昭明太子萧统编纂的诗文总集，世称《昭明文选》，为现存最早的诗文选集。本选本收《过秦论》《陈情表》《兰亭集序》《归去来兮辞》四篇历代传诵名作，以通行整理本为底。",
    "dynasty": "南朝梁"
  },
  {
    "id": "songci",
    "title": "宋词三百首",
    "author": "朱祖谋 编",
    "category": "ji",
    "description": "近人朱祖谋编选宋词选集，共收词 291 首。本版为全本。",
    "dynasty": "宋"
  },
  {
    "id": "yuanqu",
    "title": "元曲",
    "author": "元代曲家",
    "category": "ji",
    "description": "元曲总集（散曲与剧曲套数），收 11057 首、 233 家。本版为全本。",
    "dynasty": "元"
  },
  {
    "id": "guwenguanzhi",
    "title": "古文观止",
    "author": "吴楚材、吴调侯 编",
    "category": "ji",
    "description": "清·吴氏叔侄编选历代散文选集，共 222 篇。本版为全本。",
    "dynasty": "清"
  },
  {
    "id": "sanzijing",
    "title": "三字经",
    "author": "王应麟（传）",
    "category": "jing",
    "description": "相传宋·王应麟撰三字韵语蒙书，涵盖劝学、名物、经史子集纲要。本版为全本。",
    "dynasty": "宋"
  },
  {
    "id": "baijiaxing",
    "title": "百家姓",
    "author": "佚名",
    "category": "jing",
    "description": "宋初编成的姓氏韵文蒙书，四字一句读来顺口。本版为全本。",
    "dynasty": "宋"
  },
  {
    "id": "qianziwen",
    "title": "千字文",
    "author": "周兴嗣",
    "category": "jing",
    "description": "南朝梁·周兴嗣以一千个不重复汉字编成的韵文蒙书。本版为全本。",
    "dynasty": "南朝梁"
  },
  {
    "id": "dizigui",
    "title": "弟子规",
    "author": "李毓秀",
    "category": "jing",
    "description": "清·李毓秀据《论语》学而篇义理编成的童蒙行为规范。本版为全本。",
    "dynasty": "清"
  },
  {
    "id": "zhuzijiaxun",
    "title": "朱子家训",
    "author": "朱用纯",
    "category": "jing",
    "description": "明末清初·朱用纯撰治家格言，五百余字。本版为全本。",
    "dynasty": "明"
  },
  {
    "id": "zengguangxianwen",
    "title": "增广贤文",
    "author": "佚名",
    "category": "jing",
    "description": "明代辑成的谚语格言集，上下两集。本版为全本。",
    "dynasty": "明"
  },
  {
    "id": "shenglvqimeng",
    "title": "声律启蒙",
    "author": "车万育",
    "category": "jing",
    "description": "清·车万育撰声韵对偶蒙书，训练诗联对仗。本版为全本。",
    "dynasty": "清"
  },
  {
    "id": "liwengduiyun",
    "title": "笠翁对韵",
    "author": "李渔",
    "category": "jing",
    "description": "清·李渔撰声韵对偶蒙书，与《声律启蒙》齐名。本版为全本。",
    "dynasty": "清"
  },
  {
    "id": "youxueqionglin",
    "title": "幼学琼林",
    "author": "程登吉",
    "category": "jing",
    "description": "明·程登吉撰百科常识蒙书（原本《幼学须知》）。本版为全本。",
    "dynasty": "明"
  }
];

export function getBuiltinSpec(id: string): BuiltinBookSpec | undefined {
  return BUILTIN_CATALOG.find((b) => b.id === id);
}
