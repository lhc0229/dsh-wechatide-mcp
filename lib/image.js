/**
 * 纯 JS 的 PNG 编解码 + 重采样，供「截图按机型归一化」使用。
 *
 * 为什么不用 sharp / jimp：这个插件刻意保持零依赖（见 README「零依赖」），
 * 而 IDE 的 `simulator_screenshot` 只能给出「长边被钳到 1280/1300、宽度按机型比例反推」的图
 * （iPhone X 375×812 → 600×1300，Phone 12/13 Pro 390×844 → 602×1300）。
 * 想把文件尺寸对齐到机型逻辑宽高，只需解码 PNG → Lanczos 缩放 → 重新编码，
 * 这一步用 Node 自带的 `zlib` 就够，不必引入原生依赖。
 *
 * 支持范围（覆盖微信开发者工具的实际输出 + 常见截图）：
 * - PNG，8 bit/通道，非隔行；颜色类型 0/2/4/6（灰度、RGB、灰度+Alpha、RGBA）。
 * - 不支持：16 bit、调色板（type 3）、Adam7 隔行 —— 遇到就抛错，调用方降级为原图。
 *
 * @module dsh-wechatide-mcp/image
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

// ---- CRC32（PNG chunk 校验） ------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 解码 -------------------------------------------------------------------

/** 读取 PNG 头，不解析像素。 */
export function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 数据');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

/**
 * 解码 PNG 为 RGBA（8 bit/通道），返回值可直接交给 {@link resize}。
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,data:Uint8Array}} RGBA，长度 = width*height*4
 */
export function decodePng(buffer) {
  const info = pngInfo(buffer);
  if (info.bitDepth !== 8) throw new Error(`暂不支持 ${info.bitDepth} bit PNG`);
  if (info.interlace !== 0) throw new Error('暂不支持隔行（Adam7）PNG');
  const channels = CHANNELS_BY_COLOR_TYPE[info.colorType];
  if (channels === undefined) throw new Error(`暂不支持 PNG 颜色类型 ${info.colorType}`);

  // 收集 IDAT
  const parts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error('PNG 数据被截断');
    if (type === 'IDAT') parts.push(buffer.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4; // 跳过 CRC
  }
  if (parts.length === 0) throw new Error('PNG 缺少 IDAT');

  const raw = inflateSync(Buffer.concat(parts));
  const { width, height } = info;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('PNG 像素数据不完整');

  // 反 filter
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    unfilterRow(filter, line, out, prev, channels);
  }

  // 统一成 RGBA
  const data = new Uint8Array(width * height * 4);
  if (channels === 4) {
    data.set(pixels);
  } else if (channels === 3) {
    for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
      data[j] = pixels[i];
      data[j + 1] = pixels[i + 1];
      data[j + 2] = pixels[i + 2];
      data[j + 3] = 255;
    }
  } else if (channels === 2) {
    for (let i = 0, j = 0; i < pixels.length; i += 2, j += 4) {
      data[j] = pixels[i];
      data[j + 1] = pixels[i];
      data[j + 2] = pixels[i];
      data[j + 3] = pixels[i + 1];
    }
  } else {
    for (let i = 0, j = 0; i < pixels.length; i += 1, j += 4) {
      data[j] = pixels[i];
      data[j + 1] = pixels[i];
      data[j + 2] = pixels[i];
      data[j + 3] = 255;
    }
  }
  return { width, height, data };
}

