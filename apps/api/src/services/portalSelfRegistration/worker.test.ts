import { beforeEach, describe, expect, it, vi } from 'vitest';

// Portal registration W6, plan Task 3 (worker outcomes, D7). Eligibility,
// the token store, the email service and the audit writer are mocked at
// their boundaries.

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  issueToken: vi.fn(),
  sendLink: vi.fn(),
  sendExisting: vi.fn(),
  emailServiceRef: { current: null as unknown },
  audit: vi.fn(),
}));

vi.mock('./eligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./eligibility')>()),
  resolveSelfRegistrationTarget: mocks.resolveTarget,
}));
vi.mock('../../routes/portal/capabilityTokens', () => ({ issuePortalSelfRegistrationToken: mocks.issueToken }));
vi.mock('../../routes/portal/helpers', () => ({ buildPortalUrl: (p: string) => `https://portal.example.com/portal${p}` }));
vi.mock('../email', () => ({ getEmailService: () => mocks.emailServiceRef.current }));
vi.mock('../auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
  writeAuditEventAsync: mocks.audit,
}));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { buildSelfRegistrationVerifyUrl, processPortalSelfRegistration, sanitizedJobError } from './worker';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const PARTNER = '9d0a1f7e-1111-4222-8333-444455556666';
const ADDRESS = 'pat@contoso.example.com';
const NAME = 'Pat <script>Doe';
const base = { orgId: ORG, partnerId: PARTNER, orgName: 'Contoso', partnerName: 'Fabrikam IT', domain: 'contoso.example.com', mode: 'approval' as const };
const job = (over: Record<string, unknown> = {}) => ({ email: ' Pat@Contoso.Example.com ', name: NAME, host: null, ...over });

function allLogs(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailServiceRef.current = { sendPortalSelfRegistrationLink: mocks.sendLink, sendPortalSelfRegistrationExistingAccount: mocks.sendExisting };
  mocks.sendLink.mockResolvedValue(undefined);
  mocks.sendExisting.mockResolvedValue(undefined);
  mocks.issueToken.mockResolvedValue('raw-token+/=');
  mocks.audit.mockResolvedValue(undefined);
});

