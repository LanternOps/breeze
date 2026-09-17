---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner Sending Domains W03: Service, Worker and Routes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything that *calls* W02's data model and adapters: the `sendingDomainService` (list / create / check / remove / identities / admin suspend-unsuspend-force-release / capability), the `syncSendingDomain` state machine with its cadence, the `sending-domains` BullMQ worker (sweep, outbox drain, test send, daily maintenance, key probe), the `staff.sending_domain_status` transactional mail, and the two route files (`/partner/sending-domains`, `/admin/sending-domains`). It lands **dark**: `EMAIL_DOMAINS_PROVIDER` is unset, so `getEmailDomainProvider()` returns `null`, every route answers `404 sending_domains_unsupported`, and the worker is not registered.

**Architecture:** Request handlers only write intent rows and enqueue; the worker owns every provider call (spec §2). `syncSendingDomain` advances one row one step per job, idempotently, in **three phases with explicit DB-context boundaries** (short system transaction → provider call with NO context held → short system transaction), the `ticketOutboxPublisher.ts` shape. Provisioning commits `provision_attempted_at` in phase 1 *before* the provider `createDomain` in phase 2, so a crash between them is classified as "ours" on retry (spec §5.1 case 3) instead of adopted as pre-existing. `removing` deletes at the provider **only when `provider_managed`**, then nulls `provider_domain_id`, then deletes the row — in that order, because W02's `BEFORE DELETE` guard raises while `provider_domain_id IS NOT NULL`. Creates avoid the 23505-aborts-the-request-transaction trap entirely by using `onConflictDoNothing({ target: … }).returning()` and treating a missing row as the conflict (the repo's preferred idiom, `routes/partnerServicePrincipals.ts:277-279`).

**Tech Stack:** Hono + Zod (`lib/validation`'s `zValidator`), Drizzle, BullMQ on the shared ioredis connection (`services/redis.ts`'s `getBullMQConnection()`), Redis sliding-window limiter (`services/rate-limit.ts`), Vitest (unit + one real-Postgres integration extension).

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md` §2 (one-worker rule), §3.1–§3.3 (columns), §4.3 (`409 domain_unavailable`), §4.4 (identity rules), §5.1–§5.2 (adapter classification, status map), §6.1–§6.4 (jobs, cadence, transitions, drift), §7 (API), §9.1 (kill switch, caps, audit), §13 (error table), §14 (testing). Index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md` — amendment 1 (W02 split), amendment 5 (`staff.sending_domain_status` is added here with its send site).

---

## Plan amendments

Recorded here because the spec or the index does not pin them and the real code forced the choice. Each one is also listed in the reply that accompanied this plan.

1. **The provider key probe crosses a process boundary, so it lives in Redis, not a module variable.** Spec §5.1 says the worker probes `listDomains()` once on start and a permission error sets the capability to `supported: false, reason: 'provider_key_send_only'`. In production `BREEZE_ROLE=worker` and `BREEZE_ROLE=api` are **separate processes** (`worker.ts` vs `index.ts`), so a flag set in the worker's module scope is invisible to the route that renders the capability. The worker writes the probe verdict to the Redis key `emaildomains:key-probe:v1` with a 25 h TTL (re-written on every boot and by the daily maintenance job); `getSendingDomainsCapability` reads it. A missing/unreadable key means "not probed" and never blocks — the capability then reports no `provider_key_send_only` reason. Routes still make **zero** provider calls.
2. **The daily job is a cron slot, never `repeat: { every: 24h }`, and it carries BOTH the hosted drift report and the `static` re-check.** BullMQ anchors `every` to the Unix epoch, so every 24 h repeatable fires at 00:00:00.000 UTC — `jobs/scheduleRegistry.ts:1-63` documents the resulting production pile-up, and `scheduleRegistry.contract.test.ts` ("registers no repeatable job with an hour-or-coarser `every` interval", `:490`) fails the build for one. This wave allocates one new slot, `'sending-domains-daily': '3 21 * * *'` (hour 21 is unused in the daily ≡ 3 mod 5 lane), and one `daily-maintenance` job that runs the drift report when `isHosted()` and the `static` delist re-check when `provider.verifiesByDns === false`. The same job is also enqueued once, un-repeated, at worker boot — that is what satisfies spec §6.1's "re-run on worker start and daily".
3. **Registering the worker only when configured needs a new readiness rule, not just an early `return`.** `jobs/workerReadinessManifest.ts` declares each registry entry's consumers and requires them; a plain `consumers('sendingDomainsWorker')` row would `expect(name, true)` on a default (unconfigured) deployment while `initializeSendingDomainsWorker()` returns before constructing a Worker, pinning `/ready` false forever — exactly the hazard `workerReadinessManifest.ts:60-64` records for `aiAgentRunner`. This wave adds the `'sending_domains_configured'` `ConsumerRequirementRule`, its `ruleEnabled` case, the `sendingDomainsConfigured` field on `declareExpectedConsumers`'s input, both call sites (`index.ts:1170`, `worker.ts:595`) and the rule mirror in `workerReadinessManifest.test.ts`.
4. **`createSendingDomain` never raises 23505.** The repo's trap (`utils/pgErrors.ts:42-57`, prod incident 2026-09-15) is that a unique violation raised on the request's own `withDbAccessContext` transaction aborts it even when caught, so the mapped 409 surfaces as a 500 at commit. `partner_sending_domains` has a plain `UNIQUE (domain)`, so the sanctioned form applies directly: `onConflictDoNothing({ target: partnerSendingDomains.domain }).returning()` and `if (!created) → 409 domain_unavailable`. No savepoint, no catch, nothing raised. (The savepoint form, `db.transaction` + `isPgUniqueViolation(err, name)`, is only needed for partial/expression indexes — it is not needed here.)
5. **The cross-partner `partner_inbound_domains` check (§3.4) must go through `readWithPartnerAxisVisibility`.** `partner_inbound_domains` is partner-axis, so a partner-scoped RLS context reading it by domain sees **zero rows** for another partner's row and the check would silently pass. `db/partnerAxisRead.ts`'s escape is the sanctioned read for exactly this. The lookup key is the requested domain (already normalised); no partner id from request input is ever used as an axis.
6. **The admin routes mount on the admin hub, not on `apps/api/src/index.ts`.** `routes/admin/index.ts:13-15` already applies `platformAdminMiddleware` to everything it mounts (`adminRoutes` itself is mounted at `index.ts:1084`). Only `partnerSendingDomainsRoutes` is added to `index.ts`, and it must be registered **before** `api.route('/partner', partnerRoutes)` at `index.ts:1004`, the same ordering constraint `/partner/trust` observes.
7. **The test send is capped by the route limit alone in this wave.** Spec §6.1 says the test send counts against the daily partner-lane cap, but `tryCountPartnerLaneSend` is defined in W04 (index, "Defined in W04"). In W03 the only bound is the route's 5/h/partner limit; W04 adds the cap call to the `test-send` processor.
8. **The "Partner Admin" recipient query is implemented locally, not extracted.** No `getPartnerAdminEmails` helper exists; the `partnerUsers → users → roles` join on `roles.name = 'Partner Admin'` is duplicated today in `routes/auth/accountDeletion.ts:62-98` and `services/tenantOffboarding.ts:1767-1783`. W03 writes a third copy inside `services/emailDomains/statusMail.ts` with a comment naming the other two, rather than refactoring two unrelated files in a tenancy-surface PR.
9. **The status-mail template lives in `statusMail.ts`, not in `services/email.ts`.** It is written in the `buildQuoteOutcomeTemplate` idiom (`renderLayout` + `BODY_PARA`/`MUTED_PARA` + a hand-built text arm returning `EmailTemplate`) but placed beside its send site, the precedent `services/quoteEmail.ts:2` already sets by importing `supportFooter, BODY_PARA, MUTED_PARA, type EmailTemplate` back from `./email`. `email.ts` is 1295 lines; this keeps it from growing.

### Added when W02's finished plan was reconciled against this one

10. **A sixth registration list: `ALLOWED_WITHOUT_CAPABILITY_CHECK`.** `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:64` derives the partner-axis table set from the **live Drizzle schema** (`partnerAxisTableNames()`: any table with `partnerId` and no `notNull` `orgId`), so `partnerSendingDomains` and `partnerSenderIdentities` join it the moment W02's Task 1 lands. It then greps every `.ts` under `src/routes/**` and `src/services/**` (`collectSourceFiles()`, `:290-291`) for `\.(insert|update|delete)\(\s*<table>\s*[,)]` and fails the required **Test API** job unless the file mentions `canManagePartnerWidePolicies` or is allowlisted with a reason of ≥ 20 characters. **Verified: `src/jobs/**` is NOT scanned**, so `jobs/sendingDomainsWorker.ts` needs no entry even though it updates `partnerSendingDomains`. Two W03 files do: `services/emailDomains/sendingDomainService.ts` (Task 6) and `services/emailDomains/domainSync.ts` (Task 3). Each task registers its own file so every task is green standing alone — the test's "no stale entries" case (`:354`) additionally means an entry may not be added before the file mutates the table. W02 registers `services/emailDomains/domainRelease.ts` the same way (its amendment 3); the routes are not flagged because they mutate nothing directly.
11. **The write routes gain a `canManagePartnerWidePolicies` gate.** Not merely to satisfy amendment 10 — on the merits. A sending domain and a sender identity are partner-wide by construction: the From address applies to every org under the MSP, including orgs created later, which is exactly what epic #2135's rule protects and what `partnerServicePrincipals.ts` was fixed for in the 2026-08-16 review. `PATCH /partners/me`, which spec §7 names as the model stack, carries this gate inline (`routes/orgs.ts:911-916`) — the spec's summary of that stack simply omitted it. So an `orgAccess: 'selected'` partner user cannot add, re-point or remove the MSP's sending identity. The two service files stay allowlisted, with reasons pointing at this gate.
12. **`normalizeSendingDomain` returns a discriminated union, not `string | null`.** W02 Task 3 pins `NormalizeSendingDomainResult = { ok: true; domain } | { ok: false; reason: SendingDomainRejection }`. `createSendingDomain` therefore checks `result.ok` and surfaces `reason` in the 400 body, which is strictly better than the `null` this plan first assumed: the UI can say *why* the domain was refused. Identity validation likewise uses W02's `senderLocalPartSchema` / `senderDisplayNameSchema` / `RESERVED_SENDER_LOCAL_PARTS` instead of the regex this plan originally hand-rolled — one definition, shared with the web.
13. **A `pending` result from a non-DNS adapter is "no change", and provisioning must carry the partner slug.** Both are W02 contracts (its amendments 4 and 5). `static.getDomain(key)` keys on the **domain name** (there is no provider id) and *never* returns `verified` — only an accepted test send moves a `static` row there — so `syncSendingDomain` acts on `failed` alone when `provider.verifiesByDns === false`, or every daily re-check would demote a verified `static` domain back to `pending`. And `createDomain` takes `partnerSlug`, because `EMAIL_DOMAINS_STATIC_ALLOWED` binds entries by slug (`domain:partner-slug`), so the provisioning phase loads the partner's `slug` alongside the domain row and passes it.
14. **The drift report resolves `createdAt` with `findDomainByName`, not from `listDomains()`.** W02 pins `listDomains(): Promise<Array<{ providerDomainId; domain }>>` — no creation time. Spec §6.4 only alerts on a provider domain **older than 24 h**, so the report fetches `findDomainByName(domain)` for each *unknown* domain (rare by construction: a leak, not a routine row) and treats a missing `createdAt` as reportable rather than suppressing it. Error classification during provisioning likewise keys on W02's `ProviderDomainConflictError` / `ProviderDomainRejectedError` classes, not on an ad-hoc `err.reason` property.

## Consumed from W02 (reconciled against its finished plan)

W02's plan is complete (`docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains-w02-data-model-and-adapters.md`). Every name below was read from its Interfaces blocks and is binding — this wave does not guess any of them. Where W02's shape differs from the plan index's "Defined in W02" list, W02 wins and the difference is called out.

```ts
// packages/shared/src/validators/sendingDomains.ts  (W02 Task 3)
export const SENDING_DOMAIN_STATUSES: readonly ['provisioning','pending','verified','at_risk','failed','suspended','removing'];
export const SENDING_DOMAIN_STATUS_REASONS: readonly ['provider_conflict','provider_rejected','quota_exhausted','dns_not_detected','dns_removed','platform_suspended','abuse_auto','failed_expired','user_removed'];
export const PARTNER_MAIL_STREAMS: readonly ['support','billing','general'];
export type SendingDomainStatusValue   = (typeof SENDING_DOMAIN_STATUSES)[number];
export type SendingDomainStatusReason  = (typeof SENDING_DOMAIN_STATUS_REASONS)[number];
export type PartnerMailStreamValue     = (typeof PARTNER_MAIL_STREAMS)[number];
export type SendingDomainRejection =
  | 'empty' | 'scheme' | 'path' | 'port' | 'at_sign' | 'wildcard' | 'ip_literal'
  | 'too_few_labels' | 'label_length' | 'label_charset' | 'too_long' | 'numeric_tld' | 'idn_invalid';
// NOT `string | null` — a DISCRIMINATED UNION carrying the rejection reason.
export type NormalizeSendingDomainResult = { ok: true; domain: string } | { ok: false; reason: SendingDomainRejection };
export function normalizeSendingDomain(input: string): NormalizeSendingDomainResult;
export const RESERVED_SENDER_LOCAL_PARTS: readonly ['postmaster','abuse','mailer-daemon'];
export const SENDER_LOCAL_PART_PATTERN: RegExp;
export const SENDER_LOCAL_PART_MAX: number;      // 64
export const SENDER_DISPLAY_NAME_MAX: number;    // 78
export const senderLocalPartSchema: z.ZodType<string>;
export const senderDisplayNameSchema: z.ZodType<string>;
export const createSendingDomainSchema: z.ZodType<{ domain: string }>;
export const upsertSenderIdentitySchema: z.ZodType<{ sendingDomainId: string; localPart: string; displayName?: string | null; replyTo?: string | null }>;

// packages/shared/src/types/sendingDomains.ts  (W02 Task 3) — field sets are EXACT
export type SendingDomainProviderId = 'resend' | 'ses' | 'static' | 'fake';
export interface SendingDomainDnsRecordDto {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string; fqdn: string; value: string;
  priority?: number; ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}
export interface SendingDomainDto {              // ISO-8601 STRINGS, not Date
  id: string; domain: string; provider: SendingDomainProviderId;
  status: SendingDomainStatusValue; statusReason: SendingDomainStatusReason | null;
  dnsRecords: SendingDomainDnsRecordDto[];
  verifiedAt: string | null; lastCheckedAt: string | null;
  lastTestAt: string | null; lastTestStatus: 'pending' | 'sent' | 'failed' | null; lastTestError: string | null;
  lastSendError: string | null; lastSendErrorAt: string | null;
  statusChangedAt: string;                       // ISO, from status_changed_at (NOT NULL)
  providerManaged: boolean; createdAt: string;
}                                                // no providerRegion, no nextCheckAt
export interface SenderIdentityDto {
  id: string; stream: PartnerMailStreamValue; sendingDomainId: string;
  domain: string;                                // the JOINED domain name
  localPart: string; displayName: string | null; replyTo: string | null;
  fromAddress: string;                           // computed `localPart@domain`
  updatedAt: string;
}
export interface SendingDomainsCapabilityDto {
  supported: boolean; provider: SendingDomainProviderId | null; verifiesByDns: boolean;
  eligible: boolean; reason?: string; maxDomains: number;
}
export interface SendingDomainsListResponse {
  capability: SendingDomainsCapabilityDto; domains: SendingDomainDto[]; identities: SenderIdentityDto[];
}

// apps/api/src/services/emailDomains/domainPolicy.ts  (W02 Task 4)
export type SendingDomainPolicyRejection = 'platform_domain' | 'consumer_domain' | 'public_suffix' | 'denylisted';
export class SendingDomainPolicyError extends Error { readonly reason: SendingDomainPolicyRejection }
export function assertSendingDomainAllowed(domain: string): void;   // throws; input already normalised
export const PLATFORM_OWNED_DOMAINS: readonly ['2breeze.app', 'breezermm.com', 'lanternops.io'];

// apps/api/src/services/emailDomains/config.ts  (W02 Task 5)
// NOTE: the env KEYS are declared in the zod `envObjectSchema` of
// apps/api/src/config/validate.ts, NOT in config/env.ts (W02 amendment 1).
// This module is the only typed reader; W03 never reads process.env directly.
export type EmailDomainsProviderId = 'resend' | 'static' | 'fake';
export interface StaticAllowedEntry { domain: string; partnerSlug: string | null }
export interface EmailDomainsConfig {
  provider: EmailDomainsProviderId | null;
  resendApiKey: string | null; resendSendingKey: string | null;
  region: string; maxPerPartner: number; dailySendCap: number;   // 0 = unlimited
  partnerAllowlist: string[]; denylist: string[];
  staticAllowed: StaticAllowedEntry[];                           // parsed, not raw strings
  webhookSecret: string | null;
}
export function getEmailDomainsConfig(): EmailDomainsConfig;
export function isPartnerLaneConfigured(): boolean;
export function findStaticAllowedEntry(domain: string, partnerSlug: string | null): StaticAllowedEntry | null;

// apps/api/src/services/emailDomains/provider.ts  (W02 Task 6)
export type SendingDomainStatus = 'provisioning'|'pending'|'verified'|'at_risk'|'failed'|'suspended'|'removing';
export interface ProviderDomain {
  providerDomainId: string | null; region?: string;
  createdAt?: Date;            // undefined === AMBIGUOUS -> provider_managed = false
  state: 'pending' | 'verified' | 'at_risk' | 'failed';
  records: ProviderDnsRecord[];
}
export interface CreateProviderDomainInput {
  domain: string; region?: string; partnerRef: string;
  partnerSlug?: string | null;  // W02 amendment 4 — `static` binds its allow-list by SLUG
}
export class PartnerLaneSendFailure extends Error { readonly error: PartnerLaneSendError }
export class ProviderDomainConflictError extends Error { readonly domain: string }   // -> failed/provider_conflict
export class ProviderDomainRejectedError extends Error { readonly domain: string }   // -> failed/provider_rejected
export type PartnerLaneMessage = RawEmailMessage;
export interface EmailDomainProvider {
  readonly id: 'resend' | 'ses' | 'static' | 'fake';
  readonly verifiesByDns: boolean;
  createDomain(i: CreateProviderDomainInput): Promise<ProviderDomain>;
  findDomainByName(domain: string): Promise<ProviderDomain | null>;
  getDomain(providerDomainId: string): Promise<ProviderDomain>;  // `static` keys on the DOMAIN NAME
  requestVerification(providerDomainId: string): Promise<void>;
  deleteDomain(providerDomainId: string): Promise<void>;         // 404 is success
  listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>>;   // NO createdAt
  send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }): Promise<{ providerMessageId: string }>;
}

// apps/api/src/services/emailDomains/providerRegistry.ts  (W02 Task 6)
export function getEmailDomainProvider(): EmailDomainProvider | null;
export function resetEmailDomainProviderForTests(): void;

// apps/api/src/services/emailDomains/adapters/{static,fake}.ts  (W02 Task 8)
export function createStaticDomainProvider(): EmailDomainProvider;
export function createFakeDomainProvider(): EmailDomainProvider;
export function resetFakeDomainProviderState(): void;
export const FAKE_PREEXISTING_PREFIX: string;
export function classifyPlatformTransportError(err: unknown): PartnerLaneSendError;

// apps/api/src/services/emailDomains/domainRelease.ts  (W02 Task 11)
export function releaseSendingDomainsForPartner(partnerId: string): Promise<number>;

// apps/api/src/db/schema/emailSendingDomains.ts  (W02 Task 1) — Drizzle names verbatim
//   partnerSendingDomains: id partnerId domain provider providerDomainId providerManaged
//     provisionAttemptedAt providerRegion status statusReason dnsRecords checkRequestedAt
//     lastCheckedAt nextCheckAt checkAttempts verifiedAt statusChangedAt lastTestAt
//     lastTestStatus('pending'|'sent'|'failed') lastTestError lastSendError lastSendErrorAt
//     createdBy createdAt updatedAt
//     uniqueIndex partner_sending_domains_domain_uq (domain)
//   partnerSenderIdentities: id partnerId sendingDomainId stream localPart displayName replyTo
//     updatedBy createdAt updatedAt
//     uniqueIndex partner_sender_identities_partner_stream_uq (partnerId, stream)
//   emailProviderDomainReleases: id provider providerDomainId providerRegion domain
//     reason('user_removed'|'failed_expired'|'partner_released'|'force_release')  <- CHECK-constrained
//     requestedAt attempts nextAttemptAt(NOT NULL, defaultNow) lastError
//     uniqueIndex email_provider_domain_releases_provider_domain_uq (provider, providerDomainId)
// GatedCapability gains 'custom_sending_domain' (W02 Task 10, services/partnerTrust.ts).
```

From W01: `EmailService.deliverRaw(message: RawEmailMessage): Promise<void>`, `MAIL_PURPOSES` / `MailPurpose` / `PartnerMailStream` in `services/emailDomains/mailPurposes.ts`, `sendEmail({ …, purpose })`.

### Still unpinned — reconcile before merging W03

- **`releaseSendingDomainsForPartner`'s outbox `reason`.** W02's tests write `'partner_released'` for both hooks. W03 never calls that function, so nothing here depends on it; noted only so the CHECK's fourth value (`'force_release'`, which W03's admin force-release writes) is not mistaken for dead.
- **Whether `EmailService.sendEmail` accepts `to: string[]`.** Today's `SendEmailParams.to` is `string | string[]` (`services/email.ts:18`) and W01 keeps `SendEmailBase` as "today's fields minus `from`", so `statusMail.ts` passes an array. If W01 narrows it, `statusMail.ts` joins with `', '` instead.
- **`SendingDomainDto.lastTestStatus` has no `'passed'` value.** W03 writes `'sent'` on success and `'failed'` on a refusal; `'pending'` is unused by this wave (it exists for a queued test the UI can show in W05).

## Names this wave introduces beyond the index

- `apps/api/src/services/emailDomains/statusMail.ts` — `buildSendingDomainStatusTemplate`, `sendSendingDomainStatusEmail`, `type SendingDomainStatusEvent`.
- `apps/api/src/services/emailDomains/keyProbe.ts` — `recordProviderKeyProbe`, `readProviderKeyProbe`.
- `'sending-domains-daily'` in `JOB_SCHEDULES` (`jobs/scheduleRegistry.ts`).
- `'sending_domains_configured'` in `ConsumerRequirementRule` (`jobs/workerReadinessManifest.ts`).

---

## Global Constraints

Binding for every task in this plan. Do not relax any of them without changing the plan index in the same PR.

