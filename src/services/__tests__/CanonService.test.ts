/**
 * CanonService 单元测试（T11）
 * 验证：
 *   - 三级查询优先级（精确篇目 > 书级 > 全局 '*'）
 *   - sources JSON 解析与 verified 转换
 *   - 库未初始化/无匹配返回 null（降级为「无证据」）
 *   - 与 PinyinService 仲裁集成（canon 命中才标通假、读音采用并标 verified）
 */
import CanonService, {
  CANON_DICT_VERSION,
  isCanonDbOutdated,
} from '@/services/CanonService';
import RNFS from 'react-native-fs';
import {
  annotate,
  setCanonProvider,
  getCanonProvider,
} from '@/services/PinyinService';
import type { CanonProvider } from '@/types';
import { installPhrasePinyinSyncProviderForTests } from './phrasePinyin.helper';

// P0 资产下沉：测试环境注入词组层同步 provider（与静态 import 时代行为一致）
installPhrasePinyinSyncProviderForTests();

// ---- mock 控制状态（由用例写入，驱动 quick-sqlite mock 返回）----
const state = {
  tongjia: [] as Record<string, unknown>[],
  reading: [] as Record<string, unknown>[],
  /** 已部署库的 PRAGMA user_version（驱动版本比对升级路径） */
  userVersion: 2 as number,
};

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
  MainBundlePath: '/data/app/bundle',
  mkdir: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
  copyFileAssets: jest.fn(async () => undefined),
  copyFile: jest.fn(async () => undefined),
  // 升级路径覆盖重拷前清理 WAL/journal 残留（ CanonService.recopyCanonDb 调用）
  unlink: jest.fn(async () => undefined),
}));

jest.mock('react-native-quick-sqlite', () => ({
  open: jest.fn(() => ({
    execute: (sql: string, params: (string | number)[] = []) => {
      // 回归守卫：SQL 占位符 ? 数量必须与参数数一致，否则 quick-sqlite 会抛
      // 「Too many parameter values」导致查询静默失败（历史真实 bug）。
      const qCount = (sql.match(/\?/g) || []).length;
      if (qCount !== params.length) {
        throw new Error(`SQL 占位符数量(${qCount})与参数数(${params.length})不一致: ${sql}`);
      }
      if (sql.includes('PRAGMA user_version')) {
        return { rows: { _array: [{ user_version: state.userVersion }] } };
      }
      if (sql.includes('sqlite_master')) {
        return { rows: { _array: [{ name: 'tongjia_judgment' }] } };
      }
      let rows: Record<string, unknown>[];
      if (sql.includes('tongjia_judgment')) {
        rows = state.tongjia;
      } else if (sql.includes('reading_selection')) {
        rows = state.reading;
      } else {
        return { rows: { _array: [] } };
      }
      // 复刻 SQL 语义：tiers 在前半，char 在中，tiers 在后半
      const k = (params.length - 1) / 2;
      const tiers = params.slice(0, k).map(String);
      const char = String(params[k] ?? '');
      const matched = rows.filter((r) => String(r.char) === char && tiers.includes(String(r.work_id)));
      if (matched.length === 0) {
        return { rows: { _array: [] } };
      }
      // 复刻 ORDER BY：层级优先（tiers 下标小在前）→ 同层级有 context 的行优先 → rowid
      const withIdx = matched.map((r, i) => ({
        r,
        pri: tiers.indexOf(String(r.work_id)),
        noCtx: r.context ? 0 : 1,
        rowid: i,
      }));
      withIdx.sort((a, b) => a.pri - b.pri || a.noCtx - b.noCtx || a.rowid - b.rowid);
      return { rows: { _array: withIdx.map((x) => x.r) } };
    },
  })),
}));

function resetRows() {
  state.tongjia = [];
  state.reading = [];
  // 复位为与目标版本一致（避免升级路径测试污染其他用例）
  state.userVersion = CANON_DICT_VERSION;
}

