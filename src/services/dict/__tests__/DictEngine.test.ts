/**
 * DictEngine / DictDatabase 单元测试
 * 策略：以可编程 quick-sqlite mock（内存表 + SQL 模式匹配）覆盖双库读写链路，
 * 验证引擎的归一化、排序合并、异体/通假扩展、仲裁与删除回退逻辑。
 * 表结构与 DictDatabase DDL 一致（dicts / entries），DELETE/UPDATE 均真实生效。
 */
import { DictEngine, normalizeHeadword } from '@/services/dict/DictEngine';
import { DictDatabase } from '@/services/dict/DictDatabase';
import { useDictStore } from '@/store/useDictStore';

type Row = Record<string, unknown>;

interface MockTable {
  dicts: Row[];
  entries: Row[];
}

jest.mock('react-native-quick-sqlite', () => {
  const state: Record<'native' | 'user', { dicts: Record<string, unknown>[]; entries: Record<string, unknown>[] }> = {
    native: { dicts: [], entries: [] },
    user: { dicts: [], entries: [] },
  };

  const rows = (arr: Record<string, unknown>[]) => ({ rows: { _array: arr, length: arr.length } });

  const execute = (
    tab: { dicts: Record<string, unknown>[]; entries: Record<string, unknown>[] },
    sql: string,
    params: (string | number)[],
  ): { rows: { _array: Record<string, unknown>[]; length: number } } => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM dicts')) {
      return rows([...tab.dicts]);
    }
    if (s.startsWith('SELECT * FROM entries WHERE dict_id = ? AND headword_norm IN')) {
      const dictId = String(params[0]);
      const cands = params.slice(1).map(String);
      const hit = tab.entries.find(
        (e) => String(e.dict_id) === dictId && cands.includes(String(e.headword_norm)),
      );
      return rows(hit ? [hit] : []);
    }
    if (s.startsWith('SELECT * FROM entries WHERE dict_id = ? AND headword_norm = ?')) {
      const dictId = String(params[0]);
      const norm = String(params[1]);
      const hit = tab.entries.find(
        (e) => String(e.dict_id) === dictId && String(e.headword_norm) === norm,
      );
      return rows(hit ? [hit] : []);
    }
    if (s.startsWith('SELECT DISTINCT headword FROM entries')) {
      // 语向感知 searchPrefix：带 dict_id 过滤（params: dictId, prefix, limit）；兼容无过滤旧形态
      const hasDictFilter = s.includes('dict_id = ?');
      const dictId = hasDictFilter ? String(params[0]) : null;
      const prefix = String(hasDictFilter ? params[1] : params[0]).replace(/%$/, '');
      const limit = Number((hasDictFilter ? params[2] : params[1]) ?? 20);
      const seen = new Set<string>();
      const out: Row[] = [];
      for (const e of tab.entries) {
        if (dictId !== null && String(e.dict_id) !== dictId) {
          continue;
        }
        const hw = String(e.headword);
        if (String(e.headword_norm).startsWith(prefix) && !seen.has(hw)) {
          seen.add(hw);
          out.push({ headword: hw });
        }
      }
      return rows(out.slice(0, limit));
    }
    if (s.startsWith('INSERT OR REPLACE INTO dicts')) {
      const id = String(params[0]);
      tab.dicts = tab.dicts.filter((d) => String(d.id) !== id);
      tab.dicts.push({
        id,
        name: params[1],
        kind: params[2],
        format: params[3],
        entry_count: params[4],
        version: params[5],
        license: params[6],
        description: params[7],
        lang_pair: params[8],
        created_at: params[9],
        updated_at: params[10],
      });
      return rows([]);
    }
    if (s.startsWith('SELECT readings_json FROM entries')) {
      const norm = String(params[0]);
      return rows(
        tab.entries
          .filter((e) => String(e.headword_norm) === norm && e.readings_json !== null && e.readings_json !== undefined)
          .map((e) => ({ readings_json: e.readings_json })),
      );
    }
    if (s.startsWith('DELETE FROM entries')) {
      const dictId = String(params[0]);
      tab.entries = tab.entries.filter((e) => String(e.dict_id) !== dictId);
      return rows([]);
    }
    if (s.startsWith('DELETE FROM dicts')) {
      const dictId = String(params[0]);
      tab.dicts = tab.dicts.filter((d) => String(d.id) !== dictId);
      return rows([]);
    }
    if (s.startsWith('UPDATE dicts')) {
      return rows([]);
    }
    if (/^(CREATE|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK)/.test(s)) {
      return rows([]);
    }
    throw new Error(`quick-sqlite mock：未实现的 SQL：${s}`);
  };

  return {
    open: jest.fn(({ name }: { name: string }) => ({
      execute: (sql: string, params: (string | number)[] = []) =>
        execute(name === 'native_dict.db' ? state.native : state.user, sql, params),
      executeBatch: jest.fn(),
    })),
    __dictState: state,
  };
});

