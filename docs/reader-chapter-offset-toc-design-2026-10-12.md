# 章节改偏移量　设计文档（2026-10-12）

> 目标：消掉「冷启 → 导入书上书架」的 **6275ms**（读12.78MB 纯文本缓存，占总 8.2s 的 69%）。
> 手段：`Chapter.segments`（正文字符串实体数组）→ 正文按需读取，改为存偏移量目录。

## 0. 为什么要做（真机读数）

`deliverables/flick-fix-2026-10-12/shelf-detail.log`（161MB epub / 980 章，`.gxbook` 缓存**已存在**）：

| 段 | 耗时 |
|---|---|
| 读 12.78MB `.gxbook` | **6275ms** |
| `parseTxtBookChunked` 重建 980 章 | 1785ms |
| 启动 + `library-sync done builtin=77` | 232ms |
| `notifyUserBooksChanged` → 上屏 | ~120ms |

缓存已经存在却仍整本读，根因＝`Chapter.segments` 是**实体数组**，切章必须正文在手。

## 1. 关键决策

### 1.1 基准＝**UTF-8 字节偏移**（对 `.gxbook`），锚点＝**行边界**

字符偏移不可行（换算字节须先解码全文）；行号+行内偏移不可行（定位仍要扫过前序行）。
只有字节偏移能被 `RNFS.read(path, len, offset, 'base64')` O(1) 随机访问。

切章判据 100% 是整行（`splitRawChapters:3975` 先 `split('\n')`，
`CHAPTER_TITLE_RE:3726` 带 `^\\s*…\\s*$` 锚点）⇒ 章边界天然落在行边界 ⇒ 字节对齐安全。

### 1.2 ★前置改动：`.gxbook` 必须改存**归一化后**文本

现状链路（已核实）：
```
readFileBytes → decodeTextBytes → text（CRLF 保留）
→ parseTxtBookChunked:4145  const normalized = text.replace(/\r\n?/g,'\n')
→ parseBookFile:4284  return { ..., text }      ← 返回的是【未归一化】的 text
→ processOversizedBooks:4521  RNFS.writeFile(t.cachePath, parsed.text, 'utf8')
```
`.gxbook` 落的是**归一化前**文本，而偏移量必须相对**归一化后**文本算——
偏差随 CRLF 数线性增长（10 万行 CRLF ⇒ 第 900 章偏 9 万字节 ⇒ **静默显示错章，不报错**）。

⇒ 改 `.gxbook` 后缀作废旧缓存（沿用本仓 T23c 既有做法，见常量注释 `:160-163`），
`contentHash` 同步改口径。

### 1.3 只存「章起止 + 段数」，段落边界**读取时重算**

`toParagraphs:3756` 是纯函数（4 条确定性规则）⇒ 切片整章重算的结果与全量解析**逐段相同**
⇒ 段 id（`${chapterId}-s${idx+1}`）不变 ⇒ FTS 行/划线/笔记锚点/背诵进度**全部保持有效，无需迁移**。

存储恒定 ~54 KB（980 章），而存全部段偏移是 ~740 KB（典型）/ ~2.2 MB（密集）⇒ **不划算，不存**。

⚠ **必须锁死**：`toParagraphs` 第 2 条是**整章级**二选一
（`normalized.includes('\n\n') ? split(/\n{2,}/) : split(/\n+/)`）
⇒ 最小读取粒度必须是**章**，读一半就切会与全章判定不一致、段落边界漂移。

顺带收益：`runChapterStreamingStep:2791` 用的是「非空行＝段落」，与 `toParagraphs` 是**双实现**，
仅对资产格式等价（注释 `:2783-2785` 自己承认）。重算方案统一走 `toParagraphs` ⇒ 消除该分叉。

### 1.4 `.gxbook.toc` 格式

照内置书先例（`BuiltinMetaFile` 结构，`:703-710`；实测 meta/txt = 0.63%）：

```jsonc
{
  "v": 2,                    // 版本，2 = 归一化口径
  "bookId": "...",           // 对齐 stableBookIdFromPath:4472
  "sizeBytes": 12781299,     // .gxbook 字节数 —— 指纹校验
  "fileSig": "...",          // 源文件 mtime:size
  "contentHash": "...",
  "markers": true,           // ★必须存：isStructuredFormat(ext):4495 决定的分支
  "paraRule": { "maxSegChars": 2500, "blankLine": "auto" },  // 规则指纹，变更即 bump v
  "chapters": [ { "id": "b-c1", "t": "第一章", "s": 0, "e": 12345, "n": 80 } ]
}
```
`s`/`e`＝正文在 `.gxbook` 中的字节区间 `[s,e)`，**不含标题行**。
`n`＝段数（让「本书多少段」在不读正文时可知，供 `finishParsedBook:4065` 的 description）。

**失效判据**（照搬内置书 `loadBuiltinMeta:728-748` 口径）：
toc 缺失 / `v!==2` / `sizeBytes` 不符 / `chapters[i].id !== ${bookId}-c${i+1}` / 区间越界 ⇒ 整本重解析。

⚠ 顺带修一个现存缺陷：`meta.fileSig`/`contentHash` **写入但从不校验**
（`:4485-4502` 只用了 `title`/`author`）⇒ 源文件改动后旧缓存被无限期复用且静默无提示。

## 2. 🔴 两个阻塞（必须先解，否则下游改得再漂亮也没用）

### 阻塞 A：用户书**没有局部物化通道**

`TextLibraryService.ts:194-196`：
```ts
if (isUserBookId(book.id)) {
  return { success: false, error: `用户书不支持水合：${book.id}` };
}
```
且 `registerUserBooks:104-113` 是**整体替换**（`segmentIndex = null; buildIndexes()`）。
⇒ 按需物化出来的正文会被**下一次注册整体抹掉**。
内置书有「壳 → hydrate → LRU」三级，用户书只有「全量注册」一档。

**解法**：给 `Chapter` 加 `readiness` 字段，并把注册从「整体替换」改为「按章合并」
（或照搬内置书的壳/hydrate/LRU 三级）。**这是本重构最大的架构改动。**

