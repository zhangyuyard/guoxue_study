/**
 * 词条内容渲染器（EntryContent）
 * 三模式（§8.10 HTML 渲染安全约束）：
 *   - structured：DictSense[] JSON → 义项编号 / 词性 / 例句 / 书证（书证斜体）
 *   - html：MDX HTML 白名单子集渲染；未知标签文本化；img 仅允许 data: 与
 *     resources 表解析出的 data URI（否则占位）；禁止 WebView / eval
 *   - plain：原样文本
 */
import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { DictContentType, DictSense } from '@/types/dict';
import { DictDatabase } from '@/services/dict/DictDatabase';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';

// ============ structured 模式 ============

/** 圈号数字（义项编号） */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];

function senseIndex(i: number): string {
  return CIRCLED[i] ?? `(${i + 1}) `;
}

function StructuredContent({
  content,
  colors,
}: {
  content: string;
  colors: ThemeColors;
}): React.JSX.Element | null {
  const senses = useMemo<DictSense[]>(() => {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as DictSense[]) : [];
    } catch {
      return [];
    }
  }, [content]);

  if (senses.length === 0) {
    return content ? (
      <Text style={[styles.plainText, { color: colors.text }]}>{content}</Text>
    ) : null;
  }

  return (
    <View style={styles.senseWrap}>
      {senses.map((sense, i) => (
        <View key={`sense-${i}`} style={styles.senseItem}>
          <Text style={[styles.senseText, { color: colors.text }]}>
            <Text style={{ color: colors.primary }}>{senseIndex(i)}</Text>
            {sense.pos ? <Text style={styles.posText}>{`〔${sense.pos}〕`}</Text> : null}
            {sense.label ? <Text style={styles.labelText}>{`〈${sense.label}〉`}</Text> : null}
            {sense.def}
          </Text>
          {sense.examples && sense.examples.length > 0 ? (
            <View style={styles.exampleWrap}>
              {sense.examples.map((ex, j) => (
                <Text key={`ex-${i}-${j}`} style={[styles.exampleText, { color: colors.textSecondary }]}>
                  {`例：${ex}`}
                </Text>
              ))}
            </View>
          ) : null}
          {sense.citations && sense.citations.length > 0 ? (
            <View style={styles.exampleWrap}>
              {sense.citations.map((cit, j) => (
                <Text key={`cit-${i}-${j}`} style={[styles.citationText, { color: colors.pinyin }]}>
                  {cit}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

// ============ html 模式（白名单子集渲染） ============

/** HTML 节点模型 */
type HtmlNode =
  | { type: 'text'; text: string }
  | { type: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

/** 常见实体解码 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 轻量 HTML 解析（白名单外的标签保留其文本子节点） */
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  // 栈内存放「已挂到父级 children 的元素节点」，children 数组原地扩充
  const stack: Extract<HtmlNode, { type: 'element' }>[] = [];
  const current = (): HtmlNode[] => (stack.length > 0 ? stack[stack.length - 1].children : root);

  let i = 0;
  let textStart = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      i += 1;
      continue;
    }
    // 文本节点
    if (i > textStart) {
      const text = decodeEntities(html.slice(textStart, i));
      if (text.trim().length > 0 || /\s/.test(text)) {
        current().push({ type: 'text', text });
      }
    }
    const closeIdx = html.indexOf('>', i);
    if (closeIdx < 0) {
      break; // 未闭合的残缺标签：按文本收尾
    }
    const rawTag = html.slice(i + 1, closeIdx).trim();

    if (rawTag.startsWith('/')) {
      // 闭合标签：出栈到匹配项（未匹配的忽略）
      const tag = rawTag.slice(1).toLowerCase();
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].tag === tag) {
          // 更深层未闭合的元素已就地挂在各自父级 children 中，仅收缩栈即可
          stack.length = s;
          break;
        }
      }
      i = closeIdx + 1;
      textStart = i;
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const nameMatch = body.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';
    // 属性解析（k=v / k='v' / k="v"）
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(body)) !== null) {
      attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
    }

    if (selfClosing || tag === 'br' || tag === 'img' || tag === 'hr') {
      current().push({ type: 'element', tag, attrs, children: [] });
    } else {
      // 元素节点立即挂入父级 children，入栈后原地扩充其 children
      const node: Extract<HtmlNode, { type: 'element' }> = { type: 'element', tag, attrs, children: [] };
      current().push(node);
      stack.push(node);
    }
    i = closeIdx + 1;
    textStart = i;
  }
  if (textStart < html.length) {
    const text = decodeEntities(html.slice(textStart));
    if (text.length > 0) {
      current().push({ type: 'text', text });
    }
  }
  return root;
}

/** 允许渲染的标签白名单 */
const TAG_WHITELIST = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'sup', 'sub',
  'br', 'hr', 'p', 'div', 'span',
  'ul', 'ol', 'li', 'table', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'font', 'a', 'img',
]);

/** inline 样式标签 → 文本样式片段 */
const INLINE_TAG_STYLES: Record<string, { fontWeight?: '700'; fontStyle?: 'italic'; textDecorationLine?: 'underline' | 'line-through' }> = {
  b: { fontWeight: '700' },
  strong: { fontWeight: '700' },
  i: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  u: { textDecorationLine: 'underline' },
  s: { textDecorationLine: 'line-through' },
};

/** 块级标签：渲染后补换行 */
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'hr']);

