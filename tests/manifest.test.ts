/**
 * manifest.test.ts — "Add to Home Screen" is a silent feature: nothing throws
 * when the icon 404s or is the wrong size, you just get a grey square on the
 * player's phone and never hear about it. So assert the whole chain: the
 * manifest parses, declares what installability needs, and every icon it points
 * at exists and is REALLY the pixel size it claims — read out of the PNG's own
 * IHDR header, not inferred from the filename.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
}

const manifest = JSON.parse(
  readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'),
) as Manifest;
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

/** Width/height straight out of the PNG signature + IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(0, 8).equals(sig)).toBe(true);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('web app manifest', () => {
  it('declares everything an install prompt needs', () => {
    expect(manifest.name).toBe('Hexbloom');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // longer gets truncated on the home screen
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('keeps start_url and scope relative', () => {
    // The game is served from a project subpath in dev and its own domain in
    // prod. An absolute "/" would send the installed icon to the host root.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('points every icon at a real PNG of the size it claims', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const file = join(PUBLIC, icon.src);
      const [w, h] = icon.sizes.split('x').map(Number);
      const actual = pngSize(file);
      expect({ icon: icon.src, ...actual }).toEqual({ icon: icon.src, width: w, height: h });
      expect(icon.type).toBe('image/png');
    }
  });

  it('ships the 192 and 512 any-purpose icons plus a maskable 512', () => {
    const any = manifest.icons.filter((i) => (i.purpose ?? 'any').includes('any'));
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    // Android crops a non-maskable icon into its adaptive shape and slices the
    // outer hexes off. The maskable one is drawn full-bleed for exactly that.
    const maskable = manifest.icons.filter((i) => i.purpose?.includes('maskable'));
    expect(maskable.map((i) => i.sizes)).toEqual(['512x512']);
  });
});

describe('index.html install wiring', () => {
  it('links the manifest and the theme colour', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(indexHtml).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
  });

  it('carries the iOS set, because iOS ignores the manifest', () => {
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-title"');
  });

  it('has an apple-touch-icon that is 180x180 and fully OPAQUE', () => {
    const href = /rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(indexHtml)?.[1];
    expect(href).toBeTruthy();
    expect(href!.startsWith('./')).toBe(true);
    const file = join(PUBLIC, href!);
    expect(pngSize(file)).toEqual({ width: 180, height: 180 });

    // iOS composites a transparent icon onto BLACK, so a rounded tile with
    // transparent corners comes out ringed. Ours must bleed to the edge: check
    // the actual corner pixels, which is where that would show.
    const png = readFileSync(file);
    const alpha = corners(png);
    expect(alpha).toEqual([255, 255, 255, 255]);
  });

  it('registers no service worker — a stale cache would outlive every deploy', () => {
    expect(indexHtml).not.toContain('serviceWorker');
    expect(indexHtml).not.toContain('sw.js');
  });
});

/** Alpha of the four corner pixels, by inflating the PNG's own IDAT. */
function corners(png: Buffer): number[] {
  const size = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = size * 4 + 1; // one filter byte per scanline
  for (let y = 0; y < size; y++) expect(raw[y * stride]).toBe(0); // filter 0: rows are literal
  const at = (x: number, y: number): number => raw[y * stride + 1 + x * 4 + 3];
  return [at(0, 0), at(size - 1, 0), at(0, size - 1), at(size - 1, size - 1)];
}
