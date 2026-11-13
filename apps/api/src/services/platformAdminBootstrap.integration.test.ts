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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { bootstrapPlatformAdmins } from './platformAdminBootstrap';
import { auditLogs, users } from '../db/schema';
import { createOrganization, createPartner, createUser } from '../__tests__/integration/db-utils';
import { getTestDb } from '../__tests__/integration/setup';

const ORIGINAL_ENV = process.env.BREEZE_PLATFORM_ADMINS;

function setAdmins(value: string): void {
  process.env.BREEZE_PLATFORM_ADMINS = value;
}

type CreateUserInput = Parameters<typeof createUser>[0];

/** An account whose address has been proven by a mailed link. */
async function createVerifiedUser(options: CreateUserInput) {
  const user = await createUser(options);
  await getTestDb().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  return user;
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
    const user = await createVerifiedUser({ partnerId: partner.id, status: 'active', email });

    expect(await isPlatformAdmin(user.id)).toBe(false);

    setAdmins(email);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(user.id)).toBe(true);
  });

  it('promotes MULTIPLE comma-separated emails and matches case-insensitively', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    // Seed with mixed-case stored addresses to exercise the lower(email) match.
    const a = await createVerifiedUser({ partnerId: partner.id, email: `Alice-${suffix}@Example.com` });
    const b = await createVerifiedUser({ partnerId: partner.id, email: `bob-${suffix}@example.com` });

    setAdmins(`alice-${suffix}@example.com, BOB-${suffix}@EXAMPLE.com`);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(a.id)).toBe(true);
    expect(await isPlatformAdmin(b.id)).toBe(true);
  });

  it('promotes ONLY the listed users — an unlisted user stays non-admin (WHERE actually filters)', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    const listed = await createVerifiedUser({ partnerId: partner.id, email: `listed-${suffix}@example.com` });
    const other = await createVerifiedUser({ partnerId: partner.id, email: `other-${suffix}@example.com` });

    setAdmins(`listed-${suffix}@example.com`);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(listed.id)).toBe(true);
    expect(await isPlatformAdmin(other.id)).toBe(false);
  });

  it('is idempotent: a second run leaves an already-promoted user promoted', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `idem-${Date.now()}@example.com`;
    const user = await createVerifiedUser({ partnerId: partner.id, email });

    setAdmins(email);
    await bootstrapPlatformAdmins();
    expect(await isPlatformAdmin(user.id)).toBe(true);

    // Second run: the `isPlatformAdmin = false` guard means this user is no
    // longer matched, but the call must not throw and must not demote.
    await bootstrapPlatformAdmins();
    expect(await isPlatformAdmin(user.id)).toBe(true);
  });

  it('writes one audit row per promotion, and none for a user already promoted', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `audited-${Date.now()}@example.com`;
    const user = await createVerifiedUser({ partnerId: partner.id, email });

    setAdmins(email);
    await bootstrapPlatformAdmins();
    await bootstrapPlatformAdmins();

    const rows = await getTestDb()
      .select({
        actorType: auditLogs.actorType,
        orgId: auditLogs.orgId,
        result: auditLogs.result,
        resourceType: auditLogs.resourceType,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'platform_admin.bootstrap_promote'), eq(auditLogs.resourceId, user.id)));
    expect(rows).toEqual([
      { actorType: 'system', orgId: null, result: 'success', resourceType: 'user' },
    ]);
  });

  it('warns about each listed address that has no account', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    await createVerifiedUser({ partnerId: partner.id, email: `present-${suffix}@example.com` });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setAdmins(`present-${suffix}@example.com, absent-${suffix}@example.com`);
      await bootstrapPlatformAdmins();

      const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(warned).toContain(`absent-${suffix}@example.com`);
      expect(warned).not.toContain(`present-${suffix}@example.com`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not promote a listed account whose address has not been verified', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `unverified-${Date.now()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email });

    setAdmins(email);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(user.id)).toBe(false);
  });

  it('does not promote a listed account that is invited or disabled, even when verified', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    const invited = await createVerifiedUser({ partnerId: partner.id, status: 'invited', email: `invited-${suffix}@example.com` });
    const disabled = await createVerifiedUser({ partnerId: partner.id, status: 'disabled', email: `disabled-${suffix}@example.com` });

    setAdmins(`invited-${suffix}@example.com,disabled-${suffix}@example.com`);
    await bootstrapPlatformAdmins();

    expect(await isPlatformAdmin(invited.id)).toBe(false);
    expect(await isPlatformAdmin(disabled.id)).toBe(false);
  });

  it('warns about each listed address whose account is not eligible yet', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    await createUser({ partnerId: partner.id, status: 'active', email: `pending-${suffix}@example.com` });
    await createVerifiedUser({ partnerId: partner.id, status: 'active', email: `ready-${suffix}@example.com` });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setAdmins(`pending-${suffix}@example.com, ready-${suffix}@example.com`);
      await bootstrapPlatformAdmins();

      const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(warned).toContain(`pending-${suffix}@example.com`);
      expect(warned).not.toContain(`ready-${suffix}@example.com`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not promote a listed account that belongs to an organization', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id });
    const email = `org-member-${Date.now()}@example.com`;
    const user = await createVerifiedUser({ partnerId: partner.id, orgId: org.id, status: 'active', email });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setAdmins(email);
      await bootstrapPlatformAdmins();

      expect(await isPlatformAdmin(user.id)).toBe(false);
      const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(warned).toContain(email);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('promotes no account when more than one account matches a listed address, and names them', async () => {
    const partner = await createPartner({ status: 'active' });
    const suffix = Date.now();
    const first = await createVerifiedUser({ partnerId: partner.id, status: 'active', email: `Twin-${suffix}@Example.com` });
    const second = await createVerifiedUser({ partnerId: partner.id, status: 'active', email: `twin-${suffix}@example.com` });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setAdmins(`twin-${suffix}@example.com`);
      await bootstrapPlatformAdmins();

      expect(await isPlatformAdmin(first.id)).toBe(false);
      expect(await isPlatformAdmin(second.id)).toBe(false);
      const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(warned).toContain(first.id);
      expect(warned).toContain(second.id);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still reports platform admins when the list is empty', async () => {
    const partner = await createPartner({ status: 'active' });
    const user = await createVerifiedUser({ partnerId: partner.id, status: 'active', email: `kept-${Date.now()}@example.com` });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setAdmins('   ');
      await bootstrapPlatformAdmins();

      const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(warned).toContain(user.id);
      expect(await isPlatformAdmin(user.id)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
