import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

vi.mock('./monitors/monitorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitors/monitorService')>()),
  getMonitorDefinition: vi.fn(async () => ({ id: 'm', kind: 'event_log', condition: {} })),
}));

import { MONITOR_KINDS } from '@breeze/shared';
import { registerMonitorTools } from './aiToolsMonitors';
import { toolInputSchemas } from './aiToolSchemas';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';

// #7826 — the model must be able to learn valid monitor kinds + condition
// shapes from the tool itself, derived from the same zod registry the API
// validates with (no hand-written list to drift).

const ORG = '11111111-1111-4111-8111-111111111111';

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  return reg;
}

function auth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    ...overrides,
  } as unknown as AuthContext;
}

async function call(input: Record<string, unknown>, as: AuthContext = auth()) {
  const tool = registry().get('manage_monitor_definitions')!;
  return JSON.parse(await tool.handler(input, as));
}

describe('manage_monitor_definitions discoverability (#7826)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes every MONITOR_KINDS value as an enum on the input schema, plus a describe action', () => {
    const def = registry().get('manage_monitor_definitions')!.definition;
    const props = def.input_schema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect([...(props.kind?.enum ?? [])].sort()).toEqual([...MONITOR_KINDS].sort());
    expect(props.action?.enum).toContain('describe');
    expect(def.description ?? '').toMatch(/describe/);
    expect((def.description ?? '').length).toBeLessThanOrEqual(300);
    expect((props.kind?.description ?? '').length).toBeLessThanOrEqual(160);
  });

  it('the zod input schema accepts describe + kind', () => {
    expect(toolInputSchemas.manage_monitor_definitions!.safeParse({ action: 'describe', kind: 'memory' }).success).toBe(true);
  });

  it('describe without kind lists every kind', async () => {
    const result = await call({ action: 'describe' });
    expect(result.kinds).toEqual([...MONITOR_KINDS]);
  });

  it('describe with kind returns the strict condition JSON schema from the registry', async () => {
    const result = await call({ action: 'describe', kind: 'memory' });
    expect(result.kind).toBe('memory');
    expect(Object.keys(result.condition.properties).sort()).toEqual(['durationMinutes', 'operator', 'value']);
    expect(result.condition.additionalProperties).toBe(false);
    expect(result.condition.required).toEqual(expect.arrayContaining(['operator', 'value']));
  });

  it('describe works for every kind', async () => {
    for (const kind of MONITOR_KINDS) {
      const result = await call({ action: 'describe', kind });
      expect(result.error, kind).toBeUndefined();
      expect(Object.keys(result.condition.properties ?? {}).length, kind).toBeGreaterThan(0);
    }
  });

  it('describe composite exposes match + children', async () => {
    const result = await call({ action: 'describe', kind: 'composite' });
    expect(Object.keys(result.condition.properties)).toEqual(expect.arrayContaining(['match', 'children']));
  });

  it('describe rejects an unknown kind and lists the valid ones', async () => {
    const result = await call({ action: 'describe', kind: 'metric_threshold' });
    for (const kind of MONITOR_KINDS) expect(result.error).toContain(kind);
  });

  it('describe is read-only: not blocked by the site-ceiling write gate', async () => {
    const ceiling = auth({ allowedSiteIds: [] });
    const result = await call({ action: 'describe', kind: 'cpu' }, ceiling);
    expect(result.error).toBeUndefined();
    // Control: the same auth is denied on a write.
    const write = await call({ action: 'create', definition: {} }, ceiling);
    expect(write.error).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
  });

  it('create with an unknown kind points the model at describe and the valid kinds', async () => {
    const result = await call({
      action: 'create',
      definition: {
        name: 'RAM',
        kind: 'metric_threshold',
        severity: 'high',
        condition: { metric: 'ram', operator: 'gt', threshold: 90, durationMinutes: 10 },
      },
    });
    expect(result.error).toContain('describe');
    for (const kind of MONITOR_KINDS) expect(result.error).toContain(kind);
  });

  it('create with a known kind and bad condition points at describe for that kind', async () => {
    const result = await call({
      action: 'create',
      definition: { name: 'x', kind: 'cpu', severity: 'high', condition: { operator: 'gt', threshold: 90 } },
    });
    expect(result.error).toContain('describe" with kind "cpu"');
  });

  it('update with an unknown kind lists valid kinds; a kind-less update error stays terse', async () => {
    const bad = await call({ action: 'update', monitorId: ORG, definition: { kind: 'bogus' } });
    for (const kind of MONITOR_KINDS) expect(bad.error).toContain(kind);
    const terse = await call({ action: 'update', monitorId: ORG, definition: { severity: 'nope' } });
    expect(terse.error).toBeTruthy();
    expect(terse.error).not.toContain('Valid kinds');
  });

  // #7060 — event_log monitors can never match Information-level events, so a
  // rejected level/type must steer app-presence requests to compliance.
  describe('event_log app-presence hint (#7060)', () => {
    const base = { name: 'Installs', severity: 'high' };
    const eventLog = (condition: Record<string, unknown>) => ({ ...base, kind: 'event_log', condition });

    it('create with an Information level adds the hint', async () => {
      const r = await call({ action: 'create', definition: eventLog({ category: 'application', level: 'information' }) });
      expect(r.error).toContain('required_software');
      expect(r.error).toContain('Information');
    });

    it('create with a condition type key adds the hint', async () => {
      const r = await call({
        action: 'create',
        definition: eventLog({ type: 'event_log', category: 'application', level: 'warning' }),
      });
      expect(r.error).toContain('required_software');
    });

    it('composite with a bad event_log child level adds the hint', async () => {
      const child = { kind: 'event_log', condition: { category: 'application', level: 'information' } };
      const r = await call({
        action: 'create',
        definition: {
          ...base,
          kind: 'composite',
          condition: { match: 'all', children: [child, { kind: 'offline', condition: {} }] },
        },
      });
      expect(r.error).toContain('required_software');
    });

    it('update of an event_log level adds the hint', async () => {
      const r = await call({
        action: 'update',
        monitorId: ORG,
        definition: { kind: 'event_log', condition: { category: 'application', level: 'info' } },
      });
      expect(r.error).toContain('required_software');
    });

    it('does not add the hint to non-event_log errors or unrelated event_log errors', async () => {
      const cpu = await call({ action: 'create', definition: { ...base, kind: 'cpu', condition: { operator: 'gt' } } });
      expect(cpu.error).not.toContain('required_software');
      const other = await call({ action: 'create', definition: eventLog({ category: 'bogus', level: 'error' }) });
      expect(other.error).not.toContain('required_software');
    });

    it('describe event_log carries the per-category collection guidance', async () => {
      const r = await call({ action: 'describe', kind: 'event_log' });
      const text = JSON.stringify(r);
      expect(text).toContain('required_software');
      expect(text).toContain('Application log error/critical only');
    });
  });
});
