#!/usr/bin/env node
/**
 * Render the WolffMsg mark to the PNG sizes a PWA install prompt needs.
 *
 * Written by hand rather than pulled from an image library: the mark is
 * straight-edged polygons, so rasterising it is a point-in-polygon test, and
 * PNG encoding is a zlib stream Node already provides. That keeps the icon
 * pipeline dependency-free and reproducible — `npm run icons` regenerates
 * byte-identical output from the same geometry the React component uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/web/public/icons',
);

/** The same 40×40 geometry as `packages/web/src/components/Logo.tsx`. */
const HEAD = [
  [20, 9.6], [26.4, 5.4], [32.9, 2], [34.6, 14.6], [31.6, 24.6],
  [20, 37.4], [8.4, 24.6], [5.4, 14.6], [7.1, 2], [13.6, 5.4],
];
const LEFT_EYE = [[12.9, 17.6], [18.6, 19.9], [13.6, 21.6]];
const RIGHT_EYE = [[27.1, 17.6], [21.4, 19.9], [26.4, 21.6]];
const MUZZLE = [[20, 25.4], [22.9, 28.6], [20, 31.8], [17.1, 28.6]];

const BACKGROUND = [6, 7, 10];
/** Aurora stops, sampled along the same diagonal as the CSS gradient. */
const STOPS = [
  { at: 0, rgb: [76, 91, 212] },
  { at: 0.48, rgb: [124, 140, 255] },
  { at: 1, rgb: [95, 227, 224] },
];

/** Crossing-number test; the caller combines shapes with the even-odd rule. */
function inPolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function gradientAt(t) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i += 1) {
    const a = STOPS[i - 1];
    const b = STOPS[i];
    if (clamped <= b.at) {
      const local = (clamped - a.at) / (b.at - a.at);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * local),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * local),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * local),
      ];
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

/**
 * @param size    output edge length in pixels
 * @param padding fraction of the edge kept clear around the mark
 * @param rounded corner radius as a fraction of the edge, 0 for a full bleed
 */
function render(size, { padding = 0.11, rounded = 0.22 } = {}) {
  // 4× supersampling, then box-filtered down — enough to keep the sharp
  // angles clean at 180px without a real anti-aliasing pipeline.
  const scale = 4;
  const big = size * scale;
  const pixels = Buffer.alloc(size * size * 4);

  const inset = big * padding;
  const span = big - inset * 2;
  const radius = rounded * big;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const px = x * scale + sx + 0.5;
          const py = y * scale + sy + 0.5;

          if (rounded > 0 && !insideRoundedRect(px, py, big, radius)) continue;

          // Background plate.
          let [cr, cg, cb] = BACKGROUND;

          const ux = ((px - inset) / span) * 40;
          const uy = ((py - inset) / span) * 40;

          const inHead = inPolygon(HEAD, ux, uy);
          const inHole =
            inPolygon(LEFT_EYE, ux, uy) ||
            inPolygon(RIGHT_EYE, ux, uy) ||
            inPolygon(MUZZLE, ux, uy);

          if (inHead && !inHole) {
            // Project onto the gradient's diagonal, matching the SVG's
            // (4,3) → (36,37) vector.
            const t = ((ux - 4) / 32 + (uy - 3) / 34) / 2;
            [cr, cg, cb] = gradientAt(t);
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const samples = scale * scale;
      const offset = (y * size + x) * 4;
      const alpha = a / samples;
      // Premultiplied averaging would darken the edge; divide by covered
      // samples instead so the colour stays true where coverage is partial.
      const covered = Math.max(1, a / 255);
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round(alpha);
    }
  }

  return pixels;
}

function insideRoundedRect(x, y, size, radius) {
  if (x < radius && y < radius) {
    return (x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2;
  }
  if (x > size - radius && y < radius) {
    return (x - (size - radius)) ** 2 + (y - radius) ** 2 <= radius ** 2;
  }
  if (x < radius && y > size - radius) {
    return (x - radius) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2;
  }
  if (x > size - radius && y > size - radius) {
    return (x - (size - radius)) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2;
  }
  return true;
}

/* ─────────────────────────── PNG encoding ──────────────────────────────── */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  // One filter byte (0 = none) per scanline, then the RGBA row.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────────────  main  ────────────────────────────────── */

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'icon-180.png', size: 180, options: {} },
  { name: 'icon-192.png', size: 192, options: {} },
  { name: 'icon-512.png', size: 512, options: {} },
  // Maskable icons are cropped to a circle by the launcher, so the mark needs
  // a wider safe area and no rounding of its own.
  {
    name: 'icon-maskable-512.png',
    size: 512,
    options: { padding: 0.22, rounded: 0 },
  },
  { name: 'favicon-32.png', size: 32, options: { padding: 0.06, rounded: 0.16 } },
];

for (const target of targets) {
  const pixels = render(target.size, target.options);
  fs.writeFileSync(path.join(OUT_DIR, target.name), encodePng(target.size, pixels));
  console.log(`wrote ${target.name} (${target.size}×${target.size})`);
}
