/**
 * `manage_contract_templates` and `manage_contract_documents` (full-control
 * W14, #6784): the AI twins of the agreement-template library
 * (routes/contracts/templates.ts) and the signed-agreement list / link-later
 * (routes/contracts/documents.ts), through the same services
 * (contractTemplateService.ts, contractDocumentService.ts).
 *
 * Classes (W14 plan, facts 7–8, quorum QW2/QW4/QW5):
 *  - template `list` / `get` / `get_version` / `usage` and document `list` t1;
 *  - template `create` / `update` t2 for an org-owned template, supervised
 *    when the call asserts `ownerScope: 'partner'` (isInputAwareTier3). The
 *    handler refuses an assertion that does not match the row (ownership is
 *    immutable, and the handler runs again at release);
 *  - template `create_version` / `publish` / `archive` supervised and refused
 *    for a partner-wide template (each is irreversible; irreversible +
 *    partner-wide is four-eyes, W14-D5);
 *  - document `link` supervised (an executed legal record's filing cannot be
 *    undone); the service UPDATE only matches an unlinked row (QW5).
 * Every write is AGENT_HUMAN_ONLY_ACTIONS (legal documents customers sign).
 *
 * Projections (W14-D6): no version body in list / get / write results, never
 * the stored bytes, no signer email or acceptance reference, `link` returns
 * identifiers only. REST has no MFA on these routes, so the tools have none.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { createContractTemplateSchema, updateContractTemplateSchema, createTemplateVersionSchema } from '@breeze/shared';
import {
  ContractTemplateServiceError, PartnerWideWriteDeniedError, archiveTemplate, createDraftVersion, createTemplate,
  getTemplate, getTemplateUsage, getTemplateVersion, listTemplates, publishVersion, updateTemplate,
  type TemplateRow,
} from './contractTemplateService';
import { ContractDocumentServiceError, linkContractDocument, listContractDocuments } from './contractDocumentService';
import { CONTRACT_DOCUMENT_ACTIONS, CONTRACT_TEMPLATE_ACTIONS } from './aiToolSchemasBilling';
import { auditToolWrite, bounded, deviceBoundDenied, jsonError, orgWideWriteDenied, thrown } from './aiToolsSoftwareShared';

type TemplateAction = (typeof CONTRACT_TEMPLATE_ACTIONS)[number];
type DocumentAction = (typeof CONTRACT_DOCUMENT_ACTIONS)[number];

/** Most templates / documents one list returns. */
export const MAX_TEMPLATES_LISTED = 200;
export const MAX_DOCUMENTS_LISTED = 200;
/** get_version clips an authored body to this many characters. */
export const MAX_TEMPLATE_BODY_CHARS = 20_000;

/** REST: requireScope('partner', 'organization', 'system'). */
function scopeRefusal(auth: AuthContext, what: string): string | null {
  if (auth.scope === 'system' || auth.scope === 'organization' || (auth.scope === 'partner' && auth.partnerId)) return null;
  return jsonError(`${what} needs a partner-, organization- or system-scoped session`, 'ACCESS_DENIED');
}

function serviceError(err: unknown): string | null {
  if (err instanceof ContractTemplateServiceError) return jsonError(err.message, err.code);
  if (err instanceof ContractDocumentServiceError) return jsonError(err.message, err.code);
  if (err instanceof PartnerWideWriteDeniedError) return jsonError(err.message, 'ACCESS_DENIED');
  return null;
}

function invalid(issues: { message: string; path: PropertyKey[] }[] | undefined): string {
  const first = issues?.[0];
  const where = first?.path.length ? `${first.path.map(String).join('.')}: ` : '';
  return jsonError(`${where}${first?.message ?? 'Invalid input'}`, 'VALIDATION_ERROR');
}

type VersionLike = {
  id: string; templateId: string; orgId: string | null; partnerId: string | null; versionNumber: number;
  status: string; sourceType: string; mime?: string | null; byteSize?: number | null; sha256?: string | null;
  declaredVariables?: unknown; publishedAt?: Date | null; createdAt?: Date;
};

/** A version without its body or bytes (W14-D6). */
/** XOR ownership (contract_templates_one_owner_chk): org-owned or partner-wide. */
const ownerScopeOf = (row: { orgId: string | null }): 'organization' | 'partner' => (row.orgId === null ? 'partner' : 'organization');

function presentVersionSummary(v: VersionLike) {
  return {
    id: v.id, templateId: v.templateId, versionNumber: v.versionNumber, status: v.status, sourceType: v.sourceType,
    mime: v.mime ?? null, byteSize: v.byteSize ?? null, sha256: v.sha256 ?? null, declaredVariables: v.declaredVariables ?? [],
    publishedAt: v.publishedAt ?? null, createdAt: v.createdAt, ownerScope: ownerScopeOf(v),
  };
}

