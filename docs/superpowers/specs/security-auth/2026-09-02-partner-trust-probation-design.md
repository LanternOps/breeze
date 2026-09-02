# Partner Trust Probation — Design

**Date:** 2026-09-02
**Status:** Approved 2026-09-02 (operator decisions recorded in §9); advisor quorum complete (Fable + Codex gpt-5.6-sol xhigh read-only review, 13 findings folded in)
**Owner scope:** hosted SaaS (`IS_HOSTED=true`); self-hosted deployments default to `off`
**Supersedes in part:** `2026-07-11-signup-abuse-detection-design.md` (keeps its detectors; replaces the "alert-first, human suspends later" response posture with a capability gate)

## 1. Problem

Hosted Breeze is being used as a tech-support-scam toolkit. The operator signs up, enrolls a rehearsal VM on a VPS, then enrolls victims and runs remote desktop against them. The detectors built in July see all of this, but they see it **after** the payoff.

Evidence from the 2026-08-31 → 09-02 window (both regions, verified from prod):

| Fact | Count |
|---|---|
| Self-serve signups in 48 h | 23 (19 US, 4 EU) |
| Signups that passed the breeze-billing signup-risk gate with `decision=pass` | 23 of 23 |
| Signups later suspended for abuse | 19 of 23 |
| Median time from signup to first remote desktop session (abusive accounts with a device) | ≈ 25 min |
| Time from signup to suspension | 5–16 h (next operator batch) |
| Signup IPs on hosting/VPN ASNs among the 19 suspended | 14 |
| `stage1.hosting_asn` fired on those 14 | 0 |

Three structural reasons the current stack cannot win this:

1. **Scoring at the wrong moment.** The only pre-activation gate is signup-risk in breeze-billing. Its two strongest signals (`stage1.suspended_ip_match`, `stage2.suspended_fingerprint_match`, 100 pts) need a *prior* suspension to match; a fresh identity scores 0. `stage2.name_mismatch` (40 pts) fires on most abusers but also on most legitimate MSPs (AMERIBUILT, MSBLLC this week), so it can never be a blocker. `stage1.hosting_asn` uses a hand-curated prefix table that fails open and missed every hosting ASN seen this week (Hyonix, Majestic, GSL, Ultahost, 1GSERVERS, tzulo, GWY IT, IONOS, AWS, Azure).
2. **Acting at the wrong moment.** `partner_abuse_signals` are computed by an hourly BullMQ sweep (`jobs/abuseSignalsSweep.ts:43-84`, schedule in `jobs/scheduleRegistry.ts:131`) and only *recorded and notified*. Suspension is a separate human or scheduled-operator action through `POST /admin/partners/:id/suspend-for-abuse` (`routes/admin/abuse.ts:96-127`). Nothing in the request path consults the signals.
3. **Payment identity is blind where it matters.** Every fraudulent capture arrives via Stripe Link (`billing_details.name` null, Radar risk `normal`), so the card-identity signals see nothing on exactly the payments that succeed.

Blocking *signups* harder is the wrong lever: signups are free to the attacker and every hard deny at registration has a false-positive cost we have already paid (Munneries). The lever is the **payoff**: remote control, code execution, and installer distribution to machines the account does not own.

## 2. Thesis

> A new self-serve partner starts in **probation**. Probation does not restrict the console; it denies the capabilities an abuser needs, and it denies them **at the dispatch chokepoints** against a **trust state** that is promoted by positive verification or by a one-click operator approval.

Consequences we want:

- A scammer can still sign up and can still enroll a VM. They cannot open a remote session to anything, run anything on a device, or hand anyone an installer link, until a settled non-Link card payment has aged 24 h or a human clicked approve. The 25-minute payoff window closes.
- A legitimate MSP trialing Breeze enrolls devices, sees inventory, patches, alerts, and reporting on day one. Remote control and execution unlock within 24 h of paying with a card, or within minutes if they press **Request review** and the operator approves from the evidence card.
- The operator's job changes from "sweep, investigate, contain" to "glance at an evidence card, click approve or suspend".

