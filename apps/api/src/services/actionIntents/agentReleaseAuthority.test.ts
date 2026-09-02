import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state. The REAL checkAgentGuardrails and the REAL
// buildAgentAuthContext/assertRunOwnership run in this suite — the whole point
// of the stricter-combination veto is the structural gate itself, so stubbing
// it would make every test vacuous. Only the db and the effective-policy
// resolver are mocked.
// ---------------------------------------------------------------------------

const { dbState, policyState } = vi.hoisted(() => ({
  dbState: {
    selectAgentRunsResults: [] as unknown[][],
    selectAgentsResults: [] as unknown[][],
    selectOrgsResults: [] as unknown[][],
    selectDevicesResults: [] as unknown[][],
    // P2-4 (#4191): ticket-scope resolution's own select branch.
    selectTicketsResults: [] as unknown[][],
    // Wave-5A review fix (#3827): `ai_kill_state` table branch for the (real,
    // unmocked) `readAiKillState()` this suite's release lane now calls
    // directly — see the "kill-derived denial" describe block below.
    // Defaults not-killed so every pre-existing test in this file, which
    // never mentions kill state at all, is unaffected.
    killStateRows: [{ killed: false, epoch: 0 }] as unknown[],
    killStateShouldThrow: false,
  },
  policyState: {
    resolveEffectiveAgent: vi.fn(),
  },
}));

vi.mock('../../db', async () => {
  const { aiAgentRuns, aiAgents } = await import('../../db/schema/aiAgents');
  const { organizations } = await import('../../db/schema/orgs');
  const { devices } = await import('../../db/schema/devices');
  const { tickets } = await import('../../db/schema/portal');
  const { aiKillState } = await import('../../db/schema/aiKillState');
  const resultBox = (getResult: () => unknown) => ({
    limit: vi.fn(() => Promise.resolve(getResult())),
  });
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => {
            if (table === aiAgentRuns) return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
            if (table === aiAgents) return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
            if (table === organizations) return resultBox(() => dbState.selectOrgsResults.shift() ?? []);
            if (table === devices) return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
            // P2-4 (#4191): ticket-scope resolution mirror of the device branch.
            if (table === tickets) return resultBox(() => dbState.selectTicketsResults.shift() ?? []);
            if (table === aiKillState) {
              return resultBox(() => {
                if (dbState.killStateShouldThrow) throw new Error('ai_kill_state read failed (test)');
                return dbState.killStateRows;
              });
            }
            throw new Error('unexpected select table in mock');
          }),
        })),
      })),
    },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: policyState.resolveEffectiveAgent,
}));

import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy } from '@breeze/shared';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';
// Real (unmocked) module — checkAgentReleaseAuthority now imports it for
// real (Wave-5A review fix, #3827), driven through the `../../db` mock's
// `ai_kill_state` branch above rather than mocking `../aiKillState` itself.
import { _resetAiKillStateCacheForTest } from '../aiKillState';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const effectivePolicy = (overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy => ({
  enabled: true,
  mode: 'shadow',
  model: null,
  toolAllowlist: ['manage_services:restart'],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  limits: AI_AGENT_LIMIT_DEFAULTS,
  triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true },
  recipients: { userIds: [], roleIds: [] },
  actAssets: { scriptIds: [] },
  instructions: null,
  cooldownSeconds: 0,
  ...overrides,
});

const runRow = (snapshotEffective: AiAgentPolicy = effectivePolicy()) => ({
  id: 'run-1',
  agentId: 'agent-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  policySnapshot: {
    schemaVersion: 1,
    agentId: 'agent-1',
    kind: 'triage',
    effective: snapshotEffective,
    provenance: {},
    resolvedAt: '2026-08-23T00:00:00.000Z',
  },
});

const agentRow = {
  id: 'agent-1', orgId: null, partnerId: 'partner-1', name: 'Alert Triage', kind: 'triage',
};

