/**
 * `manage_ticket_forms` (full-control W06, #6776): the AI twin of
 * routes/tickets/forms.ts. A ticket form is a CUSTOMER-VISIBLE portal intake
 * form, so every write is supervised and `delete` is four-eyes (hard delete).
 *
 * The route has no service layer (the queries are inline), so this file keeps
 * its rules one-for-one: dual-axis access (org rows the caller reaches, or the
 * caller's own partner's partner-wide rows), the partner-wide write gate
 * (`canManagePartnerWidePolicies`), ownership derived from the caller's token
 * (never from input), `visibleOrgIds` only on partner-wide forms, the category
 * partner guard, version bump only when fields/titleTemplate change, and the
 * rollback of a half-created partner-wide form. Org tokens are allowed, as in
 * the route. Writes refuse an `ai_agent` principal (created_by users FK).
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createTicketFormSchema, updateTicketFormSchema } from '@breeze/shared';
import { db } from '../db';
import { organizations, ticketForms } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TICKET_FORM_ACTIONS } from './aiToolSchemasTicketOps';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  agentRefusal,
  isAgentPrincipal,
  json,
  jsonError,
  LIST_PAGE,
  parseData,
  serviceErrorJson,
} from './aiToolsTicketOpsShared';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { getTicketFormOrgLinkMap, listTicketFormsForOrg, syncTicketFormOrgLinks } from './ticketFormService';
import { assertCategoryInPartner } from './ticketService';
import { approverReleaseMismatch } from './aiToolReleaseGuards';
import type { ToolExecutionContext } from './toolExecutionContext';

type FormAction = (typeof TICKET_FORM_ACTIONS)[number];
const guid = z.string().guid();
const VISIBLE_ORG_IDS_SCOPE_ERROR = 'visibleOrgIds is only valid on partner-wide forms';

/** null/absent = visible to every org; a non-empty array is the allowlist; [] means nothing meaningful. */
function normalizeVisibleOrgIds(v: string[] | null | undefined): string[] | null {
  return v && v.length > 0 ? v : null;
}

/** Org rows the caller reaches OR the caller's own partner's partner-wide rows (partner scope only; RLS is stricter). */
function formAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(ticketForms.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

async function getFormWithAccess(formId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(ticketForms.id, formId)];
  const access = formAccessCondition(auth);
  if (access) conditions.push(access);
  const rows = await db.select().from(ticketForms).where(and(...conditions)).limit(1);
  return rows[0] ?? null;
}

async function effectivePartnerId(owner: { orgId: string | null; partnerId: string | null }): Promise<string | null> {
  if (owner.orgId === null) return owner.partnerId;
  const rows = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, owner.orgId))
    .limit(1);
  return rows[0]?.partnerId ?? null;
}

