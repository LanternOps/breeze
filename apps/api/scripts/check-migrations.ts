// CI-only entrypoint that applies every migration against an empty Postgres
// and exits non-zero on the first failure. Catches ordering bugs and SQL
// errors that the static autoMigrate.test.ts cannot see (issue #506).
//
// Between migrations it seeds 2 partners x 2 orgs into every table carrying a
// partner-export material trigger, so a later migration's set-based DML runs
// against multi-tenant rows and the lock-hierarchy guards can fire — an empty
// replay never exercises them (#5361, the v0.111.0 US outage).
import { autoMigrate } from '../src/db/autoMigrate';
import { migrationReplayTenantFixtureFor } from './migrationReplayTenantFixture';

let fixture: ReturnType<typeof migrationReplayTenantFixtureFor> | undefined;

autoMigrate({
  afterMigration: async (client, filename) => {
    fixture ??= migrationReplayTenantFixtureFor(client);
    await fixture.afterMigration(filename);
  },
})
  .then(() => {
    const seeded = fixture?.seededTables() ?? [];
    if (seeded.length === 0) {
      // Every migration was already applied (non-empty DB), so the fixture
      // never ran. CI always starts empty; say so rather than imply coverage.
      console.log('[check-migrations] note: multi-tenant fixture not seeded (no pending migrations)');
    }
    console.log('[check-migrations] OK — all migrations applied');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[check-migrations] FAILED');
    console.error(err);
    process.exit(1);
  });
