module.exports = {
  name: "device.push",
  async run(payload = {}) {
    return {
      status: "queued",
      payload,
      note: "device push worker placeholder; existing remote/page push services execute real push",
    };
  },
};
