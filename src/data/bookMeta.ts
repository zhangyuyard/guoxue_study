/**
 * 书籍元数据（bookMeta）
 * 为书库 16 部内置经典提供朝代 / 体裁维度的元数据，供高级搜索（P2-10）筛选使用。
 *
 * 朝代口径（note 已逐书注明）：
 * - 老子著《道德经》于春秋末期 → 春秋
 * - 《论语》《大学》《中庸》《诗经》《周易》《左传》为儒家 / 占筮经典，通称「先秦」
 * - 《孟子》《庄子》《荀子》《墨子》著于战国 → 战国
 * - 《楚辞》以屈原（战国）为首、兼收汉代拟作 → 战国～汉
 * - 《史记》著于西汉武帝时 → 西汉
 * - 《文选》由南朝梁昭明太子萧统编选 → 南朝梁
 * - 《唐诗三百首》所收均为唐代诗作（通行本由清·蘅塘退士编选）→ 唐
 * - 《资治通鉴》由北宋司马光主持编纂 → 北宋
 *
 * 体裁口径（固定五类）：
 * - 经部：儒家经典（《四库全书》经部口径，含《孟子》《周易》《左传》）
 * - 史部：正史与编年史（《史记》《资治通鉴》归此）
 * - 子部：诸子百家（《四库全书》子部口径，《道德经》《庄子》《荀子》《墨子》归此）
 * - 集部：文学总集与作品（《楚辞》《文选》归此）
 * - 诗文选：诗文选本（《唐诗三百首》为选集，非原典，单列一类）
 */

/** 书籍体裁（固定五类，P2-10；史部为 2026-09 书库扩充新增维度） */
export type BookGenre = '经部' | '史部' | '子部' | '集部' | '诗文选';

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
  wenxuan: {
    dynasty: '南朝梁',
    genre: '集部',
    note: '昭明太子萧统（501—531）主持编选于南朝梁；《四库全书》归集部·总集类。',
  },
};

/** 体裁维度（固定五类，展示顺序固定） */
export const BOOK_GENRES: BookGenre[] = ['经部', '史部', '子部', '集部', '诗文选'];

/**
 * 朝代维度（去重后的固定展示顺序）。
 * 「先秦」为统称（涵盖西周至战国），置于最前；其余按时代先后排列。
 */
export const BOOK_DYNASTIES: string[] = [
  '先秦',
  '春秋',
  '战国',
  '战国～汉',
  '西汉',
  '南朝梁',
  '唐',
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
