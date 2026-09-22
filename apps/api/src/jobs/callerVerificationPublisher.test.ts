import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rows: [] as unknown[], updates: [] as Array<Record<string, unknown>>, applyDecision: vi.fn(), deliver: vi.fn(),
  recipients: vi.fn(), notify: vi.fn(), sendEmail: vi.fn(), emailService: null as null | { sendEmail: unknown },
}));
vi.mock('../db', () => ({
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { m.updates.push(v); } }) }),
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/userNotifications', () => ({ createNotification: m.notify }));
vi.mock('../services/email', () => ({ getEmailService: () => m.emailService }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/callerVerification/effects', () => ({ securityRecipients: m.recipients }));
vi.mock('../services/callerVerification/ports', () => ({ callerVerificationPorts: { deliver: m.deliver } }));
vi.mock('../services/callerVerification/service', () => ({ applyDecision: m.applyDecision }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { publishCallerVerificationEffects } from './callerVerificationPublisher';

const ORG = '11111111-1111-4111-8111-111111111111';
const row = (patch: Record<string, unknown>) => ({ id: 'v1', orgId: ORG, status: 'pending', method: 'sms', expiresAt: new Date(Date.now() + 60000), ...patch });

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.updates = [];
  m.emailService = { sendEmail: m.sendEmail };
  m.recipients.mockResolvedValue([{ id: 'u1', email: 'sec@example.com' }, { id: 'u2', email: 'sec2@example.com' }]);
});

it('times out an expired non-callback challenge instead of delivering it', async () => {
  m.rows = [row({ expiresAt: new Date(Date.now() - 1000) })];
  await publishCallerVerificationEffects();
  expect(m.applyDecision).toHaveBeenCalledWith({ verificationId: 'v1', decision: { kind: 'timeout' } });
  expect(m.deliver).not.toHaveBeenCalled();
  expect(m.updates).toEqual([]);
});

it('delivers a live non-callback challenge through the port, then marks it; callback rows are only marked', async () => {
  m.rows = [row({}), row({ id: 'v2', method: 'callback_attestation', expiresAt: new Date(0) })];
  await publishCallerVerificationEffects();
  expect(m.deliver).toHaveBeenCalledTimes(1);
  expect(m.deliver).toHaveBeenCalledWith('v1');
  expect(m.applyDecision).not.toHaveBeenCalled();
  expect(m.updates.map((u) => Object.keys(u))).toEqual([['deliveryPublishedAt'], ['deliveryPublishedAt']]);
});

it('does not mark delivery when the port fails, so the row is retried', async () => {
  m.rows = [row({})];
  m.deliver.mockRejectedValue(new Error('adapter down'));
  await expect(publishCallerVerificationEffects()).rejects.toThrow('adapter down');
  expect(m.updates).toEqual([]);
});

it('notifies every security recipient with a per-verification dedupe key, emails them, then marks the rejection', async () => {
  m.rows = [row({ status: 'rejected_by_user' })];
  await publishCallerVerificationEffects();
  expect(m.recipients).toHaveBeenCalledWith(ORG);
  expect(m.notify).toHaveBeenCalledTimes(2);
  expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', orgId: ORG, type: 'security', dedupeKey: 'caller-rejection-v1' }));
  expect(m.sendEmail).toHaveBeenCalledTimes(2);
  expect(m.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'sec2@example.com', purpose: 'security.caller_rejection' }));
  const sent = m.sendEmail.mock.calls.map(([p]) => JSON.stringify(p)).join('');
  expect(sent).not.toMatch(/42|1234|match|decoy/);
  expect(m.updates).toEqual([{ rejectionNotifiedAt: expect.any(Date) }]);
});

it('refuses to mark a rejection notified when no email transport exists', async () => {
  m.rows = [row({ status: 'rejected_by_user' })];
  m.emailService = null;
  await expect(publishCallerVerificationEffects()).rejects.toThrow('email transport unavailable');
  expect(m.notify).not.toHaveBeenCalled();
  expect(m.updates).toEqual([]);
});

it('leaves the rejection unmarked when one email send fails (at-least-once)', async () => {
  m.rows = [row({ status: 'rejected_by_user' })];
  m.sendEmail.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('smtp'));
  await expect(publishCallerVerificationEffects()).rejects.toThrow('smtp');
  expect(m.updates).toEqual([]);
});
