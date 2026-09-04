#!/usr/bin/env node
/**
 * 生成 GBK（= gb18030 双字节区）解码索引表 → src/data/encoding/gbk-index.ts。
 *
 * Hermes 无 TextDecoder，RN 端无法直接解码 GBK；本脚本用 Node（full-icu）
 * 在构建期遍历全部 GBK 双字节码位（lead 0x81-0xFE × trail 0x40-0xFE 除 0x7F），
 * 产出一个长度 23940 的字符串常量：下标 = (lead-0x81)*190 + (trail-0x40)
 * （trail>0x7F 时 trail 减 1，即跳过 0x7F），字符 = 对应 Unicode。
 * 无效码位（Node 解出 U+FFFD）也存 U+FFFD，运行期无需区分。
 *
 * 用法：node scripts/gen-gbk-table.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'encoding', 'gbk-index.ts');

const dec = new TextDecoder('gb18030');
let out = '';
for (let p = 0; p < 23940; p += 1) {
  const lead = 0x81 + Math.floor(p / 190);
  let trail = 0x40 + (p % 190);
  if (trail >= 0x7f) trail += 1;
  out += dec.decode(new Uint8Array([lead, trail]));
}

const content = `/**
 * GBK 双字节解码索引表（自动生成，勿手改）。
 * 生成脚本：scripts/gen-gbk-table.mjs（Node full-icu 构建期遍历 gb18030 双字节区）。
 * 长度 23940；下标 = (lead-0x81)*190 + (trail-0x40) - (trail>0x7F ? 1 : 0)。
 * 无效码位与「无映射」均存 U+FFFD，运行期统一按替换符输出。
 */
export const GBK_INDEX = '${out}';
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, content);
console.log(`written: ${OUT} (${out.length} entries)`);
// 抽查几个已知映射
const probe = (lead, trail) => {
  const p = (lead - 0x81) * 190 + (trail - 0x40) - (trail > 0x7f ? 1 : 0);
  return out[p];
};
console.log('B5C0(道) =', probe(0xb5, 0xc0));
console.log('C4E3(你) =', probe(0xc4, 0xe3));
