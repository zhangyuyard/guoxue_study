/**
 * DocumentPicker URI → RNFS 本地路径 规范化工具。
 *
 * DocumentPicker 返回的 fileCopyUri 是 URI 形态（file:// 前缀 + URL 编码），
 * 而 RNFS 的 stat/read 在 Android 端用 java.io.File(path) 解析、iOS 端也按
 * 路径处理：file:// 前缀或未解码的 %20 等编码字符会导致找不到文件
 * （Android 抛出的错误文案即 "File does not exist"）。
 * content:// 等 provider URI 则完全无法由 RNFS 读取，需在读取前拦截并提示。
 */

/**
 * 规范化为 RNFS 可用的本地路径：
 * - 剥离 file:// 前缀；
 * - 去掉路径后可能附带的 query（部分 provider 追加 ?key=value）；
 * - 解码 URL 编码字符（空格 → %20 等）。
 * 非 file:// 的 URI（如 content://）原样返回，由调用方用 isLocalPath 拒绝。
 */
export function toLocalPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    const q = p.indexOf('?');
    if (q >= 0) {
      p = p.slice(0, q);
    }
    try {
      p = decodeURIComponent(p);
    } catch {
      // 含非法 % 序列时保留原样
    }
  }
  return p;
}

/** 判定规范化后是否为 RNFS 可读的本地路径（应以 / 开头） */
export function isLocalPath(uri: string): boolean {
  return toLocalPath(uri).startsWith('/');
}
