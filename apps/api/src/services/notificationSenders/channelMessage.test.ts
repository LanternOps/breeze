import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool Catalog W05 (#5220) Task B3 — sendChannelMessage: a short non-alert notice to a notification channel. */

const m = vi.hoisted(() => ({
  findOwned: vi.fn(),
  getChannel: vi.fn(),
  decrypt: vi.fn(),
  throttle: vi.fn(),
  email: vi.fn(),
  sms: vi.fn(),
  pushover: vi.fn(),
  webhook: vi.fn(),
  pagerduty: vi.fn(),
  partnerRows: vi.fn(),
  order: [] as string[],
}));

vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => m.partnerRows() }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => {
    m.order.push('system:start');
    return Promise.resolve(fn()).then((v) => { m.order.push('system:end'); return v; });
  },
}));
vi.mock('../flows/ownedReferences', () => ({ findOwnedNotificationChannel: m.findOwned }));
vi.mock('../notificationChannelConfig', () => ({ getNotificationChannelWithConfig: m.getChannel }));
vi.mock('../notificationChannelSecrets', () => ({ decryptNotificationChannelConfig: m.decrypt }));
vi.mock('../notificationThrottle', () => ({ checkNotificationThrottle: m.throttle }));
vi.mock('./emailSender', async (orig) => ({ ...(await orig<object>()), sendEmailNotification: m.email }));
vi.mock('./smsSender', async (orig) => ({ ...(await orig<object>()), sendSmsNotification: m.sms }));
vi.mock('./pushoverSender', async (orig) => ({ ...(await orig<object>()), sendPushoverNotification: m.pushover }));
vi.mock('./webhookSender', async (orig) => ({ ...(await orig<object>()), sendWebhookNotification: m.webhook }));
vi.mock('./pagerDutySender', async (orig) => ({ ...(await orig<object>()), sendPagerDutyNotification: m.pagerduty }));
vi.mock('../partnerPushoverDefaults', () => ({
  readPartnerPushoverDefaults: () => ({}),
  applyPartnerPushoverDefaults: (c: unknown) => c,
}));

import { sendChannelMessage, CHANNEL_MESSAGE_TYPES } from './channelMessage';

const CH = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const owner = { orgId: ORG, partnerId: PARTNER };
const msg = { title: 'Flow paused', body: 'Nightly sync was paused.', severity: 'warning' as const, link: '/flows/f1' };

function setChannel(type: string, over: Record<string, unknown> = {}, config: unknown = {}) {
  m.findOwned.mockResolvedValue({ id: CH, type, orgId: ORG, partnerId: null, enabled: true, ...over });
  m.getChannel.mockResolvedValue({ id: CH, type, enabled: true, throttleMaxPerWindow: null, throttleWindowSeconds: 3600, config: 'sealed', ...over });
  m.decrypt.mockReturnValue(config);
}

beforeEach(() => {
  for (const k of ['findOwned', 'getChannel', 'decrypt', 'throttle', 'email', 'sms', 'pushover', 'webhook', 'pagerduty', 'partnerRows'] as const) m[k].mockReset();
  m.pagerduty.mockResolvedValue({ success: true });
  m.order.length = 0;
  m.throttle.mockResolvedValue({ allowed: true, currentCount: 0, windowExpiresAt: 0 });
  m.email.mockResolvedValue({ success: true });
  m.sms.mockResolvedValue({ success: true, sentCount: 1, failedCount: 0 });
  m.pushover.mockResolvedValue({ success: true });
  m.webhook.mockResolvedValue({ success: true });
  m.partnerRows.mockResolvedValue([{ settings: {} }]);
});

