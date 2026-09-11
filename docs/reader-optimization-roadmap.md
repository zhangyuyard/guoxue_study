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
- P0 实施记录：2026-09-10，commit fcbf583；APK r19。真机回归（r20 诊断包）证明 P0 不足以解决「fresh install 点卡片无响应」。

## 六、P0.5（r20/r21，本轮实施）：真机归因 + 章节字节索引 + 首屏预算收紧

### 真机归因结论（华为 ALT-AL10，r20 诊断包实测）
- **主因①**：`RNFS.readFile` 整读资治通鉴 9.4MB，单次阻塞 JS **11.2s**（点卡片转圈 ~11.5s 的根因；Mac 仅 44ms——大字符串读是真机瓶颈，CPU 不是）。
- **主因②**：fresh install 启动期 `jsBlocked=6729ms`（loadAndRegisterAll 窗口），书架出现后 ~9.5s 内点卡片被永久吞掉（JS 饱和窗口内 touch 丢失）。
- **主因③**：首屏渲染 `jsBlocked=5281ms` + fill 尾部 `jsBlocked=2872ms`（30 行 ≈1900 字格首帧挂载，旧 `longRowThreshold:300` 早退使资治通鉴级行均 ~63 字从不收缩）。

### ① 章节字节索引（meta 快路径）——对齐 KOReader「按需加载文档流」
- **构建期**：`books/<id>.meta.json`（`{v:1, bookId, sizeBytes, chapters:[{id,t,s,e}]}`，s/e 为每章正文 UTF-8 字节区间，行界切片）；`gen-builtin-meta.mjs` 独立生成，77 部书全量。
- **运行时**：按章 `RNFS.read(path, e-s, s, 'utf8')` 切片读（毫秒级），水合/填充/FTS 三链路全部零整读；meta 缺失/损坏/sizeBytes 指纹不符整体回退旧整读慢路径。
- **对齐铁律**：meta 章序必须与 parseTxtBook 逐条一致——`builtinMetaIndex.test.ts` 77 部书全量对拍守卫（每章切片独立解析与全本逐段相等）。
- **真机目标**：点大书 ready 从 ~11.5s → <1s。

### ② 滚动模式首屏预算收紧（`computeScrollInitialRows` v2）
- 去掉 `longRowThreshold:300` 早退（真机盲区：资治通鉴级从不触发收缩），无条件按 `charBudget` 逐行累计；
- 默认 `charBudget` 3000 → **1200**（约 3~4 屏，论语级 750 字不受影响、道德经级单章短段不变，资治通鉴类 30 行收缩到 ~16-20 行）；
- `readerScroll.test.ts` 同步改写为新语义断言。

### ③ 打点基建（`[PERF]` 前缀）
- JS 心跳探针（50ms 间隔，gap≥300 记 `jsBlocked`）；startupTasks ≥20ms 计时；loadAndRegisterAll 总耗时 + registerBuiltinMeta/materialize 分段；library tap / reader mount / firstContentH。

### 真机回归点（r21）
- 卸装重装 → 冷启动 → 点资治通鉴：`meta-fast ready` 毫秒级、无 ~11.5s 转圈；
- 书架出现后立刻点卡片不被吞（启动期 jsBlocked 块消除或大幅缩短）；
- 首屏 `firstContentH` 大幅提前，滚动模式翻页/切章/锚点补偿不回归（既有红线）。

## 七、P0.6（r22，本轮实施）：重启点击无响应根治

### 真机归因（r21b 实测，tap 注入 32.3s → JS 处理 36.18s）
- **6.7s 单块真身**：warmPhrasePinyin 的 4.9MB 整文件 `readFileAssets`（native→JS 大字符串跨桥，与资治通鉴 9.4MB 整读 11.2s 同根因家族）+ `JSON.parse` + `Object.entries` + `Map` 构建——三段连续同步仅微任务间隔，单块 jsBlocked=6729ms；书架点击事件在 JS 队列排队 ~3.9s，被感知为「点卡片无响应」。
- **装载双跑**：App 启动 effect 与 LibraryScreen mount effect 各调一次 `loadBooks`，两轮 loadAndRegisterAll 并发（materialize 1.7s×2 交叠，无防重入）。

