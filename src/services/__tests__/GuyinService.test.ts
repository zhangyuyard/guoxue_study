/**
 * GuyinService 单元测试（P2-01 古音提示）
 * 验证：
 *   - getGuyin 命中：简体直接命中、繁体归一化后命中（繁体显示模式场景）
 *   - getGuyin 未命中：库外汉字、多字输入、空输入均返回 null
 *   - cleanPhoneticString 纯函数：空白清洗与折叠
 *   - getMeta 返回构建产物 meta（来源署名齐全）
 */
import GuyinService, {
  cleanPhoneticString,
  GUYIN_DICT_VERSION,
  GUYIN_ATTRIBUTION,
} from '@/services/GuyinService';

describe('GuyinService.getGuyin：命中（P2-01）', () => {
  afterEach(() => {
    GuyinService.resetForTest();
  });

  test('简体字「说」命中：中古 sywet / 上古 *l̥ot', () => {
    const r = GuyinService.getGuyin('说');
    expect(r).not.toBeNull();
    expect(r?.mc).toBe('sywet');
    expect(r?.oc).toBe('*l̥ot');
    expect(r?.gloss).toBe('speak, explain');
  });

  test('简体字「见」命中：中古 kenH / 上古 *[k]ˤen-s', () => {
    const r = GuyinService.getGuyin('见');
    expect(r).not.toBeNull();
    expect(r?.mc).toBe('kenH');
    expect(r?.oc).toBe('*[k]ˤen-s');
  });

  test('繁体字「說」「見」归一化后命中（繁体显示模式场景）', () => {
    const shuo = GuyinService.getGuyin('說');
    expect(shuo).not.toBeNull();
    expect(shuo?.mc).toBe('sywet');
    const jian = GuyinService.getGuyin('見');
    expect(jian).not.toBeNull();
    expect(jian?.oc).toBe('*[k]ˤen-s');
  });

  test('无 gloss 字段时返回对象不含 gloss（如「安」有 gloss；构造反例用 meta 覆盖不到的字段检查）', () => {
    const r = GuyinService.getGuyin('安');
    expect(r).not.toBeNull();
    expect(typeof r?.gloss).toBe('string');
  });
});

describe('GuyinService.getGuyin：未命中（P2-01）', () => {
  afterEach(() => {
    GuyinService.resetForTest();
  });

  test('库外汉字返回 null（后起形声字不在 Baxter-Sagart 2014 收字范围）', () => {
    expect(GuyinService.getGuyin('尬')).toBeNull();
    expect(GuyinService.getGuyin('咱')).toBeNull();
  });

  test('多字输入返回 null', () => {
    expect(GuyinService.getGuyin('说文')).toBeNull();
  });

  test('空输入返回 null', () => {
    expect(GuyinService.getGuyin('')).toBeNull();
  });
});

describe('cleanPhoneticString：拟音字符串清洗（纯函数）', () => {
  test('去首尾空白', () => {
    expect(cleanPhoneticString('  *qˤə  ')).toBe('*qˤə');
  });

  test('连续空白折叠为单空格', () => {
    expect(cleanPhoneticString("*[k]ʷˤ\t rə  n")).toBe('*[k]ʷˤ rə n');
  });

  test('空/非法输入安全处理（nullish 一律归空串）', () => {
    expect(cleanPhoneticString('')).toBe('');
    expect(cleanPhoneticString('   ')).toBe('');
    expect(cleanPhoneticString(null as unknown as string)).toBe('');
    expect(cleanPhoneticString(undefined as unknown as string)).toBe('');
  });
});

describe('GuyinService 元信息（P2-01）', () => {
  test('getMeta：来源含 Baxter-Sagart、版本与运行时互指常量一致', () => {
    const meta = GuyinService.getMeta();
    expect(meta.source).toContain('Baxter');
    expect(meta.attribution).toBe(GUYIN_ATTRIBUTION);
    expect(meta.version).toBe(GUYIN_DICT_VERSION);
    expect(meta.entries).toBeGreaterThan(1000);
  });
});
