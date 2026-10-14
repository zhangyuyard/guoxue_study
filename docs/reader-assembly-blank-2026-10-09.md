# ⑫ 装配空窗 —— 根因、修复与真机 A/B 验收

日期：2026-10-09 ｜ 仓：`guoxue_study_app` ｜ 设备：ALT-AL10（Android，物理 1080×2504，px=3.125）｜ 包名：`com.guoxue.studyapp`

---

## §0 摘要

| 项 | 结果 |
|---|---|
| 症状 | 换章/开书时正文区**长时间空白且三个占位分支全被穿过**（无「加载中」提示） |
| 真根因 | `ReaderScreen.tsx` 两处**渲染 memo** 直接调用**无结果缓存**的 `PinyinService.annotate`，且依赖数组含 `segmentsByChapter` ⇒ 填充循环每追加一章即对**全部已载章的全部段**全量重算 |
| 第二因 | `src/utils/pinyin.ts` 的 `CACHE_LIMIT=200` **低于工作集**（实测《资治通鉴》≈155 段/章）⇒ 预热条目被自我淘汰 |
| 修复 | 新增 `src/reader/pinyinLenCache.ts`（章级签名缓存，纯逻辑可 jest 直测）＋ `CACHE_LIMIT` 200→2048 |
| 真机验收 | ≥5 s 同步块 **9 → 0**；max **59 025 ms → 2 731 ms**；空窗 **3/6 → 0/6**（复跑再 0/6 ⇒ 累计 12/12 轮零空窗） |
| 正对照 | 三臂 `chapter-done` 计数 285 / 289 / 289、`fill-slice` 26 / 20 / 20 ⇒ **填充工作量相当**，「零空窗」不是判据打偏 |
| 门禁 | `tsc --noEmit` rc=0；jest **101 套 / 1311 例全绿** |
| 交付包 | `app-release.apk` 73 345 612 B，sha256 `e8fe31ea…`，md5 `61e8618c…`，装机 `2026-10-09 10:53:04` |

---

## §1 判据口径（含本会话抓获的两处「假读数」）

**空窗判据（最终采用）**

```
body_n = #{a11y 节点 | y >= BODY_Y(210) ∧ text 非空 ∧ text 不含占位串}
空窗 ⇔ in_reader_loose ∧ body_n == 0
恢复 ⇔ body_n >= 5
```

`body_n` 与**注音模式无关**，这是它可用的前提。前身脚本用 `cjk_cells(ns)==0`（「单字格数为 0」）判「正文归零」，该判据**只在注音开启时成立**：注音关闭后正文按整段渲染，单字格恒为 0 ⇒ 判据**恒真** ⇒ 一整轮 31.5 s 全被误判成空窗（假阳性）。**教训已入 MEMORY.md 第 78 条。**

第二处：脚本原先用 `latin==0` 判「注音已关」。在 `body_n==0` 时 `latin` 必然为 0（空集）⇒ 这是**退化结论**，与注音开关无关。实测 `b7_after` / `b8_final` 两臂都被它误导。本报告一律在 `body_n>0` 时才报注音态。

---

## §2 根因链

**链（注音开启时）**

1. `ReaderScreen.tsx` 的 `chapterMaxPinyinLen` memo 与 `unifiedPinyinFontSizeByChapter` memo 内联调用 `annotate(seg.text, pinyinMode, {workId, bookId})`（`PinyinService.annotate`）。
2. `PinyinService.annotate` **无结果缓存** ⇒ 每次调用都是真算。
3. 两 memo 的依赖数组含 `segmentsByChapter` ⇒ 章填充循环**每追加一章**就重跑一次，且范围是**全部已载章的全部段**（O(已载章段数)）⇒ 二次复杂度。
4. 实测 3 章 ≈ 465 段 × ~19 ms ≈ **9 s 单次同步块**；无 yield ⇒ RN 无法 commit ⇒ 正文行未挂载（`total=27`，只有顶栏）⇒ 表现为空白。
5. **注音关闭时该路径整体 `continue` 跳过 ⇒ 零成本**（这是「注音关 ⇒ 0/6 轮」的原因）。

