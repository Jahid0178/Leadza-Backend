# feat(business): add services, service areas, business hours and knowledge (Phase B)

## Goal
Implement the remaining Phase B backend work from `docs/IMPLEMENTATION_PLAN.md`:
- Step 09: Services
- Step 10: Service areas
- Step 11: Business hours
- Step 12: Business knowledge

This is the next backend work after business profile, create-with-owner, onboarding-complete, and geocode search.

## Context
- Spec: `docs/FEATURES.md`: §9 onboarding, §10 services, §11 service areas, §12 business hours, §13 business knowledge
- Plan: `docs/IMPLEMENTATION_PLAN.md`, Phase B (steps 08–12)
- Already in scope in this repo:
  - Business profile fields, PATCH, create-with-owner, onboarding-complete flag
  - `GET /api/v1/geocode/search` for address lookup

## Backend scope

### Step 09 — Services
- Add `Service` model in `prisma/schema.prisma`:
  - name
  - description
  - price
  - priceType
  - duration
  - active
- Add CRUD under a business:
  - `POST /api/v1/services`
  - `GET /api/v1/services`
  - `GET /api/v1/services/:id`
  - `PATCH /api/v1/services/:id`
  - `DELETE /api/v1/services/:id`
- Authorization:
  - mutations require membership + OWNER/ADMIN
  - reads require membership
- Tenant isolation:
  - every query filtered by server-side resolved `businessId`
  - no `businessId` trusted from the request body
- Validation with zod, consistent with existing business schemas
- Tests:
  - invalid fields rejected
  - cross-tenant service access denied
  - pricing only comes from this table; AI must never invent service pricing

### Step 10 — Service areas
- Add `ServiceArea` model:
  - support postcodes, cities/towns, areas, and radius where appropriate
- Add CRUD for service areas under a business
- Add internal helper `checkServiceArea()` used later by the AI tool
- Tenant isolation and role gating same as services

### Step 11 — Business hours
- Add `BusinessHour` model:
  - weekday
  - multiple time ranges per day
  - closed flag
  - emergency availability where applicable
- Add CRUD for business hours
- Add availability query helper used later by booking/AI

### Step 12 — Business knowledge
- Add `KnowledgeEntry` model:
  - question
  - answer
  - category
  - categories can include FAQs, policies, emergency rules, cancellation policy
- Add CRUD for knowledge entries
- Enforcement:
  - knowledge scope = current business only
  - tests verify AI context builder only loads the current business's entries once AI lands

## Acceptance criteria
- A business can fully configure itself through the API:
  - services
  - service areas
  - business hours
  - knowledge entries
- All business-owned resources are tenant-scoped and role-gated
- New models are added with their cross-tenant tests
- No business can read or write another business's services, areas, hours, or knowledge

## Out of scope
- AI agent usage of these resources (later, Phase E)
- Frontend settings UI for all of these (tracked separately on the frontend side)

## Notes
- Follow existing patterns in this repo:
  - controller → repository → Prisma
  - route order: authentication → authorization → validation → controller
  - typed API success/error envelope
- New business-owned models must ship with cross-tenant tests as done for earlier models.