/** 解析 img src 为可渲染的 data URI（data: 直通；其余查 resources 表） */
function resolveImageSrc(src: string): { uri: string } | null {
  const direct = src.trim();
  if (direct.toLowerCase().startsWith('data:')) {
    return { uri: direct };
  }
  // mdd 资源：尝试原始键与去斜杠变体
  const candidates = [direct, direct.replace(/^\/+/, ''), direct.replace(/^\/?data\/+/, '')];
  for (const key of candidates) {
    if (!key || key.includes('..')) {
      continue;
    }
    const res = DictDatabase.getResource(key);
    if (res) {
      return { uri: `data:${res.mime};base64,${res.dataBase64}` };
    }
  }
  return null;
}

/** 渲染白名单节点树为 RN Text 嵌套；未知标签仅保留文本 */
function renderNodes(
  nodes: HtmlNode[],
  colors: ThemeColors,
  images: { uri: string }[],
  keyPrefix: string,
): React.JSX.Element[] {
  const out: React.JSX.Element[] = [];
  nodes.forEach((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (node.type === 'text') {
      out.push(
        <Text key={key} style={{ color: colors.text }}>
          {node.text}
        </Text>,
      );
      return;
    }
    const { tag, attrs, children } = node;
    if (!TAG_WHITELIST.has(tag)) {
      // 未知/不允许的标签：文本化（仅保留其子文本）
      out.push(<React.Fragment key={key}>{renderNodes(children, colors, images, key)}</React.Fragment>);
      return;
    }
    if (tag === 'br') {
      out.push(<Text key={key}>{'\n'}</Text>);
      return;
    }
    if (tag === 'hr') {
      out.push(<Text key={key}>{'\n————————\n'}</Text>);
      return;
    }
    if (tag === 'img') {
      const src = resolveImageSrc(attrs.src ?? '');
      if (src) {
        images.push(src);
        out.push(
          <Text key={key} style={{ color: colors.textSecondary }}>{`［图 ${images.length}］`}</Text>,
        );
      } else {
        out.push(<Text key={key} style={{ color: colors.textSecondary }}>［图片缺失］</Text>);
      }
      return;
    }
    const inlineStyle = INLINE_TAG_STYLES[tag];
    const fontSizeAdj = tag === 'sup' || tag === 'sub' ? 10 : undefined;
    const childElements = renderNodes(children, colors, images, key);
    if (inlineStyle || fontSizeAdj) {
      out.push(
        <Text key={key} style={{ ...inlineStyle, ...(fontSizeAdj ? { fontSize: fontSizeAdj } : {}) }}>
          {childElements}
        </Text>,
      );
    } else {
      out.push(
        <React.Fragment key={key}>
          {childElements}
          {BLOCK_TAGS.has(tag) ? <Text>{'\n'}</Text> : null}
        </React.Fragment>,
      );
    }
  });
  return out;
}

function HtmlContent({ content, colors }: { content: string; colors: ThemeColors }): React.JSX.Element {
  // 块级图片先收集（data URI / 资源表），正文内以 ［图 N］ 占位，正文下方整块渲染
  const { textElements, images } = useMemo(() => {
    const nodes = parseHtml(content);
    const imgs: { uri: string }[] = [];
    const elements = renderNodes(nodes, colors, imgs, 'n');
    return { textElements: elements, images: imgs };
  }, [content, colors]);

  return (
    <View>
      <Text style={styles.htmlText}>{textElements}</Text>
      {images.map((img, i) => (
        <View key={`img-${i}`} style={styles.imageWrap}>
          <Image source={img} style={styles.image} resizeMode="contain" />
        </View>
      ))}
    </View>
  );
}

// ============ 对外组件 ============

export interface EntryContentProps {
  contentType: DictContentType;
  content: string;
}

/** 词条内容三模式渲染（structured / html / plain） */
function EntryContent({ contentType, content }: EntryContentProps): React.JSX.Element | null {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  if (!content) {
    return null;
  }
  if (contentType === 'structured') {
    return <StructuredContent content={content} colors={colors} />;
  }
  if (contentType === 'html') {
    return <HtmlContent content={content} colors={colors} />;
  }
  return <Text style={[styles.plainText, { color: colors.text }]}>{content}</Text>;
}

const styles = StyleSheet.create({
  plainText: {
    fontSize: 15,
    lineHeight: 24,
  },
  htmlText: {
    fontSize: 15,
    lineHeight: 24,
  },
  senseWrap: {
    gap: 8,
  },
  senseItem: {
    gap: 2,
  },
  senseText: {
    fontSize: 15,
    lineHeight: 24,
  },
  posText: {
    fontSize: 13,
    opacity: 0.8,
  },
  labelText: {
    fontSize: 13,
    opacity: 0.7,
  },
  exampleWrap: {
    paddingLeft: 18,
    gap: 2,
  },
  exampleText: {
    fontSize: 13,
    lineHeight: 20,
  },
  citationText: {
    fontSize: 13,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  imageWrap: {
    marginTop: 8,
    borderRadius: 8,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: 180,
  },
});

export default EntryContent;
