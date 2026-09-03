import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  portalUsers,
  reportRuns,
  reports,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
} from './db-utils';
import {
  generatePortalReport,
  PortalReportNotFoundError,
  renderRunPdf,
} from '../../services/portal/reportsSelfService';
import {
  persistedSiteScopeValues,
  siteScopeFingerprint,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
  };
}

describe('portal report self-service tenancy', () => {
  runDb('stores portal provenance and hides org A PDF from org B', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [portalUser] = await db.insert(portalUsers).values({
        orgId: orgA.id,
        email: `portal-${crypto.randomUUID()}@example.test`,
        status: 'active',
      }).returning({ id: portalUsers.id });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: orgA.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      await db.insert(reports).values({
        orgId: orgA.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } },
        portalSelfService: true,
        ...persistedSiteScopeValues(authority),
      });

      return { orgA, orgB, portalUser: portalUser! };
    });

    const generated = await withDbAccessContext(
      orgContext(fixture.orgA.id),
      () => generatePortalReport({
        orgId: fixture.orgA.id,
        portalUserId: fixture.portalUser.id,
        type: 'executive_summary',
      }),
    );

    expect(generated.status).toBe('completed');

    const [stored] = await withSystemDbAccessContext(() =>
      db.select({
        requestedByKind: reportRuns.requestedByKind,
        requestedByUserId: reportRuns.requestedByUserId,
        requestedByPortalUserId: reportRuns.requestedByPortalUserId,
      }).from(reportRuns).where(eq(reportRuns.id, generated.id)),
    );

    expect(stored).toEqual({
      requestedByKind: 'portal_user',
      requestedByUserId: null,
      requestedByPortalUserId: fixture.portalUser.id,
    });

    await expect(
      withDbAccessContext(orgContext(fixture.orgA.id), () =>
        renderRunPdf(generated.id, fixture.orgA.id, 'UTC'),
      ),
    ).resolves.toBeInstanceOf(Buffer);

    await expect(
      withDbAccessContext(orgContext(fixture.orgB.id), () =>
        renderRunPdf(generated.id, fixture.orgB.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });
});
