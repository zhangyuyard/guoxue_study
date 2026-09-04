/**
 * MDict 加解密实现（MDictCrypto）
 * - RIPEMD-128：按 rmd128.txt 规范自研纯 TS 移植（参考 mdict-analysis/ripemd128.py，
 *   copyright zhansliu/writemdict）
 * - Salsa20（16 字节密钥 / 8 字节 IV / 8 轮）：MDict v1/v2 的 encrypt=1 数据块解密
 * - fastDecrypt（XOR 族）：MDict v2 encrypt&2 的 key block info 解密
 * 全部为纯逻辑，node 环境直跑单测。
 */

// ============ RIPEMD-128 ============

/** 轮函数 f */
function f(j: number, x: number, y: number, z: number): number {
  if (j < 16) {
    return x ^ y ^ z;
  }
  if (j < 32) {
    return (x & y) | (z & ~x);
  }
  if (j < 48) {
    return (x | ~y) ^ z;
  }
  return (x & z) | (y & ~z);
}

/** 左线常数 K */
function K(j: number): number {
  if (j < 16) {
    return 0x00000000;
  }
  if (j < 32) {
    return 0x5a827999;
  }
  if (j < 48) {
    return 0x6ed9eba1;
  }
  return 0x8f1bbcdc;
}

/** 右线常数 K' */
function Kp(j: number): number {
  if (j < 16) {
    return 0x50a28be6;
  }
  if (j < 32) {
    return 0x5c4dd124;
  }
  if (j < 48) {
    return 0x6d703ef3;
  }
  return 0x00000000;
}

function add(...args: number[]): number {
  let sum = 0;
  for (const a of args) {
    sum = (sum + a) >>> 0;
  }
  return sum >>> 0;
}

function rol(s: number, x: number): number {
  s &= 31;
  if (s === 0) {
    return x >>> 0;
  }
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

/** 消息字序（左线 r / 右线 rp） */
const R = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
];
const RP = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
];
/** 旋转量（左线 s / 右线 sp） */
const S = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
];
const SP = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
];

/** RIPEMD-128 摘要（16 字节） */
export function ripemd128(message: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;

  // 填充：0x80 + 0x00* + 8 字节小端 bit 长度（最短填充：凑齐 ≡56 mod 64）
  const origLen = message.length;
  const rem = origLen % 64;
  const padLen = rem < 56 ? 56 - rem : 120 - rem;
  const padded = new Uint8Array(origLen + padLen + 8);
  padded.set(message);
  padded[origLen] = 0x80;
  const bitLen = origLen * 8;
  // 64 位小端长度（写入低 8 字节）
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const x = new Uint32Array(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      x[i] = dv.getUint32(block + i * 4, true);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let ap = h0;
    let bp = h1;
    let cp = h2;
    let dp = h3;
    for (let j = 0; j < 64; j += 1) {
      // 左线
      let t = rol(S[j], add(a, f(j, b, c, d), x[R[j]], K(j)));
      a = d;
      d = c;
      c = b;
      b = t;
      // 右线
      t = rol(SP[j], add(ap, f(63 - j, bp, cp, dp), x[RP[j]], Kp(j)));
      ap = dp;
      dp = cp;
      cp = bp;
      bp = t;
    }
    const t = add(h1, c, dp);
    h1 = add(h2, d, ap);
    h2 = add(h3, a, bp);
    h3 = add(h0, b, cp);
    h0 = t;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, true);
  odv.setUint32(4, h1, true);
  odv.setUint32(8, h2, true);
  odv.setUint32(12, h3, true);
  return out;
}

// ============ Salsa20（16 字节密钥，8 字节 IV，8 轮） ============