function presentTemplate(t: TemplateRow) {
  return {
    id: t.id, name: t.name, description: t.description, status: t.status,
    ownerScope: ownerScopeOf(t), orgId: t.orgId, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

function auditTemplate(auth: AuthContext, t: Pick<TemplateRow, 'id' | 'orgId' | 'partnerId' | 'name'>, action: string, details: Record<string, unknown> = {}): void {
  auditToolWrite(auth, {
    orgId: t.orgId, partnerId: t.partnerId, action, resourceType: 'contract_template', resourceId: t.id,
    resourceName: t.name, details: { ...details, ownerScope: ownerScopeOf(t), tool_name: 'manage_contract_templates' },
  });
}

async function templateWrite(action: TemplateAction, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (action === 'create') {
    const ownerScope = input.ownerScope ?? 'organization';
    if (ownerScope === 'organization') {
      const denied = orgWideWriteDenied(auth, 'An agreement template');
      if (denied) return denied;
    }
    const parsed = createContractTemplateSchema.safeParse({
      ownerScope,
      ...(typeof input.orgId === 'string' ? { orgId: input.orgId } : {}),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    if (!parsed.success) return invalid(parsed.error.issues);
    const row = await createTemplate(auth, parsed.data);
    auditTemplate(auth, row, 'contract_template.create');
    return bounded({ template: presentTemplate(row) });
  }

  if (typeof input.templateId !== 'string') return jsonError('templateId is required', 'VALIDATION_ERROR');
  const { versions: _versions, ...existing } = await getTemplate(auth, input.templateId);
  const actual = ownerScopeOf(existing);
  if (action === 'update') {
    // The class was decided from the asserted ownerScope (isInputAwareTier3); it must be the row's.
    const asserted = input.ownerScope ?? 'organization';
    if (asserted !== actual) {
      return jsonError(`This template is ${actual === 'partner' ? 'partner-wide' : 'organization-owned'}; pass ownerScope: '${actual}'`, 'OWNER_SCOPE_MISMATCH');
    }
  } else if (actual === 'partner') {
    return jsonError('Draft versions, publishing and archiving of partner-wide agreement templates are done in the web app', 'ACCESS_DENIED');
  }
  if (actual === 'organization') {
    const denied = orgWideWriteDenied(auth, 'An agreement template');
    if (denied) return denied;
  }

  if (action === 'update') {
    const parsed = updateContractTemplateSchema.safeParse({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    if (!parsed.success) return invalid(parsed.error.issues);
    if (Object.keys(parsed.data).length === 0) return jsonError('Nothing to update (name or description)', 'VALIDATION_ERROR');
    const row = await updateTemplate(auth, existing.id, parsed.data);
    auditTemplate(auth, row, 'contract_template.update', {
      changedFields: Object.keys(parsed.data), before: { name: existing.name, description: existing.description },
    });
    return bounded({ template: presentTemplate(row), before: { name: existing.name, description: existing.description } });
  }
  if (action === 'create_version') {
    const parsed = createTemplateVersionSchema.safeParse({ bodyHtml: input.bodyHtml });
    if (!parsed.success) return invalid(parsed.error.issues);
    const { warnings, ...version } = await createDraftVersion(auth, existing.id, parsed.data);
    auditTemplate(auth, existing, 'contract_template.version.create', { versionId: version.id, versionNumber: version.versionNumber });
    return bounded({ version: presentVersionSummary(version), warnings });
  }
  if (action === 'publish') {
    if (typeof input.versionId !== 'string') return jsonError('versionId is required', 'VALIDATION_ERROR');
    const version = await publishVersion(auth, existing.id, input.versionId);
    auditTemplate(auth, existing, 'contract_template.version.publish', { versionId: version.id, versionNumber: version.versionNumber, sha256: version.sha256 });
    return bounded({ version: presentVersionSummary(version) });
  }
  await archiveTemplate(auth, existing.id);
  auditTemplate(auth, existing, 'contract_template.archive');
  return bounded({ archived: true, templateId: existing.id });
}

async function templateRead(action: TemplateAction, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (action === 'list') {
    const rows = await listTemplates(auth, { includeArchived: input.includeArchived === true });
    return bounded({
      templates: rows.slice(0, MAX_TEMPLATES_LISTED).map(({ latestVersion, ...t }) => ({
        ...presentTemplate(t), latestVersion: latestVersion ? presentVersionSummary(latestVersion) : null,
      })),
      total: rows.length,
      ...(rows.length > MAX_TEMPLATES_LISTED ? { truncated: true } : {}),
    });
  }
  if (typeof input.templateId !== 'string') return jsonError('templateId is required', 'VALIDATION_ERROR');
  if (action === 'get') {
    const { versions, ...t } = await getTemplate(auth, input.templateId);
    return bounded({ template: { ...presentTemplate(t), versions: versions.map(presentVersionSummary) } });
  }
  if (action === 'usage') return bounded({ templateId: input.templateId, usage: await getTemplateUsage(auth, input.templateId) });
  // get_version
  if (typeof input.versionId !== 'string') return jsonError('versionId is required', 'VALIDATION_ERROR');
  const v = await getTemplateVersion(auth, input.templateId, input.versionId);
  const body = v.bodyHtml ?? null;
  return bounded({
    version: {
      ...presentVersionSummary(v),
      bodyHtml: body === null ? null : body.slice(0, MAX_TEMPLATE_BODY_CHARS),
      ...(body !== null && body.length > MAX_TEMPLATE_BODY_CHARS ? { bodyTruncated: true } : {}),
    },
  });
}

export function registerContractTemplateTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_contract_templates', {
    tier: 1,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'agreement / contract templates customers sign: list, read, draft a version, publish, archive',
    definition: {
      name: 'manage_contract_templates',
      description: 'Agreement templates attached to quotes and signature requests. Actions: list, get, get_version, usage, create, update, create_version, publish, archive (the last three need approval, org-owned templates only). Pass ownerScope partner for a partner-wide template.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...CONTRACT_TEMPLATE_ACTIONS], description: 'The action to perform' },
          templateId: { type: 'string', description: 'Template UUID (all but list / create)' },
          versionId: { type: 'string', description: 'get_version / publish: version UUID' },
          orgId: { type: 'string', description: 'create: owning org (organization-owned)' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create / update: the template\'s owner (default organization; must match the template)' },
          includeArchived: { type: 'boolean', description: 'list: include archived templates' },
          name: { type: 'string' },
          description: { type: 'string' },
          bodyHtml: { type: 'string', description: 'create_version: the draft body (rich-text HTML, {{ variable }} placeholders)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as TemplateAction;
      if (!CONTRACT_TEMPLATE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const refusal = scopeRefusal(auth, 'Agreement templates');
      if (refusal) return refusal;
      try {
        if (action === 'list' || action === 'get' || action === 'get_version' || action === 'usage') {
          const bound = deviceBoundDenied(auth, 'The agreement template library');
          if (bound) return bound;
          return await templateRead(action, input, auth);
        }
        return await templateWrite(action, input, auth);
      } catch (error) {
        return serviceError(error) ?? thrown('manage_contract_templates', error);
      }
    },
  });

  aiTools.set('manage_contract_documents', {
    tier: 1,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'signed agreements: list executed contract documents, file an unlinked one under its contract',
    definition: {
      name: 'manage_contract_documents',
      description: 'Signed agreements (executed contract documents). Actions: list (default: not yet filed under a contract), link (file an unlinked document under a same-org contract, needs approval, cannot be undone).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...CONTRACT_DOCUMENT_ACTIONS], description: 'The action to perform' },
          documentId: { type: 'string', description: 'link: document UUID' },
          contractId: { type: 'string', description: 'list: one contract\'s documents; link: the contract to file it under' },
          orgId: { type: 'string', description: 'list: one org' },
          linked: { type: 'string', enum: ['all', 'linked', 'unlinked'], description: 'list: link-state filter (default unlinked)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as DocumentAction;
      if (!CONTRACT_DOCUMENT_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const refusal = scopeRefusal(auth, 'Signed agreements');
      if (refusal) return refusal;
      try {
        if (action === 'list') {
          const bound = deviceBoundDenied(auth, 'Signed agreements');
          if (bound) return bound;
          const rows = await listContractDocuments(auth, {
            ...(typeof input.contractId === 'string' ? { contractId: input.contractId } : {}),
            ...(typeof input.orgId === 'string' ? { orgId: input.orgId } : {}),
            linked: (typeof input.linked === 'string' ? input.linked : 'unlinked') as 'all' | 'linked' | 'unlinked',
          });
          return bounded({
            // W14-D6: no signer email, no acceptance reference.
            documents: rows.slice(0, MAX_DOCUMENTS_LISTED).map(({ signerEmail: _e, acceptanceReference: _r, ...row }) => row),
            total: rows.length,
            ...(rows.length > MAX_DOCUMENTS_LISTED ? { truncated: true } : {}),
          });
        }
        if (typeof input.documentId !== 'string' || typeof input.contractId !== 'string') {
          return jsonError('documentId and contractId are required', 'VALIDATION_ERROR');
        }
        const denied = orgWideWriteDenied(auth, 'Filing a signed agreement');
        if (denied) return denied;
        const doc = await linkContractDocument(auth, input.documentId, input.contractId);
        auditToolWrite(auth, {
          orgId: doc.orgId, action: 'contract.document.link', resourceType: 'contract_document', resourceId: doc.id,
          details: { contractId: input.contractId, tool_name: 'manage_contract_documents' },
        });
        // QW4: identifiers only — never the stored bytes or the signer evidence.
        return bounded({ linked: true, documentId: doc.id, contractId: input.contractId });
      } catch (error) {
        return serviceError(error) ?? thrown('manage_contract_documents', error);
      }
    },
  });
}
