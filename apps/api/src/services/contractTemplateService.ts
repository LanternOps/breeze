import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  ContractVariable,
  CreateContractTemplateInput,
  UpdateContractTemplateInput,
} from '@breeze/shared';
import { AUTO_CONTRACT_VARIABLES } from '@breeze/shared';
import { db } from '../db';
import { contractTemplates, contractTemplateVersions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { sanitizeRichTextHtml } from './richTextSanitize';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from './partnerWideAccess';

// Re-exported for back-compat / single-import convenience, mirroring
// configurationPolicy.ts — routes and AI tools can import the capability gate
// straight from here without also reaching into partnerWideAccess.ts.
export { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError };

export type TemplateRow = typeof contractTemplates.$inferSelect;
export type VersionRow = typeof contractTemplateVersions.$inferSelect;
export type TemplateWithLatest = TemplateRow & { latestVersion: VersionRow | null };

export class ContractTemplateServiceError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = 'ContractTemplateServiceError';
  }
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = '%PDF-';

// Matches the token used inside `{{ name }}` placeholders in an authored
// template body. Kept in lockstep with contractVariableSchema's `name`
// pattern in packages/shared/src/validators/contractTemplates.ts — a token
// that wouldn't validate as a variable name is not scanned as one.
const VARIABLE_TOKEN_RE = /\{\{\s*([a-z][a-z0-9_.]{0,63})\s*\}\}/g;

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/**
 * Dual-axis app-layer read condition (mirrors ticketFormAccessCondition /
 * policyAccessCondition): org rows the caller can reach OR the caller's own
 * partner's partner-wide rows. RLS is stricter — org tokens never see
 * partner-wide rows — so the partner branch is gated on partner scope to keep
 * app and DB agreeing.
 */
function templateAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(contractTemplates.orgId);
  if (!orgCond) return undefined; // system scope — no filter needed
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${contractTemplates.orgId} IS NULL AND ${contractTemplates.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/**
 * Partner-wide administration gate (epic #2135, mirrors
 * updateConfigPolicy/deleteConfigPolicy): a partner-wide template (orgId
 * NULL) is readable by any member of the partner but administrable only with
 * canManagePartnerWidePolicies; an org-owned template requires ordinary org
 * access. Enforced here (service layer) so every caller — routes, AI tools,
 * future workers — hits the same gate, not just HTTP.
 */
function assertTemplateWriteAccess(auth: AuthContext, template: Pick<TemplateRow, 'orgId' | 'partnerId'>): void {
  if (template.orgId === null) {
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return;
  }
  if (!auth.canAccessOrg(template.orgId)) {
    throw new ContractTemplateServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

async function getTemplateOr404(id: string): Promise<TemplateRow> {
  const [row] = await db.select().from(contractTemplates).where(eq(contractTemplates.id, id)).limit(1);
  if (!row) throw new ContractTemplateServiceError('Contract template not found', 404, 'TEMPLATE_NOT_FOUND');
  return row;
}

async function getVersionOr404(versionId: string, templateId: string): Promise<VersionRow> {
  const [row] = await db
    .select()
    .from(contractTemplateVersions)
    .where(and(eq(contractTemplateVersions.id, versionId), eq(contractTemplateVersions.templateId, templateId)))
    .limit(1);
  if (!row) throw new ContractTemplateServiceError('Contract template version not found', 404, 'VERSION_NOT_FOUND');
  return row;
}

/** Version numbers allocate per template: max existing + 1 (starts at 1). */
async function nextVersionNumber(templateId: string): Promise<number> {
  const [row] = await db
    .select({ maxVersion: sql<number | null>`max(${contractTemplateVersions.versionNumber})` })
    .from(contractTemplateVersions)
    .where(eq(contractTemplateVersions.templateId, templateId));
  return (row?.maxVersion ?? 0) + 1;
}

/** Scan `{{ name }}` tokens out of an authored body, deduped, classified auto/manual. */
function scanDeclaredVariables(html: string): ContractVariable[] {
  const names = new Set<string>();
  VARIABLE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_TOKEN_RE.exec(html)) !== null) {
    names.add(match[1]!);
  }
  return Array.from(names).map((name) => ({
    name,
    kind: (AUTO_CONTRACT_VARIABLES as readonly string[]).includes(name) ? 'auto' : 'manual',
  }));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(auth: AuthContext, opts?: { includeArchived?: boolean }): Promise<TemplateWithLatest[]> {
  const conditions: SQL[] = [];
  const accessCond = templateAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);
  if (!opts?.includeArchived) conditions.push(eq(contractTemplates.status, 'active'));

  const templates = await db
    .select()
    .from(contractTemplates)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(contractTemplates.updatedAt));
  if (templates.length === 0) return [];

  const ids = templates.map((t) => t.id);
  // Ordered desc by versionNumber so the first row seen per templateId is the
  // latest — cheaper than a per-template query or a window function the mock
  // harness can't express.
  const versions = await db
    .select()
    .from(contractTemplateVersions)
    .where(inArray(contractTemplateVersions.templateId, ids))
    .orderBy(desc(contractTemplateVersions.versionNumber));
  const latestByTemplate = new Map<string, VersionRow>();
  for (const v of versions) {
    if (!latestByTemplate.has(v.templateId)) latestByTemplate.set(v.templateId, v);
  }

  return templates.map((t) => ({ ...t, latestVersion: latestByTemplate.get(t.id) ?? null }));
}

