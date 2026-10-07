import { Router } from "express";
import * as authController from "../controllers/auth.controller";
import { requireAuth } from "../auth/middleware";
import { validateBody } from "../middleware/validate";
import { loginSchema, registerSchema } from "../validation/auth.schemas";

const router = Router();

router.post("/register", validateBody(registerSchema), authController.register);
router.post("/login", validateBody(loginSchema), authController.login);
router.post("/logout", authController.logout);
router.get("/session", authController.session);
router.get("/me", requireAuth, authController.me);

export default router;
