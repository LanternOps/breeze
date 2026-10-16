# Connection Health Notifications — Design

**Date:** 2026-10-15
**Status:** Approved 2026-10-15. Todd asked for a lower reconcile load and for the checks to scale, which §1.3 addresses. The open questions in §12 are settled on the recommended defaults.
**Advisor quorum:** Claude (author) and Codex (xhigh, read-only).
- **Agreed:** persisted incidents kept current by a reconciler, the dual-axis tenancy shape, one digest per user across orgs, and signed one-click unsubscribe.
- **Codex amendments adopted, marked [Q]:** OAuth detection in the first wave, affirmative recovery evidence, a delivery ledger, a separate opt-out table, and an authorization recheck before send.
- **Disagreements resolved below, marked [R]:**
  - one incident per connection, not one per condition;
  - long-open incidents decay to weekly mentions;
  - customer admins are off by default (open question 1).

**Trigger:** On 2026-10-05 a customer's third-party AI agent had its Breeze OAuth grant revoked automatically for refresh-token reuse. The agent never re-authorized. It retried the dead refresh token about 750 times an hour for ten days. Nobody was told: not the user who owned the grant, not their MSP, and not us. We found it from log volume.

The same silence applies to every outbound integration. Most of them already record a failure (`last_sync_status = 'error'`, `status = 'reauth_required'`, and so on), but nothing reads that column until someone happens to open the right page.

## Goals

1. **Admins learn within a day that a connection broke.** They get an in-app notice on the next reconcile after the condition is confirmed. They also get a daily digest email, with a deep link to the screen where they fix it.
2. **Fixing it clears it.** Resolution is detected automatically. No one has to acknowledge or dismiss anything.
3. **No spam.** An MSP with 200 orgs gets at most one email a day. A connection that stays broken for weeks fades to a weekly mention. A flapping connection does not produce a notice each time it flaps.
4. **One place that answers "what's broken?"** across every integration, for the people allowed to fix it.

## Non-goals

- **Device or agent health.** Offline devices already go through alert rules (`jobs/offlineDetector.ts` → `offlineAlertEffects.ts`). This feature covers connections: integrations, OAuth grants, webhooks and syncs.
- **Routing through the alert engine.** `alerts.device_id` is NOT NULL, and the dispatcher is keyed by alert (`db/schema/alerts.ts:130`, `services/notificationDispatcher.ts:85`). Making it device-optional is its own project.
- **Slack/Teams/PagerDuty delivery.** v1 delivers in-app and by email. Event-bus events (W5) let automations and webhooks fan out further.
- **Snooze or acknowledge.** The fix for "I know Huntress is broken and don't care" is to disable the integration. A disabled integration counts as retired, not broken. Revisit only if support asks for it.
- **Wiring up `OrgNotificationSettings.tsx`.** Its alert-type × channel matrix is saved but never read (`services/effectiveSettings.ts:18`). That's a separate cleanup. This feature does not add a third notification-preference surface on top of it (see §6).

## 1. Architecture

```
health sources (one adapter per connection kind)
        │  observe(): reads only unhealthy + open-incident rows, never per org
        ▼
reconciler job (every 15 min; each kind on its own cadence; global placement)
        │  diff observations against open incidents
        ▼
connection_health_incidents  ──►  in-app notices (user_notifications, type 'integration')
        │                                  ▲
        │                                  │ marked read when the incident resolves
        ▼
digest job (hourly; sends at 08:00 partner-local) ──► email + connection_health_digest_deliveries
        │
        ▼ (W5) event bus: integration.health_opened / integration.health_resolved
```

**Why persisted incidents, not derived on read.** A digest has to know three things: when a connection broke, whether this user has already been told, and whether it recovered since the last email. None of these can be derived from current columns. Notification dedupe keys can't carry them either, because users can delete their notices (`routes/notifications.ts:143`). [Q]

