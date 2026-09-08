/**
 * 书籍元数据（bookMeta）
 * 为书库 77 部内置经典提供朝代 / 体裁维度的元数据，供高级搜索（P2-10）筛选使用。
 *
 * 朝代口径（note 已逐书注明）：
 * - 老子著《道德经》于春秋末期 → 春秋
 * - 《论语》《大学》《中庸》《诗经》《周易》《左传》为儒家 / 占筮经典，通称「先秦」
 * - 《孟子》《庄子》《荀子》《墨子》著于战国 → 战国
 * - 《楚辞》以屈原（战国）为首、兼收汉代拟作 → 战国～汉
 * - 《史记》著于西汉武帝时 → 西汉
 * - 《文选》《千字文》由南朝梁人编撰 → 南朝梁
 * - 《唐诗三百首》所收均为唐代诗作（通行本由清·蘅塘退士编选）→ 唐
 * - 《宋词三百首》所收均为宋代词作（通行本由近人朱祖谋编选）→ 宋
 * - 《三字经》相传宋·王应麟撰、《百家姓》成于宋初 → 宋
 * - 《元曲》所收均为元代曲作 → 元
 * - 《朱子家训》《增广贤文》《幼学琼林》作者为明人 → 明
 * - 《古文观止》《弟子规》《声律启蒙》《笠翁对韵》编撰者为清人 → 清
 *
 * 体裁口径（固定七类）：
 * - 经部：儒家经典与蒙学（《四库全书》经部口径，含《孟子》《周易》《左传》及九部蒙书）
 * - 史部：正史与编年史（《史记》《资治通鉴》归此）
 * - 子部：诸子百家（《四库全书》子部口径，《道德经》《庄子》《荀子》《墨子》归此）
 * - 集部：文学总集与作品（《楚辞》《文选》《元曲》归此）
 * - 诗文选：诗文选本（《唐诗三百首》《宋词三百首》《古文观止》为选本，非原典，单列一类）
 * - 佛家：汉译佛经与禅宗著述（2026-09 书库道佛扩充单列一类）
 * - 蒙学：童蒙启蒙读物（三字经等九部蒙书单列一类，便于家长筛选）
 */

/** 书籍体裁（固定七类；「佛家」与「史部 / 蒙学」为 2026-09 书库扩充新增维度） */
export type BookGenre = '经部' | '史部' | '子部' | '集部' | '佛家' | '诗文选' | '蒙学';

/** 单部书的筛选元数据 */
export interface BookMetaEntry {
  /** 朝代（与 BOOK_DYNASTIES 中的取值一致） */
  dynasty: string;
  /** 体裁（与 BOOK_GENRES 中的取值一致） */
  genre: BookGenre;
  /** 口径说明（注明归类依据） */
  note?: string;
}

