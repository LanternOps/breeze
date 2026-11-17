/**
 * AI tool vs HTTP route MFA parity.
 *
 * Principle: an AI/MCP tool action that performs the same operation as an HTTP
 * route carrying `requireMfa()` must be MFA-gated too, or MCP (API keys, OAuth
 * grants) is a weaker path to the same mutation. The MCP dispatcher only
 * consults approval for an effective Tier 3 call, so for a Tier 2 action the
 * handler-side `mfaGatedToolError` call is the ONLY gate.
 *
 * Each row is pinned on both sides: the route source must still carry
 * `requireMfa()` in its middleware chain (so the table cannot go stale), and
 * the real registered handler must refuse an API-key caller with an
 * `MFA required` error before touching the database.
 *
 * Adding a `requireMfa()` route whose operation an AI tool also performs?
 * Add a row here and enrol the action in MFA_GATED_TOOL_ACTIONS.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/auth/schemas')>();
  return { ...actual, ENABLE_2FA: true };
});

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  const reached = () => { throw new Error('reached the database'); };
  return {
    ...actual,
    db: new Proxy({}, { get: () => reached }),
    withDbAccessContext: reached,
    withSystemDbAccessContext: reached,
  };
});

import { aiTools } from './aiToolNames';
import './aiTools'; // populates the registry
import { isMfaGatedToolAction, MFA_GATED_TOOL_ACTIONS } from './aiToolMfaGate';

type Row = {
  route: string;
  method: 'post' | 'patch' | 'put' | 'delete';
  path: string;
  tool: string;
  /** `undefined` for a tool with no `action` multiplexer. */
  actions: (string | undefined)[];
};

const ROWS: Row[] = [
  { route: 'routes/backup/configs.ts', method: 'post', path: '/configs', tool: 'manage_backup_configs', actions: ['create'] },
  { route: 'routes/backup/configs.ts', method: 'patch', path: '/configs/:id', tool: 'manage_backup_configs', actions: ['update'] },
  { route: 'routes/backup/profiles.ts', method: 'post', path: '/profiles', tool: 'manage_backup_profiles', actions: ['create'] },
  { route: 'routes/backup/profiles.ts', method: 'patch', path: '/profiles/:id', tool: 'manage_backup_profiles', actions: ['update'] },
  { route: 'routes/backup/profiles.ts', method: 'delete', path: '/profiles/:id', tool: 'manage_backup_profiles', actions: ['delete'] },
  { route: 'routes/patches/approvals.ts', method: 'post', path: '/:id/approve', tool: 'manage_patches', actions: ['approve'] },
  { route: 'routes/patches/approvals.ts', method: 'post', path: '/bulk-approve', tool: 'manage_patches', actions: ['bulk_approve'] },
  { route: 'routes/patches/approvals.ts', method: 'post', path: '/:id/decline', tool: 'manage_patches', actions: ['decline'] },
  { route: 'routes/patches/approvals.ts', method: 'post', path: '/:id/defer', tool: 'manage_patches', actions: ['defer'] },
  { route: 'routes/pam.ts', method: 'post', path: '/elevation-requests/:id/revoke', tool: 'revoke_elevation', actions: [undefined] },
  { route: 'routes/backup/vault.ts', method: 'post', path: '/', tool: 'configure_vault', actions: ['create'] },
  { route: 'routes/backup/vault.ts', method: 'patch', path: '/:id', tool: 'configure_vault', actions: ['update'] },
  { route: 'routes/backup/vault.ts', method: 'post', path: '/:id/sync', tool: 'trigger_vault_sync', actions: [undefined] },
  { route: 'routes/huntress.ts', method: 'post', path: '/sync', tool: 'sync_huntress_data', actions: [undefined] },
  { route: 'routes/c2c/jobs.ts', method: 'post', path: '/configs/:id/run', tool: 'trigger_c2c_sync', actions: [undefined] },
  { route: 'routes/userRisk.ts', method: 'post', path: '/assign-training', tool: 'assign_security_training', actions: [undefined] },
  { route: 'routes/patches/operations.ts', method: 'post', path: '/scan', tool: 'manage_patches', actions: ['scan'] },
  { route: 'routes/backup/sla.ts', method: 'post', path: '/configs', tool: 'configure_backup_sla', actions: ['create'] },
  { route: 'routes/backup/sla.ts', method: 'patch', path: '/configs/:id', tool: 'configure_backup_sla', actions: ['update'] },
  { route: 'routes/dr.ts', method: 'post', path: '/plans', tool: 'manage_dr_plan', actions: ['create_plan'] },
  { route: 'routes/dr.ts', method: 'patch', path: '/plans/:id', tool: 'manage_dr_plan', actions: ['update_plan'] },
  { route: 'routes/dr.ts', method: 'post', path: '/plans/:id/groups', tool: 'manage_dr_plan', actions: ['add_group'] },
  { route: 'routes/dr.ts', method: 'patch', path: '/plans/:id/groups/:gid', tool: 'manage_dr_plan', actions: ['update_group'] },
];

