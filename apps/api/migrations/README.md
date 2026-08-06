# Core migrations

Hand-written SQL, applied by `apps/api/src/db/autoMigrate.ts` on API boot.
`optional/` is **not** auto-applied (TimescaleDB extras).

Enforced by `scripts/check-migration-naming.sh` — it runs as a pre-commit hook
and again in CI, so you find out here rather than in a red `Test API`.

## Naming

- **`YYYY-MM-DD-<slug>.sql`.** The runner discovers files matching
  `^\d{4}-.*\.sql$` and applies them in `localeCompare` order. A filename that
  does not match is not rejected — it is **silently never applied**.
- The legacy `NNNN-<slug>.sql` form is accepted only for files predating the
  date-prefix switch. Don't add new ones.
- **Same-day ordering:** when two migrations on the same date depend on each
  other, insert an explicit `-a-`/`-b-` infix *between the date and the slug*:
  `2026-04-19-a-installer-bootstrap-tokens.sql`,
  `2026-04-19-b-installer-bootstrap-tokens-constraints.sql`. Don't rely on the
  slug to sort for you — `-` (0x2D) sorts before `.` (0x2E), so `foo-bar.sql`
  sorts *after* `foo-bar-extra.sql` (#506).
- The infix letters are **per-date and local to that date**. They are not a
  global sequence, and they never continue across dates.

## Reserved / closed date blocks

Some dates are closed: their files have shipped, are content-hash immutable,
and later migrations re-create objects they define. Adding a file to a closed
block replays in the wrong order on a fresh database.

| Date | Status | Contents |
|---|---|---|
| `2026-08-06` | **CLOSED** | The eight security-remediation wave migrations, slots `-a-` … `-f-`. |

**Do not add `2026-08-06-g-` (or `-h-`, `-i-`, …).** Three separate authors
reached for exactly that (#2995, #3008, and a plan doc), because the same-day
convention above reads as "take the next free letter" — which is normally
correct, just not on a closed date. #2995 merged and reddened `main`.

If you need your migration to **sort after everything already shipped**, use a
plain `YYYY-MM-DD-<slug>.sql` on a date after the block. Today's date already
sorts last; that is the property you actually want, and it does not collide
with anything.

## Content rules

- **Idempotent.** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$ BEGIN … EXCEPTION`,
  `pg_policies` existence checks for policies. Re-applying must be a no-op.
- **No inner `BEGIN;` / `COMMIT;`.** `autoMigrate` already wraps each file in a
  transaction; your own block just emits `NOTICE: there is already a
  transaction in progress`. (Use the `-- @no-transaction` first-line directive
  for `CREATE INDEX CONCURRENTLY` and friends.)
- **Cleanup statements must report row counts.** Wrap an `UPDATE`/`DELETE` of
  suspect rows in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE
  WARNING 'cleaned % <what>', n; END IF; END $$;` so the count lands in Postgres
  logs. Silently fixing bad data destroys the forensic trail.
- **RLS policies ship in the same migration that creates the table** — never
  deferred. See the tenancy shapes in the root `CLAUDE.md`.

## Never edit a shipped migration

`breeze_migrations` records a SHA-256 of each applied file, and the API refuses
to boot on a mismatch — so *any* content change (even a comment) bricks every
database that already applied it, while CI stays green migrating from empty.
`scripts/check-migration-immutability.sh` enforces this against the latest
release tag. Fix forward with a new migration.

**Renaming counts as editing**, and it has a second blast radius: integration
suites replay migrations **by path**
(`readFileSync('../../../migrations/<file>.sql')`). A rename that misses those
references fails as an `ENOENT` several minutes into Integration Tests, not as
a compile error. `autoMigrate.test.ts` asserts every such reference resolves,
so the unit job catches it first — but only if you run it.

## Checklist for a new migration

1. Write `apps/api/migrations/YYYY-MM-DD-<slug>.sql` (add `-a-`/`-b-` only if
   you have a same-date dependency).
2. Update the Drizzle schema in `apps/api/src/db/schema/`.
3. `pnpm db:migrate && pnpm db:check-drift`.
4. New tenant-scoped table? Work the RLS + cascade + export-policy registration
   lists in the root `CLAUDE.md` — they are separate contracts and the missed
   one is always a cascade list.
5. `pnpm --filter @breeze/api test src/db/autoMigrate.test.ts`.
