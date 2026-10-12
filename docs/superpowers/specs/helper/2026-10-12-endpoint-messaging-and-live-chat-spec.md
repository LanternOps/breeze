# Endpoint messaging and live chat: Spec

Issues: LanternOps/breeze#8293 (anchor, "Send Message to Endpoints"), LanternOps/breeze#8292 ("Endpoint Live Chat")
Date: 2026-10-12
Status: draft for owner approval. No code, migration or wave registration exists yet.
Related: #8138 / PR #8213 (Assist starts hidden), `agent/2026-10-08-agent-localization-helper-runtime-branding-design.md` (runtime branding), `agent/2026-03-30-session-aware-assist-design.md`

One spec covers both issues because they share a transport, a helper surface, a branding rule and a trust model. They ship as separate waves.

## Problem

**#8293.** An MSP wants to push a message to the person at a machine. It stays on screen until the person closes it or an optional expiry passes. It must be branded so the person can tell it comes from their MSP. The technician picks several devices and several sites as targets. Uses: "phones are down, call this number", "please contact us", "maintenance tonight".

**#8292.** An MSP wants to talk to the person at a device live, without starting remote access. Uses: ask for remote-access consent before connecting, and talk through an issue when phone signal is poor.

**What exists today.** The plumbing is mostly there; the product is not.

- Agent side: `notify_user` is registered in `agent/internal/heartbeat/handlers_user.go` (`CmdNotifyUser`, line 15). It builds an `ipc.NotifyRequest` (title, body, icon, urgency, actions) and calls `sessionBroker.SendCommandAndWait(..., ipc.TypeNotify, ..., 10*time.Second)`. The handler does not pass `TimeoutMs` or `FallbackDialog`, although both fields exist on `NotifyRequest` (`agent/internal/ipc/message.go:297`).
- API side: `'notify_user'` appears **only** in `GATED_COMMAND_TYPES` (`apps/api/src/services/partnerTrust.ts:129`). Nothing else in `apps/api/src` references it (grep, non-test and test). It is **not** in `CommandTypes` (`services/commandTypes.ts`), so it has no entry in `COMMAND_OFFLINE_POLICY_REGISTRY`, and `defaultOfflinePolicy` throws `UnregisteredCommandTypeError` for an unregistered type (`services/commandOfflinePolicy.ts:350`). No route and no AI tool queues it. **Key gap: the agent can show a toast, and nothing can ask it to.**
- Routing: `notify_user` reaches the native `user_helper` (`userHelperScopes` includes `notify`, `sessionbroker/broker.go:214`). The Tauri Assist helper only receives `assistHelperScopes = {assist, consent_ui}` (`broker.go:225`), and the comment there says consent_ui is UI-only and not notify. A native toast cannot stay on screen "until closed" in a controlled way, cannot carry a branded card, and cannot take a reply. A persistent branded message and a chat both need the Assist UI.
- Assist now starts hidden (#8138). `lib.rs` builds the `main` window with `.visible(false)` (line 1401), `--show` opens it, as does any launch without `--config` (`launch_requests_window`, line 660), and window-state restore excludes `VISIBLE` (`window_state_flags`, line 686). Any incoming message must decide whether to surface UI. It must not make the helper "pop up randomly" again.

## Users & scope

**Senders.** MSP technicians in Breeze Web, and (W1 only, approval-gated) the AI agent. Not end users.

**Receivers.** The signed-in person at a device, reached through that device's connected helper session. Not portal users in W1/W2.

**Tenancy.**

- A send targets devices. Authorization is per device, using normal device RLS and the caller's org access. Org-scoped users can send only to their own org's devices.
- Targets: explicit devices, sites, device groups, whole org, or (partner-wide) all orgs of the partner. Targets resolve to a device list at send time (snapshot, not a live query), except "all orgs" which resolves at send time too but is recorded as `target_mode = 'partner_all_orgs'`.
- Partner-wide targets (more than one org, or "all orgs") are partner-owned batches. Creating one requires `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts:25`: system, or partner scope with `partnerOrgAccess === 'all'`). A partner user with `selected` org access can send to a multi-org selection only if they hold access to every resolved device's org; the batch is still partner-owned but the gate is per-device. Decision recorded in OD-8.
- Single-org sends are org-owned batches.

**Which sessions receive, and platform coverage.** The native `user_helper` path fans out one helper per interactive session via `notifyTargets` (`sessionbroker/notify_targets.go`). The **Assist helper is narrower**: the broker admits an Assist-role helper only in the active console session (`broker.go:2735`, "assist role requires the active console session"), and the Assist helper is Windows-only (comment at `broker.go:2740-2742`). Consequences, stated plainly: persistent branded cards (W1) and live chat (W2) reach the **Windows console session only**. Non-console RDS sessions, macOS and Linux get the native fallback in W1 (toast, or blocking prompt with a timeout, `userhelper/notify_prompt*.go`) and **no chat** in W2. Widening Assist to RDS sessions or other OSes is a separate security-sensitive change and out of scope (OD-14).

