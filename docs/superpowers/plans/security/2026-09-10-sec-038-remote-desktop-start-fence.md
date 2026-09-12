---
tracking_issue: LanternOps/breeze#5531
---

# SEC-038 — Remote desktop start/terminal fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linearize the desktop *start* decision against the desktop *terminal* decision, so that a start command can never take effect after a session has been ended — including when the two commands arrive at the agent out of order.

**Architecture:** One monotonic `bigint` generation on the `remote_sessions` row, bumped by both the start-intent commit and the terminal-intent commit, carried in the `start_desktop` / `stop_desktop` payloads as a canonical decimal string. The endpoint — the Go agent, and behind it the user helper — keeps a durable per-session high-water mark plus an absolute terminal tombstone, and refuses any start that is not strictly newer than everything it has already seen. The invariant fits on one line: *the endpoint refuses any start not strictly newer than everything it has already seen, and refuses all starts after a terminal.*

**Tech Stack:** Hono + Drizzle + Postgres (hand-written SQL migration), Vitest (API unit + integration against real Postgres), Go 1.x (`go test -race`) for agent and helper, Astro + React islands for the viewer/UI surface.

**Source:** independent design review of SEC-2026-09-05-038, 2026-09-10. Design M (this plan) was selected over the fuller Design F; see *Design scope* below for what was dropped and why.

---

## Problem statement

`#5481` shipped a fail-closed revocation lease for remote desktop: the agent asks the server to renew every 25 s against a 60 s lease, the watchdog ticks every 5 s, and a terminal session row is a *definitive* negative that stops capture immediately. That closed authorization **drift** over the life of a session.

What it did not close is **ordering**. All three start sites commit their session CAS and then `await` further work (audit write, lease mint) before the command is sent, so a terminal decision committed inside that window wins the database row but can still lose the wire. Worse for correctness, `stop_desktop` can reach the agent *before* the start it is meant to cancel, and the agent today keeps no record that a session is finished — an unknown-session stop is a no-op.

The residual after `#5481` is therefore **an ordering window already bounded to one lease tick by `#5481`**, and to roughly one lease grace period if Postgres and Redis are simultaneously degraded. It is bounded, not closed. This plan closes it.

Three sites publish a start today and all three are in scope:

- `apps/api/src/routes/remote/sessions.ts` — `POST /:id/offer`
- `apps/api/src/routes/desktopWs.ts` — `POST /:id/viewer/offer`
- `apps/api/src/routes/desktopWs.ts` — the WS fallback `desktop_stream_start`

---

## Design scope — what this plan deliberately does not build

The alternative design (F) added a versioned digest-bound command envelope, a second server-side linearization point (a publication-permit claim transaction that must commit before any bytes may enter WS or HTTP delivery), a `device_commands` deletion-retention guard, and an authenticated helper *incarnation* handshake with Windows DACL/reparse evidence as a hard gate. Costed at ~8–12 API files plus a new claim path and envelope codec, 2–3 migrations, a new agent protocol version *and* a new helper IPC version, i.e. 8–10 PRs.

Dropped, with reasons:

- **Digest-bound envelope.** The payload is server-authored and travels the already-authenticated agent WebSocket. A digest defends against a party who can already write commands, and such a party has strictly better options. The generation is the only field whose integrity matters here, and it is bound to the same message.
- **Publication-permit claim transaction.** Its purpose is to prove no stale bytes were ever emitted. This plan instead makes any emitted stale bytes *inert at the consumer* — equivalent outcome, and one fewer lock order to reason about against `deviceLifecycle`'s command-before-device deletion.
- **`device_commands` deletion-retention guard.** Unnecessary by construction: F needs it because it stores protocol intent in a cascade-deletable command payload. This plan stores intent on the session row, where the session already lives.
- **Helper incarnation handshake.** Reduced to "generation on the IPC start message + fence sync on helper connect". The remaining case — a helper that restarts and replays a start it already had queued — is caught by the generation, not by incarnation identity.

Kept from F, because each is load-bearing for *this* finding: the monotonic generation, the canonical-decimal-string encoding rule, the absolute terminal tombstone, the durable consumer fence, one terminal contract for every terminal writer, and the pending/confirmed teardown phase.

---

