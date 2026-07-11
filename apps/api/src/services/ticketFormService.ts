import { and, asc, eq, sql } from 'drizzle-orm';
import {
  buildResponseValidator,
  renderFormResponses,
  renderTitleTemplate,
  type TicketFormField,
  type TicketPriority
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketForms } from '../db/schema';

export type TicketFormRow = typeof ticketForms.$inferSelect;

/**
 * Own error class (NOT TicketServiceError) to keep ticketFormService free of
 * an import cycle with ticketService — createTicket maps this to
 * TicketServiceError at the call site.
 */
export class TicketFormError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'TicketFormError';
  }
}

interface OrgRef {
  id: string;
  partnerId: string;
}

/**
 * Forms visible to an org: org-owned rows plus the org's partner's
 * partner-wide rows. Partner-owned rows are INVISIBLE to org-scoped RLS
 * contexts (heartbeat/#1105 pattern), so this reads under a system context
 * and filters explicitly. Callers MUST have already authorized the org
 * (route: auth.canAccessOrg; service: the ticket's resolved org).
 */
export async function listTicketFormsForOrg(org: OrgRef, opts?: { portalOnly?: boolean }): Promise<TicketFormRow[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select()
        .from(ticketForms)
        .where(
          and(
            eq(ticketForms.isActive, true),
            opts?.portalOnly ? eq(ticketForms.showInPortal, true) : undefined,
            sql`(${ticketForms.orgId} = ${org.id} OR (${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${org.partnerId}))`
          )
        )
        .orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name))
    )
  );
}

/** Load a form and verify it is usable for the given org (tenant + active). */
export async function getTicketFormForOrg(formId: string, org: OrgRef): Promise<TicketFormRow> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.select().from(ticketForms).where(eq(ticketForms.id, formId)).limit(1))
  );
  const form = rows[0];
  if (!form) throw new TicketFormError('Ticket form not found', 404);
  const ownedByOrg = form.orgId === org.id;
  const partnerWide = form.orgId === null && form.partnerId === org.partnerId;
  if (!ownedByOrg && !partnerWide) {
    throw new TicketFormError('Ticket form is not available for this organization', 400);
  }
  if (!form.isActive) throw new TicketFormError('Ticket form is inactive', 400);
  return form;
}

export interface AppliedIntakeForm {
  responses: Record<string, unknown>;
  subjectFromForm: string;
  descriptionBlock: string;
  categoryId: string | null;
  defaultPriority: TicketPriority | null;
  defaultTags: string[];
  intakeSnapshot: {
    intakeForm: { formId: string; formName: string; formVersion: number; responses: Record<string, unknown> };
  };
}

/** Pure: validate raw responses against the form and compose ticket pieces. */
export function applyIntakeForm(form: TicketFormRow, rawResponses: Record<string, unknown>): AppliedIntakeForm {
  const fields = (form.fields ?? []) as TicketFormField[];
  const parsed = buildResponseValidator(fields).safeParse(rawResponses ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TicketFormError(`Form responses failed validation: ${detail}`, 400);
  }
  const responses = parsed.data as Record<string, unknown>;
  return {
    responses,
    subjectFromForm: renderTitleTemplate(form.titleTemplate, form.name, responses),
    descriptionBlock: renderFormResponses(
      { name: form.name, descriptionIntro: form.descriptionIntro, fields },
      responses
    ),
    categoryId: form.categoryId ?? null,
    defaultPriority: (form.defaultPriority as TicketPriority | null) ?? null,
    defaultTags: form.defaultTags ?? [],
    intakeSnapshot: {
      intakeForm: { formId: form.id, formName: form.name, formVersion: form.version, responses }
    }
  };
}
