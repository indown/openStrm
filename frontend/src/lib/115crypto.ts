const G_kts = new Uint8Array([
    0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a, 
    0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8, 
    0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4, 
    0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa, 
    0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86, 
    0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6, 
    0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd, 
    0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7, 
    0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e, 
    0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86, 
    0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34, 
    0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81, 
    0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59, 
    0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48, 
    0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77, 
    0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e, 
    0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b, 
    0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5, 
  ]);
const RSA_e = BigInt('0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683');
const RSA_n = BigInt('0x10001');

function padPkcs1V1_5(message) {
    const msg_len = message.length
    const buffer = new Uint8Array(128);
    buffer.fill(0x02, 1, 127 - msg_len);
    buffer.set(message, 128 - msg_len);
    return fromBytes(buffer);
}
export function encrypt(data: string | Uint8Array) {
  if (typeof data === "string")
      data = (new TextEncoder()).encode(data);
  const xorText = new Uint8Array(16 + data.length);
  xorText.set(xor(
      xor(data, new Uint8Array([0x8d, 0xa5, 0xa5, 0x8d])).reverse(), 
      new Uint8Array([0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46])
  ), 16);
  const cipherData = new Uint8Array(Math.ceil(xorText.length / 117) * 128);
  let start = 0;
  for (const [l, r] of accStep(0, xorText.length, 117)) {
      const chunk = toBytes(pow(padPkcs1V1_5(xorText.subarray(l, r)), RSA_n, RSA_e), 128);
      cipherData.set(chunk, start);
      start += 128;
  }
  return Buffer.from(cipherData).toString("base64");
}
function pow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === BigInt(1))
      return BigInt(0);
  let result = BigInt(1);
  base %= modulus;
  while (exponent) {
      if (exponent & BigInt(1))
          result = (result * base) % modulus;
      exponent = exponent >> BigInt(1);
      base = (base * base) % modulus;
  }
  return result;
}
export function decrypt(cipherData: string): string {
  const cipher_data = new Uint8Array(Buffer.from(cipherData, "base64"));
  const data: number[] = [];
  for (const [l, r] of accStep(0, cipher_data.length, 128)) {
      const p = pow(fromBytes(cipher_data.subarray(l, r)), RSA_n, RSA_e);
      const b = toBytes(p);
      data.push(...b.subarray(b.indexOf(0) + 1));
  }
  const dataArray = new Uint8Array(data);
  const keyL = genKey(dataArray.subarray(0, 16), 12);
  const tmp = xor(dataArray.subarray(16), keyL).reverse();
  return (new TextDecoder("utf-8")).decode(xor(tmp, new Uint8Array([0x8d, 0xa5, 0xa5, 0x8d])));
}
function genKey(randKey, skLen) {
  const xorKey = new Uint8Array(skLen);
  let length = skLen * (skLen - 1);
  let index = 0;
  for (let i = 0; i < skLen; i++) {
      const x = (randKey[i] + G_kts[index]) & 0xff;
      xorKey[i] = G_kts[length] ^ x;
      length -= skLen;
      index += skLen;
  }
  return xorKey;
}
function fromBytes(bytes: Uint8Array): bigint {
  let intVal = BigInt(0);
  for (const b of bytes)
      intVal = (intVal << BigInt(8)) | BigInt(b);
  return intVal;
}
function xor(src, key) {
  const buffer = new Uint8Array(src.length);
  const i = src.length & 0b11;
  if (i)
      buffer.set(bytesXor(src.subarray(0, i), key.subarray(0, i)));
  for (const [j, k] of accStep(i, src.length, key.length))
      buffer.set(bytesXor(src.subarray(j, k), key), j);
  return buffer;
}
function bytesXor(v1, v2) {
  const result = new Uint8Array(v1.length);
  for (let i = 0; i < v1.length; i++)
      result[i] = v1[i] ^ v2[i];
  return result;
}
function* accStep(start, stop, step = 1) {
  for (let i = start + step; i < stop; i += step) {
      yield [start, i, step];
      start = i;
  }
  if (start !== stop)
      yield [start, stop, stop - start];
}
function toBytes(value: bigint, length?: number): Uint8Array {
  if (length == undefined)
      length = Math.ceil(value.toString(16).length / 2);
  const buffer = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
      buffer[i] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
  }
  return buffer;
}