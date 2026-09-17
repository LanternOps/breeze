---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner Sending Domains W04: Partner Lane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the partner lane real. `resolveSender` gains the partner branch of spec §8.3 — one joined read of `partners` + `partner_sender_identities` + `partner_sending_domains`, four eligibility conditions in order, a From on the partner's own domain. `sendEmail` gains the partner-lane transport and its failure semantics (§8.4): a definitive refusal falls back to the platform lane and never loses the message, an ambiguous one never crosses lanes. A Redis daily cap (§9.1) bounds the blast radius. `X-Breeze-Outbound` plus a Message-ID rule stop our own mail from re-entering the ticket pipeline (§8.5). The two call sites W01 left at `partnerId: null` learn their partner, so the `general` stream and portal password resets can actually use the lane. **With `EMAIL_DOMAINS_PROVIDER` unset — the default on hosted and self-hosted — `isPartnerLaneConfigured()` is false and `resolveSender` still returns the platform lane with reason `lane_unconfigured` before any DB read, so this wave lands dark.**

**Architecture:** Three new modules under `apps/api/src/services/emailDomains/`. `sendCap.ts` is a fixed-window Redis counter per partner per UTC day (`multi().incr().expire()`, the `m365ControlPlane/readActionBudget.ts` idiom) that fails to the **platform lane** when Redis is unavailable — the only choice that neither loses mail nor lets an outage lift the abuse cap. `partnerLaneLookup.ts` owns everything that touches the database or the trust service: the ambient-context decision (read in place under system or partner scope; `readWithPartnerAxisVisibility` from org scope, portal and no-context), the single joined read, and the side-effect-free `evaluateCapabilityContinuationForState` call. `senderResolution.ts` imports it **dynamically**, inside the partner branch only, so a platform purpose never even loads the db module (plan amendment 1). `partnerLaneSend.ts` builds the `PartnerLaneMessage`, stamps `X-Breeze-Outbound` and the four provider tags onto a **fresh** headers object, calls `getEmailDomainProvider()!.send(...)`, and classifies the outcome; `EmailService.sendEmail` imports it dynamically too and either returns, falls back through `deliverRaw` with the purpose's `platformFallbackFrom`, or rethrows. Loop prevention marks our own mail rather than guessing from the sender: both inbound normalizers surface the header into `NormalizedInboundEmail.outboundMarker`, and `inboundEmailService`'s existing self-loop drop gains two more reasons.

**Tech Stack:** TypeScript (Hono API), Drizzle ORM, ioredis, Vitest (unit + the RLS/integration contract suites on real Postgres), `tsc --noEmit` over `apps/api/tsconfig.json`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md` §8.2 (ticket precedence, the last rule), §8.3 (resolution, eligibility, Reply-To precedence), §8.4 (failure semantics), §8.5 (threading and loop prevention), §9.1 (allowlist, kill switch, caps, eligibility at send), §13 (rows "Partner lane paused or rate-limited", "`static`: the relay refuses the custom sender", "Partner suspended or restricted"), §14 (sender resolution, `sendEmail` error classes, the transport matrix for `static`, loop prevention, the integration bullet), §15 row W04. Plan index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md` — the "Defined in W01", "Defined in W02", "Defined in W03" and "Defined in W04" contract blocks, which are binding.

---

## Plan amendments

Deviations from the spec, the index or W01, each forced by the real code and verified by reading the file cited on 2026-09-17. W01, W02 and W03 are treated as merged.

1. **The partner branch's database work lives behind a dynamic import.** `apps/api/src/db/index.ts` runs `dotenv`, resolves a connection config and constructs a `postgres()` client at module load (`db/index.ts:1-3, 28-42`), and `services/partnerTrust.ts` statically imports `./partnerTrust.repo`, `./auditService` and `./redis` (`partnerTrust.ts:1-8`). A static `import { db } from '../../db'` in `senderResolution.ts` would drag both graphs into **every** suite that imports `services/email.ts` — including `email.golden.test.ts` and `email.test.ts`, which mock neither and call `vi.resetModules()` before each case. So the read, the trust evaluation and the partner-axis escape live in `services/emailDomains/partnerLaneLookup.ts`, which `senderResolution.ts` reaches only through `await import('./partnerLaneLookup')` inside the partner branch. `EmailService.sendEmail` reaches `partnerLaneSend.ts` the same way, which additionally breaks a genuine cycle (`email.ts` → `partnerLaneSend.ts` → `providerRegistry.ts` → `adapters/static.ts` → `email.ts`), and `partnerLaneSend.ts` reaches `jobs/sendingDomainsWorker.ts` the same way (BullMQ, and that worker sends `staff.sending_domain_status` through `getEmailService()`). Established precedent for exactly this: `services/policyEvaluationService.ts:1322`, `services/aiBudgetAlerts.ts:157`, `services/drExecutionService.ts:480`, `services/eventSubscribers.ts:70`.

2. **A partner-scoped ambient context NEVER takes the partner-axis escape.** Spec §8.3 says the escape is taken "otherwise (org scope, portal, no context)" — its own parenthetical omits partner scope. That omission is load-bearing: `readWithPartnerAxisVisibility` runs the read as `system`, so escalating for a partner-scoped caller whose `accessiblePartnerIds` does not contain the requested partner would hand partner B the identity of partner A. Under partner scope the lookup therefore runs **in place**, and RLS decides: accessible → rows; not accessible → zero rows → the platform lane with reason `partner_ineligible`. Fail closed, no escalation. This is what makes the cross-partner integration assertion in Task 11 provable at all.

3. **`recordPartnerLaneCapHit` lives in `sendCap.ts` and is called by `sendCap.ts`, not by the resolver.** The index's "Defined in W04" block names only `tryCountPartnerLaneSend(partnerId): Promise<boolean>`. Exporting the hook from the same module is additive, and calling it there is the only way to distinguish a genuine cap hit from a Redis outage: both return `false` to the resolver, but only the first is an abuse signal for W06 to produce. A Redis outage must never fabricate one.

4. **`over_cap` is also the reason for "cap could not be evaluated".** `PlatformLaneReason` is fixed by the index and has no `cap_unavailable`. A Redis outage therefore resolves to `over_cap` (the safe direction — platform lane, no mail lost, no cap lifted) and is told apart in the logs by a distinct structured line emitted inside `sendCap.ts`. If W06 wants a separate reason, it changes the index.

5. **`NormalizedInboundEmail` has no generic header bag, so the marker needs a field.** `services/inboundEmail/types.ts:44-70` carries `autoSubmitted` and `precedence` as *named* fields precisely because the two providers surface headers differently: Mailgun ships a JSON `message-headers` form field (`mailgun.ts:60-63`, `parseHeader` at `:204`) and Graph ships `internetMessageHeaders` (`normalizeGraphMessage.ts:83-84`, `header()` at `:4`). `raw` is NOT a substitute — Mailgun's `raw` is the whole form body, Graph's is `{ graphConversationId, receivedDateTime }` only. W04 adds one field, `outboundMarker?: string`, populated by both normalizers with the same helper each already uses.

6. **The marker check belongs at ingest, not in `loopPrevention.ts`'s existing function.** `autoresponseSuppressionReason` only suppresses the **autoresponse** (its single caller is `autoresponder.ts:114`); spec §8.5 says the mail must be *ignored*. The ingest-time self-loop drop at `inboundEmailService.ts:192-205` is where "ignored" is implemented, so W04 adds a second exported function, `ownOutboundReason`, in `loopPrevention.ts` and calls it there. The file is still the right home — it is the module the spec names and the one that already owns "is this our own mail".

7. **`invoiceResend.test.ts` and `quoteLifecycle.test.ts` get their partner-lane case through the real `resolveSender`, not through a real transport.** Both suites mock `getEmailService` wholesale (`quoteLifecycle.test.ts:84-88`, `invoiceResend.test.ts:86-90`), so a "partner-lane case" asserted against their `sendEmailMock` would be vacuous. Instead each suite feeds the envelope it captured into the real `resolveSender` with `partnerLaneLookup` mocked, which fails the moment either call site regresses to `partnerId: null`. The end-to-end partner-lane send lives in `email.test.ts` (Task 5) and `staticTransportMatrix.test.ts` (Task 6).

8. **W04 owns the structured-transport-error fix W02 deferred.** W02 plan amendment 7 states it explicitly: W01's `deliverRaw` inherits today's throws, so the `static` adapter's send-error classifier has only text to work with — the Resend branch throws `new Error(\`Resend error: ${error.message}\`)` (`services/email.ts:265`), discarding `error.name` and `error.statusCode`; the Mailgun branch throws `Mailgun API error (<status>)<details>` (`services/email.ts:807`); the SMTP branch does not catch at all (`services/email.ts:300`), so nodemailer's error arrives intact with `responseCode`/`response`. "Carrying a structured cause out of `deliverRaw` is a W04 follow-up." Task 3 does it. The one hard constraint is that `.message` stays **byte-for-byte identical**, because three live matchers key on it: `services/reportNarrativeDelivery.ts:138` (`/^Resend error:/i`), `:145-146` (`/^Mailgun API error \((?:408|429)\)/i` and `/^Mailgun API error \(4\d\d\)/i`), and `services/notificationChannelSecrets.test.ts:127`. `EmailTransportError extends Error` therefore changes the error's **shape**, never its text.

9. **The report-delivery snapshot suite needs one more queued `select`.** `reportDelivery.snapshot.test.ts:162-175` drives `processRunScheduledReport` with a FIFO queue of exactly three `selectMock.mockReturnValueOnce(...)` entries; a fourth `db.select` would receive `undefined` and throw on `.from`. Task 8 adds the org→partner read after `resolveOrgTimezone`, so a fourth entry is appended in the same task, and the five success snapshots are regenerated (`partnerId` goes from `null` to the partner id). The failure snapshot is untouched — `emailReportFailure` is `staff.report_failure`, a platform purpose.

---

## Global Constraints

Verbatim binding rules for this wave.

