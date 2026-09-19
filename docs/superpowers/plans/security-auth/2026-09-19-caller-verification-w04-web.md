# Caller Verification W04: Technician Web Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let technicians verify a caller from tickets, contacts, devices, and structured AI refusals; inspect single-use grants, bindings, destinations and fences; manage partner/org policy; and obtain an administrative-disable grant through interactive MFA. Every surface remains hidden until the server enables enforcement.

**Architecture:** One typed, `runAction`-backed client owns transport. A runtime readiness hook gates mounting, including data fetching. A reusable modal separates requester/action selection, server-computed method availability, and challenge monitoring. Ticket badges use server freshness, not the challenge expiry. Contacts gain a verification drawer alongside their existing inline editor. Policy forms consume the server baseline, effective provenance and ignored overrides. Administrative step-up reuses the existing ceremony with an injectable mutation transport. AI errors offer an inline verification workflow without replaying an action.

**Tech Stack:** Astro + React islands, TypeScript, Zustand, react-i18next, existing Dialog/Drawer primitives, Vitest + Testing Library, Hono API contracts supplied by W01–W03 and W05.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md` v5: D2, D4, D6, D11–D16; “Tiers and the establishment rule,” “Administrative disable,” authenticated “API,” “Web UI,” web “Testing,” W04, and all Review notes explaining those contracts. Cross-wave authority: `docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md`, especially its exact TypeScript interfaces and permission gates.

## Global Constraints

- Execution of this document is future product work. The authoring request creates only this plan; it does not execute any implementation, test-stack, commit or PR command below.
- W04 depends on W01 and merges after W02/W03. W05 owns the administrative endpoint, step-up operation, enforcement adapters and enabling the flag. Keep `CALLER_VERIFICATION_ENABLED=false` throughout W04. Test responses may enable it; production configuration may not.
- Readiness comes from existing `GET /config` (`apps/api/src/routes/config.ts:19–29`), not a build-time public env variable. W01 must add `features.callerVerification` using its `isCallerVerificationEnabled(): boolean`. No new readiness route is necessary. Missing, false, failed and not-yet-loaded config all hide the feature.
- Preserve index names: `callerVerifications`, `callerVerificationSubjectBindings`, `callerVerificationDestinations`, `callerVerificationPolicies`; SQL tables `caller_verifications`, `caller_verification_subject_bindings`, `caller_verification_destinations`, `caller_verification_policies`. Enum names remain `callerVerificationMethodEnum`, `callerVerificationStatusEnum`, `callerVerificationActionScopeEnum`, `callerVerificationBindingSourceEnum`, `callerVerificationDestinationKindEnum`, `callerVerificationDestinationSourceEnum`.
- W04 creates no tables or migrations. All new tenant tables must have RLS enabled + forced + policies in the creating migration. Composite FKs carrying `org_id` must be `DEFERRABLE INITIALLY IMMEDIATE`. Migrations are idempotent, contain no inner `BEGIN`/`COMMIT`, and DML migrations start with `SELECT set_config('breeze.scope','system',true);`, with recorded DML row counts. Never name a column `device_id`/`ticket_id` on the new tables: correlation uses `workstation_device_ref`, `ticket_ref`, `consumed_intent_ref`.
- Reserved migrations remain `2026-10-15-180000-caller-verification-tables.sql`, `2026-10-15-180100-caller-verification-policies.sql`, `2026-10-15-180200-caller-verification-destinations-backfill.sql` (W01) and `2026-10-15-180300-action-intents-caller-target.sql` (W05). Re-check `ls apps/api/migrations | sort | tail -1` before every commit and rename upward if main overtakes an unshipped migration. That literal command currently prints the `preflight` directory; also use `git ls-files 'apps/api/migrations/*.sql' | sort | tail -1` to inspect actual SQL. Never rename shipped history. Sweep path references after any unshipped rename.
- W01 owns cascade/export/merge/RLS registrations: all four tables in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`; bindings custom merge, verifications/destinations repoint, policies keep-survivor; policy in `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`. Do not weaken those contracts to make a web test pass.
- View permissions are `ORGS_READ`; mutations require `ORGS_WRITE` + MFA and server contact/site reach. Partner writes require `canManagePartnerWidePolicies(auth)`. Browser controls are convenience, never the authorization boundary. Derive partner ownership from the session; never post a selected partner ID.
- Every new web POST/PUT/PATCH/DELETE, including passkey options and grant minting, runs inside `runAction`. Add guarded files to `no-silent-mutations.test.ts`; do not touch `runActionAllowlist.ts` or add exemption markers. Use `handleActionError` so 401 redirects and already-toasted failures are not duplicated.
- `fetchWithAuth` injects `orgId` (`apps/web/src/stores/auth.ts:1298`, `applyOrgId`). For path-scoped calls explicitly include the same org in the request query so a different active global org cannot be injected. API query arguments are transport parameters, not transient page state.
- UI navigation state lives in `window.location.hash`, never query parameters. Use `useHashState` for SSR-safe reads (`apps/web/src/lib/useHashState.ts:47`). Keep match numbers, reverse codes, reasons, factors and grant IDs only in memory, never hashes, storage or logs.
- The index/v5 D4 wins over stale prose saying unbound workstation is tier 2: it is tier 1. `administrative_stepup` is not a challenge method. Never infer binding from a username, contact email, `isPrimary`, or device selection. The server re-evaluates tier at release.
- `expiresAt` is challenge expiry; it is not grant freshness. Use server `usableUntil`, `isFresh`, `isConsumed`. Do not claim “by you” for another technician's row. Late rejection can supersede a previously verified row; keep refreshing visible status.
- Every new string belongs in `callerVerification.json` with real translations in en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR. Namespace registration is automatic (`apps/web/src/lib/i18n/index.ts:20–35`). Update the eight-locale parity and seven translated-locale duplicate-baseline contracts, not their thresholds.
- Branch: `feature/<parent#>-caller-verification/wave-<sub#>`; PR body: `Closes #<sub#>`. These are issue-number metavariables required by the feature index; obtain the actual numbers from the implementation wave issue. Do not invent tracking numbers or register issues during plan authoring.
- Commands below run from repository root unless enclosed in a subshell. API: `cd apps/api && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>`. Integration requires `pnpm test-stack up` / `pnpm test-stack down`. No watch-mode passthrough, wildcard CLI filters, or assumption that unit tests include RLS suites.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/api/callerVerification.ts` | Exact index types, route DTO supplements, all reads/mutations |
| `apps/web/src/lib/api/callerVerification.test.ts` | Method/path/body/org and feedback tests |
| `apps/web/src/stores/featuresStore.ts:6,36,70` | Runtime caller-verification boolean |
| `apps/web/src/lib/useCallerVerificationEnabled.ts` (+ `.test.tsx`) | Fail-closed readiness hook |
| `apps/web/src/components/callerVerification/testFixtures.ts` | Typed deterministic test data |
| `apps/web/src/components/callerVerification/ContactPicker.tsx` (+ `.test.tsx`) | Paged existing org-contact picker pattern |
| `apps/web/src/components/callerVerification/VerifyCallerModal.tsx` (+ `.test.tsx`) | Action/requester/target, method cards, start, retry, cancel |
| `apps/web/src/components/callerVerification/VerificationStatus.tsx` (+ `.test.tsx`) | Codes, script, statuses and incident link |
| `apps/web/src/components/callerVerification/useVerification.ts` (+ `.test.tsx`) | Non-overlapping 2 s polling and race cleanup |
| `apps/web/src/components/callerVerification/CallerVerificationEntry.tsx` (+ `.test.tsx`) | Gated hash-driven launcher shared by page mounts |
| `apps/web/src/components/callerVerification/TicketVerificationBadge.tsx` (+ `.test.tsx`) | Freshness, consumption, age and refresh |
| `apps/web/src/components/tickets/ticketConfig.ts:58` | Existing API requester contact field in web type |
| `apps/web/src/components/tickets/TicketWorkbench.tsx:998,1481` (+ `.test.tsx`) | Header launcher/badge and feed refresh |
| `apps/web/src/components/tickets/TicketFeed.test.tsx:42` | W01 system-comment rendering regression |
| `apps/web/src/components/callerVerification/ContactVerificationDrawer.tsx` (+ `.test.tsx`) | History, fence override, bindings, destinations, admin flow |
| `apps/web/src/components/settings/ContactsCard.tsx:141,614,663` (+ `.test.tsx`) | Contact row and drawer mounts |
| `apps/web/src/components/organizations/record/orgRecordTabs.ts:82` (+ `.test.ts`) | Preserve contacts tab for nested verification hashes |
| `apps/web/src/components/devices/DeviceDetails.tsx:344,666` | Device header launcher with workstation preselection |
| `apps/web/src/components/devices/DeviceDetails.hashNavigation.test.tsx:9` | Device mount and hash regression |
| `apps/web/src/components/callerVerification/CallerVerificationPolicyForm.tsx` (+ `.test.tsx`) | Partner baseline and org tighten-only editor |
| `apps/web/src/components/settings/PartnerSettingsPage.tsx:637` (+ `.test.tsx`) | Partner #security mount |
| `apps/web/src/components/settings/OrgSettingsPage.tsx:606` (+ `.test.tsx`) | Org #security mount |
| `apps/web/src/lib/mfaStepUp.ts:64` (+ `.test.ts`) | Optional POST transport preserving existing ceremony |
| `apps/web/src/components/callerVerification/AdministrativeDisable.tsx` (+ `.test.tsx`) | Reason → existing factor UI → grant |
| `apps/web/src/components/callerVerification/CallerVerificationRefusal.tsx` (+ `.test.tsx`) | Structured AI error guard and inline modal |
| `apps/web/src/components/ai/AiChatMessages.tsx:49,298` (+ `.test.tsx`) | Refusal mount beside existing tool result |
| `apps/web/src/components/callerVerification/wave.contract.test.ts` | Mount, dark-mode and dependency contracts |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:36,540` | Guard new client, ceremony and component files |
| `apps/web/src/locales/en/callerVerification.json` | English catalog |
| `apps/web/src/locales/de-DE/callerVerification.json` | German catalog |
| `apps/web/src/locales/es-419/callerVerification.json` | Latin American Spanish catalog |
| `apps/web/src/locales/fr-CA/callerVerification.json` | Canadian French catalog |
| `apps/web/src/locales/fr-FR/callerVerification.json` | French catalog |
| `apps/web/src/locales/it-IT/callerVerification.json` | Italian catalog |
| `apps/web/src/locales/pt-BR/callerVerification.json` | Brazilian Portuguese catalog |
| `apps/web/src/locales/tr-TR/callerVerification.json` | Turkish catalog |
| `apps/web/src/lib/i18n/translationCoverage.test.ts:15` | Explicit reviewed new namespace baselines |
| `apps/web/src/lib/i18n/callerVerification.test.ts` | New namespace and interpolation parity |

**Required cross-wave additions, not existing code to pretend is present.** No caller-verification API/service implementation exists in this checkout. Sibling plans appeared during authoring: W01 Task 14 uses `{data: ...}` envelopes (including start/get/history/policy), and W05 carries the full index refusal payload inside `requiresCallerVerification`; the client below consumes those actual shapes. The legacy org-contact list remains `{data, pagination}` and is not unwrapped. W01 must expose the additive web projections below in its planned `apps/api/src/routes/callerVerification.ts`, beside the index-defined routes. The index service signatures stay verbatim. W01 also adds the field to existing `routes/config.ts:22`. W05 must extend `routes/auth/schemas.ts:148,179`, `routes/auth/mfa.ts:1209,1344` and `services/mfaStepUpGrant.ts` for the administrative operation. Do not implement these backend responsibilities in this wave or enable its UI before they are delivered.

1. Verification reads/start/cancel/attest/admin return the unchanged `VerificationView` fields plus `remainingAttempts`, `undeliverableReason`, `incidentId`, `usableUntil`, `consumedAction`. Existing `VerificationView` lacks all five, so the UI cannot honestly derive them. The first four are server projections, never values guessed from a 50-row history. W05 supplies incident IDs and the actual consumed action; `actionScope='any'` cannot tell the badge which action consumed it.
2. History adds bindings/destinations with establishment state; policy GET/PUT add built-in `defaults` and the resolved partner `baseline` to own row/effective values. This makes an org's numeric/boolean/set bounds expressible without confusing its own tightening with the partner floor.
3. The spec mentions fence override but omits its route-table row; use `POST /orgs/:orgId/contacts/:contactId/caller-verifications/fence-override` with `{reason}`. Callback `attest` likewise needs `POST /orgs/:orgId/caller-verifications/:id/attest` with `{note}`. These call the index's existing `fenceOverride` / `attest` functions, with normal org/site/MFA checks.
4. No M365 HTTP user-search endpoint exists. The safe existing Graph read is `executeM365ReadAction(auth: AuthContext, action: M365ReadAction, inputOrgId?: string, auditRequest?: RequestLike): Promise<M365ReadActionServiceResult>` (`apps/api/src/services/m365ControlPlane/readActionService.ts:103`). `aiToolsM365.ts:391` uses `{type:'m365.user.list',search,pageSize:25}`; projection fields are in `packages/shared/src/m365/readActions.ts:26`. W01 adds `GET /orgs/:orgId/caller-verification-directory-users?search=` with the DTO below, backed by that read and the same verified `customer-graph-read` connection's tenant. The route reports unavailable without that connection; direct Graph has exact-user lookup only (`m365DirectGraph.ts:226`), and there is no existing three-backend search to reuse. Recheck tenant after the read; do not accept a browser-entered tenant/OID. This route is flag/ORGS_READ/site gated and returns no verifier data.
5. W02 device-suggestions must return per-device `hasBinding` and explicit username. Method availability stays the index shape. The browser may lower an estimate for an unbound selection; it must never raise a server-returned tier.

---

### Task 1: Typed API client and cross-wave projection contract

**Files:** Create `apps/web/src/lib/api/callerVerification.ts`, `apps/web/src/lib/api/callerVerification.test.ts`, `apps/web/src/components/callerVerification/testFixtures.ts`. Modify `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:36,540`.

**Interfaces:** Consumes the index's `VerificationView`, `MethodAvailability`, `EffectiveCallerVerificationPolicy`, `StartInput` shapes, and `fetchWithAuth(path: string, options?: FetchWithAuthOptions): Promise<Response>`. Produces the following exported browser types and client functions; do not import server runtime code into a React bundle.

- [ ] **Step 1: Write the failing transport test.**

```ts
// apps/web/src/lib/api/callerVerification.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { startVerification, cancelVerification, getVerification } from './callerVerification';
import { ORG, CONTACT, row } from '@/components/callerVerification/testFixtures';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetch }));
vi.mock('@/components/shared/Toast', () => ({ showToast: mocks.toast }));
beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: row }))); });
it('starts with the exact body and explicit path org, accepting 202', async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: row }), { status: 202 }));
  await startVerification({ orgId: ORG, contactId: CONTACT, actionScope: 'reset_password', method: 'sms' });
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe(`/orgs/${ORG}/caller-verifications?orgId=${ORG}`);
  expect(JSON.parse(init.body)).toEqual({ contactId: CONTACT, actionScope: 'reset_password', method: 'sms' });
  expect(init.method).toBe('POST');
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});
it('does not turn an HTTP-200 application failure into success', async () => {
  mocks.fetch.mockResolvedValue(new Response('{"success":false,"error":"contact_fenced"}'));
  await expect(cancelVerification(ORG, row.id)).rejects.toMatchObject({ status: 200 });
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});
it('reads the scoped verification with abort support', async () => {
  const signal = new AbortController().signal;
  await getVerification(ORG, row.id, signal);
  expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining(`/caller-verifications/${row.id}?orgId=${ORG}`), expect.objectContaining({ method: 'GET', signal }));
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/lib/api/callerVerification.test.ts` → unresolved new module.
- [ ] **Step 3: Implement the exact types and transport.** The three index interfaces below are unchanged, including nullable target, initiator-only secrets, provenance and ignored fields.

```ts
// apps/web/src/lib/api/callerVerification.ts
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
export type CallerVerificationAction = 'reset_password' | 'disable_user';
export type CallerVerificationActionScope = CallerVerificationAction | 'any';
export type CallerVerificationMethod = 'workstation' | 'sms' | 'email' | 'callback_attestation' | 'administrative_stepup';
export type CallerVerificationStatus = 'pending' | 'verified' | 'rejected_by_user' | 'wrong_choice' | 'expired' | 'undeliverable' | 'cancelled' | 'revoked';
export interface VerificationView { id: string; orgId: string; contactId: string; targetContactId: string | null; method: CallerVerificationMethod; status: CallerVerificationStatus; tier: number; tierReason: string; actionScope: CallerVerificationActionScope; targetLabel: string | null; technicianLabel: string; initiatedByUserId: string; expiresAt: string; decidedAt: string | null; consumedAt: string | null; ticketRef: string | null; ticketNumber: string | null; destinationRedacted: string | null; deviceHostname: string | null; osUsername: string | null; createdAt: string; secrets?: { matchValue: string; decoyValues: string[]; reverseCode: string } }
export interface MethodAvailability { method: CallerVerificationMethod; available: boolean; tier: number; reason: string; unavailableReason?: 'method_disabled' | 'no_destination' | 'helper_outdated' | 'no_binding' | 'administrative_disabled' | 'feature_disabled' }
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
export interface StartInput { orgId: string; contactId: string; targetContactId?: string; method: Exclude<CallerVerificationMethod, 'administrative_stepup'>; actionScope: CallerVerificationActionScope; deviceId?: string; username?: string; ticketId?: string; note?: string }
export type VerificationDetails = VerificationView & {
  remainingAttempts: number | null; usableUntil: string | null;
  incidentId: string | null; consumedAction: CallerVerificationAction | null;
  undeliverableReason: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' | 'sms_failed' | 'email_failed' | null;
};
export interface BindingView { id: string; entraTenantId: string | null; entraOid: string | null; upnSnapshot: string | null; osPrincipal: string | null; revokedAt: string | null }
export interface DestinationView { id: string; kind: 'email' | 'mobile'; valueRedacted: string; established: boolean; attestedAt: string | null; setAt: string; source: 'technician' | 'import' | 'inbound_email' | 'ai_tool' | 'portal_self_service' }
export interface ContactHistory { rows: VerificationDetails[]; fencedUntil: string | null; bindings: BindingView[]; destinations: DestinationView[] }
export interface DeviceSuggestion { deviceId: string; hostname: string; username: string; hasBinding: boolean }
export interface DirectoryUser { entraTenantId: string; entraOid: string; upn: string; displayName: string }
export interface DirectorySearch { available: boolean; users: DirectoryUser[]; truncated: boolean }
export type PolicyValues = Omit<EffectiveCallerVerificationPolicy, 'provenance' | 'ignored'>;
export type PolicyDraft = { [K in keyof PolicyValues]: PolicyValues[K] | null };
export interface PolicyResponse { row: PolicyDraft | null; defaults: PolicyValues; baseline: PolicyValues; effective: EffectiveCallerVerificationPolicy }
export type Owner = { ownerScope: 'partner' } | { ownerScope: 'organization'; orgId: string };
export interface TicketVerification { row: VerificationDetails | null; isFresh: boolean; isConsumed: boolean }
const segment = encodeURIComponent;
export function orgPath(orgId: string, suffix: string, query: Record<string, string> = {}): string {
  return `/orgs/${segment(orgId)}/${suffix}?${new URLSearchParams({ ...query, orgId })}`;
}
function unwrapData<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Missing API data envelope');
  return (body as { data: T }).data;
}
async function read<T>(path: string, signal?: AbortSignal, unwrap = true): Promise<T> {
  const response = await fetchWithAuth(path, { method: 'GET', cache: 'no-store', signal, ...(path.startsWith('/partner/') ? { orgIdOverride: null } : {}) });
  if (!response.ok) throw new ActionError(i18n.t('callerVerification:loadFailed'), response.status);
  const body: unknown = await response.json();
  return unwrap ? unwrapData<T>(body) : body as T;
}
export function mutate<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return runAction<T>({
    request: () => fetchWithAuth(path, { method, ...(path.startsWith('/partner/') ? { orgIdOverride: null } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    errorFallback: i18n.t('callerVerification:saveFailed'),
    successMessage: i18n.t('callerVerification:saved'),
    parseSuccess: data => unwrapData<T>(data),
    friendly: code => i18n.exists(`callerVerification:reasons.${code}`)
      ? i18n.t(/* i18n-dynamic */ `callerVerification:reasons.${code}`) : undefined,
  });
}
export function startVerification({ orgId, ...body }: StartInput): Promise<VerificationDetails> { return mutate(orgPath(orgId, 'caller-verifications'), 'POST', body); }
export function getVerification(orgId: string, id: string, signal?: AbortSignal): Promise<VerificationDetails> { return read(orgPath(orgId, `caller-verifications/${segment(id)}`), signal); }
export function cancelVerification(orgId: string, id: string): Promise<VerificationDetails> { return mutate(orgPath(orgId, `caller-verifications/${segment(id)}/cancel`), 'POST'); }
export function attestVerification(orgId: string, id: string, note: string): Promise<VerificationDetails> { return mutate(orgPath(orgId, `caller-verifications/${segment(id)}/attest`), 'POST', { note }); }
export function contactHistory(orgId: string, contactId: string, signal?: AbortSignal): Promise<ContactHistory> { return read(orgPath(orgId, `contacts/${segment(contactId)}/caller-verifications`), signal); }
export function methodsForContact(orgId: string, contactId: string, actionScope: CallerVerificationActionScope, signal?: AbortSignal): Promise<MethodAvailability[]> { return read(orgPath(orgId, `contacts/${segment(contactId)}/caller-verifications/methods`, { actionScope }), signal); }
export function deviceSuggestions(orgId: string, contactId: string, signal?: AbortSignal): Promise<DeviceSuggestion[]> { return read(orgPath(orgId, 'caller-verifications/device-suggestions', { contactId }), signal); }
export function freshForTicket(orgId: string, ticketId: string, signal?: AbortSignal): Promise<TicketVerification> { return read(orgPath(orgId, `tickets/${segment(ticketId)}/caller-verification`), signal); }
export function fenceOverride(orgId: string, contactId: string, reason: string): Promise<void> { return mutate(orgPath(orgId, `contacts/${segment(contactId)}/caller-verifications/fence-override`), 'POST', { reason }); }
export function directoryUsers(orgId: string, search: string, signal?: AbortSignal): Promise<DirectorySearch> { return read(orgPath(orgId, 'caller-verification-directory-users', { search }), signal); }
export function bindContact(orgId: string, contactId: string, user: DirectoryUser): Promise<BindingView> { const { entraTenantId, entraOid, upn } = user; return mutate(orgPath(orgId, `contacts/${segment(contactId)}/caller-verification-bindings`), 'POST', { entraTenantId, entraOid, upn }); }
export function unbindContact(orgId: string, contactId: string, bindingId: string): Promise<void> { return mutate(orgPath(orgId, `contacts/${segment(contactId)}/caller-verification-bindings/${segment(bindingId)}`), 'DELETE'); }
export function attestDestination(orgId: string, contactId: string, id: string): Promise<{ id: string; attestedAt: string }> { return mutate(orgPath(orgId, `contacts/${segment(contactId)}/caller-verification-destinations/${segment(id)}/attest`), 'POST'); }
const policyPath = (owner: Owner) => owner.ownerScope === 'partner' ? '/partner/caller-verification-policy' : orgPath(owner.orgId, 'caller-verification-policy');
export function getPolicy(owner: Owner, signal?: AbortSignal): Promise<PolicyResponse> { return read(policyPath(owner), signal); }
export function putPolicy(owner: Owner, draft: PolicyDraft): Promise<PolicyResponse> { return mutate(policyPath(owner), 'PUT', draft); }
export function createAdministrative(orgId: string, targetContactId: string, reason: string, stepUpGrantId: string): Promise<VerificationDetails> { return mutate(orgPath(orgId, 'caller-verifications/administrative'), 'POST', { targetContactId, reason, stepUpGrantId }); }
export interface ContactOption { id: string; name: string | null; email: string | null; siteId: string | null; roles: string[] }
export function contactsPage(orgId: string, page: number, signal?: AbortSignal): Promise<{ data: ContactOption[]; pagination: { page: number; total: number; limit: number } }> {
  return read(`/orgs/organizations/${segment(orgId)}/contacts?${new URLSearchParams({ orgId, page: String(page), limit: '100' })}`, signal, false);
}
```

