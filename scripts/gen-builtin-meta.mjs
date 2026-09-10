#!/usr/bin/env node
/**
 * gen-builtin-meta.mjs — 从既有 assets/books/<id>.txt 生成章节字节索引
 * books/<id>.meta.json（运行时按章 RNFS.read 切片读取，根治整读大文件
 * 阻塞 JS 的问题；见 UserBookService「章节字节索引」注释）。
 *
 * 章节枚举规则与 build-builtin-assets.mjs deriveTocWithRanges 逐字对齐
 *（@@CH@@ 切章、空正文不占 order、前置正文为「开篇」）——若该脚本的
 * 推导逻辑有改动，必须同步此处。
 *
 * 用法：node scripts/gen-builtin-meta.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(
  __dirname,
  '..',
  'android',
  'app',
  'src',
  'main',
  'assets',
  'books',
);

function deriveTocWithRanges(text, bookId) {
  const lines = text.split('\n');
  const raw = [];
  let cur = null;
  let prefaceHasBody = false;
  let markerCount = 0;
  let off = 0;
  let firstMarkerStart = -1;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const lineStart = off;
    // 末个 split 元素（文本以 \n 结尾时为空串）不带真实换行，不加 1
    off = lineStart + Buffer.byteLength(line, 'utf8') + (li < lines.length - 1 ? 1 : 0);
    const m = /^@@CH@@(.*)$/.exec(line);
    if (m) {
      markerCount += 1;
      if (firstMarkerStart < 0) firstMarkerStart = lineStart;
      if (cur) {
        cur.e = lineStart;
        raw.push(cur);
      }
      cur = {
        title: m[1].trim() || `第${markerCount}章`,
        hasBody: false,
        s: off,
        e: 0,
      };
    } else if (cur) {
      if (line.trim()) cur.hasBody = true;
    } else if (line.trim()) {
      prefaceHasBody = true;
    }
  }
  if (cur) {
    cur.e = off;
    raw.push(cur);
  }
  const toc = [];
  let order = 0;
  if (prefaceHasBody) {
    order += 1;
    toc.push({
      id: `${bookId}-c${order}`,
      t: '开篇',
      s: 0,
      e: firstMarkerStart >= 0 ? firstMarkerStart : off,
    });
  }
  for (const ch of raw) {
    if (!ch.hasBody) continue;
    order += 1;
    toc.push({ id: `${bookId}-c${order}`, t: ch.title, s: ch.s, e: ch.e });
  }
  return toc;
}

const files = fs
  .readdirSync(ASSETS_DIR)
  .filter((f) => f.endsWith('.txt'))
  .sort();
let count = 0;
for (const f of files) {
  const bookId = f.replace(/\.txt$/, '');
  const text = fs.readFileSync(path.join(ASSETS_DIR, f), 'utf8');
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  const chapters = deriveTocWithRanges(text, bookId);
  if (chapters.length === 0) {
    console.error(`${bookId}: 无有效章节，跳过`);
    continue;
  }
  const payload = { v: 1, bookId, sizeBytes, chapters };
  fs.writeFileSync(
    path.join(ASSETS_DIR, `${bookId}.meta.json`),
    JSON.stringify(payload),
    'utf8',
  );
  count += 1;
  console.log(
    `${bookId.padEnd(18)} ${String(chapters.length).padStart(4)} 章 ${String(sizeBytes).padStart(9)} B`,
  );
}
console.log(`\n已生成 ${count} 份 meta 索引 → ${ASSETS_DIR}`);