- **Platform purposes never read the database and never reach the partner lane.** Whatever `partnerId` a caller passes, a `{ lane: 'platform' }` registry entry returns `{ lane: 'platform', reason: 'platform_purpose' }` before anything is imported, read or counted. Spec G4 rests on this: a partner's sending reputation must not be able to stop a password reset.
- **An ambiguous failure never crosses lanes.** `message_rejected` and `ambiguous` throw, exactly as today. A message whose fate is unknown is never re-sent on the platform lane, because a recipient receiving two copies is worse than a retry.
- **The fallback never loses mail.** `domain_unusable` and `lane_unavailable` mean the message was definitively NOT sent; it goes out on the platform lane with the purpose's `platformFallbackFrom`, carrying neither `X-Breeze-Outbound` nor any partner tag.
- **`partnerId` never comes from request input.** It comes from a row the call site already read under its own RLS context, or from the verified auth context (spec §8.1).
- **The send path never WRITES a partner-axis table.** `last_send_error` / `last_send_error_at` are written by the worker from the `sync-domain` payload (spec §3.1), never by `sendEmail`, which may be running in a context that cannot write them. This is also a CI contract: `ALLOWED_WITHOUT_CAPABILITY_CHECK` in `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:64` greps every file under `src/routes/**` and `src/services/**` for `.insert|update|delete(<partner-axis table>` without `canManagePartnerWidePolicies` and reds the required **Test API** job (W02 plan amendment 3, W03 plan amendment 10 — which also verified that **`src/jobs/**` is NOT scanned**, so Task 7's write inside `sendingDomainsWorker.ts` needs no entry). W04 adds **no** entry to that allowlist, because it adds no such write — `senderResolution.ts`, `partnerLaneLookup.ts` and `partnerLaneSend.ts` only SELECT, and the refusal text reaches the row through `enqueueSyncDomain(domainId, { lastSendError })`. Task 12 greps for this.
- **No cache.** Resolution reads the row on every send, which is what makes suspend/unsuspend and a trust-state change take effect on the next message (spec §8.3, §9.1 kill switch).
- **No new table, no migration, no new env var.** W04 consumes `EMAIL_DOMAINS_*` as W02 declared them; the index reserves no migration slot for this wave.
- **Rigor is high** (send path, tenancy, abuse surface — index "Rules every wave inherits"). Red first on every task: write the failing assertion, run it, watch it fail, then implement. Before the PR: `pnpm test-stack up`, the RLS and integration contract suites, then `pnpm test-stack down` — nothing reaps it for you.
- **Test command form:** `cd apps/api && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>`: pnpm forwards the literal `--`, vitest swallows `--run`, and the whole suite runs in watch mode. Vitest's path filter is a plain substring, so list sibling files explicitly and check the reported file count.
- **Branch `feature/__PARENT__-partner-sending-domains/wave-__W04__`; PR body contains `Closes #__W04__`.** `get_feature_status` before starting.
- **Commit after every task** with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Consumed from W02/W03 (reconciled)

Both plans are complete and were re-read before this one was finalised. **Every name below was read from their Interfaces blocks — W04 guesses none of them.** Where a shape differs from the plan index's "Defined in W02/W03" list, the wave's own plan wins and the difference is called out.

| Name | Source | Status |
|---|---|---|
| `partnerSendingDomains`, `partnerSenderIdentities` (Drizzle, column names) | W02 Task 1 | verified |
| `PartnerLaneMessage = RawEmailMessage`; `class PartnerLaneSendFailure extends Error { constructor(readonly error: PartnerLaneSendError) }` with `.name = 'PartnerLaneSendFailure'` and message `partner lane send failed: <kind>` | W02 Task 6 | verified |
| `getEmailDomainProvider(): EmailDomainProvider \| null`, `resetEmailDomainProviderForTests()` (`providerRegistry.ts`) | W02 Task 6 | verified |
| `EmailDomainProvider.send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string,string> }): Promise<{ providerMessageId: string }>` | W02 Task 6 | verified |
| `getEmailDomainsConfig(): EmailDomainsConfig` with `dailySendCap: number` (0 = unlimited) and `partnerAllowlist: string[]`; `isPartnerLaneConfigured(): boolean`; `findStaticAllowedEntry` | W02 Task 5 | verified — W04 reads only `dailySendCap` and `partnerAllowlist` |
| `GatedCapability` includes `'custom_sending_domain'` | W02 Task 10 | verified |
| `createStaticDomainProvider()`, `classifyPlatformTransportError(err: unknown): PartnerLaneSendError` exported from `services/emailDomains/adapters/static.ts`; the `static` adapter calls `getEmailService().deliverRaw(raw)` and wraps any throw in `PartnerLaneSendFailure(classifyPlatformTransportError(err))` | W02 Task 8 | verified — Task 3 upgrades that classifier |
| `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` exists (W02 Task 12) | W02 File Structure | verified it is created there; Task 11 appends to it and reuses its `SYSTEM_CTX` / `partnerContext` / `orgContext` / `fixture` / `seedDomain` helpers verbatim |
| `SENDING_DOMAINS_QUEUE = 'sending-domains'`; `enqueueSyncDomain(domainId: string, opts?: { lastSendError?: string }): Promise<void>`; `enqueueTestSend(domainId, userId)`; `initializeSendingDomainsWorker`; `shutdownSendingDomainsWorker`; `runSendingDomainsSweep`; `runDailyMaintenance` (`apps/api/src/jobs/sendingDomainsWorker.ts`) | W03 Task 4 | verified |
| `runTestSend(domainId: string, userId: string): Promise<'sent' \| 'refused' \| 'skipped'>` — **this**, not an inline job handler, is the function Task 7 edits | W03 Task 4 | verified |
| `markStaticDomainVerified(domainId: string, now?: Date): Promise<boolean>` (`services/emailDomains/domainSync.ts`) — the ONLY path a `static` row reaches `verified`, called by `runTestSend` **after** an accepted send | W03 Task 3, Global Constraints | verified |
| The worker's Redis accessor is `getRedis()` from `services/redis.ts` (`services/emailDomains/keyProbe.ts`, W03 Task 4, Step 4) — the same shared client `sendCap.ts` uses, with the same `getRedis() → null` degrade | W03 Task 4 | verified |
| W03 amendment 7: the test send is bounded by the route's 5/h/partner limit alone in that wave, and "W04 adds the cap call to the `test-send` processor" | W03 amendment 7 | verified — Task 7 discharges it |
| W03 amendment 10: `partner-wide-write-coverage.test.ts` scans `src/routes/**` and `src/services/**` only — **`src/jobs/**` is NOT scanned**, so `sendingDomainsWorker.ts` needs no allowlist entry despite updating `partnerSendingDomains` | W03 amendment 10 | verified |

**Still unpinned: nothing.** One reconciliation note for the executor: W03's `sendingDomainsWorker.test.ts` already mocks `../services/emailDomains/config` with `dailySendCap: 0`, so W04's cap must be mocked as its own `vi.mock('../services/emailDomains/sendCap', …)` block rather than by editing that config mock — the cap is read inside `sendCap.ts`, which the worker no longer touches directly.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/emailDomains/sendCap.ts` (+ `.test.ts`) | `tryCountPartnerLaneSend`, `recordPartnerLaneCapHit` | 1 |
| `apps/api/src/services/emailDomains/partnerLaneLookup.ts` (+ `.test.ts`) | ambient-context decision, the one joined read, trust evaluation | 2 |
| `apps/api/src/services/emailDomains/senderResolution.ts` (+ `.test.ts`) | the partner branch of `resolveSender`, conditions 1–4, From, Reply-To | 2 |
| `apps/api/src/services/email.ts` (+ `email.transportError.test.ts`) | `EmailTransportError` thrown from all three `deliverRaw` branches, `.message` byte-identical | 3 |
| `apps/api/src/services/emailDomains/adapters/static.ts` (+ `static.test.ts`) | `classifyPlatformTransportError` prefers the structured fields, falls back to text | 3 |
| `apps/api/src/services/emailDomains/outboundMarker.ts` | `BREEZE_OUTBOUND_HEADER` | 4 |
| `apps/api/src/services/emailDomains/partnerLaneSend.ts` (+ `.test.ts`) | `sendOnPartnerLane`, tags, failure classification, ops alert, `enqueueSyncDomain` | 4 |
| `apps/api/src/services/email.ts`, `apps/api/src/services/email.test.ts` | partner lane wired into `sendEmail`; the four error kinds + unknown exception | 5 |
| `apps/api/src/services/emailDomains/staticTransportMatrix.test.ts` | spec §14 "Transport matrix for `static`" | 6 |
| `apps/api/src/jobs/sendingDomainsWorker.ts` (+ `sendingDomainsWorker.test.ts`) | `runTestSend` counts against the daily cap, before the send and before `markStaticDomainVerified` | 7 |
| `apps/api/src/routes/portal/auth.ts` (+ `portal/auth.test.ts`) | `portal.password_reset` resolves the org's partner | 8 |
| `apps/api/src/services/reportDelivery.ts`, `jobs/reportScheduleWorker.ts`, `services/reportNarrativeDelivery.ts`, `services/reportDelivery.snapshot.test.ts` (+ `.snap`) | `report.delivery` carries the report org's partner | 8 |
| `apps/api/src/jobs/ticketNotifyWorker.test.ts`, `apps/api/src/services/quoteLifecycle.test.ts`, `apps/api/src/services/invoiceResend.test.ts`, `apps/api/src/routes/orgPortalUsers.test.ts` | every other partner-lane site proves a non-null `partnerId`; Graph precedence and threading headers unchanged | 9 |
| `apps/api/src/services/inboundEmail/types.ts`, `services/inboundEmail/mailgun.ts`, `services/ticketMailbox/normalizeGraphMessage.ts` | `outboundMarker` surfaced by BOTH inbound providers | 10 |
| `apps/api/src/services/inboundEmail/loopPrevention.ts` (+ `.test.ts`) | `outboundMessageIdPattern`, `ownOutboundReason` | 10 |
| `apps/api/src/services/inboundEmail/inboundEmailService.ts` (+ `inboundEmailService.test.ts`) | ignore our own outbound at ingest | 10 |
| `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` | resolution from org scope, from the portal reset path, and from another partner | 11 |

---

### Task 1: The daily send cap

**Files:**
- Create: `apps/api/src/services/emailDomains/sendCap.ts`
- Create: `apps/api/src/services/emailDomains/sendCap.test.ts` (Test)

**Interfaces:**
- Consumes: `getRedis` from `../redis` (`apps/api/src/services/redis.ts:110`, returns `Redis | null`) — the SAME shared client accessor W03's `services/emailDomains/keyProbe.ts` uses, with the same `getRedis() → null` degrade; `getEmailDomainsConfig` from `./config` (W02 Task 5).
- Produces:
  ```ts
  export function partnerLaneCapKey(partnerId: string, now: number): string;
  export function recordPartnerLaneCapHit(partnerId: string): void;
  export function tryCountPartnerLaneSend(partnerId: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/emailDomains/sendCap.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock, getConfigMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('./config', () => ({ getEmailDomainsConfig: getConfigMock }));

import { partnerLaneCapKey, tryCountPartnerLaneSend } from './sendCap';

const PARTNER = '11111111-1111-1111-1111-111111111111';

/** ioredis `multi()` chain: incr -> expire -> exec, exec resolving [[null, n], [null, 1]]. */
function redisWithCount(count: number) {
  const chain = {
    incr: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec: vi.fn(async () => [[null, count], [null, 1]]),
  };
  return { multi: vi.fn(() => chain), __chain: chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockReturnValue({ dailySendCap: 2000, partnerAllowlist: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('partnerLaneCapKey', () => {
  it('is one fixed window per partner per UTC day', () => {
    const noon = Date.UTC(2026, 8, 17, 12, 0, 0);
    const lateSameDay = Date.UTC(2026, 8, 17, 23, 59, 59);
    const nextDay = Date.UTC(2026, 8, 18, 0, 0, 1);
    expect(partnerLaneCapKey(PARTNER, noon)).toBe(partnerLaneCapKey(PARTNER, lateSameDay));
    expect(partnerLaneCapKey(PARTNER, noon)).not.toBe(partnerLaneCapKey(PARTNER, nextDay));
    expect(partnerLaneCapKey(PARTNER, noon)).toContain(PARTNER);
  });
});

describe('tryCountPartnerLaneSend (spec §9.1)', () => {
  it('allows and counts a send under the cap', async () => {
    const redis = redisWithCount(1);
    getRedisMock.mockReturnValue(redis);
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    expect(redis.__chain.incr).toHaveBeenCalledWith(partnerLaneCapKey(PARTNER, Date.now()));
    // The expiry is set on EVERY increment, in the same round trip. A bare INCR
    // would leave an immortal key per partner per day forever.
    expect(redis.__chain.expire).toHaveBeenCalledTimes(1);
    expect(redis.__chain.expire.mock.calls[0]![1]).toBeGreaterThan(86_400);
  });

  it('allows the send that exactly reaches the cap and refuses the next one', async () => {
    getRedisMock.mockReturnValue(redisWithCount(2000));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  // Spec §9.1: the cap defaults to unlimited when !isHosted(). A self-hoster's
  // volume is their own business, and silently moving their ticket mail back to
  // the old From at message 2,001 would be a bug report, not a protection.
  it('is unlimited at 0 and never touches Redis', async () => {
    getConfigMock.mockReturnValue({ dailySendCap: 0, partnerAllowlist: [] });
    getRedisMock.mockReturnValue(redisWithCount(9_999_999));
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(true);
    expect(getRedisMock).not.toHaveBeenCalled();
  });

  // Redis down is NOT "unlimited". Fail to the PLATFORM lane: the message still
  // goes out (nothing is lost, spec G3) and an outage cannot lift the abuse cap.
  it('refuses the partner lane when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  it('refuses the partner lane when Redis throws', async () => {
    getRedisMock.mockReturnValue({ multi: () => { throw new Error('ECONNRESET'); } });
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  it('refuses the partner lane when the multi result is unreadable', async () => {
    const chain = { incr: vi.fn(() => chain), expire: vi.fn(() => chain), exec: vi.fn(async () => null) };
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    await expect(tryCountPartnerLaneSend(PARTNER)).resolves.toBe(false);
  });

  // A Redis outage must NOT fabricate an abuse signal for W06 to act on.
  it('logs a cap hit only for a genuine over-cap count, never for an outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getRedisMock.mockReturnValue(redisWithCount(2001));
    await tryCountPartnerLaneSend(PARTNER);
    expect(warn.mock.calls.flat().join(' ')).toContain('daily partner-lane cap');

    warn.mockClear();
    getRedisMock.mockReturnValue(null);
    await tryCountPartnerLaneSend(PARTNER);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('daily partner-lane cap');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/sendCap.test.ts
```

Expected failure: `Failed to load .../sendCap.test.ts` … `Cannot find module './sendCap'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/emailDomains/sendCap.ts`:

```ts
import { getRedis } from '../redis';
import { getEmailDomainsConfig } from './config';

/**
 * Daily partner-lane send cap (spec §9.1).
 *
 * A fixed-window counter per partner per UTC day, incremented and expired in
 * ONE round trip — the `services/m365ControlPlane/readActionBudget.ts` idiom,
 * on the same shared `getRedis()` client as the feature's other Redis state
 * (`services/emailDomains/keyProbe.ts`).
 * The increment happens even on the call that trips the limit: a denied send
 * still cost a slot, which makes the cap slightly conservative under bursts,
 * the safe direction for an abuse control.
 *
 * FAILURE DIRECTION: when Redis cannot answer, this returns FALSE — the send
 * goes out on the PLATFORM lane. That is the only option that satisfies both
 * halves of the contract at once: nothing is lost (spec G3 — the platform lane
 * still delivers the message from EMAIL_FROM), and an outage cannot silently
 * lift the abuse cap on partner-domain mail. Failing "open to the partner lane"
 * would turn a Redis blip into unbounded sending from customer domains; failing
 * "closed by throwing" would lose the mail outright. Cf. readActionBudget.ts,
 * which fails closed for the same reason but has no second lane to fall to.
 */

/** TTL comfortably past the window so a clock skew cannot orphan the counter. */
const CAP_KEY_TTL_SECONDS = 90_000; // 25 h

export function partnerLaneCapKey(partnerId: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `email-domains:partner-lane-sends:${partnerId}:${day}`;
}

/**
 * The daily cap was reached for this partner. W06 owns the abuse-signal
 * producer (spec §9.2) and wires it here; W04 records the structured line so
 * the event is observable from day one.
 *
 * Called ONLY on a genuine over-cap count — never on a Redis outage, which
 * also returns false. A signal that cannot tell the two apart would accuse a
 * partner of abuse every time our own cache went down.
 */
export function recordPartnerLaneCapHit(partnerId: string): void {
  console.warn('[emailDomains/sendCap] daily partner-lane cap reached', { partnerId });
}

export async function tryCountPartnerLaneSend(partnerId: string): Promise<boolean> {
  const cap = getEmailDomainsConfig().dailySendCap;
  // 0 = unlimited (spec §11). Do not even open a Redis connection for it: the
  // self-hosted default is unlimited and most self-hosted installs run without
  // any of this configured.
  if (!Number.isFinite(cap) || cap <= 0) return true;

  const now = Date.now();
  const key = partnerLaneCapKey(partnerId, now);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error('[emailDomains/sendCap] Redis unavailable; routing to the platform lane', { partnerId });
      return false;
    }

    const results = await redis.multi().incr(key).expire(key, CAP_KEY_TTL_SECONDS).exec();
    if (!results) {
      console.error('[emailDomains/sendCap] Redis multi returned null; routing to the platform lane', { partnerId });
      return false;
    }

    const raw = results[0]?.[1];
    const count = typeof raw === 'number' ? raw : Number(raw ?? NaN);
    if (!Number.isFinite(count)) {
      console.error('[emailDomains/sendCap] unexpected multi() result shape; routing to the platform lane', { partnerId, results });
      return false;
    }

    if (count > cap) {
      recordPartnerLaneCapHit(partnerId);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[emailDomains/sendCap] Redis error; routing to the platform lane', { partnerId, err });
    return false;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/emailDomains/sendCap.test.ts
```

Expected: `Test Files  1 passed (1)`, 8 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/emailDomains/sendCap.ts apps/api/src/services/emailDomains/sendCap.test.ts
git commit -m "$(cat <<'EOF'
feat(email): daily partner-lane send cap

Spec §9.1. Fixed-window Redis counter per partner per UTC day, INCR+EXPIRE in
one multi() (the readActionBudget idiom). 0 = unlimited and never touches Redis
(the self-hosted default). When Redis cannot answer, the send goes out on the
PLATFORM lane: nothing is lost and an outage cannot lift the abuse cap.
recordPartnerLaneCapHit fires only on a genuine over-cap count, so W06's abuse
signal can never be fabricated by our own outage.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The partner branch of `resolveSender`

**Files:**
- Create: `apps/api/src/services/emailDomains/partnerLaneLookup.ts`
- Create: `apps/api/src/services/emailDomains/partnerLaneLookup.test.ts` (Test)
- Modify: `apps/api/src/services/emailDomains/senderResolution.ts` (created by W01 Task 2 — replace the `lane_unconfigured` return with the partner branch, and add the two helpers)
- Modify: `apps/api/src/services/emailDomains/senderResolution.test.ts` (created by W01 Task 2 — replace the db tripwire mock, keep every existing case, add the partner matrix)

**Interfaces:**
- Consumes: `mailPurposePolicy`, `MailPurpose`, `PartnerMailStream` from `./mailPurposes` (W01 Task 1); `fromWithDisplayName`, `platformFallbackFrom` from `./senderResolution` (W01 Task 2); `isPartnerLaneConfigured`, `getEmailDomainsConfig` from `./config` (W02); `tryCountPartnerLaneSend` from `./sendCap` (Task 1); `db`, `getCurrentDbAccessContext` from `../../db`; `readWithPartnerAxisVisibility` from `../../db/partnerAxisRead`; `partners`, `partnerSenderIdentities`, `partnerSendingDomains` from `../../db/schema`; `evaluateCapabilityContinuationForState` from `../partnerTrust`.
- Produces:
  ```ts
  // partnerLaneLookup.ts
  export type PartnerLaneLookup =
    | { ok: false; reason: 'partner_ineligible' | 'no_identity' | 'domain_not_sendable' }
    | { ok: true; partnerName: string; localPart: string; displayName: string | null;
        replyTo: string | null; domainId: string; domain: string };
  export function partnerLaneAmbientCanSee(partnerId: string): boolean;
  export async function lookupPartnerLaneIdentity(partnerId: string, stream: PartnerMailStream): Promise<PartnerLaneLookup>;
  // senderResolution.ts — unchanged public shape, partner branch now reachable
  export function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender>;
  ```

- [ ] **Step 1: Write the failing lookup test** — create `apps/api/src/services/emailDomains/partnerLaneLookup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectMock, getCurrentDbAccessContextMock, readWithPartnerAxisVisibilityMock,
  evaluateMock, partnerTrustModeMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getCurrentDbAccessContextMock: vi.fn(),
  readWithPartnerAxisVisibilityMock: vi.fn(),
  evaluateMock: vi.fn(),
  partnerTrustModeMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...(a as [])) },
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: readWithPartnerAxisVisibilityMock,
}));
vi.mock('../partnerTrust', () => ({
  evaluateCapabilityContinuationForState: evaluateMock,
}));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: partnerTrustModeMock }));

import { lookupPartnerLaneIdentity, partnerLaneAmbientCanSee } from './partnerLaneLookup';

const PARTNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  return chain;
}

function row(over: Record<string, unknown> = {}) {
  return {
    partnerName: 'Acme MSP',
    partnerStatus: 'active',
    trustState: 'trusted',
    probationEnrollments: 0,
    localPart: 'support',
    displayName: null,
    identityReplyTo: null,
    domainId: 'd1',
    domain: 'mail.acme.test',
    domainStatus: 'verified',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentDbAccessContextMock.mockReturnValue(undefined);
  readWithPartnerAxisVisibilityMock.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  evaluateMock.mockReturnValue({ allow: true });
  partnerTrustModeMock.mockReturnValue('off');
  selectMock.mockReturnValue(selectChain([row()]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('partnerLaneAmbientCanSee (spec §8.3, plan amendment 2)', () => {
  it('is true under system scope', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(true);
  });

  it('is true under partner scope whose accessible ids contain the partner', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [PARTNER] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(true);
  });

  it('is false under org scope, under portal/no context, and for a foreign partner', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], accessiblePartnerIds: [] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [OTHER] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
  });
});

describe('lookupPartnerLaneIdentity — where the read runs', () => {
  it('reads in place under system scope', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null });
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('reads in place under partner scope, even for a partner it cannot see', async () => {
    // Plan amendment 2: escalating here would hand partner B partner A's
    // identity. RLS returns zero rows instead, and the caller falls back.
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [OTHER] });
    selectMock.mockReturnValue(selectChain([]));
    const result = await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'partner_ineligible' });
  });

  it('takes the partner-axis escape from org scope and from no context', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], accessiblePartnerIds: [] });
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(1);

    getCurrentDbAccessContextMock.mockReturnValue(undefined);
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(2);
  });

  it('makes exactly ONE read (spec §8.3)', async () => {
    await lookupPartnerLaneIdentity(PARTNER, 'billing');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('lookupPartnerLaneIdentity — conditions 2 and 3 of spec §8.3', () => {
  it('returns the identity for an active, trusted partner with a verified domain', async () => {
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support')).resolves.toEqual({
      ok: true, partnerName: 'Acme MSP', localPart: 'support', displayName: null,
      replyTo: null, domainId: 'd1', domain: 'mail.acme.test',
    });
  });

  it('accepts at_risk as sendable and refuses every other domain status', async () => {
    for (const status of ['verified', 'at_risk']) {
      selectMock.mockReturnValue(selectChain([row({ domainStatus: status })]));
      expect((await lookupPartnerLaneIdentity(PARTNER, 'support')).ok).toBe(true);
    }
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      selectMock.mockReturnValue(selectChain([row({ domainStatus: status })]));
      await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
        .resolves.toEqual({ ok: false, reason: 'domain_not_sendable' });
    }
  });

  it('refuses a partner whose status is not active', async () => {
    for (const status of ['pending', 'suspended', 'churned']) {
      selectMock.mockReturnValue(selectChain([row({ partnerStatus: status })]));
      await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
        .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    }
  });

  it('refuses when the trust evaluator denies, and uses the SIDE-EFFECT-FREE evaluator', async () => {
    evaluateMock.mockReturnValue({ allow: false, code: 'TRUST_PROBATION', capability: 'custom_sending_domain', reason: 'probation_default_deny' });
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
      .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    // A send must never write a denial audit row (spec §8.3 condition 2), and
    // the continuation evaluator is the only one that writes none.
    expect(evaluateMock).toHaveBeenCalledWith(
      'custom_sending_domain',
      { partnerId: PARTNER },
      { trustState: 'trusted', probationEnrollments: 0 },
    );
  });

  it('allows when trust mode is shadow (allow: true with shadowDenied)', async () => {
    evaluateMock.mockReturnValue({ allow: true, shadowDenied: { code: 'TRUST_PROBATION', reason: 'probation_default_deny' } });
    expect((await lookupPartnerLaneIdentity(PARTNER, 'support')).ok).toBe(true);
  });

  it('refuses when the stream has no identity', async () => {
    selectMock.mockReturnValue(selectChain([row({ localPart: null, domainId: null, domain: null, domainStatus: null })]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'general'))
      .resolves.toEqual({ ok: false, reason: 'no_identity' });
  });

  it('refuses when the partner row itself is invisible or gone', async () => {
    selectMock.mockReturnValue(selectChain([]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
      .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    // A null row must reach the evaluator as null so enforce mode denies it.
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('carries the identity display name and reply-to through', async () => {
    selectMock.mockReturnValue(selectChain([row({ displayName: 'Acme Support', identityReplyTo: 'help@acme.test' })]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support')).resolves.toMatchObject({
      ok: true, displayName: 'Acme Support', replyTo: 'help@acme.test',
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/partnerLaneLookup.test.ts
```

Expected failure: `Cannot find module './partnerLaneLookup'`.

- [ ] **Step 3: Implement the lookup** — create `apps/api/src/services/emailDomains/partnerLaneLookup.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { partners, partnerSenderIdentities, partnerSendingDomains } from '../../db/schema';
import { evaluateCapabilityContinuationForState } from '../partnerTrust';
import type { PartnerMailStream } from './mailPurposes';

/**
 * Everything in the partner branch of `resolveSender` that touches the database
 * or the trust service (spec §8.3, conditions 2 and 3).
 *
 * WHY THIS IS A SEPARATE MODULE: `senderResolution.ts` imports it ONLY through
 * `await import(...)`, inside the partner branch. `db/index.ts` runs dotenv and
 * constructs a postgres client at module load, and `services/partnerTrust.ts`
 * pulls in the audit service, the trust repo and Redis — none of which may be
 * loaded by a platform-purpose send. Keeping the boundary here is what makes
 * spec §8.1's first property ("a platform purpose returns before any database
 * read") true of the MODULE GRAPH and not merely of the control flow, and it
 * keeps every existing EmailService unit suite loading exactly what it loads
 * today. See plan amendment 1.
 */

/** Domain statuses that may send on the partner lane (spec §5.2). */
const SENDABLE_DOMAIN_STATUSES = new Set(['verified', 'at_risk']);

export type PartnerLaneLookup =
  | { ok: false; reason: 'partner_ineligible' | 'no_identity' | 'domain_not_sendable' }
  | {
      ok: true;
      partnerName: string;
      localPart: string;
      displayName: string | null;
      replyTo: string | null;
      domainId: string;
      domain: string;
    };

/**
 * Does the ambient DB context already grant RLS visibility of this partner?
 *
 * `getCurrentDbAccessContext()` mirrors exactly what `breeze_has_partner_access`
 * evaluates (db/index.ts:923-935), so an allowlist hit here means the read will
 * return the row.
 */
export function partnerLaneAmbientCanSee(partnerId: string): boolean {
  const ambient = getCurrentDbAccessContext();
  if (!ambient) return false;
  if (ambient.scope === 'system') return true;
  if (ambient.scope !== 'partner') return false;
  return (ambient.accessiblePartnerIds ?? []).includes(partnerId);
}

/**
 * Run `fn` where it can see the partner.
 *
 * - system scope, or partner scope that already lists this partner: in place.
 * - PARTNER scope that does NOT list it: STILL in place. This is the case a
 *   naive reading of §8.3 would escalate, and escalating would hand partner B
 *   partner A's sender identity — `readWithPartnerAxisVisibility` runs as
 *   `system`. RLS returns zero rows instead and the caller falls back to the
 *   platform lane. Fail closed; see plan amendment 2.
 * - org scope, portal, or no context at all: the sanctioned partner-axis escape
 *   (db/partnerAxisRead.ts). It holds a SECOND pooled connection for one indexed
 *   read, which is why it is taken only when it is actually needed.
 */
function inPartnerVisibleContext<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  if (partnerLaneAmbientCanSee(partnerId)) return fn();
  if (getCurrentDbAccessContext()?.scope === 'partner') return fn();
  return readWithPartnerAxisVisibility(fn);
}

export async function lookupPartnerLaneIdentity(
  partnerId: string,
  stream: PartnerMailStream,
): Promise<PartnerLaneLookup> {
  // ONE read (spec §8.3). LEFT JOINs so an eligible partner with no identity is
  // distinguishable from an invisible/absent partner: the first yields a row
  // with null identity columns, the second yields no row at all.
  const rows = await inPartnerVisibleContext(partnerId, () =>
    db
      .select({
        partnerName: partners.name,
        partnerStatus: partners.status,
        trustState: partners.trustState,
        probationEnrollments: partners.probationEnrollments,
        localPart: partnerSenderIdentities.localPart,
        displayName: partnerSenderIdentities.displayName,
        identityReplyTo: partnerSenderIdentities.replyTo,
        domainId: partnerSendingDomains.id,
        domain: partnerSendingDomains.domain,
        domainStatus: partnerSendingDomains.status,
      })
      .from(partners)
      .leftJoin(
        partnerSenderIdentities,
        and(
          eq(partnerSenderIdentities.partnerId, partners.id),
          eq(partnerSenderIdentities.stream, stream),
        ),
      )
      .leftJoin(
        partnerSendingDomains,
        and(
          eq(partnerSendingDomains.id, partnerSenderIdentities.sendingDomainId),
          eq(partnerSendingDomains.partnerId, partners.id),
        ),
      )
      .where(eq(partners.id, partnerId))
      .limit(1),
  );

  const row = rows[0];
  // No row: the partner does not exist, is soft-deleted out of view, or this
  // context cannot see it. All three are "we cannot establish eligibility".
  if (!row) return { ok: false, reason: 'partner_ineligible' };

  // Condition 2 (spec §8.3): active partner AND the capability continuation.
  if (row.partnerStatus !== 'active') return { ok: false, reason: 'partner_ineligible' };
  const decision = evaluateCapabilityContinuationForState(
    'custom_sending_domain',
    { partnerId },
    { trustState: row.trustState, probationEnrollments: row.probationEnrollments },
  );
  // The CONTINUATION evaluator on purpose: `evaluateCapability` writes a
  // `partner.trust.capability_denied` audit row and may fire auto-promotion.
  // Sending an email must do neither — a restricted partner would otherwise
  // mint an audit row per outbound message.
  if (!decision.allow) return { ok: false, reason: 'partner_ineligible' };

  // Condition 3: an identity for the stream, on a sendable domain.
  if (!row.localPart || !row.domainId || !row.domain) return { ok: false, reason: 'no_identity' };
  if (!row.domainStatus || !SENDABLE_DOMAIN_STATUSES.has(row.domainStatus)) {
    return { ok: false, reason: 'domain_not_sendable' };
  }

  return {
    ok: true,
    partnerName: row.partnerName,
    localPart: row.localPart,
    displayName: row.displayName,
    replyTo: row.identityReplyTo,
    domainId: row.domainId,
    domain: row.domain,
  };
}
```

- [ ] **Step 4: Run the lookup test and watch it pass**

```bash
cd apps/api && npx vitest run src/services/emailDomains/partnerLaneLookup.test.ts
```

Expected: `Test Files  1 passed (1)`, 13 tests passed.

- [ ] **Step 5: Replace the db tripwire in `senderResolution.test.ts` (red)**

W01 Task 2's tripwire is a namespace-level `Proxy` that throws on **any** property access of `../../db`. `partnerLaneLookup.ts` legitimately reads that module, so the tripwire must become one that still fails on a platform-lane input but permits the module to exist. In `apps/api/src/services/emailDomains/senderResolution.test.ts`, replace the whole `vi.mock('../../db', () => new Proxy({}, { … }))` block (the W04 TRIPWIRE comment and the factory) with:

```ts
// W01's property-throwing namespace Proxy, kept as a per-EXPORT tripwire now
// that W04 has a partner branch that legitimately reads the database. Every
// assertion in this file is a platform-lane input, so any of these firing means
// the short-circuit of spec §8.1 regressed. `partnerLaneLookup` is mocked
// separately, per test, for the partner cases.
vi.mock('../../db', () => ({
  db: new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined;
      throw new Error(`resolveSender queried the db (db.${String(property)}) on a platform-lane input`);
    },
  }),
  getCurrentDbAccessContext: () => { throw new Error('resolveSender inspected the db context on a platform-lane input'); },
  runOutsideDbContext: () => { throw new Error('resolveSender left the db context on a platform-lane input'); },
  withSystemDbAccessContext: () => { throw new Error('resolveSender opened a system context on a platform-lane input'); },
}));
```

Then append the partner matrix to the same file, after the existing `describe('resolveSender (W01: always the platform lane)', …)` block:

```ts
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { lookupPartnerLaneIdentity } from './partnerLaneLookup';
import { tryCountPartnerLaneSend } from './sendCap';

vi.mock('./config', () => ({
  isPartnerLaneConfigured: vi.fn(() => true),
  getEmailDomainsConfig: vi.fn(() => ({ dailySendCap: 0, partnerAllowlist: [] })),
}));
vi.mock('./partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: vi.fn() }));
vi.mock('./sendCap', () => ({ tryCountPartnerLaneSend: vi.fn(async () => true) }));

const laneConfigured = vi.mocked(isPartnerLaneConfigured);
const domainsConfig = vi.mocked(getEmailDomainsConfig);
const lookup = vi.mocked(lookupPartnerLaneIdentity);
const cap = vi.mocked(tryCountPartnerLaneSend);

const OK_IDENTITY = {
  ok: true as const, partnerName: 'Acme MSP', localPart: 'support', displayName: null,
  replyTo: null, domainId: 'd1', domain: 'mail.acme.test',
};

describe('resolveSender — the partner branch (spec §8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    laneConfigured.mockReturnValue(true);
    domainsConfig.mockReturnValue({ dailySendCap: 0, partnerAllowlist: [] });
    lookup.mockResolvedValue(OK_IDENTITY);
    cap.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns the partner lane when every condition holds', async () => {
    await expect(resolveSender({
      purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM,
    })).resolves.toEqual({
      lane: 'partner', from: 'support@mail.acme.test', replyTo: null,
      partnerId: 'p1', domainId: 'd1', domain: 'mail.acme.test', stream: 'support',
    });
  });

  it('asks for the stream the purpose declares', async () => {
    await resolveSender({ purpose: 'invoice.sent', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(lookup).toHaveBeenCalledWith('p1', 'billing');
    await resolveSender({ purpose: 'report.delivery', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(lookup).toHaveBeenLastCalledWith('p1', 'general');
  });

  // Condition 1a: the lane is off. This is the DARK state of W02/W04 on every
  // deployment until an operator sets EMAIL_DOMAINS_PROVIDER.
  it('returns lane_unconfigured, before any lookup, when the lane is off', async () => {
    laneConfigured.mockReturnValue(false);
    const resolved = await resolveSender({ purpose: 'quote.sent', partnerId: 'p1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'lane_unconfigured' });
    expect(lookup).not.toHaveBeenCalled();
    expect(cap).not.toHaveBeenCalled();
  });

  // Condition 1b: the dark-launch allowlist (spec §9.1).
  it('honours EMAIL_DOMAINS_PARTNER_ALLOWLIST and does not read for an excluded partner', async () => {
    domainsConfig.mockReturnValue({ dailySendCap: 0, partnerAllowlist: ['p-other'] });
    const resolved = await resolveSender({ purpose: 'portal.invite', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'not_allowlisted' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an EMPTY allowlist means every eligible partner', async () => {
    domainsConfig.mockReturnValue({ dailySendCap: 0, partnerAllowlist: [] });
    expect((await resolveSender({ purpose: 'portal.invite', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).lane).toBe('partner');
  });

  it('maps each lookup refusal to its own reason', async () => {
    for (const reason of ['partner_ineligible', 'no_identity', 'domain_not_sendable'] as const) {
      lookup.mockResolvedValue({ ok: false, reason });
      const resolved = await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
      expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason });
    }
  });

  // Condition 4 runs LAST so an ineligible partner never burns a counter slot.
  it('checks the cap only after the lookup succeeds', async () => {
    lookup.mockResolvedValue({ ok: false, reason: 'no_identity' });
    await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(cap).not.toHaveBeenCalled();
  });

  it('returns over_cap when the cap refuses, with the purpose fallback From', async () => {
    cap.mockResolvedValue(false);
    const resolved = await resolveSender({ purpose: 'invoice.sent', partnerId: 'p1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'over_cap' });
  });

  it('builds the From from the identity display name, else the partner name', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: 'Acme Support' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Acme Support" <support@mail.acme.test>');

    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: null, partnerName: 'Acme MSP' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Acme MSP" <support@mail.acme.test>');
  });

  it('strips header-breaking characters from the display name, exactly as fromWithDisplayName does', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: 'Evil"\r\nBcc: victim <x>' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Evil Bcc: victim x" <support@mail.acme.test>');
  });

  it('falls back to the bare address when nothing usable survives sanitising', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: '"<>"', partnerName: '  ' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('support@mail.acme.test');
  });

  it('carries the identity reply-to onto the partner result', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, replyTo: 'help@acme.test' });
    const resolved = await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(resolved.lane === 'partner' && resolved.replyTo).toBe('help@acme.test');
  });

  it('still short-circuits a platform purpose and a null partner with the lane ON', async () => {
    for (const purpose of PLATFORM_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: 'p1', defaultFrom: DEFAULT_FROM });
      expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
    }
    const nullPartner = await resolveSender({ purpose: 'quote.sent', partnerId: null, partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(nullPartner).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'no_partner' });
    expect(lookup).not.toHaveBeenCalled();
    expect(laneConfigured).not.toHaveBeenCalled();
  });
});
```

Also update the two W01 cases that asserted `lane_unconfigured` for a partner purpose with a partner: they still pass unchanged **only** because the new `./config` mock's default is `isPartnerLaneConfigured() === true`. Change that `describe`'s `beforeEach` to set `laneConfigured.mockReturnValue(false)`, so the W01 block keeps asserting exactly what it asserted: the lane is off ⇒ `lane_unconfigured`.

- [ ] **Step 6: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/senderResolution.test.ts
```

Expected failure: every case in the new `describe` fails with `expected { lane: 'platform', reason: 'lane_unconfigured' } to equal { lane: 'partner', … }` — the partner branch does not exist yet.

- [ ] **Step 7: Implement the partner branch** — in `apps/api/src/services/emailDomains/senderResolution.ts`, add these imports under the existing `./mailPurposes` import:

```ts
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { tryCountPartnerLaneSend } from './sendCap';
```

then replace the final `// W04 inserts the partner branch here.` comment and its `return { lane: 'platform', from, reason: 'lane_unconfigured' };` with:

```ts
  // Condition 1 (spec §8.3): the lane must be configured at all. With
  // EMAIL_DOMAINS_PROVIDER unset — the default on hosted and self-hosted — this
  // returns here and the whole feature is inert.
  if (!isPartnerLaneConfigured()) {
    return { lane: 'platform', from, reason: 'lane_unconfigured' };
  }

  // Condition 1 continued: the dark-launch allowlist (§9.1). Empty means every
  // eligible partner; set means only those ids.
  const allowlist = getEmailDomainsConfig().partnerAllowlist;
  if (allowlist.length > 0 && !allowlist.includes(input.partnerId)) {
    return { lane: 'platform', from, reason: 'not_allowlisted' };
  }

  // Conditions 2 and 3: ONE read, plus the side-effect-free trust evaluation.
  // Imported dynamically so a platform purpose never loads the db module at all
  // (plan amendment 1).
  const { lookupPartnerLaneIdentity } = await import('./partnerLaneLookup');
  const identity = await lookupPartnerLaneIdentity(input.partnerId, policy.stream);
  if (!identity.ok) {
    return { lane: 'platform', from, reason: identity.reason };
  }

  // Condition 4, LAST so an ineligible partner never burns a counter slot. A
  // Redis outage also lands here (sendCap.ts): the message still goes out, on
  // the platform lane, and the cap is never silently lifted.
  if (!(await tryCountPartnerLaneSend(input.partnerId))) {
    return { lane: 'platform', from, reason: 'over_cap' };
  }

  return {
    lane: 'partner',
    // Same header-safety strip as the platform display name: fromWithDisplayName
    // falls back to the bare address when nothing usable survives, which is
    // exactly the behaviour wanted here.
    from: fromWithDisplayName(
      `${identity.localPart}@${identity.domain}`,
      identity.displayName?.trim() || identity.partnerName,
    ),
    // The DEFAULT Reply-To only. Precedence (the call site's replyTo first) is
    // applied by EmailService.sendEmail, which is the only place that knows
    // what the call site passed (spec §8.3).
    replyTo: identity.replyTo,
    partnerId: input.partnerId,
    domainId: identity.domainId,
    domain: identity.domain,
    stream: policy.stream,
  };
```

Also narrow `policy` so `policy.stream` type-checks: the preceding `if (policy.lane === 'platform') return …` already narrows it to the partner variant, so no cast is needed.

- [ ] **Step 8: Run both suites and watch them pass**

```bash
cd apps/api && npx vitest run \
  src/services/emailDomains/senderResolution.test.ts \
  src/services/emailDomains/partnerLaneLookup.test.ts \
  src/services/emailDomains/mailPurposes.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: 3 files pass; `tsc` prints nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/emailDomains/partnerLaneLookup.ts apps/api/src/services/emailDomains/partnerLaneLookup.test.ts apps/api/src/services/emailDomains/senderResolution.ts apps/api/src/services/emailDomains/senderResolution.test.ts
git commit -m "$(cat <<'EOF'
feat(email): the partner branch of resolveSender (spec §8.3)

Four conditions in order: lane configured + allowlist, then ONE read joining
partners / partner_sender_identities / partner_sending_domains with the
side-effect-free evaluateCapabilityContinuationForState (a send must never write
a denial audit row), then the daily cap. Anything short of all four returns the
platform lane with the purpose's fallback From and a named reason.

The read runs in the ambient context under system scope AND under partner scope
— including a partner scope that cannot see the id, where RLS returning zero
rows is the answer we want. Escalating there would hand partner B partner A's
identity. Org scope, portal and no-context take readWithPartnerAxisVisibility.

All of it lives behind a dynamic import so a platform purpose never loads the db
module: spec §8.1's first property now holds of the module graph, not just the
control flow.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Structured transport errors

W02's `static` adapter has to decide, from a failure thrown by the platform transport, whether the *sending domain* was refused (fall back to `EMAIL_FROM`) or the *message* was (throw). Today it can only read text, because `deliverRaw` flattens every provider fault into a bare `Error`. W02 plan amendment 7 names this and defers it here. The fix is a typed error that carries the structure and keeps the text.

**Files:**
- Modify: `apps/api/src/services/email.ts` — add `EmailTransportError` next to `EmailAttachment` (`:11-15`); the Resend throw inside `deliverRaw` (W01 Task 3 moved it there from `:265`); the SMTP `sendMail` call inside `deliverRaw` (W01 Task 3, from `:300`); the Mailgun non-OK throw in `sendViaMailgun` (`:804-808`)
- Create: `apps/api/src/services/email.transportError.test.ts` (Test)
- Modify: `apps/api/src/services/emailDomains/adapters/static.ts` — `classifyPlatformTransportError` (created by W02 Task 8)
- Modify: `apps/api/src/services/emailDomains/adapters/static.test.ts` (Test — created by W02 Task 8)

**Interfaces:**
- Consumes: `PartnerLaneSendError` from `../provider` (W02 Task 6).
- Produces:
  ```ts
  // services/email.ts
  export interface EmailTransportErrorFields {
    transport: 'resend' | 'smtp' | 'mailgun';
    statusCode?: number;
    providerErrorName?: string;
    smtpResponseCode?: number;
    smtpResponse?: string;
  }
  export class EmailTransportError extends Error implements EmailTransportErrorFields {
    readonly transport: 'resend' | 'smtp' | 'mailgun';
    readonly statusCode?: number;
    readonly providerErrorName?: string;
    readonly smtpResponseCode?: number;
    readonly smtpResponse?: string;
    constructor(message: string, fields: EmailTransportErrorFields, options?: { cause?: unknown });
  }
  ```

- [ ] **Step 1: Write the failing transport-error test** — create `apps/api/src/services/email.transportError.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEmailMessage } from './email';

/**
 * `deliverRaw` must hand its caller the STRUCTURE of a transport failure —
 * which transport, which status code, nodemailer's SMTP reply — while keeping
 * `.message` byte-for-byte what it has always been.
 *
 * The text is load-bearing in three live places:
 *   services/reportNarrativeDelivery.ts:138  /^Resend error:/i
 *   services/reportNarrativeDelivery.ts:145  /^Mailgun API error \((?:408|429)\)/i
 *   services/reportNarrativeDelivery.ts:146  /^Mailgun API error \(4\d\d\)/i
 * A "nicer" message here silently reclassifies every narrative-delivery
 * failure, so these assertions pin the exact strings, not a shape.
 */

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

const originalEnv = { ...process.env };
const MESSAGE: RawEmailMessage = {
  from: 'Breeze <no-reply@2breeze.app>',
  to: 'customer@example.test',
  subject: 's',
  html: '<p>h</p>',
};

function resetEmailEnv() {
  for (const key of [
    'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
    'MAILGUN_BASE_URL', 'MAILGUN_FROM', 'SMTP_TIMEOUT_MS', 'MAILGUN_TIMEOUT_MS',
  ]) delete process.env[key];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  resetEmailEnv();
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

async function service() {
  const { EmailService } = await import('./email');
  return new EmailService();
}

describe('EmailTransportError — Resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('keeps the message byte-identical and carries the provider error name and status', async () => {
    resendSendMock.mockResolvedValue({
      error: { name: 'validation_error', message: 'The acme.test domain is not verified.', statusCode: 403 },
    });
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    expect((raised as Error).message).toBe('Resend error: The acme.test domain is not verified.');
    expect(raised).toMatchObject({
      transport: 'resend', providerErrorName: 'validation_error', statusCode: 403,
    });
  });

  it('omits the optional fields the SDK did not report', async () => {
    resendSendMock.mockResolvedValue({ error: { message: 'boom' } });
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Record<string, unknown>;
    expect((raised as Error).message).toBe('Resend error: boom');
    expect(raised.transport).toBe('resend');
    expect(raised.statusCode).toBeUndefined();
    expect(raised.providerErrorName).toBeUndefined();
  });
});

describe('EmailTransportError — SMTP', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('carries nodemailer responseCode and response, and preserves the original message and cause', async () => {
    const nodemailerError = Object.assign(new Error('Message failed: 550 5.7.60 SMTP; Client does not have permissions to send as this sender'), {
      responseCode: 550,
      response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender',
    });
    smtpSendMailMock.mockRejectedValue(nodemailerError);
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    // Byte-identical to what nodemailer threw: an SMTP failure has never been
    // rewritten by this service and must not start being.
    expect((raised as Error).message).toBe(nodemailerError.message);
    expect((raised as { cause?: unknown }).cause).toBe(nodemailerError);
    expect(raised).toMatchObject({
      transport: 'smtp', smtpResponseCode: 550,
      smtpResponse: '550 5.7.60 SMTP; Client does not have permissions to send as this sender',
    });
  });

  it('leaves smtpResponseCode undefined when nodemailer reports responseCode: false', async () => {
    // nodemailer sets responseCode to `false` when the reply had no leading
    // digits, so a truthiness check on the far side would misread it.
    smtpSendMailMock.mockRejectedValue(Object.assign(new Error('connection closed'), { responseCode: false }));
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(raised.transport).toBe('smtp');
    expect(raised.smtpResponseCode).toBeUndefined();
    expect((raised as unknown as Error).message).toBe('connection closed');
  });

  it('wraps a non-Error rejection without inventing text', async () => {
    smtpSendMailMock.mockRejectedValue('socket hang up');
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Error;
    expect(raised.message).toBe('socket hang up');
  });
});

describe('EmailTransportError — Mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('keeps the exact "Mailgun API error (<status>): <body>" text and carries the status', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403,
      text: vi.fn().mockResolvedValue('{"message":"The domain is not verified. Please verify your domain."}'),
    });
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    expect((raised as Error).message)
      .toBe('Mailgun API error (403): {"message":"The domain is not verified. Please verify your domain."}');
    expect(raised).toMatchObject({ transport: 'mailgun', statusCode: 403 });
  });

  it('keeps the no-body form and the 429 form that reportNarrativeDelivery matches on', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: vi.fn().mockResolvedValue('') });
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Error;
    expect(raised.message).toBe('Mailgun API error (429)');
    expect(/^Mailgun API error \((?:408|429)\)/i.test(raised.message)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/email.transportError.test.ts
```

Expected failure: `Module '"./email"' has no exported member 'EmailTransportError'`, and every `toMatchObject` case failing because a plain `Error` carries no `transport`.

- [ ] **Step 3: Add the error class to `apps/api/src/services/email.ts`**

Insert immediately after the `EmailAttachment` interface (`:11-15`):

```ts
/** Which transport produced a failure, and whatever structure it reported. */
export interface EmailTransportErrorFields {
  transport: 'resend' | 'smtp' | 'mailgun';
  /** HTTP status, for the two API transports. */
  statusCode?: number;
  /** Resend's own error name, e.g. `validation_error`. */
  providerErrorName?: string;
  /** nodemailer's parsed SMTP reply code. Absent when it reported `false`. */
  smtpResponseCode?: number;
  /** nodemailer's raw SMTP reply line. */
  smtpResponse?: string;
}

/**
 * A transport failure with its structure intact.
 *
 * WHY: the partner lane has to tell "the relay refused this SENDER" (fall back
 * to EMAIL_FROM, spec §8.4) from "the relay refused this MESSAGE" (throw), and
 * before this class the only evidence was a flattened string — see the `static`
 * adapter's classifier and W02 plan amendment 7.
 *
 * `message` is IDENTICAL to what this service threw before. Three live matchers
 * key on that text (services/reportNarrativeDelivery.ts:138, :145, :146), so a
 * reworded message would silently reclassify narrative-delivery failures. This
 * class adds fields; it never edits prose.
 */
export class EmailTransportError extends Error implements EmailTransportErrorFields {
  readonly transport: 'resend' | 'smtp' | 'mailgun';
  readonly statusCode?: number;
  readonly providerErrorName?: string;
  readonly smtpResponseCode?: number;
  readonly smtpResponse?: string;

  constructor(message: string, fields: EmailTransportErrorFields, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailTransportError';
    this.transport = fields.transport;
    this.statusCode = fields.statusCode;
    this.providerErrorName = fields.providerErrorName;
    this.smtpResponseCode = fields.smtpResponseCode;
    this.smtpResponse = fields.smtpResponse;
  }
}
```

- [ ] **Step 4: Throw it from the Resend branch of `deliverRaw`**

In `apps/api/src/services/email.ts`, inside `deliverRaw` (W01 Task 3), replace:

```ts
      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }
