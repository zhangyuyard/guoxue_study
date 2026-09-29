# legado 阅读器完整机制解析（100% 复刻基准）

> 源码基准：fork `log245/legado`（2023-08 全量，本机 `/tmp/legado-src`）。
> 精读文件：`ChapterProvider.kt`(757)、`TextChapter.kt`、`TextPage.kt`、`TextLine.kt`、`ZhLayout.kt`(260)、`TextPageFactory.kt`、`ContentTextView.kt`(702)、`PageView.kt`、`ReadView.kt`、`PageDelegate.kt`、`ScrollPageDelegate.kt`、`HorizontalPageDelegate.kt`、`CoverPageDelegate.kt`、`SlidePageDelegate.kt`、`SimulationPageDelegate.kt`、`ReadBook.kt`(538)、`ReadBookConfig.kt`(652)。
> 所有行号与语义均来自上述源码逐行精读。GPL-3.0：只学机制，零抄码。

---

## 0. 架构总览

```
ReadBookActivity（界面壳，1455 行）
 └─ ReadBook（全局状态单例：三章槽 + 进度真值 + 加载调度）
     └─ ReadView（FrameLayout，自绘容器）
         ├─ PageDelegate 家族（翻页交互策略，5 种）
         │    ├─ ScrollPageDelegate   ← 滚动模式（本项目对齐主目标）
         │    ├─ HorizontalPageDelegate（抽象：截图 + 方向 + scroller）
         │    │    ├─ SimulationPageDelegate（贝塞尔仿真）
         │    │    ├─ CoverPageDelegate（覆盖）
         │    │    └─ SlidePageDelegate（平移）
         │    └─ NoAnimPageDelegate（无动画）
         └─ PageView ×3（prev/cur/next，各包一个 ContentTextView + 头尾信息条）
              └─ ContentTextView（真正的自绘 View：排版行绘制 + 滚动状态机）
排版数据流：正文 → ContentProcessor(净化/替换) → ChapterProvider.getTextChapter()
         → TextChapter { TextPage[] } ← 每页 = 一屏行（页面切分在排版期完成）
页流解析：TextPageFactory（cur/next/nextPlus/prev，跨章透明）
```

**核心设计原则（五条，全部与本仓旧架构相反）：**
1. **排版期定页**：页 = 一屏行，在 `getTextChapter()` 排版时切好；运行期零分页计算。
2. **三页窗口**：任一时刻内存只有 prev/cur/next 三个 TextChapter（`ReadBook.prevTextChapter/curTextChapter/nextTextChapter`），窗口随章轮转，**永不增长、永不裁剪** ⇒ 无 FlatList 式窗口补偿问题。
3. **页流跨章透明**：`nextPage = 章内下页 or 下一章第 0 页`，章界在页工厂内部消化，滚动/翻页逻辑不感知章。
4. **进度真值 = char 偏移**：`durChapterIndex + durChapterPos`（章内字符偏移），页/行只是投影（`getPageIndexByCharIndex`）。任何页号变化都折算回 char 偏移持久化。
5. **同帧换页**：滚动跨页时在同一帧内完成「换 curPage + pageOffset 对账」，视觉上内容流连续无跳变。

---

## 1. 排版管线（ChapterProvider）

### 1.1 尺寸与边距
- `upLayout()`：`visibleWidth = viewWidth - paddingLeft - paddingRight`；`visibleHeight = viewHeight - paddingTop - paddingBottom`；双栏模式（平板/横屏，`doublePageHorizontal` 配置 0/1/2/3）`visibleWidth = viewWidth/2 - 左右 padding`，且右半栏起始 x = `viewWidth/2 + paddingLeft`（`leftLineSize` 记录左栏行数，供底对齐分段）。
- 行位置：`TextLine.upTopBottom(durY, paint)` → `lineTop = paddingTop + durY`，`lineBottom = lineTop + paint.textHeight`，`lineBase = lineBottom - fontMetrics.descent`。**行高 = paint.textHeight**，页内累计变量 `durY`。

