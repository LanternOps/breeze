import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import {
  contacts,
  reportScheduleRecipients,
  reports,
} from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { createContact } from '../../services/contacts/crud';
import {
  contactCreateAuditEvent,
  writeContactAudit,
} from '../../services/contacts/audit';
import { getReportWithOrgCheck } from './helpers';
import {
  addReportRecipientSchema,
  convertReportRecipientSchema,
} from './schemas';

export const recipientsRoutes = new Hono();

recipientsRoutes.use('*', authMiddleware);

const read = requirePermission(
  PERMISSIONS.REPORTS_READ.resource,
  PERMISSIONS.REPORTS_READ.action,
);
const write = requirePermission(
  PERMISSIONS.REPORTS_WRITE.resource,
  PERMISSIONS.REPORTS_WRITE.action,
);

recipientsRoutes.get(
  '/:id/recipients',
  requireScope('organization', 'partner', 'system'),
  read,
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const rows = await db.select({
      id: reportScheduleRecipients.id,
      contactId: contacts.id,
      name: contacts.name,
      email: contacts.email,
    }).from(reportScheduleRecipients)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, reportScheduleRecipients.contactId),
          eq(contacts.orgId, reportScheduleRecipients.orgId),
        ),
      )
      .where(and(
        eq(reportScheduleRecipients.reportId, report.id),
        eq(reportScheduleRecipients.orgId, report.orgId),
      ))
      .orderBy(asc(contacts.name), asc(contacts.email));

    return c.json({ data: rows });
  },
);

recipientsRoutes.post(
  '/:id/recipients',
  requireScope('organization', 'partner', 'system'),
  write,
  zValidator('json', addReportRecipientSchema),
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const { contactId } = c.req.valid('json');
    const [contact] = await db.select({ id: contacts.id })
      .from(contacts)
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.orgId, report.orgId),
      ))
      .limit(1);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);

    const [recipient] = await db.insert(reportScheduleRecipients).values({
      reportId: report.id,
      orgId: report.orgId,
      contactId,
    }).onConflictDoNothing().returning();

    return c.json({ data: recipient ?? null }, recipient ? 201 : 200);
  },
);

recipientsRoutes.delete(
  '/:id/recipients/:contactId',
  requireScope('organization', 'partner', 'system'),
  write,
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const rows = await db.delete(reportScheduleRecipients)
      .where(and(
        eq(reportScheduleRecipients.reportId, report.id),
        eq(reportScheduleRecipients.orgId, report.orgId),
        eq(
          reportScheduleRecipients.contactId,
          c.req.param('contactId')!,
        ),
      ))
      .returning({ id: reportScheduleRecipients.id });

    if (rows.length === 0) {
      return c.json({ error: 'Recipient not found' }, 404);
    }
    return c.json({ data: { deleted: true } });
  },
);

recipientsRoutes.post(
  '/:id/recipients/convert',
  requireScope('organization', 'partner', 'system'),
  write,
  requireMfa(),
  zValidator('json', convertReportRecipientSchema),
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const input = c.req.valid('json');
    const email = input.email.trim().toLowerCase();

    const result = await db.transaction(async (tx) => {
      let [contact] = await tx.select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
      }).from(contacts)
        .where(and(
          eq(contacts.orgId, report.orgId),
          sql`lower(${contacts.email}) = ${email}`,
        ))
        .limit(1);

      let createdContact = null;
      if (!contact) {
        createdContact = await createContact(tx, {
          orgId: report.orgId,
          name: input.name ?? null,
          email,
        }, { userId: c.get('auth').user.id });
        contact = {
          id: createdContact.id,
          name: createdContact.name,
          email: createdContact.email,
        };
      }

      await tx.insert(reportScheduleRecipients).values({
        reportId: report.id,
        orgId: report.orgId,
        contactId: contact!.id,
      }).onConflictDoNothing();

      const reportConfig = report.config as Record<string, unknown>;
      const rawEmailRecipients = reportConfig.emailRecipients;
      const legacy = Array.isArray(rawEmailRecipients)
        ? rawEmailRecipients.filter(
            (value: unknown) =>
              typeof value !== 'string'
              || value.trim().toLowerCase() !== email,
          )
        : [];

      await tx.update(reports).set({
        config: {
          ...reportConfig,
          emailRecipients: legacy,
        },
        updatedAt: new Date(),
      }).where(and(
        eq(reports.id, report.id),
        eq(reports.orgId, report.orgId),
      ));

      return { contact: contact!, createdContact };
    });

    if (result.createdContact) {
      const createEvent = contactCreateAuditEvent(result.createdContact);
      writeContactAudit(c, {
        orgId: report.orgId,
        action: createEvent.action,
        contactId: createEvent.resourceId,
        contactName: createEvent.resourceName,
        details: createEvent.details,
      });
    }

    return c.json({ data: result.contact }, 201);
  },
);
