package com.guoxue.studyapp.offlinetranslation

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * OfflineTranslation 原生包注册入口。
 * 在 MainApplication.getPackages() 的 apply {} 中手动
 * add(OfflineTranslationPackage())（不走 autolink）。
 */
class OfflineTranslationPackage : ReactPackage {
  override fun createNativeModules(
      reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(OfflineTranslationModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
