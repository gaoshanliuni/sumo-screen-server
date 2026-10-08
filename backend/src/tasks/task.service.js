const createId = require("../utils/id");
const { getCache } = require("../cache/redis");
const keys = require("../cache/cache_keys");

function createTaskService(options = {}) {
  const cache = options.cache || getCache();
  const tasks = new Map();

  async function persist(task) {
    tasks.set(task.id, { ...task });
    await cache.set(keys.taskState(task.id), task, 24 * 60 * 60);
    return task;
  }

  async function get(id) {
    const taskId = String(id || "");
    if (tasks.has(taskId)) return { ...tasks.get(taskId) };
    const cached = await cache.get(keys.taskState(taskId));
    return cached || null;
  }

  async function update(id, patch = {}) {
    const current = (await get(id)) || { id };
    return persist({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  async function enqueue(type, payload = {}, handler = null) {
    const now = new Date().toISOString();
    const task = await persist({
      id: createId("task"),
      type: String(type || "task"),
      payload,
      status: "queued",
      progress: 0,
      message: "queued",
      result: null,
      error: "",
      createdAt: now,
      updatedAt: now,
    });

    if (typeof handler === "function") {
      setImmediate(async () => {
        try {
          await update(task.id, { status: "running", progress: 1, message: "running" });
          const result = await handler({
            payload,
            taskId: task.id,
            updateProgress: (progress, message = "") =>
              update(task.id, {
                progress: Math.max(0, Math.min(100, Number(progress || 0))),
                message: String(message || ""),
              }),
          });
          await update(task.id, { status: "success", progress: 100, message: "success", result });
        } catch (error) {
          await update(task.id, {
            status: "failed",
            message: "failed",
            error: error?.message || String(error || "task failed"),
          });
        }
      });
    }
    return task;
  }

  async function cancel(id, reason = "cancelled") {
    const task = await get(id);
    if (!task) return null;
    return update(id, { status: "cancelled", message: reason });
  }

  return {
    enqueue,
    get,
    update,
    cancel,
  };
}

module.exports = {
  createTaskService,
};
