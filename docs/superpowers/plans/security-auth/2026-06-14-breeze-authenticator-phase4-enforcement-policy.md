# Breeze Authenticator — Phase 4 (Enforcement + Org Policy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Turn the recorded assurance ladder into an **enforced** one — a partner (MSP) can require step-up for approvals at/above a chosen tier, with a grace window — while preserving the absolute safety rule that a **deny is never blocked**.

**Architecture:** Wire the P1 `authenticator_policies` row (partner-axis) into `assertApprovalAssurance`: the partner's `floorOverrides` *raise* the required level (`requiredAssurance` already supports this, raise-only), and when `requireEnrollment` is on and the grace window (`enforceFrom`) has passed, an **approve** whose achieved level < required level is **rejected** (`StepUpRequiredError` → 403). Before `enforceFrom`, the under-assured approve is allowed but audited as a grace downgrade. A partner-admin "Approval security" tab (OrgSettingsPage) reads/writes the policy via a new partner-scoped API. **Deny, report-suspicious, and the no-policy default all stay non-blocking.**

**Tech Stack:** TypeScript, Hono, Drizzle, Astro+React, Vitest. Node v22.20.0. No DB migration (P1 shipped `authenticator_policies`).

**Spec:** `.../2026-06-14-breeze-authenticator-step-up-approvals-design.md` (§4 ladder, §10 policy, §12 deny fail-safe). Builds on P1–P3.

**Safety invariants (test every one):**
1. **Deny is never blocked** — enforcement applies to `approved` decisions only; `denied`/`reported` bypass the gate entirely, even with a locked PIN or no device.
2. **Raise-only** — `floorOverrides` can only increase a tier's required level (enforced in `requiredAssurance` + re-validated server-side on PUT).
3. **Fail-open by default** — no policy row, or `requireEnrollment=false`, or `now < enforceFrom` → never block (record/grace only).
4. **Enforce only when achieved < required** — a sufficiently-assured approve always passes.

Commands: `cd /Users/toddhebebrand/breeze-worktrees/authenticator-phase1` · `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Known tsc noise: agents.test.ts, apiKeyAuth.test.ts, ticketConfig.test.ts.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/authenticatorPolicy.ts` (create) | Load a partner's policy; `isEnforcing(policy, now)`; raise-only validation of overrides |
| `apps/api/src/services/authenticatorPolicy.test.ts` (create) | Unit tests |
| `apps/api/src/services/authenticatorAssurance.ts` (modify) | Accept `partnerId` + `decision: 'approved'|'denied'`; apply policy floor; enforce on approve only |
| `apps/api/src/routes/authenticator.ts` (modify) | `GET /authenticator/policy`, `PUT /authenticator/policy` (partner-admin) |
| `apps/api/src/routes/approvals.ts` (modify) | Pass `partnerId` + decision into the guard; map `StepUpRequiredError`→403 (approve only) |
| `apps/api/src/routes/pam.ts` (modify) | Same |
| `packages/shared/src/validators/authenticator.ts` (modify) | `authenticatorPolicySchema` (raise-only refine) |
| `apps/web/src/components/settings/OrgApprovalSecurityTab.tsx` (create) | The admin tab UI |
| `apps/web/src/components/settings/OrgSettingsPage.tsx` (modify) | Register the tab |
| `apps/web/src/stores/authenticatorPolicy.ts` (create) | Web client get/put |

---

## Task 1: Policy service (load + enforcement decision + raise-only)

**Files:** Create `apps/api/src/services/authenticatorPolicy.ts` + test.

- [ ] **Step 1: Failing tests** —
  - `loadPartnerPolicy(partnerId)` returns the row or null (mock `../db`).
  - `isEnforcing(policy, now)` → false when policy null, `requireEnrollment=false`, or `enforceFrom` in the future; true when `requireEnrollment=true` and (`enforceFrom` null or ≤ now).
  - `validateRaiseOnly(overrides)` throws when any override is *below* the Breeze default floor (`DEFAULT_ASSURANCE_FLOOR`), passes when equal-or-higher.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement:**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { authenticatorPolicies } from '../db/schema';
import { DEFAULT_ASSURANCE_FLOOR, type AssuranceFloorOverrides, type RiskTier } from '@breeze/shared';

export async function loadPartnerPolicy(partnerId: string | null) {
  if (!partnerId) return null;
  const [row] = await db.select().from(authenticatorPolicies)
    .where(eq(authenticatorPolicies.partnerId, partnerId)).limit(1);
  return row ?? null;
}