### 1.2 分页算法（getTextChapter，durY 累积状态机）
```
durY=0, absStartX=paddingLeft, textPages=[新页]
标题行（titleMode != 2）：displayTitle 按 \n 拆行 → setTypeText(titlePaint, isTitle=true)
  → durY += titleBottomSpacing
每段 content：
  imgStyle=DEFAULT：imgPattern 切分「文本/图片」交替 → setTypeText / setTypeImage
  imgStyle=TEXT：图片替换为占位字符 ▩ 融入文本行（行内 ImageColumn）
setTypeText 内（逐 layout 行）：
  if durY + textHeight > visibleHeight:  // 溢出 → 翻页
      textPage.height = durY; textPage.text = 累积文本
      textPages.add(新页); durY = 0; absStartX = paddingLeft
      （双栏：absStartX = viewWidth/2 + paddingLeft，左栏满后才真翻页）
  行内容按三分支：
    首行(非标题) → addCharsToLineFirst：缩进字符独立列 + 其余两端对齐
    末行 → addCharsToLineNatural：自然排列（标题可居中：isMiddleTitle/卷名/空内容页）
    中间行 → addCharsToLineMiddle：两端对齐（无空格：均摊 residualWidth/(n-1)；有空格：撑空格）
  addLine 后 durY += textHeight * lineSpacingExtra;  page.height = durY
  段落结束：durY += textHeight * paragraphSpacing/10
末页：height = durY + 20dp（滚动模式末页底部余量）
全部页：index/pageSize/chapterIndex/chapterSize/title 回填；upLinesPosition()（底对齐）
```

### 1.3 两端对齐（textFullJustify，默认开）
- **首行**：缩进串（默认 `　　`）按单字宽独立成列（`indentWidth` 记录缩进宽），剩余字用 middle 算法。
- **中间行**：`residualWidth = visibleWidth - desiredWidth(自然宽)`；含空格>1 → 每个空格加宽 `d=residual/spaceCount`（末空格不加）；否则均摊到字间隙 `d=residual/(n-1)`。每列 `start/end` 精确记录（点击/选择/下划线全靠列坐标）。
- **超界回拉 exceed()**：末列超 visibleEnd 时整体左移，位移量按字数比例从行尾往行头递减。
- **底对齐（textBottomJustify，默认开）**：`upLinesPosition()`——末行 bottom 距 visibleBottom 的剩余高 `surplus`，均摊到各行 `tj = surplus/(行数-1)`，逐行加到 top/base/bottom；双栏分左/右两段各自均摊（`leftLineSize` 分界）。**页高同步 += surplus**。

### 1.4 ZhLayout（中文断行禁则，useZhLayout 默认关但中文书籍建议开）
- 替代 StaticLayout：逐字测量累积，超宽时按 6 种模式断行：
  - NORMAL：正常断（下一行从当前字起）
  - BREAK_ONE_CHAR：前行是禁尾标点（，。：？！…”』）等）/当前字是禁首标点（“（《【 等）→ 前行末字下移
  - BREAK_MORE_CHAR：连查到可断处
  - CPS_1/2/3：标点压缩（两禁首标点挤在行尾，压缩不换行）
  - 特殊情况 reCheck：向后扫描找到同时非禁首/禁尾的断点
- `lineWidth` 记录每行自然宽（供两端对齐 residualWidth 用）；末字写满断行时若还有剩余字符要额外多一行。

### 1.5 图片排版（setTypeImage）
- 取图片真实尺寸（ImageProvider 缓存）；FULL 样式：宽=visibleWidth，高等比；否则：超宽缩宽、超高缩高；`durY + height > visibleHeight` → 先翻页。
- 图片行：`TextLine(isImage=true)`，lineTop/lineBottom 包住图高，ImageColumn(start,end=水平居中偏移)。**图片是行类型，不是独立元素**。
- TEXT 样式：图片缩为行内字符 ▩（行内 ImageColumn，按行高绘制）。

### 1.6 msg 页（TextPage.format()）
- `isMsgPage`（loading/错误页）：文本按 StaticLayout 居中排版（垂直 `(visibleHeight-layout.height)/2`，水平每行 `(visibleWidth-lineMax)/2`），**height = visibleHeight（整页）**。滚动模式滚入未载章时显示它。

