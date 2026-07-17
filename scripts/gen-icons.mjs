/**
 * gen-icons.mjs — rasterise the Hexbloom mark into the PNGs a phone home screen
 * needs. Run after any change to public/favicon.svg:
 *
 *   npm run gen:icons
 *
 * The geometry below is favicon.svg's, in its 32x32 viewBox, so the installed
 * icon and the tab icon stay the same drawing — no second visual identity to
 * keep in step. Rasterising is done here rather than with sharp/resvg because the
 * repo carries no image dependency and this mark is four hexes on a rounded
 * rect: a scanline point-in-polygon pass with 4x4 supersampling is enough, and a
 * PNG is just zlib + four chunks.
 *
 * Three shapes of icon, because the platforms disagree about who crops:
 *  - plain (192/512): the mark on its own rounded tile, transparent outside it.
 *  - maskable (512): FULL-BLEED background with the mark pulled into the middle
 *    ~72%. Android applies its own mask, and a non-maskable icon fed to it gets
 *    its corners — and here its outer hexes — sliced off.
 *  - apple-touch (180): full-bleed and OPAQUE. iOS ignores the manifest entirely
 *    and composites any transparency onto BLACK, which would ring the tile.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/** favicon.svg's palette + geometry, in its 32x32 viewBox. */
const BG = '#14161c';
const HEXES = [
  { fill: '#e69f00', pts: [[16, 4], [22, 7.5], [22, 14.5], [16, 18], [10, 14.5], [10, 7.5]] },
  { fill: '#0072b2', pts: [[9, 10], [15, 13.5], [15, 20.5], [9, 24], [3, 20.5], [3, 13.5]] },
  { fill: '#009e73', pts: [[23, 10], [29, 13.5], [29, 20.5], [23, 24], [17, 20.5], [17, 13.5]] },
  { fill: '#d55e00', pts: [[16, 17], [22, 20.5], [22, 27.5], [16, 31], [10, 27.5], [10, 20.5]] },
];
const VIEW = 32;
/** favicon.svg strokes each hex with the background colour to separate them. */
const STROKE = 1;
const SS = 4; // supersamples per axis

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

function inPoly(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Grow a polygon about its centroid — how the SVG's stroke reads once filled. */
function expand(pts, by) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return pts.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * by, y + ((y - cy) / d) * by];
  });
}

function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  // Nearest point of the straight-edged core; only the corners can fall outside.
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/**
 * @param {number} size  output px
 * @param {{ bleed?: boolean, inset?: number }} opts
 *   bleed: background covers the whole square (no rounded tile, no transparency)
 *   inset: scale the mark about the centre (maskable safe zone)
 */
function render(size, opts = {}) {
  const { bleed = false, inset = 1 } = opts;
  const bg = rgb(BG);
  const radius = 7; // favicon.svg's rx, in viewBox units
  const shapes = [
    ...HEXES.flatMap((h) => [
      { pts: expand(h.pts, STROKE / 2), rgb: bg }, // the stroke, painted first
      { pts: h.pts, rgb: rgb(h.fill) },
    ]),
  ].map((s) => ({
    ...s,
    // Pull the mark into the safe zone about the viewBox centre.
    pts: s.pts.map(([x, y]) => [
      VIEW / 2 + (x - VIEW / 2) * inset,
      VIEW / 2 + (y - VIEW / 2) * inset,
    ]),
  }));

  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Subpixel centre, mapped into the 32x32 viewBox.
          const vx = ((pxx + (sx + 0.5) / SS) / size) * VIEW;
          const vy = ((py + (sy + 0.5) / SS) / size) * VIEW;
          let hit = null;
          if (bleed || inRoundedRect(vx, vy, VIEW, VIEW, radius)) hit = bg;
          for (const s of shapes) if (inPoly(s.pts, vx, vy)) hit = s.rgb;
          if (hit) {
            r += hit[0];
            g += hit[1];
            b += hit[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxx) * 4;
      // Premultiplied average: outside the tile every sample is empty, so the
      // colour there is undefined and must not be divided by a zero coverage.
      const cov = a / 255;
      px[i] = cov ? Math.round(r / cov) : 0;
      px[i + 1] = cov ? Math.round(g / cov) : 0;
      px[i + 2] = cov ? Math.round(b / cov) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return png(px, size);
}

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA, no interlace. Filter 0 per scanline — the mark compresses fine. */
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── output ──────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  ['icon-maskable-512.png', render(512, { bleed: true, inset: 0.72 })],
  ['apple-touch-icon-180.png', render(180, { bleed: true })],
];
for (const [name, buf] of files) {
  writeFileSync(join(OUT, name), buf);
  console.log(`${name}  ${buf.length} bytes`);
}
