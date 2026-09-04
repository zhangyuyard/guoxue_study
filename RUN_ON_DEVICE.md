# 国学学习助手 - 真机运行指南

## 前置条件检查

| 项目 | 状态 | 说明 |
|------|------|------|
| React Native 项目 | ✅ 就绪 | `/Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app` |
| iOS 原生工程 | ✅ 就绪 | `ios/` 目录已从 RN 0.74 模板生成 |
| Android 原生工程 | ✅ 就绪 | `android/` 目录已从 RN 0.74 模板生成 |
| npm 依赖 | ✅ 已安装 | `node_modules/` 完整 |
| iOS Pods | 🔄 安装中 | `pod install` 正在运行，60+ 依赖安装中 |
| Bundle ID | ✅ 统一 | `com.guoxue.studyapp` (iOS + Android) |
| Hermes 引擎 | ✅ 已下载 | 19.7MB debug tarball + 14.5MB release tarball |

---

## 一、启动 Metro Bundler（两个平台共用）

Metro 是 JS bundle 的打包服务器，无论 iOS 还是 Android 真机运行都需要先启动它。

```bash
cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
npx react-native start
```

启动后你会看到 Metro 的控制台界面，保持这个终端窗口开着不要关。

> **提示**：如果看到 "Loading dependency graph, done." 说明 Metro 就绪了。

---

## 二、Android 真机运行

### 步骤 1：开启手机 USB 调试

1. 手机 → **设置 → 关于手机** → 连续点击 **版本号** 7 次，开启开发者模式
2. **设置 → 开发者选项** → 打开 **USB 调试**
3. 用 USB 线连接电脑和手机
4. 手机弹出 "允许 USB 调试" 对话框 → 点击 **允许**

### 步骤 2：验证设备连接

```bash
adb devices
```

应该看到类似输出：
```
List of devices attached
XXXXXXXX	device
```

如果显示 `unauthorized`，在手机上重新授权 USB 调试。

### 步骤 3：运行 App

在**另一个终端**（保持 Metro 运行）执行：

```bash
cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
npx react-native run-android
```

这会自动：
- 编译 Android 原生代码（Gradle 构建，首次约 3-5 分钟）
- 安装 APK 到手机
- 启动 App

> **首次构建注意**：Gradle 首次下载依赖可能较慢，请耐心等待。

---

## 三、iOS 真机运行

### 步骤 1：用 USB 连接 iPhone

1. 用数据线连接 iPhone 和 Mac
2. 手机弹出 "信任此电脑" → 点击 **信任**
3. 输入手机密码确认

### 步骤 2：配置 Xcode 签名

iOS 真机运行必须有开发者签名，即使是你自己的手机也需要：

1. 打开 Xcode：
   ```bash
   open /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app/ios/guoxue_study_app.xcworkspace
   ```

2. 在 Xcode 左侧文件导航器中，点击最顶部的 **guoxue_study_app** 项目

3. 选择 **Signing & Capabilities** 标签页

4. **Team** 下拉菜单：
   - 如果你有 Apple Developer 账号（$99/年），选择你的 Team
   - 如果没有，选择你的 **Personal Team**（Apple ID 免费账号，可用 7 天签名）
   - 如果没有 Team 可选，点击 **Add an Account...** 登录你的 Apple ID

5. 确认 **Bundle Identifier** 显示为 `com.guoxue.studyapp`

6. 如果看到红色错误 "Failed to register bundle identifier"，把 Bundle Identifier 改成 `com.yourname.guoxue` 之类更独特的名字

### 步骤 3：选择目标设备

1. 在 Xcode 顶部工具栏，点击设备选择器（显示模拟器名称的地方）
2. 在列表顶部找到你的 iPhone → 选中

### 步骤 4：构建并运行

- 点击 Xcode 左上角的 **▶ 运行** 按钮（或 `Cmd + R`）
- 首次构建约 2-5 分钟

### 步骤 5：信任开发者证书（仅首次）

首次在真机上运行后，App 会打不开，需要在手机上：

1. **设置 → 通用 → VPN与设备管理**
2. 找到你的 Apple ID 对应的 **开发者证书**
3. 点击 **信任**
4. 之后就可以正常打开 App 了

### 命令行方式（跳过 Xcode GUI）

如果签名已配置好，也可以用命令行：
```bash
cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
npx react-native run-ios --device
```

> **注意**：命令行方式仍需先在 Xcode 中配置好签名。首次使用建议走 Xcode GUI。

---

## 四、常见问题排查

### Q: Metro 报错 "No devices connected"
确保手机已连接，`adb devices`（Android）或 `xcrun devicectl list devices`（iOS）能看到设备。

### Q: Android 构建失败 "SDK location not found"
检查 `local.properties` 中是否配置了 SDK 路径：
```bash
echo "sdk.dir=/Users/$USER/Library/Android/sdk" > /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app/android/local.properties
```

### Q: iOS "Signing for 'guoxue_study_app' is needed"
必须在 Xcode 中配置 Team/签名（见上方步骤 2）。

### Q: App 启动后白屏
检查 Metro 终端是否还在运行。如果 Metro 关了，重新执行 `npx react-native start`。

### Q: 端口 8081 被占用
```bash
lsof -i :8081
# 找到 PID 后
kill -9 <PID>
# 重新启动 Metro
npx react-native start
```

### Q: react-native-reanimated 相关报错
已修复：版本锁定为 3.10.1（兼容 RN 0.74）。如果仍有问题：
```bash
cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
npm ls react-native-reanimated  # 应显示 3.10.1
```

---

## 五、快速启动清单

```
终端 1（保持开着）:
  cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
  npx react-native start

终端 2（Android）:
  cd /Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app
  npx react-native run-android

终端 3（iOS）或 Xcode GUI:
  open guoxue_study_app/ios/guoxue_study_app.xcworkspace
  # 在 Xcode 中配置签名 → 选择设备 → Cmd+R
  # 或: npx react-native run-ios --device
```

---

## 六、项目信息

| 信息 | 值 |
|------|-----|
| 项目路径 | `/Users/wxzhangyu/WorkBuddy/2026-08-26-10-31-18/guoxue_study_app` |
| 技术栈 | React Native 0.74.7 + TypeScript 5.4 |
| Bundle ID | `com.guoxue.studyapp` |
| 源码文件 | 66 个 |
| 主要依赖 | zustand, pinyin-pro, opencc-js, react-native-quick-sqlite, react-native-mmkv |
