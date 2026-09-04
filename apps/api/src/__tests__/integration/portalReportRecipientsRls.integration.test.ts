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
  contacts,
  reportScheduleRecipients,
  reports,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
} from './db-utils';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

describe('report_schedule_recipients RLS', () => {
  runDb('allows its org and rejects a cross-org insert', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [report] = await db.insert(reports).values({
        orgId: orgA.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
      }).returning({ id: reports.id });

      const [contact] = await db.insert(contacts).values({
        orgId: orgA.id,
        name: 'Customer',
        email: 'customer@example.test',
      }).returning({ id: contacts.id });

      return { orgA, orgB, report: report!, contact: contact! };
    });

    const [created] = await withDbAccessContext(
      orgContext(fixture.orgA.id),
      () => db.insert(reportScheduleRecipients).values({
        reportId: fixture.report.id,
        orgId: fixture.orgA.id,
        contactId: fixture.contact.id,
      }).returning(),
    );
    expect(created?.orgId).toBe(fixture.orgA.id);

    await expect(
      withDbAccessContext(orgContext(fixture.orgB.id), () =>
        db.insert(reportScheduleRecipients).values({
          reportId: fixture.report.id,
          orgId: fixture.orgA.id,
          contactId: fixture.contact.id,
        }),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }),
    });

    const rows = await withDbAccessContext(
      orgContext(fixture.orgB.id),
      () => db.select().from(reportScheduleRecipients)
        .where(eq(reportScheduleRecipients.reportId, fixture.report.id)),
    );
    expect(rows).toEqual([]);
  });
});
