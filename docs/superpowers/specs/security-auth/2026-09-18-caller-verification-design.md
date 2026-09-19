# Caller verification (anti-vishing) — design

Status: draft for review · Owner: Todd · Date: 2026-09-18

## Problem

Every named help-desk breach since 2023 (MGM, Caesars, M&S, Co-op) began with
a phone call to a service desk asking for a password or MFA reset. Trained
listeners cannot distinguish current voice clones from real voices, so nothing
that travels inside the voice channel is evidence of identity: caller ID, the
voice, employee ID, manager's name, date of birth, or knowledge of a ticket
number. The only defence that holds is moving the proof onto a channel the
caller does not control and making the risky action refuse without it.

Breeze has the primitives and none of the orchestration:

- The agent and helper already ship a branded, correlated, always-on-top
  prompt for remote-session consent (`agent/internal/heartbeat/consent_gate.go`,
  `apps/helper/src-tauri/src/ipc/desktop.rs`) that carries technician name,
  org name and a timeout.
- Twilio SMS and transactional email exist (`services/twilio.ts`, `services/email.ts`).
- Customer-side people are `contacts` rows with `email`, `phone`, `mobile`, and
  tickets already carry `requesterContactId`.
- `m365_reset_password` and `m365_disable_user` are exactly the vishing payload,
  and today nothing in their path asks who requested the change.

## Goals

1. A technician on the phone can, in one click from a ticket, a contact, or a
   device, challenge the caller on an out-of-band channel and see a pass/fail
   inside two minutes.
2. The caller can confirm the technician is genuine (reverse verification) with
   no extra surface.
3. Risky identity actions refuse unless a fresh verification of sufficient
   assurance exists for the subject. Enforcement is server-side, at the point
   the action is released and again where the Graph call is made.
4. Every attempt, pass, fail, and "that is not me" is on the ticket timeline and
   in the tamper-evident audit log; a "not me" opens a security incident and
   cancels anything pending for that person.
5. Partner-wide policy decides which actions need which assurance and for how
   long a verification stays fresh. No policy row means the gate is **on** with
   defaults, never off.

## Non-goals (v1)

- Entra Temporary Access Pass, Verified ID / Face Check, Microsoft Authenticator
  push, Teams messages. No new Graph scopes.
- Telephony or caller-ID integration.
- A contact-to-device link table. v1 picks the device per verification.
- Customer portal passkeys or TOTP.
- Gating Google Workspace or on-prem AD resets. The gate is generic; only the
  two M365 tools are wired in v1.
- Detecting resets performed outside Breeze (Microsoft admin portal, a script
  on a DC). The gate is a workflow control inside Breeze, not an enforcement
  boundary around the tenant. A detector that flags Entra password-change
  events with no matching fresh verification is the honest complement and a
  follow-up.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | New table `caller_verifications` keyed on `contacts`. Not a contact axis on `approval_requests`. | `approval_requests` is a technician-assurance ledger (`user_id NOT NULL`, device-bound factor enum, intent CAS semantics). Different subject, different factors, no fan-out. |
