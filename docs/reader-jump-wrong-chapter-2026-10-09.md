# 跳章错章与「加载完成后跳动」——根因与修复（2026-10-09）

> 适用版本：RN 0.83 真机（ALT-AL10 / Android，物理 1080×2504，px=3.125）
> 包名 `com.guoxue.studyapp`。全部结论来自黑盒轨迹（无障碍树）＋运行期 `logcat` 探针双观测面互证。

---

## 0. 两个待解问题（用户报告原文）

1. 《荀子》跳转到「致士」→ 顶部出现加载提示 → 加载完成后当前显示章节变成上一章「臣道」；
   并且手动滚动到「致士」后，导航栏仍显示「臣道」。
2. 在章节加载完成后会出现跳动，是什么原因，能否根除。

---

## 1. 判据与量法（先声明，避免跨报告口径混淆）

| 量 | 定义 | 采集面 |
| --- | --- | --- |
| `chap` | 顶栏中「非书名/非返回/非导航」的那一条文本 ＝ `loaded.chapter.title` | `uiautomator dump` |
| `body_top` | `y ≥ BODY_Y`(=210) 的第一条非占位正文文本 | 同上 |
| `body_n` | `y ≥ BODY_Y` 非占位正文节点数（**空窗判据**，与注音开/关无关） | 同上 |
| `y / geoIdx / ownerIdx / len` | 原生 `contentOffset.y`、几何顶行、归属行、当前 `lines.length` | `[TMP]` 探针 |
| `contentH / clines / fresh` | 原生内容高、其对应的 `lines.length`、是否新鲜 | 同上 |

★ **单位**：`viewportH` 与 `contentH` 同为 **dp**（实测 672 / 22678），
`maxScroll = contentH − viewportH`。本轮我曾按 px（2222）算过一次，
得出「钳制 1550px」的**假归因**（见 §5）。

★ **仪器上限**：`uiautomator dump` ≈ **2.7s/次** ⇒ 无障碍树**无法高频采样**。
「跳动」类判据只能走运行期 `logcat`；黑盒只能判「顶栏/正文在稳态是否一致」。

---

## 2. 黑盒复现（干净包，无探针）

`/tmp/b24_ab.py`，每臂前 `pm clear`（清 `lastRead`，保证起点≠目标章）：

```
T0 冷启落点 chap='劝学' body_n=262 body_top='劝学'
[toc] 命中「致士」@y=2231（扫 1 次）
[setup] 跳章「致士」=True OK
   + 2.420s chap='致士' body_n=   0 top=''        ← 空窗（装配中）
   + 5.513s chap='臣道' body_n= 266 top='chēng'    ← 顶栏与正文都退到上一章
  稳定态 +11.0s / +13.9s / +16.5s 均 chap='臣道'   ⇒ 持续错章，不自愈
```

对照：同脚本跑**探针包**（`b29_probe.log` 同轮）复现同一现象
（`+5.398s chap='臣道' body_n=266 top='chēng'`）⇒ 黑盒判据有检测力。

---

## 3. 运行期序列（决定性证据，`/tmp/b31_v4.log` 16:54）

```
16:54:54.483 JUMP cid=xunzi-c14 prevCenter=xunzi-c14 active=xunzi-c1
16:54:54.801 INIT-IDX active=xunzi-c14 first=0 within=0 stitchedLen=98
16:54:54.802 MOUNT  ch=xunzi-c14 initIdx=0 idx=0 lines=98 headerH=44 offRef=0
16:54:56.857 INIT-IDX active=xunzi-c14 first=178 within=0 stitchedLen=706
16:54:57.100 COMP   prevLen=98 len=706 anchorIdx=0 nextIdx=178 delta=8900
                offRef=0 target=8900 contentH=4988 clines=98
16:54:57.100 APPLY  target=8900 real=8900 contentH=0 fresh=false   ← JS 投递 8900
16:54:57.30? CS    h=35388 grew=true target=8900 real=8900 retry=1
16:54:57.31? APPLY  target=8900 real=8900 contentH=35388 fresh=true
16:54:57.306 SCROLL y=4316.4799 geoIdx=85 lineCh=xunzi-c13 committed=xunzi-c14
                pending=null                        ← ★ 原生只落到 4316
16:54:57.306 COMMIT-OUT xunzi-c13 ownerIdx=86 geoIdx=85
16:54:57.306 COMMIT-RR  ch=xunzi-c13 active=xunzi-c14 takeBranch=true
```

### 根因链（**补偿被丢弃**，不是「差一行」）

1. 跳章 `xunzi-c14`（致士）⇒ `MOUNT … offRef=0 / idx=0`（章首，未读 ⇒ `within=0`）。
2. 邻章 `xunzi-c13` 就位 ⇒ `lines` 98 → 706 ⇒ 锚行 0 → 178 ⇒ `delta=8900`。
3. JS 侧 `APPLY target=8900 real=8900`（**投递正确**），但原生把 offset 落到
   **4316**（差 4583px ≈ **102 行**）——`scrollToOffset` 在布局未稳时被**静默丢弃**
   （与本文件头 `userScrolledRef` 注释里的既有实证同源）。