### 阻塞 B：`segments.length === 0` 已被占用为「未装载」信号

`ReaderScreen.tsx:183`：
```ts
if (chapterRes.data.segments.length === 0) {
  const filled = await UserBookService.degradeChapterToWholeRead(bookId, cid);
```
offsets 化后「未读」与「已装载」都是空数组 ⇒ **判据失去区分能力**
⇒ 会把「已装载」误判为「未装载」而反复触发降级直读。
**解法**：语义迁到独立的 `readiness` 字段（内置书已有 `READY_FULL`/`Partial` 词汇，见 `:2361-2373`）。

### 2.1 ★★ 实测修正（2026-10-12 勘察，设计文档上文两节与实测**不一致**，以下为准）

**阻塞 A 的真实形态不是「按需物化被抹掉」，而是「用户书压根没有按需物化这条路」。**
上文「按需物化出来的正文会被下一次注册整体抹掉」需要**先有**按需物化通道才成立，
实测该通道**不存在**：

| 证据 | 位置 |
|---|---|
| 注册入参来自 `JSON.parse(row.data)` = db 缓存的**完整** `Book`（含全部 segments） | `UBS:4809` |
| 或本轮 `parseBookFile` 的**全量**解析结果 | `UBS:4859` |
| 复解析失败时 `retainKnownUserBook` 同样是完整 `Book` | `UBS:4826` |
| ⇒ **用户书注册时就是全量正文**，「局部物化」无发生机会 | — |
| `hydrateBook` 明令用户书不走此路径（但因上条，该禁令目前**无实际约束力**） | `TLS:194-196` |

⇒ **解法比原设想更大**：不是「保护已有的按需物化」，而是**从零新建用户书的
壳/hydrate 通道**（内置书已有全套：meta 壳 + `fillCursor` 流式装配 + LRU 卸载 + `onBookEvicted`）。
⇒ 但**这一步单独做没有收益**：offsets 化没落地时「壳 + 按需物化」等于凭空多一次读。

### 2.1a ★★ 实测修正之二（2026-10-13 勘察，**推翻上一节的结论**）

上一节写「用户书压根没有按需物化这条路，通道不存在」——**这是错的**。
通道**存在且已被真机验证并由 3 套判据锁着**，只是被用户书路径挡住：

| 事实 | 位置 |
|---|---|
| 内置书的字节切片通道（meta → 按章 `RNFS.read` 读区间，零整读）| `loadBuiltinMeta` / `readBuiltinChapterSlice` / `readBuiltinChapterRange` |
| 该通道有真机事故史与专测（UTF-8 边界严格解码抛错 ⇒ 首批零产出 ⇒ 整页转圈）| `#20` / `builtinSliceUtf8Boundary.test.ts` / `chapterSilentTruncationRepair.test.ts` |
| 阅读器空壳兜底**已存在**：`segments.length === 0` ⇒ `degradeChapterToWholeRead` ⇒ `fillBuiltinChapterNow(force)` | `ReaderScreen.tsx:183-198` |
| `ensureBookReady` 对用户书直接 `getBook` 返回 ⇒ 目录态也返回 success | `UBS` 内置书早退分支 |
| ★**但** `fillBuiltinChapterNow` 开头 `if (!spec) return false` ⇒ **用户书恒退** ⇒ 兜底恒失败 ⇒ 目录态书点开必 `throw '章节正文加载失败'` | `fillBuiltinChapterNow` 首部 |

⇒ **真正的阻塞不是「通道不存在」，而是「通道被 `getBuiltinSpec` 早退挡住」**
⇒ 解法从「从零新建」降级为「**路径泛化**」：把 `readBuiltinChapterSlice`
  的路径抽成通用 `readFileSliceUtf8Safe(filePath, s, e, tag)`，
  再让 `fillBuiltinChapterNow` 按「内置书走 meta / 用户书走 `.gxbook.toc`」分流。
⇒ ★**因此 ⑥「消费端接线」与「泛化」必须同时做**：只做目录态注册不做泛化，
  书能上架但点开必报错（比不做更坏）。

**阻塞 B 的判据点是 6 处，不是 1 处**（实测 `grep -nE 'segments\.length === 0|segments\.length > 0'` 全仓）：

| # | 位置 | 用途 |
|---|---|---|
| 1 | `ReaderScreen.tsx:183` | 首开空壳兜底 ⇒ 触发 `degradeChapterToWholeRead` |
| 2 | `ReaderScreen.tsx:194` | 兜底后复判，仍空 ⇒ 抛「章节正文加载失败」 |
| 3 | `StorageService.ts:944` | FTS 章级写入的空章零动作门 |
| 4 | `UBS:1832` | `fillBuiltinChapterNow` 的幂等门（已有正文则直接 true） |
| 5 | `UBS:5616` | `builtinChapterReadiness` 的 Empty 门（★红线④：空壳永不进拼接序列） |
| 6 | `UBS:5907` | `getChapterContentQuality` 的 `'empty'` 门 |

⚠ 第 4/5/6 处**不得**在 offsets 化前改动：它们承载的是**实测过的真机语义**
（`UBS:2890` 注释明确「旧写法 `segments.length > 0 ? 'done'` 会把『未证实完整』
当『已完整』」——#20 的 c169 paras=148 事故就是这么来的）。迁移必须**逐处**做，
且每一处都要能证明「新判据在旧输入上与旧判据逐例等价」。

### 2.2 ★因此调整落地顺序（原步骤 4 前移到步骤 5 之后）

原 §4 第 4 步「解阻塞 A/B」现改为**第 5 步之后**的一步，理由：
① 阻塞 A 的通道在 offsets 化前**没有消费者**（凭空多一次读，纯负收益）；
② 阻塞 B 的 6 处判据在 offsets 化前**语义未变**（「未装载」仍等于「空数组」），
提前改只增加回归面、无收益；
③ 阻塞 B 的迁移判据必须是「新旧判据在旧输入上逐例等价」——这需要先有
偏移量落地后的真实输入样本才写得出来。

