/**
 * TextDictParser 单元测试（纯逻辑直跑，零原生 mock）
 * 覆盖：CSV（表头映射 / 无表头 / 引号转义）、TSV、JSON（字符串释义 / 义项数组 / 包装结构 /
 * 坏数据上报）、TXT（〈拼音〉前缀 / 分隔符优先级 / 错误行上报）、UTF-16LE BOM、sniff 分发。
 */
import type { DictParserContext, ParsedEntry } from '@/services/dict/parsers/types';
import {
  utf16leEncode,
  utf8Encode,
} from '@/services/dict/parsers/types';
import { TextDictParser } from '@/services/dict/parsers/TextDictParser';

/** 由字节缓冲构造解析上下文（readChunk 即内存切片） */
function makeCtx(bytes: Uint8Array): DictParserContext {
  return {
    fileSize: bytes.length,
    readChunk: async (position: number, length: number) => bytes.slice(position, position + length),
    onProgress: jest.fn(),
    isCancelled: () => false,
    reportError: jest.fn(),
  };
}

/** 收集解析器全部批次 */
async function collect(parser: { parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> }, text: string | Uint8Array): Promise<ParsedEntry[]> {
  const bytes = typeof text === 'string' ? utf8Encode(text) : text;
  const out: ParsedEntry[] = [];
  for await (const batch of parser.parse(makeCtx(bytes))) {
    out.push(...batch);
  }
  return out;
}

/** 收集并附带上下文（校验 reportError / onProgress） */
async function collectWithCtx(
  parser: { parse(ctx: DictParserContext): AsyncGenerator<ParsedEntry[], void, void> },
  bytes: Uint8Array,
): Promise<{ entries: ParsedEntry[]; ctx: DictParserContext }> {
  const ctx = makeCtx(bytes);
  const entries: ParsedEntry[] = [];
  for await (const batch of parser.parse(ctx)) {
    entries.push(...batch);
  }
  return { entries, ctx };
}

// ============ CSV ============

describe('CSV 解析', () => {
  test('表头映射（字头/拼音/释义/例句/部首/笔画/读音）→ structured 多字段', async () => {
    const csv = [
      '字头,拼音,释义,例句,部首,笔画,读音',
      '學,xué,学习,学而时习之；温故而知新,子,8,xué jiào',
    ].join('\n');
    const entries = await collect(TextDictParser.csvParser, csv);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.headword).toBe('學');
    expect(e.pinyin).toBe('xué');
    expect(e.readings).toEqual(['xué', 'jiào']);
    expect(e.contentType).toBe('structured');
    expect(JSON.parse(e.content)).toEqual([
      { def: '学习', examples: ['学而时习之', '温故而知新'] },
    ]);
    expect(e.extra).toEqual({ radical: '子', strokes: 8 });
  });

  test('无表头取前两列', async () => {
    const entries = await collect(TextDictParser.csvParser, '好,优点\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].headword).toBe('好');
    expect(JSON.parse(entries[0].content)).toEqual([{ def: '优点' }]);
    expect(entries[0].pinyin).toBeUndefined();
  });

  test('引号包裹字段与 "" 转义', async () => {
    const csv = '"说,话",释义内容\n"含""引号""的词",另一个释义\n';
    const entries = await collect(TextDictParser.csvParser, csv);
    expect(entries.map((e) => e.headword)).toEqual(['说,话', '含"引号"的词']);
    expect(JSON.parse(entries[0].content)).toEqual([{ def: '释义内容' }]);
  });

  test('英文表头别名（headword/meaning）', async () => {
    const csv = 'headword,meaning\nxué,study\n';
    const entries = await collect(TextDictParser.csvParser, csv);
    expect(entries[0].headword).toBe('xué');
    expect(JSON.parse(entries[0].content)).toEqual([{ def: 'study' }]);
  });

  test('空行跳过；空字头/空释义行上报错误', async () => {
    const csv = ['好,优点', '', ',缺字头', '坏,', '差,劣'].join('\n');
    const { entries, ctx } = await collectWithCtx(TextDictParser.csvParser, utf8Encode(csv));
    expect(entries.map((e) => e.headword)).toEqual(['好', '差']);
    expect(ctx.reportError).toHaveBeenCalledTimes(2);
    const reasons = (ctx.reportError as jest.Mock).mock.calls.map((c) => c[0].reason as string);
    expect(reasons).toEqual(['字头为空', '释义为空']);
  });

  test('释义含 HTML 标签 → contentType plain 原样保留', async () => {
    const csv = '字头,释义\n学,<b>学习</b>知识\n';
    const entries = await collect(TextDictParser.csvParser, csv);
    expect(entries[0].contentType).toBe('plain');
    expect(entries[0].content).toBe('<b>学习</b>知识');
  });
});

// ============ TSV ============

describe('TSV 解析', () => {
  test('制表符分隔 + 表头映射', async () => {
    const tsv = '字头\t释义\n学\t学习\n';
    const entries = await collect(TextDictParser.tsvParser, tsv);
    expect(entries).toHaveLength(1);
    expect(entries[0].headword).toBe('学');
    expect(JSON.parse(entries[0].content)).toEqual([{ def: '学习' }]);
  });
});

// ============ TXT ============