| D2 | One "challenge card" for every method: partner branding, technician name, a reverse code, three candidate numbers of which one matches what the technician sees, and "This is not me". The caller never reads a code back. | A read-back OTP is relayable ("read me the code you just got"). A pick-the-number card is not, because the attacker never sees the choices. Number matching also stops the real user approving by reflex. |
| D3 | The workstation tier is a **new** agent command `caller_verify` on the consent-gate seam, not `notify_user`. | `notify_user` as shipped cannot render it: Windows builds a fixed two-button `MessageBoxTimeoutW` (`userhelper/notify_prompt_windows.go`), macOS caps at three buttons, Linux returns no decision, and the agent waits 10 s without forwarding a timeout (`heartbeat/handlers_user.go`). The consent gate already renders a branded Tauri window with technician and org name and a correlated timeout on all three platforms. Cost: an agent and helper release. |
| D4 | Assurance tiers: 3 workstation, 2 SMS or email link to an **established** destination, 1 callback attestation or a link to a non-established destination. Default gate is tier ≥ 2 for both M365 actions. Email never counts toward resetting the mailbox it was sent to. | Workstation proves possession of the enrolled device session. A link proves possession of the phone or mailbox of record, but only if that record predates the call. Verifying by email and then resetting that same mailbox is circular: a BEC attacker who owns the mailbox passes trivially. |
| D5 | Gate lives in `actionIntents/revalidateRelease.ts`, with a UX pre-check at intent creation and defense-in-depth checks inside both Graph write paths. | `revalidateRelease` is already the single fail-closed check both release paths run (durable worker and inline chat), and freshness is a release-time property. The two Graph paths (`m365DirectGraph.invokeDirect` and `m365ControlPlane/writeActionService.executeM365WriteActionByOrg`) are re-checked so that any future caller that skips the intent layer still refuses. A contract test pins all three. |
| D6 | Policy is a dedicated dual-ownership table `caller_verification_policies` (`org_id` XOR `partner_id`), resolved org → partner → built-in defaults. Not a config-policy feature link. | Every config-policy resolver in `services/featureConfigResolver.ts` starts from a device hierarchy. This feature is scoped to an org and a contact and often has no device. Config policies would cost the integration and still need a new resolver, and "no assignment" would read as "gate off". |
| D7 | No `ticket_id` column. The ticket badge derives from the ticket's `requesterContactId`; the timeline gets system comments. | A table carrying `device_id`, `ticket_id` and `org_id` would be the first child selected by both org-move walkers, the AB-BA deadlock class #4657 fixed (`services/ticketOrgMoveLockOrder.ts`). Poor trade for a display badge. |
| D8 | "Not me" opens an `incidents` row (p2), cancels pending action intents for the subject, puts the contact in a cooling-off state, and notifies the partner. | `alerts.device_id` is `NOT NULL`, so alerts cannot represent a device-less rejection. Incidents are device-less and drive the incident-response UI. A vishing campaign hits many orgs of one MSP, so the partner hears about it, not just the org's ticket. |
| D9 | Delivery is asynchronous: start returns 202 and the UI polls. | Holding a request transaction across a two-minute agent round trip pins a pooled connection (the #1105 hang). The agent-await helper is api-role-affine and in-process, so the result is consumed by the WebSocket command-result handler, not by a waiting request. |
| D10 | Public challenge page `/verify/:token`, patterned on Quick Support. | `routes/supportPublic.ts` already solves the same shape: token is the credential, tight `withSystemDbAccessContext`, per-IP limits, a two-tier miss budget, one atomic single-use transition. |

Advisor quorum: Codex was out of usage on 2026-09-18, so the independent
opinion came from a fresh Claude reviewer with read-only repo access. It
overturned the first draft on D3, D5, D6, D7 and D8; each claim it made was
re-read in the source before adoption.

## Data model

### `caller_verifications` (tenancy shape 1, direct `org_id`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid not null | RLS `breeze_has_org_access(org_id)` |
| `contact_id` | uuid not null | composite FK `(contact_id, org_id) → contacts(id, org_id)` **DEFERRABLE INITIALLY IMMEDIATE**, `ON DELETE CASCADE` |
| `initiated_by_user_id` | uuid not null | technician; FK `users(id)`, `ON DELETE SET NULL` is wrong for an audit row, so `RESTRICT` plus `technician_label` snapshot |
| `technician_label` | varchar(255) not null | display name frozen at creation |
| `method` | enum `caller_verification_method` | `workstation`, `sms`, `email`, `callback_attestation` |
| `status` | enum `caller_verification_status` | `pending`, `verified`, `rejected_by_user`, `wrong_choice`, `expired`, `undeliverable`, `cancelled` |
| `tier` | smallint not null | frozen at creation by the rules in "Tiers" |
| `match_value` | char(2) not null | the number the technician sees |
| `decoy_values` | char(2)[] not null | two other candidates, fixed so the card is stable across reloads |
| `reverse_code` | char(4) not null | technician reads it aloud; the card shows it |
| `challenge_token_hash` | char(64) null | sha256 of a 32-byte link token; link methods only; unique partial index |
| `destination_hash` | char(64) null | sha256 of the normalised address or E.164 number; lets the gate apply the "not the mailbox being reset" rule without storing the address |
| `destination_redacted` | varchar(64) null | `+44 •••• ••12`, `a•••@acme.com` |
| `destination_established` | boolean not null | snapshot of the establishment rule at creation |
| `device_id` | uuid null | workstation only. **No FK**: an audit snapshot, so device deletion or org move leaves it. Paired with `device_hostname` |
| `device_hostname` | varchar(255) null | snapshot |
| `session_username` | varchar(255) null | the OS user the prompt was sent to; the agent must target this user explicitly and fail if there is no such session |
| `agent_command_id` | uuid null | correlates the WS command result back to this row |
| `attempt_no` | smallint not null | 1-based per contact within the attempt window; drives the cap |
| `expires_at` | timestamptz not null | workstation: `now() + workstationTimeoutSeconds`; links: `+ 10 min`; attestation: `now()` |
| `decided_at` | timestamptz null | |
| `decided_from_ip` | inet null | link methods |
| `attestation_note` | text null | `callback_attestation` only |
| `created_at` | timestamptz not null | |

Indexes: `(org_id, contact_id, created_at desc)`, unique partial on
`challenge_token_hash`, partial on `agent_command_id`.

No json/jsonb/bytea. Export-policy classification: all `included` except
`challenge_token_hash`, `destination_hash`, `match_value`, `decoy_values`,
`reverse_code` → `excludedSensitive`.

Registration in the same PR as the migration:

- RLS enabled, forced, `breeze_has_org_access(org_id)` plus system scope. Shape
  1 is auto-discovered by the coverage test.
- `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts`, alphabetical.
  `caller_verifications` < `contacts`, child before parent, correct.
- `CORE_TENANT_EXPORT_POLICY` as above.
- `device_id` has no FK and is not rewritten on device org-move. If
  `cascadeDelete.test.ts` flags the column name, the row is added to that
  test's documented exemption list with this rationale, not to the delete list
  (deleting verification history when a device is retired would destroy the
  audit trail).
- No ticket axis, no `BEFORE` trigger.

### `caller_verification_policies` (dual ownership, #2135 playbook)

| Column | Notes |
|---|---|
| `id`, `org_id` null, `partner_id` null | `caller_verification_policies_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`; unique on each owner (at most one row per owner) |
| `required_tier_reset_password` smallint | default 2, 0..3; `0` disables the gate for that action |
| `required_tier_disable_user` smallint | default 2 |
| `verification_ttl_minutes` int | default 30, 5..240 |
| `allowed_methods` text[] | default all four |
| `workstation_timeout_seconds` int | default 120, 30..300 |
| `destination_min_age_days` int | default 7, 0..90; the establishment window |
| `require_ticket` boolean | default false |
| `allow_unmatched_subject` boolean | default false: fail closed when the target UPN maps to no contact |
| `max_attempts_per_hour` smallint | default 3 per contact |
| `cooling_off_hours` int | default 24 after a rejection |
| `created_at`, `updated_at`, `updated_by_user_id` | |

RLS: one dual-axis `FOR ALL` policy (system OR org access OR partner access)
plus the separate `FOR SELECT`-only partner-wide branch
`USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`
(template `2026-10-05-110000-config-policy-partner-wide-select.sql`). Registered
in `DUAL_AXIS_TENANT_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`,
`CORE_TENANT_EXPORT_POLICY`. Writes gated on `canManagePartnerWidePolicies`
for partner rows; org rows need `settings:write` on that org. Resolution:
org row → partner row → built-in defaults, field by field is **not** merged;
the closest row wins whole.

Lowering any tier, raising `destination_min_age_days` to 0, or enabling
`allow_unmatched_subject` writes `audit_logs` action
`caller_verification.policy_weakened` with before and after values.

## Tiers and the establishment rule

| Method | Tier | Condition |
|---|---|---|
| workstation | 3 | prompt delivered to the explicit `session_username` on the chosen device and answered |
| sms | 2 | `contacts.mobile` is established |
| email | 2 | `contacts.email` is established, **and** the gate additionally refuses to count it for an M365 action whose target UPN hashes equal to `destination_hash` |
| sms / email | 1 | destination not established |
| callback_attestation | 1 | always; the technician records they called the number of record |

A destination is **established** when the contact's audit trail
(`services/contacts/audit.ts`) shows the value unchanged for at least
`destination_min_age_days` **and** the contact was created or last edited by a
technician. Rows auto-created by inbound email
(`services/inboundEmail/resolveOrg.ts`, `userId: null`) or by the AI with no
human edit since are not established. This closes the "email the ticket
mailbox, become a contact, verify yourself" path the reviewer found.

The modal shows the computed tier per method before the technician picks, with
the reason when it is lower than expected ("mobile updated 2 days ago").

## Service layer

`apps/api/src/services/callerVerification/`

- `service.ts` — `start`, `cancel`, `attest`, `get`, `listForContact`,
  `freshForContact`. `start` checks policy, the attempt cap, the cooling-off
  state, and method availability; computes the tier; generates `match_value`,
  two distinct decoys, `reverse_code`, and for links a 32-byte token whose
  hash is stored; inserts the row; writes `caller_verification.started` to the
  audit log and, when the modal was opened from a ticket, a `system` ticket
  comment plus ticket event and outbox row. Delivery starts **after commit**,
  outside the request context.
- `deliverers/workstation.ts` — sends agent command `caller_verify` with
  `{verificationId, username, technicianName, orgName, reverseCode,
  choices:[..3 shuffled..], timeoutMs}` through `dispatchCommandToAgent`
  (`agentCommandRelay.ts`), records `agent_command_id`, and returns. Partner
  trust: `caller_verify` is added to the capability allowlist in
  `services/partnerTrust.ts` next to `notify_user`, and `evaluateCapability`
  is consulted before offering the method. The result arrives in
  `routes/agentWs.ts` `processCommandResult`, which calls
  `callerVerification.onCommandResult(commandId, result)`. Mapping:
  `delivered=false` or no session for that username → `undeliverable`;
  helper timeout → `expired`; chosen == `match_value` → `verified`; a decoy →
  `wrong_choice`; "This is not me" → `rejected_by_user`.
- `deliverers/link.ts` — builds `https://<partner app url>/verify/<token>`;
  SMS via `TwilioService.sendSmsMessage` (not Twilio Verify, an OTP product),
  email via the branded layout. Send failure → `undeliverable`.
- `gate.ts` — `requireCallerVerification({ orgId, action, subject: { upn?,
  entraOid? } })`. Policy tier for `action`; `0` → pass. Resolve contact by
  `contact_external_links (system='entra')` then case-insensitive
  `contacts.email = upn`. No contact and `allow_unmatched_subject=false` →
  refuse `subject_unmatched`. Otherwise the newest row with
  `status='verified'`, `tier >= required`, `decided_at > now() - ttl`, and not
  (`method='email'` and `destination_hash = sha256(lower(upn))`). None →
  refuse `no_fresh_verification` with the newest attempt's status. Contact in
  cooling-off → refuse `contact_cooling_off`. The refusal is a typed
  `CallerVerificationRequiredError { orgId, contactId?, action, requiredTier,
  reason, latest? }`.
- `rejection.ts` — on `rejected_by_user`: insert `incidents` (p2, title
  "Caller verification rejected by <contact name>", `sourceType =
  'caller_verification'`, `sourceRef = id`); cancel every pending
  `action_intents` row whose subject resolves to this contact
  (`cancelActionIntent`, prior art in the approvals report-suspicious path);
  set the contact's cooling-off until `now() + cooling_off_hours` (a row in
  `caller_verifications` with status `rejected_by_user` is the state; no new
  contact column); audit `caller_verification.rejected`; ticket comment; in-app
  and email notification to the org's security recipients **and** the
  partner's. During cooling-off the gate refuses and `start` requires a user
  with `settings:write` on the org to override, which is itself audited.
