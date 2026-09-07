/**
 * 书籍元数据完整性测试（P2-10 bookMeta）
 * 锁定：
 * - 16 部内置经典元数据全覆盖（id 集合精确匹配）
 * - genre 仅取固定四类、dynasty 非空且属于聚合维度列表
 * - 聚合维度：朝代去重排序、体裁固定四类
 * - 元数据登记的书籍均真实存在于 TextLibraryService（与注册表一致）
 */
import { TextLibraryService } from '@/services/TextLibraryService';

import {
  BOOK_DYNASTIES,
  BOOK_GENRES,
  BOOK_META,
  BOOK_META_IDS,
  getBookMeta,
} from '@/data/bookMeta';

/** 书库 16 部（与 TextLibraryService.RAW_BOOKS 一致） */
const LIBRARY_IDS = [
  'daodejing',
  'lunyu',
  'daxue',
  'zhongyong',
  'mengzi',
  'zhuangzi',
  'shijing',
  'xunzi',
  'chuci',
  'tangshi',
  'zhouyi',
  'zuozhuan',
  'shiji',
  'tongjian',
  'mozi',
  'wenxuan',
];

describe('bookMeta 元数据完整性', () => {
  test('16 部书全覆盖：注册表键集合与书库完全一致', () => {
    expect(BOOK_META_IDS).toHaveLength(16);
    expect([...BOOK_META_IDS].sort()).toEqual([...LIBRARY_IDS].sort());
  });

  test('每部书 dynasty 非空且属于聚合维度列表', () => {
    for (const id of BOOK_META_IDS) {
      const meta = BOOK_META[id];
      expect(meta.dynasty.length).toBeGreaterThan(0);
      expect(BOOK_DYNASTIES).toContain(meta.dynasty);
    }
  });

  test('每部书 genre 合法（仅固定四类）', () => {
    for (const id of BOOK_META_IDS) {
      expect(BOOK_GENRES).toContain(BOOK_META[id].genre);
    }
  });

  test('体裁固定五类：经部 / 史部 / 子部 / 集部 / 诗文选', () => {
    expect(BOOK_GENRES).toEqual(['经部', '史部', '子部', '集部', '诗文选']);
  });

  test('朝代维度去重且与各书取值一一对应（无冗余、无缺失）', () => {
    const actual = Array.from(new Set(BOOK_META_IDS.map((id) => BOOK_META[id].dynasty)));
    // BOOK_DYNASTIES 不应有实际不存在的朝代
    for (const dynasty of BOOK_DYNASTIES) {
      expect(actual).toContain(dynasty);
    }
    // 实际出现的朝代都应在维度列表中（去重）
    for (const dynasty of actual) {
      expect(BOOK_DYNASTIES).toContain(dynasty);
      expect(BOOK_DYNASTIES.filter((d) => d === dynasty)).toHaveLength(1);
    }
  });

  test('每部书 note 口径说明非空', () => {
    for (const id of BOOK_META_IDS) {
      expect(BOOK_META[id].note?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('getBookMeta：命中返回元数据，未登记 ID 返回 undefined', () => {
    expect(getBookMeta('daodejing')).toBeDefined();
    expect(getBookMeta('daodejing')!.genre).toBe('子部');
    expect(getBookMeta('user-xxx')).toBeUndefined();
    expect(getBookMeta('not-exist')).toBeUndefined();
  });

  test('元数据登记的书籍均可经 TextLibraryService 端到端加载（注册表一致性）', () => {
    for (const id of BOOK_META_IDS) {
      const res = TextLibraryService.getBook(id);
      expect(res.success).toBe(true);
      expect(res.data!.chapters.length).toBeGreaterThan(0);
    }
  });
});