**Permission.** Recommended: a new narrow permission `endpoint_messages:send` (and `endpoint_messages:read`), granted by migration to every role that already holds `devices:execute`. Reusing `devices:execute` (`routes/devices/commands.ts:50`) would work but ties "may talk to a user" to "may run code". See OD-4.

**Consent and trust.**

- A one-way message needs no end-user consent; it is information from the device owner's administrator, like a login banner. It still must be unforgeable as to sender (below).
- Chat is always initiated by the technician. The user can reply inside an open conversation (org toggle, OD-3). The user cannot start a chat by default.
- Remote-access consent is **not** negotiated in chat. A chat line "may I connect?" never counts as consent. The existing `consent_request` flow (fixed, Breeze-owned wording; `ScopeConsentUI`) remains the only consent. Chat may carry a convenience button that triggers that existing flow.
- Partner trust: content-bearing command types go in `GATED_COMMAND_TYPES` (unknown types fail closed); `retract_message` and `chat_close` carry no operator content and are lifecycle commands, so a restricted partner can still retract. The `notify_user` entry suggests the gate is the `device_execute` capability (`partnerTrust.ts:237`); the exact capability mapping for message types is not verified and is a W1 task. Intent: a probation or restricted partner cannot push operator-chosen popups to endpoints.

**Branding.** Resolved server-side at send time from the existing partner default → org override chain (runtime-branding spec §4.3, §6.1): `companyName`, `displayName`, colours. Snapshotted on the batch so a later branding edit does not rewrite history and so offline devices render what was sent. The sender line ("From <companyName>") is a **fixed template slot** the helper composes. The message body can never replace it (mirrors branding spec §6.5, which keeps consent text Breeze-owned). Logos are out of scope: the branding spec defers icons and signed assets (§1.3), and remote image fetch in a popup is a tracking and phishing vector.

**Audit.** Every send writes `audit_logs` with actor, batch id, target mode and counts, severity, and a body hash and length, never the body. Delivery and ack events are rows in the delivery table, not audit rows (volume). AI-origin sends carry `aiOrigin` (supported by `queueCommand`/`queueCommandForExecution` options).

## Proposed design

### Transport (reuse, do not invent)

API → agent uses `device_commands` via `queueCommandForExecution` (`services/commandQueue.ts:917`), delivered over the agent WS (`routes/agentWs.ts`), result via `routes/agents/commands.ts`. Agent → helper uses the session broker IPC and the HMAC-framed envelope (`apps/helper/src-tauri/src/ipc/envelope.rs` must stay byte-compatible with `agent/internal/ipc/protocol.go`; no envelope change is needed, only new message `typ` values).

New command types (added to `CommandTypes` and the offline-policy registry; content-bearing types go in `GATED_COMMAND_TYPES`, while the cleanup types `retract_message` and `chat_close` go in `LIFECYCLE_COMMAND_TYPES` so a restricted partner can still pull a message back, like `script_cancel` and `support_end`):

| Type | Wave | Offline class |
|---|---|---|
| `deliver_message` | W1 | queue; `deliverBy = min(expiresAt, class TTL)` |
| `retract_message` | W1 | queue, short TTL (cancels a still-pending or sticky message) |
| `chat_open` / `chat_message` / `chat_close` | W2 | live (reject when offline): chat is pointless to a device that is not there |

`notify_user` is left alone. It stays the fire-and-forget native toast. `deliver_message` is a new type because its contract differs: persistent until closed, acknowledge, expire, retract, replay on helper restart. The agent handler falls back to the existing native path (`ipc.TypeNotify`, with `FallbackDialog` for critical) when no Assist helper advertises messaging, so a device without an updated Assist still shows something.

Offline semantics (W1): a message for an offline device is queued with the registry class `standard` (168 h default, `deviceCommands` reaper) but capped by the message's own `expiresAt`. A message with no expiry still dies at the class TTL and the delivery row ends `expired`. A device that is online but has no connected helper session fails with today's `no user helper connected` error; the delivery row records `failed:no_helper` and the batch view offers "retry". The agent does **not** hold messages for a helper that has not yet connected beyond the command's own claim (OD-5).

### Agent → API events

Command results cover "delivered to a helper". The later events (displayed, acknowledged, dismissed, expired, user replied) cannot ride the command result. New upstream path: agent-authenticated `POST` on the agent routes (`apps/api/src/routes/agents/`), idempotent on `(delivery_id, session_key, event_type)` for status events and on a client-generated message nonce for chat replies (repeated replies must not collapse). Chosen over helper-token HTTP (`helperFetch.ts`, `middleware/helperAuth.ts`) because the helper token is device-level and does not assert which OS user acted. The agent knows the authenticated session (username, SID, WinSessionID) from the broker. Identity of the acting user is therefore agent-attested.

