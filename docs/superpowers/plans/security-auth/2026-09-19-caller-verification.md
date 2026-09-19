# Caller Verification (anti-vishing) — Plan Index

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md`
(v5, 2026-09-19; four Codex xhigh review passes folded in, last pass raised no
new blockers).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-caller-verification/wave-<sub-issue#>` with `Closes #<sub-issue#>`
in the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the
source of truth for status, never this index.

| Wave | Plan | Depends on | Ships |
|---|---|---|---|
| W01 | [Tables, registrations, bindings, destinations, policy, service, gate, API](2026-09-19-caller-verification-w01-backend-core.md) | — | backend end to end on `callback_attestation`; flag off |
| W02 | [Agent `caller_verify`, helper capability + window, shared result handler, workstation deliverer](2026-09-19-caller-verification-w02-workstation.md) | W01 | agent + helper release |
| W03 | [SMS/email deliverers, public `/verify/:token`, Astro card, rate limits, `m365.user.mailboxes`](2026-09-19-caller-verification-w03-links-and-public.md) | W01 | — |
| W04 | [Web: modal, entry points, badge, contact drawer, policy forms, admin flow, AI refusal render, i18n](2026-09-19-caller-verification-w04-web.md) | W01 (W02/W03 for full method list) | all behind the flag |
| W05 | [Tenant+OID pinning, gate wiring in release + 3 backends, admin route, rejection fan-out, refusal adapters, flag on](2026-09-19-caller-verification-w05-enforcement.md) | W01–W04 | **flag flipped on** |

W02 and W03 run in parallel after W01. W04 can start after W01 and stub the
method list; it merges after W02/W03. W05 lands last.

## Migration slots reserved