export function isEnforcing(
  policy: { requireEnrollment: boolean; enforceFrom: Date | null } | null,
  now: Date,
): boolean {
  if (!policy || !policy.requireEnrollment) return false;
  if (policy.enforceFrom && policy.enforceFrom > now) return false; // grace window
  return true;
}

/** Reject any override that would WEAKEN the Breeze floor (raise-only). */
export function validateRaiseOnly(overrides: AssuranceFloorOverrides): void {
  for (const [tier, level] of Object.entries(overrides) as [RiskTier, number][]) {
    if (level < DEFAULT_ASSURANCE_FLOOR[tier]) {
      throw new Error(`override for '${tier}' (${level}) is below the Breeze floor (${DEFAULT_ASSURANCE_FLOOR[tier]})`);
    }
  }
}
```

- [ ] **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): authenticator policy load + enforcement decision`.

---

## Task 2: Enforce in assertApprovalAssurance (approve-only)

**Files:** Modify `apps/api/src/services/authenticatorAssurance.ts` + test.

- [ ] **Step 1: Failing tests** (extend the existing suite):
  - **Floor raise:** a policy `floorOverrides={medium:3}` makes a `medium` approval's `requiredLevel=3` (was 2).
  - **Enforce blocks under-assured approve:** `isEnforcing=true`, no proof (achieved L1) < required L2 → throws `StepUpRequiredError(requiredLevel)`.
  - **Enforce passes sufficient approve:** achieved L2 ≥ required L2 → returns normally.
  - **Deny never blocks:** `decision='denied'`, enforcing, no proof → returns the L1 decision, NO throw (the critical fail-safe).
  - **Grace:** enforcing=false (enforceFrom future), under-assured approve → returns with `graceDowngrade=true`, no throw.
  - **No policy:** under-assured approve → no throw (unchanged P3 behavior).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** — add params + the gate. Add to `AssuranceDecision`: `graceDowngrade?: boolean`. Add a `StepUpRequiredError`:

```ts
export class StepUpRequiredError extends Error {
  constructor(public readonly requiredLevel: AssuranceLevel, public readonly achievedLevel: AssuranceLevel) {
    super(`step-up required: need level ${requiredLevel}, got ${achievedLevel}`);
    this.name = 'StepUpRequiredError';
  }
}
```

Extend the signature to `{ approvalId, userId, riskTier, proof?, pin?, partnerId?, decision?: 'approved' | 'denied' }`. After computing the base `decision` object (the existing P3 logic, which already throws on bad proof/PIN), insert before returning:

```ts
  // Apply the partner policy floor (raise-only) to the REQUIRED level, then
  // enforce — but ONLY for an approve. A deny/report is always allowed through
  // (spec §12 fail-safe): a technician must never be unable to REFUSE a request.
  const policy = await loadPartnerPolicy(input.partnerId ?? null);
  const requiredLevel = requiredAssurance(input.riskTier, policy?.floorOverrides ?? null);
  decision.requiredLevel = requiredLevel;

  if ((input.decision ?? 'approved') === 'approved' && decision.decidedAssuranceLevel < requiredLevel) {
    if (isEnforcing(policy, new Date())) {
      throw new StepUpRequiredError(requiredLevel, decision.decidedAssuranceLevel);
    }
    decision.graceDowngrade = true; // under-assured but within grace / not enforced — audit it
  }
  return decision;
```

> Note: the no-proof early return at the top (`if (!input.proof) return resolveApprovalAssurance(...)`) must ALSO run this gate. Refactor so the policy/enforce block applies to BOTH the no-proof and proof paths (e.g. compute the base `decision` for the no-proof case via `resolveApprovalAssurance`, then fall through to the shared gate instead of early-returning). Keep deny exempt.

- [ ] **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): enforce assurance floor on approve (deny-safe, grace-aware)`.

---

## Task 3: Thread partnerId + decision; map StepUpRequiredError → 403

**Files:** Modify `apps/api/src/routes/approvals.ts` + `apps/api/src/routes/pam.ts` (+ tests).

- [ ] **Step 1: Failing tests** — an enforced, under-assured **approve** returns **403** `{error:'step_up_required', requiredLevel}`; an under-assured **deny** succeeds (200). For approvals, `partnerId` comes from `c.get('auth')`; for PAM, from the elevation's `partnerId`/auth.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** — pass `partnerId` + `decision` (the handler already knows `status`) into `assertApprovalAssurance`. Wrap the call: catch `StepUpRequiredError` → `c.json({error:'step_up_required', requiredLevel: e.requiredLevel}, 403)`; keep the existing `PinVerificationError`/assertion-error → 401 mapping. Ensure the deny path passes `decision:'denied'`. **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): 403 step_up_required on enforced approve; deny stays open`.

