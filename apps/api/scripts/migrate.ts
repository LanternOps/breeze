// Dedicated entrypoint for `pnpm db:migrate` (#3065).
//
// autoMigrate.ts is a library module imported by the API boot path
// (databaseStartup), so it must not self-execute — and an "am I the main
// module?" guard comparing import.meta.url against process.argv[1] fails
// open on paths needing URL percent-encoding (spaces, non-ASCII), symlinked
// checkouts, and Windows, silently reproducing the #3065 exit-0 no-op. A
// dedicated entry file that calls autoMigrate() unconditionally has no such
// failure mode (same structure as scripts/check-drift.ts for db:check-drift).
//
// process.exit is required: autoMigrate's auto-seed step opens the shared
// pool from src/db/index, which would otherwise hold the event loop open
// forever after a successful run.
import { autoMigrate } from '../src/db/autoMigrate';

autoMigrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[auto-migrate] Migration failed:', err);
    process.exit(1);
  });