- `wrong_choice` is audited and shown; no incident. It counts toward
  `max_attempts_per_hour`, so three misreads lock the contact for the hour.

Rate limits (Redis `rateLimiter`): 10 starts per technician per 10 minutes
plus the per-contact attempt cap above. Public route: 30 requests per IP per
minute and the Quick Support two-tier miss budget
(`services/supportCodeMissBudget.ts`) for unknown tokens.

## Agent and helper change (workstation tier)

New device command `caller_verify`, handled in `agent/internal/heartbeat/`
beside `consent_gate.go`. It resolves the session for the explicit `username`
through the session broker (never `PreferredSessionWithScope`; an RDS host or a
technician's own remote session must not receive someone else's challenge),
sends a new IPC message `caller_verify_request` to the user helper with the
same correlation and timeout pattern as `consent_request`, and returns
`{delivered, choice, uid, username}` in the command result's stdout JSON.
Absent session → error result `no_session_for_user`.

Helper (`apps/helper/src-tauri/src/ipc/`): a `CallerVerifyWindow` beside
`ConsentDialog.tsx`: always on top, partner logo and name, "<technician> from
<org> is on the phone with you", the reverse code in large type, three number
buttons, "This is not me", a countdown. Old helpers that do not understand the
message reply with an unknown-type error, which the agent maps to
`undeliverable`; the modal then tells the technician the helper needs
updating.

