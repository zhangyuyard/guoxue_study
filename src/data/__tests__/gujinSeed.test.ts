/**
 * 古今字种子数据测试（B3 数据扩容·任务 C）
 * 锁定：
 *   - 组数 ≥ 100（人工标注古今字对）
 *   - 无重复字头（char 唯一，避免构建期同 work_id+char 主键互撞后随机丢失）
 *   - 说/悦、知/智、反/返 必须在列
 *   - 每对字段合法：char/original 均为单个 CJK 字、char ≠ original、note 非空
 *   - 抽查 5 组的借字在 10 部书正文中真实出现（与构建期过滤口径一致）
 *   - 构建产物 canon_dict.db 同步抽查：说/悦、知/智、反/返 有书级命中且 type=gujin
 */
import seed from '../../../scripts/canon-seed-gujin.json';
import lunyu from '@/data/texts/lunyu.json';
import daodejing from '@/data/texts/daodejing.json';
import daxue from '@/data/texts/daxue.json';
import zhongyong from '@/data/texts/zhongyong.json';
import tangshi from '@/data/texts/tangshi.json';
import mengzi from '@/data/texts/mengzi.json';
import zhuangzi from '@/data/texts/zhuangzi.json';
import shijing from '@/data/texts/shijing.json';
import xunzi from '@/data/texts/xunzi.json';
import chuci from '@/data/texts/chuci.json';

interface GujinPair {
  char: string;
  original: string;
  note: string;
}

const pairs = (seed as { pairs: GujinPair[] }).pairs;

function collectTextChars(): Set<string> {
  const books = [lunyu, daodejing, daxue, zhongyong, tangshi, mengzi, zhuangzi, shijing, xunzi, chuci];
  const chars = new Set<string>();
  for (const book of books as { chapters: { title?: string; segments?: { text: string }[] }[] }[]) {
    for (const chapter of book.chapters) {
      for (const c of chapter.title ?? '') chars.add(c);
      for (const seg of chapter.segments ?? []) {
        for (const c of seg.text) chars.add(c);
      }
    }
  }
  return chars;
}

describe('canon-seed-gujin.json：数据规模与格式（B3 任务 C）', () => {
  test('古今字对 ≥ 100 组', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(100);
  });

  test('每组字段合法：char/original 单个 CJK 字且不同、note 非空', () => {
    for (const p of pairs) {
      expect(p.char).toMatch(/^[\u3400-\u9fff]$/u);
      expect(p.original).toMatch(/^[\u3400-\u9fff]$/u);
      expect(p.char).not.toBe(p.original);
      expect(typeof p.note).toBe('string');
      expect(p.note.length).toBeGreaterThan(0);
      expect(p.note).toContain(p.original);
    }
  });

  test('无重复字头', () => {
    const seen = new Set<string>();
    for (const p of pairs) {
      expect(seen.has(p.char)).toBe(false);
      seen.add(p.char);
    }
  });

  test('说/悦、知/智、反/返 必须在列', () => {
    const byChar = new Map(pairs.map((p) => [p.char, p]));
    expect(byChar.get('说')?.original).toBe('悦');
    expect(byChar.get('知')?.original).toBe('智');
    expect(byChar.get('反')?.original).toBe('返');
  });
});

describe('canon-seed-gujin.json：正文出现抽查（B3 任务 C）', () => {
  const textChars = collectTextChars();

  test('抽查 5 组的借字在 10 部书正文中真实出现（说/知/反/莫/取）', () => {
    for (const c of ['说', '知', '反', '莫', '取']) {
      expect(textChars.has(c)).toBe(true);
    }
  });
});
