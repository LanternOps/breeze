/**
 * Wisp W07 — minting the `wisp_specialist_request` approval card (plan Task 4).
 * `createActionIntent` is mocked; the agent AuthContext builder is real, so the
 * principal under test is the production one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[][]>,
  createActionIntent: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const b: Record<string, unknown> = { where: () => b, limit: async () => h.tables[name]?.shift() ?? [] };
        return b;
      },
    }),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../actionIntents/intentService', () => ({ createActionIntent: h.createActionIntent }));

import { bulkReplyDigest } from './specialists/bulkTicketReply';
import { raiseSpecialistIntent, specialistIntentIdempotencyKey, WISP_SPECIALIST_REQUEST_TOOL } from './specialistIntent';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000a5';
const AGENT = '00000000-0000-4000-8000-0000000000a6';
const REQ = '00000000-0000-4000-8000-0000000000b1';
const TICKET = '00000000-0000-4000-8000-0000000000c1';

const base = {
  requestedByRunId: RUN, requestId: REQ, kind: 'patch_plan' as const, orgId: ORG,
  grantId: 'g1', grantRevisionId: 'r1', params: {}, reason: 'Patch compliance dropped at Greenwood',
};

function seed(): void {
  h.tables = {
    ai_agent_runs: [[{ id: RUN, agentId: AGENT, orgId: ORG, sessionId: null }]],
    ai_agents: [[{ id: AGENT, orgId: null, partnerId: PARTNER, name: 'Wisp triage', kind: 'triage' }]],
    organizations: [[{ partnerId: PARTNER }]],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  h.createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
});

describe('raiseSpecialistIntent', () => {
  it('mints under the assessment run\'s agent principal with source ai_agent and the request arguments', async () => {
    await expect(raiseSpecialistIntent(base)).resolves.toEqual({ intentId: 'intent-1' });
    const [auth, input] = h.createActionIntent.mock.calls[0]!;
    expect(auth.principal).toEqual({ kind: 'ai_agent', agentId: AGENT, runId: RUN });
    expect(auth.orgId).toBe(ORG);
    expect(input).toMatchObject({
      toolName: WISP_SPECIALIST_REQUEST_TOOL,
      source: 'ai_agent',
      orgId: ORG,
      reason: base.reason,
      input: { requestId: REQ, kind: 'patch_plan', orgId: ORG, grantId: 'g1', grantRevisionId: 'r1', params: {}, reason: base.reason },
    });
    expect(input.input).not.toHaveProperty('pinnedDigest');
  });

  it('converges on one intent per request id: the idempotency key is derived from it', async () => {
    await raiseSpecialistIntent(base);
    seed();
    await raiseSpecialistIntent(base);
    const keys = h.createActionIntent.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys).toEqual([specialistIntentIdempotencyKey(REQ), specialistIntentIdempotencyKey(REQ)]);
  });

  it('pins the exact ticket set and message of a bulk reply in the card', async () => {
    const params = { concernId: null, ticketIds: [TICKET], message: 'We are looking into the outage.' };
    await raiseSpecialistIntent({ ...base, kind: 'bulk_ticket_reply', params });
    expect(h.createActionIntent.mock.calls[0]![1].input.pinnedDigest).toBe(bulkReplyDigest(params));
  });

  it('refuses when the requesting run does not resolve in the org (never mints under another run)', async () => {
    h.tables.ai_agent_runs = [[]];
    await expect(raiseSpecialistIntent(base)).rejects.toThrow(/no longer resolves/);
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });
});
