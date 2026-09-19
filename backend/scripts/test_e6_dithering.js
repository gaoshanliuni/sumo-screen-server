const assert = require("assert");
const Jimp = require("jimp");
const {
  convertImageBufferToE6P4,
  DEFAULT_E6_DITHER_MODE,
  E6_PACKED4_SIZE,
  E6_CONVERTER_VERSION,
  ditherJimpToE6Indices,
  packE6LogicalIndices,
  previewE6Buffer,
} = require("../src/services/e6/e6_converter.service");

(async () => {
  const width = 120;
  const height = 80;
  const image = await new Jimp(width, height, 0xffffffff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const r = Math.round((x / (width - 1)) * 255);
      const g = Math.round((y / (height - 1)) * 255);
      const b = Math.round(((x + y) / (width + height - 2)) * 255);
      image.setPixelColor(Jimp.rgbaToInt(r, g, b, 255), x, y);
    }
  }
  const png = await image.getBufferAsync(Jimp.MIME_PNG);
  const dithered = await convertImageBufferToE6P4(png, { fit: "contain" });
  const plain = await convertImageBufferToE6P4(png, { fit: "contain", dither: false });

  assert.strictEqual(dithered.buffer.length, E6_PACKED4_SIZE);
  assert.strictEqual(DEFAULT_E6_DITHER_MODE, "waveshare_floyd");
  assert.strictEqual(E6_CONVERTER_VERSION, "e6-waveshare-v1");
  assert.strictEqual(dithered.converterEngine, "waveshare");
  assert.strictEqual(plain.buffer.length, E6_PACKED4_SIZE);
  assert.strictEqual(dithered.dither, true, "dithering should be enabled by default");
  assert.strictEqual(dithered.ditherMode, "waveshare_floyd", "waveshare_floyd should be the default dither mode");
  assert.strictEqual(plain.dither, false, "explicit dither:false should be preserved");
  assert.strictEqual(plain.ditherMode, "poster_clean", "dither:false should use poster_clean");
  assert.notStrictEqual(
    dithered.sha256,
    plain.sha256,
    "waveshare_floyd dithering should change the packed output for gradients"
  );
  for (const mode of ["waveshare_floyd", "poster_clean", "photo_detail", "photo_soft", "art_blue_noise"]) {
    const converted = await convertImageBufferToE6P4(png, { fit: "contain", ditherMode: mode });
    assert.strictEqual(converted.buffer.length, E6_PACKED4_SIZE, `${mode} should keep packed4 size`);
    assert.strictEqual(converted.ditherMode, mode, `${mode} should be reported in conversion result`);
    assert.strictEqual(converted.dither, mode !== "poster_clean", `${mode} should report whether diffusion dithering is enabled`);
    assert.strictEqual(converted.converterEngine, mode === "waveshare_floyd" ? "waveshare" : "custom");
  }

  const paletteImage = await new Jimp(6, 1, 0xffffffff);
  [
    [20, 20, 20],
    [245, 245, 235],
    [180, 35, 35],
    [220, 180, 40],
    [40, 80, 160],
    [55, 130, 70],
  ].forEach(([r, g, b], x) => paletteImage.setPixelColor(Jimp.rgbaToInt(r, g, b, 255), x, 0));
  const poster = ditherJimpToE6Indices(paletteImage, { mode: "poster_clean" });
  assert.deepStrictEqual(Array.from(poster.indices), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(Array.from(packE6LogicalIndices(Buffer.from([0, 1, 2, 3, 4, 5]))), [0x01, 0x32, 0x56]);
  const preview = await Jimp.read(await previewE6Buffer(Buffer.from([0x01, 0x32, 0x56]), { width: 6, height: 1 }));
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(0, 0)), { r: 20, g: 20, b: 20, a: 255 });
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(1, 0)), { r: 245, g: 245, b: 235, a: 255 });
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(2, 0)), { r: 180, g: 35, b: 35, a: 255 });
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(3, 0)), { r: 220, g: 180, b: 40, a: 255 });
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(4, 0)), { r: 40, g: 80, b: 160, a: 255 });
  assert.deepStrictEqual(Jimp.intToRGBA(preview.getPixelColor(5, 0)), { r: 55, g: 130, b: 70, a: 255 });

  const gray = await new Jimp(64, 4, 0xffffffff);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const value = Math.round(35 + (x / 63) * 185);
      gray.setPixelColor(Jimp.rgbaToInt(value, value, value, 255), x, y);
    }
  }
  const grayResult = ditherJimpToE6Indices(gray, { mode: "waveshare_floyd", grayNoiseGuard: true });
  assert.ok(Array.from(new Set(grayResult.indices)).every((value) => [0, 1].includes(value)));

  console.log("[OK] E6 dithering changes gradient output and keeps packed size");
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
