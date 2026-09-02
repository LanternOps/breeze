---
tracking_issue: LanternOps/breeze#4549
---

# Partner Trust Probation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New self-serve hosted partners start in `probation`, where remote control, device execution, and installer distribution are denied at the dispatch chokepoints until a settled non-Link 3DS card payment ages 24 h or an operator approves from an evidence card.

**Architecture:** A `trust_state` column on `partners` (default `trusted`, so everything existing is grandfathered) is read by one service, `services/partnerTrust.ts`. That service is called from the command-dispatch chokepoints (`commandQueue.ts` and the agent WebSocket fast path), from one new `createRemoteSession()` service that all session inserts go through, and from explicit gates on installer distribution, Quick Support, third-party remote launch, and agent enrollment. Promotion runs lazily on deny and on a 15-minute job; the operator approves or suspends from an email card whose links require a fresh TOTP. A three-state flag (`off | shadow | enforce`) resolves to `off` unless `IS_HOSTED=true`.

**Tech Stack:** Hono, Drizzle, Postgres, BullMQ, Vitest (API), Astro + React (web), Stripe (breeze-billing repo, Wave 1 only).

**Spec:** `docs/superpowers/specs/security-auth/2026-09-02-partner-trust-probation-design.md`

## Global Constraints

- Flag: `PARTNER_TRUST_MODE = off | shadow | enforce`; resolver returns `off` unless `isHosted()` is true; hosted default `shadow`.
- **No new env var is ever required.** `PARTNER_TRUST_MODE`, `IP_CLASSIFY_PROVIDER`, `IP_CLASSIFY_API_KEY`, `PARTNER_MEETING_URL` are all optional; a missing or unrecognised value resolves to the feature being off (or, for the classifier, provider `none` → class `unknown`), logs at most a single `warn`, and never blocks a request or fails boot. Do not add any of them to the config validator's required set. Task 2.2 and Task 5.1 each carry a test that boots with the variable unset.
- Column default `trusted`. Existing partners are never moved by a migration. Backfill is a reviewed SQL batch (Wave 7), never a migration.
- Enrollment cap in probation: **5**, lifetime counter `partners.probation_enrollments`, incremented inside the enrollment transaction with the partner row locked, never decremented.
- No age-only promotion. Auto-promotion requires a settled card charge (`type = 'card'`, not `link`) ≥ 24 h old, undisputed, unrefunded, cardholder name present, plus signup IP class not in `{hosting, vpn, tor, unknown}` and no unresolved `alert` abuse signal.
- Denials and transitions are `audit_logs` events (`partner.trust.*`), never `partner_abuse_signals` rows.
- Deny contract: HTTP 403 body `{ error: 'TRUST_PROBATION' | 'TRUST_RESTRICTED', capability, reason, reviewRequested, meetingUrl }`.
- Approval/suspend links from the email card require a fresh TOTP before acting.
- Restriction by IP requires a corroborating non-IP axis. IPv4 /24, IPv6 /64.
- No cross-region lookups. No auto-suspend.
- Migration name must sort after the newest committed migration: `apps/api/migrations/2026-09-28-partner-trust-probation.sql` (newest today is `2026-09-27-technician-ticket-write-permissions.sql`). Idempotent, no inner `BEGIN/COMMIT`.
- Tenancy: `partners` is partner-axis (shape 3) and `devices` is device-scoped; no new tables, so no cascade-list changes. `devices` gains three columns that must be classified in `tenantExportPolicyRegistry.ts` (`partners` has no entry there; only `org_id` tables do).
- Web mutations go through `runAction`; buttons stay visible in probation.
- Every wave lands as its own PR with `Closes #<sub-issue>`; run `pnpm --filter @breeze/api test --run <file>` (no `--` before `--run`) while developing, full API suite plus the RLS/integration suites before the PR of any wave that touches schema (W02, W04).

---

## File map

| Wave | Create | Modify |
|---|---|---|
| W01 (breeze-billing) | `src/routes/checkout.paymentMethods.test.ts` | `src/routes/checkout.ts:103`, `src/routes/setupIntents.ts:55` |
| W02 | `apps/api/migrations/2026-09-28-partner-trust-probation.sql`, `apps/api/src/services/partnerTrust.ts`, `apps/api/src/services/partnerTrust.test.ts`, `apps/api/src/config/partnerTrustMode.ts`, `apps/api/src/config/partnerTrustMode.test.ts` | `apps/api/src/db/schema/orgs.ts`, `apps/api/src/db/schema/devices.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts:170`, `apps/api/src/routes/auth/register.ts:229`, `apps/api/src/middleware/auth.ts` (`AuthContext.trustState`), `apps/api/src/middleware/partnerGuard.ts:35-48` |
| W03 | `apps/api/src/services/partnerTrust.commands.ts`, `apps/api/src/services/partnerTrust.commands.test.ts` | `apps/api/src/services/commandQueue.ts:601,802,913`, `apps/api/src/routes/agentWs.ts:3123` + connection record, `apps/api/src/routes/devices/actuateElevation.ts:200`, `apps/api/src/routes/mobile.ts:1318` |
| W04 | `apps/api/src/services/remoteSessionCreate.ts`, `apps/api/src/services/remoteSessionCreate.test.ts` | `apps/api/src/routes/remote/sessions.ts:251`, `apps/api/src/services/aiToolsRemote.ts:384`, `apps/api/src/routes/remote/supportSessions.ts:49`, `apps/api/src/routes/tunnels.ts:391,589,1616,1061,1121,1189`, `apps/api/src/routes/desktopWs.ts:1276`, `apps/api/src/routes/terminalWs.ts:1114`, `apps/api/src/routes/devices/core.ts:1203`, `apps/api/src/routes/enrollmentKeys.ts:2131,2519,2576`, `apps/api/src/routes/supportPublic.ts:319,445`, `apps/api/src/routes/agents/enrollment.ts:694-861` |
| W05 | `apps/api/src/services/partnerTrustPromotion.ts` (+test), `apps/api/src/services/ipClassify.ts` (+test), `apps/api/src/jobs/partnerTrustJobs.ts`, `apps/api/src/routes/admin/trust.ts` (+test), `apps/api/src/routes/partnerTrust.ts` (+test), `apps/api/src/services/partnerTrustEvidenceCard.ts` (+test) | `apps/api/src/jobs/scheduleRegistry.ts`, `apps/api/src/routes/admin/index.ts`, `apps/api/src/config/env.ts` |
| W06 | `apps/web/src/components/trust/TrustProbationBanner.tsx` (+test), `apps/web/src/lib/trustProbation.ts` | `apps/web/src/lib/runAction.ts`, onboarding copy component, device list badge |
| W07 | `apps/api/scripts/partner-trust-backfill.sql`, `apps/web/src/pages/admin/trust-queue.astro` + `TrustQueue.tsx` | `.github/workflows/guided-setup-smoke.yml` assertion, docs |

---

## Wave 1 — breeze-billing: Link off, 3DS on (repo `~/breeze-billing`)

### Task 1.1: Card-only Checkout with explicit 3DS

**Files:**
- Modify: `src/routes/checkout.ts:103-122`
- Modify: `src/routes/setupIntents.ts:55-63`
- Test: `src/routes/checkout.paymentMethods.test.ts` (new)

**Interfaces:**
- Produces: both `stripe.checkout.sessions.create` calls carry `payment_method_types: ['card']` and `payment_method_options: { card: { request_three_d_secure: 'any' } }`. Core Wave 5 relies on `charge.succeeded` rows having `payment_method_details.type === 'card'` and `billing_details.name` present.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/checkout.paymentMethods.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async () => ({ id: 'cs_test', url: 'https://checkout.stripe.com/x' }));
vi.mock('../services/stripe.js', () => ({ stripe: { checkout: { sessions: { create } } } }));
vi.mock('../services/customers.js', () => ({ findOrCreateStripeCustomer: async () => 'cus_test' }));

import { buildSubscriptionCheckoutParams } from './checkout.js';
import { buildSetupCheckoutParams } from './setupIntents.js';

