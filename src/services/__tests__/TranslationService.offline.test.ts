/**
 * TranslationService 离线路由单测（Android ML Kit 原生模块 mock）
 * 覆盖：native 可用走离线不发 fetch / native 不可用回落在线 /
 * 离线失败回落在线 / 离线失败且未配置在线服务商的明确报错。
 */
jest.mock('react-native', () => {
  // 可编程测试状态：Platform.OS 与 NativeModules.OfflineTranslation 均动态读取
  const state = { os: 'android', native: undefined as unknown };
  return {
    Platform: {
      get OS() {
        return state.os;
      },
      select: (obj: Record<string, unknown>) => obj[state.os],
    },
    NativeModules: {
      get OfflineTranslation() {
        return state.native;
      },
    },
    __offlineTestState: state,
  };
});

import * as RN from 'react-native';
import { clearTranslationCache, translateAuto } from '../TranslationService';
import { DEFAULT_TRANSLATION_SETTINGS } from '@/types/translation';

/** mock 工厂注入的可编程状态 */
const offlineState = (RN as unknown as {
  __offlineTestState: { os: string; native: unknown };
}).__offlineTestState;

/** 当前注入的原生模块 mock */
function nativeMock(): {
  isModelDownloaded: jest.Mock;
  ensureModel: jest.Mock;
  translate: jest.Mock;
} {
  return offlineState.native as {
    isModelDownloaded: jest.Mock;
    ensureModel: jest.Mock;
    translate: jest.Mock;
  };
}

const GOOGLE_SETTINGS = {
  ...DEFAULT_TRANSLATION_SETTINGS,
  provider: 'google' as const,
  googleApiKey: 'g-key',
};

/** global.fetch 替身 */
const fetchMock = jest.fn();

const googleOk = (text: string) => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      data: { translations: [{ translatedText: text, detectedSourceLanguage: 'en' }] },
    }),
});

beforeEach(() => {
  clearTranslationCache();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  offlineState.os = 'android';
});

afterEach(() => {
  offlineState.native = undefined;
  delete global.fetch;
});

describe('translateAuto 离线路由（preferOffline）', () => {
  it('native 可用：走离线翻译，不发在线请求，且结果进离线缓存', async () => {
    offlineState.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(
        async (text: string, src: string, tgt: string) => `[offline:${src}>${tgt}]${text}`,
      ),
    };
    fetchMock.mockResolvedValue(googleOk('should-not-be-used'));

    const res = await translateAuto('hello', { ...GOOGLE_SETTINGS, preferOffline: true });
    expect(res.success).toBe(true);
    expect(res.data?.provider).toBe('offline');
    expect(res.data?.text).toBe('[offline:en>zh]hello');
    expect(nativeMock().ensureModel).toHaveBeenCalledWith('en', 'zh');
    expect(fetchMock).not.toHaveBeenCalled();

    // 第二次同文本命中离线缓存：不再调用原生 translate
    const again = await translateAuto('hello', { ...GOOGLE_SETTINGS, preferOffline: true });
    expect(again.success).toBe(true);
    expect(again.data?.provider).toBe('offline');
    expect(nativeMock().translate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('native 模块不可用：自动回落在线服务', async () => {
    offlineState.native = undefined;
    fetchMock.mockResolvedValue(googleOk('你好'));

    const res = await translateAuto('hello', { ...GOOGLE_SETTINGS, preferOffline: true });
    expect(res.success).toBe(true);
    expect(res.data?.provider).toBe('google');
    expect(res.data?.text).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('离线翻译失败（模型下载失败）：自动回落在线服务', async () => {
    offlineState.native = {
      isModelDownloaded: jest.fn(async () => false),
      ensureModel: jest.fn(async () => {
        throw { code: 'MODEL_DOWNLOAD_FAILED', message: 'download failed' };
      }),
      translate: jest.fn(),
    };
    fetchMock.mockResolvedValue(googleOk('你好'));

    const res = await translateAuto('hello', { ...GOOGLE_SETTINGS, preferOffline: true });
    expect(res.success).toBe(true);
    expect(res.data?.provider).toBe('google');
    expect(res.data?.text).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nativeMock().translate).not.toHaveBeenCalled();
  });

  it('离线失败且未配置在线服务商：返回明确错误（不发请求）', async () => {
    offlineState.native = {
      isModelDownloaded: jest.fn(async () => false),
      ensureModel: jest.fn(async () => false),
      translate: jest.fn(),
    };

    const res = await translateAuto('hello', {
      ...DEFAULT_TRANSLATION_SETTINGS,
      preferOffline: true,
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('离线翻译不可用且未配置在线服务商');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