**第二因**：`src/utils/pinyin.ts` 的 `prewarmPinyinCache` 写入 LRU，但 `CACHE_LIMIT=200` < 一章段数（≈155）⇒ 预热刚结束就被自己的后续写入淘汰，预热形同虚设。

**曾被怀疑但已证伪**：`TextLibraryService.buildIndexes()` 全库重建。实测 n=49，p50=2 ms，**max=18 ms**；`ftsMs` max=3 ms（且 `[PERF][fts] per-chapter skip … no such module: fts5` ⇒ 本机 op-sqlite 无 fts5，全库 sweep 反复重跑，但注音关闭臂同样有 sweep 却 0 空窗）⇒ **与 ⑫ 无直接因果**。旧记忆条目已作废。

---

## §3 日志括号证据（“墙钟 ≠ 同步块”的定位法）

定位**单一持久同步块**不能只看墙钟（`asmMs`/`commit wall` 都跨 await）。用**日志括号**（前后两条带时间戳的 JS 行）夹逼：

**括号一（9.23 s 零 JS 行）**

```
09:53:17.151  [TMP] stitch=6ms lines=2766          ← 前括号（最后一条 JS 行）
              （9.23 s 内 **零条** JS 行）
09:53:26.381  [PERF][jank] jsBlocked=9253ms        ← 后括号（外置仪器，非本次探针）
09:53:26.381  [PERF][fill-slice] tongjian chapters=1 chaptersMs=1014 heaviestChapter=1014
09:53:27.941  [TMP] commit#5 wall=10810ms renderItemCalls=48 lines=2766 chapters=3
```

**括号二（37.3 s 零 JS 行）**

```
09:53:28.034  [TMP] stitch=6ms lines=2766          ← 前括号
              （37.3 s 内 **零条** JS 行）
09:54:05.223  [TMP] commit#6 wall=37222ms renderItemCalls=24 lines=2766 chapters=3
09:54:05.263  [PERF][jank] jsBlocked=37336ms
09:54:05.457  [TMP] fill ch=tongjian-c4 chapterMs=39076 asmMs=39072 ftsMs=3
```

**旁证（OS 级、与 JS 无关的第二观测面）**：空窗期逐线程 CPU（`/proc/<pid>/task/*/stat` 的 `utime+stime`，jiffies，USER_HZ=100；JS 线程名 `mqt_v_js`）

| 空窗 | 墙钟 | JS 线程占用 |
|---|---|---|
| #0 | 12.0 s | **99 %**（11.87 s） |
| #1 | 16.5 s | **99 %**（16.36 s） |
| #3 | 3.2 s | **94 %**（3.04 s） |

⇒「JS 线程独占 + 窗内零 JS 行 + 正文行未挂载」三点同时成立，才判定为「同步块导致的空窗」。

---

## §4 单变量 A/B（同一判据，唯一变量＝注音开关）

| 臂 | 空窗轮次 | JS 线程占用 |
|---|---|---|
| 注音**开**（修复前） | **4/6 轮进入**（3 轮窗内恢复：12.0 / 16.5 / 3.2 s；1 轮 40 s 窗内未恢复） | 94–99 % |
| 注音**关**（修复前） | **0/6** | 24–54 % → 3 % |

⇒ 判据本身有检测力（开/关两侧读数分化），「注音关 0/6」不是假 0。

---

## §5 修复内容

