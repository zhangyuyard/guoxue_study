/**
 * 公共 HTML/XML 文本提取层（供 bookFormat / rtf / mobi 复用，避免循环依赖）。
 *
 * 结构化格式的提取结果统一为 StructuredText；HTML 剥标签降维为纯文本，
 * 可选把 h1-h3 标题转换为 @@CH@@ 章节标记（独立 html 文件 / mobi 内嵌 HTML 用）。
 */

/** 结构化格式的提取结果 */
export interface StructuredText {
  title?: string;
  author?: string;
  text: string;
}

/** 章节标记行前缀（与 UserBookService.parseTxtBook 的解析约定一致） */
export const CHAPTER_MARKER = '@@CH@@';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  copy: '\u00a9',
  reg: '\u00ae',
  middot: '\u00b7',
  bull: '\u2022',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  sect: '\u00a7',
  laquo: '\u00ab',
  raquo: '\u00bb',
};

/** 码点 → 字符（越界/代理区安全，emoji 转代理对） */
export function fromCodePointSafe(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '\ufffd';
  }
  if (cp < 0x10000) {
    return String.fromCharCode(cp);
  }
  const v = cp - 0x10000;
  return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
}

/** HTML/XML 实体解码（命名实体常用集 + 十进制/十六进制数字实体） */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => fromCodePointSafe(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const mapped = NAMED_ENTITIES[name.toLowerCase()];
      return mapped ?? m;
    });
}

/** 清除标签后做行内空白折叠与空行收敛（各转换器共用的收尾） */
export function normalizeTail(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface HtmlToTextOptions {
  /** 把 h1-h3 标题块转换为 @@CH@@ 章节标记（独立 html 文件 / mobi 用；epub 有 toc 时不启用） */
  headingMarkers?: boolean;
}

/** HTML → 纯文本：剥注释/script/style/head、块级边界转行、实体解码 */
export function htmlToText(html: string, opts?: HtmlToTextOptions): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  if (opts?.headingMarkers) {
    s = s.replace(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi, (_, inner: string) => {
      const t = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      return t ? `\n${CHAPTER_MARKER}${t}\n` : '\n';
    });
  }
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(
    /<\/(p|div|h[1-6]|li|blockquote|section|article|tr|figcaption|dd|dt)\s*>/gi,
    '\n',
  );
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  return normalizeTail(s);
}

/** 取 XML/HTML 某标签的内文本（剥内部标签与实体；找不到返回 undefined） */
export function tagText(s: string, tagName: string): string | undefined {
  const m = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i').exec(s);
  if (!m) {
    return undefined;
  }
  const t = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