- **No route handler calls the provider.** Routes write intent rows and enqueue jobs. Task 9 adds a source-scan test asserting neither route file imports `providerRegistry` or any adapter, in both the static and the dynamic import form.
- **All provider management calls happen in the one `sending-domains` worker** (spec §2). `getEmailDomainProvider()` is imported by `domainSync.ts`, `sendingDomainsWorker.ts` and nothing else in this wave.
- **Never delete a provider domain with `provider_managed = false`** (spec §5.1, §14). Removal, partner release and failed-row expiry all drop the local row only; `deleteDomain` is never called and no `email_provider_domain_releases` row is written. Task 3's tests assert this on all three paths.
- **Delete order on `removing` is fixed**: `deleteDomain` (managed only) → `UPDATE … SET provider_domain_id = NULL` → `DELETE` the row. W02's `BEFORE DELETE` trigger raises while `provider_domain_id IS NOT NULL`, so reordering fails loudly.
- **Register every partner-axis write file in `ALLOWED_WITHOUT_CAPABILITY_CHECK`** (`apps/api/src/__tests__/partner-wide-write-coverage.test.ts`) in the SAME task that makes it mutate the table, and put the real gate (`canManagePartnerWidePolicies`) on the caller-facing routes. `src/routes/**` and `src/services/**` are scanned; `src/jobs/**` is not.
- **A `pending` result from an adapter with `verifiesByDns === false` is NO CHANGE.** Only `failed` acts. A `static` row reaches `verified` through `markStaticDomainVerified`, called by the `test-send` job after the relay accepted the message — never through a poll.
- **The worker registers only when a provider is configured** — the `initializeAbuseSignalsWorker` enable-check shape (`jobs/abuseSignalsSweep.ts:149-188`), plus the readiness rule of plan amendment 3.
- **Provider calls never run while a pooled DB connection is held** (#1105). Every provider/Redis/SMTP round trip sits *between* short `withSystemDbAccessContext` phases, never inside one — `jobs/ticketOutboxPublisher.ts:130-260` is the reference shape.
- **Rigor is high** (tenancy, partner cascade, abuse surface). Red first on every task: write the failing test, run it, watch it fail for the stated reason, then implement. Before the PR run the contract suites against a real database: `pnpm test-stack up`, then the integration and RLS runs of Task 11, then `pnpm test-stack down`.
- Branch `feature/__PARENT__-partner-sending-domains/wave-__W03__`; PR body contains `Closes #__W03__`. `get_feature_status` before starting.
- Test command form is `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run <path>` (the `--` is forwarded into argv and vitest runs the whole suite in watch mode).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/emailDomains/domainSync.ts` (+ `.test.ts`) | `nextCheckDelayMs` (T1), `syncSendingDomain` state machine (T3) | 1, 3 |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | `ALLOWED_WITHOUT_CAPABILITY_CHECK` entries for `domainSync.ts` (T3) and `sendingDomainService.ts` (T6) | 3, 6 |
| `apps/api/src/services/emailDomains/statusMail.ts` (+ `.test.ts`) | `buildSendingDomainStatusTemplate`, `sendSendingDomainStatusEmail`, Partner-Admin recipients | 2 |
| `apps/api/src/services/emailDomains/mailPurposes.ts` | `'staff.sending_domain_status': { lane: 'platform' }` (W01 file) | 2 |
| `apps/api/src/services/emailDomains/keyProbe.ts` (+ `.test.ts`) | Redis-backed `listDomains` key-probe verdict | 4 |
| `apps/api/src/jobs/sendingDomainsWorker.ts` (+ `.test.ts`) | queue `sending-domains`; `sync-domain`, `sweep`, `test-send`, `daily-maintenance`; enqueue helpers; init/shutdown | 4 |
| `apps/api/src/jobs/scheduleRegistry.ts` | `'sending-domains-daily': '3 21 * * *'` | 4 |
| `apps/api/src/services/workerRegistry.ts` | `sendingDomainsWorker` entry, `placement: 'global'` | 5 |
| `apps/api/src/jobs/workerReadinessManifest.ts` (+ `.test.ts`), `apps/api/src/index.ts`, `apps/api/src/worker.ts` | `'sending_domains_configured'` rule + both call sites | 5 |
| `apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts` | registry/manifest parity | 5 |
| `apps/api/src/services/emailDomains/sendingDomainService.ts` (+ `.test.ts`) | list/create/check/remove/identities/admin/capability | 6 |
| `apps/api/src/routes/partnerSendingDomains.ts` (+ `.test.ts`) | the seven routes of spec §7 | 7 |
| `apps/api/src/routes/admin/sendingDomains.ts` (+ `.test.ts`) | list across partners, suspend, unsuspend, force-release | 8 |
| `apps/api/src/index.ts`, `apps/api/src/routes/admin/index.ts`, `apps/api/src/routes/sendingDomainsMounting.test.ts` | mounting + no-provider-import source scan | 9 |
| `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` | real-Postgres `removing` guard order + sweep claim under system scope (extends W02's file) | 10 |

---

### Task 1: Cadence — `nextCheckDelayMs`

**Files:**
- Create: `apps/api/src/services/emailDomains/domainSync.ts`
- Create: `apps/api/src/services/emailDomains/domainSync.test.ts`

**Interfaces:**
- Consumes: `SendingDomainStatus` from `./provider` (W02).
- Produces: `export function nextCheckDelayMs(status: SendingDomainStatus, checkAttempts: number, rng?: () => number): number`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/domainSync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextCheckDelayMs } from './domainSync';

const MIN = 60_000;

describe('nextCheckDelayMs (spec §6.2)', () => {
  it('polls a pending domain every 2 minutes for the first five attempts', () => {
    for (const attempts of [0, 1, 2, 3, 4]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(2 * MIN);
    }
  });

  it('slows a pending domain to 10 minutes for the next six attempts', () => {
    for (const attempts of [5, 6, 7, 8, 9, 10]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(10 * MIN);
    }
  });

  it('settles a pending domain at hourly until the provider fails it', () => {
    expect(nextCheckDelayMs('pending', 11)).toBe(60 * MIN);
    expect(nextCheckDelayMs('pending', 400)).toBe(60 * MIN);
  });

  it('polls at_risk hourly, whatever the attempt count', () => {
    expect(nextCheckDelayMs('at_risk', 0)).toBe(60 * MIN);
    expect(nextCheckDelayMs('at_risk', 99)).toBe(60 * MIN);
  });

  it('polls failed hourly so the 72h expiry sweep can fire', () => {
    expect(nextCheckDelayMs('failed', 0)).toBe(60 * MIN);
  });

  it('re-checks a verified domain daily with at most +/-10% jitter', () => {
    const day = 24 * 60 * MIN;
    expect(nextCheckDelayMs('verified', 0, () => 0)).toBe(Math.round(day * 0.9));
    expect(nextCheckDelayMs('verified', 0, () => 1)).toBe(Math.round(day * 1.1));
    expect(nextCheckDelayMs('verified', 0, () => 0.5)).toBe(day);
  });

  it('spreads verified rows rather than stacking them on one instant', () => {
    const values = new Set([0.05, 0.25, 0.45, 0.65, 0.85].map((r) => nextCheckDelayMs('verified', 0, () => r)));
    expect(values.size).toBe(5);
  });

  it('retries provisioning and removing quickly, and parks suspended for a day', () => {
    expect(nextCheckDelayMs('provisioning', 0)).toBe(MIN);
    expect(nextCheckDelayMs('removing', 0)).toBe(MIN);
    expect(nextCheckDelayMs('suspended', 0)).toBe(24 * 60 * MIN);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainSync.test.ts`
Expected: the whole file fails to collect — `Failed to resolve import "./domainSync"`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/emailDomains/domainSync.ts`:

```ts
import type { SendingDomainStatus } from './provider';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Attempts served at the 2-minute cadence before stepping down (spec §6.2). */
const PENDING_FAST_ATTEMPTS = 5;
/** Attempts served at the 10-minute cadence after that, before going hourly. */
const PENDING_MEDIUM_ATTEMPTS = 6;

/**
 * Row-level poll cadence (spec §6.2). Returned as a DELAY, not an absolute
 * time, so the caller owns `now` and every test can pin it.
 *
 *   pending   2 min x5, then 10 min x6, then hourly until the provider fails it
 *   at_risk   hourly (the provider's own 72 h grace is what ends this state)
 *   verified  every 24 h +/- 10% jitter, PER ROW
 *   failed    hourly, purely so the 72 h `failed_expired` check runs
 *
 * The jitter is the whole reason `verified` is not a daily cron: without it
 * every row verified in the same tick re-checks in the same minute forever,
 * and the fleet re-converges. Same helper shape as
 * `services/m365Sync/cadence.ts`'s `nextSyncAt` — `rng` exists only so a test
 * can pin it.
 */
export function nextCheckDelayMs(
  status: SendingDomainStatus,
  checkAttempts: number,
  rng: () => number = Math.random,
): number {
  switch (status) {
    case 'provisioning':
    case 'removing':
      // Both are "the worker still owes this row an external call". The job's
      // own BullMQ retry is the primary recovery; this is the sweep's backstop.
      return MINUTE_MS;
    case 'pending': {
      const attempts = Math.max(0, Math.trunc(checkAttempts));
      if (attempts < PENDING_FAST_ATTEMPTS) return 2 * MINUTE_MS;
      if (attempts < PENDING_FAST_ATTEMPTS + PENDING_MEDIUM_ATTEMPTS) return 10 * MINUTE_MS;
      return HOUR_MS;
    }
    case 'at_risk':
    case 'failed':
      return HOUR_MS;
    case 'verified': {
      const jitter = 0.9 + rng() * 0.2;
      return Math.round(DAY_MS * jitter);
    }
    case 'suspended':
      // No provider calls at all (spec §6.1); the row is only revisited so an
      // unsuspend that raced the sweep is not stuck behind a stale next_check_at.
      return DAY_MS;
  }
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainSync.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/emailDomains/domainSync.ts apps/api/src/services/emailDomains/domainSync.test.ts
git commit -m "feat(email-domains): sending-domain poll cadence with per-row jitter (spec 6.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Status mail — registry entry, template, send site

**Files:**
- Create: `apps/api/src/services/emailDomains/statusMail.ts`
- Create: `apps/api/src/services/emailDomains/statusMail.test.ts`
- Modify: `apps/api/src/services/emailDomains/mailPurposes.ts` — add one key to the `MAIL_PURPOSES` object literal, in the `staff.*` block immediately after `'staff.quote_outcome'` (the file is created by W01; the block mirrors spec §8.2 row 6)

**Interfaces:**
- Consumes: `getEmailService()` and `BODY_PARA` / `MUTED_PARA` / `supportFooter` / `EmailTemplate` from `../email`; `renderLayout`, `escapeHtml` from `../emailLayout`; `MAIL_PURPOSES` from `./mailPurposes`.
- Produces:
  ```ts
  export type SendingDomainStatusEvent = 'verified' | 'at_risk' | 'failed' | 'suspended' | 'auto_removed';
  export interface SendingDomainStatusMailInput {
    partnerId: string; domain: string; event: SendingDomainStatusEvent;
    statusReason?: string | null; createdBy?: string | null; appUrl?: string | null;
  }
  export function buildSendingDomainStatusTemplate(input: SendingDomainStatusMailInput): EmailTemplate;
  export async function sendSendingDomainStatusEmail(input: SendingDomainStatusMailInput): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/statusMail.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/quoteOutcomeNotify.test.ts pattern).
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
}));
vi.mock('../email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { MAIL_PURPOSES } from './mailPurposes';
import { buildSendingDomainStatusTemplate, sendSendingDomainStatusEmail } from './statusMail';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockResolvedValue(undefined);
});

describe('staff.sending_domain_status registry entry', () => {
  it('is a PLATFORM purpose — a broken-domain notice must not be sent from that domain', () => {
    expect(MAIL_PURPOSES['staff.sending_domain_status']).toEqual({ lane: 'platform' });
  });
});

describe('buildSendingDomainStatusTemplate', () => {
  it('names the domain and the event in the subject for each of the five events', () => {
    const cases: Array<[Parameters<typeof buildSendingDomainStatusTemplate>[0]['event'], string]> = [
      ['verified', 'verified'],
      ['at_risk', 'at risk'],
      ['failed', 'could not be verified'],
      ['suspended', 'suspended'],
      ['auto_removed', 'removed'],
    ];
    for (const [event, fragment] of cases) {
      const tpl = buildSendingDomainStatusTemplate({ partnerId: PARTNER_ID, domain: 'mail.acme.test', event });
      expect(tpl.subject).toContain('mail.acme.test');
      expect(tpl.subject.toLowerCase()).toContain(fragment);
      expect(tpl.html).toContain('mail.acme.test');
      expect(tpl.text).toContain('mail.acme.test');
    }
  });

  it('renders the machine status reason as human text and escapes the domain', () => {
    const tpl = buildSendingDomainStatusTemplate({
      partnerId: PARTNER_ID, domain: 'a<b>.test', event: 'failed', statusReason: 'dns_not_detected',
    });
    expect(tpl.html).toContain('a&lt;b&gt;.test');
    expect(tpl.html).not.toContain('<b>.test');
    expect(tpl.text).toContain('DNS records were not detected');
  });
});

describe('sendSendingDomainStatusEmail', () => {
  it('emails the adder plus every active Partner Admin, deduplicated, with the platform purpose', async () => {
    dbResults.push([{ email: 'adder@acme.test' }]);                       // createdBy lookup
    dbResults.push([{ email: 'admin@acme.test' }, { email: 'adder@acme.test' }]); // partner admins

    const sent = await sendSendingDomainStatusEmail({
      partnerId: PARTNER_ID, domain: 'mail.acme.test', event: 'verified', createdBy: CREATOR_ID,
    });

    expect(sent).toBe(2);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('staff.sending_domain_status');
    expect(envelope.to).toEqual(['adder@acme.test', 'admin@acme.test']);
  });

  it('still reaches the partner admins when the adder has been deleted', async () => {
    dbResults.push([{ email: 'admin@acme.test' }]);
    const sent = await sendSendingDomainStatusEmail({
      partnerId: PARTNER_ID, domain: 'mail.acme.test', event: 'failed', createdBy: null,
    });
    expect(sent).toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toEqual(['admin@acme.test']);
  });

  it('is a no-op that never throws when nobody can be resolved', async () => {
    dbResults.push([]);
    dbResults.push([]);
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'suspended', createdBy: CREATOR_ID }),
    ).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('swallows a transport failure — a status transition must not be rolled back by a bounced notice', async () => {
    dbResults.push([{ email: 'adder@acme.test' }]);
    dbResults.push([]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'verified', createdBy: CREATOR_ID }),
    ).resolves.toBe(0);
  });

  it('is inert when email is not configured', async () => {
    getEmailServiceMock.mockReturnValue(null);
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'verified' }),
    ).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/emailDomains/statusMail.test.ts`
Expected: collection fails — `Failed to resolve import "./statusMail"`.

- [ ] **Step 3: Add the registry entry**

In `apps/api/src/services/emailDomains/mailPurposes.ts`, inside the `MAIL_PURPOSES` object literal, immediately after the `'staff.quote_outcome'` entry, add:

```ts
  // W03. The notice that a partner's own sending domain is verified / at risk
  // / failed / suspended / auto-removed. PLATFORM on purpose: a mail saying
  // "your sending domain is broken" must never be sent from that domain
  // (spec §6.3). Its send site is services/emailDomains/statusMail.ts.
  'staff.sending_domain_status': { lane: 'platform' },
```

- [ ] **Step 4: Implement the template and send site**

Create `apps/api/src/services/emailDomains/statusMail.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerUsers, roles, users } from '../../db/schema';
import { BODY_PARA, MUTED_PARA, getEmailService, supportFooter, type EmailTemplate } from '../email';
import { escapeHtml, renderButton, renderLayout } from '../emailLayout';
import { captureException } from '../sentry';

export type SendingDomainStatusEvent = 'verified' | 'at_risk' | 'failed' | 'suspended' | 'auto_removed';

export interface SendingDomainStatusMailInput {
  partnerId: string;
  domain: string;
  event: SendingDomainStatusEvent;
  /** Machine code from partner_sending_domains.status_reason (spec §3.1). */
  statusReason?: string | null;
  /** users.id of whoever added the domain; may be null after a user delete. */
  createdBy?: string | null;
  /** Absolute link to the settings tab; omitted when PUBLIC_APP_URL is unset. */
  appUrl?: string | null;
}

const HEADLINE: Record<SendingDomainStatusEvent, string> = {
  verified: 'Sending domain verified',
  at_risk: 'Sending domain at risk',
  failed: 'Sending domain could not be verified',
  suspended: 'Sending domain suspended',
  auto_removed: 'Sending domain removed',
};

const LEAD: Record<SendingDomainStatusEvent, (domain: string) => string> = {
  verified: (d) => `${d} is verified. Mail for the streams you have configured now sends from it.`,
  at_risk: (d) => `We can no longer see the DNS records for ${d}. Mail still sends for now, but the provider will fail the domain if the records stay missing.`,
  failed: (d) => `${d} could not be verified and is not sending any mail.`,
  suspended: (d) => `${d} has been suspended by Breeze. Mail for its streams is sending from the Breeze address instead.`,
  auto_removed: (d) => `${d} was removed after staying unverified past the retry window. You can add it again once its DNS records are in place.`,
};

/** status_reason codes (spec §3.1) rendered for a human. Unknown codes are omitted rather than leaked raw. */
const REASON_TEXT: Record<string, string> = {
  provider_conflict: 'The domain is already registered with Breeze or our email provider.',
  provider_rejected: 'Our email provider refused the domain.',
  quota_exhausted: 'Our email provider is at its domain limit. Support has been alerted.',
  dns_not_detected: 'The DNS records were not detected in time.',
  dns_removed: 'The DNS records were removed after the domain had verified.',
  platform_suspended: 'A Breeze administrator suspended the domain.',
  abuse_auto: 'Automatic suspension after a deliverability problem.',
  failed_expired: 'The domain stayed unverified past the retry window.',
  user_removed: 'Removed at your request.',
};

/**
 * Same idiom as `buildQuoteOutcomeTemplate` (services/email.ts): compute
 * subject/preheader/body, run every interpolated value through `escapeHtml`,
 * build the HTML through the shared `renderLayout` shell (never a hand-written
 * one), and assemble the text arm by filtering nulls out of a line list.
 * Breeze-branded — this goes TO the MSP, not to their customer.
 */
export function buildSendingDomainStatusTemplate(input: SendingDomainStatusMailInput): EmailTemplate {
  const subject = `${HEADLINE[input.event]}: ${input.domain}`;
  const lead = LEAD[input.event](input.domain);
  const reason = input.statusReason ? REASON_TEXT[input.statusReason] : undefined;

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      ${reason ? `<p style="${BODY_PARA}">${escapeHtml(reason)}</p>` : ''}
      ${input.appUrl ? renderButton('Open sending domains', input.appUrl) : ''}
      <p style="${MUTED_PARA}">You are receiving this because you added this domain, or you administer this Breeze account.</p>
  `;

  const html = renderLayout({
    title: subject,
    preheader: lead,
    heading: HEADLINE[input.event],
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });

  const text = [
    lead,
    reason ?? null,
    input.appUrl ? `Open sending domains: ${input.appUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

/**
 * Recipients: the user who added the domain plus the partner's admins
 * (spec §6.3). Runs in SYSTEM scope — `partner_users` / `users` are partner-axis
 * and this is called from the worker, which has no tenant context at all.
 *
 * The `roles.name = 'Partner Admin'` join is duplicated rather than shared: the
 * same query already exists at `routes/auth/accountDeletion.ts:62-98` and
 * `services/tenantOffboarding.ts:1767-1783`, and extracting a helper would mean
 * editing two unrelated files inside a tenancy-surface PR. If a third caller
 * appears after this one, extract all four together.
 */
async function resolveRecipients(input: SendingDomainStatusMailInput): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const out: string[] = [];
    if (input.createdBy) {
      const creator = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, input.createdBy), eq(users.status, 'active')))
        .limit(1);
      const email = creator[0]?.email?.trim();
      if (email) out.push(email);
    }
    const admins = await db
      .select({ email: users.email })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
      .where(and(
        eq(partnerUsers.partnerId, input.partnerId),
        eq(roles.name, 'Partner Admin'),
        eq(users.status, 'active'),
      ));
    for (const row of admins) {
      const email = row.email?.trim();
      if (email) out.push(email);
    }
    return [...new Set(out)];
  }, 'sendingDomainStatusMailRecipients');
}

/**
 * Fire the status notice. Returns the number of addresses it went to.
 *
 * NEVER throws: this is called after a status transition has already been
 * committed, and a bounced notice must not turn a correct transition into a
 * failed job that retries the provider call.
 */
export async function sendSendingDomainStatusEmail(input: SendingDomainStatusMailInput): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  try {
    const to = await resolveRecipients(input);
    if (to.length === 0) return 0;
    const template = buildSendingDomainStatusTemplate(input);
    // The DB context above has closed; the transport round trip runs with no
    // pooled connection held (#1105).
    await email.sendEmail({
      to,
      purpose: 'staff.sending_domain_status',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    console.error('[SendingDomains] status email failed:', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return 0;
  }
}
```

- [ ] **Step 5: Run it green**

Run: `cd apps/api && npx vitest run src/services/emailDomains/statusMail.test.ts`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/emailDomains/statusMail.ts apps/api/src/services/emailDomains/statusMail.test.ts apps/api/src/services/emailDomains/mailPurposes.ts
git commit -m "feat(email-domains): staff.sending_domain_status notice and its purpose registry entry

Platform lane on purpose (spec 6.3): a notice that the partner's own domain is
broken must not be sent from that domain.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `syncSendingDomain` state machine

**Files:**
- Modify: `apps/api/src/services/emailDomains/domainSync.ts` — append below `nextCheckDelayMs` (the file's only export after Task 1)
- Modify: `apps/api/src/services/emailDomains/domainSync.test.ts` — append a second `describe` block below the cadence block
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` — one `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry (see Step 0; this file starts mutating `partnerSendingDomains` in this task, and the required **Test API** job reds without it)

**Interfaces:**
- Consumes: `getEmailDomainProvider()` (`./providerRegistry`), `EmailDomainProvider` / `ProviderDomain` / `SendingDomainStatus` / `ProviderDomainConflictError` / `ProviderDomainRejectedError` (`./provider`), `partnerSendingDomains` / `partners` (`../../db/schema`), `db` / `withSystemDbAccessContext` (`../../db`), `sendSendingDomainStatusEmail` (`./statusMail`), `createAuditLogAsync` (`../auditService`), `ANONYMOUS_ACTOR_ID` (`../auditEvents`), `nextCheckDelayMs` (same file).
- Produces:
  ```ts
  export type SyncOutcome =
    | 'no_provider' | 'not_found' | 'provisioned' | 'provision_failed'
    | 'polled' | 'expired' | 'released' | 'deleted' | 'suspended_noop';
  export interface SyncOptions { lastSendError?: string; now?: Date; rng?: () => number }
  export async function syncSendingDomain(domainId: string, opts?: SyncOptions): Promise<SyncOutcome>;
  /** `static` only: an accepted test send IS the verification (spec §5.1). Returns false when it does not apply. */
  export async function markStaticDomainVerified(domainId: string, now?: Date): Promise<boolean>;
  export const FAILED_RETRY_WINDOW_MS: number;   // 72h, spec §4.3/§6.1
  ```

- [ ] **Step 0: Register the file in `ALLOWED_WITHOUT_CAPABILITY_CHECK`**

In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, add to `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`:64`), beside W02's `services/emailDomains/domainRelease.ts` entry:

```ts
  'services/emailDomains/domainSync.ts': 'the sending-domain state machine runs only inside the sending-domains BullMQ worker, under system DB scope, with no caller and no auth context: it takes a domain id from a job payload, advances that ONE row between provider-observed statuses, and creates no partner-owned configuration. Every caller-facing create/update/delete of partner_sending_domains goes through routes/partnerSendingDomains.ts, which carries the canManagePartnerWidePolicies gate',
```

Run: `cd apps/api && npx vitest run src/__tests__/partner-wide-write-coverage.test.ts`
Expected: **FAIL** on "the allowlist has no stale entries" — `domainSync.ts` does not mutate a partner-axis table yet. That red is the proof the entry is real; it goes green at Step 4 once the implementation lands. (The reverse order — implement first — would instead red the "every caller-facing partner-axis write site consults the capability helper" case, which is the same contract seen from the other side.)

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/emailDomains/domainSync.test.ts` (and extend its imports to `import { FAILED_RETRY_WINDOW_MS, markStaticDomainVerified, nextCheckDelayMs, syncSendingDomain } from './domainSync';`, with the mock block placed at the very top of the file, above the existing cadence `describe`):

```ts
// ---------------------------------------------------------------------------
// syncSendingDomain. Mocks live at the top of the file; the cadence block above
// is pure and unaffected by them.
// ---------------------------------------------------------------------------
const { rows, partnerRows, updates, deletes, releases, selectCalls } = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  partnerRows: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  deletes: [] as unknown[],
  releases: [] as Record<string, unknown>[],
  selectCalls: { n: 0 },
}));

vi.mock('../../db', () => {
  // syncSendingDomain issues at most two selects per call, always in this order:
  // (1) the partner_sending_domains row, (2) the partners row for the slug.
  const selectChain = () => {
    const index = selectCalls.n++;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'for']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const result = index === 0
        ? (rows.length > 0 ? [rows[0]] : [])
        : (partnerRows.shift() ?? [{ slug: 'test-partner' }]);
      return Promise.resolve(result).then(resolve);
    };
    return chain;
  };
  const db = {
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { deletes.push(w); }) })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        releases.push(values);
        return { onConflictDoNothing: vi.fn(async () => undefined) };
      }),
    })),
  };
  return {
    db,
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

const { providerMock, getProviderMock } = vi.hoisted(() => {
  const providerMock = {
    id: 'fake' as const,
    verifiesByDns: true,
    createDomain: vi.fn(),
    findDomainByName: vi.fn(),
    getDomain: vi.fn(),
    requestVerification: vi.fn(),
    deleteDomain: vi.fn(),
    listDomains: vi.fn(),
    send: vi.fn(),
  };
  return { providerMock, getProviderMock: vi.fn(() => providerMock as unknown) };
});
vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));

const { statusMailMock } = vi.hoisted(() => ({ statusMailMock: vi.fn(async () => 1) }));
vi.mock('./statusMail', () => ({ sendSendingDomainStatusEmail: statusMailMock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-17T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID,
    partnerId: PARTNER_ID,
    domain: 'mail.acme.test',
    provider: 'fake',
    providerDomainId: null,
    providerManaged: true,
    provisionAttemptedAt: null,
    providerRegion: null,
    status: 'provisioning',
    statusReason: null,
    dnsRecords: [],
    checkRequestedAt: null,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    checkAttempts: 0,
    verifiedAt: null,
    statusChangedAt: NOW,
    createdBy: '22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

function setRow(overrides: Record<string, unknown> = {}) {
  rows.length = 0;
  rows.push(row(overrides));
  selectCalls.n = 0;   // the next select is the domain row again
}

function lastStatus(): string | undefined {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const s = updates[i]!.status;
    if (typeof s === 'string') return s;
  }
  return undefined;
}

describe('syncSendingDomain (spec §6.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0; partnerRows.length = 0; updates.length = 0; deletes.length = 0; releases.length = 0;
    selectCalls.n = 0;
    providerMock.verifiesByDns = true;
    getProviderMock.mockReturnValue(providerMock as unknown);
    statusMailMock.mockResolvedValue(1);
  });

  it('is a no-op when no provider is configured (the dark default)', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('no_provider');
    expect(updates).toHaveLength(0);
  });

  it('returns not_found for a row that has already been deleted', async () => {
    rows.length = 0;
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('not_found');
    expect(providerMock.findDomainByName).not.toHaveBeenCalled();
  });

  // --- provisioning: the four find-then-create cases of spec §5.1 ------------

  it('commits provision_attempted_at BEFORE calling the provider (crash-recovery invariant)', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
    });
    const order: string[] = [];
    providerMock.findDomainByName.mockImplementation(async () => { order.push('provider'); return null; });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    const stampIndex = updates.findIndex((u) => u.provisionAttemptedAt instanceof Date);
    expect(stampIndex).toBe(0);                 // the very first write
    expect(updates[0]!.status).toBeUndefined(); // and it writes nothing else
    expect(order).toEqual(['provider']);        // the provider call came after
  });

  it('case 2 — nothing at the provider: creates, adopts as managed, goes pending and asks for verification', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'eu-west-1', state: 'pending',
      records: [{ purpose: 'dkim', type: 'TXT', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'v', status: 'pending' }],
    });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('provisioned');

    const patch = updates.at(-1)!;
    expect(patch).toMatchObject({
      providerDomainId: 'pd-1', providerRegion: 'eu-west-1', providerManaged: true, status: 'pending',
    });
    expect(patch.dnsRecords).toHaveLength(1);
    expect(providerMock.requestVerification).toHaveBeenCalledWith('pd-1');
  });

  it('case 3 — found but created AFTER our attempt: ours from a crashed run, adopted as MANAGED', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
      createdAt: new Date(NOW.getTime() - 30_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.createDomain).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ providerDomainId: 'pd-1', providerManaged: true, status: 'pending' });
  });

  it('case 4 — found and OLDER than our attempt: pre-existing, adopted as NOT managed', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
      createdAt: new Date(NOW.getTime() - 86_400_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ providerManaged: false });
  });

  it('an ambiguous provider object (no createdAt) resolves to NOT managed', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', state: 'pending', records: [],
    });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(updates.at(-1)).toMatchObject({ providerManaged: false });
  });

  it('an adopted already-verified domain is verified at once and never asked to verify again', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', state: 'verified', records: [], createdAt: new Date(NOW.getTime() - 86_400_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(lastStatus()).toBe('verified');
    expect(updates.at(-1)!.verifiedAt).toBeInstanceOf(Date);
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'verified' }));
  });

  it('a static row waits in pending for its test send: no verification request is ever made', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static' });
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(lastStatus()).toBe('pending');
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('passes the partner SLUG to createDomain — the static allow-list binds by slug', async () => {
    setRow();
    partnerRows.length = 0;
    partnerRows.push([{ slug: 'acme-msp' }]);
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.createDomain).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'mail.acme.test', partnerRef: PARTNER_ID, partnerSlug: 'acme-msp',
    }));
  });

  it.each([
    ['ProviderDomainConflictError', 'provider_conflict'],
    ['ProviderDomainRejectedError', 'provider_rejected'],
  ])('maps a %s to status_reason %s', async (errorName, reason) => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockRejectedValue(Object.assign(new Error('nope'), { name: errorName }));

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('provision_failed');

    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: reason });
    expect(statusMailMock).toHaveBeenCalledTimes(1);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
  });

  it('falls back to provider_rejected for an unclassified provider error', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockRejectedValue(new Error('ECONNRESET'));
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: 'provider_rejected' });
  });

  // --- the `static` contract (W02 amendment 5) ------------------------------

  it('does NOT demote a verified static row when the adapter reports pending', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null, verifiedAt: NOW });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');

    expect(lastStatus()).toBe('verified');
    expect(statusMailMock).not.toHaveBeenCalled();
  });

  it('keys a static getDomain on the DOMAIN NAME, since it has no provider id', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.getDomain).toHaveBeenCalledWith('mail.acme.test');
  });

  it('DOES fail a static row the operator delisted', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'failed', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: 'provider_rejected' });
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
  });
});

describe('markStaticDomainVerified — the only path a static row reaches verified', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0; partnerRows.length = 0; updates.length = 0; deletes.length = 0; releases.length = 0;
    selectCalls.n = 0;
    getProviderMock.mockReturnValue(providerMock as unknown);
    statusMailMock.mockResolvedValue(1);
  });

  it('promotes a pending static row, stamps verified_at, audits and mails', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'pending', providerDomainId: null });

    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(true);

    expect(updates.at(-1)).toMatchObject({ status: 'verified' });
    expect(updates.at(-1)!.verifiedAt).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'verified' }));
  });

  it('refuses to promote a DNS-verifying adapter — only the provider decides there', async () => {
    providerMock.verifiesByDns = true;
    setRow({ status: 'pending', providerDomainId: 'pd-1' });
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op for a row that is not pending, so a repeated test send changes nothing', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op with no provider configured', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
  });

  // --- polling ---------------------------------------------------------------

  it('maps the provider state, advances the cadence and bumps check_attempts', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkAttempts: 2 });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');

    const patch = updates.at(-1)!;
    expect(patch.checkAttempts).toBe(3);
    expect(patch.lastCheckedAt).toBeInstanceOf(Date);
    expect((patch.nextCheckAt as Date).getTime()).toBe(NOW.getTime() + nextCheckDelayMs('pending', 3));
  });

  it('honours a Check now by requesting verification first, but only when the adapter verifies by DNS', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkRequestedAt: NOW, lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).toHaveBeenCalledWith('pd-1');

    vi.clearAllMocks();
    updates.length = 0;
    providerMock.verifiesByDns = false;
    setRow({ status: 'pending', provider: 'static', providerDomainId: null, checkRequestedAt: NOW, lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('does not re-request verification for a check already served', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkRequestedAt: new Date(NOW.getTime() - 120_000), lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('emails and audits only on a CHANGE of status, so a re-run is idempotent', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1', verifiedAt: NOW });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'verified', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(statusMailMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('verified -> at_risk notifies once and keeps verified_at sticky', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1', verifiedAt: new Date(NOW.getTime() - 86_400_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'at_risk', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ status: 'at_risk', statusReason: 'dns_removed' });
    expect(updates.at(-1)!.verifiedAt).toBeUndefined();
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'at_risk' }));
  });

  it('writes last_send_error from the job payload — the send path never writes this table', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1' });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'verified', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW, lastSendError: '550 5.7.60 sender not allowed' });

    expect(updates[0]).toMatchObject({ lastSendError: '550 5.7.60 sender not allowed' });
    expect(updates[0]!.lastSendErrorAt).toBeInstanceOf(Date);
  });

  it('suspended makes no provider call at all', async () => {
    setRow({ status: 'suspended', providerDomainId: 'pd-1' });
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('suspended_noop');
    expect(providerMock.getDomain).not.toHaveBeenCalled();
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });

  // --- expiry and removal ----------------------------------------------------

  it('moves a failed row past the 72h window to removing/failed_expired', async () => {
    setRow({ status: 'failed', statusReason: 'dns_not_detected', providerDomainId: 'pd-1', statusChangedAt: new Date(NOW.getTime() - FAILED_RETRY_WINDOW_MS - 1000) });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('expired');

    expect(updates.at(-1)).toMatchObject({ status: 'removing', statusReason: 'failed_expired' });
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'auto_removed' }));
  });

  it('leaves a failed row inside the window alone so Retry keeps the same DNS records', async () => {
    setRow({ status: 'failed', providerDomainId: 'pd-1', statusChangedAt: new Date(NOW.getTime() - 1000) });
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');
    expect(lastStatus()).toBeUndefined();
  });

  it('removing a MANAGED domain deletes at the provider, nulls the handle, then drops the row — in that order', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: true, statusReason: 'user_removed' });
    const order: string[] = [];
    providerMock.deleteDomain.mockImplementation(async () => { order.push('provider-delete'); });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('deleted');

    expect(order).toEqual(['provider-delete']);
    const nulling = updates.findIndex((u) => u.providerDomainId === null);
    expect(nulling).toBeGreaterThan(-1);
    expect(deletes).toHaveLength(1);
    expect(releases).toHaveLength(0);
  });

  // --- NEVER DELETE WHAT WE DID NOT CREATE (spec §14) ------------------------

  it('removal of an UNMANAGED domain drops the local row only: no deleteDomain, no outbox row', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: false, statusReason: 'user_removed' });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('deleted');

    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
    expect(releases).toHaveLength(0);
    expect(deletes).toHaveLength(1);
  });

  it('failed-row EXPIRY of an UNMANAGED domain also never reaches the provider', async () => {
    setRow({ status: 'failed', providerDomainId: 'pd-1', providerManaged: false, statusChangedAt: new Date(NOW.getTime() - FAILED_RETRY_WINDOW_MS - 1000) });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: false, statusReason: 'failed_expired' });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
    expect(releases).toHaveLength(0);
  });

  it('a provider delete failure leaves the row in removing with the handle intact', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: true });
    providerMock.deleteDomain.mockRejectedValue(new Error('provider 503'));

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).rejects.toThrow('provider 503');

    expect(deletes).toHaveLength(0);
    expect(updates.some((u) => u.providerDomainId === null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainSync.test.ts`
Expected: the cadence block still passes (8); the new block fails to collect — `syncSendingDomain is not a function` / `FAILED_RETRY_WINDOW_MS` not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/services/emailDomains/domainSync.ts` (keeping `nextCheckDelayMs` above it), and add the imports at the top of the file:

```ts
import { eq, sql } from 'drizzle-orm';
import type { SendingDomainStatusReason } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains, partners } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { captureException } from '../sentry';
import { ProviderDomainConflictError, ProviderDomainRejectedError } from './provider';
import type { EmailDomainProvider, ProviderDomain, SendingDomainStatus } from './provider';
import { getEmailDomainProvider } from './providerRegistry';
import { sendSendingDomainStatusEmail, type SendingDomainStatusEvent } from './statusMail';
```

```ts
/**
 * How long a `failed` row is kept so "Retry" reuses the SAME DNS records
 * (spec §4.3, §6.1). Past it the worker moves the row to `removing` with
 * `failed_expired`, which is also the bound on how long a squatter can hold a
 * name.
 */
export const FAILED_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export type SyncOutcome =
  | 'no_provider' | 'not_found' | 'provisioned' | 'provision_failed'
  | 'polled' | 'expired' | 'released' | 'deleted' | 'suspended_noop';

export interface SyncOptions {
  /** The refusal text from a partner-lane send (spec §8.4). Written HERE, never by the send path. */
  lastSendError?: string;
  now?: Date;
  rng?: () => number;
}

type DomainRow = typeof partnerSendingDomains.$inferSelect;
type DomainPatch = Partial<typeof partnerSendingDomains.$inferInsert>;

/** Status changes that earn a notice + an audit row (spec §6.3). */
const MAIL_EVENT: Partial<Record<SendingDomainStatus, SendingDomainStatusEvent>> = {
  verified: 'verified',
  at_risk: 'at_risk',
  failed: 'failed',
  suspended: 'suspended',
};

/**
 * Map a provisioning failure onto a `status_reason` from
 * SENDING_DOMAIN_STATUS_REASONS. W02's adapters throw the two typed classes;
 * anything else is an unclassified provider refusal.
 */
function statusReasonOf(err: unknown): SendingDomainStatusReason {
  if (err instanceof ProviderDomainConflictError) return 'provider_conflict';
  if (err instanceof ProviderDomainRejectedError) return 'provider_rejected';
  // The classes may not survive a structured-clone round trip through BullMQ,
  // so match by name too — the same defence classifyM365SyncFailure uses.
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'ProviderDomainConflictError') return 'provider_conflict';
  if (name === 'ProviderDomainRejectedError') return 'provider_rejected';
  return 'provider_rejected';
}

/** Spec §5.2, keyed on whether SENDING is usable. An unknown state can never send. */
function mapProviderState(state: ProviderDomain['state']): SendingDomainStatus {
  switch (state) {
    case 'verified': return 'verified';
    case 'at_risk': return 'at_risk';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    default:
      console.warn(`[SendingDomains] unknown provider state ${String(state)} — treating as pending`);
      return 'pending';
  }
}

async function loadRow(domainId: string): Promise<DomainRow | undefined> {
  const found = await db
    .select()
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.id, domainId))
    .limit(1);
  return found[0];
}

