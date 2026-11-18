/**
 * Integration — the Audit Trail user filter matches the actor by identity (#9671).
 *
 * Device-command dispatch rows (`agent.command.*`, written by
 * services/commandQueue.ts) carry `actor_id` = the technician but no
 * `actor_email`. The viewer used to filter a picked user by email text, so a
 * technician's script runs dropped out of "what did this person do?" and out of
 * the CSV export. `?userId=` now matches `audit_logs.actor_id`.
 *
 * Proven here against real Postgres as `breeze_app` with real JWTs:
 *   - list (standard path and the skipCount fast-path request shape), search
 *     and the CSV export return the user's request row AND their email-less
 *     command row, and nobody else's rows;
 *   - the filter only narrows: the same actor's row in an org the caller cannot
 *     access never appears, and the other org's caller sees only its own row;
 *   - the free-text `?user=<email>` also finds the command row through the
 *     users join.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { auditLogs } from '../../db/schema';
import { auditLogRoutes } from '../../routes/auditLogs';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const app = new Hono().route('/audit-logs', auditLogRoutes);

async function mintAdmin(scope: 'organization' | 'partner', partnerId: string, orgId: string) {
  const user = await createUser({
    partnerId,
    orgId: scope === 'organization' ? orgId : null,
    email: `audit-9671-admin-${randomUUID()}@example.com`,
  });
  const role = await createRole({
    scope,
    partnerId: scope === 'partner' ? partnerId : undefined,
    orgId: scope === 'organization' ? orgId : undefined,
  });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  if (scope === 'partner') await assignUserToPartner(user.id, partnerId, role.id, 'all');
  else await assignUserToOrganization(user.id, orgId, role.id);
  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: scope === 'organization' ? orgId : null,
    partnerId,
    scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  return (path: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function seedRow(values: {
  orgId: string;
  actorId: string;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceName: string;
}) {
  const [row] = await getTestDb()
    .insert(auditLogs)
    .values({
      orgId: values.orgId,
      actorType: 'user',
      actorId: values.actorId,
      actorEmail: values.actorEmail,
      action: values.action,
      resourceType: values.resourceType,
      resourceId: randomUUID(),
      resourceName: values.resourceName,
      // The command writer's dispatch-time result (#4225).
      result: values.action.startsWith('agent.command.') ? 'dispatched' : 'success',
    })
    .returning({ id: auditLogs.id });
  return row!.id;
}

/**
 * Partner P owns org A. A technician (partner-level user) acts in org A and in
 * org B (another partner). Org A also has another technician's command row.
 */
