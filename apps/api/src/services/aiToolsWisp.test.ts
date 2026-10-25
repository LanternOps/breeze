/**
 * Wisp W07 — the two specialist tool handlers (plan Tasks 4 and 6; Review
 * Focus 1 and 2). The coordinator and every read are mocked: these cases pin
 * what each handler hands the coordinator and when it refuses before reaching
 * it. Registration across the six registries lives in
 * aiToolsWisp.registration.test.ts (real registries, no mocks).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  intentRows: [] as unknown[][],
  requestSpecialist: vi.fn(),
  buildApproverAuthContextForIntent: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => h.intentRows.shift() ?? [] }) }),
    }),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('./wisp/coordinator', () => ({ requestSpecialist: h.requestSpecialist }));
vi.mock('./actionIntents/actorContext', () => ({
  buildApproverAuthContextForIntent: h.buildApproverAuthContextForIntent,
}));

import { launchSpecialistHandler, wispSpecialistRequestHandler } from './aiToolsWisp';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const GRANT = '00000000-0000-4000-8000-0000000000a3';
const REV = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a5';
const APPROVER = '00000000-0000-4000-8000-0000000000a7';
const REQ = '00000000-0000-4000-8000-0000000000b1';
const INTENT = '00000000-0000-4000-8000-0000000000c1';

const ARGS = {
  requestId: REQ, kind: 'patch_plan', orgId: ORG, grantId: GRANT, grantRevisionId: REV,
  params: {}, reason: 'Patch compliance dropped at Greenwood',
};

function intentRow(o: Record<string, unknown> = {}) {
  return {
    id: INTENT, orgId: ORG, partnerId: 'p1', actionName: 'wisp_specialist_request', arguments: ARGS,
    status: 'executing', decidedByUserId: APPROVER, requestingAgentRunId: RUN, ...o,
  };
}

const approverAuth = { user: { id: APPROVER }, principal: { kind: 'user_session' } };
const sessionAuth = (o: Record<string, unknown> = {}) =>
  ({ user: { id: 'u-chat' }, principal: { kind: 'user_session' }, wispGrant: { grantId: GRANT, grantRevisionId: REV, sessionId: 's1' }, ...o }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.intentRows = [[intentRow()]];
  h.buildApproverAuthContextForIntent.mockResolvedValue(approverAuth);
  h.requestSpecialist.mockResolvedValue({ admitted: true, runId: 'run-child' });
});

describe('wispSpecialistRequestHandler (the approval carrier release)', () => {
  it('refuses without actionIntentId: it runs only as the release of its own approved intent', async () => {
    const out = JSON.parse(await wispSpecialistRequestHandler(ARGS, {} as never));
    expect(out.error).toMatch(/runs only as the release of its own approved intent/);
    expect(h.requestSpecialist).not.toHaveBeenCalled();
  });

  it.each([
    ['the intent is missing', []],
    ['the intent is still pending', [intentRow({ status: 'pending_approval' })]],
    ['nobody decided it', [intentRow({ decidedByUserId: null })]],
    ['it is another tool\'s intent', [intentRow({ actionName: 'operator_plan' })]],
    ['the arguments name another request', [intentRow({ arguments: { ...ARGS, requestId: '00000000-0000-4000-8000-0000000000ff' } })]],
    ['the arguments name another org than the intent', [intentRow({ orgId: '00000000-0000-4000-8000-0000000000ee' })]],
  ])('refuses when %s', async (_l, rows) => {
    h.intentRows = [rows as unknown[]];
    const out = JSON.parse(await wispSpecialistRequestHandler(ARGS, {} as never, { actionIntentId: INTENT }));
    expect(out.error).toBeTruthy();
    expect(h.requestSpecialist).not.toHaveBeenCalled();
  });

  it('refuses approver_invalid when the approver\'s authority cannot be rebuilt', async () => {
    h.buildApproverAuthContextForIntent.mockResolvedValue(null);
    const out = JSON.parse(await wispSpecialistRequestHandler(ARGS, {} as never, { actionIntentId: INTENT }));
    expect(out).toEqual({ error: 'approver_invalid' });
    expect(h.requestSpecialist).not.toHaveBeenCalled();
  });

  it('calls requestSpecialist with requester approval + the APPROVER\'s rebuilt auth, the intent\'s run as lineage', async () => {
    await wispSpecialistRequestHandler(ARGS, { user: { id: 'agent' } } as never, { actionIntentId: INTENT });
    expect(h.buildApproverAuthContextForIntent).toHaveBeenCalledWith(expect.objectContaining({ id: INTENT }), APPROVER);
    expect(h.requestSpecialist).toHaveBeenCalledWith(
      { grantId: GRANT, grantRevisionId: REV, orgId: ORG, kind: 'patch_plan', params: {}, requestedByRunId: RUN },
      expect.objectContaining({
        requester: { kind: 'approval', intentId: INTENT, auth: approverAuth, pinnedDigest: null },
        requestId: REQ,
      }),
    );
  });

  it('forwards the pinned bulk digest from the approved arguments', async () => {
    const bulk = { ...ARGS, kind: 'bulk_ticket_reply', params: { concernId: null, ticketIds: [REQ], message: 'On it' }, pinnedDigest: 'a'.repeat(64) };
    h.intentRows = [[intentRow({ arguments: bulk })]];
    await wispSpecialistRequestHandler(bulk, {} as never, { actionIntentId: INTENT });
    expect(h.requestSpecialist.mock.calls[0]![1].requester.pinnedDigest).toBe('a'.repeat(64));
  });

  it('reports grant_inactive when the grant was paused after approval (Review Focus 1) — nothing admitted', async () => {
    h.requestSpecialist.mockResolvedValue({ refused: 'grant_inactive' });
    const out = JSON.parse(await wispSpecialistRequestHandler(ARGS, {} as never, { actionIntentId: INTENT }));
    expect(out).toEqual({ error: 'grant_inactive' });
  });

  it('reports the approver\'s missing permission (Review Focus 2)', async () => {
    h.requestSpecialist.mockResolvedValue({ refused: 'workspace_execute_required' });
    const out = JSON.parse(await wispSpecialistRequestHandler({ ...ARGS, kind: 'analysis' }, {} as never, { actionIntentId: INTENT }));
    expect(out.error).toBe('workspace_execute_required');
  });

  it('returns the same admitted result on a redelivered release (same requestId reaches the coordinator)', async () => {
    h.intentRows = [[intentRow()], [intentRow()]];
    const a = await wispSpecialistRequestHandler(ARGS, {} as never, { actionIntentId: INTENT });
    const b = await wispSpecialistRequestHandler(ARGS, {} as never, { actionIntentId: INTENT });
    expect(a).toBe(b);
    expect(h.requestSpecialist.mock.calls.map((c) => c[1].requestId)).toEqual([REQ, REQ]);
  });
});

describe('launchSpecialistHandler (the Tier-2 chat tool)', () => {
  const input = { orgId: ORG, kind: 'sweep', reason: 'Check disks at Greenwood' };

  it('returns {"error":"wisp_grant_required"} and calls nothing when auth.wispGrant is absent', async () => {
    const out = await launchSpecialistHandler(input, { user: { id: 'u' } } as never);
    expect(out).toBe('{"error":"wisp_grant_required"}');
    expect(h.requestSpecialist).not.toHaveBeenCalled();
  });

  it('passes auth.wispGrant\'s grant/revision, requester user + the session auth, requestedByRunId null', async () => {
    const auth = sessionAuth();
    await launchSpecialistHandler({ ...input, params: { sweepKinds: ['disk_pressure'] } }, auth);
    const [first, opts] = h.requestSpecialist.mock.calls[0]!;
    expect(first).toEqual({
      grantId: GRANT, grantRevisionId: REV, orgId: ORG, kind: 'sweep', params: { sweepKinds: ['disk_pressure'] }, requestedByRunId: null,
    });
    expect(opts.requester).toEqual({ kind: 'user', auth });
    expect(opts.reason).toBe('Check disks at Greenwood');
    expect(opts.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a human asking twice means twice: each call gets a fresh request id', async () => {
    await launchSpecialistHandler(input, sessionAuth());
    await launchSpecialistHandler(input, sessionAuth());
    const ids = h.requestSpecialist.mock.calls.map((c) => c[1].requestId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('rejects malformed input without calling the coordinator', async () => {
    const out = JSON.parse(await launchSpecialistHandler({ ...input, kind: 'run_script' } as never, sessionAuth()));
    expect(out.error).toBeTruthy();
    expect(h.requestSpecialist).not.toHaveBeenCalled();
  });

  it('surfaces a refusal as an error and an admission as its result', async () => {
    h.requestSpecialist.mockResolvedValueOnce({ refused: 'budget_exhausted' });
    expect(JSON.parse(await launchSpecialistHandler(input, sessionAuth()))).toEqual({ error: 'budget_exhausted' });
    expect(JSON.parse(await launchSpecialistHandler(input, sessionAuth()))).toEqual({ admitted: true, runId: 'run-child' });
  });
});
