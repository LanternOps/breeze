# Action-Intents Phase 2 — Headless Google Tier-3 Dispatch

**Date:** 2026-07-19
**Branch:** `ToddHebebrand/action-intents-durability`
**Status:** Implemented on ToddHebebrand/action-intents-durability (commits ed56872b8..eb0ce2dd6)
**Related:** [[action_intents_durable_approval_review]], `docs/superpowers/plans/ai-mcp/2026-07-19-action-intents-durability-followups.md`, `docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md`

## Problem

The durable action-intents approval layer lets a Tier-3 AI-agent action be approved *after* the requesting tech's chat session has ended, with the release worker (`jobs/intentReleaseWorker.ts`) executing it headlessly. But **session-aware M365/Google tools currently cannot execute in the worker**: they were registered only via `makeSessionAwareHandler` and resolve their OAuth connection through a live SSE session. The worker short-circuits them with `requiresLiveSession(intent.actionName) → fail session_required` (`intentReleaseWorker.ts:250-253`).

Net effect today: an approved `google_offboard_user` / `google_suspend_user` / `google_reset_password` intent **fails `session_required`** if approved after the requester's session ended — defeating the point of the durable layer for these tools.

## Corrected scope (why this is Google-only)

The original Phase 2 framing (recorded in memory) assumed the fix required *capturing the customer `delegantM365ConnectionId`/tenant into the immutable intent + a session-less broker dispatch*. That framing is **stale and cancelled**:

- The M365 **Delegant broker is being removed**, not extended — the control-plane design spec (`2026-07-13-breeze-m365-control-plane-design.md`) states: *"Delegant is a migration source only. The completed system has no Delegant service, database, console, worker, credential, Hive grant, Breeze fallback, or compatibility path."* Building connection-capture plumbing on it would be sunk cost.
- The **future** M365 mutation path (`customer-graph-actions` profile / executor) **does not exist yet** (only the `customer-graph-read` profile + `m365-graph-read-executor` sidecar shipped). Its connection model is **org-keyed** by design, so it will be born headless-capable — nothing to retrofit here.
- Therefore **M365 headless dispatch is deferred** to the `customer-graph-actions` executor phase. The dormant `action_intents.connection_id`/`tenant_id` columns stay dormant. The worker keeps failing M365 session-aware intents cleanly with `session_required` until then.

**Google Workspace, by contrast, is org-keyed and stable today.** `resolveContext(_auth, sessionId)` (`aiToolsGoogle.ts:192`) ignores `auth` entirely and uses the session *only* to derive `session.orgId`, then `loadGoogleConnection(orgId)` (one-per-org row). So the session is pure indirection to an org id — which the durable intent already carries immutably as `intent.orgId`. Google can go headless now with no captured state.

## Approach: worker-only headless path, inline untouched

The release worker resolves the Google connection by **`intent.orgId`** (immutable, already revalidated) instead of a session. The shipped, tested **inline chat path is left completely unchanged**.

**Why not de-session the inline path too** (i.e. register Google into the headless `aiTools` map so `requiresLiveSession` auto-flips and `executeTool` runs it for both paths): inline resolves by `session.orgId`, which under a **partner-scoped** token can be a specific pinned operating org while `auth.orgId` is null/broad. The AI session pins the operating org; changing inline to resolve by `auth.orgId` risks a real org-resolution regression in multi-org partner chats. The durable intent's `org_id` is that same pinned org captured at create time, so the worker can safely use `intent.orgId` — but only the worker. This confines the blast radius to the durable worker, consistent with the existing worker-only `requiresLiveSession` predicate.

## Components

### 1. Extract per-action Google API logic into pure action fns
Each Tier-3 Google handler is split so its Google API call becomes a pure `(ctx, input) => Promise<string>` function, where `ctx = { conn, keyJson }` (the resolved+decrypted connection). The existing session-aware handler becomes `resolveContext(session.orgId) → action(ctx, input)` — **behavior identical to today**. This gives one source of truth per action's Google API call, shared by both the inline handler and the headless executor. No duplicated Directory/Gmail API logic.

`resolveContext` is refactored to resolve from an explicit `orgId` (`resolveContextByOrg(orgId)`); the inline entry point remains a thin wrapper that loads the session, reads `session.orgId`, and calls it — so inline still resolves via the session exactly as before.

### 2. New module `services/googleToolsHeadless.ts`
- `executeGoogleToolHeadless(actionName, args, orgId): Promise<string>` — resolves ctx via `resolveContextByOrg(orgId)` (reusing `loadGoogleConnection` + `authorizeGoogleConnection` + `decryptConnectionKey`) and dispatches to the matching action fn from an **action-fn map**.
- `isHeadlessGoogleTool(name): boolean` — true iff the action-fn map has the key.

**Allowlist is derived, not hand-maintained.** The action-fn map is the effective allowlist, and it must cover **exactly** the Tier-3 entries of `googleToolTiers` (`aiToolsGoogle.ts:40-66`) — the 20 tools: `google_reset_password`, `google_suspend_user`, `google_restore_user`, `google_signout`, `google_set_forwarding`, `google_disable_forwarding`, `google_set_vacation`, `google_update_user`, `google_share_calendar`, `google_offboard_user`, `google_wipe_mobile_device`, `google_add_to_group`, `google_remove_from_group`, `google_move_ou`, `google_rename_user`, `google_reset_2sv`, `google_add_mail_delegate`, `google_remove_mail_delegate`, `google_assign_license`, `google_remove_license`. A **parity contract test** asserts the map's keys equal `{ name | googleToolTiers[name] === 3 }`, so a future Google Tier-3 tool that forgets a headless action fn fails CI rather than silently failing `session_required` in the worker. (Rationale: the repo's recurring "parity list drift reds main" failure mode.)

