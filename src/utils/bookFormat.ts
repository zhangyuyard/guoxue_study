/**
 * 多格式书籍文本转换器（纯函数，可单测）。
 *
 * 结构化格式统一降维为「带章节标记的纯文本」，再交给 UserBookService.parseTxtBook
 * 复用既有章节/段落解析：
 *   - HTML/XHTML：剥脚本样式与标签、块级元素转行、实体解码（h1-h3 可转章节标记）；
 *   - Markdown：#/##/### 标题行转章节标记（代码块内不转换）；
 *   - FB2（FictionBook XML）：section/title 转章节标记、p/empty-line 转段落；
 *   - EPUB：zip 容器 → container.xml → OPF（manifest/spine）→ 逐 spine 文档
 *     提取正文，章节标题取 toc.ncx navLabel，缺省回退文档 <h1-3> / <title>；
 *   - DOCX（OOXML zip）：word/document.xml 段落提取，Heading1-3/大纲级别切章；
 *   - ODT（OpenDocument zip）：content.xml 的 text:h/text:p 提取；
 *   - ZIP：优先按 EPUB 解析，否则收集包内 txt/html/md/fb2/epub 条目按文件名切章；
 *   - RTF / MOBI：见 rtf.ts / mobi.ts。
 *
 * 章节标记行格式：`@@CH@@标题`（标题可空，由解析层补「第N章」）。
 */
import { decodeTextBytes } from '@/utils/textEncoding';
import { listZipEntries, readZipEntry } from '@/utils/zipReader';
import {
  CHAPTER_MARKER,
  type StructuredText,
  decodeHtmlEntities,
  htmlToText,
  normalizeTail,
  tagText,
} from '@/utils/htmlText';
import { mobiExtractText } from '@/utils/mobi';
import { rtfToText } from '@/utils/rtf';

export { CHAPTER_MARKER };
export type { StructuredText };
export { htmlToText, decodeHtmlEntities };

// ============ Markdown ============

