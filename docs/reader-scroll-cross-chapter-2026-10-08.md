# 滚动模式「翻页 + 加载」两条根因级缺陷 —— 修复与真机验收（2026-10-08）

范围：**仅滚动模式的翻页与跨章加载**。拼音、通假字等附加元素未在本轮改动。
设备：ALT-AL10 / Android，物理 1080×2504，px=3.125；包名 `com.guoxue.studyapp`（release，`pm install -r -t` 覆盖装）。
测试书：道德经（81 章、平均约 6 行/章 —— 短章书是本次两条缺陷的放大器）。

---

## 一、缺陷 ⑤：跨章裁剪把窗口裁到「不足一屏」⇒ 原生把滚动位置钳到 0

### 症状（真机）
下滚过程中每 3–4 次滑动突然**跳回已载窗口顶部**、章节栏回跳、顶部露出「上一章加载中…」占位。

### 证据链（临时探针，已撤净）
```
[commit] ch=daodejing-c60 … active=daodejing-c59
[win]    daodejing-c59|c60|c61                     ← 窗口被裁到 3 章 = 18 行
[comp]   prevLen=103 nextLen=18 aIdx=62 nextIdx=7 delta=-1595 off=1847.0
[comp]   prevLen=18  nextLen=25 aIdx=7  nextIdx=7 delta=0     off=252.0
[commit] ch=daodejing-c59 … active=daodejing-c60    ← 反向提交（位置已丢）
[comp]   prevLen=25  nextLen=25 aIdx=0  nextIdx=0 delta=0     off=0.0
```
- 补偿算式**正确**：锚行 62→7、`delta = (7−62)×29dp = −1595`、记账 `target = 1847−1595 = 252`。
- 但随后原生 `y = 0` ⇒ 说明问题不在补偿。
- 真因：保留集固定为 `{prev, cur, next}` 三章；短章书三章 ≈ 18 行 < 一屏（≈22 行）
  ⇒ **裁剪瞬间 `contentH < viewportH` ⇒ 原生 `maxScroll = 0`，offset 必被钳到 0**。
- 同族：铁律 60（**记账＝意图值 ≠ 原生实值，须拿实值对账**）。

### 修复
| 文件 | 改动 |
|---|---|
| `src/reader/chapterWindow.ts` | 新增纯函数 `retainIdsByBudget(centerId, order, lineCountOf, budgetLines)`：从中心向两侧交替扩张累加行数，直到 ≥ 预算或链耗尽；中心恒留；行数取不到按 0 计（只会多留不会少留）。 |
| `src/screens/ReaderScreen.tsx` | 新增 `retainForScrollCommit`（预算 = `SCROLL_WINDOW_KEEP_SCREENS(6) × lpp`，`lpp = floor(viewportH / rowHeight)`；几何未就绪或中心不在已载链内时退回三章策略）；跨章提交由 `retainSetFor(chapterId)` 改为 `retainForScrollCommit(chapterId)`。**跳章清窗路径仍用三章**（阴性对照用例锁住）。 |

### 验收
| 量 | 修前 | 修后 |
|---|---|---|
| 裁剪后窗口行数 | 18 | 135–148（22 章） |
| `[end] y=0` 回跳 | 每 3–4 次滑动一次 | 0 次（仅全书首尾越界时 y=0，属正确） |
| 顶部占位「上一章加载中…」出现在屏上 | 有 | 无 |

---

## 二、缺陷 ⑥：到达已载窗口末端后「永不再装载」

### 症状（真机）
底部占位恒为「继续滑动以加载下一章…」，但**连滑 8 次画面零变化**；`[end] y=3505.3` 每次完全相同。

### 根因（两条，互相独立）
1. 位置到达内容末端后**原生不再派发 `onScroll`**，而边沿装载判据只挂在 `handleScroll` 里 ⇒ 判据永不执行。
2. 「临近末端」用「进区一次、出区重置」去重；一次装载只把末端下推约一章（≈200dp），
   而用户一次滑动 >1000dp ⇒ 判据**永久为真、永不出现「出区」** ⇒ 不会二次触发。

### 修复
`src/reader/core/modes/ScrollMode.tsx`：抽出 `fireBoundary(y)`，**由 `handleScroll` 与 `handleScrollEnd`（拖拽/动量结束）双路径驱动**；
新增可重复触发判据 `atEnd`（`y ≥ totalH − viewportH − 1`）/ `atTop`（`y ≤ 1`），严格到末/起点时每次拖拽结束都可重试。
重复发起交给窗口层 `windowBegin` 去重闸门保证 —— **不在本层再设「已发起」旗标**（那是铁律 68 记录过的第二层拦截老毛病）。

