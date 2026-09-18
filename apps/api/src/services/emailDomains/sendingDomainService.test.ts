import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, inserts, updates, insertReturns, contextCalls } = vi.hoisted(() => ({
  contextCalls: [] as string[],
  rows: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  insertReturns: [] as unknown[][],
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          inserts.push(v);
          const tail = { returning: vi.fn(async () => insertReturns.shift() ?? []) };
          return { ...tail, onConflictDoNothing: vi.fn(() => tail), onConflictDoUpdate: vi.fn(() => tail) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => {
          updates.push(v);
          return { where: vi.fn(() => ({ returning: vi.fn(async () => rows.shift() ?? []) })) };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    },
    // NOT bare pass-throughs for the admin paths: the whole point of item 2 is
    // that `withSystemDbAccessContext` is a NO-OP when a request already opened
    // a partner-scoped context, so the escape has to be observable here.
    withSystemDbAccessContext: (fn: () => unknown) => { contextCalls.push('system'); return fn(); },
    runOutsideDbContext: (fn: () => unknown) => { contextCalls.push('outside'); return fn(); },
    getCurrentDbAccessContext: () => undefined,
  };
});
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => fn() }));

const { rateLimiterMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async (_redis: unknown, _key: string, _limit: number, _window: number) =>
    ({ allowed: true, remaining: 4, resetAt: new Date() })),
}));
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../redis', () => ({ getRedis: () => ({}) }));

const { providerMock, getProviderMock, laneConfigured, maxPerPartner, allowlist } = vi.hoisted(() => {
  const providerMock = { id: 'fake' as const, verifiesByDns: true };
  return {
    providerMock,
    getProviderMock: vi.fn(() => providerMock as unknown),
    laneConfigured: { value: true },
    maxPerPartner: { value: 3 },
    allowlist: { value: [] as string[] },
  };
});
vi.mock('./providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));
vi.mock('./config', () => ({
  isPartnerLaneConfigured: () => laneConfigured.value,
  getEmailDomainsConfig: () => ({
    provider: laneConfigured.value ? 'fake' : null,
    resendApiKey: null, resendSendingKey: null,
    region: 'us-east-1', maxPerPartner: maxPerPartner.value, dailySendCap: 0,
    partnerAllowlist: allowlist.value, denylist: [], staticAllowed: [], webhookSecret: null,
  }),
  findStaticAllowedEntry: () => null,
}));

const { policyMock } = vi.hoisted(() => ({ policyMock: vi.fn((_domain: string) => undefined as void) }));
vi.mock('./domainPolicy', () => ({
  assertSendingDomainAllowed: policyMock,
  SendingDomainPolicyError: class SendingDomainPolicyError extends Error {
    constructor(public reason: string) { super(reason); }
  },
}));

const { probeRead } = vi.hoisted(() => ({ probeRead: vi.fn(async () => null as string | null) }));
vi.mock('./keyProbe', () => ({ readProviderKeyProbe: probeRead }));

const { evaluateMock } = vi.hoisted(() => ({
  evaluateMock: vi.fn((_cap: string, _ctx: unknown, _row: unknown) => ({ allow: true }) as Record<string, unknown>),
}));
vi.mock('../partnerTrust', () => ({ evaluateCapabilityContinuationForState: evaluateMock }));

const { enqueueSyncMock } = vi.hoisted(() => ({ enqueueSyncMock: vi.fn(async (_id: string) => undefined) }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: enqueueSyncMock }));

import {
  DOMAIN_UNAVAILABLE_MESSAGE, SendingDomainServiceError, createSendingDomain, deleteSenderIdentity,
  forceReleaseSendingDomain, getSendingDomainsCapability, listSendingDomains, requestDomainCheck,
  listAllSendingDomains, requestDomainRemoval, suspendSendingDomain, unsuspendSendingDomain, upsertSenderIdentity,
} from './sendingDomainService';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const partner = () => ({ id: PARTNER_ID, status: 'active', trustState: 'trusted' as const, probationEnrollments: 0 });

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO_THROW'; }
  catch (err) { return err instanceof SendingDomainServiceError ? err.code : `OTHER:${String(err)}`; }
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0; inserts.length = 0; updates.length = 0; insertReturns.length = 0; contextCalls.length = 0;
  laneConfigured.value = true; maxPerPartner.value = 3; allowlist.value = [];
  providerMock.verifiesByDns = true;
  getProviderMock.mockReturnValue(providerMock as unknown);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
  evaluateMock.mockReturnValue({ allow: true });
  probeRead.mockResolvedValue(null);
  policyMock.mockReturnValue(undefined);
});

