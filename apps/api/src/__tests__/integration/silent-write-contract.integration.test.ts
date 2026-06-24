/**
 * Silent-write contract: login persists last_login_at under real breeze_app RLS
 *
 * Context (#1375/#1379 A3):
 *   The /auth/login route writes `users.last_login_at` via `withSystemDbAccessContext`.
 *   Prior to #1375 it used the bare `db` pool (connects as `breeze_app`), which meant
 *   the UPDATE matched 0 rows silently under RLS — the column stayed NULL platform-wide.
 *
 *   The RLS-coverage structural test cannot catch this class of bug (it only checks that
 *   policies exist, not that a specific write actually moves the row). This functional
 *   contract test fills that gap: it drives the real login route end-to-end against the
 *   real `breeze_app` pool and asserts the row moved.
 *
 * Run:
 *   cd apps/api
 *   export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test"
 *   export DATABASE_URL_APP="postgresql://breeze_app:breeze_test@localhost:5433/breeze_test"
 *   export REDIS_URL="redis://localhost:6380"
 *   export NODE_ENV=test
 *   pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/silent-write-contract.integration.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../../routes/auth';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { users } from '../../db/schema';
import { eq } from 'drizzle-orm';

// Import setup to initialize database connection and register beforeAll/beforeEach hooks
import './setup';

describe('silent-write contract: login persists last_login_at under real breeze_app RLS (#1375/#1379 A3)', () => {
  let app: Hono;
  let testPartnerId: string;

  beforeEach(async () => {
    // Mount a fresh Hono app per test — cleanupDatabase() truncates partners
    // in the setup.ts beforeEach, so recreate one here.
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  it('POST /auth/login updates users.last_login_at under real breeze_app RLS', async () => {
    // Seed a user with a known password and a membership (login requires one).
    const user = await createUser({
      partnerId: testPartnerId,
      email: 'lastlogin-contract@example.com',
      password: 'MyPassword123!',
      withMembership: true
    });

    // Verify the seeded row starts with a NULL last_login_at.
    expect(user.lastLoginAt).toBeNull();

    // Drive the real login route. The handler internally wraps its UPDATE in
    // withSystemDbAccessContext, which is exactly the fix from #1375. If that
    // wrapper were ever removed or broken, the UPDATE would match 0 rows under
    // breeze_app RLS — and the assertion below would catch it.
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'lastlogin-contract@example.com',
        password: 'MyPassword123!'
      })
    });

    expect(res.status).toBe(200);

    // Read the row back via the test-superuser connection (not breeze_app) so
    // the SELECT itself is not gated by RLS — we are asserting the WRITE.
    const db = getTestDb();
    const [updatedUser] = await db
      .select({ lastLoginAt: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    expect(updatedUser).toBeDefined();
    if (!updatedUser) throw new Error('Expected user row to exist after login');

    // THE CONTRACT: last_login_at must not be null after a successful login.
    // A future regression that silently 0-row-UPDATEs under breeze_app RLS
    // will fail here rather than being invisible.
    expect(updatedUser.lastLoginAt).not.toBeNull();
  });
});
