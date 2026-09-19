const assert = require("assert");
const AdmZip = require("adm-zip");

const {
  parseOffset,
  validateFullFirmwareZip,
} = require("../src/services/firmware/full_firmware_bundle.service");

function makeBin(size, fill = 0x11) {
  return Buffer.alloc(size, fill);
}

function makeZip(manifest, files = {}) {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  Object.entries(files).forEach(([name, buffer]) => {
    zip.addFile(name, buffer);
  });
  return zip.toBuffer();
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  await run("parses hex and decimal flash offsets", async () => {
    assert.strictEqual(parseOffset("0x10000"), 0x10000);
    assert.strictEqual(parseOffset(32768), 32768);
  });

  await run("validates E6 full firmware manifest and file checksums", async () => {
    const manifest = {
      packageType: "esp32-full-firmware",
      version: "1.0.0",
      deviceType: "e6-color-frame",
      chip: "esp32",
      flashSize: "4MB",
      files: [
        { type: "bootloader", path: "bootloader.bin", offset: "0x1000" },
        { type: "partition_table", path: "partition-table.bin", offset: "0x8000" },
        { type: "ota_data", path: "ota_data_initial.bin", offset: "0xe000", optional: true },
        { type: "app", path: "app.bin", offset: "0x10000" },
        { type: "nvs", path: "nvs.bin", offset: "0x9000", optional: true },
      ],
    };
    const result = validateFullFirmwareZip(makeZip(manifest, {
      "bootloader.bin": makeBin(4096, 1),
      "partition-table.bin": makeBin(3072, 2),
      "ota_data_initial.bin": makeBin(8192, 3),
      "app.bin": makeBin(1024 * 10, 4),
      "nvs.bin": makeBin(4096, 5),
    }));
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.manifest.deviceType, "e6-color-frame");
    assert.strictEqual(result.manifest.chip, "esp32");
    assert.strictEqual(result.files.find((item) => item.type === "app").offset, 0x10000);
    assert.ok(result.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  });

  await run("rejects missing required app partition", async () => {
    const manifest = {
      packageType: "esp32-full-firmware",
      version: "1.0.0",
      deviceType: "e6-color-frame",
      chip: "esp32",
      flashSize: "4MB",
      files: [
        { type: "bootloader", path: "bootloader.bin", offset: "0x1000" },
        { type: "partition_table", path: "partition-table.bin", offset: "0x8000" },
      ],
    };
    assert.throws(
      () => validateFullFirmwareZip(makeZip(manifest, {
        "bootloader.bin": makeBin(4096),
        "partition-table.bin": makeBin(3072),
      })),
      /缺少必要分区/
    );
  });

  await run("rejects E6 packages that exceed 4MB flash address space", async () => {
    const manifest = {
      packageType: "esp32-full-firmware",
      version: "1.0.0",
      deviceType: "e6-color-frame",
      chip: "esp32",
      flashSize: "4MB",
      files: [
        { type: "bootloader", path: "bootloader.bin", offset: "0x1000" },
        { type: "partition_table", path: "partition-table.bin", offset: "0x8000" },
        { type: "app", path: "app.bin", offset: "0x3ff000" },
      ],
    };
    assert.throws(
      () => validateFullFirmwareZip(makeZip(manifest, {
        "bootloader.bin": makeBin(4096),
        "partition-table.bin": makeBin(3072),
        "app.bin": makeBin(8192),
      })),
      /超出Flash大小/
    );
  });

  if (process.exitCode) {
    throw new Error("full firmware bundle self-test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
