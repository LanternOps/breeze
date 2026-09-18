import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const domainsCreate = vi.fn();
const domainsGet = vi.fn();
const domainsVerify = vi.fn();
const domainsRemove = vi.fn();
const domainsList = vi.fn();
const emailsSend = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    constructor(public readonly key?: string) {}
    domains = { create: domainsCreate, get: domainsGet, verify: domainsVerify, remove: domainsRemove, list: domainsList };
    emails = { send: emailsSend };
  }
}));

import {
  createResendDomainProvider,
  mapResendDomainStatus,
  normalizeResendRecords,
  classifyResendSendError,
  RESEND_SEND_ERROR_FIXTURES
} from './resend';
import { PartnerLaneSendFailure, ProviderDomainConflictError, ProviderDomainRejectedError, ProviderManagementAuthError } from '../provider';

const KEYS = ['EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_RESEND_SENDING_KEY', 'EMAIL_DOMAINS_REGION'];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const fn of [domainsCreate, domainsGet, domainsVerify, domainsRemove, domainsList, emailsSend]) fn.mockReset();
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

describe('mapResendDomainStatus (spec §5.2)', () => {
  it.each([
    ['not_started', 'pending'],
    ['pending', 'pending'],
    ['verified', 'verified'],
    ['partially_verified', 'verified'],
    ['temporary_failure', 'at_risk'],
    ['partially_failed', 'at_risk'],
    ['failed', 'failed']
  ] as const)('maps %s -> %s', (raw, expected) => {
    expect(mapResendDomainStatus(raw)).toBe(expected);
  });

  it('maps an UNKNOWN status to pending and warns — the unknown case never sends', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapResendDomainStatus('brand_new_status')).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('brand_new_status');
    warn.mockRestore();
  });
});

describe('normalizeResendRecords', () => {
  it('computes fqdn from a relative label and classifies purposes', () => {
    const records = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'x.dkim.amazonses.com' },
      { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'v=spf1 include:amazonses.com ~all' },
      { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'verified', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }
    ]);
    expect(records).toEqual([
      { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.acme.com', value: 'x.dkim.amazonses.com', ttl: 'Auto', status: 'pending' },
      { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.acme.com', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'verified' },
      { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: 'send.acme.com', value: 'feedback-smtp.us-east-1.amazonses.com', ttl: 'Auto', priority: 10, status: 'verified' }
    ]);
  });

  it('does not double-suffix a host the provider already returned as an FQDN', () => {
    const [record] = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'resend._domainkey.acme.com', type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'x' }
    ]);
    expect(record!.fqdn).toBe('resend._domainkey.acme.com');
  });

  it('treats an empty or @ host as the apex', () => {
    expect(normalizeResendRecords('acme.com', [{ record: 'SPF', name: '@', type: 'TXT', ttl: 'Auto', status: 'pending', value: 'v=spf1' }])[0]!.fqdn).toBe('acme.com');
    expect(normalizeResendRecords('acme.com', [{ record: 'SPF', name: '', type: 'TXT', ttl: 'Auto', status: 'pending', value: 'v=spf1' }])[0]!.fqdn).toBe('acme.com');
  });

  it('collapses not_started and temporary_failure record statuses onto pending', () => {
    const records = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'a', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'x' },
      { record: 'DKIM', name: 'b', type: 'CNAME', ttl: 'Auto', status: 'temporary_failure', value: 'y' }
    ]);
    expect(records.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('drops a record whose type we cannot publish in the UI (CAA tracking record)', () => {
    expect(normalizeResendRecords('acme.com', [
      { record: 'TrackingCAA', name: 'x', type: 'CAA', ttl: 'Auto', status: 'pending', value: 'z' }
    ])).toEqual([]);
  });

  it('survives a malformed record without throwing', () => {
    expect(normalizeResendRecords('acme.com', [null, 42, { nope: true }])).toEqual([]);
  });
});