describe('signup checkout payment methods', () => {
  beforeEach(() => create.mockClear());

  it('subscription checkout is card-only with 3DS requested', () => {
    const p = buildSubscriptionCheckoutParams({ customerId: 'cus_test', priceId: 'price_x', plan: 'starter', partnerId: 'p1', successUrl: 'https://a', cancelUrl: 'https://b' });
    expect(p.payment_method_types).toEqual(['card']);
    expect(p.payment_method_options?.card?.request_three_d_secure).toBe('any');
  });

  it('setup checkout is card-only with 3DS requested', () => {
    const p = buildSetupCheckoutParams({ customerId: 'cus_test', partnerId: 'p1', returnUrl: 'https://a' });
    expect(p.payment_method_types).toEqual(['card']);
    expect(p.payment_method_options?.card?.request_three_d_secure).toBe('any');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/breeze-billing && npx vitest run src/routes/checkout.paymentMethods.test.ts`
Expected: FAIL — `buildSubscriptionCheckoutParams` is not exported.

- [ ] **Step 3: Extract the params builders and add the two fields**

In `src/routes/checkout.ts`, above the route handler:

```ts
export function buildSubscriptionCheckoutParams(input: {
  customerId: string; priceId: string; plan: string; partnerId: string; successUrl: string; cancelUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    customer: input.customerId,
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    // Link is the confirmed abuse bypass (no cardholder name, Radar risk
    // normal on every fraudulent capture); card-only + 3DS is a rollout
    // prerequisite for partner trust probation (core spec 2026-09-02 §3.5).
    payment_method_types: ['card'],
    payment_method_options: { card: { request_three_d_secure: 'any' } },
    metadata: { breeze_partner_id: input.partnerId, breeze_plan: input.plan },
    subscription_data: { metadata: { breeze_partner_id: input.partnerId, breeze_plan: input.plan } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}
```

Replace the inline object at line 103 with `await stripe.checkout.sessions.create(buildSubscriptionCheckoutParams({ customerId, priceId, plan, partnerId, successUrl, cancelUrl }))`, computing `successUrl`/`cancelUrl` exactly as the existing ternaries do.

In `src/routes/setupIntents.ts`:

```ts
export function buildSetupCheckoutParams(input: { customerId: string; partnerId: string; returnUrl: string }): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'setup',
    customer: input.customerId,
    currency: 'usd',
    payment_method_types: ['card'],
    payment_method_options: { card: { request_three_d_secure: 'any' } },
    success_url: input.returnUrl,
    cancel_url: input.returnUrl,
    metadata: { breeze_partner_id: input.partnerId },
  };
}
```

and call it at line 55.

- [ ] **Step 4: Run tests**

Run: `cd ~/breeze-billing && npx vitest run src/routes/`
Expected: PASS, including the existing checkout and setupIntents suites.

- [ ] **Step 5: Verify in Stripe test mode**

Run the billing service locally against the test key, hit `POST /checkout` for a test partner, open the returned URL, and confirm the Checkout page shows no "Pay with Link" option and the card form triggers the 3DS test challenge with card `4000 0027 6000 3184`. Record the session id in the PR body.

- [ ] **Step 6: Commit and open PR (breeze-billing)**

```bash
git add src/routes/checkout.ts src/routes/setupIntents.ts src/routes/checkout.paymentMethods.test.ts
git commit -m "fix(checkout): card-only signup checkout with 3DS requested — Link is the abuse bypass"
```

Deploy note for the PR body: billing builds from source on each droplet (`cd /opt/breeze-billing && git pull --ff-only && cd /opt/breeze && docker compose build billing && docker compose up -d billing`).

---

## Wave 2 — Core foundation: schema, flag, trust service (shadow-capable, no gates yet)

### Task 2.1: Migration and Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-09-28-partner-trust-probation.sql`
- Modify: `apps/api/src/db/schema/orgs.ts:8` (enums) and the `partners` table after `signupUserAgent`
- Modify: `apps/api/src/db/schema/devices.ts:56` after `enrollmentIp`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:170` (`devices` entry)

**Interfaces:**
- Produces: `partners.trustState`, `trustChangedAt`, `trustChangedBy`, `trustReason`, `trustReviewRequestedAt`, `probationEnrollments`, `signupIpClass`, `signupIpAsn`, `signupIpClassifiedAt`; `devices.enrollmentIpClass`, `enrollmentIpAsn`, `enrollmentIpClassifiedAt`; exported types `PartnerTrustState`, `IpClass`.

- [ ] **Step 1: Write the failing schema-drift check**

Run: `cd apps/api && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: clean now (baseline). After Step 3 and before Step 4 it must report the new columns as drift, proving the migration is what closes it.

- [ ] **Step 2: Write the migration**

```sql
-- 2026-09-28-partner-trust-probation.sql
-- Partner trust probation (spec: docs/superpowers/specs/security-auth/2026-09-02-partner-trust-probation-design.md)
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file).

DO $$ BEGIN
  CREATE TYPE partner_trust_state AS ENUM ('probation', 'trusted', 'restricted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ip_class AS ENUM ('residential', 'business', 'hosting', 'vpn', 'tor', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_state               partner_trust_state NOT NULL DEFAULT 'trusted',
  ADD COLUMN IF NOT EXISTS trust_changed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS trust_changed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trust_reason              text,
  ADD COLUMN IF NOT EXISTS trust_review_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS probation_enrollments     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signup_ip_class           ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS signup_ip_asn             integer,
  ADD COLUMN IF NOT EXISTS signup_ip_classified_at   timestamptz;

CREATE INDEX IF NOT EXISTS partners_trust_state_idx
  ON partners (trust_state) WHERE trust_state <> 'trusted';

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS enrollment_ip_class         ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS enrollment_ip_asn           integer,
  ADD COLUMN IF NOT EXISTS enrollment_ip_classified_at timestamptz;
```

No RLS change: both tables already carry forced policies and the new columns inherit them.

- [ ] **Step 3: Drizzle schema**

`apps/api/src/db/schema/orgs.ts`, next to `partnerStatusEnum` (line 8):

```ts
export const partnerTrustStateEnum = pgEnum('partner_trust_state', ['probation', 'trusted', 'restricted']);
export type PartnerTrustState = (typeof partnerTrustStateEnum.enumValues)[number];
export const ipClassEnum = pgEnum('ip_class', ['residential', 'business', 'hosting', 'vpn', 'tor', 'unknown']);
export type IpClass = (typeof ipClassEnum.enumValues)[number];
```

In the `partners` table definition, after `signupUserAgent`:

```ts
  // Partner trust probation (spec 2026-09-02). Lifecycle stays in `status`;
  // this is the capability axis. Default 'trusted' grandfathers every
  // pre-existing partner; register-partner sets 'probation' under enforce.
  trustState: partnerTrustStateEnum('trust_state').notNull().default('trusted'),
  trustChangedAt: timestamp('trust_changed_at', { withTimezone: true }),
  trustChangedBy: uuid('trust_changed_by').references(() => users.id, { onDelete: 'set null' }),
  trustReason: text('trust_reason'),
  trustReviewRequestedAt: timestamp('trust_review_requested_at', { withTimezone: true }),
  // Lifetime count of agent enrollments made while in probation. Never
  // decremented: deleting a device must not recycle the probation quota.
  probationEnrollments: integer('probation_enrollments').notNull().default(0),
  signupIpClass: ipClassEnum('signup_ip_class').notNull().default('unknown'),
  signupIpAsn: integer('signup_ip_asn'),
  signupIpClassifiedAt: timestamp('signup_ip_classified_at', { withTimezone: true }),
```

(`users` is imported into `orgs.ts` via a lazy reference if a circular import appears; follow how `trustChangedBy`'s neighbours reference `users` elsewhere in the schema, e.g. `enrollment_keys.created_by`.)

`apps/api/src/db/schema/devices.ts` after `enrollmentIp` (line 56):

```ts
  enrollmentIpClass: ipClassEnum('enrollment_ip_class').notNull().default('unknown'),
  enrollmentIpAsn: integer('enrollment_ip_asn'),
  enrollmentIpClassifiedAt: timestamp('enrollment_ip_classified_at', { withTimezone: true }),
```

`apps/api/src/services/tenantExportPolicyRegistry.ts:170`, `devices` entry: add `"enrollment_ip_class"`, `"enrollment_ip_asn"`, `"enrollment_ip_classified_at"` to `"reviewedIncluded"` with a comment that they are derived risk metadata; the spec asks for them to be withheld from the tenant-facing export, and the registry's only non-secret withholding bucket is `excludedOpen`, which is reserved for containers. Decision: put them in `excludedSensitive` (the export omits them) with the comment `// risk metadata: withheld so a subject-access export cannot be used to tune evasion`. This is the one place the plan overrides the bucket's nominal meaning; the integration suite only checks membership.

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:migrate && pnpm db:check-drift`
Expected: migration applies; drift check clean.

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: PASS (naming and ordering guard).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-09-28-partner-trust-probation.sql apps/api/src/db/schema/orgs.ts apps/api/src/db/schema/devices.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(trust): partner trust state + ip class columns (probation foundation)"
```

### Task 2.2: Flag resolver

**Files:**
- Create: `apps/api/src/config/partnerTrustMode.ts`
- Test: `apps/api/src/config/partnerTrustMode.test.ts`

**Interfaces:**
- Produces: `export type PartnerTrustMode = 'off' | 'shadow' | 'enforce'; export function partnerTrustMode(): PartnerTrustMode;`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/config/partnerTrustMode.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { partnerTrustMode } from './partnerTrustMode';

const env = process.env;
afterEach(() => { process.env = { ...env }; });

describe('partnerTrustMode', () => {
  it('is off when not hosted, regardless of the env value', () => {
    process.env.IS_HOSTED = 'false';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    expect(partnerTrustMode()).toBe('off');
  });
  it('defaults to shadow when hosted and unset', () => {
    process.env.IS_HOSTED = 'true';
    delete process.env.PARTNER_TRUST_MODE;
    expect(partnerTrustMode()).toBe('shadow');
  });
  it('honours enforce when hosted', () => {
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    expect(partnerTrustMode()).toBe('enforce');
  });
  it('is off and silent when nothing at all is configured (fresh self-hosted install)', () => {
    delete process.env.IS_HOSTED; delete process.env.PARTNER_TRUST_MODE;
    delete process.env.IP_CLASSIFY_PROVIDER; delete process.env.IP_CLASSIFY_API_KEY; delete process.env.PARTNER_MEETING_URL;
    const warn = vi.spyOn(console, 'warn');
    expect(partnerTrustMode()).toBe('off');
    expect(warn).not.toHaveBeenCalled();
  });
  it('falls back to shadow on an unrecognised value', () => {
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'yes';
    expect(partnerTrustMode()).toBe('shadow');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/config/partnerTrustMode.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/config/partnerTrustMode.ts
import { isHosted } from './env';

export type PartnerTrustMode = 'off' | 'shadow' | 'enforce';

/**
 * Partner trust probation flag. Self-hosted safeguard: resolves to 'off'
 * whenever IS_HOSTED is not true, regardless of PARTNER_TRUST_MODE, so a
 * self-hosted install never evaluates the gate. Read at call time (like
 * abuseSignalsEnabled) so tests can flip it per case.
 */
export function partnerTrustMode(): PartnerTrustMode {
  if (!isHosted()) return 'off';
  const raw = (process.env.PARTNER_TRUST_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  if (raw !== '') console.warn(`[PartnerTrust] Ignoring unrecognized PARTNER_TRUST_MODE value ${JSON.stringify(raw)}; using shadow`);
  return 'shadow';
}
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: Commit** — `git commit -m "feat(trust): PARTNER_TRUST_MODE resolver, off unless hosted"`.

### Task 2.3: Trust service (decision, audit, allowlist)

**Files:**
- Create: `apps/api/src/services/partnerTrust.ts`
- Test: `apps/api/src/services/partnerTrust.test.ts`

**Interfaces:**
- Consumes: `partnerTrustMode()`, `createAuditLog` (`services/auditService.ts:86`), `withSystemDbAccessContext` / `runOutsideDbContext` (`db/index.ts:610,780`).
- Produces:

```ts
export type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll';
export type TrustDenyCode = 'TRUST_PROBATION' | 'TRUST_RESTRICTED';
export type GateDecision =
  | { allow: true; shadowDenied?: { code: TrustDenyCode; reason: string } }
  | { allow: false; code: TrustDenyCode; capability: GatedCapability; reason: string };
export interface GateContext { partnerId: string; deviceId?: string; orgId?: string; userId?: string; commandType?: string; detail?: Record<string, unknown> }
export const PROBATION_ENROLLMENT_CAP = 5;
export function isLifecycleCommand(type: string): boolean;
export async function loadTrustState(partnerId: string): Promise<{ trustState: PartnerTrustState; probationEnrollments: number } | null>;
export async function evaluateCapability(cap: GatedCapability, ctx: GateContext): Promise<GateDecision>;
export function requireCapability(cap: GatedCapability): MiddlewareHandler;
export function trustDenyBody(d: Extract<GateDecision, { allow: false }>, reviewRequested: boolean): { error: TrustDenyCode; capability: GatedCapability; reason: string; reviewRequested: boolean; meetingUrl: string | null };
export async function setTrustState(partnerId: string, next: PartnerTrustState, reason: string, actorUserId: string | null, evidence?: Record<string, unknown>): Promise<void>;
export async function partnerIdForDevice(deviceId: string): Promise<string | null>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/partnerTrust.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { trustState: 'probation', probationEnrollments: 0 };
const audit = vi.fn(async () => {});
vi.mock('./auditService', () => ({ createAuditLog: audit }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: vi.fn(() => 'enforce') }));
vi.mock('../db', () => ({
  db: {}, withSystemDbAccessContext: async (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./partnerTrust.repo', () => ({
  readTrust: vi.fn(async () => state),
  writeTrust: vi.fn(async () => {}),
  partnerForDevice: vi.fn(async () => 'p1'),
}));

import { partnerTrustMode } from '../config/partnerTrustMode';
import { evaluateCapability, isLifecycleCommand, LIFECYCLE_COMMAND_TYPES, GATED_COMMAND_TYPES } from './partnerTrust';

beforeEach(() => { audit.mockClear(); state.trustState = 'probation'; state.probationEnrollments = 0; (partnerTrustMode as any).mockReturnValue('enforce'); });

describe('evaluateCapability', () => {
  it.each(['remote_control', 'device_execute', 'installer_distribute'] as const)('denies %s in probation', async (cap) => {
    const d = await evaluateCapability(cap, { partnerId: 'p1' });
    expect(d).toMatchObject({ allow: false, code: 'TRUST_PROBATION', capability: cap });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'partner.trust.capability_denied' }));
  });
  it('denies with TRUST_RESTRICTED when restricted', async () => {
    state.trustState = 'restricted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toMatchObject({ allow: false, code: 'TRUST_RESTRICTED' });
  });
  it('allows everything when trusted and writes no audit row', async () => {
    state.trustState = 'trusted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });
  it('allows enroll under the cap and denies at the cap', async () => {
    state.probationEnrollments = 4;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' })).toEqual({ allow: true });
    state.probationEnrollments = 5;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' })).toMatchObject({ allow: false, reason: 'probation_enrollment_cap' });
  });
  it('lets lifecycle commands through device_execute even in probation', async () => {
    expect(await evaluateCapability('device_execute', { partnerId: 'p1', commandType: 'self_uninstall' })).toEqual({ allow: true });
  });
  it('shadow mode allows but records the would-deny', async () => {
    (partnerTrustMode as any).mockReturnValue('shadow');
    const d = await evaluateCapability('remote_control', { partnerId: 'p1' });
    expect(d).toMatchObject({ allow: true, shadowDenied: { code: 'TRUST_PROBATION' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'partner.trust.capability_denied', details: expect.objectContaining({ mode: 'shadow' }) }));
  });
  it('off mode allows and touches nothing', async () => {
    (partnerTrustMode as any).mockReturnValue('off');
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('command allowlist', () => {
  it('classifies every known command type exactly once', () => {
    const both = LIFECYCLE_COMMAND_TYPES.filter((t) => GATED_COMMAND_TYPES.includes(t));
    expect(both).toEqual([]);
    for (const t of ['script', 'execute_command', 'file_write', 'task_run', 'software_install', 'install_patches', 'backup_restore', 'actuate_elevation', 'computer_action', 'terminal_start', 'reboot']) expect(isLifecycleCommand(t)).toBe(false);
    for (const t of ['self_uninstall', 'terminal_stop', 'token_rotate', 'wake_on_lan', 'peripheral_policy_push']) expect(isLifecycleCommand(t)).toBe(true);
  });
  it('an unknown command type is gated (fail closed)', () => {
    expect(isLifecycleCommand('brand_new_command')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement the repo and service**

```ts
// apps/api/src/services/partnerTrust.repo.ts
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, devices, organizations } from '../db/schema';
import type { PartnerTrustState } from '../db/schema/orgs';

export interface TrustRow { trustState: PartnerTrustState; probationEnrollments: number; trustReviewRequestedAt: Date | null }

// System context: the request role must not need SELECT on trust columns
// for other partners, and dispatch paths run with no request context at all.
export async function readTrust(partnerId: string): Promise<TrustRow | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ trustState: partners.trustState, probationEnrollments: partners.probationEnrollments, trustReviewRequestedAt: partners.trustReviewRequestedAt })
      .from(partners).where(eq(partners.id, partnerId)).limit(1);
    return row ?? null;
  }, 'partnerTrust.readTrust'));
}

export async function writeTrust(partnerId: string, next: PartnerTrustState, reason: string, actorUserId: string | null): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.update(partners).set({ trustState: next, trustReason: reason, trustChangedBy: actorUserId, trustChangedAt: new Date(), updatedAt: new Date() }).where(eq(partners.id, partnerId)),
    'partnerTrust.writeTrust'));
}