### 1.7 排版配置全集（ReadBookConfig.Config，默认值）
| 配置 | 默认 | 语义 |
|---|---|---|
| textSize | 20sp | 正文字号 |
| titleSize | 0 | 标题加量（标题字号 = textSize + titleSize） |
| textBold | 0 | 0正常/1粗/2细（标题正文分别处理，P+ 字重 900/300） |
| textFont | "" | 自定义字体路径 |
| letterSpacing | 0.1 | 字间距（Paint.letterSpacing） |
| lineSpacingExtra | 12 | 行距系数（实际乘 `textHeight * /10`） |
| paragraphSpacing | 2 | 段距系数（`textHeight * /10`） |
| titleMode | 0 | 0居左/1居中/2隐藏 |
| titleTopSpacing/BottomSpacing | 0/0 | 标题上下距（dp） |
| paragraphIndent | "　　" | 缩进串（逐字成列） |
| textFullJustify | true | 两端对齐 |
| textBottomJustify | true | 底对齐 |
| useZhLayout | false | 中文断行禁则 |
| underline | false | 段落首行下划线（贴 lineBottom-1dp） |
| padding[T/B/L/R] | 6/6/16/16 dp | 版心边距 |
| pageAnim | 0 | 0覆盖/1平移/2仿真/3滚动/4无动画 |
| bg/textColor | 白天#EEEEEE/#3E3D3B、夜#000000/#ADADAD、EInk | 三套主题 |

---

## 2. 页流（TextPageFactory：cur/next/nextPlus/prev 解析）

```
hasPrev    = hasPrevChapter() || pageIndex > 0
hasNext    = hasNextChapter() || !currentChapter.isLastIndex(pageIndex)
hasNextPlus= hasNextChapter() || pageIndex < pageSize - 2
curPage    = currentChapter.getPage(pageIndex)
nextPage   = 章内 pageIndex+1；否则 nextChapter.getPage(0)；无下一章 → 空页
nextPlusPage = 章内 pageIndex+2；否则（章尾页时）nextChapter.getPage(0)；
             否则 nextChapter.getPage(1)；再无 → 「继续滑动以加载下一章…」msg
prevPage   = 章内 pageIndex-1；否则 prevChapter.lastPage
moveToNext(upContent=false)：
  章内 → ReadBook.setPageIndex(pageIndex+1)（durChapterPos=getReadLength(idx)，saveRead，无 UI 刷新）
  章尾 → ReadBook.moveToNextChapter(false)（章轮转，见 §4）
moveToPrev(upContent=false)：镜像（章首页 → moveToPrevChapter）
```
**关键**：滚动模式跨页走 `moveToNext(false)`——章内换页只更新进度**不刷新 UI**（UI 由 ContentTextView 自己的换页保持连续）；跨章才触发章状态机。

---

## 3. 滚动模式（ScrollPageDelegate + ContentTextView）★ 复刻主目标

### 3.1 视图结构
- ReadView 只把 `curPage`（PageView）当滚动容器（prev/next PageView 隐形闲置）。ContentTextView 是单 View 自绘。
- 绘制三段（`drawPage`）：
  - `relativePage(0)=curPage` 画在 `relativeOffset(0)=pageOffset`
  - `relativePage(1)=nextPage` 画在 `pageOffset + curPage.height`
  - `relativePage(2)=nextPlusPage` 画在 `pageOffset + curPage.height + nextPage.height`（仅当该 offset < visibleHeight，即可能露头才画）
- 可见裁剪 `canvas.clipRect(visibleRect)`；无 prev 段（向上滚用 pageOffset>0 表达，curPage 内部下移露「上方空白+上一章在换页时接进来」——**实际向上跨页由 moveToPrev 换 curPage 完成，同帧对账**）。

