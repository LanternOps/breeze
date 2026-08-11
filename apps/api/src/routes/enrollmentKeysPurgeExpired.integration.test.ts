/**
 * Real-Postgres coverage for the #2832 live-bootstrap-token exemption on
 * `POST /enrollment-keys/purge-expired` — the on-demand, tenant-scoped
 * counterpart to the nightly sweep, and the route behind the web UI's
 * "Delete expired" button (`EnrollmentKeyManager.tsx`, `delete-expired-keys`).
 *
 * #2775 added the exemption to the sweep (`jobs/enrollmentKeyCleanup.ts`).
 * This route never got it, and it is the WORSE of the two paths:
 *   - the sweep only touches keys that expired 7+ days ago; this route has NO
 *     grace period, so a key is eligible the moment it expires,
 *   - the Add Device modal mints its parent key with the default 60-minute
 *     TTL, while the bootstrap token minted from it carries its own
 *     independent TTL of up to 365 days,
 *   - `installer_bootstrap_tokens.parent_enrollment_key_id` is ON DELETE
 *     CASCADE.
 * So one click, 60 minutes after an admin generated a 30-day installer link,
 * destroyed that link. Redemption then hit the `no_row` branch in
 * `routes/installer.ts` and the installer 404'd.
 *
 * Why this suite and not just the unit tests: `enrollmentKeys_get_rotate_delete.test.ts`
 * mocks `../db` wholesale, so its `where()` mock returns whatever the test
 * tells it to regardless of the predicate — it can assert the exemption's SQL
 * SHAPE but can never prove Postgres EVALUATES the correlated NOT EXISTS
 * per row. It also cannot see the CASCADE at all. This suite drives the REAL
 * route (real JWT, real `authMiddleware`, real `breeze_app` RLS context)
 * against the test database.
 *
 * Cases mirror (a)-(d) of `jobs/enrollmentKeyCleanup.integration.test.ts`:
 *   (a) live, unexhausted token            -> key SURVIVES the purge
 *   (b) token itself expired                -> key is DELETED
 *   (c) token fully consumed (>= max_usage) -> key is DELETED
 *   (d) no bootstrap tokens at all          -> key is DELETED (regression
 *       guard on the pre-existing behaviour)
 * plus two properties that are specific to the ROUTE rather than the sweep:
 *   (e) NO grace period — a key that expired seconds ago with no live token is
 *       purged immediately. This is the deliberate difference from the sweep's
 *       7 days, and pinning it is what stops someone "fixing" #2832 by
 *       smuggling a grace period in here instead of the exemption.
 *   (f) tenant scope — another org's expired key is untouched by an
 *       org-scoped caller.
 *
 * Co-located with the route per the repo's test-placement convention, so it
 * must be hand-listed in BOTH `vitest.integration.config.ts` (`include`) and
 * `vitest.config.ts` (`exclude`). Miss either edit and it silently never runs
 * in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import { setupTestEnvironment, type TestEnvironment } from '../__tests__/integration/db-utils';
import { enrollmentKeyRoutes } from './enrollmentKeys';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * The purge route is `requireMfa()`-gated and `setupTestEnvironment` mints its
 * token with `mfa: false`, so re-mint the same identity with `mfa: true`.
 * Every other claim is copied from the seeded row's defaults (aep/mep = 1;
 * `sid` must be non-empty or authMiddleware rejects the access token).
 */
async function mfaSatisfiedToken(env: TestEnvironment): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/enrollment-keys', enrollmentKeyRoutes);
  return app;
}