```

with:

```ts
      if (error) {
        // Text unchanged; the SDK's own name/statusCode now ride along so the
        // partner lane can classify without regex-matching prose.
        const detail = error as { name?: unknown; statusCode?: unknown };
        throw new EmailTransportError(`Resend error: ${error.message}`, {
          transport: 'resend',
          providerErrorName: typeof detail.name === 'string' ? detail.name : undefined,
          statusCode: typeof detail.statusCode === 'number' ? detail.statusCode : undefined,
        }, { cause: error });
      }
```

- [ ] **Step 5: Throw it from the SMTP branch of `deliverRaw`**

In `apps/api/src/services/email.ts`, wrap the `await this.smtpTransport.sendMail({ … });` call at the end of `deliverRaw` (W01 Task 3) in a try/catch. Replace `await this.smtpTransport.sendMail({` … `});` with:

```ts
    try {
      await this.smtpTransport.sendMail({
        from: sender,
        to,
        cc,
        subject,
        html,
        text,
        replyTo,
        messageId,
        inReplyTo,
        references,
        headers: rest,
        attachments: attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        }))
      });
    } catch (err) {
      // nodemailer's error is the only one that already carried structure, so
      // the message is simply forwarded. `responseCode` is `false` — not
      // missing — when the reply had no leading digits, which is why this is a
      // typeof check and not a truthiness check.
      const detail = err as { responseCode?: unknown; response?: unknown } | null;
      throw new EmailTransportError(
        err instanceof Error ? err.message : String(err),
        {
          transport: 'smtp',
          smtpResponseCode: typeof detail?.responseCode === 'number' ? detail.responseCode : undefined,
          smtpResponse: typeof detail?.response === 'string' ? detail.response : undefined,
        },
        { cause: err },
      );
    }
```

- [ ] **Step 6: Throw it from `sendViaMailgun`**

At `apps/api/src/services/email.ts:804-808`, replace:

```ts
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    const details = message ? `: ${message}` : '';
    throw new Error(`Mailgun API error (${response.status})${details}`);
  }
```

with:

```ts
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    const details = message ? `: ${message}` : '';
    // `Mailgun API error (<status>)<details>` is matched verbatim by
    // services/reportNarrativeDelivery.ts:145-146. Only the shape changes.
    throw new EmailTransportError(`Mailgun API error (${response.status})${details}`, {
      transport: 'mailgun',
      statusCode: response.status,
    });
  }
```

(`mailgunFetch`'s timeout re-throw at `:721` stays a plain `Error`: it is a client-side deadline, not a provider verdict, and the classifier's default of `ambiguous` is the right answer for it.)

- [ ] **Step 7: Run the new suite and the two that pin this text**

```bash
cd apps/api && npx vitest run \
  src/services/email.transportError.test.ts \
  src/services/email.test.ts \
  src/services/email.golden.test.ts \
  src/services/reportNarrativeDelivery.test.ts \
  src/services/notificationChannelSecrets.test.ts
