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
  },
  {
    "id": "xinjing",
    "title": "心经",
    "author": "唐·玄奘 译",
    "category": "zi",
    "description": "《般若波罗蜜多心经》，大乘般若类经典纲要，二百六十字摄空义总纲。全本。",
    "dynasty": "唐"
  },
  {
    "id": "jingangjing",
    "title": "金刚经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《金刚般若波罗蜜经》，般若类核心经典，言无住生心、无相布施之旨。全本。",
    "dynasty": "后秦"
  },
  {
    "id": "emituofojing",
    "title": "阿弥陀经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《佛说阿弥陀经》，净土宗核心经典，述西方极乐世界依正庄严。全本。",
    "dynasty": "后秦"
  },
  {
    "id": "wuliangshoujing",
    "title": "无量寿经",
    "author": "曹魏·康僧铠 译",
    "category": "zi",
    "description": "《佛说无量寿经》，净土三经之一，述阿弥陀佛四十八愿与净土行果。全本。",
    "dynasty": "曹魏"
  },
  {
    "id": "guanwuliangshoujing",
    "title": "观无量寿经",
    "author": "刘宋·畺良耶舍 译",
    "category": "zi",
    "description": "《佛说观无量寿佛经》，净土三经之一，明十六观法与三辈往生。全本。",
    "dynasty": "刘宋"
  },
  {
    "id": "yaoshijing",
    "title": "药师经",
    "author": "隋·达摩笈多 译",
    "category": "zi",
    "description": "《佛说药师如来本愿经》，述药师琉璃光如来十二大愿，济世度厄。全本。",
    "dynasty": "隋"
  },
  {
    "id": "fajujing",
    "title": "法句经",
    "author": "三国吴·维祚难 等译",
    "category": "zi",
    "description": "上座部法句偈颂集汉译本，三十九品七百余偈，言身心谛修之要。全本。",
    "dynasty": "三国"
  },
  {
    "id": "baiyujing",
    "title": "百喻经",
    "author": "萧齐·求那毗地 译",
    "category": "zi",
    "description": "印度僧伽斯那集九十八喻，以寓言譬喻显佛法义理。全本。",
    "dynasty": "南朝齐"
  },
  {
    "id": "sishierzhangjing",
    "title": "四十二章经",
    "author": "东汉·迦叶摩腾、竺法兰 译",
    "category": "zi",
    "description": "相传为汉地最早译出的佛经，四十二章摄出家修行纲要。全本。",
    "dynasty": "东汉"
  },
  {
    "id": "yuanjuejing",
    "title": "圆觉经",
    "author": "唐·佛陀多罗 译",
    "category": "zi",
    "description": "《大方广圆觉修多罗了义经》，述十二菩萨问圆觉法门。全本。",
    "dynasty": "唐"
  },
  {
    "id": "yijiaojing",
    "title": "佛遗教经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "释迦牟尼临涅槃所述遗诫，又称《佛垂般涅槃略说教诫经》。全本。",
    "dynasty": "后秦"
  },
  {
    "id": "badarenjuejing",
    "title": "八大人觉经",
    "author": "东汉·安世高 译",
    "category": "zi",
    "description": "述诸佛菩萨大人所觉悟之八法，明出世解脱路径。全本。",
    "dynasty": "东汉"
  },
  {
    "id": "weimojing",
    "title": "维摩诘经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《维摩诘所说经》十四品，示在家菩萨不可思议解脱法门。全本。",
    "dynasty": "后秦"
  },
  {
    "id": "fahuajing",
    "title": "妙法莲华经",
    "author": "后秦·鸠摩罗什 译",
    "category": "zi",
    "description": "《妙法莲华经》二十八品，开权显实、会三归一之大乘要典。全本。",
    "dynasty": "后秦"
  },
  {
    "id": "lengyanjing",
    "title": "楞严经",
    "author": "唐·般剌蜜帝 译",
    "category": "zi",
    "description": "《大佛顶首楞严经》十卷，明心见性、五十阴魔之照胆镜。全本。",
    "dynasty": "唐"
  },
  {
    "id": "dizangjing",
    "title": "地藏经",
    "author": "唐·实叉难陀 译",
    "category": "zi",
    "description": "《地藏菩萨本愿经》十三品，明孝道与地狱救度之愿力。全本。",
    "dynasty": "唐"
  },
  {
    "id": "liuzutanjing",
    "title": "六祖坛经",
    "author": "唐·法海 集记",
    "category": "zi",
    "description": "禅宗六祖惠能于韶州大梵寺说法集录，唯一被尊称为「经」的中国僧人著述。全本。",
    "dynasty": "唐"
  },
  {
    "id": "qingjingjing",
    "title": "清静经",
    "author": "唐·佚名（旧题太上老君说）",
    "category": "zi",
    "description": "《太上老君说常清静经》，澄心遣欲、内修心神之道家要典。全本。",
    "dynasty": "唐"
  },
  {
    "id": "yinfujing",
    "title": "阴符经",
    "author": "旧题黄帝撰（唐·李筌得于嵩山）",
    "category": "zi",
    "description": "《黄帝阴符经》三百余字，言观天之道、执天之行。全本。",
    "dynasty": "唐"
  },
  {
    "id": "guanyinzi",
    "title": "关尹子",
    "author": "周·关令尹喜 著",
    "category": "zi",
    "description": "又称《文始真经》九篇，以宇柱极符鉴匕釜筹药名篇。全本。",
    "dynasty": "先秦"
  },
  {
    "id": "guiguzi",
    "title": "鬼谷子",
    "author": "旧题战国·鬼谷子 著",
    "category": "zi",
    "description": "纵横家鼻祖之书，捭阖、反应、揣摩、权谋十二篇。全本。",
    "dynasty": "战国"
  },
  {
    "id": "liezi",
    "title": "列子",
    "author": "战国·列御寇 著",
    "category": "zi",
    "description": "又称《冲虚至德真经》八篇，寓道于寓言，天瑞说符俱载。全本。",
    "dynasty": "战国"
  },
  {
    "id": "heguanzi",
    "title": "鹖冠子",
    "author": "战国·鹖冠子 著（宋·陆佃解）",
    "category": "zi",
    "description": "道家与纵横家言杂糅之子书十九篇。全本。",
    "dynasty": "战国"
  },
  {
    "id": "huainanzi",
    "title": "淮南子",
    "author": "西汉·刘安 撰（许慎 注）",
    "category": "zi",
    "description": "《淮南鸿烈解》二十八卷，集道家思想大成的鸿篇。全本。",
    "dynasty": "西汉"
  },
  {
    "id": "baopuzi",
    "title": "抱朴子内篇",
    "author": "东晋·葛洪 著",
    "category": "zi",
    "description": "金丹道教理论奠基之作二十卷，言神仙方药、养生延年。全本。",
    "dynasty": "东晋"
  },
  {
    "id": "huashu",
    "title": "化书",
    "author": "五代·谭峭 著",
    "category": "zi",
    "description": "道化、术化、德化、仁化、食化、俭化六卷，观物化之理。全本。",
    "dynasty": "五代"
  },
  {
    "id": "wuzhenpian",
    "title": "悟真篇",
    "author": "北宋·张伯端 著",
    "category": "zi",
    "description": "内丹南宗祖经，据《修真十书》本，与《参同契》并尊。全本。",
    "dynasty": "北宋"
  },
  {
    "id": "zuowanglun",
    "title": "坐忘论",
    "author": "唐·司马承祯 著",
    "category": "zi",
    "description": "道教修真理论名篇，敬信至得道七阶及枢翼。全本。",
    "dynasty": "唐"
  },
  {
    "id": "ganyingpian",
    "title": "太上感应篇",
    "author": "宋·李昌龄 传、郑清之 赞",
    "category": "zi",
    "description": "以太上本文冠首，附李昌龄传、郑清之赞三十卷，劝善书之首。全本。",
    "dynasty": "宋"
  },
  {
    "id": "xiaojing",
    "title": "孝经",
    "author": "先秦·孔门后学（旧题曾子问、孔子说）",
    "category": "jing",
    "description": "儒家孝道经典，十八章，以孝为德之本、教之源。全本。",
    "dynasty": "先秦"
  },
  {
    "id": "erya",
    "title": "尔雅",
    "author": "先秦～西汉·学者缀辑",
    "category": "jing",
    "description": "中国第一部训诂词典，十九篇释诂释言至释兽释畜，读经之津梁。全本。",
    "dynasty": "先秦"
  },
  {
    "id": "liji",
    "title": "礼记",
    "author": "西汉·戴圣 编（旧题郑玄 注）",
    "category": "jing",
    "description": "儒家礼学论文与礼制文献汇编四十九篇，与《周礼》《仪礼》并称三礼。全本。",
    "dynasty": "西汉"
  },
  {
    "id": "guoyu",
    "title": "国语",
    "author": "旧题左丘明 撰",
    "category": "shi",
    "description": "国别体史书之祖，二十一卷记周鲁齐晋郑楚吴越八国卿大夫言论。全本。",
    "dynasty": "先秦"
  },
  {
    "id": "zhanguoce",
    "title": "战国策",
    "author": "西汉·刘向 编订",
    "category": "shi",
    "description": "战国纵横家说辞汇编三十三卷，记十二国策士权谋与游说。全本。",
    "dynasty": "西汉"
  },
  {
    "id": "hanshu",
    "title": "汉书",
    "author": "东汉·班固 撰",
    "category": "shi",
    "description": "中国第一部纪传体断代史，一百篇记西汉二百三十年史事。全本。",
    "dynasty": "东汉"
  },
  {
    "id": "houhanshu",
    "title": "后汉书",
    "author": "南朝宋·范晔 撰（梁·刘昭 补志）",
    "category": "shi",
    "description": "纪传体东汉史一百二十卷，与《史记》《汉书》《三国志》并称前四史。全本。",
    "dynasty": "南朝宋"
  },
  {
    "id": "sanguozhi",
    "title": "三国志",
    "author": "西晋·陈寿 撰（宋·裴松之 注）",
    "category": "shi",
    "description": "纪传体三国史六十五卷，魏蜀吴三志分国纪传。全本。",
    "dynasty": "西晋"
  },
  {
    "id": "sunzibingfa",
    "title": "孙子兵法",
    "author": "春秋·孙武 撰",
    "category": "zi",
    "description": "中国现存最早兵书十三篇，计战谋攻军形兵势虚实军争九变皆备。全本。",
    "dynasty": "春秋"
  },
  {
    "id": "guanzi",
    "title": "管子",
    "author": "旧题管仲 撰（战国齐稷下学者辑）",
    "category": "zi",
    "description": "齐国管仲学派著作总集八十六篇，兼含法家经言与轻重富国之术。全本。",
    "dynasty": "战国"
  },
  {
    "id": "hanfeizi",
    "title": "韩非子",
    "author": "战国·韩非 撰",
    "category": "zi",
    "description": "法家集大成之作五十五篇，法术势兼备，刑名参验之学。全本。",
    "dynasty": "战国"
  },
  {
    "id": "lvshichunqiu",
    "title": "吕氏春秋",
    "author": "战国末·吕不韦 门客辑",
    "category": "zi",
    "description": "杂家代表作二十六卷十二纪八览六论，汇九流之说备天地万物古今之事。全本。",
    "dynasty": "战国"
  },
  {
    "id": "yanzichunqiu",
    "title": "晏子春秋",
    "author": "战国·齐人辑晏婴言行",
    "category": "zi",
    "description": "记齐国名相晏婴谏诤行事八篇二百一十五章，先秦叙事散文代表。全本。",
    "dynasty": "战国"
  },
  {
    "id": "shishuoxinyu",
    "title": "世说新语",
    "author": "南朝宋·刘义庆 撰（梁·刘孝标 注）",
    "category": "zi",
    "description": "魏晋名士言行轶事笔记小说之祖，分德行言语等三十六门。全本。",
    "dynasty": "南朝宋"
  },
  {
    "id": "yanshijiaxun",
    "title": "颜氏家训",
    "author": "南北朝·颜之推 撰",
    "category": "zi",
    "description": "中国第一部系统家训二十篇，兼论字书音训与南北风俗。全本。",
    "dynasty": "南北朝"
  },
  {
    "id": "wenxuan",
    "title": "文选",
    "author": "南朝梁·昭明太子萧统 编（唐·李善 注本白文）",
    "category": "ji",
    "description": "中国现存最早诗文总集六十卷，选周代至梁代诗文七百余篇。全本。",
    "dynasty": "南朝梁"
  },
  {
    "id": "yutaixinyong",
    "title": "玉台新咏",
    "author": "南朝梁·徐陵 编",
    "category": "ji",
    "description": "继《诗经》《楚辞》后汉魏六朝诗歌总集十卷，《孔雀东南飞》始见于此。全本。",
    "dynasty": "南朝梁"
  },
  {
    "id": "huajianji",
    "title": "花间集",
    "author": "五代后蜀·赵崇祚 编",
    "category": "ji",
    "description": "中国第一部文人词总集十卷五百首，温韦以降十八家倚声填词之祖。全本。",
    "dynasty": "五代"
  },
  {
    "id": "yuefushiji",
    "title": "乐府诗集",
    "author": "北宋·郭茂倩 编",
    "category": "ji",
    "description": "乐府诗总集一百卷，郊庙至杂歌十二类，上古至五代乐府渊薮。全本。",
    "dynasty": "北宋"
  },
  {
    "id": "wenxindiaolong",
    "title": "文心雕龙",
    "author": "南朝梁·刘勰 撰",
    "category": "ji",
    "description": "中国第一部体系完备的文学理论巨著五十篇，体大思精笼罩群言。全本。",
    "dynasty": "南朝梁"
  },
  {
    "id": "caozijian",
    "title": "曹子建集",
    "author": "曹魏·曹植 撰",
    "category": "ji",
    "description": "建安之雄才陈思王诗文赋十卷，白马篇洛神赋七哀诗俱在其中。全本。",
    "dynasty": "曹魏"
  }
];

export function getBuiltinSpec(id: string): BuiltinBookSpec | undefined {
  return BUILTIN_CATALOG.find((b) => b.id === id);
}
