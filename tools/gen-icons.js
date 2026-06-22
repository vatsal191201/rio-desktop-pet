// gen-icons.js — generates Rio's macOS tray template icon (a paw print) with a
// tiny self-contained PNG encoder, so we need no image dependencies.
//   node tools/gen-icons.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ---- minimal RGBA PNG encoder ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- tiny raster helpers on an RGBA buffer ----
function makeBuf(w, h) { return { w, h, data: Buffer.alloc(w * h * 4) }; }
function set(b, x, y, r, g, bl, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= b.w || y >= b.h) return;
  const i = (y * b.w + x) * 4; b.data[i] = r; b.data[i + 1] = g; b.data[i + 2] = bl; b.data[i + 3] = a;
}
function fillEll(b, cx, cy, rx, ry, r, g, bl, a) {
  for (let y = Math.ceil(-ry); y <= ry; y++)
    for (let x = Math.ceil(-rx); x <= rx; x++)
      if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) set(b, cx + x, cy + y, r, g, bl, a);
}

// ---- paw print (template image: black shape, alpha = silhouette) ----
function pawPrint(size) {
  const b = makeBuf(size, size);
  const u = size / 32; // design at 32, scale by u
  // big main pad (a soft rounded triangle made of stacked ellipses)
  fillEll(b, 16 * u, 22 * u, 8.5 * u, 7 * u, 0, 0, 0, 255);
  fillEll(b, 16 * u, 18 * u, 6 * u, 5 * u, 0, 0, 0, 255);
  // four toe beans
  fillEll(b, 7.5 * u, 12 * u, 3 * u, 3.6 * u, 0, 0, 0, 255);
  fillEll(b, 13 * u, 8 * u, 3.1 * u, 3.8 * u, 0, 0, 0, 255);
  fillEll(b, 19 * u, 8 * u, 3.1 * u, 3.8 * u, 0, 0, 0, 255);
  fillEll(b, 24.5 * u, 12 * u, 3 * u, 3.6 * u, 0, 0, 0, 255);
  return b;
}

const t16 = pawPrint(16), t32 = pawPrint(32);
fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), encodePNG(16, 16, t16.data));
fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), encodePNG(32, 32, t32.data));

// ---- a colourful paw as a fallback app icon (replaced later by a rig render) ----
function colorPaw(size) {
  const b = makeBuf(size, size);
  const u = size / 32;
  // rounded tan background
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rr = 6 * u, inx = Math.min(x, size - 1 - x), iny = Math.min(y, size - 1 - y);
    if (inx + iny < rr && (rr - inx) * (rr - inx) + (rr - iny) * (rr - iny) > rr * rr) continue;
    set(b, x, y, 0x2a, 0x22, 0x30, 255);
  }
  const paw = [[16, 21, 7.5, 6], [16, 17, 5, 4]];
  const beans = [[8, 12, 2.7, 3.2], [13, 8.5, 2.8, 3.4], [19, 8.5, 2.8, 3.4], [24, 12, 2.7, 3.2]];
  for (const [x, y, rx, ry] of paw) fillEll(b, x * u, y * u, rx * u, ry * u, 0xcf, 0x8a, 0x47, 255);
  for (const [x, y, rx, ry] of beans) fillEll(b, x * u, y * u, rx * u, ry * u, 0xcf, 0x8a, 0x47, 255);
  return b;
}
const ic = colorPaw(256);
fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePNG(256, 256, ic.data));

// ---- packaged-app icon: build/icon.png (1024) — tan paw on a dark squircle ----
function roundRect(b, x0, y0, x1, y1, r, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const cx = Math.max(x0 + r, Math.min(x1 - 1 - r, x));
    const cy = Math.max(y0 + r, Math.min(y1 - 1 - r, y));
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(b, x, y, rgb[0], rgb[1], rgb[2], 255);
  }
}
function appIcon(size) {
  const b = makeBuf(size, size);
  const u = size / 32;
  const m = Math.round(2.2 * u);
  roundRect(b, m, m, size - m, size - m, Math.round(6.2 * u), [0x2e, 0x27, 0x33]); // dark bg
  const paw = [[16, 20.5, 8, 6.5], [16, 16.5, 5.4, 4.5]];
  const beans = [[8, 11.5, 2.9, 3.5], [13, 7.8, 3.0, 3.7], [19, 7.8, 3.0, 3.7], [24, 11.5, 2.9, 3.5]];
  for (const [x, y, rx, ry] of paw) fillEll(b, x * u, y * u, rx * u, ry * u, 0xcd, 0x8a, 0x47, 255);
  for (const [x, y, rx, ry] of beans) fillEll(b, x * u, y * u, rx * u, ry * u, 0xcd, 0x8a, 0x47, 255);
  return b;
}
const BUILD = path.join(__dirname, '..', 'build');
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'icon.png'), encodePNG(1024, 1024, appIcon(1024).data));

console.log('wrote tray + icon assets to', ASSETS, 'and build/icon.png');
