import { describe, expect, it, vi } from 'vitest';

// #10930 contract: PARTNER_WIDE_ONLY_TOOLS (the classification MCP tools/list
// and tools/call read) must match what the REAL handlers do. Every tool and
// every declared action is run three ways with the DB made unreachable:
//   A  partner scope, no partnerOrgAccess  (every MCP credential's context)
//   B  partner scope, partnerOrgAccess 'all' (a session / released intent)
//   O  organization scope, no partnerOrgAccess
// A tool whose handler refuses A on EVERY action while B gets past that
// refusal is wholly partner-wide. The test fails in both directions: an
// unclassified wholly-gated tool (advertised but dead over MCP) and a
// classified tool some A invocation can still use (hidden but alive).

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  const unreachable = () => { throw new Error('DB_UNREACHABLE'); };
  return {
    ...actual,
    db: new Proxy({}, { get: () => unreachable }),
    withDbAccessContext: unreachable,
    withSystemDbAccessContext: unreachable,
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  };
});
vi.mock('./redis', () => ({ getRedis: () => null, getRedisConnection: () => null }));

import { aiTools } from './aiTools';
import {
  canManagePartnerWidePolicies, PARTNER_SCOPE_ONLY_TOOLS, PARTNER_WIDE_ONLY_TOOLS, partnerScopeGateRefusesTool,
  partnerWideGateRefusesCall, partnerWideGateRefusesTool,
} from './partnerWideAccess';
import type { AuthContext } from '../middleware/auth';

const ID = '11111111-1111-4111-8111-111111111111';

function fill(schema: any): unknown {
  if (!schema) return ID;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') return [fill(schema.items)];
  if (schema.type === 'object') return {};
  return ID;
}

function auth(scope: 'partner' | 'organization', extra: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'api_key', apiKeyId: 'key-1' },
    user: { id: ID, email: 'admin@example.test', name: 'Admin', isPlatformAdmin: false },
    // An MFA-satisfied token, so the MFA gate never masks the partner-wide one.
    token: { sub: ID, scope, mfa: true, roleId: ID } as unknown as AuthContext['token'],
    partnerId: ID,
    orgId: scope === 'organization' ? ID : null,
    scope,
    accessibleOrgIds: [ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...extra,
  } as AuthContext;
}

async function run(tool: any, input: Record<string, unknown>, ctx: AuthContext): Promise<string> {
  try {
    return String(await tool.handler(input, ctx));
  } catch (err) {
    return `THROW:${(err as Error)?.message ?? String(err)}`;
  }
}

const isRefusal = (out: string): boolean => {
  try { return typeof JSON.parse(out)?.error === 'string'; } catch { return false; }
};

const codeOf = (out: string): unknown => {
  try { return JSON.parse(out)?.code; } catch { return undefined; }
};

type Row = { action: string | undefined; a: string; b: string; o: string };

// Every tool is probed by more than one describe below; run each once.
const probed = new Map<string, Promise<Row[]>>();
function probe(name: string): Promise<Row[]> {
  let rows = probed.get(name);
  if (!rows) probed.set(name, (rows = probeOnce(name)));
  return rows;
}

async function probeOnce(name: string): Promise<Row[]> {
  const tool = aiTools.get(name)!;
  const schema = (tool.definition.input_schema ?? {}) as any;
  const actions: Array<string | undefined> = schema.properties?.action?.enum ?? [undefined];
  const rows: Row[] = [];
  for (const action of actions) {
    const input: Record<string, unknown> = {};
    for (const key of schema.required ?? []) input[key] = fill(schema.properties?.[key]);
    if (action) input.action = action;
    rows.push({
      action,
      a: await run(tool, input, auth('partner')),
      b: await run(tool, input, auth('partner', { partnerOrgAccess: 'all' })),
      o: await run(tool, input, auth('organization')),
    });
  }
  return rows;
}