export function registerTicketFormTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_forms', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'ticket intake forms shown in the customer portal: list, see which apply to an org, create, edit, delete',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_forms',
      description:
        'Customer-visible ticket intake forms. Actions: list,available (forms an org can use),create,update,delete. Writes need approval; delete is permanent.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TICKET_FORM_ACTIONS], description: 'The action to perform' },
          id: { type: 'string', description: 'Form UUID (update/delete)' },
          orgId: { type: 'string', description: 'available: the organization UUID. create: owner org when ownerScope is organization' },
          data: {
            type: 'object',
            description: 'create/update payload as in the UI: name, fields[{key,label,type,required}], ownerScope organization|partner, showInPortal, isActive, categoryId',
          },
          ...pageParamSchema(50, 200),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      const action = input.action as FormAction;
      if (!TICKET_FORM_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (action !== 'list' && action !== 'available' && isAgentPrincipal(auth)) return agentRefusal(action);

      try {
        if (action === 'list') {
          const page = readPageArgs('manage_ticket_forms', input, LIST_PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const rows = await db
            .select()
            .from(ticketForms)
            .where(formAccessCondition(auth))
            .orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name));
          const window = rows.slice(page.offset, page.offset + page.limit + 1);
          const linkMap = await getTicketFormOrgLinkMap(window.map((r) => r.id));
          const items = window.map((r) => ({ ...r, visibleOrgIds: linkMap.get(r.id) ?? null }));
          return json(pageEnvelope({ key: 'forms', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: rows.length }));
        }

        if (action === 'available') {
          const orgId = guid.safeParse(input.orgId);
          if (!orgId.success) return jsonError('orgId must be an organization UUID', 'VALIDATION_ERROR');
          // Access check BEFORE any fetch: this feeds the creation picker and must not leak existence.
          if (!auth.canAccessOrg(orgId.data)) return jsonError('Access denied to this organization', 'ACCESS_DENIED');
          const orgRows = await db
            .select({ id: organizations.id, partnerId: organizations.partnerId })
            .from(organizations)
            .where(eq(organizations.id, orgId.data))
            .limit(1);
          const org = orgRows[0];
          if (!org) return jsonError('Organization not found', 'NOT_FOUND');
          return json({ forms: await listTicketFormsForOrg({ id: org.id, partnerId: org.partnerId }) });
        }

        if (action === 'create') {
          // #6907/#6911: a supervised agent proposal is released AS THE APPROVER (USER_OWNED_RELEASE_ACTIONS,
          // jobs/intentReleaseWorker.ts); created_by is a users FK, so refuse when the handed auth is not that approver.
          if (approverReleaseMismatch(auth, context)) return jsonError('Approver release mismatch', 'APPROVER_RELEASE_MISMATCH');
          const parsed = parseData(createTicketFormSchema, input.data);
          if ('error' in parsed) return parsed.error;
          const payload = parsed.value;
          if (payload.visibleOrgIds !== undefined && payload.ownerScope !== 'partner') {
            return jsonError(VISIBLE_ORG_IDS_SCOPE_ERROR);
          }
          // Ownership axis: the partner is ALWAYS the caller's own, never client-supplied.
          let owner: { orgId: string | null; partnerId: string | null };
          if (payload.ownerScope === 'partner') {
            if (!auth.partnerId) return jsonError('Partner-wide forms require partner scope', 'ACCESS_DENIED');
            if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
            owner = { orgId: null, partnerId: auth.partnerId };
          } else {
            const requested = payload.orgId ?? (typeof input.orgId === 'string' ? input.orgId : undefined);
            if (auth.scope === 'organization') {
              if (!auth.orgId || (requested && requested !== auth.orgId)) return jsonError('Organization context required', 'ACCESS_DENIED');
              owner = { orgId: auth.orgId, partnerId: null };
            } else {
              if (!requested || !auth.canAccessOrg(requested)) return jsonError('orgId is required and must be accessible');
              owner = { orgId: requested, partnerId: null };
            }
          }
          if (payload.categoryId) await assertCategoryInPartner(payload.categoryId, await effectivePartnerId(owner));

          const [row] = await db
            .insert(ticketForms)
            .values({
              orgId: owner.orgId,
              partnerId: owner.partnerId,
              name: payload.name,
              description: payload.description ?? null,
              categoryId: payload.categoryId ?? null,
              fields: payload.fields,
              titleTemplate: payload.titleTemplate ?? null,
              descriptionIntro: payload.descriptionIntro ?? null,
              defaultPriority: payload.defaultPriority ?? null,
              defaultTags: payload.defaultTags,
              showInPortal: payload.showInPortal,
              isActive: payload.isActive,
              sortOrder: payload.sortOrder,
              createdBy: auth.user.id,
              version: 1,
            })
            .returning();
          if (!row) return jsonError('Failed to create ticket form');
          const visibleOrgIds = normalizeVisibleOrgIds(payload.visibleOrgIds);
          if (payload.ownerScope === 'partner') {
            try {
              await syncTicketFormOrgLinks(row.id, visibleOrgIds, auth.partnerId!);
            } catch (err) {
              // No orphaned half-created form; the rollback must not mask the original error.
              try { await db.delete(ticketForms).where(eq(ticketForms.id, row.id)); } catch { /* original error wins */ }
              throw err;
            }
          }
          return json({ form: { ...row, visibleOrgIds } });
        }

        // update / delete address one form.
        const id = guid.safeParse(input.id);
        if (!id.success) return jsonError(`id (form UUID) is required for ${action}`, 'VALIDATION_ERROR');
        const row = await getFormWithAccess(id.data, auth);
        if (!row) return jsonError('Ticket form not found', 'NOT_FOUND');
        if (row.orgId === null && !canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');

        if (action === 'delete') {
          // Hard delete per spec: existing tickets keep the rendered description + intake snapshot.
          await db.delete(ticketForms).where(eq(ticketForms.id, row.id));
          return json({ deleted: true, id: row.id });
        }

        const parsed = parseData(updateTicketFormSchema, input.data);
        if ('error' in parsed) return parsed.error;
        const payload = parsed.value;
        if (payload.visibleOrgIds !== undefined && row.orgId !== null) return jsonError(VISIBLE_ORG_IDS_SCOPE_ERROR);
        if (payload.categoryId) {
          await assertCategoryInPartner(payload.categoryId, await effectivePartnerId({ orgId: row.orgId, partnerId: row.partnerId }));
        }
        // Sync BEFORE the column update, so a rejected sync leaves the form row untouched.
        if (payload.visibleOrgIds !== undefined) {
          await syncTicketFormOrgLinks(row.id, normalizeVisibleOrgIds(payload.visibleOrgIds), row.partnerId!);
        }
        const { visibleOrgIds: _links, ...columns } = payload;
        const bumpVersion = payload.fields !== undefined || payload.titleTemplate !== undefined;
        const [updated] = await db
          .update(ticketForms)
          .set({ ...columns, ...(bumpVersion ? { version: row.version + 1 } : {}), updatedAt: new Date() })
          .where(eq(ticketForms.id, row.id))
          .returning();
        if (!updated) return jsonError('Failed to update ticket form');
        return json({ form: updated });
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
