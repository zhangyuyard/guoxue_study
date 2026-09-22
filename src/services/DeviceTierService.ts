/**
 * 设备档位分级服务（r38 T01 · 档位探测 / 参数矩阵 / 常量外置的唯一出处）
 *
 * 设计（见 deliverables/software-company/guoxue-r38-preload-architecture.md §2.1 / §6）：
 *  - 三档 low/mid/high，参数矩阵 TIER_PARAMS 是**唯一常量出处**（§6.2），
 *    其余模块（装配调度器 / 章级缓存 / 注音补渲染）只经 getParams() 读取；
 *  - 探测三步（**零新依赖**）：① 静态机型指纹（Platform.constants.Brand/
 *    Manufacturer/Model/Version）② 启动期确定性微基准（首帧后的延后任务里跑，
 *    整块预算 ≤120ms，第 1 轮丢弃以避开 Hermes JIT 预热）③ 自适应降档
 *    （复用既有 [PERF][jank] 心跳，3 次会话确认才落盘）；
 *  - 优先级：override > 机型表 > 微基准 > adaptive 修正 > fallback('mid')；
 *  - 读取路径零成本：getTier()/getParams() 为内存读（持久化在模块加载时
 *    一次性水合），未探测时返回 'mid' 兜底，不影响启动；
 *  - 会话内冻结：**测量型判定**（probe/adaptive）只落盘供下个会话生效，
 *    避免运行中参数漂移导致行为不可复现；**确定性判定**（机型表命中 /
 *    用户 override）立即生效（机型指纹是静态事实，覆盖是显式用户意图，
 *    二者不引入漂移；同时满足验收「ALT-AL10 首会话即 tier=low」）。
 */
