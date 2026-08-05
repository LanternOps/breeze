# Enrollment Idempotency — Design (#2764)

**Date:** 2026-08-02
**Issue:** #2764 — Enrollment 409 (hostname collision) rolls back the entire MSI install; uninstall strands an active device row that guarantees reinstall failure
**Status:** Approved by Todd 2026-08-02 (design "B-final"). Advisor quorum: Fable + Codex (gpt-5.6 xhigh, read-only) — positions reconciled below.

## Problem

Agent enrollment is not idempotent. Today:

1. MSI uninstall deletes local `secrets.yaml` but leaves the server device row ACTIVE.
2. A fresh install on that machine (or a reimaged one) hits the hostname-collision guard in `apps/api/src/routes/agents/enrollment.ts` (~:500-533) and gets `409 hostname_collision_requires_existing_device_token` — a token the machine structurally cannot have.
3. The agent's `classifyEnrollError` has no 409 case → `catUnknown`, exit 16 → the whole MSI rolls back (1603). The machine ends with **no agent installed**.
4. On the installer path, the bootstrap token slot was atomically consumed **before** enrollment ran and is never refunded — each retry burns a slot, then flips to 404 token-exhausted. A different error on every retry.
5. The guard also hard-blocks **legitimate duplicate hostnames** (OEM defaults, cloned VMs): the second real machine can never enroll while the first is online.

Field shape: every reimaged/uninstalled/previously-rolled-back machine hard-fails all installs until an admin manually decommissions the row. Operators read this as "the MSI doesn't install reliably."

## Threat-model conclusions (quorum record)

This design **consciously converts an SR-hardening-era control from prevention to detection.** Recorded rationale:

- Hostname is **self-attested** by the agent. The guard only fires on collision with an existing active row, so it does not prevent hostname spoofing in general — an attacker with a valid key can already enroll a rogue box under any non-colliding name.
- Hardware identifiers (serial, machine GUID, MAC) submitted at enrollment are equally self-attested and MUST NOT be used as an identity/adoption key (Codex; an existing test already pins that hardware-match does not bypass the guard).
- **Fresh-row enrollment grants an attacker nothing beyond what the enrollment key already grants** (the ability to enroll devices). The assets worth protecting are *existing* device rows — their identity, history, memberships, and pending commands.
- Therefore: **never write to any existing row at enrollment time.** With that invariant, removing the 409 adds no new attack surface, while detection (alert + linkage) makes the lookalike case *more* visible than today's silent 409.
- Staleness (`lastSeenAt`, offline status, no websocket) is an availability signal, **not** abandonment authorization — it cannot distinguish destroyed hardware from a laptop in a drawer. Automatic decommission of stale colliding rows is REJECTED (this is the one place the originally-approved "B" was revised).
- A raw `consumed_count` decrement refund is exploitable: redemption mints a live child key before enroll runs, so decrement-on-failure lets a token holder farm unlimited child keys from one slot. Refund MUST atomically revoke the linked, unused child key.

