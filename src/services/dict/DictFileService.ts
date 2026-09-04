/**
 * 字典文件服务（DictFileService）
 * - pickDictFile：document-picker 选文件（copyTo cachesDirectory 拿稳定本地路径）
 * - createChunkReader：RNFS.read（base64 分块）→ Uint8Array，供 parser ctx 注入
 */
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import type { ServiceResult } from '@/types';
import { isLocalPath, toLocalPath } from '@/utils/localPath';

/** 可选的字典扩展名（选择器 type 过滤用，Android 上按 MIME 兜底 allFiles） */
const DICT_EXTENSIONS = ['mdx', 'mdd', 'csv', 'tsv', 'json', 'txt', 'ifo', 'dz', 'gz'];

export interface PickedDictFile {
  /** 稳定本地路径（copyTo 副本优先） */
  uri: string;
  fileName: string;
  size: number;
}

/** 单次 read 上限（RNFS.read 建议值；4MB 与解析器块大小一致） */
const READ_CHUNK_LIMIT = 4 * 1024 * 1024;

/** base64 字符 → 6bit 值表（'=' 为 61，特判为 -2） */
const B64_CODE = (() => {
  const table = new Int8Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i += 1) {
    table[chars.charCodeAt(i)] = i;
  }
  return table;
})();

/** base64 → Uint8Array（RNFS.read 返回 base64；自实现保证环境无关） */
function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CODE[clean.charCodeAt(i)];
    const c1 = B64_CODE[clean.charCodeAt(i + 1)];
    const c2 = clean.charCodeAt(i + 2);
    const c3 = clean.charCodeAt(i + 3);
    const v2 = c2 === undefined ? -1 : c2 === 61 ? -2 : B64_CODE[c2];
    const v3 = c3 === undefined ? -1 : c3 === 61 ? -2 : B64_CODE[c3];
    if (p < out.length) {
      out[p++] = (c0 << 2) | (c1 >> 4);
    }
    if (v2 !== -1 && v2 !== -2 && p < out.length) {
      out[p++] = ((c1 & 0xf) << 4) | (v2 >> 2);
    }
    if (v3 !== -1 && v3 !== -2 && p < out.length) {
      out[p++] = ((v2 & 0x3) << 6) | v3;
    }
  }
  return out.subarray(0, p);
}

