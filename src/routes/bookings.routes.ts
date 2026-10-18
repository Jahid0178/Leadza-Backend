import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as bookingController from "../controllers/booking.controller";

/**
 * /api/v1/bookings — membership-scoped appointments (FEATURES §34–35,
 * IMPLEMENTATION_PLAN step 27). Availability is derived from the business's
 * own hours; the AI may never offer a time no source reports (§25).
 *
 * Order per §34: authentication → controller (authorization and validation run
 * inside the controller so item routes answer 403 vs 404 correctly, and
 * validation only runs after authorization per §14).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/bookings — caller's bookings; ?businessId scopes to one. */
router.get("/", bookingController.listBookings);

/** GET /api/v1/bookings/availability — free slots for a range. */
router.get("/availability", bookingController.listAvailability);

/** POST /api/v1/bookings — create an appointment. */
router.post("/", bookingController.createBooking);

/** GET /api/v1/bookings/:bookingId */
router.get("/:bookingId", bookingController.getBooking);

/** PATCH /api/v1/bookings/:bookingId — reschedule / edit notes. */
router.patch("/:bookingId", bookingController.updateBooking);

/** PATCH /api/v1/bookings/:bookingId/status */
router.patch("/:bookingId/status", bookingController.changeBookingStatus);

export default router;