Newest committed migration on 2026-09-19: `2026-10-15-160010-backup-snapshots-layout-manifest.sql`.
Billing (#5573) reserved `2026-10-15-1700xx`. This feature uses `2026-10-15-1800xx`.

| File | Wave | DML? |
|---|---|---|
| `2026-10-15-180000-caller-verification-tables.sql` | W01 | no (bindings, destinations, verifications, enums, RLS, indexes) |
| `2026-10-15-180100-caller-verification-policies.sql` | W01 | no (dual-axis table, XOR check, FOR ALL + SELECT-only partner branch) |
| `2026-10-15-180200-caller-verification-destinations-backfill.sql` | W01 | **yes** — `SELECT set_config('breeze.scope','system',true);` first; one row per current `contacts.email` / `contacts.mobile`, `source='import'`, `set_at = contacts.updated_at`; `RAISE WARNING` row count |
| `2026-10-15-180300-action-intents-caller-target.sql` | W05 | no (`target_entra_tenant_id`, `target_entra_oid`, `target_connection_ref`, `dispatch_started_at` on `action_intents`) |

Every executor re-checks `ls apps/api/migrations | sort | tail -1` before
committing and renames upward if main has moved past these names. Adding
columns to `action_intents` (W05) updates its `CORE_TENANT_EXPORT_POLICY`
entry (all four `included`).

## Cross-wave contract (defined in W01, consumed verbatim by W02–W05)

### Tables and Drizzle exports (`apps/api/src/db/schema/callerVerification.ts`)

- `callerVerifications` → `caller_verifications`
- `callerVerificationSubjectBindings` → `caller_verification_subject_bindings`
- `callerVerificationDestinations` → `caller_verification_destinations`
- `callerVerificationPolicies` → `caller_verification_policies`
- enums: `callerVerificationMethodEnum` (`workstation | sms | email | callback_attestation | administrative_stepup`),
  `callerVerificationStatusEnum` (`pending | verified | rejected_by_user | wrong_choice | expired | undeliverable | cancelled | revoked`),
  `callerVerificationActionScopeEnum` (`reset_password | disable_user | any`),
  `callerVerificationBindingSourceEnum` (`directory_sync | technician_attested | observed_login`),
  `callerVerificationDestinationKindEnum` (`email | mobile`),
  `callerVerificationDestinationSourceEnum` (`technician | import | inbound_email | ai_tool | portal_self_service`)

Snapshot columns that must **not** be named `device_id` / `ticket_id`:
`workstation_device_ref`, `ticket_ref`, `consumed_intent_ref`.

### Service module `apps/api/src/services/callerVerification/`

```ts
// index.ts re-exports everything below.

// errors.ts
export type CallerVerificationRefusal =
  | 'no_fresh_verification' | 'grant_consumed' | 'subject_unmatched' | 'subject_ambiguous'
  | 'subject_mailboxes_unknown' | 'tenant_mismatch' | 'contact_fenced' | 'requester_not_authorized'
  | 'technician_mismatch' | 'target_rebound' | 'stepup_invalidated' | 'administrative_disabled'
  | 'feature_disabled';
export class CallerVerificationRequiredError extends Error {
  constructor(public readonly payload: {
    orgId: string; contactId: string | null; action: CallerVerificationAction;
    requiredTier: number; reason: CallerVerificationRefusal;
    latest: { id: string; status: CallerVerificationStatus; method: CallerVerificationMethod; decidedAt: string | null } | null;
  });
}
export class CallerVerificationValidationError extends Error { constructor(public readonly code: string, message: string); }

// types.ts
export type CallerVerificationAction = 'reset_password' | 'disable_user';
export type CallerVerificationActionScope = CallerVerificationAction | 'any';
export type CallerVerificationMethod = 'workstation' | 'sms' | 'email' | 'callback_attestation' | 'administrative_stepup';
export type CallerVerificationStatus = 'pending' | 'verified' | 'rejected_by_user' | 'wrong_choice' | 'expired' | 'undeliverable' | 'cancelled' | 'revoked';
export interface EntraSubject { entraTenantId: string; entraOid: string }
export interface CallerVerificationActor { userId: string; partnerId: string | null; scope: 'partner' | 'organization'; accessibleOrgIds: string[] | null; allowedSiteIds: string[] | null; displayName: string }

// policy.ts
export interface EffectiveCallerVerificationPolicy {
  requiredTierResetPassword: number; requiredTierDisableUser: number;
  disableUserAuthorizerRoles: string[]; verificationTtlMinutes: number;
  allowedMethods: Array<'workstation' | 'sms' | 'email' | 'callback_attestation'>;
  workstationTimeoutSeconds: number; destinationMinAgeDays: number;
  requireAttestedDestination: boolean; requireTicket: boolean;
  allowCrossTechnicianUse: boolean; allowAdministrativeDisable: boolean;
  maxAttemptsPerHour: number; coolingOffHours: number;
  provenance: Record<string, 'default' | 'partner' | 'org'>; ignored: string[];
}
export const CALLER_VERIFICATION_POLICY_DEFAULTS: Omit<EffectiveCallerVerificationPolicy, 'provenance' | 'ignored'>;
export function resolveEffectivePolicy(partnerRow: PolicyRow | null, orgRow: PolicyRow | null): EffectiveCallerVerificationPolicy; // pure
export async function getEffectivePolicy(orgId: string): Promise<EffectiveCallerVerificationPolicy>;

// subjects.ts
export async function resolveTargetBinding(orgId: string, subject: EntraSubject): Promise<BindingRow>; // throws CallerVerificationRequiredError subject_unmatched | subject_ambiguous
export async function bindingsForContact(orgId: string, contactId: string): Promise<BindingRow[]>;
export async function upsertDirectorySyncBinding(input: { orgId: string; contactId: string; entraTenantId: string; entraOid: string; upn: string | null }): Promise<void>;
export async function attestBinding(actor: CallerVerificationActor, input: { orgId: string; contactId: string; entraTenantId: string; entraOid: string; upn: string | null }): Promise<BindingRow>;
export async function observeLogin(input: { orgId: string; contactId: string; osPrincipal: string; osUsername: string; upn: string | null }): Promise<void>;
export async function revokeBinding(actor: CallerVerificationActor, orgId: string, bindingId: string): Promise<void>;

// destinations.ts
export async function recordDestinationChange(input: { orgId: string; contactId: string; kind: 'email' | 'mobile'; value: string | null; source: DestinationSource; userId: string | null }): Promise<void>;
export async function currentDestination(orgId: string, contactId: string, kind: 'email' | 'mobile'): Promise<DestinationRow | null>;
export function isEstablished(row: DestinationRow, policy: EffectiveCallerVerificationPolicy, now?: Date): boolean; // pure
export async function attestDestination(actor: CallerVerificationActor, orgId: string, destinationId: string): Promise<DestinationRow>;

// tiers.ts (pure)
export function computeTier(input: { method: CallerVerificationMethod; boundPrincipal: boolean; destinationEstablished: boolean; policy: EffectiveCallerVerificationPolicy }): { tier: 0 | 1 | 2 | 3; reason: 'bound_principal' | 'unbound_principal' | 'destination_established' | 'destination_recent' | 'attestation' | 'administrative' | 'method_disabled' };

// service.ts
export interface StartInput { orgId: string; contactId: string; targetContactId?: string; method: Exclude<CallerVerificationMethod, 'administrative_stepup'>; actionScope: CallerVerificationActionScope; deviceId?: string; username?: string; ticketId?: string; note?: string }
export async function start(actor: CallerVerificationActor, input: StartInput): Promise<VerificationView>;               // 202 semantics; delivery via outbox after commit
export async function createAdministrative(actor: CallerVerificationActor, input: { orgId: string; targetContactId: string; reason: string; stepUpGrantId: string }): Promise<VerificationView>;
export async function cancel(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationView>;
export async function attest(actor: CallerVerificationActor, orgId: string, id: string, note: string): Promise<VerificationView>; // callback_attestation only
export async function get(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationView>;
export async function listForContact(actor: CallerVerificationActor, orgId: string, contactId: string): Promise<{ rows: VerificationView[]; fencedUntil: string | null }>;
export async function methodsForContact(actor: CallerVerificationActor, orgId: string, contactId: string, actionScope: CallerVerificationActionScope): Promise<MethodAvailability[]>;
export async function freshForTicket(actor: CallerVerificationActor, orgId: string, ticketId: string): Promise<{ row: VerificationView | null; isFresh: boolean; isConsumed: boolean }>;
export async function applyDecision(input: { verificationId: string; decision: { kind: 'choice'; value: string } | { kind: 'not_me' } | { kind: 'timeout' } | { kind: 'undeliverable'; reason: string }; principal?: { osPrincipal: string; osUsername: string; upn: string | null }; fromIp?: string }): Promise<VerificationView>; // used by W02 handler and W03 public route; not_me legal from any non-rejected state
export interface VerificationView { id: string; orgId: string; contactId: string; targetContactId: string | null; method: CallerVerificationMethod; status: CallerVerificationStatus; tier: number; tierReason: string; actionScope: CallerVerificationActionScope; targetLabel: string | null; technicianLabel: string; initiatedByUserId: string; expiresAt: string; decidedAt: string | null; consumedAt: string | null; ticketRef: string | null; ticketNumber: string | null; destinationRedacted: string | null; deviceHostname: string | null; osUsername: string | null; createdAt: string; secrets?: { matchValue: string; decoyValues: string[]; reverseCode: string } /* initiator only */ }
export interface MethodAvailability { method: CallerVerificationMethod; available: boolean; tier: number; reason: string; unavailableReason?: 'method_disabled' | 'no_destination' | 'helper_outdated' | 'no_binding' | 'administrative_disabled' | 'feature_disabled' }

// gate.ts
export interface GateInput { orgId: string; action: CallerVerificationAction; target: EntraSubject; backendTenantId: string; technicianUserId: string; intentId: string; mode: 'check' | 'consume' }
export async function requireCallerVerification(input: GateInput): Promise<{ verificationId: string; tier: number }>; // throws CallerVerificationRequiredError
export function isCallerVerificationEnabled(): boolean; // env CALLER_VERIFICATION_ENABLED === 'true'

// rejection.ts
export async function handleRejection(verificationId: string): Promise<void>; // idempotent; fence → incident → revoke grants → revokeIntentsForSubject → audit → notify
export async function fenceOverride(actor: CallerVerificationActor, orgId: string, contactId: string, reason: string): Promise<void>;

// locks.ts
export async function withSubjectLocks<T>(tx: Tx, bindingIds: Array<string | null>, fn: () => Promise<T>): Promise<T>; // pg_advisory_xact_lock(hashtext(id)) ascending, dedup, nulls skipped
```

### Action intents additions (W05 defines, W01 stubs the import)

```ts
// apps/api/src/services/actionIntents/revokeIntentsForSubject.ts
export async function revokeIntentsForSubject(input: { orgId: string; bindingIds: string[]; verificationId: string }): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }>; // system-scoped
```

### Agent / helper (W02)

- Device command type: `caller_verify` (added to `partnerTrust.ts` capability allowlist beside `notify_user`, to the HTTP result handler registry in `routes/agents/commands.ts`, and to `services/commandResultHandlers.ts`).
- Command payload: `{ verificationId, username, technicianName, orgName, actionLabel, targetLabel, reverseCode, choices: [string, string, string], timeoutMs }`.
- Result stdout JSON: `{ delivered: boolean, choice?: string | 'not_me' | 'timeout', principal?: { sid?: string; uid?: number; username: string; upn?: string }, helperVersion?: string, error?: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' }`.
- IPC message type `caller_verify_request` / `caller_verify_response`; helper `Capabilities.callerVerify: boolean` (`agent/internal/ipc/message.go` `Capabilities` struct gains `CallerVerify bool \`json:"callerVerify"\``).

### Public route (W03)

- `GET /verify/:token`, `POST /verify/:token` in `apps/api/src/routes/callerVerifyPublic.ts`, mounted unauthenticated like `supportPublic.ts`.
- Link token: 32 random bytes, base64url; stored as `sha256` hex in `challenge_token_hash`.

### Web (W04)

- API client `apps/web/src/lib/api/callerVerification.ts`; i18n namespace `callerVerification.json` in all 8 locales.
- Components under `apps/web/src/components/callerVerification/`.

### Permissions and gates (all waves)

- Authenticated routes: `ORGS_READ` to view, `ORGS_WRITE` + MFA to mutate (mirrors `routes/orgContacts.ts` ruling), plus contact site reach through the same helper `orgContacts.ts` uses.
- Partner policy row writes: `canManagePartnerWidePolicies(auth)`.
- Readiness flag `CALLER_VERIFICATION_ENABLED` read through `apps/api/src/config` (default `false`); when false every authenticated route returns 404 and every web entry point is hidden.