```

Expected: all 5 pass. `reportNarrativeDelivery.test.ts` and `notificationChannelSecrets.test.ts` are the control: they assert on the literal strings, so a message that drifted by one character fails here, not in production.

- [ ] **Step 8: Upgrade the `static` classifier (red first)**

Append to `apps/api/src/services/emailDomains/adapters/static.test.ts` (created by W02 Task 8):

```ts
describe('classifyPlatformTransportError prefers structured fields (W04)', () => {
  function transportError(message: string, fields: Record<string, unknown>) {
    return Object.assign(new Error(message), { name: 'EmailTransportError' }, fields);
  }

  // Structured beats text: these messages contain NO marker at all, so before
  // the structure existed every one of them fell through to `ambiguous` — and
  // an `ambiguous` sender refusal is a lost email, because §8.4 forbids
  // retrying it on the other lane.
  const TABLE: Array<[string, Record<string, unknown>, string]> = [
    ['opaque smtp 550', { transport: 'smtp', smtpResponseCode: 550 }, 'domain_unusable'],
    ['opaque smtp 553', { transport: 'smtp', smtpResponseCode: 553 }, 'domain_unusable'],
    ['opaque smtp 552', { transport: 'smtp', smtpResponseCode: 552 }, 'message_rejected'],
    ['opaque smtp 421', { transport: 'smtp', smtpResponseCode: 421 }, 'ambiguous'],
    ['opaque resend 403', { transport: 'resend', statusCode: 403 }, 'domain_unusable'],
    ['opaque mailgun 403', { transport: 'mailgun', statusCode: 403 }, 'domain_unusable'],
    ['opaque mailgun 401', { transport: 'mailgun', statusCode: 401 }, 'domain_unusable'],
    ['opaque mailgun 429', { transport: 'mailgun', statusCode: 429 }, 'lane_unavailable'],
    ['opaque resend 429', { transport: 'resend', statusCode: 429 }, 'lane_unavailable'],
    ['opaque mailgun 400', { transport: 'mailgun', statusCode: 400 }, 'message_rejected'],
    ['opaque mailgun 500', { transport: 'mailgun', statusCode: 500 }, 'ambiguous'],
  ];

  for (const [message, fields, kind] of TABLE) {
    it(`classifies ${message} as ${kind}`, () => {
      expect(classifyPlatformTransportError(transportError(message, fields)).kind).toBe(kind);
    });
  }

  it('lets sender-refusal TEXT win over a status code that says otherwise', () => {
    // A 400 from Resend whose body says the domain is unverified must still
    // fall back rather than be treated as a bad message.
    const err = transportError('Resend error: The acme.test domain is not verified.', { transport: 'resend', statusCode: 400 });
    expect(classifyPlatformTransportError(err).kind).toBe('domain_unusable');
  });

  it('still classifies a plain Error with no structure, by text', () => {
    expect(classifyPlatformTransportError(new Error('550 sender address rejected')).kind).toBe('domain_unusable');
    expect(classifyPlatformTransportError(new Error('user unknown')).kind).toBe('message_rejected');
    expect(classifyPlatformTransportError(new Error('socket hang up')).kind).toBe('ambiguous');
  });
});
```

Run and watch it fail:

```bash
cd apps/api && npx vitest run src/services/emailDomains/adapters/static.test.ts
```

Expected failure: every `opaque …` row reports `ambiguous` (or, for the SMTP rows, only the three codes W02 already handles), because the classifier reads no `transport` or `statusCode`.

- [ ] **Step 9: Implement the structured branch**

In `apps/api/src/services/emailDomains/adapters/static.ts`, replace the body of `classifyPlatformTransportError` — everything after the `haystack` line — with:

```ts
  // ORDER IS LOAD-BEARING, and TEXT STILL WINS. A body that says "domain is not
  // verified" is a sender refusal whatever status code carried it, and a sender
  // refusal is the one case that MUST fall back to EMAIL_FROM instead of
  // throwing (spec §8.4, §13 "`static`: the relay refuses the custom sender").
  if (includesAny(haystack, SENDER_REFUSAL_MARKERS)) return { kind: 'domain_unusable' };
  if (includesAny(haystack, RECIPIENT_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };
  if (includesAny(haystack, MESSAGE_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };

  // Structured fields next (W04: services/email.ts EmailTransportError). Before
  // these existed, an opaque provider body fell through to `ambiguous` — and an
  // `ambiguous` sender refusal is a LOST email, because §8.4 forbids retrying
  // it on the other lane. A status code is weaker evidence than the body text,
  // but far stronger than nothing.
  const structured = err as Partial<EmailTransportErrorFields> | null;

  // nodemailer sets responseCode to `false` when the reply had no leading
  // digits, so a truthiness check would be wrong here.
  const smtpCode = typeof structured?.smtpResponseCode === 'number'
    ? structured.smtpResponseCode
    : (typeof error?.responseCode === 'number' ? error.responseCode : null);
  if (smtpCode !== null) {
    if (smtpCode === 550 || smtpCode === 551 || smtpCode === 553) return { kind: 'domain_unusable' };
    if (smtpCode === 552 || smtpCode === 554) return { kind: 'message_rejected', detail: message };
    // 4xx is a transient SMTP deferral: the relay may accept the same message
    // minutes later, so we must NOT declare it definitively unsent.
    return { kind: 'ambiguous', detail: message };
  }

  const status = typeof structured?.statusCode === 'number' ? structured.statusCode : null;
  if (status !== null) {
    // 429 and 402 are the lane, not the domain: back off, fall back for THIS
    // message, and let the ops alert fire (spec §13 "Partner lane paused or
    // rate-limited").
    if (status === 429 || status === 402) return { kind: 'lane_unavailable', ...( {} ) };
    // 401/403 on a send is the relay refusing this sender: a send-only key that
    // does not own the domain, or SendAs rights revoked. Fall back.
    if (status === 401 || status === 403) return { kind: 'domain_unusable' };
    if (status >= 400 && status < 500) return { kind: 'message_rejected', detail: message };
    // 5xx: the provider may or may not have queued it. Never cross lanes.
    return { kind: 'ambiguous', detail: message };
  }

  return { kind: 'ambiguous', detail: message };
```

and add the type-only import at the top of the file:

```ts
import type { EmailTransportErrorFields } from '../../email';
```

(The `{ kind: 'lane_unavailable' }` variant of `PartnerLaneSendError` carries no `detail`, so the spread above is dropped — write it as plain `return { kind: 'lane_unavailable' };`.)

- [ ] **Step 10: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/emailDomains/adapters/static.test.ts \
  src/services/emailDomains/adapters/adapterContract.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: both suites pass; `tsc` prints nothing. If `adapterContract.test.ts` reds on a `static` send-error row, the fixture there asserted the pre-W04 `ambiguous` default for an opaque status — update that row to the structured answer, in this task.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.transportError.test.ts apps/api/src/services/emailDomains/adapters/static.ts apps/api/src/services/emailDomains/adapters/static.test.ts
git commit -m "$(cat <<'EOF'
feat(email): EmailTransportError — structure out of deliverRaw

W02 plan amendment 7 deferred this to W04. All three deliverRaw branches now
throw EmailTransportError carrying transport + statusCode + providerErrorName +
the nodemailer SMTP reply, with `.message` BYTE-IDENTICAL to what they threw
before — reportNarrativeDelivery.ts:138/145/146 match on that text, so a
reworded message would silently reclassify every narrative-delivery failure.

The static adapter's classifier now reads those fields when the body text is
opaque. Text still wins: a body saying "domain is not verified" is a sender
refusal whatever status carried it. Before this, an opaque 403 fell through to
`ambiguous`, and an ambiguous sender refusal is a LOST email — §8.4 forbids
retrying it on the other lane.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `sendOnPartnerLane` and the outbound marker

**Files:**
- Create: `apps/api/src/services/emailDomains/outboundMarker.ts`
- Create: `apps/api/src/services/emailDomains/partnerLaneSend.ts`
- Create: `apps/api/src/services/emailDomains/partnerLaneSend.test.ts` (Test)

**Interfaces:**
- Consumes: `getEmailDomainProvider` from `./providerRegistry` (W02 Task 6); `PartnerLaneSendFailure`, `PartnerLaneMessage` from `./provider` (W02 Task 6); `MailPurpose`, `PartnerMailStream` from `./mailPurposes` (W01 Task 1); `sendOpsAlert` from `../opsAlerts` (`apps/api/src/services/opsAlerts.ts:85`); `getRedis` from `../redis`; `enqueueSyncDomain` from `../../jobs/sendingDomainsWorker` (W03, dynamically imported).
- Produces:
  ```ts
  // outboundMarker.ts
  export const BREEZE_OUTBOUND_HEADER = 'X-Breeze-Outbound';
  export const BREEZE_OUTBOUND_HEADER_VALUE = '1';
  // partnerLaneSend.ts
  export interface PartnerLaneSendInput {
    message: PartnerLaneMessage;     // `from` is already the partner address
    purpose: MailPurpose;
    partnerId: string;
    domainId: string;
    stream: PartnerMailStream;
  }
  export type PartnerLaneSendOutcome =
    | { delivered: true; providerMessageId: string }
    | { delivered: false; failure: 'domain_unusable' | 'lane_unavailable' };
  export async function sendOnPartnerLane(input: PartnerLaneSendInput): Promise<PartnerLaneSendOutcome>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/emailDomains/partnerLaneSend.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProviderMock, sendOpsAlertMock, getRedisMock, enqueueSyncDomainMock } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
  sendOpsAlertMock: vi.fn(),
  getRedisMock: vi.fn(),
  enqueueSyncDomainMock: vi.fn(),
}));

vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: enqueueSyncDomainMock }));

import { PartnerLaneSendFailure } from './provider';
import { BREEZE_OUTBOUND_HEADER } from './outboundMarker';
import { sendOnPartnerLane, type PartnerLaneSendInput } from './partnerLaneSend';

const PARTNER = '11111111-1111-1111-1111-111111111111';
const DOMAIN_ID = '22222222-2222-2222-2222-222222222222';

const sendMock = vi.fn();

function input(over: Partial<PartnerLaneSendInput> = {}): PartnerLaneSendInput {
  return {
    message: {
      from: '"Acme Support" <support@mail.acme.test>',
      to: ['customer@example.test'],
      subject: 's',
      html: '<p>h</p>',
      headers: { 'Message-ID': '<ticket-t1@tickets.example.test>' },
    },
    purpose: 'ticket.customer_notification',
    partnerId: PARTNER,
    domainId: DOMAIN_ID,
    stream: 'support',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ providerMessageId: 'prov-1' });
  getProviderMock.mockReturnValue({ id: 'resend', verifiesByDns: true, send: sendMock });
  // SET NX EX reservation: 'OK' = we won the hour, null = someone already alerted.
  getRedisMock.mockReturnValue({ set: vi.fn(async () => 'OK') });
  enqueueSyncDomainMock.mockResolvedValue(undefined);
  sendOpsAlertMock.mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sendOnPartnerLane — the happy path', () => {
  it('delivers through the provider and reports its message id', async () => {
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: true, providerMessageId: 'prov-1' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('stamps X-Breeze-Outbound on a NEW headers object, never mutating the caller\'s', async () => {
    const params = input();
    const originalHeaders = params.message.headers!;
    await sendOnPartnerLane(params);
    const sent = sendMock.mock.calls[0]![0];
    expect(sent.headers[BREEZE_OUTBOUND_HEADER]).toBe('1');
    // The fallback message is rebuilt from these same params, and it MUST NOT
    // carry the marker (spec §8.4). Mutating in place would leak it.
    expect(originalHeaders[BREEZE_OUTBOUND_HEADER]).toBeUndefined();
    expect(params.message.headers).toBe(originalHeaders);
  });

  it('keeps the threading headers the call site set', async () => {
    await sendOnPartnerLane(input());
    expect(sendMock.mock.calls[0]![0].headers['Message-ID']).toBe('<ticket-t1@tickets.example.test>');
  });

  it('works when the call site set no headers at all', async () => {
    const params = input();
    delete params.message.headers;
    await sendOnPartnerLane(params);
    expect(sendMock.mock.calls[0]![0].headers).toEqual({ [BREEZE_OUTBOUND_HEADER]: '1' });
  });

  it('tags the message with partner_id, domain_id, stream and purpose (spec §5, §9.3)', async () => {
    await sendOnPartnerLane(input({ purpose: 'invoice.sent', stream: 'billing' }));
    const sent = sendMock.mock.calls[0]![0];
    expect(sent.partnerRef).toBe(PARTNER);
    expect(sent.tags).toEqual({
      partner_id: PARTNER, domain_id: DOMAIN_ID, stream: 'billing', purpose: 'invoice.sent',
    });
  });
});

describe('sendOnPartnerLane — definitive failures fall back (spec §8.4)', () => {
  it.each(['domain_unusable', 'lane_unavailable'] as const)('reports %s as not delivered', async (kind) => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind }));
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: kind });
  });

  it('enqueues sync-domain with the refusal text for both definitive kinds', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledWith(DOMAIN_ID, { lastSendError: expect.stringContaining('domain_unusable') });

    enqueueSyncDomainMock.mockClear();
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledWith(DOMAIN_ID, { lastSendError: expect.stringContaining('lane_unavailable') });
  });

  // The send path must never write partner_sending_domains itself (spec §3.1):
  // it may be running in a context that cannot write that table at all.
  it('never writes the row directly — the worker does', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(enqueueSyncDomainMock).toHaveBeenCalledTimes(1);
  });

  it('still falls back when the enqueue itself fails', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    enqueueSyncDomainMock.mockRejectedValue(new Error('redis down'));
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: 'domain_unusable' });
  });

  it('raises an ops alert for lane_unavailable, at most once per hour', async () => {
    const set = vi.fn(async () => 'OK');
    getRedisMock.mockReturnValue({ set });
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.any(String), '1', 'EX', 3600, 'NX');

    // Second occurrence inside the hour: the reservation is refused.
    sendOpsAlertMock.mockClear();
    getRedisMock.mockReturnValue({ set: vi.fn(async () => null) });
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('does NOT raise an ops alert for domain_unusable', async () => {
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('alerts when Redis is unavailable rather than going silent', async () => {
    getRedisMock.mockReturnValue(null);
    sendMock.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'lane_unavailable' }));
    await sendOnPartnerLane(input());
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendOnPartnerLane — indefinite failures throw (spec §8.4)', () => {
  it('rethrows message_rejected', async () => {
    const failure = new PartnerLaneSendFailure({ kind: 'message_rejected', detail: 'user unknown' });
    sendMock.mockRejectedValue(failure);
    await expect(sendOnPartnerLane(input())).rejects.toBe(failure);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
  });

  it('rethrows ambiguous — a recipient must never receive two copies', async () => {
    const failure = new PartnerLaneSendFailure({ kind: 'ambiguous', detail: 'timeout' });
    sendMock.mockRejectedValue(failure);
    await expect(sendOnPartnerLane(input())).rejects.toBe(failure);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
  });

  // The adapter contract says `send` throws PartnerLaneSendFailure, but a bug,
  // an SDK panic or an OOM does not read the contract. Anything unrecognised is
  // ambiguous: we do not know whether the message left.
  it('treats any non-PartnerLaneSendFailure exception as ambiguous and rethrows it', async () => {
    const boom = new TypeError('cannot read properties of undefined');
    sendMock.mockRejectedValue(boom);
    await expect(sendOnPartnerLane(input())).rejects.toBe(boom);
    expect(enqueueSyncDomainMock).not.toHaveBeenCalled();
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });
});

