import { describe, expect, it, vi } from 'vitest';
import { parseDiscordWebhookUrl, sendDiscordTestNotification } from './chatIntegrationTest';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abc_DEF-123';

describe('parseDiscordWebhookUrl', () => {
  it.each([
    WEBHOOK,
    'https://discordapp.com/api/webhooks/1/token',
    'https://ptb.discord.com/api/webhooks/1/token',
    'https://canary.discord.com/api/v10/webhooks/1/token/',
    'https://DISCORD.com/api/webhooks/1/token?thread_id=42',
  ])('accepts %s', (url) => {
    expect(parseDiscordWebhookUrl(url).ok).toBe(true);
  });

  it.each([
    undefined,
    '',
    '   ',
    'not a url',
    'http://discord.com/api/webhooks/1/token',
    'https://evil.test/api/webhooks/1/token',
    'https://discord.com.evil.test/api/webhooks/1/token',
    'https://xdiscord.com/api/webhooks/1/token',
    'https://discord.com/api/webhooks/notanid/token',
    'https://discord.com/api/webhooks/1/token/extra',
    'https://discord.com/api/webhooks/1',
    'https://user:pw@discord.com/api/webhooks/1/token',
    'https://discord.com:444/api/webhooks/1/token',
  ])('rejects %s', (url) => {
    expect(parseDiscordWebhookUrl(url).ok).toBe(false);
  });
});

describe('sendDiscordTestNotification', () => {
  it('does not fetch an invalid webhook', async () => {
    const fetch = vi.fn();
    const result = await sendDiscordTestNotification('https://example.com/hook', { fetch });
    expect(result).toMatchObject({ ok: false, kind: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds the request and treats any 2xx as delivered', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    const result = await sendDiscordTestNotification(WEBHOOK, { fetch });
    expect(result).toEqual({ ok: true, message: 'Discord test notification sent.' });
    const init = fetch.mock.calls[0]![1];
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', streamResponse: true });
    expect(init.timeoutMs).toBeGreaterThan(0);
    expect(init.deadlineMs).toBeGreaterThan(0);
  });

  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [404, 'rejected'],
    [429, 'unreachable'],
    [500, 'unreachable'],
    [302, 'unreachable'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    const result = await sendDiscordTestNotification(WEBHOOK, { fetch });
    expect(result).toMatchObject({ ok: false, kind });
    if (!result.ok) expect(result.message).toContain(String(status));
  });

  it('classifies a guard refusal as blocked and never echoes the error text', async () => {
    const blocked = Object.assign(new Error(`blocked ${WEBHOOK}`), { name: 'SsrfBlockedError' });
    const result = await sendDiscordTestNotification(WEBHOOK, { fetch: vi.fn().mockRejectedValue(blocked) });
    expect(result).toMatchObject({ ok: false, kind: 'blocked' });
    expect(JSON.stringify(result)).not.toContain('abc_DEF-123');
  });

  it('classifies a transport failure as unreachable and never echoes the error text', async () => {
    const result = await sendDiscordTestNotification(WEBHOOK, {
      fetch: vi.fn().mockRejectedValue(new Error(`ECONNRESET ${WEBHOOK}`)),
    });
    expect(result).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(JSON.stringify(result)).not.toContain('abc_DEF-123');
  });
});
