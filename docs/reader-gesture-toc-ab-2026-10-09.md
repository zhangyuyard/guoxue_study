# 阅读器「点击语义」三项改动 —— 真机单变量 A/B 验收报告

- 日期：2026-10-08 施工 / 2026-10-09 凌晨完成真机验收
- 设备：ALT-AL10（`22N0224511002219`），Android，物理 1080×2504，px 比 3.125
- 包名：`com.guoxue.studyapp`；被试书：《资治通鉴》（294 章）
- 探针：`/tmp/a30_probe.py`、`/tmp/a30_p5_toc_jump.py`、`/tmp/a30_p6_jumpspin.py`

---

## 一、需求（用户 2026-10-08 逐字）

1. 「滚动翻页的模式下，需要取消点击翻页的功能」
2. 「查询字典的功能也不能由点击触发，需要长按」
3. 「在阅读界面导航栏上，点击章节名可弹出目录，点击任意章节名即可跳转到该章节」

两条设计取舍经用户显式裁定：
- 长按语义 → **长按弹动作菜单（查字典 / 划线本段 / 朗读本段）**
  （理由：长按原先是「新建划线」的唯一入口，直改会致功能丢失）
- 目录 → **要，且高亮当前章、打开即定位**

---

## 二、代码改动

| 文件 | 状态 | sha256 | 说明 |
|---|---|---|---|
| `src/reader/core/modes/ScrollMode.tsx` | 改 | `4527d98bb1a601f2ae8be0c6241af92d496e1785bacf812947b2144d4a25f7a7` | 28,476 → 23,267 B；删除点按翻屏三部件 |
| `src/screens/ReaderScreen.tsx` | 改 | `497b9bc8c72b9d96b51addaa0a206975f1e598695f05a39bd833bbcdcc0c1e3b` | 58,002 B；接目录/长按菜单；删 `onPressChar` 接线 |
| `src/reader/toc.ts` | 新增 | `3b9354c552dad93c6bfcd2347ce6f0956b633f022128c4c8b3deb39edde65b6b` | `TOC_ROW_H`/`buildTocItems`/`tocIndexOf`/`tocInitialIndex`（纯 `.ts`，jest 可测） |
| `src/components/reader/ChapterTocSheet.tsx` | 新增 | `92522bba58fc151a59ed856148158e2a29ceb1de4b70e6de23714108dcc33d94` | 目录弹层；`visible` 时**才**挂载列表 |
| `src/components/reader/CharActionMenu.tsx` | 新增 | `3d20d9b7454d2d3f739cda17fca391ee7d95f6e4261729936c70f81a2405595b` | 三动作长按菜单（含朗读，自包含） |

**删除的三部件（同一根因）**：①列表自身 `touchEnd` 补判空白区点按；②行内 press 时刻带 `pageX` 回问 `charTapIntercept` 抢在查字前翻屏；③`PRESS_CONSUMED_DEDUP_MS` 去重同一手势。三者都是「同一个『点』被赋予两种语义」的时序缝补 ⇒ **整体删除，不留回退开关**（留开关会造出「开关挂着空实现、行内 press 被静默吞掉」的中间态，且任何用例都观察不到）。

`tapRegions.ts` / `tapRegions.test.ts` 现为**死代码 + 孤儿套**（生产零引用），按本仓既有约定（`flingMath`/`pageFlow` 同例）**先不删，待拍板**。

---

## 三、门禁与变异自证（10-08 完成，本报告沿用）

- `npx tsc --noEmit` ⇒ **0 错**。
- 全量 jest ⇒ **100 套 / 1298 例全绿**（本批 +2 套 +28 例）。
- 改动前基线**零检测力已证**：删除实现后 jest 仍 98/1270 全绿 ⇒ 旧行为无任何断言在守，必须补断言。
- 变异自证 7 处（逐处还原并核 sha256；红数＝失败用例数）：

| 变异 | 内容 | 红数 |
|---|---|---|
| M1 | ScrollMode 加回 `onTouchEnd={onScroll}` | 1 |
| M2 | ReaderScreen 加回 `onPressChar={() => undefined}` | 1 |
| M3 | 目录删 `initialScrollIndex` | 2 |
| M4 | `offset: TOC_ROW_H * index` 内联成 `52` | 1 |
| M5 | `tocInitialIndex` 未命中退化 0 | 2 |
| M6 | `TOC_ROW_H` 改 53 | 1 |
| M7 | 删空 `chapterId` 兜底 | 1 |