async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const tag = randomUUID().slice(0, 8);
  const tech = await createUser({
    partnerId: partnerA.id,
    orgId: null,
    email: `audit-9671-tech-${tag}@example.com`,
    name: `Tech ${tag}`,
  });
  const other = await createUser({
    partnerId: partnerA.id,
    orgId: null,
    email: `audit-9671-other-${tag}@example.com`,
    name: `Other ${tag}`,
  });
  const ids = {
    // The request-level row: carries the actor email.
    techRequest: await seedRow({
      orgId: orgA.id, actorId: tech.id, actorEmail: tech.email,
      action: 'script.execute', resourceType: 'script', resourceName: `script-${tag}`,
    }),
    // The device-level command row, shaped like commandQueue.ts writes it: no actor email.
    techCommand: await seedRow({
      orgId: orgA.id, actorId: tech.id, actorEmail: null,
      action: 'agent.command.script', resourceType: 'device', resourceName: `host-${tag}`,
    }),
    otherCommand: await seedRow({
      orgId: orgA.id, actorId: other.id, actorEmail: null,
      action: 'agent.command.script', resourceType: 'device', resourceName: `host-${tag}`,
    }),
    // Same actor, an org the org-A caller cannot access.
    techCommandOrgB: await seedRow({
      orgId: orgB.id, actorId: tech.id, actorEmail: null,
      action: 'agent.command.script', resourceType: 'device', resourceName: `host-b-${tag}`,
    }),
  };
  return { partnerA, partnerB, orgA, orgB, tech, ids };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function windowQuery(): string {
  const now = Date.now();
  const from = new Date(now - 10 * 60_000).toISOString();
  const to = new Date(now + 10 * 60_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

function csvIds(body: string): string[] {
  return body.split('\n').slice(1).map((line) => line.split(',')[0]!.replace(/"/g, '')).filter(Boolean);
}

/** The fixture rows a response shows (other suites' rows are ignored). */
function fixtureRowsSeen(seen: string[], f: Fixture): Array<keyof Fixture['ids']> {
  return (Object.keys(f.ids) as Array<keyof Fixture['ids']>).filter((k) => seen.includes(f.ids[k]));
}

async function entryIds(res: Response, key: 'entries' | 'data'): Promise<string[]> {
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body[key] as Array<{ id: string }>).map((e) => e.id);
}

describe('Audit Trail user filter by identity (#9671)', () => {
  it('?userId= returns the user\'s request AND email-less command rows, in the caller\'s org only', async () => {
    const f = await fixture();
    const get = await mintAdmin('organization', f.partnerA.id, f.orgA.id);
    const expected: Array<keyof Fixture['ids']> = ['techRequest', 'techCommand'];

    // Control: unfiltered, the caller sees all three org-A rows, so the
    // assertions below are a real narrowing.
    const all = await entryIds(await get(`/audit-logs?limit=100&${windowQuery()}`), 'entries');
    expect(fixtureRowsSeen(all, f)).toEqual(['techRequest', 'techCommand', 'otherCommand']);

    // GET / — standard path (the viewer's list request).
    const list = await entryIds(await get(`/audit-logs?limit=100&userId=${f.tech.id}&${windowQuery()}`), 'entries');
    expect(fixtureRowsSeen(list, f)).toEqual(expected);

    // GET /logs?skipCount=true with no other filter — the request shape that
    // would take the unfiltered LATERAL fast path if userId were not a filter.
    const fast = await entryIds(await get(`/audit-logs/logs?limit=100&skipCount=true&userId=${f.tech.id}`), 'data');
    expect(fixtureRowsSeen(fast, f)).toEqual(expected);

    // GET /search with the user picked.
    const search = await entryIds(
      await get(`/audit-logs/search?limit=100&q=${encodeURIComponent('host-')}&userId=${f.tech.id}`),
      'data',
    );
    expect(fixtureRowsSeen(search, f)).toEqual(['techCommand']);

    // GET /export (CSV) — same rows as the list.
    const csv = await get(`/audit-logs/export?columns=id,action&userId=${f.tech.id}&${windowQuery()}`);
    expect(csv.status).toBe(200);
    expect(fixtureRowsSeen(csvIds(await csv.text()), f)).toEqual(expected);
  });

  it('never widens scope: the other org\'s caller sees only its own row for the same actor', async () => {
    const f = await fixture();
    const getB = await mintAdmin('organization', f.partnerB.id, f.orgB.id);
    const list = await entryIds(await getB(`/audit-logs?limit=100&userId=${f.tech.id}`), 'entries');
    expect(fixtureRowsSeen(list, f)).toEqual(['techCommandOrgB']);

    // A caller cannot reach another org's rows by pinning it either.
    const getA = await mintAdmin('organization', f.partnerA.id, f.orgA.id);
    expect((await getA(`/audit-logs?limit=100&userId=${f.tech.id}&orgId=${f.orgB.id}`)).status).toBe(403);
    expect((await getA(`/audit-logs/export?userId=${f.tech.id}&orgId=${f.orgB.id}`)).status).toBe(403);
  });

  it('rejects a non-uuid userId rather than text-matching it', async () => {
    const f = await fixture();
    const get = await mintAdmin('organization', f.partnerA.id, f.orgA.id);
    expect((await get(`/audit-logs?userId=${encodeURIComponent(f.tech.email)}`)).status).toBe(400);
  });

  it('free-text ?user=<email> also finds the email-less command row through the users join (partner caller)', async () => {
    const f = await fixture();
    const get = await mintAdmin('partner', f.partnerA.id, f.orgA.id);
    const q = `/audit-logs?limit=100&user=${encodeURIComponent(f.tech.email)}&${windowQuery()}`;
    expect(fixtureRowsSeen(await entryIds(await get(q), 'entries'), f)).toEqual(['techRequest', 'techCommand']);
    // The partner caller's identity filter gives the same rows.
    const byId = await entryIds(await get(`/audit-logs?limit=100&userId=${f.tech.id}&${windowQuery()}`), 'entries');
    expect(fixtureRowsSeen(byId, f)).toEqual(['techRequest', 'techCommand']);
  });

  it('the users join does not widen an org caller\'s view: MSP staff stay invisible to text match, userId still works', async () => {
    // users RLS hides a partner-level user's row from an org-scope session, so
    // the email text cannot resolve through the join there; only the stored
    // actor_email matches. This is why the viewer's picker sends userId.
    const f = await fixture();
    const get = await mintAdmin('organization', f.partnerA.id, f.orgA.id);
    const text = await entryIds(
      await get(`/audit-logs?limit=100&user=${encodeURIComponent(f.tech.email)}&${windowQuery()}`),
      'entries',
    );
    expect(fixtureRowsSeen(text, f)).toEqual(['techRequest']);
    const byId = await entryIds(await get(`/audit-logs?limit=100&userId=${f.tech.id}&${windowQuery()}`), 'entries');
    expect(fixtureRowsSeen(byId, f)).toEqual(['techRequest', 'techCommand']);
  });
});
