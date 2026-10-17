import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { setRealtimeTransport, type RealtimeTransport } from "./hub";
import { verifyRealtimeToken } from "./token";

/**
 * socket.io server for the dashboard (IMPLEMENTATION_PLAN step 38).
 *
 * It rides on the same HTTP server as the API (path /realtime), so nothing
 * extra to deploy or proxy. Sockets are read-only: they only announce that a
 * conversation changed — the client then refetches through the normal
 * authenticated endpoints, which stay the single source of truth.
 *
 * Two safety rules:
 *   - the handshake must carry a valid short-lived realtime token (./token.ts);
 *   - rooms are derived from the user's verified memberships, so one tenant can
 *     never receive another tenant's events, whatever the client asks for.
 */

/** Socket.IO's default path, kept explicit so the client matches. */
export const REALTIME_PATH = "/realtime";

/** Room name for one business's events. */
export function businessRoom(businessId: string): string {
  return `business:${businessId}`;
}

let io: SocketIOServer | null = null;

interface SocketData {
  userId?: string;
}

function tokenFromHandshake(socket: Socket): string | undefined {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  return typeof auth?.token === "string" && auth.token.length > 0
    ? auth.token
    : undefined;
}

/** The hub transport for one socket.io server. */
function transportFor(server: SocketIOServer): RealtimeTransport {
  return {
    emit(businessId, event) {
      // `event.type` is the socket event name; the payload carries the rest.
      server.to(businessRoom(businessId)).emit(event.type, event);
    },
  };
}

/**
 * Attach the realtime server to the API's HTTP server. Called once at boot
 * (server.ts) — tests attach it themselves when they need a live socket.
 *
 * Idempotent: a second call re-arms the hub transport instead of attaching a
 * second socket.io server to the same HTTP server (which would double-handle
 * upgrades).
 */
export function attachRealtimeServer(httpServer: HttpServer): SocketIOServer {
  if (io) {
    setRealtimeTransport(transportFor(io));
    return io;
  }

  const server = new SocketIOServer(httpServer, {
    path: REALTIME_PATH,
    // The dashboard origin only; the public widget keeps polling (§22).
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    // The client bundle is served by Next.js, not by this server.
    serveClient: false,
  });

  server.use(async (socket, next) => {
    const verified = await verifyRealtimeToken(tokenFromHandshake(socket));
    if (!verified) {
      // The client sees a connect_error and requests a fresh token.
      next(new Error("UNAUTHORIZED"));
      return;
    }
    (socket.data as SocketData).userId = verified.userId;
    next();
  });

  server.on("connection", async (socket) => {
    const userId = (socket.data as SocketData).userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    try {
      const memberships = await prisma.businessMember.findMany({
        where: { userId },
        select: { businessId: true },
      });

      const businessIds = memberships.map((membership) => membership.businessId);
      if (businessIds.length > 0) {
        await socket.join(businessIds.map(businessRoom));
      }

      // Handshake ack: lets the client show "Live" only once it is subscribed.
      socket.emit("ready", { businessIds });
    } catch (err) {
      // A database hiccup must not leave a socket silently unsubscribed.
      logger.error({ err, userId }, "realtime socket could not join rooms");
      socket.disconnect(true);
    }
  });

  setRealtimeTransport(transportFor(server));

  io = server;
  logger.info({ path: REALTIME_PATH }, "realtime server attached");
  return server;
}

/** Detach the transport and close every socket (graceful shutdown/tests). */
export async function closeRealtimeServer(): Promise<void> {
  setRealtimeTransport(null);
  if (!io) return;
  const server = io;
  io = null;
  await server.close();
}
