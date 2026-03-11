class HttpError extends Error {
  constructor(status = 500, message = "Server Error", data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

module.exports = HttpError;
