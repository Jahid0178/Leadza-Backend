import type { SessionUser } from "../auth/types";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth middleware after Auth.js session verification. */
      user?: SessionUser;
    }
  }
}

export {};
