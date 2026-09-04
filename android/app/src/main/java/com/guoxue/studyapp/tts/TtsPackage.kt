package com.guoxue.studyapp.tts

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Tts 原生包注册入口（照抄 OfflineTranslationPackage 模式）。
 * 在 MainApplication.getPackages() 的 apply {} 中手动
 * add(TtsPackage())（不走 autolink）。
 */
class TtsPackage : ReactPackage {
  override fun createNativeModules(
      reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(TtsModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
