import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  buildResponseValidator,
  renderFormResponses,
  renderTitleTemplate,
  type TicketFormField,
  type TicketPriority
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, ticketFormOrgLinks, ticketForms } from '../db/schema';

export type TicketFormRow = typeof ticketForms.$inferSelect;

/**
 * Own error class (NOT TicketServiceError) to keep ticketFormService free of
 * an import cycle with ticketService — createTicket maps this to
 * TicketServiceError at the call site.
 */
export class TicketFormError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404
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
 * partner-wide rows THAT pass the org allowlist (spec §5): no
 * ticket_form_org_links rows for a form = visible to every org under the
 * partner; rows present = only the linked orgs see it. Partner-owned rows
 * are INVISIBLE to org-scoped RLS contexts (heartbeat/#1105 pattern), so
 * this reads under a system context and filters explicitly. Callers MUST
 * have already authorized the org (route: auth.canAccessOrg).
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
            sql`(
              ${ticketForms.orgId} = ${org.id}
              OR (
                ${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${org.partnerId}
                AND (
                  NOT EXISTS (SELECT 1 FROM ${ticketFormOrgLinks} WHERE ${ticketFormOrgLinks.formId} = ${ticketForms.id})
                  OR EXISTS (
                    SELECT 1 FROM ${ticketFormOrgLinks}
                    WHERE ${ticketFormOrgLinks.formId} = ${ticketForms.id} AND ${ticketFormOrgLinks.orgId} = ${org.id}
                  )
                )
              )
            )`
          )
        )
        .orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name))
    )
  );
}

/**
 * Allowlist check for a single partner-wide form: no link rows = every org
 * under the partner may use it; rows present = only the linked orgs may.
 * Reads under a system context. Callers must only invoke this once the form
 * is already confirmed partner-wide AND owned by this org's own partner.
 *
 * Two EXISTS probes (any-links / link-for-this-org) in one query — mirrors
 * the NOT EXISTS/EXISTS shape in listTicketFormsForOrg's WHERE — rather than
 * fetching up to 500 link rows and doing the membership check in JS.
 */
async function isOrgAllowedForPartnerWideForm(formId: string, orgId: string): Promise<boolean> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          anyLinks: sql<boolean>`EXISTS (SELECT 1 FROM ${ticketFormOrgLinks} WHERE ${ticketFormOrgLinks.formId} = ${ticketForms.id})`,
          linkForOrg: sql<boolean>`EXISTS (SELECT 1 FROM ${ticketFormOrgLinks} WHERE ${ticketFormOrgLinks.formId} = ${ticketForms.id} AND ${ticketFormOrgLinks.orgId} = ${orgId})`
        })
        .from(ticketForms)
        .where(eq(ticketForms.id, formId))
        .limit(1)
    )
  );
  const row = rows[0];
  if (!row || !row.anyLinks) return true; // no rows (or form vanished) = allowlist not in effect
  return row.linkForOrg;
}

/**
 * Load a form and verify it is usable for the given org (tenant + allowlist +
 * active [+ portal, when requested]). The caller MUST have already
 * authorized the org (createTicket resolves it from the ticket's target org
 * before calling here) — this reads under a system context so it does not
 * re-check tenancy at the RLS layer.
 */
export async function getTicketFormForOrg(
  formId: string,
  org: OrgRef,
  opts?: { requirePortalVisible?: boolean }
): Promise<TicketFormRow> {
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
  // Same message as the tenant-miss above, deliberately indistinguishable: an
  // allowlist miss must not let a caller (e.g. a portal user probing formIds)
  // learn the form exists but simply excludes their org.
  if (partnerWide && !(await isOrgAllowedForPartnerWideForm(form.id, org.id))) {
    throw new TicketFormError('Ticket form is not available for this organization', 400);
  }
  if (!form.isActive) throw new TicketFormError('Ticket form is inactive', 400);
  if (opts?.requirePortalVisible && !form.showInPortal) {
    throw new TicketFormError('Ticket form is not available in the portal', 400);
  }
  return form;
}

