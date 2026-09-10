# 阅读器性能优化路线图（P0-P3）

> 目标：对标主流开源阅读器（legado / KOReader），对本项目阅读器做极致性能优化。
> 每阶段独立交付、真机可回归；本文档随实现进度更新状态。

## 一、开源方案对照与本项目现状

| 关注点 | legado（阅读 3.0） | KOReader | 本项目现状 | 结论 |
| --- | --- | --- | --- | --- |
| 重数据加载 | 字典/词库全部文件外部化，按需读取 | 重计算全部离开 UI 上下文（后台协程） | **phrase-pinyin.json 4.9MB 静态 import**，bundle 执行期整块 parse | P0 修复 |
| 列表渲染 | RecyclerView 视图复用 + 按页预载 | crengine 按需分页渲染 | FlatList 默认参数：windowSize=21（约 10 屏渲染窗口）、maxToRenderPerBatch=10 | P0 调参 |
| 章节流式加载 | 分章流式 + 相邻章预下载 | 按需加载文档流 | 跨章拼接 + 相邻章预取 + fill/FTS 时间片化（0b2165b） | ✅ 已对齐 |
| 解码 | 原生层解码（Process in Native） | C 层解码 | 内置书 native utf8 直读（1e112fb） | ✅ 已对齐 |
| 视口保持 | 平台原生机制 | XPointer 内容锚定 | MVCP 灰度（430fbde）+ 手写补偿兜底 | ✅ / P2 增强 |
| 进度锚定 | 章节内偏移 | 内容坐标（XPointer），排版重排不丢位置 | segmentId 挂接 | P2 评估 |
| 翻页动画 | 各类仿真翻页 | 可插拔翻页引擎 | Animated 仿真（PageFlipPager） | P3 Skia 真卷页 |
| 转换缓存 | — | — | conversionMemo LRU（高频繁简路径） | ✅ |

## 二、P0（本轮实施）：启动瘦身 + 渲染窗口调参

### ① phrase-pinyin.json（4.9MB）资产下沉 + 异步加载
- **问题**：静态 `import phrasePinyinData from '@/data/phrase-pinyin.json'` 使 4.9MB JSON 在 bundle 执行期（冷启动最早期）整块 parse，直接拖慢首帧。
- **方案**（对齐 legado「词库文件外部化、按需读取」）：
  - 数据文件移至 `android/app/src/main/assets/data/phrase-pinyin.json`，不再进 JS bundle（bundle 减重 4.9MB）；
  - PinyinService 新增 `ensurePhrasePinyinData()`：RNFS.readFileAssets 异步载入 + JSON.parse + 构建 18 万条 Map，单例 promise 防重入；载入失败静默降级（词组层缺席，仲裁链由规则库 / pinyin-pro 兜底）；
  - App 启动延后任务预热（首个 macrotask，用户点进阅读器前大概率已就绪）；
  - PinyinText 挂载期检测「晚到载入」：载入完成于组件生命周期内时 clearPinyinCache + 重注音，保证首屏注音正确性；载入先于挂载则零开销。
- **测试语义**：jest 环境注入同步 provider（惰性读盘），与旧「首次 annotate 时懒建 Map」语义逐字节等价，金标 125 条判音基线不受影响。

### ② FlatList 渲染窗口调参（对齐 RecyclerView 缓存尺度）
- **问题**：RN 默认 windowSize=21 → 渲染窗口约 10 屏，注音行逐字字格成本高，滚动时窗口边缘批量挂载过猛。
- **方案**：滚动模式 FlatList 增加 `windowSize=9`（前后各 4 屏，对齐 RecyclerView 缓存尺度）、`maxToRenderPerBatch=8`、`updateCellsBatchingPeriod=40`——批更小更密，滚动帧更稳。数据链路（跨章拼接 / 预取门闩 / 锚点补偿）不动，MVCP 与手写兜底均不受窗口收缩影响（已由既有 contentSize 兜底路径覆盖窗口外行）。

### ③ 真机回归点（r19）
- 冷启动首帧不因词库 parse 延迟（原 bundle 执行期 4.9MB parse 移出）；
- 注音开启进入阅读器：注音与旧版完全一致（含多音字词组层）；
- 滚动模式快速滚动无白屏加深、无新增跳变（既有红线行为不回归）。

## 三、P1（下一轮候选）
- **词组匹配算法优化**：computePhraseOverlay 现为逐字 7 次 slice+Map.get（正向最大匹配朴素版）；改为首字倒排索引（Map<首字, 最长词长表>），2500 字段落查找量降约一个数量级。
- **静态数据审计**：builtinCatalog（305KB）/ guyin-zi（377KB）等模块级数据按调用时机评估懒加载。
- **PinyinText 行级缓存**：buildCells 结果按 (pairs 引用, highlights) 缓存审计，减少切章过渡帧重复构建。

## 四、P2（中期）
- **内容坐标锚定**（KOReader XPointer 式）：进度/笔记挂接增加段落内容哈希软锚，书籍重导入 / 版本升级不再永久失挂。
- **翻页动画 native driver 审计**：PageFlipPager Animated 值确认全部 useNativeDriver，残余 JS 驱动插值迁移 Reanimated。

## 五、P3（远期）
- **Skia 真卷页**：评估 react-native-pagecurl / @shopify/react-native-skia 自绘卷页，替代 Animated 仿真。

---
- P0 实施记录：2026-09-10，commit 见 git log；APK r19。
- 每阶段完成后更新本表状态与「真机回归点」。
