const crypto = require("crypto");
const Jimp = require("jimp");

const E6_WIDTH = 800;
const E6_HEIGHT = 480;
const E6_PACKED4_SIZE = (E6_WIDTH * E6_HEIGHT) / 2;
const DEFAULT_E6_DITHER_MODE = "waveshare_floyd";
const E6_CONVERTER_VERSION = "e6-waveshare-v1";

const E6_PALETTE = [
  { name: "black", index: 0, code: 0x0, rgb: [20, 20, 20] },
  { name: "white", index: 1, code: 0x1, rgb: [245, 245, 235] },
  { name: "red", index: 2, code: 0x3, rgb: [180, 35, 35] },
  { name: "yellow", index: 3, code: 0x2, rgb: [220, 180, 40] },
  { name: "blue", index: 4, code: 0x5, rgb: [40, 80, 160] },
  { name: "green", index: 5, code: 0x6, rgb: [55, 130, 70] },
];

const LOGICAL_TO_HARDWARE_NIBBLE = E6_PALETTE.map((item) => item.code);
const HARDWARE_NIBBLE_TO_LOGICAL = (() => {
  const map = new Array(16).fill(-1);
  E6_PALETTE.forEach((item) => {
    map[item.code] = item.index;
  });
  return map;
})();

const MODE_DEFAULTS = {
  waveshare_floyd: {
    engine: "waveshare",
    dither: "floyd_steinberg",
    colorspace: "rgb_weighted",
    serpentine: false,
    errorStrength: 1,
    maxError: 255,
    grayNoiseGuard: true,
    skinNoiseGuard: false,
  },
  photo_soft: {
    engine: "custom",
    dither: "atkinson",
    colorspace: "oklab",
    serpentine: true,
    errorStrength: 0.72,
    maxError: 42,
    grayNoiseGuard: true,
    skinNoiseGuard: true,
  },
  photo_detail: {
    engine: "custom",
    dither: "floyd_steinberg",
    colorspace: "oklab",
    serpentine: true,
    errorStrength: 0.75,
    maxError: 48,
    grayNoiseGuard: true,
    skinNoiseGuard: false,
  },
  poster_clean: {
    engine: "custom",
    dither: "none",
    colorspace: "oklab",
    serpentine: false,
    errorStrength: 0,
    maxError: 0,
    grayNoiseGuard: true,
    skinNoiseGuard: false,
  },
  art_blue_noise: {
    engine: "custom",
    dither: "blue_noise",
    colorspace: "oklab",
    serpentine: false,
    errorStrength: 0,
    maxError: 0,
    grayNoiseGuard: true,
    skinNoiseGuard: false,
  },
};

const E6_DITHER_MODES = Object.freeze(Object.keys(MODE_DEFAULTS));

function normalizeE6DitherMode(value, fallback = DEFAULT_E6_DITHER_MODE) {
  const mode = String(value || fallback || DEFAULT_E6_DITHER_MODE).trim();
  if (!MODE_DEFAULTS[mode]) {
    throw new Error(`unsupported dither mode: ${mode}`);
  }
  return mode;
}

function roundCropValue(value) {
  const rounded = Math.round(Number(value || 0) * 10000) / 10000;
  return Number.isFinite(rounded) ? rounded : 0;
}

function normalizeCropFraction(value, fallback) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const scaled = raw > 1 ? raw / 100 : raw;
  return clamp(scaled, 0, 1);
}

