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
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { createContact } from '../../services/contacts/crud';
import {
  contactCreateAuditEvent,
  writeContactAudit,
} from '../../services/contacts/audit';
import { getReportWithOrgCheck } from './helpers';
import {
  addReportRecipientSchema,
  convertReportRecipientSchema,
  INTERNAL_REPORT_TYPES,
  PARTNER_ONLY_DELIVERY_REPORT_TYPES,
} from './schemas';

export const recipientsRoutes = new Hono();

/**
 * #4248 W03 — a system-managed definition (the weekly AI narrative, the Fleet
 * Design) is never executed by the report worker (`WORKER_EXCLUDED_REPORT_TYPES`,
 * kept in lockstep with `INTERNAL_REPORT_TYPES` by
 * `reportScheduleWorker.contract.test.ts`), so a manual recipient on it would
 * never receive anything: the narrative's own delivery is
 * `report_run_deliveries`, gated per recipient on live export authority.
 * Refuse on BOTH writers — `/recipients/convert` inserts into
 * `report_schedule_recipients` independently of `/recipients`.
 */
function systemManagedRefusal(report: { type?: string | null }) {
  const type = report.type ?? '';
  return INTERNAL_REPORT_TYPES.has(type)
    ? { error: 'report_type_system_managed' as const, type }
    : null;
}

/**
 * #3198 W01 — schedule recipients are ORG contacts (`report_schedule_recipients`
 * carries a composite `(report_id, org_id) → reports(id, org_id)` FK and a
 * contacts FK on the same org), so a partner-owned definition cannot hold one.
 * Refused on every writer with 409 `partner_owned_report`; the GET stays
 * readable and answers an empty list.
 */
function writeRefusal(report: { type?: string | null; partnerId?: string | null }) {
  return systemManagedRefusal(report)
    ?? partnerOwnedRefusal(report)
    ?? partnerOnlyDeliveryRefusal(report);
}

/**
 * #3198 W02 (spec §3.5, ruling P14) — a business report delivers only to
 * `config.emailRecipients`. By TYPE, so an org-owned business definition is
 * refused too (a partner-owned one already stopped at `partner_owned_report`).
 * DELETE deliberately does not call this: removing a stray contact is harmless.
 */
function partnerOnlyDeliveryRefusal(report: { type?: string | null }) {
  const type = report.type ?? '';
  return PARTNER_ONLY_DELIVERY_REPORT_TYPES.has(type)
    ? { error: 'report_type_partner_only_delivery' as const, type }
    : null;
}

/** Same body as helpers' PARTNER_OWNED_REPORT; kept local so this module's
 *  only helpers dependency stays the owner-aware definition loader. */
const PARTNER_OWNED_REPORT = { error: 'partner_owned_report' } as const;

function partnerOwnedRefusal(report: { partnerId?: string | null }) {
  return report.partnerId ? PARTNER_OWNED_REPORT : null;
}

/**
 * Loads the definition through the owner-aware gate and narrows it to an
 * org-owned one. A partner-owned row (#3198 W01) has `org_id NULL`, so it
 * comes back with `orgId: null` and every writer refuses it.
 */
async function loadOrgOwnedDefinition(
  reportId: string,
  auth: Parameters<typeof getReportWithOrgCheck>[1],
  // Ruling P8b: a type whose read permissions the caller lacks is hidden (404).
  permissions: Parameters<typeof getReportWithOrgCheck>[2],
  // #6699 decision B: only the read route passes 'read_history'; every
  // recipient mutation keeps the default, which refuses an out-of-service
  // owner (404, like any definition the caller cannot act on).
  action: Parameters<typeof getReportWithOrgCheck>[3] = 'read',
) {
  const report = await getReportWithOrgCheck(reportId, auth, permissions, action);
  if (!report) return { report: null, orgId: null, partnerOwned: false } as const;
  if (report.partnerId || !report.orgId) {
    return { report, orgId: null, partnerOwned: true } as const;
  }
  return { report, orgId: report.orgId, partnerOwned: false } as const;
}

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
    const { report, orgId } = await loadOrgOwnedDefinition(
      c.req.param('id')!,
      c.get('auth'),
      c.get('permissions') as UserPermissions | undefined,
      'read_history',
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);
    if (!orgId) return c.json({ data: [] });

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
        eq(reportScheduleRecipients.orgId, orgId),
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
    const { report, orgId } = await loadOrgOwnedDefinition(
      c.req.param('id')!,
      c.get('auth'),
      c.get('permissions') as UserPermissions | undefined,
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);
    const refusal = writeRefusal(report);
    if (refusal || !orgId) return c.json(refusal ?? PARTNER_OWNED_REPORT, 409);

    const { contactId } = c.req.valid('json');
    const [contact] = await db.select({ id: contacts.id })
      .from(contacts)
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.orgId, orgId),
      ))
      .limit(1);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);

    const [recipient] = await db.insert(reportScheduleRecipients).values({
      reportId: report.id,
      orgId,
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
    const { report, orgId, partnerOwned } = await loadOrgOwnedDefinition(
      c.req.param('id')!,
      c.get('auth'),
      c.get('permissions') as UserPermissions | undefined,
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);
    if (partnerOwned || !orgId) return c.json(PARTNER_OWNED_REPORT, 409);

    const rows = await db.delete(reportScheduleRecipients)
      .where(and(
        eq(reportScheduleRecipients.reportId, report.id),
        eq(reportScheduleRecipients.orgId, orgId),
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
    const { report, orgId } = await loadOrgOwnedDefinition(
      c.req.param('id')!,
      c.get('auth'),
      c.get('permissions') as UserPermissions | undefined,
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);
    const refusal = writeRefusal(report);
    if (refusal || !orgId) return c.json(refusal ?? PARTNER_OWNED_REPORT, 409);

    const input = c.req.valid('json');
    const email = input.email.trim().toLowerCase();

    const result = await db.transaction(async (tx) => {
      const [lockedReport] = await tx.select({ config: reports.config })
        .from(reports)
        .where(and(
          eq(reports.id, report.id),
          eq(reports.orgId, orgId),
        ))
        .limit(1)
        .for('update');
      if (!lockedReport) return null;

      let [contact] = await tx.select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
      }).from(contacts)
        .where(and(
          eq(contacts.orgId, orgId),
          sql`lower(${contacts.email}) = ${email}`,
        ))
        .limit(1);

      let createdContact = null;
      if (!contact) {
        createdContact = await createContact(tx, {
          orgId,
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
        orgId,
        contactId: contact!.id,
      }).onConflictDoNothing();

      const reportConfig = lockedReport.config as Record<string, unknown>;
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
        eq(reports.orgId, orgId),
      ));

      return { contact: contact!, createdContact };
    });

    if (!result) return c.json({ error: 'Report not found' }, 404);

    if (result.createdContact) {
      const createEvent = contactCreateAuditEvent(result.createdContact);
      writeContactAudit(c, {
        orgId,
        action: createEvent.action,
        contactId: createEvent.resourceId,
        contactName: createEvent.resourceName,
        details: createEvent.details,
      });
    }

    return c.json({ data: result.contact }, 201);
  },
);
