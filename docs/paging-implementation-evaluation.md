# 开源阅读器翻页方案调研与借鉴评估

> 背景：滚动模式跳章后出现「页面不停滚动多章 / 下拉一次翻动好几章」缺陷（跳第十章滚到第十八章才停）。
> 根因已定位并修复（见本文 §4），借此机会调研开源阅读器的成熟实现，评估哪些思路可借鉴到本项目。

## 1. 三大开源阅读器实现对比

| 维度 | legado（阅读 3.0，Android 原生） | KOReader（Lua，多平台） | 本项目（RN 0.74 + FlatList） |
|---|---|---|---|
| 分页模式 | 内容排版成 `TextPage`（按视口尺寸预先分页），三PageView（prev/cur/next）缓存位图，PageDelegate 系列画翻页动画 | ReaderPaging：文档坐标 → 离散页；固定页文档（PDF）直接按页渲染 + 瓦片缓存 | `paginateBlocks` 测量式分页 + `PageFlipPager` 横向 ScrollView + 阴影插值 |
| 滚动模式 | `ScrollPageDelegate`：VelocityTracker 惯性 + 章节预加载，内容连续排布 | `ReaderRolling`：连续滚动，**位置以 XPointer（内容锚点）表达**，与像素解耦 | FlatList 窗口化 + 跨章拼接（append/prepend）+ 手写偏移补偿（锚点/快照/丢头补偿） |
| 位置模型 | 页号（分页结果稳定后页号即内容坐标） | **内容坐标（XPointer）为一等公民**，像素只是渲染投影 | 像素偏移为一等公民（rowOffsets/scrollOffset），内容锚点（chapterId+segmentId）为辅助 |
| 翻页动画 | 仿真卷页：位图 + 贝塞尔/三角函数网格变形（SimulationPageDelegate） | 依文档引擎，e-ink 无动画为主 | 横向滑动 + 阴影插值（非真卷页） |
| 头部插入防跳动 | 排版层解决：章节预加载后一次性进入排版，视口滚动由引擎保证 | 内容坐标锚定，插入内容不改变「当前位置」的语义 | **全部靠 JS 手写补偿**：prependAnchor（行布局回调/onContentSizeChange 增量双路径）+ 快照平移 + 丢头补偿 |

## 2. 可借鉴的核心思路

### 2.1 【高价值】原生 `maintainVisibleContentPosition` 替代手写补偿

RN 0.72 起 Android 支持 ScrollView/FlatList 的 `maintainVisibleContentPosition`（PR #29466/#35049/#35319）。语义：头部插入/删除时原生层自动调整 contentOffset，使「第一个可见行」保持不动。

- 本项目 RN 0.74.7 **该属性可用**，聊天类 App（双向无限列表）已大规模验证
- 直接对应本项目最脆弱的机制：prepend 时的 prependAnchor + rowOffsets 快照 + 双路径补偿 + 丢头补偿——**全部可以退役**，让原生层保证视口稳定
- 用法：`maintainVisibleContentPosition={{ minIndexForVisible: 0 }}`（勿设 autoscrollToTopThreshold，阅读场景不需要贴顶自动滚动）
- 风险与验证点：与窗口化回收（行反复挂载/卸载）的交互、与程序化 scrollToOffset 的先后顺序、Android 各厂商 ScrollView 差异。建议先在滚动模式灰度试验，保留现有补偿代码作为降级开关（settings 加 hidden flag）
- 注意 Caveat：启用后避免「重排（reorder）」类数据变更——本项目数据只做尾部追加/头部插入，天然满足

### 2.2 【中价值】位置模型向「内容坐标」倾斜（KOReader 思路）

KOReader 的滚动位置从不用「像素偏移」做持久语义，而是 XPointer（内容锚点）。本项目已有 chapterId+segmentId 锚点，但补偿链路的「当前阅读位置」仍以 scrollOffset 为基准，行高变化/插行后需要重算。

