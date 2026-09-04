/**
 * 用户书籍服务（UserBookService）
 * 用户上传书籍的完整链路：
 *   选文件（DocumentPicker，限支持的文本格式）→ 分块读取字节 →
 *   按格式转换（txt/md/html/fb2/epub → 纯文本+章节标记）→
 *   解析为 Book（章节/段落切分）→ user_books.db 持久化 → 注册进 TextLibraryService。
 * 与字典域隔离：独立 db 文件 user_books.db，严禁触碰 user_dict.db；
 * guoxue.db 仅经 StorageService 公共 API 写入 segments_fts 搜索索引行
 * （FTS 与导入/删除同步的唯一例外，保证同会话内导入即可搜、删除即清索引）。
 */
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import { open } from 'react-native-quick-sqlite';
import type { Book, ServiceResult } from '@/types';
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
  LARGE_BOOK_EXTENSIONS,
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

/** 支持的扩展名（选择器过滤用，见 bookFormat.SUPPORTED_BOOK_EXTENSIONS） */
const BOOK_EXTENSIONS: readonly string[] = SUPPORTED_BOOK_EXTENSIONS;
/** 单次 read 上限（RNFS.read 建议值 4MB） */
const READ_CHUNK_LIMIT = 4 * 1024 * 1024;
/** 文件大小上限（20MB，超出拒绝导入防止内存压力） */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
/** 大体积格式（epub/docx/odt/zip/mobi 等，含图片或压缩容器）上限放宽到 50MB */
const MAX_EPUB_SIZE = 50 * 1024 * 1024;
/** 段落最大码点数（超长段落切分，避免单段数千字影响渲染/划线索引） */
const MAX_SEGMENT_CHARS = 2500;
/** 无章节标记时，每章段落上限（超出则按此切「部分」） */
const SEGMENTS_PER_PART = 60;
/** 章节数上限（防畸形文件撑爆 db） */
const MAX_CHAPTERS = 5000;

type DB = ReturnType<typeof open>;

/** 已打开连接（惰性单例） */
let db: DB | null = null;