import { Dimensions, PixelRatio, Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

// ============ 公开类型（与架构 §2.1 签名级一致） ============

export type DeviceTier = 'low' | 'mid' | 'high';

export type DeviceTierSource =
  | 'probe'
  | 'modelTable'
  | 'override'
  | 'adaptive'
  | 'fallback';

/** 档位参数矩阵（每个字段都必须有 low/mid/high 三档取值，禁止单值） */
export interface TierParams {
  /** 跳章双向预热章数（每方向） */
  preloadSpan: number;
  /** 拼接序列章数上限（与 seqBudgetBytes 取较小约束） */
  maxContinuousChapters: number;
  /** 拼接序列字节预算 */
  seqBudgetBytes: number;
  /** 章级缓存驻留预算（≤300MB） */
  cacheBudgetBytes: number;
  /** 单章字节预算上限：超此值的巨章不进入拼接序列（仍可单章阅读） */
  singleChapterMaxBytes: number;
  /** 装配时间片 / 让出 / 读批（FILL_* 的档位化） */
  fillTimeBudgetMs: number;
  fillYieldMs: number;
  fillReadChunkBytes: number;
  fillNotifyThrottleMs: number;
  /** 空闲扩散节奏 */
  idleDiffuseIntervalMs: number;
  idleDiffuseBatch: number;
  /** 书序兜底启动延迟（仅长时间空闲） */
  bookOrderFallbackIdleMs: number;
  /** 边界前就绪预留时间（进入预载窗即提权请求） */
  readyLeadMs: number;
  /** 注音补渲染 */
  pinyinSettleMs: number;
  pinyinBatchRows: number;
  pinyinBatchIntervalMs: number;
  pinyinPreludeRows: number;
  /** 视口锚点精修的布局帧预算（取代墙钟正确性依赖） */
  anchorMaxFrames: number;
  /** 饥饿保护阈值（决策要求 10s） */
  starvationMs: number;
  /** 装配活跃时 FTS 队列让路时长 */
  ftsYieldMs: number;
}

export interface DeviceTierState {
  tier: DeviceTier;
  source: DeviceTierSource;
  /** 微基准原始耗时（ms，越小越快）；机型表/兜底路径为 null */
  probeMs: number | null;
  /** 机型指纹（Platform.constants.Model / Brand / Manufacturer） */
  model: string;
  brand: string;
  /** 自适应降档累计样本（供去抖） */
  adaptiveSamples: number;
  capturedAt: number;
}

export interface DeviceTierService {
  /** 同步读取（读者路径零成本）：已持久化则直接返回；未探测则返回 fallback 档（mid）并异步补齐 */
  getTier(): DeviceTier;
  /** 同步读取整个参数矩阵（读者路径唯一入口；禁止各处散读常量） */
  getParams(): TierParams;
  /** 启动延后任务调用：跑微基准 + 机型表 → 落 MMKV。幂等（同会话只跑一次） */
  probeAndPersist(): Promise<DeviceTierState>;
  /** 复用心跳探针：冷启动窗口内的 jank 计数上报（带去抖，3 次会话确认才降档） */
  reportJankSample(jankCount: number): void;
  /** 设置页覆盖：null = 恢复自动 */
  setOverride(tier: DeviceTier | null): void;
  /** 诊断（[PERF][tier] 日志与测试用） */
  getState(): DeviceTierState;
  /** 仅测试：注入探测结果 / 重置模块态（传 null 清持久化并回落 mid） */
  __setTierForTests(tier: DeviceTier | null): void;
}

/** MMKV key：版本化，便于将来失效重探 */
export const DEVICE_TIER_KEY = 'r38.deviceTier.v1';

/** 硬上限（用户决策②：章级缓存驻留预算 ≤300MB，三档均不得超） */
export const R38_CACHE_BUDGET_HARD_CAP = 300 * 1024 * 1024;

/** 【灰度开关】档位参数矩阵 vs 固定常量：false → 全部使用 mid 档（等价现状数值） */
export const R38_TIER_PARAMS = true;

/** 兜底档位：未探测 / 探测失败 / 参数矩阵关闭时统一取 mid（等价 r37 现状数值） */
export const FALLBACK_TIER: DeviceTier = 'mid';

/** 微基准轮数（第 1 轮丢弃以避开 Hermes JIT 预热） */
export const PROBE_ROUNDS = 3;
/** 微基准整块时间预算（ms）：超预算立即中止，已跑轮次仍可用 */
export const PROBE_BUDGET_MS = 120;
/** 微基准阈值（首轮真机数据后可调）：>60 low | 25~60 mid | <25 high */
export const PROBE_LOW_THRESHOLD_MS = 60;
export const PROBE_HIGH_THRESHOLD_MS = 25;
/** 微基准固定工作负载规模（与阅读器真实成本同构：字格逐码点 / 行拼接 / 读音表查询） */
export const PROBE_WORKLOAD_CHARS = 20_000;
export const PROBE_JOIN_EVERY = 8;
export const PROBE_MAP_LOOKUPS = 20_000;

/** 自适应降档：冷启动 0~30s 窗口内 jankCount（gap≥300 的次数）阈值 */
export const ADAPTIVE_JANK_WINDOW_MS = 30_000;
export const ADAPTIVE_JANK_MIN_COUNT = 3;
/** 同类样本累计 3 次会话确认后才落盘（防偶发误降） */
export const ADAPTIVE_CONFIRM_SESSIONS = 3;

/**
 * 已知低端机型表（静态指纹命中即判定，先保守：仅收确定性低端机；
 * 首次真机 [PERF][tier] 数据后可扩充/校准）。
 */
export const LOW_END_MODEL_TABLE: Readonly<Record<string, DeviceTier>> = {
  'ALT-AL10': 'low',
  'ALT-AL00': 'low',
  'JKM-AL00': 'low',
  'MED-AL00': 'low',
  'DUB-AL00': 'low',
  'SNE-AL00': 'low',
  'HMA-AL00': 'low',
};

// ============ 参数矩阵（§6.2，唯一常量出处） ============

const MB = 1024 * 1024;
const KB = 1024;

/** 三档参数矩阵（§6.2 逐字段照抄；矩阵改动即全链路预算/窗口/让出参数改动） */
export const TIER_PARAMS: Readonly<Record<DeviceTier, TierParams>> = Object.freeze({
  low: Object.freeze({
    preloadSpan: 2,
    maxContinuousChapters: 12,
    seqBudgetBytes: 8 * MB,
    cacheBudgetBytes: 96 * MB,
    singleChapterMaxBytes: 2 * MB,
    fillTimeBudgetMs: 8,
    fillYieldMs: 24,
    fillReadChunkBytes: 32 * KB,
    fillNotifyThrottleMs: 2000,
    idleDiffuseIntervalMs: 1200,
    idleDiffuseBatch: 1,
    bookOrderFallbackIdleMs: 60_000,
    readyLeadMs: 1200,
    pinyinSettleMs: 600,
    pinyinBatchRows: 6,
    pinyinBatchIntervalMs: 32,
    pinyinPreludeRows: 4,
    anchorMaxFrames: 40,
    starvationMs: 10_000,
    ftsYieldMs: 30_000,
  }),
  mid: Object.freeze({
    preloadSpan: 3,
    maxContinuousChapters: 20,
    seqBudgetBytes: 16 * MB,
    cacheBudgetBytes: 192 * MB,
    singleChapterMaxBytes: 4 * MB,
    fillTimeBudgetMs: 12,
    fillYieldMs: 16,
    fillReadChunkBytes: 64 * KB,
    fillNotifyThrottleMs: 1500,
    idleDiffuseIntervalMs: 900,
    idleDiffuseBatch: 1,
    bookOrderFallbackIdleMs: 45_000,
    readyLeadMs: 900,
    pinyinSettleMs: 450,
    pinyinBatchRows: 8,
    pinyinBatchIntervalMs: 24,
    pinyinPreludeRows: 6,
    anchorMaxFrames: 30,
    starvationMs: 10_000,
    ftsYieldMs: 30_000,
  }),
  high: Object.freeze({
    preloadSpan: 4,
    maxContinuousChapters: 30,
    seqBudgetBytes: 32 * MB,
    cacheBudgetBytes: 300 * MB,
    singleChapterMaxBytes: 8 * MB,
    fillTimeBudgetMs: 12,
    fillYieldMs: 16,
    fillReadChunkBytes: 64 * KB,
    fillNotifyThrottleMs: 1500,
    idleDiffuseIntervalMs: 700,
    idleDiffuseBatch: 2,
    bookOrderFallbackIdleMs: 30_000,
    readyLeadMs: 700,
    pinyinSettleMs: 350,
    pinyinBatchRows: 12,
    pinyinBatchIntervalMs: 16,
    pinyinPreludeRows: 8,
    anchorMaxFrames: 24,
    starvationMs: 10_000,
    ftsYieldMs: 30_000,
  }),
});

// ============ 纯函数（可被 jest 直接单测，无 RN 依赖） ============

/** 阈值纯函数：微基准耗时 → 档位（无有效样本返回 null，交由优先级链兜底） */
export function classifyProbe(probeMs: number | null | undefined): DeviceTier | null {
  if (typeof probeMs !== 'number' || !Number.isFinite(probeMs) || probeMs <= 0) {
    return null;
  }
  if (probeMs > PROBE_LOW_THRESHOLD_MS) {
    return 'low';
  }
  if (probeMs >= PROBE_HIGH_THRESHOLD_MS) {
    return 'mid';
  }
  return 'high';
}

/** 档位优先级输入（resolveTierScore 入参） */
export interface TierScoreInput {
  /** 设置页覆盖（null = 自动） */
  override: DeviceTier | null;
  /** 机型指纹（Platform.constants.Model 等） */
  model: string;
  brand: string;
  /** 微基准原始耗时（ms）；未跑/null = 无结论 */
  probeMs: number | null;
  /** 上一次会话确认的自适应降档结论（去抖通过后的候选档） */
  adaptive: DeviceTier | null;
}

/** 档位判定结论 */
export interface TierScore {
  tier: DeviceTier;
  source: DeviceTierSource;
}

/**
 * 优先级纯函数：override > 机型表 > 微基准 > adaptive > fallback('mid')。
 * 与架构 §2.1「④ 优先级」逐条对应；任一步无结论即下沉到下一步。
 */
export function resolveTierScore(input: TierScoreInput): TierScore {
  if (input.override) {
    return { tier: input.override, source: 'override' };
  }
  const fingerprint = readModelTableTier(input.model, input.brand);
  if (fingerprint) {
    return { tier: fingerprint, source: 'modelTable' };
  }
  const probed = classifyProbe(input.probeMs);
  if (probed) {
    return { tier: probed, source: 'probe' };
  }
  if (input.adaptive) {
    return { tier: input.adaptive, source: 'adaptive' };
  }
  return { tier: FALLBACK_TIER, source: 'fallback' };
}

/** 机型表查询纯函数：Model 优先，其次 Brand/Manufacturer 组合（未命中返回 null） */
export function readModelTableTier(model: string, brand: string): DeviceTier | null {
  const modelKey = (model ?? '').trim().toUpperCase();
  if (modelKey && LOW_END_MODEL_TABLE[modelKey]) {
    return LOW_END_MODEL_TABLE[modelKey];
  }
  const brandKey = (brand ?? '').trim().toUpperCase();
  if (brandKey && LOW_END_MODEL_TABLE[brandKey]) {
    return LOW_END_MODEL_TABLE[brandKey];
  }
  return null;
}

/** 降档一档（high→mid→low；已最低返回原档） */
export function downgradeTier(tier: DeviceTier): DeviceTier {
  if (tier === 'high') {
    return 'mid';
  }
  if (tier === 'mid') {
    return 'low';
  }
  return 'low';
}

/** 自适应降档去抖纯函数：3 次会话确认后才真正降档（防偶发误降） */
export interface AdaptiveDecision {
  /** 落盘/生效的档位 */
  tier: DeviceTier;
  source: DeviceTierSource;
  /** 累计样本（会话数） */
  samples: number;
  /** 本次是否真正降档（false = 仅累计样本，档位不变） */
  downgraded: boolean;
}

export function resolveAdaptiveDowngrade(
  currentTier: DeviceTier,
  source: DeviceTierSource,
  samplesSoFar: number,
  jankObservedInSession: boolean,
): AdaptiveDecision {
  const base = Math.max(0, Math.floor(samplesSoFar));
  if (!jankObservedInSession) {
    return { tier: currentTier, source, samples: base, downgraded: false };
  }
  if (currentTier === 'low') {
    // 已最低档：样本不再累计（无更低档可降），避免无意义写盘
    return { tier: 'low', source, samples: base, downgraded: false };
  }
  const samples = base + 1;
  if (samples < ADAPTIVE_CONFIRM_SESSIONS) {
    return { tier: currentTier, source, samples, downgraded: false };
  }
  return {
    tier: downgradeTier(currentTier),
    source: 'adaptive',
    samples: 0,
    downgraded: true,
  };
}

/** 数值兜底：非有限数/非正数回落默认值（参数矩阵读取失败时的统一护栏） */
export function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// ============ 模块态（内存缓存 + MMKV 持久化） ============

/** 持久化载荷（单 key 内自带版本与 override，便于将来失效重探） */
interface PersistedTierPayload {
  v: 1;
  state: DeviceTierState;
  override: DeviceTier | null;
}

const MODULE_TIER_FALLBACK: DeviceTierState = {
  tier: FALLBACK_TIER,
  source: 'fallback',
  probeMs: null,
  model: '',
  brand: '',
  adaptiveSamples: 0,
  capturedAt: 0,
};

let storage: MMKV | null = null;
let storageInitialized = false;
/** 会话内生效档位（冻结：只由确定性判定或探测落盘后的下个会话变更） */
let sessionState: DeviceTierState = { ...MODULE_TIER_FALLBACK };
/** 设置页覆盖（null = 自动） */
let overrideTier: DeviceTier | null = null;
/** 已探测标记：probeAndPersist 幂等（同会话只跑一次） */
let probedThisSession = false;

function isTier(value: unknown): value is DeviceTier {
  return value === 'low' || value === 'mid' || value === 'high';
}

function isSource(value: unknown): value is DeviceTierSource {
  return (
    value === 'probe' ||
    value === 'modelTable' ||
    value === 'override' ||
    value === 'adaptive' ||
    value === 'fallback'
  );
}

function getStorage(): MMKV | null {
  if (storageInitialized) {
    return storage;
  }
  storageInitialized = true;
  try {
    storage = new MMKV();
  } catch {
    storage = null; // MMKV 不可用：纯内存档位，不影响启动
  }
  return storage;
}

function readPersisted(): PersistedTierPayload | null {
  const kv = getStorage();
  if (!kv) {
    return null;
  }
  try {
    const raw = kv.getString(DEVICE_TIER_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedTierPayload;
    if (!parsed || parsed.v !== 1 || !parsed.state || !isTier(parsed.state.tier)) {
      return null;
    }
    const state: DeviceTierState = {
      tier: parsed.state.tier,
      source: isSource(parsed.state.source) ? parsed.state.source : 'fallback',
      probeMs:
        typeof parsed.state.probeMs === 'number' && Number.isFinite(parsed.state.probeMs)
          ? parsed.state.probeMs
          : null,
      model: typeof parsed.state.model === 'string' ? parsed.state.model : '',
      brand: typeof parsed.state.brand === 'string' ? parsed.state.brand : '',
      adaptiveSamples: Number.isFinite(parsed.state.adaptiveSamples)
        ? Math.max(0, Math.floor(parsed.state.adaptiveSamples))
        : 0,
      capturedAt: Number.isFinite(parsed.state.capturedAt) ? parsed.state.capturedAt : 0,
    };
    return {
      v: 1,
      state,
      override: isTier(parsed.override) ? parsed.override : null,
    };
  } catch {
    return null; // 损坏载荷：按未探测处理（下次探测覆盖）
  }
}

function writePersisted(payload: PersistedTierPayload): void {
  const kv = getStorage();
  if (!kv) {
    return;
  }
  try {
    kv.set(DEVICE_TIER_KEY, JSON.stringify(payload));
  } catch {
    // 落盘失败不影响会话内行为
  }
}

/** 模块加载即水合持久化档位（同步、微秒级）：getTier/getParams 因此零成本 */
function hydrateFromPersistence(): void {
  const persisted = readPersisted();
  if (!persisted) {
    return;
  }
  sessionState = persisted.state; // 会话冻结的「探测结论」（不含 override）
  overrideTier = persisted.override;
}
hydrateFromPersistence();

// ============ 探测（机型指纹 + 微基准；只读内置能力，零新依赖） ============

function readPlatformConstant(key: string): string {
  try {
    const constants = (Platform as unknown as { constants?: Record<string, unknown> })
      .constants;
    const value = constants?.[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 屏幕信息探针（仅用于日志可复现性；不参与判定） */
function readScreenInfo(): string {
  try {
    const win = Dimensions?.get?.('window');
    const ratio = PixelRatio?.get?.();
    if (!win) {
      return `px=${typeof ratio === 'number' ? ratio : '-'}`;
    }
    return `screen=${Math.round(win.width)}x${Math.round(win.height)} px=${ratio ?? '-'}`;
  } catch {
    return 'screen=- px=-';
  }
}

/** 微基准固定工作负载样例文本（20k 码点，构建期一次，不进热循环） */
const PROBE_SAMPLE_TEXT: string = (() => {
  const pool = '国学经典诵读文本样例字词句章句读注音通假异体';
  let text = '';
  while (text.length < PROBE_WORKLOAD_CHARS) {
    text += pool;
  }
  return text.slice(0, PROBE_WORKLOAD_CHARS);
})();

/** 读音表（微基准 W3 用；构建期一次，规模 3k 量级 ≈ 通假/多音字表） */
const PROBE_LOOKUP_TABLE: Map<string, number> = (() => {
  const table = new Map<string, number>();
  for (let i = 0; i < PROBE_SAMPLE_TEXT.length; i += 1) {
    table.set(PROBE_SAMPLE_TEXT[i], i);
  }
  return table;
})();

/** 探测结果沉淀（防 V8/Hermes 把纯计算优化掉；导出供测试观察返回值确实被消费） */
export let probeSink = 0;

/** 单轮微基准：W1 逐码点迭代 + W2 每 8 码点 join + W3 读音表 Map.get */
function runProbeRound(): number {
  const t0 = Date.now();
  const codes = Array.from(PROBE_SAMPLE_TEXT);
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += PROBE_JOIN_EVERY) {
    parts.push(codes.slice(i, i + PROBE_JOIN_EVERY).join(''));
  }
  let hits = 0;
  for (let i = 0; i < PROBE_MAP_LOOKUPS; i += 1) {
    const ch = codes[i % codes.length];
    if (PROBE_LOOKUP_TABLE.get(ch) !== undefined) {
      hits += 1;
    }
  }
  probeSink = hits + parts.length;
  return Date.now() - t0;
}

/**
 * 微基准：跑 PROBE_ROUNDS 轮，第 1 轮丢弃（JIT 预热），取后 2 轮平均。
 * 整块受 PROBE_BUDGET_MS 约束（超预算立即中止并使用已跑轮次）。
 */
export function runMicroProbe(): number | null {
  const started = Date.now();
  const samples: number[] = [];
  for (let round = 0; round < PROBE_ROUNDS; round += 1) {
    if (round > 0 && Date.now() - started > PROBE_BUDGET_MS) {
      break; // 极慢设备：不再追加轮次（整块预算护栏）
    }
    const ms = runProbeRound();
    if (round > 0) {
      samples.push(ms); // 第 1 轮丢弃
    }
  }
  if (samples.length === 0) {
    return null;
  }
  let total = 0;
  for (const ms of samples) {
    total += ms;
  }
  return total / samples.length;
}

// ============ 公开 API ============

/**
 * 会话内生效档位 = 探测结论（sessionState，会话内冻结）叠加设置页 override。
 * override 是显式用户意图（确定性判定）→ 立即生效；
 * 探测结论只在确定性来源（机型表）命中时才在会话内替换（见 probeAndPersist）。
 */
function effectiveState(): DeviceTierState {
  if (!overrideTier) {
    return sessionState;
  }
  return { ...sessionState, tier: overrideTier, source: 'override' };
}

/** 同步读取当前会话生效档位（未探测/参数矩阵关闭 → mid 兜底） */
export function getTier(): DeviceTier {
  if (!R38_TIER_PARAMS) {
    return FALLBACK_TIER;
  }
  return effectiveState().tier;
}

/** 同步读取参数矩阵（读者路径唯一入口；参数矩阵关闭 → 全 mid） */
export function getParams(): TierParams {
  return TIER_PARAMS[R38_TIER_PARAMS ? getTier() : FALLBACK_TIER];
}

/** 诊断快照（[PERF][tier] 日志与测试用；含 override 后的生效档位） */
export function getState(): DeviceTierState {
  return { ...effectiveState() };
}

/**
 * 启动延后任务：机型指纹 + 微基准 → 判定 → 落 MMKV（下个会话生效的冻结语义）。
 * 幂等（同会话只跑一次）；任何异常都回落 mid 且不影响启动。
 * 落盘的 state 恒为**纯探测结论**（不含 override），override 单独持久化——
 * 这样「设置页切回自动」能立刻恢复真实探测档位。
 */
export async function probeAndPersist(): Promise<DeviceTierState> {
  if (probedThisSession) {
    return getState();
  }
  probedThisSession = true;
  const model = readPlatformConstant('Model');
  const brand =
    readPlatformConstant('Brand') || readPlatformConstant('Manufacturer');
  let probeMs: number | null = null;
  try {
    probeMs = runMicroProbe();
  } catch {
    probeMs = null; // 微基准异常：走机型表/adaptive/fallback
  }
  const persisted = readPersisted();
  const adaptiveCandidate =
    persisted && persisted.state.source === 'adaptive' ? persisted.state.tier : null;
  let score: TierScore;
  try {
    score = resolveTierScore({
      override: null, // 纯探测结论（override 单独持久化，不污染探测真值）
      model,
      brand,
      probeMs,
      adaptive: adaptiveCandidate,
    });
  } catch {
    score = { tier: FALLBACK_TIER, source: 'fallback' };
  }
  const detection: DeviceTierState = {
    tier: score.tier,
    source: score.source,
    probeMs,
    model,
    brand,
    adaptiveSamples: persisted?.state.adaptiveSamples ?? 0,
    capturedAt: Date.now(),
  };
  writePersisted({ v: 1, state: detection, override: overrideTier });
  // 会话内冻结：确定性判定（机型表命中）立即生效；测量型判定
  // （probe / adaptive）仅落盘供下个会话生效（防参数运行中漂移、行为不可复现）。
  const deterministic = score.source === 'modelTable';
  if (deterministic) {
    sessionState = detection;
  } else {
    sessionState = {
      ...sessionState,
      probeMs,
      model,
      brand,
      capturedAt: detection.capturedAt,
    };
  }
  const effective = effectiveState();
  console.info(
    `[PERF][tier] tier=${effective.tier} score=${probeMs === null ? 'n/a' : Math.round(probeMs)} ` +
      `src=${effective.source} model=${model || '-'} probe=${score.tier}/${score.source} ` +
      `${readScreenInfo()}`,
  );
  return getState();
}

/**
 * 冷启动 0~30s 窗口内的 jank 计数上报（复用 [PERF][jank] 心跳）。
 * 去抖：同类样本累计 ADAPTIVE_CONFIRM_SESSIONS（3）次会话确认才降一档落盘。
 */
export function reportJankSample(jankCount: number): void {
  try {
    if (!Number.isFinite(jankCount) || jankCount <= 0) {
      return;
    }
    if (jankCount < ADAPTIVE_JANK_MIN_COUNT) {
      return;
    }
    const persisted = readPersisted();
    const currentTier = persisted?.state.tier ?? sessionState.tier;
    const currentSource = persisted?.state.source ?? sessionState.source;
    if (currentTier === 'low') {
      return; // 已最低档：不再累计样本
    }
    const decision = resolveAdaptiveDowngrade(
      currentTier,
      currentSource,
      persisted?.state.adaptiveSamples ?? 0,
      true,
    );
    const nextState: DeviceTierState = {
      ...(persisted?.state ?? sessionState),
      tier: decision.tier,
      source: decision.source,
      adaptiveSamples: decision.samples,
      capturedAt: Date.now(),
    };
    writePersisted({ v: 1, state: nextState, override: overrideTier });
    if (decision.downgraded) {
      // 3 次会话确认通过：落盘 + 会话内降档（降档方向单一，不引入参数漂移风险）
      sessionState = { ...nextState };
      console.info(
        `[PERF][tier] adaptive-down tier=${nextState.tier} jank=${jankCount} sessions=${ADAPTIVE_CONFIRM_SESSIONS}`,
      );
    } else {
      console.info(
        `[PERF][tier] adaptive-sample jank=${jankCount} sessions=${decision.samples}/${ADAPTIVE_CONFIRM_SESSIONS}`,
      );
    }
  } catch {
    // 上报失败不影响启动/阅读
  }
}

/** 设置页覆盖：null = 恢复自动。覆盖是显式用户意图 → 立即生效并落盘（独立字段） */
export function setOverride(tier: DeviceTier | null): void {
  try {
    const next = isTier(tier) ? tier : null;
    if (next === overrideTier && probedThisSession) {
      return; // 幂等：同值不重复写盘
    }
    overrideTier = next;
    // 探测结论（sessionState）保持不变：切回「自动」即刻恢复真探测档位
    writePersisted({ v: 1, state: sessionState, override: next });
    const effective = effectiveState();
    console.info(
      `[PERF][tier] override tier=${next ?? 'auto'} src=${effective.source} ` +
        `effective=${effective.tier}`,
    );
  } catch {
    // 设置失败不影响会话
  }
}

/** 仅测试：注入探测结果 / 重置模块态（`null` = 清持久化 + 回落 mid） */
export function __setTierForTests(tier: DeviceTier | null): void {
  if (tier === null) {
    overrideTier = null;
    probedThisSession = false;
    sessionState = { ...MODULE_TIER_FALLBACK };
    const kv = getStorage();
    try {
      kv?.delete(DEVICE_TIER_KEY);
    } catch {
      // 测试态清理失败可忽略
    }
    return;
  }
  probedThisSession = true;
  sessionState = {
    ...sessionState,
    tier,
    source: 'probe',
    capturedAt: Date.now(),
  };
}

/** 聚合导出（与 UserBookService 同风格：调用方以 DeviceTierService.xxx 取用） */
export const DeviceTierService: DeviceTierService = {
  getTier,
  getParams,
  probeAndPersist,
  reportJankSample,
  setOverride,
  getState,
  __setTierForTests,
};

export default DeviceTierService;