export async function partnerForDevice(deviceId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ partnerId: organizations.partnerId }).from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id)).where(eq(devices.id, deviceId)).limit(1);
    return row?.partnerId ?? null;
  }, 'partnerTrust.partnerForDevice'));
}
```

```ts
// apps/api/src/services/partnerTrust.ts
import type { MiddlewareHandler } from 'hono';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { createAuditLog } from './auditService';
import { readTrust, writeTrust, partnerForDevice } from './partnerTrust.repo';
import type { PartnerTrustState } from '../db/schema/orgs';

export type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll';
export type TrustDenyCode = 'TRUST_PROBATION' | 'TRUST_RESTRICTED';
export type GateDecision =
  | { allow: true; shadowDenied?: { code: TrustDenyCode; reason: string } }
  | { allow: false; code: TrustDenyCode; capability: GatedCapability; reason: string };
export interface GateContext { partnerId: string; deviceId?: string; orgId?: string; userId?: string; commandType?: string; detail?: Record<string, unknown> }

export const PROBATION_ENROLLMENT_CAP = 5;

/** Commands the platform itself needs on a probation tenant. Anything not
 *  listed here is gated: an unknown type fails closed. */
export const LIFECYCLE_COMMAND_TYPES = [
  'self_uninstall', 'terminal_stop', 'session_stop', 'desktop_stop',
  'token_rotate', 'token_rotate_confirm', 'watchdog_token_rotate', 'helper_token_rotate',
  'wake_on_lan', 'peripheral_policy_push', 'outbound_network_policy',
  'filesystem_analysis', 'inventory_refresh', 'patch_scan', 'security_status_refresh',
  'agent_update', 'watchdog_update', 'helper_update', 'edition_migrate', 'device_remove',
] as const;

