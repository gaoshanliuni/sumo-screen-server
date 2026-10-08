module.exports = {
  name: "firmware.upgrade",
  async run(payload = {}) {
    return {
      status: "queued",
      payload,
      note: "firmware upgrade worker placeholder; existing firmware routes execute real upgrade",
    };
  },
};