export const DictFileService = {
  /**
   * 文件选择（限定扩展名，copyTo cachesDirectory 拿稳定本地路径）。
   * 用户取消返回 success:false（error='已取消选择文件'）。
   */
  async pickDictFile(): Promise<ServiceResult<PickedDictFile>> {
    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.allFiles],
        copyTo: 'cachesDirectory',
      });
      // v9 返回数组；兼容 mock/旧版返回单对象
      const f = (Array.isArray(res) ? res[0] : res) as {
        uri: string;
        fileCopyUri?: string | null;
        name?: string | null;
        fileName?: string | null;
        size?: number | null;
      };
      if (!f || !f.uri) {
        return { success: false, error: '选择文件失败：未获取到文件' };
      }
      const fileName = f.name ?? f.fileName ?? f.uri.split('/').pop() ?? 'dict';
      const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
      if (ext && !DICT_EXTENSIONS.includes(ext)) {
        return {
          success: false,
          error: `不支持的文件类型 .${ext}（支持 ${DICT_EXTENSIONS.join('/')}）`,
        };
      }
      const chosen = f.fileCopyUri ?? f.uri;
      // content:// 等 provider URI 无法被 RNFS 读取（部分机型 copyTo 会失败回落）
      if (!isLocalPath(chosen)) {
        return {
          success: false,
          error: '系统未能提供所选文件的本地副本，请重新选择（建议把文件放到「下载」目录后再试）',
        };
      }
      return {
        success: true,
        data: {
          uri: chosen,
          fileName,
          size: f.size ?? 0,
        },
      };
    } catch (e) {
      if (DocumentPicker.isCancel(e)) {
        return { success: false, error: '已取消选择文件' };
      }
      return { success: false, error: `选择文件失败：${(e as Error).message}` };
    }
  },

  /**
   * 多选文件（StarDict 三件套成组导入用）：逐文件校验扩展名与本地路径，
   * 全部通过才返回列表；任一文件无效整体失败（避免用户漏选后半夜报错难排查）。
   * 用户取消返回 success:false（error='已取消选择文件'）。
   */
  async pickDictFiles(): Promise<ServiceResult<PickedDictFile[]>> {
    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.allFiles],
        copyTo: 'cachesDirectory',
        allowMultiSelection: true,
      });
      const raw = (Array.isArray(res) ? res : [res]) as Array<{
        uri: string;
        fileCopyUri?: string | null;
        name?: string | null;
        fileName?: string | null;
        size?: number | null;
      }>;
      const out: PickedDictFile[] = [];
      for (const f of raw) {
        if (!f || !f.uri) {
          return { success: false, error: '选择文件失败：未获取到文件' };
        }
        const fileName = f.name ?? f.fileName ?? f.uri.split('/').pop() ?? 'dict';
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        if (ext && !DICT_EXTENSIONS.includes(ext)) {
          return {
            success: false,
            error: `不支持的文件类型 .${ext}（${fileName}；支持 ${DICT_EXTENSIONS.join('/')}）`,
          };
        }
        const chosen = f.fileCopyUri ?? f.uri;
        if (!isLocalPath(chosen)) {
          return {
            success: false,
            error: `${fileName}：系统未能提供本地副本，请重新选择（建议把文件放到「下载」目录后再试）`,
          };
        }
        out.push({ uri: chosen, fileName, size: f.size ?? 0 });
      }
      if (out.length === 0) {
        return { success: false, error: '选择文件失败：未获取到文件' };
      }
      return { success: true, data: out };
    } catch (e) {
      if (DocumentPicker.isCancel(e)) {
        return { success: false, error: '已取消选择文件' };
      }
      return { success: false, error: `选择文件失败：${(e as Error).message}` };
    }
  },

  /**
   * 供 parser ctx 的分块读取实现：RNFS.read（base64）→ Uint8Array。
   * fileSize 经 RNFS.stat 获取。
   */
  async createChunkReader(
    uri: string,
  ): Promise<{ fileSize: number; readChunk(pos: number, len: number): Promise<Uint8Array> }> {
    // file:// 前缀 + URL 编码会让 RNFS（java.io.File）找不到文件 → "File does not exist"
    const path = toLocalPath(uri);
    const stat = await RNFS.stat(path);
    const fileSize = Number(stat.size);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      throw new Error('无法读取文件大小');
    }
    return {
      fileSize,
      readChunk: async (pos: number, len: number): Promise<Uint8Array> => {
        const total = Math.max(len, 0);
        if (total <= 0) {
          return new Uint8Array(0);
        }
        // 循环分段读取：单次 RNFS.read 建议不超过 4MB，
        // 超限（如 StarDict full 模式整读 .idx.gz）必须拼接，静默截断会导致解压必坏
        const parts: Uint8Array[] = [];
        let got = 0;
        while (got < total) {
          const take = Math.min(total - got, READ_CHUNK_LIMIT);
          const b64 = await RNFS.read(path, take, pos + got, 'base64');
          const part = bytesFromBase64(b64);
          if (part.length === 0) {
            break; // 文件提前结束（请求越界）
          }
          parts.push(part);
          got += part.length;
          if (part.length < take) {
            break; // 已到文件尾
          }
        }
        if (parts.length === 1) {
          return parts[0];
        }
        const out = new Uint8Array(got);
        let off = 0;
        for (const part of parts) {
          out.set(part, off);
          off += part.length;
        }
        return out;
      },
    };
  },
};

export default DictFileService;
