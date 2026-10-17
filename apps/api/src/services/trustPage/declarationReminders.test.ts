import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ results: [] as unknown[], select: vi.fn(), update: vi.fn(), ctx: [] as string[] }));
vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'set', 'returning']) c[m] = vi.fn(() => c);
    c.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => {
      const next = dbm.results.shift();
      return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? [])).then(r, j);
    };
    return c;
  };
  dbm.select.mockImplementation(() => chain());
  dbm.update.mockImplementation(() => chain());
  return {
    db: { select: (...a: unknown[]) => dbm.select(...a), update: (...a: unknown[]) => dbm.update(...a) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown, label?: string) => { dbm.ctx.push(label ?? ''); return fn(); },
  };
});
const users = vi.hoisted(() => ({ resolveUsersWithPermissionForOrg: vi.fn() }));
vi.mock('../usersWithPermission', () => users);
const notif = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('../userNotifications', () => notif);
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), service: true }));
vi.mock('../email', () => ({ getEmailService: () => (mail.service ? { sendEmail: mail.sendEmail } : null) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { runDeclarationReminders } from './declarationReminders';
import { captureException } from '../sentry';

const now = new Date('2026-10-17T12:00:00.000Z');
const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: 'o1', controlId: 'incident_response_plan', expiresAt: new Date(now.getTime() + 29 * 86_400_000),
  orgName: 'Acme Dental', partnerName: 'Northwind IT', ...over,
});

beforeEach(() => {
  dbm.results = []; dbm.ctx = []; dbm.select.mockClear(); dbm.update.mockClear();
  users.resolveUsersWithPermissionForOrg.mockReset().mockResolvedValue(['u1', 'u2']);
  notif.createNotification.mockReset().mockResolvedValue('n1');
  mail.sendEmail.mockReset().mockResolvedValue(undefined); mail.service = true;
  vi.mocked(captureException).mockClear();
  process.env.DASHBOARD_URL = 'https://app.example.com/';
});

describe('runDeclarationReminders', () => {
  it('claims the row, notifies and emails every orgs:write user, and counts one reminder', async () => {
    // candidates, claim RETURNING, recipient emails
    dbm.results.push([candidate()], [{ id: 'd1' }], [{ id: 'u1', email: 'a@example.com' }, { id: 'u2', email: 'b@example.com' }]);
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 1 });
    expect(users.resolveUsersWithPermissionForOrg).toHaveBeenCalledWith('o1', expect.objectContaining({ action: 'write' }));
    expect(notif.createNotification).toHaveBeenCalledTimes(2);
    expect(notif.createNotification).toHaveBeenCalledWith({
      userId: 'u1', orgId: 'o1', type: 'system', title: 'A declared control expires soon',
      message: 'Incident response plan on Acme Dental’s trust page expires on November 15, 2026. Re-declare it and republish.',
      link: '/organizations/o1#trust', priority: 'normal', dedupeKey: 'trust-declaration-reminder:d1',
    });
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'staff.trust_declaration_reminder', to: 'a@example.com',
      subject: 'Declared control "Incident response plan" expires on November 15, 2026',
    }));
    expect(mail.sendEmail.mock.calls[0]![0].html).toContain('https://app.example.com/organizations/o1#trust');
    // Every DB step runs in a labeled system context (forced RLS would otherwise match zero rows).
    expect(dbm.ctx.length).toBeGreaterThanOrEqual(2);
    expect(dbm.ctx.every((l) => l.startsWith('trustPage.declarationReminders'))).toBe(true);
  });

  it('a row another sweep already claimed is skipped: no notification, no email, 0 reminded', async () => {
    dbm.results.push([candidate()], []);
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 0 });
    expect(notif.createNotification).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('an email failure does not throw, the notification is still created, and the other recipient still gets mail', async () => {
    dbm.results.push([candidate()], [{ id: 'd1' }], [{ id: 'u1', email: 'a@example.com' }, { id: 'u2', email: 'b@example.com' }]);
    mail.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 1 });
    expect(notif.createNotification).toHaveBeenCalledTimes(2);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalled();
  });

  it('no email service configured: notifications only', async () => {
    mail.service = false;
    dbm.results.push([candidate()], [{ id: 'd1' }], [{ id: 'u1', email: 'a@example.com' }]);
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 1 });
    expect(notif.createNotification).toHaveBeenCalled();
  });

  it('one failing row does not stop the next', async () => {
    users.resolveUsersWithPermissionForOrg.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['u3']);
    dbm.results.push(
      [candidate(), candidate({ id: 'd2', orgId: 'o2', controlId: 'cyber_insurance' })],
      [{ id: 'd1' }],
      [{ id: 'd2' }], [{ id: 'u3', email: 'c@example.com' }],
    );
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 1 });
    expect(notif.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u3', dedupeKey: 'trust-declaration-reminder:d2' }));
    expect(captureException).toHaveBeenCalled();
  });

  it('a control id no longer in the declared catalog is skipped without claiming it', async () => {
    dbm.results.push([candidate({ controlId: 'retired_control' })]);
    expect(await runDeclarationReminders(now)).toEqual({ reminded: 0 });
    expect(dbm.update).not.toHaveBeenCalled();
  });
});
