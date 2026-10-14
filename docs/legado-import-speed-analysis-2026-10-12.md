# legado 导入外部书籍为何快：源码级归因与对本仓的参考价值

- 日期：2026-10-12
- 源码来源：gitee `OrganizationStudy/legado`（master 分支）镜像，逐文件拉取后归档于 `deliverables/legado-import-speed-analysis-2026-10-12/legado-src/`
- 结论：**快的原因不是「读得快」，而是「导入时几乎不读正文」。** 该机制有极高参考价值，但**不能整体照搬**——它与本仓「按需装载 + 全内存章节模型」的架构前提相冲突。可移植的是**分块流式扫描 + 偏移量目录**，且必须限定在 TXT 路径。

---

## 一、legado 实际做了什么（源码级）

### 1.1 导入入口只做元数据，不解析正文

`LocalBook.kt:44` `importFile(uri: Uri)`：
- `content://` URI → `DocumentFile.readBytes()` **全量拷进 `cacheFolder/bookTxt/`**（`LocalBook.kt:47-63`）⇒ **legado 对 `content://` 也拷**，不靠软链接
- `file://` 路径 → `path = uri.path!!`，**零拷贝，只记路径**
- 随后仅做文件名正则拆书名/作者（`70-108`），`if (book.isEpub()) EpubFile.upBookInfo(book)` 只读 OPF 元数据（`123`），最后 `appDb.bookDao.insert(book)`（`124`）
- **没有任何「切章」「抽正文」调用**

⇒ **导入一个 500 MB EPUB 的耗时 ≈ 拷 500 MB（content 情形）或 ≈ 0（file 情形）**，与「书有多少章、多少字」完全无关。这是最主要的答案。

### 1.2 TXT 扫描：分块 + 只产出偏移量

`AnalyzeTxtFile.kt`：
- `analyze()` 开 `RandomAccessFile(bookFile, "r")`（`36`）——**随机访问，不是全量读**
- 缓冲区 `BUFFER_SIZE = 512 * 1024`（`247`）＝ **512 KB 块**
- 编码探测**只读前 2000 字节**：`EncodingDetect.kt:70-81` `getFileBytes` 中 `ByteArray(2000)`
- 目录规则探测**只读前 128 KB**：`AnalyzeTxtFile.kt:227` `ByteArray(BUFFER_SIZE / 4)`，且只用于「挑一条正则」（`224-240` `getTocRule`）
- 主循环 `while (bookStream.read(buffer))`（`67`）逐块扫，只产出 `BookChapter(start, end)` **字节偏移量**（`105/111/122/134/141`）
- 兜底虚拟分章 `MAX_LENGTH_WITH_NO_CHAPTER = 10 * 1024`（`250`）＝ 无章节标题时按 10 KB 切
- 每 15 块手动 `System.gc()`（`201-204`）
- 产物只有 `ArrayList<BookChapter>`——**零正文、零 HTML 转换、零分词**

### 1.3 正文按需取

`AnalyzeTxtFile.kt:252` `getContent(book, chapter)`：
```
seek(chapter.start); read(ByteArray(end - start)); String(..., charset)
```
**每次只读一章的字节区间。** 章节正文从不集中存在内存或 db 里。

### 1.4 EPUB：交给 epublib 懒加载

`EpubFile.kt:109` `readEpub()`：
```
EpubReader().readEpubLazy(ZipFile(file), "utf-8")
```
- `readEpubLazy`（`EpubFile.kt:109`）⇒ **只读 ZIP 中央目录**，不解压正文
- 目录 `getChapterList()`（`197`）遍历 `tableOfContents.allUniqueResources`（`199`），每项存 `url = resource.href`（**资源名，不是正文**）
- 正文 `getChildChapter()`（`123`）在**阅读时**才 `it.resources.getByHref(href).data`（`125`） ⇒ 单次只解压一章
- `eFile` 是 `companion object` 里的**单例缓存**（`28`），按 `bookUrl` 切换 ⇒ 同一本书不重复解包

### 1.5 副产品：legado 也不删用户原文件（默认）