## Owner decisions (DECIDED 2026-09-10)

1. **`REMOTE_DESKTOP_FENCE_REQUIRED` flips to on one release after W06 ships.** It ships default-off in W06 and is flipped in the following release. This repeats the "agent upgrade required" friction for anyone on an old agent, and that is accepted: the same precedent already exists for `#5481`'s lease gate.
2. **A start whose FIRST lease renewal returns `unavailable` hard-stops** instead of riding the 90 s grace. This removes the degraded-infrastructure window entirely for not-yet-established sessions. Renewals *after* a session is established keep the existing 90 s grace, so an established session still rides out a Redis blip. Scoped to the first renewal only.
3. **Windows helper evidence is NOT deferred.** W05 must run its Go tests as cross-compiled `go test -c` binaries executed **natively on the Windows lab VM**, alongside a control binary built from `origin/main` that is expected to fail the fence assertions. A green run with no failing control is not evidence — it is an untested suite. See W05 for the exact obligation.

---

## Global constraints

- **Deploy order is API first, agents second, gate last.** The generation is an additive field old agents ignore, and old agents remain protected by `#5481`'s lease, so no capability refusal ships in the same release that introduces the fence.
- **Every wave is independently revertible.** The migration is additive with defaults, so an API rollback leaves the columns inert.
- **Generations are `bigint` and never pass through a JavaScript `Number`.** They are produced, transported and compared as canonical decimal strings on every hop (API → command payload → agent → helper IPC), and as `bigint`/`int64` in storage.
- **Migration naming.** The design memo's `150700` / `150800` slots are **stale** — they sort *before* migrations already shipped. A new migration must sort after the newest **committed** migration at the time of authoring. As of 2026-09-10 that is `apps/api/migrations/2026-10-15-160010-backup-snapshots-layout-manifest.sql`, so W02 uses `2026-10-15-160100-remote-session-start-generation.sql`. **Re-check `ls apps/api/migrations | sort | tail -1` immediately before committing** — the ceiling moves. Idempotent (`ADD COLUMN IF NOT EXISTS`, `DO $$` for the CHECK), no inner `BEGIN`/`COMMIT`.
- **No new tables**, so no cascade-list registration applies. But the three new columns on `remote_sessions` **do** require `CORE_TENANT_EXPORT_POLICY` entries in `apps/api/src/services/tenantExportPolicyRegistry.ts` — the export-policy contract fires on a new *column* of an already-registered org-cascade table, not only on a new table. All three go in `included`: two are monotonic counters and one is a state enum, none is credential material. Missing this reds `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` under **Integration Tests**, which cannot fail in the **Test API** unit job.
- **Any migration that performs DML must elect `breeze.scope = system`** via the `SELECT set_config('breeze.scope', 'system', true)` form; run `migrationRlsScope.test.ts` for any DML migration.
- **Ordering tests run against real Postgres.** A mocked Drizzle test cannot prove a `FOR UPDATE` interleaving; those assertions belong in the integration config, in a file placed where the integration shards actually pick it up.
- Every wave lands as its own PR with `Closes #<sub-issue>` and branch `feature/5531-remote-desktop-start-fence/wave-<subissue#>`.
- While developing, scope test runs with `pnpm --filter @breeze/api test --run <file>` — never insert `--` before `--run`. Go work runs `go test -race ./...` and the CI lint mode `golangci-lint --new-from-rev=origin/main ./...` before enqueuing.

---

## Data model

Three additive columns on `remote_sessions`:

| Column | Type | Meaning |
|---|---|---|
| `desktop_start_generation` | `bigint NOT NULL DEFAULT 0` | Monotonic; bumped by both start-intent and terminal-intent. |
| `terminal_generation` | `bigint` (nullable) | The generation at which the session was declared terminal. |
| `termination_phase` | `text NOT NULL DEFAULT 'none'`, CHECK in `('none','pending','confirmed')` | `pending` from terminal-intent commit; `confirmed` when the agent's stop result lands. |

These sit alongside the per-start identity `#5481` already added (`desktop_start_command_id`, migration `2026-10-15-150040`) and `permissions_epoch_snapshot`. Results continue to CAS against `desktop_start_command_id`; the generation is what orders decisions.

---

## Wave plan