### Helper surface and new IPC scope

Decision: **new scope `ScopeMessaging = "messaging"`**, granted to the Assist helper on explicit advertisement (`AuthRequest.SupportsMessaging`), exactly as `ScopeConsentUIFallback` is granted only on `SupportsConsentUI` so old helpers keep old semantics (`ipc/message.go:192-197,232-238`). Not reusing `consent_ui`: its definition is "remote-session consent prompt + banner", and the comment explicitly excludes notify. Widening it would let every future consent-path change reason about arbitrary operator text. The scope also lets the agent refuse to send messages to a helper that predates the feature.

New envelope types (agent → helper): `message_show`, `message_retract`, `chat_open`, `chat_message`, `chat_close`. (helper → agent): `message_presented`, `message_ack`, `message_dismissed`, `chat_reply`, using the nonce pattern from `consent_presented` / `consent_result` (`ipc/consent.rs`). The helper dispatches in `ipc/client.rs` next to `consent_request` and `banner_show` (line 313+).

Native `user_helper` remains the fallback surface only (OD-6).

### When a message may surface the hidden helper (#8138)

The main Assist window is never shown for a message. Messages render in a **dedicated small card window**, built like `show_consent_window` / `show_banner_window` (`ipc/desktop.rs:148,232`), so a user who has not opened Assist does not get a large app window.

| Event | Behaviour |
|---|---|
| `info` message arrives | Card shown without taking focus; tray tooltip/badge updated. Auto-hides only if `expiresAt` passes or the user closes it. |
| `warning` / `critical`, or `requiresAck` | Card shown, topmost. `critical` may take focus; at most one focus-taking card per device per 5 minutes. |
| Helper restarts (logon, update, watcher respawn) | Card **replayed only** for messages that are sticky, unexpired and unacknowledged. Already-acked or expired ones are not shown. This is the one case a card appears without a fresh operator action, and it is the point of "stays until closed". |
| Chat: first message of a technician-opened conversation | Card shown (a deliberate interruption, like an incoming call). |
| Chat: later messages | If the chat window is open, update it and flash the taskbar entry. If the user minimised/closed it, tray badge only; no re-raise. |
| Helper start with nothing pending | Nothing. #8138 behaviour unchanged. |

State that must survive helper restarts (sticky message list, ack state) lives in the agent (small on-disk store keyed by delivery id, pruned on expiry), not in the helper, because the agent respawns the helper and already owns `helper_config.yaml`. The API remains the source of truth for status.

### Content rules (anti-phishing; OD-4)

Plain text plus a restricted markdown subset. The existing helper renderers (`apps/helper/src/lib/safeMarkdown.tsx`: `isSafeHttpUrl`, `SafeMarkdownLink`, `SafeMarkdownImage`) are a starting point only: they accept `http:` and show arbitrary link labels, so they do **not** by themselves deliver the guarantees below. W1 adds a message-specific wrapper that enforces them. Allowed: bold/italic/lists/https links; **no images, no HTML**. Links render with their real host always visible (label text that looks like a different URL is replaced by the host) and open in the default browser, never in the privileged webview. Title ≤ 120 chars, body ≤ 2000. Severity enum `info | warning | critical`. The card always shows the fixed sender slot and an "Sent by your IT provider" footer. Validation is shared (`packages/shared/validators`) and enforced on the API; the helper re-validates (defence in depth) and renders unknown/oversized content as plain text.

### Waves

**W1: one-way message with acknowledge/dismiss.** Ships independently of W2/W3.
- `CommandTypes` + gated + offline registry entries; API route `POST /endpoint-messages` (target resolution, permission, rate limit, branding snapshot, audit), `GET` list/detail with per-device status; `retract`.
- Agent: `deliver_message` handler, messaging-scope routing with native fallback, sticky store and replay, upstream events route.
- Helper: `message_show` card window, ack/dismiss, tray badge, replay.
- Web: "Send message" from device list (multi-select), site and org pages; compose form with live preview of exactly what the user will see; batch status view.
- AI tool (approval-gated), see below.
- Migration + registrations (next section).
- Rollout flag per partner (default off until helper fleet has the feature).

**W2: two-way live chat, ad-hoc.** Requires W1's scope, card window and upstream events.
- `chat_*` commands and envelopes, helper chat window (reuses `safeMarkdown`; separate component from the AI `ChatView.tsx`/`chatStore.ts`, which talk to `clientAi` with the helper token), conversation + message tables, web chat panel on the device page, technician picks the target session. User reply (org toggle), close from either side, idle auto-close.
- Browser delivery of user replies: no verified push channel into the web console is cited in this spec. W2's plan must confirm an existing realtime path; fallback is short-interval polling of the open conversation.
- Retention job for message bodies.

