/**
 * 【章节加载重构 T07 · P0-3 残留最后一条】「书级分片 FTS 索引写入必须让路给装配」
 * 的**行为守卫**
 *
 * ── 缺口（用户可感）────────────────────────────────────────────────────
 * `fillRemainingBuiltinChapters` 收尾处的整书 FTS 分片写入此前只读
 * `ftsQueuePausedUntil` 固定缓冲门闩，**漏读**调度器活动判据
 * （`ChapterAssemblyScheduler.isUserActive()`）⇒ 用户跳章（P1 目标章装配在飞）时，
 * 索引写入仍与装配抢 JS ⇒ 掉帧（PRD「帧率优先」违例）。
 *
 * ── 本文件以**行为**断言为主 ────────────────────────────────────────────
 * spy `StorageService.upsertFtsForBookChunked`，**截获生产真正交出去的那一个
 * `shouldPause` 闭包**，并直接驱动它。断言的是「被交出去的那个谓词」的行为：
 *   装配闲 ⇒ 不让路；装配忙 ⇒ 让路；配额满 ⇒ **必须放行**（严禁饿死）；
 *   装配转闲 ⇒ 忙期复位；跨写入会话 ⇒ 配额重新记账。
 * 源码里写了 `|| ftsBookChunkPaused()` 只证明「文本存在」——既不证明它被求值，
 * 也不证明配额到期真的放行（「源码文本即断言」血训的反面用法）。
 *
 * ── ⚠ D 组是**唯一**的源码契约断言（行为层无法覆盖它，理由见该用例）────────
 * A/B/C 组零源码文本断言。D 组断言「配额常量**真的**是第 4 实参」——
 * 因为 UBS 侧常量与 `utils` 默认值**同源同值**，任何**行为**断言都无法区分
 * 「传了第 4 参」与「漏传、退回默认值」（两者行为逐字相同）。
 * 这一层只能靠源码契约守；而它守的正是 T07 首版的真实缺陷（**死常量**）。
 * D 组自身也做了变异自证（见 DESIGN §7.12.10）：删掉第 4 实参 ⇒ D 组必红，
 * 而 A/B/C 组**全绿** —— 这恰好量化了「行为层测不到这一步」。
 *
 * ── 取证边界（必读，勿误读）────────────────────────────────────────────
 *  ① **不执行** `StorageService` 的 250ms 轮询循环（本文件已 spy 掉
 *     `upsertFtsForBookChunked`）⇒「轮询真的停住 / 真的续写 / 断点续写无缺章」
 *     **不在**本文件证明范围内，端到端只能**真机 logcat** 取证。
 *     本文件结论的合法性来自：**被驱动的正是生产交出的那一个闭包**（非测试自造）。
 *  ② 本文件证明「谓词契约 + 接线」，**不证明**冷启动首帧不劣化（真机 gfxinfo）。
 *  ③ ⚠ **设备读数的正确解释**：`[PERF][asm] paused reason=ftsCheckpoint gate=on`
 *     的 `gate` 反映的是 **`isUserActive()`**（装配是否活跃），**不是**最终是否
 *     让路 —— 配额耗尽时装配仍然活跃（`gate=on`）而写入已放行。故真机上
 *     「看到 gate=on」**不得**推断「FTS 被暂停」；配额语义只能由本文件（jest）
 *     的谓词契约断言证明。
 *  ④ 本文件**不改**任何既有测试文件；harness（RNFS / TextLibraryService mock）
 *     形态复制自同轮次自建的旁路接线测试，未复用其文件。
 *  ⑤ **不用假定时器**：假定时器与 harness 的 `waitUntil`（真实 `setTimeout` 轮询）
 *     互斥。改用 `jest.spyOn(Date, 'now')` 的**双模时钟**：
 *      - **流动模**（`真实时钟 + epochShift`）：异步场景用 —— 冻结的话
 *        `ctx.bookOrderAt` 之类的空闲门永不开，填充轮次跑不完 ⇒ 假红；
 *      - **冻结模**（`frozenNow`）：仅配额边界断言用 —— 边界值需要精确 `now`，
 *        真实时钟的毫秒漂移会让 `==2000` 断言闪断。
 */

