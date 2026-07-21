# Reset-Password Temporary Credential Reveal — Design

**Date:** 2026-07-19
**Status:** Approved
**Predecessor:** `2026-07-19-m365-graph-actions-executor-design.md` (Phase 3 — component G / Task 10 was descoped to this follow-up)

## 1. Problem

When `m365_reset_password` executes headlessly, the executor sets `forceChangePasswordNextSignIn=true` on the Entra account and returns
`{ success, action: 'm365.user.reset_password', userId, temporaryPassword, forceChangeNextSignIn }`. The release worker stores that body verbatim (today: plaintext) into the RLS-protected `action_intents.result` jsonb — and nothing surfaces it. No API endpoint returns `result` (the approvals `serialize()` deliberately omits it), and no web component renders a completed intent. The requesting tech has no way to obtain the credential they asked for.

Exposing it is a new credential-returning API surface, so the design is primarily a set of security decisions.

## 2. Decisions (settled with Todd, 2026-07-19)

| Question | Decision |
|---|---|
| (a) Who may read | **Requester + admin fallback.** User-requested intents: only `requestedByUserId`. API-key/MCP-requested intents (`requestedByUserId IS NULL`): any org-authorized user holding `approvals:decide`. Fail closed otherwise. |
| (b) One-time vs repeatable | **One-time + burn.** First successful reveal returns the password and atomically redacts it from `result`, leaving a `revealedAt`/`revealedBy` marker. Further reads → 410. |
| (c) At-rest encryption | **Encrypt with `secretCrypto`.** The API seals `temporaryPassword` with `encryptSecret` (AES-256-GCM, v3, AAD `action_intents.result`, `strict: true`) before it reaches the database. Matches the recovery-key precedent; no new key infrastructure (`APP_ENCRYPTION_KEY` is already mandatory in production). |
| (d) Audit | Reveal success and denial both audited; the password never appears in audit details, logs, metrics, or error messages (same allowlist discipline as `writeActionMetrics.ts` and `recoveryKeys.ts`). |
| (e) Endpoint shape | Narrow dedicated endpoint: `POST /action-intents/:id/reveal-secret` in a new web-mounted router (the existing approvals router is the mobile surface). |
| Unrevealed TTL | **7-day reveal window** from `executedAt`. The endpoint refuses (and lazily redacts) after that; a periodic sweep redacts expired un-revealed secrets so nothing lingers at rest. |
| UI surface | **ApprovalHistoryFeed** (AI Risk dashboard). No new page; completed reset rows gain a reveal action, following the `RecoveryKeysPanel` pattern. |

## 3. Components

### 3.1 Seal at write time — `services/actionIntents/resultSecrets.ts` (new)

`sealActionResultSecrets(actionName, result)` — the single registry of "which result fields are secrets," called by `intentReleaseWorker.ts` immediately before `transitionIntent(intent.id, 'executing', 'completed', { executedAt, result })`:

- For `m365.user.reset_password` (matched on `result.action`): delete `temporaryPassword`, add `temporaryPasswordEnc = encryptSecret(pw, { aad: 'action_intents.result', strict: true })`.
- Any other action: pass through unchanged.
- Sealing happens **after** `writeActionResultSchema` validation and the 64 KiB cap check (ciphertext is larger than plaintext; re-check size after sealing).

No schema migration: reveal/burn state lives inside `result`, and the `action_intents_immutable_trg` trigger already permits `result` updates. Update the now-stale comment in `m365ToolsHeadless.ts` ("stored verbatim").

**Legacy plaintext:** `M365_GRAPH_ACTIONS_TOOLS_ENABLED` is off by default, so pre-existing plaintext `temporaryPassword` rows should be ~zero. Defensively, the reveal endpoint and the sweep both recognize the legacy plaintext key (reveal treats it as sealed-equivalent; sweep redacts it).

### 3.2 Reveal endpoint — `routes/actionIntents.ts` (new)

`POST /action-intents/:id/reveal-secret`, mounted in `index.ts` behind `authMiddleware`. POST because reveal mutates (burns). Handler flow, fail-closed at every step:

1. **Load** the intent through the normal request-scoped RLS context (Shape-1 `breeze_has_org_access(org_id)`). Not visible → 404.
2. **Gate:** `status === 'completed'` AND result contains `temporaryPasswordEnc` (or legacy plaintext key). Otherwise → 404. Deliberately the same status code as "not found" — no oracle distinguishing "no such intent" from "intent has no secret."
3. **Authorize:**
   - `requestedByUserId` set → must equal `auth.user.id`, else 403.
   - `requestedByUserId` NULL (API-key/MCP) → re-resolve live permissions for `intent.orgId` exactly like the decide path (`getUserPermissions` inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`), then require `canAccessOrg(perms, intent.orgId)` AND `userCanDecideApprovals(perms)`, else 403.
   - 403s are audited with `result: 'denied'`.
4. **Window:** `executedAt` older than 7 days → lazily redact the sealed value, return 410.
5. **Reveal + burn (race-safe ordering):**
   1. Read the sealed value from the loaded row.
   2. Decrypt (`decryptSecret` with the same AAD). Decrypt failure → 500, secret left intact (never burn what you couldn't return).
   3. CAS burn: `UPDATE action_intents SET result = <result minus secret keys, plus marker> WHERE id = :id AND result ? 'temporaryPasswordEnc'` (legacy: `?| array[...]` covering both keys). Marker: `temporaryPasswordRevealed: { revealedAt, revealedByUserId }`.
   4. Zero rows updated → concurrent reveal won → 410. Only the CAS winner returns the plaintext.
6. **Respond:** `{ temporaryPassword, userId, forceChangeNextSignIn, revealedAt }` — the only place plaintext ever appears. Never logged.

RLS note: the burn UPDATE runs in the request context, so the update policy (`breeze_has_org_access`) applies. A requester who has lost org access since requesting fails closed at step 1.

### 3.3 Audit

- Success: `writeRouteAudit` — `action: 'action_intent.temp_password.reveal'`, `resourceType: 'action_intent'`, `resourceId: intent.id`, details allowlisted to `{ intentId, actionName, revealPath: 'requester' | 'admin_fallback' }`.
- Denial: same action, `result: 'denied'`, same allowlist.
- `recordActionIntentEvent` (`services/actionIntents/metrics.ts`) gains a `revealed` outcome for the intent-lifecycle trail.
- Contract: the password appears in no audit row, log line, metric, or error message, anywhere.

### 3.4 Unrevealed-TTL sweep

A periodic job (hooked into the existing scheduler/cleanup worker — exact home chosen during planning) runs in a system db context:

```
UPDATE action_intents
SET result = <redacted + expired marker>
WHERE result ?| array['temporaryPasswordEnc','temporaryPassword']
  AND executed_at < now() - interval '7 days'
```

Logs the redaction count (never the values). Idempotent; safe to run hourly.

### 3.5 API for the UI — extend `GET /ai/admin/tool-executions`

Add to the executions select (`routes/ai.ts`): `intentId`, plus `tempPasswordState: 'available' | 'revealed' | 'expired' | null` derived via a join to `action_intents` from the result markers and the 7-day window. `null` for every non-reset execution. This keeps the feed from rendering dead reveal buttons.

### 3.6 Web UI — `ApprovalHistoryFeed.tsx`

In the expandable panel of a completed `m365_reset_password` row with `tempPasswordState === 'available'`:

- **Reveal temporary password** button → `runAction({ request: () => fetchWithAuth('/action-intents/:id/reveal-secret', { method: 'POST' }), ... })` (repo `runAction` convention — success/failure always surfaced).
- On success: password in a monospace field with copy-to-clipboard and a "This will not be shown again" warning; the row flips to a revealed state. Follows `RecoveryKeysPanel.tsx`.
- `tempPasswordState === 'revealed' | 'expired'`: static explanatory text instead of a button.
- 403 → friendly "Only the requesting technician can reveal this password."; 410 → "Already revealed or expired."
- The value is never written to console, logs, or analytics.

## 4. Security contract (restated)

1. Org-scoped RLS governs every read and the burn write; fail closed on any authz ambiguity.
2. Plaintext exists only: (a) in executor/worker memory pre-seal, (b) in the single reveal response body. At rest it is always AES-256-GCM sealed, and only until first reveal or day 7.
3. One-time: CAS burn guarantees at most one successful reveal, even under concurrent requests.
4. Reveal and denial are audited; the password is in no audit/log/metric (preserves the Phase-3 `writeActionMetrics` allowlist discipline).
5. `forceChangePasswordNextSignIn=true` bounds exposure regardless of everything above.

## 5. Testing

- **Route unit tests** (`routes/actionIntents.test.ts`, Drizzle-mock pattern): authz matrix — requester OK; other org user 403; API-key intent + decide-holder OK; decide-holder without org access 403; non-completed status 404; no-secret intent 404; double reveal 410; expired 410; legacy-plaintext reveal; audit rows written without the password; decrypt-failure leaves secret intact.
- **Seal helper tests:** round-trip seal/decrypt, pass-through for non-secret actions, size re-check.
- **Sweep test:** redacts old unrevealed (both key forms), leaves recent and already-revealed rows alone, logs count.
- **Integration (real DB):** cross-org reveal 404s as `breeze_app` (RLS); CAS burn under two concurrent requests yields exactly one success.
- **Web tests:** the three `tempPasswordState` render states; reveal flow happy path; 403/410 friendly states.

## 6. Out of scope

- Any change to how the executor generates or returns the password.
- Google Tier-3 actions (no secret-bearing results today) — the seal registry is the extension point if that changes.
- A general-purpose action-intents list/detail page (deliberately deferred; the feed surface is sufficient for this credential path).
- Re-delivery of the password to MCP API callers in their own response channel (admin fallback covers those intents).