Commands doc `apps/docs/src/content/docs/agents/commands.mdx` gains the entry.
This wave ships in an agent release, so the workstation tier is unavailable
to a fleet until it has promoted.

## Gate wiring

1. `services/actionIntents/revalidateRelease.ts`: for tool names
   `m365_reset_password` and `m365_disable_user`, call the gate with the
   intent's org and target user; a refusal is a new `errorCode`
   `caller_verification_required` in the same shape as the existing failures.
   Both release paths already run this function.
2. `services/actionIntents/intentService.ts` `createActionIntent`: the same
   check for UX only, so the technician sees "Start verification" before
   waiting on approval. Not authoritative.
3. Defense in depth: `m365DirectGraph.invokeDirect` cases `disable_user` and
   `reset_user_password`, and `writeActionService.executeM365WriteActionByOrg`
   actions `m365.user.disable` and `m365.user.reset_password`, each call the
   gate before the Graph request. The plan verifies whether
   `m365_disable_user` can execute inline without an intent (the secret-bearing
   fail-closed at `aiAgentSdkTools.ts` covers reset only); if it can, this
   layer is what protects it.
4. Contract test `callerVerificationGate.contract.test.ts` reads the three
   source files and fails if any named case no longer references
   `requireCallerVerification`.

The AI tool layer catches the typed refusal and returns a structured error with
`requiresCallerVerification: {contactId, requiredTier, reason}` so the chat
renders the modal, not prose. The intent release worker treats it as a
terminal, non-retryable release failure carrying the same payload.

