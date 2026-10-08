const crypto = require("crypto");
const AdmZip = require("adm-zip");
const HttpError = require("../../utils/httpError");

const REQUIRED_TYPES = new Set(["bootloader", "partition_table", "app"]);
const OPTIONAL_TYPES = new Set(["ota_data", "spiffs", "littlefs", "nvs"]);
const SUPPORTED_TYPES = new Set([...REQUIRED_TYPES, ...OPTIONAL_TYPES]);
const FLASH_SIZE_BYTES = {
  "4mb": 4 * 1024 * 1024,
  "8mb": 8 * 1024 * 1024,
  "16mb": 16 * 1024 * 1024,
};

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parseOffset(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new HttpError(400, "offset格式不正确");
    return Math.floor(value);
  }
  const text = String(value || "").trim().toLowerCase();
  if (!text) throw new HttpError(400, "offset不能为空");
  const n = text.startsWith("0x") ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "offset格式不正确");
  return n;
}

function normalizeEntryName(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function readManifest(zip) {
  const entry = zip.getEntry("manifest.json") || zip.getEntry("firmware-manifest.json");
  if (!entry) throw new HttpError(400, "完整固件包缺少manifest.json");
  try {
    return JSON.parse(entry.getData().toString("utf8"));
  } catch (_) {
    throw new HttpError(400, "manifest.json不是合法JSON");
  }
}

function normalizeFlashSize(value, deviceType) {
  const raw = String(value || (deviceType === "e6-color-frame" ? "4MB" : "4MB")).trim();
  const key = raw.toLowerCase().replace(/\s+/g, "");
  const size = FLASH_SIZE_BYTES[key];
  if (!size) throw new HttpError(400, "flashSize仅支持4MB/8MB/16MB");
  return { label: raw.toUpperCase().replace("MIB", "MB"), bytes: size };
}

function getZipEntry(zip, filePath) {
  const normalized = normalizeEntryName(filePath);
  const entry = zip.getEntry(normalized);
  if (!entry) throw new HttpError(400, `manifest引用的文件不存在: ${normalized}`);
  if (entry.isDirectory) throw new HttpError(400, `manifest引用了目录而不是文件: ${normalized}`);
  return entry;
}

function normalizeManifest(manifest = {}) {
  const deviceType = String(manifest.deviceType || manifest.device_type || "ink-screen").trim();
  const chip = String(manifest.chip || "esp32").trim().toLowerCase();
  const flash = normalizeFlashSize(manifest.flashSize || manifest.flash_size, deviceType);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) throw new HttpError(400, "manifest.files不能为空");
  if (deviceType === "e6-color-frame") {
    if (chip !== "esp32") throw new HttpError(400, "E6完整固件包chip必须为esp32");
    if (flash.bytes !== FLASH_SIZE_BYTES["4mb"]) throw new HttpError(400, "E6完整固件包flashSize必须为4MB");
  }
  return {
    packageType: String(manifest.packageType || "esp32-full-firmware"),
    version: String(manifest.version || ""),
    channel: String(manifest.channel || "stable"),
    deviceType,
    chip,
    flashSize: flash.label,
    flashSizeBytes: flash.bytes,
    partitionTable: String(manifest.partitionTable || manifest.partition_table || ""),
    files,
    notes: String(manifest.notes || ""),
  };
}

function validateFullFirmwareZip(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, "固件包不能为空");
  const zip = new AdmZip(buffer);
  const manifest = normalizeManifest(readManifest(zip));
  if (!manifest.version) throw new HttpError(400, "manifest.version不能为空");

  const seenTypes = new Set();
  const files = manifest.files.map((raw) => {
    const type = String(raw.type || "").trim().toLowerCase();
    if (!SUPPORTED_TYPES.has(type)) throw new HttpError(400, `不支持的分区类型: ${type}`);
    const filePath = normalizeEntryName(raw.path || raw.name);
    if (!filePath) throw new HttpError(400, `${type}缺少path`);
    const offset = parseOffset(raw.offset);
    const entry = getZipEntry(zip, filePath);
    const data = entry.getData();
    const size = data.length;
    if (offset + size > manifest.flashSizeBytes) {
      throw new HttpError(400, `${filePath}超出Flash大小`);
    }
    const hash = sha256Hex(data);
    if (raw.sha256 && String(raw.sha256).toLowerCase() !== hash) {
      throw new HttpError(400, `${filePath} sha256不匹配`);
    }
    seenTypes.add(type);
    return {
      type,
      path: filePath,
      offset,
      offsetHex: `0x${offset.toString(16)}`,
      size,
      sha256: hash,
      optional: raw.optional === true || OPTIONAL_TYPES.has(type),
    };
  });

  const missing = Array.from(REQUIRED_TYPES).filter((type) => !seenTypes.has(type));
  if (missing.length) throw new HttpError(400, `缺少必要分区: ${missing.join(",")}`);

  return {
    valid: true,
    manifest: {
      ...manifest,
      files: files.map((item) => ({
        type: item.type,
        path: item.path,
        offset: item.offset,
        offsetHex: item.offsetHex,
        size: item.size,
        sha256: item.sha256,
        optional: item.optional,
      })),
    },
    files,
  };
}

module.exports = {
  parseOffset,
  validateFullFirmwareZip,
};
