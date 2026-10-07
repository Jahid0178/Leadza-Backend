/**
 * Consistent API response format (agent.md §26).
 * Never expose stack traces, SQL errors, internal IDs, or secrets.
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function apiError(code: string, message: string): ApiFailure {
  return { success: false, error: { code, message } };
}
