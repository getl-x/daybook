/**
 * 生成 PWA 图标（192 / 512 的 PNG），零依赖——手写 PNG 编码 + 简单光栅化。
 *
 *   node source/scripts/make-icons.mjs
 *
 * 图案：深色圆角方块 + 浅色"书页" + 三条横线（日记本意象）。
 * 想换图标就改下面的颜色/尺寸后重跑；产物在 web/public/icons/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'web', 'public', 'icons');

const BACKGROUND = [15, 23, 42, 255]; // slate-900
const PAGE = [248, 250, 252, 255]; // slate-50
const LINE = [148, 163, 184, 255]; // slate-400

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

/**
 * 圆角矩形的覆盖率（0–1），用像素中心到圆角矩形的距离做一像素抗锯齿。
 * 坐标都以像素为单位。
 */
function coverage(px, py, x0, y0, x1, y1, radius) {
  const clampedX = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const clampedY = Math.min(Math.max(py, y0 + radius), y1 - radius);
  const distance = Math.hypot(px - clampedX, py - clampedY) - radius;
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

function blend(target, color, alpha) {
  if (alpha <= 0) return;
  const a = alpha * (color[3] / 255);
  for (let channel = 0; channel < 3; channel += 1) {
    target[channel] = Math.round(target[channel] * (1 - a) + color[channel] * a);
  }
  target[3] = Math.round(target[3] * (1 - a) + 255 * a);
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, value) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = value[0];
    pixels[offset + 1] = value[1];
    pixels[offset + 2] = value[2];
    pixels[offset + 3] = value[3];
  };

  // 书页与横线的位置（按比例算，保证 192 和 512 视觉一致）
  const pageX0 = size * 0.28;
  const pageY0 = size * 0.22;
  const pageX1 = size * 0.72;
  const pageY1 = size * 0.78;
  const lineX0 = size * 0.365;
  const lineX1 = size * 0.635;
  const lineThickness = size * 0.045;
  const lineCenters = [size * 0.36, size * 0.5, size * 0.64].filter((y) => y < pageY1 - lineThickness);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let color = [0, 0, 0, 0];

      // 背景圆角方块
      blend(color, BACKGROUND, coverage(cx, cy, 0, 0, size, size, size * 0.22));
      // 书页
      blend(color, PAGE, coverage(cx, cy, pageX0, pageY0, pageX1, pageY1, size * 0.06));
      // 三条横线
      for (const center of lineCenters) {
        blend(
          color,
          LINE,
          coverage(
            cx,
            cy,
            lineX0,
            center - lineThickness / 2,
            lineX1,
            center + lineThickness / 2,
            lineThickness / 2,
          ),
        );
      }

      set(x, y, color);
    }
  }

  return pixels;
}

/* -------------------------------- main ------------------------------- */

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`已生成 ${file}`);
}