### 3.2 scroll(dy) 状态机（ContentTextView.kt:273-301，逐行语义）
```
scroll(mOffset):                          // mOffset = 本帧 dy（+内容下移/-上移）
  if mOffset == 0 return
  pageOffset += mOffset
  if !hasPrev && pageOffset > 0:          // 顶钳（无上页橡皮筋禁用）
      pageOffset = 0
  elif !hasNext && pageOffset < 0
       && pageOffset + curPage.height < visibleHeight:   // 尾钳（末章封底）
      pageOffset = min(0, visibleHeight - curPage.height)
  elif pageOffset > 0:                    // 向上跨页
      pageFactory.moveToPrev(false)       //   章内：pageIndex--；章首：moveToPrevChapter（章轮转+预载）
      textPage = pageFactory.curPage      //   换 curPage
      pageOffset -= textPage.height       //   对账（同帧）
      upView?.invoke(textPage)            //   进度条刷新（页码/进度%）
  elif pageOffset < -curPage.height:      // 向下跨页
      pageOffset += textPage.height
      pageFactory.moveToNext(false)
      textPage = pageFactory.curPage
      upView?.invoke(textPage)
  invalidate()                            // 每次滚动都全帧重绘
```
- **换页是同步记账**：新 curPage 就是原来画在下方的 nextPage，offset 对账后三段拼接的相对位置不变 ⇒ 视觉零跳变、零闪烁。**无任何动画、无边界对齐、无回弹**（顶/底钳制是硬钳）。
- 多页大步（快 fling 一帧跨多页）：legado 用单次 if——一帧 dy 超 2 页高时会停在中途（frame 内 dy 很少超 1 页），复刻可用 while 循环逐页对账（更稳）。

### 3.3 手势与惯性（ScrollPageDelegate）
- `onTouch`：DOWN → abortAnim + velocity.clear；MOVE → onScroll（记录 isMoved、喂 VelocityTracker，computeCurrentVelocity(1000)）；UP/CANCEL → `onAnimStart` = `fling(0, touchY, 0, -vy, 0, 0, -10*viewHeight, 10*viewHeight)`。
- **fling 边界极宽松（±10 屏）**——真正的钳制在 scroll() 状态机里，惯性滚动自由越过页界，逐帧触发换页对账。
- Scroller（LinearInterpolator）每帧 `computeScrollOffset` → `readView.setTouchPoint(currX, currY)` → lastY/touchY 差值 → `onScroll()` → `curPage.scroll(touchY - lastY)`。**fling 物理与 RN `Animated.decay` 同族（摩擦衰减）**。
- 按下即 `abortAnim()`（isAbortAnim 标记防 abort 后又起动画）。
- `noAnim` 配置：`noAnimScrollPage` 开启时点击翻页直接 `curPage.scroll(calcNextPageOffset())` 无动画。

### 3.4 点击翻页（保留一行，calcNextPageOffset）
```
next: offset = 可见页最后一行.lineTop - paddingTop → 负向平移该值
      （图片页/无字页：整屏 -visibleHeight）
prev: offset = visibleHeight - (首行.lineBottom - paddingTop) → 正向平移
执行：startScroll(0,0,0,offset,300) → Scroller 匀速 → 每帧 scroll(dy)
```
**本质**：点击翻页只是「滚一段」，跨页仍由 scroll() 状态机自然发生 ⇒ 连点两次 = 平滑滚两屏，无页号跳变。

### 3.5 章界与进度
- 跨章（moveToNextChapter）时槽轮转保证 nextChapter 就位；未就位 → nextChapter=null → nextPage=空页/msg 页（loading），滚入后停在空页边界，等 `contentLoadFinish` 的 upContent 刷新。
- 进度：跨页（章内或跨章）`setPageIndex` → `durChapterPos = getReadLength(pageIndex)`（char 偏移）→ `saveRead()` 持久化。**恢复阅读：durChapterPos → getPageIndexByCharIndex → pageIndex + TextChapter.getPage(pageIndex)**，滚动 pageOffset 从 0 开始。
- 页脚信息：`upView` 回调 → `PageView.setProgress`（页码 index+1/pageSize、进度% readProgress = chapterIndex/chapterSize + (index+1)/pageSize 权重）。

---

## 4. 章状态机（ReadBook）

