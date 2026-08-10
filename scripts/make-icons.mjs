/**
 * Generate app icons as PNGs.
 *
 * Written by hand rather than pulled from a library: this repo has no image
 * tooling installed, and adding a dependency to draw four rectangles would be
 * a poor trade. PNG is a simple container — signature, header, zlib-compressed
 * scanlines, terminator — and zlib ships with Node.
 *
 * Design: dark ground, three ascending bars. Reads as a budget app at 60px on a
 * home screen, which is the only size that matters.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../web/icons/', import.meta.url).pathname;

const BG = [26, 29, 35];        // near-black, matches the app's dark surface
const BAR = [111, 191, 149];    // the app's accent green
const BAR_DIM = [79, 154, 117]; // shorter bars sit back slightly

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGB pixel data as a PNG. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  // 10-12: compression, filter, interlace — all zero (default/none)

  // Each scanline is prefixed with a filter byte; 0 means no filtering.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[offset++] = pixels[i];
      raw[offset++] = pixels[i + 1];
      raw[offset++] = pixels[i + 2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the icon.
 *
 * `padded` insets the artwork so Android's maskable icons can crop to a circle
 * without clipping the bars — the safe zone is the middle 80%.
 */
function drawIcon(size, { padded = false } = {}) {
  const pixels = Buffer.alloc(size * size * 3);

  for (let i = 0; i < size * size; i++) {
    pixels[i * 3] = BG[0];
    pixels[i * 3 + 1] = BG[1];
    pixels[i * 3 + 2] = BG[2];
  }

  const inset = padded ? 0.26 : 0.20;
  const left = Math.round(size * inset);
  const right = size - left;
  const usable = right - left;

  const gap = Math.max(2, Math.round(usable * 0.09));
  const barWidth = Math.round((usable - gap * 2) / 3);
  // Ascending, as a budget trending the right way.
  const heights = [0.42, 0.68, 1.0];
  const bottom = right;
  const radius = Math.max(1, Math.round(barWidth * 0.22));

  heights.forEach((fraction, index) => {
    const x0 = left + index * (barWidth + gap);
    const x1 = x0 + barWidth;
    const barHeight = Math.round(usable * fraction);
    const y0 = bottom - barHeight;
    const colour = index === 2 ? BAR : BAR_DIM;

    for (let y = y0; y < bottom; y++) {
      for (let x = x0; x < x1; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;

        // Round the top corners only, so the bars sit on a common baseline.
        const dx = Math.min(x - x0, x1 - 1 - x);
        const dy = y - y0;
        if (dy < radius && dx < radius) {
          const ddx = radius - dx;
          const ddy = radius - dy;
          if (ddx * ddx + ddy * ddy > radius * radius) continue;
        }

        const i = (y * size + x) * 3;
        pixels[i] = colour[0];
        pixels[i + 1] = colour[1];
        pixels[i + 2] = colour[2];
      }
    }
  });

  return encodePng(size, size, pixels);
}

mkdirSync(OUT, { recursive: true });

const icons = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // Android maskable: extra padding so a circular crop doesn't cut the bars.
  ['icon-maskable-512.png', 512, { padded: true }],
  // iOS home screen. Apple ignores the manifest and reads apple-touch-icon,
  // and it does not apply transparency, so the ground must be opaque.
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of icons) {
  writeFileSync(OUT + name, drawIcon(size, opts));
  console.log(`wrote ${name} (${size}x${size})`);
}