function normalizeE6ImageTransform(options = {}) {
  const source = options.imageTransform && typeof options.imageTransform === "object" ? options.imageTransform : options;
  const rawRotation = Number(source.rotateDeg ?? source.rotationDeg ?? source.rotate ?? source.rotation ?? 0);
  const rotateDeg = ((Math.round(rawRotation / 90) * 90) % 360 + 360) % 360;
  const cropSource = source.crop && typeof source.crop === "object" ? source.crop : source;
  let x = normalizeCropFraction(cropSource.x ?? cropSource.cropX ?? cropSource.left, 0);
  let y = normalizeCropFraction(cropSource.y ?? cropSource.cropY ?? cropSource.top, 0);
  let width = normalizeCropFraction(cropSource.width ?? cropSource.cropWidth ?? cropSource.w, 1);
  let height = normalizeCropFraction(cropSource.height ?? cropSource.cropHeight ?? cropSource.h, 1);
  width = Math.max(0.01, width);
  height = Math.max(0.01, height);
  if (x + width > 1) x = Math.max(0, 1 - width);
  if (y + height > 1) y = Math.max(0, 1 - height);
  return {
    rotateDeg,
    crop: {
      x: roundCropValue(x),
      y: roundCropValue(y),
      width: roundCropValue(Math.min(width, 1)),
      height: roundCropValue(Math.min(height, 1)),
    },
  };
}

function e6TransformKey(transform = {}) {
  const normalized = normalizeE6ImageTransform(transform);
  const crop = normalized.crop;
  return `r${normalized.rotateDeg}_x${crop.x}_y${crop.y}_w${crop.width}_h${crop.height}`;
}

function e6ConverterEngineForMode(value) {
  const mode = normalizeE6DitherMode(value);
  return String(MODE_DEFAULTS[mode].engine || "custom");
}

function clamp(value, low = 0, high = 255) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function clampInt(value) {
  return Math.round(clamp(value));
}

function srgbToLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function signedCbrt(value) {
  return Math.sign(value) * Math.abs(value) ** (1 / 3);
}

function oklab(rgb) {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l1 = signedCbrt(l);
  const m1 = signedCbrt(m);
  const s1 = signedCbrt(s);
  return [
    0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1,
    1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1,
    0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1,
  ];
}

