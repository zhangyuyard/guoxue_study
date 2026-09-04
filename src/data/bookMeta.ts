/**
 * 书籍元数据（bookMeta）
 * 为书库 10 部内置经典提供朝代 / 体裁维度的元数据，供高级搜索（P2-10）筛选使用。
 *
 * 朝代口径（note 已逐书注明）：
 * - 老子著《道德经》于春秋末期 → 春秋
 * - 《论语》《大学》《中庸》《诗经》为儒家经典 / 最早诗歌总集，通称「先秦」
 * - 《孟子》《庄子》《荀子》著于战国 → 战国
 * - 《楚辞》以屈原（战国）为首、兼收汉代拟作 → 战国～汉
 * - 《唐诗三百首》所收均为唐代诗作（通行本由清·蘅塘退士编选）→ 唐
 *
 * 体裁口径（固定四类）：
 * - 经部：儒家经典（《四库全书》经部口径，含《孟子》）
 * - 子部：诸子百家（《四库全书》子部口径，《道德经》《庄子》《荀子》归此）
 * - 集部：楚辞类文学作品
 * - 诗文选：诗文选本（《唐诗三百首》为选集，非原典，单列一类）
 */

/** 书籍体裁（固定四类，P2-10） */
export type BookGenre = '经部' | '子部' | '集部' | '诗文选';

/** 单部书的筛选元数据 */
export interface BookMetaEntry {
  /** 朝代（与 BOOK_DYNASTIES 中的取值一致） */
  dynasty: string;
  /** 体裁（与 BOOK_GENRES 中的取值一致） */
  genre: BookGenre;
  /** 口径说明（注明归类依据） */
  note?: string;
}

/** 书库 10 部内置经典的元数据注册表（key = Book.id） */
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
};

/** 体裁维度（固定四类，展示顺序固定） */
export const BOOK_GENRES: BookGenre[] = ['经部', '子部', '集部', '诗文选'];

/**
 * 朝代维度（去重后的固定展示顺序）。
 * 「先秦」为统称（涵盖西周至战国），置于最前；其余按时代先后排列。
 */
export const BOOK_DYNASTIES: string[] = ['先秦', '春秋', '战国', '战国～汉', '唐'];

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
