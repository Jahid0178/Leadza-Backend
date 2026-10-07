import type { DefaultSession } from "@auth/core/types";
import type { PlatformRole } from "../auth/types";

declare module "@auth/core/types" {
  interface Session {
    user: {
      id: string;
      platformRole: PlatformRole;
    } & DefaultSession["user"];
  }

  interface User {
    platformRole?: PlatformRole;
  }
}

export {};
