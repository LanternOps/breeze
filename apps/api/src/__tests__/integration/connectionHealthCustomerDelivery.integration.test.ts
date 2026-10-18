/**
 * Connection health customer-admin delivery against real Postgres (spec
 * 2026-10-15 §4, §6; W5 plan D1–D4). Pins the resolver precedence on real
 * settings rows, the widened recipient set (org members only when the org
 * resolves on, never for partner-wide incidents), and the path-level settings
 * write the settings routes use.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { resolveIncidentRecipients } from '../../services/connectionHealth/recipients';
import { loadCustomerAdminsNotified } from '../../services/connectionHealth/customerDelivery';
import { customerAdminsSettingsUpdate } from '../../routes/connectionHealthSettings';

const WRITE = { resource: 'organizations', action: 'write' };
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;
let orgA: string;
let orgB: string;
let staff: string;
let customerAdmin: string;
let customerViewer: string;

const setPartner = (settings: unknown) =>
  asSystem(() => db.update(partners).set({ settings }).where(eq(partners.id, P)));
const setOrg = (orgId: string, settings: unknown) =>
  asSystem(() => db.update(organizations).set({ settings }).where(eq(organizations.id, orgId)));
const writePartner = (v: boolean | null) =>
  asSystem(() => db.update(partners).set({ settings: customerAdminsSettingsUpdate(partners.settings, v) }).where(eq(partners.id, P)));
const writeOrg = (orgId: string, v: boolean | null) =>
  asSystem(() => db.update(organizations).set({ settings: customerAdminsSettingsUpdate(organizations.settings, v) }).where(eq(organizations.id, orgId)));
const partnerSettings = async () =>
  (await asSystem(() => db.select({ s: partners.settings }).from(partners).where(eq(partners.id, P))))[0]!.s;
const orgIncident = (orgId: string | null) => ({ partnerId: P, orgId, ownerUserId: null, repairPermission: 'organizations:write' });
const recipients = async (orgId: string | null) => (await asSystem(() => resolveIncidentRecipients(orgIncident(orgId)))).admins.sort();

describe('connection health customer-admin delivery (real DB)', () => {
  beforeEach(async () => {
    P = (await createPartner()).id;
    orgA = (await createOrganization({ partnerId: P })).id;
    orgB = (await createOrganization({ partnerId: P })).id;

    const partnerRole = await createRole({ scope: 'partner', partnerId: P, name: 'tech' });
    await grantRolePermissions(partnerRole.id, [WRITE]);
    const s = await createUser({ partnerId: P, status: 'active' });
    await assignUserToPartner(s.id, P, partnerRole.id, 'all');
    staff = s.id;

    const orgAdminRole = await createRole({ scope: 'organization', orgId: orgA, name: 'org admin' });
    await grantRolePermissions(orgAdminRole.id, [WRITE]);
    const orgViewRole = await createRole({ scope: 'organization', orgId: orgA, name: 'org viewer' });
    await grantRolePermissions(orgViewRole.id, [{ resource: 'organizations', action: 'read' }]);
    const ca = await createUser({ partnerId: P, orgId: orgA, status: 'active' });
    await assignUserToOrganization(ca.id, orgA, orgAdminRole.id);
    customerAdmin = ca.id;
    const cv = await createUser({ partnerId: P, orgId: orgA, status: 'active' });
    await assignUserToOrganization(cv.id, orgA, orgViewRole.id);
    customerViewer = cv.id;
  });

  it('off by default: an org incident reaches partner staff only', async () => {
    expect(await recipients(orgA)).toEqual([staff]);
    expect((await asSystem(() => loadCustomerAdminsNotified([orgA, orgB]))).get(orgA)).toBe(false);
  });

  it('partner default on: org members holding the repair permission are added; viewers are not', async () => {
    await writePartner(true);
    expect(await recipients(orgA)).toEqual([staff, customerAdmin].sort());
    expect(await recipients(orgA)).not.toContain(customerViewer);
  });

  it('an org override off beats the partner default on; an org override on works with the partner off', async () => {
    await writePartner(true);
    await writeOrg(orgA, false);
    expect(await recipients(orgA)).toEqual([staff]);
    await writePartner(false);
    await writeOrg(orgA, true);
    const m = await asSystem(() => loadCustomerAdminsNotified([orgA, orgB]));
    expect(m.get(orgA)).toBe(true);
    expect(m.get(orgB)).toBe(false);
    expect(await recipients(orgA)).toEqual([staff, customerAdmin].sort());
  });

  it('clearing the org override (null) inherits the partner default again', async () => {
    await writePartner(true);
    await writeOrg(orgA, false);
    await writeOrg(orgA, null);
    expect(await recipients(orgA)).toContain(customerAdmin);
  });

  it('a partner-wide incident never reaches org members, whatever the setting', async () => {
    await writePartner(true);
    await writeOrg(orgA, true);
    expect(await recipients(null)).toEqual([staff]);
  });

  it('the path-level write keeps every other settings key and creates or repairs the block', async () => {
    await setPartner({ security: { requireMfa: true }, connectionHealth: { futureKey: 1 } });
    await writePartner(true);
    expect(await partnerSettings()).toEqual({
      security: { requireMfa: true },
      connectionHealth: { futureKey: 1, customerAdminsNotified: true },
    });
    await writePartner(null);
    expect(await partnerSettings()).toEqual({ security: { requireMfa: true }, connectionHealth: { futureKey: 1 } });

    await setPartner({ connectionHealth: 'garbage', branding: { color: '#000' } });
    await writePartner(false);
    expect(await partnerSettings()).toEqual({ branding: { color: '#000' }, connectionHealth: { customerAdminsNotified: false } });

    await setPartner(null);
    await writePartner(true);
    expect(await partnerSettings()).toEqual({ connectionHealth: { customerAdminsNotified: true } });

    await setOrg(orgA, { aiApprovals: { interactiveTimeoutMinutes: 30 } });
    await writeOrg(orgA, true);
    const [org] = await asSystem(() => db.select({ s: organizations.settings }).from(organizations).where(eq(organizations.id, orgA)));
    expect(org!.s).toEqual({ aiApprovals: { interactiveTimeoutMinutes: 30 }, connectionHealth: { customerAdminsNotified: true } });
  });
});