### 修复（commit e00aee9）
1. **词组数据分片化**：`build-phrase-pinyin.mjs` 改产 `data/phrase-pinyin/part-NNN.json`（~128KB/片 ×38 片，条目边界切分、裸对象格式）；APK 移除 4.9MB 整 json（减重）。运行时逐片读+parse+merge、片间 macrotask 让出（单块 <300ms）；全部完成后整体替换 phraseMapCache——晚到失效语义不变；分片缺失回退整文件路径（测试注入 loader 兼容，jest 无分片资产自动走回退）。
2. **loadAndRegisterAll 防重入单例**：in-flight 期间后续调用并入同一 promise。
3. **materializeBuiltins 8 并发分批**：77 部串行 bridge 往返 1.7s → ~0.3s 量级。

### 真机回归点（r22）
- 重启后 2 秒即点书卡：即时打开（tap 处理延迟 3.9s → ~1s 内含同步窗口，ready +1.4s）；
- 最大 jsBlocked 6729ms → **521ms**（38 片每片均 <300ms，`phrase mode=sharded count=179406`）；
- 注音正确性不回归（金标 125 条 + 词组层覆盖实测）。

## 八、P0.7（r23/r24，本轮实施）：滚动定位交互两连修

### ① 跳章后自动前滚一章（commit 8ea905d，APK r23）
- **现象**：目录跳章落位正确，~7s 后视口自动前滚到上一章（高频截帧实锤）。
- **根因**：prefetchNeighborChapters 无条件 prepend 上一章；落位 offset=0（列表顶端）时 Android MVCP 对头部插入的补偿不可靠 → 视口随插入回退。
- **修复**：预取 prepend 条件化（视口滚出半屏 && 非章首驻留期）；append 尾插无条件保留。

### ② 续读定位失败落章首（commit 38a89b5，APK r24）
- **现象**：章节中段退出再进入，落在章首（5%→3%）。
- **三重根因与修复**：
  1. `LOCATE_TIMEOUT_MS=1500` < 真机水合(~0.6s)+首屏布局(~2.3s) → 放宽 8000ms；
  2. seed effect 同轮 `scrollToIndex` 时 FlatList data 未提交（按旧 data 判越界）→ 双 rAF 包裹 + `onScrollToIndexFailed` 平均行高近似修正；
  3. **窗口跳跃挂载的目标行首次 onLayout y 为窗口相对值(=0)**，pending 精调按 y-24=0 把视口拽回章首（真机日志 `pending hit y=0 -> offset=0` 实锤）→ scrollToIndex 发出即置 pending done，禁掉 onLayout 二次修正。
- **真机验证（r24）**：庄子·齐物论中段（s11，5%）退出重进 → 恢复到 s11 邻域（5%）而非章首。
- **已知小偏差**：落位精度由 scrollToIndex 估算保障（注音行高差异大），可能偏离目标段 1-2 段，可接受；后续若要精确到行，需窗口跳跃后等待真实行高再二次落位（注意脏 y 过滤）。
- **记忆红线**：窗口跳跃挂载行的首次 onLayout y 不可用于视口修正；定位超时必须大于水合+首屏布局总耗时。

### 真机回归点（r24）
- 章节中段退出重进：恢复到退出位置邻域（非章首）——庄子/资治通鉴各验一次；
- 目录跳章：8s 内视口不前滚；
- 切章/注音切换/繁简切换锚点补偿不回归。

## 九、P0.8（r27-r29，本轮实施）：跳章后上滚拼接三连修

### 现象
跳转到靠后章节后往上滚动：上一章加载延迟、内容大幅跳动或出现空白。

