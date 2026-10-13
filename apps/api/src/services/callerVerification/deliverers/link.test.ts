import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  load: vi.fn(), sms: vi.fn(), mail: vi.fn(), decide: vi.fn(), effect: vi.fn(),
  twilio: true as boolean, email: true as boolean, contexts: [] as string[], db: null as any,
}));
vi.mock('../publicLookup', () => ({ loadLinkDelivery: m.load }));
vi.mock('../service', () => ({ applyDecision: m.decide }));
vi.mock('../effects', () => ({ recordEffect: m.effect }));
vi.mock('../../twilio', () => ({
  getTwilioService: (mode: string) => {
    if (mode !== 'messaging') throw new Error(`wrong Twilio mode ${mode}`);
    return m.twilio ? { sendSmsMessage: m.sms } : null;
  },
}));
vi.mock('../../email', async (orig) => ({
  ...await orig<typeof import('../../email')>(),
  getEmailService: () => (m.email ? { sendEmail: m.mail } : null),
}));
vi.mock('../../../db', () => ({
  db: new Proxy({}, { get: (_, key) => m.db[key] }),
  runOutsideDbContext: (fn: () => unknown) => { m.contexts.push('outside'); return fn(); },
  withSystemDbAccessContext: (fn: () => unknown) => { m.contexts.push('system'); return fn(); },
}));

import { makeDbMock } from '../testing';
import { deliverLink } from './link';
import { newLinkChallenge, openLinkToken } from '../linkChallenge';

const id = '11111111-1111-4111-8111-111111111111';
const material = newLinkChallenge(id);
const token = openLinkToken(id, material.sealedToken);
const smsRow = {
  id, method: 'sms' as const, challengeTokenHash: material.challengeTokenHash, sealedLinkToken: material.sealedToken,
  destination: '+15555550123', partnerId: 'partner-1', partnerName: 'Example MSP', technicianLabel: 'Taylor',
  requestLabel: 'reset the password for alex@example.com',
};
const emailRow = { ...smsRow, method: 'email' as const, destination: 'alex@example.com' };

let state: ReturnType<typeof makeDbMock>;
beforeEach(() => {
  vi.clearAllMocks();
  m.twilio = true; m.email = true; m.contexts = [];
  state = makeDbMock(); m.db = state.db;
  state.results.push([{ id, orgId: 'org', status: 'pending' }]);
  vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
  m.load.mockResolvedValue(smsRow);
  m.sms.mockResolvedValue({ success: true });
  m.mail.mockResolvedValue(undefined);
  m.decide.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

it('sends the link by Messaging SMS, audits the send, and never approves', async () => {
  await deliverLink(id);
  expect(m.sms).toHaveBeenCalledTimes(1);
  const [to, body] = m.sms.mock.calls[0]!;
  expect(to).toBe('+15555550123');
  expect(body).toContain(`https://app.example.com/verify/${token}`);
  expect(body).toContain('Taylor from Example MSP wants to reset the password for alex@example.com');
  expect(body).toContain('number you already have');
  expect(m.decide).not.toHaveBeenCalled();
  expect(m.effect).toHaveBeenCalledWith(expect.objectContaining({ id }), 'link_sent');
  // The DB read and the audit write each ran in a short system scope, with the
  // provider call between them.
  expect(m.contexts.filter((c) => c === 'system')).toHaveLength(2);
});

it('sends email on the partner support stream through the shared template', async () => {
  m.load.mockResolvedValue(emailRow);
  await deliverLink(id);
  expect(m.mail).toHaveBeenCalledWith(expect.objectContaining({
    to: 'alex@example.com', purpose: 'security.caller_verification_link', partnerId: 'partner-1', partnerName: 'Example MSP',
    subject: 'Review a support request',
  }));
  expect(m.mail.mock.calls[0]![0].text).toContain(`/verify/${token}`);
  expect(m.decide).not.toHaveBeenCalled();
});

it.each([
  ['a returned SMS failure', () => { m.sms.mockResolvedValue({ success: false, error: 'provider detail' }); }, 'sms_failed', smsRow],
  ['no SMS transport', () => { m.twilio = false; }, 'sms_failed', smsRow],
  ['a thrown SMS failure', () => { m.sms.mockRejectedValue(new Error('boom')); }, 'sms_failed', smsRow],
  ['a thrown email failure', () => { m.mail.mockRejectedValue(new Error('smtp down')); }, 'email_failed', emailRow],
  ['no email transport', () => { m.email = false; }, 'email_failed', emailRow],
  ['an invalid app origin', () => { vi.stubEnv('PUBLIC_WEB_URL', 'http://insecure.example.com'); }, 'sms_failed', smsRow],
])('maps %s to an undeliverable decision', async (_label, arrange, reason, row) => {
  m.load.mockResolvedValue(row);
  arrange();
  await deliverLink(id);
  expect(m.decide).toHaveBeenCalledWith({ verificationId: id, decision: { kind: 'undeliverable', reason } });
  expect(m.effect).not.toHaveBeenCalled();
});

it('refuses a changed destination before any provider call', async () => {
  m.load.mockResolvedValue({ ...smsRow, destination: null });
  await deliverLink(id);
  expect(m.sms).not.toHaveBeenCalled();
  expect(m.decide).toHaveBeenCalledWith({ verificationId: id, decision: { kind: 'undeliverable', reason: 'sms_failed' } });
});

it('refuses missing or mismatched sealed material before any provider call', async () => {
  m.load.mockResolvedValue({ ...smsRow, sealedLinkToken: null });
  await deliverLink(id);
  m.load.mockResolvedValue({ ...smsRow, sealedLinkToken: newLinkChallenge(id).sealedToken });
  await deliverLink(id);
  expect(m.sms).not.toHaveBeenCalled();
  expect(m.decide).toHaveBeenCalledTimes(2);
});

it('does nothing for a terminal, expired or non-link row', async () => {
  m.load.mockResolvedValue(null);
  await deliverLink(id);
  expect(m.sms).not.toHaveBeenCalled();
  expect(m.mail).not.toHaveBeenCalled();
  expect(m.decide).not.toHaveBeenCalled();
});

it('propagates a failed decision write so the publisher retries', async () => {
  m.sms.mockResolvedValue({ success: false });
  m.decide.mockRejectedValue(new Error('db down'));
  await expect(deliverLink(id)).rejects.toThrow('db down');
});

it('never logs the token or the link', async () => {
  const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {})];
  m.sms.mockRejectedValue(new Error(`failed sending https://app.example.com/verify/${token}`));
  await deliverLink(id);
  for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
  spies.forEach((s) => s.mockRestore());
});