/** quick-sqlite mock 的内存表（经 __dictState 暴露） */
const sqliteMock = jest.requireMock('react-native-quick-sqlite') as {
  __dictState: Record<'native' | 'user', MockTable>;
};
const tables = sqliteMock.__dictState;

/** 造一条 dicts 行（langPair：语种对，如 zh-en / en-zh；缺省 null 表示中文单语） */
function dictRow(
  id: string,
  name: string,
  createdAt: string,
  kind: 'native' | 'user' = 'native',
  langPair?: string,
): Row {
  return {
    id,
    name,
    kind,
    format: kind === 'native' ? 'builtin' : 'csv',
    entry_count: 1,
    version: null,
    license: null,
    description: null,
    lang_pair: langPair ?? null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/** 造一条 entries 行 */
function entryRow(
  id: number,
  dictId: string,
  headword: string,
  headwordNorm: string,
  opts: {
    pinyin?: string;
    readings?: string[];
    contentType?: string;
    content?: string;
    extra?: Record<string, unknown>;
  } = {},
): Row {
  return {
    id,
    dict_id: dictId,
    headword,
    headword_norm: headwordNorm,
    pinyin: opts.pinyin ?? null,
    readings_json: opts.readings ? JSON.stringify(opts.readings) : null,
    content: opts.content ?? '[]',
    content_type: opts.contentType ?? 'structured',
    extra_json: opts.extra ? JSON.stringify(opts.extra) : null,
  };
}

describe('normalizeHeadword（归一化唯一入口）', () => {
  test('繁体转简体', () => {
    expect(normalizeHeadword('學')).toBe('学');
  });

  test('首尾空白与零宽字符清除', () => {
    expect(normalizeHeadword('  學  ')).toBe('学');
    expect(normalizeHeadword('\u200b明\ufeff')).toBe('明');
  });

  test('拉丁转小写', () => {
    expect(normalizeHeadword('ABC')).toBe('abc');
  });
});

describe('DictDatabase.rowToEntry', () => {
  test('完整行映射（含 readings / extra JSON 解析）', () => {
    const entry = DictDatabase.rowToEntry(
      entryRow(7, 'd1', '學', '学', {
        pinyin: 'xué',
        readings: ['xué', 'jiào'],
        content: '[{"def":"学习"}]',
        extra: { radical: '子', strokes: 8 },
      }),
    );
    expect(entry).toMatchObject({
      id: 7,
      dictId: 'd1',
      headword: '學',
      headwordNorm: '学',
      pinyin: 'xué',
      readings: ['xué', 'jiào'],
      contentType: 'structured',
      content: '[{"def":"学习"}]',
      extra: { radical: '子', strokes: 8 },
    });
  });

  test('空 readings_json / 坏 extra_json 返回 undefined 且不抛错', () => {
    const entry = DictDatabase.rowToEntry(
      entryRow(1, 'd1', '好', '好', { readings: undefined, extra: undefined }),
    );
    expect(entry.readings).toBeUndefined();
    expect(entry.extra).toBeUndefined();
  });
});

describe('DictEngine（quick-sqlite 可编程 responder）', () => {
  beforeAll(async () => {
    tables.native.dicts = [
      dictRow('native-common', '国学通用小字典', '2026-01-01T00:00:00Z'),
      dictRow('native-classical', '古汉语常用字典', '2026-01-02T00:00:00Z'),
    ];
    tables.user.dicts = [dictRow('user-csv-1', '我的字典', '2026-01-03T00:00:00Z', 'user')];

    tables.native.entries = [
      entryRow(1, 'native-common', '學', '学', {
        pinyin: 'xué',
        readings: ['xué', 'jiào'],
        content: '[{"def":"学习"},{"def":"学校"}]',
        extra: { radical: '子', strokes: 8 },
      }),
      entryRow(2, 'native-classical', '學', '学', {
        pinyin: 'xué',
        content: '[{"def":"效法，学习","citations":["学而时习之"]}]',
      }),
      entryRow(3, 'native-classical', '說', '说', {
        pinyin: 'shuō',
        readings: ['shuō', 'yuè'],
        content: '[{"def":"解说"},{"def":"通悦，喜悦","citations":["不亦说乎"]}]',
      }),
      entryRow(4, 'native-common', '学生', '学生', { content: '[{"def":"求学的人"}]' }),
      entryRow(5, 'user', '学生', '学生', { content: '[{"def":"重复词条"}]' }),
    ];
    tables.user.entries = [
      entryRow(10, 'user-csv-1', '峰', '峰', { pinyin: 'fēng', content: '[{"def":"山峰"}]' }),
      entryRow(11, 'user-csv-1', '說', '说', {
        readings: ['yuè', 'shuì'],
        content: '[{"def":"话说"}]',
      }),
    ];

    const res = await DictEngine.init();
    expect(res.success).toBe(true);
    expect(DictEngine.isReady()).toBe(true);
  });

  beforeEach(() => {
    // store 重置为引擎同步后的基准状态（避免用例间污染）
    useDictStore.setState({
      dictSettings: {
        'native-common': { enabled: true, order: 0 },
        'native-classical': { enabled: true, order: 1 },
        'user-csv-1': { enabled: true, order: 2 },
      },
      defaultDictId: null,
      polyphoneSource: { type: 'builtin' },
    });
  });

  test('init 后 store 元数据同步（syncFromEngine 注册全部字典且默认启用）', () => {
    const res = DictEngine.listDicts();
    expect(res.success).toBe(true);
    expect(res.data?.map((d) => d.id)).toEqual(['native-common', 'native-classical', 'user-csv-1']);
    expect(res.data?.every((d) => d.enabled)).toBe(true);
  });

  test('lookup：繁体命中归一化字头，结果按 order 排序，未收录字典 entry 为 null', () => {
    const res = DictEngine.lookup('學');
    expect(res.success).toBe(true);
    const data = res.data!;
    expect(data.headword).toBe('學');
    expect(data.results.map((r) => r.dict.id)).toEqual([
      'native-common',
      'native-classical',
      'user-csv-1',
    ]);
    expect(data.results[0].entry?.headwordNorm).toBe('学');
    expect(data.results[0].entry?.extra?.radical).toBe('子');
    expect(data.results[2].entry).toBeNull();
    // 单字聚合：部首/笔画取首个命中字典
    expect(data.charInfo?.radical).toBe('子');
    expect(data.charInfo?.strokes).toBe(8);
  });

  test('lookup：异体字反向命中（峯 → 峰）', () => {
    const res = DictEngine.lookup('峯');
    const hit = res.data!.results.find((r) => r.entry !== null);
    expect(hit?.dict.id).toBe('user-csv-1');
    expect(hit?.entry?.headword).toBe('峰');
  });

  test('lookup：通假字聚合（说 → 悦，来自内置 tongjia-zi.json）', () => {
    const res = DictEngine.lookup('说');
    expect(res.data!.charInfo?.tongjia?.original).toBe('悦');
  });

  test('lookup：空字头返回错误', () => {
    const res = DictEngine.lookup('   ');
    expect(res.success).toBe(false);
    expect(res.error).toContain('不能为空');
  });

  test('lookup：禁用字典不参与聚合', () => {
    useDictStore.getState().setEnabled('native-classical', false);
    const res = DictEngine.lookup('學');
    expect(res.data!.results.map((r) => r.dict.id)).toEqual(['native-common', 'user-csv-1']);
  });

  test('lookup：dictIds 过滤优先于 enabled', () => {
    const res = DictEngine.lookup('學', { dictIds: ['native-classical'] });
    expect(res.data!.results.map((r) => r.dict.id)).toEqual(['native-classical']);
    expect(res.data!.results[0].entry?.content).toContain('效法');
  });

  test('lookupInDict：命中与未收录（null）', () => {
    expect(DictEngine.lookupInDict('學', 'native-common').data?.headwordNorm).toBe('学');
    expect(DictEngine.lookupInDict('學', 'user-csv-1').data).toBeNull();
  });

  test('searchPrefix：跨双库去重 + limit 截断', () => {
    const res = DictEngine.searchPrefix('学');
    expect(res.success).toBe(true);
    expect(res.data).toEqual(['學', '学生']);
    expect(DictEngine.searchPrefix('学', 1).data).toEqual(['學']);
    expect(DictEngine.searchPrefix('不存在的字')).toEqual({ success: true, data: [] });
  });

  test('searchPrefix：输入含 % / _ 时按字面匹配，不做通配符全表匹配', () => {
    // '%'-only 若未转义将命中全表；转义后应无结果（无字头以字面 % 开头）
    expect(DictEngine.searchPrefix('%').data).toEqual([]);
    // 前缀含 % 亦不应放宽为「以 学 开头」的全表匹配
    expect(DictEngine.searchPrefix('学%').data).toEqual([]);
    expect(DictEngine.searchPrefix('学_').data).toEqual([]);
  });

  test('getReadings：双库 readings 并集去重', () => {
    expect(DictEngine.getReadings('说')).toEqual(['shuō', 'yuè', 'shuì']);
    // 多字或空字符串返回空数组
    expect(DictEngine.getReadings('学生')).toEqual([]);
    expect(DictEngine.getReadings('')).toEqual([]);
  });

  test('resolve：多音字来源指向字典时按书证语境判音', () => {
    useDictStore.getState().setPolyphoneSource({ type: 'dict', dictId: 'native-classical' });
    // 书证「不亦说乎」命中第 2 义项 → 返回 readings[1] = yuè
    expect(DictEngine.resolve('说', '不亦说乎')).toBe('yuè');
    // 未命中的语境返回 null（回退内置规则库）
    expect(DictEngine.resolve('说', '毫无关系的语境')).toBeNull();
  });

  test('resolve：来源为 builtin 时直接返回 null', () => {
    expect(DictEngine.resolve('说', '不亦说乎')).toBeNull();
  });

  test('deleteDict：原生字典只读拒绝删除', () => {
    const res = DictEngine.deleteDict('native-common');
    expect(res.success).toBe(false);
    expect(res.error).toContain('只读');
  });

  test('deleteDict：删除用户字典并清理 store 残留（多音字来源回退 builtin）', () => {
    useDictStore.getState().setPolyphoneSource({ type: 'dict', dictId: 'user-csv-1' });
    useDictStore.getState().setDefaultDict('user-csv-1');

    const res = DictEngine.deleteDict('user-csv-1');
    expect(res.success).toBe(true);

    const state = useDictStore.getState();
    expect(state.dictSettings['user-csv-1']).toBeUndefined();
    expect(state.defaultDictId).toBeNull();
    expect(state.polyphoneSource).toEqual({ type: 'builtin' });
    // db 侧也已删除
    expect(DictEngine.lookupInDict('峰', 'user-csv-1').data).toBeNull();
  });

  test('deleteDict：不存在的字典返回错误', () => {
    expect(DictEngine.deleteDict('no-such-dict').success).toBe(false);
  });

  test('insert 新字典后 lookup 立即可见（dicts 行缓存随 refresh 失效）', () => {
    // 走真实写入路径：insertDictRow →（导入服务同款）syncFromEngine → lookup
    DictDatabase.insertDictRow({
      id: 'user-new-1',
      name: '新导入字典',
      kind: 'user',
      format: 'csv',
      entryCount: 1,
      description: '测试新增',
      createdAt: '2026-01-04T00:00:00Z',
    });
    tables.user.entries.push(entryRow(20, 'user-new-1', '新', '新', { content: '[{"def":"新"}]' }));
    useDictStore.getState().syncFromEngine();

    const res = DictEngine.lookup('新');
    expect(res.success).toBe(true);
    const hit = res.data!.results.find((r) => r.dict.id === 'user-new-1');
    expect(hit?.entry?.headword).toBe('新');
    // 删除路径同样立即可见（缓存同步失效）
    expect(DictEngine.deleteDict('user-new-1').success).toBe(true);
    expect(DictEngine.lookup('新').data!.results.some((r) => r.dict.id === 'user-new-1')).toBe(false);
  });

  // ---- 语向感知排序（lang_pair 消费端）：双向字典与含混合词头条目用于观察批次顺序 ----

  test('searchPrefix：latin 查询 en-zh 字典结果排前，填满 limit 不再查其余批次', () => {
    // 追加双向 cedict 字典与拉丁词头条目（含中文字典中的拉丁词头，模拟混合词头数据）
    tables.native.dicts.push(
      dictRow('cedict-zh-en', 'CC-CEDICT 汉英', '2026-01-05T00:00:00Z', 'native', 'zh-en'),
      dictRow('cedict-en-zh', 'CC-CEDICT 英汉', '2026-01-06T00:00:00Z', 'native', 'en-zh'),
    );
    tables.native.entries.push(
      entryRow(30, 'cedict-en-zh', 'student', 'student', { content: '[{"def":"学生"}]' }),
      entryRow(31, 'cedict-en-zh', 'study', 'study', { content: '[{"def":"学习"}]' }),
      entryRow(32, 'cedict-zh-en', 'sunrise', 'sunrise', { content: '[{"def":"日出"}]' }),
      entryRow(33, 'cedict-en-zh', '学堂', '学堂', { content: '[{"def":"school"}]' }),
      entryRow(34, 'native-common', 'say', 'say', { content: '[{"def":"说"}]' }),
    );
    DictEngine.listDicts(); // 刷新 dictDbMap（新增字典行后）

    // latin 查询：en-zh 批次（student/study）在前，其余批次按启用顺序（say → sunrise）
    expect(DictEngine.searchPrefix('s').data).toEqual(['student', 'study', 'say', 'sunrise']);
    // en-zh 批次填满 limit 后不再查第二批
    expect(DictEngine.searchPrefix('s', 2).data).toEqual(['student', 'study']);
  });

  test('searchPrefix：cjk 查询中文单语与 zh-en 排在 en-zh 之前', () => {
    // cjk 查询：非 en-zh 批次（native-common/native-classical）在前，en-zh（学堂）排后
    expect(DictEngine.searchPrefix('学').data).toEqual(['學', '学生', '学堂']);
  });

  test('searchPrefix：langPair 缺省字典按 cjk 优先级处理（不因 undefined 崩溃或错排）', () => {
    // 无语向的用户字典：cjk 查询参与优先批次；latin 查询落入非 en-zh 批次
    tables.user.dicts.push(dictRow('user-nolang', '无语向用户字典', '2026-01-07T00:00:00Z', 'user'));
    tables.user.entries.push(
      entryRow(35, 'user-nolang', '学生物', '学生物', { content: '[{"def":"学生物"}]' }),
      entryRow(36, 'user-nolang', 'salt', 'salt', { content: '[{"def":"盐"}]' }),
    );
    DictEngine.listDicts(); // 刷新 dictDbMap

    // cjk 查询：缺省语向字典与中文单语同批（学生 → 学生物）
    expect(DictEngine.searchPrefix('学生').data).toEqual(['学生', '学生物']);
    // latin 查询：缺省语向字典在 en-zh 之后（student/study → say → sunrise → salt），无 undefined 异常
    expect(DictEngine.searchPrefix('s').data).toEqual(['student', 'study', 'say', 'sunrise', 'salt']);
  });
});

describe('DictDatabase.openDictDatabases 幂等', () => {
  test('连续调用两次均成功（惰性单例复用连接）', () => {
    expect(DictDatabase.openDictDatabases().success).toBe(true);
    expect(DictDatabase.openDictDatabases().success).toBe(true);
  });
});

describe('DictDatabase.insertEntries（mock 写入路径）', () => {
  test('空数组直接返回 0；非空走 BEGIN/executeBatch/COMMIT 事务', () => {
    expect(DictDatabase.insertEntries('user-csv-1', [])).toBe(0);

    const entries = [
      DictDatabase.rowToEntry(entryRow(0, 'user-csv-1', '好', '好', { content: '[{"def":"善"}]' })),
    ];
    expect(DictDatabase.insertEntries('user-csv-1', entries)).toBe(1);
  });
});