Unchanged, still load-bearing: exact org/site scoping; re-enrollment-with-existing-device-token path (in-place, same row); quarantine gate; `agent_token_suspended_at` gate; decommissioned-rows-are-legal-re-enroll-targets (#896); enrollment secret requirement (`enrollment.ts` ~:199,263).

## Design

### 1. Server: valid-key enrollment always succeeds with a fresh device row

Remove the hostname-collision 409 from the valid-key enrollment path. On collision with a non-decommissioned row (same org + site + hostname), enrollment proceeds and mints a **new** device row with a fresh id. No existing row is read-modified — not decommissioned, not adopted, not renamed — regardless of its online/stale state.

All other gates keep their current behavior: quarantine, suspended token, org/partner active, re-enroll-with-token (same-row, in-place), decommissioned-target re-enrollment.

### 2. Collision detection instead of prevention

When the collision described above occurs:

- Stamp linkage metadata in the enrollment audit event: old device id(s), new device id, key id, source IP.
- Raise an operator **alert** (real alert via the alerts system, not just a fire-and-forget audit write) when the colliding existing row's `status` is `online` — the lookalike-device signal. Status-field check is acceptable; do not rely on the in-process websocket map (not cluster-authoritative).
- Web UI: the alert (and the new device's detail view) links both devices and offers a **"Review possible replacement"** action that decommissions the old row via the existing decommission endpoint. Human-approved, post-install, one click. No new merge machinery in v1.

### 3. Uninstall intent (not immediate decommission)

- New nullable column `devices.uninstall_intent_at`.
- The MSI uninstall custom action makes a best-effort authenticated call (`POST /agents/uninstall-intent`, device-token auth) **before** `secrets.yaml` is removed. Short timeout; failure never blocks or fails the uninstall. macOS/Linux uninstall scripts get the same call where feasible.
- Any subsequent authenticated heartbeat clears the intent (covers MSI rollback and cancelled uninstalls).
- A reaper (extend the existing offline-detector job) decommissions rows whose intent is older than a window (default 24h, env-overridable `UNINSTALL_INTENT_DECOMMISSION_HOURS`) with no heartbeat since the intent.
- Immediate self-decommission is rejected (alert-suppression/DoS primitive for a stolen device credential; wrong outcome if the uninstall later rolls back).

### 4. Safe bootstrap-slot refund

- New nullable column `enrollment_keys.bootstrap_token_id` (FK → `installer_bootstrap_tokens.id`, SET NULL on token delete) stamped on child keys minted by `redeemBootstrapToken`.
- New endpoint `POST /installer/bootstrap/cancel`: caller presents the child key secret (capability auth, same trust level as redeem/enroll). Server atomically, in one transaction: verify child `usage_count = 0` → delete the child key → decrement the linked token's `consumed_count` (floor 0). The child-row delete is the exactly-once guard; a used or already-cancelled child refunds nothing.
- Agent: on a **non-retryable 4xx** from `/agents/enroll` after a successful redeem, call cancel best-effort before exiting non-zero. Network/5xx failures do not cancel (the child may still be usable on retry within its TTL).
- Farming is closed: cancellation revokes the child, so nothing is retained. A regression test must pin this (cancel → child unusable AND slot restored; double-cancel is a no-op).
- Out of scope, filed as follow-up: full reservation/commit idempotent enrollment (idempotency nonce, lost-response replay) — Codex rank 1, a subsystem redesign beyond this ticket.

### 5. Agent-side error classification

`classifyEnrollError` gains explicit cases for identity/conflict 4xxs (the legacy `hostname_collision_requires_existing_device_token` — new agents will still meet old self-hosted servers — plus `existing_decommissioned_row_has_suspended_token` and quarantine rejections): dedicated exit code, actionable log line naming the conflict. Loud rollback (`Return="check"`) is retained for residual failures; soft-exit-0 on a rejected supplied credential is rejected (silent-unenrolled failure shape).

## Data & contract checklist (repo obligations)

- Migration: `ADD COLUMN IF NOT EXISTS` for `devices.uninstall_intent_at` (timestamptz NULL) and `enrollment_keys.bootstrap_token_id` (uuid NULL FK), idempotent, no inner BEGIN/COMMIT. No new tables → no new RLS policies or cascade-list entries.
- **Export policy** (fires on new COLUMNS of org-cascade tables): classify both new columns in `CORE_TENANT_EXPORT_POLICY` — `uninstall_intent_at` → `included` (timestamp), `bootstrap_token_id` → `included` (tenant identifier). Run the export-policy integration suites (live DB) before PR.
- No partner-wide ownership question: `devices` and `enrollment_keys` are org-scoped operational tables, not config tables.

## Testing

- API unit + integration: collision → fresh row + old row byte-identical afterward; alert raised only when old row online; audit linkage present; refund atomicity + farming regression; double-cancel no-op; uninstall-intent set/cleared/reaped; quarantine + suspension gates unchanged (pin existing tests); re-enroll-with-token still in-place.
- Agent (Go, table-driven): new `classifyEnrollError` cases; cancel-on-4xx called, not on network error; uninstall CA never fails uninstall on network error.
- Integration suites need a live DB — they run in **Integration Tests**, not **Test API**; local `pnpm test` will not run them.

## Rollout & compatibility

- Server-first is safe: old agents simply stop receiving the 409. Agent-side changes (classification, cancel, uninstall intent) ride the next agent release + manual fleet promote (`AUTO_PROMOTE=false`).
- New agent + old server: 409 now classified loudly with an actionable message — strictly better than exit 16.
- Release notes must state the behavior change: hostname collisions no longer block enrollment; operators get an alert + one-click cleanup instead. Self-hosters who want the old blocking behavior: none planned — the control's prevention value was near-nil (self-attested hostname); no config flag.

## Out of scope

- Reservation/commit idempotent enrollment (follow-up issue).
- Automatic stale-row decommission (rejected; the reviewed-replacement UI covers cleanup).
- Device merge/history-transfer tooling.
- The rotation-401 family (#2772/#2773/#2653) — separate subsystem.
