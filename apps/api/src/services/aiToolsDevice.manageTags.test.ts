/**
 * #8297: `manage_tags` add bound the tag list as `${tagsInput}::text[]`, which
 * Drizzle spreads into `($1, $2)::text[]` — Postgres rejects that for every
 * list length ("malformed array literal" for one tag, "cannot cast type record
 * to text[]" for two or more). Each tag must be its own element of an ARRAY[].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiTools')>()),
  verifyDeviceAccess: vi.fn(async () => ({ device: { id: 'dev-1' } })),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { registerDeviceTools } from './aiToolsDevice';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
};
const dialect = new PgDialect();

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDeviceTools(reg);
  return reg.get(name)!.handler;
}

const auth = {
  principal: { kind: 'user_session' },
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
  accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
} as unknown as AuthContext;

describe('manage_tags add binds the tag list as a Postgres array (#8297)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue([]);
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ tags: ['a', 'x', 'y'] }]) }) }),
    });
  });

  it.each([
    [['owner-device']],
    [['owner-device', 'windows-workstation']],
    [['a', 'b', 'c']],
  ])('renders ARRAY[...]::text[] with one parameter per tag for %j', async (tags) => {
    const result = JSON.parse(String(await handlerFor('manage_tags')({ action: 'add', deviceId: 'dev-1', tags }, auth)));
    expect(result.success).toBe(true);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const q = dialect.sqlToQuery(mockDb.execute.mock.calls[0]![0]);
    const placeholders = tags.map((_, i) => `$${i + 1}`).join(', ');
    expect(q.sql).toContain(`array_cat(tags, ARRAY[${placeholders}]::text[])`);
    // The broken form: a parenthesised row list cast to an array.
    expect(q.sql).not.toMatch(/\(\$\d+(, \$\d+)*\)::text\[\]/);
    expect(q.params.slice(0, tags.length)).toEqual(tags);
    expect(q.params[tags.length]).toBe('dev-1');
  });
});