Create deterministic fixtures (all following tests import these rather than invent partial API rows):

```ts
// apps/web/src/components/callerVerification/testFixtures.ts
import type { VerificationDetails, EffectiveCallerVerificationPolicy, ContactHistory } from '@/lib/api/callerVerification';
export const ORG = '11111111-1111-4111-8111-111111111111';
export const CONTACT = '22222222-2222-4222-8222-222222222222';
export const TARGET = '33333333-3333-4333-8333-333333333333';
export const USER = '44444444-4444-4444-8444-444444444444';
export const row: VerificationDetails = {
  id: '55555555-5555-4555-8555-555555555555', orgId: ORG, contactId: CONTACT,
  targetContactId: CONTACT, method: 'sms', status: 'pending', tier: 2,
  tierReason: 'destination_established', actionScope: 'reset_password', targetLabel: 'Ada',
  technicianLabel: 'Technician', initiatedByUserId: USER, expiresAt: '2026-09-19T12:10:00Z',
  decidedAt: null, consumedAt: null, ticketRef: null, ticketNumber: null,
  destinationRedacted: '+1 •••• 12', deviceHostname: null, osUsername: null,
  createdAt: '2026-09-19T12:00:00Z', secrets: { matchValue: '42', decoyValues: ['13', '87'], reverseCode: '7319' },
  remainingAttempts: 2, usableUntil: null, incidentId: null, consumedAction: null, undeliverableReason: null,
};
export const policy: EffectiveCallerVerificationPolicy = {
  requiredTierResetPassword: 2, requiredTierDisableUser: 2, disableUserAuthorizerRoles: ['admin'],
  verificationTtlMinutes: 30, allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'],
  workstationTimeoutSeconds: 120, destinationMinAgeDays: 7, requireAttestedDestination: false,
  requireTicket: false, allowCrossTechnicianUse: false, allowAdministrativeDisable: true,
  maxAttemptsPerHour: 3, coolingOffHours: 24, provenance: {}, ignored: [],
};
export const history: ContactHistory = { rows: [], fencedUntil: null, bindings: [], destinations: [] };
```

Register `'src/lib/api/callerVerification.ts'` in `TARGET_GLOBS`. Increase the existing expected count 125 to 126 only after counting the rebased list; do not alter the allowlist. Additional component registrations happen in Task 15.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/lib/api/callerVerification.test.ts` → all tests pass. Full mutation guard runs after all listed new modules exist.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/lib/api/callerVerification.ts apps/web/src/lib/api/callerVerification.test.ts apps/web/src/components/callerVerification/testFixtures.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): caller verification API contract and mutation feedback"
```

### Task 2: Runtime readiness and dark mounting

**Files:** Modify `apps/web/src/stores/featuresStore.ts:6,36,70` and `apps/web/src/stores/featuresStore.test.ts`. Create `apps/web/src/lib/useCallerVerificationEnabled.ts`, `apps/web/src/lib/useCallerVerificationEnabled.test.tsx`.

**Interfaces:** Consumes `GET /config → {features:{callerVerification:boolean}}` from W01. Produces `useCallerVerificationEnabled(): boolean`, false on SSR and until loaded.

