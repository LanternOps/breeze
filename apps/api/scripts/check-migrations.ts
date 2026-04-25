// CI-only entrypoint that applies every migration against an empty Postgres
// and exits non-zero on the first failure. Catches ordering bugs and SQL
// errors that the static autoMigrate.test.ts cannot see (issue #506).
import { autoMigrate } from '../src/db/autoMigrate';

autoMigrate()
  .then(() => {
    console.log('[check-migrations] OK — all migrations applied');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[check-migrations] FAILED');
    console.error(err);
    process.exit(1);
  });
