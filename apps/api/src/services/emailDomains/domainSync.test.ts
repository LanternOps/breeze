import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// syncSendingDomain. Mocks live at the top of the file; the cadence block below
// is pure and unaffected by them.
// ---------------------------------------------------------------------------
const { rows, partnerRows, updates, deletes, releases, selectCalls } = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  partnerRows: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  deletes: [] as unknown[],
  releases: [] as Record<string, unknown>[],
  selectCalls: { n: 0 },
}));

vi.mock('../../db', () => {
  // syncSendingDomain issues at most two selects per call, always in this order:
  // (1) the partner_sending_domains row, (2) the partners row for the slug.
  const selectChain = () => {
    const index = selectCalls.n++;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'for']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const result = index === 0
        ? (rows.length > 0 ? [rows[0]] : [])
        : (partnerRows.shift() ?? [{ slug: 'test-partner' }]);
      return Promise.resolve(result).then(resolve);
    };
    return chain;
  };
  const db = {
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { deletes.push(w); }) })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        releases.push(values);
        return { onConflictDoNothing: vi.fn(async () => undefined) };
      }),
    })),
  };
  return {
    db,
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

const { providerMock, getProviderMock } = vi.hoisted(() => {
  const providerMock = {
    id: 'fake' as const,
    verifiesByDns: true,
    createDomain: vi.fn(),
    findDomainByName: vi.fn(),
    getDomain: vi.fn(),
    requestVerification: vi.fn(),
    deleteDomain: vi.fn(),
    listDomains: vi.fn(),
    send: vi.fn(),
  };
  return { providerMock, getProviderMock: vi.fn(() => providerMock as unknown) };
});
vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));

const { statusMailMock } = vi.hoisted(() => ({ statusMailMock: vi.fn(async () => 1) }));
vi.mock('./statusMail', () => ({ sendSendingDomainStatusEmail: statusMailMock }));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../auditService', () => ({ createAuditLogAsync: auditMock }));
const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: captureMessageMock }));

import { FAILED_RETRY_WINDOW_MS, markStaticDomainVerified, nextCheckDelayMs, syncSendingDomain } from './domainSync';

const MIN = 60_000;

describe('nextCheckDelayMs (spec §6.2)', () => {
  it('polls a pending domain every 2 minutes for the first five attempts', () => {
    for (const attempts of [0, 1, 2, 3, 4]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(2 * MIN);
    }
  });

  it('slows a pending domain to 10 minutes for the next six attempts', () => {
    for (const attempts of [5, 6, 7, 8, 9, 10]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(10 * MIN);
    }
  });

  it('settles a pending domain at hourly until the provider fails it', () => {
    expect(nextCheckDelayMs('pending', 11)).toBe(60 * MIN);
    expect(nextCheckDelayMs('pending', 400)).toBe(60 * MIN);
  });

  it('polls at_risk hourly, whatever the attempt count', () => {
    expect(nextCheckDelayMs('at_risk', 0)).toBe(60 * MIN);
    expect(nextCheckDelayMs('at_risk', 99)).toBe(60 * MIN);
  });

  it('polls failed hourly so the 72h expiry sweep can fire', () => {
    expect(nextCheckDelayMs('failed', 0)).toBe(60 * MIN);
  });

  it('re-checks a verified domain daily with at most +/-10% jitter', () => {
    const day = 24 * 60 * MIN;
    expect(nextCheckDelayMs('verified', 0, () => 0)).toBe(Math.round(day * 0.9));
    expect(nextCheckDelayMs('verified', 0, () => 1)).toBe(Math.round(day * 1.1));
    expect(nextCheckDelayMs('verified', 0, () => 0.5)).toBe(day);
  });

  it('spreads verified rows rather than stacking them on one instant', () => {
    const values = new Set([0.05, 0.25, 0.45, 0.65, 0.85].map((r) => nextCheckDelayMs('verified', 0, () => r)));
    expect(values.size).toBe(5);
  });

  it('retries provisioning and removing quickly, and parks suspended for a day', () => {
    expect(nextCheckDelayMs('provisioning', 0)).toBe(MIN);
    expect(nextCheckDelayMs('removing', 0)).toBe(MIN);
    expect(nextCheckDelayMs('suspended', 0)).toBe(24 * 60 * MIN);
  });
});

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-17T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID,
    partnerId: PARTNER_ID,
    domain: 'mail.acme.test',
    provider: 'fake',
    providerDomainId: null,
    providerManaged: true,
    provisionAttemptedAt: null,
    providerRegion: null,
    status: 'provisioning',
    statusReason: null,
    dnsRecords: [],
    checkRequestedAt: null,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    checkAttempts: 0,
    verifiedAt: null,
    statusChangedAt: NOW,
    createdBy: '22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

