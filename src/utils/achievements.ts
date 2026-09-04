/**
 * 成就系统纯函数模块（P2-06，本地版）
 * 只依赖结构化最小接口（completedAt 字符串数组、bookId 字符串数组、两个计数），
 * 不 import store 类型，避免耦合（与 utils/dailyGoal 同一套路）。
 *
 * 时区口径：连续打卡的日期边界按「本地时区」的日历日切分（与 dailyGoal 一致），
 * 不使用 UTC 切日，避免跨时区设备上「今天」错位。
 */

/** pad2（本地日期键拼接用） */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Date → 本地时区日历日键「YYYY-MM-DD」 */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 成就分类：recitation=累计背诵段数 / streak=连续打卡天数 / bookmark=收藏数 / note=笔记数 / coverage=覆盖书籍数 */
export type AchievementCategory =
  | 'recitation'
  | 'streak'
  | 'bookmark'
  | 'note'
  | 'coverage';

/** 单条成就定义 */
export interface AchievementDef {
  /** 成就唯一 id（持久化解锁记录的 key，发布后不可更改） */
  id: string;
  /** 成就名称 */
  name: string;
  /** 达成条件描述（未解锁时展示） */
  description: string;
  /** 图标（emoji 字符，避免引入图标库依赖） */
  icon: string;
  /** 达成阈值（对应分类下的指标值） */
  threshold: number;
  /** 成就分类（决定与哪个指标比较） */
  category: AchievementCategory;
}

/**
 * 成就定义表（13 项）。
 * 覆盖书籍口径：list 中去重 bookId 计数，全库内置书共 10 部，故上限阈值取 10。
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // —— 累计背诵段数 ——
  { id: 'recite-10', name: '初诵十段', description: '累计背诵完成 10 段', icon: '🎋', threshold: 10, category: 'recitation' },
  { id: 'recite-50', name: '诵至五十', description: '累计背诵完成 50 段', icon: '📚', threshold: 50, category: 'recitation' },
  { id: 'recite-100', name: '背诵百段', description: '累计背诵完成 100 段', icon: '🏮', threshold: 100, category: 'recitation' },
  { id: 'recite-300', name: '背诵三百段', description: '累计背诵完成 300 段', icon: '🏆', threshold: 300, category: 'recitation' },
  // —— 连续打卡天数 ——
  { id: 'streak-3', name: '初养习惯', description: '连续 3 天完成背诵', icon: '🌱', threshold: 3, category: 'streak' },
  { id: 'streak-7', name: '周而复始', description: '连续 7 天完成背诵', icon: '🔥', threshold: 7, category: 'streak' },
  { id: 'streak-21', name: '廿一日功', description: '连续 21 天完成背诵', icon: '⛰️', threshold: 21, category: 'streak' },
  { id: 'streak-60', name: '六十日恒', description: '连续 60 天完成背诵', icon: '🌟', threshold: 60, category: 'streak' },
  // —— 收藏数 ——
  { id: 'bookmark-10', name: '收藏十则', description: '累计收藏 10 条', icon: '⭐', threshold: 10, category: 'bookmark' },
  { id: 'bookmark-50', name: '收藏五十则', description: '累计收藏 50 条', icon: '🌠', threshold: 50, category: 'bookmark' },
  // —— 笔记数 ——
  { id: 'note-10', name: '笔记十条', description: '累计撰写 10 条笔记', icon: '🖋️', threshold: 10, category: 'note' },
  // —— 覆盖书籍数（全库 10 部内置书） ——
  { id: 'coverage-5', name: '博览五书', description: '在 5 部书中完成过背诵', icon: '🏛️', threshold: 5, category: 'coverage' },
  { id: 'coverage-10', name: '十部全览', description: '在全部 10 部书中完成过背诵', icon: '👑', threshold: 10, category: 'coverage' },
];

/** 成就总数（「我的成就 x/总数」入口角标用） */
export const ACHIEVEMENT_TOTAL = ACHIEVEMENTS.length;

/**
 * 评估成就用的结构化快照（最小接口，不耦合 store 类型）。
 */
export interface AchievementSnapshot {
  /** 已完成背诵的时间戳列表（每完成一段一条，缺失/非法项容错跳过） */
  completedAt: readonly string[];
  /** 出现过背诵记录的 bookId 列表（去重计数，重复不敏感） */
  bookIds: readonly string[];
  /** 当前收藏条数 */
  bookmarkCount: number;
  /** 当前笔记条数 */
  noteCount: number;
  /** 「今天」（由调用方传入，纯函数不取系统时间，便于测试） */
  today: Date;
}

/**
 * 计算连续打卡天数。
 * 口径（宽容口径，防「晚上背完隔天看断了签」的挫败感）：
 *   - 今天背了 → 从今天往回数；
 *   - 今天没背 → 从昨天往回数（今天没背不断签）；
 *   - 今天昨天都没背 → 0。
 * 日期切分按本地时区日历日；重复日期按去重后的集合计（同一天背多段只算一天）；
 * 非法/无法解析的日期字符串跳过。
 */
export function computeStreak(dates: readonly string[], today: Date): number {
  const daySet = new Set<string>();
  for (const raw of dates) {
    if (typeof raw !== 'string' || raw === '') {
      continue;
    }
    const ts = Date.parse(raw);
    if (Number.isNaN(ts)) {
      continue;
    }
    daySet.add(localDayKey(new Date(ts)));
  }

  // 起点：今天有记录用今天，否则用昨天；都没有则直接 0
  const todayKey = localDayKey(today);
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  if (!daySet.has(todayKey)) {
    start.setDate(start.getDate() - 1);
  }
  if (!daySet.has(localDayKey(start))) {
    return 0;
  }

  // 从起点逐日往回数连续天数
  let streak = 0;
  const cursor = new Date(start);
  while (daySet.has(localDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * 评估快照中已达成的成就，返回成就 id 列表（按定义表顺序）。
 * 纯函数：只判断「是否达成」，不负责记录解锁时间（由 store 层做幂等落账）。
 */
export function evaluateAchievements(input: AchievementSnapshot): string[] {
  // 先统一清洗日期：非法项既不计入段数，也不参与连击
  const validDates: string[] = [];
  for (const raw of input.completedAt) {
    if (typeof raw === 'string' && raw !== '' && !Number.isNaN(Date.parse(raw))) {
      validDates.push(raw);
    }
  }

  const bookmarkCount = Number.isFinite(input.bookmarkCount)
    ? Math.max(0, Math.floor(input.bookmarkCount))
    : 0;
  const noteCount = Number.isFinite(input.noteCount)
    ? Math.max(0, Math.floor(input.noteCount))
    : 0;
  const coverage = new Set(input.bookIds.filter((id) => typeof id === 'string' && id !== '')).size;

  // 分类 → 当前指标值
  const metricByCategory: Record<AchievementCategory, number> = {
    recitation: validDates.length,
    streak: computeStreak(validDates, input.today),
    bookmark: bookmarkCount,
    note: noteCount,
    coverage,
  };

  const achieved: string[] = [];
  for (const def of ACHIEVEMENTS) {
    if (metricByCategory[def.category] >= def.threshold) {
      achieved.push(def.id);
    }
  }
  return achieved;
}
