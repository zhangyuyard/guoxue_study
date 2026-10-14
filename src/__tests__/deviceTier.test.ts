/**
 * r38 T01 设备档位分级测试（档位矩阵 / 阈值纯函数 / 优先级链 / 持久化 key /
 * 硬上限 / 自适应降档去抖 / 探测回落）。
 *
 * 说明：本文件用 jest.mock 覆盖 setup 里的 react-native 桩，补上
 * Platform.constants + Dimensions/PixelRatio，用于验证「机型表命中 → low」
 * 与「无任何指纹/微基准结论 → fallback mid」两条端到端路径；
 * 其余断言均为纯函数，不依赖任何 RN 渲染环境。
 */
jest.mock('react-native', () => ({
  Platform: {
    OS: 'android',
    select: (obj) => obj.android,
    constants: { Brand: 'HUAWEI', Manufacturer: 'HUAWEI', Model: 'ALT-AL10', Version: 29 },
  },
  Dimensions: { get: () => ({ width: 720, height: 1280, scale: 2, fontScale: 1 }) },
  PixelRatio: { get: () => 2 },
}));

import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  ADAPTIVE_CONFIRM_SESSIONS,
  ADAPTIVE_JANK_MIN_COUNT,
  DEVICE_TIER_KEY,
  DeviceTierService,
  FALLBACK_TIER,
  LOW_END_MODEL_TABLE,
  PROBE_HIGH_THRESHOLD_MS,
  PROBE_LOW_THRESHOLD_MS,
  R38_CACHE_BUDGET_HARD_CAP,
  R38_TIER_PARAMS,
  TIER_PARAMS,
  classifyProbe,
  downgradeTier,
  getParams,
  getState,
  getTier,
  probeAndPersist,
  readModelTableTier,
  reportJankSample,
  resolveAdaptiveDowngrade,
  resolveTierScore,
  runMicroProbe,
  probeSink,
  setOverride,
  __setTierForTests,
  type DeviceTier,
  type TierParams,
} from '@/services/DeviceTierService';

const TIERS: readonly DeviceTier[] = ['low', 'mid', 'high'];

beforeEach(() => {
  __setTierForTests(null); // 重置模块态（清持久化 + 回落 mid）
});

describe('① 档位参数矩阵（§6.2 三档齐全，字段逐项对齐）', () => {
  test('三档齐全且每档字段集合完全一致', () => {
    const keySets = TIERS.map((tier) => Object.keys(TIER_PARAMS[tier]).sort());
    expect(keySets[0].length).toBeGreaterThanOrEqual(20);
    expect(keySets[1]).toEqual(keySets[0]);
    expect(keySets[2]).toEqual(keySets[0]);
  });

  test('每个字段三档均有取值，且 low 与 high 逐字段不同（禁止单值档位）', () => {
    // 架构 §6.2 明确「与档位无关」的两个字段（饥饿保护 / FTS 让出窗口为
    // 跨档恒定量，避免低端机因饥饿放弃而破坏「宁慢不丢」承诺）
    const INHERENTLY_UNIFORM: ReadonlyArray<keyof TierParams> = [
      'starvationMs',
      'ftsYieldMs',
    ];
    const keys = Object.keys(TIER_PARAMS.mid) as Array<keyof TierParams>;
    for (const key of keys) {
      const low = TIER_PARAMS.low[key];
      const mid = TIER_PARAMS.mid[key];
      const high = TIER_PARAMS.high[key];
      expect(typeof low).toBe('number');
      expect(typeof mid).toBe('number');
      expect(typeof high).toBe('number');
      if (INHERENTLY_UNIFORM.includes(key)) {
        // 跨档一致字段由下一条测试单独锁定（三档必须完全相同）
        expect(low).toBe(high);
        continue;
      }
      // low/high 必须体现档位差异；mid 允许与任一侧相同（负载型参数两侧收敛）
      expect(low).not.toBe(high);
    }
  });

  test('明确要求三档一致的两个字段：starvationMs / ftsYieldMs', () => {
    for (const tier of TIERS) {
      expect(TIER_PARAMS[tier].starvationMs).toBe(10000);
      expect(TIER_PARAMS[tier].ftsYieldMs).toBe(30000);
    }
  });

  test('关键档位数值与架构 §6.2 一致（低端机削减深度与预算，不削减边界就绪保证）', () => {
    expect(TIER_PARAMS.low.preloadSpan).toBe(2);
    expect(TIER_PARAMS.mid.preloadSpan).toBe(3);
    expect(TIER_PARAMS.high.preloadSpan).toBe(4);
    expect(TIER_PARAMS.low.maxContinuousChapters).toBe(12);
    expect(TIER_PARAMS.mid.maxContinuousChapters).toBe(20);
    expect(TIER_PARAMS.high.maxContinuousChapters).toBe(30);
    expect(TIER_PARAMS.low.cacheBudgetBytes).toBe(96 * 1024 * 1024);
    expect(TIER_PARAMS.mid.cacheBudgetBytes).toBe(192 * 1024 * 1024);
    expect(TIER_PARAMS.high.cacheBudgetBytes).toBe(300 * 1024 * 1024);
    // 低档让出更慢的机子更多窗口：readyLeadMs 反而更长
    expect(TIER_PARAMS.low.readyLeadMs).toBeGreaterThan(TIER_PARAMS.high.readyLeadMs);
  });
});