function unfilterRow(filter, line, out, prev, bpp) {
  switch (filter) {
    case 0:
      out.set(line);
      return;
    case 1:
      for (let i = 0; i < line.length; i += 1) out[i] = (line[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
      return;
    case 2:
      for (let i = 0; i < line.length; i += 1) out[i] = (line[i] + (prev ? prev[i] : 0)) & 0xff;
      return;
    case 3:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? out[i - bpp] : 0;
        const up = prev ? prev[i] : 0;
        out[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? out[i - bpp] : 0;
        const up = prev ? prev[i] : 0;
        const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
        out[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`未知 PNG filter ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---- 编码 -------------------------------------------------------------------

/**
 * 把 RGBA 像素编码成 PNG。
 * 全不透明时写成 RGB（体积更小），否则保留 Alpha。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} image
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height } = image;
  const rgba = image.data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`非法尺寸 ${width}×${height}`);
  }
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None —— 截图数据熵高，过滤收益不值得复杂度
    const src = y * width * 4;
    const dst = rowStart + 1;
    if (channels === 3) {
      for (let x = 0; x < width; x += 1) {
        raw[dst + x * 3] = rgba[src + x * 4];
        raw[dst + x * 3 + 1] = rgba[src + x * 4 + 1];
        raw[dst + x * 3 + 2] = rgba[src + x * 4 + 2];
      }
    } else {
      raw.set(rgba.subarray(src, src + width * 4), dst);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

// ---- 重采样 -----------------------------------------------------------------

const LANCZOS_A = 3;

function lanczos(x) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= LANCZOS_A) return 0;
  const px = Math.PI * x;
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
}

/** 预计算一维 Lanczos 权重表：每个目标像素的 [start, weights[]]。 */
function weights1d(srcSize, dstSize) {
  const scale = dstSize / srcSize;
  const support = LANCZOS_A * Math.max(1, 1 / scale);
  const table = new Array(dstSize);
  for (let i = 0; i < dstSize; i += 1) {
    const center = (i + 0.5) / scale - 0.5;
    const left = Math.ceil(center - support);
    const right = Math.floor(center + support);
    const start = Math.max(0, left);
    const end = Math.min(srcSize - 1, right);
    const taps = end - start + 1;
    const weights = new Float64Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j += 1) {
      const w = lanczos((start + j - center) * Math.min(1, scale));
      weights[j] = w;
      sum += w;
    }
    if (sum === 0) {
      weights.fill(1 / taps);
      sum = 1;
    }
    for (let j = 0; j < taps; j += 1) weights[j] /= sum;
    table[i] = { start, weights };
  }
  return table;
}

/**
 * Lanczos3 双通道分离缩放。输入/输出都是 RGBA。
 * @param {{width:number,height:number,data:Uint8Array}} image
 * @param {number} width 目标宽
 * @param {number} height 目标高
 */
export function resize(image, width, height) {
  const { width: sw, height: sh, data } = image;
  if (width === sw && height === sh) return { width, height, data };
  if (width <= 0 || height <= 0) throw new Error(`非法目标尺寸 ${width}×${height}`);

  // 横向
  const xw = weights1d(sw, width);
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const rowBase = y * sw * 4;
    for (let x = 0; x < width; x += 1) {
      const { start, weights } = xw[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const idx = rowBase + (start + k) * 4;
        const w = weights[k];
        r += data[idx] * w;
        g += data[idx + 1] * w;
        b += data[idx + 2] * w;
        a += data[idx + 3] * w;
      }
      const out = (y * width + x) * 4;
      tmp[out] = r;
      tmp[out + 1] = g;
      tmp[out + 2] = b;
      tmp[out + 3] = a;
    }
  }

  // 纵向
  const yw = weights1d(sh, height);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const { start, weights } = yw[y];
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const col = x * 4;
      for (let k = 0; k < weights.length; k += 1) {
        const idx = (start + k) * width * 4 + col;
        const w = weights[k];
        r += tmp[idx] * w;
        g += tmp[idx + 1] * w;
        b += tmp[idx + 2] * w;
        a += tmp[idx + 3] * w;
      }
      out[rowBase + col] = clamp255(r);
      out[rowBase + col + 1] = clamp255(g);
      out[rowBase + col + 2] = clamp255(b);
      out[rowBase + col + 3] = clamp255(a);
    }
  }
  return { width, height, data: out };
}

function clamp255(value) {
  const v = Math.round(value);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function copyRow(image, from, to) {
  const stride = image.width * 4;
  image.data.copyWithin(to * stride, from * stride, from * stride + stride);
}

/**
 * 把截图对齐到机型的逻辑宽高（CSS px）。
 *
 * 策略：先按目标宽度等比缩放；高度差在容差内时「补/裁」底部若干像素，
 * 保证输出尺寸精确等于机型尺寸且**不拉伸画面**（等比缩放 + 最多几像素的
 * 底边复用/裁切，肉眼不可见）。比例差超出容差说明截图并不对应这台机型
 * （比如带了 IDE 工具条），此时保留等比结果并如实报告。
 *
 * @param {{width:number,height:number,data:Uint8Array}} image
 * @param {{width:number,height:number}} target 机型逻辑尺寸
 * @param {{tolerance?:number}} [options] tolerance = 允许补/裁的比例（默认 0.03）
 * @returns {{image:{width:number,height:number,data:Uint8Array}, source:{width:number,height:number}, clipped:number, padded:number, exact:boolean}}
 */
export function fitToDevice(image, target, options = {}) {
  const tolerance = options.tolerance ?? 0.03;
  const source = { width: image.width, height: image.height };
  const targetW = Math.round(target.width);
  const targetH = Math.round(target.height);
  if (!Number.isFinite(targetW) || !Number.isFinite(targetH) || targetW <= 0 || targetH <= 0) {
    throw new Error(`机型尺寸非法：${target.width}×${target.height}`);
  }
  const scaled = resize(image, targetW, Math.max(1, Math.round((image.height * targetW) / image.width)));
  const delta = scaled.height - targetH;
  const limit = Math.max(3, Math.round(targetH * tolerance));
  if (Math.abs(delta) <= limit) {
    if (delta > 0) {
      // 裁掉底部多余的 delta 行
      const data = scaled.data.subarray(0, targetW * targetH * 4);
      return { image: { width: targetW, height: targetH, data }, source, clipped: delta, padded: 0, exact: true };
    }
    if (delta < 0) {
      // 复用最后一行补齐底部
      const data = new Uint8Array(targetW * targetH * 4);
      data.set(scaled.data);
      const filled = { width: targetW, height: scaled.height + delta * -1, data };
      for (let i = 0; i < -delta; i += 1) copyRow(filled, scaled.height - 1 + i, scaled.height + i);
      return { image: { width: targetW, height: targetH, data }, source, clipped: 0, padded: -delta, exact: true };
    }
    return { image: scaled, source, clipped: 0, padded: 0, exact: true };
  }
  return { image: scaled, source, clipped: 0, padded: 0, exact: false };
}

// ---- 机型信息 ---------------------------------------------------------------

/**
 * 从 `automation_runtime_info(action=systemInfo)` 的结构化结果里取出机型与逻辑尺寸。
 * IDE 的 payload 形状是 `{ success, systemInfo: { result: {...} } }`，但不同版本
 * 可能少一层或直接平铺，所以这里做容错探测。
 * @param {unknown} payload
 * @returns {{model:string,system:string,width:number,height:number,pixelRatio:number}|undefined}
 */
export function readDeviceMetrics(payload) {
  const found = findSystemInfo(payload, 0);
  if (!found) return undefined;
  const width = number(found.screenWidth ?? found.windowWidth);
  const height = number(found.screenHeight ?? found.windowHeight);
  if (!width || !height) return undefined;
  return {
    model: typeof found.model === 'string' ? found.model : 'unknown',
    system: typeof found.system === 'string' ? found.system : '',
    width,
    height,
    pixelRatio: number(found.pixelRatio ?? found.devicePixelRatio) || 1,
  };
}

function findSystemInfo(node, depth) {
  if (node === null || typeof node !== 'object' || depth > 5) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findSystemInfo(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (number(node.screenWidth) && number(node.screenHeight) && typeof node.model === 'string') return node;
  for (const value of Object.values(node)) {
    const hit = findSystemInfo(value, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