| 文件 | 改动 | sha256 |
|---|---|---|
| `src/reader/pinyinLenCache.ts` | **新增**：`chapterSegSignature()`（段数｜总长｜首段 id｜末段 id）+ `createChapterMaxPinyinLenStore()`（键 `cid::mode::salt`，一 store 一书） | `95a9075f031baa03ead02205d9aa995ccc7722ab57933d54da4951471b9dbe4d` |
| `src/screens/ReaderScreen.tsx` | 删除内联全量重算；改经 `pinyinLenStore.of()`；`unifiedPinyinFontSize` 直接取自同一映射 | `c601526811843d6c487e9425b837a75360e5f1d25ad0785b94483e6cbe0ce8ed` |
| `src/utils/pinyin.ts` | `CACHE_LIMIT` 200 → **2048** | `7cc2c9e3d4a4c2d43c5c909656726700f54f894bc7d7ba4b2a868c394c54a96c` |
| `src/__tests__/pinyinLenCache.test.ts` | **新增** 13 例（含 1 例补缺口，见 §8） | `7c21605c2b3d879dc732935d545838f64e440cb07a26bb1dca121b3fc8ff142c` |
| `src/__tests__/deviceTier.test.ts` | 微基准断言改为非计时判据（原 `probeMs > 0` 亚毫秒合法为 0 ⇒ 同码可红可绿） | `54a50e12a1f1e939a0ad14e072b9a8b5b9112947b8bec7970e30332e1b32a9ba` |

`CACHE_LIMIT` 依据：本缓存**按整段**记条目，实测《资治通鉴》≈155 段/章；保留集可达 6~13 章 ⇒ 工作集 ≈900~2000 段，远超 200。

---

## §6 修复后真机验收

### 6.1 三臂对比（同脚本、同判据、同注音态「开」）

数据源：本机后台 `adb logcat -v epoch` 连续日志（`/tmp/b3_full.log`），按装机时刻分桶；`[PERF][jank]` 是**产品内既有仪器**，不是本会话探针。

| 臂 | 窗口 | `chapter-done` | `fill-slice` | jank n | max | ≥5 s | ≥1 s | Σ |
|---|---|---|---|---|---|---|---|---|
| 修复前（探针版） | 10:19:00–10:27:00 | 285 | 26 | 63 | **59 025** | **9** | 10 | 213 331 ms |
| 修复后（探针版） | 10:41:00–10:48:00 | 289 | 20 | 31 | **2 999** | **0** | 3 | 20 381 ms |
| 终态（干净版） | 10:53:20–10:59:50 | 289 | 20 | 30 | **2 731** | **0** | 3 | 19 633 ms |

**关键读法**：`chapter-done` / `fill-slice` 三臂几乎相同 ⇒ **填充工作量相当，判据没有打偏**；而 ≥5 s 块 9→0→0、max 59.0 s→2.7 s。p50 基本不变 ⇒ 典型块没变，**只消掉了病态长块**。

### 6.2 空窗与复现性

| 臂 | 构建 | 空窗命中 |
|---|---|---|
| 修复前 | 探针版 | 4/6 轮进入 |
| 修复后 | 探针版 | **0/6** |
| 终态 | 干净版 | **0/6** |
| 终态·同位复跑 | 干净版 | **0/6** |

⇒ 两次独立复跑共 **12/12 轮零空窗**（同位副本复跑＝可复现性验收）。

---

## §7 首开装配期独立测量（不凭「滚动期 0/6」就结案）

在 `b7_after` / `b8_final` 两臂里，`wait_ready + locate_book + 8 s` 这一**单次**静止态普查读到 `body_n=0 / total=27`（与空窗同形签名）；而终态**同位复跑**同点读到 `body_n=344 / cjk=159 / latin=73 / total=386`（健康）。

⇒ 该单点读数是**间歇性**的，不能据此判「首开仍长空白」。改用**细粒度轮询**独立量（`b10_firstopen.py`，冷启后自 `locate_book` 起每 ~1 s 采样一次、共 120 s）：

```
[  0] t=+  0.0s in_reader=True body_n=   0 total=  24   ← 书架→阅读器 过渡帧（唯一空白样本）
[  1] t=+  2.6s in_reader=True body_n= 344 total= 386   ← 已恢复
[  2] t=+  5.5s … [ 41] t=+117.2s    body_n 恒为 344，total 恒为 386
采样数=42  空白样本=1 ⇒ 空白占比 2%
```

