/**
 * useReadingOverrideStore 单测：
 *   - addOverride：新增 / 同 char+context 幂等覆盖 / 空入参防御拒绝
 *   - removeOverride / removeOverridesByChar（空 char 不误删）
 *   - getOverride / getOverrideEntry 查询
 *   - restoreFromBackup：合并语义（设备已有保留）、char+context 幂等覆盖、非法条目跳过
 * IO 经 jestSetupFile 的 MMKV 内存 mock（persist 写入恒成功，不真跑 MMKV）。
 */
import { useReadingOverrideStore } from '@/store/useReadingOverrideStore';

beforeEach(() => {
  useReadingOverrideStore.setState({ overrides: [] });
});

describe('addOverride', () => {
  test('新增纠正：字段完整、新条目在前', () => {
    useReadingOverrideStore.getState().addOverride('王', '以德行仁者王。', 'wàng');
    useReadingOverrideStore.getState().addOverride('中', '刑罚不中。', 'zhòng');
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(2);
    expect(list[0].char).toBe('中');
    expect(list[0].context).toBe('刑罚不中。');
    expect(list[0].reading).toBe('zhòng');
    expect(list[0].id).toMatch(/^ro-/);
    expect(new Date(list[0].createdAt).getTime()).not.toBeNaN();
  });

  test('同 char+context 幂等覆盖：保留原 id 与位次，仅更新读音', () => {
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wàng');
    useReadingOverrideStore.getState().addOverride('朝', '皆朝于齐。', 'cháo');
    const firstId = useReadingOverrideStore.getState().overrides[1].id;
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wáng');
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe(firstId);
    expect(list[1].reading).toBe('wáng');
  });

  test('空 char / 空 context / 空 reading 防御拒绝', () => {
    useReadingOverrideStore.getState().addOverride('', 'context', 'yuè');
    useReadingOverrideStore.getState().addOverride('乐', '', 'yuè');
    useReadingOverrideStore.getState().addOverride('乐', 'context', '');
    expect(useReadingOverrideStore.getState().overrides).toHaveLength(0);
  });
});

describe('removeOverride / removeOverridesByChar', () => {
  test('按 id 删除', () => {
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wàng');
    const id = useReadingOverrideStore.getState().overrides[0].id;
    useReadingOverrideStore.getState().removeOverride(id);
    expect(useReadingOverrideStore.getState().overrides).toHaveLength(0);
  });

  test('按字删除：只删该字的纠正', () => {
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wàng');
    useReadingOverrideStore.getState().addOverride('中', '不中。', 'zhòng');
    useReadingOverrideStore.getState().removeOverridesByChar('王');
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(1);
    expect(list[0].char).toBe('中');
  });

  test('removeOverridesByChar 空 char 不误删', () => {
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wàng');
    useReadingOverrideStore.getState().removeOverridesByChar('');
    expect(useReadingOverrideStore.getState().overrides).toHaveLength(1);
  });
});

describe('getOverride / getOverrideEntry', () => {
  test('命中返回读音 / 记录；未命中返回 null', () => {
    useReadingOverrideStore.getState().addOverride('王', '以德行仁者王。', 'wàng');
    expect(useReadingOverrideStore.getState().getOverride('王', '以德行仁者王。')).toBe('wàng');
    expect(useReadingOverrideStore.getState().getOverrideEntry('王', '以德行仁者王。')?.char).toBe('王');
    expect(useReadingOverrideStore.getState().getOverride('王', '别的话。')).toBeNull();
    expect(useReadingOverrideStore.getState().getOverride('中', '以德行仁者王。')).toBeNull();
  });
});

describe('restoreFromBackup（合并语义）', () => {
  test('备份条目写入，设备独有条目保留，同键覆盖读音且保留原 id', () => {
    useReadingOverrideStore.getState().addOverride('王', '以德行仁者王。', 'wàng');
    useReadingOverrideStore.getState().addOverride('乐', '礼乐皆得。', 'yuè');
    const existingId = useReadingOverrideStore.getState().overrides.find(
      (o) => o.char === '王',
    )!.id;

    useReadingOverrideStore.getState().restoreFromBackup([
      // 同键：覆盖读音
      { id: 'ro-backup-1', char: '王', context: '以德行仁者王。', reading: 'wáng' },
      // 设备没有的新键：写入
      { id: 'ro-backup-2', char: '朝', context: '皆朝于齐。', reading: 'cháo' },
    ]);
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(3);
    const wang = list.find((o) => o.char === '王')!;
    expect(wang.reading).toBe('wáng');
    expect(wang.id).toBe(existingId); // 幂等覆盖保留原 id
    expect(list.find((o) => o.char === '朝')!.id).toBe('ro-backup-2');
    expect(list.find((o) => o.char === '乐')!.reading).toBe('yuè'); // 设备已有保留
  });

  test('非法条目（缺 char/context/reading）静默跳过', () => {
    useReadingOverrideStore.getState().restoreFromBackup([
      null,
      'junk',
      { char: '王', context: '以德行仁者王。' }, // 缺 reading
      { char: '', context: 'x', reading: 'wàng' }, // 空 char
      { char: '王', context: '以德行仁者王。', reading: 'wàng' },
    ]);
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(1);
    expect(list[0].reading).toBe('wàng');
  });

  test('非数组入参不改动现有列表', () => {
    useReadingOverrideStore.getState().addOverride('王', '天下。', 'wàng');
    const before = useReadingOverrideStore.getState().overrides;
    useReadingOverrideStore.getState().restoreFromBackup('nope');
    useReadingOverrideStore.getState().restoreFromBackup(undefined);
    expect(useReadingOverrideStore.getState().overrides).toBe(before);
  });

  test('旧备份条目缺 id/createdAt：容错补齐', () => {
    useReadingOverrideStore.getState().restoreFromBackup([
      { char: '中', context: '刑罚不中。', reading: 'zhòng' },
    ]);
    const list = useReadingOverrideStore.getState().overrides;
    expect(list).toHaveLength(1);
    expect(list[0].id).toMatch(/^ro-/);
    expect(new Date(list[0].createdAt).getTime()).not.toBeNaN();
  });
});