async function patchRow(domainId: string, patch: DomainPatch): Promise<void> {
  await db
    .update(partnerSendingDomains)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(partnerSendingDomains.id, domainId));
}

/**
 * Commit the status change, its audit row and (after the transaction) its
 * notice. Called only when `next` actually differs from the row's current
 * status — a re-run of the same job must be silent, or a hourly `at_risk` poll
 * would mail the partner every hour.
 */
async function commitTransition(
  row: DomainRow,
  next: SendingDomainStatus,
  reason: string | null,
  extra: DomainPatch,
  now: Date,
  rng?: () => number,
): Promise<void> {
  const changed = row.status !== next;
  const patch: DomainPatch = {
    ...extra,
    status: next,
    statusReason: reason,
    lastCheckedAt: now,
    nextCheckAt: new Date(now.getTime() + nextCheckDelayMs(next, (row.checkAttempts ?? 0) + 1, rng)),
  };
  if (changed) patch.statusChangedAt = now;
  if (next === 'verified' && !row.verifiedAt) patch.verifiedAt = now;

  await withSystemDbAccessContext(async () => {
    await patchRow(row.id, patch);
    if (changed) {
      await createAuditLogAsync({
        orgId: null,
        actorType: 'system',
        actorId: ANONYMOUS_ACTOR_ID,
        action: 'partner_sending_domain.status_changed',
        resourceType: 'partner_sending_domain',
        resourceId: row.id,
        resourceName: row.domain,
        details: { partnerId: row.partnerId, from: row.status, to: next, reason },
        result: 'success',
      });
    }
  }, 'sendingDomainTransition');

  // OUTSIDE the transaction: the notice makes a transport round trip and must
  // never hold a pooled connection (#1105). It also never throws.
  const event = changed ? MAIL_EVENT[next] : undefined;
  if (event) {
    await sendSendingDomainStatusEmail({
      partnerId: row.partnerId,
      domain: row.domain,
      event,
      statusReason: reason,
      createdBy: row.createdBy,
    });
  }
}

/**
 * Provisioning, spec §5.1. The `provision_attempted_at` stamp is committed in
 * its own transaction BEFORE any provider call, and only when it is still null:
 *
 *   - null on entry  -> first attempt; stamp = now
 *   - already set    -> a previous attempt crashed somewhere after the stamp
 *
 * That is the ONLY thing that distinguishes "a domain object we created and
 * then lost" from "a domain object that pre-existed in the account". Re-stamping
 * on every retry would make our own object look older than the attempt and
 * adopt it as `provider_managed = false`, which is the one classification the
 * whole feature must not get wrong: an unmanaged row is never deleted at the
 * provider, so we would leak a domain object forever.
 */
async function provision(
  row: DomainRow,
  provider: EmailDomainProvider,
  now: Date,
  rng?: () => number,
): Promise<SyncOutcome> {
  let attemptedAt = row.provisionAttemptedAt;
  if (!attemptedAt) {
    attemptedAt = now;
    await withSystemDbAccessContext(
      () => patchRow(row.id, { provisionAttemptedAt: attemptedAt! }),
      'sendingDomainProvisionStamp',
    );
  }

  // The `static` allow-list binds entries by SLUG (`domain:partner-slug`,
  // spec §2.1), and W02's `createDomain` takes `partnerSlug` for exactly that
  // (its amendment 4). Read in the same short transaction as the stamp, so the
  // provider call below still holds no connection.
  const partnerSlug = await withSystemDbAccessContext(async () => {
    const [p] = await db
      .select({ slug: partners.slug })
      .from(partners)
      .where(eq(partners.id, row.partnerId))
      .limit(1);
    return p?.slug ?? null;
  }, 'sendingDomainProvisionSlug');

  let found: ProviderDomain | null;
  let managed: boolean;
  try {
    // NO DB context held across these calls.
    found = await provider.findDomainByName(row.domain);
    if (!found) {
      found = await provider.createDomain({
        domain: row.domain,
        region: row.providerRegion ?? undefined,
        partnerRef: row.partnerId,
        partnerSlug,
      });
      managed = true;
    } else {
      // Ambiguity resolves to NOT managed: leaking one provider domain is
      // recoverable, deleting an operator's primary sending domain is not
      // (spec §5.1).
      managed = found.createdAt instanceof Date && found.createdAt.getTime() > attemptedAt.getTime();
    }
  } catch (err) {
    const reason = statusReasonOf(err);
    console.error(`[SendingDomains] provisioning ${row.domain} failed: ${reason}`);
    captureException(err instanceof Error ? err : new Error(String(err)));
    await commitTransition(row, 'failed', reason, {}, now, rng);
    return 'provision_failed';
  }

  const next = mapProviderState(found.state);
  await commitTransition(row, next, null, {
    providerDomainId: found.providerDomainId,
    providerRegion: found.region ?? row.providerRegion,
    providerManaged: managed,
    dnsRecords: found.records,
  }, now, rng);

  // A `static` adapter has verifiesByDns = false and verifies through an
  // accepted test send instead (spec §5.1); asking it to verify is meaningless.
  if (next === 'pending' && provider.verifiesByDns && found.providerDomainId) {
    await provider.requestVerification(found.providerDomainId);
  }
  return 'provisioned';
}

/**
 * Poll one live row. `check_requested_at` newer than `last_checked_at` is the
 * "Check now" signal and asks the provider to re-verify first.
 */
async function poll(
  row: DomainRow,
  provider: EmailDomainProvider,
  now: Date,
  rng?: () => number,
): Promise<SyncOutcome> {
  if (!row.providerDomainId && provider.verifiesByDns) {
    // A DNS-verifying row with no provider object never got provisioned —
    // send it back round rather than calling getDomain(null).
    await commitTransition(row, 'provisioning', row.statusReason, {}, now, rng);
    return 'polled';
  }

  const requested = row.checkRequestedAt?.getTime() ?? 0;
  const checked = row.lastCheckedAt?.getTime() ?? 0;
  if (requested > checked && provider.verifiesByDns && row.providerDomainId) {
    await provider.requestVerification(row.providerDomainId);
  }

  // `static` has no provider object, so its key is the DOMAIN NAME
  // (W02 amendment 5); every other adapter takes its provider domain id.
  const observed = await provider.getDomain(row.providerDomainId ?? row.domain);

  let next = mapProviderState(observed.state);
  if (!provider.verifiesByDns && next === 'pending') {
    // W02 amendment 5, and it is load-bearing: a `static` adapter reports
    // `pending` for "still listed in EMAIL_DOMAINS_STATIC_ALLOWED" and NEVER
    // `verified` — only an accepted test send moves a static row to verified
    // (spec §5.1). Taking `pending` at face value would demote every verified
    // static domain on the daily re-check and silently stop the operator's mail.
    // `failed` (the operator delisted it) is the only state that acts here.
    next = row.status as SendingDomainStatus;
  }
  const reason = next === 'at_risk' ? 'dns_removed'
    : next === 'failed' ? (provider.verifiesByDns
        ? (row.status === 'pending' ? 'dns_not_detected' : 'provider_rejected')
        : 'provider_rejected')
    : row.status === next ? row.statusReason
    : null;

  await commitTransition(row, next, reason, {
    checkAttempts: (row.checkAttempts ?? 0) + 1,
    dnsRecords: observed.records.length > 0 ? observed.records : row.dnsRecords,
    providerRegion: observed.region ?? row.providerRegion,
  }, now, rng);
  return 'polled';
}

/**
 * `removing`, spec §6.1 + §3.5. The order is load-bearing and W02's
 * `BEFORE DELETE` trigger enforces it: the row cannot be deleted while
 * `provider_domain_id IS NOT NULL`, so a path that forgot to release the
 * provider handle fails loudly instead of leaking it.
 *
 * `provider_managed = false` short-circuits every provider interaction — no
 * `deleteDomain`, and no outbox row either. The provider object pre-existed
 * Breeze (it is typically the operator's primary `EMAIL_FROM` domain) and
 * removing our local row must not touch it (spec §5.1, §13, §14).
 */
async function release(row: DomainRow, provider: EmailDomainProvider): Promise<SyncOutcome> {
  if (row.providerManaged && row.providerDomainId) {
    // 404 is success in the adapter contract; anything else throws and the job
    // retries with the row still in `removing` and its handle intact.
    await provider.deleteDomain(row.providerDomainId);
  }
  await withSystemDbAccessContext(async () => {
    await patchRow(row.id, { providerDomainId: null });
    await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row.id));
  }, 'sendingDomainRelease');
  return 'deleted';
}

/**
 * Advance ONE row ONE step, idempotently. Every provider call sits between two
 * short system-scoped transactions, never inside one (#1105) — the
 * `jobs/ticketOutboxPublisher.ts` phase shape.
 */
export async function syncSendingDomain(domainId: string, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const provider = getEmailDomainProvider();
  if (!provider) return 'no_provider';
  const now = opts.now ?? new Date();

  const row = await withSystemDbAccessContext(async () => {
    const found = await loadRow(domainId);
    if (found && opts.lastSendError) {
      // Recorded here because the send path may be running in a context that
      // cannot write this partner-axis table at all (spec §3.1).
      await patchRow(domainId, { lastSendError: opts.lastSendError.slice(0, 2000), lastSendErrorAt: now });
    }
    return found;
  }, 'sendingDomainLoad');

  if (!row) return 'not_found';

  switch (row.status as SendingDomainStatus) {
    case 'suspended':
      // The kill switch. No provider call of any kind (spec §6.1).
      await withSystemDbAccessContext(
        () => patchRow(row.id, { nextCheckAt: new Date(now.getTime() + nextCheckDelayMs('suspended', 0, opts.rng)) }),
        'sendingDomainSuspendedTouch',
      );
      return 'suspended_noop';

    case 'provisioning':
      return provision(row, provider, now, opts.rng);

    case 'removing':
      return release(row, provider);

    case 'failed': {
      const age = now.getTime() - (row.statusChangedAt?.getTime() ?? now.getTime());
      if (age > FAILED_RETRY_WINDOW_MS) {
        await commitTransition(row, 'removing', 'failed_expired', {}, now, opts.rng);
        await sendSendingDomainStatusEmail({
          partnerId: row.partnerId, domain: row.domain, event: 'auto_removed',
          statusReason: 'failed_expired', createdBy: row.createdBy,
        });
        return 'expired';
      }
      // Inside the window: leave the row (and its DNS records) exactly as they
      // are so "Retry" does not hand the partner a second set of records.
      await withSystemDbAccessContext(
        () => patchRow(row.id, { nextCheckAt: new Date(now.getTime() + nextCheckDelayMs('failed', 0, opts.rng)) }),
        'sendingDomainFailedTouch',
      );
      return 'polled';
    }

    case 'pending':
    case 'verified':
    case 'at_risk':
      return poll(row, provider, now, opts.rng);
  }
}

/**
 * The ONE way a `static` row reaches `verified` (spec §5.1, §6.1).
 *
 * It cannot happen in `poll`: a `static` adapter reports `pending` for "still
 * listed" and never `verified`, and `poll` treats that as no change precisely so
 * a daily re-check cannot demote a working domain. So the worker's `test-send`
 * job calls this after the relay has ACCEPTED a message from the domain, which
 * is the only evidence Breeze can obtain that it may send as it.
 *
 * Returns false — not an error — when it does not apply, so the caller can
 * invoke it unconditionally after a successful test send.
 */
