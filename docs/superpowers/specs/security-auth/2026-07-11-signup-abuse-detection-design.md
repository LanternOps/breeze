# Signup Abuse Detection — Design

**Date:** 2026-07-11
**Status:** Approved design, pre-implementation
**Owner scope:** hosted-SaaS operators (feature is equally useful to self-hosted multi-tenant deployments)

## Problem

Hosted Breeze accepts self-service partner signups. Abuse of those signups today is detected only by manual operator spot checks. Four threat classes, in priority order:

1. **Malicious RMM use** (top priority): a real, paying account deploying agents to machines the "partner" does not own — the tech-support-scammer pattern. Invisible to payment-fraud screening and to host-level IDS; the evidence lives in application data (enrollment geography, device shapes, remote-session behavior).
2. **Fraudulent signups**: card testing, fake partners, trial abuse.
3. **Droplet/host compromise**: intrusion on the hosting VMs themselves.
4. **Resource abuse**: accounts driving cost or hammering the API.

Response posture (operator decision): **alert-first**. Detections notify the platform operator with evidence; suspension remains a human decision via the existing `POST /admin/partners/:id/suspend-for-abuse` playbook. No auto-suspend in this phase.

## Prior verification (2026-07-10)

The signup gate chain was re-verified before this design was finalized:

- Hosted signups are created `status='pending'`; activation requires **both** `email_verified_at` and `payment_method_attached_at` via a single shared predicate (`services/partnerActivation.ts`), covering both orderings. The billing service independently gates its activation flip on email verification.
- A `pending` partner can log in but is blocked by `partnerGuard` from orgs, enrollment keys, installer tokens, scripts, and remote sessions; the agent plane (enrollment, agent WS, mTLS, API keys) independently requires the partner to be strictly `active`. No agent can enroll pre-activation. Suspension re-seals the same gates.
- Production containers were confirmed running with `IS_HOSTED=true` and `NODE_ENV=production`.
- **Finding:** a deploy-lag window (billing service deployed from a build predating its email-verification gate) allowed a small number of partners to activate with unverified emails between mid-May and mid-June 2026. The window is closed. Affected accounts were reviewed and deliberately grandfathered (see acknowledgment mechanism below). This incident motivates the standing invariant checks in this design.

Known residual gaps, addressed in scope:

- Admin `unsuspend` reinstates on `payment_method_attached_at` alone without re-checking `email_verified_at` — the only activation write that ignores the email gate. **Fix in scope** (fall back to `pending` when email is unverified).
- `createPartner` defaults omitted `status` to `'active'` for non-MCP callers. Safe today (single caller passes explicitly); **fix in scope** (require explicit status or default hosted-aware).
- The `IS_HOSTED` boot-refusal validation only runs when `NODE_ENV=production`. Not directly fixed; the consequence (unverified-active partners) is caught by the invariant sweep.

## Architecture overview

Five layers, each independently useful:

1. **Data capture** — persist the IPs and metadata the signals need (ships first; unrecorded signals are unrecoverable).
2. **Abuse-signals sweep** — an hourly BullMQ job computing deterministic per-partner signals into a new `partner_abuse_signals` table.
3. **Ops alerting** — a platform-operator notification primitive (Discord webhook / email), immediate alerts + weekly digest.
4. **Scheduled analyst** — a weekly operator-side Claude run that applies judgment to persisted signals. Reads only; never collects, never acts.
5. **Host hardening** — CrowdSec on the droplets. Wazuh explicitly deferred (its distinctive value — FIM/compliance — targets the least-likely threat at the highest operational cost).

LLM involvement is confined to layer 4. Layers 1–3 are deterministic SQL + arithmetic.

## Layer 1: Data capture

**New columns (all nullable; existing rows stay null):**

| Table | Column | Written where |
|---|---|---|
| `partners` | `signup_ip` (varchar 45) | `register-partner` handler, from trusted client IP |
| `partners` | `signup_user_agent` (text) | same |
| `devices` | `enrollment_ip` (varchar 45) | agent enrollment route (IP already computed for rate limiting) |

**Amendment 2026-07-11:** the originally proposed `devices.last_public_ip` is dropped — `devices.last_seen_ip` (varchar 45) already exists, updated on every authenticated agent request with audit-logged transitions. The sweep reads `last_seen_ip` for ongoing device geography. **No Go agent changes** either way.

**IP enrichment:** MaxMind GeoLite2 (City + ASN), resolved at **sweep time** only — never on hot paths. Databases are downloaded locally by a weekly refresh job using `MAXMIND_LICENSE_KEY`; lookups give country, city, ASN, and org name. Residential-vs-business classification is a best-effort keyword heuristic over ASN org names and is only ever one weighted signal among several.

**Stripe Radar:** `radar.early_fraud_warning.created` and `charge.dispute.created` webhooks belong to the platform Stripe account and therefore land in the **billing service (separate repo)**, which posts them to the same ops webhook (its own env config). Dependency noted; not in this repo's scope.

