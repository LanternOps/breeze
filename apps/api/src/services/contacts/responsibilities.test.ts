import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { contactRoles } from '../../db/schema/contactRoles';
import { contacts } from '../../db/schema/contacts';
import { sites } from '../../db/schema/orgs';
import { deviceGroupMemberships, deviceGroups } from '../../db/schema/devices';
import type { ContactExecutor } from './compat';
import {
  syncLegacyContactRoles,
  addLegacyDerivedContactRoles,
  removeContactResponsibility,
  replaceContactResponsibilities,
  resolveContactResponsibility,
} from './responsibilities';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const PARENT = '55555555-5555-4555-8555-555555555555';
const DEVICE = '66666666-6666-4666-8666-666666666666';

const dialect = new PgDialect();
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as never);
  return { sql: query.sql, params: query.params };
}

type Row = Record<string, unknown>;
interface SelectCall { table: unknown; where?: unknown }
interface InsertCall { table: unknown; values: Row[]; onConflict: boolean }
interface DeleteCall { table: unknown; where?: unknown }
interface UpdateCall { table: unknown; values: Row; where?: unknown }

function makeExec(selectRows: Row[][] = []) {
  const queue = [...selectRows];
  const selects: SelectCall[] = [];
  const inserts: InsertCall[] = [];
  const deletes: DeleteCall[] = [];
  const updates: UpdateCall[] = [];

  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const call: SelectCall = { table };
        selects.push(call);
        const rows = queue.shift() ?? [];
        const settled = () => {
          const promise = Promise.resolve(rows) as Promise<Row[]> & { orderBy?: (...args: unknown[]) => Promise<Row[]>; limit?: (n: number) => Promise<Row[]>; for?: (m: string) => Promise<Row[]> };
          promise.orderBy = () => promise;
          promise.limit = () => promise;
          promise.for = () => promise;
          return promise;
        };
        return {
          where: (condition: unknown) => {
            call.where = condition;
            const promise = settled();
            return Object.assign(promise, { orderBy: () => promise, limit: () => promise });
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const call: InsertCall = { table, values: Array.isArray(values) ? values : [values], onConflict: false };
        inserts.push(call);
        return {
          onConflictDoNothing: async () => { call.onConflict = true; },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => { deletes.push({ table, where: condition }); },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async (condition: unknown) => { updates.push({ table, values, where: condition }); },
      }),
    }),
  } as unknown as ContactExecutor;

  return { exec, selects, inserts, deletes, updates };
}

function assignment(input: Partial<{
  id: string;
  contactId: string;
  orgId: string;
  role: string;
  isPrimary: boolean;
  siteId: string | null;
  deviceGroupId: string | null;
}> = {}) {
  return {
    id: input.id ?? '77777777-7777-4777-8777-777777777777',
    contactId: input.contactId ?? CONTACT,
    orgId: input.orgId ?? ORG,
    role: input.role ?? 'technical',
    isPrimary: input.isPrimary ?? false,
    siteId: input.siteId ?? null,
    deviceGroupId: input.deviceGroupId ?? null,
  };
}

