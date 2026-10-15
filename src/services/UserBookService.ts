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
import * as DocumentPicker from '@react-native-documents/picker';
import { isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import RNFS from 'react-native-fs';
import { open } from '@/services/sqliteClient';
import type { Book, ServiceResult } from '@/types';
import { getBuiltinSpec, BUILTIN_CATALOG, type BuiltinBookSpec } from '@/data/builtinCatalog';
import {
  getParams as getTierParams,
  pickNumber as pickTierNumber,
  type TierParams,
} from '@/services/DeviceTierService';
import {
  AsmPriority,
  ChapterReadiness,
  R38_SCHEDULER_ENABLED,
  chapterAssemblyScheduler,
  registerAssemblyHost,
  type AsmExecContext,
  type AsmHost,
  type ChapterReadyEvent,
} from '@/services/ChapterAssemblyScheduler';
import { TextLibraryService } from '@/services/TextLibraryService';
import { buildTocFromBook, lineByteRanges, normalizeForCache, validateTocShape, type ChapterToc } from '@/services/chapterToc';
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
import {
  ASSEMBLY_YIELD_STARVE_MAX_MS,
  planAssemblyYield,
} from '@/utils/assemblyYield';

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
 * 【R2-3】FTS 队列**世代号**：`scheduleBuiltinFtsIndexBuild` 启动时自增并
 * 记住自己的世代；队列在书间检查点与暂停轮询处比对世代，不一致即**立即返回**。
 *
 * 存在的理由：队列是 77 本书的长循环（书间 200ms 让出 + 暂停轮询 250ms），
 * 一次启动会在启动它的用例结束后继续跑很久——它会 `console.info`，于是
 * jest 报「Cannot log after tests are done」并让 `--detectOpenHandles`
 * 退出码为 1（QA 实证 144 条）。世代号让 `__resetBuiltinLazyStateForTests()`
 * 能**确定性地取消**在飞队列（只清 `builtinFtsQueueRunning` 挡不住：那是
 * 「是否已有队列」的标记，不是取消信号；且新队列置 true 会让旧队列复活）。
 */
let ftsQueueGeneration = 0;
/**
 * FTS 队列「用户优先」门闩：在此之前的时间戳内队列不得开始解析新书。
 * 用户点卡片触发 ensureBookLoaded 水合时置位（+30s，每次水合刷新），
 * 解析完成后再续 10s 缓冲——用户水合后大概率继续翻页/点击，队列必须
 * 彻底让路。队列在书间检查点检查该标志；分片索引写入（chunked upsert）
 * 也在片间检查（水合/交互时挂起，解除后断点续写）；书内分片解析按章
 * 让出，tap 可在章间插队，无需中断整本。
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
 * JS 几乎不间断占用，tap 排队可达秒级。改为 200ms 硬下限；测试可注入
 * 短间隔（见 __setFtsQueueYieldForTests）。
 * （RN 0.83 迁移时起该下限由定时器独占，InteractionManager 竞速已移除，
 *   原因见 ftsInterBookYield 注释。）
 */
let ftsQueueYieldMs = 200;
/**
 * 分片索引写入进行中的书（bookId 集合）：填充完成顺带入索引（fire-and-forget）
 * 与 FTS 队列并发时互斥去重——INSERT OR REPLACE 虽幂等，但数百万字的书
 * 重复整本写入纯属浪费。队列书间检查点跳过在写的书，下轮启动兜底。
 */
const ftsUpsertInFlight = new Set<string>();
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
/**
 * 超大书纯文本缓存（.gxbook）分片读上限。
 * **不得复用 READ_CHUNK_LIMIT(4MB)**：RNFS 原生 readFile/read 只返回 base64，
 * UTF-8 解码在 JS 层完成（node_modules/react-native-fs/FS.common.js:164），
 * 真机速率 ≈1.15 MB/s（实测 12.78MB 单次读阻塞 JS 14.7s；仓内 meta 快路径
 * 注释记录「真机 9MB 级 readFile 单次阻塞 JS 11s+」，HEAD :2071-2072）。
 * 4MB 单片的同步解码仍达 ~4.6s，必须用更小分片把不可中断
 * 巨块切成 ≤~0.3s 的小块，使 tap/渲染可穿插。
 */
const OVERSIZED_READ_CHUNK_BYTES = 256 * 1024;
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
/**
 * 超大书解析结果磁盘缓存后缀（与源文件同目录；删除书时一并清理）。
 * 【T23c】由 '.gxcache' 改为 '.gxbook'：旧后缀存的是 JSON.stringify(parsed.book)
 * （数万章×百万段嵌套对象），读 JSON.parse / 写 JSON.stringify 同步占死 JS ≈32s
 * （真机 jsBlocked≈31419ms）。新后缀存「纯文本」（无 JSON 包裹）+ '.gxbook.meta'
 * 小信封，彻底消除该巨块。改后缀即自动无效化旧缓存（首启重解析，chunked 不阻塞）。
 */
const OVERSIZED_CACHE_SUFFIX = '.gxbook';
/** 旧版超大书缓存后缀（T23c 前），删除书时顺带清理避免占盘 */
const OVERSIZED_CACHE_LEGACY_SUFFIX = '.gxcache';
/** 超大书后台队列运行中标记（防并发装载重复排队解析同一批文件） */
let oversizedQueueRunning = false;
/** 超大书 id → 源文件/缓存文件位置（超大书不落 db，删除时按此清理文件） */
const oversizedBookFiles = new Map<string, { path: string; cachePath: string }>();

/**
 * 仅测试：登记超大书的缓存位置（等价于 `processOversizedBooks` 装载完成后的登记）。
 *
 * ⚠ 为什么需要这个注入口（不是「给判据开后门」）：
 *   `fillBuiltinChapterNow` 的用户书分支靠 `oversizedBookFiles` 找缓存路径，
 *   而该 Map 只在后台队列里被写 ⇒ 端到端判据无法在单测里触达该分支。
 *   与 `__resetAssemblyStateForTests` 同族惯例：**测试专用、生产不调用**。
 *   替代方案（让判据去驱动整个 `loadAndRegisterAll`）会把用例变成大而慢的集成测试，
 *   且失败时定位不到具体分支。
 */
export function __registerOversizedFileForTests(
  bookId: string,
  path: string,
  cachePath: string,
): void {
  oversizedBookFiles.set(bookId, { path, cachePath });
}

/**
 * 用户书集合变更监听（R2c 修复：超大书后台装载完成注册后通知 UI 层）。
 * 后台队列在书架渲染之后才完成注册——没有任何同步调用点会触发书架重拉，
 * 不通知则超大书在本次会话内永久不可见（真机实测复现）。
 */
const userBooksChangedListeners = new Set<() => void>();

/** 订阅用户书集合变更（UI 层刷新用）；返回退订函数 */
export function onUserBooksChanged(cb: () => void): () => void {
  userBooksChangedListeners.add(cb);
  return () => {
    userBooksChangedListeners.delete(cb);
  };
}

/** 广播用户书集合变更（异步注册写回成功后调用；单监听器异常不影响其余） */
export function notifyUserBooksChanged(): void {
  userBooksChangedListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      // 监听器异常不阻断广播
    }
  });
}

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
 * FTS 队列书间让出：只等 setTimeout 下限（ftsQueueYieldMs，默认 200ms）。
 *
 * ⚠ 迁移 RN 0.83 时移除 InteractionManager 竞速（真机 + 用例双重实证）：
 *  ① RN 0.83 起 `runAfterInteractions(task)` 的 task 是**必需**入参，无参调用
 *     被 reject TypeError「Invalid task of type: undefined」
 *     （react-native/Libraries/Interaction/InteractionManager.js）。该 thenable
 *     参与原先的 `Promise.race` ⇒ 未处理拒绝 ⇒ 真机 JS 致命崩溃
 *     （2026-10-08 实测：冷启 ~11s、daodejing FTS 装配期间进程被杀）。
 *  ② 仅补一个空任务只是「不崩」：RN 0.83 的 IM 已不再等交互（内部退化为
 *     setImmediate），它会**立即赢得竞速**，把 200ms 下限击穿成 0ms
 *     ——与让出目的相反（保真 IM 桩下既有用例实测书间隔 0ms 红）。
 *  ③ IM 自本版起被官方标记 deprecated（建议改 requestIdleCallback），
 *    且「等交互收尾」语义已不存在 ⇒ 改为由定时器下限独占。
 */
function ftsInterBookYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ftsQueueYieldMs);
    // 【R2-3/D7】纯让出定时器不得阻塞宿主退出（RN 无 unref → 可选调用）
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/** meta 快路径全本组装：逐章切片 → toParagraphs → segments。
 * chunked=true 时按时间片让出 JS（与整读分片解析同节奏）。
 * 任一章切片失败返回 null（调用方回退整读解析）。 */
async function assembleBuiltinFromMeta(
  spec: BuiltinBookSpec,
  meta: BuiltinMetaFile,
  yieldEnabled: boolean,
): Promise<Book | null> {
  const chapters: Book['chapters'] = [];
  let sliceStart = Date.now();
  for (let i = 0; i < meta.chapters.length; i += 1) {
    const c = meta.chapters[i];
    // eslint-disable-next-line no-await-in-loop
    const slice = await readBuiltinChapterRange(spec, c.s, c.e);
    if (slice === null) {
      return null;
    }
    const paras = toParagraphs(slice);
    chapters.push({
      id: c.id,
      bookId: spec.id,
      title: c.t,
      order: i + 1,
      segments: paras.map((p, idx) => ({
        id: `${c.id}-s${idx + 1}`,
        chapterId: c.id,
        order: idx + 1,
        text: p,
      })),
    });
    if (yieldEnabled && Date.now() - sliceStart >= FILL_TIME_BUDGET_MS) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToJs();
      sliceStart = Date.now();
    }
  }
  return assembleBuiltinBook(spec, chapters);
}

/** 单本内置书装载（builtin/ 文件解析 → APK assets 直读兜底），不含注册。
 * chunked 默认 true：水合与 FTS 队列两条路径都走分片解析（大书装配
 * 期间按章让出 JS，tap/动画可插队）。
 * 优先 meta 快路径：按章切片组装，全程零整读（真机 9MB readFile
 * 单次阻塞 JS 11s+ 的根治）。 */
async function loadBuiltinBookBody(
  spec: BuiltinBookSpec,
  chunked = true,
): Promise<ParsedFileBook | null> {
  const meta = await loadBuiltinMeta(spec);
  if (meta) {
    const book = await assembleBuiltinFromMeta(spec, meta, chunked);
    if (book) {
      return {
        book,
        sourcePath: `${getBuiltinDirPath()}/${spec.id}.txt`,
        fileSig: `${meta.sizeBytes}:meta`,
      };
    }
  }
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  let parsed = await parseBookFile(canonicalPath, `${spec.id}.txt`, spec.id, spec, chunked);
  if (!parsed) {
    parsed = await parseBuiltinFromAssets(spec, canonicalPath, chunked);
  }
  return parsed;
}

/** 指纹自愈：落盘文件与资产大小不一致先覆盖补写（物化时机之外的自愈）。
 * ensureBookLoaded / ensureBookReady 共用。返回落盘文件当前字节数（0=未知）。 */
async function ensureBuiltinAssetFresh(spec: BuiltinBookSpec): Promise<number> {
  if (typeof spec.sizeBytes !== 'number' || spec.sizeBytes <= 0) {
    return 0;
  }
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  try {
    // eslint-disable-next-line no-await-in-loop
    const st = await RNFS.stat(canonicalPath);
    const destSize = Number((st as { size?: number | string }).size ?? 0);
    if (destSize > 0 && destSize !== spec.sizeBytes) {
      // eslint-disable-next-line no-await-in-loop
      await RNFS.copyFileAssets(`books/${spec.id}.txt`, canonicalPath);
      return spec.sizeBytes;
    }
    return destSize;
  } catch {
    // stat 失败（文件缺失/IO 异常）交由读取路径兜底
    return 0;
  }
}

// ---------- 章节字节索引（meta 快路径，P0 根治大读阻塞） ----------
// 背景：真机上 RNFS.readFile 整读资治通鉴级 9.4MB 文本一次性阻塞 JS
// 11.2s+（点卡片无响应主因）。构建脚本随包产出 books/<id>.meta.json
// （每章正文 [s,e) UTF-8 字节区间，与运行时章序逐条对齐），运行时按章
// RNFS.read 定位切片读取（30KB/次，毫秒级），首开水合/后台填充/FTS 建
// 索引均不再整读全文。meta 缺失/损坏/sizeBytes 指纹不符时整体回退旧
// 整读扫描路径（兜底保留）。

/** books/<id>.meta.json 结构（scripts/build-builtin-assets.mjs 生成） */
interface BuiltinMetaFile {
  v: number;
  bookId: string;
  /** 对应 txt 的字节数（与落盘文件指纹比对，不符即资产换代/半截文件） */
  sizeBytes: number;
  /** 有正文章节（含「开篇」），id 与运行时 `${bookId}-c${order}` 逐条一致 */
  chapters: Array<{ id: string; t: string; s: number; e: number }>;
}

const builtinMetaCache = new Map<string, BuiltinMetaFile | null>();

/** 读取并校验章节字节索引（幂等缓存；null = 无 meta，走慢路径） */
async function loadBuiltinMeta(
  spec: BuiltinBookSpec,
): Promise<BuiltinMetaFile | null> {
  const cached = builtinMetaCache.get(spec.id);
  if (cached !== undefined) {
    return cached;
  }
  let result: BuiltinMetaFile | null = null;
  try {
    const raw = await RNFS.readFileAssets(
      `books/${spec.id}.meta.json`,
      'utf8',
    );
    const parsed = JSON.parse(raw) as BuiltinMetaFile;
    const ok =
      parsed &&
      parsed.v === 1 &&
      parsed.bookId === spec.id &&
      typeof parsed.sizeBytes === 'number' &&
      parsed.sizeBytes > 0 &&
      Array.isArray(parsed.chapters) &&
      parsed.chapters.length > 0 &&
      parsed.chapters.every(
        (c, i) =>
          typeof c.s === 'number' &&
          typeof c.e === 'number' &&
          c.s >= 0 &&
          c.e >= c.s &&
          c.e <= parsed.sizeBytes &&
          c.id === `${spec.id}-c${i + 1}`,
      );
    if (ok) {
      result = parsed;
    }
  } catch {
    // meta 缺失/损坏：慢路径兜底
  }
  builtinMetaCache.set(spec.id, result);
  return result;
}

/**
 * 用户书章字节目录（`.gxbook.toc`）读侧 —— 与 `loadBuiltinMeta` **同范式**的对偶。
 *
 * ★为什么不需要从零造通道（2026-10-13 勘察纠正）：
 *   此前结论「阻塞 A＝按需物化通道压根不存在，须从零新建」**是错的**。
 *   内置书的 meta 快路径（`loadBuiltinMeta` + `readFileSliceUtf8Safe`）**早就在跑**，
 *   且有 3 套判据锁着（含 `builtinSliceUtf8Boundary` UTF-8 边界专测）。
 *   用户书缺的只是：① toc 落盘（步骤 5 已做）②读盘闸门（本函数）③路径泛化（已做）。
 *
 * ★读侧**只做纯结构校验**（`validateTocShape`），绝不读正文来校验偏移——
 *   读正文就等于把本步要省的 6275ms 又花回去。偏移是否真与文本对得上，
 *   由生成端 `verifyTocAgainstText` 的 fail-fast 保证（写不出坏 toc）。
 *
 * @param cachePath 该书的 `.gxbook` 缓存路径（toc 落在 `<cachePath>.toc`）
 * @param bookId 期望书 id（校验条目归属，防别书的 toc 错挂）
 * @param expectedChapterCount 期望章数；≤0 表示不校验（调用方尚不知章数时）
 * @returns 合法 toc；缺失/损坏/不合法一律 `null`（调用方回退全量读，永远正确）
 */
async function loadUserBookToc(
  cachePath: string,
  bookId: string,
  expectedChapterCount: number,
): Promise<ChapterToc | null> {
  try {
    // eslint-disable-next-line no-await-in-loop
    const raw = await RNFS.readFile(`${cachePath}.toc`, 'utf8');
    const parsed = JSON.parse(raw) as ChapterToc;
    const reason = validateTocShape(parsed, bookId, expectedChapterCount);
    if (reason !== '') {
      console.info(
        `[UserBookService] .gxbook.toc 结构非法（回退全量读）：${bookId} reason=${reason}`,
      );
      return null;
    }
    return parsed;
  } catch {
    // toc 缺失/JSON 损坏：慢路径兜底（首次导入后尚未写 toc 的书属正常）
    return null;
  }
}

/**
 * 单片读取结果。
 * `text` = 该片文本；`consumed` = **实际消费的字节数**（≤ 请求量；尾部不完整
 * UTF-8 序列被裁掉时小于请求量，至多 -3）。调用方必须以 `consumed`（而非
 * 请求量）推进字节游标，否则会重复或跳过正文。
 */
export interface BuiltinChapterSliceRead {
  text: string;
  consumed: number;
}

/** 切片失败原因日志上限（去重后条数；防刷屏同时保留证据） */
const SLICE_FAIL_LOG_CAP = 12;
/** 已打印过的失败签名（`bookId@offset:reason`） */
const sliceFailLogged = new Set<string>();

/**
 * 【#20 探针】切片读失败原因（native/JS 的**原始 message**）。
 *
 * 背景（r34 血泪教训）：装配失败**禁止推理猜因**——必须把 reject 的 message
 * 打出来。本缺陷（资治通鉴跳多批章整页空白）正是「失败被吞成 null、无人知道
 * 为什么」拖了两轮才定位。故此处永久保留：失败是异常事件（正常路径零失败），
 * 按「书 + 起始偏移 + 原因」去重，同签名只打一次，全局封顶 SLICE_FAIL_LOG_CAP
 * 条 —— 既拿得到证据，也不会因某章持续失败刷屏。
 */
function logSliceReadFailure(
  bookId: string,
  offset: number,
  want: number,
  reason: string,
): void {
  if (sliceFailLogged.size >= SLICE_FAIL_LOG_CAP) {
    return;
  }
  const sig = `${bookId}@${offset}:${reason}`;
  if (sliceFailLogged.has(sig)) {
    return;
  }
  sliceFailLogged.add(sig);
  console.info(
    `[PERF][slice] ${bookId} off=${offset} want=${want} fail="${reason}" (${sliceFailLogged.size}/${SLICE_FAIL_LOG_CAP})`,
  );
}

/**
 * 最长「完整 UTF-8 字符前缀」的字节长度。
 *
 * 尾部不完整序列（lead 字节之后的 continuation 不足）与任何非法字节**一律不计入**，
 * 故 `decodeUtf8(bytes.subarray(0, 返回值))` 不会产出替换符，且调用方可自返回值
 * 处继续读——内容不丢、不重。
 */
