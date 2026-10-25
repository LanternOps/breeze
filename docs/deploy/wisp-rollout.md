# Wisp — Rollout Checklist

Wisp (spec `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md`,
feature #9906) ships **dark**. Every route, job, tool handler and finalizer
short-circuits while `wispEnabled()` is false, so merging and deploying the
waves changes nothing until the flag is flipped on a hosted deployment. This
checklist is the flip. It names no hosts: run each step against the regional
deployment you are rolling out to.

Two independent switches carry the feature:

| Flag | Gates | Needs |
|---|---|---|
| `BREEZE_WISP_ENABLED` | The Wisp **engine and home**: grants, assessments, concerns, nudges, memory, specialists, `/admin/wisp`. | `IS_HOSTED=true` and `BREEZE_AI_AGENTS_ENABLED=true`. Production refuses to boot with it on otherwise. |
| `BREEZE_WORKSPACE_ENABLED` | Wisp's **knowledge connector** (the `ee/workspace` file/email index). User-facing copy calls it Wisp; its technical identity stays `workspace`. | A Postgres image with **pgvector**. Optional: the engine runs without it. |

Per partner, the commercial switch is the `wisp` **entitlement** (on by default
for Pro, Enterprise and Unlimited). The entitlement never overrides a kill
switch: `BREEZE_AI_AGENTS_ENABLED`, the AI kill state and the flags above all
still win.

## 1. Environment (hosted API **and** worker)

- [ ] `IS_HOSTED=true`
- [ ] `BREEZE_AI_AGENTS_ENABLED=true`
- [ ] `BREEZE_WISP_ENABLED=true`
- [ ] `ENABLE_2FA` left on (unset or true). Production refuses to boot with
      `BREEZE_WISP_ENABLED=true` and `ENABLE_2FA` off: grants are created and
      refreshed on a step-up proof.
- [ ] Only if `analysis` specialists are wanted: `BREEZE_AI_WORKSPACE_ENABLED=true`
      plus the sandbox settings it requires (`AI_WORKSPACE_BACKEND=vercel`, the
      three `VERCEL_*` values, artifact storage). Without it, `analysis`
      requests are refused and every other specialist kind still works.
- [ ] Only if the knowledge connector is wanted: `BREEZE_WORKSPACE_ENABLED=true`
      on a pgvector-capable Postgres image (see the upgrade caveat in
      `deploy/.env.example`).
- [ ] Set the flags on **both** the API and the worker services; the worker
      runs the wake scheduler, assessments, nudges and the specialist release
      path. A flag on only one side gives routes without engine (or the reverse).

## 2. Migrations

- [ ] Every Wisp migration is applied in the region (they run on API boot):
      `2027-01-04-100000-partner-entitlements`, `…-100100-wisp-grants`,
      `…-100110-ai-workspace-execute-permission`, `…-110100-ai-memory-blocks`,
      `…-110200-wisp-threads`, `…-110300-wisp-concerns-watches`,
      `…-110350-ai-agent-runs-assessment-profile`, `…-110400-wisp-nudge-preferences`,
      `2027-01-05-100400-wisp-specialist-lineage` (specialists,
      W07) plus the W08 home migrations once those waves land.
      Confirm with `SELECT filename FROM breeze_migrations WHERE filename LIKE '2027-01-0%' ORDER BY 1`
      — the result must include every Wisp migration above (the `2027-01-0*`
      range also holds unrelated migrations).
- [ ] `pnpm db:check-drift` is clean against the deployed tag.

## 3. Entitlements

- [ ] On a Pro partner, `GET /api/v1/partner/me/entitlements` shows `wisp`
      enabled with limits `{ maxGrants: 25, budgetCentsPerDayCeiling: 1000,
      minFloorTickMinutes: 15 }` (Enterprise `100 / 2500 / 15`, Unlimited
      `500 / 5000 / 15`).
- [ ] Community and Starter partners get Wisp only through a manual
      platform-admin entitlement grant (spec §16). Decide the list before the flip.

## 4. Permissions

Partner Admin holds the wildcard `*:*`, which covers every Wisp permission
including `ai_workspace:execute`. Verify no partner's seeded Partner Admin role
lost it:

```sql
SELECT p.id
  FROM partners p
 WHERE NOT EXISTS (
   SELECT 1
     FROM roles r
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions pm ON pm.id = rp.permission_id
    WHERE r.partner_id = p.id
      AND r.name = 'Partner Admin'
      AND r.is_system
      AND pm.resource = '*'
      AND pm.action = '*'
 );
```

- [ ] The query returns no rows. Any partner it does return gets
      `ai_workspace:execute` granted to its admin role through the Roles UI — no
      migration (the wildcard covers everything else).

## 5. Kill-switch rehearsal (before announcing)

- [ ] Flip `BREEZE_WISP_ENABLED=false` on API + worker and restart: every
      authenticated request to `/api/v1/wisp/*` and `/api/v1/admin/wisp/*`
      returns 404 (unauthenticated requests still get 401 first), the wake
      scheduler admits no assessments, and existing grants are untouched
      (still `active` in `wisp_grants`).
- [ ] Flip it back on: the next floor tick resumes assessments without any
      grant needing a refresh.
- [ ] The global AI kill switch (`docs/deploy/ai-kill-switch.md`) also stops
      Wisp assessments and specialist runs, because both are agent runs.

## 6. Alerts

The `wisp_*` series below are registered by `apps/api/src/services/wispMetrics.ts`
(W07a, #9913). Confirm they appear on the API's metrics endpoint at the deployed
tag before wiring alerts.

- [ ] Alert on `rate(wisp_budget_exhausted_total[1h])` (an exhausted budget
      does **not** pause the grant — assessments are skipped and the grant stays
      `active` — so `wisp_grant_pauses_total{reason="budget_exhausted"}` stays
      flat and is the wrong signal) and on any growth of
      `wisp_specialist_requests_total{outcome="refused"}` (a refusal spike means
      a ceiling, budget or permission regression).
- [ ] Alert on `wisp_grant_pauses_total{reason=~"grantor_access_lost|grantor_suspended|entitlement_lost"}`
      growth: grants pausing for authority reasons in bulk points at an RBAC or
      entitlement change, not user behaviour.
- [ ] Dashboard: `wisp_grants_active`, `wisp_assessments_total` by outcome,
      `wisp_nudges_total` by result. No series carries a partner label; per
      partner numbers live on `/admin/wisp`.

## 7. Flip order

- [ ] **EU first.** Flip, then watch `/admin/wisp` (active grants, pauses,
      assessments today, specialist requests, budget-exhausted grants) and the
      alerts above for **24 hours**.
- [ ] **Then US**, same checks.

## 8. Rollback

- [ ] Rollback is **the flag off** (`BREEZE_WISP_ENABLED=false` on API +
      worker). Data stays: grants, memory, threads and concerns are kept and
      resume when the flag returns.
- [ ] **Never revert a Wisp migration.** The schema is inert with the flag off.
