import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ negotiate: vi.fn(), ingest: vi.fn(), parse: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: (run: () => unknown) => run() }, assertInTransaction: vi.fn() }));
vi.mock('./collectionAuthority', () => ({ negotiateTopologyContext: mocks.negotiate }));
vi.mock('./collectionIngest', () => ({ ingestTopologyNetworkContext: mocks.ingest }));
vi.mock('@breeze/shared', () => ({ parseNetworkContextReport: mocks.parse }));

import { topologyHeartbeat, topologyHeartbeatWithoutMaterialization } from './heartbeat';

const device = { id: 'd', orgId: 'o', siteId: 's' };
const config = { producerEpoch: 'epoch', configurationRevision: '1', sourceIdentity: 'o:s:agent:d' };

describe('topologyHeartbeat receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.negotiate.mockResolvedValue(config);
    mocks.parse.mockReturnValue({ accepted: true, report: { sequence: '7' } });
  });

  // The agent only discards a rejected capture when the rejection names it.
  it.each([
    ['an ingest rejection', () => mocks.ingest.mockResolvedValue({ producerEpoch: 'epoch', accepted: false, reason: 'snapshot_conflict', sourceReceipts: [] })],
    ['an expected ingest error', () => mocks.ingest.mockRejectedValue(new Error('content_digest_mismatch'))],
  ])('names the rejected capture for %s', async (_name, arrange) => {
    arrange();
    const { receipt } = await topologyHeartbeat(device, { networkContextV1: { sequence: '7' } });
    expect(receipt).toMatchObject({ accepted: false, producerEpoch: 'epoch', reportSequence: '7' });
  });

  it('names an unparseable capture by its claimed sequence', async () => {
    mocks.parse.mockReturnValue({ accepted: false, reason: 'invalid_report' });
    const { receipt } = await topologyHeartbeat(device, { networkContextV1: { sequence: '18446744073709551615', junk: true } });
    expect(receipt).toMatchObject({ accepted: false, reason: 'invalid_report', producerEpoch: 'epoch', reportSequence: '18446744073709551615' });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it.each([[{ sequence: 7 }], [{ sequence: '1'.repeat(21) }], [{ sequence: '-1' }], ['nope']])('does not echo a malformed sequence %j', async (payload) => {
    mocks.parse.mockReturnValue({ accepted: false, reason: 'invalid_report' });
    const { receipt } = await topologyHeartbeat(device, { networkContextV1: payload });
    expect(receipt).toMatchObject({ accepted: false, reason: 'invalid_report' });
    expect(receipt).not.toHaveProperty('reportSequence');
  });

  it('keeps an accepted receipt intact', async () => {
    mocks.ingest.mockResolvedValue({ producerEpoch: 'epoch', accepted: true, acceptedSequence: '7', sourceReceipts: [] });
    const { receipt } = await topologyHeartbeat(device, { networkContextV1: { sequence: '7' } });
    expect(receipt).toMatchObject({ accepted: true, acceptedSequence: '7', reportSequence: '7' });
  });
});

// #8053 W1a-1 — with materialization off, negotiateTopologyContext returns
// exactly `{ acceptedNetworkContextVersions: [] }` (collectionAuthority.ts
// `if (!flags.materialization) return …`). The skip path must hand the agent
// the same config and the same receipt for every input, without the DB.
describe('topologyHeartbeatWithoutMaterialization parity', () => {
  const liveRow = { isEphemeral: false, agentTokenSuspendedAt: null, agentTokenHash: 'a'.repeat(64) };
  const disabledConfig = { acceptedNetworkContextVersions: [] as number[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.negotiate.mockResolvedValue(disabledConfig);
  });

  it.each([
    ['no report', {}, null],
    ['an unparseable report with a sequence', { networkContextV1: { sequence: '42', junk: true } }, { accepted: false, reason: 'invalid_report' }],
    ['an unsupported version', { networkContextV1: { version: 2 } }, { accepted: false, reason: 'unsupported_major_version' }],
    ['a parseable report', { networkContextV1: { sequence: '9' } }, { accepted: true, report: { sequence: '9' } }],
    ['a malformed sequence', { networkContextV1: { sequence: -1 } }, { accepted: false, reason: 'invalid_report' }],
  ] as const)('matches the negotiated path for %s', async (_name, input, parsed) => {
    if (parsed) mocks.parse.mockReturnValue(parsed);
    const negotiated = await topologyHeartbeat(device, input);
    const skipped = topologyHeartbeatWithoutMaterialization(liveRow, input);
    expect(skipped).toEqual(negotiated);
    expect(JSON.stringify(skipped.config)).toBe('{"acceptedNetworkContextVersions":[]}');
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it.each([
    ['ephemeral (Quick Support)', { ...liveRow, isEphemeral: true }],
    ['token suspended', { ...liveRow, agentTokenSuspendedAt: new Date() }],
    ['no agent token', { ...liveRow, agentTokenHash: null }],
  ])('throws producer_unavailable for a %s device, as negotiation does', (_name, row) => {
    expect(() => topologyHeartbeatWithoutMaterialization(row, {})).toThrow('producer_unavailable');
  });

  it("the negotiated path no longer opens its own savepoint (the caller's isolates it)", async () => {
    const transaction = vi.fn((run: () => unknown) => run());
    const { db } = await import('../../db');
    (db as unknown as { transaction: unknown }).transaction = transaction;
    await topologyHeartbeat(device, {});
    expect(transaction).not.toHaveBeenCalled();
  });
});
