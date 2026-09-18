import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerPlaybookTools } from './aiToolsPlaybooks';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPlaybookTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
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
  } as unknown as AuthContext;
}

/**
 * Order-preserving render of a drizzle SQL tree into `column op [params]` text
 * so a test can assert WHICH column carries WHICH literal. Deliberately not a
 * deep value search: a bare "does 'dev-1' appear anywhere" scan matches enum
 * values and unrelated params and reads green without the fix.
 */
export function renderSql(node: any): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(renderSql).join('');
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(renderSql).join('');
  if ('encoder' in node && 'value' in node) return JSON.stringify(node.value); // Param
  if (typeof node.name === 'string' && node.table) return node.name; // Column
  if (Array.isArray(node.value)) return node.value.join(''); // StringChunk
  return '';
}

function captureHistoryWhere(): { where: () => string } {
  let captured = '';
  mockDb.select.mockImplementation(() => ({
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: (cond: unknown) => {
            captured = renderSql(cond);
            return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
          },
        }),
      }),
    }),
  }));
  return { where: () => captured };
}

describe('get_playbook_history — exact-device axis (finding 7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller (site + device axes) narrows history to its own device', async () => {
    const cap = captureHistoryWhere();
    await handlerFor('get_playbook_history')(
      {},
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    expect(cap.where()).toMatch(/device_id in \(?"dev-1"/);
    expect(cap.where()).not.toContain('dev-2');
  });

  it('device-LESS analysis shape (no site axis) still narrows history to its own device', async () => {
    const cap = captureHistoryWhere();
    await handlerFor('get_playbook_history')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(cap.where()).toMatch(/device_id in \(?"dev-1"/);
  });

  it('device-bound caller still sees its own device when it asks for it', async () => {
    let captured = '';
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: (cond: unknown) => {
              captured = renderSql(cond);
              return {
                orderBy: () => ({
                  limit: () => Promise.resolve([{ id: 'x1', status: 'completed' }]),
                }),
              };
            },
          }),
        }),
      }),
    }));
    const raw = await handlerFor('get_playbook_history')(
      { deviceId: 'dev-1' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.count).toBe(1);
    expect(captured).toMatch(/device_id in \(?"dev-1"/);
  });

  it('empty device allowlist returns nothing with a scope note', async () => {
    const cap = captureHistoryWhere();
    const raw = await handlerFor('get_playbook_history')({}, makeAuth({ allowedDeviceIds: [] }));
    const parsed = JSON.parse(raw);
    expect(parsed.executions).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.scopeNote).toBeTruthy();
    expect(cap.where()).toBe('');
  });

  it('unrestricted caller is not narrowed at all', async () => {
    const cap = captureHistoryWhere();
    await handlerFor('get_playbook_history')({}, makeAuth({}));
    expect(cap.where()).toBe('');
  });
});