Six waves, tracked as sub-issues of `LanternOps/breeze#5531`.

| Wave | Issue | Scope | Status |
|---|---|---|---|
| W01 | `#5532` | Port the wave-0 partial: full authority revalidation on every viewer transition; End dispatches via the relay with a status guard | **Done** — merged as `#5518` (`f5a3d1870d`) |
| W02 | `#5533` | Server generation columns + start-intent CAS on all three start sites | Not started |
| W03 | `#5534` | One terminal-intent contract for every terminal writer (pending→confirmed phase) | Not started |
| W04 | `#5535` | Agent in-memory fence: high-water mark + tombstone on stop, refuse stale starts | Not started |
| W05 | `#5536` | Durable fence store + helper IPC generation + resync on connect/lease renewal | Not started |
| W06 | `#5537` | Capability gate `REMOTE_DESKTOP_FENCE_REQUIRED`, cutover, viewer/UI pending-teardown handling | Not started |

---

## W01 — `#5532` — wave-0 port: live authority revalidation + End via relay — **DONE**

**This wave is already merged**, as PR `#5518`, commit `f5a3d1870d` ("fix(remote): revalidate full authority on every desktop viewer transition; End dispatches via relay with a status guard (SEC-038 wave 0)"). It is recorded here because W02 and W03 build directly on it and because the plan should read as a complete account of the feature.

It landed two adjacent defects found while reading for this design, plus the consolidation that the later waves depend on:

- `POST /remote/sessions/:id/end` was sending its stop with socket-local `sendCommandToAgent` rather than `dispatchCommandToAgent`, so an End served by a non-owning API replica never reached the agent at all. The teardown service already used the relay; End now does too.
- That same handler's `UPDATE` carried no status guard in its `WHERE`. It does now.
- `currentSessionCapabilityDenial` / live-authorization checking was consolidated in `apps/api/src/services/remoteWsAuthorization.ts`, so W02 and W03 edit **one** revalidation helper instead of six inline copies.

Files touched: `apps/api/src/routes/remote/sessions.ts`, `apps/api/src/routes/desktopWs.ts`, `apps/api/src/services/remoteWsAuthorization.ts` and their tests.

Red-first tests that shipped with it: ws-ticket, connect-code, ICE, answer and end each denied after site-scope narrowing, and each denied after policy disable.

---

## W02 — `#5533` — server generation + start-intent CAS

**Goal:** every start decision is a single serialized transaction that produces a strictly increasing generation, and no start is published whose generation has already been superseded.

**Files:**

- Create: `apps/api/migrations/2026-10-15-160100-remote-session-start-generation.sql` (re-check the sort-last ceiling before committing)
- Modify: `apps/api/src/db/schema/remote.ts` (three columns)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`remote_sessions` → three new `included` entries)
- Modify: `apps/api/src/routes/remote/sessions.ts` (`POST /:id/offer`)
- Modify: `apps/api/src/routes/desktopWs.ts` (`POST /:id/viewer/offer`, `desktop_stream_start`)

**Contract — one transaction per start site:**

1. `SELECT … FOR UPDATE` on the session row.
2. Assert `termination_phase = 'none'` and status live; re-assert ownership, site scope, policy and device via the W01 revalidation helper.
3. Bump `desktop_start_generation`.
4. Write `desktop_start_command_id`, prompt mode, offer, `status = 'connecting'`.
5. Commit, returning the generation.

The generation rides in the `start_desktop` payload as a canonical decimal string. **Immediately before `sendCommandToAgent`, re-read generation + phase with one cheap `SELECT` and abort `409` on change.** That check narrows the window to microseconds; it does not close it, and it is not meant to — closing it is the endpoint's job in W04/W05, deliberately.

**Red-first tests** (ordering assertions against real Postgres):

- [ ] REST start-intent race: an End interleaved between the CAS and the send yields `409` and **no** command row.
- [ ] Viewer-offer start-intent race: same property on `POST /:id/viewer/offer`.
- [ ] Transaction rollback emits nothing — a failure after the CAS leaves no published command.
- [ ] Re-offer supersession: an older generation is never re-published once a newer one has committed.
- [ ] Same-generation retry carrying a *different* payload is denied.
- [ ] `remote_sessions` export-policy classification covers all three new columns (integration suite must be green).

