# M365 tenant sync — capacity benchmark

Spec: `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` §5.11.

This benchmark is **not** part of CI. Run it before enabling
`M365_TENANT_SYNC_ENABLED` on a region for the first time, and again whenever
the fleet's org count roughly doubles or the sync cadence defaults change.

## What it measures

| Metric | Source | Pass criterion |
|---|---|---|
| Tick drain p95 | wall clock per ticker iteration | ≤ 60 s (a tick finishes before the next fires) |
| Ticker utilisation | completed runs ÷ (`--tick-batch` × ticks) | ≤ 0.50 (spec §5.9 capacity rule) |
| Max queue depth | rows claimed but not yet run | ≤ 500 (`M365_SYNC_MAX_BACKLOG` default) |
| WAL bytes | `pg_current_wal_lsn()` delta over the window | reported, no fixed limit — compare across runs |
| Pool occupancy peak | `pg_stat_activity` non-idle for the app role | ≤ 50 % of `max_connections` |
| Foreground probe p95 | an unrelated indexed query sampled every second | ≤ 50 ms |
| Steady-state entity writes | second pass over an unchanged tenant | 0 rows for users / CA / SKUs / Secure Score |

The pass criteria are fixed in `apps/api/scripts/m365-sync-benchmark.lib.ts`
(`BENCHMARK_PASS_CRITERIA`) and were written before the first run. Do not edit
them to make a run pass; a failure is a capacity finding.

Ticker utilisation counts **completed runs**. A `signin_activity` call that
comes back with a continuation is reported separately as `pagesCompleted`: it
did real work, but its row is due again immediately, so counting it as a run
would understate utilisation. The driver also aborts if any domain returns
`'noop'` — that means no persister is registered for it, and a domain doing no
work drains instantly and invents headroom that does not exist.

`intune_devices` and `signin_activity` are excluded from the steady-state
zero-write criterion by design (spec §5.9): device rows carry
`last_intune_sync_at` in the hash and churn every run, and sign-in activity
writes only changed timestamps.

## Environment

Run against a **production-class managed Postgres** — the hosted regions use a
1 vCPU managed class. A laptop container has a different fsync profile and
different `max_connections`; numbers from one are not comparable to the other.

1. Provision a throwaway database on the same managed class and region as
   production. Never point this at a production database: it inserts ~`--orgs`
   organizations and deletes them again on exit.
2. Apply migrations: `DATABASE_URL=<throwaway> pnpm db:migrate`.
3. Export the app role URL the API itself uses:

```bash
export DATABASE_URL=postgresql://<superuser>@<host>:25060/breeze?sslmode=require
export DATABASE_URL_APP=postgresql://breeze_app@<host>:25060/breeze?sslmode=require
export M365_TENANT_SYNC_ENABLED=true
```

The benchmark script itself only reads `DATABASE_URL_APP` — the sync work,
and the WAL/`pg_stat_activity` reads it reports, all run through that same
`breeze_app` pool (both `pg_current_wal_lsn()` and `pg_stat_activity` for a
role's own connections are executable by an unprivileged role on stock
Postgres, no extra grant needed). `DATABASE_URL` above is only consumed by
the `pnpm db:migrate` step before the benchmark runs.

## Run

```bash
pnpm --filter @breeze/api m365-sync:benchmark \
  --orgs=1000 --window-minutes=60 --executor-latency-ms=200 \
  --concurrency=4 --tick-batch=200
```

Do **not** put a bare `--` before the flags — this is a plain `tsx` entrypoint,
not vitest, but pnpm still forwards a literal `--` into argv rather than
stripping it, and the parser would otherwise reject it as an unknown
argument. (The parser tolerates a stray `--` defensively, but the example
above is the form to copy.)

Flags: `--orgs`, `--window-minutes`, `--executor-latency-ms`,
`--concurrency`, `--tick-batch`, `--probe-interval-ms`, `--seed`,
`--keep-data` (skips the cleanup delete so you can inspect the rows).

A full 1 000-org / 60-minute run takes just over an hour of wall clock. Run it
in `tmux`; it prints the report to stdout and a JSON blob after it.

## Recording a result

Paste the JSON report into the release's readiness note together with:

- Postgres version, instance class, and `max_connections`
- the region it ran in
- the git SHA of `apps/api`
- any criterion that failed and the dial you turned (`--tick-batch` is the
  ticker dial; `M365_SYNC_CONCURRENCY` is the worker dial;
  `M365_SYNC_MAX_IN_FLIGHT` is the executor dial)

If ticker utilisation exceeds 0.50, raise `M365_SYNC_TICK_BATCH` and re-run —
that is the documented remedy in spec §5.9, not a reason to lengthen cadences.
