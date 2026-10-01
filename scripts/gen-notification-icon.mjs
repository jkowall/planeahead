#!/usr/bin/env node
/**
 * Generates `apps/mobile/assets/notification-icon.png`, the placeholder Android notification icon
 * (increment 16, ruling C5; R2 design 14), which expo-notifications' plugin scales to each screen
 * density at prebuild.
 *
 * Android draws a notification's small icon from its alpha channel alone, tinted with the
 * plugin's `color`, and FCM ignores an adaptive icon (R2 fact 41), so this one is white on
 * transparent, 96 by 96 pixels: the xxxhdpi size of the 24 dp status-bar icon. The glyph is the
 * app icon's paper plane (assets/icon-production.png) with its wing and its fold split by a gap
 * along the fold line, the one way an alpha channel can show the fold the app icon shades. It is
 * a placeholder until the owner's monochrome icon exists (R2 owner action 5); the runbook names
 * the swap.
 *
 * The output is committed. Pass `--check` to fail instead of writing when the committed file does
 * not decode to what this script draws (apps/mobile/__tests__/app-config.test.ts runs it). The
 * decoded image is compared, not the file's bytes, which another zlib build may deflate
 * differently.
 *
 * Dependency free: node:zlib deflates the image data and computes the chunk checksums.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(repoRoot, 'apps', 'mobile', 'assets', 'notification-icon.png');
const checkOnly = process.argv.includes('--check');

/** The canvas, in pixels: 24 dp at xxxhdpi, 4 px to the dp. */
const SIZE = 96;
/** The plane's width: the 20 dp live area of Material's 24 dp icon grid. */
const LIVE = 80;
/** The gap along the fold: 1 dp, one pixel at mdpi. */
const GAP = 4;
/** Samples per pixel along each axis (64 a pixel), for anti-aliased edges. */
const SAMPLES = 8;

// The paper plane of assets/icon-production.png (1024 px square), measured from its pixels: the
// wing tip, the nose, the tail, and the corner where the fold line turns towards the tail. The
// outline is the triangle wing, nose, tail; the fold runs from the nose to that corner to the tail.
const PLANE = { wing: [124, 530], nose: [900, 235], tail: [465, 825], fold: [493, 603] };

const scale = LIVE / (PLANE.nose[0] - PLANE.wing[0]);
const height = (PLANE.tail[1] - PLANE.nose[1]) * scale;
/** A point of the app icon on this canvas: the plane's bounding box, scaled and centred. */
const toCanvas = ([x, y]) => [
  (SIZE - LIVE) / 2 + (x - PLANE.wing[0]) * scale,
  (SIZE - height) / 2 + (y - PLANE.nose[1]) * scale,
];
const [wing, nose, tail, fold] = [PLANE.wing, PLANE.nose, PLANE.tail, PLANE.fold].map(toCanvas);

/** Which side of the line from `a` to `b` the point `p` is on: the sign of the cross product. */
function side(p, a, b) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/**
 * The squared distance from `p` to the segment from `a` to `b`. Squared, so the drawing uses only
 * arithmetic IEEE 754 rounds exactly (`Math.hypot` need not be), and every Node draws it alike.
 */
function squaredDistanceToSegment(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const along = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const t = Math.max(0, Math.min(1, along));
  const [ex, ey] = [p[0] - a[0] - t * dx, p[1] - a[1] - t * dy];
  return ex * ex + ey * ey;
}

/** Inside the outline and clear of the gap along the fold. */
function covered(p) {
  const sides = [side(p, wing, nose), side(p, nose, tail), side(p, tail, wing)];
  const inside = sides.every((s) => s >= 0) || sides.every((s) => s <= 0);
  const toFold = Math.min(
    squaredDistanceToSegment(p, nose, fold),
    squaredDistanceToSegment(p, fold, tail),
  );
  return inside && toFold >= (GAP / 2) * (GAP / 2);
}

/** The image data: per row a filter type byte (0, none), then RGBA, white with the coverage. */
function drawScanlines() {
  const stride = 1 + SIZE * 4;
  const raw = Buffer.alloc(SIZE * stride);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let hits = 0;
      for (let i = 0; i < SAMPLES; i += 1) {
        for (let j = 0; j < SAMPLES; j += 1) {
          if (covered([x + (i + 0.5) / SAMPLES, y + (j + 0.5) / SAMPLES])) hits += 1;
        }
      }
      const offset = y * stride + 1 + x * 4;
      raw.fill(255, offset, offset + 3);
      raw[offset + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
    }
  }
  return raw;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageHeader() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  // 8 bits a sample, RGBA, deflate, adaptive filtering, not interlaced.
  ihdr.set([8, 6, 0, 0, 0], 8);
  return ihdr;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encode(ihdr, raw) {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Whether `png` carries this header and this image data, every chunk's checksum intact. */
function decodesTo(png, ihdr, raw) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) return false;
  let header = null;
  const data = [];
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) return false;
    const end = offset + 8 + png.readUInt32BE(offset);
    if (end + 4 > png.length) return false;
    if (crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) return false;
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') header = png.subarray(offset + 8, end);
    if (type === 'IDAT') data.push(png.subarray(offset + 8, end));
    offset = end + 4;
  }
  if (header === null || !header.equals(ihdr) || data.length === 0) return false;
  try {
    return inflateSync(Buffer.concat(data)).equals(raw);
  } catch {
    return false;
  }
}

const ihdr = imageHeader();
const raw = drawScanlines();
const target = relative(repoRoot, outputPath);

let existing = null;
try {
  existing = readFileSync(outputPath);
} catch {
  existing = null;
}

if (existing !== null && decodesTo(existing, ihdr, raw)) {
  console.log(`gen-notification-icon: up to date (${target})`);
  process.exit(0);
}

if (checkOnly) {
  console.error('gen-notification-icon: FAIL');
  console.error(`  - ${target} is not the image scripts/gen-notification-icon.mjs draws`);
  console.error('  - run "node scripts/gen-notification-icon.mjs" and commit the result');
  process.exit(1);
}

writeFileSync(outputPath, encode(ihdr, raw));
console.log(`gen-notification-icon: wrote ${target}`);