**Why a reconciler, not hooks at every failure write.** There are about 14 failure write sites spread across sync workers. Hooks would scatter noise policy across all of them and still miss sources that never write a failure: Google has no failure writer at all, and webhooks only count failures. The reconciler is the single policy point. Targeted instrumentation is added only where no column expresses health (W4).

### 1.1 Health-source contract

```ts
// apps/api/src/services/connectionHealth/types.ts
export type HealthObservation = {
  sourceKind: ConnectionSourceKind;      // 'oauth_grant' | 'huntress' | 'webhook' | …
  sourceId: string;                      // the connection row's primary key
  partnerId: string;
  orgId: string | null;                  // null = partner-owned connection
  ownerUserId: string | null;            // set only when one user can fix it (OAuth grant)
  state: 'healthy' | 'broken' | 'unknown' | 'retired';
  severity: 'permanent' | 'transient';   // permanent = needs a human (reauth, revoked)
  condition: string;                     // stable code: 'reauth_required', 'sync_failed', 'grant_revoked_reuse', …
  detail: string | null;                 // already sanitized by the adapter (§7), at most 300 chars
  displayName: string;                   // "Huntress", "Hermes Agent (OAuth app)"
  fixHref: string;                       // relative path; validated against the CHECK in user_notifications
  viewPermission: Permission;            // who may see it
  repairPermission: Permission;          // who receives it
  observedAt: Date;
};

export interface HealthSource {
  kind: ConnectionSourceKind;
  /** Minutes between observations; a multiple of 15, chosen to match how often the underlying signal changes (§1.3). */
  intervalMinutes: number;
  /**
   * Runs in system scope, batched. Returns:
   *   (a) every connection of this kind currently in a broken state, read through an
   *       index on the broken predicate; and
   *   (b) the current state of every id in `trackedSourceIds` (open and pending incidents),
   *       including `retired` for an id that no longer exists.
   * Healthy connections without an incident are never read. Throw on failure; never
   * return a partial set.
   */
  observe(now: Date, trackedSourceIds: readonly string[]): Promise<HealthObservation[]>;
}
```

The registry is `services/connectionHealth/sources/index.ts`: a list of `HealthSource` objects, one file per kind. A new integration is not finished until it registers a source. A contract test lists every `*_integrations` / `*_connections` table and fails on any that has neither a source nor an exemption.

**State semantics:**
- `unknown`: the source couldn't decide, for example because a sync is running or the error was just cleared at retry start. It never resolves an incident and never opens one. [Q]
- `retired`: the connection was deleted, disabled, or deliberately disconnected. An open incident is closed with `resolution = 'retired'` and no "restored" mention.
- **A failed `observe()`** leaves that kind's incidents untouched and records the failure in the reconciler run metrics (§8). A failed scan must never look like recovery. [Q]

### 1.2 Reconciler

The job is `jobs/connectionHealthReconcile.ts`:
- queue `connection-health-reconcile`;
- stable jobId;
- pattern `2,17,32,47 * * * *` (every 15 minutes, offset from the top of the hour);
- `WORKER_REGISTRY` placement `global`.

Sub-hourly schedules do not go through `JOB_SCHEDULES`.

Each run, for each source **due** this run (its `intervalMinutes` has elapsed since its last successful observe):
1. Load that kind's open incidents and pending candidates (the tracked ids).
2. `observe(now, trackedIds)`.
3. Apply the transitions below in one system-scope transaction per kind.

| Observation | No open incident | Open incident |
|---|---|---|
| `broken`, permanent | open now | update condition/detail/last_observed_at; if condition escalated transient→permanent, re-notify in-app |
| `broken`, transient | record `first_failed_at` on a pending row; open on the **second consecutive** broken observation | update |
| `healthy` | clear any pending row | resolve after **2 consecutive** healthy observations (affirmative recovery) [Q] |
| `unknown` | no-op | no-op |
| `retired`, or a tracked id missing from the result | clear pending | resolve as `retired` |
| not returned and not tracked | — (healthy; never read) | — |

