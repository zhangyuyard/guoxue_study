# ScrollReader 预演实现定案（照此文档实现）

> 前置：`docs/reader-legado-full-analysis-2026-09-24.md`（legado 机制三轮精读，已闭环）。
> 本文 = 动工前预演：重点/难点/确切解法。实现时**只依照本文**，不再即兴。

## 对齐原则与合规声明（用户指令：完全以 legado 方案为主，不擅自更改）

1. **每一处行为决策都必须有 legado 源码依据**，标注到文件:行；无依据的行为 = 违规，须回源码确认后才可加。
2. **RN 平台差异的翻译而非更改**：legado 单 View 自绘（Canvas）在 RN 无等价物 ⇒ 以「View 树 + Animated + PanResponder」翻译同一语义，语义逐条对应：
   - legado `ContentTextView.scroll(mOffset)` 状态机 ⇔ `applyScroll(dy)`（§2 逐条直译，标注行号 L273-301）
   - legado `ContentTextView.touch(x,y)` 列命中 → `ReadView.onSingleTapUp` 九宫格 ⇔ 容器 capture 接管 + `hitTestChar(x,y)` 列命中 → 语义分流（同一判定顺序：命中列→字符语义，未命中→九宫格；legado L409-446/L380-411）
   - legado 列坐标（TextColumn.start/end 1em 字格）⇔ 本仓 `geometry.cellAdvance = cellWidth + 2×charGap`（L1 排版同源算式）⇒ `hitTestChar` 列号 = `floor(x'/cellAdvance)` + margin 校正
3. **零侵权**：GPL-3.0 允许学机制、禁止抄码。全部 RN/TS 独立重写——不复制变量名/函数结构/注释文本，只复刻行为语义；本仓排版/页流/滚动数据结构均为自有模型（Line/segmentId/charOffset）。fork 仓库仅作源码阅读，不入仓、不打包、不分发。
4. **有意差异须声明**（已声明清单见解析文档 §7.6/§8）：底对齐、双栏、图片行、朗读/自动翻页/长截图、多指触控、未载章空页（legado 高 0 连跳，我们 loading 一屏钳住——行为更稳，已声明）。

---

## 0. 预演结论（两个推翻初稿的发现）

1. **弃 `Animated.decay`/`Animated.timing` 做滚动驱动**：JS driver 动画每帧按解析式计算并覆盖 `_value`，listener 里的换页对账 `setValue` 会被下一帧动画覆盖 → decay 中跨页对账不可实现。
2. **自实现 rAF fling 循环**（legado 同构）：legado 的 Scroller 本就是「每帧差值喂 `scroll(dy)`」。RN 侧用一个 rAF 循环：每帧 `dy = v*dt`（`v *= friction^(dt/16)`），喂 `applyScroll(dy)`，`|v|<STOP_V` 或钳制发生时停。拖动、惯性、点击翻页三种输入**统一走同一个 `applyScroll`**——与 legado（onScroll / fling / startScroll 全喂 curPage.scroll）逐帧同构。

---

## 1. 核心数据流（对应 legado 机制表）

```
props.orderedChapters: {chapterId, lines: Line[]}[]   ← ReaderScreen 从 stitched 派生（含标题行）
props.linesPerPage / rowHeight / viewportH / pageMargin
props.activeChapterId（真值：char 偏移锚点经它回流）

ScrollReader 内部（ref 真值源，setState 仅镜像渲染）：
  prRef: {chapterId, page}          ← 对应 legado (durChapterIndex, pageIndex)
  offRef: number                    ← 对应 pageOffset（+内容下移 / −上移）
  offset: Animated.Value            ← 仅渲染绑定 translateY，无动画 API
  curHRef: number                   ← 当前页高（rows*rowHeight）

派生渲染（每次 render 现算，对应 legado「每帧从 pageFactory 现取」）：
  curBlock    = resolvePage(prRef, 0)        → 行数组（or loading 占位）
  nextBlock   = resolvePage(prRef, +1)
  nextPlusBlock = resolvePage(prRef, +2)
  三块绝对定位 y：0 / curH / curH+nextH（非 flex 纵排，页高不齐时语义更准）
  容器 <Animated.View translateY={offset}>
```

