'use strict';
/* eslint-disable no-bitwise -- PNG decoding, filtering and CRC are bit operations */
/**
 * Minimal PNG reader/writer (Node's zlib only) used to remove the alpha channel from iOS icons.
 * App Store Connect rejects app icons that have an alpha channel (ITMS-90717), even when every
 * pixel is opaque, so iOS outputs are written as RGB PNGs.
 */

const { Buffer } = require('buffer');
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Color information that stays valid after dropping alpha; copied so colors render the same.
const COLOR_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  const chunks = [];
  for (let o = 8; o + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + length) });
    o += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function header(chunks) {
  const ihdr = chunks.find(c => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const d = ihdr.data;
  return { width: d.readUInt32BE(0), height: d.readUInt32BE(4), depth: d[8], colorType: d[9], interlace: d[12] };
}

/** True when the PNG has an alpha channel or a transparency (tRNS) chunk. */
function hasAlpha(buf) {
  const chunks = readChunks(buf);
  const { colorType } = header(chunks);
  return colorType === 4 || colorType === 6 || chunks.some(c => c.type === 'tRNS');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a non-interlaced PNG of any color type and bit depth to 8-bit RGBA. */
function decode(buf) {
  const chunks = readChunks(buf);
  const { width, height, depth, colorType, interlace } = header(chunks);
  if (interlace) throw new Error('interlaced PNGs are not supported; re-export the image without interlacing');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < height * (stride + 1)) throw new Error('PNG image data is truncated');

  const palette = chunks.find(c => c.type === 'PLTE');
  const trns = chunks.find(c => c.type === 'tRNS');
  const maxValue = (1 << depth) - 1;
  const sample = (row, index) => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2]; // high byte
    const bitOffset = index * depth;
    return (row[bitOffset >> 3] >> (8 - depth - (bitOffset & 7))) & maxValue;
  };
  const scale = v => (depth < 8 && colorType !== 3 ? Math.round((v * 255) / maxValue) : v);
  const keyed = (row, x) => {
    // tRNS on gray/RGB images marks one exact color as fully transparent (compared at full depth).
    if (!trns || (colorType !== 0 && colorType !== 2)) return false;
    const full = i => (depth === 16 ? row.readUInt16BE(i * 2) : sample(row, i));
    if (colorType === 0) return full(x) === trns.data.readUInt16BE(0);
    return [0, 1, 2].every(k => full(x * 3 + k) === trns.data.readUInt16BE(k * 2));
  };

  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0, p = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const v = raw[p++];
      cur[x] = filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const i = sample(cur, x);
        if (!palette || i * 3 + 2 >= palette.data.length) throw new Error('PNG palette index out of range');
        rgba[o] = palette.data[i * 3];
        rgba[o + 1] = palette.data[i * 3 + 1];
        rgba[o + 2] = palette.data[i * 3 + 2];
        rgba[o + 3] = trns && i < trns.data.length ? trns.data[i] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = scale(sample(cur, x * channels));
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sample(cur, x * 2 + 1) : keyed(cur, x) ? 0 : 255;
      } else {
        rgba[o] = sample(cur, x * channels);
        rgba[o + 1] = sample(cur, x * channels + 1);
        rgba[o + 2] = sample(cur, x * channels + 2);
        rgba[o + 3] = colorType === 6 ? sample(cur, x * 4 + 3) : keyed(cur, x) ? 0 : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba, colorChunks: chunks.filter(c => COLOR_CHUNKS.has(c.type)) };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes 8-bit RGB pixels; each row uses the filter with the smallest output (libpng heuristic). */
function encodeRgb(width, height, rgb, colorChunks = []) {
  const stride = width * 3;
  const filtered = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgb.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev[x];
        const c = x >= 3 ? prev[x - 3] : 0;
        const v = (row[x] - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 0xff;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        candidate.copy(best);
      }
    }
    filtered[y * (stride + 1)] = bestFilter;
    best.copy(filtered, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...colorChunks.map(c => chunk(c.type, c.data)),
    chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Returns the PNG without an alpha channel: transparent pixels are composited over `background`
 * ([r, g, b]). PNGs that already have no alpha are returned unchanged.
 */
function removeAlpha(buf, background) {
  if (!hasAlpha(buf)) return buf;
  const { width, height, rgba, colorChunks } = decode(buf);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3];
    for (let k = 0; k < 3; k++) rgb[j + k] = Math.round((rgba[i + k] * a + background[k] * (255 - a)) / 255);
  }
  return encodeRgb(width, height, rgb, colorChunks);
}

module.exports = { hasAlpha, decode, encodeRgb, removeAlpha };
