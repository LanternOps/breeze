import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasDirect: vi.fn(), readDirect: vi.fn(), readCp: vi.fn(), delegant: vi.fn(),
  cp: [] as unknown[], dg: [] as unknown[], contexts: [] as string[],
}));
vi.mock('../delegantClient', () => ({ invokeDelegantTool: m.delegant }));
vi.mock('../m365DirectGraph', () => ({ hasDirectM365Connection: m.hasDirect, readMailboxesDirect: m.readDirect, invokeDirect: vi.fn() }));
vi.mock('../m365ControlPlane/readActionService', () => ({ executeM365MailboxReadByOrg: m.readCp, executeM365ReadAction: vi.fn() }));
vi.mock('../../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>, label?: string) => { m.contexts.push(label ?? 'system'); return fn(); },
  db: {
    // .limit() is the control-plane probe; the bare await is the Delegant probe.
    select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(m.dg), { limit: () => Promise.resolve(m.cp) }) }) }),
  },
}));

import { fetchMailboxResourceByOrg } from './mailboxBackends';
import { withMailboxReader } from './mailboxReader';

const target = { entraTenantId: '11111111-1111-4111-8111-111111111111', entraOid: '22222222-2222-4222-8222-222222222222' };
const conn = { id: 'conn', orgId: 'org-A', m365TenantId: target.entraTenantId, status: 'active', delegantOrgId: 'd', customerLabel: 'c' };

beforeEach(() => {
  vi.clearAllMocks();
  m.cp = []; m.dg = []; m.contexts = [];
  m.hasDirect.mockResolvedValue(false);
  m.readDirect.mockResolvedValue({ kind: 'ok', data: { id: target.entraOid } });
  m.readCp.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: target.entraOid } });
  m.delegant.mockResolvedValue({ kind: 'ok', data: { id: target.entraOid } });
});

it.each(['direct', 'controlPlane', 'delegant'] as const)('routes mailbox reads through %s only', async (backend) => {
  m.hasDirect.mockResolvedValue(backend === 'direct');
  if (backend === 'controlPlane') m.cp = [{ id: 'read' }]; else m.dg = [conn];
  await expect(withMailboxReader('tech', () => fetchMailboxResourceByOrg('org-A', target))).resolves.toEqual({ id: target.entraOid });
  expect(m.readDirect).toHaveBeenCalledTimes(backend === 'direct' ? 1 : 0);
  expect(m.readCp).toHaveBeenCalledTimes(backend === 'controlPlane' ? 1 : 0);
  expect(m.delegant).toHaveBeenCalledTimes(backend === 'delegant' ? 1 : 0);
  if (backend === 'direct') expect(m.readDirect).toHaveBeenCalledWith('org-A', { userId: target.entraOid, expectedTenantId: target.entraTenantId });
  if (backend === 'controlPlane') expect(m.readCp).toHaveBeenCalledWith('org-A', target, 'tech');
  if (backend === 'delegant') {
    expect(m.delegant).toHaveBeenCalledWith(expect.objectContaining({
      connection: conn, toolName: 'get_user_mailboxes',
      parameters: { userId: target.entraOid, expectedTenantId: target.entraTenantId },
      actingUser: expect.objectContaining({ breezeUserId: 'tech' }),
    }), expect.anything());
  }
  // Every backend probe is a short system read; none wraps the network call.
  expect(m.contexts.every((label) => label.startsWith('callerVerification.mailboxes.'))).toBe(true);
});

it.each([
  ['direct', () => { m.hasDirect.mockResolvedValue(true); m.readDirect.mockResolvedValue({ kind: 'error', code: 'auth_failed', message: 'x' }); }],
  ['controlPlane', () => { m.cp = [{ id: 'read' }]; m.readCp.mockResolvedValue({ ok: false, code: 'executor_unavailable', message: 'x' }); }],
  ['delegant', () => { m.dg = [conn]; m.delegant.mockResolvedValue({ kind: 'error', code: 'tool_error', message: 'unsupported' }); }],
])('does not fall back after the selected %s backend fails', async (_backend, arrange) => {
  arrange();
  await expect(withMailboxReader('tech', () => fetchMailboxResourceByOrg('org-A', target))).rejects.toThrow();
  expect(m.readDirect.mock.calls.length + m.readCp.mock.calls.length + m.delegant.mock.calls.length).toBe(1);
});

it.each([
  ['no', []],
  ['multiple', [conn, { ...conn, id: 'conn-2' }]],
])('refuses %s matching Delegant connections', async (_label, rows) => {
  m.dg = rows;
  await expect(withMailboxReader('tech', () => fetchMailboxResourceByOrg('org-A', target))).rejects.toThrow('mailbox_connection_ambiguous_or_missing');
  expect(m.delegant).not.toHaveBeenCalled();
});

it('refuses an unattributed call before any backend probe', async () => {
  await expect(fetchMailboxResourceByOrg('org-A', target)).rejects.toThrow('mailbox_reader_missing');
  expect(m.hasDirect).not.toHaveBeenCalled();
  expect(m.contexts).toEqual([]);
});

it('keeps concurrent readers isolated', async () => {
  m.dg = [conn];
  await Promise.all([
    withMailboxReader('tech-1', () => fetchMailboxResourceByOrg('org-A', target)),
    withMailboxReader('tech-2', () => fetchMailboxResourceByOrg('org-A', target)),
  ]);
  expect(new Set(m.delegant.mock.calls.map(([args]) => args.actingUser.breezeUserId))).toEqual(new Set(['tech-1', 'tech-2']));
});
