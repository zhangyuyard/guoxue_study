/**
 * 章节字节索引（meta）对齐性守卫测试。
 * 背景：meta 快路径是首开水合/填充/FTS 装载的正源（按章 RNFS.read 切片，
 * 零整读），其章序与内容必须与全本解析逐章逐段等价——本文件对全部内置书
 * 做全量对拍：
 *   1. meta 存在、版本/书号/大小指纹合法；
 *   2. 章数与全本解析一致，id/title 逐条一致；
 *   3. 每章按 meta 字节区间切片再独立解析，segments 与全本解析逐段一致。
 * 任何改资产构建（deriveTocWithRanges / gen-builtin-meta.mjs）或解析器
 * 切章语义的改动，必须保持本文件全绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_CATALOG } from '@/data/builtinCatalog';
import { parseTxtBook } from '@/services/UserBookService';

const ASSETS_DIR = path.resolve(
  __dirname,
  '../../../android/app/src/main/assets/books',
);

interface MetaChapter {
  id: string;
  t: string;
  s: number;
  e: number;
}
interface MetaFile {
  v: number;
  bookId: string;
  sizeBytes: number;
  chapters: MetaChapter[];
}

const CATALOG_IDS = BUILTIN_CATALOG.map((b) => b.id);

describe('章节字节索引（meta）与全本解析全量对拍', () => {
  test.each(CATALOG_IDS)('%s：meta 合法且逐章等价', (bookId) => {
    const metaPath = path.join(ASSETS_DIR, `${bookId}.meta.json`);
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MetaFile;

    // 1. 合法性
    expect(meta.v).toBe(1);
    expect(meta.bookId).toBe(bookId);
    expect(meta.chapters.length).toBeGreaterThan(0);

    const txtPath = path.join(ASSETS_DIR, `${bookId}.txt`);
    const buf = fs.readFileSync(txtPath);
    expect(meta.sizeBytes).toBe(buf.length);

    // 2/3. 与全本解析逐章逐段对拍
    const text = buf.toString('utf8');
    const full = parseTxtBook(`${bookId}.txt`, text, bookId, {
      markers: true,
      sourceLabel: '内置',
    });
    expect(meta.chapters.length).toBe(full.chapters.length);

    for (let i = 0; i < meta.chapters.length; i += 1) {
      const c = meta.chapters[i];
      const fullCh = full.chapters[i];
      expect(c.id).toBe(`${bookId}-c${i + 1}`);
      expect(c.id).toBe(fullCh.id);
      expect(c.t).toBe(fullCh.title);
      expect(c.s).toBeGreaterThanOrEqual(0);
      expect(c.e).toBeGreaterThan(c.s);
      expect(c.e).toBeLessThanOrEqual(meta.sizeBytes);

      // 切片独立解析 == 全本解析对应章
      const sliceText = buf.subarray(c.s, c.e).toString('utf8');
      const sliceParsed = parseTxtBook(
        `${bookId}.txt`,
        `@@CH@@${c.t}\n${sliceText}`,
        bookId,
        { markers: true },
      );
      expect(sliceParsed.chapters.length).toBe(1);
      expect(sliceParsed.chapters[0].segments.map((s) => s.text)).toEqual(
        fullCh.segments.map((s) => s.text),
      );
      expect(sliceParsed.chapters[0].segments.length).toBe(
        fullCh.segments.length,
      );
    }
  });
});