/** 书库 16 部内置经典的元数据注册表（key = Book.id） */
export const BOOK_META: Record<string, BookMetaEntry> = {
  daodejing: {
    dynasty: '春秋',
    genre: '子部',
    note: '老子著于春秋末期，一说成书于战国；体裁按《四库全书》归子部·道家类。',
  },
  lunyu: {
    dynasty: '先秦',
    genre: '经部',
    note: '孔子弟子及再传弟子编定，约成书于战国初期，通称先秦儒家经典。',
  },
  daxue: {
    dynasty: '先秦',
    genre: '经部',
    note: '《礼记》第四十二篇，相传曾子所作，成书于战国至西汉之间，按通称归先秦。',
  },
  zhongyong: {
    dynasty: '先秦',
    genre: '经部',
    note: '《礼记》第三十一篇，相传子思所作，按通称归先秦。',
  },
  mengzi: {
    dynasty: '战国',
    genre: '经部',
    note: '孟子及弟子著于战国；《四库全书》归经部·孟子类。',
  },
  zhuangzi: {
    dynasty: '战国',
    genre: '子部',
    note: '庄周及后学著于战国；《四库全书》归子部·道家类。',
  },
  xunzi: {
    dynasty: '战国',
    genre: '子部',
    note: '荀况著于战国；《四库全书》归子部·儒家类。',
  },
  shijing: {
    dynasty: '先秦',
    genre: '经部',
    note: '我国最早诗歌总集，收录西周至春秋诗篇，按通称归先秦；《四库全书》归经部。',
  },
  chuci: {
    dynasty: '战国～汉',
    genre: '集部',
    note: '以屈原（战国）作品为首，兼收汉代拟作；《四库全书》归集部·楚辞类。',
  },
  tangshi: {
    dynasty: '唐',
    genre: '诗文选',
    note: '所收均为唐代诗作；通行选本《唐诗三百首》由清·蘅塘退士编选，故朝代按作品归唐。',
  },
  zhouyi: {
    dynasty: '先秦',
    genre: '经部',
    note: '卜筮成书于西周至春秋，《易传》成于战国，通称先秦；《四库全书》列经部之首。',
  },
  zuozhuan: {
    dynasty: '先秦',
    genre: '经部',
    note: '相传左丘明作，记春秋史事，成书于战国初期；《四库全书》归经部·春秋类。',
  },
  shiji: {
    dynasty: '西汉',
    genre: '史部',
    note: '司马迁著于西汉武帝时；《四库全书》归史部·正史类。',
  },
  tongjian: {
    dynasty: '北宋',
    genre: '史部',
    note: '司马光主持编纂于北宋元丰年间；《四库全书》归史部·编年类。',
  },
  mozi: {
    dynasty: '战国',
    genre: '子部',
    note: '墨翟及墨家后学著于战国；《四库全书》归子部·墨家类。',
  },
  songci: {
    dynasty: '宋',
    genre: '诗文选',
    note: '所收均为宋代词作；通行选本《宋词三百首》由近人朱祖谋编选，故朝代按作品归宋。',
  },
  yuanqu: {
    dynasty: '元',
    genre: '集部',
    note: '元代曲家散曲与剧曲套数总集，按作品时代归元；归集部·总集类口径。',
  },
  guwenguanzhi: {
    dynasty: '清',
    genre: '诗文选',
    note: '清·吴楚材、吴调侯叔侄编选历代散文选本，成书于清康熙年间，故按编者归清。',
  },
  sanzijing: {
    dynasty: '宋',
    genre: '蒙学',
    note: '相传宋·王应麟撰（一说宋末区适子），三字韵语蒙书之首，归蒙学类。',
  },
  baijiaxing: {
    dynasty: '宋',
    genre: '蒙学',
    note: '成书于北宋初的姓氏韵文蒙书，归蒙学类。',
  },
  qianziwen: {
    dynasty: '南朝梁',
    genre: '蒙学',
    note: '南朝梁·周兴嗣以一千个不重复汉字编成的韵文蒙书，归蒙学类。',
  },
  dizigui: {
    dynasty: '清',
    genre: '蒙学',
    note: '清·李毓秀据《论语》学而篇义理编成的童蒙行为规范，归蒙学类。',
  },
  zhuzijiaxun: {
    dynasty: '明',
    genre: '蒙学',
    note: '朱用纯（朱柏庐）生于明末、成书于明末清初，按作者朝代通称归明，归蒙学类。',
  },
  zengguangxianwen: {
    dynasty: '明',
    genre: '蒙学',
    note: '明代辑成的谚语格言集（清代重刊增补），按初辑朝代归明，归蒙学类。',
  },
  shenglvqimeng: {
    dynasty: '清',
    genre: '蒙学',
    note: '清·车万育撰声韵对偶蒙书，归蒙学类。',
  },
  liwengduiyun: {
    dynasty: '清',
    genre: '蒙学',
    note: '清·李渔撰声韵对偶蒙书，与《声律启蒙》齐名，归蒙学类。',
  },
  youxueqionglin: {
    dynasty: '明',
    genre: '蒙学',
    note: '明·程登吉撰百科常识蒙书（清·邹圣脉增补），按原作者朝代归明，归蒙学类。',
  },
  // ============ 2026-09 道家 / 佛家扩充 29 部 ============
  xinjing: {
    dynasty: '唐',
    genre: '佛家',
    note: '唐·玄奘译般若纲要，二百六十字；体裁单列佛家类。',
  },
  jingangjing: {
    dynasty: '后秦',
    genre: '佛家',
    note: '后秦弘始年间鸠摩罗什译，按译经朝代归后秦，归佛家类。',
  },
  emituofojing: {
    dynasty: '后秦',
    genre: '佛家',
    note: '后秦·鸠摩罗什译净土要典，按译经朝代归后秦，归佛家类。',
  },
  wuliangshoujing: {
    dynasty: '曹魏',
    genre: '佛家',
    note: '曹魏嘉平年间康僧铠译，按译经朝代归曹魏，归佛家类。',
  },
  guanwuliangshoujing: {
    dynasty: '刘宋',
    genre: '佛家',
    note: '刘宋元嘉年间畺良耶舍译，按译经朝代归刘宋，归佛家类。',
  },
  yaoshijing: {
    dynasty: '隋',
    genre: '佛家',
    note: '隋大业年间达摩笈多译，按译经朝代归隋，归佛家类。',
  },
  fajujing: {
    dynasty: '三国',
    genre: '佛家',
    note: '三国吴黄武年间维祚难等译，按译经朝代归三国，归佛家类。',
  },
  baiyujing: {
    dynasty: '南朝齐',
    genre: '佛家',
    note: '南朝齐永明年间求那毗地译，按译经朝代归南朝齐，归佛家类。',
  },
  sishierzhangjing: {
    dynasty: '东汉',
    genre: '佛家',
    note: '相传东汉永平年间迦叶摩腾、竺法兰译，按译经朝代归东汉，归佛家类。',
  },
  yuanjuejing: {
    dynasty: '唐',
    genre: '佛家',
    note: '唐·佛陀多罗译，按译经朝代归唐，归佛家类。',
  },
  yijiaojing: {
    dynasty: '后秦',
    genre: '佛家',
    note: '后秦·鸠摩罗什译佛涅槃遗诫，按译经朝代归后秦，归佛家类。',
  },
  badarenjuejing: {
    dynasty: '东汉',
    genre: '佛家',
    note: '东汉·安世高译，按译经朝代归东汉，归佛家类。',
  },
  weimojing: {
    dynasty: '后秦',
    genre: '佛家',
    note: '后秦·鸠摩罗什译，按译经朝代归后秦，归佛家类。',
  },
  fahuajing: {
    dynasty: '后秦',
    genre: '佛家',
    note: '后秦弘始年间鸠摩罗什译二十八品，按译经朝代归后秦，归佛家类。',
  },
  lengyanjing: {
    dynasty: '唐',
    genre: '佛家',
    note: '唐神龙年间般剌蜜帝译，按译经朝代归唐，归佛家类。',
  },
  dizangjing: {
    dynasty: '唐',
    genre: '佛家',
    note: '唐·实叉难陀译，按译经朝代归唐，归佛家类。',
  },
  liuzutanjing: {
    dynasty: '唐',
    genre: '佛家',
    note: '唐·门人法海集记六祖说法，按成书朝代归唐，归佛家类。',
  },
  qingjingjing: {
    dynasty: '唐',
    genre: '子部',
    note: '旧题太上老君说，通行本出于唐，按出世朝代归唐；《四库》归子部·道家类。',
  },
  yinfujing: {
    dynasty: '唐',
    genre: '子部',
    note: '旧题黄帝撰，传唐·李筌得于嵩山虎口岩，按出世朝代归唐，归子部·道家类。',
  },
  guanyinzi: {
    dynasty: '先秦',
    genre: '子部',
    note: '旧题周·关令尹喜著（今本或出唐前），按托名作者归先秦，归子部·道家类。',
  },
  guiguzi: {
    dynasty: '战国',
    genre: '子部',
    note: '旧题战国·鬼谷子著，《四库全书》归子部·纵横家类。',
  },
  liezi: {
    dynasty: '战国',
    genre: '子部',
    note: '战国·列御寇著（今本经魏晋人整编），《四库全书》归子部·道家类。',
  },
  heguanzi: {
    dynasty: '战国',
    genre: '子部',
    note: '战国·鹖冠子著（宋·陆佃解），《四库全书》归子部·杂家类。',
  },
  huainanzi: {
    dynasty: '西汉',
    genre: '子部',
    note: '西汉淮南王刘安召集门客撰，东汉许慎注；《四库全书》归子部·杂家类。',
  },
  baopuzi: {
    dynasty: '东晋',
    genre: '子部',
    note: '东晋·葛洪撰，按作者朝代归东晋；《四库全书》归子部·道家类。',
  },
  huashu: {
    dynasty: '五代',
    genre: '子部',
    note: '五代·谭峭撰，按作者朝代归五代；《四库全书》归子部·道家类。',
  },
  wuzhenpian: {
    dynasty: '北宋',
    genre: '子部',
    note: '北宋·张伯端撰内丹南宗祖经，按作者朝代归北宋，归子部·道家类。',
  },
  zuowanglun: {
    dynasty: '唐',
    genre: '子部',
    note: '唐·司马承祯撰，按作者朝代归唐，归子部·道家类。',
  },
  ganyingpian: {
    dynasty: '宋',
    genre: '子部',
    note: '宋·李昌龄传、郑清之赞，按传赞者朝代归宋，归子部·道家类。',
  },
  // ============ 2026-09 经史子集 + 诗词歌赋扩充 21 部 ============
  xiaojing: {
    dynasty: '先秦',
    genre: '经部',
    note: '旧题孔门后学辑孔子孝道之论，《十三经》之一，归经部。',
  },
  erya: {
    dynasty: '先秦',
    genre: '经部',
    note: '先秦至西汉学者缀辑的训诂词典，《十三经》之一，归经部。',
  },
  liji: {
    dynasty: '西汉',
    genre: '经部',
    note: '西汉·戴圣编定四十九篇，《十三经》之一，归经部。',
  },
  guoyu: {
    dynasty: '先秦',
    genre: '史部',
    note: '旧题左丘明撰国别体史书，成书于战国初期，归史部。',
  },
  zhanguoce: {
    dynasty: '西汉',
    genre: '史部',
    note: '西汉·刘向编订战国纵横家说辞，按编者朝代归西汉，归史部。',
  },
  hanshu: {
    dynasty: '东汉',
    genre: '史部',
    note: '东汉·班固撰断代史，按作者朝代归东汉；《四库全书》归史部·正史类。',
  },
  houhanshu: {
    dynasty: '南朝宋',
    genre: '史部',
    note: '南朝宋·范晔撰，按作者朝代归南朝宋；《四库全书》归史部·正史类。',
  },
  sanguozhi: {
    dynasty: '西晋',
    genre: '史部',
    note: '西晋·陈寿撰，按作者朝代归西晋；《四库全书》归史部·正史类。',
  },
  sunzibingfa: {
    dynasty: '春秋',
    genre: '子部',
    note: '春秋·孙武撰，《四库全书》归子部·兵家类。',
  },
  guanzi: {
    dynasty: '战国',
    genre: '子部',
    note: '旧题管仲撰，实为战国齐稷下学者辑，《四库全书》归子部·法家类。',
  },
  hanfeizi: {
    dynasty: '战国',
    genre: '子部',
    note: '战国·韩非撰，《四库全书》归子部·法家类。',
  },
  lvshichunqiu: {
    dynasty: '战国',
    genre: '子部',
    note: '战国末吕不韦门客辑，《四库全书》归子部·杂家类。',
  },
  yanzichunqiu: {
    dynasty: '战国',
    genre: '子部',
    note: '战国时齐人辑晏婴言行成书，归子部。',
  },
  shishuoxinyu: {
    dynasty: '南朝宋',
    genre: '子部',
    note: '南朝宋·刘义庆撰，按作者朝代归南朝宋；《四库全书》归子部·小说家类。',
  },
  yanshijiaxun: {
    dynasty: '南北朝',
    genre: '子部',
    note: '颜之推著于南北朝末期（齐周隋间），按作者活动时代归南北朝，归子部。',
  },
  wenxuan: {
    dynasty: '南朝梁',
    genre: '集部',
    note: '南朝梁·昭明太子萧统编选，按编者朝代归南朝梁；《四库全书》归集部·总集类。',
  },
  yutaixinyong: {
    dynasty: '南朝梁',
    genre: '集部',
    note: '南朝梁·徐陵编选汉魏六朝诗，按编者朝代归南朝梁，归集部·总集类。',
  },
  huajianji: {
    dynasty: '五代',
    genre: '集部',
    note: '五代后蜀·赵崇祚编词总集，按编者朝代归五代，归集部·词总集类。',
  },
  yuefushiji: {
    dynasty: '北宋',
    genre: '集部',
    note: '北宋·郭茂倩编乐府诗总集，按编者朝代归北宋，归集部·总集类。',
  },
  wenxindiaolong: {
    dynasty: '南朝梁',
    genre: '集部',
    note: '南朝梁·刘勰撰文学理论巨著，按作者朝代归南朝梁；《四库全书》归集部·诗文评类。',
  },
  caozijian: {
    dynasty: '曹魏',
    genre: '集部',
    note: '曹魏·陈思王曹植撰别集，按作者朝代归曹魏，归集部·别集类。',
  },
};

