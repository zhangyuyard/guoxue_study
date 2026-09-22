/**
 * 【#20 根因守卫】内置书切片读的 **UTF-8 边界对齐**（资产级离线对拍）。
 *
 * 缺陷（QA #19 真机验收打穿「双向必有内容」基线）：
 *   资治通鉴（294 章 / 156 章 >32KB）跳到需要 ≥2 次切片读的章时，整页全白 +
 *   转圈，`uiautomator dump` 只有 17 节点、非空文本 0 个，>60s 不自愈、无错误
 *   出口，唯一出路是杀进程；且失败态随**进程**复位（force-stop 后正常），
 *   不随导航复位（BACK 回书架重开同书仍空白）。
 *
 * 根因（本文件用真实资产逐字节证明，不依赖真机）：
 *   ① `meta` 的章区间 `[s, e)` 是**字符边界**（构建脚本按章生成），但流式装配
 *      按 `tier.readChunkBytes`（低档 32KB）**章内**切片，切点落在多字节字符
 *      中间（中文 3 字节 → 命中概率 ≈ 2/3）；
 *   ② `RNFS.read(path, len, pos, 'utf8')` 的 JS 包装是
 *      `utf8.decode(base64.decode(b64))`，而 `utf8@3` 是**严格**解码器：
 *      尾部不完整序列直接 `throw Error('Invalid byte index')`；
 *   ③ `readBuiltinChapterSlice` 把异常吞成 null → 上层判「读失败」→ 首批零产出
 *      → `[PERF][asm] empty … discard` → 目标章永不就绪 → 无限 loading；
 *   ④ 章内偏移固定 ⇒ 每次都失败（间歇失败被代码变成**永久状态**）。
 *
 * 交叉证据（同一章 3ms 内两条互斥日志，曾被误判为「两链路并发冲突」）：
 *   `[PERF][asm] empty ch=tongjian-c166 bytes=32940 failed=true discard`
 *   与 `[PERF][fill-now] tongjian tongjian-c166 bytes=32940 paras=106`
 *   —— 两条链路的**批大小不同**：asm 走档位 32KB（切点 32768 落在字符中间 →
 *   抛错），fill-now 走常量 `FILL_READ_CHUNK_BYTES` = 64KB（32940 < 64KB →
 *   一次读完，切点在章尾=字符边界 → 成功）。与并发无关。
 *
 * 本文件锁定：
 *   A. 真实资产上「32KB 切点落在字符中间」确实存在，且 `utf8.decode` 确实抛
 *      `Invalid byte index`（用与 RNFS 同源的 utf8 包复现真机形态）；
 *   B. 修复算法 `utf8CompletePrefixLength` 在**全部内置书 × 全部章 × 真实切点**
 *      下**无丢失、无重复**地重组出与整章解码逐字节一致的字节流；
 *   C. QA 亲验的 8 个章节（c148/c150/c164/c166/c167/c168/c169/c170）逐个给出
 *      「32KB 必失败 / 64KB 成功」的判定，c290 作为反例（32KB 恰落边界）——
 *      这正是「>32KB 必然失败」不成立、而「切点是否落字符中间」成立的原因。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_CATALOG } from '@/data/builtinCatalog';
import { utf8CompletePrefixLength } from '@/services/UserBookService';
import { decodeUtf8 } from '@/utils/utf8';

const ASSETS_DIR = path.resolve(
  __dirname,
  '../../../android/app/src/main/assets/books',
);

/** 低档 `fillReadChunkBytes`（DeviceTierService）——流式装配的章内切片大小 */
const LOW_TIER_CHUNK = 32 * 1024;
/** r37 灰度路径 `FILL_READ_CHUNK_BYTES`（fillBuiltinChapterNow 使用） */
const FALLBACK_CHUNK = 64 * 1024;

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

function readBook(bookId: string): { buf: Buffer; meta: MetaFile } {
  const buf = fs.readFileSync(path.join(ASSETS_DIR, `${bookId}.txt`));
  const meta = JSON.parse(
    fs.readFileSync(path.join(ASSETS_DIR, `${bookId}.meta.json`), 'utf8'),
  ) as MetaFile;
  return { buf, meta };
}

/** 切点是否为字符边界（非 0b10xxxxxx 的 continuation 字节） */
function isCharBoundary(buf: Buffer, offset: number): boolean {
  if (offset >= buf.length) {
    return true;
  }
  return (buf[offset] & 0xc0) !== 0x80;
}