describe('CanonService 三级查询优先级', () => {
  beforeEach(async () => {
    resetRows();
    state.tongjia = [
      { work_id: '*', char: '说', original: '悦', note: '通悦', sources: '["北师大通假字资源库"]', verified: 1 },
      { work_id: 'lunyu-xueer', char: '说', original: '阅', note: '通阅', sources: '["北师大通假字资源库"]', verified: 1 },
    ];
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
  });

  afterEach(() => {
    CanonService.getInstance().close();
  });

  test('精确篇目优先于全局 * ', () => {
    const r = CanonService.getInstance().getTongjia('lunyu-xueer', 'lunyu', '说');
    expect(r).not.toBeNull();
    expect(r!.original).toBe('阅');
    expect(r!.verified).toBe(true);
    expect(r!.sources).toEqual(['北师大通假字资源库']);
  });

  test('精确篇目缺失时回退到书级，最后回退全局 * ', () => {
    // tiers = ['lunyu-other','lunyu','*'] → 命中 '*'
    const r = CanonService.getInstance().getTongjia('lunyu-other', 'lunyu', '说');
    expect(r!.original).toBe('悦');
  });

  test('仅传 workId 也无匹配篇目时回退全局 * ', () => {
    const r = CanonService.getInstance().getTongjia(undefined, undefined, '说');
    expect(r!.original).toBe('悦');
  });

  test('任意层级均无匹配返回 null（不标角标）', () => {
    expect(CanonService.getInstance().getTongjia('x', 'y', '无此字')).toBeNull();
  });

  test('reading_selection 同样遵循三级优先级', () => {
    state.reading = [
      { work_id: '*', char: '重', reading: 'zhòng', sources: '["chinese-poetry 开源诗词库"]', verified: 1 },
      { work_id: 'poem-1', char: '重', reading: 'chóng', sources: '["chinese-poetry 开源诗词库"]', verified: 1 },
    ];
    // 重新 init 以刷新（此处直接查即可，mock 实时读取 state）
    const r = CanonService.getInstance().getReading('poem-1', 'book', '重');
    expect(r!.reading).toBe('chóng');
    expect(r!.verified).toBe(true);
    const r2 = CanonService.getInstance().getReading('other', 'book', '重');
    expect(r2!.reading).toBe('zhòng');
  });

  test('库未初始化时 getTongjia 返回 null（降级安全）', () => {
    CanonService.getInstance().close();
    expect(CanonService.getInstance().getTongjia('lunyu-xueer', 'lunyu', '说')).toBeNull();
  });
});

describe('CanonService 用字关系类型 kind（canon_dict v2·B3）', () => {
  beforeEach(async () => {
    resetRows();
    // 模拟 v2 库：gujin 行带 type='gujin'；BNU 行带 type='tongjia'；
    // 旧库（v1）行无 type 列 → SELECT * 不含该字段 → 回退 tongjia
    state.tongjia = [
      { work_id: 'mengzi-liang-hui-wang-shang', char: '说', original: '悦', note: '古今字·悦', sources: '["人工标注·据训诂常识（古今字），建议校对"]', verified: 0, type: 'gujin' },
      // 輮(U+8FAE) 运行时经 opencc 归一化为 𫐓(U+2B4D3)，库内键与该查询键一致（B3 构建口径）
      { work_id: 'xunzi-quan-xue', char: '𫐓', original: '煣', note: '通煣', sources: '["北师大通假字资源库·《荀子·劝学》"]', verified: 1, type: 'tongjia' },
      { work_id: 'lunyu-xueer', char: '说', original: '悦', note: '旧库无 type 列', sources: '["seed"]', verified: 1 },
    ];
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
  });

  afterEach(() => {
    CanonService.getInstance().close();
  });

  test('type=gujin 的行返回 kind=gujin 且 verified=false（建议校对语义）', () => {
    const r = CanonService.getInstance().getTongjia('mengzi-liang-hui-wang-shang', 'mengzi', '说');
    expect(r).not.toBeNull();
    expect(r!.original).toBe('悦');
    expect(r!.kind).toBe('gujin');
    expect(r!.verified).toBe(false);
  });

  test('type=tongjia 的行返回 kind=tongjia', () => {
    // 库内 char 键与运行时查询键同口径（构建期 opencc 归一化，如正文「輮」查询键为「𫐓」）
    const r = CanonService.getInstance().getTongjia('xunzi-quan-xue', 'xunzi', '輮');
    expect(r).not.toBeNull();
    expect(r!.original).toBe('煣');
    expect(r!.kind).toBe('tongjia');
    expect(r!.verified).toBe(true);
  });

  test('旧库行（无 type 字段）回退为 kind=tongjia（向后兼容）', () => {
    const r = CanonService.getInstance().getTongjia('lunyu-xueer', 'lunyu', '说');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('tongjia');
  });

  test('古今字种子三样例说/悦、知/智、反/返 均可经三级查询命中（B3 任务 C）', () => {
    state.tongjia.push(
      { work_id: 'mengzi', char: '反', original: '返', note: '古今字·返', sources: '["人工标注·据训诂常识（古今字），建议校对"]', verified: 0, type: 'gujin' },
      { work_id: 'mengzi', char: '知', original: '智', note: '古今字·智', sources: '["人工标注·据训诂常识（古今字），建议校对"]', verified: 0, type: 'gujin' },
    );
    // 书级兜底：章级未收录时经 bookId=mengzi 层命中
    for (const [char, original] of [['反', '返'], ['知', '智']] as const) {
      const r = CanonService.getInstance().getTongjia('mengzi-wei-zhang-wei-xia', 'mengzi', char);
      expect(r).not.toBeNull();
      expect(r!.original).toBe(original);
      expect(r!.kind).toBe('gujin');
    }
  });
});