describe('② 阈值纯函数 classifyProbe 边界', () => {
  test('> 60ms → low（含 61 边界）', () => {
    expect(classifyProbe(61)).toBe('low');
    expect(classifyProbe(PROBE_LOW_THRESHOLD_MS + 1)).toBe('low');
    expect(classifyProbe(120)).toBe('low');
  });

  test('25 ≤ probeMs ≤ 60 → mid（含 25 / 60 边界）', () => {
    expect(classifyProbe(60)).toBe('mid');
    expect(classifyProbe(59)).toBe('mid');
    expect(classifyProbe(26)).toBe('mid');
    expect(classifyProbe(25)).toBe('mid');
    expect(classifyProbe(PROBE_LOW_THRESHOLD_MS)).toBe('mid');
    expect(classifyProbe(PROBE_HIGH_THRESHOLD_MS)).toBe('mid');
  });

  test('< 25ms → high（含 24 边界）', () => {
    expect(classifyProbe(24)).toBe('high');
    expect(classifyProbe(PROBE_HIGH_THRESHOLD_MS - 1)).toBe('high');
    expect(classifyProbe(1)).toBe('high');
  });

  test('无有效样本（null/undefined/NaN/0/负数）返回 null，交给优先级链下沉', () => {
    expect(classifyProbe(null)).toBeNull();
    expect(classifyProbe(undefined)).toBeNull();
    expect(classifyProbe(Number.NaN)).toBeNull();
    expect(classifyProbe(0)).toBeNull();
    expect(classifyProbe(-5)).toBeNull();
  });
});

describe('③ 优先级纯函数 resolveTierScore（override > modelTable > probe > adaptive > fallback）', () => {
  const base = { override: null, model: '', brand: '', probeMs: null, adaptive: null };

  test('override 最优先（无视其余全部线索）', () => {
    expect(
      resolveTierScore({ ...base, override: 'high', model: 'ALT-AL10', probeMs: 200 }),
    ).toEqual({ tier: 'high', source: 'override' });
  });

  test('机型表优先于微基准', () => {
    expect(
      resolveTierScore({ ...base, model: 'ALT-AL10', probeMs: 1, adaptive: 'low' }),
    ).toEqual({ tier: 'low', source: 'modelTable' });
  });

  test('微基准优先于 adaptive 修正', () => {
    expect(
      resolveTierScore({ ...base, model: 'UNKNOWN-X', probeMs: 80, adaptive: 'high' }),
    ).toEqual({ tier: 'low', source: 'probe' });
  });

  test('adaptive 优先于 fallback', () => {
    expect(resolveTierScore({ ...base, adaptive: 'low' })).toEqual({
      tier: 'low',
      source: 'adaptive',
    });
  });

  test('全部线索缺失 → fallback mid（不影响启动）', () => {
    expect(resolveTierScore(base)).toEqual({ tier: 'mid', source: 'fallback' });
    expect(FALLBACK_TIER).toBe('mid');
  });

  test('机型表查询：Model 命中（大小写不敏感）与 Brand 兜底', () => {
    expect(readModelTableTier('alt-al10', '')).toBe('low');
    expect(readModelTableTier('', 'ALT-AL10')).toBe('low');
    expect(readModelTableTier('NOT-IN-TABLE', '')).toBeNull();
    expect(Object.keys(LOW_END_MODEL_TABLE)).toContain('ALT-AL10');
  });
});

