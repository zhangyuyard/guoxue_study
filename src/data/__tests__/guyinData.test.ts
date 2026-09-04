/**
 * 古音拟音库数据测试（P2-01 数据完整性冒烟）
 * 锁定：
 *   - JSON 可 require、_meta 存在且含来源/许可/署名/版本
 *   - 条目数 ≥ 1000（实测 3874，Baxter-Sagart 2015-10-13 全量去重后规模）
 *   - 全表格式合法：key 单简体汉字、mc/oc 非空、gloss 可选字符串
 *   - 抽查常见异读字（说/见/行/长）条目正确
 *   - 版本互指：_meta.version === GUYIN_DICT_VERSION
 */
import guyinData from '@/data/guyin-zi.json';
import { GUYIN_DICT_VERSION, GUYIN_ATTRIBUTION } from '@/services/GuyinService';

interface GuyinEntryJson {
  mc: string;
  oc: string;
  gloss?: string;
}

interface GuyinMetaJson {
  source: string;
  sourceUrl?: string;
  license: string;
  attribution: string;
  version: number;
  retrievedAt?: string;
  entries: number;
  skipped?: Record<string, number>;
}

interface GuyinFileJson {
  _meta: GuyinMetaJson;
  chars: Record<string, GuyinEntryJson>;
}

const data = guyinData as unknown as GuyinFileJson;
const chars = data.chars ?? {};

describe('guyin-zi.json：meta 与版本互指（P2-01）', () => {
  test('_meta 存在且含来源/许可/署名', () => {
    expect(data._meta).toBeTruthy();
    expect(typeof data._meta.source).toBe('string');
    expect(data._meta.source).toContain('Baxter');
    expect(data._meta.source).toContain('Sagart');
    expect(typeof data._meta.license).toBe('string');
    expect(data._meta.license.length).toBeGreaterThan(0);
    expect(data._meta.attribution).toBe(GUYIN_ATTRIBUTION);
  });

  test('版本互指：_meta.version 与运行时 GUYIN_DICT_VERSION 一致', () => {
    expect(data._meta.version).toBe(GUYIN_DICT_VERSION);
    expect(GUYIN_DICT_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('_meta.entries 与实际条目数一致', () => {
    expect(data._meta.entries).toBe(Object.keys(chars).length);
  });
});

describe('guyin-zi.json：数据规模与格式（P2-01）', () => {
  test('条目数 ≥ 1000（Baxter-Sagart 去重后实测 3874）', () => {
    expect(Object.keys(chars).length).toBeGreaterThanOrEqual(1000);
  });

  test('全表格式合法：key 单简体汉字、mc/oc 非空、gloss 非空字符串（可选）', () => {
    for (const [key, entry] of Object.entries(chars)) {
      expect(key).toMatch(/^[\u3400-\u9fff]$/u);
      expect(typeof entry.mc).toBe('string');
      expect(entry.mc.length).toBeGreaterThan(0);
      expect(typeof entry.oc).toBe('string');
      expect(entry.oc.length).toBeGreaterThan(0);
      // Baxter-Sagart 拟音恒带 * 前缀；官方源表仅「参」1 条写为 r̥ˤəʔ（源数据原样保留，
      // 不做修饰），故此处允许 * 前缀或小写转写两种形态
      expect(/^\*|^[a-zʔʕ°ʰʷˤl̥n̥m̥ŋ̥r̥t̥s̥d]/.test(entry.oc)).toBe(true);
      if (entry.gloss !== undefined) {
        expect(typeof entry.gloss).toBe('string');
        expect(entry.gloss.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('guyin-zi.json：抽查常见异读字（P2-01）', () => {
  test.each([
    ['说', 'sywet', '*l̥ot', 'speak, explain'],
    ['见', 'kenH', '*[k]ˤen-s', 'see (v.)'],
    ['行', 'haeng', '*Cə.[g]ˤraŋ', 'walk (v.)'],
    ['长', 'drjang', '*Cə-[N]-traŋ', 'long (adj.)'],
  ])('「%s」中古=%s / 上古=%s / 释义=%s', (char, mc, oc, gloss) => {
    const entry = chars[char];
    expect(entry).toBeTruthy();
    expect(entry?.mc).toBe(mc);
    expect(entry?.oc).toBe(oc);
    expect(entry?.gloss).toBe(gloss);
  });
});