describe('processPortalSelfRegistration (W6 D7)', () => {
  it('eligible: issues one token and sends one verify link with the token in the fragment; audits email_sent verify_link', async () => {
    mocks.resolveTarget.mockResolvedValue({ kind: 'eligible', ...base, policyFingerprint: 'f'.repeat(64) });
    expect(await processPortalSelfRegistration(job({ host: 'portal.contoso.example.com' }))).toBe('link_sent');

    expect(mocks.resolveTarget).toHaveBeenCalledWith({ email: ADDRESS, host: 'portal.contoso.example.com' });
    expect(mocks.issueToken).toHaveBeenCalledTimes(1);
    expect(mocks.issueToken).toHaveBeenCalledWith({ orgId: ORG, email: ADDRESS, name: NAME, domain: 'contoso.example.com', policyFingerprint: 'f'.repeat(64) });
    expect(mocks.sendLink).toHaveBeenCalledTimes(1);
    const sent = mocks.sendLink.mock.calls[0]![0];
    expect(sent).toEqual({
      to: ADDRESS,
      verifyUrl: 'https://portal.example.com/portal/request-access/verify#token=raw-token%2B%2F%3D',
      orgName: 'Contoso', partnerId: PARTNER, partnerName: 'Fabrikam IT',
    });
    // The name the requester typed never reaches the email.
    expect(JSON.stringify(sent)).not.toContain('Pat <script>');
    expect(mocks.sendExisting).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![1]).toMatchObject({
      orgId: ORG, action: 'portal.auth.self_register.email_sent', resourceType: 'portal_auth', actorEmail: ADDRESS,
      actorId: '00000000-0000-0000-0000-000000000000', result: 'success',
      details: { kind: 'verify_link', domain: 'contoso.example.com', mode: 'approval' },
    });
  });

  it('the verify URL keeps the token out of the path and query', () => {
    const url = new URL(buildSelfRegistrationVerifyUrl('abc'));
    expect(url.pathname).toBe('/portal/request-access/verify');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=abc');
  });

  it('existing account: sends the existing-account email, issues no token', async () => {
    mocks.resolveTarget.mockResolvedValue({ kind: 'existing_account', ...base, mode: 'instant' });
    expect(await processPortalSelfRegistration(job())).toBe('existing_account_sent');
    expect(mocks.issueToken).not.toHaveBeenCalled();
    expect(mocks.sendLink).not.toHaveBeenCalled();
    expect(mocks.sendExisting).toHaveBeenCalledWith({
      to: ADDRESS,
      loginUrl: 'https://portal.example.com/portal/login',
      forgotPasswordUrl: 'https://portal.example.com/portal/forgot-password',
      orgName: 'Contoso', partnerId: PARTNER, partnerName: 'Fabrikam IT',
    });
    expect(mocks.audit.mock.calls[0]![1]).toMatchObject({ orgId: ORG, details: { kind: 'existing_account', domain: 'contoso.example.com', mode: 'instant' } });
  });

  it('ineligible: sends nothing, writes no org audit, logs the domain but never the address', async () => {
    const spies = [vi.spyOn(console, 'debug'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
      .map((s) => s.mockImplementation(() => {}));
    for (const reason of ['no_verified_domain', 'host_mismatch', 'org_inactive', 'mode_off'] as const) {
      mocks.resolveTarget.mockResolvedValue({ kind: 'ineligible', reason });
      expect(await processPortalSelfRegistration(job())).toBe('ineligible');
    }
    expect(mocks.issueToken).not.toHaveBeenCalled();
    expect(mocks.sendLink).not.toHaveBeenCalled();
    expect(mocks.sendExisting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    const logs = allLogs(spies);
    expect(logs).toContain('contoso.example.com');
    expect(logs.toLowerCase()).not.toContain('pat@');
    expect(logs).not.toContain('Pat <script>');
  });

  it('a send failure is logged and not retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.resolveTarget.mockResolvedValue({ kind: 'eligible', ...base, policyFingerprint: 'f'.repeat(64) });
    mocks.sendLink.mockRejectedValue(new Error(`transport refused ${ADDRESS}`));
    // Resolves (never throws), so BullMQ records success and never retries.
    expect(await processPortalSelfRegistration(job())).toBe('not_sent');
    expect(mocks.sendLink).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(ADDRESS);

    mocks.resolveTarget.mockResolvedValue({ kind: 'existing_account', ...base });
    mocks.sendExisting.mockRejectedValue(new Error('down'));
    expect(await processPortalSelfRegistration(job())).toBe('not_sent');
    expect(mocks.sendExisting).toHaveBeenCalledTimes(1);
  });

  it('token store unavailable: no email, logged not_sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.resolveTarget.mockResolvedValue({ kind: 'eligible', ...base, policyFingerprint: 'f'.repeat(64) });
    mocks.issueToken.mockResolvedValue(null);
    expect(await processPortalSelfRegistration(job())).toBe('not_sent');
    expect(mocks.sendLink).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not issued'), { orgId: ORG, domain: 'contoso.example.com' });
  });

  it('no email service: nothing is minted or sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.emailServiceRef.current = null;
    mocks.resolveTarget.mockResolvedValue({ kind: 'eligible', ...base, policyFingerprint: 'f'.repeat(64) });
    expect(await processPortalSelfRegistration(job())).toBe('not_sent');
    expect(mocks.issueToken).not.toHaveBeenCalled();
  });
});

describe('sanitizedJobError', () => {
  it('keeps the error class and drops the message and cause (a failed query embeds the address)', () => {
    const original = new TypeError(`Failed query: select ... params: ${ADDRESS}`, { cause: new Error(ADDRESS) });
    const clean = sanitizedJobError(original);
    expect(clean.message).toContain('TypeError');
    expect(clean.message).not.toContain(ADDRESS);
    expect(clean.cause).toBeUndefined();
    expect(JSON.stringify({ m: clean.message, s: clean.stack })).not.toContain(ADDRESS);
  });
});

describe('queue options', () => {
  it('one attempt, removed on completion, failed jobs kept one day', async () => {
    const { PORTAL_SELF_REGISTRATION_JOB_OPTIONS } = await import('./queue');
    expect(PORTAL_SELF_REGISTRATION_JOB_OPTIONS).toEqual({ attempts: 1, removeOnComplete: true, removeOnFail: { age: 86_400 } });
  });
});
