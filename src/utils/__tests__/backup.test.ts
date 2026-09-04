/**
 * 备份/恢复纯函数单测（P2-15）：
 *   - formatBackupStamp：文件名时间戳
 *   - pickSettingsSnapshot：设置白名单采集
 *   - buildBackup → parseBackup：往返一致
 *   - parseBackup：各字段最小结构校验与中文错误文案
 *   - userBooks：v1 扩展可选字段（缺失容错 / 非法报错 / 正常透传）
 *   - summarizeBackup：规模汇总（含用户书籍计数）
 */
import {
  BACKUP_VERSION,
  buildBackup,
  formatBackupStamp,
  parseBackup,
  pickSettingsSnapshot,
  SETTINGS_BACKUP_KEYS,
  summarizeBackup,
  type BackupSnapshot,
} from '@/utils/backup';

/** 构造一本最小用户书 Book 结构（备份聚合用） */
function makeUserBook(id = 'user-backup-1'): Record<string, unknown> {
  return {
    id,
    title: '备份之书',
    author: '佚名',
    category: 'user',
    description: '共 1 章 1 段 · 导入自 TXT',
    chapters: [
      {
        id: `${id}-c1`,
        bookId: id,
        title: '全文',
        order: 1,
        segments: [{ id: `${id}-c1-s1`, chapterId: `${id}-c1`, order: 1, text: '学而时习之。' }],
      },
    ],
  };
}

/** 构造一份最小备份快照 */
function makeSnapshot(): BackupSnapshot {
  return {
    settings: { fontSize: 20, theme: 'dark', translation: { provider: 'deepl' } },
    recitation: [
      {
        id: 'book1:ch1:fillBlank',
        bookId: 'book1',
        chapterId: 'ch1',
        mode: 'fillBlank',
        status: 'mastered',
        progress: 100,
        completedAt: '2026-03-15T02:00:00.000Z',
      },
    ],
    bookmarks: [{ id: 'bm-1', type: 'paragraph', tags: ['名句'], createdAt: '2026-03-15T00:00:00.000Z' }],
    notes: [{ id: 'note-1', bookId: 'book1', chapterId: 'ch1', segmentId: 'seg-1', startOffset: 0, endOffset: 3, content: '温故知新' }],
    achievements: { 'recite-10': '2026-03-15T03:00:00.000Z' },
    userBooks: [makeUserBook()],
  };
}

describe('formatBackupStamp', () => {
  test('生成 YYYYMMDD-HHmmss（本地时区）', () => {
    const stamp = formatBackupStamp(new Date(2026, 2, 15, 9, 5, 3));
    expect(stamp).toBe('20260315-090503');
  });

  test('月/日/时/分/秒补零', () => {
    const stamp = formatBackupStamp(new Date(2026, 0, 2, 23, 59, 9));
    expect(stamp).toBe('20260102-235909');
  });
});

describe('pickSettingsSnapshot', () => {
  test('仅保留白名单字段，函数与未知字段剔除', () => {
    const snapshot = pickSettingsSnapshot({
      fontSize: 22,
      theme: 'light',
      setTheme: () => undefined, // 函数字段不进备份
      notASetting: 'x',
    });
    expect(snapshot).toEqual({ fontSize: 22, theme: 'light' });
  });

  test('translation 嵌套对象整体保留（浅拷贝）', () => {
    const translation = { provider: 'baidu', baiduAppId: 'id' };
    const snapshot = pickSettingsSnapshot({ translation });
    expect(snapshot.translation).toEqual(translation);
    expect(snapshot.translation).not.toBe(translation);
  });

  test('覆盖全部白名单键（备份完整性）', () => {
    const settings: Record<string, unknown> = {};
    for (const key of SETTINGS_BACKUP_KEYS) {
      settings[key] = key === 'fontSize' ? 18 : null;
    }
    const snapshot = pickSettingsSnapshot(settings);
    expect(Object.keys(snapshot).sort()).toEqual([...SETTINGS_BACKUP_KEYS].sort());
  });
});

describe('buildBackup → parseBackup 往返', () => {
  test('往返后数据一致（深比较）', () => {
    const snapshot = makeSnapshot();
    const parsed = parseBackup(buildBackup(snapshot));
    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.exportedAt).not.toBe('');
    expect(parsed.data).toEqual(snapshot);
  });

  test('根节点带 version 与 exportedAt', () => {
    const root = JSON.parse(buildBackup(makeSnapshot())) as Record<string, unknown>;
    expect(root.version).toBe(1);
    expect(typeof root.exportedAt).toBe('string');
  });

  test('JSON 为 pretty 格式（含缩进）', () => {
    const text = buildBackup(makeSnapshot());
    expect(text).toContain('\n  "version"');
  });

  test('userBooks 随快照透传进 JSON（聚合断言）', () => {
    const root = JSON.parse(buildBackup(makeSnapshot())) as {
      data: { userBooks: Array<{ id: string }> };
    };
    expect(root.data.userBooks).toHaveLength(1);
    expect(root.data.userBooks[0].id).toBe('user-backup-1');
  });
});

