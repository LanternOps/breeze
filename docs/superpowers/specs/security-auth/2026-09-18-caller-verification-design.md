# Caller verification (anti-vishing) — design

Status: draft v2 for review · Owner: Todd · Date: 2026-09-18 · Revised: 2026-09-19
(folds in the Codex gpt-6-astra xhigh review, see "Review notes")

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
2. The caller can confirm what is being requested and by whom (request
   confirmation). See D2 for what this does and does not prove.
3. Risky identity actions refuse unless a fresh, **single-use** verification of
   sufficient assurance exists for the **canonical** subject, bound to the
   requesting technician and to the action. Enforcement is server-side, at the
   point the action is released and again at every place a Graph mutation is
   issued (three backends, D5).
4. Every attempt, pass, fail, and "that is not me" is on the ticket timeline and
   in the tamper-evident audit log; a "not me" opens a security incident,
   fences the subject, and cancels everything for that person that has not yet
   been dispatched.
5. Partner-wide policy is a **floor**: it decides which actions need which
   assurance and how long a verification stays fresh, and an org row can only
   tighten it. No policy row means the gate is **on** with defaults, never off.
6. Nothing user-visible ships before the gate and the rejection path are live.

## Non-goals (v1)

- Entra Temporary Access Pass, Verified ID / Face Check, Microsoft Authenticator
  push, Teams messages. No new Graph scopes beyond what the directory sync
  already holds.
- Telephony or caller-ID integration.
- A general contact-to-device link table. v1 has a narrow contact-to-principal
  binding (D11) for the workstation tier only.
- Customer portal passkeys or TOTP.
- Gating Google Workspace or on-prem AD resets. The gate is generic; only the
  two M365 tools are wired in v1.
- Detecting resets performed outside Breeze (Microsoft admin portal, a script
  on a DC). The gate is a workflow control inside Breeze, not an enforcement
  boundary around the tenant. A detector that flags Entra password-change
  events with no matching fresh verification is the honest complement and a
  follow-up.
- Non-console sessions on RDS / multi-session hosts for the workstation tier.
  The Tauri helper is console-bound (`sessionbroker/broker.go` ~L2685); those
  sessions report `unavailable` in v1. A native per-session prompt is a
  follow-up.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | New table `caller_verifications` keyed on `contacts`. Not a contact axis on `approval_requests`. | `approval_requests` is a technician-assurance ledger (`user_id NOT NULL`, device-bound factor enum, intent CAS semantics). Different subject, different factors, no fan-out. |