describe('④ MMKV 键名（版本化，便于将来失效重探）', () => {
  test('DEVICE_TIER_KEY === r38.deviceTier.v1', () => {
    expect(DEVICE_TIER_KEY).toBe('r38.deviceTier.v1');
  });
});

describe('⑤ 硬上限：≤300MB 且三档均不超（用户决策②）', () => {
  test('R38_CACHE_BUDGET_HARD_CAP === 300 * 1024 * 1024', () => {
    expect(R38_CACHE_BUDGET_HARD_CAP).toBe(300 * 1024 * 1024);
  });

  test('三档 cacheBudgetBytes ≤ 硬上限（含 low/mid/high）', () => {
    for (const tier of TIERS) {
      expect(TIER_PARAMS[tier].cacheBudgetBytes).toBeLessThanOrEqual(
        R38_CACHE_BUDGET_HARD_CAP,
      );
      expect(TIER_PARAMS[tier].cacheBudgetBytes).toBeGreaterThan(0);
    }
    expect(TIER_PARAMS.high.cacheBudgetBytes).toBe(R38_CACHE_BUDGET_HARD_CAP);
  });
});

describe('⑥ 自适应降档去抖：需 ADAPTIVE_CONFIRM_SESSIONS(3) 次会话确认', () => {
  test('样本累计不足 3 次不降档，只累计计数', () => {
    expect(ADAPTIVE_CONFIRM_SESSIONS).toBe(3);
    const first = resolveAdaptiveDowngrade('high', 'probe', 0, true);
    expect(first).toEqual({ tier: 'high', source: 'probe', samples: 1, downgraded: false });
    const second = resolveAdaptiveDowngrade('high', 'probe', 1, true);
    expect(second).toEqual({ tier: 'high', source: 'probe', samples: 2, downgraded: false });
  });

  test('第 3 次会话确认才降一档并转为 adaptive 真源（样本清零重新计）', () => {
    const third = resolveAdaptiveDowngrade('high', 'probe', 2, true);
    expect(third).toEqual({ tier: 'mid', source: 'adaptive', samples: 0, downgraded: true });
  });

  test('本会话无 jank 样本：不累计、不降档（防偶发误降）', () => {
    expect(resolveAdaptiveDowngrade('mid', 'probe', 2, false)).toEqual({
      tier: 'mid',
      source: 'probe',
      samples: 2,
      downgraded: false,
    });
  });

  test('已最低档不再降档（low 保持不变）', () => {
    expect(resolveAdaptiveDowngrade('low', 'adaptive', 2, true).downgraded).toBe(false);
    expect(downgradeTier('low')).toBe('low');
    expect(downgradeTier('mid')).toBe('low');
    expect(downgradeTier('high')).toBe('mid');
  });

  test('reportJankSample：低于 jank 阈值不产生样本', () => {
    __setTierForTests('high');
    reportJankSample(ADAPTIVE_JANK_MIN_COUNT - 1);
    expect(getState().tier).toBe('high');
    reportJankSample(0);
    expect(getState().tier).toBe('high');
  });
});

describe('⑦ 读取路径：getTier/getParams 同步零成本 + 档位生效数值', () => {
  test('未探测/重置后回落 mid 档参数（不影响启动）', () => {
    expect(getTier()).toBe('mid');
    expect(getParams().cacheBudgetBytes).toBe(192 * 1024 * 1024);
  });

  test('低端机档位：cacheBudgetBytes 96MB / preloadSpan 2（T01 验收口径）', () => {
    __setTierForTests('low');
    const params = getParams();
    expect(params.cacheBudgetBytes).toBe(96 * 1024 * 1024);
    expect(params.preloadSpan).toBe(2);
  });

  test('高档位：300MB / preloadSpan 4', () => {
    __setTierForTests('high');
    expect(getParams().cacheBudgetBytes).toBe(300 * 1024 * 1024);
    expect(getParams().preloadSpan).toBe(4);
  });

  test('灰度开关 R38_TIER_PARAMS 默认开启（关闭时全 mid，矩阵随即失效）', () => {
    expect(R38_TIER_PARAMS).toBe(true);
  });
});