async function purgeExpired(app: Hono, token: string): Promise<Response> {
  return app.request('/enrollment-keys/purge-expired', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * An expired parent enrollment key, optionally with one bootstrap token
 * hanging off it. `expiredMinutesAgo` defaults to 60 — the shape the Add
 * Device modal actually produces (DEFAULT_ENROLLMENT_KEY_TTL_MINUTES), not a
 * contrived long-dead row.
 *
 * The token always takes the parent's `orgId`, exactly as
 * `installerBootstrapTokenIssuance.ts` does. That is load-bearing for the RLS
 * reasoning in the shared guard's docblock: the exemption subquery runs inside
 * the caller's org-scoped context, so a token stamped with a DIFFERENT org
 * would be invisible to it and the guard would silently fail open.
 */
async function seedKey(opts: {
  orgId: string;
  siteId: string;
  unique: string;
  expiredMinutesAgo?: number;
  token?: {
    expiresAt: Date;
    createdAt?: Date;
    maxUsage: number;
    consumedCount: number;
    /**
     * Optional here, unlike the expired-filter suite: this delete path counts
     * tokens of EVERY `usage_kind` (#3034), so a case that does not name one is
     * still meaningful — it lands on the column DEFAULT `legacy_unknown`, which
     * the purge guard must treat as live exactly like any other kind. Case (g)
     * names `per_download` explicitly to pin the realistic short-link shape.
     */
    usageKind?: 'capacity' | 'per_download';
  };
}): Promise<{ keyId: string; tokenId: string | null }> {
  const expiredMinutesAgo = opts.expiredMinutesAgo ?? 60;
  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: opts.orgId,
        siteId: opts.siteId,
        name: `transient parent ${opts.unique}`,
        key: `purge-key-${opts.unique}`,
        expiresAt: new Date(Date.now() - expiredMinutesAgo * 60 * 1000),
        maxUsage: 1,
      })
      .returning({ id: enrollmentKeys.id });
    if (!opts.token) return { keyId: key!.id, tokenId: null };
    const [token] = await db
      .insert(installerBootstrapTokens)
      .values({
        token: `purge-token-${opts.unique}`,
        orgId: opts.orgId,
        parentEnrollmentKeyId: key!.id,
        siteId: opts.siteId,
        maxUsage: opts.token.maxUsage,
        consumedCount: opts.token.consumedCount,
        ...(opts.token.usageKind ? { usageKind: opts.token.usageKind } : {}),
        ...(opts.token.createdAt ? { createdAt: opts.token.createdAt } : {}),
        expiresAt: opts.token.expiresAt,
      })
      .returning({ id: installerBootstrapTokens.id });
    return { keyId: key!.id, tokenId: token!.id };
  });
}

async function keyRowExists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, id));
    return !!row;
  });
}

async function tokenRowExists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: installerBootstrapTokens.id })
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.id, id));
    return !!row;
  });
}