⇒ **新顺序**：步骤 1–3（已落地）→ 改 `.gxbook` 落归一化文本 + 新增 `.gxbook.toc`
→ 让 161MB 书走 toc 路径（**兑现 6275ms**）→ 解阻塞 B（6 处逐处迁移）→
建用户书壳/hydrate 通道（兑现阻塞 A）。


## 3. 其余消费者（勘察结论：52/55 处几乎白送）

| 类别 | 处数 | 处理 |
|---|---|---|
| **纯 `.length` / 只写** | 19 | 换`segCount` / `charCount`，成本同阶。★`UBS:3207` 有契约测试正则锁定源码文本，要一并改 |
| **阅读器窗口** | 8 | 窗口 ≤3 章（`retainSetFor:228` = 中心∪前后邻），零全书遍历。★`RS:201` 的 `[...segments].sort(by order)` 可直接删（区间天然单调）。**必须保住三条不变量**（`geometry.ts:169`）：段内有序、id 稳定、章内码点偏移连续累加 |
| **背诵/填空** | 5 | 路由单章（`RPS:79` 只带一个 `chapterId`），零跨章随机。`buildCoverChars`/`buildBlanks` 逐字不动 |
| **FTS** | 6 |★**不是障碍**：161MB 书早被 `FTS_MAX_BOOK_CHARS=4M`（`StorageService:654`）挡在门外。且写入侧**已经是章级**（`buildAndInsertChapterFts:735`）。⚠️ **但 `bookTextChars:660` 必须改**：它`sg.text.length` 遍历全书，offsets 化后恒返回 ~0 ⇒ **FTS 闸门形同虚设，中等书会被误判为「很小」而全部入索引**，反而制造新卡顿 |
| **死代码** | 1 | `bookToMarkerText:496`（整本拍平）全仓无调用方 |
| **全量聚合器** | 2 | `allSegments:391`（唯一实质调用方是 SearchService 回退；`StorageService:614` 的调用**结果丢弃**）＋ `buildIndexes:83`（`segmentIndex` 只服务 `NotesListScreen:109` 的单条取用）⇒ 冷启动省一整轮 Map 构建 |
| **流式装配状态机** | 4 | `UBS:2922/2932` + 自洽校验（`:2819/2892/2593`）不依赖「段是字符串」，只依赖「可增量追加且长度可比」⇒ `push` 变追加 `{s,e}`、语义**完全平移** |

## 4. 落地顺序（每步独立可合并、可回滚）

1. **加目录字段**（`segCount`/`charCount`/`range`）让 19 处 `.length` 有替身 → 零风险
2. **修 `bookTextChars:660`** → 拆掉唯一硬障碍（FTS 闸门）
3. **删 `allSegments` ＋ `StorageService:617` 的丢弃调用**；`buildIndexes` 降为章级
4. **改 `.gxbook` 落归一化文本 + 新增 `.gxbook.toc`**（后缀改 ⇒ 旧缓存自动失效）
5. **让 161MB 书走 toc 路径** ← 这一步才真正兑现 6275ms 收益
6. **解阻塞 B**（6 处判据逐处迁到 `readiness`，每处须证「新旧判据在旧输入上逐例等价」）
7. **建用户书壳/hydrate 通道**（解阻塞 A：从零新建，offsets 化后才划算）

### 4.1 步骤 6 实施记录（2026-10-13）：消费端接线 = 泛化，**不是新建**

★**原步骤 6/7 合并**（依据 §2.1a 的实测修正：通道已存在，只是被早退挡住）。

