/**
 * PinyinService 字典域扩展单测（QA 补充覆盖）
 * 验证 §8.6 兼容性铁律与 T02 验收标准 2/3：
 *   - setExternalReadingProvider(null) 后 annotate 输出与无字典时代完全一致（快照级对比）
 *   - provider.resolve 命中优先于内置规则库（仲裁顺序）
 *   - provider.resolve 返回 null 回退内置规则库
 *   - getPolyphoneReadings = 内置 ∪ provider.getReadings 去重（且返回副本）
 *   - 现有导出签名（annotate/resolvePolyphone/getPolyphoneReadings/isRare）不变
 */
import type { PinyinAnnotation } from '@/types';
import {
  annotate,
  getExternalReadingProvider,
  getReadingOverrideProvider,
  getPolyphoneReadings,
  isRareChar,
  resolvePolyphone,
  setExternalReadingProvider,
  setReadingOverrideProvider,
  type ReadingProvider,
} from '@/services/PinyinService';

/** 取某字的注音项 */
function pinyinOf(anns: PinyinAnnotation[], char: string): string {
  const hit = anns.find((a) => a.char === char);
  if (!hit) {
    throw new Error(`未找到「${char}」的注音项`);
  }
  return hit.pinyin;
}

const TEXT = '学而时习之，不亦说乎';

afterAll(() => {
  setExternalReadingProvider(null);
  setReadingOverrideProvider(null);
});

describe('PinyinService 导出签名兼容（§8.6）', () => {
  test('现有四个导出仍为函数且可直调', () => {
    expect(typeof annotate).toBe('function');
    expect(typeof resolvePolyphone).toBe('function');
    expect(typeof getPolyphoneReadings).toBe('function');
    expect(typeof isRareChar).toBe('function');
    // 基本行为抽查：内置规则库判音不受本次改动影响
    expect(resolvePolyphone('说', '不亦说乎')).toBe('yuè');
    expect(isRareChar('龘')).toBe(true);
    expect(isRareChar('学')).toBe(false);
    expect(annotate('学', 'off')).toEqual({ success: true, data: [] });
  });
});

describe('仲裁注入与向后兼容', () => {
  const baseline = annotate(TEXT, 'full');

  test('前置基准：无 provider 时「说」由内置规则库判为 yuè', () => {
    expect(getExternalReadingProvider()).toBeNull();
    expect(baseline.success).toBe(true);
    expect(pinyinOf(baseline.data!, '说')).toBe('yuè');
  });

  test('provider.resolve 命中优先于内置规则库（仲裁最高级）', () => {
    const provider: ReadingProvider = {
      getReadings: () => [],
      resolve: (char, context) => (char === '说' && context.includes('说乎') ? 'shuì' : null),
    };
    setExternalReadingProvider(provider);
    const res = annotate(TEXT, 'full');
    expect(pinyinOf(res.data!, '说')).toBe('shuì');
    // 其他字不受影响
    expect(pinyinOf(res.data!, '学')).toBe(pinyinOf(baseline.data!, '学'));
    expect(pinyinOf(res.data!, '习')).toBe(pinyinOf(baseline.data!, '习'));
  });

  test('provider.resolve 返回 null → 回退内置规则库（行为与基准一致）', () => {
    const provider: ReadingProvider = {
      getReadings: () => [],
      resolve: () => null,
    };
    setExternalReadingProvider(provider);
    const res = annotate(TEXT, 'full');
    expect(res.data).toEqual(baseline.data);
  });

  test('setExternalReadingProvider(null) 后 annotate 输出与无字典时代完全一致', () => {
    // 先注入一个会改变结果的 provider，再移除
    const provider: ReadingProvider = {
      getReadings: () => ['shuì'],
      resolve: () => 'shuì',
    };
    setExternalReadingProvider(provider);
    expect(annotate(TEXT, 'full').data).not.toEqual(baseline.data);

    setExternalReadingProvider(null);
    expect(getExternalReadingProvider()).toBeNull();
    expect(annotate(TEXT, 'full').data).toEqual(baseline.data);
  });
});

describe('getPolyphoneReadings 并集（T02 验收标准 3）', () => {
  afterAll(() => {
    setExternalReadingProvider(null);
  });

  test('无 provider：返回内置候选读音副本', () => {
    setExternalReadingProvider(null);
    expect(getPolyphoneReadings('乐')).toEqual(['lè', 'yuè', 'yào', 'lào']);
  });

  test('provider 提供额外读音时返回并集去重（内置在前）', () => {
    const provider: ReadingProvider = {
      getReadings: (char) => (char === '乐' ? ['yuè', 'shuì'] : []),
      resolve: () => null,
    };
    setExternalReadingProvider(provider);
    // yuè 去重，shuì 追加在尾部
    expect(getPolyphoneReadings('乐')).toEqual(['lè', 'yuè', 'yào', 'lào', 'shuì']);
    // provider 未提供读音的字不受影响
    expect(getPolyphoneReadings('说')).toEqual(['shuō', 'shuì', 'yuè']);
  });

  test('返回副本：外部篡改不影响后续调用', () => {
    const provider: ReadingProvider = {
      getReadings: (char) => (char === '乐' ? ['shuì'] : []),
      resolve: () => null,
    };
    setExternalReadingProvider(provider);
    const r1 = getPolyphoneReadings('乐');
    r1.push('篡改项');
    r1[0] = '篡改项';
    expect(getPolyphoneReadings('乐')).toEqual(['lè', 'yuè', 'yào', 'lào', 'shuì']);
  });
});

