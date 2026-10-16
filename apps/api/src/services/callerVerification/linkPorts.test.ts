import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  db: null as any, deliver: vi.fn(), inTx: vi.fn(), twilio: null as any, email: null as any,
  deliverWorkstation: vi.fn(), prepareWorkstation: vi.fn(), readyUsers: vi.fn(async () => [] as string[]),
}));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_, key) => m.db[key] }),
  assertInTransaction: m.inTx,
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
}));
vi.mock('./deliverers/link', () => ({ deliverLink: m.deliver }));
vi.mock('./deliverers/workstation', () => ({ deliverWorkstation: m.deliverWorkstation, prepareWorkstationVerification: m.prepareWorkstation }));
vi.mock('./workstationCapabilities', () => ({ workstationReadyUsers: m.readyUsers }));
vi.mock('../twilio', () => ({ getTwilioService: (mode: string) => (mode === 'messaging' ? m.twilio : null) }));
vi.mock('../email', () => ({ getEmailService: () => m.email }));

import { makeDbMock } from './testing';
import { callerVerificationPorts } from './ports';
import { linkAvailable, prepareLink } from './linkPorts';
import { hashLinkToken, openLinkToken } from './linkChallenge';
import type { VerificationRow } from './types';

const id = '11111111-1111-4111-8111-111111111111';
const token = 'T'.repeat(43);
const row = (over: Partial<VerificationRow> = {}) => ({
  id, method: 'sms', status: 'pending', challengeTokenHash: hashLinkToken(token), matchValue: '42', decoyValues: ['17', '83'], ...over,
}) as VerificationRow;

let state: ReturnType<typeof makeDbMock>;
beforeEach(() => {
  vi.clearAllMocks();
  state = makeDbMock(); m.db = state.db;
  m.twilio = { hasMessagingConfiguration: () => true };
  m.email = {};
  vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
});
afterEach(() => vi.unstubAllEnvs());

describe('prepareLink', () => {
  it('persists the same token sealed to this row plus the stored choice order, inside the start transaction', async () => {
    await prepareLink(row(), token);
    expect(m.inTx).toHaveBeenCalled();
    const set = state.calls.find((c) => c.name === 'set')!.args[0] as { sealedLinkToken: string; challengeChoices: string[] };
    expect(openLinkToken(id, set.sealedLinkToken)).toBe(token);
    expect(set.sealedLinkToken).not.toContain(token);
    expect(new Set(set.challengeChoices)).toEqual(new Set(['42', '17', '83']));
  });

  it('refuses a token that is not the one whose digest the row stores', async () => {
    await expect(prepareLink(row(), 'U'.repeat(43))).rejects.toThrow('link_token_mismatch');
    await expect(prepareLink(row(), null)).rejects.toThrow('link_token_mismatch');
    expect(state.calls.some((c) => c.name === 'update')).toBe(false);
  });
});

describe('linkAvailable', () => {
  it('requires a sender and an HTTPS app origin', () => {
    expect(linkAvailable('sms')).toBe(true);
    expect(linkAvailable('email')).toBe(true);
    m.twilio = { hasMessagingConfiguration: () => false };
    expect(linkAvailable('sms')).toBe(false);
    m.twilio = null;
    expect(linkAvailable('sms')).toBe(false);
    m.email = null;
    expect(linkAvailable('email')).toBe(false);
    m.email = {};
    vi.stubEnv('PUBLIC_WEB_URL', 'http://insecure.example.com');
    expect(linkAvailable('email')).toBe(false);
  });
});

describe('linkAvailable diagnostics', () => {
  it('says once per process why the link tier is off, never per call', async () => {
    const { __resetLinkOriginWarningForTests } = await import('./linkPorts');
    __resetLinkOriginWarningForTests();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('PUBLIC_WEB_URL', 'http://insecure.example.com');
    expect(linkAvailable('email')).toBe(false);
    expect(linkAvailable('sms')).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/PUBLIC_WEB_URL|PUBLIC_APP_URL/);
    error.mockRestore();
  });
});

describe('default ports', () => {
  it('route sms/email to the link adapter and workstation to the workstation adapter', async () => {
    expect(await callerVerificationPorts.available('sms', 'org')).toBe(true);
    expect(await callerVerificationPorts.available('email', 'org')).toBe(true);
    // Workstation readiness is per device: none without a device, else the
    // device's live helper report.
    expect(await callerVerificationPorts.available('workstation', 'org')).toBe(false);
    expect(await callerVerificationPorts.available('workstation', 'org', 'device')).toBe(false);
    m.readyUsers.mockResolvedValueOnce(['alex']);
    expect(await callerVerificationPorts.available('workstation', 'org', 'device')).toBe(true);
    expect(m.readyUsers).toHaveBeenLastCalledWith('org', 'device');

    await callerVerificationPorts.prepare(row({ method: 'email' }), token);
    expect(state.calls.some((c) => c.name === 'update')).toBe(true);
    await callerVerificationPorts.prepare(row({ method: 'workstation' }), null);
    expect(m.prepareWorkstation).toHaveBeenCalledWith(expect.objectContaining({ method: 'workstation' }));
    await expect(callerVerificationPorts.prepare(row({ method: 'callback_attestation' }), null)).rejects.toMatchObject({ code: 'method_disabled' });

    state.results.push([{ method: 'sms' }]);
    await callerVerificationPorts.deliver(id);
    expect(m.deliver).toHaveBeenCalledWith(id);

    state.results.push([{ method: 'workstation' }], [{ method: 'workstation' }]);
    await callerVerificationPorts.deliver(id);
    expect(m.deliverWorkstation).toHaveBeenCalledWith(id);
    expect(m.deliver).toHaveBeenCalledTimes(1);

    state.results.push([{ method: 'callback_attestation' }], [{ method: 'callback_attestation' }]);
    await expect(callerVerificationPorts.deliver(id)).rejects.toMatchObject({ code: 'method_disabled' });
  });
});
