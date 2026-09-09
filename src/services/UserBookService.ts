/**
 * 用户书籍服务（UserBookService）
 * 书籍文件夹统一管理链路（2026-09 书籍文件夹化）：
 *   所有书籍资源统一落在 <外部应用目录>/guoxue-books/（Android 为
 *   Android/data/<pkg>/files/guoxue-books，用户可经 USB / 文件管理器直接
 *   放入书籍文件，无需存储权限）；内置书在其下 builtin/ 独立子目录
 *   （首启自 bundle 物化为 .txt 资源副本，阅读正源仍是 bundle JSON）。
 *   - 文件夹自动识别：启动/刷新扫描顶层支持格式的文件 → 解析上架书架；
 *     文件被用户移走/删除 → 自动下架并级联清理；
 *   - 稳定 ID：按文件名哈希（stableBookIdFromPath），文件内容更新重解析
 *     后 ID 不变，用户数据（背诵/收藏/笔记）不脱挂；
 *   - 解析缓存：file_sig（mtime:size）未变的文件直接复用 db 内解析结果；
 *   - 大小不限：分块读取无上限（解析为全量同步，超大文件首启会稍久）；
 *   - 内置书可删：删除 = 删文件 + builtin_hidden 抑制记录（不复活），
 *     「恢复内置书籍」清空抑制并补写文件。
 * 历史遗留：文件夹化前经选择器导入的书（db 行无 source_path）保持应用内
 * 管理不动（仍可经 App 删除），扫描不触碰，避免误判文件缺失误删。
 * 与字典域隔离：独立 db 文件 user_books.db，严禁触碰 user_dict.db；
 * guoxue.db 仅经 StorageService 公共 API 写入 segments_fts 搜索索引行。
 */
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import { InteractionManager } from 'react-native';
import { open } from 'react-native-quick-sqlite';
import type { Book, ServiceResult } from '@/types';
import { getBuiltinSpec, BUILTIN_CATALOG, type BuiltinBookSpec } from '@/data/builtinCatalog';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { useRecitationStore } from '@/store/useRecitationStore';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useReaderStore } from '@/store/useReaderStore';
import { isLocalPath, toLocalPath } from '@/utils/localPath';
import { decodeTextBytes } from '@/utils/textEncoding';
import { decodeUtf8 } from '@/utils/utf8';
import {
  CHAPTER_MARKER,
  SUPPORTED_BOOK_EXTENSIONS,
  convertBookBytes,
  isStructuredFormat,
} from '@/utils/bookFormat';

// 兼容既有导入路径（tests 等处从本模块 import decodeUtf8）
export { decodeUtf8 };

/** 用户书籍 db 文件名（quick-sqlite location 子目录内） */
const USER_BOOKS_DB = 'user_books.db';
/** quick-sqlite location 子目录（与字典库同级，互不干扰） */
const DB_LOCATION = 'dictionaries';

/** 书籍根文件夹名（位于外部应用目录/文档目录下，用户可直接放入书籍文件） */
const BOOKS_DIR_NAME = 'guoxue-books';
/** 内置书资源子目录名（根文件夹内的独立文件夹，App 托管） */
const BUILTIN_DIR_NAME = 'builtin';

/** 内置书 FTS 后台索引队列运行中标记（防并发装载重复排队） */
let builtinFtsQueueRunning = false;
/**
 * FTS 队列「用户优先」门闩：在此之前的时间戳内队列不得开始解析新书。
 * 用户点卡片触发 ensureBookLoaded 水合时置位（+30s，每次水合刷新），
 * 解析完成后再续 10s 缓冲——用户水合后大概率继续翻页/点击，队列必须
 * 彻底让路。队列只在书间检查点检查该标志（正在解析的一本书由分片
 * 解析按章让出，tap 可在章间插队，无需中断整本）。
 */
let ftsQueuePausedUntil = 0;
/** 水合期间门闩时长：覆盖一次大书解析 + 后续连续操作窗口 */
const FTS_PAUSE_ON_HYDRATE_MS = 30_000;
/** 水合完成后追加缓冲：避免队列在用户连续操作间隙立刻抢跑 */
const FTS_PAUSE_AFTER_HYDRATE_MS = 10_000;
/** 门闩轮询间隔：暂停期间每 250ms 查一次是否解禁 */
const FTS_PAUSE_POLL_MS = 250;
/**
 * 队列书间让出下限（ms）。旧值 16ms 让出形同虚设——连续书解析之间
 * JS 几乎不间断占用，tap 排队可达秒级。改为 200ms 与
 * InteractionManager.runAfterInteractions 竞速：至少间隔 200ms，
 * 且等当前交互/动画收尾。测试可注入短间隔（见 __setFtsQueueYieldForTests）。
 */
let ftsQueueYieldMs = 200;
/** FTS 队列自动排队开关（测试环境关闭，避免挂起定时器拖慢/悬住 jest 进程） */
let builtinFtsAutoSchedule = true;
/** 内置书元数据是否已注册（每进程一次；目录/抑制变化由 setSuppressedBuiltins 增量生效） */
let builtinMetaRegistered = false;
/** 水合去重：bookId → 进行中的水合 Promise（并发进入同一本书只解析一次） */
const ensureInFlight = new Map<string, Promise<ServiceResult<Book>>>();

/** 支持的扩展名（选择器过滤用，见 bookFormat.SUPPORTED_BOOK_EXTENSIONS） */
const BOOK_EXTENSIONS: readonly string[] = SUPPORTED_BOOK_EXTENSIONS;
/** 单次 read 上限（RNFS.read 建议值 4MB） */
const READ_CHUNK_LIMIT = 4 * 1024 * 1024;
/** 段落最大码点数（超长段落切分，避免单段数千字影响渲染/划线索引） */
const MAX_SEGMENT_CHARS = 2500;
/** 无章节标记时，每章段落上限（超出则按此切「部分」） */
const SEGMENTS_PER_PART = 60;
/** 章节数上限（防畸形文件撑爆 db） */
const MAX_CHAPTERS = 5000;
/**
 * db 解析缓存单行 JSON 上限。超大书（如数百 MB epub）的解析结果不进 db：
 * 真机已踩坑——161MB epub 的解析 JSON 整块写入单行，诱发 db 损坏
 * （disk I/O error）且 SELECT 全量装载时内存爆炸。超限书籍每轮启动
 * 重新解析（正源仍是书籍文件夹文件，功能不受影响，仅启动稍慢）。
 */
const MAX_CACHE_JSON_CHARS = 32 * 1024 * 1024;
/**
 * 超大文件阈值：超过此原始大小的书籍文件不阻塞启动装载。
 * 真机教训：161MB epub 每次启动全量重解析（db 缓存超上限不落库），
 * JS 线程被占用 40s+（重度 GC），打开其他书籍全部假死。
 */
const OVERSIZED_RAW_BYTES = 24 * 1024 * 1024;
/** 超大书解析结果磁盘缓存后缀（与源文件同目录；删除书时一并清理） */
const OVERSIZED_CACHE_SUFFIX = '.gxcache';
/** 超大书后台队列运行中标记（防并发装载重复排队解析同一批文件） */
let oversizedQueueRunning = false;
/** 超大书 id → 源文件/缓存文件位置（超大书不落 db，删除时按此清理文件） */
const oversizedBookFiles = new Map<string, { path: string; cachePath: string }>();

/** 单个超大书后台装载任务 */
interface OversizedTask {
  path: string;
  name: string;
  sig: string;
  cachePath: string;
}

type DB = ReturnType<typeof open>;

/** 已打开连接（惰性单例） */
let db: DB | null = null;

/** 本会话是否已尝试过删库重建（防循环重建） */
let dbRepairAttempted = false;

/** 建表 + 增量迁移（新建/重建后都会走） */
function createUserBooksSchema(instance: DB): void {
  instance.execute(
    `CREATE TABLE IF NOT EXISTS user_books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  // 文件夹化增列（旧库原地演进；已存在时 ALTER 报错吞掉即可）：
  //   source_path —— 书籍源文件在书籍文件夹内的绝对路径；NULL = 文件夹化
  //                  之前的遗留书（应用内管理，扫描不触碰）；
  //   file_sig    —— 源文件指纹「mtimeMs:size」，未变则复用解析结果。
  for (const ddl of [
    'ALTER TABLE user_books ADD COLUMN source_path TEXT',
    'ALTER TABLE user_books ADD COLUMN file_sig TEXT',
    'ALTER TABLE user_books ADD COLUMN content_hash TEXT',
  ]) {
    try {
      instance.execute(ddl);
    } catch {
      // 列已存在
    }
  }
  // 被用户删除的内置书抑制表（内置书正源在 assets，删除靠抑制记录防复活）
  instance.execute(
    'CREATE TABLE IF NOT EXISTS builtin_hidden (id TEXT PRIMARY KEY)',
  );
}

/**
 * 探针：验证连接真实可用。损坏的 db（disk I/O error）建表语句可能
 * 假成功（CREATE TABLE IF NOT EXISTS 不触数据页），必须实际读一次。
 */
function probeUserBooksDb(instance: DB): boolean {
  try {
    instance.execute('SELECT id FROM user_books LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * 删库重建。user_books.db 为纯解析缓存：书籍正源在书籍文件夹/assets，
 * 学习数据（背诵/笔记/收藏）在主库与 MMKV，删除重建不丢任何用户资产。
 * 唯一代价：被删除过的内置书（抑制记录）会复活、created_at 归零。
 */
function repairUserBooksDb(): DB | null {
  try {
    try {
      db?.close();
    } catch {
      // 旧连接可能已失效
    }
    db = null;
    try {
      const stale = open({ name: USER_BOOKS_DB, location: DB_LOCATION });
      stale.delete();
      try {
        stale.close();
      } catch {
        // delete 可能已同时关闭
      }
    } catch (e) {
      console.warn('[UserBookService] 删除损坏 db 失败:', (e as Error)?.message ?? e);
    }
  } catch (e) {
    console.warn('[UserBookService] db 重建准备失败:', (e as Error)?.message ?? e);
  }
  try {
    const instance = open({ name: USER_BOOKS_DB, location: DB_LOCATION });
    createUserBooksSchema(instance);
    if (!probeUserBooksDb(instance)) {
      console.warn('[UserBookService] db 重建后探针仍失败，本会话书籍功能降级');
      return null;
    }
    console.warn('[UserBookService] user_books.db 已删库重建成功');
    db = instance;
    return instance;
  } catch (e) {
    console.warn('[UserBookService] user_books.db 重建失败:', (e as Error)?.message ?? e);
    return null;
  }
}

function getDb(): DB | null {
  if (db) {
    return db;
  }
  try {
    const instance = open({ name: USER_BOOKS_DB, location: DB_LOCATION });
    createUserBooksSchema(instance);
    if (!probeUserBooksDb(instance)) {
      // 真机已踩坑：db 损坏（SQL execution error: disk I/O error）→
      // 所有查询全灭、书架空白且无诊断。纯缓存库，直接删库重建。
      if (!dbRepairAttempted) {
        dbRepairAttempted = true;
        return repairUserBooksDb();
      }
      return null;
    }
    db = instance;
    return instance;
  } catch (e) {
    console.warn('[UserBookService] 打开 user_books.db 失败:', (e as Error)?.message ?? e);
    if (!dbRepairAttempted) {
      dbRepairAttempted = true;
      return repairUserBooksDb();
    }
    return null;
  }
}

// ============ 书籍文件夹（guoxue-books） ============

/**
 * 书籍根文件夹绝对路径。
 * Android 取外部应用目录（Android/data/<pkg>/files，USB / 文件管理器可直接
 * 放入文件，无需存储权限）；iOS 及测试环境回落文档目录。
 */
export function getBooksRootPath(): string {
  const base = RNFS.ExternalDirectoryPath || RNFS.DocumentDirectoryPath;
  return `${base}/${BOOKS_DIR_NAME}`;
}

/** 内置书资源子目录绝对路径 */
export function getBuiltinDirPath(): string {
  return `${getBooksRootPath()}/${BUILTIN_DIR_NAME}`;
}

/** 确保书籍根目录与内置书子目录存在（mkdir 递归建父目录） */
async function ensureDirs(): Promise<void> {
  const root = getBooksRootPath();
  if (!(await RNFS.exists(root))) {
    await RNFS.mkdir(root);
  }
  const builtinDir = getBuiltinDirPath();
  if (!(await RNFS.exists(builtinDir))) {
    await RNFS.mkdir(builtinDir);
  }
}

/** 判定文件名是否为支持的书籍格式（且非隐藏文件） */
function isSupportedBookFile(name: string): boolean {
  if (name.startsWith('.')) {
    return false;
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext !== '' && BOOK_EXTENSIONS.includes(ext);
}

/**
 * 文件名 → 稳定书籍 ID（FNV-1a 32 位哈希）。
 * 同名文件（含内容更新后重解析）永远得到同一 ID，用户数据不脱挂；
 * 文件重命名等同换书（与旧「重导入生成新 ID」语义一致）。
 */
export function stableBookIdFromPath(fileName: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < fileName.length; i += 1) {
    h ^= fileName.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `user-h${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 内容签名：与路径/文件名无关的文件内容指纹（导入去重用）。
 * 全量双散列（FNV-1a 32bit ⊕ djb2）+ 字节长度——字节级相同的文件
 * （同一本书被改名/移动/复制后再导入）必得同签名；不同书碰撞概率
 * 可忽略。签名前缀 cs1 便于未来演进哈希算法时区分世代。
 */
function contentSignature(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + b) >>> 0;
  }
  return `cs1-${h1.toString(16)}-${h2.toString(16)}-${bytes.length}`;
}

/** 文本 → UTF-8 字节（签名口径统一为解码后文本，同书不同编码同签名） */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** 从 file_sig「mtimeMs:size」中提取文件字节数（无信息时返回 -1） */
function sizeFromFileSig(fileSig: string | null | undefined): number {
  if (!fileSig) {
    return -1;
  }
  const size = Number(String(fileSig).split(':').pop());
  return Number.isFinite(size) && size >= 0 ? size : -1;
}

/**
 * 查找书架中与给定内容签名相同的书（导入去重）。
 * 匹配两级：① content_hash 直接相等；② 旧数据无哈希但文件大小相同 →
 * 现场读取该书源文件计算哈希比对（仅在导入时发生，代价可接受）。
 * 返回重复书的 id（无重复返回 null）；db 异常时返回 null（放行导入，
 * 不因查重故障阻断正常导入）。
 */
async function findDuplicateBook(
  instance: DB,
  sig: string,
  sizeBytes: number,
): Promise<string | null> {
  let rows: Array<{
    id: string;
    title: string;
    source_path: string | null;
    file_sig: string | null;
    content_hash: string | null;
  }> = [];
  try {
    const res = instance.execute(
      'SELECT id, title, source_path, file_sig, content_hash FROM user_books',
    );
    rows = (res.rows?._array ?? []) as typeof rows;
  } catch (e) {
    console.warn('[UserBookService] 导入查重查询失败（放行导入）:', (e as Error)?.message ?? e);
    return null;
  }
  for (const r of rows) {
    if (r.content_hash) {
      if (r.content_hash === sig) {
        return r.id;
      }
      continue;
    }
    // 旧数据无哈希：先比文件大小（字节级相同必同大小），大小相同才读文件比对
    if (sizeFromFileSig(r.file_sig) === sizeBytes && r.source_path) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const bytesRes = await readFileBytes(r.source_path);
        if (bytesRes.success && bytesRes.data && contentSignature(bytesRes.data) === sig) {
          return r.id;
        }
      } catch {
        // 单行比对失败不影响整体查重
      }
    }
  }
  return null;
}