`LocalBook.kt:128` `deleteBook(book, deleteOriginal: Boolean)`：只有 `deleteOriginal=true` 时才 `DocumentFile.delete()` / `deleteFile(book.bookUrl)`（`142-149`）——**即删用户 Download 里的原件**；删的是自己的 `bookTxt/` 副本。

---

## 二、速度归因（按贡献排序）

| # | 机制 | 源码位置 | 对「导入耗时」的影响 |
|---|---|---|---|
| 1 | **导入时不解正文**，只记路径 + 元数据 | `LocalBook.kt:44-126` | ★★★★★ 主因：耗时与书的大小/章数解耦 |
| 2 | **目录 = 字节偏移量**，非正文 | `AnalyzeTxtFile.kt:105-141` | ★★★★★ 不产生正文存储成本 |
| 3 | 512 KB 分块读 + 每 15 块 GC | `AnalyzeTxtFile.kt:56/67/201` | ★★★ 控制内存峰值 |
| 4 | 编码探测只读 2000 B | `EncodingDetect.kt:72` | ★★★ 与文件大小无关 |
| 5 | 目录规则探测只读 128 KB | `AnalyzeTxtFile.kt:227` | ★★ |
| 6 | 正文按章 `seek`+`read` | `AnalyzeTxtFile.kt:252-259` | 阅读期成本，不是导入期 |
| 7 | EPUB 懒加载 + 单例缓存 | `EpubFile.kt:28/109` | ★★★ EPUB 只解一次中央目录 |
| 8 | 导入在原生线程（非 JS） | `AnalyzeTxtFile` 是 Kotlin，无 JS 桥 | ★★★ 不与 UI 竞争，但**会与 UI 抢 CPU**（legado 靠后台线程化缓解） |

---

## 三、本仓现状对照（为什么我们慢）

| 环节 | 本仓实现 | 位置 | 代价 |
|---|---|---|---|
| 读入 | `readFileBytes()` 分块读**整个文件**到 `Uint8Array` | `UserBookService.ts:3623-3663` | 全量字节常驻内存 |
| 编码判定 | `decodeTextBytes(bytes)` —— **必须拿到全部字节**才能判（`isStrictUtf8(bytes)` 全量校验） | `textEncoding.ts:156-186` | 无法「先读 2 KB 判编码，再流式扫」 |
| EPUB | 自研 `epubExtractText()` 遍历 spine，**逐文档 `htmlToText` 并拼接成一整段文本** | `bookFormat.ts:140` | 全量解压 + 全量 HTML 转换 + 全量字符串拼接 |
| 切章 | 章节切分器把整本标记文本切成 `Chapter.segments[]`（**每段都是实体对象**） | `types/index.ts:32-42` | 正文实体化，内存与时间都 O(全书) |
| 让出 | `EPUB_YIELD_EVERY = 100` 每 100 文档 `await` 一次 | `bookFormat.ts:138` | 只是缓解 JS 独占，**总工作量没减少** |
| 大书兜底 | >24 MB 走 `.gxbook` 纯文本缓存 + 后台队列 | `UserBookService.ts:157/4773` | 已承认此路径必然慢 |

**根因一句话**：本仓的解析器接口是「字节 → 完整 `Book`（含全文章节实体）」，所以**必须**先把整个文件读进来；而 legado 的接口是「文件 → 偏移量目录」，正文是**阅读时才取的函数**。

---

## 四、参考价值评估

### 4.1 值得移植（高价值、低风险）

| 项 | 价值 | 移植代价 | 风险 |
|---|---|---|---|
| **① 编码探测只读头部 2 KB**（`EncodingDetect.kt:70-81`） | 把「读全文件才能判编码」解耦 ⇒ 可先读 2 KB 判编码，再决定后续流式策略 | 中：需重构 `decodeTextBytes` 为「探测」与「解码」两段 | 低（只改判定时机，不改判定结果） |
| **② 目录规则探测只读前 128 KB** | 目录识别不必扫全文件 | 低 | 低 |
| **③ 512 KB 分块 + 每 N 块主动让出** | 与现有 `EPUB_YIELD_EVERY` 同思路，但**分块粒度从「文档」改为「字节」，粒度更细 ⇒ JS 独占窗口更短** | 低 | 低 |

### 4.2 需改造后移植（高价值、高风险）