describe('sendOnPartnerLane — no provider', () => {
  // resolveSender only returns the partner lane when isPartnerLaneConfigured(),
  // so this is a race (the config changed under us), not a normal state. It must
  // fall back, not throw: the message is definitively unsent.
  it('reports lane_unavailable when the registry has no provider', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(sendOnPartnerLane(input())).resolves.toEqual({ delivered: false, failure: 'lane_unavailable' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/partnerLaneSend.test.ts
```

Expected failure: `Cannot find module './outboundMarker'`.

- [ ] **Step 3: Implement the marker** — create `apps/api/src/services/emailDomains/outboundMarker.ts`:

```ts
/**
 * The header that marks a message as OUR OWN outbound mail (spec §8.5).
 *
 * Loop prevention used to recognise our mail by sender domain — a custom From
 * has neither `no-reply` nor TICKETS_INBOUND_DOMAIN, so a notification that
 * comes back (a contact address forwarding to the partner's support mailbox,
 * which forwards into Breeze) would open or update a ticket. We mark our own
 * mail instead of guessing from the sender.
 *
 * Forging it only gets the forger's own mail ignored, which is why this is safe
 * to trust from untrusted inbound. The inverse rule — suppressing by SENDING
 * DOMAIN — is explicitly rejected by the spec: with a root domain every
 * technician's address is on the sending domain, and a technician may
 * legitimately write from the shared mailbox.
 *
 * Its own module so `services/inboundEmail/**` can consume the constant without
 * importing anything from the partner-lane send path.
 */
export const BREEZE_OUTBOUND_HEADER = 'X-Breeze-Outbound';
export const BREEZE_OUTBOUND_HEADER_VALUE = '1';
```

- [ ] **Step 4: Implement the send** — create `apps/api/src/services/emailDomains/partnerLaneSend.ts`:

```ts
import { sendOpsAlert } from '../opsAlerts';
import { getRedis } from '../redis';
import type { MailPurpose, PartnerMailStream } from './mailPurposes';
import { BREEZE_OUTBOUND_HEADER, BREEZE_OUTBOUND_HEADER_VALUE } from './outboundMarker';
import { PartnerLaneSendFailure, type PartnerLaneMessage } from './provider';
import { getEmailDomainProvider } from './providerRegistry';

/**
 * The partner-lane transport (spec §8.4).
 *
 * Returns `{ delivered: false }` ONLY for the two failures that mean the
 * message was definitively not sent, so the caller can put it on the platform
 * lane. `message_rejected` and `ambiguous` are rethrown, as today — an
 * ambiguous failure is never retried on the other lane, because a recipient
 * receiving two copies is worse than a retry the caller can decide on.
 */

/** At most one ops alert per hour for a paused/rate-limited lane (spec §13). */
const LANE_ALERT_KEY = 'email-domains:lane-unavailable-alert';
const LANE_ALERT_WINDOW_SECONDS = 3600;

export interface PartnerLaneSendInput {
  /** `from` is already the partner address decided by resolveSender. */
  message: PartnerLaneMessage;
  purpose: MailPurpose;
  partnerId: string;
  domainId: string;
  stream: PartnerMailStream;
}

export type PartnerLaneSendOutcome =
  | { delivered: true; providerMessageId: string }
  | { delivered: false; failure: 'domain_unusable' | 'lane_unavailable' };

/**
 * `SET NX EX` reservation, the `services/m365Sync/onDemandLimiter.ts` idiom:
 * the semantics are "a slot is held for the hour", not "count the failures".
 * When Redis cannot answer we ALERT — an ops alert we cannot deduplicate is a
 * nuisance; a paused sending account nobody hears about is an outage.
 */
async function claimLaneAlertSlot(): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) return true;
    return (await redis.set(LANE_ALERT_KEY, '1', 'EX', LANE_ALERT_WINDOW_SECONDS, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

export async function sendOnPartnerLane(input: PartnerLaneSendInput): Promise<PartnerLaneSendOutcome> {
  const provider = getEmailDomainProvider();
  if (!provider) {
    // resolveSender only returns the partner lane when the lane is configured,
    // so this is a race with a config change, not a normal state. Fall back
    // rather than throw: nothing was sent.
    console.error('[emailDomains/partnerLaneSend] resolved to the partner lane with no provider registered', {
      partnerId: input.partnerId, domainId: input.domainId,
    });
    return { delivered: false, failure: 'lane_unavailable' };
  }

  // A NEW headers object. The caller rebuilds the fallback message from the
  // ORIGINAL params, so mutating in place would put X-Breeze-Outbound on a
  // platform-lane message — which would then be ignored by our own inbound
  // pipeline if it ever came back.
  const headers = { ...(input.message.headers ?? {}), [BREEZE_OUTBOUND_HEADER]: BREEZE_OUTBOUND_HEADER_VALUE };

  try {
    const { providerMessageId } = await provider.send({
      ...input.message,
      headers,
      partnerRef: input.partnerId,
      // W06 attributes every delivery event by these four (spec §9.3).
      tags: {
        partner_id: input.partnerId,
        domain_id: input.domainId,
        stream: input.stream,
        purpose: input.purpose,
      },
    });
    return { delivered: true, providerMessageId };
  } catch (err) {
    // Anything that is not the adapter's declared failure type is AMBIGUOUS: a
    // bug, an SDK panic or an OOM tells us nothing about whether the message
    // left. Rethrow without falling back.
    if (!(err instanceof PartnerLaneSendFailure)) throw err;
    const { kind } = err.error;
    if (kind === 'message_rejected' || kind === 'ambiguous') throw err;

    const detail = 'detail' in err.error && typeof err.error.detail === 'string' ? err.error.detail : '';
    const lastSendError = detail ? `${kind}: ${detail}` : kind;
    console.warn('[emailDomains/partnerLaneSend] partner lane refused the message; falling back to the platform lane', {
      partnerId: input.partnerId, domainId: input.domainId, purpose: input.purpose, kind,
    });

    // The refusal text reaches partner_sending_domains.last_send_error through
    // the WORKER (spec §3.1): the send path may be running in a context that
    // cannot write that table, and writing a partner-axis table from
    // services/** would also red partner-wide-write-coverage.test.ts.
    await import('../../jobs/sendingDomainsWorker')
      .then(({ enqueueSyncDomain }) => enqueueSyncDomain(input.domainId, { lastSendError }))
      .catch((enqueueErr) => {
        // Best effort. Losing the diagnostic must never cost us the fallback.
        console.error('[emailDomains/partnerLaneSend] could not enqueue sync-domain for the refusal', {
          domainId: input.domainId, enqueueErr,
        });
      });

    if (kind === 'lane_unavailable' && await claimLaneAlertSlot()) {
      await sendOpsAlert({
        title: 'Partner sending lane unavailable',
        body: `The partner-lane provider refused a send (429, paused account, or quota). Messages are falling back to ${'EMAIL_FROM'} meanwhile. partner=${input.partnerId} domain=${input.domainId}`,
      }).catch(() => undefined);
    }

    return { delivered: false, failure: kind };
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/emailDomains/partnerLaneSend.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: `Test Files  1 passed (1)`, 16 tests passed; `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/emailDomains/outboundMarker.ts apps/api/src/services/emailDomains/partnerLaneSend.ts apps/api/src/services/emailDomains/partnerLaneSend.test.ts
git commit -m "$(cat <<'EOF'
feat(email): sendOnPartnerLane + the X-Breeze-Outbound marker

Spec §8.4/§8.5. Builds the PartnerLaneMessage, stamps X-Breeze-Outbound and the
four provider tags (partner_id, domain_id, stream, purpose) onto a FRESH headers
object — the fallback message is rebuilt from the caller's originals and must
not carry either — and classifies the outcome.

domain_unusable / lane_unavailable => definitively unsent: report it so the
caller can use the platform lane, enqueue sync-domain with the refusal text (the
WORKER writes last_send_error; the send path never writes a partner-axis table),
and for lane_unavailable raise one ops alert per hour via SET NX EX.
message_rejected / ambiguous => rethrow. Anything that is not a
PartnerLaneSendFailure is treated as ambiguous and rethrown too.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the partner lane into `EmailService.sendEmail`

**Files:**
- Modify: `apps/api/src/services/email.ts` — the `sendEmail` body (written by W01 Task 3, finalised by W01 Task 8) and its import of `./emailDomains/senderResolution`
- Modify: `apps/api/src/services/email.test.ts` (Test) — append the partner-lane describe

**Interfaces:**
- Consumes: `resolveSender`, `platformFallbackFrom` from `./emailDomains/senderResolution` (W01 Task 2 + Task 2 here); `sendOnPartnerLane` from `./emailDomains/partnerLaneSend` (Task 4, dynamically imported).
- Produces: no signature change. `sendEmail(params: SendEmailParams): Promise<void>` keeps W01's discriminated union exactly.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/services/email.test.ts`, at the very end of the file (outside the existing `describe('email service', …)`):

```ts
/**
 * The partner lane, end-to-end through the REAL resolveSender and the REAL
 * sendOnPartnerLane. Only the database lookup, the config reader, the cap and
 * the provider registry are mocked — everything between `sendEmail` and the
 * transport is production code, which is what makes the failure-semantics
 * assertions below worth having.
 */
describe('email service — the partner lane (spec §8.3, §8.4)', () => {
  const laneSend = vi.fn();
  const lookup = vi.fn();
  const cap = vi.fn();

  vi.doMock('./emailDomains/config', () => ({
    isPartnerLaneConfigured: () => true,
    getEmailDomainsConfig: () => ({ dailySendCap: 0, partnerAllowlist: [] }),
  }));
  vi.doMock('./emailDomains/partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: lookup }));
  vi.doMock('./emailDomains/sendCap', () => ({ tryCountPartnerLaneSend: cap }));
  vi.doMock('./emailDomains/providerRegistry', () => ({
    getEmailDomainProvider: () => ({ id: 'resend', verifiesByDns: true, send: laneSend }),
  }));
  vi.doMock('../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: vi.fn(async () => undefined) }));
  vi.doMock('./opsAlerts', () => ({ sendOpsAlert: vi.fn(async () => true), isOpsAlertingConfigured: () => false }));

  const PARTNER = '11111111-1111-1111-1111-111111111111';
  const IDENTITY = {
    ok: true as const, partnerName: 'Acme MSP', localPart: 'support', displayName: 'Acme Support',
    replyTo: 'help@acme.test', domainId: 'd1', domain: 'mail.acme.test',
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    resetEmailEnv();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
    resendSendMock.mockResolvedValue({ id: 'resend-1' });
    laneSend.mockResolvedValue({ providerMessageId: 'partner-1' });
    lookup.mockResolvedValue(IDENTITY);
    cap.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function service() {
    const { getEmailService } = await import('./email');
    return getEmailService()!;
  }

  const BASE = {
    to: 'customer@example.test',
    subject: 'Invoice INV-1',
    html: '<p>hi</p>',
  } as const;

  it('sends a partner-lane purpose through the provider, not the platform transport', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP' });
    expect(laneSend).toHaveBeenCalledTimes(1);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(laneSend.mock.calls[0]![0].from).toBe('"Acme Support" <support@mail.acme.test>');
  });

  it('applies the Reply-To precedence: call site, then identity, then none', async () => {
    const svc = await service();
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, replyTo: 'accounts@acmemsp.example' });
    expect(laneSend.mock.calls[0]![0].replyTo).toBe('accounts@acmemsp.example');

    laneSend.mockClear();
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER });
    expect(laneSend.mock.calls[0]![0].replyTo).toBe('help@acme.test');

    laneSend.mockClear();
    lookup.mockResolvedValue({ ...IDENTITY, replyTo: null });
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER });
    expect(laneSend.mock.calls[0]![0].replyTo).toBeUndefined();
  });

  it('a platform purpose never reaches the partner lane, whatever the registry says', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'auth.password_reset' });
    expect(laneSend).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(resendSendMock.mock.calls[0]![0].from).toBe('Breeze <no-reply@2breeze.app>');
  });

  it.each([
    ['domain_unusable', '"Acme MSP via Breeze" <no-reply@2breeze.app>'],
    ['lane_unavailable', '"Acme MSP via Breeze" <no-reply@2breeze.app>'],
  ] as const)('falls back to the platform lane on %s, with the purpose fallback From', async (kind, expectedFrom) => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind }));
    await (await service()).sendEmail({
      ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP',
      headers: { 'Message-ID': '<m@x>' },
    });
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const fallback = resendSendMock.mock.calls[0]![0];
    expect(fallback.from).toBe(expectedFrom);
    // Spec §8.4: the fallback carries NEITHER the outbound marker NOR any
    // partner tag. A platform-lane message wearing X-Breeze-Outbound would be
    // dropped by our own inbound pipeline if it ever came back.
    expect(fallback.headers).toEqual({ 'Message-ID': '<m@x>' });
    expect(fallback.headers['X-Breeze-Outbound']).toBeUndefined();
  });

  it('the fallback uses the CALL SITE Reply-To, not the identity default', async () => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await (await service()).sendEmail({ ...BASE, purpose: 'ticket.customer_notification', partnerId: PARTNER });
    // help@acme.test is on the domain that just refused us; routing replies
    // there would compound the failure.
    expect(resendSendMock.mock.calls[0]![0].replyTo).toBeUndefined();
  });

  it.each(['message_rejected', 'ambiguous'] as const)('rethrows %s and NEVER touches the second lane', async (kind) => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind, detail: 'd' }));
    await expect((await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER }))
      .rejects.toBeInstanceOf(PartnerLaneSendFailure);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('rethrows an unknown exception from the adapter and never falls back', async () => {
    laneSend.mockRejectedValue(new TypeError('adapter blew up'));
    await expect((await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER }))
      .rejects.toThrow('adapter blew up');
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('a partner-lane purpose with partnerId: null is a plain platform send', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'report.delivery', partnerId: null });
    expect(laneSend).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(resendSendMock.mock.calls[0]![0].from).toBe('Breeze <no-reply@2breeze.app>');
  });

  it('an over-cap send goes out on the platform lane, exactly once', async () => {
    cap.mockResolvedValue(false);
    await (await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP' });
    expect(laneSend).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0]![0].from).toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');
  });
});
```

Note on `vi.doMock`: it is deliberately not `vi.mock`, which is hoisted to the top of the FILE and would apply to every existing case in `email.test.ts`. `vi.doMock` registers for subsequent dynamic imports only, and this describe's `beforeEach` calls `vi.resetModules()` before importing `./email`, so the mocks take effect exactly here. If the runner reports the earlier cases suddenly resolving through a partner lane, the calls were hoisted — move this block into its own file `apps/api/src/services/email.partnerLane.test.ts` with plain `vi.mock` and add that path everywhere this plan lists `src/services/email.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/email.test.ts
```

Expected failure: the first partner-lane case reports `expect(laneSend).toHaveBeenCalledTimes(1)` received 0 and `resendSendMock` called once — `sendEmail` still delivers everything through `deliverRaw`.

- [ ] **Step 3: Implement** — in `apps/api/src/services/email.ts`, change the resolver import from

```ts
import { resolveSender } from './emailDomains/senderResolution';
```

to

```ts
import { platformFallbackFrom, resolveSender } from './emailDomains/senderResolution';
```

and replace the whole `sendEmail` body (W01 Task 8's final form) with:

```ts
  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, cc, subject, html, text, replyTo, headers, attachments } = params;

    const resolved = await resolveSender({
      purpose: params.purpose,
      partnerId: params.partnerId ?? null,
      partnerName: params.partnerName ?? null,
      defaultFrom: this.defaultFrom,
    });

    if (resolved.lane === 'partner') {
      // Dynamic so a platform-lane send never loads the provider registry, the
      // Resend SDK or BullMQ — and so `email.ts -> partnerLaneSend.ts ->
      // providerRegistry.ts -> adapters/static.ts -> email.ts` is not a static
      // import cycle (plan amendment 1).
      const { sendOnPartnerLane } = await import('./emailDomains/partnerLaneSend');
      const outcome = await sendOnPartnerLane({
        message: {
          to,
          cc,
          subject,
          html,
          text,
          // Reply-To precedence (spec §8.3): the call site's replyTo, then the
          // identity's default, then none. Tickets therefore keep
          // {slug}@TICKETS_INBOUND_DOMAIN and quotes/invoices keep
          // partner.billingEmail, because those call sites set replyTo.
          replyTo: replyTo ?? resolved.replyTo ?? undefined,
          headers,
          attachments,
          from: resolved.from,
        },
        purpose: params.purpose,
        partnerId: resolved.partnerId,
        domainId: resolved.domainId,
        stream: resolved.stream,
      });
      if (outcome.delivered) return;

      // Definitively not sent (spec §8.4). Put it on the platform lane with the
      // purpose's fallback From — the exact envelope this send site produced
      // before the feature existed. Deliberately rebuilt from the ORIGINAL
      // params: no X-Breeze-Outbound, no partner tags, and the call site's own
      // Reply-To rather than the identity's, whose domain is the one that just
      // refused us.
      await this.deliverRaw({
        to,
        cc,
        subject,
        html,
        text,
        replyTo,
        headers,
        attachments,
        from: platformFallbackFrom(params.purpose, this.defaultFrom, params.partnerName ?? null),
      });
      return;
    }

    await this.deliverRaw({
      to,
      cc,
      subject,
      html,
      text,
      replyTo,
      headers,
      attachments,
      from: resolved.from,
    });
  }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/email.test.ts \
  src/services/email.golden.test.ts \
  src/services/email.headers.test.ts \
  src/services/email.transportError.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all four pass; `tsc` prints nothing. `email.golden.test.ts` is the control here: it mocks nothing under `emailDomains/`, so `isPartnerLaneConfigured()` reads the real (unset) `EMAIL_DOMAINS_PROVIDER`, every purpose resolves to `lane_unconfigured`, and all 87+ golden rows must still produce byte-identical envelopes. **If any golden row moved, the wave has broken its own dark-launch guarantee — stop and fix it here.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.test.ts
git commit -m "$(cat <<'EOF'
feat(email): sendEmail delivers on the partner lane, and falls back safely

Spec §8.3/§8.4. A partner-lane resolution now goes through sendOnPartnerLane;
Reply-To precedence is applied here, the only place that knows what the call
site passed (call site, then identity default, then none).

domain_unusable / lane_unavailable are definitively unsent, so the message is
re-sent on the platform lane with the purpose's fallback From, rebuilt from the
ORIGINAL params — no outbound marker, no partner tags, and the call site's own
Reply-To, not the identity's (whose domain just refused us). message_rejected,
ambiguous and any unrecognised exception are rethrown and never cross lanes.

email.golden.test.ts is unchanged and still green: with EMAIL_DOMAINS_PROVIDER
unset every purpose resolves lane_unconfigured and every envelope is
byte-identical. The wave is dark.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The `static` transport matrix, end to end

Spec §14 "Transport matrix for `static`": the partner-lane send with a custom From through each platform transport (`smtp`, `mailgun`, `resend`), and the fallback when the transport refuses the sender. This is the self-hosted acceptance test — it is the only suite where `sendEmail`, `resolveSender`, `sendOnPartnerLane`, the registry, the `static` adapter and a real transport body all run together.

**Files:**
- Create: `apps/api/src/services/emailDomains/staticTransportMatrix.test.ts` (Test)

**Interfaces:**
- Consumes: everything from Tasks 2–5, plus W02's `createStaticDomainProvider`, `getEmailDomainProvider`, `resetEmailDomainProviderForTests`.
- Produces: nothing at runtime.

- [ ] **Step 1: Write the test** — create `apps/api/src/services/emailDomains/staticTransportMatrix.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec §14, "Transport matrix for `static`" — the self-hosted acceptance test.
 *
 * Everything between sendEmail and the wire is production code: the real
 * resolver, the real sendOnPartnerLane, the real registry, the real `static`
 * adapter and the real deliverRaw transport bodies. Only the identity lookup
 * (a database read) and the sockets are mocked.
 *
 * The second half is the one that matters most for a self-hoster: an operator
 * who lists a domain the relay will not actually send as (Microsoft 365 SendAs
 * rights revoked, Postfix sender maps edited) must see the invoice arrive from
 * EMAIL_FROM, not vanish (spec §13, "`static`: the relay refuses the custom
 * sender").
 */

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock, lookupMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));
vi.mock('./partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: lookupMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: vi.fn(async () => undefined) }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: vi.fn(async () => true), isOpsAlertingConfigured: () => false }));

const PARTNER = '11111111-1111-1111-1111-111111111111';
const DEFAULT_FROM = '"Acme IT" <helpdesk@acme.test>';
const PARTNER_FROM = '"Acme Billing" <billing@acme.test>';

const IDENTITY = {
  ok: true as const, partnerName: 'Acme MSP', localPart: 'billing', displayName: 'Acme Billing',
  replyTo: null, domainId: 'd1', domain: 'acme.test',
};

const originalEnv = { ...process.env };

function resetEmailEnv() {
  for (const key of [
    'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
    'MAILGUN_BASE_URL', 'MAILGUN_FROM', 'SMTP_TIMEOUT_MS', 'MAILGUN_TIMEOUT_MS',
    'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
    'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'IS_HOSTED',
  ]) delete process.env[key];
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  resetEmailEnv();
  // The operator's attestation: this relay may send as acme.test. `static` is
  // self-hosted only, so IS_HOSTED stays unset.
  process.env.EMAIL_DOMAINS_PROVIDER = 'static';
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'acme.test';
  process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
  process.env.EMAIL_FROM = DEFAULT_FROM;
  lookupMock.mockResolvedValue(IDENTITY);
  resendSendMock.mockResolvedValue({ error: null });
  smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { resetEmailDomainProviderForTests } = await import('./providerRegistry');
  resetEmailDomainProviderForTests();
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

async function service() {
  const { getEmailService } = await import('../email');
  return getEmailService()!;
}

const MESSAGE = {
  to: 'ap@customer.test',
  subject: 'Invoice INV-2026-0007',
  html: '<p>Your invoice is attached.</p>',
  text: 'Your invoice is attached.',
} as const;

async function sendInvoice() {
  await (await service()).sendEmail({
    ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP',
  });
}

describe('static + EMAIL_PROVIDER=resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
  });

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const sent = resendSendMock.mock.calls[0]![0];
    expect(sent.from).toBe(PARTNER_FROM);
    expect(sent.headers['X-Breeze-Outbound']).toBe('1');
  });

  it('falls back to EMAIL_FROM when the account refuses the sender', async () => {
    resendSendMock
      .mockResolvedValueOnce({ error: { name: 'validation_error', statusCode: 403, message: 'The acme.test domain is not verified.' } })
      .mockResolvedValueOnce({ error: null });
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(2);
    const fallback = resendSendMock.mock.calls[1]![0];
    expect(fallback.from).toBe('"Acme MSP via Breeze" <helpdesk@acme.test>');
    expect(fallback.headers?.['X-Breeze-Outbound']).toBeUndefined();
  });
});

describe('static + EMAIL_PROVIDER=smtp', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.acme.test';
  });

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
    const sent = smtpSendMailMock.mock.calls[0]![0];
    expect(sent.from).toBe(PARTNER_FROM);
    expect(sent.headers['X-Breeze-Outbound']).toBe('1');
  });

  // The canonical self-hosted failure: Microsoft 365 SendAs rights revoked.
  it('falls back to EMAIL_FROM on 550 5.7.60', async () => {
    smtpSendMailMock
      .mockRejectedValueOnce(Object.assign(
        new Error('Message failed: 550 5.7.60 SMTP; Client does not have permissions to send as this sender'),
        { responseCode: 550, response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender' },
      ))
      .mockResolvedValueOnce({ messageId: 'smtp-2' });
    await sendInvoice();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(2);
    const fallback = smtpSendMailMock.mock.calls[1]![0];
    expect(fallback.from).toBe('"Acme MSP via Breeze" <helpdesk@acme.test>');
    expect(fallback.headers?.['X-Breeze-Outbound']).toBeUndefined();
  });

  it('does NOT fall back on a recipient refusal — the message, not the domain, was wrong', async () => {
    smtpSendMailMock.mockRejectedValue(Object.assign(
      new Error('550 5.1.1 User unknown'),
      { responseCode: 550, response: '550 5.1.1 User unknown' },
    ));
    await expect(sendInvoice()).rejects.toThrow();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on a transient 4xx — a deferral is ambiguous, never definitively unsent', async () => {
    smtpSendMailMock.mockRejectedValue(Object.assign(
      new Error('421 4.7.0 Try again later'),
      { responseCode: 421, response: '421 4.7.0 Try again later' },
    ));
    await expect(sendInvoice()).rejects.toThrow();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe('static + EMAIL_PROVIDER=mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.acme.test';
  });

  function bodyOf(callIndex: number) {
    return new URLSearchParams(String(fetchMock.mock.calls[callIndex]![1].body ?? ''));
  }

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).get('from')).toBe(PARTNER_FROM);
    expect(bodyOf(0).get('h:X-Breeze-Outbound')).toBe('1');
  });

  it('falls back to EMAIL_FROM when Mailgun refuses the sending domain', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403, text: vi.fn().mockResolvedValue('{"message":"The domain is not verified. Please verify your domain."}') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
    await sendInvoice();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).get('from')).toBe('"Acme MSP via Breeze" <helpdesk@acme.test>');
    expect(bodyOf(1).get('h:X-Breeze-Outbound')).toBeNull();
  });
});

describe('static with the domain delisted', () => {
  it('never reaches the partner lane at all when the operator removes the domain', async () => {
    // Spec §13: rows move to failed/provider_rejected on the next boot, but the
    // resolver is the immediate control — the identity's domain is no longer
    // sendable, so the message goes out on the platform lane.
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
    lookupMock.mockResolvedValue({ ok: false, reason: 'domain_not_sendable' });
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0]![0].from).toBe('"Acme MSP via Breeze" <helpdesk@acme.test>');
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run src/services/emailDomains/staticTransportMatrix.test.ts
```

Expected: `Test Files  1 passed (1)`, 10 tests passed.

If a *refusal* case reports one transport call instead of two, the `static` adapter's `classifyPlatformTransportError` (W02 Task 8, upgraded in Task 3 here) did not map that fixture to `domain_unusable`. **Fix the classifier, not the fixture** — every string above is a real sender refusal:
- `550 5.7.60 … send as this sender` → matched by the structured `smtpResponseCode === 550` branch;
- `The domain is not verified. Please verify your domain.` → matched by the `domain is not verified` and `verify your domain` text markers, and by the `statusCode === 403` branch;
- `The acme.test domain is not verified.` → matched by `domain is not verified`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/emailDomains/staticTransportMatrix.test.ts
git commit -m "$(cat <<'EOF'
test(email): the static transport matrix, end to end (spec §14)

Partner-lane send with a custom From through each platform transport (resend,
smtp, mailgun) and the fallback when the relay refuses the sender — the
self-hosted acceptance test. Everything between sendEmail and the wire is
production code; only the identity lookup and the sockets are mocked.

Also pins the two NON-fallback cases, which are the ones that would lose mail if
they regressed: a recipient refusal and a transient 4xx deferral both throw and
never touch the second lane.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `runTestSend` counts against the daily cap

Spec §6.1 says the test send "counts against the daily cap". W03 amendment 7 records that it deliberately did not wire it — `tryCountPartnerLaneSend` ships here — and says in as many words: "W04 adds the cap call to the `test-send` processor." This task discharges that.

**Files:**
- Modify: `apps/api/src/jobs/sendingDomainsWorker.ts` — `runTestSend(domainId, userId)` (created by W03 Task 4, Step 5), between its `sendable` guard and its `provider.send({ … })` call
- Modify: `apps/api/src/jobs/sendingDomainsWorker.test.ts` — the `describe('test send (spec §6.1)', …)` block (created by W03 Task 4, Step 2) (Test)

**Interfaces:**
- Consumes: `tryCountPartnerLaneSend` from `../services/emailDomains/sendCap` (Task 1).
- Produces: **no signature change.** `runTestSend(domainId: string, userId: string): Promise<'sent' | 'refused' | 'skipped'>` keeps W03's exact return union; a capped send resolves `'refused'` and writes `last_test_status = 'failed'` with a cap message.

**Why `'refused'` and not `'skipped'`.** W03's vocabulary is consistent: every `'skipped'` branch (`!provider`, no context, no recipient, not sendable) writes **nothing** to the row, while `'refused'` is the one branch that records `last_test_*`. A cap hit records `last_test_*` — the partner must be able to see why the button did nothing — so it is a refusal. Returning `'skipped'` would leave W03's "skipped writes nothing" invariant false.

**Placement is load-bearing, in both directions.** After the `sendable` guard: a row that could never send must not burn a counter slot. Before `provider.send`: the test button is the only partner-lane send a human can fire on demand, so an exhausted partner must not be able to use it as an uncapped path. And because the cap check returns before the send, it also returns before `markStaticDomainVerified` — a capped `static` test send must **not** verify the row, since nothing was handed to the relay and the relay's acceptance is the entire proof (spec §5.1, W03 Task 3).

- [ ] **Step 1: Write the failing tests** — in `apps/api/src/jobs/sendingDomainsWorker.test.ts`, add this mock beside the other `vi.mock` blocks (near the `keyProbe` mock, which is the closest sibling):

```ts
const { tryCountPartnerLaneSendMock } = vi.hoisted(() => ({
  tryCountPartnerLaneSendMock: vi.fn(async () => true),
}));
vi.mock('../services/emailDomains/sendCap', () => ({
  tryCountPartnerLaneSend: tryCountPartnerLaneSendMock,
  recordPartnerLaneCapHit: vi.fn(),
  partnerLaneCapKey: vi.fn(() => 'k'),
}));
```

add one line to the file's `beforeEach`, beside `providerMock.listDomains.mockResolvedValue([])`:

```ts
  tryCountPartnerLaneSendMock.mockResolvedValue(true);
```

and append these four cases inside `describe('test send (spec §6.1)', …)`:

```ts
  // Spec §6.1: "It counts against the daily cap." W03 left the wiring to W04
  // (its amendment 7); this is the assertion that it landed.
  it('consumes a cap slot for the domain partner before sending', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');
    expect(tryCountPartnerLaneSendMock).toHaveBeenCalledWith('p1');
    expect(providerMock.send).toHaveBeenCalledTimes(1);
  });

  it('records the cap refusal on the row and never reaches the provider', async () => {
    tryCountPartnerLaneSendMock.mockResolvedValue(false);
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([{ localPart: 'help' }]);

    // 'refused', not 'skipped': every skipped branch writes nothing to the row,
    // and this one writes last_test_*.
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');
    expect(providerMock.send).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      lastTestStatus: 'failed',
      lastTestError: expect.stringContaining('daily send cap'),
    });
  });

  // A row that could never send must not burn a slot: the counter is the abuse
  // control, and a partner should not be able to exhaust their own cap by
  // pressing "test" on a failed domain.
  it('checks the cap AFTER the sendable guard', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'failed' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('skipped');
    expect(tryCountPartnerLaneSendMock).not.toHaveBeenCalled();
  });

  // The relay accepting the message is the ONLY proof Breeze can obtain that it
  // may send as a `static` domain (spec §5.1). A capped send hands the relay
  // nothing, so it must not verify the row.
  it('a capped STATIC test send does not verify the domain', async () => {
    tryCountPartnerLaneSendMock.mockResolvedValue(false);
    providerMock.verifiesByDns = false;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test' }]);
    execRows.push([]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');
    expect(providerMock.send).not.toHaveBeenCalled();
    expect(markStaticVerifiedMock).not.toHaveBeenCalled();
  });
```

(`execRows` is W03's FIFO of select results in `runTestSend`'s own order — domain row, recipient, support identity. `updates` captures every `.set()` value. `providerMock`, `markStaticVerifiedMock`, `DOMAIN_ID` and `USER_ID` are W03's; the last case restores `providerMock.verifiesByDns` via the file's `beforeEach`, exactly as W03's own `static` cases rely on.)

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/jobs/sendingDomainsWorker.test.ts
```

Expected failure: `expected "tryCountPartnerLaneSend" to be called with 'p1', but it was not called`, and the two capped cases resolving `'sent'` with `providerMock.send` called once — `runTestSend` still sends without consulting the cap.

- [ ] **Step 3: Implement** — in `apps/api/src/jobs/sendingDomainsWorker.ts`, add the import beside the other `../services/emailDomains/*` imports (W03 Task 4, Step 5's import block):

```ts
import { tryCountPartnerLaneSend } from '../services/emailDomains/sendCap';
```

and insert this immediately **after** `runTestSend`'s `sendable` guard and **before** its `const from = …` / `provider.send({ … })`:

```ts
  // Spec §6.1: the test send counts against the daily partner-lane cap. W03
  // left this to W04 (its amendment 7) because tryCountPartnerLaneSend ships
  // here.
  //
  // AFTER the sendable guard, so a row that could never send does not burn a
  // counter slot — a partner must not be able to exhaust their own cap by
  // pressing "test" on a failed domain. BEFORE the provider call, because this
  // is the only partner-lane send a human can fire on demand and it must not
  // become an uncapped bypass. Being before the send also puts it before
  // markStaticDomainVerified: a capped `static` test hands the relay nothing,
  // and the relay's acceptance is the ONLY proof that Breeze may send as the
  // domain (spec §5.1), so the row must stay `pending`.
  //
  // `refused`, not `skipped`: every skipped branch above writes nothing to the
  // row, and this one records last_test_* so the partner can see why the button
  // did nothing.
  if (!(await tryCountPartnerLaneSend(domain.partnerId))) {
    await withSystemDbAccessContext(
      () => db.update(partnerSendingDomains)
        .set({
          lastTestAt: new Date(),
          lastTestStatus: 'failed',
          lastTestError: 'The daily send cap for this partner has been reached; try again after 00:00 UTC.',
          updatedAt: sql`now()`,
        })
        .where(eq(partnerSendingDomains.id, domainId)),
      'sendingDomainTestSendCapped',
    );
    return 'refused';
  }
```

(`db`, `withSystemDbAccessContext`, `partnerSendingDomains`, `eq` and `sql` are all already imported in this file by W03 Task 4, Step 5, and the `'sendingDomainTestSend*'` context labels follow its naming. `src/jobs/**` is not scanned by `partner-wide-write-coverage.test.ts` — W03 amendment 10 verified this — so the write needs no allowlist entry.)

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/jobs/sendingDomainsWorker.test.ts \
  src/services/emailDomains/sendCap.test.ts \
  src/services/emailDomains/domainSync.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all three pass; `tsc` prints nothing. W03's own six `test send` cases must still pass unchanged — they all leave `tryCountPartnerLaneSendMock` at its default `true`, so the cap is transparent to them.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/sendingDomainsWorker.ts apps/api/src/jobs/sendingDomainsWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(email): runTestSend counts against the daily cap

Spec §6.1, discharging W03 amendment 7 ("W04 adds the cap call to the test-send
processor") now that sendCap.ts exists.

Placement is load-bearing both ways: AFTER the sendable guard, so a row that
could never send burns no counter slot; BEFORE the provider call, because the
test button is the only partner-lane send a human can fire on demand and must
not become an uncapped bypass. Being before the send also puts it before
markStaticDomainVerified — a capped `static` test hands the relay nothing, and
the relay's acceptance is the only proof Breeze may send as the domain, so the
row stays pending.

Returns 'refused', not 'skipped': every skipped branch writes nothing to the
row, and this one records last_test_* so the partner sees why.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The two sites W01 left at `partnerId: null`

W01 plan amendment 5 records both, and says W04 is the wave that decides whether to widen their reads. Without this task the `general` stream and portal password resets can **never** use the partner lane, however the partner configures it — a silently dead feature, not a slow one.

**Files:**
- Modify: `apps/api/src/routes/portal/auth.ts:557-567` (the `withSystemDbAccessContext` select in `POST /auth/forgot-password`), `:8` (the schema import), and the `sendPasswordReset` call at `:594-598` (W01 Task 4 rewrote it)
- Modify: `apps/api/src/routes/portal.test.ts:153-159` (`mockSelectResult`), `:317-386` (the three forgot-password cases) (Test)
- Modify: `apps/api/src/services/reportDelivery.ts:65-77` (the `emailReportRun` signature) and `:12` (the module docstring), plus the `partnerId` W01 Task 7 hard-coded to `null` in the `sendEmail` call at `:141`
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts:605-616` (the `emailReportRun` call)
- Modify: `apps/api/src/services/reportNarrativeDelivery.ts:206-213` (the per-pass lookups), `:230-236` (`deliverOne`'s signature), `:275-284` (the `emailReportRun` call)
- Modify: `apps/api/src/services/reportDelivery.snapshot.test.ts:58` (add `PARTNER_ID`), `:162-175` (`runScheduledReportForTest`) (Test)
- Modify: `apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap` (regenerated)
- Modify: `apps/api/src/jobs/reportScheduleWorker.test.ts`, `apps/api/src/services/reportNarrativeDelivery.test.ts` (Test — queued-select and call-shape updates)

**Interfaces:**
- Consumes: `organizations` from `../../db/schema` / `../db/schema` (already imported in `reportScheduleWorker.ts:41`).
- Produces:
  ```ts
  // services/reportDelivery.ts — the ONLY signature change in this task
  export async function emailReportRun(opts: {
    reportName: string; reportType: string; format: string; recipients: string[];
    rows: unknown[]; summary?: Record<string, unknown>; previous?: ReportResult['previous'];
    trendLine?: string | null; timezone: string; branding: ReportBranding;
    partnerId: string | null;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing portal test (red)** — in `apps/api/src/routes/portal.test.ts`, replace the `sendPasswordResetMock` assertion in `'should send password reset email when user exists'` (`:357-361`):

```ts
      expect(sendPasswordResetMock).toHaveBeenCalledWith({
        to: 'portal@example.com',
        resetUrl: 'http://localhost:4321/portal/reset-password?token=nanoid-token&orgId=f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
      });
```

with:

```ts
      // Spec §8.2: a portal password reset is the partner's `support` stream.
      // The partner comes from the org the portal_users row already points at —
      // one join, inside the system context the lookup already holds, never
      // from request input (§8.1).
      expect(sendPasswordResetMock).toHaveBeenCalledWith({
        to: 'portal@example.com',
        resetUrl: 'http://localhost:4321/portal/reset-password?token=nanoid-token&orgId=f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001',
        purpose: 'portal.password_reset',
        partnerId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620777',
      });
```

and add `partnerId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620777'` to the row that case queues (`:332-337`), beside `authMethod: 'password'`.

Also add one line to `mockSelectResult` (`:153-159`) so an `innerJoin` chains like `leftJoin` already does:

```ts
  fromChain.innerJoin = vi.fn().mockReturnValue(fromChain);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/portal.test.ts
```

Expected failure: `expected "sendPasswordReset" to have been called with …` — the call still carries `partnerId: null` (W01 Task 4's placeholder).

- [ ] **Step 3: Resolve the partner in `routes/portal/auth.ts`**

Change the schema import at `:8` from

```ts
import { portalBranding, portalUsers } from '../../db/schema';
```
to
```ts
import { organizations, portalBranding, portalUsers } from '../../db/schema';
```

and replace the lookup at `:557-567` with:

```ts
  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        email: portalUsers.email,
        orgId: portalUsers.orgId,
        authMethod: portalUsers.authMethod,
        // The partner that owns this customer's org — the `support` stream's
        // sender (spec §8.2). PUBLIC, UNAUTHENTICATED ROUTE: the id is derived
        // from the org the portal_users row points at, never from the request
        // body, whose only tenant input (`orgId`) is already constrained by the
        // WHERE below. portal_users.org_id is NOT NULL with an FK to
        // organizations (db/schema/portal.ts:58), so the inner join never drops
        // a row that the old query would have returned.
        //
        // This read MUST stay inside withSystemDbAccessContext. An
        // unauthenticated request carries no DB access context, and
        // organizations is org-axis: outside a context the query matches zero
        // rows SILENTLY under forced RLS rather than raising, so a mocked-DB
        // test cannot see the breakage. The live proof is in
        // partnerSendingDomainsRls.integration.test.ts (Task 11).
        partnerId: organizations.partnerId,
      })
      .from(portalUsers)
      .innerJoin(organizations, eq(organizations.id, portalUsers.orgId))
      .where(
        orgId
          ? and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail), eq(portalUsers.authMethod, 'password'))
          : and(eq(portalUsers.email, normalizedEmail), eq(portalUsers.authMethod, 'password'))
      )
      .limit(1)
  );
```

and change the `sendPasswordReset` call (W01 Task 4's form, `:594-604`) to:

```ts
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl,
          purpose: 'portal.password_reset',
          partnerId: user.partnerId ?? null
        });
```

- [ ] **Step 4: Run the portal suites**

```bash
cd apps/api && npx vitest run \
  src/routes/portal.test.ts \
  src/routes/portal/auth.test.ts \
  src/routes/portal/authOrgStatusGate.test.ts
```

Expected: all three pass. The latter two never exercise `forgot-password` (their `getEmailService` mock returns `null`), so the added join is invisible to them; if either reds on a missing `innerJoin`, add `innerJoin: () => chain` to that file's `db.select` chain mock and `organizations: { id: 'id', partnerId: 'partnerId' }` to its `../../db/schema` mock.

- [ ] **Step 5: Widen `emailReportRun` (red)** — in `apps/api/src/services/reportDelivery.snapshot.test.ts`, add after `const ORG_ID = …` (`:58`):

```ts
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
```

and append a fourth queued select in `runScheduledReportForTest` (`:162-175`), immediately after the `// org/partner timezone` line:

```ts
  selectMock.mockReturnValueOnce(selectChain([{ partnerId: PARTNER_ID }])); // org -> partner, for report.delivery
```

(`runFailedReportForTest` is untouched: `emailReportFailure` is `staff.report_failure`, a platform purpose, and reads no partner.)

- [ ] **Step 6: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts
```

Expected failure: the five success snapshots mismatch — each still shows `"partnerId": null`, and the queued fourth select is never consumed, which surfaces as a leftover mock rather than an error.

- [ ] **Step 7: Widen the signature in `apps/api/src/services/reportDelivery.ts`**

Replace the `opts` type of `emailReportRun` (`:65-77`) with:

```ts
export async function emailReportRun(opts: {
  reportName: string;
  reportType: string;
  format: string;
  recipients: string[];
  rows: unknown[];
  summary?: Record<string, unknown>;
  previous?: ReportResult['previous'];
  trendLine?: string | null;
  timezone: string;
  branding: ReportBranding;
  /**
   * The partner that owns the report's org — the `general` stream's sender
   * (spec §8.2). Passed IN, never read here: this module's contract is that it
   * takes address strings, a branding bag and a timezone and touches no db
   * handle (see the module docstring). Both callers already hold an org id and
   * a system DB context, so the read is theirs to make.
   *
   * `null` is allowed and means the platform sender, for a caller that cannot
   * resolve one (spec §8.1).
   */
  partnerId: string | null;
}): Promise<void> {
```

and in the `sendEmail` call at `:141`, replace W01 Task 7's placeholder

```ts
    purpose: 'report.delivery',
    partnerId: null,
```
with
```ts
    purpose: 'report.delivery',
    partnerId: opts.partnerId,
```

Update the module docstring's last paragraph (`:11-12`) from

```
 * Shape to keep in mind downstream: both take EMAIL ADDRESS STRINGS (not user
 * ids), build in-memory PDF/CSV buffers, and touch no db handle.
```
to
```
 * Shape to keep in mind downstream: both take EMAIL ADDRESS STRINGS (not user
 * ids) and IDENTIFIERS THE CALLER ALREADY RESOLVED (`partnerId`), build
 * in-memory PDF/CSV buffers, and touch no db handle. That last property is why
 * `partnerId` is a parameter rather than a lookup: the partner-lane sender
 * (spec §8.2) needs it, and this module must not grow a query to get it.
```

- [ ] **Step 8: Supply it from `jobs/reportScheduleWorker.ts`**

At `:605-616`, replace the `emailReportRun({ … })` call with:

```ts
        // The scheduled report IS a customer deliverable — partner lane,
        // `general` stream (spec §8.2). Every job in this worker runs inside
        // runWithSystemDbAccess (`:753`), so this is a plain system-context
        // read of an org row the job already owns.
        const [orgRow] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, report.orgId))
          .limit(1);

        await emailReportRun({
          reportName: report.name,
          reportType: report.type,
          format: report.format,
          recipients,
          rows,
          summary: result.summary,
          previous: result.previous,
          trendLine: trendLineOf(result),
          timezone: timeZone,
          branding,
          partnerId: orgRow?.partnerId ?? null,
        });
```

(`organizations` is already imported at `:41`; `eq` and `db` are already in scope.)

- [ ] **Step 9: Supply it from `services/reportNarrativeDelivery.ts`**

Add to the imports at `:43` (`from '../db/schema/reports'` block is separate — add a new line):

```ts
import { organizations } from '../db/schema';
```

Insert after the branding load (`:207-210`), before the `for (const delivery of pending)` loop:

```ts
  // The partner that owns this run's org — the `general` stream's sender
  // (spec §8.2). Once per pass, like the timezone and branding above, and in
  // its OWN system context: deliverNarrativeEmails refuses to run inside a db
  // context (`:165`), so every read here opens and closes one.
  const [orgRow] = await inOwnSystemContext(() =>
    db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
      .limit(1),
  );
  const partnerId = orgRow?.partnerId ?? null;
```

Change the loop call at `:213` to:

```ts
    const outcome = await deliverOne(delivery, artifact, ctx.orgId, timezone, branding, partnerId);
```

Change `deliverOne`'s signature (`:230-236`) to:

```ts
async function deliverOne(
  delivery: DeliveryRow,
  artifact: NarrativeArtifact,
  orgId: string,
  timezone: string,
  branding: Awaited<ReturnType<typeof loadReportBrandingForOrg>>,
  partnerId: string | null,
): Promise<OneOutcome> {
```

and the `emailReportRun` call (`:275-284`) to:

```ts
    await emailReportRun({
      reportName: artifact.reportName,
      reportType: artifact.reportType,
      format: artifact.format,
      recipients: [email],
      rows: [],
      summary: artifact.result?.summary,
      timezone,
      branding,
      partnerId,
    });
```

- [ ] **Step 10: Regenerate the report snapshots and fix the two worker suites**

```bash
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts
```

Expected: five snapshot mismatches, each changing exactly one line from `"partnerId": null` to `"partnerId": "55555555-5555-4555-8555-555555555555"`. Inspect the diff — **every changed line must be that one key**, and the failure snapshot must not appear at all — then accept it:

```bash
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts -u
git diff apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap
```

Expected after `-u`: the suite passes and the diff touches only `partnerId` lines — no change to `html`, `text`, `subject`, `to`, `purpose` or `attachments`. If any other line moved, stop: `emailReportRun`'s rendering was supposed to be untouched.

Then:

```bash
cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts src/services/reportNarrativeDelivery.test.ts
```

Expected: both may red. In `reportScheduleWorker.test.ts`, any case whose `processRunScheduledReport` run reaches the email branch (non-empty recipients) now makes a fourth `db.select`; append one `selectMock.mockReturnValueOnce(selectChain([{ partnerId: PARTNER_ID }]));` in that case, in the same relative position as the snapshot suite (after the org/partner timezone entry), declaring `PARTNER_ID` once at the top of the file. In `reportNarrativeDelivery.test.ts`, its `db.select` mock gains one org row per pass and any `expect(emailReportRunMock).toHaveBeenCalledWith(objectContaining({...}))` gains `partnerId`. Do not weaken an assertion to `expect.anything()` — pin the id.

- [ ] **Step 11: Prove no partner-lane site is left at null on the normal path**

```bash
git grep -n "partnerId: null" -- apps/api/src | grep -v '\.test\.ts'
```

Expected: **no line in a partner-lane send path.** Matches elsewhere (unrelated services, W01's own defaults inside `resolveSender`, `?? null` coalescers) are fine; a literal `partnerId: null` inside a `sendEmail`/`sendPasswordReset`/`sendPortalInvite`/`emailReportRun` call is not. If one survives, it is a site this task missed.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/routes/portal/auth.ts apps/api/src/routes/portal.test.ts apps/api/src/services/reportDelivery.ts apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts apps/api/src/services/reportNarrativeDelivery.ts apps/api/src/services/reportNarrativeDelivery.test.ts apps/api/src/services/reportDelivery.snapshot.test.ts apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap
git commit -m "$(cat <<'EOF'
feat(email): the two partner-lane sites W01 left at partnerId: null

Without this the `general` stream and portal password resets could NEVER use the
partner lane, however a partner configured it — a dead feature, not a slow one.

portal/auth.ts: the forgot-password lookup joins organizations for the partner,
inside the withSystemDbAccessContext it already holds. Public unauthenticated
route: the id comes from the org the portal_users row points at, never from the
request body, and the read must stay in a DB context — outside one, forced RLS
matches zero rows SILENTLY, which a mocked test cannot see. Live proof is in
partnerSendingDomainsRls.integration.test.ts.

reportDelivery.ts: emailReportRun takes partnerId rather than looking it up —
the module's contract is that it touches no db handle. Both callers already hold
an org id and a system context: the worker reads it inline, the narrative
delivery once per pass alongside the timezone and branding.

Snapshots regenerated: only the partnerId line moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Re-verify every other partner-lane site, the ticket precedence, and threading

Four sites already pass a partner id after W01 (ticket customer notifications, portal invite, quote, invoice). This task proves each one passes a **non-null** id on its normal path — a regression to `null` is silent, costs nothing at runtime and switches the whole feature off for that stream — and pins the two rules W04 must not disturb: Graph beats the partner lane, and threading headers ignore the From entirely.

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.test.ts` (Test)
- Modify: `apps/api/src/routes/orgPortalUsers.test.ts` (Test)
- Modify: `apps/api/src/services/quoteLifecycle.test.ts` (Test)
- Modify: `apps/api/src/services/invoiceResend.test.ts` (Test)

**Interfaces:**
- Consumes: `resolveSender` from `./emailDomains/senderResolution` (Task 2). No production file changes in this task.
- Produces: nothing at runtime.

- [ ] **Step 1: Ticket worker — partner id, Graph precedence, threading**

Append inside the outermost `describe` of `apps/api/src/jobs/ticketNotifyWorker.test.ts`, immediately before its closing `});`:

```ts
  // W01 made EmailPayload a discriminated union carrying the purpose; W04 is
  // the wave where a null partnerId would actually cost something. The ticket
  // row's own partner_id is the source (no new read) — a regression to null
  // would silently switch the `support` stream off for every ticket.
  it('customer notifications carry the ticket row partner id, not null', async () => {
    const customerCalls = sendEmailMock.mock.calls
      .map((c) => c[0] as { purpose?: string; partnerId?: string | null })
      .filter((c) => c.purpose === 'ticket.customer_notification');
    expect(customerCalls.length).toBeGreaterThan(0);
    for (const call of customerCalls) {
      expect(call.partnerId).toEqual(expect.any(String));
    }
  });

  // Spec §8.5: threading is decided by TICKETS_INBOUND_DOMAIN and nothing else.
  // If a From change could ever move the Message-ID, an inbound reply would
  // stop matching its ticket — the failure mode that loses a customer's reply.
  it('keeps Message-ID / In-Reply-To / References on TICKETS_INBOUND_DOMAIN whatever the From will be', async () => {
    const withHeaders = sendEmailMock.mock.calls
      .map((c) => c[0] as { purpose?: string; headers?: Record<string, string> })
      .filter((c) => c.headers && Object.keys(c.headers).length > 0);
    expect(withHeaders.length).toBeGreaterThan(0);
    for (const call of withHeaders) {
      for (const key of ['Message-ID', 'In-Reply-To', 'References']) {
        const value = call.headers![key];
        if (value === undefined) continue;
        expect(value).toContain('@tickets.example.com>');
      }
    }
  });
```

(These read whatever the preceding cases in the file already sent, so they must stay **last**. If the suite's `beforeEach` clears `sendEmailMock`, fold each assertion into the existing requester-notification case instead, on the `arg` it already captures.)

- [ ] **Step 2: Ticket worker — the Graph branch is untouched**

`apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts` already pins the precedence in four cases (`:97`, `:114`, `:131`, `:148`): a connected mailbox routes through `sendThreadedReply` / `sendNewMail` and **never** through `EmailService`. W04 changes nothing inside `EmailService`'s *caller*, so that file needs no edit — it is the control. Run it and confirm:

```bash
cd apps/api && npx vitest run src/jobs/ticketNotifyWorker.graphFork.test.ts
```

Expected: 4 tests pass, unchanged. Read `apps/api/src/jobs/ticketNotifyWorker.ts` around the send loop (`:573-596`) and confirm by eye that the `if (payload.graphMailbox) { … return; }` branch still precedes the `EmailService` branch and that only the latter reaches `email.sendEmail`. **Do not add a partner-lane call to the Graph branch**: spec §8.2's last rule is connected Graph mailbox, then partner lane, then platform, and the Graph mailbox already sends from the partner's own domain.

- [ ] **Step 3: Portal invite — partner id from the verified auth context**

Append to `apps/api/src/routes/orgPortalUsers.test.ts`, inside the describe that exercises the invite:

```ts
  // Spec §8.1: the partner comes from the VERIFIED auth context, never request
  // input. A partner-scoped caller must hand a real id over, or portal invites
  // silently stay on the platform sender forever.
  it('sends the portal invite with the caller partner id', async () => {
    const call = sendPortalInviteMock.mock.calls.at(-1)![0] as { partnerId?: string | null };
    expect(call.partnerId).toBe(TEST_PARTNER_ID);
  });
```

(`sendPortalInviteMock` and `TEST_PARTNER_ID` are this file's own names — use whatever it already calls the email mock and the partner id its auth fixture carries. If the suite only exercises a system-scope caller, add one partner-scope case rather than asserting `null`.)

- [ ] **Step 4: Quote — the captured envelope really reaches the partner lane**

Add to the top of `apps/api/src/services/quoteLifecycle.test.ts`, beside the existing `vi.mock('./email', …)` block (`:84-88`):

```ts
// W04: the real resolveSender runs over the envelope this suite captures, with
// only the database lookup mocked. This is what makes the assertion below
// non-vacuous — `getEmailService` is mocked wholesale here, so asserting on
// sendEmailMock alone could never prove the partner lane is REACHABLE.
vi.mock('./emailDomains/partnerLaneLookup', () => ({
  lookupPartnerLaneIdentity: vi.fn(async () => ({
    ok: true, partnerName: 'Acme MSP', localPart: 'billing', displayName: null,
    replyTo: null, domainId: 'd1', domain: 'mail.acmemsp.example',
  })),
}));
```

and append this case to the describe holding the existing From assertion (after `:641`):

```ts
  it('hands resolveSender enough to reach the partner lane', async () => {
    const { resolveSender } = await import('./emailDomains/senderResolution');
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
    delete process.env.EMAIL_DOMAINS_PARTNER_ALLOWLIST;
    try {
      const envelope = sendEmailMock.mock.calls[0]![0] as {
        purpose: 'quote.sent'; partnerId: string | null; partnerName?: string | null;
      };
      const resolved = await resolveSender({
        purpose: envelope.purpose,
        partnerId: envelope.partnerId,
        partnerName: envelope.partnerName,
        defaultFrom: 'Breeze <no-reply@test.example>',
      });
      // Fails the moment this call site regresses to partnerId: null — which
      // costs nothing at runtime and switches `billing` off for every quote.
      expect(resolved).toMatchObject({ lane: 'partner', from: '"Acme MSP" <billing@mail.acmemsp.example>' });
    } finally {
      delete process.env.EMAIL_DOMAINS_PROVIDER;
      delete process.env.EMAIL_DOMAINS_DAILY_SEND_CAP;
    }
  });
```

Keep the existing fallback assertions in that describe exactly as W01 left them (`purpose: 'quote.sent'`, `partnerId: 'p1'`, `partnerName: 'Acme MSP'`, `replyTo: 'accounts@acmemsp.example'`, and `not.toHaveProperty('from')`). This case is **added beside** them, not instead of them.

- [ ] **Step 5: Invoice — the same, in `apps/api/src/services/invoiceResend.test.ts`**

Add beside the existing mocks:

```ts
vi.mock('./emailDomains/partnerLaneLookup', () => ({
  lookupPartnerLaneIdentity: vi.fn(async () => ({
    ok: true, partnerName: 'Lantern MSP', localPart: 'billing', displayName: null,
    replyTo: null, domainId: 'd1', domain: 'mail.lantern.test',
  })),
}));
```

and append to the describe holding the existing envelope assertions (after `:103`):

```ts
  it('hands resolveSender enough to reach the partner lane', async () => {
    const { resolveSender } = await import('./emailDomains/senderResolution');
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
    delete process.env.EMAIL_DOMAINS_PARTNER_ALLOWLIST;
    try {
      queueHappyPath();
      await resendInvoiceEmail(INV_ID, actor);
      const envelope = sendEmailMock.mock.calls[0]![0] as {
        purpose: 'invoice.sent'; partnerId: string | null; partnerName?: string | null;
      };
      const resolved = await resolveSender({
        purpose: envelope.purpose,
        partnerId: envelope.partnerId,
        partnerName: envelope.partnerName,
        defaultFrom: 'Breeze <no-reply@breeze.test>',
      });
      expect(resolved).toMatchObject({ lane: 'partner', from: '"Lantern MSP" <billing@mail.lantern.test>' });
    } finally {
      delete process.env.EMAIL_DOMAINS_PROVIDER;
      delete process.env.EMAIL_DOMAINS_DAILY_SEND_CAP;
    }
  });
```

Keep W01's existing assertions (`envelope.purpose === 'invoice.sent'`, `envelope.partnerId === 'p1'`, `envelope.partnerName === 'Lantern MSP'`, `not.toHaveProperty('from')`).

- [ ] **Step 6: Run the four suites**

```bash
cd apps/api && npx vitest run \
  src/jobs/ticketNotifyWorker.test.ts \
  src/jobs/ticketNotifyWorker.graphFork.test.ts \
  src/jobs/ticketNotifyWorker.leak.test.ts \
  src/routes/orgPortalUsers.test.ts \
  src/services/quoteLifecycle.test.ts \
  src/services/quoteLifecycle.supersede.test.ts \
  src/services/invoiceResend.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all seven pass; `tsc` prints nothing. Check the reported file count is 7 — each path is a full filename, and vitest's filter is a plain substring, so a mistyped path silently contributes nothing rather than erroring.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.test.ts apps/api/src/routes/orgPortalUsers.test.ts apps/api/src/services/quoteLifecycle.test.ts apps/api/src/services/invoiceResend.test.ts
git commit -m "$(cat <<'EOF'
test(email): every partner-lane site reaches the lane, and nothing else moved

Four sites already passed a partner id after W01; these assertions prove it is
NON-NULL on the normal path. A regression to null is silent, costs nothing at
runtime, and switches the feature off for that whole stream.

quote and invoice run the REAL resolveSender over the envelope they captured —
both suites mock getEmailService wholesale, so an assertion on their own send
mock could never prove the lane is reachable.

Also pinned: ticket threading headers stay on TICKETS_INBOUND_DOMAIN whatever
the From becomes (a From that could move the Message-ID would stop inbound
replies matching their ticket), and the Graph branch still precedes the
EmailService branch — spec §8.2's precedence is mailbox, then partner lane,
then platform, and graphFork.test.ts passes unchanged as the control.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Loop prevention — recognise our own mail, not our own sender

Spec §8.5. Today the pipeline recognises our own mail by system local part (`no-reply`) and by sender domain `== TICKETS_INBOUND_DOMAIN`. A partner-lane From has neither, so a notification that comes back — a contact address forwarding to the partner's support mailbox, which forwards into Breeze — would open or update a ticket. We mark our own mail instead of guessing from the sender, and we deliberately do **not** suppress by sending domain: with a root domain every technician's address is on it, and a technician may legitimately write from the shared mailbox.

**Files:**
- Modify: `apps/api/src/services/inboundEmail/types.ts:44-70` (`NormalizedInboundEmail`)
- Modify: `apps/api/src/services/inboundEmail/mailgun.ts:48-66` (the `parse` return)
- Modify: `apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts:70-92` (the return)
- Modify: `apps/api/src/services/inboundEmail/loopPrevention.ts` (add two exports; leave `autoresponseSuppressionReason` untouched)
- Modify: `apps/api/src/services/inboundEmail/loopPrevention.test.ts` (Test)
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts:192-205` (the ingest-time drop)
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.test.ts` (Test — beside the existing self-loop case at `:851`)

**Interfaces:**
- Consumes: `BREEZE_OUTBOUND_HEADER` from `../emailDomains/outboundMarker` (Task 4).
- Produces:
  ```ts
  // services/inboundEmail/types.ts
  interface NormalizedInboundEmail { /* … */ outboundMarker?: string }
  // services/inboundEmail/loopPrevention.ts
  export function outboundMessageIdPattern(inboundDomain: string): RegExp;
  export function ownOutboundReason(
    n: NormalizedInboundEmail, inboundDomain: string | null | undefined,
  ): 'outbound-marker' | 'own-message-id' | null;
  ```

- [ ] **Step 1: Write the failing loop-prevention tests** — append to `apps/api/src/services/inboundEmail/loopPrevention.test.ts`:

```ts
import { outboundMessageIdPattern, ownOutboundReason } from './loopPrevention';

const INBOUND_DOMAIN = 'tickets.example.com';

describe('outboundMessageIdPattern (derived from outboundThreading.ts)', () => {
  // The generator emits exactly two shapes (services/inboundEmail/outboundThreading.ts):
  //   ticketThreadAnchor:  `<ticket-${ticketId}@${d}>`                 (:20)
  //   commentMessageId:    `<ticket-${ticketId}-${commentId}@${d}>`    (:26)
  // so the pattern is `<ticket-` + anything that is not @ / < / > / space,
  // then the inbound domain.
  const pattern = outboundMessageIdPattern(INBOUND_DOMAIN);

  it('matches both generator shapes', () => {
    expect(pattern.test('<ticket-11111111-1111-4111-8111-111111111111@tickets.example.com>')).toBe(true);
    expect(pattern.test('<ticket-11111111-1111-4111-8111-111111111111-c0ffee00-0000-4000-8000-000000000001@tickets.example.com>')).toBe(true);
  });

  it('is case-insensitive on the domain, as Message-IDs are in practice', () => {
    expect(pattern.test('<TICKET-abc@TICKETS.EXAMPLE.COM>')).toBe(true);
  });

  it('does not match another domain, another prefix, or a lookalike suffix', () => {
    expect(pattern.test('<ticket-abc@tickets.evil.com>')).toBe(false);
    expect(pattern.test('<quote-abc@tickets.example.com>')).toBe(false);
    expect(pattern.test('<ticket-abc@x.tickets.example.com>')).toBe(false);
    expect(pattern.test('<abc@tickets.example.com>')).toBe(false);
  });

  it('escapes the dots in the domain so they are not wildcards', () => {
    expect(outboundMessageIdPattern('tickets.example.com').test('<ticket-a@ticketsXexampleXcom>')).toBe(false);
  });
});

describe('ownOutboundReason (spec §8.5)', () => {
  it('recognises the outbound marker', () => {
    expect(ownOutboundReason(email({ outboundMarker: '1' }), INBOUND_DOMAIN)).toBe('outbound-marker');
    // Any non-empty value counts: forging it only gets the forger's own mail
    // ignored, so there is nothing to gain by being strict about the value.
    expect(ownOutboundReason(email({ outboundMarker: 'yes' }), INBOUND_DOMAIN)).toBe('outbound-marker');
    expect(ownOutboundReason(email({ outboundMarker: '  ' }), INBOUND_DOMAIN)).toBeNull();
  });

  it('recognises our own Message-ID', () => {
    expect(ownOutboundReason(
      email({ messageId: '<ticket-t1-c1@tickets.example.com>' }), INBOUND_DOMAIN,
    )).toBe('own-message-id');
  });

  it('leaves a customer reply alone — its In-Reply-To is ours, its Message-ID is not', () => {
    expect(ownOutboundReason(email({
      messageId: '<CAF=abc@mail.gmail.com>',
      inReplyTo: '<ticket-t1@tickets.example.com>',
      references: ['<ticket-t1@tickets.example.com>'],
    }), INBOUND_DOMAIN)).toBeNull();
  });

  // Spec §8.5, explicitly: inbound mail is NOT suppressed by sending domain or
  // identity address. With a root sending domain every technician's address is
  // on it, and a technician may legitimately write from the shared mailbox.
  it('processes a technician writing FROM the partner identity address', () => {
    expect(ownOutboundReason(
      email({ from: 'support@mail.acme.test', messageId: '<abc@mail.acme.test>' }), INBOUND_DOMAIN,
    )).toBeNull();
  });

  it('is inert when no inbound domain is configured, except for the marker', () => {
    expect(ownOutboundReason(email({ messageId: '<ticket-t1@tickets.example.com>' }), null)).toBeNull();
    expect(ownOutboundReason(email({ outboundMarker: '1' }), null)).toBe('outbound-marker');
  });

  it('returns null for ordinary inbound mail', () => {
    expect(ownOutboundReason(email({}), INBOUND_DOMAIN)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/inboundEmail/loopPrevention.test.ts
```

Expected failure: `The requested module './loopPrevention' does not provide an export named 'ownOutboundReason'`.

- [ ] **Step 3: Add `outboundMarker` to the normalized shape**

In `apps/api/src/services/inboundEmail/types.ts`, add to `NormalizedInboundEmail`, immediately after `precedence?: string;`:

```ts
  /**
   * The value of X-Breeze-Outbound, when the message carries it — i.e. this is
   * our OWN partner-lane mail coming back (spec §8.5).
   *
   * A named field, not a generic header bag, for the same reason autoSubmitted
   * and precedence are: the two providers surface headers differently (Mailgun
   * ships a JSON `message-headers` form field, Graph ships
   * internetMessageHeaders) and `raw` is provider-shaped — Mailgun's is the
   * whole form body, Graph's is two ids. Every provider that wants to
   * participate in loop prevention must map this explicitly.
   */
  outboundMarker?: string;
```

- [ ] **Step 4: Populate it in BOTH inbound providers**

`apps/api/src/services/inboundEmail/mailgun.ts` — add the import at the top:

```ts
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';
```

and one line to the `parse` return (`:48-66`), after `precedence:`:

```ts
      outboundMarker: parseHeader(b['message-headers'], BREEZE_OUTBOUND_HEADER),
```

`apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts` — add the import:

```ts
import { BREEZE_OUTBOUND_HEADER } from '../emailDomains/outboundMarker';
```

and one line to the return (`:70-92`), after `precedence:`:

```ts
    outboundMarker: header(msg.internetMessageHeaders, BREEZE_OUTBOUND_HEADER),
```

(Both helpers already compare header names case-insensitively — `mailgun.ts:208`, `normalizeGraphMessage.ts:5` — so no extra handling is needed.)

- [ ] **Step 5: Implement the two functions** — append to `apps/api/src/services/inboundEmail/loopPrevention.ts`:

```ts
/**
 * The Message-ID shapes `outboundThreading.ts` generates, as a matcher.
 *
 * Generator (services/inboundEmail/outboundThreading.ts):
 *   ticketThreadAnchor(ticketId)          -> `<ticket-${ticketId}@${domain}>`        (:20)
 *   commentMessageId(ticketId, commentId) -> `<ticket-${ticketId}-${commentId}@${domain}>`  (:26)
 *
 * Both are `<ticket-` + an id run containing no `@`, `<`, `>` or whitespace,
 * then `@` + TICKETS_INBOUND_DOMAIN + `>`. The domain is regex-escaped, so its
 * dots are literal and `ticketsXexampleXcom` does not match.
 *
 * Only the message's OWN Message-ID is tested. In-Reply-To and References are
 * deliberately NOT: every genuine customer reply carries our anchor there, and
 * matching on them would drop exactly the mail this pipeline exists to receive.
 */
export function outboundMessageIdPattern(inboundDomain: string): RegExp {
  const domain = inboundDomain.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^<ticket-[^@<>\\s]+@${domain}>$`, 'i');
}

/**
 * Is this inbound message our OWN outbound mail, looping back? (spec §8.5)
 *
 * Two signals, both about the MESSAGE:
 *   - it carries X-Breeze-Outbound (every partner-lane message does);
 *   - its own Message-ID was minted by outboundThreading.ts.
 *
 * Forging the header only gets the forger's own mail ignored, so trusting it
 * from untrusted inbound is safe.
 *
 * What is deliberately NOT a signal: the SENDING DOMAIN or the identity
 * address. With a root sending domain every technician's address is on it, and
 * a technician may legitimately write in from the shared mailbox — suppressing
 * by domain would drop their mail. The existing sender-domain rule inside
 * `autoresponseSuppressionReason` stays scoped to TICKETS_INBOUND_DOMAIN, which
 * is ours and nobody else's.
 *
 * With no inbound domain configured (self-hosted without inbound email) the
 * Message-ID rule is inert — there is no anchor to have generated — but the
 * marker still applies.
 */
export function ownOutboundReason(
  n: NormalizedInboundEmail,
  inboundDomain: string | null | undefined,
): 'outbound-marker' | 'own-message-id' | null {
  if (n.outboundMarker && n.outboundMarker.trim() !== '') return 'outbound-marker';
  const domain = inboundDomain?.trim();
  if (!domain) return null;
  const messageId = n.messageId?.trim();
  if (messageId && outboundMessageIdPattern(domain).test(messageId)) return 'own-message-id';
  return null;
}
```

- [ ] **Step 6: Run the loop-prevention suite and watch it pass**

```bash
cd apps/api && npx vitest run src/services/inboundEmail/loopPrevention.test.ts
```

Expected: `Test Files  1 passed (1)` — the file's original `autoresponseSuppressionReason` cases plus 11 new ones.

- [ ] **Step 7: Write the failing ingest test** — append to `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`, immediately after the existing self-loop case (`:851-867`):

```ts
  // OUR OWN OUTBOUND, LOOPING BACK (spec §8.5). With a partner sending domain
  // the sender is neither `no-reply` nor TICKETS_INBOUND_DOMAIN, so the
  // self-loop rule above cannot see it: a contact address that forwards to the
  // partner's support mailbox, which forwards into Breeze, would otherwise open
  // a ticket from our own notification.
  it('drops mail carrying X-Breeze-Outbound as ignored, before any create/match', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    await processInboundEmail(email({
      from: 'contact@customer.example', subject: 'Re: [T-1] printer', outboundMarker: '1',
    }));

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('ignored');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(String(log[0]!.error)).toContain('outbound-marker');
  });

  it('drops mail whose own Message-ID we generated, as ignored', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    await processInboundEmail(email({
      from: 'contact@customer.example',
      messageId: '<ticket-t1-c1@tickets.example.com>',
    }));

    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('ignored');
    expect(String(log[0]!.error)).toContain('own-message-id');
  });

  // The rule must not swallow the pipeline's whole purpose: a customer reply
  // carries OUR anchor in In-Reply-To/References and its OWN Message-ID.
  it('processes a customer reply that quotes our anchor in In-Reply-To', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-reply', internalNumber: 'T-2026-0015' });
    await processInboundEmail(email({
      from: 'contact@customer.example',
      messageId: '<CAF=abc@mail.gmail.com>',
      inReplyTo: '<ticket-t1@tickets.example.com>',
      references: ['<ticket-t1@tickets.example.com>'],
    }));

    const log = inboundOf();
    expect(log[0]!.parseStatus).not.toBe('ignored');
  });

  // Spec §8.5, the rule the advisor's alternative would have broken: a
  // technician writing in FROM the partner's own support address is a person,
  // not a loop.
  it('processes a technician writing from the partner identity address', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-tech', internalNumber: 'T-2026-0016' });
    await processInboundEmail(email({
      from: 'support@mail.acme.test', messageId: '<abc@mail.acme.test>',
    }));

    const log = inboundOf();
    expect(log[0]!.parseStatus).not.toBe('ignored');
  });
```

- [ ] **Step 8: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/inboundEmail/inboundEmailService.test.ts
```

Expected failure: the first two cases report `parseStatus` `'created'` (or `'quarantined'`) instead of `'ignored'` — the marker and the Message-ID are parsed but nothing reads them.

- [ ] **Step 9: Drop our own outbound at ingest**

In `apps/api/src/services/inboundEmail/inboundEmailService.ts`, add the import beside the existing `./loopPrevention`-adjacent imports:

```ts
import { ownOutboundReason } from './loopPrevention';
```

and insert immediately **after** the self-loop guard at `:201-205` (the block ending `return;` for `self-loop: sender is inbound domain …`):

```ts
    // (1d) OUR OWN OUTBOUND, LOOPING BACK (spec §8.5). The self-loop rule above
    // keys on the SENDER being on TICKETS_INBOUND_DOMAIN, which a partner-lane
    // message is not: its From is the partner's own domain. So a notification
    // that comes back — a contact address forwarding to the partner's support
    // mailbox, which forwards into Breeze — would sail past it and open a
    // ticket from our own mail.
    //
    // Two message-level signals instead of a sender guess: the X-Breeze-Outbound
    // header every partner-lane message carries, and a Message-ID that
    // outboundThreading.ts minted. Both are about the MESSAGE, so a technician
    // writing in from the partner's support address is unaffected — which is
    // the case suppressing by sending domain would have broken.
    const ownOutbound = ownOutboundReason(n, inboundDomain);
    if (ownOutbound) {
      await logInbound(n, partnerId, 'ignored', null, `own outbound mail: ${ownOutbound}`);
      return;
    }
```

(`inboundDomain` is already in scope from the guard immediately above, and `ownOutboundReason` accepts its `string | null`.)

- [ ] **Step 10: Run everything this task touched**

```bash
cd apps/api && npx vitest run \
  src/services/inboundEmail/loopPrevention.test.ts \
  src/services/inboundEmail/inboundEmailService.test.ts \
  src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts \
  src/services/inboundEmail/mailgun.test.ts \
  src/services/inboundEmail/autoresponder.test.ts \
  src/services/ticketMailbox/normalizeGraphMessage.test.ts \
  src/jobs/ticketMailboxPollWorker.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all seven pass; `tsc` prints nothing. `autoresponder.test.ts` is the control that `autoresponseSuppressionReason` was left alone — W04 adds a second, independent rule rather than widening the autoresponse gate, because §8.5 asks for the mail to be *ignored*, not merely un-autoresponded.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/inboundEmail/types.ts apps/api/src/services/inboundEmail/mailgun.ts apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts apps/api/src/services/inboundEmail/loopPrevention.ts apps/api/src/services/inboundEmail/loopPrevention.test.ts apps/api/src/services/inboundEmail/inboundEmailService.ts apps/api/src/services/inboundEmail/inboundEmailService.test.ts
git commit -m "$(cat <<'EOF'
feat(email): ignore our own outbound mail, by marker and Message-ID

Spec §8.5. A partner-lane From is neither `no-reply` nor TICKETS_INBOUND_DOMAIN,
so the existing self-loop rule cannot see our own notification coming back
through a forwarding contact address — it would open a ticket from our own mail.

Both inbound providers now surface X-Breeze-Outbound into
NormalizedInboundEmail.outboundMarker (a named field, because Mailgun ships a
JSON message-headers blob and Graph ships internetMessageHeaders, and `raw` is
provider-shaped), and ingest drops a message carrying it, or whose OWN
Message-ID matches the outboundThreading.ts generator on TICKETS_INBOUND_DOMAIN.

Deliberately NOT suppressed by sending domain or identity address: with a root
sending domain every technician's address is on it, and a technician writing in
from the shared mailbox is a person, not a loop. In-Reply-To and References are
not tested either — every genuine customer reply carries our anchor there.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Resolution on real Postgres

Spec §14: "Resolution is exercised from an org-scoped context and from the unauthenticated portal route, because a mocked DB cannot see the zero-row failure." Every unit test above mocks `lookupPartnerLaneIdentity`, so **none of them can fail** if the partner-axis escape is wrong — under org scope a partner-axis read returns zero rows silently rather than raising, and the whole feature would collapse to the platform lane in production while every suite stayed green.

**Files:**
- Modify: `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` (created by W02 Task 12 — append one describe; reuse its `SYSTEM_CTX`, `partnerContext`, `orgContext`, `fixture`, `seedDomain`, `uniqueDomain`, `createdPartnerIds` helpers)

**Interfaces:**
- Consumes: `resolveSender` from `../../services/emailDomains/senderResolution` (Task 2); `partnerSenderIdentities`, `partnerSendingDomains` from `../../db/schema`; W02 Task 12's harness.
- Produces: nothing importable.

- [ ] **Step 1: Write the suite** — append to `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts`:

```ts
import { resolveSender } from '../../services/emailDomains/senderResolution';

/**
 * resolveSender against real Postgres, as `breeze_app` under FORCE RLS.
 *
 * THIS IS THE ONLY PLACE the partner-axis escape can be proven. Every unit
 * test mocks lookupPartnerLaneIdentity, so none of them can fail if the escape
 * is missing — under org scope `breeze_has_partner_access` is false, the read
 * returns ZERO ROWS rather than raising, and the resolver quietly answers
 * "platform lane" forever while the whole suite stays green. That is the exact
 * shape of #2822 and the reason db/partnerAxisRead.ts exists.
 */
describe('resolveSender — live partner-axis visibility (spec §8.3, §14)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let domainName: string;

  const SAVED: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_DAILY_SEND_CAP', 'EMAIL_DOMAINS_PARTNER_ALLOWLIST',
  ];

  beforeEach(async () => {
    for (const key of ENV_KEYS) { SAVED[key] = process.env[key]; delete process.env[key]; }
    // `fake` keeps isPartnerLaneConfigured() true with no provider credentials;
    // an unlimited cap keeps Redis out of the resolution path entirely.
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';

    f = await fixture();
    // createPartner() defaults to status 'active' and trust_state 'trusted'
    // (db/schema/orgs.ts:31, :67), so the eligibility gate is open.
    const [domainRow] = await seedDomain(f.partnerA, { status: 'verified' });
    domainName = domainRow!.domain;
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA,
        sendingDomainId: domainRow!.id,
        stream: 'support',
        localPart: 'support',
        displayName: 'Acme Support',
        replyTo: null,
      }),
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key]!;
    }
  });

  it('resolves the partner lane from a SYSTEM context', async () => {
    const resolved = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toMatchObject({ lane: 'partner', from: `"Acme Support" <support@${domainName}>`, domain: domainName });
  });

  it('resolves the partner lane from the partner OWN context', async () => {
    const resolved = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved.lane).toBe('partner');
  });

  // The quote / invoice / portal-invite send sites run here.
  it('resolves the partner lane from an ORG-SCOPED context, through the partner-axis escape', async () => {
    const resolved = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toMatchObject({ lane: 'partner', domain: domainName });
  });

  // The portal password-reset route: unauthenticated, no ambient DB context at
  // all by the time the email is sent.
  it('resolves the partner lane with NO ambient context (the portal reset path)', async () => {
    const resolved = await resolveSender({
      purpose: 'portal.password_reset', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>',
    });
    // `portal.password_reset` is the `support` stream, so the same identity
    // serves it (spec §3.2).
    expect(resolved).toMatchObject({ lane: 'partner', domain: domainName });
  });

  // Plan amendment 2: a partner-scoped caller that cannot see the partner must
  // NOT escalate. If it did, this would return partner A's identity.
  it('NEVER returns another partner identity to a different partner context', async () => {
    const resolved = await withDbAccessContext(partnerContext(f.partnerB, [f.orgB]), () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toEqual({ lane: 'platform', from: 'Breeze <no-reply@2breeze.app>', reason: 'partner_ineligible' });
  });

  it('returns the platform lane for a stream with no identity', async () => {
    const resolved = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSender({ purpose: 'invoice.sent', partnerId: f.partnerA, partnerName: 'Acme MSP', defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'no_identity' });
  });

  it('returns the platform lane once the domain stops being sendable (the kill switch)', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(partnerSendingDomains).set({ status: 'suspended' })
        .where(eq(partnerSendingDomains.partnerId, f.partnerA)),
    );
    const resolved = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    // Spec §9.1: suspension takes effect on the NEXT send, because resolution
    // reads the row. There is no cache to invalidate — that is the whole
    // reason §8.3 declines one.
    expect(resolved).toMatchObject({ lane: 'platform', reason: 'domain_not_sendable' });
  });

  it('returns the platform lane for a suspended partner', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, f.partnerA)),
    );
    const resolved = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toMatchObject({ lane: 'platform', reason: 'partner_ineligible' });
  });

  it('stays on the platform lane with the provider unset — the dark state', async () => {
    delete process.env.EMAIL_DOMAINS_PROVIDER;
    const resolved = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSender({ purpose: 'ticket.customer_notification', partnerId: f.partnerA, defaultFrom: 'Breeze <no-reply@2breeze.app>' }),
    );
    expect(resolved).toEqual({ lane: 'platform', from: 'Breeze <no-reply@2breeze.app>', reason: 'lane_unconfigured' });
  });
});
```

Add `partners` to the file's `../../db/schema` import list if W02's version does not already import it (the suspended-partner case needs it), and `eq` is already imported there.

- [ ] **Step 2: Bring up a stack and run it**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack up
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
```

Expected: the whole file passes — W02's RLS/guard/cascade cases plus these 9. Leave the stack up for Task 12.

If the org-scope case returns `{ lane: 'platform', reason: 'partner_ineligible' }`, the partner-axis escape did not fire: `inPartnerVisibleContext` took the in-place branch for org scope. That is exactly the bug this suite exists to catch — fix `partnerLaneLookup.ts`, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
git commit -m "$(cat <<'EOF'
test(email): resolveSender on real Postgres, from every calling context

Spec §14. The ONLY place the partner-axis escape can be proven: every unit test
mocks the lookup, and under org scope a partner-axis read returns ZERO ROWS
silently rather than raising — so a missing escape would collapse the feature to
the platform lane in production with the whole suite green (#2822's shape).

Covers system, partner-own, org-scoped and NO-context (the unauthenticated
portal reset path) resolution, plus the assertion that a DIFFERENT partner's
context never gets partner A's identity — which holds only because a
partner-scoped caller never escalates.

Also pins the kill switch on live rows: suspending the domain or the partner
moves the next send to the platform lane, with no cache to invalidate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Verification

**Files:**
- Modify: none. This task only runs commands; fix in the owning task if anything fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a green wave.

- [ ] **Step 1: Typecheck the whole API project, including its tests**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no output. (`apps/api/tsconfig.json` sets `"include": ["src/**/*"]`, so every `*.test.ts` under `src/` is type-checked.)

- [ ] **Step 2: Typecheck the other workspaces CI type-checks separately**

```bash
pnpm --filter @breeze/shared typecheck
pnpm --filter @breeze/ext-workspace typecheck
```

Expected: both pass. W04 adds nothing to `packages/shared`; this is a regression check.

- [ ] **Step 3: Run every test file this wave touched**

```bash
cd apps/api && npx vitest run \
  src/services/emailDomains/sendCap.test.ts \
  src/services/emailDomains/partnerLaneLookup.test.ts \
  src/services/emailDomains/senderResolution.test.ts \
  src/services/emailDomains/mailPurposes.test.ts \
  src/services/emailDomains/mailPurposes.callSites.test.ts \
  src/services/emailDomains/partnerLaneSend.test.ts \
  src/services/emailDomains/staticTransportMatrix.test.ts \
  src/services/emailDomains/providerRegistry.test.ts \
  src/services/emailDomains/adapters/static.test.ts \
  src/services/emailDomains/adapters/resend.test.ts \
  src/services/emailDomains/adapters/adapterContract.test.ts \
  src/services/email.test.ts \
  src/services/email.golden.test.ts \
  src/services/email.headers.test.ts \
  src/services/email.transportError.test.ts \
  src/services/email.deliverRawScope.test.ts \
  src/services/quoteLifecycle.test.ts \
  src/services/quoteLifecycle.supersede.test.ts \
  src/services/invoiceResend.test.ts \
  src/services/reportDelivery.snapshot.test.ts \
  src/services/reportDelivery.threatDetection.test.ts \
  src/services/reportNarrativeDelivery.test.ts \
  src/services/notificationChannelSecrets.test.ts \
  src/services/inboundEmail/loopPrevention.test.ts \
  src/services/inboundEmail/inboundEmailService.test.ts \
  src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts \
  src/services/inboundEmail/mailgun.test.ts \
  src/services/inboundEmail/autoresponder.test.ts \
  src/services/inboundEmail/outboundThreading.test.ts \
  src/services/ticketMailbox/normalizeGraphMessage.test.ts \
  src/jobs/ticketNotifyWorker.test.ts \
  src/jobs/ticketNotifyWorker.graphFork.test.ts \
  src/jobs/ticketNotifyWorker.leak.test.ts \
  src/jobs/ticketMailboxPollWorker.test.ts \
  src/jobs/reportScheduleWorker.test.ts \
  src/jobs/sendingDomainsWorker.test.ts \
  src/routes/portal.test.ts \
  src/routes/portal/auth.test.ts \
  src/routes/portal/authOrgStatusGate.test.ts \
  src/routes/orgPortalUsers.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts
```

Expected: every file passes, and the reported file count is 41. Each path is a full filename — vitest's filter is a plain substring, so a mistyped path contributes nothing rather than erroring. If a path reports "No test files found", correct it rather than dropping it (`src/services/emailDomains/adapters/resend.test.ts` and `providerRegistry.test.ts` are W02's; if W02 named them differently, use its names).

- [ ] **Step 4: Prove the send path writes no partner-axis table**

```bash
git grep -nE '\.(insert|update|delete)\(\s*partnerSend' -- apps/api/src/services apps/api/src/routes
```

Expected: matches **only** in `apps/api/src/services/emailDomains/domainRelease.ts` and `apps/api/src/services/emailDomains/sendingDomainService.ts` (W02 and W03, already allowlisted). **No match in `senderResolution.ts`, `partnerLaneLookup.ts`, `partnerLaneSend.ts` or `sendCap.ts`.** Then confirm the contract test agrees:

```bash
cd apps/api && npx vitest run src/__tests__/partner-wide-write-coverage.test.ts
```

Expected: pass, with **no new entry added to `ALLOWED_WITHOUT_CAPABILITY_CHECK`** by this wave.

- [ ] **Step 5: Prove the dark state and the lazy boundary**

```bash
git grep -n "import .*from '\.\./\.\./db'" -- apps/api/src/services/emailDomains
```

Expected: matches only `apps/api/src/services/emailDomains/partnerLaneLookup.ts` — the one module `senderResolution.ts` reaches dynamically. A static `../../db` import in `senderResolution.ts`, `sendCap.ts`, `partnerLaneSend.ts` or `mailPurposes.ts` breaks spec §8.1's first property at the module-graph level (plan amendment 1).

```bash
git grep -n "await import(" -- apps/api/src/services/email.ts apps/api/src/services/emailDomains/senderResolution.ts apps/api/src/services/emailDomains/partnerLaneSend.ts
```

Expected: exactly three — `./emailDomains/partnerLaneSend` in `email.ts`, `./partnerLaneLookup` in `senderResolution.ts`, `../../jobs/sendingDomainsWorker` in `partnerLaneSend.ts`.

- [ ] **Step 6: Run the full API unit suite**

```bash
cd apps/api && npx vitest run
```

Expected: the whole suite green. This is the only run that catches a mock factory elsewhere in the repo whose `sendEmail` stub or `db.select` chain now sees an extra call.

- [ ] **Step 7: Run the contract suites on a real database**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack up          # skip if Task 11 left it up
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.config.rls.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts
```

Expected: both green. The RLS suite is unchanged by W04 (no new table), so it is a regression check; the integration run must include `partnerSendingDomainsRls.integration.test.ts` with Task 11's nine cases, and `orgLifecycleFoundations.integration.test.ts` and `tenantCascade.integration.test.ts` must still pass. Do **not** scope the integration run with `test:integration -- <paths>`: pnpm forwards the literal `--` and the whole suite runs anyway.

- [ ] **Step 8: Lint**

```bash
pnpm --filter @breeze/api lint
```

Expected: clean.

- [ ] **Step 9: Tear the stack down — nothing reaps it for you**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain && pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

Expected: the second command lists nothing this session started. Say in the PR what, if anything, was left running.

---

## Self-review

| Spec requirement | Source | Task |
|---|---|---|
| Partner branch of `resolveSender`: ONE read joining `partners`, `partner_sender_identities`, `partner_sending_domains` | §8.3 | 2 |
| Read in the ambient context when it can already see the partner (system scope, or partner scope whose accessible ids include it); `readWithPartnerAxisVisibility` otherwise (org scope, portal, no context) | §8.3 | 2 (`partnerLaneAmbientCanSee`, `inPartnerVisibleContext`), 11 (live proof) |
| A partner-scoped context that cannot see the partner never escalates | §8.3 parenthetical; plan amendment 2 | 2, 11 |
| Condition 1 — lane configured; `EMAIL_DOMAINS_PARTNER_ALLOWLIST` → `not_allowlisted` / `lane_unconfigured` | §8.3, §9.1 "Dark launch" | 2 |
| Condition 2 — `partners.status = 'active'` + `evaluateCapabilityContinuationForState('custom_sending_domain', …)`, the **side-effect-free** evaluator → `partner_ineligible` | §8.3, §9.1 "Eligibility" | 2 |
| Condition 3 — identity for the stream → `no_identity`; domain `verified` or `at_risk` → `domain_not_sendable` (all seven statuses covered) | §8.3, §5.2 | 2 |
| Condition 4 — daily cap → `over_cap`, plus the abuse-signal/log hook `recordPartnerLaneCapHit(partnerId)` for W06 | §8.3, §9.1 "Caps", §9.2 | 1, 2 |
| From = `"<display_name or partner name>" <local_part@domain>` with the `fromWithDisplayName` header-safety strip | §8.3, §4.4 | 2 |
| No cache; suspend/unsuspend and trust changes take effect on the next send | §8.3, §9.1 "Kill switch" | 2 (no cache), 11 (live kill-switch cases) |
| Platform purposes never read the DB and never reach the partner lane, whatever `partnerId` | §8.1 property 1 | 2 (reason matrix + the per-export db tripwire), 5, 12 Step 5 (module-graph grep) |
| Reply-To precedence: call site, then `identity.reply_to`, then none | §8.3 | 5 |
| Tickets keep `{slug}@TICKETS_INBOUND_DOMAIN`; quotes and invoices keep `partner.billingEmail` | §8.3 | 5 (precedence), 9 (ticket + quote/invoice sites) |
| Self-hosted with `TICKETS_INBOUND_DOMAIN` unset: no Reply-To override, replies go to the From address | §8.5 last bullet | 5 (`replyTo ?? identity ?? undefined`); `partnerInboundAddress` returns null, so the identity default applies and, absent one, no Reply-To is set |
| `sendOnPartnerLane`: `PartnerLaneMessage`, `X-Breeze-Outbound`, tags `partner_id` / `domain_id` / `stream` / `purpose`, `getEmailDomainProvider()!.send(...)` | §8.4, §5, §9.3 | 4 |
| `domain_unusable` / `lane_unavailable` → platform lane with `platformFallbackFrom`, log, `enqueueSyncDomain(domainId, { lastSendError })` | §8.4, §13 "Partner lane paused or rate-limited" | 4, 5 |
| `lane_unavailable` → ops alert on the first occurrence per hour | §13 "Partner lane paused or rate-limited" | 4 |
| `message_rejected` / `ambiguous` → throw; ambiguous NEVER retried on the other lane; unknown exception treated as ambiguous | §8.4 | 4, 5 |
| The fallback message carries neither `X-Breeze-Outbound` nor partner tags | §8.4 | 4 (fresh headers object), 5 (asserted at the transport) |
| `static`: the relay refuses the custom sender → `domain_unusable` → out from `EMAIL_FROM`, refusal recorded on the row | §13 row, §5.1 | 3 (classifier), 4 (`enqueueSyncDomain`), 6 (end-to-end, all three transports) |
| Transport matrix for `static`: `smtp`, `mailgun`, `resend` + sender refusal → `EMAIL_FROM` | §14 | 6 |
| Structured transport errors out of `deliverRaw` (deferred to W04 by W02 amendment 7) | W02 amendment 7 | 3 |
| Daily cap: Redis counter per partner per UTC day with expiry, `EMAIL_DOMAINS_DAILY_SEND_CAP`, `0` = unlimited without touching Redis, Redis-down → platform lane | §9.1, §11 | 1 |
| The test send counts against the daily cap — `runTestSend`, after the sendable guard, before the send, and therefore before `markStaticDomainVerified` (a capped `static` test never verifies the row) | §6.1, §5.1; W03 amendment 7 | 7 |
| `portal.password_reset` resolves the org's partner (public route, read inside a DB context, live-DB proof) | §8.2, W01 amendment 5 | 8, 11 |
| `report.delivery` carries the report org's partner, from both callers | §8.2, W01 amendment 5 | 8 |
| Every other partner-lane site passes a non-null `partnerId` on the normal path | §8.1, §8.2 | 9 |
| Ticket precedence: connected Graph mailbox, then partner lane, then platform | §8.2 last rule | 9 (graphFork as the control; only the `EmailService` branch changed) |
| Message-ID / In-Reply-To / References keep `TICKETS_INBOUND_DOMAIN` whatever the From | §8.5 | 9 (ticket worker), 4 (`sendOnPartnerLane` preserves the call site's headers) |
| `BREEZE_OUTBOUND_HEADER = 'X-Breeze-Outbound'` in `services/emailDomains/outboundMarker.ts` | index "Defined in W04" | 4 |
| Inbound ignored when it carries the header, or when its OWN Message-ID matches the `outboundThreading.ts` generator on `TICKETS_INBOUND_DOMAIN`, for BOTH inbound providers | §8.5 | 10 |
| Inbound NOT suppressed by sending domain or identity address (a technician writing from the identity address is processed) | §8.5 | 10 |
| Partner suspended or restricted → platform lane on the next send; provider domains kept | §13 row | 2, 11 |
| Resolver eligibility matrix, Reply-To precedence, null `partnerId`, display-name sanitising | §14 "Sender resolution" | 2, 5 |
| W01's property test still holds (a platform purpose never touches the DB) | §14, W01 Task 2 | 2 (tripwire restructured, never removed) |
| `sendEmail` with each of the four error kinds + unknown exception | §14 "`sendEmail`" | 5 |
| `email.test.ts`, `invoiceResend.test.ts`, `quoteLifecycle.test.ts` gain partner-lane cases and keep their fallback assertions | §14 | 5, 9 (plan amendment 7) |
| Integration on real Postgres: org-scoped and unauthenticated-portal resolution; another partner never gets this identity | §14 "Integration" | 11 |
| Loop prevention: own Message-ID ignored; a technician writing from the identity address is not | §14 "Loop prevention" | 10 |
| The send path never writes a partner-axis table (no `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry) | §3.1; W02 amendment 3 | Global Constraints, 4, 12 Step 4 |
| Hosted state after merge: dark (provider unset) | §15 row W04 | 2 (`lane_unconfigured` before any read), 5 (golden test unchanged), 11 (live dark case), 12 |
| Branch, `Closes #__W04__`, commit trailer, `cd apps/api && npx vitest run <path>`, contract suites before the PR | index "Rules every wave inherits" | Global Constraints, every task |
