/**
 * Shared fixtures of the ticket import framework's integration suites
 * (#8313 W4): a partner with orgs, a partner-wide admin who owns a keyless
 * import principal, a source on the fake module with its org maps, windows,
 * runs, and a driver that runs a run's slices the way the worker does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DelayedError, type Job } from 'bullmq';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partnerServicePrincipals, ticketImportItems, ticketImportRuns, users } from '../../db/schema';
import type { TicketImportSliceJobData } from '../../jobs/queueSchemas';
import { processTicketImportSlice, type ProcessSliceDeps } from '../../jobs/ticketImportWorker';
import { closeMigrationWindow, openMigrationWindow } from '../../services/migrationWindows';
import { startRun } from '../../services/ticketImport/runStore';
import { sealSourceCredentials } from '../../services/ticketImport/sourceCredentials';
import { insertSource, replaceMappings, type TicketImportMappings } from '../../services/ticketImport/sourceStore';
import { FAKE_MODULE_ID, fakeSource, type FakeTicket } from '../../services/ticketImport/testing/fakeModule';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const DAY = 86_400_000;
let seq = 0;
export const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

export const T0 = new Date('2022-05-01T08:00:00.000Z');
export const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

export async function seedImport() {
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = 'ticket-import-integration-key-material';
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgOutside = await createOrganization({ partnerId: partner.id });
  const owner = await createUser({ partnerId: partner.id, orgId: null, email: `${uniq('owner')}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role!.id, [
    { resource: 'organizations', action: 'write' },
    { resource: 'organizations', action: 'read' },
    { resource: 'tickets', action: 'write' },
    { resource: 'tickets', action: 'read' },
  ]);
  await assignUserToPartner(owner.id, partner.id, role!.id, 'all');
  const agent = await createUser({ partnerId: partner.id, orgId: null, email: `${uniq('agent')}@example.test` });
  const [principal] = await getTestDb().insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: uniq('Import'),
    scopes: ['tickets:read', 'tickets:write'],
    createdBy: owner.id,
    updatedBy: owner.id,
  }).returning();
  const ownerContext = (userId: string = owner.id): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id, orgB.id, orgOutside.id],
    accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id,
    userId,
  });
  const sourceId = randomUUID();
  const baseUrl = `https://${uniq('helpdesk')}.example.test`;
  await withDbAccessContext(ownerContext(), () => insertSource({
    id: sourceId,
    partnerId: partner.id,
    module: FAKE_MODULE_ID,
    label: 'Fake helpdesk',
    baseUrl,
    credentialsEncrypted: sealSourceCredentials(sourceId, { token: 'fake-token' }),
    principalId: principal!.id,
    createdBy: owner.id,
    options: {},
  }));
  const fx = { partner, orgA, orgB, orgOutside, owner, agent, principal: principal!, ownerContext, sourceId, baseUrl };
  await setMappings(fx, {
    orgs: [
      { sourceOrgKey: 'acme', sourceOrgName: 'Acme', orgId: orgA.id },
      { sourceOrgKey: 'beta', sourceOrgName: 'Beta', orgId: orgB.id },
    ],
    categories: [],
  });
  const source = fakeSource(baseUrl);
  return { ...fx, source };
}

export type ImportFx = Awaited<ReturnType<typeof seedImport>>;

export async function setMappings(fx: { partner: { id: string }; sourceId: string; ownerContext: () => DbAccessContext }, mappings: TicketImportMappings) {
  await withDbAccessContext(fx.ownerContext(), () => replaceMappings({ partnerId: fx.partner.id, sourceId: fx.sourceId, mappings, options: {} }));
}

export async function openWindow(fx: ImportFx, orgIds: string[] = [fx.orgA.id, fx.orgB.id]) {
  const [epochs] = await getTestDb().select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch }).from(users).where(eq(users.id, fx.owner.id));
  return withDbAccessContext(fx.ownerContext(), () => openMigrationWindow({
    partnerId: fx.partner.id,
    principalId: fx.principal.id,
    orgIds,
    endsAt: new Date(Date.now() + 2 * DAY),
    sourceLabel: 'fake',
    opener: { userId: fx.owner.id, authEpoch: epochs!.authEpoch, mfaEpoch: epochs!.mfaEpoch },
    stepUp: null,
  }));
}

export async function closeWindow(fx: ImportFx, windowId: string) {
  await withSystemDbAccessContext(() => db.transaction((tx) => closeMigrationWindow(tx, {
    windowId, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
  })));
}

export async function startImportRun(fx: ImportFx, kind: 'dry_run' | 'import', windowId?: string) {
  return withDbAccessContext(fx.ownerContext(), () => startRun({
    partnerId: fx.partner.id,
    sourceId: fx.sourceId,
    kind,
    windowId,
    startedBy: fx.owner.id,
    objectStorageConfigured: true,
  }));
}

export function sliceJob(data: TicketImportSliceJobData, attemptsMade = 0) {
  const moveToDelayed = async (_at: number, _token?: string) => undefined;
  return {
    id: `ticket-import-${data.runId}-${data.seq}`,
    name: 'slice',
    data,
    opts: { attempts: 3 },
    attemptsMade,
    moveToDelayed,
  } as unknown as Job & { moveToDelayed: typeof moveToDelayed };
}

export type DriveStep = { seq: number; outcome: string };

/**
 * Runs a run's slices to the end, as BullMQ would: successors from the
 * worker's enqueue, a deferred job again (DelayedError), a failed job retried
 * with one more attempt made.
 */