---

## W03 — `#5534` — one terminal-intent contract

**Goal:** there is exactly one way to declare a desktop session terminal, every writer uses it, and it bumps the same generation that starts bump.

**Files:**

- Create: `apps/api/src/services/remoteDesktopTerminalIntent.ts` (+ co-located test)
- Modify: `apps/api/src/routes/remote/sessions.ts` (REST End)
- Modify: `apps/api/src/services/remoteSessionTeardown.ts` (org/user teardown)
- Modify: `apps/api/src/services/remoteSessionStaleness.ts` (stale/replacement cleanup, stale-command reaping)
- Modify: `apps/api/src/services/remoteRevocationLease.ts` (`markRevoked`)
- Modify: the tunnel→WebRTC replacement path
- Modify: `apps/api/src/routes/agentWs.ts` (agent `denied` / `failed` / `disconnected` result handlers)
- Optional migration: only if a backfill is needed; name it to sort after the W02 file, and elect `breeze.scope = system` first.

**Contract — `commitDesktopTerminalIntent()`, one transaction:**

1. Bump `desktop_start_generation`.
2. Record `terminal_generation` at that value.
3. Set `termination_phase = 'pending'`.
4. Set the row terminal.

The stop then goes out over `dispatchCommandToAgent` carrying `terminalGeneration`. Phase moves to `'confirmed'` when the agent's stop result lands. `POST /:id/end` keeps returning `200` with an explicit phase field — it does **not** become `202`; callers that already treat `200` as "ended" must not start polling differently.

**Red-first tests:**

- [ ] Terminal-before-publication: a start whose terminal intent committed first is refused, and nothing is published.
- [ ] Publication-before-terminal: phase moves `pending` → `confirmed` when the agent's stop result arrives.
- [ ] A stale result identity cannot clear terminal intent.
- [ ] Table-driven test over the full terminal-writer list: **every** terminal/deletion entry point bumps the generation. This is the test that catches a seventh writer being added later.
- [ ] REST End still returns `200` with the phase field, not `202`.

---

## W04 — `#5535` — agent fence (in-memory)

**Goal:** the agent refuses to act on a start it has already superseded, and — the actual fix for the reorder case — a stop installs a tombstone **even when no session is running**.

**Files:**

- Create: `agent/internal/heartbeat/desktop_fence.go` (+ test)
- Modify: `agent/internal/heartbeat/handlers_desktop.go`
- Modify: the `tools` command payload parsing that decodes `start_desktop` / `stop_desktop`

**Contract — a per-session `{highWaterGeneration int64, terminal bool}` map:**

- `handleStartDesktop` refuses a generation **≤** the high-water mark, and refuses any start at all on a tombstoned session id.
- An identical `commandId` + generation **joins** the existing in-flight call — `joinOrRunDesktopStart` is unchanged, it keeps collapsing concurrent starts.
- `handleStopDesktop` **installs the tombstone even when no session is running.** That single line is the fix for the reorder case; today an unknown-session stop is a no-op and a late start then runs.
- A start with **no** generation field (old server) is admitted, so agents can roll before the API in a mixed fleet.

**Red-first tests (`go test -race`):**

- [ ] Stop-before-start installs a tombstone and the later start is refused.
- [ ] A start with generation ≤ high-water mark is refused.
- [ ] Identical generation + `commandId` joins the in-flight call rather than starting twice.
- [ ] Absent generation is admitted (old server compatibility).
- [ ] WS/HTTP reorder: the same pair delivered over the two transports in either order converges on "refused".

---

## W05 — `#5536` — durable fence + helper IPC + Windows evidence

**Goal:** an agent restart between terminal intent and a re-delivered start cannot forget the tombstone, and the user helper honours the same fence.

**Files:**

- Create: an atomic-write fence store under the agent state dir, modelled on the existing `agent/internal/rollback` store pattern (`store.go` / `store_unix.go` / `store_windows.go`)
- Modify: `agent/internal/ipc/message.go` (`DesktopStart` gains the generation, as a decimal string)
- Modify: `agent/internal/userhelper/desktop.go` (refuse a start below the fence)
- Modify: fence sync on helper connect, and on the lease-renew answer

