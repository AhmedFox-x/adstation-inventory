"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
exports.notFound = notFound;
exports.createError = createError;
function errorHandler(err, _req, res, _next) {
    console.error("[ERROR]", err?.message || err);
    const status = err?.status || 500;
    const message = err?.message || "Internal server error";
    res.status(status).json({ error: message });
}
function notFound(_req, res) {
    res.status(404).json({ error: "Not found" });
}
function createError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}
//# sourceMappingURL=errorHandler.js.map