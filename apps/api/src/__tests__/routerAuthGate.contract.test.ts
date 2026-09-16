/**
 * Contract for index.ts mounts: injected test auth hides a missing router gate
 * (#5866, #5963). Read the composition root without booting its server/workers,
 * then exercise each router on a fresh app with no auth context or credentials.
 * This pins 401 behavior, not middleware identity: another gate can also
 * reject missing auth. Removing a redundant gate may still satisfy the contract.
 * Only the normal unit setup's Redis mock applies; auth and handlers stay real.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Key by router expression, not mount path: public and protected routers often
// share a prefix. Auth-equivalent gates (MCP, helper, tunnel, etc.) are tested.
const EXEMPT: Record<string, string> = {
  api: 'Aggregate /api/v1 composition; its individual mounts are tested below.',
  authRoutes: 'Login and registration must accept requests before login.',
  configRoutes: 'First endpoint exposes public UI feature flags before login.',
  agentRoutes: 'First endpoints serve public agent downloads before agent-auth routes.',
  automationWebhookRoutes: 'Inbound automation webhooks authenticate with webhook secrets.',
  invoicesPublicRoutes: 'Public invoice links authenticate via share tokens.',
  quotesPublicRoutes: 'Public quote links authenticate via share tokens.',
  publicEnrollmentRoutes: 'Public enrollment installer download uses enrollment keys.',
  publicShortLinkRoutes: 'Public short links resolve enrollment downloads.',
  installerRoutes: 'Installer bootstrap/download flow uses bootstrap tokens.',
  supportPublicRoutes: 'Public support-code check/download bootstraps unattended support.',
  docsRoutes: 'Public API documentation and OpenAPI documents.',
  emailWebhookRoutes: 'Inbound email webhook authenticates provider signatures.',
  stripeWebhookRoutes: 'Stripe webhook authenticates provider signatures.',
  quickbooksWebhookRoutes: 'QuickBooks webhook authenticates provider signatures.',
  backupRoutes: 'Public bare-metal recovery code exchange precedes JWT-protected backup routes.',
  clientAiRoutes: 'First endpoint exchanges an Entra token before client AI login.',
  officeAddinRoutes: 'First endpoint exchanges an Entra token before Office add-in login.',
  huntressRoutes: 'Public provider webhook precedes JWT-protected management routes.',
  portalRoutes: 'Public portal login routes precede portal-authenticated endpoints.',
  viewerRoutes: 'First endpoint is a public viewer binary download.',
  oauthRoutes: 'Public OAuth authorization/token protocol endpoints.',
  wellKnownRoutes: 'Public OAuth discovery metadata.',
  m365CallbackRoute: 'Public Microsoft OAuth callback validates callback state.',
  m365ConsentCallbackRoutes: 'Public Microsoft consent callback validates callback state.',
  m365ActionsConsentCallbackRoutes: 'Public Microsoft actions-consent callback validates state.',
  vncExchangeRoutes: 'One-time exchange code is the credential; absent code returns 404.',
  'createAgentWsRoutes(upgradeWebSocket)': 'Agent WebSocket handshake authenticates agent credentials; requires upgrade adapter.',
  'createTerminalWsRoutes(upgradeWebSocket)': 'Terminal WebSocket handshake authenticates tickets; requires upgrade adapter.',
  'createDesktopWsRoutes(upgradeWebSocket)': 'First endpoint is public desktop-WS health; handshake requires upgrade adapter.',
  'createTunnelWsRoutes(upgradeWebSocket)': 'Tunnel WebSocket handshake authenticates tickets; requires upgrade adapter.',
  'createEventWsRoutes(upgradeWebSocket)': 'Event WebSocket handshake authenticates tickets; requires upgrade adapter.',
};

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const imports = new Map<string, { module: string; exported: string }>();
for (const match of indexSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
  for (const binding of match[1]!.split(',')) {
    const [exported, local = exported] = binding.trim().split(/\s+as\s+/);
    if (exported && local) imports.set(local, { module: match[2]!, exported });
  }
}

// Capture the complete expression (including factory calls), not only names.
const mounts = [...indexSource.matchAll(/^\s*(api|app)\.route\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\s*\);/gm)]
  .map((match) => ({ owner: match[1]!, path: match[2]!, expression: match[3]! }));
const protectedMounts = mounts.filter(({ expression }) => !Object.hasOwn(EXEMPT, expression));

beforeAll(() => {
  // These opt-in routers must register their real gates, not an empty router.
  vi.stubEnv('MCP_OAUTH_ENABLED', 'true');
  vi.stubEnv('SYNTHETIC_TEST_TOKEN', 'router-auth-contract-test-token');
});
afterAll(() => vi.unstubAllEnvs());

describe('index.ts router auth gate contract', () => {
  it('discovers every mount and keeps exemptions explicit and current', () => {
    expect(mounts.length).toBeGreaterThan(0);
    expect(protectedMounts.length).toBeGreaterThan(0);
    expect(mounts).toHaveLength([...indexSource.matchAll(/\b(?:api|app)\.route\s*\(/g)].length);
    for (const [expression, reason] of Object.entries(EXEMPT)) {
      expect(mounts.some((mount) => mount.expression === expression), expression).toBe(true);
      expect(reason.trim().length, expression).toBeGreaterThan(0);
    }
  });

  it.each(protectedMounts)('$owner: $path ($expression) rejects a bare request', async ({ path, expression }) => {
    // No arbitrary eval: ordinary imports and zero-argument router factories
    // are supported. New composition syntax fails loudly instead of escaping.
    const parsed = /^(\w+)(\(\))?$/.exec(expression);
    expect(parsed, `Unsupported router expression: ${expression}`).not.toBeNull();
    const binding = imports.get(parsed![1]!);
    expect(binding, `No import found for ${expression}`).toBeDefined();
    const modulePath = fileURLToPath(new URL(binding!.module, new URL('../index.ts', import.meta.url)));
    const exports = await import(modulePath);
    const router: Hono = parsed![2] ? exports[binding!.exported]() : exports[binding!.exported];
    expect(router, expression).toBeInstanceOf(Hono);

    // Hono records use() middleware as ALL entries too. Prefer an endpoint
    // method; an all()-only proxy uses its last ALL entry as the handler.
    const firstRoute = router.routes.find((route) => route.method !== 'ALL') ?? router.routes.at(-1);
    expect(firstRoute, `${expression} has no registered endpoint`).toBeDefined();
    const app = new Hono();
    app.route(path, router);
    const requestPath = `${path === '/' ? '' : path}${firstRoute!.path === '/' ? '' : firstRoute!.path}`
      .replace(/:[A-Za-z_][\w]*(?:\{[^}]*\})?\??/g, '11111111-1111-4111-8111-111111111111')
      .replace(/\*/g, 'probe') || '/';
    const method = firstRoute!.method === 'ALL' ? 'GET' : firstRoute!.method;
    const response = await app.request(requestPath, { method });
    expect(response.status, `${expression}: ${method} ${requestPath}`).toBe(401);
  }, 30_000); // Cold imports traverse shared service graphs; requests need no I/O.
});