export function utf8CompletePrefixLength(bytes: Uint8Array): number {
  const n = bytes.length;
  let i = 0;
  let complete = 0;
  while (i < n) {
    const b0 = bytes[i];
    let need: number;
    if (b0 < 0x80) {
      need = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 4;
    } else {
      break; // 非法 lead（0x80..0xC1 悬空 continuation / 0xF5..0xFF）：就此止步
    }
    if (i + need > n) {
      break; // ★ 尾部序列不完整（本缺陷的字节形态）：就此止步
    }
    let ok = true;
    for (let k = 1; k < need; k += 1) {
      if ((bytes[i + k] & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      break; // 非法 continuation：宁可少读一字节，绝不产出错字
    }
    i += need;
    complete = i;
  }
  return complete;
}

/**
 * 按字节区间切片读取章节正文（**UTF-8 边界对齐**）。
 *
 * ★ r41/#20 根因修复。
 *
 * 旧实现：`RNFS.read(path, e - s, s, 'utf8')` —— RNFS 的 JS 包装把 native
 * 返回的 base64 交给 `utf8.decode()`，而 `utf8@3` 是**严格**解码器：
 * 一旦 `e` 落在多字节字符中间（中文 3 字节字符 → 命中概率 ≈ 2/3），尾部
 * 不完整序列直接抛 `Error('Invalid byte index')`。本函数把异常吞成 null，
 * 上层只能判「读失败」。真机 + 资产实测（资治通鉴 294 章）：156 个 >32KB 的
 * 章里 **112 章（71.8%）** 首批 32KB 切片即命中 → 目标章首批零产出 →
 * `[PERF][asm] empty … bytes=… failed=true discard` → 永不就绪 →
 * 整页 ActivityIndicator 无限转圈（QA #19 缺陷根因）；且「章内偏移固定 ⇒
 * 每次都失败」，把间歇失败变成了**永久状态**，唯有杀进程（冷启动走整章直读
 * `hydrateBuiltinViaMeta`）能解；而 r37 灰度路径 `fillBuiltinChapterNow` 用
 * 64KB 批，同一章一次读完 → 成功（日志里同章 `[PERF][fill-now] paras=106`
 * 与 `[PERF][asm] empty … discard` 并存，正是两条链路**批大小不同**所致，
 * 不是并发冲突）。
 *
 * 修复策略（最小改动 + 双路径）：
 *  ① 主路径保持 `'utf8'` 单次 native read——落在字符边界上的批（约 28%）
 *     仍是一次读、零额外开销，也不改变既有测试约定的 mock 契约；
 *  ② **仅当** ① 抛错/非字符串时，回落一次 `'base64'` 读：JS 侧用
 *     `utf8CompletePrefixLength` 裁掉尾部不完整序列，再用**宽松**解码器
 *     `decodeUtf8`（U+FFFD 容错、绝不抛）解出前缀文本；
 *  ③ 返回 `consumed`：下一个切片自真正的字符边界开始（内容不丢不重，
 *     `cur.carry` 跨批残行防护逐字不变）。
 * 真 IO 失败（native reject / 文件缺失）在 ② 同样失败 → 仍返回 null，
 * 失败计数/退避/终态语义（R2-1/D1）完全不变。
 */
/**
 * ★通用版：按字节区间切片读取任意本地文件的正文（**UTF-8 边界对齐**）。
 *
 * 这是 r41/#20 根因修复的**真实现**，对内置书与用户书共用；`readBuiltinChapterSlice`
 * 只是「内置书路径 + 失败日志标签」的薄包装（其行为逐字不变，见该函数注释）。
 *
 * 为什么必须对齐 UTF-8 边界：旧实现 `RNFS.read(path, e - s, s, 'utf8')` 让 RNFS 的
 * JS 包装把 native 返回的 base64 交给 `utf8.decode()`，而 `utf8@3` 是**严格**解码器
 * —— 一旦 `e` 落在多字节字符中间（中文 3 字节字符 → 命中概率 ≈ 2/3），尾部不完整
 * 序列直接抛 `Error('Invalid byte index')`，上层只判「读失败」。真机 + 资产实测
 * （资治通鉴 294 章）：156 个 >32KB 的章里 **112 章（71.8%）** 首批 32KB 切片即命中
 * ⇒ 目标章首批零产出 ⇒ 永不就绪 ⇒ 整页转圈（QA #19 根因）。
 *
 * 双路径策略（最小改动）：
 *  ① 主路径 `'utf8'` 单次 native read——落在字符边界上的批恒成功，零额外开销；
 *  ② **仅当** ① 抛错/非字符串时，回落一次 `'base64'`：JS 侧用
 *     `utf8CompletePrefixLength` 裁掉尾部不完整序列，再用**宽松**解码器
 *     `decodeUtf8`（U+FFFD 容错、绝不抛）解出前缀文本；
 *  返回 `consumed` 让调用方自真正的字符边界续读（内容不丢不重）。
 *  真 IO 失败在 ② 同样失败 ⇒ 仍返回 null，失败语义不变。
 *
 * @param filePath 绝对/可读路径（调用方给定；本函数不做路径拼接）
 * @param tag 失败日志里的书标识（去重键的一部分）
 */
async function readFileSliceUtf8Safe(
  filePath: string,
  s: number,
  e: number,
  tag: string,
): Promise<BuiltinChapterSliceRead | null> {
  const want = e - s;
  if (want <= 0) {
    return { text: '', consumed: 0 };
  }
  // ① 快路径：native utf8 直解（尾部恰落在字符边界时恒成功）
  try {
    const text = await RNFS.read(filePath, want, s, 'utf8');
    if (typeof text === 'string') {
      return { text, consumed: want };
    }
    // 非字符串 = 桥接层没给出数据（真机 RNFS 只会 resolve(字符串) 或 reject）。
    // 此时不是「尾部截断」形态，重读一次 base64 也无济于事 → 直接判失败。
    logSliceReadFailure(tag, s, want, 'utf8-非字符串');
    return null;
  } catch (err) {
    // ★ 本缺陷的形态：utf8@3 严格解码在「切片尾部截断多字节字符」时抛
    //   `Invalid byte index`。把真实 message 打出来（禁止推理猜因），
    //   随后走 ② 的边界对齐回落。
    logSliceReadFailure(tag, s, want, (err as Error)?.message ?? String(err));
  }
  // ② 边界对齐回落：base64 原文 → 裁掉尾部不完整序列 → 宽松解码前缀
  try {
    const b64 = await RNFS.read(filePath, want, s, 'base64');
    if (typeof b64 !== 'string') {
      logSliceReadFailure(tag, s, want, 'base64-非字符串');
      return null;
    }
    const bytes = bytesFromBase64(b64);
    const consumed = utf8CompletePrefixLength(bytes);
    if (consumed <= 0) {
      logSliceReadFailure(tag, s, want, '无可解码的完整字符前缀');
      return null; // 连一个完整字符都拿不到 = 真失败（不得静默跳字节）
    }
    return { text: decodeUtf8(bytes.subarray(0, consumed)), consumed };
  } catch (err) {
    logSliceReadFailure(
      tag,
      s,
      want,
      (err as Error)?.message ?? String(err),
    );
    return null;
  }
}

/**
 * 按字节区间切片读取内置书章节正文。
 *
 * ⚠ 内置书专名包装：**行为与历史实现逐字一致**（保留其专属注释与调用点形状），
 *   真实现见 `readFileSliceUtf8Safe`（内置书/用户书共用）。
 */
async function readBuiltinChapterSlice(
  spec: BuiltinBookSpec,
  s: number,
  e: number,
): Promise<BuiltinChapterSliceRead | null> {
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  return readFileSliceUtf8Safe(canonicalPath, s, e, spec.id);
}

/**
 * 整章区间读取：必须完整消费 `[s, e)`，任一片失败即 null（调用方回退慢路径）。
 * 分片上限 READ_CHUNK_LIMIT（4MB，RNFS.read 建议值），与切片路径共用边界对齐
 * 逻辑——章尾落在章界（meta/toc 按章生成，恒为字符边界），故正常情况
 * 一次读完；即便资产异常也不会把「尾部截断」误判成读失败。
 *
 * ⚠ 内置书专名包装：真实现见 `readFileRangeUtf8Safe`（内置书/用户书共用）。
 */
async function readBuiltinChapterRange(
  spec: BuiltinBookSpec,
  s: number,
  e: number,
): Promise<string | null> {
  return readFileRangeUtf8Safe(
    `${getBuiltinDirPath()}/${spec.id}.txt`,
    s,
    e,
    spec.id,
  );
}

/** 任意本地文件的整章区间读取（见 `readBuiltinChapterRange` 的语义与分片上限）。 */
async function readFileRangeUtf8Safe(
  filePath: string,
  s: number,
  e: number,
  tag: string,
): Promise<string | null> {
  const total = e - s;
  if (total <= 0) {
    return null;
  }
  const parts: string[] = [];
  let pos = s;
  while (pos < e) {
    const want = Math.min(e - pos, READ_CHUNK_LIMIT);
    // eslint-disable-next-line no-await-in-loop
    const r = await readFileSliceUtf8Safe(filePath, pos, pos + want, tag);
    if (r === null) {
      return null;
    }
    parts.push(r.text);
    // consumed ≥ 1（consumed ≤ 0 已在切片函数内判失败）⇒ 循环必然推进
    pos += Math.max(1, Math.min(r.consumed, want));
  }
  return parts.join('');
}

/**
 * 通用「整文件文本分片读」：≤OVERSIZED_READ_CHUNK_BYTES 分片，片间让出 JS 线程。
 * 与 readBuiltinChapterSlice 的 ② 支同范式（base64 原文 → bytesFromBase64 →
 * 裁尾部不完整 UTF-8 序列 → 宽松解码），但路径可传任意本地文件，且强制分片。
 *
 * 为什么不能用 RNFS.readFile(path, 'utf8')：RNFS 原生 readFile 只 encodeToString
 * 成 base64 后 resolve（RNFSManager.java:223-234），'utf8' 解码发生在 JS 层
 * （FS.common.js:164 = utf8.decode(base64.decode(b64))，两个纯 JS 包，其中
 * base-64 用 output += 逐字符拼接整个二进制串）。对 12.78MB 缓存实测单次
 * 阻塞 JS 14.767s（jsBlocked，窗口内 0 条 JS 日志 = 不可中断任务）。
 *
 * @returns 全文；stat 失败/尺寸非正/读失败/拿不到完整字符前缀时返回 null
 *          （调用方按原语义回落完整解析）。
 */
async function readLocalTextFileChunked(path: string): Promise<string | null> {
  // pos 提到 try 之外：catch 里的 read-throw 行需要报告失败发生位置
  let pos = 0;
  try {
    const stat = await RNFS.stat(path);
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) {
      console.info(
        `[PERF][oversized] chunked-read fallback reason=size-invalid size=${size}`,
      );
      return null;
    }
    const parts: string[] = [];
    while (pos < size) {
      const want = Math.min(OVERSIZED_READ_CHUNK_BYTES, size - pos);
      // ★ 'base64' 编码时 FS.common.js 直接返回 b64 原文、不做任何 JS 解码，
      //   正好绕开 npm base-64 的逐字符拼接（这是本次降常数的关键）。
      // eslint-disable-next-line no-await-in-loop
      const b64 = await RNFS.read(path, want, pos, 'base64');
      if (typeof b64 !== 'string') {
        console.info(
          `[PERF][oversized] chunked-read fallback reason=b64-not-string off=${pos}`,
        );
        return null;
      }
      const bytes = bytesFromBase64(b64);
      const consumed = utf8CompletePrefixLength(bytes);
      if (consumed <= 0) {
        console.info(
          `[PERF][oversized] chunked-read fallback reason=no-complete-prefix off=${pos} want=${want}`,
        );
        return null; // 与 readBuiltinChapterSlice 同判据：不可静默跳字节
      }
      parts.push(decodeUtf8(bytes.subarray(0, consumed)));
      // ★ 推进不变量：pos 只有两处写点（let pos=0 与 pos+=consumed），且 consumed ≤ want ⇒
      //   成功出口 ⟺ pos 恰等于 size ⟺ 相对【本次读到的文件】零丢字节；⚠ 不蕴含文件自身完整——外部截断亦静默收短文本（待 T1 闸）；
      //   consumed=0 ⟺ 非法字节序列（含首字节合法、续字节非法）或末窗 want∈[1,3]。
      pos += consumed;
      // ★ 显式 macrotask 让出，切断微任务链（片间另有 native read 的 await 让出）
      // eslint-disable-next-line no-await-in-loop
      await yieldToJs();
    }
    return parts.join('');
  } catch (err) {
    console.info(
      `[PERF][oversized] chunked-read fallback reason=read-throw off=${pos} err=${String(err).slice(0, 120)}`,
    );
    return null;
  }
}

/** 内置书正文文本直读（不经解析）：文件 → assets 兜底。
 * 首章优先快速水合用——只需原文即可切章与装配目标章。 */
async function readBuiltinText(
  spec: BuiltinBookSpec,
): Promise<{ text: string; contentHash?: string } | null> {
  const canonicalPath = `${getBuiltinDirPath()}/${spec.id}.txt`;
  // ① native UTF-8 直读（首选）：解码在 native 层完成，JS 零逐字节开销。
  // 旧路径（readFileBytes base64 分块 + isStrictUtf8 全量校验 + decodeUtf8
  // 逐字节拼接）对资治通鉴级 9MB 文本是 3-10s 的连续同步阻塞——「初次
  // 点卡片长时间无响应」的第一大块。内置资产由构建脚本生成、恒为 UTF-8，
  // 直读必然成功；失败（文件缺失/损坏/非 UTF-8）走 ② 字节路径兜底。
  try {
    const t0 = Date.now();
    const text = await RNFS.readFile(canonicalPath, 'utf8');
    if (text) {
      // contentHash 仅导入查重消费（user_books 表），内置首开链路无人使用；
      // 不再对 9MB 文本做 utf8Bytes 全量重编码 + 双散列（原为 2-7s 的
      // 第二大块，纯浪费）。
      console.info(
        `[PERF][read] ${spec.id} primary-utf8 ${text.length}ch ${Date.now() - t0}ms`,
      );
      return { text };
    }
  } catch (e) {
    console.warn(
      `[PERF][read] ${spec.id} primary-utf8 THREW:`,
      (e as Error)?.message ?? e,
    );
  }
  // ② 字节路径（编码检测 + JS 逐字节解码）：仅非 UTF-8 内容触达
  try {
    const bytesRes = await readFileBytes(canonicalPath);
    if (bytesRes.success && bytesRes.data && bytesRes.data.length > 0) {
      return { text: decodeTextBytes(bytesRes.data).text };
    }
  } catch {
    // 文件读取失败走 assets 兜底
  }
  // ③ assets 兜底（native utf8 解码）
  try {
    const text = await RNFS.readFileAssets(`books/${spec.id}.txt`, 'utf8');
    return { text };
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

// ---------------- r38 T03：空闲扩散锚点 + 书序兜底 + FTS 章级增量 ----------------

/**
 * 【灰度开关】FTS 章级增量索引：`false` → 完整回落 r37「整书装配完成后
 * `upsertFtsForBookChunked(整本)`」（一行回退，两条路径互相独立）。
 */
export const R38_FTS_PER_CHAPTER = true;

/**
 * 空闲门重探间隔（ms）：兜底推进因「空闲门关闭（跳章装配中）
 * 或书序门槛未到」中止后，按此间隔重探并续跑——保证语义是「空闲时才推进」
 * 而不是「一旦忙过就永不推进」。档位化节奏由 `idleDiffuseIntervalMs` 决定，
 * 本常量只是下限保护（档位读取失败时的回落）。
 */
const IDLE_HEARTBEAT_FALLBACK_MS = 900;

/**
 * 单本书的填充上下文（r38 T03）：把「书序兜底推进」的全部状态从局部变量
 * 提升为可按书查询/取消的上下文——这是「取消令牌 + 书序门槛」可生效的前提
 * （旧实现的 `let i = 0` 局部游标无法被外部作废）。
 */
interface BuiltinFillContext {
  spec: BuiltinBookSpec;
  shells: BuiltinShell[];
  /**
   * ★ 取消令牌：与 `fillGeneration` 比对。世代在「切书 / 重水合 /
   * 测试重置」时递增 → 在推进的兜底轮立即中止（取消粒度 = 章边界：
   * 进行中的单章由调用方跑完，不中途截断，保「全有或全无」）。
   */
  token: number;
  /** 上一次返回的章下标是否为「在推进章」（流式 cursor 未 done → 续作优先） */
  inProgress: number;
  /** 书序兜底的前推游标 */
  orderCursor: number;
  /** 书序兜底启动门槛（锚点已知时 = now + 档位 bookOrderFallbackIdleMs） */
  bookOrderAt: number;
  /** 兜底轮是否在飞（单飞：同书至多一轮） */
  running: boolean;
  /** 最近一次有实际进展的时间（空闲心跳寿命判据） */
  lastProgressAt: number;
  /** 空闲心跳计时器（书填满 / 取消 / 重置时清除） */
  heartbeat: ReturnType<typeof setTimeout> | null;
  /**
   * 【D3】阅读器已卸载（切书 / 退出阅读）→ 不再为本书推进后台装配与心跳；
   * 阅读器重新上报锚点时复位。游标与上下文**保留**（可继续装配，红线⑤）。
   */
  detached: boolean;
  hydrate: ((book: Book) => { success: boolean; error?: string }) | undefined;
}

/** 按书登记的填充上下文（书级 LRU 淘汰 / 测试重置时释放，见 releaseBookAssemblyRefs） */
const fillContexts = new Map<string, BuiltinFillContext>();

/**
 * 兜底推进世代（取消令牌的真源）：任何「填充语义发生整体变化」的事件都递增
 * 它——书体重水合、测试重置。旧世代的兜底轮在下一次
 * `scheduleBookOrderFallback` 调用处即遭中止（≤1 步延迟，章边界语义）。
 */
let fillGeneration = 0;

/**
 * 【r38 T03】上报当前阅读位置的**锚点**。
 *
 * ⚠ 阅读器清理后本函数的阅读器耦合已剥离（原实现还会写入阅读器活跃窗，并递增
 * 填充世代 / 重置取消令牌 / 复位扩散与书序游标）。保留的最小语义只有三条，且
 * **都与阅读器视口无关**：
 *  ① 转发给调度器（锚点真源在调度器，供其 P1~P3 优先级与空闲判定使用）；
 *  ② 清除全书失败锁存（自愈入口，见下）；
 *  ③ 解除 `detached` 并唤醒一轮后台填充。
 * 用户书（非内置书）无填充语义，只做 ① + ②。
 */
export function reportReadingAnchor(
  bookId: string,
  chapterId: string,
  order: number,
): void {
  if (!bookId || !chapterId) {
    return;
  }
  chapterAssemblyScheduler.reportReadingAnchor(bookId, chapterId, order);
  // 【R2-1/#20】用户重新挂在本书上（进入 / 切章 / 重进）→ 清除**全部**失败
  // 锁存，恢复「可续可重试」自愈能力（红线⑤）。否则一次持续读失败会让该章在
  // 本次会话内永久不再尝试（QA #19：BACK 回书架再重开同书仍空白，只有杀进程
  // 能复位）。必须放在 `ctx` 早退**之前**：调度器路径的流式壳登记
  // （`streamingEntries`）与 `fillContexts` 生命周期不同，ctx 不存在时
  // 也要清（否则被 LRU 释放过上下文的书永远解不开锁存）。
  clearAssemblyFailures(bookId);
  const ctx = fillContexts.get(bookId);
  if (!ctx) {
    return;
  }
  // 阅读器重新挂在本书上（阅读器卸载时会置 detached，见 detachReaderBook）
  ctx.detached = false;
  pumpFillContext(ctx);
}

/**
 * 【D3】阅读器卸载（切书 / 退出阅读）时释放本书的装配侧引用。
 *
 * 权衡（红线⑤「游标可续」优先于引用回收）：
 *  - 本书仍有未完成的章（Partial / 未装配）→ **保留上下文与游标**，只置
 *    `detached` 并停掉空闲心跳（不再为没人读的书推进后台装配）。绝不丢弃
 *    游标：游标丢失会让 Partial 章在 `builtinChapterReadiness` 里退化为
 *    Full（截断章，D1 同类缺陷），且新游标 segCount 归零会重复 push 段落。
 *  - 本书已无未完成章 → 整体释放（引用可立即回收，判定复用已就绪章）。
 *  真正的内存兜底由「书级 LRU 淘汰钩子」承担（releaseBookAssemblyRefs），
 *  故此处退化为「可继续装配」不影响 P0-5 内存目标。
 */
export function detachReaderBook(bookId: string): void {
  if (!bookId) {
    return;
  }
  const ctx = fillContexts.get(bookId);
  if (!ctx) {
    return;
  }
  ctx.detached = true;
  clearFillHeartbeat(ctx);
  if (!hasPendingFillWork(ctx)) {
    releaseBookAssemblyRefs(bookId);
  }
}

/**
 * 【D3】释放某本书的装配侧引用（流式游标登记 + 空闲扩散上下文）。
 *
 * 由**书级 LRU 淘汰钩子**（TextLibraryService.onBookEvicted）调用——书体正文
 * 被换回元数据目录态时，这几个集合若仍持有 `shell` / `shell.chapter`，
 * 就会把已被淘汰的整本 `chapters` 数组钉住，使 P0-5「已填书正文可回收」
 * 目标失效；同时**钉住旧壳还会让该章后续装配写进已被替换的孤儿章对象**
 * （就绪判定读的是新书体 → 永远填不满），故此处释放同时修掉该缺陷。
 *
 * 安全性（不违反红线⑤）：被淘汰书体的 `chapters` 已被 LRU 换成元数据目录
 * 数组，旧章对象连同其 `fillCursor` 已不被任何书体引用——保留游标也无法
 * 「续作」，只会在下次水合时把内容写进孤儿对象。释放后重新进入本书走
 * `ensureBookReady` 全新建壳，自 bytePos 0 完整装配（内容完整，不截断）。
 */
export function releaseBookAssemblyRefs(bookId: string): void {
  const prefix = `${bookId}:`;
  for (const key of Array.from(streamingEntries.keys())) {
    if (key.startsWith(prefix)) {
      streamingEntries.delete(key);
    }
  }
  const ctx = fillContexts.get(bookId);
  if (ctx) {
    clearFillHeartbeat(ctx);
    ctx.running = false;
    fillContexts.delete(bookId);
  }
}

/**
 * 章节是否已就绪（READY_FULL）：兜底与扩散共同的跳过判据。
 *
 * ★【#22 修复】口径与 `builtinChapterReadiness` / `getChapterContentQuality` /
 * `runChapterAssembleToFull` 的 `cursorSettled` **统一为「有游标看 done、
 * 无游标看 provenance」**。旧写法
 * `segments.length > 0 && !fillCursor ⟹ true` 把「有正文但**完整性未证实**」
 * 当作已就绪——真机复验（QA #21）里 c169 `paras=148`（oracle 156）/
 * c166 `paras=105`（106）正是这种形态（装配被接管 → 游标被作废 → 只剩半章）：
 * 兜底填充因此**永久跳过**该章 ⇒ 缺失段既不上屏也永不补齐，且被写进 FTS。
 * 现在口径统一后，这类章会被判「未就绪」→ 由装配链路整章直读补全
 * （`resolveCursorMismatch` / `repairChapterByWholeRead`，含退避）。
 */
function isShellComplete(shell: BuiltinShell): boolean {
  const key = streamingKeyOf(shell.chapter.bookId, shell.chapter.id);
  // ① 登记游标是本图真源（登记壳与本书章对象一致时）：done 即 READY_FULL
  const entry = streamingEntries.get(key);
  if (entry && entry.shell.chapter === shell.chapter) {
    return entry.cursor.done === true;
  }
  // ② 本壳自己的游标（ctx 壳与调度器壳并存时不共享对象，各自可能承载证据）
  if (shell.fillCursor) {
    return shell.fillCursor.done === true; // 流式装配到章尾
  }
  // ③ 无游标：只有「整章一次性装配」证明（provenance）才算完整
  return (
    shell.chapter.segments.length > 0 && chapterWholeReadComplete.has(key)
  );
}

/**
 * 【R2-1】兜底/扩散**选章判据**（调度语义）：未就绪 且 非失败终态 且 不在
 * 失败退避窗口内。
 *
 * 与 `isShellComplete`（**就绪语义**）严格分离——这正是 R2-1 的要求：
 * `isShellComplete` / `builtinChapterReadiness` 只认 `done`，**绝不**因
 * `failedTerminal` 判 Full（失败章不得被当成就绪，也不得写 FTS）；而选章
 * 必须把「失败终态 / 退避中」的壳排除，否则主循环永远重选同一失败章。
 */
function isShellSelectable(shell: BuiltinShell): boolean {
  if (isShellComplete(shell) || shell.failedTerminal === true) {
    return false;
  }
  const cur = shell.fillCursor;
  if (cur && cur.failCount > 0 && Date.now() < cur.failBackoffUntil) {
    return false; // 退避窗口内：本轮不选它（失败之间不紧循环空转）
  }
  // ★【#22】「未证实完整」章的**整章直读补全**退避窗口内同样不选它：
  //   否则「选它 → 补全（挡在退避里只能廉价 false）→ 未就绪 → 再选它」
  //   会变成新的紧循环空转（team-lead 明确要求不得做成新空转）。
  //   退避窗口外自然重新入选（自愈），窗口内本轮直接推进到其他章或返回。
  const repairUntil =
    chapterRepairBackoffUntil.get(
      streamingKeyOf(shell.chapter.bookId, shell.chapter.id),
    ) ?? 0;
  if (Date.now() < repairUntil) {
    return false;
  }
  return true;
}

/**
 * 【R2-1】清除失败终态与失败计数/退避（**自愈**入口，红线⑤「可续可重试」）。
 * 调用时机：用户重新进入本书 / 上报阅读锚点（阅读器重新挂到本书上）。
 */
function clearShellFailures(shells: BuiltinShell[]): void {
  for (const shell of shells) {
    if (shell.failedTerminal === true) {
      shell.failedTerminal = false;
    }
    const cur = shell.fillCursor;
    if (cur && (cur.failCount > 0 || cur.failBackoffUntil > 0)) {
      cur.failCount = 0;
      cur.failBackoffUntil = 0;
    }
  }
}

/** 书序兜底启动延迟（档位 `bookOrderFallbackIdleMs`，读失败回落 45s = mid） */
const BOOK_ORDER_FALLBACK_IDLE_FALLBACK_MS = 45_000;
function resolveBookOrderFallbackIdleMs(): number {
  try {
    const params = getTierParams();
    return Math.max(
      0,
      pickTierNumber(
        params?.bookOrderFallbackIdleMs,
        BOOK_ORDER_FALLBACK_IDLE_FALLBACK_MS,
      ),
    );
  } catch {
    return BOOK_ORDER_FALLBACK_IDLE_FALLBACK_MS;
  }
}

/** 空闲扩散心跳间隔（档位 `idleDiffuseIntervalMs`，读失败回落 900ms = mid） */
function resolveIdleDiffuseIntervalMs(): number {
  try {
    const params = getTierParams();
    return Math.max(
      0,
      pickTierNumber(params?.idleDiffuseIntervalMs, IDLE_HEARTBEAT_FALLBACK_MS),
    );
  } catch {
    return IDLE_HEARTBEAT_FALLBACK_MS;
  }
}

/**
 * 空闲门（全开才推进后台兜底）：调度器侧空闲
 * （`isIdle()` = 无 P1~P3 请求/在飞 **且** 不在锚点迁移后的
 * `ANCHOR_ACTIVITY_WINDOW_MS` 活跃窗口内）。
 * 不满足 → 本轮不推进（由空闲心跳按档位节奏重探）。
 * 调度器异常不得阻塞兜底（读失败视为「空闲」，等价 r37 行为）。
 *
 * 【阅读器清理】原有「① 无手势/滚动」「② 无 loading」两项已随阅读器族一并移除：
 * 这两项的真源是阅读器上报，
 * 清理后无人上报，恒为「开」。`isIdle()` 内含 `isUserActiveNow()`，
 * 故对 P1~P3 的判定与改前逐字等价。
 */
function fillIdleGateOpen(): boolean {
  try {
    return chapterAssemblyScheduler.isIdle();
  } catch {
    return true;
  }
}

/**
 * §4.4 FTS 双检查点（书间 + 片间）：装配侧活动期间不让 FTS 队列开新书 / 续片。
 * 【D6】接线此前未消费的 `chapterAssemblyScheduler.isUserActive()`：调度器有
 * P1~P3 请求或在飞即让路。功能上与会抬升的 `ftsQueuePausedUntil` 等价
 *（`latchFts()` 在同一判据下把门闩推到 now + 档位 ftsYieldMs），差异只在
 * 「单章装配耗时超过 FTS 让路窗口」这一边界：此时旧门闩已到期，而装配仍在
 * 进行——双检查点会继续让路，符合 §4.4「绝不与装配抢 JS」的意图。
 * 异常一律视为「无活动」（不阻塞 FTS 队列）。
 */
/**
 * 【章节加载重构 T01】FTS 检查点让路探针开关
 * （`[PERF][asm] paused reason=ftsCheckpoint ...`）。
 *
 * ⚠ **必须**边沿触发 + 限流，**不得**裸打：本行落点是 `ftsCheckpointPaused()`，
 * 而该判据有两处高频消费者——书间 `while` 轮询（每 `FTS_PAUSE_POLL_MS` = 250ms
 * 求值一次）与片间 `shouldPause`（逐章/逐片求值）。裸打会刷屏并打穿
 * `[PERF][jank]` 的观测口径（本仓已因混标栽过两次）。
 *
 * ⚠ **刻意不打 `book=`**：该判据是**全局**判据（书间轮询跨全部内置书），其调用点
 * 无书上下文；伪造书 id / 片计数 = 伪证。真正需要「哪本书被停」时应从
 * `[PERF][fts] <书> parse=…` 的相邻行推断，而不是在探针里编。
 *
 * **翻转时机 = T07**（把 `ftsCheckpointPaused()` 接进 `shouldPause`）。在 T07 之前
 * 打开本开关只会看到「书间检查点」的半景。
 *
 * ⚠ 【T07 已落地】本开关已在 T07 翻为 `true`：新增的第三个消费点（书级分片索引
 * 写入，见 {@link ftsBookChunkPaused}）补齐后，三个消费点都在位，读数不再是半景。
 * 本行只控**日志**，不控行为（行为回退见 `FTS_BOOK_CHUNK_STARVE_MAX_MS`）。
 *
 * ⚠⚠ 【T07 修订】上句「行为回退见 `FTS_BOOK_CHUNK_STARVE_MAX_MS`」在 T07 首版是
 * **空头承诺**：该常量当时未作为第 4 实参传进 `planAssemblyYield` ⇒ 是死常量，
 * 改它不改变行为（「一行回退」实际不存在，且无任何测试可观测）。现已接线并
 * 由 `ftsBookChunkYield.test.ts` D 组用例常驻守住。**两个开关现在才真正各司其职**：
 * 本行 = 日志；`FTS_BOOK_CHUNK_STARVE_MAX_MS` = 行为。
 */
const FTS_CHECKPOINT_PROBE_ENABLED = true;
/** 同值下的最小重打间隔（ms）。跳变不受本限流约束（跳变必打）。 */
const FTS_CHECKPOINT_PROBE_MIN_INTERVAL_MS = 1000;
/** 上一次的判界值（边沿检测基准；`null` = 尚未建立基线 ⇒ 首次求值必打） */
let ftsCheckpointProbeLatch: boolean | null = null;
/** 上一次打印时间戳（限流基准；`0` = 从未打印） */
let ftsCheckpointProbeLoggedAt = 0;

function ftsCheckpointPaused(): boolean {
  try {
    const paused = chapterAssemblyScheduler.isUserActive();
    if (FTS_CHECKPOINT_PROBE_ENABLED) {
      const now = Date.now();
      // 边沿必打（跳变 = 让路的开始/结束，是唯一真正有信息量的时刻）；
      // 同值下按 1s 限流（本判据在书间 250ms 轮询 + 片间逐章求值下会被高频调用）。
      const edge = paused !== ftsCheckpointProbeLatch;
      if (edge || now - ftsCheckpointProbeLoggedAt >= FTS_CHECKPOINT_PROBE_MIN_INTERVAL_MS) {
        ftsCheckpointProbeLatch = paused;
        ftsCheckpointProbeLoggedAt = now;
        // 【阅读器清理】原 `utils/annotationProbe.formatAsmPausedLine` 已随阅读器族
        // 删除（那是给 ReaderScreen 四条路径按 path= 分桶用的格式器）。此处内联**逐字
        // 同形**的输出：该行字面量被保留族测试 `ftsBookChunkYield.test.ts:442-443`
        // （`pausedOnLines()`/`pausedOffLines()`）逐字冻结，是本判据唯一的真机取证面。
        console.info(
          `[PERF][asm] paused reason=ftsCheckpoint gate=${paused ? 'on' : 'off'}`,
        );
      }
    }
    return paused;
  } catch {
    return false;
  }
}

/**
 * 【章节加载重构 T07】书级分片索引写入的**让路保底配额**（ms）。
 *
 * 缺口：`fillRemainingBuiltinChapters` 收尾处的整书分片写入
 * （{@link ftsBookChunkPaused} 的调用点）此前只读 `ftsQueuePausedUntil` 门闩，
 * **漏读**调度器活动判据 ⇒ 用户跳章（P1 目标章装配在飞）时该写入仍与装配抢 JS
 * （PRD P0-3 残留最后一条）。
 *
 * 语义（**不可改**）：同一轮书级分片写入内，让路给装配的**累计**时长不得超过本值，
 * 到达后必须放行强写 ⇒ **严禁饿死**（与注音侧 T05 同族的「保底配额」，判定实现
 * 共用 {@link planAssemblyYield}）：
 * ```text
 * 装配空闲                ⇒ 不让路，忙期复位（配额重新记账）
 * 装配忙 且 未满配额       ⇒ 让路（继续轮询等）
 * 装配忙 且 已满配额       ⇒ **放行**（继续写；同一连续忙期内不再反复让路）
 * ```
 *
 * **一行回退（行为）**：本值设为 `0` ⇒ 判定恒不让路 ⇒ 行为等价于 T07 之前
 * （只剩 `ftsQueuePausedUntil`）。日志侧回退见 {@link FTS_CHECKPOINT_PROBE_ENABLED}。
 * 二者互不依赖。
 *
 * ⚠ **取值必须与 `utils/assemblyYield.ts` 同源，禁止硬编码数值**：
 * 「让路配额」与「FTS 让路配额」是**同一个语义**（都是「让路给装配的累计上限」），
 * 两处各写一份 `2000` 就会出现第二份数值真相（改一处忘另一处 = 静默漂移）。
 *
 * ⚠⚠ **本常量必须真的作为第 4 实参传进 {@link planAssemblyYield}**：
 * T07 首版漏传该实参 ⇒ 配额实际取自 `planAssemblyYield` 的默认值 ⇒
 * 本常量成为**死常量**：「改为 `0`」不改变任何行为（一行回退是空头承诺），
 * 且「改本值」不能被任何测试观测到。**已修**（见 {@link ftsBookChunkPaused}），
 * 并由 `ftsBookChunkYield.test.ts` 的「D 组·接线契约」用例常驻守住。
 *
 * ⚠ **刻意不新造第二条暂停谓词**：本配额消费的是既有 {@link ftsCheckpointPaused}
 * （其内部即 `chapterAssemblyScheduler.isUserActive()`），避免「两个真相源」。
 */
const FTS_BOOK_CHUNK_STARVE_MAX_MS = ASSEMBLY_YIELD_STARVE_MAX_MS;

/**
 * 书级分片写入侧的**忙期起点**（`null` = 上一轮判定时装配空闲 ⇒ 配额重新记账）。
 *
 * ⚠ 必须由**写入会话入口**显式清零一次（见调用点的注释）：本字段只在
 * `shouldPause` 求值点被更新，而两次写入之间可能长期无求值（无写入在飞 ⇒
 * 无轮询）⇒ 不清零则上一会话遗留的起点会让 `now − 起点 > 配额` 恒真，
 * 之后的写入**再也不让路**（开关开着却静默失效 = 假证据）。
 */
let ftsBookChunkBusySince: number | null = null;

/**
 * 【章节加载重构 T07】书级分片索引写入的让路谓词（送进
 * `StorageService.upsertFtsForBookChunked({ shouldPause })`）。
 *
 * 复用**既有的** {@link ftsCheckpointPaused}（不新造第二个暂停谓词）+
 * T05 提炼的纯判定 {@link planAssemblyYield}（配额语义只在一处定义，注音与 FTS
 * 两侧共用 ⇒ 不会各自漂移）。
 *
 * **为什么必须可复位**（team-lead T07 硬要求 2）：`StorageService` 侧是
 * `while (shouldPause()) { await sleep(FTS_CHUNK_PAUSE_POLL_MS) }` 的阻塞轮询，
 * 本谓词一旦恒真就是「暂停后永不再写」= 该书无 FTS 索引 = 用户可见缺陷。
 * 出口有**两个**，都在结构上成立（非约定）：
 *  ① **配额到期**：装配整轮忙满 {@link FTS_BOOK_CHUNK_STARVE_MAX_MS} 后必放行
 *    ——对应 `planAssemblyYield` 的 `defer: now − start < quota`；
 *  ② **装配转空闲**：`planAssemblyYield` 随即返回 `busySince = null` ⇒ 下一轮重新记账。
 * 轮询间隔 `FTS_CHUNK_PAUSE_POLL_MS` = 250ms ⇒ 到期最迟 250ms 内被观测到。
 *
 * ⚠ **不复用 `ftsQueuePausedUntil`**：那是「水合后固定缓冲」语义，已由调用点的
 * `||` 左项负责（顺序刻意放左：既有语义先短路求值，右项只在真成为决定因时才
 * 通过 {@link ftsCheckpointPaused} 的边沿/限流打印）。本谓词只补「调度器活动」
 * 这一条，两条件互不覆盖。
 *
 * ⚠ **本谓词不做边沿/限流**：打印与限流全在 `ftsCheckpointPaused()` 内部
 * （边沿必打 + 1s 限流，见其文档）。本谓词多调一次 `isUserActive()`，但只在
 * `shouldPause` 求值点（章级，非逐段）触发，成本可忽略。
 */
function ftsBookChunkPaused(): boolean {
  const plan = planAssemblyYield(
    ftsCheckpointPaused(),
    ftsBookChunkBusySince,
    Date.now(),
    // ⚠ 第 4 实参**必须**显式传入本侧常量：漏传会退回 `planAssemblyYield` 的
    //   默认值（`ASSEMBLY_YIELD_STARVE_MAX_MS`）⇒ 本侧常量变死常量、「=0」失去
    //   一行回退能力，且任何测试都观察不到（T07 首版即此缺陷，已修）。
    FTS_BOOK_CHUNK_STARVE_MAX_MS,
  );
  ftsBookChunkBusySince = plan.busySince;
  return plan.defer;
}

/** 当前阅读锚点在本章壳数组中的下标；无锚点 / 非本书 / 未命中 → -1 */
function anchorIndexOf(ctx: BuiltinFillContext): number {
  const anchor = chapterAssemblyScheduler.getReadingAnchor();
  if (!anchor || anchor.bookId !== ctx.spec.id) {
    return -1;
  }
  if (anchor.order > 0) {
    const byOrder = anchor.order - 1;
    if (byOrder >= 0 && byOrder < ctx.shells.length) {
      return byOrder;
    }
  }
  return ctx.shells.findIndex((s) => s.chapter.id === anchor.chapterId);
}

/**
 * 空闲兜底调度（r38 T03）。
 *
 * 返回下一个该装配的章下标；`-1` = 本轮无目标（调用方结束本轮）。
 *
 * ⚠【阅读器清理】原「④ 锚点邻近扩散（±k 双向交错 / `ctx.diffuseK` /
 * `ctx.diffuseQueue`）」「灰度开关 `R38_DIFFUSE_ENABLED` 的完整回退分支」与
 * 「`[PERF][diffuse]` / `[PERF][neighbor] path=idle` 两处扩散探针」已随阅读器
 * 定位/跨章族**整体移除**。保留的闸门与目标：
 *
 *  ① **取消令牌**：`ctx.token !== fillGeneration` → -1。切书 / 重水合 /
 *     测试重置都会递增世代，旧位置在推进的兜底轮立即中止（≤1 步延迟）。
 *  ② **空闲门**：`fillIdleGateOpen()` 为 false → -1（调度器有 P1~P3 在飞）。
 *  ③ **在推进章的续作优先**：游标章未完整（流式游标未 done）→ 继续本章，
 *     不换目标（取消粒度 = 章边界，绝不半途换章造成部分产出）。
 *  ③b **锚点章未完整优先补**（D1 重试通道）：调度器侧装配失败/只到 Partial
 *     时章游标未 done，本层接手重试，避免「失败即永久截断」。空闲门保证不与
 *     调度器在飞的目标章并发，两条路径共用同一流式游标（幂等）。
 *  ④ **书序兜底**：自锚点起按书序前推（跳过已完整章）。锚点已知时额外等
 *     档位 `bookOrderFallbackIdleMs`（「仅长时间空闲」才按书序走长尾）；
 *     锚点未知（首开尚无上报）时无门槛 = 初始化填充语义。
 *
 * 注意：**不存在**「无条件从 i = 0 推进」的路径——没有锚点时 `from = 0`
 * 只是「尚无阅读位置」的初始化兜底。
 */
function scheduleBookOrderFallback(ctx: BuiltinFillContext): number {
  const shells = ctx.shells;
  // ① 取消令牌：世代变更 → 本轮中止
  if (ctx.token !== fillGeneration) {
    return -1;
  }
  // ①b 【D3】阅读器已卸载 → 不为没人读的书继续推进（下章边界即停，
  //     不丢游标、不产生截断：Partial 章保留可续状态）
  if (ctx.detached) {
    return -1;
  }
  // ② 空闲门
  if (!fillIdleGateOpen()) {
    return -1;
  }
  // ③ 在推进章未完整 → 继续本章（流式游标可续；不换目标 = 章边界语义）
  //    R2-1：改用「可选」判据——失败终态 / 退避中的章不再被锁在这里续作
  if (
    ctx.inProgress >= 0 &&
    ctx.inProgress < shells.length &&
    isShellSelectable(shells[ctx.inProgress])
  ) {
    return ctx.inProgress;
  }
  ctx.inProgress = -1;
  const anchorIdx = anchorIndexOf(ctx);
  // ③b 锚点章未完整 → 优先补它（D1 重试通道）：调度器侧（P1 目标）装配失败
  //     或只跑到 Partial 时，章游标未 done → 本层接手续作/重试。
  //     空闲门已保证「调度器有 P1~P3 在飞」时不会走到这里（不与目标章抢 JS），
  //     故不会与调度器重复装配；两条路径共用同一流式游标，天然幂等。
  //     R2-1：同样用「可选」判据——锚点章失败终态/退避中则**落后续闸门**去填
  //     别的章（否则这里就是 QA 实证的死循环入口：每次都选中同一失败章）。
  if (anchorIdx >= 0 && isShellSelectable(shells[anchorIdx])) {
    return anchorIdx;
  }
  // ④ 书序兜底：锚点已知时仅长时间空闲才启动（长尾交给档位门槛）
  if (anchorIdx >= 0 && Date.now() < ctx.bookOrderAt) {
    return -1;
  }
  const from = anchorIdx >= 0 ? anchorIdx : 0;
  if (ctx.orderCursor < from) {
    ctx.orderCursor = from;
  }
  for (let i = ctx.orderCursor; i < shells.length; i += 1) {
    if (isShellSelectable(shells[i])) {
      ctx.orderCursor = i;
      return i;
    }
  }
  ctx.orderCursor = shells.length;
  return -1;
}

/** 建立/取回本书的填充上下文（token 跟随当前世代；锚点未知则书序自 0） */
function ensureFillContext(
  spec: BuiltinBookSpec,
  shells: BuiltinShell[],
  hydrate: ((book: Book) => { success: boolean; error?: string }) | undefined,
): BuiltinFillContext {
  const existing = fillContexts.get(spec.id);
  if (existing && existing.shells === shells) {
    existing.hydrate = hydrate;
    return existing;
  }
  const ctx: BuiltinFillContext = {
    spec,
    shells,
    token: fillGeneration,
    inProgress: -1,
    orderCursor: 0,
    bookOrderAt: 0,
    running: false,
    lastProgressAt: Date.now(),
    heartbeat: null,
    detached: false,
    hydrate,
  };
  const anchorIdx = anchorIndexOf(ctx);
  // 书序游标自锚点起步（无锚点则自 0：初始化填充语义）
  ctx.orderCursor = Math.max(0, anchorIdx);
  // 锚点已知（用户在读本书）→ 书序兜底等档位门槛；无锚点 → 无门槛（初始化填充）
  ctx.bookOrderAt =
    anchorIdx >= 0 ? Date.now() + resolveBookOrderFallbackIdleMs() : 0;
  fillContexts.set(spec.id, ctx);
  return ctx;
}

/** 清空某书的空闲心跳（填满 / 取消 / 重置） */
function clearFillHeartbeat(ctx: BuiltinFillContext): void {
  if (ctx.heartbeat !== null) {
    clearTimeout(ctx.heartbeat);
    ctx.heartbeat = null;
  }
}

/**
 * 本书是否还有未完整章（空闲心跳的寿命判据）。
 * 【R2-1】排除**失败终态**章：它们本批已放弃重试，若计入会让心跳永远续排
 *（空转）。失败退避中的章仍计入（退避是暂态，心跳到点应重试）。
 */
function hasPendingFillWork(ctx: BuiltinFillContext): boolean {
  return ctx.shells.some(
    (s) => !isShellComplete(s) && s.failedTerminal !== true,
  );
}

/**
 * 唤醒一轮兜底推进（单飞：同书至多一轮在飞，由 `ctx.running` 守卫）。
 * 空闲心跳亦经此入口续跑，保证「同一本书的装配推进」永不并发。
 */
function pumpFillContext(ctx: BuiltinFillContext): void {
  if (ctx.token !== fillGeneration) {
    return;
  }
  void fillRemainingBuiltinChapters(ctx.spec, ctx.shells);
}

/**
 * 【#14】章级 FTS 写入跳过日志是否已打（一次性）。
 * FTS 不可用（SQLite 未编译 FTS5）或持续写失败是**稳定事实**，按章打印会
 * 让「每章一条 [PERF][fts] per-chapter skip」刷屏（玉台新咏级 390 章即 390 条），
 * 且掩盖真正需要关注的日志。故只保留首条提示（失败原因已由 StorageService
 * 侧一次性降级日志给出），后续章静默降级。
 */
let ftsPerChapterSkipLogged = false;

/** 章就绪（READY_FULL）→ FTS 章级增量写入（失败静默降级，不得影响装配） */
function writeFtsForReadyChapter(spec: BuiltinBookSpec, shell: BuiltinShell): void {
  writeFtsForChapter(spec, shell.chapter);
}

/** 同上，按章对象直写（补全链路拿到的是书体内章对象，未必持有 BuiltinShell） */
function writeFtsForChapter(
  spec: BuiltinBookSpec,
  chapter: BuiltinShell['chapter'],
): void {
  if (!R38_FTS_PER_CHAPTER) {
    return;
  }
  const book = TextLibraryService.getBook(spec.id);
  if (!book.success || !book.data) {
    return;
  }
  try {
    const res = StorageService.upsertFtsForChapter(book.data, chapter);
    if (!res.success && !ftsPerChapterSkipLogged) {
      ftsPerChapterSkipLogged = true;
      console.info(
        `[PERF][fts] per-chapter skip ch=${chapter.id} err=${res.error ?? '-'}（一次性提示：FTS 不可用/写入失败，后续章不再逐条打印）`,
      );
    }
  } catch {
    // FTS 写失败静默降级：装配链路不得因检索索引受影响
  }
}

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

/** fillBuiltinChapterNow 的并发去重（bookId:chapterId） */
const chapterFillInFlight = new Set<string>();

/**
 * 按需优先填充单个内置书章节（阅读器「向前拼接预热」专用）。
 * 背景：后台填充按书序进行（fillRemainingBuiltinChapters 从第 1 章起），
 * 跳章阅读时「上一章」可能长期处于空壳态——向前拼接若插入空壳章会先
 * 渲染空白、后台填到该章时又整体暴涨（大幅跳动）。本函数按 meta 字节
 * 区间切片（毫秒级）即刻装配目标章，复用既有 hydrate 合并 + 进度通知
 * 链路；与后台填充并发安全（后台循环对 segments 非空的章直接跳过，
 * 双方写入内容幂等）。非内置书/未水合/无该章返回 false。
 *
 * @param force 【#20】true = 忽略「已有正文」短路，重读并**整体替换**
 *   `chapter.segments`。用于「截断章补全 / 降级整章直读」（用户可见出口
 *   的第二档策略）。默认 false，既有调用方行为逐字不变。
 */
export async function fillBuiltinChapterNow(
  bookId: string,
  chapterId: string,
  force = false,
): Promise<boolean> {
  if (!bookId || !chapterId) {
    return false;
  }
  // ★2026-10-13（B 档步骤 6）：本函数从「内置书专名」泛化为「任何有章字节区间的书」。
  //   用户书走 `.gxbook.toc`（步骤 5 已落盘）——此前用户书在此**无条件早退**，
  //   于是 `ReaderScreen` 的空壳兜底 `degradeChapterToWholeRead` 对用户书恒返回
  //   false ⇒ 目录态书点开必 `throw '章节正文加载失败'`。
  //   ⚠ 内置书的早退条件与顺序**逐字保留**（非用户书缺 spec / hidden 都直接退，
  //     且**不做任何 IO**）；用户书另走一支，缺 toc 时同样退 ⇒ 回退全量读，永远正确。
  const isUser = TextLibraryService.isUserBook(bookId);
  const spec = isUser ? null : getBuiltinSpec(bookId);
  if (hiddenBuiltins.has(bookId) || (!isUser && !spec)) {
    return false;
  }
  const bookRes = TextLibraryService.getBook(bookId);
  if (!bookRes.success || !bookRes.data) {
    return false; // 未水合（无壳可填）：由 ensureBookReady 主链路负责
  }
  const chapter = bookRes.data.chapters.find((c) => c.id === chapterId);
  if (!chapter) {
    return false;
  }
  if (!force && chapter.segments.length > 0) {
    return true; // 已有正文
  }
  const key = `${bookId}:${chapterId}`;
  if (chapterFillInFlight.has(key)) {
    return false; // 已在填充：完成时经进度通知驱动重试
  }
  chapterFillInFlight.add(key);
  // 【#20】收回本章装配所有权：整章直读将**整体替换** segments，必须先作废
  // 在飞的流式游标（否则在飞步会重复 push 同一批段号 = 正文重复）
  abandonStreamingAssembly(bookId, chapterId);
  try {
    // 章字节区间来源：内置书 = `books/<id>.meta.json`，用户书 = `<cachePath>.toc`。
    // 两者的「纯结构校验」都在各自读侧完成（`loadBuiltinMeta` / `loadUserBookToc`），
    // **读盘即判**——不为了校验偏移去读正文，否则本步要省的 6275ms 就白花了。
    let rangeOf: (id: string) => { s: number; e: number } | null;
    let readSlice: (s: number, e: number) => Promise<BuiltinChapterSliceRead | null>;
    if (isUser) {
      const files = oversizedBookFiles.get(bookId);
      if (!files) {
        return false; // 非超大书路径注册的用户书（仍全量注册）⇒ 维持原行为
      }
      const toc = await loadUserBookToc(files.cachePath, bookId, 0);
      if (!toc) {
        return false; // 无 toc / 非法 ⇒ 回退全量读
      }
      rangeOf = (id: string) => {
        const hit = toc.chapters.find((c) => c.id === id);
        return hit ? { s: hit.start, e: hit.end } : null;
      };
      readSlice = (s: number, e: number) =>
        readFileSliceUtf8Safe(files.cachePath, s, e, bookId);
    } else {
      const builtinSpec = spec as BuiltinBookSpec;
      const meta = await loadBuiltinMeta(builtinSpec);
      if (!meta) {
        return false;
      }
      rangeOf = (id: string) => {
        const hit = meta.chapters.find((c) => c.id === id);
        return hit ? { s: hit.s, e: hit.e } : null;
      };
      readSlice = (s: number, e: number) =>
        readBuiltinChapterSlice(builtinSpec, s, e);
    }
    const range = rangeOf(chapterId);
    if (!range) {
      return false;
    }
    const entryS = range.s;
    const entryE = range.e;
    // 流式装配（r37）：整章一次读 + toParagraphs 单块在巨章（史记表章级
    // 几十万字节）上是多秒级连续同步块——跳远章后邻章预热串行触发本函数，
    // JS 连续阻塞（真机采样 jsBlocked 8.4s）导致触摸不被处理（「无法
    // 滚动」）、渲染饿死（「空白」）、prepend 对齐 rAF 与标题行 onLayout
    // 精修被延迟到超时（tryAlign ticks=1 即 exhausted、精修日志缺失）。
    // 改为与 fillRemainingBuiltinChapters 一致的流式路径：64KB 分批读 +
    // 行级时间片（FILL_TIME_BUDGET_MS）+ 片间让出（FILL_YIELD_MS）。
    // 语义保持「全有或全无」：中途读失败丢弃部分产出——部分内容会让后台
    // 填充按 segments 非空跳过该章，造成永久截断章。
    const t0 = Date.now();
    const totalBytes = entryE - entryS;
    let bytePos = 0;
    let carry = '';
    let readMs = 0;
    let segCount = 0;
    const segs: typeof chapter.segments = [];
    let batchT0 = Date.now();
    let readFailed = false;
    while (bytePos < totalBytes || carry) {
      const want = Math.min(FILL_READ_CHUNK_BYTES, totalBytes - bytePos);
      let slice = '';
      if (want > 0) {
        const rT0 = Date.now();
        const r = await readSlice(entryS + bytePos, entryS + bytePos + want);
        readMs += Date.now() - rT0;
        if (r === null) {
          readFailed = true;
          break;
        }
        slice = r.text;
        // 【#20】按实际消费字节数推进（尾部不完整多字节字符被裁掉时至多 -3）
        bytePos += Math.min(r.consumed, want);
      }
      let chunk = carry + slice;
      carry = '';
      if (bytePos < totalBytes) {
        // 批尾未完结行留到下批（行跨批截断防护）：整批无换行时全部留 carry
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl >= 0) {
          carry = chunk.slice(lastNl + 1);
          chunk = chunk.slice(0, lastNl + 1);
        } else {
          carry = chunk;
          chunk = '';
        }
      }
      // 逐行产出段落：资产格式段落以 \n\n 分隔、段内无换行，「非空行=
      // 段落」与 toParagraphs 对该格式完全等价（同
      // fillRemainingBuiltinChapters 流式路径，有对齐测试锁定）。
      const lines = chunk.split('\n');
      for (const rawLine of lines) {
        const t = rawLine.trim();
        if (!t) {
          continue; // 空行 = 段落分隔
        }
        for (const p of splitLongParagraph(t, MAX_SEGMENT_CHARS)) {
          segCount += 1;
          segs.push({
            id: `${chapterId}-s${segCount}`,
            chapterId,
            order: segCount,
            text: p,
          });
        }
        if (Date.now() - batchT0 >= FILL_TIME_BUDGET_MS) {
          // 行级时间片：超预算让出一帧（触摸/渲染/GC 真正可执行）
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) =>
            setTimeout(resolve, FILL_YIELD_MS),
          );
          batchT0 = Date.now();
        }
      }
    }
    if (readFailed) {
      console.info(
        `[PERF][fill-now] ${bookId} ${chapterId} READ FAILED bytes=${totalBytes} paras=${segs.length}(discarded)`,
      );
      return false; // 全有或全无：丢弃部分产出，防永久截断章
    }
    chapter.segments = segs;
    // 【#20】整章直读完成 → 终态归位：注销该章流式游标（就绪判定回到
    // 「无游标 ⟹ READY_FULL」分支，否则残留游标会让调度器/兜底填充
    // 从 bytePos 0 续作并重复 push 同一批段号 = 正文重复）。
    abandonStreamingAssembly(bookId, chapterId);
    // 【#20 复验追加】标记「整章一次性装配」证明（**必须在 abandon 之后**：
    //   abandon 会撤销证明）。本函数是「整章区间一次读完 + 整体替换」
    //   （全有或全无）⇒ 内容完整性有保证，允许在无游标时判 READY_FULL。
    markChapterWholeReadComplete(bookId, chapterId);
    // 复用填充链路的合并 + 通知语义：重注册书体（LRU 刷新）并通知订阅者
    //（阅读器 hydrateTick / 拼接重试均由进度订阅驱动）
    const hydrate = (
      TextLibraryService as unknown as {
        hydrateBook?: (book: Book) => { success: boolean; error?: string };
      }
    ).hydrateBook;
    if (typeof hydrate === 'function') {
      try {
        // 【T11】陈旧书体快照防护：本函数在 US:1951 捕获了 `bookRes.data`，此后
        // 经过长时流式填充（64KB 分片 + 行级时间片让出）——窗口长度 ∝ 本章正文
        // 体量。窗口内书体**可能已被替换**（典型：阅读器水合 effect 走
        // ensureBookReady → hydrateBuiltinViaMeta，装入「在读章已有正文」的新书体；
        // 亦含 LRU 换形 / 其他 hydrated 写回）。此时若无条件 `hydrate.call(bookRes.data)`
        // 整体装回旧快照，会把**已上屏的正文连同新书体一起丢弃** ⇒ 阅读器
        // chapter memo 重算后 `chapter.segments.length === 0` ⇒ `chapterPending`
        // 翻真 ⇒ 整页 loading（用户报障：「内容加载出来了，但是闪烁一下之后，
        // 变成 loading 页面，loading 完后才正常显示」，仅大章书复现）。
        // 故：写入前重读当前书体；对象未变则逐字保持原行为，已变则**只把本次
        // 真正填好的这一章**落到当前书体上，绝不装回旧快照。
        const curRes = TextLibraryService.getBook(bookId);
        const cur = curRes.success ? curRes.data : null;
        if (cur && cur !== bookRes.data) {
          const curCh = cur.chapters.find((c) => c.id === chapterId);
          if (curCh) {
            curCh.segments = segs;
          }
          hydrate.call(TextLibraryService, cur);
        } else {
          // 未换对象（含从未替换的常态路径）：行为与修复前逐字一致
          hydrate.call(TextLibraryService, bookRes.data);
        }
      } catch {
        // 合并失败不抛出（segments 已就位，下次进入重水合兜底）
      }
    }
    builtinFillListeners.forEach((cb) => {
      try {
        cb(bookId);
      } catch {
        // 单个订阅者异常不影响其余订阅者
      }
    });
    console.info(
      `[PERF][fill-now] ${bookId} ${chapterId} bytes=${totalBytes} ` +
        `paras=${segs.length} readMs=${readMs} totalMs=${Date.now() - t0}`,
    );
    // 【阅读器清理】原 T06 · P0-3「旁路① 注音预热投递」已随注音预热族整体移除
    //   （原实现：`注音预热投递(bookId, chapterId)`）。
    return true;
  } finally {
    chapterFillInFlight.delete(key);
  }
}

