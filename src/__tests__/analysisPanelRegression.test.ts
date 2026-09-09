/**
 * 解析面板两个真机反馈 Bug 的回归防护测试（源码结构断言）
 * Bug 1：解析面板显示不全，无法滚动。
 *   根因：内容区 ScrollView 样式只有 flexGrow: 0、无 flexShrink（RN 默认 0）——
 *   内容超高时面板被 maxHeight: '60%' 截断，但 ScrollView 仍按内容全高量取，
 *   溢出部分被裁剪且 ScrollView 自认为无需滚动（拖不动）。
 *   修复：content 样式补 flexShrink: 1，触顶时压缩到剩余空间进入滚动。
 * Bug 2：解析面板 → 在字典中查看 → 字典管理 → 返回，落在「我的/设置」页。
 *   根因：RootStack 实例的查字页打开词典管理走嵌套兜底
 *   Main→Profile→ProfileStack→DictManage——DictManage 压进「我的」Tab 的栈，
 *   返回自然落在设置页（而非查字页）。
 *   修复：RootStack 同样注册 DictManage，两处挂载点的 routeNames 检测
 *   均命中本地 navigate，返回逐级回退到查字页 → 阅读器。
 * 本文件以源码断言锁定各修复点，防止后续改动回退。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

describe('Bug 1：解析面板内容区超高可滚动', () => {
  const source = readSrc('components/reader/AnalysisPanel.tsx');

  test('content ScrollView 样式必须含 flexShrink: 1（触 maxHeight 后压缩并滚动）', () => {
    expect(source).toMatch(/content:\s*\{[^}]*flexGrow:\s*0,[^}]*flexShrink:\s*1,[^}]*\}/);
  });

  test('面板保留 maxHeight 约束（半屏弹层语义不变）', () => {
    expect(source).toMatch(/maxHeight:\s*'60%'/);
  });

  test('内容区确为 ScrollView（可滚容器）', () => {
    expect(source).toMatch(/<ScrollView style=\{styles\.content\}/);
  });
});

describe('Bug 2：RootStack 查字页直达词典管理，返回不落设置页', () => {
  const navigatorSource = readSrc('navigation/RootNavigator.tsx');
  const typesSource = readSrc('navigation/types.ts');
  const lookupSource = readSrc('screens/DictLookupScreen.tsx');

  test('RootStack 必须注册 DictManage（与 DictLookup 同级）', () => {
    expect(navigatorSource).toMatch(
      /<RootStack\.Screen name="DictLookup" component=\{DictLookupScreen\} \/>\s*\n\s*<RootStack\.Screen name="DictManage" component=\{DictManageScreen\} \/>/,
    );
  });

  test('RootStackParamList 必须声明 DictManage 路由', () => {
    expect(typesSource).toMatch(/DictLookup:\s*DictLookupParams;\s*\n\s*\/\*\*[^*]*\*\/\s*\n\s*DictManage:\s*undefined;/);
  });

  test('openDictManage 保留 routeNames 本地检测（两个挂载点统一走本地 navigate）', () => {
    expect(lookupSource).toMatch(/state\.routeNames\.includes\('DictManage'\)/);
    expect(lookupSource).toMatch(/navigation\.navigate\('DictManage'\)/);
  });
});
