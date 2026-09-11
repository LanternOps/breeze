import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, applyMock, contextLabels } = vi.hoisted(() => ({
  rows: [] as unknown[], applyMock: vi.fn(), contextLabels: [] as Array<string | undefined>,
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown, label?: string) => { contextLabels.push(label); return fn(); },
  };
});
vi.mock('./serviceDeliverableService', () => ({ applyTicketStatusChange: applyMock }));
import { handleDeliverableTicketStatusChanged } from './deliverableStatusSubscriber';

const evt = (payload: unknown, orgId: string | null = 'org1') => ({ id: 'e1', type: 'ticket.status_changed', orgId,
  source: 't', priority: 'normal', payload, metadata: { timestamp: '' } } as never);

describe('deliverable-status subscriber (spec §6)', () => {
  beforeEach(() => { rows.length = 0; contextLabels.length = 0; vi.clearAllMocks(); });

  it('drops a malformed event without touching the service', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleDeliverableTicketStatusChanged(evt({ to: 'resolved' }));
      await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', to: 'resolved' }, null));
      expect(applyMock).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(2);
    } finally { err.mockRestore(); }
  });

  it('ignores a ticket no occurrence is linked to', async () => {
    rows.push([]);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'open', to: 'resolved' }));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('passes the resolution note and the status-change actor through on resolve, under a labelled system context', async () => {
    rows.push([{ id: 'o1' }], [{ resolutionNote: 'Reviewed, no findings' }], [{ userId: 'u7' }]);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'open', to: 'resolved' }));
    expect(applyMock).toHaveBeenCalledWith({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'Reviewed, no findings' });
    expect(contextLabels).toEqual(['deliverableStatusSubscriber']);
  });

  it('forwards a reopen with a null note', async () => {
    rows.push([{ id: 'o1' }], [{ resolutionNote: null }], []);
    await handleDeliverableTicketStatusChanged(evt({ ticketId: 't1', from: 'resolved', to: 'open' }));
    expect(applyMock).toHaveBeenCalledWith({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: null, resolutionNote: null });
  });
});