**Deliberately out of scope this phase:** captcha and disposable-email screening (prevention rather than detection; signup rate limiting already exists; easy independent follow-up).

## Layer 2: Abuse-signals sweep

**Job:** `abuse-signals-sweep`, BullMQ repeatable, hourly. Follows the `userRiskJobs` pattern: `runOutsideDbContext` → `withSystemDbAccessContext`, worker observability attached, no connections held across slow non-DB work. Job IDs use `-`, never `:`.

**Scope per run:** heuristic signals computed for partners created < 90 days ago or with activity since the last sweep; invariant checks run fleet-wide every pass (cheap queries). "Young account" in the signal definitions means partner age < 30 days at full weight, linearly decaying to zero weight at 90 days.

### Signals

**Invariants** (severity `alert`; should never fire):

| Key | Condition |
|---|---|
| `invariant.active_unverified_email` | `status='active' AND email_verified_at IS NULL`, excluding acknowledged signals |
| `invariant.active_no_payment` | `status='active' AND payment_method_attached_at IS NULL`, excluding acknowledged (comped accounts exist) |
| `invariant.inactive_partner_with_agents` | pending/suspended partner with enrolled devices or live agent connections |

**Malicious-RMM-use heuristics** (weighted, per-partner):

| Key | Signal |
|---|---|
| `rmm.geo_spread` | distinct countries across device public IPs on a young account |
| `rmm.signup_device_mismatch` | signup-IP country differs from dominant device country |
| `rmm.residential_ratio` | share of devices on eyeball/residential ASNs |
| `rmm.consumer_devices` | ratio of default hostnames (`DESKTOP-`/`LAPTOP-` pattern) and non-domain-joined Windows machines |
| `rmm.session_intensity` | remote sessions per device in first weeks; remote session into a device enrolled < 24h earlier weighs heaviest |
| `rmm.enrollment_velocity` | burst enrollments on young accounts |
| `rmm.enrollment_ip_spread` | devices enrolled from many distinct IPs relative to fleet size (amended from the original `rmm.token_spread`: bootstrap tokens do not record redeemer IPs; per-device `enrollment_ip` spread measures the same scatter. Upgraded to country-level in the geo PR) |

**Fraud / resource** (existing data):

| Key | Signal |
|---|---|
| `fraud.failed_login_cluster` | failed-login clusters from audit logs |
| `resource.enrollment_denied` | enrollment-denied / device-cap-hit counts |
| `resource.volume_outlier` | script-push and command volume outliers on young accounts |

**Scoring:** transparent weighted sum → `info` (recorded only) / `watch` (weekly digest) / `alert` (immediate notification). Weights and thresholds are constants in one file **with env-var overrides** via a single JSON map, `ABUSE_SIGNAL_OVERRIDES` (e.g. `{"rmm.geo_spread.alert_countries": 5}`), validated at boot with unknown keys warned and ignored, so production values can diverge from the published defaults. Rationale: the repo is public; adversaries can read default thresholds but not the deployed ones.

**Storage:** new table `partner_abuse_signals`:

- `id`, `partner_id` (FK), `signal_key`, `severity`, `score`, `evidence` (jsonb — the actual IPs/hostnames/counts so the operator's decision needs no re-query), `computed_at`, `resolved_at`, `acknowledged_at`, `acknowledged_by`, `delivered_at`.
- **Acknowledgment replaces code allowlists.** Grandfathered/comped accounts are handled by setting `acknowledged_at`/`acknowledged_by` on the fired signal row — direct SQL in this phase (a platform-admin ack endpoint is a possible follow-up, not in scope). Acknowledged signals are suppressed unless evidence materially changes. No tenant identifiers ever appear in code or config.
- **RLS: deny-all to app traffic.** This table is *about* partners, not *for* them. RLS enabled + forced with policies passing only for system context (and platform-admin, if the ack endpoint is built). It must NOT use `breeze_has_partner_access`. Registered in the RLS contract test as an intentional special case; integration test proves a partner-scoped token reads zero rows and a cross-tenant forge fails.

**Dedup:** state-based. Notification on first firing or severity escalation only; hourly re-computation updates evidence without re-alerting. `delivered_at` set only on successful send, so failed deliveries retry next sweep.

**Scope boundary:** heuristic signals only cover partners that are young (< 90 days old), recently enrolling (device enrolled in the last 2 hours), or currently flagged (have an open signal row, so they stay evaluated to real resolution). Steady-state resource abuse by older accounts with no recent enrollment activity — e.g. a partner past the 90-day window running an established fleet abnormally hard — falls outside the sweep's scope in this phase. That gap is covered by the Prometheus/Grafana stack and the scheduled-analyst layer (Layer 4), not by this hourly job. This is a deliberate boundary, not an oversight; revisit it alongside the geo PR when `rmm.geo_spread`/`rmm.signup_device_mismatch` land and the scope question gets re-examined anyway.

## Layer 3: Ops alerting

**New `opsAlerts` service** — the platform-operator channel (all existing notification paths are tenant-facing). Env-only config, no infrastructure details in code:

- `OPS_ALERT_WEBHOOK_URL` — Discord-format webhook.
- `OPS_ALERT_EMAIL` — optional second channel via the existing email service.
- Both optional: unset → feature logs a warning and no-ops. No new boot-refusal requirements.

**Immediate alerts** (`alert` severity + invariants): one message per partner-signal — partner name + short id + region tag (each regional deployment posts its own, same channel), fired signals + score, inline evidence, pointer to the suspend playbook with partner id pre-filled.

**Weekly digest** (Monday): `watch`-tier signals, week-over-week trends, new-partner count, and an explicit "invariants checked and clean" line — silence must mean *verified nothing*, not *nothing ran*.

**Delivery semantics:** send failure never fails the sweep (log + Sentry + retry next pass). Sweep exports Prometheus counters (signals fired by severity, sweep duration) — a flatlined metric in the existing Grafana stack is the dead-man's switch.

## Layer 4: Scheduled analyst (operator-side, not product code)

Weekly Claude Code scheduled run on the operator's workstation (prod access rides the operator's tailnet; posture-gated SSH may require an interactive re-auth). Playbook document lives in the gitignored `internal/` directory because it references production access paths.