### 页流解析（`src/reader/pageFlow.ts` 纯模块 + 测试）
```ts
interface PageRef { chapterId: string; page: number }
type Resolved =
  | { kind: 'page'; ref: PageRef; lines: readonly Line[]; height: number }
  | { kind: 'loading'; ref: PageRef; height: number };   // 邻章未载（legado msg 页「加载中…」整屏居中，TextPageFactory L84-91，高=一屏）

// chapters 窗口内解析；dir: -1|0|+1；越窗 → loading（若对应方向 hasMore）或 null
function resolvePage(chs, hasMorePrev, hasMoreNext, linesPerPage, rowHeight, ref, dir): Resolved | null
// nextPlus 跨章解析（legado TextPageFactory L112-130：cur=末页时 nextPlus=下章 p1）
// = resolveN(pr, n)：循环 n 次 resolve(+1) 步进，跨章边界自然处理（M10）
function resolveN(chs, ..., ref, n): Resolved | null
function pageCountOf(ch, linesPerPage): number          // ceil(len/lpp)，空章=1
function pageLinesOf(ch, linesPerPage, page): Line[]    // slice，末页=余数
// 占位文案对齐 legado：邻章未载「加载中…」；书尾 nextPlus「继续滑动以加载下一章…」
```
- 页切块复用既有 `chunkLines`（pagination.ts，已 3 测）。

---

## 2. applyScroll 状态机（legado ContentTextView.scroll L273-301 else-if 链逐条直译）

> 逐行对照修正（七轮）：legado 是 **else-if 单分支链，每帧最多跨一页**（fling 帧增量 < 一页高，跨页由下一帧继续）——弃 while 循环，逐条直译。

```ts
function applyScroll(dy: number) {
  if (dy === 0) return;                                  // L274
  let off = offRef.current + dy;                         // L275
  if (!canResolve(-1) && off > 0) {                      // L279 顶钳
    off = 0;
  } else if (!canResolve(+1) && off < 0
             && off + curHRef.current < viewportH) {     // L281-284 尾钳
    off = Math.min(0, viewportH - curHRef.current);      // L285-286
  } else if (off > 0) {                                  // L287 跨上（先换页后对账）
    const prev = resolvePage(prRef, -1);
    if (prev) {
      prRef.current = prev.ref;
      off -= prev.height;                                // L290 减新页高
      curHRef.current = prev.height;
      markDirty();                                       // = setPr 镜像（L291 upView 进度刷新对应）
    } else off = 0;                                      // 解析失败兜底（legado 空页高 0 连跳的有意差异，见 §8）
  } else if (off < -curHRef.current) {                   // L293 跨下（先对账后换页）
    off += curHRef.current;                              // L294 加旧页高
    const nxt = resolvePage(prRef, +1);
    if (nxt) {
      prRef.current = nxt.ref;
      curHRef.current = nxt.height;
      markDirty();
    } else {                                             // 回滚本次对账（legado 会跨入空页，我们钳住，声明差异）
      off -= curHRef.current; // 还原
    }
  }
  if (prRef.current.chapterId !== committedChapterRef.current) commit();  // L291/298 upView 进度刷新对应
  offRef.current = off; offset.setValue(off);            // L300 invalidate 对应
}
```
- `markDirty()` 实质：**ref 不触发渲染**，跨页换页时 `setPr({chapterId, page})` 镜像 state，三块由 render 现算 resolvePage 派生（legado「每帧现取」同构）。offset 每帧 `setValue` 不经 React。
- `canResolve(-1)`/`resolvePage` null 语义：书首/章窗边界未载 → 钳住（legado 顶/尾钳 + msg 页行为同构）。
- **帧驱动链对齐确认（七轮）**：legado 拖动与惯性共用一条链 `setTouchPoint → (touchY−lastY) → curPage.scroll(dy)`（ReadView L289-298），区别只在 touchY 来源（手指 vs Scroller）⇔ 我们「拖动/rAF/点击翻页三种输入统一 applyScroll」逐点同构。
- **换页 setState 与 offset.setValue 同一 JS 任务**（rAF/手势回调内）→ 同帧 flush，无错位帧（预演难点 A 的最终解，配合 rAF 方案彻底闭环）。