---

## Task 4: Policy CRUD API (partner-admin)

**Files:** Modify `apps/api/src/routes/authenticator.ts` + test; `packages/shared/src/validators/authenticator.ts`.

- [ ] **Step 1: Failing tests** — `GET /authenticator/policy` returns the caller-partner's policy (or defaults); `PUT /authenticator/policy` validates raise-only (`validateRaiseOnly` → 400 on a weakening override), upserts the row (`partnerId` from auth, `updatedByUserId`), audits `auth.authenticator.policy.update`. Gate with the partner-admin permission (reuse the existing org/partner admin guard — match how OrgSettings writes are gated).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** — add `authenticatorPolicySchema = z.object({ floorOverrides: z.record(z.enum(['low','medium','high','critical']), z.number().int().min(1).max(4)).default({}), requireEnrollment: z.boolean(), enforceFrom: z.string().datetime().nullable() })` to shared; the route upserts on `partnerId` (PK conflict → update). **Step 4: PASS** + typecheck. **Step 5: Commit** — `feat(api): authenticator policy get/put (partner-admin, raise-only)`.

---

## Task 5: Web client + "Approval security" admin tab

**Files:** Create `apps/web/src/stores/authenticatorPolicy.ts`, `apps/web/src/components/settings/OrgApprovalSecurityTab.tsx`; modify `OrgSettingsPage.tsx` (+ a component test).

- [ ] **Step 1: Failing test** — the tab loads the policy, renders a per-tier required-level control (low→critical, each ≥ Breeze floor), a `requireEnrollment` toggle, and an `enforceFrom` date; Save calls PUT via `runAction`; a weakening selection is prevented client-side. Mock the store; assert by `data-testid`.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement:**
  - `stores/authenticatorPolicy.ts`: `getAuthenticatorPolicy()` / `putAuthenticatorPolicy(body)` via `fetchWithAuth`.
  - `OrgApprovalSecurityTab.tsx`: mirror an existing OrgSettings section (load → form → `handleSaveSettings`-style Save wrapped in `runAction`). Per-tier `<select>` constrained to `>= DEFAULT_ASSURANCE_FLOOR[tier]` (import from `@breeze/shared`). Show a clear "raise-only" helper note.
  - `OrgSettingsPage.tsx`: add `{ id: 'approval-security', label: 'Approval Security', ... }` to the `tabs` array (after `security`) and render `<OrgApprovalSecurityTab>` for that tab. Gate visibility to partner-admins (match how other admin-only tabs gate).
- [ ] **Step 4: PASS** + typecheck (web). **Step 5: Commit** — `feat(web): Approval Security org policy tab (raise-only floor + enrollment)`.

---

## Orchestrator-run gate

1. API unit: the 4 server suites above + the existing approvals/pam/assurance suites.
2. shared: `authenticator.test.ts`.
3. web: the new tab test.
4. Full `tsc --noEmit` (api/shared/web) — no new errors.
5. **Targeted enforcement integration (real test DB):** seed a partner policy `requireEnrollment=true, enforceFrom=past, floorOverrides={medium:2}`; POST an under-assured **approve** → 403; POST a **deny** → 200 (the deny-safe invariant, end-to-end). This is the one that proves enforcement actually engages against Postgres + RLS.

## Self-review

- **Spec §10 coverage:** policy load/raise-only → T1/T4; enforce + grace → T2; 403 wiring → T3; admin tab → T5.
- **Safety invariants** each have a test (T2 deny-never-blocks is the critical one; T1/T4 raise-only; T2 fail-open default + grace).
- **No migration** (P1 `authenticator_policies` suffices).
- **Type consistency:** `StepUpRequiredError.requiredLevel` (T2) → 403 body (T3); `authenticatorPolicySchema` (T4) → web form (T5); `DEFAULT_ASSURANCE_FLOOR` reused on both server (raise-only) and client (control floor).

## What Phase 4 completes

The full feature: register a device-bound biometric approver (browser + mobile) + PIN, verified server-side, recorded, and now **enforced** at a partner-chosen, risk-tiered floor with a grace window — while a deny is always allowed. Remaining beyond P4: the mobile native-module on-device verification (P3 manual handoff) and #1254 (PAM-elevation→mobile bridge).