/** Salsa20 核心：16 个 32 位小端字的 64 字节 keystream */
function salsa20WordToByte(input: Uint32Array, nRounds: number): Uint8Array {
  const x = new Uint32Array(16);
  x.set(input);
  const rotl = (a: number, b: number) => ((a << b) | (a >>> (32 - b))) >>> 0;
  const add32 = (a: number, b: number) => (a + b) >>> 0;
  const xor = (a: number, b: number) => (a ^ b) >>> 0;

  for (let i = 0; i < nRounds >> 1; i += 1) {
    x[4] = xor(x[4], rotl(add32(x[0], x[12]), 7));
    x[8] = xor(x[8], rotl(add32(x[4], x[0]), 9));
    x[12] = xor(x[12], rotl(add32(x[8], x[4]), 13));
    x[0] = xor(x[0], rotl(add32(x[12], x[8]), 18));
    x[9] = xor(x[9], rotl(add32(x[5], x[1]), 7));
    x[13] = xor(x[13], rotl(add32(x[9], x[5]), 9));
    x[1] = xor(x[1], rotl(add32(x[13], x[9]), 13));
    x[5] = xor(x[5], rotl(add32(x[1], x[13]), 18));
    x[14] = xor(x[14], rotl(add32(x[10], x[6]), 7));
    x[2] = xor(x[2], rotl(add32(x[14], x[10]), 9));
    x[6] = xor(x[6], rotl(add32(x[2], x[14]), 13));
    x[10] = xor(x[10], rotl(add32(x[6], x[2]), 18));
    x[3] = xor(x[3], rotl(add32(x[15], x[11]), 7));
    x[7] = xor(x[7], rotl(add32(x[3], x[15]), 9));
    x[11] = xor(x[11], rotl(add32(x[7], x[3]), 13));
    x[15] = xor(x[15], rotl(add32(x[11], x[7]), 18));

    x[1] = xor(x[1], rotl(add32(x[0], x[3]), 7));
    x[2] = xor(x[2], rotl(add32(x[1], x[0]), 9));
    x[3] = xor(x[3], rotl(add32(x[2], x[1]), 13));
    x[0] = xor(x[0], rotl(add32(x[3], x[2]), 18));
    x[6] = xor(x[6], rotl(add32(x[5], x[4]), 7));
    x[7] = xor(x[7], rotl(add32(x[6], x[5]), 9));
    x[4] = xor(x[4], rotl(add32(x[7], x[6]), 13));
    x[5] = xor(x[5], rotl(add32(x[4], x[7]), 18));
    x[11] = xor(x[11], rotl(add32(x[10], x[9]), 7));
    x[8] = xor(x[8], rotl(add32(x[11], x[10]), 9));
    x[9] = xor(x[9], rotl(add32(x[8], x[11]), 13));
    x[10] = xor(x[10], rotl(add32(x[9], x[8]), 18));
    x[12] = xor(x[12], rotl(add32(x[15], x[14]), 7));
    x[13] = xor(x[13], rotl(add32(x[12], x[15]), 9));
    x[14] = xor(x[14], rotl(add32(x[13], x[12]), 13));
    x[15] = xor(x[15], rotl(add32(x[14], x[13]), 18));
  }

  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 16; i += 1) {
    odv.setUint32(i * 4, (x[i] + input[i]) >>> 0, true);
  }
  return out;
}

/**
 * Salsa20 keystream 构造器（MDict 用法：16 字节 key、8 字节全零 IV、8 轮）。
 * encrypt/decrypt 同函数（流密码对称）。
 */