/** Documented for the allowlist test only; membership is not consulted at runtime. */
export const GATED_COMMAND_TYPES = [
  'script', 'execute_command', 'file_write', 'file_copy', 'file_rename', 'file_delete', 'file_trash_restore', 'file_trash_purge',
  'task_run', 'registry_set', 'registry_key_create', 'registry_key_delete',
  'software_install', 'software_uninstall', 'software_update', 'homebrew_bootstrap',
  'install_patches', 'rollback_patches',
  'backup_restore', 'vm_restore_from_backup', 'vm_instant_boot', 'mssql_restore', 'hyperv_restore', 'hyperv_checkpoint',
  'actuate_elevation', 'computer_action', 'take_screenshot', 'terminal_start', 'terminal_data', 'terminal_resize',
  'tunnel_open', 'tunnel_close', 'execute_containment', 'security_threat_quarantine', 'security_threat_remove', 'reboot',
] as const;

const lifecycle = new Set<string>(LIFECYCLE_COMMAND_TYPES);
export function isLifecycleCommand(type: string): boolean { return lifecycle.has(type); }

export async function partnerIdForDevice(deviceId: string): Promise<string | null> { return partnerForDevice(deviceId); }

export async function loadTrustState(partnerId: string) { return readTrust(partnerId); }

function decide(cap: GatedCapability, row: { trustState: PartnerTrustState; probationEnrollments: number }, ctx: GateContext): { code: TrustDenyCode; reason: string } | null {
  if (row.trustState === 'trusted') return null;
  const code: TrustDenyCode = row.trustState === 'restricted' ? 'TRUST_RESTRICTED' : 'TRUST_PROBATION';
  switch (cap) {
    case 'agent_enroll':
      if (row.trustState === 'restricted') return { code, reason: 'restricted' };
      return row.probationEnrollments >= PROBATION_ENROLLMENT_CAP ? { code, reason: 'probation_enrollment_cap' } : null;
    case 'device_execute':
      if (ctx.commandType && isLifecycleCommand(ctx.commandType)) return null;
      return { code, reason: row.trustState === 'restricted' ? 'restricted' : 'probation_default_deny' };
    default:
      return { code, reason: row.trustState === 'restricted' ? 'restricted' : 'probation_default_deny' };
  }
}

export async function evaluateCapability(cap: GatedCapability, ctx: GateContext): Promise<GateDecision> {
  const mode = partnerTrustMode();
  if (mode === 'off') return { allow: true };
  const row = await readTrust(ctx.partnerId);
  if (!row) return { allow: true }; // unknown partner: lifecycle guards elsewhere handle it
  const denial = decide(cap, row, ctx);
  if (!denial) return { allow: true };
  await createAuditLog({
    orgId: ctx.orgId ?? null, actorType: ctx.userId ? 'user' : 'system', actorId: ctx.userId ?? null,
    action: 'partner.trust.capability_denied', resourceType: 'partner', resourceId: ctx.partnerId,
    result: mode === 'enforce' ? 'denied' : 'success',
    details: { mode, capability: cap, code: denial.code, reason: denial.reason, deviceId: ctx.deviceId ?? null, commandType: ctx.commandType ?? null, ...ctx.detail },
  });
  if (mode === 'shadow') return { allow: true, shadowDenied: denial };
  return { allow: false, code: denial.code, capability: cap, reason: denial.reason };
}

export function trustDenyBody(d: Extract<GateDecision, { allow: false }>, reviewRequested: boolean) {
  return { error: d.code, capability: d.capability, reason: d.reason, reviewRequested, meetingUrl: process.env.PARTNER_MEETING_URL ?? null };
}

/** Route-level convenience: friendly early 403. The chokepoints remain the control. */
export function requireCapability(cap: GatedCapability): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) return next();
    const d = await evaluateCapability(cap, { partnerId: auth.partnerId, userId: auth.user?.id, orgId: auth.orgId ?? undefined });
    if (!d.allow) {
      const row = await readTrust(auth.partnerId);
      return c.json(trustDenyBody(d, !!row?.trustReviewRequestedAt), 403);
    }
    return next();
  };
}

export async function setTrustState(partnerId: string, next: PartnerTrustState, reason: string, actorUserId: string | null, evidence: Record<string, unknown> = {}): Promise<void> {
  const before = await readTrust(partnerId);
  await writeTrust(partnerId, next, reason, actorUserId);
  await createAuditLog({
    orgId: null, actorType: actorUserId ? 'user' : 'system', actorId: actorUserId,
    action: next === 'trusted' ? 'partner.trust.promoted' : next === 'restricted' ? 'partner.trust.restricted' : 'partner.trust.probation',
    resourceType: 'partner', resourceId: partnerId, result: 'success',
    details: { from: before?.trustState ?? null, to: next, reason, ...evidence },
  });
}
```

The `CreateAuditLogParams` shape must be checked against `services/auditService.ts` and the object literal adjusted to its field names (`actorType`, `actorId`, `orgId`, `action`, `resourceType`, `resourceId`, `result`, `details`); the test mocks it so field drift shows up at typecheck, not at runtime.

- [ ] **Step 4: Verify the allowlist against real command types**

Run: `grep -rhoE "type: '([a-z_]+)'" apps/api/src/services/commandQueue.ts apps/api/src/routes apps/api/src/services | sort -u`
Every type printed must appear in exactly one of `LIFECYCLE_COMMAND_TYPES` or `GATED_COMMAND_TYPES`; extend the test's explicit lists with whatever the grep shows that the lists above do not name, and put each in the right list. Names in the lists above that do not exist in the repo are removed. This step is the one that makes the allowlist true rather than plausible.

- [ ] **Step 5: Run tests, typecheck** — `npx vitest run src/services/partnerTrust.test.ts && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(trust): partner trust service, allowlist, audit events"`.

### Task 2.4: New signups enter probation; trust on auth context

**Files:**
- Modify: `apps/api/src/routes/auth/register.ts:229` (partner insert)
- Modify: `apps/api/src/middleware/partnerGuard.ts:35-48` (select `trustState` too, set `c.set('trustState', …)`)
- Modify: `apps/api/src/middleware/auth.ts:72` (`AuthContext.trustState?: PartnerTrustState`)
- Test: `apps/api/src/routes/auth/register.trust.test.ts` (new), extend `apps/api/src/middleware/partnerGuard.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/routes/auth/register.trust.test.ts — follows register.test.ts's existing mocking of db.insert
it('new partner is created in probation when PARTNER_TRUST_MODE=enforce and hosted', async () => {
  process.env.IS_HOSTED = 'true'; process.env.PARTNER_TRUST_MODE = 'enforce';
  await registerPartner(validBody);
  expect(insertedPartnerValues()).toMatchObject({ trustState: 'probation' });
});
it('new partner is trusted when mode is shadow (shadow must not change data)', async () => {
  process.env.IS_HOSTED = 'true'; process.env.PARTNER_TRUST_MODE = 'shadow';
  await registerPartner(validBody);
  expect(insertedPartnerValues().trustState ?? 'trusted').toBe('trusted');
});
```

Shadow must not write `probation`: the point of shadow is measuring denials without changing state, and a shadow partner flipped to `probation` would be denied the moment enforce turns on without ever having been in the queue. Shadow measures against `trusted` partners created after the flag is set, using the `mode: shadow` audit rows, which is what Wave 7's acceptance reads.

- [ ] **Step 2: Run to fail**, **Step 3: Implement**

