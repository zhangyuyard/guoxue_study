/**
 * 初次打开点卡片长时间无响应（第二轮）回归测试。
 *
 * 背景：FTS 分片（第一轮修复）后真机仍复现——点卡片后的水合链路存在
 * 四个同步大块（资治通鉴级 9MB 书）：
 *   ① decodeUtf8 逐字节 JS 解码（3-10s）
 *   ② contentSignature(utf8Bytes(text)) 无人消费的全量重编码+散列（2-7s）
 *   ③ splitRawChapters 单块 9MB 逐行扫描（0.5-1.5s）
 *   ④ fillRemainingBuiltinChapters 固定 30 章/批（单片可达数秒）
 *   ⑤ FTS 8 章/片（单片约 25 万字 tokenize+execute）
 * 修复：native utf8 直读 + 砍签名 + 切章分批 + fill/FTS 时间片。
 * 本文件用「源码结构断言 + 行为测试」锁定以上不变量。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { decodeUtf8 } from '@/utils/utf8';
import {
  __splitChaptersBothWaysForTests,
} from '@/services/UserBookService';

const ubsSource = readFileSync(
  resolve(__dirname, '../services/UserBookService.ts'),
  'utf8',
);
const storageSource = readFileSync(
  resolve(__dirname, '../services/StorageService.ts'),
  'utf8',
);
const utf8Source = readFileSync(resolve(__dirname, '../utils/utf8.ts'), 'utf8');

/** 提取函数源码片段（从声明行到下一个顶层声明/文件尾） */
function extractFn(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) {
    throw new Error(`未找到函数：${signature}`);
  }
  const next = source.slice(start + 1).search(/\n(async function|function|export (async )?function|const [A-Z_]+ =|\/\*\*)/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe('① readBuiltinText：native UTF-8 直读优先 + 砍掉无人消费的签名', () => {
  const fn = extractFn(ubsSource, 'async function readBuiltinText');

  test('canonicalPath 必须先走 RNFS.readFile utf8（native 解码，JS 零逐字节）', () => {
    expect(fn).toMatch(/RNFS\.readFile\(canonicalPath, 'utf8'\)/);
    const utf8Pos = fn.indexOf("RNFS.readFile(canonicalPath, 'utf8')");
    const bytesPos = fn.indexOf('readFileBytes(canonicalPath)');
    expect(utf8Pos).toBeGreaterThan(-1);
    expect(bytesPos).toBeGreaterThan(utf8Pos);
  });

  test('内置首开路径不得计算 contentSignature（utf8Bytes 重编码 + 双散列）', () => {
    expect(fn).not.toMatch(/contentSignature/);
  });
});

describe('③ 切章分批让出：分批版与同步版必须产出恒等', () => {
  test('跨批（>20000 行）标记文本：章序列/行数/preface 逐项一致', async () => {
    // 45001 行 = 3 章 × 15000 行正文，横跨 SPLIT_SCAN_BATCH_LINES=20000 的 3 批
    const lines: string[] = ['@@CH@@甲章'];
    for (let i = 0; i < 15000; i += 1) {
      lines.push(`甲第${i}行`);
    }
    lines.push('@@CH@@乙章');
    for (let i = 0; i < 15000; i += 1) {
      lines.push('乙正文');
    }
    lines.push('@@CH@@丙章');
    for (let i = 0; i < 15000; i += 1) {
      lines.push('丙正文');
    }
    const text = lines.join('\n');
    const { sync, chunked } = await __splitChaptersBothWaysForTests(text);
    expect(chunked.rawChapters.map((c) => c.title)).toEqual(['甲章', '乙章', '丙章']);
    expect(chunked.rawChapters.map((c) => c.body.length)).toEqual([15000, 15000, 15000]);
    expect(sync.rawChapters).toEqual(chunked.rawChapters);
    expect(sync.preface).toEqual(chunked.preface);
  });

  test('分批扫描批间必须让出 JS（SPLIT_SCAN_BATCH_LINES）', () => {
    expect(ubsSource).toMatch(/const SPLIT_SCAN_BATCH_LINES = 20000;/);
    const fn = extractFn(ubsSource, 'async function splitRawChaptersChunked');
    expect(fn).toMatch(/await yieldToJs\(\)/);
  });
});

describe('④⑤ fill / FTS 时间片化（块上限压到单章量级）', () => {
  test('fillRemainingBuiltinChapters 必须逐章检查时间预算（不再固定 30 章/批）', () => {
    const fn = extractFn(ubsSource, 'async function fillRemainingBuiltinChapters');
    expect(fn).toMatch(/Date\.now\(\) - sliceStart >= FILL_TIME_BUDGET_MS/);
    expect(fn).not.toMatch(/start \+= PARSE_CHUNK_CHAPTERS/);
    expect(ubsSource).toMatch(/const FILL_TIME_BUDGET_MS = 12;/);
  });

  test('upsertFtsForBookChunked 默认时间片路径（章级门闩检查），chunkChapters 显式注入走固定片', () => {
    const fn = extractFn(storageSource, 'export async function upsertFtsForBookChunked');
    expect(fn).toMatch(/opts\?\.chunkChapters !== undefined/);
    expect(fn).toMatch(/Date\.now\(\) - sliceStart >= FTS_TIME_BUDGET_MS/);
    expect(storageSource).toMatch(/const FTS_TIME_BUDGET_MS = 8;/);
  });
});

describe('decodeUtf8 分块拼接：与逐字符拼接语义一致', () => {
  test('ASCII/多字节/四字节/非法序列/跨块边界 均与预期一致', () => {
    const ascii = Uint8Array.from([0x68, 0x69, 0x0a]);
    expect(decodeUtf8(ascii)).toBe('hi\n');
    // 中 = E4 B8 AD；😀 = F0 9F 98 80（四字节代理对）
    const mixed = Uint8Array.from([0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80]);
    expect(decodeUtf8(mixed)).toBe('中\u{1f600}');
    // 非法首字节 → U+FFFD
    const bad = Uint8Array.from([0xff, 0x41]);
    expect(decodeUtf8(bad)).toBe('\ufffdA');
    // 截断的多字节序列（末尾缺续字节）→ 首字节替换后，孤立续字节亦替换
    //（原实现的容错语义：每个无法解码的字节各产出一个 U+FFFD）
    const trunc = Uint8Array.from([0xe4, 0xb8]);
    expect(decodeUtf8(trunc)).toBe('\ufffd\ufffd');
    // 跨块边界：构造 > 32768 字符的输出，块拼接后总长度与内容完整
    const long = new Uint8Array(40000);
    for (let i = 0; i < long.length; i += 1) {
      long[i] = 0x61; // 'a'
    }
    expect(decodeUtf8(long)).toBe('a'.repeat(40000));
  });

  test('实现必须走分块 join（禁逐字符 += 到单一字符串）', () => {
    expect(utf8Source).toMatch(/const DECODE_CHUNK_CHARS = 32768;/);
    expect(utf8Source).toMatch(/chunks\.push\(buf\)/);
  });
});
