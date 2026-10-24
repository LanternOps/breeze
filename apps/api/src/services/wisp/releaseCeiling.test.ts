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
}));

vi.mock('../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../config/env')>()),
  wispEnabled: shared.wispEnabled,
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
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
  shared.lookupWispGrant.mockResolvedValue(GRANT);
  shared.resolveGrantCeiling.mockResolvedValue(ceiling());
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