## API

Authenticated routes are org-scoped; `contacts:write` to start, cancel or
attest, `contacts:read` to view.

| Route | Notes |
|---|---|
| `POST /orgs/:orgId/caller-verifications` | `{ contactId, method, deviceId?, username?, ticketId?, note? }` → 202 with the row. `matchValue`, `decoyValues` and `reverseCode` are returned only to the initiating technician (creator check on every read); others see status. `ticketId` is used only to write the timeline comment, never stored. |
| `GET /orgs/:orgId/caller-verifications/:id` | polled every 2 s while pending. |
| `POST /orgs/:orgId/caller-verifications/:id/cancel` | pending → cancelled. |
| `GET /orgs/:orgId/contacts/:contactId/caller-verifications` | history, newest first, 50 max; includes `coolingOffUntil`. |
| `GET /orgs/:orgId/contacts/:contactId/caller-verifications/methods` | per-method availability and computed tier with reasons; feeds the modal. |
| `GET /orgs/:orgId/tickets/:ticketId/caller-verification` | freshest row for the requester contact plus `isFresh` per policy; feeds the badge. |
| `GET /orgs/:orgId/caller-verifications/device-suggestions?contactId=` | online devices whose `last_user` matches the contact's email local-part or name tokens, with the matched username pre-filled. |
| `GET/PUT /orgs/:orgId/caller-verification-policy`, `GET/PUT /partner/caller-verification-policy` | policy rows; `PUT` upserts. |
| `GET /verify/:token` (public) | JSON for the card: branding, technician label, contact first name, reverse code, the three candidates in stored order, expiry. Unknown, spent or expired → one generic "expired" response. `Cache-Control: no-store, private`. |
| `POST /verify/:token` (public) | `{ choice: '<2 digits>' | 'not_me' }`. One atomic `UPDATE … WHERE status='pending' AND expires_at > now()` CAS. |

