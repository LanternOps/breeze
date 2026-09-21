import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ negotiate: vi.fn(), ingest: vi.fn(), parse: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: (run: () => unknown) => run() }, assertInTransaction: vi.fn() }));
vi.mock('./collectionAuthority', () => ({ negotiateTopologyContext: mocks.negotiate }));
vi.mock('./collectionIngest', () => ({ ingestTopologyNetworkContext: mocks.ingest }));
vi.mock('@breeze/shared', () => ({ parseNetworkContextReport: mocks.parse }));

import { topologyHeartbeat } from './heartbeat';

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