| 项 | 价值 | 阻塞 |
|---|---|---|
| **④ 章节 = 偏移量，正文按需** | 根治大书导入慢 | ★与本仓架构冲突：本仓 `Chapter.segments` 是**实体数组**，注音/划线/笔记/FTS 全部直接吃 `segments`。改偏移量意味着 `segments` 变成「按需生成」⇒ 触及 `ensureBookLoaded`/`chapterWindow`/FTS/标注全链路。这是**改形状**，不是局部优化 |

### 4.3 不该学

| 项 | 原因 |
|---|---|
| legado 的「导入不校验」 | 它导入时不解析，所以可能导入一堆坏书（用户点开才报错）。本仓导入即上架即索引，需保证 `unparsedFiles` 诊断与「保留既有注册」的语义（`UserBookService.ts:4800-4850`）——**不能为了快而牺牲可诊断性** |
| `System.gc()` 每 15 块 | 手动 GC 是应急手段；本仓应靠分块自然回收，靠 yield 让出事件循环（Hermes 单线程下 `setImmediate` 已退化，`InteractionManager` 已移除，见 MEMORY 75） |
| epublib `readEpubLazy` | legado 用 Kotlin + epublib 做；本仓是 RN/JS，若要等价须自研**原生** ZIP 懒加载模块（工程量大，见 `docs/import-softlink-feasibility-2026-10-12.md` B 档） |
| 内容 `content://` 全量拷贝（`LocalBook.kt:54`） | 这正是我们上一轮论证中 legado 也没解决的问题；**legado 并非零拷贝**，不要把它当软链接方案的证据 |

---

## 五、行动建议（分档）

### A 档（建议做，收益明确、风险低）
1. `decodeTextBytes` 拆成 `detectCharset(head2K)` + `decodeBody(bytes, charset)`；**探测阶段只喂前 8 KB**。
2. 目录识别（`parseBookFile` 的 markers 扫描）改「先读 128 KB 试判，不命中再全量」。
3. 分块粒度由「每 N 个文档」改为「每 M 字节」（如 512 KB）⇒ JS 独占窗口从「单个大文档」缩短到「单块」。

预期：超大书导入的**首屏可交互时间**明显下降；但**总 CPU 工作量不变**。

### B 档（需拍板，属改形状）
把 `Chapter` 从「持有 segments 实体」改为「持有 `(sourcePath, byteStart, byteEnd)` + 惰性解码」。
- 收益：导入耗时与书的大小基本解耦，追平 legado。
- 代价：`segments` 的所有消费方（拼音装配、划线、笔记、FTS、跳章）都要改成惰性；需重做真机 A/B 验收（现有 5 套冻结红线套多数锁的是「内容一次性物化」的行为）。
- 风险：**高**。且与上一轮论证的 B 档（SAF 零拷贝）耦合——两者应合并设计，否则要做两次大改。

### 不建议
只做「把 `copyTo` 改 `moveFile`」（上一轮 A 档）就宣称导入快 —— 那一档优化的是**拷贝**，不是**解析**，对大书耗时无帮助。

---

## 六、归档

| 文件 | sha256 |
|---|---|
| `legado-src/AnalyzeTxtFile.kt` | `e102f434528a51955573676628629db08675f6b92266715fa6414b4b1638d79b` |
| `legado-src/EpubFile.kt` | `f73d9fee9dd6dc9306426d577ea6b33c0d0655c8e85ae8d26da682e5238e6a34` |
| `legado-src/LocalBook.kt` | `0b1b57171c88a7a82a2cb11b51add6aa90cc2cc2d88bc80b6353c6e88a726d3d` |
| `legado-src/BookHelp.kt` | `1fca47d4237a6837dac0732ea6f2a92740ba4739249778b598dfaf11d1139934` |
| `legado-src/EncodingDetect.kt` | `fa960d621a59dd71a31489369f92bcb7bc53afea9e9025bbae6c2068768eecfd` |

拉取来源：`https://gitee.com/OrganizationStudy/legado/raw/master/app/src/main/java/io/legado/app/…`（GitHub `raw.githubusercontent.com` 对该镜像返回 404，GitHub 上亦有上游 `gedoor/legado`）。