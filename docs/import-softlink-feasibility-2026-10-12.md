# 导入功能「拷贝副本 → 软链接」可行性论证

- 日期：2026-10-12
- 设备：ALT-AL10（华为），Android 12 / API 31，`targetSdk=35 / minSdk=24`
- 包名：`com.guoxue.studyapp`，uid=10725，进程组 `Groups: 3003 9997 20725 50725`
- 结论摘要：**软链接方案在本机不可行（实测否决）**；「不拷贝副本」的可行路径是 SAF 长期授权（`mode:'open'` + `requestLongTermAccess`），但需自研原生模块补齐 `stat`/`read` 能力。

---

## 一、目标拆解

用户诉求包含两条，必须分开论证：

| 子目标 | 含义 | 可行性 |
|---|---|---|
| A. 不拷贝副本 | 导入后不再在 `guoxue-books/` 留一份实体文件 | 见第三节 |
| B. 阅读体验等同内置 | 拼音/划线/笔记/FTS/跳章/朗读全链路一致 | **已天然满足**（见第二节） |

---

## 二、有利条件：B 档（阅读体验）零改动

全部经源码复核，行号为 `src/services/UserBookService.ts`（除注明）：

| 事实 | 位置 | 含义 |
|---|---|---|
| EPUB/ZIP 解析全在内存 `Uint8Array` 上做 | `src/utils/zipReader.ts:8-9` 仅 import `pako`/`decodeUtf8`，**零 RNFS 调用**；`bookFormat.ts:455` `convertBookBytes(ext, bytes: Uint8Array)` | 不依赖文件随机访问/seek ⇒ 换任何取字节的通道都不动解析层 |
| 13 种扩展名统一入口 | `bookFormat.ts:449-470` | 同上 |
| 阅读时零 IO：用户书走内存注册表 | `1088` `TextLibraryService.getBook(bookId)` | 解析一次后常驻内存，与文件位置解耦 |
| FTS 从内存 `Book` 生成 | `StorageService.ts:674` `upsertFtsForBook(book)` → `buildFtsRows(book)`，**不读源文件** | 索引层零改动 |
| 启动扫描按 `mtime:size` 指纹复用解析结果 | `4767-4770` `file_sig` | 外部文件被外部编辑后能自动重解析（前提：能 stat 到） |

**结论 B：一旦能拿到字节，后续 100% 复用现有链路，体验自动等同内置书。** 改造面全在「怎么拿到字节」这一层。

---

## 三、判决性实验：软链接在本机**不可行**

### 3.1 前置事实（源码复核）

| 项 | 读数 | 出处 |
|---|---|---|
| manifest 存储权限 | **零**。无 `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` / `MANAGE_EXTERNAL_STORAGE` / `READ_MEDIA_*` | `android/app/src/main/AndroidManifest.xml` 全文 |
| SDK | `minSdkVersion=24 / compileSdk=35 / targetSdk=35` | `android/build.gradle:4-6` |
| 设备侧确认 | `pm dump`：`uid=10725`，`READ/WRITE_EXTERNAL_STORAGE granted=false` | adb |
| 书籍根路径 | `RNFS.ExternalDirectoryPath/guoxue-books` = `/storage/emulated/0/Android/data/<pkg>/files/guoxue-books` | `UserBookService.ts:338-341` |
| RNFS 无 symlink API | `FS.common.js` 导出清单共 20+ 方法，**无 `symlink`/`readlink`**；Android 侧 `RNFSManager.java` 亦无 | `node_modules/react-native-fs/` |

### 3.2 实验 1：能力四象限（`probe-01`）

以 shell 身份在四个位置尝试建软链：

| 位置 | 结果 |
|---|---|
| `/data/local/tmp`（内部存储） | ✅ `rc=0`，`lrwxrwxrwx ... -> /storage/emulated/0/Download/...` |
| `.../guoxue-books/`（app 外部目录） | ❌ `Permission denied` |
| `.../Android/data/<pkg>/cache/` | ❌ `Permission denied` |
| `/storage/emulated/0/Android/` | ❌ `Permission denied` |

