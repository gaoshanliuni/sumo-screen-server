function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeVariableName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeVariableValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function valuePreview(value, maxLen = 160) {
  let text = "";
  if (value === null || value === undefined) {
    text = "";
  } else if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function normalizeBaseVariableRows(input) {
  const source = isPlainObject(input) && input.base !== undefined ? input.base : input;
  const rows = [];

  if (Array.isArray(source)) {
    source.forEach((item) => {
      if (!isPlainObject(item)) return;
      const name = normalizeVariableName(item.name ?? item.key ?? item.path);
      if (!name) return;
      rows.push({
        name,
        value: normalizeVariableValue(item.value),
        createdAt: String(item.createdAt || item.updatedAt || ""),
        updatedAt: String(item.updatedAt || item.createdAt || ""),
      });
    });
  } else if (isPlainObject(source)) {
    Object.keys(source).forEach((key) => {
      const name = normalizeVariableName(key);
      if (!name) return;
      rows.push({
        name,
        value: normalizeVariableValue(source[key]),
        createdAt: "",
        updatedAt: "",
      });
    });
  }

  const byName = new Map();
  rows.forEach((row) => {
    byName.set(row.name, row);
  });
  return [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function ensureDeviceVariableContainer(device) {
  if (!device || typeof device !== "object") return { base: [], updatedAt: "" };
  const current = isPlainObject(device.deviceVariables) ? device.deviceVariables : {};
  const normalized = {
    base: normalizeBaseVariableRows(current.base !== undefined ? current.base : current),
    updatedAt: String(current.updatedAt || ""),
  };
  device.deviceVariables = normalized;
  return normalized;
}

function baseRowsToMap(rows) {
  const map = {};
  normalizeBaseVariableRows(rows).forEach((row) => {
    map[row.name] = row.value;
    setNestedVariableAlias(map, row.name, row.value);
  });
  return map;
}

function setNestedVariableAlias(target, name, value) {
  const parts = String(name || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return;

  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = cursor[part];
    if (next !== undefined && !isPlainObject(next)) {
      return;
    }
    if (!isPlainObject(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function upsertBaseVariableOnDevice(device, payload = {}, now = new Date().toISOString()) {
  const name = normalizeVariableName(payload.name ?? payload.key);
  if (!name) {
    const error = new Error("变量名不能为空");
    error.status = 400;
    throw error;
  }

  const container = ensureDeviceVariableContainer(device);
  const value = normalizeVariableValue(payload.value);
  const rows = normalizeBaseVariableRows(container.base);
  const existing = rows.find((item) => item.name === name);
  if (existing) {
    existing.value = value;
    existing.updatedAt = now;
  } else {
    rows.push({ name, value, createdAt: now, updatedAt: now });
  }
  container.base = rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  container.updatedAt = now;
  device.updatedAt = now;
  return { name, value, updatedAt: now };
}

function deleteBaseVariableOnDevice(device, nameInput, now = new Date().toISOString()) {
  const name = normalizeVariableName(nameInput);
  if (!name) {
    const error = new Error("变量名不能为空");
    error.status = 400;
    throw error;
  }

  const container = ensureDeviceVariableContainer(device);
  const before = container.base.length;
  container.base = container.base.filter((item) => item.name !== name);
  container.updatedAt = now;
  device.updatedAt = now;
  return { name, deleted: container.base.length !== before };
}

function resolveTemplateName(db, slug, fallback = "") {
  const row = Array.isArray(db?.apiTemplates)
    ? db.apiTemplates.find((item) => String(item?.slug || "") === String(slug || ""))
    : null;
  return String(row?.name || fallback || slug || "");
}

function flattenValue(value, prefix, rows, meta, depth = 0) {
  if (!prefix || rows.length >= 1200 || depth > 6) return;
  const tail = prefix.split(".").slice(meta.pathPrefixParts).join(".");
  const displayName = meta.namePrefix ? [meta.namePrefix, tail].filter(Boolean).join(".") : prefix;
  rows.push({
    source: "api",
    name: String(displayName),
    path: prefix,
    value: valuePreview(value),
    type: valueType(value),
    slug: meta.slug,
    templateName: meta.templateName,
    updatedAt: meta.updatedAt,
  });

  if (Array.isArray(value)) {
    if (value.length) flattenValue(value[0], `${prefix}.0`, rows, meta, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  Object.keys(value).forEach((key) => {
    flattenValue(value[key], `${prefix}.${key}`, rows, meta, depth + 1);
  });
}

function buildApiVariableRows(db, device) {
  const cache = isPlainObject(device?.thirdApiCache) ? device.thirdApiCache : {};
  const rows = [];
  Object.keys(cache)
    .sort((a, b) => a.localeCompare(b))
    .forEach((slug) => {
      const entry = cache[slug];
      if (!isPlainObject(entry)) return;
      const formatted =
        entry.formatted !== undefined
          ? entry.formatted
          : isPlainObject(entry.raw)
            ? entry.raw.output
            : undefined;
      if (formatted === undefined) return;
      const templateName = String(entry.template?.name || resolveTemplateName(db, slug, slug));
      const prefix = `api.formatted_by_slug.${slug}`;
      flattenValue(formatted, prefix, rows, {
        slug,
        templateName,
        updatedAt: String(entry.updatedAt || entry.updated_at || ""),
        namePrefix: slug,
        pathPrefixParts: 3,
      });
    });
  return rows;
}

function buildDeviceVariableContext(db, device) {
  const container = ensureDeviceVariableContainer(device || {});
  const baseRows = normalizeBaseVariableRows(container.base);
  const baseMap = baseRowsToMap(baseRows);
  const apiVariables = buildApiVariableRows(db, device);
  const deviceVariableList = baseRows.map((row) => ({
    source: "device",
    name: row.name,
    path: `deviceVariables.${row.name}`,
    placeholder: `{{deviceVariables.${row.name}}}`,
    value: row.value,
    type: "string",
    example: row.value,
    updatedAt: row.updatedAt || "",
  }));

  return {
    deviceVariables: baseMap,
    device_variables: {
      base: baseMap,
      api: apiVariables,
      updated_at: String(container.updatedAt || ""),
    },
    deviceVariableList,
    device_variable_list: deviceVariableList,
    baseVariables: baseRows,
    apiVariables,
  };
}

function buildDeviceVariablePayload(db, device) {
  const context = buildDeviceVariableContext(db, device);
  const baseNameSet = new Set();
  const baseValueSet = new Set();
  const apiNameSet = new Set();
  const apiValueSet = new Set();

  context.baseVariables.forEach((item) => {
    if (item.name) baseNameSet.add(item.name);
    if (item.value) baseValueSet.add(item.value);
  });
  context.apiVariables.forEach((item) => {
    if (item.name) apiNameSet.add(item.name);
    if (item.value) apiValueSet.add(item.value);
  });

  const baseSuggestions = {
    names: [...baseNameSet].slice(0, 500),
    values: [...baseValueSet].slice(0, 500),
  };
  const apiSuggestions = {
    names: [...apiNameSet].slice(0, 500),
    values: [...apiValueSet].slice(0, 500),
  };

  return {
    deviceId: String(device?.id || ""),
    baseVariables: context.baseVariables,
    apiVariables: context.apiVariables,
    baseSuggestions,
    apiSuggestions,
    suggestions: baseSuggestions,
  };
}

module.exports = {
  normalizeVariableName,
  normalizeVariableValue,
  normalizeBaseVariableRows,
  ensureDeviceVariableContainer,
  upsertBaseVariableOnDevice,
  deleteBaseVariableOnDevice,
  buildApiVariableRows,
  buildDeviceVariableContext,
  buildDeviceVariablePayload,
};