### 4.1 三章槽轮转
```
moveToNextChapter(upContent):
  durChapterPos = 0; durChapterIndex++
  prev = cur; cur = next; next = null
  cur == null → loadContent(durChapterIndex, upContent, false)   // 未载则加载
  loadContent(durChapterIndex + 1, ...)                          // 始终预载下一章
  saveRead(); curPageChanged()
moveToPrevChapter: 镜像（durChapterPos = prevChapter.lastReadLength 或 0）
```

### 4.2 加载
- `loadContent(resetPageOffset)`：载 cur±1 三向；`addLoading` 去重表防并发重载。
- `contentLoadFinish`：**只有 index ∈ [dur-1, dur+1] 才接收**（防跳章后旧结果污染槽位）；排版在 async 协程；完成后按 offset 写槽 + `upContent(offset, resetPageOffset)` 刷新。
- 预下载：`preDownload`（cur+2..cur+preDownloadNum 与反向 5 章）。

### 4.3 curPageChanged（页/章变化统一钩子）
`pageChanged 回调（页脚/菜单刷新）→ 朗读跟随 → upReadTime → preDownload`。

---

## 5. 翻页动画家族（page 模式，后续对齐备用）

- **Horizontal 家族通用骨架**：
  - 按下/移动：`setDirection(PREV/NEXT)`（首次越 slop 时判定方向并 `setBitmap()` 截 prev/cur 或 next/cur 三张位图）；拖动 `setTouchPoint(sumX, sumY)` 触发重绘（动画帧画位图）。
  - 反向拖 = `isCancel`（回滚不翻页）。
  - UP → `onAnimStart`：按当前位移算终点 `startScroll(touchX, 0, distanceX, 0, speed)`；动画完 `onAnimStop` → `!isCancel` 时 `readView.fillPage(direction)` = `pageFactory.moveToPrev/Next(true)`（带 upContent 刷新三槽 + resetPageOffset）。
  - 拖动中途再按下：`abortAnim` → `!isCancel` 时 `fillPage` 先落定（**防动画中重入错页**）。
- **Cover**：next 方向：cur 从 (offsetX-viewWidth) 滑出盖住 next；prev 方向：prev 从左滑入。左缘 30px 阴影渐变。
- **Slide**：双位图平移（next/prev 相邻拼接），无阴影。
- **Simulation**：贝塞尔卷页（mPath0/mPath1 双路径裁剪 + 正背面颜色矩阵 + 折角阴影 GradientDrawable×4 + Matrix 顶点变换），mIsRtOrLb 区分触摸角。
- **NoAnim**：onDraw 空；`fillPage` 直切。

---

## 6. 交互面（ReadView / ReadBookActivity）

### 6.1 九宫格点击（setRect9x：33% 三分；mc 特判 36% 起防误触）
`clickAction{TL,TC,TR,ML,MC,MR,BL,BC,BR}` 各自可配 12 种 action：
0 菜单（默认 MC）/1 下一页/2 上一页/3 下一章/4 上一章/5 上一段朗读/6 下一段朗读/7 添加书签/8 内容编辑/9 替换净化开关/10 目录/11 搜索。默认：BL/BC/BR=翻下页，TL/TR=翻上页，ML/MR=菜单。
- 点击事件由 `onSingleTapUp`（isPageMove=false 时）分发；长按 600ms 起文本选择； slop 判定走 `pageSlopSquare`（可配置 touchSlop）。

### 6.2 其他
- 自动翻页（autoPage：nextPage 截图按进度条覆盖绘制）、长截图（dispatchTouchEvent 期间 scrollY 平移 + canvas.translate 截长图）、朗读跟随（isReadAloud 行高亮 + upPageAloudSpan 段落级定位）、文本选择（selectStart/End TextPos 三元组 relativePagePos/lineIndex/columnIndex）。

---

## 8. 三轮补漏（全量覆盖确认）