describe('listSendingDomains DTO shape (W05 renders these fields)', () => {
  it('fills every SendingDomainDto field, including statusChangedAt, as an ISO string', async () => {
    const at = new Date('2026-09-17T12:00:00.000Z');
    rows.push([{
      id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake',
      status: 'at_risk', statusReason: 'dns_removed', dnsRecords: [],
      providerManaged: true, providerRegion: 'us-east-1',
      verifiedAt: at, lastCheckedAt: at, nextCheckAt: at, statusChangedAt: at,
      lastTestAt: null, lastTestStatus: null, lastTestError: null,
      lastSendError: null, lastSendErrorAt: null, createdAt: at,
    }]);
    rows.push([]);   // identities

    const { domains } = await listSendingDomains(partner());

    expect(domains[0]).toEqual({
      id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake',
      status: 'at_risk', statusReason: 'dns_removed', dnsRecords: [],
      verifiedAt: at.toISOString(), lastCheckedAt: at.toISOString(),
      lastTestAt: null, lastTestStatus: null, lastTestError: null,
      lastSendError: null, lastSendErrorAt: null,
      statusChangedAt: at.toISOString(),
      providerManaged: true, createdAt: at.toISOString(),
    });
    // Poll scheduling and the provider region are not the partner's business.
    expect(domains[0]).not.toHaveProperty('nextCheckAt');
    expect(domains[0]).not.toHaveProperty('providerRegion');
  });

  it('joins each identity to its domain and computes fromAddress', async () => {
    const at = new Date('2026-09-17T12:00:00.000Z');
    rows.push([]);   // domains
    rows.push([{
      identity: {
        id: 'i1', partnerId: PARTNER_ID, sendingDomainId: DOMAIN_ID, stream: 'support',
        localPart: 'help', displayName: 'Acme Support', replyTo: null, updatedAt: at,
      },
      domain: 'mail.acme.test',
    }]);

    const { identities } = await listSendingDomains(partner());

    expect(identities[0]).toEqual({
      id: 'i1', stream: 'support', sendingDomainId: DOMAIN_ID,
      domain: 'mail.acme.test', localPart: 'help', displayName: 'Acme Support',
      replyTo: null, fromAddress: 'help@mail.acme.test', updatedAt: at.toISOString(),
    });
  });
});

describe('getSendingDomainsCapability', () => {
  it('is unsupported with no provider configured — the dark default', async () => {
    laneConfigured.value = false;
    getProviderMock.mockReturnValue(null);
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: false, provider: null, eligible: false });
  });

  it('reports the provider, whether it verifies by DNS, and the per-partner cap', async () => {
    maxPerPartner.value = 5;
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 5 });
  });

  it('is ineligible with a reason when the side-effect-free trust evaluator denies', async () => {
    evaluateMock.mockReturnValue({ allow: false, code: 'TRUST_PROBATION', capability: 'custom_sending_domain', reason: 'probation' });
    const cap = await getSendingDomainsCapability(partner());
    expect(cap.eligible).toBe(false);
    expect(cap.reason).toBe('probation');
  });

  it('never writes a denial audit row — it uses the CONTINUATION evaluator, not evaluateCapability', async () => {
    await getSendingDomainsCapability(partner());
    expect(evaluateMock).toHaveBeenCalledWith('custom_sending_domain', expect.objectContaining({ partnerId: PARTNER_ID }), expect.anything());
  });

  it('is ineligible when an allowlist is set and the partner is not on it', async () => {
    allowlist.value = [OTHER_PARTNER_ID];
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ eligible: false, reason: 'not_allowlisted' });
  });

  it('is unsupported with provider_key_send_only when the worker probe found a sending-only key', async () => {
    probeRead.mockResolvedValue('send_only');
    const cap = await getSendingDomainsCapability(partner());
    expect(cap).toMatchObject({ supported: false, reason: 'provider_key_send_only' });
  });

  it('treats an unprobed key as fine rather than as a denial', async () => {
    probeRead.mockResolvedValue(null);
    const cap = await getSendingDomainsCapability(partner());
    expect(cap.supported).toBe(true);
    expect(cap.reason).toBeUndefined();
  });

  it('is ineligible for a non-active partner', async () => {
    const cap = await getSendingDomainsCapability({ ...partner(), status: 'suspended' });
    expect(cap).toMatchObject({ eligible: false, reason: 'partner_inactive' });
  });
});