export async function createTemplate(auth: AuthContext, input: CreateContractTemplateInput): Promise<TemplateRow> {
  let orgId: string | null;
  let partnerId: string | null;

  if (input.ownerScope === 'partner') {
    if (!auth.partnerId) {
      throw new ContractTemplateServiceError('Partner-wide templates require partner scope', 403, 'PARTNER_SCOPE_REQUIRED');
    }
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    orgId = null;
    partnerId = auth.partnerId;
  } else {
    // createContractTemplateSchema's superRefine guarantees orgId is present
    // whenever ownerScope === 'organization' — the runtime check here is
    // defense-in-depth against a caller that bypassed the schema.
    if (!input.orgId) {
      throw new ContractTemplateServiceError('orgId is required for an organization-owned template', 400, 'VALIDATION_ERROR');
    }
    if (!auth.canAccessOrg(input.orgId)) {
      throw new ContractTemplateServiceError('Organization access denied', 403, 'ORG_DENIED');
    }
    orgId = input.orgId;
    partnerId = null;
  }

  const [row] = await db
    .insert(contractTemplates)
    .values({
      orgId,
      partnerId,
      name: input.name,
      description: input.description ?? null,
      createdBy: auth.user.id,
    })
    .returning();
  if (!row) throw new ContractTemplateServiceError('Failed to create contract template', 500, 'TEMPLATE_CREATE_FAILED');
  return row;
}

export async function updateTemplate(auth: AuthContext, id: string, input: UpdateContractTemplateInput): Promise<TemplateRow> {
  const template = await getTemplateOr404(id);
  assertTemplateWriteAccess(auth, template);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;

  const [updated] = await db.update(contractTemplates).set(updates).where(eq(contractTemplates.id, id)).returning();
  if (!updated) throw new ContractTemplateServiceError('Failed to update contract template', 500, 'TEMPLATE_UPDATE_FAILED');
  return updated;
}

/**
 * Archive only — delete is deliberately not exposed. Archiving blocks NEW
 * attachments (createDraftVersion/createUploadedVersion reject once a
 * template is archived) but leaves existing published versions, and any
 * contract document already pinned to one, fully renderable.
 */
