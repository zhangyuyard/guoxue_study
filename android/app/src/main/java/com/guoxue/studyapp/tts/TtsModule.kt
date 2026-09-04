package com.guoxue.studyapp.tts

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * TtsModule — Android 正文朗读 Bridge 模块（旧架构，P2-02）。
 *
 * JS 侧经 NativeModules.Tts 访问，共三个方法：
 * - [isAvailable]：TextToSpeech 引擎初始化是否成功（resolve Boolean）
 * - [speak]：以 zh-CN 朗读文本，rate 为 0.5–2.0 语速系数；
 *   正在朗读时先 stop 再 speak（QUEUE_FLUSH 语义）；
 *   朗读入队成功 resolve true，完成/失败经事件回调 JS
 *   （ttsFinished / ttsError，见 [EVENT_FINISHED] / [EVENT_ERROR]）
 * - [stop]：停止当前朗读（幂等空操作）
 *
 * 实现要点（照抄 OfflineTranslationModule 模式）：
 * - ReactContextBaseJavaModule + @ReactMethod，不走 TurboModule codegen
 * - TextToSpeech 惰性创建（synchronized），初始化为异步回调，
 *   初始化完成前的 speak / isAvailable 请求按未就绪处理
 * - [invalidate] 时 stop + shutdown 释放引擎资源
 *   （Activity 重建 / RN 上下文销毁时由 ReactNativeHost 调用）
 */
class TtsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "Tts"

    /** 朗读完成事件名（JS 侧经 DeviceEventEmitter 监听） */
    const val EVENT_FINISHED = "ttsFinished"

    /** 朗读失败事件名（JS 侧经 DeviceEventEmitter 监听） */
    const val EVENT_ERROR = "ttsError"

    private const val E_INIT_FAILED = "TTS_INIT_FAILED"
    private const val E_NOT_READY = "TTS_NOT_READY"
    private const val E_SPEAK_FAILED = "TTS_SPEAK_FAILED"

    /** 语速范围（与 JS 侧 utils/speech.ts 保持一致） */
    private const val MIN_RATE = 0.5f
    private const val MAX_RATE = 2.0f
  }

  /** TextToSpeech 实例（惰性创建，访问均在 synchronized(lock) 内） */
  private var tts: TextToSpeech? = null

  /** 惰性创建锁 */
  private val lock = Any()

  /** 引擎初始化结果（TextToSpeech.SUCCESS / ERROR；null = 初始化尚未回调） */
  private var initStatus: Int? = null

  /** 自增 utteranceId（同一时刻至多一段朗读，仍保证 id 唯一便于排查） */
  private val utteranceCounter = AtomicInteger(0)

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    synchronized(lock) {
      try {
        tts?.stop()
        tts?.shutdown()
      } catch (_: Exception) {
        // 引擎已失效时忽略，确保实例引用清空
      }
      tts = null
      initStatus = null
    }
  }

  /** 惰性创建 TextToSpeech 并挂接进度监听；已创建时直接复用 */
  private fun ensureTtsLocked(): TextToSpeech? {
    if (tts != null) {
      return tts
    }
    val listener = object : TextToSpeech.OnInitListener {
      override fun onInit(status: Int) {
        synchronized(lock) {
          initStatus = status
        }
      }
    }
    val engine = TextToSpeech(reactApplicationContext, listener)
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        // 入队成功即可 onStart，无需通知 JS
      }

      override fun onDone(utteranceId: String?) {
        sendEvent(EVENT_FINISHED, null)
      }

      @Deprecated("Deprecated in Java（保留旧签名兼容低版本回调路径）")
      override fun onError(utteranceId: String?) {
        sendEvent(EVENT_ERROR, null)
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        val params = Arguments.createMap()
        params.putInt("errorCode", errorCode)
        sendEvent(EVENT_ERROR, params)
      }
    })
    tts = engine
    return engine
  }

  /** 向 JS 发射事件（无监听时安全忽略） */
  private fun sendEvent(eventName: String, params: com.facebook.react.bridge.WritableMap?) {
    try {
      reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(eventName, params)
    } catch (_: Exception) {
      // JS 侧尚未挂载监听 / 上下文已销毁时忽略
    }
  }

  @ReactMethod
  fun isAvailable(promise: Promise) {
    synchronized(lock) {
      val engine = ensureTtsLocked()
      if (engine == null) {
        promise.reject(E_INIT_FAILED, "Failed to create TextToSpeech engine", null)
        return
      }
      val status = initStatus
      if (status == null) {
        // 初始化回调尚未到达：按不可用处理（引擎热身后再次调用即准确）
        promise.resolve(false)
        return
      }
      promise.resolve(status == TextToSpeech.SUCCESS)
    }
  }

  @ReactMethod
  fun speak(text: String, rate: Double, promise: Promise) {
    synchronized(lock) {
      val engine = ensureTtsLocked()
      if (engine == null) {
        promise.reject(E_INIT_FAILED, "Failed to create TextToSpeech engine", null)
        return
      }
      val status = initStatus
      if (status == null || status != TextToSpeech.SUCCESS) {
        promise.reject(E_NOT_READY, "TextToSpeech engine is not ready", null)
        return
      }
      // 语速夹取到 [0.5, 2.0]
      val clampedRate = rate.toFloat().coerceIn(MIN_RATE, MAX_RATE)
      val langResult = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
      if (langResult == TextToSpeech.LANG_MISSING_DATA ||
          langResult == TextToSpeech.LANG_NOT_SUPPORTED
      ) {
        promise.reject(E_SPEAK_FAILED, "zh-CN language data is missing or unsupported", null)
        return
      }
      // 正在朗读时先 stop 再 speak（显式 stop + QUEUE_FLUSH 双保险）
      if (engine.isSpeaking) {
        engine.stop()
      }
      val utteranceId = "tts-${utteranceCounter.incrementAndGet()}"
      engine.setSpeechRate(clampedRate)
      val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
      if (result == TextToSpeech.SUCCESS) {
        promise.resolve(true)
      } else {
        promise.reject(E_SPEAK_FAILED, "TextToSpeech speak() queued failed: $result", null)
      }
    }
  }

  @ReactMethod
  fun stop() {
    synchronized(lock) {
      try {
        tts?.stop()
      } catch (_: Exception) {
        // 引擎已失效时忽略
      }
    }
  }
}
