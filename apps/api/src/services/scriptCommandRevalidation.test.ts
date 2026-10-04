import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ getUserPermissions: vi.fn() }));
vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: m.getUserPermissions };
});

import { revalidateScriptCommandAuthority, toRequesterPermissions } from './scriptCommandRevalidation';

const deviceId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const orgId = '00000000-0000-4000-8000-000000000003';
const siteId = '00000000-0000-4000-8000-000000000004';
const row = { id: 'cmd-1', type: 'script', deviceId, payload: null, createdBy: userId };
const EXECUTE = { resource: 'scripts', action: 'execute' };
const dialect = new PgDialect();

type Authority = Record<string, unknown> | null;

/**
 * `select` serves the device row; the requester's authority comes ONLY from the
 * savepointed SECURITY DEFINER resolver call (`transaction` → `execute`). The
 * reader records every resolver query so a case can assert what was asked.
 */
function readerFor(device: { orgId: string; siteId: string } | undefined, authority: Authority | (() => never)) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const reader = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (device ? [device] : []),
        }),
      }),
    }),
    execute: () => {
      throw new Error('the resolver must run inside a savepoint');
    },
    transaction: async (fn: (sp: unknown) => Promise<unknown>) =>
      fn({
        execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
          const compiled = dialect.sqlToQuery(q);
          queries.push(compiled.sql);
          params.push(compiled.params);
          if (typeof authority === 'function') authority();
          return [{ authority }];
        },
      }),
  };
  return { reader: reader as never, queries, params };
}

const orgAuthority = (over: Record<string, unknown> = {}) => ({
  scope: 'organization',
  roleId: 'r',
  orgAccess: null,
  allowedOrgIds: null,
  allowedSiteIds: null,
  permissions: [EXECUTE],
  ...over,
});
const partnerAuthority = (over: Record<string, unknown> = {}) => ({
  scope: 'partner',
  roleId: 'r',
  orgAccess: 'all',
  allowedOrgIds: null,
  allowedSiteIds: null,
  permissions: [EXECUTE],
  ...over,
});

describe('revalidateScriptCommandAuthority', () => {
  it('does not revalidate a row with no requester identity (system/automation-issued)', async () => {
    const reader = { select: () => { throw new Error('must not read'); } } as never;
    await expect(revalidateScriptCommandAuthority(reader, { ...row, createdBy: null })).resolves.toBeNull();
  });

  it('resolves authority through the SQL resolver keyed on the requester and the DEVICE org — never getUserPermissions', async () => {
    const { reader, queries, params } = readerFor({ orgId, siteId }, partnerAuthority());
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('public.breeze_command_requester_authority(');
    expect(params[0]).toEqual([userId, orgId]);
    expect(m.getUserPermissions).not.toHaveBeenCalled();
  });

  it('delivers for a partner-level technician holding scripts:execute with access to the org', async () => {
    const { reader } = readerFor({ orgId, siteId }, partnerAuthority({ orgAccess: 'selected', allowedOrgIds: [orgId] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBeNull();
  });

  it('honours a wildcard grant', async () => {
    const { reader } = readerFor({ orgId, siteId }, orgAuthority({ permissions: [{ resource: '*', action: '*' }] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBeNull();
  });

  it('cancels when the requester no longer holds scripts:execute for the device org', async () => {
    const { reader } = readerFor({ orgId, siteId }, orgAuthority({ permissions: [{ resource: 'devices', action: 'read' }] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('cancels when a partner technician\'s org access no longer covers the device org', async () => {
    for (const over of [{ orgAccess: 'none' }, { orgAccess: 'selected', allowedOrgIds: ['other-org'] }, { orgAccess: 'selected', allowedOrgIds: null }]) {
      const { reader } = readerFor({ orgId, siteId }, partnerAuthority(over));
      await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
    }
  });

  it('cancels when the device site is outside the requester\'s restricted site allowlist', async () => {
    const { reader } = readerFor({ orgId, siteId }, orgAuthority({ allowedSiteIds: ['other-site'] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('an empty site allowlist restricts to nothing, not everything', async () => {
    const { reader } = readerFor({ orgId, siteId }, orgAuthority({ allowedSiteIds: [] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBe('scope_changed');
  });

  it('allows delivery when the requester still holds authority for the device', async () => {
    const { reader } = readerFor({ orgId, siteId }, orgAuthority({ allowedSiteIds: [siteId] }));
    await expect(revalidateScriptCommandAuthority(reader, row)).resolves.toBeNull();
  });

  it('fails closed when the device row is gone or the resolver finds no membership', async () => {
    expect(await revalidateScriptCommandAuthority(readerFor(undefined, orgAuthority()).reader, row)).toBe('scope_changed');
    expect(await revalidateScriptCommandAuthority(readerFor({ orgId, siteId }, null).reader, row)).toBe('scope_changed');
  });

  it('propagates a resolver fault so the claim can HOLD the row (never a silent cancel or delivery)', async () => {
    const { reader } = readerFor({ orgId, siteId }, () => { throw new Error('function does not exist'); });
    await expect(revalidateScriptCommandAuthority(reader, row)).rejects.toThrow('function does not exist');
  });
});

describe('toRequesterPermissions', () => {
  it('maps an org-axis answer', () => {
    expect(toRequesterPermissions(orgAuthority({ allowedSiteIds: [siteId] }), orgId)).toEqual({
      permissions: [EXECUTE], partnerId: null, orgId, roleId: 'r', scope: 'organization', allowedSiteIds: [siteId],
    });
  });

  it('maps a partner-axis answer, null lists to undefined', () => {
    expect(toRequesterPermissions(partnerAuthority(), orgId)).toEqual({
      permissions: [EXECUTE], partnerId: null, orgId, roleId: 'r', scope: 'partner', orgAccess: 'all', allowedOrgIds: undefined,
    });
  });

  it('accepts a JSON string (driver returning jsonb unparsed)', () => {
    expect(toRequesterPermissions(JSON.stringify(orgAuthority()), orgId)?.scope).toBe('organization');
  });

  it('drops malformed grants rather than trusting them', () => {
    expect(toRequesterPermissions(orgAuthority({ permissions: [EXECUTE, { resource: 1 }, null] }), orgId)?.permissions).toEqual([EXECUTE]);
  });

  it('rejects anything unrecognised', () => {
    expect(toRequesterPermissions(null, orgId)).toBeNull();
    expect(toRequesterPermissions({}, orgId)).toBeNull();
    expect(toRequesterPermissions(orgAuthority({ scope: 'system' }), orgId)).toBeNull();
    expect(toRequesterPermissions(orgAuthority({ roleId: null }), orgId)).toBeNull();
    expect(toRequesterPermissions(orgAuthority({ permissions: null }), orgId)).toBeNull();
    expect(toRequesterPermissions(partnerAuthority({ orgAccess: 'some' }), orgId)).toBeNull();
  });
});
