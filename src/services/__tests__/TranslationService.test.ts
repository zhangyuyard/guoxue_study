/**
 * TranslationService 单元测试
 * 覆盖：语种粗判（Unicode 区段）、MD5 签名（对拍 Node crypto 硬编码值）、
 * 配置校验与文本长度限制（网络请求不做单测——适配器为纯 fetch 薄层）。
 */
import {
  clearTranslationCache,
  detectLang,
  md5Hex,
  translateAuto,
} from '../TranslationService';
import { DEFAULT_TRANSLATION_SETTINGS } from '@/types/translation';

describe('detectLang', () => {
  it('识别常见语种', () => {
    expect(detectLang('学而时习之')).toBe('zh');
    expect(detectLang('こんにちは世界')).toBe('ja');
    expect(detectLang('안녕하세요')).toBe('ko');
    expect(detectLang('Привет мир')).toBe('ru');
    expect(detectLang('مرحبا بالعالم')).toBe('ar');
    expect(detectLang('Hello world, this is a test')).toBe('en');
  });

  it('假名优先于汉字（混排判日文）', () => {
    expect(detectLang('漢字かな交じり文')).toBe('ja');
  });

  it('无字符/纯符号回退 en', () => {
    expect(detectLang('123 !@#')).toBe('en');
    expect(detectLang('')).toBe('en');
  });
});

describe('md5Hex', () => {
  // 期望值取自 Node crypto.createHash('md5')，覆盖 ASCII/中文/空串
  it('与标准 MD5 一致', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(md5Hex('测试翻译')).toBe('9bbb2e4fe49e43a5fbcb3419cd2e4bfd');
    expect(md5Hex('appid中文salt123')).toBe('5df59a0ed6aa1af778fe73631db186ba');
  });
});

describe('translateAuto（配置与输入校验）', () => {
  it('空文本报错', async () => {
    const res = await translateAuto('   ', DEFAULT_TRANSLATION_SETTINGS);
    expect(res.success).toBe(false);
    expect(res.error).toContain('没有可翻译的内容');
  });

  it('超长文本报错', async () => {
    const res = await translateAuto('a'.repeat(4001), DEFAULT_TRANSLATION_SETTINGS);
    expect(res.success).toBe(false);
    expect(res.error).toContain('选段过长');
  });

  it('DeepL 未配置 Key 报错', async () => {
    const res = await translateAuto('hello', DEFAULT_TRANSLATION_SETTINGS);
    expect(res.success).toBe(false);
    expect(res.error).toContain('未配置 DeepL API Key');
  });

  it('Google 未配置 Key 报错', async () => {
    const res = await translateAuto('hello', {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'google',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('未配置 Google API Key');
  });

  it('百度缺密钥报错', async () => {
    const res = await translateAuto('hello', {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'baidu',
      baiduAppId: '202609020001',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('未配置百度 APP ID / 密钥');
  });

  it('百度通道按 UTF-8 字节限长（中文 3 字节/字）', async () => {
    // 1950 汉字 × 3 字节 = 5850 字节 > 5800 上限（1950 字符 < 4000 字符上限，仅百度字节检查命中）
    const res = await translateAuto('汉'.repeat(1950), {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'baidu',
      baiduAppId: '202609020001',
      baiduSecretKey: 'secret',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('字节');
  });

  it('百度通道字节限内不触发限长报错', async () => {
    // 1900 汉字 × 3 = 5700 字节 ≤ 5800：通过限长校验（此后进入网络请求，单测环境必失败，但错误不应是限长）
    const res = await translateAuto('汉'.repeat(1900), {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'baidu',
      baiduAppId: '202609020001',
      baiduSecretKey: 'secret',
    });
    expect(res.success).toBe(false);
    expect(res.error ?? '').not.toContain('字节');
  });
});

describe('translateAuto 缓存与百度 QPS 限流', () => {
  const BAIDU_SETTINGS = {
    ...DEFAULT_TRANSLATION_SETTINGS,
    provider: 'baidu' as const,
    baiduAppId: '202609030001',
    baiduSecretKey: 'secret',
  };

  /** global.fetch 替身（每个用例重置调用计数） */
  const fetchMock = jest.fn();

  beforeEach(() => {
    clearTranslationCache();
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
  });

  const baiduOk = (dst: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ from: 'en', to: 'zh', trans_result: [{ dst }] }),
  });

  const googleOk = (text: string) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: { translations: [{ translatedText: text, detectedSourceLanguage: 'en' }] },
      }),
  });

  it('相同文本命中缓存不重复发请求；不同文本不命中', async () => {
    const settings = {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'google' as const,
      googleApiKey: 'g-key',
    };
    fetchMock.mockResolvedValue(googleOk('你好'));

    const r1 = await translateAuto('hello', settings);
    expect(r1.success).toBe(true);
    expect(r1.data?.text).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const r2 = await translateAuto('hello', settings);
    expect(r2.success).toBe(true);
    expect(r2.data?.text).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 缓存命中

    const r3 = await translateAuto('world', settings);
    expect(r3.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 不同文本重新请求
  });

  it('失败结果不进缓存，重试会重新发请求', async () => {
    const settings = {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'google' as const,
      googleApiKey: 'g-key',
    };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' });
    const r1 = await translateAuto('hello', settings);
    expect(r1.success).toBe(false);

    fetchMock.mockResolvedValueOnce(googleOk('你好'));
    const r2 = await translateAuto('hello', settings);
    expect(r2.success).toBe(true);
    expect(r2.data?.text).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('缓存上限 50 条：最早条目淘汰后重新发请求，未淘汰条目仍命中', async () => {
    const settings = {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'google' as const,
      googleApiKey: 'g-key',
    };
    fetchMock.mockImplementation(async (_url, init) => {
      const q = JSON.parse(init.body).q;
      return googleOk(`译:${q}`);
    });
    // 写入 51 条 → 第 51 条写入时淘汰最早的 text-0
    for (let i = 0; i < 51; i += 1) {
      await translateAuto(`text-${i}`, settings);
    }
    expect(fetchMock).toHaveBeenCalledTimes(51);

    await translateAuto('text-0', settings); // 已淘汰 → 重新请求
    expect(fetchMock).toHaveBeenCalledTimes(52);

    await translateAuto('text-50', settings); // 仍在缓存 → 不发请求
    expect(fetchMock).toHaveBeenCalledTimes(52);
  });

  it('百度 QPS=1：连续两次请求发出间隔 ≥1.1s', async () => {
    jest.useFakeTimers();
    const callTimes = [];
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return baiduOk('结果');
    });

    await translateAuto('first', BAIDU_SETTINGS);
    expect(callTimes).toHaveLength(1);

    const p2 = translateAuto('second', BAIDU_SETTINGS);
    await jest.advanceTimersByTimeAsync(1200);
    const r2 = await p2;
    expect(r2.success).toBe(true);
    expect(callTimes).toHaveLength(2);
    // 第二次请求发出前等待补足 QPS 间隔（假定时钟下 ≥1100ms，留余量断言）
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1000);
  });

  it('限流仅对百度生效：DeepL/Google 连续请求无需等待', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(googleOk('你好'));
    const settings = {
      ...DEFAULT_TRANSLATION_SETTINGS,
      provider: 'google' as const,
      googleApiKey: 'g-key',
    };
    // 若被限流挂起，不推进定时器将永远无法完成 → 用例超时失败
    await translateAuto('first', settings);
    await translateAuto('second', settings);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