describe('TXT 解析', () => {
  test('〈拼音〉前缀拆出 pinyin；全角冒号分隔', async () => {
    const entries = await collect(TextDictParser.txtParser, '樂〈lè〉：快乐\n');
    expect(entries[0]).toMatchObject({
      headword: '樂',
      pinyin: 'lè',
      contentType: 'plain',
      content: '快乐',
    });
  });

  test('分隔符优先级：：> : > ＝ > = > \\t', async () => {
    const a = await collect(TextDictParser.txtParser, '學＝效法\n');
    expect(a[0].content).toBe('效法');
    const b = await collect(TextDictParser.txtParser, '學：学：习\n');
    // 首个出现的分隔符（全角冒号）生效
    expect(b[0].headword).toBe('學');
    expect(b[0].content).toBe('学：习');
    const c = await collect(TextDictParser.txtParser, '学\t学习\n');
    expect(c[0].content).toBe('学习');
  });

  test('无分隔符 / 空释义行上报错误，其余行照常解析', async () => {
    const txt = '无分隔符的行\n学：\n好：善\n';
    const { entries, ctx } = await collectWithCtx(TextDictParser.txtParser, utf8Encode(txt));
    expect(entries.map((e) => e.headword)).toEqual(['好']);
    const reasons = (ctx.reportError as jest.Mock).mock.calls.map((c) => c[0].reason as string);
    expect(reasons).toEqual(['缺少字头/释义分隔符', '释义为空']);
  });
});

// ============ JSON ============

describe('JSON 解析', () => {
  test('字符串释义 + 中英文键名别名', async () => {
    const json = JSON.stringify([{ headword: '学', meaning: '学习', pinyin: 'xué' }]);
    const entries = await collect(TextDictParser.jsonParser, json);
    expect(entries[0].headword).toBe('学');
    expect(entries[0].pinyin).toBe('xué');
    expect(JSON.parse(entries[0].content)).toEqual([{ def: '学习' }]);
  });

  test('义项数组 → structured 多义项（pos/examples/citations）', async () => {
    const json = JSON.stringify([
      {
        字头: '说',
        释义: [
          { def: '解说', pos: '动', 例句: ['说文解字'] },
          { def: '通悦', citations: ['不亦说乎'] },
        ],
      },
    ]);
    const entries = await collect(TextDictParser.jsonParser, json);
    expect(entries[0].contentType).toBe('structured');
    expect(JSON.parse(entries[0].content)).toEqual([
      { def: '解说', pos: '动', examples: ['说文解字'] },
      { def: '通悦', citations: ['不亦说乎'] },
    ]);
  });

  test('{description, entries} 包装结构', async () => {
    const json = JSON.stringify({ description: '测试', entries: [{ headword: '仁', meaning: '爱人' }] });
    const entries = await collect(TextDictParser.jsonParser, json);
    expect(entries).toHaveLength(1);
    expect(entries[0].headword).toBe('仁');
  });

  test('extra（部首/笔画）与 readings 字段', async () => {
    const json = JSON.stringify([
      { headword: '学', meaning: '学习', radical: '子', strokes: '8', readings: ['xué', 'jiào'] },
    ]);
    const entries = await collect(TextDictParser.jsonParser, json);
    expect(entries[0].extra).toEqual({ radical: '子', strokes: 8 });
    expect(entries[0].readings).toEqual(['xué', 'jiào']);
  });

  test('释义含 HTML → plain；非对象项与缺字段项上报错误', async () => {
    const json = JSON.stringify([
      { headword: '学', meaning: '<i>学习</i>' },
      '不是对象的项',
      { meaning: '缺字头' },
    ]);
    const { entries, ctx } = await collectWithCtx(TextDictParser.jsonParser, utf8Encode(json));
    expect(entries).toHaveLength(1);
    expect(entries[0].contentType).toBe('plain');
    expect(ctx.reportError).toHaveBeenCalledTimes(2);
  });

  test('顶层非数组且无 entries 包装 → 抛错', async () => {
    await expect(collect(TextDictParser.jsonParser, '{"foo":1}')).rejects.toThrow('entries');
  });

  test('JSON 语法错误 → 抛错', async () => {
    await expect(collect(TextDictParser.jsonParser, '{bad json')).rejects.toThrow('JSON 解析失败');
  });
});

// ============ 编码 ============

describe('编码探测', () => {
  test('UTF-16LE BOM（FF FE）CSV 正常解析', async () => {
    const text = '字头,释义\n學,学习\n';
    const bytes = new Uint8Array([0xff, 0xfe, ...utf16leEncode(text)]);
    const entries = await collect(TextDictParser.csvParser, bytes);
    expect(entries).toHaveLength(1);
    expect(entries[0].headword).toBe('學');
    expect(JSON.parse(entries[0].content)).toEqual([{ def: '学习' }]);
  });

  test('UTF-8 BOM（EF BB BF）跳过 BOM 解析', async () => {
    const text = '學：学习\n';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Encode(text)]);
    const entries = await collect(TextDictParser.txtParser, bytes);
    expect(entries[0].headword).toBe('學');
  });
});

// ============ sniff 分发 ============

describe('sniff 扩展名判断', () => {
  test('四格式各自命中', () => {
    expect(TextDictParser.csvParser.sniff('a.csv')).toBe(true);
    expect(TextDictParser.csvParser.sniff('a.CSV')).toBe(true);
    expect(TextDictParser.csvParser.sniff('a.txt')).toBe(false);
    expect(TextDictParser.tsvParser.sniff('a.tsv')).toBe(true);
    expect(TextDictParser.jsonParser.sniff('a.json?x=1')).toBe(true);
    expect(TextDictParser.txtParser.sniff('a.txt')).toBe(true);
    expect(TextDictParser.txtParser.sniff('noext')).toBe(false);
  });
});
