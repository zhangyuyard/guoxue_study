/**
 * P0 词组层资产下沉回归测试（phrase-pinyin 异步载入）。
 * 背景：phrase-pinyin.json（4.9MB）由静态 import 下沉为 Android assets
 * 异步载入（见 docs/reader-optimization-roadmap.md P0①）。本文件锁定：
 * 1. 异步载入成功 / 失败 / 重试语义（ensurePhrasePinyinData）；
 * 2. 载入前词组层缺席（空覆盖）、载入后参与正向最大匹配；
 * 3. 测试同步 provider 路径（jestSetupFile 注入）语义；
 * 4. 源码结构断言：无静态 import、App 预热、阅读器晚到失效、列表调参。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  computePhraseOverlay,
  ensurePhrasePinyinData,
  isPhrasePinyinDataLoaded,
  resetPhrasePinyinForTests,
  setPhrasePinyinAsyncLoader,
  setPhrasePinyinSyncProvider,
} from '@/services/PinyinService';

const PHRASE_JSON = resolve(
  __dirname,
  '../../../android/app/src/main/assets/data/phrase-pinyin.json',
);

beforeEach(() => {
  // 每用例从干净态开始：清掉缓存与 jestSetupFile 注入的同步 provider / loader
  resetPhrasePinyinForTests();
});

describe('ensurePhrasePinyinData 异步载入语义', () => {
  test('载入成功：构建词组表并参与词组覆盖', async () => {
    expect(isPhrasePinyinDataLoaded()).toBe(false);
    setPhrasePinyinAsyncLoader(() => Promise.resolve(readFileSync(PHRASE_JSON, 'utf8')));

    await expect(ensurePhrasePinyinData()).resolves.toBe(true);
    expect(isPhrasePinyinDataLoaded()).toBe(true);

    // 「行为」含多音字「行」，必在过滤后的词库中；覆盖读音与词库条目一致
    const payload = JSON.parse(readFileSync(PHRASE_JSON, 'utf8')) as {
      phrases: Record<string, string>;
    };
    expect(payload.phrases['行为']).toBeDefined();
    const overlay = computePhraseOverlay(Array.from('行为'));
    const syllables = payload.phrases['行为'].split(/\s+/);
    expect(overlay.get(0)).toBe(syllables[0]);
    expect(overlay.get(1)).toBe(syllables[1]);
  });

  test('载入失败：resolve false、词组层缺席（空覆盖）、允许重试', async () => {
    let calls = 0;
    setPhrasePinyinAsyncLoader(() => {
      calls += 1;
      return Promise.reject(new Error('asset missing'));
    });

    await expect(ensurePhrasePinyinData()).resolves.toBe(false);
    expect(isPhrasePinyinDataLoaded()).toBe(false);
    // 词组层缺席：任何输入都不产生覆盖，仲裁链降级不抛错
    expect(computePhraseOverlay(Array.from('行为')).size).toBe(0);

    // 失败后 promise 已复位：修复 loader 后可重试成功
    setPhrasePinyinAsyncLoader(() => Promise.resolve(readFileSync(PHRASE_JSON, 'utf8')));
    await expect(ensurePhrasePinyinData()).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  test('ensure 幂等：单例 promise，loader 只调一次', async () => {
    let calls = 0;
    setPhrasePinyinAsyncLoader(() => {
      calls += 1;
      return Promise.resolve(readFileSync(PHRASE_JSON, 'utf8'));
    });

    const [a, b] = await Promise.all([
      ensurePhrasePinyinData(),
      ensurePhrasePinyinData(),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('同步 provider 路径（测试环境注入）', () => {
  test('懒初始化：首个 annotate 前不触发，ensure 后参与覆盖', () => {
    let calls = 0;
    setPhrasePinyinSyncProvider(() => {
      calls += 1;
      return { phrases: { 测试: 'cè shì' } };
    });

    // provider 惰性：注入本身不触发读取
    expect(calls).toBe(0);
    void ensurePhrasePinyinData();
    // 同步 provider 下 ensure 立即走同步路径
    expect(calls).toBe(1);
    expect(isPhrasePinyinDataLoaded()).toBe(true);

    const overlay = computePhraseOverlay(Array.from('测试'));
    expect(overlay.get(0)).toBe('cè');
    expect(overlay.get(1)).toBe('shì');
  });
});

describe('源码结构断言（P0 落地形态）', () => {
  const srcRoot = resolve(__dirname, '../../..');

  test('PinyinService 不再静态 import phrase-pinyin.json', () => {
    const source = readFileSync(resolve(srcRoot, 'src/services/PinyinService.ts'), 'utf8');
    expect(source).not.toMatch(/from '@\/data\/phrase-pinyin\.json'/);
    expect(source).toMatch(/ensurePhrasePinyinData/);
    expect(source).toMatch(/readFileAssets/);
  });

  test('App 启动延后任务包含词组层预热', () => {
    const source = readFileSync(resolve(srcRoot, 'src/App.tsx'), 'utf8');
    expect(source).toMatch(/warmPhrasePinyin/);
  });

  test('PinyinText 含晚到载入失效机制', () => {
    const source = readFileSync(
      resolve(srcRoot, 'src/components/reader/PinyinText.tsx'),
      'utf8',
    );
    expect(source).toMatch(/isPhrasePinyinDataLoaded\(\)/);
    expect(source).toMatch(/ensurePhrasePinyinData\(\)/);
  });

  test('滚动模式 FlatList 含渲染窗口调参', () => {
    const source = readFileSync(resolve(srcRoot, 'src/screens/ReaderScreen.tsx'), 'utf8');
    expect(source).toMatch(/windowSize=\{LIST_WINDOW_SIZE\}/);
    expect(source).toMatch(/maxToRenderPerBatch=\{LIST_MAX_TO_RENDER_PER_BATCH\}/);
    expect(source).toMatch(/updateCellsBatchingPeriod=\{LIST_UPDATE_CELLS_BATCHING_PERIOD\}/);
  });
});