4. 补偿目标被**提前宣告落定**（见 §4）⇒ 不再复投 ⇒ 视口停在 `geoIdx=85`，
   该行属 **`xunzi-c13`（臣道）** ⇒ 顶栏与 store 一起被改写，且视口不再移动
   ⇒ **永不自愈**。

⚠ 顶栏与正文**同时**错（`body_top='chēng'` 是臣道首字）⇒ 必在**视口定位**层，
不在「顶栏取值」层。

---

## 4. 补偿为什么被丢弃（三处判据，逐个修正）

| # | 原判据 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `onContentSizeChange` 里 **`!grew`（内容高未增长）＝ 目标不可达** | 跳章时 `lines` 一步到位（98→706）后 `contentH` 不再增长 ⇒ 第一次回调就丢弃补偿 | 放弃判据改为**重投次数** `COMP_TARGET_MAX_RETRY=8` |
| 2 | **`real >= target` ＝ 已落定** | 只证明「原生**能容纳**」，不证明「offset **已**到位」⇒ 原生丢弃后目标被清、永不重投 | `onContentSizeChange` **只复投、绝不宣告落定**；落定权只在 `handleScroll`（实测 `y` 与 `expect` 差 ≤ `rowH`） |
| 3 | 落定前**不再复投** | 原生丢弃 ⇒ 用户不动 ⇒ **再无 `onScroll`** ⇒ 无处重投 | 新增**续投节拍** `scheduleCompRetry`（`COMP_PENDING_MAX_MS/2`＝250ms），由定时器持续复投直到落定或次数用尽 |

**修后真机序列**（`/tmp/b33_v5.log`，与 §3 同条件）：

```
COMP  target=8900
APPLY real=8900 fresh=false          ← 首次投递（布局未稳）
CS    h=35388 retry=1                ← 内容高到位，复投
APPLY real=8900 fresh=true
RETRY target=8900 n=2 offRef=4316    ← ★节拍捕获「原生只落到 4316」并再投
APPLY real=8900
SCROLL y=8900.16 geoIdx=177 lineCh=xunzi-c13 committed=xunzi-c14   ← 落定，无 COMMIT-OUT
```

⇒ `RETRY` 是决定性的一步：没有它就停在 4316（= v4 行为）。

---

## 5. 我在本轮推翻的三个假设（防止重犯）

| # | 假设 | 怎么被推翻 | 教训 |
| --- | --- | --- | --- |
| 1 | 错章＝章归属行对亚像素零容差（`idx=150` 判成 `149`） | 干净包上「归属 +1 行」**未通过验收**：`body_top` 实为 `chēng`（正文也退到臣道，不是顶栏单独错） | 顶栏与正文**同时**错 ⇒ 一定在**视口定位**层，不在「顶栏取值」层 |
| 2 | 错章＝装配空窗期 `y` 越界被钳到末行 | 加「越界 ⇒ 放弃提交」护栏后**仍复现** | 越界确实该防，但**不是本条主链**（护栏已保留，作为副防御） |
| 3 | 跳动＝补偿超 `maxScroll` 被钳制 1550px | 单位算错：`viewportH` 是 **dp(672)** 不是 px(2222) ⇒ `maxScroll = 22678−672 = 22006 = target`，**根本没有钳制** | 算几何前先在真机日志里找一处**已知量**反推单位 |

---

## 6. 「跳动」的机理与可根除性

「跳动」＝**数据位移补偿的一次性 `scrollToOffset`**。真机量法（`[TMP] COMP/APPLY/RETRY`）：

- 跳章落章首 + 邻章前插 ⇒ 锚行位移 `delta=8900`（≈198 行）⇒ 一次性瞬时 `scrollToOffset`；
- 原生**丢弃首次投递** ⇒ 节拍在 250ms 后**再瞬移一次** ⇒ 用户看到「内容向下一窜、再回位」；
  这正是「加载完成后跳动」。

**可根除，但需要原生侧配合**：把「丢弃」变成「排队」——
RN 的 `scrollToOffset` 在布局未稳时被静默忽略，本仓只能靠**定时器重投**兜底
（已做，`RETRY`）。若要彻底无跳，需改为「`onLayout` 后投递一次」或用
`maintainVisibleContentPosition`（RN 官方为「内容变化保持可见位置」提供的属性），
**属改形状，须先跑冻结红线套**（MEMORY 50–54），本轮不做。

⇒ 结论：**跳动与错章同源**（都是补偿未一次到位）。错章已根除；
跳动已从「落错 102 行」收敛为「250ms 后二次瞬移到正确位置」，
彻底消除需改用官方保位属性（待拍板）。

---

## 7. 修复清单（`src/reader/core/modes/`）

