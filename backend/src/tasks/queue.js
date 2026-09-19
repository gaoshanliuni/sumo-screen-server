const { createTaskService } = require("./task.service");

let singleton = null;

function getTaskService() {
  if (!singleton) singleton = createTaskService();
  return singleton;
}

module.exports = {
  getTaskService,
};