/** The middleware chain of `<x>Routes.<method>('<path>', ...mw, async (c) =>`. */
function middlewareChain(file: string, method: string, path: string): string {
  const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\w+Routes\\.${method}\\(\\s*'${escaped}',([\\s\\S]*?)async \\(c`).exec(src);
  if (!match) throw new Error(`${method.toUpperCase()} ${path} not found in ${file}`);
  return match[1]!;
}

const apiKeyAuth = {
  user: { id: 'u1', email: 'u@example.com', name: 'U' },
  principal: { kind: 'api_key', apiKeyId: 'key-1' },
  token: {},
  scope: 'organization',
  orgId: '00000000-0000-4000-8000-000000000001',
  partnerId: null,
  accessibleOrgIds: ['00000000-0000-4000-8000-000000000001'],
  canAccessOrg: () => true,
  orgCondition: () => undefined,
} as any;

describe('AI tool actions mirroring a requireMfa() route are MFA-gated', () => {
  it('every MFA_GATED_TOOL_ACTIONS entry names a registered tool and real actions', () => {
    for (const [tool, gated] of Object.entries(MFA_GATED_TOOL_ACTIONS)) {
      const definition = aiTools.get(tool)?.definition as any;
      expect(definition, tool).toBeDefined();
      if (gated === '*') continue;
      for (const action of gated) expect(definition.input_schema.properties.action.enum, `${tool}:${action}`).toContain(action);
    }
  });

  it.each(ROWS)('$method $route $path still carries requireMfa()', ({ route, method, path }) => {
    expect(middlewareChain(route, method, path)).toContain('requireMfa()');
  });

  const cases = ROWS.flatMap((row) => row.actions.map((action) => [row.tool, action] as const));

  it.each(cases)('%s action=%s is enrolled in MFA_GATED_TOOL_ACTIONS', (tool, action) => {
    const definition = aiTools.get(tool)?.definition as any;
    expect(definition, tool).toBeDefined();
    if (action !== undefined) expect(definition.input_schema.properties.action.enum).toContain(action);
    expect(isMfaGatedToolAction(tool, action)).toBe(true);
  });

  it.each(cases)('%s action=%s: the handler refuses an API-key caller before any query', async (tool, action) => {
    let output: string;
    try {
      output = await aiTools.get(tool)!.handler({ action }, apiKeyAuth);
    } catch (err) {
      output = JSON.stringify({ error: String(err) });
    }
    expect(JSON.parse(output).error).toMatch(/^MFA required/);
  });

  // The gate must stay as narrow as the routes: reads, and actions whose route
  // twin carries no requireMfa() (or is not enrolled here), pass the gate and
  // reach the handler body (here: the stubbed database).
  const ungated: [string, string][] = [
    ['manage_patches', 'list'],
    ['manage_patches', 'compliance'],
    ['manage_backup_profiles', 'list'],
    ['manage_backup_configs', 'get'],
    ['manage_dr_plan', 'delete_group'],
  ];

  it.each(ungated)('%s action=%s is not MFA-gated and passes the gate', async (tool, action) => {
    expect(isMfaGatedToolAction(tool, action)).toBe(false);
    let output: string;
    try {
      output = await aiTools.get(tool)!.handler({ action }, apiKeyAuth);
    } catch (err) {
      output = JSON.stringify({ error: String(err) });
    }
    expect(String(JSON.parse(output).error ?? '')).not.toMatch(/MFA required/);
  });

  it('a human session that cleared MFA passes the gate on an enrolled action', async () => {
    let output: string;
    try {
      output = await aiTools.get('configure_backup_sla')!.handler(
        { action: 'create' },
        { ...apiKeyAuth, principal: { kind: 'user_session' }, token: { mfa: true } },
      );
    } catch (err) {
      output = JSON.stringify({ error: String(err) });
    }
    expect(String(JSON.parse(output).error ?? '')).not.toMatch(/MFA required/);
  });
});