### 3.3 实验 2：2×2 变量分离（`probe-02`）—— 决定性

「放在外部存储失败」有两种互斥解释，必须分离：

| # | 链接存放 | 链接目标 | 结果 | 说明 |
|---|---|---|---|---|
| 1 | app files（外部） | 内部 `/data/local/tmp` | ❌ denied | 目标在内部**也**失败 ⇒ 与目标无关 |
| 2 | app files（外部） | 外部 app files | ❌ denied | 同向复现 |
| 3 | 内部 `/data/local/tmp` | 外部 app files | ✅ `rc=0`，`cat` 读出 `BBBBB` | **软链机制本身完全可用**，能穿透读外部存储 |
| 4 | 内部 `/data/local/tmp` | `/storage/emulated/0/Download` | ✅ `rc=0`，`ls` 列出 `2026429 账单.pdf` 等 | 同上 |

**判定：失败原因＝「链接自身存放位置在外部存储」＝ 外部存储挂载层禁止创建链接（`ln` 返回 `EPERM/EACCES`），与目标无关。**

### 3.4 实验 3：硬链接 + 挂载选项（`probe-03`）

| 项 | 读数 |
|---|---|
| 硬链接 `ln src dst`（app files 内，同 fs） | ❌ `Permission denied` |
| `/storage/emulated` 挂载 | `fuse`（华为 hmdfs 后端），`rw,nosuid,nodev,noexec,noatime` |
| `/storage/emulated/0/Android/data` 挂载 | **`f2fs` 真实块设备直挂**（`/dev/block/by-name/userdata`），`rw,seclabel,nosuid,nodev` |

挂载选项中**无 `nosymfollow`**，但 FUSE/f2fs 层对「创建符号链接」这一操作本身做了拒绝——这与 Linux VFS 的 `may_follow_link`/`SYMLINK` 权限位（`S_IFLNK` 写入需 `CAP_FOWNER` 或目录写权限）无关：目录可写（`touch` 成功，`probe-01` 自证 `WRITE_OK`），写普通文件可以、写链接不行 ⇒ 是挂载/策略层的显式限制。

### 3.5 app 身份下会更严格吗？

