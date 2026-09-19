/**
 * Artifact attachments — CHECK shape, RLS, expiry-to-null and erasure ordering
 * against real Postgres (execution-plane W05, spec §6.3).
 *
 * Migration under test: 2026-10-16-192900-artifact-attachments.sql
 *
 * Proves:
 *   1. an artifact-backed ticket_attachments row inserts with no key and no
 *      bytes, and the old s3/db shapes still insert — WITH a positive control,
 *      so a malformed statement cannot masquerade as a passing check;
 *   2. the widened CHECK refuses an artifact row that also carries a
 *      storage_key or data;
 *   3. deleting the artifact SET NULLs both back-references and deletes
 *      neither row — the 30-day sweeper must never be blocked by a ticket;
 *   4. a cross-org attach forge raises 42501 as `breeze_app`;
 *   5. org erasure does not strand either row.
 *
 * Three of those are Postgres behaviours a mocked suite cannot observe: the
 * ON DELETE SET NULL the retention sweeper fires, the widened CHECK accepting
 * exactly the artifact shape and refusing the others, and RLS refusing a
 * cross-org attach. The mocked route suite proves statement SHAPE; this proves
 * Postgres agrees.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { tickets, reports, reportRuns, aiAgents, aiAgentRuns } from '../../db/schema';
import { ticketAttachments } from '../../db/schema/ticketAttachments';
import { aiRunArtifacts } from '../../db/schema/aiWorkspace';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const SHA = 'f'.repeat(64);

/**
 * Drizzle wraps the driver error in a `Failed query: …` Error and hangs the
 * real `PostgresError` off `cause`, so the SQLSTATE lives one level down.
 * Asserting on the top-level object would pass for ANY rejection — including
 * a malformed statement — which is exactly the vacuous check these tests exist
 * to avoid.
 */
function expectSqlState(code: string) {
  return { cause: expect.objectContaining({ code }) };
}

/**
 * Seeds partner → org → site → user → ticket → report run → agent run →
 * artifact and returns every id. If this helper drifts from W01/W02's shipped
 * columns, fix it HERE — never by relaxing an assertion below.
 */