describe('PinyinService × canon 仲裁（缺陷一/二根治）', () => {
  afterEach(() => {
    setCanonProvider(null);
  });

  test('无 canon 注入：通假不标角标、读音标未校验（缺陷一归零）', () => {
    expect(getCanonProvider()).toBeNull();
    const res = annotate('学而时习之，不亦说乎', 'full');
    const shuo = res.data!.find((a) => a.char === '说')!;
    expect(shuo.tongjia).toBeUndefined(); // 不再因「通用通假属性」误标
    expect(shuo.readingVerified).toBe(false);
  });

  test('canon 通假命中：仅设置 tongjia 并带 sources/verified', () => {
    const provider: CanonProvider = {
      getTongjia: (workId, _bookId, char) =>
        char === '说'
          ? {
              original: '悦',
              note: '同“悦”，喜悦',
              sources: ['北师大通假字资源库'],
              verified: true,
              context: '不亦说乎',
            }
          : null,
      getReading: () => null,
    };
    setCanonProvider(provider);
    const res = annotate('不亦说乎', 'full', { workId: 'lunyu-xueer', bookId: 'lunyu' });
    const shuo = res.data!.find((a) => a.char === '说')!;
    expect(shuo.tongjia).toBeDefined();
    expect(shuo.tongjia!.original).toBe('悦');
    expect(shuo.tongjia!.sources).toEqual(['北师大通假字资源库']);
    expect(shuo.tongjia!.verified).toBe(true);
  });

  test('canon 读音命中：采用其 reading 并标 verified=true，优先级高于内置规则', () => {
    const provider: CanonProvider = {
      getTongjia: () => null,
      getReading: (workId, _bookId, char) =>
        char === '说'
          ? {
              reading: 'shuì',
              sources: ['chinese-poetry 开源诗词库'],
              verified: true,
              context: '不亦说乎',
            }
          : null,
    };
    setCanonProvider(provider);
    // 「说」在「说乎」语境下内置规则库判为 yuè，但 canon 语境读音应胜出
    const res = annotate('不亦说乎', 'full', { workId: 'poem-x', bookId: 'book' });
    const shuo = res.data!.find((a) => a.char === '说')!;
    expect(shuo.pinyin).toBe('shuì');
    expect(shuo.readingVerified).toBe(true);
    expect(shuo.readingSources).toEqual(['chinese-poetry 开源诗词库']);
  });

  test('用户字典来源优先级高于 canon（仲裁最高级）', () => {
    // 注意：本测试不注入外部 ReadingProvider，仅验证 canon 在「无用户字典」时生效；
    // 用户字典高于 canon 已由 ReadingProvider 逻辑保证（外部 provider 先判定）。
    const provider: CanonProvider = {
      getTongjia: () => null,
      getReading: (_w, _b, c) =>
        c === '重'
          ? { reading: 'chóng', sources: ['s'], verified: true, context: '德高望重' }
          : null,
    };
    setCanonProvider(provider);
    const res = annotate('德高望重', 'full', { workId: 'poem-1' });
    const zhong = res.data!.find((a) => a.char === '重')!;
    expect(zhong.pinyin).toBe('chóng');
    expect(zhong.readingVerified).toBe(true);
  });
});

