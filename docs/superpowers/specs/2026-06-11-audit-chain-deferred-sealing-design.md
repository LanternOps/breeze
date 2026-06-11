# Audit Hash-Chain: Deferred Commit-Time Sealing (issue #1002)

**Status:** approved design, ready to implement (plan: `docs/superpowers/plans/2026-06-11-audit-chain-deferred-sealing.md`)
**Supersedes:** draft PR #1240 (advisory-lock-in-BEFORE-trigger — proven to deadlock, see below)

## Problem

The `audit_logs` tamper-evidence chain (PR #900) forks under concurrent same-org
inserts: the BEFORE INSERT trigger reads the latest committed checksum as `prev`
with no serialization, so N concurrent transactions all chain off the same
predecessor. `audit_log_verify_chain()` then reports false-positive breaks
(observed in production: US droplet, v0.68.2, ~20 false breaks in minutes).
False positives make real tampering indistinguishable — the control is dead
until fixed.

## Why the obvious fix deadlocks (do not re-attempt)

Draft PR #1240 added `pg_advisory_xact_lock(1000200, hashtext(org))` inside the
BEFORE INSERT trigger. The lock is held **until the transaction commits**, and
this codebase legitimately writes audit rows on **two connections within one
logical flow**:

- (a) the caller's own audit insert **inside** its request transaction
  (`withDbAccessContext` wraps the request in a tx; the row must roll back with it), and
- (b) `logSessionAudit` (`apps/api/src/routes/remote/helpers.ts`), which
  deliberately **escapes** onto a separate pooled connection so the audit row
  survives a caller rollback.

Same org → (a) holds the advisory lock for the whole caller tx; (b)'s trigger
blocks on that lock; the caller tx is `await`ing (b) in JS. Postgres cannot see
the JS-side wait, so there is no deadlock detection — it hangs until timeout.
Reproduced deterministically by
`audit-logs-rls.integration.test.ts > "transaction isolation: audit row persists
even when caller request tx rolls back"` (30 s timeout). **Any** held-to-commit
per-org serialization (advisory lock, `SELECT … FOR UPDATE` on a head row) has
the same hang.

## Design: seal the chain at COMMIT, in a side table

Move chain linkage out of the insert path entirely. Serialization happens only
inside commit processing, where no application code can interleave an `await`.

### Components

1. **`audit_log_chain` side table** — one row per sealed audit row:

   | column | type | notes |
   |---|---|---|
   | `chain_seq` | `bigserial` PK | total order of the chain (per-org subsequences are walked by `WHERE org_id … ORDER BY chain_seq`) |
   | `audit_id` | `uuid` FK → `audit_logs(id)` ON DELETE CASCADE, UNIQUE | one seal per audit row |
   | `org_id` | `uuid` NULL, FK → `organizations(id)` | chain key; NULL = system chain (mirrors `audit_logs.org_id`) |
   | `content_checksum` | `varchar(128)` NOT NULL | `sha256(audit_log_canonical_payload(row, NULL))` — content-only, recomputable from the audit row |
   | `prev_chain_checksum` | `varchar(128)` NULL | previous entry's `chain_checksum` (NULL = genesis; non-NULL on an org's first surviving entry = retention-pruned history, treated as the trusted anchor) |
   | `chain_checksum` | `varchar(128)` NOT NULL | `sha256(COALESCE(prev,'') \|\| '\|' \|\| content_checksum)` |
   | `sealed_at` | `timestamptz` DEFAULT now() | informational |

2. **BEFORE INSERT trigger** (`audit_log_compute_checksum`, redefined): computes
   a **content-only** checksum (`canonical_payload(NEW, NULL)`), sets
   `prev_checksum := NULL`. **No predecessor read, no lock.** The legacy
   `checksum`/`prev_checksum` columns on `audit_logs` become vestigial (old rows
   keep their historical values; nothing reads them — verified by grep).

3. **Deferred seal trigger** — `CREATE CONSTRAINT TRIGGER … AFTER INSERT ON
   audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` → `audit_log_seal_chain()`,
   which calls a shared `audit_log_seal_one(audit_logs)` function:
   - `pg_advisory_xact_lock(1000200, hashtext(COALESCE(org,'NULL')))` — acquired
     **at commit time**, held only through the remaining commit processing
     (sub-millisecond), never across application awaits.
   - Read the org's chain head (`ORDER BY chain_seq DESC LIMIT 1`, branched on
     NULL org for index use).
   - Insert the chain entry.

