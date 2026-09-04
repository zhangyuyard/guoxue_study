/**
 * DictImportService 导入管线单测（QA 补充覆盖，对应 T03 验收标准 3）
 * 策略：可编程 quick-sqlite mock（内存表 + executeBatch 记录）跑真实链路
 *   文件字节 → TextDictParser 流式解析 → DictDatabase.insertEntries → store 刷新
 * 断言：分批写入、entry_count 回填、错误行进 report、
 *   取消路径清理半成品 dict_id 行、失败路径清理、不支持格式不建行。
 */
import { DictImportService } from '@/services/dict/DictImportService';
import { utf8Encode } from '@/services/dict/parsers/types';
import { useDictStore } from '@/store/useDictStore';

type Row = Record<string, unknown>;

interface MockTable {
  dicts: Row[];
  entries: Row[];
}

/** 测试注入的文件字节（mock DictFileService 读取；按 uri 注册，支持成组多文件） */
const mockFileRegistry = new Map<string, Uint8Array>();

jest.mock('@/services/dict/DictFileService', () => ({
  DictFileService: {
    createChunkReader: async (uri: string) => {
      const bytes = mockFileRegistry.get(uri) ?? new Uint8Array(0);
      return {
        fileSize: bytes.length,
        readChunk: async (pos: number, len: number) => bytes.slice(pos, pos + len),
      };
    },
  },
}));

jest.mock('react-native-quick-sqlite', () => {
  const state = {
    native: { dicts: [], entries: [] } as MockTable,
    user: { dicts: [], entries: [] } as MockTable,
    /** 每次 executeBatch 的 INSERT INTO entries 命令数 */
    entryBatchSizes: [] as number[],
    /** dicts 行插入调用记录 */
    dictRowInserts: [] as string[],
    /** DELETE 调用记录（entries / dicts） */
    deletes: { entries: [] as string[], dicts: [] as string[] },
    /** UPDATE dicts SET entry_count 调用记录 */
    entryCountUpdates: [] as { dictId: string; count: number }[],
  };

  const rows = (arr: Row[]) => ({ rows: { _array: arr, length: arr.length } });

  const execute = (
    tab: MockTable,
    sql: string,
    params: (string | number | null)[],
  ): { rows: { _array: Row[]; length: number } } => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM dicts')) {
      return rows([...tab.dicts]);
    }
    if (s.startsWith('INSERT OR REPLACE INTO dicts')) {
      state.dictRowInserts.push(String(params[0]));
      const id = String(params[0]);
      tab.dicts = tab.dicts.filter((d) => String(d.id) !== id);
      tab.dicts.push({ id, name: params[1], kind: params[2], entry_count: params[4] });
      return rows([]);
    }
    if (s.startsWith('UPDATE dicts')) {
      state.entryCountUpdates.push({ dictId: String(params[2]), count: Number(params[0]) });
      const row = tab.dicts.find((d) => String(d.id) === String(params[2]));
      if (row) {
        row.entry_count = Number(params[0]);
      }
      return rows([]);
    }
    if (s.startsWith('DELETE FROM entries')) {
      state.deletes.entries.push(String(params[0]));
      tab.entries = tab.entries.filter((e) => String(e.dict_id) !== String(params[0]));
      return rows([]);
    }
    if (s.startsWith('DELETE FROM dicts')) {
      state.deletes.dicts.push(String(params[0]));
      tab.dicts = tab.dicts.filter((d) => String(d.id) !== String(params[0]));
      return rows([]);
    }
    if (s.startsWith('SELECT COALESCE(SUM(size_bytes)')) {
      return rows([{ total: 0 }]);
    }
    if (/^(CREATE|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK)/.test(s)) {
      return rows([]);
    }
    throw new Error(`quick-sqlite mock：未实现的 SQL：${s}`);
  };

  return {
    open: jest.fn(({ name }: { name: string }) => ({
      execute: (sql: string, params: (string | number | null)[] = []) =>
        execute(name === 'native_dict.db' ? state.native : state.user, sql, params),
      executeBatch: (commands: [string, (string | number | null)[]][]) => {
        const inserts = commands.filter(([sql]) => sql.replace(/\s+/g, ' ').startsWith('INSERT INTO entries'));
        state.entryBatchSizes.push(inserts.length);
        for (const [, p] of inserts) {
          state.user.entries.push({
            id: state.user.entries.length + 1,
            dict_id: p[0],
            headword: p[1],
            headword_norm: p[2],
            pinyin: p[3],
            readings_json: p[4],
            content: p[5],
            content_type: p[6],
            extra_json: p[7],
          });
        }
        return { rows: { _array: [], length: 0 } };
      },
    })),
    __importState: state,
  };
});