describe('syncLegacyContactRoles', () => {
  const sync = (f: ReturnType<typeof makeExec>, siteId: string | null, roles: string[], previousSiteId?: string | null) =>
    syncLegacyContactRoles(f.exec, { contactId: CONTACT, orgId: ORG, siteId, previousSiteId, roles });

  it('create: adds each distinct role at Organization scope for an unpinned contact', async () => {
    const f = makeExec([[]]);
    await sync(f, null, ['admin', 'billing', 'admin']);

    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'billing', isPrimary: false, siteId: null, deviceGroupId: null },
      { contactId: CONTACT, orgId: ORG, role: 'admin', isPrimary: false, siteId: null, deviceGroupId: null },
    ]);
    expect(f.updates.at(-1)!.table).toBe(contacts);
    expect(f.updates.at(-1)!.values.roles).toEqual(['billing', 'admin']);
  });

  it('create with a site pin derives Site scope, never Organization', async () => {
    const f = makeExec([[]]);
    await sync(f, SITE, ['admin', 'technical']);
    expect(f.inserts[0]!.values.every((v) => v.siteId === SITE && v.deviceGroupId === null)).toBe(true);
    expect(f.inserts[0]!.values.map((v) => v.role).sort()).toEqual(['admin', 'technical']);
  });

  it('adds only the missing role and preserves assignments at other scopes', async () => {
    const f = makeExec([[{ role: 'technical', siteId: null, deviceGroupId: null, isPrimary: false }]]);
    await sync(f, null, ['technical', 'billing']);

    expect(f.deletes).toHaveLength(0);
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'billing', isPrimary: false, siteId: null, deviceGroupId: null },
    ]);
    expect(f.updates.at(-1)!.values.roles).toEqual(['billing', 'technical']);
  });

  it('removes every assignment of a dropped role, at any scope, and nothing else', async () => {
    const f = makeExec([[
      { role: 'technical', siteId: null, deviceGroupId: null, isPrimary: false },
      { role: 'technical', siteId: null, deviceGroupId: null, isPrimary: false },
      { role: 'admin', siteId: null, deviceGroupId: null, isPrimary: false },
    ]]);
    await sync(f, null, ['admin']);

    expect(f.inserts).toHaveLength(0);
    expect(f.deletes).toHaveLength(1);
    expect(f.deletes[0]!.table).toBe(contactRoles);
    expect(compile(f.deletes[0]!.where).params).toEqual([CONTACT, ORG, 'technical']);
    expect(f.updates.at(-1)!.values.roles).toEqual(['admin']);
  });

  it('is a complete no-op (no delete, insert or update) when roles are unchanged and already scoped to the pinned Site', async () => {
    const f = makeExec([[{ role: 'admin', siteId: SITE, deviceGroupId: null, isPrimary: false }]]);
    await sync(f, SITE, ['admin']);
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('is a complete no-op when nothing changes even if Device Group and other-Site rows exist', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    const f = makeExec([[
      { role: 'technical', siteId: null, deviceGroupId: GROUP, isPrimary: false },
      { role: 'admin', siteId: OTHER, deviceGroupId: null, isPrimary: true },
    ]]);
    await expect(sync(f, SITE, ['technical', 'admin'])).resolves.toBeUndefined();
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('fails closed when a role is added and a Device Group row exists, writing nothing', async () => {
    const f = makeExec([[
      { role: 'technical', siteId: null, deviceGroupId: GROUP, isPrimary: false },
    ]]);
    await expect(sync(f, null, ['technical', 'billing'])).rejects.toMatchObject({
      code: 'legacy-write-cannot-represent-scoped-responsibilities',
    });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('fails closed when a Device Group row exists and a role would be removed', async () => {
    const f = makeExec([[
      { role: 'technical', siteId: null, deviceGroupId: null, isPrimary: false },
      { role: 'admin', siteId: null, deviceGroupId: GROUP, isPrimary: false },
    ]]);
    await expect(sync(f, null, ['technical'])).rejects.toMatchObject({
      code: 'legacy-write-cannot-represent-scoped-responsibilities',
    });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('fails closed when a Site row differs from the pre-write pin, writing nothing', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    const f = makeExec([[
      { role: 'technical', siteId: SITE, deviceGroupId: null, isPrimary: false },
      { role: 'admin', siteId: OTHER, deviceGroupId: null, isPrimary: false },
    ]]);
    // Pre-write pin defaults to SITE; the admin row at OTHER is not representable.
    await expect(sync(f, SITE, ['technical'])).rejects.toMatchObject({
      code: 'legacy-write-cannot-represent-scoped-responsibilities',
      status: 400,
    });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('fails closed on a re-pin that changes roles when a row sits at neither the old pin nor Organization-derived scope', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    const f = makeExec([[{ role: 'admin', siteId: OTHER, deviceGroupId: null, isPrimary: false }]]);
    // Contact was unpinned (previousSiteId null) but holds an admin row at OTHER.
    await expect(sync(f, SITE, ['admin', 'technical'], null)).rejects.toMatchObject({
      code: 'legacy-write-cannot-represent-scoped-responsibilities',
    });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('re-pin with an unchanged role set is a no-op: contact_roles untouched, no throw, even off-pin or Device Group rows', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    const f = makeExec([[
      { role: 'admin', siteId: null, deviceGroupId: null, isPrimary: true },
      { role: 'technical', siteId: OTHER, deviceGroupId: null, isPrimary: false },
      { role: 'billing', siteId: null, deviceGroupId: GROUP, isPrimary: false },
    ]]);
    await expect(sync(f, SITE, ['admin', 'technical', 'billing'], null)).resolves.toBeUndefined();
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('re-pin with changed roles: moves an Organization-scoped kept role to the pinned Site and keeps its primacy', async () => {
    const f = makeExec([[{ role: 'admin', siteId: null, deviceGroupId: null, isPrimary: true }]]);
    await sync(f, SITE, ['admin', 'technical'], null);
    expect(f.deletes).toHaveLength(1);
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'technical', isPrimary: false, siteId: SITE, deviceGroupId: null },
      { contactId: CONTACT, orgId: ORG, role: 'admin', isPrimary: true, siteId: SITE, deviceGroupId: null },
    ]);
    expect(f.updates.at(-1)!.values.roles).toEqual(['technical', 'admin']);
  });

  it('re-pin with changed roles: moves every kept role held at the previous Site to the new Site and keeps primacy', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    const f = makeExec([[
      { role: 'admin', siteId: OTHER, deviceGroupId: null, isPrimary: true },
      { role: 'technical', siteId: OTHER, deviceGroupId: null, isPrimary: false },
    ]]);
    await sync(f, SITE, ['admin', 'technical', 'billing'], OTHER);
    expect(f.inserts[0]!.values.map((v) => [v.role, v.siteId, v.isPrimary])).toEqual([
      ['billing', SITE, false],
      ['admin', SITE, true],
      ['technical', SITE, false],
    ]);
    const where = compile(f.deletes.at(-1)!.where);
    expect(where.sql).toMatch(/"device_group_id" is null/);
    expect(where.params).toEqual(expect.arrayContaining([SITE]));
  });

  it('un-pin with an unchanged role set is a no-op: roles stay at the Site, nothing broadens, no throw', async () => {
    const f = makeExec([[
      { role: 'billing', siteId: SITE, deviceGroupId: null, isPrimary: true },
      { role: 'technical', siteId: null, deviceGroupId: GROUP, isPrimary: false },
    ]]);
    await expect(sync(f, null, ['billing', 'technical'], SITE)).resolves.toBeUndefined();
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('un-pin with changed roles: moves kept roles at the previous Site back to Organization and keeps their primacy', async () => {
    const f = makeExec([[{ role: 'billing', siteId: SITE, deviceGroupId: null, isPrimary: true }]]);
    await sync(f, null, ['billing', 'technical'], SITE);
    expect(f.deletes).toHaveLength(1);
    const where = compile(f.deletes[0]!.where);
    expect(where.sql).toMatch(/"device_group_id" is null/);
    expect(where.params).toEqual(expect.arrayContaining([CONTACT, ORG, 'billing', SITE]));
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'technical', isPrimary: false, siteId: null, deviceGroupId: null },
      { contactId: CONTACT, orgId: ORG, role: 'billing', isPrimary: true, siteId: null, deviceGroupId: null },
    ]);
    expect(f.updates.at(-1)!.values.roles).toEqual(['billing', 'technical']);
  });

  it('un-pin with changed roles: widens every kept role held at the previous Site to Organization', async () => {
    const f = makeExec([[
      { role: 'technical', siteId: SITE, deviceGroupId: null, isPrimary: false },
      { role: 'billing', siteId: SITE, deviceGroupId: null, isPrimary: false },
    ]]);
    await sync(f, null, ['technical', 'billing', 'admin'], SITE);
    expect(f.inserts[0]!.values.map((v) => [v.role, v.siteId])).toEqual([['admin', null], ['technical', null], ['billing', null]]);
    expect(compile(f.deletes.at(-1)!.where).params).toEqual(expect.arrayContaining([SITE]));
  });

  it('un-pin that changes roles fails closed rather than touching a Device Group row', async () => {
    const f = makeExec([[
      { role: 'technical', siteId: null, deviceGroupId: GROUP, isPrimary: false },
      { role: 'billing', siteId: SITE, deviceGroupId: null, isPrimary: false },
    ]]);
    await expect(sync(f, null, ['technical', 'billing', 'admin'], SITE)).rejects.toMatchObject({
      code: 'legacy-write-cannot-represent-scoped-responsibilities',
    });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
  });

  it('un-pin without a previous Site does not touch Site-scoped assignments', async () => {
    const f = makeExec([[{ role: 'admin', siteId: SITE, deviceGroupId: null, isPrimary: false }]]);
    await sync(f, null, ['admin']);
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('passes an out-of-vocabulary role through so the role CHECK refuses it, instead of dropping it', async () => {
    const f = makeExec([[]]);
    await sync(f, null, ['admin', 'not-a-role']);
    expect(f.inserts[0]!.values.map((v) => v.role)).toEqual(['admin', 'not-a-role']);
  });

  it('clearing all roles deletes all assignments and projects an empty list', async () => {
    const f = makeExec([[{ role: 'admin', siteId: null, deviceGroupId: null, isPrimary: false }]]);
    await sync(f, null, []);
    expect(f.deletes).toHaveLength(1);
    expect(f.inserts).toHaveLength(0);
    expect(f.updates.at(-1)!.values.roles).toEqual([]);
  });
});

describe('addLegacyDerivedContactRoles', () => {
  // select 1: contact pin (with .for('no key update')); select 2: held roles for re-projection.
  function makeAddExec(pin: string | null, held: Row[]) {
    const f = makeExec([[{ siteId: pin }], held]);
    return f;
  }

  it('inserts at Organization scope for an unpinned contact, additively, never deleting', async () => {
    const f = makeAddExec(null, [{ role: 'portal' }, { role: 'admin' }]);
    await addLegacyDerivedContactRoles(f.exec, { contactId: CONTACT, orgId: ORG, roles: ['portal', 'portal'] });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0]!.onConflict).toBe(true);
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'portal', isPrimary: false, siteId: null, deviceGroupId: null },
    ]);
  });

  it('inserts at Site scope for a pinned contact', async () => {
    const f = makeAddExec(SITE, [{ role: 'portal' }]);
    await addLegacyDerivedContactRoles(f.exec, { contactId: CONTACT, orgId: ORG, roles: ['portal'] });
    expect(f.deletes).toHaveLength(0);
    expect(f.inserts[0]!.values).toEqual([
      { contactId: CONTACT, orgId: ORG, role: 'portal', isPrimary: false, siteId: SITE, deviceGroupId: null },
    ]);
  });

  it('re-projects contacts.roles[] from the resulting canonical set, in vocabulary order', async () => {
    const f = makeAddExec(null, [{ role: 'technical' }, { role: 'billing' }, { role: 'technical' }]);
    await addLegacyDerivedContactRoles(f.exec, { contactId: CONTACT, orgId: ORG, roles: ['billing'] });
    expect(f.updates.at(-1)!.table).toBe(contacts);
    expect(f.updates.at(-1)!.values.roles).toEqual(['billing', 'technical']);
  });

  it('refuses a contact outside the organization before writing', async () => {
    const f = makeExec([[]]);
    await expect(addLegacyDerivedContactRoles(f.exec, { contactId: CONTACT, orgId: ORG, roles: ['portal'] }))
      .rejects.toMatchObject({ code: 'contact-not-in-org' });
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });
});

