/**
 * localPath 工具测试：DocumentPicker URI → RNFS 本地路径规范化。
 * 回归背景：file:// 前缀 / URL 编码路径传入 RNFS.stat 会导致
 * Android 端 "File does not exist"（2026-09-02 用户导入 txt 失败）。
 */
import { isLocalPath, toLocalPath } from '@/utils/localPath';

describe('toLocalPath', () => {
  test('剥离 file:// 前缀', () => {
    expect(toLocalPath('file:///data/user/0/app/cache/a.txt')).toBe(
      '/data/user/0/app/cache/a.txt',
    );
  });

  test('纯绝对路径原样返回', () => {
    expect(toLocalPath('/data/user/0/app/cache/a.txt')).toBe(
      '/data/user/0/app/cache/a.txt',
    );
  });

  test('解码 URL 编码字符（空格 → %20、中文）', () => {
    expect(
      toLocalPath('file:///data/user/0/app/cache/%E9%81%93%E5%BE%B7%E7%BB%8F.txt'),
    ).toBe('/data/user/0/app/cache/道德经.txt');
    expect(toLocalPath('file:///storage/emulated/0/Download/my%20book.txt')).toBe(
      '/storage/emulated/0/Download/my book.txt',
    );
  });

  test('剥离路径后附带的 query', () => {
    expect(
      toLocalPath('file:///data/cache/a.txt?token=abc&x=1'),
    ).toBe('/data/cache/a.txt');
  });

  test('content:// 等非 file:// URI 原样返回（由 isLocalPath 拦截）', () => {
    expect(
      toLocalPath('content://com.android.providers.downloads/document/123'),
    ).toBe('content://com.android.providers.downloads/document/123');
  });

  test('非法 % 序列解码失败时保留原样（不抛错）', () => {
    expect(toLocalPath('file:///data/cache/bad%zz.txt')).toBe(
      '/data/cache/bad%zz.txt',
    );
  });
});

describe('isLocalPath', () => {
  test('file:// 剥离后以 / 开头 → 可读', () => {
    expect(isLocalPath('file:///data/cache/a.txt')).toBe(true);
  });

  test('纯绝对路径 → 可读', () => {
    expect(isLocalPath('/data/cache/a.txt')).toBe(true);
  });

  test('content:// → 不可读', () => {
    expect(isLocalPath('content://docs/document/xyz')).toBe(false);
  });
});
