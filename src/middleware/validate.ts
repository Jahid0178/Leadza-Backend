import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "../utils/api-error";

/**
 * Request-body validation middleware (agent.md §14).
 * Never trust TypeScript types at runtime.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.join(".");
      const message = !issue
        ? "Invalid input."
        : field
          ? `${field}: ${issue.message}`
          : issue.message;
      next(ApiError.badRequest("VALIDATION_ERROR", message));
      return;
    }

    req.body = result.data;
    next();
  };
}