jest.mock('@/services/TextLibraryService', () => {
  const mockLibState = {
    builtinCalls: [] as number[],
    userBooks: [] as unknown[],
    builtinLast: [] as Array<{
      id: string;
      chapters: Array<{ id: string; segments: unknown[] }>;
    }>,
    hydratedLast: null as {
      id: string;
      chapters: Array<{ id: string; segments: unknown[] }>;
    } | null,
    hydratedIds: [] as string[],
  };
  const mockLib = {
    __libState: mockLibState,
    registerBuiltinBooks: (books: unknown[]) => {
      mockLibState.builtinLast = books as typeof mockLibState.builtinLast;
      mockLibState.builtinCalls.push(books.length);
      return { success: true, data: null };
    },
    hydrateBook: (book: {
      id: string;
      chapters: Array<{ id: string; segments: unknown[] }>;
    }) => {
      mockLibState.hydratedLast = book;
      mockLibState.hydratedIds.push(book.id);
      return { success: true, data: null };
    },
    isBookHydrated: (id: string) => mockLibState.hydratedIds.includes(id),
    evictBook: () => ({ success: true, data: null }),
    setSuppressedBuiltins: () => ({ success: true, data: null }),
    onBookEvicted: () => () => undefined,
    registerUserBooks: (books: unknown[]) => {
      mockLibState.userBooks = books;
      return { success: true, data: null };
    },
    getBooks: () => ({ success: true, data: [...mockLibState.userBooks] }),
    getBook: (id: string) => {
      const hydrated = mockLibState.hydratedIds.includes(id)
        ? mockLibState.hydratedLast
        : mockLibState.builtinLast.find((b) => b.id === id);
      if (hydrated && hydrated.id === id) {
        return { success: true, data: hydrated };
      }
      const user = (mockLibState.userBooks as Array<{ id: string }>).find(
        (b) => b.id === id,
      );
      return user
        ? { success: true, data: user }
        : { success: false, error: `未找到书籍：${id}` };
    },
    isUserBook: (id: string) => String(id).startsWith('user-'),
  };
  return { TextLibraryService: mockLib, default: mockLib };
});

jest.mock('react-native-fs', () => {
  const state = {
    files: new Set<string>(),
    readDirResults: {} as Record<string, unknown[] | Error>,
    readReply: '',
    readReplies: {} as Record<string, string>,
    readFileResult: '',
    sizes: {} as Record<string, number>,
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    exists: jest.fn(async (path: string) => state.files.has(path)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(async (path: string) => state.readReplies[path] ?? state.readReply),
    readFile: jest.fn(async () => state.readFileResult),
    readFileAssets: jest.fn(async () => {
      throw new Error('readFileAssets unavailable');
    }),
    writeFile: jest.fn(async (path: string) => {
      state.files.add(path);
    }),
    appendFile: jest.fn(async () => undefined),
    copyFile: jest.fn(async (_src: string, dst: string) => {
      state.files.add(dst);
    }),
    copyFileAssets: jest.fn(async (_src: string, dst: string) => {
      state.files.add(dst);
    }),
    unlink: jest.fn(async (path: string) => {
      state.files.delete(path);
    }),
    stat: jest.fn(async (path: string) => ({
      path,
      size: state.sizes[path] ?? 128,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    })),
    readDir: jest.fn(async (path: string) => {
      const explicit = state.readDirResults[path];
      if (explicit instanceof Error) {
        throw explicit;
      }
      if (explicit) {
        return explicit;
      }
      return Array.from(state.files)
        .filter((f) => f.startsWith(`${path}/`))
        .map((f) => ({
          name: f.slice(f.lastIndexOf('/') + 1),
          path: f,
          isFile: () => true,
        }));
    }),
    __rnfsState: state,
  };
});

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  UserBookService,
  __resetBuiltinLazyStateForTests,
  __resetAssemblyStateForTests,
  reportReadingAnchor,
} from '@/services/UserBookService';
import { StorageService } from '@/services/StorageService';
import { chapterAssemblyScheduler } from '@/services/ChapterAssemblyScheduler';
import { TextLibraryService } from '@/services/TextLibraryService';
import { getBuiltinSpec } from '@/data/builtinCatalog';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __rnfsState } = require('react-native-fs');

const BOOK = 'lunyu';
const CHS = [`${BOOK}-c1`, `${BOOK}-c2`, `${BOOK}-c3`];
/** 每章 2 行；单章区间远小于单批读取上限 → 一次装配即到章尾 */
const LINE = '甲'.repeat(120);
const BLOCK = `${LINE}\n${LINE}\n`;
const BODY3 = BLOCK + BLOCK + BLOCK;
const RANGES = [0, 1, 2].map((i) => ({
  s: i * BLOCK.length,
  e: (i + 1) * BLOCK.length,
}));