1. **列模型**（5 小文件）：`BaseColumn{start,end,isTouch(x)}`；`TextColumn{charData, selected, isSearchResult}`；`ImageColumn{src}`；`ButtonColumn`/`ReviewColumn`（段评按钮，功能面外）。列坐标是选择/下划线/点击定位的原子。
2. **ContentProcessor 净化管线**（排版输入端，201 行全读）：去重复标题（正文首部与章名同形时剪除，正则含书名/标点/空白前缀）→ `reSegment` 重分段 → 简繁转换 → 替换规则 → 逐段 trim（code≤0x20 与全角空格）→ **首段（标题）不加缩进、其余段统一前置 `paragraphIndent`**。`sameTitleRemoved` 回传 TextChapter。⇒ 本仓导入管线对齐点：缩进在净化期拼入段落文本，排版期只识别不生成。
3. **进度保存时机**：页/章每次变化 `setPageIndex/moveToNextChapter → saveRead()`（协程异步写库）+ `onPause` 兜底 saveRead + 全文搜索/跳章前 `saveCurrentBookProcess` 快照、退出恢复。
4. **点击默认值**（AppConfig）：TL/TC/ML/BL=2（上一页）、TR/MR/BC/BR=1（下一页）、MC=0（菜单）；九宫格全非 0 时强制 MC=0（保菜单入口）。`pageTouchSlop` 可配（默认=系统 slop）；`noAnimScrollPage`（滚动点击翻页无动画，默认 false）。
5. **SimulationPageDelegate 结构要点**（572 行，卷页数学，page 模式后续票）：`calcCornerXY` 触摸角判定（左右下三角区）→ `calcPoints` 贝塞尔顶点/控制点/交点计算（getCross 直线交点）→ 双 Path（mPath0 卷起正面 / mPath1 背面）裁剪 → 分层绘制：下一页区+阴影 / 当前页区 / 正面 / 背面(mColorMatrixFilter) / 当前页阴影 / 折角阴影 GradientDrawable。
6. **NoAnimPageDelegate**：`onAnimStart` 直接 `fillPage`（无动画翻页即落定）。
7. **upContent 全链**：Activity 直通 ReadView；滚动模式只 `setContent(curPage, resetPageOffset)`；跳章 `setProgress → clearTextChapter → loadContent(true)` 从 durChapterPos 投影页重启。

**三轮检查结论：滚动模式复刻所需机制 100% 闭环，无遗漏。**

---



### 7.1 数据层（对齐 §1/§2）
| legado | RN 复刻 | 文件 |
|---|---|---|
| TextChapter{TextPage[]}（排版期切页） | `layoutChapter` 产出行 → `chunkLines(lines, linesPerPage)` 排版后切页（行高恒定 rowHeight 时等价） | `pagination.ts` |
| TextPage.height | `lines.length * rowHeight`（页块高；末页余量行自然更矮） | ScrollReader |
| TextPageFactory 页流 | `pageFlow.ts` 纯函数：`resolvePage(chapters[], pr, dir)`（章内下页 or 下一章第 0 页；未载 → loading 页标记） | 新建 |
| durChapterPos char 真值 | 既有 `recordProgress(segmentId, charOffset)` 不变 | ReaderScreen |
| msg 页 | loading 占位块（高=一屏，文本居中） | ScrollReader |
| upLinesPosition 底对齐 | **暂不对齐**（等宽行高模型下等价于行距微调；留待排版引擎升级） | — |

### 7.2 视图层（对齐 §3.1）
```
<ScrollReader>                                  ← 替换 ScrollPager，删除旧组件
  <Animated.View translateY={offset}>           ← 单一滚动容器（对应 ContentTextView）
    <PageBlock pr={cur}/>                       ← curPage（renderLine 逐行渲染）
    <PageBlock pr={next}/>                      ← nextPage
    <PageBlock pr={nextPlus}/>                  ← nextPlusPage（offset 越界才可能露头，常驻渲染成本 ~3 页 DOM）
  </Animated.View>
</ScrollReader>
```
- 页块纵排 flex（block 高 = 页行数×rowHeight），`offset` Animated.Value（JS driver）。
- **无 FlatList、无 itemHeight 恒定假设破绽、无 contentSize 钳制、无重挂**。

