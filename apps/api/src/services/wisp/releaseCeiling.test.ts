import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wisp W04a — the delegation ceiling at DURABLE release of a chat-originated
 * action intent. `enforceWispCeiling` stays REAL here (one implementation with
 * the chat gate); only its two reads are stubbed: the session's pinned grant
 * (`lookupWispGrant`) and the live ceiling (`resolveGrantCeiling`).
 */
const shared = vi.hoisted(() => ({
  resolveGrantCeiling: vi.fn(),
  lookupWispGrant: vi.fn(),
  writeAuditEvent: vi.fn(),
  captureException: vi.fn(),
  wispEnabled: vi.fn(() => true),
  // #11432: the thread row enforceWispCeiling reads for an org-less call's focus.
  threadRows: [] as unknown[],
  // #10428 W06: the standing-instruction release check (its rules: standingInstructionRelease.test.ts).
  standingRelease: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));
vi.mock('./standingInstructionRelease', () => ({
  checkStandingInstructionsForRelease: (...args: unknown[]) => shared.standingRelease(...args),
}));

vi.mock('../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../config/env')>()),
  wispEnabled: shared.wispEnabled,
}));

vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => shared.threadRows);
  return {
  db: { select: vi.fn(() => chain) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('./grantAuthority', async (orig) => ({
  ...(await orig<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: shared.resolveGrantCeiling,
  inSystemContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./chatCeiling', async (orig) => ({
  ...(await orig<typeof import('./chatCeiling')>()),
  lookupWispGrant: shared.lookupWispGrant,
}));
vi.mock('./threads', () => ({ seedContextForSession: vi.fn() }));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: shared.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));
vi.mock('../sentry', () => ({ captureException: shared.captureException }));

import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { GrantInactiveError, type GrantCeiling } from './grantAuthority';
import { WISP_REFUSAL_MESSAGES, WispSessionUnavailableError } from './chatCeiling';
import { checkWispCeilingForRelease } from './releaseCeiling';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const SESSION = '00000000-0000-4000-8000-0000000000e1';
const GRANT = { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' };

const ceiling = (o: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: 'g-1', revisionId: 'r-1', partnerId: 'p-1', grantorUserId: 'u-1', scopeOrgId: ORG_A, partnerWide: false,
  status: 'active', orgIds: new Set([ORG_A]), siteIds: null,
  permissionKeys: new Set(['scripts:execute', 'external_tools:write']),
  toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(), ...o,
});

/** The worker's rebuilt requester auth: pinned to the intent org. */
function releaseAuth(orgIds: string[] = [ORG_A]): AuthContext {
  return {
    user: { id: 'u-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: null,
    partnerId: 'p-1',
    orgId: ORG_A,
    scope: 'partner',
    partnerOrgAccess: 'all',
    principal: { kind: 'user_session' },
    accessibleOrgIds: orgIds,
    ...buildOrgAccessClosures(orgIds),
  } as AuthContext;
}

function intent(o: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    orgId: ORG_A,
    actionName: 'cancel_script_execution',
    arguments: { executionId: 'exec-1' },
    aiOriginSessionId: SESSION,
    toolSourceToolId: null,
    ...o,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.threadRows = [];
  shared.lookupWispGrant.mockResolvedValue(GRANT);
  shared.resolveGrantCeiling.mockResolvedValue(ceiling());
  shared.standingRelease.mockResolvedValue(null);
});

// #11432: a durable release rebuilds the requester's auth, so the thread-focus
// write default is re-derived here, against the INTENT org the approval was
// filed in, never carried over from the chat session.
describe('checkWispCeilingForRelease — the focus write default (#11432)', () => {
  const create = intent({ actionName: 'manage_configuration_policy', arguments: { action: 'create', name: 'Baseline Monitoring' } });
  // A partner-wide grant over both orgs, both in the requester's reach, so only the focus rule decides.
  const writes = () => ceiling({
    permissionKeys: new Set(['devices:write']), orgIds: new Set([ORG_A, ORG_B]), scopeOrgId: null, partnerWide: true,
  });

  it('an org-less write of a thread focused on the intent org releases with that org as its write default', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes());
    shared.threadRows = [{ focusOrgId: ORG_A }];
    const r = await checkWispCeilingForRelease(create, releaseAuth([ORG_A, ORG_B]));
    expect(r.ok && r.auth.aiWriteDefaultOrgId).toBe(ORG_A);
  });

  it('a focus moved to another org during the approval wait gives no default', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes());
    shared.threadRows = [{ focusOrgId: ORG_B }];
    const r = await checkWispCeilingForRelease(create, releaseAuth([ORG_A, ORG_B]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.auth.aiWriteDefaultOrgId).toBeUndefined();
  });
});