describe('removeContactResponsibility', () => {
  it('deletes exactly one assignment (role + scope) and re-projects roles[]', async () => {
    const f = makeExec([[{ id: CONTACT }], [{ role: 'technical' }]]);
    await removeContactResponsibility(f.exec, {
      contactId: CONTACT, orgId: ORG, role: 'billing', scope: { type: 'organization' },
    });
    expect(f.deletes).toHaveLength(1);
    expect(f.deletes[0]!.table).toBe(contactRoles);
    const where = compile(f.deletes[0]!.where);
    expect(where.params).toEqual([CONTACT, ORG, 'billing']);
    expect(where.sql).toMatch(/"site_id" is null/);
    expect(where.sql).toMatch(/"device_group_id" is null/);
    expect(f.updates.at(-1)!.values.roles).toEqual(['technical']);
  });

  it('targets the exact Site when the scope is a Site', async () => {
    const f = makeExec([[{ id: CONTACT }], []]);
    await removeContactResponsibility(f.exec, {
      contactId: CONTACT, orgId: ORG, role: 'admin', scope: { type: 'site', siteId: SITE },
    });
    expect(compile(f.deletes[0]!.where).params).toEqual([CONTACT, ORG, 'admin', SITE]);
    expect(f.updates.at(-1)!.values.roles).toEqual([]);
  });

  it('refuses a contact outside the organization before deleting', async () => {
    const f = makeExec([[]]);
    await expect(removeContactResponsibility(f.exec, {
      contactId: CONTACT, orgId: ORG, role: 'billing', scope: { type: 'organization' },
    })).rejects.toMatchObject({ code: 'contact-not-in-org' });
    expect(f.deletes).toHaveLength(0);
  });
});