### 7.3 滚动状态机（对齐 §3.2，逐条对应）
- PanResponder MOVE：`applyScroll(dy)`（同步，ref 为真值源，setState 仅镜像）：
  1. `off += dy`
  2. `!canPrev && off>0 → off=0`
  3. `while off>0 && canPrev`: `pr=resolve(-1); off -= pageHeight(pr)`（**先换页后对账**，legado 同序）
  4. `!canNext && off + curH < viewportH → off = min(0, viewportH - curH)`
  5. `while off < -curH && canNext`: `off += curH; pr=resolve(+1)`（**先对账后换页**，legado 同序）
  6. `pr.chapterId` 变 → `onChapterCommit`（ReaderScreen: openChapter+recordProgress；窗口裁剪延后到静止）
  7. `offset.setValue(off)` + setState 镜像（同一 JS 任务，同帧 flush）
- UP：`Animated.decay(offset, {velocity: vy*1000, deceleration: 0.997})`（对应 fling；listener 内差值喂 applyScroll）；按下 `offset.stopAnimation()`（对应 abortAnim）。
- 点击翻页：timing 平移 `±(curH - rowHeight)`（保留一行；等价 calcNextPageOffset）——**滚一段而非跳页**，跨页交给状态机。
- canPrev/canNext 解析失败（邻章未载）→ 滚入 loading 占位页（高=一屏）后钳住，装载完成 props 更新自然续流（legado msg 页同行为）。

### 7.4 与旧实现的切割清单
- 删 `ScrollPager.tsx`（离散三槽翻页器——方向性错误：legado 滚动不是离散翻页）。
- ReaderScreen 删 pagerPages/pagerFallback/pagerHasNext memos；`chunkLines` 移交 pageFlow 使用。
- STITCHDBG 探针：新架构验收通过后统一删。
- page 模式（FlatList）本轮不动（后续按 §5 家族对齐仿真/覆盖动画，独立票）。

### 7.5 二轮补漏（动工前确认，5 项关键机制闭环）
1. **pageIndex 非状态**：`DataSource.pageIndex = ReadBook.durPageIndex`（默认实现）——页号是 `durChapterPos`（char 偏移）的投影（`getPageIndexByCharIndex`），每次取页现算。⇒ RN：pageRef 的真值锚定在 (chapterId, charOffset)，页号只是派生。
2. **三段绘制无刷新回调**：ContentTextView.drawPage 每帧从 `pageFactory.curPage/nextPage/nextPlusPage` **getter 现取**（getter 内部又从 ReadBook 三槽现取）⇒ 槽位一变下一帧自动生效。只有 curPage 例外：scroll() 跨页时显式 `textPage = pageFactory.curPage`（对账需要页高）。⇒ RN：三页块 = 派生数据每次 render 现算（useMemo），不手动同步。
3. **滚动模式 upContent 只刷 cur**：`curPage.setContent(pageFactory.curPage, resetPageOffset)`（ReadView.upContent L528-530），next/nextPlus 不动（它们本来就每帧现取）。跳章/配置变更 resetPageOffset=true → pageOffset=0 从 durChapterPos 投影页重新开始。
4. **hasNextChapter = 书级边界**（`durChapterIndex < chapterSize-1`），与邻章是否已载无关——未载滚入显示空页/msg 页（legado msg=「加载中/失败」，height=整屏）。RN 同构：邻章未载 → loading 占位块（高=一屏），钳住。
5. **isInitFinish 闸门**：章未初始化时三槽全 null → TextPage() 空页，防初始抖动。

### 7.6 已知差异声明（复刻例外）
1. 自绘 Canvas → RN View 树：列级坐标（选择/下划线/列点击）暂以行为粒度（本仓无文本选择/批注功能面）。
2. VelocityTracker(1000ms) → PanResponder vy + decay 摩擦系数：手感级差异，装机调参。
3. 双栏/EInk/朗读/自动翻页/长截图：功能面外，不复刻。
4. 底对齐（textBottomJustify）：行高恒定模型下行距均摊会破 INV-G1，留排版引擎升级票。
```