| D2 | One "challenge card" for every method: partner branding, technician name, **the exact action and target** ("reset the password for j.smith@acme.com"), a reverse code, three candidate numbers of which one matches what the technician sees, and "This is not me". The caller never reads a code back. **Number matching is request confirmation, not proof of the technician's identity and not relay-proof.** | A read-back OTP is relayable outright. Number matching removes reflex approval and forces the user to see what is being requested. It does **not** stop an attacker who is on the phone with the real technician from repeating the number to the victim on a parallel call (threat 2); the card therefore names the technician, the action and the target, and the script never claims the code "proves" anything. A branded page reached from a link the caller supplied is not an independent trust anchor either; the strong reverse check is the caller ringing the MSP back on a number they already hold, and the card says so. |
| D3 | The workstation tier is a **new** agent command `caller_verify` on the consent-gate seam, not `notify_user`. | `notify_user` as shipped cannot render it: Windows builds a fixed two-button `MessageBoxTimeoutW` (`userhelper/notify_prompt_windows.go`), macOS caps at three buttons, Linux returns no decision, and the agent waits 10 s without forwarding a timeout (`heartbeat/handlers_user.go`). The consent gate already renders a branded Tauri window with technician and org name and a correlated timeout on all three platforms. Cost: an agent and helper release. |
| D4 | Assurance tiers: 3 workstation **bound** (the answering OS principal is bound to the contact, D11), 2 workstation unbound or SMS/email link to an **established** destination (D12), 1 callback attestation or a link to a non-established destination. Default gate is tier ≥ 2 for both M365 actions. Email never counts toward resetting the mailbox it was sent to, judged against the subject's directory identity, not a string compare. | A technician-selected device and username is possession of *some* managed session in the org, not this contact's. Only a principal binding lifts that to tier 3. A link proves possession of the phone or mailbox of record, but only if that record predates the call and was set by a human. Verifying by email and then resetting that same mailbox is circular. |
| D5 | Gate lives in `actionIntents/revalidateRelease.ts`, with a UX pre-check at intent creation and defense-in-depth checks inside **all three** M365 mutation backends: `m365DirectGraph.invokeDirect`, `m365ControlPlane/writeActionService.executeM365WriteActionByOrg`, and the Delegant broker path (`aiToolsM365.call()` → `invokeDelegantTool`). | `revalidateRelease` is already the single fail-closed check both release paths run, and freshness is a release-time property. `aiToolsM365.ts` selects among three backends (`direct`, `controlPlane`, `delegant`); the first draft gated two. Any future caller that skips the intent layer still refuses. Behavioural tests prove every backend issues zero mutation calls on refusal; a source-reference contract test is not sufficient on its own. |
| D6 | Policy is a dedicated dual-ownership table `caller_verification_policies` (`org_id` XOR `partner_id`). Resolution is **strictest-wins per field** across org row, partner row and built-in defaults. Not a config-policy feature link. | Every config-policy resolver in `services/featureConfigResolver.ts` starts from a device hierarchy. This feature is scoped to an org and a contact and often has no device. "Closest row wins whole" (v1 draft) let an org `settings:write` holder create an org row with tier 0 and defeat the partner's security policy; `canManagePartnerWidePolicies` only governs partner-owned rows. Strictest-wins makes an org row tighten-only without a new authority model. Weakening below defaults is therefore only possible on the partner row, which is already partner-gated. |
| D7 | No `ticket_id` and no `device_id` column. Snapshots `ticket_ref`, `ticket_number`, `workstation_device_ref`, `device_hostname` carry the correlation with **no FK and no `device_id`/`ticket_id` column name**. | A table carrying `device_id`, `ticket_id` and `org_id` would be the first child selected by both org-move walkers (#4657 deadlock class). Worse, `breeze_device_child_orgid_tables()` (migration `2026-10-14-100000-ai-operator-thin-slice.sql`) discovers device children **by the uuid column name `device_id`**, FK or not, and rewrites `org_id` on a device move, which would then trip the contact/org composite FK. Renaming the snapshot column keeps the table out of both walkers; the badge and timeline resolve by `ticket_ref`. |
| D8 | "Not me" opens an `incidents` row (p2), places a **subject fence** on the contact, cancels every not-yet-dispatched action intent for the subject through a **system-scoped internal revocation** (not `cancelActionIntent`), reports already-executing intents honestly in the incident, and notifies the partner. | `alerts.device_id` is `NOT NULL`, so alerts cannot represent a device-less rejection. `cancelActionIntent` (`intentService.ts` ~L2289) requires requester-or-approver authorization, which a public challenge response does not have, and it only reaches `pending_approval`/`approved`; the release worker claims `executing` before revalidation (`intentReleaseWorker.ts` ~L904). So cancellation alone cannot stop a release already past CAS; the fence is checked again inside every Graph backend at dispatch, which is the last point before the irreversible boundary. A vishing campaign hits many orgs of one MSP, so the partner hears about it. |
| D9 | Delivery is asynchronous: start returns 202 and the UI polls. The `device_commands` row is created **in the same transaction as the verification row**, before anything is sent; the result is consumed by **one** idempotent handler in `services/commandResultHandlers.ts`, which both the WebSocket and HTTP transports already dispatch through. | Holding a request transaction across a two-minute agent round trip pins a pooled connection (#1105). `dispatchCommandToAgent` (`agentCommandRelay.ts`) transmits; it does not create the persisted ownership row, so "send then record the id" races an early result. The agent also posts results over HTTP (`heartbeat.go` ~L6084, `routes/agents/commands.ts`), and the WS path drops a duplicate once HTTP has terminalised (`agentWs.ts` ~L2107), so a WS-only hook loses decisions. |
| D10 | Public challenge page `/verify/:token`, patterned on Quick Support. | `routes/supportPublic.ts` already solves the same shape: token is the credential, tight `withSystemDbAccessContext`, per-IP limits, a two-tier miss budget, one atomic single-use transition. |
| D11 | **Canonical subject** is an Entra principal `(m365_connection_id, entra_tenant_id, entra_oid)` recorded in a new table `caller_verification_subject_bindings`, written only by the M365 directory import or by an explicit technician attestation. The gate resolves subjects by binding only; there is no email-string fallback. Ambiguity (two contacts bound to one OID, or one contact to two OIDs in the same tenant) fails closed. | `contacts.email` is deliberately non-unique (`schema/contacts.ts` ~L86); `contact_external_links` accepts arbitrary imported identifiers (`services/contacts/schemas.ts` ~L79), so an `entra` link is a label, not evidence; the M365 tools resolve UPN → OID and drop the UPN before mutating (`aiToolsM365.ts` ~L258), so a UPN string compare can guard a different user than the one mutated, and misses aliases. Same table also carries the principal bindings the workstation tier needs: `os_principal` (Windows SID or `uid:<n>@<hostname>`), `os_username`, `upn_snapshot`. |
| D12 | **Destination provenance** is its own table `caller_verification_destinations`: one row per (contact, kind, value hash) with `set_at`, `set_by_user_id`, `source` and optional `attested_at`. Every contact write path (CRUD route, import, inbound email, AI tool) records the change through one helper. "Established" is computed from this table, never from `contacts.updated_at` or the audit log. | The existing contact audit events record field *names*, roles and link metadata, not destination values (`services/contacts/audit.ts` ~L60/L96, `routes/orgContacts.ts` ~L351), so they cannot show that a phone number was unchanged for N days. AI-created contacts carry the technician's `userId` (`aiToolsOrgs.ts` ~L518), so "created by a human" is not derivable from ownership. Editing an unrelated field must not establish the phone. |
| D13 | A verification is a **single-use grant bound to** the canonical subject, the initiating technician, and an `action_scope` (`reset_password`, `disable_user`, or `any`). Release **consumes** it with a CAS (`consumed_by_intent_id IS NULL`). Cross-technician use is off by default (`allow_cross_technician_use`). Bindings changing (OID rebinding, contact merge, device move) or a fence invalidate outstanding grants. | v1 draft selected by contact, tier, status and age only. An impersonator ringing a second technician minutes after a legitimate verification inherited it, and one approval authorised repeated resets and a disable. |
| D14 | The Entra OID is pinned end to end: the intent's target, the grant's subject and the executor's mutation all name `(connection, oid)`; UPN is display-only after resolution. Expiry and the fence are re-evaluated at dispatch inside each backend, not only at release. | `writeActionService.executeM365WriteActionByOrg` forwards the original identifier (`writeActionService.ts` ~L159) and the executor re-resolves it (`m365-graph-actions-executor/src/microsoft/writeActions.ts` ~L56); a UPN reassignment or connection change between verification, release and execution separates the verified identity from the mutated one. |
| D15 | `disable_user` is gated on the **requester**, not the target. The requester is the verified contact on the call; if they are not the target they must hold an authoriser role on the org (policy `disable_user_authorizer_roles`, matched against `contacts.roles`, default `['primary']` plus `is_primary`). A separate, audited **administrative disable** path exists for offboarding and containment: initiator holds `settings:write` on the org with MFA, records a reason, no caller verification, partner notified. It never applies to `reset_password`. | Requiring the target's own cooperation to disable their account blocks the two legitimate cases (offboarding, compromise containment) where the target is unavailable or hostile, and would push partners to set the tier to 0 globally. |
| D16 | Feature is dark until W05: server flag `CALLER_VERIFICATION_ENABLED` (default false) hides every entry point and 404s the authenticated routes; per-method availability additionally requires the agent/helper capability (D17). | Green "Caller verified" badges without a live gate are a false sense of security. |
| D17 | Helper advertises `callerVerify` in its `Capabilities` report; the agent refuses the command as `undeliverable(helper_outdated)` when the console session's helper lacks it. Timeout is never approval. | Older Tauri helpers **silently ignore** unknown IPC messages (`apps/helper/src-tauri/src/ipc/client.rs` ~L365); the v1 draft assumed an unknown-type error reply. |
| D18 | Merge and erasure: `caller_verifications`, `caller_verification_subject_bindings` and `caller_verification_destinations` are `repoint` in `orgMergeRegistry` with a `custom` post-step that expires pending rows and fences fresh grants for loser-org contacts; `caller_verification_policies` is `keep-survivor`. All four in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. | Every cascade table needs exactly one merge classification or `orgMerge.ts` (~L1083) throws at runtime; the v1 draft registered none. |

Advisor quorum: v1 came from a Claude reviewer (Codex out of usage on
2026-09-18). v2 folds in the Codex gpt-6-astra `xhigh` review of 2026-09-19
(verdict: rework), whose file:line claims were re-read before adoption. The
two blockers became D11 and D4/D13; see "Review notes".

## Data model

All new tables are tenancy shape 1 (direct `org_id`, `breeze_has_org_access`)
except the policy table (dual ownership). No json/jsonb/bytea anywhere.

### `caller_verifications`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid not null | RLS `breeze_has_org_access(org_id)` |
| `contact_id` | uuid not null | composite FK `(contact_id, org_id) → contacts(id, org_id)` **DEFERRABLE INITIALLY IMMEDIATE**, `ON DELETE CASCADE` |
| `subject_binding_id` | uuid null | FK → `caller_verification_subject_bindings(id)` `ON DELETE SET NULL`; null for contacts with no Entra binding (grant then only satisfies `action_scope='any'` gates that allow unbound subjects, i.e. never the two M365 actions) |
| `initiated_by_user_id` | uuid not null | technician; FK `users(id)` `RESTRICT` plus `technician_label` snapshot |
| `technician_label` | varchar(255) not null | display name frozen at creation |
| `action_scope` | enum `caller_verification_action_scope` | `reset_password`, `disable_user`, `any` |
| `target_label` | varchar(320) null | what the card shows ("reset the password for j.smith@…"); snapshot |
| `method` | enum `caller_verification_method` | `workstation`, `sms`, `email`, `callback_attestation` |
| `status` | enum `caller_verification_status` | `pending`, `verified`, `rejected_by_user`, `wrong_choice`, `expired`, `undeliverable`, `cancelled`, `revoked` |
| `tier` | smallint not null | frozen at creation by the rules in "Tiers" |
| `tier_reason` | varchar(64) not null | `bound_principal`, `unbound_principal`, `destination_established`, `destination_recent`, `attestation` |
| `match_value` | char(2) not null | the number the technician sees |
| `decoy_values` | char(2)[] not null | two other candidates, fixed so the card is stable across reloads |
| `reverse_code` | char(4) not null | technician reads it aloud; the card shows it |
| `challenge_token_hash` | char(64) null | sha256 of a 32-byte link token; link methods only; unique partial index |
| `destination_id` | uuid null | FK → `caller_verification_destinations(id)` `RESTRICT`; link methods |
| `destination_redacted` | varchar(64) null | `+44 •••• ••12`, `a•••@acme.com` |
| `workstation_device_ref` | uuid null | snapshot, **no FK, deliberately not named `device_id`** (D7) |
| `device_hostname` | varchar(255) null | snapshot |
| `os_username` | varchar(255) null | the OS user the prompt was targeted at |
| `os_principal_observed` | varchar(255) null | SID / uid reported back by the agent for the answering session |
| `agent_command_id` | uuid null | FK → `device_commands(id)` `ON DELETE SET NULL`; unique partial index; written in the same transaction as the row (D9) |
| `ticket_ref` | uuid null | snapshot, no FK, not named `ticket_id` (D7) |
| `ticket_number` | varchar(32) null | snapshot for display |
| `attempt_no` | smallint not null | 1-based per contact within the attempt window; drives the cap |
| `expires_at` | timestamptz not null | workstation: `now() + workstation_timeout_seconds`; links: `+ 10 min`; attestation: `now()` |
| `decided_at` | timestamptz null | |
| `decided_from_ip` | inet null | link methods |
| `consumed_by_intent_id` | uuid null | FK → `action_intents(id)` `ON DELETE SET NULL`; set by the release CAS (D13) |
| `consumed_at` | timestamptz null | |
| `attestation_note` | text null | `callback_attestation` only |
| `created_at` | timestamptz not null | |

Indexes: `(org_id, contact_id, created_at desc)`; unique partial on
`challenge_token_hash`; unique partial on `agent_command_id`; partial on
`(contact_id, status, consumed_at) WHERE status='verified' AND consumed_at IS NULL`
for the gate lookup.

Export policy: `included` for everything except `challenge_token_hash`,
`match_value`, `decoy_values`, `reverse_code` → `excludedSensitive`.

### `caller_verification_subject_bindings` (D11)

| Column | Notes |
|---|---|
| `id`, `org_id`, `contact_id` | composite FK to `contacts(id, org_id)` deferrable, cascade |
| `m365_connection_id` uuid null | FK `m365_connections(id)` `ON DELETE CASCADE`; null for OS-only bindings |
| `entra_tenant_id` varchar(64) null, `entra_oid` varchar(64) null | the canonical subject; unique `(org_id, entra_tenant_id, entra_oid)` |
| `upn_snapshot` varchar(320) null | display and workstation matching; refreshed by sync, never used for authorisation |
| `os_principal` varchar(255) null | Windows SID, or `uid:<n>@<hostname>` on macOS/Linux; unique `(org_id, os_principal)` |
| `os_username` varchar(255) null | |
| `source` enum | `directory_sync`, `technician_attested`, `observed_login` |
| `established_at` timestamptz not null | `directory_sync`/`technician_attested`: when written; `observed_login`: first observation |
| `attested_by_user_id` uuid null, `attested_at` timestamptz null | |
| `revoked_at` timestamptz null | set when sync no longer sees the OID or a technician removes it |
| `created_at`, `updated_at` | |

Writers: the M365 directory import (`services/contacts/import.ts`, m365 source)
writes `directory_sync` rows keyed by OID; the contact drawer offers "Bind to
Entra user" (`technician_attested`, requires `ORGS_WRITE` + MFA, audited); the
agent's session broker reports `(sid|uid, username, upn?)` on the
`caller_verify` result and on login observation, which writes or refreshes an
`observed_login` row **only when the UPN matches an existing directory binding
for that contact**. An OS principal with no UPN match is never bound
automatically. Ambiguity rules: one OID → one contact per org; a second claim
marks both `revoked_at` and audits `caller_verification.binding_conflict`.

Export policy: all `included` (`upn_snapshot`, `os_principal` are identifiers,
not secrets). Merge: `repoint` (see D18).

### `caller_verification_destinations` (D12)

| Column | Notes |
|---|---|
| `id`, `org_id`, `contact_id` | composite FK, deferrable, cascade |
| `kind` enum | `email`, `mobile` |
| `value_hash` char(64) | sha256 of normalised address / E.164 |
| `value_redacted` varchar(64) | |
| `set_at` timestamptz | when this value became current |
| `superseded_at` timestamptz null | when it stopped being current; the current row has null |
| `set_by_user_id` uuid null | null for inbound-email and import writers |
| `source` enum | `technician`, `import`, `inbound_email`, `ai_tool`, `portal_self_service` |
| `attested_by_user_id`, `attested_at` | technician confirms the value out of band ("Confirm number of record") |

One helper `recordDestinationChange(contactId, kind, value, {source, userId})`
is called from every write path (`routes/orgContacts.ts`, `services/contacts/import.ts`,
`services/inboundEmail/resolveOrg.ts`, `aiToolsOrgs.ts`, portal profile edit).
A contract test greps every writer of `contacts.email` / `contacts.mobile` for
the call. Backfill: the migration inserts one row per current value with
`source='import'`, `set_at = contacts.updated_at`; those rows count as
established only once attested (conservative default; partners attest in bulk
from the contact list).

Export policy: `value_hash` → `excludedSensitive`, rest `included`. Merge:
`repoint`.

### `caller_verification_policies` (dual ownership, #2135 playbook)

| Column | Notes |
|---|---|
| `id`, `org_id` null, `partner_id` null | `caller_verification_policies_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`; unique on each owner |
| `required_tier_reset_password` smallint | default 2, 0..3; `0` disables the gate for that action — only meaningful on the partner row (D6) |
| `required_tier_disable_user` smallint | default 2 |
| `disable_user_authorizer_roles` text[] | default `{primary}`; roles a non-target requester must hold (D15) |
| `verification_ttl_minutes` int | default 30, 5..240 |
| `allowed_methods` text[] | default all four |
| `workstation_timeout_seconds` int | default 120, 30..300 |
| `destination_min_age_days` int | default 7, 0..90 |
| `require_attested_destination` boolean | default false; true → only attested rows are established |
| `require_ticket` boolean | default false; enforced at **initiation** (D7 / API) |
| `allow_cross_technician_use` boolean | default false (D13) |
| `max_attempts_per_hour` smallint | default 3 per contact |
| `cooling_off_hours` int | default 24 after a rejection |
| `created_at`, `updated_at`, `updated_by_user_id` | |

RLS: one dual-axis `FOR ALL` policy (system OR org access OR partner access)
plus the separate `FOR SELECT`-only partner-wide branch
`USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`
(template `2026-10-05-110000-config-policy-partner-wide-select.sql`). Registered
in `DUAL_AXIS_TENANT_TABLES` and, until the branch is verified by the coverage
suite, **not** in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`. Writes: partner rows
gated on `canManagePartnerWidePolicies`; org rows on `ORGS_WRITE` + MFA
(matches contacts). **Resolution is strictest-wins per field** (D6): tiers
`max`, TTL and timeout `min`, `destination_min_age_days` `max`, booleans that
tighten `OR`, `allowed_methods` intersection, attempt cap `min`, cooling-off
`max`. The API returns the effective policy with a per-field "from" so the UI
can show why an org field is read-only.

Export policy: `required_tier_reset_password` matches `SUSPICIOUS_NAME_PARTS`
(`password`) → `reviewedIncluded`; rest `included`. Merge: `keep-survivor`.

Lowering any tier, setting `destination_min_age_days` to 0, or enabling
`allow_cross_technician_use` on the partner row writes `audit_logs` action
`caller_verification.policy_weakened` with before and after values. Tightening
policy does not revoke issued grants; the gate re-evaluates against the
*current* policy at release, so a grant that no longer meets the tier simply
stops satisfying it.

### Registration checklist (same PR as the migration)

- RLS enabled + forced on all four; shape 1 auto-discovered for three, policy
  table in `DUAL_AXIS_TENANT_TABLES`.
- `CORE_ORG_CASCADE_DELETE_ORDER`: all four, alphabetical, children before
  `contacts`, `device_commands`, `m365_connections`, `action_intents`.
- `CORE_TENANT_EXPORT_POLICY`: every column as classified above.
- `orgMergeRegistry`: three `repoint` (with the D18 custom post-step), one
  `keep-survivor`.
- No column named `device_id` or `ticket_id` → not in any device cascade list
  and not discovered by `breeze_device_child_orgid_tables()`. A unit test
  asserts the schema has no such column on these tables.

## Tiers and the establishment rule

| Method | Tier | Condition |
|---|---|---|
| workstation | 3 | the answering session's `(os_principal, upn)` matches a non-revoked binding for this contact (D11) |
| workstation | 2 | delivered to the technician-selected `os_username` on the chosen device and answered, but no binding matches |
| sms | 2 | current `mobile` destination row is established |
| email | 2 | current `email` destination row is established **and** the destination is not one of the subject's mailbox addresses (see below) |
| sms / email | 1 | destination not established |
| callback_attestation | 1 | always; the technician records they called the number of record |

A destination is **established** when its current `caller_verification_destinations`
row has `set_at <= now() - destination_min_age_days`, `source = 'technician'`
or `attested_at IS NOT NULL`, and (if `require_attested_destination`)
`attested_at IS NOT NULL`. Inbound-email, import and AI-written values are not
established until attested. This closes the "email the ticket mailbox, become
a contact, verify yourself" path.

**Same-mailbox rule.** For an M365 action, an `email` verification never
counts if the destination equals any of the subject's `mail`,
`userPrincipalName` or `proxyAddresses` (SMTP entries, case-insensitive). The
gate fetches these from Graph for the pinned OID at release using the
directory-read scope the sync already holds; if the read fails, the gate
refuses `subject_mailboxes_unknown` rather than falling back to a string
compare.

The modal shows the computed tier per method before the technician picks, with
the reason when it is lower than expected ("mobile updated 2 days ago",
"no Entra binding for this contact — workstation caps at tier 2").

## Service layer

`apps/api/src/services/callerVerification/`

- `service.ts` — `start`, `cancel`, `attest`, `get`, `listForContact`,
  `freshForSubject`. `start` checks the readiness flag, site reach for the
  contact, policy, the attempt cap (an atomic `INSERT … WHERE (SELECT count(*)
  …) < cap` under a per-contact advisory lock), the fence, method availability
  and capability; computes the tier; generates `match_value`, two distinct
  decoys, `reverse_code`, and for links a 32-byte token whose hash is stored;
  inserts the row **and** for workstation the `device_commands` row in one
  transaction; writes `caller_verification.started` to the audit log and, when
  started from a ticket, a `system` ticket comment plus ticket event (payload
  carries `verificationId`) and outbox row. Delivery starts **after commit**,
  outside the request context. `require_ticket` is enforced here: the ticket
  must belong to the org and its `requesterContactId` must be the contact.
- `deliverers/workstation.ts` — sends the pre-created command through
  `dispatchCommandToAgent` with `{verificationId, username, technicianName,
  orgName, actionLabel, targetLabel, reverseCode, choices:[..3 shuffled..],
  timeoutMs}`. Partner trust: `caller_verify` is added to the capability
  allowlist in `services/partnerTrust.ts` next to `notify_user`.
- `commandResultHandlers.ts` gains `caller_verify`: one handler for both
  transports; looks the row up by `agent_command_id`, applies an
  expiry-aware CAS `UPDATE … WHERE status='pending' AND expires_at > now()`,
  maps `delivered=false`/`no_session_for_user` → `undeliverable`,
  `helper_outdated` → `undeliverable`, timeout → `expired`, chosen ==
  `match_value` → `verified` (tier finalised 3 or 2 from the reported
  principal), decoy → `wrong_choice`, "not me" → `rejected_by_user`. A
  reconciliation job expires pending rows past `expires_at` whose command never
  terminalised.
- `deliverers/link.ts` — builds `https://<partner app url>/verify/<token>`;
  SMS via `TwilioService.sendSmsMessage`, email via the branded layout. Send
  failure → `undeliverable`.
- `subjects.ts` — `resolveSubject({orgId, connectionId, entraOid})` → exactly
  one non-revoked binding or a typed refusal (`subject_unmatched`,
  `subject_ambiguous`). `bindingsForContact`, `attestBinding`,
  `observeLogin`.
- `destinations.ts` — `recordDestinationChange`, `currentDestination`,
  `isEstablished`, `attestDestination`.
- `gate.ts` — `requireCallerVerification({ orgId, action, subject:
  {connectionId, entraOid}, requester: {contactId?}, technicianUserId,
  intentId })`. Order: readiness flag → effective policy tier (`0` → pass) →
  resolve subject → fence (`contact_fenced`) → for `disable_user`, the
  requester rule (D15) → candidate grant: newest `verified`, unconsumed,
  `tier >= required`, `decided_at > now() - ttl`, `action_scope IN (action,
  'any')`, `initiated_by_user_id = technicianUserId` unless
  `allow_cross_technician_use`, and not (`method='email'` and destination in
  the subject's mailbox set) → **consume** via CAS setting
  `consumed_by_intent_id`. Refusals are a typed
  `CallerVerificationRequiredError { orgId, contactId?, action, requiredTier,
  reason, latest? }` with reasons `no_fresh_verification`, `grant_consumed`,
  `subject_unmatched`, `subject_ambiguous`, `subject_mailboxes_unknown`,
  `contact_fenced`, `requester_not_authorized`, `technician_mismatch`.
  Consumption happens in the same transaction as the release CAS so a lost
  release does not burn the grant; a dispatch failure after consumption is
  reported to the technician as "verification used, action failed, re-verify".
- `rejection.ts` — on `rejected_by_user`: insert `incidents` (p2,
  `sourceType='caller_verification'`, `sourceRef=id`); set the **fence**
  (the `rejected_by_user` row is the fence state until `decided_at +
  cooling_off_hours`; an override writes `fence_override_until` on that row
  plus an audit event, so the state lives in one table); mark other
  `verified`-unconsumed rows for the contact `revoked`; call
  `revokeIntentsForSubject(subject)` — a new **system-scoped** function in
  `actionIntents` that cancels `pending_approval`/`approved` intents whose
  pinned subject matches, with actor `system:caller_verification` and the
  verification id in details, and returns the ids of intents already
  `executing`, which the incident lists as "already dispatched, check Entra";
  audit `caller_verification.rejected`; ticket comment; in-app and email
  notification to the org's security recipients **and** the partner's. All
  side effects are idempotent on the verification id (outbox rows keyed on it)
  so a retried handler does not double-open incidents.
- During the fence the gate refuses and `start` requires `ORGS_WRITE` + MFA
  on the org to override, which writes `fence_override_until` and is audited.
- `wrong_choice` is audited and shown; no incident. It counts toward
  `max_attempts_per_hour`, so three misreads lock the contact for the hour.

Rate limits (Redis `rateLimiter`): 10 starts per technician per 10 minutes
plus the per-contact attempt cap above. Public route: 30 requests per IP per
minute and the Quick Support two-tier miss budget
(`services/supportCodeMissBudget.ts`) for unknown tokens.

## Agent and helper change (workstation tier)

New device command `caller_verify`, handled in `agent/internal/heartbeat/`
beside `consent_gate.go`. It resolves the session for the explicit `username`
through the session broker (never `PreferredSessionWithScope`), requires that
session to be the **console** session with a user helper advertising the
`callerVerify` capability, sends IPC `caller_verify_request` with the same
correlation and timeout pattern as `consent_request`, and returns
`{delivered, choice, principal: {sid|uid, username, upn?}, helperVersion}` in
the command result's stdout JSON. `upn` comes from the session's Entra join
state where available (Windows `whoami /upn` equivalent through the token,
macOS Platform SSO attribute when present); absent is fine and caps at tier 2.
Absent session → `no_session_for_user`; non-console session →
`session_not_console`; helper without the capability → `helper_outdated`.
Timeout → `timeout`, never a choice.

Helper (`apps/helper/src-tauri/src/ipc/`): `Capabilities` gains
`callerVerify: true`; a `CallerVerifyWindow` beside `ConsentDialog.tsx`:
always on top, partner logo and name, "<technician> from <org> is on the
phone with you and wants to <action> for <target>", the reverse code in large
type, three number buttons, "This is not me", a countdown, and the line "Only
tap a number if you are on the phone with <technician> right now. If you are
not sure, hang up and call <MSP> on the number you already have."

Commands doc `apps/docs/src/content/docs/agents/commands.mdx` gains the entry.
This wave ships in an agent release, so the workstation tier is unavailable
to a fleet until it has promoted; the methods endpoint reports it as
`unavailable(helper_outdated)` per device until then.

## Gate wiring

1. `services/actionIntents/revalidateRelease.ts`: for tool names
   `m365_reset_password` and `m365_disable_user`, call the gate with the
   intent's org, pinned `(connectionId, entraOid)`, requester contact,
   requesting technician and intent id; a refusal is a new `errorCode`
   `caller_verification_required` in the same shape as the existing failures.
   Both release paths already run this function.
2. `services/actionIntents/intentService.ts` `createActionIntent`: resolves
   the target to `(connectionId, entraOid)` and stores it in the intent
   (`targetEntraOid`, `targetConnectionId`); runs the gate in **check-only**
   mode (no consumption) for UX, so the technician sees "Start verification"
   before waiting on approval. Not authoritative.
3. Defense in depth at dispatch, all three backends: `m365DirectGraph.invokeDirect`
   cases `disable_user` and `reset_user_password`; `writeActionService.executeM365WriteActionByOrg`
   actions `m365.user.disable` and `m365.user.reset_password`, which also
   passes the pinned OID to the executor instead of the original identifier
   (executor change in `apps/m365-graph-actions-executor`); and
   `aiToolsM365.call()` before `invokeDelegantTool` for the same two tools.
   Each verifies the grant is consumed by *this* intent, unexpired, the
   subject is unfenced, and the OID matches the grant's binding. This layer
   also covers any path that reaches a backend without an intent.
4. Contract test `callerVerificationGate.contract.test.ts` reads the four
   source files and fails if any named case no longer references the gate;
   **plus** a behavioural suite that stubs each backend's HTTP/broker client
   and asserts zero mutation calls when the gate refuses.

The AI tool layer catches the typed refusal and returns a structured error with
`requiresCallerVerification: {contactId, requiredTier, reason}` so the chat
renders the modal, not prose. Every adapter between the gate and the client is
named in the plan and tested to preserve the payload: the inline release in
`aiAgentSdk.ts` (which today reduces revalidation failures to a generic
string, ~L1455), the release worker's terminal failure, the MCP tool result,
and the helper chat route. The intent release worker treats it as a terminal,
non-retryable release failure carrying the same payload.

### Administrative disable (D15)

`m365_disable_user` with `mode: 'administrative'` skips caller verification
when the intent's requester holds `ORGS_WRITE` on the org with a fresh MFA
claim and supplies `reason` (min 20 chars). The gate records
`caller_verification.administrative_bypass` in the audit log with the reason,
the incident-response UI shows it on the contact, and the partner's security
recipients are notified. The intent still goes through approval as today.

## API

All authenticated routes: readiness flag (404 when off), org scope, **site
reach for the contact** via the same helper the contact routes use
(`routes/orgContacts.ts`, "Site-axis reach"), `ORGS_READ` to view and
`ORGS_WRITE` + MFA to start, cancel, attest, bind or override, matching the
contact routes' ruling. Device and ticket ids supplied by the client are
re-checked for org ownership and the caller's site reach.

| Route | Notes |
|---|---|
| `POST /orgs/:orgId/caller-verifications` | `{ contactId, method, actionScope, deviceId?, username?, ticketId?, note? }` → 202 with the row. `matchValue`, `decoyValues` and `reverseCode` are returned only to the initiating technician (creator check on every read); others see status. `ticketId` is validated (org, requester = contact) and stored as `ticket_ref`/`ticket_number`. |
| `GET /orgs/:orgId/caller-verifications/:id` | polled every 2 s while pending. |
| `POST /orgs/:orgId/caller-verifications/:id/cancel` | pending → cancelled; initiator or `ORGS_WRITE`. |
| `GET /orgs/:orgId/contacts/:contactId/caller-verifications` | history, newest first, 50 max; includes `fencedUntil`, bindings and destinations with establishment state. |
| `GET /orgs/:orgId/contacts/:contactId/caller-verifications/methods` | per-method availability and computed tier with reasons; feeds the modal. |
| `POST /orgs/:orgId/contacts/:contactId/caller-verification-bindings` / `DELETE …/:bindingId` | technician attestation of an Entra binding (D11). |
| `POST /orgs/:orgId/contacts/:contactId/caller-verification-destinations/:id/attest` | attest a destination (D12). |
| `GET /orgs/:orgId/tickets/:ticketId/caller-verification` | freshest row with `ticket_ref = ticketId`, else freshest for the requester contact, plus `isFresh` and `isConsumed`; feeds the badge. |
| `GET /orgs/:orgId/caller-verifications/device-suggestions?contactId=` | online devices whose `last_user` or a binding's `os_username` matches the contact, with the matched username pre-filled and whether a binding exists (tier 3 vs 2). |
| `GET/PUT /orgs/:orgId/caller-verification-policy`, `GET/PUT /partner/caller-verification-policy` | `GET` returns own row + effective policy with per-field provenance; `PUT` upserts. |
| `GET /verify/:token` (public) | JSON for the card: branding, technician label, contact first name, action and target label, reverse code, the three candidates in stored order, expiry. Unknown, spent or expired → one generic "expired" response. `Cache-Control: no-store, private`. |
| `POST /verify/:token` (public) | `{ choice: '<2 digits>' \| 'not_me' }`. One atomic `UPDATE … WHERE status='pending' AND expires_at > now()` CAS; `not_me` then runs `rejection.ts` through the outbox. |

Public handlers wrap only the token lookup and the CAS in
`withSystemDbAccessContext` and get a live-DB integration test. Page rendering
is an Astro page in `apps/web` at `/verify/[token]` calling the JSON route,
consistent with the Quick Support landing page.

## Web UI

- **Entry points** (hidden while the flag is off): "Verify caller" on the
  ticket header, on contact rows and the contact drawer, and on the device
  page header (pre-selects workstation and that device; the technician picks
  the contact and confirms the username; the card shows "tier 3" only when a
  binding exists).
- **Modal**: step 0, what for: reset password / disable user / general; step
  1, method cards with computed tier and greyed reasons; step 2, match number
  and reverse code in very large type with the script line: "I've sent a
  prompt to your screen. It shows the code 7 3 1 9 and says I'm asking to
  reset your password. If that's right, tap **42**. If anything on it looks
  wrong, tap 'This is not me'." Live status; `verified` green with "usable
  once for <action> by you, expires in 30 min"; `wrong_choice` retry with the
  remaining attempts; `rejected_by_user` red panel linking to the incident;
  `undeliverable` with the concrete reason (no session for that user, helper
  outdated, not the console session, SMS failed).
- **Ticket badge**: "Caller verified · SMS · 12 min ago · unused" while fresh,
  "used for password reset" once consumed, grey "expired" after. Timeline
  shows system comments.
- **Contact drawer**: history, fence state, Entra binding (bind/unbind),
  destinations with established/attest controls.
- **Settings**: policy form under partner settings and under org settings;
  org form shows effective values with "from partner policy" and disables
  fields the org cannot loosen; persistent warning on the partner form when
  any tier is 0.
- **AI chat**: a refusal with `requiresCallerVerification` renders the modal
  inline.
- All new strings through i18n with real translations in every shipped locale.

## Threats this still does not stop

1. **Compromised endpoint or phone.** If the attacker already has the user's
   desktop session or SIM, tiers 2 and 3 pass. This is the ceiling for every
   product in the space.
2. **Coached real user (relay).** The attacker keeps the real user on a
   parallel call and repeats the match number they heard from the technician.
   Number matching does not stop this; the card mitigates by naming the
   technician, the action and the target and by telling the user to hang up
   and call the MSP back on a known number if unsure. Tier 3 with a binding
   raises the bar only in that the prompt lands on the bound user's own
   session, which the coached user is sitting at anyway.
3. **Slow-burn contact planting.** An attacker who plants a contact and waits
   out `destination_min_age_days` gets tier 2 only if a technician set or
   attested the destination; imported and inbound values never establish on
   their own. Partners with a stricter posture set `require_attested_destination`
   or the required tier to 3.
4. **Out-of-band execution.** See non-goals.
5. **Policy weakening.** Partner-row only, audited, warned in the UI.
6. **Technician collusion or a compromised technician account.** The
   technician who verifies is the one who releases; a compromised technician
   can verify a planted contact and act. Approval flow and MFA on the
   technician side are the existing controls; this feature does not add to
   them.

## Testing

- Unit: state machine transitions including `revoked` and consumption; decoy
  distinctness; token hashing; tier computation including bindings,
  establishment and the same-mailbox set; gate resolution order and every
  refusal reason; strictest-wins policy resolution; deliverer result mapping
  for both transports and the duplicate-result case; rejection fan-out
  (incident, system revocation returning executing ids, fence, notifications,
  idempotency on retry); destination-change helper called from every writer
  (grep contract).
- Contract: gate references in the four files; RLS coverage (all four
  tables); org cascade; export policy; dual-axis select branch for the policy
  table; partner-wide XOR; merge registry classification; no `device_id` /
  `ticket_id` column on the new tables.
- Behavioural: each of the three backends issues zero mutation calls when the
  gate refuses, and exactly one when it passes; OID pinned through to the
  executor payload; UPN change between verification and release does not
  redirect the mutation.
- Integration (live DB): cross-org forge → 42501 on all four tables; sibling-
  site user denied on every authenticated route; public route under system
  context; concurrent `POST /verify/:token` CAS; concurrent release of two
  intents against one grant → exactly one consumes; org merge with a pending
  verification, two populated policies, and fresh grants in the loser org
  (revoked); device org-move leaves `workstation_device_ref` rows untouched
  and does not trip the composite FK; intent release refused without a fresh
  verification and allowed with one; "not me" during `executing` reports the
  intent as dispatched.
- Agent: `go test -race` for `caller_verify` session targeting (explicit
  username, missing session, non-console session, helper without capability,
  timeout is not approval, principal reported). Helper: capability advertised;
  window renders action, target, three buttons and reports the choice; an old
  helper build ignores the message and the agent times out to
  `helper_outdated`, tested with a stub helper that lacks the capability.
- Web: modal availability and tier display, badge freshness and consumption,
  policy forms with read-only provenance, locale parity, all hidden when the
  flag is off.
- Manual, pre-release, on the lab rigs: workstation prompt on Windows 11
  (Entra-joined, tier 3) and macOS (tier 2); SMS to a real handset; "not me"
  ends in an incident, fences the contact and cancels a pending intent; a
  UPN-renamed user is still the pinned OID.

## Waves

| Wave | Scope |
|---|---|
| W01 | All four tables, migrations, registrations (RLS, cascade, export, merge), destination-change helper wired into every contact writer with backfill, subject bindings from the directory import, policy resolver (strictest-wins) and defaults, service state machine, tier and establishment rules, gate service with consumption, `revokeIntentsForSubject`, authenticated API with site reach, callback attestation method, audit and ticket timeline. Readiness flag off. |
| W02 | Agent `caller_verify` command with principal reporting, helper capability + window, shared command-result handler, pre-created command row, workstation deliverer, device suggestions, partner-trust allowlist, commands doc. Needs an agent release. |
| W03 | SMS and email deliverers, public JSON route, Astro challenge page, rate limits and miss budget, same-mailbox Graph read. |
| W04 | Web: modal, entry points, ticket badge, contact drawer (bindings, destinations, fence), policy forms with provenance, AI chat refusal rendering, i18n. All behind the flag. |
| W05 | OID pinning in intents and executor; gate wired into `revalidateRelease`, intent-creation pre-check, all three backends, administrative disable path, contract + behavioural tests; rejection fan-out (incident, revocation, fence, partner notification); every refusal adapter; docs and release notes; **flag flipped on**. Lands last so W01–W04 change no existing M365 flow and expose nothing. |

Feature-lifecycle registration happens when the plans are written.

## Review notes

### Independent Claude reviewer, 2026-09-18 (v1)

- R1 Workstation tier cannot be built on `notify_user`. Adopted: D3.
- R2 Two disjoint Graph executors; the shared fail-closed seam is
  `revalidateRelease.ts`. Adopted: D5 (widened to three backends in v2).
- R3 No org-scoped config-policy resolver exists. Adopted: D6.
- R4 `device_id + ticket_id + org_id` would be the first dual-axis org-move
  child. Adopted: D7 (tightened in v2 to rename the columns).
- R5 `alerts.device_id` is NOT NULL. Adopted: incidents, D8.
- R6 Inbound email auto-creates contacts; email-to-mailbox before resetting
  that mailbox is circular; no attempt cap. Adopted: establishment rule,
  same-mailbox exclusion, attempt cap, cooling-off.
- R7 Always target an explicit username. Adopted.
- R8 Emit ticket event and outbox row with the system comment. Adopted.
- R9 `sendCommandToAgentAwaitResult` is api-role-affine. Adopted: D9.

### Codex gpt-6-astra `xhigh`, 2026-09-19 (v2) — verdict "rework", all 18 folded

Full text: `2026-09-18-caller-verification-design.codex-review.md`.

| # | Finding | Adopted as |
|---|---|---|
| 1 | Blocker: answering session not bound to the contact | D4 (workstation unbound = tier 2), D11 bindings, principal reported by agent |
| 2 | Blocker: no canonical subject; email compare misses aliases | D11 OID binding, no email fallback, same-mailbox set from Graph |
| 3 | Graph check guards identifier, not mutated identity | D14 OID pinned intent → executor |
| 4 | Contact audits cannot prove destination provenance | D12 destinations table + helper + backfill-as-unestablished |
| 5 | Grant reusable across calls and actions | D13 single-use, technician- and action-bound, CAS consume |
| 6 | Reverse-verification claims false | D2 rewritten, script and card copy changed, threat 2 rewritten |
| 7 | `cancelActionIntent` lacks authority; `executing` race | D8 system revocation, fence re-checked at dispatch, executing reported |
| 8 | Delegant backend ungated | D5 third backend + behavioural tests |
| 9 | WS-only result hook loses decisions; send-then-record race | D9 shared handler, command row pre-created in tx |
| 10 | RDS / old-helper assumptions wrong | D17 capability, non-console → unavailable (non-goal) |
| 11 | Org override defeats partner policy | D6 strictest-wins per field |
| 12 | Site reach not applied | API section: site reach on every route, device/ticket ownership re-checked |
| 13 | `device_id` rewritten on device move by column name | D7 `workstation_device_ref` |
| 14 | Merge registry classification missing | D18 |
| 15 | Ticket correlation discarded | `ticket_ref`/`ticket_number` snapshots; `require_ticket` at initiation |
| 16 | Disable-user needs target cooperation | D15 requester rule + administrative disable |
| 17 | UI ships before enforcement | D16 readiness flag, W05 flips it |
| 18 | Permissions, allowlists, export, refusal plumbing unspecified | `ORGS_READ`/`ORGS_WRITE`+MFA, both RLS allowlists, `reviewedIncluded` for the `password` column, named refusal adapters |

## Open questions for Todd

None blocking. Defaults chosen: gate tier 2, TTL 30 minutes, establishment
window 7 days, backfilled destinations unestablished until attested, 3
attempts per hour, 24 hour fence, ticket not required, single technician use,
authoriser role `primary`. All are policy knobs. One product call worth a
glance: the backfill rule means every existing contact starts at tier 1 for
SMS/email until a technician attests the number, which is the safe default but
adds a one-time attestation chore per partner.