function setRow(overrides: Record<string, unknown> = {}) {
  rows.length = 0;
  rows.push(row(overrides));
  selectCalls.n = 0;   // the next select is the domain row again
}

function lastStatus(): string | undefined {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const s = updates[i]!.status;
    if (typeof s === 'string') return s;
  }
  return undefined;
}

describe('syncSendingDomain (spec §6.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0; partnerRows.length = 0; updates.length = 0; deletes.length = 0; releases.length = 0;
    selectCalls.n = 0;
    providerMock.verifiesByDns = true;
    getProviderMock.mockReturnValue(providerMock as unknown);
    statusMailMock.mockResolvedValue(1);
  });

  it('is a no-op when no provider is configured (the dark default)', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('no_provider');
    expect(updates).toHaveLength(0);
  });

  it('returns not_found for a row that has already been deleted', async () => {
    rows.length = 0;
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('not_found');
    expect(providerMock.findDomainByName).not.toHaveBeenCalled();
  });

  // --- provisioning: the four find-then-create cases of spec §5.1 ------------

  it('commits provision_attempted_at BEFORE calling the provider (crash-recovery invariant)', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
    });
    const order: string[] = [];
    providerMock.findDomainByName.mockImplementation(async () => { order.push('provider'); return null; });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    const stampIndex = updates.findIndex((u) => u.provisionAttemptedAt instanceof Date);
    expect(stampIndex).toBe(0);                 // the very first write
    expect(updates[0]!.status).toBeUndefined(); // and it writes nothing else
    expect(order).toEqual(['provider']);        // the provider call came after
  });

  it('case 2 — nothing at the provider: creates, adopts as managed, goes pending and asks for verification', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'eu-west-1', state: 'pending',
      records: [{ purpose: 'dkim', type: 'TXT', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'v', status: 'pending' }],
    });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('provisioned');

    const patch = updates.at(-1)!;
    expect(patch).toMatchObject({
      providerDomainId: 'pd-1', providerRegion: 'eu-west-1', providerManaged: true, status: 'pending',
    });
    expect(patch.dnsRecords).toHaveLength(1);
    expect(providerMock.requestVerification).toHaveBeenCalledWith('pd-1');
  });

  it('case 3 — found but created AFTER our attempt: ours from a crashed run, adopted as MANAGED', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
      createdAt: new Date(NOW.getTime() - 30_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.createDomain).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ providerDomainId: 'pd-1', providerManaged: true, status: 'pending' });
  });

  it('case 4 — found and OLDER than our attempt: pre-existing, adopted as NOT managed', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', region: 'us-east-1', state: 'pending', records: [],
      createdAt: new Date(NOW.getTime() - 86_400_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ providerManaged: false });
  });

  it('an ambiguous provider object (no createdAt) resolves to NOT managed', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', state: 'pending', records: [],
    });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(updates.at(-1)).toMatchObject({ providerManaged: false });
  });

  it('an adopted already-verified domain is verified at once and never asked to verify again', async () => {
    setRow({ provisionAttemptedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', state: 'verified', records: [], createdAt: new Date(NOW.getTime() - 86_400_000),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(lastStatus()).toBe('verified');
    expect(updates.at(-1)!.verifiedAt).toBeInstanceOf(Date);
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'verified' }));
  });

  it('a static row waits in pending for its test send: no verification request is ever made', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static' });
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(lastStatus()).toBe('pending');
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('passes the partner SLUG to createDomain — the static allow-list binds by slug', async () => {
    setRow();
    partnerRows.length = 0;
    partnerRows.push([{ slug: 'acme-msp' }]);
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.createDomain).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'mail.acme.test', partnerRef: PARTNER_ID, partnerSlug: 'acme-msp',
    }));
  });

  it.each([
    ['ProviderDomainConflictError', 'provider_conflict'],
    ['ProviderDomainRejectedError', 'provider_rejected'],
  ])('maps a %s to status_reason %s', async (errorName, reason) => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockRejectedValue(Object.assign(new Error('nope'), { name: errorName }));

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('provision_failed');

    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: reason });
    expect(statusMailMock).toHaveBeenCalledTimes(1);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
  });

  // Falling back to `pending` keeps the row unable to send, which is safe — but
  // silently: an unmapped provider state is a real status partners can never
  // see, and this warn is the only place it ever surfaces.
  it('reports an unmapped provider state to Sentry rather than only warning', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-1', state: 'brand_new_resend_state' as never, records: [], createdAt: new Date(0),
    });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'sending_domain_provider_state_unknown' }),
    );
  });

  it('maps a ProviderQuotaExhaustedError to status_reason quota_exhausted', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockRejectedValue(Object.assign(new Error('at limit'), { name: 'ProviderQuotaExhaustedError' }));
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('provision_failed');
    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: 'quota_exhausted' });
  });

  // `failed` is TERMINAL: it ends the retry cadence and mails the partner that
  // the provider refused their domain. Committing it for an unclassified error
  // permanently failed a good domain on the FIRST attempt and made BullMQ's
  // `attempts: 5` dead code, because the job returned normally instead of
  // throwing. An unclassified error must leave the row alone and rethrow.
  it('does NOT fail the domain on an unclassified provider error — it rethrows so BullMQ retries', async () => {
    setRow();
    providerMock.findDomainByName.mockResolvedValue(null);
    providerMock.createDomain.mockRejectedValue(new Error('ECONNRESET'));

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).rejects.toThrow('ECONNRESET');

    expect(updates.some((u) => u.status === 'failed')).toBe(false);
    expect(statusMailMock).not.toHaveBeenCalled();
  });

  // --- the `static` contract (W02 amendment 5) ------------------------------

  it('does NOT demote a verified static row when the adapter reports pending', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null, verifiedAt: NOW });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');

    expect(lastStatus()).toBe('verified');
    expect(statusMailMock).not.toHaveBeenCalled();
  });

  it('keys a static getDomain on the DOMAIN NAME and its partner SLUG, since it has no provider id', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    partnerRows.length = 0;
    partnerRows.push([{ slug: 'acme-msp' }]);
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    // The slug is what lets `static` notice its allow-list entry was re-bound
    // to a DIFFERENT partner, which reads as `failed` rather than still listed.
    expect(providerMock.getDomain).toHaveBeenCalledWith('mail.acme.test', { partnerSlug: 'acme-msp' });
  });

  it('does not pay for a slug lookup on a DNS-verifying adapter, which ignores it', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1' });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'verified', records: [] });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.getDomain).toHaveBeenCalledWith('pd-1', { partnerSlug: null });
  });

  it('DOES fail a static row the operator delisted', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'failed', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ status: 'failed', statusReason: 'provider_rejected' });
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
  });
});