export async function markStaticDomainVerified(domainId: string, now: Date = new Date()): Promise<boolean> {
  const provider = getEmailDomainProvider();
  if (!provider || provider.verifiesByDns) return false;

  const row = await withSystemDbAccessContext(() => loadRow(domainId), 'sendingDomainStaticVerifyLoad');
  if (!row || row.status !== 'pending') return false;

  await commitTransition(row, 'verified', null, {}, now);
  return true;
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainSync.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: 8 + 27 in `domainSync.test.ts`, 0 failed; and `partner-wide-write-coverage.test.ts` now green — the Step 0 entry has stopped being stale because the file mutates `partnerSendingDomains`, and the sweep does not flag it because it is allowlisted.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/emailDomains/domainSync.ts apps/api/src/services/emailDomains/domainSync.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(email-domains): syncSendingDomain state machine (spec 6.1)

provision_attempted_at commits before the provider create so a crashed attempt
is re-adopted as ours; provider_managed=false is never deleted at the provider
on any of the three removal paths.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The `sending-domains` worker

**Files:**
- Create: `apps/api/src/services/emailDomains/keyProbe.ts`
- Create: `apps/api/src/jobs/sendingDomainsWorker.ts`
- Create: `apps/api/src/jobs/sendingDomainsWorker.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts:156` — add one key after `'monitor-episode-retention': '3 20 * * *',`

**Interfaces:**
- Consumes: `syncSendingDomain` / `FAILED_RETRY_WINDOW_MS` (`../services/emailDomains/domainSync`), `getEmailDomainProvider` (`../services/emailDomains/providerRegistry`), `isPartnerLaneConfigured` (`../services/emailDomains/config`), `getBullMQConnection` (`../services/redis`), `attachWorkerObservability` (`./workerObservability`), `jobSchedule` (`./scheduleRegistry`), `sendOpsAlert` (`../services/opsAlerts`), `isHosted` (`../config/env`), `db` / `withSystemDbAccessContext` (`../db`).
- Produces:
  ```ts
  export const SENDING_DOMAINS_QUEUE = 'sending-domains';
  export async function enqueueSyncDomain(domainId: string, opts?: { lastSendError?: string }): Promise<void>;
  export async function enqueueTestSend(domainId: string, userId: string): Promise<void>;
  export async function initializeSendingDomainsWorker(): Promise<void>;
  export async function shutdownSendingDomainsWorker(): Promise<void>;
  export async function runSendingDomainsSweep(now?: Date): Promise<{ enqueued: number; released: number; stuck: number }>;
  export async function runDailyMaintenance(now?: Date): Promise<{ drift: number; rechecked: number }>;
  export async function runTestSend(domainId: string, userId: string): Promise<'sent' | 'refused' | 'skipped'>;
  ```
  And in `keyProbe.ts`:
  ```ts
  export type ProviderKeyProbe = 'ok' | 'send_only';
  export async function recordProviderKeyProbe(verdict: ProviderKeyProbe): Promise<void>;
  export async function readProviderKeyProbe(): Promise<ProviderKeyProbe | null>;
  ```

- [ ] **Step 1: Allocate the cron slot**

In `apps/api/src/jobs/scheduleRegistry.ts`, immediately after line 156 (`'monitor-episode-retention': '3 20 * * *',`), add:

```ts
  // Partner sending domains W03 (spec §6.4). ONE daily job doing two things:
  // the hosted drift report (listDomains vs local rows + outbox) and, on a
  // `static` instance, the re-check that a domain the operator removed from
  // EMAIL_DOMAINS_STATIC_ALLOWED stops being used. A slot rather than
  // `repeat: { every: 24h }` — BullMQ anchors `every` to the epoch, so a 24 h
  // repeatable fires at exactly 00:00:00.000 UTC alongside every other one (see
  // this file's header). Hour 21 was entirely free; :03 keeps the daily = 3
  // (mod 5) lane.
  'sending-domains-daily': '3 21 * * *',
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/jobs/sendingDomainsWorker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueAdd, getRepeatableJobs, removeRepeatableByKey, queueClose, workerCtor, workerClose } = vi.hoisted(() => ({
  queueAdd: vi.fn(async () => ({ id: 'j1' })),
  getRepeatableJobs: vi.fn(async () => [] as Array<{ name: string; key: string }>),
  removeRepeatableByKey: vi.fn(async () => undefined),
  queueClose: vi.fn(async () => undefined),
  workerCtor: vi.fn(),
  workerClose: vi.fn(async () => undefined),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    getRepeatableJobs = getRepeatableJobs;
    removeRepeatableByKey = removeRepeatableByKey;
    close = queueClose;
  },
  Worker: class {
    constructor(name: string, processor: unknown, opts: unknown) { workerCtor(name, processor, opts); }
    on = vi.fn();
    close = workerClose;
  },
}));

const { execRows, updates, deletes } = vi.hoisted(() => ({
  execRows: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  deletes: [] as unknown[],
}));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async () => ({ rows: execRows.shift() ?? [] })),
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
      (chain as { then: unknown }).then = (r: (v: unknown) => unknown) =>
        Promise.resolve(execRows.shift() ?? []).then(r);
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn((v: Record<string, unknown>) => { updates.push(v); return { where: vi.fn(async () => undefined) }; }) })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { deletes.push(w); }) })),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

const { syncMock, markStaticVerifiedMock } = vi.hoisted(() => ({
  syncMock: vi.fn(async () => 'polled'),
  markStaticVerifiedMock: vi.fn(async () => true),
}));
vi.mock('../services/emailDomains/domainSync', () => ({
  syncSendingDomain: syncMock,
  markStaticDomainVerified: markStaticVerifiedMock,
  FAILED_RETRY_WINDOW_MS: 72 * 60 * 60 * 1000,
}));

const { providerMock, getProviderMock } = vi.hoisted(() => {
  const providerMock = {
    id: 'fake' as const, verifiesByDns: true,
    createDomain: vi.fn(), findDomainByName: vi.fn(), getDomain: vi.fn(),
    requestVerification: vi.fn(), deleteDomain: vi.fn(),
    listDomains: vi.fn(async () => []), send: vi.fn(async () => ({ providerMessageId: 'm1' })),
  };
  return { providerMock, getProviderMock: vi.fn(() => providerMock as unknown) };
});
vi.mock('../services/emailDomains/providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));

const { laneConfigured } = vi.hoisted(() => ({ laneConfigured: { value: true } }));
vi.mock('../services/emailDomains/config', () => ({
  isPartnerLaneConfigured: () => laneConfigured.value,
  getEmailDomainsConfig: () => ({
    provider: laneConfigured.value ? 'fake' : null,
    resendApiKey: null, resendSendingKey: null,
    region: 'us-east-1', maxPerPartner: 3, dailySendCap: 0,
    partnerAllowlist: [], denylist: [], staticAllowed: [], webhookSecret: null,
  }),
  findStaticAllowedEntry: () => null,
}));

const { opsAlertMock } = vi.hoisted(() => ({ opsAlertMock: vi.fn(async () => true) }));
vi.mock('../services/opsAlerts', () => ({ sendOpsAlert: opsAlertMock, isOpsAlertingConfigured: () => true }));

const { hostedFlag } = vi.hoisted(() => ({ hostedFlag: { value: false } }));
vi.mock('../config/env', () => ({ isHosted: () => hostedFlag.value }));

const { probeRecord, probeRead } = vi.hoisted(() => ({
  probeRecord: vi.fn(async () => undefined),
  probeRead: vi.fn(async () => null),
}));
vi.mock('../services/emailDomains/keyProbe', () => ({
  recordProviderKeyProbe: probeRecord, readProviderKeyProbe: probeRead,
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  SENDING_DOMAINS_QUEUE, enqueueSyncDomain, enqueueTestSend,
  initializeSendingDomainsWorker, runDailyMaintenance, runSendingDomainsSweep, runTestSend,
  shutdownSendingDomainsWorker,
} from './sendingDomainsWorker';

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(async () => {
  await shutdownSendingDomainsWorker();
  vi.clearAllMocks();
  execRows.length = 0; updates.length = 0; deletes.length = 0;
  laneConfigured.value = true;
  hostedFlag.value = false;
  getProviderMock.mockReturnValue(providerMock as unknown);
  getRepeatableJobs.mockResolvedValue([]);
  providerMock.listDomains.mockResolvedValue([]);
});

describe('worker registration', () => {
  it('does not construct a Worker when no provider is configured (the dark default)', async () => {
    laneConfigured.value = false;
    await initializeSendingDomainsWorker();
    expect(workerCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('constructs one Worker on the sending-domains queue, limited to 5 provider calls a second', async () => {
    await initializeSendingDomainsWorker();
    expect(workerCtor).toHaveBeenCalledTimes(1);
    const [name, , opts] = workerCtor.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe(SENDING_DOMAINS_QUEUE);
    expect(opts.limiter).toEqual({ max: 5, duration: 1000 });
    expect(opts.concurrency).toBe(1);
  });

  it('schedules the 60s sweep and the daily job by CRON, never a coarse `every`', async () => {
    await initializeSendingDomainsWorker();
    const sweep = queueAdd.mock.calls.find(([n]) => n === 'sweep')![2] as Record<string, any>;
    expect(sweep.repeat).toEqual({ every: 60_000 });
    const dailyOpts = queueAdd.mock.calls
      .filter(([n]) => n === 'daily-maintenance')
      .map((c) => c[2] as Record<string, any>);
    expect(dailyOpts.length).toBeGreaterThan(0);
    // A cron pattern, and NEVER a coarse `every` — scheduleRegistry.contract.test.ts
    // fails the build for one, and an epoch-anchored 24h repeat stampedes at 00:00 UTC.
    expect(dailyOpts.some((o) => typeof o.repeat?.pattern === 'string')).toBe(true);
    expect(dailyOpts.every((o) => o.repeat?.every === undefined)).toBe(true);
  });

  it('also enqueues one un-repeated daily-maintenance at boot so a static delist is caught on start', async () => {
    await initializeSendingDomainsWorker();
    const oneShots = queueAdd.mock.calls.filter(([n, , o]) => n === 'daily-maintenance' && (o as any).repeat === undefined);
    expect(oneShots).toHaveLength(1);
  });

  it('probes the management key exactly once on start and records send_only on a permission error', async () => {
    providerMock.listDomains.mockRejectedValue(Object.assign(new Error('restricted'), { statusCode: 401 }));
    await initializeSendingDomainsWorker();
    expect(providerMock.listDomains).toHaveBeenCalledTimes(1);
    expect(probeRecord).toHaveBeenCalledWith('send_only');
  });

  it('records ok when the key can list domains', async () => {
    await initializeSendingDomainsWorker();
    expect(probeRecord).toHaveBeenCalledWith('ok');
  });
});

describe('enqueue helpers', () => {
  it('collapses duplicate sync jobs by using the domain id as the jobId', async () => {
    await enqueueSyncDomain(DOMAIN_ID);
    const [name, data, opts] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(name).toBe('sync-domain');
    expect(data).toEqual({ domainId: DOMAIN_ID });
    expect(opts.jobId).toBe(DOMAIN_ID);
  });

  it('carries the send refusal through so the worker, not the send path, writes last_send_error', async () => {
    await enqueueSyncDomain(DOMAIN_ID, { lastSendError: '550 sender not allowed' });
    const [, data] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(data).toEqual({ domainId: DOMAIN_ID, lastSendError: '550 sender not allowed' });
  });

  it('enqueues a test send addressed to the requesting user', async () => {
    await enqueueTestSend(DOMAIN_ID, USER_ID);
    const [name, data] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(name).toBe('test-send');
    expect(data).toEqual({ domainId: DOMAIN_ID, userId: USER_ID });
  });

  it('is inert when the lane is unconfigured, so a stale route can never queue work', async () => {
    laneConfigured.value = false;
    await enqueueSyncDomain(DOMAIN_ID);
    await enqueueTestSend(DOMAIN_ID, USER_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  it('claims at most 25 due rows with FOR UPDATE SKIP LOCKED and enqueues one job each', async () => {
    execRows.push([{ id: 'd1' }, { id: 'd2' }]);   // due rows
    execRows.push([]);                             // outbox rows
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.enqueued).toBe(2);
    const { db } = await import('../db');
    const sqlText = JSON.stringify((db.execute as any).mock.calls[0][0]);
    expect(sqlText).toContain('for update skip locked');
    expect(sqlText).toContain('25');
  });

  it('drains a due outbox row by deleting the provider domain, then the row', async () => {
    execRows.push([]);                                                        // no due domains
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 0 }]);
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(providerMock.deleteDomain).toHaveBeenCalledWith('pd-1');
    expect(result.released).toBe(1);
    expect(deletes).toHaveLength(1);
  });

  it('backs an outbox row off instead of deleting it when the provider refuses', async () => {
    execRows.push([]);
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 2 }]);
    providerMock.deleteDomain.mockRejectedValue(new Error('provider 503'));
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.released).toBe(0);
    expect(deletes).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ attempts: 3 });
    expect(updates.at(-1)!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('raises an ops alert for an outbox row stuck past ten attempts and stops retrying it', async () => {
    execRows.push([]);
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 10 }]);
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.stuck).toBe(1);
    expect(opsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('release') }));
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });
});

describe('test send (spec §6.1)', () => {
  it('sends from the support identity local part, to the requesting user, tagged as a test', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');

    expect(providerMock.send).toHaveBeenCalledWith(expect.objectContaining({
      from: 'help@mail.acme.test',
      to: 'tech@acme.test',
      tags: expect.objectContaining({ purpose: 'sending_domain.test', domain_id: DOMAIN_ID }),
    }));
    expect(updates.at(-1)).toMatchObject({ lastTestStatus: 'sent' });
  });

  it('falls back to a `test` local part when no support identity exists', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([]);
    await runTestSend(DOMAIN_ID, USER_ID);
    expect(providerMock.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'test@mail.acme.test' }));
  });

  it('records the refusal verbatim and does not verify anything', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([]);
    providerMock.send.mockRejectedValue(new Error('550 5.7.60 sender not allowed'));

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');

    expect(updates.at(-1)).toMatchObject({ lastTestStatus: 'failed', lastTestError: '550 5.7.60 sender not allowed' });
    expect(markStaticVerifiedMock).not.toHaveBeenCalled();
  });

  it('skips a domain that is not sendable, and a static PENDING one is sendable', async () => {
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      vi.clearAllMocks();
      execRows.length = 0;
      execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status }]);
      execRows.push([{ email: 'tech@acme.test' }]);
      execRows.push([]);
      await expect(runTestSend(DOMAIN_ID, USER_ID), status).resolves.toBe('skipped');
      expect(providerMock.send, status).not.toHaveBeenCalled();
    }

    vi.clearAllMocks();
    providerMock.verifiesByDns = false;   // static
    execRows.length = 0;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([]);
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');
  });

  it('an accepted static test send verifies the row THERE, not through a sync job', async () => {
    providerMock.verifiesByDns = false;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([]);

    await runTestSend(DOMAIN_ID, USER_ID);

    // A sync would read `pending` from the static adapter and treat it as no
    // change (W02 amendment 5), leaving the row pending forever.
    expect(markStaticVerifiedMock).toHaveBeenCalledWith(DOMAIN_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('never sends for a user who is not in the domain\'s partner', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([]);   // the users lookup is scoped to the domain's partner
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('skipped');
    expect(providerMock.send).not.toHaveBeenCalled();
  });
});

describe('daily maintenance', () => {
  it('runs the drift report on HOSTED only', async () => {
    hostedFlag.value = false;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-x', domain: 'ghost.test' }]);
    execRows.push([]);
    await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(providerMock.listDomains).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('alerts on a provider domain older than 24h that no local row or outbox row explains — and deletes nothing', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([
      { providerDomainId: 'pd-known', domain: 'known.test' },
      { providerDomainId: 'pd-ghost', domain: 'ghost.test' },
    ]);
    execRows.push([{ provider_domain_id: 'pd-known' }]);  // local rows + outbox, one query
    // listDomains carries no createdAt (W02 pins the interface), so the age
    // comes from a second lookup — made only for the unaccounted-for domain.
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-ghost', state: 'verified', records: [], createdAt: new Date('2026-09-10T00:00:00Z'),
    });

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(providerMock.findDomainByName).toHaveBeenCalledTimes(1);
    expect(providerMock.findDomainByName).toHaveBeenCalledWith('ghost.test');
    expect(result.drift).toBe(1);
    expect(opsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('ghost.test') }));
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });

  it('does not flag a provider domain created in the last 24h — it may be mid-provision', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-fresh', domain: 'fresh.test' }]);
    execRows.push([]);
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-fresh', state: 'pending', records: [], createdAt: new Date('2026-09-17T11:00:00Z'),
    });

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(result.drift).toBe(0);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('flags a candidate whose creation time cannot be read, rather than suppressing it', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-opaque', domain: 'opaque.test' }]);
    execRows.push([]);
    providerMock.findDomainByName.mockRejectedValue(new Error('provider 500'));

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(result.drift).toBe(1);
    expect(opsAlertMock).toHaveBeenCalled();
  });

  it('re-checks every live static row so a delisted domain stops being used', async () => {
    providerMock.verifiesByDns = false;
    execRows.push([{ id: 'd1' }, { id: 'd2' }]);
    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(result.rechecked).toBe(2);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/sendingDomainsWorker.test.ts`
Expected: collection fails — `Failed to resolve import "./sendingDomainsWorker"`.

- [ ] **Step 4: Implement the key probe**

Create `apps/api/src/services/emailDomains/keyProbe.ts`:

```ts
import { getRedis } from '../redis';

export type ProviderKeyProbe = 'ok' | 'send_only';

/**
 * The verdict of the worker's one-shot `listDomains()` probe (spec §5.1).
 *
 * It lives in Redis rather than a module variable because the probe runs in the
 * WORKER process (`BREEZE_ROLE=worker`) while the capability that reports it is
 * rendered by a route in the API process — a module flag would always read
 * "not probed" there. Redis is the only state both processes already share.
 *
 * 25 h TTL: the daily maintenance job re-writes it, so an expired key means
 * "the worker has not run for a day", which is honestly reported as "unknown"
 * rather than as a permission problem.
 */
const KEY = 'emaildomains:key-probe:v1';
const TTL_SECONDS = 25 * 60 * 60;

export async function recordProviderKeyProbe(verdict: ProviderKeyProbe): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(KEY, verdict, 'EX', TTL_SECONDS);
  } catch (err) {
    console.warn('[SendingDomains] could not record the provider key probe:', err instanceof Error ? err.message : err);
  }
}

/** `null` = never probed / Redis unavailable. Callers must treat that as "unknown", never as a denial. */
export async function readProviderKeyProbe(): Promise<ProviderKeyProbe | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(KEY);
    return value === 'ok' || value === 'send_only' ? value : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Implement the worker**

Create `apps/api/src/jobs/sendingDomainsWorker.ts`:

```ts
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isHosted } from '../config/env';
import { db, withSystemDbAccessContext } from '../db';
import { emailProviderDomainReleases, partnerSenderIdentities, partnerSendingDomains, users } from '../db/schema';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from '../services/emailDomains/config';
import { markStaticDomainVerified, syncSendingDomain } from '../services/emailDomains/domainSync';
import { recordProviderKeyProbe } from '../services/emailDomains/keyProbe';
import { getEmailDomainProvider } from '../services/emailDomains/providerRegistry';
import { sendOpsAlert } from '../services/opsAlerts';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

/**
 * The ONE place that talks to the email-domain provider (spec §2). Request
 * handlers only write intent rows and enqueue here, so provider outages, the
 * account's 10 req/s ceiling and retry/backoff are handled once, and no route
 * ever needs SELF_MANAGED_DB_CONTEXT_ROUTES.
 *
 * Registration is conditional: with EMAIL_DOMAINS_PROVIDER unset (the default,
 * and the state hosted ships in until W05) nothing is constructed and nothing
 * is scheduled — the same enable-check shape as initializeAbuseSignalsWorker
 * (jobs/abuseSignalsSweep.ts:149). The readiness manifest carries a matching
 * 'sending_domains_configured' rule so an unconfigured box is not pinned
 * not-ready waiting for a consumer that will never attach.
 */
export const SENDING_DOMAINS_QUEUE = 'sending-domains';

const SWEEP_JOB = 'sweep';
const SYNC_JOB = 'sync-domain';
const TEST_SEND_JOB = 'test-send';
const DAILY_JOB = 'daily-maintenance';
const SWEEP_REPEAT_ID = 'sending-domains-sweep-repeat';
const DAILY_REPEAT_ID = 'sending-domains-daily-repeat';

// Declared in THIS file on purpose: scheduleRegistry.contract.test.ts resolves
// `repeat: { every }` operands only through same-file const declarations, and an
// imported constant reads as UNRESOLVED and fails the suite.
const SWEEP_INTERVAL_MS = 60_000;
const DAILY_CRON = jobSchedule('sending-domains-daily');

/** Rows claimed per sweep. Deliberately small: each one becomes a provider call. */
const SWEEP_BATCH = 25;
/** Outbox rows past this many attempts are alerted and left alone (spec §3.3). */
const MAX_RELEASE_ATTEMPTS = 10;
/** A provider domain younger than this is not drift — it may be mid-provision (spec §6.4). */
const DRIFT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

type SendingDomainsJobData =
  | { domainId: string; lastSendError?: string }
  | { domainId: string; userId: string }
  | Record<string, never>;

let queue: Queue<SendingDomainsJobData> | null = null;
let worker: Worker<SendingDomainsJobData> | null = null;