/** 内置书 → 带章节标记的纯文本（@@CH@@标题 + 段落空行分隔，资源副本格式） */
export function bookToMarkerText(book: Book): string {
  const parts: string[] = [];
  for (const ch of book.chapters) {
    parts.push(`${CHAPTER_MARKER}${ch.title}`);
    parts.push(ch.segments.map((s) => s.text).join('\n\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

// ============ 内置书物化与抑制 ============

/** 内存中的内置书抑制集合（与 db builtin_hidden 表同步） */
let hiddenBuiltins: Set<string> = new Set();

/** 从 db 读取内置书抑制记录（表/列不可用时降级为空集） */
function loadHiddenBuiltins(): Set<string> {
  const instance = getDb();
  if (!instance) {
    return new Set();
  }
  try {
    const res = instance.execute('SELECT id FROM builtin_hidden');
    const rows = (res.rows?._array ?? []) as Array<{ id: string }>;
    hiddenBuiltins = new Set(rows.map((r) => r.id));
  } catch {
    hiddenBuiltins = new Set();
  }
  return hiddenBuiltins;
}

/** 把当前抑制集合同步进 TextLibraryService（mock 环境无该方法时跳过） */
function applySuppression(): void {
  const fn = (
    TextLibraryService as unknown as {
      setSuppressedBuiltins?: (ids: string[]) => unknown;
    }
  ).setSuppressedBuiltins;
  if (typeof fn === 'function') {
    fn.call(TextLibraryService, Array.from(hiddenBuiltins));
  }
}

/**
 * 构建内置书「元数据书」：chapters 仅目录（id/title/order，segments 空），
 * 全文由 ensureBookLoaded 按书惰性水合（按需装载架构——启动只注册
 * 77 部书的目录，约 3000 条标题、<1MB；37MB 正文完全不进内存）。
 */
function buildBuiltinMetaBooks(): Book[] {
  return BUILTIN_CATALOG.filter((spec) => !hiddenBuiltins.has(spec.id)).map((spec) => ({
    id: spec.id,
    title: spec.title,
    author: spec.author,
    category: spec.category,
    description: spec.description,
    chapters: spec.toc.map((t, i) => ({
      id: t.id,
      bookId: spec.id,
      title: t.title,
      order: i + 1,
      segments: [],
    })),
  }));
}

/**
 * 注册内置书元数据（每进程一次）。书架即刻完整可用（77 部卡片 + 章节目录），
 * 与文件系统扫描/解析成败彻底解耦。抑制（用户删除）变化经 applySuppression
 * → setSuppressedBuiltins 增量生效，无需重注册。
 */
function registerBuiltinMetaOnce(): void {
  if (builtinMetaRegistered) {
    return;
  }
  const reg = (
    TextLibraryService as unknown as {
      registerBuiltinBooks?: (books: Book[]) => { success: boolean; error?: string };
    }
  ).registerBuiltinBooks;
  if (typeof reg === 'function') {
    reg.call(TextLibraryService, buildBuiltinMetaBooks());
    builtinMetaRegistered = true;
  }
}

/** 让出 JS 线程一拍（setTimeout 0）：把已排队的 tap/触摸/渲染任务放行 */
function yieldToJs(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * 与交互收尾竞速的让出 promise；InteractionManager 不可用（测试桩/
 * 异常环境）时返回 undefined——此时书间让出必须退化为纯 setTimeout
 * 下限等待，绝不能拿「已 resolve 的 promise」参与竞速（那会让下限
 * 失效，等于没让出）。
 */
function runAfterInteractionsSafe(): Promise<void> | undefined {
  try {
    // 经 unknown 双重断言：RN 类型里 runAfterInteractions 返回 thenable
    //（无 catch/finally），与标准 Promise 结构不兼容，需放宽签名判断
    const im = InteractionManager as unknown as
      | { runAfterInteractions?: () => Promise<void> }
      | undefined;
    if (im && typeof im.runAfterInteractions === 'function') {
      return im.runAfterInteractions();
    }
  } catch {
    // 测试桩/异常环境下降级
  }
  return undefined;
}

/**
 * FTS 队列书间让出：InteractionManager（等交互收尾）与 setTimeout
 * （至少 ftsQueueYieldMs，默认 200ms）竞速——两者都满足前不开始下一本书
 * 的解析。InteractionManager 不可用时只等 setTimeout 下限。
 */
function ftsInterBookYield(): Promise<void> {
  const timerDone = new Promise<void>((resolve) => setTimeout(resolve, ftsQueueYieldMs));
  const interactionDone = runAfterInteractionsSafe();
  if (!interactionDone) {
    return timerDone;
  }
  return Promise.race([interactionDone, timerDone]);
}

/** 单本内置书装载（builtin/ 文件解析 → APK assets 直读兜底），不含注册。
 * chunked 默认 true：水合与 FTS 队列两条路径都走分片解析（大书装配
 * 期间按章让出 JS，tap/动画可插队）。 */
async function loadBuiltinBookBody(
  spec: BuiltinBookSpec,
  chunked = true,
): Promise<ParsedFileBook | null> {
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  let parsed = await parseBookFile(canonicalPath, `${spec.id}.txt`, spec.id, spec, chunked);
  if (!parsed) {
    parsed = await parseBuiltinFromAssets(spec, canonicalPath, chunked);
  }
  return parsed;
}

/** 指纹自愈：落盘文件与资产大小不一致先覆盖补写（物化时机之外的自愈）。
 * ensureBookLoaded / ensureBookReady 共用。 */
async function ensureBuiltinAssetFresh(spec: BuiltinBookSpec): Promise<void> {
  if (typeof spec.sizeBytes !== 'number' || spec.sizeBytes <= 0) {
    return;
  }
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  try {
    // eslint-disable-next-line no-await-in-loop
    const st = await RNFS.stat(canonicalPath);
    const destSize = Number((st as { size?: number | string }).size ?? 0);
    if (destSize > 0 && destSize !== spec.sizeBytes) {
      // eslint-disable-next-line no-await-in-loop
      await RNFS.copyFileAssets(`books/${spec.id}.txt`, canonicalPath);
    }
  } catch {
    // stat 失败（文件缺失/IO 异常）交由读取路径兜底
  }
}

/** 内置书正文文本直读（不经解析）：文件 → assets 兜底。
 * 首章优先快速水合用——只需原文即可切章与装配目标章。 */
async function readBuiltinText(
  spec: BuiltinBookSpec,
): Promise<{ text: string; contentHash: string } | null> {
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  try {
    const bytesRes = await readFileBytes(canonicalPath);
    if (bytesRes.success && bytesRes.data && bytesRes.data.length > 0) {
      const text = decodeTextBytes(bytesRes.data).text;
      return { text, contentHash: contentSignature(utf8Bytes(text)) };
    }
  } catch {
    // 文件读取失败走 assets 兜底
  }
  try {
    const text = await RNFS.readFileAssets(`books/${spec.id}.txt`, 'utf8');
    return { text, contentHash: contentSignature(utf8Bytes(text)) };
  } catch {
    return null;
  }
}

/**
 * 确保内置书全文已装载（按需装载核心入口）。
 * 用户书始终全量注册（数量少、单本有限），直接返回；内置书未水合时
 * 从 builtin/ 文件（或 assets 兜底）解析单本书并 hydrate 进文本库。
 * 单本 50KB~2.5MB，解析几十~两百 ms；并发调用按书去重。sizeBytes
 * 指纹不一致（升级换资产/半截文件）先覆盖补写再解析。
 */
export async function ensureBookLoaded(
  bookId: string,
): Promise<ServiceResult<Book>> {
  if (!bookId) {
    return { success: false, error: '书籍 ID 不能为空' };
  }
  if (TextLibraryService.isUserBook(bookId) || !getBuiltinSpec(bookId)) {
    return TextLibraryService.getBook(bookId);
  }
  if (hiddenBuiltins.has(bookId)) {
    return { success: false, error: '该书籍已被删除' };
  }
  if (TextLibraryService.isBookHydrated(bookId)) {
    return TextLibraryService.getBook(bookId);
  }
  const inFlight = ensureInFlight.get(bookId);
  if (inFlight) {
    return inFlight;
  }
  const spec = getBuiltinSpec(bookId)!;
  const task = (async (): Promise<ServiceResult<Book>> => {
    try {
      // 用户优先门闩：水合前置位（+30s，每次水合刷新）。FTS 后台队列在
      // 书间检查点见此标志即轮询等待，绝不与用户当前操作争抢 JS。
      ftsQueuePausedUntil = Date.now() + FTS_PAUSE_ON_HYDRATE_MS;
      // 让出一拍再开始解析：把已在事件队列里的 tap/触摸事件先放行，
      // 避免「点了没反应、事件在水合同步解析结束后才生效」的假死体感。
      await yieldToJs();
      // 指纹校验：落盘文件与资产大小不一致先覆盖补写（物化时机之外的自愈）
      await ensureBuiltinAssetFresh(spec);
      const parsed = await loadBuiltinBookBody(spec);
      if (!parsed) {
        return { success: false, error: `书籍内容加载失败：${spec.title}` };
      }
      const reg = (
        TextLibraryService as unknown as {
          hydrateBook?: (book: Book) => { success: boolean; error?: string };
        }
      ).hydrateBook;
      if (typeof reg === 'function') {
        const regRes = reg.call(TextLibraryService, parsed.book);
        if (!regRes.success) {
          return { success: false, error: regRes.error ?? '注册书体失败' };
        }
      }
      return TextLibraryService.getBook(bookId);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    } finally {
      // 解析收尾再续 10s 缓冲（无论成败）：水合刚完成的用户大概率
      // 立刻翻页/点击，队列必须等这波连续操作结束再恢复后台索引。
      ftsQueuePausedUntil = Math.max(
        ftsQueuePausedUntil,
        Date.now() + FTS_PAUSE_AFTER_HYDRATE_MS,
      );
      ensureInFlight.delete(bookId);
    }
  })();
  ensureInFlight.set(bookId, task);
  return task;
}

/** 首章优先快速水合：进行中标记（书 ID 集合）。
 * FTS 后台队列见此标志即跳过该书（填充完成后由填充流程顺带入索引，
 * 省一次重复解析）；下轮启动重试兜底。 */
const builtinFillInFlight = new Set<string>();
/** 章节填充进度监听（阅读器订阅：当前章正文就位后刷新派生） */
const builtinFillListeners = new Set<(bookId: string) => void>();

/**
 * 订阅内置书章节后台填充进度（每批 30 章合并后触发一次回调）。
 * 返回取消订阅函数。阅读器用它驱动 hydrateTick 重算：用户跳到尚未
 * 填充完的章时，「正文空壳」章在填充到该章后自动变为可读。
 */
export function onBuiltinFillProgress(cb: (bookId: string) => void): () => void {
  builtinFillListeners.add(cb);
  return () => {
    builtinFillListeners.delete(cb);
  };
}

/** ensureBookReady 的并发去重（首屏快速路径，与全量装载分开记账） */
const readyInFlight = new Map<string, Promise<ServiceResult<Book>>>();

/**
 * 首章优先快速水合（阅读器专用入口，问题：首开加载圈太长）。
 * 与 ensureBookLoaded（整本解析完才 resolve）的区别：只解析用户要读的
 * 目标章（几十 ms 量级）即 hydrate 上屏——其余章节先以「空壳章」（仅有
 * id/title/order、segments 为空）占位保证目录完整，随后由后台任务按批
 * （30 章/批）填充并逐批合并回文本库（onBuiltinFillProgress 通知阅读器）。
 *
 * 空壳章与解析器的 id 严格对齐：pushChapter 只在段落非空时递增编号，
 * 而「body 仅空白 ⟺ toParagraphs 为空」（已核对 toParagraphs 实现），
 * 故空壳构建用相同的空白判定跳过无正文章节，两者产出的 `bookId-cN`
 * 序列逐一对齐（77 部/3243 章已脚本验证）。
 *
 * 背景填充期间持续压住 FTS 队列门闩（填充本身就是用户活动）；填充完成
 * 后书体已在内存，顺带 upsert FTS 索引（若未入索引），省一次重复解析。
 * 失败兜底：文本直读失败 → 走整本分片解析旧路径（ensureBookLoaded 语义）。
 */
export async function ensureBookReady(
  bookId: string,
  opts?: { priorityChapterId?: string | null },
): Promise<ServiceResult<Book>> {
  if (!bookId) {
    return { success: false, error: '书籍 ID 不能为空' };
  }
  if (TextLibraryService.isUserBook(bookId) || !getBuiltinSpec(bookId)) {
    return TextLibraryService.getBook(bookId);
  }
  if (hiddenBuiltins.has(bookId)) {
    return { success: false, error: '该书籍已被删除' };
  }
  if (TextLibraryService.isBookHydrated(bookId)) {
    // 已水合（含早期部分水合）：正文空壳章由填充进度订阅驱动刷新，
    // 这里直接返回当前书体，绝不重置回解析流程
    return TextLibraryService.getBook(bookId);
  }
  const fullInFlight = ensureInFlight.get(bookId);
  if (fullInFlight) {
    return fullInFlight;
  }
  const inFlight = readyInFlight.get(bookId);
  if (inFlight) {
    return inFlight;
  }
  const spec = getBuiltinSpec(bookId)!;
  const task = (async (): Promise<ServiceResult<Book>> => {
    try {
      ftsQueuePausedUntil = Date.now() + FTS_PAUSE_ON_HYDRATE_MS;
      await yieldToJs();
      await ensureBuiltinAssetFresh(spec);
      const body = await readBuiltinText(spec);
      if (!body) {
        // 兜底：文本直读失败 → 整本分片解析旧路径
        const parsed = await loadBuiltinBookBody(spec);
        if (!parsed) {
          return { success: false, error: `书籍内容加载失败：${spec.title}` };
        }
        const reg = (
          TextLibraryService as unknown as {
            hydrateBook?: (book: Book) => { success: boolean; error?: string };
          }
        ).hydrateBook;
        if (typeof reg === 'function') {
          const regRes = reg.call(TextLibraryService, parsed.book);
          if (!regRes.success) {
            return { success: false, error: regRes.error ?? '注册书体失败' };
          }
        }
        return TextLibraryService.getBook(bookId);
      }
      const shells = buildBuiltinChapterShells(bookId, body.text);
      if (shells.length === 0) {
        // 兜底：切章失败（异常文本）→ 整本分片解析旧路径
        const parsed = await loadBuiltinBookBody(spec);
        if (!parsed) {
          return { success: false, error: `书籍内容加载失败：${spec.title}` };
        }
        const reg = (
          TextLibraryService as unknown as {
            hydrateBook?: (book: Book) => { success: boolean; error?: string };
          }
        ).hydrateBook;
        if (typeof reg === 'function') {
          const regRes = reg.call(TextLibraryService, parsed.book);
          if (!regRes.success) {
            return { success: false, error: regRes.error ?? '注册书体失败' };
          }
        }
        return TextLibraryService.getBook(bookId);
      }
      // 目标章优先装配：只解析用户要读的这一章（回退第一章），其余留空壳
      const target =
        shells.find((s) => s.chapter.id === opts?.priorityChapterId) ?? shells[0];
      const paras = toParagraphs(target.bodyLines.join('\n'));
      target.chapter.segments = paras.map((p, idx) => ({
        id: `${target.chapter.id}-s${idx + 1}`,
        chapterId: target.chapter.id,
        order: idx + 1,
        text: p,
      }));
      const earlyBook = assembleBuiltinBook(spec, shells.map((s) => s.chapter));
      const reg = (
        TextLibraryService as unknown as {
          hydrateBook?: (book: Book) => { success: boolean; error?: string };
        }
      ).hydrateBook;
      if (typeof reg === 'function') {
        const regRes = reg.call(TextLibraryService, earlyBook);
        if (!regRes.success) {
          return { success: false, error: regRes.error ?? '注册书体失败' };
        }
      }
      // 后台填充：不阻塞首屏 promise（resolve 后阅读器当帧可渲染目标章）
      void fillRemainingBuiltinChapters(spec, shells);
      return TextLibraryService.getBook(bookId);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    } finally {
      readyInFlight.delete(bookId);
    }
  })();
  readyInFlight.set(bookId, task);
  return task;
}

/**
 * 内置书空壳章构建：@@CH@@ 标记文本 → 全量章节骨架（segments 空）。
 * 切章/开篇/空白跳过规则与解析器完全一致（见函数头注释），仅不做
 * toParagraphs 装配（重活留给目标章与后台填充）。
 */
function buildBuiltinChapterShells(
  bookId: string,
  text: string,
): { chapter: Book['chapters'][number]; bodyLines: string[] }[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const { rawChapters, preface } = splitRawChapters(normalized, true);
  const shells: { chapter: Book['chapters'][number]; bodyLines: string[] }[] = [];
  let order = 0;
  const addShell = (chapterTitle: string, bodyLines: string[]): void => {
    // 与解析器对齐：body 仅空白 → toParagraphs 为空 → 该章不编号不产出
    if (bodyLines.join('\n').trim() === '') {
      return;
    }
    order += 1;
    const chapterId = `${bookId}-c${order}`;
    shells.push({
      chapter: { id: chapterId, bookId, title: chapterTitle, order, segments: [] },
      bodyLines,
    });
  };
  if (toParagraphs(preface.join('\n')).length > 0) {
    addShell('开篇', preface);
  }
  for (const rc of rawChapters) {
    addShell(rc.title, rc.body);
  }
  return shells;
}

/** 内置书体组装（目录清单元数据 + 章节列表） */
function assembleBuiltinBook(
  spec: BuiltinBookSpec,
  chapters: Book['chapters'],
): Book {
  return {
    id: spec.id,
    title: spec.title,
    author: spec.author,
    category: spec.category,
    description: spec.description,
    chapters,
  };
}

/**
 * 后台分批填充剩余章节：每 30 章一批（与 parseTxtBookChunked 同粒度），
 * 批内同步装配、批间让出 JS，并把合并后的书体重新 hydrate（引用替换
 * 使 TextLibraryService 缓存正确失效）+ 通知订阅者。填充即用户活动，
 * 期间持续压住 FTS 队列门闩；全部完成后书体在内存，顺带补 FTS 索引。
 * 失败静默中止（空壳章保留，重进该书重新走 ensureBookReady 水合）。
 */
async function fillRemainingBuiltinChapters(
  spec: BuiltinBookSpec,
  shells: { chapter: Book['chapters'][number]; bodyLines: string[] }[],
): Promise<void> {
  builtinFillInFlight.add(spec.id);
  try {
    const hydrate = (
      TextLibraryService as unknown as {
        hydrateBook?: (book: Book) => { success: boolean; error?: string };
      }
    ).hydrateBook;
    // 先让出一拍再开始批量装配：ensureBookReady 的首屏 promise 先 resolve
    //（首屏只含目标章解析），填充绝不与首屏渲染争抢同一拍
    // eslint-disable-next-line no-await-in-loop
    await yieldToJs();
    for (let start = 0; start < shells.length; start += PARSE_CHUNK_CHAPTERS) {
      // 填充期间压住 FTS 队列（书间检查点生效），完成后留 10s 收尾缓冲
      ftsQueuePausedUntil = Math.max(
        ftsQueuePausedUntil,
        Date.now() + FTS_PAUSE_ON_HYDRATE_MS,
      );
      let batchFilled = 0;
      for (
        let i = start;
        i < Math.min(start + PARSE_CHUNK_CHAPTERS, shells.length);
        i += 1
      ) {
        const shell = shells[i];
        if (shell.chapter.segments.length > 0) {
          continue; // 目标章已在首屏装配，跳过
        }
        const paras = toParagraphs(shell.bodyLines.join('\n'));
        shell.chapter.segments = paras.map((p, idx) => ({
          id: `${shell.chapter.id}-s${idx + 1}`,
          chapterId: shell.chapter.id,
          order: idx + 1,
          text: p,
        }));
        batchFilled += 1;
      }
      // 批间让出一拍：tap/触摸/渲染可插队
      // eslint-disable-next-line no-await-in-loop
      await yieldToJs();
      if (batchFilled > 0 && typeof hydrate === 'function') {
        const merged = assembleBuiltinBook(
          spec,
          shells.map((s) => s.chapter),
        );
        try {
          hydrate.call(TextLibraryService, merged);
        } catch {
          // 单批合并失败不中止（空壳保留，下次进入重水合）
        }
        builtinFillListeners.forEach((cb) => {
          try {
            cb(spec.id);
          } catch {
            // 单个订阅者异常不影响其余订阅者与填充流程
          }
        });
      }
    }
    // 填充完成：书体已在内存，若尚未入 FTS 索引则顺带补齐（省重复解析）
    if (!StorageService.isBookIndexedInFts(spec.id)) {
      try {
        StorageService.upsertFtsForBook(
          assembleBuiltinBook(spec, shells.map((s) => s.chapter)),
        );
      } catch {
        // 索引失败由下轮启动的 FTS 队列兜底
      }
    }
  } catch {
    // 填充整体异常：静默中止（空壳章保留，重进重水合）
  } finally {
    builtinFillInFlight.delete(spec.id);
    ftsQueuePausedUntil = Math.max(
      ftsQueuePausedUntil,
      Date.now() + FTS_PAUSE_AFTER_HYDRATE_MS,
    );
  }
}

/**
 * 内置书 FTS 后台索引队列（按需装载架构的搜索配套）。
 * 全文搜索主路径查 SQLite segments_fts，不再依赖内存全量注册——启动后
 * 空闲期逐书解析 → upsert 进 FTS → 立即丢弃书体（不经 TextLibraryService，
 * 内存峰值恒为单本）。已入索引的书跳过（幂等增量）；单书失败吞错跳过，
 * 下轮启动重试。
 *
 * 用户优先策略（真机 BugFix：启动后点卡片响应缓慢）：
 *  - 首次启动延迟默认 10s（原 3s），先让书架/水合链路彻底站稳；
 *  - 每本书开始前检查「用户优先门闩」（ftsQueuePausedUntil）：用户
 *    水合期间轮询等待（250ms 一次），门闩过期才继续下一本；
 *  - 书间让出从 setTimeout(16) 升级为 InteractionManager 与 setTimeout(200)
 *    竞速：至少 200ms 间隔且等当前交互/动画收尾，大幅降低连续占用；
 *  - 单本解析走分片路径（loadBuiltinBookBody chunked）：书内按章让出，
 *    用户 tap 可在章间插队，正解析一本书时无需中断也不会拖死交互。
 */
export function scheduleBuiltinFtsIndexBuild(delayMs = 10000): void {
  if (builtinFtsQueueRunning) {
    return;
  }
  builtinFtsQueueRunning = true;
  const run = async (): Promise<void> => {
    // 等启动链路完全收尾再开跑（书架渲染/水合入口优先）
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    for (const spec of BUILTIN_CATALOG) {
      if (hiddenBuiltins.has(spec.id)) {
        continue;
      }
      // 用户优先门闩：书间检查点——水合进行中/缓冲期内轮询等待，
      // 绝不开始新书解析（只在书间让路，不中断书内分片解析）。
      while (Date.now() < ftsQueuePausedUntil) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, FTS_PAUSE_POLL_MS));
      }
      // 填充中的书跳过：其后台填充完成后会顺带入索引（书体已在内存），
      // 这里再解析一遍纯属浪费；本轮跳过、下轮启动重试兜底
      if (builtinFillInFlight.has(spec.id)) {
        continue;
      }
      try {
        if (!StorageService.isBookIndexedInFts(spec.id)) {
          const parsed = await loadBuiltinBookBody(spec);
          if (parsed) {
            StorageService.upsertFtsForBook(parsed.book);
          }
        }
      } catch {
        // 单书失败不阻断队列（下轮启动重试）
      }
      // 每书让出：至少 200ms 且等当前交互/动画收尾，批量解析期间 UI 可交互
      // eslint-disable-next-line no-await-in-loop
      await ftsInterBookYield();
    }
  };
  run()
    .catch(() => undefined)
    .finally(() => {
      builtinFtsQueueRunning = false;
    });
}

/** 仅测试：注入 FTS 队列书间让出间隔（ms，0 = 立即让出）。
 * 用例注入短间隔避免真实 200ms×77 本拖慢测试；门闩/竞速语义不变。 */
export function __setFtsQueueYieldForTests(ms: number): void {
  ftsQueueYieldMs = ms;
}

/** 仅测试用：重置惰性装载模块级状态（注册标记跨用例残留会破坏冷启动场景）；
 * 同时关闭 FTS 队列自动排队（防 10s 挂起定时器悬住 jest 进程），
 * 并清空「用户优先」门闩与书间让出注入（恢复默认 200ms）。 */
export function __resetBuiltinLazyStateForTests(): void {
  builtinMetaRegistered = false;
  builtinFtsQueueRunning = false;
  builtinFtsAutoSchedule = false;
  ftsQueuePausedUntil = 0;
  ftsQueueYieldMs = 200;
  builtinFillInFlight.clear();
  builtinFillListeners.clear();
  ensureInFlight.clear();
  readyInFlight.clear();
}

/**
 * 物化内置书：builtin/ 下缺文件或与目录清单 sizeBytes 指纹不一致的，
 * 从 APK assets（books/<id>.txt，@@CH@@ 标记文本）复制/覆盖补齐。
 * 大小比对覆盖两类场景：① App 升级内置书换全本资产（如文选残本→
 * 六十卷全本）；② 首启复制被中断留下的半截文件。内容变更的书会同时
 * 失效 db 解析缓存行（仅删缓存，不级联清理背诵/收藏/笔记），下轮装载
 * 自动重新解析上架。被抑制（用户已删除）的书不补写——删除永久生效，
 * 除非「恢复内置书籍」；单书复制失败只记录该 id（下轮重试），绝不影响
 * 其他书。返回复制失败的书籍 ID 列表（供诊断展示）。
 */
async function materializeBuiltins(): Promise<string[]> {
  const builtinDir = getBuiltinDirPath();
  const failures: string[] = [];
  const changedIds: string[] = [];
  for (const spec of BUILTIN_CATALOG) {
    if (hiddenBuiltins.has(spec.id)) {
      continue;
    }
    const path = `${builtinDir}/${spec.id}.txt`;
    try {
      let needCopy = false;
      let contentChanged = false;
      if (!(await RNFS.exists(path))) {
        needCopy = true;
      } else if (typeof spec.sizeBytes === 'number' && spec.sizeBytes > 0) {
        // 指纹比对：落盘文件与随包资产字节大小不一致即视为内容变更
        try {
          // eslint-disable-next-line no-await-in-loop
          const st = await RNFS.stat(path);
          const destSize = Number((st as { size?: number | string }).size ?? 0);
          if (destSize !== spec.sizeBytes) {
            needCopy = true;
            contentChanged = true;
          }
        } catch {
          // stat 失败按缺失处理（覆盖复制兜底）
          needCopy = true;
          contentChanged = true;
        }
      }
      if (needCopy) {
        // eslint-disable-next-line no-await-in-loop
        await RNFS.copyFileAssets(`books/${spec.id}.txt`, path);
        if (contentChanged) {
          changedIds.push(spec.id);
        }
      }
    } catch {
      // copyFileAssets 失败（旧机型/异常路径）回落读资产+写文件
      try {
        const existed = await RNFS.exists(path);
        // eslint-disable-next-line no-await-in-loop
        const content = await RNFS.readFileAssets(`books/${spec.id}.txt`, 'utf8');
        // eslint-disable-next-line no-await-in-loop
        await RNFS.writeFile(path, content, 'utf8');
        if (existed) {
          changedIds.push(spec.id);
        }
      } catch {
        // 单书自愈失败：记录诊断，下轮启动重试，不阻断其他书
        failures.push(spec.id);
      }
    }
  }
  // 内容变更的书失效解析缓存（user_books 为纯缓存表；不动其余表，
  // 背诵/收藏/笔记等用户数据保留，阅读进度按章号截断容错）
  if (changedIds.length > 0) {
    const db = getDb();
    if (db) {
      for (const id of changedIds) {
        try {
          db.execute('DELETE FROM user_books WHERE id = ?', [id]);
        } catch {
          // 单行失效失败不影响其他书；旧缓存下轮仍会因标题/指纹机制兜底
        }
      }
      console.warn(
        `[UserBookService] 内置书资产内容更新 ${changedIds.length} 部，已失效解析缓存：${changedIds.join(',')}`,
      );
    }
  }
  if (failures.length > 0) {
    console.warn(
      `[UserBookService] 内置书资产复制失败 ${failures.length}/${BUILTIN_CATALOG.length}：${failures.join(',')}`,
    );
  }
  return failures;
}

// ============ 文件选取与读取 ============

/** 选取的书籍文件 */
export interface PickedBookFile {
  uri: string;
  fileName: string;
  size: number;
}

/** 文件选择（限 .txt，copyTo cachesDirectory 拿稳定本地路径） */
export async function pickBookFile(): Promise<ServiceResult<PickedBookFile>> {
  try {
    const res = await DocumentPicker.pick({
      type: [DocumentPicker.types.allFiles],
      copyTo: 'cachesDirectory',
    });
    const f = (Array.isArray(res) ? res[0] : res) as {
      uri: string;
      fileCopyUri?: string | null;
      name?: string | null;
      fileName?: string | null;
      size?: number | null;
    };
    if (!f || !f.uri) {
      return { success: false, error: '选择文件失败：未获取到文件' };
    }
    const fileName = f.name ?? f.fileName ?? f.uri.split('/').pop() ?? 'book';
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (ext && !BOOK_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: `暂不支持 .${ext} 格式，支持：${BOOK_EXTENSIONS.join(' / ')}`,
      };
    }
    const chosen = f.fileCopyUri ?? f.uri;
    // content:// 等 provider URI 无法被 RNFS 读取（部分机型 copyTo 会失败回落）
    if (!isLocalPath(chosen)) {
      return {
        success: false,
        error: '系统未能提供所选文件的本地副本，请重新选择（建议把文件放到「下载」目录后再试）',
      };
    }
    return {
      success: true,
      data: { uri: chosen, fileName, size: f.size ?? 0 },
    };
  } catch (e) {
    if (DocumentPicker.isCancel(e)) {
      return { success: false, error: '已取消选择文件' };
    }
    return { success: false, error: `选择文件失败：${(e as Error).message}` };
  }
}

/** 分块读取文件为原始字节（base64 分块；不限文件大小） */
export async function readFileBytes(
  uri: string,
): Promise<ServiceResult<Uint8Array>> {
  try {
    // file:// 前缀 + URL 编码会让 RNFS（java.io.File）找不到文件 → "File does not exist"
    const path = toLocalPath(uri);
    const stat = await RNFS.stat(path);
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size < 0) {
      return { success: false, error: '无法读取文件大小' };
    }
    const parts: Uint8Array[] = [];
    let pos = 0;
    while (pos < size) {
      const take = Math.min(READ_CHUNK_LIMIT, size - pos);
      // eslint-disable-next-line no-await-in-loop
      const b64 = await RNFS.read(path, take, pos, 'base64');
      parts.push(bytesFromBase64(b64));
      pos += take;
    }
    let total = 0;
    for (const p of parts) {
      total += p.length;
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    return { success: true, data: all };
  } catch (e) {
    return { success: false, error: `读取文件失败：${(e as Error).message}` };
  }
}

/** 分块读取文件并解码为文本（编码自动检测 UTF-8/GBK/UTF-16） */
export async function readTextFile(uri: string): Promise<ServiceResult<string>> {
  const res = await readFileBytes(uri);
  if (!res.success || !res.data) {
    return { success: false, error: res.error ?? '读取文件失败' };
  }
  return { success: true, data: decodeTextBytes(res.data).text };
}

/** base64 字符 → 6bit 值表（'=' 特判） */
const B64_CODE = (() => {
  const table = new Int8Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i += 1) {
    table[chars.charCodeAt(i)] = i;
  }
  return table;
})();

