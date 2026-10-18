import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestIncidentRow } from './digestStore';

const store = vi.hoisted(() => ({
  expireStaleClaims: vi.fn(),
  deleteOldDeliveries: vi.fn(),
  loadCandidatePartners: vi.fn(),
  loadPartnerIncidents: vi.fn(),
  loadActiveUsers: vi.fn(),
  loadOptedOut: vi.fn(),
  loadLedgerForDate: vi.fn(),
  loadRecentSent: vi.fn(),
  insertSkippedEmpty: vi.fn(),
  claimDelivery: vi.fn(),
  markDeliverySent: vi.fn(),
  markDeliveryFailed: vi.fn(),
}));
const resolvePartnerUsers = vi.hoisted(() => vi.fn());
const resolveOrgUsers = vi.hoisted(() => vi.fn());
const loadCustomerAdmins = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const emailService = vi.hoisted(() => ({ current: { sendEmail } as { sendEmail: typeof sendEmail } | null }));

vi.mock('./digestStore', () => ({ ...store, ERROR_MAX: 500 }));
vi.mock('../usersWithPermission', () => ({
  resolvePartnerUsersWithPermission: (...a: unknown[]) => resolvePartnerUsers(...a),
  resolveUsersWithPermissionForOrg: (...a: unknown[]) => resolveOrgUsers(...a),
}));
vi.mock('./customerDelivery', () => ({
  loadCustomerAdminsNotified: (...a: unknown[]) => loadCustomerAdmins(...a),
}));
vi.mock('../email', () => ({ getEmailService: () => emailService.current }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('../sentry', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));
vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

import { runDigest } from './digest';
import { verifyUnsubscribeToken } from '../emailUnsubscribeToken';

const P = 'partner-1';
// Friday 2026-10-16 08:09 UTC.
const NOW = new Date('2026-10-16T08:09:00Z');
const ADMIN = '11111111-1111-4111-8111-111111111111';
const SELECTED = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const READONLY = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const ORG = 'org-a';

const row = (over: Partial<DigestIncidentRow> = {}): DigestIncidentRow => ({
  id: 'inc-p',
  partnerId: P,
  orgId: null,
  orgName: null,
  ownerUserId: null,
  displayName: 'Huntress',
  condition: 'sync_failed',
  severity: 'transient',
  detail: 'Sync failed: upstream 502',
  fixHref: '/integrations#huntress',
  ownerFixHref: null,
  viewPermission: 'organizations:read',
  repairPermission: 'organizations:write',
  openedAt: new Date('2026-10-15T10:00:00Z'),
  resolvedAt: null,
  resolution: null,
  ...over,
});

/** Permission table: (permission text, orgId|'') → holders. */
let holders: Record<string, string[]>;
function setHolders(h: Record<string, string[]>) {
  holders = h;
  resolvePartnerUsers.mockImplementation(async (_p: string, perm: { resource: string; action: string }, opts: { orgId?: string }) =>
    holders[`${perm.resource}:${perm.action}|${opts.orgId ?? ''}`] ?? []);
}

const emails: Record<string, string> = {
  [ADMIN]: 'admin@example.test',
  [SELECTED]: 'selected@example.test',
  [OWNER]: 'owner@example.test',
  [READONLY]: 'readonly@example.test',
  [CUSTOMER]: 'customer@example.test',
};
/** Org-scope (customer) users: users.org_id is set. */
const orgOf: Record<string, string> = { [CUSTOMER]: ORG };
/** Org-resolver table (W5 widened audience): (permission text|orgId) → holders, org members included. */
let orgHolders: Record<string, string[]> = {};

let claimSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_ENCRYPTION_KEY', 'digest-test-secret-0123456789');
  vi.stubEnv('DASHBOARD_URL', 'https://app.example.test');
  vi.stubEnv('PUBLIC_API_URL', '');
  emailService.current = { sendEmail };
  claimSeq = 0;
  store.expireStaleClaims.mockResolvedValue(0);
  store.deleteOldDeliveries.mockResolvedValue(0);
  store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'UTC' }]);
  store.loadPartnerIncidents.mockResolvedValue([row()]);
  store.loadActiveUsers.mockImplementation(async (ids: string[]) => ids.filter((id) => emails[id]).map((id) => ({ id, email: emails[id]!, partnerId: P, orgId: orgOf[id] ?? null, partnerName: 'Acme MSP' })));
  orgHolders = {};
  resolveOrgUsers.mockImplementation(async (orgId: string, perm: { resource: string; action: string }) =>
    orgHolders[`${perm.resource}:${perm.action}|${orgId}`] ?? []);
  loadCustomerAdmins.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, false])));
  store.loadOptedOut.mockResolvedValue(new Set());
  store.loadLedgerForDate.mockResolvedValue(new Set());
  store.loadRecentSent.mockResolvedValue(new Map());
  store.insertSkippedEmpty.mockResolvedValue(true);
  store.claimDelivery.mockImplementation(async () => `claim-${++claimSeq}`);
  store.markDeliverySent.mockResolvedValue(undefined);
  store.markDeliveryFailed.mockResolvedValue(undefined);
  sendEmail.mockResolvedValue(undefined);
  setHolders({
    'organizations:write|': [ADMIN],
    'organizations:read|': [ADMIN],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const sentTo = () => sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);

describe('runDigest', () => {
  it('sends one digest with the RFC 8058 headers on the platform lane', async () => {
    const r = await runDigest(NOW);
    expect(r.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as { to: string; purpose: string; headers: Record<string, string>; html: string; partnerId?: string };
    expect(msg.to).toBe('admin@example.test');
    expect(msg.purpose).toBe('staff.connection_health_digest');
    expect(msg.partnerId).toBeUndefined();
    const lu = msg.headers['List-Unsubscribe']!;
    expect(lu).toMatch(/^<https:\/\/app\.example\.test\/api\/v1\/email\/unsubscribe\?t=[^>]+>$/);
    const token = decodeURIComponent(new URL(lu.slice(1, -1)).searchParams.get('t')!);
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: ADMIN, topic: 'connection_health_digest' });
    expect(msg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.html).toContain('Sync failed: upstream 502');
    // Claimed for the partner-local date, then marked sent.
    expect(store.claimDelivery).toHaveBeenCalledWith(ADMIN, '2026-10-16', ['inc-p'], expect.any(Date));
    expect(store.markDeliverySent).toHaveBeenCalledWith('claim-1', expect.any(Date));
  });

  it('is a no-op outside the 08:00–11:59 local window', async () => {
    store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'America/New_York' }]); // 04:09 local
    const r = await runDigest(NOW);
    expect(r.partners).toBe(0);
    expect(store.loadPartnerIncidents).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('drops a recipient who holds the repair permission but lost the view permission', async () => {
    setHolders({
      'organizations:write|': [ADMIN, READONLY],
      'organizations:read|': [ADMIN],
    });
    await runDigest(NOW);
    expect(sentTo()).toEqual(['admin@example.test']);
  });

  it('a selected-access partner user only receives incidents of orgs they cover', async () => {
    store.loadPartnerIncidents.mockResolvedValue([
      row({ id: 'inc-a', orgId: 'org-a', orgName: 'Covered Co', displayName: 'DNS' }),
      row({ id: 'inc-b', orgId: 'org-b', orgName: 'Other Co', displayName: 'M365' }),
    ]);
    setHolders({
      'organizations:write|org-a': [ADMIN, SELECTED],
      'organizations:read|org-a': [ADMIN, SELECTED],
      'organizations:write|org-b': [ADMIN],
      'organizations:read|org-b': [ADMIN],
    });
    await runDigest(NOW);
    const bySel = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === 'selected@example.test')![0] as { html: string };
    expect(bySel.html).toContain('Covered Co');
    expect(bySel.html).not.toContain('Other Co');
    expect(store.claimDelivery).toHaveBeenCalledWith(SELECTED, '2026-10-16', ['inc-a'], expect.any(Date));
  });

  it('partner-wide incidents use the no-org resolution (orgAccess = all only)', async () => {
    await runDigest(NOW);
    expect(resolvePartnerUsers).toHaveBeenCalledWith(P, { resource: 'organizations', action: 'write' }, {});
    expect(resolvePartnerUsers).toHaveBeenCalledWith(P, { resource: 'organizations', action: 'read' }, {});
  });

  it('memoizes permission lookups per (permission, org) within a run', async () => {
    store.loadPartnerIncidents.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    await runDigest(NOW);
    expect(resolvePartnerUsers).toHaveBeenCalledTimes(2);
  });

  it('the owner receives their grant incident with the owner link, without the view permission', async () => {
    store.loadPartnerIncidents.mockResolvedValue([row({
      id: 'inc-g',
      ownerUserId: OWNER,
      displayName: 'Example Agent (OAuth app)',
      condition: 'grant_revoked_reuse',
      fixHref: '/settings/connected-apps',
      ownerFixHref: '/account/connected-apps',
      viewPermission: 'connected_apps:read',
      repairPermission: 'connected_apps:manage',
    })]);
    setHolders({ 'connected_apps:manage|': [ADMIN], 'connected_apps:read|': [ADMIN] });
    await runDigest(NOW);
    const owner = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === 'owner@example.test')![0] as { html: string };
    expect(owner.html).toContain('https://app.example.test/account/connected-apps');
    const admin = sendEmail.mock.calls.find((c) => (c[0] as { to: string }).to === 'admin@example.test')![0] as { html: string };
    expect(admin.html).toContain('https://app.example.test/settings/connected-apps');
  });

  it('an inactive owner gets nothing', async () => {
    store.loadPartnerIncidents.mockResolvedValue([row({ ownerUserId: OWNER, ownerFixHref: '/account/connected-apps' })]);
    store.loadActiveUsers.mockImplementation(async (ids: string[]) =>
      ids.filter((id) => id !== OWNER && emails[id]).map((id) => ({ id, email: emails[id]!, partnerId: P })));
    await runDigest(NOW);
    expect(sentTo()).toEqual(['admin@example.test']);
  });

  it('skips an opted-out user without claiming', async () => {
    store.loadOptedOut.mockResolvedValue(new Set([ADMIN]));
    const r = await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.claimDelivery).not.toHaveBeenCalled();
    expect(store.insertSkippedEmpty).not.toHaveBeenCalled();
    expect(r.optedOut).toBe(1);
    expect(store.loadOptedOut).toHaveBeenCalledWith([ADMIN], 'connection_health_digest');
  });

  it('a user already in the ledger for the local date is not recomputed (second run sends nothing)', async () => {
    store.loadLedgerForDate.mockResolvedValue(new Set([ADMIN]));
    const r = await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.claimDelivery).not.toHaveBeenCalled();
    expect(r.alreadyHandled).toBe(1);
  });

  it('a lost claim race sends nothing', async () => {
    store.claimDelivery.mockResolvedValue(null);
    const r = await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.claimConflicts).toBe(1);
  });

  it('expires stale claims an hour old and never resends them', async () => {
    store.expireStaleClaims.mockResolvedValue(2);
    const r = await runDigest(NOW);
    expect(store.expireStaleClaims).toHaveBeenCalledWith(new Date(NOW.getTime() - 3600_000));
    expect(r.expired).toBe(2);
    // The digest still runs; expired rows are just failed ledger entries, so
    // their users are skipped by loadLedgerForDate in the store.
    expect(store.loadLedgerForDate).toHaveBeenCalledWith([ADMIN], '2026-10-16');
  });

  it('a send failure marks the row failed and the run continues with the next user', async () => {
    setHolders({ 'organizations:write|': [ADMIN, SELECTED], 'organizations:read|': [ADMIN, SELECTED] });
    sendEmail.mockRejectedValueOnce(new Error('provider 500'));
    const r = await runDigest(NOW);
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(1);
    expect(store.markDeliveryFailed).toHaveBeenCalledWith('claim-1', 'provider 500');
    expect(store.markDeliverySent).toHaveBeenCalledTimes(1);
  });

  it('nothing to say writes skipped_empty and sends nothing', async () => {
    // Only incident is past day 7 on a Friday.
    store.loadPartnerIncidents.mockResolvedValue([row({ openedAt: new Date('2026-10-01T00:00:00Z') })]);
    const r = await runDigest(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.insertSkippedEmpty).toHaveBeenCalledWith(ADMIN, '2026-10-16', expect.any(Date));
    expect(r.skippedEmpty).toBe(1);
  });

  it('includes a restored incident the user was told about', async () => {
    store.loadPartnerIncidents.mockResolvedValue([row({ id: 'inc-r', resolvedAt: new Date('2026-10-15T20:00:00Z'), resolution: 'recovered' })]);
    store.loadRecentSent.mockResolvedValue(new Map([[ADMIN, { lastSentAt: new Date('2026-10-15T08:10:00Z'), told: new Set(['inc-r']) }]]));
    await runDigest(NOW);
    const msg = sendEmail.mock.calls[0]![0] as { subject: string };
    expect(msg.subject).toBe('Connection health: 1 connection restored');
    expect(store.claimDelivery).toHaveBeenCalledWith(ADMIN, '2026-10-16', ['inc-r'], expect.any(Date));
  });

  it('email not configured: no ledger writes at all', async () => {
    emailService.current = null;
    const r = await runDigest(NOW);
    expect(r.skipped).toBe('email_unconfigured');
    expect(store.expireStaleClaims).not.toHaveBeenCalled();
    expect(store.claimDelivery).not.toHaveBeenCalled();
  });

  it('a partner that throws does not stop the next partner', async () => {
    store.loadCandidatePartners.mockResolvedValue([{ id: 'bad', timezone: 'UTC' }, { id: P, timezone: 'UTC' }]);
    store.loadPartnerIncidents.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return [row()];
    });
    const r = await runDigest(NOW);
    expect(r.partnerFailures).toBe(1);
    expect(r.sent).toBe(1);
  });

  it('no unsubscribe secret in production: the job fails loudly before any claim or send', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(runDigest(NOW)).rejects.toThrow(/APP_ENCRYPTION_KEY/);
    expect(store.claimDelivery).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a failed sent-marker after a successful send is counted as sent, never resent or failed', async () => {
    store.markDeliverySent.mockRejectedValue(new Error('db blip'));
    const r = await runDigest(NOW);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed failed-marker after a send failure still counts one failure and no resend', async () => {
    sendEmail.mockRejectedValue(new Error('provider 500'));
    store.markDeliveryFailed.mockRejectedValue(new Error('db blip'));
    const r = await runDigest(NOW);
    expect(r.failed).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a pre-claim error is counted as errored, not failed, and leaves no claim', async () => {
    store.insertSkippedEmpty.mockRejectedValue(new Error('db blip'));
    store.loadPartnerIncidents.mockResolvedValue([row({ openedAt: new Date('2026-10-01T00:00:00Z') })]);
    const r = await runDigest(NOW);
    expect(r.errored).toBe(1);
    expect(r.failed).toBe(0);
    expect(store.claimDelivery).not.toHaveBeenCalled();
  });

  it('a user who is a recipient in two due partners gets ONE merged digest', async () => {
    const Q = 'partner-2';
    store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'UTC' }, { id: Q, timezone: 'Europe/London' }]);
    store.loadPartnerIncidents.mockImplementation(async (id: string) =>
      id === P ? [row({ id: 'inc-p' })] : [row({ id: 'inc-q', partnerId: Q, displayName: 'UniFi' })]);
    const r = await runDigest(NOW);
    expect(r.partners).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(store.claimDelivery).toHaveBeenCalledTimes(1);
    const ids = store.claimDelivery.mock.calls[0]![2] as string[];
    expect([...ids].sort()).toEqual(['inc-p', 'inc-q']);
  });

  it('an owner who no longer belongs to the incident partner gets nothing for it', async () => {
    store.loadPartnerIncidents.mockResolvedValue([row({ ownerUserId: OWNER, ownerFixHref: '/account/connected-apps' })]);
    store.loadActiveUsers.mockImplementation(async (ids: string[]) =>
      ids.filter((id) => emails[id]).map((id) => ({ id, email: emails[id]!, partnerId: id === OWNER ? 'another-partner' : P })));
    await runDigest(NOW);
    expect(sentTo()).toEqual(['admin@example.test']);
  });

  it('a maintenance failure does not block delivery and is reported', async () => {
    store.expireStaleClaims.mockRejectedValue(new Error('lock timeout'));
    store.deleteOldDeliveries.mockRejectedValue(new Error('statement timeout'));
    const r = await runDigest(NOW);
    expect(r.sent).toBe(1);
    expect(r.maintenanceFailures).toBe(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('reports a degraded run when nothing was delivered', async () => {
    sendEmail.mockRejectedValue(new Error('provider down'));
    await runDigest(NOW);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection_health_digest_degraded' }),
      undefined,
      expect.objectContaining({ sent: '0', failed: '1' }),
      expect.anything(),
    );
  });

  it('a healthy run reports nothing', async () => {
    await runDigest(NOW);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('catch-up window: 11:09 local sends, 12:09 does not', async () => {
    expect((await runDigest(new Date('2026-10-16T11:09:00Z'))).sent).toBe(1);
    sendEmail.mockClear();
    const late = await runDigest(new Date('2026-10-16T12:09:00Z'));
    expect(late.partners).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('keys the ledger on the partner-local date, not the UTC date', async () => {
    // 03:09Z on the 16th is 08:39 on the 16th in Kolkata, but 23:09 on the 15th in New York.
    store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'Asia/Kolkata' }]);
    await runDigest(new Date('2026-10-16T03:09:00Z'));
    expect(store.claimDelivery).toHaveBeenCalledWith(ADMIN, '2026-10-16', ['inc-p'], expect.any(Date));
    // Pacific/Auckland at 21:09Z on the 16th is 10:09 on the 17th.
    store.claimDelivery.mockClear();
    store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'Pacific/Auckland' }]);
    await runDigest(new Date('2026-10-16T21:09:00Z'));
    expect(store.claimDelivery).toHaveBeenCalledWith(ADMIN, '2026-10-17', expect.any(Array), expect.any(Date));
  });

  it('an invalid partner timezone is treated as UTC', async () => {
    store.loadCandidatePartners.mockResolvedValue([{ id: P, timezone: 'Not/AZone' }]);
    await runDigest(NOW);
    expect(store.claimDelivery).toHaveBeenCalledWith(ADMIN, '2026-10-16', ['inc-p'], expect.any(Date));
  });

  it('runs ledger retention with a 90-day cutoff', async () => {
    await runDigest(NOW);
    expect(store.deleteOldDeliveries).toHaveBeenCalledWith('2026-07-18', 1000);
  });

  describe('customerAdminsNotified (W5)', () => {
    const orgRow = () => row({ id: 'inc-o', orgId: ORG, orgName: 'Org A', displayName: 'M365', fixHref: '/integrations#m365' });
    const customerMsg = () => sendEmail.mock.calls
      .map((c) => c[0] as { to: string; purpose: string; partnerId?: string; html: string; text: string })
      .find((m) => m.to === 'customer@example.test');

    beforeEach(() => {
      store.loadPartnerIncidents.mockResolvedValue([orgRow()]);
      setHolders({ [`organizations:write|${ORG}`]: [ADMIN], [`organizations:read|${ORG}`]: [ADMIN] });
      orgHolders = {
        [`organizations:write|${ORG}`]: [ADMIN, CUSTOMER],
        [`organizations:read|${ORG}`]: [ADMIN, CUSTOMER],
      };
    });

    it('off (default): customer org admins get nothing; the org-member resolver is never used', async () => {
      await runDigest(NOW);
      expect(loadCustomerAdmins).toHaveBeenCalledWith([ORG]);
      expect(resolveOrgUsers).not.toHaveBeenCalled();
      expect(sentTo()).toEqual(['admin@example.test']);
    });

    it('on: a customer admin holding repair + view gets the digest on the partner lane with customer copy', async () => {
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, true]]));
      await runDigest(NOW);
      expect(sentTo().sort()).toEqual(['admin@example.test', 'customer@example.test']);
      const staff = sendEmail.mock.calls.map((c) => c[0] as { to: string; purpose: string; partnerId?: string })
        .find((m) => m.to === 'admin@example.test')!;
      expect(staff.purpose).toBe('staff.connection_health_digest');
      expect(staff.partnerId).toBeUndefined();
      const msg = customerMsg()!;
      expect(msg.purpose).toBe('customer.connection_health_digest');
      expect(msg.partnerId).toBe(P);
      expect((msg as { partnerName?: string }).partnerName).toBe('Acme MSP');
      expect(msg.text).toContain('You receive this because you can fix these connections.');
      expect(msg.text).not.toContain('in Breeze');
    });

    it('on: a customer user who lost the view permission is dropped (send-time recheck)', async () => {
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, true]]));
      orgHolders[`organizations:read|${ORG}`] = [ADMIN];
      await runDigest(NOW);
      expect(sentTo()).toEqual(['admin@example.test']);
    });

    it('on for the org: a partner-wide incident still reaches only orgAccess = all staff', async () => {
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, true]]));
      store.loadPartnerIncidents.mockResolvedValue([row()]);
      setHolders({ 'organizations:write|': [ADMIN], 'organizations:read|': [ADMIN] });
      await runDigest(NOW);
      expect(loadCustomerAdmins).toHaveBeenCalledWith([]);
      expect(resolveOrgUsers).not.toHaveBeenCalled();
      expect(sentTo()).toEqual(['admin@example.test']);
    });

    it('mixed orgs in one run: on for A, off for B; the customer admin of both hears only about A', async () => {
      const ORG_B = 'org-b';
      store.loadPartnerIncidents.mockResolvedValue([
        orgRow(),
        row({ id: 'inc-b', orgId: ORG_B, orgName: 'Org B', displayName: 'DNS filter', fixHref: '/dns-security' }),
      ]);
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, true], [ORG_B, false]]));
      setHolders({
        [`organizations:write|${ORG}`]: [ADMIN], [`organizations:read|${ORG}`]: [ADMIN],
        [`organizations:write|${ORG_B}`]: [ADMIN], [`organizations:read|${ORG_B}`]: [ADMIN],
      });
      orgHolders = {
        ...orgHolders,
        [`organizations:write|${ORG_B}`]: [ADMIN, CUSTOMER],
        [`organizations:read|${ORG_B}`]: [ADMIN, CUSTOMER],
      };
      await runDigest(NOW);
      expect(resolveOrgUsers.mock.calls.every((c) => c[0] === ORG)).toBe(true);
      const customerClaim = store.claimDelivery.mock.calls.find((c) => c[0] === CUSTOMER)!;
      expect(customerClaim[2]).toEqual(['inc-o']);
      const adminClaim = store.claimDelivery.mock.calls.find((c) => c[0] === ADMIN)!;
      expect([...adminClaim[2]].sort()).toEqual(['inc-b', 'inc-o']);
    });

    it('an org-scope grant owner gets the customer mail on the partner lane even with the setting off', async () => {
      store.loadPartnerIncidents.mockResolvedValue([
        orgRow(),
        row({ id: 'inc-g', orgId: ORG, orgName: 'Org A', ownerUserId: CUSTOMER, displayName: 'Agent app',
          condition: 'grant_revoked_reuse', fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
          viewPermission: 'connected_apps:read', repairPermission: 'connected_apps:manage' }),
      ]);
      await runDigest(NOW);
      expect(resolveOrgUsers).not.toHaveBeenCalled();
      const msg = customerMsg()!;
      expect(msg.purpose).toBe('customer.connection_health_digest');
      expect(msg.partnerId).toBe(P);
      expect(msg.text).toContain('/account/connected-apps');
      expect(msg.text).not.toContain('M365'); // the org incident did not widen to them
      expect(msg.text).not.toContain('in Breeze');
    });

    it('turning it off takes effect on the next send (recomputed, never snapshotted)', async () => {
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, true]]));
      await runDigest(NOW);
      expect(customerMsg()).toBeDefined();
      sendEmail.mockClear();
      loadCustomerAdmins.mockResolvedValue(new Map([[ORG, false]]));
      await runDigest(new Date('2026-10-17T08:09:00Z'));
      expect(customerMsg()).toBeUndefined();
    });
  });
});