- 包内双向计数（Hermes 字节码非 ASCII ⇒ 必须 `unzip` 后 utf8 **与** utf16le 双通道、必加 `-a`）：新串 `划线本段`/`查字典`/`朗读本段`/`打开目录`/`当前` 等 utf16le 各 ≥1；旧桩 `charTapIntercept`/`resolveTapRegion`/`isTapGesture`/`PRESS_CONSUMED_DEDUP_MS` **双通道全 0**；ASCII 正对照 `onPressChar`/`onLongPressChar` 各 1 ⇒ 计数工具有效。

### 产物自证链

| 环节 | 值 |
|---|---|
| APK | 73,344,816 B，构建 2026-10-08 17:07 |
| APK sha256 | `b12629ee6d88bc0f4aec70b174be300b7603f60864e533aabbd916f01794a338` |
| APK md5（本机 ≡ 设备端 push 后） | `0a2ef3d19e1b5b249b058f0a36c3ebdc` |
| 装机后 `lastUpdateTime` | `2026-10-08 17:34:19`（> 构建 17:07 > 基线 15:50:36） |

---

## 四、真机 A/B 设计

**红臂 = 设备上原有的改动前包**（`lastUpdateTime=2026-10-08 15:50:36`），无需额外构建即可做真基线。

- 每次输入前过**前台闸门**（`mCurrentFocus` 含包名），闸门不过一律不下发。
- 每次快照用**唯一新文件名** + dump 前先 `rm` ⇒ 「文件存在且以 `<?xml` 开头」等价于「本次 dump 真的写了它」，避免沿用旧快照。
- 滚动模式自证：`PageMode` 的左右点击区带 `content-desc`「上一页/下一页」；有=翻页模式，无=滚动模式。**两相皆 `scroll`**，模式不构成混淆变量。

### 落点必须实测（首版教训）

本仓阅读器是**逐字渲染**：每个汉字是独立节点（格宽 50px、高 66px），拼音行在其正上方（同 x，高 38px）。

首版把落点写死 `y=1300` ⇒ 实测命中拼音行（`wèi`/`gēn`）或版心留白 ⇒ **基线的「点字查字典」根本没被触发，红臂不成立**。最终版落点全部来自 dump：
- 组 A（行内）：取 x∈[0,300] / [420,660] / [760,1000] 区间内的**汉字单字格**中心；
- 组 B（留白）：取版心外沿处**无任何有文字节点覆盖**的点（实测 `(40,500)`）。

---

## 五、A/B 读数

探针 sha：A 相 `5a70afc02d1724d3b990882f966242361cb8cbc000bb45574b55dead907f05c8`；B 相 `be93bf1c0523f004080a2a223e345f97ecab2fc7f2eb2196ca856a8c4f90dff3`（差异见 §六，主判据字段两版一致）。

| 探针 | 落点（实测） | A 基线 | B 新包 | 对应需求 |
|---|---|---|---|---|
| P0 包自证 | — | `15:50:36` | `17:34:19` | — |
| P1 模式 | — | `scroll` | `scroll` | 可比前提 |
| 顶栏目录入口 | — | **无** | `打开目录：<章名>` | 需 3 |
| P2 left30 | 汉字格 | `changed=True`，仍在阅读页 ⇒ **翻屏** | `changed=False`，无浮层 | 需 1 ✅ |
| P2 mid | 汉字格 | `changed=True`，**离开阅读页** ⇒ 进词典页 | `changed=False`，无浮层 | 需 1+2 ✅ |
| P2 right30 | 汉字格 | `changed=True` ⇒ **翻屏** | `changed=False` | 需 1 ✅ |
| P2 blank | 版心留白 | `changed=True` ⇒ **翻屏** | `changed=False` | 需 1 ✅ |
| P2 CONTROL | 真滑一下 | `changed=True` | `changed=True` | 仪器有检测力 ✅ |
| P3 短按 | 汉字格 | `body_changed=True`（跳页） | `body_changed=False`、无浮层、仍在阅读页 | 需 2 ✅ |
| P3 长按 | 汉字格 | 弹出**划线弹层**（全树：朗读 / 划线本段 / 三色 / 笔记），三动作命中 **1/3** | 三动作命中 **3/3**（`「虽」` + 查字典 + 划线本段 + 朗读本段） | 需 2 ✅ |
| P3 点「查字典」 | 菜单项 | — | 进词典页，条目 `虽则/虽是/虽死犹生/虽死犹荣/虽然/虽说` | 链路通 ✅ |
| P4 目录 | 顶栏 | 无入口 | `目录 · 294 章`；当前章 y=1074、徽标 y=1081、**dy=7** | 需 3 ✅ |