| 落点 | 内容 |
|---|---|
| `readFileSliceUtf8Safe(filePath, s, e, tag)` | 从 `readBuiltinChapterSlice` 抽出的**真实现**（UTF-8 边界双路径 + `consumed` 语义逐字不变）；内置书函数降为**薄包装**（既有 3 套判据的形状不变） |
| `readFileRangeUtf8Safe` | 同上，整章区间版 |
| `loadUserBookToc(cachePath, bookId, expectedCount)` | 读 `.gxbook.toc` + **`validateTocShape` 纯结构校验**；缺失/损坏/不合法一律 `null` |
| `validateTocShape`（新，`chapterToc.ts`） | **不需要原文**的读侧闸门（版本/字段/区间/不重叠/order/章数/**条目 id 归属本书**）。⚠ 消费端**只能**用它：读正文校验就等于把要省的 6275ms 花回去 |
| `buildShellBookFromToc` | toc → **目录态 `Book`**（`segments: []`，其余字段全部取自 toc ⇒ 章 id 不漂 ⇒ FTS/划线/笔记锚点保持有效）|
| `buildShellBookFromCacheIfPossible` | 快路径入口：只读 `.toc` + `.meta`。⚠ `.meta` 缺失**也回退**——`fileSig`/`contentHash` 是「缓存还对得上原书」的依据，缺它就造出一条从未验证的路|
| `processOversizedBooks` | 有 toc ⇒ 走快路径；否则**原路径逐字不变**（分片读正文 + `parseTxtBookChunked`）|
| `fillBuiltinChapterNow` | 首部早退泛化为 `isUserBook` 分流；区间来源与切片函数按书籍类型分派。⚠ 内置书分支的 `loadBuiltinMeta` 逐字保留 |
| `deleteBook` | 新增 `.gxbook.toc` 清理。⚠ 漏清的后果不是占盘，而是**同名书重导入命中旧 toc ⇒ 静默错章**（`stableBookIdFromPath` 对同名文件给同一 id）|

判据 31 条 = `chapterTocConsume.test.ts`（24，闸门 + 骨架等价 + 形状）
＋ `chapterTocUserFill.test.ts`（7，**端到端行为**，自带 RNFS mock 造真实字节流）。

变异自证（5 项，一次一变量，全红）：

| 变异 | 红条数 |
|---|---|
| M1 快路径偷读正文（6275ms 白花） | **1** |
| M2 闸门放水「章数不符」检查（最危险：合法 toc 但对应另一版正文） | **1** |
| **M3 用户书又无条件早退** | **0 ⇒ 补行为判据后 4** ← 见下 |
| M4 删书漏清 `.toc` | **1** |
| M5 装配改成整读全文再切 | **1** |

⚠ **M3 首跑红 0 条**：变异保留了 `isUserBook` 与 `loadUserBookToc` 两个字面量
（只是走不到）⇒ 任何源码文本断言都测不出差别（条目 90 的又一次复现）。
⇒ 补**端到端行为判据**：mock RNFS 造真实字节流 → 注册目录态书 →
调 `fillBuiltinChapterNow(force)` → 断言正文与全量解析**逐段相等**
且只读该章字节区间。M3 随即红 4 条。
⇒ 为此暴露 `__registerOversizedFileForTests`（`oversizedBookFiles` 是模块私有，
  端到端用例无法触达分支；与 `__resetAssemblyStateForTests` 同族惯例）。

⚠ 判据自身踩坑两处（已按实测读数改）：
① `.toc` 字面量**不在** `buildShellBookFromCacheIfPossible` 函数体内（它在
  `loadUserBookToc` 里）⇒ 写死 `.toc` 查快路径体是**锚点过期假红**（条目 91⑧复现）；
② `jest.mock('react-native-fs')` 的工厂在业务 import **之前**求值，
  试图从外部（`globalThis`）传状态进去必抛「mock 未拿到状态」
  ⇒ `Tests: 0 total`＝**仪器坏了**不是判据结果；须让状态在 mock 模块内自持。

### 4.2 ★★ 步骤 7 实施记录（2026-10-13）：阻塞 B 的「6 处判据迁移」清单**本身是错的**

**结论先行**：`segments.length === 0 / > 0` 在生产代码里实测**9 处**（不是 6 处），
而**真需要迁移的是 0 处**。逐处实测判定：

| # | 位置（只引函数名） | 问的问题 | 目录态下 | 判定 |
|---|---|---|---|---|
| 1 | `StorageService.upsertFtsForChapter` | 此刻有正文可写索引吗 | 空 ⇒ 零动作 | 不改（且只被内置书 `writeFtsForChapter` 调，用户书不走） |
| 2 | `isShellComplete` ③ | 同上（+ provenance 门） | 不 complete ⇒ 正确 | 不改 |
| 3 | `fillBuiltinChapterNow` 幂等门 | 已有正文就短路吗 | 空 ⇒ 去装载 ⇒ **正确** | 不改 |
| 4 | `fillableChapters` | 内置书 FTS 计数 | 用户书不走 | 不改 |
| 5 | `builtinChapterReadiness` Empty 门 | 能否进拼接序列 | 空 ⇒ Empty | **★绝对不改**：改 `segCount` 会让空壳进拼接序列，**违反红线④** |
| 6 | `runChapterAssembleToFull`「内容存在但无游标」支 | 完整性未证时补全 | 目录态走不到 ⇒ 正确 | 不改 |
| 7 | `getChapterContentQuality` | 此刻正文完整吗 | 判 `empty` ⇒ 正确 | **★不是阻塞点：全仓无生产调用方**（仅 3 个测试文件调用） |
| 8/9 | `ReaderScreen` 两处空壳兜底 | 空壳 ⇒ 触发兜底装载 | 空 ⇒ 去装载 ⇒ **正确** | 不改 |

**★为什么不需要迁移（这才是本步的真正认知）**：这9 处问的都是
「**此刻用户看得到的正文有没有**」，答案是 `chapter.segments.length`，
而这个答案**与「正文是整读还是按需切片」无关** ⇒ 目录态下语义**逐例不变**。

⇒ **真正会因offsets 化失效的是「能不能拿到正文」＝通道可达性**，
不是一个判据的形状问题。这是原清单被误判的根因。

#### 4.2.1★ 真阻塞：两条通道（设计文档 §2.1a **漏列**）

步骤 6 泛化了 `fillBuiltinChapterNow`（**兜底**路径），但**调度器主路径**
与**邻章预热**未泛化 ⇒ 目录态用户书**首开能看、一翻页就断**：

| 通道 | 优化前 | 后果 |
|---|---|---|
| `runChapterAssembleToFull`（调度器执行器） | 首行 `getBuiltinSpec(bookId)` 对用户书恒 null ⇒ 恒早退 | 邻章永远装不上 ⇒ **只能一章一章跳，不能连续滚动** |
| `prefillBuiltinNeighbors`（邻章预热） | 同样早退 ⇒ 恒 return | 同上 |

**修法（路径泛化，内置书分支逐字保留）**：
① `BuiltinShell` 新增**可选** `readSlice`（内置书壳**不写** ⇒ 流式步走原
   `readBuiltinChapterSlice(opts.spec, …)` 分支，**内置书行为零变化**）；
② `runChapterStreamingStep` 切片读改为「壳上`readSlice` 优先，否则原路径」；
③ `runChapterAssembleToFull` 首部按书籍类型分流，区间来源二选一
   （内置书 `loadBuiltinMeta` / 用户书 `loadUserBookToc`），用户书壳挂 `readSlice`；
④ 两处章级 FTS 写入加 `!isUser` 分流（与 `fillBuiltinChapterNow` 兜底同口径：
   **用户书从不写章级 FTS** —— 超 24MB 恒超 `FTS_MAX_BOOK_CHARS`，整书索引不可达）；
⑤ `prefillBuiltinNeighbors` 早退分流＋「仅目录态用户书才提交邻章请求」
  （非超大书路径注册的用户书仍全量注册，提交纯浪费）。

#### 4.2.2 ★ FTS 整书路径：看似阻塞，**实则恒不可达**

`upsertFtsForBook` / `upsertFtsForBookChunked` / `ensureFtsIndex` 都经
`buildFtsRows`遍历 `chapter.segments` ⇒ 目录态得**0 行**；而闸门
`bookTextChars` 读 `charCount` 目录字段 ⇒ **放行**；
`upsertFtsForBook` 更会先 `DELETE FROM segments_fts WHERE book_id=?`
⇒ **清空既有索引后插 0 行**（真实危险，非假想）。

但：`.gxbook.toc` **只对 `size > OVERSIZED_RAW_BYTES`（24MB）的书生成**
⇒ 目录态书恒 > 24MB ⇒ 恒超 `FTS_MAX_BOOK_CHARS`（4M 字）
⇒ **该支不可达**。

⚠ 安全性**完全依赖两个常量的算术关系**，任一被改就静默破 ⇒ 已用判据钉死
（`chapterOffsetsReadiness.test.ts` 的 FTS 组）。

#### 4.2.3 判据（27 条）与变异

| 判据文件 | 条数 | 职责 |
|---|---|---|
| `chapterOffsetsReadiness.test.ts` | 19 | **行为组**（7）：走 `chapterAssemblyScheduler.readinessOf`（＝`builtinChapterReadiness` 同一函数）实测 Empty/Partial/Full 逐例正确；**形状组**（8）：锁「这 9 处不许换成 `segCount`」；**FTS 组**（4）：钉死两个常量的算术关系 |
| `chapterTocSchedulerPath.test.ts` | 8 | **端到端行为**：调度器主路径对目录态用户书真能装配（含只读该章字节区间、幂等、两路逐段相等） |

★**形状组只对具体改法有鉴别力**（条目 90）⇒ 必须与行为组同存。

变异自证（每次一变量，判据文件为观测面）：

| 变异 | 内容 | 红条数 |
|---|---|---|
| MUT-1 | `builtinChapterReadiness` Empty 门 → `segCount` | **3**（2 行为 + 1 形状） |
| MUT-2 | `ReaderScreen` 两处兜底 → `segCount` | 1 |
| MUT-3 | `FTS_MAX_BOOK_CHARS` 4M → 64M | 1 |
| MUT-4 | `chapterCharCount` 去掉目录字段分支 | 2 |
| MUT-A | 调度器主路径对用户书又早退 | **5** |
| MUT-B | `prefillBuiltinNeighbors` 又早退 | 1（精确命中） |
| MUT-C | 保留分流但切片器**不挂壳** | 5 |

★**仪器自证**：判据对**泛化前基线**跑 ⇒ **红 5 条**，且红的正是
「能装配/能预热/字节区间/幂等/两路一致」5 条**正例**；
3 条「返回 false 类」负例仍绿 ⇒ 符合条目 94（拒下类判据只测一个方向会恒绿）。

#### 4.2.4 本步踩的三处坑（均为判据自身，非实现）

① **判据锚点过期 3 处**（条目 91④复现）：`sliceExportFn` 未考虑
   `export async function` 形态；`fillableChapters` 所在函数实为
   `fillRemainingBuiltinChapters`（我按记忆写了旧函数名）⇒ **只引函数名不引行号**
   条目 92 当场复现；`G1` 契约断言锁死 `writeFtsForReadyChapter(spec, shell);`
   字面量 ⇒ 通道泛化后写作 `spec as BuiltinBookSpec` / `if (full && !isUser)`
   ⇒ 改为**按「写法会变」写正则**，且**强度不许降低**（正则不接受 `||`／`!full`）。
② **`prefillBuiltinNeighbors` 是 fire-and-forget**（只 `requestMany` 入队，
   执行由 `pump()` 异步驱动）⇒ 判据必须显式 `awaitReadiness` 等待；
   我先写「提交即完成」的期望，读到 0 段——那是**等待方式不对**不是实现错。
③ **`git checkout --` 对未入库新文件无效**（`chapterCatalog.ts` 未入库）
   ⇒ 还原只能用备份 + 「变异串 `grep -c` = 0」自证。

#### 4.2.5 冻结红线套核验

`chapterSilentTruncationRepair` / `chapterAssemblyRecovery` /
`UserBookService.builtinResilience` / `readerFastOpen` / `builtinSliceUtf8Boundary` /
`builtinMetaIndex` / `chapterAssemblyScheduler` / `ftsChapterIndexingContract` /
`StorageService.ftsDegrade` ＋步骤 5–7 判据 ⇒ **300 条全绿**（泛化前后同）
⇒ 内置书行为**零变化**。`tsc` rc=0、`eslint` rc=0。

`UBS` sha256：`a9f1ff2b…`（泛化前）→ `189108be…`（泛化后）。

> ⚠ **步骤 4/5 与下文 §2.1/§2.2 是本轮实测修正后的新顺序。** 原设计把「解阻塞 A/B」
> 排在第 4 位，实测发现：① 阻塞 A 的通道当前**不存在**（用户书注册即全量正文，
> 见 §2.1），提前建通道在 offsets 化前**没有消费者**；② 阻塞 B 的 6 处判据在
> offsets 化前**语义未变**，提前改只增回归面、无收益。故 A/B 后移。

### 4.1 步骤 4 实施记录（2026-10-12 已落地：`.gxbook` 落归一化文本）

**实测确认的缺陷（非推演）**：`parseBookFile` 返回的 `text` 是**未归一化**原文
（`decodeTextBytes(...).text` / `converted.text` 原样透传），而归一化只发生在
`parseTxtBook` / `parseTxtBookChunked` **函数内部** ⇒ `processOversizedBooks`
直写 `parsed.text` ⇒ **`.gxbook` 缓存里存的是 CRLF 文本**。

⇒ 若 `.gxbook.toc` 按「归一化文本的字节偏移」记账，偏移随 CRLF 数线性漂移：
10 万行 CRLF ⇒ 第 900 章偏 9 万字节 ⇒ **静默显示错章、不报错**（最坏的一类）。

**落地内容**：

| 项 | 内容 |
|---|---|
| 新建 `src/services/chapterToc.ts` | `normalizeForCache`（落盘归一化唯一口径）／`utf8ByteLength`／`lineByteRanges`／`sliceBytes`（**真字节**口径）／`verifyTocAgainstText`（toc 自洽校验）／`CHAPTER_TOC_VERSION=1` |
| `UserBookService:4537` | 落盘改写 `normalizeForCache(parsed.text)`；**不加这一步则上面整个 toc 体系的前提不成立** |

★**判据抓到一个真缺陷（不是判据自身错）**：`sliceBytes` 初版用
`normalized.slice(start, end)`（**UTF-16 下标**）冒充字节偏移 ⇒ 中文场景直接
切空。**命名与实现不符**，已改为二分定位行首 + 行内逐字符累加字节，并在
`startByte` 不在行边界时**抛错**（拒绝静默错位）。阳性对照：`t.slice(0,6) !== '中文'`。

**判据 `chapterToc.test.ts` 19 条 · 9/9 变异全红**：

| 变异 | 红条数（共 19） |
|---|---|
| M1 归一化只处理 CRLF（漏裸 CR） | 1 |
| M2 `utf8ByteLength` 用 `length`（UTF-16 冒充字节） | 2 |
| **M3 `sliceBytes` 退回 `slice`** | **3** |
| M4 取消「非行边界抛错」守卫 | 1 |
| M5 `verifyToc` 去掉行边界检查（CRLF 漂移不报） | 1 |
| M6 `verifyToc` 去掉连续性检查 | 1 |
| M7 `verifyToc` 忽略版本号 | 1 |
| **M8 落盘退回写未归一化 `parsed.text`** | **1** |
| M9 去掉 `normalizeForCache` import | 1 |

**判据自身被修正四处（均按实测读数改，未迁就实现）**：
① 归一化处数原写 `3`，**实测 4**（漏了第四处）⇒ 按读数改；
② 「区间不连续」构造错误两次——先是把 `end` 减 1（被「不在行边界」先命中），
   再是把后续条目整体前移（**仍首尾相接＝根本没造出缝**），第三次改为
   「第 i 条 end 与第 i+1 条 start 不相等且都在行边界上」才测到目标条件；
③ `starts.length` 原断言 `== split('\n').length - 1`，**实测两者相等**
   （`starts` 含每个 `\n` 之后的位置，末尾空串项也算一行）⇒ 按读数改；
④ 一条断言跨 `describe` 引用了别的作用域里的 `text` ⇒ `ReferenceError` ⇒ 移回纯函数组。

★**另一条纪律**：本轮注释里写的 `parseTxtBook:4096` / `parseTxtBookChunked:4141`
在改动后**已位移**（真实值 `3328` / `3365`）⇒ 已改为**只引函数名不引行号**。
归一化四处的真实行号：`1878 / 3079 / 3334 / 3371`。

**读数**：新判据 19 全绿；**全量 107 套 / 1412 条全绿**；`tsc` rc=0；`eslint` rc=0。

### 4.1 步骤 1–3 实施记录（2026-10-12 已落地）

| 步 | 落地内容 | 判据 | 全量 |
|---|---|---|---|
| 1 | `Chapter` 加 `segCount?` / `charCount?`（**可选**：20+ 构造点不必同步改）；`createChapterBuilder` 构造即写入 | `chapterCatalogFields.test.ts` 10 条 | — |
| 1' | 新建 `chapterCatalog.ts` 作目录字段**唯一读侧真值**（`usable()` 门槛挡 `-1` 哨兵与非有限值） | 同上 | — |
| 2 | `StorageService.bookTextChars` 内联实现迁出 → 改读 `charCount`（3 个调用点不变：`ensureFtsIndex` / `upsertFtsForBook` / `upsertFtsForBookChunked`） | 同上（含 legacy oracle 逐书等价） | — |
| 3 | 删 `TextLibraryService.allSegments`（全量段聚合器）；`buildIndexes` 降为**章级**（删 `Map<segmentId,TextSegment>`）；`getSegment` 改「`chapterIdOfSegment` 反解章 id → 章内线性查找」；`StorageService` 的**丢弃调用**改用 `getBooks()` | `chapterIndex.test.ts` 12 条 | **106 套 / 1393 全绿** |

★**步骤 3 勘察发现（比设计预期更严重）**：`StorageService:617` 原有一次
`TextLibraryService.allSegments()` 调用，其返回的 `data` **从未被读取**
（全函数内 `segRes` 仅出现 3 次：赋值 + 判 `success` 两处）⇒ **纯丢弃调用**，
而它的副作用是**把全书 `segments` 物化并拼成一个巨型数组**（161MB / 980 章
即数万段对象），且发生在冷启路径上。已删除。

★**判据设计上的一个教训（复用必读）**：步骤 3 起初只用「源码文本计数」锁形状，
变异自证时 **M4（`buildIndexes` 里重新物化段）红 0 条**——因为该变异只加了个
空 `Map`，而文本断言只能锁**字面量**。随后补了一条**运行时判据**：给
`chapter.segments` 装 `Object.defineProperty` getter 计数，断言
`registerUserBooks` 全程读取次数 **= 0**、`getSegment` 读取次数 **> 0**（阳性对照）。
重做忠实变异后：

| 变异 | 红条数 |
|---|---|
| M1 反解改非贪婪（剥错层） | **2** |
| M2 反解去掉 `$` 锚定 | **1** |
| M3 章内查找恒 miss | **2** |
| M4' `buildIndexes` 真遍历 `segments` | **2** |
| **M4'' 换写法物化（`Object.values(chapter)`，文本零关键词）** | **1** ← 只有运行时判据能抓 |
| M5 `allSegments` 回潮 | **1** |
| M6 `StorageService` 丢弃调用回潮 | **2** |

⇒ **纯文本断言对「换写法的等价实现」无鉴别力**；凡目标形状是「不读某字段」，
必须配 getter 计数这类运行时判据。

⚠ 步骤 1/2 的判据有一处**已知无保护**：`chapterSegCount` 等回落分支在
「所有字段都缺失」时与旧实现同结果 ⇒ 若某调用点单独依赖回落路径，**没有测试会红**。


## 5. 正确性守卫（★自建，无现成 oracle）

⚠ **agent 勘察报告引用的 `builtinMetaIndex.test.ts` **确实存在**
（在 `src/services/__tests__/`，不在 `src/__tests__/`）——本文早前版本写的
「经核实不存在」**是错的**（当时只查了 `src/__tests__/`）。
它锁的正是「切片独立解析 == 全本解析对应章」的对拍，且资产是**真内置书**
（`android/.../assets/books/*.meta.json`）⇒ 比自建样本更硬。
⚠ 但它**不能直接当用户书 toc 的 oracle**：资产/生成器不同（`deriveTocWithRanges`
vs 本仓 `buildTocFromBook`）、文件格式不同（`meta.json` vs `.gxbook.toc`）、
且它跑 `test.each(BUILTIN_CATALOG)` 依赖真实资产目录。⇒ 自建的仍然必要（覆盖
用户书特有的无标记/CRLF/空行章/超长段等样本），**两者并存**。

自建守卫（借内置书的思路）：用真实资产做「**切片独立解析 == 全本解析对应章**」的逐段对拍，
章样本覆盖：无标题/多段标题/超长段（>2500 强制切分）/段内单换行/CRLF/空行章/首章前言。

### 5.1 ★对拍 oracle 的判据形状（步骤 5 实施记录，2026-10-13）

**刻意不采用**「重新解析一遍再比」—— 那样两边共用同一个实现，比的是**自己等于自己**。
采用的形状：**按 toc 偏移从文本切出的片段** ⟷ **原 `Book` 里该章 `segments` 逐段文本**。
前者走字节路径（新代码），后者走解析路径（旧代码），两条**互不共用**。

⚠ **中途修正过一次「什么算等价」**（判据自身设计错，按实测读数改，未迁就实现）：
初版比的是「拼回字符串相等」，报的是 `charCount` 差 1。查因发现
**原文本段间可以是单换行，而 `segments` 统一以 `\n\n` 拼** ⇒ 「拼回字符串相等」
根本不可满足。真正的不变量是设计文档 §3 那条：**切片经 `toParagraphs` 重切段
⇒ 段数与逐段文本与原 `Book` 一致**。这同时是消费端唯一依赖的性质。

⇒ 为此把 `toParagraphs` 从模块私有**改为导出**：消费端重切段本来就需要它，
且私有函数在 jest 里无法被执行（判据会退化成自己等于自己）。

变异自证（6 项，一次一变量，全红）：

| 变异 | 红条数 |
|---|---|
| M1 `verifyTocAgainstText` 去掉「不重叠」检查 | **1** |
| M2 `buildTocFromBook` 部分可用（跳过缺范围章而非整体放弃） | **1** |
| M3 字节范围写成行号（口径错 ⇒ 偏移全漂） | **8** |
| M4 `normalizeForCache` 不归一化（CRLF 原样落盘） | **3** |
| M5 `sliceBytes` 退回 `String.slice`（UTF-16 下标冒充字节） | **12** |
| M6 `buildTocFromBook` 去掉生成后自检 | **0 ⇒ 补判据后 3** |

⚠ **M6 首跑红 0 条**：正常样本生成本来就自洽，删掉自检看不出差别 ⇒
判据只覆盖了「不变式成立」的方向。补三条**负例**（范围越界 / 切点不在行边界 /
相邻区间重叠）后 M6 红 3。⇒ **凡目标是「破坏时必须拒绝」，必须显式构造破坏样本。**

⚠ **本轮判据自身错误五处**（全部按实测读数改，未迁就实现）：
①`goodToc` 用 `starts[starts.length]` 取 `end` ⇒ 越界读出 `undefined`，被
「区间非法」前置命中 ⇒ 掩盖了后面真正要测的成因；
②判据把「末条 `end < byteLen`」当不变量，而末章正文延伸到文本末尾时
`end === byteLen` **合法**（`verify` 对此显式跳过行边界检查）；
③行区间 `[starts[i], starts[i+1])` **含该行 `\n`**（`starts` 记的是每个 `\n`
**之后**的位置），而 `split('\n')` 已吃掉分隔符 ⇒ 初版直接比 `split('\n')[i]`
恒多一个 `\n`；
④`.gxbook.toc` 字面量锚点：代码用模板串 `${t.cachePath}.toc`，`cachePath`
变量名里没有 `.gxbook` ⇒ 写死字面量是**锚点过期假红**（同 `normalizeForCache`
单符号 import 锚点，已改为正则匹配多符号 import）；
⑤`starts.length === split('\n').length` 口径正确（末尾空串项也算一行），
但据此写出的逐行反查仍需按 ③ 补回 `\n`。
⇒ 补一条**更强**的表述替代逐行比：「按 `starts` 逐段切片再拼起来 == 原文」
（切章不丢字、不重字），4 个文本样本全绿。

## 6. 诚实边界

- offsets 化**只对已生成 `.gxbook` 的书成立**。epub 要生成 `.gxbook` 仍须先跑完
  `epubExtractText` 全量解压＋HTML 转换 ⇒ **结构化格式的首轮成本降不下来**。
- 收益体现在**每次冷启**（不再整本读），而非首次导入。
- `MAX_CACHE_JSON_CHARS` 这道闸门（`UserBookService:146-151`，161MB epub 曾诱发 db 损坏）
  在 offsets 化后**可以退休**（估算《资治通鉴》9.47MB 的 Book JSON 4.70MB → 34.6KB，收缩 139×）
  ⇒ 161MB epub 的 db 损坏根因被移除。但**前提是该书有 `.gxbook`**，见上一条。

## 7. 红线基线（改形状前已冻结）

`npx jest` 选定 7 套 ⇒ **97 条全绿**：
`readerGestureContract` / `bookMetadataWiring` / `ftsBookChunkYield` /
`oversizedShelfNotification` / `importShelfRegistrationGuard` / `scrollAnchor` / `scrollEventNullSafety`

★`MVCP`（`maintainVisibleContentPosition`）已被 **INV-G4** 判禁（`ReaderScreen.tsx:9`），本方案不触碰。
每步改动后必须复跑这 7 套 + 全量，并做真机 A/B（单变量、两侧 md5 核对）。
## 8. ★★ 步骤 8：修「存量已导入的大书永远拿不到 `.toc`」（真机挖出的真缺陷，已修＋真机判决）

### 8.1 缺陷本体（真机读数，非推演）

步骤 5 只在「缓存**不存在**→ 完整解析」路径写 `.toc`。而**存量**已导入的大书
`.gxbook` 早已存在 ⇒ 走「读缓存 + `parseTxtBookChunked` 重建」分支
⇒ **`.toc` 永远不会被生成** ⇒ §4 的收益（8072ms → 202ms）对真实用户**等于零**。

真机证据链（修复前 B臂包）：装机后首启 Δ=**9247ms**（比 A 臂老路 8072ms 还慢，
因为多付了一次「`buildShellBookFromCacheIfPossible` 探测」）＋ `ls` 确认无 `.toc`。
必须手动 `rm .gxbook` 逼一次完整解析，`.toc` 才会出现。

### 8.2 修法（用户拍板方案 1：缓存命中分支也落 toc）

抽出共用小函数 `writeTocIfPossible(book, cacheText, cachePath)`，两条落盘路径共用
（全有或全无语义**只允许一处实现**）；回退重建成功后调一次。代价：首次仍付一次
重建成本，**之后每次冷启走快路径**。

★额外加了**显式 CR 口径守卫** `tocOffsetBaseMatchesCache(cacheText)`
（＝`normalizeForCache(cacheText) === cacheText`）。它不是保险起见，是**必需的**——
见 8.4 的实测反例。

### 8.3 真机判决（设备 22N0224511002219 / ALT-AL10 / Android 12）

样本：`dafeng.epub` 161,589,256 B；`.gxbook` 12,781,299 B；`.meta` 143 B。

| 步骤 | 场景 | `.toc` |Δ（library-sync done → 超大书装载完成）|
|---|---|---|---|
| 装机后首启 | `.gxbook` 有、`.toc` 无（**存量场景**，`rm .toc` 制造） | **自动生成 119,724 B** | 11,455 ms（付一次重建） |
| 冷启 ×3 | `.toc` 已存在（**快路径**） | mtime 不变（未重写，幂等） | **269 / 249 / 313 ms，均值 277** |

★**最强的一条读数**：重建分支产出的 `.toc` 与当初完整解析路径产出的 `.toc`
**md5 完全相同**（`ae9b25d0522113cfee319506a9bf3b2c`，119,724 B）⇒ 两条落盘路径
产出等价、偏移无漂移。这比「结构合法」强得多：它直接对比了正确性基准。

对照A 臂（无 toc，走老路）8072ms ⇒ **修复后存量书从8 秒档降到 0.28 秒档**。

### 8.4 ★★ 判据与「为什么显式守卫不可省」

判据 `src/__tests__/tocBackfillOnCacheHit.test.ts` **10 条**（7 行为 + 3 形状）。

**MUT-BASE**（回退分支不落 toc，模拟修复前）⇒ 红 **3** 条：
`A1 正例`、`A2 幂等`、`B3 守卫接线`。
⚠ `A3/A4/A6` 三条拒下类**对基线也绿**（第 4 次印证「拒下类只测一个方向会恒绿」）。

**MUT-CR**（守卫恒真）⇒ 红 **2** 条：`A5 纯函数`、`A7 守卫鉴别力`。

★**A7 的来历（本次最关键的一条认知）**：
最初以为「`buildTocFromBook` 内部的 `verifyTocAgainstText` 自检会兜住 CR 不一致」
—— 变异 MUT-CR 时**A4 行为组没红**，说明兜住了。**但那是样本选得不好**。
改用「**只把末尾 k个 `\n` 换成 `\r\n`**」的危险样本后实测：

| k（末尾 CR 个数） | 1 | 2 | 3 | 10 | 41 | 82 | 123 |
|---|---|---|---|---|---|---|---|
| 生成端自检 | 通过 | 通过 | 通过 | 通过 | 通过 | 拒 | 拒 |
| 实测切错章数 | 0/6 | **1/6** | 1/6 | **1/6** | 1/6 | — | — |

⇒ **自检在 k≤41 时全部放行，但正文已经切错 1/6 章**。原因：前面各章的偏移在
CRLF 文本里**恰好仍落在行边界上**（CR 只影响 CR 之后的字节），而末章 `end`
被顶偏。自检只查「偏移在行边界 / 不重叠 / 有序」，**查不出「切出来的正文对不对」**
⇒ 「靠生成端自检兜住」是**错的**。显式守卫是唯一可靠防线。

A7 因此同时钉住两件事：①自检会误判通过（前置探针，用真 `parseTxtBook` 造Book），
②被测链路必须不落 toc。

### 8.5 本步的三处判据构造错误（全部按实测改，未迁就实现）

①`toParagraphs` 收**字符串**不是数组（我按数组写）；
②前置探针误传 `markers: true`，而真链路 `processOversizedBooks` 传的是
`markers: isStructuredFormat(ext)`，`.txt` ⇒ **false** ⇒ 结构不同、偏移分布不同；
③引入 A7 时残留旧变量名 `fsState`（早前已改名 `mockFs`）。

★另**判据锚点第 5 次过期**：`chapterTocParity` 的「已接线到落盘」原锁
`${t.cachePath}.toc`，落盘抽成共用函数后接收变量变成 `cachePath` ⇒ 假红。
改为「按写法会变」的正则 `/\$\{[A-Za-z_][A-Za-z0-9_]*\}\.toc/` **且强度不许降低**
（并加反向对照：模板串恰 2 处 = 读侧 + 落盘，防有人另起一份实现）。
★`.meta` 的真实写法是硬编码后缀 `'`${t.cachePath}.meta`'`，我一度把它也写成
模板串正则 ⇒ 又一次「按想象写判据」，已按真实写法分别锁定。