function getQueue(): Queue<SendingDomainsJobData> {
  if (!queue) {
    queue = new Queue<SendingDomainsJobData>(SENDING_DOMAINS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------------------------
// Producers. Callable from a route; both no-op when the lane is unconfigured so
// a route that somehow reached them on a dark instance cannot queue orphan work.
// ---------------------------------------------------------------------------

/**
 * `jobId = domainId` so a burst of route calls and sweep claims for the same
 * row collapses into one in-flight job rather than N concurrent provider calls
 * against the same domain.
 */
export async function enqueueSyncDomain(domainId: string, opts: { lastSendError?: string } = {}): Promise<void> {
  if (!isPartnerLaneConfigured()) return;
  await getQueue().add(
    SYNC_JOB,
    opts.lastSendError ? { domainId, lastSendError: opts.lastSendError } : { domainId },
    { jobId: domainId, attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
  );
}

export async function enqueueTestSend(domainId: string, userId: string): Promise<void> {
  if (!isPartnerLaneConfigured()) return;
  await getQueue().add(
    TEST_SEND_JOB,
    { domainId, userId },
    { attempts: 2, backoff: { type: 'fixed', delay: 15_000 }, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * One sweep pass, in the three-phase shape of jobs/ticketOutboxPublisher.ts:
 * claim inside a short system transaction, then do the Redis/provider work with
 * NO context held, then write back in a second short transaction.
 */
export async function runSendingDomainsSweep(now: Date = new Date()): Promise<{ enqueued: number; released: number; stuck: number }> {
  const provider = getEmailDomainProvider();
  if (!provider) return { enqueued: 0, released: 0, stuck: 0 };

  // Phase 1: claim due rows. FOR UPDATE SKIP LOCKED so two replicas sweeping the
  // same second take disjoint sets instead of duplicating every provider call.
  const due = await withSystemDbAccessContext(async () => {
    const result = await db.execute<{ id: string }>(sql`
      select id
      from ${partnerSendingDomains}
      where ${partnerSendingDomains.nextCheckAt} <= ${now.toISOString()}::timestamptz
        and ${partnerSendingDomains.status} <> 'suspended'
      order by ${partnerSendingDomains.nextCheckAt} asc
      limit ${SWEEP_BATCH}
      for update skip locked
    `);
    return extractRows<{ id: string }>(result);
  }, 'sendingDomainsSweepClaim');

  // Phase 2: Redis only, outside any DB context.
  let enqueued = 0;
  for (const row of due) {
    try {
      await enqueueSyncDomain(row.id);
      enqueued += 1;
    } catch (err) {
      console.error(`[SendingDomains] enqueue failed for ${row.id}:`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const { released, stuck } = await drainReleaseOutbox(provider, now);
  return { enqueued, released, stuck };
}

/**
 * Drain `email_provider_domain_releases` (spec §3.3). These rows exist because
 * `cascadeDeletePartner` erases every table with a `partner_id` column: the
 * outbox has none, so it survives the partner and still knows which provider
 * object to release. Rows are only ever written for `provider_managed` domains,
 * so anything in here is by construction ours to delete.
 */
async function drainReleaseOutbox(
  provider: NonNullable<ReturnType<typeof getEmailDomainProvider>>,
  now: Date,
): Promise<{ released: number; stuck: number }> {
  const rows = await withSystemDbAccessContext(async () => {
    const result = await db.execute<{ id: string; provider: string; provider_domain_id: string; attempts: number }>(sql`
      select id, provider, provider_domain_id, attempts
      from ${emailProviderDomainReleases}
      -- next_attempt_at is NOT NULL DEFAULT now() in W02's schema, so a
      -- freshly written row is due immediately and no IS NULL arm is needed.
      where ${emailProviderDomainReleases.nextAttemptAt} <= ${now.toISOString()}::timestamptz
      order by ${emailProviderDomainReleases.requestedAt} asc
      limit ${SWEEP_BATCH}
      for update skip locked
    `);
    return extractRows<{ id: string; provider: string; provider_domain_id: string; attempts: number }>(result);
  }, 'sendingDomainsOutboxClaim');

  let released = 0;
  let stuck = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_RELEASE_ATTEMPTS) {
      stuck += 1;
      await sendOpsAlert({
        title: 'Sending domain release stuck',
        body: `Provider ${row.provider} domain ${row.provider_domain_id} has failed ${row.attempts} release attempts. It is still held at the provider. Release it by hand and delete email_provider_domain_releases row ${row.id}.`,
      });
      continue;
    }
    if (row.provider !== provider.id) {
      // A row left by a different configured provider. Alert rather than guess:
      // deleting the wrong provider's domain is unrecoverable.
      stuck += 1;
      await sendOpsAlert({
        title: 'Sending domain release for another provider',
        body: `email_provider_domain_releases row ${row.id} names provider ${row.provider}, but this instance runs ${provider.id}. Not attempted.`,
      });
      continue;
    }
    try {
      await provider.deleteDomain(row.provider_domain_id);   // 404 is success per the adapter contract
      await withSystemDbAccessContext(
        () => db.delete(emailProviderDomainReleases).where(eq(emailProviderDomainReleases.id, row.id)),
        'sendingDomainsOutboxDelete',
      );
      released += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      const backoffMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** attempts);
      await withSystemDbAccessContext(
        () => db.update(emailProviderDomainReleases)
          .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffMs), lastError: message.slice(0, 2000) })
          .where(eq(emailProviderDomainReleases.id, row.id)),
        'sendingDomainsOutboxBackoff',
      );
    }
  }
  return { released, stuck };
}

// ---------------------------------------------------------------------------
// Test send (spec §6.1, §7)
// ---------------------------------------------------------------------------

/**
 * Calls the adapter's `send` DIRECTLY, bypassing resolveSender, so a domain can
 * be tested before any identity exists. From is the support identity's local
 * part when one is configured, else `test`; To is always the requesting user's
 * own address, never a typed one.
 *
 * On `static` this is the verification step itself: the relay accepting the
 * message is the only proof Breeze can obtain that it may send as the domain,
 * so acceptance moves a `pending` row to `verified` (spec §5.1).
 *
 * NOTE (W03): the daily partner-lane cap of spec §6.1 is NOT counted here —
 * `tryCountPartnerLaneSend` ships in W04. Until then the only bound is the
 * route's 5/h/partner limit. W04 adds the call.
 */
export async function runTestSend(domainId: string, userId: string): Promise<'sent' | 'refused' | 'skipped'> {
  const provider = getEmailDomainProvider();
  if (!provider) return 'skipped';

  const context = await withSystemDbAccessContext(async () => {
    const found = await db
      .select()
      .from(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, domainId))
      .limit(1);
    const domain = found[0];
    if (!domain) return null;
    const recipient = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.partnerId, domain.partnerId), eq(users.status, 'active')))
      .limit(1);
    const support = await db
      .select({ localPart: partnerSenderIdentities.localPart })
      .from(partnerSenderIdentities)
      .where(and(
        eq(partnerSenderIdentities.sendingDomainId, domainId),
        eq(partnerSenderIdentities.stream, 'support'),
      ))
      .limit(1);
    return { domain, to: recipient[0]?.email ?? null, localPart: support[0]?.localPart ?? 'test' };
  }, 'sendingDomainTestSendLoad');

  if (!context || !context.to) return 'skipped';
  const { domain, to, localPart } = context;

  const sendable = domain.status === 'verified' || domain.status === 'at_risk'
    || (domain.status === 'pending' && !provider.verifiesByDns);
  if (!sendable) return 'skipped';

  const from = `${localPart}@${domain.domain}`;
  try {
    await provider.send({
      from,
      to,
      subject: `Breeze test message from ${domain.domain}`,
      html: `<p>This is a test message sent from <strong>${from}</strong> to confirm Breeze can send as this domain.</p>`,
      text: `This is a test message sent from ${from} to confirm Breeze can send as this domain.`,
      partnerRef: domain.partnerId,
      tags: {
        partner_id: domain.partnerId,
        domain_id: domain.id,
        stream: 'support',
        purpose: 'sending_domain.test',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withSystemDbAccessContext(
      () => db.update(partnerSendingDomains)
        .set({ lastTestAt: new Date(), lastTestStatus: 'failed', lastTestError: message.slice(0, 2000), updatedAt: sql`now()` })
        .where(eq(partnerSendingDomains.id, domainId)),
      'sendingDomainTestSendFailed',
    );
    return 'refused';
  }

  await withSystemDbAccessContext(
    () => db.update(partnerSendingDomains)
      .set({ lastTestAt: new Date(), lastTestStatus: 'sent', lastTestError: null, updatedAt: sql`now()` })
      .where(eq(partnerSendingDomains.id, domainId)),
    'sendingDomainTestSendPassed',
  );

  // `static` only: an accepted test send IS the verification (spec §5.1). This
  // must NOT be an enqueued sync — `syncSendingDomain` deliberately treats a
  // `static` adapter's `pending` as no change (W02 amendment 5), so a sync
  // would leave the row pending forever. The transition is made here, with its
  // audit row and its status mail.
  if (!provider.verifiesByDns && domain.status === 'pending') {
    await markStaticDomainVerified(domainId);
  }
  return 'sent';
}

// ---------------------------------------------------------------------------
// Daily maintenance: hosted drift report + static delist re-check (spec §6.4)
// ---------------------------------------------------------------------------

export async function runDailyMaintenance(now: Date = new Date()): Promise<{ drift: number; rechecked: number }> {
  const provider = getEmailDomainProvider();
  if (!provider) return { drift: 0, rechecked: 0 };

  let drift = 0;
  if (isHosted()) {
    // Hosted only: the partner-lane account is dedicated to this instance, so a
    // provider domain with no local row and no outbox row is a real leak. On
    // self-hosted the account is the operator's own and holds domains Breeze
    // knows nothing about, which would make this pure noise.
    try {
      const remote = await provider.listDomains();
      await recordProviderKeyProbe('ok');
      const known = await withSystemDbAccessContext(async () => {
        const result = await db.execute<{ provider_domain_id: string }>(sql`
          select provider_domain_id from ${partnerSendingDomains} where provider_domain_id is not null
          union
          select provider_domain_id from ${emailProviderDomainReleases}
        `);
        return new Set(extractRows<{ provider_domain_id: string }>(result).map((r) => r.provider_domain_id));
      }, 'sendingDomainsDriftKnown');

      // `listDomains()` returns only { providerDomainId, domain } (W02 pins the
      // interface), so the age each candidate is judged on comes from a second
      // call. That is affordable precisely because it is made ONLY for domains
      // we cannot account for: in a healthy account that list is empty, and a
      // non-empty one is an incident, not a routine cost.
      const candidates = remote.filter((d) => !known.has(d.providerDomainId));
      const unknown: Array<{ providerDomainId: string; domain: string }> = [];
      for (const candidate of candidates) {
        let createdAt: Date | undefined;
        try {
          createdAt = (await provider.findDomainByName(candidate.domain))?.createdAt;
        } catch {
          // Treat an unreadable candidate as reportable: silence here is the
          // failure mode this report exists to prevent.
        }
        // Spec §6.4 alerts only past 24 h, so a domain mid-provision is not
        // flagged. No creation time means we cannot tell a leak from a
        // just-created object — report it rather than suppress it.
        if (!createdAt || now.getTime() - createdAt.getTime() > DRIFT_MIN_AGE_MS) {
          unknown.push(candidate);
        }
      }
      drift = unknown.length;
      if (drift > 0) {
        // NOTHING is deleted here, ever. Drift is reported and repaired by a
        // human (spec §2, §6.4).
        await sendOpsAlert({
          title: `Sending-domain drift: ${drift} provider domain(s) with no Breeze row`,
          body: unknown.map((d) => `${d.domain} (${d.providerDomainId})`).join('\n'),
        });
      }
    } catch (err) {
      await recordProviderKeyProbe('send_only');
      console.warn('[SendingDomains] drift report could not list domains:', err instanceof Error ? err.message : err);
    }
  }

  let rechecked = 0;
  if (!provider.verifiesByDns) {
    // `static`: getDomain is a local lookup against EMAIL_DOMAINS_STATIC_ALLOWED,
    // so re-running it is how a domain the operator delisted stops being used
    // (spec §5.1, §13). Enqueue rather than sync inline so the limiter applies.
    const rows = await withSystemDbAccessContext(async () => {
      const result = await db.execute<{ id: string }>(sql`
        select id from ${partnerSendingDomains}
        where ${partnerSendingDomains.status} in ('pending', 'verified', 'at_risk')
      `);
      return extractRows<{ id: string }>(result);
    }, 'sendingDomainsStaticRecheck');
    for (const row of rows) {
      await enqueueSyncDomain(row.id);
      rechecked += 1;
    }
  }

  return { drift, rechecked };
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

function createSendingDomainsWorker(): Worker<SendingDomainsJobData> {
  return new Worker<SendingDomainsJobData>(
    SENDING_DOMAINS_QUEUE,
    async (job: Job<SendingDomainsJobData>) => {
      switch (job.name) {
        case SYNC_JOB: {
          const data = job.data as { domainId: string; lastSendError?: string };
          return syncSendingDomain(data.domainId, { lastSendError: data.lastSendError });
        }
        case SWEEP_JOB:
          return runSendingDomainsSweep();
        case TEST_SEND_JOB: {
          const data = job.data as { domainId: string; userId: string };
          return runTestSend(data.domainId, data.userId);
        }
        case DAILY_JOB:
          return runDailyMaintenance();
        default:
          console.warn(`[SendingDomains] unknown job name: ${job.name}`);
          return null;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      // 5 management calls a second leaves headroom under the account's 10 req/s
      // for the partner-lane SENDS that share it (spec §6).
      limiter: { max: 5, duration: 1000 },
    },
  );
}

async function scheduleRepeatables(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === SWEEP_JOB || job.name === DAILY_JOB) {
      await q.removeRepeatableByKey(job.key);
    }
  }
  await q.add(SWEEP_JOB, {}, {
    jobId: SWEEP_REPEAT_ID,
    repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 100 },
  });
  await q.add(DAILY_JOB, {}, {
    jobId: DAILY_REPEAT_ID,
    repeat: { pattern: DAILY_CRON },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });
  // One un-repeated run at boot: the `static` re-check has to happen on start,
  // not only at 21:03 (spec §6.1). Harmless on hosted — the drift report is
  // read-only.
  await q.add(DAILY_JOB, {}, { removeOnComplete: true, removeOnFail: { count: 10 } });
}

/**
 * Probe the management key once (spec §5.1). A `sending_access` key can send
 * but cannot manage domains; degrading the capability to an explained
 * "unavailable" is far better than failing every add-domain request with a
 * provider error the partner cannot act on.
 */
async function probeManagementKey(): Promise<void> {
  const provider = getEmailDomainProvider();
  if (!provider) return;
  try {
    await provider.listDomains();
    await recordProviderKeyProbe('ok');
  } catch (err) {
    console.warn('[SendingDomains] management key probe failed — treating the key as send-only:', err instanceof Error ? err.message : err);
    await recordProviderKeyProbe('send_only');
  }
}

export async function initializeSendingDomainsWorker(): Promise<void> {
  if (worker) return;
  if (!isPartnerLaneConfigured()) {
    // The default. Nothing is constructed and nothing is scheduled, and the
    // readiness manifest's 'sending_domains_configured' rule declares this
    // consumer optional-disabled so /ready is unaffected.
    console.log(`[SendingDomains] Disabled (EMAIL_DOMAINS_PROVIDER unset) — worker not registered`);
    return;
  }

  worker = createSendingDomainsWorker();
  attachWorkerObservability(worker, 'sendingDomainsWorker');
  worker.on('error', (error) => {
    console.error('[SendingDomains] Worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[SendingDomains] Job ${job?.id} (${job?.name}) failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatables();
    await probeManagementKey();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }

  console.log(`[SendingDomains] Worker initialized (provider=${getEmailDomainsConfig().provider})`);
}

export async function shutdownSendingDomainsWorker(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  if (w) {
    try { await w.close(); } catch (err) { console.error('[SendingDomains] Error closing worker:', err); }
  }
  if (q) {
    try { await q.close(); } catch (err) { console.error('[SendingDomains] Error closing queue:', err); }
  }
}
```

- [ ] **Step 6: Run the worker tests and the schedule contract**

Run: `cd apps/api && npx vitest run src/jobs/sendingDomainsWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/jobs/scheduleRegistry.test.ts`
Expected: all green. The contract suite proves no coarse `every` was introduced, that `'sending-domains-daily'` is allocated exactly once, and that `3 21 * * *` collides with nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/sendingDomainsWorker.ts apps/api/src/jobs/sendingDomainsWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/emailDomains/keyProbe.ts
git commit -m "feat(email-domains): sending-domains worker (sweep, outbox drain, test send, daily maintenance)

Daily work takes an allocated cron slot, never repeat:{every:24h} — BullMQ
anchors `every` to the epoch and every 24h repeatable fires at 00:00 UTC.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Register the worker (registry, readiness rule, both boot paths)

**Files:**
- Modify: `apps/api/src/services/workerRegistry.ts:1420-1431` — add one entry after the `toolSourceDiscoveryWorker` entry, still inside `WORKER_REGISTRY`
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts:5-10` (rule union), `:264` (manifest row, after `consumers('toolSourceDiscoveryWorker'),`), `:274-296` (`ruleEnabled`), `:298-307` (`declareExpectedConsumers` input)
- Modify: `apps/api/src/index.ts:1170-1179` (the `declareExpectedConsumers` call) and its import block near `:231`
- Modify: `apps/api/src/worker.ts:595-604` (the `declareExpectedConsumers` call) and its import block near `:96`
- Modify: `apps/api/src/jobs/workerReadinessManifest.test.ts:49-64`, `:77-86`, `:175`, `:219-231`, `:261`
- Create: `apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts`

**Interfaces:**
- Consumes: `initializeSendingDomainsWorker` / `shutdownSendingDomainsWorker` (Task 4), `isPartnerLaneConfigured` (W02).
- Produces: registry entry `sendingDomainsWorker` (`placement: 'global'`); `ConsumerRequirementRule` gains `'sending_domains_configured'`; `declareExpectedConsumers` input gains `sendingDomainsConfigured: boolean`.

> **Why `placement: 'global'`, verified not guessed.** `workerRegistry.ts:46-48` forbids guessing. The runtime import closure of `jobs/sendingDomainsWorker.ts` was walked (transitive relative imports, `import type` ignored) over `services/email.ts`, `services/opsAlerts.ts`, `services/partnerTrust.ts`, `services/auditEvents.ts`, `db/index.ts`, `db/schema/index.ts`, `services/redis.ts`, `jobs/workerObservability.ts` and `db/partnerAxisRead.ts` — none reaches `routes/agentWs.ts` or `services/agentCommandAwait.ts`. The same walk correctly flags `jobs/m365SyncWorker.ts` and `jobs/orgMerge.ts` as `socket-owner`, which is how their registry entries are classified, so the tool is not returning false negatives. `services/workerEntrypointClosure.contract.test.ts` remains the final authority and runs in Step 5.

- [ ] **Step 1: Write the failing registration test**

Create `apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts`:

```ts
// apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('sendingDomainsWorker registration (W03, partner sending domains)', () => {
  it('is registered in WORKER_REGISTRY as a global-placement, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'sendingDomainsWorker');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });

  it('is declared CONDITIONALLY, so an unconfigured instance is never pinned not-ready', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'sendingDomainsWorker',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      consumers: ['sendingDomainsWorker'],
      requiredWhen: 'sending_domains_configured',
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/workerRegistry.sendingDomainsWorker.test.ts`
Expected: both cases fail — `expected undefined to be defined`.

- [ ] **Step 3: Add the registry entry**

In `apps/api/src/services/workerRegistry.ts`, immediately after the `toolSourceDiscoveryWorker` entry's closing `},` (line 1431) and before the array's `];`, add:

```ts
  {
    // Partner sending domains W03. The ONE place that calls the email-domain
    // provider (spec §2). `initializeSendingDomainsWorker` returns before
    // constructing anything when EMAIL_DOMAINS_PROVIDER is unset, which is the
    // default — hence the matching 'sending_domains_configured' readiness rule.
    // placement 'global': the module's runtime import closure (domainSync ->
    // providerRegistry/adapters -> services/email.ts, opsAlerts, partnerTrust,
    // auditEvents, db, redis) reaches neither routes/agentWs.ts nor
    // services/agentCommandAwait.ts.
    name: 'sendingDomainsWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/sendingDomainsWorker');
      return { init: m.initializeSendingDomainsWorker, shutdown: m.shutdownSendingDomainsWorker };
    },
  },
```

- [ ] **Step 4: Add the readiness rule and wire both boot paths**

`apps/api/src/jobs/workerReadinessManifest.ts`, the `ConsumerRequirementRule` union at `:5-10` — add the last member:

```ts
export type ConsumerRequirementRule =
  | 'redis'                   // required whenever Redis is available
  | 'abuse_or_partner_trust_enabled' // shared abuse/partner-trust consumer
  | 'audit_chain_verify_enabled' // audit verification kill switch
  | 'event_dispatch_enabled'  // D3a: eventDispatch (EVENT_DISPATCH_MODE !== 'off')
  | 'ai_agents_enabled'       // D3a: aiAgentRunner (AI_AGENTS_ENABLED)
  | 'sending_domains_configured'; // W03: sendingDomainsWorker (EMAIL_DOMAINS_PROVIDER set)
```

After `consumers('toolSourceDiscoveryWorker'),` (`:264`), add:

```ts
  // Partner sending domains W03. initializeSendingDomainsWorker returns before
  // constructing a Worker when EMAIL_DOMAINS_PROVIDER is unset — the default on
  // every self-hosted install and on hosted until W05 — so a plain-required row
  // would leave every api/all process permanently not-ready. Same shape and
  // same reason as aiAgentRunner above.
  consumers('sendingDomainsWorker', ['sendingDomainsWorker'], 'sending_domains_configured'),
```

In `ruleEnabled` (`:274-296`) add the field to the input type and the case:

```ts
function ruleEnabled(
  rule: ConsumerRequirementRule,
  input: {
    partnerTrustEnabled: boolean;
    auditChainVerifyEnabled: boolean;
    abuseSignalsEnabled: boolean;
    eventDispatchEnabled: boolean;
    aiAgentsEnabled: boolean;
    sendingDomainsConfigured: boolean;
  },
): boolean {
  switch (rule) {
    case 'redis':
      return true;
    case 'abuse_or_partner_trust_enabled':
      return input.abuseSignalsEnabled || input.partnerTrustEnabled;
    case 'audit_chain_verify_enabled':
      return input.auditChainVerifyEnabled;
    case 'event_dispatch_enabled':
      return input.eventDispatchEnabled;
    case 'ai_agents_enabled':
      return input.aiAgentsEnabled;
    case 'sending_domains_configured':
      return input.sendingDomainsConfigured;
  }
}
```

And the exported input at `:298-307` gains `sendingDomainsConfigured: boolean;` after `aiAgentsEnabled: boolean;`.

`apps/api/src/index.ts`: add `import { isPartnerLaneConfigured } from './services/emailDomains/config';` to the import block that ends at `:232`, and extend the call at `:1170-1179`:

```ts
  declareExpectedConsumers({
    role: breezeRole(),
    redisAvailable,
    abuseSignalsEnabled: abuseSignalsEnabled(),
    partnerTrustEnabled: partnerTrustMode() !== 'off',
    auditChainVerifyEnabled: auditChainVerifyEnabled(),
    eventDispatchEnabled: eventDispatchMode() !== 'off',
    aiAgentsEnabled: AI_AGENTS_ENABLED,
    sendingDomainsConfigured: isPartnerLaneConfigured(),
    registry: workerReadinessRegistry,
  });
```

`apps/api/src/worker.ts`: add `import { isPartnerLaneConfigured } from './services/emailDomains/config';` beside the `partnerTrustMode` import at `:98`, and make the same one-line addition to the call at `:595-604`.

- [ ] **Step 5: Update the manifest's own rule mirror**

`apps/api/src/jobs/workerReadinessManifest.test.ts` mirrors the rules locally so the count tests cannot drift from the semantics tests. Five edits:

At `:49-64`, extend `Flags`, `ALL_ON` and `DEFAULT_FLAGS`:
```ts
interface Flags {
  partnerTrustEnabled: boolean;
  auditChainVerifyEnabled: boolean;
  abuseSignalsEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
  sendingDomainsConfigured: boolean;
}
const ALL_ON: Flags = {
  partnerTrustEnabled: true, auditChainVerifyEnabled: true, abuseSignalsEnabled: true,
  eventDispatchEnabled: true, aiAgentsEnabled: true, sendingDomainsConfigured: true,
};
// Default configuration: opt-in flags off, audit verification on.
const DEFAULT_FLAGS: Flags = {
  partnerTrustEnabled: false, auditChainVerifyEnabled: true, abuseSignalsEnabled: false,
  eventDispatchEnabled: false, aiAgentsEnabled: false, sendingDomainsConfigured: false,
};
```

At `:77-86`, add the case to `ruleIsOn`:
```ts
    case 'sending_domains_configured': return flags.sendingDomainsConfigured;
```

At `:175` and at `:261`, the two hard-coded optional-consumer lists gain the new name (both are sorted):
```ts
    expect(optional).toEqual(['abuseSignalsWorker', 'aiAgentRunner', 'eventDispatch', 'eventDispatchMaintenance', 'sendingDomainsWorker']);
```
and rename the second test so the count in its title stays truthful:
```ts
  it('on a default all box exactly five consumers are optional (names, not a number)', () => {
```

At `:219-231`, add a row to the rule table so the new rule gets the same on/off proof as the other four:
```ts
    ['sending_domains_configured', 'sendingDomainsWorker', 'worker', { ...ALL_ON, sendingDomainsConfigured: false }],
```

- [ ] **Step 6: Run everything registration touches**

Run: `cd apps/api && npx vitest run src/services/workerRegistry.sendingDomainsWorker.test.ts src/jobs/workerReadinessManifest.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/worker.boot.test.ts`
Expected: all green. `workerReadinessManifest.test.ts`'s "classifies every initializeWorkers group exactly once" proves the registry entry and the manifest row agree; `workerEntrypointClosure.contract.test.ts` is the authority on the `'global'` placement and will fail if the closure actually reaches `routes/agentWs.ts`.

- [ ] **Step 7: Typecheck the two boot paths**

Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean. A missing `sendingDomainsConfigured` at either call site is a compile error, which is the point of putting it on the required input rather than defaulting it.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/jobs/workerReadinessManifest.test.ts apps/api/src/index.ts apps/api/src/worker.ts
git commit -m "feat(email-domains): register sendingDomainsWorker behind a sending_domains_configured readiness rule

A plain redis-required row would pin every unconfigured api/all process
not-ready, since the initializer returns before constructing a Worker.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `sendingDomainService.ts`

**Files:**
- Create: `apps/api/src/services/emailDomains/sendingDomainService.ts`
- Create: `apps/api/src/services/emailDomains/sendingDomainService.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` — one `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry (Step 0)

**Interfaces:**
- Consumes: `getEmailDomainsConfig` / `isPartnerLaneConfigured` (`./config`), `getEmailDomainProvider` (`./providerRegistry`), `assertSendingDomainAllowed` / `SendingDomainPolicyError` (`./domainPolicy`), `normalizeSendingDomain` / `senderLocalPartSchema` / `senderDisplayNameSchema` (`@breeze/shared`), `readProviderKeyProbe` (`./keyProbe`), `evaluateCapabilityContinuationForState` (`../partnerTrust`), `readWithPartnerAxisVisibility` (`../../db/partnerAxisRead`), `rateLimiter` (`../rate-limit`), `getRedis` (`../redis`), `partnerInboundDomains` / `partnerSenderIdentities` / `partnerSendingDomains` / `emailProviderDomainReleases` / `partners` (`../../db/schema`).
- Produces:
  ```ts
  export type SendingDomainErrorCode =
    | 'sending_domains_unsupported' | 'domain_invalid' | 'domain_unavailable'
    | 'domain_limit_reached' | 'rate_limited' | 'not_found' | 'domain_not_sendable';
  export class SendingDomainServiceError extends Error {
    readonly code: SendingDomainErrorCode; readonly status: 400 | 404 | 409 | 429;
  }
  export interface CapabilityPartnerRow {
    id: string; status: string; trustState: PartnerTrustState; probationEnrollments: number;
  }
  export async function getSendingDomainsCapability(partner: CapabilityPartnerRow): Promise<SendingDomainsCapabilityDto>;
  export async function listSendingDomains(partner: CapabilityPartnerRow): Promise<SendingDomainsListResponse>;
  export async function createSendingDomain(input: { partnerId: string; domain: string; userId: string }): Promise<SendingDomainDto>;
  export async function requestDomainCheck(input: { partnerId: string; domainId: string }): Promise<SendingDomainDto>;
  export async function requestDomainRemoval(input: { partnerId: string; domainId: string }): Promise<void>;
  export async function upsertSenderIdentity(input: { partnerId: string; stream: PartnerMailStream; sendingDomainId: string; localPart: string; displayName?: string | null; replyTo?: string | null; userId: string }): Promise<SenderIdentityDto>;
  export async function deleteSenderIdentity(input: { partnerId: string; stream: PartnerMailStream }): Promise<void>;
  export async function suspendSendingDomain(domainId: string): Promise<void>;
  export async function unsuspendSendingDomain(domainId: string): Promise<void>;
  export async function forceReleaseSendingDomain(domainId: string): Promise<void>;
  export async function listAllSendingDomains(opts: { limit: number }): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string }>>;
  export const DOMAIN_UNAVAILABLE_MESSAGE: string;
  ```

- [ ] **Step 0: Register the file in `ALLOWED_WITHOUT_CAPABILITY_CHECK`**

In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, add to `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`:64`):

```ts
  'services/emailDomains/sendingDomainService.ts': 'the partner-wide gate for every caller-facing sending-domain write lives one layer up, in routes/partnerSendingDomains.ts, which calls canManagePartnerWidePolicies on all six mutating routes; this service takes the partner id from the verified auth context its route passed, never from request input, and its remaining callers are the platform-admin routes (already behind platformAdminMiddleware + requireMfa) and the sending-domains worker, which has no caller at all',
```

Run: `cd apps/api && npx vitest run src/__tests__/partner-wide-write-coverage.test.ts`
Expected: **FAIL** on "the allowlist has no stale entries" until Step 3 lands the file. Same discipline as Task 3 Step 0.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/sendingDomainService.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, inserts, updates, insertReturns } = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  insertReturns: [] as unknown[][],
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          inserts.push(v);
          const tail = { returning: vi.fn(async () => insertReturns.shift() ?? []) };
          return { ...tail, onConflictDoNothing: vi.fn(() => tail), onConflictDoUpdate: vi.fn(() => tail) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => {
          updates.push(v);
          return { where: vi.fn(() => ({ returning: vi.fn(async () => rows.shift() ?? []) })) };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => fn() }));

const { rateLimiterMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: new Date() })),
}));
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../redis', () => ({ getRedis: () => ({}) }));

const { providerMock, getProviderMock, laneConfigured, maxPerPartner, allowlist } = vi.hoisted(() => {
  const providerMock = { id: 'fake' as const, verifiesByDns: true };
  return {
    providerMock,
    getProviderMock: vi.fn(() => providerMock as unknown),
    laneConfigured: { value: true },
    maxPerPartner: { value: 3 },
    allowlist: { value: [] as string[] },
  };
});
vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));
vi.mock('./config', () => ({
  isPartnerLaneConfigured: () => laneConfigured.value,
  getEmailDomainsConfig: () => ({
    provider: laneConfigured.value ? 'fake' : null,
    resendApiKey: null, resendSendingKey: null,
    region: 'us-east-1', maxPerPartner: maxPerPartner.value, dailySendCap: 0,
    partnerAllowlist: allowlist.value, denylist: [], staticAllowed: [], webhookSecret: null,
  }),
  findStaticAllowedEntry: () => null,
}));

const { policyMock } = vi.hoisted(() => ({ policyMock: vi.fn() }));
vi.mock('./domainPolicy', () => ({
  assertSendingDomainAllowed: policyMock,
  SendingDomainPolicyError: class SendingDomainPolicyError extends Error {
    constructor(public reason: string) { super(reason); }
  },
}));

const { probeRead } = vi.hoisted(() => ({ probeRead: vi.fn(async () => null as string | null) }));
vi.mock('./keyProbe', () => ({ readProviderKeyProbe: probeRead }));

const { evaluateMock } = vi.hoisted(() => ({ evaluateMock: vi.fn(() => ({ allow: true })) }));
vi.mock('../partnerTrust', () => ({ evaluateCapabilityContinuationForState: evaluateMock }));

const { enqueueSyncMock } = vi.hoisted(() => ({ enqueueSyncMock: vi.fn(async () => undefined) }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: enqueueSyncMock }));

import {
  DOMAIN_UNAVAILABLE_MESSAGE, SendingDomainServiceError, createSendingDomain, deleteSenderIdentity,
  forceReleaseSendingDomain, getSendingDomainsCapability, listSendingDomains, requestDomainCheck,
  requestDomainRemoval, suspendSendingDomain, unsuspendSendingDomain, upsertSenderIdentity,
} from './sendingDomainService';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const partner = () => ({ id: PARTNER_ID, status: 'active', trustState: 'trusted' as const, probationEnrollments: 0 });

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO_THROW'; }
  catch (err) { return err instanceof SendingDomainServiceError ? err.code : `OTHER:${String(err)}`; }
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0; inserts.length = 0; updates.length = 0; insertReturns.length = 0;
  laneConfigured.value = true; maxPerPartner.value = 3; allowlist.value = [];
  providerMock.verifiesByDns = true;
  getProviderMock.mockReturnValue(providerMock as unknown);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
  evaluateMock.mockReturnValue({ allow: true });
  probeRead.mockResolvedValue(null);
  policyMock.mockReturnValue(undefined);
});

describe('listSendingDomains DTO shape (W05 renders these fields)', () => {
  it('fills every SendingDomainDto field, including statusChangedAt, as an ISO string', async () => {
    const at = new Date('2026-09-17T12:00:00.000Z');
    rows.push([{
      id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake',
      status: 'at_risk', statusReason: 'dns_removed', dnsRecords: [],
      providerManaged: true, providerRegion: 'us-east-1',
      verifiedAt: at, lastCheckedAt: at, nextCheckAt: at, statusChangedAt: at,
      lastTestAt: null, lastTestStatus: null, lastTestError: null,
      lastSendError: null, lastSendErrorAt: null, createdAt: at,
    }]);
    rows.push([]);   // identities

    const { domains } = await listSendingDomains(partner());

    expect(domains[0]).toEqual({
      id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake',
      status: 'at_risk', statusReason: 'dns_removed', dnsRecords: [],
      verifiedAt: at.toISOString(), lastCheckedAt: at.toISOString(),
      lastTestAt: null, lastTestStatus: null, lastTestError: null,
      lastSendError: null, lastSendErrorAt: null,
      statusChangedAt: at.toISOString(),
      providerManaged: true, createdAt: at.toISOString(),
    });
    // Poll scheduling and the provider region are not the partner's business.
    expect(domains[0]).not.toHaveProperty('nextCheckAt');
    expect(domains[0]).not.toHaveProperty('providerRegion');
  });

  it('joins each identity to its domain and computes fromAddress', async () => {
    const at = new Date('2026-09-17T12:00:00.000Z');
    rows.push([]);   // domains
    rows.push([{
      identity: {
        id: 'i1', partnerId: PARTNER_ID, sendingDomainId: DOMAIN_ID, stream: 'support',
        localPart: 'help', displayName: 'Acme Support', replyTo: null, updatedAt: at,
      },
      domain: 'mail.acme.test',
    }]);

    const { identities } = await listSendingDomains(partner());

    expect(identities[0]).toEqual({
      id: 'i1', stream: 'support', sendingDomainId: DOMAIN_ID,
      domain: 'mail.acme.test', localPart: 'help', displayName: 'Acme Support',
      replyTo: null, fromAddress: 'help@mail.acme.test', updatedAt: at.toISOString(),
    });
  });
});

describe('getSendingDomainsCapability', () => {
  it('is unsupported with no provider configured — the dark default', async () => {
    laneConfigured.value = false;
    getProviderMock.mockReturnValue(null);
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: false, provider: null, eligible: false });
  });

  it('reports the provider, whether it verifies by DNS, and the per-partner cap', async () => {
    maxPerPartner.value = 5;
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 5 });
  });

  it('is ineligible with a reason when the side-effect-free trust evaluator denies', async () => {
    evaluateMock.mockReturnValue({ allow: false, code: 'TRUST_PROBATION', capability: 'custom_sending_domain', reason: 'probation' });
    const cap = await getSendingDomainsCapability(partner());
    expect(cap.eligible).toBe(false);
    expect(cap.reason).toBe('probation');
  });

  it('never writes a denial audit row — it uses the CONTINUATION evaluator, not evaluateCapability', async () => {
    await getSendingDomainsCapability(partner());
    expect(evaluateMock).toHaveBeenCalledWith('custom_sending_domain', expect.objectContaining({ partnerId: PARTNER_ID }), expect.anything());
  });

  it('is ineligible when an allowlist is set and the partner is not on it', async () => {
    allowlist.value = [OTHER_PARTNER_ID];
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ eligible: false, reason: 'not_allowlisted' });
  });

  it('is unsupported with provider_key_send_only when the worker probe found a sending-only key', async () => {
    probeRead.mockResolvedValue('send_only');
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: false, reason: 'provider_key_send_only' });
  });

  it('treats an unprobed key as fine rather than as a denial', async () => {
    probeRead.mockResolvedValue(null);
    const cap = await getSendingDomainsCapability(partner());
    expect(cap.supported).toBe(true);
    expect(cap.reason).toBeUndefined();
  });

  it('is ineligible for a non-active partner', async () => {
    const cap = await getSendingDomainsCapability({ ...partner(), status: 'suspended' });
    expect(cap).toMatchObject({ eligible: false, reason: 'partner_inactive' });
  });
});