会，且不可能更宽松：
- app 进程组 `Groups: 3003 9997 20725 50725`，**不含 `ext_data_rw`(1078)/`sdcard_rw`(1015)/`media_rw`(1053)`** 中的任一（对照：shell 有 `1078 ext_data_rw`、`1015 sdcard_rw`）。
- `Download` 内文件权限位实测 `-rw-rw---- 1 10171 1023`（属主 u0_a171、属组 media_rw），app 不在 media_rw 组 ⇒ **DAC 层直接拒绝**。

因此「链接放外部存储」这条路对 app 身份**双重不可行**：链接建不出来（挂载层），即便建成也读不到目标（DAC + FUSE）。

### 3.6 顺带否决：`MANAGE_EXTERNAL_STORAGE` 路线

即使申请 `MANAGE_EXTERNAL_STORAGE`（targetSdk 35 下唯一能直连 `/sdcard/Download` 的手段）：
- 仍需解决「链接存放」问题——3.2/3.3 已否决外部存储建链；若把链接放内部存储（`/data/data/<pkg>/files/`），则书籍目录不再是 `guoxue-books`，整套扫描/下架/页脚引导（`LibraryScreen.tsx:354-357`）全部要重做。
- Google Play 对该权限的审核政策仅放行文件管理器/防病毒/备份类应用，国学阅读器属「内容/阅读」类，**被拒风险高**。

---

## 四、源码侧必须改的连带项（即便方案成立也要付）

| # | 项 | 位置 | 风险 |
|---|---|---|---|
| 1 | `id` 由**文件名**哈希决定 | `stableBookIdFromPath` `374-381`（FNV-1a，仅吃 `fileName`） | 外部文件被改名/移动 ⇒ 换书 ⇒ 用户划线/笔记/进度全部脱挂 |
| 2 | 下架清扫会误杀 | `4885` `!seenPaths.has(row.source_path)` + `4889` `startsWith(currentRoot+'/')` | 若 `source_path` 存链接路径而源文件被删 ⇒ 断链 ⇒ 本轮扫不到 ⇒ **删 db 行 + `cascadeCleanupAfterDelete` 级联清用户数据** |
| 3 | 删除语义差异 | `5481` `RNFS.unlink(sourcePath)`；POSIX 正确（只删链接），但 UI 文案 `LibraryScreen.tsx:161` 写「书籍文件夹中的源文件一并删除」 | 文案须按「是否软链」分支 |
| 4 | 超大书缓存路径 | `4778` `cachePath = ${f.path}${OVERSIZED_CACHE_SUFFIX}`（`.gxbook`，`165`） | 链接在外部则缓存写不进 app 目录；须改为落到 app 内部目录 |
| 5 | RNFS 无 symlink API | 已核 | 须自研 Kotlin 模块（可照抄 `PhraseMatcherPackage.kt` 23 行 + `TtsPackage` 注册模式，`MainApplication.kt:26-28` 三行 add）——**但 3.2/3.3 已否决前提，此项无意义** |
| 6 | 测试桩需扩语义 | `src/__tests__/importShelfRegistrationGuard.test.ts` 等 8 处 `jest.mock('react-native-fs')` 用内存 FS | 需 mock 断链/改名场景 |

---

## 五、三档方案

### A 档：去掉「双份拷贝」中的**一份**（推荐先做）

**现状是双份拷贝**：
1. `copyTo: 'cachesDirectory'` 让系统把 `content://` 拷一份到 cache（`3582`）
2. `RNFS.copyFile(toLocalPath(file.uri), destPath)` 再拷一份到 `guoxue-books`（`5227`）

**改造**：`5227` 改为 `RNFS.moveFile(fileCopyUri → destPath)`。副本从 2 份降为 1 份（cache 那份被搬走，不再残留），且**零架构改动**——`destPath` 仍在 `currentRoot` 内，第四节 1/2/3/4 项全部不触发。

- 代价：仍是拷贝语义，用户改外部文件后不会自动同步（但现状也不同步）。
- 风险：极低。`moveFile` 在同一 fs 内是 rename，跨 fs 是 copy+delete——两者都在 app 私有目录内，实际是 rename。
- 顺带清理：`copyTo` 产生的 cache 目录（`FileOperations.kt:101` `getUniqueDir` 建的 UUID 目录）目前**从不删除**（全仓 `CachesDirectoryPath` 只在测试 mock 里出现，无生产清理代码）⇒ 长期占盘，A 档顺手修掉。

### B 档：SAF 长期授权 + 原生模块（真·不拷贝）

**原理**：`DocumentPicker.pick({ mode:'open', requestLongTermAccess: true })` 返回 `bookmark`（base64 编码的 `content://` URI），并已在 picker 内部调 `takePersistableUriPermission`（`node_modules/@react-native-documents/picker/android/src/main/java/com/reactnativedocumentpicker/MetadataGetter.kt:58`）。授权持久化 ⇒ 重启后仍可读 ⇒ **完全不需要拷贝**。

**关键发现：RNFS 部分支持 `content://`**（此前 `localPath.ts:8` 的注释「content:// 完全无法由 RNFS 读取」不准确）：

| RNFS API | `content://` 支持 | 依据 |
|---|---|---|
| `read` / `readFile` / `copyFile` | ✅ **支持** | 都走 `getInputStream()` → `reactContext.getContentResolver().openInputStream(uri)`（`RNFSManager.java:100-115`） |
| `stat` | ❌ **不支持** | `stat` 走 `getOriginalFilepath()`，对 `content://` 用 `MediaStore.Images.Media.DATA` 列反查路径（`88-101`）——该列在 Android 10+ 已废弃，实测必然拿不到 ⇒ `new File(原始uri)` 不存在 ⇒ 抛 `File does not exist` |

