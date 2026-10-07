/**
 * Application error with a safe, client-facing code + message.
 * Technical details stay in backend logs (agent.md §25).
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(code: string, message: string) {
    return new ApiError(400, code, message);
  }

  static unauthorized(code: string, message = "You need to sign in to continue.") {
    return new ApiError(401, code, message);
  }

  static forbidden(code: string, message = "You do not have permission to do that.") {
    return new ApiError(403, code, message);
  }

  static notFound(code: string, message = "The requested resource was not found.") {
    return new ApiError(404, code, message);
  }

  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }

  static internal(code: string, message = "Something went wrong. Please try again.") {
    return new ApiError(500, code, message);
  }
}