| 文件 | 改动 | 目的 |
| --- | --- | --- |
| `scrollAnchor.ts` | 新增 `viewportOwnerIndexAtContentY` | 归属行 = 顶行+1；**越界钳制时返回 `null`**（不提交/不记账，副防御） |
| `scrollAnchor.ts` | 新增 `clampScrollTarget` | 补偿目标 → 原生**实落点**（按 `maxScroll` 钳制；`contentH<=0` 不钳制） |
| `ScrollMode.tsx` | `contentHRef` + `contentLinesRef` **新鲜度闸门** | 内容高与「当前数据长度」不匹配 ⇒ 视为未知(0) ⇒ **不用旧数据自造钳制** |
| `ScrollMode.tsx` | `compTargetRef`（目标态）**与** `pendingCompRef`（记账抑制）**分离** | 「记账抑制超时」不再等于「补偿放弃」 |
| `ScrollMode.tsx` | `onContentSizeChange` **不复投即不宣告落定**（§4-②） | ★ 根因修复之一 |
| `ScrollMode.tsx` | **`scheduleCompRetry` 续投节拍**（250ms，上限 8 次）（§4-③） | ★ 根因修复之二（`RETRY` 是决定性一步） |
| `ScrollMode.tsx` | `handleScroll` 超时未到位 ⇒ **再投一次**并续节拍 | 补齐「用户不动 ⇒ 无事件」的唯一触发点 |
| `ScrollMode.tsx` | 记账用 `clampScrollTarget` 结果（**实值**） | 偏差不进入下一次补偿基线 |

### 单测（`src/__tests__/scrollAnchor.test.ts`，20 → 25 例）

新增 `viewportOwnerIndexAtContentY` 5 例、`clampScrollTarget` 4 例。

### 变异自证（每条都实测会红）

| 变异 | 红条数 | 对应用例 |
| --- | --- | --- |
| `chapterOwnerIndex` 退化成恒等（不做 +1） | 2 | 章界 149→150 |
| `clampScrollTarget` 不钳制（恒返 target） | 2 | 超 `maxScroll` |
| `clampScrollTarget` 终值错（`maxScroll−1`） | 3 | 钳制 + 不误钳 + 短内容 |
| `clampScrollTarget` 把 `contentH<=0` 也钳成 0 | 1 | 首次投递不吞 |
| 去掉越界 `null` 判据（只留 `raw<0`） | 2 | 机理②越界钳制 |

---

## 8. 验收

**干净包**（无任何探针）：`[TMP]/MOUNT/COMP/APPLY/RETRY/COMMIT-OUT/OWNER-NULL` 包内计数
**全 0**，同范围正对照 `[PERF][fill-slice]`=1 ⇒ 计数有检测力。

- APK 73 347 236 B／sha256 `a052260c…`／md5 `b4f6e9b9…`（本机 ≡ 设备侧）
- 装机 `lastUpdateTime=2026-10-09 17:06:20`
- `tsc --noEmit` rc=0；jest **101 套 / 1324 例全绿**
- `ReaderScreen.tsx` 与探针前基线**逐字节相同**（sha `c6015268…`）⇒ 探针零残留

### 黑盒验收（`/tmp/b24_ab.py`，每轮前 `pm clear`）

| 轮次 | 起点 → 目标 | 变化点 | 稳定态 | 判定 |
| --- | --- | --- | --- | --- |
| v3（修1+越界护栏） | 劝学 → 致士 | 2（`+5.5s` 变臣道） | `chap='臣道'` | ❌ 未修复 |
| v4（+重试计数） | 劝学 → 致士 | 2（`+5.3s` 变臣道） | `chap='臣道'` | ❌ 未修复 |
| v5（+落定权移交+续投节拍，带探针） | 劝学 → 致士 | **1** | `chap='致士'` | ✅ |
| **FINAL-A（干净包）** | 劝学 → 致士 | **1** | `chap='致士'`／`body_top='cǐ'` 19.4s | ✅ |
| **FINAL-B（干净包，换起点）** | 君道 → 致士 | **1** | `chap='致士'`／`body_top='致士'` 18.6s | ✅ |

FINAL-A/B 采样自证：`n=7`，不同秒级时刻 `=7` ⇒ 时间戳未塌缩。

---

## 9. 遗留与待拍板

- 跳动：已从「落错 102 行」收敛为「250ms 后二次瞬移到正确位置」；
  彻底消除需改用 RN 官方 `maintainVisibleContentPosition` 或 `onLayout` 后投递
  ⇒ **改形状**，须先跑冻结红线套（MEMORY 50–54），本轮不做。
- `fillNeighbors` 的 `needPrev` 经验等价（风险 A，MEMORY 未结案 ⑤）仍**未修**。
- 死代码清单（`tapRegions.ts`／`resolveReaderSetting` 等）待拍板。

---

## 10. 证据文件

| 文件 | 内容 |
| --- | --- |
| `/tmp/b24_ab.py` | A/B 驱动（`pm clear`＋目录双向定位＋无输入采样＋采样自证） |
| `/tmp/b31_v4.log` | v4 探针日志（根因定位的决定性序列） |
| `/tmp/b33_v5.log` | v5 探针日志（`RETRY` 生效证据） |
| `/tmp/b35_final_a.log`／`/tmp/b36_final_b.log` | 干净包 FINAL-A/B 黑盒 |
| `/tmp/pre_b21/` | 各阶段源码备份（含逐字节基线 `ScrollMode`／`ReaderScreen`） |