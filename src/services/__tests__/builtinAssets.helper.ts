/**
 * 测试助手：从 APK assets 目录（磁盘路径）按目录清单解析内置书。
 * 2026-09 书体资产化后，内置书正文在 android/app/src/main/assets/books/<id>.txt
 * （@@CH@@ 标记文本），运行时由 UserBookService 物化+解析；测试环境直接读磁盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Book } from '@/types';
import { BUILTIN_CATALOG } from '@/data/builtinCatalog';
import { parseTxtBook } from '@/services/UserBookService';

const ASSETS_DIR = path.resolve(__dirname, '../../../android/app/src/main/assets/books');

/** 解析指定内置书（缺省全部 28 部；可传子集避免大书解析开销） */
export function loadBuiltinBooks(ids?: string[]): Book[] {
  const wanted = ids ?? BUILTIN_CATALOG.map((b) => b.id);
  return wanted.map((id) => {
    const spec = BUILTIN_CATALOG.find((b) => b.id === id);
    if (!spec) {
      throw new Error(`builtinCatalog 中不存在书籍：${id}`);
    }
    const text = fs.readFileSync(path.join(ASSETS_DIR, `${id}.txt`), 'utf8');
    const book = parseTxtBook(`${id}.txt`, text, spec.id, {
      markers: true,
      sourceLabel: '内置',
    });
    book.title = spec.title;
    book.author = spec.author;
    book.category = spec.category;
    book.description = spec.description;
    return book;
  });
}