export async function drive(
  fx: { partner: { id: string } },
  runId: string,
  options: { deps?: ProcessSliceDeps; maxJobs?: number; startSeq?: number } = {},
): Promise<DriveStep[]> {
  const queue: Array<{ data: TicketImportSliceJobData; attemptsMade: number }> = [
    { data: { runId, partnerId: fx.partner.id, seq: options.startSeq ?? 0 }, attemptsMade: 0 },
  ];
  const steps: DriveStep[] = [];
  let jobs = 0;
  while (queue.length > 0) {
    jobs += 1;
    if (jobs > (options.maxJobs ?? 300)) throw new Error('drive: too many slice jobs');
    const next = queue.shift()!;
    try {
      const out = await processTicketImportSlice(sliceJob(next.data, next.attemptsMade), 'lock-token', {
        ...options.deps,
        enqueue: async (data) => { queue.push({ data, attemptsMade: 0 }); },
      });
      steps.push({ seq: next.data.seq, outcome: out.kind });
    } catch (error) {
      if (error instanceof DelayedError) {
        steps.push({ seq: next.data.seq, outcome: 'delayed' });
        queue.unshift(next);
        continue;
      }
      if (next.attemptsMade + 1 >= 3) throw error;
      steps.push({ seq: next.data.seq, outcome: 'retried' });
      queue.unshift({ data: next.data, attemptsMade: next.attemptsMade + 1 });
    }
  }
  return steps;
}

export async function runRow(runId: string) {
  const [row] = await getTestDb().select().from(ticketImportRuns).where(eq(ticketImportRuns.id, runId));
  return row!;
}

export async function ledger(sourceId: string) {
  const rows = await getTestDb().select().from(ticketImportItems).where(and(eq(ticketImportItems.sourceId, sourceId)));
  return new Map(rows.map((r) => [r.sourceTicketKey, r]));
}

export function fakeTickets(keys: string[], extra: Partial<FakeTicket> = {}): FakeTicket[] {
  return keys.map((key, i) => ({
    key,
    version: 'v1',
    orgKey: 'acme',
    number: `#${1000 + i}`,
    createdAt: minutes(i),
    updatedAt: minutes(i + 30),
    comments: [{ id: `${key}-1`, at: minutes(i + 5), content: `First reply on ${key}` }],
    ...extra,
  }));
}
