/**
 * AI tools for service deliverables (spec #5573 §10).
 *
 * W03 contributes the two organization-document tools:
 *  - `list_org_documents`   — metadata of the current version of every document
 *    in an org's library (or every version, on request). Read-only.
 *  - `manage_org_documents` — edit metadata, toggle portal visibility, or link
 *    one existing document as the newer version of another.
 *
 * Byte upload stays OUT of MCP by design (spec §3 "Out (v1)"): no action here
 * accepts file content, and no tool ever returns bytes, storage keys, or URLs.
 * Neither tool is approval-gated (spec §10: only `apply_template` is).
 *
 * W02 adds its deliverable/key-date tools to this module; each tool is one
 * exported const and `registerDeliverableTools` registers them, so the two
 * waves merge additively.
 *
 * Org access is enforced by `orgDocumentService` (404 `NOT_FOUND`, never 403);
 * a thrown `DeliverableServiceError` is converted to a JSON error string rather
 * than propagated.
 */

import { z } from 'zod';
import { updateDocumentSchema, type OrgDocumentCategory } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import { listDocuments, supersedeDocument, updateDocument } from './orgDocumentService';
import { DeliverableServiceError, type DeliverableActor } from './serviceDeliverableService';
import { missingParamsJson, validationErrorJson, zodErrorToJson } from './aiToolValidation';

const ORG_DOCUMENT_CATEGORIES: readonly OrgDocumentCategory[] = [
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
];

function actorFromAuth(auth: AuthContext): DeliverableActor {
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof DeliverableServiceError) {
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  return null;
}

/**
 * Params each manage_org_documents action requires, presence-checked BEFORE
 * any `String(...)` coercion so a missing id can't become the literal string
 * "undefined" (#2362 sweep).
 */
const MANAGE_ORG_DOCUMENTS_REQUIRED: Record<string, readonly string[]> = {
  update_metadata: ['orgId', 'documentId', 'patch'],
  set_portal_visibility: ['orgId', 'documentId', 'portalVisible'],
  supersede: ['orgId', 'documentId', 'supersedesDocumentId'],
};

// Wrapped under the param name so ZodError paths read `patch.title: …`.
const patchPayload = z.object({ patch: updateDocumentSchema });

export const listOrgDocumentsTool: AiTool = {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'list_org_documents',
    description:
      'List the current version of every document in an organization\'s library (runbooks, baselines, policies, '
      + 'exports, delivery evidence). Returns metadata only — titles, categories, sizes, versions and portal visibility — '
      + 'never the file bytes. Set includeSuperseded to also list older versions. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Organization UUID' },
        category: { type: 'string', enum: [...ORG_DOCUMENT_CATEGORIES] },
        includeSuperseded: { type: 'boolean', description: 'Include older versions (default false)' },
      },
      required: ['orgId'],
    },
  },
  handler: async (input, auth) => {
    const missing = missingParamsJson(input, 'list', ['orgId']);
    if (missing) return missing;
    try {
      const rows = await listDocuments(String(input.orgId), {
        category: input.category ? (String(input.category) as OrgDocumentCategory) : undefined,
        includeSuperseded: input.includeSuperseded === true,
      }, actorFromAuth(auth));
      return JSON.stringify({ documents: rows, showing: rows.length });
    } catch (err) {
      const json = serviceErrorToJson(err);
      if (json) return json;
      throw err;
    }
  },
};

export const manageOrgDocumentsTool: AiTool = {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'manage_org_documents',
    description:
      'Manage documents already in an organization\'s library. update_metadata edits title, description, category '
      + 'and/or portalVisible; set_portal_visibility shows or hides a document on the customer portal; supersede marks '
      + 'documentId as the newer version of supersedesDocumentId (both must be current versions). Files cannot be '
      + 'added or replaced here — only a technician can put file content into the library, from the web app.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['update_metadata', 'set_portal_visibility', 'supersede'] },
        orgId: { type: 'string', description: 'Organization UUID' },
        documentId: { type: 'string', description: 'Document UUID' },
        supersedesDocumentId: { type: 'string', description: 'For supersede: the older document UUID' },
        portalVisible: { type: 'boolean', description: 'For set_portal_visibility' },
        patch: {
          type: 'object',
          description: 'For update_metadata: any of title (1-200 chars), description (string or null), '
            + `category (${ORG_DOCUMENT_CATEGORIES.join(' | ')}), portalVisible (boolean).`,
        },
      },
      required: ['action', 'orgId'],
    },
  },
  handler: async (input, auth) => {
    const action = String(input.action);
    const required = MANAGE_ORG_DOCUMENTS_REQUIRED[action];
    if (!required) return validationErrorJson(`Unknown action: ${action}`);
    const missing = missingParamsJson(input, action, required);
    if (missing) return missing;

    const actor = actorFromAuth(auth);
    const orgId = String(input.orgId);
    const documentId = String(input.documentId);
    try {
      switch (action) {
        case 'update_metadata':
          return JSON.stringify(await updateDocument(orgId, documentId, patchPayload.parse({ patch: input.patch }).patch, actor));
        case 'set_portal_visibility':
          if (typeof input.portalVisible !== 'boolean') return validationErrorJson('portalVisible must be a boolean');
          return JSON.stringify(await updateDocument(orgId, documentId, { portalVisible: input.portalVisible }, actor));
        case 'supersede':
          return JSON.stringify(await supersedeDocument(orgId, documentId, String(input.supersedesDocumentId), actor));
        default:
          return validationErrorJson(`Unknown action: ${action}`);
      }
    } catch (err) {
      const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
      if (json) return json;
      throw err;
    }
  },
};

export function registerDeliverableTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_org_documents', listOrgDocumentsTool);
  aiTools.set('manage_org_documents', manageOrgDocumentsTool);
}