Role boundary: **code decides what is anomalous; the analyst decides what it means.** Each run: pull open watch/alert signals + the week's new partners (read-only SQL), build the holistic picture per flagged partner (name-vs-usage coherence, org/device naming, timing patterns), cross-check payment posture, and deliver per-partner verdicts — *clear / keep watching / suspend candidate with evidence*. Judgment rules encoded in the playbook: distinct-card cardinality beats failure count; out-of-band contact is a signal, not proof; a Radar early-fraud warning is dispositive. The run never mutates anything.

Quarterly deep pass: re-verify activation invariants end-to-end (gate order in code, live container env, unverified-active query), review acknowledged signals, and re-fit signal weights against what real incidents taught.

## Layer 5: Host hardening (ops task, minimal repo footprint)

Droplets already sit behind a cloud firewall (SSH closed to a single allowlisted IP; only the reverse proxy exposed). Remaining edge = public HTTPS.

- **CrowdSec** on both droplets: reverse-proxy log parser + firewall bouncer; community blocklists. Catches scanner floods and credential stuffing at the edge for a few hundred MB of RAM.
- Hygiene check: unattended security upgrades, auditd.
- **Wazuh deferred, not rejected** — revisit if FIM/compliance-evidence needs arise; nothing here overlaps with it.

## Testing

- **Unit (Vitest, Drizzle mocks):** each signal computation; scoring thresholds and severity transitions; dedup state machine (fire → escalate → resolve → no re-alert); ops-alert payloads; delivery-failure leaves `delivered_at` null.
- **Integration (real Postgres):** RLS deny-all on `partner_abuse_signals` (cross-tenant forge → RLS violation; partner token → zero rows; system context → reads) + registration in the RLS coverage contract test; invariant queries against seeded good/bad fixtures; migration idempotency (re-apply is a no-op).
- **Live validation:** seed a synthetic scattered-devices/instant-remote-session partner in a worktree stack; observe the end-to-end alert before prod deploy.

Migrations follow the standard rules: `YYYY-MM-DD-<slug>.sql`, idempotent, RLS policies in the same migration that creates the table, no inner transactions.

## Rollout

| # | Deliverable | Notes |
|---|---|---|
| 1 | Data-capture PR | migrations + write paths; ship first so data accrues |
| 2 | Sweep PR | signals table, hourly job, invariants + non-geo heuristics (work on existing data), opsAlerts, digest, unsuspend/createPartner hardening fixes |
| 3 | Geo PR | GeoLite2 refresh job; geography/ASN signals switch on |
| 4 | Billing-service PR (separate repo) | Radar EFW + dispute → ops webhook |
| 5 | Ops | CrowdSec on droplets; weekly analyst schedule + `internal/` playbook; env vars added to droplet `.env` **and** compose `environment:` mappings |

New env vars (`OPS_ALERT_WEBHOOK_URL`, `OPS_ALERT_EMAIL`, `MAXMIND_LICENSE_KEY`, threshold overrides) are all optional with logged warnings when unset.

## Decisions log

- Alert-first; no auto-suspend (operator decision, 2026-07-10).
- Wazuh deferred in favor of CrowdSec; malicious RMM use is invisible at host level.
- Grandfathered/comped accounts handled via signal acknowledgment in DB, never code allowlists (public repo; no tenant identifiers in git).
- Signal thresholds env-overridable so deployed values can diverge from published defaults.
- Everything ships in the public repo; only the analyst playbook (`internal/`) and env values stay private.
- Captcha/disposable-email screening deferred as independent follow-up.
