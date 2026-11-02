import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ update: vi.fn(), wake: vi.fn(), audit: vi.fn() }));
vi.mock('../../db', () => ({
  db: { update: h.update },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}),
  writeAuditEventAsync: h.audit,
}));
vi.mock('./queue', () => ({ wakeMapping: h.wake }));
vi.mock('./storage', () => ({ ticketingDb: (fn: () => unknown) => fn() }));
import { pauseTicketingConnection, resumeTicketingConnection } from './pause';
beforeEach(() => {
  vi.clearAllMocks();
  h.wake.mockResolvedValue(undefined);
  h.audit.mockResolvedValue(undefined);
});
function update(rows: unknown[]) {
  const chain = { set: vi.fn(), where: vi.fn(), returning: vi.fn(async () => rows) };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  h.update.mockReturnValueOnce(chain);
}
describe('pause and resume', () => {
  it('audits only actual pause transitions', async () => {
    update([{ id: 'connection', partnerId: 'partner' }]);
    await pauseTicketingConnection('connection');
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'psa.alert_ticketing.pause',
        partnerId: 'partner',
        orgId: null,
      })
    );
    update([]);
    await pauseTicketingConnection('connection');
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
  it('successful connection test resumes and wakes durable paused rows after committing', async () => {
    update([{ id: 'connection', partnerId: 'partner' }]);
    update([{ id: 'mapping' }]);
    await resumeTicketingConnection('connection');
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'psa.alert_ticketing.resume', details: { reason: 'successful_connection_test' } })
    );
    expect(h.wake).toHaveBeenCalledWith('mapping', 'close');
  });
});

it('logs mapping wake failure after resume while retaining a successful resume', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  update([{ id: 'connection', partnerId: 'partner' }]); update([{ id: 'mapping' }]);
  h.wake.mockRejectedValueOnce(new Error('redis disconnected'));
  await expect(resumeTicketingConnection('connection')).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ connectionId: 'connection', mappingId: 'mapping', message: 'redis disconnected' }));
  warn.mockRestore();
});