**判据细化说明**：`tap_body_changed` 对**任何** Modal 都为真（RN `Modal` 是独立 Window，会把底下阅读页整棵树顶掉）⇒ 单看它无法区分「翻屏」与「弹层」。故引入
`判定_翻屏 = still_reader ∧ body_changed`（需求 1 的红线）与 `overlay_kind`（区分 dict / highlight-sheet / toc / char-menu）。

### 补充验收（新包专属）

**P5 目录跳章 + 定位 + 回归（RC=0）**
- J1：点目录里「汉纪·汉纪三十」⇒ 目录关闭、回阅读页、顶栏 label **变成该章名** ✅
- J2：正文指纹确实变化 ✅
- J3：重开目录 ⇒ 当前章名节点 y=1074、徽标 y=1081、**dy=7**、位于列表顶部区 ✅
- J4：下滚/上滚各 5 次，**0/10 异常**，全程无「加载失败」占位 ✅

**P6 跳章落地稳定性 + 同页短滚（RC=0）**
- Q1：跳章后**不发任何输入**，每 3s 采样 label，18s 窗口内 **6/6 全部为目标章**（`汉纪·汉纪四十三`）⇒ **无自发漂移** ✅
- Q2：200px 短距同页滚动下滚/上滚各 5 次，**0/10 异常**（另一次跑为 10/10 全部 changed=True）✅

> P5 过程中曾两次观察到「跳章后 label 退回上一章」，一度怀疑是需求 3 的隐患。P6-Q1 用**无输入窗口**证伪：漂移由探针自己的清场 `back()` 引起，不是被测行为。

---

## 六、仪器侧缺陷与修正（都不是被测对象的错）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 就绪闸 `[TOOLFAIL]`，空等 **121.1s** | 判据 `[PERF][phrase] loaded` **陈旧**：只在 PinyinService 的 JS 回退支打印（`src/services/PinyinService.ts:300`），当前走原生支（`:279-282`）永不打印 | 换双判据：行为（书架可读：`国学书架` + 三个 Tab）+ 日志旁证（`[PERF][startup] dictEngineSyncPrefix=` + `[PERF][library-sync] done`）；实测两者在 **2.6s** 同时成立 |
| 2 | 行为判据过、日志旁证恒 False | `logcat -c` 跑在 `cold_start()` **之后** ⇒ 一次性启动日志刚打印就被清掉 | 清日志移到 `cold_start` 之前；并把日志降为**旁证**（缺则 WARN，不单独否决） |
| 3 | 恢复逻辑连按 `back` 把书退到书架 | 严格「在阅读页」判据在**装配空窗**（换章/上滚到章首约 **6~11s**，正文为零且**无占位文案**）期间为假 ⇒ 误判后多发 `back` | 拆出 `in_reader_loose`（顶栏有返回 + 有章导航 `›`）专供恢复/前置；严格版留给判据输出 |
| 4 | 「同屏锚」判据假阴性 | `BottomSheet` 基于 RN `Modal`（`src/components/common/BottomSheet.tsx:112`）⇒ 弹层是独立 Window，底下阅读页从无障碍树**整体消失** | 菜单在场判据改为「三动作 **≥2 项**同时命中」，不再依赖顶栏是否还在 |
| 5 | 长按偶发不触发 | `input swipe` 同坐标 900ms 在 RN 长按阈值边缘**偶发丢失**（同一脚本同一坐标约定，一次成功一次失败） | 改为 **2 次尝试**（900ms → 1200ms），只有两次都失败才可声明功能缺失 |
| 6 | 目录/弹层首次点开偶发不弹 | 开书/跳章后页面仍在恢复，首点被吞 | 清场 + 等装配完成后重试（≤3 轮） |
| 7 | 落点打偏（见 §四） | 写死 y 落在拼音行/留白 | 落点一律实测（汉字单字格中心 / 无文字覆盖点） |