## 3. 三种输入统一进 applyScroll

| 输入 | 驱动 | 对应 legado |
|---|---|---|
| 拖动 | PanResponder MOVE：`applyScroll(dy − lastDy)`（**无 slop 门控，capture 接管后全量跟随**，legado 每个 MOVE 都喂 scroll） | onScroll(event) → setTouchPoint → onScroll() → curPage.scroll(touchY−lastY)（ReadView L289-298） |
| 惯性 | UP：rAF 循环跑 **Android Scroller.fling viscousFluid 数学移植**（AOSP Apache-2.0 公开数学，非 legado 代码）：`v = g.vy*1000` 不取反、每帧 dy=currY 差值喂 applyScroll，自然衰减至停 | VelocityTracker(1000ms) + Scroller.fling(0, touchY, 0, vy, 0,0, ±10vh)（ScrollPageDelegate L23-29） |
| 点击翻页 | **定速 rAF 滚动**：速度恒定 `viewportH/300ms`（duration=300ms×\|dy\|/viewHeight，PageDelegate L72-82）；锚点 = 可见末行视口 y（next）／首行视口 bottom（prev）；目标 off_new = −末行全局y ／ +(viewportH − 首行视口bottom) | calcNextPageOffset/calcPrevPageOffset（ScrollPageDelegate L131-161）+ startScroll（PageDelegate L72-82）+ getCurVisiblePage 跨页拼接（ContentTextView L498-520） |
| 按下 | `stopFling()`；**动画中 tap 吞一次**（fling/翻页动画运行中的 DOWN-UP → 只 abort 不响应） | abortAnim + isAbortAnim（ScrollPageDelegate L91-106：动画中 abort 置 isAbortAnim=true，nextPageByAnim 检查后 return） |

- fling viscousFluid 要点（Android Scroller.fling 数学）：物理摩擦系数 friction=0.15 起步（`deceleration = friction * 256 * 0.01` 类换算），距离经 `viscousFluid(x)` 归一化曲线（`1-(1-x)^2·cos` 族）映射——移植产出「每帧 currY 序列」→ 帧间差值即 dy，与 legado 逐帧同值。
- **点击翻页不直接换页**：只是滚一段，跨页由状态机自然发生（连点=连续滚，legado 同）。
- 滚动模式无「没有上一页/下一页」toast（SnackBar 仅 Horizontal 家族）——静默钳制 ✓ 对齐。

### tap 交互（三轮修正定案：ScrollReader 统一接管，legado 同构）
legado 单 View 自绘，click 判定全在自身（`curPage.onClick` 命中字符→true，未命中→九宫格）。RN 下 LineRow 内嵌 Pressable 会独占 responder ⇒ 容器收不到 tap ⇒ **scroll 模式统一接管**：
- 容器 PanResponder `onStartShouldSetPanResponderCapture=true`（capture 抢 start，含 tap）+ move 同理。
- release 且未 isMoved（tap）：`(x,y)` → 行命中判定（行号 = floor((y − off − paddingTop)/rowH)，页流全局行）：
  - 命中正文行 → `props.onTapLine(line)`（ReaderScreen 复用 handlePressChar 行级查词语义——本仓点字本就是整段 `handlePressChar(seg.text)`，行级命中足够）
  - 未命中 / 标题行 / 空白 → 九宫格分区 action（33% 三分；trRect x 从 36% 起，legado setRect9x 特判；默认 TL/TC/ML/BL=上一页、TR/MR/BC/BR=下一页、MC=菜单；全非 0 时强制 MC=菜单）
- 长按 600ms 计时 → `props.onLongPressLine(line)`（划线语义），移动超 slop 取消。
- **scroll 模式 renderLine 不传 onPressChar/onLongPressChar**（LineRow 内部 Pressable 禁用，避免 responder 竞争）；page 模式 renderItem 不动。
- 九宫格 action 本轮接：翻页（保留一行滚动）+ 菜单；其余 action（章跳/书签/朗读）走既有菜单逻辑，不在滚动器内扩展。

