# Network topology M0 rollout proof

M0 installs canonical graph storage and preserves manual work while legacy
clients continue to write. It does not expose the new topology UI, collect
physical evidence, execute diagnostics, or call an AI model. Those capabilities
belong to later waves of [feature #5995](https://github.com/LanternOps/breeze/issues/5995).

## Installation order

Apply migrations in the normal migration runner, before selecting any site for
backfill. The foundation requires all three valid, ready, unique inventory
indexes on `(id, org_id, site_id)`; an invalid concurrent index is a deployment
failure, not permission to continue with missing tenant constraints.

1. `2026-10-20-150000-topology-inventory-fk-targets.sql`
2. `2026-10-20-150100-topology-foundation.sql`
3. `2026-10-20-150200-topology-legacy-capture.sql`
4. `2026-10-20-150300-topology-inventory-lifecycle.sql`

These names follow the newest committed migration at the latest ordering check,
`2026-10-17-110700-report-type-identity-access-review.sql`. When adding a future migration,
recompute the actual newest committed filename and allocate a later `HHMMSS`
slot; the wall-clock date is insufficient.

The capture triggers cover manual nodes, manual relationships, saved legacy
positions, and relevant inventory identity/link/type/site changes. They also
cover old application writers and direct SQL. Unchanged snapshots and heartbeat
updates do not create topology events. A trigger failure rolls the source write
back. No feature flag disables capture.

The lifecycle triggers detach current bindings before inventory moves or
deletion. They retain canonical history, manual facts and pins in the original
site. Organization merges preserve site and canonical UUIDs, fence old work,
recompute scope-derived identities, and normalize pending event ownership inside
the merge transaction. The org-level RLS policies do not enforce site permission
ceilings: every API resource access must also use the application site guard.

## Selected-site migration

Run from an authorized operator environment against explicitly selected scope.
The following variables are operator selections; do not put customer addresses,
credentials or payloads into a proof artifact.

```bash
git rev-parse HEAD
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts capture-status --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts backfill --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts drain --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts compare --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
```

Save the commit, migration basenames, database application role, command exit
codes, capture verification, snapshot barrier, drained revision and JSON parity
report in the deployment evidence. Each backfill/drain invocation processes a
bounded batch. Exit code 2 and a `resumeToken` mean the barrier is incomplete:
repeat backfill with `--resume <runUUID>`, or repeat drain through the reported
barrier using `--through <revision>`, until complete. Do not move to a pilot based solely on a
successful backfill command. The required parity fields are:

```json
{
  "pendingThroughBarrier": 0,
  "unexplainedManualDifferences": [],
  "unexplainedPinDifferences": [],
  "resurrectedTombstones": []
}
```

Capture must precede backfill. Drain and comparison must refer to the same
barrier. Event UUID allocation is not commit order; only the serialized per-site
revision is an ordering fence. Resume an interrupted import from its durable
checkpoint and compare again. No GET or worker startup initiates a backfill.

Legacy positions map to Overview only. Physical and Logical layouts remain
independent. Ambiguous legacy drag intent is conservatively pinned. Accepted
inventory links use their stored reference; matching names or IP addresses do
not merge devices. A legacy link with unknown physical provenance remains an
inferred attachment, not a measured cable.

## Restart and retention contract

The importer stages a consistent source snapshot in reserved, versioned
`legacy.snapshot` outbox envelopes under the site serialization lock. Staging is
atomic; canonical application drains in bounded, restartable batches. Delivery
revisions order staging and later captured mutations; source revisions arbitrate
whether a particular legacy fact can replace its existing canonical value. Do
not interchange those two fields.

The bounded `effectiveSettings.legacyImport` object is internal checkpoint
metadata. Future settings writers must preserve it rather than replace the
entire settings document. Pending snapshot rows are never eligible for delivered
outbox retention. Canonical node, relationship and position tombstones preserve
source fences beyond ordinary outbox retention. An unresolved delete whose
canonical endpoints never existed must retain its delete envelope until a
durable canonical fence can replace it; inventing endpoints would create a false
topology.

Revoking an accepted inventory link restores the relevant retained source IDs
and reassigns live bindings in the publication transaction. Historical manual
connections and pins stay at their existing IDs; a split does not guess which
side owns them. The split is audited and invalidates older builds. Relinking
still requires accepted identity evidence and compatible manual facts/pins.

After a split, a retained user pin or manual fact whose source ownership is
ambiguous can remain at the prior canonical ID. Shadow comparison reports
that difference using bounded opaque identifiers. Resolve it through an explicit
operator edit, then drain and compare again; a completed drain alone does not
waive a parity mismatch.

Publication acquires inventory reference locks without waiting when a source is
being deleted or moved. A conflict rolls the entire attempt back; the repair
worker and operator CLI retry in a fresh authorized transaction. Request writes
return a retryable conflict after rollback. No failed attempt acknowledges an
outbox event or commits a partial layout.

Snapshot staging holds a site lock for the source copy. Its duration and row
volume must be measured for a production-sized site before broad rollout.
Legacy nonmanual inferred links are not part of the manual-write capture
guarantee. Manual facts, explicit pins and deletions are release gates.

## Rollback

Stop materialization and leave UI, physical collection, interface health,
diagnostics and AI flags disabled. Keep the schema, lifecycle hooks and capture
triggers installed. Legacy reads and writes continue; captured edits accumulate
durably until consumption resumes. Do not drop canonical data, reset revision
fences, or delete pending outbox rows. Before re-enabling materialization, drain
and compare the selected sites again.

## Validation scope

Use a private disposable Postgres/Redis test stack. Verify `breeze_app` has
neither superuser nor `BYPASSRLS` privileges. Integration setup truncates test
fixtures, so only one runner may own that database at a time.

The test suites cover source rollback and delayed commits, duplicate delivery,
source tombstones, atomic publication, alias pin/manual conflicts, site/org
isolation, revisioned writes, tenant moves/merges/erasure and legacy parity.
TypeScript compilation uses the API's CI memory allowance:

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter @breeze/api test:rls-coverage
pnpm db:check-drift
```

The inventory-index experiment used 100,000 device rows, 50,000 discovered asset
rows and 10,000 manual rows with synthetic payloads. It proved concurrent index
construction and writes on that fixture; it does not establish production
capacity or the cost of collection at 10,000 agents. M0 is a backend foundation;
no public UI readiness or production rollout is implied by local test results.