interface MockLibState {
  builtinLast: Array<{
    id: string;
    chapters: Array<{ id: string; segments: unknown[] }>;
  }>;
  hydratedLast: {
    id: string;
    chapters: Array<{ id: string; segments: unknown[] }>;
  } | null;
  hydratedIds: string[];
}
function libState(): MockLibState {
  return (TextLibraryService as unknown as { __libState: MockLibState }).__libState;
}

// ============ 双模时钟 ============
/** 真实时钟（**必须在装 spy 之前**绑定：装之后 `Date.now` 已是 mock） */
const realNow = Date.now.bind(Date);
/** 与真实时钟的固定平移量；**每用例再 +6 小时** ⇒ 本文件内时钟严格单调 */
let epochShift = new Date('2026-09-20T00:00:00.000Z').getTime() - realNow();
/**
 * 冻结值（`null` = 流动模）。
 * ⚠ 每用例的 `epochShift` 都向前跨 6 小时：`ftsCheckpointProbeLoggedAt` 是**模块级**
 * 限流状态，若新用例的时钟早于上一用例的打印时刻，`now − loggedAt` 为负 ⇒ 该打的
 * 边沿被限流吞掉 ⇒ 探针断言**假红**。单调递增能结构性排除该用例间耦合。
 */
let frozenNow: number | null = null;
let dateNowSpy: jest.SpyInstance | null = null;
const clockNow = (): number => (frozenNow !== null ? frozenNow : realNow() + epochShift);

// ============ 受控替身（装配忙闲 / 日志） ============
/** 装配侧「用户活跃」替身值；生产真源 = CAS 的 P1~P3 活动判定 */
let busy = false;
let isUserActiveSpy: jest.SpyInstance | null = null;

let infoLines: string[] = [];
let infoSpy: jest.SpyInstance | null = null;

/** `[PERF][asm] paused reason=ftsCheckpoint gate=on`：`isUserActive()` 为真 */
const pausedOnLines = (): string[] =>
  infoLines.filter((l) => l === '[PERF][asm] paused reason=ftsCheckpoint gate=on');
/** 同上 gate=off */
const pausedOffLines = (): string[] =>
  infoLines.filter((l) => l === '[PERF][asm] paused reason=ftsCheckpoint gate=off');

// ============ 截获生产交出的 shouldPause 闭包 ============
interface ChunkedOpts {
  shouldPause?: () => boolean;
  chunkChapters?: number;
}
interface CapturedWrite {
  bookId: string;
  opts?: ChunkedOpts;
}
let captured: CapturedWrite[] = [];
let upsertSpy: jest.SpyInstance | null = null;

// ============ helpers ============
/** 轮询直到条件成立（超时抛错，避免「永远绿」的空断言） */
async function waitUntil(
  label: string,
  cond: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const step = 20;
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    if (cond()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((r) => setTimeout(r, step));
  }
  throw new Error(`waitUntil 超时（${timeoutMs}ms）：${label}`);
}

/** 冲刷异步链（真实定时器；**不**冻结时钟时使用） */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((r) => setTimeout(r, 30));
  }
}

/**
 * 跑一段真实链路，截获 `fillRemainingBuiltinChapters` 交给
 * `StorageService.upsertFtsForBookChunked` 的 `shouldPause`。
 *
 * ⚠ 必须以「新调用」为准（先清账）——否则会拿到上一轮的闭包，M3（跨会话
 * 记账）变异就失去区分力。
 */
async function captureShouldPause(
  tag: string,
  drive: () => Promise<unknown> | unknown,
): Promise<() => boolean> {
  captured = [];
  await drive();
  await waitUntil(`${tag}：书级分片写入被调用`, () => captured.length > 0, 20000);
  const opts = captured[captured.length - 1].opts;
  if (typeof opts?.shouldPause !== 'function') {
    throw new Error(
      `${tag}：upsertFtsForBookChunked 未收到 shouldPause ⇒ T07 谓词未接线`,
    );
  }
  return opts.shouldPause;
}

/** 越过本轮收尾把 `ftsQueuePausedUntil` 推到的时刻（由「闲 ⇒ 不让路」自证） */
const LATCH_JUMP_MS = 300_000;

