import { Request, Response, NextFunction } from "express";
import { captureException } from "../utils/sentry";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error("[ERROR]", err?.message || err);
  captureException(err instanceof Error ? err : new Error(String(err)), { status: err?.status });
  const status = err?.status || 500;
  const message = err?.message || "Internal server error";
  res.status(status).json({ error: message });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

export function createError(message: string, status: number) {
  const err = new Error(message) as any;
  err.status = status;
  return err;
}
