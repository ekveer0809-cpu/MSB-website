// Generates the PWA icons (no dependencies): a clock face on an indigo tile.
import fs from 'node:fs';
import zlib from 'node:zlib';

function png(size, { maskable }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2, scale = maskable ? 0.62 : 0.78; // maskable keeps art inside the safe zone
  const R = (size / 2) * scale, ring = R * 0.14;
  const segDist = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3, d = Math.hypot(px - c, py - c);
        const onRing = Math.abs(d - R) <= ring / 2;
        const onHand = segDist(px, py, c, c, c, c - R * 0.55) <= ring / 2 || segDist(px, py, c, c, c + R * 0.4, c) <= ring / 2;
        if (onRing || onHand) hit++;
      }
      const a = hit / 9, o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(79 + (255 - 79) * a); raw[o + 1] = Math.round(70 + (255 - 70) * a);
      raw[o + 2] = Math.round(229 + (255 - 229) * a); raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync('public/icons', { recursive: true });
fs.writeFileSync('public/icons/icon-192.png', png(192, { maskable: false }));
fs.writeFileSync('public/icons/icon-512.png', png(512, { maskable: false }));
fs.writeFileSync('public/icons/maskable-512.png', png(512, { maskable: true }));
console.log('icons written');