describe('markStaticDomainVerified — the only path a static row reaches verified', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0; partnerRows.length = 0; updates.length = 0; deletes.length = 0; releases.length = 0;
    selectCalls.n = 0;
    // The flag is mutable state on a module-scoped double: without this reset a
    // `verifiesByDns = false` set by one case leaks into the next one, and the
    // "Check now" case below silently stops exercising the DNS-verifying branch.
    providerMock.verifiesByDns = true;
    getProviderMock.mockReturnValue(providerMock as unknown);
    statusMailMock.mockResolvedValue(1);
  });

  it('promotes a pending static row, stamps verified_at, audits and mails', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'pending', providerDomainId: null });

    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(true);

    expect(updates.at(-1)).toMatchObject({ status: 'verified' });
    expect(updates.at(-1)!.verifiedAt).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'verified' }));
  });

  it('refuses to promote a DNS-verifying adapter — only the provider decides there', async () => {
    providerMock.verifiesByDns = true;
    setRow({ status: 'pending', providerDomainId: 'pd-1' });
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op for a row that is not pending, so a repeated test send changes nothing', async () => {
    providerMock.verifiesByDns = false;
    setRow({ provider: 'static', status: 'verified', providerDomainId: null });
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op with no provider configured', async () => {
    getProviderMock.mockReturnValue(null);
    await expect(markStaticDomainVerified(DOMAIN_ID, NOW)).resolves.toBe(false);
  });

  // --- polling ---------------------------------------------------------------

  it('maps the provider state, advances the cadence and bumps check_attempts', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkAttempts: 2 });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');

    const patch = updates.at(-1)!;
    expect(patch.checkAttempts).toBe(3);
    expect(patch.lastCheckedAt).toBeInstanceOf(Date);
    expect((patch.nextCheckAt as Date).getTime()).toBe(NOW.getTime() + nextCheckDelayMs('pending', 3));
  });

  it('honours a Check now by requesting verification first, but only when the adapter verifies by DNS', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkRequestedAt: NOW, lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).toHaveBeenCalledWith('pd-1');

    vi.clearAllMocks();
    updates.length = 0;
    providerMock.verifiesByDns = false;
    setRow({ status: 'pending', provider: 'static', providerDomainId: null, checkRequestedAt: NOW, lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: null, state: 'pending', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('does not re-request verification for a check already served', async () => {
    setRow({ status: 'pending', providerDomainId: 'pd-1', checkRequestedAt: new Date(NOW.getTime() - 120_000), lastCheckedAt: new Date(NOW.getTime() - 60_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'pending', records: [] });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    expect(providerMock.requestVerification).not.toHaveBeenCalled();
  });

  it('emails and audits only on a CHANGE of status, so a re-run is idempotent', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1', verifiedAt: NOW });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'verified', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(statusMailMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('verified -> at_risk notifies once and keeps verified_at sticky', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1', verifiedAt: new Date(NOW.getTime() - 86_400_000) });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'at_risk', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(updates.at(-1)).toMatchObject({ status: 'at_risk', statusReason: 'dns_removed' });
    expect(updates.at(-1)!.verifiedAt).toBeUndefined();
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'at_risk' }));
  });

  it('writes last_send_error from the job payload — the send path never writes this table', async () => {
    setRow({ status: 'verified', providerDomainId: 'pd-1' });
    providerMock.getDomain.mockResolvedValue({ providerDomainId: 'pd-1', state: 'verified', records: [] });

    await syncSendingDomain(DOMAIN_ID, { now: NOW, lastSendError: '550 5.7.60 sender not allowed' });

    expect(updates[0]).toMatchObject({ lastSendError: '550 5.7.60 sender not allowed' });
    expect(updates[0]!.lastSendErrorAt).toBeInstanceOf(Date);
  });

  it('suspended makes no provider call at all', async () => {
    setRow({ status: 'suspended', providerDomainId: 'pd-1' });
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('suspended_noop');
    expect(providerMock.getDomain).not.toHaveBeenCalled();
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });

  // --- expiry and removal ----------------------------------------------------

  it('moves a failed row past the 72h window to removing/failed_expired', async () => {
    setRow({ status: 'failed', statusReason: 'dns_not_detected', providerDomainId: 'pd-1', statusChangedAt: new Date(NOW.getTime() - FAILED_RETRY_WINDOW_MS - 1000) });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('expired');

    expect(updates.at(-1)).toMatchObject({ status: 'removing', statusReason: 'failed_expired' });
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'auto_removed' }));
  });

  it('leaves a failed row inside the window alone so Retry keeps the same DNS records', async () => {
    setRow({ status: 'failed', providerDomainId: 'pd-1', statusChangedAt: new Date(NOW.getTime() - 1000) });
    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('polled');
    expect(lastStatus()).toBeUndefined();
  });

  it('removing a MANAGED domain deletes at the provider, nulls the handle, then drops the row — in that order', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: true, statusReason: 'user_removed' });
    const order: string[] = [];
    providerMock.deleteDomain.mockImplementation(async () => { order.push('provider-delete'); });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('deleted');

    expect(order).toEqual(['provider-delete']);
    const nulling = updates.findIndex((u) => u.providerDomainId === null);
    expect(nulling).toBeGreaterThan(-1);
    expect(deletes).toHaveLength(1);
    expect(releases).toHaveLength(0);
  });

  // --- NEVER DELETE WHAT WE DID NOT CREATE (spec §14) ------------------------

  it('removal of an UNMANAGED domain drops the local row only: no deleteDomain, no outbox row', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: false, statusReason: 'user_removed' });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('deleted');

    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
    expect(releases).toHaveLength(0);
    expect(deletes).toHaveLength(1);
  });

  it('failed-row EXPIRY of an UNMANAGED domain also never reaches the provider', async () => {
    setRow({ status: 'failed', providerDomainId: 'pd-1', providerManaged: false, statusChangedAt: new Date(NOW.getTime() - FAILED_RETRY_WINDOW_MS - 1000) });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: false, statusReason: 'failed_expired' });
    await syncSendingDomain(DOMAIN_ID, { now: NOW });

    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
    expect(releases).toHaveLength(0);
  });

  // W02 review: releaseSendingDomainsForPartner now leaves the rows it releases
  // in `removing` / `partner_released` with the provider handle ALREADY nulled
  // (it cleared it when it wrote the outbox row). The sweep then picks them up,
  // and there is nothing left to delete at the provider.
  it('drops a partner_released row whose handle is already null without calling the provider', async () => {
    setRow({ status: 'removing', statusReason: 'partner_released', providerDomainId: null, providerManaged: true });

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).resolves.toBe('deleted');

    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
    expect(releases).toHaveLength(0);
    expect(deletes).toHaveLength(1);
  });

  it('a provider delete failure leaves the row in removing with the handle intact', async () => {
    setRow({ status: 'removing', providerDomainId: 'pd-1', providerManaged: true });
    providerMock.deleteDomain.mockRejectedValue(new Error('provider 503'));

    await expect(syncSendingDomain(DOMAIN_ID, { now: NOW })).rejects.toThrow('provider 503');

    expect(deletes).toHaveLength(0);
    expect(updates.some((u) => u.providerDomainId === null)).toBe(false);
  });
});