**Contract:**

- The fence is persisted with the existing atomic-write pattern so a restart cannot forget it.
- On missing or corrupt state, **refuse starts** until the next lease-renew answer echoes the server's current generation and phase. No new endpoint is needed — the renewal answer already flows.
- The service passes its fence to the helper on connect; the helper refuses any start below it. This is a generation check, not a full incarnation handshake (see *Design scope*).
- Per owner decision 2, a start whose **first** lease renewal returns `unavailable` hard-stops rather than riding the 90 s grace; renewals after the session is established keep the grace unchanged.

**Windows evidence obligation (owner decision 3 — NOT deferred):**

W05 does not merge on a Linux/macOS-only green. The Go tests must be cross-compiled with `go test -c` and the resulting binaries executed **natively on the Windows lab VM**, because the atomic-replace and state-directory semantics under test are exactly the ones that differ on Windows. The run must include a **control binary built from `origin/main`** and that control must **fail** the fence assertions. Record in the PR body: both binaries' build SHAs, the VM identity, and the pass/fail of each. A green test binary with no failing control proves the suite ran, not that it discriminates.

**Red-first tests (`go test -race`, then re-run as native Windows binaries):**

- [ ] Direct restart re-loads the fence and refuses the replayed start.
- [ ] Helper restart refuses a below-fence start.
- [ ] Corrupt or missing state blocks starts until resync from the lease-renew answer.
- [ ] Write-failure injection keeps admission blocked and **never rolls the high-water mark back**.
- [ ] First-renewal `unavailable` hard-stops; a later-renewal `unavailable` on an established session still rides the 90 s grace.
- [ ] Control binary from `origin/main` fails the fence assertions (evidence the suite discriminates).

---

## W06 — `#5537` — capability gate, cutover, viewer/UI

**Goal:** the server can require a fenced agent, and the UI stops rendering a session as connected while its teardown is still pending.

**Files:**

- Modify: agent heartbeat capability advertisement — add `desktopFenceProtocolVersion` alongside the existing `revocationLeaseProtocolVersion` (`agent/internal/heartbeat/heartbeat.go`), same shape
- Modify: the API side that records agent security capabilities, and the three start sites, to refuse unfenced agents behind `REMOTE_DESKTOP_FENCE_REQUIRED`
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx` and the answer-polling path
- Modify: session history labelling for pending teardown

**Contract:**

- The agent advertises `desktopFenceProtocolVersion`; the server records it and, behind `REMOTE_DESKTOP_FENCE_REQUIRED` (**default off**), refuses starts to unfenced agents exactly as `#5481` refuses lease-incapable ones — same denial code shape, same upgrade messaging.
- Per owner decision 1, the flag is **flipped on one release after W06 ships**, not in the same release.
- Viewer/UI: answer polling and `ConnectDesktopButton` must treat `termination_phase = 'pending'` as **not connected**. Session history labels pending teardown distinctly from a confirmed end.

**Red-first tests:**

- [ ] Gate off: an unfenced agent is admitted (so the release that introduces the gate is a no-op for the fleet).
- [ ] Gate on: an unfenced agent is refused with the upgrade code.
- [ ] `ConnectDesktopButton` / answer polling does not render connected while `termination_phase = 'pending'`.
- [ ] Session history distinguishes pending teardown from confirmed end.
- [ ] New UI strings land in all locales (`localeParity.test.ts` must stay green).

---

## Verification before each PR

- `pnpm --filter @breeze/api test --run <touched files>` while developing; full API suite before the PR.
- **W02 and W03 additionally require the RLS and integration suites** (`vitest.config.rls.ts`, `vitest.integration.config.ts`) — `pnpm test` does not run them, and the export-policy contract can only fail there.
- `pnpm db:check-drift` after the W02 migration.
- W04/W05: `go test -race ./...` plus `golangci-lint --new-from-rev=origin/main ./...`; W05 additionally the native Windows run with its control binary.
- W06: `pnpm --filter @breeze/web test` including locale parity.
- Because `ci.yml` triggers on `pull_request: branches: [main]`, do not stack a wave PR on a sibling branch and read `gh pr checks` as green — a stacked PR runs almost no CI. Target `main`, or dispatch CI per branch.