### 三重根因与修复（commit 7e34a5a）
1. **空壳插入**：后台填充按书序进行，跳靠后章节时「上一章」仍是空壳（segments 空）
   ——插入空白、后台填到该章时整体替换行高暴涨。
   → prepend 拒插空壳；新增 `UserBookService.fillBuiltinChapterNow`（meta 切片
   毫秒级装配单章，与后台填充并发安全）；填充完成进度订阅自动补拼；
   新增「上一章预热」effect（章就绪即填充空壳的上一章，上滚零等待）。
2. **顶端插入视口跳动**：offset≈0 时 MVCP 不可靠 + 测量式锚点窗口化失效
   （旧行出窗 onLayout 永不触发；prepend 重挂新表头行 JS 阻塞 2-5s 打穿
   锚点超时）→ **scrollToIndex 对齐法**：按插入章行数对齐旧首行标题，
   估算偏差由标题行 onLayout 真实 y 修正（topAlignRef）；
   onContentSizeChange 兜底加陈旧 y 防护。
3. **续读定位**（r24-r26 前置修复）：cell 级测量（CellRendererComponent）+
   lastRead.offsetRatio 段内比例精修（即时首试）。

### 真机验证（r29）
- 跳 c32 → 章首上滚：c31 拼接后视口保持 c32 章首（top align est=0→y=8468）；
- 继续上滚自然进入渔父篇尾部（连续阅读，不跳章头）。

### 已知成本与后续候选
- prepend 重挂新表头 initialNumToRender 行（注音行重）单块 JS 阻塞 1-5s
  （短暂停顿，位置不丢）→ 候选：拼接章首批行轻量化渲染（先无注音后补）；
- 资治通鉴级（294 卷）的填充批次合并/FTS upsert 阻塞比庄子级更重，待观察。

## P0.9 未打开书籍跳章「一直 loading」（r30）

### 现象
打开一本未读过的内置书后直接目录跳章（尤其大部头远端章节），目标章
loading 转圈极久（大部头可达分钟级），用户感知「内容无法加载出来」。

### 根因（真机日志 + 代码实锤）
- ensureBookReady 对 early-hydrated 书（mount 水合完成后）的后续调用在
  `TextLibraryService.isBookHydrated` 处**早退**，直接返回当前书体——
  不补装新的 priorityChapterId（UserBookService.ts）。
- hydrate effect（ReaderScreen）依赖 chapterId 重跑时命中同一早退分支，
  同样不补装 → 跳到的空壳章无人装配。
- 唯一救援是后台 fillRemainingBuiltinChapters **按书序**（第 1 章起 30 章/批）
  推进到目标章：玉台新咏 390 章 fill 全程 92s、每 1-1.5s 一次 jsBlocked
  1-2s；跳到 fill 未到达处就要等完整推进——「一直 loading」。
- 复现时序注：r30 之前真机三轮盲测（荀子 c32 / 玉台新咏 c140 / 汉书 c114）
  均未踩中，因目录交互耗时 > fill 剩余时长，目标章恰好已被按书序填充覆盖。

### 修复（r30）
hydrate effect（ReaderScreen）：
- 抽出 `fillShellTargetIfNeeded()`：目标章在库中为空壳（segments.length===0）
  时调用 `fillBuiltinChapterNow`（meta 字节切片毫秒级单章装配，r27 引入，
  幂等 + in-flight 去重 + 完成后经进度订阅驱动 hydrateTick 自动解除 loading）。
- 两处调用：① isBookHydrated 早退分支（跳章重跑的常态路径）；
  ② mount 水合 promise resolve 后（竞争窗口：水合 in-flight 命中旧优先章时
  用户已跳章，新优先章未被装配）。

### 附带发现（独立问题，待修）
- **houhanshu.txt 资产损坏**：131 个 @@CH@@ 标记中前 130 个全为空标题骨架
  （目录堆叠），全书正文（11128 行）堆在最后一个错标「卷一上·光武帝纪第一·上」
  的章后 → 阅读器只有 1 章且为 2.7MB 巨章（mount hydrate 3.5s、正文渲染异常）。
  需重查 build-builtin-assets.mjs 对后汉书源文本的处理并重生成资产+meta。
- 大部头 fill 期间的持续性 jsBlocked（每批合并 hydrateBook 阻塞 1-2s）伤体验，
  候选：批次时间片内让出粒度优化。

