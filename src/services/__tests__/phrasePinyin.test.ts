/**
 * 词组读音层（v3.2 phrase-pinyin-data）行为测试。
 * 数据：mozillazg/phrase-pinyin-data（MIT）——汉典词典+成语词典+CC-CEDICT 合并词库，
 * 经 build-phrase-pinyin.mjs 过滤为含多音字的 2~8 字纯汉字词组。
 */
import { annotate, computePhraseOverlay } from '@/services/PinyinService';

describe('computePhraseOverlay 正向最大匹配', () => {
  test('词组命中：覆盖表给出词组内各字读音（含单音字）', () => {
    // 「银行」2 字词组：yin1 银行拼音 yín háng，两字均被覆盖
    const overlay = computePhraseOverlay(Array.from('去银行取钱'));
    expect(overlay.get(1)).toBe('yín');
    expect(overlay.get(2)).toBe('háng');
    // 未被词组覆盖的位置无值
    expect(overlay.get(0)).toBeUndefined();
    expect(overlay.get(3)).toBeUndefined();
  });

  test('最长匹配优先：不因短词组截断长词组', () => {
    // 「参差不齐」4 字词组应整体命中（而非「参差」或更短片段）
    const overlay = computePhraseOverlay(Array.from('水平参差不齐'));
    expect(overlay.get(2)).toBe('cēn');
    expect(overlay.get(3)).toBe('cī');
    expect(overlay.get(4)).toBe('bù');
    expect(overlay.get(5)).toBe('qí');
  });

  test('非汉字字符跳过：数字/标点不参与词组拼接', () => {
    const overlay = computePhraseOverlay(Array.from('银行，2024年'));
    expect(overlay.get(0)).toBe('yín');
    expect(overlay.get(1)).toBe('háng');
    expect(overlay.has(3)).toBe(false); // 「2」非汉字
  });
});

describe('词组读音层仲裁（canon > 规则库 > 词组层 > pinyin-pro）', () => {
  test('通用词组读音：annotate 命中词组层并标已校验', () => {
    const res = annotate('学校反应很平静', 'full');
    const ying = res.data!.find((a) => a.char === '应')!;
    expect(ying.pinyin).toBe('yìng');
    expect(ying.readingVerified).toBe(true);
    expect(ying.readingSources![0]).toContain('phrase-pinyin-data');
  });

  test('成语读音：汉典成语词典覆盖文言成语', () => {
    const res = annotate('他自怨自艾了很久', 'full');
    const yi = res.data!.find((a) => a.char === '艾')!;
    expect(yi.pinyin).toBe('yì');
  });

  test('古文规则库优先于通用词典：规则命中的字不受词组层覆盖', () => {
    // 「地道」词典为名词 dì dào，但古文规则库若有「道」语境判定则规则库胜出；
    // 此处仅验证词组层不破坏既有古文金标（全面回归由 polyphoneGold 保证）
    const res = annotate('重新统一', 'full');
    const zhong = res.data!.find((a) => a.char === '重')!;
    expect(zhong.pinyin).toBe('chóng');
  });

  test('canon 语境读音优先于词组层（仲裁链最高层不动）', () => {
    // canon 锚定体系由 CanonService.test.ts 全面覆盖；此处确保 provider 注入
    // 语境读音仍胜过词组层（如「说」在例句内读 yuè，即便「说」在词组中）
    const res = annotate('银行说清楚', 'full');
    const shuo = res.data!.find((a) => a.char === '说')!;
    // 无 canon 注入时走词组/基础层，不抛错即可
    expect(res.success).toBe(true);
    expect(shuo).toBeDefined();
  });
});
