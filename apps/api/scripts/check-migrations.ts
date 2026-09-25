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
    // This script is only meaningful against an EMPTY database (CI). If any
    // fixture table was never seeded — the hook stopped firing, a trigger was
    // renamed, or the DB was already migrated — the multi-tenant coverage this
    // job exists for did not happen, so fail rather than report OK.
    const unseeded = fixture?.unseededTemplateTables() ?? ['<afterMigration hook never ran>'];
    if (unseeded.length > 0) {
      console.error(
        `[check-migrations] FAILED — multi-tenant fixture never seeded: ${unseeded.join(', ')}. ` +
          'Run against an empty database; see scripts/migrationReplayTenantFixture.ts (#5361).',
      );
      process.exit(1);
    }
    console.log('[check-migrations] OK — all migrations applied');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[check-migrations] FAILED');
    console.error(err);
    process.exit(1);
  });
