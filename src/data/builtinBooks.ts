/**
 * 内置经典书籍模板（BUILTIN_BOOKS）。
 * 从 TextLibraryService 抽出为独立数据模块，供两处消费：
 *   - TextLibraryService：启动时全量装载进内存（正源，阅读/搜索/注音均基于此）；
 *   - UserBookService：首次启动把每部书物化为 guoxue-books/builtin/<id>.txt
 *     纯文本资源文件（@@CH@@ 章节标记格式），让「所有书籍资源落在统一书籍
 *     文件夹」且内置书可被用户删除（删除 = 删文件 + 抑制记录，见
 *     UserBookService.deleteBook / restoreBuiltinBooks）。
 * 注意：内置书的阅读数据始终以 bundle 内 JSON 为正源，物化文件仅是资源副本，
 * 不参与解析装载（避免重解析改变章节/段落 ID 破坏既有背诵进度/笔记挂接）。
 */
import type { Book } from '@/types';

import daodejingData from '@/data/texts/daodejing.json';
import lunyuData from '@/data/texts/lunyu.json';
import daxueData from '@/data/texts/daxue.json';
import zhongyongData from '@/data/texts/zhongyong.json';
import mengziData from '@/data/texts/mengzi.json';
import zhuangziData from '@/data/texts/zhuangzi.json';
import shijingData from '@/data/texts/shijing.json';
import xunziData from '@/data/texts/xunzi.json';
import chuciData from '@/data/texts/chuci.json';
import tangshiData from '@/data/texts/tangshi.json';
import zhouyiData from '@/data/texts/zhouyi.json';
import zuozhuanData from '@/data/texts/zuozhuan.json';
import shijiData from '@/data/texts/shiji.json';
import tongjianData from '@/data/texts/tongjian.json';
import moziData from '@/data/texts/mozi.json';
import wenxuanData from '@/data/texts/wenxuan.json';

/** 内置书籍原始数据（16 部：经部 7 部 + 史部 2 部 + 子部 4 部 + 集部 3 部） */
export const BUILTIN_BOOKS: Book[] = [
  daodejingData,
  lunyuData,
  daxueData,
  zhongyongData,
  mengziData,
  zhuangziData,
  shijingData,
  xunziData,
  chuciData,
  tangshiData,
  zhouyiData,
  zuozhuanData,
  shijiData,
  tongjianData,
  moziData,
  wenxuanData,
] as Book[];

/** 按 ID 查内置书模板 */
export function getBuiltinTemplate(id: string): Book | undefined {
  return BUILTIN_BOOKS.find((b) => b.id === id);
}
