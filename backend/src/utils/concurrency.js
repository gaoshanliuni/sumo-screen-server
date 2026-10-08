function createConcurrencyLimiter(maxConcurrent = 4) {
  const max = Math.max(1, Math.floor(Number(maxConcurrent || 4)));
  const queue = [];
  let active = 0;

  function runNext() {
    if (active >= max || queue.length === 0) return;
    const item = queue.shift();
    if (!item) return;
    active += 1;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return function limit(fn) {
    if (typeof fn !== "function") {
      return Promise.reject(new Error("limited task must be a function"));
    }
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

module.exports = {
  createConcurrencyLimiter,
};
