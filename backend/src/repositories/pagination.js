function toPositiveInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function paginateRows(rows, options = {}) {
  const page = toPositiveInt(options.page, 1, { min: 1, max: 100000 });
  const pageSize = toPositiveInt(options.pageSize || options.limit, 20, { min: 1, max: 100 });
  const total = Array.isArray(rows) ? rows.length : 0;
  const offset = (page - 1) * pageSize;
  const pageRows = Array.isArray(rows) ? rows.slice(offset, offset + pageSize) : [];
  return {
    rows: pageRows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: offset + pageRows.length < total,
  };
}

module.exports = {
  paginateRows,
  toPositiveInt,
};