describe('parseBackup 校验与错误文案', () => {
  test('非 JSON 文本 → 明确中文原因', () => {
    expect(() => parseBackup('not json {')).toThrow('JSON');
  });

  test('根节点非对象（数组/字符串/数字）→ 报错', () => {
    expect(() => parseBackup('[]')).toThrow('根节点应为对象');
    expect(() => parseBackup('"str"')).toThrow('根节点应为对象');
  });

  test('缺少 version → 报错', () => {
    const text = JSON.stringify({ data: {} });
    expect(() => parseBackup(text)).toThrow('缺少 version');
  });

  test('版本不支持 → 报错并带版本号', () => {
    const text = JSON.stringify({ version: 99, data: {} });
    expect(() => parseBackup(text)).toThrow('版本不支持');
    expect(() => parseBackup(text)).toThrow('99');
  });

  test('exportedAt 非字符串 → 报错', () => {
    const text = JSON.stringify({ version: 1, exportedAt: 123, data: {} });
    expect(() => parseBackup(text)).toThrow('exportedAt');
  });

  test('exportedAt 缺失 → 容错为空串（不报错）', () => {
    const text = JSON.stringify({
      version: 1,
      data: { settings: {}, recitation: [], bookmarks: [], notes: [], achievements: {} },
    });
    expect(parseBackup(text).exportedAt).toBe('');
  });

  test('data 非对象 → 报错', () => {
    const text = JSON.stringify({ version: 1, data: [] });
    expect(() => parseBackup(text)).toThrow('data 应为对象');
  });

  test('settings 非对象 → 报错并指名字段', () => {
    const text = JSON.stringify({
      version: 1,
      data: { settings: [], recitation: [], bookmarks: [], notes: [], achievements: {} },
    });
    expect(() => parseBackup(text)).toThrow('data.settings 应为对象');
  });

  test.each(['recitation', 'bookmarks', 'notes'] as const)(
    'data.%s 非数组 → 报错并指名字段',
    (field) => {
      const text = JSON.stringify({
        version: 1,
        data: {
          settings: {},
          recitation: [],
          bookmarks: [],
          notes: [],
          achievements: {},
          [field]: 'oops',
        },
      });
      expect(() => parseBackup(text)).toThrow(`data.${field} 应为数组`);
    },
  );

  test('achievements 非对象 → 报错并指名字段', () => {
    const text = JSON.stringify({
      version: 1,
      data: { settings: {}, recitation: [], bookmarks: [], notes: [], achievements: [] },
    });
    expect(() => parseBackup(text)).toThrow('data.achievements 应为对象');
  });

  test('data 中未知多余字段忽略（向前兼容）', () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: '2026-03-15T00:00:00.000Z',
      data: {
        settings: {},
        recitation: [],
        bookmarks: [],
        notes: [],
        achievements: {},
        userBooks: [],
        futureField: { whatever: true },
      },
      extraRoot: 1,
    });
    const parsed = parseBackup(text);
    expect(parsed.data).toEqual({
      settings: {},
      recitation: [],
      bookmarks: [],
      notes: [],
      achievements: {},
      userBooks: [],
    });
  });

  test('userBooks 为 v1 扩展可选字段：旧备份缺失 → 容错为空数组（不报错）', () => {
    const text = JSON.stringify({
      version: 1,
      data: { settings: {}, recitation: [], bookmarks: [], notes: [], achievements: {} },
    });
    const parsed = parseBackup(text);
    expect(parsed.data.userBooks).toEqual([]);
  });

  test('userBooks 提供但非数组 → 报错并指名字段', () => {
    const text = JSON.stringify({
      version: 1,
      data: {
        settings: {},
        recitation: [],
        bookmarks: [],
        notes: [],
        achievements: {},
        userBooks: 'oops',
      },
    });
    expect(() => parseBackup(text)).toThrow('data.userBooks 应为数组');
  });

  test('userBooks 正常数组 → 原样透传', () => {
    const book = makeUserBook('user-passthrough');
    const text = JSON.stringify({
      version: 1,
      data: {
        settings: {},
        recitation: [],
        bookmarks: [],
        notes: [],
        achievements: {},
        userBooks: [book],
      },
    });
    expect(parseBackup(text).data.userBooks).toEqual([book]);
  });
});

describe('summarizeBackup', () => {
  test('汇总六类数据规模（含用户书籍计数）', () => {
    const parsed = parseBackup(buildBackup(makeSnapshot()));
    expect(summarizeBackup(parsed.data)).toBe(
      '设置 3 项、背诵进度 1 条、收藏 1 条、笔记 1 条、成就 1 项、用户书籍 1 本',
    );
  });

  test('旧备份（无 userBooks 字段）→ 用户书籍显示 0 本', () => {
    const parsed = parseBackup(
      JSON.stringify({
        version: 1,
        data: { settings: {}, recitation: [], bookmarks: [], notes: [], achievements: {} },
      }),
    );
    expect(summarizeBackup(parsed.data)).toContain('用户书籍 0 本');
  });
});