Public handlers wrap only the token lookup and the CAS in
`withSystemDbAccessContext` and get a live-DB integration test. Page rendering
is an Astro page in `apps/web` at `/verify/[token]` calling the JSON route,
consistent with the Quick Support landing page.

## Web UI

- **Entry points**: "Verify caller" on the ticket header, on contact rows and
  the contact drawer, and on the device page header (pre-selects workstation
  and that device, technician picks the contact and confirms the username).
- **Modal**: step 1, method cards with computed tier and greyed reasons; step
  2, match number and reverse code in very large type with the script line:
  "I've sent a prompt to your screen. It shows a code, 7 3 1 9, that proves
  I'm from Acme IT. Please tap the number **42**." Live status; `verified`
  green; `wrong_choice` retry with the remaining attempts; `rejected_by_user`
  red panel linking to the incident; `undeliverable` with the concrete reason
  (no session for that user, helper outdated, SMS failed).
- **Ticket badge**: "Caller verified · SMS · 12 min ago" while fresh, grey
  "expired" after. Timeline shows system comments.
- **Contact drawer**: history and cooling-off state.
- **Settings**: policy form under partner settings and under org settings
  ("inherits partner policy" when no org row), with a persistent warning when
  any tier is 0.
- **AI chat**: a refusal with `requiresCallerVerification` renders the modal
  inline.
- All new strings through i18n with real translations in every shipped locale.

## Threats this still does not stop

1. **Compromised endpoint or phone.** If the attacker already has the user's
   desktop session or SIM, tiers 2 and 3 pass. This is the ceiling for every
   product in the space.
2. **Coached real user.** The attacker keeps the real user on a parallel call:
   "IT is about to send a prompt, tap 42." They can only know 42 if they are
   the one on the phone with the technician, which is the case being defended.
   The card's copy says "only tap if you are on the phone with <technician>
   right now" and names the technician.
3. **Slow-burn contact planting.** An attacker who plants a contact and waits
   out `destination_min_age_days` gets tier 2 by email or SMS. The
   technician-edit requirement raises the cost; the M365 same-mailbox rule
   removes the most valuable target. Partners with a stricter posture set the
   required tier to 3.
