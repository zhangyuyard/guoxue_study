/**
 * 异体字关联表数据测试（B3 数据扩容）
 * 锁定：
 *   - 组数 ≥ 150（人工种子 47 组 + Unihan 生成组）
 *   - 数据格式与消费端兼容（standard 单字、variants 非空单字数组、note 非空）
 *   - 人工种子 47 组全部保留（build-variant-chars.mjs 生成时在前且内容不变）
 *   - 全表内每个异体字只归属一个标准字（与 yitiReverse 首条命中语义一致）
 *   - 抽查 5 组在 10 部书正文中真实出现（standard 或 variant 至少一侧命中）
 */
import yitiData from '@/data/yiti-zi.json';
import seedData from '../../../scripts/yiti-seed.json';
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
import type { Chapter } from '@/types';

interface YitiGroup {
  standard: string;
  variants: string[];
  note: string;
}

const groups = yitiData.groups as unknown as YitiGroup[];

/** 10 部书全部正文字符集（含章节标题） */
function collectTextChars(): Set<string> {
  const books = [lunyu, daodejing, daxue, zhongyong, tangshi, mengzi, zhuangzi, shijing, xunzi, chuci];
  const chars = new Set<string>();
  for (const book of books) {
    for (const chapter of (book as { chapters: Chapter[] }).chapters) {
      for (const c of chapter.title ?? '') chars.add(c);
      for (const seg of chapter.segments ?? []) {
        for (const c of seg.text) chars.add(c);
      }
    }
  }
  return chars;
}

describe('yiti-zi.json：数据规模与格式（B3）', () => {
  test('组数 ≥ 150（47 组人工种子 + Unihan 生成组）', () => {
    expect(groups.length).toBeGreaterThanOrEqual(150);
  });

  test('每组格式合法：standard 单字、variants 非空单字数组、note 非空', () => {
    for (const g of groups) {
      expect(g.standard).toMatch(/^[\u3400-\u9fff]$/u);
      expect(Array.isArray(g.variants)).toBe(true);
      expect(g.variants.length).toBeGreaterThan(0);
      for (const v of g.variants) {
        expect(v).toMatch(/^[\u3400-\u9fff]$/u);
      }
      expect(typeof g.note).toBe('string');
      expect(g.note.length).toBeGreaterThan(0);
    }
  });

  test('无字符同时归属多个组（异体字唯一归属，避免 yitiReverse 二义）', () => {
    const owner = new Map<string, string>();
    for (const g of groups) {
      for (const c of [g.standard, ...g.variants]) {
        if (owner.has(c) && owner.get(c) !== g.standard) {
          throw new Error(`字符「${c}」同时出现在以「${owner.get(c)}」与「${g.standard}」为标准字的组中`);
        }
        owner.set(c, g.standard);
      }
    }
  });

  test('生成组 note 注明 Unihan 来源字段（可溯源）', () => {
    const generated = groups.filter(
      (g) => !seedData.groups.some((s: YitiGroup) => s.standard === g.standard),
    );
    // 生成组确有规模（扩容生效）
    expect(generated.length).toBeGreaterThanOrEqual(100);
    for (const g of generated) {
      expect(g.note).toMatch(/Unihan k(ZVariant|SpecializedSemanticVariant|TraditionalVariant|SimplifiedVariant)/);
    }
  });
});

describe('yiti-zi.json：人工种子保留（B3）', () => {
  test('scripts/yiti-seed.json 的 47 组原样保留在产出文件前部', () => {
    const seedGroups = seedData.groups as unknown as YitiGroup[];
    expect(seedGroups.length).toBe(47);
    for (let i = 0; i < seedGroups.length; i += 1) {
      expect(groups[i].standard).toBe(seedGroups[i].standard);
      expect(groups[i].variants).toEqual(seedGroups[i].variants);
      expect(groups[i].note).toBe(seedGroups[i].note);
    }
  });

  test('既有反向查询场景不受影响（峯 → 峰 / 羣 → 群）', () => {
    const reverse = new Map<string, string>();
    for (const g of groups) {
      for (const v of g.variants) {
        if (!reverse.has(v)) reverse.set(v, g.standard);
      }
    }
    expect(reverse.get('峯')).toBe('峰');
    expect(reverse.get('羣')).toBe('群');
    expect(reverse.get('淚')).toBe('泪');
  });
});

describe('yiti-zi.json：正文真实出现抽查（B3）', () => {
  const textChars = collectTextChars();

  test('10 部书正文非空（抽查前置条件）', () => {
    expect(textChars.size).toBeGreaterThan(1000);
  });

  test('抽查 5 组（含 Unihan 生成组）：standard 或 variant 至少一侧出现在真实正文中', () => {
    const textChars2 = textChars;
    // 固定取样：种子组（群/羣）+ 生成组区间内 4 组（覆盖 ZVariant / SpecializedSemantic / Traditional 来源）
    const pickIdx = [1, 47, 100, 130, 160, groups.length - 1];
    for (const i of pickIdx) {
      const g = groups[i];
      expect(g).toBeDefined();
      const hit = [g.standard, ...g.variants].some((c) => textChars2.has(c));
      expect(hit).toBe(true);
    }
  });

  test('全部 Unihan 生成组的「正文交集」不变量成立（构建期筛选项不回退）', () => {
    for (const g of groups) {
      // 种子组为人工校订（不做正文交集过滤），仅约束 Unihan 生成组
      if (g.note.startsWith('Unihan')) {
        const hit = [g.standard, ...g.variants].some((c) => textChars.has(c));
        expect(hit).toBe(true);
      }
    }
  });
});