- **Reopen window.** If a connection breaks again within 60 minutes of resolving, the reconciler reopens the same incident: it clears `resolved_at` and increments `flap_count`. It does not create a new episode. [Q]
- **First run per kind.** The first successful `observe()` of a newly registered kind seeds incidents but creates no notices, so an existing backlog doesn't arrive as a burst. Seeded incidents appear in the next digest.
- **Onboarding grace.** A connection created in the last 2 hours that has never succeeded is `unknown`, not `broken`, unless the failure is permanent. This covers onboarding.

### 1.3 Load and scaling

The reconciler's cost has to grow with **the number of broken connections**, not with the number of connections, orgs or agents. These rules also serve as the template for any future periodic health check:

- **Never read the healthy set.** Every `observe()` query filters on the source's broken predicate, plus a primary-key lookup of the tracked ids. Each source must be backed by a partial index on that predicate (for example `WHERE last_sync_status IN ('error','failed')`), or must sit on a partner-axis table whose rows grow with partners. The plan lists the indexes each W2 source needs. A test runs `EXPLAIN` on each source query against a seeded DB and fails on a sequential scan of a table on the per-org list.
- **Cadence follows the signal.** Polling faster than the column it reads changes is wasted work. Sources take the default of 15 minutes. A source whose underlying sync runs hourly or daily declares `intervalMinutes: 60`. W4 staleness checks run every 360 minutes. The shortest interval is 15, because in-app latency of up to about 30 minutes still meets the within-a-day goal.
- **Latency comes from nudges, not polling.** Where a single shared write point already records a failure (the durable grant revocation in `oauth/grantStatus.ts`, the sync final-attempt helper `jobs/syncAttempt.ts`), W4 adds a nudge. The nudge enqueues `reconcile-kind:<kind>` with a stable jobId and a 60-second delay, so a burst of failures collapses into one run of that kind only. The nudge carries no policy. The poll remains the source of truth, and a lost nudge only delays detection to the next poll.
- **Bounded work per run.** One global job runs at concurrency 1, and the stable jobId prevents overlapping runs. Each kind runs in its own transaction with `SET LOCAL statement_timeout = '5s'`. The whole run has a 60-second budget: kinds left over roll to the next run, and the overrun is logged and counted.
- **Readers stop recomputing.** The W2 panel and the digest read the incidents table, a single indexed query on `partner_id WHERE resolved_at IS NULL`. They do not re-run the readiness aggregator's roughly 13 queries on every page load.
- **Expected load.** About 12 kinds at 4 runs an hour or fewer gives roughly 50 indexed queries an hour. Each returns only broken or tracked rows, typically tens of rows. Scale is reached by keeping the broken set small, not by adding replicas.

## 2. Data model

### 2.1 `connection_health_incidents`

Tenancy shape 4 (dual-axis), as in `users`: `partner_id NOT NULL`, and `org_id` nullable only for partner-owned connections. [Q]

```sql
CREATE TABLE IF NOT EXISTS connection_health_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id           uuid NULL,
  owner_user_id    uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  source_kind      text NOT NULL,
  source_id        text NOT NULL,
  condition        text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('permanent','transient')),
  detail           text NULL CHECK (char_length(detail) <= 300),
  display_name     text NOT NULL CHECK (char_length(display_name) <= 120),
  fix_href         text NOT NULL CHECK (fix_href LIKE '/%' AND fix_href NOT LIKE '//%'),
  owner_fix_href   text NULL CHECK (owner_fix_href IS NULL OR (owner_fix_href LIKE '/%' AND owner_fix_href NOT LIKE '//%')),
  view_permission  text NOT NULL,     -- 'resource:action'
  repair_permission text NOT NULL,
  first_failed_at  timestamptz NOT NULL,
  opened_at        timestamptz NULL,  -- NULL = pending (inside the grace window)
  last_observed_at timestamptz NOT NULL,
  healthy_streak   smallint NOT NULL DEFAULT 0,
  flap_count       integer NOT NULL DEFAULT 0,
  resolved_at      timestamptz NULL,
  resolution       text NULL CHECK (resolution IN ('recovered','retired')),
  pending_notice   text NULL CHECK (pending_notice IN ('opened','escalated','resolved')),
  notified_user_ids uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT connection_health_incidents_resolution_chk
    CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CONSTRAINT connection_health_incidents_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_health_incidents_open_uniq
  ON connection_health_incidents (source_kind, source_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_partner_open_idx
  ON connection_health_incidents (partner_id) WHERE resolved_at IS NULL;
```

