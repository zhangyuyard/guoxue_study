/**
 * 背诵独立为首页底部 Tab + 两级选择器升级回归防护测试（源码结构断言）
 *
 * 变更背景：
 * - 背诵助手（Recitation / RecitationPractice）原挂在 ProfileStack，入口在「我的」页；
 *   现改为首页底部导航独立「背诵」Tab（ReciteStack）。
 * - 背诵选择器升级为两级：先选书（横向 chips，含用户导入书），再展示该书章节
 *   逐章可选（粒度 = 最小章节，逐章独立开始背诵）。
 * 本文件以源码断言锁定结构，防止导航结构回退与选择器能力回退。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const navTypes = readSrc('navigation/types.ts');
const rootNavigator = readSrc('navigation/RootNavigator.tsx');
const profileScreen = readSrc('screens/ProfileScreen.tsx');
const recitationScreen = readSrc('screens/RecitationScreen.tsx');

/** 提取源码中某个 type 声明的完整块（至第一个 `};`） */
function extractTypeBlock(src: string, name: string): string {
  const m = src.match(new RegExp(`export type ${name} = \\{[\\s\\S]*?\\};`));
  return m?.[0] ?? '';
}

describe('背诵独立为首页底部 Tab（导航结构）', () => {
  test('MainTabParamList 含 Recite，且有独立的 ReciteStackParamList', () => {
    const mainTabBlock = extractTypeBlock(navTypes, 'MainTabParamList');
    expect(mainTabBlock).toMatch(/Recite: undefined;/);
    const reciteStackBlock = extractTypeBlock(navTypes, 'ReciteStackParamList');
    expect(reciteStackBlock).toMatch(/Recitation: undefined;/);
    expect(reciteStackBlock).toMatch(/RecitationPractice: RecitationPracticeParams;/);
  });

  test('ProfileStackParamList 不再包含背诵两页（防死路由回潮）', () => {
    const profileStackBlock = extractTypeBlock(navTypes, 'ProfileStackParamList');
    expect(profileStackBlock).not.toMatch(/Recitation/);
  });

  test('RootNavigator 挂载 ReciteStack（Recitation + RecitationPractice 两屏）', () => {
    expect(rootNavigator).toMatch(
      /const ReciteStack = createNativeStackNavigator<ReciteStackParamList>\(\);/,
    );
    const reciteStackBlock =
      rootNavigator.match(/function ReciteStackScreens\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(reciteStackBlock).toMatch(/<ReciteStack\.Screen name="Recitation"/);
    expect(reciteStackBlock).toMatch(/name="RecitationPractice"/);
  });

  test('底部 Tab 注册「背诵」项（TAB_META 图标 + Tab.Screen）', () => {
    expect(rootNavigator).toMatch(/Recite: \{ icon: '[^']+', label: '背诵' \},/);
    expect(rootNavigator).toMatch(/<Tab\.Screen\s*\n\s*name="Recite"/);
    expect(rootNavigator).toMatch(/component=\{ReciteStackScreens\}/);
    expect(rootNavigator).toMatch(/options=\{\{ title: TAB_META\.Recite\.label \}\}/);
  });

  test('ProfileStack 不再挂载背诵两页；ProfileScreen 无残留死入口', () => {
    const profileStackBlock =
      rootNavigator.match(/function ProfileStackScreens\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(profileStackBlock).not.toMatch(/name="Recitation"/);
    expect(profileStackBlock).not.toMatch(/name="RecitationPractice"/);
    // 「我的」页背诵入口删除（navigate('Recitation') 已成死调用）
    expect(profileScreen).not.toMatch(/navigation\.navigate\('Recitation'\)/);
    expect(profileScreen).not.toMatch(/recitationCount/);
  });

  test('RootStack 的 RecitationPractice 保留；ReaderScreen 菜单背诵直达入口已删除（改由背诵 Tab 进入）', () => {
    expect(rootNavigator).toMatch(
      /<RootStack\.Screen\s*\n\s*name="RecitationPractice"/,
    );
    expect(navTypes).toMatch(/export type RootStackParamList = \{[\s\S]*?RecitationPractice: RecitationPracticeParams;/);
    // 阅读器长按菜单不再保留背诵练习入口（handleRecite 直达跳转删除）
    const readerScreen = readSrc('screens/ReaderScreen.tsx');
    expect(readerScreen).not.toMatch(/handleRecite/);
    expect(readerScreen).not.toMatch(/accessibilityLabel="背诵练习"/);
  });
});

describe('背诵选择器两级升级（选书 → 选章节）', () => {
  test('存在第一级「选书」状态与回调（selectedBookId / selectBook）', () => {
    expect(recitationScreen).toMatch(/const \[selectedBookId, setSelectedBookId\] = /);
    expect(recitationScreen).toMatch(/const selectBook = useCallback/);
    expect(recitationScreen).toMatch(/选择书籍/);
  });

  test('第二级章节列表只渲染当前选中书的章节（粒度 = 最小章节）', () => {
    expect(recitationScreen).toMatch(/const selectedGroup = useMemo/);
    expect(recitationScreen).toMatch(
      /\(selectedGroup\?\.chapters \?\? \[\]\)\.map\(\(chapter\) =>/,
    );
    // 逐章独立开始背诵：选中章节 + 开始按钮链路保留
    expect(recitationScreen).toMatch(/const startRecitation = useCallback/);
    expect(recitationScreen).toMatch(/selectedChapter\.bookId/);
    expect(recitationScreen).toMatch(/selectedChapter\.id/);
  });

  test('书籍列表 focus 时刷新（覆盖本 Tab 挂载后导入新书的场景）', () => {
    expect(recitationScreen).toMatch(/const loadBooks = useCallback/);
    expect(recitationScreen).toMatch(/navigation\.addListener\('focus', loadBooks\)/);
  });

  test('书源含用户导入书（TextLibraryService.getBooks 统一索引），取文链路无需特判', () => {
    expect(recitationScreen).toMatch(/TextLibraryService\.getBooks\(\)/);
  });

  test('既有能力全部保留：今日复习 / 复习提醒 / 每日目标 / 进度卡片网格', () => {
    expect(recitationScreen).toMatch(/buildReviewItems/);
    expect(recitationScreen).toMatch(/syncReminderFromStores/);
    expect(recitationScreen).toMatch(/requestReminderPermission/);
    expect(recitationScreen).toMatch(/dailyGoalProgress/);
    expect(recitationScreen).toMatch(/<RecitationCard/);
  });
});
