import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../utils/api-error";
import { apiError } from "../utils/api-response";
import { logger } from "../utils/logger";

/** 404 for unknown routes — consistent error format (agent.md §26). */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json(apiError("NOT_FOUND", "That endpoint does not exist."));
}

/**
 * Central error handler (agent.md §25).
 * Internal errors are logged; clients only ever see safe messages.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error({ err, code: err.code }, "request failed");
    } else {
      logger.warn({ code: err.code, message: err.message }, "request rejected");
    }
    res.status(err.statusCode).json(apiError(err.code, err.message));
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json(apiError("VALIDATION_ERROR", "Some of the submitted fields are invalid."));
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json(apiError("INTERNAL_ERROR", "Something went wrong. Please try again."));
}