describe('createDomain', () => {
  it('sends camelCase customReturnPath-free payload with name + region and returns the mapped domain', async () => {
    process.env.EMAIL_DOMAINS_REGION = 'eu-west-1';
    domainsCreate.mockResolvedValue({
      data: {
        id: 'dom_1', name: 'acme.com', status: 'not_started', region: 'eu-west-1',
        created_at: '2026-09-17T10:00:00.000Z',
        records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'x' }]
      },
      error: null
    });
    const result = await createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' });
    expect(domainsCreate).toHaveBeenCalledWith({ name: 'acme.com', region: 'eu-west-1' });
    expect(result).toEqual({
      providerDomainId: 'dom_1',
      region: 'eu-west-1',
      createdAt: new Date('2026-09-17T10:00:00.000Z'),
      state: 'pending',
      records: [{ purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.acme.com', value: 'x', ttl: 'Auto', status: 'pending' }]
    });
  });

  it('falls back to us-east-1 when EMAIL_DOMAINS_REGION is unset', async () => {
    domainsCreate.mockResolvedValue({ data: { id: 'd', name: 'acme.com', status: 'pending', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
    await createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' });
    expect(domainsCreate).toHaveBeenCalledWith({ name: 'acme.com', region: 'us-east-1' });
  });

  it('refuses an unrecognised region rather than sending it', async () => {
    process.env.EMAIL_DOMAINS_REGION = 'mars-1';
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toThrow(/mars-1/);
    expect(domainsCreate).not.toHaveBeenCalled();
  });

  it('raises a conflict when the provider says the domain already exists', async () => {
    domainsCreate.mockResolvedValue({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'A domain with this name already exists.' } });
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toBeInstanceOf(ProviderDomainConflictError);
  });

  it('raises a rejection for a 4xx refusal of THIS domain', async () => {
    domainsCreate.mockResolvedValue({ data: null, error: { name: 'invalid_parameter', statusCode: 400, message: 'bad name' } });
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toBeInstanceOf(ProviderDomainRejectedError);
  });

  // `provider_rejected` is a TERMINAL state that mails the partner "the provider
  // refused this domain" and stops retrying. A 5xx or a bodiless transport error
  // is the provider being unavailable, not a refusal, so it must stay a plain
  // Error for BullMQ to retry.
  it.each([
    ['a 5xx', { name: 'application_error', statusCode: 503, message: 'service unavailable' }],
    ['no status at all', { name: 'application_error', statusCode: null, message: 'socket hang up' }],
  ])('does NOT reject the domain on %s', async (_label, error) => {
    domainsCreate.mockResolvedValue({ data: null, error });
    const call = createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' });
    await expect(call).rejects.toThrow(/transient/);
    await expect(call).rejects.not.toBeInstanceOf(ProviderDomainRejectedError);
  });

  it.each([
    ['401', { name: 'application_error', statusCode: 401, message: 'unauthorized' }],
    ['403', { name: 'application_error', statusCode: 403, message: 'forbidden' }],
    ['restricted_api_key', { name: 'restricted_api_key', statusCode: 422, message: 'this key is restricted' }],
    ['invalid_api_key', { name: 'invalid_api_key', statusCode: 422, message: 'bad key' }],
    ['missing_api_key', { name: 'missing_api_key', statusCode: 422, message: 'no key' }],
  ])('classifies %s as a MANAGEMENT KEY refusal, not a domain refusal', async (_label, error) => {
    domainsCreate.mockResolvedValue({ data: null, error });
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toBeInstanceOf(ProviderManagementAuthError);
  });
});

describe('listDomains', () => {
  it('raises ProviderManagementAuthError when the key cannot manage domains', async () => {
    domainsList.mockResolvedValue({ data: null, error: { name: 'restricted_api_key', statusCode: 422, message: 'restricted' } });
    await expect(createResendDomainProvider().listDomains())
      .rejects.toBeInstanceOf(ProviderManagementAuthError);
  });

  it('raises a PLAIN error for a transient list failure, so the key verdict is not touched', async () => {
    domainsList.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 503, message: 'unavailable' } });
    const call = createResendDomainProvider().listDomains();
    await expect(call).rejects.toThrow(/listDomains failed/);
    await expect(call).rejects.not.toBeInstanceOf(ProviderManagementAuthError);
  });
});