export async function archiveTemplate(auth: AuthContext, id: string): Promise<void> {
  const template = await getTemplateOr404(id);
  assertTemplateWriteAccess(auth, template);
  await db.update(contractTemplates).set({ status: 'archived', updatedAt: new Date() }).where(eq(contractTemplates.id, id));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function createDraftVersion(
  auth: AuthContext,
  templateId: string,
  input: { bodyHtml: string }
): Promise<VersionRow> {
  const template = await getTemplateOr404(templateId);
  assertTemplateWriteAccess(auth, template);
  if (template.status === 'archived') {
    throw new ContractTemplateServiceError('Cannot add a version to an archived template', 409, 'TEMPLATE_ARCHIVED');
  }

  const versionNumber = await nextVersionNumber(templateId);
  // Authored version bodies must pass through the shared rich-text sanitizer
  // before persisting — same subset enforced on quote rich_text blocks.
  const bodyHtml = sanitizeRichTextHtml(input.bodyHtml);

  const [row] = await db
    .insert(contractTemplateVersions)
    .values({
      templateId,
      orgId: template.orgId,
      partnerId: template.partnerId,
      versionNumber,
      status: 'draft',
      sourceType: 'authored',
      bodyHtml,
      declaredVariables: [],
      createdBy: auth.user.id,
    })
    .returning();
  if (!row) throw new ContractTemplateServiceError('Failed to create draft version', 500, 'VERSION_CREATE_FAILED');
  return row;
}

export async function createUploadedVersion(
  auth: AuthContext,
  templateId: string,
  file: { data: Buffer; mime: string }
): Promise<VersionRow> {
  const template = await getTemplateOr404(templateId);
  assertTemplateWriteAccess(auth, template);
  if (template.status === 'archived') {
    throw new ContractTemplateServiceError('Cannot add a version to an archived template', 409, 'TEMPLATE_ARCHIVED');
  }
  if (file.data.length > MAX_UPLOAD_BYTES) {
    throw new ContractTemplateServiceError('File exceeds the 10MB upload limit', 400, 'FILE_TOO_LARGE');
  }
  if (file.data.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    throw new ContractTemplateServiceError('File is not a valid PDF', 400, 'INVALID_FILE');
  }

  const versionNumber = await nextVersionNumber(templateId);
  const [row] = await db
    .insert(contractTemplateVersions)
    .values({
      templateId,
      orgId: template.orgId,
      partnerId: template.partnerId,
      versionNumber,
      status: 'draft',
      sourceType: 'uploaded',
      fileData: file.data,
      mime: file.mime,
      byteSize: file.data.length,
      declaredVariables: [],
      createdBy: auth.user.id,
    })
    .returning();
  if (!row) throw new ContractTemplateServiceError('Failed to create uploaded version', 500, 'VERSION_CREATE_FAILED');
  return row;
}

/**
 * Publish a draft version: computes sha256 over its content (body_html for
 * authored, file_data for uploaded), scans `{{ var }}` tokens out of an
 * authored body into declared_variables (kind 'auto' when the name is in
 * AUTO_CONTRACT_VARIABLES, else 'manual' — uploaded PDFs are opaque binary
 * and are never scanned), and stamps published_at.
 *
 * Published versions are immutable: publishing an already-published version
 * throws 409 VERSION_IMMUTABLE rather than recomputing/overwriting it.
 */
export async function publishVersion(auth: AuthContext, templateId: string, versionId: string): Promise<VersionRow> {
  const template = await getTemplateOr404(templateId);
  assertTemplateWriteAccess(auth, template);
  const version = await getVersionOr404(versionId, templateId);

  if (version.status === 'published') {
    throw new ContractTemplateServiceError('Published versions are immutable', 409, 'VERSION_IMMUTABLE');
  }

  let sha256: string;
  let declaredVariables: ContractVariable[];
  if (version.sourceType === 'authored') {
    const body = version.bodyHtml ?? '';
    sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    declaredVariables = scanDeclaredVariables(body);
  } else {
    if (!version.fileData) {
      throw new ContractTemplateServiceError('Uploaded version has no file content', 500, 'VERSION_MISSING_FILE');
    }
    sha256 = createHash('sha256').update(version.fileData).digest('hex');
    declaredVariables = [];
  }

  const [updated] = await db
    .update(contractTemplateVersions)
    .set({ status: 'published', sha256, declaredVariables, publishedAt: new Date() })
    .where(eq(contractTemplateVersions.id, versionId))
    .returning();
  if (!updated) throw new ContractTemplateServiceError('Failed to publish version', 500, 'VERSION_PUBLISH_FAILED');
  return updated;
}
