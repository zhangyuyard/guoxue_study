/**
 * NativeOfflineTranslation iOS 平台探测单测（iOS 平台补齐 #37）
 * 覆盖：iOS 且原生模块已注册时 isNativeAvailable 为 true /
 * iOS 模块缺失时为 false / Android 行为不变 / 三方法透传与错误归一。
 */
jest.mock('react-native', () => {
  // 可编程测试状态：Platform.OS 与 NativeModules.OfflineTranslation 均动态读取
  const state = { os: 'ios', native: undefined as unknown };
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
    __nativeOfflineTestState: state,
  };
});

import * as RN from 'react-native';
import {
  isModelDownloaded,
  ensureModel,
  nativeTranslate,
  isNativeAvailable,
} from '../offline/NativeOfflineTranslation';

/** mock 工厂注入的可编程状态 */
const state = (RN as unknown as {
  __nativeOfflineTestState: { os: string; native: unknown };
}).__nativeOfflineTestState;

afterEach(() => {
  state.native = undefined;
  state.os = 'ios';
});

describe('NativeOfflineTranslation 平台探测（iOS 补齐）', () => {
  it('iOS 且原生模块已注册：isNativeAvailable 为 true', () => {
    state.os = 'ios';
    state.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(async () => 'x'),
    };
    expect(isNativeAvailable()).toBe(true);
  });

  it('iOS 但原生模块缺失（如未升级安装包）：isNativeAvailable 为 false', () => {
    state.os = 'ios';
    state.native = undefined;
    expect(isNativeAvailable()).toBe(false);
  });

  it('Android 行为不变：模块已注册 true / 缺失 false', () => {
    state.os = 'android';
    state.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(async () => 'x'),
    };
    expect(isNativeAvailable()).toBe(true);

    state.native = undefined;
    expect(isNativeAvailable()).toBe(false);
  });

  it('其他平台恒不可用（模块存在也不暴露）', () => {
    state.os = 'windows';
    state.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(async () => 'x'),
    };
    expect(isNativeAvailable()).toBe(false);
  });
});

describe('iOS 下三方法透传与错误归一', () => {
  it('isModelDownloaded / ensureModel / nativeTranslate 正常透传参数', async () => {
    state.os = 'ios';
    const mod = {
      isModelDownloaded: jest.fn(async (s: string, t: string) => s === 'en' && t === 'zh'),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(async (text: string) => `译文:${text}`),
    };
    state.native = mod;

    await expect(isModelDownloaded('en', 'zh')).resolves.toBe(true);
    await expect(ensureModel('en', 'zh')).resolves.toBe(true);
    await expect(nativeTranslate('论语', 'en', 'zh')).resolves.toBe('译文:论语');
    expect(mod.isModelDownloaded).toHaveBeenCalledWith('en', 'zh');
    expect(mod.ensureModel).toHaveBeenCalledWith('en', 'zh');
    expect(mod.translate).toHaveBeenCalledWith('论语', 'en', 'zh');
  });

  it('不支持的语言 tag：快速失败且 reject UNSUPPORTED_LANGUAGE', async () => {
    state.os = 'ios';
    state.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => true),
      translate: jest.fn(async () => 'x'),
    };
    await expect(ensureModel('xx', 'zh')).rejects.toMatchObject({
      code: 'UNSUPPORTED_LANGUAGE',
    });
    // 原生模块未被触达（白名单前置校验）
    expect(
      (state.native as { ensureModel: jest.Mock }).ensureModel,
    ).not.toHaveBeenCalled();
  });

  it('原生 reject：错误归一为 { code, message }', async () => {
    state.os = 'ios';
    state.native = {
      isModelDownloaded: jest.fn(async () => true),
      ensureModel: jest.fn(async () => {
        throw { code: 'MODEL_DOWNLOAD_FAILED', message: 'network down' };
      }),
      translate: jest.fn(async () => {
        throw { message: 'boom' };
      }),
    };
    await expect(ensureModel('en', 'zh')).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: 'network down',
    });
    await expect(nativeTranslate('a', 'en', 'zh')).rejects.toMatchObject({
      code: 'TRANSLATE_FAILED',
    });
  });

  it('模块缺失时调用抛出 NATIVE_UNAVAILABLE', async () => {
    state.os = 'ios';
    state.native = undefined;
    await expect(ensureModel('en', 'zh')).rejects.toMatchObject({
      code: 'NATIVE_UNAVAILABLE',
    });
  });
});
