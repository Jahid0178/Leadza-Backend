import { Router } from "express";
import { WIDGET_SCRIPT } from "../widget/script";

/**
 * GET /widget.js — serves the embeddable website widget (FEATURES §21,
 * IMPLEMENTATION_PLAN step 18). Mounted at the API root (app.ts), not under
 * /api/v1, so the business snippet reads exactly like the spec example:
 *
 *   <script src="https://API_HOST/widget.js" data-business="…" async></script>
 *
 * Public by definition (any site may include it); it carries no secrets —
 * the only value it needs is the business id the owner already publishes.
 * no-store: embeds cache aggressively, and a stale widget on a customer
 * site would keep posting to yesterday's endpoint.
 */
const router = Router();

/**
 * CORS + CORP for the embedded script: any site may include it, so the
 * resource must be fetchable cross-origin. helmet sets
 * `Cross-Origin-Resource-Policy: same-origin` app-wide (step 36), which is
 * right for the JSON API but would block a cross-site classic `<script>` —
 * classic scripts are no-cors requests, so CORP applies. The widget route
 * overrides it for its own response only.
 */
router.get("/widget.js", (_req, res) => {
  res
    .status(200)
    .type("application/javascript; charset=utf-8")
    .set("cache-control", "public, max-age=300")
    .set("cross-origin-resource-policy", "cross-origin")
    .send(WIDGET_SCRIPT);
});

export default router;