export function salsa20(key: Uint8Array, nonce: Uint8Array, rounds = 8): (data: Uint8Array) => Uint8Array {
  if (key.length !== 16 && key.length !== 32) {
    throw new Error(`Salsa20 密钥长度须为 16 或 32 字节（当前 ${key.length}）`);
  }
  if (nonce.length !== 8) {
    throw new Error('Salsa20 nonce（IV）须为 8 字节');
  }
  const sigma = 'expand 16-byte k';
  const constants = [
    sigma.charCodeAt(0), sigma.charCodeAt(1), sigma.charCodeAt(2), sigma.charCodeAt(3),
    sigma.charCodeAt(4), sigma.charCodeAt(5), sigma.charCodeAt(6), sigma.charCodeAt(7),
    sigma.charCodeAt(8), sigma.charCodeAt(9), sigma.charCodeAt(10), sigma.charCodeAt(11),
    sigma.charCodeAt(12), sigma.charCodeAt(13), sigma.charCodeAt(14), sigma.charCodeAt(15),
  ];
  const ctx = new Uint32Array(16);
  const kdv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const ndv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  ctx[0] = constants[0] | (constants[1] << 8) | (constants[2] << 16) | (constants[3] << 24);
  ctx[5] = constants[4] | (constants[5] << 8) | (constants[6] << 16) | (constants[7] << 24);
  ctx[10] = constants[8] | (constants[9] << 8) | (constants[10] << 16) | (constants[11] << 24);
  ctx[15] = constants[12] | (constants[13] << 8) | (constants[14] << 16) | (constants[15] << 24);
  ctx[1] = kdv.getUint32(0, true);
  ctx[2] = kdv.getUint32(4, true);
  ctx[3] = kdv.getUint32(8, true);
  ctx[4] = kdv.getUint32(12, true);
  if (key.length === 32) {
    ctx[11] = kdv.getUint32(16, true);
    ctx[12] = kdv.getUint32(20, true);
    ctx[13] = kdv.getUint32(24, true);
    ctx[14] = kdv.getUint32(28, true);
  } else {
    ctx[11] = ctx[1];
    ctx[12] = ctx[2];
    ctx[13] = ctx[3];
    ctx[14] = ctx[4];
  }
  ctx[6] = ndv.getUint32(0, true);
  ctx[7] = ndv.getUint32(4, true);
  ctx[8] = 0;
  ctx[9] = 0;

  let counter = 0;
  return (data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(data.length);
    for (let pos = 0; pos < data.length; pos += 64) {
      const h = salsa20WordToByte(ctx, rounds);
      counter = (counter + 1) % 0x100000000;
      ctx[8] = counter >>> 0;
      ctx[9] = Math.floor(counter / 0x100000000);
      const take = Math.min(64, data.length - pos);
      for (let j = 0; j < take; j += 1) {
        out[pos + j] = data[pos + j] ^ h[j];
      }
    }
    return out;
  };
}

// ============ MDict 专用解密 ============

/** fast_decrypt（XOR 族）：MDict v2 encrypt&2 的 key block info 解密 */
export function fastDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const b = new Uint8Array(data);
  let previous = 0x36;
  for (let i = 0; i < b.length; i += 1) {
    let t = ((b[i] >> 4) | (b[i] << 4)) & 0xff;
    t = t ^ previous ^ (i & 0xff) ^ key[i % key.length];
    previous = b[i];
    b[i] = t;
  }
  return b;
}

/**
 * 解密 key block info（v2 encrypt&2）：
 * key = ripemd128(adler32 字节(4) + LE uint32(0x3695))，作用于第 8 字节起的数据。
 * 输入为完整 block（前 4 字节压缩标记 + 4 字节 adler32 + 数据）。
 */
export function decryptHeaderBlock(block: Uint8Array): Uint8Array {
  if (block.length < 8) {
    throw new Error('key block info 块过短，无法解密');
  }
  const seed = new Uint8Array(8);
  seed.set(block.slice(4, 8));
  new DataView(seed.buffer).setUint32(4, 0x3695, true);
  const key = ripemd128(seed);
  const head = block.slice(0, 8);
  const body = fastDecrypt(block.slice(8), key);
  const out = new Uint8Array(block.length);
  out.set(head);
  out.set(body, 8);
  return out;
}

/** Salsa20 解密（encrypt=1 数据块 / 记录块用）：key = ripemd128(adler32 4 字节)，IV 全零，8 轮 */
export function salsaDecryptWithAdlerKey(adlerBytes: Uint8Array, data: Uint8Array): Uint8Array {
  const key = ripemd128(adlerBytes);
  const decryptor = salsa20(key, new Uint8Array(8), 8);
  return decryptor(data);
}

export const MDictCrypto = {
  ripemd128,
  salsa20,
  fastDecrypt,
  decryptHeaderBlock,
  salsaDecryptWithAdlerKey,
};

export default MDictCrypto;