/** Markdown → 纯文本：1-3 级标题行转章节标记（围栏代码块内不转换） */
export function mdToMarkerText(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const h = /^#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (h) {
        out.push(`${CHAPTER_MARKER}${h[1].trim()}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// ============ FB2（FictionBook XML） ============

/** FB2 → 纯文本：取正文 body（忽略 notes），section 标题转章节标记 */
export function fb2ToText(xml: string): StructuredText {
  const title = tagText(xml, 'book-title');
  let author: string | undefined;
  const authorEl = /<author>([\s\S]*?)<\/author>/i.exec(xml);
  if (authorEl) {
    const first = tagText(authorEl[1], 'first-name');
    const last = tagText(authorEl[1], 'last-name');
    const nick = tagText(authorEl[1], 'nickname');
    author = [first, last].filter(Boolean).join(' ') || nick || undefined;
  }

  let body = xml.replace(/<binary[\s\S]*?<\/binary>/gi, '');
  const bodies = [...body.matchAll(/<body[^>]*>([\s\S]*?)<\/body>/gi)];
  if (bodies.length > 0) {
    body = bodies[0][1];
  }
  body = body.replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, (_, inner: string) => {
    const t = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return t ? `\n${CHAPTER_MARKER}${t}\n` : '\n';
  });
  body = body.replace(/<empty-line\s*\/?>/gi, '\n');
  body = body.replace(/<\/p\s*>/gi, '\n').replace(/<p\b[^>]*>/gi, '');
  body = body.replace(/<[^>]+>/g, '');
  body = decodeHtmlEntities(body);
  return { title, author, text: normalizeTail(body) };
}

// ============ EPUB ============

function decodeUriSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 以 baseDir 解析相对路径，返回 zip 内规范路径 */
function resolveHref(baseDir: string, href: string): string {
  const clean = decodeUriSafe(href.trim());
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    return clean;
  }
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function xmlAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? m[2] ?? m[3] : undefined;
}

/**
 * EPUB → 纯文本（zip 字节流直接解析）。
 * 按 spine 顺序逐文档提取，每个文档视为一章：
 *   章节标题优先取 toc.ncx 的 navLabel，回退文档 h1-h3，再回退 <title>；
 *   全部缺失且多文档时补「第N章」。
 */
export function epubExtractText(bytes: Uint8Array): StructuredText {
  const entries = listZipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const readEntryText = (name: string): string | null => {
    const e = byName.get(name);
    if (!e) {
      return null;
    }
    // EPUB 规范要求内容为 UTF-8/UTF-16；个别损坏文件走编码检测兜底
    const data = readZipEntry(bytes, e);
    return decodeTextBytes(data).text;
  };

  // 1) container.xml → OPF 路径
  const container = readEntryText('META-INF/container.xml');
  if (!container) {
    throw new Error('无效的 EPUB 文件（缺少 container.xml）');
  }
  const opfPathRaw = /<rootfile\b[^>]*\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(container);
  const opfPath = opfPathRaw ? opfPathRaw[2] ?? opfPathRaw[3] : undefined;
  if (!opfPath) {
    throw new Error('无效的 EPUB 文件（缺少 rootfile）');
  }
  const opf = readEntryText(opfPath);
  if (!opf) {
    throw new Error(`无效的 EPUB 文件（找不到 ${opfPath}）`);
  }
  const opfDir = dirname(opfPath);

  // 2) 元数据
  const title = tagText(opf, 'dc:title');
  const author = tagText(opf, 'dc:creator');

  // 3) manifest + spine
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const id = xmlAttr(m[0], 'id');
    const href = xmlAttr(m[0], 'href');
    if (id && href) {
      manifest.set(id, { href, mediaType: xmlAttr(m[0], 'media-type') ?? '' });
    }
  }
  const spineEl = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf);
  const tocId = spineEl ? xmlAttr(spineEl[0], 'toc') : undefined;
  const order: string[] = [];
  if (spineEl) {
    for (const m of spineEl[1].matchAll(/<itemref\b[^>]*\/?>/gi)) {
      const idref = xmlAttr(m[0], 'idref');
      if (idref) {
        order.push(idref);
      }
    }
  }

  // spine 为空时回退：按 zip 顺序取全部 html 文档
  const isHtmlItem = (href: string, mediaType: string): boolean =>
    /xhtml|html/i.test(mediaType) || /\.(x?html|htm)$/i.test(href);
  let docs: Array<{ path: string }> = [];
  if (order.length > 0) {
    docs = order
      .map((id) => manifest.get(id))
      .filter((it): it is { href: string; mediaType: string } => !!it)
      .filter((it) => isHtmlItem(it.href, it.mediaType))
      .map((it) => ({ path: resolveHref(opfDir, it.href) }));
  } else {
    docs = entries
      .filter((e) => /\.(x?html|htm)$/i.test(e.name) && !e.name.startsWith('__MACOSX'))
      .map((e) => ({ path: e.name }));
  }

  // 4) toc.ncx 章节标题（key 为 zip 内规范路径）
  const chapterTitles = new Map<string, string>();
  const ncxHref = tocId ? manifest.get(tocId)?.href : undefined;
  const ncxPath = ncxHref ? resolveHref(opfDir, ncxHref) : undefined;
  const ncx = ncxPath ? readEntryText(ncxPath) : null;
  if (ncx) {
    const ncxDir = dirname(ncxPath ?? '');
    for (const np of ncx.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/gi)) {
      const label = /<navLabel\b[^>]*>([\s\S]*?)<\/navLabel>/i.exec(np[0])?.[1];
      const src = /<content\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(np[0]);
      const srcVal = src ? src[2] ?? src[3] : undefined;
      if (label && srcVal) {
        const t = decodeHtmlEntities(label.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        const key = resolveHref(ncxDir, srcVal.split('#')[0]);
        if (t && key && !chapterTitles.has(key)) {
          chapterTitles.set(key, t);
        }
      }
    }
  }

  // 5) 逐文档提取正文
  const forceMarkers = docs.length > 1;
  const parts: string[] = [];
  let idx = 0;
  for (const doc of docs) {
    const raw = readEntryText(doc.path);
    if (raw == null) {
      continue;
    }
    const bodyText = htmlToText(raw);
    if (!bodyText) {
      continue;
    }
    idx += 1;
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(raw)?.[1];
    const docTitle =
      chapterTitles.get(doc.path) ??
      (heading ? decodeHtmlEntities(heading.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : undefined) ??
      tagText(raw, 'title');
    if (forceMarkers || docTitle) {
      parts.push(`${CHAPTER_MARKER}${docTitle ?? ''}`);
    }
    parts.push(bodyText);
    if (idx >= 5000) {
      break;
    }
  }
  return { title, author, text: normalizeTail(parts.join('\n\n')) };
}

// ============ DOCX（OOXML zip） ============

function readZipText(bytes: Uint8Array, name: string): string | null {
  const entry = listZipEntries(bytes).find((e) => e.name === name);
  if (!entry) {
    return null;
  }
  return decodeTextBytes(readZipEntry(bytes, entry)).text;
}

/** DOCX → 纯文本：word/document.xml 段落提取，Heading1-3/大纲级别切章 */
export function docxExtractText(bytes: Uint8Array): StructuredText {
  const doc = readZipText(bytes, 'word/document.xml');
  if (!doc) {
    throw new Error('无效的 DOCX 文件（缺少 word/document.xml）');
  }
  const lines: string[] = [];
  for (const p of doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const style = /<w:pStyle\b[^>]*\bw:val\s*=\s*"([^"]*)"/i.exec(p)?.[1] ?? '';
    const outline = /<w:outlineLvl\b[^>]*\bw:val\s*=\s*"([^"]*)"/i.exec(p)?.[1];
    // 英文 Word 用 Heading1-3；中文 Word 的标题样式 styleId 是 "1"/"2"/"3"
    const isHeading =
      /heading[1-3]/i.test(style) || /^[1-3]$/.test(style) || ['0', '1', '2'].includes(outline ?? '');
    let text = p
      .replace(/<w:tab\b[^>]*\/?>/gi, ' ')
      .replace(/<w:br\b[^>]*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    text = decodeHtmlEntities(text)
      .replace(/[ \t\u00a0]+/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
    if (!text) {
      continue;
    }
    lines.push(isHeading ? `${CHAPTER_MARKER}${text}` : text);
  }
  const core = readZipText(bytes, 'docProps/core.xml');
  return {
    title: core ? tagText(core, 'dc:title') : undefined,
    author: core ? tagText(core, 'dc:creator') : undefined,
    text: lines.join('\n\n'),
  };
}

// ============ ODT（OpenDocument zip） ============

/** ODT → 纯文本：content.xml 的 text:h（1-3 级切章）与 text:p 提取 */
export function odtExtractText(bytes: Uint8Array): StructuredText {
  const content = readZipText(bytes, 'content.xml');
  if (!content) {
    throw new Error('无效的 ODT 文件（缺少 content.xml）');
  }
  const parts: string[] = [];
  for (const m of content.matchAll(/<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1\s*>/gi)) {
    const level = /text:outline-level\s*=\s*"([1-3])"/i.exec(m[2])?.[1];
    let text = m[3]
      .replace(/<text:tab\b[^>]*\/?>/gi, ' ')
      .replace(/<text:line-break\b[^>]*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    text = decodeHtmlEntities(text).replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!text) {
      continue;
    }
    parts.push(m[1].toLowerCase() === 'h' && level ? `${CHAPTER_MARKER}${text}` : text);
  }
  const meta = readZipText(bytes, 'meta.xml');
  return {
    title: meta ? tagText(meta, 'dc:title') : undefined,
    author: meta ? tagText(meta, 'dc:creator') : undefined,
    text: parts.join('\n\n'),
  };
}

// ============ 通用 ZIP（打包的文本/EPUB） ============

/** ZIP → 纯文本：优先按 EPUB 解析；否则收集包内文本条目，按文件名切章 */
export function zipExtractText(bytes: Uint8Array): StructuredText {
  try {
    const epub = epubExtractText(bytes);
    if (epub.text.trim()) {
      return epub;
    }
  } catch {
    // 不是 EPUB 结构，走通用文本包路径
  }
  const entries = listZipEntries(bytes).filter(
    (e) =>
      !e.name.startsWith('__MACOSX') &&
      /\.(txt|html?|xhtml|md|markdown|fb2|epub)$/i.test(e.name),
  );
  if (entries.length === 0) {
    throw new Error('压缩包内没有可识别的文本文档（支持 txt/html/md/fb2/epub）');
  }
  const parts: string[] = [];
  let idx = 0;
  let metaTitle: string | undefined;
  let metaAuthor: string | undefined;
  for (const e of entries) {
    const raw = readZipEntry(bytes, e);
    const ext = e.name.split('.').pop()?.toLowerCase() ?? 'txt';
    let converted: StructuredText;
    try {
      converted = convertBookBytes(ext, raw);
    } catch {
      continue;
    }
    if (!converted.text.trim()) {
      continue;
    }
    idx += 1;
    if (!metaTitle && converted.title) {
      metaTitle = converted.title;
      metaAuthor = converted.author;
    }
    if (entries.length > 1) {
      const baseName = e.name.split('/').pop()?.replace(/\.[^.]+$/, '') ?? `第${idx}章`;
      parts.push(`${CHAPTER_MARKER}${converted.title ?? baseName}`);
    }
    parts.push(converted.text);
  }
  if (idx === 0) {
    throw new Error('压缩包内没有可识别的文本文档');
  }
  return { title: metaTitle, author: metaAuthor, text: normalizeTail(parts.join('\n\n')) };
}

// ============ 格式判定与统一入口 ============

/** 支持导入的扩展名 */
export const SUPPORTED_BOOK_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'xhtml',
  'fb2',
  'epub',
  'docx',
  'odt',
  'rtf',
  'zip',
  'mobi',
  'prc',
  'azw',
] as const;

/** 结构化格式集合（需要先转换再解析；txt 之外全部结构化） */
const STRUCTURED_EXTENSIONS = [
  'md',
  'markdown',
  'html',
  'htm',
  'xhtml',
  'fb2',
  'epub',
  'docx',
  'odt',
  'rtf',
  'zip',
  'mobi',
  'prc',
  'azw',
];

/** 按扩展名判定是否结构化格式（需要先转换再解析） */
export function isStructuredFormat(ext: string): boolean {
  return STRUCTURED_EXTENSIONS.includes(ext);
}

/** 大体积格式（含图片/压缩包），导入上限放宽到 50MB */
export const LARGE_BOOK_EXTENSIONS = ['epub', 'docx', 'odt', 'zip', 'mobi', 'prc', 'azw'];

/**
 * 统一转换入口：字节 → 章节标记文本。
 * txt 直接走编码检测；其余格式按类型转换（epub/docx/odt/zip/mobi 从 zip/二进制直接提取）。
 */
export function convertBookBytes(ext: string, bytes: Uint8Array): StructuredText {
  switch (ext) {
    case 'epub':
      return epubExtractText(bytes);
    case 'docx':
      return docxExtractText(bytes);
    case 'odt':
      return odtExtractText(bytes);
    case 'zip':
      return zipExtractText(bytes);
    case 'mobi':
    case 'prc':
    case 'azw':
      return mobiExtractText(bytes);
    case 'fb2':
      return fb2ToText(decodeTextBytes(bytes).text);
    case 'rtf':
      return rtfToText(decodeTextBytes(bytes).text);
    case 'html':
    case 'htm':
    case 'xhtml':
      return { text: htmlToText(decodeTextBytes(bytes).text, { headingMarkers: true }) };
    case 'md':
    case 'markdown':
      return { text: mdToMarkerText(decodeTextBytes(bytes).text) };
    default:
      return { text: decodeTextBytes(bytes).text };
  }
}