function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CODE[clean.charCodeAt(i)];
    const c1 = B64_CODE[clean.charCodeAt(i + 1)];
    const c2 = clean.charCodeAt(i + 2);
    const c3 = clean.charCodeAt(i + 3);
    const v2 = c2 === undefined ? -1 : c2 === 61 ? -2 : B64_CODE[c2];
    const v3 = c3 === undefined ? -1 : c3 === 61 ? -2 : B64_CODE[c3];
    if (p < out.length) {
      out[p++] = (c0 << 2) | (c1 >> 4);
    }
    if (v2 !== -1 && v2 !== -2 && p < out.length) {
      out[p++] = ((c1 & 0xf) << 4) | (v2 >> 2);
    }
    if (v3 !== -1 && v3 !== -2 && p < out.length) {
      out[p++] = ((v2 & 0x3) << 6) | v3;
    }
  }
  return out.subarray(0, p);
}

// ============ 文本 → Book 解析（纯函数，可单测） ============

/** 中文章节标题（行首「第X章/回/节/卷/篇」） */
const CN_CHAPTER_TITLE = `第[0-9〇零一二三四五六七八九十百千两]+[章回节卷篇集][\\s\\S]{0,24}`;
/** 英文序号形式：阿拉伯数字（1-3 位）或罗马数字（1-8 位） */
const EN_CHAPTER_NUM = `\\d{1,3}|[IVXLCDMivxlcdm]{1,8}`;
/**
 * 英文数字词形式（Book One / Part Twelve / Chapter Thirteen / Chapter Twentieth）。
 * 基数词（One…Twenty，实际书籍最常用）与序数词（Thirteenth…Twentieth）都收录；
 * 长词在前，防止 Thirteen 截断 Thirteenth。
 */