/** One day out — a modest stand-in for the 30-day/1-year links #2832 is about. */
const TOKEN_LIVE_UNTIL = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('POST /enrollment-keys/purge-expired — live bootstrap token exemption (#2832, real Postgres)', () => {
  runDb('(a) an expired key holding a live, unexhausted bootstrap token SURVIVES the purge — and so does its token', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    const { keyId, tokenId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
      token: { expiresAt: TOKEN_LIVE_UNTIL(), maxUsage: 25, consumedCount: 0 },
    });
    // A same-org key that MUST die in the same request. Without it, the
    // survive-assertion below would also pass if the DELETE matched nothing at
    // all (wrong RLS context, swallowed predicate error).
    const { keyId: canaryId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique: `${unique}-canary`,
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; deletedCount: number };
    expect(body.success).toBe(true);
    // Org-scoped purge, so the count IS deterministic here (unlike the
    // system-wide sweep): exactly the canary.
    expect(body.deletedCount).toBe(1);

    expect(await keyRowExists(canaryId)).toBe(false); // the purge really ran
    expect(await keyRowExists(keyId)).toBe(true);
    expect(await tokenRowExists(tokenId!)).toBe(true);
  });

  runDb('(b) an expired key whose token has itself expired is DELETED — liveness is a strict now() boundary', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    const { keyId, tokenId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
      token: {
        // expires_at must be strictly after created_at (DB CHECK
        // installer_bootstrap_tokens_expires_after_created) — backdate both.
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
        expiresAt: new Date(Date.now() - 10 * 60 * 1000),
        maxUsage: 25,
        consumedCount: 0,
      },
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    expect(await keyRowExists(keyId)).toBe(false);
    // The CASCADE is real: the dead token goes with its parent. This is what
    // makes case (a)'s token assertion a meaningful one rather than vacuous.
    expect(await tokenRowExists(tokenId!)).toBe(false);
  });

  runDb('(c) an expired key whose token is fully consumed (consumed_count >= max_usage) is DELETED', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    const { keyId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
      // Still unexpired, but spent — the arm that would survive if the guard
      // only checked expiry.
      token: { expiresAt: TOKEN_LIVE_UNTIL(), maxUsage: 5, consumedCount: 5 },
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    expect(await keyRowExists(keyId)).toBe(false);
  });

  runDb('(d) an expired key with no bootstrap tokens at all is DELETED — pre-existing behaviour is unchanged', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    const { keyId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    expect((await res.json()).deletedCount).toBe(1);
    expect(await keyRowExists(keyId)).toBe(false);
  });

  runDb('(e) has NO grace period — a key that expired seconds ago is purged immediately (deliberately unlike the nightly sweep)', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    // Well inside the sweep's 7-day window — the sweep would retain this row.
    // This route is on-demand admin hygiene and is supposed to take it.
    const { keyId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
      expiredMinutesAgo: 1,
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    expect(await keyRowExists(keyId)).toBe(false);
  });

  // #3034 — the safety invariant the capacity/all-kind guard split turns on.
  //
  // The LIST filter deliberately ignores per_download tokens: they are clicks,
  // not device slots, so a key backed only by them badges off its parent expiry
  // and "Hide expired" hides it. This DELETE path must NOT copy that narrowing.
  // A per_download token is a working installer somebody actually downloaded,
  // and `parent_enrollment_key_id` is ON DELETE CASCADE, so purging its parent
  // destroys it irreversibly.
  //
  // Case (a) above happens to cover the same wiring via the column DEFAULT
  // (`legacy_unknown`), but only by accident of the default. This names the
  // realistic short-link shape outright, so narrowing the delete guard to
  // capacity-only — the single most damaging way to get #3034 wrong — fails
  // HERE rather than silently shipping.
  runDb('(g) an expired key whose only live token is per_download SURVIVES the purge (#3034)', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(env);

    const { keyId, tokenId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique,
      // Exactly what serveInstaller mints on a public download: one slot, unused.
      token: {
        expiresAt: TOKEN_LIVE_UNTIL(),
        maxUsage: 1,
        consumedCount: 0,
        usageKind: 'per_download',
      },
    });
    // Same canary rationale as case (a): without a row that MUST die, the
    // survive-assertion passes just as well when the DELETE matched nothing.
    const { keyId: canaryId } = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique: `${unique}-canary`,
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; deletedCount: number };
    expect(body.deletedCount).toBe(1);

    expect(await keyRowExists(canaryId)).toBe(false); // the purge really ran
    expect(await keyRowExists(keyId)).toBe(true);
    expect(await tokenRowExists(tokenId!)).toBe(true);
  });

  runDb('(f) stays inside the caller\'s tenant — another org\'s expired key is untouched', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const callerEnv = await setupTestEnvironment({ scope: 'organization' });
    const otherEnv = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaSatisfiedToken(callerEnv);

    const { keyId: ownKeyId } = await seedKey({
      orgId: callerEnv.organization.id,
      siteId: callerEnv.site.id,
      unique: `${unique}-own`,
    });
    const { keyId: foreignKeyId } = await seedKey({
      orgId: otherEnv.organization.id,
      siteId: otherEnv.site.id,
      unique: `${unique}-foreign`,
    });

    const res = await purgeExpired(makeApp(), token);

    expect(res.status).toBe(200);
    expect((await res.json()).deletedCount).toBe(1);
    expect(await keyRowExists(ownKeyId)).toBe(false);
    expect(await keyRowExists(foreignKeyId)).toBe(true);
  });
});