describe('【T07 · P0-3 残留】书级分片 FTS 写入让路给装配（谓词契约行为守卫）', () => {
  let readMock: jest.Mock;
  let readFileAssetsMock: jest.Mock;

  beforeEach(() => {
    epochShift += 6 * 3600_000;
    frozenNow = null;
    infoLines = [];
    captured = [];
    busy = false;
    __rnfsState.files = new Set();
    __rnfsState.readDirResults = {};
    __rnfsState.readReply = '';
    __rnfsState.readReplies = {};
    __rnfsState.readFileResult = '';
    __rnfsState.sizes = {};
    __resetBuiltinLazyStateForTests();
    __resetAssemblyStateForTests();
    libState().builtinCalls = [];
    libState().builtinLast = [];
    libState().hydratedLast = null;
    libState().hydratedIds = [];

    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(clockNow);
    infoSpy = jest.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      infoLines.push(args.map((a) => String(a)).join(' '));
    });
    isUserActiveSpy = jest
      .spyOn(chapterAssemblyScheduler, 'isUserActive')
      .mockImplementation(() => busy);

    // ⚠ 必须 `require` 取**真实模块的导出对象**再 spy：`import * as` 可能拷贝属性
    //   ⇒ spy 只替换副本、生产读到的仍是原函数 ⇒ 断言静默恒真（本仓已踩过）。
    //   `UserBookService` 是 `import { StorageService }` + **调用时**成员访问 ⇒ 必然生效。
    //   另：本 spy 同时也是「不执行 250ms 轮询循环」的原因（见文件头边界①）。
    upsertSpy = jest.spyOn(StorageService, 'upsertFtsForBookChunked') as unknown as jest.SpyInstance;
    upsertSpy.mockImplementation(
      async (book: { id?: string }, opts?: ChunkedOpts) => {
        captured.push({ bookId: String(book?.id ?? ''), opts });
        return { success: true, data: true };
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnfs = require('react-native-fs') as {
      read: jest.Mock;
      readFileAssets: jest.Mock;
    };
    readMock = rnfs.read;
    readFileAssetsMock = rnfs.readFileAssets;
  });

  afterEach(async () => {
    frozenNow = null;
    isUserActiveSpy?.mockRestore();
    isUserActiveSpy = null;
    upsertSpy?.mockRestore();
    upsertSpy = null;
    infoSpy?.mockRestore();
    infoSpy = null;
    dateNowSpy?.mockRestore();
    dateNowSpy = null;
    __resetAssemblyStateForTests();
    __resetBuiltinLazyStateForTests();
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });

  /** 安装「meta 快路径可用」的内置书：指纹对齐 + meta JSON + 切片读可用 */
  function installMetaFastBook(): void {
    const spec = getBuiltinSpec(BOOK)!;
    const canonicalPath = `${UserBookService.getBuiltinDirPath()}/${BOOK}.txt`;
    __rnfsState.sizes[canonicalPath] = spec.sizeBytes;
    readFileAssetsMock.mockImplementation(async (p: string) => {
      if (p === `books/${BOOK}.meta.json`) {
        return JSON.stringify({
          v: 1,
          bookId: BOOK,
          sizeBytes: spec.sizeBytes,
          chapters: [
            { id: CHS[0], t: '一', s: RANGES[0].s, e: RANGES[0].e },
            { id: CHS[1], t: '二', s: RANGES[1].s, e: RANGES[1].e },
            { id: CHS[2], t: '三', s: RANGES[2].s, e: RANGES[2].e },
          ],
        });
      }
      throw new Error('readFileAssets unavailable');
    });
    readMock.mockImplementation(
      async (_p: string, len: number, pos: number) => BODY3.slice(pos, pos + len),
    );
    __rnfsState.readDirResults[UserBookService.getBooksRootPath()] = [];
  }

  test('① 装配忙 ⇒ 让路；忙期配额满 ⇒ 必须放行（严禁饿死）；转闲 ⇒ 复位', async () => {
    installMetaFastBook();
    const shouldPause = await captureShouldPause('①', () =>
      UserBookService.ensureBookReady(BOOK, { priorityChapterId: CHS[1] }),
    );

    // 越过本轮收尾把 `ftsQueuePausedUntil` 推到的时刻
    const T = clockNow() + LATCH_JUMP_MS;

    // ── ①-a 装配闲 ⇒ 不让路。此断言**同时自证**左项门闩已过期 ──
    //   若门闩未过期，它也会返回 true ⇒ 下面的「忙 ⇒ 让路」就不是右项造成的
    //   （= 断言失去鉴别力）。所以这一条必须**先**跑。
    busy = false;
    frozenNow = T;
    expect(shouldPause()).toBe(false);

    // ── ①-b 装配忙 ⇒ 让路（忙期起点 = T）──
    busy = true;
    frozenNow = T;
    expect(shouldPause()).toBe(true);

    // ── ①-c 忙期内持续让路，直到配额边缘（FTS_BOOK_CHUNK_STARVE_MAX_MS = 2000）──
    frozenNow = T + 1999;
    expect(shouldPause()).toBe(true);

    // ── ①-d **配额到期 ⇒ 必须放行**：这是「暂停后必须有出口」的第一条，
    //        也是「严禁饿死」的机器可验形态 ──
    frozenNow = T + 2000;
    expect(shouldPause()).toBe(false);

    // ── ①-e 同一连续忙期内不再反复让路（配额 = 连续忙期只发一次）──
    frozenNow = T + 60_000;
    expect(shouldPause()).toBe(false);

    // ── ①-f 装配转闲 ⇒ 忙期复位 ──
    busy = false;
    frozenNow = T + 60_001;
    expect(shouldPause()).toBe(false);

    // ── ①-g 再次转忙 ⇒ 重新让路（证明 ①-f 真的复位了记账，而非巧合）──
    busy = true;
    frozenNow = T + 60_002;
    expect(shouldPause()).toBe(true);

    // ── 探针可达性：两个边沿都必须真的出货（否则真机取证面无从谈起）──
    expect(pausedOnLines().length).toBeGreaterThan(0);
    expect(pausedOffLines().length).toBeGreaterThan(0);
  }, 45000);

  test('② 跨写入会话 ⇒ 配额重新记账（防「开关开着却静默失效」）', async () => {
    installMetaFastBook();

    // ── 第一轮写入会话 ──
    const first = await captureShouldPause('②-第一轮', () =>
      UserBookService.ensureBookReady(BOOK, { priorityChapterId: CHS[1] }),
    );
    const T1 = clockNow() + LATCH_JUMP_MS;
    busy = true;
    frozenNow = T1;
    expect(first()).toBe(true); // 记账：忙期起点 = T1
    frozenNow = T1 + 5000;
    expect(first()).toBe(false); // 配额耗尽（起点残留 = T1）

    // ⚠ 此处**不得**驱动 `busy = false`：那会走 `planAssemblyYield` 的空闲分支把
    //   起点自动清零，从而掩盖「跨会话是否需要显式清零」这一被测点。
    //   也不得再调 `first()`：那会把起点刷新。以下只推进时钟，模拟「两次写入之间
    //   无写入在飞 ⇒ 无 `shouldPause` 求值」的真实空窗。
    frozenNow = null;
    epochShift += 600_000; // 十分钟空窗

    // ── 第二轮写入会话：新的一轮 `fillRemainingBuiltinChapters` ──
    await settle();
    const second = await captureShouldPause('②-第二轮', () =>
      reportReadingAnchor(BOOK, CHS[1], 2),
    );
    expect(second).not.toBe(first); // 必须是**新**闭包，否则等于没换会话

    const T2 = clockNow() + LATCH_JUMP_MS;
    busy = true;
    frozenNow = T2;
    // 第二轮**首个**忙期判定必须让路。若写入会话入口没有清零起点，这里
    // `T2 − T1` 达十分钟 > 2000 ⇒ 返回 false ⇒ 「开关开着却静默失效」。
    expect(second()).toBe(true);
  }, 45000);

  test('③ 谓词只以 CAS 的 isUserActive 为忙闲真源（无第二套活跃判定）', async () => {
    installMetaFastBook();
    const shouldPause = await captureShouldPause('③', () =>
      UserBookService.ensureBookReady(BOOK, { priorityChapterId: CHS[1] }),
    );
    const before = isUserActiveSpy!.mock.calls.length;

    frozenNow = clockNow() + LATCH_JUMP_MS;
    busy = false;
    expect(shouldPause()).toBe(false);
    const afterIdle = isUserActiveSpy!.mock.calls.length;
    // 闲态下也必须**问过**装配侧（而不是靠别的判据短路掉）
    expect(afterIdle).toBeGreaterThan(before);

    busy = true;
    expect(shouldPause()).toBe(true);
    expect(isUserActiveSpy!.mock.calls.length).toBeGreaterThan(afterIdle);
  }, 45000);
});