describe('createSendingDomain', () => {
  const create = (domain = 'mail.acme.test') => createSendingDomain({ partnerId: PARTNER_ID, domain, userId: USER_ID });

  it('404s when no provider is configured', async () => {
    laneConfigured.value = false;
    getProviderMock.mockReturnValue(null);
    expect(await codeOf(create)).toBe('sending_domains_unsupported');
  });

  it('rejects a structurally invalid domain before any database work', async () => {
    expect(await codeOf(() => create('not a domain'))).toBe('domain_invalid');
    expect(inserts).toHaveLength(0);
  });

  it('rejects a policy-refused domain (platform, consumer, public suffix, denylist)', async () => {
    const { SendingDomainPolicyError } = await import('./domainPolicy');
    policyMock.mockImplementation(() => { throw new SendingDomainPolicyError('platform_domain'); });
    expect(await codeOf(create)).toBe('domain_invalid');
  });

  it('enforces the per-partner cap', async () => {
    maxPerPartner.value = 1;
    rows.push([{ count: 1 }]);           // own-row count
    expect(await codeOf(create)).toBe('domain_limit_reached');
  });

  it('enforces 5 creates a day per partner', async () => {
    rows.push([{ count: 0 }]);
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    expect(await codeOf(create)).toBe('rate_limited');
    const [, key, limit, window] = rateLimiterMock.mock.calls[0]!;
    expect(key).toContain(PARTNER_ID);
    expect(limit).toBe(5);
    expect(window).toBe(24 * 60 * 60);
  });

  it('refuses a domain another partner already holds INBOUND, through the partner-axis read', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: OTHER_PARTNER_ID }]);    // partner_inbound_domains hit
    expect(await codeOf(create)).toBe('domain_unavailable');
    expect(inserts).toHaveLength(0);
  });

  it('allows a domain the SAME partner holds inbound — that is the white-labelled loop', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: PARTNER_ID }]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await expect(create()).resolves.toMatchObject({ id: DOMAIN_ID, status: 'provisioning' });
  });

  it('inserts with onConflictDoNothing and returns 409 on zero rows — never raising 23505 in the request transaction', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([]);                          // the UNIQUE (domain) conflict
    expect(await codeOf(create)).toBe('domain_unavailable');
  });

  it('gives BOTH conflict causes the identical non-revealing message (spec §4.3)', async () => {
    rows.push([{ count: 0 }]);
    rows.push([{ partnerId: OTHER_PARTNER_ID }]);
    let heldElsewhere: SendingDomainServiceError | undefined;
    try { await create(); } catch (e) { heldElsewhere = e as SendingDomainServiceError; }

    rows.length = 0; insertReturns.length = 0;
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([]);
    let uniqueViolation: SendingDomainServiceError | undefined;
    try { await create(); } catch (e) { uniqueViolation = e as SendingDomainServiceError; }

    expect(heldElsewhere!.message).toBe(uniqueViolation!.message);
    expect(heldElsewhere!.message).toBe(DOMAIN_UNAVAILABLE_MESSAGE);
    expect(heldElsewhere!.message).not.toContain(OTHER_PARTNER_ID);
  });

  it('inserts provisioning and enqueues the sync AFTER the write has returned', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await create();
    expect(inserts[0]).toMatchObject({ partnerId: PARTNER_ID, domain: 'mail.acme.test', status: 'provisioning', createdBy: USER_ID });
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('normalises before storing — the stored value is the lowercase A-label', async () => {
    rows.push([{ count: 0 }]);
    rows.push([]);
    insertReturns.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await createSendingDomain({ partnerId: PARTNER_ID, domain: '  MAIL.Acme.Test.  ', userId: USER_ID });
    expect(inserts[0]!.domain).toBe('mail.acme.test');
  });
});