- [ ] **Step 1: Write failing tests.**

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useFeaturesStore } from '@/stores/featuresStore';
import { useCallerVerificationEnabled } from './useCallerVerificationEnabled';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetch }));
beforeEach(() => { useFeaturesStore.setState({ loaded: false, features: { billing: false, support: false, aiOperatorTasks: false, callerVerification: false } }); });
it.each([{}, { callerVerification: false }, { callerVerification: 'true' }])('fails closed for %j', async features => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ features })));
  const { result } = renderHook(useCallerVerificationEnabled);
  await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
  expect(result.current).toBe(false);
});
it('opens only after the true runtime flag and closes on reset', async () => {
  fetch.mockResolvedValue(new Response('{"features":{"callerVerification":true}}'));
  const { result } = renderHook(useCallerVerificationEnabled);
  expect(result.current).toBe(false);
  await waitFor(() => expect(result.current).toBe(true));
  act(() => useFeaturesStore.setState({ loaded: false }));
  expect(result.current).toBe(false);
});
it('hides on config failure', async () => {
  fetch.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(useCallerVerificationEnabled);
  await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
  expect(result.current).toBe(false);
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/lib/useCallerVerificationEnabled.test.tsx` → module absent.
- [ ] **Step 3: Implement.** Add `callerVerification: boolean` to `Features`, `callerVerification: false` to `DEFAULT_FEATURES`, and `callerVerification: data.features?.callerVerification === true` to parsed features. Update existing complete feature literals in `featuresStore.test.ts` with false. W01's config projection is `callerVerification: isCallerVerificationEnabled(),` inside the existing `features` object; this is a prerequisite, not a second flag implementation.

```ts
// apps/web/src/lib/useCallerVerificationEnabled.ts
import { useEffect } from 'react';
import { useFeaturesStore } from '@/stores/featuresStore';
export function useCallerVerificationEnabled(): boolean {
  const enabled = useFeaturesStore(s => s.features.callerVerification);
  const loaded = useFeaturesStore(s => s.loaded);
  const load = useFeaturesStore(s => s.load);
  useEffect(() => { void load(); }, [load]);
  return loaded && enabled === true;
}
```

Use a gated outer component and a data-fetching inner component throughout this plan; returning null after running fetching effects does not satisfy dark mounting. No caller-verification route may be fetched while this hook is false.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/lib/useCallerVerificationEnabled.test.tsx src/stores/featuresStore.test.ts` → pass, including old config fixtures.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/stores/featuresStore.ts apps/web/src/stores/featuresStore.test.ts apps/web/src/lib/useCallerVerificationEnabled.ts apps/web/src/lib/useCallerVerificationEnabled.test.tsx
git commit -m "feat(web): hide caller verification until runtime readiness"
```

### Task 3: Complete eight-locale namespace before building the UI

**Files:** Create the eight exact `apps/web/src/locales/<locale>/callerVerification.json` paths listed in File structure and `apps/web/src/lib/i18n/callerVerification.test.ts`. Modify `apps/web/src/lib/i18n/translationCoverage.test.ts:15` (each locale's baseline object).

**Interfaces:** Consumes automatic namespace loading from `lib/i18n/index.ts:20`. Produces all keys in the catalog matrix below; dot-separated keys become nested JSON objects. Dynamic key calls must use the existing `/* i18n-dynamic */` marker (`keyUsage.test.ts:11`).

- [ ] **Step 1: Write the failing locale test.**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const locales = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'];
const leaves = (o: Record<string, unknown>, prefix = ''): [string, string][] => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' && v !== null ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]]);
it('ships the complete namespace and preserves interpolation in all locales', () => {
  const catalogs = locales.map(l => new Map(leaves(JSON.parse(readFileSync(new URL(`../../locales/${l}/callerVerification.json`, import.meta.url), 'utf8')))));
  const tokens = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map(m => m[1]).sort();
  for (const catalog of catalogs) {
    expect([...catalog.keys()].sort()).toEqual([...catalogs[0].keys()].sort());
    for (const [key, value] of catalogs[0]) expect(tokens(catalog.get(key)!)).toEqual(tokens(value));
  }
  expect(catalogs[0].get('script')).toContain("If anything on it looks wrong");
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/lib/i18n/callerVerification.test.ts` → ENOENT for the new catalog.
- [ ] **Step 3: Write these real translations.** The matrix is executable input to the following script, not instructions to translate later. French Canadian “courriel” and French “e-mail” are intentionally distinct. Labels describe assurance without promising identity proof.

<!-- caller-catalog-start -->
| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| title | Verify caller | Anrufer überprüfen | Verificar a quien llama | Vérifier l’appelant | Vérifier l’appelant | Verifica chiamante | Verificar quem está ligando | Arayanı doğrula |
| next | Continue | Weiter | Continuar | Continuer | Continuer | Continua | Continuar | Devam et |
| back | Back | Zurück | Volver | Retour | Retour | Indietro | Voltar | Geri |
| close | Close | Schließen | Cerrar | Fermer | Fermer | Chiudi | Fechar | Kapat |
| cancel | Cancel verification | Überprüfung abbrechen | Cancelar verificación | Annuler la vérification | Annuler la vérification | Annulla verifica | Cancelar verificação | Doğrulamayı iptal et |
| start | Send verification | Überprüfung senden | Enviar verificación | Envoyer la vérification | Envoyer la vérification | Invia verifica | Enviar verificação | Doğrulama gönder |
| retry | Start a new attempt | Neuen Versuch starten | Iniciar otro intento | Faire une nouvelle tentative | Faire une nouvelle tentative | Avvia un nuovo tentativo | Iniciar nova tentativa | Yeni deneme başlat |
| loading | Loading verification details… | Überprüfungsdetails werden geladen… | Cargando detalles de verificación… | Chargement des détails de vérification… | Chargement des détails de vérification… | Caricamento dei dettagli di verifica… | Carregando detalhes da verificação… | Doğrulama ayrıntıları yükleniyor… |
| loadFailed | Could not load verification details. Try again. | Überprüfungsdetails konnten nicht geladen werden. Erneut versuchen. | No se pudieron cargar los detalles. Inténtalo de nuevo. | Impossible de charger les détails. Réessayez. | Impossible de charger les détails. Réessayez. | Impossibile caricare i dettagli. Riprova. | Não foi possível carregar os detalhes. Tente novamente. | Ayrıntılar yüklenemedi. Yeniden deneyin. |
| saveFailed | Could not save this change. | Änderung konnte nicht gespeichert werden. | No se pudo guardar el cambio. | Impossible d’enregistrer cette modification. | Impossible d’enregistrer cette modification. | Impossibile salvare la modifica. | Não foi possível salvar a alteração. | Bu değişiklik kaydedilemedi. |
| saved | Verification request saved | Überprüfungsanfrage gespeichert | Solicitud de verificación guardada | Demande de vérification enregistrée | Demande de vérification enregistrée | Richiesta di verifica salvata | Solicitação de verificação salva | Doğrulama isteği kaydedildi |
| action | Requested action | Angeforderte Aktion | Acción solicitada | Action demandée | Action demandée | Azione richiesta | Ação solicitada | İstenen işlem |
| actions.reset_password | Reset password | Passwort zurücksetzen | Restablecer contraseña | Réinitialiser le mot de passe | Réinitialiser le mot de passe | Reimposta password | Redefinir senha | Parolayı sıfırla |
| actions.disable_user | Disable user | Benutzer deaktivieren | Deshabilitar usuario | Désactiver l’utilisateur | Désactiver l’utilisateur | Disabilita utente | Desativar usuário | Kullanıcıyı devre dışı bırak |
| actions.any | General verification | Allgemeine Überprüfung | Verificación general | Vérification générale | Vérification générale | Verifica generale | Verificação geral | Genel doğrulama |
| requester | Caller contact | Kontakt des Anrufers | Contacto de quien llama | Contact de l’appelant | Contact de l’appelant | Contatto del chiamante | Contato de quem liga | Arayanın kişisi |
| target | Account to disable | Zu deaktivierendes Konto | Cuenta que se deshabilitará | Compte à désactiver | Compte à désactiver | Account da disabilitare | Conta a desativar | Devre dışı bırakılacak hesap |
| differentTarget | Disable a different contact’s account | Konto eines anderen Kontakts deaktivieren | Deshabilitar la cuenta de otro contacto | Désactiver le compte d’un autre contact | Désactiver le compte d’un autre contact | Disabilita l’account di un altro contatto | Desativar a conta de outro contato | Başka bir kişinin hesabını devre dışı bırak |
| selectContact | Select a contact | Kontakt auswählen | Seleccionar contacto | Sélectionner un contact | Sélectionner un contact | Seleziona un contatto | Selecionar contato | Kişi seç |
| searchContacts | Filter loaded contacts | Geladene Kontakte filtern | Filtrar contactos cargados | Filtrer les contacts chargés | Filtrer les contacts chargés | Filtra i contatti caricati | Filtrar contatos carregados | Yüklenen kişileri filtrele |
| more | Load more contacts | Weitere Kontakte laden | Cargar más contactos | Charger plus de contacts | Charger plus de contacts | Carica altri contatti | Carregar mais contatos | Daha fazla kişi yükle |
| noContacts | No matching contacts loaded | Keine passenden Kontakte geladen | No hay contactos cargados que coincidan | Aucun contact chargé ne correspond | Aucun contact chargé ne correspond | Nessun contatto caricato corrisponde | Nenhum contato carregado corresponde | Yüklenen eşleşen kişi yok |
| username | Confirm the signed-in username | Angemeldeten Benutzernamen bestätigen | Confirma el usuario que inició sesión | Confirmez le nom d’utilisateur connecté | Confirmez le nom d’utilisateur connecté | Conferma il nome utente connesso | Confirme o usuário conectado | Oturum açmış kullanıcı adını onaylayın |
| device | Workstation | Arbeitsplatz | Estación de trabajo | Poste de travail | Poste de travail | Postazione di lavoro | Estação de trabalho | İş istasyonu |
| ticket | Ticket identifier | Ticketkennung | Identificador del ticket | Identifiant du billet | Identifiant du ticket | Identificativo del ticket | Identificador do chamado | Destek kaydı kimliği |
| ticketRequired | A ticket for this caller is required. | Ein Ticket für diesen Anrufer ist erforderlich. | Se requiere un ticket de quien llama. | Un billet pour cet appelant est requis. | Un ticket pour cet appelant est requis. | È necessario un ticket per questo chiamante. | É necessário um chamado de quem liga. | Bu arayan için bir destek kaydı gereklidir. |
| tier | Assurance tier {{tier}} | Sicherheitsstufe {{tier}} | Nivel de garantía {{tier}} | Niveau d’assurance {{tier}} | Niveau d’assurance {{tier}} | Livello di garanzia {{tier}} | Nível de garantia {{tier}} | Güvence düzeyi {{tier}} |
| methods.workstation | Workstation prompt | Arbeitsplatzabfrage | Aviso en estación de trabajo | Invite sur le poste | Invite sur le poste | Richiesta sulla postazione | Solicitação na estação | İş istasyonu istemi |
| methods.sms | Text message (SMS) | SMS-Nachricht | Mensaje de texto (SMS) | Message texte (SMS) | Message par SMS | Messaggio SMS | Mensagem de texto (SMS) | Kısa mesaj (SMS) |
| methods.email | Email link | E-Mail-Link | Enlace por correo | Lien par courriel | Lien par e-mail | Link via e-mail | Link por e-mail | E-posta bağlantısı |
| methods.callback_attestation | Callback attestation | Rückrufbestätigung | Constancia de devolución de llamada | Attestation de rappel | Attestation de rappel | Attestazione di richiamata | Atestado de retorno da ligação | Geri arama beyanı |
| methods.administrative_stepup | Administrative MFA verification | Administrative MFA-Überprüfung | Verificación MFA administrativa | Vérification MFA administrative | Vérification MFA administrative | Verifica MFA amministrativa | Verificação MFA administrativa | Yönetici MFA doğrulaması |
| reasons.method_disabled | Disabled by policy | Durch Richtlinie deaktiviert | Deshabilitado por la política | Désactivé par la politique | Désactivé par la politique | Disabilitato dalla policy | Desativado pela política | İlke tarafından devre dışı bırakıldı |
| reasons.no_destination | No destination on record | Kein Ziel hinterlegt | No hay destino registrado | Aucune destination au dossier | Aucune destination enregistrée | Nessun recapito registrato | Nenhum destino registrado | Kayıtlı hedef yok |
| reasons.helper_outdated | The desktop helper needs an update. | Der Desktop-Helfer benötigt ein Update. | El asistente de escritorio necesita actualizarse. | L’assistant de bureau doit être mis à jour. | L’assistant de bureau doit être mis à jour. | L’assistente desktop deve essere aggiornato. | O assistente de desktop precisa ser atualizado. | Masaüstü yardımcısının güncellenmesi gerekiyor. |
| reasons.no_binding | No Entra binding; workstation assurance is at most tier 1. | Keine Entra-Zuordnung; höchstens Stufe 1 am Arbeitsplatz. | Sin vínculo de Entra; la estación ofrece como máximo nivel 1. | Aucun lien Entra; le poste offre au plus le niveau 1. | Aucun lien Entra; le poste offre au plus le niveau 1. | Nessun collegamento Entra; la postazione offre al massimo il livello 1. | Sem vínculo Entra; a estação oferece no máximo nível 1. | Entra bağı yok; iş istasyonu en fazla düzey 1 sağlar. |
| reasons.administrative_disabled | Administrative disable is disabled by policy. | Administrative Deaktivierung ist nicht erlaubt. | La política no permite la deshabilitación administrativa. | La désactivation administrative est interdite par la politique. | La désactivation administrative est interdite par la politique. | La disabilitazione amministrativa è vietata dalla policy. | A desativação administrativa está desabilitada pela política. | Yönetici devre dışı bırakma işlemi ilkeyle kapatıldı. |
| reasons.feature_disabled | Caller verification is unavailable. | Anruferüberprüfung ist nicht verfügbar. | La verificación de llamadas no está disponible. | La vérification de l’appelant est indisponible. | La vérification de l’appelant est indisponible. | La verifica chiamante non è disponibile. | A verificação de quem liga está indisponível. | Arayan doğrulaması kullanılamıyor. |
| reasons.bound_principal | Bound to this contact’s signed-in identity | Der angemeldeten Identität dieses Kontakts zugeordnet | Vinculado a la identidad de sesión de este contacto | Lié à l’identité connectée de ce contact | Lié à l’identité connectée de ce contact | Collegato all’identità connessa di questo contatto | Vinculado à identidade conectada deste contato | Bu kişinin oturum kimliğine bağlı |
| reasons.unbound_principal | Signed-in identity is not bound to this contact. | Angemeldete Identität ist diesem Kontakt nicht zugeordnet. | La identidad de sesión no está vinculada a este contacto. | L’identité connectée n’est pas liée à ce contact. | L’identité connectée n’est pas liée à ce contact. | L’identità connessa non è collegata a questo contatto. | A identidade conectada não está vinculada a este contato. | Oturum kimliği bu kişiye bağlı değil. |
| reasons.destination_established | Established destination of record | Etabliertes hinterlegtes Ziel | Destino registrado establecido | Destination au dossier établie | Destination enregistrée établie | Recapito registrato consolidato | Destino registrado estabelecido | Yerleşik kayıtlı hedef |
| reasons.destination_recent | Destination is not yet established. | Ziel ist noch nicht etabliert. | El destino aún no está establecido. | La destination n’est pas encore établie. | La destination n’est pas encore établie. | Il recapito non è ancora consolidato. | O destino ainda não está estabelecido. | Hedef henüz yerleşik değil. |
| reasons.attestation | Technician attestation only | Nur Bestätigung durch Techniker | Solo constancia del técnico | Attestation du technicien seulement | Attestation du technicien uniquement | Solo attestazione del tecnico | Apenas atestado do técnico | Yalnızca teknisyen beyanı |
| reasons.no_session_for_user | No signed-in session for that username. | Keine Sitzung für diesen Benutzernamen. | No hay sesión iniciada para ese usuario. | Aucune session ouverte pour ce nom d’utilisateur. | Aucune session ouverte pour ce nom d’utilisateur. | Nessuna sessione aperta per questo utente. | Nenhuma sessão conectada para esse usuário. | Bu kullanıcı için açık oturum yok. |
| reasons.session_not_console | The user is not in the console session. | Benutzer ist nicht in der Konsolensitzung. | El usuario no está en la sesión de consola. | L’utilisateur n’est pas dans la session console. | L’utilisateur n’est pas dans la session console. | L’utente non è nella sessione console. | O usuário não está na sessão do console. | Kullanıcı konsol oturumunda değil. |
| reasons.sms_failed | The SMS could not be delivered. | SMS konnte nicht zugestellt werden. | No se pudo entregar el SMS. | Le SMS n’a pas pu être livré. | Le SMS n’a pas pu être livré. | Impossibile recapitare l’SMS. | Não foi possível entregar o SMS. | SMS iletilemedi. |
| reasons.email_failed | The email could not be delivered. | E-Mail konnte nicht zugestellt werden. | No se pudo entregar el correo. | Le courriel n’a pas pu être livré. | L’e-mail n’a pas pu être livré. | Impossibile recapitare l’e-mail. | Não foi possível entregar o e-mail. | E-posta iletilemedi. |
| reasons.contact_fenced | Verification is blocked after a rejection. | Überprüfung nach Ablehnung gesperrt. | Verificación bloqueada tras un rechazo. | Vérification bloquée après un rejet. | Vérification bloquée après un rejet. | Verifica bloccata dopo un rifiuto. | Verificação bloqueada após rejeição. | Ret sonrasında doğrulama engellendi. |
| reasons.unknown | Further verification details are unavailable. | Weitere Überprüfungsdetails fehlen. | No hay más detalles de verificación disponibles. | Les détails supplémentaires sont indisponibles. | Les détails supplémentaires sont indisponibles. | Ulteriori dettagli di verifica non disponibili. | Outros detalhes da verificação estão indisponíveis. | Ek doğrulama ayrıntıları kullanılamıyor. |
| script | I've sent a prompt to your screen. It shows the code {{code}} and says I'm asking to {{action}} for {{target}}. If that's right, tap {{number}}. If anything on it looks wrong, tap 'This is not me'. | Ich habe eine Abfrage an Ihren Bildschirm gesendet. Sie zeigt den Code {{code}} und die Anfrage „{{action}}“ für {{target}}. Wenn das stimmt, tippen Sie auf {{number}}. Wenn etwas nicht stimmt, tippen Sie auf „Das bin nicht ich“. | Envié un aviso a tu pantalla. Muestra el código {{code}} y dice que solicito {{action}} para {{target}}. Si es correcto, toca {{number}}. Si algo parece incorrecto, toca «No soy yo». | J’ai envoyé une invite à votre écran. Elle affiche le code {{code}} et indique ma demande : {{action}} pour {{target}}. Si c’est exact, appuyez sur {{number}}. Si quelque chose semble incorrect, appuyez sur « Ce n’est pas moi ». | J’ai envoyé une invite sur votre écran. Elle affiche le code {{code}} et indique ma demande : {{action}} pour {{target}}. Si c’est exact, appuyez sur {{number}}. Si quelque chose semble incorrect, appuyez sur « Ce n’est pas moi ». | Ho inviato una richiesta al tuo schermo. Mostra il codice {{code}} e indica che chiedo di {{action}} per {{target}}. Se è corretto, tocca {{number}}. Se qualcosa non va, tocca «Non sono io». | Enviei uma solicitação à sua tela. Ela mostra o código {{code}} e informa que estou pedindo para {{action}} para {{target}}. Se estiver correto, toque em {{number}}. Se algo parecer errado, toque em «Não sou eu». | Ekranınıza bir istem gönderdim. {{code}} kodunu ve {{target}} için {{action}} istediğimi gösteriyor. Doğruysa {{number}} seçeneğine dokunun. Yanlış görünen bir şey varsa «Bu ben değilim» seçeneğine dokunun. |
| linkScript | Open the link sent to your recorded destination, then read the card together. | Öffnen Sie den Link am hinterlegten Ziel und lesen Sie die Karte gemeinsam. | Abre el enlace enviado al destino registrado y revisen juntos la tarjeta. | Ouvrez le lien envoyé à la destination au dossier, puis lisez la fiche ensemble. | Ouvrez le lien envoyé à la destination enregistrée, puis lisez la fiche ensemble. | Apri il link inviato al recapito registrato e leggete insieme la scheda. | Abra o link enviado ao destino registrado e leiam o cartão juntos. | Kayıtlı hedefe gönderilen bağlantıyı açın, ardından kartı birlikte okuyun. |
| knownNumber | If unsure, hang up and call your IT provider on a number you already have. | Im Zweifel auflegen und Ihren IT-Anbieter unter einer bekannten Nummer anrufen. | Si tienes dudas, cuelga y llama a tu proveedor de TI a un número que ya conozcas. | En cas de doute, raccrochez et appelez votre fournisseur TI à un numéro que vous connaissez déjà. | En cas de doute, raccrochez et appelez votre prestataire informatique à un numéro déjà connu. | In caso di dubbi, riaggancia e chiama il fornitore IT a un numero già noto. | Em caso de dúvida, desligue e ligue para seu provedor de TI em um número que você já tenha. | Emin değilseniz kapatın ve BT sağlayıcınızı bildiğiniz bir numaradan arayın. |
| match | Matching number | Passende Zahl | Número coincidente | Numéro correspondant | Numéro correspondant | Numero corrispondente | Número correspondente | Eşleşen sayı |
| reverse | Reverse-check code | Rückprüfcode | Código de comprobación inversa | Code de vérification inverse | Code de vérification inverse | Codice di verifica inversa | Código de verificação reversa | Ters kontrol kodu |
| states.pending | Waiting for the caller | Warte auf den Anrufer | Esperando a quien llama | En attente de l’appelant | En attente de l’appelant | In attesa del chiamante | Aguardando quem liga | Arayan bekleniyor |
| states.verified | Caller verified | Anrufer überprüft | Persona que llama verificada | Appelant vérifié | Appelant vérifié | Chiamante verificato | Quem liga foi verificado | Arayan doğrulandı |
| states.wrong_choice | The caller selected a different number. | Anrufer hat eine andere Zahl gewählt. | Quien llama eligió otro número. | L’appelant a choisi un autre numéro. | L’appelant a choisi un autre numéro. | Il chiamante ha scelto un altro numero. | Quem liga selecionou outro número. | Arayan farklı bir sayı seçti. |
| states.rejected_by_user | The caller rejected this request. | Anrufer hat diese Anfrage abgelehnt. | Quien llama rechazó la solicitud. | L’appelant a rejeté cette demande. | L’appelant a rejeté cette demande. | Il chiamante ha rifiutato la richiesta. | Quem liga rejeitou esta solicitação. | Arayan bu isteği reddetti. |
| states.undeliverable | Verification could not be delivered. | Überprüfung konnte nicht zugestellt werden. | No se pudo entregar la verificación. | La vérification n’a pas pu être livrée. | La vérification n’a pas pu être livrée. | Impossibile recapitare la verifica. | Não foi possível entregar a verificação. | Doğrulama iletilemedi. |
| states.expired | Verification expired | Überprüfung abgelaufen | Verificación vencida | Vérification expirée | Vérification expirée | Verifica scaduta | Verificação expirada | Doğrulamanın süresi doldu |
| states.cancelled | Verification cancelled | Überprüfung abgebrochen | Verificación cancelada | Vérification annulée | Vérification annulée | Verifica annullata | Verificação cancelada | Doğrulama iptal edildi |
| states.revoked | Verification revoked | Überprüfung widerrufen | Verificación revocada | Vérification révoquée | Vérification révoquée | Verifica revocata | Verificação revogada | Doğrulama geri alındı |
| usable | Usable once for {{action}} by you; expires in {{minutes}} min. | Einmal für „{{action}}“ durch Sie nutzbar; läuft in {{minutes}} Min. ab. | Puedes usarla una vez para {{action}}; vence en {{minutes}} min. | Utilisable une fois par vous pour {{action}}; expire dans {{minutes}} min. | Utilisable une fois par vous pour {{action}}; expire dans {{minutes}} min. | Utilizzabile una volta da te per {{action}}; scade tra {{minutes}} min. | Você pode usar uma vez para {{action}}; expira em {{minutes}} min. | Sizin tarafınızdan {{action}} için bir kez kullanılabilir; {{minutes}} dk. sonra sona erer. |
| anotherTechnician | Initiated by {{technician}}; usability is checked at release. | Von {{technician}} gestartet; Nutzbarkeit wird bei Freigabe geprüft. | Iniciada por {{technician}}; se comprueba su validez al ejecutar. | Lancée par {{technician}}; la validité est vérifiée à l’exécution. | Lancée par {{technician}}; la validité est vérifiée à l’exécution. | Avviata da {{technician}}; validità verificata al rilascio. | Iniciada por {{technician}}; a validade é verificada na execução. | {{technician}} tarafından başlatıldı; kullanılabilirlik işlem öncesinde kontrol edilir. |
| remaining | Remaining attempts: {{attempts}} | Verbleibende Versuche: {{attempts}} | Intentos restantes: {{attempts}} | Tentatives restantes : {{attempts}} | Tentatives restantes : {{attempts}} | Tentativi rimasti: {{attempts}} | Tentativas restantes: {{attempts}} | Kalan deneme: {{attempts}} |
| incident | Open security incident | Sicherheitsvorfall öffnen | Abrir incidente de seguridad | Ouvrir l’incident de sécurité | Ouvrir l’incident de sécurité | Apri incidente di sicurezza | Abrir incidente de segurança | Güvenlik olayını aç |
| unused | Unused | Unbenutzt | Sin usar | Non utilisée | Non utilisée | Non utilizzata | Não utilizada | Kullanılmadı |
| used | Used for {{action}} | Für „{{action}}“ verwendet | Usada para {{action}} | Utilisée pour {{action}} | Utilisée pour {{action}} | Utilizzata per {{action}} | Usada para {{action}} | {{action}} için kullanıldı |
| age | {{minutes}} min ago | Vor {{minutes}} Min. | Hace {{minutes}} min | Il y a {{minutes}} min | Il y a {{minutes}} min | {{minutes}} min fa | Há {{minutes}} min | {{minutes}} dk. önce |
| history | Verification history | Überprüfungsverlauf | Historial de verificaciones | Historique des vérifications | Historique des vérifications | Cronologia verifiche | Histórico de verificações | Doğrulama geçmişi |
| empty | No verifications yet | Noch keine Überprüfungen | Aún no hay verificaciones | Aucune vérification pour le moment | Aucune vérification pour le moment | Nessuna verifica ancora | Nenhuma verificação ainda | Henüz doğrulama yok |
| fenced | Blocked until {{until}} | Bis {{until}} gesperrt | Bloqueado hasta {{until}} | Bloqué jusqu’à {{until}} | Bloqué jusqu’à {{until}} | Bloccato fino a {{until}} | Bloqueado até {{until}} | {{until}} tarihine kadar engellendi |
| override | Override the block | Sperre aufheben | Anular bloqueo | Lever le blocage | Lever le blocage | Revoca blocco | Remover bloqueio | Engeli kaldır |
| reason | Reason (at least 20 characters) | Begründung (mindestens 20 Zeichen) | Motivo (mínimo 20 caracteres) | Motif (au moins 20 caractères) | Motif (au moins 20 caractères) | Motivo (almeno 20 caratteri) | Motivo (pelo menos 20 caracteres) | Gerekçe (en az 20 karakter) |
| note | Record the callback and number-of-record check | Rückruf und Prüfung der hinterlegten Nummer dokumentieren | Registra la devolución de llamada y la comprobación del número | Consignez le rappel et la vérification du numéro au dossier | Consignez le rappel et la vérification du numéro enregistré | Registra la richiamata e il controllo del numero registrato | Registre o retorno e a conferência do número cadastrado | Geri aramayı ve kayıtlı numara kontrolünü kaydedin |
| attestCallback | Record callback attestation | Rückrufbestätigung speichern | Registrar constancia de devolución | Enregistrer l’attestation de rappel | Enregistrer l’attestation de rappel | Registra attestazione di richiamata | Registrar atestado de retorno | Geri arama beyanını kaydet |
| bindings | Entra identity bindings | Entra-Identitätszuordnungen | Vínculos de identidad Entra | Liens d’identité Entra | Liens d’identité Entra | Collegamenti identità Entra | Vínculos de identidade Entra | Entra kimlik bağları |
| bind | Bind to Entra user | Entra-Benutzer zuordnen | Vincular a usuario de Entra | Lier à un utilisateur Entra | Lier à un utilisateur Entra | Collega a utente Entra | Vincular a usuário Entra | Entra kullanıcısına bağla |
| unbind | Remove binding | Zuordnung entfernen | Quitar vínculo | Retirer le lien | Retirer le lien | Rimuovi collegamento | Remover vínculo | Bağı kaldır |
| directorySearch | Search Entra users | Entra-Benutzer suchen | Buscar usuarios de Entra | Rechercher des utilisateurs Entra | Rechercher des utilisateurs Entra | Cerca utenti Entra | Buscar usuários Entra | Entra kullanıcılarını ara |
| directoryUnavailable | Connect a customer Graph read profile to search Entra users. | Für Entra-Suche ein Kunden-Graph-Leseprofil verbinden. | Conecta un perfil de lectura Graph del cliente para buscar usuarios. | Connectez un profil de lecture Graph client pour rechercher les utilisateurs. | Connectez un profil de lecture Graph client pour rechercher les utilisateurs. | Collega un profilo di lettura Graph del cliente per cercare utenti. | Conecte um perfil de leitura Graph do cliente para buscar usuários. | Kullanıcı aramak için müşteri Graph okuma profilini bağlayın. |
| truncated | Refine the search to see more matches. | Suche verfeinern, um weitere Treffer zu sehen. | Refina la búsqueda para ver más coincidencias. | Précisez la recherche pour voir plus de résultats. | Affinez la recherche pour voir plus de résultats. | Affina la ricerca per vedere altri risultati. | Refine a busca para ver mais resultados. | Daha fazla eşleşme için aramayı daraltın. |
| destinations | Destinations of record | Hinterlegte Ziele | Destinos registrados | Destinations au dossier | Destinations enregistrées | Recapiti registrati | Destinos registrados | Kayıtlı hedefler |
| confirmNumber | Confirm number of record | Hinterlegte Nummer bestätigen | Confirmar número registrado | Confirmer le numéro au dossier | Confirmer le numéro enregistré | Conferma numero registrato | Confirmar número cadastrado | Kayıtlı numarayı onayla |
| confirmDestination | Confirm destination of record | Hinterlegtes Ziel bestätigen | Confirmar destino registrado | Confirmer la destination au dossier | Confirmer la destination enregistrée | Conferma recapito registrato | Confirmar destino cadastrado | Kayıtlı hedefi onayla |
| attestHelp | Confirm only after an independent check; this does not waive the minimum age. | Nur nach unabhängiger Prüfung bestätigen; das Mindestalter bleibt bestehen. | Confirma solo tras una comprobación independiente; la antigüedad mínima sigue vigente. | Confirmez après une vérification indépendante; l’âge minimal reste requis. | Confirmez après une vérification indépendante; l’ancienneté minimale reste requise. | Conferma solo dopo un controllo indipendente; l’età minima resta obbligatoria. | Confirme após verificação independente; a idade mínima continua exigida. | Yalnızca bağımsız kontrolden sonra onaylayın; asgari süre gereği devam eder. |
| policyTitle | Caller verification policy | Richtlinie zur Anruferüberprüfung | Política de verificación de llamadas | Politique de vérification de l’appelant | Politique de vérification de l’appelant | Policy di verifica chiamante | Política de verificação de quem liga | Arayan doğrulama ilkesi |
| partnerScope | All organizations in this partner | Alle Organisationen dieses Partners | Todas las organizaciones de este socio | Toutes les organisations de ce partenaire | Toutes les organisations de ce partenaire | Tutte le organizzazioni di questo partner | Todas as organizações deste parceiro | Bu iş ortağındaki tüm kuruluşlar |
| orgScope | This organization; partner minimums apply | Diese Organisation; Partnermindestwerte gelten | Esta organización; se aplican mínimos del socio | Cette organisation; minimums du partenaire applicables | Cette organisation; minimums du partenaire applicables | Questa organizzazione; valgono i minimi del partner | Esta organização; mínimos do parceiro se aplicam | Bu kuruluş; iş ortağı alt sınırları geçerlidir |
| save | Save policy | Richtlinie speichern | Guardar política | Enregistrer la politique | Enregistrer la politique | Salva policy | Salvar política | İlkeyi kaydet |
| inherit | Inherit | Erben | Heredar | Hériter | Hériter | Eredita | Herdar | Devral |
| provenance.default | From built-in defaults | Aus integrierten Standardwerten | De valores predeterminados | Des valeurs par défaut intégrées | Des valeurs par défaut intégrées | Dai valori predefiniti | Dos padrões integrados | Yerleşik varsayılanlardan |
| provenance.partner | From partner policy | Aus Partnerrichtlinie | De la política del socio | De la politique du partenaire | De la politique du partenaire | Dalla policy del partner | Da política do parceiro | İş ortağı ilkesinden |
| provenance.org | From organization policy | Aus Organisationsrichtlinie | De la política de la organización | De la politique de l’organisation | De la politique de l’organisation | Dalla policy dell’organizzazione | Da política da organização | Kuruluş ilkesinden |
| ignored | Ignored because it weakens the partner policy: {{field}} | Wegen Abschwächung der Partnerrichtlinie ignoriert: {{field}} | Se ignoró por debilitar la política del socio: {{field}} | Ignoré car cela affaiblit la politique du partenaire : {{field}} | Ignoré car cela affaiblit la politique du partenaire : {{field}} | Ignorato perché indebolisce la policy del partner: {{field}} | Ignorado por enfraquecer a política do parceiro: {{field}} | İş ortağı ilkesini zayıflattığı için yok sayıldı: {{field}} |
| gateOffWarning | A tier of 0 disables caller verification for that action. This warning remains while it is disabled. | Stufe 0 deaktiviert die Anruferüberprüfung für diese Aktion. Die Warnung bleibt bestehen. | El nivel 0 desactiva la verificación para esa acción. Esta advertencia permanece mientras esté desactivada. | Le niveau 0 désactive la vérification pour cette action. Cet avertissement reste affiché. | Le niveau 0 désactive la vérification pour cette action. Cet avertissement reste affiché. | Il livello 0 disattiva la verifica per l’azione. Questo avviso rimane visibile. | O nível 0 desativa a verificação para essa ação. Este aviso permanece enquanto estiver desativada. | Düzey 0, bu işlem için arayan doğrulamasını kapatır. Kapalı kaldığı sürece bu uyarı gösterilir. |
| fields.requiredTierResetPassword | Password reset minimum tier | Mindeststufe für Passwortzurücksetzung | Nivel mínimo para restablecer contraseña | Niveau minimal de réinitialisation du mot de passe | Niveau minimal de réinitialisation du mot de passe | Livello minimo per reimpostare la password | Nível mínimo para redefinir senha | Parola sıfırlama asgari düzeyi |
| fields.requiredTierDisableUser | User disable minimum tier | Mindeststufe für Benutzerdeaktivierung | Nivel mínimo para deshabilitar usuario | Niveau minimal de désactivation | Niveau minimal de désactivation | Livello minimo per disabilitare utenti | Nível mínimo para desativar usuário | Kullanıcı devre dışı bırakma asgari düzeyi |
| fields.disableUserAuthorizerRoles | Roles allowed to authorize another user’s disable | Rollen für Freigabe fremder Kontodeaktivierung | Roles que pueden autorizar deshabilitar a otro usuario | Rôles autorisant la désactivation d’un autre utilisateur | Rôles autorisant la désactivation d’un autre utilisateur | Ruoli autorizzati a disabilitare altri utenti | Funções que podem autorizar desativar outro usuário | Başka kullanıcıyı devre dışı bırakmayı onaylayan roller |
| fields.verificationTtlMinutes | Grant lifetime (minutes) | Berechtigungsdauer (Minuten) | Vigencia de autorización (minutos) | Durée de l’autorisation (minutes) | Durée de l’autorisation (minutes) | Durata autorizzazione (minuti) | Validade da autorização (minutos) | İzin geçerliliği (dakika) |
| fields.allowedMethods | Allowed challenge methods | Erlaubte Abfragemethoden | Métodos de desafío permitidos | Méthodes de défi permises | Méthodes de défi autorisées | Metodi di richiesta consentiti | Métodos de desafio permitidos | İzin verilen doğrulama yöntemleri |
| fields.workstationTimeoutSeconds | Workstation timeout (seconds) | Arbeitsplatzzeitlimit (Sekunden) | Tiempo límite de estación (segundos) | Délai du poste (secondes) | Délai du poste (secondes) | Timeout postazione (secondi) | Tempo limite da estação (segundos) | İş istasyonu zaman aşımı (saniye) |
| fields.destinationMinAgeDays | Destination minimum age (days) | Mindestalter des Ziels (Tage) | Antigüedad mínima del destino (días) | Âge minimal de la destination (jours) | Ancienneté minimale de la destination (jours) | Età minima del recapito (giorni) | Idade mínima do destino (dias) | Hedefin asgari yaşı (gün) |
| fields.requireAttestedDestination | Require destination attestation | Zielbestätigung verlangen | Exigir constancia del destino | Exiger l’attestation de destination | Exiger l’attestation de destination | Richiedi attestazione del recapito | Exigir atestado do destino | Hedef beyanını zorunlu kıl |
| fields.requireTicket | Require a matching ticket | Passendes Ticket verlangen | Exigir ticket coincidente | Exiger un billet correspondant | Exiger un ticket correspondant | Richiedi ticket corrispondente | Exigir chamado correspondente | Eşleşen destek kaydını zorunlu kıl |
| fields.allowCrossTechnicianUse | Allow use by another technician | Nutzung durch andere Techniker erlauben | Permitir uso por otro técnico | Permettre l’utilisation par un autre technicien | Autoriser l’utilisation par un autre technicien | Consenti uso da altro tecnico | Permitir uso por outro técnico | Başka teknisyenin kullanımına izin ver |
| fields.allowAdministrativeDisable | Allow administrative disable | Administrative Deaktivierung erlauben | Permitir deshabilitación administrativa | Permettre la désactivation administrative | Autoriser la désactivation administrative | Consenti disabilitazione amministrativa | Permitir desativação administrativa | Yönetici devre dışı bırakmasına izin ver |
| fields.maxAttemptsPerHour | Attempts per hour | Versuche pro Stunde | Intentos por hora | Tentatives par heure | Tentatives par heure | Tentativi all’ora | Tentativas por hora | Saat başına deneme |
| fields.coolingOffHours | Block duration after rejection (hours) | Sperrdauer nach Ablehnung (Stunden) | Duración del bloqueo tras rechazo (horas) | Durée du blocage après rejet (heures) | Durée du blocage après rejet (heures) | Durata blocco dopo rifiuto (ore) | Duração do bloqueio após rejeição (horas) | Ret sonrası engel süresi (saat) |
| adminTitle | Administrative account disable | Administrative Kontodeaktivierung | Deshabilitación administrativa de cuenta | Désactivation administrative du compte | Désactivation administrative du compte | Disabilitazione amministrativa account | Desativação administrativa de conta | Yönetici hesabı devre dışı bırakma |
| adminSubmit | Verify MFA and create one-use grant | MFA prüfen und Einmalberechtigung erstellen | Verificar MFA y crear autorización de un uso | Vérifier la MFA et créer une autorisation unique | Vérifier la MFA et créer une autorisation unique | Verifica MFA e crea autorizzazione monouso | Verificar MFA e criar autorização de uso único | MFA doğrula ve tek kullanımlık izin oluştur |
| noFactor | Add a passkey or authenticator factor in your profile to continue. | Zum Fortfahren Passkey oder Authenticator im Profil hinzufügen. | Agrega una clave de acceso o autenticador en tu perfil para continuar. | Ajoutez une clé d’accès ou un authentificateur à votre profil pour continuer. | Ajoutez une clé d’accès ou un authentificateur à votre profil pour continuer. | Aggiungi una passkey o un autenticatore al profilo per continuare. | Adicione uma chave de acesso ou autenticador ao perfil para continuar. | Devam etmek için profilinize geçiş anahtarı veya kimlik doğrulayıcı ekleyin. |
| aiRequired | Caller verification is required before this action. | Vor dieser Aktion ist eine Anruferüberprüfung erforderlich. | Debes verificar a quien llama antes de esta acción. | La vérification de l’appelant est requise avant cette action. | La vérification de l’appelant est requise avant cette action. | È necessaria la verifica del chiamante prima dell’azione. | É necessário verificar quem liga antes desta ação. | Bu işlemden önce arayan doğrulaması gereklidir. |
| aiRetry | Verification recorded. Request the action again when ready. | Überprüfung gespeichert. Aktion bei Bereitschaft erneut anfordern. | Verificación registrada. Solicita la acción de nuevo cuando quieras. | Vérification enregistrée. Redemandez l’action lorsque vous serez prêt. | Vérification enregistrée. Redemandez l’action lorsque vous serez prêt. | Verifica registrata. Richiedi di nuovo l’azione quando sei pronto. | Verificação registrada. Solicite a ação novamente quando estiver pronto. | Doğrulama kaydedildi. Hazır olduğunuzda işlemi yeniden isteyin. |
| reasons.no_fresh_verification | No fresh verification meets this action’s requirements. | Keine aktuelle Überprüfung erfüllt die Anforderungen. | Ninguna verificación reciente cumple los requisitos. | Aucune vérification récente ne répond aux exigences. | Aucune vérification récente ne répond aux exigences. | Nessuna verifica recente soddisfa i requisiti. | Nenhuma verificação recente atende aos requisitos. | Güncel hiçbir doğrulama gereksinimleri karşılamıyor. |
| reasons.grant_consumed | This verification has already been used. | Diese Überprüfung wurde bereits verwendet. | Esta verificación ya se utilizó. | Cette vérification a déjà été utilisée. | Cette vérification a déjà été utilisée. | Questa verifica è già stata utilizzata. | Esta verificação já foi utilizada. | Bu doğrulama zaten kullanıldı. |
| reasons.subject_unmatched | No trusted identity binding was found. | Keine vertrauenswürdige Identitätszuordnung gefunden. | No se encontró un vínculo de identidad confiable. | Aucun lien d’identité fiable trouvé. | Aucun lien d’identité fiable trouvé. | Nessun collegamento di identità attendibile trovato. | Nenhum vínculo de identidade confiável encontrado. | Güvenilir kimlik bağı bulunamadı. |
| reasons.subject_ambiguous | Identity bindings conflict; review the contact. | Identitätszuordnungen widersprechen sich; Kontakt prüfen. | Hay vínculos de identidad en conflicto; revisa el contacto. | Les liens d’identité sont en conflit; vérifiez le contact. | Les liens d’identité sont en conflit; vérifiez le contact. | Collegamenti di identità in conflitto; controlla il contatto. | Há vínculos de identidade conflitantes; revise o contato. | Kimlik bağları çakışıyor; kişiyi inceleyin. |
| reasons.subject_mailboxes_unknown | The target mailbox identities could not be checked. | Postfachidentitäten des Ziels konnten nicht geprüft werden. | No se pudieron comprobar las identidades del buzón de destino. | Impossible de vérifier les identités de la boîte cible. | Impossible de vérifier les identités de la boîte cible. | Impossibile verificare le identità della casella di destinazione. | Não foi possível verificar as identidades da caixa de destino. | Hedef posta kutusu kimlikleri kontrol edilemedi. |
| reasons.tenant_mismatch | The connected directory belongs to a different tenant. | Das verbundene Verzeichnis gehört zu einem anderen Mandanten. | El directorio conectado pertenece a otro tenant. | Le répertoire connecté appartient à un autre locataire. | L’annuaire connecté appartient à un autre locataire. | La directory connessa appartiene a un altro tenant. | O diretório conectado pertence a outro locatário. | Bağlı dizin farklı bir kiracıya ait. |
| reasons.requester_not_authorized | This caller cannot authorize the selected target action. | Dieser Anrufer darf die Zielaktion nicht freigeben. | Quien llama no puede autorizar la acción sobre ese destino. | Cet appelant ne peut pas autoriser l’action sur cette cible. | Cet appelant ne peut pas autoriser l’action sur cette cible. | Il chiamante non può autorizzare l’azione sul destinatario. | Quem liga não pode autorizar a ação nesse destino. | Bu arayan seçilen hedef işlemini onaylayamaz. |
| reasons.technician_mismatch | This verification belongs to another technician. | Diese Überprüfung gehört einem anderen Techniker. | Esta verificación pertenece a otro técnico. | Cette vérification appartient à un autre technicien. | Cette vérification appartient à un autre technicien. | Questa verifica appartiene a un altro tecnico. | Esta verificação pertence a outro técnico. | Bu doğrulama başka bir teknisyene ait. |
| reasons.target_rebound | The target identity changed; verify again. | Zielidentität geändert; erneut überprüfen. | La identidad de destino cambió; verifica de nuevo. | L’identité cible a changé; vérifiez de nouveau. | L’identité cible a changé; vérifiez de nouveau. | L’identità di destinazione è cambiata; verifica di nuovo. | A identidade de destino mudou; verifique novamente. | Hedef kimliği değişti; yeniden doğrulayın. |
| reasons.stepup_invalidated | The MFA proof is no longer valid; verify again. | MFA-Nachweis nicht mehr gültig; erneut bestätigen. | La prueba MFA ya no es válida; verifica de nuevo. | La preuve MFA n’est plus valide; vérifiez de nouveau. | La preuve MFA n’est plus valide; vérifiez de nouveau. | La prova MFA non è più valida; verifica di nuovo. | A prova MFA não é mais válida; verifique novamente. | MFA kanıtı artık geçerli değil; yeniden doğrulayın. |
| scriptActions.reset_password | reset your password | Ihr Passwort zurücksetzen | restablecer tu contraseña | réinitialiser votre mot de passe | réinitialiser votre mot de passe | reimpostare la tua password | redefinir sua senha | parolanızı sıfırlamak |
| scriptActions.disable_user | disable the account | das Konto deaktivieren | deshabilitar la cuenta | désactiver le compte | désactiver le compte | disabilitare l’account | desativar a conta | hesabı devre dışı bırakmak |
| scriptActions.any | confirm this request | diese Anfrage bestätigen | confirmar esta solicitud | confirmer cette demande | confirmer cette demande | confermare questa richiesta | confirmar esta solicitação | bu isteği onaylamak |
<!-- caller-catalog-end -->

Use the following exact generator from repository root during implementation. It writes only the eight listed catalogs; it does not rewrite this plan.

```python
import json
from pathlib import Path
plan = Path('docs/superpowers/plans/security-auth/2026-09-19-caller-verification-w04-web.md').read_text()
block = plan.split('<!-- caller-catalog-start -->', 1)[1].split('<!-- caller-catalog-end -->', 1)[0]
lines = [line for line in block.splitlines() if line.startswith('|')]
locales = [cell.strip() for cell in lines[0].split('|')[2:-1]]
catalogs = {locale: {} for locale in locales}
for line in lines[2:]:
    cells = [cell.strip() for cell in line.split('|')[1:-1]]
    assert len(cells) == 9, cells[0]
    for locale, value in zip(locales, cells[1:]):
        target = catalogs[locale]
        parts = cells[0].split('.')
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
for locale, catalog in catalogs.items():
    Path(f'apps/web/src/locales/{locale}/callerVerification.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
```

Add `'callerVerification.json': 0,` to each of the seven `namespaceDuplicateBaselines` objects. The matrix intentionally has zero exact-English duplicates outside en. No index.ts namespace edit is needed. CONTACT_ROLES labels reuse `settings:contactsCard.roles.*`, already translated for all seven valid roles.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/lib/i18n/callerVerification.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts` → exact key/token parity and zero duplicate growth.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/locales/*/callerVerification.json apps/web/src/lib/i18n/callerVerification.test.ts apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): translate caller verification in all eight locales"
```

### Task 4: Requester picker and action/method selection modal

**Files:** Create `apps/web/src/components/callerVerification/ContactPicker.tsx`, `apps/web/src/components/callerVerification/ContactPicker.test.tsx`, `apps/web/src/components/callerVerification/VerifyCallerModal.tsx`, `apps/web/src/components/callerVerification/VerifyCallerModal.test.tsx` in that same directory. Reference `apps/web/src/components/devices/ManualAssetModal.tsx:161–195,560–595` (inline contact picker), `apps/api/src/routes/orgContacts.ts:46–54,250–275` (paged list, no search parameter).

**Interfaces:** Consumes `contactsPage`, `methodsForContact`, `deviceSuggestions`, `getPolicy`, `startVerification`. Produces `ContactPicker({orgId,value,onChange,label}): ReactNode` and `VerifyCallerModal(props: VerifyCallerModalProps): ReactNode`. There is no reusable existing contact-picker component; create this smallest reusable addition without rewriting ManualAssetModal.

- [ ] **Step 1: Write failing component tests using real i18n, matching ContactsCard.test.tsx and MaintenanceModeDialog.test.tsx.**

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/callerVerification';
import { VerifyCallerModal } from './VerifyCallerModal';
import { ORG, CONTACT, TARGET, row, policy } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.contactsPage).mockResolvedValue({ data: [{ id: CONTACT, name: 'Ada', email: null, siteId: null, roles: ['admin'] }, { id: TARGET, name: 'Grace', email: null, siteId: null, roles: [] }], pagination: { page: 1, total: 2, limit: 100 } });
  vi.mocked(api.getPolicy).mockResolvedValue({ row: null, defaults: policy, baseline: policy, effective: policy });
  vi.mocked(api.deviceSuggestions).mockResolvedValue([]);
  vi.mocked(api.methodsForContact).mockResolvedValue([{ method: 'sms', available: true, tier: 2, reason: 'destination_established' }, { method: 'workstation', available: false, tier: 1, reason: 'unbound_principal', unavailableReason: 'helper_outdated' }]);
  vi.mocked(api.startVerification).mockResolvedValue(row);
});
it('shows server tiers and the disabled-method reason', async () => {
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('cv-next')).toBeEnabled());
  fireEvent.click(screen.getByTestId('cv-next'));
  expect(await screen.findByTestId('cv-method-sms')).toHaveTextContent('Assurance tier 2');
  expect(screen.getByTestId('cv-method-workstation')).toBeDisabled();
  expect(screen.getByText('The desktop helper needs an update.')).toBeVisible();
});
it('pins a different target only for disable_user and resets it when action changes', async () => {
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} onClose={vi.fn()} />);
  fireEvent.change(await screen.findByTestId('cv-action'), { target: { value: 'disable_user' } });
  fireEvent.click(screen.getByTestId('cv-different-target'));
  await waitFor(() => expect(screen.getByTestId('cv-target').querySelector(`option[value="${TARGET}"]`)).not.toBeNull());
  fireEvent.change(screen.getByTestId('cv-target'), { target: { value: TARGET } });
  fireEvent.change(screen.getByTestId('cv-action'), { target: { value: 'reset_password' } });
  await waitFor(() => expect(screen.getByTestId('cv-next')).toBeEnabled());
  fireEvent.click(screen.getByTestId('cv-next'));
  fireEvent.click(await screen.findByTestId('cv-method-sms'));
  fireEvent.click(screen.getByTestId('cv-start'));
  await waitFor(() => expect(api.startVerification).toHaveBeenCalledWith(expect.objectContaining({ contactId: CONTACT, actionScope: 'reset_password' })));
  expect(vi.mocked(api.startVerification).mock.calls[0][0].targetContactId).toBeUndefined();
});
```

`ContactPicker.test.tsx` adds a paginated-selection regression:

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { contactsPage } from '@/lib/api/callerVerification';
import { ContactPicker } from './ContactPicker';
import { ORG, CONTACT } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
it('loads a later page and returns the canonical contact id', async () => {
  vi.mocked(contactsPage).mockResolvedValueOnce({ data: [], pagination: { page: 1, total: 101, limit: 100 } }).mockResolvedValueOnce({ data: [{ id: CONTACT, name: 'Ada', email: null, siteId: null, roles: [] }], pagination: { page: 2, total: 101, limit: 100 } });
  const change = vi.fn(); render(<ContactPicker orgId={ORG} value="" onChange={change} label="Caller" />);
  fireEvent.click(await screen.findByText('Load more contacts'));
  await screen.findByText('Ada');
  fireEvent.change(screen.getByLabelText('Caller'), { target: { value: CONTACT } });
  expect(change).toHaveBeenCalledWith(CONTACT);
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/ContactPicker.test.tsx src/components/callerVerification/VerifyCallerModal.test.tsx` → absent components.
- [ ] **Step 3: Implement the picker and modal selection.**

