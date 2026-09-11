/**
 * 生成 Android 通知状态栏小图标 `ic_stat_daybook`，零依赖——手写 PNG 编码 + 简单光栅化。
 *
 *   node source/scripts/make-notification-icon.mjs
 *
 * 图案：白色不透明「翻开的本子 + 三条横线」+ 全透明背景（符合 Android 通知小图标的规范：
 * 系统会把它当作纯 alpha 遮罩染色，所以只能有白色像素和透明像素）。
 *
 * 复用与 make-icons.mjs 同款的手写 PNG 编码器（CRC32 + node:zlib deflate），不引任何依赖。
 * 产物写到 android 的五个密度目录：drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_stat_daybook.png。
 * 可重复运行（幂等覆盖）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const resDir = join(here, '..', 'web', 'android', 'app', 'src', 'main', 'res');

/** 密度目录 → 期望的像素尺寸（mdpi 基准 24dp）。 */
const DENSITIES = [
  ['mdpi', 24],
  ['hdpi', 36],
  ['xhdpi', 48],
  ['xxhdpi', 72],
  ['xxxhdpi', 96],
];

/* ----------------------------- PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4 + 1; // 每行前面加一个 filter 字节
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 光栅化 ------------------------------- */

/** 圆角矩形的覆盖率（0–1），用像素中心到圆角矩形的距离做一像素抗锯齿。 */
function rectCoverage(px, py, x0, y0, x1, y1, radius) {
  const r = Math.max(radius, 0);
  const clampedX = Math.min(Math.max(px, x0 + r), x1 - r);
  const clampedY = Math.min(Math.max(py, y0 + r), y1 - r);
  const distance = Math.hypot(px - clampedX, py - clampedY) - r;
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

/** 圆角矩形「描边环」的覆盖率（外矩形覆盖率 − 内矩形覆盖率）。 */
function ringCoverage(px, py, x0, y0, x1, y1, radius, thickness) {
  const outer = rectCoverage(px, py, x0, y0, x1, y1, radius);
  const inner = rectCoverage(px, py, x0 + thickness, y0 + thickness, x1 - thickness, y1 - thickness, radius - thickness);
  return Math.min(Math.max(outer - inner, 0), 1);
}

/**
 * 画「翻开的本子 + 三条横线」：左右两页各是一个白色描边环（中间留出书脊的透明缝），
 * 每页内再画三条白色横线。全部白色、背景透明。
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);

  const stroke = size * 0.075;
  const radius = size * 0.06;
  const lineThickness = size * 0.06;
  const pages = [
    { x0: size * 0.14, x1: size * 0.487, y0: size * 0.2, y1: size * 0.8 },
    { x0: size * 0.513, x1: size * 0.86, y0: size * 0.2, y1: size * 0.8 },
  ];
  const lineCenters = [size * 0.37, size * 0.5, size * 0.63];
  const lineInset = size * 0.07;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let alpha = 0;

      for (const page of pages) {
        alpha = Math.max(alpha, ringCoverage(cx, cy, page.x0, page.y0, page.x1, page.y1, radius, stroke));
        for (const center of lineCenters) {
          alpha = Math.max(
            alpha,
            rectCoverage(
              cx,
              cy,
              page.x0 + lineInset,
              center - lineThickness / 2,
              page.x1 - lineInset,
              center + lineThickness / 2,
              lineThickness / 2,
            ),
          );
        }
      }

      alpha = Math.min(Math.max(alpha, 0), 1);
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

/* -------------------------------- main ------------------------------- */

for (const [density, size] of DENSITIES) {
  const outDir = join(resDir, `drawable-${density}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'ic_stat_daybook.png');
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`已生成 ${file} (${size}x${size})`);
}