/**
 * 跳章邻章预热（保留函数名作兼容薄壳，内部改走统一装配调度器）。
 *
 * r38（T02）行为：
 *  - 向 `ChapterAssemblyScheduler` 提交**双向交错**请求 prev1→next1→prev2→next2
 *    （上滚 P2 / 下滚 P3，跨距 = 档位 `preloadSpan`）：两侧**最近**的边界
 *    同时进入队列，「够到边界前就绪」对两个方向同时成立（用户决策①）；
 *  - 去重/幂等/串行/让出一律由调度器负责（同章并发只执行一次、
 *    已就绪章零成本短路、单 worker 串行、执行器内部按档位分片让出）。
 *
 * 灰度回退（`R38_SCHEDULER_ENABLED=false`）：完整回落 r37 的串行
 * 「前 count 后 count」路径（fillBuiltinChapterNow + 章间让出）。
 */
export async function prefillBuiltinNeighbors(
  bookId: string,
  chapterId: string,
  count = resolvePreloadSpan(),
): Promise<void> {
  // ★2026-10-13（B 档步骤 7）：早退条件按书籍类型分流——用户书无
  //   `BuiltinBookSpec`，此前在此**无条件早退** ⇒ 邻章预热对用户书恒失效。
  //   ⚠ 内置书分支的判据与顺序**逐字未变**（hidden 优先、缺 spec 即退）。
  const isUser = TextLibraryService.isUserBook(bookId);
  const spec = isUser ? null : getBuiltinSpec(bookId);
  if (hiddenBuiltins.has(bookId) || (!isUser && !spec)) {
    return;
  }
  const bookRes = TextLibraryService.getBook(bookId);
  if (!bookRes.success || !bookRes.data) {
    return;
  }
  const chapters = bookRes.data.chapters;
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) {
    return;
  }
  // ★用户书只在「有 toc（= 目录态）」时才提交邻章请求：非超大书路径注册的
  //   用户书仍是全量注册（各章 segments 已在手），提交纯浪费。
  if (isUser && !oversizedBookFiles.has(bookId)) {
    return;
  }
  if (R38_SCHEDULER_ENABLED) {
    // 双向交错序：交错提交保证「两个方向各先拿到最近邻」，同级 FIFO 保序
    // 【T04】第 5 实参 = 波次（距锚点距离 k）：调度器据此让「两侧同距离的邻章」
    // 逐轮交替执行（本循环的提交序即是期望的执行序）。缺省不传 = 旧行为。
    for (let k = 1; k <= count; k += 1) {
      const prevId = idx - k >= 0 ? chapters[idx - k].id : null;
      const nextId = idx + k < chapters.length ? chapters[idx + k].id : null;
      if (prevId) {
        chapterAssemblyScheduler.requestMany(
          bookId,
          [prevId],
          AsmPriority.PrevNeighbor,
          'prev',
          k,
        );
      }
      if (nextId) {
        chapterAssemblyScheduler.requestMany(
          bookId,
          [nextId],
          AsmPriority.NextNeighbor,
          'next',
          k,
        );
      }
    }
    return;
  }
  // —— 灰度回退：r37 串行「前 count 后 count」 ——
  const order: string[] = [];
  for (let k = 1; k <= count; k += 1) {
    if (idx - k >= 0) {
      order.push(chapters[idx - k].id);
    }
  }
  for (let k = 1; k <= count; k += 1) {
    if (idx + k < chapters.length) {
      order.push(chapters[idx + k].id);
    }
  }
  for (const cid of order) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fillBuiltinChapterNow(bookId, cid);
      // 章间让出一帧（r37）：每章完成后的 hydrate + 进度回调（三级缓存
      // 重建 + 可能的整树重渲染）是数百 ms 级同步块，章间不留窗口会把
      // 触摸响应饿死整个预热期（跳远章后「无法滚动」的放大器）。
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) =>
        setTimeout(resolve, FILL_YIELD_MS),
      );
    } catch {
      // 单章预热失败不阻塞其余邻章
    }
  }
}

/**
 * meta 快路径：构建全量章节壳（仅目录级，正文空），并按字节区间切片
 * 装配目标章（优先章/第一章），hydrate 上屏。全文零整读。
 * 任一环节失败返回 false（调用方回退整读扫描慢路径）。
 */
async function hydrateBuiltinViaMeta(
  spec: BuiltinBookSpec,
  meta: BuiltinMetaFile,
  priorityChapterId: string | null,
): Promise<boolean> {
  const hydrate = (
    TextLibraryService as unknown as {
      hydrateBook?: (book: Book) => { success: boolean; error?: string };
    }
  ).hydrateBook;
  if (typeof hydrate !== 'function') {
    return false;
  }
  const bookId = spec.id;
  const shells: BuiltinShell[] = meta.chapters.map((c) => ({
    chapter: { id: c.id, bookId, title: c.t, order: 0, segments: [] },
    bodyLines: [],
    range: { s: c.s, e: c.e },
  }));
  shells.forEach((s, i) => {
    s.chapter.order = i + 1;
  });
  const target =
    shells.find((s) => s.chapter.id === priorityChapterId) ?? shells[0];
  if (!target || !target.range) {
    return false;
  }
  const slice = await readBuiltinChapterRange(
    spec,
    target.range.s,
    target.range.e,
  );
  if (slice === null) {
    return false;
  }
  const paras = toParagraphs(slice);
  target.chapter.segments = paras.map((p, idx) => ({
    id: `${target.chapter.id}-s${idx + 1}`,
    chapterId: target.chapter.id,
    order: idx + 1,
    text: p,
  }));
  // 【#20 复验追加】整章区间一次读完 + 整体安装 ⇒ 完整性有证明
  markChapterWholeReadComplete(bookId, target.chapter.id);
  const regRes = hydrate.call(
    TextLibraryService,
    assembleBuiltinBook(
      spec,
      shells.map((s) => s.chapter),
    ),
  );
  if (!regRes.success) {
    return false;
  }
  // 后台按章切片填充其余章节（复用既有时间片填充与通知链路）
  void fillRemainingBuiltinChapters(spec, shells);
  // 【阅读器清理】原 T06 · P0-5「旁路③ 注音预热投递」已随注音预热族整体移除
  // （原实现：`冷启动注音预热投递(spec.id, target.chapter.id)`）。
  return true;
}

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
      const perfT0 = Date.now();
      ftsQueuePausedUntil = Date.now() + FTS_PAUSE_ON_HYDRATE_MS;
      await yieldToJs();
      const canonicalSize = await ensureBuiltinAssetFresh(spec);
      console.info(
        `[PERF][hydrate] ${spec.id} assetFresh=+${Date.now() - perfT0}ms`,
      );
      // —— meta 快路径：按章切片装配目标章，不整读全文（真机 9MB 级
      // readFile 单次阻塞 JS 11s+ 的根治）；任一环节失败落慢路径 ——
      const meta = await loadBuiltinMeta(spec);
      if (meta && canonicalSize === meta.sizeBytes) {
        const fast = await hydrateBuiltinViaMeta(
          spec,
          meta,
          opts?.priorityChapterId ?? null,
        );
        if (fast) {
          console.info(
            `[PERF][hydrate] ${spec.id} meta-fast ready +${
              Date.now() - perfT0
            }ms`,
          );
          return TextLibraryService.getBook(bookId);
        }
        console.info(
          `[PERF][hydrate] ${spec.id} meta-fast miss → fallback scan`,
        );
      }
      const body = await readBuiltinText(spec);
      console.info(
        `[PERF][hydrate] ${spec.id} read=${body ? body.text.length : 0}ch +${
          Date.now() - perfT0
        }ms`,
      );
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
      const shells = await buildBuiltinChapterShells(bookId, body.text);
      console.info(
        `[PERF][hydrate] ${spec.id} shells=${shells.length} +${
          Date.now() - perfT0
        }ms`,
      );
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
      // 【#20 复验追加】整段正文一次装配 + 整体安装 ⇒ 完整性有证明
      markChapterWholeReadComplete(bookId, target.chapter.id);
      const earlyBook = assembleBuiltinBook(spec, shells.map((s) => s.chapter));
      const reg = (
        TextLibraryService as unknown as {
          hydrateBook?: (book: Book) => { success: boolean; error?: string };
        }
      ).hydrateBook;
      if (typeof reg === 'function') {
        const regRes = reg.call(TextLibraryService, earlyBook);
        console.info(
          `[PERF][hydrate] ${spec.id} hydrate=${
            regRes.success ? 'ok' : 'fail'
          } +${Date.now() - perfT0}ms`,
        );
        if (!regRes.success) {
          return { success: false, error: regRes.error ?? '注册书体失败' };
        }
      }
      // 后台填充：不阻塞首屏 promise（resolve 后阅读器当帧可渲染目标章）
      void fillRemainingBuiltinChapters(spec, shells);
      console.info(
        `[PERF][hydrate] ${spec.id} ready +${Date.now() - perfT0}ms`,
      );
      // 【阅读器清理】原 T06 · P0-5「旁路③ 注音预热投递（整读扫描慢路径）」已随
      // 注音预热族整体移除（原实现：`冷启动注音预热投递(...)`）。
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
 * 分批让出版：切章走 splitRawChaptersChunked（每 2 万行让出），空白
 * 判定（join+trim）每 SHELL_BATCH 章 让出一次——原单块版对 9MB 全程
 * 同步约 1-2s；本函数仅首开快速水合路径调用（ensureBookReady）。
 */
