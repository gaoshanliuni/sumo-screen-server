module.exports = {
  name: "page.render",
  async run(payload = {}) {
    return {
      status: "queued",
      payload,
      note: "page render worker placeholder; existing render services execute real rendering",
    };
  },
};
