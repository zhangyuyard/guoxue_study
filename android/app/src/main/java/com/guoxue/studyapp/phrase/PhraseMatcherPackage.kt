package com.guoxue.studyapp.phrase

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * PhraseMatcher 原生包注册入口（照抄 TtsPackage 模式）。
 * 在 MainApplication.getPackages() 的 apply {} 中手动 add(PhraseMatcherPackage())
 * （不走 autolink）。
 */
class PhraseMatcherPackage : ReactPackage {
  override fun createNativeModules(
      reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(PhraseMatcherModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
