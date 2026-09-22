/**
 * 【#20 复验追加】真实资产 × 低档 32KB 切片：流式装配的**完整性 oracle** 对拍。
 *
 * QA 复验（#20）在真机抓到 2 条原始行：`ready-full` 但段数**少于**资产段落数：
 *   `ready-full ch=tongjian-c169 bytes=34663 paras=148`（oracle 156）
 *   `ready-full ch=tongjian-c166 bytes=32940 paras=105`（oracle 106）
 * 且同章另一次装配是完整的（156），即**间歇性丢段**。
 *
 * 本文件用**真实资产字节**（`android/app/src/main/assets/books/tongjian.*`）在
 * CI 里给出可复算的 oracle，并回答两个必须分清的问题：
 *  A. 单装配者（一个壳、一个游标）走 32KB 多批，是否本身就丢段？
 *     → 与「整章直读」（一次读完 → toParagraphs）**逐段对拍**，并对照
 *       「资产非空行数」（= 段落数，QA 交叉验证过的 oracle）。
 *  B. oracle 的字节归属：每章有多少段落在第 1 个 32KB 批内 / 批 2 内，
 *     以便把真机上「少 1 段 / 少 7 段」的签名归属到具体批。
 *
 * RNFS 照真机语义 mock：`read(...,'utf8')` = base64 → binary string → `utf8.decode`
 * （`utf8@3` 严格，尾部截断抛 `Invalid byte index`）；`'base64'` 返回真实字节。
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: { android: unknown }) => o.android },
  InteractionManager: { runAfterInteractions: () => null },
}));

jest.mock('react-native-quick-sqlite', () => ({
  open: () => ({ execute: () => ({ rows: { _array: [], length: 0 } }) }),
}));

jest.mock('@/services/TextLibraryService', () => {
  const state = {
    hydrated: null as null | {
      id: string;
      chapters: Array<{
        id: string;
        bookId: string;
        title: string;
        order: number;
        segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
      }>;
    },
    hydratedIds: [] as string[],
  };
  const lib = {
    __libState: state,
    hydrateBook: (book: typeof state.hydrated) => {
      state.hydrated = book;
      if (book && !state.hydratedIds.includes(book.id)) {
        state.hydratedIds.push(book.id);
      }
      return { success: true, data: null };
    },
    getBook: (id: string) =>
      state.hydrated && state.hydrated.id === id
        ? { success: true, data: state.hydrated }
        : { success: false, error: `未找到书籍：${id}` },
    isBookHydrated: (id: string) => state.hydratedIds.includes(id),
    isUserBook: (id: string) => String(id).startsWith('user-'),
    evictBook: () => ({ success: true, data: null }),
  };
  return { TextLibraryService: lib, default: lib };
});

jest.mock('react-native-fs', () => {
  const state = {
    files: new Map<string, Buffer>(),
    assets: new Map<string, string>(),
    reads: [] as Array<{ position: number; length: number; encoding?: string }>,
    failAll: false,
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    exists: jest.fn(async (p: string) => state.files.has(p)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(
      async (p: string, length: number, position: number, encoding?: string) => {
        state.reads.push({ position, length, encoding });
        if (state.failAll) {
          throw new Error('EIO: read failed');
        }
        const buf = state.files.get(p);
        if (!buf) {
          throw new Error(`File does not exist: ${p}`);
        }
        const slice = buf.subarray(position, Math.min(position + length, buf.length));
        if (encoding === 'base64') {
          return slice.toString('base64');
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const utf8 = require('utf8') as { decode: (s: string) => string };
        return utf8.decode(slice.toString('binary'));
      },
    ),
    readFile: jest.fn(async () => ''),
    readFileAssets: jest.fn(async (p: string) => {
      const v = state.assets.get(p);
      if (v === undefined) {
        throw new Error('readFileAssets unavailable');
      }
      return v;
    }),
    writeFile: jest.fn(async () => undefined),
    appendFile: jest.fn(async () => undefined),
    copyFile: jest.fn(async () => undefined),
    copyFileAssets: jest.fn(async () => undefined),
    unlink: jest.fn(async () => undefined),
    stat: jest.fn(async (p: string) => ({
      path: p,
      size: 1024,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    })),
    readDir: jest.fn(async () => []),
    __state: state,
  };
});

jest.mock('react-native-document-picker', () => ({
  pick: jest.fn(),
  types: { allFiles: 0, plainText: 1 },
  isCancel: () => false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RNFSMock = require('react-native-fs') as {
  __state: {
    files: Map<string, Buffer>;
    assets: Map<string, string>;
    reads: Array<{ position: number; length: number; encoding?: string }>;
    failAll: boolean;
  };
};

import { readFileSync } from 'fs';
import { join } from 'path';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import {
  UserBookService,
  assembleChapterStreaming,
  getChapterContentQuality,
  __resetAssemblyStateForTests,
  __resetBuiltinLazyStateForTests,
} from '@/services/UserBookService';
import { getBuiltinSpec } from '@/data/builtinCatalog';

const BOOK = 'tongjian';
const ASSET_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'android',
  'app',
  'src',
  'main',
  'assets',
  'books',
);
const BOOK_BYTES = readFileSync(join(ASSET_DIR, `${BOOK}.txt`));
const META = JSON.parse(
  readFileSync(join(ASSET_DIR, `${BOOK}.meta.json`), 'utf8'),
) as { chapters: Array<{ id: string; t: string; s: number; e: number }> };

/** 低档切片（生产：DeviceTierService low → fillReadChunkBytes = 32 * KB） */
const LOW_TIER_CHUNK = 32 * 1024;

