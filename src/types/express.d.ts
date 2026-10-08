import type { BusinessMember } from "../../generated/prisma/client";
import type { SessionUser } from "../auth/types";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth middleware after Auth.js session verification. */
      user?: SessionUser;

      /**
       * Set by resolveMembership (auth/permissions.ts) after the backend
       * verified the caller's membership for the route's business — the only
       * role source downstream guards may read.
       */
      membership?: BusinessMember;
    }
  }
}

export {};
