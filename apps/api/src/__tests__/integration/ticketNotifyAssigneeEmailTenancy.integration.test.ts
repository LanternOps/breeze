/**
 * The assignee email's device and status lookups run in system scope, so the
 * tenant boundary is the explicit org / partner predicate in each query. A
 * ticket that points at another tenant's device or status gets no name.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, ticketStatuses } from '../../db/schema';
import { getDeviceName, getStatusName } from '../../jobs/ticketNotifyWorker';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

describe('assignee email lookups stay inside the ticket tenant', () => {
  runDb('names a device only within the ticket org and a status only within the ticket partner', async () => {
    await withSystemDbAccessContext(async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgA = await createOrganization({ partnerId: partnerA.id });
      const orgB = await createOrganization({ partnerId: partnerB.id });
      const siteB = await createSite({ orgId: orgB.id });
      const [deviceB] = await db.insert(devices).values({
        orgId: orgB.id, siteId: siteB.id, agentId: uniq('agent'), hostname: 'other-tenant-host',
        osType: 'linux', osVersion: 'synthetic-test', architecture: 'amd64', agentVersion: '0.0.0-test',
      }).returning();
      const [statusB] = await db.insert(ticketStatuses).values({
        partnerId: partnerB.id, name: uniq('B-Status'), coreStatus: 'open', isSystem: false,
      }).returning();

      expect(await getDeviceName(deviceB!.id, orgB.id)).toBe('other-tenant-host');
      expect(await getDeviceName(deviceB!.id, orgA.id)).toBeNull();
      expect(await getStatusName(statusB!.id, partnerB.id)).toBe(statusB!.name);
      expect(await getStatusName(statusB!.id, partnerA.id)).toBeNull();
    });
  });
});