In `register.ts` at the partner insert: `trustState: partnerTrustMode() === 'enforce' ? 'probation' : 'trusted'`, and immediately after the insert, `if (trustState === 'probation') await createAuditLog({ ...action: 'partner.trust.probation', resourceId: partner.id, details: { reason: 'signup' } })` (reuse `setTrustState`'s audit shape by calling `setTrustState(partner.id, 'probation', 'signup', null)` after the insert instead of duplicating the row; the extra `UPDATE` is fine at signup volume).

In `partnerGuard.ts`, add `trustState: partners.trustState` to the select and `c.set('trustState', partner.trustState)` before `return next()` on the active path. In `auth.ts`, add `trustState?: PartnerTrustState` to `AuthContext` and populate from `c.get('trustState')` where the auth context is assembled after `partnerGuard` (if auth runs first, leave `AuthContext` untouched and have `requireCapability` read `c.get('trustState')` as a fast path before `readTrust`).

- [ ] **Step 4: Run** `npx vitest run src/routes/auth/register src/middleware/partnerGuard` → PASS (check the file count: `src/routes/auth/register` also matches `register.test.ts`).
- [ ] **Step 5: Commit** — `git commit -m "feat(trust): signups enter probation under enforce; trust on guard context"`.

### Task 2.5: Wave 2 PR

- [ ] Run full API suite `pnpm --filter @breeze/api test --run`, then `cd apps/api && npx vitest run -c vitest.config.rls.ts` and `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage src/__tests__/integration/tenant-export-policy` against the local DB.
- [ ] `pnpm lint`.
- [ ] Open PR `feat(trust): probation foundation (W02)` with `Closes #<W02 sub-issue>`; body lists the migration name and the export-policy bucket decision from Task 2.1 for reviewer attention.

---

## Wave 3 — Command dispatch chokepoints

### Task 3.1: Gate helper for dispatch

**Files:**
- Create: `apps/api/src/services/partnerTrust.commands.ts`
- Test: `apps/api/src/services/partnerTrust.commands.test.ts`

**Interfaces:**
- Produces: `export class TrustDeniedError extends Error { code: TrustDenyCode; capability: 'device_execute'; reason: string; deviceId: string; commandType: string }` and `export async function assertDeviceExecuteAllowed(deviceId: string, commandType: string, userId?: string | null): Promise<void>` (throws `TrustDeniedError` on deny, returns on allow or shadow).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
const evaluate = vi.fn();
vi.mock('./partnerTrust', () => ({ evaluateCapability: evaluate, partnerIdForDevice: async () => 'p1', isLifecycleCommand: (t: string) => t === 'self_uninstall' }));
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';

it('throws TrustDeniedError on deny', async () => {
  evaluate.mockResolvedValueOnce({ allow: false, code: 'TRUST_PROBATION', capability: 'device_execute', reason: 'probation_default_deny' });
  await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).rejects.toBeInstanceOf(TrustDeniedError);
});
it('returns on allow', async () => {
  evaluate.mockResolvedValueOnce({ allow: true });
  await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).resolves.toBeUndefined();
});
it('skips the lookup entirely for lifecycle commands', async () => {
  evaluate.mockClear();
  await assertDeviceExecuteAllowed('d1', 'self_uninstall');
  expect(evaluate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Fail**, **Step 3: Implement**

```ts
// apps/api/src/services/partnerTrust.commands.ts
import { evaluateCapability, partnerIdForDevice, isLifecycleCommand, type TrustDenyCode } from './partnerTrust';

export class TrustDeniedError extends Error {
  readonly code: TrustDenyCode; readonly capability = 'device_execute' as const; readonly reason: string; readonly deviceId: string; readonly commandType: string;
  constructor(code: TrustDenyCode, reason: string, deviceId: string, commandType: string) {
    super(`Partner trust ${code}: ${commandType} on ${deviceId} (${reason})`);
    this.name = 'TrustDeniedError'; this.code = code; this.reason = reason; this.deviceId = deviceId; this.commandType = commandType;
  }
}

export async function assertDeviceExecuteAllowed(deviceId: string, commandType: string, userId?: string | null): Promise<void> {
  if (isLifecycleCommand(commandType)) return;
  const partnerId = await partnerIdForDevice(deviceId);
  if (!partnerId) return;
  const d = await evaluateCapability('device_execute', { partnerId, deviceId, userId: userId ?? undefined, commandType });
  if (!d.allow) throw new TrustDeniedError(d.code, d.reason, deviceId, commandType);
}
```

- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): assertDeviceExecuteAllowed for dispatch chokepoints"`.

### Task 3.2: Gate `commandQueue.ts`

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts:601` (`queueCommand`), `:802` (`queueCommandForExecution`), `:913` (`executeCommand`)
- Test: extend `apps/api/src/services/commandQueue.test.ts`

- [ ] **Step 1: Failing tests** (add to the existing suite, using its existing device/db mocks)

```ts
vi.mock('./partnerTrust.commands', async (orig) => ({ ...(await orig()), assertDeviceExecuteAllowed: vi.fn(async (_d, t) => { if (t === 'script') throw new TrustDeniedError('TRUST_PROBATION', 'probation_default_deny', 'd1', 'script'); }) }));

it('queueCommand refuses a gated type for a probation partner and inserts nothing', async () => {
  await expect(queueCommand('d1', 'script', {}, 'u1')).rejects.toBeInstanceOf(TrustDeniedError);
  expect(insertSpy).not.toHaveBeenCalled();
});
it('queueCommand still queues self_uninstall', async () => {
  await expect(queueCommand('d1', 'self_uninstall', { removeConfig: true }, 'u1')).resolves.toBeTruthy();
});
it('queueCommandForExecution returns a structured trust error instead of throwing', async () => {
  await expect(queueCommandForExecution('d1', 'script', {})).resolves.toMatchObject({ error: 'TRUST_PROBATION', trust: { reason: 'probation_default_deny' } });
});
it('executeCommand returns a failed CommandResult with the trust code', async () => {
  await expect(executeCommand('d1', 'script', {})).resolves.toMatchObject({ success: false, error: 'TRUST_PROBATION' });
});
```

- [ ] **Step 2: Fail**, **Step 3: Implement**

In `queueCommand` (line 601), after the `AGENT_BINARY_UPDATE_COMMAND_TYPES` check and before `resolveCommandCreatedBy`:

```ts
  await assertDeviceExecuteAllowed(deviceId, type, userId);
```

In `queueCommandForExecution` (line 802), after the `device.status !== 'online'` check:

```ts
  try { await assertDeviceExecuteAllowed(deviceId, type, userId); }
  catch (e) { if (e instanceof TrustDeniedError) return { error: e.code, trust: { capability: e.capability, reason: e.reason } }; throw e; }
```

and extend `QueueCommandForExecutionResult`'s error variant with `trust?: { capability: 'device_execute'; reason: string }`.

In `executeCommand` (line 913), after the device select and before the WS dispatch branch:

```ts
  try { await assertDeviceExecuteAllowed(deviceId, type, userId); }
  catch (e) { if (e instanceof TrustDeniedError) return { success: false, error: e.code, output: '', exitCode: null, trust: { capability: e.capability, reason: e.reason } } as CommandResult; throw e; }
```

adding the optional `trust` field to `CommandResult`.

- [ ] **Step 4: Run** `npx vitest run src/services/commandQueue` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(trust): gate queueCommand/queueCommandForExecution/executeCommand"`.

### Task 3.3: Route the two raw inserts through the queue helper

**Files:**
- Modify: `apps/api/src/routes/devices/actuateElevation.ts:191-217` (raw `insert(deviceCommands)` at 200)
- Modify: `apps/api/src/routes/mobile.ts:1318`
- Test: extend `actuateElevation.test.ts` and `mobile.test.ts`

- [ ] **Step 1: Failing tests** — for each route, mock `assertDeviceExecuteAllowed` to throw `TrustDeniedError` and assert the response is `403` with body `{ error: 'TRUST_PROBATION', capability: 'device_execute', reason: 'probation_default_deny' }` and that no `device_commands` row is inserted.
- [ ] **Step 2: Fail**, **Step 3: Implement** — call `await assertDeviceExecuteAllowed(deviceId, 'actuate_elevation', auth.user.id)` (resp. `data.action`) immediately before the raw insert, catching `TrustDeniedError` and returning `c.json(trustDenyBody({ allow: false, code: e.code, capability: 'device_execute', reason: e.reason }, false), 403)`. The raw inserts stay raw (they carry single-use transactional semantics the queue helper does not); the gate is what moves.
- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): gate PAM actuation and mobile actions"`.

### Task 3.4: Agent WebSocket fast path

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` — the `activeConnections` record type, the connect/auth path that populates it, and `sendCommandToAgent` at `:3123`
- Modify: `apps/api/src/services/partnerTrust.ts` — `setTrustState` publishes `partner-trust:changed` on Redis
- Test: extend `apps/api/src/routes/agentWs.test.ts`

**Interfaces:**
- `sendCommandToAgent(agentId, command)` keeps its synchronous signature. It returns `false` (not sent) when the connection's cached `trustState` is not `trusted` and `!isLifecycleCommand(command.type)` under `enforce`; callers already treat `false` as "agent offline" and fall back to `queueCommand`, which is gated by Task 3.2 and produces the real decision and audit row. Under `shadow` it sends and writes the audit row via `evaluateCapability` fire-and-forget.

- [ ] **Step 1: Failing tests**

```ts
it('fast path refuses a gated command for a probation connection and returns false', () => {
  registerConnection('agent-1', fakeWs, { partnerId: 'p1', trustState: 'probation' });
  expect(sendCommandToAgent('agent-1', { id: 'c1', type: 'script', payload: {} })).toBe(false);
  expect(fakeWs.send).not.toHaveBeenCalled();
});
it('fast path sends lifecycle commands regardless of trust', () => {
  registerConnection('agent-1', fakeWs, { partnerId: 'p1', trustState: 'probation' });
  expect(sendCommandToAgent('agent-1', { id: 'c1', type: 'self_uninstall', payload: {} })).toBe(true);
});
it('a partner-trust:changed message updates the cached state for every connection of that partner', async () => {
  registerConnection('agent-1', fakeWs, { partnerId: 'p1', trustState: 'probation' });
  await handleTrustChanged({ partnerId: 'p1', trustState: 'trusted' });
  expect(sendCommandToAgent('agent-1', { id: 'c1', type: 'script', payload: {} })).toBe(true);
});
```

- [ ] **Step 2: Fail**, **Step 3: Implement**

1. Extend the connection record (wherever `activeConnections.set(agentId, ws)` is done at agent auth) to `{ ws, partnerId, trustState }`. The partner id and trust state are resolved once at connect time with `partnerIdForDevice(deviceId)` + `loadTrustState(partnerId)`; the agent-auth path already runs in a system context.
2. `sendCommandToAgent`: after `const conn = activeConnections.get(agentId); if (!conn) return false;` add

```ts
  const mode = partnerTrustMode();
  if (mode !== 'off' && conn.trustState !== 'trusted' && !isLifecycleCommand(command.type)) {
    if (mode === 'enforce') return false; // caller falls back to queueCommand, which audits and decides
    void evaluateCapability('device_execute', { partnerId: conn.partnerId, commandType: command.type, detail: { via: 'ws_fast_path' } });
  }
```

3. Subscribe (in the same module's boot path that already subscribes to Redis for agent events) to channel `partner-trust:changed`; on message `{ partnerId, trustState }`, update every connection with that `partnerId`. `setTrustState` publishes the message after `writeTrust`.

- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): agent WS fast path honours partner trust"`.

### Task 3.5: Wave 3 PR

- [ ] Grep-verify no dispatch path bypasses the gate: `grep -rn "insert(deviceCommands)" apps/api/src | grep -v test` must list only `actuateElevation.ts`, `mobile.ts`, `commandQueue.ts`, and the system-initiated sites named in the spec (`routes/agents/helpers.ts`, `services/wakeOnLan.ts`, `desktopSessionStop.ts`, `tenantOffboarding.ts`, `deviceUninstallDrain.ts`, `peripheralPolicyState.ts`); each of the system sites emits a lifecycle type (assert with a unit test that reads their literal `type:` values and passes them through `isLifecycleCommand`).
- [ ] Full API suite, lint, PR `feat(trust): dispatch chokepoints (W03)` with `Closes #<W03>`.

---

## Wave 4 — Sessions, distribution, enrollment

### Task 4.1: `createRemoteSession()` service

**Files:**
- Create: `apps/api/src/services/remoteSessionCreate.ts` (+ test)
- Modify: `apps/api/src/routes/remote/sessions.ts:251`, `apps/api/src/services/aiToolsRemote.ts:384`, `apps/api/src/routes/remote/supportSessions.ts:49`, `apps/api/src/routes/tunnels.ts:391,589,1616`

**Interfaces:**

```ts
export type SessionKind = 'remote' | 'support' | 'tunnel';
export class RemoteSessionDeniedError extends Error { code: TrustDenyCode; reason: string }
export async function createRemoteSession(kind: 'remote', input: { deviceId: string; orgId: string; userId: string; type: 'desktop' | 'terminal' | 'file_transfer' }): Promise<{ id: string; status: string }>;
export async function createRemoteSession(kind: 'support', input: SupportSessionInsert & { partnerId: string }): Promise<SupportSessionRow>;
export async function createRemoteSession(kind: 'tunnel', input: TunnelSessionInsert): Promise<TunnelSessionRow>;
```

Each overload resolves the partner (`partnerIdForDevice(deviceId)` for remote/tunnel; `partnerId` passed for support since no device exists yet), calls `evaluateCapability('remote_control', …)`, throws `RemoteSessionDeniedError` on deny, and otherwise performs the exact insert the call site does today (values copied verbatim from the three sites; support keeps its `runOutsideDbContext(withSystemDbAccessContext(...))` wrapper).

- [ ] **Step 1: Failing tests** — one per kind: deny throws and inserts nothing; allow returns the inserted row; `shadow` inserts and returns.
- [ ] **Step 2: Fail**, **Step 3: Implement**, replacing each inline insert with the call and mapping `RemoteSessionDeniedError` to `c.json(trustDenyBody(...), 403)` in the routes and to a tool error `{ error: 'TRUST_PROBATION', message: 'Remote control is not available until this account is verified.' }` in `aiToolsRemote.ts`.
- [ ] **Step 4: Pass** (`npx vitest run src/routes/remote src/services/aiToolsRemote src/routes/tunnels`), **Step 5: Commit** — `git commit -m "feat(trust): all session inserts go through createRemoteSession"`.

### Task 4.2: Ticket-time re-check

**Files:**
- Modify: `apps/api/src/routes/desktopWs.ts:1276` (`POST /connect/exchange`), `apps/api/src/routes/terminalWs.ts:1114` (WS upgrade), `apps/api/src/routes/tunnels.ts:1061,1121,1189` (tickets, connect-code)
- Test: extend each route's test file

- [ ] **Step 1: Failing tests** — session row exists, partner is `probation` under enforce → exchange/upgrade/ticket returns 403 `TRUST_PROBATION`; `trusted` → unchanged behaviour.
- [ ] **Step 2: Fail**, **Step 3: Implement** — after the session row is loaded in each handler: `const partnerId = await partnerIdForDevice(session.deviceId); const d = partnerId ? await evaluateCapability('remote_control', { partnerId, deviceId: session.deviceId, userId, detail: { stage: 'ticket' } }) : { allow: true }; if (!d.allow) return c.json(trustDenyBody(d, false), 403);` (for the WS upgrade, close with code `4403` and reason `TRUST_PROBATION` instead of JSON).
- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): re-check trust at ticket issuance"`.

