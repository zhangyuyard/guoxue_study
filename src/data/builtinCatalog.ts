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
  /** APK 资产字节大小（物化变更检测指纹，见 UserBookService.materializeBuiltins） */
  sizeBytes: number;
  /** 章节目录（id+title，无正文；id 与运行时解析逐条一致） */
  toc: Array<{ id: string; title: string }>;
}

export const BUILTIN_CATALOG: BuiltinBookSpec[] = [
  {
    "id": "daodejing",
    "title": "道德经",
    "author": "老子",
    "category": "zi",
    "description": "道家哲学经典，又称《老子》，共八十一章，阐述道与德的思想体系。",
    "dynasty": "春秋",
    "sizeBytes": 21275,
    "toc": [
      {
        "id": "daodejing-c1",
        "title": "第一章"
      },
      {
        "id": "daodejing-c2",
        "title": "第二章"
      },
      {
        "id": "daodejing-c3",
        "title": "第三章"
      },
      {
        "id": "daodejing-c4",
        "title": "第四章"
      },
      {
        "id": "daodejing-c5",
        "title": "第五章"
      },
      {
        "id": "daodejing-c6",
        "title": "第六章"
      },
      {
        "id": "daodejing-c7",
        "title": "第七章"
      },
      {
        "id": "daodejing-c8",
        "title": "第八章"
      },
      {
        "id": "daodejing-c9",
        "title": "第九章"
      },
      {
        "id": "daodejing-c10",
        "title": "第十章"
      },
      {
        "id": "daodejing-c11",
        "title": "第十一章"
      },
      {
        "id": "daodejing-c12",
        "title": "第十二章"
      },
      {
        "id": "daodejing-c13",
        "title": "第十三章"
      },
      {
        "id": "daodejing-c14",
        "title": "第十四章"
      },
      {
        "id": "daodejing-c15",
        "title": "第十五章"
      },
      {
        "id": "daodejing-c16",
        "title": "第十六章"
      },
      {
        "id": "daodejing-c17",
        "title": "第十七章"
      },
      {
        "id": "daodejing-c18",
        "title": "第十八章"
      },
      {
        "id": "daodejing-c19",
        "title": "第十九章"
      },
      {
        "id": "daodejing-c20",
        "title": "第二十章"
      },
      {
        "id": "daodejing-c21",
        "title": "第二十一章"
      },
      {
        "id": "daodejing-c22",
        "title": "第二十二章"
      },
      {
        "id": "daodejing-c23",
        "title": "第二十三章"
      },
      {
        "id": "daodejing-c24",
        "title": "第二十四章"
      },
      {
        "id": "daodejing-c25",
        "title": "第二十五章"
      },
      {
        "id": "daodejing-c26",
        "title": "第二十六章"
      },
      {
        "id": "daodejing-c27",
        "title": "第二十七章"
      },
      {
        "id": "daodejing-c28",
        "title": "第二十八章"
      },
      {
        "id": "daodejing-c29",
        "title": "第二十九章"
      },
      {
        "id": "daodejing-c30",
        "title": "第三十章"
      },
      {
        "id": "daodejing-c31",
        "title": "第三十一章"
      },
      {
        "id": "daodejing-c32",
        "title": "第三十二章"
      },
      {
        "id": "daodejing-c33",
        "title": "第三十三章"
      },
      {
        "id": "daodejing-c34",
        "title": "第三十四章"
      },
      {
        "id": "daodejing-c35",
        "title": "第三十五章"
      },
      {
        "id": "daodejing-c36",
        "title": "第三十六章"
      },
      {
        "id": "daodejing-c37",
        "title": "第三十七章"
      },
      {
        "id": "daodejing-c38",
        "title": "第三十八章"
      },
      {
        "id": "daodejing-c39",
        "title": "第三十九章"
      },
      {
        "id": "daodejing-c40",
        "title": "第四十章"
      },
      {
        "id": "daodejing-c41",
        "title": "第四十一章"
      },
      {
        "id": "daodejing-c42",
        "title": "第四十二章"
      },
      {
        "id": "daodejing-c43",
        "title": "第四十三章"
      },
      {
        "id": "daodejing-c44",
        "title": "第四十四章"
      },
      {
        "id": "daodejing-c45",
        "title": "第四十五章"
      },
      {
        "id": "daodejing-c46",
        "title": "第四十六章"
      },
      {
        "id": "daodejing-c47",
        "title": "第四十七章"
      },
      {
        "id": "daodejing-c48",
        "title": "第四十八章"
      },
      {
        "id": "daodejing-c49",
        "title": "第四十九章"
      },
      {
        "id": "daodejing-c50",
        "title": "第五十章"
      },
      {
        "id": "daodejing-c51",
        "title": "第五十一章"
      },
      {
        "id": "daodejing-c52",
        "title": "第五十二章"
      },
      {
        "id": "daodejing-c53",
        "title": "第五十三章"
      },
      {
        "id": "daodejing-c54",
        "title": "第五十四章"
      },
      {
        "id": "daodejing-c55",
        "title": "第五十五章"
      },
      {
        "id": "daodejing-c56",
        "title": "第五十六章"
      },
      {
        "id": "daodejing-c57",
        "title": "第五十七章"
      },
      {
        "id": "daodejing-c58",
        "title": "第五十八章"
      },
      {
        "id": "daodejing-c59",
        "title": "第五十九章"
      },
      {
        "id": "daodejing-c60",
        "title": "第六十章"
      },
      {
        "id": "daodejing-c61",
        "title": "第六十一章"
      },
      {
        "id": "daodejing-c62",
        "title": "第六十二章"
      },
      {
        "id": "daodejing-c63",
        "title": "第六十三章"
      },
      {
        "id": "daodejing-c64",
        "title": "第六十四章"
      },
      {
        "id": "daodejing-c65",
        "title": "第六十五章"
      },
      {
        "id": "daodejing-c66",
        "title": "第六十六章"
      },
      {
        "id": "daodejing-c67",
        "title": "第六十七章"
      },
      {
        "id": "daodejing-c68",
        "title": "第六十八章"
      },
      {
        "id": "daodejing-c69",
        "title": "第六十九章"
      },
      {
        "id": "daodejing-c70",
        "title": "第七十章"
      },
      {
        "id": "daodejing-c71",
        "title": "第七十一章"
      },
      {
        "id": "daodejing-c72",
        "title": "第七十二章"
      },
      {
        "id": "daodejing-c73",
        "title": "第七十三章"
      },
      {
        "id": "daodejing-c74",
        "title": "第七十四章"
      },
      {
        "id": "daodejing-c75",
        "title": "第七十五章"
      },
      {
        "id": "daodejing-c76",
        "title": "第七十六章"
      },
      {
        "id": "daodejing-c77",
        "title": "第七十七章"
      },
      {
        "id": "daodejing-c78",
        "title": "第七十八章"
      },
      {
        "id": "daodejing-c79",
        "title": "第七十九章"
      },
      {
        "id": "daodejing-c80",
        "title": "第八十章"
      },
      {
        "id": "daodejing-c81",
        "title": "第八十一章"
      }
    ]
  },
  {
    "id": "lunyu",
    "title": "论语",
    "author": "孔子弟子及再传弟子",
    "category": "jing",
    "description": "记录孔子及其弟子言行的儒家经典，二十篇。本版为全本。",
    "dynasty": "先秦",
    "sizeBytes": 65819,
    "toc": [
      {
        "id": "lunyu-c1",
        "title": "学而篇"
      },
      {
        "id": "lunyu-c2",
        "title": "为政篇"
      },
      {
        "id": "lunyu-c3",
        "title": "八佾篇"
      },
      {
        "id": "lunyu-c4",
        "title": "里仁篇"
      },
      {
        "id": "lunyu-c5",
        "title": "公冶长篇"
      },
      {
        "id": "lunyu-c6",
        "title": "雍也篇"
      },
      {
        "id": "lunyu-c7",
        "title": "述而篇"
      },
      {
        "id": "lunyu-c8",
        "title": "泰伯篇"
      },
      {
        "id": "lunyu-c9",
        "title": "子罕篇"
      },
      {
        "id": "lunyu-c10",
        "title": "乡党篇"
      },
      {
        "id": "lunyu-c11",
        "title": "先进篇"
      },
      {
        "id": "lunyu-c12",
        "title": "颜渊篇"
      },
      {
        "id": "lunyu-c13",
        "title": "子路篇"
      },
      {
        "id": "lunyu-c14",
        "title": "宪问篇"
      },
      {
        "id": "lunyu-c15",
        "title": "卫灵公篇"
      },
      {
        "id": "lunyu-c16",
        "title": "季氏篇"
      },
      {
        "id": "lunyu-c17",
        "title": "阳货篇"
      },
      {
        "id": "lunyu-c18",
        "title": "微子篇"
      },
      {
        "id": "lunyu-c19",
        "title": "子张篇"
      },
      {
        "id": "lunyu-c20",
        "title": "尧曰篇"
      }
    ]
  },
  {
    "id": "daxue",
    "title": "大学",
    "author": "曾子（传）",
    "category": "jing",
    "description": "《礼记》篇目，四书之一，相传为曾子所作，论述格物致知、诚意正心、修身齐家治国平天下之道。",
    "dynasty": "先秦",
    "sizeBytes": 7503,
    "toc": [
      {
        "id": "daxue-c1",
        "title": "经一章"
      },
      {
        "id": "daxue-c2",
        "title": "传一章（释明明德）"
      },
      {
        "id": "daxue-c3",
        "title": "传二章（释新民）"
      },
      {
        "id": "daxue-c4",
        "title": "传三章（释止于至善）"
      },
      {
        "id": "daxue-c5",
        "title": "传四章（释本末）"
      },
      {
        "id": "daxue-c6",
        "title": "传五章（释格物致知）"
      },
      {
        "id": "daxue-c7",
        "title": "传六章（释诚意）"
      },
      {
        "id": "daxue-c8",
        "title": "传七章（释正心修身）"
      },
      {
        "id": "daxue-c9",
        "title": "传八章（释修身齐家）"
      },
      {
        "id": "daxue-c10",
        "title": "传九章（释齐家治国）"
      },
      {
        "id": "daxue-c11",
        "title": "传十章（释治国平天下）"
      }
    ]
  },
  {
    "id": "zhongyong",
    "title": "中庸",
    "author": "子思（传）",
    "category": "jing",
    "description": "《礼记》篇目，四书之一，相传为孔子之孙子思所作，阐述中庸之道与诚的哲学体系，共三十三章。",
    "dynasty": "先秦",
    "sizeBytes": 14137,
    "toc": [
      {
        "id": "zhongyong-c1",
        "title": "第一章"
      },
      {
        "id": "zhongyong-c2",
        "title": "第二章"
      },
      {
        "id": "zhongyong-c3",
        "title": "第三章"
      },
      {
        "id": "zhongyong-c4",
        "title": "第四章"
      },
      {
        "id": "zhongyong-c5",
        "title": "第五章"
      },
      {
        "id": "zhongyong-c6",
        "title": "第六章"
      },
      {
        "id": "zhongyong-c7",
        "title": "第七章"
      },
      {
        "id": "zhongyong-c8",
        "title": "第八章"
      },
      {
        "id": "zhongyong-c9",
        "title": "第九章"
      },
      {
        "id": "zhongyong-c10",
        "title": "第十章"
      },
      {
        "id": "zhongyong-c11",
        "title": "第十一章"
      },
      {
        "id": "zhongyong-c12",
        "title": "第十二章"
      },
      {
        "id": "zhongyong-c13",
        "title": "第十三章"
      },
      {
        "id": "zhongyong-c14",
        "title": "第十四章"
      },
      {
        "id": "zhongyong-c15",
        "title": "第十五章"
      },
      {
        "id": "zhongyong-c16",
        "title": "第十六章"
      },
      {
        "id": "zhongyong-c17",
        "title": "第十七章"
      },
      {
        "id": "zhongyong-c18",
        "title": "第十八章"
      },
      {
        "id": "zhongyong-c19",
        "title": "第十九章"
      },
      {
        "id": "zhongyong-c20",
        "title": "第二十章"
      },
      {
        "id": "zhongyong-c21",
        "title": "第二十一章"
      },
      {
        "id": "zhongyong-c22",
        "title": "第二十二章"
      },
      {
        "id": "zhongyong-c23",
        "title": "第二十三章"
      },
      {
        "id": "zhongyong-c24",
        "title": "第二十四章"
      },
      {
        "id": "zhongyong-c25",
        "title": "第二十五章"
      },
      {
        "id": "zhongyong-c26",
        "title": "第二十六章"
      },
      {
        "id": "zhongyong-c27",
        "title": "第二十七章"
      },
      {
        "id": "zhongyong-c28",
        "title": "第二十八章"
      },
      {
        "id": "zhongyong-c29",
        "title": "第二十九章"
      },
      {
        "id": "zhongyong-c30",
        "title": "第三十章"
      },
      {
        "id": "zhongyong-c31",
        "title": "第三十一章"
      },
      {
        "id": "zhongyong-c32",
        "title": "第三十二章"
      },
      {
        "id": "zhongyong-c33",
        "title": "第三十三章"
      }
    ]
  },
  {
    "id": "mengzi",
    "title": "孟子",
    "author": "孟子及弟子",
    "category": "jing",
    "description": "孟子及弟子著录孟子言行的儒家经典，七篇二百六十一章。本版为全本。",
    "dynasty": "战国",
    "sizeBytes": 136003,
    "toc": [
      {
        "id": "mengzi-c1",
        "title": "梁惠王章句上"
      },
      {
        "id": "mengzi-c2",
        "title": "梁惠王章句下"
      },
      {
        "id": "mengzi-c3",
        "title": "公孙丑章句上"
      },
      {
        "id": "mengzi-c4",
        "title": "公孙丑章句下"
      },
      {
        "id": "mengzi-c5",
        "title": "滕文公章句上"
      },
      {
        "id": "mengzi-c6",
        "title": "滕文公章句下"
      },
      {
        "id": "mengzi-c7",
        "title": "离娄章句上"
      },
      {
        "id": "mengzi-c8",
        "title": "离娄章句下"
      },
      {
        "id": "mengzi-c9",
        "title": "万章章句上"
      },
      {
        "id": "mengzi-c10",
        "title": "万章章句下"
      },
      {
        "id": "mengzi-c11",
        "title": "告子章句上"
      },
      {
        "id": "mengzi-c12",
        "title": "告子章句下"
      },
      {
        "id": "mengzi-c13",
        "title": "尽心章句上"
      },
      {
        "id": "mengzi-c14",
        "title": "尽心章句下"
      }
    ]
  },
  {
    "id": "zhuangzi",
    "title": "庄子",
    "author": "庄周及后学",
    "category": "zi",
    "description": "《庄子》又名《南华经》，是战国中期庄子及其后学所著道家经文。到了汉代以后，尊庄子为南华真人，因此《庄子》亦称《南华经》。其书与《老子》《周易》合称“三玄”。《庄子》书分内、外、杂篇，原有…本版为全本。",
    "dynasty": "战国",
    "sizeBytes": 241705,
    "toc": [
      {
        "id": "zhuangzi-c1",
        "title": "内篇·逍遥游"
      },
      {
        "id": "zhuangzi-c2",
        "title": "内篇·齐物论"
      },
      {
        "id": "zhuangzi-c3",
        "title": "内篇·养生主"
      },
      {
        "id": "zhuangzi-c4",
        "title": "内篇·人间世"
      },
      {
        "id": "zhuangzi-c5",
        "title": "内篇·德充符"
      },
      {
        "id": "zhuangzi-c6",
        "title": "内篇·大宗师"
      },
      {
        "id": "zhuangzi-c7",
        "title": "内篇·应帝王"
      },
      {
        "id": "zhuangzi-c8",
        "title": "外篇·骈拇"
      },
      {
        "id": "zhuangzi-c9",
        "title": "外篇·马蹄"
      },
      {
        "id": "zhuangzi-c10",
        "title": "外篇·胠箧"
      },
      {
        "id": "zhuangzi-c11",
        "title": "外篇·在宥"
      },
      {
        "id": "zhuangzi-c12",
        "title": "外篇·天地"
      },
      {
        "id": "zhuangzi-c13",
        "title": "外篇·天道"
      },
      {
        "id": "zhuangzi-c14",
        "title": "外篇·天运"
      },
      {
        "id": "zhuangzi-c15",
        "title": "外篇·刻意"
      },
      {
        "id": "zhuangzi-c16",
        "title": "外篇·缮性"
      },
      {
        "id": "zhuangzi-c17",
        "title": "外篇·秋水"
      },
      {
        "id": "zhuangzi-c18",
        "title": "外篇·至乐"
      },
      {
        "id": "zhuangzi-c19",
        "title": "外篇·达生"
      },
      {
        "id": "zhuangzi-c20",
        "title": "外篇·山木"
      },
      {
        "id": "zhuangzi-c21",
        "title": "外篇·田子方"
      },
      {
        "id": "zhuangzi-c22",
        "title": "外篇·知北游"
      },
      {
        "id": "zhuangzi-c23",
        "title": "杂篇·庚桑楚"
      },
      {
        "id": "zhuangzi-c24",
        "title": "杂篇·徐无鬼"
      },
      {
        "id": "zhuangzi-c25",
        "title": "杂篇·则阳"
      },
      {
        "id": "zhuangzi-c26",
        "title": "杂篇·外物"
      },
      {
        "id": "zhuangzi-c27",
        "title": "杂篇·寓言"
      },
      {
        "id": "zhuangzi-c28",
        "title": "杂篇·让王"
      },
      {
        "id": "zhuangzi-c29",
        "title": "杂篇·盗跖"
      },
      {
        "id": "zhuangzi-c30",
        "title": "杂篇·说剑"
      },
      {
        "id": "zhuangzi-c31",
        "title": "杂篇·渔父"
      },
      {
        "id": "zhuangzi-c32",
        "title": "杂篇·列御寇"
      },
      {
        "id": "zhuangzi-c33",
        "title": "杂篇·天下"
      }
    ]
  },
  {
    "id": "shijing",
    "title": "诗经",
    "author": "佚名（周代采诗）",
    "category": "jing",
    "description": "我国最早诗歌总集，收录西周至春秋诗篇三百零五篇。本版为全本。",
    "dynasty": "先秦",
    "sizeBytes": 118146,
    "toc": [
      {
        "id": "shijing-c1",
        "title": "国风·周南"
      },
      {
        "id": "shijing-c2",
        "title": "国风·召南"
      },
      {
        "id": "shijing-c3",
        "title": "国风·邶风"
      },
      {
        "id": "shijing-c4",
        "title": "国风·鄘风"
      },
      {
        "id": "shijing-c5",
        "title": "国风·卫风"
      },
      {
        "id": "shijing-c6",
        "title": "国风·王风"
      },
      {
        "id": "shijing-c7",
        "title": "国风·郑风"
      },
      {
        "id": "shijing-c8",
        "title": "国风·齐风"
      },
      {
        "id": "shijing-c9",
        "title": "国风·魏风"
      },
      {
        "id": "shijing-c10",
        "title": "国风·唐风"
      },
      {
        "id": "shijing-c11",
        "title": "国风·秦风"
      },
      {
        "id": "shijing-c12",
        "title": "国风·陈风"
      },
      {
        "id": "shijing-c13",
        "title": "国风·桧风"
      },
      {
        "id": "shijing-c14",
        "title": "国风·曹风"
      },
      {
        "id": "shijing-c15",
        "title": "国风·豳风"
      },
      {
        "id": "shijing-c16",
        "title": "小雅·鹿鸣之什"
      },
      {
        "id": "shijing-c17",
        "title": "小雅·南有嘉鱼之什"
      },
      {
        "id": "shijing-c18",
        "title": "小雅·鸿雁之什"
      },
      {
        "id": "shijing-c19",
        "title": "小雅·节南山之什"
      },
      {
        "id": "shijing-c20",
        "title": "小雅·谷风之什"
      },
      {
        "id": "shijing-c21",
        "title": "小雅·甫田之什"
      },
      {
        "id": "shijing-c22",
        "title": "小雅·鱼藻之什"
      },
      {
        "id": "shijing-c23",
        "title": "大雅·文王之什"
      },
      {
        "id": "shijing-c24",
        "title": "大雅·生民之什"
      },
      {
        "id": "shijing-c25",
        "title": "大雅·荡之什"
      },
      {
        "id": "shijing-c26",
        "title": "周颂·清庙之什"
      },
      {
        "id": "shijing-c27",
        "title": "周颂·臣工之什"
      },
      {
        "id": "shijing-c28",
        "title": "周颂·闵予小子之什"
      },
      {
        "id": "shijing-c29",
        "title": "鲁颂·駉之什"
      },
      {
        "id": "shijing-c30",
        "title": "商颂·那之什"
      }
    ]
  },
  {
    "id": "xunzi",
    "title": "荀子",
    "author": "荀况",
    "category": "zi",
    "description": "《荀子》是战国末年著名唯物主义思想家的著作。该书旨在总结当时学术界的百家争鸣和自己的学术思想，反映唯物主义自然观、认识论思想以及荀况的伦理、政治和经济思想。本版为全本。",
    "dynasty": "战国",
    "sizeBytes": 273644,
    "toc": [
      {
        "id": "xunzi-c1",
        "title": "劝学"
      },
      {
        "id": "xunzi-c2",
        "title": "修身"
      },
      {
        "id": "xunzi-c3",
        "title": "不苟"
      },
      {
        "id": "xunzi-c4",
        "title": "荣辱"
      },
      {
        "id": "xunzi-c5",
        "title": "非相"
      },
      {
        "id": "xunzi-c6",
        "title": "非十二子"
      },
      {
        "id": "xunzi-c7",
        "title": "仲尼"
      },
      {
        "id": "xunzi-c8",
        "title": "儒效"
      },
      {
        "id": "xunzi-c9",
        "title": "王制"
      },
      {
        "id": "xunzi-c10",
        "title": "富国"
      },
      {
        "id": "xunzi-c11",
        "title": "王霸"
      },
      {
        "id": "xunzi-c12",
        "title": "君道"
      },
      {
        "id": "xunzi-c13",
        "title": "臣道"
      },
      {
        "id": "xunzi-c14",
        "title": "致士"
      },
      {
        "id": "xunzi-c15",
        "title": "议兵"
      },
      {
        "id": "xunzi-c16",
        "title": "强国"
      },
      {
        "id": "xunzi-c17",
        "title": "天论"
      },
      {
        "id": "xunzi-c18",
        "title": "正论"
      },
      {
        "id": "xunzi-c19",
        "title": "礼论"
      },
      {
        "id": "xunzi-c20",
        "title": "乐论"
      },
      {
        "id": "xunzi-c21",
        "title": "解蔽"
      },
      {
        "id": "xunzi-c22",
        "title": "正名"
      },
      {
        "id": "xunzi-c23",
        "title": "性恶"
      },
      {
        "id": "xunzi-c24",
        "title": "君子"
      },
      {
        "id": "xunzi-c25",
        "title": "成相"
      },
      {
        "id": "xunzi-c26",
        "title": "赋"
      },
      {
        "id": "xunzi-c27",
        "title": "大略"
      },
      {
        "id": "xunzi-c28",
        "title": "宥坐"
      },
      {
        "id": "xunzi-c29",
        "title": "子道"
      },
      {
        "id": "xunzi-c30",
        "title": "法行"
      },
      {
        "id": "xunzi-c31",
        "title": "哀公"
      },
      {
        "id": "xunzi-c32",
        "title": "尧问"
      }
    ]
  },
  {
    "id": "chuci",
    "title": "楚辞",
    "author": "屈原 等",
    "category": "ji",
    "description": "以屈原作品为首的楚辞总集，兼收汉代拟作。本版为全本。",
    "dynasty": "战国～汉",
    "sizeBytes": 100845,
    "toc": [
      {
        "id": "chuci-c1",
        "title": "离骚"
      },
      {
        "id": "chuci-c2",
        "title": "九歌"
      },
      {
        "id": "chuci-c3",
        "title": "天问"
      },
      {
        "id": "chuci-c4",
        "title": "九章"
      },
      {
        "id": "chuci-c5",
        "title": "远游"
      },
      {
        "id": "chuci-c6",
        "title": "卜居"
      },
      {
        "id": "chuci-c7",
        "title": "渔父"
      },
      {
        "id": "chuci-c8",
        "title": "九辩"
      },
      {
        "id": "chuci-c9",
        "title": "招魂"
      },
      {
        "id": "chuci-c10",
        "title": "大招"
      },
      {
        "id": "chuci-c11",
        "title": "惜誓"
      },
      {
        "id": "chuci-c12",
        "title": "招隐士"
      },
      {
        "id": "chuci-c13",
        "title": "七谏"
      },
      {
        "id": "chuci-c14",
        "title": "哀时命"
      },
      {
        "id": "chuci-c15",
        "title": "九怀"
      },
      {
        "id": "chuci-c16",
        "title": "九叹"
      },
      {
        "id": "chuci-c17",
        "title": "九思"
      }
    ]
  },
  {
    "id": "tangshi",
    "title": "唐诗三百首",
    "author": "蘅塘退士 编",
    "category": "ji",
    "description": "清·蘅塘退士编选唐诗选集，共收诗 320 首。本版为全本。",
    "dynasty": "唐",
    "sizeBytes": 83857,
    "toc": [
      {
        "id": "tangshi-c1",
        "title": "五言绝句"
      },
      {
        "id": "tangshi-c2",
        "title": "七言绝句"
      },
      {
        "id": "tangshi-c3",
        "title": "五言律诗"
      },
      {
        "id": "tangshi-c4",
        "title": "七言律诗"
      },
      {
        "id": "tangshi-c5",
        "title": "五言古诗"
      },
      {
        "id": "tangshi-c6",
        "title": "七言古诗"
      },
      {
        "id": "tangshi-c7",
        "title": "乐府"
      }
    ]
  },
  {
    "id": "zhouyi",
    "title": "周易",
    "author": "佚名",
    "category": "jing",
    "description": "《周易》即《易经》，《三易》之一（另有观点：认为易经即三易，而非周易），是传统经典之一，相传系周文王姬昌所作，内容包括《经》和《传》两个部分。《经》主要是六十四卦和三百八十四爻，卦和爻各…本版为全本。",
    "dynasty": "先秦",
    "sizeBytes": 22390,
    "toc": [
      {
        "id": "zhouyi-c1",
        "title": "乾卦"
      },
      {
        "id": "zhouyi-c2",
        "title": "坤卦"
      },
      {
        "id": "zhouyi-c3",
        "title": "屯卦"
      },
      {
        "id": "zhouyi-c4",
        "title": "蒙卦"
      },
      {
        "id": "zhouyi-c5",
        "title": "需卦"
      },
      {
        "id": "zhouyi-c6",
        "title": "讼卦"
      },
      {
        "id": "zhouyi-c7",
        "title": "师卦"
      },
      {
        "id": "zhouyi-c8",
        "title": "比卦"
      },
      {
        "id": "zhouyi-c9",
        "title": "小畜卦"
      },
      {
        "id": "zhouyi-c10",
        "title": "履卦"
      },
      {
        "id": "zhouyi-c11",
        "title": "泰卦"
      },
      {
        "id": "zhouyi-c12",
        "title": "否卦"
      },
      {
        "id": "zhouyi-c13",
        "title": "同人卦"
      },
      {
        "id": "zhouyi-c14",
        "title": "大有卦"
      },
      {
        "id": "zhouyi-c15",
        "title": "谦卦"
      },
      {
        "id": "zhouyi-c16",
        "title": "豫卦"
      },
      {
        "id": "zhouyi-c17",
        "title": "随卦"
      },
      {
        "id": "zhouyi-c18",
        "title": "蛊卦"
      },
      {
        "id": "zhouyi-c19",
        "title": "临卦"
      },
      {
        "id": "zhouyi-c20",
        "title": "观卦"
      },
      {
        "id": "zhouyi-c21",
        "title": "噬嗑卦"
      },
      {
        "id": "zhouyi-c22",
        "title": "贲卦"
      },
      {
        "id": "zhouyi-c23",
        "title": "剥卦"
      },
      {
        "id": "zhouyi-c24",
        "title": "复卦"
      },
      {
        "id": "zhouyi-c25",
        "title": "无妄卦"
      },
      {
        "id": "zhouyi-c26",
        "title": "大畜卦"
      },
      {
        "id": "zhouyi-c27",
        "title": "颐卦"
      },
      {
        "id": "zhouyi-c28",
        "title": "大过卦"
      },
      {
        "id": "zhouyi-c29",
        "title": "坎卦"
      },
      {
        "id": "zhouyi-c30",
        "title": "离卦"
      },
      {
        "id": "zhouyi-c31",
        "title": "咸卦"
      },
      {
        "id": "zhouyi-c32",
        "title": "恒卦"
      },
      {
        "id": "zhouyi-c33",
        "title": "遯卦"
      },
      {
        "id": "zhouyi-c34",
        "title": "大壮卦"
      },
      {
        "id": "zhouyi-c35",
        "title": "晋卦"
      },
      {
        "id": "zhouyi-c36",
        "title": "明夷卦"
      },
      {
        "id": "zhouyi-c37",
        "title": "家人卦"
      },
      {
        "id": "zhouyi-c38",
        "title": "睽卦"
      },
      {
        "id": "zhouyi-c39",
        "title": "蹇卦"
      },
      {
        "id": "zhouyi-c40",
        "title": "解卦"
      },
      {
        "id": "zhouyi-c41",
        "title": "损卦"
      },
      {
        "id": "zhouyi-c42",
        "title": "益卦"
      },
      {
        "id": "zhouyi-c43",
        "title": "夬卦"
      },
      {
        "id": "zhouyi-c44",
        "title": "姤卦"
      },
      {
        "id": "zhouyi-c45",
        "title": "萃卦"
      },
      {
        "id": "zhouyi-c46",
        "title": "升卦"
      },
      {
        "id": "zhouyi-c47",
        "title": "困卦"
      },
      {
        "id": "zhouyi-c48",
        "title": "井卦"
      },
      {
        "id": "zhouyi-c49",
        "title": "革卦"
      },
      {
        "id": "zhouyi-c50",
        "title": "鼎卦"
      },
      {
        "id": "zhouyi-c51",
        "title": "震卦"
      },
      {
        "id": "zhouyi-c52",
        "title": "艮卦"
      },
      {
        "id": "zhouyi-c53",
        "title": "渐卦"
      },
      {
        "id": "zhouyi-c54",
        "title": "归妹卦"
      },
      {
        "id": "zhouyi-c55",
        "title": "丰卦"
      },
      {
        "id": "zhouyi-c56",
        "title": "旅卦"
      },
      {
        "id": "zhouyi-c57",
        "title": "巽卦"
      },
      {
        "id": "zhouyi-c58",
        "title": "兑卦"
      },
      {
        "id": "zhouyi-c59",
        "title": "涣卦"
      },
      {
        "id": "zhouyi-c60",
        "title": "节卦"
      },
      {
        "id": "zhouyi-c61",
        "title": "中孚卦"
      },
      {
        "id": "zhouyi-c62",
        "title": "小过卦"
      },
      {
        "id": "zhouyi-c63",
        "title": "既济卦"
      },
      {
        "id": "zhouyi-c64",
        "title": "未济卦"
      }
    ]
  },
  {
    "id": "zuozhuan",
    "title": "左传",
    "author": "左丘明",
    "category": "jing",
    "description": "《左传》，全称《春秋左氏传》，原名《左氏春秋》，汉朝时又名《春秋左氏》《春秋内传》《左氏》，汉朝以后才多称《左传》。《左传》相传是春秋末年鲁国的为《春秋》做注解的一部史书，与《公羊传》、…本版为全本。",
    "dynasty": "先秦",
    "sizeBytes": 762938,
    "toc": [
      {
        "id": "zuozhuan-c1",
        "title": "隐公·隐公元年"
      },
      {
        "id": "zuozhuan-c2",
        "title": "隐公·隐公二年"
      },
      {
        "id": "zuozhuan-c3",
        "title": "隐公·隐公三年"
      },
      {
        "id": "zuozhuan-c4",
        "title": "隐公·隐公四年"
      },
      {
        "id": "zuozhuan-c5",
        "title": "隐公·隐公五年"
      },
      {
        "id": "zuozhuan-c6",
        "title": "隐公·隐公六年"
      },
      {
        "id": "zuozhuan-c7",
        "title": "隐公·隐公七年"
      },
      {
        "id": "zuozhuan-c8",
        "title": "隐公·隐公八年"
      },
      {
        "id": "zuozhuan-c9",
        "title": "隐公·隐公九年"
      },
      {
        "id": "zuozhuan-c10",
        "title": "隐公·隐公十年"
      },
      {
        "id": "zuozhuan-c11",
        "title": "隐公·隐公十一年"
      },
      {
        "id": "zuozhuan-c12",
        "title": "桓公·桓公元年"
      },
      {
        "id": "zuozhuan-c13",
        "title": "桓公·桓公二年"
      },
      {
        "id": "zuozhuan-c14",
        "title": "桓公·桓公三年"
      },
      {
        "id": "zuozhuan-c15",
        "title": "桓公·桓公四年"
      },
      {
        "id": "zuozhuan-c16",
        "title": "桓公·桓公五年"
      },
      {
        "id": "zuozhuan-c17",
        "title": "桓公·桓公六年"
      },
      {
        "id": "zuozhuan-c18",
        "title": "桓公·桓公七年"
      },
      {
        "id": "zuozhuan-c19",
        "title": "桓公·桓公八年"
      },
      {
        "id": "zuozhuan-c20",
        "title": "桓公·桓公九年"
      },
      {
        "id": "zuozhuan-c21",
        "title": "桓公·桓公十年"
      },
      {
        "id": "zuozhuan-c22",
        "title": "桓公·桓公十一年"
      },
      {
        "id": "zuozhuan-c23",
        "title": "桓公·桓公十二年"
      },
      {
        "id": "zuozhuan-c24",
        "title": "桓公·桓公十三年"
      },
      {
        "id": "zuozhuan-c25",
        "title": "桓公·桓公十四年"
      },
      {
        "id": "zuozhuan-c26",
        "title": "桓公·桓公十五年"
      },
      {
        "id": "zuozhuan-c27",
        "title": "桓公·桓公十六年"
      },
      {
        "id": "zuozhuan-c28",
        "title": "桓公·桓公十七年"
      },
      {
        "id": "zuozhuan-c29",
        "title": "桓公·桓公十八年"
      },
      {
        "id": "zuozhuan-c30",
        "title": "庄公·庄公元年"
      },
      {
        "id": "zuozhuan-c31",
        "title": "庄公·庄公二年"
      },
      {
        "id": "zuozhuan-c32",
        "title": "庄公·庄公三年"
      },
      {
        "id": "zuozhuan-c33",
        "title": "庄公·庄公四年"
      },
      {
        "id": "zuozhuan-c34",
        "title": "庄公·庄公五年"
      },
      {
        "id": "zuozhuan-c35",
        "title": "庄公·庄公六年"
      },
      {
        "id": "zuozhuan-c36",
        "title": "庄公·庄公七年"
      },
      {
        "id": "zuozhuan-c37",
        "title": "庄公·庄公八年"
      },
      {
        "id": "zuozhuan-c38",
        "title": "庄公·庄公九年"
      },
      {
        "id": "zuozhuan-c39",
        "title": "庄公·庄公十年"
      },
      {
        "id": "zuozhuan-c40",
        "title": "庄公·庄公十一年"
      },
      {
        "id": "zuozhuan-c41",
        "title": "庄公·庄公十二年"
      },
      {
        "id": "zuozhuan-c42",
        "title": "庄公·庄公十三年"
      },
      {
        "id": "zuozhuan-c43",
        "title": "庄公·庄公十四年"
      },
      {
        "id": "zuozhuan-c44",
        "title": "庄公·庄公十五年"
      },
      {
        "id": "zuozhuan-c45",
        "title": "庄公·庄公十六年"
      },
      {
        "id": "zuozhuan-c46",
        "title": "庄公·庄公十七年"
      },
      {
        "id": "zuozhuan-c47",
        "title": "庄公·庄公十八年"
      },
      {
        "id": "zuozhuan-c48",
        "title": "庄公·庄公十九年"
      },
      {
        "id": "zuozhuan-c49",
        "title": "庄公·庄公二十年"
      },
      {
        "id": "zuozhuan-c50",
        "title": "庄公·庄公二十一年"
      },
      {
        "id": "zuozhuan-c51",
        "title": "庄公·庄公二十二年"
      },
      {
        "id": "zuozhuan-c52",
        "title": "庄公·庄公二十三年"
      },
      {
        "id": "zuozhuan-c53",
        "title": "庄公·庄公二十四年"
      },
      {
        "id": "zuozhuan-c54",
        "title": "庄公·庄公二十五年"
      },
      {
        "id": "zuozhuan-c55",
        "title": "庄公·庄公二十六年"
      },
      {
        "id": "zuozhuan-c56",
        "title": "庄公·庄公二十七年"
      },
      {
        "id": "zuozhuan-c57",
        "title": "庄公·庄公二十八年"
      },
      {
        "id": "zuozhuan-c58",
        "title": "庄公·庄公二十九年"
      },
      {
        "id": "zuozhuan-c59",
        "title": "庄公·庄公三十年"
      },
      {
        "id": "zuozhuan-c60",
        "title": "庄公·庄公三十一年"
      },
      {
        "id": "zuozhuan-c61",
        "title": "庄公·庄公三十二年"
      },
      {
        "id": "zuozhuan-c62",
        "title": "闵公·闵公元年"
      },
      {
        "id": "zuozhuan-c63",
        "title": "闵公·闵公二年"
      },
      {
        "id": "zuozhuan-c64",
        "title": "僖公·僖公元年"
      },
      {
        "id": "zuozhuan-c65",
        "title": "僖公·僖公二年"
      },
      {
        "id": "zuozhuan-c66",
        "title": "僖公·僖公三年"
      },
      {
        "id": "zuozhuan-c67",
        "title": "僖公·僖公四年"
      },
      {
        "id": "zuozhuan-c68",
        "title": "僖公·僖公五年"
      },
      {
        "id": "zuozhuan-c69",
        "title": "僖公·僖公六年"
      },
      {
        "id": "zuozhuan-c70",
        "title": "僖公·僖公七年"
      },
      {
        "id": "zuozhuan-c71",
        "title": "僖公·僖公八年"
      },
      {
        "id": "zuozhuan-c72",
        "title": "僖公·僖公九年"
      },
      {
        "id": "zuozhuan-c73",
        "title": "僖公·僖公十年"
      },
      {
        "id": "zuozhuan-c74",
        "title": "僖公·僖公十一年"
      },
      {
        "id": "zuozhuan-c75",
        "title": "僖公·僖公十二年"
      },
      {
        "id": "zuozhuan-c76",
        "title": "僖公·僖公十三年"
      },
      {
        "id": "zuozhuan-c77",
        "title": "僖公·僖公十四年"
      },
      {
        "id": "zuozhuan-c78",
        "title": "僖公·僖公十五年"
      },
      {
        "id": "zuozhuan-c79",
        "title": "僖公·僖公十六年"
      },
      {
        "id": "zuozhuan-c80",
        "title": "僖公·僖公十七年"
      },
      {
        "id": "zuozhuan-c81",
        "title": "僖公·僖公十八年"
      },
      {
        "id": "zuozhuan-c82",
        "title": "僖公·僖公十九年"
      },
      {
        "id": "zuozhuan-c83",
        "title": "僖公·僖公二十年"
      },
      {
        "id": "zuozhuan-c84",
        "title": "僖公·僖公二十一年"
      },
      {
        "id": "zuozhuan-c85",
        "title": "僖公·僖公二十二年"
      },
      {
        "id": "zuozhuan-c86",
        "title": "僖公·僖公二十三年"
      },
      {
        "id": "zuozhuan-c87",
        "title": "僖公·僖公二十四年"
      },
      {
        "id": "zuozhuan-c88",
        "title": "僖公·僖公二十五年"
      },
      {
        "id": "zuozhuan-c89",
        "title": "僖公·僖公二十六年"
      },
      {
        "id": "zuozhuan-c90",
        "title": "僖公·僖公二十七年"
      },
      {
        "id": "zuozhuan-c91",
        "title": "僖公·僖公二十八年"
      },
      {
        "id": "zuozhuan-c92",
        "title": "僖公·僖公二十九年"
      },
      {
        "id": "zuozhuan-c93",
        "title": "僖公·僖公三十年"
      },
      {
        "id": "zuozhuan-c94",
        "title": "僖公·僖公三十一年"
      },
      {
        "id": "zuozhuan-c95",
        "title": "僖公·僖公三十二年"
      },
      {
        "id": "zuozhuan-c96",
        "title": "僖公·僖公三十三年"
      },
      {
        "id": "zuozhuan-c97",
        "title": "文公·文公元年"
      },
      {
        "id": "zuozhuan-c98",
        "title": "文公·文公二年"
      },
      {
        "id": "zuozhuan-c99",
        "title": "文公·文公三年"
      },
      {
        "id": "zuozhuan-c100",
        "title": "文公·文公四年"
      },
      {
        "id": "zuozhuan-c101",
        "title": "文公·文公五年"
      },
      {
        "id": "zuozhuan-c102",
        "title": "文公·文公六年"
      },
      {
        "id": "zuozhuan-c103",
        "title": "文公·文公七年"
      },
      {
        "id": "zuozhuan-c104",
        "title": "文公·文公八年"
      },
      {
        "id": "zuozhuan-c105",
        "title": "文公·文公九年"
      },
      {
        "id": "zuozhuan-c106",
        "title": "文公·文公十年"
      },
      {
        "id": "zuozhuan-c107",
        "title": "文公·文公十一年"
      },
      {
        "id": "zuozhuan-c108",
        "title": "文公·文公十二年"
      },
      {
        "id": "zuozhuan-c109",
        "title": "文公·文公十三年"
      },
      {
        "id": "zuozhuan-c110",
        "title": "文公·文公十四年"
      },
      {
        "id": "zuozhuan-c111",
        "title": "文公·文公十五年"
      },
      {
        "id": "zuozhuan-c112",
        "title": "文公·文公十六年"
      },
      {
        "id": "zuozhuan-c113",
        "title": "文公·文公十七年"
      },
      {
        "id": "zuozhuan-c114",
        "title": "文公·文公十八年"
      },
      {
        "id": "zuozhuan-c115",
        "title": "宣公·宣公元年"
      },
      {
        "id": "zuozhuan-c116",
        "title": "宣公·宣公二年"
      },
      {
        "id": "zuozhuan-c117",
        "title": "宣公·宣公三年"
      },
      {
        "id": "zuozhuan-c118",
        "title": "宣公·宣公四年"
      },
      {
        "id": "zuozhuan-c119",
        "title": "宣公·宣公五年"
      },
      {
        "id": "zuozhuan-c120",
        "title": "宣公·宣公六年"
      },
      {
        "id": "zuozhuan-c121",
        "title": "宣公·宣公七年"
      },
      {
        "id": "zuozhuan-c122",
        "title": "宣公·宣公八年"
      },
      {
        "id": "zuozhuan-c123",
        "title": "宣公·宣公九年"
      },
      {
        "id": "zuozhuan-c124",
        "title": "宣公·宣公十年"
      },
      {
        "id": "zuozhuan-c125",
        "title": "宣公·宣公十一年"
      },
      {
        "id": "zuozhuan-c126",
        "title": "宣公·宣公十二年"
      },
      {
        "id": "zuozhuan-c127",
        "title": "宣公·宣公十三年"
      },
      {
        "id": "zuozhuan-c128",
        "title": "宣公·宣公十四年"
      },
      {
        "id": "zuozhuan-c129",
        "title": "宣公·宣公十五年"
      },
      {
        "id": "zuozhuan-c130",
        "title": "宣公·宣公十六年"
      },
      {
        "id": "zuozhuan-c131",
        "title": "宣公·宣公十七年"
      },
      {
        "id": "zuozhuan-c132",
        "title": "宣公·宣公十八年"
      },
      {
        "id": "zuozhuan-c133",
        "title": "成公·成公元年"
      },
      {
        "id": "zuozhuan-c134",
        "title": "成公·成公二年"
      },
      {
        "id": "zuozhuan-c135",
        "title": "成公·成公三年"
      },
      {
        "id": "zuozhuan-c136",
        "title": "成公·成公四年"
      },
      {
        "id": "zuozhuan-c137",
        "title": "成公·成公五年"
      },
      {
        "id": "zuozhuan-c138",
        "title": "成公·成公六年"
      },
      {
        "id": "zuozhuan-c139",
        "title": "成公·成公七年"
      },
      {
        "id": "zuozhuan-c140",
        "title": "成公·成公八年"
      },
      {
        "id": "zuozhuan-c141",
        "title": "成公·成公九年"
      },
      {
        "id": "zuozhuan-c142",
        "title": "成公·成公十年"
      },
      {
        "id": "zuozhuan-c143",
        "title": "成公·成公十一年"
      },
      {
        "id": "zuozhuan-c144",
        "title": "成公·成公十二年"
      },
      {
        "id": "zuozhuan-c145",
        "title": "成公·成公十三年"
      },
      {
        "id": "zuozhuan-c146",
        "title": "成公·成公十四年"
      },
      {
        "id": "zuozhuan-c147",
        "title": "成公·成公十五年"
      },
      {
        "id": "zuozhuan-c148",
        "title": "成公·成公十六年"
      },
      {
        "id": "zuozhuan-c149",
        "title": "成公·成公十七年"
      },
      {
        "id": "zuozhuan-c150",
        "title": "成公·成公十八年"
      },
      {
        "id": "zuozhuan-c151",
        "title": "襄公·襄公元年"
      },
      {
        "id": "zuozhuan-c152",
        "title": "襄公·襄公二年"
      },
      {
        "id": "zuozhuan-c153",
        "title": "襄公·襄公三年"
      },
      {
        "id": "zuozhuan-c154",
        "title": "襄公·襄公四年"
      },
      {
        "id": "zuozhuan-c155",
        "title": "襄公·襄公五年"
      },
      {
        "id": "zuozhuan-c156",
        "title": "襄公·襄公六年"
      },
      {
        "id": "zuozhuan-c157",
        "title": "襄公·襄公七年"
      },
      {
        "id": "zuozhuan-c158",
        "title": "襄公·襄公八年"
      },
      {
        "id": "zuozhuan-c159",
        "title": "襄公·襄公九年"
      },
      {
        "id": "zuozhuan-c160",
        "title": "襄公·襄公十年"
      },
      {
        "id": "zuozhuan-c161",
        "title": "襄公·襄公十一年"
      },
      {
        "id": "zuozhuan-c162",
        "title": "襄公·襄公十二年"
      },
      {
        "id": "zuozhuan-c163",
        "title": "襄公·襄公十三年"
      },
      {
        "id": "zuozhuan-c164",
        "title": "襄公·襄公十四年"
      },
      {
        "id": "zuozhuan-c165",
        "title": "襄公·襄公十五年"
      },
      {
        "id": "zuozhuan-c166",
        "title": "襄公·襄公十六年"
      },
      {
        "id": "zuozhuan-c167",
        "title": "襄公·襄公十七年"
      },
      {
        "id": "zuozhuan-c168",
        "title": "襄公·襄公十八年"
      },
      {
        "id": "zuozhuan-c169",
        "title": "襄公·襄公十九年"
      },
      {
        "id": "zuozhuan-c170",
        "title": "襄公·襄公二十年"
      },
      {
        "id": "zuozhuan-c171",
        "title": "襄公·襄公二十一年"
      },
      {
        "id": "zuozhuan-c172",
        "title": "襄公·襄公二十二年"
      },
      {
        "id": "zuozhuan-c173",
        "title": "襄公·襄公二十三年"
      },
      {
        "id": "zuozhuan-c174",
        "title": "襄公·襄公二十四年"
      },
      {
        "id": "zuozhuan-c175",
        "title": "襄公·襄公二十五年"
      },
      {
        "id": "zuozhuan-c176",
        "title": "襄公·襄公二十六年"
      },
      {
        "id": "zuozhuan-c177",
        "title": "襄公·襄公二十七年"
      },
      {
        "id": "zuozhuan-c178",
        "title": "襄公·襄公二十八年"
      },
      {
        "id": "zuozhuan-c179",
        "title": "襄公·襄公二十九年"
      },
      {
        "id": "zuozhuan-c180",
        "title": "襄公·襄公三十年"
      },
      {
        "id": "zuozhuan-c181",
        "title": "襄公·襄公三十一年"
      },
      {
        "id": "zuozhuan-c182",
        "title": "昭公·昭公元年"
      },
      {
        "id": "zuozhuan-c183",
        "title": "昭公·昭公二年"
      },
      {
        "id": "zuozhuan-c184",
        "title": "昭公·昭公三年"
      },
      {
        "id": "zuozhuan-c185",
        "title": "昭公·昭公四年"
      },
      {
        "id": "zuozhuan-c186",
        "title": "昭公·昭公五年"
      },
      {
        "id": "zuozhuan-c187",
        "title": "昭公·昭公六年"
      },
      {
        "id": "zuozhuan-c188",
        "title": "昭公·昭公七年"
      },
      {
        "id": "zuozhuan-c189",
        "title": "昭公·昭公八年"
      },
      {
        "id": "zuozhuan-c190",
        "title": "昭公·昭公九年"
      },
      {
        "id": "zuozhuan-c191",
        "title": "昭公·昭公十年"
      },
      {
        "id": "zuozhuan-c192",
        "title": "昭公·昭公十一年"
      },
      {
        "id": "zuozhuan-c193",
        "title": "昭公·昭公十二年"
      },
      {
        "id": "zuozhuan-c194",
        "title": "昭公·昭公十三年"
      },
      {
        "id": "zuozhuan-c195",
        "title": "昭公·昭公十四年"
      },
      {
        "id": "zuozhuan-c196",
        "title": "昭公·昭公十五年"
      },
      {
        "id": "zuozhuan-c197",
        "title": "昭公·昭公十六年"
      },
      {
        "id": "zuozhuan-c198",
        "title": "昭公·昭公十七年"
      },
      {
        "id": "zuozhuan-c199",
        "title": "昭公·昭公十八年"
      },
      {
        "id": "zuozhuan-c200",
        "title": "昭公·昭公十九年"
      },
      {
        "id": "zuozhuan-c201",
        "title": "昭公·昭公二十年"
      },
      {
        "id": "zuozhuan-c202",
        "title": "昭公·昭公二十一年"
      },
      {
        "id": "zuozhuan-c203",
        "title": "昭公·昭公二十二年"
      },
      {
        "id": "zuozhuan-c204",
        "title": "昭公·昭公二十三年"
      },
      {
        "id": "zuozhuan-c205",
        "title": "昭公·昭公二十四年"
      },
      {
        "id": "zuozhuan-c206",
        "title": "昭公·昭公二十五年"
      },
      {
        "id": "zuozhuan-c207",
        "title": "昭公·昭公二十六年"
      },
      {
        "id": "zuozhuan-c208",
        "title": "昭公·昭公二十七年"
      },
      {
        "id": "zuozhuan-c209",
        "title": "昭公·昭公二十八年"
      },
      {
        "id": "zuozhuan-c210",
        "title": "昭公·昭公二十九年"
      },
      {
        "id": "zuozhuan-c211",
        "title": "昭公·昭公三十年"
      },
      {
        "id": "zuozhuan-c212",
        "title": "昭公·昭公三十一年"
      },
      {
        "id": "zuozhuan-c213",
        "title": "昭公·昭公三十二年"
      },
      {
        "id": "zuozhuan-c214",
        "title": "定公·定公元年"
      },
      {
        "id": "zuozhuan-c215",
        "title": "定公·定公二年"
      },
      {
        "id": "zuozhuan-c216",
        "title": "定公·定公三年"
      },
      {
        "id": "zuozhuan-c217",
        "title": "定公·定公四年"
      },
      {
        "id": "zuozhuan-c218",
        "title": "定公·定公五年"
      },
      {
        "id": "zuozhuan-c219",
        "title": "定公·定公六年"
      },
      {
        "id": "zuozhuan-c220",
        "title": "定公·定公七年"
      },
      {
        "id": "zuozhuan-c221",
        "title": "定公·定公八年"
      },
      {
        "id": "zuozhuan-c222",
        "title": "定公·定公九年"
      },
      {
        "id": "zuozhuan-c223",
        "title": "定公·定公十年"
      },
      {
        "id": "zuozhuan-c224",
        "title": "定公·定公十一年"
      },
      {
        "id": "zuozhuan-c225",
        "title": "定公·定公十二年"
      },
      {
        "id": "zuozhuan-c226",
        "title": "定公·定公十三年"
      },
      {
        "id": "zuozhuan-c227",
        "title": "定公·定公十四年"
      },
      {
        "id": "zuozhuan-c228",
        "title": "定公·定公十五年"
      },
      {
        "id": "zuozhuan-c229",
        "title": "哀公·哀公元年"
      },
      {
        "id": "zuozhuan-c230",
        "title": "哀公·哀公二年"
      },
      {
        "id": "zuozhuan-c231",
        "title": "哀公·哀公三年"
      },
      {
        "id": "zuozhuan-c232",
        "title": "哀公·哀公四年"
      },
      {
        "id": "zuozhuan-c233",
        "title": "哀公·哀公五年"
      },
      {
        "id": "zuozhuan-c234",
        "title": "哀公·哀公六年"
      },
      {
        "id": "zuozhuan-c235",
        "title": "哀公·哀公七年"
      },
      {
        "id": "zuozhuan-c236",
        "title": "哀公·哀公八年"
      },
      {
        "id": "zuozhuan-c237",
        "title": "哀公·哀公九年"
      },
      {
        "id": "zuozhuan-c238",
        "title": "哀公·哀公十年"
      },
      {
        "id": "zuozhuan-c239",
        "title": "哀公·哀公十一年"
      },
      {
        "id": "zuozhuan-c240",
        "title": "哀公·哀公十二年"
      },
      {
        "id": "zuozhuan-c241",
        "title": "哀公·哀公十三年"
      },
      {
        "id": "zuozhuan-c242",
        "title": "哀公·哀公十四年"
      },
      {
        "id": "zuozhuan-c243",
        "title": "哀公·哀公十五年"
      },
      {
        "id": "zuozhuan-c244",
        "title": "哀公·哀公十六年"
      },
      {
        "id": "zuozhuan-c245",
        "title": "哀公·哀公十七年"
      },
      {
        "id": "zuozhuan-c246",
        "title": "哀公·哀公十八年"
      },
      {
        "id": "zuozhuan-c247",
        "title": "哀公·哀公十九年"
      },
      {
        "id": "zuozhuan-c248",
        "title": "哀公·哀公二十年"
      },
      {
        "id": "zuozhuan-c249",
        "title": "哀公·哀公二十一年"
      },
      {
        "id": "zuozhuan-c250",
        "title": "哀公·哀公二十二年"
      },
      {
        "id": "zuozhuan-c251",
        "title": "哀公·哀公二十三年"
      },
      {
        "id": "zuozhuan-c252",
        "title": "哀公·哀公二十四年"
      },
      {
        "id": "zuozhuan-c253",
        "title": "哀公·哀公二十五年"
      },
      {
        "id": "zuozhuan-c254",
        "title": "哀公·哀公二十六年"
      },
      {
        "id": "zuozhuan-c255",
        "title": "哀公·哀公二十七年"
      }
    ]
  },
  {
    "id": "shiji",
    "title": "史记",
    "author": "司马迁",
    "category": "shi",
    "description": "《史记》是由撰写的中国第一部纪传体通史。记载了上自上古传说中的黄帝时代，下至汉武帝元狩元年间共3000多年的历史（哲学、政治、经济、军事等）。《史记》最初没有固定书名，或称“太史公书”，…本版为全本。",
    "dynasty": "西汉",
    "sizeBytes": 1873686,
    "toc": [
      {
        "id": "shiji-c1",
        "title": "十二本纪·五帝本纪"
      },
      {
        "id": "shiji-c2",
        "title": "十二本纪·夏本纪"
      },
      {
        "id": "shiji-c3",
        "title": "十二本纪·殷本纪"
      },
      {
        "id": "shiji-c4",
        "title": "十二本纪·周本纪"
      },
      {
        "id": "shiji-c5",
        "title": "十二本纪·秦本纪"
      },
      {
        "id": "shiji-c6",
        "title": "十二本纪·秦始皇本纪"
      },
      {
        "id": "shiji-c7",
        "title": "十二本纪·项羽本纪"
      },
      {
        "id": "shiji-c8",
        "title": "十二本纪·高祖本纪"
      },
      {
        "id": "shiji-c9",
        "title": "十二本纪·吕太后本纪"
      },
      {
        "id": "shiji-c10",
        "title": "十二本纪·孝文本纪"
      },
      {
        "id": "shiji-c11",
        "title": "十二本纪·孝景本纪"
      },
      {
        "id": "shiji-c12",
        "title": "十二本纪·孝武本纪"
      },
      {
        "id": "shiji-c13",
        "title": "十表·三代世表"
      },
      {
        "id": "shiji-c14",
        "title": "十表·十二诸侯年表"
      },
      {
        "id": "shiji-c15",
        "title": "十表·六国年表"
      },
      {
        "id": "shiji-c16",
        "title": "十表·秦楚之际月表"
      },
      {
        "id": "shiji-c17",
        "title": "十表·汉兴以来诸侯王年表"
      },
      {
        "id": "shiji-c18",
        "title": "十表·高祖功臣侯者年表"
      },
      {
        "id": "shiji-c19",
        "title": "十表·惠景间侯者年表"
      },
      {
        "id": "shiji-c20",
        "title": "十表·建元以来侯者年表"
      },
      {
        "id": "shiji-c21",
        "title": "十表·建元已来王子侯者年表"
      },
      {
        "id": "shiji-c22",
        "title": "十表·汉兴以来将相名臣年表"
      },
      {
        "id": "shiji-c23",
        "title": "八书·礼书"
      },
      {
        "id": "shiji-c24",
        "title": "八书·乐书"
      },
      {
        "id": "shiji-c25",
        "title": "八书·律书"
      },
      {
        "id": "shiji-c26",
        "title": "八书·历书"
      },
      {
        "id": "shiji-c27",
        "title": "八书·天官书"
      },
      {
        "id": "shiji-c28",
        "title": "八书·封禅书"
      },
      {
        "id": "shiji-c29",
        "title": "八书·河渠书"
      },
      {
        "id": "shiji-c30",
        "title": "八书·平准书"
      },
      {
        "id": "shiji-c31",
        "title": "三十世家·吴太伯世家"
      },
      {
        "id": "shiji-c32",
        "title": "三十世家·齐太公世家"
      },
      {
        "id": "shiji-c33",
        "title": "三十世家·鲁周公世家"
      },
      {
        "id": "shiji-c34",
        "title": "三十世家·燕召公世家"
      },
      {
        "id": "shiji-c35",
        "title": "三十世家·管蔡世家"
      },
      {
        "id": "shiji-c36",
        "title": "三十世家·陈杞世家"
      },
      {
        "id": "shiji-c37",
        "title": "三十世家·卫康叔世家"
      },
      {
        "id": "shiji-c38",
        "title": "三十世家·宋微子世家"
      },
      {
        "id": "shiji-c39",
        "title": "三十世家·晋世家"
      },
      {
        "id": "shiji-c40",
        "title": "三十世家·楚世家"
      },
      {
        "id": "shiji-c41",
        "title": "三十世家·越王勾践世家"
      },
      {
        "id": "shiji-c42",
        "title": "三十世家·郑世家"
      },
      {
        "id": "shiji-c43",
        "title": "三十世家·赵世家"
      },
      {
        "id": "shiji-c44",
        "title": "三十世家·魏世家"
      },
      {
        "id": "shiji-c45",
        "title": "三十世家·韩世家"
      },
      {
        "id": "shiji-c46",
        "title": "三十世家·田敬仲完世家"
      },
      {
        "id": "shiji-c47",
        "title": "三十世家·孔子世家"
      },
      {
        "id": "shiji-c48",
        "title": "三十世家·陈涉世家"
      },
      {
        "id": "shiji-c49",
        "title": "三十世家·外戚世家"
      },
      {
        "id": "shiji-c50",
        "title": "三十世家·楚元王世家"
      },
      {
        "id": "shiji-c51",
        "title": "三十世家·荆燕世家"
      },
      {
        "id": "shiji-c52",
        "title": "三十世家·齐悼惠王世家"
      },
      {
        "id": "shiji-c53",
        "title": "三十世家·萧相国世家"
      },
      {
        "id": "shiji-c54",
        "title": "三十世家·曹相国世家"
      },
      {
        "id": "shiji-c55",
        "title": "三十世家·留侯世家"
      },
      {
        "id": "shiji-c56",
        "title": "三十世家·陈丞相世家"
      },
      {
        "id": "shiji-c57",
        "title": "三十世家·绛侯周勃世家"
      },
      {
        "id": "shiji-c58",
        "title": "三十世家·梁孝王世家"
      },
      {
        "id": "shiji-c59",
        "title": "三十世家·五宗世家"
      },
      {
        "id": "shiji-c60",
        "title": "三十世家·三王世家"
      },
      {
        "id": "shiji-c61",
        "title": "七十列传·伯夷列传"
      },
      {
        "id": "shiji-c62",
        "title": "七十列传·管晏列传"
      },
      {
        "id": "shiji-c63",
        "title": "七十列传·老子韩非列传"
      },
      {
        "id": "shiji-c64",
        "title": "七十列传·司马穰苴列传"
      },
      {
        "id": "shiji-c65",
        "title": "七十列传·孙子吴起列传"
      },
      {
        "id": "shiji-c66",
        "title": "七十列传·伍子胥列传"
      },
      {
        "id": "shiji-c67",
        "title": "七十列传·仲尼弟子列传"
      },
      {
        "id": "shiji-c68",
        "title": "七十列传·商君列传"
      },
      {
        "id": "shiji-c69",
        "title": "七十列传·苏秦列传"
      },
      {
        "id": "shiji-c70",
        "title": "七十列传·张仪列传"
      },
      {
        "id": "shiji-c71",
        "title": "七十列传·樗里子甘茂列传"
      },
      {
        "id": "shiji-c72",
        "title": "七十列传·穰侯列传"
      },
      {
        "id": "shiji-c73",
        "title": "七十列传·白起王翦列传"
      },
      {
        "id": "shiji-c74",
        "title": "七十列传·孟子荀卿列传"
      },
      {
        "id": "shiji-c75",
        "title": "七十列传·孟尝君列传"
      },
      {
        "id": "shiji-c76",
        "title": "七十列传·平原君虞卿列传"
      },
      {
        "id": "shiji-c77",
        "title": "七十列传·魏公子列传"
      },
      {
        "id": "shiji-c78",
        "title": "七十列传·春申君列传"
      },
      {
        "id": "shiji-c79",
        "title": "七十列传·范睢蔡泽列传"
      },
      {
        "id": "shiji-c80",
        "title": "七十列传·乐毅列传"
      },
      {
        "id": "shiji-c81",
        "title": "七十列传·廉颇蔺相如列传"
      },
      {
        "id": "shiji-c82",
        "title": "七十列传·田单列传"
      },
      {
        "id": "shiji-c83",
        "title": "七十列传·鲁仲连邹阳列传"
      },
      {
        "id": "shiji-c84",
        "title": "七十列传·屈原贾生列传"
      },
      {
        "id": "shiji-c85",
        "title": "七十列传·吕不韦列传"
      },
      {
        "id": "shiji-c86",
        "title": "七十列传·刺客列传"
      },
      {
        "id": "shiji-c87",
        "title": "七十列传·李斯列传"
      },
      {
        "id": "shiji-c88",
        "title": "七十列传·蒙恬列传"
      },
      {
        "id": "shiji-c89",
        "title": "七十列传·张耳陈馀列传"
      },
      {
        "id": "shiji-c90",
        "title": "七十列传·魏豹彭越列传"
      },
      {
        "id": "shiji-c91",
        "title": "七十列传·黥布列传"
      },
      {
        "id": "shiji-c92",
        "title": "七十列传·淮阴侯列传"
      },
      {
        "id": "shiji-c93",
        "title": "七十列传·韩信卢绾列传"
      },
      {
        "id": "shiji-c94",
        "title": "七十列传·田儋列传"
      },
      {
        "id": "shiji-c95",
        "title": "七十列传·樊郦滕灌列传"
      },
      {
        "id": "shiji-c96",
        "title": "七十列传·张丞相列传"
      },
      {
        "id": "shiji-c97",
        "title": "七十列传·郦生陆贾列传"
      },
      {
        "id": "shiji-c98",
        "title": "七十列传·傅靳蒯成列传"
      },
      {
        "id": "shiji-c99",
        "title": "七十列传·刘敬叔孙通列传"
      },
      {
        "id": "shiji-c100",
        "title": "七十列传·季布栾布列传"
      },
      {
        "id": "shiji-c101",
        "title": "七十列传·袁盎晁错列传"
      },
      {
        "id": "shiji-c102",
        "title": "七十列传·张释之冯唐列传"
      },
      {
        "id": "shiji-c103",
        "title": "七十列传·万石张叔列传"
      },
      {
        "id": "shiji-c104",
        "title": "七十列传·田叔列传"
      },
      {
        "id": "shiji-c105",
        "title": "七十列传·扁鹊仓公列传"
      },
      {
        "id": "shiji-c106",
        "title": "七十列传·吴王濞列传"
      },
      {
        "id": "shiji-c107",
        "title": "七十列传·魏其武安侯列传"
      },
      {
        "id": "shiji-c108",
        "title": "七十列传·韩长孺列传"
      },
      {
        "id": "shiji-c109",
        "title": "七十列传·李将军列传"
      },
      {
        "id": "shiji-c110",
        "title": "七十列传·匈奴列传"
      },
      {
        "id": "shiji-c111",
        "title": "七十列传·卫将军骠骑列传"
      },
      {
        "id": "shiji-c112",
        "title": "七十列传·平津侯主父列传"
      },
      {
        "id": "shiji-c113",
        "title": "七十列传·南越列传"
      },
      {
        "id": "shiji-c114",
        "title": "七十列传·东越列传"
      },
      {
        "id": "shiji-c115",
        "title": "七十列传·朝鲜列传"
      },
      {
        "id": "shiji-c116",
        "title": "七十列传·西南夷列传"
      },
      {
        "id": "shiji-c117",
        "title": "七十列传·司马相如列传"
      },
      {
        "id": "shiji-c118",
        "title": "七十列传·淮南衡山列传"
      },
      {
        "id": "shiji-c119",
        "title": "七十列传·循吏列传"
      },
      {
        "id": "shiji-c120",
        "title": "七十列传·汲郑列传"
      },
      {
        "id": "shiji-c121",
        "title": "七十列传·儒林列传"
      },
      {
        "id": "shiji-c122",
        "title": "七十列传·酷吏列传"
      },
      {
        "id": "shiji-c123",
        "title": "七十列传·大宛列传"
      },
      {
        "id": "shiji-c124",
        "title": "七十列传·游侠列传"
      },
      {
        "id": "shiji-c125",
        "title": "七十列传·佞幸列传"
      },
      {
        "id": "shiji-c126",
        "title": "七十列传·滑稽列传"
      },
      {
        "id": "shiji-c127",
        "title": "七十列传·日者列传"
      },
      {
        "id": "shiji-c128",
        "title": "七十列传·龟策列传"
      },
      {
        "id": "shiji-c129",
        "title": "七十列传·货殖列传"
      },
      {
        "id": "shiji-c130",
        "title": "七十列传·太史公自序"
      }
    ]
  },
  {
    "id": "tongjian",
    "title": "资治通鉴",
    "author": "司马光",
    "category": "shi",
    "description": "北宋司马光主持编纂的编年体通史，二百九十四卷，记十六朝一千三百六十二年史事。本版为全本。",
    "dynasty": "北宋",
    "sizeBytes": 9473320,
    "toc": [
      {
        "id": "tongjian-c1",
        "title": "周纪·周纪一"
      },
      {
        "id": "tongjian-c2",
        "title": "周纪·周纪二"
      },
      {
        "id": "tongjian-c3",
        "title": "周纪·周纪三"
      },
      {
        "id": "tongjian-c4",
        "title": "周纪·周纪四"
      },
      {
        "id": "tongjian-c5",
        "title": "周纪·周纪五"
      },
      {
        "id": "tongjian-c6",
        "title": "秦纪·秦纪一"
      },
      {
        "id": "tongjian-c7",
        "title": "秦纪·秦纪二"
      },
      {
        "id": "tongjian-c8",
        "title": "秦纪·秦纪三"
      },
      {
        "id": "tongjian-c9",
        "title": "汉纪·汉纪一"
      },
      {
        "id": "tongjian-c10",
        "title": "汉纪·汉纪二"
      },
      {
        "id": "tongjian-c11",
        "title": "汉纪·汉纪三"
      },
      {
        "id": "tongjian-c12",
        "title": "汉纪·汉纪四"
      },
      {
        "id": "tongjian-c13",
        "title": "汉纪·汉纪五"
      },
      {
        "id": "tongjian-c14",
        "title": "汉纪·汉纪六"
      },
      {
        "id": "tongjian-c15",
        "title": "汉纪·汉纪七"
      },
      {
        "id": "tongjian-c16",
        "title": "汉纪·汉纪八"
      },
      {
        "id": "tongjian-c17",
        "title": "汉纪·汉纪九"
      },
      {
        "id": "tongjian-c18",
        "title": "汉纪·汉纪十"
      },
      {
        "id": "tongjian-c19",
        "title": "汉纪·汉纪十一"
      },
      {
        "id": "tongjian-c20",
        "title": "汉纪·汉纪十二"
      },
      {
        "id": "tongjian-c21",
        "title": "汉纪·汉纪十三"
      },
      {
        "id": "tongjian-c22",
        "title": "汉纪·汉纪十四"
      },
      {
        "id": "tongjian-c23",
        "title": "汉纪·汉纪十五"
      },
      {
        "id": "tongjian-c24",
        "title": "汉纪·汉纪十六"
      },
      {
        "id": "tongjian-c25",
        "title": "汉纪·汉纪十七"
      },
      {
        "id": "tongjian-c26",
        "title": "汉纪·汉纪十八"
      },
      {
        "id": "tongjian-c27",
        "title": "汉纪·汉纪十九"
      },
      {
        "id": "tongjian-c28",
        "title": "汉纪·汉纪二十"
      },
      {
        "id": "tongjian-c29",
        "title": "汉纪·汉纪二十一"
      },
      {
        "id": "tongjian-c30",
        "title": "汉纪·汉纪二十二"
      },
      {
        "id": "tongjian-c31",
        "title": "汉纪·汉纪二十三"
      },
      {
        "id": "tongjian-c32",
        "title": "汉纪·汉纪二十四"
      },
      {
        "id": "tongjian-c33",
        "title": "汉纪·汉纪二十五"
      },
      {
        "id": "tongjian-c34",
        "title": "汉纪·汉纪二十六"
      },
      {
        "id": "tongjian-c35",
        "title": "汉纪·汉纪二十七"
      },
      {
        "id": "tongjian-c36",
        "title": "汉纪·汉纪二十八"
      },
      {
        "id": "tongjian-c37",
        "title": "汉纪·汉纪二十九"
      },
      {
        "id": "tongjian-c38",
        "title": "汉纪·汉纪三十"
      },
      {
        "id": "tongjian-c39",
        "title": "汉纪·汉纪三十一"
      },
      {
        "id": "tongjian-c40",
        "title": "汉纪·汉纪三十二"
      },
      {
        "id": "tongjian-c41",
        "title": "汉纪·汉纪三十三"
      },
      {
        "id": "tongjian-c42",
        "title": "汉纪·汉纪三十四"
      },
      {
        "id": "tongjian-c43",
        "title": "汉纪·汉纪三十五"
      },
      {
        "id": "tongjian-c44",
        "title": "汉纪·汉纪三十六"
      },
      {
        "id": "tongjian-c45",
        "title": "汉纪·汉纪三十七"
      },
      {
        "id": "tongjian-c46",
        "title": "汉纪·汉纪三十八"
      },
      {
        "id": "tongjian-c47",
        "title": "汉纪·汉纪三十九"
      },
      {
        "id": "tongjian-c48",
        "title": "汉纪·汉纪四十"
      },
      {
        "id": "tongjian-c49",
        "title": "汉纪·汉纪四十一"
      },
      {
        "id": "tongjian-c50",
        "title": "汉纪·汉纪四十二"
      },
      {
        "id": "tongjian-c51",
        "title": "汉纪·汉纪四十三"
      },
      {
        "id": "tongjian-c52",
        "title": "汉纪·汉纪四十四"
      },
      {
        "id": "tongjian-c53",
        "title": "汉纪·汉纪四十五"
      },
      {
        "id": "tongjian-c54",
        "title": "汉纪·汉纪四十六"
      },
      {
        "id": "tongjian-c55",
        "title": "汉纪·汉纪四十七"
      },
      {
        "id": "tongjian-c56",
        "title": "汉纪·汉纪四十八"
      },
      {
        "id": "tongjian-c57",
        "title": "汉纪·汉纪四十九"
      },
      {
        "id": "tongjian-c58",
        "title": "汉纪·汉纪五十"
      },
      {
        "id": "tongjian-c59",
        "title": "汉纪·汉纪五十一"
      },
      {
        "id": "tongjian-c60",
        "title": "汉纪·汉纪五十二"
      },
      {
        "id": "tongjian-c61",
        "title": "汉纪·汉纪五十三"
      },
      {
        "id": "tongjian-c62",
        "title": "汉纪·汉纪五十四"
      },
      {
        "id": "tongjian-c63",
        "title": "汉纪·汉纪五十五"
      },
      {
        "id": "tongjian-c64",
        "title": "汉纪·汉纪五十六"
      },
      {
        "id": "tongjian-c65",
        "title": "汉纪·汉纪五十七"
      },
      {
        "id": "tongjian-c66",
        "title": "汉纪·汉纪五十八"
      },
      {
        "id": "tongjian-c67",
        "title": "汉纪·汉纪五十九"
      },
      {
        "id": "tongjian-c68",
        "title": "汉纪·汉纪六十"
      },
      {
        "id": "tongjian-c69",
        "title": "魏纪·魏纪一"
      },
      {
        "id": "tongjian-c70",
        "title": "魏纪·魏纪二"
      },
      {
        "id": "tongjian-c71",
        "title": "魏纪·魏纪三"
      },
      {
        "id": "tongjian-c72",
        "title": "魏纪·魏纪四"
      },
      {
        "id": "tongjian-c73",
        "title": "魏纪·魏纪五"
      },
      {
        "id": "tongjian-c74",
        "title": "魏纪·魏纪六"
      },
      {
        "id": "tongjian-c75",
        "title": "魏纪·魏纪七"
      },
      {
        "id": "tongjian-c76",
        "title": "魏纪·魏纪八"
      },
      {
        "id": "tongjian-c77",
        "title": "魏纪·魏纪九"
      },
      {
        "id": "tongjian-c78",
        "title": "魏纪·魏纪十"
      },
      {
        "id": "tongjian-c79",
        "title": "晋纪·晋纪一"
      },
      {
        "id": "tongjian-c80",
        "title": "晋纪·晋纪二"
      },
      {
        "id": "tongjian-c81",
        "title": "晋纪·晋纪三"
      },
      {
        "id": "tongjian-c82",
        "title": "晋纪·晋纪四"
      },
      {
        "id": "tongjian-c83",
        "title": "晋纪·晋纪五"
      },
      {
        "id": "tongjian-c84",
        "title": "晋纪·晋纪六"
      },
      {
        "id": "tongjian-c85",
        "title": "晋纪·晋纪七"
      },
      {
        "id": "tongjian-c86",
        "title": "晋纪·晋纪八"
      },
      {
        "id": "tongjian-c87",
        "title": "晋纪·晋纪九"
      },
      {
        "id": "tongjian-c88",
        "title": "晋纪·晋纪十"
      },
      {
        "id": "tongjian-c89",
        "title": "晋纪·晋纪十一"
      },
      {
        "id": "tongjian-c90",
        "title": "晋纪·晋纪十二"
      },
      {
        "id": "tongjian-c91",
        "title": "晋纪·晋纪十三"
      },
      {
        "id": "tongjian-c92",
        "title": "晋纪·晋纪十四"
      },
      {
        "id": "tongjian-c93",
        "title": "晋纪·晋纪十五"
      },
      {
        "id": "tongjian-c94",
        "title": "晋纪·晋纪十六"
      },
      {
        "id": "tongjian-c95",
        "title": "晋纪·晋纪十七"
      },
      {
        "id": "tongjian-c96",
        "title": "晋纪·晋纪十八"
      },
      {
        "id": "tongjian-c97",
        "title": "晋纪·晋纪十九"
      },
      {
        "id": "tongjian-c98",
        "title": "晋纪·晋纪二十"
      },
      {
        "id": "tongjian-c99",
        "title": "晋纪·晋纪二十一"
      },
      {
        "id": "tongjian-c100",
        "title": "晋纪·晋纪二十二"
      },
      {
        "id": "tongjian-c101",
        "title": "晋纪·晋纪二十三"
      },
      {
        "id": "tongjian-c102",
        "title": "晋纪·晋纪二十四"
      },
      {
        "id": "tongjian-c103",
        "title": "晋纪·晋纪二十五"
      },
      {
        "id": "tongjian-c104",
        "title": "晋纪·晋纪二十六"
      },
      {
        "id": "tongjian-c105",
        "title": "晋纪·晋纪二十七"
      },
      {
        "id": "tongjian-c106",
        "title": "晋纪·晋纪二十八"
      },
      {
        "id": "tongjian-c107",
        "title": "晋纪·晋纪二十九"
      },
      {
        "id": "tongjian-c108",
        "title": "晋纪·晋纪三十"
      },
      {
        "id": "tongjian-c109",
        "title": "晋纪·晋纪三十一"
      },
      {
        "id": "tongjian-c110",
        "title": "晋纪·晋纪三十二"
      },
      {
        "id": "tongjian-c111",
        "title": "晋纪·晋纪三十三"
      },
      {
        "id": "tongjian-c112",
        "title": "晋纪·晋纪三十四"
      },
      {
        "id": "tongjian-c113",
        "title": "晋纪·晋纪三十五"
      },
      {
        "id": "tongjian-c114",
        "title": "晋纪·晋纪三十六"
      },
      {
        "id": "tongjian-c115",
        "title": "晋纪·晋纪三十七"
      },
      {
        "id": "tongjian-c116",
        "title": "晋纪·晋纪三十八"
      },
      {
        "id": "tongjian-c117",
        "title": "晋纪·晋纪三十九"
      },
      {
        "id": "tongjian-c118",
        "title": "晋纪·晋纪四十"
      },
      {
        "id": "tongjian-c119",
        "title": "宋纪·宋纪一"
      },
      {
        "id": "tongjian-c120",
        "title": "宋纪·宋纪二"
      },
      {
        "id": "tongjian-c121",
        "title": "宋纪·宋纪三"
      },
      {
        "id": "tongjian-c122",
        "title": "宋纪·宋纪四"
      },
      {
        "id": "tongjian-c123",
        "title": "宋纪·宋纪五"
      },
      {
        "id": "tongjian-c124",
        "title": "宋纪·宋纪六"
      },
      {
        "id": "tongjian-c125",
        "title": "宋纪·宋纪七"
      },
      {
        "id": "tongjian-c126",
        "title": "宋纪·宋纪八"
      },
      {
        "id": "tongjian-c127",
        "title": "宋纪·宋纪九"
      },
      {
        "id": "tongjian-c128",
        "title": "宋纪·宋纪十"
      },
      {
        "id": "tongjian-c129",
        "title": "宋纪·宋纪十一"
      },
      {
        "id": "tongjian-c130",
        "title": "宋纪·宋纪十二"
      },
      {
        "id": "tongjian-c131",
        "title": "宋纪·宋纪十三"
      },
      {
        "id": "tongjian-c132",
        "title": "宋纪·宋纪十四"
      },
      {
        "id": "tongjian-c133",
        "title": "宋纪·宋纪十五"
      },
      {
        "id": "tongjian-c134",
        "title": "宋纪·宋纪十六"
      },
      {
        "id": "tongjian-c135",
        "title": "齐纪·齐纪一"
      },
      {
        "id": "tongjian-c136",
        "title": "齐纪·齐纪二"
      },
      {
        "id": "tongjian-c137",
        "title": "齐纪·齐纪三"
      },
      {
        "id": "tongjian-c138",
        "title": "齐纪·齐纪四"
      },
      {
        "id": "tongjian-c139",
        "title": "齐纪·齐纪五"
      },
      {
        "id": "tongjian-c140",
        "title": "齐纪·齐纪六"
      },
      {
        "id": "tongjian-c141",
        "title": "齐纪·齐纪七"
      },
      {
        "id": "tongjian-c142",
        "title": "齐纪·齐纪八"
      },
      {
        "id": "tongjian-c143",
        "title": "齐纪·齐纪九"
      },
      {
        "id": "tongjian-c144",
        "title": "齐纪·齐纪十"
      },
      {
        "id": "tongjian-c145",
        "title": "梁纪·梁纪一"
      },
      {
        "id": "tongjian-c146",
        "title": "梁纪·梁纪二"
      },
      {
        "id": "tongjian-c147",
        "title": "梁纪·梁纪三"
      },
      {
        "id": "tongjian-c148",
        "title": "梁纪·梁纪四"
      },
      {
        "id": "tongjian-c149",
        "title": "梁纪·梁纪五"
      },
      {
        "id": "tongjian-c150",
        "title": "梁纪·梁纪六"
      },
      {
        "id": "tongjian-c151",
        "title": "梁纪·梁纪七"
      },
      {
        "id": "tongjian-c152",
        "title": "梁纪·梁纪八"
      },
      {
        "id": "tongjian-c153",
        "title": "梁纪·梁纪九"
      },
      {
        "id": "tongjian-c154",
        "title": "梁纪·梁纪十"
      },
      {
        "id": "tongjian-c155",
        "title": "梁纪·梁纪十一"
      },
      {
        "id": "tongjian-c156",
        "title": "梁纪·梁纪十二"
      },
      {
        "id": "tongjian-c157",
        "title": "梁纪·梁纪十三"
      },
      {
        "id": "tongjian-c158",
        "title": "梁纪·梁纪十四"
      },
      {
        "id": "tongjian-c159",
        "title": "梁纪·梁纪十五"
      },
      {
        "id": "tongjian-c160",
        "title": "梁纪·梁纪十六"
      },
      {
        "id": "tongjian-c161",
        "title": "梁纪·梁纪十七"
      },
      {
        "id": "tongjian-c162",
        "title": "梁纪·梁纪十八"
      },
      {
        "id": "tongjian-c163",
        "title": "梁纪·梁纪十九"
      },
      {
        "id": "tongjian-c164",
        "title": "梁纪·梁纪二十"
      },
      {
        "id": "tongjian-c165",
        "title": "梁纪·梁纪二十一"
      },
      {
        "id": "tongjian-c166",
        "title": "梁纪·梁纪二十二"
      },
      {
        "id": "tongjian-c167",
        "title": "陈纪·陈纪一"
      },
      {
        "id": "tongjian-c168",
        "title": "陈纪·陈纪二"
      },
      {
        "id": "tongjian-c169",
        "title": "陈纪·陈纪三"
      },
      {
        "id": "tongjian-c170",
        "title": "陈纪·陈纪四"
      },
      {
        "id": "tongjian-c171",
        "title": "陈纪·陈纪五"
      },
      {
        "id": "tongjian-c172",
        "title": "陈纪·陈纪六"
      },
      {
        "id": "tongjian-c173",
        "title": "陈纪·陈纪七"
      },
      {
        "id": "tongjian-c174",
        "title": "陈纪·陈纪八"
      },
      {
        "id": "tongjian-c175",
        "title": "陈纪·陈纪九"
      },
      {
        "id": "tongjian-c176",
        "title": "陈纪·陈纪十"
      },
      {
        "id": "tongjian-c177",
        "title": "隋纪·隋纪一"
      },
      {
        "id": "tongjian-c178",
        "title": "隋纪·隋纪二"
      },
      {
        "id": "tongjian-c179",
        "title": "隋纪·隋纪三"
      },
      {
        "id": "tongjian-c180",
        "title": "隋纪·隋纪四"
      },
      {
        "id": "tongjian-c181",
        "title": "隋纪·隋纪五"
      },
      {
        "id": "tongjian-c182",
        "title": "隋纪·隋纪六"
      },
      {
        "id": "tongjian-c183",
        "title": "隋纪·隋纪七"
      },
      {
        "id": "tongjian-c184",
        "title": "隋纪·隋纪八"
      },
      {
        "id": "tongjian-c185",
        "title": "唐纪·唐纪一"
      },
      {
        "id": "tongjian-c186",
        "title": "唐纪·唐纪二"
      },
      {
        "id": "tongjian-c187",
        "title": "唐纪·唐纪三"
      },
      {
        "id": "tongjian-c188",
        "title": "唐纪·唐纪四"
      },
      {
        "id": "tongjian-c189",
        "title": "唐纪·唐纪五"
      },
      {
        "id": "tongjian-c190",
        "title": "唐纪·唐纪六"
      },
      {
        "id": "tongjian-c191",
        "title": "唐纪·唐纪七"
      },
      {
        "id": "tongjian-c192",
        "title": "唐纪·唐纪八"
      },
      {
        "id": "tongjian-c193",
        "title": "唐纪·唐纪九"
      },
      {
        "id": "tongjian-c194",
        "title": "唐纪·唐纪十"
      },
      {
        "id": "tongjian-c195",
        "title": "唐纪·唐纪十一"
      },
      {
        "id": "tongjian-c196",
        "title": "唐纪·唐纪十二"
      },
      {
        "id": "tongjian-c197",
        "title": "唐纪·唐纪十三"
      },
      {
        "id": "tongjian-c198",
        "title": "唐纪·唐纪十四"
      },
      {
        "id": "tongjian-c199",
        "title": "唐纪·唐纪十五"
      },
      {
        "id": "tongjian-c200",
        "title": "唐纪·唐纪十六"
      },
      {
        "id": "tongjian-c201",
        "title": "唐纪·唐纪十七"
      },
      {
        "id": "tongjian-c202",
        "title": "唐纪·唐纪十八"
      },
      {
        "id": "tongjian-c203",
        "title": "唐纪·唐纪十九"
      },
      {
        "id": "tongjian-c204",
        "title": "唐纪·唐纪二十"
      },
      {
        "id": "tongjian-c205",
        "title": "唐纪·唐纪二十一"
      },
      {
        "id": "tongjian-c206",
        "title": "唐纪·唐纪二十二"
      },
      {
        "id": "tongjian-c207",
        "title": "唐纪·唐纪二十三"
      },
      {
        "id": "tongjian-c208",
        "title": "唐纪·唐纪二十四"
      },
      {
        "id": "tongjian-c209",
        "title": "唐纪·唐纪二十五"
      },
      {
        "id": "tongjian-c210",
        "title": "唐纪·唐纪二十六"
      },
      {
        "id": "tongjian-c211",
        "title": "唐纪·唐纪二十七"
      },
      {
        "id": "tongjian-c212",
        "title": "唐纪·唐纪二十八"
      },
      {
        "id": "tongjian-c213",
        "title": "唐纪·唐纪二十九"
      },
      {
        "id": "tongjian-c214",
        "title": "唐纪·唐纪三十"
      },
      {
        "id": "tongjian-c215",
        "title": "唐纪·唐纪三十一"
      },
      {
        "id": "tongjian-c216",
        "title": "唐纪·唐纪三十二"
      },
      {
        "id": "tongjian-c217",
        "title": "唐纪·唐纪三十三"
      },
      {
        "id": "tongjian-c218",
        "title": "唐纪·唐纪三十四"
      },
      {
        "id": "tongjian-c219",
        "title": "唐纪·唐纪三十五"
      },
      {
        "id": "tongjian-c220",
        "title": "唐纪·唐纪三十六"
      },
      {
        "id": "tongjian-c221",
        "title": "唐纪·唐纪三十七"
      },
      {
        "id": "tongjian-c222",
        "title": "唐纪·唐纪三十八"
      },
      {
        "id": "tongjian-c223",
        "title": "唐纪·唐纪三十九"
      },
      {
        "id": "tongjian-c224",
        "title": "唐纪·唐纪四十"
      },
      {
        "id": "tongjian-c225",
        "title": "唐纪·唐纪四十一"
      },
      {
        "id": "tongjian-c226",
        "title": "唐纪·唐纪四十二"
      },
      {
        "id": "tongjian-c227",
        "title": "唐纪·唐纪四十三"
      },
      {
        "id": "tongjian-c228",
        "title": "唐纪·唐纪四十四"
      },
      {
        "id": "tongjian-c229",
        "title": "唐纪·唐纪四十五"
      },
      {
        "id": "tongjian-c230",
        "title": "唐纪·唐纪四十六"
      },
      {
        "id": "tongjian-c231",
        "title": "唐纪·唐纪四十七"
      },
      {
        "id": "tongjian-c232",
        "title": "唐纪·唐纪四十八"
      },
      {
        "id": "tongjian-c233",
        "title": "唐纪·唐纪四十九"
      },
      {
        "id": "tongjian-c234",
        "title": "唐纪·唐纪五十"
      },
      {
        "id": "tongjian-c235",
        "title": "唐纪·唐纪五十一"
      },
      {
        "id": "tongjian-c236",
        "title": "唐纪·唐纪五十二"
      },
      {
        "id": "tongjian-c237",
        "title": "唐纪·唐纪五十三"
      },
      {
        "id": "tongjian-c238",
        "title": "唐纪·唐纪五十四"
      },
      {
        "id": "tongjian-c239",
        "title": "唐纪·唐纪五十五"
      },
      {
        "id": "tongjian-c240",
        "title": "唐纪·唐纪五十六"
      },
      {
        "id": "tongjian-c241",
        "title": "唐纪·唐纪五十七"
      },
      {
        "id": "tongjian-c242",
        "title": "唐纪·唐纪五十八"
      },
      {
        "id": "tongjian-c243",
        "title": "唐纪·唐纪五十九"
      },
      {
        "id": "tongjian-c244",
        "title": "唐纪·唐纪六十"
      },
      {
        "id": "tongjian-c245",
        "title": "唐纪·唐纪六十一"
      },
      {
        "id": "tongjian-c246",
        "title": "唐纪·唐纪六十二"
      },
      {
        "id": "tongjian-c247",
        "title": "唐纪·唐纪六十三"
      },
      {
        "id": "tongjian-c248",
        "title": "唐纪·唐纪六十四"
      },
      {
        "id": "tongjian-c249",
        "title": "唐纪·唐纪六十五"
      },
      {
        "id": "tongjian-c250",
        "title": "唐纪·唐纪六十六"
      },
      {
        "id": "tongjian-c251",
        "title": "唐纪·唐纪六十七"
      },
      {
        "id": "tongjian-c252",
        "title": "唐纪·唐纪六十八"
      },
      {
        "id": "tongjian-c253",
        "title": "唐纪·唐纪六十九"
      },
      {
        "id": "tongjian-c254",
        "title": "唐纪·唐纪七十"
      },
      {
        "id": "tongjian-c255",
        "title": "唐纪·唐纪七十一"
      },
      {
        "id": "tongjian-c256",
        "title": "唐纪·唐纪七十二"
      },
      {
        "id": "tongjian-c257",
        "title": "唐纪·唐纪七十三"
      },
      {
        "id": "tongjian-c258",
        "title": "唐纪·唐纪七十四"
      },
      {
        "id": "tongjian-c259",
        "title": "唐纪·唐纪七十五"
      },
      {
        "id": "tongjian-c260",
        "title": "唐纪·唐纪七十六"
      },
      {
        "id": "tongjian-c261",
        "title": "唐纪·唐纪七十七"
      },
      {
        "id": "tongjian-c262",
        "title": "唐纪·唐纪七十八"
      },
      {
        "id": "tongjian-c263",
        "title": "唐纪·唐纪七十九"
      },
      {
        "id": "tongjian-c264",
        "title": "唐纪·唐纪八十"
      },
      {
        "id": "tongjian-c265",
        "title": "唐纪·唐纪八十一"
      },
      {
        "id": "tongjian-c266",
        "title": "后梁纪·后梁纪一"
      },
      {
        "id": "tongjian-c267",
        "title": "后梁纪·后梁纪二"
      },
      {
        "id": "tongjian-c268",
        "title": "后梁纪·后梁纪三"
      },
      {
        "id": "tongjian-c269",
        "title": "后梁纪·后梁纪四"
      },
      {
        "id": "tongjian-c270",
        "title": "后梁纪·后梁纪五"
      },
      {
        "id": "tongjian-c271",
        "title": "后梁纪·后梁纪六"
      },
      {
        "id": "tongjian-c272",
        "title": "后唐纪·后唐纪一"
      },
      {
        "id": "tongjian-c273",
        "title": "后唐纪·后唐纪二"
      },
      {
        "id": "tongjian-c274",
        "title": "后唐纪·后唐纪三"
      },
      {
        "id": "tongjian-c275",
        "title": "后唐纪·后唐纪四"
      },
      {
        "id": "tongjian-c276",
        "title": "后唐纪·后唐纪五"
      },
      {
        "id": "tongjian-c277",
        "title": "后唐纪·后唐纪六"
      },
      {
        "id": "tongjian-c278",
        "title": "后唐纪·后唐纪七"
      },
      {
        "id": "tongjian-c279",
        "title": "后唐纪·后唐纪八"
      },
      {
        "id": "tongjian-c280",
        "title": "后晋纪·后晋纪一"
      },
      {
        "id": "tongjian-c281",
        "title": "后晋纪·后晋纪二"
      },
      {
        "id": "tongjian-c282",
        "title": "后晋纪·后晋纪三"
      },
      {
        "id": "tongjian-c283",
        "title": "后晋纪·后晋纪四"
      },
      {
        "id": "tongjian-c284",
        "title": "后晋纪·后晋纪五"
      },
      {
        "id": "tongjian-c285",
        "title": "后晋纪·后晋纪六"
      },
      {
        "id": "tongjian-c286",
        "title": "后汉纪·后汉纪一"
      },
      {
        "id": "tongjian-c287",
        "title": "后汉纪·后汉纪二"
      },
      {
        "id": "tongjian-c288",
        "title": "后汉纪·后汉纪三"
      },
      {
        "id": "tongjian-c289",
        "title": "后汉纪·后汉纪四"
      },
      {
        "id": "tongjian-c290",
        "title": "后周纪·后周纪一"
      },
      {
        "id": "tongjian-c291",
        "title": "后周纪·后周纪二"
      },
      {
        "id": "tongjian-c292",
        "title": "后周纪·后周纪三"
      },
      {
        "id": "tongjian-c293",
        "title": "后周纪·后周纪四"
      },
      {
        "id": "tongjian-c294",
        "title": "后周纪·后周纪五"
      }
    ]
  },
  {
    "id": "mozi",
    "title": "墨子",
    "author": "墨翟",
    "category": "zi",
    "description": "墨家创始经典，墨翟及后学所著，主张兼爱、非攻、尚贤、节用。本版为全本。",
    "dynasty": "战国",
    "sizeBytes": 277911,
    "toc": [
      {
        "id": "mozi-c1",
        "title": "亲士"
      },
      {
        "id": "mozi-c2",
        "title": "修身"
      },
      {
        "id": "mozi-c3",
        "title": "所染"
      },
      {
        "id": "mozi-c4",
        "title": "法仪"
      },
      {
        "id": "mozi-c5",
        "title": "七患"
      },
      {
        "id": "mozi-c6",
        "title": "辞过"
      },
      {
        "id": "mozi-c7",
        "title": "三辩"
      },
      {
        "id": "mozi-c8",
        "title": "尚贤上"
      },
      {
        "id": "mozi-c9",
        "title": "尚贤中"
      },
      {
        "id": "mozi-c10",
        "title": "尚贤下"
      },
      {
        "id": "mozi-c11",
        "title": "尚同上"
      },
      {
        "id": "mozi-c12",
        "title": "尚同中"
      },
      {
        "id": "mozi-c13",
        "title": "尚同下"
      },
      {
        "id": "mozi-c14",
        "title": "兼爱上"
      },
      {
        "id": "mozi-c15",
        "title": "兼爱中"
      },
      {
        "id": "mozi-c16",
        "title": "兼爱下"
      },
      {
        "id": "mozi-c17",
        "title": "非攻上"
      },
      {
        "id": "mozi-c18",
        "title": "非攻中"
      },
      {
        "id": "mozi-c19",
        "title": "非攻下"
      },
      {
        "id": "mozi-c20",
        "title": "节用上"
      },
      {
        "id": "mozi-c21",
        "title": "节用中"
      },
      {
        "id": "mozi-c22",
        "title": "节葬下"
      },
      {
        "id": "mozi-c23",
        "title": "天志上"
      },
      {
        "id": "mozi-c24",
        "title": "天志中"
      },
      {
        "id": "mozi-c25",
        "title": "天志下"
      },
      {
        "id": "mozi-c26",
        "title": "明鬼下"
      },
      {
        "id": "mozi-c27",
        "title": "非乐上"
      },
      {
        "id": "mozi-c28",
        "title": "非命上"
      },
      {
        "id": "mozi-c29",
        "title": "非命中"
      },
      {
        "id": "mozi-c30",
        "title": "非命下"
      },
      {
        "id": "mozi-c31",
        "title": "非儒上"
      },
      {
        "id": "mozi-c32",
        "title": "非儒下"
      },
      {
        "id": "mozi-c33",
        "title": "经上"
      },
      {
        "id": "mozi-c34",
        "title": "经下"
      },
      {
        "id": "mozi-c35",
        "title": "经说上"
      },
      {
        "id": "mozi-c36",
        "title": "经说下"
      },
      {
        "id": "mozi-c37",
        "title": "大取"
      },
      {
        "id": "mozi-c38",
        "title": "小取"
      },
      {
        "id": "mozi-c39",
        "title": "耕柱"
      },
      {
        "id": "mozi-c40",
        "title": "贵义"
      },
      {
        "id": "mozi-c41",
        "title": "公孟"
      },
      {
        "id": "mozi-c42",
        "title": "鲁问"
      },
      {
        "id": "mozi-c43",
        "title": "公输"
      },
      {
        "id": "mozi-c44",
        "title": "备城门"
      },
      {
        "id": "mozi-c45",
        "title": "备高临"
      },
      {
        "id": "mozi-c46",
        "title": "备梯"
      },
      {
        "id": "mozi-c47",
        "title": "备水"
      },
      {
        "id": "mozi-c48",
        "title": "备突"
      },
      {
        "id": "mozi-c49",
        "title": "备穴"
      },
      {
        "id": "mozi-c50",
        "title": "备蛾傅"
      },
      {
        "id": "mozi-c51",
        "title": "迎敌祠"
      },
      {
        "id": "mozi-c52",
        "title": "旗帜"
      },
      {
        "id": "mozi-c53",
        "title": "号令"
      },
      {
        "id": "mozi-c54",
        "title": "杂守"
      }
    ]
  },
  {
    "id": "songci",
    "title": "宋词三百首",
    "author": "朱祖谋 编",
    "category": "ji",
    "description": "近人朱祖谋编选宋词选集，共收词 291 首。本版为全本。",
    "dynasty": "宋",
    "sizeBytes": 83747,
    "toc": [
      {
        "id": "songci-c1",
        "title": "刘克庄"
      },
      {
        "id": "songci-c2",
        "title": "韩疁"
      },
      {
        "id": "songci-c3",
        "title": "孙光宪"
      },
      {
        "id": "songci-c4",
        "title": "辛弃疾"
      },
      {
        "id": "songci-c5",
        "title": "赵佶"
      },
      {
        "id": "songci-c6",
        "title": "冯延巳"
      },
      {
        "id": "songci-c7",
        "title": "韦庄"
      },
      {
        "id": "songci-c8",
        "title": "韩元吉"
      },
      {
        "id": "songci-c9",
        "title": "李煜"
      },
      {
        "id": "songci-c10",
        "title": "文及翁"
      },
      {
        "id": "songci-c11",
        "title": "范仲淹"
      },
      {
        "id": "songci-c12",
        "title": "仲殊"
      },
      {
        "id": "songci-c13",
        "title": "韩缜"
      },
      {
        "id": "songci-c14",
        "title": "徐昌图"
      },
      {
        "id": "songci-c15",
        "title": "柳永"
      },
      {
        "id": "songci-c16",
        "title": "牛峤"
      },
      {
        "id": "songci-c17",
        "title": "李璟"
      },
      {
        "id": "songci-c18",
        "title": "蒋捷"
      },
      {
        "id": "songci-c19",
        "title": "白居易"
      },
      {
        "id": "songci-c20",
        "title": "朱淑真"
      },
      {
        "id": "songci-c21",
        "title": "姜夔"
      },
      {
        "id": "songci-c22",
        "title": "李白"
      },
      {
        "id": "songci-c23",
        "title": "张先"
      },
      {
        "id": "songci-c24",
        "title": "王安石"
      },
      {
        "id": "songci-c25",
        "title": "岳飞"
      },
      {
        "id": "songci-c26",
        "title": "晁补之"
      },
      {
        "id": "songci-c27",
        "title": "石孝友"
      },
      {
        "id": "songci-c28",
        "title": "张孝祥"
      },
      {
        "id": "songci-c29",
        "title": "曹勋"
      },
      {
        "id": "songci-c30",
        "title": "赵长卿"
      },
      {
        "id": "songci-c31",
        "title": "周邦彦"
      },
      {
        "id": "songci-c32",
        "title": "黄庭坚"
      },
      {
        "id": "songci-c33",
        "title": "黄孝迈"
      },
      {
        "id": "songci-c34",
        "title": "苏轼"
      },
      {
        "id": "songci-c35",
        "title": "秦观"
      },
      {
        "id": "songci-c36",
        "title": "陆游"
      },
      {
        "id": "songci-c37",
        "title": "李珣"
      },
      {
        "id": "songci-c38",
        "title": "周紫芝"
      },
      {
        "id": "songci-c39",
        "title": "时彦"
      },
      {
        "id": "songci-c40",
        "title": "贺铸"
      },
      {
        "id": "songci-c41",
        "title": "黄裳"
      },
      {
        "id": "songci-c42",
        "title": "吴文英"
      },
      {
        "id": "songci-c43",
        "title": "李元膺"
      },
      {
        "id": "songci-c44",
        "title": "李清照"
      },
      {
        "id": "songci-c45",
        "title": "严仁"
      },
      {
        "id": "songci-c46",
        "title": "欧阳修"
      },
      {
        "id": "songci-c47",
        "title": "房舜卿"
      },
      {
        "id": "songci-c48",
        "title": "谢逸"
      },
      {
        "id": "songci-c49",
        "title": "刘辰翁"
      },
      {
        "id": "songci-c50",
        "title": "晏几道"
      },
      {
        "id": "songci-c51",
        "title": "王清惠"
      },
      {
        "id": "songci-c52",
        "title": "晏殊"
      },
      {
        "id": "songci-c53",
        "title": "陈亮"
      },
      {
        "id": "songci-c54",
        "title": "黄公绍"
      },
      {
        "id": "songci-c55",
        "title": "刘禹锡"
      },
      {
        "id": "songci-c56",
        "title": "佚名"
      },
      {
        "id": "songci-c57",
        "title": "杨无咎"
      },
      {
        "id": "songci-c58",
        "title": "俞国宝"
      },
      {
        "id": "songci-c59",
        "title": "毛滂"
      },
      {
        "id": "songci-c60",
        "title": "皇甫松"
      },
      {
        "id": "songci-c61",
        "title": "温庭筠"
      },
      {
        "id": "songci-c62",
        "title": "潘阆"
      },
      {
        "id": "songci-c63",
        "title": "宋祁"
      },
      {
        "id": "songci-c64",
        "title": "宋自逊"
      },
      {
        "id": "songci-c65",
        "title": "陈东甫"
      },
      {
        "id": "songci-c66",
        "title": "刘过"
      },
      {
        "id": "songci-c67",
        "title": "吴潜"
      },
      {
        "id": "songci-c68",
        "title": "袁去华"
      },
      {
        "id": "songci-c69",
        "title": "史达祖"
      },
      {
        "id": "songci-c70",
        "title": "张元干"
      },
      {
        "id": "songci-c71",
        "title": "王安国"
      },
      {
        "id": "songci-c72",
        "title": "范成大"
      },
      {
        "id": "songci-c73",
        "title": "张耒"
      },
      {
        "id": "songci-c74",
        "title": "黄机"
      },
      {
        "id": "songci-c75",
        "title": "叶梦得"
      },
      {
        "id": "songci-c76",
        "title": "蒋氏女"
      },
      {
        "id": "songci-c77",
        "title": "吕本中"
      },
      {
        "id": "songci-c78",
        "title": "王建"
      },
      {
        "id": "songci-c79",
        "title": "戴叔伦"
      },
      {
        "id": "songci-c80",
        "title": "李重元"
      },
      {
        "id": "songci-c81",
        "title": "张抡"
      },
      {
        "id": "songci-c82",
        "title": "牛希济"
      },
      {
        "id": "songci-c83",
        "title": "朱敦儒"
      },
      {
        "id": "songci-c84",
        "title": "黄升"
      },
      {
        "id": "songci-c85",
        "title": "朱服"
      },
      {
        "id": "songci-c86",
        "title": "王雱"
      },
      {
        "id": "songci-c87",
        "title": "杨万里"
      },
      {
        "id": "songci-c88",
        "title": "陈与义"
      },
      {
        "id": "songci-c89",
        "title": "李好古"
      },
      {
        "id": "songci-c90",
        "title": "张舜民"
      },
      {
        "id": "songci-c91",
        "title": "卢祖皋"
      },
      {
        "id": "songci-c92",
        "title": "程垓"
      },
      {
        "id": "songci-c93",
        "title": "严蕊"
      },
      {
        "id": "songci-c94",
        "title": "汪藻"
      },
      {
        "id": "songci-c95",
        "title": "向子諲"
      },
      {
        "id": "songci-c96",
        "title": "张昪"
      },
      {
        "id": "songci-c97",
        "title": "曹组"
      },
      {
        "id": "songci-c98",
        "title": "顾夐"
      },
      {
        "id": "songci-c99",
        "title": "李之仪"
      },
      {
        "id": "songci-c100",
        "title": "王炎"
      },
      {
        "id": "songci-c101",
        "title": "戴复古"
      },
      {
        "id": "songci-c102",
        "title": "张炎"
      },
      {
        "id": "songci-c103",
        "title": "叶清臣"
      },
      {
        "id": "songci-c104",
        "title": "方岳"
      },
      {
        "id": "songci-c105",
        "title": "王禹偁"
      },
      {
        "id": "songci-c106",
        "title": "王观"
      },
      {
        "id": "songci-c107",
        "title": "侯蒙"
      },
      {
        "id": "songci-c108",
        "title": "张志和"
      },
      {
        "id": "songci-c109",
        "title": "寇准"
      },
      {
        "id": "songci-c110",
        "title": "林逋"
      },
      {
        "id": "songci-c111",
        "title": "薛昭蕴"
      },
      {
        "id": "songci-c112",
        "title": "唐婉"
      },
      {
        "id": "songci-c113",
        "title": "蔡伸"
      },
      {
        "id": "songci-c114",
        "title": "卢炳"
      },
      {
        "id": "songci-c115",
        "title": "万俟咏"
      }
    ]
  },
  {
    "id": "yuanqu",
    "title": "元曲",
    "author": "元代曲家",
    "category": "ji",
    "description": "元曲总集（散曲与剧曲套数），收 11057 首、 233 家。本版为全本。",
    "dynasty": "元",
    "sizeBytes": 3505564,
    "toc": [
      {
        "id": "yuanqu-c1",
        "title": "关汉卿"
      },
      {
        "id": "yuanqu-c2",
        "title": "阚志学"
      },
      {
        "id": "yuanqu-c3",
        "title": "王实甫"
      },
      {
        "id": "yuanqu-c4",
        "title": "杨维桢"
      },
      {
        "id": "yuanqu-c5",
        "title": "蒲察善长"
      },
      {
        "id": "yuanqu-c6",
        "title": "白贲"
      },
      {
        "id": "yuanqu-c7",
        "title": "查德卿"
      },
      {
        "id": "yuanqu-c8",
        "title": "无名氏《宦门子弟错立身》"
      },
      {
        "id": "yuanqu-c9",
        "title": "高克礼"
      },
      {
        "id": "yuanqu-c10",
        "title": "李唐宾"
      },
      {
        "id": "yuanqu-c11",
        "title": "无名氏"
      },
      {
        "id": "yuanqu-c12",
        "title": "王伯成"
      },
      {
        "id": "yuanqu-c13",
        "title": "孔文升"
      },
      {
        "id": "yuanqu-c14",
        "title": "白朴"
      },
      {
        "id": "yuanqu-c15",
        "title": "赵善庆"
      },
      {
        "id": "yuanqu-c16",
        "title": "沈禧"
      },
      {
        "id": "yuanqu-c17",
        "title": "马致远"
      },
      {
        "id": "yuanqu-c18",
        "title": "石君宝"
      },
      {
        "id": "yuanqu-c19",
        "title": "童童学士"
      },
      {
        "id": "yuanqu-c20",
        "title": "杨显之"
      },
      {
        "id": "yuanqu-c21",
        "title": "杜仁杰"
      },
      {
        "id": "yuanqu-c22",
        "title": "李好古"
      },
      {
        "id": "yuanqu-c23",
        "title": "陈克明"
      },
      {
        "id": "yuanqu-c24",
        "title": "高明"
      },
      {
        "id": "yuanqu-c25",
        "title": "云龛子"
      },
      {
        "id": "yuanqu-c26",
        "title": "高文秀"
      },
      {
        "id": "yuanqu-c27",
        "title": "张子坚"
      },
      {
        "id": "yuanqu-c28",
        "title": "康进之"
      },
      {
        "id": "yuanqu-c29",
        "title": "王恽"
      },
      {
        "id": "yuanqu-c30",
        "title": "孔文卿"
      },
      {
        "id": "yuanqu-c31",
        "title": "孙周卿"
      },
      {
        "id": "yuanqu-c32",
        "title": "刘唐卿"
      },
      {
        "id": "yuanqu-c33",
        "title": "薛昂夫"
      },
      {
        "id": "yuanqu-c34",
        "title": "王子一"
      },
      {
        "id": "yuanqu-c35",
        "title": "马谦斋"
      },
      {
        "id": "yuanqu-c36",
        "title": "狄君厚"
      },
      {
        "id": "yuanqu-c37",
        "title": "钟嗣成"
      },
      {
        "id": "yuanqu-c38",
        "title": "杨朝英"
      },
      {
        "id": "yuanqu-c39",
        "title": "纪君祥"
      },
      {
        "id": "yuanqu-c40",
        "title": "孙仲章"
      },
      {
        "id": "yuanqu-c41",
        "title": "谢应芳"
      },
      {
        "id": "yuanqu-c42",
        "title": "萧德祥"
      },
      {
        "id": "yuanqu-c43",
        "title": "郑光祖"
      },
      {
        "id": "yuanqu-c44",
        "title": "睢玄明"
      },
      {
        "id": "yuanqu-c45",
        "title": "郑延玉"
      },
      {
        "id": "yuanqu-c46",
        "title": "徐田臣《杀狗记》"
      },
      {
        "id": "yuanqu-c47",
        "title": "杨舜臣"
      },
      {
        "id": "yuanqu-c48",
        "title": "贾仲明"
      },
      {
        "id": "yuanqu-c49",
        "title": "宫天挺"
      },
      {
        "id": "yuanqu-c50",
        "title": "杨梓"
      },
      {
        "id": "yuanqu-c51",
        "title": "盍志学"
      },
      {
        "id": "yuanqu-c52",
        "title": "元好问"
      },
      {
        "id": "yuanqu-c53",
        "title": "顾德润"
      },
      {
        "id": "yuanqu-c54",
        "title": "徐琰"
      },
      {
        "id": "yuanqu-c55",
        "title": "任昱"
      },
      {
        "id": "yuanqu-c56",
        "title": "费唐臣"
      },
      {
        "id": "yuanqu-c57",
        "title": "季子安"
      },
      {
        "id": "yuanqu-c58",
        "title": "苏彦文"
      },
      {
        "id": "yuanqu-c59",
        "title": "杨景贤"
      },
      {
        "id": "yuanqu-c60",
        "title": "无名氏《张协状元》"
      },
      {
        "id": "yuanqu-c61",
        "title": "施惠"
      },
      {
        "id": "yuanqu-c62",
        "title": "王大学士"
      },
      {
        "id": "yuanqu-c63",
        "title": "孛罗御史"
      },
      {
        "id": "yuanqu-c64",
        "title": "吴昌龄"
      },
      {
        "id": "yuanqu-c65",
        "title": "施惠《幽闺记》"
      },
      {
        "id": "yuanqu-c66",
        "title": "尚仲贤"
      },
      {
        "id": "yuanqu-c67",
        "title": "李子昌"
      },
      {
        "id": "yuanqu-c68",
        "title": "金仁杰"
      },
      {
        "id": "yuanqu-c69",
        "title": "阿里耀卿"
      },
      {
        "id": "yuanqu-c70",
        "title": "一分儿"
      },
      {
        "id": "yuanqu-c71",
        "title": "兰楚芳"
      },
      {
        "id": "yuanqu-c72",
        "title": "赵君祥"
      },
      {
        "id": "yuanqu-c73",
        "title": "范居中"
      },
      {
        "id": "yuanqu-c74",
        "title": "徐田臣"
      },
      {
        "id": "yuanqu-c75",
        "title": "梁寅"
      },
      {
        "id": "yuanqu-c76",
        "title": "王元和"
      },
      {
        "id": "yuanqu-c77",
        "title": "彭寿之"
      },
      {
        "id": "yuanqu-c78",
        "title": "李直夫"
      },
      {
        "id": "yuanqu-c79",
        "title": "邓学可"
      },
      {
        "id": "yuanqu-c80",
        "title": "吴镇"
      },
      {
        "id": "yuanqu-c81",
        "title": "王举之"
      },
      {
        "id": "yuanqu-c82",
        "title": "邓玉宾"
      },
      {
        "id": "yuanqu-c83",
        "title": "蒲道源"
      },
      {
        "id": "yuanqu-c84",
        "title": "黄公望"
      },
      {
        "id": "yuanqu-c85",
        "title": "邓玉宾子"
      },
      {
        "id": "yuanqu-c86",
        "title": "王仲文"
      },
      {
        "id": "yuanqu-c87",
        "title": "张弘范"
      },
      {
        "id": "yuanqu-c88",
        "title": "高茂卿"
      },
      {
        "id": "yuanqu-c89",
        "title": "武汉臣"
      },
      {
        "id": "yuanqu-c90",
        "title": "程景初"
      },
      {
        "id": "yuanqu-c91",
        "title": "张彦文"
      },
      {
        "id": "yuanqu-c92",
        "title": "吕止庵"
      },
      {
        "id": "yuanqu-c93",
        "title": "黑老五"
      },
      {
        "id": "yuanqu-c94",
        "title": "景元启"
      },
      {
        "id": "yuanqu-c95",
        "title": "严忠济"
      },
      {
        "id": "yuanqu-c96",
        "title": "汤舜民"
      },
      {
        "id": "yuanqu-c97",
        "title": "史九散人"
      },
      {
        "id": "yuanqu-c98",
        "title": "石子章"
      },
      {
        "id": "yuanqu-c99",
        "title": "姚燧"
      },
      {
        "id": "yuanqu-c100",
        "title": "奥敦周卿"
      },
      {
        "id": "yuanqu-c101",
        "title": "伯颜"
      },
      {
        "id": "yuanqu-c102",
        "title": "曹德"
      },
      {
        "id": "yuanqu-c103",
        "title": "罗贯中"
      },
      {
        "id": "yuanqu-c104",
        "title": "赵天锡"
      },
      {
        "id": "yuanqu-c105",
        "title": "高秀文"
      },
      {
        "id": "yuanqu-c106",
        "title": "刘伯亨"
      },
      {
        "id": "yuanqu-c107",
        "title": "卢挚"
      },
      {
        "id": "yuanqu-c108",
        "title": "卫立中"
      },
      {
        "id": "yuanqu-c109",
        "title": "赵显宏"
      },
      {
        "id": "yuanqu-c110",
        "title": "王爱山"
      },
      {
        "id": "yuanqu-c111",
        "title": "不忽木"
      },
      {
        "id": "yuanqu-c112",
        "title": "邾仲谊"
      },
      {
        "id": "yuanqu-c113",
        "title": "赵雍"
      },
      {
        "id": "yuanqu-c114",
        "title": "鲜于枢"
      },
      {
        "id": "yuanqu-c115",
        "title": "李文蔚"
      },
      {
        "id": "yuanqu-c116",
        "title": "王嘉甫"
      },
      {
        "id": "yuanqu-c117",
        "title": "王和卿"
      },
      {
        "id": "yuanqu-c118",
        "title": "吴西逸"
      },
      {
        "id": "yuanqu-c119",
        "title": "高明《蔡伯喈琵琶记》"
      },
      {
        "id": "yuanqu-c120",
        "title": "胡用和"
      },
      {
        "id": "yuanqu-c121",
        "title": "赵秉文"
      },
      {
        "id": "yuanqu-c122",
        "title": "庾吉甫"
      },
      {
        "id": "yuanqu-c123",
        "title": "张子友"
      },
      {
        "id": "yuanqu-c124",
        "title": "王仲元"
      },
      {
        "id": "yuanqu-c125",
        "title": "乔吉"
      },
      {
        "id": "yuanqu-c126",
        "title": "朱庭玉"
      },
      {
        "id": "yuanqu-c127",
        "title": "秦简夫"
      },
      {
        "id": "yuanqu-c128",
        "title": "丘士元"
      },
      {
        "id": "yuanqu-c129",
        "title": "杨立斋"
      },
      {
        "id": "yuanqu-c130",
        "title": "刘因"
      },
      {
        "id": "yuanqu-c131",
        "title": "贯云石"
      },
      {
        "id": "yuanqu-c132",
        "title": "陈草庵"
      },
      {
        "id": "yuanqu-c133",
        "title": "盍西村"
      },
      {
        "id": "yuanqu-c134",
        "title": "张雨"
      },
      {
        "id": "yuanqu-c135",
        "title": "班惟志"
      },
      {
        "id": "yuanqu-c136",
        "title": "赵彦晖"
      },
      {
        "id": "yuanqu-c137",
        "title": "宋方壶"
      },
      {
        "id": "yuanqu-c138",
        "title": "李茂之"
      },
      {
        "id": "yuanqu-c139",
        "title": "爱山"
      },
      {
        "id": "yuanqu-c140",
        "title": "唐毅夫"
      },
      {
        "id": "yuanqu-c141",
        "title": "詹时雨"
      },
      {
        "id": "yuanqu-c142",
        "title": "阿鲁威"
      },
      {
        "id": "yuanqu-c143",
        "title": "刘庭信"
      },
      {
        "id": "yuanqu-c144",
        "title": "张国宾"
      },
      {
        "id": "yuanqu-c145",
        "title": "张可久"
      },
      {
        "id": "yuanqu-c146",
        "title": "姚守中"
      },
      {
        "id": "yuanqu-c147",
        "title": "邵元长"
      },
      {
        "id": "yuanqu-c148",
        "title": "李寿卿"
      },
      {
        "id": "yuanqu-c149",
        "title": "吕侍中"
      },
      {
        "id": "yuanqu-c150",
        "title": "刘时中"
      },
      {
        "id": "yuanqu-c151",
        "title": "张寿卿"
      },
      {
        "id": "yuanqu-c152",
        "title": "钱霖"
      },
      {
        "id": "yuanqu-c153",
        "title": "秦竹村"
      },
      {
        "id": "yuanqu-c154",
        "title": "王修甫"
      },
      {
        "id": "yuanqu-c155",
        "title": "范康"
      },
      {
        "id": "yuanqu-c156",
        "title": "戴善甫"
      },
      {
        "id": "yuanqu-c157",
        "title": "吕济民"
      },
      {
        "id": "yuanqu-c158",
        "title": "荆干臣"
      },
      {
        "id": "yuanqu-c159",
        "title": "虞集"
      },
      {
        "id": "yuanqu-c160",
        "title": "王晔"
      },
      {
        "id": "yuanqu-c161",
        "title": "李行甫"
      },
      {
        "id": "yuanqu-c162",
        "title": "岳伯川"
      },
      {
        "id": "yuanqu-c163",
        "title": "孙梁"
      },
      {
        "id": "yuanqu-c164",
        "title": "刘秉忠"
      },
      {
        "id": "yuanqu-c165",
        "title": "王德信"
      },
      {
        "id": "yuanqu-c166",
        "title": "李伯瑜"
      },
      {
        "id": "yuanqu-c167",
        "title": "王仲诚"
      },
      {
        "id": "yuanqu-c168",
        "title": "张氏"
      },
      {
        "id": "yuanqu-c169",
        "title": "沙正卿"
      },
      {
        "id": "yuanqu-c170",
        "title": "赵莹"
      },
      {
        "id": "yuanqu-c171",
        "title": "张鸣善"
      },
      {
        "id": "yuanqu-c172",
        "title": "邦哲"
      },
      {
        "id": "yuanqu-c173",
        "title": "赵明道"
      },
      {
        "id": "yuanqu-c174",
        "title": "孟汉卿"
      },
      {
        "id": "yuanqu-c175",
        "title": "沈和"
      },
      {
        "id": "yuanqu-c176",
        "title": "贯石屏"
      },
      {
        "id": "yuanqu-c177",
        "title": "夏庭芝"
      },
      {
        "id": "yuanqu-c178",
        "title": "张养浩"
      },
      {
        "id": "yuanqu-c179",
        "title": "魏初"
      },
      {
        "id": "yuanqu-c180",
        "title": "周文质"
      },
      {
        "id": "yuanqu-c181",
        "title": "睢景臣"
      },
      {
        "id": "yuanqu-c182",
        "title": "刘敏中"
      },
      {
        "id": "yuanqu-c183",
        "title": "真氏"
      },
      {
        "id": "yuanqu-c184",
        "title": "大食惟寅"
      },
      {
        "id": "yuanqu-c185",
        "title": "珠帘秀"
      },
      {
        "id": "yuanqu-c186",
        "title": "柯丹邱《荆钗记》"
      },
      {
        "id": "yuanqu-c187",
        "title": "滕斌"
      },
      {
        "id": "yuanqu-c188",
        "title": "孙季昌"
      },
      {
        "id": "yuanqu-c189",
        "title": "刘君锡"
      },
      {
        "id": "yuanqu-c190",
        "title": "李致远"
      },
      {
        "id": "yuanqu-c191",
        "title": "萧德祥《小孙屠》"
      },
      {
        "id": "yuanqu-c192",
        "title": "贾固"
      },
      {
        "id": "yuanqu-c193",
        "title": "吕天用"
      },
      {
        "id": "yuanqu-c194",
        "title": "李爱山"
      },
      {
        "id": "yuanqu-c195",
        "title": "方伯成"
      },
      {
        "id": "yuanqu-c196",
        "title": "鲜于必仁"
      },
      {
        "id": "yuanqu-c197",
        "title": "刘唐卿《白兔记》"
      },
      {
        "id": "yuanqu-c198",
        "title": "吴仁卿"
      },
      {
        "id": "yuanqu-c199",
        "title": "王挺秀"
      },
      {
        "id": "yuanqu-c200",
        "title": "曾瑞"
      },
      {
        "id": "yuanqu-c201",
        "title": "谷子敬"
      },
      {
        "id": "yuanqu-c202",
        "title": "朱凯"
      },
      {
        "id": "yuanqu-c203",
        "title": "陆登善"
      },
      {
        "id": "yuanqu-c204",
        "title": "马彦良"
      },
      {
        "id": "yuanqu-c205",
        "title": "顾鉴中"
      },
      {
        "id": "yuanqu-c206",
        "title": "柴野愚"
      },
      {
        "id": "yuanqu-c207",
        "title": "孙叔顺"
      },
      {
        "id": "yuanqu-c208",
        "title": "杨果"
      },
      {
        "id": "yuanqu-c209",
        "title": "侯正卿"
      },
      {
        "id": "yuanqu-c210",
        "title": "亢文苑"
      },
      {
        "id": "yuanqu-c211",
        "title": "周德清"
      },
      {
        "id": "yuanqu-c212",
        "title": "赵岩"
      },
      {
        "id": "yuanqu-c213",
        "title": "董君瑞"
      },
      {
        "id": "yuanqu-c214",
        "title": "张碧山"
      },
      {
        "id": "yuanqu-c215",
        "title": "倪瓒"
      },
      {
        "id": "yuanqu-c216",
        "title": "李邦基"
      },
      {
        "id": "yuanqu-c217",
        "title": "刘婆惜"
      },
      {
        "id": "yuanqu-c218",
        "title": "王氏"
      },
      {
        "id": "yuanqu-c219",
        "title": "王元鼎"
      },
      {
        "id": "yuanqu-c220",
        "title": "萧德润"
      },
      {
        "id": "yuanqu-c221",
        "title": "徐再思"
      },
      {
        "id": "yuanqu-c222",
        "title": "武林隐"
      },
      {
        "id": "yuanqu-c223",
        "title": "周浩"
      },
      {
        "id": "yuanqu-c224",
        "title": "阿里西瑛"
      },
      {
        "id": "yuanqu-c225",
        "title": "汪元亨"
      },
      {
        "id": "yuanqu-c226",
        "title": "杜遵礼"
      },
      {
        "id": "yuanqu-c227",
        "title": "陈子厚"
      },
      {
        "id": "yuanqu-c228",
        "title": "李齐贤"
      },
      {
        "id": "yuanqu-c229",
        "title": "于伯渊"
      },
      {
        "id": "yuanqu-c230",
        "title": "萨都剌"
      },
      {
        "id": "yuanqu-c231",
        "title": "冯子振"
      },
      {
        "id": "yuanqu-c232",
        "title": "高安道"
      },
      {
        "id": "yuanqu-c233",
        "title": "邵亨贞"
      }
    ]
  },
  {
    "id": "guwenguanzhi",
    "title": "古文观止",
    "author": "吴楚材、吴调侯 编",
    "category": "ji",
    "description": "清·吴氏叔侄编选历代散文选集，共 222 篇。本版为全本。",
    "dynasty": "清",
    "sizeBytes": 429389,
    "toc": [
      {
        "id": "guwenguanzhi-c1",
        "title": "郑伯克段于鄢 · 左传"
      },
      {
        "id": "guwenguanzhi-c2",
        "title": "周郑交质 · 左传"
      },
      {
        "id": "guwenguanzhi-c3",
        "title": "石碏谏宠州吁 · 左传"
      },
      {
        "id": "guwenguanzhi-c4",
        "title": "臧僖伯谏观鱼 · 左传"
      },
      {
        "id": "guwenguanzhi-c5",
        "title": "郑庄公戒饬守臣 · 左传"
      },
      {
        "id": "guwenguanzhi-c6",
        "title": "臧哀伯谏纳郜鼎 · 左传"
      },
      {
        "id": "guwenguanzhi-c7",
        "title": "季梁谏追楚师 · 左传"
      },
      {
        "id": "guwenguanzhi-c8",
        "title": "曹刿论战 · 左传"
      },
      {
        "id": "guwenguanzhi-c9",
        "title": "齐桓公伐楚 · 左传"
      },
      {
        "id": "guwenguanzhi-c10",
        "title": "宫之奇谏假道 · 左传"
      },
      {
        "id": "guwenguanzhi-c11",
        "title": "齐桓下拜受胙 · 左传"
      },
      {
        "id": "guwenguanzhi-c12",
        "title": "阴饴甥对秦伯 · 左传"
      },
      {
        "id": "guwenguanzhi-c13",
        "title": "子鱼论战 · 左传"
      },
      {
        "id": "guwenguanzhi-c14",
        "title": "寺人披见文公 · 左传"
      },
      {
        "id": "guwenguanzhi-c15",
        "title": "介之推不言禄 · 左传"
      },
      {
        "id": "guwenguanzhi-c16",
        "title": "展喜犒师 · 左传"
      },
      {
        "id": "guwenguanzhi-c17",
        "title": "烛之武退秦师 · 左传"
      },
      {
        "id": "guwenguanzhi-c18",
        "title": "蹇叔哭师 · 左传"
      },
      {
        "id": "guwenguanzhi-c19",
        "title": "郑子家告赵宣子 · 左传"
      },
      {
        "id": "guwenguanzhi-c20",
        "title": "王孙满对楚子 · 左传"
      },
      {
        "id": "guwenguanzhi-c21",
        "title": "齐国佐不辱命 · 左传"
      },
      {
        "id": "guwenguanzhi-c22",
        "title": "楚归晋知䓨 · 左传"
      },
      {
        "id": "guwenguanzhi-c23",
        "title": "吕相绝秦 · 左传"
      },
      {
        "id": "guwenguanzhi-c24",
        "title": "驹支不屈于晋 · 左传"
      },
      {
        "id": "guwenguanzhi-c25",
        "title": "祁奚请免叔向 · 左传"
      },
      {
        "id": "guwenguanzhi-c26",
        "title": "子产告范宣子轻币 · 左传"
      },
      {
        "id": "guwenguanzhi-c27",
        "title": "晏子不死君难 · 左传"
      },
      {
        "id": "guwenguanzhi-c28",
        "title": "季札观周乐 · 左传"
      },
      {
        "id": "guwenguanzhi-c29",
        "title": "子产坏晋馆垣 · 左传"
      },
      {
        "id": "guwenguanzhi-c30",
        "title": "子产论尹何为邑 · 左传"
      },
      {
        "id": "guwenguanzhi-c31",
        "title": "子产却楚逆女以兵 · 左传"
      },
      {
        "id": "guwenguanzhi-c32",
        "title": "子革对灵王 · 左传"
      },
      {
        "id": "guwenguanzhi-c33",
        "title": "子产论政宽猛 · 左传"
      },
      {
        "id": "guwenguanzhi-c34",
        "title": "吴许越成 · 左传"
      },
      {
        "id": "guwenguanzhi-c35",
        "title": "祭公谏征犬戎 · 国语"
      },
      {
        "id": "guwenguanzhi-c36",
        "title": "召公谏厉王止谤 · 国语"
      },
      {
        "id": "guwenguanzhi-c37",
        "title": "襄王不许请隧 · 国语"
      },
      {
        "id": "guwenguanzhi-c38",
        "title": "单子知陈必亡 · 国语"
      },
      {
        "id": "guwenguanzhi-c39",
        "title": "展禽论祀爰居 · 国语"
      },
      {
        "id": "guwenguanzhi-c40",
        "title": "里革断罟匡君 · 国语"
      },
      {
        "id": "guwenguanzhi-c41",
        "title": "敬姜论劳逸 · 国语"
      },
      {
        "id": "guwenguanzhi-c42",
        "title": "叔向贺贫 · 国语"
      },
      {
        "id": "guwenguanzhi-c43",
        "title": "王孙圉论楚宝 · 国语"
      },
      {
        "id": "guwenguanzhi-c44",
        "title": "诸稽郢行成于吴 · 国语"
      },
      {
        "id": "guwenguanzhi-c45",
        "title": "申胥谏许越成 · 国语"
      },
      {
        "id": "guwenguanzhi-c46",
        "title": "春王正月 · 公羊传"
      },
      {
        "id": "guwenguanzhi-c47",
        "title": "宋人及楚人平 · 公羊传"
      },
      {
        "id": "guwenguanzhi-c48",
        "title": "吴子使札来聘 · 公羊传"
      },
      {
        "id": "guwenguanzhi-c49",
        "title": "郑伯克段于鄢 · 谷梁传"
      },
      {
        "id": "guwenguanzhi-c50",
        "title": "虞师晋师灭夏阳 · 谷梁传"
      },
      {
        "id": "guwenguanzhi-c51",
        "title": "晋献公杀世子申生 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c52",
        "title": "曾子易箦 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c53",
        "title": "有子之言似夫子 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c54",
        "title": "公子重耳对秦客 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c55",
        "title": "杜蒉扬觯 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c56",
        "title": "晋献文子成室 · 礼记·檀弓"
      },
      {
        "id": "guwenguanzhi-c57",
        "title": "苏秦以连横说秦 · 战国策"
      },
      {
        "id": "guwenguanzhi-c58",
        "title": "司马错论伐蜀 · 战国策"
      },
      {
        "id": "guwenguanzhi-c59",
        "title": "范雎说秦王 · 战国策"
      },
      {
        "id": "guwenguanzhi-c60",
        "title": "邹忌讽齐王纳谏 · 战国策"
      },
      {
        "id": "guwenguanzhi-c61",
        "title": "齐宣王见颜斶 · 战国策"
      },
      {
        "id": "guwenguanzhi-c62",
        "title": "冯谖客孟尝君 · 战国策"
      },
      {
        "id": "guwenguanzhi-c63",
        "title": "赵威后问齐使 · 战国策"
      },
      {
        "id": "guwenguanzhi-c64",
        "title": "庄辛论幸臣 · 战国策"
      },
      {
        "id": "guwenguanzhi-c65",
        "title": "触龙说赵太后 · 战国策"
      },
      {
        "id": "guwenguanzhi-c66",
        "title": "鲁仲连义不帝秦 · 战国策"
      },
      {
        "id": "guwenguanzhi-c67",
        "title": "鲁共公择言 · 战国策"
      },
      {
        "id": "guwenguanzhi-c68",
        "title": "唐雎说信陵君 · 战国策"
      },
      {
        "id": "guwenguanzhi-c69",
        "title": "唐雎不辱使命  · 战国策"
      },
      {
        "id": "guwenguanzhi-c70",
        "title": "乐毅报燕王书 · 战国策"
      },
      {
        "id": "guwenguanzhi-c71",
        "title": "谏逐客书 · (李斯)"
      },
      {
        "id": "guwenguanzhi-c72",
        "title": "卜居 · (屈原)"
      },
      {
        "id": "guwenguanzhi-c73",
        "title": "对楚王问 · (宋玉)"
      },
      {
        "id": "guwenguanzhi-c74",
        "title": "五帝本纪赞 · 史记"
      },
      {
        "id": "guwenguanzhi-c75",
        "title": "项羽本纪赞 · 史记"
      },
      {
        "id": "guwenguanzhi-c76",
        "title": "秦楚之际月表 · 史记"
      },
      {
        "id": "guwenguanzhi-c77",
        "title": "高祖功臣侯者年表 · 史记"
      },
      {
        "id": "guwenguanzhi-c78",
        "title": "孔子世家赞 · 史记"
      },
      {
        "id": "guwenguanzhi-c79",
        "title": "外戚世家序 · 史记"
      },
      {
        "id": "guwenguanzhi-c80",
        "title": "伯夷列传 · 史记"
      },
      {
        "id": "guwenguanzhi-c81",
        "title": "管晏列传 · 史记"
      },
      {
        "id": "guwenguanzhi-c82",
        "title": "屈原列传 · 史记"
      },
      {
        "id": "guwenguanzhi-c83",
        "title": "酷吏列传序 · 史记"
      },
      {
        "id": "guwenguanzhi-c84",
        "title": "游侠列传序 · 史记"
      },
      {
        "id": "guwenguanzhi-c85",
        "title": "滑稽列传 · 史记"
      },
      {
        "id": "guwenguanzhi-c86",
        "title": "货殖列传序 · 史记"
      },
      {
        "id": "guwenguanzhi-c87",
        "title": "太史公自序 · 史记"
      },
      {
        "id": "guwenguanzhi-c88",
        "title": "报任安书 · (司马迁)"
      },
      {
        "id": "guwenguanzhi-c89",
        "title": "高帝求贤诏 · (班固)"
      },
      {
        "id": "guwenguanzhi-c90",
        "title": "文帝议佐百姓诏 · (汉文帝)"
      },
      {
        "id": "guwenguanzhi-c91",
        "title": "景帝令二千石修职诏 · (汉景帝)"
      },
      {
        "id": "guwenguanzhi-c92",
        "title": "武帝求茂才异等诏 · (汉武帝)"
      },
      {
        "id": "guwenguanzhi-c93",
        "title": "过秦论 · (贾谊)"
      },
      {
        "id": "guwenguanzhi-c94",
        "title": "治安策 · (贾谊)"
      },
      {
        "id": "guwenguanzhi-c95",
        "title": "论贵粟疏 · (晁错)"
      },
      {
        "id": "guwenguanzhi-c96",
        "title": "狱中上梁王书 · (邹阳)"
      },
      {
        "id": "guwenguanzhi-c97",
        "title": "上书谏猎 · (司马相如)"
      },
      {
        "id": "guwenguanzhi-c98",
        "title": "答苏武书 · (李陵)"
      },
      {
        "id": "guwenguanzhi-c99",
        "title": "尚德缓刑书 · (路温舒)"
      },
      {
        "id": "guwenguanzhi-c100",
        "title": "报孙会宗书 · (杨恽)"
      },
      {
        "id": "guwenguanzhi-c101",
        "title": "光武帝临淄劳耿弇 · (光武帝)"
      },
      {
        "id": "guwenguanzhi-c102",
        "title": "诫兄子严敦书 · (马援)"
      },
      {
        "id": "guwenguanzhi-c103",
        "title": "前出师表 · (诸葛亮)"
      },
      {
        "id": "guwenguanzhi-c104",
        "title": "后出师表 · (诸葛亮)"
      },
      {
        "id": "guwenguanzhi-c105",
        "title": "陈情表 · (李密)"
      },
      {
        "id": "guwenguanzhi-c106",
        "title": "兰亭集序 · (王羲之)"
      },
      {
        "id": "guwenguanzhi-c107",
        "title": "归去来兮辞 · (陶渊明)"
      },
      {
        "id": "guwenguanzhi-c108",
        "title": "桃花源记 · (陶渊明)"
      },
      {
        "id": "guwenguanzhi-c109",
        "title": "五柳先生传 · (陶渊明)"
      },
      {
        "id": "guwenguanzhi-c110",
        "title": "北山移文 · (孔稚珪)"
      },
      {
        "id": "guwenguanzhi-c111",
        "title": "谏太宗十思疏 · (魏徵)"
      },
      {
        "id": "guwenguanzhi-c112",
        "title": "为徐敬业讨武曌檄 · (骆宾王)"
      },
      {
        "id": "guwenguanzhi-c113",
        "title": "滕王阁序 · (王勃)"
      },
      {
        "id": "guwenguanzhi-c114",
        "title": "与韩荆州书 · (李白)"
      },
      {
        "id": "guwenguanzhi-c115",
        "title": "春夜宴桃李园序 · (李白)"
      },
      {
        "id": "guwenguanzhi-c116",
        "title": "吊古战场文 · (李华)"
      },
      {
        "id": "guwenguanzhi-c117",
        "title": "陋室铭 · (刘禹锡)"
      },
      {
        "id": "guwenguanzhi-c118",
        "title": "阿房宫赋 · (杜牧)"
      },
      {
        "id": "guwenguanzhi-c119",
        "title": "原道 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c120",
        "title": "原毁 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c121",
        "title": "获麟解 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c122",
        "title": "杂说·龙说 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c123",
        "title": "杂说·马说 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c124",
        "title": "师说 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c125",
        "title": "进学解 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c126",
        "title": "圬者王承福传 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c127",
        "title": "讳辩 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c128",
        "title": "争臣论 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c129",
        "title": "后十九日覆上宰相书 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c130",
        "title": "后廿九日覆上宰相书 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c131",
        "title": "与于襄阳书 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c132",
        "title": "与陈给事书 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c133",
        "title": "应科目时与人书 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c134",
        "title": "送孟东野序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c135",
        "title": "送李愿归盘谷序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c136",
        "title": "送董邵南游河北序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c137",
        "title": "送杨少尹序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c138",
        "title": "送石处士序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c139",
        "title": "送温处士赴河阳军序 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c140",
        "title": "祭十二郎文 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c141",
        "title": "祭鳄鱼文 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c142",
        "title": "柳子厚墓志铭 · (韩愈)"
      },
      {
        "id": "guwenguanzhi-c143",
        "title": "驳复仇议 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c144",
        "title": "桐叶封弟辨 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c145",
        "title": "箕子碑 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c146",
        "title": "捕蛇者说 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c147",
        "title": "种树郭橐驼传 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c148",
        "title": "梓人传 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c149",
        "title": "愚溪诗序 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c150",
        "title": "永州韦使君新堂记 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c151",
        "title": "钴𬭁潭西小丘记 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c152",
        "title": "小石城山记 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c153",
        "title": "贺进士王参元失火书 · (柳宗元)"
      },
      {
        "id": "guwenguanzhi-c154",
        "title": "待漏院记 · (王禹偁)"
      },
      {
        "id": "guwenguanzhi-c155",
        "title": "黄冈竹楼记 · (王禹偁)"
      },
      {
        "id": "guwenguanzhi-c156",
        "title": "书洛阳名园记后 · (李格非)"
      },
      {
        "id": "guwenguanzhi-c157",
        "title": "严先生祠堂记 · (范仲淹)"
      },
      {
        "id": "guwenguanzhi-c158",
        "title": "岳阳楼记 · (范仲淹)"
      },
      {
        "id": "guwenguanzhi-c159",
        "title": "谏院题名记 · (司马光)"
      },
      {
        "id": "guwenguanzhi-c160",
        "title": "义田记 · (钱公辅)"
      },
      {
        "id": "guwenguanzhi-c161",
        "title": "袁州州学记 · (李觏)"
      },
      {
        "id": "guwenguanzhi-c162",
        "title": "朋党论 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c163",
        "title": "纵囚论 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c164",
        "title": "释秘演诗集序 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c165",
        "title": "梅圣俞诗集序 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c166",
        "title": "送杨寘序 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c167",
        "title": "五代史伶官传序 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c168",
        "title": "五代史宦官传序 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c169",
        "title": "相州昼锦堂记 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c170",
        "title": "丰乐亭记 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c171",
        "title": "醉翁亭记 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c172",
        "title": "秋声赋 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c173",
        "title": "祭石曼卿文 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c174",
        "title": "泷冈阡表 · (欧阳修)"
      },
      {
        "id": "guwenguanzhi-c175",
        "title": "管仲论 · (苏洵)"
      },
      {
        "id": "guwenguanzhi-c176",
        "title": "辨奸论 · (苏洵)"
      },
      {
        "id": "guwenguanzhi-c177",
        "title": "心术 · (苏洵)"
      },
      {
        "id": "guwenguanzhi-c178",
        "title": "张益州画像记 · (苏洵)"
      },
      {
        "id": "guwenguanzhi-c179",
        "title": "刑赏忠厚之至论 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c180",
        "title": "范增论 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c181",
        "title": "留侯论 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c182",
        "title": "贾谊论 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c183",
        "title": "晁错论 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c184",
        "title": "上梅直讲书 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c185",
        "title": "喜雨亭记 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c186",
        "title": "凌虚台记 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c187",
        "title": "超然台记 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c188",
        "title": "放鹤亭记 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c189",
        "title": "石钟山记 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c190",
        "title": "潮州韩文公庙碑 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c191",
        "title": "乞校正陆贽奏议进御札子 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c192",
        "title": "前赤壁赋 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c193",
        "title": "后赤壁赋 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c194",
        "title": "三槐堂铭 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c195",
        "title": "方山子传 · (苏轼)"
      },
      {
        "id": "guwenguanzhi-c196",
        "title": "六国论 · (苏辙)"
      },
      {
        "id": "guwenguanzhi-c197",
        "title": "上枢密韩太尉书 · (苏辙)"
      },
      {
        "id": "guwenguanzhi-c198",
        "title": "黄州快哉亭记 · (苏辙)"
      },
      {
        "id": "guwenguanzhi-c199",
        "title": "寄欧阳舍人书 · (曾巩)"
      },
      {
        "id": "guwenguanzhi-c200",
        "title": "赠黎安二生序 · (曾巩)"
      },
      {
        "id": "guwenguanzhi-c201",
        "title": "读孟尝君传 · (王安石)"
      },
      {
        "id": "guwenguanzhi-c202",
        "title": "同学一首别子固 · (王安石)"
      },
      {
        "id": "guwenguanzhi-c203",
        "title": "游褒禅山记 · (王安石)"
      },
      {
        "id": "guwenguanzhi-c204",
        "title": "泰州海陵县主簿许君墓志铭 ·"
      },
      {
        "id": "guwenguanzhi-c205",
        "title": "送天台陈庭学序 · (宋濂)"
      },
      {
        "id": "guwenguanzhi-c206",
        "title": "阅江楼记 · (宋濂)"
      },
      {
        "id": "guwenguanzhi-c207",
        "title": "司马季主论卜 · (刘基)"
      },
      {
        "id": "guwenguanzhi-c208",
        "title": "卖柑者言 · (刘基)"
      },
      {
        "id": "guwenguanzhi-c209",
        "title": "深虑论 · (方孝孺)"
      },
      {
        "id": "guwenguanzhi-c210",
        "title": "豫让论 · (方孝孺)"
      },
      {
        "id": "guwenguanzhi-c211",
        "title": "亲政篇 · (王鏊)"
      },
      {
        "id": "guwenguanzhi-c212",
        "title": "稽山书院尊经阁记 · (王守仁)"
      },
      {
        "id": "guwenguanzhi-c213",
        "title": "象祠记 · (王守仁)"
      },
      {
        "id": "guwenguanzhi-c214",
        "title": "瘗旅文 · (王守仁)"
      },
      {
        "id": "guwenguanzhi-c215",
        "title": "信陵君救赵论 · (唐顺之)"
      },
      {
        "id": "guwenguanzhi-c216",
        "title": "报刘一丈书 · (宗臣)"
      },
      {
        "id": "guwenguanzhi-c217",
        "title": "吴山图记 · (归有光)"
      },
      {
        "id": "guwenguanzhi-c218",
        "title": "沧浪亭记 · (归有光)"
      },
      {
        "id": "guwenguanzhi-c219",
        "title": "青霞先生文集序 · (茅坤)"
      },
      {
        "id": "guwenguanzhi-c220",
        "title": "蔺相如完璧归赵论 · (王世贞)"
      },
      {
        "id": "guwenguanzhi-c221",
        "title": "徐文长传 · (袁宏道)"
      },
      {
        "id": "guwenguanzhi-c222",
        "title": "五人墓碑记 · (张溥)"
      }
    ]
  },
  {
    "id": "sanzijing",
    "title": "三字经",
    "author": "王应麟（传）",
    "category": "jing",
    "description": "相传宋·王应麟撰三字韵语蒙书，涵盖劝学、名物、经史子集纲要。本版为全本。",
    "dynasty": "宋",
    "sizeBytes": 6566,
    "toc": [
      {
        "id": "sanzijing-c1",
        "title": "三字经"
      }
    ]
  },
  {
    "id": "baijiaxing",
    "title": "百家姓",
    "author": "佚名",
    "category": "jing",
    "description": "宋初编成的姓氏韵文蒙书，四字一句读来顺口。本版为全本。",
    "dynasty": "宋",
    "sizeBytes": 2288,
    "toc": [
      {
        "id": "baijiaxing-c1",
        "title": "百家姓"
      }
    ]
  },
  {
    "id": "qianziwen",
    "title": "千字文",
    "author": "周兴嗣",
    "category": "jing",
    "description": "南朝梁·周兴嗣以一千个不重复汉字编成的韵文蒙书。本版为全本。",
    "dynasty": "南朝梁",
    "sizeBytes": 3517,
    "toc": [
      {
        "id": "qianziwen-c1",
        "title": "千字文"
      }
    ]
  },
  {
    "id": "dizigui",
    "title": "弟子规",
    "author": "李毓秀",
    "category": "jing",
    "description": "清·李毓秀据《论语》学而篇义理编成的童蒙行为规范。本版为全本。",
    "dynasty": "清",
    "sizeBytes": 3810,
    "toc": [
      {
        "id": "dizigui-c1",
        "title": "总叙"
      },
      {
        "id": "dizigui-c2",
        "title": "入则孝"
      },
      {
        "id": "dizigui-c3",
        "title": "出则弟"
      },
      {
        "id": "dizigui-c4",
        "title": "谨"
      },
      {
        "id": "dizigui-c5",
        "title": "信"
      },
      {
        "id": "dizigui-c6",
        "title": "泛爱众"
      },
      {
        "id": "dizigui-c7",
        "title": "亲仁"
      },
      {
        "id": "dizigui-c8",
        "title": "余力学文"
      }
    ]
  },
  {
    "id": "zhuzijiaxun",
    "title": "朱子家训",
    "author": "朱用纯",
    "category": "jing",
    "description": "明末清初·朱用纯撰治家格言，五百余字。本版为全本。",
    "dynasty": "明",
    "sizeBytes": 2011,
    "toc": [
      {
        "id": "zhuzijiaxun-c1",
        "title": "朱子家训"
      }
    ]
  },
  {
    "id": "zengguangxianwen",
    "title": "增广贤文",
    "author": "佚名",
    "category": "jing",
    "description": "明代辑成的谚语格言集，上下两集。本版为全本。",
    "dynasty": "明",
    "sizeBytes": 31411,
    "toc": [
      {
        "id": "zengguangxianwen-c1",
        "title": "上集"
      },
      {
        "id": "zengguangxianwen-c2",
        "title": "下集"
      }
    ]
  },
  {
    "id": "shenglvqimeng",
    "title": "声律启蒙",
    "author": "车万育",
    "category": "jing",
    "description": "清·车万育撰声韵对偶蒙书，训练诗联对仗。本版为全本。",
    "dynasty": "清",
    "sizeBytes": 26035,
    "toc": [
      {
        "id": "shenglvqimeng-c1",
        "title": "上卷·一 东"
      },
      {
        "id": "shenglvqimeng-c2",
        "title": "上卷·二 冬"
      },
      {
        "id": "shenglvqimeng-c3",
        "title": "上卷·三 江"
      },
      {
        "id": "shenglvqimeng-c4",
        "title": "上卷·四 支"
      },
      {
        "id": "shenglvqimeng-c5",
        "title": "上卷·五 微"
      },
      {
        "id": "shenglvqimeng-c6",
        "title": "上卷·六 鱼"
      },
      {
        "id": "shenglvqimeng-c7",
        "title": "上卷·七 虞"
      },
      {
        "id": "shenglvqimeng-c8",
        "title": "上卷·八 齐"
      },
      {
        "id": "shenglvqimeng-c9",
        "title": "上卷·九 佳"
      },
      {
        "id": "shenglvqimeng-c10",
        "title": "上卷·十 灰"
      },
      {
        "id": "shenglvqimeng-c11",
        "title": "上卷·十一 真"
      },
      {
        "id": "shenglvqimeng-c12",
        "title": "上卷·十二 文"
      },
      {
        "id": "shenglvqimeng-c13",
        "title": "上卷·十三 元"
      },
      {
        "id": "shenglvqimeng-c14",
        "title": "上卷·十四 寒"
      },
      {
        "id": "shenglvqimeng-c15",
        "title": "上卷·十五 删"
      },
      {
        "id": "shenglvqimeng-c16",
        "title": "下卷·一 先"
      },
      {
        "id": "shenglvqimeng-c17",
        "title": "下卷·二 萧"
      },
      {
        "id": "shenglvqimeng-c18",
        "title": "下卷·三 肴"
      },
      {
        "id": "shenglvqimeng-c19",
        "title": "下卷·四 豪"
      },
      {
        "id": "shenglvqimeng-c20",
        "title": "下卷·五 歌"
      },
      {
        "id": "shenglvqimeng-c21",
        "title": "下卷·六 麻"
      },
      {
        "id": "shenglvqimeng-c22",
        "title": "下卷·七 阳"
      },
      {
        "id": "shenglvqimeng-c23",
        "title": "下卷·八 庚"
      },
      {
        "id": "shenglvqimeng-c24",
        "title": "下卷·九 青"
      },
      {
        "id": "shenglvqimeng-c25",
        "title": "下卷·十 蒸"
      },
      {
        "id": "shenglvqimeng-c26",
        "title": "下卷·十一 尤"
      },
      {
        "id": "shenglvqimeng-c27",
        "title": "下卷·十二 侵"
      },
      {
        "id": "shenglvqimeng-c28",
        "title": "下卷·十三 覃"
      },
      {
        "id": "shenglvqimeng-c29",
        "title": "下卷·十四 盐"
      },
      {
        "id": "shenglvqimeng-c30",
        "title": "下卷·十五 咸"
      }
    ]
  },
  {
    "id": "liwengduiyun",
    "title": "笠翁对韵",
    "author": "李渔",
    "category": "jing",
    "description": "清·李渔撰声韵对偶蒙书，与《声律启蒙》齐名。本版为全本。",
    "dynasty": "清",
    "sizeBytes": 26809,
    "toc": [
      {
        "id": "liwengduiyun-c1",
        "title": "上卷·一东"
      },
      {
        "id": "liwengduiyun-c2",
        "title": "上卷·一东"
      },
      {
        "id": "liwengduiyun-c3",
        "title": "上卷·一东"
      },
      {
        "id": "liwengduiyun-c4",
        "title": "上卷·二冬"
      },
      {
        "id": "liwengduiyun-c5",
        "title": "上卷·二冬"
      },
      {
        "id": "liwengduiyun-c6",
        "title": "上卷·二冬"
      },
      {
        "id": "liwengduiyun-c7",
        "title": "上卷·三江"
      },
      {
        "id": "liwengduiyun-c8",
        "title": "上卷·三江"
      },
      {
        "id": "liwengduiyun-c9",
        "title": "上卷·四支"
      },
      {
        "id": "liwengduiyun-c10",
        "title": "上卷·四支"
      },
      {
        "id": "liwengduiyun-c11",
        "title": "上卷·四支"
      },
      {
        "id": "liwengduiyun-c12",
        "title": "上卷·四支"
      },
      {
        "id": "liwengduiyun-c13",
        "title": "上卷·五微"
      },
      {
        "id": "liwengduiyun-c14",
        "title": "上卷·五微"
      },
      {
        "id": "liwengduiyun-c15",
        "title": "上卷·五微"
      },
      {
        "id": "liwengduiyun-c16",
        "title": "上卷·六鱼"
      },
      {
        "id": "liwengduiyun-c17",
        "title": "上卷·六鱼"
      },
      {
        "id": "liwengduiyun-c18",
        "title": "上卷·六鱼"
      },
      {
        "id": "liwengduiyun-c19",
        "title": "上卷·七虞"
      },
      {
        "id": "liwengduiyun-c20",
        "title": "上卷·七虞"
      },
      {
        "id": "liwengduiyun-c21",
        "title": "上卷·七虞"
      },
      {
        "id": "liwengduiyun-c22",
        "title": "上卷·七虞"
      },
      {
        "id": "liwengduiyun-c23",
        "title": "上卷·八齐"
      },
      {
        "id": "liwengduiyun-c24",
        "title": "上卷·八齐"
      },
      {
        "id": "liwengduiyun-c25",
        "title": "上卷·八齐"
      },
      {
        "id": "liwengduiyun-c26",
        "title": "上卷·九佳"
      },
      {
        "id": "liwengduiyun-c27",
        "title": "上卷·九佳"
      },
      {
        "id": "liwengduiyun-c28",
        "title": "上卷·九佳"
      },
      {
        "id": "liwengduiyun-c29",
        "title": "上卷·九佳"
      },
      {
        "id": "liwengduiyun-c30",
        "title": "上卷·十灰"
      },
      {
        "id": "liwengduiyun-c31",
        "title": "上卷·十灰"
      },
      {
        "id": "liwengduiyun-c32",
        "title": "上卷·十灰"
      },
      {
        "id": "liwengduiyun-c33",
        "title": "上卷·十一真"
      },
      {
        "id": "liwengduiyun-c34",
        "title": "上卷·十一真"
      },
      {
        "id": "liwengduiyun-c35",
        "title": "上卷·十一真"
      },
      {
        "id": "liwengduiyun-c36",
        "title": "上卷·十二文"
      },
      {
        "id": "liwengduiyun-c37",
        "title": "上卷·十二文"
      },
      {
        "id": "liwengduiyun-c38",
        "title": "上卷·十二文"
      },
      {
        "id": "liwengduiyun-c39",
        "title": "上卷·十三元"
      },
      {
        "id": "liwengduiyun-c40",
        "title": "上卷·十三元"
      },
      {
        "id": "liwengduiyun-c41",
        "title": "上卷·十四寒"
      },
      {
        "id": "liwengduiyun-c42",
        "title": "上卷·十四寒"
      },
      {
        "id": "liwengduiyun-c43",
        "title": "上卷·十四寒"
      },
      {
        "id": "liwengduiyun-c44",
        "title": "上卷·十五删"
      },
      {
        "id": "liwengduiyun-c45",
        "title": "上卷·十五删"
      },
      {
        "id": "liwengduiyun-c46",
        "title": "下卷·一先"
      },
      {
        "id": "liwengduiyun-c47",
        "title": "下卷·一先"
      },
      {
        "id": "liwengduiyun-c48",
        "title": "下卷·一先"
      },
      {
        "id": "liwengduiyun-c49",
        "title": "下卷·一先"
      },
      {
        "id": "liwengduiyun-c50",
        "title": "下卷·二萧"
      },
      {
        "id": "liwengduiyun-c51",
        "title": "下卷·二萧"
      },
      {
        "id": "liwengduiyun-c52",
        "title": "下卷·二萧"
      },
      {
        "id": "liwengduiyun-c53",
        "title": "下卷·三肴"
      },
      {
        "id": "liwengduiyun-c54",
        "title": "下卷·三肴"
      },
      {
        "id": "liwengduiyun-c55",
        "title": "下卷·三肴"
      },
      {
        "id": "liwengduiyun-c56",
        "title": "下卷·四豪"
      },
      {
        "id": "liwengduiyun-c57",
        "title": "下卷·四豪"
      },
      {
        "id": "liwengduiyun-c58",
        "title": "下卷·四豪"
      },
      {
        "id": "liwengduiyun-c59",
        "title": "下卷·五歌"
      },
      {
        "id": "liwengduiyun-c60",
        "title": "下卷·五歌"
      },
      {
        "id": "liwengduiyun-c61",
        "title": "下卷·五歌"
      },
      {
        "id": "liwengduiyun-c62",
        "title": "下卷·五歌"
      },
      {
        "id": "liwengduiyun-c63",
        "title": "下卷·六麻"
      },
      {
        "id": "liwengduiyun-c64",
        "title": "下卷·六麻"
      },
      {
        "id": "liwengduiyun-c65",
        "title": "下卷·六麻"
      },
      {
        "id": "liwengduiyun-c66",
        "title": "下卷·六麻"
      },
      {
        "id": "liwengduiyun-c67",
        "title": "下卷·七阳"
      },
      {
        "id": "liwengduiyun-c68",
        "title": "下卷·七阳"
      },
      {
        "id": "liwengduiyun-c69",
        "title": "下卷·七阳"
      },
      {
        "id": "liwengduiyun-c70",
        "title": "下卷·七阳"
      },
      {
        "id": "liwengduiyun-c71",
        "title": "下卷·八庚"
      },
      {
        "id": "liwengduiyun-c72",
        "title": "下卷·八庚"
      },
      {
        "id": "liwengduiyun-c73",
        "title": "下卷·八庚"
      },
      {
        "id": "liwengduiyun-c74",
        "title": "下卷·九青"
      },
      {
        "id": "liwengduiyun-c75",
        "title": "下卷·九青"
      },
      {
        "id": "liwengduiyun-c76",
        "title": "下卷·十蒸"
      },
      {
        "id": "liwengduiyun-c77",
        "title": "下卷·十蒸"
      },
      {
        "id": "liwengduiyun-c78",
        "title": "下卷·十一尤"
      },
      {
        "id": "liwengduiyun-c79",
        "title": "下卷·十一尤"
      },
      {
        "id": "liwengduiyun-c80",
        "title": "下卷·十一尤"
      },
      {
        "id": "liwengduiyun-c81",
        "title": "下卷·十二侵"
      },
      {
        "id": "liwengduiyun-c82",
        "title": "下卷·十二侵"
      },
      {
        "id": "liwengduiyun-c83",
        "title": "下卷·十三覃"
      },
      {
        "id": "liwengduiyun-c84",
        "title": "下卷·十三覃"
      },
      {
        "id": "liwengduiyun-c85",
        "title": "下卷·十四盐"
      },
      {
        "id": "liwengduiyun-c86",
        "title": "下卷·十四盐"
      },
      {
        "id": "liwengduiyun-c87",
        "title": "下卷·十四盐"
      },
      {
        "id": "liwengduiyun-c88",
        "title": "下卷·十五咸"
      },
      {
        "id": "liwengduiyun-c89",
        "title": "下卷·十五咸"
      },
      {
        "id": "liwengduiyun-c90",
        "title": "下卷·十五咸"
      }
    ]
  },
  {
    "id": "youxueqionglin",
    "title": "幼学琼林",
    "author": "程登吉",
    "category": "jing",
    "description": "明·程登吉撰百科常识蒙书（原本《幼学须知》）。本版为全本。",
    "dynasty": "明",
    "sizeBytes": 64991,
    "toc": [
      {
        "id": "youxueqionglin-c1",
        "title": "卷一·天文"
      },
      {
        "id": "youxueqionglin-c2",
        "title": "卷一·地舆"
      },
      {
        "id": "youxueqionglin-c3",
        "title": "卷一·岁时"
      },
      {
        "id": "youxueqionglin-c4",
        "title": "卷一·朝廷"
      },
      {
        "id": "youxueqionglin-c5",
        "title": "卷一·文臣"
      },
      {
        "id": "youxueqionglin-c6",
        "title": "卷一·武职"
      },
      {
        "id": "youxueqionglin-c7",
        "title": "卷二·祖孙父子"
      },
      {
        "id": "youxueqionglin-c8",
        "title": "卷二·兄弟"
      },
      {
        "id": "youxueqionglin-c9",
        "title": "卷二·夫妇"
      },
      {
        "id": "youxueqionglin-c10",
        "title": "卷二·叔侄"
      },
      {
        "id": "youxueqionglin-c11",
        "title": "卷二·师生"
      },
      {
        "id": "youxueqionglin-c12",
        "title": "卷二·朋友宾主"
      },
      {
        "id": "youxueqionglin-c13",
        "title": "卷二·婚姻"
      },
      {
        "id": "youxueqionglin-c14",
        "title": "卷二·女子"
      },
      {
        "id": "youxueqionglin-c15",
        "title": "卷二·外戚"
      },
      {
        "id": "youxueqionglin-c16",
        "title": "卷二·老幼寿诞"
      },
      {
        "id": "youxueqionglin-c17",
        "title": "卷二·身体"
      },
      {
        "id": "youxueqionglin-c18",
        "title": "卷二·衣服"
      },
      {
        "id": "youxueqionglin-c19",
        "title": "卷三·人事"
      },
      {
        "id": "youxueqionglin-c20",
        "title": "卷三·饮食"
      },
      {
        "id": "youxueqionglin-c21",
        "title": "卷三·宫室"
      },
      {
        "id": "youxueqionglin-c22",
        "title": "卷三·器用"
      },
      {
        "id": "youxueqionglin-c23",
        "title": "卷三·珍宝"
      },
      {
        "id": "youxueqionglin-c24",
        "title": "卷三·贫富"
      },
      {
        "id": "youxueqionglin-c25",
        "title": "卷三·疾病死丧"
      },
      {
        "id": "youxueqionglin-c26",
        "title": "卷四·文事"
      },
      {
        "id": "youxueqionglin-c27",
        "title": "卷四·科第"
      },
      {
        "id": "youxueqionglin-c28",
        "title": "卷四·制作"
      },
      {
        "id": "youxueqionglin-c29",
        "title": "卷四·技艺"
      },
      {
        "id": "youxueqionglin-c30",
        "title": "卷四·讼狱"
      },
      {
        "id": "youxueqionglin-c31",
        "title": "卷四·释道鬼神"
      },
      {
        "id": "youxueqionglin-c32",
        "title": "卷四·鸟兽"
      },
      {
        "id": "youxueqionglin-c33",
        "title": "卷四·花木"
      }
    ]
  },
  {
    "id": "xinjing",
    "title": "心经",
    "author": "唐·玄奘 译",
    "category": "zi",
    "description": "《般若波罗蜜多心经》，大乘般若类经典纲要，二百六十字摄空义总纲。全本。",
    "dynasty": "唐",
    "sizeBytes": 3959,
    "toc": [
      {
        "id": "xinjing-c1",
        "title": "心经"
      }
    ]
  },
  {
    "id": "jingangjing",
    "title": "金刚经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《金刚般若波罗蜜经》，般若类核心经典，言无住生心、无相布施之旨。全本。",
    "dynasty": "后秦",
    "sizeBytes": 19931,
    "toc": [
      {
        "id": "jingangjing-c1",
        "title": "金刚经"
      }
    ]
  },
  {
    "id": "emituofojing",
    "title": "阿弥陀经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《佛说阿弥陀经》，净土宗核心经典，述西方极乐世界依正庄严。全本。",
    "dynasty": "后秦",
    "sizeBytes": 7642,
    "toc": [
      {
        "id": "emituofojing-c1",
        "title": "阿弥陀经"
      }
    ]
  },
  {
    "id": "wuliangshoujing",
    "title": "无量寿经",
    "author": "曹魏·康僧铠 译",
    "category": "zi",
    "description": "《佛说无量寿经》，净土三经之一，述阿弥陀佛四十八愿与净土行果。全本。",
    "dynasty": "曹魏",
    "sizeBytes": 60618,
    "toc": [
      {
        "id": "wuliangshoujing-c1",
        "title": "无量寿经"
      }
    ]
  },
  {
    "id": "guanwuliangshoujing",
    "title": "观无量寿经",
    "author": "刘宋·畺良耶舍 译",
    "category": "zi",
    "description": "《佛说观无量寿佛经》，净土三经之一，明十六观法与三辈往生。全本。",
    "dynasty": "刘宋",
    "sizeBytes": 27354,
    "toc": [
      {
        "id": "guanwuliangshoujing-c1",
        "title": "观无量寿经"
      }
    ]
  },
  {
    "id": "yaoshijing",
    "title": "药师经",
    "author": "隋·达摩笈多 译",
    "category": "zi",
    "description": "《佛说药师如来本愿经》，述药师琉璃光如来十二大愿，济世度厄。全本。",
    "dynasty": "隋",
    "sizeBytes": 16708,
    "toc": [
      {
        "id": "yaoshijing-c1",
        "title": "药师经"
      }
    ]
  },
  {
    "id": "fajujing",
    "title": "法句经",
    "author": "三国吴·维祚难 等译",
    "category": "zi",
    "description": "上座部法句偈颂集汉译本，三十九品七百余偈，言身心谛修之要。全本。",
    "dynasty": "三国",
    "sizeBytes": 61011,
    "toc": [
      {
        "id": "fajujing-c1",
        "title": "无常品第一二十有一章"
      },
      {
        "id": "fajujing-c2",
        "title": "教学品　　法句经第二二十有九章"
      },
      {
        "id": "fajujing-c3",
        "title": "多闻品　　法句经第三十有九章"
      },
      {
        "id": "fajujing-c4",
        "title": "笃信品　　法句经第四十有八章"
      },
      {
        "id": "fajujing-c5",
        "title": "戒慎品　　法句经第五十有六章"
      },
      {
        "id": "fajujing-c6",
        "title": "惟念品　　法句经第六十有二章"
      },
      {
        "id": "fajujing-c7",
        "title": "慈仁品　　法句经第七十有八章"
      },
      {
        "id": "fajujing-c8",
        "title": "言语品　　法句经第八十有二章"
      },
      {
        "id": "fajujing-c9",
        "title": "双要品　　法句经第九二十有二章"
      },
      {
        "id": "fajujing-c10",
        "title": "放逸品　　法句经第十有二十章"
      },
      {
        "id": "fajujing-c11",
        "title": "心意品　　法句经第十一十有二章"
      },
      {
        "id": "fajujing-c12",
        "title": "华香品　　法句经第十二十有七章"
      },
      {
        "id": "fajujing-c13",
        "title": "愚暗品　　法句经第十三二十有一章"
      },
      {
        "id": "fajujing-c14",
        "title": "明哲品　　法句经第十四"
      },
      {
        "id": "fajujing-c15",
        "title": "罗汉品　　法句经第十五有十章"
      },
      {
        "id": "fajujing-c16",
        "title": "述千品　　法句经第十六十有六章"
      },
      {
        "id": "fajujing-c17",
        "title": "恶行品　　法句经第十七二十有二章"
      },
      {
        "id": "fajujing-c18",
        "title": "刀杖品　　法句经第十八十有四章"
      },
      {
        "id": "fajujing-c19",
        "title": "老耗品　　法句经第十九十有四章"
      },
      {
        "id": "fajujing-c20",
        "title": "爱身品　　法句经第二十十有三章"
      },
      {
        "id": "fajujing-c21",
        "title": "世俗品　　法句经第二十一十有四章"
      },
      {
        "id": "fajujing-c22",
        "title": "述佛品　　法句经第二十二二十有一章"
      },
      {
        "id": "fajujing-c23",
        "title": "安宁品　　法句经第二十三十有四章"
      },
      {
        "id": "fajujing-c24",
        "title": "好喜品　　法句经第二十四十有二章"
      },
      {
        "id": "fajujing-c25",
        "title": "忿怒品　　法句经第二十五二十有六章"
      },
      {
        "id": "fajujing-c26",
        "title": "尘垢品　　法句经第二十六十有九章"
      },
      {
        "id": "fajujing-c27",
        "title": "奉持品　　法句经第二十七十有七章"
      },
      {
        "id": "fajujing-c28",
        "title": "道行品　　法句经第二十八二十有八章"
      },
      {
        "id": "fajujing-c29",
        "title": "广衍品　　法句经第二十九十有四章"
      },
      {
        "id": "fajujing-c30",
        "title": "地狱品　　法句经第三十十有六章"
      },
      {
        "id": "fajujing-c31",
        "title": "象喻品　　法句经第三十一十有八章"
      },
      {
        "id": "fajujing-c32",
        "title": "爱欲品　　法句经第三十二三十有二章"
      },
      {
        "id": "fajujing-c33",
        "title": "利养品　　法句经第三十三有二十章"
      },
      {
        "id": "fajujing-c34",
        "title": "沙门品　　法句经第三十四三十有二章"
      },
      {
        "id": "fajujing-c35",
        "title": "梵志品　　法句经第三十五有四十章"
      },
      {
        "id": "fajujing-c36",
        "title": "泥洹品法句经第三十六三十有六章"
      },
      {
        "id": "fajujing-c37",
        "title": "生死品法句经第三十七十有八章"
      },
      {
        "id": "fajujing-c38",
        "title": "道利品法句经第三十八十有九章"
      },
      {
        "id": "fajujing-c39",
        "title": "吉祥品　　法句经第三十九十有九章"
      }
    ]
  },
  {
    "id": "baiyujing",
    "title": "百喻经",
    "author": "萧齐·求那毗地 译",
    "category": "zi",
    "description": "印度僧伽斯那集九十八喻，以寓言譬喻显佛法义理。全本。",
    "dynasty": "南朝齐",
    "sizeBytes": 61904,
    "toc": [
      {
        "id": "baiyujing-c1",
        "title": "（一）愚人食盐喻"
      },
      {
        "id": "baiyujing-c2",
        "title": "（二）愚人集牛乳喻"
      },
      {
        "id": "baiyujing-c3",
        "title": "（三）以梨打头破喻"
      },
      {
        "id": "baiyujing-c4",
        "title": "（四）妇诈称死喻"
      },
      {
        "id": "baiyujing-c5",
        "title": "（五）渴见水喻"
      },
      {
        "id": "baiyujing-c6",
        "title": "（六）子死欲停置家中喻"
      },
      {
        "id": "baiyujing-c7",
        "title": "（七）认人为兄喻"
      },
      {
        "id": "baiyujing-c8",
        "title": "（八）山羌偷官库喻"
      },
      {
        "id": "baiyujing-c9",
        "title": "（九）叹父德行喻"
      },
      {
        "id": "baiyujing-c10",
        "title": "（一○）三重楼喻"
      },
      {
        "id": "baiyujing-c11",
        "title": "（一一）婆罗门杀子喻"
      },
      {
        "id": "baiyujing-c12",
        "title": "（一二）煮黑石蜜浆喻"
      },
      {
        "id": "baiyujing-c13",
        "title": "（一三）说人喜嗔喻"
      },
      {
        "id": "baiyujing-c14",
        "title": "（一四）杀商主祀天喻"
      },
      {
        "id": "baiyujing-c15",
        "title": "（一五）医与王女药令卒长大喻"
      },
      {
        "id": "baiyujing-c16",
        "title": "（一六）灌甘蔗喻"
      },
      {
        "id": "baiyujing-c17",
        "title": "（一七）债半钱喻"
      },
      {
        "id": "baiyujing-c18",
        "title": "（一八）就楼磨刀喻"
      },
      {
        "id": "baiyujing-c19",
        "title": "（一九）乘船失釪喻"
      },
      {
        "id": "baiyujing-c20",
        "title": "（二○）人说王纵暴喻"
      },
      {
        "id": "baiyujing-c21",
        "title": "（二一）妇女欲更求子喻"
      },
      {
        "id": "baiyujing-c22",
        "title": "缘起"
      },
      {
        "id": "baiyujing-c23",
        "title": "（二二）入海取沉水喻"
      },
      {
        "id": "baiyujing-c24",
        "title": "（二三）贼偷锦绣用裹氀褐喻"
      },
      {
        "id": "baiyujing-c25",
        "title": "（二四）种熬胡麻子喻"
      },
      {
        "id": "baiyujing-c26",
        "title": "（二五）水火喻"
      },
      {
        "id": "baiyujing-c27",
        "title": "（二六）人效王眼瞤喻"
      },
      {
        "id": "baiyujing-c28",
        "title": "（二七）治鞭疮喻"
      },
      {
        "id": "baiyujing-c29",
        "title": "（二八）为妇贸鼻喻"
      },
      {
        "id": "baiyujing-c30",
        "title": "（二九）贫人烧粗褐衣喻"
      },
      {
        "id": "baiyujing-c31",
        "title": "（三○）牧羊人喻"
      },
      {
        "id": "baiyujing-c32",
        "title": "（三一）雇借瓦师喻"
      },
      {
        "id": "baiyujing-c33",
        "title": "（三二）估客偷金喻"
      },
      {
        "id": "baiyujing-c34",
        "title": "（三三）斫树取果喻"
      },
      {
        "id": "baiyujing-c35",
        "title": "（三四）送美水喻"
      },
      {
        "id": "baiyujing-c36",
        "title": "（三五）宝箧镜喻"
      },
      {
        "id": "baiyujing-c37",
        "title": "（三六）破五通仙眼喻"
      },
      {
        "id": "baiyujing-c38",
        "title": "（三七）杀群牛喻"
      },
      {
        "id": "baiyujing-c39",
        "title": "（三八）饮木筒水喻"
      },
      {
        "id": "baiyujing-c40",
        "title": "（三九）见他人涂舍喻"
      },
      {
        "id": "baiyujing-c41",
        "title": "（四○）治秃喻"
      },
      {
        "id": "baiyujing-c42",
        "title": "（四一）毗舍阇鬼喻"
      },
      {
        "id": "baiyujing-c43",
        "title": "（四二）估客驼死喻"
      },
      {
        "id": "baiyujing-c44",
        "title": "（四三）磨大石喻"
      },
      {
        "id": "baiyujing-c45",
        "title": "（四四）欲食半饼喻"
      },
      {
        "id": "baiyujing-c46",
        "title": "（四五）奴守门喻"
      },
      {
        "id": "baiyujing-c47",
        "title": "（四六）偷牦牛喻"
      },
      {
        "id": "baiyujing-c48",
        "title": "（四七）贫人作鸳鸯鸣喻"
      },
      {
        "id": "baiyujing-c49",
        "title": "（四八）野干为折树枝所打喻"
      },
      {
        "id": "baiyujing-c50",
        "title": "（四九）小儿争分别毛喻"
      },
      {
        "id": "baiyujing-c51",
        "title": "（五○）医治脊偻喻"
      },
      {
        "id": "baiyujing-c52",
        "title": "（五一）五人买婢共使作喻"
      },
      {
        "id": "baiyujing-c53",
        "title": "（五二）伎儿作乐喻"
      },
      {
        "id": "baiyujing-c54",
        "title": "（五三）师患脚付二弟子喻"
      },
      {
        "id": "baiyujing-c55",
        "title": "（五四）蛇头尾共争在前喻"
      },
      {
        "id": "baiyujing-c56",
        "title": "（五五）愿为王剃须喻"
      },
      {
        "id": "baiyujing-c57",
        "title": "（五六）索无物喻"
      },
      {
        "id": "baiyujing-c58",
        "title": "（五七）蹋长者口喻"
      },
      {
        "id": "baiyujing-c59",
        "title": "（五八）二子分财喻"
      },
      {
        "id": "baiyujing-c60",
        "title": "（五九）观作瓶喻"
      },
      {
        "id": "baiyujing-c61",
        "title": "（六○）见水底金影喻"
      },
      {
        "id": "baiyujing-c62",
        "title": "（六一）梵天弟子造物因喻"
      },
      {
        "id": "baiyujing-c63",
        "title": "（六二）病人食雉肉喻"
      },
      {
        "id": "baiyujing-c64",
        "title": "（六三）伎儿著戏罗刹服共相惊怖喻"
      },
      {
        "id": "baiyujing-c65",
        "title": "（六四）人谓故屋中有恶鬼喻"
      },
      {
        "id": "baiyujing-c66",
        "title": "（六五）五百欢喜丸喻"
      },
      {
        "id": "baiyujing-c67",
        "title": "（六六）口诵乘船法而不解用喻"
      },
      {
        "id": "baiyujing-c68",
        "title": "（六七）夫妇食饼共为要喻"
      },
      {
        "id": "baiyujing-c69",
        "title": "（六八）共相怨害喻"
      },
      {
        "id": "baiyujing-c70",
        "title": "（六九）效其祖先急速食喻"
      },
      {
        "id": "baiyujing-c71",
        "title": "（七○）尝庵婆罗果喻"
      },
      {
        "id": "baiyujing-c72",
        "title": "（七一）为二妇故丧其两目喻"
      },
      {
        "id": "baiyujing-c73",
        "title": "（七二）唵米决口喻"
      },
      {
        "id": "baiyujing-c74",
        "title": "（七三）诈言马死喻"
      },
      {
        "id": "baiyujing-c75",
        "title": "（七四）出家凡夫贪利养喻"
      },
      {
        "id": "baiyujing-c76",
        "title": "（七五）驼瓮俱失喻"
      },
      {
        "id": "baiyujing-c77",
        "title": "（七六）田夫思王女喻"
      },
      {
        "id": "baiyujing-c78",
        "title": "（七七）构驴乳喻"
      },
      {
        "id": "baiyujing-c79",
        "title": "（七八）与儿期早行喻"
      },
      {
        "id": "baiyujing-c80",
        "title": "（七九）为王负机喻"
      },
      {
        "id": "baiyujing-c81",
        "title": "（八○）倒灌喻"
      },
      {
        "id": "baiyujing-c82",
        "title": "（八一）为熊所啮喻"
      },
      {
        "id": "baiyujing-c83",
        "title": "（八二）比种田喻"
      },
      {
        "id": "baiyujing-c84",
        "title": "（八三）猕猴喻"
      },
      {
        "id": "baiyujing-c85",
        "title": "（八四）月蚀打狗喻"
      },
      {
        "id": "baiyujing-c86",
        "title": "（八五）妇女患眼痛喻"
      },
      {
        "id": "baiyujing-c87",
        "title": "（八六）父取儿耳珰喻"
      },
      {
        "id": "baiyujing-c88",
        "title": "（八七）劫盗分财喻"
      },
      {
        "id": "baiyujing-c89",
        "title": "（八八）猕猴把豆喻"
      },
      {
        "id": "baiyujing-c90",
        "title": "（八九）得金鼠狼喻"
      },
      {
        "id": "baiyujing-c91",
        "title": "（九○）地得金钱喻"
      },
      {
        "id": "baiyujing-c92",
        "title": "（九一）贫儿欲与富等财物喻"
      },
      {
        "id": "baiyujing-c93",
        "title": "（九二）小儿得欢喜丸喻"
      },
      {
        "id": "baiyujing-c94",
        "title": "（九三）老母捉熊喻"
      },
      {
        "id": "baiyujing-c95",
        "title": "（九四）摩尼水窦喻"
      },
      {
        "id": "baiyujing-c96",
        "title": "（九五）一鸽喻"
      },
      {
        "id": "baiyujing-c97",
        "title": "（九六）诈称眼盲喻"
      },
      {
        "id": "baiyujing-c98",
        "title": "（九七）为恶贼所劫失[叠*毛]喻"
      },
      {
        "id": "baiyujing-c99",
        "title": "（九八）小儿得大龟喻"
      }
    ]
  },
  {
    "id": "sishierzhangjing",
    "title": "四十二章经",
    "author": "东汉·迦叶摩腾、竺法兰 译",
    "category": "zi",
    "description": "相传为汉地最早译出的佛经，四十二章摄出家修行纲要。全本。",
    "dynasty": "东汉",
    "sizeBytes": 8862,
    "toc": [
      {
        "id": "sishierzhangjing-c1",
        "title": "四十二章经"
      }
    ]
  },
  {
    "id": "yuanjuejing",
    "title": "圆觉经",
    "author": "唐·佛陀多罗 译",
    "category": "zi",
    "description": "《大方广圆觉修多罗了义经》，述十二菩萨问圆觉法门。全本。",
    "dynasty": "唐",
    "sizeBytes": 40888,
    "toc": [
      {
        "id": "yuanjuejing-c1",
        "title": "圆觉经"
      }
    ]
  },
  {
    "id": "yijiaojing",
    "title": "佛遗教经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "释迦牟尼临涅槃所述遗诫，又称《佛垂般涅槃略说教诫经》。全本。",
    "dynasty": "后秦",
    "sizeBytes": 8275,
    "toc": [
      {
        "id": "yijiaojing-c1",
        "title": "佛遗教经"
      }
    ]
  },
  {
    "id": "badarenjuejing",
    "title": "八大人觉经",
    "author": "东汉·安世高 译",
    "category": "zi",
    "description": "述诸佛菩萨大人所觉悟之八法，明出世解脱路径。全本。",
    "dynasty": "东汉",
    "sizeBytes": 1555,
    "toc": [
      {
        "id": "badarenjuejing-c1",
        "title": "八大人觉经"
      }
    ]
  },
  {
    "id": "weimojing",
    "title": "维摩诘经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《维摩诘所说经》十四品，示在家菩萨不可思议解脱法门。全本。",
    "dynasty": "后秦",
    "sizeBytes": 92710,
    "toc": [
      {
        "id": "weimojing-c1",
        "title": "佛国品第一"
      },
      {
        "id": "weimojing-c2",
        "title": "方便品第二"
      },
      {
        "id": "weimojing-c3",
        "title": "弟子品第三"
      },
      {
        "id": "weimojing-c4",
        "title": "菩萨品第四"
      },
      {
        "id": "weimojing-c5",
        "title": "文殊师利问疾品第五"
      },
      {
        "id": "weimojing-c6",
        "title": "不思议品第六"
      },
      {
        "id": "weimojing-c7",
        "title": "观众生品第七"
      },
      {
        "id": "weimojing-c8",
        "title": "佛道品第八"
      },
      {
        "id": "weimojing-c9",
        "title": "入不二法门品第九"
      },
      {
        "id": "weimojing-c10",
        "title": "香积佛品第十"
      },
      {
        "id": "weimojing-c11",
        "title": "菩萨行品第十一"
      },
      {
        "id": "weimojing-c12",
        "title": "见阿閦佛品第十二"
      },
      {
        "id": "weimojing-c13",
        "title": "法供养品第十三"
      },
      {
        "id": "weimojing-c14",
        "title": "嘱累品第十四"
      }
    ]
  },
  {
    "id": "fahuajing",
    "title": "妙法莲华经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《妙法莲华经》二十八品，开权显实、会三归一之大乘要典。全本。",
    "dynasty": "后秦",
    "sizeBytes": 282419,
    "toc": [
      {
        "id": "fahuajing-c1",
        "title": "序品第一"
      },
      {
        "id": "fahuajing-c2",
        "title": "方便品第二"
      },
      {
        "id": "fahuajing-c3",
        "title": "譬喻品第三"
      },
      {
        "id": "fahuajing-c4",
        "title": "信解品第四"
      },
      {
        "id": "fahuajing-c5",
        "title": "药草喻品第五"
      },
      {
        "id": "fahuajing-c6",
        "title": "授记品第六"
      },
      {
        "id": "fahuajing-c7",
        "title": "化城喻品第七"
      },
      {
        "id": "fahuajing-c8",
        "title": "五百弟子受记品第八"
      },
      {
        "id": "fahuajing-c9",
        "title": "授学无学人记品第九"
      },
      {
        "id": "fahuajing-c10",
        "title": "法师品第十"
      },
      {
        "id": "fahuajing-c11",
        "title": "见宝塔品第十一"
      },
      {
        "id": "fahuajing-c12",
        "title": "提婆达多品第十二"
      },
      {
        "id": "fahuajing-c13",
        "title": "劝持品第十三"
      },
      {
        "id": "fahuajing-c14",
        "title": "安乐行品第十四"
      },
      {
        "id": "fahuajing-c15",
        "title": "从地踊出品第十五"
      },
      {
        "id": "fahuajing-c16",
        "title": "如来寿量品第十六"
      },
      {
        "id": "fahuajing-c17",
        "title": "分别功德品第十七"
      },
      {
        "id": "fahuajing-c18",
        "title": "随喜功德品第十八"
      },
      {
        "id": "fahuajing-c19",
        "title": "法师功德品第十九"
      },
      {
        "id": "fahuajing-c20",
        "title": "常不轻菩萨品第二十"
      },
      {
        "id": "fahuajing-c21",
        "title": "如来神力品第二十一"
      },
      {
        "id": "fahuajing-c22",
        "title": "嘱累品第二十二"
      },
      {
        "id": "fahuajing-c23",
        "title": "药王菩萨本事品第二十三"
      },
      {
        "id": "fahuajing-c24",
        "title": "妙音菩萨品第二十四"
      },
      {
        "id": "fahuajing-c25",
        "title": "观世音菩萨普门品第二十五"
      },
      {
        "id": "fahuajing-c26",
        "title": "陀罗尼品第二十六"
      },
      {
        "id": "fahuajing-c27",
        "title": "妙庄严王本事品第二十七"
      },
      {
        "id": "fahuajing-c28",
        "title": "普贤菩萨劝发品第二十八"
      }
    ]
  },
  {
    "id": "lengyanjing",
    "title": "楞严经",
    "author": "唐·般剌蜜帝 译",
    "category": "zi",
    "description": "《大佛顶首楞严经》十卷，明心见性、五十阴魔之照胆镜。全本。",
    "dynasty": "唐",
    "sizeBytes": 224161,
    "toc": [
      {
        "id": "lengyanjing-c1",
        "title": "卷第一"
      },
      {
        "id": "lengyanjing-c2",
        "title": "卷第二"
      },
      {
        "id": "lengyanjing-c3",
        "title": "卷第三"
      },
      {
        "id": "lengyanjing-c4",
        "title": "卷第四"
      },
      {
        "id": "lengyanjing-c5",
        "title": "卷第五"
      },
      {
        "id": "lengyanjing-c6",
        "title": "卷第六"
      },
      {
        "id": "lengyanjing-c7",
        "title": "卷第七"
      },
      {
        "id": "lengyanjing-c8",
        "title": "卷第八"
      },
      {
        "id": "lengyanjing-c9",
        "title": "卷第九"
      }
    ]
  },
  {
    "id": "dizangjing",
    "title": "地藏经",
    "author": "唐·实叉难陀 译",
    "category": "zi",
    "description": "《地藏菩萨本愿经》十三品，明孝道与地狱救度之愿力。全本。",
    "dynasty": "唐",
    "sizeBytes": 57386,
    "toc": [
      {
        "id": "dizangjing-c1",
        "title": "忉利天宫神通品第一"
      },
      {
        "id": "dizangjing-c2",
        "title": "分身集会品第二"
      },
      {
        "id": "dizangjing-c3",
        "title": "观众生业缘品第三"
      },
      {
        "id": "dizangjing-c4",
        "title": "阎浮众生业感品第四"
      },
      {
        "id": "dizangjing-c5",
        "title": "地狱名号品第五"
      },
      {
        "id": "dizangjing-c6",
        "title": "如来赞叹品第六"
      },
      {
        "id": "dizangjing-c7",
        "title": "利益存亡品第七"
      },
      {
        "id": "dizangjing-c8",
        "title": "阎罗王众赞叹品第八"
      },
      {
        "id": "dizangjing-c9",
        "title": "称佛名号品第九"
      },
      {
        "id": "dizangjing-c10",
        "title": "校量布施功德缘品第十"
      },
      {
        "id": "dizangjing-c11",
        "title": "地神护法品第十一"
      },
      {
        "id": "dizangjing-c12",
        "title": "见闻利益品第十二"
      },
      {
        "id": "dizangjing-c13",
        "title": "嘱累人天品第十三"
      }
    ]
  },
  {
    "id": "liuzutanjing",
    "title": "六祖坛经",
    "author": "唐·法海 集记",
    "category": "zi",
    "description": "禅宗六祖惠能于韶州大梵寺说法集录，唯一被尊称为「经」的中国僧人著述。全本。",
    "dynasty": "唐",
    "sizeBytes": 73315,
    "toc": [
      {
        "id": "liuzutanjing-c1",
        "title": "自序品第一"
      },
      {
        "id": "liuzutanjing-c2",
        "title": "般若品第二"
      },
      {
        "id": "liuzutanjing-c3",
        "title": "决疑品第三"
      },
      {
        "id": "liuzutanjing-c4",
        "title": "定慧品第四"
      },
      {
        "id": "liuzutanjing-c5",
        "title": "妙行品第五"
      },
      {
        "id": "liuzutanjing-c6",
        "title": "忏悔品第六"
      },
      {
        "id": "liuzutanjing-c7",
        "title": "机缘品第七"
      },
      {
        "id": "liuzutanjing-c8",
        "title": "顿渐品第八"
      },
      {
        "id": "liuzutanjing-c9",
        "title": "护法品第九"
      },
      {
        "id": "liuzutanjing-c10",
        "title": "付嘱品第十"
      }
    ]
  },
  {
    "id": "qingjingjing",
    "title": "清静经",
    "author": "唐·佚名（旧题太上老君说）",
    "category": "zi",
    "description": "《太上老君说常清静经》，澄心遣欲、内修心神之道家要典。全本。",
    "dynasty": "唐",
    "sizeBytes": 2256,
    "toc": [
      {
        "id": "qingjingjing-c1",
        "title": "清静经"
      }
    ]
  },
  {
    "id": "yinfujing",
    "title": "阴符经",
    "author": "旧题黄帝撰（唐·李筌得于嵩山）",
    "category": "zi",
    "description": "《黄帝阴符经》三百余字，言观天之道、执天之行。全本。",
    "dynasty": "唐",
    "sizeBytes": 1796,
    "toc": [
      {
        "id": "yinfujing-c1",
        "title": "阴符经"
      }
    ]
  },
  {
    "id": "guanyinzi",
    "title": "关尹子",
    "author": "周·关令尹喜 著",
    "category": "zi",
    "description": "又称《文始真经》九篇，以宇柱极符鉴匕釜筹药名篇。全本。",
    "dynasty": "先秦",
    "sizeBytes": 39374,
    "toc": [
      {
        "id": "guanyinzi-c1",
        "title": "序传"
      },
      {
        "id": "guanyinzi-c2",
        "title": "一字"
      },
      {
        "id": "guanyinzi-c3",
        "title": "二柱"
      },
      {
        "id": "guanyinzi-c4",
        "title": "三极"
      },
      {
        "id": "guanyinzi-c5",
        "title": "四符"
      },
      {
        "id": "guanyinzi-c6",
        "title": "五鉴"
      },
      {
        "id": "guanyinzi-c7",
        "title": "六匕"
      },
      {
        "id": "guanyinzi-c8",
        "title": "七釜"
      },
      {
        "id": "guanyinzi-c9",
        "title": "八筹"
      },
      {
        "id": "guanyinzi-c10",
        "title": "九药"
      }
    ]
  },
  {
    "id": "guiguzi",
    "title": "鬼谷子",
    "author": "旧题战国·鬼谷子 著",
    "category": "zi",
    "description": "纵横家鼻祖之书，捭阖、反应、揣摩、权谋十二篇。全本。",
    "dynasty": "战国",
    "sizeBytes": 89033,
    "toc": [
      {
        "id": "guiguzi-c1",
        "title": "摔阖第一"
      },
      {
        "id": "guiguzi-c2",
        "title": "反应第二"
      },
      {
        "id": "guiguzi-c3",
        "title": "内键第三"
      },
      {
        "id": "guiguzi-c4",
        "title": "抵职第四"
      },
      {
        "id": "guiguzi-c5",
        "title": "飞箝第五"
      },
      {
        "id": "guiguzi-c6",
        "title": "作合第六"
      },
      {
        "id": "guiguzi-c7",
        "title": "揣篇第七"
      },
      {
        "id": "guiguzi-c8",
        "title": "摩篇第八"
      },
      {
        "id": "guiguzi-c9",
        "title": "权篇第九"
      },
      {
        "id": "guiguzi-c10",
        "title": "谋篇第十"
      },
      {
        "id": "guiguzi-c11",
        "title": "决篇第十一"
      },
      {
        "id": "guiguzi-c12",
        "title": "符言第十二"
      }
    ]
  },
  {
    "id": "liezi",
    "title": "列子",
    "author": "战国·列御寇 著",
    "category": "zi",
    "description": "又称《冲虚至德真经》八篇，寓道于寓言，天瑞说符俱载。全本。",
    "dynasty": "战国",
    "sizeBytes": 111697,
    "toc": [
      {
        "id": "liezi-c1",
        "title": "天瑞第一"
      },
      {
        "id": "liezi-c2",
        "title": "黄帝第二"
      },
      {
        "id": "liezi-c3",
        "title": "周穆王第三"
      },
      {
        "id": "liezi-c4",
        "title": "仲尼第四"
      },
      {
        "id": "liezi-c5",
        "title": "汤问第五"
      },
      {
        "id": "liezi-c6",
        "title": "力命第六"
      },
      {
        "id": "liezi-c7",
        "title": "杨朱第七"
      },
      {
        "id": "liezi-c8",
        "title": "说符第八"
      }
    ]
  },
  {
    "id": "heguanzi",
    "title": "鹖冠子",
    "author": "战国·鹖冠子 著（宋·陆佃解）",
    "category": "zi",
    "description": "道家与纵横家言杂糅之子书十九篇。全本。",
    "dynasty": "战国",
    "sizeBytes": 124155,
    "toc": [
      {
        "id": "heguanzi-c1",
        "title": "博选第一"
      },
      {
        "id": "heguanzi-c2",
        "title": "着希第二"
      },
      {
        "id": "heguanzi-c3",
        "title": "夜行第三"
      },
      {
        "id": "heguanzi-c4",
        "title": "天则第四"
      },
      {
        "id": "heguanzi-c5",
        "title": "环流第五"
      },
      {
        "id": "heguanzi-c6",
        "title": "道端第六"
      },
      {
        "id": "heguanzi-c7",
        "title": "近迭第七"
      },
      {
        "id": "heguanzi-c8",
        "title": "度万第八"
      },
      {
        "id": "heguanzi-c9",
        "title": "王𫓧第九"
      },
      {
        "id": "heguanzi-c10",
        "title": "泰鸿第十"
      },
      {
        "id": "heguanzi-c11",
        "title": "泰录第十一"
      },
      {
        "id": "heguanzi-c12",
        "title": "世兵第十二"
      },
      {
        "id": "heguanzi-c13",
        "title": "备知第十三"
      },
      {
        "id": "heguanzi-c14",
        "title": "兵政第十四"
      },
      {
        "id": "heguanzi-c15",
        "title": "学问第十五"
      },
      {
        "id": "heguanzi-c16",
        "title": "世贤第十六"
      },
      {
        "id": "heguanzi-c17",
        "title": "天权第十七"
      },
      {
        "id": "heguanzi-c18",
        "title": "能天第十八"
      },
      {
        "id": "heguanzi-c19",
        "title": "武灵王第十九"
      }
    ]
  },
  {
    "id": "huainanzi",
    "title": "淮南子",
    "author": "西汉·刘安 撰（许慎 注）",
    "category": "zi",
    "description": "《淮南鸿烈解》二十八卷，集道家思想大成的鸿篇。全本。",
    "dynasty": "西汉",
    "sizeBytes": 710164,
    "toc": [
      {
        "id": "huainanzi-c1",
        "title": "叙"
      },
      {
        "id": "huainanzi-c2",
        "title": "卷之一·原道训上"
      },
      {
        "id": "huainanzi-c3",
        "title": "卷之二·原道训下"
      },
      {
        "id": "huainanzi-c4",
        "title": "卷之三·俶真训上"
      },
      {
        "id": "huainanzi-c5",
        "title": "卷之四·俶真训下"
      },
      {
        "id": "huainanzi-c6",
        "title": "卷之五·天文训上"
      },
      {
        "id": "huainanzi-c7",
        "title": "卷之六·天文训下"
      },
      {
        "id": "huainanzi-c8",
        "title": "卷之七·地形训上"
      },
      {
        "id": "huainanzi-c9",
        "title": "卷之八·地形训下"
      },
      {
        "id": "huainanzi-c10",
        "title": "卷之九·时则训上"
      },
      {
        "id": "huainanzi-c11",
        "title": "卷之十·时则训下"
      },
      {
        "id": "huainanzi-c12",
        "title": "卷之十一·览冥训"
      },
      {
        "id": "huainanzi-c13",
        "title": "卷之十二·精神训"
      },
      {
        "id": "huainanzi-c14",
        "title": "卷之十三·本经训"
      },
      {
        "id": "huainanzi-c15",
        "title": "卷之十四·主术训上"
      },
      {
        "id": "huainanzi-c16",
        "title": "卷之十五·主术训下"
      },
      {
        "id": "huainanzi-c17",
        "title": "卷之十六·缪称训"
      },
      {
        "id": "huainanzi-c18",
        "title": "卷之十七·齐俗训"
      },
      {
        "id": "huainanzi-c19",
        "title": "卷之十八·道应训"
      },
      {
        "id": "huainanzi-c20",
        "title": "卷之十九·泛论训上"
      },
      {
        "id": "huainanzi-c21",
        "title": "卷之二十·泛论训下"
      },
      {
        "id": "huainanzi-c22",
        "title": "卷之二十一·诠言训"
      },
      {
        "id": "huainanzi-c23",
        "title": "卷之二十二·兵略训"
      },
      {
        "id": "huainanzi-c24",
        "title": "卷之二十三·说山训"
      },
      {
        "id": "huainanzi-c25",
        "title": "卷之二十四·说林训"
      },
      {
        "id": "huainanzi-c26",
        "title": "卷之二十五·人间训"
      },
      {
        "id": "huainanzi-c27",
        "title": "卷之二十六·修务训"
      },
      {
        "id": "huainanzi-c28",
        "title": "卷之二十七·泰族训"
      },
      {
        "id": "huainanzi-c29",
        "title": "卷之二十八·要略"
      }
    ]
  },
  {
    "id": "baopuzi",
    "title": "抱朴子内篇",
    "author": "东晋·葛洪 著",
    "category": "zi",
    "description": "金丹道教理论奠基之作二十卷，言神仙方药、养生延年。全本。",
    "dynasty": "东晋",
    "sizeBytes": 268641,
    "toc": [
      {
        "id": "baopuzi-c1",
        "title": "序"
      },
      {
        "id": "baopuzi-c2",
        "title": "卷之一·畅玄"
      },
      {
        "id": "baopuzi-c3",
        "title": "卷之二·论仙"
      },
      {
        "id": "baopuzi-c4",
        "title": "卷之三·对俗"
      },
      {
        "id": "baopuzi-c5",
        "title": "卷之四·金丹"
      },
      {
        "id": "baopuzi-c6",
        "title": "卷之五·至理"
      },
      {
        "id": "baopuzi-c7",
        "title": "卷之六·微旨"
      },
      {
        "id": "baopuzi-c8",
        "title": "卷之七·塞难"
      },
      {
        "id": "baopuzi-c9",
        "title": "卷之八·释滞"
      },
      {
        "id": "baopuzi-c10",
        "title": "卷之九·道意"
      },
      {
        "id": "baopuzi-c11",
        "title": "卷之十·明本"
      },
      {
        "id": "baopuzi-c12",
        "title": "卷之十一·仙药"
      },
      {
        "id": "baopuzi-c13",
        "title": "卷之十二·辨问"
      },
      {
        "id": "baopuzi-c14",
        "title": "卷之十三·极言"
      },
      {
        "id": "baopuzi-c15",
        "title": "卷之十四·勤求"
      },
      {
        "id": "baopuzi-c16",
        "title": "卷之十五·杂应"
      },
      {
        "id": "baopuzi-c17",
        "title": "卷之十六·黄白"
      },
      {
        "id": "baopuzi-c18",
        "title": "卷之十七·登涉"
      },
      {
        "id": "baopuzi-c19",
        "title": "卷之十八·地真"
      },
      {
        "id": "baopuzi-c20",
        "title": "卷之十九·遐览"
      },
      {
        "id": "baopuzi-c21",
        "title": "卷之二十·祛惑"
      }
    ]
  },
  {
    "id": "huashu",
    "title": "化书",
    "author": "五代·谭峭 著",
    "category": "zi",
    "description": "道化、术化、德化、仁化、食化、俭化六卷，观物化之理。全本。",
    "dynasty": "五代",
    "sizeBytes": 42542,
    "toc": [
      {
        "id": "huashu-c1",
        "title": "道化卷第一"
      },
      {
        "id": "huashu-c2",
        "title": "卫化卷第二"
      },
      {
        "id": "huashu-c3",
        "title": "德化卷第三"
      },
      {
        "id": "huashu-c4",
        "title": "仁化卷第四"
      },
      {
        "id": "huashu-c5",
        "title": "食化卷第五"
      },
      {
        "id": "huashu-c6",
        "title": "俭化卷第六"
      }
    ]
  },
  {
    "id": "wuzhenpian",
    "title": "悟真篇",
    "author": "北宋·张伯端 著",
    "category": "zi",
    "description": "内丹南宗祖经，据《修真十书》本，与《参同契》并尊。全本。",
    "dynasty": "北宋",
    "sizeBytes": 116489,
    "toc": [
      {
        "id": "wuzhenpian-c1",
        "title": "悟真篇"
      }
    ]
  },
  {
    "id": "zuowanglun",
    "title": "坐忘论",
    "author": "唐·司马承祯 著",
    "category": "zi",
    "description": "道教修真理论名篇，敬信至得道七阶及枢翼。全本。",
    "dynasty": "唐",
    "sizeBytes": 22295,
    "toc": [
      {
        "id": "zuowanglun-c1",
        "title": "序"
      },
      {
        "id": "zuowanglun-c2",
        "title": "敬信一"
      },
      {
        "id": "zuowanglun-c3",
        "title": "断缘二"
      },
      {
        "id": "zuowanglun-c4",
        "title": "收心三"
      },
      {
        "id": "zuowanglun-c5",
        "title": "简事四"
      },
      {
        "id": "zuowanglun-c6",
        "title": "真观五"
      },
      {
        "id": "zuowanglun-c7",
        "title": "泰定六"
      },
      {
        "id": "zuowanglun-c8",
        "title": "得道七"
      }
    ]
  },
  {
    "id": "ganyingpian",
    "title": "太上感应篇",
    "author": "宋·李昌龄 传、郑清之 赞",
    "category": "zi",
    "description": "以太上本文冠首，附李昌龄传、郑清之赞三十卷，劝善书之首。全本。",
    "dynasty": "宋",
    "sizeBytes": 314424,
    "toc": [
      {
        "id": "ganyingpian-c1",
        "title": "感应篇本文"
      },
      {
        "id": "ganyingpian-c2",
        "title": "进表"
      },
      {
        "id": "ganyingpian-c3",
        "title": "卷之二"
      },
      {
        "id": "ganyingpian-c4",
        "title": "卷之三"
      },
      {
        "id": "ganyingpian-c5",
        "title": "卷之四"
      },
      {
        "id": "ganyingpian-c6",
        "title": "卷之五"
      },
      {
        "id": "ganyingpian-c7",
        "title": "卷之六"
      },
      {
        "id": "ganyingpian-c8",
        "title": "卷之七"
      },
      {
        "id": "ganyingpian-c9",
        "title": "卷之八"
      },
      {
        "id": "ganyingpian-c10",
        "title": "卷之九"
      },
      {
        "id": "ganyingpian-c11",
        "title": "卷之十"
      },
      {
        "id": "ganyingpian-c12",
        "title": "卷之十一"
      },
      {
        "id": "ganyingpian-c13",
        "title": "卷之十二"
      },
      {
        "id": "ganyingpian-c14",
        "title": "卷之十三"
      },
      {
        "id": "ganyingpian-c15",
        "title": "卷之十四"
      },
      {
        "id": "ganyingpian-c16",
        "title": "卷之十五"
      },
      {
        "id": "ganyingpian-c17",
        "title": "卷之十六"
      },
      {
        "id": "ganyingpian-c18",
        "title": "卷之十七"
      },
      {
        "id": "ganyingpian-c19",
        "title": "卷之十八"
      },
      {
        "id": "ganyingpian-c20",
        "title": "卷之十九"
      },
      {
        "id": "ganyingpian-c21",
        "title": "卷之二十一"
      },
      {
        "id": "ganyingpian-c22",
        "title": "卷之二十三"
      },
      {
        "id": "ganyingpian-c23",
        "title": "卷之二十四"
      },
      {
        "id": "ganyingpian-c24",
        "title": "卷之二十八"
      },
      {
        "id": "ganyingpian-c25",
        "title": "卷之二十九"
      }
    ]
  },
  {
    "id": "xiaojing",
    "title": "孝经",
    "author": "先秦·孔门后学（旧题曾子问、孔子说）",
    "category": "jing",
    "description": "儒家孝道经典，十八章，以孝为德之本、教之源。全本。",
    "dynasty": "先秦",
    "sizeBytes": 7267,
    "toc": [
      {
        "id": "xiaojing-c1",
        "title": "开宗明义章第一"
      },
      {
        "id": "xiaojing-c2",
        "title": "卿大夫章第四"
      },
      {
        "id": "xiaojing-c3",
        "title": "士章第五"
      },
      {
        "id": "xiaojing-c4",
        "title": "庶人章第六"
      },
      {
        "id": "xiaojing-c5",
        "title": "三才章第七"
      },
      {
        "id": "xiaojing-c6",
        "title": "五刑章第十一"
      },
      {
        "id": "xiaojing-c7",
        "title": "广要道章第十二"
      },
      {
        "id": "xiaojing-c8",
        "title": "广至德章第十三"
      },
      {
        "id": "xiaojing-c9",
        "title": "广扬名章第十四"
      },
      {
        "id": "xiaojing-c10",
        "title": "谏诤章第十五"
      },
      {
        "id": "xiaojing-c11",
        "title": "感应章第十六"
      }
    ]
  },
  {
    "id": "erya",
    "title": "尔雅",
    "author": "先秦～西汉·学者缀辑",
    "category": "jing",
    "description": "中国第一部训诂词典，十九篇释诂释言至释兽释畜，读经之津梁。全本。",
    "dynasty": "先秦",
    "sizeBytes": 49164,
    "toc": [
      {
        "id": "erya-c1",
        "title": "释诂第一"
      },
      {
        "id": "erya-c2",
        "title": "释言第二"
      },
      {
        "id": "erya-c3",
        "title": "释训第三"
      },
      {
        "id": "erya-c4",
        "title": "释亲第四"
      },
      {
        "id": "erya-c5",
        "title": "释宫第五"
      },
      {
        "id": "erya-c6",
        "title": "释器第六"
      },
      {
        "id": "erya-c7",
        "title": "释乐第七"
      },
      {
        "id": "erya-c8",
        "title": "释天第八"
      },
      {
        "id": "erya-c9",
        "title": "释地第九"
      },
      {
        "id": "erya-c10",
        "title": "释丘第十"
      },
      {
        "id": "erya-c11",
        "title": "释山第十一"
      },
      {
        "id": "erya-c12",
        "title": "释水第十二"
      },
      {
        "id": "erya-c13",
        "title": "释草第十三"
      },
      {
        "id": "erya-c14",
        "title": "释木第十四"
      },
      {
        "id": "erya-c15",
        "title": "释虫第十五"
      },
      {
        "id": "erya-c16",
        "title": "释鱼第十六"
      },
      {
        "id": "erya-c17",
        "title": "释鸟第十七"
      },
      {
        "id": "erya-c18",
        "title": "释兽第十八"
      },
      {
        "id": "erya-c19",
        "title": "释畜第十九"
      }
    ]
  },
  {
    "id": "liji",
    "title": "礼记",
    "author": "西汉·戴圣 编（旧题郑玄 注）",
    "category": "jing",
    "description": "儒家礼学论文与礼制文献汇编四十九篇，与《周礼》《仪礼》并称三礼。全本。",
    "dynasty": "西汉",
    "sizeBytes": 367608,
    "toc": [
      {
        "id": "liji-c1",
        "title": "曲礼"
      },
      {
        "id": "liji-c2",
        "title": "檀弓"
      },
      {
        "id": "liji-c3",
        "title": "王制"
      },
      {
        "id": "liji-c4",
        "title": "月令"
      },
      {
        "id": "liji-c5",
        "title": "曾子问"
      },
      {
        "id": "liji-c6",
        "title": "文王世子"
      },
      {
        "id": "liji-c7",
        "title": "礼运"
      },
      {
        "id": "liji-c8",
        "title": "礼器"
      },
      {
        "id": "liji-c9",
        "title": "郊特牲"
      },
      {
        "id": "liji-c10",
        "title": "内则"
      },
      {
        "id": "liji-c11",
        "title": "玉藻"
      },
      {
        "id": "liji-c12",
        "title": "明堂位"
      },
      {
        "id": "liji-c13",
        "title": "丧服小记"
      },
      {
        "id": "liji-c14",
        "title": "大传"
      },
      {
        "id": "liji-c15",
        "title": "少仪"
      },
      {
        "id": "liji-c16",
        "title": "学记"
      },
      {
        "id": "liji-c17",
        "title": "乐记"
      },
      {
        "id": "liji-c18",
        "title": "杂记"
      },
      {
        "id": "liji-c19",
        "title": "丧大记"
      },
      {
        "id": "liji-c20",
        "title": "丧服大记"
      },
      {
        "id": "liji-c21",
        "title": "祭法"
      },
      {
        "id": "liji-c22",
        "title": "祭义"
      },
      {
        "id": "liji-c23",
        "title": "祭统"
      },
      {
        "id": "liji-c24",
        "title": "经解"
      },
      {
        "id": "liji-c25",
        "title": "哀公问"
      },
      {
        "id": "liji-c26",
        "title": "仲尼燕居"
      },
      {
        "id": "liji-c27",
        "title": "孔子闲居"
      },
      {
        "id": "liji-c28",
        "title": "坊记"
      },
      {
        "id": "liji-c29",
        "title": "中庸"
      },
      {
        "id": "liji-c30",
        "title": "表记"
      },
      {
        "id": "liji-c31",
        "title": "缁衣"
      },
      {
        "id": "liji-c32",
        "title": "奔丧"
      },
      {
        "id": "liji-c33",
        "title": "问丧"
      },
      {
        "id": "liji-c34",
        "title": "服问"
      },
      {
        "id": "liji-c35",
        "title": "间传"
      },
      {
        "id": "liji-c36",
        "title": "三年问"
      },
      {
        "id": "liji-c37",
        "title": "深衣"
      },
      {
        "id": "liji-c38",
        "title": "投壶"
      },
      {
        "id": "liji-c39",
        "title": "儒行"
      },
      {
        "id": "liji-c40",
        "title": "大学"
      },
      {
        "id": "liji-c41",
        "title": "冠义"
      },
      {
        "id": "liji-c42",
        "title": "昏义"
      },
      {
        "id": "liji-c43",
        "title": "乡饮酒义"
      },
      {
        "id": "liji-c44",
        "title": "射义"
      },
      {
        "id": "liji-c45",
        "title": "燕义"
      },
      {
        "id": "liji-c46",
        "title": "聘义"
      },
      {
        "id": "liji-c47",
        "title": "丧服四制"
      }
    ]
  },
  {
    "id": "guoyu",
    "title": "国语",
    "author": "旧题左丘明 撰",
    "category": "shi",
    "description": "国别体史书之祖，二十一卷记周鲁齐晋郑楚吴越八国卿大夫言论。全本。",
    "dynasty": "先秦",
    "sizeBytes": 267598,
    "toc": [
      {
        "id": "guoyu-c1",
        "title": "卷一·周语上"
      },
      {
        "id": "guoyu-c2",
        "title": "卷二·周语中"
      },
      {
        "id": "guoyu-c3",
        "title": "卷三·周语下"
      },
      {
        "id": "guoyu-c4",
        "title": "卷四·鲁语上"
      },
      {
        "id": "guoyu-c5",
        "title": "卷六·齐语"
      },
      {
        "id": "guoyu-c6",
        "title": "卷七·晋语一"
      },
      {
        "id": "guoyu-c7",
        "title": "卷八·晋语二"
      },
      {
        "id": "guoyu-c8",
        "title": "卷九·晋语三"
      },
      {
        "id": "guoyu-c9",
        "title": "卷十·晋语四"
      },
      {
        "id": "guoyu-c10",
        "title": "卷十一·晋语五"
      },
      {
        "id": "guoyu-c11",
        "title": "卷十二·晋语六"
      },
      {
        "id": "guoyu-c12",
        "title": "卷十三·晋语七"
      },
      {
        "id": "guoyu-c13",
        "title": "卷十四·晋语八"
      },
      {
        "id": "guoyu-c14",
        "title": "卷十五·晋语九"
      },
      {
        "id": "guoyu-c15",
        "title": "卷十六·郑语"
      },
      {
        "id": "guoyu-c16",
        "title": "卷十七·楚语上"
      },
      {
        "id": "guoyu-c17",
        "title": "卷十八·楚语下"
      },
      {
        "id": "guoyu-c18",
        "title": "卷十九·吴语"
      },
      {
        "id": "guoyu-c19",
        "title": "卷二十·越语上"
      },
      {
        "id": "guoyu-c20",
        "title": "卷二十一·越语下"
      }
    ]
  },
  {
    "id": "zhanguoce",
    "title": "战国策",
    "author": "西汉·刘向 编订",
    "category": "shi",
    "description": "战国纵横家说辞汇编三十三卷，记十二国策士权谋与游说。全本。",
    "dynasty": "西汉",
    "sizeBytes": 472276,
    "toc": [
      {
        "id": "zhanguoce-c1",
        "title": "卷一·东周"
      },
      {
        "id": "zhanguoce-c2",
        "title": "卷三·秦一"
      },
      {
        "id": "zhanguoce-c3",
        "title": "卷四·秦二"
      },
      {
        "id": "zhanguoce-c4",
        "title": "卷五·秦三"
      },
      {
        "id": "zhanguoce-c5",
        "title": "卷六·秦四"
      },
      {
        "id": "zhanguoce-c6",
        "title": "卷七·秦五"
      },
      {
        "id": "zhanguoce-c7",
        "title": "卷八·齐一"
      },
      {
        "id": "zhanguoce-c8",
        "title": "卷九·齐二"
      },
      {
        "id": "zhanguoce-c9",
        "title": "卷十一·齐四"
      },
      {
        "id": "zhanguoce-c10",
        "title": "卷十二·齐五"
      },
      {
        "id": "zhanguoce-c11",
        "title": "卷十三·齐六"
      },
      {
        "id": "zhanguoce-c12",
        "title": "卷十四·楚一"
      },
      {
        "id": "zhanguoce-c13",
        "title": "卷十五·楚二"
      },
      {
        "id": "zhanguoce-c14",
        "title": "卷十六·楚三"
      },
      {
        "id": "zhanguoce-c15",
        "title": "卷十九·赵二"
      },
      {
        "id": "zhanguoce-c16",
        "title": "卷二十·赵三"
      },
      {
        "id": "zhanguoce-c17",
        "title": "卷二十一·赵四"
      },
      {
        "id": "zhanguoce-c18",
        "title": "卷二十二·魏一"
      },
      {
        "id": "zhanguoce-c19",
        "title": "卷二十三·魏二"
      },
      {
        "id": "zhanguoce-c20",
        "title": "卷二十四·魏三"
      },
      {
        "id": "zhanguoce-c21",
        "title": "卷二十六·韩一"
      },
      {
        "id": "zhanguoce-c22",
        "title": "卷二十七·韩二"
      },
      {
        "id": "zhanguoce-c23",
        "title": "卷二十八·韩三"
      },
      {
        "id": "zhanguoce-c24",
        "title": "卷二十九·燕一"
      },
      {
        "id": "zhanguoce-c25",
        "title": "卷三十·燕二"
      },
      {
        "id": "zhanguoce-c26",
        "title": "卷三十一·燕三"
      },
      {
        "id": "zhanguoce-c27",
        "title": "卷三十二·宋卫"
      },
      {
        "id": "zhanguoce-c28",
        "title": "卷三十三·中山"
      }
    ]
  },
  {
    "id": "hanshu",
    "title": "汉书",
    "author": "东汉·班固 撰",
    "category": "shi",
    "description": "中国第一部纪传体断代史，一百篇记西汉二百三十年史事。全本。",
    "dynasty": "东汉",
    "sizeBytes": 4221606,
    "toc": [
      {
        "id": "hanshu-c1",
        "title": "志第七上"
      },
      {
        "id": "hanshu-c2",
        "title": "志第八上"
      },
      {
        "id": "hanshu-c3",
        "title": "志第八下"
      },
      {
        "id": "hanshu-c4",
        "title": "志第九"
      },
      {
        "id": "hanshu-c5",
        "title": "志第十"
      },
      {
        "id": "hanshu-c6",
        "title": "传第七十上"
      },
      {
        "id": "hanshu-c7",
        "title": "传第七十下"
      },
      {
        "id": "hanshu-c8",
        "title": "高帝纪第一上"
      },
      {
        "id": "hanshu-c9",
        "title": "高帝纪第一下"
      },
      {
        "id": "hanshu-c10",
        "title": "惠帝纪第二"
      },
      {
        "id": "hanshu-c11",
        "title": "高后纪第三"
      },
      {
        "id": "hanshu-c12",
        "title": "文帝纪第四"
      },
      {
        "id": "hanshu-c13",
        "title": "景帝纪第五"
      },
      {
        "id": "hanshu-c14",
        "title": "武帝纪第六"
      },
      {
        "id": "hanshu-c15",
        "title": "昭帝纪第七"
      },
      {
        "id": "hanshu-c16",
        "title": "宣帝纪第八"
      },
      {
        "id": "hanshu-c17",
        "title": "元帝纪第九"
      },
      {
        "id": "hanshu-c18",
        "title": "成帝纪第十"
      },
      {
        "id": "hanshu-c19",
        "title": "哀帝纪第十一"
      },
      {
        "id": "hanshu-c20",
        "title": "平帝纪第十二"
      },
      {
        "id": "hanshu-c21",
        "title": "异姓诸侯王表第一"
      },
      {
        "id": "hanshu-c22",
        "title": "诸侯王表第二"
      },
      {
        "id": "hanshu-c23",
        "title": "王子侯表第三上"
      },
      {
        "id": "hanshu-c24",
        "title": "王子侯表第三下"
      },
      {
        "id": "hanshu-c25",
        "title": "髙惠髙后文功臣表第四"
      },
      {
        "id": "hanshu-c26",
        "title": "景武昭宣元成功臣表第五"
      },
      {
        "id": "hanshu-c27",
        "title": "外戚恩泽侯表第六"
      },
      {
        "id": "hanshu-c28",
        "title": "百官公卿表第七下"
      },
      {
        "id": "hanshu-c29",
        "title": "律歴志第一上"
      },
      {
        "id": "hanshu-c30",
        "title": "律歴志第一下"
      },
      {
        "id": "hanshu-c31",
        "title": "礼乐志第二"
      },
      {
        "id": "hanshu-c32",
        "title": "刑法志第三"
      },
      {
        "id": "hanshu-c33",
        "title": "食货志第四"
      },
      {
        "id": "hanshu-c34",
        "title": "食货志第四下"
      },
      {
        "id": "hanshu-c35",
        "title": "郊祀志第五上"
      },
      {
        "id": "hanshu-c36",
        "title": "郊祀志第五下"
      },
      {
        "id": "hanshu-c37",
        "title": "天文志第六"
      },
      {
        "id": "hanshu-c38",
        "title": "五行志第七上"
      },
      {
        "id": "hanshu-c39",
        "title": "地理志第八上"
      },
      {
        "id": "hanshu-c40",
        "title": "汉　　　兰　　台　　令　　史班　固撰唐正议大夫行秘书少监琅邪县开国子颜师古注地理志第八下"
      },
      {
        "id": "hanshu-c41",
        "title": "艺文志第十"
      },
      {
        "id": "hanshu-c42",
        "title": "陈胜项籍列传第一"
      },
      {
        "id": "hanshu-c43",
        "title": "张耳陈余传第二"
      },
      {
        "id": "hanshu-c44",
        "title": "魏豹田儋韩王信传第三"
      },
      {
        "id": "hanshu-c45",
        "title": "韩彭英卢吴传第四"
      },
      {
        "id": "hanshu-c46",
        "title": "荆燕吴传第五"
      },
      {
        "id": "hanshu-c47",
        "title": "楚元王传第六"
      },
      {
        "id": "hanshu-c48",
        "title": "季布栾布田叔传第七"
      },
      {
        "id": "hanshu-c49",
        "title": "髙五王传第八"
      },
      {
        "id": "hanshu-c50",
        "title": "萧何曹参传第九"
      },
      {
        "id": "hanshu-c51",
        "title": "张陈王周传第十"
      },
      {
        "id": "hanshu-c52",
        "title": "樊郦滕灌傅靳周传第十一"
      },
      {
        "id": "hanshu-c53",
        "title": "张周赵任申屠传第十二"
      },
      {
        "id": "hanshu-c54",
        "title": "郦陆朱刘叔孙传第十三"
      },
      {
        "id": "hanshu-c55",
        "title": "淮南衡山济北王传第十四"
      },
      {
        "id": "hanshu-c56",
        "title": "蒯伍江息夫传第十五"
      },
      {
        "id": "hanshu-c57",
        "title": "万石衞直周张传第十六"
      },
      {
        "id": "hanshu-c58",
        "title": "文三王传第十七"
      },
      {
        "id": "hanshu-c59",
        "title": "贾谊传第十八"
      },
      {
        "id": "hanshu-c60",
        "title": "爰盎鼌错传第十九"
      },
      {
        "id": "hanshu-c61",
        "title": "张冯汲郑传第二十"
      },
      {
        "id": "hanshu-c62",
        "title": "贾邹枚路传第二十一"
      },
      {
        "id": "hanshu-c63",
        "title": "窦田灌韩传第二十二"
      },
      {
        "id": "hanshu-c64",
        "title": "景十三王传第二十三"
      },
      {
        "id": "hanshu-c65",
        "title": "李广苏建传第二十四"
      },
      {
        "id": "hanshu-c66",
        "title": "卫青霍去病传第二十五"
      },
      {
        "id": "hanshu-c67",
        "title": "董仲舒传第二十六"
      },
      {
        "id": "hanshu-c68",
        "title": "司马相如传第二十七上"
      },
      {
        "id": "hanshu-c69",
        "title": "司马相如传第二十七下"
      },
      {
        "id": "hanshu-c70",
        "title": "公孙卜式儿寛传第二十八"
      },
      {
        "id": "hanshu-c71",
        "title": "张汤传第二十九"
      },
      {
        "id": "hanshu-c72",
        "title": "杜周传第三十"
      },
      {
        "id": "hanshu-c73",
        "title": "张骞李广利传第三十一"
      },
      {
        "id": "hanshu-c74",
        "title": "司马迁传第三十二"
      },
      {
        "id": "hanshu-c75",
        "title": "武五子传第三十三"
      },
      {
        "id": "hanshu-c76",
        "title": "严朱吾丘主父徐严终王贾传第三十四上"
      },
      {
        "id": "hanshu-c77",
        "title": "严朱吾丘主父徐严终王贾传第三十四下"
      },
      {
        "id": "hanshu-c78",
        "title": "东方朔传第三十五"
      },
      {
        "id": "hanshu-c79",
        "title": "公孙刘车王杨蔡陈郑传第三十六"
      },
      {
        "id": "hanshu-c80",
        "title": "杨胡朱梅云传第三十七"
      },
      {
        "id": "hanshu-c81",
        "title": "霍光金日防传第三十八"
      },
      {
        "id": "hanshu-c82",
        "title": "赵充国辛庆忌传第三十九"
      },
      {
        "id": "hanshu-c83",
        "title": "傅常郑甘陈叚传第四十"
      },
      {
        "id": "hanshu-c84",
        "title": "隽疏于薛平彭传第四十一"
      },
      {
        "id": "hanshu-c85",
        "title": "王贡两龚鲍传第四十二"
      },
      {
        "id": "hanshu-c86",
        "title": "韦贤传第四十三"
      },
      {
        "id": "hanshu-c87",
        "title": "魏相丙吉传第四十四"
      },
      {
        "id": "hanshu-c88",
        "title": "眭两夏侯京翼李传第四十五"
      },
      {
        "id": "hanshu-c89",
        "title": "赵尹韩张两王列传第四十六"
      },
      {
        "id": "hanshu-c90",
        "title": "盖诸葛刘郑孙母将何传第四十七"
      },
      {
        "id": "hanshu-c91",
        "title": "萧望之列传第四十八"
      },
      {
        "id": "hanshu-c92",
        "title": "冯奉世传第四十九"
      },
      {
        "id": "hanshu-c93",
        "title": "宣元六王传第五十"
      },
      {
        "id": "hanshu-c94",
        "title": "匡张孔马传第五十一"
      },
      {
        "id": "hanshu-c95",
        "title": "王商史丹傅喜传第五十二"
      },
      {
        "id": "hanshu-c96",
        "title": "何武王嘉师丹传第五十六"
      },
      {
        "id": "hanshu-c97",
        "title": "儒林传第五十八"
      },
      {
        "id": "hanshu-c98",
        "title": "循吏传第五十九"
      },
      {
        "id": "hanshu-c99",
        "title": "酷吏传第六十"
      },
      {
        "id": "hanshu-c100",
        "title": "货殖传第六十一"
      },
      {
        "id": "hanshu-c101",
        "title": "游侠传第六十二"
      },
      {
        "id": "hanshu-c102",
        "title": "佞幸传第六十三"
      },
      {
        "id": "hanshu-c103",
        "title": "匈奴传第六十四上"
      },
      {
        "id": "hanshu-c104",
        "title": "匈奴传第六十四下"
      },
      {
        "id": "hanshu-c105",
        "title": "西南夷两粤朝鲜传第六十五"
      },
      {
        "id": "hanshu-c106",
        "title": "西域传第六十六上"
      },
      {
        "id": "hanshu-c107",
        "title": "西域传第六十六下"
      },
      {
        "id": "hanshu-c108",
        "title": "外戚列传第六十七上"
      },
      {
        "id": "hanshu-c109",
        "title": "王莽传第六十九下"
      },
      {
        "id": "hanshu-c110",
        "title": "叙传第七十上"
      },
      {
        "id": "hanshu-c111",
        "title": "孝昭幼冲冡宰惟忠燕盖诪张实叡实聪【如淳曰诪音辀应劭曰诪张诳也】辠人斯得邦家和同述昭纪第七"
      },
      {
        "id": "hanshu-c112",
        "title": "受命之初赞功剖符奕世业爵土廼昭【师古曰赞功佐命之功也奕大也】述髙恵髙后孝文功臣侯表第四"
      },
      {
        "id": "hanshu-c113",
        "title": "篇章博举通于上下略差名号九品之叙述古今人表第八"
      },
      {
        "id": "hanshu-c114",
        "title": "哀平之防丁傅莽贤武嘉戚之乃防厥身髙乐废黜咸列贞臣述何武王嘉师丹传第五十六"
      }
    ]
  },
  {
    "id": "houhanshu",
    "title": "后汉书",
    "author": "南朝宋·范晔 撰（梁·刘昭 补志）",
    "category": "shi",
    "description": "纪传体东汉史一百二十卷，与《史记》《汉书》《三国志》并称前四史。全本。",
    "dynasty": "南朝宋",
    "sizeBytes": 2720699,
    "toc": [
      {
        "id": "houhanshu-c1",
        "title": "卷一上·光武帝纪第一·上"
      }
    ]
  },
  {
    "id": "sanguozhi",
    "title": "三国志",
    "author": "西晋·陈寿 撰（宋·裴松之 注）",
    "category": "shi",
    "description": "纪传体三国史六十五卷，魏蜀吴三志分国纪传。全本。",
    "dynasty": "西晋",
    "sizeBytes": 2170619,
    "toc": [
      {
        "id": "sanguozhi-c1",
        "title": "魏志·卷一"
      },
      {
        "id": "sanguozhi-c2",
        "title": "魏志·卷二"
      },
      {
        "id": "sanguozhi-c3",
        "title": "魏志·卷三"
      },
      {
        "id": "sanguozhi-c4",
        "title": "魏志·卷四"
      },
      {
        "id": "sanguozhi-c5",
        "title": "魏志·卷五"
      },
      {
        "id": "sanguozhi-c6",
        "title": "魏志·卷六"
      },
      {
        "id": "sanguozhi-c7",
        "title": "魏志·卷七"
      },
      {
        "id": "sanguozhi-c8",
        "title": "魏志·卷八"
      },
      {
        "id": "sanguozhi-c9",
        "title": "魏志·卷九"
      },
      {
        "id": "sanguozhi-c10",
        "title": "魏志·卷十"
      },
      {
        "id": "sanguozhi-c11",
        "title": "魏志·卷十一"
      },
      {
        "id": "sanguozhi-c12",
        "title": "魏志·卷十二"
      },
      {
        "id": "sanguozhi-c13",
        "title": "魏志·卷十三"
      },
      {
        "id": "sanguozhi-c14",
        "title": "魏志·卷十四"
      },
      {
        "id": "sanguozhi-c15",
        "title": "魏志·卷十五"
      },
      {
        "id": "sanguozhi-c16",
        "title": "魏志·卷十六"
      },
      {
        "id": "sanguozhi-c17",
        "title": "魏志·卷十七"
      },
      {
        "id": "sanguozhi-c18",
        "title": "魏志·卷十八"
      },
      {
        "id": "sanguozhi-c19",
        "title": "魏志·卷十九"
      },
      {
        "id": "sanguozhi-c20",
        "title": "魏志·卷二十"
      },
      {
        "id": "sanguozhi-c21",
        "title": "魏志·卷二十一"
      },
      {
        "id": "sanguozhi-c22",
        "title": "魏志·卷二十二"
      },
      {
        "id": "sanguozhi-c23",
        "title": "魏志·卷二十三"
      },
      {
        "id": "sanguozhi-c24",
        "title": "魏志·卷二十四"
      },
      {
        "id": "sanguozhi-c25",
        "title": "魏志·卷二十五"
      },
      {
        "id": "sanguozhi-c26",
        "title": "魏志·卷二十六"
      },
      {
        "id": "sanguozhi-c27",
        "title": "魏志·卷二十七"
      },
      {
        "id": "sanguozhi-c28",
        "title": "魏志·卷二十八"
      },
      {
        "id": "sanguozhi-c29",
        "title": "魏志·卷二十九"
      },
      {
        "id": "sanguozhi-c30",
        "title": "魏志·卷三十"
      },
      {
        "id": "sanguozhi-c31",
        "title": "蜀志·卷一"
      },
      {
        "id": "sanguozhi-c32",
        "title": "蜀志·卷二"
      },
      {
        "id": "sanguozhi-c33",
        "title": "蜀志·卷三"
      },
      {
        "id": "sanguozhi-c34",
        "title": "蜀志·卷四"
      },
      {
        "id": "sanguozhi-c35",
        "title": "蜀志·卷五"
      },
      {
        "id": "sanguozhi-c36",
        "title": "蜀志·卷六"
      },
      {
        "id": "sanguozhi-c37",
        "title": "蜀志·卷七"
      },
      {
        "id": "sanguozhi-c38",
        "title": "蜀志·卷八"
      },
      {
        "id": "sanguozhi-c39",
        "title": "蜀志·卷九"
      },
      {
        "id": "sanguozhi-c40",
        "title": "蜀志·卷十"
      },
      {
        "id": "sanguozhi-c41",
        "title": "蜀志·卷十一"
      },
      {
        "id": "sanguozhi-c42",
        "title": "蜀志·卷十二"
      },
      {
        "id": "sanguozhi-c43",
        "title": "蜀志·卷十三"
      },
      {
        "id": "sanguozhi-c44",
        "title": "蜀志·卷十四"
      },
      {
        "id": "sanguozhi-c45",
        "title": "蜀志·卷十五"
      },
      {
        "id": "sanguozhi-c46",
        "title": "吴志·卷一"
      },
      {
        "id": "sanguozhi-c47",
        "title": "吴志·卷二"
      },
      {
        "id": "sanguozhi-c48",
        "title": "吴志·卷六"
      },
      {
        "id": "sanguozhi-c49",
        "title": "吴志·卷七"
      },
      {
        "id": "sanguozhi-c50",
        "title": "吴志·卷十"
      },
      {
        "id": "sanguozhi-c51",
        "title": "吴志·卷十一"
      },
      {
        "id": "sanguozhi-c52",
        "title": "吴志·卷十二"
      },
      {
        "id": "sanguozhi-c53",
        "title": "吴志·卷十三"
      },
      {
        "id": "sanguozhi-c54",
        "title": "吴志·卷十四"
      },
      {
        "id": "sanguozhi-c55",
        "title": "吴志·卷十五"
      },
      {
        "id": "sanguozhi-c56",
        "title": "吴志·卷十六"
      },
      {
        "id": "sanguozhi-c57",
        "title": "吴志·卷十七"
      },
      {
        "id": "sanguozhi-c58",
        "title": "吴志·卷十八"
      },
      {
        "id": "sanguozhi-c59",
        "title": "吴志·卷十九"
      },
      {
        "id": "sanguozhi-c60",
        "title": "吴志·卷二十"
      }
    ]
  },
  {
    "id": "sunzibingfa",
    "title": "孙子兵法",
    "author": "春秋·孙武 撰",
    "category": "zi",
    "description": "中国现存最早兵书十三篇，计战谋攻军形兵势虚实军争九变皆备。全本。",
    "dynasty": "春秋",
    "sizeBytes": 19427,
    "toc": [
      {
        "id": "sunzibingfa-c1",
        "title": "始计第一"
      },
      {
        "id": "sunzibingfa-c2",
        "title": "作战第二"
      },
      {
        "id": "sunzibingfa-c3",
        "title": "谋攻第三"
      },
      {
        "id": "sunzibingfa-c4",
        "title": "军形第四"
      },
      {
        "id": "sunzibingfa-c5",
        "title": "兵势第五"
      },
      {
        "id": "sunzibingfa-c6",
        "title": "虚实第六"
      },
      {
        "id": "sunzibingfa-c7",
        "title": "军争第七"
      },
      {
        "id": "sunzibingfa-c8",
        "title": "九变第八"
      },
      {
        "id": "sunzibingfa-c9",
        "title": "行军第九"
      },
      {
        "id": "sunzibingfa-c10",
        "title": "地形第十"
      },
      {
        "id": "sunzibingfa-c11",
        "title": "九地第十一"
      },
      {
        "id": "sunzibingfa-c12",
        "title": "火攻第十二"
      },
      {
        "id": "sunzibingfa-c13",
        "title": "用间第十三"
      }
    ]
  },
  {
    "id": "guanzi",
    "title": "管子",
    "author": "旧题管仲 撰（战国齐稷下学者辑）",
    "category": "zi",
    "description": "齐国管仲学派著作总集八十六篇，兼含法家经言与轻重富国之术。全本。",
    "dynasty": "战国",
    "sizeBytes": 622301,
    "toc": [
      {
        "id": "guanzi-c1",
        "title": "乘马第五"
      },
      {
        "id": "guanzi-c2",
        "title": "版法第七"
      },
      {
        "id": "guanzi-c3",
        "title": "五辅第十"
      },
      {
        "id": "guanzi-c4",
        "title": "枢言第十二"
      },
      {
        "id": "guanzi-c5",
        "title": "重令第十五"
      },
      {
        "id": "guanzi-c6",
        "title": "兵法第十七"
      },
      {
        "id": "guanzi-c7",
        "title": "大匡第十八"
      },
      {
        "id": "guanzi-c8",
        "title": "王言第二十一"
      },
      {
        "id": "guanzi-c9",
        "title": "谋失第二十五"
      },
      {
        "id": "guanzi-c10",
        "title": "君臣上第三十"
      },
      {
        "id": "guanzi-c11",
        "title": "正言第三十四"
      },
      {
        "id": "guanzi-c12",
        "title": "侈靡第三十五"
      },
      {
        "id": "guanzi-c13",
        "title": "白心第三十八"
      },
      {
        "id": "guanzi-c14",
        "title": "五行第四十一"
      },
      {
        "id": "guanzi-c15",
        "title": "治国第四十八"
      },
      {
        "id": "guanzi-c16",
        "title": "小问第五十一"
      },
      {
        "id": "guanzi-c17",
        "title": "禁藏第五十三"
      },
      {
        "id": "guanzi-c18",
        "title": "度地第五十七"
      },
      {
        "id": "guanzi-c19",
        "title": "牧民解第六十三"
      },
      {
        "id": "guanzi-c20",
        "title": "形势解第六十四"
      },
      {
        "id": "guanzi-c21",
        "title": "问乘马第七十"
      },
      {
        "id": "guanzi-c22",
        "title": "山至数第七十六"
      },
      {
        "id": "guanzi-c23",
        "title": "轻重甲第八十"
      },
      {
        "id": "guanzi-c24",
        "title": "轻重庚第八十六"
      }
    ]
  },
  {
    "id": "hanfeizi",
    "title": "韩非子",
    "author": "战国·韩非 撰",
    "category": "zi",
    "description": "法家集大成之作五十五篇，法术势兼备，刑名参验之学。全本。",
    "dynasty": "战国",
    "sizeBytes": 363987,
    "toc": [
      {
        "id": "hanfeizi-c1",
        "title": "初见秦第一"
      },
      {
        "id": "hanfeizi-c2",
        "title": "存韩第二"
      },
      {
        "id": "hanfeizi-c3",
        "title": "难言第三"
      },
      {
        "id": "hanfeizi-c4",
        "title": "主道第五"
      },
      {
        "id": "hanfeizi-c5",
        "title": "有度第六"
      },
      {
        "id": "hanfeizi-c6",
        "title": "二柄第七"
      },
      {
        "id": "hanfeizi-c7",
        "title": "八奸第九"
      },
      {
        "id": "hanfeizi-c8",
        "title": "和氏第十三"
      },
      {
        "id": "hanfeizi-c9",
        "title": "奸劫弑臣第十四"
      },
      {
        "id": "hanfeizi-c10",
        "title": "亡征第十五"
      },
      {
        "id": "hanfeizi-c11",
        "title": "三守第十六"
      },
      {
        "id": "hanfeizi-c12",
        "title": "备内第十七"
      },
      {
        "id": "hanfeizi-c13",
        "title": "南面第十八"
      },
      {
        "id": "hanfeizi-c14",
        "title": "饰邪第十九"
      },
      {
        "id": "hanfeizi-c15",
        "title": "喻老第二十一"
      },
      {
        "id": "hanfeizi-c16",
        "title": "说林下第二十三"
      },
      {
        "id": "hanfeizi-c17",
        "title": "观行第二十四"
      },
      {
        "id": "hanfeizi-c18",
        "title": "安危第二十五"
      },
      {
        "id": "hanfeizi-c19",
        "title": "守道第二十六"
      },
      {
        "id": "hanfeizi-c20",
        "title": "功名第二十八"
      },
      {
        "id": "hanfeizi-c21",
        "title": "大体第二十九"
      },
      {
        "id": "hanfeizi-c22",
        "title": "外储说左下第三十三"
      },
      {
        "id": "hanfeizi-c23",
        "title": "难二第三十七"
      },
      {
        "id": "hanfeizi-c24",
        "title": "难三第三十八"
      },
      {
        "id": "hanfeizi-c25",
        "title": "难势第四十"
      },
      {
        "id": "hanfeizi-c26",
        "title": "问辩第四十一"
      },
      {
        "id": "hanfeizi-c27",
        "title": "问田第四十二"
      },
      {
        "id": "hanfeizi-c28",
        "title": "说疑第四十四"
      },
      {
        "id": "hanfeizi-c29",
        "title": "诡使第四十五"
      },
      {
        "id": "hanfeizi-c30",
        "title": "六反第四十六"
      },
      {
        "id": "hanfeizi-c31",
        "title": "八说第四十七"
      },
      {
        "id": "hanfeizi-c32",
        "title": "八经第四十八"
      },
      {
        "id": "hanfeizi-c33",
        "title": "五蠧第四十九"
      },
      {
        "id": "hanfeizi-c34",
        "title": "显学第五十"
      },
      {
        "id": "hanfeizi-c35",
        "title": "忠孝第五十一"
      },
      {
        "id": "hanfeizi-c36",
        "title": "人主第五十二"
      },
      {
        "id": "hanfeizi-c37",
        "title": "饬令第五十三"
      },
      {
        "id": "hanfeizi-c38",
        "title": "心度第五十四"
      },
      {
        "id": "hanfeizi-c39",
        "title": "制分第五十五"
      }
    ]
  },
  {
    "id": "lvshichunqiu",
    "title": "吕氏春秋",
    "author": "战国末·吕不韦 门客辑",
    "category": "zi",
    "description": "杂家代表作二十六卷十二纪八览六论，汇九流之说备天地万物古今之事。全本。",
    "dynasty": "战国",
    "sizeBytes": 548609,
    "toc": [
      {
        "id": "lvshichunqiu-c1",
        "title": "卷一·孟春纪第一"
      },
      {
        "id": "lvshichunqiu-c2",
        "title": "卷二·仲春纪第二"
      },
      {
        "id": "lvshichunqiu-c3",
        "title": "卷三·季春纪第三"
      },
      {
        "id": "lvshichunqiu-c4",
        "title": "卷四·孟夏纪第四"
      },
      {
        "id": "lvshichunqiu-c5",
        "title": "卷五·仲夏纪第五"
      },
      {
        "id": "lvshichunqiu-c6",
        "title": "卷六·季夏纪第六"
      },
      {
        "id": "lvshichunqiu-c7",
        "title": "卷七·孟秋纪第七"
      },
      {
        "id": "lvshichunqiu-c8",
        "title": "卷八·仲秋纪第八"
      },
      {
        "id": "lvshichunqiu-c9",
        "title": "卷九·季秋纪第九"
      },
      {
        "id": "lvshichunqiu-c10",
        "title": "卷十·孟冬纪第十"
      },
      {
        "id": "lvshichunqiu-c11",
        "title": "卷十一·仲冬纪第十一"
      },
      {
        "id": "lvshichunqiu-c12",
        "title": "卷十二·季冬纪第十二"
      },
      {
        "id": "lvshichunqiu-c13",
        "title": "卷十三·有始览第一"
      },
      {
        "id": "lvshichunqiu-c14",
        "title": "卷十四·孝行览第二"
      },
      {
        "id": "lvshichunqiu-c15",
        "title": "卷十五·慎大览第三"
      },
      {
        "id": "lvshichunqiu-c16",
        "title": "卷十六·先识览第四"
      },
      {
        "id": "lvshichunqiu-c17",
        "title": "卷十七·审分览第五"
      },
      {
        "id": "lvshichunqiu-c18",
        "title": "卷十八·审应览第六"
      },
      {
        "id": "lvshichunqiu-c19",
        "title": "卷十九·离俗览第七"
      },
      {
        "id": "lvshichunqiu-c20",
        "title": "卷二十·恃君览第八"
      },
      {
        "id": "lvshichunqiu-c21",
        "title": "卷二十一·开春论第一"
      },
      {
        "id": "lvshichunqiu-c22",
        "title": "卷二十二·慎行论第二"
      },
      {
        "id": "lvshichunqiu-c23",
        "title": "卷二十三·贵直论第三"
      },
      {
        "id": "lvshichunqiu-c24",
        "title": "卷二十四·不苟论第四"
      },
      {
        "id": "lvshichunqiu-c25",
        "title": "卷二十五·似顺论第五"
      },
      {
        "id": "lvshichunqiu-c26",
        "title": "卷二十六·士容论第六"
      }
    ]
  },
  {
    "id": "yanzichunqiu",
    "title": "晏子春秋",
    "author": "战国·齐人辑晏婴言行",
    "category": "zi",
    "description": "记齐国名相晏婴谏诤行事八篇二百一十五章，先秦叙事散文代表。全本。",
    "dynasty": "战国",
    "sizeBytes": 171116,
    "toc": [
      {
        "id": "yanzichunqiu-c1",
        "title": "内篇谏上第一凡二十五章"
      },
      {
        "id": "yanzichunqiu-c2",
        "title": "内篇谏下第二凡二十五章"
      },
      {
        "id": "yanzichunqiu-c3",
        "title": "内篇问上第三凡三十章"
      },
      {
        "id": "yanzichunqiu-c4",
        "title": "内篇问下第四凡三十章"
      },
      {
        "id": "yanzichunqiu-c5",
        "title": "内篇杂上第五凡三十章"
      },
      {
        "id": "yanzichunqiu-c6",
        "title": "内篇杂下第六凡三十章"
      },
      {
        "id": "yanzichunqiu-c7",
        "title": "外篇第七凡二十七章"
      },
      {
        "id": "yanzichunqiu-c8",
        "title": "不合经术者第八凡十八章"
      }
    ]
  },
  {
    "id": "shishuoxinyu",
    "title": "世说新语",
    "author": "南朝宋·刘义庆 撰（梁·刘孝标 注）",
    "category": "zi",
    "description": "魏晋名士言行轶事笔记小说之祖，分德行言语等三十六门。全本。",
    "dynasty": "南朝宋",
    "sizeBytes": 467287,
    "toc": [
      {
        "id": "shishuoxinyu-c1",
        "title": "德行"
      },
      {
        "id": "shishuoxinyu-c2",
        "title": "言语"
      },
      {
        "id": "shishuoxinyu-c3",
        "title": "政事"
      },
      {
        "id": "shishuoxinyu-c4",
        "title": "文学"
      },
      {
        "id": "shishuoxinyu-c5",
        "title": "方正"
      },
      {
        "id": "shishuoxinyu-c6",
        "title": "雅量"
      },
      {
        "id": "shishuoxinyu-c7",
        "title": "识鉴"
      },
      {
        "id": "shishuoxinyu-c8",
        "title": "品藻"
      },
      {
        "id": "shishuoxinyu-c9",
        "title": "规箴"
      },
      {
        "id": "shishuoxinyu-c10",
        "title": "捷悟"
      },
      {
        "id": "shishuoxinyu-c11",
        "title": "夙惠"
      },
      {
        "id": "shishuoxinyu-c12",
        "title": "豪爽"
      },
      {
        "id": "shishuoxinyu-c13",
        "title": "容止"
      },
      {
        "id": "shishuoxinyu-c14",
        "title": "自新"
      },
      {
        "id": "shishuoxinyu-c15",
        "title": "企羡"
      },
      {
        "id": "shishuoxinyu-c16",
        "title": "伤逝"
      },
      {
        "id": "shishuoxinyu-c17",
        "title": "栖逸"
      },
      {
        "id": "shishuoxinyu-c18",
        "title": "贤媛"
      },
      {
        "id": "shishuoxinyu-c19",
        "title": "术解"
      },
      {
        "id": "shishuoxinyu-c20",
        "title": "巧艺"
      },
      {
        "id": "shishuoxinyu-c21",
        "title": "宠礼"
      },
      {
        "id": "shishuoxinyu-c22",
        "title": "任诞"
      },
      {
        "id": "shishuoxinyu-c23",
        "title": "简傲"
      },
      {
        "id": "shishuoxinyu-c24",
        "title": "排调"
      },
      {
        "id": "shishuoxinyu-c25",
        "title": "轻诋"
      },
      {
        "id": "shishuoxinyu-c26",
        "title": "假谲"
      },
      {
        "id": "shishuoxinyu-c27",
        "title": "黜免"
      },
      {
        "id": "shishuoxinyu-c28",
        "title": "俭啬"
      },
      {
        "id": "shishuoxinyu-c29",
        "title": "汰侈"
      },
      {
        "id": "shishuoxinyu-c30",
        "title": "忿狷"
      },
      {
        "id": "shishuoxinyu-c31",
        "title": "谗险"
      },
      {
        "id": "shishuoxinyu-c32",
        "title": "尤悔"
      },
      {
        "id": "shishuoxinyu-c33",
        "title": "纰漏"
      },
      {
        "id": "shishuoxinyu-c34",
        "title": "惑溺"
      },
      {
        "id": "shishuoxinyu-c35",
        "title": "仇隟"
      }
    ]
  },
  {
    "id": "yanshijiaxun",
    "title": "颜氏家训",
    "author": "南北朝·颜之推 撰",
    "category": "zi",
    "description": "中国第一部系统家训二十篇，兼论字书音训与南北风俗。全本。",
    "dynasty": "南北朝",
    "sizeBytes": 100743,
    "toc": [
      {
        "id": "yanshijiaxun-c1",
        "title": "序致篇第一"
      },
      {
        "id": "yanshijiaxun-c2",
        "title": "教子篇第二"
      },
      {
        "id": "yanshijiaxun-c3",
        "title": "兄弟篇第三"
      },
      {
        "id": "yanshijiaxun-c4",
        "title": "后娶篇第四"
      },
      {
        "id": "yanshijiaxun-c5",
        "title": "治家篇第五"
      },
      {
        "id": "yanshijiaxun-c6",
        "title": "风操篇第六"
      },
      {
        "id": "yanshijiaxun-c7",
        "title": "慕贤篇第七"
      },
      {
        "id": "yanshijiaxun-c8",
        "title": "勉学篇第八"
      },
      {
        "id": "yanshijiaxun-c9",
        "title": "文章篇第九"
      },
      {
        "id": "yanshijiaxun-c10",
        "title": "名实篇第十"
      },
      {
        "id": "yanshijiaxun-c11",
        "title": "涉务篇第十一"
      },
      {
        "id": "yanshijiaxun-c12",
        "title": "省事篇第十二"
      },
      {
        "id": "yanshijiaxun-c13",
        "title": "止足篇第十三"
      },
      {
        "id": "yanshijiaxun-c14",
        "title": "诫兵篇第十四"
      },
      {
        "id": "yanshijiaxun-c15",
        "title": "养生篇第十五"
      },
      {
        "id": "yanshijiaxun-c16",
        "title": "归心篇第十六"
      },
      {
        "id": "yanshijiaxun-c17",
        "title": "书证篇第十七"
      },
      {
        "id": "yanshijiaxun-c18",
        "title": "音辞篇第十八"
      },
      {
        "id": "yanshijiaxun-c19",
        "title": "杂艺篇第十九"
      },
      {
        "id": "yanshijiaxun-c20",
        "title": "终制篇第二十"
      }
    ]
  },
  {
    "id": "wenxuan",
    "title": "文选",
    "author": "南朝梁·昭明太子萧统 编（唐·李善 注本白文）",
    "category": "ji",
    "description": "中国现存最早诗文总集六十卷，选周代至梁代诗文七百余篇。全本。",
    "dynasty": "南朝梁",
    "sizeBytes": 3787004,
    "toc": [
      {
        "id": "wenxuan-c1",
        "title": "文选序"
      },
      {
        "id": "wenxuan-c2",
        "title": "卷一·京都上"
      },
      {
        "id": "wenxuan-c3",
        "title": "卷二·京都上"
      },
      {
        "id": "wenxuan-c4",
        "title": "卷三·京都中"
      },
      {
        "id": "wenxuan-c5",
        "title": "卷四·京都中"
      },
      {
        "id": "wenxuan-c6",
        "title": "卷五·京都下"
      },
      {
        "id": "wenxuan-c7",
        "title": "卷六·京都下"
      },
      {
        "id": "wenxuan-c8",
        "title": "卷七·郊祀·耕藉·畋猎上"
      },
      {
        "id": "wenxuan-c9",
        "title": "卷八·畋猎中"
      },
      {
        "id": "wenxuan-c10",
        "title": "卷九·畋猎下·纪行上"
      },
      {
        "id": "wenxuan-c11",
        "title": "卷十·纪行下"
      },
      {
        "id": "wenxuan-c12",
        "title": "卷十一·游览·宫殿"
      },
      {
        "id": "wenxuan-c13",
        "title": "卷十二·江海"
      },
      {
        "id": "wenxuan-c14",
        "title": "卷十三·物色·鸟兽上"
      },
      {
        "id": "wenxuan-c15",
        "title": "卷十四·鸟兽下·志上"
      },
      {
        "id": "wenxuan-c16",
        "title": "卷十五·志中"
      },
      {
        "id": "wenxuan-c17",
        "title": "卷十六·志下·哀伤"
      },
      {
        "id": "wenxuan-c18",
        "title": "卷十七·论文·音乐上"
      },
      {
        "id": "wenxuan-c19",
        "title": "卷十八·音乐下"
      },
      {
        "id": "wenxuan-c20",
        "title": "卷十九·情·补亡·述德·劝励"
      },
      {
        "id": "wenxuan-c21",
        "title": "卷二十·献诗·公宴·祖饯"
      },
      {
        "id": "wenxuan-c22",
        "title": "卷二一·咏史·百一·游仙"
      },
      {
        "id": "wenxuan-c23",
        "title": "卷二二·招隐·游览"
      },
      {
        "id": "wenxuan-c24",
        "title": "卷二三·咏怀·哀伤·赠答"
      },
      {
        "id": "wenxuan-c25",
        "title": "卷二四·赠答二"
      },
      {
        "id": "wenxuan-c26",
        "title": "卷二五·赠答三"
      },
      {
        "id": "wenxuan-c27",
        "title": "卷二六·赠答四·行旅上"
      },
      {
        "id": "wenxuan-c28",
        "title": "卷二七·行旅下·军戎·郊庙·乐府上"
      },
      {
        "id": "wenxuan-c29",
        "title": "卷二八·乐府下·挽歌·杂歌"
      },
      {
        "id": "wenxuan-c30",
        "title": "卷二九·杂诗上"
      },
      {
        "id": "wenxuan-c31",
        "title": "卷三十·杂诗下·杂拟上"
      },
      {
        "id": "wenxuan-c32",
        "title": "卷三一·杂拟下"
      },
      {
        "id": "wenxuan-c33",
        "title": "卷三二·骚上"
      },
      {
        "id": "wenxuan-c34",
        "title": "卷三三·骚下"
      },
      {
        "id": "wenxuan-c35",
        "title": "卷三四·七上"
      },
      {
        "id": "wenxuan-c36",
        "title": "卷三五·七下·诏·册"
      },
      {
        "id": "wenxuan-c37",
        "title": "卷三六·令·教·文"
      },
      {
        "id": "wenxuan-c38",
        "title": "卷三七·表上"
      },
      {
        "id": "wenxuan-c39",
        "title": "卷三八·表下"
      },
      {
        "id": "wenxuan-c40",
        "title": "卷三九·上书·启"
      },
      {
        "id": "wenxuan-c41",
        "title": "卷四十·弹事·笺·奏记"
      },
      {
        "id": "wenxuan-c42",
        "title": "卷四一·书上"
      },
      {
        "id": "wenxuan-c43",
        "title": "卷四二·书中"
      },
      {
        "id": "wenxuan-c44",
        "title": "卷四三·书下"
      },
      {
        "id": "wenxuan-c45",
        "title": "卷四四·檄"
      },
      {
        "id": "wenxuan-c46",
        "title": "卷四五·对问·设论·辞·序上"
      },
      {
        "id": "wenxuan-c47",
        "title": "卷四六·序下"
      },
      {
        "id": "wenxuan-c48",
        "title": "卷四七·颂·赞"
      },
      {
        "id": "wenxuan-c49",
        "title": "卷四八·符命"
      },
      {
        "id": "wenxuan-c50",
        "title": "卷四九·史论上"
      },
      {
        "id": "wenxuan-c51",
        "title": "卷五十·史论下·史述赞"
      },
      {
        "id": "wenxuan-c52",
        "title": "卷五一·论一"
      },
      {
        "id": "wenxuan-c53",
        "title": "卷五二·论二"
      },
      {
        "id": "wenxuan-c54",
        "title": "卷五三·论三"
      },
      {
        "id": "wenxuan-c55",
        "title": "卷五四·论四"
      },
      {
        "id": "wenxuan-c56",
        "title": "卷五五·论五·连珠"
      },
      {
        "id": "wenxuan-c57",
        "title": "卷五六·箴·铭·诔上"
      },
      {
        "id": "wenxuan-c58",
        "title": "卷五七·诔下·哀上"
      },
      {
        "id": "wenxuan-c59",
        "title": "卷五八·哀下·碑文上"
      },
      {
        "id": "wenxuan-c60",
        "title": "卷五九·碑文下·墓志"
      },
      {
        "id": "wenxuan-c61",
        "title": "卷六十·行状·吊文·祭文"
      }
    ]
  },
  {
    "id": "yutaixinyong",
    "title": "玉台新咏",
    "author": "南朝梁·徐陵 编",
    "category": "ji",
    "description": "继《诗经》《楚辞》后汉魏六朝诗歌总集十卷，《孔雀东南飞》始见于此。全本。",
    "dynasty": "南朝梁",
    "sizeBytes": 165352,
    "toc": [
      {
        "id": "yutaixinyong-c1",
        "title": "卷首·集序"
      },
      {
        "id": "yutaixinyong-c2",
        "title": "古诗八首"
      },
      {
        "id": "yutaixinyong-c3",
        "title": "古乐府诗六首"
      },
      {
        "id": "yutaixinyong-c4",
        "title": "枚乘杂诗九首"
      },
      {
        "id": "yutaixinyong-c5",
        "title": "李延年歌诗一首（并序）"
      },
      {
        "id": "yutaixinyong-c6",
        "title": "苏武诗一首"
      },
      {
        "id": "yutaixinyong-c7",
        "title": "辛延年羽林郎诗一首"
      },
      {
        "id": "yutaixinyong-c8",
        "title": "班婕妤怨诗一首（并序）"
      },
      {
        "id": "yutaixinyong-c9",
        "title": "宋子侯董娇饶诗一首"
      },
      {
        "id": "yutaixinyong-c10",
        "title": "汉时童谣歌一首"
      },
      {
        "id": "yutaixinyong-c11",
        "title": "张衡同声歌一首"
      },
      {
        "id": "yutaixinyong-c12",
        "title": "秦嘉赠妇诗三首（并序）"
      },
      {
        "id": "yutaixinyong-c13",
        "title": "秦嘉妻徐淑答诗一首"
      },
      {
        "id": "yutaixinyong-c14",
        "title": "蔡邕饮马长城窟行一首"
      },
      {
        "id": "yutaixinyong-c15",
        "title": "陈琳饮马长城窟行一首"
      },
      {
        "id": "yutaixinyong-c16",
        "title": "徐室思一首"
      },
      {
        "id": "yutaixinyong-c17",
        "title": "情诗一首"
      },
      {
        "id": "yutaixinyong-c18",
        "title": "繁钦定情诗一首"
      },
      {
        "id": "yutaixinyong-c19",
        "title": "古诗无名人为焦仲卿妻作（并序）"
      },
      {
        "id": "yutaixinyong-c20",
        "title": "魏文帝于清河见挽船士新婚与妻别一首"
      },
      {
        "id": "yutaixinyong-c21",
        "title": "又清河作一首"
      },
      {
        "id": "yutaixinyong-c22",
        "title": "又甄皇后乐府塘上行一首"
      },
      {
        "id": "yutaixinyong-c23",
        "title": "刘勋妻王氏杂诗二首（并序）"
      },
      {
        "id": "yutaixinyong-c24",
        "title": "曹植杂诗五首"
      },
      {
        "id": "yutaixinyong-c25",
        "title": "美女篇"
      },
      {
        "id": "yutaixinyong-c26",
        "title": "种葛篇"
      },
      {
        "id": "yutaixinyong-c27",
        "title": "浮萍篇"
      },
      {
        "id": "yutaixinyong-c28",
        "title": "弃妇诗一首"
      },
      {
        "id": "yutaixinyong-c29",
        "title": "魏明帝乐府诗二首"
      },
      {
        "id": "yutaixinyong-c30",
        "title": "阮籍咏怀诗二首"
      },
      {
        "id": "yutaixinyong-c31",
        "title": "傅玄青青河边草篇"
      },
      {
        "id": "yutaixinyong-c32",
        "title": "苦相篇豫章行"
      },
      {
        "id": "yutaixinyong-c33",
        "title": "有女篇□艳歌行"
      },
      {
        "id": "yutaixinyong-c34",
        "title": "朝时篇□怨歌行"
      },
      {
        "id": "yutaixinyong-c35",
        "title": "明月篇"
      },
      {
        "id": "yutaixinyong-c36",
        "title": "秋兰篇"
      },
      {
        "id": "yutaixinyong-c37",
        "title": "西长安行"
      },
      {
        "id": "yutaixinyong-c38",
        "title": "和班氏诗一首"
      },
      {
        "id": "yutaixinyong-c39",
        "title": "张华情诗五首"
      },
      {
        "id": "yutaixinyong-c40",
        "title": "杂诗二首"
      },
      {
        "id": "yutaixinyong-c41",
        "title": "潘岳内顾诗二首"
      },
      {
        "id": "yutaixinyong-c42",
        "title": "悼亡诗二首"
      },
      {
        "id": "yutaixinyong-c43",
        "title": "石崇王昭君辞一首（并序）"
      },
      {
        "id": "yutaixinyong-c44",
        "title": "左思娇女诗一首"
      },
      {
        "id": "yutaixinyong-c45",
        "title": "陆机拟古七首"
      },
      {
        "id": "yutaixinyong-c46",
        "title": "为顾彦先赠妇二首"
      },
      {
        "id": "yutaixinyong-c47",
        "title": "周夫人赠车骑一首"
      },
      {
        "id": "yutaixinyong-c48",
        "title": "乐府三首"
      },
      {
        "id": "yutaixinyong-c49",
        "title": "陆□为顾彦先赠妇往反四首"
      },
      {
        "id": "yutaixinyong-c50",
        "title": "张协杂诗一首"
      },
      {
        "id": "yutaixinyong-c51",
        "title": "杨方合欢诗五首"
      },
      {
        "id": "yutaixinyong-c52",
        "title": "王鉴七夕观织女一首"
      },
      {
        "id": "yutaixinyong-c53",
        "title": "李充嘲友人一首"
      },
      {
        "id": "yutaixinyong-c54",
        "title": "曹毗夜听捣衣一首"
      },
      {
        "id": "yutaixinyong-c55",
        "title": "陶潜拟古一首"
      },
      {
        "id": "yutaixinyong-c56",
        "title": "荀昶乐府二首"
      },
      {
        "id": "yutaixinyong-c57",
        "title": "王微杂诗二首"
      },
      {
        "id": "yutaixinyong-c58",
        "title": "谢惠连七月七日咏牛女"
      },
      {
        "id": "yutaixinyong-c59",
        "title": "捣衣"
      },
      {
        "id": "yutaixinyong-c60",
        "title": "代古"
      },
      {
        "id": "yutaixinyong-c61",
        "title": "刘铄杂诗五首"
      },
      {
        "id": "yutaixinyong-c62",
        "title": "王僧达七夕月下一首"
      },
      {
        "id": "yutaixinyong-c63",
        "title": "颜延之为织女赠牵牛"
      },
      {
        "id": "yutaixinyong-c64",
        "title": "秋胡诗一首"
      },
      {
        "id": "yutaixinyong-c65",
        "title": "鲍照玩月城西门"
      },
      {
        "id": "yutaixinyong-c66",
        "title": "代京洛篇"
      },
      {
        "id": "yutaixinyong-c67",
        "title": "拟乐府白头吟"
      },
      {
        "id": "yutaixinyong-c68",
        "title": "采桑诗"
      },
      {
        "id": "yutaixinyong-c69",
        "title": "梦还诗"
      },
      {
        "id": "yutaixinyong-c70",
        "title": "拟古"
      },
      {
        "id": "yutaixinyong-c71",
        "title": "咏燕"
      },
      {
        "id": "yutaixinyong-c72",
        "title": "赠故人"
      },
      {
        "id": "yutaixinyong-c73",
        "title": "王素学阮步兵体"
      },
      {
        "id": "yutaixinyong-c74",
        "title": "吴迈远拟乐府四首"
      },
      {
        "id": "yutaixinyong-c75",
        "title": "鲍令晖拟青青河畔草"
      },
      {
        "id": "yutaixinyong-c76",
        "title": "拟客从远方来"
      },
      {
        "id": "yutaixinyong-c77",
        "title": "题书后寄行人"
      },
      {
        "id": "yutaixinyong-c78",
        "title": "古意赠今人"
      },
      {
        "id": "yutaixinyong-c79",
        "title": "代葛沙门妻郭小玉诗"
      },
      {
        "id": "yutaixinyong-c80",
        "title": "丘巨源咏七宝扇"
      },
      {
        "id": "yutaixinyong-c81",
        "title": "听邻妓"
      },
      {
        "id": "yutaixinyong-c82",
        "title": "王元长古意"
      },
      {
        "id": "yutaixinyong-c83",
        "title": "咏琵琶"
      },
      {
        "id": "yutaixinyong-c84",
        "title": "咏幔"
      },
      {
        "id": "yutaixinyong-c85",
        "title": "巫山高"
      },
      {
        "id": "yutaixinyong-c86",
        "title": "谢赠王主簿"
      },
      {
        "id": "yutaixinyong-c87",
        "title": "同王主簿怨情"
      },
      {
        "id": "yutaixinyong-c88",
        "title": "夜听妓"
      },
      {
        "id": "yutaixinyong-c89",
        "title": "咏邯郸故才人嫁为厮养卒妇"
      },
      {
        "id": "yutaixinyong-c90",
        "title": "秋夜"
      },
      {
        "id": "yutaixinyong-c91",
        "title": "杂咏五首"
      },
      {
        "id": "yutaixinyong-c92",
        "title": "陆厥中山王孺子妾歌"
      },
      {
        "id": "yutaixinyong-c93",
        "title": "施荣泰杂诗"
      },
      {
        "id": "yutaixinyong-c94",
        "title": "江淹古体"
      },
      {
        "id": "yutaixinyong-c95",
        "title": "班婕妤"
      },
      {
        "id": "yutaixinyong-c96",
        "title": "张司空离情"
      },
      {
        "id": "yutaixinyong-c97",
        "title": "休上人怨别"
      },
      {
        "id": "yutaixinyong-c98",
        "title": "丘迟敬酬柳仆射征怨"
      },
      {
        "id": "yutaixinyong-c99",
        "title": "答徐侍中为人赠妇"
      },
      {
        "id": "yutaixinyong-c100",
        "title": "沈约登高望春"
      },
      {
        "id": "yutaixinyong-c101",
        "title": "昭君辞"
      },
      {
        "id": "yutaixinyong-c102",
        "title": "少年新婚为之咏"
      },
      {
        "id": "yutaixinyong-c103",
        "title": "杂曲三首"
      },
      {
        "id": "yutaixinyong-c104",
        "title": "杂咏五首"
      },
      {
        "id": "yutaixinyong-c105",
        "title": "六忆诗四首（三言五言）"
      },
      {
        "id": "yutaixinyong-c106",
        "title": "十咏二首"
      },
      {
        "id": "yutaixinyong-c107",
        "title": "拟青青河边草"
      },
      {
        "id": "yutaixinyong-c108",
        "title": "拟三妇"
      },
      {
        "id": "yutaixinyong-c109",
        "title": "古意"
      },
      {
        "id": "yutaixinyong-c110",
        "title": "梦见美人"
      },
      {
        "id": "yutaixinyong-c111",
        "title": "效古"
      },
      {
        "id": "yutaixinyong-c112",
        "title": "初春"
      },
      {
        "id": "yutaixinyong-c113",
        "title": "悼亡"
      },
      {
        "id": "yutaixinyong-c114",
        "title": "柳恽捣衣诗一首"
      },
      {
        "id": "yutaixinyong-c115",
        "title": "鼓吹曲二首"
      },
      {
        "id": "yutaixinyong-c116",
        "title": "杂诗"
      },
      {
        "id": "yutaixinyong-c117",
        "title": "长门怨"
      },
      {
        "id": "yutaixinyong-c118",
        "title": "江南曲"
      },
      {
        "id": "yutaixinyong-c119",
        "title": "起夜来"
      },
      {
        "id": "yutaixinyong-c120",
        "title": "七夕穿针"
      },
      {
        "id": "yutaixinyong-c121",
        "title": "咏席"
      },
      {
        "id": "yutaixinyong-c122",
        "title": "江洪咏歌姬"
      },
      {
        "id": "yutaixinyong-c123",
        "title": "舞女"
      },
      {
        "id": "yutaixinyong-c124",
        "title": "咏红笺"
      },
      {
        "id": "yutaixinyong-c125",
        "title": "咏蔷薇"
      },
      {
        "id": "yutaixinyong-c126",
        "title": "高爽咏镜"
      },
      {
        "id": "yutaixinyong-c127",
        "title": "鲍子卿咏画扇"
      },
      {
        "id": "yutaixinyong-c128",
        "title": "咏玉阶"
      },
      {
        "id": "yutaixinyong-c129",
        "title": "何子朗学谢体"
      },
      {
        "id": "yutaixinyong-c130",
        "title": "和虞记室骞古意"
      },
      {
        "id": "yutaixinyong-c131",
        "title": "和缪郎视月"
      },
      {
        "id": "yutaixinyong-c132",
        "title": "范靖妇咏步摇花"
      },
      {
        "id": "yutaixinyong-c133",
        "title": "戏萧襄"
      },
      {
        "id": "yutaixinyong-c134",
        "title": "咏五彩竹火笼"
      },
      {
        "id": "yutaixinyong-c135",
        "title": "咏灯"
      },
      {
        "id": "yutaixinyong-c136",
        "title": "何逊日夕望江赠鱼司马"
      },
      {
        "id": "yutaixinyong-c137",
        "title": "咏照镜"
      },
      {
        "id": "yutaixinyong-c138",
        "title": "闺怨"
      },
      {
        "id": "yutaixinyong-c139",
        "title": "咏七夕"
      },
      {
        "id": "yutaixinyong-c140",
        "title": "咏舞妓"
      },
      {
        "id": "yutaixinyong-c141",
        "title": "看新妇"
      },
      {
        "id": "yutaixinyong-c142",
        "title": "咏倡家"
      },
      {
        "id": "yutaixinyong-c143",
        "title": "咏白鸥嘲别者"
      },
      {
        "id": "yutaixinyong-c144",
        "title": "学青青河边草"
      },
      {
        "id": "yutaixinyong-c145",
        "title": "嘲刘孝绰"
      },
      {
        "id": "yutaixinyong-c146",
        "title": "王枢古意应萧信武教"
      },
      {
        "id": "yutaixinyong-c147",
        "title": "至乌林村见采桑者聊以赠之"
      },
      {
        "id": "yutaixinyong-c148",
        "title": "徐尚书座赋得可怜"
      },
      {
        "id": "yutaixinyong-c149",
        "title": "庾丹秋闺有望"
      },
      {
        "id": "yutaixinyong-c150",
        "title": "夜梦还家"
      },
      {
        "id": "yutaixinyong-c151",
        "title": "吴均和萧洗马子显古意六首"
      },
      {
        "id": "yutaixinyong-c152",
        "title": "与柳恽相赠答六首"
      },
      {
        "id": "yutaixinyong-c153",
        "title": "拟古四首"
      },
      {
        "id": "yutaixinyong-c154",
        "title": "赠杜容成一首"
      },
      {
        "id": "yutaixinyong-c155",
        "title": "春咏"
      },
      {
        "id": "yutaixinyong-c156",
        "title": "去妾赠前夫"
      },
      {
        "id": "yutaixinyong-c157",
        "title": "咏少年"
      },
      {
        "id": "yutaixinyong-c158",
        "title": "王僧孺春怨"
      },
      {
        "id": "yutaixinyong-c159",
        "title": "月夜咏陈南康新有所纳"
      },
      {
        "id": "yutaixinyong-c160",
        "title": "见贵者初迎盛姬聊为之咏"
      },
      {
        "id": "yutaixinyong-c161",
        "title": "与司马治书同闻邻妇夜织"
      },
      {
        "id": "yutaixinyong-c162",
        "title": "夜愁"
      },
      {
        "id": "yutaixinyong-c163",
        "title": "春闺有怨"
      },
      {
        "id": "yutaixinyong-c164",
        "title": "捣衣"
      },
      {
        "id": "yutaixinyong-c165",
        "title": "为人述梦"
      },
      {
        "id": "yutaixinyong-c166",
        "title": "为人伤近不见"
      },
      {
        "id": "yutaixinyong-c167",
        "title": "为何库部旧姬拟蘼芜之句"
      },
      {
        "id": "yutaixinyong-c168",
        "title": "在王晋安酒席数韵"
      },
      {
        "id": "yutaixinyong-c169",
        "title": "为人有赠"
      },
      {
        "id": "yutaixinyong-c170",
        "title": "何生姬人有怨"
      },
      {
        "id": "yutaixinyong-c171",
        "title": "鼓瑟曲□有所思"
      },
      {
        "id": "yutaixinyong-c172",
        "title": "为人宠姬有怨"
      },
      {
        "id": "yutaixinyong-c173",
        "title": "为人自伤"
      },
      {
        "id": "yutaixinyong-c174",
        "title": "秋闺怨"
      },
      {
        "id": "yutaixinyong-c175",
        "title": "张率相逢行"
      },
      {
        "id": "yutaixinyong-c176",
        "title": "对酒"
      },
      {
        "id": "yutaixinyong-c177",
        "title": "远期"
      },
      {
        "id": "yutaixinyong-c178",
        "title": "徐悱赠内"
      },
      {
        "id": "yutaixinyong-c179",
        "title": "对房前桃树咏佳期赠内"
      },
      {
        "id": "yutaixinyong-c180",
        "title": "费昶华观省中夜闻城外捣衣"
      },
      {
        "id": "yutaixinyong-c181",
        "title": "和萧记室春旦有所思"
      },
      {
        "id": "yutaixinyong-c182",
        "title": "春郊望美人"
      },
      {
        "id": "yutaixinyong-c183",
        "title": "咏照镜"
      },
      {
        "id": "yutaixinyong-c184",
        "title": "和萧洗马画屏风二首"
      },
      {
        "id": "yutaixinyong-c185",
        "title": "采菱"
      },
      {
        "id": "yutaixinyong-c186",
        "title": "长门怨"
      },
      {
        "id": "yutaixinyong-c187",
        "title": "鼓吹曲二首"
      },
      {
        "id": "yutaixinyong-c188",
        "title": "姚翻同郭侍郎采桑一首"
      },
      {
        "id": "yutaixinyong-c189",
        "title": "孔翁归奉和湘东王教班婕妤一首"
      },
      {
        "id": "yutaixinyong-c190",
        "title": "徐悱妻刘令娴答外诗二首"
      },
      {
        "id": "yutaixinyong-c191",
        "title": "何思澄奉和湘东王教班婕妤"
      },
      {
        "id": "yutaixinyong-c192",
        "title": "拟古"
      },
      {
        "id": "yutaixinyong-c193",
        "title": "南苑逢美人"
      },
      {
        "id": "yutaixinyong-c194",
        "title": "徐悱答唐襄七夕所穿针"
      },
      {
        "id": "yutaixinyong-c195",
        "title": "梁武帝捣衣"
      },
      {
        "id": "yutaixinyong-c196",
        "title": "拟长安有狭斜十韵"
      },
      {
        "id": "yutaixinyong-c197",
        "title": "拟明月照高楼"
      },
      {
        "id": "yutaixinyong-c198",
        "title": "拟青青河边草"
      },
      {
        "id": "yutaixinyong-c199",
        "title": "代苏属国妇"
      },
      {
        "id": "yutaixinyong-c200",
        "title": "古意二首"
      },
      {
        "id": "yutaixinyong-c201",
        "title": "芳树"
      },
      {
        "id": "yutaixinyong-c202",
        "title": "临高台"
      },
      {
        "id": "yutaixinyong-c203",
        "title": "有所思"
      },
      {
        "id": "yutaixinyong-c204",
        "title": "紫兰始萌"
      },
      {
        "id": "yutaixinyong-c205",
        "title": "织妇"
      },
      {
        "id": "yutaixinyong-c206",
        "title": "七夕"
      },
      {
        "id": "yutaixinyong-c207",
        "title": "戏作"
      },
      {
        "id": "yutaixinyong-c208",
        "title": "皇太子圣制乐府三首（简文）"
      },
      {
        "id": "yutaixinyong-c209",
        "title": "代乐府三首"
      },
      {
        "id": "yutaixinyong-c210",
        "title": "和湘东王横吹曲三首"
      },
      {
        "id": "yutaixinyong-c211",
        "title": "雍州十曲抄三首（是襄州）"
      },
      {
        "id": "yutaixinyong-c212",
        "title": "同庾肩吾四咏二首"
      },
      {
        "id": "yutaixinyong-c213",
        "title": "和湘东王三韵二首"
      },
      {
        "id": "yutaixinyong-c214",
        "title": "戏作谢惠连体十三韵"
      },
      {
        "id": "yutaixinyong-c215",
        "title": "倡妇怨情十二韵"
      },
      {
        "id": "yutaixinyong-c216",
        "title": "和徐录事见内人作卧具"
      },
      {
        "id": "yutaixinyong-c217",
        "title": "戏赠丽人"
      },
      {
        "id": "yutaixinyong-c218",
        "title": "秋闺夜思"
      },
      {
        "id": "yutaixinyong-c219",
        "title": "和湘东王名士悦倾城"
      },
      {
        "id": "yutaixinyong-c220",
        "title": "从顿暂还城"
      },
      {
        "id": "yutaixinyong-c221",
        "title": "咏人弃妾"
      },
      {
        "id": "yutaixinyong-c222",
        "title": "执笔戏书"
      },
      {
        "id": "yutaixinyong-c223",
        "title": "艳歌曲"
      },
      {
        "id": "yutaixinyong-c224",
        "title": "怨"
      },
      {
        "id": "yutaixinyong-c225",
        "title": "拟沈隐侯夜夜曲"
      },
      {
        "id": "yutaixinyong-c226",
        "title": "七夕"
      },
      {
        "id": "yutaixinyong-c227",
        "title": "同刘谘议咏春雪"
      },
      {
        "id": "yutaixinyong-c228",
        "title": "晚景出行"
      },
      {
        "id": "yutaixinyong-c229",
        "title": "赋乐府得大垂手"
      },
      {
        "id": "yutaixinyong-c230",
        "title": "赋乐器名得箜篌"
      },
      {
        "id": "yutaixinyong-c231",
        "title": "咏舞"
      },
      {
        "id": "yutaixinyong-c232",
        "title": "春闺情"
      },
      {
        "id": "yutaixinyong-c233",
        "title": "又三韵"
      },
      {
        "id": "yutaixinyong-c234",
        "title": "率尔为咏"
      },
      {
        "id": "yutaixinyong-c235",
        "title": "美人晨妆"
      },
      {
        "id": "yutaixinyong-c236",
        "title": "赋得当炉"
      },
      {
        "id": "yutaixinyong-c237",
        "title": "林下妓"
      },
      {
        "id": "yutaixinyong-c238",
        "title": "拟落日窗中坐"
      },
      {
        "id": "yutaixinyong-c239",
        "title": "美人观画"
      },
      {
        "id": "yutaixinyong-c240",
        "title": "娈童"
      },
      {
        "id": "yutaixinyong-c241",
        "title": "邵陵王纶代秋胡妇闺怨"
      },
      {
        "id": "yutaixinyong-c242",
        "title": "车中见美人"
      },
      {
        "id": "yutaixinyong-c243",
        "title": "代旧姬有怨"
      },
      {
        "id": "yutaixinyong-c244",
        "title": "湘东王绎登颜园故阁"
      },
      {
        "id": "yutaixinyong-c245",
        "title": "戏作艳诗"
      },
      {
        "id": "yutaixinyong-c246",
        "title": "夜游柏斋"
      },
      {
        "id": "yutaixinyong-c247",
        "title": "和刘上黄"
      },
      {
        "id": "yutaixinyong-c248",
        "title": "咏晚栖乌"
      },
      {
        "id": "yutaixinyong-c249",
        "title": "寒宵三韵"
      },
      {
        "id": "yutaixinyong-c250",
        "title": "咏秋夜"
      },
      {
        "id": "yutaixinyong-c251",
        "title": "武陵王纪同萧长史看妓"
      },
      {
        "id": "yutaixinyong-c252",
        "title": "和湘东王夜梦应令"
      },
      {
        "id": "yutaixinyong-c253",
        "title": "晓思"
      },
      {
        "id": "yutaixinyong-c254",
        "title": "闺妾寄征人"
      },
      {
        "id": "yutaixinyong-c255",
        "title": "萧子显乐府二首"
      },
      {
        "id": "yutaixinyong-c256",
        "title": "王筠和吴主簿六首"
      },
      {
        "id": "yutaixinyong-c257",
        "title": "刘孝绰遥见邻舟主人投一物众姬争之有客请余为咏"
      },
      {
        "id": "yutaixinyong-c258",
        "title": "淇上人戏荡子妇示行事一首"
      },
      {
        "id": "yutaixinyong-c259",
        "title": "赋得照棋烛刻五分成"
      },
      {
        "id": "yutaixinyong-c260",
        "title": "夜听妓赋得乌夜啼"
      },
      {
        "id": "yutaixinyong-c261",
        "title": "赋得遗所思"
      },
      {
        "id": "yutaixinyong-c262",
        "title": "刘遵繁华应令"
      },
      {
        "id": "yutaixinyong-c263",
        "title": "从顿还城应令"
      },
      {
        "id": "yutaixinyong-c264",
        "title": "王训奉和率尔有咏"
      },
      {
        "id": "yutaixinyong-c265",
        "title": "庾肩吾咏得有所思"
      },
      {
        "id": "yutaixinyong-c266",
        "title": "咏美人自看画应令"
      },
      {
        "id": "yutaixinyong-c267",
        "title": "赋得横吹曲长安道"
      },
      {
        "id": "yutaixinyong-c268",
        "title": "南苑还看人"
      },
      {
        "id": "yutaixinyong-c269",
        "title": "送别于建兴苑相逢"
      },
      {
        "id": "yutaixinyong-c270",
        "title": "和湘东王二首"
      },
      {
        "id": "yutaixinyong-c271",
        "title": "刘孝威侍宴赋得龙沙宵月明"
      },
      {
        "id": "yutaixinyong-c272",
        "title": "奉和湘东王应令冬晓"
      },
      {
        "id": "yutaixinyong-c273",
        "title": "若阝县遇见人织率尔寄妇"
      },
      {
        "id": "yutaixinyong-c274",
        "title": "徐君共内人夜坐守岁"
      },
      {
        "id": "yutaixinyong-c275",
        "title": "初春携内人行戏"
      },
      {
        "id": "yutaixinyong-c276",
        "title": "鲍泉南苑看游者"
      },
      {
        "id": "yutaixinyong-c277",
        "title": "落日看还"
      },
      {
        "id": "yutaixinyong-c278",
        "title": "刘缓敬酬刘长史咏名士悦倾城"
      },
      {
        "id": "yutaixinyong-c279",
        "title": "杂咏和湘东王三首"
      },
      {
        "id": "yutaixinyong-c280",
        "title": "邓铿和阴梁州杂怨"
      },
      {
        "id": "yutaixinyong-c281",
        "title": "奉和夜听妓声"
      },
      {
        "id": "yutaixinyong-c282",
        "title": "甄固奉和世子春情"
      },
      {
        "id": "yutaixinyong-c283",
        "title": "庾信奉和咏舞"
      },
      {
        "id": "yutaixinyong-c284",
        "title": "七夕"
      },
      {
        "id": "yutaixinyong-c285",
        "title": "仰和何仆射还宅怀故"
      },
      {
        "id": "yutaixinyong-c286",
        "title": "刘邈万山见采桑人"
      },
      {
        "id": "yutaixinyong-c287",
        "title": "见人织聊为之咏"
      },
      {
        "id": "yutaixinyong-c288",
        "title": "秋闺"
      },
      {
        "id": "yutaixinyong-c289",
        "title": "鼓吹曲□折杨柳"
      },
      {
        "id": "yutaixinyong-c290",
        "title": "纪少瑜建兴苑"
      },
      {
        "id": "yutaixinyong-c291",
        "title": "拟吴均体应教"
      },
      {
        "id": "yutaixinyong-c292",
        "title": "春日"
      },
      {
        "id": "yutaixinyong-c293",
        "title": "闻人春日"
      },
      {
        "id": "yutaixinyong-c294",
        "title": "徐孝穆走笔戏书应令"
      },
      {
        "id": "yutaixinyong-c295",
        "title": "奉和咏舞"
      },
      {
        "id": "yutaixinyong-c296",
        "title": "和王舍人送客未还闺中有望"
      },
      {
        "id": "yutaixinyong-c297",
        "title": "为羊兖州家人答饷镜"
      },
      {
        "id": "yutaixinyong-c298",
        "title": "吴孜春闺怨"
      },
      {
        "id": "yutaixinyong-c299",
        "title": "汤僧济咏渫井得金钗"
      },
      {
        "id": "yutaixinyong-c300",
        "title": "徐悱妻刘氏和婕妤怨"
      },
      {
        "id": "yutaixinyong-c301",
        "title": "王叔英妻刘氏和昭君怨"
      },
      {
        "id": "yutaixinyong-c302",
        "title": "歌辞二首"
      },
      {
        "id": "yutaixinyong-c303",
        "title": "越人歌一首（并序）"
      },
      {
        "id": "yutaixinyong-c304",
        "title": "司马相如琴歌二首（并序）"
      },
      {
        "id": "yutaixinyong-c305",
        "title": "乌孙公主歌诗一首（并序）"
      },
      {
        "id": "yutaixinyong-c306",
        "title": "汉成帝时童谣歌二首（并序）"
      },
      {
        "id": "yutaixinyong-c307",
        "title": "汉桓帝时童谣歌二首"
      },
      {
        "id": "yutaixinyong-c308",
        "title": "张衡四愁诗四首"
      },
      {
        "id": "yutaixinyong-c309",
        "title": "秦嘉赠妇诗一首（四言）"
      },
      {
        "id": "yutaixinyong-c310",
        "title": "魏文帝乐府燕歌行二首"
      },
      {
        "id": "yutaixinyong-c311",
        "title": "曹植乐府妾薄命行一首（六言）"
      },
      {
        "id": "yutaixinyong-c312",
        "title": "傅玄拟北乐府三首"
      },
      {
        "id": "yutaixinyong-c313",
        "title": "拟四愁诗四首（并序）"
      },
      {
        "id": "yutaixinyong-c314",
        "title": "盘中诗一首"
      },
      {
        "id": "yutaixinyong-c315",
        "title": "张载拟四愁诗四首"
      },
      {
        "id": "yutaixinyong-c316",
        "title": "晋惠帝时童谣歌一首"
      },
      {
        "id": "yutaixinyong-c317",
        "title": "陆机乐府燕歌行一首"
      },
      {
        "id": "yutaixinyong-c318",
        "title": "代白歌辞二首"
      },
      {
        "id": "yutaixinyong-c319",
        "title": "行路难四首"
      },
      {
        "id": "yutaixinyong-c320",
        "title": "释宝月行路难一首"
      },
      {
        "id": "yutaixinyong-c321",
        "title": "陆厥李夫人及贵人歌一首"
      },
      {
        "id": "yutaixinyong-c322",
        "title": "沈约八咏二首（六首在卷末）"
      },
      {
        "id": "yutaixinyong-c323",
        "title": "春日白曲一首"
      },
      {
        "id": "yutaixinyong-c324",
        "title": "秋日白曲一首"
      },
      {
        "id": "yutaixinyong-c325",
        "title": "吴均行路难二首"
      },
      {
        "id": "yutaixinyong-c326",
        "title": "张率拟乐府长相思二首"
      },
      {
        "id": "yutaixinyong-c327",
        "title": "白歌辞二首"
      },
      {
        "id": "yutaixinyong-c328",
        "title": "费昶行路难二首"
      },
      {
        "id": "yutaixinyong-c329",
        "title": "皇太子圣制乌栖曲四首（简文）"
      },
      {
        "id": "yutaixinyong-c330",
        "title": "杂句从军行一首"
      },
      {
        "id": "yutaixinyong-c331",
        "title": "和萧侍中子显春别四首（七言）"
      },
      {
        "id": "yutaixinyong-c332",
        "title": "杂句春情一首"
      },
      {
        "id": "yutaixinyong-c333",
        "title": "拟古一首"
      },
      {
        "id": "yutaixinyong-c334",
        "title": "倡楼怨节一首（六言）"
      },
      {
        "id": "yutaixinyong-c335",
        "title": "湘东王春别应令四首（七言）"
      },
      {
        "id": "yutaixinyong-c336",
        "title": "萧子显春别四首"
      },
      {
        "id": "yutaixinyong-c337",
        "title": "乐府乌栖曲应令二首"
      },
      {
        "id": "yutaixinyong-c338",
        "title": "燕歌行"
      },
      {
        "id": "yutaixinyong-c339",
        "title": "王筠行路难一首"
      },
      {
        "id": "yutaixinyong-c340",
        "title": "刘孝绰元广州景仲座见故姬一首"
      },
      {
        "id": "yutaixinyong-c341",
        "title": "刘孝威拟古应教一首"
      },
      {
        "id": "yutaixinyong-c342",
        "title": "徐君别义阳郡二首"
      },
      {
        "id": "yutaixinyong-c343",
        "title": "王叔英妇赠答一首"
      },
      {
        "id": "yutaixinyong-c344",
        "title": "古绝句四首"
      },
      {
        "id": "yutaixinyong-c345",
        "title": "贾充与妻李夫人连句诗三首"
      },
      {
        "id": "yutaixinyong-c346",
        "title": "孙绰情人碧玉歌二首"
      },
      {
        "id": "yutaixinyong-c347",
        "title": "王献之情人桃叶歌二首"
      },
      {
        "id": "yutaixinyong-c348",
        "title": "桃叶答王团扇歌三首"
      },
      {
        "id": "yutaixinyong-c349",
        "title": "谢灵运东阳中赠答二首"
      },
      {
        "id": "yutaixinyong-c350",
        "title": "宋孝武诗三首"
      },
      {
        "id": "yutaixinyong-c351",
        "title": "许瑶诗二首"
      },
      {
        "id": "yutaixinyong-c352",
        "title": "鲍令晖寄行人一首"
      },
      {
        "id": "yutaixinyong-c353",
        "title": "近代西曲歌五首"
      },
      {
        "id": "yutaixinyong-c354",
        "title": "近代吴歌九首"
      },
      {
        "id": "yutaixinyong-c355",
        "title": "近代杂歌三首"
      },
      {
        "id": "yutaixinyong-c356",
        "title": "近代杂诗一首"
      },
      {
        "id": "yutaixinyong-c357",
        "title": "丹阳孟珠歌一首"
      },
      {
        "id": "yutaixinyong-c358",
        "title": "钱唐苏小歌一首"
      },
      {
        "id": "yutaixinyong-c359",
        "title": "王元长诗四首"
      },
      {
        "id": "yutaixinyong-c360",
        "title": "谢诗四首"
      },
      {
        "id": "yutaixinyong-c361",
        "title": "虞炎有所思一首"
      },
      {
        "id": "yutaixinyong-c362",
        "title": "沈约诗三首"
      },
      {
        "id": "yutaixinyong-c363",
        "title": "施荣泰咏王昭君一首"
      },
      {
        "id": "yutaixinyong-c364",
        "title": "高爽咏酌酒人一首"
      },
      {
        "id": "yutaixinyong-c365",
        "title": "吴兴妖神赠谢府君览一首"
      },
      {
        "id": "yutaixinyong-c366",
        "title": "江洪诗七首"
      },
      {
        "id": "yutaixinyong-c367",
        "title": "范静妇诗三首"
      },
      {
        "id": "yutaixinyong-c368",
        "title": "何逊诗五首"
      },
      {
        "id": "yutaixinyong-c369",
        "title": "吴均杂绝句四首"
      },
      {
        "id": "yutaixinyong-c370",
        "title": "王僧孺诗二首"
      },
      {
        "id": "yutaixinyong-c371",
        "title": "徐悱妇诗三首"
      },
      {
        "id": "yutaixinyong-c372",
        "title": "姚翻诗三首"
      },
      {
        "id": "yutaixinyong-c373",
        "title": "王环代西丰侯美人一首"
      },
      {
        "id": "yutaixinyong-c374",
        "title": "梁武帝诗廿七首"
      },
      {
        "id": "yutaixinyong-c375",
        "title": "皇太子杂题二十一首（简文）"
      },
      {
        "id": "yutaixinyong-c376",
        "title": "萧子显二首"
      },
      {
        "id": "yutaixinyong-c377",
        "title": "刘孝绰诗二首"
      },
      {
        "id": "yutaixinyong-c378",
        "title": "庾肩吾诗四首"
      },
      {
        "id": "yutaixinyong-c379",
        "title": "王台卿同萧治中十咏二首"
      },
      {
        "id": "yutaixinyong-c380",
        "title": "刘孝仪诗二首"
      },
      {
        "id": "yutaixinyong-c381",
        "title": "刘孝威和定襄侯八绝初笄一首"
      },
      {
        "id": "yutaixinyong-c382",
        "title": "江伯摇和定襄侯八绝楚越衫一首"
      },
      {
        "id": "yutaixinyong-c383",
        "title": "刘泓咏繁华一首"
      },
      {
        "id": "yutaixinyong-c384",
        "title": "何曼才为徐陵伤妾诗一首"
      },
      {
        "id": "yutaixinyong-c385",
        "title": "萧ら咏衤日复一首"
      },
      {
        "id": "yutaixinyong-c386",
        "title": "纪少瑜咏残灯一首"
      },
      {
        "id": "yutaixinyong-c387",
        "title": "王叔英妇暮寒一首"
      },
      {
        "id": "yutaixinyong-c388",
        "title": "戴咏欲眠诗一首"
      },
      {
        "id": "yutaixinyong-c389",
        "title": "刘孝威二首"
      },
      {
        "id": "yutaixinyong-c390",
        "title": "后叙"
      }
    ]
  },
  {
    "id": "huajianji",
    "title": "花间集",
    "author": "五代后蜀·赵崇祚 编",
    "category": "ji",
    "description": "中国第一部文人词总集十卷五百首，温韦以降十八家倚声填词之祖。全本。",
    "dynasty": "五代",
    "sizeBytes": 92106,
    "toc": [
      {
        "id": "huajianji-c1",
        "title": "卷一"
      },
      {
        "id": "huajianji-c2",
        "title": "卷二"
      },
      {
        "id": "huajianji-c3",
        "title": "卷三"
      },
      {
        "id": "huajianji-c4",
        "title": "卷四"
      },
      {
        "id": "huajianji-c5",
        "title": "卷五"
      },
      {
        "id": "huajianji-c6",
        "title": "卷六"
      },
      {
        "id": "huajianji-c7",
        "title": "卷七"
      },
      {
        "id": "huajianji-c8",
        "title": "卷八"
      },
      {
        "id": "huajianji-c9",
        "title": "卷九"
      },
      {
        "id": "huajianji-c10",
        "title": "卷十"
      }
    ]
  },
  {
    "id": "yuefushiji",
    "title": "乐府诗集",
    "author": "北宋·郭茂倩 编",
    "category": "ji",
    "description": "乐府诗总集一百卷，郊庙至杂歌十二类，上古至五代乐府渊薮。全本。",
    "dynasty": "北宋",
    "sizeBytes": 1243553,
    "toc": [
      {
        "id": "yuefushiji-c1",
        "title": "卷一·郊庙歌辞一"
      },
      {
        "id": "yuefushiji-c2",
        "title": "卷二·郊庙歌辞二"
      },
      {
        "id": "yuefushiji-c3",
        "title": "卷三·郊庙歌辞三"
      },
      {
        "id": "yuefushiji-c4",
        "title": "卷四·郊庙歌辞四"
      },
      {
        "id": "yuefushiji-c5",
        "title": "卷五·郊庙歌辞五"
      },
      {
        "id": "yuefushiji-c6",
        "title": "卷六·郊庙歌辞六"
      },
      {
        "id": "yuefushiji-c7",
        "title": "卷七·郊庙歌辞七"
      },
      {
        "id": "yuefushiji-c8",
        "title": "卷八·郊庙歌辞八"
      },
      {
        "id": "yuefushiji-c9",
        "title": "卷九·郊庙歌辞九"
      },
      {
        "id": "yuefushiji-c10",
        "title": "卷十一·郊庙歌辞十一"
      },
      {
        "id": "yuefushiji-c11",
        "title": "卷十二·郊庙歌辞十二"
      },
      {
        "id": "yuefushiji-c12",
        "title": "卷十三·燕射歌辞一"
      },
      {
        "id": "yuefushiji-c13",
        "title": "卷十四·燕射歌辞二"
      },
      {
        "id": "yuefushiji-c14",
        "title": "卷十五·燕射歌辞三"
      },
      {
        "id": "yuefushiji-c15",
        "title": "卷十六·鼓吹曲辞一"
      },
      {
        "id": "yuefushiji-c16",
        "title": "卷十七·鼓吹曲辞二"
      },
      {
        "id": "yuefushiji-c17",
        "title": "卷十八·鼓吹曲辞三"
      },
      {
        "id": "yuefushiji-c18",
        "title": "卷十九·鼓吹曲辞四"
      },
      {
        "id": "yuefushiji-c19",
        "title": "卷二十·鼓吹曲辞五"
      },
      {
        "id": "yuefushiji-c20",
        "title": "卷二十一·横吹曲辞一"
      },
      {
        "id": "yuefushiji-c21",
        "title": "卷二十二·横吹曲辞二"
      },
      {
        "id": "yuefushiji-c22",
        "title": "卷二十三·横吹曲辞三"
      },
      {
        "id": "yuefushiji-c23",
        "title": "卷二十四·横吹曲辞四"
      },
      {
        "id": "yuefushiji-c24",
        "title": "卷二十五·横吹曲辞五"
      },
      {
        "id": "yuefushiji-c25",
        "title": "卷二十六·相和歌辞一"
      },
      {
        "id": "yuefushiji-c26",
        "title": "卷二十七·相和歌辞二"
      },
      {
        "id": "yuefushiji-c27",
        "title": "卷二十八·相和歌辞三"
      },
      {
        "id": "yuefushiji-c28",
        "title": "卷二十九·相和歌辞四"
      },
      {
        "id": "yuefushiji-c29",
        "title": "卷三十·相和歌辞五"
      },
      {
        "id": "yuefushiji-c30",
        "title": "卷三十一·相和歌辞六"
      },
      {
        "id": "yuefushiji-c31",
        "title": "卷三十二·相和歌辞七"
      },
      {
        "id": "yuefushiji-c32",
        "title": "卷三十三·相和歌辞八"
      },
      {
        "id": "yuefushiji-c33",
        "title": "卷三十四·相和歌辞九"
      },
      {
        "id": "yuefushiji-c34",
        "title": "卷三十五·相和歌辞十"
      },
      {
        "id": "yuefushiji-c35",
        "title": "卷三十六·相和歌辞十一"
      },
      {
        "id": "yuefushiji-c36",
        "title": "卷五十一·清商曲辞八"
      },
      {
        "id": "yuefushiji-c37",
        "title": "卷五十二·舞曲歌辞一"
      },
      {
        "id": "yuefushiji-c38",
        "title": "卷五十三·舞曲歌辞二"
      },
      {
        "id": "yuefushiji-c39",
        "title": "卷五十四·舞曲歌辞三"
      },
      {
        "id": "yuefushiji-c40",
        "title": "卷五十五·舞曲歌辞四"
      },
      {
        "id": "yuefushiji-c41",
        "title": "卷五十六·舞曲歌辞五"
      },
      {
        "id": "yuefushiji-c42",
        "title": "卷五十七·琴曲歌辞一"
      },
      {
        "id": "yuefushiji-c43",
        "title": "卷五十八·琴曲歌辞二"
      },
      {
        "id": "yuefushiji-c44",
        "title": "卷五十九·琴曲歌辞三"
      },
      {
        "id": "yuefushiji-c45",
        "title": "卷六十·琴曲歌辞四"
      },
      {
        "id": "yuefushiji-c46",
        "title": "卷六十一·杂曲歌辞一"
      },
      {
        "id": "yuefushiji-c47",
        "title": "卷六十二·杂曲歌辞二"
      },
      {
        "id": "yuefushiji-c48",
        "title": "卷六十三·杂曲歌辞三"
      },
      {
        "id": "yuefushiji-c49",
        "title": "卷六十四·杂曲歌辞四"
      },
      {
        "id": "yuefushiji-c50",
        "title": "卷六十五·杂曲歌辞五"
      },
      {
        "id": "yuefushiji-c51",
        "title": "卷六十六·杂曲歌辞六"
      },
      {
        "id": "yuefushiji-c52",
        "title": "卷六十七·杂曲歌辞七"
      },
      {
        "id": "yuefushiji-c53",
        "title": "卷六十九·杂曲歌辞九"
      },
      {
        "id": "yuefushiji-c54",
        "title": "卷七十·杂曲歌辞十"
      },
      {
        "id": "yuefushiji-c55",
        "title": "卷七十一·杂曲歌辞十一"
      },
      {
        "id": "yuefushiji-c56",
        "title": "卷七十二·杂曲歌辞十二"
      },
      {
        "id": "yuefushiji-c57",
        "title": "卷七十三·杂曲歌辞十三"
      },
      {
        "id": "yuefushiji-c58",
        "title": "卷七十四·杂曲歌辞十四"
      },
      {
        "id": "yuefushiji-c59",
        "title": "卷七十五·杂曲歌辞十五"
      },
      {
        "id": "yuefushiji-c60",
        "title": "卷七十六·杂曲歌辞十六"
      },
      {
        "id": "yuefushiji-c61",
        "title": "卷七十七·杂曲歌辞十七"
      },
      {
        "id": "yuefushiji-c62",
        "title": "卷七十八·杂曲歌辞十八"
      },
      {
        "id": "yuefushiji-c63",
        "title": "卷七十九·近代曲辞一"
      },
      {
        "id": "yuefushiji-c64",
        "title": "卷八十·近代曲辞二"
      },
      {
        "id": "yuefushiji-c65",
        "title": "卷八十一·近代曲辞三"
      },
      {
        "id": "yuefushiji-c66",
        "title": "卷八十二·近代曲辞四"
      },
      {
        "id": "yuefushiji-c67",
        "title": "卷八十三·杂歌谣辞一"
      },
      {
        "id": "yuefushiji-c68",
        "title": "卷八十四·杂歌谣辞二"
      },
      {
        "id": "yuefushiji-c69",
        "title": "卷八十五·杂歌谣辞三"
      },
      {
        "id": "yuefushiji-c70",
        "title": "卷八十六·杂歌谣辞四"
      },
      {
        "id": "yuefushiji-c71",
        "title": "卷八十七·杂歌谣辞五"
      },
      {
        "id": "yuefushiji-c72",
        "title": "卷八十八·杂歌谣辞六"
      },
      {
        "id": "yuefushiji-c73",
        "title": "卷八十九·杂歌谣辞七"
      },
      {
        "id": "yuefushiji-c74",
        "title": "卷九十·新乐府辞一"
      },
      {
        "id": "yuefushiji-c75",
        "title": "卷九十一·新乐府辞二"
      },
      {
        "id": "yuefushiji-c76",
        "title": "卷九十二·新乐府辞三"
      },
      {
        "id": "yuefushiji-c77",
        "title": "卷九十四·新乐府辞五"
      },
      {
        "id": "yuefushiji-c78",
        "title": "卷九十五·新乐府辞六"
      },
      {
        "id": "yuefushiji-c79",
        "title": "卷九十六·新乐府辞七"
      },
      {
        "id": "yuefushiji-c80",
        "title": "卷九十八·新乐府辞九"
      },
      {
        "id": "yuefushiji-c81",
        "title": "卷九十九·新乐府辞十"
      },
      {
        "id": "yuefushiji-c82",
        "title": "卷一百·新乐府辞十一"
      }
    ]
  },
  {
    "id": "wenxindiaolong",
    "title": "文心雕龙",
    "author": "南朝梁·刘勰 撰",
    "category": "ji",
    "description": "中国第一部体系完备的文学理论巨著五十篇，体大思精笼罩群言。全本。",
    "dynasty": "南朝梁",
    "sizeBytes": 150813,
    "toc": [
      {
        "id": "wenxindiaolong-c1",
        "title": "原道第一"
      },
      {
        "id": "wenxindiaolong-c2",
        "title": "微圣第二"
      },
      {
        "id": "wenxindiaolong-c3",
        "title": "宗经第三"
      },
      {
        "id": "wenxindiaolong-c4",
        "title": "正纬第四"
      },
      {
        "id": "wenxindiaolong-c5",
        "title": "辩骚第五"
      },
      {
        "id": "wenxindiaolong-c6",
        "title": "明诗第六"
      },
      {
        "id": "wenxindiaolong-c7",
        "title": "乐府第七"
      },
      {
        "id": "wenxindiaolong-c8",
        "title": "铨赋第八"
      },
      {
        "id": "wenxindiaolong-c9",
        "title": "颂赞第九"
      },
      {
        "id": "wenxindiaolong-c10",
        "title": "祝盟第十"
      },
      {
        "id": "wenxindiaolong-c11",
        "title": "铭箴第十一"
      },
      {
        "id": "wenxindiaolong-c12",
        "title": "诔碑第十二"
      },
      {
        "id": "wenxindiaolong-c13",
        "title": "哀吊第十三"
      },
      {
        "id": "wenxindiaolong-c14",
        "title": "杂文第十四"
      },
      {
        "id": "wenxindiaolong-c15",
        "title": "谐讔第十五"
      },
      {
        "id": "wenxindiaolong-c16",
        "title": "史传第十六"
      },
      {
        "id": "wenxindiaolong-c17",
        "title": "诸子第十七"
      },
      {
        "id": "wenxindiaolong-c18",
        "title": "论说第十八"
      },
      {
        "id": "wenxindiaolong-c19",
        "title": "诏策第十九"
      },
      {
        "id": "wenxindiaolong-c20",
        "title": "檄移第二十"
      },
      {
        "id": "wenxindiaolong-c21",
        "title": "封禅第二十一"
      },
      {
        "id": "wenxindiaolong-c22",
        "title": "章表第二十二"
      },
      {
        "id": "wenxindiaolong-c23",
        "title": "奏启第二十三"
      },
      {
        "id": "wenxindiaolong-c24",
        "title": "议对第二十四"
      },
      {
        "id": "wenxindiaolong-c25",
        "title": "书记第二十五"
      },
      {
        "id": "wenxindiaolong-c26",
        "title": "神思第二十六"
      },
      {
        "id": "wenxindiaolong-c27",
        "title": "体性第二十七"
      },
      {
        "id": "wenxindiaolong-c28",
        "title": "风骨第二十八"
      },
      {
        "id": "wenxindiaolong-c29",
        "title": "通变第二十九"
      },
      {
        "id": "wenxindiaolong-c30",
        "title": "定势第三十"
      },
      {
        "id": "wenxindiaolong-c31",
        "title": "情采第三十一"
      },
      {
        "id": "wenxindiaolong-c32",
        "title": "镕裁第三十二"
      },
      {
        "id": "wenxindiaolong-c33",
        "title": "声律第三十三"
      },
      {
        "id": "wenxindiaolong-c34",
        "title": "章句第三十四"
      },
      {
        "id": "wenxindiaolong-c35",
        "title": "丽辞第三十五"
      },
      {
        "id": "wenxindiaolong-c36",
        "title": "比兴第三十六"
      },
      {
        "id": "wenxindiaolong-c37",
        "title": "夸饰第三十七"
      },
      {
        "id": "wenxindiaolong-c38",
        "title": "事类第三十八"
      },
      {
        "id": "wenxindiaolong-c39",
        "title": "练字第三十九"
      },
      {
        "id": "wenxindiaolong-c40",
        "title": "隐秀第四十"
      },
      {
        "id": "wenxindiaolong-c41",
        "title": "指瑕第四十一"
      },
      {
        "id": "wenxindiaolong-c42",
        "title": "养气第四十二"
      },
      {
        "id": "wenxindiaolong-c43",
        "title": "附会第四十三"
      },
      {
        "id": "wenxindiaolong-c44",
        "title": "总术第四十四"
      },
      {
        "id": "wenxindiaolong-c45",
        "title": "时序第四十五"
      },
      {
        "id": "wenxindiaolong-c46",
        "title": "物色第四十六"
      },
      {
        "id": "wenxindiaolong-c47",
        "title": "才略第四十七"
      },
      {
        "id": "wenxindiaolong-c48",
        "title": "知音第四十八"
      },
      {
        "id": "wenxindiaolong-c49",
        "title": "程器第四十九"
      },
      {
        "id": "wenxindiaolong-c50",
        "title": "序志第五十"
      }
    ]
  },
  {
    "id": "caozijian",
    "title": "曹子建集",
    "author": "曹魏·曹植 撰",
    "category": "ji",
    "description": "建安之雄才陈思王诗文赋十卷，白马篇洛神赋七哀诗俱在其中。全本。",
    "dynasty": "曹魏",
    "sizeBytes": 122886,
    "toc": [
      {
        "id": "caozijian-c1",
        "title": "卷一"
      },
      {
        "id": "caozijian-c2",
        "title": "卷二"
      },
      {
        "id": "caozijian-c3",
        "title": "卷三"
      },
      {
        "id": "caozijian-c4",
        "title": "卷四"
      },
      {
        "id": "caozijian-c5",
        "title": "卷五"
      },
      {
        "id": "caozijian-c6",
        "title": "卷六"
      },
      {
        "id": "caozijian-c7",
        "title": "卷七"
      },
      {
        "id": "caozijian-c8",
        "title": "卷八"
      },
      {
        "id": "caozijian-c9",
        "title": "卷九"
      },
      {
        "id": "caozijian-c10",
        "title": "卷十"
      }
    ]
  }
];

export function getBuiltinSpec(id: string): BuiltinBookSpec | undefined {
  return BUILTIN_CATALOG.find((b) => b.id === id);
}