const EN_CHAPTER_WORDNUM = `One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirteenth|Fourteenth|Fifteenth|Sixteenth|Seventeenth|Eighteenth|Nineteenth|Twentieth`;
/**
 * 英文标题可带副标题（如 Chapter 1: The Beginning / Chapter 1 The Beginning，副标题 ≤32 字符）。
 * 注意：上限保持 32 不放宽——回归用例「part one of my life story was long and winding road」
 * 的副标题实长约 42 字符，放宽到 48 会把该普通长句误判为章节标题。
 */
const EN_CHAPTER_TAIL = `(?:[.:：\\-—–]?\\s*[\\s\\S]{0,32})?`;
/** 英文关键词大小写自适应（CHAPTER/Chapter/chapter 等任意大小写组合） */
const EN_CHAPTER = `(?:[Cc][Hh][Aa][Pp][Tt][Ee][Rr]|[Bb][Oo][Oo][Kk]|[Pp][Aa][Rr][Tt])`;
/** 英文章节标题（Chapter/Book/Part + 序号，整行匹配防止误切正文句子） */
const EN_CHAPTER_TITLE = `(?:${EN_CHAPTER}\\s+(?:${EN_CHAPTER_NUM}|${EN_CHAPTER_WORDNUM})${EN_CHAPTER_TAIL})`;

