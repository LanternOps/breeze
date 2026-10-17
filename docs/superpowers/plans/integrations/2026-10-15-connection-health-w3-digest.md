---
tracking_issue: LanternOps/breeze#8844
wave: W03 (#8847)
---

# Connection Health W3 — Daily Digest, Opt-out and RFC 8058 Unsubscribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each admin (and each grant owner) who has something to hear about gets at most one connection health email a day, at 08:00 in their partner's timezone. The email lists open incidents grouped by org, with the partner-wide ones first, and the incidents restored since their last digest. A long-open incident fades to the Monday digest. Every digest carries a signed one-click unsubscribe (RFC 8058). The same choice can be flipped back on from My Account → Profile.

**Architecture:**
- `user_email_optouts` and `connection_health_digest_deliveries` are Shape 6 (user-id scoped) tables in one migration with their RLS.
- `services/emailOptouts.ts` owns the topic list and the `isOptedOut` / `setEmailOptOut` / `clearEmailOptOut` resolver (spec §6).
- `services/emailUnsubscribeToken.ts` signs and verifies the opaque token with an HKDF-derived key (never the session/JWT key).
- `services/connectionHealth/digest.ts` holds the pure planning functions (local clock, decay, per-user content) and `runDigest(now)`, which claims, sends and marks each user's ledger row.
- `services/connectionHealth/digestEmail.ts` renders the email (HTML-escaped detail, absolute fix links, unsubscribe footer).
- `jobs/connectionHealthDigest.ts` is an hourly global BullMQ worker on `JOB_SCHEDULES['connection-health-digest']`.
- `routes/emailUnsubscribe.ts` serves `GET` (confirmation page, never writes) and `POST` (idempotent opt-out) at `/api/v1/email/unsubscribe`, per-IP rate limited.
- `GET/PATCH /users/me/email-preferences` back a new `EmailNotificationSettings` card on the Profile (My Account) page.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration, BullMQ, `node:crypto` (HKDF + HMAC-SHA256), the existing `emailLayout` helpers, Vitest, React + react-i18next.

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md` §2.2, §2.3, §2.4 (mail purpose), §4 "Digest email", §5, §6, §7, §10. W1/W2 plans in this directory.

## Global Constraints

- **Migration:** `apps/api/migrations/2026-12-29-210000-connection-health-digest.sql` (`200000` is reserved for another wave). Idempotent, no inner `BEGIN/COMMIT`, RLS in the same file, starts with `SELECT set_config('breeze.scope', 'system', true);`. Re-check it still sorts last at rebase.
- **Tenancy:** both tables are Shape 6, `user_id` only, no `org_id` / `partner_id`. Registrations: `USER_ID_SCOPED_TABLES` and `USER_OWNED_CHILD_TABLES` (rls-coverage). No cascade, merge or export entries: there is no org column, and the user FK cascades on delete. The ledger's `incident_ids` is a bare `uuid[]` with no FK, so an org delete that cascades incidents leaves harmless dangling ids that join to nothing.
- **At most once:** a ledger row is claimed with `INSERT … ON CONFLICT (user_id, digest_date) DO NOTHING RETURNING` before the send. A row still `claimed` an hour later is marked `failed`, never resent. No retry path reads `failed`.
- **Authorization at send time:** recipients are recomputed per incident at send time: partner-scope users holding `repairPermission` **and** `viewPermission` for the incident's org (or partner-wide = `orgAccess = all`), plus the active owner. Customer org admins stay off (W5). An incident leaves a user's digest the moment they lose either permission.
- **Detail:** only the stored, already-sanitized `detail` (§7), HTML-escaped. No provider text is read at send time.
- **Platform lane:** mail purpose `staff.connection_health_digest`, no `partnerId`.
- **Links:** fix links are `appBase + fixHref` (owner: `ownerFixHref ?? fixHref`), `appBase = getFrontendBaseUrl()`. The unsubscribe URL is `(PUBLIC_API_URL || getFrontendBaseUrl()) + '/api/v1/email/unsubscribe?t=<token>'`. Never a literal host.
- **No issue comments** (the orchestrator owns them). Public repo: no customer, host or infra names.

## Decisions made by this plan

| # | Decision | Why |
|---|---|---|
| D1 | **Schedule `9 * * * *`**, not a ≡ 2 (mod 5) minute | The spec asks for ≡ 2 (mod 5), but that lane is full (`scheduleRegistry.ts` notes it at `ai-artifact-expiry-sweeper` / `parked-device-expiry`). :09 is free in every hour and outside the ≡ 0 minutes. Every whole-, half- and quarter-hour offset still hits local hour 8 once a day. |
| D2 | **Catch-up window 08:00–11:59 local.** A partner is due when its local hour is 8–11 | A run missed at 08 (deploy, worker restart) still sends at 09 rather than not at all. The ledger keeps it at one per user per local date; users already in the ledger for that date are skipped before any work. |
| D3 | **`skipped_empty` rows are written** when a recomputed digest has nothing to say | The catch-up window would otherwise recompute that user hourly. The row is cheap and retention removes it. |
| D4 | **"Restored since your last digest" = recovered incidents that appeared in one of the user's `sent` digests in the last 30 days and resolved after the user's last `sent` digest** | The reader only hears "restored" about something they were told about. `retired` incidents never get a restored line (§1.1). A user with no sent digest gets no restored section. |
| D5 | **Decay is computed in the partner's local calendar.** Age = local date of now − local date of `opened_at`; age 0–6 → daily; ≥ 7 → only on local Monday | Matches §4 "first 7 days … then Monday digest". |
| D6 | **The owner path skips the `viewPermission` recheck** but requires the owner to be active | §4: the owner is notified "whatever their role", and only they can re-consent. Their link is their own `/account/connected-apps`. |
| D7 | **Only `active`, non-deleted partners are digested** | A suspended (abuse) or churned partner must not receive platform mail. |
| D8 | **No provider idempotency key** | `sendEmail` has no idempotency parameter, and the claim-before-send ledger never resends, so a key would protect nothing extra (§2.3 "when the provider supports one"). |
| D9 | **Token key = HKDF-SHA256(`APP_ENCRYPTION_KEY` ‖ fallback `SECRET_ENCRYPTION_KEY`, salt `breeze-email-unsubscribe`, info `v1`)**; a fixed test-only key outside production; **throws in production** without a secret. `JWT_SECRET` / `SESSION_SECRET` are never read | §5 "dedicated key derived from the app secret, never the session key". Rotating `APP_ENCRYPTION_KEY` invalidates old links; the user can still use My Account, and the next digest carries a fresh link. |
| D10 | **Token = `base64url("v1.<userId>.<topic>.<issuedAtSeconds>") + "." + base64url(HMAC)`**, no expiry, topic bound by the signature and checked against the topic list | §5. A token for an unknown topic is rejected (400) even with a valid signature. |
| D11 | **POST always answers with a small HTML page** (200 on success / already unsubscribed, 400 on a bad token); the body `List-Unsubscribe=One-Click` is accepted but not required | Mail clients ignore the body; the confirmation form posts the same field, so one handler serves both. |
| D12 | **Rate limit 30 requests / 60 s per IP** (`email-unsubscribe:<ip>`), on GET and POST; Redis unavailable → 503 (fail closed, the repo pattern for public routes) | §5 "rate-limited per IP". Mail-provider one-click POSTs come from shared provider IPs, so the limit is generous. |
| D13 | **The confirmation page sets its own CSP** (`default-src 'none'; style-src 'sha256-…'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`) with a hashed `<style>` block, no script | The global CSP blocks inline style in production; a hash keeps the page legible without loosening anything. |
| D14 | **Opt-out topics are a closed list** (`connection_health_digest`), enforced by a CHECK and by `EMAIL_OPTOUT_TOPICS` | A new topic is a deliberate migration. |
| D15 | **Ledger retention: rows older than 90 days**, deleted in batches of 1000 by the hourly run | Matches incident retention; the 30-day restored lookback and decay need far less. |

## Review Focus

1. **Duplicate send.** Two digest runs overlap, or a run crashes after `sendEmail`. Expect at most one email per user per local date. Tests: Task 5 "a second run for the same date sends nothing", "claim conflict skips", "stale claim becomes failed, not resent".
2. **Authorization leak.** A partner user with `selected` access, or one who lost `viewPermission`, must not see an incident in their digest. Tests: Task 5 "recipient without view permission is dropped", "selected access excludes an uncovered org".
3. **Forged unsubscribe.** An altered user id, topic or signature → 400 and no write; GET never writes. Tests: Task 3 and Task 6.
4. **Opt-out honored.** An opted-out user gets nothing, and gets the digest again after re-subscribing in My Account. Tests: Task 5, Task 7.
5. **Decay.** Day 7+ incidents only on Monday; a user whose only open incidents are past day 7 gets no Tuesday email. Tests: Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-12-29-210000-connection-health-digest.sql` | both tables, indexes, RLS, grants |
| `apps/api/src/db/schema/emailOptouts.ts` (+ `index.ts` export) | Drizzle definitions for both tables |
| `apps/api/src/services/emailOptouts.ts` (+ test) | topics + resolver |
| `apps/api/src/services/emailUnsubscribeToken.ts` (+ test) | HKDF key, sign, verify, unsubscribe URL |
| `apps/api/src/services/connectionHealth/digest.ts` (+ test) | local clock, decay, content planning, `runDigest` |
| `apps/api/src/services/connectionHealth/digestEmail.ts` (+ test) | template |
| `apps/api/src/jobs/connectionHealthDigest.ts` (+ test) | worker + schedule |
| `apps/api/src/jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `services/workerRegistry.test.ts`, `services/workerEntrypointClosure.contract.test.ts` | registrations |
| `apps/api/src/services/emailDomains/mailPurposes.ts`, `mailPurposes.test.ts`, `services/email.golden.test.ts` | mail purpose |
| `apps/api/src/routes/emailUnsubscribe.ts` (+ test), `index.ts` | public endpoint |
| `apps/api/src/routes/users.ts` (+ `users.test.ts`) | `GET/PATCH /me/email-preferences`, self-service allowlist |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Shape 6 registrations |
| `apps/api/src/__tests__/integration/connectionHealthDigest.integration.test.ts` | real-DB RLS, ledger, opt-out |
| `apps/web/src/components/settings/EmailNotificationSettings.tsx` (+ test), `ProfilePage.tsx`, `ProfilePage.test.tsx`, `locales/*/settings.json` | the toggle |
| `apps/api/src/services/connectionHealth/sources/conditions.contract.test.ts` | digest condition labels covered too |
| `apps/docs` operations note (DKIM covers both headers on SMTP relays) | §5 |

---

### Task 0: Wave plan

- [ ] Commit this plan (`docs(connection-health): W3 wave plan (#8847)`).

### Task 1: Migration, schema, RLS registration

**Files:** migration; `db/schema/emailOptouts.ts`; `db/schema/index.ts`; rls-coverage.

```sql
CREATE TABLE IF NOT EXISTS user_email_optouts (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic      text NOT NULL CHECK (topic IN ('connection_health_digest')),
  source     text NOT NULL CHECK (source IN ('settings','one_click')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
CREATE TABLE IF NOT EXISTS connection_health_digest_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date  date NOT NULL,
  status       text NOT NULL CHECK (status IN ('claimed','sent','failed','skipped_empty')),
  incident_ids uuid[] NOT NULL DEFAULT '{}',
  claimed_at   timestamptz NOT NULL,
  sent_at      timestamptz NULL,
  error        text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  CONSTRAINT connection_health_digest_deliveries_user_date_uniq UNIQUE (user_id, digest_date),
  CONSTRAINT connection_health_digest_deliveries_sent_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
-- partial index for the stale-claim sweep; digest_date index for retention
```
RLS: enabled + forced; one `FOR ALL` policy each, `breeze_current_scope() = 'system' OR user_id = breeze_current_user_id()` (the `ticket_push_preferences` spelling); `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app`.

- [ ] Step 1: add both names to `USER_ID_SCOPED_TABLES` and `USER_OWNED_CHILD_TABLES` (with reasons) — red against a DB without the tables.
- [ ] Step 2: write the migration + Drizzle schema; `pnpm db:check-drift`; `migrationRlsScope.test.ts`, `autoMigrate.test.ts`.
- [ ] Step 3: commit.

### Task 2: Opt-out resolver

**Interfaces:** `EMAIL_OPTOUT_TOPICS = ['connection_health_digest'] as const`; `type EmailOptoutTopic`; `isEmailOptoutTopic(x)`; `isOptedOut(userId, topic): Promise<boolean>`; `setEmailOptOut(userId, topic, source)` (insert on conflict do nothing; a missing user is a no-op, via `INSERT … SELECT … FROM users`); `clearEmailOptOut(userId, topic)`. All run in the caller's DB context.

- [ ] Red: unit tests with a mocked `db` for the topic guard and the call shapes; the real-DB behaviour lives in Task 8.
- [ ] Green, commit.

### Task 3: Unsubscribe token

**Interfaces:** `signUnsubscribeToken({ userId, topic, issuedAt? }): string`; `verifyUnsubscribeToken(token): { userId; topic } | null`; `buildUnsubscribeUrl(userId, topic): string`.

- [ ] Red: round trip; altered payload (user id, topic) → null; altered signature → null; truncated / extra segments / non-base64 / empty → null; a correctly signed token for an unknown topic → null; a token signed with a key derived from another secret → null; the derived key differs from a key derived from `JWT_SECRET` with the same input (and `JWT_SECRET` changes never affect verification); production with no app secret throws; URL uses `PUBLIC_API_URL`, falls back to the frontend base, never contains a literal host.
- [ ] Green (`hkdfSync`, `createHmac`, `timingSafeEqual` on equal-length buffers), commit.

### Task 4: Digest planning (pure)

**Interfaces (in `digest.ts`):**
```ts
export function localClock(now: Date, timeZone: string): { date: string; hour: number; weekday: number }; // invalid tz → UTC
export function isDigestHour(hour: number): boolean;                 // 8..11 (D2)
export function localAgeDays(openedAt: Date, now: Date, timeZone: string): number;
export function includeOpenIncident(ageDays: number, weekday: number): boolean; // D5
export type DigestIncident = { id; orgId; orgName; displayName; condition; severity; detail; fixHref; openedAt; resolvedAt; resolution };
export function planUserDigest(input: { open: DigestIncident[]; resolved: DigestIncident[]; toldIncidentIds: ReadonlySet<string>; lastSentAt: Date | null; now: Date; timeZone: string }):
  { open: DigestIncident[]; restored: DigestIncident[] } | null;     // null = nothing to say
```
- [ ] Red (table-driven): DST and half-hour zones produce hour 8 once per day; invalid tz falls back to UTC; age 0 and 6 included daily; age 7 included only on Monday; restored requires told + resolved after last sent + `recovered`; `retired` never restored; empty → null; partner-wide (orgId null) sorts first, then org name, then display name.
- [ ] Green, commit.

### Task 5: `runDigest(now)` and the email

**Flow (all DB work in system scope, outside any request context; the send itself is outside any transaction):**
1. Email service missing → return `{ skipped: 'email_unconfigured' }` without touching the ledger.
2. Expire stale claims (`claimed`, `claimed_at < now − 1h` → `failed`, error `claim expired`); retention (D15).
3. Candidate partners: active, not deleted, with an opened incident that is open or recovered in the last 8 days; keep those whose local hour is due (D2).
4. Per partner: load its open + recently recovered incidents (with org names); recompute recipients per incident = `resolvePartnerUsersWithPermission(repair) ∩ resolvePartnerUsersWithPermission(view)` (scoped by org; memoized per run) ∪ active owner; drop opted-out and inactive users and users who already have a ledger row for the local date; load each remaining user's `sent` rows from the last 30 days.
5. Per user: `planUserDigest` → `null` writes `skipped_empty`; otherwise claim → send (headers `List-Unsubscribe: <url>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, purpose `staff.connection_health_digest`) → mark `sent`, or `failed` with the error message (≤ 500 chars). A failure on one user never stops the rest.
6. Return counts `{ partners, sent, failed, skippedEmpty, claimConflicts, expired, retained }` and log a structured summary.

**Email (`digestEmail.ts`):** subject `N connection(s) need attention` (or `N connection(s) restored` when only restored items); sections per org, partner-wide first; each item: name, condition label, `open N days`, escaped detail, `Fix` link; a restored list; muted footer "You receive this because you can fix these connections in Breeze." + unsubscribe link + "Manage email in your profile" link (`/settings/profile`). Plain-text part mirrors it. Condition labels mirror the web panel's English (`conditions.contract.test.ts` extended to cover the digest map).

- [ ] Red (unit, mocked db/email/permission resolvers): sends one email with both headers and the right purpose; recipient without view permission dropped; `selected` user only for covered orgs; opted-out user skipped; owner included without view permission; second run for the same date sends nothing; claim conflict skips; stale claim becomes failed and is not resent; send failure marks failed and continues; nothing-to-say writes `skipped_empty`; partner not due → no work; email unconfigured → no ledger writes. Template: detail with `<script>` is escaped; links absolute; unsubscribe URL present in HTML and text.
- [ ] Green, commit.

### Task 6: Unsubscribe route

**Files:** `routes/emailUnsubscribe.ts`, mounted `api.route('/email', emailUnsubscribeRoutes)`.

- [ ] Red: GET valid → 200 HTML with a POST form and no DB write; GET bad token → 400; POST valid → 200, `setEmailOptOut(…, 'one_click')` in system scope; POST replay → 200 again; POST forged / wrong topic → 400 and no write; rate limit exceeded → 429; Redis down → 503; response carries the page CSP.
- [ ] Green, commit.

### Task 7: My Account toggle

**API:** `GET /users/me/email-preferences` → `{ connectionHealthDigest: boolean }` (true = subscribed); `PATCH` with a `.strict()` body `{ connectionHealthDigest: boolean }` → set/clear with `source: 'settings'`, audited `user.email_preferences.update`; added to the `isSelfServiceRoute` allowlist.

**Web:** `EmailNotificationSettings.tsx` card (`data-testid="email-notification-settings"`) on the Profile page under the push settings; loads with `fetchWithAuth`, saves with `runAction` (optimistic, reverts on failure; the `ActionError` catch pattern); `settings.json` keys under `emailNotificationSettings.*` in all 8 locales with real translations; ProfilePage test stubs the card.

- [ ] Red: route tests (default subscribed, opt-out round trip, strict body rejects `userId`, partner `selected` user reaches it); component tests (renders state, toggles and PATCHes, reverts on failure).
- [ ] Green; `localeParity`, `translationCoverage`, `humanizedKeyRegression`, `keyUsage`, `no-silent-mutations`; commit.

### Task 8: Worker, registrations, integration tests, docs

- [ ] Worker `connection-health-digest` (concurrency 1, stale-repeatable prune like the reconciler), `JOB_SCHEDULES['connection-health-digest'] = '9 * * * *'` (D1), `WORKER_REGISTRY` global entry, readiness manifest, `EXPECTED_NAMES` / `EXPECTED_WORKER_NAMES`.
- [ ] Mail purpose + `mailPurposes.test.ts` + golden test row.
- [ ] Integration (real DB): a user reads only their own opt-out and ledger rows; system scope writes them; the ledger unique key rejects a second claim; user delete cascades both; `runDigest` end to end with a fake email service.
- [ ] Contract suites on a per-worktree test stack: rls-coverage, org cascade, export policy, worker closure, parked fan-out, schedule registry.
- [ ] Docs: one operations note that DKIM must sign `List-Unsubscribe` and `List-Unsubscribe-Post` on SMTP relays.

## Deferred

- Customer org admins in the digest (W5, `customerAdminsNotified`).
- Per-locale digest copy (all platform staff mail is English today).
- A digest preview / "send me one now" button.