```tsx
// ContactPicker.tsx
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { contactsPage, type ContactOption } from '@/lib/api/callerVerification';
export function ContactPicker({ orgId, value, onChange, label, testId }: { orgId: string; value: string; onChange: (id: string) => void; label: string; testId?: string }) {
  const { t } = useTranslation('callerVerification'); const id = useId();
  const [items, setItems] = useState<ContactOption[]>([]); const [page, setPage] = useState(1);
  const [more, setMore] = useState(false); const [query, setQuery] = useState('');
  const [error, setError] = useState(false); const [loading, setLoading] = useState(true); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false);
    void contactsPage(orgId, page, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setItems(old => [...new Map([...(page === 1 ? [] : old), ...result.data].map(c => [c.id, c])).values()]);
      setMore(result.pagination.page * result.pagination.limit < result.pagination.total);
    }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [orgId, page, retry]);
  const visible = items.filter(c => c.id === value || `${c.name ?? ''} ${c.email ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return <div><label htmlFor={`${id}-filter`}>{t('searchContacts')}</label><input id={`${id}-filter`} value={query} onChange={e => setQuery(e.target.value)} />
    <label htmlFor={id}>{label}</label><select id={id} data-testid={testId} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t('selectContact')}</option>
      {value && !items.some(c => c.id === value) && <option value={value}>{value}</option>}
      {visible.map(c => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.id}</option>)}
    </select>{!loading && !visible.length && <p>{t('noContacts')}</p>}
    {loading && <p role="status">{t('loading')}</p>}{error && <p role="alert">{t('loadFailed')}</p>}
    {(more || error) && <button type="button" disabled={loading} onClick={() => error ? setRetry(n => n + 1) : setPage(p => p + 1)}>{t('more')}</button>}
  </div>;
}
```

Parent modal is keyed by org/context at every mount, so an org switch destroys picker state. Retries retain the failed page and retrigger its request.

```tsx
// VerifyCallerModal.tsx — complete selection controller; Task 5 adds status JSX.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/shared/Dialog';
import { handleActionError } from '@/lib/runAction';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import * as api from '@/lib/api/callerVerification';
import { ContactPicker } from './ContactPicker';
export interface VerifyCallerModalProps {
  orgId: string; initialContactId?: string; initialAction?: api.CallerVerificationActionScope;
  deviceId?: string; ticketId?: string; initialMethod?: api.StartInput['method'];
  onClose: () => void; onChanged?: (row: api.VerificationDetails) => void;
}
export function VerifyCallerModal(props: VerifyCallerModalProps) {
  return useCallerVerificationEnabled() ? <VerificationFlow key={`${props.orgId}:${props.initialContactId ?? ''}`} {...props} /> : null;
}
function VerificationFlow(props: VerifyCallerModalProps) {
  const { t } = useTranslation('callerVerification');
  const [step, setStep] = useState(0); const [action, setAction] = useState(props.initialAction ?? 'reset_password');
  const [contact, setContact] = useState(props.initialContactId ?? ''); const [target, setTarget] = useState('');
  const [different, setDifferent] = useState(false); const [method, setMethod] = useState(props.initialMethod);
  const [device, setDevice] = useState(props.deviceId ?? ''); const [username, setUsername] = useState('');
  const [ticket, setTicket] = useState(props.ticketId ?? ''); const [note, setNote] = useState('');
  const [methods, setMethods] = useState<api.MethodAvailability[]>([]);
  const [suggestions, setSuggestions] = useState<api.DeviceSuggestion[]>([]);
  const [policy, setPolicy] = useState<api.EffectiveCallerVerificationPolicy | null>(null);
  const [row, setRow] = useState<api.VerificationDetails | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(false); const [retryLoad, setRetryLoad] = useState(0);
  const busy = useRef(false); const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!contact) return;
    const controller = new AbortController(); setLoading(true); setError(false); setMethods([]); setPolicy(null);
    void Promise.all([api.methodsForContact(props.orgId, contact, action, controller.signal), api.deviceSuggestions(props.orgId, contact, controller.signal), api.getPolicy({ ownerScope: 'organization', orgId: props.orgId }, controller.signal)]).then(([m, d, p]) => {
      if (controller.signal.aborted) return;
      setMethods(m); setSuggestions(d); setPolicy(p.effective);
      const selected = d.find(s => s.deviceId === device); setUsername(selected?.username ?? '');
    }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.orgId, contact, action, retryLoad]);
  const selected = methods.find(m => m.method === method);
  const canStart = !!contact && !!policy && !!selected?.available && (!policy.requireTicket || !!ticket) &&
    (action !== 'disable_user' || !different || !!target) && (method !== 'workstation' || (!!device && !!username.trim()));
  async function start() {
    if (busy.current || !canStart || !method) return;
    busy.current = true; setSaving(true);
    try {
      const created = await api.startVerification({ orgId: props.orgId, contactId: contact, method, actionScope: action,
        ...(action === 'disable_user' && different ? { targetContactId: target } : {}),
        ...(method === 'workstation' ? { deviceId: device, username: username.trim() } : {}),
        ...(ticket ? { ticketId: ticket } : {}) });
      setRow(created); setStep(2); props.onChanged?.(created);
    } catch (e) { handleActionError(e, t('saveFailed')); } finally { busy.current = false; setSaving(false); }
  }
  return <Dialog open title={t('title')} onClose={() => { if (!saving) props.onClose(); }} maxWidth="2xl" className="p-6 space-y-4">
    <h2>{t('title')}</h2>
    {step === 0 && <fieldset disabled={saving}><label>{t('action')}<select data-testid="cv-action" value={action} onChange={e => { setAction(e.target.value as api.CallerVerificationActionScope); setDifferent(false); setTarget(''); setMethod(props.initialMethod); }}>
      {(['reset_password', 'disable_user', 'any'] as const).map(a => <option key={a} value={a}>{t(/* i18n-dynamic */ `actions.${a}`)}</option>)}
    </select></label><ContactPicker orgId={props.orgId} value={contact} onChange={id => { setContact(id); setTarget(''); setMethod(props.initialMethod); }} label={t('requester')} />
      {action === 'disable_user' && <><label><input data-testid="cv-different-target" type="checkbox" checked={different} onChange={e => setDifferent(e.target.checked)} />{t('differentTarget')}</label>
        {different && <ContactPicker orgId={props.orgId} value={target} onChange={setTarget} label={t('target')} testId="cv-target" />}</>}
      <label>{t('ticket')}<input value={ticket} onChange={e => setTicket(e.target.value)} readOnly={!!props.ticketId} /></label>
      {policy?.requireTicket && !ticket && <p>{t('ticketRequired')}</p>}
      <button data-testid="cv-next" disabled={!contact || loading || !policy || (different && !target)} onClick={() => setStep(1)}>{t('next')}</button></fieldset>}
    {step === 1 && <fieldset disabled={saving}><div className="grid gap-3 sm:grid-cols-2">{methods.filter(m => m.method !== 'administrative_stepup').map(m => {
      const bound = suggestions.find(s => s.deviceId === device && s.username === username)?.hasBinding === true;
      const tier = m.method === 'workstation' && !bound ? Math.min(m.tier, 1) : m.tier;
      const reason = m.unavailableReason ?? (m.method === 'workstation' && !bound ? 'no_binding' : m.reason);
      return <div key={m.method}><button data-testid={`cv-method-${m.method}`} disabled={!m.available} aria-pressed={method === m.method} className="w-full rounded border p-4 text-left disabled:opacity-50" onClick={() => setMethod(m.method as api.StartInput['method'])}>
        {t(/* i18n-dynamic */ `methods.${m.method}`)}<span className="block">{t('tier', { tier })}</span></button>
        <p>{t(/* i18n-dynamic */ `reasons.${reason}`, { defaultValue: t('reasons.unknown') })}</p></div>;
    })}</div>{method === 'workstation' && <><label>{t('device')}<select value={device} onChange={e => { setDevice(e.target.value); setUsername(suggestions.find(s => s.deviceId === e.target.value)?.username ?? ''); }}>
      <option value="">{t('device')}</option>{props.deviceId && !suggestions.some(s => s.deviceId === props.deviceId) && <option value={props.deviceId}>{props.deviceId}</option>}
      {suggestions.map(s => <option key={s.deviceId} value={s.deviceId}>{s.hostname}</option>)}
    </select></label><label>{t('username')}<input maxLength={255} data-testid="cv-username" value={username} onChange={e => setUsername(e.target.value)} /></label></>}
      <button onClick={() => setStep(0)}>{t('back')}</button><button data-testid="cv-start" disabled={!canStart || saving} onClick={() => void start()}>{t('start')}</button></fieldset>}
    {loading && <p role="status">{t('loading')}</p>}{error && <p role="alert">{t('loadFailed')}<button onClick={() => setRetryLoad(n => n + 1)}>{t('retry')}</button></p>}
    <button disabled={saving} onClick={props.onClose}>{t('close')}</button>
  </Dialog>;
}
```

Add a “confirm username” checkbox after the username input, using the same translated label, and require it in `canStart` for workstation. Reset confirmation whenever contact/device/username changes. A pre-filled username is a suggestion, not confirmation. Task 5 owns cancellation and step-2 markup; `row`, `note`, and `setNote` are intentionally consumed there. The load-retry button retriggers all three reads after a transient failure.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/ContactPicker.test.tsx src/components/callerVerification/VerifyCallerModal.test.tsx` → tier/availability and target-reset assertions pass.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/ContactPicker.tsx apps/web/src/components/callerVerification/ContactPicker.test.tsx apps/web/src/components/callerVerification/VerifyCallerModal.tsx apps/web/src/components/callerVerification/VerifyCallerModal.test.tsx
git commit -m "feat(web): select caller action target and verification method"
```

### Task 5: Polling, challenge script, terminal states, retry and cancel

**Files:** Create `apps/web/src/components/callerVerification/useVerification.ts`, `apps/web/src/components/callerVerification/useVerification.test.tsx`, `apps/web/src/components/callerVerification/VerificationStatus.tsx`, `apps/web/src/components/callerVerification/VerificationStatus.test.tsx`. Modify `apps/web/src/components/callerVerification/VerifyCallerModal.tsx` created in Task 4 (VerificationFlow state and step-2 slot).

**Interfaces:** Consumes `getVerification(orgId,id,signal): Promise<VerificationDetails>`. Produces `useVerification(orgId: string, initial: VerificationDetails | null): {row: VerificationDetails | null; error: boolean}` and `VerificationStatus({row, now?, userId?}): ReactNode`.

- [ ] **Step 1: Write failing tests.**

```tsx
// useVerification.test.tsx
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getVerification } from '@/lib/api/callerVerification';
import { useVerification } from './useVerification';
import { ORG, row } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('polls every 2 s, refreshes a verified row for late rejection, stops after unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(getVerification).mockResolvedValueOnce({ ...row, status: 'verified', usableUntil: '2026-09-19T12:30:00Z' }).mockResolvedValueOnce({ ...row, status: 'rejected_by_user', incidentId: row.id });
  const { result, unmount } = renderHook(() => useVerification(ORG, row));
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(getVerification).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.row?.status).toBe('verified');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.row?.status).toBe('rejected_by_user');
  unmount(); await vi.advanceTimersByTimeAsync(10000);
  expect(getVerification).toHaveBeenCalledTimes(2);
});
```

```tsx
// VerificationStatus.test.tsx
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { VerificationStatus } from './VerificationStatus';
import { row, USER } from './testFixtures';
it('renders initiator-only codes with the request-confirmation script', () => {
  render(<VerificationStatus row={row} userId={USER} />);
  expect(screen.getByTestId('cv-match')).toHaveTextContent('42');
  expect(screen.getByTestId('cv-reverse')).toHaveTextContent('7 3 1 9');
  expect(screen.getByTestId('cv-script')).toHaveTextContent("If anything on it looks wrong");
  expect(screen.getByTestId('cv-script')).not.toHaveTextContent(/proves/i);
});
it('does not confuse challenge expiry with grant expiry', () => {
  render(<VerificationStatus userId={USER} now={Date.parse('2026-09-19T12:15:00Z')} row={{ ...row, status: 'verified', usableUntil: '2026-09-19T12:30:00Z' }} />);
  expect(screen.getByText(/expires in 15 min/)).toBeVisible();
});
it('shows the concrete delivery failure and remaining attempts', () => {
  const view = render(<VerificationStatus row={{ ...row, status: 'undeliverable', undeliverableReason: 'session_not_console' }} />);
  expect(screen.getByText('The user is not in the console session.')).toBeVisible();
  view.rerender(<VerificationStatus row={{ ...row, status: 'wrong_choice', remainingAttempts: 1 }} />);
  expect(screen.getByText('Remaining attempts: 1')).toBeVisible();
  view.rerender(<VerificationStatus row={{ ...row, status: 'rejected_by_user', incidentId: row.id }} />);
  expect(screen.getByRole('link')).toHaveAttribute('href', `/incidents/${row.id}`);
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/useVerification.test.tsx src/components/callerVerification/VerificationStatus.test.tsx` → imports fail.
- [ ] **Step 3: Implement polling and presentation.**

```tsx
// useVerification.ts
import { useEffect, useState } from 'react';
import { getVerification, type VerificationDetails } from '@/lib/api/callerVerification';
export function useVerification(orgId: string, initial: VerificationDetails | null) {
  const [row, setRow] = useState(initial); const [error, setError] = useState(false);
  useEffect(() => {
    setRow(initial); setError(false); if (!initial) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await getVerification(orgId, initial!.id, controller.signal); if (!controller.signal.aborted) { setRow(next); setError(false); } }
      catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    timer = setTimeout(() => void poll(), 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [orgId, initial]);
  return { row, error };
}
```

Keep polling all visible statuses, not only pending: rejection is valid after expiry/verification. Await the previous GET before scheduling another. A failed GET removes any affirmative freshness claim by rendering the error instead of stale green status; it never fabricates `expired`. `initial` is stable state, not an inline object recreated on render.

```tsx
// VerificationStatus.tsx
import { useTranslation } from 'react-i18next';
import type { VerificationDetails } from '@/lib/api/callerVerification';
export function VerificationStatus({ row, now = Date.now(), userId }: { row: VerificationDetails; now?: number; userId?: string }) {
  const { t } = useTranslation('callerVerification');
  const action = t(/* i18n-dynamic */ `actions.${row.actionScope}`);
  const fresh = row.usableUntil !== null && Date.parse(row.usableUntil) > now;
  const owns = userId === row.initiatedByUserId;
  const showCodes = owns && row.status === 'pending' && row.secrets && row.method !== 'callback_attestation';
  return <section className={row.status === 'rejected_by_user' ? 'rounded border border-destructive bg-destructive/10 p-4' : 'space-y-3'}>
    <p role="status" aria-live="polite">{t(/* i18n-dynamic */ `states.${row.status}`)}</p>
    {showCodes && <><p>{t('match')}</p><strong data-testid="cv-match" className="block text-7xl tabular-nums">{row.secrets!.matchValue}</strong>
      <p>{t('reverse')}</p><strong data-testid="cv-reverse" className="block text-5xl tabular-nums">{row.secrets!.reverseCode.split('').join(' ')}</strong>
      {row.method !== 'workstation' && <p>{t('linkScript')}</p>}
      <p data-testid="cv-script">{t('script', { code: row.secrets!.reverseCode.split('').join(' '), number: row.secrets!.matchValue, action: t(/* i18n-dynamic */ `scriptActions.${row.actionScope}`), target: row.targetLabel ?? action })}</p><p>{t('knownNumber')}</p></>}
    {row.status === 'verified' && (row.consumedAt ? <p>{t('used', { action: row.consumedAction ? t(/* i18n-dynamic */ `actions.${row.consumedAction}`) : action })}</p> : fresh && owns ?
      <p>{t('usable', { action, minutes: Math.max(1, Math.ceil((Date.parse(row.usableUntil!) - now) / 60000)) })}</p> :
      <p>{fresh ? t('anotherTechnician', { technician: row.technicianLabel }) : t('states.expired')}</p>)}
    {row.status === 'wrong_choice' && row.remainingAttempts !== null && <p>{t('remaining', { attempts: row.remainingAttempts })}</p>}
    {row.status === 'undeliverable' && <p>{t(/* i18n-dynamic */ `reasons.${row.undeliverableReason ?? 'unknown'}`)}</p>}
    {row.status === 'rejected_by_user' && row.incidentId && <a href={`/incidents/${encodeURIComponent(row.incidentId)}`}>{t('incident')}</a>}
  </section>;
}
```

In VerificationFlow, import `useAuthStore`, `useVerification`, `VerificationStatus`; add this code before the return, and insert the JSX at the step-2 slot. Changed rows refresh parent history/feed through a stable callback ref so a parent rerender does not restart polling. Call `onChanged` only when status/consumption/incident/freshness actually changes.

```tsx
const userId = useAuthStore(s => s.user?.id);
const polled = useVerification(props.orgId, row);
const current = polled.row;
const onChangedRef = useRef(props.onChanged);
onChangedRef.current = props.onChanged;
useEffect(() => { if (current) onChangedRef.current?.(current); }, [current?.id, current?.status, current?.consumedAt, current?.incidentId, current?.usableUntil]);
async function cancel() {
  if (!current || busy.current) return;
  busy.current = true; setSaving(true);
  try { const cancelled = await api.cancelVerification(props.orgId, current.id); setRow(cancelled); }
  catch (e) { handleActionError(e, t('saveFailed')); }
  finally { busy.current = false; setSaving(false); }
}
async function attest() {
  if (!current || busy.current || note.trim().length < 20) return;
  busy.current = true; setSaving(true);
  try { setRow(await api.attestVerification(props.orgId, current.id, note.trim())); }
  catch (e) { handleActionError(e, t('saveFailed')); }
  finally { busy.current = false; setSaving(false); }
}
```

```tsx
{step === 2 && current && <>
  {polled.error ? <p role="alert">{t('loadFailed')}</p> : <VerificationStatus row={current} userId={userId} />}
  {current.status === 'pending' && current.method === 'callback_attestation' && <>
    <label>{t('note')}<textarea maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></label>
    <button disabled={saving || note.trim().length < 20} onClick={() => void attest()}>{t('attestCallback')}</button></>}
  {current.status === 'pending' && <button disabled={saving} onClick={() => void cancel()}>{t('cancel')}</button>}
  {['wrong_choice', 'expired', 'undeliverable'].includes(current.status) && <button disabled={saving || !current.remainingAttempts || polled.error} onClick={() => { setRow(null); setStep(1); }}>{t('retry')}</button>}
</>}
```

Closing merely dismisses the monitor; the explicit cancel button mutates the pending challenge. Retry creates a new verification, never resubmits a number to a terminal row. Clear note and method on contact/action changes. Do not render candidate decoys to the technician.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/useVerification.test.tsx src/components/callerVerification/VerificationStatus.test.tsx src/components/callerVerification/VerifyCallerModal.test.tsx` → pass, including this deferred-result regression:

```tsx
it('aborts a request that resolves after the monitor is unmounted', async () => {
  vi.useFakeTimers(); let resolve!: (value: typeof row) => void;
  vi.mocked(getVerification).mockReturnValue(new Promise(r => { resolve = r; }));
  const { unmount } = renderHook(() => useVerification(ORG, row));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const signal = vi.mocked(getVerification).mock.calls[0][2]!;
  unmount(); expect(signal.aborted).toBe(true); resolve({ ...row, status: 'verified' });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(getVerification).toHaveBeenCalledTimes(1);
});
```
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/useVerification.ts apps/web/src/components/callerVerification/useVerification.test.tsx apps/web/src/components/callerVerification/VerificationStatus.tsx apps/web/src/components/callerVerification/VerificationStatus.test.tsx apps/web/src/components/callerVerification/VerifyCallerModal.tsx apps/web/src/components/callerVerification/VerifyCallerModal.test.tsx
git commit -m "feat(web): monitor caller verification decisions and single-use status"
```

### Task 6: Shared hash launcher and accurate ticket badge

**Files:** Create `apps/web/src/components/callerVerification/CallerVerificationEntry.tsx`, `apps/web/src/components/callerVerification/CallerVerificationEntry.test.tsx`, `apps/web/src/components/callerVerification/TicketVerificationBadge.tsx`, `apps/web/src/components/callerVerification/TicketVerificationBadge.test.tsx`.

**Interfaces:** Produces `CallerVerificationEntry(props: Omit<VerifyCallerModalProps,'onClose'> & {hash: string}): ReactNode`; `TicketVerificationBadge({orgId,ticketId,revision?}): ReactNode`. Consumes `freshForTicket`, never synthesizes badge state from contact history.

- [ ] **Step 1: Write failing tests.**

```tsx
// TicketVerificationBadge.test.tsx
import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { freshForTicket } from '@/lib/api/callerVerification';
import { TicketVerificationBadge } from './TicketVerificationBadge';
import { ORG, row } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
it('uses server freshness and consumed action, including any-scope grants', async () => {
  vi.mocked(freshForTicket).mockResolvedValue({ row: { ...row, status: 'verified', decidedAt: new Date(Date.now() - 720000).toISOString(), usableUntil: new Date(Date.now() + 900000).toISOString() }, isFresh: true, isConsumed: false });
  const view = render(<TicketVerificationBadge orgId={ORG} ticketId={row.id} />);
  expect(await screen.findByTestId('cv-badge')).toHaveTextContent('12 min ago');
  expect(screen.getByTestId('cv-badge')).toHaveTextContent('Unused');
  vi.mocked(freshForTicket).mockResolvedValue({ row: { ...row, actionScope: 'any', status: 'verified', consumedAction: 'reset_password', consumedAt: row.createdAt }, isFresh: false, isConsumed: true });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={row.id} revision={1} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Used for Reset password'));
  vi.mocked(freshForTicket).mockResolvedValue({ row, isFresh: false, isConsumed: false });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={row.id} revision={2} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Verification expired'));
});
```

```tsx
// CallerVerificationEntry.test.tsx
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CallerVerificationEntry } from './CallerVerificationEntry';
import { ORG } from './testFixtures';
const enabled = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
vi.mock('./VerifyCallerModal', () => ({ VerifyCallerModal: () => <div data-testid="modal" /> }));
it('does not mount even when a verification hash is forged while disabled', () => {
  window.location.hash = 'overview/caller-verification';
  render(<CallerVerificationEntry orgId={ORG} hash="overview/caller-verification" />);
  expect(screen.queryByText('Verify caller')).toBeNull(); expect(screen.queryByTestId('modal')).toBeNull();
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/TicketVerificationBadge.test.tsx src/components/callerVerification/CallerVerificationEntry.test.tsx` → missing modules.
- [ ] **Step 3: Implement.**

```tsx
// CallerVerificationEntry.tsx
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { useHashState } from '@/lib/useHashState';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { VerifyCallerModal, type VerifyCallerModalProps } from './VerifyCallerModal';
export function CallerVerificationEntry({ hash, ...props }: Omit<VerifyCallerModalProps, 'onClose'> & { hash: string }) {
  const { t } = useTranslation('callerVerification'); const enabled = useCallerVerificationEnabled();
  const [open, setOpen] = useHashState(false, raw => raw === hash);
  const previousHash = useRef<string | null>(null);
  if (!enabled) return null;
  const close = () => { setOpen(false); window.location.hash = previousHash.current ?? hash.split('/')[0]; };
  return <><button data-testid="cv-entry" onClick={() => { previousHash.current = window.location.hash; setOpen(true); window.location.hash = hash; }}>{t('title')}</button>
    {open && <VerifyCallerModal {...props} onClose={close} />}</>;
}
```

```tsx
// TicketVerificationBadge.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { freshForTicket, type TicketVerification } from '@/lib/api/callerVerification';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
type Props = { orgId: string; ticketId: string; revision?: number };
export function TicketVerificationBadge(props: Props) { return useCallerVerificationEnabled() ? <LoadedBadge key={`${props.orgId}:${props.ticketId}`} {...props} /> : null; }
function LoadedBadge({ orgId, ticketId, revision }: Props) {
  const { t } = useTranslation('callerVerification'); const [data, setData] = useState<TicketVerification | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const result = await freshForTicket(orgId, ticketId, controller.signal); if (!controller.signal.aborted) setData(result); }
      catch { if (!controller.signal.aborted) setData(null); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [orgId, ticketId, revision]);
  if (!data?.row) return null;
  const row = data.row; const fresh = row.status === 'verified' && data.isFresh && !!row.usableUntil && Date.parse(row.usableUntil) > Date.now();
  const age = t('age', { minutes: Math.max(0, Math.floor((Date.now() - Date.parse(row.decidedAt ?? row.createdAt)) / 60000)) });
  if (data.isConsumed && !row.consumedAction) return null;
  const used = data.isConsumed && row.consumedAction;
  const text = !['verified', 'pending', 'expired'].includes(row.status) ? t(/* i18n-dynamic */ `states.${row.status}`) : used ? t('used', { action: t(/* i18n-dynamic */ `actions.${row.consumedAction}`) }) : fresh ? t('unused') : t('states.expired');
  return <span data-testid="cv-badge" className={fresh && !used ? 'text-emerald-700' : 'text-muted-foreground'}>
    {fresh || used ? `${t('states.verified')} · ${t(/* i18n-dynamic */ `methods.${row.method}`)} · ${age} · ${text}` : text}
  </span>;
}
```

Rejected/revoked/cancelled rows show their actual state. W05 must supply `consumedAction` whenever `isConsumed` is true; until that projection is delivered, withhold an ambiguous consumed badge rather than inventing the operation. The guard before badge text enforces that rule.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/TicketVerificationBadge.test.tsx src/components/callerVerification/CallerVerificationEntry.test.tsx` → pass.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/CallerVerificationEntry.tsx apps/web/src/components/callerVerification/CallerVerificationEntry.test.tsx apps/web/src/components/callerVerification/TicketVerificationBadge.tsx apps/web/src/components/callerVerification/TicketVerificationBadge.test.tsx
git commit -m "feat(web): caller verification launcher and ticket grant badge"
```

### Task 7: Mount the ticket header workflow and prove timeline comments

**Files:** Modify `apps/web/src/components/tickets/ticketConfig.ts:58`, `TicketWorkbench.tsx:998–1016,1481–1487`, `apps/web/src/components/tickets/TicketWorkbench.test.tsx:1–50`, `apps/web/src/components/tickets/TicketFeed.test.tsx:42–89` in the same tickets directory.

**Interfaces:** Consumes the API's existing `requesterContactId` (full row selected at `apps/api/src/routes/tickets/tickets.ts:141–145`, spread at `:535`). Produces header `CallerVerificationEntry` + `TicketVerificationBadge`, keyed to ticket/org, and calls the existing `load` callback after verification changes. `submittedBy` remains a portal user ID, never a contact selector value.

- [ ] **Step 1: Add failing mount and timeline tests using verified existing helpers.**

```tsx
// TicketWorkbench.test.tsx: module-level child spies, then a new test.
vi.mock('../callerVerification/CallerVerificationEntry', () => ({ CallerVerificationEntry: (p: Record<string, unknown>) => <div data-testid="cv-ticket-entry" data-props={JSON.stringify(p)} /> }));
vi.mock('../callerVerification/TicketVerificationBadge', () => ({ TicketVerificationBadge: (p: Record<string, unknown>) => <div data-testid="cv-ticket-badge" data-props={JSON.stringify(p)} /> }));
it('mounts verification with canonical requesterContactId rather than portal submittedBy', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const contactId = '22222222-2222-4222-8222-222222222222';
  mockTicketApi({ 'tk-1': makeTicket({ orgId, requesterContactId: contactId, submittedBy: 'portal-user-7' }) });
  render(<TicketWorkbench ticketId="tk-1" />);
  await screen.findByTestId('ticket-workbench');
  expect(JSON.parse(screen.getByTestId('cv-ticket-entry').getAttribute('data-props')!)).toMatchObject({ orgId, ticketId: 'tk-1', initialContactId: contactId });
  expect(JSON.parse(screen.getByTestId('cv-ticket-badge').getAttribute('data-props')!)).toMatchObject({ orgId, ticketId: 'tk-1' });
});
// TicketFeed.test.tsx: makeComment and TicketFeed are existing imports/helper.
it('renders W01 caller-verification system comments', () => {
  const content = 'Caller verification started: SMS for password reset.';
  render(<TicketFeed comments={[makeComment({ commentType: 'system', authorType: 'system', authorName: null, userId: null, isPublic: false, content })]} />);
  expect(screen.getByText(content)).toBeVisible();
  expect(screen.queryByTestId('ticket-feed-system-collapsed')).toBeNull();
});
```

No new timeline renderer is required: `TicketFeed.tsx:10,32,51–74` already recognizes system comments and renders their content.

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/tickets/TicketWorkbench.test.tsx src/components/tickets/TicketFeed.test.tsx` → header mount missing; comment case documents existing behavior.
- [ ] **Step 3: Implement the mount.** Add `requesterContactId?: string | null;` to `TicketDetail`. Import both new components, add `const [verificationRevision, setVerificationRevision] = useState(0);`, and append this JSX to the header metadata row at line 998:

```tsx
<CallerVerificationEntry key={`${ticket.orgId}:${ticket.id}`} orgId={ticket.orgId}
  initialContactId={ticket.requesterContactId ?? undefined} ticketId={ticket.id}
  hash={`caller-verification/${ticket.id}`}
  onChanged={() => { setVerificationRevision(n => n + 1); void load(); }} />
<TicketVerificationBadge orgId={ticket.orgId} ticketId={ticket.id} revision={verificationRevision} />
```

The existing TicketFeed receives refreshed `ticket.comments` after `load`. Missing requesterContactId opens the explicit picker. A ticket whose contact is changed is still validated by the start endpoint; the browser cannot transfer a grant between requesters. The shared launcher restores its captured previous hash on close, preserving an embedded queue selection.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/tickets/TicketWorkbench.test.tsx src/components/tickets/TicketFeed.test.tsx` → canonical contact ID and system comment visible.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/tickets/ticketConfig.ts apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx apps/web/src/components/tickets/TicketFeed.test.tsx apps/web/src/components/callerVerification/CallerVerificationEntry.tsx
git commit -m "feat(web): verify callers from the ticket header and timeline"
```

### Task 8: Contact drawer history, fence, bindings and destinations

**Files:** Create `apps/web/src/components/callerVerification/ContactVerificationDrawer.tsx`, `apps/web/src/components/callerVerification/ContactVerificationDrawer.test.tsx`. Existing drawer primitive: `apps/web/src/components/shared/Drawer.tsx:31–50` accepts `open`, `onClose`, `title`, `closeDisabled`.

**Interfaces:** Consumes `contactHistory`, `directoryUsers`, `bindContact`, `unbindContact`, `attestDestination`, `fenceOverride`; produces `ContactVerificationDrawer({orgId,contactId,onClose}): ReactNode`. Binding picker accepts only a returned `DirectoryUser`, never free-form identity fields.

- [ ] **Step 1: Write failing tests.**

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/callerVerification';
import { ContactVerificationDrawer } from './ContactVerificationDrawer';
import { ORG, CONTACT, history, row, policy, USER } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('./CallerVerificationEntry', () => ({ CallerVerificationEntry: () => null }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (select: (s: {user: {id: string}}) => unknown) => select({ user: { id: '44444444-4444-4444-8444-444444444444' } }) }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.contactHistory).mockResolvedValue(history); vi.mocked(api.getPolicy).mockResolvedValue({ row: null, defaults: policy, baseline: policy, effective: policy }); });
it('shows the fence and sends its override reason, then reloads', async () => {
  vi.mocked(api.contactHistory).mockResolvedValue({ ...history, fencedUntil: '2099-01-01T00:00:00Z' });
  render(<ContactVerificationDrawer orgId={ORG} contactId={CONTACT} onClose={vi.fn()} />);
  await screen.findByText(/Blocked until/);
  fireEvent.change(screen.getByTestId('cv-fence-reason'), { target: { value: 'Independent investigation completed' } });
  fireEvent.click(screen.getByText('Override the block'));
  await waitFor(() => expect(api.fenceOverride).toHaveBeenCalledWith(ORG, CONTACT, 'Independent investigation completed'));
});
it('attests the destination id and never labels it established optimistically', async () => {
  vi.mocked(api.contactHistory).mockResolvedValue({ ...history, destinations: [{ id: row.id, kind: 'mobile', valueRedacted: '+1 ••12', established: false, attestedAt: null, setAt: row.createdAt, source: 'import' }] });
  render(<ContactVerificationDrawer orgId={ORG} contactId={CONTACT} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByText('Confirm number of record'));
  await waitFor(() => expect(api.attestDestination).toHaveBeenCalledWith(ORG, CONTACT, row.id));
  expect(screen.getByText('Destination is not yet established.')).toBeVisible();
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/ContactVerificationDrawer.test.tsx` → component absent.
- [ ] **Step 3: Implement all management controls.**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer } from '@/components/shared/Drawer';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/lib/permissions';
import { handleActionError } from '@/lib/runAction';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import * as api from '@/lib/api/callerVerification';
import { CallerVerificationEntry } from './CallerVerificationEntry';
import { VerificationStatus } from './VerificationStatus';
type Props = { orgId: string; contactId: string; onClose: () => void };
export function ContactVerificationDrawer(props: Props) { return useCallerVerificationEnabled() ? <LoadedDrawer key={`${props.orgId}:${props.contactId}`} {...props} /> : null; }
function LoadedDrawer({ orgId, contactId, onClose }: Props) {
  const { t } = useTranslation('callerVerification'); const { can } = usePermissions(); const write = can('organizations', 'write');
  const [data, setData] = useState<api.ContactHistory | null>(null); const [revision, setRevision] = useState(0);
  const [effectivePolicy, setEffectivePolicy] = useState<api.EffectiveCallerVerificationPolicy | null>(null);
  const [adminBusy, setAdminBusy] = useState(false); const userId = useAuthStore(s => s.user?.id);
  const [error, setError] = useState(false); const [reason, setReason] = useState('');
  const [query, setQuery] = useState(''); const [search, setSearch] = useState<api.DirectorySearch | null>(null);
  const [searchError, setSearchError] = useState(false); const [selected, setSelected] = useState('');
  const busy = useRef(false); const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [history, policy] = await Promise.all([api.contactHistory(orgId, contactId, controller.signal), api.getPolicy({ ownerScope: 'organization', orgId }, controller.signal)]);
        if (!controller.signal.aborted) { setData(history); setEffectivePolicy(policy.effective); setError(false); }
      } catch { if (!controller.signal.aborted) { setError(true); setEffectivePolicy(null); } }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2000); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [orgId, contactId, revision]);
  useEffect(() => {
    const controller = new AbortController(); setSelected(''); setSearch(null); setSearchError(false);
    if (query.trim().length < 2 || !write) return;
    const timer = setTimeout(() => { void api.directoryUsers(orgId, query.trim(), controller.signal).then(r => { if (!controller.signal.aborted) setSearch(r); }).catch(() => { if (!controller.signal.aborted) setSearchError(true); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [orgId, query, write]);
  async function change(request: () => Promise<unknown>) {
    if (busy.current) return; busy.current = true; setSaving(true);
    try { await request(); setRevision(n => n + 1); setReason(''); }
    catch (e) { handleActionError(e, t('saveFailed')); }
    finally { busy.current = false; setSaving(false); }
  }
  return <Drawer open onClose={onClose} title={t('history')} closeDisabled={saving || adminBusy} closeDisabledReason={t('loading')}>
    <div className="space-y-6 p-5">
      {write && !error && <CallerVerificationEntry orgId={orgId} initialContactId={contactId} hash={`contacts/${contactId}/verification/start`} onChanged={() => setRevision(n => n + 1)} />}
      {error && <p role="alert">{t('loadFailed')}<button onClick={() => setRevision(n => n + 1)}>{t('retry')}</button></p>}
      {!data && !error && <p role="status">{t('loading')}</p>}
      {data && !error && <>
        {data.fencedUntil && <section><p>{t('fenced', { until: new Date(data.fencedUntil).toLocaleString() })}</p>
          {write && <><label>{t('reason')}<textarea maxLength={4000} data-testid="cv-fence-reason" value={reason} onChange={e => setReason(e.target.value)} /></label>
            <button disabled={saving || reason.trim().length < 20} onClick={() => void change(() => api.fenceOverride(orgId, contactId, reason.trim()))}>{t('override')}</button></>}</section>}
        <section><h3>{t('history')}</h3>{!data.rows.length && <p>{t('empty')}</p>}
          {data.rows.map(r => <VerificationStatus key={r.id} userId={userId} row={{ ...r, secrets: undefined }} />)}</section>
        <section><h3>{t('bindings')}</h3>{data.bindings.map(b => <div key={b.id}><span>{b.upnSnapshot ?? b.osPrincipal ?? b.entraOid}</span>
          {b.revokedAt ? <span>{t('states.revoked')}</span> : write && <button disabled={saving} onClick={() => void change(() => api.unbindContact(orgId, contactId, b.id))}>{t('unbind')}</button>}</div>)}
          {write && <><label>{t('directorySearch')}<input value={query} onChange={e => setQuery(e.target.value)} /></label>
            {searchError && <p role="alert">{t('loadFailed')}</p>}
            {search?.available === false && <p>{t('directoryUnavailable')}</p>}
            {search?.available && <><select aria-label={t('bind')} value={selected} onChange={e => setSelected(e.target.value)}><option value="">{t('bind')}</option>
              {search.users.map(u => <option key={`${u.entraTenantId}:${u.entraOid}`} value={`${u.entraTenantId}:${u.entraOid}`}>{u.displayName} · {u.upn}</option>)}</select>
              <button disabled={!selected || saving} onClick={() => { const user = search.users.find(u => `${u.entraTenantId}:${u.entraOid}` === selected); if (user) void change(() => api.bindContact(orgId, contactId, user)); }}>{t('bind')}</button>
              {search.truncated && <p>{t('truncated')}</p>}</>}</>}
        </section><section><h3>{t('destinations')}</h3><p>{t('attestHelp')}</p>
          {data.destinations.map(d => <div key={d.id}><span>{d.valueRedacted}</span><p>{d.established ? t('reasons.destination_established') : t('reasons.destination_recent')}</p>
            {write && !d.attestedAt && <button disabled={saving} onClick={() => void change(() => api.attestDestination(orgId, contactId, d.id))}>{d.kind === 'mobile' ? t('confirmNumber') : t('confirmDestination')}</button>}</div>)}
        </section>
      </>}
    </div>
  </Drawer>;
}
```

The server may still refuse unbind/attest/override for stale MFA or site scope; `runAction` surfaces those outcomes. Do not promote `established` locally after an attestation: age still applies. W05's incident link may be briefly null while fan-out completes; a reload reveals it. The sequential 2 s history/policy refresh hides stale controls and affirmative status after a failed read; cleanup aborts it on close.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/ContactVerificationDrawer.test.tsx` → fence and destination tests pass. Include this executable binding regression in the same harness:

```tsx
it('binds only the selected Graph result and unbinds by binding id', async () => {
  const user = { entraTenantId: ORG, entraOid: CONTACT, upn: 'ada@example.test', displayName: 'Ada' };
  vi.mocked(api.directoryUsers).mockResolvedValue({ available: true, users: [user], truncated: false });
  vi.mocked(api.contactHistory).mockResolvedValue({ ...history, bindings: [{ id: row.id, entraTenantId: ORG, entraOid: CONTACT, upnSnapshot: user.upn, osPrincipal: null, revokedAt: null }] });
  render(<ContactVerificationDrawer orgId={ORG} contactId={CONTACT} onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Search Entra users'), { target: { value: 'Ada' } });
  await screen.findByText('Ada · ada@example.test');
  fireEvent.change(screen.getByLabelText('Bind to Entra user'), { target: { value: `${ORG}:${CONTACT}` } });
  fireEvent.click(screen.getByRole('button', { name: 'Bind to Entra user' }));
  await waitFor(() => expect(api.bindContact).toHaveBeenCalledWith(ORG, CONTACT, user));
  await waitFor(() => expect(screen.getByText('Remove binding')).toBeEnabled());
  fireEvent.click(screen.getByText('Remove binding'));
  await waitFor(() => expect(api.unbindContact).toHaveBeenCalledWith(ORG, CONTACT, row.id));
});
```
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/ContactVerificationDrawer.tsx apps/web/src/components/callerVerification/ContactVerificationDrawer.test.tsx
git commit -m "feat(web): inspect caller history bindings destinations and fences"
```

### Task 9: Mount contact rows and the new contact drawer

**Files:** Modify `apps/web/src/components/settings/ContactsCard.tsx:141,614,663`, `apps/web/src/components/settings/ContactsCard.test.tsx`; `apps/web/src/components/organizations/record/orgRecordTabs.ts:82–84`, `apps/web/src/components/organizations/record/orgRecordTabs.test.ts`. `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx:300` already mounts ContactsCard and needs no edit.

**Interfaces:** Produces hash `#contacts/<contactId>/verification` and nested `/start`; consumes `ContactVerificationDrawer` and `CallerVerificationEntry`. Existing inline editor at `ContactsCard.tsx:444` remains the edit surface; the new drawer is the verification management surface the spec assumes but the repo does not yet have.

- [ ] **Step 1: Write failing parser and mount tests.**

```ts
// Append to orgRecordTabs.test.ts; tabFromHash is already exported.
it('keeps the contacts island mounted for verification drawer hashes', () => {
  expect(tabFromHash('#contacts/22222222-2222-4222-8222-222222222222/verification')).toBe('contacts');
  expect(tabFromHash('#contacts/22222222-2222-4222-8222-222222222222/verification/start')).toBe('contacts');
});
```

In ContactsCard.test.tsx use its existing `mockApi`, `renderCard`, `ORG_ID`, `CONTACTS` fixtures and these module-scope mocks:

```tsx
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../callerVerification/CallerVerificationEntry', () => ({ CallerVerificationEntry: () => null }));
vi.mock('../callerVerification/ContactVerificationDrawer', () => ({ ContactVerificationDrawer: (p: {contactId: string}) => <div data-testid="cv-contact-drawer-stub" data-contact={p.contactId} /> }));
```

Then add:

```tsx
it('opens verification management for the selected row', async () => {
  mockApi(); await renderCard();
  fireEvent.click(screen.getByTestId(`cv-contact-history-${CONTACTS[0].id}`));
  await waitFor(() => expect(window.location.hash).toBe(`#contacts/${CONTACTS[0].id}/verification`));
  expect(screen.getByTestId('cv-contact-drawer-stub')).toHaveAttribute('data-contact', CONTACTS[0].id);
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/settings/ContactsCard.test.tsx src/components/organizations/record/orgRecordTabs.test.ts` → nested tab rejected and action absent.
- [ ] **Step 3: Implement explicit mounts.** Change `tabFromHash`'s raw line to `const raw = hash.replace(/^#/, '').split('/')[0];`. Add imports for readiness, permissions, `useHashState`, both components; inside ContactsCard add:

```tsx
const cvEnabled = useCallerVerificationEnabled();
const { can } = usePermissions();
const [verificationContact, setVerificationContact] = useHashState<string | null>(null, raw => {
  const parts = raw.split('/');
  return parts[0] === 'contacts' && parts[2] === 'verification' ? parts[1] || null : null;
});
```

Inside the row's existing action cell (the map variable is `c`), add:

```tsx
{cvEnabled && <>
  {can('organizations', 'write') && <CallerVerificationEntry orgId={orgId} initialContactId={c.id} hash={`contacts/${c.id}/verify-caller`} />}
  <button data-testid={`cv-contact-history-${c.id}`} onClick={() => { setVerificationContact(c.id); window.location.hash = `contacts/${c.id}/verification`; }}>{i18n.t('callerVerification:history')}</button>
</>}
```

After the table, mount exactly one drawer:

```tsx
{cvEnabled && verificationContact && <ContactVerificationDrawer key={`${orgId}:${verificationContact}`} orgId={orgId} contactId={verificationContact} onClose={() => { setVerificationContact(null); window.location.hash = 'contacts'; }} />}
```

The row uses `/verify-caller`; the drawer parser accepts only `/verification`, and its nested start uses `/verification/start`, so only one start modal mounts. Both paths retain the contacts tab. The row action and the drawer button are explicit entry points. Import `i18n` from `@/lib/i18n` if not present.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/settings/ContactsCard.test.tsx src/components/organizations/record/orgRecordTabs.test.ts` → selection survives hash navigation without changing query parameters.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/settings/ContactsCard.tsx apps/web/src/components/settings/ContactsCard.test.tsx apps/web/src/components/organizations/record/orgRecordTabs.ts apps/web/src/components/organizations/record/orgRecordTabs.test.ts
git commit -m "feat(web): mount caller verification on contact rows and drawer"
```

### Task 10: Mount device-header verification with explicit username confirmation

**Files:** Modify `apps/web/src/components/devices/DeviceDetails.tsx:344,666–668`, `apps/web/src/components/devices/DeviceDetails.hashNavigation.test.tsx:9–29`. Modify `apps/web/src/components/callerVerification/VerifyCallerModal.test.tsx` (device preselection cases).

**Interfaces:** Consumes `device.id`, `device.orgId`, `deviceSuggestions(...): Promise<DeviceSuggestion[]>`; produces header entry with `initialMethod='workstation'`. `hasBinding` from the selected suggestion is the only basis for displaying tier 3, and cannot raise the method endpoint's tier.

- [ ] **Step 1: Add failing device cases to the modal harness.**

```tsx
it('caps an unbound selected workstation at tier 1 and requires confirmation', async () => {
  vi.mocked(api.deviceSuggestions).mockResolvedValue([{ deviceId: TARGET, hostname: 'Workstation A', username: 'ada', hasBinding: false }]);
  vi.mocked(api.methodsForContact).mockResolvedValue([{ method: 'workstation', available: true, tier: 3, reason: 'bound_principal' }]);
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} deviceId={TARGET} initialMethod="workstation" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('cv-next')).toBeEnabled());
  fireEvent.click(screen.getByTestId('cv-next'));
  expect(screen.getByTestId('cv-method-workstation')).toHaveTextContent('Assurance tier 1');
  expect(screen.getByTestId('cv-start')).toBeDisabled();
  fireEvent.click(screen.getByTestId('cv-confirm-username'));
  fireEvent.click(screen.getByTestId('cv-start'));
  await waitFor(() => expect(api.startVerification).toHaveBeenCalledWith(expect.objectContaining({ deviceId: TARGET, username: 'ada', method: 'workstation' })));
});
```

Parameterize the preceding test with `[false, true]` through `it.each([false, true])`, pass `hasBinding` into the suggestion, and expect `Assurance tier ${hasBinding ? 3 : 1}`. After confirming, edit `cv-username` to `different-user`, assert `cv-confirm-username` is unchecked and the card is tier 1, then restore `ada` and reconfirm before the start click. The exact edit/assertion code is:

```tsx
fireEvent.change(screen.getByTestId('cv-username'), { target: { value: 'different-user' } });
expect(screen.getByTestId('cv-confirm-username')).not.toBeChecked();
expect(screen.getByTestId('cv-method-workstation')).toHaveTextContent('Assurance tier 1');
fireEvent.change(screen.getByTestId('cv-username'), { target: { value: 'ada' } });
fireEvent.click(screen.getByTestId('cv-confirm-username'));
```

Existing `DeviceDetails.hashNavigation.test.tsx` keeps `installAstroClientRouterStandIn` and its automatic fetch/router setup. Add this module-scope stub and independent mount test:

```tsx
vi.mock('../callerVerification/CallerVerificationEntry', () => ({ CallerVerificationEntry: (props: Record<string, unknown>) => <div data-testid="cv-device-entry" data-props={JSON.stringify(props)} /> }));
it('mounts workstation verification for the displayed device', async () => {
  render(<DeviceDetails device={device} />);
  expect(JSON.parse((await screen.findByTestId('cv-device-entry')).getAttribute('data-props')!)).toMatchObject({ orgId: device.orgId, deviceId: device.id, initialMethod: 'workstation' });
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/VerifyCallerModal.test.tsx src/components/devices/DeviceDetails.hashNavigation.test.tsx` → mount absent / confirmation absent.
- [ ] **Step 3: Add the explicit header mount, beside DeviceActions.**

```tsx
<CallerVerificationEntry key={device.id} orgId={device.orgId} deviceId={device.id}
  initialMethod="workstation" hash={`${activeTab}/caller-verification`} />
<DeviceActions device={device} onAction={onAction} />
```

The current `activeTab: Tab` declaration is at DeviceDetails.tsx:400, derived from hashTab initialized at :344. The current parser already takes the first slash segment (`:233–237`). Restore the previous hash on dismissal through the Task-7 launcher update. Do not use `last_user` as consent: the username input must be confirmed after contact selection.

Minimal confirmation code inside VerificationFlow:

```tsx
const [usernameConfirmed, setUsernameConfirmed] = useState(false);
useEffect(() => { setUsernameConfirmed(false); }, [contact, device, username]);
// Replace the workstation branch of canStart:
(method !== 'workstation' || (!!device && !!username.trim() && usernameConfirmed))
// After the username input:
<label><input data-testid="cv-confirm-username" type="checkbox" checked={usernameConfirmed}
  onChange={e => setUsernameConfirmed(e.target.checked)} />{t('username')}</label>
```

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/VerifyCallerModal.test.tsx src/components/devices/DeviceDetails.hashNavigation.test.tsx` → both binding cases and hash navigation pass.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/devices/DeviceDetails.tsx apps/web/src/components/devices/DeviceDetails.hashNavigation.test.tsx apps/web/src/components/callerVerification/VerifyCallerModal.tsx apps/web/src/components/callerVerification/VerifyCallerModal.test.tsx
git commit -m "feat(web): verify callers from a confirmed workstation session"
```

### Task 11: Partner baseline and organization tighten-only policy form

**Files:** Create `apps/web/src/components/callerVerification/CallerVerificationPolicyForm.tsx`, `apps/web/src/components/callerVerification/CallerVerificationPolicyForm.test.tsx`. Precedent: `apps/web/src/components/software/PolicyForm.tsx:18–22,87–116` for owner scope and “All organizations”; do not add ownerScope to PUT payloads.

**Interfaces:** Consumes `getPolicy(owner,signal): Promise<PolicyResponse>`, `putPolicy(owner,draft): Promise<PolicyResponse>`; produces `CallerVerificationPolicyForm({owner,readOnly?}): ReactNode`. Policy GET must supply `baseline` separately from `effective` to constrain org overrides correctly.

- [ ] **Step 1: Write failing policy tests.**

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getPolicy, putPolicy } from '@/lib/api/callerVerification';
import { CallerVerificationPolicyForm } from './CallerVerificationPolicyForm';
import { ORG, policy } from './testFixtures';
vi.mock('@/lib/api/callerVerification');
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
it('shows provenance, ignored fields and disables loosening values', async () => {
  vi.mocked(getPolicy).mockResolvedValue({ row: null, defaults: policy, baseline: policy, effective: { ...policy, provenance: { requiredTierResetPassword: 'partner' }, ignored: ['requiredTierResetPassword'] } });
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'organization', orgId: ORG }} />);
  expect(await screen.findByText('From partner policy')).toBeVisible();
  expect(screen.getByTestId('cv-policy-requiredTierResetPassword')).toHaveAttribute('min', '2');
  expect(screen.getByText(/Ignored because it weakens/)).toBeVisible();
});
it('keeps the tier-0 warning visible after a successful save', async () => {
  const result = { row: null, defaults: policy, baseline: { ...policy, requiredTierResetPassword: 0 }, effective: { ...policy, requiredTierResetPassword: 0 } };
  vi.mocked(getPolicy).mockResolvedValue(result); vi.mocked(putPolicy).mockResolvedValue(result);
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  await screen.findByText(/A tier of 0 disables/);
  fireEvent.click(screen.getByText('Save policy'));
  await waitFor(() => expect(putPolicy).toHaveBeenCalled());
  expect(screen.getByText(/A tier of 0 disables/)).toBeVisible();
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/CallerVerificationPolicyForm.test.tsx` → absent form.
- [ ] **Step 3: Implement field-by-field constraints, null inheritance and effective preview.**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { getPolicy, putPolicy, type Owner, type PolicyDraft, type PolicyResponse, type PolicyValues } from '@/lib/api/callerVerification';
const numeric = {
  requiredTierResetPassword: [0, 3, 'max'], requiredTierDisableUser: [0, 3, 'max'],
  verificationTtlMinutes: [5, 240, 'min'], workstationTimeoutSeconds: [30, 300, 'min'],
  destinationMinAgeDays: [0, 90, 'max'], maxAttemptsPerHour: [1, 100, 'min'], coolingOffHours: [1, 720, 'max'],
} as const;
const booleans = { requireAttestedDestination: 'or', requireTicket: 'or', allowCrossTechnicianUse: 'and', allowAdministrativeDisable: 'and' } as const;
const sets = { allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'], disableUserAuthorizerRoles: ['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal'] } as const;
const keys = [...Object.keys(numeric), ...Object.keys(booleans), ...Object.keys(sets)] as (keyof PolicyValues)[];
export function inheritedDraft(): PolicyDraft { return Object.fromEntries(keys.map(k => [k, null])) as PolicyDraft; }
function draftFrom(row: PolicyDraft | null): PolicyDraft { return Object.fromEntries(keys.map(k => [k, row?.[k] ?? null])) as PolicyDraft; }
type Props = { owner: Owner; readOnly?: boolean };
export function CallerVerificationPolicyForm(props: Props) { return useCallerVerificationEnabled() ? <LoadedPolicy key={props.owner.ownerScope === 'partner' ? 'partner' : props.owner.orgId} {...props} /> : null; }
function LoadedPolicy({ owner, readOnly = false }: Props) {
  const { t } = useTranslation('callerVerification'); const { t: settings } = useTranslation('settings');
  const [data, setData] = useState<PolicyResponse | null>(null); const [draft, setDraft] = useState<PolicyDraft>(inheritedDraft);
  const [error, setError] = useState(false); const [revision, setRevision] = useState(0); const [saving, setSaving] = useState(false); const busy = useRef(false);
  const org = owner.ownerScope === 'organization'; const orgId = org ? owner.orgId : null;
  useEffect(() => { const c = new AbortController(); setError(false);
    void getPolicy(owner, c.signal).then(r => { if (!c.signal.aborted) { setData(r); setDraft(draftFrom(r.row)); } }).catch(() => { if (!c.signal.aborted) setError(true); });
    return () => c.abort();
  }, [orgId, org, revision]);
  if (error) return <p role="alert">{t('loadFailed')}<button onClick={() => setRevision(n => n + 1)}>{t('retry')}</button></p>;
  if (!data) return <p role="status">{t('loading')}</p>;
  const value = (key: keyof PolicyValues) => draft[key] ?? (org ? data.baseline[key] : data.defaults[key]);
  const update = (key: keyof PolicyValues, next: unknown) => setDraft(old => ({ ...old, [key]: next }));
  const warning = !org && (value('requiredTierResetPassword') === 0 || value('requiredTierDisableUser') === 0);
  return <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (busy.current || readOnly) return; busy.current = true; setSaving(true);
    try { const result = await putPolicy(owner, draft); setData(result); setDraft(draftFrom(result.row)); }
    catch (error) { handleActionError(error, t('saveFailed')); } finally { busy.current = false; setSaving(false); }
  }}><h3>{t('policyTitle')}</h3><p>{org ? t('orgScope') : t('partnerScope')}</p>
    {warning && <p role="alert" className="border border-amber-500 p-3">{t('gateOffWarning')}</p>}
    <fieldset disabled={readOnly || saving} className="space-y-4">{keys.map(key => {
      const label = t(/* i18n-dynamic */ `fields.${key}`); const id = `cv-policy-${key}`;
      const num = numeric[key as keyof typeof numeric]; const bool = booleans[key as keyof typeof booleans]; const options = sets[key as keyof typeof sets];
      const base = data.baseline[key];
      const min = num ? org && num[2] === 'max' ? Math.max(num[0], base as number) : num[0] : undefined;
      const max = num ? org && num[2] === 'min' ? Math.min(num[1], base as number) : num[1] : undefined;
      return <div key={key}><label htmlFor={id}>{label}</label><span className="ml-2 rounded border px-2">{t(/* i18n-dynamic */ `provenance.${data.effective.provenance[key] ?? 'default'}`)}</span>
        <output className="ml-2" data-testid={`${id}-effective`}>{String(data.effective[key])}</output>
        {num && <input id={id} data-testid={id} type="number" step={1} min={min} max={max} value={value(key) as number} onChange={e => { const n = e.target.valueAsNumber; if (Number.isInteger(n) && n >= min! && n <= max!) update(key, n); }} />}
        {bool && <select id={id} data-testid={id} value={String(value(key))} onChange={e => update(key, e.target.value === 'true')}>
          {[false, true].map(v => <option key={String(v)} value={String(v)} disabled={org && ((bool === 'or' && base === true && !v) || (bool === 'and' && base === false && v))}>{v ? t('common:labels.yes') : t('common:labels.no')}</option>)}
        </select>}
        {options && <div id={id}>{options.map(option => {
          const values = value(key) as string[]; const checked = values.includes(option); const forbidden = org && !(base as string[]).includes(option);
          return <label key={option}><input type="checkbox" disabled={forbidden} checked={checked && !forbidden} onChange={e => update(key, e.target.checked ? [...values, option] : values.filter(v => v !== option))} />
            {key === 'allowedMethods' ? t(/* i18n-dynamic */ `methods.${option}`) : settings(/* i18n-dynamic */ `contactsCard.roles.${option === 'after_hours' ? 'afterHours' : option}`)}</label>;
        })}</div>}
        <button type="button" onClick={() => update(key, null)}>{t('inherit')}</button>
        {data.effective.ignored.includes(key) && <p className="text-amber-700">{t('ignored', { field: label })}</p>}
      </div>;
    })}</fieldset><button disabled={readOnly || saving} type="submit">{t('save')}</button>
  </form>;
}
```

The numeric ranges match W01 Task 8's `callerVerificationPolicySchema` (attempt cap 1–100, cooling-off 1–720 hours). Null partner fields render built-in defaults; null org fields render the partner baseline. Keep actual `effective` values and provenance separate from unsaved draft values. Format boolean/array effective outputs with the same translated options used by the editor, using this local formatter before the JSX:

```tsx
const displayValue = (key: keyof PolicyValues): string => {
  const current = data.effective[key];
  if (typeof current === 'boolean') return current ? t('common:labels.yes') : t('common:labels.no');
  if (typeof current === 'number') return new Intl.NumberFormat().format(current);
  return current.map(option => key === 'allowedMethods' ? t(/* i18n-dynamic */ `methods.${option}`) : settings(/* i18n-dynamic */ `contactsCard.roles.${option === 'after_hours' ? 'afterHours' : option}`)).join(', ');
};
```
Replace the output's `String(data.effective[key])` with `displayValue(key)`.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/CallerVerificationPolicyForm.test.tsx` → provenance, ignored and warning assertions pass. Include this read-only regression:

```tsx
it('disables all policy mutation controls for read-only operators', async () => {
  vi.mocked(getPolicy).mockResolvedValue({ row: null, defaults: policy, baseline: policy, effective: policy });
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'organization', orgId: ORG }} readOnly />);
  expect(await screen.findByText('Save policy')).toBeDisabled();
  expect(screen.getByTestId('cv-policy-requiredTierResetPassword')).toBeDisabled();
});
```
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/CallerVerificationPolicyForm.tsx apps/web/src/components/callerVerification/CallerVerificationPolicyForm.test.tsx
git commit -m "feat(web): edit caller policy with partner provenance and tightening bounds"
```

### Task 12: Mount policy forms in partner and organization settings

**Files:** Modify `apps/web/src/components/settings/PartnerSettingsPage.tsx:637–640`, `apps/web/src/components/settings/PartnerSettingsPage.test.tsx`; `apps/web/src/components/settings/OrgSettingsPage.tsx:606–615`, `apps/web/src/components/settings/OrgSettingsPage.test.tsx` in that directory.

**Interfaces:** Consumes `CallerVerificationPolicyForm({owner,readOnly})`. Produces partner form in existing `#security`, and org form next to `OrgSecuritySettings`. `ownerScope` is fixed by the shell, not switchable on an update. The partner ID is derived server-side.

- [ ] **Step 1: Write failing shell tests.** Add a module-scope policy-form stub in each test file, then use its existing local fixtures:

```tsx
vi.mock('../callerVerification/CallerVerificationPolicyForm', () => ({ CallerVerificationPolicyForm: (props: Record<string, unknown>) => <div data-testid="cv-policy-mount" data-props={JSON.stringify(props)} /> }));
// OrgSettingsPage.test.tsx, inside its general-tab describe where orgDetails exists:
it('mounts org caller policy beside security settings', async () => {
  window.location.hash = '#security';
  fetchWithAuthMock.mockImplementation(async (url: string) => url.endsWith('/effective-settings') ? makeJsonResponse({ locked: [] }) : makeJsonResponse(orgDetails));
  render(<OrgSettingsPage orgId="org-1" />);
  const mount = await screen.findByTestId('cv-policy-mount');
  expect(JSON.parse(mount.getAttribute('data-props')!).owner).toEqual({ ownerScope: 'organization', orgId: 'org-1' });
});
// PartnerSettingsPage.test.tsx: separate test, using module-level store/response helpers.
it('mounts partner-wide caller policy in security', async () => {
  window.location.hash = '#security';
  useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  fetchWithAuthMock.mockImplementation(async (url) => String(url) === '/orgs/partners/me'
    ? makeJsonResponse({ id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro', settings: {}, createdAt: '2026-02-09T00:00:00Z' }) : makeJsonResponse({ data: [] }));
  render(<PartnerSettingsPage />);
  const mount = await screen.findByTestId('cv-policy-mount');
  expect(JSON.parse(mount.getAttribute('data-props')!).owner).toEqual({ ownerScope: 'partner' });
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/settings/PartnerSettingsPage.test.tsx src/components/settings/OrgSettingsPage.test.tsx` → no policy mount.
- [ ] **Step 3: Implement both explicit mounts.** Import the form and `usePermissions`/`useAuthStore` as needed. In each page compute `const { can } = usePermissions();`; in partner settings compute `const canManageCallerPolicy = useAuthStore(s => s.user?.canManagePartnerWide === true);`. Add alongside existing security JSX:

```tsx
// PartnerSettingsPage.tsx, inside activeTab === 'security' section:
<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} readOnly={!canManageCallerPolicy || !can('organizations', 'write')} />
// OrgSettingsPage.tsx, wrap the existing case's OrgSecuritySettings in a fragment:
<CallerVerificationPolicyForm owner={{ ownerScope: 'organization', orgId: effectiveOrgId }} readOnly={!can('organizations', 'write')} />
```

The form gates its own data-fetching child with readiness. Use parent read gates if org-read permission is absent. Add the following member to each existing test auth factory (retain its existing fetch export), and stub `usePermissions` so permission reading does not alter unrelated shell tests:

```tsx
useAuthStore: (selector: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => selector({ user: { canManagePartnerWide: true } }),
```
```tsx
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
``` Do not add new settings navigation labels, pages or query-state parameters.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/settings/PartnerSettingsPage.test.tsx src/components/settings/OrgSettingsPage.test.tsx src/components/callerVerification/CallerVerificationPolicyForm.test.tsx` → pass including read-only rendering.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/settings/PartnerSettingsPage.tsx apps/web/src/components/settings/PartnerSettingsPage.test.tsx apps/web/src/components/settings/OrgSettingsPage.tsx apps/web/src/components/settings/OrgSettingsPage.test.tsx
git commit -m "feat(web): mount caller policy in partner and org security settings"
```

### Task 13: Interactive administrative disable with resource-bound MFA

**Files:** Modify `apps/web/src/lib/mfaStepUp.ts:64`, `apps/web/src/lib/mfaStepUp.test.ts`; `apps/web/src/lib/api/callerVerification.ts` (POST adapter). Create `apps/web/src/components/callerVerification/AdministrativeDisable.tsx`, `apps/web/src/components/callerVerification/AdministrativeDisable.test.tsx`; modify `apps/web/src/components/callerVerification/ContactVerificationDrawer.tsx` (management section after destinations).

**Interfaces:** Keep `mintStepUpGrant`'s current return `Promise<string>` and existing arguments; add optional `post?: (path: string, body: unknown, fallback: string) => Promise<Record<string, any>>`. Consumes W05 operation `caller_verification_administrative_disable`, resource `{orgId,entraTenantId,entraOid,reason}` and `POST /orgs/:orgId/caller-verifications/administrative {targetContactId,reason,stepUpGrantId}`. Browser sends resource fields; server computes `sha256(orgId | entraTenantId | entraOid | sha256(reason))`. A client-supplied digest alone is not accepted.

- [ ] **Step 1: Write failing ceremony and flow tests.**

```ts
// mfaStepUp.test.ts, in the existing describe (startAuthenticationMock exists).
it('uses an injected POST transport for both passkey requests', async () => {
  const post = vi.fn().mockResolvedValueOnce({ options: { challenge: 'c' } }).mockResolvedValueOnce({ stepUpGrantId: 'grant' });
  startAuthenticationMock.mockResolvedValue({ id: 'credential' });
  await expect(mintStepUpGrant({ operation: 'caller_verification_administrative_disable', resource: { orgId: 'o', entraTenantId: 't', entraOid: 'u', reason: 'Offboarding approved by HR' }, reauth: { method: 'passkey' }, post })).resolves.toBe('grant');
  expect(post.mock.calls.map(c => c[0])).toEqual(['/auth/mfa/step-up/options', '/auth/mfa/step-up']);
  expect(fetchWithAuthMock).not.toHaveBeenCalled();
});
```

```tsx
// AdministrativeDisable.test.tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as api from '@/lib/api/callerVerification';
import { mintStepUpGrant } from '@/lib/mfaStepUp';
import { AdministrativeDisable } from './AdministrativeDisable';
import { ORG, CONTACT, row } from './testFixtures';
vi.mock('@/lib/api/callerVerification'); vi.mock('@/lib/mfaStepUp', () => ({ mintStepUpGrant: vi.fn() }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(async (path: string) => new Response(JSON.stringify(path === '/users/me' ? { mfaMethod: 'totp' } : { passkeys: [] }))) }));
it('mints for the exact target and trimmed reason before creating the grant row', async () => {
  vi.mocked(mintStepUpGrant).mockResolvedValue('grant'); vi.mocked(api.createAdministrative).mockResolvedValue(row);
  const binding = { id: row.id, entraTenantId: ORG, entraOid: CONTACT, upnSnapshot: 'ada@example.test', osPrincipal: null, revokedAt: null };
  render(<AdministrativeDisable orgId={ORG} targetContactId={CONTACT} binding={binding} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByTestId('cv-admin-reason'), { target: { value: 'short' } });
  expect(screen.getByTestId('cv-admin-next')).toBeDisabled();
  fireEvent.change(screen.getByTestId('cv-admin-reason'), { target: { value: '  Offboarding approved by HR  ' } });
  fireEvent.click(screen.getByTestId('cv-admin-next'));
  fireEvent.change(await screen.findByTestId('approver-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('cv-admin-submit'));
  await waitFor(() => expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({ operation: 'caller_verification_administrative_disable', resource: { orgId: ORG, entraTenantId: ORG, entraOid: CONTACT, reason: 'Offboarding approved by HR' } })));
  expect(api.createAdministrative).toHaveBeenCalledWith(ORG, CONTACT, 'Offboarding approved by HR', 'grant');
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/lib/mfaStepUp.test.ts src/components/callerVerification/AdministrativeDisable.test.tsx` → transport ignored / component absent.
- [ ] **Step 3: Implement the transport seam without duplicating WebAuthn.** Add `post` to the options type and `const post = opts.post ?? postOrThrow;` at the top of `mintStepUpGrant`; replace its two calls to `postOrThrow` with `post`. Leave the original helper and its callers' error behavior unchanged. Export this adapter from callerVerification.ts:

```ts
export function stepUpPost(path: string, body: unknown, _fallback: string): Promise<Record<string, any>> {
  return runAction<Record<string, any>>({
    request: () => fetchWithAuth(path, { method: 'POST', orgIdOverride: null, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    errorFallback: i18n.t('callerVerification:saveFailed'),
    parseSuccess: data => { if (!data || typeof data !== 'object') throw new Error('Invalid step-up response'); return data as Record<string, any>; },
  });
}
```

No success toast is required for an intermediate passkey-options request; its next visible factor prompt is feedback. The administrative creation itself has `runAction` success feedback. Existing proof rejection is 400 `mfa_proof_invalid`; retain normal 401 session refresh semantics (`mfaStepUp.ts:41`), rather than treating a login failure as a wrong factor.

```tsx
// AdministrativeDisable.tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import StepUpPrompt from '@/components/settings/StepUpPrompt';
import { fetchWithAuth } from '@/stores/auth';
import { mintStepUpGrant } from '@/lib/mfaStepUp';
import { handleActionError } from '@/lib/runAction';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { createAdministrative, stepUpPost, type BindingView, type VerificationDetails } from '@/lib/api/callerVerification';
type Props = { orgId: string; targetContactId: string; binding: BindingView; onCreated: (row: VerificationDetails) => void; onBusyChange?: (busy: boolean) => void };
export function AdministrativeDisable(props: Props) { return useCallerVerificationEnabled() ? <AdminFlow key={`${props.orgId}:${props.targetContactId}:${props.binding.id}`} {...props} /> : null; }
function AdminFlow({ orgId, targetContactId, binding, onCreated, onBusyChange }: Props) {
  const { t } = useTranslation('callerVerification'); const [reason, setReason] = useState(''); const [step, setStep] = useState(0);
  const [factor, setFactor] = useState<'passkey' | 'totp' | null>(null); const [loaded, setLoaded] = useState(false); const [error, setError] = useState(false);
  const [code, setCode] = useState(''); const [saving, setSaving] = useState(false); const busy = useRef(false);
  useEffect(() => {
    if (step !== 1) return; const c = new AbortController(); setLoaded(false); setError(false);
    void Promise.all(['/users/me', '/auth/passkeys'].map(async path => { const r = await fetchWithAuth(path, { method: 'GET', orgIdOverride: null, signal: c.signal }); if (!r.ok) throw new Error('factor lookup'); return r.json(); })).then(([user, keys]) => {
      if (!c.signal.aborted) { setFactor(keys.passkeys?.length ? 'passkey' : user.mfaMethod === 'totp' ? 'totp' : null); setLoaded(true); }
    }).catch(() => { if (!c.signal.aborted) { setError(true); setLoaded(true); } });
    return () => c.abort();
  }, [step]);
  async function submit() {
    if (busy.current || !factor || !binding.entraTenantId || !binding.entraOid || binding.revokedAt || reason.trim().length < 20) return;
    const snapshot = { orgId, entraTenantId: binding.entraTenantId, entraOid: binding.entraOid, reason: reason.trim() };
    busy.current = true; setSaving(true); onBusyChange?.(true);
    try {
      const grant = await mintStepUpGrant({ operation: 'caller_verification_administrative_disable', resource: snapshot, reauth: factor === 'passkey' ? { method: 'passkey' } : { method: 'totp', code }, post: stepUpPost });
      const result = await createAdministrative(orgId, targetContactId, snapshot.reason, grant); onCreated(result); setStep(0); setReason('');
    } catch (e) { handleActionError(e, t('saveFailed')); }
    finally { busy.current = false; setSaving(false); setCode(''); onBusyChange?.(false); }
  }
  return <section><h3>{t('adminTitle')}</h3><p>{binding.upnSnapshot ?? binding.entraOid}</p>
    <label>{t('reason')}<textarea maxLength={4000} data-testid="cv-admin-reason" disabled={saving || step === 1} value={reason} onChange={e => setReason(e.target.value)} /></label>
    {step === 0 ? <button data-testid="cv-admin-next" disabled={reason.trim().length < 20} onClick={() => setStep(1)}>{t('next')}</button> : <>
      {!loaded && <p role="status">{t('loading')}</p>}{error && <p role="alert">{t('loadFailed')}</p>}
      {loaded && !error && !factor && <a href="/settings/profile">{t('noFactor')}</a>}
      {factor && <StepUpPrompt tier={factor} reauthValue={code} onChange={setCode} disabled={saving} />}
      <button disabled={saving} onClick={() => { setStep(0); setCode(''); }}>{t('back')}</button>
      <button data-testid="cv-admin-submit" disabled={saving || !factor || (factor === 'totp' && !/^\d{6}$/.test(code))} onClick={() => void submit()}>{t('adminSubmit')}</button>
    </>}
  </section>;
}
```

Mount in LoadedDrawer only when write is allowed, the freshly loaded effective policy permits administrative disable, and exactly one active Entra binding exists for the target contact. Fetch `getPolicy` alongside history. Import AdministrativeDisable and render:

```tsx
const activeBindings = error ? [] : data?.bindings.filter(b => !b.revokedAt && b.entraTenantId && b.entraOid) ?? [];
{write && effectivePolicy?.allowAdministrativeDisable && activeBindings.length === 1 &&
  <AdministrativeDisable orgId={orgId} targetContactId={contactId} binding={activeBindings[0]} onBusyChange={setAdminBusy} onCreated={() => setRevision(n => n + 1)} />}
```

Do not silently choose among multiple bindings. The `onBusyChange` callback locks the drawer while the mint/create sequence is in flight. Never save/reuse a minted grant after failure. Every retry proves a fresh factor. This creates a single-use grant only; the account action still passes through the existing approval/release workflow.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/lib/mfaStepUp.test.ts src/components/callerVerification/AdministrativeDisable.test.tsx src/components/callerVerification/ContactVerificationDrawer.test.tsx` → exact resource, reason and grant handoff. Parameterize the flow test with rejected mint and passkey cancellation; the following failure case is required:

```tsx
it('never creates an administrative row after factor rejection', async () => {
  vi.mocked(api.createAdministrative).mockClear(); vi.mocked(mintStepUpGrant).mockRejectedValue(new Error('factor rejected'));
  render(<AdministrativeDisable orgId={ORG} targetContactId={CONTACT} binding={{ id: row.id, entraTenantId: ORG, entraOid: CONTACT, upnSnapshot: 'ada@example.test', osPrincipal: null, revokedAt: null }} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByTestId('cv-admin-reason'), { target: { value: 'Offboarding approved by HR' } });
  fireEvent.click(screen.getByTestId('cv-admin-next'));
  fireEvent.change(await screen.findByTestId('approver-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('cv-admin-submit'));
  await waitFor(() => expect(screen.getByTestId('approver-stepup-code')).toHaveValue(''));
  expect(api.createAdministrative).not.toHaveBeenCalled();
});
```
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/lib/mfaStepUp.ts apps/web/src/lib/mfaStepUp.test.ts apps/web/src/lib/api/callerVerification.ts apps/web/src/components/callerVerification/AdministrativeDisable.tsx apps/web/src/components/callerVerification/AdministrativeDisable.test.tsx apps/web/src/components/callerVerification/ContactVerificationDrawer.tsx apps/web/src/components/callerVerification/ContactVerificationDrawer.test.tsx
git commit -m "feat(web): create administrative disable grants through MFA step-up"
```

### Task 14: Inline AI refusal workflow with pinned organization and action

**Files:** Create `apps/web/src/components/callerVerification/CallerVerificationRefusal.tsx`, `apps/web/src/components/callerVerification/CallerVerificationRefusal.test.tsx`. Modify `apps/web/src/components/ai/AiChatMessages.tsx:298–307`, `apps/web/src/components/ai/AiChatMessages.test.tsx`. No change to `AiToolCallCard.tsx:65` approval-handoff trust rules.

**Interfaces:** Consumes a tool error containing exact inner `requiresCallerVerification: {contactId: string | null, requiredTier: number, reason: string}`. W05 must preserve the full index `CallerVerificationRequiredError.payload` inside `requiresCallerVerification`, including `orgId` and `action` alongside the three minimum UI fields. Produces a gated inline modal; no automatic retry/release. Current `processStreamEvent.ts:132–141` already preserves toolOutput/isError, and `AiChatMessages.tsx:298` hands that output to the card. Sidebar has no reliable org ID, and the current browser AI store discards session.orgId; never fall back to the ambient org switcher for a historical refusal.

- [ ] **Step 1: Write failing parser/render tests.**

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CallerVerificationRefusal, parseRefusal } from './CallerVerificationRefusal';
import { ORG, CONTACT } from './testFixtures';
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
vi.mock('./VerifyCallerModal', () => ({ VerifyCallerModal: (p: {orgId: string; initialContactId?: string}) => <div data-testid="inline-cv" data-org={p.orgId} data-contact={p.initialContactId} /> }));
const error = { requiresCallerVerification: { orgId: ORG, action: 'reset_password', contactId: CONTACT, requiredTier: 2, reason: 'grant_consumed' } };
it('opens a modal with the refusal scope, not the ambient switcher', () => {
  render(<CallerVerificationRefusal output={JSON.stringify(error)} isError />);
  fireEvent.click(screen.getByText('Verify caller'));
  expect(screen.getByTestId('inline-cv')).toHaveAttribute('data-org', ORG);
  expect(screen.getByTestId('inline-cv')).toHaveAttribute('data-contact', CONTACT);
});
it('rejects missing scope, malformed payload and success output', () => {
  expect(parseRefusal({ requiresCallerVerification: { contactId: CONTACT, requiredTier: 2, reason: 'grant_consumed' } })).toBeNull();
  expect(parseRefusal('{')).toBeNull();
  render(<CallerVerificationRefusal output={error} isError={false} />);
  expect(screen.queryByText('Verify caller')).toBeNull();
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/callerVerification/CallerVerificationRefusal.test.tsx` → missing module.
- [ ] **Step 3: Implement strict parsing and the explicit renderer mount.**

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { VerifyCallerModal } from './VerifyCallerModal';
const schema = z.object({
  requiresCallerVerification: z.object({ orgId: z.string().uuid(), action: z.enum(['reset_password', 'disable_user']), contactId: z.string().uuid().nullable(), requiredTier: z.number().int().min(0).max(3), reason: z.enum(['no_fresh_verification', 'grant_consumed', 'subject_unmatched', 'subject_ambiguous', 'subject_mailboxes_unknown', 'tenant_mismatch', 'contact_fenced', 'requester_not_authorized', 'technician_mismatch', 'target_rebound', 'stepup_invalidated', 'administrative_disabled', 'feature_disabled']) }),
});
export function parseRefusal(output: unknown): z.infer<typeof schema> | null {
  try { const result = schema.safeParse(typeof output === 'string' ? JSON.parse(output) : output); return result.success ? result.data : null; } catch { return null; }
}
export function CallerVerificationRefusal({ output, isError }: { output: unknown; isError?: boolean }) {
  const { t } = useTranslation('callerVerification'); const enabled = useCallerVerificationEnabled();
  const [open, setOpen] = useState(false); const [completed, setCompleted] = useState(false);
  const refusal = isError ? parseRefusal(output) : null;
  if (!enabled || !refusal) return null;
  const required = refusal.requiresCallerVerification;
  return <aside className="rounded border p-3"><p>{t('aiRequired')}</p><p>{t('tier', { tier: required.requiredTier })}</p>
    <p>{t(/* i18n-dynamic */ `reasons.${required.reason}`, { defaultValue: t('reasons.unknown') })}</p>
    {completed && <p role="status">{t('aiRetry')}</p>}
    <button onClick={() => setOpen(true)}>{t('title')}</button>
    {open && <VerifyCallerModal orgId={required.orgId} initialAction={required.action} initialContactId={required.contactId ?? undefined} onClose={() => setOpen(false)} onChanged={r => setCompleted(r.status === 'verified' && !r.consumedAt && !!r.usableUntil && Date.parse(r.usableUntil) > Date.now())} />}
  </aside>;
}
```

At the tool_result branch wrap the existing card in a keyed fragment and append the refusal component. Retain `handoff` and the raw/error output unchanged:

```tsx
<div key={msg.id}>
  <AiToolCallCard toolName={msg.toolName ?? t('aiChatMessages.toolResult')} output={msg.toolOutput ?? msg.content} isError={msg.isError} handoff={msg.handoff} />
  <CallerVerificationRefusal output={msg.toolOutput ?? msg.content} isError={msg.isError} />
</div>
```

Add `import { CallerVerificationRefusal } from '../callerVerification/CallerVerificationRefusal';`. W05 adapters own payload preservation; an older unscoped error remains the normal error card. This parser offers only a workflow, never confers approval based on tool output. If a refused disable targeted another person, the technician must reconfirm requester and target in step 0; do not infer authorization from an AI message.

- [ ] **Step 4: Run green.** `cd apps/web && npx vitest run src/components/callerVerification/CallerVerificationRefusal.test.tsx src/components/ai/AiChatMessages.test.tsx src/components/ai/AiToolCallCard.test.tsx` → inline refusal works and approval handoff tests remain intact.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/web/src/components/callerVerification/CallerVerificationRefusal.tsx apps/web/src/components/callerVerification/CallerVerificationRefusal.test.tsx apps/web/src/components/ai/AiChatMessages.tsx apps/web/src/components/ai/AiChatMessages.test.tsx
git commit -m "feat(web): offer caller verification for structured AI refusals"
```

### Task 15: Wave verification, dark-mode contracts, integration and PR

**Files:** Create `apps/web/src/components/callerVerification/wave.contract.test.ts`. Modify `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:36,540`. All other task files are verification inputs.

**Interfaces:** Consumes every W04 mount and W01–W03 backend route projection. Produces executable no-mount/no-request contracts and an open W04 PR; leaves readiness off and does not merge or close the parent issue.

- [ ] **Step 1: Write the failing cross-surface dark-mode test.**

```tsx
// wave.contract.test.ts (use createElement so this contract keeps a .ts extension)
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { CallerVerificationEntry } from './CallerVerificationEntry';
import { VerifyCallerModal } from './VerifyCallerModal';
import { TicketVerificationBadge } from './TicketVerificationBadge';
import { ContactVerificationDrawer } from './ContactVerificationDrawer';
import { CallerVerificationPolicyForm } from './CallerVerificationPolicyForm';
import { AdministrativeDisable } from './AdministrativeDisable';
import { CallerVerificationRefusal } from './CallerVerificationRefusal';
import { ORG, CONTACT, row } from './testFixtures';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetch, useAuthStore: (select: (s: unknown) => unknown) => select({ user: null }) }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => false }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('hides every independently addressable surface and makes no API request', () => {
  const common = { orgId: ORG, onClose: vi.fn() };
  render(createElement('div', null,
    createElement(CallerVerificationEntry, { ...common, hash: 'contacts/verification' }),
    createElement(VerifyCallerModal, common),
    createElement(TicketVerificationBadge, { orgId: ORG, ticketId: row.id }),
    createElement(ContactVerificationDrawer, { ...common, contactId: CONTACT }),
    createElement(CallerVerificationPolicyForm, { owner: { ownerScope: 'partner' } }),
    createElement(AdministrativeDisable, { orgId: ORG, targetContactId: CONTACT, binding: { id: row.id, entraTenantId: ORG, entraOid: CONTACT, upnSnapshot: null, osPrincipal: null, revokedAt: null }, onCreated: vi.fn() }),
    createElement(CallerVerificationRefusal, { isError: true, output: { requiresCallerVerification: { orgId: ORG, action: 'disable_user', contactId: CONTACT, requiredTier: 2, reason: 'grant_consumed' } } }),
  ));
  expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('keeps all explicit page integrations present', () => {
  for (const [path, component] of [
    ['../tickets/TicketWorkbench.tsx', 'TicketVerificationBadge'],
    ['../settings/ContactsCard.tsx', 'ContactVerificationDrawer'],
    ['../devices/DeviceDetails.tsx', 'CallerVerificationEntry'],
    ['../settings/PartnerSettingsPage.tsx', 'CallerVerificationPolicyForm'],
    ['../settings/OrgSettingsPage.tsx', 'CallerVerificationPolicyForm'],
    ['../ai/AiChatMessages.tsx', 'CallerVerificationRefusal'],
  ]) expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain(`<${component}`);
});
```

- [ ] **Step 2: Run red before registering every mutation file.** `cd apps/web && npx vitest run src/components/callerVerification/wave.contract.test.ts src/lib/__tests__/no-silent-mutations.test.ts` → dark surfaces must pass; add an assertion to the guard's existing “finds files” test that every new mutation owner is in TARGET_GLOBS, then observe failure for absent registrations.

```ts
for (const rel of [
  'src/lib/api/callerVerification.ts',
  'src/components/callerVerification/VerifyCallerModal.tsx',
  'src/components/callerVerification/ContactVerificationDrawer.tsx',
  'src/components/callerVerification/CallerVerificationPolicyForm.tsx',
  'src/components/callerVerification/AdministrativeDisable.tsx',
]) expect(TARGET_GLOBS).toContain(rel);
```

- [ ] **Step 3: Implement the remaining guard registrations.** Add those five exact strings once (client already added in Task 1); increase the rebased guarded count by four, 126 → 130 on this baseline. Do not register legacy `mfaStepUp.ts` as an adopted file: its old callers retain the existing transport, while the new injected transport is lexically guarded in callerVerification.ts. Do not add any allowlist or exemption. The guard resolves imported API wrappers and detects future bare mutations in the components.
- [ ] **Step 4: Run all targeted, type and contract checks from root.**

```bash
(cd apps/web && npx vitest run src/components/callerVerification src/lib/api/callerVerification.test.ts src/lib/useCallerVerificationEnabled.test.tsx src/stores/featuresStore.test.ts src/lib/mfaStepUp.test.ts)
(cd apps/web && npx vitest run src/components/tickets/TicketWorkbench.test.tsx src/components/tickets/TicketFeed.test.tsx src/components/settings/ContactsCard.test.tsx src/components/organizations/record/orgRecordTabs.test.ts src/components/devices/DeviceDetails.hashNavigation.test.tsx src/components/settings/PartnerSettingsPage.test.tsx src/components/settings/OrgSettingsPage.test.tsx src/components/ai/AiChatMessages.test.tsx src/components/ai/AiToolCallCard.test.tsx)
(cd apps/web && npx vitest run src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts)
(cd apps/web && npx tsc --noEmit && npx astro check)
(cd apps/api && npx vitest run src/routes/config.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts)
```

Expected: all pass with nonzero file counts; no missing translations, module imports or Astro props. W01 route supplements and W05's administrative operation must be checked against their merged source rather than assumed from these fixtures. No W04 Go/helper code changed, so a new agent race run is not required here; W02 owns `cd agent && go test -race ./internal/heartbeat/...`.

- [ ] **Step 5: Run live-DB contracts; always tear down the private stack.**

```bash
pnpm test-stack up
trap 'pnpm test-stack down' EXIT
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerification.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.config.rls.ts src/__tests__/integration/rls.integration.test.ts)
pnpm test-stack down
trap - EXIT
```

W01 Task 15 defines the exact new `callerVerification.integration.test.ts` path included above. `rls-coverage.integration.test.ts` is excluded from the normal integration config and uses its dedicated `vitest.config.rls-coverage.ts`; do not combine it with the truncate-based fixture runner. Require positive own-org controls and cross-org/sibling-site refusals for history, methods, bindings, destination attestation, override and ticket freshness. W04 does not claim that mocked web tests establish RLS.

- [ ] **Step 6: Commit verification and open the wave PR.** Read actual parent and sub-issue numbers from the implementation task into `CV_PARENT` and `CV_SUB` before using these commands; they are required issue inputs, not fabricated values. On the pre-created branch the exact branch name is mechanically asserted. No commit/PR command in this plan runs during plan authoring.

```bash
ls apps/api/migrations | sort | tail -1
git diff --check
git add apps/web/src/components/callerVerification/wave.contract.test.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "test(web): verify dark caller workflow and mutation contracts"
export CV_PARENT CV_SUB
test "$(git branch --show-current)" = "feature/${CV_PARENT}-caller-verification/wave-${CV_SUB}"
git push -u origin HEAD
python3 - <<'PY'
import os
from pathlib import Path
body = f'''Adds the technician caller-verification workflow on tickets, contacts, devices and AI refusals. Policy editing shows the partner baseline and ignored org overrides; administrative disable requires an interactive resource-bound factor proof.

The runtime readiness flag remains off. W05 owns enforcement, administrative operation support and the final enablement. W01 supplies the documented additive web projections and Graph-backed directory picker.

Validation: targeted web suites, TypeScript/Astro checks, eight-locale parity, no-silent-mutations contract, runtime dark-mode checks and live-DB RLS/cascade/export contracts.

Spec: docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md

Closes #{os.environ['CV_SUB']}
'''
Path('/tmp/caller-verification-w04-pr.md').write_text(body)
PY
gh pr create --base main --title "feat(web): caller verification workflow (W04)" --body-file /tmp/caller-verification-w04-pr.md
```

Only claim successful checks in the PR body after their actual runs pass. If a required stack/check cannot run, replace the validation sentence with its exact limitation; do not label W04 ready. Keep the PR open. No merge, parent closure, flag flip or deployment is part of W04.

## Self-review

**Spec coverage.** D2/script and large codes → Task 5; D4 availability/tier → Tasks 4/10; D6 floor/provenance/ignored → Tasks 11/12; D11 bindings → Task 8; D12 destination establishment/attestation → Task 8; D13 single-use/technician/freshness → Tasks 5/6; D15 requester/target and interactive admin → Tasks 4/13; D16 dark mounting → Tasks 2/15. Ticket, contact row, contact drawer and device header each have explicit mount tasks (7/9/10). W01 system comments already render in TicketFeed. AI refusal → Task 14. Eight actual translations and parity → Task 3. Final verification covers targeted, contract, type and integration suites.

**Cross-wave findings.** This checkout has no caller-verification implementation. The index's exact three UI interfaces are preserved; additive route projections are identified as prerequisites rather than fabricated existing fields. Sibling-plan verification also caught W01’s `{data}` envelopes and W05’s full nested refusal payload; both are reflected in the final client. Existing `/config` fits readiness. A reusable contact picker, contact drawer and HTTP M365 user search do not exist: the plan adds the smallest web primitives and assigns a Graph-backed picker route to W01. Administrative mint resource/digest support is explicitly W05-owned. Stale tier-2 workstation prose is superseded by v5 D4 and review P1: unbound is tier 1.

**Type and state consistency.** API methods use canonical contact IDs, never portal user IDs; partner policy carries no browser-selected partner ID. UI identity, match/reverse codes and step-up data are never persisted in URL state. Polls are cancellable, sequential and scoped; components remount on org/subject changes. The ticket badge uses server freshness and actual consumed action. Administrative disable proves an existing factor, never synthesized release-context MFA. AI refusals never auto-retry an identity mutation.

**Review discipline.** Source paths and current integration seams were read before writing; new files are marked Create, not cited as existing implementations. Code fences define each new interface, component, helper, mutation and failing-test assertion. Planned implementation commands are not execution evidence. This plan authoring changes only this Markdown file and makes no product changes or commits.