## 3. Design

### 3.1 Trust state (data model)

Trust is orthogonal to lifecycle. `partners.status` (`pending | active | suspended | churned | offboarding`) stays the lifecycle axis and is not changed.

`partners` is a **partner-axis** tenant table (RLS shape 3, `PARTNER_TENANT_TABLES`; `rls-coverage.integration.test.ts:174-179`), already registered in every cascade and export list. New columns:

```sql
DO $$ BEGIN
  CREATE TYPE partner_trust_state AS ENUM ('probation','trusted','restricted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ip_class AS ENUM ('residential','business','hosting','vpn','tor','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_state               partner_trust_state NOT NULL DEFAULT 'trusted',
  ADD COLUMN IF NOT EXISTS trust_changed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS trust_changed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trust_reason              text,          -- machine key: 'auto:settled_card_24h' | 'admin:approve' | 'auto:tor_signup' ...
  ADD COLUMN IF NOT EXISTS trust_review_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS probation_enrollments     integer NOT NULL DEFAULT 0,   -- lifetime, never decremented
  ADD COLUMN IF NOT EXISTS signup_ip_class           ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS signup_ip_asn             integer,
  ADD COLUMN IF NOT EXISTS signup_ip_classified_at   timestamptz;
CREATE INDEX IF NOT EXISTS partners_trust_state_idx ON partners (trust_state) WHERE trust_state <> 'trusted';

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS enrollment_ip_class         ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS enrollment_ip_asn           integer,
  ADD COLUMN IF NOT EXISTS enrollment_ip_classified_at timestamptz;
```

- `probation` — default for every partner created through `POST /auth/register-partner` (`routes/auth/register.ts:95`) from the day the flag is `enforce`. Capability-gated per §3.2.
- `trusted` — full capabilities. Column default, so **every pre-existing partner is grandfathered** without a backfill decision on day one (optional retro-backfill in §5).
- `restricted` — set by the operator, or by the hard-deny rules in §3.4, when the account is suspicious but not proven abusive. Same gates as probation, never auto-promotes; only an admin moves it.

Transitions and every gate denial are written to `audit_logs` (`partner.trust.promoted`, `partner.trust.restricted`, `partner.trust.review_requested`, `partner.trust.capability_denied`) with reason and evidence snapshot. These are immutable events on purpose: `partner_abuse_signals` dedupes on `(partner_id, signal_key)` and stale-resolves rows (`services/abuseSignals/persistence.ts:29-33,95-121`), which would collapse "denied 5 remote sessions in 10 minutes" into one row and then auto-resolve it.

Tenancy and export contracts: no new table, no cascade-list change. `tenantExportPolicyRegistry.ts` gets entries for the new columns: trust columns `included`; `*_ip_class`, `*_ip_asn`, `*_classified_at` and `probation_enrollments` go in the bucket that is **excluded from the tenant-facing export** (they are risk metadata about the tenant, and a subject-access export must not double as a detection-tuning oracle for an abuser). The `rls-coverage` and `tenant-export-policy` suites gate the PR.

`devices.enrollment_ip` (`db/schema/devices.ts:53-56`) and `partners.signup_ip` (`db/schema/orgs.ts:49-53`) already exist; the classification columns are the only additions on that axis.

### 3.2 Capability gate

New module `apps/api/src/services/partnerTrust.ts`, evaluated under a system DB context (`withSystemDbAccessContext`, after `runOutsideDbContext` on the request path) because the request-scoped role cannot read `partner_abuse_signals` (`db/schema/abuseSignals.ts:9-15`):

```ts
type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll';
type GateDecision =
  | { allow: true }
  | { allow: false; code: 'TRUST_PROBATION' | 'TRUST_RESTRICTED'; capability: GatedCapability; reason: string };

export async function evaluateCapability(cap: GatedCapability, ctx: { partnerId: string; deviceId?: string; clientIp?: string }): Promise<GateDecision>;
export function requireCapability(cap: GatedCapability): MiddlewareHandler; // 403 with the contract body below
export function isLifecycleCommand(type: string): boolean;                   // the allowlist, single source of truth
```

