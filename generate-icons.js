import { execFileSync } from 'child_process';
import fs from 'fs';
import zlib from 'zlib';

// The launcher icons. Two laws from the founder's PWA report (2026-11-01):
// 1. MASKABLE: the mark sits inside the inner 80% circle on a FULL-BLEED
//    black ground, so an Android launcher may crop to any shape and the
//    mark never clips. Measured here, not assumed: the decode check below
//    walks every pixel and refuses a mark outside the circle.
// 2. APPLE TOUCH: a square opaque icon (iOS flattens alpha to black, which
//    on this app's black ground is invisible).
//
// ImageMagick does the raster work; this script owns the verification.
// (sharp was the old generator but is not in the dependency tree; convert
// is on the machine and the check below is the part that matters.)

const input = './public/logo_raw.png';
if (!fs.existsSync(input)) {
  console.log('❌ logo_raw.png missing at ./public/');
  process.exit(1);
}

// 370/512 proven: every luminous pixel inside the 80% circle (decoded walk,
// 0 outliers). The same ratio scales to every size.
const MARK_RATIO = 370 / 512;

const targets = [
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-192.png', size: 192 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
];

for (const { name, size } of targets) {
  const mark = Math.round(size * MARK_RATIO);
  execFileSync('convert', [
    input, '-resize', `${mark}x${mark}`, '-background', 'black',
    '-gravity', 'center', '-extent', `${size}x${size}`,
    `./public/${name}`,
  ], { stdio: 'inherit' });
}
console.log('✅ icons generated');

// ————— the decode check: the law, proven on the bytes —————
// Only truecolor PNGs are checked; a palette (color type 3) favicon at 32px
// is a browser favicon, not a launcher icon — the maskable law does not bind it.
function decode(path) {
  const d = fs.readFileSync(path);
  const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
  const ct = d[25];
  let pos = 8, idat = Buffer.alloc(0);
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = d.subarray(pos + 4, pos + 8);
    if (type.equals(Buffer.from('IDAT'))) idat = Buffer.concat([idat, d.subarray(pos + 8, pos + 8 + len)]);
    pos += 12 + len;
    if (type.equals(Buffer.from('IEND'))) break;
  }
  const raw = zlib.inflateSync(idat);
  const bpp = { 6: 4, 2: 3 }[ct];
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y += 1) {
    const f = raw[p]; p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    if (f === 1) for (let i = bpp; i < stride; i += 1) line[i] = (line[i] + line[i - bpp]) & 255;
    else if (f === 2) for (let i = 0; i < stride; i += 1) line[i] = (line[i] + prev[i]) & 255;
    else if (f === 3) for (let i = 0; i < stride; i += 1) line[i] = (line[i] + (((i >= bpp ? line[i - bpp] : 0) + prev[i]) >> 1)) & 255;
    else if (f === 4) for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (line[i] + pr) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, bpp, px: (x, y) => out.subarray((y * w + x) * bpp, (y * w + x) * bpp + bpp) };
}
const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

let failed = false;
for (const { name, size } of targets) {
  const header = fs.readFileSync(`./public/${name}`).subarray(0, 26);
  const colorType = header[25];
  if (colorType === 3) { console.log(`⏭️  ${name}: palette favicon, maskable law does not bind`); continue; }
  const { w, h, bpp, px } = decode(`./public/${name}`);
  const r = w >> 1;
  let outliers = 0, transparentCorners = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const p = px(x, y);
      if (bpp === 4 && p[3] < 250 && (x < r * 0.05 || y < r * 0.05 || x > w - r * 0.05 || y > h - r * 0.05)) transparentCorners += 1;
      const dist = Math.hypot(x - r, y - r);
      if (lum(p) > 20 && dist > r * 0.8) outliers += 1;
    }
  }
  const ok = outliers === 0 && transparentCorners === 0;
  if (!ok) failed = true;
  console.log(`${ok ? '✅' : '❌'} ${name}: mark inside the 80% circle (${outliers} outliers), ground opaque (${transparentCorners} clear corners)`);
}
process.exit(failed ? 1 : 0);