async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ orgId: org.id, partnerId: partner.id });

  return withSystemDbAccessContext(async () => {
    const [ticket] = await db.insert(tickets).values({
      orgId: org.id,
      partnerId: partner.id,
      // NOT NULL with no default — same shape every other integration fixture
      // uses (see aiAgentImpact.integration.test.ts). `tickets` has no site_id.
      ticketNumber: `ATT-${randomUUID().slice(0, 12)}`,
      subject: 'analysis attach fixture',
      description: 'fixture',
      source: 'manual',
    }).returning({ id: tickets.id });

    const [report] = await db.insert(reports).values({
      orgId: org.id,
      name: 'analysis attach fixture',
      type: 'device_inventory',
      format: 'csv',
    }).returning({ id: reports.id });

    const [reportRun] = await db.insert(reportRuns).values({
      reportId: report!.id,
      status: 'completed',
      requestedByKind: 'system',
    }).returning({ id: reportRuns.id });

    const [agent] = await db.insert(aiAgents).values({
      orgId: org.id,
      partnerId: null,
      kind: 'triage',
      name: 'Artifact attach fixture',
      createdBy: user.id,
    }).returning({ id: aiAgents.id });

    const [run] = await db.insert(aiAgentRuns).values({
      agentId: agent!.id,
      orgId: org.id,
      triggerKind: 'manual',
      dedupeKey: `artifact-attach-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 } as never,
    }).returning({ id: aiAgentRuns.id });

    const [artifact] = await db.insert(aiRunArtifacts).values({
      orgId: org.id,
      runId: run!.id,
      sessionId: null,
      kind: 'output',
      name: 'failed-logons.csv',
      contentType: 'text/csv',
      bytes: 40_112,
      sha256: SHA,
      blobKey: `eu/2026/09/${randomUUID()}`,
      headPreview: 'user,when\n',
      tailPreview: '\n',
      sourceDeviceId: null,
      createdByTool: 'workspace_collect',
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    }).returning({ id: aiRunArtifacts.id });

    return {
      partnerId: partner.id,
      orgId: org.id,
      siteId: site.id,
      userId: user.id,
      ticketId: ticket!.id,
      reportId: report!.id,
      reportRunId: reportRun!.id,
      runId: run!.id,
      artifactId: artifact!.id,
    };
  });
}

describe('artifact attachments (live DB)', () => {
  let ids: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    ids = await seed();
  });

  /** An artifact-backed attachment row, with whatever the caller overrides. */
  function artifactAttachment(over: Record<string, unknown> = {}) {
    return {
      orgId: ids.orgId,
      ticketId: ids.ticketId,
      commentId: null,
      uploadedByUserId: ids.userId,
      storageBackend: 'artifact' as const,
      storageKey: null,
      data: null,
      artifactId: ids.artifactId,
      contentType: 'text/csv',
      byteSize: 40_112,
      originalFilename: 'failed-logons.csv',
      sha256: SHA,
      ...over,
    };
  }

  runDb('inserts an artifact-backed attachment with no key and no bytes', async () => {
    await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(ticketAttachments)
        .values(artifactAttachment())
        .returning({ id: ticketAttachments.id });
      expect(row?.id).toBeDefined();
    });
  });

  runDb('still accepts the two pre-existing upload shapes', async () => {
    // Positive control for the CHECK rewrite: widening it must not have
    // narrowed the s3/db arms it replaced.
    await withSystemDbAccessContext(async () => {
      const [dbRow] = await db.insert(ticketAttachments).values(artifactAttachment({
        storageBackend: 'db', data: Buffer.from('inline'), artifactId: null, byteSize: 6,
      })).returning({ id: ticketAttachments.id });
      expect(dbRow?.id).toBeDefined();

      const [s3Row] = await db.insert(ticketAttachments).values(artifactAttachment({
        storageBackend: 's3', storageKey: `ticket-attachments/${randomUUID()}`, artifactId: null, byteSize: 6,
      })).returning({ id: ticketAttachments.id });
      expect(s3Row?.id).toBeDefined();
    });
  });

  runDb('refuses inserting an artifact-backed row with no artifact_id (#5955)', async () => {
    // The backend CHECK deliberately allows artifact_id IS NULL so the FK's
    // ON DELETE SET NULL (the retention sweeper) can null a row that HAD a
    // valid pointer. It must NOT allow a row to be born with a null pointer —
    // that's a trigger's job (BEFORE INSERT only, never fires on the
    // sweeper's UPDATE), covered by the "nulls both back-references..." test
    // above which proves the sweeper path still works.
    await expect(withSystemDbAccessContext(() => db
      .insert(ticketAttachments)
      .values(artifactAttachment({ artifactId: null, byteSize: 10 })),
    )).rejects.toMatchObject(expectSqlState('23514'));
  });

  runDb('refuses an artifact row that also carries a storage key', async () => {
    await expect(withSystemDbAccessContext(() => db
      .insert(ticketAttachments)
      .values(artifactAttachment({ storageKey: 'ticket-attachments/x', byteSize: 10 })),
    )).rejects.toMatchObject(expectSqlState('23514'));
  });

  runDb('refuses an artifact row that also carries inline bytes', async () => {
    await expect(withSystemDbAccessContext(() => db
      .insert(ticketAttachments)
      .values(artifactAttachment({ data: Buffer.from('x'), byteSize: 1 })),
    )).rejects.toMatchObject(expectSqlState('23514'));
  });

  runDb('accepts an artifact row larger than the 10 MiB upload cap', async () => {
    await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(ticketAttachments)
        .values(artifactAttachment({ byteSize: 60 * 1024 * 1024, originalFilename: 'big.csv' }))
        .returning({ id: ticketAttachments.id });
      expect(row?.id).toBeDefined();
    });

    // …and still refuses an oversize UPLOAD (positive control for the CASE arm).
    await expect(withSystemDbAccessContext(() => db
      .insert(ticketAttachments)
      .values(artifactAttachment({
        storageBackend: 'db',
        data: Buffer.from('x'),
        artifactId: null,
        byteSize: 60 * 1024 * 1024,
        originalFilename: 'big.csv',
      })),
    )).rejects.toMatchObject(expectSqlState('23514'));
  });

  runDb('nulls both back-references when the artifact expires, deleting neither row', async () => {
    await withSystemDbAccessContext(async () => {
      const [att] = await db
        .insert(ticketAttachments)
        .values(artifactAttachment({ byteSize: 10, originalFilename: 'f.csv' }))
        .returning({ id: ticketAttachments.id });
      await db.update(reportRuns)
        .set({ artifactId: ids.artifactId })
        .where(eq(reportRuns.id, ids.reportRunId));

      // This is exactly what the retention sweeper does. A NOT NULL arm on the
      // artifact CHECK would make it fail here with 23514 and wedge silently.
      await db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, ids.artifactId));

      const [attAfter] = await db.select().from(ticketAttachments)
        .where(eq(ticketAttachments.id, att!.id));
      expect(attAfter).toBeDefined();
      expect(attAfter!.artifactId).toBeNull();
      expect(attAfter!.storageBackend).toBe('artifact');

      const [runAfter] = await db.select().from(reportRuns)
        .where(eq(reportRuns.id, ids.reportRunId));
      expect(runAfter!.artifactId).toBeNull();
    });
  });

  runDb('refuses a cross-org attach as breeze_app', async () => {
    const other = await createOrganization({ partnerId: ids.partnerId });

    await expect(
      withDbAccessContext(
        { scope: 'organization', orgId: other.id, accessibleOrgIds: [other.id] } as never,
        () => db.insert(ticketAttachments).values(artifactAttachment({ byteSize: 10, originalFilename: 'f.csv' })),
      ),
    ).rejects.toMatchObject(expectSqlState('42501'));

    // Positive control in the SAME test: the identical statement in the OWNING
    // org's context succeeds, so a broken statement cannot pass as isolation.
    await expect(
      withDbAccessContext(
        { scope: 'organization', orgId: ids.orgId, accessibleOrgIds: [ids.orgId] } as never,
        () => db.insert(ticketAttachments).values(artifactAttachment({ byteSize: 10, originalFilename: 'f.csv' })),
      ),
    ).resolves.toBeDefined();
  });

  runDb('erases the org without stranding an artifact-backed attachment', async () => {
    await withSystemDbAccessContext(async () => {
      await db.insert(ticketAttachments)
        .values(artifactAttachment({ byteSize: 10, originalFilename: 'f.csv' }));
      // Drop the artifact FIRST, leaving the attachment as a backend='artifact'
      // row with a NULL pointer — the awkward state the ON DELETE SET NULL
      // creates, and the one an erasure is most likely to trip over.
      //
      // It also keeps this test off W01's artifact-BLOB pre-clear, which needs
      // real S3 credentials and short-circuits at zero artifacts. That
      // pre-clear is W01's contract, not this wave's; what is under test here
      // is that the org cascade still removes the ticket_attachments row.
      await db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.orgId, ids.orgId));
    });

    await cascadeDeleteOrg(ids.orgId, ids.userId, 'fixture@example.test');

    await withSystemDbAccessContext(async () => {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS count FROM ticket_attachments WHERE org_id = ${ids.orgId}`,
      )) as unknown as Array<{ count: number }>;
      expect(rows[0]!.count).toBe(0);
    });
  });
});
