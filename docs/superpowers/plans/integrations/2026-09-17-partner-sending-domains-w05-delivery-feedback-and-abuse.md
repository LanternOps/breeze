---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner Sending Domains W05: Delivery Feedback and Abuse Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Plan amendments

Deviations from the spec, the plan index or an upstream plan. Every one was
forced by the real code and verified by reading the file cited on 2026-09-17.

1. **`sent` is counted from the `email.sent` webhook event, never by the send
   path.** Spec §9.3 lists `sent` as a column but names only `email.bounced`,
   `email.complained`, `email.delivered`, `email.failed`, `email.suppressed`
   and `domain.updated` as handled events, which leaves `sent` with no writer.
   The installed SDK settles it: `resend@6.18.0`'s `WebhookEvent` union
   (`node_modules/resend/dist/index.d.mts:2143`) **does** include `'email.sent'`,
   and its payload is the same `BaseEmailEventData` that carries
   `tags?: Record<string, string>` (`:2144-2153`). So W05 subscribes to
   `email.sent` and increments `sent` from it. The alternative — incrementing at
   send time in W03's `sendOnPartnerLane` — is forbidden: "the send path never
   WRITES a partner-axis table" is a verbatim W03 Global Constraint, and
   `partner_sending_daily_stats` is partner-axis, so that write would also red
   the required **Test API** job through `ALLOWED_WITHOUT_CAPABILITY_CHECK`.
   Because a self-hoster may configure the endpoint without subscribing
   `email.sent`, every rate in this wave uses
   `messages = GREATEST(sent, delivered + bounced + failed)` as the denominator,
   which is correct whether or not `email.sent` is subscribed and never divides
   by a number smaller than the events actually observed.
2. **`partner_sending_daily_stats` gets NO `domain_id` dimension.** Spec §9.3
   defines both the table and its thresholds per partner ("a partner whose
   7-day bounce rate…", "has every domain set to `suspended`"), and the kill
   switch is partner-wide, so nothing in this wave would read a per-domain
   breakdown. Adding the dimension would triple the row count, force every
   consumer to aggregate, and make the PK `(partner_id, day, domain_id)` — while
   `domain_id` cannot be a real FK, because an event can arrive after the local
   row was removed, so it would be a nullable text column nothing joins on.
   Per-domain deliverability, if it is ever wanted, is an additive second table
   or an additive nullable column with a new PK — a new migration, not a
   retrofit of this one's consumers. Recorded because spec §9.3's column list
   is explicit and the omission should read as a decision, not an oversight.
3. **Neither `svix` nor a Resend `webhooks.verify` helper exists — the scheme is
   implemented by hand.** `svix` has zero hits in the repo (no `package.json`
   entry, no import), and `resend@6.18.0`'s `Resend` class exposes
   `readonly webhooks: Webhooks` (`index.d.mts:2425`) whose surface is webhook
   **CRUD** (`CreateWebhookOptions`, `GetWebhookResponse`, `ListWebhooksOptions`,
   `UpdateWebhookOptions`, `RemoveWebhookResponse`) — there is no `verify`
   anywhere in the file. Task 6 therefore implements the documented Svix scheme
   directly: base64 HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`
   with the base64 body of a `whsec_`-prefixed secret, a 5-minute timestamp
   tolerance, and a constant-time compare against **each** space-separated
   `v1,<sig>` entry of `svix-signature` (Svix sends more than one during secret
   rotation). No new dependency is added.
4. **`suspendSendingDomain` does not write an audit row or a status mail, so
   W05 widens it and adds both.** The index and the task brief assume the admin
   suspend path already carries them. It does not: W02b's
   `suspendSendingDomain(domainId)` calls `setAdminStatus`, which patches the
   row and calls `enqueueSyncDomain` — the audit comes from the admin
   *route*'s `writeRouteAudit`, and `syncSendingDomain` on an already-`suspended`
   row returns `'suspended_noop'` after touching `nextCheckAt` only, so
   `commitTransition` (the thing that mails) never runs. W05 therefore:
   (a) widens the signature to
   `suspendSendingDomain(domainId, statusReason: 'platform_suspended' | 'abuse_auto' = 'platform_suspended')`,
   which is source-compatible with W02b's admin route and its test, and
   (b) puts the system audit row and the `sendSendingDomainStatusEmail` call in
   `autoSuspend.ts`, which already holds the `partnerId`, `domain` and
   `createdBy` those two need and which is the only caller with no human actor.
   The admin route keeps its own `writeRouteAudit`; no double audit row.
5. **The stats upsert is raw SQL and therefore gets NO
   `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry.** `partnerSendingDailyStats` joins
   the partner-axis set automatically (`partnerAxisTableNames()`,
   `partner-wide-write-coverage.test.ts:313-330`: any Drizzle table with
   `partnerId` and no `notNull` `orgId`), but the scanner's pattern is
   `\.(insert|update|delete)\(\s*<table>\s*[,)]`
   (`mutatedTables()`, `:349-353`) and the write in `deliveryStats.ts` is a
   single `db.execute(sql\`INSERT … SELECT … ON CONFLICT DO UPDATE\`)`. The
   statement form is not a workaround, it is required: the insert's row source
   is `SELECT p.id FROM partners p WHERE p.id = $1`, so an event tagged with an
   unknown partner inserts **zero rows** instead of raising 23503 — and a caught
   23503 inside a request transaction aborts that transaction even when handled
   (`utils/pgErrors.ts:42-57`, prod incident 2026-09-15). Adding an allowlist
   entry anyway would red `it('the allowlist has no stale entries')`
   (`partner-wide-write-coverage.test.ts:354`), because the grep finds no match.
   Recorded here so a reviewer reads the absent entry as deliberate. The gate on
   that write is the Svix signature, and the partner id never comes from a
   request body — only from a provider tag that is existence-checked against
   `partners` in the same statement.
6. **`recordPartnerLaneCapHit` records into a Redis day-hash, not a table.**
   W03 exports it as `recordPartnerLaneCapHit(partnerId: string): void` —
   **synchronous, returning void**, called from `tryCountPartnerLaneSend` on the
   send path. It therefore cannot await a database write, and the send path is
   forbidden from writing a partner-axis table anyway (amendment 1). W05 makes
   it additionally fire-and-forget `HINCRBY email-domains:cap-hits:<YYYY-MM-DD>
   <partnerId> 1` with an 8-day `EXPIRE`, keyed by **day** rather than by
   partner so the abuse producer reads the whole fleet's window with 7 bounded
   `HGETALL` calls and never needs `SCAN` or a partner enumeration. Losing a
   record to a Redis outage is acceptable and correct: W03 already refuses to
   fabricate a cap-hit signal when Redis cannot answer.
7. **The route needs its own isolated global-rate-limit bucket.**
   `middleware/globalRateLimit.ts:18` skips only `/health` and `/ready`, and its
   skip prefixes (`:24`) are `/api/v1/agents/` and `/api/v1/helper/` — nothing
   under `/api/v1/webhooks/`. With the shared 300 req/min per-IP budget, a busy
   partner lane's delivery events would throttle dashboard traffic from the same
   egress IP (and vice versa). Task 8 adds
   `{ prefix: '/api/v1/webhooks/email-provider/', name: 'emaildomainswebhook', limit: 1200 }`
   to `ISOLATED_BUCKETS` (`:63-81`), the same remedy `/api/v1/desktop-ws/` and
   `/api/v1/backup/bmr/recover/download` already carry.
8. **There is no `PUBLIC_ROUTES` array and no CSRF middleware.** Public-ness in
   this API is structural (the router is mounted where no auth middleware covers
   it), and the only contract test is
   `apps/api/src/__tests__/routerAuthGate.contract.test.ts`, whose `EXEMPT` map
   (`:16-49`) is keyed by the **router expression string** used in `index.ts`,
   not by the mount path. Task 8 adds one `resendWebhookRoutes` entry there.
   CSRF is a per-handler double-submit check invoked explicitly inside
   authenticated routes (`routes/auth/schemas.ts:260`), never global — a webhook
   has nothing to exempt. `SELF_MANAGED_DB_CONTEXT_ROUTES` likewise does not
   apply: `index.ts:918-920` states in a comment that webhooks do not belong
   there because there is no ambient auth transaction to opt out of.
9. **A platform-admin web UI DOES exist for the trust/abuse admin routes, but
   only for trust.** `apps/web/src/pages/admin/trust-queue.astro` mounts
   `apps/web/src/components/admin/TrustQueue.tsx`, which consumes
   `routes/admin/trust.ts`. There is **no** page consuming `routes/admin/abuse.ts`
   (`grep -rln "admin/abuse" apps/web/src` → nothing). W05 therefore ships a new
   unlisted admin page, `apps/web/src/pages/admin/sending-domains.astro` +
   `apps/web/src/components/admin/SendingDomainsAdmin.tsx`, built in the
   `TrustQueue.tsx` idiom (`fetchWithAuth` for reads, `runAction` for mutations,
   `data-testid` on every interactive element, an unauthorized state) rather
   than bolting a second resource onto the trust queue. Task 13 is that mount
   task. Neither page appears in any navigation file — `trust-queue` has zero
   hits outside its own `titles.adminTrustQueue` i18n key, so the new page
   follows the same shape and adds its own key to all eight locales.
10. **The abuse sweep has no producer registry and no `sweep.ts`.** Spec §9.2
    says the producer is "wired into `runAbuseSweep`". The real wiring is
    hand-written in `apps/api/src/services/abuseSignals/index.ts` (the file
    `sweep.test.ts` imports) at five edit points: the import block (`:5-14`), the
    destructure and loader object inside `runSystemDbCompute` (`:53-67`), the
    `computed` spread array (`:69-90`), the `evaluatedPartnerIds` set (`:103-109`)
    and — for a detector with its own corpus — an ordering call before the
    returns. There is no `ComputedSignal` producer interface: producers are a
    fleet-wide async **loader** that imports `db` directly and returns
    `{ …rows, scannedPartnerIds }`, plus a **pure sync scorer**
    `(rows, cfg) => ComputedSignal[]`. Task 10 follows that split exactly.
11. **A new signal key needs two TypeScript registrations and one test-list
    entry, but no migration.** `partner_abuse_signals.signal_key` is a plain
    `varchar(64)` with no CHECK and no enum
    (`migrations/2026-07-13-partner-abuse-signals.sql:14`), so nothing in the
    database rejects an unregistered key — the failure mode is silent
    mis-scoring. The real registries are `SIGNAL_AXIS`
    (`services/abuseSignals/corroboration.ts:48`), `CORROBORATION_INELIGIBLE`
    (`:95`) and the hand-maintained `EMITTED_KEYS` list in
    `corroboration.test.ts:333-352`, whose assertion cannot see a key that is
    not in it. Task 10 edits all three. Keys must be ≤ 64 characters, and only
    `severity === 'watch'` signals corroborate
    (`computeCorroborationSignals`, `corroboration.ts:114-137`).

---

**Goal:** Close the hosted general-availability gate (spec §15 row W05,
§16.1 step 4). A signature-verified public webhook turns Resend delivery events
into a partner-axis daily-stats table; a 7-day bounce/complaint evaluation
suspends every domain of an offending partner through W02b's kill switch and
raises one ops alert; four new abuse signals and an evidence-card entry give the
human reviewer the sending-domain picture; and the platform-admin list gains
7-day volume, bounce rate and complaint count with a suspend / unsuspend /
force-release UI. Nothing in this wave is a functional dependency of W01–W04:
with `EMAIL_DOMAINS_WEBHOOK_SECRET` unset the endpoint answers `404` and does no
work, with the auto-suspend thresholds unset on a self-hosted instance the
evaluator is off, the stats table simply stays empty, and `static` mode produces
no provider events at all.

**Architecture:** One migration adds `partner_sending_daily_stats`, RLS shape 3
(partner-axis), PK `(partner_id, day)`, using the same
`breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)`
policy idiom W02a's Task 1 shipped. The public route
`POST /api/v1/webhooks/email-provider/resend` copies `routes/webhooks/stripe.ts`
verbatim in shape: per-IP limiter first (fails closed → 429 → provider retries),
raw body via `await c.req.text()` before anything can consume it, then signature,
then a Redis `SET … NX` reservation on `svix-id` so an at-least-once redelivery
cannot double-count, then one atomic
`INSERT … SELECT FROM partners … ON CONFLICT DO UPDATE SET <col> = <col> + 1`
inside a short `withSystemDbAccessContext`. The route never calls the provider:
`domain.updated` only enqueues `sync-domain`, and a bounce or complaint only
enqueues `evaluate-auto-suspend { partnerId }` with `jobId` =
`autosuspend:<partnerId>` so a burst collapses into one evaluation. The evaluator runs in the existing
`sending-domains` worker, reuses `suspendSendingDomain` for the kill-switch
semantics, and is a no-op for a partner whose domains are already suspended.
Unsuspend stays manual.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle ORM, Hono
(public route, no auth middleware), Node `crypto` (`createHmac`,
`timingSafeEqual`) for the Svix scheme, ioredis (dedupe + cap-hit hash) via
`services/redis.ts`, BullMQ (`sending-domains` queue), Vitest (unit +
integration on real Postgres), React + Astro for the admin page.

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md`
§0.2 (Resend webhook event list), §9.2 (abuse signals), §9.3 (delivery feedback,
automatic suspension, admin metrics), §11 (`EMAIL_DOMAINS_WEBHOOK_SECRET`),
§13 (error handling), §14 (testing), §15 row W05, §16.1 steps 4–5.
Plan index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md`
— the "Defined in W05" block (`partner_sending_daily_stats`,
`partnerSendingDailyStats`, `POST /webhooks/email-provider/resend`,
`services/emailDomains/autoSuspend.ts` → `evaluateAutoSuspension`) is binding.

## Assumed from W03

W03's plan document exists and was read; every row below is **verified against
it** unless marked otherwise.

| Name | Source | Status |
|---|---|---|
| Provider tags on every partner-lane message are exactly `partner_id`, `domain_id`, `stream`, `purpose` | W03 Task 4, the `provider.send({ … tags: { … } })` block | verified |
| Tag values are sanitised by the `resend` adapter with `value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256)` (W02a Task 7), so a UUID survives intact and a `purpose` like `ticket.customer_notification` arrives as `ticket_customer_notification` | W02a Task 7 `sanitizeTagValue` | verified — W05 never parses `purpose`, only `partner_id` |
| `recordPartnerLaneCapHit(partnerId: string): void` lives in `apps/api/src/services/emailDomains/sendCap.ts`, is **synchronous**, currently only `console.warn`s, and is called **only** on a genuine over-cap count — never on a Redis outage | W03 Task 1 + its amendments 3 and 4 | verified |
| `partnerLaneCapKey(partnerId, now)` returns `email-domains:partner-lane-sends:<partnerId>:<YYYY-MM-DD>` (UTC day) — W05's cap-hit key mirrors that namespace | W03 Task 1 | verified |
| W03 adds **no** `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry, because the send path only SELECTs | W03 Global Constraints | verified |
| `sendOnPartnerLane` is the only caller of `provider.send`, and a fallback message carries neither `X-Breeze-Outbound` nor any partner tag — so a platform-lane fallback produces no webhook event attributable to a partner | W03 Task 4 | verified |

## Consumed from W02a / W02b

Read from their finished plans; binding.

```ts
// apps/api/src/services/emailDomains/config.ts  (W02a Task 5)
export interface EmailDomainsConfig {
  provider: 'resend' | 'static' | 'fake' | null;
  resendApiKey: string | null; resendSendingKey: string | null;
  region: string; maxPerPartner: number; dailySendCap: number;
  partnerAllowlist: string[]; denylist: string[];
  staticAllowed: StaticAllowedEntry[];
  webhookSecret: string | null;          // EMAIL_DOMAINS_WEBHOOK_SECRET — already declared
}
export function getEmailDomainsConfig(): EmailDomainsConfig;
export function isPartnerLaneConfigured(): boolean;

// apps/api/src/services/emailDomains/sendingDomainService.ts  (W02b Task 6)
export class SendingDomainServiceError extends Error {
  readonly code: SendingDomainErrorCode; readonly status: 400 | 404 | 409 | 429;
}
export async function suspendSendingDomain(domainId: string): Promise<void>;   // W05 widens — amendment 4
export async function unsuspendSendingDomain(domainId: string): Promise<void>;
export async function forceReleaseSendingDomain(domainId: string): Promise<void>;
export async function listAllSendingDomains(opts: { limit: number }): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string }>>;

// apps/api/src/services/emailDomains/statusMail.ts  (W02b Task 2)
export type SendingDomainStatusEvent = 'verified' | 'at_risk' | 'failed' | 'suspended' | 'auto_removed';
export interface SendingDomainStatusMailInput {
  partnerId: string; domain: string; event: SendingDomainStatusEvent;
  statusReason?: string | null; createdBy?: string | null; appUrl?: string | null;
}
export async function sendSendingDomainStatusEmail(input: SendingDomainStatusMailInput): Promise<number>;

// apps/api/src/jobs/sendingDomainsWorker.ts  (W02b Task 4)
export const SENDING_DOMAINS_QUEUE = 'sending-domains';
export async function enqueueSyncDomain(domainId: string, opts?: { lastSendError?: string }): Promise<void>;
export async function enqueueTestSend(domainId: string, userId: string): Promise<void>;
// in-file constants: SYNC_JOB='sync-domain', SWEEP_JOB='sweep',
// TEST_SEND_JOB='test-send', DAILY_JOB='daily-maintenance'; getQueue();
// type SendingDomainsJobData; createSendingDomainsWorker()'s switch (job.name).

// apps/api/src/db/schema/emailSendingDomains.ts  (W02a Task 1)
//   partnerSendingDomains: id partnerId domain provider providerDomainId providerManaged
//     provisionAttemptedAt providerRegion status statusReason dnsRecords checkRequestedAt
//     lastCheckedAt nextCheckAt checkAttempts verifiedAt statusChangedAt lastTestAt
//     lastTestStatus lastTestError lastSendError lastSendErrorAt createdBy createdAt updatedAt
```

---

## Global Constraints

Binding for every task. Do not relax any of them without changing the plan index
in the same PR.

- **Migration name `apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql`.**
  Before committing, run `ls apps/api/migrations/*.sql | sort | tail -1`. If the
  newest committed migration sorts at or after `2026-10-20-100100`, rename this
  file upward so it sorts last, and update every reference to it in this plan's
  steps. W02a holds `2026-10-20-100000`; newest on `origin/main` when this plan
  was written was `2026-10-17-140000-snmp-metrics-instance-width.sql`.
- **The migration is idempotent and has no inner `BEGIN`/`COMMIT`.**
  `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `pg_policies`
  existence guards. `autoMigrate` wraps each file in one transaction.
- **It is DDL only — no `set_config('breeze.scope', 'system', true)` is needed
  or permitted.** `apps/api/src/db/migrationRlsScope.test.ts` requires the
  elevation only for files that `INSERT`/`UPDATE`/`DELETE`/`MERGE`. This
  migration writes no rows. **Never add this file to that test's frozen
  baseline.**
- **RLS lives in the creating migration.** Enable + force + the partner-axis
  policy + `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app` in the same
  file. The DELETE grant is load-bearing: `cascadeDeletePartner` issues hard
  `DELETE`s as `breeze_app` under a system RLS context.
- **The webhook is inert without the secret.** With
  `EMAIL_DOMAINS_WEBHOOK_SECRET` unset the handler returns `404` before reading
  the body, before touching Redis and before touching the database. Not 401, not
  503: on a self-hosted instance that never configured the feature the endpoint
  does not exist, and a 5xx would make a misdirected caller retry forever.
- **No new env var is ever required by an upgrade.** The three auto-suspend
  variables are plain optional strings in the zod schema; there is no `requireIf`
  on any of them. Unset on self-hosted means the evaluator is off; unset on
  hosted means the spec §9.3 defaults (0.08 / 50 / 3).
- **Self-hosted defaults are off.** `evaluateAutoSuspension` returns
  `'disabled'` immediately when `!isHosted()` and none of the three thresholds is
  explicitly set. A self-hoster's bounce rate is their own business, and silently
  suspending their only sending domain would be a bug report, not a protection.
- **The send path never writes a table.** `sent` comes from the `email.sent`
  provider event (amendment 1); `recordPartnerLaneCapHit` writes Redis only
  (amendment 6). `partner-wide-write-coverage.test.ts` scans `src/routes/**` and
  `src/services/**` (`collectSourceFiles()`, `:326-343`) and **not** `src/jobs/**`
  — verified by reading the two `walk()` calls.
- **The route never calls the provider.** Everything outbound is an enqueue onto
  the `sending-domains` queue; the worker owns every provider call (spec §2).
  Task 8 adds a source-scan test asserting the route file imports neither
  `providerRegistry` nor any adapter, in static and dynamic import form.
- **Public-route DB work runs inside a DB context, in system scope.** The route
  has no ambient auth transaction, so every read and write is wrapped in
  `withSystemDbAccessContext`. `runOutsideDbContext` is **not** used: it does not
  close an outer transaction (it only silences the #1105 tripwire), and there is
  no outer transaction here to close. A live-database test is mandatory — a
  mocked DB cannot see a contextless read return zero rows under forced RLS.
- **Rigor is high** (public unauthenticated surface, tenancy, abuse controls,
  kill switch). Red first on every task: write the failing assertion, run it,
  watch it fail for the stated reason, then implement. Before the PR:
  `pnpm test-stack up`, the RLS and integration contract suites of Task 14, then
  `pnpm test-stack down` — nothing reaps it for you.
- **Test command form:** `cd apps/api && npx vitest run <path>` (never
  `pnpm --filter <pkg> test -- --run <path>`: pnpm forwards the literal `--`,
  vitest swallows `--run`, and the whole suite runs in watch mode). Vitest's path
  filter is a plain substring, so list sibling files explicitly and check the
  reported file count. `apps/web` uses `cd apps/web && npx vitest run <path>`.
- **Branch `feature/__PARENT__-partner-sending-domains/wave-__W05__`; PR body
  contains `Closes #__W05__`.** `get_feature_status` before starting.
- **Commit after every task** with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql` | table, PK, index, RLS, grant | 1 |
| `apps/api/src/db/schema/emailSendingDomains.ts` | Drizzle `partnerSendingDailyStats` | 1 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` entry | 1 |
| `apps/api/src/services/emailDomains/deliveryStats.ts` (+ `.test.ts`) | atomic upsert-increment, 7-day rollups | 2 |
| `apps/api/src/config/validate.ts`, `validate.test.ts`, `envComposeParity.test.ts` | three `EMAIL_DOMAINS_AUTOSUSPEND_*` keys | 3 |
| `apps/api/src/services/emailDomains/config.ts` (+ `.test.ts`) | `autoSuspend` block on `EmailDomainsConfig` | 3 |
| `.env.example`, `deploy/.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | documentation + compose mapping | 3 |
| `apps/api/src/services/emailDomains/autoSuspend.ts` (+ `.test.ts`) | `evaluateAutoSuspension` | 4 |
| `apps/api/src/services/emailDomains/sendingDomainService.ts` | `suspendSendingDomain` reason parameter | 4 |
| `apps/api/src/routes/admin/sendingDomains.test.ts` | the widened call still compiles | 4 |
| `apps/api/src/jobs/sendingDomainsWorker.ts` (+ `.test.ts`) | `evaluate-auto-suspend` job + `enqueueAutoSuspendEvaluation` | 5 |
| `apps/api/src/services/emailDomains/webhookSignature.ts` (+ `.test.ts`) | Svix verification | 6 |
| `apps/api/src/routes/webhooks/emailProvider.ts` (+ `.test.ts`) | the public handler | 7 |
| `apps/api/src/index.ts`, `middleware/globalRateLimit.ts`, `__tests__/routerAuthGate.contract.test.ts`, `routes/webhooks.mountOrder.test.ts` | mount + public-route contract + isolated bucket | 8 |
| `apps/api/src/services/emailDomains/sendCap.ts` (+ `.test.ts`), `capHits.ts` (+ `.test.ts`) | cap-hit day-hash recorder and reader | 9 |
| `apps/api/src/services/abuseSignals/sendingDomains.ts` (+ `.test.ts`), `index.ts`, `config.ts`, `corroboration.ts`, `corroboration.test.ts`, `sweep.test.ts` | the producer and its five wiring points | 10 |
| `apps/api/src/services/partnerTrustEvidenceCard.ts` (+ `.test.ts`), `apps/web/src/components/admin/TrustQueue.tsx` (+ `.test.tsx`), `TrustActionPage.tsx` | `sendingDomains` on the evidence card | 11 |
| `apps/api/src/services/emailDomains/sendingDomainService.ts` (+ `.test.ts`), `apps/api/src/routes/admin/sendingDomains.ts` (+ `.test.ts`) | admin 7-day metrics, one grouped query | 12 |
| `apps/web/src/pages/admin/sending-domains.astro`, `apps/web/src/components/admin/SendingDomainsAdmin.tsx` (+ `.test.tsx`), `apps/web/src/locales/*/pages.json` | admin UI mount | 13 |
| `apps/api/src/__tests__/integration/partnerSendingDailyStats.integration.test.ts` | live-Postgres RLS, concurrency, end-to-end webhook | 14 |

---

## Task 1: Migration, Drizzle model and the RLS registration

**Files:**
- Create: `apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql`
- Modify: `apps/api/src/db/schema/emailSendingDomains.ts` (append below the
  `emailProviderDomainReleases` table and above the three `$inferSelect` type
  aliases at the end of the file; created by W02a Task 1)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
  (`PARTNER_TENANT_TABLES`, immediately after the
  `['partner_sender_identities', 'partner_id'],` entry W02a Task 2 added)

**Interfaces:**
- Consumes: `partners` (`db/schema/orgs.ts`), `public.breeze_current_scope()`,
  `public.breeze_has_partner_access(uuid)`.
- Produces: table `partner_sending_daily_stats`; Drizzle export
  `partnerSendingDailyStats` and type alias `PartnerSendingDailyStat`.

- [ ] **Step 1: Confirm the migration slot**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
ls apps/api/migrations/*.sql | sort | tail -1
```
Expected: a name sorting **before** `2026-10-20-100100-partner-sending-daily-stats.sql`
(W02a's `2026-10-20-100000-partner-sending-domains.sql` is the expected answer
once W02a has merged). If not, rename this file upward — e.g.
`2026-10-22-100100-partner-sending-daily-stats.sql` — and use the new name in
every step below.

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql`:

```sql
-- Partner sending daily stats (spec 2026-09-17-partner-sending-domains-design
-- §9.3). W05 of the partner-sending-domains feature.
--
-- TENANCY: RLS shape 3 (partner-axis), exactly the idiom
-- 2026-10-20-100000-partner-sending-domains.sql shipped for
-- partner_sending_domains: one FOR ALL TO breeze_app policy,
-- breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id),
-- on both USING and WITH CHECK. Deliberately NO org_id and NO device_id, so the
-- only registration is PARTNER_TENANT_TABLES — no CORE_ORG_CASCADE_DELETE_ORDER,
-- no device lists, no CORE_TENANT_EXPORT_POLICY, no org-merge registry.
-- cascadeDeletePartner discovers this table by its partner_id column and its
-- topological order puts it before `partners`, so no registration is needed
-- there either.
--
-- NO domain_id dimension, on purpose: spec §9.3's thresholds and the kill
-- switch are both per PARTNER, an event can arrive after the local domain row
-- was removed (so domain_id could not be a real FK), and nothing in this wave
-- reads a per-domain breakdown. Per-domain deliverability is an additive second
-- table, not a retrofit of this one.
--
-- The partner FK deliberately carries NO ON DELETE CASCADE, matching the two
-- W02a partner tables: the partner sweep deletes these rows explicitly.
--
-- Counters are bigint: a hosted partner-lane account carries every partner's
-- mail, and an integer counter would be a latent overflow on a busy day.
--
-- DDL only: no rows written, so no breeze.scope election
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS partner_sending_daily_stats (
  partner_id  uuid NOT NULL REFERENCES partners(id),
  -- UTC calendar day the provider event was received on.
  day         date NOT NULL,
  -- Incremented from the `email.sent` provider event, NEVER by the send path:
  -- the send path is forbidden from writing a partner-axis table.
  sent        bigint NOT NULL DEFAULT 0,
  delivered   bigint NOT NULL DEFAULT 0,
  bounced     bigint NOT NULL DEFAULT 0,
  complained  bigint NOT NULL DEFAULT 0,
  failed      bigint NOT NULL DEFAULT 0,
  suppressed  bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sending_daily_stats_pk PRIMARY KEY (partner_id, day),
  CONSTRAINT partner_sending_daily_stats_nonneg_chk CHECK (
    sent >= 0 AND delivered >= 0 AND bounced >= 0
    AND complained >= 0 AND failed >= 0 AND suppressed >= 0
  )
);