/** 复现真机 RNFS 的 utf8 解码（严格：尾部截断即抛） */
function rnfsUtf8DecodeOrThrow(bytes: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const utf8 = require('utf8') as { decode: (s: string) => string };
  // RNFS FS.common.js: base64.decode(b64) → binary string → utf8.decode(...)
  return utf8.decode(bytes.toString('binary'));
}

/** 按给定批大小用**修复后的算法**重组章字节：返回消费到 e 时的字节序列 */
function reassembleWithAlignedChunks(
  buf: Buffer,
  s: number,
  e: number,
  chunk: number,
): { bytes: Buffer[]; chunkCount: number; trimmedChunks: number } {
  const bytes: Buffer[] = [];
  let pos = s;
  let chunkCount = 0;
  let trimmedChunks = 0;
  while (pos < e) {
    const want = Math.min(chunk, e - pos);
    const slice = buf.subarray(pos, pos + want);
    const consumed = utf8CompletePrefixLength(slice);
    expect(consumed).toBeGreaterThan(0); // 必然推进（否则调用方判读失败）
    expect(consumed).toBeLessThanOrEqual(want);
    if (consumed < want) {
      trimmedChunks += 1;
    }
    bytes.push(slice.subarray(0, consumed));
    pos += consumed;
    chunkCount += 1;
    expect(chunkCount).toBeLessThan(10_000); // 终止性护栏
  }
  expect(pos).toBe(e); // 恰好消费到章尾（无跳字节 / 无越界）
  return { bytes, chunkCount, trimmedChunks };
}

describe('【#20 根因】低档 32KB 切片切点多落在字符中间，严格 utf8 解码必然抛', () => {
  const { buf, meta } = readBook('tongjian');

  test('生产常量：低档 fillReadChunkBytes = 32KB（档位矩阵未漂移）', () => {
    const tierSrc = fs.readFileSync(
      path.resolve(__dirname, '../DeviceTierService.ts'),
      'utf8',
    );
    expect(tierSrc).toMatch(/const KB = 1024;/);
    // 低档（首档）fillReadChunkBytes = 32KB；其余档 64KB
    expect(tierSrc).toMatch(/fillReadChunkBytes: 32 \* KB,/);
    expect(LOW_TIER_CHUNK).toBe(32 * 1024);
    expect(FALLBACK_CHUNK).toBe(64 * 1024);
    const svcSrc = fs.readFileSync(
      path.resolve(__dirname, '../UserBookService.ts'),
      'utf8',
    );
    expect(svcSrc).toMatch(/const FILL_READ_CHUNK_BYTES = 64 \* 1024;/);
  });

  test('量化：>32KB 的章中，首批 32KB 切点落在字符中间的比例（真机命中率来源）', () => {
    const big = meta.chapters.filter((c) => c.e - c.s > LOW_TIER_CHUNK);
    expect(big.length).toBeGreaterThan(100); // 资治通鉴：>32KB 章数众多
    const midChar = big.filter((c) => !isCharBoundary(buf, c.s + LOW_TIER_CHUNK));
    // 中文 3 字节字符 ⇒ 理论命中率 ≈ 2/3；实测 112/156 ≈ 71.8%
    const ratio = midChar.length / big.length;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.85);
  });

  test('QA 亲验章节：32KB 首批解码抛 Invalid byte index（逐章）', () => {
    const verified = [
      'tongjian-c148',
      'tongjian-c150',
      'tongjian-c164',
      'tongjian-c166',
      'tongjian-c167',
      'tongjian-c168',
      'tongjian-c169',
      'tongjian-c170',
    ];
    for (const id of verified) {
      const c = meta.chapters.find((x) => x.id === id);
      expect(c).toBeDefined();
      const range = c as MetaChapter;
      expect(range.e - range.s).toBeGreaterThan(LOW_TIER_CHUNK); // 需 ≥2 批
      expect(isCharBoundary(buf, range.s + LOW_TIER_CHUNK)).toBe(false); // 切点落在字符中间
      expect(() =>
        rnfsUtf8DecodeOrThrow(
          buf.subarray(range.s, range.s + LOW_TIER_CHUNK) as Buffer,
        ),
      ).toThrow(/Invalid byte index/);
    }
  });

  test('反例 c290：同 >32KB 但 32KB 切点恰落字符边界 ⇒ 不抛（“必然失败”不成立）', () => {
    const c = meta.chapters.find((x) => x.id === 'tongjian-c290') as MetaChapter;
    expect(c.e - c.s).toBeGreaterThan(LOW_TIER_CHUNK);
    expect(isCharBoundary(buf, c.s + LOW_TIER_CHUNK)).toBe(true);
    expect(() =>
      rnfsUtf8DecodeOrThrow(
        buf.subarray(c.s, c.s + LOW_TIER_CHUNK) as Buffer,
      ),
    ).not.toThrow();
  });

  test('c166 互斥日志的真相：32KB 抛 / 64KB 一次读完成功（批大小差异，非并发冲突）', () => {
    const c = meta.chapters.find((x) => x.id === 'tongjian-c166') as MetaChapter;
    expect(c.e - c.s).toBe(32940); // 与 QA 日志 bytes=32940 逐字对应
    expect(c.e - c.s).toBeLessThan(FALLBACK_CHUNK); // 64KB 批 → 单次整章读
    expect(() =>
      rnfsUtf8DecodeOrThrow(
        buf.subarray(c.s, c.s + LOW_TIER_CHUNK) as Buffer,
      ),
    ).toThrow(/Invalid byte index/);
    // 64KB 批 = 整章区间（落章界）→ 严格解码成功
    expect(() =>
      rnfsUtf8DecodeOrThrow(buf.subarray(c.s, c.e) as Buffer),
    ).not.toThrow();
  });
});

