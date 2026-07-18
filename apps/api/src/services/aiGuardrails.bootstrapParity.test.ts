import { describe, expect, it, vi } from 'vitest';

// This test compares the real bootstrap tool names with the real permission map;
// the independently covered eager 48-tool registry is unrelated to that parity.
vi.mock('./aiTools', () => ({ getToolTier: vi.fn() }));

// Registry parity (MCP-OAUTH-11): every authenticated bootstrap tool MUST
// declare a TOOL_PERMISSIONS mapping, so a future bootstrap tool cannot ship
// without a product-RBAC gate. `../db` is stubbed only so importing the real
// bootstrap module (which the tool files pull in transitively) doesn't stand up
// a real Postgres pool.

vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

// The sendDeploymentInvites tool file pulls in the enrollmentKeys route module,
// which drags the whole Hono route graph in at import time (hangs under test).
// Stub it — the registry's tool NAMES (the thing under test) are unaffected.
vi.mock('../routes/enrollmentKeys', () => ({
  mintChildEnrollmentKey: vi.fn(),
}));
vi.mock('../services/email', () => ({ getEmailService: () => null }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/encryptedColumnRegistry', () => ({
  encryptColumnValueForWrite: (_t: string, _c: string, v: unknown) => v,
}));
// index.ts re-exports the invite-landing route module — another heavy Hono graph.
vi.mock('../modules/mcpInvites/inviteLandingRoutes', () => ({
  mountInviteLandingRoutes: vi.fn(),
}));

describe('bootstrap authTool RBAC registry parity (MCP-OAUTH-11)', () => {
  it('every authTool in initMcpBootstrap() has a TOOL_PERMISSIONS entry', async () => {
    const { initMcpBootstrap } = await import('../modules/mcpInvites');
    const { TOOL_PERMISSIONS } = await import('./aiGuardrails');
    const authTools = initMcpBootstrap().authTools;
    expect(authTools.length).toBeGreaterThan(0);
    const missing = authTools
      .map((t) => t.definition.name)
      .filter((name) => !(name in TOOL_PERMISSIONS));
    expect(missing).toEqual([]);
  }, 30_000); // real bootstrap module graph (oidc-provider chain) is slow to load
});