const sqliteMock = jest.requireMock('react-native-quick-sqlite') as {
  __importState: {
    native: MockTable;
    user: MockTable;
    entryBatchSizes: number[];
    dictRowInserts: string[];
    deletes: { entries: string[]; dicts: string[] };
    entryCountUpdates: { dictId: string; count: number }[];
  };
};
const st = sqliteMock.__importState;

/** 构造导入文件对象 */
function fileOf(name: string, text: string): { uri: string; fileName: string; size: number } {
  const bytes = utf8Encode(text);
  mockFileRegistry.set(`memory://${name}`, bytes);
  return { uri: `memory://${name}`, fileName: name, size: bytes.length };
}

/** .ifo 文本 → 字节（与 StarDictParser.test 同构） */
function buildIfoBytes(meta: Record<string, string>): Uint8Array {
  const lines = ["StarDict's dict ifo file", ...Object.entries(meta).map(([k, v]) => `${k}=${v}`)];
  return utf8Encode(lines.join('\n') + '\n');
}

interface IdxEntrySpec {
  word: string;
  offset: number;
  size: number;
}

/** 构造 .idx 字节（大端 offset 4 字节 + size 4 字节） */
function buildIdxBytes(entries: IdxEntrySpec[]): Uint8Array {
  const parts: number[] = [];
  const pushBE = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i -= 1) {
      parts.push(Math.floor(value / 256 ** i) & 0xff);
    }
  };
  for (const e of entries) {
    for (const b of utf8Encode(e.word)) {
      parts.push(b);
    }
    parts.push(0);
    pushBE(e.offset, 4);
    pushBE(e.size, 4);
  }
  return new Uint8Array(parts);
}

beforeEach(() => {
  st.native.dicts = [];
  st.native.entries = [];
  st.user.dicts = [];
  st.user.entries = [];
  st.entryBatchSizes = [];
  st.dictRowInserts = [];
  st.deletes.entries = [];
  st.deletes.dicts = [];
  st.entryCountUpdates = [];
  useDictStore.setState({
    dictSettings: {},
    defaultDictId: null,
    polyphoneSource: { type: 'builtin' },
    importStatus: 'idle',
    importProgress: { fileName: '', entryCount: 0 },
  });
});

describe('importFromFile 成功路径', () => {
  test('CSV 导入：分批入库 + headword_norm 归一化 + entry_count 回填 + store 同步', async () => {
    // 1500 行 → 解析器 yield 2 批（1000 + 500），insertEntries 每批一次 executeBatch
    const lines = ['字头,释义', ...Array.from({ length: 1500 }, (_, i) => `字${i},释义${i}`)];
    const res = await DictImportService.importFromFile(fileOf('my.csv', lines.join('\n')));

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ totalEntries: 1500, cancelled: false });
    // 分批写入：2 次 executeBatch，每次 1000 / 500 条
    expect(st.entryBatchSizes).toEqual([1000, 500]);
    // entry_count 回填为真实计数
    expect(st.entryCountUpdates).toHaveLength(1);
    expect(st.entryCountUpdates[0].count).toBe(1500);
    expect(st.user.dicts[0]).toMatchObject({ kind: 'user', entry_count: 1500 });
    // store 同步：新字典默认启用
    const dictId = res.data!.dictId;
    expect(useDictStore.getState().dictSettings[dictId]).toEqual({ enabled: true, order: 0 });
    expect(useDictStore.getState().importStatus).toBe('done');
    expect(useDictStore.getState().importProgress.entryCount).toBe(1500);
  });

  test('繁体字头归一化入库（學 → headword_norm=学）', async () => {
    const res = await DictImportService.importFromFile(fileOf('t.csv', '字头,释义\n學,学习\n'));
    expect(res.success).toBe(true);
    expect(st.user.entries.map((e) => [e.headword, e.headword_norm])).toEqual([['學', '学']]);
  });

  test('错误行进入 report.errors 且不影响成功条数', async () => {
    const res = await DictImportService.importFromFile(
      fileOf('e.csv', '字头,释义\n好,善\n,缺字头\n坏,\n仁,爱人\n'),
    );
    expect(res.success).toBe(true);
    expect(res.data!.totalEntries).toBe(2);
    expect(res.data!.failedCount).toBe(2);
    expect(res.data!.errors.map((e) => e.reason)).toEqual(['字头为空', '释义为空']);
  });
});