## 4. 难点清单与定案（预演推演记录）

| # | 难点 | 定案 |
|---|---|---|
| A | 换页同帧性（setState 异步 vs setValue 同步） | rAF/手势回调单任务内完成「换页 setState + setValue 对账」→ 同一 flush；Animated 仅做 translateY 绑定，无动画 API；真机若仍闪（老桥差帧）→ 降级四块缓冲（prev/cur/next/nextPlus 常驻，换页延后到静止点） |
| B | 跨章 commit 回流（openChapter 触发 props 重建） | commit 时 pr 已在新章；props 回流后 render 现算 resolve 与换页结果一致 ⇒ 视觉零变；**prRef 永不被 props 重置**（仅外部跳章：activeChapterId 不在页流且 ≠ pr.chapterId 时重置 pr+off=0） |
| C | windowRecenter 裁窗与滚动竞争 | 窗口裁剪照旧（commit 内同步）；被裁方向 resolve 失败 → 钳住/loading 占位，fillNeighbors useEffect 载回后 props 更新 → `applyScroll(0)` 校正对账。**无任何补偿性滚动**（legado 哲学） |
| D | 页高一致性（标题行/末页余量） | 页高 = `rows*rowHeight`；标题行高=rowHeight（renderItem 既有样式）；末页=余数行更矮（legado durY 同构）；linesPerPage=floor(viewportH/rowHeight) |
| E | PanResponder 吞子 tap（铁律 64 同族） | 容器非 capture：`onStartShouldSet=false`、`onMoveShouldSet=\|dy\|>slop` ⇒ tap 直达 LineRow 点字/划线 Pressable；tap 分区（上/中/下 1/3）在 release 且未 isMoved 时调 `onTapRegion`；move 接管后 Pressable 自动取消 |
| F | decay 覆盖 setValue（预演发现） | 弃 decay/timing，自实现 rAF fling（§0.2）；点击翻页也走 rAF（prev 方向会跨上页，timing 同样不可用） |
| G | 邻章未载滚入后续流 | loading 占位块（高=一屏，文本居中）钳住；props 更新 → useEffect `applyScroll(0)` 校正（页高占位→真实页高对账）；legado msg 页同行为 |
| H | 进度真值 | commit/换页时取新 curPage 首行 `(segmentId, charStart)` → `recordProgress`；跨章加 `openChapter`（现 handlePagerCommit 逻辑平移）；**char 偏移恒真值，页号仅派生**（legado durChapterPos 同构） |
| I | 初始定位 | initialCharOffset → 章内行号（lineAtCharOffset）→ 章内页号=floor(行/lpp)，pr 初始化 + off=0（legado setPageIndex 同构） |
| J | 空章/短章（<1 页） | pageCountOf=1，页块高<viewportH；尾钳 `min(0, viewportH-curH)` 保证末页可完整可见（legado `visibleHeight - textPage.height` 同式） |
| K | rAF 生命周期 | mount 启动 / unmount 取消；App 后台（AppState）停 fling；fling 中新拖动先 stopFling |
| L | tap 统一接管的行命中 | 渲染时把三块解析结果存 `triRef={cur,next,nextPlus,heights}`；tap：`y'=locationY − offRef` → 映射三段（0..curH / curH..+nextH / …）→ 块内行号=floor(y''/rowH) → 命中行；标题行/页尾余量/越界 → 九宫格。坐标用 `nativeEvent.locationX/Y`（相对响应容器，不含 transform） |
| M | viewportH/linesPerPage 变化（旋转/字号） | 记视口顶行 → 新 lpp 下重投影：`page=floor(行/lpp')`、`off=−(行%lpp')*rowH`（legado 靠 char 真值+getPageByReadPos 天然恢复的 RN 显式版） |
| N | **commit 进度真值坑（bug 级）** | 页首行若是 title 行（`segmentId='__title__'`，stitch 注入）⇒ `recordProgress` 会把假 segmentId 写进持久进度 ⇒ 续读错位。**定案：commit 取页首非 title 行；title 页（page0）→ 记章首**（legado `getReadLength(pageIndex)` 天然无此坑，char 偏移真值） |
| O | seekToChar 双路判定 | `props.activeChapterId ≠ prRef.chapterId` → 外部跳章：重置 pr+off=0（charOffset→页投影）；`==` → commit 回流，**不得重置**。ScrollReader forwardRef 暴露 `seekToChar(charOffset)`（章内跳转：行→page+off 同帧 setValue） |
| P | LineRow memo | 三块 ≈3×lpp≈60 行，未 memo 则每次换页全量重渲染掉帧 ⇒ 核对 LineRow，未 memo 则 `React.memo` 包装（props 稳定键已就绪） |
| Q | chunkLines 缓存 | resolvePage 现算频繁 ⇒ pages 按章缓存（`chapterId+linesPerPage` 键 memo），避免全章重切 |
| R | STITCHDBG 探针 | scroll 模式无 FlatList onScroll ⇒ 旧探针全失效 ⇒ **本次接线一并删除**；验收期临时加新探针（pr/offset 变化 log），验收后删 |
| S | hasMore 方向性（五轮） | `hasMore` 须拆 **hasMorePrev / hasMoreNext**（窗口顶/底独立：loading 占位 vs 书首/书尾硬钳） |
| T | renderItem 共享（五轮） | renderItem 增 `interactive` 参数（默认 true）；scroll 模式传 false → LineRow 不传 onPressChar/onLongPressChar（内部 Pressable 禁用）；onTapLine/onLongPressLine 由 ReaderScreen 闭包查 seg 触发。**实现第一步先核对 LineRow props 可选性 + handlePressChar/handleLongPressChar 签名** |
| U | rAF stale closure（五轮） | rAF 循环只调 `applyScrollRef.current`（每 render 更新 ref.current），严禁闭包直持 props/pr |
| V | velocity 上限（五轮） | `v = clamp(g.vy*1000, ±8000)`，防一帧跨 3+ 页 render 堆积 |
| W | committedChapterRef 初值（五轮） | = mount 时 activeChapterId，否则首帧误判跨章 |

