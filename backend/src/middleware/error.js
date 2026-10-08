const HttpError = require("../utils/httpError");

function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : "服务器异常";
  const data = err instanceof HttpError ? err.data : null;

  return res.status(status).json({
    code: status,
    msg: message,
    data,
  });
}

module.exports = errorMiddleware;