Tier-1 Google reads never create intents, so the worker never sees them; they are intentionally out of the headless set.

### 3. Worker change (`intentReleaseWorker.ts`)
Replace the blanket `if (requiresLiveSession(actionName)) fail session_required` short-circuit (`250-253`) with:

```
if (isHeadlessGoogleTool(intent.actionName)) {
  rawResult = await withToolTimeout(
    runOutsideDbContext(() =>
      withDbAccessContext(dbAccessContextFromAuth(auth), () =>
        executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId))),
    getToolTimeout(intent.actionName), intent.actionName);
  // then the same result/error categorization as executeTool
} else if (requiresLiveSession(intent.actionName)) {
  await failIntent(intent, 'session_required', ...);   // M365 — deferred
  return;
} else {
  // existing executeTool path (headless-native tools)
}
```

The headless Google call reuses the **same** `withToolTimeout(runOutsideDbContext(withDbAccessContext(...)))` wrapper `executeTool` already runs under, so it inherits the timeout bound on the #1105 connection-hold and the org-scoped RLS context.

## Data flow (worker)
`releaseApprovedIntent(intentId)` → CAS `approved→executing` (stamps `execution_started_at`, `requireNotExpired`) → load intent + winning approval (system tx) → `revalidateApprovedIntentForRelease` (digest / tier / actor-rebuild / org-active / RBAC — **unchanged**) → **`isHeadlessGoogleTool` → `executeGoogleToolHeadless(name, args, intent.orgId)`** under org RLS context + timeout → CAS `executing→completed` (or `failed` with a code).

## Security re-validation at execution
1. `revalidateApprovedIntentForRelease` runs first, unchanged (fail-closed on digest_mismatch / tier_escalated / actor_invalid / org_inactive / rbac_denied).
2. The Google connection is then loaded **fresh** under `intent.orgId`'s RLS context, and `authorizeGoogleConnection(conn, intent.orgId)` re-checks: connection exists, `conn.orgId === intent.orgId`, `conn.status === 'active'`. A connection **revoked or rotated between approval and release** fails closed — the worker records `connection_unavailable` and performs no Google API call. No stale-connection execution is possible.
3. The decrypted service-account key lives in memory only for the call (never logged/returned), same invariant as the inline path.

## Error handling
| Condition | Worker outcome |
|---|---|
| No active Google connection for `intent.orgId` (missing / wrong org / not active) | `failed:connection_unavailable`, no API call |
| Connection key cannot be decrypted | `failed:connection_key_error` |
| Google API returns an error | action fn returns normalized `{error}` JSON → `failed:tool_returned_error` (mirrors existing `executeTool` returned-error handling) |
| Tool exceeds timeout | existing `withToolTimeout` path (bounds #1105 hold; does not cancel underlying, same as inline) |
| Success | `completed`, `result` stored |

**Race fix (folded in):** the memory-noted race — worker wins the `approved→executing` CAS over a still-live inline session and fails `session_required` even though a session existed — **dissolves for Google**: the worker simply executes headless. It remains for M365 (deferred), which is not a regression (pre-branch M365 failed worse, with `Unknown tool`).

## Testing (real Postgres @ 5433; Google client mocked at the client boundary)
Google's SDK clients (`getDirectoryClient` etc.) are mocked at the client-construction boundary — the connection resolution, RLS context, intent lifecycle, and worker dispatch all run against real Postgres.

1. **Headless happy path:** approved Google Tier-3 intent → worker resolves connection by `intent.orgId` → action fn invoked → intent `completed`. Proves it no longer fails `session_required`.
2. **Revoked-after-approval:** connection set `status='inactive'` (or deleted) after approval → `failed:connection_unavailable`, mock Google client never constructed.
3. **Wrong-org connection:** connection row exists but for a different org → `authorizeGoogleConnection` fails → `connection_unavailable` (defense-in-depth over RLS).
4. **Worker-wins-CAS race:** worker claims an intent whose inline session is still notionally live → executes instead of false-failing.
5. **M365 deferral intact (contract):** an M365 session-aware intent still fails `session_required` in the worker.
6. **Parity unit test:** headless action-fn map keys === Tier-3 `googleToolTiers` names.
7. **Inline unchanged (regression):** existing `aiToolsGoogle` handler tests stay green (behavior identical).

## Out of scope / explicitly deferred
- **All M365 headless dispatch** → deferred to the control-plane `customer-graph-actions` executor phase. Worker keeps failing M365 session-aware intents with `session_required`.
- **Delegant connection-capture plumbing** → cancelled (Delegant being decommissioned). `action_intents.connection_id`/`tenant_id` stay dormant.
- **De-sessioning the inline Google chat path** → not done (partner-scope org-resolution risk); worker-only.

## Follow-up bookkeeping
- Update memory `action_intents_durable_approval_review` to record: Phase 2 = Google headless (this branch); Delegant-capture framing retired; M365 headless folded into the `customer-graph-actions` executor phase.
