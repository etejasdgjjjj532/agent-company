import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "apps", "desktop", "build", "icon.png");

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp = (v) => Math.max(0, Math.min(1, v));
const cover = (distance) => clamp(0.5 - distance);

function roundedBox(x, y, half, radius) {
  const dx = Math.abs(x - SIZE / 2) - (half - radius);
  const dy = Math.abs(y - SIZE / 2) - (half - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function segment(x, y, a, b) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const t = clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

const root = { c: [256, 214], r: 62, color: hex("#7f77dd") };
const kids = [
  { c: [122, 372], r: 38, color: hex("#1d9e75") },
  { c: [256, 404], r: 38, color: hex("#378add") },
  { c: [390, 372], r: 38, color: hex("#1d9e75") },
];

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const shape = cover(roundedBox(px, py, 240, 104));
    const t = py / SIZE;
    let rgb = [32 - 14 * t, 36 - 15 * t, 58 - 22 * t];
    for (const kid of kids) {
      const a = cover(segment(px, py, root.c, kid.c) - 5) * 0.9;
      rgb = rgb.map((v, i) => v * (1 - a) + hex("#5a6490")[i] * a);
    }
    for (const node of [root, ...kids]) {
      const a = cover(Math.hypot(px - node.c[0], py - node.c[1]) - node.r);
      rgb = rgb.map((v, i) => v * (1 - a) + node.color[i] * a);
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(rgb[0]);
    raw[o + 1] = Math.round(rgb[1]);
    raw[o + 2] = Math.round(rgb[2]);
    raw[o + 3] = Math.round(shape * 255);
  }
}

const table = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
