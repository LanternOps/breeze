/**
 * AI Deliverable Tools (#5573 spec §10)
 *
 *  - `list_deliverables`   — deliverables of one org, optionally with the
 *    recent occurrences of one of them. Read-only.
 *  - `manage_deliverables` — create / update / deactivate a deliverable;
 *    deliver / waive / reopen / reschedule an occurrence; link an existing
 *    report run as evidence.
 *  - `manage_key_dates`    — list / create / update / delete org key dates.
 *
 * `apply_template` is deliberately ABSENT: template sets land in W05, and that
 * action is the only approval-gated one in this family (it arms unattended
 * ticket creation). Everything here is tier 2 and ungated.
 *
 * This is a second door onto the same services as routes/serviceDeliverables.ts
 * and routes/orgKeyDates.ts, so it must agree with them:
 *  - permissions: `contracts:read` / `contracts:write` (TOOL_PERMISSIONS);
 *  - scope: partner or system sessions only — the routes' requireScope. There
 *    is no route scanner covering aiTools, so the gate is repeated here;
 *  - payloads: parsed with the SAME @breeze/shared schemas the routes validate
 *    with, so a malformed call is a structured VALIDATION_ERROR, never an
 *    opaque database 500;
 *  - org access: the SERVICE layer answers 404 NOT_FOUND (never 403) for an org
 *    outside the session's accessibleOrgIds, via the DeliverableActor.
 *
 * Structure (for sibling waves): one exported const per tool, registered by
 * registerDeliverableTools. W03 appends its document tools the same way.
 */
import { z } from 'zod';
import {
  createDeliverableSchema, updateDeliverableSchema, deliverOccurrenceSchema, waiveOccurrenceSchema,
  rescheduleOccurrenceSchema, reportRunEvidenceRefSchema, createKeyDateSchema, updateKeyDateSchema,
} from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listDeliverables, createDeliverable, updateDeliverable, deactivateDeliverable,
  listOccurrences, deliverOccurrence, waiveOccurrence, reopenOccurrence,
  rescheduleOccurrence, addEvidence, DeliverableServiceError, type DeliverableActor,
} from './serviceDeliverableService';
import { listKeyDates, createKeyDate, updateKeyDate, deleteKeyDate } from './orgKeyDateService';
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';

export const MANAGE_DELIVERABLES_ACTIONS = [
  'create', 'update', 'deactivate', 'deliver', 'waive', 'reopen', 'reschedule', 'link_evidence',
] as const;
export const MANAGE_KEY_DATES_ACTIONS = ['list', 'create', 'update', 'delete'] as const;

/** Presence-checked BEFORE any coercion, so a missing id can never become the
 *  literal string "undefined" and die downstream as an opaque 500. */
const MANAGE_DELIVERABLES_REQUIRED: Record<(typeof MANAGE_DELIVERABLES_ACTIONS)[number], readonly string[]> = {
  create: ['orgId', 'input'], update: ['orgId', 'deliverableId', 'patch'], deactivate: ['orgId', 'deliverableId'],
  deliver: ['orgId', 'occurrenceId'], waive: ['orgId', 'occurrenceId', 'reason'], reopen: ['orgId', 'occurrenceId'],
  reschedule: ['orgId', 'occurrenceId', 'dueAt'], link_evidence: ['orgId', 'occurrenceId', 'reportRunId'],
};
const MANAGE_KEY_DATES_REQUIRED: Record<(typeof MANAGE_KEY_DATES_ACTIONS)[number], readonly string[]> = {
  list: ['orgId'], create: ['orgId', 'input'], update: ['orgId', 'keyDateId', 'patch'], delete: ['orgId', 'keyDateId'],
};

// Payloads wrapped under their param name so ZodError paths are
// self-describing ("input.cadence: ...") for the calling model.
const createDeliverablePayload = z.object({ input: createDeliverableSchema });
const updateDeliverablePayload = z.object({ patch: updateDeliverableSchema });
const createKeyDatePayload = z.object({ input: createKeyDateSchema });
const updateKeyDatePayload = z.object({ patch: updateKeyDateSchema });

function actorFromAuth(auth: AuthContext): DeliverableActor {
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}