interface RealChapter {
  id: string;
  title: string;
  s: number;
  e: number;
  bytes: Buffer;
  text: string;
  /** oracle：资产段落数（非空行数，与 QA 真机交叉验证一致） */
  paragraphs: string[];
}

function loadRealChapter(id: string): RealChapter {
  const meta = META.chapters.find((c) => c.id === id);
  expect(meta).toBeDefined();
  const bytes = BOOK_BYTES.subarray(meta!.s, meta!.e);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const paragraphs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { id, title: meta!.t, s: meta!.s, e: meta!.e, bytes, text, paragraphs };
}

function hydrateFor(ch: RealChapter): {
  id: string;
  bookId: string;
  title: string;
  order: number;
  segments: Array<{ id: string; chapterId: string; order: number; text: string }>;
} {
  const chapter = {
    id: ch.id,
    bookId: BOOK,
    title: ch.title,
    order: 1,
    segments: [] as Array<{
      id: string;
      chapterId: string;
      order: number;
      text: string;
    }>,
  };
  (TextLibraryService as unknown as { hydrateBook: (b: unknown) => unknown }).hydrateBook({
    id: BOOK,
    title: '资治通鉴',
    author: '司马光',
    category: 'shi',
    description: '',
    chapters: [chapter],
  });
  return chapter;
}

/**
 * 只把「该章的字节」当书文件、把章区间设为 [0, len)：读取路径逐字节等价。
 * `loadBuiltinMeta` 会校验 `c.id === `${bookId}-c${i+1}``（1-based 下标），
 * 故用零长度占位条目把真实章顶到它自己的下标上。
 */
function installChapterFile(ch: RealChapter): void {
  const index = Number(ch.id.slice(ch.id.lastIndexOf('-c') + 2));
  expect(Number.isFinite(index)).toBe(true);
  const chapters = Array.from({ length: index }, (_, i) => ({
    id: `${BOOK}-c${i + 1}`,
    t: i + 1 === index ? ch.title : '占位',
    s: 0,
    e: i + 1 === index ? ch.bytes.length : 0,
  }));
  RNFSMock.__state.files.set(
    `${UserBookService.getBuiltinDirPath()}/${BOOK}.txt`,
    ch.bytes,
  );
  RNFSMock.__state.assets.set(
    `books/${BOOK}.meta.json`,
    JSON.stringify({
      v: 1,
      bookId: BOOK,
      sizeBytes: ch.bytes.length,
      chapters,
    }),
  );
}