The migration (`2026-12-29-100100-connection-health-incidents.sql`) adds three more partial indexes for the reconciler's scans: `(source_kind, resolved_at) WHERE resolved_at IS NOT NULL` (retention and the reopen window), `(id) WHERE pending_notice IS NOT NULL` (the outbox drain), and `(org_id) WHERE org_id IS NOT NULL` (org cascade and merge).

**Owner link.** `owner_fix_href` holds the connection owner's link (`/account/connected-apps`), which differs from the admin `fix_href`. Both are same-origin relative paths by CHECK.

**Notice outbox.** `pending_notice` is a durable outbox: the store sets it in the same transaction as the state change, and the notifier clears it after delivery, so a crash between commit and notify can't lose a notice.

**Notified users.** `notified_user_ids` records who received the open notice, so resolution marks exactly those users' notices read through the `(user_id, dedupe_key)` index instead of scanning `user_notifications`.

**Keying.** **[R]** The key is one incident per connection, not one per condition. Codex proposed `(…, condition_kind)`. But a connection that goes from `sync_failed` to `reauth_required` is one broken thing to the admin, and two episodes would mean two notices. So `condition` is a mutable column, and an escalation re-notifies (see §1.2).

**Org deletion.** `ON DELETE CASCADE` on the composite FK. An org's incidents must never turn into partner incidents through `SET NULL`. [Q]

**Pending rows.** A row with `opened_at IS NULL` is a pending candidate. It shares the open unique index, so a connection has at most one live row.

**RLS** (enabled and forced, in the creating migration):

```sql
-- One FOR ALL policy, so the dual-axis coverage contract
-- (rls-coverage.integration.test.ts:1993) passes unmodified.
USING / WITH CHECK (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
)
```

Codex preferred writes in system scope only. Here, writes happen only in the reconciler, in system scope, and no route exposes INSERT, UPDATE or DELETE. The tenant predicate on write commands is there to keep the coverage contract uniform. It does not grant a write path. A route test asserts that the incidents API is GET-only.

Partner-wide rows (`org_id IS NULL`) are visible only to partner-scope users with partner access. An org-scope token never sees them. That's intended, because those connections are partner-owned. No `FOR SELECT` partner-wide branch is added.