describe('createSendingDomain', () => {
  const create = (domain = 'mail.acme.test') => createSendingDomain({ partnerId: PARTNER_ID, domain, userId: USER_ID });

  it('404s when no provider is configured', async () => {
    laneConfigured.value = false;
    getProviderMock.mockReturnValue(null);
    expect(await codeOf(create)).toBe('sending_domains_unsupported');
  });

  it('rejects a structurally invalid domain before any database work', async () => {
    expect(await codeOf(() => create('not a domain'))).toBe('domain_invalid');
    expect(inserts).toHaveLength(0);
  });

  it('rejects a policy-refused domain (platform, consumer, public suffix, denylist)', async () => {
    const { SendingDomainPolicyError } = await import('./domainPolicy');
    policyMock.mockImplementation(() => { throw new SendingDomainPolicyError('platform_domain'); });
    expect(await codeOf(create)).toBe('domain_invalid');
  });

  it('enforces the per-partner cap', async () => {
    maxPerPartner.value = 1;
    rows.push([{ count: 1 }]);           // own-row count
    expect(await codeOf(create)).toBe('domain_limit_reached');
  });

  it('enforces 5 creates a day per partner', async () => {
    rows.push([{ count: 0 }]);
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    expect(await codeOf(create)).toBe('rate_limited');
    const [, key, limit, window] = rateLimiterMock.mock.calls[0]!;
    expect(key).toContain(PARTNER_ID);
    expect(limit).toBe(5);
    expect(window).toBe(24 * 60 * 60);
  });

  it('refuses a domain another partner already holds INBOUND, through the partner-axis read', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: OTHER_PARTNER_ID }]);    // partner_inbound_domains hit
    expect(await codeOf(create)).toBe('domain_unavailable');
    expect(inserts).toHaveLength(0);
  });

  it('allows a domain the SAME partner holds inbound — that is the white-labelled loop', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: PARTNER_ID }]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, createdAt: new Date() }]);
    await expect(create()).resolves.toMatchObject({ id: DOMAIN_ID, status: 'provisioning' });
  });

  it('inserts with onConflictDoNothing and returns 409 on zero rows — never raising 23505 in the request transaction', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([]);                          // the UNIQUE (domain) conflict
    expect(await codeOf(create)).toBe('domain_unavailable');
  });

  it('gives BOTH conflict causes the identical non-revealing message (spec §4.3)', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: OTHER_PARTNER_ID }]);
    let heldElsewhere: SendingDomainServiceError | undefined;
    try { await create(); } catch (e) { heldElsewhere = e as SendingDomainServiceError; }

    rows.length = 0; insertReturns.length = 0;
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([]);
    let uniqueViolation: SendingDomainServiceError | undefined;
    try { await create(); } catch (e) { uniqueViolation = e as SendingDomainServiceError; }

    expect(heldElsewhere!.message).toBe(uniqueViolation!.message);
    expect(heldElsewhere!.message).toBe(DOMAIN_UNAVAILABLE_MESSAGE);
    expect(heldElsewhere!.message).not.toContain(OTHER_PARTNER_ID);
  });

  it('inserts provisioning and enqueues the sync AFTER the write has returned', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, createdAt: new Date() }]);
    await create();
    expect(inserts[0]).toMatchObject({ partnerId: PARTNER_ID, domain: 'mail.acme.test', status: 'provisioning', createdBy: USER_ID });
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('normalises before storing — the stored value is the lowercase A-label', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, createdAt: new Date() }]);
    await createSendingDomain({ partnerId: PARTNER_ID, domain: '  MAIL.Acme.Test.  ', userId: USER_ID });
    expect(inserts[0]!.domain).toBe('mail.acme.test');
  });
});

describe('requestDomainCheck', () => {
  it('limits a domain to one check a minute', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('rate_limited');
    const [, key, limit, window] = rateLimiterMock.mock.calls[0]!;
    expect(key).toContain(DOMAIN_ID);
    expect(limit).toBe(1);
    expect(window).toBe(60);
  });

  it('404s a domain that is not the caller\'s', async () => {
    rows.push([]);
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('not_found');
  });

  it('puts a failed row inside the retry window back to pending, keeping its DNS records', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'failed', providerDomainId: 'pd-1', dnsRecords: [{}] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null, dnsRecords: [{}], providerManaged: true, createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'pending' });
    expect(updates.at(-1)!.dnsRecords).toBeUndefined();
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('sends a failed row with NO provider object back to provisioning instead', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'failed', providerDomainId: null, dnsRecords: [] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'provisioning' });
  });

  it('only stamps check_requested_at for a live row', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'pending', providerDomainId: 'pd-1', dnsRecords: [] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null, dnsRecords: [], providerManaged: true, createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)!.status).toBeUndefined();
    expect(updates.at(-1)!.checkRequestedAt).toBeInstanceOf(Date);
  });

  it('refuses to re-check a suspended row — the partner cannot undo the kill switch', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'suspended', providerDomainId: 'pd-1', dnsRecords: [] }]);
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('domain_not_sendable');
  });
});

describe('requestDomainRemoval', () => {
  it('marks the row removing and lets the worker do the provider work', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'removing' }]);
    await requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'removing', statusReason: 'user_removed' });
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('404s when the row is not the caller\'s (the UPDATE returns nothing under RLS)', async () => {
    rows.push([]);
    expect(await codeOf(() => requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('not_found');
  });
});

describe('sender identities (spec §4.4)', () => {
  const upsert = (overrides: Record<string, unknown> = {}) => upsertSenderIdentity({
    partnerId: PARTNER_ID, stream: 'support', sendingDomainId: DOMAIN_ID,
    localPart: 'support', userId: USER_ID, ...overrides,
  } as Parameters<typeof upsertSenderIdentity>[0]);

  it('requires the domain to belong to the caller', async () => {
    rows.push([]);
    expect(await codeOf(() => upsert())).toBe('not_found');
  });

  it('requires the domain to be verified or at_risk', async () => {
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      rows.length = 0;
      rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status, domain: 'mail.acme.test' }]);
      expect(await codeOf(() => upsert())).toBe('domain_not_sendable');
    }
  });

  it('accepts at_risk — mail still flows there with fallback', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'at_risk', domain: 'mail.acme.test' }]);
    insertReturns.push([{ id: 'i1', partnerId: PARTNER_ID, stream: 'support', localPart: 'support', sendingDomainId: DOMAIN_ID, displayName: null, replyTo: null, updatedAt: new Date() }]);
    await expect(upsert()).resolves.toMatchObject({ stream: 'support' });
  });

  it('refuses the reserved local parts', async () => {
    for (const localPart of ['postmaster', 'abuse', 'mailer-daemon']) {
      rows.length = 0;
      rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
      expect(await codeOf(() => upsert({ localPart }))).toBe('domain_invalid');
    }
  });

  it('refuses a display name that looks like another address', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
    expect(await codeOf(() => upsert({ displayName: 'Acme <billing@bank.test>' }))).toBe('domain_invalid');
  });

  it('upserts on (partner_id, stream) so re-pointing a stream is one call', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
    insertReturns.push([{ id: 'i1', partnerId: PARTNER_ID, stream: 'billing', localPart: 'billing', sendingDomainId: DOMAIN_ID, displayName: null, replyTo: null, updatedAt: new Date() }]);
    await upsert({ stream: 'billing', localPart: 'billing' });
    expect(inserts[0]).toMatchObject({ partnerId: PARTNER_ID, stream: 'billing', localPart: 'billing', updatedBy: USER_ID });
  });

  it('deleting an identity returns the stream to the platform sender', async () => {
    await expect(deleteSenderIdentity({ partnerId: PARTNER_ID, stream: 'support' })).resolves.toBeUndefined();
  });
});

describe('platform admin actions (spec §9.1 kill switch)', () => {
  it('suspend sets suspended/platform_suspended and takes effect on the next send', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'suspended' }]);
    await suspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'suspended', statusReason: 'platform_suspended' });
  });

  it('unsuspend returns the row to provisioning when it has no provider object, else pending', async () => {
    rows.push([{ id: DOMAIN_ID, providerDomainId: null }]);
    rows.push([{ id: DOMAIN_ID, status: 'provisioning' }]);
    await unsuspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'provisioning' });

    updates.length = 0; rows.length = 0;
    rows.push([{ id: DOMAIN_ID, providerDomainId: 'pd-1' }]);
    rows.push([{ id: DOMAIN_ID, status: 'pending' }]);
    await unsuspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'pending' });
  });

  it('force-release of a MANAGED domain writes the outbox row, nulls the handle, then drops the row', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', providerDomainId: 'pd-1', providerRegion: 'us-east-1', providerManaged: true }]);
    await forceReleaseSendingDomain(DOMAIN_ID);
    expect(inserts[0]).toMatchObject({ provider: 'fake', providerDomainId: 'pd-1', reason: 'force_release' });
    expect(updates.at(-1)).toMatchObject({ providerDomainId: null });
  });

  it('force-release of an UNMANAGED domain writes NO outbox row — we never delete what we did not create', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'acme.test', provider: 'fake', providerDomainId: 'pd-1', providerRegion: null, providerManaged: false }]);
    await forceReleaseSendingDomain(DOMAIN_ID);
    expect(inserts).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ providerDomainId: null });
  });

  it('404s an unknown domain', async () => {
    rows.push([]);
    expect(await codeOf(() => forceReleaseSendingDomain(DOMAIN_ID))).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/services/emailDomains/sendingDomainService.test.ts`
Expected: collection fails — `Failed to resolve import "./sendingDomainService"`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/emailDomains/sendingDomainService.ts`:

```ts
import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  normalizeSendingDomain, senderDisplayNameSchema, senderLocalPartSchema,
  type SenderIdentityDto, type SendingDomainDto, type SendingDomainProviderId,
  type SendingDomainStatusReason, type SendingDomainStatusValue,
  type SendingDomainsCapabilityDto, type SendingDomainsListResponse,
} from '@breeze/shared';
import type { PartnerMailStream } from './mailPurposes';
import { db, withSystemDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import {
  emailProviderDomainReleases, partnerInboundDomains, partnerSenderIdentities,
  partnerSendingDomains, partners,
} from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import { enqueueSyncDomain } from '../../jobs/sendingDomainsWorker';
import { evaluateCapabilityContinuationForState } from '../partnerTrust';
import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { SendingDomainPolicyError, assertSendingDomainAllowed } from './domainPolicy';
import { readProviderKeyProbe } from './keyProbe';
import { getEmailDomainProvider } from './providerRegistry';

export type SendingDomainErrorCode =
  | 'sending_domains_unsupported' | 'domain_invalid' | 'domain_unavailable'
  | 'domain_limit_reached' | 'rate_limited' | 'not_found' | 'domain_not_sendable';

export class SendingDomainServiceError extends Error {
  constructor(
    readonly code: SendingDomainErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 429,
  ) {
    super(message);
    this.name = 'SendingDomainServiceError';
  }
}

/**
 * ONE message for BOTH conflict causes — "another partner holds this name" and
 * "it exists at our provider outside Breeze" (spec §4.3). Telling them apart
 * would let anyone probe which domains other Breeze customers send from.
 */
export const DOMAIN_UNAVAILABLE_MESSAGE =
  'This domain may already be registered with Breeze or with our email provider. '
  + 'Use a dedicated subdomain (for example mail.yourdomain.com), or contact support.';

const CREATE_LIMIT_PER_DAY = 5;
const CREATE_WINDOW_SECONDS = 24 * 60 * 60;
const CHECK_LIMIT_PER_MINUTE = 1;
const CHECK_WINDOW_SECONDS = 60;

export interface CapabilityPartnerRow {
  id: string;
  status: string;
  trustState: PartnerTrustState;
  probationEnrollments: number;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * W02's `SendingDomainDto` is an EXACT field set with ISO-8601 strings, and it
 * deliberately omits `providerRegion` and `nextCheckAt` — the poll schedule and
 * the provider's region are not the partner's business. `statusChangedAt` IS
 * included: the UI dates the "at risk since"/"failed" banners from it.
 * Keep this mapper exhaustive against that type rather than spreading the row.
 */
function toDomainDto(row: typeof partnerSendingDomains.$inferSelect): SendingDomainDto {
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider as SendingDomainProviderId,
    status: row.status as SendingDomainStatusValue,
    statusReason: (row.statusReason ?? null) as SendingDomainStatusReason | null,
    dnsRecords: (row.dnsRecords ?? []) as SendingDomainDto['dnsRecords'],
    verifiedAt: iso(row.verifiedAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    lastTestAt: iso(row.lastTestAt),
    lastTestStatus: row.lastTestStatus ?? null,
    lastTestError: row.lastTestError ?? null,
    lastSendError: row.lastSendError ?? null,
    lastSendErrorAt: iso(row.lastSendErrorAt),
    statusChangedAt: row.statusChangedAt.toISOString(),
    providerManaged: row.providerManaged,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `SenderIdentityDto` carries the JOINED domain and the computed `fromAddress`,
 * so the UI never has to reassemble `localPart@domain` itself (and cannot get
 * it wrong). Callers must therefore pass the identity row together with its
 * domain name.
 */
function toIdentityDto(
  row: typeof partnerSenderIdentities.$inferSelect,
  domain: string,
): SenderIdentityDto {
  return {
    id: row.id,
    stream: row.stream as PartnerMailStream,
    sendingDomainId: row.sendingDomainId,
    domain,
    localPart: row.localPart,
    displayName: row.displayName ?? null,
    replyTo: row.replyTo ?? null,
    fromAddress: `${row.localPart}@${domain}`,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Capability, spec §7 `GET /`. `eligible` is decided by the SIDE-EFFECT-FREE
 * trust evaluator (`evaluateCapabilityContinuationForState`) rather than
 * `evaluateCapability`, so merely rendering the settings tab never writes a
 * denial audit row or triggers auto-promotion.
 *
 * `supported` is about the INSTANCE (is a provider configured, can its key
 * manage domains); `eligible` is about the PARTNER (allowlist, status, trust).
 * They are separate so the UI can say "your plan/DNS is fine, this server is
 * not set up" without conflating the two.
 */
export async function getSendingDomainsCapability(partner: CapabilityPartnerRow): Promise<SendingDomainsCapabilityDto> {
  const config = getEmailDomainsConfig();
  const provider = getEmailDomainProvider();
  if (!provider || !isPartnerLaneConfigured()) {
    return { supported: false, provider: null, verifiesByDns: false, eligible: false, maxDomains: config.maxPerPartner };
  }

  // Written by the worker's one-shot probe and read across the process boundary
  // through Redis (see keyProbe.ts). `null` means "not probed", never "denied".
  const probe = await readProviderKeyProbe();
  if (probe === 'send_only') {
    return {
      supported: false, provider: provider.id, verifiesByDns: provider.verifiesByDns,
      eligible: false, reason: 'provider_key_send_only', maxDomains: config.maxPerPartner,
    };
  }

  const base = {
    supported: true, provider: provider.id, verifiesByDns: provider.verifiesByDns,
    maxDomains: config.maxPerPartner,
  };

  if (partner.status !== 'active') {
    return { ...base, eligible: false, reason: 'partner_inactive' };
  }
  if (config.partnerAllowlist.length > 0 && !config.partnerAllowlist.includes(partner.id)) {
    return { ...base, eligible: false, reason: 'not_allowlisted' };
  }
  const decision = evaluateCapabilityContinuationForState(
    'custom_sending_domain',
    { partnerId: partner.id },
    { trustState: partner.trustState, probationEnrollments: partner.probationEnrollments },
  );
  if (!decision.allow) {
    return { ...base, eligible: false, reason: decision.reason };
  }
  return { ...base, eligible: true };
}

export async function listSendingDomains(partner: CapabilityPartnerRow): Promise<SendingDomainsListResponse> {
  const capability = await getSendingDomainsCapability(partner);
  if (!isPartnerLaneConfigured()) return { capability, domains: [], identities: [] };

  // Ambient partner-scoped RLS context: these are the caller's OWN rows, and
  // breeze_has_partner_access(partner_id) is exactly the boundary we want.
  const domains = await db
    .select()
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.partnerId, partner.id))
    .orderBy(desc(partnerSendingDomains.createdAt));
  // Joined, because SenderIdentityDto carries `domain` and `fromAddress`.
  const identities = await db
    .select({ identity: partnerSenderIdentities, domain: partnerSendingDomains.domain })
    .from(partnerSenderIdentities)
    .innerJoin(partnerSendingDomains, eq(partnerSendingDomains.id, partnerSenderIdentities.sendingDomainId))
    .where(eq(partnerSenderIdentities.partnerId, partner.id));

  return {
    capability,
    domains: domains.map(toDomainDto),
    identities: identities.map((r) => toIdentityDto(r.identity, r.domain)),
  };
}

function requireProvider(): NonNullable<ReturnType<typeof getEmailDomainProvider>> {
  const provider = getEmailDomainProvider();
  if (!provider || !isPartnerLaneConfigured()) {
    throw new SendingDomainServiceError(
      'sending_domains_unsupported', 'Custom sending domains are not available on this Breeze instance.', 404,
    );
  }
  return provider;
}

export async function createSendingDomain(input: { partnerId: string; domain: string; userId: string }): Promise<SendingDomainDto> {
  requireProvider();

  // W02 returns a DISCRIMINATED UNION, not `string | null`, so the rejection
  // reason reaches the UI instead of a generic "invalid".
  const normalized = normalizeSendingDomain(input.domain);
  if (!normalized.ok) {
    throw new SendingDomainServiceError(
      'domain_invalid', `Enter a valid domain name, for example mail.yourdomain.com (${normalized.reason}).`, 400,
    );
  }
  const domain = normalized.domain;
  try {
    assertSendingDomainAllowed(domain);
  } catch (err) {
    if (err instanceof SendingDomainPolicyError) {
      throw new SendingDomainServiceError('domain_invalid', `This domain cannot be used for sending (${err.reason}).`, 400);
    }
    throw err;
  }

  const config = getEmailDomainsConfig();
  const [existing] = await db
    .select({ count: count() })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.partnerId, input.partnerId));
  if ((existing?.count ?? 0) >= config.maxPerPartner) {
    throw new SendingDomainServiceError(
      'domain_limit_reached', `This account can hold ${config.maxPerPartner} sending domains. Remove one first.`, 409,
    );
  }

  const rate = await rateLimiter(
    getRedis(), `rl:sending-domains:create:${input.partnerId}`, CREATE_LIMIT_PER_DAY, CREATE_WINDOW_SECONDS,
  );
  if (!rate.allowed) {
    throw new SendingDomainServiceError('rate_limited', 'Too many sending domains added today. Try again tomorrow.', 429);
  }

  // Spec §3.4: refuse a domain another partner already owns INBOUND, so the two
  // seams cannot disagree about who owns a name. partner_inbound_domains is
  // partner-axis, so a partner-scoped context sees ZERO rows for another
  // partner's entry and this check would silently pass — the sanctioned escape
  // for exactly this read is readWithPartnerAxisVisibility. The lookup key is
  // the requested domain; no partner id from request input is used as an axis.
  const inbound = await readWithPartnerAxisVisibility(() => db
    .select({ partnerId: partnerInboundDomains.partnerId })
    .from(partnerInboundDomains)
    .where(eq(partnerInboundDomains.domain, domain))
    .limit(1));
  if (inbound[0] && inbound[0].partnerId !== input.partnerId) {
    throw new SendingDomainServiceError('domain_unavailable', DOMAIN_UNAVAILABLE_MESSAGE, 409);
  }

  // `onConflictDoNothing` rather than catch-23505: a unique violation raised on
  // the request's own withDbAccessContext transaction ABORTS it even when
  // caught, and the mapped 409 then surfaces as a 500 at commit (utils/pgErrors.ts:42,
  // prod incident 2026-09-15). Zero returned rows is the race-safe conflict
  // signal and nothing is ever raised.
  const [created] = await db
    .insert(partnerSendingDomains)
    .values({
      partnerId: input.partnerId,
      domain,
      provider: requireProvider().id,
      providerRegion: config.region,
      status: 'provisioning',
      statusChangedAt: new Date(),
      nextCheckAt: new Date(),
      createdBy: input.userId,
    })
    .onConflictDoNothing({ target: partnerSendingDomains.domain })
    .returning();
  if (!created) {
    throw new SendingDomainServiceError('domain_unavailable', DOMAIN_UNAVAILABLE_MESSAGE, 409);
  }

  // The write above is awaited and its row exists; the enqueue is the next
  // statement rather than a hook inside the transaction callback, because the
  // repo has no after-commit helper. The worst case if the request transaction
  // later rolls back is one sync job that finds no row and returns 'not_found'.
  await enqueueSyncDomain(created.id);
  return toDomainDto(created);
}

export async function requestDomainCheck(input: { partnerId: string; domainId: string }): Promise<SendingDomainDto> {
  requireProvider();

  const rate = await rateLimiter(
    getRedis(), `rl:sending-domains:check:${input.domainId}`, CHECK_LIMIT_PER_MINUTE, CHECK_WINDOW_SECONDS,
  );
  if (!rate.allowed) {
    throw new SendingDomainServiceError('rate_limited', 'You can check a domain once a minute. Try again shortly.', 429);
  }

  const [row] = await db
    .select()
    .from(partnerSendingDomains)
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .limit(1);
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  if (row.status === 'suspended' || row.status === 'removing') {
    throw new SendingDomainServiceError('domain_not_sendable', 'This domain cannot be checked in its current state.', 409);
  }

  const now = new Date();
  const patch: Partial<typeof partnerSendingDomains.$inferInsert> = { checkRequestedAt: now, nextCheckAt: now };
  if (row.status === 'failed') {
    // Retry inside the window (spec §7). The DNS records are deliberately NOT
    // cleared: handing the partner a second set would invalidate whatever they
    // already published.
    patch.status = row.providerDomainId ? 'pending' : 'provisioning';
    patch.statusReason = null;
    patch.statusChangedAt = now;
    patch.checkAttempts = 0;
  }

  const [updated] = await db
    .update(partnerSendingDomains)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);

  await enqueueSyncDomain(input.domainId);
  return toDomainDto(updated);
}

export async function requestDomainRemoval(input: { partnerId: string; domainId: string }): Promise<void> {
  requireProvider();
  const now = new Date();
  const [updated] = await db
    .update(partnerSendingDomains)
    .set({ status: 'removing', statusReason: 'user_removed', statusChangedAt: now, nextCheckAt: now, updatedAt: sql`now()` })
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // The worker does the provider delete and the row delete, in that order, so
  // the BEFORE DELETE guard can never be bypassed from a request path.
  await enqueueSyncDomain(input.domainId);
}

/**
 * Spec §4.4, enforced by W02's SHARED schemas rather than a second regex here:
 * `senderLocalPartSchema` carries the pattern, the 64-char bound, the
 * consecutive-dot rule and RESERVED_SENDER_LOCAL_PARTS; `senderDisplayNameSchema`
 * carries the 78-char bound and the "display name that looks like another
 * address" spoof check. One definition, shared with the web form, so the two
 * cannot drift.
 */
function assertIdentityShape(localPart: string, displayName?: string | null): void {
  const local = senderLocalPartSchema.safeParse(localPart.trim().toLowerCase());
  if (!local.success) {
    throw new SendingDomainServiceError('domain_invalid', 'Enter a valid mailbox name, for example support.', 400);
  }
  if (displayName !== undefined && displayName !== null && displayName.trim() !== '') {
    const name = senderDisplayNameSchema.safeParse(displayName.trim());
    if (!name.success) {
      throw new SendingDomainServiceError('domain_invalid', 'The display name cannot contain an email address or a link.', 400);
    }
  }
}

export async function upsertSenderIdentity(input: {
  partnerId: string; stream: PartnerMailStream; sendingDomainId: string;
  localPart: string; displayName?: string | null; replyTo?: string | null; userId: string;
}): Promise<SenderIdentityDto> {
  requireProvider();

  const [domain] = await db
    .select({
      id: partnerSendingDomains.id,
      status: partnerSendingDomains.status,
      domain: partnerSendingDomains.domain,
    })
    .from(partnerSendingDomains)
    .where(and(
      eq(partnerSendingDomains.id, input.sendingDomainId),
      eq(partnerSendingDomains.partnerId, input.partnerId),
    ))
    .limit(1);
  if (!domain) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // at_risk is allowed: mail still flows there, with fallback (spec §5.2).
  if (domain.status !== 'verified' && domain.status !== 'at_risk') {
    throw new SendingDomainServiceError('domain_not_sendable', 'Verify this domain before using it as a sender.', 409);
  }

  assertIdentityShape(input.localPart, input.displayName);
  const localPart = input.localPart.trim().toLowerCase();
  const now = new Date();

  const [row] = await db
    .insert(partnerSenderIdentities)
    .values({
      partnerId: input.partnerId, sendingDomainId: input.sendingDomainId, stream: input.stream,
      localPart, displayName: input.displayName ?? null, replyTo: input.replyTo ?? null,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [partnerSenderIdentities.partnerId, partnerSenderIdentities.stream],
      set: {
        sendingDomainId: input.sendingDomainId, localPart,
        displayName: input.displayName ?? null, replyTo: input.replyTo ?? null,
        updatedBy: input.userId, updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  return toIdentityDto(row, domain.domain);
}

export async function deleteSenderIdentity(input: { partnerId: string; stream: PartnerMailStream }): Promise<void> {
  requireProvider();
  // Idempotent: removing a stream that has no identity already leaves it on the
  // platform sender, which is the requested end state.
  await db
    .delete(partnerSenderIdentities)
    .where(and(
      eq(partnerSenderIdentities.partnerId, input.partnerId),
      eq(partnerSenderIdentities.stream, input.stream),
    ));
}

// ---------------------------------------------------------------------------
// Platform admin. All of these run cross-partner, so they take SYSTEM scope —
// the caller has already passed platformAdminMiddleware + requireMfa().
// ---------------------------------------------------------------------------

export async function listAllSendingDomains(opts: { limit: number }): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string }>> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ domain: partnerSendingDomains, partnerName: partners.name })
      .from(partnerSendingDomains)
      .innerJoin(partners, eq(partners.id, partnerSendingDomains.partnerId))
      .orderBy(desc(partnerSendingDomains.statusChangedAt))
      .limit(opts.limit);
    return rows.map((r) => ({ ...toDomainDto(r.domain), partnerId: r.domain.partnerId, partnerName: r.partnerName }));
  }, 'sendingDomainsAdminList');
}

async function setAdminStatus(domainId: string, patch: Partial<typeof partnerSendingDomains.$inferInsert>): Promise<void> {
  const updated = await withSystemDbAccessContext(() => db
    .update(partnerSendingDomains)
    .set({ ...patch, statusChangedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(partnerSendingDomains.id, domainId))
    .returning(), 'sendingDomainsAdminStatus');
  if (updated.length === 0) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  await enqueueSyncDomain(domainId);
}

/** The kill switch (spec §9.1). Sending stops on the next send, because resolution reads the row. */
export async function suspendSendingDomain(domainId: string): Promise<void> {
  await setAdminStatus(domainId, { status: 'suspended', statusReason: 'platform_suspended', nextCheckAt: new Date() });
}

export async function unsuspendSendingDomain(domainId: string): Promise<void> {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ providerDomainId: partnerSendingDomains.providerDomainId })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.id, domainId))
    .limit(1), 'sendingDomainsAdminUnsuspendLoad');
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // Back to the state the worker can advance from: a row that never got a
  // provider object must re-provision; one that has it only needs a poll.
  await setAdminStatus(domainId, {
    status: row.providerDomainId ? 'pending' : 'provisioning',
    statusReason: null, checkAttempts: 0, nextCheckAt: new Date(),
  });
}

/**
 * Drop Breeze's claim on a name without waiting for the partner (spec §7, §13).
 * Order is the same as the worker's: outbox row (MANAGED only) → null the
 * handle → delete the row, so the BEFORE DELETE guard is satisfied and the
 * provider object is still released after the partner rows are gone.
 *
 * `provider_managed = false` gets NO outbox row. That domain object pre-existed
 * Breeze and deleting it could take down the operator's primary sender.
 */
export async function forceReleaseSendingDomain(domainId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, domainId))
      .limit(1);
    if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);

    if (row.providerManaged && row.providerDomainId) {
      await db
        .insert(emailProviderDomainReleases)
        .values({
          provider: row.provider,
          providerDomainId: row.providerDomainId,
          providerRegion: row.providerRegion,
          domain: row.domain,
          reason: 'force_release',   // one of the four values the CHECK allows
        })
        .onConflictDoNothing({
          target: [emailProviderDomainReleases.provider, emailProviderDomainReleases.providerDomainId],
        });
    }
    await db
      .update(partnerSendingDomains)
      .set({ providerDomainId: null, updatedAt: sql`now()` })
      .where(eq(partnerSendingDomains.id, domainId));
    await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, domainId));
  }, 'sendingDomainsForceRelease');
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/emailDomains/sendingDomainService.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: 36 passed in the service suite; `partner-wide-write-coverage.test.ts` green (the Step 0 entry is no longer stale, and the sweep does not flag the file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/emailDomains/sendingDomainService.ts apps/api/src/services/emailDomains/sendingDomainService.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(email-domains): sending domain service (create, check, remove, identities, admin, capability)

Creates use onConflictDoNothing so a UNIQUE(domain) race never raises 23505
inside the request transaction, and both conflict causes return the identical
non-revealing 409 (spec 4.3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `routes/partnerSendingDomains.ts`

**Files:**
- Create: `apps/api/src/routes/partnerSendingDomains.ts`
- Create: `apps/api/src/routes/partnerSendingDomains.test.ts`

**Interfaces:**
- Consumes: `authMiddleware` / `requireMfa` / `requirePermission` / `requireScope` / `requirePartner` (`../middleware/auth`), `requireCapability` (`../services/partnerTrust`), `canManagePartnerWidePolicies` + `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`../services/partnerWideAccess`), `writeRouteAudit` (`../services/auditEvents`), `zValidator` (`../lib/validation`), `PERMISSIONS` (`../services/permissions`), `rateLimiter` (`../services/rate-limit`), `getRedis` (`../services/redis`), every exported function of `../services/emailDomains/sendingDomainService`, `enqueueTestSend` (`../jobs/sendingDomainsWorker`).
- Produces: `export const partnerSendingDomainsRoutes: Hono`, mounted at `/partner/sending-domains`.

> The middleware stack is copied from `PATCH /partners/me` (`routes/orgs.ts:904-922`) **in full**: `requireScope('partner')` → `requirePartner` → `requireOrgWrite` → `requireMfa()` → the inline `canManagePartnerWidePolicies` denial → `requireCapability('custom_sending_domain')` → `zValidator`. `requireOrgWrite` is not importable — it is built locally from `requirePermission(PERMISSIONS.ORGS_WRITE…)`, exactly as `orgs.ts:102-104` does. The partner-wide gate is the piece spec §7's prose summary leaves out and `orgs.ts:911-916` actually has: a sending domain applies to **every org under the MSP**, so an `orgAccess: 'selected'` user must not be able to add, re-point or remove it (the `partnerServicePrincipals.ts` lesson from the 2026-08-16 review, and plan amendment 11).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/partnerSendingDomains.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  gateOrder: [] as string[],
  authMiddleware: vi.fn(),
  requireScope: vi.fn((...scopes: string[]) => async (_c: any, next: any) => {
    mocks.gateOrder.push(`scope:${scopes.join(',')}`);
    return next();
  }),
  requirePartner: vi.fn(async (c: any, next: any) => {
    mocks.gateOrder.push('partner');
    return c.get('auth')?.partnerId ? next() : c.json({ error: 'Partner context required' }, 403);
  }),
  permissionAllowed: { value: true },
  mfaAllowed: { value: true },
  capabilityAllowed: { value: true },
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    mocks.gateOrder.push(`permission:${resource}:${action}`);
    return mocks.permissionAllowed.value ? next() : c.json({ error: 'Insufficient permissions' }, 403);
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    mocks.gateOrder.push('mfa');
    return mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }),
  requireCapability: vi.fn((cap: string) => async (c: any, next: any) => {
    mocks.gateOrder.push(`capability:${cap}`);
    return mocks.capabilityAllowed.value ? next() : c.json({ error: 'capability denied' }, 403);
  }),
  partnerWideAllowed: vi.fn(() => true),
  audit: vi.fn(),
  enqueueTestSend: vi.fn(async () => undefined),
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: new Date() })),
  service: {
    listSendingDomains: vi.fn(),
    createSendingDomain: vi.fn(),
    requestDomainCheck: vi.fn(),
    requestDomainRemoval: vi.fn(),
    upsertSenderIdentity: vi.fn(),
    deleteSenderIdentity: vi.fn(),
    getSendingDomainsCapability: vi.fn(),
  },
  laneConfigured: { value: true },
  partnerRow: { value: { id: '', status: 'active', trustState: 'trusted', probationEnrollments: 0 } as Record<string, unknown> | null },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
  requireScope: mocks.requireScope,
  requirePartner: mocks.requirePartner,
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
}));
vi.mock('../services/partnerTrust', () => ({ requireCapability: mocks.requireCapability }));
vi.mock('../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: mocks.partnerWideAllowed,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Full partner access required',
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: { ORGS_READ: { resource: 'organizations', action: 'read' }, ORGS_WRITE: { resource: 'organizations', action: 'write' } },
}));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../jobs/sendingDomainsWorker', () => ({ enqueueTestSend: mocks.enqueueTestSend }));
vi.mock('../services/emailDomains/config', () => ({ isPartnerLaneConfigured: () => mocks.laneConfigured.value }));
vi.mock('../services/emailDomains/sendingDomainService', async () => {
  class SendingDomainServiceError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  }
  return { ...mocks.service, SendingDomainServiceError, DOMAIN_UNAVAILABLE_MESSAGE: 'unavailable' };
});
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const c: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => c);
      (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
        Promise.resolve(mocks.partnerRow.value ? [mocks.partnerRow.value] : []).then(r);
      return c;
    }),
  },
}));