function distance3(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function weightedRgbDistance(a, b) {
  return 0.3 * (a[0] - b[0]) ** 2 + 0.59 * (a[1] - b[1]) ** 2 + 0.11 * (a[2] - b[2]) ** 2;
}

function isGrayish(rgb, saturationThreshold = 0.12, chromaThreshold = 18) {
  const high = Math.max(rgb[0], rgb[1], rgb[2]);
  const low = Math.min(rgb[0], rgb[1], rgb[2]);
  if (high === 0) return true;
  return (high - low) / high < saturationThreshold || high - low < chromaThreshold;
}

function isSkinLike(rgb) {
  const [r, g, b] = rgb;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  return r > 92 && g > 38 && b > 18 && high - low > 15 && Math.abs(r - g) > 12 && r > g && r > b;
}

function allowedIndices(rgb, options) {
  if (options.grayNoiseGuard && isGrayish(rgb, options.graySaturationThreshold, 18)) return [0, 1];
  if (options.skinNoiseGuard && isSkinLike(rgb)) return [0, 1, 2, 3];
  return [0, 1, 2, 3, 4, 5];
}

function makePaletteSpace(colorspace) {
  if (colorspace === "rgb_weighted") {
    return E6_PALETTE.map((item) => item.rgb);
  }
  return E6_PALETTE.map((item) => oklab(item.rgb));
}

function nearestPaletteIndex(rgb, context, candidates) {
  const key = `${rgb[0]},${rgb[1]},${rgb[2]}|${context.colorspace}|${candidates.join("")}`;
  const cached = context.nearestCache.get(key);
  if (cached !== undefined) return cached;
  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  if (context.colorspace === "rgb_weighted") {
    for (const index of candidates) {
      const d = weightedRgbDistance(rgb, E6_PALETTE[index].rgb);
      if (d < bestDistance) {
        best = index;
        bestDistance = d;
      }
    }
  } else {
    const source = oklab(rgb);
    for (const index of candidates) {
      const d = distance3(source, context.paletteSpace[index]);
      if (d < bestDistance) {
        best = index;
        bestDistance = d;
      }
    }
  }
  context.nearestCache.set(key, best);
  return best;
}

function diffusionWeights(dither, reverse) {
  let weights = [];
  if (dither === "atkinson") {
    weights = [
      [1, 0, 1 / 8],
      [2, 0, 1 / 8],
      [-1, 1, 1 / 8],
      [0, 1, 1 / 8],
      [1, 1, 1 / 8],
      [0, 2, 1 / 8],
    ];
  } else if (dither === "floyd_steinberg") {
    weights = [
      [1, 0, 7 / 16],
      [-1, 1, 3 / 16],
      [0, 1, 5 / 16],
      [1, 1, 1 / 16],
    ];
  }
  return reverse ? weights.map(([dx, dy, factor]) => [-dx, dy, factor]) : weights;
}

function blueNoiseValue(x, y) {
  const value = (x * 37 + y * 17 + ((x ^ y) * 13) + ((x * y) & 63) * 7) & 4095;
  return value / 4095 - 0.5;
}

async function fitImageToCanvas(buffer, options = {}) {
  const fit = String(options.fit || "crop").toLowerCase() === "contain" ? "contain" : "crop";
  const source = await Jimp.read(buffer);
  source.rgba(true);
  const imageTransform = normalizeE6ImageTransform(options);
  if (imageTransform.rotateDeg) {
    source.rotate(imageTransform.rotateDeg, false);
  }
  const crop = imageTransform.crop;
  if (crop.x > 0 || crop.y > 0 || crop.width < 1 || crop.height < 1) {
    const cropX = Math.min(source.bitmap.width - 1, Math.max(0, Math.floor(crop.x * source.bitmap.width)));
    const cropY = Math.min(source.bitmap.height - 1, Math.max(0, Math.floor(crop.y * source.bitmap.height)));
    const cropW = Math.max(1, Math.min(source.bitmap.width - cropX, Math.round(crop.width * source.bitmap.width)));
    const cropH = Math.max(1, Math.min(source.bitmap.height - cropY, Math.round(crop.height * source.bitmap.height)));
    source.crop(cropX, cropY, cropW, cropH);
  }
  const canvas = await new Jimp(E6_WIDTH, E6_HEIGHT, 0xffffffff);

  const scale =
    fit === "contain"
      ? Math.min(E6_WIDTH / source.bitmap.width, E6_HEIGHT / source.bitmap.height)
      : Math.max(E6_WIDTH / source.bitmap.width, E6_HEIGHT / source.bitmap.height);
  const width = Math.max(1, Math.round(source.bitmap.width * scale));
  const height = Math.max(1, Math.round(source.bitmap.height * scale));
  const resized = source.clone().resize(width, height, Jimp.RESIZE_BICUBIC);
  const x = Math.floor((E6_WIDTH - width) / 2);
  const y = Math.floor((E6_HEIGHT - height) / 2);
  canvas.composite(resized, x, y);
  return canvas;
}

function readImageToRgbBuffers(image) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const original = new Uint8Array(width * height * 3);
  const working = new Float32Array(width * height * 3);
  const data = image.bitmap.data;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * 4;
    const target = pixel * 3;
    const alpha = data[source + 3];
    const r = alpha < 128 ? 255 : data[source];
    const g = alpha < 128 ? 255 : data[source + 1];
    const b = alpha < 128 ? 255 : data[source + 2];
    original[target] = r;
    original[target + 1] = g;
    original[target + 2] = b;
    working[target] = r;
    working[target + 1] = g;
    working[target + 2] = b;
  }
  return { original, working };
}