describe('【#20 复验追加】真实资产 × 32KB 切片：流式装配完整性 oracle', () => {
  let infoSpy: jest.SpyInstance;
  let upsertSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    RNFSMock.__state.files.clear();
    RNFSMock.__state.assets.clear();
    RNFSMock.__state.reads = [];
    RNFSMock.__state.failAll = false;
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    upsertSpy = jest
      .spyOn(StorageService, 'upsertFtsForChapter')
      .mockImplementation(() => ({ success: true, data: true }));
  });

  afterEach(() => {
    infoSpy.mockRestore();
    upsertSpy.mockRestore();
    __resetAssemblyStateForTests();
  });

  test('oracle 自身可复算：c166=106 段 / c169=156 段（且最长段 < 2500 ⇒ 无二次切分）', () => {
    const c166 = loadRealChapter('tongjian-c166');
    const c169 = loadRealChapter('tongjian-c169');
    expect(c166.paragraphs.length).toBe(106);
    expect(c169.paragraphs.length).toBe(156);
    for (const ch of [c166, c169]) {
      expect(ch.bytes.length).toBeGreaterThan(LOW_TIER_CHUNK); // 确实需要 ≥2 批
      expect((ch.bytes[LOW_TIER_CHUNK] & 0xc0) === 0x80).toBe(true); // 首批切点落字符中间
      // 无 >MAX_SEGMENT_CHARS(2500) 的段落 ⇒ 「段数」= 「segments 数」
      expect(Math.max(...ch.paragraphs.map((p) => p.length))).toBeLessThan(2500);
    }
  });

  for (const id of ['tongjian-c166', 'tongjian-c169', 'tongjian-c167']) {
    test(`${id}：32KB 多批流式装配 == 整章直读（逐段文本一致）且段数 == oracle`, async () => {
      const ch = loadRealChapter(id);
      const spec = getBuiltinSpec(BOOK)!;
      installChapterFile(ch);

      // ① 参照：整章直读（一次读完 → toParagraphs）——冷启动可用路径
      const wholeChapter = hydrateFor(ch);
      expect(await UserBookService.fillBuiltinChapterNow(BOOK, ch.id)).toBe(true);
      const wholeTexts = wholeChapter.segments.map((s) => s.text);
      expect(wholeTexts).toHaveLength(ch.paragraphs.length); // oracle 对拍
      expect(wholeTexts).toEqual(ch.paragraphs);

      // ② 被测：单壳 + 单游标，低档 32KB 多批流式
      __resetAssemblyStateForTests();
      installChapterFile(ch);
      const chapter = hydrateFor(ch);
      const shell = {
        chapter,
        bodyLines: [] as string[],
        range: { s: 0, e: ch.bytes.length },
      };
      let step = 'progress';
      let steps = 0;
      for (; steps < 50 && step !== 'done'; steps += 1) {
        // eslint-disable-next-line no-await-in-loop
        step = await assembleChapterStreaming(shell, {
          spec,
          readChunkBytes: LOW_TIER_CHUNK,
          timeBudgetMs: 1_000_000,
        });
      }
      expect(step).toBe('done');
      expect(steps).toBeGreaterThan(1); // 确实多批
      // ★ 核心断言：单装配者路径不得丢段 / 不得与整章直读有差异
      expect(chapter.segments.map((s) => s.text)).toEqual(wholeTexts);
      expect(getChapterContentQuality(BOOK, ch.id)).toBe('full');
    });
  }

  test('批归属：c166 的第 2 批 0 段、c169 的第 2 批 7 段（真机 105/148 的签名归属）', () => {
    const c166 = loadRealChapter('tongjian-c166');
    const c169 = loadRealChapter('tongjian-c169');

    /** 每段的起始字节偏移（UTF-8 逐行累加，含换行） */
    const paragraphStartBytes = (ch: RealChapter): number[] => {
      const starts: number[] = [];
      let pos = 0;
      for (const rawLine of ch.text.split('\n')) {
        if (rawLine.trim().length > 0) {
          starts.push(pos);
        }
        pos += Buffer.byteLength(rawLine, 'utf8') + 1; // +1 = 被 split 吃掉的 '\n'
      }
      return starts;
    };
    /** 读取原语的批边界（32KB 请求 → 裁到字符边界后的实际消费量累加） */
    const batchMarks = (ch: RealChapter): number[] => {
      const marks: number[] = [];
      let pos = 0;
      while (pos < ch.bytes.length) {
        const want = Math.min(LOW_TIER_CHUNK, ch.bytes.length - pos);
        let consumed = want;
        while (consumed > 0) {
          const b = ch.bytes[pos + consumed];
          if (b === undefined || (b & 0xc0) !== 0x80) {
            break; // 下一字节是字符首字节 ⇒ consumed 已是字符边界
          }
          consumed -= 1;
        }
        pos += consumed === 0 ? want : consumed;
        marks.push(pos);
      }
      return marks;
    };

    const c166Marks = batchMarks(c166);
    const c169Marks = batchMarks(c169);
    expect(c166Marks).toHaveLength(2);
    expect(c169Marks).toHaveLength(2);
    // c166（32940B）：末段跨批，第 2 批无段落起点 ⇒ 少 1 段 = 末段未落盘
    expect(
      paragraphStartBytes(c166).filter((b) => b >= c166Marks[0]).length,
    ).toBe(0);
    // c169（34663B）：第 2 批 7 段 ⇒ 真机 paras=148 缺的正是「批 1 末段 + 批 2 的 7 段」
    expect(
      paragraphStartBytes(c169).filter((b) => b >= c169Marks[0]).length,
    ).toBe(7);
  });
});