-- The PK already indexes (partner_id) as a prefix, which serves every
-- per-partner window read. This index serves the CROSS-partner admin rollup
-- and the abuse sweep, both of which scan one 7-day window over every partner.
CREATE INDEX IF NOT EXISTS partner_sending_daily_stats_day_idx
  ON partner_sending_daily_stats (day);

ALTER TABLE partner_sending_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sending_daily_stats FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sending_daily_stats'
      AND policyname = 'partner_sending_daily_stats_partner_access'
  ) THEN
    CREATE POLICY partner_sending_daily_stats_partner_access ON partner_sending_daily_stats
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sending_daily_stats TO breeze_app;
```

- [ ] **Step 3: Add the Drizzle model**

In `apps/api/src/db/schema/emailSendingDomains.ts`, extend the import at the top
of the file to include `bigint`, `date` and `primaryKey`:

```ts
import { pgTable, uuid, text, varchar, boolean, integer, bigint, date, timestamp, jsonb, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core';
```

Then append, immediately **after** the `emailProviderDomainReleases` table
definition and **before** the `export type PartnerSendingDomain = …` line:

```ts
/**
 * Per-partner, per-UTC-day delivery counters (spec §9.3). Partner-axis (RLS
 * shape 3), registered in PARTNER_TENANT_TABLES only.
 *
 * Every counter is written by the delivery webhook from a provider event, never
 * by the send path — W03 forbids the send path from writing a partner-axis
 * table, and `sent` therefore comes from Resend's `email.sent` event rather than
 * from sendOnPartnerLane.
 *
 * NO domain_id dimension: the spec's thresholds and the kill switch are
 * per-partner, and an event can outlive the local domain row.
 */
export const partnerSendingDailyStats = pgTable('partner_sending_daily_stats', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  day: date('day').notNull(),
  sent: bigint('sent', { mode: 'number' }).notNull().default(0),
  delivered: bigint('delivered', { mode: 'number' }).notNull().default(0),
  bounced: bigint('bounced', { mode: 'number' }).notNull().default(0),
  complained: bigint('complained', { mode: 'number' }).notNull().default(0),
  failed: bigint('failed', { mode: 'number' }).notNull().default(0),
  suppressed: bigint('suppressed', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.day] }),
  index('partner_sending_daily_stats_day_idx').on(t.day)
]);
```

and add one type alias beside the existing three at the end of the file:

```ts
export type PartnerSendingDailyStat = typeof partnerSendingDailyStats.$inferSelect;
```

- [ ] **Step 4: Run the migration guards**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql
scripts/check-migration-naming.sh --staged
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: naming guard PASS; both suites PASS. `migrationRlsScope.test.ts` must
pass **without** adding this file to its baseline — the migration writes no rows.

- [ ] **Step 5: Watch the classification contract fail, then register the table**

Run (needs a live stack: `pnpm test-stack up` from the repo root — leave it up
through Task 14):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts
```
Expected: **FAIL** on `every public base table is classified by exactly one
tenancy bucket`, naming `partner_sending_daily_stats` as unclassified.

Then, in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`,
immediately after the `['partner_sender_identities', 'partner_id'],` entry that
W02a Task 2 added to `PARTNER_TENANT_TABLES`:

```ts
  // partner_sending_daily_stats (spec 2026-09-17 §9.3, partner sending domains
  // W05): per-partner, per-UTC-day delivery counters written by the Resend
  // delivery webhook. Partner-axis (Shape 3) like its two siblings above, and
  // deliberately without a domain_id dimension — the spec's bounce/complaint
  // thresholds and the auto-suspension kill switch are both per PARTNER. No
  // org_id means no cascade / export-policy / org-merge registration;
  // cascadeDeletePartner's dynamic partner_id sweep erases it, and the GRANT
  // includes DELETE for that sweep.
  // Functional cross-partner forge proof: partnerSendingDailyStats.integration.test.ts.
  ['partner_sending_daily_stats', 'partner_id'],
```

- [ ] **Step 6: Run the contract suite green and check drift**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run --config vitest.config.rls-coverage.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm db:check-drift
```
Expected: the RLS-coverage suite PASSES, including the partner-tenant policy
test (the `FOR ALL` policy references `breeze_has_partner_access`, so all four
DML commands are covered) and the FORCE-RLS test. `db:check-drift` reports no
drift.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/migrations/2026-10-20-100100-partner-sending-daily-stats.sql apps/api/src/db/schema/emailSendingDomains.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(db): partner sending daily stats table

Per-partner, per-UTC-day delivery counters (spec §9.3), partner-axis RLS shape 3
with the same policy idiom as partner_sending_domains. PK (partner_id, day); no
domain_id dimension, because the spec's thresholds and the kill switch are both
per partner and an event can outlive the local domain row. Registered in
PARTNER_TENANT_TABLES; no org cascade, device, ticket-move, export-policy or
org-merge registration applies.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: `deliveryStats.ts` — atomic upsert-increment and the 7-day rollups

**Files:**
- Create: `apps/api/src/services/emailDomains/deliveryStats.ts`
- Create: `apps/api/src/services/emailDomains/deliveryStats.test.ts`

**Interfaces:**
- Consumes: `db`, `withSystemDbAccessContext` (`../../db`); `sql` (`drizzle-orm`).
- Produces:
  ```ts
  export type DeliveryStatColumn = 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed';
  export const STATS_WINDOW_DAYS: number;               // 7
  export interface PartnerSendingWindowStats {
    partnerId: string;
    sent: number; delivered: number; bounced: number;
    complained: number; failed: number; suppressed: number;
    /** GREATEST(sent, delivered + bounced + failed) — the rate denominator. */
    messages: number;
    /** bounced / messages, 0 when messages === 0. */
    bounceRate: number;
  }
  /** Returns false when the tag named a partner that does not exist. */
  export async function incrementPartnerSendingStat(
    partnerId: string, column: DeliveryStatColumn, at?: Date,
  ): Promise<boolean>;
  export async function loadPartnerSendingWindowStats(partnerId: string, now?: Date): Promise<PartnerSendingWindowStats>;
  export async function loadAllPartnerSendingWindowStats(now?: Date): Promise<PartnerSendingWindowStats[]>;
  ```
- Callers: the webhook route (Task 7), `autoSuspend.ts` (Task 4), the abuse
  producer (Task 10), the admin metrics (Task 12).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/deliveryStats.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, contextLabels } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  contextLabels: [] as Array<string | undefined>,
}));

vi.mock('../../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: (fn: () => unknown, label?: string) => {
    contextLabels.push(label);
    return fn();
  },
}));

import {
  STATS_WINDOW_DAYS,
  incrementPartnerSendingStat,
  loadAllPartnerSendingWindowStats,
  loadPartnerSendingWindowStats,
} from './deliveryStats';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-17T23:45:00.000Z');

/** The queries return postgres.js-shaped results; the helper unwraps `.rows`. */
function rows(value: unknown[]): { rows: unknown[] } {
  return { rows: value };
}

beforeEach(() => {
  vi.clearAllMocks();
  contextLabels.length = 0;
});

describe('incrementPartnerSendingStat', () => {
  it('runs inside a SYSTEM db context — the webhook has no ambient auth transaction', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    await incrementPartnerSendingStat(PARTNER, 'delivered', AT);
    expect(contextLabels).toEqual(['emailDomainsDeliveryStatIncrement']);
  });

  it('returns true when the statement affected the partner row', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    await expect(incrementPartnerSendingStat(PARTNER, 'bounced', AT)).resolves.toBe(true);
  });

  // The provider tag is attacker-influencable only in the sense that anyone who
  // can forge a signed payload controls it; the statement's row source is a
  // SELECT over `partners`, so an unknown id inserts NOTHING rather than
  // raising 23503 — a caught 23503 would abort the surrounding transaction.
  it('returns false for a partner id that does not exist, without raising', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    await expect(incrementPartnerSendingStat(PARTNER, 'bounced', AT)).resolves.toBe(false);
  });

  it('refuses a column name that is not one of the six counters', async () => {
    await expect(
      incrementPartnerSendingStat(PARTNER, 'drop table' as never, AT),
    ).rejects.toThrow(/unknown delivery stat column/i);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('keys the row on the UTC calendar day, not the local one', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    // 2026-09-17T23:45Z is 2026-09-18 in any timezone east of UTC+1.
    await incrementPartnerSendingStat(PARTNER, 'sent', AT);
    const params = executeMock.mock.calls[0]![0] as { queryChunks?: unknown[] };
    expect(JSON.stringify(params)).toContain('2026-09-17');
  });
});

describe('loadPartnerSendingWindowStats', () => {
  it('uses GREATEST(sent, delivered + bounced + failed) as the denominator', async () => {
    // A self-hoster who did not subscribe email.sent has sent = 0 but real
    // outcome counts; the denominator must still be 100, not 0.
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '0', delivered: '90', bounced: '8', complained: '1', failed: '2', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.messages).toBe(100);
    expect(stats.bounceRate).toBeCloseTo(0.08, 10);
  });

  it('prefers `sent` when it is larger than the outcome sum', async () => {
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '500', delivered: '90', bounced: '8', complained: '1', failed: '2', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.messages).toBe(500);
  });

  it('returns an all-zero row for a partner with no stats at all', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats).toEqual({
      partnerId: PARTNER, sent: 0, delivered: 0, bounced: 0,
      complained: 0, failed: 0, suppressed: 0, messages: 0, bounceRate: 0,
    });
  });

  it('never divides by zero', async () => {
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '0', delivered: '0', bounced: '0', complained: '3', failed: '0', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.bounceRate).toBe(0);
    expect(stats.complained).toBe(3);
  });

  it('spans exactly STATS_WINDOW_DAYS days ending today', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(STATS_WINDOW_DAYS).toBe(7);
    // 2026-09-17 minus 6 days == 2026-09-11 inclusive.
    expect(JSON.stringify(executeMock.mock.calls[0]![0])).toContain('2026-09-11');
  });
});

