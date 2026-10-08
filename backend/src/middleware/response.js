function responseMiddleware(req, res, next) {
  res.success = (data = null, msg = "success", code = 200) => {
    return res.status(code).json({ code, msg, data });
  };

  res.fail = (msg = "error", code = 400, data = null) => {
    return res.status(code).json({ code, msg, data });
  };

  next();
}

module.exports = responseMiddleware;
