# AI Kill Switch — Operator Runbook

`ai_kill_state` is a single global database row (`id = 'global'`) that stops
**unattended AI activity platform-wide** when flipped to `killed = true`:

- **Run admission** — new AI agent runs are skipped before they start
  (`runLoop.ts`'s `isStoppedBeforeStart`).
- **Act-mode dispatch** — the live revalidation immediately before an act-mode
  mutation denies (`actRevalidation.ts`).
- **Policy-decided release** — the release authority's final pre-effect check
  denies (`agentReleaseAuthority.ts`), and the policy-decide lane refuses new
  authorizations.
- **Guardrail gate** — `checkAgentGuardrails` denies via the cached snapshot.

It does **not** cancel in-flight tool executions already dispatched to an
agent, and it does not touch human-approved action intents that a technician
executes interactively.

## Propagation bound

Every API/worker process re-reads the row on its hot paths through a **5-second
TTL cache** (`apps/api/src/services/aiKillState.ts`). A flip is therefore
effective within **~5 seconds** in any process exercising those hot paths
(run admission, act-mode dispatch, intent release) — which is every process
that could act unattended; a process that has never hit one since boot only
picks the flip up on its first admission check, which is also the first
moment it could matter. No restart, no deploy. The read fails **closed**: if
a process cannot read the row, it behaves as killed.

Each write increments `epoch` (monotonic, audit-traceable). The admin `GET`
below bypasses the cache and always shows database truth.

## Path 1 — Admin console UI (preferred)

Platform admins can flip the switch from **Administration → AI Kill Switch**
in the web console (`/admin/ai-kill-switch`), backed by the same API as Path
1a below. The page shows the current state, epoch, and last reason/provenance,
and requires a reason on every flip (surfaced as a friendly prompt if MFA
step-up is needed).

> **Production caveat (flagged 2026-08-26): production currently has ZERO
> platform admins in both regions**, so all `/admin/*` surfaces — including
> this one — are unreachable there today. Until a platform admin exists, the
> SQL fallback below is the only usable production path.

## Path 1a — Admin API

Requires a **platform admin** session; **MFA is additionally required for the
POST** (the GET is readable without it).

```bash
# Inspect current state (killed, epoch, reason, provenance)
curl -s https://<region>.2breeze.app/api/v1/admin/ai-kill-state \
  -H "Authorization: Bearer <platform-admin-token>"

# KILL — stop all unattended AI activity
curl -s -X POST https://<region>.2breeze.app/api/v1/admin/ai-kill-state \
  -H "Authorization: Bearer <platform-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"killed": true, "reason": "<incident ref / why>"}'

# RESTORE
curl -s -X POST https://<region>.2breeze.app/api/v1/admin/ai-kill-state \
  -H "Authorization: Bearer <platform-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"killed": false, "reason": "<incident resolved / why>"}'
```

`reason` is mandatory (3–500 chars). Every flip writes an
`ai_kill_state.updated` audit row with the actor, reason, and new epoch.

## Path 2 — SQL fallback

The table is **FORCE ROW LEVEL SECURITY** with a system-only policy, so a bare
`UPDATE` — as `breeze_app` or any non-superuser — is denied. Set the system
scope inside a transaction (the SQL body is identical on every deployment;
only how you reach `psql` differs).

**Hosted droplets** (production): there is **no local postgres container** —
`DATABASE_URL` points at a managed database, and connecting requires the
credentials from the droplet's env. Run a throwaway client against the app
DSN:

```bash
ssh root@<droplet> 'cd /opt/breeze && set -a && . ./.env && set +a && \
  docker run --rm -i --network host postgres:16 psql "${DATABASE_URL_APP:-$DATABASE_URL}"' <<'SQL'
BEGIN;
SET LOCAL breeze.scope = 'system';
-- KILL (for RESTORE, set killed = false)
UPDATE ai_kill_state
SET killed = true,
    epoch = epoch + 1,
    reason = '<incident ref / why>',
    updated_by = NULL,
    updated_at = now()
WHERE id = 'global';
COMMIT;
SQL
```

**Self-hosted / dev** (stock compose with the `breeze-postgres` container):

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze <<'SQL'
BEGIN;
SET LOCAL breeze.scope = 'system';
UPDATE ai_kill_state
SET killed = true, epoch = epoch + 1, reason = '<incident ref / why>',
    updated_by = NULL, updated_at = now()
WHERE id = 'global';
COMMIT;
SQL
```

Verify (same connection method, either deployment):

```sql
BEGIN;
SET LOCAL breeze.scope = 'system';
SELECT killed, epoch, reason, updated_at FROM ai_kill_state WHERE id = 'global';
COMMIT;
```

**The SQL path writes no audit row** (only the API path does). Record the
flip — who, when, why, and the resulting epoch — in the incident ticket.

Always increment `epoch` in the same statement as the flip (the API does this
automatically) — downstream release checks compare epochs, and a flip that
reuses an epoch can be mistaken for stale state.

## Relationship to the env-flag switch

`BREEZE_AI_AGENTS_ENABLED=false` is the coarse boot-time switch (requires a
container restart to change). The DB row is the **operational** switch: fast
(≤5s), auditable, reversible without a deploy. In an incident, flip the DB row
first; reach for the env flag only if the database itself is suspect.

## Before enabling policy-decide (`BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`)

The kill switch's **Policy-decided release** bullet above governs the flag
while it is on; this note governs what must be true *before* flipping it on
in the first place.

Partner-row `actAssets.supervisedActionKeys` is a **ceiling**, not an
inherited grant (P2-5, C3): with no org-level `ai_agents` row, the effective
supervised-key set for that org is `[]`, regardless of what the partner
baseline names. An org only gets a policy-decidable key once an org row
grants it — either an operator writes one directly, or the graduation
promotion flow (`manage_ai_agents:authorize_supervised_key`, Tier-3
four-eyes) appends it after enough verified evidence accrues.

So before flipping `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` on for a partner,
every org under it that should actually get unattended policy decisions
needs its own `ai_agents` row carrying the intended `supervisedActionKeys` —
setting the key on the partner-wide baseline alone authorizes nothing. The
flag is re-read live on every decision (`policyDecide.ts`), so this is a
data-readiness check, not a deploy-ordering one.

## After restoring

- Runs skipped while killed are **not** retried automatically — agents resume
  on their next scheduled/triggered admission.
- Check the per-org circuit breakers (`GET /api/v1/ai-agents/:id/circuit`):
  failure streaks that accumulated before the kill may have opened circuits,
  which only close via manual MFA reset.