### Task 4.3: Third-party remote launch and installer distribution

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:1203-1218` (third-party launch): add `requireCapability('remote_control')` to the route chain.
- Modify: `apps/api/src/routes/enrollmentKeys.ts` — the child-key/installer-link handler that emits `enrollment_key.installer_link_created` (`:2131` region), onboarding-token creation, and the bulk-link creators: add `requireCapability('installer_distribute')`.
- Modify: `apps/api/src/routes/enrollmentKeys.ts:2519` (`GET /public-download/:platform`) and `:2576` (short-link redirect): these are unauthenticated; after resolving the key, resolve `partnerId` via the key's org (`organizations.partnerId`) and call `evaluateCapability('installer_distribute', { partnerId, orgId, detail: { route: 'public-download' } })`; on deny respond `404` (never reveal the gate to an anonymous downloader) and audit as usual.
- Modify: `apps/api/src/routes/remote/supportSessions.ts:52` (Quick Support create): covered by Task 4.1 (`support` kind); `apps/api/src/routes/supportPublic.ts:319-369` (anonymous download) and `:445-551` (code redemption): same anonymous pattern as public download, deny → 404.
- Test: extend `enrollmentKeys.test.ts`, `supportPublic.test.ts`, `devices/core.test.ts`.

- [ ] **Step 1: Failing tests** for each: probation → 403 (authenticated) or 404 (anonymous) and an audit row with `capability: 'installer_distribute'`; trusted → unchanged.
- [ ] **Step 2: Fail**, **Step 3: Implement**, **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): gate installer distribution, Quick Support, third-party launch"`.

### Task 4.4: Enrollment counter in the enrollment transaction

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts:694-861`
- Test: extend `enrollment.test.ts`; add integration test `apps/api/src/__tests__/integration/partnerTrustEnrollment.integration.test.ts`

- [ ] **Step 1: Failing tests**

Unit: with mode `enforce`, a partner row `{ trustState: 'probation', probationEnrollments: 5 }` → `POST /enroll` returns 403 `{ error: 'TRUST_PROBATION', capability: 'agent_enroll', reason: 'probation_enrollment_cap' }` and no device insert; with `4` → device inserted and the update sets `probationEnrollments = 5`.

Integration (real Postgres, in the `integration-test` job): create a probation partner, fire 8 concurrent `POST /enroll` requests with distinct agent ids, assert exactly 5 devices exist and `probation_enrollments = 5`; delete two devices, enroll again, assert still denied.

- [ ] **Step 2: Fail**, **Step 3: Implement** — inside the existing `db.transaction(async (tx) => { … })` at line 694, before the device-cap count:

```ts
    const [trustRow] = await tx.select({ trustState: partners.trustState, probationEnrollments: partners.probationEnrollments })
      .from(partners).where(eq(partners.id, deviceLimitPartnerId)).for('update');
    if (trustRow && partnerTrustMode() !== 'off' && trustRow.trustState !== 'trusted') {
      const d = await evaluateCapability('agent_enroll', { partnerId: deviceLimitPartnerId, orgId: key.orgId, detail: { probationEnrollments: trustRow.probationEnrollments } });
      if (!d.allow) { writeAuditEvent(c, { orgId: key.orgId, action: 'agent.enroll', result: 'denied', details: { reason: d.reason } }); throw new HTTPException(403, { message: JSON.stringify(trustDenyBody(d, false)) }); }
      await tx.update(partners).set({ probationEnrollments: sql`${partners.probationEnrollments} + 1` }).where(eq(partners.id, deviceLimitPartnerId));
    }