describe('importFromFile 取消路径（清理半成品）', () => {
  test('首批写入后取消：entries + dicts 行全部清理，report.cancelled=true', async () => {
    const lines = ['字头,释义', ...Array.from({ length: 1500 }, (_, i) => `字${i},释义${i}`)];
    // 第 1 批（1000 条）写入后触发取消
    let cancelled = false;
    const isCancelled = () => cancelled;
    const unspy = () => {
      cancelled = st.entryBatchSizes.length >= 1;
    };
    // 轮询钩子：借助 onProgress（首批入库后回调）翻转取消标记
    const res = await DictImportService.importFromFile(fileOf('c.csv', lines.join('\n')), {
      isCancelled,
      onProgress: () => unspy(),
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('导入已取消');
    expect(res.data).toMatchObject({ cancelled: true, totalEntries: 0 });
    // 半成品清理：entries + dicts 行均已删除
    expect(st.user.entries).toHaveLength(0);
    expect(st.user.dicts).toHaveLength(0);
    expect(st.deletes.entries).toHaveLength(1);
    expect(st.deletes.dicts).toHaveLength(1);
    // 取消后未回填 entry_count
    expect(st.entryCountUpdates).toHaveLength(0);
    // store 状态为 cancelled
    expect(useDictStore.getState().importStatus).toBe('cancelled');
  });
});

describe('importFromFile 失败路径', () => {
  test('JSON 语法错误：清理已建的 dicts 行，返回「导入失败」前缀', async () => {
    const res = await DictImportService.importFromFile(fileOf('bad.json', '{bad json'));
    expect(res.success).toBe(false);
    expect(res.error).toContain('导入失败');
    expect(res.error).toContain('JSON 解析失败');
    // dicts 行已建又清理
    expect(st.dictRowInserts).toHaveLength(1);
    expect(st.user.dicts).toHaveLength(0);
    expect(st.deletes.dicts).toHaveLength(1);
    expect(useDictStore.getState().importStatus).toBe('error');
  });

  test('不支持的格式：直接报错且不建 dicts 行', async () => {
    const res = await DictImportService.importFromFile(fileOf('foo.zip', 'whatever'));
    expect(res.success).toBe(false);
    expect(res.error).toContain('暂不支持的字典格式');
    expect(st.dictRowInserts).toHaveLength(0);
    expect(st.user.dicts).toHaveLength(0);
  });
});

describe('importStarDict 成组导入（多余文件 warnings）', () => {
  /** 构造一部单词条 StarDict 三件套（plain idx/dict），返回三个文件对象 */
  function starDictTrio(): Array<{ uri: string; fileName: string; size: number }> {
    const article = utf8Encode('a translation');
    const idx = buildIdxBytes([{ word: 'alpha', offset: 0, size: article.length }]);
    const ifo = buildIfoBytes({
      version: '2.4.2',
      wordcount: '1',
      idxfilesize: String(idx.length),
      bookname: 'Test Dict',
    });
    mockFileRegistry.set('memory://test.ifo', ifo);
    mockFileRegistry.set('memory://test.idx', idx);
    mockFileRegistry.set('memory://test.dict', article);
    return [
      { uri: 'memory://test.ifo', fileName: 'test.ifo', size: ifo.length },
      { uri: 'memory://test.idx', fileName: 'test.idx', size: idx.length },
      { uri: 'memory://test.dict', fileName: 'test.dict', size: article.length },
    ];
  }

  test('三件套正常导入成功且不带 warnings', async () => {
    const res = await DictImportService.importStarDict(starDictTrio());
    expect(res.success).toBe(true);
    expect(res.data!.totalEntries).toBe(1);
    expect(res.data!.warnings).toBeUndefined();
  });

  test('误选无关文件（csv）：导入仍成功，warnings 提示已忽略', async () => {
    const files = [...starDictTrio(), fileOf('extra.csv', '字头,释义\n好,善\n')];
    const res = await DictImportService.importStarDict(files);
    expect(res.success).toBe(true);
    expect(res.data!.totalEntries).toBe(1);
    expect(res.data!.warnings).toHaveLength(1);
    expect(res.data!.warnings![0]).toContain('1 个无关文件');
    expect(res.data!.warnings![0]).toContain('extra.csv');
    // 词条不受无关文件影响
    expect(st.user.entries).toHaveLength(1);
  });
});