/**
 * ── D 组：**接线契约**（本文件唯一的源码断言）────────────────────────────
 *
 * **为什么行为层覆盖不到这一步**：UBS 侧 `FTS_BOOK_CHUNK_STARVE_MAX_MS` 与
 * `utils/assemblyYield.ts` 里 `planAssemblyYield` 的默认值**同源同值**
 * （`= ASSEMBLY_YIELD_STARVE_MAX_MS`，且 team-lead 明令「禁硬编码数值，避免第二份
 * 数值真相」）⇒「显式传第 4 实参」与「漏传、退回默认值」两种实现在**行为上逐字
 * 相同**，任何驱动谓词的断言都**不可能**区分。**这不是断言写得不够，是行为层
 * 的信息边界。**
 *
 * 而 T07 首版的真实缺陷恰恰是「漏传第 4 实参」⇒ 常量成**死常量**：
 * 「设为 `0`」不改变任何行为（所谓「一行回退」是空头承诺）、改它的值无任何测试
 * 可观测，而 `FTS_CHECKPOINT_PROBE_ENABLED` 又只控日志 ⇒ **两个开关都不控行为**
 * （缺陷由 team-lead 的 MC/MC3 变异「绿」查出；成因是死代码，不是脚本打偏）。
 * ⇒ 这一层**只能**用源码契约守。
 *
 * ⚠ 断言一律打在**剥掉注释**后的代码上：本谓词与常量的文档块里都提到了
 * `planAssemblyYield` / `FTS_BOOK_CHUNK_STARVE_MAX_MS`，若不过滤注释，
 * 断言会被**注释**满足 ⇒ 恒真的假绿（「源码文本即断言」血训的变体）。
 */