---

## 七、未结案 / 待拍板

1. **装配空窗无占位文案**：换章或上滚到章首时，正文区约 6~11s 为零、屏幕上看不到任何提示（实测 17:45:10/15 cjk=0 → 17:45:21 cjk=149 自愈）。**非本轮引入**，但属体验缺口。
2. **跳章后立即按键可能漂回上一章**（P5 中 2/2 观测，机理未查）。P6-Q1 已证**无输入时不自漂** ⇒ 触发条件与按键/清场操作相关。
3. `tapRegions.ts` + `tapRegions.test.ts`：死代码 + 孤儿套，待拍板删除。
4. 历史未结案（见 `MEMORY.md`）：①footer 部分场景 y 偏下 ~100px；⑤`fillNeighbors` 的 `needPrev` 经验等价；⑥`useReaderBookSettings/resolveReaderSetting` 无调用方；⑧`flingMath`/`pageFlow` 死代码；⑦⑨为 0.74 期遗留须整体重验；iOS 仍未过（CocoaPods 缺失）。
5. 症状①（跨章前插补偿的可见位移）上一轮已定量、**未改行为**，仍待拍板。

---

## 八、复现命令

```bash
# 探针（A/B 同脚本；phase ∈ {baseline, new}）
/Users/wxzhangyu/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -u /tmp/a30_probe.py new
# 目录跳章 + 定位 + 回归
/Users/wxzhangyu/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -u /tmp/a30_p5_toc_jump.py
# 跳章落地稳定性 + 同页短滚
/Users/wxzhangyu/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -u /tmp/a30_p6_jumpspin.py

# 装机（华为机走 push + pm install）
adb push android/app/build/outputs/apk/release/app-release.apk /data/local/tmp/a30.apk
adb shell md5sum /data/local/tmp/a30.apk          # 必须与 md5 -q 一致
adb shell pm install -r -t /data/local/tmp/a30.apk
adb shell dumpsys package com.guoxue.studyapp | grep lastUpdateTime=
```

原始日志与探针**已归档进仓**（`/tmp` 会被清理）：

```
guoxue_study_app/deliverables/a30-2026-10-09/
  a30_probe.py            sha256 be93bf1c0523f004080a2a223e345f97ecab2fc7f2eb2196ca856a8c4f90dff3  ← B 相冻结版
  a30_probe.FROZEN.py     同上（副本，便于比对）
  a30_p5_toc_jump.py      sha256 9d58df0c8c51fe07e5b946a513a50ab0d244d863083b1e20eefd28a6943e868e
  a30_p6_jumpspin.py      sha256 d7d8178505c7ec28bab03ede197b4a261e529e8dec58716c06484e1a418b7a07
  probe_ready30.py        冷启就绪判据探测（定 §六① 用）
  inspect_reader30.py     阅读页 a11y 树结构探测（定 §四 落点用）
  a30_baseline.log        A 相原始输出
  a30_new.log             B 相原始输出
  a30_p5.log / a30_p6.log / a30_blank_watch.log / a30_back_probe.log
```

### 归档缺口登记（2026-10-09 复核）

| 项 | 状态 |
|---|---|
| A 相探针文件本体 | **未归档**。仅存于 §五 的 sha256 `5a70afc02d1724d3b990882f966242361cb8cbc000bb45574b55dead907f05c8`（差异为探针自身修补，§六 所列；主判据字段与 B 相一致）。重跑 A 相需先从该 sha 反推或改用 B 相 + 老包。 |
| 本报告自身 | 2026-10-09 复核时位于**工作区** `docs/`（仓外）。已移入仓内 `guoxue_study_app/docs/`，移前/移后 sha256 均为 `3d1f1ede9a419ca10d4f60a174d84c39933da28076a1e4a2d7a59296ac125f16`。 |
| 归档 12 文件 vs `/tmp` | 10 个同名文件 **sha256 逐字节一致**（另 2 个 `inspect_reader30.py`/`probe_ready30.py` 为归档独有）。 |