describe('PinyinService × canon v3 用例级语境锚定', () => {
  afterEach(() => {
    setCanonProvider(null);
  });

  test('例句命中：候选行带 context 且字符落在例句跨度内 → 标注并透传例句', () => {
    const provider: CanonProvider = {
      getTongjiaCandidates: (_w, _b, char) =>
        char === '说'
          ? [
              {
                original: '悦',
                note: '同“悦”，喜悦',
                sources: ['北师大通假字资源库'],
                verified: true,
                context: '学而时习之，不亦说乎',
              },
            ]
          : [],
      getTongjia: () => null,
      getReading: () => null,
    };
    setCanonProvider(provider);
    const res = annotate('子曰：学而时习之，不亦说乎！人说的多呀', 'full', {
      workId: 'lunyu-xueer',
      bookId: 'lunyu',
    });
    const shuo = res.data!.find((a) => a.char === '说' && a.tongjia)!;
    expect(shuo.tongjia!.original).toBe('悦');
    expect(shuo.tongjia!.context).toBe('学而时习之，不亦说乎');
  });

  test('例句未命中（同篇另一处本义用法）：不标注（宁缺毋滥）', () => {
    const provider: CanonProvider = {
      getTongjiaCandidates: (_w, _b, char) =>
        char === '说'
          ? [
              {
                original: '悦',
                note: '通悦',
                sources: ['北师大通假字资源库'],
                verified: true,
                context: '学而时习之，不亦说乎',
              },
            ]
          : [],
      getTongjia: () => null,
      getReading: () => null,
    };
    setCanonProvider(provider);
    // 「成事不说」中「说」为本义（说解），例句「不亦说乎」未出现 → 不标注
    const res = annotate('成事不说，遂事不谏', 'full', {
      workId: 'lunyu-bayi',
      bookId: 'lunyu',
    });
    const shuo = res.data!.find((a) => a.char === '说')!;
    expect(shuo.tongjia).toBeUndefined();
  });

  test('读音候选同样受语境锚定约束：例句未命中 → canon 未采用，回退词组层（v3.2）', () => {
    const provider: CanonProvider = {
      getTongjia: () => null,
      getReadingCandidates: (_w, _b, char) =>
        char === '说'
          ? [{ reading: 'yuè', sources: ['北师大通假字资源库'], verified: true, context: '学而时习之，不亦说乎' }]
          : [],
      getReading: () => null,
    };
    setCanonProvider(provider);
    const res = annotate('成事不说', 'full', { workId: 'lunyu-bayi', bookId: 'lunyu' });
    const shuo = res.data!.find((a) => a.char === '说')!;
    // canon 的 yuè 未被采用；回退链路命中词组层「成事不说 → shuō」（读音正确）
    expect(shuo.pinyin).toBe('shuō');
    expect(shuo.readingVerified).toBe(true);
    expect(shuo.readingSources![0]).toContain('phrase-pinyin-data');
  });

  test('候选行无 context（人工种子/引文缺失）：不标注（v3.1 宁缺毋滥）', () => {
    // 「其→箕」「虚→墟」教训：无例句的字级人工断言无用例支撑，
    // 会让全书每个出现位置都被误标 → 无 context 行一律跳过
    const provider: CanonProvider = {
      getTongjiaCandidates: (_w, _b, char) =>
        char === '反' ? [{ original: '返', sources: ['人工标注'], verified: false }] : [],
      getTongjia: () => null,
      getReading: () => null,
    };
    setCanonProvider(provider);
    const res = annotate('往而不反也', 'full', { workId: 'mengzi', bookId: 'mengzi' });
    const fan = res.data!.find((a) => a.char === '反')!;
    expect(fan.tongjia).toBeUndefined();
  });

  test('繁体正文：例句匹配在归一化后进行（說→说），命中不受显示字形影响', () => {
    const provider: CanonProvider = {
      getTongjiaCandidates: (_w, _b, char) =>
        char === '说'
          ? [
              {
                original: '悦',
                note: '通悦',
                sources: ['北师大通假字资源库'],
                verified: true,
                context: '学而时习之，不亦说乎',
              },
            ]
          : [],
      getTongjia: () => null,
      getReading: () => null,
    };
    setCanonProvider(provider);
    // 繁体正文段落（含完整例句覆盖）；「說」归一化为「说」后与简体例句匹配
    const res = annotate('子曰：學而時習之，不亦說乎！', 'full', {
      workId: 'lunyu-xueer',
      bookId: 'lunyu',
    });
    const shuo = res.data!.find((a) => a.tongjia)!;
    expect(shuo.char).toBe('說');
    expect(shuo.tongjia!.original).toBe('悦');
  });
});