- 改进方向：视口锚点统一为「行 id + 行内深度比」（`captureViewportAnchor` 已有雏形），所有补偿目标都化归为「让锚点行回到视口顶入深度处」，而不是「offset ± delta」
- 好处：补偿逻辑不再依赖 contentSize 增量的归因（本次 Bug 的根因正是增量混入 append 高度），任何数据变更后只要锚点行重新布局即可恢复视口
- 与 2.1 配合：2.1 兜住头部插入，2.2 兜住行高变化（注音切换已有 layoutAnchor 同类机制，可推广为唯一模型）

### 2.3 【可选】真·仿真卷页：react-native-skia RuntimeShader

legado 的仿真翻页 = 当前页/下一页位图 + 圆柱面卷曲变形。RN 生态已有成熟路径：

- `wcandillon/can-it-be-done-in-react-native` 第 5 季 pageCurl.ts（GLSL RuntimeShader + Reanimated 手势驱动，uniform 只需 pointer/origin/resolution）
- npm 包 `react-native-pagecurl`（Skia + RNGH + Reanimated，网格卷曲、过半自动翻页）
- 掘金实战文章验证了「RN 组件 → useTexture 转位图 → shader 采样」的可行性，含锯齿/反射区踩坑记录

落地代价：新增 @shopify/react-native-skia 依赖（native 模块，需重新构建）；PageFlipPager 现为横向 ScrollView 结构，需改为「截图纹理 + Skia Canvas」双页结构。建议作为 P2 观感升级，不与稳定性工作混做。

### 2.4 【参考】legado 的「预分页」架构

legado 滚动模式也是「先把章节排进视口尺寸的连续内容」，但章节预加载发生在排版层而非 UI 层。本项目 FlatList 窗口化等价于按需排版，方向一致；可借鉴的是它**把翻页动画与内容滚动统一在 ReadView 单一视口**（滚动模式无动画、翻页模式换 Delegate），本项目双模式分离（PageFlipPager vs FlatList）维护成本更高，但改造收益有限，保持现状。

## 3. 结论与路线建议

| 优先级 | 事项 | 收益 | 代价 |
|---|---|---|---|
| P0 | 已完成：跳章连滚 Bug 修复（见 §4） | 止血 | 小 |
| P1 | 试验 `maintainVisibleContentPosition`，成功后退役 prependAnchor/快照/增量兜底/丢头补偿约 300 行手写补偿 | 根除一整类补偿竞态 Bug（本次即第 3 起） | 1 次专项 + 真机回归 |
| P2 | 视口锚点统一为「行 id + 深度」内容坐标模型（推广 layoutAnchor） | 注音切换/换行高场景彻底免疫 | 中，需动 handleRowLayout 语义 |
| P3 | Skia 真卷页仿真翻页（pageCurl shader） | 观感对齐 legado | 大（新原生依赖 + PageFlipPager 重构） |

## 4. 附：本次跳章连滚 Bug 诊断（commit 待提交）

现象：滚动模式跳转道德经第十章后页面不停滚动至第十八章；下拉一次翻动好几章。

根因（两个叠加，均为 `e5ad598` 引入）：

1. **预取重试条件恒真**：`prefetchNeighborChapters.attempt` 的重试判定「新首章的上一章是否已加载」在每次成功 prepend 后必然为否（预取语义只拼一章）→ 空转重试 4 轮，每轮 append+prepend 各一章，一轮预取被放大成 4 轮双向拼接。
2. **锚点补偿增量污染**：`attempt` 中 append 先于 prepend，两次 setState 同 tick 合并渲染，`onContentSizeChange` 锚点兜底取 `delta = h - contentH`（= prepend 高度 + append 高度）做补偿 scrollTo → 视口向前多甩一个 append 章高度；4 轮重试 × 每轮前甩 ≈ 连滚 8 章（短章书）。

修复：

- 重试条件改为「本轮零进展」（`progressed` 判定），不再追逐恒假条件
- `appendNextChapter` 成功记录 `lastAppendAtRef`；锚点兜底补偿优先走「锚点行新 y 精确补偿」（只含插入高度，与下方 append 无关），增量路径加 `APPEND_COALESCE_MS=100` 时间窗门控——同 tick append 污染时让位给行布局路径/超时兜底
- 回归断言锁入 `readerBugfixRegression.test.ts`；全量 869/869
