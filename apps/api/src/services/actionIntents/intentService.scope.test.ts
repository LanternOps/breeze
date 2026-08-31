import { createHash } from 'crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

/**
 * P2-2 (Task A3, #4189) — `CreateActionIntentInput.scope`: the explicit target
 * device a DEVICE-LESS sweep run binds an intent to.
 *
 * Mock scaffolding is the `intentService.tier2Agent.test.ts` shape, with two
 * deliberate departures:
 *  - `../aiGuardrails` is mocked WHOLESALE (both `checkGuardrails` and
 *    `checkAgentGuardrails`, like `intentService.test.ts`): this suite is about
 *    the scope plumbing, not tier classification, and it needs to ASSERT what
 *    device the agent guardrail was handed — the single most load-bearing
 *    effect of a scope, since `checkAgentGuardrails` denies every mutating call
 *    whose `policy.deviceId` is null ("the run is not device-bound") and a
 *    sweep run has none.
 *  - the `devices` table stub carries `org_id`, because the scoped-device read
 *    projects it to pin the device to the intent's org.
 */

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    idempotencyKey: col('idempotency_key'),
    status: col('status'),
    expiresAt: col('expires_at'),
    releaseBy: col('release_by'),
    approvalExpiresAt: col('approval_expires_at'),
  };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), userId: col('user_id') };
  const intentOutboxTbl = { id: col('id'), intentId: col('intent_id') };
  const aiAgentRunsTbl = {
    id: col('id'),
    agentId: col('agent_id'),
    orgId: col('org_id'),
    deviceId: col('device_id'),
    policySnapshot: col('policy_snapshot'),
  };
  const aiAgentsTbl = { id: col('id'), name: col('name') };
  const devicesTbl = { id: col('id'), orgId: col('org_id'), siteId: col('site_id') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, intentOutboxTbl, aiAgentRunsTbl, aiAgentsTbl, devicesTbl },
    dbState: {
      insertActionIntentsResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
      selectDevicesResults: [] as unknown[][],
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: { scope: string; orgId: string | null; accessibleOrgIds: string[] | null; user: { id: string } }) => ({
      scope: auth.scope,
      orgId: auth.orgId,
      accessibleOrgIds: auth.accessibleOrgIds,
      userId: auth.user.id,
    })) },
    guardrailMock: { checkGuardrails: vi.fn(), checkAgentGuardrails: vi.fn() },
    aiToolsState: {
      tools: new Map<string, { definition: { description?: string } }>(),
      resolveWritableToolOrgId: vi.fn(),
    },
    permState: {
      getUserPermissions: vi.fn(),
      userCanDecideApprovals: vi.fn((perms: { canDecide?: boolean } | null) => !!perms?.canDecide),
    },
    pushState: {
      getUserPushTokens: vi.fn(async () => []),
      dispatchApprovalPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
    },
    notifyState: { createNotification: vi.fn(async () => 'notif-1') },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    intentApproversState: {
      resolveIntentApprovers: vi.fn(async () => [] as string[]),
      resolveAgentIntentApprovers: vi.fn(async () => [] as string[]),
      resolveIntentTargetScope: vi.fn(async () => ({ kind: 'indirect' }) as unknown),
    },
    effectDigestState: {
      computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as { kind: string }),
    },
    envMock: { policyDecideEnabled: vi.fn(() => false) },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
  };
});