已确认无碍（五轮 walkthrough 结论）：fling 连跨多章 → commit 幂等 + 同帧批处理；loading 页顶替真页时 off=0 顶对齐无跳变；Animated.Value 实例跨 re-render 绑定保持；lineCountOf/firstLineOf 切章派生可行。

## 9. 动工前终审：历史问题对照 + 落地困难清单（六轮）

### 9.1 往期问题 → 新架构判定（8 轮全清单）

| 历史问题 | 新架构判定 |
|---|---|
| key 位置键漂移 → FlatList 全量重挂 → 停顿闪烁 | **架构性消除**：无 FlatList，三块普通 View + 稳定逻辑 key |
| prepend 补偿撞原生 contentSize 钳制（铁律 60） | **架构性消除**：无连续列表/无 prepend/无补偿 |
| onScrollEndDrag 抬手即发 → 动量中改窗 → 跳动/锁死 | **架构性消除**：滚动自驱动（无 native scroll 事件），改窗只在 applyScroll 自控节奏内 |
| 窗口裁剪跑飞/锁死 | **消除**：裁窗后 resolve 失败 → 钳住/loading 占位，无补偿滚动（钳住哲学） |
| 顶栏错章（中心行判定短章失效） | **架构性消除**：顶栏章名 = pr.chapterId 页流真值，无行判定 |
| fill 只 begin 不装载（updater 旗标同步读） | 既有修复沿用（winRef 同步 + useEffect 触发） |
| 「序」标题泛滥 | 不变项：titleOf 抑制在 stitch 层，新架构沿用 |
| 标题重复/key 冲突 | 已修（stitch 全局重编 index + 稳定键）+ 三块 map 稳定 key |
| 短章无滚距/末页显示 | **解决**：尾钳 `min(0, viewportH−curH)`，短章归 0 静止；章尾直接接下一章开头（页流拼接无空隙，legado 同构） |
| 第八轮 8 项全挂（回滚/跳动/锁死/错章/卡顿/惯性过头） | 全部源于离散翻页判定 + FlatList 残留 → 新架构无过半判定、无离散页、无 FlatList；逐项验收判据见 §6 |
| RN 无 Log 导出白屏 / 来电抢占假象 | 纪律项：探针用 console.log；测试防前台抢占（铁律 32） |

