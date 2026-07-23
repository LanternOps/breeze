/**
 * Real-Postgres integration coverage for the platform-admin bootstrap (#2655).
 *
 * Why this file exists: `platformAdminBootstrap.test.ts` mocks `../db`, so it
 * executes NO SQL — the promotion query is never sent to a database. That is
 * exactly why the original defect survived to a live stock-image boot: the
 * `where` clause interpolated a JS `string[]` into a raw `sql` template as
 * `= ANY(${emails}::text[])`, and in the production CJS bundle that array param
 * reached Postgres as a bare string (not a `{...}` array literal), so the
 * `::text[]` cast failed at runtime with `malformed array literal`. A mocked
 * `db.execute` can never see a malformed-SQL failure.
 *
 * NOTE on scope: the *bundle-only* serialization difference does not reproduce
 * under vitest/tsx (the ESM/dev path serializes a JS array correctly), so this
 * suite would pass against the OLD `= ANY(::text[])` code too. Its value is not
 * reproducing that specific bundler quirk — it is being the FIRST test that
 * actually runs the promotion SQL against real Postgres under the same
 * system-scoped RLS context production uses, proving the rewritten `inArray`
 * form (`lower(email) in ($1, $2, …)`, one bound param per email, no array
 * literal to serialize) is valid SQL and is correctly SCOPED: it promotes only
 * the listed, not-already-admin users and leaves everyone else alone. The
 * mocked unit suite asserts none of that.
 *
 * Run (Docker required — no Docker in the default agent sandbox; this runs in CI):
 *   docker compose -f docker-compose.test.yml up -d
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/services/platformAdminBootstrap.integration.test.ts
 */
import '../__tests__/integration/setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { bootstrapPlatformAdmins } from './platformAdminBootstrap';
import { users } from '../db/schema';
import { createPartner, createUser } from '../__tests__/integration/db-utils';
import { getTestDb } from '../__tests__/integration/setup';

const ORIGINAL_ENV = process.env.BREEZE_PLATFORM_ADMINS;

function setAdmins(value: string): void {
  process.env.BREEZE_PLATFORM_ADMINS = value;
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await getTestDb()
    .select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row.isPlatformAdmin;
}

describe('bootstrapPlatformAdmins — real Postgres (#2655)', () => {
  beforeEach(() => {
    delete process.env.BREEZE_PLATFORM_ADMINS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BREEZE_PLATFORM_ADMINS;
    } else {
      process.env.BREEZE_PLATFORM_ADMINS = ORIGINAL_ENV;
    }
  });

  it('promotes a SINGLE configured email against real Postgres (the exact single-element case that failed in the prod bundle)', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `solo-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email });

    expect(await isPlatformAdmin(user.id)).toBe(false);

    setAdmins(email);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(user.id)).toBe(true);
  });

  it('promotes MULTIPLE comma-separated emails and matches case-insensitively', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    // Seed with mixed-case stored addresses to exercise the lower(email) match.
    const a = await createUser({ partnerId: partner.id, email: `Alice-${suffix}@Example.com` });
    const b = await createUser({ partnerId: partner.id, email: `bob-${suffix}@example.com` });

    setAdmins(`alice-${suffix}@example.com, BOB-${suffix}@EXAMPLE.com`);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(a.id)).toBe(true);
    expect(await isPlatformAdmin(b.id)).toBe(true);
  });

  it('promotes ONLY the listed users — an unlisted user stays non-admin (WHERE actually filters)', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    const listed = await createUser({ partnerId: partner.id, email: `listed-${suffix}@example.com` });
    const other = await createUser({ partnerId: partner.id, email: `other-${suffix}@example.com` });

    setAdmins(`listed-${suffix}@example.com`);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(listed.id)).toBe(true);
    expect(await isPlatformAdmin(other.id)).toBe(false);
  });

  it('is idempotent: a second run leaves an already-promoted user promoted', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `idem-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email });

    setAdmins(email);
    await bootstrapPlatformAdmins();
    expect(await isPlatformAdmin(user.id)).toBe(true);

    // Second run: the `isPlatformAdmin = false` guard means this user is no
    // longer matched, but the call must not throw and must not demote.
    await bootstrapPlatformAdmins();
    expect(await isPlatformAdmin(user.id)).toBe(true);
  });
});
