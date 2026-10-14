/**
 * Jest setup：mock 加载被测 store / service 链路必需的原生模块。
 * - react-native-mmkv：内存 Map 实现同步 KV（zustand persist 依赖）；
 *   v4 用 createMMKV 工厂函数（无 MMKV 类），此处同时导出 MMKV 类
 *   （供 useSettingsStore.test.ts 经 MMKV.prototype 打桩）与 createMMKV。
 * - @/services/sqliteClient：op-sqlite 适配层（旧 quick-sqlite 同形）；
 *   惰性单例；字典域测试可在测试文件内用 jest.mock 再次覆盖以获得
 *   可编程响应（后注册的 mock 优先）。
 * - react-native-fs：字典域部署/分块读取依赖；提供可重置的内存状态
 * - react-native-document-picker：文件选择 mock
 * - react-native：仅提供 Platform 等最小桩（字典服务判断平台用）
 * 注意：本文件为 .js（不走 babel TS 转换），禁止 TypeScript 注解语法。
 * 不添加与被测逻辑无关的其他 RN mock。
 */
/**
 * InteractionManager 桩（**保真 RN 0.83 契约**，2026-10-08 加）：
 * RN 0.83 起 `runAfterInteractions(task)` 的 task 是必需入参——无参调用会被
 * reject `TypeError('Invalid task of type: undefined')`
 * （node_modules/react-native/Libraries/Interaction/InteractionManager.js）。
 * 该 thenable 参与 `Promise.race` 时拒绝即未处理拒绝 ⇒ 真机 JS 致命崩溃。
 * 旧桩（只给 Platform，无 InteractionManager）使 `runAfterInteractionsSafe()`
 * 直接走降级分支 ⇒ **缺陷在 harness 里测不出来**（mock 无检测力，本仓第 3 次）。
 * 此桩按 RN 实现的判定顺序复刻：函数 / {run} / {gen} / 其它 → reject。
 * `__imState.calls` 记录每次入参，供「必须传 task」类断言。
 */
jest.mock('react-native', () => {
  const imState = { calls: [] };
  const runTask = (task, resolve, reject) => {
    if (typeof task === 'function') {
      try {
        task();
        resolve();
      } catch (e) {
        reject(e);
      }
      return;
    }
    if (task !== null && typeof task === 'object') {
      if (typeof task.gen === 'function') {
        task.gen().then(resolve, reject);
        return;
      }
      if (typeof task.run === 'function') {
        try {
          task.run();
          resolve();
        } catch (e) {
          reject(e);
        }
        return;
      }
    }
    reject(new TypeError('Invalid task of type: ' + typeof task));
  };
  return {
    Platform: { OS: 'android', select: (obj) => obj.android },
    InteractionManager: {
      runAfterInteractions: (task) => {
        imState.calls.push(task);
        const promise = new Promise((resolve, reject) => {
          setImmediate(() => runTask(task, resolve, reject));
        });
        return { then: promise.then.bind(promise), cancel() {} };
      },
    },
    __imState: imState,
  };
});

jest.mock('react-native-mmkv', () => {
  class MMKV {
    constructor() {
      this.map = new Map();
    }
    set(key, value) {
      this.map.set(key, String(value));
    }
    getString(key) {
      return this.map.has(key) ? this.map.get(key) : undefined;
    }
    getNumber(key) {
      const v = this.map.get(key);
      return v === undefined ? undefined : Number(v);
    }
    getBoolean(key) {
      const v = this.map.get(key);
      return v === undefined ? undefined : v === 'true';
    }
    remove(key) {
      this.map.delete(key);
    }
    delete(key) {
      this.map.delete(key);
    }
    contains(key) {
      return this.map.has(key);
    }
    getAllKeys() {
      return Array.from(this.map.keys());
    }
    clearAll() {
      this.map.clear();
    }
  }
  const createMMKV = () => new MMKV();
  return { MMKV, createMMKV };
});

jest.mock('@/services/sqliteClient', () => ({
  open: jest.fn(() => ({
    execute: jest.fn(() => ({ rows: { _array: [], length: 0 } })),
    executeBatch: jest.fn(),
    close: jest.fn(),
    delete: jest.fn(),
  })),
}));

jest.mock('react-native-fs', () => {
  /** 内存文件系统状态（测试可经 __state 重置/断言） */
  const state = {
    /** 已“存在”的目标路径集合 */
    files: new Set(),
    /** copyFileAssets 调用记录（src 参数） */
    assetsCopied: [],
    /** read 调用记录 */
    reads: [],
    /** read 返回内容（base64），测试可注入分块数据 */
    readResults: [],
    readFileResult: '',
  };
  return {
    DocumentDirectoryPath: '/data/user/0/com.guoxue.app/files',
    CachesDirectoryPath: '/data/user/0/com.guoxue.app/cache',
    MainBundlePath: '/data/app/bundle',
    exists: jest.fn(async (path) => state.files.has(path)),
    mkdir: jest.fn(async () => undefined),
    read: jest.fn(async (_path, length, position) => {
      state.reads.push({ position, length });
      return state.readResults.length > 0 ? state.readResults.shift() : '';
    }),
    readFile: jest.fn(async () => state.readFileResult),
    writeFile: jest.fn(async () => undefined),
    appendFile: jest.fn(async () => undefined),
    copyFile: jest.fn(async (_src, dst) => {
      state.files.add(dst);
    }),
    copyFileAssets: jest.fn(async (src, dst) => {
      state.assetsCopied.push(src);
      state.files.add(dst);
    }),
    unlink: jest.fn(async (path) => {
      state.files.delete(path);
    }),
    stat: jest.fn(async (path) => ({
      path,
      size: 4096,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    })),
    readDir: jest.fn(async () => []),
    __state: state,
  };
});

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(async () => ({
    uri: 'file:///data/user/0/com.guoxue.app/cache/picked-dict.csv',
    fileName: 'picked-dict.csv',
    size: 1024,
    type: 'text/csv',
  })),
  types: { allFiles: 0, plainText: 1 },
  isCancel: (e) =>
    Boolean(e && typeof e === 'object' && e.code === 'DOCUMENT_PICKER_CANCELED'),
}));