function partnerScopeRefusal(auth: AuthContext): string | null {
  if (auth.scope === 'partner' || auth.scope === 'system') return null;
  return JSON.stringify({
    error: 'Service deliverables and key dates require a partner-scoped session',
    code: 'PARTNER_SCOPE_REQUIRED',
  });
}

/** Service and validation errors become a tool result the model can act on;
 *  anything else is a real failure and propagates. */
function toToolError(err: unknown): string {
  if (err instanceof DeliverableServiceError) {
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  const zod = zodErrorToJson(err);
  if (zod) return zod;
  throw err;
}

const unknownAction = (action: string) => JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
const optionalString = (v: unknown): string | undefined => (v == null ? undefined : String(v));

export const LIST_DELIVERABLES_TOOL: AiTool = {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'list_deliverables',
    description:
      'List service deliverables (scheduled recurring service obligations, such as a monthly sign-in log review) for one organization, '
      + 'with cadence, next due date, last delivery and status (on_track / due_soon / late / missed / inactive). '
      + 'Pass occurrencesFor to also get the recent occurrences of one deliverable. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Organization id (UUID)' },
        contractId: { type: 'string', description: 'Only deliverables attached to this contract (UUID)' },
        includeInactive: { type: 'boolean', description: 'Include deactivated deliverables (default false)' },
        occurrencesFor: { type: 'string', description: 'Also return the recent occurrences of this deliverable id (UUID)' },
      },
      required: ['orgId'],
    },
  },
  handler: async (input, auth) => {
    const refusal = partnerScopeRefusal(auth);
    if (refusal) return refusal;
    const missing = missingParamsJson(input, 'list', ['orgId']);
    if (missing) return missing;
    const actor = actorFromAuth(auth);
    const orgId = String(input.orgId);
    try {
      const deliverables = await listDeliverables(orgId, {
        contractId: optionalString(input.contractId),
        includeInactive: input.includeInactive === true,
      }, actor);
      const occurrences = input.occurrencesFor
        ? await listOccurrences(orgId, String(input.occurrencesFor), { limit: 24 }, actor)
        : undefined;
      return JSON.stringify({ deliverables, showing: deliverables.length, ...(occurrences ? { occurrences } : {}) });
    } catch (err) { return toToolError(err); }
  },
};

export const MANAGE_DELIVERABLES_TOOL: AiTool = {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'manage_deliverables',
    description:
      'Create and manage service deliverables and their occurrences for one organization: create, update or deactivate a deliverable; '
      + 'deliver, waive, reopen or reschedule an occurrence; or link an existing report run as evidence. '
      + 'Delivering an occurrence whose deliverable requires an artifact fails with EVIDENCE_REQUIRED until evidence is linked.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...MANAGE_DELIVERABLES_ACTIONS] },
        orgId: { type: 'string', description: 'Organization id (UUID)' },
        deliverableId: { type: 'string', description: 'Deliverable id (update, deactivate)' },
        occurrenceId: { type: 'string', description: 'Occurrence id (deliver, waive, reopen, reschedule, link_evidence)' },
        input: { type: 'object', description: 'Create payload: name, cadence (monthly|quarterly|semiannual|annual|one_time), anchorDueDate, effectiveFrom (YYYY-MM-DD), optional contractId, leadDays, graceDays, artifactRequired, completionMode, ownerUserId, ticketCategoryId, autoEvidenceReportId, portalVisible' },
        patch: { type: 'object', description: 'Update payload (any create field except cadence and anchorDueDate, plus active)' },
        note: { type: 'string', description: 'Delivery note (deliver)' },
        reason: { type: 'string', description: 'Waiver reason (waive)' },
        dueAt: { type: 'string', description: 'New due date, YYYY-MM-DD (reschedule)' },
        reportRunId: { type: 'string', description: 'Report run to attach as evidence (link_evidence)' },
      },
      required: ['action'],
    },
  },
  handler: async (input, auth) => {
    const action = String(input.action);
    const required = (MANAGE_DELIVERABLES_REQUIRED as Record<string, readonly string[] | undefined>)[action];
    if (!required) return unknownAction(action);
    const refusal = partnerScopeRefusal(auth);
    if (refusal) return refusal;
    const missing = missingParamsJson(input, action, required);
    if (missing) return missing;
    const actor = actorFromAuth(auth);
    const orgId = String(input.orgId);
    try {
      switch (action) {
        case 'create': {
          const { input: body } = createDeliverablePayload.parse({ input: input.input });
          return JSON.stringify(await createDeliverable(orgId, body, actor));
        }
        case 'update': {
          const { patch } = updateDeliverablePayload.parse({ patch: input.patch });
          return JSON.stringify(await updateDeliverable(orgId, String(input.deliverableId), patch, actor));
        }
        case 'deactivate':
          await deactivateDeliverable(orgId, String(input.deliverableId), actor);
          return JSON.stringify({ ok: true });
        case 'deliver':
          return JSON.stringify(await deliverOccurrence(orgId, String(input.occurrenceId),
            deliverOccurrenceSchema.parse({ note: optionalString(input.note) }), actor));
        case 'waive':
          return JSON.stringify(await waiveOccurrence(orgId, String(input.occurrenceId),
            waiveOccurrenceSchema.parse({ reason: input.reason }), actor));
        case 'reopen':
          return JSON.stringify(await reopenOccurrence(orgId, String(input.occurrenceId), actor));
        case 'reschedule':
          return JSON.stringify(await rescheduleOccurrence(orgId, String(input.occurrenceId),
            rescheduleOccurrenceSchema.parse({ dueAt: input.dueAt }), actor));
        case 'link_evidence':
          return JSON.stringify(await addEvidence(orgId, String(input.occurrenceId),
            reportRunEvidenceRefSchema.parse({ kind: 'report_run', reportRunId: input.reportRunId }), actor));
        default:
          return unknownAction(action);
      }
    } catch (err) { return toToolError(err); }
  },
};

