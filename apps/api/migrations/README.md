# Core migrations

Hand-written SQL, applied by `apps/api/src/db/autoMigrate.ts` on API boot.
`optional/` is **not** auto-applied (TimescaleDB extras).

Enforced by `scripts/check-migration-naming.sh` — it runs as a pre-commit hook
and again in CI, so you find out here rather than in a red `Test API`.

The pre-commit guard only compares a new migration against history already
reachable from the branch's own HEAD — it cannot see a migration that lands on
`origin/main` *after* the branch was cut. A separate `pre-push` hook re-runs
the same script as `check-migration-naming.sh --against-ref origin/main`
(after fetching `origin/main` itself, and warning rather than blocking if that
fetch fails, e.g. offline), so a branch whose migration sorted fine at commit
time but has since been overtaken by `origin/main` fails locally, at push
time, instead of surfacing later in CI's `Check Migrations` job on the merge
commit — the round-trip that motivated adding this check. If it fails, rename
the migration to sort after the newest one it names on `origin/main`.

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
| `2026-08-06` | **CLOSED** | Eight shipped migrations in slots `-a-` … `-f-`. Mostly the security-remediation waves, plus two same-day migrations from unrelated work that landed in the block (`-e-action-intents-origin-principal`, `-f-m365-comms-delegated`). |

The block is closed because those eight files carry ordering dependencies on
each other and are content-hash immutable — not because everything in it is
remediation content.

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
- **Writing rows requires system scope first.** Before the first
  `UPDATE`/`DELETE`/`INSERT`/`MERGE` in the file:

  ```sql
  SELECT set_config('breeze.scope', 'system', true);
  ```

  (or `PERFORM set_config('breeze.scope', 'system', true);` as the first
  statement inside a `DO` block). `breeze_current_scope()` defaults to `'none'`
  (`0012-tenant-rls-deny-default.sql`) and 425 of the 442 public tables are
  `FORCE ROW LEVEL SECURITY`, which binds the table **owner** too — and the
  owner is the role migrations run as. On a connection that does not bypass
  RLS, an unwrapped `UPDATE`/`DELETE` therefore matches **zero rows with no
  error** — your `RAISE WARNING` prints a truthful-looking `0 cleaned` and the
  migration moves on — and an unwrapped `INSERT` aborts with 42501. Reference
  file: `2026-09-30-100000-rls-scoped-backfill-replay.sql`.

  `is_local = true` scopes the setting to autoMigrate's per-file transaction,
  so one line at the top covers the whole file — **except** in a
  `-- @no-transaction` file, where each statement is sent separately and the
  elevation must sit inside the same statement as the write.

  Enforced by `apps/api/src/db/migrationRlsScope.test.ts` in the **Test API**
  job. It carries a frozen baseline of the 122 shipped migrations that predate
  the rule; that list is capped at a cutoff filename, so a new migration
  **cannot** be silenced by adding it. See issue #4518.

## Never edit a shipped migration

`breeze_migrations` records a SHA-256 of each applied file, and the API refuses
to boot on a mismatch — so *any* content change (even a comment) bricks every
database that already applied it, while CI stays green migrating from empty.
`scripts/check-migration-immutability.sh` enforces this against the highest
semantic-version release tag reachable from the checked commit. Higher tags on
other lineages must have reviewed provenance: exact registered candidates stay
frozen on their candidate lineage, while applicable stable side-branch releases
are checked as additional baselines. A higher tag already reachable from
`origin/main` means the checked branch is behind main and fails closed. Automatic
resolution requires full history and tags; pass an explicit base ref only when
you deliberately need a deterministic one-baseline comparison. Fix forward with
a new migration.

**Renaming counts as editing**, and it has a second blast radius: integration
suites replay migrations **by path**
(`readFileSync('../../../migrations/<file>.sql')`). A rename that misses those
references fails as an `ENOENT` several minutes into Integration Tests, not as
a compile error. `autoMigrate.test.ts` asserts every such reference resolves,
so the unit job catches it first — but only if you run it.

**A replayed migration must go through `replayMigration`, not a bare
`readFile` + `sql.raw`.** If the file redefines a SQL function
(`CREATE OR REPLACE FUNCTION`) that a LATER migration also redefines, a bare
replay reverts that function to the earlier body for the rest of the vitest
process — silently breaking any later suite in the same shard/CI job that
depends on the later body (#3205 W07 / PR #4838).
`apps/api/src/__tests__/integration/replayMigration.ts` re-applies every
later definer automatically; see its header comment.

## Checklist for a new migration

1. Write `apps/api/migrations/YYYY-MM-DD-<slug>.sql` (add `-a-`/`-b-` only if
   you have a same-date dependency).
2. Update the Drizzle schema in `apps/api/src/db/schema/`.
3. `pnpm db:migrate && pnpm db:check-drift`.
4. New tenant-scoped table? Work the RLS + cascade + export-policy registration
   lists in the root `CLAUDE.md` — they are separate contracts and the missed
   one is always a cascade list.
5. Does it write rows? Elect system scope first (see Content rules).
6. `pnpm --filter @breeze/api test --run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`.

## Rule 3 — a new migration must sort AFTER every committed one

`autoMigrate` applies files in `localeCompare` order. The only property a new
filename must have is that it sorts after everything already shipped. A file
that sorts into the middle replays before migrations it may depend on: it
passes on your already-migrated database and fails on a fresh one.

**Do not assume today's date gives you that.** It does not, and has not since
around 2026-06-12.

Filenames drifted ahead of real time in a compounding ratchet. Each author who
needed sort-last picked one day past the highest existing filename rather than
today's date; that raised the ceiling, so the next author had to go further
still. The September-dated block is perfectly sequential (`09-01`, `09-02`, …
`09-10`), which is the signature. As of 2026-08-26:

- 169 of 466 dated migrations are named ahead of the day they were committed
- the furthest is +16 days (`2026-09-10-device-command-uninstall-provenance.sql`,
  committed 2026-08-25)
- the drift began at +1 day (`2026-04-12-drop-policy-compliance.sql`)

Shipped migrations are content-hash immutable and keyed on filename in
`breeze_migrations`, so they cannot be renamed back — a rename makes every
already-migrated database re-apply the file under its new name. The ceiling
therefore stands until real time catches up with it, and shrinks on its own
as it does.

So: **compare against the files, not the calendar.**

```bash
git ls-tree --name-only HEAD apps/api/migrations/ | sed 's#.*/##' \
  | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);
             console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
```

`scripts/check-migration-naming.sh --staged` enforces this at commit time (and
in CI). It compares with `localeCompare` via `node`, not shell `sort`, because
the runner uses `localeCompare` and shell collation disagrees with it on
exactly the punctuation these filenames are full of — a guard that ordered
differently from the runner would bless files that then replay in a different
order than it checked.

### Preferred format for new migrations

`YYYY-MM-DD-HHMMSS-<slug>.sql`. The time component orders same-day migrations
natively, which removes the need for the hand-assigned `-a-`/`-b-` infix — the
convention whose "take the next free letter" reading produced the closed-block
incidents three separate times. Plain `YYYY-MM-DD-<slug>.sql` stays valid.

**A Unix-epoch prefix does not work here.** `1787000000-foo.sql` sorts *before*
every `2026-…` filename under `localeCompare` (`"1" < "2"`), so it would replay
ahead of the entire history including `0001-baseline.sql`'s successors. Any
scheme has to keep the `YYYY-` prefix to interleave correctly with the 466
files already shipped.
