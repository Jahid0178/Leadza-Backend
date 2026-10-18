import { getSession } from "@auth/express";
import type { Request, Response } from "express";
import { authConfig } from "../auth/auth";
import {
  createSessionToken,
  sessionCookieName,
  sessionCookieOptions,
  toSessionUser,
} from "../auth/session";
import { registerUser, verifyCredentials } from "../services/auth.service";
import { findUserAuthState } from "../repositories/user.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import type { LoginInput, RegisterInput } from "../validation/auth.schemas";

async function issueSessionCookie(res: Response, user: NonNullable<ReturnType<typeof toSessionUser>>) {
  const token = await createSessionToken(user);
  res.cookie(sessionCookieName, token, sessionCookieOptions());
}

/** POST /api/v1/auth/register — create account and sign in. */
export async function register(req: Request, res: Response) {
  const input = req.body as RegisterInput;
  const user = await registerUser(input);
  await issueSessionCookie(res, user);
  res.status(201).json(apiSuccess({ user }));
}

/** POST /api/v1/auth/login — verify credentials and issue the session cookie. */
export async function login(req: Request, res: Response) {
  const input = req.body as LoginInput;
  const user = await verifyCredentials(input.email, input.password);

  if (!user) {
    throw ApiError.unauthorized(
      "INVALID_CREDENTIALS",
      "That email or password is incorrect.",
    );
  }

  await issueSessionCookie(res, user);
  res.json(apiSuccess({ user }));
}

/** POST /api/v1/auth/logout — clear the session cookie. */
export async function logout(_req: Request, res: Response) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: sessionCookieOptions().secure,
  });
  res.json(apiSuccess({ ok: true }));
}

/**
 * GET /api/v1/auth/session — current session user, or null when signed out.
 *
 * `platformRole` is re-read from the database (IMPLEMENTATION_PLAN step 28):
 * the JWT carries it from issue time, so without this the admin navigation and
 * the `/admin` route guard would disagree with the API for up to 30 days after
 * a role change. The backend remains the only authority on access — this only
 * keeps the UI in step with it.
 */
export async function session(req: Request, res: Response) {
  const authSession = await getSession(req, authConfig);
  const user = toSessionUser(authSession);
  if (!user) {
    res.json(apiSuccess({ user: null }));
    return;
  }

  const state = await findUserAuthState(user.id);
  const platformRole =
    state?.platformRole === "PLATFORM_ADMIN" ? "PLATFORM_ADMIN" : "USER";

  res.json(apiSuccess({ user: { ...user, platformRole } }));
}

/** GET /api/v1/auth/me — protected route (requireAuth); the session user. */
export async function me(req: Request, res: Response) {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  res.json(apiSuccess({ user }));
}
