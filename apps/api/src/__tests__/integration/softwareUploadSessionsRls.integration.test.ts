/**
 * Real-driver cross-tenant forge tests for software_upload_sessions
 * (chunked package upload, issue #2951). Runs under
 * vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role, so RLS is actually enforced.
 *
 * Coverage:
 *   (a) org B context reading org A's upload session → 0 rows
 *   (b) org B context UPDATE/DELETE on org A's session → 0 rows, row survives
 *   (c) a forged cross-org INSERT (org B context, org_id = orgA) → 42501
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { softwareCatalog, softwareUploadSessions } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgA: { id: string };
  orgB: { id: string };
  catalogA: { id: string };
  sessionA: { id: string };
  orgBContext: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const [catalogA] = await db
      .insert(softwareCatalog)
      .values({ orgId: orgA.id, name: 'A-only package' })
      .returning({ id: softwareCatalog.id });
    if (!catalogA) throw new Error('failed to seed catalog item A');

    const [sessionA] = await db
      .insert(softwareUploadSessions)
      .values({
        orgId: orgA.id,
        catalogId: catalogA.id,
        fileName: 'installer.msi',
        fileSize: 1024,
        chunkSize: 512,
        tempPath: '/tmp/breeze-uploads/session-test-a.part',
        ownerInstanceId: 'itest-instance',
        versionMetadata: { version: '1.0.0' },
      })
      .returning({ id: softwareUploadSessions.id });
    if (!sessionA) throw new Error('failed to seed upload session A');

    const orgBContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [],
      userId: null,
    };

    return {
      orgA: { id: orgA.id },
      orgB: { id: orgB.id },
      catalogA: { id: catalogA.id },
      sessionA: { id: sessionA.id },
      orgBContext,
    };
  });
}

describe('software_upload_sessions RLS isolation (breeze_app)', () => {
  runDb('org B context cannot read an org-A upload session', async () => {
    const { sessionA, orgBContext } = await seedFixture();
    const rows = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: softwareUploadSessions.id })
        .from(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('org B UPDATE/DELETE on an org-A session affects 0 rows; row survives', async () => {
    const { sessionA, orgBContext } = await seedFixture();

    const updated = await withDbAccessContext(orgBContext, () =>
      db
        .update(softwareUploadSessions)
        .set({ bytesReceived: 999 })
        .where(eq(softwareUploadSessions.id, sessionA.id))
        .returning({ id: softwareUploadSessions.id })
    );
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgBContext, () =>
      db
        .delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
        .returning({ id: softwareUploadSessions.id })
    );
    expect(deleted).toHaveLength(0);

    const survivor = await withSystemDbAccessContext(() =>
      db
        .select({ id: softwareUploadSessions.id, bytesReceived: softwareUploadSessions.bytesReceived })
        .from(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.bytesReceived).toBe(0);
  });

  // Drizzle wraps the driver error; Postgres 42501 (insufficient_privilege /
  // "new row violates row-level security policy") rides on `cause.code` —
  // same assertion pattern as catalog-rls.integration.test.ts case (c).
  runDb('a forged cross-org software_upload_sessions insert is rejected by RLS', async () => {
    const { orgA, catalogA, orgBContext } = await seedFixture();

    let caught: unknown;
    try {
      await withDbAccessContext(orgBContext, () =>
        db.insert(softwareUploadSessions).values({
          orgId: orgA.id, // forged: org B context writing an org A row
          catalogId: catalogA.id,
          fileName: 'forged.msi',
          fileSize: 1024,
          chunkSize: 512,
          tempPath: '/tmp/breeze-uploads/session-forged.part',
          ownerInstanceId: 'itest-instance',
          versionMetadata: { version: '6.6.6' },
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    const cause = (caught as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('42501');
  });
});