describe('繁体文本注解（修复：繁体字误判生僻字→满屏下划线）', () => {
  const TRAD = '學而時習之，不亦說乎';
  const res = annotate(TRAD, 'full');

  test('前置：注解成功且字数与输入一致', () => {
    expect(res.success).toBe(true);
    expect(res.data!.length).toBe(Array.from(TRAD).length);
  });

  test('繁体字不被误判为生僻字（否则会套下划线样式）', () => {
    for (const c of ['學', '說', '時', '習', '而']) {
      const hit = res.data!.find((a) => a.char === c);
      expect(hit).toBeDefined();
      expect(hit!.isRare).toBe(false);
    }
  });

  test('繁体字多音字识别正常（說 应为多音字）', () => {
    const shuo = res.data!.find((a) => a.char === '說')!;
    expect(shuo.isPolyphone).toBe(true);
  });

  test('繁体字读音正确（學→xué）', () => {
    expect(pinyinOf(res.data!, '學')).toBe('xué');
  });

  test('繁体下多音字语境规则按简体匹配（說乎→yuè，而非回退 shuō）', () => {
    // 修复前：logicText 未归一化，繁体「說乎」匹配不到规则 pattern「说乎」，回退 default=shuō
    expect(pinyinOf(res.data!, '說')).toBe('yuè');
  });
});

describe('用户读音纠正注入点（setReadingOverrideProvider）', () => {
  afterEach(() => {
    setReadingOverrideProvider(null);
    setExternalReadingProvider(null);
  });

  test('默认未注入：getReadingOverrideProvider 为 null，行为不变', () => {
    expect(getReadingOverrideProvider()).toBeNull();
    const baseline = annotate(TEXT, 'full');
    expect(pinyinOf(baseline.data!, '说')).toBe('yuè');
  });

  test('override 命中为仲裁链最顶端：优先于外部字典与内置规则，且 readingVerified=true', () => {
    const external: ReadingProvider = {
      getReadings: () => [],
      resolve: () => 'shuì',
    };
    setExternalReadingProvider(external);
    setReadingOverrideProvider({
      resolve: (char, context) =>
        char === '说' && context.includes('说乎') ? 'shuō' : null,
    });
    const res = annotate(TEXT, 'full');
    const shuo = res.data!.find((a) => a.char === '说')!;
    expect(shuo.pinyin).toBe('shuō');
    expect(shuo.readingVerified).toBe(true);
  });

  test('override 未命中返回 null → 回退外部字典 / 内置规则（行为与基准一致）', () => {
    setReadingOverrideProvider({ resolve: () => null });
    const baseline = annotate(TEXT, 'full');
    const res = annotate(TEXT, 'full');
    expect(res.data).toEqual(baseline.data);
    expect(pinyinOf(res.data!, '说')).toBe('yuè');
  });

  test('setReadingOverrideProvider(null) 移除后输出与无纠正时代完全一致', () => {
    setReadingOverrideProvider({ resolve: () => 'shuō' });
    const withOverride = annotate(TEXT, 'full');
    expect(pinyinOf(withOverride.data!, '说')).toBe('shuō');
    setReadingOverrideProvider(null);
    expect(getReadingOverrideProvider()).toBeNull();
    const without = annotate(TEXT, 'full');
    expect(pinyinOf(without.data!, '说')).toBe('yuè');
  });
});

describe('resolvePolyphone 位置感知匹配（^/$ 锚定）', () => {
  test('向后兼容：无锚定 pattern 仍为整句子串匹配', () => {
    expect(resolvePolyphone('说', '不亦说乎')).toBe('yuè');
    expect(resolvePolyphone('乐', '礼乐皆得')).toBe('yuè');
    expect(resolvePolyphone('中', '中庸之为德')).toBe('zhōng');
  });

  test('^ 前缀锚定：该字之前紧邻文本以锚定内容结尾（图穷而匕首见 → xiàn）', () => {
    // 无锚定 pattern 均不命中（「图穷匕见」因子间有「而」而不匹配），锚定生效
    expect(resolvePolyphone('见', '图穷而匕首见')).toBe('xiàn');
    // 前缀不满足锚定 → 回退 default
    expect(resolvePolyphone('见', '看见山')).toBe('jiàn');
  });

  test('$ 后缀锚定：该字之后紧邻文本以锚定内容开头（朝于齐 → cháo）', () => {
    // 旧实现：无锚定时「朝于齐」无 pattern 命中，回退 default=zhāo
    expect(resolvePolyphone('朝', '朝于齐')).toBe('cháo');
    expect(resolvePolyphone('朝', '朝闻道')).toBe('zhāo');
  });

  test('多次出现任一位置命中：如「学而时习之，不亦说乎」', () => {
    // 说 在句首出现（无 pattern 命中），句中出现「说乎」→ 任一命中即命中
    expect(resolvePolyphone('说', '说与不亦说乎')).toBe('yuè');
  });

  test('最长 pattern 胜出（含锚定内容长度比较）', () => {
    // 无锚定「将相」(长2) 胜过前缀锚定「^将」(长1)，两者同音
    expect(resolvePolyphone('相', '王侯将相')).toBe('xiàng');
    expect(resolvePolyphone('将', '将相宁有种乎')).toBe('jiàng');
  });

  test('无命中回退 default', () => {
    expect(resolvePolyphone('朝', '无命中语境')).toBe('zhāo');
  });

  test('位置感知随 annotate 生效：繁体正文经简体归一化后同样命中锚定 pattern', () => {
    const res = annotate('圖窮而匕首見', 'full');
    const jian = res.data!.find((a) => a.char === '見')!;
    expect(jian.pinyin).toBe('xiàn');
  });
});