function resultBox(getResult: () => unknown) {
  return {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(getResult()).then(res, rej),
    catch: (rej: (e: unknown) => unknown) => Promise.resolve(getResult()).catch(rej),
    limit: vi.fn(() => resultBox(getResult)),
  };
}

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (table === schema.actionIntentsTbl) {
          const insertedValues = values as Record<string, unknown>;
          dbState.insertedActionIntentValues.push(insertedValues);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => {
                const queued = dbState.insertActionIntentsResults.shift();
                if (typeof queued === 'function') return queued(insertedValues);
                return queued ?? [];
              }),
            })),
          };
        }
        if (table === schema.approvalRequestsTbl) {
          dbState.insertedApprovalRequestsValues.push(values);
          return { returning: vi.fn(async () => dbState.insertApprovalRequestsResults.shift() ?? []) };
        }
        if (table === schema.intentOutboxTbl) {
          dbState.insertedOutboxValues.push(values as Record<string, unknown>);
          return Promise.resolve(undefined);
        }
        throw new Error('unexpected insert table in mock');
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.actionIntentsTbl) return resultBox(() => dbState.selectActionIntentsResults.shift() ?? []);
          if (table === schema.approvalRequestsTbl) return resultBox(() => dbState.selectApprovalRequestsResults.shift() ?? []);
          if (table === schema.aiAgentRunsTbl) return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
          if (table === schema.aiAgentsTbl) return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
          if (table === schema.devicesTbl) return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: schema.actionIntentsTbl,
  intentOutbox: schema.intentOutboxTbl,
}));
vi.mock('../../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));
vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: authMock.dbAccessContextFromAuth }));
vi.mock('../aiTools', () => ({
  aiTools: aiToolsState.tools,
  resolveWritableToolOrgId: aiToolsState.resolveWritableToolOrgId,
}));
vi.mock('../aiGuardrails', () => ({
  checkGuardrails: guardrailMock.checkGuardrails,
  checkAgentGuardrails: guardrailMock.checkAgentGuardrails,
}));
vi.mock('../../db/schema/aiAgents', () => ({
  aiAgents: schema.aiAgentsTbl,
  aiAgentRuns: schema.aiAgentRunsTbl,
}));
vi.mock('../../db/schema/devices', () => ({ devices: schema.devicesTbl }));
vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  userCanDecideApprovals: permState.userCanDecideApprovals,
}));
vi.mock('../expoPush', () => ({
  getUserPushTokens: pushState.getUserPushTokens,
  dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens,
}));
vi.mock('../userNotifications', () => ({ createNotification: notifyState.createNotification }));
vi.mock('./metrics', () => ({ recordActionIntentEvent: metricsMock.recordActionIntentEvent }));
vi.mock('./effectDigest', () => ({ computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome }));
vi.mock('../../config/env', () => ({ policyDecideEnabled: envMock.policyDecideEnabled }));
vi.mock('./policyDecide', () => ({ attemptPolicyDecision: policyDecideMock.attemptPolicyDecision }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  sql: vi.fn(() => ({ op: 'sql' })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { createActionIntent, type CreateActionIntentInput } from './intentService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const SCOPE_DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_DEVICE_ID = '88888888-8888-4888-8888-888888888888';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVER_1 = '33333333-3333-4333-8333-333333333333';

function makeUserAuth() {
  return {
    principal: { kind: 'user_session' },
    user: { id: REQUESTER_ID, email: 'req@example.com', name: 'Requester' },
    orgId: ORG_ID,
    partnerId: null,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function makeAgentAuth() {
  return {
    principal: { kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID },
    user: { id: AGENT_ID, email: `agent+${AGENT_ID}@breeze.internal`, name: 'Sweep agent' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

/** A SWEEP run: `deviceId` null. This is the whole reason the scope exists. */
function makeSweepRunRow(overrides?: Record<string, unknown>) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    policySnapshot: {
      schemaVersion: 1,
      agentId: AGENT_ID,
      kind: 'patch',
      effective: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_services'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

/** Queues the run -> agent -> (scoped) device system reads the agent branch
 *  performs. A device-less run performs NO run-device read, so the only
 *  `devices` select on the queue is the scoped one. */
function queueSweepContext(opts?: { run?: Record<string, unknown>; scopedDevice?: unknown[] }) {
  const run = makeSweepRunRow(opts?.run);
  dbState.selectAgentRunsResults.push([run]);
  dbState.selectAgentsResults.push([{ id: AGENT_ID, name: 'Sweep agent' }]);
  if (run.deviceId) dbState.selectDevicesResults.push([{ siteId: SITE_ID }]);
  dbState.selectDevicesResults.push(
    opts?.scopedDevice ?? [{ id: SCOPE_DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID }],
  );
  // One fanned-out approval row per intent — createActionIntent CANCELS an
  // intent it cannot fan out to anybody, so an empty approver set would make
  // every assertion below read 'cancelled' rather than the scope behavior.
  dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);
}

function echoInsertedIntent(overrides?: Record<string, unknown>) {
  return (values: Record<string, unknown>) => [
    {
      id: 'intent-echo',
      partnerId: PARTNER_ID,
      requestedByUserId: null,
      status: 'pending_approval',
      createdAt: new Date(),
      result: null,
      errorCode: null,
      ...values,
      ...overrides,
    },
  ];
}

function sweepInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'manage_services',
    input: { action: 'restart', deviceId: SCOPE_DEVICE_ID, serviceName: 'spooler' },
    source: 'ai_agent',
    orgId: ORG_ID,
    scope: { deviceId: SCOPE_DEVICE_ID },
    ...overrides,
  };
}

function resetDbState() {
  for (const key of Object.keys(dbState) as Array<keyof typeof dbState>) {
    (dbState[key] as unknown[]).length = 0;
  }
}

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
  aiToolsState.tools.clear();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  guardrailMock.checkGuardrails.mockReturnValue({
    tier: 3,
    allowed: true,
    requiresApproval: true,
    approvalScope: 'supervised',
    description: 'Restart a service',
  });
  guardrailMock.checkAgentGuardrails.mockReturnValue({
    tier: 3,
    allowed: false,
    requiresApproval: true,
    disposition: 'propose',
    description: 'Restart a service',
  });
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'devices', siteIds: [SITE_ID] });
  permState.getUserPermissions.mockResolvedValue(null);
  pushState.getUserPushTokens.mockResolvedValue([]);
  pushState.dispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
  notifyState.createNotification.mockResolvedValue('notif-1');
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.policyDecideEnabled.mockReturnValue(false);
  policyDecideMock.attemptPolicyDecision.mockResolvedValue(undefined);
});

describe('createActionIntent — explicit device scope (P2-2)', () => {
  it('mints a pending_approval intent with scopeKind=device from a DEVICE-LESS run', async () => {
    queueSweepContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());

    const snapshot = await createActionIntent(makeAgentAuth(), sweepInput());

    expect(snapshot.status).toBe('pending_approval');
    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.scopeKind).toBe('device');
    expect(inserted?.scopeDeviceId).toBe(SCOPE_DEVICE_ID);

    // THE load-bearing effect: the guardrail re-run saw the SCOPE device and
    // its site, not the run's null device. Without this substitution
    // checkAgentGuardrails denies outright ("the run is not device-bound")
    // and a sweep could never propose anything.
    expect(guardrailMock.checkAgentGuardrails).toHaveBeenCalledWith(
      'manage_services',
      expect.anything(),
      expect.objectContaining({ deviceId: SCOPE_DEVICE_ID, deviceSiteId: SITE_ID }),
    );
    // Approver targeting resolves against the scope device too — the humans
    // who can reach IT, not whatever the (device-less) run could reach.
    expect(intentApproversState.resolveIntentTargetScope).toHaveBeenCalledWith(
      'manage_services',
      expect.anything(),
      { deviceId: SCOPE_DEVICE_ID },
      ORG_ID,
    );
  });

  it('never lets the RUN device\'s site stand in for a site-less SCOPED device', async () => {
    // Review fix (round 1). `devices.site_id` is nullable. With the original
    // `loaded.scopedDevice?.siteId ?? loaded.deviceSiteId`, a scoped device
    // with no site fell through `??` to the RUN device's site — handing
    // checkAgentGuardrails `deviceId = <scope device>` paired with
    // `deviceSiteId = <a DIFFERENT device's site>`, which is precisely the
    // pair siteScopeDenial evaluates. All three release-time readers use
    // `device.siteId ?? null` with no run fallback, so that form made
    // creation and release disagree. The default fixture seeds every scoped
    // device with SITE_ID, which is what hid the branch.
    queueSweepContext({
      // A run that DOES have a device, and that device DOES have a site
      // (queueSweepContext seeds it as SITE_ID) — the value that must not leak.
      run: { deviceId: OTHER_DEVICE_ID },
      scopedDevice: [{ id: SCOPE_DEVICE_ID, orgId: ORG_ID, siteId: null }],
    });
    dbState.insertActionIntentsResults.push(echoInsertedIntent());

    await createActionIntent(makeAgentAuth(), sweepInput());

    expect(guardrailMock.checkAgentGuardrails).toHaveBeenCalledWith(
      'manage_services',
      expect.anything(),
      expect.objectContaining({ deviceId: SCOPE_DEVICE_ID, deviceSiteId: null }),
    );
  });

  it('refuses a scope from a non-agent principal (scope_not_allowed)', async () => {
    await expect(
      createActionIntent(makeUserAuth(), {
        toolName: 'manage_services',
        input: { action: 'restart', deviceId: SCOPE_DEVICE_ID },
        source: 'chat',
        orgId: ORG_ID,
        scope: { deviceId: SCOPE_DEVICE_ID },
      }),
    ).rejects.toMatchObject({ code: 'scope_not_allowed' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('refuses a scoped device in another org (scope_device_invalid)', async () => {
    queueSweepContext({ scopedDevice: [{ id: SCOPE_DEVICE_ID, orgId: OTHER_ORG_ID, siteId: SITE_ID }] });

    await expect(createActionIntent(makeAgentAuth(), sweepInput())).rejects.toMatchObject({
      code: 'scope_device_invalid',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('refuses a scoped device that does not exist at all (same error, no oracle)', async () => {
    queueSweepContext({ scopedDevice: [] });

    await expect(createActionIntent(makeAgentAuth(), sweepInput())).rejects.toMatchObject({
      code: 'scope_device_invalid',
    });
  });

  it('refuses arguments that name a different device than the scope (scope_argument_mismatch)', async () => {
    queueSweepContext();

    await expect(
      createActionIntent(
        makeAgentAuth(),
        sweepInput({ input: { action: 'restart', deviceId: OTHER_DEVICE_ID, serviceName: 'spooler' } }),
      ),
    ).rejects.toMatchObject({ code: 'scope_argument_mismatch' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
    // Refused BEFORE the guardrail re-run: a mismatched proposal is never
    // evaluated against a policy narrowed to the (wrong) scope device.
    expect(guardrailMock.checkAgentGuardrails).not.toHaveBeenCalled();
  });

  it('derives DISTINCT idempotency keys per scope device, and leaves the unscoped key unchanged', async () => {
    const args = { action: 'restart', deviceId: SCOPE_DEVICE_ID, serviceName: 'spooler' };
    const otherArgs = { action: 'restart', deviceId: OTHER_DEVICE_ID, serviceName: 'spooler' };

    queueSweepContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-a' }));
    await createActionIntent(makeAgentAuth(), sweepInput({ input: args }));

    queueSweepContext({ scopedDevice: [{ id: OTHER_DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID }] });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-b' }));
    await createActionIntent(
      makeAgentAuth(),
      sweepInput({ input: otherArgs, scope: { deviceId: OTHER_DEVICE_ID } }),
    );

    // A sweep fans one intent out PER DEVICE; identical keys would collapse
    // the whole sweep to a single live intent via the partial unique index.
    const [a, b] = dbState.insertedActionIntentValues;
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);

    // And the unscoped derivation is byte-identical to the pre-P2-2 formula —
    // the 4th part is only appended when a scope exists, so no live intent's
    // key moved when this column shipped.
    queueSweepContext({ run: { deviceId: SCOPE_DEVICE_ID }, scopedDevice: [] });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-c' }));
    await createActionIntent(makeAgentAuth(), sweepInput({ input: args, scope: undefined }));

    const unscoped = dbState.insertedActionIntentValues[2];
    const digest = computeArgumentDigest(canonicalizeArguments(args));
    expect(unscoped?.idempotencyKey).toBe(
      createHash('sha256').update(`${RUN_ID}:manage_services:${digest}`).digest('hex'),
    );
    expect(unscoped?.scopeKind).toBeNull();
    expect(unscoped?.scopeDeviceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Final-review fix (#4189, item 1) — spec §4.2 amendment: a SWEEP-minted
// proposal is a supervised inbox card this wave. It is never policy-decided,
// so a sweep can never auto-execute even on a partner that has policy-decide
// enabled, an act-mode agent, and the operation registered in
// `actAssets.supervisedActionKeys`. Act-mode sweep auto-execution arrives with
// P2-5, behind its own review.
//
// The scope is the discriminator, not the run's profile: `input.scope` is the
// only signal `createActionIntent` has that this intent was minted for a
// device the RUN is not bound to, and it is agent-principal-only, so it
// cannot be forged by a chat/MCP caller into a decidability change.
// ---------------------------------------------------------------------------
describe('createActionIntent — a scoped (sweep) intent is never policy-decided', () => {
  /** Act mode + the operation registered — the full pre-conditions
   *  `resolvePolicyDecisionState` needs to return 'unattempted'. */
  function actModeRun(overrides?: Record<string, unknown>) {
    const base = makeSweepRunRow(overrides);
    return {
      ...base,
      policySnapshot: {
        ...base.policySnapshot,
        effective: {
          ...base.policySnapshot.effective,
          mode: 'act',
          actAssets: { supervisedActionKeys: ['manage_services:restart'] },
        },
      },
    };
  }

  beforeEach(() => {
    envMock.policyDecideEnabled.mockReturnValue(true);
  });

  /** The fire-and-forget trigger resolves a dynamic `import()`; flush the
   *  microtask queue so "was it called" is a real answer either way. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('inserts human_required and never attempts a policy decision', async () => {
    queueSweepContext({ run: actModeRun() });
    dbState.insertActionIntentsResults.push(echoInsertedIntent());

    await createActionIntent(makeAgentAuth(), sweepInput());
    await flush();

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
    // Human fan-out is the point: it ran, so the proposal really is an inbox
    // card and not a silently unrouted row.
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
  });

  it('CONTROL: the same run without a scope still reaches the policy-decide path', async () => {
    // Run-device-bound (a scope is what a device-LESS run needs), everything
    // else identical: same agent, same tool, same act-mode snapshot, same
    // registered action key.
    queueSweepContext({ run: actModeRun({ deviceId: SCOPE_DEVICE_ID }) });
    dbState.insertActionIntentsResults.push(echoInsertedIntent());

    await createActionIntent(
      makeAgentAuth(),
      sweepInput({ scope: undefined }),
    );
    await flush();

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('unattempted');
    expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledTimes(1);
  });
});