describe('replaceContactResponsibilities', () => {
  it('writes the canonical whole set and projects distinct legacy roles deterministically', async () => {
    const f = makeExec([[{ id: CONTACT }], [{ id: SITE }]]);
    await replaceContactResponsibilities(f.exec, {
      contactId: CONTACT, orgId: ORG, responsibilities: [
        { role: 'technical', scope: { type: 'organization' } },
        { role: 'technical', scope: { type: 'site', siteId: SITE } },
        { role: 'billing', scope: { type: 'organization' } },
      ],
    });
    expect(f.inserts[0]!.values).toHaveLength(3);
    expect(f.updates.at(-1)!.values.roles).toEqual(['billing', 'technical']);
  });

  it('keeps a projected role while any scoped assignment remains and removes it with the last one', async () => {
    const first = makeExec([[{ id: CONTACT }], [{ id: SITE }]]);
    await replaceContactResponsibilities(first.exec, {
      contactId: CONTACT, orgId: ORG, responsibilities: [
        { role: 'technical', scope: { type: 'site', siteId: SITE } },
      ],
    });
    expect(first.updates.at(-1)!.values.roles).toEqual(['technical']);

    const last = makeExec([[{ id: CONTACT }]]);
    await replaceContactResponsibilities(last.exec, { contactId: CONTACT, orgId: ORG, responsibilities: [] });
    expect(last.updates.at(-1)!.values.roles).toEqual([]);
  });

  it('rejects a Site that is not in the contact organization', async () => {
    const f = makeExec([[{ id: CONTACT }], []]);
    await expect(replaceContactResponsibilities(f.exec, {
      contactId: CONTACT, orgId: ORG, responsibilities: [
        { role: 'technical', scope: { type: 'site', siteId: SITE } },
      ],
    })).rejects.toMatchObject({ code: 'site-not-in-org' });
    expect(f.deletes).toHaveLength(0);
  });

  it('characterization: rejects a Device Group outside the contact organization with 400 before writes', async () => {
    const f = makeExec([[{ id: CONTACT }], []]);
    await expect(replaceContactResponsibilities(f.exec, {
      contactId: CONTACT, orgId: ORG, responsibilities: [
        { role: 'technical', scope: { type: 'device_group', deviceGroupId: GROUP } },
      ],
    })).rejects.toMatchObject({ code: 'device-group-not-in-org', status: 400 });
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
    expect(f.deletes).toHaveLength(0);
  });

  it('rejects an exact duplicate before writing', async () => {
    const f = makeExec([[{ id: CONTACT }]]);
    await expect(replaceContactResponsibilities(f.exec, {
      contactId: CONTACT, orgId: ORG, responsibilities: [
        { role: 'admin', scope: { type: 'organization' } },
        { role: 'admin', scope: { type: 'organization' } },
      ],
    })).rejects.toMatchObject({ code: 'duplicate-assignment' });
    expect(f.deletes).toHaveLength(0);
  });
});