function getDb(): DB | null {
  if (db) {
    return db;
  }
  try {
    const instance = open({ name: USER_BOOKS_DB, location: DB_LOCATION });
    instance.execute(
      `CREATE TABLE IF NOT EXISTS user_books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    db = instance;
    return instance;
  } catch {
    return null;
  }
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

/** 分块读取文件为原始字节（base64 分块；sizeLimit 超限拒绝） */
export async function readFileBytes(
  uri: string,
  sizeLimit = MAX_FILE_SIZE,
): Promise<ServiceResult<Uint8Array>> {
  try {
    // file:// 前缀 + URL 编码会让 RNFS（java.io.File）找不到文件 → "File does not exist"
    const path = toLocalPath(uri);
    const stat = await RNFS.stat(path);
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size < 0) {
      return { success: false, error: '无法读取文件大小' };
    }
    if (size > sizeLimit) {
      return { success: false, error: `文件过大（上限 ${Math.round(sizeLimit / 1024 / 1024)}MB）` };
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

/**
 * 将文本解析为 Book。
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
  const fallbackTitle =
    fileName.replace(/\.(txt|md|markdown|html?|xhtml|fb2|epub)$/i, '').trim() || '未命名书籍';
  const title = opts?.title?.trim() || fallbackTitle;
  const author = opts?.author?.trim() || '佚名';
  const normalized = text.replace(/\r\n?/g, '\n');

  // 1) 切出 [章节标题, 标题下正文] 序列
  const lines = normalized.split('\n');
  type RawChapter = { title: string; body: string[] };
  const rawChapters: RawChapter[] = [];
  let current: RawChapter | null = null;
  const preface: string[] = [];
  let markerCount = 0;
  for (const line of lines) {
    const marker = opts?.markers ? CHAPTER_MARKER_LINE_RE.exec(line) : null;
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

// ============ 持久化与注册 ============

/** 内存中的用户书列表（注册进 TextLibraryService 的数据源） */
let loadedBooks: Book[] = [];

/** 从 db 读取全部用户书并注册进 TextLibraryService（App 启动时调用一次） */
export async function loadAndRegisterAll(): Promise<ServiceResult<null>> {
  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }
  try {
    const res = instance.execute(
      'SELECT data FROM user_books ORDER BY created_at DESC',
    );
    const rows = (res.rows?._array ?? []) as Array<{ data: string }>;
    const books: Book[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as Book;
        if (parsed && parsed.id && Array.isArray(parsed.chapters)) {
          books.push(parsed);
        }
      } catch {
        // 单条损坏数据跳过，不影响其他书籍
      }
    }
    const reg = TextLibraryService.registerUserBooks(books);
    if (!reg.success) {
      return reg;
    }
    loadedBooks = books;
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: `加载用户书籍失败：${(e as Error).message}` };
  }
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
      instance.execute(
        'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at) VALUES (?, ?, ?, ?, ?)',
        [book.id, book.title, book.author, JSON.stringify(book), Date.now()],
      );
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

/** 导入一本书：选文件 → 读取 → 解析 → 存库 → 注册 → 刷新内存列表 */
export async function importBook(
  picked?: PickedBookFile,
): Promise<ServiceResult<Book>> {
  const pickRes = picked ? { success: true, data: picked } : await pickBookFile();
  if (!pickRes.success || !pickRes.data) {
    return { success: false, error: pickRes.error ?? '已取消选择文件' };
  }
  const file = pickRes.data;

  const ext = file.fileName.split('.').pop()?.toLowerCase() ?? 'txt';
  // 含图片/压缩容器格式体积偏大，放宽限制
  const bytesRes = await readFileBytes(
    file.uri,
    LARGE_BOOK_EXTENSIONS.includes(ext) ? MAX_EPUB_SIZE : MAX_FILE_SIZE,
  );
  if (!bytesRes.success || !bytesRes.data) {
    return { success: false, error: bytesRes.error ?? '读取文件失败' };
  }

  let text: string;
  let metaTitle: string | undefined;
  let metaAuthor: string | undefined;
  if (isStructuredFormat(ext)) {
    try {
      const converted = convertBookBytes(ext, bytesRes.data);
      text = converted.text;
      metaTitle = converted.title;
      metaAuthor = converted.author;
    } catch (e) {
      return { success: false, error: `${ext.toUpperCase()} 解析失败：${(e as Error).message}` };
    }
  } else {
    text = decodeTextBytes(bytesRes.data).text;
  }

  const book = parseTxtBook(file.fileName, text, undefined, {
    markers: isStructuredFormat(ext),
    title: metaTitle,
    author: metaAuthor,
    sourceLabel: ext.toUpperCase(),
  });
  if (book.chapters.length === 0) {
    return { success: false, error: '未解析出任何内容（文件可能为空）' };
  }

  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }
  try {
    instance.execute(
      'INSERT OR REPLACE INTO user_books (id, title, author, data, created_at) VALUES (?, ?, ?, ?, ?)',
      [book.id, book.title, book.author, JSON.stringify(book), Date.now()],
    );
  } catch (e) {
    return { success: false, error: `保存书籍失败：${(e as Error).message}` };
  }

  const next = [book, ...loadedBooks];
  const reg = TextLibraryService.registerUserBooks(next);
  if (!reg.success) {
    return { success: false, error: reg.error };
  }
  loadedBooks = next;
  // BugFix：FTS 同步入索引——此前新书要等下次冷启动 ensureFtsIndex 才可搜，
  // 同会话内导入后立即搜索无结果。导入书可能很大（数千段），保持同步
  // 逐条插入（与全量构建同级代价），换取同会话内立即可搜。
  // 取舍：FTS 写入失败不阻断导入——书籍主体已持久化且已注册，失败仅意味着
  // 本次会话搜索暂缺该书，下次冷启动 ensureFtsIndex 增量构建会补齐，故吞错降级。
  StorageService.upsertFtsForBook(book);
  return { success: true, data: book };
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

/** 删除一本用户书（划线/笔记按 segmentId 存储，将随段落失效而不再显示） */
export async function deleteBook(id: string): Promise<ServiceResult<null>> {
  if (!isUserBook(id)) {
    return { success: false, error: '内置经典不可删除' };
  }
  const instance = getDb();
  if (!instance) {
    return { success: false, error: '用户书籍数据库不可用' };
  }
  try {
    instance.execute('DELETE FROM user_books WHERE id = ?', [id]);
  } catch (e) {
    return { success: false, error: `删除失败：${(e as Error).message}` };
  }
  const next = loadedBooks.filter((b) => b.id !== id);
  const reg = TextLibraryService.registerUserBooks(next);
  if (!reg.success) {
    return { success: false, error: reg.error };
  }
  loadedBooks = next;
  // BugFix：FTS 同步清索引——此前已删书在 segments_fts 中残留死索引，
  // 搜索仍会命中（点进去加载失败）。清理失败同样不阻断删除结果：
  // 书已不在文本库中，下次冷启动 ensureFtsIndex 的死索引自愈会兜底清除。
  StorageService.deleteFtsForBook(id);
  // BugFix：级联清理孤儿用户数据（背诵进度/收藏/笔记/续读位置）——
  // 重导入同文件生成新 bookId，残留数据永远挂不回，详见 cascadeCleanupAfterDelete。
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
  loadAndRegisterAll,
  isUserBook,
  getAllBooks,
  importBook,
  deleteBook,
  restoreUserBooks,
};

export default UserBookService;