const resolvedAgent = (eff: AiAgentPolicy = effectivePolicy(), agentId = 'agent-1') => ({
  schemaVersion: 1,
  agentId,
  kind: 'triage',
  effective: eff,
  provenance: {},
  resolvedAt: '2026-08-23T01:00:00.000Z',
});

function intentFixture(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    partnerId: 'partner-1',
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_services',
    arguments: { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler', siteId: 'site-a' },
    riskTier: 3,
    ...overrides,
  } as ActionIntent;
}

function seedHappyRows(overrides: {
  run?: unknown; agent?: unknown; org?: unknown; deviceSiteId?: string | null;
} = {}) {
  dbState.selectAgentRunsResults.push([overrides.run ?? runRow()]);
  dbState.selectAgentsResults.push([overrides.agent ?? agentRow]);
  dbState.selectOrgsResults.push([overrides.org ?? { partnerId: 'partner-1' }]);
  dbState.selectDevicesResults.push([{ siteId: overrides.deviceSiteId === undefined ? 'site-a' : overrides.deviceSiteId }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbState.selectAgentRunsResults.length = 0;
  dbState.selectAgentsResults.length = 0;
  dbState.selectOrgsResults.length = 0;
  dbState.selectDevicesResults.length = 0;
  dbState.selectTicketsResults.length = 0;
  dbState.killStateRows = [{ killed: false, epoch: 0 }];
  dbState.killStateShouldThrow = false;
  // A prior test's kill state must never leak into the next one via
  // `readAiKillState`'s 5s in-process TTL cache — it's a real module-level
  // singleton across every test in this file.
  _resetAiKillStateCacheForTest();
  policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The stricter-combination veto
// ---------------------------------------------------------------------------

describe('checkAgentReleaseAuthority', () => {
  it('passes when both snapshot and current policy yield propose', async () => {
    seedHappyRows();

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toEqual({ ok: true });
    // The current policy is resolved through the reconstructed AGENT auth
    // (structural, never user RBAC) for the run's org + the agent's kind.
    expect(policyState.resolveEffectiveAgent).toHaveBeenCalledTimes(1);
    const [auth, orgId, kind] = policyState.resolveEffectiveAgent.mock.calls[0]!;
    expect(auth.principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
    expect(orgId).toBe('org-1');
    expect(kind).toBe('triage');
  });

  it('vetoes when the CURRENT allowlist dropped the tool (snapshot still allows)', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ toolAllowlist: [] })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes when the agent was disabled after approval', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ enabled: false })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes agent_policy_denied when no effective agent resolves any more', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(null);

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { reason: 'no effective agent' },
    });
  });

  it('vetoes when the kill switch is off', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    seedHappyRows();

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_policy_denied' });
  });

  it('vetoes when current mode is off', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ mode: 'off' })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes agent_identity_changed when the org+kind resolves to a different agent', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy(), 'agent-2'),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_identity_changed' });
  });

  it('re-resolves the device site at release (device moved site => site-scoped input vetoes)', async () => {
    // The proposal cited siteId 'site-a' and was approved while the device
    // lived there; the device has since moved to site-b. BOTH evaluations use
    // the CURRENT site, so even the snapshot policy now denies.
    seedHappyRows({ deviceSiteId: 'site-b' });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'snapshot' },
    });
  });

  it('fails agent_run_invalid when the run is missing', async () => {
    dbState.selectAgentRunsResults.push([]);

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
    expect(policyState.resolveEffectiveAgent).not.toHaveBeenCalled();
  });

  it('fails agent_run_invalid when the run targets another org than the intent', async () => {
    seedHappyRows({ run: { ...runRow(), orgId: 'org-2' } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid when the run agent does not match originPrincipalId', async () => {
    seedHappyRows({ run: { ...runRow(), agentId: 'agent-9' } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid on ownership mismatch (org agent of another org)', async () => {
    seedHappyRows({ agent: { ...agentRow, orgId: 'org-2', partnerId: null } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid for an intent that is not agent-originated', async () => {
    const result = await checkAgentReleaseAuthority(
      intentFixture({ requestingAgentRunId: null } as Partial<ActionIntent>),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('vetoes on a malformed policy snapshot (fail closed, policy: snapshot)', async () => {
    seedHappyRows({
      run: { ...runRow(), policySnapshot: { schemaVersion: 1, effective: null } },
    });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'snapshot' },
    });
  });

  // ---------------------------------------------------------------------
  // Wave-5A review fix (#3827): the DB kill-state gate, read FRESH by this
  // lane rather than inherited from another lane's cache — and non-terminal
  // (a distinct errorCode) when it fires.
  // ---------------------------------------------------------------------

  describe('DB kill-state gate (own fresh read)', () => {
    it('vetoes with kill_switch_engaged, not agent_policy_denied, when ai_kill_state is killed', async () => {
      dbState.killStateRows = [{ killed: true, epoch: 7 }];
      seedHappyRows();

      const result = await checkAgentReleaseAuthority(intentFixture());

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'kill_switch_engaged',
        details: { policy: 'snapshot', epoch: 7 },
      });
    });

    it('refreshes the kill-state cache with its own read: db.select is called for it', async () => {
      // Same evidence shape as actRevalidation.test.ts's identically-named
      // assertion: proves the refresh actually fires (a real `readAiKillState()`
      // call, not a no-op reuse of whatever another lane last cached) rather
      // than asserting on timing, which `readAiKillState`'s 5s TTL cache would
      // make flaky within a single fast-running test.
      const { db: mockedDb } = await import('../../db');
      const selectSpy = mockedDb.select as unknown as { mock: { calls: unknown[] } };
      const callsBefore = selectSpy.mock.calls.length;
      seedHappyRows();

      await checkAgentReleaseAuthority(intentFixture());

      expect(selectSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('a transient read failure on THIS lane fails closed as kill_switch_engaged, not agent_policy_denied', async () => {
      // The exact scenario the review finding was about: a DB read failure
      // must PAUSE (not destroy) an already-approved intent. Critically, this
      // is the release lane's OWN read failing — not a poisoned snapshot
      // inherited from an unrelated lane, which is precisely what the fresh
      // `readAiKillState()` call above prevents.
      dbState.killStateShouldThrow = true;
      seedHappyRows();

      const result = await checkAgentReleaseAuthority(intentFixture());

      expect(result).toMatchObject({ ok: false, errorCode: 'kill_switch_engaged' });
    });

    it('does not mark the ENV-flag kill switch (unrelated to DB kill state) as kill_switch_engaged', async () => {
      vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
      dbState.killStateRows = [{ killed: false, epoch: 0 }];
      seedHappyRows();

      const result = await checkAgentReleaseAuthority(intentFixture());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_policy_denied' });
    });
  });

  // ---------------------------------------------------------------------
  // Wave 5 Part B (#3827): the stricter predicate for a policy-decided
  // intent — `checkAgentGuardrails` returning 'propose' (not 'deny') must
  // NOT be treated as authorization once no human is in the loop.
  // `manage_startup_items:disable` is deliberately used here rather than
  // `manage_services:restart` (this file's default fixture): the latter IS
  // matched by ACT_MANIFEST (actManifest.ts), so under mode 'act' it would
  // yield disposition 'act', not the 'propose' this block exists to probe —
  // POLICY_DECIDABLE_TIER3 and ACT_MANIFEST are disjoint asset classes on
  // purpose (policyDecidable.ts's header).
  // ---------------------------------------------------------------------

  describe('policy-decided stricter predicate (wave 5b, #3827)', () => {
    const POLICY_KEY = 'manage_startup_items:disable';
    const policyArgs = { deviceId: 'dev-1', action: 'disable', itemId: 'startup-1' };

    const actPolicy = (overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy => effectivePolicy({
      mode: 'act',
      toolAllowlist: ['manage_startup_items'],
      actAssets: { scriptIds: [], supervisedActionKeys: [POLICY_KEY] },
      ...overrides,
    });

    function policyIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
      return intentFixture({
        actionName: 'manage_startup_items',
        arguments: policyArgs,
        decidedVia: 'policy',
        policyAuthorizationKey: POLICY_KEY,
        // Matches `dbState.killStateRows`'s default epoch (0, set in
        // `beforeEach`) so every pre-existing test in this block that does
        // NOT specifically exercise the epoch-sanity veto below keeps
        // passing through it unaffected.
        policyKillEpoch: 0,
        ...overrides,
      });
    }

    it('passes when BOTH snapshot and current policy authorize the exact key under mode act', async () => {
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(actPolicy()));

      const result = await checkAgentReleaseAuthority(policyIntent());

      expect(result).toEqual({ ok: true });
    });

    it('a HUMAN-approved intent for the identical call still passes on propose alone (decidedVia !== policy is untouched)', async () => {
      // Same mode/allowlist/actAssets as the passing case above, but WITHOUT
      // supervisedActionKeys covering the key AND WITHOUT decidedVia: 'policy'
      // — proves the new predicate is opt-in per intent, not a global
      // tightening of the guardrail-disposition check.
      seedHappyRows({ run: runRow(actPolicy({ actAssets: { scriptIds: [] } })) });
      policyState.resolveEffectiveAgent.mockResolvedValue(
        resolvedAgent(actPolicy({ actAssets: { scriptIds: [] } })),
      );

      const result = await checkAgentReleaseAuthority(
        intentFixture({ actionName: 'manage_startup_items', arguments: policyArgs }),
      );

      expect(result).toEqual({ ok: true });
    });

    it('vetoes policy_authorization_revoked when the CURRENT policy no longer lists the key (operator revoked it)', async () => {
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(
        resolvedAgent(actPolicy({ actAssets: { scriptIds: [] } })),
      );

      const result = await checkAgentReleaseAuthority(policyIntent());

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'policy_authorization_revoked',
        details: { policy: 'current', key: POLICY_KEY },
      });
    });

    it('vetoes policy_authorization_revoked when the SNAPSHOT never listed the key (defense-in-depth on stored provenance)', async () => {
      seedHappyRows({ run: runRow(actPolicy({ actAssets: { scriptIds: [] } })) });
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(actPolicy()));

      const result = await checkAgentReleaseAuthority(policyIntent());

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'policy_authorization_revoked',
        details: { policy: 'snapshot', key: POLICY_KEY },
      });
    });

    it('vetoes policy_authorization_revoked when the CURRENT mode downgraded to shadow, even though the key is still listed', async () => {
      // A mutating call under shadow ALSO yields disposition 'propose', not
      // 'deny' — this proves the predicate is mode-aware, not merely a key
      // membership check that a downgrade-to-shadow could sail past.
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(
        resolvedAgent(actPolicy({ mode: 'shadow' })),
      );

      const result = await checkAgentReleaseAuthority(policyIntent());

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'policy_authorization_revoked',
        details: { policy: 'current', mode: 'shadow' },
      });
    });

    it('a real kill-switch veto still wins over the stricter predicate (kill_switch_engaged, not policy_authorization_revoked)', async () => {
      dbState.killStateRows = [{ killed: true, epoch: 3 }];
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(actPolicy()));

      const result = await checkAgentReleaseAuthority(policyIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'kill_switch_engaged' });
    });

    // Review fix: kill-epoch sanity. `killState.killed` alone misses a
    // kill-then-clear cycle that happened entirely between authorization and
    // release — the flag is back to false by the time this runs, but the
    // epoch the operator's emergency stop advanced never comes back down to
    // what the intent was authorized under.
    it('vetoes policy_authorization_revoked when the CURRENT kill epoch has advanced past the authorized one, even though killed is false', async () => {
      // Authorized at epoch 4; the current (post kill-then-clear) epoch is 6
      // and NOT killed — proves this is a genuinely separate veto from the
      // kill_switch_engaged path above, not a restatement of it.
      dbState.killStateRows = [{ killed: false, epoch: 6 }];
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(actPolicy()));

      const result = await checkAgentReleaseAuthority(policyIntent({ policyKillEpoch: 4 }));

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'policy_authorization_revoked',
        details: { reason: 'kill epoch advanced since authorization', authorizedEpoch: 4, currentEpoch: 6 },
      });
    });

    it('passes when the current kill epoch matches the epoch the intent was authorized under', async () => {
      dbState.killStateRows = [{ killed: false, epoch: 4 }];
      seedHappyRows({ run: runRow(actPolicy()) });
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(actPolicy()));

      const result = await checkAgentReleaseAuthority(policyIntent({ policyKillEpoch: 4 }));

      expect(result).toEqual({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // P2-2 (Task A3, #4189): explicit device scope
  // -------------------------------------------------------------------------

  /** A SWEEP-minted intent: the run is device-less, the target comes from the
   *  intent's own `scope_device_id`. */
  const scopedIntent = (overrides: Partial<ActionIntent> = {}) =>
    intentFixture({
      arguments: { deviceId: 'dev-scope', action: 'restart', serviceName: 'spooler', siteId: 'site-a' },
      scopeKind: 'device',
      scopeDeviceId: 'dev-scope',
      ...overrides,
    } as Partial<ActionIntent>);

  /** run/agent/org rows for a DEVICE-LESS run, plus one scoped-device row
   *  (which the scope branch projects `org_id` from, unlike the run-device
   *  read that only ever needed `site_id`). */
  function seedScopedRows(device: unknown[] | undefined = [{ orgId: 'org-1', siteId: 'site-a' }]) {
    dbState.selectAgentRunsResults.push([{ ...runRow(), deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectDevicesResults.push(device ?? []);
  }

  describe('device scope (P2-2)', () => {
    it('pins the rebuilt agent context to the SCOPE device, not the run (which has none)', async () => {
      seedScopedRows();

      const result = await checkAgentReleaseAuthority(scopedIntent());

      expect(result).toEqual({ ok: true });
      // Without the scope substitution `checkAgentGuardrails` would deny at
      // its device-less-mutation gate and this would never reach ok:true —
      // and the context resolveEffectiveAgent is authorized against must be
      // narrowed to the scope device, never left org-wide.
      const [auth] = policyState.resolveEffectiveAgent.mock.calls[0]!;
      expect(auth.allowedDeviceIds).toEqual(['dev-scope']);
      expect(auth.allowedSiteIds).toEqual(['site-a']);
    });

    it('fails agent_scope_lost when the scope was tombstoned (device deleted / moveOrg detach)', async () => {
      seedScopedRows();

      const result = await checkAgentReleaseAuthority(scopedIntent({ scopeDeviceId: null } as Partial<ActionIntent>));

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
      // Terminal, and never mislabeled as a broken run.
      expect(policyState.resolveEffectiveAgent).not.toHaveBeenCalled();
    });

    it('fails agent_scope_lost when the scoped device no longer exists', async () => {
      seedScopedRows([]);

      const result = await checkAgentReleaseAuthority(scopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
    });

    it('fails agent_scope_lost when the scoped device now belongs to another org', async () => {
      // Controller ruling: a device org-move that landed through the DB-side
      // cascade (not the HTTP moveOrg route, which detaches the scope) leaves
      // scope_device_id live — release is the backstop.
      seedScopedRows([{ orgId: 'org-2', siteId: 'site-a' }]);

      const result = await checkAgentReleaseAuthority(scopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
      expect(policyState.resolveEffectiveAgent).not.toHaveBeenCalled();
    });

    it('leaves an UNSCOPED intent on the run device (no behavior change)', async () => {
      seedHappyRows();

      const result = await checkAgentReleaseAuthority(intentFixture());

      expect(result).toEqual({ ok: true });
      const [auth] = policyState.resolveEffectiveAgent.mock.calls[0]!;
      expect(auth.allowedDeviceIds).toEqual(['dev-1']);
    });
  });

  // -------------------------------------------------------------------------
  // P2-4 (Task A4/A5, #4191): explicit ticket scope — the mirror of P2-2's
  // device scope above. This is what actually lets checkAgentGuardrails's
  // ticket-scope exemption fire at RELEASE time, not just at creation time
  // (intentService.ts already threaded `scope.ticketId` there).
  // -------------------------------------------------------------------------

  const ticketTriagePolicy = effectivePolicy({ toolAllowlist: ['manage_tickets:draft'] });

  /** A ticket-triage-minted intent: the run is device-less, the target comes
   *  from the intent's own `scope_ticket_id`. */
  const ticketScopedIntent = (overrides: Partial<ActionIntent> = {}) =>
    intentFixture({
      actionName: 'manage_tickets',
      arguments: { action: 'draft', ticketId: 'ticket-scope', kind: 'reply', content: 'proposed reply' },
      scopeKind: 'ticket',
      scopeTicketId: 'ticket-scope',
      ...overrides,
    } as Partial<ActionIntent>);

  function seedTicketScopedRows(ticket: unknown[] = [{ id: 'ticket-scope', orgId: 'org-1', status: 'open', deletedAt: null }]) {
    dbState.selectAgentRunsResults.push([{ ...runRow(ticketTriagePolicy), deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectTicketsResults.push(ticket);
    policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(ticketTriagePolicy));
  }

  describe('ticket scope (P2-4, #4191)', () => {
    it('passes via the ticket-scope exemption even though the run is device-less', async () => {
      seedTicketScopedRows();

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toEqual({ ok: true });
    });

    it('fails agent_scope_lost when the ticket scope was tombstoned (scope_ticket_id NULL)', async () => {
      // No ticket select is even reached — tombstone short-circuits first.
      dbState.selectAgentRunsResults.push([{ ...runRow(ticketTriagePolicy), deviceId: null }]);
      dbState.selectAgentsResults.push([agentRow]);
      dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent({ scopeTicketId: null } as Partial<ActionIntent>));

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
      expect(policyState.resolveEffectiveAgent).not.toHaveBeenCalled();
    });

    it('fails agent_scope_lost when the scoped ticket no longer exists', async () => {
      seedTicketScopedRows([]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
    });

    it('fails agent_scope_lost when the scoped ticket is soft-deleted', async () => {
      seedTicketScopedRows([{ id: 'ticket-scope', orgId: 'org-1', status: 'open', deletedAt: new Date() }]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
    });

    it('fails agent_scope_lost when the scoped ticket moved to another org', async () => {
      seedTicketScopedRows([{ id: 'ticket-scope', orgId: 'org-2', status: 'open', deletedAt: null }]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
    });

    it('fails agent_scope_lost when the scoped ticket is closed', async () => {
      seedTicketScopedRows([{ id: 'ticket-scope', orgId: 'org-1', status: 'closed', deletedAt: null }]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
    });

    it('allows a RESOLVED (not closed) ticket — resolution-note drafts are the motivating case', async () => {
      seedTicketScopedRows([{ id: 'ticket-scope', orgId: 'org-1', status: 'resolved', deletedAt: null }]);

      const result = await checkAgentReleaseAuthority(ticketScopedIntent());

      expect(result).toEqual({ ok: true });
    });

    it('WITHOUT ticket scope, a device-less manage_tickets intent still denies (regression guard on the exemption)', async () => {
      dbState.selectAgentRunsResults.push([{ ...runRow(ticketTriagePolicy), deviceId: null }]);
      dbState.selectAgentsResults.push([agentRow]);
      dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
      policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent(ticketTriagePolicy));

      const result = await checkAgentReleaseAuthority(intentFixture({
        actionName: 'manage_tickets',
        arguments: { action: 'draft', ticketId: 'ticket-scope', kind: 'reply', content: 'x' },
      } as Partial<ActionIntent>));

      expect(result).toMatchObject({ ok: false, errorCode: 'agent_policy_denied' });
    });
  });
});