而 `readFileBytes`（`3623-3663`）**第一步就是 `RNFS.stat` 拿 size**（`3629`），循环用 `RNFS.read(path, take, pos, 'base64')`（`3640`）。

⇒ **B 档的原生模块只需补 3 个方法**：`statUri(uri) → {size}`、`readUri(uri, off, len) → base64`、`unlinkUri` 可选。
- `readUri` 不能用 `inputStream.skip(position)`（SAF 流不可靠），须用 `ParcelFileDescriptor` + `FileInputStream.skip` 或 `ContentResolver.openAssetFileDescriptor(uri,"r")` 拿 fd 后 seek。
- 超大书（>24MB，`OVERSIZED_RAW_BYTES`）仍可沿用现有 `.gxbook` 缓存机制，只需把缓存写到 app 内部目录。

**B 档连带项** = 第四节 1/2/3/4/6（1/2 是真阻塞：外部文件被改名/删掉，用户数据会脱挂/被级联清除；须引入 `link_target`/断链豁免）。

**B 档收益**：真正零拷贝、外部文件改动可检测（重解析）、用户删 App 不影响书。
**B 档代价**：原生模块（~120 行 Kotlin）+ DB 加列 + 下架清扫重构 + 一整套真机验收。**跨平台**：iOS 上 `RNFSExternalDirectoryPath = [NSNull null]`（`RNFSManager.m:972`），`getBooksRootPath()` 回落 `DocumentDirectoryPath` ⇒ iOS 只能走拷贝，等于要维护两条导入路径。

### C 档：接受 `MANAGE_EXTERNAL_STORAGE`

若接受 Play 审核被拒风险（且需为中文渠道单独说明），可直连 `/sdcard/Download`。
但**仍不解决「链接建不出来」**（3.2/3.3），只能配 A 档的 move 语义或继续拷贝 ⇒ **相比 B 档无收益**。

---

## 六、推荐

**先做 A 档，立刻可做、风险最低、把双份拷贝降为一份并修掉 cache 残留**。

B 档是「真·不拷贝」的唯一可行路径，但它解决的是一个**当前并非痛点**的问题：现状拷贝一次，用户感知是「导入稍慢 + 占一点空间」。而 B 档要付出原生模块 + 下架清扫重构 + 双平台双路径 + 一整套真机验收。

**需用户拍板的决策点**：
1. 是否接受 Play 政策风险（若接受，C 档也不解决问题 ⇒ 实际等价于「不要 Play」）。
2. B 档是否值得——关键在「外部文件被改名/删除时不丢用户数据」这条保障能否做到（能做到则值得）。
3. 若 iOS 必须同等支持，B 档成本翻倍。

---

## 七、证据文件

| 文件 | sha256 |
|---|---|
| `probe-00-first-attempt.sh` | `5f01ab50d6fadad6ca933a9af8049a410c6f37a97c2506cfb7ecee0581b6e07b` |
| `probe-01-symlink-capability-matrix.sh` | `b89c98a0bbd66344550b7abed65ff3430080b0182a0164f9d0eb87f637d6af34` |
| `probe-02-variable-separation-2x2.sh` | `825c465ba49cd67da4577dbcc1d62d297f2dcc597eee74931f749155a2da8bbf` |
| `probe-03-hardlink-and-mounts.sh` | `2818d3f775eda971f036c8edf69006467f75a1539d7ea97998b24a05d8dd7491` |

设备侧实验后已核 `guoxue-books/` 恢复基线（仅含 `builtin/`），所有 `_s*`/`_probe_*`/`_l_*`/`_hl_*` 临时项已删除。