describe('【#20 修复】边界对齐切片：全部内置书 × 全部章 × 真实切点 → 无丢失无重复', () => {
  test.each(BUILTIN_CATALOG.map((b) => b.id))(
    '%s：32KB 与 64KB 批下逐章字节级重组一致',
    (bookId) => {
      const { buf, meta } = readBook(bookId);
      for (const c of meta.chapters) {
        for (const chunk of [LOW_TIER_CHUNK, FALLBACK_CHUNK]) {
          const { bytes } = reassembleWithAlignedChunks(buf, c.s, c.e, chunk);
          const joined = Buffer.concat(bytes);
          const expected = buf.subarray(c.s, c.e);
          // 字节级一致 = 不丢字、不重复、不越界
          expect(joined.equals(expected)).toBe(true);
          // 文本级一致 = 解码结果与整章一次解码逐字相同（无替换符）
          expect(decodeUtf8(new Uint8Array(joined))).toBe(
            decodeUtf8(new Uint8Array(expected)),
          );
          expect(decodeUtf8(new Uint8Array(joined))).not.toContain('\ufffd');
        }
      }
    },
  );
});

describe('【#20 修复】utf8CompletePrefixLength 纯函数边界', () => {
  test('落在任意中间字节都裁到完整字符前缀（1~4 字节字符 + 非法字节）', () => {
    const text = 'a¢中𝄞z'; // 1 + 2 + 3 + 4 + 1 = 11 字节
    const bytes = Buffer.from(text, 'utf8');
    const lens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    // 字节布局：a(1) ¢(2) 中(3) 𝄞(4) z(1) → 前缀长度对应的完整字符字节数
    const expected = [1, 1, 3, 3, 3, 6, 6, 6, 6, 10, 11];
    lens.forEach((len, i) => {
      expect(utf8CompletePrefixLength(bytes.subarray(0, len))).toBe(
        expected[i],
      );
    });
    // 完整输入恒返回全长
    expect(utf8CompletePrefixLength(bytes)).toBe(bytes.length);
  });

  test('非法字节（悬空 continuation / 0xC0 过长编码 / 0xFF）就地止步，不吞错字节', () => {
    expect(utf8CompletePrefixLength(Buffer.from([0x61, 0x80, 0x80]))).toBe(1);
    expect(utf8CompletePrefixLength(Buffer.from([0x61, 0xc0, 0x80]))).toBe(1);
    expect(utf8CompletePrefixLength(Buffer.from([0x61, 0xff]))).toBe(1);
    expect(utf8CompletePrefixLength(Buffer.from([]))).toBe(0);
  });

  test('任意 ASCII 从未受影响（回归：普通英文/数字切片不退化为重读）', () => {
    const ascii = Buffer.from('Lorem ipsum dolor sit amet '.repeat(10), 'utf8');
    for (const len of [1, 7, 33, 100, ascii.length]) {
      expect(utf8CompletePrefixLength(ascii.subarray(0, len))).toBe(len);
    }
  });
});