const SHELL_BATCH_CHAPTERS = 40;

/** 内置书章节壳（水合中间态）：meta 快路径带 range（按章切片读），
 * 慢路径（整读扫描）带 bodyLines；填充时二者取一。 */
export interface BuiltinShell {
  chapter: Book['chapters'][number];
  bodyLines: string[];
  range: { s: number; e: number } | null;
  /**
   * 巨章流式装配游标（fill 进程内临时态，不持久化）。meta 壳的章按
   * 「字节分批读 + 逐行产出段落」增量装配：旧实现一次 read 整章 +
   * 一次 toParagraphs——史记的表章（几十万字）单章同步块可达 1s+，
   * 时间片机制（粒度=整章）对其失效。segments 增量 push：首段产出后
   * chapterPending（segments.length===0）即解除，部分内容先渲染，
   * 其余批次继续追加（id 连续 cN-s1..sM，与一次性装配结果一致）。
   */
  fillCursor?: {
    bytePos: number; // 已读字节（相对 range.s）
    carry: string; // 跨批残行（批尾无换行的未完结行）
    pendingLines: string[] | null; // 时间片中断时批内未消费行
    lineIdx: number; // pendingLines 的消费游标
    segCount: number; // 已产出段数
    done: boolean;
    /** 【R2-1】本壳切片读失败次数（读成功即清零）；达上限 → `failedTerminal` */
    failCount: number;
    /** 【R2-1】失败退避截止时间戳（ms）：未到则该壳本轮不可选，防紧循环空转 */
    failBackoffUntil: number;
  };
  /**
   * 【R2-1】切片读**持续失败终态**标记（连续失败达 `FILL_FAIL_TERMINAL_THRESHOLD`）。
   *
   * 与 `fillCursor.done` 语义**严格区分**（这是 R2-1 的核心要求）：
   *  - `done` = 装配到章尾 = READY_FULL —— `isShellComplete` /
   *    `builtinChapterReadiness` / FTS 章级写入的唯一真源；
   *  - `failedTerminal` = 本批放弃重试（**不是**就绪）——上述三处均**不**
   *    因它判 Full、**不**写 FTS；仅让选章判据 `isShellSelectable` 跳过它，
   *    使兜底主循环**必然推进并返回**（终止性：失败章不再被反复选中）。
   *
   * 可自愈（红线⑤意图）：用户重新进入本书 / 上报阅读锚点时由
   * `clearShellFailures` 清除，恢复「可续可重试」。
   */
  failedTerminal?: boolean;
  /**
   * ★ 2026-10-13（B 档步骤 7）：本壳的**字节区间切片读函数**（用户书通道）。
   *
   * 存在理由：`runChapterStreamingStep` 原本硬调 `readBuiltinChapterSlice(opts.spec, …)`
   * ——而 `opts.spec` 是 `BuiltinBookSpec`，**用户书没有它** ⇒ 调度器主路径
   * 对用户书恒早退（实测：邻章永不装配，目录态用户书只能一章一章跳）。
   *
   * ⚠ **内置书壳不写此字段**（`hydrateBuiltinViaMeta` /
   *   `fillRemainingBuiltinChapters` 构造的壳逐字不变）⇒ 缺省时
   *   `runChapterStreamingStep` 走原 `readBuiltinChapterSlice(opts.spec, …)`
   *   分支，**内置书行为零变化**。
   */
  readSlice?: (s: number, e: number) => Promise<BuiltinChapterSliceRead | null>;
}

async function buildBuiltinChapterShells(
  bookId: string,
  text: string,
): Promise<BuiltinShell[]> {
  const normalized = text.replace(/\r\n?/g, '\n');
  const { rawChapters, preface } = await splitRawChaptersChunked(normalized, true);
  const shells: BuiltinShell[] = [];
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
      range: null,
    });
  };
  if (toParagraphs(preface.join('\n')).length > 0) {
    addShell('开篇', preface);
  }
  for (let i = 0; i < rawChapters.length; i += 1) {
    addShell(rawChapters[i].title, rawChapters[i].body);
    if ((i + 1) % SHELL_BATCH_CHAPTERS === 0 && i + 1 < rawChapters.length) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToJs();
    }
  }
  return shells;
}

/**
 * 流式装配的单次推进结果：
 *  - done：游标到达章尾（READY_FULL）；
 *  - progress：本批已消费（时间片耗尽或还有未读批），游标可续 → 调用方下轮续作；
 *  - failed：切片读失败（属**后台填充**语义：按已产出保留并结束本章；
 *    调度器路径的「全有或全无」原语是 fillBuiltinChapterNow，红线⑤不变）。
 */
export type ChapterAssembleStep = 'done' | 'progress' | 'failed';

/** assembleChapterStreaming 可选项（缺省全部取档位参数 → FILL_* 默认值快照） */
export interface AssembleChapterOptions {
  /** 内置书规格（meta 字节区间切片读必需） */
  spec: BuiltinBookSpec;
  /** 单批读取字节上限（缺省 = tier.fillReadChunkBytes） */
  readChunkBytes?: number;
  /** 行级时间片预算（缺省 = tier.fillTimeBudgetMs） */
  timeBudgetMs?: number;
}

/** 流式装配游标登记项：就绪级别判定与「跨批续作」的共同真源 */
interface StreamingEntry {
  shell: BuiltinShell;
  cursor: NonNullable<BuiltinShell['fillCursor']>;
}

/**
 * 流式装配游标登记表（`bookId:chapterId` → 壳 + 游标）。
 * 用途：① 调度器路径按需创建/续作壳；② 就绪级别判定（游标未 done = Partial）。
 * 游标 done 后不再有搬运成本（对象极小，随水合生命周期回收）。
 */
const streamingEntries = new Map<string, StreamingEntry>();

function streamingKeyOf(bookId: string, chapterId: string): string {
  return `${bookId}:${chapterId}`;
}

/**
 * 【#20】「同章装配」的重入合并表（`bookId:chapterId` → 在飞 Promise）。
 *
 * 为什么必须有：装配原语 `assembleChapterStreaming` 有**两个并发调用方**——
 *  ① 调度器单 worker（`assembleChapterToFull` 内的推进循环）；
 *  ② 兜底填充主循环（`fillRemainingBuiltinChapters` 直接 `await
 *     assembleChapterStreaming(shell, { spec })`）。
 * 调度器的「单 worker 串行」（INV-1）只约束**调度器自己**的队列，对 ② 毫无
 * 约束力；而 ①② 可能同时命中同一章、同一个壳。游标（`cur.bytePos` /
 * `cur.segCount`）是**共享**对象，而「读切片」是整步里唯一的 await 点：
 * 两个在飞步会读到同一区间、各 push 一遍 → **段号重复、正文重复**
 * （`cur.segCount += 1` 读的是共享值，第二遍续编出 s101…）。
 * 本表把同章在飞步合并成同一个 Promise：后来者**复用**在飞结果，
 * 不重复读、不重复 push、不重复写 FTS / 发事件。
 *
 * 与「游标自洽校验」（`cur.segCount !== segments.length` → 自弃）的分工：
 *  - 自洽校验处理**串行**的失效（章内容被整体替换过，游标语义作废）；
 *  - 本表处理**并行**的互踩（同一时刻两个装配者）。
 * 两者互补，缺一都会产生重复正文。
 */
const streamingStepInFlight = new Map<string, Promise<ChapterAssembleStep>>();
const fullAssembleInFlight = new Map<string, Promise<boolean>>();

/**
 * 按 key 合并同章在飞调用：命中即复用；未命中则以 `run()` 为唯一执行体，
 * settle 后自表内摘除（用「promise 身份比较」防止误删后来者的在飞项）。
 * 失败照原样向上抛（合并不吞异常：调用方语义不变）。
 */
function coalesceAssemblyRun<T>(
  table: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = table.get(key);
  if (existing) {
    return existing;
  }
  let guarded: Promise<T> | null = null;
  const release = (): void => {
    if (guarded !== null && table.get(key) === guarded) {
      table.delete(key);
    }
  };
  const settled = run().then(
    (value) => {
      release();
      return value;
    },
    (error: unknown) => {
      release();
      throw error;
    },
  );
  guarded = settled;
  table.set(key, settled);
  return settled;
}

/**
 * 【#20 复验追加】「整章一次性装配」完整性证明（provenance）。
 *
 * 背景（QA 真机复验抓到的回归）：`ready-full ch=tongjian-c169 bytes=34663 paras=148`
 * / `paras=105`（oracle 156 / 106），同章另一次装配是完整的 ⇒ **间歇性丢段且被
 * 标成 ready-full**。离线复算：单壳单游标走 32KB 多批在真实资产上**逐段等于
 * 整章直读**（`chapterStreamingRealAssets.test.ts` 5/5 绿）⇒ 丢段不在这条逻辑里，
 * 而在「同一章被两个装配者/两个章对象交叉推进」时 `segCount` 与实际
 * `segments.length` 脱钩 —— 旧实现在脱钩时**直接判 `done`**（`releaseChapterCursor`
 * + `fillCursor === undefined ⟹ 视作已定`），把「未证实完整」当成「已完整」。
 *
 * 本集合记录「该章当前的 `segments` 是**一次性的整章装配**（整章直读 / 整段正文
 * 装配）整体安装的结果，且此后没有被增量 push 触碰过」——只有这种状态才允许在
 * **没有游标**的情况下判定 READY_FULL。增量 push 或接管会撤销证明。
 */
const chapterWholeReadComplete = new Set<string>();

/** 记录「整章一次性装配完成」（成功安装 `segments` 后调用） */
function markChapterWholeReadComplete(bookId: string, chapterId: string): void {
  chapterWholeReadComplete.add(streamingKeyOf(bookId, chapterId));
}

/** 撤销完整性证明（增量 push / 接管 / 放弃装配时调用） */
function unmarkChapterWholeReadComplete(bookId: string, chapterId: string): void {
  chapterWholeReadComplete.delete(streamingKeyOf(bookId, chapterId));
}

/**
 * 【#20 复验追加】「完整性未证」时的整章直读补全（含退避，防新空转）。
 *
 * 触发场景：检测到 `segCount ≠ segments.length`（内容存在但不知道完整没完整），
 * 且无 provenance。处置 = 用**冷启动已验证可用**的整章直读整体替换 `segments`
 * （红线⑤全有或全无），成功后自然带上 provenance ⇒ 后续判据全部一致。
 *
 * 退避理由：若读通道真的坏了（整章直读也失败），不能让邻居预热/调度器每次
 * 请求都付一次整章读的代价——那正是「新的空转」。退避窗口内直接返回 false
 * （廉价失败），由**用户可见的重试链**（`retryChapterAssembly` /
 * `degradeChapterToWholeRead` 会清退避）负责最终收敛。
 */
const chapterRepairFailCount = new Map<string, number>();
const chapterRepairBackoffUntil = new Map<string, number>();
const REPAIR_BACKOFF_BASE_MS = 500;
const REPAIR_BACKOFF_MAX_MS = 8000;

/** 清退避（用户可见重试 / 显式降级 = 用户意图，立即重试） */
function clearChapterRepairBackoff(bookId: string, chapterId: string): void {
  const key = streamingKeyOf(bookId, chapterId);
  chapterRepairFailCount.delete(key);
  chapterRepairBackoffUntil.delete(key);
}

async function repairChapterByWholeRead(
  bookId: string,
  chapterId: string,
): Promise<boolean> {
  const key = streamingKeyOf(bookId, chapterId);
  const until = chapterRepairBackoffUntil.get(key) ?? 0;
  if (Date.now() < until) {
    return false; // 退避窗口内：廉价失败，不做整章读
  }
  const ok = await fillBuiltinChapterNow(bookId, chapterId, true);
  if (ok) {
    clearChapterRepairBackoff(bookId, chapterId);
    return true;
  }
  const n = (chapterRepairFailCount.get(key) ?? 0) + 1;
  chapterRepairFailCount.set(key, n);
  const backoff = Math.min(REPAIR_BACKOFF_BASE_MS * 2 ** (n - 1), REPAIR_BACKOFF_MAX_MS);
  chapterRepairBackoffUntil.set(key, Date.now() + backoff);
  console.info(
    `[PERF][asm] repair-fail ch=${chapterId} n=${n} backoff=${backoff}ms`,
  );
  return false;
}

/**
 * 游标与章内实际段数脱钩的统一处置（入口 / 读后两处共用）。
 *
 * - 有 provenance（内容由整章一次性装配整体安装）⇒ 判 `'done'`（真·完整）；
 * - 否则**绝不判完成**：先撤销游标，再整章直读补全；补全成功 ⇒ `'done'`，
 *   失败 ⇒ `'failed'`（就绪停 Partial ⇒ 阅读器提示条 + 重试出口，不再静默）。
 */
async function resolveCursorMismatch(
  shell: BuiltinShell,
  cur: NonNullable<BuiltinShell['fillCursor']>,
  where: 'entry' | 'after-read',
): Promise<ChapterAssembleStep> {
  const bookId = shell.chapter.bookId;
  const chapterId = shell.chapter.id;
  const segCount = shell.chapter.segments.length;
  console.info(
    `[PERF][asm] cursor-mismatch ch=${chapterId} at=${where} ` +
      `cur.segCount=${cur.segCount} segments=${segCount} bytePos=${cur.bytePos} ` +
      `carry=${cur.carry.length} proven=${chapterWholeReadComplete.has(
        streamingKeyOf(bookId, chapterId),
      )} → ${chapterWholeReadComplete.has(streamingKeyOf(bookId, chapterId)) ? '按整章装配完成' : '整章直读补全'}`,
  );
  const proven = chapterWholeReadComplete.has(streamingKeyOf(bookId, chapterId));
  releaseChapterCursor(shell);
  if (proven) {
    return 'done'; // 内容已由整章装配整体安装 ⇒ 完整
  }
  const repaired = await repairChapterByWholeRead(bookId, chapterId);
  return repaired ? 'done' : 'failed';
}

function ensureStreamingEntry(shell: BuiltinShell): StreamingEntry | null {
  const key = streamingKeyOf(shell.chapter.bookId, shell.chapter.id);
  const existing = streamingEntries.get(key);
  if (existing && existing.shell === shell) {
    return existing;
  }
  if (existing && existing.shell.chapter === shell.chapter) {
    // 同章**同对象**、不同壳（例如 ctx 壳与调度器壳并存）：可以安全共享同一游标
    // ——两者写入的是同一个 `segments` 数组，游标语义一致。
    shell.fillCursor = existing.cursor;
    return existing;
  }
  if (existing) {
    // ★★【#20 复验追加·根因】同章但**章对象不同**（重水合/重水化重建了章对象，
    //   旧壳仍持有旧对象）。旧实现无条件 `return existing`：把 A 壳（新对象）的
    //   游标交给 B 壳（旧对象）续作 ⇒ `cur.segCount` 计的是**两个数组的混合
    //   push 数**，与任一 `segments.length` 都对不上 ⇒ 自洽校验误触发 ⇒ 旧代码
    //   判 `done` ⇒ `ready-full` 但**正文只到某一批**（真机 c169 paras=148、
    //   c166 paras=105 的签名）。处置：**游标绝不跨章对象共享**；旧登记作废
    //   （它的章对象已非书体真源），由本次调用的壳接管。
    existing.shell.fillCursor = undefined;
    unmarkChapterWholeReadComplete(
      existing.shell.chapter.bookId,
      existing.shell.chapter.id,
    );
    streamingEntries.delete(key);
  }
  // 陈旧壳防护：调用的壳若已不是书体里的那个章对象（书被重建/已换形），
  // 它的 push 只会落进**孤儿数组**（用户永远看不到）= 纯浪费 + 制造游标混乱。
  // 直接拒绝（返回 null），由持有书体章对象的装配者负责该章。
  const liveBook = TextLibraryService.getBook(shell.chapter.bookId);
  const liveChapter =
    liveBook.success && liveBook.data
      ? liveBook.data.chapters.find((c) => c.id === shell.chapter.id)
      : undefined;
  if (liveChapter && liveChapter !== shell.chapter) {
    console.info(
      `[PERF][asm] stale-shell ch=${shell.chapter.id} → 拒绝装配（章对象已非书体真源）`,
    );
    return null;
  }
  const cursor = (shell.fillCursor ??= {
    bytePos: 0,
    carry: '',
    pendingLines: null,
    lineIdx: 0,
    segCount: 0,
    done: false,
    failCount: 0,
    failBackoffUntil: 0,
  });
  const entry: StreamingEntry = { shell, cursor };
  streamingEntries.set(key, entry);
  return entry;
}

/**
 * 【#20】注销某壳的流式游标（登记表 + 壳上的 `fillCursor` 一并清除）。
 *
 * 语义：该章退回「**无游标**」，就绪判定走 `isShellComplete` /
 * `builtinChapterReadiness` 的「segments 非空 ⟹ READY_FULL」分支。
 * 使用场景：① 游标自洽校验发现 `segCount` 与 `segments.length` 不符
 * （章内容被整体替换过，游标语义失效）；② 整章直读成功后收回所有权。
 * 清除 `failedTerminal` 同理：失败锁存属于「流式装配」，游标既已作废，
 * 锁存不得残留（否则选章判据会永久跳过该章）。
 */
function releaseChapterCursor(shell: BuiltinShell): void {
  streamingEntries.delete(streamingKeyOf(shell.chapter.bookId, shell.chapter.id));
  shell.fillCursor = undefined;
  shell.failedTerminal = false;
}

/**
 * 【#20】把某章的装配所有权切回「**整章直读**」。
 *
 * 为什么需要：同一章有两条独立装配实现——调度器流式（`assembleChapterStreaming`，
 * 分批读 + 增量 push）与整章直读（`fillBuiltinChapterNow`，一次读 + 整体替换
 * `chapter.segments`）。两者并发时旧实现会互踩：整体替换数组后，在飞流式步
 * 仍从 bytePos/segCount 续作 → 重复 push 同一批段号（正文重复）。
 * 本函数在整章直读**开始前**收回所有权（注销登记 + 清壳游标），配合
 * `assembleChapterStreaming` 的游标自洽校验，使在飞流式步自弃。
 *
 * 不动的：已产出的 `segments`（部分内容不丢，由整章直读结果整体替换）。
 */
function abandonStreamingAssembly(bookId: string, chapterId: string): void {
  const key = streamingKeyOf(bookId, chapterId);
  // 【#20 复验追加】收回所有权即撤销「整章一次性装配」证明：此后 `segments`
  //   是否完整**未知**（调用方通常会紧接着做整章直读/整体替换，完成时会重新标记）。
  unmarkChapterWholeReadComplete(bookId, chapterId);
  const entry = streamingEntries.get(key);
  if (entry) {
    // ★【#20】登记项的壳**本身**也要收回游标（不止删登记）：
    //   调度器路径自建的壳（`{ chapter, bodyLines, range }`）只存在于登记表里，
    //   整章直读用 `chapter.segments = segs` **整体替换**之后，就绪判定
    //   （`builtinChapterReadiness`）读的正是这个壳上的游标——残留的
    //   「游标未 done」会让该章永远停在 Partial → 调度器反复重请求（空转），
    //   且 `getChapterContentQuality` 会误报 incomplete（伪截断提示）。
    entry.shell.fillCursor = undefined;
    entry.shell.failedTerminal = false;
    streamingEntries.delete(key);
  }
  const ctx = fillContexts.get(bookId);
  if (!ctx) {
    return;
  }
  for (const shell of ctx.shells) {
    if (shell.chapter.id !== chapterId) {
      continue;
    }
    shell.fillCursor = undefined;
    shell.failedTerminal = false;
  }
}

/**
 * 【#20】清除某书（或某章）的**全部**失败锁存。
 *
 * 关键：同一章在装配层有**两个不同对象**的「壳」——
 *  ① 兜底填充上下文里的壳（`fillContexts[*].shells`）；
 *  ② 调度器路径的流式壳（`streamingEntries[*].shell`，`assembleChapterToFull`
 *     自建 `{ chapter, bodyLines, range }` 并登记）。
 * `failedTerminal` / `failCount` 落在**各自的对象**上——旧实现只清 ①，
 * 于是调度器路径的失败终态**永不解除**：`isShellSelectable` 跳过、就绪判定
 * 仍 Empty，用户 BACK 重进同书照样空白，只有杀进程（冷启动全新建壳）能恢复
 * （QA #19 会话级锁存实证）。本函数把两类壳一并清除，恢复「可续可重试」
 * （红线⑤），且**不改变**「失败终态 ≠ 就绪」的语义（只清锁存，不写内容）。
 */
function clearAssemblyFailures(bookId: string, chapterId?: string): void {
  const match = (id: string): boolean => !chapterId || id === chapterId;
  const ctx = fillContexts.get(bookId);
  if (ctx) {
    clearShellFailures(ctx.shells.filter((s) => match(s.chapter.id)));
  }
  for (const key of Array.from(streamingEntries.keys())) {
    if (!key.startsWith(`${bookId}:`)) {
      continue;
    }
    const entry = streamingEntries.get(key);
    if (!entry || !match(entry.shell.chapter.id)) {
      continue;
    }
    if (entry.shell.failedTerminal === true) {
      entry.shell.failedTerminal = false;
    }
    const cur = entry.cursor;
    if (cur.failCount > 0 || cur.failBackoffUntil > 0) {
      cur.failCount = 0;
      cur.failBackoffUntil = 0;
    }
  }
}

export async function assembleChapterStreaming(
  shell: BuiltinShell,
  opts: AssembleChapterOptions,
): Promise<ChapterAssembleStep> {
  // ★【#20】单章串行化（INV-2 的执行层兜底，见 `streamingStepInFlight` 注释）：
  //   同章在飞期间，后来者复用同一 Promise —— 不重复读切片、不重复 push 段。
  return coalesceAssemblyRun(
    streamingStepInFlight,
    streamingKeyOf(shell.chapter.bookId, shell.chapter.id),
    () => runChapterStreamingStep(shell, opts),
  );
}

/**
 * 流式装配状态机单步的**真实实现**（不做重入合并；唯一调用方是上面那层
 * 合并包装，故无第二装配者能与之并发命中同一游标）。
 * 原 r38 T02 由 fillRemainingBuiltinChapters 提炼，逐字保持：
 *  - 64KB 分批读（档位化 fillReadChunkBytes）：巨章（史记表章级几十万字）
 *    整章一次 read + toParagraphs 是秒级连续同步块，分批后单块 ≈ 单行切分；
 *  - **carry 跨批未完结行防护**：批尾无换行时整批留 carry（半行当段落产出
 *    会造成内容切分错误，r34 已有 7 类文本 × 5 种批大小对拍守卫）；
 *  - 「**非空行 = 段落**」：资产格式段落以 \n\n 分隔、段内无换行，逐行 trim
 *    后非空即一段（与 toParagraphs 对该格式等价，有对齐测试锁定），
 *    超长段落仍经 splitLongParagraph(MAX_SEGMENT_CHARS) 切分；
 *  - 行级时间片（档位 fillTimeBudgetMs）：超预算即把余行留在 pendingLines
 *    返回 'progress'，由调用方让出后续作（单块上限 ≈ 一行切分耗时）；
 *  - 段落**增量 push**：首段产出后 segments.length > 0，目标章可先上屏。
 * 耗时读（RNFS 切片）之外的 JS 段严格同步，节奏由调用方控制（无内部墙钟等待）。
 */