function resolveDitherOptions(options = {}) {
  const mode = normalizeE6DitherMode(options.mode || options.ditherMode || (options.dither === false ? "poster_clean" : DEFAULT_E6_DITHER_MODE));
  const defaults = MODE_DEFAULTS[mode];
  return {
    mode,
    engine: String(defaults.engine || "custom"),
    dither: defaults.dither,
    colorspace: String(options.colorspace || defaults.colorspace) === "rgb_weighted" ? "rgb_weighted" : "oklab",
    serpentine: options.serpentine === undefined ? defaults.serpentine : Boolean(options.serpentine),
    errorStrength: options.errorStrength === undefined ? defaults.errorStrength : Number(options.errorStrength),
    maxError: options.maxError === undefined ? defaults.maxError : Math.max(0, Number(options.maxError)),
    grayNoiseGuard: options.grayNoiseGuard === undefined ? defaults.grayNoiseGuard : Boolean(options.grayNoiseGuard),
    skinNoiseGuard: options.skinNoiseGuard === undefined ? defaults.skinNoiseGuard : Boolean(options.skinNoiseGuard),
    graySaturationThreshold: Number(options.graySaturationThreshold || 0.12),
    grayColorErrorScale: Number(options.grayColorErrorScale || 0.45),
    skinColorErrorScale: Number(options.skinColorErrorScale || 0.55),
    noiseStrength: Number(options.noiseStrength || 0.16),
  };
}

function validateE6Indices(indices, width, height) {
  if (indices.length !== width * height) throw new Error(`image size mismatch: expected ${width * height}, got ${indices.length}`);
  for (const value of indices) {
    if (value < 0 || value > 5) throw new Error("invalid E6 index generated");
  }
}

function ditherJimpToE6Indices(image, options = {}) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const opts = resolveDitherOptions(options);
  const { original, working } = readImageToRgbBuffers(image);
  const indices = Buffer.alloc(width * height);
  const context = {
    colorspace: opts.colorspace,
    paletteSpace: makePaletteSpace(opts.colorspace),
    nearestCache: new Map(),
  };

  for (let y = 0; y < height; y += 1) {
    const reverse = opts.serpentine && y % 2 === 1;
    const start = reverse ? width - 1 : 0;
    const end = reverse ? -1 : width;
    const step = reverse ? -1 : 1;
    for (let x = start; x !== end; x += step) {
      const pixel = y * width + x;
      const rgbIndex = pixel * 3;
      const guardRgb = [original[rgbIndex], original[rgbIndex + 1], original[rgbIndex + 2]];
      let rgb = [clampInt(working[rgbIndex]), clampInt(working[rgbIndex + 1]), clampInt(working[rgbIndex + 2])];
      if (opts.dither === "blue_noise") {
        const noise = blueNoiseValue(x % 64, y % 64) * 255 * opts.noiseStrength;
        rgb = [clampInt(rgb[0] + noise), clampInt(rgb[1] + noise), clampInt(rgb[2] + noise)];
      }
      const candidates = allowedIndices(guardRgb, opts);
      const index = nearestPaletteIndex(rgb, context, candidates);
      indices[pixel] = index;

      if (opts.dither === "none" || opts.dither === "blue_noise") continue;

      const target = E6_PALETTE[index].rgb;
      let strength = opts.errorStrength;
      if (opts.grayNoiseGuard && isGrayish(guardRgb, opts.graySaturationThreshold, 18)) {
        strength *= opts.grayColorErrorScale;
      } else if (opts.skinNoiseGuard && isSkinLike(guardRgb)) {
        strength *= opts.skinColorErrorScale;
      }
      const er = clamp(rgb[0] - target[0], -opts.maxError, opts.maxError) * strength;
      const eg = clamp(rgb[1] - target[1], -opts.maxError, opts.maxError) * strength;
      const eb = clamp(rgb[2] - target[2], -opts.maxError, opts.maxError) * strength;
      for (const [dx, dy, factor] of diffusionWeights(opts.dither, reverse)) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = (ny * width + nx) * 3;
        working[next] = clamp(working[next] + er * factor);
        working[next + 1] = clamp(working[next + 1] + eg * factor);
        working[next + 2] = clamp(working[next + 2] + eb * factor);
      }
    }
  }

  validateE6Indices(indices, width, height);
  return { width, height, indices, mode: opts.mode, dither: opts.dither, engine: opts.engine };
}