describe('sendChannelMessage', () => {
  it('exports the supported type list', () => {
    expect([...CHANNEL_MESSAGE_TYPES]).toEqual(['email', 'slack', 'teams', 'sms', 'pushover', 'webhook', 'pagerduty']);
  });

  it('email channel: title/body/severity mapped, no device or alert', async () => {
    setChannel('email', {}, { recipients: ['a@example.com'] });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r).toEqual({ ok: true, channelId: CH, channelType: 'email' });
    expect(m.email).toHaveBeenCalledTimes(1);
    expect(m.email.mock.calls[0]![0]).toMatchObject({ to: ['a@example.com'], alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'medium' });
    expect(m.email.mock.calls[0]![0].deviceName).toBeUndefined();
  });

  it('slack channel: posts the notice through the chat webhook with mapped severity', async () => {
    setChannel('slack', {}, { webhookUrl: 'https://hooks.slack.com/services/T/B/SECRET' });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r.ok).toBe(true);
    const [cfg, payload] = m.webhook.mock.calls[0]!;
    expect(cfg.url).toBe('https://hooks.slack.com/services/T/B/SECRET');
    expect(payload).toMatchObject({ alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'medium' });
    expect(payload.alertId).toBe('');
  });

  it('teams channel: posts through the chat webhook', async () => {
    setChannel('teams', {}, { webhookUrl: 'https://example.webhook.office.com/x' });
    const r = await sendChannelMessage(CH, { ...msg, severity: 'critical' }, owner);
    expect(r.ok).toBe(true);
    expect(m.webhook.mock.calls[0]![1]).toMatchObject({ alertName: 'Flow paused', severity: 'critical' });
  });

  it('sms channel: sender called with mapped fields', async () => {
    setChannel('sms', {}, { phoneNumbers: ['+15551234567'] });
    const r = await sendChannelMessage(CH, { ...msg, severity: 'info' }, owner);
    expect(r.ok).toBe(true);
    expect(m.sms.mock.calls[0]![1]).toMatchObject({ alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'info' });
  });

  it('pushover channel: sender called with mapped fields', async () => {
    setChannel('pushover', {}, { token: 't', user: 'u' });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r.ok).toBe(true);
    expect(m.pushover.mock.calls[0]![1]).toMatchObject({ alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'medium' });
  });

  // W6 (#5221, Decision 15): webhook and PagerDuty channels receive flow notices.
  it("webhook send uses the channel's signing", async () => {
    const cfg = {
      url: 'https://hooks.example.com/in', method: 'POST', authType: 'bearer', authToken: 'tok',
      headers: { 'X-Custom': '1' }, payloadTemplate: '{"t":"{{alertName}}"}',
    };
    setChannel('webhook', {}, cfg);
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r).toEqual({ ok: true, channelId: CH, channelType: 'webhook' });
    const [sentCfg, payload] = m.webhook.mock.calls[0]!;
    // The channel's own config (URL, auth, headers, template) — the alert dispatcher's path.
    expect(sentCfg).toEqual(cfg);
    expect(payload).toMatchObject({ alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'medium', orgId: ORG });
  });

  it('pagerduty dedup key is flow:<runId>:<stepId>:<item>', async () => {
    setChannel('pagerduty', {}, { routingKey: 'rk', severity: 'warning' });
    const dedupKey = 'flow:run-1:a1_send_notification:3';
    const r = await sendChannelMessage(CH, { ...msg, dedupKey }, owner);
    expect(r).toEqual({ ok: true, channelId: CH, channelType: 'pagerduty' });
    const [sentCfg, payload] = m.pagerduty.mock.calls[0]!;
    expect(sentCfg).toMatchObject({ routingKey: 'rk', dedupKey });
    expect(payload).toMatchObject({ alertName: 'Flow paused', summary: 'Nightly sync was paused.', severity: 'medium' });
  });

  it('pagerduty without a dedup key falls back to a fresh per-send key, never the channel default', async () => {
    setChannel('pagerduty', {}, { routingKey: 'rk', dedupKey: 'channel-static' });
    await sendChannelMessage(CH, msg, owner);
    const [sentCfg] = m.pagerduty.mock.calls[0]!;
    expect(sentCfg.dedupKey).not.toBe('channel-static');
    expect(sentCfg.dedupKey).toMatch(/^flow-notice:/);
  });

  it('channel of another org is refused', async () => {
    m.findOwned.mockResolvedValue(null);
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r).toMatchObject({ ok: false, code: 'channel_not_found' });
    expect(m.getChannel).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
    expect(m.webhook).not.toHaveBeenCalled();
  });

  // Review round: a lookup or throttle error happens before any send — it is a
  // definite failure, never a throw the notify step would read as "may have run".
  it('a channel lookup or throttle error before the send is a definite send_failed, never a throw', async () => {
    m.findOwned.mockRejectedValueOnce(new Error('db down'));
    await expect(sendChannelMessage(CH, msg, owner)).resolves.toMatchObject({ ok: false, code: 'send_failed' });
    setChannel('email', { throttleMaxPerWindow: 5 });
    m.throttle.mockRejectedValueOnce(new Error('redis down'));
    await expect(sendChannelMessage(CH, msg, owner)).resolves.toMatchObject({ ok: false, code: 'send_failed' });
    expect(m.email).not.toHaveBeenCalled();
  });

  it('disabled channel is refused', async () => {
    setChannel('email', { enabled: false });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r).toMatchObject({ ok: false, code: 'channel_disabled' });
    expect(m.email).not.toHaveBeenCalled();
  });

  it('throttled channel returns a throttled result', async () => {
    setChannel('email', { throttleMaxPerWindow: 5 }, { recipients: ['a@example.com'] });
    m.throttle.mockResolvedValue({ allowed: false, currentCount: 5, windowExpiresAt: Date.now() + 1000 });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r).toMatchObject({ ok: false, code: 'throttled' });
    expect(m.throttle).toHaveBeenCalledWith(CH, 'flow-notice', 5, 3600);
    expect(m.email).not.toHaveBeenCalled();
  });

  it('config is loaded in system context and the send happens after it ends', async () => {
    setChannel('email', {}, { recipients: ['a@example.com'] });
    m.email.mockImplementation(async () => { m.order.push('send'); return { success: true }; });
    await sendChannelMessage(CH, msg, owner);
    expect(m.order).toEqual(['system:start', 'system:end', 'send']);
  });

  it('sender error returns send_failed and never throws', async () => {
    setChannel('email', {}, { recipients: ['a@example.com'] });
    m.email.mockResolvedValue({ success: false, error: 'smtp down' });
    await expect(sendChannelMessage(CH, msg, owner)).resolves.toEqual({ ok: false, code: 'send_failed', message: 'smtp down' });
    m.email.mockRejectedValue(new Error('boom'));
    await expect(sendChannelMessage(CH, msg, owner)).resolves.toMatchObject({ ok: false, code: 'send_failed' });
  });

  it('a slack webhook URL in the sender error is not echoed', async () => {
    const url = 'https://hooks.slack.com/services/T000/B000/XXXSECRETXXX';
    setChannel('slack', {}, { webhookUrl: url });
    m.webhook.mockResolvedValue({ success: false, error: `POST ${url} failed: 500` });
    const r = await sendChannelMessage(CH, msg, owner);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('XXXSECRETXXX');
    m.webhook.mockRejectedValue(new Error(`fetch ${url} refused`));
    const r2 = await sendChannelMessage(CH, msg, owner);
    expect(JSON.stringify(r2)).not.toContain('XXXSECRETXXX');
  });
});