describe('findDomainByName', () => {
  it('returns null when the account holds no such domain', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'other.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    expect(await createResendDomainProvider().findDomainByName('acme.com')).toBeNull();
  });

  it('fetches the full record set with get() — list() does not return records', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'acme.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'd1', object: 'domain', name: 'acme.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z', records: [] }, error: null });
    const found = await createResendDomainProvider().findDomainByName('acme.com');
    expect(domainsGet).toHaveBeenCalledWith('d1');
    expect(found).toEqual({ providerDomainId: 'd1', region: 'us-east-1', createdAt: new Date('2026-01-01T00:00:00.000Z'), state: 'verified', records: [] });
  });

  it('matches case-insensitively', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'ACME.com', status: 'pending', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'd1', name: 'ACME.com', status: 'pending', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z', records: [] }, error: null });
    expect(await createResendDomainProvider().findDomainByName('acme.com')).not.toBeNull();
  });

  it('propagates a list failure instead of reporting "not found"', async () => {
    // Reporting null here would make W03 CREATE a domain that already exists.
    domainsList.mockResolvedValue({ data: null, error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails.' } });
    await expect(createResendDomainProvider().findDomainByName('acme.com')).rejects.toThrow(/restricted/i);
  });
});

describe('deleteDomain', () => {
  it('succeeds', async () => {
    domainsRemove.mockResolvedValue({ data: { id: 'd1', object: 'domain', deleted: true }, error: null });
    await expect(createResendDomainProvider().deleteDomain('d1')).resolves.toBeUndefined();
  });
  it('treats a 404 not_found as success — the domain is already gone', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).resolves.toBeUndefined();
  });
  it('treats a bare 404 as success even under an unfamiliar error name', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'some_new_code', statusCode: 404, message: 'gone' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).resolves.toBeUndefined();
  });
  it('THROWS on name=not_found with a non-404 status — that is an auth or routing failure, not a deleted domain', async () => {
    // Swallowing this would mark the row released while the provider domain is
    // still live, and the outbox row is dropped on the floor.
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 401, message: 'API key not found' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).rejects.toThrow(/API key not found/);
  });
  it('throws on any other error', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).rejects.toThrow(/boom/);
  });
});

describe('requestVerification', () => {
  it('calls verify and ignores its id-only response', async () => {
    domainsVerify.mockResolvedValue({ data: { id: 'd1', object: 'domain' }, error: null });
    await expect(createResendDomainProvider().requestVerification('d1')).resolves.toBeUndefined();
    expect(domainsVerify).toHaveBeenCalledWith('d1');
  });
  it('throws on error', async () => {
    domainsVerify.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'nope' } });
    await expect(createResendDomainProvider().requestVerification('d1')).rejects.toThrow(/nope/);
  });
});

describe('send', () => {
  const message = {
    from: 'support@acme.com', to: 'customer@example.com', subject: 'Ticket #1',
    html: '<p>hi</p>', text: 'hi', partnerRef: 'p1',
    tags: { partner_id: 'p1', domain_id: 'd1', stream: 'support', purpose: 'ticket_customer_notification' }
  };

  it('maps tags into Resend name/value pairs and returns the message id', async () => {
    emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    const result = await createResendDomainProvider().send(message);
    expect(result).toEqual({ providerMessageId: 'msg_1' });
    const payload = emailsSend.mock.calls[0]![0];
    expect(payload.from).toBe('support@acme.com');
    expect(payload.tags).toEqual([
      { name: 'partner_id', value: 'p1' },
      { name: 'domain_id', value: 'd1' },
      { name: 'stream', value: 'support' },
      { name: 'purpose', value: 'ticket_customer_notification' }
    ]);
  });

  it('sanitises tag values to the charset Resend accepts (letters, digits, _ and -)', async () => {
    emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await createResendDomainProvider().send({ ...message, tags: { purpose: 'ticket.customer_notification', domain: 'acme.com' } });
    expect(emailsSend.mock.calls[0]![0].tags).toEqual([
      { name: 'purpose', value: 'ticket_customer_notification' },
      { name: 'domain', value: 'acme_com' }
    ]);
  });

  it('throws PartnerLaneSendFailure carrying the classified error', async () => {
    emailsSend.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } });
    await expect(createResendDomainProvider().send(message)).rejects.toBeInstanceOf(PartnerLaneSendFailure);
    await expect(createResendDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'lane_unavailable' } });
  });
});