**结论**：首开过渡帧空白 **≤2.6 s**（1 个采样点），随后 117 s 稳定；对比修复前滚动期空窗 12.0 / 16.5 s。滚动期 12/12 轮零空窗见 §6.2。

---

## §8 变异自证（11 处；每处点名应红判据）

对 `src/reader/pinyinLenCache.ts` 做定点变异、跑其单测；每处跑完**逐字节还原并核 sha256**。

| # | 变异 | 结果 | 应红判据 / 实测红项 |
|---|---|---|---|
| M1 | 去掉章签名校验（缓存只看键） | **红** | 「章内容变化 ⇒ 重算并返回新值」 |
| M2 | 缓存键去掉 `mode` | **红** | 「注音模式变化 / 多音字来源盐变化 ⇒ 均失效重算」 |
| M3 | 缓存键去掉 `salt` | **红** | 同上 |
| M4 | 缓存提升为模块级共享 | **红** | 「★ 跨书隔离：一 store 一书」 |
| M5 | 不再累计 `computed` | **红** | 「★ 同章同内容重复取 ⇒ 注音调用 0 次」 |
| M6 | `len > max` 改 `len >= max` | 未红 | **等价变异**（`len == max` 时赋值同值、无副作用） |
| M7 | 签名丢弃末段 id | **红** | 「段数/总长/首末段 id 变化 ⇒ 签名变化」 |
| M8 | 空章签名改成空串 | **红** | 「空章 ⇒ 稳定签名且不抛」（期望 `0|0||`） |
| M9 | 忽略 `res.success`（直接用 `res.data`） | 未红 | **等价变异**：已核真实生产者 `src/utils/pinyin.ts` 的 4 处 `return`，失败支只返回 `{success:false, error}`、**不带 `data`** |
| M10 | 不再向注音透传 `bookId` | 首轮**未红 ⇒ 真缺口** | 补断言后重跑 ⇒ **红，且仅新用例红（1 failed / 12 passed）** |
| M11 | `clear()` 不清 `computed` | **红** | 「clear() 后重新计算」 |

**M10 的意义**：`annotateText` 的 `cacheKey` 把 `{workId, bookId}` 并入缓存盐 ⇒ 丢 `bookId` 会让本 store 的注音调用与 `prewarmPinyinCache` / `PinyinText` **不同参** ⇒ 预热静默失效（性能回退、功能照常 ⇒ 不报错不红灯）。已补断言：

```
★ 必须把 workId/bookId/盐 一并透传给注音（否则与预热、渲染侧缓存键不同参 ⇒ 静默失去缓存）
```

**还原自证**：11 处全部跑完，`final_sha256 == orig_sha256`（`1dae4e4a472f594ac786d4788a053063bb49debf947f9f8d6483b3c80d86ed29`）；锚点回退为 1 的次数 = 11。

> `pinyinLenCache.ts` 现行 sha256 为 `95a9075f…`（≠ 上述 orig），差异**仅在文件头注释内的一处数据声明**：原文写「注音开启 ⇒ 4/4 轮复现」，与实测（6 轮中 4 轮）不符 ⇒ 已改正。该改动经 **babel 转译逐字节比对**证明**编译输出不变**：改前/改后 `transformFileSync` 结果长度均 1261 B、sha256 均 `8d9015249a03e6c1905952ed0b9a94226b7bffcfdbef951ed7c6cf853b138a51`。同理 `pinyinLenCache.test.ts` 不在 bundle 内 ⇒ **已装机的 APK 仍是有效交付物，无需重打包**。

---

## §9 门禁与产物自证链