// #11433: the release re-checks the intent's STORED arguments, so the action-level
// floor holds across the approval wait: a run releases, an apply never does.
describe('checkWispCeilingForRelease — Fleet Design actions (#11433)', () => {
  const REPORT_RUN = '00000000-0000-4000-8000-0000000000f1';
  beforeEach(() => { shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['*:*']) })); });

  it('a run intent for the intent org releases', async () => {
    const r = await checkWispCeilingForRelease(intent({ actionName: 'manage_fleet_designs', arguments: { action: 'run', orgId: ORG_A } }), releaseAuth());
    expect(r.ok).toBe(true);
  });

  it.each(['apply', 'rollback'])('an %s intent is refused at release with the tool detail, and audited', async (action) => {
    const r = await checkWispCeilingForRelease(
      intent({ actionName: 'manage_fleet_designs', arguments: { action, reportRunId: REPORT_RUN } }),
      releaseAuth(),
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_ceiling_refused', details: { wispRefusal: 'tool' } });
    expect(shared.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'wisp.ceiling_refused' }));
  });
});

describe('checkWispCeilingForRelease', () => {
  it('an intent with no chat-session origin never reads the session or the ceiling', async () => {
    const auth = releaseAuth();
    const r = await checkWispCeilingForRelease(intent({ aiOriginSessionId: null }), auth);
    expect(r).toEqual({ ok: true, auth });
    expect(shared.lookupWispGrant).not.toHaveBeenCalled();
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('a non-Wisp chat session passes unchanged and never resolves a ceiling', async () => {
    shared.lookupWispGrant.mockResolvedValue(null);
    const auth = releaseAuth();
    const r = await checkWispCeilingForRelease(intent(), auth);
    expect(r).toEqual({ ok: true, auth });
    expect(shared.lookupWispGrant).toHaveBeenCalledWith(SESSION);
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(shared.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('resolves the ceiling for the session PINNED pair and returns the ceiling-narrowed auth', async () => {
    const r = await checkWispCeilingForRelease(intent(), releaseAuth([ORG_A, ORG_B]));
    expect(shared.resolveGrantCeiling).toHaveBeenCalledWith('g-1', 'r-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth.accessibleOrgIds).toEqual([ORG_A]);
    expect(r.auth.wispGrant).toEqual({ grantId: 'g-1', grantRevisionId: 'r-1', sessionId: SESSION });
  });

  it('a revoked / paused grant refuses with wisp_grant_inactive and audits wisp.ceiling_refused', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g-1', 'revoked'));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({
      ok: false,
      errorCode: 'wisp_grant_inactive',
      details: { wispRefusal: 'inactive', grantId: 'g-1', aiSessionId: SESSION, reason: WISP_REFUSAL_MESSAGES.inactive },
    });
    expect(shared.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(shared.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_A,
      action: 'wisp.ceiling_refused',
      resourceType: 'action_intent',
      resourceId: 'intent-1',
      result: 'failure',
      details: { toolName: 'cancel_script_execution', code: 'wisp_grant_inactive', detail: 'inactive', grantId: 'g-1', phase: 'release' },
    });
  });

  it('a call outside the narrowed ceiling (permission dropped) refuses with wisp_ceiling_refused', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:read']) }));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_ceiling_refused', details: { wispRefusal: 'permission' } });
    expect(shared.writeAuditEvent.mock.calls[0]![1]).toMatchObject({ action: 'wisp.ceiling_refused', details: { code: 'wisp_outside_ceiling' } });
  });

  it('an intent whose org left the ceiling refuses with wisp_ceiling_refused/org', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ orgIds: new Set([ORG_B]), scopeOrgId: ORG_B }));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_ceiling_refused', details: { wispRefusal: 'org' } });
  });

  it('an external (BYO MCP) tool is checked against external_tools:write in the intent org, ignoring its own arguments', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:read']) }));
    const r = await checkWispCeilingForRelease(
      intent({ actionName: 'ext__acme__do_thing', arguments: { orgId: ORG_B }, toolSourceToolId: 'tool-1' }),
      releaseAuth(),
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_ceiling_refused', details: { wispRefusal: 'permission' } });
  });

  it('a Wisp session that cannot be gated (unpinned / unlinked) fails closed with wisp_gate_unavailable', async () => {
    shared.lookupWispGrant.mockRejectedValue(new WispSessionUnavailableError('grant_unpinned', SESSION));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_gate_unavailable' });
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('a deleted session row fails closed while Wisp is enabled (its grant can no longer be proven absent)', async () => {
    shared.wispEnabled.mockReturnValue(true);
    shared.lookupWispGrant.mockRejectedValue(new WispSessionUnavailableError('session_not_found', SESSION));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_gate_unavailable' });
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('a deleted session row passes unchanged while Wisp is disabled (flag off = no behaviour change)', async () => {
    shared.wispEnabled.mockReturnValue(false);
    shared.lookupWispGrant.mockRejectedValue(new WispSessionUnavailableError('session_not_found', SESSION));
    const auth = releaseAuth();
    await expect(checkWispCeilingForRelease(intent(), auth)).resolves.toEqual({ ok: true, auth });
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('any unexpected error (DB down, corrupt pin) fails closed with wisp_gate_unavailable, audited and reported', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new Error('connection terminated'));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_gate_unavailable' });
    expect(shared.captureException).toHaveBeenCalled();
    expect(shared.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      action: 'wisp.ceiling_refused', details: { code: 'wisp_gate_unavailable', detail: 'unavailable' },
    });

    shared.lookupWispGrant.mockRejectedValue(new Error('lookup failed'));
    await expect(checkWispCeilingForRelease(intent(), releaseAuth())).resolves.toMatchObject({ ok: false, errorCode: 'wisp_gate_unavailable' });
  });
});

describe('checkWispCeilingForRelease — standing instructions (#10428 W06, Review Focus 3)', () => {
  const REFUSAL = {
    errorCode: 'standing_instruction_denied',
    details: {
      instructionId: 'i-1', text: "don't reboot PC-01",
      reason: 'Refused: this now conflicts with a standing instruction. Ask the user to lift it, or act from the device page.',
    },
  };

  it('an instruction confirmed after the card was raised refuses the release, audited', async () => {
    shared.standingRelease.mockResolvedValue(REFUSAL);
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'standing_instruction_denied', details: { ...REFUSAL.details, grantId: 'g-1', aiSessionId: SESSION } });
    expect(shared.standingRelease).toHaveBeenCalledWith(expect.objectContaining({ id: 'intent-1' }), expect.objectContaining({ grantId: 'g-1' }));
    expect(shared.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.standing_instruction_refused', resourceType: 'action_intent', resourceId: 'intent-1', result: 'failure',
    }));
  });

  it('is checked only once the ceiling passed (a ceiling refusal wins, no lookup)', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g-1', 'revoked'));
    await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(shared.standingRelease).not.toHaveBeenCalled();
  });

  it('a non-Wisp intent never runs the check', async () => {
    shared.lookupWispGrant.mockResolvedValue(null);
    await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(shared.standingRelease).not.toHaveBeenCalled();
  });

  it('a check that throws fails closed with wisp_gate_unavailable', async () => {
    shared.standingRelease.mockRejectedValue(new Error('db down'));
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r).toMatchObject({ ok: false, errorCode: 'wisp_gate_unavailable' });
  });

  it('no refusal releases as before', async () => {
    const r = await checkWispCeilingForRelease(intent(), releaseAuth());
    expect(r.ok).toBe(true);
    expect(shared.standingRelease).toHaveBeenCalledTimes(1);
  });
});