import { SendingDomainServiceError } from '../services/emailDomains/sendingDomainService';
import { partnerSendingDomainsRoutes } from './partnerSendingDomains';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const registeredScopeCalls = mocks.requireScope.mock.calls.map((c) => c.map(String));
const registeredCapabilityCalls = mocks.requireCapability.mock.calls.map((c) => String(c[0]));
const registeredMfaCount = mocks.requireMfa.mock.calls.length;

function auth(partnerId: string | null = PARTNER_ID, scope = 'partner') {
  mocks.authMiddleware.mockImplementation((c: any, next: any) => {
    mocks.gateOrder.push('auth');
    c.set('auth', { scope, partnerId, partnerOrgAccess: 'all', user: { id: USER_ID, email: 'tech@acme.test' }, token: { mfa: true } });
    c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
    return next();
  });
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/partner/sending-domains', partnerSendingDomainsRoutes);
  return app;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gateOrder.length = 0;
  mocks.permissionAllowed.value = true;
  mocks.mfaAllowed.value = true;
  mocks.capabilityAllowed.value = true;
  mocks.partnerWideAllowed.mockReturnValue(true);
  mocks.laneConfigured.value = true;
  mocks.partnerRow.value = { id: PARTNER_ID, status: 'active', trustState: 'trusted', probationEnrollments: 0 };
  mocks.rateLimiter.mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
  mocks.service.listSendingDomains.mockResolvedValue({ capability: { supported: true }, domains: [], identities: [] });
  auth();
});

describe('gate registration (spec §7)', () => {
  it('reads require partner scope; writes additionally require MFA and the custom_sending_domain capability', () => {
    expect(registeredScopeCalls.some((c) => c.includes('partner'))).toBe(true);
    expect(registeredMfaCount).toBeGreaterThan(0);
    expect(registeredCapabilityCalls).toContain('custom_sending_domain');
  });

  it('mentions canManagePartnerWidePolicies, which partner-wide-write-coverage requires of this surface', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'partnerSendingDomains.ts'), 'utf8');
    expect(src).toContain('canManagePartnerWidePolicies');
  });
});

describe('unsupported instance', () => {
  it('404s every route with sending_domains_unsupported when no provider is configured', async () => {
    mocks.laneConfigured.value = false;
    const app = buildApp();
    const calls: Array<[string, RequestInit | undefined]> = [
      ['/partner/sending-domains', undefined],
      ['/partner/sending-domains', json({ domain: 'mail.acme.test' })],
      [`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' }],
      [`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' }],
      ['/partner/sending-domains/identities/support', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/partner/sending-domains/identities/support', { method: 'DELETE' }],
      [`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(404);
      expect((await res.json()).error, path).toBe('sending_domains_unsupported');
    }
  });
});

describe('authz matrix', () => {
  it('403s a request with no partner context', async () => {
    auth(null);
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(403);
  });

  it('403s a write without MFA and never touches the service', async () => {
    mocks.mfaAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(403);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('403s a write for a partner without the capability', async () => {
    mocks.capabilityAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(403);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('403s a write without organizations:write', async () => {
    mocks.permissionAllowed.value = false;
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('403s EVERY write for a partner user without full partner access (epic #2135)', async () => {
    mocks.partnerWideAllowed.mockReturnValue(false);
    const app = buildApp();
    const writes: Array<[string, RequestInit]> = [
      ['/partner/sending-domains', json({ domain: 'mail.acme.test' })],
      [`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' }],
      [`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' }],
      ['/partner/sending-domains/identities/support', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'support' }),
      }],
      ['/partner/sending-domains/identities/support', { method: 'DELETE' }],
      [`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' }],
    ];
    for (const [path, init] of writes) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error, path).toBe('Full partner access required');
    }
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
    expect(mocks.enqueueTestSend).not.toHaveBeenCalled();
  });

  it('does NOT gate the read on full partner access — an org-limited tech may still see the state', async () => {
    mocks.partnerWideAllowed.mockReturnValue(false);
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
  });

  it('does NOT gate the read on MFA or the capability — a locked-out partner must still see why', async () => {
    mocks.mfaAllowed.value = false;
    mocks.capabilityAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
  });
});

describe('routes', () => {
  it('GET / returns the capability, domains and identities', async () => {
    mocks.service.listSendingDomains.mockResolvedValue({
      capability: { supported: true, provider: 'fake', eligible: true, maxDomains: 3, verifiesByDns: true },
      domains: [{ id: DOMAIN_ID }], identities: [],
    });
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ capability: { provider: 'fake' }, domains: [{ id: DOMAIN_ID }] });
  });

  it('POST / creates, audits and returns 201', async () => {
    mocks.service.createSendingDomain.mockResolvedValue({ id: DOMAIN_ID, domain: 'mail.acme.test', status: 'provisioning' });
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(201);
    expect(mocks.service.createSendingDomain).toHaveBeenCalledWith({ partnerId: PARTNER_ID, domain: 'mail.acme.test', userId: USER_ID });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'partner_sending_domain.create', resourceType: 'partner_sending_domain', resourceId: DOMAIN_ID,
    }));
  });

  it('maps every service error code to its status and never writes an audit row on failure', async () => {
    const cases: Array<[string, number]> = [
      ['domain_invalid', 400], ['domain_unavailable', 409], ['domain_limit_reached', 409],
      ['rate_limited', 429], ['not_found', 404], ['domain_not_sendable', 409],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      auth();
      mocks.service.createSendingDomain.mockRejectedValue(new SendingDomainServiceError(code, 'nope', status));
      const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
      expect(res.status, code).toBe(status);
      expect((await res.json()).error, code).toBe(code);
      expect(mocks.audit, code).not.toHaveBeenCalled();
    }
  });

  it('422s an invalid body before the service is reached', async () => {
    const res = await buildApp().request('/partner/sending-domains', json({}));
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('POST /:id/check returns 202 and audits', async () => {
    mocks.service.requestDomainCheck.mockResolvedValue({ id: DOMAIN_ID, status: 'pending' });
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sending_domain.check' }));
  });

  it('DELETE /:id returns 202 and audits', async () => {
    mocks.service.requestDomainRemoval.mockResolvedValue(undefined);
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(202);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sending_domain.remove' }));
  });

  it('PUT /identities/:stream upserts and audits', async () => {
    mocks.service.upsertSenderIdentity.mockResolvedValue({ id: 'i1', stream: 'support', localPart: 'support' });
    const res = await buildApp().request('/partner/sending-domains/identities/support', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'support' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.service.upsertSenderIdentity).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER_ID, stream: 'support', userId: USER_ID }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sender_identity.upsert' }));
  });

  it('rejects an unknown stream', async () => {
    const res = await buildApp().request('/partner/sending-domains/identities/marketing', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'news' }),
    });
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  it('DELETE /identities/:stream returns 204 and audits', async () => {
    const res = await buildApp().request('/partner/sending-domains/identities/billing', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sender_identity.delete' }));
  });

  it('POST /:id/test enqueues the job with the CALLING user, never a typed address', async () => {
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'attacker@evil.test' }),
    });
    expect(res.status).toBe(202);
    expect(mocks.enqueueTestSend).toHaveBeenCalledWith(DOMAIN_ID, USER_ID);
    expect(JSON.stringify(mocks.enqueueTestSend.mock.calls)).not.toContain('attacker@evil.test');
  });

  it('limits test sends to 5 an hour per partner', async () => {
    mocks.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) });
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(mocks.enqueueTestSend).not.toHaveBeenCalled();
    const [, key, limit, window] = mocks.rateLimiter.mock.calls[0]!;
    expect(String(key)).toContain(PARTNER_ID);
    expect(limit).toBe(5);
    expect(window).toBe(3600);
  });
});