/** 章节标题行（中文「第X章…」或英文 Chapter/Book/Part N，且整行较短） */
const CHAPTER_TITLE_RE = new RegExp(`^\\s*(${CN_CHAPTER_TITLE}|${EN_CHAPTER_TITLE})\\s*$`);

/** 章节标记行（结构化格式转换产物，bookFormat.CHAPTER_MARKER 前缀） */
const CHAPTER_MARKER_LINE_RE = new RegExp(`^${CHAPTER_MARKER}(.*)$`);

/** parseTxtBook 可选项（结构化格式导入时传入） */
export interface ParseTxtBookOptions {
  /** 启用 @@CH@@ 章节标记行解析（md/html/fb2/epub 转换产物） */
  markers?: boolean;
  /** 覆盖书名（如 EPUB dc:title） */
  title?: string;
  /** 覆盖作者（如 EPUB dc:creator） */
  author?: string;
  /** 来源格式标签（description 用，默认 TXT） */
  sourceLabel?: string;
}

/** 单段超长时的切分 */
function splitLongParagraph(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const parts: string[] = [];
  for (let s = 0; s < text.length; s += limit) {
    parts.push(text.slice(s, s + limit));
  }
  return parts;
}

/** 文本切段落：优先按空行分组；无空行则每行一段；空白行剔除 */
function toParagraphs(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const chunks = normalized.includes('\n\n')
    ? normalized.split(/\n{2,}/)
    : normalized.split(/\n+/);
  const paragraphs: string[] = [];
  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t) {
      continue;
    }
    paragraphs.push(...splitLongParagraph(t, MAX_SEGMENT_CHARS));
  }
  return paragraphs;
}

