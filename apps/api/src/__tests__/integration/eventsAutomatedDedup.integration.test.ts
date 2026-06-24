/**
 * Device events feed — includeAutomated dedup (issue: device-overview automated activity).
 *
 * What only a real Postgres can prove: the `includeAutomated` predicate surfaces
 * automated `agent.command.*` rows (actor_type 'system'/'agent') while EXCLUDING
 * the manual twin (actor_type 'user'). Manual command dispatches write both an
 * `agent.command.*` audit AND a richer route audit (e.g. `script.execute`,
 * `device.patch.*`); including the manual `agent.command.*` row would double-list
 * the same action. The guard is a `LIKE ... AND actor_type IN (...)` predicate a
 * Drizzle mock can't exercise — hence an integration test.
 *
 * Mirrors the predicate the route actually runs by importing buildActionConditions
 * from the route module, so a future edit that drops the actor_type guard fails here.
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { and, or, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getTestDb } from './setup';
import { auditLogs } from '../../db/schema';
import { buildActionConditions } from '../../routes/devices/events';
import { createPartner, createOrganization } from './db-utils';

// commandQueue writes automated dispatches with the all-zero sentinel actor id.
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

describe('device events — includeAutomated dedup (agent.command.* actor scoping)', () => {
  let orgId: string;
  let deviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    deviceId = randomUUID();

    // Three audit rows for one device: an automated patch install (system),
    // its manual twin (user), and a manual route audit matching `script.`.
    await getTestDb()
      .insert(auditLogs)
      .values([
        {
          orgId,
          actorType: 'system',
          actorId: SYSTEM_ACTOR,
          action: 'agent.command.install_patches',
          resourceType: 'device',
          resourceId: deviceId,
          result: 'success',
        },
        {
          orgId,
          actorType: 'user',
          actorId: randomUUID(),
          action: 'agent.command.install_patches',
          resourceType: 'device',
          resourceId: deviceId,
          result: 'success',
        },
        {
          orgId,
          actorType: 'user',
          actorId: randomUUID(),
          action: 'script.execute',
          resourceType: 'device',
          resourceId: deviceId,
          result: 'success',
        },
      ]);
  });

  async function fetchActionKeys(actions: string[], includeAutomated: boolean): Promise<string[]> {
    const clauses = buildActionConditions(actions, includeAutomated);
    const rows = await getTestDb()
      .select({ action: auditLogs.action, actorType: auditLogs.actorType })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, deviceId), or(...clauses)));
    return rows.map((r) => `${r.action}:${r.actorType}`).sort();
  }

  it('includes the system-actor agent.command.* row but excludes the manual (user) twin', async () => {
    const keys = await fetchActionKeys(['script.'], true);
    expect(keys).toEqual(['agent.command.install_patches:system', 'script.execute:user']);
    // The manual agent.command twin must never appear — its route-audit twin does.
    expect(keys).not.toContain('agent.command.install_patches:user');
  });

  it('omits all agent.command.* rows when includeAutomated is false', async () => {
    const keys = await fetchActionKeys(['script.'], false);
    expect(keys).toEqual(['script.execute:user']);
  });
});
