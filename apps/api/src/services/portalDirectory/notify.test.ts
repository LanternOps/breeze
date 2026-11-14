import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  names: [] as unknown[],
  admins: [] as Array<{ id: string; email: string; name: string }>,
  send: vi.fn(),
  email: true,
}));

vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve(h.names);
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
  };
});
vi.mock('../email', () => ({
  getEmailService: vi.fn(() => (h.email ? { sendPortalDirectoryHeld: h.send } : null)),
}));
vi.mock('../partnerAdminRecipients', () => ({ listActivePartnerAdmins: vi.fn(async () => h.admins) }));
vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { captureException } from '../sentry';
import { listActivePartnerAdmins } from '../partnerAdminRecipients';
import { notifyDirectoryRunHeld } from './notify';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const RUN = '9f8e7d6c-5b4a-4398-8776-655443322110';
const PARTNER = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
const held = { orgId: ORG, runId: RUN, source: 'entra' as const, affected: 3 };

describe('notifyDirectoryRunHeld (D12, OD7)', () => {
  let savedDash: string | undefined;
  let savedPublic: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedDash = process.env.DASHBOARD_URL;
    savedPublic = process.env.PUBLIC_APP_URL;
    process.env.DASHBOARD_URL = 'https://app.example.com/';
    delete process.env.PUBLIC_APP_URL;
    h.names = [{ orgName: 'Contoso', partnerName: 'Acme MSP', partnerId: PARTNER }];
    h.admins = [{ id: 'u1', email: 'admin1@msp.test', name: 'A' }, { id: 'u2', email: 'admin2@msp.test', name: 'B' }];
    h.email = true;
    h.send.mockReset();
    h.send.mockResolvedValue(undefined);
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (savedDash === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = savedDash;
    if (savedPublic === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = savedPublic;
    warn.mockRestore();
    error.mockRestore();
  });

  it('emails the partner\'s active admins once with the org, directory, count and the org\'s Portal tab link', async () => {
    await notifyDirectoryRunHeld(held);
    expect(listActivePartnerAdmins).toHaveBeenCalledWith(PARTNER);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      to: ['admin1@msp.test', 'admin2@msp.test'],
      partnerName: 'Acme MSP',
      orgName: 'Contoso',
      source: 'entra',
      affected: 3,
      portalTabUrl: `https://app.example.com/settings/organizations/${ORG}#portal`,
    });
  });

  it('with no absolute dashboard URL the email goes out without a link', async () => {
    process.env.DASHBOARD_URL = 'not-a-url';
    await notifyDirectoryRunHeld(held);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ portalTabUrl: null });
  });

  it('no email service, no org or no admins: no send, no throw', async () => {
    h.email = false;
    await notifyDirectoryRunHeld(held);
    h.email = true;
    h.names = [];
    await notifyDirectoryRunHeld(held);
    h.names = [{ orgName: 'Contoso', partnerName: 'Acme MSP', partnerId: PARTNER }];
    h.admins = [];
    await notifyDirectoryRunHeld(held);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('never throws: a send failure is logged and reported', async () => {
    h.send.mockRejectedValueOnce(new Error('smtp down'));
    await expect(notifyDirectoryRunHeld(held)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('logs ids and counts only: no address, org or partner name', async () => {
    h.admins = [];
    await notifyDirectoryRunHeld(held);
    h.send.mockRejectedValueOnce(new Error('smtp down for admin1@msp.test'));
    h.admins = [{ id: 'u1', email: 'admin1@msp.test', name: 'A' }];
    await notifyDirectoryRunHeld(held);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toMatch(/@|Contoso|Acme/);
  });
});