/** 生成书籍 ID（user- 前缀为 TextLibraryService 的用户书约定） */
export function makeUserBookId(now = Date.now()): string {
  return `user-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 逐行扫描产出的章节草稿 */
interface RawChapter {
  title: string;
  body: string[];
}

/** 分片解析的让出粒度：每装配 30 章让出一次 JS 线程 */
const PARSE_CHUNK_CHAPTERS = 30;

/**
 * 逐行扫描切出 [章节标题, 标题下正文] 序列与标题前正文（同步纯函数）。
 * useMarkers 启用时 @@CH@@ 标记行同样切章（结构化格式统一标记），
 * 标记行无标题时补「第N章」（按标记行出现顺序计数）。
 * 同步版与分片版装配路径共用本函数，保证解析结果逐字节一致。
 */
function splitRawChapters(
  normalized: string,
  useMarkers: boolean,
): { rawChapters: RawChapter[]; preface: string[] } {
  const lines = normalized.split('\n');
  const rawChapters: RawChapter[] = [];
  let current: RawChapter | null = null;
  const preface: string[] = [];
  let markerCount = 0;
  for (const line of lines) {
    const marker = useMarkers ? CHAPTER_MARKER_LINE_RE.exec(line) : null;
    if (marker) {
      if (current) {
        rawChapters.push(current);
      }
      markerCount += 1;
      current = { title: marker[1].trim() || `第${markerCount}章`, body: [] };
    } else {
      const m = CHAPTER_TITLE_RE.exec(line);
      if (m) {
        if (current) {
          rawChapters.push(current);
        }
        current = { title: m[1].trim(), body: [] };
      } else if (current) {
        current.body.push(line);
      } else {
        preface.push(line);
      }
    }
  }
  if (current) {
    rawChapters.push(current);
  }
  return { rawChapters, preface };
}

/**
 * 章节装配器：pushChapter 抽为共享闭包，同步版（parseTxtBook）与
 * 分片版（parseTxtBookChunked）走完全相同的逐章装配逻辑。
 */
function createChapterBuilder(bookId: string): {
  chapters: Book['chapters'];
  pushChapter: (chapterTitle: string, bodyLines: string[]) => void;
} {
  const chapters: Book['chapters'][number][] = [];
  let chapterOrder = 0;
  const pushChapter = (chapterTitle: string, bodyLines: string[]): void => {
    if (chapters.length >= MAX_CHAPTERS) {
      return;
    }
    const paragraphs = toParagraphs(bodyLines.join('\n'));
    if (paragraphs.length === 0) {
      return;
    }
    chapterOrder += 1;
    const chapterId = `${bookId}-c${chapterOrder}`;
    const segments = paragraphs.map((p, idx) => ({
      id: `${chapterId}-s${idx + 1}`,
      chapterId,
      order: idx + 1,
      text: p,
    }));
    chapters.push({
      id: chapterId,
      bookId,
      title: chapterTitle,
      order: chapterOrder,
      segments,
    });
  };
  return { chapters, pushChapter };
}

/**
 * 解析收尾：书名/作者/描述元数据组装（同步与分片路径共用）。
 * 章节规则沿用原实现：无章节标记整本一章「全文」或切「第N部分」；
 * 有标记时标题前正文归「开篇」。
 */
function finishParsedBook(
  fileName: string,
  bookId: string,
  chapters: Book['chapters'],
  opts?: ParseTxtBookOptions,
): Book {
  const fallbackTitle =
    fileName.replace(/\.(txt|md|markdown|html?|xhtml|fb2|epub)$/i, '').trim() || '未命名书籍';
  const title = opts?.title?.trim() || fallbackTitle;
  const author = opts?.author?.trim() || '佚名';
  const totalSegments = chapters.reduce((n, c) => n + c.segments.length, 0);
  return {
    id: bookId,
    title,
    author,
    category: 'user',
    description: `共 ${chapters.length} 章 ${totalSegments} 段 · 导入自 ${opts?.sourceLabel ?? 'TXT'}`,
    chapters,
  };
}

/**
 * 将文本解析为 Book（同步版，用户书导入等场景使用，签名不变）。
 * 章节规则：行首「第X章/回/节/卷/篇」独立行视为章节标题；
 * 英文行首 Chapter/Book/Part + 序号（阿拉伯/罗马数字/序数词）独立行同样切章；
 * opts.markers 启用时 @@CH@@标题 行同样切章（结构化格式统一标记），
 * 标记行无标题时补「第N章」（按标记行出现顺序计数）；
 * 标题前若有正文则归「开篇」；全篇无标题则整本一章，
 * 段落过多时按 SEGMENTS_PER_PART 切为「第N部分」。
 */
export function parseTxtBook(
  fileName: string,
  text: string,
  bookId = makeUserBookId(),
  opts?: ParseTxtBookOptions,
): Book {
  const normalized = text.replace(/\r\n?/g, '\n');
  const { rawChapters, preface } = splitRawChapters(normalized, opts?.markers ?? false);
  const { chapters, pushChapter } = createChapterBuilder(bookId);
  const prefaceParagraphs = toParagraphs(preface.join('\n'));

  if (rawChapters.length === 0) {
    // 无章节标记：preface 即全部内容，整本一章「全文」；段落过多时切「部分」
    if (prefaceParagraphs.length <= SEGMENTS_PER_PART) {
      pushChapter('全文', preface);
    } else {
      for (let i = 0; i < prefaceParagraphs.length; i += SEGMENTS_PER_PART) {
        const part = prefaceParagraphs.slice(i, i + SEGMENTS_PER_PART);
        pushChapter(`第${Math.floor(i / SEGMENTS_PER_PART) + 1}部分`, [
          part.join('\n\n'),
        ]);
      }
    }
  } else {
    // 有章节标记：标题前正文归「开篇」
    if (prefaceParagraphs.length > 0) {
      pushChapter('开篇', preface);
    }
    for (const rc of rawChapters) {
      pushChapter(rc.title, rc.body);
    }
  }

  return finishParsedBook(fileName, bookId, chapters, opts);
}

/**
 * parseTxtBook 的分片版：切章扫描与逐章装配逻辑与同步版完全共用
 * （splitRawChapters / createChapterBuilder），解析结果逐字节一致；
 * 唯一差异是每装配 PARSE_CHUNK_CHAPTERS（30）章让出一次 JS 线程。
 * 为什么：资治通鉴 9.2MB 的整本同步装配会阻塞 JS 数百 ms~秒级——
 * 内置书水合与 FTS 后台队列均走本函数后，用户 tap/触摸可在章间
 * 插队，loading 圈不再冻结。仅内置书链路使用；用户书导入仍走
 * 同步版 parseTxtBook（签名与行为均不变）。
 */
export async function parseTxtBookChunked(
  fileName: string,
  text: string,
  bookId: string,
  opts?: ParseTxtBookOptions,
): Promise<Book> {
  const normalized = text.replace(/\r\n?/g, '\n');
  const { rawChapters, preface } = splitRawChapters(normalized, opts?.markers ?? false);
  const { chapters, pushChapter } = createChapterBuilder(bookId);
  const prefaceParagraphs = toParagraphs(preface.join('\n'));

  if (rawChapters.length === 0) {
    if (prefaceParagraphs.length <= SEGMENTS_PER_PART) {
      pushChapter('全文', preface);
    } else {
      let partsDone = 0;
      for (let i = 0; i < prefaceParagraphs.length; i += SEGMENTS_PER_PART) {
        const part = prefaceParagraphs.slice(i, i + SEGMENTS_PER_PART);
        pushChapter(`第${Math.floor(i / SEGMENTS_PER_PART) + 1}部分`, [
          part.join('\n\n'),
        ]);
        partsDone += 1;
        // 分片让出：部分切分场景同样按批量让出，保持线程可插队
        if (partsDone % PARSE_CHUNK_CHAPTERS === 0) {
          // eslint-disable-next-line no-await-in-loop
          await yieldToJs();
        }
      }
    }
  } else {
    if (prefaceParagraphs.length > 0) {
      pushChapter('开篇', preface);
    }
    let chaptersDone = 0;
    for (const rc of rawChapters) {
      pushChapter(rc.title, rc.body);
      chaptersDone += 1;
      // 分片让出：每 30 章放行一次已排队的 tap/触摸/渲染任务
      if (chaptersDone % PARSE_CHUNK_CHAPTERS === 0) {
        // eslint-disable-next-line no-await-in-loop
        await yieldToJs();
      }
    }
  }

  return finishParsedBook(fileName, bookId, chapters, opts);
}

// ============ 持久化与注册 ============

/** 内存中的用户书列表（注册进 TextLibraryService 的数据源） */
let loadedBooks: Book[] = [];

/** 单个文件夹文件的解析结果（含文件指纹与内容签名，导入去重用） */
interface ParsedFileBook {
  book: Book;
  sourcePath: string;
  fileSig: string;
  /** 内容签名（与路径/文件名无关，解析时顺带产出，零额外读取） */
  contentHash?: string;
}

/**
 * 读取并解析书籍文件夹内的单个文件为 Book。
 * 结构化格式（epub/docx 等）先转「@@CH@@ 标记文本」再走统一解析；
 * spec（内置书目录条目）存在时按目录清单覆写元数据（title/author/
 * category/description），并强制章节标记解析（资产即标记文本格式）。
 * 解析不出内容（空文件等）返回 null 由调用方跳过。不限文件大小。
 */
async function parseBookFile(
  sourcePath: string,
  fileName: string,
  bookId: string,
  spec?: BuiltinBookSpec,
  chunked = false,
): Promise<ParsedFileBook | null> {
  try {
    const stat = await RNFS.stat(sourcePath);
    const size = Number(stat.size);
    const mtimeMs = stat.mtime ? new Date(stat.mtime).getTime() : 0;
    const fileSig = `${Number.isFinite(mtimeMs) ? mtimeMs : 0}:${Number.isFinite(size) ? size : 0}`;
    const bytesRes = await readFileBytes(sourcePath);
    if (!bytesRes.success || !bytesRes.data) {
      return null;
    }
    const ext = fileName.split('.').pop()?.toLowerCase() ?? 'txt';
    let text: string;
    if (isStructuredFormat(ext)) {
      try {
        const converted = convertBookBytes(ext, bytesRes.data);
        text = converted.text;
      } catch {
        return null;
      }
    } else {
      text = decodeTextBytes(bytesRes.data).text;
    }
    const parseOpts = {
      markers: isStructuredFormat(ext) || !!spec,
      sourceLabel: spec ? '内置' : ext.toUpperCase(),
    };
    // chunked：内置书水合/FTS 队列传 true，大书装配期间按章让出 JS；
    // 用户书导入等其余链路默认 false 走原同步路径（解析结果一致）。
    const book = chunked
      ? await parseTxtBookChunked(fileName, text, bookId, parseOpts)
      : parseTxtBook(fileName, text, bookId, parseOpts);
    if (book.chapters.length === 0) {
      return null;
    }
    if (spec) {
      book.title = spec.title;
      book.author = spec.author;
      book.category = spec.category;
      book.description = spec.description;
    }
    // 内容签名：解码后文本口径（同书不同编码同签名），解析时顺带产出
    return { book, sourcePath, fileSig, contentHash: contentSignature(utf8Bytes(text)) };
  } catch {
    return null;
  }
}

/**
 * 内置书兜底来源：不经文件系统，直接从 APK assets 直读解析。
 * 用于文件解析失败（builtin 文件缺失/损坏/机型 IO 异常）时的最后防线——
 * assets 随包分发，release 环境必然可用。
 */
async function parseBuiltinFromAssets(
  spec: BuiltinBookSpec,
  canonicalPath: string,
  chunked = false,
): Promise<ParsedFileBook | null> {
  try {
    const text = await RNFS.readFileAssets(`books/${spec.id}.txt`, 'utf8');
    const book = chunked
      ? await parseTxtBookChunked(`${spec.id}.txt`, text, spec.id, {
          markers: true,
          sourceLabel: '内置',
        })
      : parseTxtBook(`${spec.id}.txt`, text, spec.id, {
          markers: true,
          sourceLabel: '内置',
        });
    if (book.chapters.length === 0) {
      return null;
    }
    book.title = spec.title;
    book.author = spec.author;
    book.category = spec.category;
    book.description = spec.description;
    // 签名尽量取物化文件的真实指纹；文件缺失时占位（下轮文件可用即重解析缓存）
    let fileSig = '0:0';
    try {
      const stat = await RNFS.stat(canonicalPath);
      const size = Number(stat.size);
      const mtimeMs = stat.mtime ? new Date(stat.mtime).getTime() : 0;
      fileSig = `${Number.isFinite(mtimeMs) ? mtimeMs : 0}:${Number.isFinite(size) ? size : 0}`;
    } catch {
      // 未物化：占位签名
    }
    return {
      book,
      sourcePath: canonicalPath,
      fileSig,
      contentHash: contentSignature(utf8Bytes(text)),
    };
  } catch {
    return null;
  }
}

/** 书籍文件夹同步结果（供管理页/调试展示） */
export interface LibrarySyncSummary {
  /** 文件夹内有效书籍总数 */
  folderBooks: number;
  /** 内置书（builtin/ 资产）数量 */
  builtinBooks: number;
  /** 本次新识别上架的文件数 */
  imported: number;
  /** 本次因文件变化重新解析的书籍数 */
  updated: number;
  /** 本次因源文件缺失而下架的书籍数 */
  removed: number;
  /** 遗留书（文件夹化前导入，应用内管理）数量 */
  legacyBooks: number;
}

/** 最近一次 loadAndRegisterAll 的诊断信息（书架页脚/调试展示，定位真机问题） */
export interface LibrarySyncDiagnostics {
  /** 扫描链路中途异常：本轮降级为 db 装载，内置书注册被跳过（保留上次注册） */
  scanInterrupted: boolean;
  /** 扫描中断时的底层错误信息（页脚直显，避免真机无从下手） */
  scanInterruptedReason: string;
  /** 资产复制失败的内置书 ID */
  assetCopyFailures: string[];
  /** 扫描到的有效（未被抑制）内置资产文件数 */
  builtinFilesSeen: number;
  /** 装载失败的内置书 ID（db 缓存 / 文件 / 资产三路全失败时才计入） */
  builtinParseFailures: string[];
  /** 已转入后台队列解析的超大书数量（完成一本注册一本） */
  oversizedPending: number;
}

function emptySyncDiagnostics(): LibrarySyncDiagnostics {
  return {
    scanInterrupted: false,
    scanInterruptedReason: '',
    assetCopyFailures: [],
    builtinFilesSeen: 0,
    builtinParseFailures: [],
    oversizedPending: 0,
  };
}

let lastSyncDiagnostics: LibrarySyncDiagnostics = emptySyncDiagnostics();

/** 读取最近一次装载的诊断信息（未装载过时返回全空诊断） */
export function getLibrarySyncDiagnostics(): LibrarySyncDiagnostics {
  return lastSyncDiagnostics;
}

/**
 * 逐个处理超大书（串行 + 每项处理前让出 JS 线程）：优先读磁盘缓存
 * （<源文件>.gxcache），无缓存则完整解析并写缓存供下次直接读。
 * 每完成一本立即重注册进文本库——书架下次刷新即可见可读。
 */
async function processOversizedBooks(
  tasks: OversizedTask[],
  baseBooks: () => Book[],
): Promise<Book[]> {
  const loaded: Book[] = [];
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      let book: Book | null = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await RNFS.exists(t.cachePath)) {
          // eslint-disable-next-line no-await-in-loop
          const raw = await RNFS.readFile(t.cachePath, 'utf8');
          const cached = JSON.parse(raw) as Book;
          if (cached && cached.id && Array.isArray(cached.chapters) && cached.chapters.length > 0) {
            book = cached;
          }
        }
      } catch {
        // 缓存缺失/损坏则走完整解析
      }
      if (!book) {
        const id = stableBookIdFromPath(t.name);
        const parsed = await parseBookFile(t.path, t.name, id);
        if (parsed) {
          book = parsed.book;
          try {
            // eslint-disable-next-line no-await-in-loop
            await RNFS.writeFile(t.cachePath, JSON.stringify(parsed.book), 'utf8');
          } catch {
            // 缓存写失败不影响本会话（下次启动重解析）
          }
        }
      }
      if (book) {
        loaded.push(book);
        oversizedBookFiles.set(book.id, { path: t.path, cachePath: t.cachePath });
        console.warn(
          `[UserBookService] 超大书后台装载完成 ${loaded.length}/${tasks.length}：${book.title}`,
        );
        try {
          TextLibraryService.registerUserBooks([...baseBooks(), ...loaded]);
        } catch {
          // 注册失败不阻断队列
        }
      } else {
        console.warn(`[UserBookService] 超大书解析失败：${t.name}`);
      }
    } catch (e) {
      console.warn(`[UserBookService] 超大书装载异常 ${t.name}:`, (e as Error)?.message ?? e);
    }
  }
  return loaded;
}

/**
 * 装载全部书籍并注册进 TextLibraryService（App 启动/书架刷新时调用）。
 * 流程：元数据注册（每进程一次，纯内存）→ 确保文件夹 → 物化内置书 →
 * 扫描顶层文件增量同步（用户书）→ 遗留书装载 → 整体注册用户书。
 * 任一文件系统步骤失败均降级为「仅装载 db 内已有书籍」，不阻断书架
 * 可用性。超大文件转入后台队列解析（不阻塞启动）。
 *
 * 按需装载（性能）：启动只注册内置书目录元数据（<1MB，77 部卡片 +
 * 章节目录即刻完整可见），37MB 正文完全不进启动路径——打开书时经
 * ensureBookLoaded 单本水合（LRU 上限内常驻）。内置书历史 db 解析
 * 缓存行顺带清理（正源在资产/文件，db 不再有 37MB JSON）。
 */
export async function loadAndRegisterAll(): Promise<ServiceResult<LibrarySyncSummary>> {
  // let：db 损坏自愈重建后需替换为新鲜连接（旧连接所有查询报 disk I/O error）
  let instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }

  let summary: LibrarySyncSummary = {
    folderBooks: 0,
    builtinBooks: 0,
    imported: 0,
    updated: 0,
    removed: 0,
    legacyBooks: 0,
  };
  const folderBooks: Book[] = [];
  const legacyBooks: Book[] = [];
  const oversizedTasks: OversizedTask[] = [];
  let scanOk = false;
  // 扫描链路中途异常（跳进外层兜底 catch）时经诊断暴露（scanInterrupted）。
  // 元数据注册在扫描前已完成且与扫描解耦，扫描异常只影响用户书增量。

  lastSyncDiagnostics = emptySyncDiagnostics();

  try {
    loadHiddenBuiltins();
    applySuppression();
    // 元数据注册（每进程一次）：书架即刻完整可见（目录含章节列表），
    // 全文按需水合。注册是纯内存操作（目录 <1MB），不依赖文件系统。
    registerBuiltinMetaOnce();
    await ensureDirs();
    lastSyncDiagnostics.assetCopyFailures = await materializeBuiltins();
  } catch {
    // 文件夹不可用（极端机型）：降级为仅装载 db，书架仍可用
    console.warn('[UserBookService] 书籍文件夹初始化失败，降级为 db 装载');
  }

  try {
    // 全量读 user_books：区分遗留书（无 source_path）与文件夹书（有 source_path）。
    // 查询本身加保护：极端情况（旧库结构异常等）下退化为仅读 data 列，
    // 绝不让查询异常上抛中断整轮装载。
    let rows: Array<{
      id: string;
      title: string;
      author: string;
      data: string;
      source_path: string | null;
      file_sig: string | null;
      content_hash: string | null;
      created_at: number;
    }> = [];
    try {
      const allRes = instance.execute(
        'SELECT id, title, author, data, source_path, file_sig, content_hash, created_at FROM user_books ORDER BY created_at DESC',
      );
      rows = (allRes.rows?._array ?? []) as typeof rows;
    } catch (e) {
      console.warn('[UserBookService] user_books 全量查询失败:', (e as Error)?.message ?? e);
      // 损坏 db 自愈（真机：SQL execution error: disk I/O error）：删库重建
      // 后重试一次。user_books 为纯缓存表，重建不丢任何用户资产。
      const repaired = repairUserBooksDb();
      if (repaired) {
        instance = repaired;
        try {
          const retryRes = instance.execute(
            'SELECT id, title, author, data, source_path, file_sig, content_hash, created_at FROM user_books ORDER BY created_at DESC',
          );
          rows = (retryRes.rows?._array ?? []) as typeof rows;
        } catch (e1) {
          console.warn('[UserBookService] 重建后重试仍失败:', (e1 as Error)?.message ?? e1);
        }
      }
      if (rows.length === 0) {
        // 仍不可用：退化为仅读 data 列（旧库/异常库尽量显示书籍）
        try {
          const fbRes = instance.execute('SELECT data FROM user_books ORDER BY created_at DESC');
          rows = ((fbRes.rows?._array ?? []) as Array<{ data: string }>).map((r) => ({
            id: '',
            title: '',
            author: '',
            data: r.data,
            source_path: null,
            file_sig: null,
            content_hash: null,
            created_at: 0,
          }));
        } catch (e2) {
          console.warn('[UserBookService] user_books 降级查询亦失败:', (e2 as Error)?.message ?? e2);
          rows = [];
        }
      }
    }
    type Row = (typeof rows)[number];
    const folderRows = rows.filter((r) => !!r.source_path);
    const folderRowsByPath = new Map<string, Row>(
      folderRows.map((r) => [r.source_path as string, r]),
    );

    // 1) 扫描：根目录顶层文件（用户书）。扫描失败（readDir 抛错）时
    // scanOk=false：跳过本轮扫描与下架比对，绝不把「读不到目录」当
    // 「文件夹为空」——否则一次瞬时 IO 故障就会误删全部已导入书籍
    //（BugFix：导入书重启后消失）。
    // 内置书不在此扫描：由下方目录清单驱动装载（db 缓存 → 文件 → assets
    // 三级来源），与文件系统扫描成败彻底解耦。
    const files: Array<{
      name: string;
      path: string;
      isFile: () => boolean;
    }> = [];
    try {
      const entries = await RNFS.readDir(getBooksRootPath());
      for (const e of entries) {
        const isFile = typeof e.isFile === 'function' ? e.isFile() : !e.isDirectory?.();
        if (isFile && isSupportedBookFile(e.name)) {
          files.push(e as { name: string; path: string; isFile: () => boolean });
        }
      }
      scanOk = true;
    } catch {
      scanOk = false;
    }

    if (scanOk) {
      const seenPaths = new Set<string>();
      for (const f of files) {
        seenPaths.add(f.path);
        try {
          const row = folderRowsByPath.get(f.path);
          const stat = await RNFS.stat(f.path);
          const size = Number(stat.size);
          const mtimeMs = stat.mtime ? new Date(stat.mtime).getTime() : 0;
          const sig = `${Number.isFinite(mtimeMs) ? mtimeMs : 0}:${Number.isFinite(size) ? size : 0}`;
          // 超大文件（如数百 MB epub）：绝不阻塞启动装载——转后台队列
          // 解析（完成后自动重注册上架）；磁盘缓存命中则队列直接读缓存
          if (size > OVERSIZED_RAW_BYTES) {
            oversizedTasks.push({
              path: f.path,
              name: f.name,
              sig,
              cachePath: `${f.path}${OVERSIZED_CACHE_SUFFIX}`,
            });
            continue;
          }
          if (row && row.file_sig === sig) {
            // 指纹未变：复用 db 解析结果，零解析开销
            try {
              const cached = JSON.parse(row.data) as Book;
              if (cached && cached.id && Array.isArray(cached.chapters)) {
                folderBooks.push(cached);
                continue;
              }
            } catch {
              // 缓存损坏则走重新解析
            }
          }
          const id = row && row.id.startsWith('user-') ? row.id : stableBookIdFromPath(f.name);
          const parsed = await parseBookFile(f.path, f.name, id);
          if (!parsed) {
            continue;
          }
          if (row) {
            summary.updated += 1;
          } else {
            summary.imported += 1;
          }
          try {
            const cacheJson = JSON.stringify(parsed.book);
            // 超限大书不进 db（防 db 损坏与装载内存爆炸）：本会话内存可用，
            // 下轮启动重新解析。content_hash 顺带回填（导入查重用）
            if (cacheJson.length <= MAX_CACHE_JSON_CHARS) {
              instance.execute(
                'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at, source_path, file_sig, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                  parsed.book.id,
                  parsed.book.title,
                  parsed.book.author,
                  cacheJson,
                  row ? row.created_at : Date.now(),
                  parsed.sourcePath,
                  parsed.fileSig,
                  parsed.contentHash,
                ],
              );
            }
          } catch {
            // 持久化失败仍注册进内存（本会话可读，下次启动重解析）
          }
          folderBooks.push(parsed.book);
        } catch (e) {
          // 单文件 stat/IO 异常只跳过该文件：绝不中断整轮扫描
          //（否则异常上抛会跳进外层降级分支，殃及内置书注册）。
          console.warn(`[UserBookService] 用户书扫描失败 ${f.name}:`, (e as Error)?.message ?? e);
          continue;
        }
      }

      // 1b) 内置书装载不在扫描分支内：见下方目录清单驱动装载（与 scanOk 解耦）

      // 2) 下架：db 中有 source_path 但扫描未见的书（文件被用户移走/删除）。
      // 仅在扫描成功时执行（scanOk=false 时保留全部书籍，下轮再比对）。
      // 内置书（目录清单 id）绝不参与下架：其生命周期由物化补写/抑制表管理，
      // 文件暂缺（builtin 目录读取失败/复制未完成）时若在此删除 db 行并级联
      // 清理，用户的背诵/收藏/笔记会永久丢失（真机「内置书全部消失且数据
      // 无法找回」的第二根因）。
      for (const row of folderRows) {
        if (!seenPaths.has(row.source_path as string)) {
          try {
            if (getBuiltinSpec(row.id)) {
              continue;
            }
            summary.removed += 1;
            try {
              instance.execute('DELETE FROM user_books WHERE id = ?', [row.id]);
            } catch {
              // 下次启动会再次尝试清理
            }
            StorageService.deleteFtsForBook(row.id);
            cascadeCleanupAfterDelete(row.id);
          } catch (e) {
            // 单行下架失败只跳过该行：绝不中断整轮装载
            console.warn(`[UserBookService] 下架清理失败 ${row.id}:`, (e as Error)?.message ?? e);
          }
        }
      }
    }

    // 2) 内置书 db 解析缓存瘦身（幂等迁移，每次执行代价 77 条 UPDATE，
    // 已瘦身的行零代价）：按需装载架构下内置书全文 JSON 不再需要
    // （37MB JSON 曾是启动 SELECT/反解的大头），但行本身保留——
    // file_sig/content_hash 供导入查重（与内置书同内容的文件拒绝导入）。
    // builtin id 不会与用户书（user- 前缀）冲突；书的正源是随包资产 +
    // builtin/ 文件，打开时经 ensureBookLoaded 按书装载。
    for (const spec of BUILTIN_CATALOG) {
      try {
        instance.execute('UPDATE user_books SET data = ? WHERE id = ?', ['', spec.id]);
      } catch {
        // 单条清理失败不影响其余书（旧行仅在下轮再瘦身）
      }
    }
    summary.builtinBooks = BUILTIN_CATALOG.length - hiddenBuiltins.size;

    // 3) 遗留书装载（应用内管理，不参与扫描/下架）
    for (const row of rows) {
      if (row.source_path) {
        continue;
      }
      try {
        const parsedLegacy = JSON.parse(row.data) as Book;
        if (parsedLegacy && parsedLegacy.id && Array.isArray(parsedLegacy.chapters)) {
          legacyBooks.push(parsedLegacy);
        }
      } catch {
        // 单条损坏数据跳过，不影响其他书籍
      }
    }
    summary.folderBooks = folderBooks.length;
    summary.legacyBooks = legacyBooks.length;
  } catch (e) {
    // 扫描链路失败：降级为旧行为（仅装载 db 全量），保证书架可用。
    // 若 scanOk 已置 true（扫描进行到一半才抛错），标记 scanInterrupted：
    // 内置书注册保持上一轮结果，绝不用残缺的 builtinLoaded 整体替换。
    // 逐段隔离后此分支理论上不可达，保留为最后防线；错误信息进诊断
    // （书架页脚直显），真机问题不再无从下手。
    lastSyncDiagnostics.scanInterrupted = true;
    lastSyncDiagnostics.scanInterruptedReason = (e as Error)?.message ?? String(e);
    console.warn(
      '[UserBookService] 扫描链路异常，降级为 db 装载（本轮不更新内置书注册）:',
      lastSyncDiagnostics.scanInterruptedReason,
    );
    try {
      const fallbackRes = instance.execute(
        'SELECT data FROM user_books ORDER BY created_at DESC',
      );
      const rows = (fallbackRes.rows?._array ?? []) as Array<{ data: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Book;
          if (parsed && parsed.id && Array.isArray(parsed.chapters)) {
            folderBooks.push(parsed);
          }
        } catch {
          // 跳过损坏行
        }
      }
      summary = {
        folderBooks: folderBooks.length,
        builtinBooks: 0,
        imported: 0,
        updated: 0,
        removed: 0,
        legacyBooks: 0,
      };
    } catch (e2) {
      return { success: false, error: `加载用户书籍失败：${(e2 as Error).message}` };
    }
  }

  lastSyncDiagnostics.builtinParseFailures = [];

  const reg = TextLibraryService.registerUserBooks([...folderBooks, ...legacyBooks]);
  if (!reg.success) {
    return { success: false, error: reg.error ?? '注册用户书籍失败' };
  }
  // loadedBooks 仅含用户书（备份快照口径；内置书在目录清单/资产，不入备份）
  loadedBooks = [...folderBooks, ...legacyBooks];

  // 超大书后台队列：本次装载立即返回（书架立即可用），队列逐本解析、
  // 完成一本注册一本（书架下次刷新即可见）。运行中的队列不重复排队
  //（防书架刷新并发触发多队列重复解析同一批文件）。
  if (oversizedTasks.length > 0 && !oversizedQueueRunning) {
    oversizedQueueRunning = true;
    console.warn(
      `[UserBookService] 超大书 ${oversizedTasks.length} 本转入后台装载（不阻塞书架）`,
    );
    void processOversizedBooks(oversizedTasks, () => [...folderBooks, ...legacyBooks])
      .then((deferred) => {
        if (deferred.length > 0) {
          // 合入备份快照/管理页口径
          loadedBooks = [...loadedBooks, ...deferred];
        }
      })
      .catch(() => undefined)
      .finally(() => {
        oversizedQueueRunning = false;
      });
    lastSyncDiagnostics.oversizedPending = oversizedTasks.length;
  }
  // 内置书 FTS 后台索引：全文搜索主路径走 segments_fts，启动后空闲期
  // 逐书补索引（幂等增量），与内存装载彻底解耦。
  if (builtinFtsAutoSchedule) {
    scheduleBuiltinFtsIndexBuild();
  }
  return { success: true, data: summary };
}

/** 判定是否用户上传书籍（按 ID 前缀） */
export function isUserBook(id: string): boolean {
  return TextLibraryService.isUserBook(id);
}

/** 获取全部已装载用户书的内存快照（浅拷贝数组，防调用方误改内部列表）。
 * 供备份导出（buildBackup 快照采集）与管理页展示使用；App 启动时
 * loadAndRegisterAll 已全量装载，此后 importBook/deleteBook 增量维护，
 * 故该列表始终与 db 一致，无需再查库。 */
export function getAllBooks(): Book[] {
  return [...loadedBooks];
}

// ============ 备份恢复（P2-15 补全） ============

/** 用户书恢复结果统计 */
export interface UserBooksRestoreResult {
  /** 成功恢复（持久化 + 注册 + 入 FTS）的书本数 */
  restored: number;
  /** 非法条目静默跳过的数量（与五类 restoreFromBackup 的跳过惯例一致） */
  skipped: number;
}

/**
 * 备份条目 → Book 的最小校验与收窄（非法返回 null，由调用方跳过）。
 * 校验口径与 loadAndRegisterAll 一致：id 非空且为用户书前缀、chapters 为数组；
 * title/author/description 缺失或类型不符时补默认值（宁可降级也不丢书）。
 */
function normalizeRestoredBook(entry: unknown): Book | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const b = entry as Record<string, unknown>;
  if (typeof b.id !== 'string' || b.id === '' || !isUserBook(b.id)) {
    return null;
  }
  if (!Array.isArray(b.chapters)) {
    return null;
  }
  return {
    id: b.id,
    title: typeof b.title === 'string' && b.title !== '' ? b.title : '未命名书籍',
    author: typeof b.author === 'string' ? b.author : '佚名',
    category: 'user',
    description: typeof b.description === 'string' ? b.description : '',
    chapters: b.chapters as Book['chapters'],
  };
}

/**
 * 从备份数据恢复用户书（P2-15 补全）。
 *
 * 恢复语义为「合并」（只增改不删），与五类数据的「整体替换」不同——
 * 取舍说明：设置/背诵等五类由 App 自身产生，覆盖即可完整重建状态；
 * 用户书是用户的导入劳动成果（原始文件可能已不在手上），若按替换语义
 * 删除「设备上有而备份中没有」的书，将造成不可再生的数据损失，故恢复
 * 只按 id 幂等覆盖备份中存在的书，设备独有的书原样保留。
 *
 * 对备份中每本合法书依次：持久化（INSERT OR REPLACE，同 id 幂等覆盖）→
 * 注册进 TextLibraryService（整体重注册，内存列表与 db 收敛一致）→
 * upsertFtsForBook 同步入搜索索引（失败吞错降级，与导入同口径，
 * 冷启动 ensureFtsIndex 会兜底补齐）。
 *
 * 书架刷新不在此处做（UserBookService 被 useLibraryStore 依赖，
 * 反向引用会成环），由 UI 层恢复完成后调 useLibraryStore.loadBooks()。
 */
export async function restoreUserBooks(
  raw: unknown,
): Promise<ServiceResult<UserBooksRestoreResult>> {
  if (!Array.isArray(raw)) {
    return { success: false, error: '恢复数据格式不正确：userBooks 应为数组' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }

  const restoredBooks: Book[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const book = normalizeRestoredBook(entry);
    if (!book) {
      skipped += 1;
      continue;
    }
    try {
      // 同 id 幂等覆盖；created_at 取恢复时刻（书架按 created_at 排序，
      // 恢复书排在最近，与「刚导入了书」的用户直觉一致）
      const cacheJson = JSON.stringify(book);
      if (cacheJson.length <= MAX_CACHE_JSON_CHARS) {
        instance.execute(
          'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at) VALUES (?, ?, ?, ?, ?)',
          [book.id, book.title, book.author, cacheJson, Date.now()],
        );
      } else {
        // 超限大书不进 db（防 db 损坏）：本会话内存可读，冷启动后不保留
        console.warn(`[UserBookService] 恢复书超缓存上限，仅本会话内存可读：${book.title}`);
      }
    } catch (e) {
      return { success: false, error: `恢复书籍失败：${(e as Error).message}` };
    }
    restoredBooks.push(book);
  }

  // 注册：备份中的书按 id 覆盖内存列表同 id 书，设备独有的书保留（合并语义）
  const byId = new Map<string, Book>();
  for (const b of loadedBooks) {
    byId.set(b.id, b);
  }
  for (const b of restoredBooks) {
    byId.set(b.id, b);
  }
  const next = Array.from(byId.values());
  const reg = TextLibraryService.registerUserBooks(next);
  if (!reg.success) {
    return { success: false, error: reg.error };
  }
  loadedBooks = next;

  // FTS 同步：恢复的书重新入索引（失败吞错降级，与 importBook 同口径）
  for (const b of restoredBooks) {
    StorageService.upsertFtsForBook(b);
  }

  return { success: true, data: { restored: restoredBooks.length, skipped } };
}

/** 在书籍根目录内生成不冲突的目标文件名（重名追加时间戳） */
async function uniqueDestName(root: string, fileName: string): Promise<string> {
  let name = fileName;
  try {
    if (await RNFS.exists(`${root}/${name}`)) {
      const dot = fileName.lastIndexOf('.');
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      name = `${stem}-${Date.now().toString(36)}${ext}`;
    }
  } catch {
    // exists 失败按原名处理（copyFile 失败会报错给调用方）
  }
  return name;
}

/**
 * 导入一本书：选文件 → 复制进书籍文件夹 → 解析 → 持久化（含 source_path/
 * file_sig）→ 注册 → FTS 入索引。复制后书籍文件与手动放入文件夹的文件
 * 完全同构（同一稳定 ID 规则、同一扫描/删除语义）。不限文件大小。
 */
export async function importBook(
  picked?: PickedBookFile,
): Promise<ServiceResult<Book>> {
  const pickRes = picked ? { success: true, data: picked } : await pickBookFile();
  if (!pickRes.success || !pickRes.data) {
    return { success: false, error: pickRes.error ?? '已取消选择文件' };
  }
  const file = pickRes.data;
  const ext = file.fileName.split('.').pop()?.toLowerCase() ?? 'txt';
  if (ext && !BOOK_EXTENSIONS.includes(ext)) {
    return {
      success: false,
      error: `暂不支持 .${ext} 格式，支持：${BOOK_EXTENSIONS.join(' / ')}`,
    };
  }

  const root = getBooksRootPath();
  let destPath = '';
  try {
    await ensureDirs();
    const destName = await uniqueDestName(root, file.fileName);
    destPath = `${root}/${destName}`;
    await RNFS.copyFile(toLocalPath(file.uri), destPath);
  } catch (e) {
    return { success: false, error: `复制文件到书籍文件夹失败：${(e as Error).message}` };
  }

  const fileNameInFolder = destPath.split('/').pop() ?? file.fileName;
  const id = stableBookIdFromPath(fileNameInFolder);

  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }

  const parsed = await parseBookFile(destPath, fileNameInFolder, id);
  if (!parsed) {
    // 解析失败不残留半截文件（已复制但无有效内容）
    try {
      await RNFS.unlink(destPath);
    } catch {
      // 清理失败不影响结果
    }
    return { success: false, error: '未解析出任何内容（文件可能为空或格式损坏）' };
  }

  // 内容去重：与路径/文件名无关——同一本书（内容相同，含改名/换目录/
  // 与内置书同内容）已在书架即拒绝导入。签名由解析顺带产出（零额外读取）；
  // 解析失败/签名缺失时放行导入，不因查重故障阻断正常功能。
  if (parsed.contentHash) {
    const dupId = await findDuplicateBook(
      instance,
      parsed.contentHash,
      sizeFromFileSig(parsed.fileSig),
    );
    // 同 id 豁免：同名文件（stableBookId 相同）= 幂等覆盖（重导/半截修复
    // 场景）；不同 id 的同内容书才判定为重复（改名/换目录再导入）。
    if (dupId && dupId !== id) {
      try {
        await RNFS.unlink(destPath);
      } catch {
        // 清理失败不影响结果
      }
      const dupTitle = TextLibraryService.getBook(dupId).data?.title ?? dupId;
      return {
        success: false,
        error: `书架已有内容相同的书：《${dupTitle}》，同一本书无需重复导入`,
      };
    }
  }

  try {
    const cacheJson = JSON.stringify(parsed.book);
    if (cacheJson.length <= MAX_CACHE_JSON_CHARS) {
      instance.execute(
        'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at, source_path, file_sig, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          parsed.book.id,
          parsed.book.title,
          parsed.book.author,
          cacheJson,
          Date.now(),
          parsed.sourcePath,
          parsed.fileSig,
          parsed.contentHash,
        ],
      );
    } else {
      // 超限大书不进 db（防 db 损坏与装载内存爆炸）：本会话内存可用，
      // 下轮启动重新解析
      instance.execute(
        'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at, source_path, file_sig) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          parsed.book.id,
          parsed.book.title,
          parsed.book.author,
          cacheJson,
          Date.now(),
          parsed.sourcePath,
          parsed.fileSig,
        ],
      );
    }
  } catch (e) {
    return { success: false, error: `保存书籍失败：${(e as Error).message}` };
  }

  const next = [parsed.book, ...loadedBooks.filter((b) => b.id !== parsed.book.id)];
  const reg = TextLibraryService.registerUserBooks(next);
  if (!reg.success) {
    return { success: false, error: reg.error };
  }
  loadedBooks = next;
  // FTS 同步入索引——导入后本会话立即可搜；写入失败不阻断导入
  // （下次冷启动 ensureFtsIndex 增量构建会补齐）。
  StorageService.upsertFtsForBook(parsed.book);
  return { success: true, data: parsed.book };
}

/**
 * 删书后的级联清理（BugFix 孤儿数据）。
 * 依据：makeUserBookId 基于时间戳，重导入同一文件会得到新 bookId，
 * 残留的用户数据永远无法重新挂接到书，属永久死数据：
 *   - 背诵进度：继续计入成就（recite-、coverage-、streak- 系列）与学习统计，
 *     「已在 X 部书中留下足迹」会包含已删书；
 *   - 收藏/笔记：列表页出现指向已删书的死条目（note-* 成就计数虚高）；
 *   - 续读位置：书架「继续阅读」点进已删书会加载失败。
 * 划线（highlights）刻意不清理：阅读页本就按段落渲染，删书后划线自然
 * 不再显示，且划线条目在收藏场景无独立展示页，清理收益低——若后续
 * 出现划线聚合展示页，再随该需求一并清理。
 * 容错：书已删除成功，各步清理失败仅记日志、不阻断删除主结果
 * （与 FTS 清理同策略；冷启动后各数据域加载自库中，无更差后果）。
 * 成就 recompute 幂等，残留计数会在下次触发（App 启动/背诵完成）自动回落。
 */
function cascadeCleanupAfterDelete(id: string): void {
  const steps: Array<[string, () => void]> = [
    ['背诵进度', () => useRecitationStore.getState().removeProgressByBook(id)],
    ['收藏', () => useBookmarkStore.getState().removeByBook(id)],
    ['笔记', () => useNoteStore.getState().removeByBook(id)],
    ['续读位置', () => useReaderStore.getState().clearLastReadForBook(id)],
  ];
  for (const [label, run] of steps) {
    try {
      run();
    } catch (e) {
      console.warn(
        `删书级联清理失败（${label}，不影响删除结果）：${(e as Error).message}`,
      );
    }
  }
}

/** 抑制（删除）一本内置书：db 记录 + 内存集合 + 同步文本库 */
function addHiddenBuiltin(id: string): void {
  hiddenBuiltins.add(id);
  const instance = getDb();
  if (instance) {
    try {
      instance.execute(
        'INSERT OR REPLACE INTO builtin_hidden (id) VALUES (?)',
        [id],
      );
    } catch {
      // 内存生效即可，持久化失败下次启动会复活（自愈可接受）
    }
  }
  applySuppression();
}

/**
 * 恢复内置书籍：清空全部抑制记录 + 补写缺失的 builtin/ 资源文件。
 * 供书架「恢复内置书籍」入口调用；返回恢复后的内置书总数。
 */
export async function restoreBuiltinBooks(): Promise<ServiceResult<number>> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }
  try {
    instance.execute('DELETE FROM builtin_hidden');
  } catch (e) {
    return { success: false, error: `恢复内置书籍失败：${(e as Error).message}` };
  }
  hiddenBuiltins = new Set();
  applySuppression();
  try {
    await ensureDirs();
    const failures = await materializeBuiltins();
    if (failures.length > 0) {
      // 复制失败的书这次恢复不完整：返回实际落盘数量，让 UI 如实提示
      const builtinDir = getBuiltinDirPath();
      let restored = 0;
      for (const spec of BUILTIN_CATALOG) {
        // eslint-disable-next-line no-await-in-loop
        if (await RNFS.exists(`${builtinDir}/${spec.id}.txt`)) {
          restored += 1;
        }
      }
      return { success: true, data: restored };
    }
  } catch {
    // 文件补写失败不阻断（下轮启动自愈重试）
  }
  return { success: true, data: BUILTIN_CATALOG.length };
}

/**
 * 删除一本书（所有书籍均可删，含内置书）。
 *   - 内置书：删除 builtin/ 资源文件 + 写抑制记录（防止下次启动复活）+
 *     FTS 清索引 + 级联清理；「恢复内置书籍」可整体找回（学习数据不找回）。
 *   - 文件夹书：删除源文件（用户放入的文件本体一并移除）+ 删 db 行 +
 *     FTS 清索引 + 级联清理。
 *   - 遗留书（文件夹化前导入）：删 db 行 + FTS + 级联清理（无源文件）。
 */
export async function deleteBook(id: string): Promise<ServiceResult<null>> {
  // 内置书分支：目录命中即内置书（ID 不带 user- 前缀）
  if (getBuiltinSpec(id)) {
    addHiddenBuiltin(id);
    try {
      const path = `${getBuiltinDirPath()}/${id}.txt`;
      if (await RNFS.exists(path)) {
        await RNFS.unlink(path);
      }
    } catch {
      // 文件删除失败不阻断（抑制记录已防复活；残留文件下次启动被自愈逻辑忽略）
    }
    // 解析缓存行一并删除（内置书现与用户书同表缓存）
    const instance = getDb();
    if (instance) {
      try {
        instance.execute('DELETE FROM user_books WHERE id = ?', [id]);
      } catch {
        // 抑制已生效，残留行下次启动下架逻辑兜底
      }
    }
    StorageService.deleteFtsForBook(id);
    cascadeCleanupAfterDelete(id);
    return { success: true, data: null };
  }

  if (!isUserBook(id)) {
    return { success: false, error: '书籍不存在' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }
  // 先查源文件路径（删行后就查不到了）
  let sourcePath: string | null = null;
  try {
    const res = instance.execute(
      'SELECT source_path FROM user_books WHERE id = ?',
      [id],
    );
    const row = (res.rows?._array ?? [])[0] as { source_path: string | null } | undefined;
    sourcePath = row?.source_path ?? null;
  } catch {
    sourcePath = null;
  }
  try {
    instance.execute('DELETE FROM user_books WHERE id = ?', [id]);
  } catch (e) {
    return { success: false, error: `删除失败：${(e as Error).message}` };
  }
  // 文件夹书：源文件一并删除（「所有书籍均可供用户自由删除」的文件级语义）
  const oversizedFiles = oversizedBookFiles.get(id);
  if (sourcePath || oversizedFiles) {
    try {
      if (sourcePath && (await RNFS.exists(sourcePath))) {
        await RNFS.unlink(sourcePath);
      }
      if (oversizedFiles) {
        // 超大书：源文件 + 磁盘解析缓存一并清理（不落 db，位置在内存登记）
        if (await RNFS.exists(oversizedFiles.path)) {
          await RNFS.unlink(oversizedFiles.path);
        }
        if (await RNFS.exists(oversizedFiles.cachePath)) {
          await RNFS.unlink(oversizedFiles.cachePath);
        }
        oversizedBookFiles.delete(id);
      } else {
        // 常规书的磁盘解析缓存（如有）一并清理
        const cachePath = `${sourcePath}${OVERSIZED_CACHE_SUFFIX}`;
        if (await RNFS.exists(cachePath)) {
          await RNFS.unlink(cachePath);
        }
      }
    } catch {
      // 文件删除失败不阻断书架移除；残留文件下次启动会重新上架
    }
  }
  const next = loadedBooks.filter((b) => b.id !== id);
  const reg = TextLibraryService.registerUserBooks(next);
  if (!reg.success) {
    return { success: false, error: reg.error };
  }
  loadedBooks = next;
  // FTS 同步清索引——失败不阻断删除结果：书已不在文本库中，
  // 下次冷启动 ensureFtsIndex 的死索引自愈会兜底清除。
  StorageService.deleteFtsForBook(id);
  // 级联清理孤儿用户数据（背诵进度/收藏/笔记/续读位置），详见 cascadeCleanupAfterDelete。
  cascadeCleanupAfterDelete(id);
  return { success: true, data: null };
}

/** 导出 db 文件名（调试/管理页用） */
export const USER_BOOKS_DB_FILE = USER_BOOKS_DB;

/** 聚合导出（供 store / 屏幕以 UserBookService.xxx 调用） */
export const UserBookService = {
  pickBookFile,
  readFileBytes,
  readTextFile,
  parseTxtBook,
  makeUserBookId,
  stableBookIdFromPath,
  loadAndRegisterAll,
  ensureBookLoaded,
  ensureBookReady,
  onBuiltinFillProgress,
  scheduleBuiltinFtsIndexBuild,
  isUserBook,
  getAllBooks,
  restoreBuiltinBooks,
  importBook,
  deleteBook,
  restoreUserBooks,
  getLibrarySyncDiagnostics,
  getBooksRootPath,
  getBuiltinDirPath,
  bookToMarkerText,
};

export default UserBookService;
