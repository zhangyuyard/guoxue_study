/**
 * RTF → 纯文本解析器（子集实现，纯函数可单测）。
 *
 * RTF 是 ASCII 转义文本：{\rtf1 ... } 分组 + \控制字 + \'hh 代码页字节 + \uN Unicode。
 * 支持：
 *   - 分组与状态栈（\ansicpg 代码页 / \uc 跳过数随组恢复）；
 *   - \par/\line/\sect/\page → 换行，\tab/\cell → 空白，常用符号（\emdash 等）；
 *   - \'hh 字节缓冲按代码页解码（936 → GBK，其余按 latin1）；
 *   - \uN Unicode（负数 +65536；后续 \ucN 个回退字符跳过）；
 *   - 目的地组跳过（fonttbl/colortbl/stylesheet/info/pict/object/header/footer 等）。
 * 不支持：\bin 二进制内嵌、\shp 等复杂绘制（内容会被剥离或忽略）。
 */
import { decodeGbk } from '@/utils/textEncoding';
import { type StructuredText, normalizeTail } from '@/utils/htmlText';

/** 跳过内容的目的地控制字 */
const SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'themedata',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'xmlnstbl',
  'filetbl',
  'latentstyles',
  'datastore',
  'header',
  'footer',
  'headerl',
  'headerr',
  'footerl',
  'footerr',
  'ftnsep',
  'ftnsepc',
  'aftnsep',
  'aftnsepc',
]);

const SYMBOLS: Record<string, string> = {
  emdash: '\u2014',
  endash: '\u2013',
  bullet: '\u2022',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
  emspace: '\u2003',
  enspace: '\u2002',
  '~': '\u00a0',
};

interface GroupState {
  ucSkip: number;
  cpg: number;
}

/** RTF 源文本 → 纯文本（title/author 从 \info 组提取） */
export function rtfToText(rtf: string): StructuredText {
  const out: string[] = [];
  let pendingBytes: number[] = [];
  let ansiCpg = 1252;
  let ucSkip = 1;
  let skipChars = 0;
  const stateStack: GroupState[] = [];
  let depth = 0;
  let skipping = false;
  let skipStartDepth = 0;

  const flushBytes = (): void => {
    if (pendingBytes.length === 0) {
      return;
    }
    if (ansiCpg === 936) {
      out.push(decodeGbk(new Uint8Array(pendingBytes)));
    } else {
      out.push(String.fromCharCode(...pendingBytes));
    }
    pendingBytes = [];
  };
  const emit = (s: string): void => {
    flushBytes();
    out.push(s);
  };

  const n = rtf.length;
  let i = 0;
  while (i < n) {
    const c = rtf[i];
    if (skipping) {
      // 跳过的目的地组内只跟踪括号深度
      if (c === '{') {
        depth += 1;
        stateStack.push({ ucSkip, cpg: ansiCpg });
      } else if (c === '}') {
        depth -= 1;
        stateStack.pop();
        if (depth < skipStartDepth) {
          skipping = false;
        }
      }
      i += 1;
      continue;
    }
    if (c === '{') {
      depth += 1;
      stateStack.push({ ucSkip, cpg: ansiCpg });
      i += 1;
      continue;
    }
    if (c === '}') {
      // 先按当前代码页刷出字节缓冲，再恢复组状态（否则 \'hh 字节会用错误的 cpg 解码）
      flushBytes();
      depth -= 1;
      const st = stateStack.pop();
      if (st) {
        ucSkip = st.ucSkip;
        ansiCpg = st.cpg;
      }
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 1;
      const c2 = rtf[i];
      if (c2 === undefined) {
        break;
      }
      // 转义符号
      if (c2 === '\\' || c2 === '{' || c2 === '}') {
        emit(c2);
        i += 1;
        continue;
      }
      if (c2 === '~') {
        emit('\u00a0');
        i += 1;
        continue;
      }
      if (c2 === '*') {
        // 可忽略目的地标记：随后的目的地组按内容处理（pict 等由控制字触发跳过）
        i += 1;
        continue;
      }
      if (c2 === "'") {
        const hex = rtf.slice(i + 1, i + 3);
        const v = parseInt(hex, 16);
        if (Number.isNaN(v)) {
          i += 1;
          continue;
        }
        if (skipChars > 0) {
          skipChars -= 1;
        } else {
          pendingBytes.push(v);
        }
        i += 3;
        continue;
      }
      // 控制字：字母 + 可选参数 + 可选空格
      let j = i;
      while (j < n && rtf[j] >= 'a' && rtf[j] <= 'z') j += 1;
      while (j < n && rtf[j] >= 'A' && rtf[j] <= 'Z') j += 1;
      const word = rtf.slice(i, j);
      let paramStr = '';
      if (rtf[j] === '-') {
        paramStr += '-';
        j += 1;
      }
      while (j < n && rtf[j] >= '0' && rtf[j] <= '9') {
        paramStr += rtf[j];
        j += 1;
      }
      if (rtf[j] === ' ') {
        j += 1;
      }
      i = j;
      const param = paramStr ? parseInt(paramStr, 10) : null;

      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') {
        emit('\n');
      } else if (word === 'tab') {
        emit(' ');
      } else if (word === 'cell' || word === 'row') {
        emit('\n');
      } else if (word === 'ansicpg') {
        ansiCpg = param ?? 1252;
      } else if (word === 'uc') {
        ucSkip = param ?? 1;
      } else if (word === 'u') {
        const v = (param ?? 0) < 0 ? (param as number) + 65536 : (param ?? 0);
        emit(String.fromCharCode(v));
        skipChars = ucSkip;
      } else if (word in SYMBOLS) {
        emit(SYMBOLS[word]);
      } else if (SKIP_DESTINATIONS.has(word)) {
        skipping = true;
        skipStartDepth = depth;
      }
      // 其余控制字（\pard、\fs 等）忽略
      continue;
    }
    if (c === '\r' || c === '\n') {
      // RTF 中裸 CR/LF 仅是源码换行，忽略
      i += 1;
      continue;
    }
    // 普通字符（\uN 的回退字符在此跳过）
    if (skipChars > 0) {
      skipChars -= 1;
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  flushBytes();
  return { text: normalizeTail(out.join('')) };
}