Rules while `trust_state ∈ {probation, restricted}` (**default deny**; this is the quorum's simpler model, see §9 Q1 for the opt-in exception):

| Capability | Probation / restricted rule |
|---|---|
| `remote_control` | **Deny.** Every remote session type (desktop, terminal, file transfer), Quick Support / support sessions, tunnels (proxy and VNC), the AI `create_remote_session` / `computer_control` tools, and third-party remote launch (which returns a launcher URL and may carry preset credentials, `routes/devices/core.ts:1203-1218,1297-1301`). |
| `device_execute` | **Deny every device mutation** except an explicit lifecycle allowlist. Gated types include `script`, `execute_command`, `file_write` and the other `file_*` mutations, `task_run`, `registry_*`, `software_install|uninstall|update`, `install_patches`, `rollback_patches`, `backup_restore`, `vm_*`, `mssql_restore`, `hyperv_*`, `actuate_elevation`, `computer_action`, `terminal_start`, `tunnel_*`, `execute_containment`, `security_threat_*`, `homebrew_bootstrap`, and `reboot`. Reads (`file_list`, `file_read`, `list_processes`, event logs, inventory, metrics, `filesystem_analysis` when system-initiated) are never gated. |
| `installer_distribute` | **Deny** installer links, short-links, public download URLs, bulk-link keys (`x20 … x1000`), onboarding tokens, and Quick Support codes/URLs. The authenticated console download for the partner's own machine stays allowed. |
| `agent_enroll` | Allowed while `probation_enrollments < 5`. The counter is incremented **inside the enrollment transaction with the partner row locked** (`SELECT … FOR UPDATE`) and never decremented, so deleting devices (`routes/devices/core.ts:1517-1561`) or racing parallel enrollments (`routes/agents/enrollment.ts:695-767,830-861` separates count and insert today) cannot recycle the quota. Restricted: deny. |

**Where the gate lives: chokepoints, not routes.** A route-by-route enumeration (2026-09-02) found 17 categories of device execution. Nearly all converge on two functions, so the gate goes there and the routes inherit it:

1. **Command dispatch.** `services/commandQueue.ts` (`queueCommand:601`, `queueCommandForExecution:802`, `executeCommand:913`) and the online fast path `routes/agentWs.ts:3123` `sendCommandToAgent` (18 call sites that skip the queue when the agent is connected; e.g. `services/softwareDeployment.ts:113-132`). Both take a device id; the gate resolves device → org → partner (one indexed read, cached per request) and applies `isLifecycleCommand()`. The two raw `db.insert(deviceCommands)` sites (`routes/devices/actuateElevation.ts:191-217`, `routes/mobile.ts:1318`) are routed through the same helper so the allowlist is the single source of truth. Script dispatch (`routes/scripts.ts:976-998`, `dispatchScriptToDevice`) and automation actions (`services/automationRuntime.ts:1184-1198,1265-1290`) already terminate in these functions.
2. **Session creation.** The `insert(remoteSessions)` sites (`routes/remote/sessions.ts:155`, `services/aiToolsRemote.ts:357`, `routes/tunnels.ts`) and the `supportSessions` / `tunnelSessions` inserts (`routes/remote/supportSessions.ts:52-127`, `routes/tunnels.ts:321-424,447-456`) move behind one `createRemoteSession()` service that evaluates `remote_control`. Ticket issuance (`desktopWs.ts:1276` connect/exchange, `terminalWs.ts:1114`, tunnel `ws-ticket` / `http-ticket` / `connect-code` at `routes/tunnels.ts:1061,1121,1189`) re-checks the session's partner trust at ticket time, so a promotion revoked mid-session ends at the next ticket. Third-party remote launch is gated at its route because it does not create a session row.

Paths that do not pass through those chokepoints get explicit gates:

- **Installer distribution**: the `routes/enrollmentKeys.ts` handlers that emit `enrollment_key.installer_link_created`, the public download (`:2519`), the short-link redirect (`:2576`), onboarding-token creation, and Quick Support code creation → `requireCapability('installer_distribute')`. The public routes carry no auth; they resolve key → org → partner and evaluate the same predicate. Quick Support additionally re-checks owner trust at anonymous download and at code redemption (`routes/supportPublic.ts:319-369,445-551`), so a code minted before restriction dies with it.
- **Agent enrollment**: `routes/agents/enrollment.ts:86` → `evaluateCapability('agent_enroll')` inside the enrollment transaction; on allow, increment `probation_enrollments` and enqueue IP classification (§3.4).

Automations and schedulers run as the system principal on behalf of the automation's creator; because the gate sits in dispatch, a probation partner's automation still runs its read steps and has its execute steps refused with the same reason code, logged on the run. The unauthenticated automation webhook trigger (`routes/automations.ts:1337-1367`, secret-only auth) needs no extra work for the same reason. The MCP server (`routes/mcpServer.ts`) and mobile app reach the same dispatch layer.

A route-level `requireCapability()` is added where an early, friendlier 403 beats a dispatch-time refusal (`POST /remote/sessions`, `POST /scripts/:id/execute`, `POST /devices/:id/commands`, `POST /software/deployments`), but it is a UX convenience; the chokepoint is the control.

The deny body is a stable contract the web client renders as a banner, never as a generic error:

```json
{ "error": "TRUST_PROBATION", "capability": "remote_control",
  "reason": "probation_default_deny",
  "reviewRequested": false, "meetingUrl": "<PARTNER_MEETING_URL>" }
```

`partnerGuard.ts` (`middleware/partnerGuard.ts:8`) is **not** the gate. It stays a lifecycle gate (`PARTNER_INACTIVE`). Trust is loaded alongside it into `auth.trustState` so the gate does not repeat the query.

Agent side: nothing changes. The agent tenant gate (`services/tenantStatus.ts:244`) still keys on `partners.status`; a probation tenant is `active`, so heartbeats, inventory, and patch scans keep working. Only operator-initiated actions on the device are refused, at the API.

### 3.3 Promotion

Promotion is evaluated in two places: lazily at every capability deny (a partner that just became eligible is promoted on their next click, not next hour), and by a 15-minute job on the existing `abuse-signals` BullMQ queue. Both run in the system DB context.

**Automatic promotion** (`trust_reason = 'auto:settled_card_24h'`) requires **all** of:

1. `partners.created_at` ≥ 24 h ago and `email_verified_at` set.
2. A **settled card payment**: `charge.succeeded` ≥ 24 h ago in `billing_events`, not disputed, not refunded, `payment_method_details.type = 'card'` (not `link`), 3DS authenticated (§3.5), `billing_details.name` present.
3. `signup_ip_class ∉ {hosting, vpn, tor, unknown}`, and every enrolled device's `enrollment_ip_class ∉ {tor}`. Devices on hosting ASNs do not block promotion (MSPs manage servers in datacenters); they are shown on the evidence card.
4. No unresolved `partner_abuse_signals` at `alert` severity and no breeze-billing hold in `hold | review_pending`.

There is **no age-only promotion**. A free or community plan account, or a paid account that fails rule 3, is promoted only by an operator click. Age plus absence of alerts was rejected by the quorum: it rewards stockpiled quiet accounts, and the current sweep thresholds (`services/abuseSignals/config.ts:13-27`, `heuristics.ts:440-464`) tolerate low-and-slow activity.

**Manual promotion / restriction** (`trust_reason = 'admin:<verb>'`): `POST /admin/partners/:id/trust/promote` and `POST /admin/partners/:id/trust/restrict`, both `requireMfa()`, in `routes/admin/abuse.ts` next to `suspend-for-abuse`. Body `{ reason }` (required, ≥ 8 chars); writes the audit row.

**Partner-initiated review**: `POST /partner/trust/request-review` sets `trust_review_requested_at` and emails the ops channel (existing `sendOpsAlert`) with the evidence card (§3.6). One per 24 h.

Promotion never moves `restricted`. Only an admin does.

### 3.4 IP classification and hard denies

Replace the static `hostingPrefixes.ts` table as the source of truth with an **asynchronous** classification that runs off the request path, honoring the existing rule that registration never waits on an external lookup:

- New job `ip-classify` on the `abuse-signals` queue, enqueued from `register-partner` (signup IP) and from agent enrollment (enrollment IP). It calls a privacy-detection API (ipinfo `privacy` or ipdata; provider and key behind env vars, never in the repo) and writes `signup_ip_class` / `enrollment_ip_class` plus ASN. Results are cached in Redis per /24 (v4) or /48 (v6) for 7 days so a ring costs one call.
- Until the result lands (typically < 5 s) the class is `unknown`, which blocks **auto-promotion only**; it does not deny anything by itself, because probation already denies everything that matters.
- The static prefix table stays as an offline fallback (provider outage or no key configured) and is refreshed from RIPEstat per the note already in that file.

Hard denies (`probation → restricted`, evaluated by the same job, no human in the loop). Each requires **either** a non-IP axis **or** an IP match corroborated by a second axis. Egress IP alone is not evidence: the repo already rejects it as sole recidivism proof (`services/abuseSignals/recidivistEndpoint.ts:310-317`), and CGNAT, shared offices, and VPN-using MSPs make a bare /24 rule unsafe.

- Signup IP class `tor`.
- Card fingerprint or Link email matches a `fraudulent`-refunded customer in Stripe. Stripe is one account for both regions, so this is the one identity axis that is legitimately cross-region.
- Signup or enrollment IP within /24 (v4) or **/64** (v6, matching the existing heuristic in `heuristics.ts:328-356`) of a partner suspended for abuse in the same region in the last 90 days, **and** one of: same email domain, same card fingerprint, same `signup_user_agent` plus same device hostname pattern, or same agent-reported machine identity on an enrolled device.

Explicitly **not** in scope: any registration-time lookup against the other region's database. That was ruled out on 2026-08-03 as a cross-border transfer of personal data with no region model to govern it. If a shared blocklist is ever wanted, it must be a hashed, non-reversible token list (HMAC of /24 and email domain under a per-deployment key) published to a neutral store, and it is a separate decision.

### 3.5 Stripe (prerequisite, breeze-billing repo)

These are **rollout prerequisites** for `enforce`, not follow-ups, because rule §3.3(2) is meaningless while Link is on. They live in breeze-billing (the signup Checkout is created there; core only has the invoice pay link, `services/invoiceCheckout.ts:107`) and must be verified end-to-end in Stripe test mode before the flag flips:

1. Signup Checkout: `payment_method_types: ['card']`, no Link, `payment_method_options.card.request_three_d_secure: 'any'`.
2. Radar: retire `card_count_for_customer_all_time >= 2` (it manufactures the retries our own `card_testing` detector then scores) in favor of `review` at `>= 3` and `block` at `>= 5`. Dashboard change; recorded here so the decision is auditable.
3. The webhook already persists `charge.succeeded` to `billing_events`; core reads it through `breezeBillingClient`. `billing_cardholder_name` becomes reliably non-null once Link is off, which also revives `stage2.name_mismatch` and `stage2.distinct_names` as real signals.
4. Refund posture on `suspend-for-abuse` stays as it is today (operator decision at suspension time).

### 3.6 Operator surface: approval queue

Two entry points, cheapest first:

**Email card (day one).** Every entry into probation with at least one `watch`+ signal, every review request, and every `restricted` transition sends one ops email with an evidence card: partner, plan, signup IP + class + ASN, email domain age and MX, cardholder vs. user name, distinct payment methods and failures, devices (hostname, enrollment IP class, virtual flag), capability denials in the last 24 h, and matching suspended-account axes. The card carries two signed one-time links (`/admin/trust/act?token=…`, 24 h TTL, single use, bound to the operator's user and requiring a fresh MFA) for **Approve** and **Suspend**. This is the 10-second path.

**Web page (wave 2).** `apps/web` platform-admin page `/admin/trust-queue` listing `partners WHERE trust_state <> 'trusted'` ordered by newest signal, with the same card and buttons, backed by `GET /admin/trust/queue`. Production currently has **zero** `is_platform_admin` users; enabling the page requires granting the flag to the operator account first.

### 3.7 Signals

The hourly sweep keeps computing `partner_abuse_signals`. Changes:

- Capability denials are `audit_logs` events (§3.1), and the evidence card and queue read them directly. A denial burst ("5 remote sessions refused in 10 min against a hosting-ASN device") is the abuser's signature and today only shows up as `rmm.session_intensity` after the sessions succeeded.
- Sweep cadence for `fraud.*` and `rmm.*` signals drops from 60 min to 15 min. The sweep's cost is dominated by `remote_sessions` and `devices` scans already indexed by partner; measured at < 2 s per run on US.

Nothing auto-suspends. Suspension remains an explicit admin action; probation makes the human decision affordable.

## 4. Web client

- `TrustProbationBanner` renders when any gated request returns `TRUST_PROBATION | TRUST_RESTRICTED`: explains what is gated, shows the promotion checklist with ticks (24 h, verified email, card settled), a **Request review** button, and the meeting link. Copy never explains the detection mechanism.
- Remote-control and execution buttons stay enabled; the 403 is handled by `runAction` and surfaces the banner. Hiding the buttons would be a hide-on-failure UI that needs E2E proof and would break the request-review flow.
- Onboarding copy for new signups says up front which capabilities unlock after payment or review, so the banner is never the first time they hear it.

## 5. Configuration and rollout

Flag `PARTNER_TRUST_MODE = off | shadow | enforce` (env; hosted default `shadow`, self-hosted default `off`), following the `ML_FEATURE_FLAGS` global-kill-switch pattern (`services/mlFeatureFlags.ts`).

- `off`: columns exist, nothing reads them.
- `shadow`: `evaluateCapability` runs, logs would-deny decisions as `partner.trust.capability_denied` audit events with `mode: shadow`, and allows. Gives a false-positive count before any customer is affected.
- `enforce`: denies.

Rollout order:

1. breeze-billing prerequisites (§3.5), verified in Stripe test mode. Independent of core; ships first.
2. Core migration (columns, enums, index) + `partnerTrust.ts` + chokepoint gates + email cards, in `shadow`. One release.
3. Read the shadow denials for 7 days. Target: every denial on an account later suspended; zero denials on accounts still active and paying after 14 days that did not also press Request review.
4. Flip `enforce` for **new partners only** (created after the flip). Existing partners stay `trusted` by column default.
5. Optional retro-backfill: `probation` for partners created in the last 14 days with no settled card payment. Reviewed SQL batch, not a migration.
6. Web queue page after enforce.

## 6. Failure modes and residual risk

| Scenario | What happens | Mitigation |
|---|---|---|
| MSP trials remote desktop on day 1 | Denied, banner with checklist | Request review → operator approves from the card in seconds; or auto-promotes 24 h after a card payment |
| MSP that will never pay by card (invoice, Pax8) | Never auto-promotes | Manual approve; the card carries the evidence |
| Free/community plan, real MSP | Gated until approved | Request review; operator approves in 10 s |
| Classification provider down | Class `unknown` → auto-promotion paused, nothing else changes | Static prefix fallback; shadow metric alerts when `unknown` rate > 20 % |
| Abuser waits 24 h and pays with a stolen non-Link card | Auto-promotes if the charge survives 24 h undisputed | 3DS shifts liability and blocks most stolen cards; `stage2.suspended_fingerprint_match`, the Stripe fraudulent-refund match, and the corroborated /24 rule still apply; promotion is reversible by one click |
| Abuser already has first-stage remote access to the victim (phone-guided AnyDesk) and uses Breeze as persistence | Enrollment succeeds (within quota), but no remote control or execution until promoted | Residual risk accepted; the payoff Breeze adds is withheld, and the evidence card shows a residential device under a hosting-ASN signup |
| Operator approves a scammer from a convincing card | Full capabilities | Same exposure as today, minus the 25-minute window; suspension path unchanged |

## 7. Testing

- Unit: `partnerTrust.test.ts` table-driven over (state × capability × command type) → decision; `isLifecycleCommand` allowlist pinned so a new command type fails the test until classified; promotion-rule matrix including `link` vs `card`, the 24 h clock, and `unknown` IP class.
- Chokepoint tests: `commandQueue` and `sendCommandToAgent` refuse gated types for a probation partner and pass lifecycle types; `createRemoteSession` refuses all types; ticket issuance re-checks trust.
- Route tests for installer distribution, Quick Support creation / download / redemption, third-party remote launch, and the enrollment counter (concurrent enrollments cannot exceed the cap; device delete does not reset it).
- Integration (real Postgres): partner in probation enrolls 5 devices, 6th denied; every gated route 403s; after `UPDATE partners SET trust_state='trusted'` the same requests succeed. RLS coverage suite unchanged (no new table); export-policy suite updated for the new columns.
- Web: `TrustProbationBanner` render + `runAction` handling of `TRUST_PROBATION`; E2E for request-review.
- Shadow-mode acceptance in prod is the 7-day metric in §5 step 3, not a test.

## 8. Decisions log

- **Gate capabilities, not signups.** Signups are free to the attacker; capabilities are the payoff.
- **Default deny in probation, no per-device exceptions.** The first draft allowed remote control to "self-enrolled" devices whose enrollment IP matched a console session IP. The quorum rejected it: IP co-location is not ownership (a scammer can have the victim sign up or log in from the victim's machine), and password login writes JWT/refresh state without a `sessions` row (`routes/auth/login.ts:639-734`, `services/session.ts:26-44`), so the check was also incomplete. Simpler and harder to bypass wins.
- **Gate at dispatch chokepoints, not routes.** Seventeen execution categories converge on `commandQueue` / `sendCommandToAgent` and session creation; per-route gates would have missed tunnels, third-party remote launch, automation webhooks, and software deployment.
- **Trust is a separate axis from lifecycle status.** Reusing `partners.status` would entangle billing activation, agent tenant gating, and cascade semantics that all key on it.
- **Default `trusted` on the column.** Grandfathering by default makes the migration risk-free; tightening existing accounts is a separate reviewed batch.
- **No age-only promotion.** Positive verification (settled 3DS card) or a human click.
- **IP is never sole evidence for restriction.** Corroborate with a non-IP axis; v6 at /64.
- **Denials are audit events, not abuse signals.** Signal persistence dedupes and stale-resolves.
- **No cross-region data plane.** Per the 2026-08-03 decision. Stripe is the only shared identity axis.
- **No auto-suspend.** Probation makes the human decision affordable, so the July "alert-first" posture is kept.
- **Async external IP classification, never on the registration path.**
- **Buttons stay visible in probation.** Hidden-on-failure UI is a documented anti-pattern here.

## 9. Operator decisions (2026-09-02)

1. **Default deny ships first; no self-device exception.** Revisit only with a stronger ownership proof than IP (one-time code shown in the console and typed into the installer), behind `PARTNER_TRUST_SELF_DEVICE_EXCEPTION`, if review requests show real conversion loss.
2. **Enrollment cap in probation: 5**, lifetime counter.
3. **3DS: already enforced in the Stripe dashboard** (Radar rule) as far as Stripe allows. The Checkout code still sets `request_three_d_secure: 'any'` explicitly so the behaviour does not depend on dashboard state. Note: both signup Checkout sessions in breeze-billing (`src/routes/checkout.ts:103` subscription mode, `src/routes/setupIntents.ts:55` setup mode) currently pass **no** `payment_method_types`, so Link is on by Stripe default; turning it off is a code change in both.
4. **Retro-backfill: yes.** Partners created in the last 14 days with no settled card payment move to `probation` at the `enforce` flip, as a reviewed SQL batch (not a migration), each with an evidence-card email so the operator can approve real trials the same day.
5. **Approval links require a fresh TOTP.** The signed one-time token opens a page that prompts for the authenticator code before acting; the token alone never performs the action.