```

`evaluateCapability` reads through the repo's own system context, not `tx`; the `FOR UPDATE` on `tx` is what serialises concurrent enrollments, and the counter read for the decision must come from `trustRow` (pass it via `detail` and have `decide()` prefer `ctx.detail.probationEnrollments` when present, so the locked value is the one compared). Also enqueue `ip-classify` for the new device's `enrollmentIp` (Wave 5 defines the job; until then, no-op if the queue is absent).

- [ ] **Step 4: Pass** (unit locally; integration against the local DB with `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/partnerTrustEnrollment`), **Step 5: Commit** — `git commit -m "feat(trust): lifetime probation enrollment counter, locked in the enrollment tx"`.

### Task 4.5: Wave 4 PR

- [ ] Integration suites (RLS coverage, export policy, the new enrollment test) + full API suite + lint. PR `feat(trust): session, distribution and enrollment gates (W04)` with `Closes #<W04>`.

---

## Wave 5 — Promotion, IP classification, admin routes, evidence card

### Task 5.1: IP classification job

**Files:**
- Create: `apps/api/src/services/ipClassify.ts` (+ test), `apps/api/src/jobs/partnerTrustJobs.ts`
- Modify: `apps/api/src/config/env.ts` (`IP_CLASSIFY_PROVIDER = ipinfo | ipdata | none`, `IP_CLASSIFY_API_KEY`), `apps/api/src/jobs/scheduleRegistry.ts` (`'partner-trust-promote': '*/15 * * * *'`, and `'abuse-signals-sweep'` from `'22 * * * *'` to `'22,37,52,7 * * * *'` per spec §3.7), `apps/api/src/routes/auth/register.ts` (enqueue for signup IP), `apps/api/src/routes/agents/enrollment.ts` (enqueue for enrollment IP)

**Interfaces:**

```ts
export type IpClassification = { ipClass: IpClass; asn: number | null; provider: string };
export async function classifyIp(ip: string): Promise<IpClassification>; // Redis cache per /24 or /48, 7 d; provider 'none' → static hostingPrefixes fallback; any error → { ipClass: 'unknown', asn: null }
export async function enqueueIpClassify(target: { kind: 'partner'; partnerId: string; ip: string } | { kind: 'device'; deviceId: string; ip: string }): Promise<void>;
```

- [ ] **Step 1: Failing tests** — with `IP_CLASSIFY_PROVIDER` and `IP_CLASSIFY_API_KEY` both unset, `classifyIp()` returns the static-prefix fallback result without any network call and without throwing, and `validateConfig()` (or the API's boot-time env check) still passes; with provider set but key missing → same fallback plus one `console.warn`; provider response mapping (`privacy.hosting → hosting`, `privacy.vpn → vpn`, `privacy.tor → tor`, neither → `residential`, `company.type === 'business'` → `business`); cache hit skips the HTTP call; provider error → `unknown`; job handler writes `signup_ip_class` / `enrollment_ip_class` + asn + `classified_at`.
- [ ] **Step 2: Fail**, **Step 3: Implement** with `fetch`, a 3 s timeout, and the Redis key `ipclass:v1:<prefix>`; the BullMQ worker lives in `partnerTrustJobs.ts` on the existing `abuse-signals` queue (job name `ip-classify`), following `abuseSignalsSweep.ts`'s registration pattern, gated by `partnerTrustMode() !== 'off'`.
- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): async IP classification job"`.

### Task 5.2: Promotion evaluator and job

**Files:**
- Create: `apps/api/src/services/partnerTrustPromotion.ts` (+ test)
- Modify: `apps/api/src/services/partnerTrust.ts` (call `tryAutoPromote` on deny), `apps/api/src/jobs/partnerTrustJobs.ts` (job `partner-trust-promote`, every 15 min)

**Interfaces:**

```ts
export interface PromotionFacts { createdAt: Date; emailVerified: boolean; settledCard: { chargeId: string; settledAt: Date } | null; signupIpClass: IpClass; deviceIpClasses: IpClass[]; unresolvedAlerts: number; billingHold: boolean }
export function promotionDecision(facts: PromotionFacts, now: Date): { promote: true; reason: 'auto:settled_card_24h' } | { promote: false; blockers: string[] };
export async function gatherPromotionFacts(partnerId: string): Promise<PromotionFacts>; // billing_events via breezeBillingClient, partner + devices + partner_abuse_signals in system ctx
export async function tryAutoPromote(partnerId: string): Promise<boolean>;
```

- [ ] **Step 1: Failing tests** — table-driven over `promotionDecision`: link charge → blocker `card_not_settled`; charge 23 h old → blocker; refunded/disputed → blocker; signup class `hosting` → blocker `signup_ip_hosting`; `unknown` → blocker `signup_ip_unclassified`; device on `hosting` → not a blocker; device on `tor` → blocker; unresolved alert → blocker; all clear → promote. `tryAutoPromote` calls `setTrustState(partnerId, 'trusted', 'auto:settled_card_24h', null, facts)` only when `promote` and current state is `probation` (never `restricted`).
- [ ] **Step 2: Fail**, **Step 3: Implement**. In `evaluateCapability`, on a `probation` denial call `void tryAutoPromote(ctx.partnerId)` after the audit write (fire-and-forget; the current request still denies, the next one passes). `breezeBillingClient` gains `getSettledCardCharge(partnerId)` reading `billing_events` for the partner's customer: newest `charge.succeeded` with `payment_method_details.type === 'card'`, `billing_details.name` non-empty, `payment_method_details.card.three_d_secure?.authenticated !== false`, no later `charge.refunded`/`charge.dispute.created` for the same charge.
- [ ] **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): auto-promotion on settled 3DS card, lazy + 15-min job"`.

### Task 5.3: Hard-deny rules

**Files:**
- Modify: `apps/api/src/services/partnerTrustPromotion.ts` — `export async function evaluateHardDenies(partnerId: string): Promise<{ restrict: true; reason: string; evidence: Record<string, unknown> } | { restrict: false }>`, run by the `ip-classify` job after it writes a class and by the 15-min job.
- Test: extend the promotion test.

Rules (each must hold in full):
1. `signup_ip_class = 'tor'` → `auto:tor_signup`.
2. Stripe: `billing_card_fingerprint` matches a partner suspended for abuse (same region, `partners.status='suspended'` with a `partner.suspended_for_abuse` audit row), or the customer's email matches a `fraudulent`-refund customer (via `breezeBillingClient.hasFraudulentRefundMatch(partnerId)`) → `auto:fraud_identity_match`.
3. Signup or enrollment IP within /24 (v4) or /64 (v6) of a suspended-for-abuse partner's signup or enrollment IP in the last 90 days **and** one of: same email domain, same `billing_card_fingerprint`, same `signup_user_agent` and a device hostname prefix shared with the suspended partner's devices → `auto:corroborated_suspended_network`.

- [ ] **Step 1: Failing tests** — IP match alone → no restrict; IP match + same email domain → restrict with evidence naming both axes; tor → restrict; a `restricted` partner is never auto-promoted.
- [ ] **Step 2: Fail**, **Step 3: Implement** (SQL over `partners`, `devices`, `audit_logs` filtered by `action = 'partner.suspended_for_abuse'` and `timestamp >= now() - interval '90 days'`; use `inet` prefix arithmetic via `set_masklen(host(ip)::inet, 24)`), **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): corroborated hard-deny rules"`.

### Task 5.4: Admin routes and partner review request

**Files:**
- Create: `apps/api/src/routes/admin/trust.ts` (+ test), `apps/api/src/routes/partnerTrust.ts` (+ test)
- Modify: `apps/api/src/routes/admin/index.ts` (mount under the existing `platformAdminMiddleware`), main router (mount `partnerTrustRoutes` at `/partner/trust`)

Routes:
- `POST /admin/partners/:id/trust/promote` and `/restrict`, `requireMfa()`, body `{ reason: string (min 8) }` → `setTrustState(id, 'trusted' | 'restricted', 'admin:' + verb, auth.user.id, { reason })`; 404 unknown partner; 409 if promote on `restricted` without `{ override: true }`.
- `GET /admin/trust/queue` → `partners WHERE trust_state <> 'trusted'` with the evidence card (Task 5.5) per row, newest denial first, `limit`/`cursor`.
- `POST /partner/trust/request-review` (partner scope, `requireScope('partner')`): sets `trust_review_requested_at` if null or older than 24 h, emails the ops card, returns `{ requested: true }`; 429 otherwise.
- `GET /partner/trust` → `{ trustState, checklist: { ageOk, emailVerified, cardSettled, signupIpOk }, reviewRequestedAt }` for the banner.