export const MANAGE_KEY_DATES_TOOL: AiTool = {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'manage_key_dates',
    description:
      'List, create, update or delete organization key dates (insurance renewals, vendor contract ends, compliance deadlines, audits). '
      + 'A key date with remindDaysBefore opens a reminder ticket that many days ahead; recursAnnually rolls it forward each year. '
      + 'Listing also returns upcoming contract end dates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...MANAGE_KEY_DATES_ACTIONS] },
        orgId: { type: 'string', description: 'Organization id (UUID)' },
        keyDateId: { type: 'string', description: 'Key date id (update, delete)' },
        input: { type: 'object', description: 'Create payload: label, date (YYYY-MM-DD), optional kind (insurance_renewal|vendor_contract_end|compliance_deadline|audit|other), recursAnnually, remindDaysBefore, ownerUserId, portalVisible, notes' },
        patch: { type: 'object', description: 'Update payload (any create field)' },
      },
      required: ['action', 'orgId'],
    },
  },
  handler: async (input, auth) => {
    const action = String(input.action);
    const required = (MANAGE_KEY_DATES_REQUIRED as Record<string, readonly string[] | undefined>)[action];
    if (!required) return unknownAction(action);
    const refusal = partnerScopeRefusal(auth);
    if (refusal) return refusal;
    const missing = missingParamsJson(input, action, required);
    if (missing) return missing;
    const actor = actorFromAuth(auth);
    const orgId = String(input.orgId);
    try {
      switch (action) {
        case 'list':
          return JSON.stringify({ keyDates: await listKeyDates(orgId, actor, { includeContractEnds: true }) });
        case 'create': {
          const { input: body } = createKeyDatePayload.parse({ input: input.input });
          return JSON.stringify(await createKeyDate(orgId, body, actor));
        }
        case 'update': {
          const { patch } = updateKeyDatePayload.parse({ patch: input.patch });
          return JSON.stringify(await updateKeyDate(orgId, String(input.keyDateId), patch, actor));
        }
        case 'delete':
          await deleteKeyDate(orgId, String(input.keyDateId), actor);
          return JSON.stringify({ ok: true });
        default:
          return unknownAction(action);
      }
    } catch (err) { return toToolError(err); }
  },
};

export function registerDeliverableTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_deliverables', LIST_DELIVERABLES_TOOL);
  aiTools.set('manage_deliverables', MANAGE_DELIVERABLES_TOOL);
  aiTools.set('manage_key_dates', MANAGE_KEY_DATES_TOOL);
}