describe('requestDomainCheck', () => {
  it('limits a domain to one check a minute', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('rate_limited');
    const [, key, limit, window] = rateLimiterMock.mock.calls[0]!;
    expect(key).toContain(DOMAIN_ID);
    expect(limit).toBe(1);
    expect(window).toBe(60);
  });

  it('404s a domain that is not the caller\'s', async () => {
    rows.push([]);
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('not_found');
  });

  it('puts a failed row inside the retry window back to pending, keeping its DNS records', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'failed', providerDomainId: 'pd-1', dnsRecords: [{}] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null, dnsRecords: [{}], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'pending' });
    expect(updates.at(-1)!.dnsRecords).toBeUndefined();
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('sends a failed row with NO provider object back to provisioning instead', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'failed', providerDomainId: null, dnsRecords: [] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'provisioning', statusReason: null, dnsRecords: [], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'provisioning' });
  });

  it('only stamps check_requested_at for a live row', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'pending', providerDomainId: 'pd-1', dnsRecords: [] }]);
    rows.push([{ id: DOMAIN_ID, domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null, dnsRecords: [], providerManaged: true, statusChangedAt: new Date(), createdAt: new Date() }]);
    await requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)!.status).toBeUndefined();
    expect(updates.at(-1)!.checkRequestedAt).toBeInstanceOf(Date);
  });

  it('refuses to re-check a suspended row — the partner cannot undo the kill switch', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'suspended', providerDomainId: 'pd-1', dnsRecords: [] }]);
    expect(await codeOf(() => requestDomainCheck({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('domain_not_sendable');
  });
});

describe('requestDomainRemoval', () => {
  it('marks the row removing and lets the worker do the provider work', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'verified' }]);   // the ownership load
    rows.push([{ id: DOMAIN_ID, status: 'removing' }]);   // the UPDATE ... RETURNING
    await requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'removing', statusReason: 'user_removed' });
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('404s when the row is not the caller\'s (the load returns nothing under RLS)', async () => {
    rows.push([]);
    expect(await codeOf(() => requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID }))).toBe('not_found');
  });

  // Without this guard a partner can escape a platform suspension: delete the
  // suspended row, then re-create the same domain as a fresh pending one
  // (spec §5.2, §9.1). Removal is the one partner-facing write the kill switch
  // did not cover.
  it('refuses to remove a platform-suspended domain', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'suspended' }]);
    expect(await codeOf(() => requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID })))
      .toBe('domain_not_sendable');
    expect(updates).toHaveLength(0);
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });

  it('is idempotent for a row already removing', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'removing' }]);
    rows.push([{ id: DOMAIN_ID, status: 'removing' }]);
    await requestDomainRemoval({ partnerId: PARTNER_ID, domainId: DOMAIN_ID });
    expect(updates.at(-1)).toMatchObject({ status: 'removing' });
  });
});

describe('sender identities (spec §4.4)', () => {
  const upsert = (overrides: Record<string, unknown> = {}) => upsertSenderIdentity({
    partnerId: PARTNER_ID, stream: 'support', sendingDomainId: DOMAIN_ID,
    localPart: 'support', userId: USER_ID, ...overrides,
  } as Parameters<typeof upsertSenderIdentity>[0]);

  it('requires the domain to belong to the caller', async () => {
    rows.push([]);
    expect(await codeOf(() => upsert())).toBe('not_found');
  });

  it('requires the domain to be verified or at_risk', async () => {
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      rows.length = 0;
      rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status, domain: 'mail.acme.test' }]);
      expect(await codeOf(() => upsert())).toBe('domain_not_sendable');
    }
  });

  it('accepts at_risk — mail still flows there with fallback', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'at_risk', domain: 'mail.acme.test' }]);
    insertReturns.push([{ id: 'i1', partnerId: PARTNER_ID, stream: 'support', localPart: 'support', sendingDomainId: DOMAIN_ID, displayName: null, replyTo: null, updatedAt: new Date() }]);
    await expect(upsert()).resolves.toMatchObject({ stream: 'support' });
  });

  it('refuses the reserved local parts', async () => {
    for (const localPart of ['postmaster', 'abuse', 'mailer-daemon']) {
      rows.length = 0;
      rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
      expect(await codeOf(() => upsert({ localPart }))).toBe('domain_invalid');
    }
  });

  it('refuses a display name that looks like another address', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
    expect(await codeOf(() => upsert({ displayName: 'Acme <billing@bank.test>' }))).toBe('domain_invalid');
  });

  it('upserts on (partner_id, stream) so re-pointing a stream is one call', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, status: 'verified', domain: 'mail.acme.test' }]);
    insertReturns.push([{ id: 'i1', partnerId: PARTNER_ID, stream: 'billing', localPart: 'billing', sendingDomainId: DOMAIN_ID, displayName: null, replyTo: null, updatedAt: new Date() }]);
    await upsert({ stream: 'billing', localPart: 'billing' });
    expect(inserts[0]).toMatchObject({ partnerId: PARTNER_ID, stream: 'billing', localPart: 'billing', updatedBy: USER_ID });
  });

  it('deleting an identity returns the stream to the platform sender', async () => {
    await expect(deleteSenderIdentity({ partnerId: PARTNER_ID, stream: 'support' })).resolves.toBeUndefined();
  });
});