**W3: ticket binding.** Optional `ticket_id` on a conversation, added by a W3 migration as a nullable column (additive). Start-from-ticket-UI entry. Org policy `chat_ticket_policy`: `optional` (default) | `required` | `off`. Transcript written to the ticket timeline (OD-2). Identity mapping to `requesterContactId` only on reliable match. The channel-neutral `channel` column exists from W2 but only `endpoint_helper` is implemented; Teams/Slack/Entra adapters are separate future specs.

### AI tool exposure

W1 adds `send_endpoint_message` (one write action, plus a read-only `list`/`get` for status, following the action-style of `manage_tickets` in `services/aiToolsTicketing.ts`). Registration points to check, not judge: `aiToolsDevice.ts`/new `aiToolsMessaging.ts` (thin hub pattern), `aiToolSchemas*.ts`, `aiGuardrails.ts` tier tables, `aiToolRateLimits.ts`, `mcpCoverage.ts`, `services/aiAgents/agentToolCatalog.ts`. Tier: customer-visible and impersonation-adjacent, so **always human approval** (the `manage_tickets:comment` precedent at `aiGuardrails.ts:686` is for a customer-visible comment; same class). A tight rate limit (proposed 5 sends/hour). Existing tool limits are per user/tool and multiplied by tier in `aiGuardrails.ts` (~line 2844), so registering in `aiToolRateLimits.ts` is not enough: the send route itself enforces actor/partner limits through `services/rate-limit` (Redis), AI or not. `aiOrigin` threaded to the queue. Two repo traps apply: AI-tool contract tests key `SAFE_WRITE_SITES` by line number (update them when line numbers shift), and no `z.undefined()` anywhere in a tool schema (it empties the model's tool list). AI does **not** get live chat in W2: AI-composed real-time conversation with an end user is out of scope.

### Portal

W1/W2: not visible in the customer portal. W3: a ticket-bound conversation's transcript appears in the portal ticket view if and only if mirrored as a public comment (OD-10).

### Evaluation of the #8292 contributor direction

Treated as input, not a decision.

**Adopt.**
- Technician-initiated only; the user cannot start a conversation by default (no parallel intake queue). Matches the original request, which only describes the tech talking to the user.
- The ticket comment stays the canonical support record where a ticket exists; a **separate delivery record** carries status, timestamps, session identity and errors. Matches the tables above.
- Messaging core decoupled from the agent: a `channel` column and a delivery record, with Helper as the first adapter.
- Identity honesty: the agent-attested session (username, SID, session id) is stored; a Breeze Contact is linked only on a reliable mapping. Never guessed.
- Reply path goes through the agent (identity is agent-attested).

**Do not adopt as stated.**
1. *Every conversation bound to a ticket* conflicts with the original request: the requester uses chat **before** taking access and for quick "are you there" contact, often before any ticket exists (inferred from the request's wording, not stated in it). A mandatory ticket forces ticket-per-ping noise or fake tickets. It also cannot apply to #8293 broadcasts, which target N devices with no ticket and no single requester.
2. *Tech always talks from the ticket UI* is a good default for an org that wants it. As a hard rule it removes the device-page entry the original request implies (the tech is looking at a device).
3. *Each reply as a ticket comment* has side effects. A public `ticket.commented` event emails the requester (`jobs/ticketNotifyWorker.ts:836-849`), suppressed today only by the `inbound` flag meant for email-origin comments. Chat lines need their own suppression source or they spam and can loop. `ticket_comments` rows are also editable and soft-deletable (`deletedAt`, `editedAt`, `portal.ts` schema), a weak fit for a conversation record. Mirroring one transcript comment at close removes the notification storm but not the mutability (the comment stays editable and soft-deletable), so the authoritative record is the conversation tables plus audit rows and the ticket comment is a convenience copy.
4. *Teams/Slack/Entra adapters, per-org default channel* is a separate product with its own identity and consent model. Build the data model channel-neutral, build only the endpoint adapter, spec the others separately.

**Resolution.** Conversations are a first-class entity with nullable `ticket_id`. An org policy sets `optional` (default), `required` (the contributor's model, per org), or `off`. #8293 broadcasts are never ticket-bound. This honours the contributor's workflow for orgs that want it without breaking the original ask. See OD-2.

## Tenancy & data model impact

Spec only. No migration in this PR. Tables below are proposed.

**Migration slot.** The newest committed migration on `origin/main` is `2026-12-23-100000-tier1-sweep-indexes.sql` (checked with `ls apps/api/migrations`; shipped names run ahead of the calendar). W1's file must sort after the then-newest file, e.g. `2026-12-23-110000-endpoint-messages.sql`; re-check at implementation. Idempotent, no inner `BEGIN/COMMIT`, `set_config('breeze.scope','system',true)` before any permission-grant `INSERT` into role tables, per `apps/api/migrations/README.md`.

### W1 tables

**`endpoint_messages`** (batch/campaign parent). Dual ownership per the Partner-Wide First rule: `org_id` XOR `partner_id`, `endpoint_messages_one_owner_chk`, partner index, one dual-axis RLS policy (`system OR org-access OR partner-access`). Justification for XOR rather than `org_id NOT NULL`: a partner-wide send to all of a partner's orgs has no single org. Columns: `id`, `org_id`, `partner_id`, `created_by`, `target_mode`, `target_spec` (jsonb, **excludedOpen**; for partner-owned batches it holds selection criteria and counts only, never device or org ids, so org erasure leaves nothing dangling; resolved ids live in the deliveries), `title`, `body` (text, user content/PII), `severity`, `requires_ack`, `allow_reply` (W2), `expires_at`, `branding` (jsonb snapshot, **excludedOpen**), `ai_origin_*`, `created_at`.
Read access: RLS is coarse here. Any partner-scope token passes `breeze_has_partner_access` for its partner regardless of `selected` org access (`middleware/auth.ts:522`), so **RLS cannot hide a partner-owned batch from a selected-org partner user**; the route must filter to batches that have a delivery in the caller's accessible orgs (app layer, with a test). Org-scoped tokens get a SELECT-only policy `EXISTS (delivery in the caller's org for this batch)` instead of the playbook's blanket partner-wide branch, so they see only batches that reached their devices. `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` is frozen empty (ceiling zero, `rls-coverage.integration.test.ts:935`) and is **not** available; the implementation must classify the table per the harness's rules and add dedicated functional RLS tests. This deviation needs reviewer sign-off.

**`endpoint_message_receipts`** (insert-only event log, one row per session event: `org_id`, `device_id`, `delivery_id`, `session_key` (agent-attested WinSessionID/username), `event_type`, `at`; unique `(delivery_id, session_key, event_type)`; same shape-5 denormalization). The delivery row's `status` is the aggregate across receipts; per-session truth lives here because the native path can reach several sessions while Assist reaches one.

**`endpoint_message_deliveries`** (one row per device per batch; **shape 5, device-id scoped, hot-write**, so denormalized `org_id`, not an EXISTS join policy). Columns: `id`, `batch_id` FK → `endpoint_messages(id)` (ON DELETE CASCADE), `org_id` NOT NULL, `device_id` FK, `command_id`, `status` (`queued|delivered|displayed|acknowledged|dismissed|expired|retracted|failed|superseded`), `surface` (`assist|native|mixed`), `delivered_at`, `displayed_at`, `acked_at`, `dismissed_at`, `expires_at`, `error_code`, `created_at`. Index `(batch_id, status)` and `(device_id, created_at)`. Fan-out volume: one row per target device; 10 000-device blast = 10 000 inserts in one transaction batch (chunked, system context worker), not per-request.

### W2 tables

**`endpoint_conversations`**: `org_id` NOT NULL (a conversation is always one device in one org; XOR rule N/A, justified), `device_id`, `ticket_id` NULL (W3), `channel` (`endpoint_helper`), `opened_by`, `target_username`, `win_session_id`, `status`, `allow_user_reply`, timestamps. **`endpoint_conversation_messages`**: `org_id`, `device_id` (denormalized, hot-write; needed for device cascade), `conversation_id`, `direction`, `body` (PII), `sender_user_id` NULL, `sender_session` (jsonb snapshot: deviceId/username/SID/session id as agent-attested, **excludedOpen**), `created_at`, `delivered_at`, `read_at`.

### Registrations (a new `org_id` table is not done until all are touched; grep, don't judge)

| Registry | Entries |
|---|---|
| RLS: `rls-coverage.integration.test.ts` | `endpoint_messages` → `DUAL_AXIS_TENANT_TABLES` (+ documented SELECT-branch alternative above). `endpoint_message_deliveries`, `endpoint_message_receipts`, `endpoint_conversations`, `endpoint_conversation_messages` have a direct `org_id` column, so they are auto-discovered shape 1 (denormalized-on-device-table, Phase 1-4 style). Verify none needs `DEVICE_ID_JOIN_POLICY_TABLES`. |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | all five, alphabetical (`localeCompare`, `organizations` last). **FK direction:** the integration test computes FK order topologically (`tenantCascade.integration.test.ts`), so verify children-before-parents there rather than trusting the names. Chains: receipts → deliveries → messages; conversation_messages → conversations. Use `ON DELETE CASCADE` on the batch/conversation FKs and confirm the order assertion passes; if alphabetical and FK order conflict, rename the tables. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) | deliveries, receipts, conversations, conversation_messages (all carry `device_id`). |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) | the same three (`device_id` + denormalized `org_id`); enforced by `moveOrg.coverage.test.ts`. |
| `orgMergeRegistry.ts` | `repoint` for deliveries, receipts, conversations, conversation_messages. For `endpoint_messages` with `org_id` set: `repoint`; partner-owned rows are untouched by an org merge. Any composite FK touching `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`. |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | every column classified. jsonb (`target_spec`, `branding`, `sender_session`) → `excludedOpen`. `body`/`title` text → `included` (customer data, same class as `ticket_comments.content`). Org erasure deletes org-owned batches; **partner-owned batches have `org_id NULL` and survive an org erasure** (`tenantCascade.ts` deletes `WHERE org_id = <org>`). That content belongs to the partner, and its per-device deliveries and receipts do cascade; partner-owned batches are removed on partner offboarding (`services/tenantOffboarding.ts` must list them) and by the retention job. Status/timestamps/ids → `included`. No column name matches `SUSPICIOUS_NAME_PARTS`; if one does, `reviewedIncluded`. |
| Ticket-move contracts (`services/ticketOrgMoveLockOrder.ts`, `routes/devices/core.ts`, `moveOrg.coverage.test.ts`) | **`ticket_id` is not added until W3** (W2 conversations are unbound), because a table with `ticket_id` + `org_id` triggers the coverage test (`moveOrg.coverage.test.ts:565`, `INTENTIONALLY_NOT_REWRITTEN`). A conversation also has a `device_id`, and `CUSTOM_ORG_REWRITE_TABLES` excludes `device_id` tables (`routes/devices/core.ts:437`), so rewriting its org on a ticket move would split it from its device and messages. W3 rule: a ticket org-move **detaches** its conversations (`ticket_id = NULL`) instead of moving them, and the table goes in `INTENTIONALLY_NOT_REWRITTEN` with that ruling. |
| `AUDIT_ADMIN_REQUIRED_TABLES` | **Not registered.** Decision: no DB-level append-only. See below. |

**Append-only / immutability.** Not recommended. DB-level append-only (REVOKE + trigger) forces `AUDIT_ADMIN_REQUIRED_TABLES` and breaks org erasure unless run with the audit admin role. Immutability is achieved at the app layer (no edit/delete endpoints) and the evidentiary record is the `audit_logs` row (hash) plus the delivery row. If the owner wants chat as consent-adjacent evidence, revisit (OD-1).

**Retention.** A worker (system context, `withSystemDbAccessContext`) nulls `body`/`title` on batches and conversation messages older than the retention window (proposed 90 days, partner-configurable later) and deletes delivery rows after 13 months. `device_commands.payload` also carries the body today because the command payload is the transport; whether the existing reaper removes terminal-command payloads soon enough is **not verified** here and must be checked in W1. If not, redact the body from the command row on terminal status.

**Other tenancy notes.** `device_commands` is intentionally system-scoped (agent WS path); that is why delivery status lives in a tenant-scoped table rather than being read back from commands. All new route handlers use `withDbAccessContext`; fan-out workers use `withSystemDbAccessContext`. New config-ish table: org setting `endpoint_messaging` (enabled, allow_user_reply, ticket policy, default expiry) belongs with Helper settings (`services/helperSettings`, `docs/agents/settings.md`): one concept, one home, partner default → org override.

## Out of scope

- End-user-initiated chat by default, anonymous intake, and any queue of unsolicited user messages.
- Teams, Slack, Entra identity adapters, and a per-org "default channel" setting beyond the stored `channel` column.
- Images, logos, attachments, file transfer, voice, video, rich HTML in messages.
- Using chat as remote-access consent. Consent stays in the existing consent flow.
- AI-driven live chat with end users.
- Portal-originated messaging; showing broadcasts in the portal.
- Scheduled / recurring / templated broadcasts (a follow-up once W1 proves the primitive).
- Reaching devices with no helper installed other than the native fallback toast.
- Mobile (iOS/Android) targets.
- Extending the Assist helper to RDS non-console sessions, macOS or Linux (OD-14).
- Localization of operator-written message text. Fixed chrome (sender slot, buttons) follows the helper's localization from the branding spec; all seven locales per the repo's locale-parity rule when web strings are added.

## Open Decisions

Each lists options and a recommendation.

**OD-1. Persist message bodies, or keep an ephemeral delivery-only record?**
- (a) Persist body + delivery rows with a retention job. Pros: operators can see what was sent, resend, audit disputes ("you never told us"); needed for offline replay and sticky replay. Cons: PII at rest, export/erasure surface, one more retention job.
- (b) Ephemeral: body lives only in the queued command, DB keeps metadata (counts, hash, status). Pros: minimal PII. Cons: no history UI, no resend, no dispute evidence, body still sits in `device_commands.payload` anyway.
- **Recommend (a)** with 90-day body retention and hash-only audit rows. For W2 chat, the same (conversation text is the work product). Revisit append-only only if the owner wants chat as evidence.

**OD-2. Ticket-bound chat only, ad-hoc chat, or both? (the #8292 comment vs the original request)**
- (a) Ticket-bound only (contributor). Pros: one canonical record, no parallel queue, clean timeline. Cons: breaks pre-access ad-hoc contact, cannot cover #8293, forces ticket noise.
- (b) Ad-hoc only. Pros: simplest. Cons: no ticket link, a second place support context lives.
- (c) Both: nullable `ticket_id`, org policy `optional|required|off`, transcript mirrored to the ticket at close (W3).
- **Recommend (c).** W2 ships ad-hoc; W3 adds binding and the `required` policy. Mirror a single internal-by-default transcript comment at close, not a comment per line (OD-2b: per-line mirroring is the alternative if owners want a live timeline; it needs a notification-suppression source on `ticket.commented`).

**OD-3. Can the end user reply or start a chat by default? Org toggle?**
- (a) Tech-only, no replies. (b) Replies inside a tech-opened conversation, no user-initiated start. (c) User may also start.
- **Recommend (b)** as default, with org toggle `allow_user_reply` (default on) and `allow_user_initiated` (default off, not built in W2; leaving the field out of W2 avoids a half-feature). Message cards in W1 are read/ack only.

**OD-4. Rate limits, abuse controls, phishing-look-alike risk.**
A branded popup is the exact shape of a phishing lure, and a compromised technician account can push one to thousands of PCs.
- Controls (proposed, tune from data): permission `endpoint_messages:send` separate from `devices:execute`; partner trust gating via `GATED_COMMAND_TYPES`; per-actor 20 sends/hour, per-partner 10 000 device-deliveries/hour, per-device 1 `critical` per 5 minutes; fan-out above 100 devices requires a confirm step showing the exact card and target count (and MFA step-up if the org already requires it for bulk actions); title 120 / body 2000 chars; https links only with visible host, no images/HTML, rendering through `safeMarkdown`; fixed unforgeable sender slot; org-level optional link allowlist; AI sends always need approval.
- **Recommend all of the above** for W1. The numbers are starting points, not measured.

**OD-5. Offline queueing and expiry.**
- (a) Queue until `expiresAt` or class TTL (168 h), then drop. (b) Never queue; only online devices (`live`). (c) Queue with a hard max regardless of expiry.
- Considered: a stale "phones are down" shown a day later is wrong, but "contact us when you're back" is right. **Recommend (a)**, with the sender choosing expiry at compose time and a default expiry (proposed 24 h; "until closed" selectable up to the 168 h cap). Expired = never shown, delivery row `expired`. A device that is online without a helper: fail and show retry; do not hold in the agent.

**OD-6. Which helper surface renders it?**
- (a) Native `user_helper` toast only. Pros: works today, no helper change. Cons: not persistent or branded, no replies.
- (b) Assist card window only. Pros: persistent, branded, replies. Cons: devices without a current Assist get nothing.
- (c) Assist card window, native toast/dialog fallback when no Assist advertises messaging.
- **Recommend (c)** with new scope `ScopeMessaging` (not `consent_ui`, not `notify`). Chat requires Assist and has no native fallback.

**OD-7. Branding source.**
- (a) Reuse the runtime-branding chain (partner default → org override, `companyName`/`displayName`/colours), snapshotted per batch. (b) Per-message free-text "from" name.
- **Recommend (a).** (b) defeats the point (user knows it's their MSP). Depends on the Phase 2 branding work (#7567 / #8277 lineage) landing; until then W1 uses partner name only, rendered in the fixed slot. Logos deferred.

**OD-8. Multi-target fan-out limits and partner-wide scope.**
- Options: explicit device/site/group/org targets, "all orgs", and mixtures. Ownership: org-owned batch when one org, partner-owned when several.
- **Recommend** partner-wide ("all orgs") gated by `canManagePartnerWidePolicies`; multi-org explicit selections allowed for partner users whose org access covers every resolved device. Hard cap per batch 5 000 devices in W1 (above that requires the partner-wide gate). Targets are resolved once at send time, never re-evaluated (a device that joins later does not receive an old broadcast).
- Open sub-question for the owner: should org-scoped users see partner-wide messages delivered to their devices? Recommend yes, delivery-scoped via the EXISTS branch in Tenancy.

**OD-9. AI tool exposure and approval tier.**
- (a) No AI tool. (b) Tool with auto-execute. (c) Tool, always human approval, tight rate limit.
- **Recommend (c)** for one-way messages. No AI chat in W2.

**OD-10. Portal visibility.**
- (a) Never. (b) Ticket-bound transcripts appear in the portal ticket view (W3). (c) Broadcast history in the portal.
- **Recommend (a) for W1/W2, (b) for W3** only when mirrored as a public comment; (c) rejected: broadcasts have no requester.

**OD-11. Browser-side delivery of user replies in W2.**
No existing realtime channel into the web console is verified by this spec. Options: reuse an existing SSE/WS channel if one exists, or poll. **Recommend** the W2 plan confirms the existing channel first; polling at 3 s on an open conversation is the floor.

**OD-12. Message-type naming and `notify_user`.**
Options: extend `notify_user` with persistence, or add `deliver_message`. **Recommend** the new type; `notify_user` stays the lightweight toast and gets registered in `CommandTypes` (it is currently unqueueable) only if a use arises. Extending it would change a shipped agent contract for a different semantic.

**OD-13. Agent minimum version gating.**
An agent that predates `deliver_message` refuses it as an unknown type. **Recommend** the API checks `devices.agentVersion` and marks the delivery `failed:agent_unsupported` instead of queueing a command that can only fail; the batch view shows the count.

**OD-14. Platform coverage.**
Assist is Windows-only and console-session-only (`broker.go:2735`). Options: (a) accept: cards and chat on the Windows console session, native fallback elsewhere, no chat on macOS/Linux/RDS; (b) first extend Assist to RDS/macOS/Linux (large, security-sensitive); (c) build a native chat dialog in `user_helper`. **Recommend (a)** for W1 and W2, with the limit shown in the compose UI (per-device capability column) so a technician knows before sending; (b)/(c) are separate specs. This materially limits #8292 on non-Windows fleets, which the owner should weigh before approving W2.

Codex dissent: see "Quorum" below.

## Test & rollout notes

**Red-first test plan (per wave).**
- API unit: target resolution (device/site/org/all-orgs), per-device authorization failure leaves other targets intact, permission and `canManagePartnerWidePolicies` gating, content validation (length, links, no HTML/images), rate limits, expiry maths with `deliverBy`, retraction, idempotent upstream events, agent-version gating.
- Registry contracts: new types present in `CommandTypes`, `GATED_COMMAND_TYPES` and the offline registry (the allowlist and registry tests fail closed); AI tool in tier/rate-limit/MCP-coverage registries; `SAFE_WRITE_SITES` line keys updated.
- RLS/integration (`pnpm test-stack up`, tear down with `pnpm test-stack down`; Integration Tests job): `endpoint_messages` dual-axis XOR, cross-partner forge 42501, org isolation, the EXISTS read branch, deliveries denormalized-org policy, `CORE_ORG_CASCADE_DELETE_ORDER` ordering, export-policy classification, org merge, device move. These fire only under **Integration Tests**, never Test API; run the full + contract suites before the PR.
- Agent (Go, `go test -race ./internal/...`): handler routes to the messaging scope, native fallback when absent, sticky store replay/expiry, per-Windows-session grouping (reuse `notify_targets` tests' shape), scope not granted without advertisement.
- Helper (Rust + Vitest): envelope compatibility with `agent/internal/ipc/protocol.go`, `message_show` window lifecycle, replay on restart, never shows the main window, card contents escaped.
- Web: compose form preview equals what the card renders; `runAction` for all mutations (`no-silent-mutations.test.ts`).
- Playwright E2E with `data-testid` only.

**Rollout.**
- Feature flag per partner, default off. W1 ships API + agent + helper + web together because the agent and helper are the product on the endpoint; the flag keeps API paths dark until the fleet has the new agent and Assist.
- The agent and helper ship to customer machines: full rigor (high blast radius). The envelope change is additive (new `typ` values only), so a mixed fleet degrades to the native fallback or `agent_unsupported`.
- Lab checks owed before release: Windows console plus a second RDS session (the second gets only the native fallback), macOS and Linux native fallback; helper restart replays a sticky card; no main-window pop on plain helper start (#8138 regression guard); message to a device with no helper; offline device then reconnect before and after expiry.
- Tear down any local stack brought up and say what was left running.
- Wave tracking: after approval, the orchestrator registers the feature and sub-issues; this PR does not.

### Quorum

An independent `codex exec` (gpt-6-astra, read-only, xhigh) reviewed the first draft and returned 13 findings. Twelve were confirmed against code and folded in:

- Partner-batch RLS cannot hide batches from selected-org partner users: app-layer filter specified. The exemption allowlist is frozen empty: suggestion removed.
- Ticket move vs device ownership: `ticket_id` deferred to W3 and a detach-on-move rule defined.
- Assist is Windows-only and console-only (`broker.go:2735`): platform coverage and OD-14 added, multi-session claim corrected, per-session receipts table added.
- Partner-batch content survives org erasure: rules stated.
- `safeMarkdown` does not give https-only or visible-host guarantees: wrapper required.
- Rate limits: route-level enforcement specified.
- `retract_message` and `chat_close` moved to lifecycle (ungated) so restricted partners can retract.
- Transcript mirroring does not fix mutability: wording corrected; the ticket comment is a copy.
- FK-order wording, `--show` citation and event idempotency key corrected.

Codex dissent: the ticket-binding evaluation (OD-2) rests partly on inference. Codex marked as uncertain that pre-access contact must be ticketless and that broadcast requirements argue against chat-only ticket binding. The spec now labels those points as inferred. Unresolved: whether W2 ships ad-hoc before W3 or requires tickets from the start is the owner's call.