### 验收（干净包，真机）
- 下滚 8 次：第一章 → 6 → 13 → 17 → 20 → 25 → 27 → 28 → 30；继续下滚 14 次直达 **第八十一章（全书末章）**。
- 上滚：末章 → … → 27 → … → **第一章**（书首 `hh=0`，证明「再无上一章」）。
- 全程章号单向推进、无回跳、无占位、截图像素墨量恒 1250–1310 行（满屏）。

---

## 三、回归复核（缺陷 ④ 首帧空白）

截图像素判据（`ink.py`：逐行墨量与背景差异 + 视口 8 段分布）：

| 取样 | ink_rows / 2140 | 8 段分布 |
|---|---|---|
| **启动瞬间（阴性对照）** | **0** | 全 0 —— 证明判据能检出空白 |
| 开书后 t≈0.45s | 1679 | 全段有墨 |
| 开书后 t≈1.2s | 1679 | 全段有墨 |
| 开书后 t≈3.0s | 1289 | 全段有墨 |

⇒ **首屏为满屏正文，无大片空白**。

点按分区（物理宽 1080，`edgeRatio = 0.3` ⇒ 左区 x<324、右区 x>756）：

| x | 结果 |
|---|---|
| 900 / 760（右区） | 前进一屏（`deltaY −1790 / −1812` ≈ 1950px ≈ 21 行），**未进查词页** |
| 180 / 300（左区） | 回退 |
| 540（中区） | 不动 |

---

## 四、门禁与自证

- `npx tsc --noEmit`：**0 错**。
- `npx jest`：**97 套 / 1266 例全绿**（`find src -name '*.test.ts*' | wc -l` = 97 = 套数）。
  ⚠ 旧记「95 套 / 1232 例」已过期：工作树另有未跟踪新文件 `tapRegions.test.ts`、`scrollAnchor.test.ts`、`sqliteClient.nativeParams.test.ts`。
- 新增用例：`retainIdsByBudget` 6 例（chapterWindow.test.ts）+ 接线断言 2 例（scrollLoadRetry.test.ts）。
- 变异自证（逐项一次只动一变量，还原后 sha256 一致）：

| 变异 | 结果 |
|---|---|
| M1 跨章提交退回 `retainSetFor(chapterId)` | 1 红（接线） |
| M2 `SCROLL_WINDOW_KEEP_SCREENS` 6 → 1 | 1 红（接线） |
| M3 `retainIdsByBudget` 只留中心、不扩张 | 4 红（单测） |
| M4 去掉 `handleScrollEnd` 里的 `fireBoundary` | 1 红（接线） |
| M5b 删 `atEnd` 的使用块 | 1 红（接线） |
| M6 删 `atTop` 的使用块 | 1 红（接线） |

- ⚠ **M5 首版断言是「死常量式」假判据**：仅断言 `const atEnd = …` 声明行，删掉其 `if` 使用块仍全绿 ⇒ 已改为断言**使用处**并重验。
- 包内符号双向计数（Hermes，必加 `-a`）：`DBGZ` ascii=0 / utf16le=0（探针零残留）；`retainIdsByBudget`=1（新码在场）；
  正对照 `charTapIntercept`=1、`onPressChar`=1。局部标识符 `SCROLL_WINDOW_KEEP_SCREENS`=0 属压缩所致，**不作判据**。
- 装机链：`adb push` → 设备端 `sha256sum` 与本地逐字一致 → `pm install -r -t` **Success** → `am force-stop` 冷启 → 采样。
- 终版 APK sha256：`475fb74052ef33d2de17d215de579d0fd27c8d3dc821642ca764c0263a726d11`。

---

## 五、残留（未修，量化留档）

| 项 | 量 | 说明 |
|---|---|---|
| FTS 后台装配期间的 JS 占满 | `[PERF][asm] paused reason=ftsCheckpoint gate=off` × 38；`[PERF][jank] jsBlocked` 7 次：302 / 377 / 437 / 635 / 759 / 912 / 923 ms | 设备档位 `tier=low`（modelTable 判定）。**「加载期卡顿」的现存来源**，属独立专项（asm 队列分片让出）；本轮未动。 |
| 跨章装载失败 / 重试 | **0 命中** | 加载链路无失败、无重试 |
| 注音关时点字 | 无 press 处理 | `PinyinText` 纯文本降级分支无 onPress/onLongPress ⇒ 既不查词也不划线。附加元素，按用户指令本轮不动。 |
