/**
 * TtsService iOS 平台探测单测（iOS 平台补齐 #37）
 * 覆盖：iOS 且原生 Tts 模块已注册时 isTtsAvailable 为 true /
 * iOS 模块缺失时为 false / Android 行为不变 / speakText 透传与语速夹取 /
 * stopSpeech 透传 / 事件订阅（ttsFinished / ttsError）。
 */
jest.mock('react-native', () => {
  // 可编程测试状态：Platform.OS 与 NativeModules.Tts 均动态读取
  const state = { os: 'ios', tts: undefined as unknown };
  return {
    Platform: {
      get OS() {
        return state.os;
      },
      select: (obj: Record<string, unknown>) => obj[state.os],
    },
    NativeModules: {
      get Tts() {
        return state.tts;
      },
    },
    DeviceEventEmitter: {
      addListener: jest.fn(),
    },
    __ttsTestState: state,
  };
});

import * as RN from 'react-native';
import {
  isTtsAvailable,
  speakText,
  stopSpeech,
  onSpeechFinish,
  onSpeechError,
} from '../tts/TtsService';

/** mock 工厂注入的可编程状态 */
const state = (RN as unknown as {
  __ttsTestState: { os: string; tts: unknown };
}).__ttsTestState;

/** 便捷构造原生 Tts mock */
function makeNativeTts() {
  return {
    isAvailable: jest.fn(async () => true),
    speak: jest.fn(async () => true),
    stop: jest.fn(),
  };
}

afterEach(() => {
  state.tts = undefined;
  state.os = 'ios';
  (RN.DeviceEventEmitter.addListener as jest.Mock).mockClear();
});

describe('TtsService 平台探测（iOS 补齐）', () => {
  it('iOS 且原生模块已注册：isTtsAvailable 透传引擎可用性', async () => {
    state.os = 'ios';
    const tts = makeNativeTts();
    state.tts = tts;
    await expect(isTtsAvailable()).resolves.toBe(true);
    expect(tts.isAvailable).toHaveBeenCalledTimes(1);

    tts.isAvailable.mockResolvedValueOnce(false);
    await expect(isTtsAvailable()).resolves.toBe(false);
  });

  it('iOS 但原生模块缺失（如未升级安装包）：isTtsAvailable 为 false', async () => {
    state.os = 'ios';
    state.tts = undefined;
    await expect(isTtsAvailable()).resolves.toBe(false);
  });

  it('iOS 原生 isAvailable 异常：按不可用处理', async () => {
    state.os = 'ios';
    state.tts = {
      isAvailable: jest.fn(async () => {
        throw new Error('bridge dead');
      }),
      speak: jest.fn(),
      stop: jest.fn(),
    };
    await expect(isTtsAvailable()).resolves.toBe(false);
  });

  it('Android 行为不变：模块已注册可探测', async () => {
    state.os = 'android';
    const tts = makeNativeTts();
    state.tts = tts;
    await expect(isTtsAvailable()).resolves.toBe(true);
  });
});

describe('TtsService iOS 下 speak / stop 行为', () => {
  it('speakText 透传清洗后的文本与语速（越界语速被夹取到 [0.5, 2.0]）', async () => {
    state.os = 'ios';
    const tts = makeNativeTts();
    state.tts = tts;

    await expect(speakText('  天行健，  \n@@CH@@地势坤  ', 1.5)).resolves.toEqual({
      success: true,
    });
    expect(tts.speak).toHaveBeenCalledWith('天行健， 地势坤', 1.5);

    await speakText('论语', 9);
    expect(tts.speak).toHaveBeenLastCalledWith('论语', 2.0);
    await speakText('论语', -3);
    expect(tts.speak).toHaveBeenLastCalledWith('论语', 0.5);
  });

  it('speakText 原生 reject：返回失败结果（不抛出）', async () => {
    state.os = 'ios';
    state.tts = {
      isAvailable: jest.fn(async () => true),
      speak: jest.fn(async () => {
        throw { code: 'TTS_SPEAK_FAILED', message: 'speak failed' };
      }),
      stop: jest.fn(),
    };
    await expect(speakText('论语', 1)).resolves.toMatchObject({
      success: false,
      error: 'speak failed',
    });
  });

  it('speakText 模块缺失：返回失败结果', async () => {
    state.os = 'ios';
    state.tts = undefined;
    await expect(speakText('论语', 1)).resolves.toMatchObject({
      success: false,
    });
  });

  it('stopSpeech 透传调用原生 stop', () => {
    state.os = 'ios';
    const tts = makeNativeTts();
    state.tts = tts;
    stopSpeech();
    expect(tts.stop).toHaveBeenCalledTimes(1);
  });
});

describe('TtsService 事件订阅', () => {
  it('onSpeechFinish / onSpeechError 订阅并注册对应事件名', () => {
    state.os = 'ios';
    state.tts = makeNativeTts();
    onSpeechFinish(() => {});
    onSpeechError(() => {});
    expect(RN.DeviceEventEmitter.addListener).toHaveBeenCalledWith(
      'ttsFinished',
      expect.any(Function),
    );
    expect(RN.DeviceEventEmitter.addListener).toHaveBeenCalledWith(
      'ttsError',
      expect.any(Function),
    );
  });
});
