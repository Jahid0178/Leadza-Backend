import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as customerController from "../controllers/customer.controller";

/**
 * /api/v1/customers — membership-scoped customer resources (FEATURES §14,
 * IMPLEMENTATION_PLAN step 13). Reads plus find-or-create; the tenant scope
 * is resolved server-side from the authenticated user, never from a trusted
 * client-supplied businessId (§7, §52).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so item routes can answer 403 vs 404 correctly).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/customers — caller's customers; ?businessId scopes to one. */
router.get("/", customerController.listCustomers);

/** POST /api/v1/customers — find by phone/email or create (201 when new). */
router.post("/", customerController.findOrCreateCustomer);

/** GET /api/v1/customers/:customerId */
router.get("/:customerId", customerController.getCustomer);

export default router;