/**
 * Replace the org allowlist for a form (system-context write; intended for
 * partner-wide forms only — callers gate visibleOrgIds to ownerScope
 * 'partner' before reaching here). `null` clears the allowlist entirely
 * (form reverts to visible-to-all-the-partner's-orgs). An array replaces the
 * link rows wholesale; an EMPTY array produces the exact same zero-row state
 * as `null` — there is no distinct "allowlist nobody" state, since "no link
 * rows" already means visible-to-all (spec ruling). Callers (routes) should
 * normalize `[] -> null` before calling, but this function tolerates either
 * because both converge on the same persisted result. Every id in a
 * non-empty array MUST belong to `partnerId`, checked with a single select
 * before any write so a cross-partner id can never sneak in as a link.
 */
export async function syncTicketFormOrgLinks(formId: string, orgIds: string[] | null, partnerId: string): Promise<void> {
  const sync = async () => {
    if (orgIds === null) {
      await db.delete(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.formId, formId));
      return;
    }
    const dedupedIds = Array.from(new Set(orgIds));
    if (dedupedIds.length > 0) {
      const orgRows = await db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(inArray(organizations.id, dedupedIds))
        .limit(500);
      const partnerIdById = new Map(orgRows.map((r) => [r.id, r.partnerId]));
      const allBelongToPartner = dedupedIds.every((id) => partnerIdById.get(id) === partnerId);
      if (!allBelongToPartner) {
        throw new TicketFormError('visibleOrgIds must reference organizations of the owning partner', 400);
      }
    }
    // Replace semantics: delete-all then bulk insert, in ONE transaction with
    // the validation read above.
    await db.delete(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.formId, formId));
    if (dedupedIds.length > 0) {
      await db.insert(ticketFormOrgLinks).values(dedupedIds.map((orgId) => ({ formId, orgId })));
    }
  };

  // The link write MUST share the caller's ambient request transaction when one
  // exists. On POST /ticket-forms the parent ticket_forms row is inserted
  // uncommitted on the request transaction (C1); escaping to a FRESH system
  // transaction on another pooled connection (C2) means C2's READ COMMITTED
  // snapshot cannot see that parent, so the link policy's WITH CHECK
  // `EXISTS (... ticket_forms ...)` finds no parent row and the insert is
  // rejected (42501) — the create 500s (whole-branch review Critical). Running
  // on the ambient transaction lets the write see the same-transaction parent.
  //
  // Only partner-scoped tokens with orgAccess='all' reach this code path (POST
  // partner-wide + PUT partner-wide, both behind canManagePartnerWidePolicies),
  // so the ambient context is a partner context whose accessiblePartnerIds
  // covers the owning partner and whose accessibleOrgIds covers every org under
  // it. That clears BOTH the link WITH CHECK (breeze_has_partner_access on the
  // parent's partner_id) and the org-belongs-to-partner validation read
  // (breeze_has_org_access on organizations) — RLS stays fully enforced, it is
  // simply satisfied by the caller's own partner scope rather than a system
  // escalation. When there is NO ambient context (defensive; no current caller
  // reaches here contextless) fall back to a fresh system context.
  if (getCurrentDbAccessContext()) {
    return sync();
  }
  return runOutsideDbContext(() => withSystemDbAccessContext(sync));
}

/**
 * Link map for management-list responses: `Map<formId, orgId[]>` containing
 * ONLY the forms that have link rows (a form with no entry means "no
 * allowlist" / visible to all the partner's orgs). The map can never hold an
 * empty array — a form only gets a key when at least one link row exists —
 * so there is no distinct "empty allowlist" state to guard against; a
 * missing key IS the all-orgs state.
 */
export async function getTicketFormOrgLinkMap(formIds: string[]): Promise<Map<string, string[]>> {
  if (formIds.length === 0) return new Map();
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ formId: ticketFormOrgLinks.formId, orgId: ticketFormOrgLinks.orgId })
        .from(ticketFormOrgLinks)
        .where(inArray(ticketFormOrgLinks.formId, formIds))
        .limit(10_000)
    )
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.formId);
    if (list) list.push(row.orgId);
    else map.set(row.formId, [row.orgId]);
  }
  return map;
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