describe('platform admin actions (spec §9.1 kill switch)', () => {
  it('suspend sets suspended/platform_suspended and takes effect on the next send', async () => {
    rows.push([{ id: DOMAIN_ID, status: 'suspended' }]);
    await suspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'suspended', statusReason: 'platform_suspended' });
  });

  it('unsuspend returns the row to provisioning when it has no provider object, else pending', async () => {
    rows.push([{ id: DOMAIN_ID, providerDomainId: null }]);
    rows.push([{ id: DOMAIN_ID, status: 'provisioning' }]);
    await unsuspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'provisioning' });

    updates.length = 0; rows.length = 0;
    rows.push([{ id: DOMAIN_ID, providerDomainId: 'pd-1' }]);
    rows.push([{ id: DOMAIN_ID, status: 'pending' }]);
    await unsuspendSendingDomain(DOMAIN_ID);
    expect(updates.at(-1)).toMatchObject({ status: 'pending' });
  });

  it('force-release of a MANAGED domain writes the outbox row, nulls the handle, then drops the row', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', providerDomainId: 'pd-1', providerRegion: 'us-east-1', providerManaged: true }]);
    await forceReleaseSendingDomain(DOMAIN_ID);
    expect(inserts[0]).toMatchObject({ provider: 'fake', providerDomainId: 'pd-1', reason: 'force_release' });
    expect(updates.at(-1)).toMatchObject({ providerDomainId: null });
  });

  it('force-release of an UNMANAGED domain writes NO outbox row — we never delete what we did not create', async () => {
    rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'acme.test', provider: 'fake', providerDomainId: 'pd-1', providerRegion: null, providerManaged: false }]);
    await forceReleaseSendingDomain(DOMAIN_ID);
    expect(inserts).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ providerDomainId: null });
  });

  it('404s an unknown domain', async () => {
    rows.push([]);
    expect(await codeOf(() => forceReleaseSendingDomain(DOMAIN_ID))).toBe('not_found');
  });

  // `withSystemDbAccessContext` RETAINS an existing context (db/index.ts) — it
  // returns fn() unchanged when a store is already open — so a bare call from a
  // request handler keeps the ADMIN'S OWN partner scope and the kill switch
  // silently only ever sees that partner's rows. Every cross-partner admin path
  // must close the ambient context first, as routes/admin/trust.ts:154 does.
  it.each([
    ['listAllSendingDomains', async () => { rows.push([]); await listAllSendingDomains({ limit: 10 }); }],
    ['suspendSendingDomain', async () => { rows.push([{ id: DOMAIN_ID, status: 'suspended' }]); await suspendSendingDomain(DOMAIN_ID); }],
    ['unsuspendSendingDomain', async () => {
      rows.push([{ id: DOMAIN_ID, providerDomainId: 'pd-1' }]);
      rows.push([{ id: DOMAIN_ID, status: 'pending' }]);
      await unsuspendSendingDomain(DOMAIN_ID);
    }],
    ['forceReleaseSendingDomain', async () => {
      rows.push([{ id: DOMAIN_ID, partnerId: PARTNER_ID, domain: 'mail.acme.test', provider: 'fake', providerDomainId: 'pd-1', providerRegion: null, providerManaged: false }]);
      await forceReleaseSendingDomain(DOMAIN_ID);
    }],
  ])('%s escapes the ambient request context before electing system scope', async (_name, run) => {
    contextCalls.length = 0;
    await run();
    expect(contextCalls.length).toBeGreaterThan(0);
    // Every system election on an admin path is wrapped, never bare.
    for (let i = 0; i < contextCalls.length; i += 1) {
      if (contextCalls[i] === 'system') {
        expect(contextCalls[i - 1], 'system scope elected without leaving the request context first').toBe('outside');
      }
    }
  });
});