- [ ] **Step 1: Failing route tests** (follow `routes/admin/abuse.test.ts`'s mocking), **Step 2: Fail**, **Step 3: Implement**, **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): admin promote/restrict/queue, partner review request"`.

### Task 5.5: Evidence card email with TOTP-guarded action links

**Files:**
- Create: `apps/api/src/services/partnerTrustEvidenceCard.ts` (+ test), `apps/api/src/routes/admin/trustAct.ts` (+ test)
- Modify: `apps/api/src/services/opsAlerts.ts` (reuse `sendOpsAlert` for delivery; HTML body support if absent)

**Interfaces:**

```ts
export async function buildEvidenceCard(partnerId: string): Promise<EvidenceCard>; // partner, plan, signup ip/class/asn, email domain age + MX (dns.promises.resolveMx, 2 s timeout), cardholder vs user name, distinct PMs + failures, devices[{hostname, enrollmentIpClass, isVirtual}], denials24h, matchedSuspendedAxes[]
export function mintTrustActionToken(partnerId: string, action: 'approve' | 'suspend', operatorUserId: string): string; // HMAC-signed, 24 h, single-use via Redis key trustact:<jti>
export async function sendEvidenceCard(partnerId: string, trigger: 'probation_watch' | 'review_requested' | 'restricted'): Promise<void>;
```

Action flow: `GET /admin/trust/act?token=…` renders a minimal page (server-rendered HTML from the API, no web build dependency) showing the card summary and a TOTP field; `POST /admin/trust/act` with `{ token, totp }` verifies the token (signature, expiry, unused, `operatorUserId` matches the authenticated platform admin), verifies the code with `consumeMFAToken(secret, totp, userId)` (`services/mfa.ts:38`), marks the jti used, then calls `setTrustState(..., 'trusted', 'admin:approve_link', userId)` or the existing suspend-for-abuse service function with reason `'trust_card_link'`. The token alone never acts.

- [ ] **Step 1: Failing tests** — token round-trip; expired/used/mismatched-operator → 403; wrong TOTP → 403 and token still unused; correct TOTP → state change + token consumed; card builder fields for a fixture partner.
- [ ] **Step 2: Fail**, **Step 3: Implement**, **Step 4: Pass**, **Step 5: Commit** — `git commit -m "feat(trust): evidence card email with TOTP-guarded approve/suspend links"`.

### Task 5.6: Wave 5 PR

- [ ] Full API suite, lint, PR `feat(trust): promotion, classification, admin surface (W05)` with `Closes #<W05>`. PR body lists the two new env vars (`IP_CLASSIFY_PROVIDER`, `IP_CLASSIFY_API_KEY`) and the compose `environment:` mapping they need on the droplets.

---

## Wave 6 — Web client

### Task 6.1: Trust deny handling in `runAction` and the banner

**Files:**
- Create: `apps/web/src/lib/trustProbation.ts`, `apps/web/src/components/trust/TrustProbationBanner.tsx` (+ tests)
- Modify: `apps/web/src/lib/runAction.ts:4-14` (recognise `TRUST_PROBATION | TRUST_RESTRICTED` bodies and dispatch a `trust-denied` window event instead of the generic toast)

- [ ] **Step 1: Failing tests** — `runAction` receiving a 403 with `error: 'TRUST_PROBATION'` dispatches `CustomEvent('breeze:trust-denied', { detail: body })` and shows no toast; the banner renders capability copy, the checklist from `GET /partner/trust`, and the Request review button which calls `POST /partner/trust/request-review` via `runAction` and flips to "Review requested".
- [ ] **Step 2: Fail**, **Step 3: Implement**. Copy (no mechanism details): title "Verification pending", body "Remote control and script execution unlock after your first card payment settles (about 24 hours) or once we've reviewed your account.", button "Request review", secondary link "Book a call" using `meetingUrl` when present.
- [ ] **Step 4: Pass** (`cd apps/web && npx vitest run src/lib/runAction src/components/trust`), **Step 5: Commit**.

### Task 6.2: Onboarding copy and the `no-silent-mutations` guard

- [ ] Add one sentence to the post-signup onboarding screen naming what unlocks after payment or review. Run `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` to confirm the new handlers are covered. Commit, PR `feat(trust): probation banner and review request (W06)` with `Closes #<W06>`.

---

## Wave 7 — Rollout: shadow acceptance, enforce, backfill, admin page, smoke

### Task 7.1: Shadow acceptance query and smoke assertions

**Files:**
- Create: `apps/api/scripts/partner-trust-shadow-report.sql` — counts `partner.trust.capability_denied` audit rows with `details->>'mode' = 'shadow'` per partner over 7 days joined to `partners.status` and `created_at`, so the acceptance rule in the spec (§5 step 3) is one query.
- Modify: `.github/workflows/guided-setup-smoke.yml` — after the stack boots (self-hosted, `IS_HOSTED=false`), assert `POST /remote/sessions` for the seeded device returns 200/400 (device offline) and never 403 `TRUST_*`.
- Test: `apps/api/src/config/partnerTrustMode.test.ts` already pins the self-hosted `off`.

- [ ] Commit `chore(trust): shadow report + self-hosted smoke assertion`.

### Task 7.2: Backfill batch

**Files:**
- Create: `apps/api/scripts/partner-trust-backfill.sql`

```sql
-- Run manually per region as doadmin after PARTNER_TRUST_MODE=enforce is live.
-- Dry run first: replace COMMIT with ROLLBACK.
BEGIN;
SET LOCAL breeze.scope = 'system';
CREATE TEMP TABLE bf AS
SELECT p.id FROM partners p
WHERE p.status = 'active' AND p.trust_state = 'trusted'
  AND p.created_at >= now() - interval '14 days'
  AND NOT EXISTS (SELECT 1 FROM billing_settled_card_view v WHERE v.partner_id = p.id); -- view created in W05 over billing events
UPDATE partners SET trust_state = 'probation', trust_reason = 'backfill:2026-09', trust_changed_at = now() WHERE id IN (SELECT id FROM bf);
INSERT INTO audit_logs (...) SELECT ... 'partner.trust.probation' ... FROM bf; -- same columns createAuditLog writes
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM bf; RAISE WARNING 'partner-trust backfill moved % partners to probation', n; END $$;
COMMIT;
```

then `POST /admin/trust/queue` is read once and `sendEvidenceCard(id, 'probation_watch')` is fired for each row via a one-off script `apps/api/scripts/partner-trust-backfill-cards.ts`. The `breeze.scope = 'system'` line is mandatory on managed Postgres (a backfill without it is a silent 0-row no-op as `doadmin`).

- [ ] Commit; execution is an operator step recorded in the wave's PR body, not CI.

### Task 7.3: Admin trust-queue page

**Files:**
- Create: `apps/web/src/pages/admin/trust-queue.astro`, `apps/web/src/components/admin/TrustQueue.tsx` (+ test)

- [ ] Table of `GET /admin/trust/queue` rows with the evidence card expanded inline, Approve / Restrict / Suspend buttons through `runAction` (each prompts for the reason; MFA step-up is enforced by the API's `requireMfa()`). Note in the PR that production has zero platform admins and the operator account needs `is_platform_admin = true` before the page is usable.
- [ ] Commit, PR `feat(trust): rollout tooling and admin queue (W07)` with `Closes #<W07>`.

### Task 7.4: Flip and record

- [ ] After 7 days of shadow with the acceptance query clean: set `PARTNER_TRUST_MODE=enforce` in `/opt/breeze/.env` on both droplets and map it in the `api` service `environment:` block; `docker compose up -d api`; run the backfill; verify `SELECT trust_state, count(*) FROM partners GROUP BY 1` per region; update `docs/superpowers/specs/security-auth/2026-09-02-partner-trust-probation-design.md` status line to "Enforced <date>".

---

## Self-review

- **Spec coverage.** §3.1 → 2.1; §3.2 (chokepoints, allowlist, deny contract, ticket re-check, installer/Quick Support/third-party launch, enrollment counter) → 2.3, 3.1–3.4, 4.1–4.4; §3.3 → 5.2, 5.4; §3.4 → 5.1, 5.3; §3.5 → 1.1; §3.6 → 5.5, 7.3; §3.7 (denials as audit events, sweep cadence) → 2.3 and a one-line `scheduleRegistry.ts` change in 5.1 (`'abuse-signals-sweep': '*/15 * * * *'`), add it to Task 5.1's Modify list; §4 → 6.1, 6.2; §5 → 2.2, 7.1, 7.2, 7.4; §6/§7 covered by the tests in each task; §9 decisions: default deny (2.3), cap 5 (2.3, 4.4), 3DS (1.1), backfill (7.2), TOTP links (5.5); self-hosted safeguard (2.2, 7.1).
- **Placeholder scan.** Task 4.x "extend each route's test file" steps name the assertion and the fixture state; Task 5.x interfaces are typed. The one deliberate open item is the `CreateAuditLogParams` field names in 2.3, which the implementer confirms against `auditService.ts` at typecheck.
- **Type consistency.** `GateDecision`, `GatedCapability`, `TrustDenyCode`, `trustDenyBody`, `evaluateCapability`, `isLifecycleCommand`, `partnerIdForDevice`, `setTrustState`, `TrustDeniedError`, `assertDeviceExecuteAllowed`, `createRemoteSession`, `RemoteSessionDeniedError`, `PROBATION_ENROLLMENT_CAP` are used with the same names and signatures across waves.
