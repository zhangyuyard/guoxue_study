/**
 * 文本类字典解析器（TextDictParser）
 * 四合一：CSV / TSV / JSON / TXT（§3.4 映射规则）：
 *   - CSV/TSV：分隔符固定（, 或 \t），引号包裹字段支持 "" 转义；表头自动嗅探
 *     （首行含 字头|词条|headword|word 任一 → 按表头映射），无表头取前两列。
 *   - JSON：对象数组，键名兼容中英文；{description, entries} 包装取 entries。
 *     （JSON 为唯一允许整读的格式，见 types.ts 注释。）
 *   - TXT：一行一条目，分隔符按优先级嗅探 ： > : > ＝ > = > \t；
 *     字头侧可选 〈拼音〉 前缀拆出 pinyin。
 *   - 产出 contentType：含 HTML 标签 → 'plain'（原样）；否则 'structured'
 *     （单段释义转 [{def}]；JSON meaning 数组转多义项）。
 * 解析器为纯逻辑（仅依赖注入的 readChunk），单测零原生 mock。
 * 编码：支持 UTF-8（含 BOM）与 UTF-16LE（FF FE BOM）。
 */
import {
  PARSER_REGISTRY,
  fileExt,
  utf16leDecode,
  utf8Decode,
  type DictParser,
  type DictParserContext,
  type ParsedEntry,
} from './types';
import type { DictSense } from '@/types/dict';

/** 单批最大条数 */
const BATCH_SIZE = 1000;
/** 行流式读取块大小（1MB） */
const LINE_CHUNK_SIZE = 1024 * 1024;

// ---------- 列/键名别名（§3.4） ----------

const HEADWORD_ALIASES = ['字头', '词条', 'headword', 'word'];
const PINYIN_ALIASES = ['拼音', 'pinyin'];
const MEANING_ALIASES = ['释义', '词义', 'meaning', 'definition'];
const EXAMPLES_ALIASES = ['例句', 'examples'];
const RADICAL_ALIASES = ['部首', 'radical'];
const STROKES_ALIASES = ['笔画', 'strokes'];
const READINGS_ALIASES = ['读音', 'readings'];

/** TXT 分隔符优先级（§3.4：`：` > `:` > `＝` > `=` > `\t`） */
const TXT_SEPARATORS = ['：', ':', '＝', '=', '\t'];

/** HTML 标签检测（决定 plain vs structured） */
const HTML_TAG_RE = /<[a-zA-Z!/][^>]*>/;

/** 字头侧〈拼音〉前缀（如 `乐〈lè〉`） */
const PINYIN_PREFIX_RE = /^(.{1,4}?)〈([^〉]+)〉$/;

