import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePng, encodePng, fitToDevice, pngInfo, readDeviceMetrics } from '../lib/image.js';

function gradient(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7) % 256;
      data[i + 1] = (y * 5) % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('PNG 编解码往返保持像素与尺寸', () => {
  const source = gradient(37, 61);
  const png = encodePng(source);
  const info = pngInfo(png);
  assert.deepEqual({ width: info.width, height: info.height, bitDepth: info.bitDepth }, { width: 37, height: 61, bitDepth: 8 });
  const decoded = decodePng(png);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 37, height: 61 });
  assert.equal(Buffer.compare(Buffer.from(decoded.data), Buffer.from(source.data)), 0);
});

test('编码保留 Alpha（半透明像素不被压成 RGB）', () => {
  const source = gradient(8, 8);
  source.data[3] = 128;
  const info = pngInfo(encodePng(source));
  assert.equal(info.colorType, 6, '应写 RGBA');
  assert.equal(decodePng(encodePng(source)).data[3], 128);
});

test('非 PNG 数据被明确拒绝', () => {
  assert.throws(() => decodePng(Buffer.from('nope')), /不是 PNG/);
});

test('fitToDevice 按机型宽度等比缩放并补齐底部到精确尺寸', () => {
  // 39×84 缩放到 390 宽 → 840 高，目标 844：补 4px
  const fit = fitToDevice(gradient(39, 84), { width: 390, height: 844 });
  assert.equal(fit.exact, true);
  assert.deepEqual({ width: fit.image.width, height: fit.image.height }, { width: 390, height: 844 });
  assert.equal(fit.padded, 4);
  assert.equal(fit.clipped, 0);
  assert.deepEqual(fit.source, { width: 39, height: 84 });
});

test('fitToDevice 裁掉底部多余的行而不拉伸', () => {
  // 300×650 → 目标 375×812：等比得到 812.5 → 813，裁 1px
  const fit = fitToDevice(gradient(300, 650), { width: 375, height: 812 });
  assert.equal(fit.exact, true);
  assert.deepEqual({ width: fit.image.width, height: fit.image.height }, { width: 375, height: 812 });
  assert.equal(fit.clipped, 1);
  assert.equal(fit.padded, 0);
});

test('fitToDevice 在比例差过大时拒绝硬凑', () => {
  // 带工具条的长图：600×800 对 390×844，比例差远超 3%
  const fit = fitToDevice(gradient(600, 800), { width: 390, height: 844 });
  assert.equal(fit.exact, false);
  assert.equal(fit.image.width, 390);
});

test('fitToDevice 对非法目标尺寸报错', () => {
  assert.throws(() => fitToDevice(gradient(4, 4), { width: 0, height: 0 }), /机型尺寸非法/);
});

test('readDeviceMetrics 兼容 IDE 的嵌套 payload', () => {
  const metrics = readDeviceMetrics({
    success: true,
    systemInfo: { result: { model: 'iPhone X', system: 'iOS 10.0.1', screenWidth: 375, screenHeight: 812, pixelRatio: 3 } },
  });
  assert.deepEqual(metrics, { model: 'iPhone X', system: 'iOS 10.0.1', width: 375, height: 812, pixelRatio: 3 });
});

test('readDeviceMetrics 兼容平铺与深层嵌套，缺字段时返回 undefined', () => {
  assert.deepEqual(readDeviceMetrics({ model: 'iPhone 12/13 (Pro)', screenWidth: 390, screenHeight: 844 }), {
    model: 'iPhone 12/13 (Pro)',
    system: '',
    width: 390,
    height: 844,
    pixelRatio: 1,
  });
  assert.equal(readDeviceMetrics({ success: true, screenWidth: 390 }), undefined);
  assert.equal(readDeviceMetrics(undefined), undefined);
  // 超过 5 层仍是对象就放弃：防止在无关键里无限下钻
  assert.equal(
    readDeviceMetrics({ a: { b: { c: { d: { e: { f: { model: 'too deep', screenWidth: 1, screenHeight: 1 } } } } } } }),
    undefined,
  );
});