| 项 | 读数 |
|---|---|
| `npx tsc --noEmit` | rc=0，0 行输出 |
| 全量 jest | **101 套 / 1311 例全绿**（86.9 s） |
| `pinyinLenCache` 单套 | 13/13 绿 |
| APK | 73 345 612 B，sha256 `e8fe31ea789bfa53b66a4b61ba68dd0677c51b9516d4448e7b391f04981e6f9a`，md5 `61e8618cce0476ec1a66a0a5504ac95d` |
| 推送比对 | 本机 md5 ≡ 设备 `/data/local/tmp/final.apk` md5 |
| 装机 | `pm install -r -t` ⇒ `Success`；`lastUpdateTime=2026-10-09 10:53:04` |
| bundle | `assets/index.android.bundle` 4 903 864 B，sha256 `942758d9c8f52e8b5414e825b3f57710647833020889cc4d4195685a2903432c` |

**包内自证（解包后双向计数：utf8 + utf16le）**

| 串 | utf8 | utf16le | 合计 | 期望 |
|---|---|---|---|---|
| `[TMP]`（探针标记） | 0 | 0 | **0** | 0 ✅ |
| `computedSegments` | 1 | 0 | 1 | ≥1 ✅ |
| `chapterSegSignature` | 1 | 0 | 1 | ≥1 ✅ |
| `createChapterMaxPinyinLenStore` | 1 | 0 | 1 | ≥1 ✅ |
| `prewarmPinyinCache` | 1 | 0 | 1 | ≥1 ✅ |
| `[PERF][fill-slice]`（**正对照**） | 1 | 0 | **1** | =1 ✅ |

正对照命中 ⇒ 计数法有检测力，「`[TMP]`=0」不是假 0。**干净版已不含任何临时探针。**

---

## §10 路径更正

上一轮的 A/B 报告**并非「未落盘」**：`reader-gesture-toc-ab-2026-10-09.md` 在**仓内** `guoxue_study_app/docs/`（此前在**工作区根**检索 ⇒ 假 0；本仓有两个 `docs/`，inode 不同，且工作区根无 `.git`）。该报告 §五已登记 A 臂探针 sha `5a70afc0…`，但**探针文件本体确实未归档**（重跑 A 相需按 sha 反推或改用 B 相 + 老包）。归档目录 `guoxue_study_app/deliverables/a30-2026-10-09/`（12 文件）对 `/tmp` 同名文件 sha 逐字节一致——曾被 `.gitignore:37 deliverables/*` 忽略导致检索落空。

---

## §11 未结案 / 待拍板

**待拍板（只列不删，等确认）**

| 对象 | 证据 |
|---|---|
| `src/reader/core/modes/tapRegions.ts`（3 195 B）+ `src/__tests__/tapRegions.test.ts` | 全仓消费者仅：该测试自身的 `import`（第 27 行）、`ScrollMode.tsx:14` 的一条注释。**零生产侧调用**（上一轮已按「滚动模式取消点击翻页」删掉调用方） |
| `src/store/useSettingsStore.ts` 的 `resolveReaderSetting`（:539）/ `useReaderBookSettings`（:589） | 仅被 `useSettingsStore.test.ts` 引用；`useReaderBookSettings` **零引用** |
| `src/store/useReaderStore.ts:231-247` 的 `annotateSegment` / `getAnnotation` / `annotationCache` | 全仓（含测试）**零消费者**；正是「预注解注入」这条未接线的性能方案 |

**未动**

- ① footer 部分场景 y 偏下 ~100 px（JS/native 分叉 ~33 dp）
- ⑤ 风险 A（低危，暂搁置）：`ReaderScreen.tsx` 的 `needPrev = opts?.forcePrev === true || loadedChapters[0] === activeChapterId`
- ⑪ 症状①：跨章前插后一次性 `scrollToOffset` 补偿（≈1.5 次/手势、116–629 px、滞后中位 18 / P90 62 / max 395 ms）——机理已定量，**未改行为**；本机无 `gfxinfo`/`screenrecord` ⇒ 帧级证据不可得
- ⑬ 跳章后立即按键可能漂回上章（P5 2/2）——需先造可复现按键时序
- ⑦⑨ 0.74 期遗留真机项，须整体重验
- iOS（CocoaPods 缺失，未过）
