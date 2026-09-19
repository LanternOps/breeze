import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => undefined) }));
vi.mock('./aiDispatch', () => ({ aiDispatchDeviceCommand: vi.fn() }));
vi.mock('./partnerTrust.commands', async () => ({
  ...(await vi.importActual<typeof import('./partnerTrust.commands')>('./partnerTrust.commands')),
  assertDeviceExecuteAllowed: vi.fn(async () => undefined),
}));

import { db } from '../db';
import { registerBrowserTools } from './aiToolsBrowser';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBrowserTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-test' },
  } as unknown as AuthContext;
}

const POLICIES = [
  { id: 'pol-own', name: 'own device', targetType: 'device', targetIds: ['dev-1'] },
  { id: 'pol-sibling', name: 'sibling device', targetType: 'device', targetIds: ['dev-2'] },
  { id: 'pol-mixed', name: 'both devices', targetType: 'device', targetIds: ['dev-1', 'dev-2'] },
  { id: 'pol-site', name: 'site wide', targetType: 'site', targetIds: ['site-1'] },
];

/** Both fleet devices sit in site-1; only the exact-device axis separates them. */
const ORG_DEVICE_ROWS = [
  { id: 'dev-1', siteId: 'site-1' },
  { id: 'dev-2', siteId: 'site-1' },
];

function mockPolicyList(rows = POLICIES): void {
  mockDb.select.mockImplementation((cols?: unknown) => {
    // A caller carrying allowedSiteIds also resolves the site-narrowed device
    // set for device-targeted policies — a {id, siteId} scan over org devices.
    if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
      return { from: () => ({ where: () => Promise.resolve(ORG_DEVICE_ROWS) }) };
    }
    return {
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }),
      }),
    };
  });
}

describe('manage_browser_policy list — exact-device axis (finding 10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller (site + device axes) does NOT see a sibling device policy', async () => {
    mockPolicyList();
    const raw = await handlerFor('manage_browser_policy')(
      { action: 'list' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const ids = JSON.parse(raw).policies.map((p: any) => p.id);
    expect(ids).not.toContain('pol-sibling');
    expect(ids).not.toContain('pol-mixed');
  });

  it('device-bound caller still sees a policy targeting only its own device', async () => {
    mockPolicyList();
    const raw = await handlerFor('manage_browser_policy')(
      { action: 'list' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const ids = JSON.parse(raw).policies.map((p: any) => p.id);
    expect(ids).toContain('pol-own');
    // Non-device-targeted policies are not device-attributable and stay visible.
    expect(ids).toContain('pol-site');
  });

  it('device-LESS analysis shape also cannot see a sibling device policy', async () => {
    mockPolicyList();
    const raw = await handlerFor('manage_browser_policy')(
      { action: 'list' },
      makeAuth({ allowedDeviceIds: ['dev-1'] }),
    );
    const ids = JSON.parse(raw).policies.map((p: any) => p.id);
    expect(ids).toEqual(['pol-own', 'pol-site']);
  });

  it('unrestricted caller sees every policy (no narrowing)', async () => {
    mockPolicyList();
    const raw = await handlerFor('manage_browser_policy')({ action: 'list' }, makeAuth({}));
    const ids = JSON.parse(raw).policies.map((p: any) => p.id);
    expect(ids).toEqual(['pol-own', 'pol-sibling', 'pol-mixed', 'pol-site']);
  });
});

/** See aiToolsPlaybooks.deviceScope.test.ts — order-preserving drizzle SQL render. */
function renderSql(node: any): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(renderSql).join('');
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(renderSql).join('');
  if ('encoder' in node && 'value' in node) return JSON.stringify(node.value);
  if (typeof node.name === 'string' && node.table) return node.name;
  if (Array.isArray(node.value)) return node.value.join('');
  return '';
}

function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

// Same class as finding 10, one tool over: the extension/violation reads are
// gated on `allowedSiteIds` alone, which a device-less analysis run never has.
describe('get_browser_security — exact-device axis', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockExtensionQueries(): { wheres: () => string[] } {
    const captured: string[] = [];
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () => Promise.resolve([
              { id: 'dev-1', siteId: 'site-1' },
              { id: 'dev-2', siteId: 'site-1' },
            ]),
          }),
        };
      }
      const chain: any = (cond: unknown) => {
        captured.push(renderSql(cond));
        const res: any = Promise.resolve([{ total: 0 }]);
        res.orderBy = () => ({ limit: () => Promise.resolve([]) });
        return res;
      };
      return {
        from: () => ({
          where: chain,
          innerJoin: () => ({ where: chain }),
        }),
      };
    });
    return { wheres: () => captured };
  }

  it('device-LESS analysis shape narrows extension and violation reads to its own device', async () => {
    const cap = mockExtensionQueries();
    const raw = await handlerFor('get_browser_security')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(JSON.parse(raw).error).toBeUndefined();
    const all = cap.wheres();
    expect(all.length).toBeGreaterThan(0);
    for (const w of all) {
      expect(w).toMatch(/device_id in \(?"dev-1"/);
      expect(w).not.toContain('dev-2');
    }
  });

  it('unrestricted caller is not narrowed at all', async () => {
    const cap = mockExtensionQueries();
    await handlerFor('get_browser_security')({}, makeAuth({}));
    for (const w of cap.wheres()) expect(w).not.toContain('device_id in');
  });
});