// ---------- 小工具 ----------

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  if (b.length === 0) {
    return a;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** 依优先级取第一个存在的键值（中英文别名） */
function pickValue(obj: Record<string, unknown>, aliases: string[]): unknown {
  for (const key of aliases) {
    const v = obj[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return v;
    }
  }
  return undefined;
}

/** 例句列切分（内部 `；/;` 分割，§3.4） */
function splitExamples(raw: string): string[] | undefined {
  const parts = raw
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** CSV/TSV 行切分（支持双引号包裹与 "" 转义） */
function splitDelimited(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// ---------- CSV/TSV 列映射 ----------

interface ColumnMap {
  headword: number;
  pinyin: number;
  meaning: number;
  examples: number;
  radical: number;
  strokes: number;
  readings: number;
}

/** 尝试从首行构造列映射（无表头返回 null） */
function buildColumnMap(cells: string[]): ColumnMap | null {
  const normalized = cells.map((c) => c.trim().toLowerCase());
  const find = (aliases: string[]): number => normalized.findIndex((c) => aliases.includes(c));
  const headword = find(HEADWORD_ALIASES);
  if (headword < 0) {
    return null;
  }
  return {
    headword,
    pinyin: find(PINYIN_ALIASES),
    meaning: find(MEANING_ALIASES),
    examples: find(EXAMPLES_ALIASES),
    radical: find(RADICAL_ALIASES),
    strokes: find(STROKES_ALIASES),
    readings: find(READINGS_ALIASES),
  };
}

/** 从对象/行构造义项（含 HTML 判定） */
function buildContent(meaning: string, examples?: string[]): { contentType: 'structured' | 'plain'; content: string } {
  if (HTML_TAG_RE.test(meaning)) {
    return { contentType: 'plain', content: meaning };
  }
  const sense: DictSense = examples && examples.length > 0 ? { def: meaning, examples } : { def: meaning };
  return { contentType: 'structured', content: JSON.stringify([sense]) };
}

/** CSV/TSV 行 → ParsedEntry（失败返回错误原因） */
function rowToEntry(cells: string[], colMap: ColumnMap | null): { entry?: ParsedEntry; reason?: string } {
  const headword = (colMap ? cells[colMap.headword] : cells[0]).trim();
  if (!headword) {
    return { reason: '字头为空' };
  }
  const meaning = colMap
    ? colMap.meaning >= 0
      ? (cells[colMap.meaning] ?? '')
      : ''
    : cells[1] ?? '';
  if (!meaning.trim()) {
    return { reason: '释义为空' };
  }
  const pinyin = colMap && colMap.pinyin >= 0 ? (cells[colMap.pinyin] ?? '').trim() : '';
  const examplesRaw = colMap && colMap.examples >= 0 ? cells[colMap.examples] ?? '' : '';
  const examples = examplesRaw ? splitExamples(examplesRaw) : undefined;
  const radical = colMap && colMap.radical >= 0 ? (cells[colMap.radical] ?? '').trim() : '';
  const strokesRaw = colMap && colMap.strokes >= 0 ? (cells[colMap.strokes] ?? '').trim() : '';
  const readingsRaw = colMap && colMap.readings >= 0 ? (cells[colMap.readings] ?? '').trim() : '';

  const { contentType, content } = buildContent(meaning.trim(), examples);
  const entry: ParsedEntry = {
    headword,
    contentType,
    content,
    pinyin: pinyin || undefined,
    readings: readingsRaw
      ? readingsRaw
          .split(/[\s,，]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
  };
  if (radical || strokesRaw) {
    const strokes = Number.parseInt(strokesRaw, 10);
    entry.extra = {
      ...(radical ? { radical } : {}),
      ...(Number.isFinite(strokes) ? { strokes } : {}),
    };
  }
  return { entry };
}

// ---------- JSON 对象 → ParsedEntry ----------

function jsonToEntry(obj: Record<string, unknown>): { entry?: ParsedEntry; reason?: string } {
  const headword = pickValue(obj, HEADWORD_ALIASES);
  if (headword === undefined) {
    return { reason: '缺少字头字段（headword/字头/词条/word）' };
  }
  const meaning = pickValue(obj, MEANING_ALIASES);
  if (meaning === undefined) {
    return { reason: '缺少释义字段（meaning/definition/释义/词义）' };
  }
  const hw = String(headword).trim();
  if (!hw) {
    return { reason: '字头为空' };
  }
  const pinyin = pickValue(obj, PINYIN_ALIASES);
  const examplesVal = pickValue(obj, EXAMPLES_ALIASES);
  const radical = pickValue(obj, RADICAL_ALIASES);
  const strokesVal = pickValue(obj, STROKES_ALIASES);
  const readingsVal = pickValue(obj, READINGS_ALIASES);

  let contentType: 'structured' | 'plain';
  let content: string;
  if (typeof meaning === 'string') {
    // 字符串释义：含 HTML → plain 原样；否则 structured 单义项
    if (HTML_TAG_RE.test(meaning)) {
      contentType = 'plain';
      content = meaning;
    } else {
      const examples =
        typeof examplesVal === 'string'
          ? splitExamples(examplesVal)
          : Array.isArray(examplesVal)
            ? (examplesVal.map((e) => String(e)).filter((e) => e.trim().length > 0) as string[])
            : undefined;
      const sense: DictSense = examples ? { def: meaning, examples } : { def: meaning };
      contentType = 'structured';
      content = JSON.stringify([sense]);
    }
  } else if (Array.isArray(meaning)) {
    // 对象数组 → structured 多义项 [{def, pos, examples}]
    const senses: DictSense[] = [];
    for (const item of meaning) {
      if (item === null || typeof item !== 'object') {
        senses.push({ def: String(item) });
        continue;
      }
      const m = item as Record<string, unknown>;
      const def = m.def ?? m.meaning ?? m.definition ?? '';
      const sense: DictSense = { def: String(def) };
      if (typeof m.pos === 'string' && m.pos) {
        sense.pos = m.pos;
      }
      const ex = m.examples ?? m.例句;
      if (Array.isArray(ex)) {
        sense.examples = ex.map((e) => String(e)).filter((e) => e.trim().length > 0);
      } else if (typeof ex === 'string' && ex.trim()) {
        sense.examples = splitExamples(ex);
      }
      const cit = m.citations;
      if (Array.isArray(cit)) {
        sense.citations = cit.map((c) => String(c)).filter((c) => c.trim().length > 0);
      }
      senses.push(sense);
    }
    contentType = 'structured';
    content = JSON.stringify(senses);
  } else {
    return { reason: '释义字段类型不支持（须为字符串或义项数组）' };
  }

  const entry: ParsedEntry = {
    headword: hw,
    contentType,
    content,
    pinyin: pinyin !== undefined ? String(pinyin).trim() || undefined : undefined,
    readings: Array.isArray(readingsVal)
      ? (readingsVal.map((r) => String(r)).filter((r) => r.trim().length > 0) as string[])
      : undefined,
  };
  const extra: Record<string, unknown> = {};
  if (radical !== undefined) {
    extra.radical = String(radical);
  }
  if (strokesVal !== undefined) {
    const strokes = Number.parseInt(String(strokesVal), 10);
    if (Number.isFinite(strokes)) {
      extra.strokes = strokes;
    }
  }
  if (Object.keys(extra).length > 0) {
    entry.extra = extra as ParsedEntry['extra'];
  }
  return { entry };
}

// ---------- TXT 行 → ParsedEntry ----------

function txtLineToEntry(line: string): { entry?: ParsedEntry; reason?: string } {
  let sep = '';
  for (const s of TXT_SEPARATORS) {
    if (line.includes(s)) {
      sep = s;
      break;
    }
  }
  if (!sep) {
    return { reason: '缺少字头/释义分隔符' };
  }
  const idx = line.indexOf(sep);
  const left = line.slice(0, idx).trim();
  const meaning = line.slice(idx + sep.length).trim();
  if (!left) {
    return { reason: '字头为空' };
  }
  if (!meaning) {
    return { reason: '释义为空' };
  }
  // 〈拼音〉前缀拆出（如 `乐〈lè〉：高兴`）
  let headword = left;
  let pinyin: string | undefined;
  const pm = left.match(PINYIN_PREFIX_RE);
  if (pm) {
    headword = pm[1].trim();
    pinyin = pm[2].trim();
  }
  if (!headword) {
    return { reason: '字头为空' };
  }
  return {
    entry: {
      headword,
      contentType: 'plain',
      content: meaning,
      pinyin,
    },
  };
}

// ---------- 行流式读取（CSV/TSV/TXT 共用） ----------

/**
 * 逐块读取并按换行切分（UTF-8 查 0x0A；UTF-16LE 查 0A 00）。
 * 每凑满 BATCH_SIZE 条 yield 一批。
 */
async function* streamLines(
  ctx: DictParserContext,
  start: number,
  utf16: boolean,
): AsyncGenerator<string, void, void> {
  const step = utf16 ? 2 : 1;
  let carry = new Uint8Array(0);
  let carryStart = start; // carry[0] 对应的文件绝对偏移（对齐基准）
  let pos = start;

  const emitLines = function* (buf: Uint8Array, bufStart: number): Generator<string> {
    let from = 0;
    for (let i = 0; i < buf.length; i += step) {
      const isBreak = utf16 ? buf[i] === 0x0a && buf[i + 1] === 0x00 : buf[i] === 0x0a;
      if (isBreak) {
        const lineBytes = buf.subarray(from, i);
        const line = utf16 ? utf16leDecode(lineBytes) : utf8Decode(lineBytes);
        yield line.replace(/\r$/u, '');
        from = i + step;
      }
    }
    carryStart = bufStart + from;
    carry = buf.slice(from);
  };

  while (pos < ctx.fileSize) {
    if (ctx.isCancelled()) {
      return;
    }
    const len = Math.min(LINE_CHUNK_SIZE, ctx.fileSize - pos);
    const chunk = await ctx.readChunk(pos, len);
    if (chunk.length === 0) {
      break;
    }
    pos += chunk.length;
    const merged = concatBytes(carry, chunk);
    yield* emitLines(merged, carryStart);
  }
  // 尾部无换行的最后一行
  if (carry.length > 0) {
    const last = (utf16 ? utf16leDecode(carry) : utf8Decode(carry)).replace(/\r$/u, '');
    if (last.length > 0) {
      yield last;
    }
  }
}

// ---------- 解析器实现 ----------

class TextDictParserImpl implements DictParser {
  readonly format: 'csv' | 'tsv' | 'json' | 'txt';

  constructor(format: 'csv' | 'tsv' | 'json' | 'txt') {
    this.format = format;
  }

  sniff(fileName: string): boolean {
    return fileExt(fileName) === this.format;
  }

  async *parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> {
    // BOM / 编码探测
    const head = await ctx.readChunk(0, 4);
    let start = 0;
    let utf16 = false;
    if (head[0] === 0xff && head[1] === 0xfe) {
      utf16 = true;
      start = 2;
    } else if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      start = 3;
    }

    if (this.format === 'json') {
      yield* this.parseJson(ctx, start, utf16);
    } else {
      yield* this.parseTextLines(ctx, start, utf16);
    }
  }

  /** CSV / TSV / TXT：行流式解析 */
  private async *parseTextLines(
    ctx: DictParserContext,
    start: number,
    utf16: boolean,
  ): AsyncGenerator<ParsedEntry[], void, void> {
    const delim = this.format === 'csv' ? ',' : this.format === 'tsv' ? '\t' : '';
    let colMap: ColumnMap | null = null;
    let headerChecked = false;
    let lineNo = 0;
    let batch: ParsedEntry[] = [];
    let emitted = 0;

    for await (const line of streamLines(ctx, start, utf16)) {
      lineNo += 1;
      if (ctx.isCancelled()) {
        return;
      }
      // 空行跳过（§3.4：跳过并计数；计数用于潜在调试，不进错误列表）
      if (line.trim().length === 0) {
        continue;
      }

      let result: { entry?: ParsedEntry; reason?: string };
      if (delim) {
        const cells = splitDelimited(line, delim);
        if (!headerChecked) {
          headerChecked = true;
          const map = buildColumnMap(cells);
          if (map) {
            colMap = map;
            continue; // 首行为表头，跳过
          }
          colMap = null;
        }
        result = rowToEntry(cells, colMap);
      } else {
        result = txtLineToEntry(line.trim());
      }

      if (result.entry) {
        batch.push(result.entry);
        if (batch.length >= BATCH_SIZE) {
          emitted += batch.length;
          ctx.onProgress(emitted);
          yield batch;
          batch = [];
        }
      } else {
        ctx.reportError({ at: lineNo, reason: result.reason ?? '未知解析错误' });
      }
    }

    if (batch.length > 0) {
      emitted += batch.length;
      ctx.onProgress(emitted);
      yield batch;
    }
  }

  /** JSON：整读 + 单次解析（types.ts 注明的唯一例外） */
  private async *parseJson(
    ctx: DictParserContext,
    start: number,
    utf16: boolean,
  ): AsyncGenerator<ParsedEntry[], void, void> {
    const bytes = await ctx.readChunk(start, ctx.fileSize - start);
    const text = utf16 ? utf16leDecode(bytes) : utf8Decode(bytes);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`JSON 解析失败：${(e as Error).message}`);
    }
    if (!Array.isArray(data)) {
      if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).entries)) {
        // {description, entries} 包装结构（§3.4）
        data = (data as Record<string, unknown>).entries;
      } else {
        throw new Error('JSON 顶层须为对象数组或 { entries: [...] } 包装结构');
      }
    }
    const items = data as unknown[];

    let batch: ParsedEntry[] = [];
    let emitted = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (ctx.isCancelled()) {
        return;
      }
      const item = items[i];
      if (item === null || typeof item !== 'object') {
        ctx.reportError({ at: i + 1, reason: `第 ${i + 1} 项不是对象` });
        continue;
      }
      const result = jsonToEntry(item as Record<string, unknown>);
      if (result.entry) {
        batch.push(result.entry);
        if (batch.length >= BATCH_SIZE) {
          emitted += batch.length;
          ctx.onProgress(emitted);
          yield batch;
          batch = [];
        }
      } else {
        ctx.reportError({ at: i + 1, reason: result.reason ?? '未知解析错误' });
      }
    }
    if (batch.length > 0) {
      emitted += batch.length;
      ctx.onProgress(emitted);
      yield batch;
    }
  }
}

export const csvParser = new TextDictParserImpl('csv');
export const tsvParser = new TextDictParserImpl('tsv');
export const jsonParser = new TextDictParserImpl('json');
export const txtParser = new TextDictParserImpl('txt');

// 注册进扩展点（DictImportService 按 PARSER_REGISTRY 分发）
PARSER_REGISTRY.push(csvParser, tsvParser, jsonParser, txtParser);

export const TextDictParser = {
  csvParser,
  tsvParser,
  jsonParser,
  txtParser,
};

export default TextDictParser;
