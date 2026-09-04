/**
 * 本地备份/恢复纯函数模块（P2-15，本地版）
 * 聚合 设置 / 背诵进度 / 收藏 / 笔记 / 成就 五类数据为带版本号的 JSON。
 * 只做纯数据构造与校验，不触碰 RNFS / DocumentPicker（IO 由 UI 层负责），
 * 与 exporters / dailyGoal 同一纯函数套路，便于单测锁定格式与错误文案。
 *
 * 向前兼容：data 中未知的多余字段在 parse 时忽略（不报错），便于后续版本加字段。
 */

/** 备份文件格式版本（当前唯一支持版本；解析时严格校验） */
export const BACKUP_VERSION = 1;

/** 备份聚合数据（五类数据的最小结构约束在 parseBackup 校验） */
export interface BackupData {
  /** 设置快照（键值对；恢复时逐字段覆盖，未提供的字段保持现值） */
  settings: Record<string, unknown>;
  /** 背诵进度列表 */
  recitation: unknown[];
  /** 收藏列表 */
  bookmarks: unknown[];
  /** 笔记列表 */
  notes: unknown[];
  /** 成就解锁记录（achievementId → ISO 解锁时间） */
  achievements: Record<string, string>;
}

/** buildBackup 的输入（与 BackupData 同构；由 UI 层从各 store 采集） */
export type BackupSnapshot = BackupData;

/** 解析后的备份（parseBackup 成功产物） */
export interface ParsedBackup {
  /** 格式版本（恒为 BACKUP_VERSION，否则抛错） */
  version: number;
  /** 导出时间（ISO 字符串；缺失时为空串） */
  exportedAt: string;
  /** 聚合数据（仅保留已知字段，未知字段已剔除） */
  data: BackupData;
}

/**
 * 备份文件名时间戳：YYYYMMDD-HHmmss（本地时区，秒级避免同分钟覆盖）。
 */
export function formatBackupStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 参与备份的设置字段白名单（与 useSettingsStore 的持久化字段对应，函数字段不进备份） */
export const SETTINGS_BACKUP_KEYS = [
  'fontSize',
  'lineHeight',
  'theme',
  'paper',
  'readerMode',
  'pinyinMode',
  'conversionMode',
  'recitationHintGranularity',
  'bookmarkGroupedView',
  'reminderEnabled',
  'reminderHour',
  'reminderMinute',
  'dailyGoalEnabled',
  'dailyGoalCount',
  'speechRate',
] as const;

/**
 * 从设置 state 采集备份快照：仅保留白名单字段 + translation 配置对象。
 * 纯函数（不 import store 类型，入参用索引签名，调用方做一次类型收窄即可）。
 */
export function pickSettingsSnapshot(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_BACKUP_KEYS) {
    if (settings[key] !== undefined) {
      out[key] = settings[key];
    }
  }
  // translation 为嵌套配置对象（服务商 + Key），整体浅拷贝进备份
  const translation = settings.translation;
  if (translation && typeof translation === 'object' && !Array.isArray(translation)) {
    out.translation = { ...(translation as Record<string, unknown>) };
  }
  return out;
}

/**
 * 构造备份 JSON 字符串（pretty 缩进 2 空格，便于用户用文本编辑器检查）。
 * 注意：调用方应先经 pickSettingsSnapshot 等采集函数得到快照，本函数不再清洗。
 */
export function buildBackup(snapshot: BackupSnapshot): string {
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      settings: snapshot.settings,
      recitation: snapshot.recitation,
      bookmarks: snapshot.bookmarks,
      notes: snapshot.notes,
      achievements: snapshot.achievements,
    },
  };
  return JSON.stringify(payload, null, 2);
}

/** 「是否为普通对象」判断（排除 null 与数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析并校验备份 JSON 文本。
 * 校验失败抛出 Error，message 为明确的中文原因（哪个字段坏了说清楚）；
 * data 中未知多余字段忽略（向前兼容）。
 */
export function parseBackup(text: string): ParsedBackup {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('备份文件解析失败：不是有效的 JSON 文本');
  }
  if (!isPlainObject(root)) {
    throw new Error('备份文件格式错误：根节点应为对象');
  }

  // 版本严格校验：仅支持当前版本（更高版本由未来 App 升级支持）
  if (root.version === undefined) {
    throw new Error('备份文件格式错误：缺少 version 版本号');
  }
  if (root.version !== BACKUP_VERSION) {
    throw new Error(
      `备份文件版本不支持：期望版本 ${BACKUP_VERSION}，实际为 ${String(root.version)}（可能由更新版本的应用导出）`,
    );
  }

  let exportedAt = '';
  if (root.exportedAt !== undefined) {
    if (typeof root.exportedAt !== 'string') {
      throw new Error('备份文件格式错误：exportedAt 应为字符串（ISO 时间）');
    }
    exportedAt = root.exportedAt;
  }

  if (!isPlainObject(root.data)) {
    throw new Error('备份文件格式错误：data 应为对象');
  }
  const data = root.data;

  if (!isPlainObject(data.settings)) {
    throw new Error('备份文件格式错误：data.settings 应为对象');
  }
  for (const key of ['recitation', 'bookmarks', 'notes'] as const) {
    if (!Array.isArray(data[key])) {
      throw new Error(`备份文件格式错误：data.${key} 应为数组`);
    }
  }
  if (!isPlainObject(data.achievements)) {
    throw new Error('备份文件格式错误：data.achievements 应为对象');
  }

  // 只挑已知字段重组（未知字段忽略），保证返回类型可信
  return {
    version: BACKUP_VERSION,
    exportedAt,
    data: {
      settings: data.settings,
      recitation: data.recitation as unknown[],
      bookmarks: data.bookmarks as unknown[],
      notes: data.notes as unknown[],
      achievements: data.achievements as Record<string, string>,
    },
  };
}

/**
 * 汇总备份数据规模（导入确认弹窗 / 完成提示共用），例如：
 * 「设置 16 项、背诵进度 12 条、收藏 8 条、笔记 5 条、成就 3 项」。
 */
export function summarizeBackup(data: BackupData): string {
  const parts = [
    `设置 ${Object.keys(data.settings).length} 项`,
    `背诵进度 ${data.recitation.length} 条`,
    `收藏 ${data.bookmarks.length} 条`,
    `笔记 ${data.notes.length} 条`,
    `成就 ${Object.keys(data.achievements).length} 项`,
  ];
  return parts.join('、');
}