### 附带修复：houhanshu.txt 资产损坏（r31）
- 根因：源文本（dzbook/houhanshu.txt）文件前部有 130 行目录（「卷X 标题」），
  正文标题则带书名前缀（「后汉书卷X …」「后汉书志第X …」）。houhanshu 配置
  缺 tocGuard 且 chapterPattern 不识别前缀标题 → 130 个目录行全被判为章标题
  （各章零正文=空壳），全书正文堆进末尾唯一的无前缀标题章（2.7MB 巨章）。
- 修复：buildDaizhigeBook 新增 stripHeadingPrefix（剥标题行书名前缀，前瞻限定
  后随卷/志编号，正文段行不受影响）+ houhanshu 启用 tocGuard（剥前缀后目录
  题名与正文标题规范化文本一致，repeats 判定可靠丢弃目录骨架）。
- 结果：129 章（目录 130 卷中卷四十六的正文标题行在源文本中缺失，其正文并入
  相邻章，无内容损失）；meta 字节区间与文本切片对拍一致。
- 顺带修正脚本生成 builtinCatalog.ts 的 toc 漂移：catalog 条目应为 {id,title}
  （运行时 buildBuiltinMetaBooks 消费 title；字节区间 s/e 属 <id>.meta.json
  专责，bundle 内不重复携带）。重跑全量构建其余 76 部资产/meta 幂等无变化。

## P1.0 大部头填充期持续卡顿根治（r34）

### 真机采样定位（r32 探针包，史记 130 章填充期）
- 每片装配仅 17-76ms（时间片本身工作正常），但每 ~0.75s 一次
  `fill-cb heavy=546-817ms` + `jsBlocked 600-850ms`——JS 线程持续饱和；
- 三个真因：① 填充通知回调**无条件 setHydrateTick** → 每次通知同步
  整树重渲染（填充推进的绝大多数批次与当前视口无关）；② 巨章（史记
  表章级几十万字）单章一次 read+toParagraphs 单块 930-1067ms——时间片
  「粒度=整章」失效；③ setTimeout(0) 让出仅 1-4ms，填充对 JS 占空比
  ~75%；通知还触发 assemble/hydrate（垃圾 + TextLibraryService 三级
  缓存置空 → 下次访问全量重建索引）。

### 修复（r34）
1. **通知回调 viewDirty 条件化**（ReaderScreen）：hydrateTick 仅在
   `changed`（拼接序列章被替换）或「当前章空→非空」边沿时递增；
   chapterRef 与库内章同引用（fill mutate 即时可见），边沿检测免渲染；
   切章 effect 重置边沿基准。
2. **meta 壳流式装配**（UserBookService）：字节分批读（64KB/批，
   RNFS 大切片 ~1MB/s 是巨章第二大块）+ 逐行产出段落（资产格式段落
   以 \n\n 分隔、段内无换行 ⇒「非空行=段落」与 toParagraphs 完全等价，
   7 类文本形态 × 5 种批大小对拍一致）+ 行级时间检查（单块上限 ≈ 单行
   切分毫秒级）；segments 增量 push（首段产出即解除 chapterPending，
   部分内容先渲染）；批尾无换行整批留 carry（行跨批截断防护，半行产出
   是对拍抓出的真 bug）。慢路径壳（bodyLines）保持一次性装配。
3. **片间让出 16ms + 合并/通知节流 1500ms**：填充退居真正的后台任务，
   成本（GC + 缓存重建 + 整树渲染）降一个量级；跳章兜底走
   fillBuiltinChapterNow（segments 直查）不受节流影响。

### 效果（真机复测，同场景对比）
- 修复前：每 ~0.75s 一次 600-850ms 饱和块（JS 持续 100% 占用）+ 巨章
  单块 1s+ + 通知块最高 5.1s；
- 修复后：稳态每 1.5s 一次装配 14-39ms、mergeNotify=0ms、
  采样期后段零 jank（无 ≥300ms 块）——填充期 UI 恢复流畅。