describe('resolveContactResponsibility', () => {
  it('stops at direct Device Group matches before Site and Organization', async () => {
    const direct = assignment({ deviceGroupId: GROUP });
    const f = makeExec([[direct]]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', siteId: SITE, deviceGroupIds: [GROUP],
    });
    expect(result).toEqual({ level: 'device_group', assignments: [direct] });
    expect(f.selects.map((s) => s.table)).toEqual([contactRoles]);
  });

  it('uses the nearest matching ancestor when a direct group has no assignment', async () => {
    const inherited = assignment({ deviceGroupId: PARENT });
    const f = makeExec([
      [],
      [{ id: GROUP, parentId: PARENT }],
      [inherited],
    ]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', deviceGroupIds: [GROUP],
    });
    expect(result).toEqual({ level: 'device_group', assignments: [inherited] });
    expect(f.selects.map((s) => s.table)).toEqual([contactRoles, deviceGroups, contactRoles]);
  });

  it('falls back from groups to Site, then stops before Organization', async () => {
    const siteAssignment = assignment({ siteId: SITE });
    const f = makeExec([
      [],
      [{ id: GROUP, parentId: null }],
      [siteAssignment],
    ]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', siteId: SITE, deviceGroupIds: [GROUP],
    });
    expect(result).toEqual({ level: 'site', assignments: [siteAssignment] });
    expect(f.selects.map((s) => s.table)).toEqual([contactRoles, deviceGroups, contactRoles]);
  });

  it('falls back to Organization when no more-specific assignment exists', async () => {
    const orgAssignment = assignment();
    const f = makeExec([[], [orgAssignment]]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', siteId: SITE,
    });
    expect(result).toEqual({ level: 'organization', assignments: [orgAssignment] });
    expect(f.selects.map((s) => s.table)).toEqual([contactRoles, contactRoles]);
  });

  it('deduplicates a contact reached through multiple same-level group assignments deterministically', async () => {
    const otherGroup = '88888888-8888-4888-8888-888888888888';
    const later = assignment({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', deviceGroupId: GROUP });
    const earlier = assignment({ id: '00000000-0000-4000-8000-000000000001', deviceGroupId: otherGroup });
    const f = makeExec([[later, earlier]]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', deviceGroupIds: [GROUP, otherGroup],
    });
    expect(result.level).toBe('device_group');
    expect(result.assignments).toEqual([earlier]);
  });

  it('reads current device memberships when a deviceId is supplied', async () => {
    const direct = assignment({ deviceGroupId: GROUP });
    const f = makeExec([
      [{ groupId: GROUP }],
      [direct],
    ]);
    const result = await resolveContactResponsibility(f.exec, {
      orgId: ORG, role: 'technical', deviceId: DEVICE,
    });
    expect(result).toEqual({ level: 'device_group', assignments: [direct] });
    expect(f.selects.map((s) => s.table)).toEqual([deviceGroupMemberships, contactRoles]);
    const membershipWhere = compile(f.selects[0]!.where);
    expect(membershipWhere.params).toEqual([ORG, DEVICE]);
  });
});