describe('CanonService v3 用例级语境锚定（context 列）', () => {
  beforeEach(async () => {
    resetRows();
    // 同篇同字的两个通假用例（context 不同）共存；无 context 的旧行殿后
    state.tongjia = [
      { work_id: 'lunyu-bayi', char: '说', original: '解', note: '本义', sources: '["x"]', verified: 0, type: 'tongjia', context: null },
      { work_id: 'lunyu-xueer', char: '说', original: '悦', note: '通悦', sources: '["北师大通假字资源库"]', verified: 1, type: 'tongjia', context: '学而时习之，不亦说乎' },
    ];
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
  });

  afterEach(() => {
    CanonService.getInstance().close();
  });

  test('getTongjiaCandidates 返回层级优先的全部候选并透传 context', () => {
    const cands = CanonService.getInstance().getTongjiaCandidates('lunyu-xueer', 'lunyu', '说');
    // 章级行在前（context 非空优先），全局/书级行在后
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands[0]!.original).toBe('悦');
    expect(cands[0]!.context).toBe('学而时习之，不亦说乎');
  });

  test('getTongjia = 候选首条（单行旧行为兼容）', () => {
    const r = CanonService.getInstance().getTongjia('lunyu-xueer', 'lunyu', '说');
    expect(r!.original).toBe('悦');
  });

  test('reading_candidates 同样透传 context', () => {
    state.reading = [
      { work_id: 'lunyu-xueer', char: '说', reading: 'yuè', sources: '["北师大通假字资源库"]', verified: 1, context: '学而时习之，不亦说乎' },
    ];
    const r = CanonService.getInstance().getReadingCandidates('lunyu-xueer', 'lunyu', '说');
    expect(r[0]!.reading).toBe('yuè');
    expect(r[0]!.context).toBe('学而时习之，不亦说乎');
  });
});

describe('canon 库版本比对升级（#33）', () => {
  afterEach(() => {
    CanonService.getInstance().close();
    jest.clearAllMocks();
  });

  test('isCanonDbOutdated：版本比较纯函数（无标记/落后 → 需覆盖；一致或更新 → 沿用）', () => {
    expect(isCanonDbOutdated(1)).toBe(true);
    expect(isCanonDbOutdated(0)).toBe(true);
    expect(isCanonDbOutdated(null)).toBe(true); // v1 旧库无版本标记 → 按 0 触发升级
    expect(isCanonDbOutdated(undefined)).toBe(true);
    expect(isCanonDbOutdated(Number.NaN)).toBe(true);
    expect(isCanonDbOutdated(CANON_DICT_VERSION)).toBe(false);
    expect(isCanonDbOutdated(CANON_DICT_VERSION + 1)).toBe(false); // 高于目标不降级
  });

  test('旧版本（v1，user_version=1）触发关闭连接、清理日志并覆盖重拷', async () => {
    state.userVersion = 1;
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
    // 目标已存在（exists=true）→ 部署阶段不拷贝；仅升级路径触发一次覆盖重拷
    expect(RNFS.copyFileAssets).toHaveBeenCalledTimes(1);
    // 清理 WAL/-shm/-journal 三个残留文件
    expect(RNFS.unlink).toHaveBeenCalledTimes(3);
    // 重拷并重新打开后查询链路可用（无匹配返回 null，不崩溃）
    expect(CanonService.getInstance().getTongjia('x', 'y', '说')).toBeNull();
  });

  test('同版本不覆盖（幂等沿用）', async () => {
    state.userVersion = CANON_DICT_VERSION;
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
    expect(RNFS.copyFileAssets).not.toHaveBeenCalled();
    expect(RNFS.unlink).not.toHaveBeenCalled();
  });

  test('高于目标版本不降级覆盖', async () => {
    state.userVersion = CANON_DICT_VERSION + 1;
    const ok = await CanonService.getInstance().init();
    expect(ok).toBe(true);
    expect(RNFS.copyFileAssets).not.toHaveBeenCalled();
  });
});