4. **`audit_log_verify_chain(p_org_id)` v2** — same name and signature
   (`RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)`), so the
   daily alerting cron (`auditChainVerify.ts`, from #1240) and existing tests
   work unchanged. Walks the chain table in `chain_seq` order and flags:
   - linkage break (`prev_chain_checksum` ≠ previous entry's `chain_checksum`);
     the **first surviving entry's prev is the trusted anchor** (NULL for a
     virgin chain; a non-NULL value refers to retention-pruned history — see
     "Retention" below for why there is deliberately no re-anchor rewrite);
   - chain-hash mismatch (recompute `sha256(prev || '|' || content)`);
   - content tamper (recompute canonical hash from the live `audit_logs` row,
     compare to `content_checksum`);
   - dangling seal (chain entry whose audit row is gone);
   - **unsealed audit row** (audit row with no chain entry = chain-row deletion).

5. **Backfill** (in the same migration): seal every existing un-sealed audit row
   per org in `(org NULLS FIRST, timestamp, id)` order via `audit_log_seal_one`.
   `NOT EXISTS`-guarded → idempotent; ignores the legacy (possibly forked)
   `prev_checksum` values entirely — no UPDATE of `audit_logs`, no history rewrite.

### Why this kills the deadlock (trace of the failing test)

T1 (caller tx) inserts audit row → BEFORE trigger computes content hash, **no
lock**. T1 awaits `logSessionAudit` → T2 (separate connection) inserts + commits
→ T2's deferred seal takes the lock (free — T1 holds nothing), seals, releases at
commit end. T1 throws → rollback → T1's row and its **pending** deferred trigger
vanish. No deadlock; no fork; (b) sealed, (a) gone — exactly the required
semantics.

Concurrent same-org commits serialize on the lock for microseconds at commit;
each seal's head SELECT runs in a fresh READ COMMITTED snapshot taken after the
previous committer released the lock (advisory xact locks release in post-commit
cleanup, after the commit is visible), so it sees the new head. Same-tx
multi-row batches seal in insertion order within one lock hold — this also fixes
the *other* documented limitation (same-transaction batches, noted in
`audit-checksum.integration.test.ts`).

### Anti-fork hard guarantees (defense-in-depth)

Two partial unique indexes convert any residual fork (e.g. a future caller using
REPEATABLE READ, where the head SELECT could read a stale snapshot) into a
**loud constraint violation** instead of a silent fork:

- `UNIQUE (prev_chain_checksum) WHERE prev_chain_checksum IS NOT NULL` — no two
  entries may chain off the same predecessor.
- `UNIQUE ((COALESCE(org_id::text,'NULL'))) WHERE prev_chain_checksum IS NULL` —
  one genesis per org chain.

### Tamper-resistance of the side table

**Stronger than `audit_logs`:** RLS enabled + forced with the standard four
shape-1 policies (`breeze_has_org_access(org_id)` — auto-discovered by
`rls-coverage`, no allowlist entry); `breeze_app` gets SELECT+INSERT only
(UPDATE/DELETE revoked); append-only trigger allows **DELETE only** under
`breeze.allow_audit_retention='1'` — **UPDATE is never allowed**, not even for
retention, because the design needs no chain rewrite ever (see Retention).
DELETE granted to `breeze_audit_admin` only (post-#915 a separate login
credential). Hiding an `audit_logs` tamper by rewriting the chain therefore
requires DBA-level access, not just app-level SQL or even the audit-admin
credential.

### Retention: prefix-cut delete, NO re-anchor

`chain_seq` order is **commit order**, which can disagree with `timestamp` order
around long-running transactions. A raw `timestamp < cutoff` DELETE could
therefore punch a mid-chain hole. Fix: retention deletes the **maximal chain
prefix entirely older than the cutoff** (everything with `chain_seq` below the
first "young" row), plus any unsealed old rows. Stragglers behind a young row
survive one extra cycle and are caught as the prefix advances.

**There is deliberately no re-anchor rewrite.** Recomputing the surviving
head's `chain_checksum` (the v1 approach) would invalidate its *successor's*
stored `prev_chain_checksum` — a self-inflicted break. Instead the verifier
treats the first surviving entry's `prev_chain_checksum` as the trusted anchor:
its linkage refers to legitimately pruned history. The chain-hash and content
checks still apply to that entry in full. Trust-model consequence: an actor who
can DELETE chain+audit rows (audit-admin credential + GUC) can truncate a
prefix undetectably — identical to the previous design's trust model, since
retention is exactly that operation. Mid-chain deletions remain detectable
(unsealed-row sweep + successor linkage break). `deleteAndReanchor` in
`auditRetention.ts` becomes `deleteChainPrefix` and stops touching
`audit_logs.checksum`/`prev_checksum` entirely — `audit_logs` itself is never
UPDATEd by retention anymore.

### GDPR / tenant erasure

`audit_log_chain` has `org_id` → it joins `ORG_CASCADE_DELETE_ORDER` (between
`audit_baselines` and `audit_logs`; FK topo-sort deletes it before `audit_logs`
anyway) and `AUDIT_ADMIN_REQUIRED_TABLES` in `tenantCascade.ts` (its direct
DELETE needs the same `SET LOCAL ROLE breeze_audit_admin` + retention-GUC bypass
as `audit_logs`). `tenantExport` picks it up automatically from the list.

## Accepted edges (documented, not blocking)

- **Cross-org multi-row transactions** can theoretically deadlock at commit if
  two such transactions seal orgs in opposite orders. This is a *DB-detectable*
  deadlock (instant `40P01` error on one side, retryable) — not a silent hang.
  Multi-org single-tx audit writers are rare system jobs; acceptable.
- **Chain order ≠ timestamp order** near long transactions. Verification and
  retention key on `chain_seq`; timestamp ordering is display-only.
- **`breeze_migrations` note:** draft #1240's `2026-06-11-a-/-b-` migrations were
  never merged but *were applied to local dev/test DBs*. New migrations use fresh
  filenames (`-g-`, `-h-`); recorded-but-absent filenames are ignored by the
  runner, and `-h-`'s `CREATE OR REPLACE` converges any DB that ran the draft
  trigger. Fresh test DB (`pnpm test:docker:down && pnpm test:docker:up`) is the
  clean path locally.

## Out of scope (tracked elsewhere)

- External anchor for the chain head (#916) — infra decision pending.
- Excluding high-volume telemetry from the chain — worthwhile follow-up to shrink
  the chain; not needed for correctness now.
- Making `audit_logs` strictly append-only again (retention no longer UPDATEs it)
  — possible future hardening of `audit_log_immutable`.