4. **Out-of-band execution.** See non-goals.
5. **Policy weakening.** Audited, warned in the UI, and partner-only for
   partner rows.

## Testing

- Unit: state machine transitions; decoy distinctness; token hashing; tier
  computation including establishment and the same-mailbox rule; gate
  resolution order and each refusal reason; policy resolution and defaults;
  deliverer result mapping; rejection fan-out (incident, intent cancel,
  cooling-off, notifications).
- Contract: gate references in the three files; RLS coverage (both tables);
  org cascade; export policy; dual-axis select branch for the policy table;
  partner-wide XOR.
- Integration (live DB): cross-org forge → 42501 on both tables; public route
  under system context; concurrent `POST /verify/:token` CAS; org merge with
  a pending verification (deferrable FK); intent release refused without a
  fresh verification and allowed with one.
- Agent: `go test -race` for `caller_verify` session targeting (explicit
  username, missing session, old helper reply). Helper: window renders the
  three buttons and reports the choice.
- Web: modal availability and tier display, badge freshness, policy forms,
  locale parity.
- Manual, pre-release, on the lab rigs: workstation prompt on Windows 11 and
  macOS; SMS to a real handset; "not me" ends in an incident and cancels a
  pending intent.

## Waves

| Wave | Scope |
|---|---|
| W01 | Both tables, migrations, registrations, policy resolver and defaults, service state machine, tier and establishment rules, gate service, authenticated API, callback attestation method, audit and ticket timeline. Ships the backend end to end on the weakest method. |
| W02 | Agent `caller_verify` command, helper window, WS result hook, workstation deliverer, device suggestions, partner-trust allowlist, commands doc. Needs an agent release. |
| W03 | SMS and email deliverers, public JSON route, Astro challenge page, rate limits and miss budget. |
| W04 | Web: modal, entry points, ticket badge, contact history, policy forms, AI chat refusal rendering, i18n. Explicit mount task per page. |
| W05 | Gate wired into `revalidateRelease`, intent-creation pre-check, both Graph paths, contract test; rejection fan-out (incident, intent cancel, cooling-off, partner notification); docs and release notes. Lands last so W01–W04 ship without changing any existing M365 flow. |

Feature-lifecycle registration happens when the plans are written.

## Review notes (independent reviewer, 2026-09-18)

- R1 Workstation tier cannot be built on `notify_user`: two buttons on
  Windows, three on macOS, none on Linux, 10 s wait with no forwarded timeout.
  Adopted: D3.
- R2 Two disjoint Graph executors; the shared fail-closed seam is
  `revalidateRelease.ts`. Adopted: D5, with Graph-path defense in depth kept.
- R3 No org-scoped config-policy resolver exists; absent assignment would read
  as gate off. Adopted: D6.
- R4 `device_id + ticket_id + org_id` would be the first dual-axis org-move
  child (#4657 deadlock class). Adopted: D7, and `device_id` demoted to a
  snapshot without FK.
- R5 `alerts.device_id` is NOT NULL, so no alert helper works for device-less
  rejections. Adopted: incidents, D8.
- R6 Inbound email auto-creates contacts with no verification; email-to-mailbox
  before resetting that mailbox is circular; no attempt cap. Adopted: the
  establishment rule, the same-mailbox exclusion, `max_attempts_per_hour`,
  cooling-off.
- R7 Always target an explicit username; never the preferred session. Adopted.
- R8 Emit ticket event and outbox row with the system comment; record the
  end-user decision principal in audit `details` rather than inventing an
  actor. Adopted.
- R9 `sendCommandToAgentAwaitResult` is api-role-affine and in-process; do not
  await inside a request. Adopted: D9, result consumed in `processCommandResult`.

## Open questions for Todd

None blocking. Defaults chosen: gate tier 2, TTL 30 minutes, establishment
window 7 days, 3 attempts per hour, 24 hour cooling-off, ticket not required,
fail closed on unmatched subjects. All are policy knobs.