async function runChapterStreamingStep(
  shell: BuiltinShell,
  opts: AssembleChapterOptions,
): Promise<ChapterAssembleStep> {
  if (!shell.range) {
    return 'failed'; // 慢路径壳（整读扫描产物）不走流式
  }
  const tier = resolveFillTierParams();
  const readChunkBytes = pickTierNumber(opts.readChunkBytes, tier.readChunkBytes);
  const timeBudgetMs = pickTierNumber(opts.timeBudgetMs, tier.timeBudgetMs);
  const entry = ensureStreamingEntry(shell);
  if (entry === null) {
    // 陈旧壳（章对象已非书体真源）：不装配、不 push 孤儿数组。
    // 返回 'failed' 而非 'progress'：调用方（兜底填充/调度器）据此**推进到其他章**，
    // 不会对同一壳紧循环重试（无新空转）；该章由持有书体对象的装配者负责。
    return 'failed';
  }
  const cur = entry.cursor;
  if (cur.done) {
    return 'done';
  }
  // ★【#20】游标自洽校验（入口）：游标记录的已产出段数必须等于章内实际段数。
  //   不等 ⟺ 该章 `segments` 被**整体替换**过（整章直读接管 `fillBuiltinChapterNow`
  //   / 降级直读）或被另一个装配者 push 过——游标语义已失效，继续按
  //   bytePos/segCount 续作会**重复 push 同一批段号**（正文重复上屏）。
  //   ★【#20 复验追加】处置改为 `resolveCursorMismatch`：有「整章一次性装配」证明
  //   才判完成，否则整章直读补全 / 判失败（Partial + 阅读器提示条），
  //   **绝不**把「未证实完整」当「已完整」（真机 c169/c166 丢段却标 ready-full 的根因）。
  if (cur.segCount !== shell.chapter.segments.length) {
    return await resolveCursorMismatch(shell, cur, 'entry');
  }
  const totalBytes = shell.range.e - shell.range.s;
  // ① 取本批行集合：中断余量 → 上批续；否则读新批（批尾残行经 carry 跨批）
  let lines: string[];
  if (cur.pendingLines) {
    lines = cur.pendingLines;
    cur.pendingLines = null; // lineIdx 保留续用
  } else {
    if (cur.bytePos >= totalBytes && !cur.carry) {
      cur.done = true;
      return 'done';
    }
    const want = Math.min(readChunkBytes, totalBytes - cur.bytePos);
    let slice = '';
    if (want > 0) {
      // ★2026-10-13（B 档步骤 7 · 调度器主路径泛化）：壳自带切片器优先
      //   （用户书通道，`.gxbook.toc` 字节区间）；**内置书壳不写该字段**
      //   ⇒ 下面 else 分支与优化前逐字一致（`readBuiltinChapterSlice` 照旧）。
      const sliceFrom = shell.range.s + cur.bytePos;
      const sliceTo = sliceFrom + want;
      const r = shell.readSlice
        ? await shell.readSlice(sliceFrom, sliceTo)
        : await readBuiltinChapterSlice(opts.spec, sliceFrom, sliceTo);
      if (r === null) {
        // ★ D1 截断防护：切片读失败**绝不置 `cur.done`**。
        //   置 done 会把「已产出但内容截断」的章标成 READY_FULL——
        //   `isShellComplete`（fillCursor.done === true）与
        //   `builtinChapterReadiness`（游标 done → Full）双双判其已就绪，
        //   调度器 `request()` 因此短路、后台填充因此跳过，**永不重试**
        //   = 不可逆截断章（r37 目标章走 fillBuiltinChapterNow 的
        //   「失败可自愈」语义，此处不得退化，红线⑤/§11）。
        //   保留 bytePos / carry / segCount / 已产出段落：
        //   下次进入自同一 bytePos 续读，进度不丢、段落不重（段号续编）。
        //
        // ★ R2-1 终止性（D1 的必要配套）：只去掉 `done` 会让选章判据
        //   （未就绪即候选）**每次都重新选中同一失败章** → 兜底主循环
        //   紧循环空转烧 CPU（QA 实证：700ms 内 read 调用 17.5 万 → 51 万，
        //   不收敛，且 `ctx.running` 永不复位、后续章永不填充）。
        //   故失败必须留下「失败进展」证据：
        //   - 未达上限 → 记退避截止（**指数**递增间隔），窗口内该壳不可选；
        //   - 达上限 → 标记 `failedTerminal`（**非就绪**，仅让选章跳过）
        //     —— 此后主循环**必然推进**到其他章或返回。
        cur.failCount += 1;
        if (cur.failCount >= FILL_FAIL_TERMINAL_THRESHOLD) {
          shell.failedTerminal = true;
        } else {
          // 【#20】退避由线性（250·n）改为指数（250→500→1000，封顶 4s）：
          // 失败之间绝不紧循环空转；且失败锁存可被「用户重新挂到本书上 /
          // 显式重试」清除（见 clearAssemblyFailures），重试时机由用户意图
          // 与长空闲驱动，而不是固定短间隔的自动轮询。
          cur.failBackoffUntil =
            Date.now() +
            Math.min(
              FILL_FAIL_BACKOFF_MS * 2 ** (cur.failCount - 1),
              FILL_FAIL_BACKOFF_MAX_MS,
            );
        }
        return 'failed';
      }
      slice = r.text;
      // ★【#20】按**实际消费字节数**推进：r.consumed ≤ want（尾部不完整
      //   多字节字符被裁到上一字符边界，至多 -3）。用请求量推进会跳过被裁
      //   的 1~3 字节（丢字）；不多推则下一个切片自然自真正边界起读。
      cur.bytePos += Math.min(r.consumed, want);
      // R2-1：读成功即证明读通道恢复 → 清失败计数与退避（自愈，红线⑤）
      cur.failCount = 0;
      cur.failBackoffUntil = 0;
    }
    // ★【#20】游标自洽校验（读后）：切片读 await 期间，该章 `segments` 可能
    //   被「整章直读/降级直读」整体替换，或被另一个装配者 push——旧实现在此处
    //   照常续 push，会把同一批段号再产出一遍（正文重复）。
    //   ★【#20 复验追加】处置改为 `resolveCursorMismatch`：**绝不无条件判完成**
    //   （旧实现 `segments.length > 0 ? 'done'` 会把「未证实完整」当「已完整」，
    //   正是真机 c169 paras=148 / c166 paras=105 被标 ready-full 的路径）。
    if (cur.segCount !== shell.chapter.segments.length) {
      return await resolveCursorMismatch(shell, cur, 'after-read');
    }
    let chunk = cur.carry + slice;
    cur.carry = '';
    if (cur.bytePos < totalBytes) {
      // 批尾未完结行留到下批（行跨批截断防护）：整批无换行时
      // 全部留 carry——半行当段落产出会造成内容切分错误
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl >= 0) {
        cur.carry = chunk.slice(lastNl + 1);
        chunk = chunk.slice(0, lastNl + 1);
      } else {
        cur.carry = chunk;
        chunk = '';
      }
    }
    lines = chunk.split('\n');
    cur.lineIdx = 0;
  }
  // ② 逐行产出段落：资产格式段落以 \n\n 分隔、段内无换行，「非空行=段落」
  //    与 toParagraphs 对该格式完全等价；行级时间检查保证单块 ≤ 一行切分耗时
  // ★【#20 复验追加】增量 push 即撤销「整章一次性装配」证明：此后 `segments`
  //   只是**部分产出**，不允许在无游标时被当成完整（详见 chapterWholeReadComplete）。
  //   注意判据是「本批**真的**有非空行待产出」而不是 `lines.length > 0`
  //   （`''.split('\n')` 恒为 `['']`，长度恒 ≥1 ⇒ 空批也会撤销证明 ⇒
  //   下一次判据误判「未证实」⇒ 白付一次整章直读，纯浪费）。
  if (lines.some((line) => line.trim() !== '')) {
    unmarkChapterWholeReadComplete(shell.chapter.bookId, shell.chapter.id);
  }
  const segs = shell.chapter.segments;
  const batchT0 = Date.now();
  let exhausted = true;
  for (; cur.lineIdx < lines.length; cur.lineIdx += 1) {
    const t = lines[cur.lineIdx].trim();
    if (!t) {
      continue; // 空行 = 段落分隔
    }
    for (const p of splitLongParagraph(t, MAX_SEGMENT_CHARS)) {
      cur.segCount += 1;
      segs.push({
        id: `${shell.chapter.id}-s${cur.segCount}`,
        chapterId: shell.chapter.id,
        order: cur.segCount,
        text: p,
      });
    }
    if (Date.now() - batchT0 >= timeBudgetMs) {
      // 行级时间片：余行留在 pendingLines 下批续处理
      exhausted = false;
      cur.lineIdx += 1; // 当前行已产出，指针前进
      cur.pendingLines = lines;
      break;
    }
  }
  if (!exhausted) {
    return 'progress';
  }
  cur.lineIdx = 0;
  if (cur.bytePos >= totalBytes && !cur.carry) {
    // R2-1：本章装配到章尾 → 失败状态彻底清除（终态标记不得残留到就绪态）
    cur.done = true;
    cur.failCount = 0;
    cur.failBackoffUntil = 0;
    shell.failedTerminal = false;
    return 'done';
  }
  return 'progress';
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
 * 后台时间片填充剩余章节：逐章装配，每章完成检查耗时，超过
 * FILL_TIME_BUDGET_MS（12ms）即让出 JS 并把合并后的书体重新 hydrate
 *（引用替换使 TextLibraryService 缓存正确失效）+ 通知订阅者。
 * 正文来源双轨：meta 快路径壳带 range（按章切片读，零整读），慢路径壳
 * 带 bodyLines（整读扫描产物）；有 range 优先切片。
 * 填充即用户活动，期间持续压住 FTS 队列门闩；全部完成后书体在内存，
 * 顺带补 FTS 索引（分片异步）。失败静默中止（空壳章保留，重进该书
 * 重新走 ensureBookReady 水合）。
 * 通知节流：合并每片都做（引用替换廉价），订阅者通知（触发阅读器
 * 重渲染）按 FILL_NOTIFY_THROTTLE_MS 节流 + 尾片必达。
 */
async function fillRemainingBuiltinChapters(
  spec: BuiltinBookSpec,
  shells: BuiltinShell[],
): Promise<void> {
  const fillPerfT0 = Date.now();
  /**
   * 本轮填充上下文（try 外声明：finally 必须复位 `running`——
   * 否则中途异常会让本书的兜底推进被单飞守卫永久阻塞）。
   */
  let ctx: BuiltinFillContext | null = null;
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
    // 时间片驱动（替代固定 30 章/批）：每批装配后检查耗时，超过
    // FILL_TIME_BUDGET_MS 即让出 JS 并 hydrate+通知。meta 壳走「流式
    // 装配」：字节分批读（FILL_READ_CHUNK_BYTES）+ 逐行产出段落，
    // 行级时间检查——巨章（史记表章级几十万字）单章一次装配可达 1s+，
    // 「粒度=整章」的旧时间片对其失效；流式后单块上限 ≈ 单行切分（毫秒级）。
    // 慢路径壳（bodyLines，整读扫描产物）保持一次性装配。
    // r38 T01：让出与通知节流改为档位参数读取（读失败回落上面的默认值快照）
    const fillTier = resolveFillTierParams();
    let sliceFilled = 0;
    let sliceStart = Date.now();
    let lastNotifyAt = 0;
    // 片内分解计时（诊断填充期 jsBlocked 的连续饱和块来源）
    let sliceChapterMs = 0;
    let sliceHeaviestChapterMs = 0;
    // ★ r38 T03：`let i = 0; while (i < shells.length)` 的「打开书即从第 1 章
    //   无条件按书序推进」主循环已移除——下一个该装配的章由
    //   `scheduleBookOrderFallback(ctx)` 决定：取消令牌（跳章/切书立即中止）
    //   + 空闲门（手势/loading/跳章装配中不推进）+ 锚点邻近扩散（±k 双向交错）
    //   + 书序兜底（自锚点前推，锚点已知时等档位 bookOrderFallbackIdleMs）。
    const active = ensureFillContext(spec, shells, hydrate);
    if (active.running) {
      return; // 单飞：同书至多一轮兜底推进在飞（空闲心跳与主链路互斥）
    }
    ctx = active;
    active.running = true;
    active.token = fillGeneration;
    active.hydrate = hydrate;
    builtinFillInFlight.add(spec.id);
    // 【R2-1】迭代上限（终止性双保险，见 FILL_MAX_ITERATIONS_PER_ROUND）
    let iterations = 0;
    for (;;) {
      iterations += 1;
      if (iterations > FILL_MAX_ITERATIONS_PER_ROUND) {
        console.info(
          `[PERF][fill] ${spec.id} iteration-cap=${iterations} → 中止本轮（终止性护栏）`,
        );
        break;
      }
      const idx = scheduleBookOrderFallback(active);
      if (idx < 0) {
        break; // 取消 / 空闲门关闭 / 已无未完整章
      }
      const shell = shells[idx];
      active.inProgress = idx;
      // 填充期间压住 FTS 队列（片间检查点生效），完成后留 10s 收尾缓冲
      ftsQueuePausedUntil = Math.max(
        ftsQueuePausedUntil,
        Date.now() + FTS_PAUSE_ON_HYDRATE_MS,
      );
      const chapterT0 = Date.now();
      if (shell.range) {
        // —— meta 壳：流式装配（r38 T02 提炼为 assembleChapterStreaming，
        //    与调度器流式路径共用同一状态机：档位化分批读 + 行级时间片 +
        //    carry 跨批防护 + 「非空行=段落」+ 游标可续）——
        // eslint-disable-next-line no-await-in-loop
        const step = await assembleChapterStreaming(shell, { spec });
        // 'progress' = 本章未完成（时间片耗尽 / 还有未读批）→ 不前进，下轮续作；
        // 'done' = 装配到章尾（READY_FULL）；'failed' = 切片读失败
        //（按已产出保留 + 记失败退避/终态，**不是**就绪）。
        //
        // ★ R2-2 FTS 门控与调度器路径对齐：**仅 READY_FULL 才写**。
        //   旧实现 `if (step !== 'progress')` 把 'failed' 也算进去 → 给
        //   Partial/失败章写了章级 FTS 行，而调度器路径（`if (full)`）不写，
        //   两条路径语义不一致：搜索会命中「尚未上屏的整章」，且
        //   `isBookFullyIndexedInFts` 的**计数判据**会把只索引了部分段落的
        //   书误判为「整本已索引」→ 整书补写被永久跳过（真·缺章）。
        if (
          step === 'done' &&
          (shell.fillCursor?.done === true ||
            chapterWholeReadComplete.has(
              streamingKeyOf(spec.id, shell.chapter.id),
            )) &&
          shell.failedTerminal !== true
        ) {
          // 【#22】第二支 = 「就绪」由**整章一次性装配**证明（含本步内
          //   `resolveCursorMismatch` 的整章直读补全）：内容完整才写 FTS，
          //   与上面的门控口径一致（未证实内容绝不入索引）。
          writeFtsForReadyChapter(spec, shell);
          // 【r40 F1 探针②】书序/扩散后台路径的**真实章计数**：本区间此前零
          // `[PERF][asm]`，而 `[PERF][fill-slice]` 的 `chapters=` 是**装配迭代数**
          // 不是章数（UBS:2974 每轮无条件 +1，含 'progress' 未完成轮）。故单列
          // 「每装配完一章一行」。真章计数 = 本行 ∪ (`[PERF][asm] ready-full` UBS:5369)。
          console.info(
            `[PERF][fill] chapter-done ch=${shell.chapter.id} gen=${fillGeneration}`,
          );
          // 【阅读器清理】原 T06 · P0-4「旁路②（流式支）注音预热」已随注音预热族
          //   整体移除（原实现：`注音预热投递(spec.id, ...)`）。
          active.inProgress = -1;
        } else if (step !== 'progress') {
          // failed：本章本批结束（不进就绪、不写 FTS），让选章前进到其他章
          active.inProgress = -1;
        }
      } else {
        // —— 慢路径壳（整读扫描产物，历史路径保持一次性装配）——
        const bodyText = shell.bodyLines.join('\n');
        const paras = toParagraphs(bodyText);
        shell.chapter.segments = paras.map((p, idx) => ({
          id: `${shell.chapter.id}-s${idx + 1}`,
          chapterId: shell.chapter.id,
          order: idx + 1,
          text: p,
        }));
        // ★ r38 T03：一次性装配完成即章就绪 → FTS 章级增量写入
        // 【#20 复验追加】整段正文一次装配 + 整体安装 ⇒ 完整性有证明
        markChapterWholeReadComplete(spec.id, shell.chapter.id);
        writeFtsForReadyChapter(spec, shell);
        // 【r40 F1 探针②】慢路径「一次性装配完成 = 一章就绪」，与流式分支同口径
        console.info(
          `[PERF][fill] chapter-done ch=${shell.chapter.id} gen=${fillGeneration}`,
        );
        // 【阅读器清理】原 T06 · P0-4「旁路②（慢路径支）注音预热」已随注音预热族
        //   整体移除（原实现：`注音预热投递(spec.id, ...)`）。
        active.inProgress = -1;
      }
      active.lastProgressAt = Date.now();
      const chapterMs = Date.now() - chapterT0;
      sliceChapterMs += chapterMs;
      sliceHeaviestChapterMs = Math.max(sliceHeaviestChapterMs, chapterMs);
      sliceFilled += 1;
      if (Date.now() - sliceStart >= FILL_TIME_BUDGET_MS) {
        // 片间让出一帧：tap/触摸/渲染/GC 获得真正可用的执行窗口
        //（setTimeout(0) 仅 1-4ms，填充近乎连续占用 JS——见 FILL_YIELD_MS）
        // r38 T01：让出时长读档位参数（低端机 24ms 更慷慨，防 JS 饱和）
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) =>
          setTimeout(resolve, fillTier.yieldMs),
        );
        const now = Date.now();
        // 合并 + 通知一起节流：assemble/hydrate（垃圾 + 三级缓存置空）
        // 与通知（阅读器整树重渲染）都是频率的线性成本；尾片必达。
        // 跳章到「已装配未通知」的章由 segments 直查 + fillBuiltinChapterNow
        // 链路兜底，不受节流影响。
        if (
          sliceFilled > 0 &&
          typeof hydrate === 'function' &&
          now - lastNotifyAt >= fillTier.notifyThrottleMs
        ) {
          lastNotifyAt = now;
          const mergeT0 = Date.now();
          const merged = assembleBuiltinBook(
            spec,
            shells.map((s) => s.chapter),
          );
          try {
            hydrate.call(TextLibraryService, merged);
          } catch {
            // 单片合并失败不中止（空壳保留，下次进入重水合）
          }
          builtinFillListeners.forEach((cb) => {
            try {
              cb(spec.id);
            } catch {
              // 单个订阅者异常不影响其余订阅者与填充流程
            }
          });
          console.info(
            `[PERF][fill-slice] ${spec.id} chapters=${sliceFilled} ` +
              `chaptersMs=${sliceChapterMs} heaviestChapter=${sliceHeaviestChapterMs} ` +
              `mergeNotify=${Date.now() - mergeT0}ms`,
          );
        }
        sliceFilled = 0;
        sliceChapterMs = 0;
        sliceHeaviestChapterMs = 0;
        sliceStart = Date.now();
      }
    }
    // 尾片（不足预算余额）合并+通知（必达）
    if (sliceFilled > 0 && typeof hydrate === 'function') {
      const merged = assembleBuiltinBook(
        spec,
        shells.map((s) => s.chapter),
      );
      try {
        hydrate.call(TextLibraryService, merged);
      } catch {
        // 尾片合并失败不中止
      }
      builtinFillListeners.forEach((cb) => {
        try {
          cb(spec.id);
        } catch {
          // 单个订阅者异常不影响其余订阅者与填充流程
        }
      });
    }
    // 填充完成：书体已在内存，若尚未入 FTS 索引则顺带补齐（省重复解析）。
    // 分片异步写入：同步版对资治通鉴级（约 300 万字）的书单块执行会把
    // JS 线程占死数秒至数十秒（初次打开 app 全 UI 无响应的根因之一），
    // 且此刻用户刚打开本书正准备阅读，绝不能阻塞。
    // r38 T03：本轮进度（诊断填充推进量；`rounds` 可证空闲心跳续跑）
    console.info(
      `[PERF][fill] ${spec.id} done +${Date.now() - fillPerfT0}ms filled=${sliceFilled} gen=${fillGeneration}`,
    );
    // ★ r38 T03 书级判据：章级增量启用时改用**计数式**判据——
    //   `isBookIndexedInFts`（存在即真）在「只索引了 1 章」时也会判真，
    //   会让整书补写被永久跳过（真·缺章）；计数式要求整本覆盖。
    //   判据为真即跳过整书分片写入（章级路径已覆盖），仅作兜底补齐。
    const fillableChapters = shells.filter(
      (s) => s.chapter.segments.length > 0,
    ).length;
    const ftsComplete = R38_FTS_PER_CHAPTER
      ? StorageService.isBookFullyIndexedInFts(spec.id, fillableChapters)
      : StorageService.isBookIndexedInFts(spec.id);
    if (!ftsComplete && !ftsUpsertInFlight.has(spec.id)) {
      ftsUpsertInFlight.add(spec.id);
      // 【T07】写入会话入口：忙期起点清零 ⇒ 配额语义被钉成「**每轮**书级分片写入内
      //   累计让路 ≤ FTS_BOOK_CHUNK_STARVE_MAX_MS」。清零是**必需**而非洁癖：
      //   本谓词只在 shouldPause 求值点被更新，两次写入之间可长期无求值
      //   （无写入在飞 ⇒ 无轮询，不会走 planAssemblyYield 的空闲分支自动复位）
      //   ⇒ 上一会话遗留的起点会让 `now − 起点 > 配额` 恒真 ⇒ 之后的写入再也
      //   不让路（开关为 true 却静默失效 = 假证据；单测有专项断言守此点）。
      ftsBookChunkBusySince = null;
      void StorageService.upsertFtsForBookChunked(
        assembleBuiltinBook(spec, shells.map((s) => s.chapter)),
        // §4.4 双检查点之三（书级分片写入）：固定缓冲门闩 + T07 新增的调度器活动判据。
        // 顺序刻意：左项（既有语义）先短路求值；右项只在它成为决定因时才让
        // `ftsCheckpointPaused()` 打到 `[PERF][asm] paused`（边沿/限流在其内部）。
        { shouldPause: () => Date.now() < ftsQueuePausedUntil || ftsBookChunkPaused() },
      ).then(
        () => ftsUpsertInFlight.delete(spec.id),
        () => ftsUpsertInFlight.delete(spec.id),
      );
    }
    ctx.running = false;
    armIdleHeartbeatIfNeeded(active);
  } catch {
    // 填充整体异常：静默中止（空壳章保留，重进重水合）
  } finally {
    // 异常路径也必须复位单飞守卫（否则本书兜底推进被永久阻塞）
    if (ctx) {
      ctx.running = false;
    }
    builtinFillInFlight.delete(spec.id);
    ftsQueuePausedUntil = Math.max(
      ftsQueuePausedUntil,
      Date.now() + FTS_PAUSE_AFTER_HYDRATE_MS,
    );
  }
}

/**
 * 空闲心跳（r38 T03）：兜底推进因「空闲门关闭（手势 / loading / 跳章装配中）
 * 或书序门槛未到」中止后，按档位 `idleDiffuseIntervalMs` 重探并续跑——
 * 保证语义是「**空闲时才推进**」而不是「忙过一次就永不推进」。
 *
 * 终止条件（三者任一）：
 *  ① 已无未完整章（本书填满）→ 停止；
 *  ② 取消令牌失效（跳章 / 切书 / 重水合 / 测试重置）→ 停止；
 *  ③ 无锚点（尚无阅读位置上报，纯初始化填充已在单轮内跑完）→ 不排心跳；
 *  ④ 心跳寿命超限（距最近一次进展超过档位 bookOrderFallbackIdleMs +
 *     idleDiffuseIntervalMs）→ 停止（避免退到后台的书长期挂一个空转定时器；
 *     用户下次跳章/切章上报锚点会重新唤醒）。
 */
