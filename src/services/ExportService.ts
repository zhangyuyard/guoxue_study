/**
 * 导出服务（P1-11）
 * - writeExportFile：导出内容写入 文档目录/exports/（RNFS），返回完整路径供成功提示
 * - shareExportText：调起系统分享面板（React Native 内置 Share）分享纯文本，超长自动截断
 * 不新增第三方依赖：文件写入用 react-native-fs，分享用 RN 内置 Share。
 */
import { Share } from 'react-native';
import RNFS from 'react-native-fs';
import type { ServiceResult } from '@/types';
import { formatExportStamp, truncateForShare } from '@/utils/exporters';

/** 导出子目录名（相对 DocumentDirectoryPath） */
const EXPORT_DIR_NAME = 'exports';

/** 导出目录绝对路径：DocumentDirectoryPath/exports/ */
function exportDir(): string {
  return `${RNFS.DocumentDirectoryPath}/${EXPORT_DIR_NAME}`;
}

/** 写入导出文件（md / txt），成功返回完整路径（文件名 prefix-YYYYMMDD-HHmm.ext） */
export async function writeExportFile(
  prefix: string,
  ext: 'md' | 'txt',
  content: string,
  now: Date = new Date(),
): Promise<ServiceResult<string>> {
  try {
    const dir = exportDir();
    // mkdir 对已存在目录会 reject，忽略
    await RNFS.mkdir(dir).catch(() => undefined);
    const path = `${dir}/${prefix}-${formatExportStamp(now)}.${ext}`;
    await RNFS.writeFile(path, content, 'utf8');
    return { success: true, data: path };
  } catch (e) {
    return { success: false, error: `导出失败：${(e as Error).message}` };
  }
}

/** 调起系统分享面板分享纯文本内容（超长截断并注明） */
export async function shareExportText(content: string): Promise<ServiceResult<boolean>> {
  try {
    const res = await Share.share({ message: truncateForShare(content) });
    if (res.action === Share.dismissedAction) {
      return { success: false, error: '分享已取消' };
    }
    return { success: true, data: true };
  } catch (e) {
    return { success: false, error: `分享失败：${(e as Error).message}` };
  }
}

export const ExportService = { writeExportFile, shareExportText };

export default ExportService;