### 9.2 legado 落地剩余困难（诚实清单）

| # | 困难 | 等级 | 缓解 |
|---|---|---|---|
| G1 | 同帧性（setPr+setValue 同帧 flush）依赖 React 18 RN 批处理，未实测旧桥/Fabric | 低-中 | 换页每帧 ≤1 次；即使差帧仅露背景一帧；防御方案已备（四块缓冲/静止对账降级）。**装机首验项** |
| G2 | tap 统一接管后行内交互需核对 LineRow props 可选性/签名（W2/难点 T） | 低 | 实现第一步核对（§7.3 前置） |
| G3 | 惯性手感（friction/velocity clamp）≠ Android ViscousFluid，需装机调参 1-2 轮 | 低 | 预期内调参 |
| G4 | 快滚滚入未载章 → 钳在 loading 页等装载 | 低 | fillNeighbors+prewarm 既有机制；legado 空页高 0 行为更差（已声明更优差异） |
| G5 | 大章 commit 同步重排可能掉一帧（stitch useMemo 同步） | 低 | 与现架构成本相同，无新增 |
| G6/G7/G8 | 多指触控/双栏横屏/底对齐/图片行 | — | 功能面外，已声明不复刻 |

**终审结论：历史问题全部避开或有既定解法；落地困难 2 项需装机实测（G1/G3）、其余低风险有缓解路径。方案可动工。**

## 5. 文件变更清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/reader/pageFlow.ts` | 新建 | resolvePage/pageCountOf/pageLinesOf（纯函数） |
| `src/__tests__/pageFlow.test.ts` | 新建 | 页流解析边界：章内跨页/跨章 p0/末章封口/未载 loading/空章（约 8 例） |
| `src/components/reader/ScrollReader.tsx` | 新建 | §1-§4 全部（~300 行） |
| `src/screens/ReaderScreen.tsx` | 修改 | 删 pagerPages/pagerHasNext/pagerFallback/handlePagerCommit→改 handleScrollCommit；派生 orderedChapters（stitched.firstLineOf+lineCountOf 切章）；scroll 分支换 `<ScrollReader>` |
| `src/components/reader/ScrollPager.tsx` | **删除** | 离散三槽翻页器（方向性错误） |
| `docs/` 两文档 | 已有 | 解析文档 + 本文 |

## 6. 验收判据（映射第八轮 8 项 + legado 行为）

1. 连续下滚多章：页流连续、章界无缝、**全程零闪烁**（同帧对账）。
2. 下滚停顿：无跳变（无 FlatList 装载重挂）。
3. 快速回滚到第一章触顶：硬钳 off=0，**不闪不跳章**。
4. 顶栏章名 == 当前页所在章（commit 即时回流）。
5. 大奉往回滚多章：无锁死（窗口被裁→loading→载回续流）。
6. 「序」标题：沿用 titleOf 抑制（不变项）。
7. 惯性：一滑多页顺滑衰减停止；中途按下立即停（abortAnim）。
8. 滑一半停手：低速率时停在该处（无强翻页判定——**legado 无过半翻页**，这是与旧 ScrollPager 的行为差异，预期行为）。
9. 点击下区：平滑滚「保留一行」一段；连点连续滚。
10. 邻章未载滚入：loading 占位钳住，载回自动续流。

## 7. 实现顺序（照此执行）

1. pageFlow.ts + 测试 → jest 绿
2. ScrollReader.tsx（骨架：渲染三块 → applyScroll → 手势 → rAF fling → tap 分区）
3. ReaderScreen 接线（orderedChapters 派生 + commit + 删旧）→ 删 ScrollPager
4. tsc 零错 → 全量 jest（90 套/1179+新增）→ assembleRelease → 装机 sha 核对
5. 追加记忆 + 复测清单交付