describe('no route calls the provider', () => {
  it('does not import providerRegistry or any adapter, in either import form', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'partnerSendingDomains.ts'), 'utf8');
    expect(src).not.toMatch(/^import (?!type ).*from ['"].*emailDomains\/providerRegistry['"]/m);
    expect(src).not.toMatch(/import\(['"].*emailDomains\/providerRegistry['"]\)/);
    expect(src).not.toMatch(/^import (?!type ).*from ['"].*emailDomains\/adapters\//m);
    expect(src).not.toMatch(/import\(['"].*emailDomains\/adapters\//);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/partnerSendingDomains.test.ts`
Expected: collection fails — `Failed to resolve import "./partnerSendingDomains"`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/partnerSendingDomains.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { db } from '../db';
import { partners } from '../db/schema';
import { enqueueTestSend } from '../jobs/sendingDomainsWorker';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { isPartnerLaneConfigured } from '../services/emailDomains/config';
import {
  SendingDomainServiceError, createSendingDomain, deleteSenderIdentity, getSendingDomainsCapability,
  listSendingDomains, requestDomainCheck, requestDomainRemoval, upsertSenderIdentity,
  type CapabilityPartnerRow,
} from '../services/emailDomains/sendingDomainService';
import { PERMISSIONS } from '../services/permissions';
import { requireCapability } from '../services/partnerTrust';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';

/**
 * Partner-facing sending-domain management (spec §7).
 *
 * NO handler here calls the email-domain provider. Routes write intent rows and
 * enqueue `sync-domain`; the worker owns every outbound call (spec §2). That is
 * why none of these routes needs SELF_MANAGED_DB_CONTEXT_ROUTES: nothing in a
 * handler makes a slow network call while the request transaction holds a
 * pooled connection (#1105). `partnerSendingDomains.test.ts` enforces it with a
 * source scan.
 */
export const partnerSendingDomainsRoutes = new Hono();

const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

/**
 * Epic #2135. A sending domain and a sender identity are partner-wide BY
 * CONSTRUCTION: the From address they set applies to every org under the MSP,
 * including orgs created later. Partner SCOPE alone is not enough — an
 * `orgAccess: 'selected'` user has partner scope and must not be able to
 * re-point the MSP's customer-facing sender. Exactly the shape
 * `PATCH /partners/me` carries inline (`routes/orgs.ts:911-916`) and the shape
 * `partnerServicePrincipals.ts` was fixed to in the 2026-08-16 security review.
 *
 * `partner-wide-write-coverage.test.ts` additionally requires the helper to be
 * MENTIONED wherever a partner-axis table is mutated; the two service files
 * this router calls carry allowlist entries pointing back at this gate.
 */
const requirePartnerWideAdmin = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth'))) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  return next();
};

const TEST_SEND_LIMIT_PER_HOUR = 5;
const TEST_SEND_WINDOW_SECONDS = 3600;

const streamParamSchema = z.object({ stream: z.enum(['support', 'billing', 'general']) });
const idParamSchema = z.object({ id: z.string().guid() });
const createBodySchema = z.object({ domain: z.string().trim().min(3).max(253) });
const identityBodySchema = z.object({
  sendingDomainId: z.string().guid(),
  localPart: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(78).nullable().optional(),
  replyTo: z.string().trim().email().max(320).nullable().optional(),
});

partnerSendingDomainsRoutes.use('*', authMiddleware);
partnerSendingDomainsRoutes.use('*', requireScope('partner'));
partnerSendingDomainsRoutes.use('*', requirePartner);

/**
 * With EMAIL_DOMAINS_PROVIDER unset the whole feature does not exist on this
 * instance, so every route 404s BEFORE any auth-specific gate reports something
 * more interesting (spec §5.1 "none", §7).
 */
partnerSendingDomainsRoutes.use('*', async (c: Context, next: Next) => {
  if (!isPartnerLaneConfigured()) {
    return c.json({ error: 'sending_domains_unsupported' }, 404);
  }
  return next();
});

function partnerId(c: Context): string {
  return (c.get('auth') as AuthContext).partnerId as string;
}

/** The partner row the capability evaluator needs. Read under the caller's own RLS context. */
async function loadCapabilityPartner(c: Context): Promise<CapabilityPartnerRow | null> {
  const [row] = await db
    .select({
      id: partners.id, status: partners.status,
      trustState: partners.trustState, probationEnrollments: partners.probationEnrollments,
    })
    .from(partners)
    .where(eq(partners.id, partnerId(c)))
    .limit(1);
  return row ?? null;
}

function fail(c: Context, err: unknown): Response {
  if (err instanceof SendingDomainServiceError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  throw err;
}

// --- reads -----------------------------------------------------------------

partnerSendingDomainsRoutes.get('/', async (c) => {
  const partner = await loadCapabilityPartner(c);
  if (!partner) return c.json({ error: 'not_found' }, 404);
  try {
    return c.json(await listSendingDomains(partner));
  } catch (err) {
    return fail(c, err);
  }
});

// --- writes ----------------------------------------------------------------
// Same stack as PATCH /partners/me (routes/orgs.ts:904): scope -> partner ->
// organizations:write -> MFA -> capability -> validator -> handler.

partnerSendingDomainsRoutes.post(
  '/',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('json', createBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    try {
      const created = await createSendingDomain({
        partnerId: partnerId(c), domain: c.req.valid('json').domain, userId: auth.user.id,
      });
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'partner_sending_domain.create',
        resourceType: 'partner_sending_domain',
        resourceId: created.id,
        resourceName: created.domain,
        details: { partnerId: partnerId(c), status: created.status },
      });
      return c.json(created, 201);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.post(
  '/:id/check',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    try {
      const updated = await requestDomainCheck({ partnerId: partnerId(c), domainId: id });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.check', resourceType: 'partner_sending_domain',
        resourceId: id, resourceName: updated.domain, details: { status: updated.status },
      });
      return c.json(updated, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.delete(
  '/:id',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    try {
      await requestDomainRemoval({ partnerId: partnerId(c), domainId: id });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.remove', resourceType: 'partner_sending_domain',
        resourceId: id, details: { partnerId: partnerId(c) },
      });
      return c.json({ status: 'removing' }, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.put(
  '/identities/:stream',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', streamParamSchema),
  zValidator('json', identityBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { stream } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const identity = await upsertSenderIdentity({
        partnerId: partnerId(c), stream, sendingDomainId: body.sendingDomainId,
        localPart: body.localPart, displayName: body.displayName ?? null,
        replyTo: body.replyTo ?? null, userId: auth.user.id,
      });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sender_identity.upsert', resourceType: 'partner_sender_identity',
        resourceId: identity.id, resourceName: `${identity.localPart}@${stream}`,
        details: { partnerId: partnerId(c), stream, sendingDomainId: body.sendingDomainId },
      });
      return c.json(identity);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.delete(
  '/identities/:stream',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', streamParamSchema),
  async (c) => {
    const { stream } = c.req.valid('param');
    try {
      await deleteSenderIdentity({ partnerId: partnerId(c), stream });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sender_identity.delete', resourceType: 'partner_sender_identity',
        resourceId: null, details: { partnerId: partnerId(c), stream },
      });
      return c.body(null, 204);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.post(
  '/:id/test',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const rate = await rateLimiter(
      getRedis(), `rl:sending-domains:test:${partnerId(c)}`, TEST_SEND_LIMIT_PER_HOUR, TEST_SEND_WINDOW_SECONDS,
    );
    if (!rate.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000))));
      return c.json({ error: 'rate_limited', message: 'Too many test sends. Try again shortly.' }, 429);
    }

    // The recipient is ALWAYS the calling user's own verified address, taken
    // from the auth context. A body-supplied address would turn this into an
    // open relay for arbitrary mail from a customer-trusted domain (spec §7).
    try {
      await enqueueTestSend(id, auth.user.id);
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.test', resourceType: 'partner_sending_domain',
        resourceId: id, details: { partnerId: partnerId(c) },
      });
      return c.json({ status: 'queued' }, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/routes/partnerSendingDomains.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: 23 passed in the route suite; the coverage contract still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/partnerSendingDomains.ts apps/api/src/routes/partnerSendingDomains.test.ts
git commit -m "feat(email-domains): partner sending-domain routes (spec 7)

No handler calls the provider; routes write intent rows and enqueue. The test
send always addresses the calling user, never a body-supplied address.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `routes/admin/sendingDomains.ts`

**Files:**
- Create: `apps/api/src/routes/admin/sendingDomains.ts`
- Create: `apps/api/src/routes/admin/sendingDomains.test.ts`

**Interfaces:**
- Consumes: `requireMfa` (`../../middleware/auth`), `zValidator` (`../../lib/validation`), `writeRouteAudit` (`../../services/auditEvents`), `forceReleaseSendingDomain` / `listAllSendingDomains` / `suspendSendingDomain` / `unsuspendSendingDomain` / `SendingDomainServiceError` (`../../services/emailDomains/sendingDomainService`).
- Produces: `export const adminSendingDomainsRoutes: Hono`, mounted by the hub at `/admin/sending-domains`.

> `platformAdminMiddleware` is **not** applied here: `routes/admin/index.ts:15` already applies it to everything it mounts, exactly as `routes/admin/trust.ts` relies on. This file adds `requireMfa()` per mutating route, the same posture as `tenantErasureRoutes` (`routes/admin/index.ts:20-22`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/admin/sendingDomains.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  mfaAllowed: { value: true },
  requireMfa: vi.fn(() => async (c: any, next: any) => (
    mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  )),
  audit: vi.fn(),
  listAll: vi.fn(),
  suspend: vi.fn(),
  unsuspend: vi.fn(),
  forceRelease: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({ requireMfa: mocks.requireMfa }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../../services/emailDomains/sendingDomainService', () => {
  class SendingDomainServiceError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  }
  return {
    SendingDomainServiceError,
    listAllSendingDomains: mocks.listAll,
    suspendSendingDomain: mocks.suspend,
    unsuspendSendingDomain: mocks.unsuspend,
    forceReleaseSendingDomain: mocks.forceRelease,
  };
});

import { SendingDomainServiceError } from '../../services/emailDomains/sendingDomainService';
import { adminSendingDomainsRoutes } from './sendingDomains';

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const registeredMfaCount = mocks.requireMfa.mock.calls.length;

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { scope: 'system', partnerId: null, user: { id: ADMIN_ID, email: 'admin@lanternops.test' } } as never);
    await next();
  });
  app.route('/admin/sending-domains', adminSendingDomainsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mfaAllowed.value = true;
  mocks.listAll.mockResolvedValue([]);
});

describe('admin sending domains', () => {
  it('registers MFA on every mutating route (three of them)', () => {
    expect(registeredMfaCount).toBe(3);
  });

  it('does NOT apply platformAdminMiddleware itself — the hub owns that gate', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'sendingDomains.ts'), 'utf8');
    expect(src).not.toContain('platformAdminMiddleware');
    const hub = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(hub).toContain("adminRoutes.use('*', platformAdminMiddleware)");
  });

  it('lists across partners with the partner name attached', async () => {
    mocks.listAll.mockResolvedValue([{ id: DOMAIN_ID, domain: 'mail.acme.test', partnerId: 'p1', partnerName: 'Acme MSP' }]);
    const res = await buildApp().request('/admin/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ partnerName: 'Acme MSP' }] });
  });

  it('caps the list size rather than trusting the query string', async () => {
    await buildApp().request('/admin/sending-domains?limit=100000');
    expect(mocks.listAll).toHaveBeenCalledWith({ limit: expect.any(Number) });
    expect(mocks.listAll.mock.calls[0]![0].limit).toBeLessThanOrEqual(200);
  });

  it.each([
    ['suspend', 'suspend', 'partner_sending_domain.admin_suspend'],
    ['unsuspend', 'unsuspend', 'partner_sending_domain.admin_unsuspend'],
    ['force-release', 'forceRelease', 'partner_sending_domain.admin_force_release'],
  ] as const)('POST /:id/%s calls the service and audits', async (path, fn, action) => {
    (mocks as Record<string, any>)[fn].mockResolvedValue(undefined);
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/${path}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((mocks as Record<string, any>)[fn]).toHaveBeenCalledWith(DOMAIN_ID);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action, resourceId: DOMAIN_ID }));
  });

  it('403s a mutation without MFA', async () => {
    mocks.mfaAllowed.value = false;
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(mocks.suspend).not.toHaveBeenCalled();
  });

  it('404s an unknown domain and writes no audit row', async () => {
    mocks.suspend.mockRejectedValue(new SendingDomainServiceError('not_found', 'Sending domain not found.', 404));
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not import providerRegistry or any adapter, in either import form', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'sendingDomains.ts'), 'utf8');
    expect(src).not.toMatch(/^import (?!type ).*from ['"].*emailDomains\/providerRegistry['"]/m);
    expect(src).not.toMatch(/import\(['"].*emailDomains\/providerRegistry['"]\)/);
    expect(src).not.toMatch(/^import (?!type ).*from ['"].*emailDomains\/adapters\//m);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/admin/sendingDomains.test.ts`
Expected: collection fails — `Failed to resolve import "./sendingDomains"`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/admin/sendingDomains.ts`:

```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  SendingDomainServiceError, forceReleaseSendingDomain, listAllSendingDomains,
  suspendSendingDomain, unsuspendSendingDomain,
} from '../../services/emailDomains/sendingDomainService';

/**
 * Platform-admin surface for sending domains (spec §7, §9.1 kill switch).
 *
 * `platformAdminMiddleware` is deliberately NOT applied here — routes/admin/index.ts
 * applies it to everything it mounts, and applying it twice would authenticate
 * and audit-log the same request twice (the note at routes/admin/index.ts:20).
 * MFA is per mutating route, the same posture as tenantErasureRoutes.
 *
 * Like the partner routes, nothing here calls the provider: suspend/unsuspend
 * move the row and enqueue, and force-release writes the release outbox row the
 * worker drains.
 */
export const adminSendingDomainsRoutes = new Hono();

const MAX_LIST = 200;
const DEFAULT_LIST = 50;

const idParamSchema = z.object({ id: z.string().guid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST).optional(),
});

function fail(c: Context, err: unknown): Response {
  if (err instanceof SendingDomainServiceError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  throw err;
}

adminSendingDomainsRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { limit } = c.req.valid('query');
  const data = await listAllSendingDomains({ limit: Math.min(limit ?? DEFAULT_LIST, MAX_LIST) });
  return c.json({ data });
});

adminSendingDomainsRoutes.post('/:id/suspend', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await suspendSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_suspend',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true, status: 'suspended' });
});

adminSendingDomainsRoutes.post('/:id/unsuspend', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await unsuspendSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_unsuspend',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true });
});

adminSendingDomainsRoutes.post('/:id/force-release', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await forceReleaseSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_force_release',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true });
});
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/routes/admin/sendingDomains.test.ts`
Expected: 10 passed (the `it.each` contributes three).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/sendingDomains.ts apps/api/src/routes/admin/sendingDomains.test.ts
git commit -m "feat(email-domains): platform-admin sending-domain routes (list, suspend, unsuspend, force-release)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Mount both route groups and prove they are reachable

**Files:**
- Modify: `apps/api/src/index.ts` — add one import beside `import { partnerTrustRoutes } from './routes/partnerTrust';` (`:131`), and one `api.route(...)` line between `:1001` and `:1004`
- Modify: `apps/api/src/routes/admin/index.ts:10-11` (import) and `:36` (mount)
- Create: `apps/api/src/routes/sendingDomainsMounting.test.ts`

**Interfaces:**
- Consumes: `partnerSendingDomainsRoutes` (Task 7), `adminSendingDomainsRoutes` (Task 8).
- Produces: `GET /api/v1/partner/sending-domains` and `GET /api/v1/admin/sending-domains` reachable through the real composition roots.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/sendingDomainsMounting.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Reach each router through the REAL admin hub, and assert the index.ts mount
// statically. Importing index.ts itself would boot the server and every worker.
vi.mock('../middleware/platformAdmin', () => ({
  platformAdminMiddleware: async (c: any, next: any) => {
    c.set('auth', { scope: 'system', partnerId: null, user: { id: '55555555-5555-4555-8555-555555555555' } });
    return next();
  },
}));
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('auth', { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', user: { id: 'u1' } });
      c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
      return next();
    },
    requireMfa: () => async (_c: any, next: any) => next(),
  };
});
vi.mock('../services/emailDomains/config', () => ({ isPartnerLaneConfigured: () => false }));
vi.mock('../services/emailDomains/sendingDomainService', () => ({
  SendingDomainServiceError: class extends Error {},
  listAllSendingDomains: vi.fn(async () => []),
  suspendSendingDomain: vi.fn(),
  unsuspendSendingDomain: vi.fn(),
  forceReleaseSendingDomain: vi.fn(),
  listSendingDomains: vi.fn(),
  createSendingDomain: vi.fn(),
  requestDomainCheck: vi.fn(),
  requestDomainRemoval: vi.fn(),
  upsertSenderIdentity: vi.fn(),
  deleteSenderIdentity: vi.fn(),
  getSendingDomainsCapability: vi.fn(),
}));
vi.mock('../jobs/sendingDomainsWorker', () => ({ enqueueTestSend: vi.fn() }));

const indexSource = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

describe('index.ts mounts the partner router', () => {
  it('registers /partner/sending-domains', () => {
    expect(indexSource).toContain("import { partnerSendingDomainsRoutes } from './routes/partnerSendingDomains';");
    expect(indexSource.indexOf("api.route('/partner/sending-domains', partnerSendingDomainsRoutes);")).toBeGreaterThan(-1);
  });

  it('registers it BEFORE the catch-all /partner router, or /sending-domains is eaten', () => {
    const specific = indexSource.indexOf("api.route('/partner/sending-domains'");
    const catchAll = indexSource.indexOf("api.route('/partner', partnerRoutes);");
    expect(specific).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(specific).toBeLessThan(catchAll);
  });
});

describe('the routers are reachable through the real composition roots', () => {
  it('the admin hub serves /admin/sending-domains under platformAdminMiddleware', async () => {
    const { adminRoutes } = await import('./admin');
    const app = new Hono();
    app.route('/admin', adminRoutes);
    const res = await app.request('/admin/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('the partner router answers through its own auth gate and reports the dark default', async () => {
    const { partnerSendingDomainsRoutes } = await import('./partnerSendingDomains');
    const app = new Hono();
    app.route('/partner/sending-domains', partnerSendingDomainsRoutes);
    const res = await app.request('/partner/sending-domains');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sending_domains_unsupported' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/sendingDomainsMounting.test.ts`
Expected: the two static assertions fail (`expected -1 to be greater than -1`) and the admin-hub case 404s, because neither mount exists yet.

- [ ] **Step 3: Mount them**

`apps/api/src/index.ts`, beside the `partnerTrustRoutes` import at `:131`:
```ts
import { partnerSendingDomainsRoutes } from './routes/partnerSendingDomains';
```
and between `api.route('/partner/ai/script-policy', partnerAiScriptPolicyRoutes);` (`:1003`) and `api.route('/partner', partnerRoutes);` (`:1004`):
```ts
// W03 (partner sending domains). MUST stay above the catch-all `/partner`
// mount below, the same ordering `/partner/trust` relies on — Hono matches in
// registration order, so a later specific mount is never reached.
api.route('/partner/sending-domains', partnerSendingDomainsRoutes);
```

`apps/api/src/routes/admin/index.ts`, after the `trustActionAdminRoutes` import (`:11`):
```ts
import { adminSendingDomainsRoutes } from './sendingDomains';
```
and after the `ai-kill-state` mount (`:36`):
```ts
// Partner sending domains W03: cross-partner list plus the kill switch
// (suspend / unsuspend / force-release, spec §9.1). Mounted UNDER the
// platformAdminMiddleware above; the router adds its own requireMfa() on each
// mutating verb.
adminRoutes.route('/sending-domains', adminSendingDomainsRoutes);
```

- [ ] **Step 4: Run the mounting test plus the router auth contract**

Run: `cd apps/api && npx vitest run src/routes/sendingDomainsMounting.test.ts src/__tests__/routerAuthGate.contract.test.ts`
Expected: both green. `routerAuthGate.contract.test.ts` discovers the new `api.route` mount automatically and drives `partnerSendingDomainsRoutes` with no credentials — it must answer 401, which it does because the router applies `authMiddleware` to `*` before the unsupported-instance 404.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/routes/admin/index.ts apps/api/src/routes/sendingDomainsMounting.test.ts
git commit -m "feat(email-domains): mount partner and admin sending-domain routers

/partner/sending-domains is registered above the catch-all /partner mount.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Real-Postgres proof for the release order and the sweep claim

**Files:**
- Modify: `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` — append one `describe` block at the end of the file (the file is created by W02; keep its existing imports and its `afterAll` cleanup, and extend the cleanup's id arrays if the block seeds its own rows)

**Interfaces:**
- Consumes: `syncSendingDomain` (Task 3), `runSendingDomainsSweep` (Task 4), `resetEmailDomainProviderForTests` + the `fake` adapter (W02), `createPartner` / `createUser` (`./db-utils`), `withDbAccessContext` / `withSystemDbAccessContext` (`../../db`).
- Produces: nothing exported; it is the only test that can see the `BEFORE DELETE` guard and the RLS visibility of the sweep's claim, because both are enforced by Postgres and invisible to a mocked db.

> Why this cannot be a unit test: the `BEFORE DELETE` trigger and `FOR UPDATE SKIP LOCKED` are database behaviour. The mocked suites in Tasks 3 and 4 assert the *order of calls*; only real Postgres proves the trigger actually raises when the order is wrong, and that the sweep's claim runs under a scope that can see rows at all. The `tunnel-allowlist-duplicate-savepoint` incident is the repo's standing example of a mocked suite staying green through a production-only failure.

- [ ] **Step 1: Write the failing block**

Append to `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts`:

```ts
// ---------------------------------------------------------------------------
// W03: the release ORDER and the sweep claim, against real Postgres.
// ---------------------------------------------------------------------------
describe('W03 — provider release guard and sweep claim (breeze_app role)', () => {
  it('the BEFORE DELETE guard raises while provider_domain_id is set, and syncSendingDomain gets the order right', async () => {
    const partner = await createPartner();
    seededPartnerIds.push(partner.id);
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    resetEmailDomainProviderForTests();

    const [seeded] = await withSystemDbAccessContext(() => db
      .insert(partnerSendingDomains)
      .values({
        partnerId: partner.id,
        domain: `release-${uniqueSuffix()}.verify.test`,
        provider: 'fake',
        providerDomainId: 'pd-guard',
        providerManaged: true,
        status: 'removing',
        statusReason: 'user_removed',
        statusChangedAt: new Date(),
        nextCheckAt: new Date(),
      })
      .returning());

    // CONTROL: a delete that skips the release raises, so the assertion below
    // is not vacuous. (This is what a future path that "just deletes the row"
    // would hit.)
    const guardMessage = await captureRlsCause(() => withSystemDbAccessContext(() => db
      .delete(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, seeded!.id))));
    expect(guardMessage).toBeDefined();
    expect(guardMessage).toMatch(/provider_domain_id/i);

    // The real path: null the handle first, then delete.
    await expect(syncSendingDomain(seeded!.id)).resolves.toBe('deleted');

    const remaining = await withSystemDbAccessContext(() => db
      .select({ id: partnerSendingDomains.id })
      .from(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, seeded!.id)));
    expect(remaining).toHaveLength(0);

    delete process.env.EMAIL_DOMAINS_PROVIDER;
    resetEmailDomainProviderForTests();
  });

  it('never deletes at the provider, and writes no outbox row, for a provider_managed = false row', async () => {
    const partner = await createPartner();
    seededPartnerIds.push(partner.id);
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    resetEmailDomainProviderForTests();

    const [seeded] = await withSystemDbAccessContext(() => db
      .insert(partnerSendingDomains)
      .values({
        partnerId: partner.id,
        domain: `adopted-${uniqueSuffix()}.verify.test`,
        provider: 'fake',
        providerDomainId: 'pd-preexisting',
        providerManaged: false,
        status: 'removing',
        statusReason: 'user_removed',
        statusChangedAt: new Date(),
        nextCheckAt: new Date(),
      })
      .returning());

    await expect(syncSendingDomain(seeded!.id)).resolves.toBe('deleted');

    const outbox = await withSystemDbAccessContext(() => db
      .select({ id: emailProviderDomainReleases.id })
      .from(emailProviderDomainReleases)
      .where(eq(emailProviderDomainReleases.providerDomainId, 'pd-preexisting')));
    expect(outbox).toHaveLength(0);

    delete process.env.EMAIL_DOMAINS_PROVIDER;
    resetEmailDomainProviderForTests();
  });

  it('the sweep claim runs under SYSTEM scope and sees due rows across partners', async () => {
    const a = await createPartner();
    const b = await createPartner();
    seededPartnerIds.push(a.id, b.id);
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    resetEmailDomainProviderForTests();

    const past = new Date(Date.now() - 60_000);
    await withSystemDbAccessContext(() => db.insert(partnerSendingDomains).values([
      { partnerId: a.id, domain: `sweep-a-${uniqueSuffix()}.verify.test`, provider: 'fake', status: 'pending', statusChangedAt: past, nextCheckAt: past },
      { partnerId: b.id, domain: `sweep-b-${uniqueSuffix()}.verify.test`, provider: 'fake', status: 'pending', statusChangedAt: past, nextCheckAt: past },
      { partnerId: b.id, domain: `sweep-susp-${uniqueSuffix()}.verify.test`, provider: 'fake', status: 'suspended', statusChangedAt: past, nextCheckAt: past },
    ]));

    const result = await runSendingDomainsSweep(new Date());
    // Both partners' due rows, and never the suspended one (spec §6.1).
    expect(result.enqueued).toBeGreaterThanOrEqual(2);

    // The same query under a PARTNER context sees only its own row — proof the
    // sweep genuinely needs system scope and is not accidentally tenant-blind.
    const partnerAView = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [a.id], userId: null, currentPartnerId: a.id },
      () => db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains),
    );
    expect(partnerAView.every((r) => typeof r.id === 'string')).toBe(true);
    expect(partnerAView.length).toBe(1);

    delete process.env.EMAIL_DOMAINS_PROVIDER;
    resetEmailDomainProviderForTests();
  });
});
```

Add to the file's imports (keeping W02's): `import { runSendingDomainsSweep } from '../../jobs/sendingDomainsWorker';`, `import { syncSendingDomain } from '../../services/emailDomains/domainSync';`, `import { resetEmailDomainProviderForTests } from '../../services/emailDomains/providerRegistry';`, and add `emailProviderDomainReleases` / `partnerSendingDomains` to the schema import if W02's file does not already pull them in.

- [ ] **Step 2: Bring up a database and run it**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
```
Expected before the implementation of Tasks 3-4 is present: the block fails on the missing imports. With them present: W02's cases plus these three pass. The first case's CONTROL assertion must genuinely fail the delete — if `guardMessage` comes back `undefined`, W02's `BEFORE DELETE` trigger is not installed and the rest of the case proves nothing; fix that before continuing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
git commit -m "test(email-domains): real-Postgres proof of the release order and the system-scoped sweep claim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Verification

**Files:** none changed. This task only runs things.

- [ ] **Step 1: Typecheck the API package**

Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`
Expected: no errors. (This is the exact command `.github/workflows/ci.yml:295` runs; there is no `typecheck` script in `apps/api/package.json`.)

- [ ] **Step 2: Lint the files this wave touched**

Run: `cd apps/api && npx eslint src/services/emailDomains src/jobs/sendingDomainsWorker.ts src/routes/partnerSendingDomains.ts src/routes/admin/sendingDomains.ts`
Expected: clean.

- [ ] **Step 3: Run every unit file this wave added or changed**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/emailDomains/domainSync.test.ts \
  src/services/emailDomains/statusMail.test.ts \
  src/services/emailDomains/sendingDomainService.test.ts \
  src/jobs/sendingDomainsWorker.test.ts \
  src/jobs/scheduleRegistry.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts \
  src/jobs/workerReadinessManifest.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/workerRegistry.sendingDomainsWorker.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/worker.boot.test.ts \
  src/routes/partnerSendingDomains.test.ts \
  src/routes/admin/sendingDomains.test.ts \
  src/routes/sendingDomainsMounting.test.ts \
  src/__tests__/routerAuthGate.contract.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: all green. Check the reported **file count is 16** — vitest's path filter is a plain substring match, so a typo silently runs fewer files than intended rather than erroring.

- [ ] **Step 4: Run the whole API unit suite**

Run: `cd apps/api && npx vitest run`
Expected: green. The suites most likely to be disturbed by this wave, and why, so a failure is diagnosable rather than mysterious: `workerReadinessCoverage.test.ts` (one `new Worker(` must be matched by one `attachWorkerObservability(` in `sendingDomainsWorker.ts`), `workerReadinessManifest.test.ts` (the optional-consumer lists), `scheduleRegistry.contract.test.ts` (the new cron slot), `routerAuthGate.contract.test.ts` (the new mount), `partner-wide-write-coverage.test.ts` (the two allowlist entries and the route gate), and W01's `mailPurposes` property test (the new purpose must have a send site — `statusMail.ts` is it).

- [ ] **Step 5: Run the contract suites against a real database**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts
cd apps/api && npm run test:rls
cd apps/api && npm run test:rls-coverage
```
Expected: green. Note `test:integration` does **not** accept a path after `--` (that runs the whole suite); pass the path to `npx vitest run --config …` directly as above.

- [ ] **Step 6: Confirm the wave really is dark**

Run: `cd apps/api && npx vitest run src/routes/sendingDomainsMounting.test.ts src/jobs/sendingDomainsWorker.test.ts -t "dark default"`
Expected: the two "dark default" cases pass — with `EMAIL_DOMAINS_PROVIDER` unset the routes answer `404 sending_domains_unsupported` and no Worker is constructed. Also confirm by hand that `git grep -n "EMAIL_DOMAINS_PROVIDER" -- '.env.example' 'deploy/.env.example'` shows the variable commented out or absent, i.e. this PR does not turn the feature on anywhere.

- [ ] **Step 7: Tear the stack down**

Run: `pnpm test-stack down`
Expected: the worktree's private Postgres and Redis are gone. Nothing else reaps them.

- [ ] **Step 8: Open the PR**

Body must contain `Closes #__W03__`, the list of plan amendments above, and an explicit statement that the wave lands dark (provider unset → routes 404, worker not registered). Request one independent review round (high rigor: tenancy, partner cascade, abuse surface).

---

## Self-review

Every in-scope spec requirement, mapped to the task that satisfies it and the test that proves it.

| Spec requirement | Task | Proof |
|---|---|---|
| §2 — all provider management calls happen in ONE worker; request handlers only write intent rows | 4, 7, 8 | `partnerSendingDomains.test.ts` / `admin/sendingDomains.test.ts` source scans ("does not import providerRegistry or any adapter"); `getEmailDomainProvider` is imported only by `domainSync.ts` and `sendingDomainsWorker.ts` |
| §2 — one partner-lane account per instance; drift reported, never auto-repaired | 4 | `runDailyMaintenance` alerts and asserts `deleteDomain` was not called |
| §4.3 — `409 domain_unavailable`, one message for both causes, no information about who holds it | 6 | "gives BOTH conflict causes the identical non-revealing message" |
| §4.3 — creates rate-limited 5/day/partner | 6 | "enforces 5 creates a day per partner" (key, limit and window asserted) |
| §4.3 — failed rows auto-removed 72 h after the failure | 3 | "moves a failed row past the 72h window to removing/failed_expired" + the inside-window negative |
| §4.4 — local-part shape, reserved names, display-name spoof, From is always `local_part@domain` | 6 | "refuses the reserved local parts", "refuses a display name that looks like another address" |
| §5.1 — find-then-create four-case classification; `provision_attempted_at` committed before the provider call | 3 | "commits provision_attempted_at BEFORE calling the provider" + the four case tests + the ambiguous case |
| §5.1 — adopted already-verified domain is verified at once | 3 | "an adopted already-verified domain is verified at once" |
| §5.1 — `static` waits in `pending` for its test send; acceptance verifies it | 3, 4 | "a static row waits in pending"; `runTestSend` enqueues a sync for a `pending` non-DNS row |
| §5.1 — send-only key degrades the capability instead of failing every request | 4, 6 | "records send_only on a permission error"; "is unsupported with provider_key_send_only" |
| §5.2 — status mapping, unknown state never sends | 3 | `mapProviderState` + "maps the provider state, advances the cadence" |
| §6.1 `sync-domain` — every transition, `jobId = domainId` | 3, 4 | the 21-case state-machine block; "collapses duplicate sync jobs" |
| §6.1 — `check_requested_at` → `requestVerification` only when `verifiesByDns` | 3 | "honours a Check now … but only when the adapter verifies by DNS" |
| §6.1 — `removing` → `deleteDomain` only when `provider_managed`, then null, then delete | 3, 10 | "removing a MANAGED domain … in that order"; the real-Postgres guard case |
| §6.1 — `suspended` makes no provider calls | 3 | "suspended makes no provider call at all" |
| §6.1 `sweep` — due rows, `LIMIT 25`, `FOR UPDATE SKIP LOCKED`, outbox drain, ops alert past 10 attempts | 4, 10 | the sweep block; the real-Postgres claim case |
| §6.1 `test-send` — direct adapter send, From from the support identity else `test`, To the caller | 4, 7 | `runTestSend`; "enqueues the job with the CALLING user, never a typed address" |
| §6.1 — `static` re-checked on worker start and daily | 4 | "also enqueues one un-repeated daily-maintenance at boot"; "re-checks every live static row" |
| §6.2 — cadence, per-row jitter on the 24 h interval | 1 | the eight cadence cases, incl. "spreads verified rows rather than stacking them" |
| §6.3 — every status change writes an audit entry and mails the adder plus partner admins | 2, 3 | "emails the adder plus every active Partner Admin"; "emails and audits only on a CHANGE of status" |
| §6.4 — drift report hosted-only, never deletes | 4 | "runs the drift report on HOSTED only"; "alerts … and deletes nothing" |
| §7 — the seven partner routes, their verbs and status codes | 7 | the `routes` block (one case per route) |
| §7 — reads `requireScope('partner')` + `requirePartner`; writes add `requireOrgWrite`, `requireMfa()`, `requireCapability('custom_sending_domain')` | 7 | "gate registration" + the four authz-matrix cases |
| §7 — `404 sending_domains_unsupported` when no provider | 7 | "404s every route with sending_domains_unsupported" (all seven paths) |
| §7 — `writeRouteAudit` on every write | 7, 8 | each write case asserts the audit call; the error cases assert it is *not* written |
| §7 — platform admin list / suspend / unsuspend / force-release under `platformAdminMiddleware` + `requireMfa()` | 8, 9 | `admin/sendingDomains.test.ts`; "the admin hub serves /admin/sending-domains under platformAdminMiddleware" |
| §9.1 — kill switch takes effect on the next send | 6 | "suspend sets suspended/platform_suspended"; resolution reads the row (W04 consumes it) |
| §9.1 — `EMAIL_DOMAINS_MAX_PER_PARTNER` cap | 6 | "enforces the per-partner cap" |
| §9.1 — dark-launch allowlist gates eligibility | 6 | "is ineligible when an allowlist is set and the partner is not on it" |
| §9.1 — eligibility via the trust capability, evaluated without side effects | 6 | "is ineligible with a reason when the side-effect-free trust evaluator denies"; "never writes a denial audit row" |
| §9.1 — audit on every mutation and every status transition | 3, 7, 8 | `commitTransition`'s audit write; every route write case |
| §13 — provider down during provisioning: row stays `provisioning`, job retries | 3, 4 | the job's `attempts: 5` exponential backoff; `provision` only transitions on a definitive answer |
| §13 — provider refuses: `failed` with the reason | 3 | "a provider refusal fails the row with its reason" |
| §13 — crash between provider create and the local update | 3 | "case 3 — found but created AFTER our attempt" |
| §13 — DNS removed after verification → `at_risk`, partner notified | 3 | "verified -> at_risk notifies once and keeps verified_at sticky" |
| §13 — provider delete fails: row stays `removing`, outbox backs off, ops alert after 10 | 3, 4 | "a provider delete failure leaves the row in removing"; "backs an outbox row off"; "raises an ops alert … past ten attempts" |
| §13 — partner suspended/restricted → resolution falls back; admin can force-release | 6 | `forceReleaseSendingDomain` cases (managed and unmanaged) |
| §13 — self-hosted removes a pre-existing domain: local row only | 3, 6, 10 | "removal of an UNMANAGED domain drops the local row only"; the unmanaged force-release case; the real-Postgres unmanaged case |
| §13 — operator delists a `static` domain → `failed`/`provider_rejected` on the next boot | 3, 4 | `poll` maps a `static` `getDomain` failure; "re-checks every live static row" |
| §14 — "never delete what we did not create" across removal, partner release and failed-row expiry | 3, 10 | three dedicated cases plus the real-Postgres one |
| §14 — state machine: every transition, idempotent re-runs, crash recovery, cadence, failed-row expiry | 1, 3 | the cadence block and the state-machine block |
| Index amendment 5 — `staff.sending_domain_status` added here **with its send site** | 2 | "is a PLATFORM purpose"; `statusMail.ts` is the send site W01's registry property test requires |
| Epic #2135 — a partner-wide write consults `canManagePartnerWidePolicies` | 7 | "403s EVERY write for a partner user without full partner access"; the source-scan case |
| `ALLOWED_WITHOUT_CAPABILITY_CHECK` registration for both mutating service files | 3, 6 | `partner-wide-write-coverage.test.ts` runs in each task's green step and in verification |
| W02 amendment 4 — `createDomain` carries `partnerSlug` | 3 | "passes the partner SLUG to createDomain" |
| W02 amendment 5 — `static` `getDomain` keys on the domain name; `pending` is no change; only a test send verifies | 3, 4 | "does NOT demote a verified static row"; "keys a static getDomain on the DOMAIN NAME"; "DOES fail a static row the operator delisted"; the `markStaticDomainVerified` block; "an accepted static test send verifies the row THERE" |
| W02's typed provider errors drive `status_reason` | 3 | the `ProviderDomainConflictError` / `ProviderDomainRejectedError` `it.each`, plus the unclassified fallback |
| W02's DTO field sets and ISO-8601 strings are honoured exactly (incl. `statusChangedAt`, `domain`, `fromAddress`) | 6 | "fills every SendingDomainDto field, including statusChangedAt"; "joins each identity to its domain and computes fromAddress" |
| `email_provider_domain_releases.reason` stays inside its CHECK | 6 | "force-release of a MANAGED domain writes the outbox row" asserts `reason: 'force_release'` |
| `last_test_status` stays inside its CHECK (`pending`/`sent`/`failed`) | 4 | the test-send block asserts `lastTestStatus: 'sent'` and `'failed'` |