describe('classifyResendSendError', () => {
  it.each([
    [{ name: 'invalid_from_address', statusCode: 422, message: 'The from address is not valid.' }, 'domain_unusable'],
    [{ name: 'validation_error', statusCode: 403, message: 'The acme.com domain is not verified. Please verify your domain.' }, 'domain_unusable'],
    [{ name: 'not_found', statusCode: 404, message: 'Domain not found' }, 'domain_unusable'],
    [{ name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' }, 'lane_unavailable'],
    [{ name: 'daily_quota_exceeded', statusCode: 429, message: 'Daily quota reached' }, 'lane_unavailable'],
    [{ name: 'monthly_quota_exceeded', statusCode: 429, message: 'Monthly quota reached' }, 'lane_unavailable'],
    [{ name: 'restricted_api_key', statusCode: 401, message: 'restricted' }, 'lane_unavailable'],
    [{ name: 'invalid_api_key', statusCode: 401, message: 'bad key' }, 'lane_unavailable'],
    [{ name: 'missing_api_key', statusCode: 401, message: 'no key' }, 'lane_unavailable'],
    [{ name: 'security_error', statusCode: 451, message: 'account paused' }, 'lane_unavailable'],
    [{ name: 'validation_error', statusCode: 422, message: 'to must be a valid email' }, 'message_rejected'],
    [{ name: 'invalid_parameter', statusCode: 400, message: 'subject too long' }, 'message_rejected'],
    [{ name: 'missing_required_field', statusCode: 422, message: 'subject is required' }, 'message_rejected'],
    [{ name: 'invalid_attachment', statusCode: 422, message: 'attachment too large' }, 'message_rejected'],
    [{ name: 'application_error', statusCode: 500, message: 'Internal server error' }, 'ambiguous'],
    [{ name: 'internal_server_error', statusCode: 500, message: 'boom' }, 'ambiguous'],
    // statusCode === null is the SDK's "never reached Resend" signal.
    [{ name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' }, 'ambiguous'],
    [{ name: 'brand_new_error_code', statusCode: 418, message: 'who knows' }, 'ambiguous']
  ] as const)('classifies %j as %s', (error, kind) => {
    expect(classifyResendSendError(error as never).kind).toBe(kind);
  });

  it('checks the domain-refusal text BEFORE the validation_error rule, so a not-verified refusal falls back instead of being lost', () => {
    expect(classifyResendSendError({ name: 'validation_error', statusCode: 403, message: 'The domain is not verified.' }).kind).toBe('domain_unusable');
  });

  it.each([
    ['invalid_api_key', 'invalid_api_key'],
    ['missing_api_key', 'missing_api_key'],
    ['restricted_api_key', 'restricted_api_key'],
    ['rate_limit_exceeded', 'rate_limit_exceeded'],
    ['daily_quota_exceeded', 'daily_quota_exceeded'],
  ])('carries the provider error name as lane_unavailable.detail for %s', (name, expected) => {
    // W04's ops alert has to tell a credential failure (someone must rotate a
    // key) from a rate limit (it will clear itself). Without detail both arrive
    // as an indistinguishable `lane_unavailable`.
    expect(classifyResendSendError({ name, statusCode: 401, message: 'whatever' }))
      .toEqual({ kind: 'lane_unavailable', detail: expected });
  });

  it('falls back to the status code for a lane_unavailable with no recognised name', () => {
    expect(classifyResendSendError({ name: '', statusCode: 429, message: 'slow down' }))
      .toMatchObject({ kind: 'lane_unavailable', detail: 'http_429' });
  });

  it('classifies every recorded fixture to its recorded kind', () => {
    for (const fixture of RESEND_SEND_ERROR_FIXTURES) {
      expect(classifyResendSendError(fixture.error), fixture.label).toMatchObject({ kind: fixture.expectedKind });
    }
  });
});
