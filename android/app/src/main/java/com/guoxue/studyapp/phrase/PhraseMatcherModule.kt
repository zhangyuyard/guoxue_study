package com.guoxue.studyapp.phrase

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableNativeArray
import org.json.JSONObject
import java.io.BufferedReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * PhraseMatcherModule — 词组读音匹配原生模块（方案 3d，旧架构同步桥）。
 *
 * 职责（对齐 src/services/PinyinService.ts 的 computePhraseOverlay + ensurePhrasePinyinData）：
 * - 在**原生后台线程**装载 data/phrase-pinyin/part-NNN.json 分片，构建 HashMap<String,String>
 *   （179,406 条），完成后翻转 isLoaded —— 该装载原在 JS 线程进行，是冷启动 ~34.8s
 *   冻结的根因；搬入原生后台线程后 JS 线程零参与 → 解冻。
 * - 暴露同步桥 match(text)：对简化码点串做正向最大匹配（len 8→2），返回
 *   [[idx, syllable], …]，与原 JS computePhraseOverlay 逐字节一致。
 *
 * JS 侧经 NativeModules.PhraseMatcher 访问（见 src/services/phraseMatcherNative.ts）。
 * 同步桥 isBlockingSynchronousMethod=true：match/isLoaded 在 JS 线程同步返回，
 * 但 HashMap 已就绪时仅为段落级 O(n·8) 查找（亚毫秒），不阻塞 UI。
 *
 * 注册：MainApplication.getPackages() apply 块 add(PhraseMatcherPackage())（无 autolink）。
 */
class PhraseMatcherModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "PhraseMatcher"

    /** assets 下分片目录（与 PinyinService.PHRASE_PART_DIR 一致） */
    private const val PART_DIR = "data/phrase-pinyin"

    /** 正向最大匹配上限（与 PinyinService.PHRASE_MAX_LEN = 8 一致） */
    private const val PHRASE_MAX_LEN = 8
  }

  /** 原生构建的词组词典（后台线程写入，完成后只读） */
  private val phraseMapRef = AtomicReference<Map<String, String>?>(null)

  /** 装载完成标志（后台线程置位，volatile 语义由 AtomicBoolean 保证） */
  private val loaded = AtomicBoolean(false)

  /** 后台装载线程（单线程，避免并发写 map） */
  private val loaderExecutor = Executors.newSingleThreadExecutor()

  init {
    // 构造即在后台线程启动装载，与 JS 启动并行；JS 线程不参与构建
    loaderExecutor.submit { loadAllShards() }
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    loaderExecutor.shutdownNow()
  }

  /** 码点是否属 CJK（逐字复刻 PinyinService.isCJKChar 范围） */
  private fun isCJK(cp: Int): Boolean {
    return (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x20000 && cp <= 0x2a6df) ||
        (cp >= 0x2a700 && cp <= 0x2ebef)
  }

  /** 统计字符串码点数（API-1 安全；规避 String.codePoints 的 API24 依赖） */
  private fun countCodePoints(text: String, n: Int): Int {
    var off = 0
    var count = 0
    while (off < n) {
      off += Character.charCount(text.codePointAt(off))
      count += 1
    }
    return count
  }

  /** 后台读取全部分片，构建 HashMap */
  private fun loadAllShards() {
    val map = HashMap<String, String>(180000)
    try {
      var i = 0
      while (true) {
        val path = "$PART_DIR/part-${String.format("%03d", i)}.json"
        val input = try {
          reactApplicationContext.assets.open(path)
        } catch (_: Exception) {
          // 读不到：i==0 表示无分片资产（置空表完成）；i>0 表示序号尽头
          break
        }
        input.bufferedReader(StandardCharsets.UTF_8).use { reader ->
          val text = reader.readText()
          val obj = JSONObject(text)
          val keys = obj.keys()
          while (keys.hasNext()) {
            val key = keys.next()
            val value = obj.optString(key, "")
            if (value.isNotEmpty()) {
              map[key] = value
            }
          }
        }
        i += 1
      }
    } catch (e: Exception) {
      Log.e(NAME, "load shards failed", e)
    }
    phraseMapRef.set(map)
    loaded.set(true)
    Log.i(NAME, "loaded count=${map.size}")
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun isLoaded(): Boolean = loaded.get()

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun match(text: String): WritableArray {
    val result = WritableNativeArray()
    val map = phraseMapRef.get() ?: return result
    if (!loaded.get()) {
      return result
    }
    // 按码点遍历（非 UTF-16 单元），保证与 JS Array.from 下标对齐
    // 码点数组（用 API-1 codePointAt 手动展开，规避 String.codePoints 的 API24 依赖）
    val n = text.length
    val cps = IntArray(countCodePoints(text, n))
    run {
      var off = 0
      var k = 0
      while (off < n) {
        val cp = text.codePointAt(off)
        cps[k] = cp
        k += 1
        off += Character.charCount(cp)
      }
    }
    var i = 0
    while (i < cps.size) {
      if (!isCJK(cps[i])) {
        i += 1
        continue
      }
      var hit = false
      val maxLen = if (PHRASE_MAX_LEN < cps.size - i) PHRASE_MAX_LEN else (cps.size - i)
      var len = maxLen
      while (len >= 2) {
        val sb = StringBuilder()
        for (k in 0 until len) {
          sb.append(String(Character.toChars(cps[i + k])))
        }
        val phrase = sb.toString()
        val pinyin = map[phrase]
        if (pinyin != null) {
          val syllables = pinyin.split("\\s+".toRegex()).toTypedArray()
          for (j in 0 until len) {
            if (j < syllables.size && syllables[j].isNotEmpty()) {
              val pair = WritableNativeArray()
              pair.pushInt(i + j)
              pair.pushString(syllables[j])
              result.pushArray(pair)
            }
          }
          i += len
          hit = true
          break
        }
        len -= 1
      }
      if (!hit) {
        i += 1
      }
    }
    return result
  }
}