**Registration** (grep, don't judge):

| Registry | Entry |
|---|---|
| `DUAL_AXIS_TENANT_TABLES` (rls-coverage) | add |
| `CORE_ORG_CASCADE_DELETE_ORDER` | add (rows for the deleted org) |
| `orgMergeRegistry.ts` | **repoint** `org_id`. Then the reconciler's next run retires incidents whose `source_id` no longer exists (merge deduplicated the connection). |
| `CORE_TENANT_EXPORT_POLICY` | `org_id` table; `detail` → `excludedOpen` (provider text). Everything else is included. |

**Retention.** The reconciler deletes resolved rows older than 90 days in batches of 1000.

### 2.2 `user_email_optouts` (W3)

Shape 6 (user-id scoped, `breeze_current_user_id()`), on the `USER_ID_SCOPED_TABLES` allowlist. [Q]

```sql
user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
topic   text NOT NULL,           -- 'connection_health_digest' (only value in v1)
source  text NOT NULL CHECK (source IN ('settings','one_click')),
created_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY (user_id, topic)
```

**Why a table and not `users.preferences` jsonb.** The digest job has to exclude opted-out users with a set query, and the unsubscribe endpoint writes it without a session. The table has no `org_id`, so it needs no org cascade registration. The user FK cascade covers deletion.

### 2.3 `connection_health_digest_deliveries` (W3)

Shape 6. This is the per-user delivery ledger. [Q]

```sql
id uuid PK, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
digest_date date NOT NULL,                 -- partner-local date
status text NOT NULL CHECK (status IN ('claimed','sent','failed','skipped_empty')),
incident_ids uuid[] NOT NULL,
claimed_at timestamptz NOT NULL, sent_at timestamptz NULL, error text NULL,
UNIQUE (user_id, digest_date)
```

**Claim protocol.**
1. Claim with `INSERT … ON CONFLICT DO NOTHING`.
2. Send, passing the provider idempotency key `connection-health:<user>:<date>` when the provider supports one.
3. Mark the row `sent`.

A row left in `claimed` for over an hour is marked `failed`, not resent. The model is at most once: a missed digest is better than a duplicate. This window was flagged by Codex, and the AI-budget pattern has the same gap (`jobs/aiBudgetAlertDelivery.ts:223`). The ledger also drives the decay rule in §4.

### 2.4 Shared constants

- **Notification type.** Add `integration` to `NOTIFICATION_TYPES` and `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'integration'` (pattern: `2026-12-04-120100-autopay-billing-notification-type.sql`). Add a fallback-link case in `NotificationCenter.tsx:163-193`.
- **Mail purpose.** `staff.connection_health_digest`, platform lane. Update `mailPurposes.test.ts` and `mailPurposes.callSites.test.ts`.
- **Events (W5).** Add `integration.health_opened` and `integration.health_resolved` to both the `EventType` union and `EVENT_TYPES`. The first segment has no underscore, because of the WS subscribe regex (`routes/eventWs.ts:27`).

## 3. Sources

| Kind | Owner | broken when | permanent? | fix href | view / repair permission | Wave |
|---|---|---|---|---|---|---|
| `oauth_grant` | user (owner) + partner | the pair's latest automatic revoke (`refresh-token-reuse`, `revoked_by_user_id IS NULL`, within 30 days) has no grant for the same (account, client) created after it; see **OAuth detail** | yes | `/account/connected-apps` (owner); `/settings/connected-apps` (admins) | `connected_apps:read` / `connected_apps:manage` | W1 |
| `huntress`, `sentinelone`, `pax8` | partner | `is_active` and `last_sync_status` in (`error`,`failed`) | no | `/integrations#<kind>` | `organizations:read` / `organizations:write` | W2 |
| `unifi`, `backup_provider`, `edr` | partner | `status` in (`reauth_required`,`error`) or last sync failed | reauth = yes | `/integrations#unifi` / `#backup` / `#edr` | backup: `backup:read`/`backup:write`; others `organizations:*` | W2 |
| `accounting` | partner | `status` in (`reauth_required`,`disconnected`,`error`) | reauth = yes | `/integrations#quickbooks` / `#xero` | `accounting:read` / `billing:manage` | W2 |
| `dns_filter` | org | active and last sync failed | no | DNS security page (not on the hub; adapter owns the path) | `organizations:*` | W2 |
| `m365_connection`, `m365_sync` | org | connection `degraded`/`suspended`/`revoked`; sync `needs_consent`/`error` | consent/revoked = yes | `/integrations#m365` | `organizations:*` | W2 |
| `ticket_mailbox` | partner (org optional) | `status = 'reauth_required'`, or `consecutive_transient_failures ≥ 5` | reauth = yes | the mailbox card's settings page (adapter owns the path) | `organizations:*` | W2 |
| `webhook` | org | terminal delivery failures (excluding superseded deliveries, `workers/webhookDelivery.ts:137`) over a 1h window with no success since | no | `/integrations#webhooks` | `webhooks:read` / `organizations:write` | W4 |
| `google_workspace` | org | verification probe fails | yes | `/integrations#google` | `organizations:*` | W4 |
| sync staleness (any kind) | as source | no successful sync for 3× the configured interval while active | no | as source | as source | W4 |

**Fix links** are owned by each adapter. Hub hashes follow `CONNECTOR_SETTINGS_HREF` (`web/src/lib/orgReadiness.ts:442`). A per-adapter test asserts that its href matches a route in the web page registry.

**Grounding.** The W2 adapters reuse the per-kind state functions in `services/orgAccountReadinessIntegrations.ts`. They do not reuse its output: the aggregator collapses connections into worst-state badges (`:209`), and the reconciler needs one observation per connection. [Q] Extract the pure mapping functions so both consumers share them.

**Backup recovery trap.** `jobs/backupProviderSync.ts:229` clears the error when a retry starts. The backup adapter therefore reports `unknown` while a sync is running, and `healthy` only after `last_sync_status = 'success'`.

**OAuth detail.** Deliberate revocations are `retired`, never `broken`: they set `revoked_by_user_id`, or come from a partner disconnect or the tenant lifecycle. Only `refresh-token-reuse` counts as automatic. `provider-revoke-grant` does not, because oidc-provider's default `revokeGrantPolicy` also writes it for deliberate RP-initiated revocation and `end_session`, so it cannot tell a logout from a break.

Classification runs per (account, client) pair, over grants with `partner_id IS NOT NULL` only. Let E be the pair's latest automatic revoke (reason `refresh-token-reuse`, `revoked_by_user_id IS NULL`, `revoked_at` within 30 days), ordered by `revoked_at`, then `created_at`, then `id`, so ties are deterministic.
- E exists and the client is disabled → `retired`.
- E exists → look only at grants created after `E.revoked_at`. If any is active (`revoked_at IS NULL AND expires_at > now`), the pair is `healthy`. If some exist but none is active (re-consent, then a deliberate revoke or expiry), it is `retired`. If none exists, it is `broken` / permanent, condition `grant_revoked_reuse`.
- No E → an active grant means `healthy`, otherwise `retired`.

So an older install that is still active never hides a newer install that is dead. Only a grant created after the break counts as the fix.

*Deferred to W4:* detecting authorization-code replay. It needs a distinct revocation reason, which means changing `revokeGrantPolicy` on the auth surface, and that change gets its own review.

A grant incident resolves when the owner re-consents and a new active grant for the same client exists [Q]. It retires after 30 days with no replacement, because an app the user abandoned shouldn't nag forever. In W4, a Redis per-client daily counter of `refresh token not found` from the `grant.error` logger (`oauth/grantErrorLog.ts`) adds "this app is still retrying N times a day" to the detail. W1 does not depend on it.

## 4. Recipients and noise

**Who receives a notice for an incident:**
- **Org incident:** `resolveUsersWithPermissionForOrg(orgId, repairPermission)` (`services/usersWithPermission.ts:63`). This is restricted to **partner-scope users**, unless the org's resolved `customerAdminsNotified` setting is on (§6, W5) **[R]**. Partner users with `orgAccess = selected` receive it only for the orgs they cover.
- **Partner incident:** active partner-scope users with `orgAccess = all` who hold `repairPermission`.
- **`ownerUserId`:** always notified (in-app and digest), whatever their role. Only they can re-consent. Their link goes to `/account/connected-apps`, where `lifecycle.ts:254` already binds grants to the authenticated owner.

**In-app.**
- One notice per (incident, user), created when the incident opens. The dedupe key is `connection-health:<incidentId>:<openedAtEpoch>`, so a reopen after the 60-minute window creates a new notice.
- Priority is `high` for permanent incidents and `normal` for transient ones.
- On escalation to permanent, a second notice is sent with dedupe key `…:permanent`.
- On resolve, the incident's unread notices are marked read. History stays.

**Digest email (W3).**
- **When.** One email per user per partner-local day, sent at 08:00 in `partners.timezone` (`db/schema/orgs.ts:44`). The job runs hourly: register it in `JOB_SCHEDULES`, minute ≡ 2 (mod 5).
- **Contents:** open incidents grouped by org, with the partner-wide ones first. Each shows age, condition, sanitized detail and a fix link. It also lists incidents resolved since the user's last sent digest.
- **Skipped** when there's nothing new to say.
- **Decay [R].** An incident appears in a user's digest every day for its first 7 days open. After that it appears only in the Monday digest. If a user's only open incidents are past day 7 and it isn't Monday, they get no email.
- **Authorization recheck.** Recipients are recomputed at send time, and each incident's `viewPermission` is checked again. An incident leaves a user's digest the moment that user loses access. [Q]

The result for an MSP with 200 orgs is still one email a day, or none.

## 5. Unsubscribe (W3)

- **Headers.** Every digest carries `List-Unsubscribe: <https://…/api/v1/email/unsubscribe?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
- **Token.** Opaque, HMAC-SHA256 over `(v1, userId, topic, issuedAt)` with a dedicated key derived from the app secret, never the session key. It doesn't expire: an old email's unsubscribe link has to keep working. The signature binds it to a single topic.
- **`POST /api/v1/email/unsubscribe`.** Unauthenticated, idempotent. Writes `user_email_optouts(source='one_click')` and returns 200, also for an already-unsubscribed user. Rate-limited per IP.
- **`GET`** with the same token shows a confirmation page with a button that POSTs. A GET never unsubscribes, because link scanners prefetch.
- **Re-subscribe** from My Account → Notifications (§6).
- **DKIM** has to cover both headers. Resend and Mailgun sign all headers by default. The SMTP path depends on the relay, so the operations docs gain a note on it.

## 6. Settings

Settings rule 9 accounting: before = 0 places. After = 2 concepts, 1 home each.

| Concept | Home | Level | Resolver | Wave |
|---|---|---|---|---|
| Personal digest on/off | My Account → Notifications (new section) | user only (personal, not a tenant setting, so rule 3 doesn't apply) | `isOptedOut(userId, topic)` | W3 |
| Customer org admins receive connection-health notices | Integrations → Health notifications | partner default → org override (rule 3; blank = inherit, rule 4) | `resolveCustomerAdminsNotified(orgId)` | W5 |

The second setting is stored in `partners.settings.connectionHealth.customerAdminsNotified` and `organizations.settings.connectionHealth.customerAdminsNotified` (nullable = inherit), read through the existing effective-settings merge. **[R]** Codex proposed an XOR config table. For a single boolean that's more than it's worth. If a second delivery-policy setting ever arrives, revisit it then.

In-app notices have no opt-out. They are the floor.

## 7. Detail sanitization

Provider error strings can echo URLs with tokens, emails, tenant IDs or response bodies. Each adapter maps its errors to a fixed `condition` code. `detail` is built by a shared `sanitizeHealthDetail()`, which:
- strips URLs down to scheme and host;
- redacts anything matching the credential patterns already used for log redaction (bearer tokens, `key=`/`token=`/`secret=` values, JWT shapes);
- collapses whitespace;
- truncates to 300 characters.

Email renders `detail` HTML-escaped, and only to recipients who passed the `viewPermission` recheck. Tests feed it each provider's known error fixtures plus hostile strings.

## 8. Observability (W1)

- **Reconciler run metrics.** Per kind: duration, observations, opened, resolved, `observe()` failures.
- **Run summary.** Each run logs a structured summary. A kind that fails `observe()` 3 runs in a row raises an ops alert (`services/opsAlerts.ts`). A silent notifier is the worst failure mode here. [Q]
- **Zero-recipient incidents.** An incident that opens with no one to notify (no user holds `repairPermission`) gets a warn log, and is counted in a daily ops summary.
- **Heartbeat.** The reconciler writes its last successful run time to Redis. `/admin/system` shows it, so a dead job is visible.

## 9. Waves

Each wave can ship on its own and is useful without the later ones.

| Wave | Ships | Useful because |
|---|---|---|
| **W1: Incident core and OAuth** | incidents table + RLS + all registrations; source contract + registry; reconciler; `oauth_grant` source; `integration` notification type; in-app notices to grant owner + `connected_apps:manage` partner admins; resolve clears; observability (§8); read API `GET /connection-health/incidents` | Today's motivating case is caught in-app within about 15 minutes |
| **W2: Existing integration sources and panel** | the W2 adapters in §3; shared state-function extraction from the readiness aggregator; **Connection Health** panel on `/integrations` listing open + recently resolved incidents with fix links; delete the mock `ConnectorStatusPanel.tsx` | Every integration that already records failure now notifies |
| **W3: Daily digest** | digest job, email template, delivery ledger, decay, auth recheck, `user_email_optouts`, RFC 8058 endpoint + headers, My Account → Notifications toggle, new mail purpose | The within-a-day email goal is met |
| **W4: Missing signals and nudges** | webhook terminal-failure classification; sync-staleness detection; Google verification probe; OAuth "still retrying" counter; debounced per-kind reconcile nudges from shared failure write points (§1.3) | Covers connections that fail without writing a failure |
| **W5: Customer delivery and events** | `customerAdminsNotified` setting (partner → org) + UI; `integration.health_opened` / `_resolved` events (sanitized payload, no detail). A webhook incident's events are never delivered to the webhook the incident is about, which avoids a feedback loop. | Customer admins and automations can act on it |

## 10. Testing

- **Reconciler transitions** are a pure function, `(observations, incidents, now) → actions`, with table-driven unit tests for every cell in §1.2: grace, the 2-healthy rule, the reopen window, `unknown` no-ops, and a failed `observe()` leaving incidents untouched. Each test is written red first.
- **Integration tests** (real DB):
  - RLS: an org-scope token can't see partner-wide incidents or another org's incidents.
  - A partner user with `selected` access doesn't see an uncovered org's incidents.
  - Cascade on org delete.
  - Merge repoint.
  - Export policy classification.
  - The dual-axis coverage contract.
  - Run all of these locally before the W1 PR, because they fail only under Integration Tests.
- **Source contract test:** every connection table has a source or an exemption.
- **Per-source fixture tests:** each adapter maps its real column states to the expected observation, including the backup-retry `unknown` case.
- **Digest:** decay schedule, empty skip, auth recheck drops an incident, ledger at-most-once, opt-out honored.
- **Unsubscribe:** forged or altered token → 400; replay is idempotent; GET doesn't write; wrong topic is rejected.
- **Sanitizer:** provider fixtures plus hostile strings.

## 11. Risks

| Risk | Mitigation |
|---|---|
| False recovery (a cleared error that isn't a fix) | `unknown` state; 2 healthy observations; per-source traps handled (backup retry, superseded webhooks) |
| Authorization leak through email | Recipients and `viewPermission` rechecked at send time; partner-wide incidents only to `orgAccess = all`; detail sanitized and export-excluded |
| Silent notifier | Per-kind failure alerts, heartbeat, zero-recipient counter |
| Email spam leading to domain reputation damage | One per user per day; decay; skip empty; one-click unsubscribe |
| Reconciler cost at scale | Cost grows with the broken set, not with total connections; partial indexes enforced by an `EXPLAIN` test; per-kind cadence; run budget (§1.3) |
| Tenancy registration missed | Registration table in §2.1; contract suites run before the PR |
| Notice burst on first deploy | First run per kind seeds without notices (§1.2) |

## 12. Decisions (settled 2026-10-15 on the recommended defaults)

1. **Customer org admins.** Should they receive notices for their own org's connections by default?
   - **Off (MSP staff only)**, with a partner setting to turn it on. *Recommended:* most connections are partner-owned anyway, and an MSP may not want customers seeing raw "M365 sync degraded" mail.
   - **On**, as Codex proposed: customer admins who can fix it get told.
2. **Partner-level recipient gate.** Who receives partner-wide incidents?
   - **Holders of the source's repair permission** (`organizations:write` for most integrations). *Recommended:* the people who can fix it.
   - **Partner admins only.** Narrower, quieter.
3. **Digest time.** 08:00 in the partner's timezone (*recommended*), or a fixed UTC hour.
4. **OAuth retirement.** Stop reminding about a dead grant after **30 days** with no re-consent (*recommended*), or keep it open until someone acts.
