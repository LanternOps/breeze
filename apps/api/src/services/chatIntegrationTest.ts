/**
 * "Test notification" delivery for the chat integrations on the Integrations →
 * Notifications page (#12054). The route used to answer `test notification
 * queued.` without sending or queueing anything; a test now reports the real
 * outcome of one delivery attempt.
 *
 * Only Discord stores a deliverable destination there (an incoming webhook
 * URL). That URL embeds the webhook's token, so it is never echoed back in a
 * result message, and only Discord's own webhook endpoints are accepted: the
 * button must not turn into a server-side POST to an arbitrary address.
 */

export const CHAT_TEST_TIMEOUT_MS = 10_000;
export const CHAT_TEST_DEADLINE_MS = 15_000;

export interface ChatTestFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'error';
  timeoutMs: number;
  deadlineMs: number;
  streamResponse: true;
}

export interface ChatTestDeps {
  fetch: (url: string, init: ChatTestFetchInit) => Promise<Response>;
}

export type ChatTestResult =
  | { ok: true; message: string }
  | { ok: false; kind: 'invalid' | 'blocked' | 'rejected' | 'unreachable'; message: string };

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com',
  'ptb.discordapp.com',
  'canary.discordapp.com',
]);

// /api/webhooks/{id}/{token}, optionally API-versioned (/api/v10/webhooks/...).
const DISCORD_WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;

const INVALID_DISCORD_WEBHOOK =
  'Enter a Discord webhook URL (https://discord.com/api/webhooks/...) before testing';

export function parseDiscordWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, message: 'Enter the Discord webhook URL before testing' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: INVALID_DISCORD_WEBHOOK };
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || !DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase())
    || !DISCORD_WEBHOOK_PATH.test(url.pathname)
  ) {
    return { ok: false, message: INVALID_DISCORD_WEBHOOK };
  }
  return { ok: true, url: url.toString() };
}

export async function sendDiscordTestNotification(rawWebhookUrl: unknown, deps: ChatTestDeps): Promise<ChatTestResult> {
  const parsed = parseDiscordWebhookUrl(rawWebhookUrl);
  if (!parsed.ok) return { ok: false, kind: 'invalid', message: parsed.message };

  let res: Response;
  try {
    res = await deps.fetch(parsed.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `Breeze test notification: this Discord webhook is connected (${new Date().toISOString()}).`,
        // A test must never ping @everyone, @here, a role or a user.
        allowed_mentions: { parse: [] },
      }),
      redirect: 'error',
      timeoutMs: CHAT_TEST_TIMEOUT_MS,
      deadlineMs: CHAT_TEST_DEADLINE_MS,
      streamResponse: true,
    });
  } catch (e) {
    // The error text can carry the request URL, and with it the webhook token:
    // classify by name only. The SSRF guard's error is identified by name so
    // this module stays free of a urlSafety import.
    const name = e instanceof Error ? e.name : '';
    if (name === 'SsrfBlockedError') {
      return { ok: false, kind: 'blocked', message: 'The Discord webhook host is not an allowed destination' };
    }
    return { ok: false, kind: 'unreachable', message: 'Could not reach Discord to deliver the test notification' };
  }
  res.body?.cancel().catch(() => {});

  if (res.ok) return { ok: true, message: 'Discord test notification sent.' };
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return {
      ok: false,
      kind: 'rejected',
      message: `Discord rejected the webhook (HTTP ${res.status}); check that the webhook URL is current`,
    };
  }
  if (res.status === 429) {
    return { ok: false, kind: 'unreachable', message: 'Discord rate-limited the test notification (HTTP 429); try again shortly' };
  }
  return { ok: false, kind: 'unreachable', message: `Discord did not accept the test notification (HTTP ${res.status})` };
}