function armIdleHeartbeatIfNeeded(ctx: BuiltinFillContext): void {
  clearFillHeartbeat(ctx);
  if (ctx.token !== fillGeneration) {
    return;
  }
  // D3：阅读器已卸载 → 不再排心跳（重新进入本书由锚点上报唤醒）
  if (ctx.detached) {
    // 【r40 F1 探针③】终态事件（每次挂载至多一次），无需状态转移限流
    console.info(
      `[PERF][fill] heartbeat stop reason=detached age=${Date.now() - ctx.lastProgressAt}`,
    );
    return;
  }
  if (!hasPendingFillWork(ctx)) {
    return;
  }
  const anchorIdx = anchorIndexOf(ctx);
  if (anchorIdx < 0) {
    return; // 无锚点：单轮初始化填充语义，不排心跳
  }
  const intervalMs = Math.max(1, resolveIdleDiffuseIntervalMs());
  const maxIdleAgeMs = resolveBookOrderFallbackIdleMs() + intervalMs;
  if (Date.now() - ctx.lastProgressAt > maxIdleAgeMs) {
    // 【r40 F1 探针③】终态事件：心跳**寿命自尽**（本次顺读「07:58:47 后再无进展、
    // 08:02 起设备空闲仍不恢复」的确切根因；此后唯一唤醒源是锚点上报，而顺读
    // 不 navigate ⇒ 永不重触发 —— 即 F5）。噪声型早退分支（stale-gen / no-work /
    // no-anchor）每 1.2s 一拍，按 R1 **不加**探针，避免污染 logcat 环形缓冲。
    console.info(
      `[PERF][fill] heartbeat stop reason=lifetime age=${Date.now() - ctx.lastProgressAt}`,
    );
    return; // 寿命超限：停止空转（下次锚点上报重新唤醒）
  }
  ctx.heartbeat = setTimeout(() => {
    ctx.heartbeat = null;
    if (ctx.token !== fillGeneration) {
      return;
    }
    pumpFillContext(ctx);
  }, intervalMs);
  // 心跳是纯后台工作，绝不阻塞宿主进程退出：Node/测试环境有 unref，
  // RN 的 setTimeout 返回数字（unref 为 undefined）→ 可选调用即无副作用。
  (ctx.heartbeat as unknown as { unref?: () => void }).unref?.();
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
 *  - 书间让出从 setTimeout(16) 升级为硬下限 setTimeout(200)：
 *    至少 200ms 间隔（RN 0.83 迁移时移除 InteractionManager 竞速，见
 *    ftsInterBookYield 注释）；
 *  - 单本解析走分片路径（loadBuiltinBookBody chunked）：书内按章让出，
 *    用户 tap 可在章间插队，正解析一本书时无需中断也不会拖死交互。
 */
export function scheduleBuiltinFtsIndexBuild(delayMs = 10000): void {
  if (builtinFtsQueueRunning) {
    return;
  }
  builtinFtsQueueRunning = true;
  // 【R2-3】本队列的世代号：被 __resetBuiltinLazyStateForTests 递增即作废本队列
  const myGeneration = (ftsQueueGeneration += 1);
  /** 队列是否已被取消（世代被推进）——取消后立即返回，不再解析也不再打印 */
  const cancelled = (): boolean => myGeneration !== ftsQueueGeneration;
  const run = async (): Promise<void> => {
    // 等启动链路完全收尾再开跑（书架渲染/水合入口优先）
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delayMs);
      // RN 的 setTimeout 返回 number（unref 为 undefined）→ 可选调用无副作用
      (t as unknown as { unref?: () => void }).unref?.();
    });
    if (cancelled()) {
      return;
    }
    for (const spec of BUILTIN_CATALOG) {
      // 【R2-3】书间取消检查：测试 teardown / 卸载后不得继续解析与打印
      if (cancelled()) {
        return;
      }
      if (hiddenBuiltins.has(spec.id)) {
        continue;
      }
      // 用户优先门闩：书间检查点——水合进行中/缓冲期内轮询等待，
      // 绝不开始新书解析（只在书间让路，不中断书内分片解析）。
      // §4.4 双检查点之一：另叠加调度器活动判据（D6 接线 isUserActive）。
      while (Date.now() < ftsQueuePausedUntil || ftsCheckpointPaused()) {
        // 【R2-3】暂停轮询同样必须可取消：否则测试结束后本循环会 250ms 一次
        // 永久轮询（`ftsCheckpointPaused()` 由调度器活动驱动），既空转又打印
        if (cancelled()) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, FTS_PAUSE_POLL_MS);
          (t as unknown as { unref?: () => void }).unref?.();
        });
      }
      // 填充中的书跳过：其后台填充完成后会顺带入索引（书体已在内存），
      // 这里再解析一遍纯属浪费；本轮跳过、下轮启动重试兜底
      if (builtinFillInFlight.has(spec.id)) {
        continue;
      }
      // 分片索引写入进行中的书跳过（填充顺带入索引与队列的并发去重）
      if (ftsUpsertInFlight.has(spec.id)) {
        continue;
      }
      try {
        if (!StorageService.isBookIndexedInFts(spec.id)) {
          const ftsBookT0 = Date.now();
          const parsed = await loadBuiltinBookBody(spec);
          // 【R2-3】取消后**绝不打印**：本检查必须在 console.info 之前——
          // 否则队列可能在 `await` 期间被取消，恢复后仍打印一条越过 teardown 的日志
          if (cancelled()) {
            return;
          }
          console.info(
            `[PERF][fts] ${spec.id} parse=${parsed ? 'ok' : 'null'} +${
              Date.now() - ftsBookT0
            }ms`,
          );
          if (parsed) {
            // 分片异步写入：片间让出 + 用户优先门闩片间生效（水合/交互
            // 时挂起，解除后断点续写）。同步版单块执行资治通鉴级会把
            // JS 线程占死数秒至数十秒（初次启动全 UI 无响应的根因）。
            ftsUpsertInFlight.add(spec.id);
            try {
              await StorageService.upsertFtsForBookChunked(parsed.book, {
                // §4.4 双检查点之二（片间）：门闩 + 调度器活动判据
                shouldPause: () =>
                  Date.now() < ftsQueuePausedUntil || ftsCheckpointPaused(),
              });
            } finally {
              ftsUpsertInFlight.delete(spec.id);
            }
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
 * 并清空「用户优先」门闩与书间让出注入（恢复默认 200ms）。
 * 另清 meta 缓存：用例可按需注入受控 meta（否则首次读取的 null 会被缓存，
 * 后续用例注入 readFileAssets 也拿不到 → 用例间顺序耦合）。 */
export function __resetBuiltinLazyStateForTests(): void {
  builtinMetaRegistered = false;
  builtinFtsQueueRunning = false;
  builtinFtsAutoSchedule = false;
  // 【R2-3】世代号 +1 → 在飞的 FTS 队列在下一次书间/暂停轮询检查点**立即返回**，
  // 不再解析、不再 `console.info`（否则用例结束后仍打印，jest 报
  // 「Cannot log after tests are done」且 --detectOpenHandles 退出码 1）
  ftsQueueGeneration += 1;
  ftsQueuePausedUntil = 0;
  // 【T07】书级分片写入的忙期起点：跨用例残留会让下一个用例的配额看起来「已耗尽」
  // ⇒ 「装配忙时让路」断言假红（与上面的门闩同类残留，故一同清零）。
  ftsBookChunkBusySince = null;
  ftsQueueYieldMs = 200;
  builtinMetaCache.clear();
  ftsUpsertInFlight.clear();
  builtinFillInFlight.clear();
  builtinFillListeners.clear();
  ensureInFlight.clear();
  readyInFlight.clear();
}

/** 仅测试：切章同步版与分批让出版各跑一遍（分批状态机漂移防护——
 * 两版共用 scanChapterLineRange，但跨批续作正确性只有端到端可比对）。 */
export async function __splitChaptersBothWaysForTests(
  normalized: string,
): Promise<{
  sync: { rawChapters: RawChapter[]; preface: string[] };
  chunked: { rawChapters: RawChapter[]; preface: string[] };
}> {
  return {
    sync: splitRawChapters(normalized, true),
    chunked: await splitRawChaptersChunked(normalized, true),
  };
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
/** 单部内置书物化：需要复制返回 'copied'（contentChanged 时记 changed）；失败记入 failures */
async function materializeOneBuiltin(
  spec: BuiltinBookSpec,
  builtinDir: string,
  failures: string[],
  changedIds: string[],
): Promise<void> {
  const path = `${builtinDir}/${spec.id}.txt`;
  try {
    let needCopy = false;
    let contentChanged = false;
    if (!(await RNFS.exists(path))) {
      needCopy = true;
    } else if (typeof spec.sizeBytes === 'number' && spec.sizeBytes > 0) {
      // 指纹比对：落盘文件与随包资产字节大小不一致即视为内容变更
      try {
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
      await RNFS.copyFileAssets(`books/${spec.id}.txt`, path);
      if (contentChanged) {
        changedIds.push(spec.id);
      }
    }
  } catch {
    // copyFileAssets 失败（旧机型/异常路径）回落读资产+写文件
    try {
      const existed = await RNFS.exists(path);
      const content = await RNFS.readFileAssets(`books/${spec.id}.txt`, 'utf8');
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

async function materializeBuiltins(): Promise<string[]> {
  const builtinDir = getBuiltinDirPath();
  const failures: string[] = [];
  const changedIds: string[] = [];
  const specs = BUILTIN_CATALOG.filter((spec) => !hiddenBuiltins.has(spec.id));
  // 分批并行（8 并发）：77 部串行 exists+stat 每次 bridge 往返 ~20ms，
  // warm restart 实测串行 1.7s；分批并行收敛到 ~0.3s。批内失败互相隔离。
  const BATCH = 8;
  for (let i = 0; i < specs.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      specs.slice(i, i + BATCH).map((spec) =>
        materializeOneBuiltin(spec, builtinDir, failures, changedIds),
      ),
    );
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
    if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
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

/**
 * 文本切段落：优先按空行分组；无空行则每行一段；空白行剔除。
 *
 * ★导出（2026-10-13，B 档步骤 5）：`.gxbook.toc` 消费端按字节偏移切出某章
 *   正文后，**必须**用本函数重切段才能得到与全量解析**逐段相同**的 segments
 *   （否则段 id 漂移 ⇒ FTS / 划线 / 笔记锚点全部失效）。
 *   它同时是「字节路径 == 解析路径」对拍判据的一端 —— 私有函数在 jest 里
 *   无法被执行，判据会退化成「自己等于自己」。
 * ⚠ 本函数是**纯函数**：不得引入状态/IO，否则上述等价性立即失效。
 */
export function toParagraphs(raw: string): string[] {
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
  /**
   * ★ 正文首行行号（含）。切到标题行时该标题**不计入**正文，故为 `标题行号 + 1`。
   * 用途：把 `splitRawChapters` 的结果映射回**字节偏移**（`.gxbook.toc` 的来源）。
   * ⚠ 行号口径必须与 `normalized.split('\n')` **完全一致**（空行也算一项），
   *   否则与 `lineByteRanges` 的行表错位 ⇒ toc 偏移漂移 ⇒ 静默切错章。
   */
  startLine: number;
  /** 正文末行行号 + 1（**开区间**）；下一标题行的行号，或全文末行数 */
  endLine: number;
  /** ★ 正文起始**字节**偏移（由 `finishChapterScan` 从 `startLine` 换算） */
  byteStart: number;
  /** ★ 正文结束**字节**偏移（开区间） */
  byteEnd: number;
}

/** 分片解析的让出粒度：每装配 30 章让出一次 JS 线程 */
const PARSE_CHUNK_CHAPTERS = 30;

/**
 * 后台填充的时间片预算（ms）：每装配完一章检查耗时，超预算即让出。
 * 块上限 = 单章 toParagraphs（资治通鉴级约 10-30ms）。替代原固定
 * 30 章/批（对大书单片可达数秒，点卡片后长时间无法操作的第四大块）。
 */
const FILL_TIME_BUDGET_MS = 12;
/**
 * 流式装配的单批读取字节量：巨章按此分批走 RNFS 切片读。RNFS 大字符串
 * native→JS 约 1MB/s——史记表章级（几十万字节）整章一次读是第二大同步块，
 * 64KB/批单次 ~60-70ms 且批内行级时间片可再中断。
 */
const FILL_READ_CHUNK_BYTES = 64 * 1024;
/**
 * 片间让出时长（ms）：填充是最低优先级后台任务，片间必须留出一帧让
 * tap/渲染/GC 真正执行。旧 setTimeout(0) 在 RN/Hermes 上仅让出 1-4ms，
 * 填充对 JS 线程的占空比高达 ~75%——触摸响应延迟、心跳探针连续报
 * jsBlocked、动画掉帧（真机采样：填充期每 ~0.75s 一次 600-850ms 饱和块）。
 */
const FILL_YIELD_MS = 16;
/**
 * 填充进度「合并+通知」节流：两者都是通知频率的线性成本——
 * ① assemble/hydrate 让旧 Book 壳变垃圾 + 置空 TextLibraryService 三级
 *   缓存（booksCache/chapterIndex/segmentIndex，下次访问全量重建，已水合
 *   大部头下单次重建可达数百 ms）；
 * ② 通知触发 ReaderScreen 整树重渲染（hydrateTick 依赖扩散）。
 * 真机采样（史记 130 章）：每片 chaptersMs 仅 17-76ms，但回调同步块
 * 546-817ms（GC + 索引重建计入），400ms 节流下持续饱和。1.5s 节流将
 * 成本降一个量级；跳章到「已填充但未通知」的章由 fillBuiltinChapterNow
 * 链路（segments 直查 + hydrateTick）兜底，不受节流影响。
 */
const FILL_NOTIFY_THROTTLE_MS = 1500;

/**
 * 【R2-1】切片读**连续失败终态阈值**：同一壳连续失败达此值 → `failedTerminal`。
 *
 * 为什么必须有（这是 D1 的必要配套）：D1 去掉了失败路径的 `cur.done = true`
 * （截断防护），但选章判据是「未就绪即候选」——失败章永不就绪，于是每轮都
 * 重新被选中，形成**无退避无上限的紧循环**（QA 实证：700ms 内 read 调用
 * 17.5 万 → 51 万，且 `ctx.running` 永不复位、后续章永不填充）。
 * 3 次给瞬时故障留足恢复窗口，又不至于长时间卡在同一章。
 */
const FILL_FAIL_TERMINAL_THRESHOLD = 3;

/**
 * 【R2-1】失败退避基数（ms）：第 n 次失败后退避 `本值 × 2^(n-1)`（**指数**
 * 递增，见 `FILL_FAIL_BACKOFF_MAX_MS` 封顶），窗口内该壳不可选 →
 * 失败之间不再紧循环空转。
 *
 * 【#20】原为线性 `本值 × n`（250/500ms，窗口偏短且节奏固定）：真机上失败章
 * 会被反复以数百毫秒的固定节奏重试，叠加「两条链路（调度器目标/邻章 + 兜底
 * 扩散）各自重试」形成持续 CPU 占用。改为指数后退后，重试密度随失败次数
 * 快速衰减，重试时机交给「用户重新挂到本书上 / 显式重试」（见
 * `clearAssemblyFailures`）与长空闲心跳，而不是固定短间隔的自动轮询。
 */
const FILL_FAIL_BACKOFF_MS = 250;

/** 【#20】失败退避上限（ms）：指数退避封顶，避免重试窗口无限拉长 */
const FILL_FAIL_BACKOFF_MAX_MS = 4000;

/**
 * 【R2-1】单轮兜底推进的**迭代上限**（终止性双保险）。
 *
 * 主防线是「失败终态跳过」：每章最多失败 `FILL_FAIL_TERMINAL_THRESHOLD` 次
 * 即永久跳过（本批），每章最多推进 `totalBytes / readChunkBytes` 次成功批，
 * 章数有限 ⇒ 迭代数有限。本上限是与之独立的最后护栏：即便未来有未知形态的
 * 「既不就绪也不失败终态」的壳（例如极端小 readChunkBytes），也能保证本轮
 * 必然返回。取值远大于合法最坏情形（77 部 × 章数 × 批数），正常运行不会触发。
 */
const FILL_MAX_ITERATIONS_PER_ROUND = 100_000;

/**
 * 【r38 T01 常量外置】装配参数的**唯一读取入口**：档位矩阵（三档见
 * DeviceTierService.TIER_PARAMS §6.2）→ 上面的 FILL_* 默认值快照。
 * 读档位失败（DeviceTierService 异常 / 未注册）一律回落快照，
 * 行为等价 r37（mid 档数值与快照逐项一致）；灰度开关 R38_TIER_PARAMS=true。
 */
function safeTierParams(): TierParams | null {
  try {
    return getTierParams() ?? null;
  } catch {
    return null;
  }
}

/** 装配时间片 / 读批 / 让出 / 通知节流的档位化取值（失败回落快照） */
function resolveFillTierParams(): {
  timeBudgetMs: number;
  readChunkBytes: number;
  yieldMs: number;
  notifyThrottleMs: number;
} {
  const params = safeTierParams();
  return {
    timeBudgetMs: pickTierNumber(params?.fillTimeBudgetMs, FILL_TIME_BUDGET_MS),
    readChunkBytes: pickTierNumber(
      params?.fillReadChunkBytes,
      FILL_READ_CHUNK_BYTES,
    ),
    yieldMs: pickTierNumber(params?.fillYieldMs, FILL_YIELD_MS),
    notifyThrottleMs: pickTierNumber(
      params?.fillNotifyThrottleMs,
      FILL_NOTIFY_THROTTLE_MS,
    ),
  };
}

/** 跳章双向预热跨距的默认快照（档位 mid.preloadSpan，等价 r37 的「前 3 后 3」） */
const PREFILL_SPAN_FALLBACK = 3;

/** 跳章双向预热跨距（每方向）= tier.preloadSpan；读档位失败回落 3 */
function resolvePreloadSpan(): number {
  const params = safeTierParams();
  // ★ SPAN-PROBE（可移除）：本机档位与实际 span（判「预装覆盖够不够」）
  console.info(
    `[SPAN] tierParams=${params ? JSON.stringify(params) : 'null'} span=${Math.max(
      1,
      Math.round(pickTierNumber(params?.preloadSpan, PREFILL_SPAN_FALLBACK)),
    )}`,
  );
  return Math.max(
    1,
    Math.round(pickTierNumber(params?.preloadSpan, PREFILL_SPAN_FALLBACK)),
  );
}

/**
 * 逐行扫描切出 [章节标题, 标题下正文] 序列与标题前正文（同步纯函数）。
 * useMarkers 启用时 @@CH@@ 标记行同样切章（结构化格式统一标记），
 * 标记行无标题时补「第N章」（按标记行出现顺序计数）。
 * 同步版与分片版装配路径共用本函数，保证解析结果逐字节一致。
 */
/**
 * 切章扫描状态（跨批续作）：同步版 splitRawChapters 与分批版
 * splitRawChaptersChunked 共用同一逐行状态机（scanChapterLineRange），
 * 两版产出恒等（有对齐测试锁定）。
 */
interface ChapterScanState {
  rawChapters: RawChapter[];
  current: RawChapter | null;
  preface: string[];
  markerCount: number;
  /**
   * ★ preface 的结束行号（开区间）＝首个标题行行号；无标题则＝全文末行数。
   * preface 就是「第一个标题行之前」的行，故天然连续，可直接映射字节区间。
   */
  prefaceEndLine: number;
}

function createChapterScanState(): ChapterScanState {
  return { rawChapters: [], current: null, preface: [], markerCount: 0, prefaceEndLine: -1 };
}

/**
 * 收尾当前章：把正文范围截至 `endLine`（下一标题行的行号）并入结果。
 * 正文范围收尾与 push 必须**同一处**，否则会出现「push 了但 endLine 还是 0」的章。
 */
function finishCurrentChapter(state: ChapterScanState, endLine: number): void {
  if (!state.current) {
    return;
  }
  state.current.endLine = endLine;
  state.rawChapters.push(state.current);
  state.current = null;
}

/** 扫描 lines 的 [from, to) 区间并入状态（逐行规则与原实现逐语句一致） */
function scanChapterLineRange(
  state: ChapterScanState,
  lines: string[],
  from: number,
  to: number,
  useMarkers: boolean,
): void {
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    const marker = useMarkers ? CHAPTER_MARKER_LINE_RE.exec(line) : null;
    if (marker) {
      finishCurrentChapter(state, i);
      if (state.prefaceEndLine < 0) {
        state.prefaceEndLine = i;
      }
      state.markerCount += 1;
      state.current = {
        title: marker[1].trim() || `第${state.markerCount}章`,
        body: [],
        // ★ 标题行不计入正文 ⇒ 正文从下一行开始
        startLine: i + 1,
        endLine: -1,
        byteStart: -1,
        byteEnd: -1,
      };
    } else {
      const m = CHAPTER_TITLE_RE.exec(line);
      if (m) {
        finishCurrentChapter(state, i);
        if (state.prefaceEndLine < 0) {
          state.prefaceEndLine = i;
        }
        state.current = {
          title: m[1].trim(),
          body: [],
          startLine: i + 1,
          endLine: -1,
          byteStart: -1,
          byteEnd: -1,
        };
      } else if (state.current) {
        state.current.body.push(line);
      } else {
        state.preface.push(line);
      }
    }
  }
}

/**
 * 切章收尾：把行范围换算成**字节偏移**（`.gxbook.toc` 的记账口径）。
 *
 * ⚠ 行→字节的换算必须与 `chapterToc.lineByteRanges` **同一张行表**
 *   （口径＝`normalized.split('\n')`，空行也算一项）⇒ 换算必须在**本文件内**
 *   用同一张表，否则两处行表不一致 ⇒ toc 偏移漂移 ⇒ 静默切错章。
 *
 * ⚠ 换算是 O(全文长度) 的额外一趟（≈12MB 文本约几十~百 ms）。
 *   只在「生成分片切章结果」时付一次，落盘时一次，读取时零成本。
 */
function finishChapterScan(
  state: ChapterScanState,
  lineCount: number,
  byteStarts: number[],
  byteLen: number,
): {
  rawChapters: RawChapter[];
  preface: string[];
  prefaceStartByte: number;
  prefaceEndByte: number;
} {
  finishCurrentChapter(state, lineCount);
  if (state.prefaceEndLine < 0) {
    state.prefaceEndLine = lineCount;
  }
  // 行号 → 字节偏移；行号越界（末行无换行时 endLine === 行数）时钳到 byteLen
  const toByte = (line: number): number =>
    line < byteStarts.length ? byteStarts[line] : byteLen;
  for (const rc of state.rawChapters) {
    rc.byteStart = toByte(rc.startLine);
    rc.byteEnd = toByte(rc.endLine);
  }
  return {
    rawChapters: state.rawChapters,
    preface: state.preface,
    prefaceStartByte: 0,
    prefaceEndByte: toByte(state.prefaceEndLine),
  };
}

function splitRawChapters(
  normalized: string,
  useMarkers: boolean,
): {
  rawChapters: RawChapter[];
  preface: string[];
  prefaceStartByte: number;
  prefaceEndByte: number;
} {
  const lines = normalized.split('\n');
  const { starts, byteLen } = lineByteRanges(normalized);
  const state = createChapterScanState();
  scanChapterLineRange(state, lines, 0, lines.length, useMarkers);
  return finishChapterScan(state, lines.length, starts, byteLen);
}

/** 分批切章的每批行数：9MB 书约 20 万行 → 10 批，每批约 30-80ms 让出一次
 *（tap/触摸/渲染可在批间插队）。原单块版对 9MB 全量扫描约 0.5-1.5s，
 * 是「初次点卡片长时间无响应」的第三大块。 */
const SPLIT_SCAN_BATCH_LINES = 20000;

/**
 * 分批让出版的切章扫描：与同步版共用 scanChapterLineRange 状态机，
 * 每 SPLIT_SCAN_BATCH_LINES 行让出一次 JS。供首开快速水合路径
 * （buildBuiltinChapterShells）使用；解析器（parseTxtBook 系）保持同步版。
 */
async function splitRawChaptersChunked(
  normalized: string,
  useMarkers: boolean,
): Promise<{
  rawChapters: RawChapter[];
  preface: string[];
  prefaceStartByte: number;
  prefaceEndByte: number;
}> {
  const lines = normalized.split('\n');
  const { starts, byteLen } = lineByteRanges(normalized);
  const state = createChapterScanState();
  for (let from = 0; from < lines.length; from += SPLIT_SCAN_BATCH_LINES) {
    scanChapterLineRange(
      state,
      lines,
      from,
      Math.min(from + SPLIT_SCAN_BATCH_LINES, lines.length),
      useMarkers,
    );
    if (from + SPLIT_SCAN_BATCH_LINES < lines.length) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToJs();
    }
  }
  return finishChapterScan(state, lines.length, starts, byteLen);
}

/**
 * 章节装配器：pushChapter 抽为共享闭包，同步版（parseTxtBook）与
 * 分片版（parseTxtBookChunked）走完全相同的逐章装配逻辑。
 */
function createChapterBuilder(bookId: string): {
  chapters: Book['chapters'];
  /**
   * 装配一章。
   * @param byteRange **可选**：本章正文在归一化文本中的**字节**区间。
   *   缺省时**不写** `byteStart`/`byteEnd` ⇒ `buildTocFromBook` 整体放弃生成 toc。
   *   典型缺省场景：「按段数切第N部分」——段落边界不在行边界，偏移无法表达。
   */
  pushChapter: (
    chapterTitle: string,
    bodyLines: string[],
    byteRange?: { byteStart: number; byteEnd: number },
  ) => void;
} {
  const chapters: Book['chapters'][number][] = [];
  let chapterOrder = 0;
  const pushChapter = (
    chapterTitle: string,
    bodyLines: string[],
    byteRange?: { byteStart: number; byteEnd: number },
  ): void => {
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
      // ★ 目录字段（2026-10-12）：与 segments 同源算出，构造即一致。
      //   作用见 types/index.ts 的 Chapter.segCount / charCount 注释与设计文档 §3。
      //   ⚠ 必须在此算（而非读侧兜底算）：读侧在「未装载」态拿不到正文。
      segCount: segments.length,
      charCount: paragraphs.reduce((n, p) => n + p.length, 0),
      // ★ 字节范围（2026-10-13）：`.gxbook.toc` 的来源。缺省时**不写**
      //   （宁缺勿猜：部分 toc 会静默切错章，见 chapterToc.buildTocFromBook）。
      ...(byteRange ? { byteStart: byteRange.byteStart, byteEnd: byteRange.byteEnd } : {}),
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
  const { rawChapters, preface, prefaceStartByte, prefaceEndByte } = splitRawChapters(
    normalized,
    opts?.markers ?? false,
  );
  const { chapters, pushChapter } = createChapterBuilder(bookId);
  const prefaceParagraphs = toParagraphs(preface.join('\n'));

  if (rawChapters.length === 0) {
    // 无章节标记：preface 即全部内容，整本一章「全文」；段落过多时切「部分」
    if (prefaceParagraphs.length <= SEGMENTS_PER_PART) {
      // 单章「全文」＝整个 preface 区间 ⇒ 字节范围可用
      pushChapter('全文', preface, {
        byteStart: prefaceStartByte,
        byteEnd: prefaceEndByte,
      });
    } else {
      for (let i = 0; i < prefaceParagraphs.length; i += SEGMENTS_PER_PART) {
        const part = prefaceParagraphs.slice(i, i + SEGMENTS_PER_PART);
        // ★**故意不传字节范围**：按段数切片，段落边界**不一定落在行边界**
        //   ⇒ 偏移无法表达 ⇒ 该书整体不生成 toc（`buildTocFromBook` 返回 null，
        //   消费端回退全量读，永远正确）。
        pushChapter(`第${Math.floor(i / SEGMENTS_PER_PART) + 1}部分`, [part.join('\n\n')]);
      }
    }
  } else {
    // 有章节标记：标题前正文归「开篇」
    if (prefaceParagraphs.length > 0) {
      pushChapter('开篇', preface, {
        byteStart: prefaceStartByte,
        byteEnd: prefaceEndByte,
      });
    }
    for (const rc of rawChapters) {
      pushChapter(rc.title, rc.body, {
        byteStart: rc.byteStart,
        byteEnd: rc.byteEnd,
      });
    }
  }

  return finishParsedBook(fileName, bookId, chapters, opts);
}

/**
 * 由 `.gxbook.toc` 构造**目录态** `Book`（2026-10-13 B 档步骤 6 消费端）。
 *
 * ★这是「兑现 6275ms」的那一步：冷启只读几十 KB 的 toc 即可上架全部章节，
 *   **不读 12.78MB 正文、不跑 `parseTxtBookChunked`**（真机读数：读缓存
 *   6275ms 占冷启→上屏 8.2s 的 69%，重建 980 章另 1785ms）。
 *
 * 目录态与全量态的差异**只有一个**：`segments: []`。
 * 章 id / title / order / segCount / charCount / byteStart / byteEnd
 * 全部**取自 toc**——它们与全量解析逐字相同（toc 就是全量解析的产物）⇒
 * 章 id 不漂 ⇒ 目录跳转 / FTS / 划线 / 笔记锚点全部保持有效。
 *
 * ⚠ 正文缺失的补救**不在本函数**：阅读时 `ReaderScreen` 见 `segments.length === 0`
 *   会走 `degradeChapterToWholeRead` → `fillBuiltinChapterNow` 按 toc 的字节区间
 *   切片装配（内置书 meta 快路径的同范式，用户书版在同文件内）。
 *   ⇒ 「读侧通道」与「目录态注册」必须**同时**落地，否则目录态书点开必报错。
 *
 * @param meta `.gxbook.meta` 信封（title/author；缺失时用文件名兜底）
 */
function buildShellBookFromToc(
  fileName: string,
  bookId: string,
  toc: ChapterToc,
  meta: { title?: string; author?: string },
): Book {
  const fallbackTitle =
    fileName.replace(/\.(txt|md|markdown|html?|xhtml|fb2|epub)$/i, '').trim() ||
    '未命名书籍';
  const totalSegments = toc.chapters.reduce((n, c) => n + c.segCount, 0);
  return {
    id: bookId,
    title: meta.title?.trim() || fallbackTitle,
    author: meta.author?.trim() || '佚名',
    category: 'user',
    description: `共 ${toc.chapters.length} 章 ${totalSegments} 段 · 导入自 ${
      fileName.split('.').pop()?.toUpperCase() ?? 'TXT'
    }`,
    chapters: toc.chapters.map((c) => ({
      id: c.id,
      bookId,
      title: c.title,
      order: c.order,
      // ★ 目录态：**唯一**差异。正文由阅读时按字节区间切片装配。
      segments: [],
      segCount: c.segCount,
      charCount: c.charCount,
      byteStart: c.start,
      byteEnd: c.end,
    })),
  };
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
  // 【T23】切分也走分片版：原同步 splitRawChapters 对整书一次性扫描是隐藏的
  // 同步大块（超大书可达数秒），会使「chunked」版本名不副实。splitRawChaptersChunked
  // 每 2 万行让出一次，返回同构 {rawChapters, preface}，解析结果与原版一致。
  const { rawChapters, preface, prefaceStartByte, prefaceEndByte } =
    await splitRawChaptersChunked(normalized, opts?.markers ?? false);
  const { chapters, pushChapter } = createChapterBuilder(bookId);
  const prefaceParagraphs = toParagraphs(preface.join('\n'));

  if (rawChapters.length === 0) {
    if (prefaceParagraphs.length <= SEGMENTS_PER_PART) {
      pushChapter('全文', preface, {
        byteStart: prefaceStartByte,
        byteEnd: prefaceEndByte,
      });
    } else {
      let partsDone = 0;
      for (let i = 0; i < prefaceParagraphs.length; i += SEGMENTS_PER_PART) {
        const part = prefaceParagraphs.slice(i, i + SEGMENTS_PER_PART);
        // ★**故意不传字节范围**：段落边界不在行边界 ⇒ 偏移无法表达 ⇒ 不生成 toc
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
      pushChapter('开篇', preface, {
        byteStart: prefaceStartByte,
        byteEnd: prefaceEndByte,
      });
    }
    let chaptersDone = 0;
    for (const rc of rawChapters) {
      pushChapter(rc.title, rc.body, {
        byteStart: rc.byteStart,
        byteEnd: rc.byteEnd,
      });
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
  /** 喂给章节切分器的原始/解码文本（超大书纯文本缓存用；仅 oversized 路径必填） */
  text?: string;
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
    /**
     * ★ 结构化格式（epub/odt/fb2…）的内嵌元数据（书名/作者）。
     *
     * 存在理由（2026-10-12 真机实证）：`convertBookBytes` 已从 OPF `dc:title` /
     * `dc:creator` 解析出书名与作者（`bookFormat.ts:183-184`），但本函数原先
     * **只取 `.text`、把 `title`/`author` 整个丢掉** ⇒ `finishParsedBook` 的
     * `opts?.title` 恒 undefined ⇒ `:4062` 回落**文件名**、`:4064` 回落 `佚名`。
     * 实录：`大奉打更人.epub` 的 OPF 明确含 `<dc:title>大奉打更人</dc:title>`、
     * `<dc:creator>卖报小郎君</dc:creator>`，书架却显示文件名 + 佚名。
     * ⇒ 用户重命名文件或用 ASCII 名导入时，书架显示跟着变；opaque 文件名 ⇒ 显示乱码。
     */
    let metaTitle: string | undefined;
    let metaAuthor: string | undefined;
    const tConv0 = Date.now();
    if (isStructuredFormat(ext)) {
      try {
        // 【T23b】超大书（epub 等结构化格式）转换按批让出 JS：原同步 epubExtractText
        // 对数百 MB epub 解压＋逐文档 htmlToText＋拼接会同步占死 JS 数十秒（真机
        // 实测 jsBlocked≈32s；T23 的解析 chunked 已让出，但转换更早发生，仍是
        // 书架冻结真凶）。仅 chunked（超大书）路径传 yieldToJs，普通导入保持原语义。
        const converted = await convertBookBytes(ext, bytesRes.data, chunked ? yieldToJs : undefined);
        text = converted.text;
        metaTitle = converted.title;
        metaAuthor = converted.author;
      } catch {
        return null;
      }
    } else {
      text = decodeTextBytes(bytesRes.data).text;
    }
    const tConv = Date.now() - tConv0;
    const parseOpts = {
      markers: isStructuredFormat(ext) || !!spec,
      sourceLabel: spec ? '内置' : ext.toUpperCase(),
      // ★ 结构化格式传内嵌元数据；空串由 finishParsedBook 的 `|| fallback` 兜住
      //   （`opts?.title?.trim() || fallbackTitle`），故无需在此判空。
      title: metaTitle,
      author: metaAuthor,
    };
    // chunked：内置书水合/FTS 队列传 true，大书装配期间按章让出 JS；
    // 用户书导入等其余链路默认 false 走原同步路径（解析结果一致）。
    const tParse0 = Date.now();
    const book = chunked
      ? await parseTxtBookChunked(fileName, text, bookId, parseOpts)
      : parseTxtBook(fileName, text, bookId, parseOpts);
    const tParse = Date.now() - tParse0;
    // 慢路径计时（仅超 50ms 打印），供真机定位 convert/parse 占比
    if (tConv > 50 || tParse > 50) {
      console.warn(
        `[PERF][parseBookFile] convert=${tConv}ms parse=${tParse}ms chunked=${chunked} ext=${ext} name=${fileName}`,
      );
    }
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
    return { book, sourcePath, fileSig, contentHash: contentSignature(utf8Bytes(text)), text };
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
  /** 扫描失败（readDir 抛错）：本轮未做下架比对、未写回注册，保留上一轮结果 */
  scanFailed: boolean;
  /** 本轮因陈旧（已被更新的同步/导入作废）而整体跳过的变更阶段 */
  staleSkippedStages: string[];
  /** 本轮未能解析出内容、但按 db 既有行保留了既有注册的书文件名（绝不因此丢书） */
  unparsedFiles: string[];
  /** 根路径与上一轮不一致：本轮禁用下架清扫（防误删 db 行 ⇒ 永久丢书） */
  rootPathDrift: boolean;
}

function emptySyncDiagnostics(): LibrarySyncDiagnostics {
  return {
    scanInterrupted: false,
    scanInterruptedReason: '',
    assetCopyFailures: [],
    builtinFilesSeen: 0,
    builtinParseFailures: [],
    oversizedPending: 0,
    scanFailed: false,
    staleSkippedStages: [],
    unparsedFiles: [],
    rootPathDrift: false,
  };
}

let lastSyncDiagnostics: LibrarySyncDiagnostics = emptySyncDiagnostics();

/** 读取最近一次装载的诊断信息（未装载过时返回全空诊断） */
export function getLibrarySyncDiagnostics(): LibrarySyncDiagnostics {
  return lastSyncDiagnostics;
}

/**
 * 【F3】本轮没能解析出内容的书 —— 绝不因此丢书。
 *
 * 依据：`user_books` 行才是「这本书存在」的持久证据（列
 * `id,title,author,data,created_at,source_path,file_sig,content_hash`，
 * 其中 `data` 为整本 `Book` 的 JSON，含 `chapters`）。
 * 本轮解析失败只说明「这次读不到正文」（文件被截断/临时不可读/IO 抖动），
 * 不说明书被删除——此时按 db 行 `id` 去复用既有注册，三路兜底：
 *   ① 上一轮装载的内存快照 `loadedBooks`（同进程内最省）；
 *   ② 当前注册表 `TextLibraryService.userBooks`（importBook 刚注册的书在此）；
 *   ③ db 行 `data` 列反解（跨进程重启后 loadedBooks 为空时）。
 * 三路都拿不到（行内 data 已损坏/被瘦身）才返回 null——调用方仍会在诊断
 * `unparsedFiles` 里留痕，绝不静默。
 *
 * @param row 本轮扫描对应路径的 user_books 行（无则 undefined）
 * @param fileName 文件名（仅用于调用方诊断留痕，本函数不做判定）
 * @returns 可复用的既有 Book（含非空 chapters），拿不到则 null
 */
function retainKnownUserBook(
  row: { id: string; data: string } | undefined,
  fileName: string,
): Book | null {
  if (!row || !row.id) {
    return null;
  }
  const usable = (b: Book | null | undefined): b is Book =>
    !!b && !!b.id && Array.isArray(b.chapters) && b.chapters.length > 0;
  // ① 上一轮装载快照
  const prev = loadedBooks.find((b) => b.id === row.id);
  if (usable(prev)) {
    return prev;
  }
  // ② 当前注册表（importBook 注册、或同进程上一轮注册的书）
  try {
    const reg = TextLibraryService.getBook(row.id);
    if (reg.success && usable(reg.data)) {
      return reg.data;
    }
  } catch {
    // 注册表查询异常不阻断：继续走 db 反解
  }
  // ③ db 行 data 列反解（仅内置书行会被瘦身为空串，用户书行始终是完整 JSON）
  if (typeof row.data === 'string' && row.data.length > 0) {
    try {
      const fromDb = JSON.parse(row.data) as Book;
      if (usable(fromDb)) {
        return fromDb;
      }
    } catch {
      // 损坏行：放弃反解（诊断留痕由调用方完成）
    }
  }
  console.warn(`[UserBookService] 未能解析且无法复用既有注册：${fileName}（id=${row.id}）`);
  return null;
}

/**
 * ★目录态快路径：只读 `.gxbook.toc` + `.gxbook.meta`，**不碰 12.78MB 正文**。
 *
 * 这是 B 档兑现 6275ms 的读侧入口。任何一步不成立即返回 `null`，
 * 由调用方落回「分片读正文 + `parseTxtBookChunked` 重建」的原路径 ——
 * 回退路径必须**永远正确**，宁可不优化。
 *
 * ⚠ 为什么 meta 缺失也要回退（而不是用文件名兜底）：
 *   `.meta` 里有 `fileSig`/`contentHash`，是判断「缓存是否还对得上原书」的依据。
 *   记忆条目：`meta.fileSig`/`contentHash` **写入但从不校验** ⇒ 这是已知欠账。
 *   本函数**不引入**该欠账（不校验就当没有），但也不能在 meta 缺失时
 *   造一个「看起来正常」的书 —— 那会让缺信封的书走上一条从未被验证的路径。
 *   ⇒ meta 缺失即回退全量读。
 */
async function buildShellBookFromCacheIfPossible(
  t: OversizedTask,
  id: string,
): Promise<Book | null> {
  // ① 信封（title/author）必须在：缺它就没法产出与全量态等价的书体元数据
  let meta: { title?: string; author?: string };
  try {
    // eslint-disable-next-line no-await-in-loop
    const metaRaw = await RNFS.readFile(`${t.cachePath}.meta`, 'utf8');
    meta = JSON.parse(metaRaw) as { title?: string; author?: string };
  } catch {
    return null; // 信封缺失/损坏 ⇒ 回退全量读
  }
  // ② toc（章目录 + 字节区间），读侧已做纯结构校验
  const toc = await loadUserBookToc(t.cachePath, id, 0);
  if (!toc) {
    return null;
  }
  return buildShellBookFromToc(t.name, id, toc, meta);
}

/**
 * ★偏移基准是否与 `.gxbook` 落盘内容**逐字一致**（B 档步骤 8）。
 *
 * 为什么必须是独立判据而不是「相信兜底」：`buildTocFromBook` 的行边界自检
 * 只保证「**偏移与传入文本**自洽」。而步骤 4（落盘前归一化）之前写的旧缓存
 * **含 CRLF**，解析层却已把 CRLF 归一化后才算 `byteStart/byteEnd`
 * ⇒ 两者口径不一致，且**偏移有可能碰巧落在 CRLF 版的行边界上** ⇒
 * 自检通过但 toc 是错的 ⇒ **静默显示错章**（最坏的一类缺陷，不报错）。
 * ⇒ 必须**显式判基准**，宁可不落 toc（回退全量读，永远正确）。
 *
 * 抽成导出纯函数的理由：这是「该不该落 toc」的**唯一真值**，
 * 判据要能在不搭 24MB 集成环境的前提下直接验证它两个方向。
 */
export function tocOffsetBaseMatchesCache(cacheText: string): boolean {
  return normalizeForCache(cacheText) === cacheText;
}

/**
 * ★落 `.gxbook.toc`（B 档步骤 8 抽出的共用小函数）——两条落盘路径共用一份实现。
 *
 * 抽出来的理由（不是「为了好看」）：`.toc` 曾只在「缓存**不存在**→完整解析」
 * 路径写 ⇒ **存量已导入的大书**走「读缓存+ `parseTxtBookChunked` 重建」分支
 * ⇒ `.toc` 永远不会被生成 ⇒ B 档收益（真机 8072ms → 202ms）对真实用户等于零。
 * 真机证据：装机后首启 Δ=9247ms（比走老路更慢）且 `ls` 确认无 `.toc`。
 *
 * ⚠ `buildTocFromBook` **全有或全无**：返回 null（无标记书按段数切「第N部分」，
 *   段落边界不在行边界 ⇒ 偏移无法表达）⇒ **不写 toc、不报错**，消费端回退
 *   全量读，永远正确。宁可不优化，也不能给一份会切错章的 toc。
 * ⚠ 内部 `verifyTocAgainstText` 自检是**真保护**而非装饰：若传入的 `cacheText`
 *   含 CRLF（步骤 4 归一化修复之前写的旧缓存），而 `book` 的 `byteStart/byteEnd`
 *   是按**归一化后**文本算的 ⇒ 行边界对不上 ⇒ 自检不过 ⇒ 返回 null ⇒ 不写。
 *   这正是我们要的：**宁可不落 toc，也绝不落一份会静默切错章的 toc**。
 *
 * @param cacheText **与 `.gxbook` 落盘内容逐字一致**的文本（偏移基准）
 * @returns 是否真的写出了 `.toc`（写失败/不适用都返回 false，绝不抛）
 */
export async function writeTocIfPossible(
  book: Book,
  cacheText: string,
  cachePath: string,
): Promise<boolean> {
  const toc = buildTocFromBook(book, cacheText);
  if (!toc) {
    console.info(`[UserBookService] 该书无法用字节偏移表达章目录（不写 .toc）：${book.title}`);
    return false;
  }
  try {
    await RNFS.writeFile(`${cachePath}.toc`, JSON.stringify(toc), 'utf8');
    return true;
  } catch {
    // toc 写失败不影响正文缓存（下次启动退回全量读）
    return false;
  }
}

/**
 * 逐个处理超大书（串行 + 每项处理前让出 JS 线程）：优先读磁盘缓存（纯文本 +
 * .meta 信封），无缓存则完整解析并写纯文本缓存供下次直接读。
 * 每完成一本立即重注册进文本库——书架下次刷新即可见可读。
 * 【T23c】缓存由嵌套 Book JSON 改为纯文本：读 = 分片取文本（非嵌套
 * 解析）→ parseTxtBookChunked 按章让出重建（不阻塞）；写 = writeFile 直写
 * 文本（非 JSON.stringify 嵌套对象）。彻底消除旧版 ≈32s 同步巨块。
 */
async function processOversizedBooks(tasks: OversizedTask[]): Promise<Book[]> {
  const loaded: Book[] = [];
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      let book: Book | null = null;
      const id = stableBookIdFromPath(t.name);
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await RNFS.exists(t.cachePath)) {
          // ★★ 2026-10-13（B 档步骤 6 · 消费端）：**toc 快路径**。
          //   有 `.gxbook.toc` ⇒ 只读它（~54KB）+ `.meta` 信封即可上架全部章节，
          //   **不读 12.78MB 正文、不跑 `parseTxtBookChunked`**（真机 6275ms / 69%）。
          //   任何一步不成立（toc 缺失/损坏/结构非法/`meta` 缺失）⇒ 落回下方
          //   原「分片读正文 + 重建」路径，行为与优化前**逐字相同**。
          //   ⚠ 形状锁：判据必须同时锁「快路径存在」与「正文仍可回退读」两个方向
          //     （只锁前者 ⇒ 有人把回退删了测试仍绿）。
          const shellBook = await buildShellBookFromCacheIfPossible(t, id);
          if (shellBook) {
            book = shellBook;
          } else {
          // 【T23c→】纯文本缓存分片读：不再用无界 RNFS.readFile('utf8')——RNFS 原生
          // 只返回 base64、UTF-8 解码在 JS 层（FS.common.js:164），12.78MB 单次
          // 实测阻塞 JS 14.767s（不可中断，tap 被吞）。改 readLocalTextFileChunked
          // 分片 + 片间让出，单块 ≤~0.3s。读到 null 抛错由外层 catch 回落完整解析。
          // eslint-disable-next-line no-await-in-loop
          const raw = await readLocalTextFileChunked(t.cachePath);
          if (raw === null) {
            throw new Error('oversized cache chunked read failed');
          }
          let meta = { v: 0, title: '', author: '', fileSig: '', contentHash: '' };
          try {
            // eslint-disable-next-line no-await-in-loop
            const metaRaw = await RNFS.readFile(`${t.cachePath}.meta`, 'utf8');
            meta = JSON.parse(metaRaw);
          } catch {
            // 信封缺失则重建后用解析默认元数据
          }
          const ext = t.name.split('.').pop()?.toLowerCase() ?? 'txt';
          const rebuilt = await parseTxtBookChunked(t.name, raw, id, {
            markers: isStructuredFormat(ext),
            sourceLabel: ext.toUpperCase(),
          });
          if (rebuilt.chapters.length > 0) {
            if (meta.title) rebuilt.title = meta.title;
            if (meta.author) rebuilt.author = meta.author;
            book = rebuilt;
            // ★★ 2026-10-13（B 档步骤 8 · 修「存量书拿不到 toc」缺陷）：
            //   本分支是**存量已导入大书**的必经之路（`.gxbook` 已存在 ⇒
            //   走「读缓存 + 重建」，不会进下方完整解析路径）⇒ 修复前
            //   `.toc` **永远不会被生成** ⇒ B 档收益对真实用户等于零。
            //   真机证据：装 B 臂包后首启 Δ=9247ms（比老路更慢）且 `ls` 无 `.toc`。
            //   代价：首次仍付一次重建成本（约 8s）；**之后每次冷启走快路径**。
            //
            //   ⚠ 偏移基准必须**逐字等于 `.gxbook` 落盘内容**，否则偏移随
            //   CRLF 数线性漂移 ⇒ 静默显示错章（最坏的一类缺陷）。
            //   `raw` 就是刚读出来的缓存本体，故基准天然一致 —— **但**：
            //   步骤 4 加归一化之前写的旧缓存含 CRLF，而 `parseTxtBookChunked`
            //   内部把 CRLF 归一化后才算 `byteStart/byteEnd` ⇒ 二者口径不一致。
            //   `buildTocFromBook` 的行边界自检**未必**能兜住（偏移可能碰巧
            //   落在 CRLF 版的行边界上）⇒ 这里**显式先判**，不依赖兜底。
            if (tocOffsetBaseMatchesCache(raw)) {
              // eslint-disable-next-line no-await-in-loop
              await writeTocIfPossible(rebuilt, raw, t.cachePath);
            } else {
              console.info(
                `[UserBookService] 缓存含 CR，偏移口径不一致（本次不写 .toc，回退全量读）：${t.name}`,
              );
            }
          }
          }
        }
      } catch {
        // 缓存缺失/损坏则走完整解析
      }
      if (!book) {
        // 【T23】超大书解析改走 chunked（按章 + 按 2 万行让出 JS）：原默认 false
        // 走同步 parseTxtBook，整本一次性解析把 JS 线程占死数十秒（真机实测
        // 大奉打更人后台装载 jsBlocked=31328ms，注释「不阻塞书架」实际失效）。
        // chunked 与同步版解析结果一致，仅插入让出点，使书架在装载期保持可响应。
        const parsed = await parseBookFile(t.path, t.name, id, undefined, true);
        if (parsed) {
          book = parsed.book;
          try {
            // 【T23c】写纯文本缓存 + 小信封（不再 JSON.stringify 嵌套 Book）：
            // 直写源文本（直接字节拷贝）比序列化数万章×百万段对象快数倍，
            // 且读路径只需 readFile 无需嵌套 JSON.parse。
            if (parsed.text) {
              // ★★ 2026-10-12（B 档步骤 4）：落盘前**必须归一化**。
              //   缺陷实测：`parseBookFile` 返回的 `text` 是**未归一化**原文
              //   （`decodeTextBytes(...).text` / `converted.text` 原样透传），
              //   而归一化只发生在 `parseTxtBook` / `parseTxtBookChunked`
              //   **函数内部** ⇒ 旧实现直写 `parsed.text` ⇒ **`.gxbook` 缓存里
              //   存的是 CRLF 文本**。
              //   ⇒ 未来 `.gxbook.toc` 若按「归一化文本的字节偏移」记账，
              //   偏移会随 CRLF 数线性漂移：10 万行 CRLF ⇒ 第 900 章偏 9 万字节
              //   ⇒ **静默显示错章、不报错**（最坏的一类缺陷）。
              //   口径与解析层四处 `replace(/\r\n?/g,'\n')` 逐字一致（由
              //   `chapterToc.test.ts` 的形状判据锁定处数）。
              //   ⚠ 行号会随本文件改动位移 ⇒ 只引函数名，不引行号。
              const cacheText = normalizeForCache(parsed.text);
              // eslint-disable-next-line no-await-in-loop
              await RNFS.writeFile(t.cachePath, cacheText, 'utf8');
              // ★★ 2026-10-13（B 档步骤 5）：同时落 `.gxbook.toc` —— 章目录
              //   （字节区间 + segCount + charCount）。有了它，冷启**只需读几十 KB
              //   的 toc**即可上架全部章节，**不必读 12.78MB 正文**（真机 6275ms）。
              //   2026-10-13（步骤 8）：实现抽到 `writeTocIfPossible`，与
              //   「缓存命中回退重建」分支共用一份（全有或全无语义两处必须一致）。
              // eslint-disable-next-line no-await-in-loop
              await writeTocIfPossible(book, cacheText, t.cachePath);
              // eslint-disable-next-line no-await-in-loop
              await RNFS.writeFile(
                `${t.cachePath}.meta`,
                JSON.stringify({
                  v: 1,
                  title: book.title,
                  author: book.author,
                  fileSig: parsed.fileSig,
                  contentHash: parsed.contentHash ?? '',
                }),
                'utf8',
              );
            }
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
          // 【F1b】同族第二处「整体替换写回」，但**不能**用世代号整段跳过：
          // 队列的存在意义就是把刚解析好的这本大书注册上架，跳过会让它直到
          // 下次刷新都不可见（同一症状换个触发点）。故改为**非破坏性合并**：
          //   · 基准 = 写回**当下**的注册表（而非入队时的 baseBooks 快照——
          //     快照可能早于之后的导入，整体写回会把新导入的书挤掉）；
          //   · 并入 = 本次队列刚解析出的书（按 id 去重，新解析结果优先）。
          const currentUser = (TextLibraryService.getBooks().data ?? []).filter((b) =>
            isUserBook(b.id),
          );
          const merged = [
            ...currentUser,
            ...loaded.filter((b) => !currentUser.some((x) => x.id === b.id)),
          ];
          const reg = TextLibraryService.registerUserBooks(merged);
          if (reg.success) {
            // 通知书架重拉：此注册发生在书架渲染之后（异步队列），无通知则不刷新
            notifyUserBooksChanged();
          }
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
 * 仅测试：直接驱动后台超大书队列（2026-10-13 B 档步骤 8）。
 *
 * ⚠ 同族惯例（`__registerOversizedFileForTests` / `__resetBuiltinLazyStateForTests`）：
 *   **测试专用、生产不调用**。存在的理由不是「给判据开后门」，而是：
 *   `processOversizedBooks` 的入队门槛是 `size > OVERSIZED_RAW_BYTES`(24MB)
 *   ⇒ 走 `loadAndRegisterAll` 端到端必须造一本 24MB 的书（既有
 *   `oversizedShelfNotification.test.ts` 单这一条就要 ~30s）。
 *   而本步要验的是「缓存命中回退分支是否补落 `.toc`」，**与书有多大无关**
 *   ⇒ 直接喂任务列表，把预算花在真行为上而不是造大文件上。
 */
export async function __processOversizedBooksForTests(
  tasks: Array<{ path: string; name: string; sig: string; cachePath: string }>,
): Promise<Book[]> {
  return processOversizedBooks(tasks);
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
/**
 * 装载防重入单例：App 启动 effect 与 LibraryScreen mount effect 各调一次
 * loadBooks → loadAndRegisterAll，两个调用几乎同时发出（真机 r21b 实测并发
 * 两轮全量 materialize+扫描，materialize 1.7s × 2 交叠）。in-flight 期间
 * 后续调用直接并入同一 promise（完成后清空，手动刷新仍会真实执行）。
 */
let librarySyncInFlight: Promise<ServiceResult<LibrarySyncSummary>> | null = null;

/**
 * 【F1】装载世代号（非破坏性注册守卫）。
 * 每发起一轮 `loadAndRegisterAllInternal` 取一次号；`importBook` 成功后自增。
 * 口径（**不得过度宣称**）：此前发起的同步，其**目录列举快照**可能早于本次
 * 文件落盘、其**写回集合**可能不含本次导入的书；但**不能**说「其快照一定早于
 * 本次 INSERT」——门控发生在 SELECT 之前的同步，恢复后其 SELECT 会包含新行。
 * 任何**变更阶段**（`registerUserBooks` 整体替换写回 / `loadedBooks` 赋值 /
 * db 下架删行）执行前都要复核 `syncGen === librarySyncGen`；不相等即整段跳过，
 * 只让只读的扫描结果进 summary / 诊断。跳过是**保守方向**（宁可不刷新，也不用
 * 陈旧集合整体替换；代价 = 本轮扫描到的「文件内容变更重解析」顺延到下一轮）。
 * 其中「db 下架删行」一支的**危害面在当前调用图下不可达**（证明见下方
 * `purgeBlocked` 处注释），保留它属纵深防御。
 * 依据：`registerUserBooks` 是**整体替换**语义，而本轮扫描快照只代表「本轮
 * 文件系统所见」——「本轮没看到 / 没解析出」绝不等于「该书不存在」。
 */
let librarySyncGen = 0;

/** 【F4】上一轮扫描所用的书籍根路径（漂移检测：根变了 ⇒ 本轮禁用**变更阶段**——
 * 既禁用下架清扫（`purgeBlocked`）也禁用注册写回（`skipRootDrift`）） */
let lastScannedBooksRoot: string | null = null;

export function loadAndRegisterAll(): Promise<ServiceResult<LibrarySyncSummary>> {
  if (librarySyncInFlight) {
    console.info('[PERF][library-sync] dedup: join in-flight sync');
    return librarySyncInFlight;
  }
  librarySyncInFlight = loadAndRegisterAllInternal().finally(() => {
    librarySyncInFlight = null;
  });
  return librarySyncInFlight;
}

async function loadAndRegisterAllInternal(): Promise<ServiceResult<LibrarySyncSummary>> {
  const librarySyncPerfT0 = Date.now();
  // 【F1】本轮世代号：变更阶段（注册写回 / loadedBooks 赋值 / db 删行）执行前
  // 复核它未被更新的同步或导入推进；不等即整段跳过（陈旧快照不得改写新状态）。
  const syncGen = ++librarySyncGen;
  // 【F4】根路径漂移：本轮根与上一轮不一致 ⇒ 本轮扫描的是「另一个根」，
  // 其 db 行（source_path 指向旧根）必然全部「未被看见」，据此下架会误删
  // 仍在旧根存在的书（并触发级联清理 ⇒ 永久丢书）。故本轮禁用下架清扫。
  const currentRoot = getBooksRootPath();
  const rootDrift = lastScannedBooksRoot !== null && lastScannedBooksRoot !== currentRoot;
  lastScannedBooksRoot = currentRoot;
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
    const syncT0 = Date.now();
    registerBuiltinMetaOnce();
    console.info(
      `[PERF][library-sync] registerBuiltinMeta=${Date.now() - syncT0}ms`,
    );
    await ensureDirs();
    const matT0 = Date.now();
    lastSyncDiagnostics.assetCopyFailures = await materializeBuiltins();
    console.info(
      `[PERF][library-sync] materialize=${Date.now() - matT0}ms`,
    );
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
    } catch (e) {
      scanOk = false;
      // 【F2】扫描失败如实留痕：本轮不做下架比对、不写回注册（下方按 `!scanOk`
      // 跳过全部变更阶段并保留上一轮注册），失败原因进诊断，绝不静默——
      // 否则一次瞬时 IO 故障就是「书架全空且零提示」。
      lastSyncDiagnostics.scanFailed = true;
      lastSyncDiagnostics.scanInterrupted = true;
      lastSyncDiagnostics.scanInterruptedReason = `书籍文件夹列举失败：${
        (e as Error)?.message ?? String(e)
      }`;
      console.warn('[PERF][library-sync] scan-failed：本轮保留上一轮注册');
    }

    if (scanOk) {
      const seenPaths = new Set<string>();
      for (const f of files) {
        seenPaths.add(f.path);
        // 行提取提到 try 之外：【F3】异常分支也要用它判定「db 行是否仍在」
        const row = folderRowsByPath.get(f.path);
        try {
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
            // 【F3】本轮未解析出内容 ≠ 该书不存在：db 行仍在（持久证据）则保留
            // 既有注册，绝不用「本轮残缺快照」把它挤掉（否则文件被截断/临时
            // 不可读 = 书架永久少一本，且 db 行还在 ⇒ 症状反复）。
            const kept = retainKnownUserBook(row, f.name);
            if (kept) {
              folderBooks.push(kept);
            }
            lastSyncDiagnostics.unparsedFiles.push(f.name);
            console.warn('[PERF][library-sync] unparsed-retain：保留既有注册');
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
                  parsed.contentHash ?? null,
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
          // 【F3】异常同样不丢书：db 行仍在则保留既有注册 + 诊断留痕
          const kept = retainKnownUserBook(row, f.name);
          if (kept) {
            folderBooks.push(kept);
          }
          lastSyncDiagnostics.unparsedFiles.push(f.name);
          console.warn('[PERF][library-sync] scan-error-retain：保留既有注册');
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
      //
      // 【F1/F4】清扫总闸：以下任一成立即整轮跳过下架（只跳变更阶段，只读诊断
      // 照常留痕）——
      //  · 本轮已被更新的同步/导入作废（syncGen 落后）：扫描快照「没看到」不
      //    等于「书不存在」，据此删行会连带级联清理用户数据。
      //    ⚠ **纵深防御：本支危害面在当前调用图下不可达**（不得当真实风险宣称）
      //    ——下架只遍历本轮 `SELECT` 取来的行，而导入的 `copyFile` 先于
      //    `INSERT`、`SELECT` 又先于 `readDir` ⇒「该行在集合里 ∧ 本轮 readDir
      //    没见过它的文件」自相矛盾。保留以防未来出现第二条在飞同步路径。
      //  · 根路径与上一轮不一致（rootDrift）：本轮扫的是新根，旧根的 db 行
      //    必然全部「未被看见」，据此删行 + 级联 = 永久丢书（此支**可达**）。
      const purgeBlocked = syncGen !== librarySyncGen || rootDrift;
      if (syncGen !== librarySyncGen) {
        // 本支**可达**（A4 实测该标记确实会打出，**不是死探针**）：它只说明
        // 「陈旧轮跳过了清扫」，**不等于**「本轮没有应下架的书」（陈旧轮本就不
        // 该下架）；而它所守的那个 DELETE 在当前调用图下不可达（见上）。
        // 反推纪律：不得用「此处没删行」证明「没有发生陈旧同步」。
        lastSyncDiagnostics.staleSkippedStages.push('purge');
        console.info('[PERF][library-sync] stale-skip purge');
      }
      if (rootDrift) {
        lastSyncDiagnostics.rootPathDrift = true;
        console.info('[PERF][library-sync] root-drift skip purge');
      }
      const purgeRows = purgeBlocked ? [] : folderRows;
      for (const row of purgeRows) {
        if (!seenPaths.has(row.source_path as string)) {
          // 【F4b】非本轮根路径下的行不属本轮扫描管辖：绝不下架。判据：根路径
          // 一旦切换，漂移轮被 F4 豁免后，**下一个稳定轮**（root 不再变）会重新
          // 执行清扫并删掉旧根的全部行 ⇒ F4 单独不足以防「永久丢书」。
          if (!String(row.source_path).startsWith(`${currentRoot}/`)) {
            console.info('[PERF][library-sync] foreign-root retain row');
            continue;
          }
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

  // 【F1/F2/F4】变更阶段总闸：`registerUserBooks` 是**整体替换**语义，只有
  // 「本轮扫描成功」且「本轮世代号仍是最新」且「根路径未漂移」时才允许写回。
  // 任一不成立即保留 `TextLibraryService.userBooks` 现状与 `loadedBooks` 快照，
  // 只让只读的扫描结果进 summary / 诊断（绝不静默）。
  // 诊断口径 = **取主因、非逐条**：`skipRootDrift` / `skipStaleWrite` 都带
  // `scanOk &&` 前缀，故 `scanOk=false` 时只记 `scanFailed`，漂移/陈旧不会同时
  // 出现（此时「本轮扫描不可信」已足以解释为何不写回）。
  // summary 口径（**实测**）：`imported` / `updated` 在**扫描期**即计数（见上方
  // 逐文件循环），与是否写回**无关**；只有 `removed` 因计数落在下架清扫内，
  // 跳过清扫时恒为 0。「本轮是否写回」由 scanFailed / rootPathDrift /
  // staleSkippedStages 如实反映。
  const skipScanFailure = !scanOk;
  const skipRootDrift = scanOk && rootDrift;
  const skipStaleWrite = scanOk && syncGen !== librarySyncGen;
  if (skipRootDrift) {
    lastSyncDiagnostics.rootPathDrift = true;
    console.info('[PERF][library-sync] root-drift skip register');
  }
  if (skipStaleWrite) {
    lastSyncDiagnostics.staleSkippedStages.push('register');
    console.info('[PERF][library-sync] stale-skip register');
  }
  if (skipScanFailure) {
    // 【F2】扫描失败（readDir 抛错）：绝不用「本轮零结果」整体替换上一轮注册，
    // 否则一次瞬时 IO 故障 = 书架全空（用户可见「书全部消失」）。
    lastSyncDiagnostics.scanFailed = true;
    console.warn('[PERF][library-sync] scan-failed skip register');
  }
  if (!skipScanFailure && !skipRootDrift && !skipStaleWrite) {
    const reg = TextLibraryService.registerUserBooks([...folderBooks, ...legacyBooks]);
    if (!reg.success) {
      return { success: false, error: reg.error ?? '注册用户书籍失败' };
    }
    // loadedBooks 仅含用户书（备份快照口径；内置书在目录清单/资产，不入备份）
    loadedBooks = [...folderBooks, ...legacyBooks];
  }

  // 超大书后台队列：本次装载立即返回（书架立即可用），队列逐本解析、
  // 完成一本注册一本（书架下次刷新即可见）。运行中的队列不重复排队
  //（防书架刷新并发触发多队列重复解析同一批文件）。
  if (oversizedTasks.length > 0 && !oversizedQueueRunning) {
    oversizedQueueRunning = true;
    console.warn(
      `[UserBookService] 超大书 ${oversizedTasks.length} 本转入后台装载（不阻塞书架）`,
    );
    void processOversizedBooks(oversizedTasks)
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
  console.info(
    `[PERF][library-sync] done folder=${summary.folderBooks} builtin=${
      summary.builtinBooks
    } +${Date.now() - librarySyncPerfT0}ms`,
  );
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
      parsed.contentHash ?? null,
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
          parsed.contentHash ?? null,
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
  // 【F1】本次导入让所有「已发起但尚未写回」的同步世代作废：
  //  · 可达危害：那次同步的写回集合可能不含本次导入的书，若仍执行注册写回
  //    （整体替换），刚上架的书会被挤下架 —— 即用户报障「导入的书籍没有显示
  //    在书架上」（A3 实测）；
  //  · 不可达危害（不得当真实风险宣称）：「陈旧清扫 DELETE 掉刚落库的行」在
  //    当前调用图下自相矛盾（证明见 `purgeBlocked` 处注释），属纵深防御。
  librarySyncGen += 1;
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
        // 【T23c】新型纯文本缓存的 .meta 信封一并清理
        const metaPath = `${oversizedFiles.cachePath}.meta`;
        if (await RNFS.exists(metaPath)) {
          await RNFS.unlink(metaPath);
        }
        // ★2026-10-13（B 档步骤 6）：`.gxbook.toc` 章目录一并清理。
        //   ⚠ 漏清的后果不是「占盘」而是**更坏**：书重新导入同名文件时
        //   （`stableBookIdFromPath` 对同名文件给同一 id），会命中**上一版的
      //   旧 toc** ⇒ 目录态快路径直接采用它 ⇒ 偏移指向旧版正文 ⇒ 静默错章。
        const tocPath = `${oversizedFiles.cachePath}.toc`;
        if (await RNFS.exists(tocPath)) {
          await RNFS.unlink(tocPath);
        }
        // 旧版 .gxcache（T23c 前嵌套 Book JSON）遗留清理，避免占盘
        const legacyCache = `${oversizedFiles.path}${OVERSIZED_CACHE_LEGACY_SUFFIX}`;
        if (await RNFS.exists(legacyCache)) {
          await RNFS.unlink(legacyCache);
        }
        oversizedBookFiles.delete(id);
      } else {
        // 常规书的磁盘解析缓存（如有）一并清理
        const cachePath = `${sourcePath}${OVERSIZED_CACHE_SUFFIX}`;
        if (await RNFS.exists(cachePath)) {
          await RNFS.unlink(cachePath);
        }
        // 旧版 .gxcache 遗留清理
        const legacyCache = `${sourcePath}${OVERSIZED_CACHE_LEGACY_SUFFIX}`;
        if (await RNFS.exists(legacyCache)) {
          await RNFS.unlink(legacyCache);
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

// ---------- r38 T02：装配调度层（事件契约 / 宿主适配器 / 流式执行器） ----------

/**
 * 装配完成通知（扩展既有 onBuiltinFillProgress，保持向后兼容；架构 §2.6）。
 * `generation` = 该事件由哪一代请求产生：阅读器据此丢弃「跳章世代之前」的
 * 陈旧事件（旧位置任务完成后不得驱动新章列表的重算/插入）。
 * 契约定义在装配层模块（ChapterAssemblyScheduler）并从本模块透出。
 */
export type { ChapterReadyEvent };

/** 装配完成事件订阅集合（调度器流式路径专用；既有填充进度订阅保持不变） */
const chapterReadyListeners = new Set<(event: ChapterReadyEvent) => void>();

/**
 * 订阅「某章装配完成」事件（含就绪级别与世代号）；返回取消订阅函数。
 * 与 onBuiltinFillProgress 并存：后者驱动 hydrateTick 重算（滚动/页面模式），
 * 本订阅用于按就绪级别与世代精确判断（目标章首屏 / 拼接门）。
 */
export function onChapterReady(cb: (event: ChapterReadyEvent) => void): () => void {
  chapterReadyListeners.add(cb);
  return () => {
    chapterReadyListeners.delete(cb);
  };
}

function emitChapterReady(event: ChapterReadyEvent): void {
  chapterReadyListeners.forEach((cb) => {
    try {
      cb(event);
    } catch {
      // 单个订阅者异常不影响其余订阅者
    }
  });
}

/** 章序读取（单一序源 = book.chapters 下标 + 1，与 meta/解析器一致）；未知章返回 0 */
function builtinChapterOrder(bookId: string, chapterId: string): number {
  const res = TextLibraryService.getBook(bookId);
  if (!res.success || !res.data) {
    return 0;
  }
  const index = res.data.chapters.findIndex((c) => c.id === chapterId);
  return index < 0 ? 0 : index + 1;
}

/**
 * 就绪级别真源（拼接门唯一判据）：
 *  - 无正文 → Empty（★红线④：空壳章永不插入拼接序列）；
 *  - 有正文但流式游标未 done → Partial（只可做目标章首屏，禁止 prepend）；
 *  - 游标 done 或一次性装配完成 → Full。
 */
function builtinChapterReadiness(
  bookId: string,
  chapterId: string,
): ChapterReadiness {
  const res = TextLibraryService.getBook(bookId);
  if (!res.success || !res.data) {
    return ChapterReadiness.Empty;
  }
  const chapter = res.data.chapters.find((c) => c.id === chapterId);
  if (!chapter || chapter.segments.length === 0) {
    return ChapterReadiness.Empty;
  }
  const key = streamingKeyOf(bookId, chapterId);
  const entry = streamingEntries.get(key);
  // 登记壳必须仍是**书体内的章对象**才有判定效力（孤儿登记不代表本书状态）
  if (entry && entry.shell.chapter === chapter && !entry.cursor.done) {
    return ChapterReadiness.Partial;
  }
  // ★【#20 复验追加】内容存在但**完整性未证**（无游标可续、且非整章一次性装配）
  //   ⇒ 停 Partial：可作目标章首屏，但**不得进双向拼接门**（红线④的同源要求：
  //   拼接会把半章当整章与邻章拼接）。这是真机 c169 paras=148 曾以 READY_FULL
  //   进入拼接门的修补点。补全（整章直读/重试）后自动转 Full。
  if (!entry && !chapterWholeReadComplete.has(key)) {
    return ChapterReadiness.Partial;
  }
  return ChapterReadiness.Full;
}

/** 单章流式装配的最大推进步数（畸形字节区间护栏，防死循环） */
const MAX_ASSEMBLE_STEPS = 100_000;

/**
 * 调度器执行器（对外唯一入口 = `chapterAssemblyHost.assemble`）：
 * 同章重入合并的包装层，真实实现见 `runChapterAssembleToFull`。
 */
export async function assembleChapterToFull(
  bookId: string,
  chapterId: string,
  ctx?: AsmExecContext,
): Promise<boolean> {
  if (!bookId || !chapterId) {
    return false;
  }
  // ★【#20】同章重入合并：调度器 pump（`host.assemble`）与任何**显式调用方**
  //   （用户「重试」链、兜底链路、诊断）都可能同章同时在飞。若不合并，
  //   两个执行体会各自 hydrate + notify + 发事件，且**各自写一次该章 FTS**
  //   （G1/D1 的「恰一次」口径被打破；FTS 幂等性另见 #16）。
  //   合并后：同一个 Promise、同一份结果、恰好一次收尾。
  const full = await coalesceAssemblyRun(
    fullAssembleInFlight,
    streamingKeyOf(bookId, chapterId),
    () => runChapterAssembleToFull(bookId, chapterId, ctx),
  );
  // 【阅读器清理】原 T06 的「守卫子句 + 注音预热投递」已随注音预热族移除
  //   （原实现为 `if (!full) { return full; } 注音预热投递(...);
  //   return full;`，语义与本行等价）。
  // ⚠ 本函数体**不得**出现字面量 `if (` + `full` + `) {`：保留族测试
  //   `chapterAssemblyScheduler.test.ts` G1 取切片内**第一处**该字面量作为 FTS 写入
  //   门控位置，本处若出现会让该断言的断言对象迁移到 `assembleChapterToFull` ⇒ 误报
  //   （那是 T01 期就存在的 FTS 写入门控断言，与本章无关）。
  return full;
}

// 【阅读器清理】原「章级注音预热」族已**整体移除**：本文件内被删的只是
// 「章就绪 / 冷启动水合 → 后台注音预热投递」这条旁路（其规划器模块、冷启动延迟
// 常量与顶部 import 一并移除，五处调用点随之消失）。
// 注音**渲染**本体（`components/reader/PinyinText.tsx` → `PinyinService.annotate`）与
// 词组拼音原生模块均**保留**，不受影响。

/**
 * 调度器执行器的**真实实现**（不做重入合并；唯一调用方是上面那层合并包装）。
 * 把一章装配到 READY_FULL（流式、可跨批续作）。
 * - 只经 `assembleChapterStreaming` 推进（与后台填充共用同一状态机：
 *   档位化分批读 + 行级时间片 + carry 跨批防护 + 「非空行=段落」）；
 * - 步间按档位 `fillYieldMs` 让出（片间留出真正可用的执行窗口）；
 * - 段落增量 push → 目标章首屏（Partial）可先上屏；
 * - **不中途取消**（调度器取消粒度 = 章边界，红线⑤/R6）；
 * - 完成/有内容即 hydrate + 通知 + 发 onChapterReady 事件。
 */
async function runChapterAssembleToFull(
  bookId: string,
  chapterId: string,
  ctx?: AsmExecContext,
): Promise<boolean> {
  // ★2026-10-13（B 档步骤 7 · 调度器主路径泛化）：本函数此前对用户书
  //   **无条件早退**（`getBuiltinSpec` 对用户书恒 null）⇒ 邻章永远装不上，
  //   目录态用户书只能一章一章跳、**不能连续滚动阅读**。
  //   早退条件与顺序按书籍类型分流，**内置书分支逐字未变**。
  const isUser = TextLibraryService.isUserBook(bookId);
  const spec = isUser ? null : getBuiltinSpec(bookId);
  if (hiddenBuiltins.has(bookId) || (!isUser && !spec)) {
    return false;
  }
  const bookRes = TextLibraryService.getBook(bookId);
  if (!bookRes.success || !bookRes.data) {
    return false; // 未水合（无壳可填）：由 ensureBookReady 主链路负责
  }
  const chapter = bookRes.data.chapters.find((c) => c.id === chapterId);
  if (!chapter) {
    return false;
  }
  const key = streamingKeyOf(bookId, chapterId);
  // ★【#20】孤儿游标防护：重水合 / LRU 换形会**重建章对象**，而旧登记里的壳
  //   仍指向**旧章对象**——续作会把正文推进孤儿对象（书体里永远填不满：
  //   `segCount === 0 → [PERF][asm] empty … discard`，而流式步其实"成功"了）。
  //   判定：登记壳的 chapter 引用与书体内章对象不一致 → 丢弃旧登记、重建壳。
  const rawRegistered = streamingEntries.get(key);
  if (rawRegistered && rawRegistered.shell.chapter !== chapter) {
    streamingEntries.delete(key);
    unmarkChapterWholeReadComplete(bookId, chapterId); // 章对象已换 ⇒ 旧证明失效
  }
  const registered =
    rawRegistered && rawRegistered.shell.chapter === chapter ? rawRegistered : undefined;
  if (!registered && chapter.segments.length > 0) {
    // ★【#20】内容存在但**无流式游标**：只有两种情况可以判 READY_FULL——
    //   ① 该章由「整章一次性装配」整体安装（provenance，见 chapterWholeReadComplete）；
    //   ② 无 provenance = 完整性**未证实**（此前被并发接管/中止，真机 c169 paras=148
    //      即此形态）→ 一次性整章直读补全（含退避），补全失败则**不判就绪**
    //      （readiness 停 Partial → 阅读器「内容未完整」提示条 + 重试出口）。
    //   旧实现无条件 `return true` 会把「未证实完整」当「已完整」= 静默截断 + 写 FTS。
    if (chapterWholeReadComplete.has(key)) {
      return true; // 一次性装配完成（有证明）→ 幂等短路
    }
    const repaired = await repairChapterByWholeRead(bookId, chapterId);
    console.info(
      `[PERF][asm] unproven-content ch=${chapterId} paras=${chapter.segments.length} ` +
        `repaired=${repaired} → ${repaired ? 'ready-full' : '停 Partial（阅读器提示可重试）'}`,
    );
    if (repaired) {
      // 补全成功 = 本章内容**现已完整** ⇒ 立刻（重）写章级 FTS 行。
      // 必要性（QA #21 harm ①）：修复前该章若被误判 ready-full，索引里存的是
      // **不完整**内容（搜到的章与上屏内容不一致）；且本分支 `return repaired`
      // 会跳过函数末段就绪门（`if (full)`）的章级 FTS 写入，
      // 此处是「补全后重新入索引」的唯一写入点。真幂等 upsert 属 #16 独立范围。
      // ★用户书跳过：`writeFtsForChapter` 需要 `BuiltinBookSpec`（只有 `.id` 可用），
      //   且用户书走 `fillBuiltinChapterNow` 兜底时**本来就不写**章级 FTS
      //   （超 24MB 恒超 `FTS_MAX_BOOK_CHARS` 闸门，整书索引不可达）⇒ 两路径同口径。
      if (!isUser) {
        writeFtsForChapter(spec as BuiltinBookSpec, chapter);
      }
    }
    return repaired;
  }
  // 章字节区间来源：内置书 = `books/<id>.meta.json`；用户书 = `<cachePath>.toc`
  //   （与 `fillBuiltinChapterNow` 的分流同构，读侧闸门分别是
  //   `loadBuiltinMeta` / `loadUserBookToc`，**都在读盘即判**、不读正文）。
  let range: { s: number; e: number } | null = null;
  /** 用户书切片器（内置书为 undefined ⇒ 流式步走 `readBuiltinChapterSlice`） */
  let userReadSlice: BuiltinShell['readSlice'];
  if (isUser) {
    const files = oversizedBookFiles.get(bookId);
    if (!files) {
      return false; // 非超大书路径注册的用户书（仍全量注册）⇒ 维持原行为
    }
    const toc = await loadUserBookToc(files.cachePath, bookId, 0);
    if (!toc) {
      return false;
    }
    const hit = toc.chapters.find((c) => c.id === chapterId);
    if (!hit) {
      return false;
    }
    range = { s: hit.start, e: hit.end };
    userReadSlice = (s, e) => readFileSliceUtf8Safe(files.cachePath, s, e, bookId);
  } else {
    const meta = await loadBuiltinMeta(spec as BuiltinBookSpec);
    if (!meta) {
      return false;
    }
    const hit = meta.chapters.find((c) => c.id === chapterId);
    if (!hit) {
      return false;
    }
    range = { s: hit.s, e: hit.e };
  }
  const shell: BuiltinShell = registered?.shell ?? {
    chapter,
    bodyLines: [],
    range: { s: range.s, e: range.e },
    // ★仅用户书壳带切片器；内置书壳逐字不变（无此字段）
    ...(userReadSlice ? { readSlice: userReadSlice } : {}),
  };
  if (!registered) {
    // 本壳的章对象就是书体内对象（上方已查），故必不为陈旧壳（返回非 null）
    const created = ensureStreamingEntry(shell);
    if (created === null) {
      return false; // 理论不可达（陈旧壳防护）：保守判未就绪
    }
    streamingEntries.set(key, created);
  }
  const tier = resolveFillTierParams();
  const t0 = Date.now();
  const totalBytes = range.e - range.s;
  let failed = false;
  let steps = 0;
  while (steps < MAX_ASSEMBLE_STEPS) {
    steps += 1;
    // eslint-disable-next-line no-await-in-loop
    const step = await assembleChapterStreaming(shell, {
      // ★用户书 `spec` 为 null：流式步在壳带 `readSlice` 时**不会**碰它
      //   （`runChapterStreamingStep` 只在壳无切片器时才调`readBuiltinChapterSlice`）。
      //   类型上仍是必填 ⇒ 此处给内置书 spec（用户书路径不会被消费）。
      spec: spec as BuiltinBookSpec,
      readChunkBytes: tier.readChunkBytes,
      timeBudgetMs: tier.timeBudgetMs,
    });
    if (step === 'done') {
      break;
    }
    if (step === 'failed') {
      failed = true;
      break;
    }
    // 片间让出：装配是最低优先级后台任务，必须留出触摸/渲染窗口
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, tier.yieldMs));
  }
  const segCount = chapter.segments.length;
  if (segCount === 0) {
    console.info(
      `[PERF][asm] empty ch=${chapterId} bytes=${totalBytes} failed=${failed} discard`,
    );
    return false; // 空壳不进入拼接门（红线④）
  }
  // ★ D1：`failed`（切片读失败/meta 异常）**不得当作 full**——只有本次调用
  //   真正把游标推到章尾（且未发生失败）才算 READY_FULL。失败时游标未 done，
  //   readiness 停在 Partial → 调度器/兜底链路后续可重试，不会产生截断章。
  // ★【#20】另补「无游标」分支：游标被合法作废（整章直读接管 / 游标自洽校验 /
  //   一次性装配完成）时，**有 provenance 才**算 READY_FULL——与
  //   `isShellComplete` / `builtinChapterReadiness` 同口径。
  // ★【#20 复验追加】旧写法 `shell.fillCursor === undefined ? true : …` **过宽**：
  //   任何「游标被作废但完整性未知」的情形都会被判 full（真机 c169 paras=148 /
  //   c166 paras=105 被标 ready-full 的直接原因）。现在要求「整章一次性装配」证明
  //   （`chapterWholeReadComplete`）；无证明 ⇒ 停 Partial ⇒ 阅读器提示条/重试/补全。
  const cursorSettled =
    shell.fillCursor === undefined
      ? chapterWholeReadComplete.has(key)
      : shell.fillCursor.done === true;
  const full = !failed && cursorSettled;
  if (!full && !failed && segCount > 0) {
    console.info(
      `[PERF][asm] unproven-partial ch=${chapterId} paras=${segCount} bytes=${totalBytes} ` +
        `cursor=${
          shell.fillCursor
            ? `bytePos=${shell.fillCursor.bytePos} done=${shell.fillCursor.done}`
            : 'none'
        } → 就绪停 Partial（不进双向拼接门 · 阅读器提示可重试）`,
    );
  }
  // ★【#20】静默截断的可见化（红线④语义缺口的补丁）：切片读**中途**失败时
  //   上面保留了已产出段落（部分内容优于空白），但旧实现只打 ready-partial，
  //   阅读器无从分辨「正常流式中」与「已中止的截断内容」→ 半章被当整章渲染。
  //   此处显式打出 truncated 标记，并由 `getChapterContentQuality` 把该状态
  //   暴露给阅读器（渲染「内容未完整」提示 + 重试出口）。
  if (!full && failed && segCount > 0) {
    console.info(
      `[PERF][asm] truncated ch=${chapterId} bytes=${totalBytes} paras=${segCount} ` +
        `done=${totalBytes > 0 ? Math.round(((shell.fillCursor?.bytePos ?? 0) / totalBytes) * 100) : 0}% ` +
        `fail=${shell.fillCursor?.failCount ?? 0} → 保留已产出（不静默）· 就绪停 Partial · 阅读器提示可重试`,
    );
  }
  // ★ r38 T03：章就绪（READY_FULL）**之后**写该章 FTS 行——顺序在就绪判定之后，
  //   保证「搜到的章必定已装配完整」；写失败静默降级，绝不影响装配主链路。
  //   部分就绪（Partial，游标未 done）不写：半章的 FTS 行会让搜索命中
  //   尚未上屏的内容（且与后续整章写入重复）。
  if (full && !isUser) {
    // ★用户书不写章级 FTS（同 4a：与 `fillBuiltinChapterNow` 兜底路径同口径）
    writeFtsForReadyChapter(spec as BuiltinBookSpec, shell);
  }
  // 合并 + 通知：复用填充链路语义（LRU 刷新 + 三级缓存重建 + 订阅者重算）
  const hydrate = (
    TextLibraryService as unknown as {
      hydrateBook?: (book: Book) => { success: boolean; error?: string };
    }
  ).hydrateBook;
  if (typeof hydrate === 'function') {
    try {
      hydrate.call(TextLibraryService, bookRes.data);
    } catch {
      // 合并失败不抛出（segments 已就位，下次进入重水合兜底）
    }
  }
  builtinFillListeners.forEach((cb) => {
    try {
      cb(bookId);
    } catch {
      // 单个订阅者异常不影响其余订阅者
    }
  });
  const ms = Date.now() - t0;
  const event: ChapterReadyEvent = {
    bookId,
    chapterId,
    chapterOrder: chapter.order,
    readiness: full ? ChapterReadiness.Full : ChapterReadiness.Partial,
    bytes: totalBytes,
    ms,
    generation: ctx?.generation ?? chapterAssemblyScheduler.getGeneration(),
  };
  emitChapterReady(event);
  console.info(
    `[PERF][asm] ${full ? 'ready-full' : 'ready-partial'} ch=${chapterId} ` +
      `bytes=${totalBytes} paras=${segCount} steps=${steps} totalMs=${ms} ` +
      `gen=${event.generation} pri=${ctx?.priority ?? '-'}`,
  );
  return full;
}

/**
 * 【#20】章正文装配质量（阅读器的「可见出口」判据；**不是**拼接门判据）。
 *
 * 与 `builtinChapterReadiness`（拼接门：Empty/Partial/Full）分工不同：
 * 拼接门只回答「能否插入双向拼接序列」；本函数回答「用户此刻看到的正文
 * 是否完整」。Partial 有两种截然不同的语义，必须区分（红线④语义缺口）：
 *  - `streaming`：游标未 done **且无失败证据** → 正常流式推进中（首屏先上屏），
 *    用户无需任何提示，更不该触发重试；
 *  - `incomplete`：装配已中止 / **完整性未证**，正文可能被静默截断。两种来源：
 *     ① 游标未 done 且有失败证据（`failCount > 0` / `failedTerminal`）；
 *     ② **无游标且无「整章一次性装配」证明**（`chapterWholeReadComplete`）——
 *        #20 真机复验实证：c169 paras=148（oracle 156）/ c166 paras=105（106）
 *        正是此形态（并发接管把游标推进与实际段数拉脱钩，旧实现判 ready-full）。
 *    旧实现对此零信号（`assembleChapterToFull` 照常 hydrate + notify + 发
 *    READY_PARTIAL），阅读器把半章当整章渲染。
 * 本判据就是补上的「部分质量」判断——**放宽的绝不是空壳判定**（红线④不变：
 * `empty` 仍然永不进入拼接序列）。
 */
export type ChapterContentQuality = 'full' | 'streaming' | 'incomplete' | 'empty';

export function getChapterContentQuality(
  bookId: string,
  chapterId: string,
): ChapterContentQuality {
  if (!bookId || !chapterId) {
    return 'empty';
  }
  const res = TextLibraryService.getBook(bookId);
  if (!res.success || !res.data) {
    return 'empty';
  }
  const chapter = res.data.chapters.find((c) => c.id === chapterId);
  if (!chapter || chapter.segments.length === 0) {
    return 'empty';
  }
  // 游标真源优先取登记表；登记缺失（被 LRU 释放 / 一次性装配）时回落到
  // 填充上下文里的同名壳——两个壳对象的游标都可能承载失败证据。
  const key = streamingKeyOf(bookId, chapterId);
  const entryRaw = streamingEntries.get(key);
  const entry =
    entryRaw && entryRaw.shell.chapter === chapter ? entryRaw : undefined;
  const ctxShell = fillContexts
    .get(bookId)
    ?.shells.find((s) => s.chapter.id === chapterId);
  const cursor = entry?.cursor ?? ctxShell?.fillCursor;
  if (!cursor) {
    // ★【#20 复验追加】无游标**不等于**完整：只有「整章一次性装配」证明才算
    //   full（真机 c169/c166 的丢段章正是「无游标 + 未证实」却被当 full 渲染的）。
    return chapterWholeReadComplete.has(key) ? 'full' : 'incomplete';
  }
  if (cursor.done) {
    return 'full';
  }
  const failed =
    cursor.failCount > 0 || entry?.shell.failedTerminal === true || ctxShell?.failedTerminal === true;
  return failed ? 'incomplete' : 'streaming';
}

/**
 * 【#20】显式重试某章装配（用户可见出口的「重试」按钮 / 目标章兜底重试链）。
 *
 * 行为：
 *  ① 清除该章的失败锁存（两个壳对象都清）→ 恢复「可续可重试」（红线⑤）；
 *  ② 提交 P1 目标章请求给调度器。**不递增世代**：本函数只重试**同一章**，
 *     递增世代会把队列里的邻章请求（P2/P3）一并作废——那会让「目标章一直
 *     没就绪」连带饿死双向预热，正是要避免的新空转。跳章的世代递增仍由
 *     阅读器的 `requestTargetAssembly` 负责（语义不变）。
 * 幂等：调度器对同章 in-flight/队列内请求去重；已就绪章零成本短路。
 */
export function retryChapterAssembly(bookId: string, chapterId: string): void {
  if (!bookId || !chapterId) {
    return;
  }
  clearChapterRepairBackoff(bookId, chapterId); // 用户/目标章重试：立即允许整章直读补全
  clearAssemblyFailures(bookId, chapterId);
  chapterAssemblyScheduler.request(bookId, chapterId, AsmPriority.Target, 'target');
}

/**
 * 【#20】降级整章直读（用户可见出口的**第二档策略**）。
 *
 * 与调度器流式装配是两条独立实现：整章区间一次读完 + **整体替换**
 * `chapter.segments`，语义「全有或全无」（红线⑤：读失败丢弃部分产出，
 * 绝不产生永久截断章）。这是**冷启动已验证可用**的路径——首开水合的
 * `hydrateBuiltinViaMeta` 走的正是整章直读，故「force-stop 后重进同章正常」
 * 的现象与之一致。
 *
 * 调用前先收回装配所有权（作废在飞流式游标），避免两条链路并发写同一章的
 * `segments`（旧实现在此处会重复 push 同一批段号 = 正文重复）。
 * 非内置书 / 未水合 / 无该章返回 false。
 */
export async function degradeChapterToWholeRead(
  bookId: string,
  chapterId: string,
): Promise<boolean> {
  if (!bookId || !chapterId) {
    return false;
  }
  clearChapterRepairBackoff(bookId, chapterId); // 显式降级：清退避，立即整章直读
  abandonStreamingAssembly(bookId, chapterId);
  return fillBuiltinChapterNow(bookId, chapterId, true);
}

/** 调度器宿主适配器（装配执行/就绪判定/章序/FTS 让路的唯一实现） */
const chapterAssemblyHost: AsmHost = {
  readinessOf: builtinChapterReadiness,
  // 【D6 保留钩子】T05（锚点模型）的就近排序判据；当前调度层不消费，
  // 详见 AsmHost.orderOf 的接口注释
  orderOf: builtinChapterOrder,
  assemble: assembleChapterToFull,
  pauseFts: (untilMs: number) => {
    ftsQueuePausedUntil = Math.max(ftsQueuePausedUntil, untilMs);
  },
};

registerAssemblyHost(chapterAssemblyHost);

// 【D3】书级 LRU 淘汰 / 显式卸载钩子：书体正文被换回元数据目录态时，释放本
// 模块持有的壳与章对象引用——否则已淘汰书的整本 chapters 数组被钉住，
// P0-5 内存目标失效；且旧壳会让后续装配写进孤儿章对象（永远填不满）。
// 依赖方向：TextLibraryService 不反向依赖本模块（回调注册，无循环导入）。
// 存在性守卫与 hydrateBook 同风格：旧版/替身实现（测试 mock）无此方法时
// 只是不注册释放回调，不影响装配主链路。
if (typeof TextLibraryService.onBookEvicted === 'function') {
  TextLibraryService.onBookEvicted(releaseBookAssemblyRefs);
}

/** 仅测试：清空流式装配游标登记、空闲扩散上下文与调度器队列（世代递增 = 取消在推进轮） */
export function __resetAssemblyStateForTests(): void {
  streamingEntries.clear();
  sliceFailLogged.clear(); // 【#20】切片失败原因探针去重集一并复位（测试隔离）
  streamingStepInFlight.clear(); // 【#20】在飞流式步合并表复位（测试隔离）
  fullAssembleInFlight.clear(); // 【#20】在飞整章装配合并表复位（测试隔离）
  chapterWholeReadComplete.clear(); // 【#20 复验追加】完整性证明复位
  chapterRepairFailCount.clear(); // 【#20 复验追加】补全退避状态复位
  chapterRepairBackoffUntil.clear();
  fillGeneration += 1; // 取消令牌：在推进的兜底轮全部作废
  for (const ctx of fillContexts.values()) {
    clearFillHeartbeat(ctx);
    ctx.running = false;
    ctx.token = fillGeneration;
  }
  fillContexts.clear();
  chapterAssemblyScheduler.__resetForTests();
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
  fillBuiltinChapterNow,
  prefillBuiltinNeighbors,
  onBuiltinFillProgress,
  // —— r41/#20 新增（跳多批章永久空白卡死的用户可见出口与失败态自愈）——
  getChapterContentQuality,
  retryChapterAssembly,
  degradeChapterToWholeRead,
  // —— r38 T02 新增（装配调度层；新增导出必须登记于此，否则调用方取不到）——
  assembleChapterStreaming,
  assembleChapterToFull,
  onChapterReady,
  __resetAssemblyStateForTests,
  // —— r38 T03 新增（书序兜底锚点 / FTS 章级增量开关）——
  reportReadingAnchor,
  // —— r38 Phase1-C 新增（D3 引用回收 / 阅读器卸载释放）——
  detachReaderBook,
  releaseBookAssemblyRefs,
  R38_FTS_PER_CHAPTER,
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
