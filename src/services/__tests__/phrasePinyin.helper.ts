/**
 * 测试共享 helper：词组读音层同步 provider 注入。
 * 背景（P0 资产下沉）：phrase-pinyin.json（4.9MB）由静态 import 下沉为
 * Android assets 异步载入后，测试环境需要等价的同步数据源，才能保持
 * 「与静态 import 时代逐字节一致」的判音行为（金标 125 条基线）。
 *
 * 为什么不用 jestSetupFile 全局注入：setupFiles 里 require PinyinService 会
 * 提前把 react-native-fs 等模块拉进模块注册表缓存，绕过个别测试文件自带的
 * jest.mock 本地工厂（UserBookService.builtinResilience 套件踩坑）。
 * 因此改为「需要词组层的套件自行调用本 helper」的按需注入。
 *
 * provider 惰性：注入本身不读盘，首个 annotate / computePhraseOverlay 才
 * 读取 assets 下的 JSON 并 parse（与旧懒建 Map 语义一致）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { setPhrasePinyinSyncProvider } from '@/services/PinyinService';

let installed = false;

export function installPhrasePinyinSyncProviderForTests(): void {
  if (installed) {
    return;
  }
  installed = true;
  const jsonPath = resolve(
    __dirname,
    '../../../android/app/src/main/assets/data/phrase-pinyin.json',
  );
  setPhrasePinyinSyncProvider(() => JSON.parse(readFileSync(jsonPath, 'utf8')));
}