/** 体裁维度（固定七类，展示顺序固定） */
export const BOOK_GENRES: BookGenre[] = ['经部', '史部', '子部', '集部', '佛家', '诗文选', '蒙学'];

/**
 * 朝代维度（去重后的固定展示顺序）。
 * 「先秦」为统称（涵盖西周至战国），置于最前；其余按时代先后排列
 * （「北宋」为历史追加项，置于末尾保持既有顺序兼容）。
 */
export const BOOK_DYNASTIES: string[] = [
  '先秦',
  '春秋',
  '战国',
  '战国～汉',
  '西汉',
  '东汉',
  '曹魏',
  '三国',
  '西晋',
  '东晋',
  '后秦',
  '刘宋',
  '南朝宋',
  '南朝齐',
  '南朝梁',
  '南北朝',
  '隋',
  '唐',
  '五代',
  '宋',
  '元',
  '明',
  '清',
  '北宋',
];

/** 读取单部书的元数据（未登记的书籍 ID 返回 undefined） */
export function getBookMeta(bookId: string): BookMetaEntry | undefined {
  return BOOK_META[bookId];
}

/** 已登记元数据的书籍 ID 列表（注册表键序） */
export const BOOK_META_IDS: string[] = Object.keys(BOOK_META);

export default {
  BOOK_META,
  BOOK_META_IDS,
  BOOK_GENRES,
  BOOK_DYNASTIES,
  getBookMeta,
};
