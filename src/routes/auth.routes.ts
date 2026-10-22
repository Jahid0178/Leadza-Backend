import { Router } from "express";
import * as authController from "../controllers/auth.controller";
import { requireAuth } from "../auth/middleware";
import { env } from "../config/env";
import { authWindowMs, rateLimiter } from "../middleware/rate-limit";
import { validateBody } from "../middleware/validate";
import { loginSchema, registerSchema } from "../validation/auth.schemas";

const router = Router();

/**
 * The anonymous /auth POST endpoints are the credential-stuffing door
 * (FEATURES §52, step 36), so they are rate limited per IP from the shared
 * factory — the 429 keeps the API envelope, the counters live in the shared
 * store. Budgets are generous for humans (an impatient double-click, a mistyped
 * password twice, even a family on one Wi-Fi) and tight enough to blunt a
 * password-spray run; they are env-tunable for deployment tuning.
 */
const loginLimiter = rateLimiter({
  name: "auth-login",
  windowMs: authWindowMs(),
  limit: env.AUTH_LOGIN_RATE_LIMIT,
  message: "Too many sign-in attempts from this address. Please wait a little and try again.",
});
const registerLimiter = rateLimiter({
  name: "auth-register",
  windowMs: authWindowMs(),
  limit: env.AUTH_REGISTER_RATE_LIMIT,
  message: "Too many account creation attempts from this address. Please try again later.",
});
const logoutLimiter = rateLimiter({
  name: "auth-logout",
  windowMs: authWindowMs(),
  // Logout is harmless (it only clears a cookie), so this is spam bound only.
  limit: Math.max(env.AUTH_LOGIN_RATE_LIMIT * 2, 30),
  message: "Too many sign-out attempts. Please try again later.",
});

router.post("/register", registerLimiter, validateBody(registerSchema), authController.register);
router.post("/login", loginLimiter, validateBody(loginSchema), authController.login);
router.post("/logout", logoutLimiter, authController.logout);
router.get("/session", authController.session);
router.get("/me", requireAuth, authController.me);

export default router;
