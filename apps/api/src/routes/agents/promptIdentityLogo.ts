import { Hono } from 'hono';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { loadDevicePromptLogo } from '../../services/promptIdentity';

/**
 * GET /:id/prompt-identity/logo?sha256=<hex> (#10190 W03, plan Task 3.2).
 *
 * The MSP logo drawn on the device's prompts. The heartbeat's `promptIdentity`
 * block carries only `{ sha256, mime, bytes }`; the agent downloads the bytes
 * here over its authenticated channel and checks the sha, so the device never
 * fetches a remote URL.
 *
 * Binding: agentAuthMiddleware resolves the device from `:id` and the bearer
 * token together and puts it on the context; every id used here comes from
 * that context (`agent.deviceId`, `agent.orgId`, `agent.partnerId`), never
 * from the path or the query. The service walks device → org → partner →
 * logo source and answers only when `sha256` names that logo, so a stale sha,
 * or another partner's correct sha, is a 404.
 *
 * Self-managed DB context (SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS in
 * middleware/agentAuth.ts): on a cache miss the logo may be fetched from an
 * https source, which must never run inside the request-long org transaction
 * (#1105). The service opens its own short system read.
 *
 * Read-only; main agent credential only (the watchdog draws no prompts).
 *
 * Cache-Control: `private, max-age=3600, immutable`. The response is keyed by
 * the sha in the URL, so the bytes for a URL never change; a new logo is a new
 * sha and a new URL. `private` keeps shared caches out of it (authenticated).
 */
export const promptIdentityLogoRoutes = new Hono();

const SHA256_HEX = /^[0-9a-f]{64}$/;

promptIdentityLogoRoutes.use('/:id/prompt-identity/*', requireAgentRole);

promptIdentityLogoRoutes.get('/:id/prompt-identity/logo', async (c) => {
  const agent = c.get('agent');
  const sha256 = c.req.query('sha256') ?? '';
  if (!SHA256_HEX.test(sha256)) {
    return c.json({ error: 'sha256 must be 64 lowercase hex characters' }, 400);
  }

  let logo: Awaited<ReturnType<typeof loadDevicePromptLogo>>;
  try {
    logo = await loadDevicePromptLogo({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      partnerId: agent.partnerId,
      sha256,
    });
  } catch (err) {
    console.error(`[promptIdentityLogo] failed to load the prompt logo for device ${agent.deviceId}:`, err);
    return c.json({ error: 'Prompt logo temporarily unavailable' }, 503);
  }
  if (!logo) return c.json({ error: 'Not found' }, 404);

  return c.body(Buffer.from(logo.data), 200, {
    'Content-Type': logo.mime,
    'Content-Length': String(logo.bytes),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600, immutable',
    'Content-Security-Policy': "default-src 'none'",
  });
});