function packE6LogicalIndices(indices) {
  if (indices.length % 2 !== 0) throw new Error("packed4 requires an even number of pixels");
  const packed = Buffer.alloc(indices.length / 2);
  for (let index = 0, out = 0; index < indices.length; index += 2, out += 1) {
    const high = LOGICAL_TO_HARDWARE_NIBBLE[indices[index]];
    const low = LOGICAL_TO_HARDWARE_NIBBLE[indices[index + 1]];
    packed[out] = ((high & 0x0f) << 4) | (low & 0x0f);
  }
  return packed;
}

function unpackE6Packed4(buffer, options = {}) {
  const width = Number(options.width || E6_WIDTH);
  const height = Number(options.height || E6_HEIGHT);
  const expectedPixels = width * height;
  const source = Buffer.from(buffer || []);
  if (source.length !== expectedPixels / 2) {
    throw new Error(`packed4 size mismatch: expected ${expectedPixels / 2}, got ${source.length}`);
  }
  const indices = Buffer.alloc(expectedPixels);
  for (let offset = 0, pixel = 0; offset < source.length; offset += 1, pixel += 2) {
    const high = source[offset] >> 4;
    const low = source[offset] & 0x0f;
    const highLogical = HARDWARE_NIBBLE_TO_LOGICAL[high];
    const lowLogical = HARDWARE_NIBBLE_TO_LOGICAL[low];
    if (highLogical < 0 || lowLogical < 0) {
      throw new Error(`invalid E6 packed4 nibble at byte ${offset}`);
    }
    indices[pixel] = highLogical;
    indices[pixel + 1] = lowLogical;
  }
  return { width, height, indices };
}

async function previewFromIndices(width, height, indices) {
  const preview = await new Jimp(width, height, 0xffffffff);
  const data = preview.bitmap.data;
  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const rgb = E6_PALETTE[indices[pixel]].rgb;
    const offset = pixel * 4;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  }
  return preview;
}

async function previewE6Buffer(buffer, options = {}) {
  const unpacked = unpackE6Packed4(buffer, options);
  const preview = await previewFromIndices(unpacked.width, unpacked.height, unpacked.indices);
  return preview.getBufferAsync(Jimp.MIME_PNG);
}

async function convertImageBufferToE6P4(buffer, options = {}) {
  const imageTransform = normalizeE6ImageTransform(options);
  const image = await fitImageToCanvas(buffer, options);
  const ditherResult = ditherJimpToE6Indices(image, options);
  const packed = packE6LogicalIndices(ditherResult.indices);
  let previewBuffer = Buffer.alloc(0);
  if (options.preview !== false) {
    const preview = await previewFromIndices(image.bitmap.width, image.bitmap.height, ditherResult.indices);
    previewBuffer = await preview.getBufferAsync(Jimp.MIME_PNG);
  }
  return {
    buffer: packed,
    previewBuffer,
    width: E6_WIDTH,
    height: E6_HEIGHT,
    format: "e6p4",
    converterVersion: E6_CONVERTER_VERSION,
    converterEngine: ditherResult.engine,
    imageTransform,
    transformKey: e6TransformKey(imageTransform),
    colorMode: "e6_6color",
    dither: ditherResult.mode !== "poster_clean",
    ditherMode: ditherResult.mode,
    palette: E6_PALETTE.map((item) => ({ name: item.name, index: item.index, code: item.code, rgb: item.rgb })),
    sha256: crypto.createHash("sha256").update(packed).digest("hex"),
  };
}

module.exports = {
  E6_WIDTH,
  E6_HEIGHT,
  E6_PACKED4_SIZE,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  E6_PALETTE,
  E6_DITHER_MODES,
  normalizeE6DitherMode,
  normalizeE6ImageTransform,
  e6TransformKey,
  e6ConverterEngineForMode,
  convertImageBufferToE6P4,
  ditherJimpToE6Indices,
  packE6LogicalIndices,
  unpackE6Packed4,
  previewE6Buffer,
  validateE6Indices,
};
