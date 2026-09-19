/* eslint-disable no-console */
const assert = require("assert");
const Jimp = require("jimp");

const {
  convertImageBufferToE6P4,
  normalizeE6ImageTransform,
  e6TransformKey,
  E6_PACKED4_SIZE,
} = require("../src/services/e6/e6_converter.service");

async function makeQuadrantPng() {
  const image = await new Jimp(120, 80, 0xffffffff);
  image.scan(0, 0, 120, 80, function scan(x, y, idx) {
    const left = x < 60;
    const top = y < 40;
    const color = left && top
      ? [0, 0, 0]
      : !left && top
        ? [255, 0, 0]
        : left
          ? [0, 0, 255]
          : [255, 255, 255];
    this.bitmap.data[idx] = color[0];
    this.bitmap.data[idx + 1] = color[1];
    this.bitmap.data[idx + 2] = color[2];
    this.bitmap.data[idx + 3] = 255;
  });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

async function main() {
  const png = await makeQuadrantPng();
  const base = await convertImageBufferToE6P4(png, { fit: "contain", ditherMode: "poster_clean" });
  const rotated = await convertImageBufferToE6P4(png, {
    fit: "contain",
    ditherMode: "poster_clean",
    imageTransform: { rotateDeg: 90 },
  });
  const croppedLeft = await convertImageBufferToE6P4(png, {
    fit: "contain",
    ditherMode: "poster_clean",
    imageTransform: { crop: { x: 0, y: 0, width: 0.5, height: 1 } },
  });
  const croppedRight = await convertImageBufferToE6P4(png, {
    fit: "contain",
    ditherMode: "poster_clean",
    imageTransform: { crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  });

  assert.strictEqual(base.buffer.length, E6_PACKED4_SIZE);
  assert.strictEqual(rotated.buffer.length, E6_PACKED4_SIZE);
  assert.notStrictEqual(rotated.sha256, base.sha256, "rotation should affect packed E6 output");
  assert.notStrictEqual(croppedLeft.sha256, croppedRight.sha256, "different crop boxes should affect packed E6 output");
  assert.deepStrictEqual(rotated.imageTransform, {
    rotateDeg: 90,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.strictEqual(rotated.transformKey, "r90_x0_y0_w1_h1");
  assert.strictEqual(
    e6TransformKey(normalizeE6ImageTransform({ rotateDeg: -90, cropX: 10, cropY: 20, cropWidth: 50, cropHeight: 60 })),
    "r270_x0.1_y0.2_w0.5_h0.6"
  );
  console.log("[ok] E6 image rotation and crop transform contract passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