describe('【T07 · D 组】配额常量接线契约（行为层不可覆盖，故用源码契约）', () => {
  const rawSource = readFileSync(
    join(__dirname, '..', 'services', 'UserBookService.ts'),
    'utf-8',
  );
  /** 剥注释：先块注释后行注释（顺序不能反，否则 `//` 会先吃掉块注释的开头） */
  const code = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  /** 按花括号配平截取某函数体（锚点失效时返回空串，由调用方断言非空 ⇒ 不恒真） */
  function bodyOf(signature: string): string {
    const start = code.indexOf(signature);
    if (start < 0) {
      return '';
    }
    const braceStart = code.indexOf('{', start);
    if (braceStart < 0) {
      return '';
    }
    let depth = 0;
    for (let i = braceStart; i < code.length; i += 1) {
      if (code[i] === '{') {
        depth += 1;
      } else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          return code.slice(braceStart, i + 1);
        }
      }
    }
    return '';
  }

  test('D1 第 4 实参必须显式传入本侧常量（漏传 ⇒ 死常量 ⇒ 一行回退失效）', () => {
    const body = bodyOf('function ftsBookChunkPaused(');
    expect(body).not.toBe('');

    // 正向：四实参，第 4 个是本侧配额常量
    expect(body).toMatch(
      /planAssemblyYield\(\s*ftsCheckpointPaused\(\),\s*ftsBookChunkBusySince,\s*Date\.now\(\),\s*FTS_BOOK_CHUNK_STARVE_MAX_MS,?\s*\)/,
    );
    // 反向：不得存在「三实参」形态（= T07 首版缺陷的字面形态）。
    // 本条是 D 组的**变异靶点**：删掉第 4 实参 ⇒ 必红。
    expect(body).not.toMatch(/planAssemblyYield\([\s\S]*?Date\.now\(\),\s*\)/);
  });

  test('D2 配额常量必须与 utils **同源**，不得再写一份数值', () => {
    const m = code.match(/const FTS_BOOK_CHUNK_STARVE_MAX_MS\s*=\s*([^;]+);/);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('ASSEMBLY_YIELD_STARVE_MAX_MS');
    // 同源的前提：该名字是**导入**来的，而不是本文件里又定义一份（第二份数值真相）
    expect(code).toMatch(
      /import\s*\{[\s\S]*?ASSEMBLY_YIELD_STARVE_MAX_MS[\s\S]*?\}\s*from\s*'@\/utils\/assemblyYield'/,
    );
    expect(code).not.toMatch(/const ASSEMBLY_YIELD_STARVE_MAX_MS\s*=/);
  });
});
