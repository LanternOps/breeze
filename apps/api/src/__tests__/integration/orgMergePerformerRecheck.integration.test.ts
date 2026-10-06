/**
 * Real-PostgreSQL coverage for the org-merge job's execution-time re-check of
 * the requesting user (services/orgMergePerformerAuthority.ts).
 *
 * The re-check reads users / partner_users / role_permissions through the
 * unprivileged breeze_app pool under the worker's system context. The merge
 * engine and the erasure hand-off are mocked: the assertion is that the job
 * never reaches them for a performer who no longer qualifies, and that the
 * loser org is left exactly as it was.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const { executeOrgMergeMock, enqueueTenantErasureMock } = vi.hoisted(() => ({
  executeOrgMergeMock: vi.fn(),
  enqueueTenantErasureMock: vi.fn(),
}));

vi.mock('../../services/orgMerge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/orgMerge')>()),
  executeOrgMerge: executeOrgMergeMock,
}));
vi.mock('../../jobs/tenantErasure', () => ({ enqueueTenantErasure: enqueueTenantErasureMock }));

import { db, withSystemDbAccessContext } from '../../db';
import { auditLogs, organizations, partnerUsers, users } from '../../db/schema';
import { createOrganization, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { processOrgMergeJob } from '../../jobs/orgMerge';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const loser = await withSystemDbAccessContext(() =>
    createOrganization({ partnerId: env.partner.id, name: 'Synthetic merge loser' }),
  );
  const job = {
    name: 'org-merge',
    id: `org-merge-${loser.id}`,
    data: {
      loserOrgId: loser.id,
      survivorOrgId: env.organization.id,
      partnerId: env.partner.id,
      performedBy: env.user.id,
      performedByEmail: env.user.email,
    },
  };
  return { env, loser, job };
}

async function loserRow(id: string) {
  const [row] = await getTestDb()
    .select({ status: organizations.status, deletedAt: organizations.deletedAt })
    .from(organizations)
    .where(eq(organizations.id, id));
  return row;
}

async function failedAudit(loserId: string) {
  return getTestDb()
    .select({ details: auditLogs.details, actorId: auditLogs.actorId, result: auditLogs.result })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'org.merge.failed'), eq(auditLogs.resourceId, loserId)));
}

describe('org merge job re-checks the requesting user at execution time', () => {
  beforeEach(() => {
    executeOrgMergeMock.mockReset();
    executeOrgMergeMock.mockResolvedValue({ tables: {}, summary: {}, warnings: [], mergeEventId: 'synthetic' });
    enqueueTenantErasureMock.mockReset();
    enqueueTenantErasureMock.mockResolvedValue({ id: 'synthetic-erasure' });
  });

  runDb('runs the merge for a requester who still qualifies', async () => {
    const { job } = await fixture();

    await expect(processOrgMergeJob(job)).resolves.toMatchObject({ jobId: job.id });
    expect(executeOrgMergeMock).toHaveBeenCalledOnce();
  });

  runDb('refuses a queued merge whose requester was deactivated, without touching the organization', async () => {
    const { env, loser, job } = await fixture();
    await withSystemDbAccessContext(() =>
      db.update(users).set({ status: 'disabled' }).where(eq(users.id, env.user.id)),
    );

    await expect(processOrgMergeJob(job)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: expect.stringContaining('performer_inactive'),
    });

    expect(executeOrgMergeMock).not.toHaveBeenCalled();
    expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
    expect(await loserRow(loser.id)).toEqual({ status: 'active', deletedAt: null });
    const audits = await failedAudit(loser.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: env.user.id,
      result: 'failure',
      details: expect.objectContaining({
        reason: 'performer_no_longer_authorized',
        performerCheck: 'performer_inactive',
      }),
    });
  });

  runDb('refuses a queued merge whose requester was removed from the partner', async () => {
    const { env, loser, job } = await fixture();
    await withSystemDbAccessContext(() =>
      db.delete(partnerUsers).where(eq(partnerUsers.userId, env.user.id)),
    );

    await expect(processOrgMergeJob(job)).rejects.toMatchObject({
      message: expect.stringContaining('performer_not_in_partner'),
    });
    expect(executeOrgMergeMock).not.toHaveBeenCalled();
    expect(await loserRow(loser.id)).toEqual({ status: 'active', deletedAt: null });
  });

  runDb('refuses a queued merge whose requester no longer reaches the loser', async () => {
    const { env, loser, job } = await fixture();
    await withSystemDbAccessContext(() =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [env.organization.id] })
        .where(eq(partnerUsers.userId, env.user.id)),
    );

    await expect(processOrgMergeJob(job)).rejects.toMatchObject({
      message: expect.stringContaining('performer_lacks_org_access'),
    });
    expect(executeOrgMergeMock).not.toHaveBeenCalled();
    expect(await loserRow(loser.id)).toEqual({ status: 'active', deletedAt: null });
  });
});
