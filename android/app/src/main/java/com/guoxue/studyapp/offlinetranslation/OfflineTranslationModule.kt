package com.guoxue.studyapp.offlinetranslation

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * OfflineTranslationModule — Android ML Kit 离线翻译 Bridge 模块（旧架构）。
 *
 * JS 侧经 NativeModules.OfflineTranslation 访问，共三个 Promise 方法：
 * - [isModelDownloaded]：两个语言模型是否均已下载（resolve Boolean）
 * - [ensureModel]：按需下载缺失的语言模型，成功 resolve true，
 *   失败 reject（code: MODEL_DOWNLOAD_FAILED）
 * - [translate]：离线翻译，成功 resolve 译文，失败 reject（code: TRANSLATE_FAILED）
 * - 语言 tag 非法（TranslateLanguage.fromLanguageTag 返回 null）时
 *   reject（code: UNSUPPORTED_LANGUAGE）
 *
 * 实现要点：
 * - ML Kit Tasks 为异步 API，全部经单线程 Executor + Tasks.await(60s) 执行，
 *   不阻塞 UI 线程 / JS 线程
 * - 同一语言对的并发下载用 synchronized 互斥（按语言对的锁对象表），
 *   避免重复触发模型下载
 * - Translator 每次调用创建、finally 中 close()，不常驻持有
 */
class OfflineTranslationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "OfflineTranslation"

    /** Tasks.await 超时（秒）：语言模型约 30MB，留足余量 */
    private const val AWAIT_TIMEOUT_SECONDS = 60L

    private const val E_UNSUPPORTED_LANGUAGE = "UNSUPPORTED_LANGUAGE"
    private const val E_MODEL_DOWNLOAD_FAILED = "MODEL_DOWNLOAD_FAILED"
    private const val E_TRANSLATE_FAILED = "TRANSLATE_FAILED"
  }

  /** 串行执行 ML Kit 调用的单线程池（Tasks.await 为阻塞 API，禁止在主线程调用） */
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  /** 语言对 → 下载互斥锁（简单 synchronized Map，避免并发重复下载同一模型） */
  private val downloadLocks = ConcurrentHashMap<String, Any>()

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    executor.shutdown()
  }

  /** 语言 tag → ML Kit 语言代码；非法时 reject（UNSUPPORTED_LANGUAGE）并返回 null */
  private fun resolveLanguage(tag: String, promise: Promise): String? {
    val normalized = tag.trim()
    if (normalized.isEmpty()) {
      promise.reject(E_UNSUPPORTED_LANGUAGE, "Unsupported language tag: empty string", null)
      return null
    }
    val language = TranslateLanguage.fromLanguageTag(normalized)
    if (language == null) {
      promise.reject(E_UNSUPPORTED_LANGUAGE, "Unsupported language tag: $normalized", null)
      return null
    }
    return language
  }

  /** 查询两个语言模型是否均已下载（查询失败按未下载处理，由调用方决定是否触发下载） */
  private fun bothModelsDownloaded(sourceLang: String, targetLang: String): Boolean {
    return try {
      val downloaded = Tasks.await(
          RemoteModelManager.getInstance()
              .getDownloadedModels(TranslateRemoteModel::class.java),
          AWAIT_TIMEOUT_SECONDS,
          TimeUnit.SECONDS,
      )
      downloaded.any { it.language == sourceLang } &&
          downloaded.any { it.language == targetLang }
    } catch (e: Exception) {
      if (e is InterruptedException) {
        Thread.currentThread().interrupt()
      }
      false
    }
  }

  @ReactMethod
  fun isModelDownloaded(sourceTag: String, targetTag: String, promise: Promise) {
    executor.execute {
      try {
        val sourceLang = resolveLanguage(sourceTag, promise) ?: return@execute
        val targetLang = resolveLanguage(targetTag, promise) ?: return@execute
        val downloaded = Tasks.await(
            RemoteModelManager.getInstance()
                .getDownloadedModels(TranslateRemoteModel::class.java),
            AWAIT_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
        )
        val hasSource = downloaded.any { it.language == sourceLang }
        val hasTarget = downloaded.any { it.language == targetLang }
        promise.resolve(hasSource && hasTarget)
      } catch (e: Exception) {
        if (e is InterruptedException) {
          Thread.currentThread().interrupt()
        }
        promise.reject(
            E_MODEL_DOWNLOAD_FAILED,
            "Failed to query downloaded translation models: ${e.message}",
            e,
        )
      }
    }
  }

  @ReactMethod
  fun ensureModel(sourceTag: String, targetTag: String, promise: Promise) {
    executor.execute {
      try {
        val sourceLang = resolveLanguage(sourceTag, promise) ?: return@execute
        val targetLang = resolveLanguage(targetTag, promise) ?: return@execute
        val lock = downloadLocks.computeIfAbsent("$sourceLang>$targetLang") { Any() }
        synchronized(lock) {
          if (bothModelsDownloaded(sourceLang, targetLang)) {
            promise.resolve(true)
            return@synchronized
          }
          val options = TranslatorOptions.Builder()
              .setSourceLanguage(sourceLang)
              .setTargetLanguage(targetLang)
              .build()
          val client = Translation.getClient(options)
          try {
            // downloadModelIfNeeded 同时确保源/目标两个语言模型各就绪一次；
            // 已存在时立即返回，缺失时触发下载
            Tasks.await(
                client.downloadModelIfNeeded(DownloadConditions.Builder().build()),
                AWAIT_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            )
            promise.resolve(true)
          } finally {
            client.close()
          }
        }
      } catch (e: Exception) {
        if (e is InterruptedException) {
          Thread.currentThread().interrupt()
        }
        promise.reject(
            E_MODEL_DOWNLOAD_FAILED,
            "Failed to download translation model: ${e.message}",
            e,
        )
      }
    }
  }

  @ReactMethod
  fun translate(text: String, sourceTag: String, targetTag: String, promise: Promise) {
    executor.execute {
      try {
        val sourceLang = resolveLanguage(sourceTag, promise) ?: return@execute
        val targetLang = resolveLanguage(targetTag, promise) ?: return@execute
        val options = TranslatorOptions.Builder()
            .setSourceLanguage(sourceLang)
            .setTargetLanguage(targetLang)
            .build()
        val client = Translation.getClient(options)
        try {
          // 模型缺失时先确保下载（已下载则立即返回），再执行翻译
          Tasks.await(
              client.downloadModelIfNeeded(DownloadConditions.Builder().build()),
              AWAIT_TIMEOUT_SECONDS,
              TimeUnit.SECONDS,
          )
          val translated = Tasks.await(
              client.translate(text),
              AWAIT_TIMEOUT_SECONDS,
              TimeUnit.SECONDS,
          )
          promise.resolve(translated)
        } finally {
          client.close()
        }
      } catch (e: Exception) {
        if (e is InterruptedException) {
          Thread.currentThread().interrupt()
        }
        promise.reject(
            E_TRANSLATE_FAILED,
            "Offline translation failed: ${e.message}",
            e,
        )
      }
    }
  }
}
