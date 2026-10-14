/**
 * Caller verification W03 (#6354 / #6357) — mailbox prefetch, live DB.
 *
 * Real DB contexts, real mailbox port, normalization and backend selection;
 * only the outbound Delegant broker HTTP call is stubbed. These are the
 * executable prefetch contract W05's dispatch relies on: the read works with
 * no request/AuthContext, is attributed to the persisted technician, holds no
 * DB context across the network call, and refuses an unattributed call.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createUser } from './db-utils';
import { getCurrentDbAccessContext, runOutsideDbContext, withDbAccessContext } from '../../db';
import { delegantM365Connections } from '../../db/schema/delegant';
import { m365Connections } from '../../db/schema';
import { callerVerificationPorts } from '../../services/callerVerification/ports';
import { withMailboxReader } from '../../services/callerVerification/mailboxReader';
import { destinationHash, normalizeDestination } from '../../services/callerVerification/destinations';

const broker = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../services/delegantClient', async (orig) => ({
  ...await orig<typeof import('../../services/delegantClient')>(),
  invokeDelegantTool: broker.invoke,
}));

let org: string, tech: string, target: { entraTenantId: string; entraOid: string };

beforeEach(async () => {
  const partner = (await createPartner())!.id;
  org = (await createOrganization({ partnerId: partner }))!.id;
  tech = (await createUser({ partnerId: partner, email: `cvm-${randomUUID()}@example.com`, status: 'active' }))!.id;
  target = { entraTenantId: randomUUID(), entraOid: randomUUID() };
  await getTestDb().insert(delegantM365Connections).values({
    orgId: org, customerLabel: 'mailbox-test', customerDisplayName: 'Mailbox test', delegantOrgId: randomUUID(),
    delegantConnectionId: randomUUID(), m365TenantId: target.entraTenantId, status: 'active',
  });
  broker.invoke.mockImplementation(async (args: { connection: { orgId: string }; parameters: unknown }) => {
    // Every backend probe has committed before the outbound call.
    expect(getCurrentDbAccessContext()).toBeUndefined();
    expect(args.connection.orgId).toBe(org);
    expect(args.parameters).toEqual({ userId: target.entraOid, expectedTenantId: target.entraTenantId });
    return { kind: 'ok', data: { id: target.entraOid, userPrincipalName: 'Target@Example.com', mail: 'Primary@Example.com', proxyAddresses: ['SMTP:Alias@Example.com', 'X500:/o=x'] } };
  });
});
afterEach(() => vi.clearAllMocks());

// W05's pre-lock pipeline: no Hono, no AuthContext, no fabricated session.
const prefetch = async (technicianUserId: string) => new Set((await runOutsideDbContext(() =>
  withMailboxReader(technicianUserId, () => callerVerificationPorts.mailboxes({ orgId: org, target }))))
  .map((value) => normalizeDestination('email', value.replace(/^smtp:/i, '')))
  .filter((value): value is string => !!value).map(destinationHash));

it('supplies the known mailbox hashes for a headless prefetch, attributed to the technician', async () => {
  expect(getCurrentDbAccessContext()).toBeUndefined();
  expect(await prefetch(tech)).toEqual(new Set(['target@example.com', 'primary@example.com', 'alias@example.com'].map(destinationHash)));
  expect(broker.invoke).toHaveBeenCalledWith(expect.objectContaining({
    toolName: 'get_user_mailboxes', actingUser: expect.objectContaining({ breezeUserId: tech }),
  }), expect.anything());
  expect((await prefetch(tech)).has(destinationHash('recovery@example.net'))).toBe(false);
});

it('detaches the prefetch from an authorized transaction and restores that context', async () => {
  const context = { scope: 'organization' as const, orgId: org, accessibleOrgIds: [org], accessiblePartnerIds: [], userId: tech };
  await withDbAccessContext(context, async () => {
    expect(await prefetch(tech)).toContain(destinationHash('alias@example.com'));
    expect(getCurrentDbAccessContext()).toBe(context);
  });
  expect(getCurrentDbAccessContext()).toBeUndefined();
});

it('isolates concurrent readers and refuses an unattributed port call', async () => {
  const second = randomUUID();
  await Promise.all([prefetch(tech), prefetch(second)]);
  expect(new Set(broker.invoke.mock.calls.map(([args]) => (args as { actingUser: { breezeUserId: string } }).actingUser.breezeUserId)))
    .toEqual(new Set([tech, second]));
  broker.invoke.mockClear();
  await expect(runOutsideDbContext(() => callerVerificationPorts.mailboxes({ orgId: org, target }))).rejects.toThrow('mailbox_reader_missing');
  expect(broker.invoke).not.toHaveBeenCalled();
});

it('never falls back to Delegant after the selected control-plane backend refuses', async () => {
  await getTestDb().insert(m365Connections).values({
    orgId: org, userId: null, tenantId: target.entraTenantId, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
    vaultRef: 'akv://vault.example/test-certificate/version', credentialVersion: 'test-version', permissionManifestVersion: 1, status: 'revoked',
  });
  await expect(prefetch(tech)).rejects.toThrow(/control_plane/);
  expect(broker.invoke).not.toHaveBeenCalled();
});

it('another org cannot use this org connection', async () => {
  const other = (await createOrganization({ partnerId: (await createPartner())!.id }))!.id;
  await expect(runOutsideDbContext(() => withMailboxReader(tech, () => callerVerificationPorts.mailboxes({ orgId: other, target }))))
    .rejects.toThrow('mailbox_connection_ambiguous_or_missing');
  expect(broker.invoke).not.toHaveBeenCalled();
});