describe('loadAllPartnerSendingWindowStats', () => {
  it('returns one grouped row per partner in ONE query (no N+1)', async () => {
    executeMock.mockResolvedValueOnce(rows([
      { partner_id: 'p1', sent: '10', delivered: '9', bounced: '1', complained: '0', failed: '0', suppressed: '0' },
      { partner_id: 'p2', sent: '0', delivered: '0', bounced: '0', complained: '0', failed: '0', suppressed: '0' },
    ]));
    const all = await loadAllPartnerSendingWindowStats(AT);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(all.map((r) => r.partnerId)).toEqual(['p1', 'p2']);
    expect(all[0]!.messages).toBe(10);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/deliveryStats.test.ts
```
Expected failure: `Failed to load … deliveryStats.test.ts` … `Cannot find module './deliveryStats'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/emailDomains/deliveryStats.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';

/**
 * Per-partner delivery counters (spec §9.3).
 *
 * WRITE PATH. The only writer is the Resend delivery webhook
 * (routes/webhooks/emailProvider.ts). The send path never writes here: a
 * partner-axis write from sendEmail is forbidden by W03's Global Constraints,
 * so `sent` is counted from the provider's own `email.sent` event.
 *
 * The increment is ONE statement whose row source is a SELECT over `partners`:
 *
 *   INSERT INTO partner_sending_daily_stats (partner_id, day, <col>)
 *   SELECT p.id, $day, 1 FROM partners p WHERE p.id = $partner
 *   ON CONFLICT (partner_id, day) DO UPDATE SET <col> = … + 1
 *
 * Two properties fall out of that shape and both are load-bearing:
 *
 *  1. A provider tag naming a partner that does not exist inserts ZERO rows.
 *     The alternative — letting the FK raise 23503 and catching it — would
 *     abort the surrounding transaction even though the error was handled
 *     (utils/pgErrors.ts:42-57; production incident 2026-09-15).
 *  2. Concurrent deliveries for the same (partner, day) serialise on the
 *     primary key inside ON CONFLICT DO UPDATE, so two workers processing two
 *     events never lose an increment. A read-modify-write in application code
 *     would.
 *
 * The column name is interpolated with sql.raw, which is safe because it is
 * looked up in the frozen STAT_COLUMNS set below and never taken from input;
 * anything else throws before a statement is built.
 */

export type DeliveryStatColumn = 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed';

const STAT_COLUMNS: ReadonlySet<string> = new Set<DeliveryStatColumn>([
  'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed',
]);

/** Spec §9.3: "7-day bounce rate", "3 complaints in 7 days". */
export const STATS_WINDOW_DAYS = 7;

export interface PartnerSendingWindowStats {
  partnerId: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  /**
   * The rate denominator. GREATEST(sent, delivered + bounced + failed) is
   * correct whether or not the operator subscribed `email.sent` on the provider
   * webhook: with it, `sent` is the true denominator and is never smaller than
   * the outcomes; without it, the observed outcomes are the best estimate. It
   * can never be smaller than the number of bounces, so a rate can never exceed 1.
   */
  messages: number;
  /** bounced / messages, or 0 when nothing was observed. */
  bounceRate: number;
}

/** `YYYY-MM-DD` in UTC. The stats day is the provider event's UTC calendar day. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function windowStartDay(now: Date): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (STATS_WINDOW_DAYS - 1));
  return utcDay(start);
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

interface RawWindowRow {
  partner_id: string;
  sent: string | number;
  delivered: string | number;
  bounced: string | number;
  complained: string | number;
  failed: string | number;
  suppressed: string | number;
}

/** bigint arrives from postgres.js as a string; Number() is exact well past any real volume. */
function num(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toWindowStats(row: RawWindowRow): PartnerSendingWindowStats {
  const sent = num(row.sent);
  const delivered = num(row.delivered);
  const bounced = num(row.bounced);
  const complained = num(row.complained);
  const failed = num(row.failed);
  const suppressed = num(row.suppressed);
  const messages = Math.max(sent, delivered + bounced + failed);
  return {
    partnerId: row.partner_id,
    sent, delivered, bounced, complained, failed, suppressed,
    messages,
    bounceRate: messages > 0 ? bounced / messages : 0,
  };
}

function zeroStats(partnerId: string): PartnerSendingWindowStats {
  return {
    partnerId, sent: 0, delivered: 0, bounced: 0,
    complained: 0, failed: 0, suppressed: 0, messages: 0, bounceRate: 0,
  };
}

/**
 * Increment one counter for (partner, UTC day of `at`).
 *
 * @returns true when the row was inserted or updated; false when `partnerId`
 *          matched no partner, which is how an unknown or forged provider tag
 *          is counted nowhere.
 */
export async function incrementPartnerSendingStat(
  partnerId: string,
  column: DeliveryStatColumn,
  at: Date = new Date(),
): Promise<boolean> {
  if (!STAT_COLUMNS.has(column)) {
    // Never reachable from the webhook (its map is exhaustive over the handled
    // event types); this is the guard that makes the sql.raw below safe to read.
    throw new Error(`[emailDomains/deliveryStats] unknown delivery stat column: ${String(column)}`);
  }
  const col = sql.raw(column);
  const day = utcDay(at);

  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      insert into partner_sending_daily_stats (partner_id, day, ${col})
      select p.id, ${day}::date, 1
      from partners p
      where p.id = ${partnerId}::uuid
      on conflict (partner_id, day) do update
        set ${col} = partner_sending_daily_stats.${col} + 1,
            updated_at = now()
      returning partner_id
    `),
    'emailDomainsDeliveryStatIncrement',
  );
  return extractRows<{ partner_id: string }>(result).length > 0;
}

/** The trailing STATS_WINDOW_DAYS days, inclusive of today, for one partner. */
export async function loadPartnerSendingWindowStats(
  partnerId: string,
  now: Date = new Date(),
): Promise<PartnerSendingWindowStats> {
  const from = windowStartDay(now);
  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      select
        ${partnerId}::uuid              as partner_id,
        coalesce(sum(s.sent), 0)        as sent,
        coalesce(sum(s.delivered), 0)   as delivered,
        coalesce(sum(s.bounced), 0)     as bounced,
        coalesce(sum(s.complained), 0)  as complained,
        coalesce(sum(s.failed), 0)      as failed,
        coalesce(sum(s.suppressed), 0)  as suppressed
      from partner_sending_daily_stats s
      where s.partner_id = ${partnerId}::uuid
        and s.day >= ${from}::date
      having count(*) > 0
    `),
    'emailDomainsWindowStats',
  );
  const row = extractRows<RawWindowRow>(result)[0];
  return row ? toWindowStats(row) : zeroStats(partnerId);
}

/**
 * The same window for EVERY partner that has any row in it, in ONE grouped
 * query. Both consumers — the admin list (spec §9.3) and the abuse sweep
 * (spec §9.2) — need the whole fleet, and a per-partner call would be an N+1
 * over the partner table.
 */
export async function loadAllPartnerSendingWindowStats(
  now: Date = new Date(),
): Promise<PartnerSendingWindowStats[]> {
  const from = windowStartDay(now);
  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      select
        s.partner_id                    as partner_id,
        coalesce(sum(s.sent), 0)        as sent,
        coalesce(sum(s.delivered), 0)   as delivered,
        coalesce(sum(s.bounced), 0)     as bounced,
        coalesce(sum(s.complained), 0)  as complained,
        coalesce(sum(s.failed), 0)      as failed,
        coalesce(sum(s.suppressed), 0)  as suppressed
      from partner_sending_daily_stats s
      where s.day >= ${from}::date
      group by s.partner_id
    `),
    'emailDomainsWindowStatsAll',
  );
  return extractRows<RawWindowRow>(result).map(toWindowStats);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/deliveryStats.test.ts
```
Expected: `Test Files 1 passed (1)`, 11 tests passed.

- [ ] **Step 5: Prove no allowlist entry is needed**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: PASS with **no** edit to `ALLOWED_WITHOUT_CAPABILITY_CHECK`. The
scanner's pattern is `\.(insert|update|delete)\(\s*partnerSendingDailyStats\s*[,)]`
and this module writes through `db.execute(sql\`insert into …\`)`, which it
cannot see. Adding an entry anyway would red
`it('the allowlist has no stale entries')`. This is plan amendment 5; if the
suite reds here, the implementation drifted to a Drizzle `.insert()` and must be
put back to the single guarded statement.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/deliveryStats.ts apps/api/src/services/emailDomains/deliveryStats.test.ts
git commit -m "feat(email-domains): partner delivery-stat counters and 7-day rollups

One guarded statement per increment: the row source is a SELECT over partners,
so an unknown provider tag inserts nothing instead of raising a 23503 that would
abort the transaction, and concurrent events serialise on the primary key inside
ON CONFLICT DO UPDATE. The rate denominator is GREATEST(sent, delivered +
bounced + failed) so it is correct whether or not the operator subscribed
email.sent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Auto-suspension configuration

Three optional variables (spec §9.3 last paragraph). **Every one is optional and
none is ever required by an upgrade.** There is no `requireIf` on any of them:
hosted falls back to the spec's defaults, self-hosted falls back to "off".

**Files:**
- Modify: `apps/api/src/config/validate.ts` — three zod keys immediately after
  `EMAIL_DOMAINS_WEBHOOK_SECRET: z.string().optional(),` (added by W02a Task 5,
  the last line of its `EMAIL_DOMAINS_*` block)
- Modify: `apps/api/src/config/validate.test.ts` — extend W02a's
  `it.each([...])('%s is declared in the env schema')` list and add two cases
- Modify: `apps/api/src/config/envComposeParity.test.ts` — extend W02a's
  `EMAIL_DOMAINS_VARS` array inside
  `describe('EMAIL_DOMAINS_* env plumbing (partner sending domains W02a)')`
- Modify: `apps/api/src/services/emailDomains/config.ts` — an `autoSuspend`
  block on `EmailDomainsConfig`
- Modify: `apps/api/src/services/emailDomains/config.test.ts` — a new describe
- Modify: `.env.example` (append after `EMAIL_DOMAINS_WEBHOOK_SECRET=`)
- Modify: `deploy/.env.example` (append after `EMAIL_DOMAINS_WEBHOOK_SECRET=`)
- Modify: `docker-compose.yml` (append after
  `EMAIL_DOMAINS_WEBHOOK_SECRET: ${EMAIL_DOMAINS_WEBHOOK_SECRET:-}` in the
  `x-api-env: &api-env` anchor)
- Modify: `deploy/docker-compose.prod.yml` (the identical three lines in its own
  `x-api-env: &api-env` anchor)

**Interfaces:**
- Consumes: `isHosted` (`config/env.ts:321`).
- Produces (added to the existing `EmailDomainsConfig`):
  ```ts
  export interface EmailDomainsAutoSuspendConfig {
    /** false when nothing is configured and the instance is self-hosted. */
    enabled: boolean;
    bounceRate: number;     // fraction, e.g. 0.08
    minMessages: number;    // e.g. 50
    complaints: number;     // e.g. 3
  }
  // EmailDomainsConfig gains: autoSuspend: EmailDomainsAutoSuspendConfig;
  export const DEFAULT_AUTOSUSPEND_BOUNCE_RATE: number;   // 0.08
  export const DEFAULT_AUTOSUSPEND_MIN_MESSAGES: number;  // 50
  export const DEFAULT_AUTOSUSPEND_COMPLAINTS: number;    // 3
  ```

- [ ] **Step 1: Write the failing config tests**

Append to `apps/api/src/services/emailDomains/config.test.ts`:

```ts
describe('getEmailDomainsConfig — auto-suspension (spec §9.3)', () => {
  it('is ON with the spec defaults when hosted and nothing is set', () => {
    process.env.IS_HOSTED = 'true';
    expect(getEmailDomainsConfig().autoSuspend).toEqual({
      enabled: true, bounceRate: 0.08, minMessages: 50, complaints: 3,
    });
  });

  // The load-bearing self-hosted guarantee: an upgrade must not start
  // suspending an operator's only sending domain behind their back.
  it('is OFF when self-hosted and nothing is set', () => {
    process.env.IS_HOSTED = 'false';
    expect(getEmailDomainsConfig().autoSuspend.enabled).toBe(false);
  });

  it('is ON self-hosted as soon as the operator sets any one threshold', () => {
    process.env.IS_HOSTED = 'false';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS = '5';
    const cfg = getEmailDomainsConfig().autoSuspend;
    expect(cfg.enabled).toBe(true);
    expect(cfg.complaints).toBe(5);
    // The two the operator did NOT set fall back to the published defaults.
    expect(cfg.bounceRate).toBe(0.08);
    expect(cfg.minMessages).toBe(50);
  });

  it('reads all three thresholds', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE = '0.12';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = '200';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS = '10';
    expect(getEmailDomainsConfig().autoSuspend).toEqual({
      enabled: true, bounceRate: 0.12, minMessages: 200, complaints: 10,
    });
  });

  it('ignores a bounce rate outside (0, 1] and warns', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE = '8';
    expect(getEmailDomainsConfig().autoSuspend.bounceRate).toBe(0.08);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a non-numeric threshold and keeps the default', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = 'lots';
    expect(getEmailDomainsConfig().autoSuspend.minMessages).toBe(50);
    warn.mockRestore();
  });

  // 0 messages would make every partner with a single bounce suspendable.
  it('refuses minMessages = 0 and keeps the default', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = '0';
    expect(getEmailDomainsConfig().autoSuspend.minMessages).toBe(50);
    warn.mockRestore();
  });
});
```

Extend the file's `beforeEach` env-clearing list (W02a Task 5 declared it as an
array of `EMAIL_DOMAINS_*` names) with the three new keys:

```ts
  'EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE', 'EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES',
  'EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS',
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/config.test.ts
```
Expected failure: every new case fails with
`expected undefined to equal { enabled: true, … }` — `autoSuspend` is not on the
config object yet.

- [ ] **Step 3: Implement the reader**

In `apps/api/src/services/emailDomains/config.ts`, add the interface and the
three defaults beside the existing `DEFAULT_*` constants:

```ts
export interface EmailDomainsAutoSuspendConfig {
  /**
   * Hosted: on by default (spec §9.3). Self-hosted: off until the operator sets
   * at least one threshold. A self-hoster's bounce rate is their own business,
   * and an upgrade that started suspending their only sending domain would be a
   * bug report, not a protection — the same argument as the send cap's
   * unlimited self-hosted default.
   */
  enabled: boolean;
  /** Fraction in (0, 1]. */
  bounceRate: number;
  /** Minimum messages in the window before the rate means anything. */
  minMessages: number;
  /** Complaints in the window that suspend regardless of rate. */
  complaints: number;
}

export const DEFAULT_AUTOSUSPEND_BOUNCE_RATE = 0.08;
export const DEFAULT_AUTOSUSPEND_MIN_MESSAGES = 50;
export const DEFAULT_AUTOSUSPEND_COMPLAINTS = 3;

const AUTOSUSPEND_KEYS = [
  'EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE',
  'EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES',
  'EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS',
] as const;

/** A fraction in (0, 1]; anything else warns and falls back. */
function ratio(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    console.warn(`[emailDomains] Ignoring ${name}=${JSON.stringify(raw)} (want a fraction in (0,1]); using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** An integer >= 1; 0 would make one bounce enough to suspend. */
function positiveInt(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[emailDomains] Ignoring ${name}=${JSON.stringify(raw)} (want an integer >= 1); using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function readAutoSuspendConfig(): EmailDomainsAutoSuspendConfig {
  const configured = AUTOSUSPEND_KEYS.some((key) => str(key) !== null);
  return {
    enabled: isHosted() || configured,
    bounceRate: ratio('EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE', DEFAULT_AUTOSUSPEND_BOUNCE_RATE),
    minMessages: positiveInt('EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES', DEFAULT_AUTOSUSPEND_MIN_MESSAGES),
    complaints: positiveInt('EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS', DEFAULT_AUTOSUSPEND_COMPLAINTS),
  };
}
```

Add the field to the `EmailDomainsConfig` interface, immediately after
`webhookSecret: string | null;`:

```ts
  autoSuspend: EmailDomainsAutoSuspendConfig;
```

and to the object `getEmailDomainsConfig()` returns, immediately after
`webhookSecret: str('EMAIL_DOMAINS_WEBHOOK_SECRET')`:

```ts
    ,
    autoSuspend: readAutoSuspendConfig()
```

- [ ] **Step 4: Declare the three keys in the env schema**

In `apps/api/src/config/validate.ts`, immediately after
`EMAIL_DOMAINS_WEBHOOK_SECRET: z.string().optional(),`:

```ts
    // Automatic suspension thresholds (spec §9.3). Optional strings like every
    // other EMAIL_DOMAINS_* key, and deliberately with NO requireIf: hosted
    // falls back to 0.08 / 50 / 3, self-hosted falls back to "off". Parsing and
    // range-checking live in services/emailDomains/config.ts.
    EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE: z.string().optional(),
    EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES: z.string().optional(),
    EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS: z.string().optional(),
```

In `apps/api/src/config/validate.test.ts`, add the three names to the
`it.each([...])('%s is declared in the env schema')` list W02a Task 5 created,
and add two cases beside it inside the same describe:

```ts
    it('boots with the auto-suspension thresholds unset (upgrade is a no-op)', () => {
      withEnv({ ...prodBase }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('never requires an auto-suspension threshold, even with the provider set', () => {
      withEnv({
        ...prodBase,
        EMAIL_DOMAINS_PROVIDER: 'resend',
        EMAIL_DOMAINS_RESEND_API_KEY: 're_partner_lane',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
```

- [ ] **Step 5: Document and map the three variables**

Append to `.env.example`, immediately after the
`EMAIL_DOMAINS_WEBHOOK_SECRET=` line:

```
# Automatic suspension of a partner's sending domains on poor deliverability.
# ON by default on hosted (0.08 / 50 / 3). OFF on a self-hosted instance until
# you set at least one of the three — then the two you left unset use the
# defaults shown. Unsuspending is always manual (platform admin).
# 7-day bounce rate above this fraction suspends every domain of the partner.
EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE=0.08
# …but only once the 7-day window holds at least this many messages.
EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES=50
# Spam complaints in 7 days that suspend regardless of the rate.
EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS=3
```

Append to `deploy/.env.example`, immediately after its
`EMAIL_DOMAINS_WEBHOOK_SECRET=` line:

```
EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE=0.08
EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES=50
EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS=3
```

Insert into `docker-compose.yml`'s `x-api-env: &api-env` anchor, immediately
after `EMAIL_DOMAINS_WEBHOOK_SECRET: ${EMAIL_DOMAINS_WEBHOOK_SECRET:-}`:

```yaml
  EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE: ${EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE:-}
  EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES: ${EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES:-}
  EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS: ${EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS:-}
```

Insert the identical three lines into `deploy/docker-compose.prod.yml`'s
`x-api-env: &api-env` anchor after its own `EMAIL_DOMAINS_WEBHOOK_SECRET` line.
One insertion covers both the `api` service (`<<: *api-env`) and the `worker`
service.

Finally, extend the `EMAIL_DOMAINS_VARS` array in
`apps/api/src/config/envComposeParity.test.ts` (inside
`describe('EMAIL_DOMAINS_* env plumbing (partner sending domains W02a)')`) with:

```ts
    'EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE',
    'EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES',
    'EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS',
```

- [ ] **Step 6: Run everything green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/config.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts
```
Expected: all PASS. `composeBindMounts.test.ts` walks `services[*].volumes` and
is unaffected by an `environment:` edit — run it anyway to prove the YAML still
parses.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts apps/api/src/config/envComposeParity.test.ts apps/api/src/services/emailDomains/config.ts apps/api/src/services/emailDomains/config.test.ts .env.example deploy/.env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "feat(api): auto-suspension thresholds for partner sending domains

Three optional EMAIL_DOMAINS_AUTOSUSPEND_* variables (spec §9.3), with no
requireIf on any of them. Hosted defaults to 0.08 / 50 / 3; self-hosted is OFF
until the operator sets at least one, so an upgrade can never start suspending
an operator's only sending domain. Mapped in BOTH compose files; the
envComposeParity pin covers all four axes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: `autoSuspend.ts` and the widened `suspendSendingDomain`

**Files:**
- Create: `apps/api/src/services/emailDomains/autoSuspend.ts`
- Create: `apps/api/src/services/emailDomains/autoSuspend.test.ts`
- Modify: `apps/api/src/services/emailDomains/sendingDomainService.ts` — the
  `suspendSendingDomain` function created by W02b Task 6 (it is the two-line
  wrapper over `setAdminStatus` immediately above `unsuspendSendingDomain`)
- Modify: `apps/api/src/routes/admin/sendingDomains.test.ts` — one assertion that
  the admin route still suspends with the default reason (W02b Task 8 created it)

**Interfaces:**
- Consumes: `getEmailDomainsConfig` (`./config`), `loadPartnerSendingWindowStats`
  / `STATS_WINDOW_DAYS` (`./deliveryStats`, Task 2), `suspendSendingDomain`
  (`./sendingDomainService`), `sendSendingDomainStatusEmail` (`./statusMail`),
  `sendOpsAlert` (`../opsAlerts`), `createAuditLogAsync` (`../auditService`),
  `ANONYMOUS_ACTOR_ID` (`../auditEvents`), `db` / `withSystemDbAccessContext`
  (`../../db`), `partnerSendingDomains` / `partners` (`../../db/schema`),
  `isHosted` (`../../config/env`).
- Produces:
  ```ts
  export type AutoSuspensionOutcome =
    | 'disabled' | 'no_active_domains' | 'below_thresholds'
    | 'suspended_bounce_rate' | 'suspended_complaints';
  export interface AutoSuspensionResult {
    outcome: AutoSuspensionOutcome;
    suspendedDomainIds: string[];
  }
  export async function evaluateAutoSuspension(partnerId: string): Promise<AutoSuspensionResult>;
  ```
- Also produced (widened, in `sendingDomainService.ts`):
  ```ts
  export async function suspendSendingDomain(
    domainId: string,
    statusReason?: 'platform_suspended' | 'abuse_auto',
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/autoSuspend.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectRows, windowStats, suspendMock, statusMailMock, opsAlertMock, auditMock, configMock, hostedMock } =
  vi.hoisted(() => ({
    selectRows: [] as unknown[][],
    windowStats: { value: null as unknown },
    suspendMock: vi.fn(async () => undefined),
    statusMailMock: vi.fn(async () => 1),
    opsAlertMock: vi.fn(async () => true),
    auditMock: vi.fn(async () => undefined),
    configMock: vi.fn(),
    hostedMock: vi.fn(() => true),
  }));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
      Promise.resolve(selectRows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./config', () => ({ getEmailDomainsConfig: configMock }));
vi.mock('./deliveryStats', () => ({
  STATS_WINDOW_DAYS: 7,
  loadPartnerSendingWindowStats: vi.fn(async () => windowStats.value),
}));
vi.mock('./sendingDomainService', () => ({ suspendSendingDomain: suspendMock }));
vi.mock('./statusMail', () => ({ sendSendingDomainStatusEmail: statusMailMock }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: opsAlertMock }));
vi.mock('../auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('../auditEvents', () => ({ ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000' }));
vi.mock('../../config/env', () => ({ isHosted: hostedMock }));

import { evaluateAutoSuspension } from './autoSuspend';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const DOMAIN_A = '22222222-2222-4222-8222-222222222222';
const DOMAIN_B = '33333333-3333-4333-8333-333333333333';

function stats(over: Partial<{ sent: number; delivered: number; bounced: number; complained: number; failed: number; suppressed: number }>) {
  const base = { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0, ...over };
  const messages = Math.max(base.sent, base.delivered + base.bounced + base.failed);
  return {
    partnerId: PARTNER, ...base, messages,
    bounceRate: messages > 0 ? base.bounced / messages : 0,
  };
}

function activeDomains() {
  return [
    { id: DOMAIN_A, domain: 'mail.acme.test', createdBy: 'u1', partnerName: 'Acme MSP' },
    { id: DOMAIN_B, domain: 'billing.acme.test', createdBy: null, partnerName: 'Acme MSP' },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.length = 0;
  hostedMock.mockReturnValue(true);
  configMock.mockReturnValue({ autoSuspend: { enabled: true, bounceRate: 0.08, minMessages: 50, complaints: 3 } });
  windowStats.value = stats({});
});

describe('evaluateAutoSuspension — the off switch', () => {
  it('is a no-op when auto-suspension is disabled (self-hosted default)', async () => {
    configMock.mockReturnValue({ autoSuspend: { enabled: false, bounceRate: 0.08, minMessages: 50, complaints: 3 } });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'disabled', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the partner has no sendable domain left', async () => {
    selectRows.push([]);
    windowStats.value = stats({ delivered: 10, bounced: 90 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'no_active_domains', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });
});

describe('evaluateAutoSuspension — the threshold matrix (spec §9.3)', () => {
  it('does NOT suspend exactly AT the bounce rate (strictly greater is required)', async () => {
    selectRows.push(activeDomains());
    // 8 bounced of 100 messages == 0.08 exactly.
    windowStats.value = stats({ sent: 100, delivered: 90, bounced: 8, failed: 2 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it('suspends just OVER the bounce rate', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 100, delivered: 89, bounced: 9, failed: 2 });
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_bounce_rate');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });

  it('ignores a high bounce rate BELOW the minimum message count', async () => {
    selectRows.push(activeDomains());
    // 49 messages, 40% bounced — loud, but not enough evidence.
    windowStats.value = stats({ sent: 49, delivered: 29, bounced: 20 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it('acts at EXACTLY the minimum message count when the rate is over', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 50, delivered: 44, bounced: 5, failed: 1 }); // 0.10 > 0.08
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toMatchObject({ outcome: 'suspended_bounce_rate' });
  });

  it('does NOT suspend at 2 complaints', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 2 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
  });

  it('suspends at EXACTLY 3 complaints, whatever the volume', async () => {
    selectRows.push(activeDomains());
    // Deliberately below minMessages: the complaint rule is absolute (spec §9.3).
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_complaints');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });
});

describe('evaluateAutoSuspension — the fan-out', () => {
  it('suspends EVERY domain of the partner with reason abuse_auto', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(suspendMock.mock.calls).toEqual([[DOMAIN_A, 'abuse_auto'], [DOMAIN_B, 'abuse_auto']]);
  });

  it('mails one status notice per domain and writes one audit row per domain', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(statusMailMock).toHaveBeenCalledTimes(2);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER, domain: 'mail.acme.test', event: 'suspended',
      statusReason: 'abuse_auto', createdBy: 'u1',
    }));
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner_sending_domain.auto_suspended',
      resourceType: 'partner_sending_domain',
      actorType: 'system',
      result: 'success',
    }));
  });

  it('raises exactly ONE ops alert for the whole partner, not one per domain', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
    const alert = opsAlertMock.mock.calls[0]![0] as { title: string; body: string };
    expect(alert.title).toContain('Acme MSP');
    expect(alert.body).toContain(PARTNER);
    expect(alert.body).toContain('complaints');
  });

  // A domain already suspended is filtered out by the query, so a repeat
  // evaluation has nothing to act on — the job is safe to run on every event.
  it('is idempotent: a second evaluation with everything already suspended does nothing', async () => {
    selectRows.push([]);
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 30 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'no_active_domains', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  // Delivery of a notice must never roll back a suspension that already landed.
  it('still reports the suspension when the status mail throws', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    statusMailMock.mockRejectedValueOnce(new Error('smtp down'));
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_complaints');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });

  it('still reports the suspension when the ops alert throws', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    opsAlertMock.mockRejectedValueOnce(new Error('discord down'));
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toMatchObject({ outcome: 'suspended_complaints' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/autoSuspend.test.ts
```
Expected failure: `Cannot find module './autoSuspend'`.

- [ ] **Step 3: Widen `suspendSendingDomain`**

In `apps/api/src/services/emailDomains/sendingDomainService.ts`, replace the
`suspendSendingDomain` function W02b Task 6 shipped with:

```ts
/**
 * The kill switch (spec §9.1). Sending stops on the next send, because
 * resolution reads the row.
 *
 * `statusReason` defaults to `platform_suspended` — the admin route's meaning
 * and W02b's original behaviour, so that call site is unchanged. W05's
 * automatic suspension passes `abuse_auto` (spec §9.3). The status reason is
 * the ONLY difference between the two: both stop sending, both keep the
 * provider domain, and neither can be undone by the partner.
 *
 * This function deliberately does NOT write an audit row or send the status
 * notice. The admin route already writes its own `writeRouteAudit` with the
 * human actor, and the automatic path writes a system audit row and mails from
 * services/emailDomains/autoSuspend.ts, which is the only caller that has the
 * partner id, the domain name and `created_by` in hand.
 */
export async function suspendSendingDomain(
  domainId: string,
  statusReason: 'platform_suspended' | 'abuse_auto' = 'platform_suspended',
): Promise<void> {
  await setAdminStatus(domainId, { status: 'suspended', statusReason, nextCheckAt: new Date() });
}
```

Add one case to `apps/api/src/routes/admin/sendingDomains.test.ts`, inside the
existing `describe('admin sending domains', …)`:

```ts
  it('the admin route suspends with the default platform_suspended reason', async () => {
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(200);
    // One argument: the route must not start passing abuse_auto.
    expect(mocks.suspend).toHaveBeenCalledWith(DOMAIN_ID);
  });
```

- [ ] **Step 4: Implement `autoSuspend.ts`**

Create `apps/api/src/services/emailDomains/autoSuspend.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains, partners } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { sendOpsAlert } from '../opsAlerts';
import { getEmailDomainsConfig } from './config';
import { STATS_WINDOW_DAYS, loadPartnerSendingWindowStats } from './deliveryStats';
import { suspendSendingDomain } from './sendingDomainService';
import { sendSendingDomainStatusEmail } from './statusMail';

/**
 * Automatic suspension on poor deliverability (spec §9.3).
 *
 * Two independent rules over the trailing STATS_WINDOW_DAYS days:
 *
 *   1. bounce rate STRICTLY above the configured fraction, over at least
 *      `minMessages` messages. "At least" and "strictly above" are both
 *      deliberate: a partner sitting exactly on the published threshold has not
 *      crossed it, and a rate computed over a handful of messages is noise.
 *   2. `complaints` or more spam complaints, regardless of volume. A complaint
 *      is a human pressing "this is spam"; three of them is not a rate.
 *
 * Both thresholds sit well inside Resend's ACCOUNT-wide limits (bounce < 4%,
 * spam < 0.08%) because many partners share the one partner-lane account: one
 * partner must be stopped long before it can pause the account for everyone.
 *
 * On self-hosted this is OFF unless the operator sets a threshold
 * (services/emailDomains/config.ts) — the same reasoning as the unlimited
 * self-hosted send cap.
 *
 * Unsuspension is always manual (a platform admin, spec §9.1). Nothing here
 * ever clears a suspension.
 *
 * DB CONTEXT: every read runs in a short system transaction; the suspension
 * writes go through sendingDomainService, which opens its own. The notices and
 * the ops alert make network round trips and therefore run with NO pooled
 * connection held (#1105).
 */

export type AutoSuspensionOutcome =
  | 'disabled'
  | 'no_active_domains'
  | 'below_thresholds'
  | 'suspended_bounce_rate'
  | 'suspended_complaints';

export interface AutoSuspensionResult {
  outcome: AutoSuspensionOutcome;
  suspendedDomainIds: string[];
}

/**
 * Statuses that can still put mail on the partner lane (spec §5.2). A row that
 * is already `suspended`, `failed`, `removing`, `provisioning` or `pending` is
 * not sending, so suspending it would be noise — and filtering here is what
 * makes a repeat evaluation an exact no-op.
 */
const SENDABLE_STATUSES = ['verified', 'at_risk'] as const;

interface ActiveDomainRow {
  id: string;
  domain: string;
  createdBy: string | null;
  partnerName: string;
}

export async function evaluateAutoSuspension(partnerId: string): Promise<AutoSuspensionResult> {
  const cfg = getEmailDomainsConfig().autoSuspend;
  if (!cfg.enabled) return { outcome: 'disabled', suspendedDomainIds: [] };

  const rows = await withSystemDbAccessContext(() => db
    .select({
      id: partnerSendingDomains.id,
      domain: partnerSendingDomains.domain,
      createdBy: partnerSendingDomains.createdBy,
      partnerName: partners.name,
    })
    .from(partnerSendingDomains)
    .innerJoin(partners, eq(partners.id, partnerSendingDomains.partnerId))
    .where(and(
      eq(partnerSendingDomains.partnerId, partnerId),
      inArray(partnerSendingDomains.status, [...SENDABLE_STATUSES]),
    ))
    .orderBy(partnerSendingDomains.createdAt), 'emailDomainsAutoSuspendLoad') as ActiveDomainRow[];

  if (rows.length === 0) return { outcome: 'no_active_domains', suspendedDomainIds: [] };

  const stats = await loadPartnerSendingWindowStats(partnerId);

  const rateBreached = stats.messages >= cfg.minMessages && stats.bounceRate > cfg.bounceRate;
  const complaintsBreached = stats.complained >= cfg.complaints;
  if (!rateBreached && !complaintsBreached) {
    return { outcome: 'below_thresholds', suspendedDomainIds: [] };
  }

  // Complaints win the label when both fire: a human marking mail as spam is
  // the stronger statement, and the ops alert reads better for it.
  const outcome: AutoSuspensionOutcome = complaintsBreached ? 'suspended_complaints' : 'suspended_bounce_rate';
  const reasonLine = complaintsBreached
    ? `${stats.complained} spam complaints in ${STATS_WINDOW_DAYS} days (threshold ${cfg.complaints})`
    : `bounce rate ${(stats.bounceRate * 100).toFixed(2)}% over ${stats.messages} messages in ${STATS_WINDOW_DAYS} days (threshold ${(cfg.bounceRate * 100).toFixed(2)}%, min ${cfg.minMessages})`;

  const suspendedDomainIds: string[] = [];
  for (const row of rows) {
    try {
      await suspendSendingDomain(row.id, 'abuse_auto');
    } catch (err) {
      // One domain refusing to suspend must not leave the others sending.
      console.error(
        `[emailDomains/autoSuspend] failed to suspend ${row.id} (${row.domain}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    suspendedDomainIds.push(row.id);

    await withSystemDbAccessContext(() => createAuditLogAsync({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'partner_sending_domain.auto_suspended',
      resourceType: 'partner_sending_domain',
      resourceId: row.id,
      resourceName: row.domain,
      details: {
        partnerId,
        outcome,
        reason: reasonLine,
        windowDays: STATS_WINDOW_DAYS,
        messages: stats.messages,
        bounced: stats.bounced,
        complained: stats.complained,
        thresholds: { bounceRate: cfg.bounceRate, minMessages: cfg.minMessages, complaints: cfg.complaints },
      },
      result: 'success',
    }), 'emailDomainsAutoSuspendAudit');

    // OUTSIDE any DB context: a transport round trip, and it must never turn a
    // correct suspension into a thrown job that retries the whole evaluation.
    try {
      await sendSendingDomainStatusEmail({
        partnerId,
        domain: row.domain,
        event: 'suspended',
        statusReason: 'abuse_auto',
        createdBy: row.createdBy,
      });
    } catch (err) {
      console.error(
        `[emailDomains/autoSuspend] status mail failed for ${row.domain}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (suspendedDomainIds.length > 0) {
    // ONE alert for the partner, not one per domain: the operator is being told
    // about an account, and N pages for one account is how an alert channel
    // gets muted.
    const partnerName = rows[0]!.partnerName;
    try {
      await sendOpsAlert({
        title: `Sending domains auto-suspended: ${partnerName}`,
        body: [
          `Partner: ${partnerName}`,
          `Partner id: ${partnerId}`,
          `Reason: ${reasonLine}`,
          `Domains suspended (${suspendedDomainIds.length}): ${rows.filter((r) => suspendedDomainIds.includes(r.id)).map((r) => r.domain).join(', ')}`,
          `Window totals: sent=${stats.sent} delivered=${stats.delivered} bounced=${stats.bounced} complained=${stats.complained} failed=${stats.failed} suppressed=${stats.suppressed}`,
          'Unsuspending is manual: /admin/sending-domains (platform admin + MFA).',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[emailDomains/autoSuspend] ops alert failed:', err instanceof Error ? err.message : err);
    }
  }

  return { outcome, suspendedDomainIds };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/autoSuspend.test.ts src/services/emailDomains/sendingDomainService.test.ts src/routes/admin/sendingDomains.test.ts
```
Expected: `Test Files 3 passed (3)`. `autoSuspend.test.ts` has 14 tests; the two
W02b suites are unchanged apart from the one added case.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/autoSuspend.ts apps/api/src/services/emailDomains/autoSuspend.test.ts apps/api/src/services/emailDomains/sendingDomainService.ts apps/api/src/routes/admin/sendingDomains.test.ts
git commit -m "feat(email-domains): automatic suspension on bounce and complaint thresholds

Spec §9.3. Strictly-above on the 7-day bounce rate over at least minMessages,
or an absolute complaint count; either one suspends EVERY sendable domain of the
partner through W02b's kill switch with status_reason abuse_auto, writes a
system audit row and a status notice per domain, and raises exactly one ops
alert for the partner. An already-suspended partner is an exact no-op, so the
evaluation is safe to run on every bounce event. Unsuspending stays manual.

suspendSendingDomain gains an optional status reason, defaulting to
platform_suspended so the admin route is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: The `evaluate-auto-suspend` job

**Files:**
- Modify: `apps/api/src/jobs/sendingDomainsWorker.ts` (created by W02b Task 4) —
  one job-name constant beside `DAILY_JOB`, one member on the
  `SendingDomainsJobData` union, one exported producer beside
  `enqueueTestSend`, and one `case` in `createSendingDomainsWorker()`'s
  `switch (job.name)`
- Modify: `apps/api/src/jobs/sendingDomainsWorker.test.ts` (created by W02b
  Task 4) — one describe block

**Interfaces:**
- Consumes: `evaluateAutoSuspension` (`../services/emailDomains/autoSuspend`,
  Task 4), `isPartnerLaneConfigured` (`../services/emailDomains/config`).
- Produces:
  ```ts
  export async function enqueueAutoSuspendEvaluation(partnerId: string): Promise<void>;
  ```
  and the job name `'evaluate-auto-suspend'` on the `sending-domains` queue.

> `src/jobs/**` is NOT scanned by `partner-wide-write-coverage.test.ts`
> (`collectSourceFiles()` walks only `src/routes` and `src/services`), so this
> file needs no `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry even though the job it
> runs ends in a partner-axis write. Verified by reading the two `walk()` calls.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/jobs/sendingDomainsWorker.test.ts` (and extend its
imports to include `enqueueAutoSuspendEvaluation`; add the mock below beside the
file's existing `vi.mock` block, at the top of the file):

```ts
const { evaluateAutoSuspendMock } = vi.hoisted(() => ({
  evaluateAutoSuspendMock: vi.fn(async () => ({ outcome: 'below_thresholds', suspendedDomainIds: [] })),
}));
vi.mock('../services/emailDomains/autoSuspend', () => ({ evaluateAutoSuspension: evaluateAutoSuspendMock }));
```

```ts
describe('evaluate-auto-suspend', () => {
  it('collapses a burst for one partner into ONE job by using the partner id as jobId', async () => {
    laneConfigured.value = true;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd).toHaveBeenCalledWith(
      'evaluate-auto-suspend',
      { partnerId: PARTNER_ID },
      expect.objectContaining({ jobId: `autosuspend:${PARTNER_ID}` }),
    );
  });

  it('does not enqueue on an instance with no partner lane configured', async () => {
    laneConfigured.value = false;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('the worker processor routes the job to evaluateAutoSuspension', async () => {
    laneConfigured.value = true;
    await initializeSendingDomainsWorker();
    const processor = workerCtor.mock.calls[0]![1] as (job: { name: string; data: unknown }) => Promise<unknown>;
    await processor({ name: 'evaluate-auto-suspend', data: { partnerId: PARTNER_ID } });
    expect(evaluateAutoSuspendMock).toHaveBeenCalledWith(PARTNER_ID);
  });

  // The evaluation makes no provider call, so a retry storm cannot burn the
  // account's 10 req/s budget — but a failure should still be retried a couple
  // of times rather than dropped, since it ends in a kill-switch decision.
  it('is enqueued with bounded retries', async () => {
    laneConfigured.value = true;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd.mock.calls[0]![2]).toMatchObject({ attempts: 3 });
  });
});
```

Declare `const PARTNER_ID = '11111111-1111-4111-8111-111111111111';` beside the
file's existing id constants if it is not already there.

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/jobs/sendingDomainsWorker.test.ts
```
Expected failure: `enqueueAutoSuspendEvaluation is not a function` (the import is
`undefined`), and the processor case falls through to the `default` branch and
returns `null`.

- [ ] **Step 3: Implement**

In `apps/api/src/jobs/sendingDomainsWorker.ts`:

Add the import beside the existing `syncSendingDomain` import:
```ts
import { evaluateAutoSuspension } from '../services/emailDomains/autoSuspend';
```

Add the job-name constant immediately after `const DAILY_JOB = 'daily-maintenance';`:
```ts
/** W05 (spec §9.3). Evaluated after a bounce/complaint event, never inline in the webhook request. */
const AUTO_SUSPEND_JOB = 'evaluate-auto-suspend';
```

Extend the `SendingDomainsJobData` union with the new payload shape:
```ts
type SendingDomainsJobData =
  | { domainId: string; lastSendError?: string }
  | { domainId: string; userId: string }
  | { partnerId: string }
  | Record<string, never>;
```

Add the producer immediately after `enqueueTestSend`:
```ts
/**
 * Evaluate one partner against the auto-suspension thresholds (spec §9.3).
 *
 * `jobId = autosuspend:<partnerId>` so a burst of bounce events for the same
 * partner — which is exactly the shape a deliverability problem takes — collapses
 * into ONE in-flight evaluation instead of N identical reads and N identical
 * kill-switch decisions. The prefix keeps the id space disjoint from
 * enqueueSyncDomain's, which uses a bare domain id.
 *
 * Deliberately NOT called inline from the webhook handler: the handler must
 * answer the provider in milliseconds, and this reads a 7-day window and may
 * update every domain of the partner.
 */
export async function enqueueAutoSuspendEvaluation(partnerId: string): Promise<void> {
  if (!isPartnerLaneConfigured()) return;
  await getQueue().add(
    AUTO_SUSPEND_JOB,
    { partnerId },
    {
      jobId: `autosuspend:${partnerId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    },
  );
}
```

Add the `case` in `createSendingDomainsWorker()`'s switch, immediately after the
`case DAILY_JOB:` arm and before `default:`:
```ts
        case AUTO_SUSPEND_JOB: {
          const data = job.data as { partnerId: string };
          return evaluateAutoSuspension(data.partnerId);
        }
```

- [ ] **Step 4: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/jobs/sendingDomainsWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.sendingDomainsWorker.test.ts
```
Expected: all PASS. `scheduleRegistry.contract.test.ts` is unaffected — this job
is enqueued on demand, never repeatable, so it allocates no cron slot.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/jobs/sendingDomainsWorker.ts apps/api/src/jobs/sendingDomainsWorker.test.ts
git commit -m "feat(email-domains): evaluate-auto-suspend job on the sending-domains queue

jobId = autosuspend:<partnerId>, so a burst of bounce events for one partner
collapses into one evaluation. Enqueued by the delivery webhook; never run
inline in the request, which must answer the provider in milliseconds.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Svix signature verification

**Files:**
- Create: `apps/api/src/services/emailDomains/webhookSignature.ts`
- Create: `apps/api/src/services/emailDomains/webhookSignature.test.ts`

**Interfaces:**
- Consumes: `createHmac`, `timingSafeEqual` (`node:crypto`).
- Produces:
  ```ts
  export type WebhookVerifyFailure =
    | 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_secret' | 'bad_signature';
  export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookVerifyFailure };
  export interface SvixHeaders { id: string | null; timestamp: string | null; signature: string | null }
  export const SVIX_TIMESTAMP_TOLERANCE_SECONDS: number;   // 300
  export function verifySvixSignature(
    headers: SvixHeaders, rawBody: string, secret: string, now?: Date,
  ): WebhookVerifyResult;
  ```

> No new dependency. `svix` is not installed anywhere in this repo and
> `resend@6.18.0` exposes webhook **CRUD** only — its `Webhooks` client has no
> `verify` method (plan amendment 3). The scheme below is Svix's documented one,
> which Resend uses verbatim.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/webhookSignature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SVIX_TIMESTAMP_TOLERANCE_SECONDS, verifySvixSignature } from './webhookSignature';

const SECRET = `whsec_${Buffer.from('a-thirty-two-byte-test-secret!!!').toString('base64')}`;
const ID = 'msg_2abcDEF';
const BODY = '{"type":"email.delivered","data":{"email_id":"e1"}}';
const NOW = new Date('2026-09-17T12:00:00.000Z');

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function ts(offsetSeconds = 0): string {
  return String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);
}

describe('verifySvixSignature', () => {
  it('accepts a correctly signed payload', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  // Svix sends every currently-valid secret's signature, space-separated,
  // during a rotation. Only checking the first would break every rotation.
  it('accepts when the matching v1 entry is not the first of several', () => {
    const timestamp = ts();
    const signature = [
      'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      `v1,${sign(SECRET, ID, timestamp, BODY)}`,
    ].join(' ');
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  it('ignores entries whose version is not v1', () => {
    const timestamp = ts();
    const signature = `v2,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a payload signed with a different secret', () => {
    const timestamp = ts();
    const other = `whsec_${Buffer.from('a-different-thirty-two-byte-key!').toString('base64')}`;
    const signature = `v1,${sign(other, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  // The signature covers the EXACT bytes; a re-serialised body must not verify.
  it('rejects when the body differs by one byte', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, `${BODY} `, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects when the id differs (the id is inside the signed string)', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: 'msg_other', timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['id', { id: null, timestamp: ts(), signature: 'v1,x' }],
    ['timestamp', { id: ID, timestamp: null, signature: 'v1,x' }],
    ['signature', { id: ID, timestamp: ts(), signature: null }],
  ])('rejects a request missing the svix-%s header', (_label, headers) => {
    expect(verifySvixSignature(headers as never, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifySvixSignature({ id: ID, timestamp: 'yesterday', signature: 'v1,x' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects a timestamp older than the tolerance', () => {
    const timestamp = ts(-(SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1));
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a timestamp further in the FUTURE than the tolerance', () => {
    const timestamp = ts(SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1);
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts exactly AT the tolerance boundary', () => {
    const timestamp = ts(-SVIX_TIMESTAMP_TOLERANCE_SECONDS);
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  it('tolerates a secret written without the whsec_ prefix', () => {
    const bare = SECRET.replace(/^whsec_/, '');
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, bare, NOW)).toEqual({ ok: true });
  });

  it('rejects an empty secret rather than verifying against an empty key', () => {
    expect(verifySvixSignature({ id: ID, timestamp: ts(), signature: 'v1,x' }, BODY, '   ', NOW))
      .toEqual({ ok: false, reason: 'bad_secret' });
  });

  // A malformed entry must not be able to throw out of the verifier: a thrown
  // error inside a public handler is a 500, which tells the provider to retry
  // a payload that will never verify.
  it('rejects garbage in the signature header without throwing', () => {
    const timestamp = ts();
    expect(verifySvixSignature({ id: ID, timestamp, signature: 'v1,!!!not-base64!!!' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySvixSignature({ id: ID, timestamp, signature: 'nonsense' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySvixSignature({ id: ID, timestamp, signature: '' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/webhookSignature.test.ts
```
Expected failure: `Cannot find module './webhookSignature'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/emailDomains/webhookSignature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix webhook signature verification (spec §9.3: "signature-verified (svix
 * scheme)"). Resend delivers through Svix and uses the scheme unmodified.
 *
 * Implemented by hand on purpose: `svix` is not a dependency of this repo, and
 * `resend@6.18.0`'s client exposes webhook CRUD only — there is no
 * `webhooks.verify` to call (node_modules/resend/dist/index.d.mts). The scheme
 * is small and fully specified, so a hand-rolled verifier is cheaper than a new
 * transitive dependency on an unauthenticated public surface.
 *
 * The scheme:
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   key            = base64-decoded body of the `whsec_`-prefixed secret
 *   signature      = base64( HMAC-SHA256( key, signed content ) )
 *   header         = space-separated `v<version>,<signature>` entries
 *
 * Three properties this function guarantees, each with a test:
 *  - it NEVER throws. A thrown error inside a public webhook handler becomes a
 *    500, which tells the provider to retry a payload that can never verify.
 *  - every candidate signature is compared in constant time, and a length
 *    mismatch short-circuits BEFORE timingSafeEqual (which throws on unequal
 *    lengths).
 *  - EVERY `v1` entry is checked, not just the first: Svix sends one signature
 *    per currently-valid secret during a rotation.
 */

export type WebhookVerifyFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_secret'
  | 'bad_signature';

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookVerifyFailure };

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Svix's own recommendation. Wide enough that a retry after a brief provider
 * queue delay still verifies, narrow enough that a captured payload cannot be
 * replayed hours later — and the `svix-id` reservation in the route is the
 * second, stronger replay defence.
 */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 300;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual THROWS on differing lengths, so the length check has to
  // come first. Length is not a secret here: it is fixed by the algorithm.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
): WebhookVerifyResult {
  const id = headers.id?.trim() ?? '';
  const timestamp = headers.timestamp?.trim() ?? '';
  const signatureHeader = headers.signature?.trim() ?? '';
  if (id.length === 0 || timestamp.length === 0 || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || !Number.isInteger(sentAt)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Symmetric: a timestamp far in the future is as suspicious as a stale one
  // and is what a replay with a doctored clock looks like.
  if (Math.abs(nowSeconds - sentAt) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) return { ok: false, reason: 'bad_secret' };
  // The `whsec_` prefix is a label, not part of the key. Tolerate a secret
  // pasted without it: that is the single most likely operator mistake, and
  // silently failing every delivery over a missing prefix is a bad trade.
  const key = Buffer.from(trimmedSecret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return { ok: false, reason: 'bad_secret' };

  let expected: string;
  try {
    expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }

  for (const entry of signatureHeader.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma <= 0) continue;
    if (entry.slice(0, comma) !== 'v1') continue;
    const candidate = entry.slice(comma + 1);
    if (candidate.length === 0) continue;
    if (constantTimeEquals(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/webhookSignature.test.ts
```
Expected: `Test Files 1 passed (1)`, 16 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/webhookSignature.ts apps/api/src/services/emailDomains/webhookSignature.test.ts
git commit -m "feat(email-domains): Svix webhook signature verification

Hand-rolled because svix is not a dependency and resend@6.18.0's client exposes
webhook CRUD only, with no verify helper. Base64 HMAC-SHA256 over
\`\${svix-id}.\${svix-timestamp}.\${rawBody}\`, a symmetric 5-minute tolerance,
constant-time compare against EVERY v1 entry (Svix sends one per valid secret
during a rotation), and it never throws — a throw in a public handler is a 500
that tells the provider to retry a payload that can never verify.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: The public delivery webhook

**Files:**
- Create: `apps/api/src/routes/webhooks/emailProvider.ts`
- Create: `apps/api/src/routes/webhooks/emailProvider.test.ts`

**Interfaces:**
- Consumes: `getTrustedClientIp` / `rateLimitIpKey` (`../../services/clientIp`),
  `rateLimiter` (`../../services/rate-limit`), `getRedis`
  (`../../services/redis`), `captureException` (`../../services/sentry`),
  `getEmailDomainsConfig` (`../../services/emailDomains/config`),
  `verifySvixSignature` (`../../services/emailDomains/webhookSignature`, Task 6),
  `incrementPartnerSendingStat` (`../../services/emailDomains/deliveryStats`,
  Task 2), `enqueueSyncDomain` / `enqueueAutoSuspendEvaluation`
  (`../../jobs/sendingDomainsWorker`, Task 5), `db` /
  `withSystemDbAccessContext` (`../../db`), `partnerSendingDomains`
  (`../../db/schema`).
- Produces: `export const resendWebhookRoutes: Hono` serving
  `POST /email-provider/resend` (final URL
  `/api/v1/webhooks/email-provider/resend`).

> This file must import **neither** `providerRegistry` **nor** any adapter. Task
> 8 adds the source-scan test that enforces it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/webhooks/emailProvider.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  rateLimiterMock, redisSet, redisRef, incrementMock,
  enqueueSyncMock, enqueueAutoSuspendMock, selectRows, configMock, captureMock,
} = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date() })),
  redisSet: vi.fn(async () => 'OK' as string | null),
  redisRef: { value: null as unknown },
  incrementMock: vi.fn(async () => true),
  enqueueSyncMock: vi.fn(async () => undefined),
  enqueueAutoSuspendMock: vi.fn(async () => undefined),
  selectRows: [] as unknown[][],
  configMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: () => redisRef.value }));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '203.0.113.9'),
}));
vi.mock('../../services/sentry', () => ({ captureException: captureMock }));
vi.mock('../../services/emailDomains/config', () => ({ getEmailDomainsConfig: configMock }));
vi.mock('../../services/emailDomains/deliveryStats', () => ({ incrementPartnerSendingStat: incrementMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({
  enqueueSyncDomain: enqueueSyncMock,
  enqueueAutoSuspendEvaluation: enqueueAutoSuspendMock,
}));
vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
      Promise.resolve(selectRows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { resendWebhookRoutes } from './emailProvider';

const SECRET = `whsec_${Buffer.from('a-thirty-two-byte-test-secret!!!').toString('base64')}`;
const PARTNER = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';

function app(): Hono {
  const a = new Hono();
  a.route('/webhooks', resendWebhookRoutes);
  return a;
}

let messageCounter = 0;
function post(payload: unknown, over: { id?: string; timestamp?: string; signature?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  messageCounter += 1;
  const id = over.id ?? `msg_${messageCounter}`;
  const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = Buffer.from((over.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const signature = over.signature
    ?? `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  return app().request('/webhooks/email-provider/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    body,
  });
}

function emailEvent(type: string, tags: Record<string, string> | undefined = { partner_id: PARTNER }) {
  return { type, created_at: '2026-09-17T12:00:00.000Z', data: { email_id: 'e1', from: 'x@acme.test', to: ['y@z.test'], subject: 's', created_at: '2026-09-17T12:00:00.000Z', tags } };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.length = 0;
  configMock.mockReturnValue({ webhookSecret: SECRET });
  redisRef.value = { set: redisSet };
  redisSet.mockResolvedValue('OK');
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
  incrementMock.mockResolvedValue(true);
});

describe('inertness', () => {
  it('404s and does NO work when EMAIL_DOMAINS_WEBHOOK_SECRET is unset', async () => {
    configMock.mockReturnValue({ webhookSecret: null });
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(404);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    // The limiter is the ONLY thing allowed to run before the secret check.
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });
});

describe('signature', () => {
  it('202s a correctly signed event', async () => {
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(202);
  });

  it('401s a payload signed with another secret', async () => {
    const other = `whsec_${Buffer.from('a-different-thirty-two-byte-key!').toString('base64')}`;
    const res = await post(emailEvent('email.delivered'), { secret: other });
    expect(res.status).toBe(401);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('401s a stale timestamp', async () => {
    const res = await post(emailEvent('email.delivered'), { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
    expect(res.status).toBe(401);
  });

  it('401s missing svix headers', async () => {
    const res = await app().request('/webhooks/email-provider/resend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // An unauthenticated caller must never be able to burn a dedupe key.
  it('does not reserve the svix-id before the signature is verified', async () => {
    await post(emailEvent('email.delivered'), { signature: 'v1,bogus' });
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('rate limiting and replay', () => {
  it('429s when the per-IP limiter refuses', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(429);
  });

  it('202s but does NOT count a redelivery of the same svix-id', async () => {
    redisSet.mockResolvedValue(null); // SET … NX lost the race
    const res = await post(emailEvent('email.bounced'));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  // 503 makes svix retry; processing without the guard would double-count.
  it('503s when Redis cannot answer, so the provider retries', async () => {
    redisRef.value = null;
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(503);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('503s when the Redis reservation throws', async () => {
    redisSet.mockRejectedValue(new Error('ECONNRESET'));
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(503);
  });
});

describe('event handling', () => {
  it.each([
    ['email.sent', 'sent'],
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.failed', 'failed'],
    ['email.suppressed', 'suppressed'],
  ])('%s increments the %s counter for the tagged partner', async (type, column) => {
    const res = await post(emailEvent(type));
    expect(res.status).toBe(202);
    expect(incrementMock).toHaveBeenCalledWith(PARTNER, column, expect.any(Date));
  });

  it('enqueues an auto-suspend evaluation after a bounce and after a complaint', async () => {
    await post(emailEvent('email.bounced'));
    expect(enqueueAutoSuspendMock).toHaveBeenCalledWith(PARTNER);
    enqueueAutoSuspendMock.mockClear();
    await post(emailEvent('email.complained'));
    expect(enqueueAutoSuspendMock).toHaveBeenCalledWith(PARTNER);
  });

  it('does NOT enqueue an evaluation after a delivered or sent event', async () => {
    await post(emailEvent('email.delivered'));
    await post(emailEvent('email.sent'));
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  it('ignores an event type it does not handle, with a 202', async () => {
    const res = await post(emailEvent('email.opened'));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('counts nothing when the event carries no tags at all', async () => {
    const res = await post(emailEvent('email.bounced', undefined));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  it('counts nothing when partner_id is not a UUID', async () => {
    const res = await post(emailEvent('email.bounced', { partner_id: 'not-a-uuid' }));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  // The statement's row source is a SELECT over partners, so a forged but
  // well-formed id simply affects no rows — and must not enqueue an evaluation.
  it('does not enqueue an evaluation for a partner id that matched no partner', async () => {
    incrementMock.mockResolvedValue(false);
    const res = await post(emailEvent('email.bounced'));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });
});

describe('domain.updated', () => {
  it('enqueues sync-domain for the matching local row', async () => {
    selectRows.push([{ id: DOMAIN_ID }]);
    const res = await post({
      type: 'domain.updated', created_at: '2026-09-17T12:00:00.000Z',
      data: { id: 'prov-abc', name: 'mail.acme.test', status: 'verified', created_at: '2026-09-01T00:00:00.000Z', region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('202s and enqueues nothing when no local row owns that provider domain id', async () => {
    selectRows.push([]);
    const res = await post({
      type: 'domain.updated', created_at: '2026-09-17T12:00:00.000Z',
      data: { id: 'prov-unknown', name: 'someone-else.test', status: 'verified', created_at: '2026-09-01T00:00:00.000Z', region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });
});

describe('malformed payloads', () => {
  it('400s a body that is not JSON', async () => {
    const body = 'not json';
    const id = 'msg_bad';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    const res = await app().request('/webhooks/email-provider/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('400s a JSON body with no string `type`', async () => {
    const res = await post({ data: {} });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/routes/webhooks/emailProvider.test.ts
```
Expected failure: `Cannot find module './emailProvider'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/webhooks/emailProvider.ts`:

```ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains } from '../../db/schema';
import { enqueueAutoSuspendEvaluation, enqueueSyncDomain } from '../../jobs/sendingDomainsWorker';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { getEmailDomainsConfig } from '../../services/emailDomains/config';
import { incrementPartnerSendingStat, type DeliveryStatColumn } from '../../services/emailDomains/deliveryStats';
import { verifySvixSignature } from '../../services/emailDomains/webhookSignature';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { captureException } from '../../services/sentry';

/**
 * Resend delivery webhook (spec §9.3). PUBLIC and unauthenticated: the Svix
 * signature is the credential.
 *
 * Order of operations, and why each step is where it is:
 *
 *  1. Per-IP limiter. Fails CLOSED (Redis down -> 429), which makes the
 *     provider retry rather than letting an outage open the endpoint up.
 *  2. Secret check -> 404 when unset. NOT 401 and NOT 503: on an instance that
 *     never configured the feature this endpoint does not exist, and a 5xx
 *     would make a misdirected caller retry forever. This is spec §9.3's
 *     "inert unless EMAIL_DOMAINS_WEBHOOK_SECRET is set".
 *  3. Raw body via `await c.req.text()` — the signature covers the exact bytes,
 *     so nothing may consume the body first. This is why no body-consuming
 *     middleware may be mounted in front of this route (see index.ts).
 *  4. Signature. An unauthenticated caller must never get past here, in
 *     particular never far enough to reserve a dedupe key.
 *  5. Replay reservation on `svix-id`. Svix delivers AT LEAST once, so a
 *     redelivery of an already-counted event would inflate every counter the
 *     auto-suspension thresholds read. Redis unavailable -> 503, so the
 *     provider retries: silently processing without the guard trades a retry
 *     for permanently wrong numbers.
 *  6. Handle, then 202. The handler never calls the provider — `domain.updated`
 *     only enqueues `sync-domain`, and a bounce/complaint only enqueues
 *     `evaluate-auto-suspend`. All provider calls live in the worker (spec §2).
 *
 * ATTRIBUTION. Events are attributed by the `partner_id` provider tag W03 sets
 * on every partner-lane message. The tag is never trusted beyond an existence
 * check: it must parse as a UUID, and the increment statement's row source is a
 * SELECT over `partners`, so an id that matches no partner counts nowhere. A
 * fallback message (platform lane) carries no tags at all, so it produces no
 * attributable event by construction.
 *
 * DB CONTEXT. There is no ambient auth transaction on a public route, so every
 * read and write opens its own `withSystemDbAccessContext`. `runOutsideDbContext`
 * is deliberately NOT used: it does not close an outer transaction, and there is
 * no outer transaction here to close.
 */

export const resendWebhookRoutes = new Hono();

const RATE_LIMIT = 600;
const RATE_WINDOW_SECONDS = 60;
/** Comfortably past Svix's retry schedule, so a late redelivery is still caught. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The events this endpoint counts. `email.sent` is the ONLY source of the
 * `sent` column: the send path is forbidden from writing a partner-axis table,
 * so subscribing this event on the provider webhook is what populates the rate
 * denominator (spec §9.3 + W03's Global Constraints).
 */
const EVENT_COLUMN: Readonly<Record<string, DeliveryStatColumn>> = Object.freeze({
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
});

/** Events that can move a partner across the spec §9.3 thresholds. */
const EVALUATES_AUTO_SUSPENSION: ReadonlySet<string> = new Set(['email.bounced', 'email.complained']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookEnvelope {
  type: string;
  data?: {
    tags?: Record<string, unknown> | null;
    id?: unknown;
    name?: unknown;
  } | null;
}

/** One log line per unknown tag value per process, so a misconfiguration is visible but not a flood. */
const loggedUnknownTags = new Set<string>();
function logUnknownTagOnce(reason: string, value: string): void {
  const key = `${reason}:${value}`;
  if (loggedUnknownTags.has(key)) return;
  if (loggedUnknownTags.size > 500) loggedUnknownTags.clear();
  loggedUnknownTags.add(key);
  console.warn('[emailProviderWebhook] event not attributable to a partner', { reason, value });
}

resendWebhookRoutes.post('/email-provider/resend', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(
    getRedis(),
    `email-domains-webhook:${rateLimitIpKey(ip)}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  );
  if (!rate.allowed) return c.json({ error: 'Too Many Requests' }, 429);

  const secret = getEmailDomainsConfig().webhookSecret;
  if (!secret) {
    // Inert. No body read, no Redis, no database.
    return c.json({ error: 'Not Found' }, 404);
  }

  // The signature covers these exact bytes — read them before anything else.
  const raw = await c.req.text();

  const verified = verifySvixSignature(
    {
      id: c.req.header('svix-id') ?? null,
      timestamp: c.req.header('svix-timestamp') ?? null,
      signature: c.req.header('svix-signature') ?? null,
    },
    raw,
    secret,
  );
  if (!verified.ok) {
    console.warn('[emailProviderWebhook] rejected delivery', { reason: verified.reason });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Svix is at-least-once. Reserve the message id BEFORE doing any counting.
  const svixId = (c.req.header('svix-id') ?? '').trim();
  const redis = getRedis();
  if (!redis) {
    console.error('[emailProviderWebhook] Redis unavailable; asking the provider to retry');
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  let reserved: string | null;
  try {
    reserved = await redis.set(`emaildomains:webhook:${svixId}`, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
  } catch (err) {
    console.error('[emailProviderWebhook] replay reservation failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Service Unavailable' }, 503);
  }
  if (reserved !== 'OK') {
    // Already processed. 202 so the provider stops retrying.
    return c.json({ received: true, duplicate: true }, 202);
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(raw) as WebhookEnvelope;
  } catch {
    return c.json({ error: 'Bad Request' }, 400);
  }
  if (typeof envelope?.type !== 'string' || envelope.type.length === 0) {
    return c.json({ error: 'Bad Request' }, 400);
  }

  try {
    if (envelope.type === 'domain.updated') {
      await handleDomainUpdated(envelope);
    } else {
      await handleEmailEvent(envelope);
    }
  } catch (err) {
    console.error('[emailProviderWebhook] handler error', envelope.type, err instanceof Error ? err.message : err);
    captureException(
      err instanceof Error ? err : new Error(`[emailProviderWebhook] handler error for ${envelope.type}: ${String(err)}`),
      c,
    );
    // 500 so the provider retries. The svix-id reservation is already held, so
    // a retry would be deduped — which is the correct trade: delivery stats are
    // advisory, and double-counting them would move a kill switch.
    return c.json({ error: 'Handler error' }, 500);
  }

  return c.json({ received: true }, 202);
});

async function handleEmailEvent(envelope: WebhookEnvelope): Promise<void> {
  const column = EVENT_COLUMN[envelope.type];
  // email.opened / email.clicked / email.scheduled / email.delivery_delayed and
  // the contact.* and domain.created/deleted families are simply not counted.
  if (!column) return;

  const rawTag = envelope.data?.tags?.partner_id;
  if (typeof rawTag !== 'string' || rawTag.length === 0) {
    logUnknownTagOnce('missing_partner_tag', envelope.type);
    return;
  }
  if (!UUID_RE.test(rawTag)) {
    logUnknownTagOnce('malformed_partner_tag', rawTag.slice(0, 64));
    return;
  }

  const counted = await incrementPartnerSendingStat(rawTag, column, new Date());
  if (!counted) {
    logUnknownTagOnce('unknown_partner', rawTag);
    return;
  }

  if (EVALUATES_AUTO_SUSPENSION.has(envelope.type)) {
    // jobId = autosuspend:<partnerId>, so a bounce storm collapses into one
    // evaluation instead of one per message.
    await enqueueAutoSuspendEvaluation(rawTag);
  }
}

async function handleDomainUpdated(envelope: WebhookEnvelope): Promise<void> {
  const providerDomainId = envelope.data?.id;
  if (typeof providerDomainId !== 'string' || providerDomainId.length === 0) return;

  const rows = await withSystemDbAccessContext(() => db
    .select({ id: partnerSendingDomains.id })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.providerDomainId, providerDomainId))
    .limit(1), 'emailProviderWebhookDomainLookup') as Array<{ id: string }>;

  const row = rows[0];
  if (!row) {
    // A provider domain Breeze does not know about. The daily drift report
    // (W02b) owns that case; the webhook says nothing.
    return;
  }
  // The worker re-reads the domain from the provider and maps the status. The
  // event's own `status` field is deliberately ignored: one mapper, one place.
  await enqueueSyncDomain(row.id);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/routes/webhooks/emailProvider.test.ts
```
Expected: `Test Files 1 passed (1)`, 24 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/routes/webhooks/emailProvider.ts apps/api/src/routes/webhooks/emailProvider.test.ts
git commit -m "feat(email-domains): POST /webhooks/email-provider/resend

Public, Svix-signature-verified delivery webhook (spec §9.3). Inert with a 404
when EMAIL_DOMAINS_WEBHOOK_SECRET is unset — no body read, no Redis, no
database. Per-IP limiter fails closed to 429; a Redis outage answers 503 so the
provider retries rather than letting an at-least-once redelivery double-count.
Events are attributed by the partner_id tag, which is never trusted beyond a
UUID check plus the increment statement's own existence check. The route never
calls the provider: domain.updated enqueues sync-domain, a bounce or complaint
enqueues evaluate-auto-suspend.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Mount the route and satisfy every mount contract

**Files:**
- Modify: `apps/api/src/index.ts` — one import beside
  `import { quickbooksWebhookRoutes } from './routes/webhooks/quickbooks';`
  (`:42`), one `api.route(...)` immediately after
  `api.route('/webhooks', quickbooksWebhookRoutes);` (`:921`)
- Modify: `apps/api/src/middleware/globalRateLimit.ts` — one entry in
  `ISOLATED_BUCKETS` (`:63-81`)
- Modify: `apps/api/src/__tests__/routerAuthGate.contract.test.ts` — one `EXEMPT`
  entry beside `quickbooksWebhookRoutes` (`:31`)
- Modify: `apps/api/src/routes/webhooks.mountOrder.test.ts` — one case proving
  the public route survives the shared `/webhooks` prefix
- Create: `apps/api/src/routes/webhooks/emailProviderMounting.test.ts`

**Interfaces:**
- Consumes: `resendWebhookRoutes` (Task 7).
- Produces: `POST /api/v1/webhooks/email-provider/resend` reachable through the
  real composition root.

- [ ] **Step 1: Write the failing mounting test**

Create `apps/api/src/routes/webhooks/emailProviderMounting.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
const routeSource = readFileSync(join(__dirname, 'emailProvider.ts'), 'utf8');
const globalRateLimitSource = readFileSync(
  join(__dirname, '..', '..', 'middleware', 'globalRateLimit.ts'),
  'utf8',
);

describe('index.ts mounts the delivery webhook', () => {
  it('imports and mounts resendWebhookRoutes', () => {
    expect(indexSource).toContain("import { resendWebhookRoutes } from './routes/webhooks/emailProvider';");
    expect(indexSource).toContain("api.route('/webhooks', resendWebhookRoutes);");
  });

  // Hono flattens .route() mounts, so a wildcard auth middleware on the
  // session-authenticated webhookRoutes would 401 this public sibling before
  // the signature handler ever ran (issue #2053).
  it('mounts it AFTER the CRUD webhookRoutes, like every other public webhook', () => {
    const crud = indexSource.indexOf("api.route('/webhooks', webhookRoutes);");
    const resend = indexSource.indexOf("api.route('/webhooks', resendWebhookRoutes);");
    expect(crud).toBeGreaterThan(-1);
    expect(resend).toBeGreaterThan(crud);
  });

  it('gives the endpoint its own global-rate-limit bucket', () => {
    expect(globalRateLimitSource).toContain("prefix: '/api/v1/webhooks/email-provider/'");
  });
});

describe('the delivery webhook never reaches the provider', () => {
  // Spec §2: request handlers write intent rows and enqueue; the worker owns
  // every provider call. A dynamic import would defeat a naive grep, so check
  // both forms.
  it.each(['providerRegistry', 'adapters/resend', 'adapters/static', 'adapters/fake', 'resend'])(
    'does not import %s, statically or dynamically',
    (moduleName) => {
      expect(routeSource).not.toMatch(new RegExp(`from\\s+['"][^'"]*${moduleName}['"]`));
      expect(routeSource).not.toMatch(new RegExp(`import\\s*\\(\\s*['"][^'"]*${moduleName}['"]`));
    },
  );

  it('does not use runOutsideDbContext — there is no outer transaction on a public route', () => {
    expect(routeSource).not.toContain('runOutsideDbContext');
    expect(routeSource).toContain('withSystemDbAccessContext');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/routes/webhooks/emailProviderMounting.test.ts src/__tests__/routerAuthGate.contract.test.ts
```
Expected: the three `index.ts` / rate-limit assertions FAIL (`expected … to
contain …`). `routerAuthGate.contract.test.ts` still passes at this point,
because the mount does not exist yet.

- [ ] **Step 3: Mount it**

In `apps/api/src/index.ts`, beside the QuickBooks webhook import (`:42`):
```ts
import { resendWebhookRoutes } from './routes/webhooks/emailProvider';
```

and immediately after `api.route('/webhooks', quickbooksWebhookRoutes);` (`:921`):
```ts
// Resend delivery webhook for partner sending domains (W05) — no session auth,
// Svix-signature-verified, and inert with a 404 when EMAIL_DOMAINS_WEBHOOK_SECRET
// is unset. partnerGuard passes through (no Authorization header); the route
// reads the raw body itself via c.req.text(), so no body-consuming middleware may
// sit in front of it. NOT in SELF_MANAGED_DB_CONTEXT_ROUTES: there is no ambient
// auth transaction to opt out of on an unauthenticated route.
api.route('/webhooks', resendWebhookRoutes);
```

In `apps/api/src/middleware/globalRateLimit.ts`, append to `ISOLATED_BUCKETS`:
```ts
  // Partner sending-domain delivery events (W05). One provider egress IP
  // delivers every partner's bounces, complaints and deliveries, so on the
  // shared 300/min per-IP budget a busy partner lane would throttle dashboard
  // traffic that happens to share an egress address — and vice versa. The
  // route carries its own 600/min limiter and rejects anything unsigned, so
  // this bucket only needs to stay out of runaway territory.
  { prefix: '/api/v1/webhooks/email-provider/', name: 'emaildomainswebhook', limit: 1200 },
```

In `apps/api/src/__tests__/routerAuthGate.contract.test.ts`, add one `EXEMPT`
entry immediately after the `quickbooksWebhookRoutes` line (`:31`):
```ts
  resendWebhookRoutes: 'Resend delivery webhook authenticates provider signatures (Svix).',
```

In `apps/api/src/routes/webhooks.mountOrder.test.ts`, add one case to the
existing describe (the file already builds the real `/webhooks` topology):
```ts
  it('the Svix-signed delivery webhook is reachable under the shared /webhooks prefix', async () => {
    const { resendWebhookRoutes } = await import('./webhooks/emailProvider');
    const app = new Hono();
    app.route('/webhooks', webhookRoutes);          // session-auth CRUD, mounted FIRST
    app.route('/webhooks', resendWebhookRoutes);    // public, mounted after
    const res = await app.request('/webhooks/email-provider/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // Anything but 401-with-"Missing or invalid authorization header" proves the
    // CRUD router's auth did not blanket the public sibling. With no secret
    // configured in this suite's env the route is inert, so 404 is the answer.
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 4: Run every mount contract green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/routes/webhooks/emailProviderMounting.test.ts src/routes/webhooks.mountOrder.test.ts src/__tests__/routerAuthGate.contract.test.ts src/middleware/globalRateLimit.test.ts
```
Expected: all PASS. `routerAuthGate.contract.test.ts` must pass with the new
`EXEMPT` entry present — its `discovers every mount and keeps exemptions
explicit and current` case asserts both that every mount is found and that every
`EXEMPT` key still corresponds to a live mount.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/index.ts apps/api/src/middleware/globalRateLimit.ts apps/api/src/__tests__/routerAuthGate.contract.test.ts apps/api/src/routes/webhooks.mountOrder.test.ts apps/api/src/routes/webhooks/emailProviderMounting.test.ts
git commit -m "feat(email-domains): mount the Resend delivery webhook

Mounted after the session-authenticated /webhooks CRUD router, the same
topology every other public webhook uses, with a regression case in
webhooks.mountOrder.test.ts. Registered in routerAuthGate's EXEMPT map (there is
no PUBLIC_ROUTES array in this API — public-ness is structural) and given its
own isolated global-rate-limit bucket so one provider egress IP cannot throttle
dashboard traffic. A source scan pins that the route imports no provider
adapter and no registry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: Make the daily-cap hit readable

W03 leaves `recordPartnerLaneCapHit(partnerId: string): void` as a
`console.warn` with the comment *"W05 owns the abuse-signal producer (spec §9.2)
and wires it here"*. This task is that wiring.

**Decision, and why:** the record goes into a **Redis day-hash**, not a row.
Three facts force it.
1. `recordPartnerLaneCapHit` is **synchronous and returns `void`**, called from
   `tryCountPartnerLaneSend` on the send path — it cannot await a database write
   without changing W03's signature and making every send await one more round
   trip.
2. W03's Global Constraints say verbatim that the send path never writes a
   partner-axis table, and `partner-wide-write-coverage.test.ts` enforces it for
   any file under `src/services/**`.
3. The consumer is the fleet-wide abuse sweep, which needs "every partner that
   hit the cap in the last 7 days". Keying the hash by **day** (`field =
   partnerId`) answers that with 7 bounded `HGETALL` calls — no `SCAN`, no
   partner enumeration. Keying it by partner would force one of the two.

Losing a record to a Redis outage is acceptable and consistent: W03 already
refuses to record a cap hit when Redis cannot answer, precisely so our own
outage cannot manufacture an abuse signal.

**Files:**
- Create: `apps/api/src/services/emailDomains/capHits.ts`
- Create: `apps/api/src/services/emailDomains/capHits.test.ts`
- Modify: `apps/api/src/services/emailDomains/sendCap.ts` (created by W03 Task 1)
- Modify: `apps/api/src/services/emailDomains/sendCap.test.ts` (created by W03 Task 1)

**Interfaces:**
- Consumes: `getRedis` (`../redis`).
- Produces:
  ```ts
  export const CAP_HIT_WINDOW_DAYS: number;      // 7, matching STATS_WINDOW_DAYS
  export function capHitDayKey(day: string): string;   // `email-domains:cap-hits:<YYYY-MM-DD>`
  /** Fire-and-forget; never throws, never awaited by the send path. */
  export function recordCapHit(partnerId: string, now?: Date): void;
  /** partnerId -> hits across the trailing CAP_HIT_WINDOW_DAYS days. */
  export async function loadCapHitWindow(now?: Date): Promise<Map<string, number>>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/emailDomains/capHits.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));

import { CAP_HIT_WINDOW_DAYS, capHitDayKey, loadCapHitWindow, recordCapHit } from './capHits';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-17T09:00:00.000Z');

function multiChain(execResult: unknown = [[null, 1], [null, 1]]) {
  const chain = {
    hincrby: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec: vi.fn(async () => execResult),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('capHitDayKey', () => {
  it('namespaces by UTC day so one HGETALL covers the whole fleet for that day', () => {
    expect(capHitDayKey('2026-09-17')).toBe('email-domains:cap-hits:2026-09-17');
  });
});

describe('recordCapHit', () => {
  it('HINCRBYs the partner field on today\'s hash and sets an expiry past the window', () => {
    const chain = multiChain();
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    recordCapHit(PARTNER, NOW);
    expect(chain.hincrby).toHaveBeenCalledWith('email-domains:cap-hits:2026-09-17', PARTNER, 1);
    // 8 days: one clear day past the 7-day read window.
    expect(chain.expire).toHaveBeenCalledWith('email-domains:cap-hits:2026-09-17', 8 * 24 * 60 * 60);
  });

  // The send path calls this synchronously; it must never throw into a send.
  it('returns void and swallows a Redis constructor failure', () => {
    getRedisMock.mockImplementation(() => { throw new Error('ECONNRESET'); });
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
  });

  it('swallows a rejected exec without an unhandled rejection', async () => {
    const chain = multiChain();
    chain.exec.mockRejectedValue(new Error('down'));
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('is a silent no-op when Redis is unavailable', () => {
    getRedisMock.mockReturnValue(null);
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
  });
});

describe('loadCapHitWindow', () => {
  it('sums the trailing window across days, one HGETALL per day and no SCAN', async () => {
    const hgetall = vi.fn(async (key: string) => (
      key.endsWith('2026-09-17') ? { [PARTNER]: '2' }
        : key.endsWith('2026-09-15') ? { [PARTNER]: '3', other: '1' }
        : {}
    ));
    getRedisMock.mockReturnValue({ hgetall, scan: vi.fn(), keys: vi.fn() });
    const window = await loadCapHitWindow(NOW);
    expect(hgetall).toHaveBeenCalledTimes(CAP_HIT_WINDOW_DAYS);
    expect(window.get(PARTNER)).toBe(5);
    expect(window.get('other')).toBe(1);
  });

  it('reads exactly the same 7 UTC days the stats window covers', async () => {
    const hgetall = vi.fn(async () => ({}));
    getRedisMock.mockReturnValue({ hgetall });
    await loadCapHitWindow(NOW);
    const keys = hgetall.mock.calls.map((call) => call[0]);
    expect(keys).toEqual([
      'email-domains:cap-hits:2026-09-11',
      'email-domains:cap-hits:2026-09-12',
      'email-domains:cap-hits:2026-09-13',
      'email-domains:cap-hits:2026-09-14',
      'email-domains:cap-hits:2026-09-15',
      'email-domains:cap-hits:2026-09-16',
      'email-domains:cap-hits:2026-09-17',
    ]);
  });

  it('returns an empty map when Redis is unavailable rather than throwing into the sweep', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(loadCapHitWindow(NOW)).resolves.toEqual(new Map());
  });

  it('returns an empty map when a read throws', async () => {
    getRedisMock.mockReturnValue({ hgetall: vi.fn(async () => { throw new Error('down'); }) });
    await expect(loadCapHitWindow(NOW)).resolves.toEqual(new Map());
  });

  it('ignores a non-numeric field value', async () => {
    getRedisMock.mockReturnValue({ hgetall: vi.fn(async () => ({ [PARTNER]: 'NaN' })) });
    const window = await loadCapHitWindow(NOW);
    expect(window.get(PARTNER)).toBeUndefined();
  });
});
```

Append to `apps/api/src/services/emailDomains/sendCap.test.ts` (and add
`vi.mock('./capHits', () => ({ recordCapHit: recordCapHitMock }));` with a
`vi.hoisted` `recordCapHitMock` beside the file's existing hoisted block):

```ts
describe('recordPartnerLaneCapHit wiring (W05)', () => {
  it('records the hit for the abuse producer on a genuine over-cap count', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).toHaveBeenCalledWith(PARTNER);
  });

  // W03's invariant, re-pinned now that the hit has a consumer: an outage must
  // never be able to manufacture an abuse signal against a partner.
  it('records NOTHING when Redis is unavailable', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(null);
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).not.toHaveBeenCalled();
  });

  it('records NOTHING for a send comfortably under the cap', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 2000 });
    getRedisMock.mockReturnValue(redisWithCount(3));
    await tryCountPartnerLaneSend(PARTNER);
    expect(recordCapHitMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/capHits.test.ts src/services/emailDomains/sendCap.test.ts
```
Expected: `capHits.test.ts` fails to load (`Cannot find module './capHits'`), and
the three new `sendCap.test.ts` cases fail on
`expect(recordCapHitMock).toHaveBeenCalledWith(...)` because
`recordPartnerLaneCapHit` still only logs.

- [ ] **Step 3: Implement `capHits.ts`**

Create `apps/api/src/services/emailDomains/capHits.ts`:

```ts
import { getRedis } from '../redis';

/**
 * Daily partner-lane cap hits, recorded for the abuse sweep (spec §9.2).
 *
 * WHY REDIS AND NOT A TABLE. The recorder is called from the SEND PATH, through
 * W03's synchronous `recordPartnerLaneCapHit(partnerId): void`. The send path is
 * forbidden from writing a partner-axis table (W03 Global Constraints, enforced
 * by partner-wide-write-coverage.test.ts), and a `void` function cannot await a
 * database write anyway.
 *
 * WHY KEYED BY DAY AND NOT BY PARTNER. The only consumer is the fleet-wide abuse
 * sweep, which asks "who hit the cap in the last 7 days". A hash per day, with
 * the partner id as the field, answers that with 7 bounded HGETALLs. A key per
 * partner would force either a SCAN over the keyspace or a full partner
 * enumeration on every sweep.
 *
 * A Redis outage silently drops a record, which is the correct direction and
 * matches W03: `tryCountPartnerLaneSend` already declines to report a cap hit
 * when Redis cannot answer, so our own outage can never accuse a partner.
 */

/** Matches deliveryStats.STATS_WINDOW_DAYS; both feed spec §9.2/§9.3 windows. */
export const CAP_HIT_WINDOW_DAYS = 7;

/** One clear day past the read window, so a sweep at the edge still sees day 7. */
const CAP_HIT_TTL_SECONDS = (CAP_HIT_WINDOW_DAYS + 1) * 24 * 60 * 60;

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function capHitDayKey(day: string): string {
  return `email-domains:cap-hits:${day}`;
}

/**
 * Fire-and-forget. Returns immediately; the write is not awaited and every
 * failure path is swallowed, because the caller is a send in flight.
 */
export function recordCapHit(partnerId: string, now: Date = new Date()): void {
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = capHitDayKey(utcDay(now));
    void redis
      .multi()
      .hincrby(key, partnerId, 1)
      .expire(key, CAP_HIT_TTL_SECONDS)
      .exec()
      .catch((err: unknown) => {
        console.warn(
          '[emailDomains/capHits] failed to record a cap hit:',
          err instanceof Error ? err.message : err,
        );
      });
  } catch (err) {
    console.warn(
      '[emailDomains/capHits] failed to record a cap hit:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** partnerId -> total cap hits across the trailing CAP_HIT_WINDOW_DAYS UTC days. */
export async function loadCapHitWindow(now: Date = new Date()): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  try {
    const redis = getRedis();
    if (!redis) return totals;
    for (let offset = CAP_HIT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const day = new Date(now.getTime());
      day.setUTCDate(day.getUTCDate() - offset);
      const entries = await redis.hgetall(capHitDayKey(utcDay(day)));
      for (const [partnerId, raw] of Object.entries(entries ?? {})) {
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) continue;
        totals.set(partnerId, (totals.get(partnerId) ?? 0) + value);
      }
    }
  } catch (err) {
    // The sweep must keep running: an unreadable cap-hit window means "no cap
    // signal this pass", never a failed sweep for every other detector.
    console.warn(
      '[emailDomains/capHits] failed to read the cap-hit window:',
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }
  return totals;
}
```

- [ ] **Step 4: Wire it into `sendCap.ts`**

In `apps/api/src/services/emailDomains/sendCap.ts`, add the import:
```ts
import { recordCapHit } from './capHits';
```

and replace the body of `recordPartnerLaneCapHit` (keeping its signature and
docblock, and extending the docblock's last paragraph):

```ts
export function recordPartnerLaneCapHit(partnerId: string): void {
  console.warn('[emailDomains/sendCap] daily partner-lane cap reached', { partnerId });
  // W05: make the hit readable by the abuse sweep (spec §9.2). Fire-and-forget
  // into a Redis day-hash — this runs on the send path, which must not await a
  // write and must not write a partner-axis table.
  recordCapHit(partnerId);
}
```

- [ ] **Step 5: Run it and watch it pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/capHits.test.ts src/services/emailDomains/sendCap.test.ts src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: all PASS. `partner-wide-write-coverage.test.ts` needs no new entry:
neither file touches a table.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/capHits.ts apps/api/src/services/emailDomains/capHits.test.ts apps/api/src/services/emailDomains/sendCap.ts apps/api/src/services/emailDomains/sendCap.test.ts
git commit -m "feat(email-domains): record daily-cap hits for the abuse sweep

W03 left recordPartnerLaneCapHit as a log line for W05 to wire. It now also
HINCRBYs a Redis hash keyed by UTC DAY with the partner id as the field, so the
fleet-wide sweep reads a 7-day window with seven HGETALLs and never needs SCAN.
Redis, not a row: the recorder is synchronous, sits on the send path, and the
send path may not write a partner-axis table. An outage still records nothing,
so it can never manufacture a signal against a partner.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: The sending-domain abuse-signal producer

Spec §9.2: *"a `ComputedSignal` producer under `services/abuseSignals/`, wired
into `runAbuseSweep`: sending domain added (with the domain name, for human
review of lookalikes), repeated failed verifications, daily cap hit, bounce or
complaint threshold crossed."*

**Files:**
- Create: `apps/api/src/services/abuseSignals/sendingDomains.ts`
- Create: `apps/api/src/services/abuseSignals/sendingDomains.test.ts`
- Modify: `apps/api/src/services/abuseSignals/config.ts` — nine `SIGNAL_DEFAULTS` keys
- Modify: `apps/api/src/services/abuseSignals/index.ts` — the four wiring points
- Modify: `apps/api/src/services/abuseSignals/corroboration.ts` — four `SIGNAL_AXIS` entries
- Modify: `apps/api/src/services/abuseSignals/corroboration.test.ts` — four `EMITTED_KEYS` entries
- Modify: `apps/api/src/services/abuseSignals/sweep.test.ts` — the new module's mock

**Interfaces:**
- Consumes: `db` (`../../db`), `sql` (`drizzle-orm`), `loadCapHitWindow`
  (`../emailDomains/capHits`, Task 9), `SignalConfig` / `scoreToSeverity`
  (`./config`), `ComputedSignal` (`./types`).
- Produces:
  ```ts
  export interface SendingDomainAggregate {
    partnerId: string;
    partnerName: string;
    /** Domains added inside the added-window, newest first, name included for lookalike review. */
    recentDomains: Array<{ domain: string; createdAt: Date }>;
    /** Rows currently `failed` with a DNS reason, and their accumulated attempts. */
    failedVerifications: Array<{ domain: string; checkAttempts: number; statusReason: string | null }>;
    capHits: number;
    windowSent: number; windowDelivered: number; windowBounced: number;
    windowComplained: number; windowFailed: number;
    windowMessages: number; windowBounceRate: number;
  }
  export async function loadSendingDomainAggregates(now?: Date): Promise<{
    aggregates: SendingDomainAggregate[];
    scannedPartnerIds: string[];
  }>;
  export function computeSendingDomainSignals(
    aggregates: SendingDomainAggregate[], cfg: SignalConfig,
  ): ComputedSignal[];
  ```

Signal keys (all ≤ 64 characters, the `signal_key varchar(64)` limit):

| Key | Severity intent | Why |
|---|---|---|
| `email.sending_domain_added` | info (25) | Pure visibility: a human reviews the NAME for a lookalike. Never accuses on its own, and at `info` it cannot corroborate. |
| `email.sending_domain_verify_failures` | watch (45) | Repeated failed verifications is what squatting or probing a name you do not control looks like (spec §4.3). |
| `email.partner_lane_cap_hit` | watch (45) | Blasting past the daily cap. |
| `email.sending_bounce_complaint` | watch (65), capped below alert | Auto-suspension already raised an ops alert for the same facts; a second page would be noise. Left at `watch` so it can corroborate. |

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/abuseSignals/sendingDomains.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadSignalConfig } from './config';
import { computeSendingDomainSignals, type SendingDomainAggregate } from './sendingDomains';

vi.mock('../../db', () => ({ db: { execute: vi.fn() } }));
vi.mock('../emailDomains/capHits', () => ({ CAP_HIT_WINDOW_DAYS: 7, loadCapHitWindow: vi.fn() }));

const cfg = loadSignalConfig();

function agg(over: Partial<SendingDomainAggregate> = {}): SendingDomainAggregate {
  return {
    partnerId: 'p1',
    partnerName: 'Acme MSP',
    recentDomains: [],
    failedVerifications: [],
    capHits: 0,
    windowSent: 0, windowDelivered: 0, windowBounced: 0,
    windowComplained: 0, windowFailed: 0,
    windowMessages: 0, windowBounceRate: 0,
    ...over,
  };
}

function keys(signals: ReturnType<typeof computeSendingDomainSignals>): string[] {
  return signals.map((s) => s.signalKey).sort();
}

describe('computeSendingDomainSignals — nothing to say', () => {
  it('emits nothing for a partner with no sending activity at all', () => {
    expect(computeSendingDomainSignals([agg()], cfg)).toEqual([]);
  });
});

describe('email.sending_domain_added', () => {
  it('fires at info severity and carries the domain NAME for lookalike review', () => {
    const signals = computeSendingDomainSignals([agg({
      recentDomains: [{ domain: 'acrne-bank.test', createdAt: new Date('2026-09-16T00:00:00Z') }],
    })], cfg);
    expect(keys(signals)).toEqual(['email.sending_domain_added']);
    expect(signals[0]!.severity).toBe('info');
    expect(signals[0]!.evidence.domains).toEqual(['acrne-bank.test']);
    expect(signals[0]!.evidence.partnerName).toBe('Acme MSP');
  });

  it('caps the evidence list so one partner cannot flood an alert body', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ domain: `d${i}.test`, createdAt: new Date() }));
    const signals = computeSendingDomainSignals([agg({ recentDomains: many })], cfg);
    expect((signals[0]!.evidence.domains as string[]).length).toBeLessThanOrEqual(10);
    expect(signals[0]!.evidence.addedCount).toBe(40);
  });
});

describe('email.sending_domain_verify_failures', () => {
  it('does not fire below the configured minimum', () => {
    const signals = computeSendingDomainSignals([agg({
      failedVerifications: [{ domain: 'a.test', checkAttempts: 4, statusReason: 'dns_not_detected' }],
    })], cfg);
    expect(keys(signals)).not.toContain('email.sending_domain_verify_failures');
  });

  it('fires at watch severity at exactly the minimum', () => {
    const failed = Array.from({ length: cfg['email.sending_domain_verify_failures.min_domains'] }, (_, i) => ({
      domain: `f${i}.test`, checkAttempts: 9, statusReason: 'dns_not_detected',
    }));
    const signals = computeSendingDomainSignals([agg({ failedVerifications: failed })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_domain_verify_failures');
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('watch');
    expect(signal!.evidence.failedDomains).toEqual(failed.map((f) => f.domain).slice(0, 10));
  });
});

describe('email.partner_lane_cap_hit', () => {
  it('does not fire below the configured minimum hits', () => {
    const signals = computeSendingDomainSignals([agg({ capHits: 1 })], cfg);
    expect(keys(signals)).not.toContain('email.partner_lane_cap_hit');
  });

  it('fires at watch severity at exactly the minimum hits', () => {
    const signals = computeSendingDomainSignals([
      agg({ capHits: cfg['email.partner_lane_cap_hit.min_hits'] }),
    ], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.partner_lane_cap_hit');
    expect(signal!.severity).toBe('watch');
    expect(signal!.evidence.capHits).toBe(cfg['email.partner_lane_cap_hit.min_hits']);
  });
});

describe('email.sending_bounce_complaint', () => {
  it('fires on a bounce rate over the threshold with enough messages', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 500, windowDelivered: 440, windowBounced: 55, windowFailed: 5,
      windowMessages: 500, windowBounceRate: 0.11,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal).toBeDefined();
    expect(signal!.evidence.bounceRate).toBeCloseTo(0.11, 5);
  });

  it('does not fire on a high rate over too few messages', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 10, windowDelivered: 5, windowBounced: 5,
      windowMessages: 10, windowBounceRate: 0.5,
    })], cfg);
    expect(keys(signals)).not.toContain('email.sending_bounce_complaint');
  });

  it('fires on complaints alone, whatever the volume', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 4, windowDelivered: 4, windowComplained: cfg['email.sending_bounce_complaint.min_complaints'],
      windowMessages: 4,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal!.evidence.complained).toBe(cfg['email.sending_bounce_complaint.min_complaints']);
  });

  // Auto-suspension already paged for exactly these facts (spec §9.3). A second
  // page for the same partner is noise, so this stays below the alert score.
  it('stays at watch severity — it must never page on its own', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 5000, windowBounced: 4000, windowComplained: 900,
      windowMessages: 5000, windowBounceRate: 0.8,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal!.severity).toBe('watch');
    expect(signal!.score).toBeLessThan(cfg['severity.alert_score']);
  });
});

describe('every emitted signal is well-formed', () => {
  it('carries partnerName in evidence — index.ts formatSignalAlert reads it', () => {
    const signals = computeSendingDomainSignals([agg({
      recentDomains: [{ domain: 'x.test', createdAt: new Date() }],
      capHits: 99,
      windowSent: 500, windowBounced: 100, windowMessages: 500, windowBounceRate: 0.2,
      failedVerifications: Array.from({ length: 5 }, (_, i) => ({ domain: `f${i}.test`, checkAttempts: 9, statusReason: 'dns_not_detected' })),
    })], cfg);
    expect(signals).toHaveLength(4);
    for (const signal of signals) {
      expect(signal.partnerId).toBe('p1');
      expect(signal.evidence.partnerName).toBe('Acme MSP');
      expect(signal.signalKey.length).toBeLessThanOrEqual(64);
      expect(signal.score).toBeGreaterThan(0);
      expect(signal.score).toBeLessThanOrEqual(100);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/abuseSignals/sendingDomains.test.ts
```
Expected failure: `Cannot find module './sendingDomains'`.

- [ ] **Step 3: Add the nine tunables**

In `apps/api/src/services/abuseSignals/config.ts`, append to the
`SIGNAL_DEFAULTS` object (before its closing `} as const …`):

```ts
  // --- Partner sending domains (spec §9.2, W05) ------------------------------
  // Four detectors over the outbound mail a partner sends from its OWN domain.
  // None of them is age-decayed: a lookalike domain and a bounce storm are
  // evidence about what the account is DOING, not about how old it is.
  //
  // `added` is deliberately INFO: a partner adding a sending domain is the
  // feature working. The signal exists so a human reads the NAME — a lookalike
  // of a bank or a well-known brand is the thing worth catching, and no
  // automatic rule can judge that. At info it also cannot corroborate, so it can
  // never contribute to a page on its own.
  'email.sending_domain_added.window_days': 7,
  'email.sending_domain_added.score': 25,
  // Repeated failed verifications is what adding names you do not control looks
  // like (spec §4.3). Watch, not alert: a partner whose DNS provider is slow
  // produces the same shape.
  'email.sending_domain_verify_failures.min_domains': 3,
  'email.sending_domain_verify_failures.score': 45,
  // Blasting past the daily partner-lane cap. Counted from the Redis day-hash
  // recordPartnerLaneCapHit writes, which is only ever written on a GENUINE
  // over-cap count — a Redis outage records nothing rather than accusing.
  'email.partner_lane_cap_hit.min_hits': 2,
  'email.partner_lane_cap_hit.score': 45,
  // Deliverability. Capped BELOW severity.alert_score on purpose: automatic
  // suspension (spec §9.3) already raised an ops alert for the same facts and
  // already stopped the sending, so a second page would be pure noise. Left at
  // watch so it can still corroborate a second, independent axis.
  'email.sending_bounce_complaint.min_messages': 50,
  'email.sending_bounce_complaint.bounce_rate': 0.08,
  'email.sending_bounce_complaint.min_complaints': 3,
  'email.sending_bounce_complaint.score': 65,
```

- [ ] **Step 4: Implement the producer**

Create `apps/api/src/services/abuseSignals/sendingDomains.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { CAP_HIT_WINDOW_DAYS, loadCapHitWindow } from '../emailDomains/capHits';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

/**
 * Partner sending-domain abuse signals (spec §9.2).
 *
 * Shape follows the file's siblings exactly: one fleet-wide async LOADER that
 * reads the database directly (and must run inside the sweep's system DB
 * context), plus a PURE, synchronous SCORER. Neither takes a clock, which is
 * this file's enforced documentation that none of these detectors age-decays:
 * a lookalike domain and a bounce storm are evidence about what the account is
 * doing, not about how recently it was created.
 *
 * Four detectors:
 *   email.sending_domain_added            info  — a human reads the NAME
 *   email.sending_domain_verify_failures  watch — names the partner cannot prove
 *   email.partner_lane_cap_hit            watch — blasting past the daily cap
 *   email.sending_bounce_complaint        watch — deliverability, capped below alert
 */

/** Evidence lists are bounded: index.ts truncates a serialized evidence blob at 800 chars. */
const EVIDENCE_CAP = 10;

export interface SendingDomainAggregate {
  partnerId: string;
  partnerName: string;
  recentDomains: Array<{ domain: string; createdAt: Date }>;
  failedVerifications: Array<{ domain: string; checkAttempts: number; statusReason: string | null }>;
  capHits: number;
  windowSent: number;
  windowDelivered: number;
  windowBounced: number;
  windowComplained: number;
  windowFailed: number;
  windowMessages: number;
  windowBounceRate: number;
}

interface AggregateRow {
  partner_id: string;
  partner_name: string;
  recent_domains: Array<{ domain: string; created_at: string }> | null;
  failed_verifications: Array<{ domain: string; check_attempts: number; status_reason: string | null }> | null;
  sent: string | number;
  delivered: string | number;
  bounced: string | number;
  complained: string | number;
  failed: string | number;
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

function num(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * ONE query for every partner that has a sending domain at all, plus one Redis
 * window read. Both the domain lists and the delivery counters are aggregated
 * in SQL so the sweep does not fan out per partner.
 *
 * MUST run inside the sweep's system DB context: partner_sending_domains and
 * partner_sending_daily_stats are partner-axis with forced RLS, so a contextless
 * read returns zero rows and would report a permanently clean fleet.
 */
export async function loadSendingDomainAggregates(now: Date = new Date()): Promise<{
  aggregates: SendingDomainAggregate[];
  scannedPartnerIds: string[];
}> {
  const addedWindowDays = 7;
  const statsWindowDays = 7;

  const result = await db.execute(sql`
    with recent as (
      select
        d.partner_id,
        jsonb_agg(jsonb_build_object('domain', d.domain, 'created_at', d.created_at)
                  order by d.created_at desc) as domains
      from partner_sending_domains d
      where d.created_at >= now() - (${addedWindowDays} || ' days')::interval
      group by d.partner_id
    ),
    failures as (
      select
        d.partner_id,
        jsonb_agg(jsonb_build_object(
          'domain', d.domain,
          'check_attempts', d.check_attempts,
          'status_reason', d.status_reason
        ) order by d.status_changed_at desc) as rows
      from partner_sending_domains d
      where d.status = 'failed'
        and coalesce(d.status_reason, '') in ('dns_not_detected', 'provider_conflict', 'provider_rejected')
      group by d.partner_id
    ),
    stats as (
      select
        s.partner_id,
        coalesce(sum(s.sent), 0)       as sent,
        coalesce(sum(s.delivered), 0)  as delivered,
        coalesce(sum(s.bounced), 0)    as bounced,
        coalesce(sum(s.complained), 0) as complained,
        coalesce(sum(s.failed), 0)     as failed
      from partner_sending_daily_stats s
      where s.day >= (current_date - ${statsWindowDays - 1})
      group by s.partner_id
    ),
    scanned as (
      select distinct partner_id from partner_sending_domains
      union
      select distinct partner_id from stats
    )
    select
      p.id                                as partner_id,
      p.name                              as partner_name,
      recent.domains                      as recent_domains,
      failures.rows                       as failed_verifications,
      coalesce(stats.sent, 0)             as sent,
      coalesce(stats.delivered, 0)        as delivered,
      coalesce(stats.bounced, 0)          as bounced,
      coalesce(stats.complained, 0)       as complained,
      coalesce(stats.failed, 0)           as failed
    from scanned
    join partners p on p.id = scanned.partner_id
    left join recent   on recent.partner_id = scanned.partner_id
    left join failures on failures.partner_id = scanned.partner_id
    left join stats    on stats.partner_id = scanned.partner_id
    where p.deleted_at is null
  `);

  const rows = extractRows<AggregateRow>(result);
  const capHits = await loadCapHitWindow(now);

  const aggregates: SendingDomainAggregate[] = rows.map((row) => {
    const sent = num(row.sent);
    const delivered = num(row.delivered);
    const bounced = num(row.bounced);
    const complained = num(row.complained);
    const failed = num(row.failed);
    const messages = Math.max(sent, delivered + bounced + failed);
    return {
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      recentDomains: (row.recent_domains ?? []).map((d) => ({
        domain: d.domain,
        createdAt: new Date(d.created_at),
      })),
      failedVerifications: (row.failed_verifications ?? []).map((f) => ({
        domain: f.domain,
        checkAttempts: Number(f.check_attempts ?? 0),
        statusReason: f.status_reason,
      })),
      capHits: capHits.get(row.partner_id) ?? 0,
      windowSent: sent,
      windowDelivered: delivered,
      windowBounced: bounced,
      windowComplained: complained,
      windowFailed: failed,
      windowMessages: messages,
      windowBounceRate: messages > 0 ? bounced / messages : 0,
    };
  });

  // A partner that only appears in the cap-hit hash still has to be scanned, or
  // an open row for it would never stale-resolve.
  const scanned = new Set(aggregates.map((a) => a.partnerId));
  for (const partnerId of capHits.keys()) scanned.add(partnerId);

  return { aggregates, scannedPartnerIds: [...scanned] };
}

export function computeSendingDomainSignals(
  aggregates: SendingDomainAggregate[],
  cfg: SignalConfig,
): ComputedSignal[] {
  const signals: ComputedSignal[] = [];

  for (const agg of aggregates) {
    const base = { partnerName: agg.partnerName };

    if (agg.recentDomains.length > 0) {
      const score = cfg['email.sending_domain_added.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_domain_added',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          // The NAME is the whole point: only a human can see that
          // `acrne-bank.test` is a lookalike of a real brand (spec §9.2).
          domains: agg.recentDomains.slice(0, EVIDENCE_CAP).map((d) => d.domain),
          addedCount: agg.recentDomains.length,
          windowDays: cfg['email.sending_domain_added.window_days'],
        },
      });
    }

    if (agg.failedVerifications.length >= cfg['email.sending_domain_verify_failures.min_domains']) {
      const score = cfg['email.sending_domain_verify_failures.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_domain_verify_failures',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          failedDomains: agg.failedVerifications.slice(0, EVIDENCE_CAP).map((f) => f.domain),
          failedCount: agg.failedVerifications.length,
          reasons: [...new Set(agg.failedVerifications.map((f) => f.statusReason ?? 'unknown'))].slice(0, EVIDENCE_CAP),
        },
      });
    }

    if (agg.capHits >= cfg['email.partner_lane_cap_hit.min_hits']) {
      const score = cfg['email.partner_lane_cap_hit.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.partner_lane_cap_hit',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: { ...base, capHits: agg.capHits, windowDays: CAP_HIT_WINDOW_DAYS },
      });
    }

    const rateBreached =
      agg.windowMessages >= cfg['email.sending_bounce_complaint.min_messages'] &&
      agg.windowBounceRate > cfg['email.sending_bounce_complaint.bounce_rate'];
    const complaintsBreached = agg.windowComplained >= cfg['email.sending_bounce_complaint.min_complaints'];
    if (rateBreached || complaintsBreached) {
      const score = cfg['email.sending_bounce_complaint.score'];
      signals.push({
        partnerId: agg.partnerId,
        signalKey: 'email.sending_bounce_complaint',
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: {
          ...base,
          messages: agg.windowMessages,
          bounced: agg.windowBounced,
          complained: agg.windowComplained,
          bounceRate: agg.windowBounceRate,
          // Says out loud that the kill switch has its own, independent path:
          // this signal is for the reviewer, not the page.
          note: 'automatic suspension is evaluated independently (spec §9.3)',
        },
      });
    }
  }

  return signals;
}
```

- [ ] **Step 5: Register the four keys in the corroboration registries**

In `apps/api/src/services/abuseSignals/corroboration.ts`, append to
`SIGNAL_AXIS` (before its closing `};`):

```ts
  // Partner sending domains (W05). TWO axes, not four.
  //
  //  - `added` and `verify_failures` are the same observation at two
  //    strengths: this partner is claiming DNS names. A partner adding three
  //    lookalikes and failing to verify them must contribute ONE axis, not two.
  //  - `cap_hit` and `bounce_complaint` are both "the mail this partner
  //    actually sent". A single blast produces both — over the cap AND a bounce
  //    spike — and counting that one episode as two independent axes would let
  //    it manufacture an alert by itself, the exact trap the ip_scatter and
  //    origin_ip pairs are grouped for.
  'email.sending_domain_added': 'sending_domain_setup',
  'email.sending_domain_verify_failures': 'sending_domain_setup',
  'email.partner_lane_cap_hit': 'sending_reputation',
  'email.sending_bounce_complaint': 'sending_reputation',
```

In `apps/api/src/services/abuseSignals/corroboration.test.ts`, append the four
keys to `EMITTED_KEYS`:

```ts
    'email.sending_domain_added',
    'email.sending_domain_verify_failures',
    'email.partner_lane_cap_hit',
    'email.sending_bounce_complaint',
```

- [ ] **Step 6: Wire the producer into the sweep**

In `apps/api/src/services/abuseSignals/index.ts`, four edits.

(a) Import, after the `./originIp` import (`:11`):
```ts
import { loadSendingDomainAggregates, computeSendingDomainSignals } from './sendingDomains';
```

(b) Destructure and loader, inside `runSystemDbCompute` — add `sendingDomains`
to the destructured names (`:53`) and one line to the returned object after
`originIp: await loadOriginIpAggregates(),` (`:64`):
```ts
        sendingDomains: await loadSendingDomainAggregates(now),
```

(c) Scorer, in the `computed` array after the `computeOriginIpSignals` spread
(`:89`):
```ts
    // Sending-domain signals are likewise never age-decayed — the scorer takes
    // no clock at all. A lookalike sending domain and a bounce storm say what
    // the account is DOING; account age is not evidence either way.
    ...computeSendingDomainSignals(sendingDomains.aggregates, cfg),
```

(d) `evaluatedPartnerIds`, after `...originIp.scannedPartnerIds,` (`:108`):
```ts
    ...sendingDomains.scannedPartnerIds,
```

In `apps/api/src/services/abuseSignals/sweep.test.ts`, add the new module to the
hoisted mock block and its `vi.mock` list, and give it a default in the file's
`beforeEach` (an undefined loader result would break every sweep case):

```ts
// in the vi.hoisted({...}) object:
  loadSendingDomainAggregates: vi.fn(),
  computeSendingDomainSignals: vi.fn(),
```
```ts
vi.mock('./sendingDomains', () => ({ loadSendingDomainAggregates, computeSendingDomainSignals }));
```
```ts
// in beforeEach, beside the other loader defaults:
  loadSendingDomainAggregates.mockResolvedValue({ aggregates: [], scannedPartnerIds: [] });
  computeSendingDomainSignals.mockReturnValue([]);
```

and one case proving the wiring:

```ts
  it('feeds sending-domain signals into persistSignals and their partners into the evaluated set', async () => {
    loadSendingDomainAggregates.mockResolvedValue({
      aggregates: [], scannedPartnerIds: ['p-sending'],
    });
    computeSendingDomainSignals.mockReturnValue([
      { partnerId: 'p-sending', signalKey: 'email.partner_lane_cap_hit', score: 45, severity: 'watch', evidence: { partnerName: 'Acme' } },
    ] satisfies ComputedSignal[]);
    persistSignals.mockResolvedValue({ toNotify: [] });

    await runAbuseSweep();

    const [computed, , evaluated] = persistSignals.mock.calls[0]!;
    expect((computed as ComputedSignal[]).map((s) => s.signalKey)).toContain('email.partner_lane_cap_hit');
    expect((evaluated as ReadonlySet<string>).has('p-sending')).toBe(true);
  });
```

- [ ] **Step 7: Run everything green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/abuseSignals/sendingDomains.test.ts src/services/abuseSignals/sweep.test.ts src/services/abuseSignals/corroboration.test.ts src/services/abuseSignals/config.test.ts
```
Expected: all PASS. `corroboration.test.ts`'s `SIGNAL_AXIS coverage` case must
pass with the four new `EMITTED_KEYS` entries — if it reds, one of the four keys
is missing from `SIGNAL_AXIS` and would silently have become its own
paging-grade axis.

- [ ] **Step 8: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/abuseSignals/sendingDomains.ts apps/api/src/services/abuseSignals/sendingDomains.test.ts apps/api/src/services/abuseSignals/config.ts apps/api/src/services/abuseSignals/index.ts apps/api/src/services/abuseSignals/corroboration.ts apps/api/src/services/abuseSignals/corroboration.test.ts apps/api/src/services/abuseSignals/sweep.test.ts
git commit -m "feat(abuse): sending-domain signals in the abuse sweep

Spec §9.2's four detectors: domain added (info, so a human reads the NAME for a
lookalike), repeated failed verifications, daily-cap hits, and the bounce or
complaint threshold. Loader/scorer split like every sibling, one fleet-wide
query plus one Redis window read, and no clock in the scorer — none of these
age-decays.

Two corroboration axes, not four: added+verify_failures are one observation at
two strengths, and cap_hit+bounce_complaint are one blast measured twice.
bounce_complaint is capped below the alert score because automatic suspension
already paged for the same facts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 11: The evidence-card entry

Spec §9.2 last sentence: *"The partner trust evidence card lists the partner's
sending domains."* The card is built once in the API and rendered by **two**
web components, each of which re-declares the type structurally (there is no
shared package for it), so all three files change together.

**Files:**
- Modify: `apps/api/src/services/partnerTrustEvidenceCard.ts` — the
  `EvidenceCard` interface (`:11-41`), the read inside `buildEvidenceCard`
  (`:115-129`, the existing `Promise.all`), the returned object literal
  (`:161-190`), and `renderCardText` (`:309-324`)
- Modify: `apps/api/src/services/partnerTrustEvidenceCard.test.ts`
- Modify: `apps/web/src/components/admin/TrustQueue.tsx` — the local
  `EvidenceCard` type (`:7-37`) and `EvidenceCardDetails` (`:81-127`)
- Modify: `apps/web/src/components/admin/TrustQueue.test.tsx` — the `card`
  fixture (`:26-51`) and one assertion
- Modify: `apps/web/src/components/admin/TrustActionPage.tsx` — its own local
  `EvidenceCard` type and the "Partner summary" section (`:157-167`)

**Interfaces:**
- Consumes: `partnerSendingDomains` (`../db/schema`).
- Produces (added to `EvidenceCard`):
  ```ts
  sendingDomains: Array<{ domain: string; status: string; verifiedAt: string | null }>;
  ```
  ISO-8601 strings, not `Date`: the card is serialised straight onto two HTTP
  responses.

- [ ] **Step 1: Write the failing API test**

Append to `apps/api/src/services/partnerTrustEvidenceCard.test.ts`, inside the
existing `buildEvidenceCard` describe (extend the suite's queued select results
with one more entry for the new read — the file drives `db.select` from a FIFO
queue, so the new read needs its own queued row set placed after the devices and
denials reads):

```ts
  it('lists the partner\'s sending domains with status and verification time', async () => {
    // … existing queue setup for partner / user / devices / denials …
    queueSelect([
      { domain: 'mail.acme.test', status: 'verified', verifiedAt: new Date('2026-09-01T00:00:00Z') },
      { domain: 'billing.acme.test', status: 'pending', verifiedAt: null },
    ]);

    const card = await buildEvidenceCard(PARTNER_ID);

    expect(card.sendingDomains).toEqual([
      { domain: 'mail.acme.test', status: 'verified', verifiedAt: '2026-09-01T00:00:00.000Z' },
      { domain: 'billing.acme.test', status: 'pending', verifiedAt: null },
    ]);
  });

  it('renders the sending domains into the ops-alert text', async () => {
    // … same setup …
    queueSelect([{ domain: 'mail.acme.test', status: 'verified', verifiedAt: new Date('2026-09-01T00:00:00Z') }]);
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(renderEvidenceCardSummary(card)).toContain('mail.acme.test (verified)');
  });

  it('says "none" rather than omitting the line when the partner has no sending domain', async () => {
    // … same setup …
    queueSelect([]);
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.sendingDomains).toEqual([]);
    expect(renderEvidenceCardSummary(card)).toContain('Sending domains: none');
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/partnerTrustEvidenceCard.test.ts
```
Expected failure: `expected undefined to deeply equal [ … ]` — `sendingDomains`
is not on the card yet.

- [ ] **Step 3: Implement the API side**

In `apps/api/src/services/partnerTrustEvidenceCard.ts`:

Add to the imports beside the other schema imports:
```ts
import { partnerSendingDomains } from '../db/schema';
```

Add to the `EvidenceCard` interface, immediately after the `devices` array
(`:29-34`):
```ts
  /**
   * The partner's custom outbound sending domains (spec §9.2). Listed by NAME
   * so the reviewer can spot a lookalike of a bank or a well-known brand —
   * nothing automatic can make that judgement.
   */
  sendingDomains: Array<{ domain: string; status: string; verifiedAt: string | null }>;
```

Extend the existing `Promise.all` at `:115-129` with a third read:
```ts
      db.select({
        domain: partnerSendingDomains.domain,
        status: partnerSendingDomains.status,
        verifiedAt: partnerSendingDomains.verifiedAt,
      }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.partnerId, partnerId))
        .orderBy(asc(partnerSendingDomains.createdAt)),
```
destructuring it as `sendingDomainRows`:
```ts
    const [deviceRows, denialRows, sendingDomainRows] = await Promise.all([
```

Add to the returned object literal, immediately after `devices: deviceRows,`
(`:187`):
```ts
      sendingDomains: sendingDomainRows.map((row) => ({
        domain: row.domain,
        status: row.status,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      })),
```

Add one line to `renderCardText`, immediately after the
`Matched suspended axes` line (`:321`):
```ts
    `Sending domains: ${card.sendingDomains.map((d) => `${d.domain} (${d.status})`).join(', ') || 'none'}`,
```

- [ ] **Step 4: Run the API side green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/partnerTrustEvidenceCard.test.ts src/routes/admin/trust.test.ts src/routes/admin/trustAct.test.ts
```
Expected: all PASS. The two route suites exercise the card through
`mapTrustQueueRowWithCard` and `GET /admin/trust/act/preview`; if either red,
their fixtures need the extra queued select result too.

- [ ] **Step 5: Write the failing web test, then mount it in BOTH components**

In `apps/web/src/components/admin/TrustQueue.test.tsx`, add to the `card`
fixture (`:26-51`), after `denials24h: 3,`:
```ts
  sendingDomains: [
    { domain: 'mail.acme.example', status: 'verified', verifiedAt: '2026-09-01T00:00:00.000Z' },
  ],
```
and one case beside the existing expansion test:
```ts
  it('shows the partner\'s sending domains inside the expanded evidence card', async () => {
    render(<TrustQueue />);
    await screen.findByTestId('trust-queue-row-partner-1');
    fireEvent.click(screen.getByTestId('trust-queue-expand-partner-1'));
    const cardEl = await screen.findByTestId('trust-queue-card-partner-1');
    expect(within(cardEl).getByTestId('trust-queue-sending-domains-partner-1').textContent)
      .toContain('mail.acme.example');
  });
```
(add `within` to the existing `@testing-library/react` import.)

Run it and watch it fail:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/admin/TrustQueue.test.tsx
```
Expected failure: `Unable to find an element by:
[data-testid="trust-queue-sending-domains-partner-1"]`.

Then, in `apps/web/src/components/admin/TrustQueue.tsx`, add to the local
`EvidenceCard` type (`:7-37`), after the `devices` array:
```ts
  sendingDomains: Array<{ domain: string; status: string; verifiedAt: string | null }>;
```
and one `<div>` to the `<dl>` grid in `EvidenceCardDetails`, immediately after
the `Matched suspended axes` entry:
```tsx
        <div data-testid={`trust-queue-sending-domains-${card.partner.id}`}>
          <dt className="text-muted-foreground">Sending domains</dt>
          <dd className="font-medium">
            {card.sendingDomains.length
              ? card.sendingDomains.map((d) => `${d.domain} (${d.status})`).join(', ')
              : 'None'}
          </dd>
        </div>
```

In `apps/web/src/components/admin/TrustActionPage.tsx`, add the same field to
its own local `EvidenceCard` type and one `<div>` to the "Partner summary"
`<dl>` (`:159-166`), after the `Denials in last 24 h` entry:
```tsx
          <div data-testid="trust-action-sending-domains">
            <dt className="text-muted-foreground">Sending domains</dt>
            <dd className="font-medium">
              {card.sendingDomains.length
                ? card.sendingDomains.map((d) => `${d.domain} (${d.status})`).join(', ')
                : 'None'}
            </dd>
          </div>
```

- [ ] **Step 6: Run the web tests green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/admin/TrustQueue.test.tsx src/components/admin/TrustActionPage.test.tsx
```
Expected: both PASS. If `TrustActionPage.test.tsx` reds on a missing
`sendingDomains`, add the same two-line fixture entry it uses for the card.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/partnerTrustEvidenceCard.ts apps/api/src/services/partnerTrustEvidenceCard.test.ts apps/web/src/components/admin/TrustQueue.tsx apps/web/src/components/admin/TrustQueue.test.tsx apps/web/src/components/admin/TrustActionPage.tsx
git commit -m "feat(trust): list the partner's sending domains on the evidence card

Spec §9.2. One extra read in buildEvidenceCard, one line in the ops-alert text,
and the field rendered in BOTH web consumers of the card — TrustQueue and
TrustActionPage each re-declare the type structurally, so they both had to
change. Listed by NAME: spotting a lookalike of a real brand is the reviewer's
job, not a rule's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 12: Admin metrics — 7-day volume, bounce rate and complaints

Spec §9.3: *"The admin list shows 7-day volume, bounce and complaint rates."*

**Files:**
- Modify: `apps/api/src/services/emailDomains/sendingDomainService.ts` — one new
  exported function beside `listAllSendingDomains`
- Modify: `apps/api/src/services/emailDomains/sendingDomainService.test.ts`
- Modify: `apps/api/src/routes/admin/sendingDomains.ts` — the `GET /` handler
  W02b Task 8 shipped
- Modify: `apps/api/src/routes/admin/sendingDomains.test.ts`

**Interfaces:**
- Consumes: `loadAllPartnerSendingWindowStats` / `STATS_WINDOW_DAYS`
  (`./deliveryStats`, Task 2).
- Produces:
  ```ts
  export interface SendingPartnerMetricsDto {
    windowDays: number;     // STATS_WINDOW_DAYS
    messages: number;       // GREATEST(sent, delivered + bounced + failed)
    delivered: number; bounced: number; complained: number;
    failed: number; suppressed: number;
    bounceRate: number;     // 0..1
  }
  export async function listAllSendingDomainsWithMetrics(
    opts: { limit: number },
  ): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string; metrics: SendingPartnerMetricsDto }>>;
  ```

> `sendingDomainService.ts` is already in `ALLOWED_WITHOUT_CAPABILITY_CHECK`
> (W02b Task 6), and this function only SELECTs, so no allowlist change.

- [ ] **Step 1: Write the failing service test**

Append to `apps/api/src/services/emailDomains/sendingDomainService.test.ts`
(and add `vi.mock('./deliveryStats', () => ({ STATS_WINDOW_DAYS: 7, loadAllPartnerSendingWindowStats: loadAllStatsMock }));`
with a hoisted `loadAllStatsMock` beside the file's existing mocks):

```ts
describe('listAllSendingDomainsWithMetrics', () => {
  const D1 = '22222222-2222-4222-8222-222222222222';
  const D2 = '33333333-3333-4333-8333-333333333333';
  const P1 = '11111111-1111-4111-8111-111111111111';
  const P2 = '44444444-4444-4444-8444-444444444444';

  function domainRow(id: string, partnerId: string, partnerName: string) {
    return {
      domain: {
        id, partnerId, domain: `${id}.test`, provider: 'resend', providerDomainId: 'pd',
        providerManaged: true, status: 'verified', statusReason: null, dnsRecords: [],
        verifiedAt: new Date('2026-09-01T00:00:00Z'), lastCheckedAt: null,
        lastTestAt: null, lastTestStatus: null, lastTestError: null,
        lastSendError: null, lastSendErrorAt: null, createdAt: new Date('2026-08-01T00:00:00Z'),
        statusChangedAt: new Date('2026-09-01T00:00:00Z'),
      },
      partnerName,
    };
  }

  it('attaches each partner\'s window metrics with ONE stats query for the whole page', async () => {
    rows.push([domainRow(D1, P1, 'Acme MSP'), domainRow(D2, P2, 'Beta IT')]);
    loadAllStatsMock.mockResolvedValue([
      { partnerId: P1, sent: 1000, delivered: 900, bounced: 90, complained: 4, failed: 10, suppressed: 2, messages: 1000, bounceRate: 0.09 },
    ]);

    const result = await listAllSendingDomainsWithMetrics({ limit: 50 });

    expect(loadAllStatsMock).toHaveBeenCalledTimes(1);
    expect(result[0]!.metrics).toEqual({
      windowDays: 7, messages: 1000, delivered: 900, bounced: 90,
      complained: 4, failed: 10, suppressed: 2, bounceRate: 0.09,
    });
  });

  // A partner with no events at all must render as zeros, not as a gap.
  it('gives a partner with no stats an all-zero metrics block', async () => {
    rows.push([domainRow(D2, P2, 'Beta IT')]);
    loadAllStatsMock.mockResolvedValue([]);
    const result = await listAllSendingDomainsWithMetrics({ limit: 50 });
    expect(result[0]!.metrics).toEqual({
      windowDays: 7, messages: 0, delivered: 0, bounced: 0,
      complained: 0, failed: 0, suppressed: 0, bounceRate: 0,
    });
  });

  it('shares one metrics object shape across two domains of the same partner (no N+1)', async () => {
    rows.push([domainRow(D1, P1, 'Acme MSP'), domainRow(D2, P1, 'Acme MSP')]);
    loadAllStatsMock.mockResolvedValue([
      { partnerId: P1, sent: 10, delivered: 10, bounced: 0, complained: 0, failed: 0, suppressed: 0, messages: 10, bounceRate: 0 },
    ]);
    const result = await listAllSendingDomainsWithMetrics({ limit: 50 });
    expect(loadAllStatsMock).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.metrics.messages)).toEqual([10, 10]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/sendingDomainService.test.ts
```
Expected failure: `listAllSendingDomainsWithMetrics is not a function`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/emailDomains/sendingDomainService.ts`, add the import:
```ts
import { STATS_WINDOW_DAYS, loadAllPartnerSendingWindowStats } from './deliveryStats';
```

and add the function immediately after `listAllSendingDomains`:

```ts
export interface SendingPartnerMetricsDto {
  windowDays: number;
  /** GREATEST(sent, delivered + bounced + failed) — see deliveryStats.ts. */
  messages: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  /** 0..1. */
  bounceRate: number;
}

const ZERO_METRICS: SendingPartnerMetricsDto = Object.freeze({
  windowDays: STATS_WINDOW_DAYS,
  messages: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0, bounceRate: 0,
});

/**
 * The platform-admin list with each partner's 7-day deliverability attached
 * (spec §9.3).
 *
 * TWO queries total, whatever the page size: the domain list, then ONE grouped
 * rollup over partner_sending_daily_stats for the whole fleet, joined in memory
 * by partner id. Fetching per partner would be an N+1 on a page that exists to
 * be scanned, and two domains of the same partner would fetch the same window
 * twice.
 */
export async function listAllSendingDomainsWithMetrics(
  opts: { limit: number },
): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string; metrics: SendingPartnerMetricsDto }>> {
  const [domains, windowStats] = await Promise.all([
    listAllSendingDomains(opts),
    loadAllPartnerSendingWindowStats(),
  ]);
  const byPartner = new Map(windowStats.map((s) => [s.partnerId, s]));
  return domains.map((domain) => {
    const stats = byPartner.get(domain.partnerId);
    return {
      ...domain,
      metrics: stats
        ? {
            windowDays: STATS_WINDOW_DAYS,
            messages: stats.messages,
            delivered: stats.delivered,
            bounced: stats.bounced,
            complained: stats.complained,
            failed: stats.failed,
            suppressed: stats.suppressed,
            bounceRate: stats.bounceRate,
          }
        : { ...ZERO_METRICS },
    };
  });
}
```

- [ ] **Step 4: Switch the admin route over**

In `apps/api/src/routes/admin/sendingDomains.ts`, change the `GET /` handler's
import and call from `listAllSendingDomains` to `listAllSendingDomainsWithMetrics`
(the response envelope, `{ data }`, is unchanged).

In `apps/api/src/routes/admin/sendingDomains.test.ts`, add
`listAllSendingDomainsWithMetrics: mocks.listAllWithMetrics` to the service
module mock (with a hoisted `listAllWithMetrics: vi.fn()` and a
`mocks.listAllWithMetrics.mockResolvedValue([])` default in `beforeEach`), and
add one case:

```ts
  it('lists across partners with the 7-day metrics attached', async () => {
    mocks.listAllWithMetrics.mockResolvedValue([{
      id: DOMAIN_ID, partnerId: 'p1', partnerName: 'Acme MSP', domain: 'mail.acme.test',
      provider: 'resend', status: 'verified', statusReason: null, dnsRecords: [],
      verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
      lastTestError: null, lastSendError: null, lastSendErrorAt: null,
      providerManaged: true, createdAt: '2026-08-01T00:00:00.000Z',
      metrics: { windowDays: 7, messages: 100, delivered: 90, bounced: 8, complained: 1, failed: 2, suppressed: 0, bounceRate: 0.08 },
    }]);
    const res = await buildApp().request('/admin/sending-domains');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ metrics: { bounceRate: number } }> };
    expect(body.data[0]!.metrics.bounceRate).toBeCloseTo(0.08, 5);
  });
```

- [ ] **Step 5: Run it green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/sendingDomainService.test.ts src/routes/admin/sendingDomains.test.ts src/routes/sendingDomainsMounting.test.ts
```
Expected: all PASS. `sendingDomainsMounting.test.ts` mocks the service module
wholesale, so add `listAllSendingDomainsWithMetrics: vi.fn(async () => [])` to
its mock object if it reds on the new import.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/sendingDomainService.ts apps/api/src/services/emailDomains/sendingDomainService.test.ts apps/api/src/routes/admin/sendingDomains.ts apps/api/src/routes/admin/sendingDomains.test.ts apps/api/src/routes/sendingDomainsMounting.test.ts
git commit -m "feat(email-domains): 7-day deliverability on the admin sending-domain list

Spec §9.3. Two queries whatever the page size: the domain list plus ONE grouped
rollup over partner_sending_daily_stats for the whole fleet, joined by partner
id in memory. A partner with no events renders as zeros, not as a gap.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 13: The platform-admin sending-domains page (mount task)

A platform-admin web UI exists for the trust admin routes —
`apps/web/src/pages/admin/trust-queue.astro` mounts
`apps/web/src/components/admin/TrustQueue.tsx`, which consumes
`routes/admin/trust.ts`. There is **no** page for `routes/admin/abuse.ts`. W05
ships a new unlisted admin page for the sending-domain admin routes rather than
bolting a second resource onto the trust queue; it is built in `TrustQueue.tsx`'s
idiom (`fetchWithAuth` for the read, `runAction` for every mutation,
`data-testid` on every interactive element, an explicit unauthorized state).

**This task is not done until the page renders the component.** A component with
no page is the failure mode a previous wave shipped (13 green components, never
mounted).

**Files:**
- Create: `apps/web/src/components/admin/SendingDomainsAdmin.tsx`
- Create: `apps/web/src/components/admin/SendingDomainsAdmin.test.tsx`
- Create: `apps/web/src/pages/admin/sending-domains.astro`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/pages.json`
  — one `titles.adminSendingDomains` key each, with a REAL translation in every
  locale (the locale-parity coverage test rejects an English string pasted into
  a non-English file)

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../stores/auth`), `ActionError` /
  `handleActionError` / `runAction` (`../../lib/runAction`), `showToast`
  (`../shared/Toast`); the API surface
  `GET /admin/sending-domains`,
  `POST /admin/sending-domains/:id/suspend`,
  `POST /admin/sending-domains/:id/unsuspend`,
  `POST /admin/sending-domains/:id/force-release`.
- Produces: `export default function SendingDomainsAdmin(): JSX.Element`.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/admin/SendingDomainsAdmin.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { fetchWithAuth, runAction, showToast } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  runAction: vi.fn(async ({ request }: { request: () => Promise<Response> }) => { await request(); }),
  showToast: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('../../lib/runAction', () => ({
  runAction,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('../shared/Toast', () => ({ showToast }));

import SendingDomainsAdmin from './SendingDomainsAdmin';

const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID, partnerId: 'p1', partnerName: 'Acme MSP', domain: 'mail.acme.test',
    provider: 'resend', status: 'verified', statusReason: null, providerManaged: true,
    verifiedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
    lastSendError: null, lastSendErrorAt: null,
    metrics: { windowDays: 7, messages: 1000, delivered: 900, bounced: 90, complained: 4, failed: 10, suppressed: 0, bounceRate: 0.09 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row()] }));
});

describe('SendingDomainsAdmin', () => {
  it('renders one row per domain with the partner, the status and the 7-day metrics', async () => {
    render(<SendingDomainsAdmin />);
    const rowEl = await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    expect(within(rowEl).getByText('mail.acme.test')).toBeTruthy();
    expect(within(rowEl).getByText('Acme MSP')).toBeTruthy();
    expect(within(rowEl).getByTestId(`sending-domains-admin-bounce-rate-${DOMAIN_ID}`).textContent).toContain('9.00%');
    expect(within(rowEl).getByTestId(`sending-domains-admin-messages-${DOMAIN_ID}`).textContent).toContain('1,000');
    expect(within(rowEl).getByTestId(`sending-domains-admin-complaints-${DOMAIN_ID}`).textContent).toContain('4');
  });

  it('shows an unauthorized state instead of an empty table on 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({}, 403));
    render(<SendingDomainsAdmin />);
    expect(await screen.findByTestId('sending-domains-admin-requires-platform-admin')).toBeTruthy();
  });

  it('renders an explicit empty state', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
    render(<SendingDomainsAdmin />);
    expect(await screen.findByTestId('sending-domains-admin-empty')).toBeTruthy();
  });

  it('suspends through runAction and reflects the new status', async () => {
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true, status: 'suspended' }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-suspend-${DOMAIN_ID}`));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/suspend`,
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(
      screen.getByTestId(`sending-domains-admin-status-${DOMAIN_ID}`).textContent,
    ).toContain('suspended'));
  });

  it('unsuspends a suspended row', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row({ status: 'suspended', statusReason: 'abuse_auto' })] }));
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true, status: 'pending' }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-unsuspend-${DOMAIN_ID}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/unsuspend`,
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  // Force-release drops Breeze's claim on a name and cannot be undone.
  it('confirms before force-releasing, and does nothing when the operator cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SendingDomainsAdmin />);
    await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    fireEvent.click(screen.getByTestId(`sending-domains-admin-force-release-${DOMAIN_ID}`));
    expect(runAction).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fetchWithAuth.mockResolvedValue(jsonResponse({ success: true }));
    fireEvent.click(screen.getByTestId(`sending-domains-admin-force-release-${DOMAIN_ID}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(
      `/admin/sending-domains/${DOMAIN_ID}/force-release`,
      expect.objectContaining({ method: 'POST' }),
    ));
    confirmSpy.mockRestore();
  });

  it('shows the auto-suspension reason so the operator can tell it from a manual one', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ data: [row({ status: 'suspended', statusReason: 'abuse_auto' })] }));
    render(<SendingDomainsAdmin />);
    const rowEl = await screen.findByTestId(`sending-domains-admin-row-${DOMAIN_ID}`);
    expect(within(rowEl).getByTestId(`sending-domains-admin-status-${DOMAIN_ID}`).textContent).toContain('abuse_auto');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/admin/SendingDomainsAdmin.test.tsx
```
Expected failure: `Failed to resolve import "./SendingDomainsAdmin"`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/admin/SendingDomainsAdmin.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

/**
 * Platform-admin view of every partner sending domain (spec §9.3), with the
 * 7-day deliverability the admin list gained in W05 and the three kill-switch
 * actions. Unlisted, like /admin/trust-queue: it is reached by URL.
 *
 * Every mutation goes through runAction so a failure is always surfaced; the
 * unauthorized state is explicit rather than an empty table, because "no rows"
 * and "you are not a platform admin" must not look the same.
 */

type SendingDomainMetrics = {
  windowDays: number;
  messages: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  bounceRate: number;
};

type AdminSendingDomain = {
  id: string;
  partnerId: string;
  partnerName: string;
  domain: string;
  provider: string;
  status: string;
  statusReason: string | null;
  providerManaged: boolean;
  verifiedAt: string | null;
  createdAt: string;
  lastSendError: string | null;
  lastSendErrorAt: string | null;
  metrics: SendingDomainMetrics;
};

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';
type AdminAction = 'suspend' | 'unsuspend' | 'force-release';

const ACTION_LABEL: Record<AdminAction, string> = {
  suspend: 'Suspend',
  unsuspend: 'Unsuspend',
  'force-release': 'Force release',
};

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export default function SendingDomainsAdmin() {
  const [rows, setRows] = useState<AdminSendingDomain[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [actingOn, setActingOn] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const response = await fetchWithAuth('/admin/sending-domains?limit=200');
      if (response.status === 401 || response.status === 403) {
        setLoadState('unauthorized');
        return;
      }
      if (!response.ok) {
        setLoadState('error');
        return;
      }
      const body = await response.json() as { data: AdminSendingDomain[] };
      setRows(body.data ?? []);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (row: AdminSendingDomain, action: AdminAction) => {
    if (action === 'force-release') {
      // Irreversible: it drops Breeze's claim on the name and deletes the local
      // row. Nothing else on this page needs a confirmation.
      if (!window.confirm(
        `Force-release ${row.domain}? This drops Breeze's claim on the name and removes the row for ${row.partnerName}. It cannot be undone.`,
      )) return;
    }

    setActingOn(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/sending-domains/${encodeURIComponent(row.id)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        errorFallback: `Unable to ${ACTION_LABEL[action].toLowerCase()} ${row.domain}`,
        successMessage: `${ACTION_LABEL[action]}d ${row.domain}`,
      });

      if (action === 'force-release') {
        setRows((current) => current.filter((candidate) => candidate.id !== row.id));
      } else {
        setRows((current) => current.map((candidate) => candidate.id === row.id
          ? {
              ...candidate,
              status: action === 'suspend' ? 'suspended' : 'pending',
              statusReason: action === 'suspend' ? 'platform_suspended' : null,
            }
          : candidate));
      }
    } catch (error) {
      if (error instanceof ActionError && (error.status === 401 || error.status === 403)) {
        setLoadState('unauthorized');
      } else {
        handleActionError(error, `Unable to ${ACTION_LABEL[action].toLowerCase()} ${row.domain}`);
      }
    } finally {
      setActingOn(null);
    }
  };

  if (loadState === 'loading') {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading sending domains…</p>;
  }
  if (loadState === 'unauthorized') {
    return (
      <p className="rounded-lg border bg-card p-6" data-testid="sending-domains-admin-requires-platform-admin">
        Sign in as a platform admin
      </p>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="sending-domains-admin-error">
        <p className="text-sm">Could not load sending domains.</p>
        <button
          type="button"
          className="mt-3 rounded-md border px-3 py-1.5 text-sm"
          data-testid="sending-domains-admin-retry"
          onClick={() => { void load(); }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="sending-domains-admin">
      <div className="flex items-center gap-2">
        <MailWarning className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">Partner sending domains</h1>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center" data-testid="sending-domains-admin-empty">
          <p className="text-sm text-muted-foreground">No partner has added a sending domain yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Partner</th>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">7-day messages</th>
                <th className="px-3 py-2">Bounce rate</th>
                <th className="px-3 py-2">Complaints</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} className="border-t" data-testid={`sending-domains-admin-row-${row.id}`}>
                  <td className="px-3 py-2">{row.partnerName}</td>
                  <td className="px-3 py-2 font-medium">{row.domain}</td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-status-${row.id}`}>
                    {row.status}{row.statusReason ? ` (${row.statusReason})` : ''}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-messages-${row.id}`}>
                    {formatCount(row.metrics.messages)}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-bounce-rate-${row.id}`}>
                    {formatRate(row.metrics.bounceRate)}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-complaints-${row.id}`}>
                    {formatCount(row.metrics.complained)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs"
                        disabled={actingOn === row.id || row.status === 'suspended'}
                        data-testid={`sending-domains-admin-suspend-${row.id}`}
                        onClick={() => { void act(row, 'suspend'); }}
                      >
                        Suspend
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs"
                        disabled={actingOn === row.id || row.status !== 'suspended'}
                        data-testid={`sending-domains-admin-unsuspend-${row.id}`}
                        onClick={() => { void act(row, 'unsuspend'); }}
                      >
                        Unsuspend
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs text-destructive"
                        disabled={actingOn === row.id}
                        data-testid={`sending-domains-admin-force-release-${row.id}`}
                        onClick={() => { void act(row, 'force-release'); }}
                      >
                        Force release
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

`showToast` is imported for parity with `TrustQueue.tsx`'s error handling; if
the linter flags it as unused, drop the import rather than inventing a use.

- [ ] **Step 4: MOUNT it — the page**

Create `apps/web/src/pages/admin/sending-domains.astro`, byte-for-byte in the
shape of `trust-queue.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import SendingDomainsAdmin from '../../components/admin/SendingDomainsAdmin';
---

<DashboardLayout titleKey="titles.adminSendingDomains">
  <SendingDomainsAdmin client:load />
</DashboardLayout>
```

Add `titles.adminSendingDomains` to all eight locale files, each a REAL
translation (`apps/web/src/locales/<locale>/pages.json`, beside
`adminTrustQueue`):

| Locale | Value |
|---|---|
| `en` | `Partner Sending Domains` |
| `de-DE` | `Partner-Versanddomains` |
| `es-419` | `Dominios de envío del socio` |
| `fr-CA` | `Domaines d'envoi du partenaire` |
| `fr-FR` | `Domaines d'envoi du partenaire` |
| `it-IT` | `Domini di invio del partner` |
| `pt-BR` | `Domínios de envio do parceiro` |
| `tr-TR` | `İş ortağı gönderim alan adları` |

- [ ] **Step 5: Run the web tests green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/admin/SendingDomainsAdmin.test.tsx
npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
npx vitest run src/locales
```
Expected: the component suite passes (8 tests); `no-silent-mutations.test.ts`
passes without an allowlist entry, because every mutation here goes through
`runAction`; the locale suites pass with the eight real translations. If the
locale-parity suite reds on a missing key, one of the eight files was skipped.

- [ ] **Step 6: Prove the page actually mounts the component**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
grep -n "SendingDomainsAdmin" apps/web/src/pages/admin/sending-domains.astro
cd apps/web && npx astro check 2>&1 | tail -20
```
Expected: the grep prints both the import and the `<SendingDomainsAdmin
client:load />` usage, and `astro check` reports no new errors. A component that
exists but is never rendered by a page is the exact failure this step exists to
catch.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/admin/SendingDomainsAdmin.tsx apps/web/src/components/admin/SendingDomainsAdmin.test.tsx apps/web/src/pages/admin/sending-domains.astro apps/web/src/locales
git commit -m "feat(web): platform-admin sending-domains page

/admin/sending-domains, unlisted like /admin/trust-queue: every partner's
domains with the 7-day messages, bounce rate and complaint count, plus suspend /
unsuspend / force-release. Built in the TrustQueue idiom — fetchWithAuth for the
read, runAction for every mutation, an explicit unauthorized state so 'no rows'
and 'not a platform admin' cannot look the same, and a confirmation on the one
irreversible action. Eight real locale titles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 14: Live-Postgres contract suite

**Placement rule:** the file must live in `apps/api/src/__tests__/integration/`.
`vitest.integration.config.ts`'s include list covers
`src/__tests__/integration/**/*.test.ts`; a co-located `*.integration.test.ts`
anywhere else runs in **no CI job at all**. The harness idiom below is the one
W02a Task 12 established in `partnerSendingDomainsRls.integration.test.ts`.

**Files:**
- Create: `apps/api/src/__tests__/integration/partnerSendingDailyStats.integration.test.ts`

**Interfaces:**
- Consumes: `db`, `withDbAccessContext`, `type DbAccessContext` (`../../db`),
  `partnerSendingDailyStats` / `partnerSendingDomains` (`../../db/schema`),
  `incrementPartnerSendingStat` / `loadPartnerSendingWindowStats` /
  `loadAllPartnerSendingWindowStats` (`../../services/emailDomains/deliveryStats`),
  `resendWebhookRoutes` (`../../routes/webhooks/emailProvider`), `pgErrorCode`
  (`../../utils/pgErrors`), `createOrganization` / `createPartner` (`./db-utils`).
- Produces: nothing importable.

> **Why Redis is stubbed here and Postgres is not.** The three properties this
> suite exists to prove — forced RLS on a partner-axis table, a lost-update-free
> concurrent increment, and a handler that works with no ambient DB context —
> are all database properties, and a mocked database cannot show any of them
> (a contextless read under forced RLS returns zero rows and looks "healthy").
> Redis contributes only the replay reservation, which `emailProvider.test.ts`
> already covers, so it is replaced with a tiny in-memory stub to keep the suite
> from depending on a second service being up.

- [ ] **Step 1: Write the suite**

Create `apps/api/src/__tests__/integration/partnerSendingDailyStats.integration.test.ts`:

```ts
/**
 * partner_sending_daily_stats — live RLS, concurrent upsert-increment
 * correctness, and the delivery webhook end-to-end with NO ambient DB context
 * (spec §9.3, §14; CLAUDE.md "Tenant Isolation" step 6).
 *
 * The shipped policy (2026-10-20-100100-partner-sending-daily-stats.sql) is:
 *   partner_sending_daily_stats_partner_access  FOR ALL
 *     system OR breeze_has_partner_access(partner_id)
 *
 * rls-coverage.integration.test.ts proves the policy EXISTS by reading
 * pg_catalog; it cannot prove it enforces anything. This suite drives the real
 * postgres.js driver as `breeze_app` under FORCE RLS, which is the only thing
 * that does.
 */
import './setup';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerSendingDailyStats, partnerSendingDomains } from '../../db/schema';
import {
  incrementPartnerSendingStat,
  loadAllPartnerSendingWindowStats,
  loadPartnerSendingWindowStats,
} from '../../services/emailDomains/deliveryStats';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SECRET = `whsec_${Buffer.from('an-integration-thirty-two-byte!!').toString('base64')}`;

// Redis: in-memory. See the task header for why.
const reservations = new Set<string>();
vi.mock('../../services/redis', () => ({
  getRedis: () => ({
    set: async (key: string, _v: string, _ex: string, _ttl: number, _nx: string) => {
      if (reservations.has(key)) return null;
      reservations.add(key);
      return 'OK';
    },
  }),
}));
// The route's only enqueue targets; BullMQ is not part of what this suite proves.
const enqueueSyncSpy = vi.fn(async () => undefined);
const enqueueAutoSuspendSpy = vi.fn(async () => undefined);
vi.mock('../../jobs/sendingDomainsWorker', () => ({
  enqueueSyncDomain: (...args: unknown[]) => enqueueSyncSpy(...(args as [])),
  enqueueAutoSuspendEvaluation: (...args: unknown[]) => enqueueAutoSuspendSpy(...(args as [])),
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: async () => ({ allowed: true, remaining: 100, resetAt: new Date() }),
}));

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const createdPartnerIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  createdPartnerIds.length = 0;
  reservations.clear();
  vi.clearAllMocks();
  if (partnerIds.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(partnerSendingDailyStats).where(inArray(partnerSendingDailyStats.partnerId, partnerIds));
    // The BEFORE DELETE guard raises while provider_domain_id is set.
    await db.update(partnerSendingDomains).set({ providerDomainId: null })
      .where(inArray(partnerSendingDomains.partnerId, partnerIds));
    await db.delete(partnerSendingDomains).where(inArray(partnerSendingDomains.partnerId, partnerIds));
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('partner_sending_daily_stats — RLS (shape 3)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('FORGE: partner B cannot insert a stats row for partner A (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, []), () =>
        db.insert(partnerSendingDailyStats)
          .values({ partnerId: f.partnerA, day: TODAY, sent: 1 })
          .returning()),
      '42501',
    );
  });

  it('FORGE: partner B cannot read or update partner A\'s row', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, sent: 5 }));

    const read = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ sent: partnerSendingDailyStats.sent }).from(partnerSendingDailyStats));
    expect(read).toHaveLength(0);

    const updated = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.update(partnerSendingDailyStats).set({ sent: 999 })
        .where(eq(partnerSendingDailyStats.partnerId, f.partnerA))
        .returning({ sent: partnerSendingDailyStats.sent }));
    expect(updated).toHaveLength(0);
  });

  it('partner A CAN read its own row', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats));
    expect(rows).toEqual([{ delivered: 7 }]);
  });

  it('an ORG-scoped context sees ZERO rows even for its own partner', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats));
    expect(rows).toHaveLength(0);
  });

  it('a CONTEXTLESS read sees zero rows — the reason the webhook must elect system scope', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats);
    expect(rows).toHaveLength(0);
  });
});

describe('incrementPartnerSendingStat — real Postgres', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('inserts then updates the same (partner, day) row', async () => {
    await expect(incrementPartnerSendingStat(f.partnerA, 'delivered')).resolves.toBe(true);
    await expect(incrementPartnerSendingStat(f.partnerA, 'delivered')).resolves.toBe(true);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered).toBe(2);
  });

  // The whole reason the statement is INSERT … SELECT … ON CONFLICT and not a
  // read-modify-write: concurrent deliveries must not lose an increment.
  it('loses no increment under 50 concurrent calls', async () => {
    await Promise.all(Array.from({ length: 50 }, () => incrementPartnerSendingStat(f.partnerA, 'bounced')));
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(50);
  });

  it('counts concurrent increments of DIFFERENT columns independently', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => incrementPartnerSendingStat(f.partnerA, 'sent')),
      ...Array.from({ length: 5 }, () => incrementPartnerSendingStat(f.partnerA, 'complained')),
    ]);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.sent).toBe(20);
    expect(rows[0]!.complained).toBe(5);
  });

  // A forged tag must be counted nowhere and must NOT raise 23503 — a caught
  // FK violation would abort the surrounding transaction.
  it('returns false and raises nothing for a partner id that does not exist', async () => {
    await expect(
      incrementPartnerSendingStat('99999999-9999-4999-8999-999999999999', 'bounced'),
    ).resolves.toBe(false);
  });

  it('rolls the window up per partner and fleet-wide from the same rows', async () => {
    await incrementPartnerSendingStat(f.partnerA, 'sent');
    await incrementPartnerSendingStat(f.partnerA, 'bounced');
    await incrementPartnerSendingStat(f.partnerB, 'delivered');

    const a = await loadPartnerSendingWindowStats(f.partnerA);
    expect(a.sent).toBe(1);
    expect(a.bounced).toBe(1);
    expect(a.messages).toBe(1);   // GREATEST(1, 0 + 1 + 0)

    const all = await loadAllPartnerSendingWindowStats();
    const ids = all.map((r) => r.partnerId);
    expect(ids).toContain(f.partnerA);
    expect(ids).toContain(f.partnerB);
  });

  it('excludes a day outside the 7-day window', async () => {
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      insert into partner_sending_daily_stats (partner_id, day, bounced)
      values (${f.partnerA}::uuid, (current_date - 30), 99)
    `));
    const stats = await loadPartnerSendingWindowStats(f.partnerA);
    expect(stats.bounced).toBe(0);
  });
});

describe('the delivery webhook end-to-end, with NO ambient DB context', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
    process.env.EMAIL_DOMAINS_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => { delete process.env.EMAIL_DOMAINS_WEBHOOK_SECRET; });

  async function post(payload: unknown, id = `msg_${Math.random().toString(36).slice(2)}`) {
    const { resendWebhookRoutes } = await import('../../routes/webhooks/emailProvider');
    const app = new Hono();
    app.route('/webhooks', resendWebhookRoutes);
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    // Note: NO withDbAccessContext wrapper. The handler must elect system scope
    // itself; if it does not, forced RLS silently counts nothing.
    return app.request('/webhooks/email-provider/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
      body,
    });
  }

  function event(type: string, partnerId: string) {
    return {
      type, created_at: new Date().toISOString(),
      data: { email_id: 'e1', from: 'a@b.test', to: ['c@d.test'], subject: 's', created_at: new Date().toISOString(), tags: { partner_id: partnerId } },
    };
  }

  it('counts a delivered event into the tagged partner\'s row', async () => {
    const res = await post(event('email.delivered', f.partnerA));
    expect(res.status).toBe(202);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.delivered).toBe(1);
  });

  it('counts a bounce and enqueues exactly one auto-suspend evaluation', async () => {
    const res = await post(event('email.bounced', f.partnerA));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendSpy).toHaveBeenCalledWith(f.partnerA);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(1);
  });

  it('does not double-count a redelivery of the same svix-id', async () => {
    const id = 'msg_replayed';
    expect((await post(event('email.bounced', f.partnerA), id)).status).toBe(202);
    expect((await post(event('email.bounced', f.partnerA), id)).status).toBe(202);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(1);
  });

  it('counts a forged partner tag nowhere and enqueues nothing', async () => {
    const res = await post(event('email.bounced', '99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendSpy).not.toHaveBeenCalled();
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats));
    expect(rows).toHaveLength(0);
  });

  it('resolves domain.updated to the local row and enqueues a sync', async () => {
    const [domain] = await withDbAccessContext(SYSTEM_CTX, () => db
      .insert(partnerSendingDomains)
      .values({ partnerId: f.partnerA, domain: `wh-${Date.now()}.test`, provider: 'fake', providerDomainId: 'prov-wh-1', status: 'verified' })
      .returning());
    const res = await post({
      type: 'domain.updated', created_at: new Date().toISOString(),
      data: { id: 'prov-wh-1', name: domain!.domain, status: 'verified', created_at: new Date().toISOString(), region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncSpy).toHaveBeenCalledWith(domain!.id);
  });

  it('is inert with a 404 when the secret is unset', async () => {
    delete process.env.EMAIL_DOMAINS_WEBHOOK_SECRET;
    const res = await post(event('email.delivered', f.partnerA));
    expect(res.status).toBe(404);
    const rows = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(partnerSendingDailyStats));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it against a live database**

Run (the stack from Task 1 Step 5 should still be up; if not,
`pnpm test-stack up` and `pnpm db:migrate` first):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSendingDailyStats.integration.test.ts
```
Expected: 16 tests PASS. If the contextless-read case passes only because the
table is empty, it is vacuous — the assertion inserts under system scope first,
precisely so a zero-row result proves enforcement rather than absence.

- [ ] **Step 3: Verify as `breeze_app` by hand (CLAUDE.md step 6)**

Run:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SET breeze.scope = 'organization'; INSERT INTO partner_sending_daily_stats (partner_id, day, sent) SELECT id, current_date, 1 FROM partners LIMIT 1;"
```
Expected: `ERROR: new row violates row-level security policy for table
"partner_sending_daily_stats"`. (Substitute the test stack's container name if
this worktree's compose project differs — `docker compose ls -a` lists it.)

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/__tests__/integration/partnerSendingDailyStats.integration.test.ts
git commit -m "test(api): live-Postgres contract for the sending daily stats

Cross-partner forge is 42501, an org-scoped context and a CONTEXTLESS read both
see zero rows (which is why the webhook has to elect system scope itself), the
upsert-increment loses nothing under 50 concurrent calls, a forged partner tag
counts nowhere without raising 23503, and the webhook is driven end-to-end
through the real route with no ambient DB context — including replay dedupe,
domain.updated resolution and the inert 404.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 15: Verification

**Files:** none changed. This task only runs things.

- [ ] **Step 1: Typecheck**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx tsc --noEmit
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx tsc --noEmit
npx astro check
```
Expected: no errors from either package.

- [ ] **Step 2: Every unit file this wave touched**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run \
  src/services/emailDomains/deliveryStats.test.ts \
  src/services/emailDomains/config.test.ts \
  src/services/emailDomains/autoSuspend.test.ts \
  src/services/emailDomains/sendingDomainService.test.ts \
  src/services/emailDomains/webhookSignature.test.ts \
  src/services/emailDomains/capHits.test.ts \
  src/services/emailDomains/sendCap.test.ts \
  src/services/abuseSignals/sendingDomains.test.ts \
  src/services/abuseSignals/sweep.test.ts \
  src/services/abuseSignals/corroboration.test.ts \
  src/services/abuseSignals/config.test.ts \
  src/services/partnerTrustEvidenceCard.test.ts \
  src/jobs/sendingDomainsWorker.test.ts \
  src/routes/webhooks/emailProvider.test.ts \
  src/routes/webhooks/emailProviderMounting.test.ts \
  src/routes/webhooks.mountOrder.test.ts \
  src/routes/admin/sendingDomains.test.ts \
  src/routes/sendingDomainsMounting.test.ts \
  src/config/validate.test.ts \
  src/config/envComposeParity.test.ts \
  src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/__tests__/routerAuthGate.contract.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: every file PASSES, and the reported file count is **24**. Vitest's
path filter is a plain substring, so a typo silently drops a file — check the
count, not just the colour.

- [ ] **Step 3: The whole API unit suite**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run
```
Expected: green. This is the job that would catch a contract test this plan did
not name — in particular `scheduleRegistry.contract.test.ts`,
`workerReadinessManifest.test.ts` and `composeBindMounts.test.ts`.

- [ ] **Step 4: Schema drift**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm db:check-drift
```
Expected: no drift. A mismatch means the Drizzle model and the migration
disagree — most likely the composite primary key or a `bigint` mode.

- [ ] **Step 5: The RLS and integration contract suites**

Run (bring the stack up if Task 1 left it down):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack up
pnpm db:migrate
cd apps/api
npx vitest run --config vitest.config.rls.ts
npx vitest run --config vitest.config.rls-coverage.ts
npx vitest run --config vitest.integration.config.ts
```
Expected: all three green. `pnpm test` does **not** run any of them, so local
green without this step is not CI green — and the org-cascade and export-policy
suites in the integration config only fail here, never in the unit job.

- [ ] **Step 6: Web tests**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run
```
Expected: green, including `SendingDomainsAdmin.test.tsx`, both trust-component
suites, the locale-parity suites and `no-silent-mutations.test.ts`.

- [ ] **Step 7: Tear the stack down**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: the worktree's test stack is gone, and the listing shows nothing this
session brought up. Nothing reaps a local stack for you.

- [ ] **Step 8: Open the PR**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git push -u origin feature/__PARENT__-partner-sending-domains/wave-__W05__
gh pr create --base main --title "W05: partner sending domains — delivery feedback and abuse controls" --body "$(cat <<'EOF'
Closes #__W05__

W05 of the partner-sending-domains feature (spec §9.2, §9.3, §11, §16.1 step 4).
This is the gate for HOSTED general availability, not a functional dependency of
W01–W04.

- `partner_sending_daily_stats`, partner-axis RLS shape 3, PK `(partner_id, day)`.
- `POST /api/v1/webhooks/email-provider/resend`: public, Svix-signature-verified,
  replay-deduped on `svix-id`, inert with a 404 when
  `EMAIL_DOMAINS_WEBHOOK_SECRET` is unset.
- Automatic suspension on the 7-day bounce rate or complaint count, through
  W02b's kill switch, with one ops alert per partner. Manual unsuspend only.
- Four abuse signals in `runAbuseSweep`, the partner's sending domains on the
  trust evidence card, and 7-day deliverability on the platform-admin list with
  a new `/admin/sending-domains` page.

**Self-hosted is unchanged by this wave.** The endpoint 404s without the secret,
auto-suspension is off unless a threshold is set, the stats table stays empty,
and `static` mode produces no provider events at all. No new env var is
required by an upgrade.

Three new optional variables: `EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE`,
`EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES`, `EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS`.
Operators on a customised compose file need the mapping lines; the release notes
call them out.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Rollout (operator checklist — NOT a Codex task)

Spec §16.1 step 4. Run this **after** W05 has merged and shipped in a release.
Nothing here belongs in the PR.

### 1. Configure the provider webhook, per region

For **each** regional partner-lane Resend team (US and EU — they are separate
teams on separate instances, spec §2):

1. Create a webhook endpoint pointing at that region's API:
   `https://<region>.2breeze.app/api/v1/webhooks/email-provider/resend`.
2. Subscribe **exactly** these events:
   `email.sent`, `email.delivered`, `email.bounced`, `email.complained`,
   `email.failed`, `email.suppressed`, `domain.updated`.
   **`email.sent` is not optional.** It is the only writer of the `sent` column
   and therefore of the rate denominator; without it the denominator falls back
   to `delivered + bounced + failed`, which is correct but noisier.
   Do **not** subscribe `email.opened` / `email.clicked`: the handler ignores
   them, and they are the highest-volume events Resend emits.
3. Copy the endpoint's signing secret (it starts `whsec_`).

### 2. Put the secret on both droplets

```bash
ssh root@<droplet> "cd /opt/breeze && \
  cp .env .env.bak-pre-emaildomains-webhook && \
  printf '%s\n' 'EMAIL_DOMAINS_WEBHOOK_SECRET=whsec_…' >> .env"
```

Then map it in the `api` service's `environment:` block of
`/opt/breeze/docker-compose.yml`. **A value in `.env` alone is inert** —
compose only interpolates variables listed there. Add the four lines together:

```yaml
  EMAIL_DOMAINS_WEBHOOK_SECRET: ${EMAIL_DOMAINS_WEBHOOK_SECRET:-}
  EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE: ${EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE:-}
  EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES: ${EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES:-}
  EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS: ${EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS:-}
```

The three threshold variables may stay unset: hosted defaults to 0.08 / 50 / 3.
Set them only to diverge from the published defaults.

Restart and assert version parity afterwards — the deploy service list is
hand-maintained and has gone stale before:

```bash
ssh root@<droplet> "cd /opt/breeze && docker compose up -d api web portal"
ssh root@<droplet> "cd /opt/breeze && set -a && . ./.env && set +a && \
  docker ps -a --format '{{.Names}}\t{{.Image}}' | grep 'ghcr.io/lanternops/breeze/' | \
  while IFS=\$'\t' read -r n i; do t=\${i##*:}; \
    [ \"\$t\" = \"\$BREEZE_VERSION\" ] && echo \"OK    \$n \$t\" || echo \"SKEW  \$n \$t (expected \$BREEZE_VERSION)\"; done"
```
Every line must read `OK`.

### 3. Confirm the endpoint is live

Send a test event from the Resend dashboard and confirm:
- the delivery shows `202` (not 404 — that means the secret did not reach the
  container; not 401 — that means the wrong secret);
- a row appears in `partner_sending_daily_stats` for the tagged partner;
- nothing appears for an event with no `partner_id` tag.

### 4. Watch one week, then clear the allowlist

Leave `EMAIL_DOMAINS_PARTNER_ALLOWLIST` set for a full week with the
allow-listed partners sending real customer mail, and check daily at
`/admin/sending-domains`:
- 7-day messages is non-zero and roughly matches what the partner sent;
- bounce rate is well under the 8% threshold;
- complaints are 0;
- no `abuse_auto` suspension fired unexpectedly.

Also check `/admin/trust-queue`: each allow-listed partner's evidence card now
lists its sending domains, and the abuse sweep is emitting
`email.sending_domain_added` at `info` (visible in the weekly digest's watch
list only if it were `watch` — at `info` it is visible through
`GET /admin/abuse/signals?signalKey=email.`).

Then, and only then, **clear `EMAIL_DOMAINS_PARTNER_ALLOWLIST`** on both
droplets and restart `api`. That is hosted general availability.

### 5. Close out the tracking issues (spec §16.1 step 5)

- **#4199** — close it once a *fresh* partner-verification email confirms the
  2026-09-10 SPF/DMARC fix. Paste the passing `Authentication-Results` header
  into the closing comment.
- **#3363** — **leave open.** This feature does not fix it: partners without a
  custom domain still send from the shared `2breeze.app` address, which still
  has no MX and no usable reply path. Add a comment saying so and linking this
  wave, so nobody closes it as collateral.
- Add a release-note line for the three new optional variables and the compose
  mapping, for self-hosters on a customised compose file.

---

## Self-review

Every in-scope spec requirement mapped to the task that satisfies it.

| Spec requirement | Task |
|---|---|
| §9.2 — `ComputedSignal` producer under `services/abuseSignals/`, wired into `runAbuseSweep` | 10 |
| §9.2 — signal: **sending domain added, with the domain name** for lookalike review | 10 (`email.sending_domain_added`, `evidence.domains` carries the names) |
| §9.2 — signal: **repeated failed verifications** | 10 (`email.sending_domain_verify_failures`) |
| §9.2 — signal: **daily cap hit** | 9 (the Redis day-hash `recordPartnerLaneCapHit` now writes) + 10 (`email.partner_lane_cap_hit`) |
| §9.2 — signal: **bounce or complaint threshold crossed** | 10 (`email.sending_bounce_complaint`) |
| §9.2 — **the trust evidence card lists the partner's sending domains** | 11 (API card + both web consumers) |
| §9.3 — `POST /webhooks/email-provider/resend`, **signature-verified (svix scheme)** | 6 (verifier) + 7 (route) |
| §9.3 — **registered as a public route** | 8 (mount + `routerAuthGate` EXEMPT + mount-order regression + isolated rate-limit bucket) |
| §9.3 — **DB work in system context** | 2 (`withSystemDbAccessContext` on every statement) + 14 (proved on real Postgres with no ambient context) |
| §9.3 — handles `email.bounced`, `email.complained`, `email.delivered`, `email.failed`, `email.suppressed` | 7 (`EVENT_COLUMN` map, one test per type) |
| §9.3 — `domain.updated` **just enqueues `sync-domain`** | 7 (`handleDomainUpdated`, by `provider_domain_id`) |
| §9.3 — `partner_sending_daily_stats (partner_id, day, sent, delivered, bounced, complained)`, **partner-axis** | 1 (plus `failed` and `suppressed`; no `domain_id` — plan amendment 2) |
| §9.3 — **attributed by the `partner_id` tag** | 7 (UUID check + existence check in the statement; unknown counts nowhere and logs once) |
| §9.3 — `sent` has a writer | 1, 2, 7 (`email.sent` provider event — plan amendment 1; the send path stays write-free) |
| §9.3 — **automatic suspension**: 7-day bounce rate > 8% over ≥ 50 messages | 4 (`evaluateAutoSuspension`, strictly-greater, threshold matrix tested at and over) |
| §9.3 — **or 3 complaints in 7 days** | 4 (absolute rule, tested at 2 and at exactly 3) |
| §9.3 — **every domain of the partner set to `suspended` / `abuse_auto`** | 4 (fan-out through W02b's `suspendSendingDomain`, widened per plan amendment 4) |
| §9.3 — **with an ops alert** | 4 (exactly one per partner, not one per domain) |
| §9.3 — **thresholds are env vars** | 3 (`EMAIL_DOMAINS_AUTOSUSPEND_{BOUNCE_RATE,MIN_MESSAGES,COMPLAINTS}`, declared the W02a way) |
| §9.3 — **the admin list shows 7-day volume, bounce and complaint rates** | 12 (one grouped query, no N+1) + 13 (the page that shows them) |
| §9.3 / §15 — evaluation **not inline in the webhook request** | 5 (`evaluate-auto-suspend`, `jobId = autosuspend:<partnerId>` so bursts collapse) |
| §9.3 — an already-suspended partner is a no-op | 4 (the load filters to `verified`/`at_risk`; tested) |
| §9.3 — **unsuspend stays manual** | 4 (nothing in `autoSuspend.ts` clears a suspension) + 13 (the admin action) |
| §11 — `EMAIL_DOMAINS_WEBHOOK_SECRET`; **unset = webhook endpoint inert** | 7 (404 before body, Redis or DB) + 14 (proved end-to-end) |
| §11 — **no new env var is ever required by an upgrade** | 3 (three optional strings, no `requireIf`; `validate.test.ts` pins boot with all unset) |
| §9.3 last ¶ — **self-hosted: auto-suspension off unless thresholds are set** | 3 (`enabled: isHosted() \|\| configured`) + 4 (`'disabled'` short-circuit) |
| §9.3 last ¶ — **self-hosted: stats stay empty, `static` has no provider events** | 1 (table created empty) + 7 (no secret → 404; `static` never calls a provider that emits events) |
| §16.1 step 4 — configure the webhook + secret per region, watch a week, clear the allowlist | Rollout §1–4 |
| §16.1 step 5 — close #4199, keep #3363 open | Rollout §5 |
| §14 — integration on real Postgres: RLS forge, org-scope zero rows, concurrency, end-to-end | 14 |