describe('PARTNER_WIDE_ONLY_TOOLS matches the handlers (#10930)', () => {
  it('lists exactly the tools whose handler refuses a partner caller without partnerOrgAccess on every action', async () => {
    const detected: string[] = [];
    for (const name of aiTools.keys()) {
      const rows = await probe(name);
      if (rows.every((r) => isRefusal(r.a) && r.a !== r.b)) detected.push(name);
    }
    expect(detected.sort()).toEqual([...PARTNER_WIDE_ONLY_TOOLS.keys()].sort());
  }, 120_000);

  it.each([...PARTNER_WIDE_ONLY_TOOLS])('%s: the scope classification "%s" matches the org-scope behaviour', async (name, scopes) => {
    const rows = await probe(name);
    if (scopes === 'any_scope') {
      // An org-scope caller is refused on every action too (by scope or by the gate).
      expect(rows.every((r) => isRefusal(r.o))).toBe(true);
    } else {
      // The gate applies only at partner scope: some org-scope call gets past the partner refusal.
      expect(rows.some((r) => r.o !== r.a)).toBe(true);
    }
  });

  it('every entry names a registered tool', () => {
    for (const name of PARTNER_WIDE_ONLY_TOOLS.keys()) expect(aiTools.has(name), name).toBe(true);
  });

  it('the predicate fails closed and follows canManagePartnerWidePolicies', () => {
    const name = [...PARTNER_WIDE_ONLY_TOOLS].find(([, s]) => s === 'any_scope')![0];
    const partnerOnly = [...PARTNER_WIDE_ONLY_TOOLS].find(([, s]) => s === 'partner_scope')![0];
    expect(partnerWideGateRefusesTool(name, auth('partner'))).toBe(true);
    expect(partnerWideGateRefusesTool(name, auth('partner', { partnerOrgAccess: 'selected' }))).toBe(true);
    expect(partnerWideGateRefusesTool(name, auth('partner', { partnerOrgAccess: 'all' }))).toBe(false);
    expect(partnerWideGateRefusesTool(name, auth('organization'))).toBe(true);
    expect(partnerWideGateRefusesTool(name, { ...auth('partner'), scope: 'system' } as AuthContext)).toBe(false);
    expect(partnerWideGateRefusesTool(partnerOnly, auth('partner'))).toBe(true);
    expect(partnerWideGateRefusesTool(partnerOnly, auth('organization'))).toBe(false);
    expect(partnerWideGateRefusesTool('list_sites', auth('partner'))).toBe(false);
    // Consistency with the handlers' own gate.
    expect(canManagePartnerWidePolicies(auth('partner'))).toBe(false);
  });

  // A released user-owned action intent rebuilds the approver's context with
  // partnerOrgAccess from the live membership (actionIntents/actorContext.ts,
  // pinned by actorContext.test.ts). With it, no classified handler returns the
  // partner-wide refusal it gives an MCP credential.
  it.each([...PARTNER_WIDE_ONLY_TOOLS.keys()])('%s: an orgAccess "all" context (a released intent) gets past the gate', async (name) => {
    const rows = await probe(name);
    for (const r of rows) expect(r.b, `${name}:${r.action}`).not.toBe(r.a);
  });
});

// #11287: a tool whose handler answers PARTNER_SCOPE_REQUIRED to an
// organization-scoped caller on every action is not listed for an org-scoped
// MCP credential, and tools/call refuses it before any intent is filed. A
// partner-scope caller (B) must get past that refusal on some action, or the
// tool is dead for everyone and belongs elsewhere. Fails in both directions.
describe('PARTNER_SCOPE_ONLY_TOOLS matches the handlers (#11287)', () => {
  it('lists exactly the tools whose handler refuses an org-scope caller with PARTNER_SCOPE_REQUIRED on every action', async () => {
    const detected: string[] = [];
    for (const name of aiTools.keys()) {
      // Already hidden from an org-scope caller by the partner-wide gate.
      if (PARTNER_WIDE_ONLY_TOOLS.get(name) === 'any_scope') continue;
      const rows = await probe(name);
      if (rows.every((r) => codeOf(r.o) === 'PARTNER_SCOPE_REQUIRED')
        && rows.some((r) => codeOf(r.b) !== 'PARTNER_SCOPE_REQUIRED')) detected.push(name);
    }
    expect(detected.sort()).toEqual([...PARTNER_SCOPE_ONLY_TOOLS].sort());
  }, 120_000);

  it('every entry names a registered tool', () => {
    for (const name of PARTNER_SCOPE_ONLY_TOOLS) expect(aiTools.has(name), name).toBe(true);
  });

  it('the predicate refuses only an organization-scope caller', () => {
    const name = [...PARTNER_SCOPE_ONLY_TOOLS][0]!;
    expect(partnerScopeGateRefusesTool(name, auth('organization'))).toBe(true);
    expect(partnerScopeGateRefusesTool(name, auth('partner'))).toBe(false);
    expect(partnerScopeGateRefusesTool(name, { ...auth('partner'), scope: 'system' } as AuthContext)).toBe(false);
    expect(partnerScopeGateRefusesTool('list_sites', auth('organization'))).toBe(false);
  });
});

// #11287: a mixed tool's partner-wide action named by its input (a partner
// baseline create) is refused at MCP filing; its other actions are not.
describe('partnerWideGateRefusesCall (#11287)', () => {
  const baseline = { action: 'create', ownerScope: 'partner' };
  it('refuses a partner baseline create without full partner access, and nothing else', () => {
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', baseline, auth('partner'))).toBe(true);
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', baseline, auth('organization'))).toBe(true);
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', baseline, auth('partner', { partnerOrgAccess: 'all' }))).toBe(false);
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', baseline, { ...auth('partner'), scope: 'system' } as AuthContext)).toBe(false);
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', { action: 'create', ownerScope: 'organization' }, auth('partner'))).toBe(false);
    expect(partnerWideGateRefusesCall('manage_ai_agent_schedules', { action: 'delete', scheduleId: ID }, auth('partner'))).toBe(false);
    expect(partnerWideGateRefusesCall('list_sites', baseline, auth('partner'))).toBe(false);
  });
});