describe('⑧ 探测端到端：机型表命中立即生效；无结论回落 mid', () => {
  test('ALT-AL10 机型指数字命 → tier=low / src=modelTable（会话内立即生效）', async () => {
    const state = await probeAndPersist();
    expect(state.tier).toBe('low');
    expect(state.source).toBe('modelTable');
    expect(state.model).toBe('ALT-AL10');
    expect(getTier()).toBe('low');
    expect(getParams().cacheBudgetBytes).toBe(96 * 1024 * 1024);
  });

  test('probeAndPersist 幂等（同会话只跑一次）且微基准返回有限值或 null', async () => {
    const first = await probeAndPersist();
    const second = await probeAndPersist();
    expect(second.capturedAt).toBe(first.capturedAt);
    const probeMs = runMicroProbe();
    // ★ 2026-10-09 去 flake：原断言为 `probeMs > 0`，但 `runProbeRound` 返回
    //   `Date.now() - t0`（整数毫秒）——整块在亚毫秒内跑完时**合法返回 0**
    //   ⇒ 同一份代码既可红又可绿（实测：全量套一次红、复跑一次绿），无判据价值。
    //   改为①语义判据（有限值或 null）+②**非计时**判据（探测确实执行了计算）。
    expect(probeMs === null || (Number.isFinite(probeMs) && probeMs >= 0)).toBe(true);
    expect(probeSink).toBeGreaterThan(0);
  });

  test('档位探测只读内置能力：模块不引入任何第三方依赖（源码断言）', () => {
    const src = readFileSync(
      resolve(__dirname, '../services/DeviceTierService.ts'),
      'utf8',
    );
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThanOrEqual(2);
    for (const line of imports) {
      // 仅允许内置两依赖：react-native（Platform/Dimensions/PixelRatio）与
      // react-native-mmkv（持久化）——「禁止引入任何新依赖」的硬约束
      expect(line).toMatch(/from '(react-native|react-native-mmkv)';/);
    }
    // Platform.constants 走「未知形状」防御读取（类型安全 + 老版本兜底）
    expect(src).toMatch(/Platform as unknown as \{ constants\?: Record<string, unknown> \}/);
    expect(src).toMatch(/Dimensions\?\.get\?\.\('window'\)/);
    expect(src).toMatch(/PixelRatio\?\.get\?\.\(\)/);
  });
});

describe('⑨ 设置页覆盖（override 优先且可恢复自动）', () => {
  test('setOverride(tier) 立即使会话档位切换为 override 真源', () => {
    setOverride('high');
    expect(getTier()).toBe('high');
    expect(getState().source).toBe('override');
    expect(getParams().cacheBudgetBytes).toBe(300 * 1024 * 1024);
  });

  test('setOverride(null) 恢复自动（回落 fallback mid）', () => {
    setOverride('low');
    expect(getTier()).toBe('low');
    setOverride(null);
    expect(getTier()).toBe(FALLBACK_TIER);
  });

  test('非法值被忽略（null 语义）', () => {
    setOverride('ultra' as unknown as DeviceTier);
    expect(getTier()).toBe(FALLBACK_TIER);
  });
});

describe('⑩ 聚合导出（调用方以 DeviceTierService.xxx 取用）', () => {
  test('设备档位服务聚合对象包含全部公开方法', () => {
    expect(typeof DeviceTierService.getTier).toBe('function');
    expect(typeof DeviceTierService.getParams).toBe('function');
    expect(typeof DeviceTierService.probeAndPersist).toBe('function');
    expect(typeof DeviceTierService.reportJankSample).toBe('function');
    expect(typeof DeviceTierService.setOverride).toBe('function');
    expect(typeof DeviceTierService.getState).toBe('function');
    expect(typeof DeviceTierService.__setTierForTests).toBe('function');
  });
});
