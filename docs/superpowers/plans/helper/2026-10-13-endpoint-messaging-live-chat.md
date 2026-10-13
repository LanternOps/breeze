# Endpoint Messaging + Live Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician push a branded, acknowledgeable message to the person at a device (#8293), then hold a technician-initiated live chat with that person (#8292), without starting remote access.

**Architecture:** Reuse the existing `device_commands` → agent → session-broker IPC → helper pipeline. W1 turns the dormant `notify_user` command into a queueable, persistent-card message (additive payload, new IPC scope `messaging`, native fallback). W2 adds tenant-scoped persistence (batch, per-device delivery, receipt tables), the batch status UI, retention and the approval-gated AI tool. W3 adds ad-hoc chat on the same transport and helper card window. Org-scoped only in v1; partner-wide is a follow-up.

**Tech Stack:** Hono/TypeScript API (Vitest), Drizzle (queries only) + hand-written SQL migrations, Go agent (`go test -race`), Tauri/Rust + React helper, Astro/React web with `runAction`.

**Spec:** `docs/superpowers/specs/helper/2026-10-12-endpoint-messaging-and-live-chat-spec.md` (PR #8505). Spec recommendations are DECIDED unless listed under Open Decisions as a deviation.

**Tracking:** Not registered. The orchestrator registers the feature and sub-issues after owner review; this document is docs-only.

## Global Constraints

- Migrations: first slot `apps/api/migrations/2026-12-25-210000-…`, then `-210100-`, `-210200-`. Newest known on `origin/main` when written: `2026-12-25-110000-caller-verification-link-tier.sql`; another plan holds `2026-12-25-2000NN`, so stay at 210000+. Re-run `git ls-tree --name-only origin/main apps/api/migrations/ | tail` before creating each file and rename upward if something newer exists. Idempotent, no inner `BEGIN;`/`COMMIT;`, `SELECT set_config('breeze.scope','system',true);` before any write, never edit a shipped migration.
- Tenancy: unprivileged `breeze_app`; RLS enabled + forced + policies in the creating migration; every composite FK touching `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`; request path uses `withDbAccessContext`, workers use `withSystemDbAccessContext` (call `runOutsideDbContext` first from inside a request). Read `docs/agents/tenancy-rls.md` and `apps/api/migrations/README.md` before Task 2.1.
- Tests: `cd apps/api && npx vitest run <file>` (never `--` before flags; paths are substring matches). Go: `cd agent && go test -race ./internal/<pkg>/...`. Web: `cd apps/web && npx vitest run <file>`.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo exit=$?` (same for `apps/web`). Read the exit code; never pipe tsc to `tail`.
- Web: every POST/PUT/PATCH/DELETE goes through `runAction` (`apps/web/src/lib/runAction.ts`; guarded by `no-silent-mutations.test.ts`). Transient UI state in `window.location.hash`. Each new en locale key is added to all 7 locales under `apps/web/src/lib/i18n` (`localeParity.test.ts`).
- Content limits (shared validator, enforced API + helper): title ≤ 120, body ≤ 2000, severity `info|warning|critical`, https links only, no images, no HTML.
- Public repo: no customer names, hostnames, IPs or session IDs in code, commits, PR bodies.
- Agent and helper ship to customer machines: high blast radius, full rigor on W1 agent/helper tasks and every tenancy task.
- Settings rule 9 (PR template): the `endpoint_messaging` setting has one home (Helper settings, `services/helperSettings`), level partner default → org override; configured in 0 places before, 1 after.
- Stacked PRs (base ≠ `main`) run no CI. Each wave PR is based on `main` and opened only after the previous wave merged. If a wave must be stacked, dispatch `gh workflow run CI --ref <branch>`. The tenancy-cascade/export suites fail only under **Integration Tests**, never Test API.

## Review Focus

Failure modes the spec implies but no obvious task test covers; each is pinned by a test in the named task.

1. Plain Assist start with nothing pending must never show a window (#8138 regression). Task 1.8.
2. A `selected`-access partner user choosing devices across several orgs: per-org split, no row visible outside their access. Task 1.3.
3. Old agent receiving the message type: must never queue (version gate) and must not silently report success after showing a transient toast. Tasks 1.2, 1.3.
4. Sticky card replay after helper restart for already-acked or expired messages must NOT reappear. Tasks 1.6, 1.8.
5. Body text lingering in `device_commands.payload` after retention/terminal status. Task 2.6.
6. Link label that looks like a different URL; `javascript:`/`http:` links; markdown image syntax. Task 1.7.
7. Same technician/`messageId` retried (double click, network retry) must not create two cards. Tasks 1.3, 1.5.

---

# Wave 1: One-way message + acknowledgement

**Ships independently.** Platform scope stated plainly: the persistent branded card is rendered by the Assist (Tauri) helper, which is **Windows-only and console-session-only** (`agent/internal/sessionbroker/broker.go` ~2735, "assist role requires the active console session"). RDS non-console sessions, macOS and Linux get the existing native fallback (`ipc.TypeNotify`, blocking prompt for `critical`). There is no persistent card, ack or replay there. The compose UI shows a per-device capability column so the technician knows before sending.

**What W1 leaves behind if W2 never ships:** a working send-and-acknowledge feature with no history table. Per-device outcome is visible in the send response (command result) and in `audit_logs` (send audit row with body hash; ack/dismiss events as audit rows). No batch list, no resend, no AI tool, no body retention problem (bodies live only in the command payload, which the existing reaper governs; Task 2.6 verifies). It is a complete, safe, smaller feature.

**Decision recorded (deviation to review, see Open Decisions N1):** the brief for this plan says W1 reuses the `notify_user` command; the spec (OD-12) recommends a new `deliver_message` type. This plan follows the brief: W1 registers `notify_user` in `CommandTypes`/offline registry (closing the "agent can toast, nothing can ask it" gap) and extends its payload **additively**. Old agents ignore unknown keys and would show a transient toast and report success, which is why the min-version gate (Task 1.2) is mandatory and why W1 never queues to an agent below the gate. If the owner prefers the spec's separate type, Tasks 1.1/1.2/1.4 change by a mechanical rename; nothing else moves.

## Task 1.1: Register `notify_user` as a queueable command type

**Files:**
- Modify: `apps/api/src/services/commandTypes.ts` (add `NOTIFY_USER: 'notify_user'` next to the other user-helper types)
- Modify: `apps/api/src/services/commandOfflinePolicy.ts` (add to `STANDARD_REVIEWED`, ~line 275; offline class `standard`, capped per message by `expiresAt`, see Task 1.3)
- Verify only: `apps/api/src/services/partnerTrust.ts:129` (already in `GATED_COMMAND_TYPES`; do not add to lifecycle)
- Test: `apps/api/src/services/commandOfflinePolicy.test.ts` (existing registry/fail-closed tests)

**Interfaces:**
- Produces: `CommandTypes.NOTIFY_USER`; `defaultOfflinePolicy('notify_user')` returns `{ kind: 'queue', deliverWithinMs: <standard TTL> }`.

- [ ] **Step 1: Write the failing test** (append to `commandOfflinePolicy.test.ts`)

```ts
it('registers notify_user as a standard queueable type and keeps it partner-trust gated', () => {
  expect(Object.values(CommandTypes)).toContain('notify_user');
  expect(defaultOfflinePolicy('notify_user').kind).toBe('queue');
  expect(GATED_COMMAND_TYPES).toContain('notify_user');
  expect(LIFECYCLE_COMMAND_TYPES).not.toContain('notify_user');
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts` → FAIL (`UnregisteredCommandTypeError: notify_user`).
- [ ] **Step 3: Implement** the two one-line registrations above.
- [ ] **Step 4: Run the registry/allowlist suites** — `npx vitest run src/services/commandOfflinePolicy.test.ts src/services/partnerTrust` → PASS. Confirm the "every `CommandTypes` value is explicitly classified" test is green.
- [ ] **Step 5: Confirm the trust capability mapping** (the spec flags it unverified). Read `partnerTrust.ts` `device_execute` branch (~line 237) and the call site that passes `commandType`; add a test asserting a `probation` partner is denied `notify_user` and allowed `script_cancel`. If the mapping is a different capability, fix the test to match reality and record the finding in the PR body.
- [ ] **Step 6: Commit** — `feat(api): register notify_user as a queueable command type (#8293)`.

## Task 1.2: Agent minimum-version gate for message payloads

**Files:**
- Create: `apps/api/src/services/commandMinVersion.ts` — `export const COMMAND_MIN_AGENT_VERSION: Readonly<Record<string,string>>` and `export function agentSupportsMessaging(agentVersion: string | null): boolean`
- Test: `apps/api/src/services/commandMinVersion.test.ts`

**Interfaces:**
- Produces: `agentSupportsMessaging(v): boolean` (false for null/unparseable/dev builds below the gate; the gate value is the first agent release containing Task 1.4, set in Task 1.10 once the version is known).

- [ ] **Step 1: Locate the existing semver comparison.** Run `grep -rn "agentVersion" apps/api/src/services/agentEditionCompat.ts apps/api/src/services/agentRollback.ts | head`. Reuse its comparator; if none is exported, extract it (do not hand-roll a second one).
- [ ] **Step 2: Failing test**

```ts
it('rejects null, garbage and older versions; accepts the gate and above', () => {
  expect(agentSupportsMessaging(null)).toBe(false);
  expect(agentSupportsMessaging('not-a-version')).toBe(false);
  expect(agentSupportsMessaging('0.0.1')).toBe(false);
  expect(agentSupportsMessaging(COMMAND_MIN_AGENT_VERSION.notify_user_messaging)).toBe(true);
});
```

- [ ] **Step 3: Run** `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts` → FAIL. **Step 4: Implement** with the reused comparator; placeholder gate constant `'0.0.0-unreleased'` is replaced in Task 1.10. **Step 5: PASS. Step 6: Commit.**

## Task 1.3: `POST /endpoint-messages` send route (stateless, W1)

**Files:**
- Create: `apps/api/src/routes/endpointMessages/index.ts` (exports `endpointMessageRoutes`, mounted in `apps/api/src/index.ts`), `routes/endpointMessages/send.ts`, `routes/endpointMessages/resolveTargets.ts`
- Create: `packages/shared/src/validators/endpointMessage.ts` (Zod: `endpointMessageSchema`, `messageTargetSchema`), exported from the package index
- Create: `apps/api/src/services/endpointMessaging/brandingSnapshot.ts`, `services/endpointMessaging/rateLimits.ts`
- Test: `apps/api/src/routes/endpointMessages/send.test.ts`, `resolveTargets.test.ts`, `packages/shared/src/validators/endpointMessage.test.ts`

**Interfaces:**
- Consumes: `queueCommandForExecution` (`services/commandQueue.ts`), `agentSupportsMessaging` (1.2), `defaultOfflinePolicy` (1.1), `requirePermission`, existing rate-limit service (`services/rate-limit`, Redis).
- Produces: `POST /api/v1/endpoint-messages` body `{ messageId: uuid, targets: { deviceIds?: uuid[], siteIds?: uuid[], deviceGroupIds?: uuid[], orgId?: uuid }, title, body, severity, requiresAck, expiresInMinutes: number|null, confirmedCount?: number }` → `200 { batchId, results: [{ deviceId, orgId, status: 'queued'|'failed', commandId?, errorCode? }] }`. `errorCode ∈ agent_unsupported | no_permission | offline_rejected | rate_limited | cap_exceeded`.
- Produces: `resolveTargets(auth, targets) → { orgId: string; deviceIds: string[] }[]` — grouped per org, each org validated against the caller's access. Selected-access partner users get one group per org; no partner-owned artifact exists anywhere in W1 (partner-wide is a follow-up, Open Decision N4).

**Behaviour to implement (each with a test first):**
1. Permission `endpoint_messages:send` (granted in Task 1.9). Fan-out above 100 devices requires `confirmedCount === resolved device count` (else 409 `confirmation_required`, returning the count). Hard cap 5 000 devices (`cap_exceeded`); the partner-wide gate that would lift the cap is out of scope.
2. Targets resolve once at send time (snapshot). Per-device authorization failure marks that device `failed:no_permission` and leaves other targets intact.
3. Idempotency: `messageId` is a client-generated UUID; Redis `SET NX` on `(actorId, messageId)` for 24 h; a replay returns the first response, never a second card (Review Focus 7).
4. Rate limits (OD-4, starting values): 20 sends/hour/actor, 10 000 device-deliveries/hour/partner, 1 `critical` per device per 5 minutes. Enforced in the route via `services/rate-limit` regardless of AI origin.
5. Version gate: devices with `!agentSupportsMessaging(device.agentVersion)` get `failed:agent_unsupported` and are not queued.
6. Branding snapshot resolved server-side at send time (partner default → org override via the existing runtime-branding resolver; W1 falls back to partner name only if the Phase 2 branding fields have not landed). Included in the command payload as `branding: { companyName, displayName, accent }`. The sender line is a helper-side fixed slot; the body can never replace it.
7. Queue one `notify_user` command per device with payload `{ title, body, urgency: severity, messageId, batchId, persistent: true, requiresAck, severity, expiresAt, branding, source: 'endpoint_message' }` and offline `deliverBy = min(expiresAt, standard TTL)`; default `expiresInMinutes = 1440`, `null` = "until closed" capped at the 168 h class TTL.
8. Audit: one `audit_logs` row per batch per org (actor, batchId, target mode, counts, severity, SHA-256 hash + length of body, **never the body**); `aiOrigin` threaded through `queueCommandForExecution` options.

- [ ] **Step 1: Write failing tests** (representative; write one per numbered behaviour above)

```ts
it('splits a selected-access partner user\'s cross-org selection into per-org groups and rejects orgs they cannot access', async () => {
  const groups = await resolveTargets(selectedPartnerAuth, { deviceIds: [devA1, devB1, devC1] });
  expect(groups.map(g => g.orgId).sort()).toEqual([orgA, orgB].sort()); // orgC not accessible
  expect(groups.flatMap(g => g.deviceIds)).not.toContain(devC1);
});

it('does not queue to an agent below the messaging gate', async () => {
  const res = await post(sendBody({ deviceIds: [oldAgentDevice] }));
  expect(res.results[0]).toMatchObject({ status: 'failed', errorCode: 'agent_unsupported' });
  expect(queueCommandForExecution).not.toHaveBeenCalled();
});

it('never writes the body to audit_logs, only its hash and length', async () => {
  await post(sendBody({ body: 'secret phone number 555' }));
  const row = auditInsert.mock.calls[0][0];
  expect(JSON.stringify(row)).not.toContain('secret phone number');
  expect(row.details.bodySha256).toMatch(/^[0-9a-f]{64}$/);
});

it('replaying the same messageId returns the first response and queues nothing new', async () => { /* … */ });
it('rejects http: links, images and html via the shared validator', () => { /* … */ });
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/endpointMessages` and `cd packages/shared && npx vitest run src/validators/endpointMessage.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** validator, `resolveTargets`, `send.ts` per behaviours 1–8; mount `endpointMessageRoutes` in `index.ts`.
- [ ] **Step 4: Run both suites** → PASS. **Step 5:** typecheck API with the 12 GB command in Global Constraints; exit code must be 0.
- [ ] **Step 6: Contract greps** — `grep -rn "endpointMessageRoutes" apps/api/src/index.ts`; run `npx vitest run src/routes/routeParity src/__tests__` style contract suites that enumerate routes (find with `grep -rln "routeParity\|route-coverage" apps/api/src | head`) and fix any registration they demand.
- [ ] **Step 7: Commit** — `feat(api): send endpoint messages via notify_user with version gate, caps and audit (#8293)`.

## Task 1.4: Agent — `ScopeMessaging` and the `notify_user` handler

**Files:**
- Modify: `agent/internal/ipc/message.go` (add `ScopeMessaging = "messaging"`, `AuthRequest.SupportsMessaging bool`, grant rule mirroring `ScopeConsentUIFallback`/`SupportsConsentUI` at ~lines 192-197, 232-238; message types `TypeMessageShow`, `TypeMessageRetract`, `TypeMessagePresented`, `TypeMessageAck`, `TypeMessageDismissed`; payload structs `MessageShow{MessageID,BatchID,Title,Body,Severity,RequiresAck,ExpiresAt,Branding}`)
- Modify: `agent/internal/sessionbroker/broker.go:225` — `assistHelperScopes` gains `ipc.ScopeMessaging` **only when the helper advertised it** (granted per session at auth, not statically)
- Modify: `agent/internal/heartbeat/handlers_user.go` — branch in `handleNotifyUser`: when payload `source == "endpoint_message"` and an Assist session with `ScopeMessaging` exists, send `TypeMessageShow`; else fall back to the existing `ipc.TypeNotify` path (add `FallbackDialog: severity=="critical"` and `TimeoutMs`; the fields exist at `ipc/message.go:297`). Result map gains `surface: "assist"|"native"`.
- Create: `agent/internal/heartbeat/message_store.go` (+ `_test.go`): small on-disk store keyed by `messageId` holding sticky unexpired unacked messages, pruned on expiry, 0600 perms, in the agent data dir next to `helper_config.yaml`
- Test: `agent/internal/ipc/message_test.go`, `agent/internal/heartbeat/handlers_user_test.go`, `agent/internal/sessionbroker/broker_notify_test.go`

**Interfaces:**
- Produces: result JSON `{ delivered: bool, surface: "assist"|"native", uid, username }`; store API `Put(m)`, `Pending(now) []MessageShow`, `MarkTerminal(messageID, state)`.

- [ ] **Step 1: Failing tests**

```go
func TestMessagingScopeNotGrantedWithoutAdvertisement(t *testing.T) { /* AuthRequest{Role:assist, SupportsMessaging:false} → scopes lack ScopeMessaging */ }
func TestNotifyUserMessageUsesAssistWhenAdvertised(t *testing.T)    { /* TypeMessageShow sent, surface=="assist" */ }
func TestNotifyUserMessageFallsBackToNativeAndNeverClaimsAssist(t *testing.T) { /* no assist session → TypeNotify, surface=="native", FallbackDialog for critical */ }
func TestStoreDropsExpiredAndTerminalOnPending(t *testing.T)         { /* Review Focus 4 */ }
func TestNotifyUserWithoutMessageSourceIsUnchanged(t *testing.T)     { /* legacy payload path byte-identical */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/ipc/... ./internal/heartbeat/... ./internal/sessionbroker/...` → FAIL (undefined symbols).
- [ ] **Step 3: Implement** scope + types + handler branch + store. Do **not** change the envelope (`protocol.go` HMAC framing stays byte-identical; only new `typ` values).
- [ ] **Step 4: Run** the same `go test -race` command → PASS. Also `cd agent && go vet ./internal/ipc/... ./internal/heartbeat/... ./internal/sessionbroker/...`.
- [ ] **Step 5: Commit** — `feat(agent): messaging IPC scope and persistent notify_user path with native fallback (#8293)`.

## Task 1.5: Agent → API message events route (ack/dismiss/displayed)

**Files:**
- Create: `apps/api/src/routes/agents/messageEvents.ts` (pattern: `routes/agents/elevationRequests.ts`), registered where other agent routes are mounted
- Modify: `agent/internal/heartbeat/` — emit events from `TypeMessagePresented/Ack/Dismissed` to `POST /api/v1/agents/{id}/message-events` (reuse the agent HTTP client the elevation-request path uses)
- Test: `apps/api/src/routes/agents/messageEvents.test.ts`, `agent/internal/heartbeat/message_events_test.go`

**Interfaces:**
- Produces: `POST …/message-events` body `{ messageId, batchId, eventType: 'displayed'|'acknowledged'|'dismissed'|'expired', session: { username, sid?, winSessionId? }, at }`; agent-authenticated (device token), identity of the acting user is agent-attested, so the helper token (`helperAuth`) is deliberately not used. W1 sink: an `audit_logs` row (device-scoped, org resolved from the device); idempotent via Redis `SET NX` on `(messageId, sessionKey, eventType)` 7 days. W2 (Task 2.4) replaces the sink with `endpoint_message_receipts` and a DB unique constraint.

- [ ] **Step 1: Failing test** — duplicate event with same key returns 200 and writes one audit row; an event whose `messageId` was never sent to that device is rejected 404 (cross-device forge); event from device A cannot name device B's org.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/agents/messageEvents.test.ts` → FAIL. **Step 3: Implement. Step 4: PASS** + agent test with `go test -race ./internal/heartbeat/...`.
- [ ] **Step 5:** run the agent-route contract tests (`agentRoleCoverage.test.ts`, `agentAuthSkip.test.ts` in `routes/agents/`) and register the route as they require.
- [ ] **Step 6: Commit** — `feat(api,agent): agent-attested message event upstream route (#8293)`.

## Task 1.6: Helper — `message_show` card window, ack/dismiss, replay

**Files:**
- Modify: `apps/helper/src-tauri/src/ipc/client.rs` (dispatch `message_show`/`message_retract` next to `consent_request`/`banner_show`, ~line 313+; send `message_presented/ack/dismissed`), `apps/helper/src-tauri/src/ipc/desktop.rs` (new `show_message_window` modelled on `show_consent_window`/`show_banner_window`, ~148/232), `apps/helper/src-tauri/src/ipc/envelope.rs` (**no framing change**; add only a byte-compat test for the new `typ` strings against `agent/internal/ipc/protocol.go`)
- Create: `apps/helper/src-tauri/src/ipc/message.rs` (+ unit tests), `apps/helper/src/components/MessageCard.tsx` (+ `MessageCard.test.tsx`)
- Modify: auth handshake to send `SupportsMessaging: true`

**Surfacing rules (from spec, table "When a message may surface the hidden helper"):** the main window is never shown for a message. `info` → card without focus, tray badge; `warning`/`critical`/`requiresAck` → topmost card, `critical` may take focus at most once per device per 5 minutes; replay only sticky + unexpired + unacked messages on helper start (the agent resends them after the helper authenticates; the helper itself stores nothing); helper start with nothing pending shows nothing.

- [ ] **Step 1: Failing tests** — Rust: `launch_requests_window`-style test asserting a `message_show` never calls the main-window show path; focus rate limit; Vitest: `MessageCard` renders the fixed sender slot ("From <companyName>") and "Sent by your IT provider" footer and that body text cannot replace the slot; an ack click emits `message_ack` once.
- [ ] **Step 2: Run** `cd apps/helper/src-tauri && cargo test ipc::message` and `cd apps/helper && npx vitest run src/components/MessageCard.test.tsx` → FAIL.
- [ ] **Step 3: Implement. Step 4: Run both → PASS. Step 5:** `cargo test envelope` byte-compat test green against the Go fixture.
- [ ] **Step 6: Commit** — `feat(helper): branded persistent message card window (#8293)`.

## Task 1.7: Message-specific safe renderer

**Files:**
- Create: `apps/helper/src/lib/messageMarkdown.tsx` (wrapper over `safeMarkdown.tsx` primitives), test `apps/helper/src/lib/messageMarkdown.test.tsx`
- Reuse validation: `packages/shared/src/validators/endpointMessage.ts`

The existing `isSafeHttpUrl`/`SafeMarkdownLink`/`SafeMarkdownImage` accept `http:` and arbitrary link labels, so they do not meet the guarantees. This wrapper enforces: https only, no images or HTML (rendered as plain text), a link whose label looks like a URL/host different from the real host shows the real host instead, host always visible, links open via the opener plugin in the default browser, never the privileged webview; oversized or invalid content renders as plain text (defence in depth).

- [ ] **Step 1: Failing tests** (Review Focus 6): `[https://bank.example](https://evil.example)` renders host `evil.example`; `[x](javascript:alert(1))`, `[x](http://a.b)` render as text; `![i](https://a.b/i.png)` and `<img onerror>` render as inert text; a 5 000-char body renders as plain text.
- [ ] **Step 2: Run** `cd apps/helper && npx vitest run src/lib/messageMarkdown.test.tsx` → FAIL. **Step 3: Implement. Step 4: PASS. Step 5: Commit** — `feat(helper): anti-phishing message markdown renderer (#8293)`.

## Task 1.8: #8138 regression guard and mixed-session lab checklist

**Files:**
- Modify: `apps/helper/src-tauri/src/lib.rs` tests (next to `launch_requests_window`, ~line 660)
- No new files; the lab checklist below goes in the W1 PR description.

- [ ] **Step 1: Failing test** — helper started with `--config` and zero pending messages: no window is built or shown; helper started and then sent `message_show`: only the `message` card label exists, `main` stays hidden.
- [ ] **Step 2: Run** `cd apps/helper/src-tauri && cargo test lib::` → FAIL → **Step 3** wire any missing guard → **Step 4** PASS.
- [ ] **Step 5: PR-body lab checklist (owed before release, record results in the PR):** Windows console session shows card and ack; a second RDS session gets only the native fallback; macOS and Linux native fallback; helper restart replays only a sticky unacked card; plain helper start shows nothing; device with no helper returns `no user helper connected` (delivery shown failed); offline device reconnects before and after expiry (after expiry: never shown).
- [ ] **Step 6: Commit** — `test(helper): guard Assist start-hidden against message surfacing (#8138, #8293)`.

## Task 1.9: Permission migration

**Files:**
- Create: `apps/api/migrations/2026-12-25-210000-endpoint-messages-permissions.sql` (re-check slot first, Global Constraints)
- Test: existing `migrationRlsScope.test.ts`, `pnpm db:check-drift`

Copy the grant predicate from `apps/api/migrations/2026-12-20-220100-sites-set-location-permission.sql` (match `r.name`, `r.scope`, `r.is_system = TRUE`, no `partner_id IS NULL` clause; existence-check insert into `permissions`; `ON CONFLICT DO NOTHING` into `role_permissions`). Permissions `endpoint_messages:send` and `endpoint_messages:read` granted to every system role that already holds `devices:execute`; Partner Admin holds `*:*`. `SELECT set_config('breeze.scope','system',true);` first.

- [ ] **Step 1: Failing test** — add to the permission-seed contract test (find: `grep -rln "sites.*set_location" apps/api/src | head`) assertions that both permissions exist and `Org Viewer` does not hold `send`.
- [ ] **Step 2: Run** that test → FAIL. **Step 3:** write the migration. **Step 4:** `cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts <permission test path>` → PASS; `pnpm db:migrate && pnpm db:check-drift` against the local DB.
- [ ] **Step 5: Commit** — `feat(api): endpoint_messages permissions (#8293)`.

## Task 1.10: Web — Send message dialog (multi-select) and gate value

**Files:**
- Create: `apps/web/src/components/endpointMessages/SendMessageDialog.tsx`, `MessagePreviewCard.tsx`, `apps/web/src/lib/endpointMessages.ts`; wire "Send message" into the device list multi-select, site and org pages
- Modify: `apps/web/src/lib/i18n/**` — **all 7 locales** for each new key
- Modify: `apps/api/src/services/commandMinVersion.ts` — set the real gate value to the agent release that carries Task 1.4
- Test: `SendMessageDialog.test.tsx`, `apps/web/src/lib/i18n/localeParity.test.ts`, `no-silent-mutations.test.ts`

Behaviour: compose form with live preview rendered by the same renderer contract (shared validator limits shown), severity, requires-ack, expiry (default 24 h, "until closed" up to 168 h), per-device capability column (Assist card vs native fallback vs unsupported agent) from device data, confirm step above 100 devices showing the exact card and count, result list from the send response. Submit uses `runAction`; selected tab/step state in `window.location.hash`. Rollout flag per partner (default off), read from the `endpoint_messaging.enabled` helper setting (Task 2.5 owns the settings UI; W1 reads a partner-level boolean from existing helper settings storage).

- [ ] **Step 1: Failing tests** — dialog posts via `runAction` (the guard test fails otherwise); preview text equals submitted text; over-100 selection requires the confirm step; locale parity fails until all 7 locales have the keys.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/endpointMessages src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts` → FAIL. **Step 3: Implement. Step 4: PASS. Step 5:** typecheck web (12 GB, read exit code).
- [ ] **Step 6: Commit** — `feat(web): send endpoint message dialog (#8293)`.

## Task 1.11: W1 docs and PR

- [ ] Run, in order: API typecheck, web typecheck, `cd agent && go test -race ./internal/ipc/... ./internal/heartbeat/... ./internal/sessionbroker/...`, helper cargo + vitest suites, `cd apps/api && npx vitest run src/services src/routes/endpointMessages src/routes/agents`.
- [ ] Open PR from branch `feature/<parent#>-endpoint-messaging/wave-<sub#>` based on `main`; body ends `Closes #<W1 sub-issue>`; includes the lab checklist from Task 1.8. One independent review round (agent/helper code ships to customer machines).

---

# Wave 2: Persistence, batch status, retention, AI tool

**Depends on W1 merged.** **What W2 leaves behind if W3 never ships:** a complete messaging product with history, resend, status view, retention and an approval-gated AI tool. W1's audit-row event sink is replaced by receipts; nothing chat-related exists.

**Tenancy shape (OD-8/15 resolved conservatively):** org-scoped only. `endpoint_messages` is `org_id NOT NULL`. Justification required by the Partner-Wide First rule: v1 sends always resolve to per-org groups (Task 1.3), so a partner-owned row never exists; a partner-wide "all orgs" send is a follow-up epic. Because no `partner_id` axis exists, OD-15 (partner-batch read RLS vs the frozen-empty `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`) does not arise in v1. **If partner-wide is later added, the dual-ownership playbook in `docs/agents/tenancy-rls.md` applies in full: XOR owner check, `breeze_current_partner_id()` SELECT-only branch, write gate `canManagePartnerWidePolicies`, worker fan-out by device org's partner, repo-wide `<table>.orgId` sweep. Spec OD-15 recommendation (b), partner-axis table plus per-delivery rendered snapshots, is the recorded starting point.** Retrofit cost is bounded because deliveries already carry the denormalized `org_id`.

**Hot vs cold:** `endpoint_messages` is cold (one row per send): direct `org_id` policy. `endpoint_message_deliveries` and `endpoint_message_receipts` are hot-write and device-scoped: **shape 5, denormalized `org_id` with a direct `breeze_has_org_access(org_id)` policy**, no EXISTS join policy, so neither goes in `DEVICE_ID_JOIN_POLICY_TABLES` (verify by running the harness).

## Task 2.1: Tables migration (tenancy-critical)

**Files:**
- Create: `apps/api/migrations/2026-12-25-210100-endpoint-messages-tables.sql` (re-check slot)
- Create: `apps/api/src/db/schema/endpointMessages.ts` (Drizzle query schema), export from `db/schema/index.ts`
- Test: `apps/api/src/__tests__/integration/endpointMessages.rls.integration.test.ts`

Read `docs/agents/tenancy-rls.md` and `apps/api/migrations/README.md` first. DDL requirements:
- `endpoint_messages(id uuid pk, org_id uuid NOT NULL → organizations, created_by uuid, target_mode text, target_spec jsonb, title text NULL, body text NULL, severity, requires_ack, expires_at, branding jsonb, ai_origin_* , body_sha256 text, body_purged_at timestamptz, created_at)`; `title`/`body` nullable because retention nulls them.
- `endpoint_message_deliveries(id, message_id → endpoint_messages ON DELETE CASCADE, org_id NOT NULL, device_id → devices, command_id, status text CHECK in ('queued','delivered','displayed','acknowledged','dismissed','expired','retracted','failed','superseded'), surface text, error_code, delivered_at, displayed_at, acked_at, dismissed_at, expires_at, created_at)`; indexes `(message_id, status)`, `(device_id, created_at)`; unique `(message_id, device_id)`.
- `endpoint_message_receipts(id, delivery_id → deliveries ON DELETE CASCADE, org_id NOT NULL, device_id, session_key, event_type, at)`; unique `(delivery_id, session_key, event_type)`; insert-only by app convention (no DB append-only, OD-1).
- Composite FKs touching `org_id` (if you add any, e.g. `(device_id, org_id)`) are `DEFERRABLE INITIALLY IMMEDIATE`.
- Per table: `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies using `breeze_has_org_access(org_id)` for USING and WITH CHECK; `GRANT` to `breeze_app`. All idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` then create).
- `SELECT set_config('breeze.scope','system',true);` at top (backfill of nothing, but required if any row is written).

- [ ] **Step 1: Failing integration test** (needs `pnpm test-stack up`; tear down with `pnpm test-stack down` when done and say what was left running):

```ts
it('breeze_app cannot insert a delivery whose org_id is another org (cross-tenant forge → 42501)', async () => {
  await expect(
    asOrg(orgA, (tx) => tx.insert(endpointMessageDeliveries).values({ messageId: msgOfOrgB, orgId: orgB, deviceId: devB, status: 'queued' })),
  ).rejects.toMatchObject({ code: '42501' });
});
it('org A cannot read org B messages, deliveries or receipts', async () => { /* all three tables */ });
it('forging device_id from org B with org_id = org A is rejected by the device/org consistency check', async () => { /* if a composite FK or trigger enforces it */ });
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/__tests__/integration/endpointMessages.rls.integration.test.ts` (on the test stack) → FAIL (tables missing).
- [ ] **Step 3: Write the migration + schema file. Step 4:** `pnpm db:migrate && pnpm db:check-drift`; rerun the integration test → PASS, including the forge-as-`breeze_app` case.
- [ ] **Step 5: Commit** — `feat(api): endpoint message tables with RLS (#8293)`.

## Task 2.2: Registrations (mechanical grep-then-edit, per table)

For **each** of `endpoint_messages`, `endpoint_message_deliveries`, `endpoint_message_receipts`, run the grep, then edit the file:

| Registry / file | Entries | Enforcing CI job |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts` | all three, alphabetical (`localeCompare`, `organizations` last); FK children first. `tenantCascade.integration.test.ts` computes FK order topologically, so trust the test over the names | **Integration Tests** |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` in `apps/api/src/routes/devices/core.ts` | deliveries, receipts (carry `device_id`) | Integration Tests (`moveOrg.coverage.test.ts`) and Test API (`cascadeDelete.test.ts`) |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) | deliveries, receipts | `moveOrg.coverage.test.ts` |
| `apps/api/src/services/orgMergeRegistry.ts` | `repoint` for all three | Integration Tests (org-merge suites) |
| `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` | every column classified: `title`/`body` `included` (customer data, same class as `ticket_comments.content`); `target_spec`, `branding` and any json/jsonb/bytea `excludedOpen`; ids/status/timestamps `included`; `reviewedIncluded` with justification for any column matching `SUSPICIOUS_NAME_PARTS` | **Integration Tests** |
| rls-coverage allowlists in `rls-coverage.integration.test.ts` | auto-discovered as direct-`org_id` tables; confirm none belong in `DEVICE_ID_JOIN_POLICY_TABLES`; `AUDIT_ADMIN_REQUIRED_TABLES` **not** registered (no DB-level append-only, OD-1) | **Integration Tests** |
| Org-move handling | deliveries/receipts follow the device (denormalized `org_id` rewrite); `endpoint_messages` stays in the source org, so `message_id` must be an org-agnostic FK (no composite with `org_id`). Confirm the exact outcome against `moveOrg.coverage.test.ts` and record it in the PR (Open Decision N5) | `moveOrg.coverage.test.ts` |

- [ ] **Step 1: Grep, don't judge:** `grep -rn "endpoint_message" apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts` → must show nothing (red).
- [ ] **Step 2: Run the contract suites to see them red** on the test stack: `cd apps/api && npx vitest run src/services/tenantCascade.integration.test.ts src/services/tenantExportPolicyRegistry src/routes/devices/moveOrg.coverage.test.ts src/__tests__/integration/rls-coverage.integration.test.ts` (use the exact paths from `docs/agents/testing.md`; substring matches).
- [ ] **Step 3: Edit the registries above. Step 4: Re-run → green.** Then run the full integration shard set per `docs/agents/testing.md` (always required when tenancy/cascade code is touched). Tear down `pnpm test-stack down`.
- [ ] **Step 5: Commit** — `feat(api): register endpoint message tables in cascade, merge, export and move contracts (#8293)`.

## Task 2.3: Persist on send, delivery state machine, batch list/detail/retract/resend routes

**Files:**
- Modify: `routes/endpointMessages/send.ts` (insert batch + delivery rows in a system-context chunked worker for > 200 devices; otherwise in-request), create `routes/endpointMessages/list.ts`, `detail.ts`, `retract.ts`, `resend.ts`; `services/endpointMessaging/deliveryState.ts` (legal transitions only; terminal states are final)
- Register `retract_message` in `CommandTypes`, offline registry (short TTL) and **`LIFECYCLE_COMMAND_TYPES`** (carries no operator content, so a restricted partner can still retract); add agent handler (extends Task 1.4 store: `MarkTerminal(retracted)` and `TypeMessageRetract` to helper)
- Test: `deliveryState.test.ts`, `list.test.ts`, `retract.test.ts`

Rules: command result updates delivery to `delivered`/`failed`; events route (Task 2.4) drives `displayed/acknowledged/dismissed`; reaper/expiry marks `expired`; retract of a still-queued command cancels it; states never regress (e.g. `acknowledged` never returns to `delivered`).

- [ ] **Step 1: Failing tests** — transition table (legal and illegal), list returns only the caller's org batches, retract is allowed for a restricted partner (lifecycle), resend creates a new `messageId`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/endpointMessaging src/routes/endpointMessages` → FAIL. **Step 3–4:** implement, PASS. **Step 5:** trust-allowlist test (`partnerTrust`) updated with `retract_message` in lifecycle. **Step 6: Commit.**

## Task 2.4: Events route writes receipts

**Files:** Modify `routes/agents/messageEvents.ts` (swap the Redis+audit sink for `endpoint_message_receipts` inserts using `ON CONFLICT (delivery_id, session_key, event_type) DO NOTHING`, and aggregate into `deliveries.status` via `deliveryState.ts`); test `messageEvents.test.ts`.

- [ ] **Step 1: Failing test** — duplicate event inserts one receipt; two sessions' acks produce two receipts and the delivery aggregate is `acknowledged`; event for a delivery of another device is 404.
- [ ] **Step 2: Run → FAIL. Step 3–4: implement → PASS. Step 5: Commit.** Keep a one-release fallback: events for messages sent before W2 (no delivery row) still land as audit rows.

## Task 2.5: Settings + batch status UI

**Files:** `services/helperSettings` (add `endpoint_messaging { enabled, allowUserReply, defaultExpiryMinutes }`, partner default → org override; read `docs/agents/settings.md` first and register in the settings page registry per `settingsPageRegistry.test.ts`); web `EndpointMessagesPage` (batch list, detail with per-device status, retry/resend/retract buttons), locale keys in all 7 locales, hash-based selected batch.

- [ ] **Step 1: Failing tests** — `settingsPageRegistry.test.ts` fails until registered; resend/retract buttons use `runAction`; `localeParity.test.ts`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/endpointMessages src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts settingsPageRegistry` → FAIL → implement → PASS. **Step 3:** typecheck web + API (exit codes). **Step 4: Commit.**

## Task 2.6: Retention worker and `device_commands.payload` redaction

**Files:** Create `apps/api/src/jobs/endpointMessageRetentionWorker.ts` (BullMQ, `withSystemDbAccessContext`); test beside it.

- 90-day retention: null `title`/`body` on batches (set `body_purged_at`), delete deliveries/receipts older than 13 months.
- **Verify first (spec says unverified):** does the existing `deviceCommands` reaper remove terminal-command payloads soon enough? Read the reaper; write a test that a terminal `notify_user` command row with `source: 'endpoint_message'` has its `title`/`body` redacted. If the reaper does not, redact on terminal status in the result handler (`routes/agents/commands.ts`).

- [ ] **Step 1: Failing tests** (Review Focus 5) — terminal command payload no longer contains the body; retention nulls only batches older than 90 days.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/jobs/endpointMessageRetentionWorker.test.ts src/routes/agents/commands.test.ts` → FAIL → implement → PASS. **Step 3: Commit.**

## Task 2.7: AI tool `send_endpoint_message` (approval-gated)

**Files (check each registry, don't judge):**
- Create: `apps/api/src/services/aiToolsMessaging.ts` (thin hub pattern, follow `aiToolsTicketing.ts` action style: `send`, `list`, `get`)
- Modify: `aiToolSchemas*.ts` (input schema), `aiGuardrails.ts` (tier tables: `send` is customer-visible and impersonation-adjacent → **always human approval**, same class as `manage_tickets:comment` at ~line 686; `list`/`get` read-only tier), `aiToolRateLimits.ts` (5 sends/hour/user; the tier multiplier at `aiGuardrails.ts` ~2844 means this alone is not enough, so the route's `services/rate-limit` enforcement from Task 1.3 stays authoritative), `aiAgentSdkTools.ts`, `services/aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts`
- Thread `aiOrigin` through the send service into `queueCommandForExecution`
- Tests: the contract suites `aiGuardrails.tier1WriteActions.contract.test.ts`, `aiGuardrails.readonly.contract.test.ts`, `aiGuardrailsTierParity`, `aiToolRateLimits.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts`, `aiTools.descriptionBudget.contract.test.ts`, plus new `aiToolsMessaging.test.ts`

Traps (both repo-documented): AI-tool contract tests key `SAFE_WRITE_SITES` by **line number**, so after edits update the keys to the shifted lines; and **never use `z.undefined()`** anywhere in a tool schema (it empties the model's tool list). Use optional/nullable fields instead. AI gets no live chat in W3.

- [ ] **Step 1: Failing tests** — `send` classified approval-required and not auto-executable; tool appears in rate-limit, MCP-coverage and agent catalog registries; a schema walk asserts no `ZodUndefined`; the executed send carries `aiOrigin`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/aiToolsMessaging.test.ts src/services/aiGuardrails src/services/aiToolRateLimits.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts` (each as separate path substrings) → FAIL → implement → PASS.
- [ ] **Step 3:** update `SAFE_WRITE_SITES` line keys; rerun the contract suites green. **Step 4:** typecheck API, exit 0. **Step 5: Commit.**

## Task 2.8: W2 verification and PR

- [ ] Full API suite plus contract suites on the test stack (`docs/agents/testing.md`), typecheck both apps, agent `go test -race` for the retract handler, then `pnpm test-stack down`. State in the PR what was left running.
- [ ] PR from `main`, `Closes #<W2 sub-issue>`. One review round (tenancy surface: a second round is allowed only if a fix itself touched cascade/RLS).

---

# Wave 3: Live chat (#8292), ad-hoc

**Depends on W1 (scope, card window, events) and W2 (tenancy patterns, permission seeds, rate limits) merged.** **What W3 leaves behind if it never ships:** W1+W2 complete; nothing chat-related is half-built (no columns or routes registered early). Chat is **Windows console session only** (Assist limitation); other platforms/sessions get no chat and the web UI says so (per-device capability). Ticket binding is deferred (Open Decision N3): `ticket_id` is not added, which avoids the ticket-move contract (`moveOrg.coverage.test.ts:581`, `INTENTIONALLY_NOT_REWRITTEN`).

## Task 3.1: Chat tables migration + registrations

**Files:** Create `apps/api/migrations/2026-12-25-210200-endpoint-conversations.sql` (re-check slot), schema `db/schema/endpointConversations.ts`, integration test `endpointConversations.rls.integration.test.ts`.

- `endpoint_conversations(id, org_id NOT NULL (always one device in one org; XOR rule N/A, justified), device_id, channel text DEFAULT 'endpoint_helper', opened_by, target_username, win_session_id, status ('open','closed','expired'), allow_user_reply, last_activity_at, closed_at, created_at)`.
- `endpoint_conversation_messages(id, conversation_id → endpoint_conversations ON DELETE CASCADE, org_id NOT NULL, device_id, direction ('to_user','from_user'), body text NULL, client_nonce uuid, sender_user_id NULL, sender_session jsonb, created_at, delivered_at, read_at)`; unique `(conversation_id, client_nonce)` for idempotent replies (repeated user replies must not collapse, and retries must not duplicate). Hot-write, shape 5, denormalized `org_id`, direct policy.
- Registrations, same table and mechanical-grep procedure as Task 2.2: `CORE_ORG_CASCADE_DELETE_ORDER` (messages before conversations in FK terms), `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `orgMergeRegistry.ts` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (`body` `included`, `sender_session` jsonb `excludedOpen`), rls-coverage allowlist check. Enforcing job: **Integration Tests**.

- [ ] **Step 1: Failing tests** — forge as `breeze_app` (insert message with another org's `org_id` → 42501), cross-org read denied, the five contract suites red via grep and suite run. **Step 2:** run on test stack → FAIL. **Step 3:** migration + registrations. **Step 4:** green; full integration shards; `pnpm test-stack down`. **Step 5: Commit.**

## Task 3.2: Chat command types and agent/IPC

**Files:** `commandTypes.ts`, `commandOfflinePolicy.ts` (`chat_open`, `chat_message` → `LIVE` class: rejected when offline; `chat_close` → live and in `LIFECYCLE_COMMAND_TYPES`; `chat_open`/`chat_message` in `GATED_COMMAND_TYPES`), `COMMAND_MIN_AGENT_VERSION.chat`; agent `ipc/message.go` (`TypeChatOpen`, `TypeChatMessage`, `TypeChatClose`, `TypeChatReply`; chat requires the Assist session with `ScopeMessaging`, **no native fallback**), `heartbeat/handlers_chat.go` (+ test), registered in `handlerRegistry`.

- [ ] **Step 1: Failing tests** — API: new types in all three registries; offline device rejects `chat_open`. Go: no Assist session → result `failed: chat_requires_assist`; reply with repeated nonce forwarded once.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts src/services/partnerTrust` and `cd agent && go test -race ./internal/heartbeat/... ./internal/ipc/...` → FAIL → implement → PASS. **Step 3: Commit.**

## Task 3.3: Chat routes, rate limits, audit

**Files:** `routes/endpointMessages/conversations.ts` (+ test). Permission `endpoint_messages:send` reused (Open Decision N6); open requires a device that has an Assist session with messaging scope. Endpoints: `POST /endpoint-conversations` (open, technician picks session), `POST …/:id/messages`, `POST …/:id/close`, `GET …/:id` (poll), `GET /devices/:id/endpoint-conversations`. Technician-initiated only. A user reply when `allowUserReply=false` is dropped at the agent and 403'd at the API. Idle auto-close (30 min, worker). Rate limit 60 chat messages/hour/conversation. Audit rows for open/close with counts; message bodies never audited (hash only). The chat "may I connect?" line never counts as consent; the optional convenience button triggers the **existing** `consent_request` flow only (Test: no code path writes a consent record from a chat message).
- Agent→API reply route: extend `routes/agents/messageEvents.ts` with `eventType: 'chat_reply'` carrying `client_nonce`; agent-attested session stored in `sender_session`.

- [ ] **Step 1: Failing tests** — tech cannot open a conversation on another org's device (RLS + permission); duplicate nonce inserts once; closed conversation rejects messages; reply not accepted when `allow_user_reply` false; no consent record produced.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/endpointMessages/conversations.test.ts src/routes/agents/messageEvents.test.ts` → FAIL → implement → PASS. **Step 3: Commit.**

## Task 3.4: Helper chat window

**Files:** `apps/helper/src-tauri/src/ipc/chat.rs`, `apps/helper/src/components/EndpointChat.tsx` (separate from the AI `ChatView.tsx`/`chatStore.ts`, which talk to `clientAi` with the helper token), reuse `messageMarkdown.tsx`.
Surfacing rules: first technician message shows the card (deliberate interruption like an incoming call); later messages update an open window and flash the taskbar entry; a minimised/closed window gets tray badge only, never re-raised; the main window is never shown.

- [ ] **Step 1: Failing tests** — Vitest: reply sends `chat_reply` with a fresh nonce, closed chat disables input, sender slot fixed; Rust: later message never re-raises a closed window; main window stays hidden.
- [ ] **Step 2: Run** `cd apps/helper && npx vitest run src/components/EndpointChat.test.tsx` and `cd apps/helper/src-tauri && cargo test ipc::chat` → FAIL → implement → PASS. **Step 3: Commit.**

## Task 3.5: Web chat panel and browser delivery of replies

**Files:** `apps/web/src/components/endpointMessages/DeviceChatPanel.tsx` on the device page (selected conversation in `window.location.hash`), locale keys ×7, `no-silent-mutations` compliance via `runAction`.
Reply delivery (OD-11): **first confirm an existing realtime channel into the web console** (`grep -rn "EventSource\|SSE\|/stream" apps/api/src apps/web/src | head`); the conservative default is polling the open conversation every 3 s (visibility-aware: paused when the tab is hidden), which is the floor and needs no new infrastructure.

- [ ] **Step 1: Failing tests** — poller stops when tab hidden or conversation closed; send uses `runAction`; locale parity; panel shows "no chat on this device (needs Breeze Assist on a Windows console session)" for unsupported devices.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/endpointMessages/DeviceChatPanel.test.tsx src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts` → FAIL → implement → PASS. **Step 3:** web typecheck (exit code). **Step 4: Commit.**

## Task 3.6: Retention for chat bodies, lab checks, PR

- [ ] Extend the Task 2.6 worker to null `endpoint_conversation_messages.body` after 90 days (test first).
- [ ] Lab checks owed (PR body): chat open/reply/close on Windows console; second RDS session gets no chat and the UI says so; macOS/Linux get no chat; reply when org toggle off; helper restart mid-conversation; minimised window not re-raised; no main-window pop.
- [ ] Full suites + contract suites on the test stack, typecheck, `pnpm test-stack down`. PR from `main`, `Closes #<W3 sub-issue>` (and `Refs #8292`). One review round.

---

# Security and abuse reasoning (prose)

A branded, persistent popup is the exact shape of a phishing lure, and a compromised technician account could push one to thousands of machines. The controls are layered rather than any one being sufficient. Sending needs its own permission (`endpoint_messages:send`), separate from `devices:execute`, so "may talk to a user" is not conflated with "may run code". Partner trust gating blocks probation/restricted partners from pushing operator-chosen content, while retract/close remain allowed because they carry no operator content. Volume is bounded by per-actor, per-partner and per-device limits enforced in the route (not only in the AI limiter), a 5 000-device hard cap, and a confirm step with the exact card above 100 devices. Spoofing is limited by making the sender line a helper-composed fixed slot sourced from server-resolved branding (never message text) and by rendering with a restricted markdown wrapper that always shows the true link host and drops images and HTML. The AI path is approval-gated without exception. Every send is audited with actor, targets and a body hash. Ack and chat identity is agent-attested, so the record says which OS user acted, not just which device. Chat is technician-initiated and never carries consent; remote-access consent remains Breeze's fixed-wording flow.

---

# Open Decisions

Format: decision, options, chosen default or recommendation, why. "Spec rec" means the spec gave a recommendation and this plan treats it as decided.

**Spec decisions (15)**

1. **Persist bodies vs ephemeral.** (a) persist with retention; (b) ephemeral. **Spec rec (a)**, 90-day body retention; W1 persists nothing (command payload only), W2 adds tables. Why: history, resend and dispute evidence; delay keeps W1 small.
2. **Ticket-bound vs ad-hoc chat.** (a) ticket-only; (b) ad-hoc; (c) both. **Spec rec (c); this plan ships ad-hoc (W3) and defers ticket binding** (no `ticket_id` column). Unresolved from spec: owner still decides whether ad-hoc may ship before binding exists. Why: avoids the ticket-move contract and the `ticket.commented` notification-storm risk until a binding wave is specced.
3. **End-user reply / start chat.** Spec rec (b): replies inside a tech-opened chat, org toggle `allow_user_reply` default on, user-initiated chat not built. W1 cards are read/ack only.
4. **Rate limits and phishing controls.** Spec rec: all controls as listed (20 sends/hour/actor, 10 000 deliveries/hour/partner, 1 critical per device per 5 min, confirm above 100, 120/2000 limits, https-only links, fixed sender slot, optional link allowlist). Numbers are starting points. Optional org link allowlist: **conservative default is not built in W1–W3** (follow-up) because it needs a settings home.
5. **Offline queueing and expiry.** Spec rec (a): queue until `expiresAt` or the 168 h class TTL; default expiry 24 h; online device without helper fails (`failed:no_helper`), agent does not hold messages.
6. **Helper surface.** Spec rec (c): Assist card with native fallback, new scope `messaging`; chat has no fallback.
7. **Branding source.** Spec rec (a): runtime-branding chain snapshotted per batch; until Phase 2 lands W1 uses partner name only; no logos.
8. **Multi-target fan-out and partner-wide scope.** Spec rec: "all orgs" gated by `canManagePartnerWidePolicies`. **Plan conservative default: org-scoped only in v1**; cross-org selections by selected-access users split into per-org org-owned sends; "all orgs" is a follow-up under the epic #2135 playbook. Cap 5 000 devices per send (the spec's lift via the partner-wide gate is deferred). Why: avoids the dual-axis RLS contract problem and a partner-owned row type nobody asked for yet.
9. **AI tool exposure.** Spec rec (c): tool, always human approval, tight rate limit; no AI chat. Lands in W2.
10. **Portal visibility.** Spec rec (a) for W1–W3: never visible; ticket-mirrored transcript visibility only with a future binding wave.
11. **Browser delivery of replies.** Spec: confirm an existing channel first. **Default: 3 s visibility-aware polling** (Task 3.5 greps for an existing channel before building). Why: no new infrastructure, lowest risk.
12. **`deliver_message` vs extending `notify_user`.** See N1 below (plan deviates from spec rec).
13. **Agent min-version gating.** Spec rec: API marks `failed:agent_unsupported` instead of queueing. Implemented in Task 1.2/1.3.
14. **Platform coverage.** Spec rec (a): Windows console only for card persistence and chat; native fallback elsewhere for one-way messages; no chat on macOS/Linux/RDS; capability column in compose UI. Owner should weigh this before approving W3.
15. **Read access to partner-owned batches (RLS contract).** **Moot in v1** because no partner-owned batch exists (decision 8). If partner-wide follows: spec rec (b) (partner-axis table plus per-delivery rendered snapshots) is the starting point; exemption list stays frozen empty; any deviation needs reviewer sign-off.

**New decisions from this plan**

N1. **W1 transport: reuse `notify_user` (brief) vs new `deliver_message` (spec OD-12 rec).** Options: (a) extend `notify_user` additively; (b) new type. **Chosen default: (a)**, per the brief, with the mandatory min-version gate so old agents never receive it. Risk: an old agent that somehow gets the payload shows a transient toast and reports success. Why: it closes the "unqueueable" gap with one registration and no second type. Switching to (b) is a mechanical rename in Tasks 1.1, 1.2, 1.4. **Disagreement with spec recorded for owner.**

N2. **Wave shape differs from the spec.** Spec W1 includes persistence tables and the AI tool; the brief moves them to W2 and makes chat W3. Chosen: brief's shape. W1's event sink is Redis-deduped `audit_logs` rows, replaced by receipts in W2. Why: W1 ships with no migration beyond permission seeds, shrinking blast radius of the agent+helper wave.

N3. **Ticket binding / `chat_ticket_policy` (spec W3) is out of this plan.** Chosen: follow-up spec/plan after W3. Why: a `ticket_id` column triggers the ticket-move contract and needs the notification-suppression design.

N4. **Partner-wide scope timing.** Chosen: follow-up epic (see decision 8).

N5. **Org-move behaviour for deliveries.** Conservative default: deliveries/receipts follow the device (denormalized `org_id` rewrite), messages stay in the source org; exact FK handling is confirmed against `moveOrg.coverage.test.ts` in Task 2.2 and documented in the PR. Alternative: block moves with non-terminal deliveries (rejected: operational friction).

N6. **Permission for chat.** Chosen: reuse `endpoint_messages:send` (no separate `chat` permission). Alternative: split later if orgs want "may broadcast but not chat". Why: fewer roles to migrate; reversible.

N7. **Idempotency store for W1 events.** Redis `SET NX` (7 days) rather than a table. Why: W1 has no table; W2 replaces it with a DB unique constraint. Risk: Redis flush could duplicate an audit row (harmless).

N8. **Hard rollout flag.** Per-partner `endpoint_messaging.enabled`, default off until the fleet has the new agent and Assist. Why: spec rollout note.

**Unresolved disagreements:** see "Quorum" below.

---

# Quorum

_To be completed after the independent `codex exec` read-only review of this draft (see PR body for the folded findings and any disagreement left open)._

# Self-review notes

- Spec coverage: transport (1.1–1.5), helper surface and #8138 rules (1.6, 1.8), content rules (1.7), permission (1.9), UI (1.10, 2.5, 3.5), tenancy and registrations (2.1–2.2, 3.1), retention (2.6, 3.6), AI tool (2.7), chat (3.x). Out of scope per spec: portal, images, AI chat, non-Windows chat.
- Types: `notify_user` payload keys (`messageId`, `batchId`, `persistent`, `requiresAck`, `severity`, `expiresAt`, `branding`, `source`) are identical in Tasks 1.3 and 1.4; event types identical in 1.4, 1.5, 2.4; `agentSupportsMessaging` and `COMMAND_MIN_AGENT_VERSION` named identically in 1.2, 1.3, 3.2.
