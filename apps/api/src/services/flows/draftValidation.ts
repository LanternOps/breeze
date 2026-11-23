/**
 * Flows completion W01b (#12435): validate a flow document without saving it
 * (POST /flows/validate).
 *
 * The same catalog-aware validation `validate_flow` and `saveDraftFlow` run.
 * With a `flowId`, its validation is the one saving that draft would return
 * (it is a read, so a selected-access partner user still gets the validation
 * where a save would answer `partner_wide_forbidden`):
 *  - the same reach rule as `updateDraft` (services/flows/service.ts): an org
 *    token can read a partner-wide flow through the SELECT-only policy but can
 *    never update it, so it gets `flow_not_found`, before any owner lookup or
 *    catalog read;
 *  - the owner comes from the row (`ownerForFlowRow`), never from the body;
 *  - while the flow's conversion is in shadow, its own generated-script
 *    placeholders are excused, as at save (conversion/ledger.ts).
 * Without a `flowId`, the owner is resolved for the caller in read mode, as
 * `validate_flow` does.
 *
 * Reads only, in the caller's DB context. Nothing here writes.
 */
import { eq } from 'drizzle-orm';
import type { FlowValidationResult } from '@breeze/shared';
import { db } from '../../db';
import { flows } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { validateFlowDocument } from '../flowValidator';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { allowGeneratedScriptPlaceholders, hasScriptOwnershipRefusal, shadowPlaceholderAllowance } from './conversion/ledger';
import { resolveFlowOwnerForCaller } from './owner';
import { ownerForFlowRow } from './repository';

export interface ValidateFlowDraftRequest {
  document: unknown;
  ownerScope?: 'organization' | 'partner';
  orgId?: string;
  flowId?: string;
}

export type ValidateFlowDraftResult =
  | { ok: true; validation: FlowValidationResult }
  | { ok: false; error: 'flow_not_found' }
  | { ok: false; error: 'owner_invalid'; message: string; accessDenied: boolean };

/**
 * Owner-resolution messages that mean "you may not act for that owner":
 * `resolveWritableToolOrgId` (services/aiToolWriteOrg.ts) and owner.ts. Any
 * other owner message is a malformed request. The route answers 403 for these
 * and 400 for the rest; draftValidation.test.ts drives the real resolver to
 * each message so a rewording cannot silently move a status.
 */
const OWNER_ACCESS_DENIED_MESSAGES: ReadonlySet<string> = new Set([
  'Cannot access another organization',
  'Access denied to this organization',
  'Partner-wide flows require a partner-scoped caller',
]);

export function isOwnerAccessDeniedMessage(message: string): boolean {
  return OWNER_ACCESS_DENIED_MESSAGES.has(message);
}

export async function validateFlowDraft(auth: AuthContext, req: ValidateFlowDraftRequest): Promise<ValidateFlowDraftResult> {
  if (req.flowId) return validateAgainstFlow(auth, req.flowId, req.document);

  const resolved = await resolveFlowOwnerForCaller(auth, { ownerScope: req.ownerScope, orgId: req.orgId }, 'read');
  if ('error' in resolved) {
    return { ok: false, error: 'owner_invalid', message: resolved.error, accessDenied: isOwnerAccessDeniedMessage(resolved.error) };
  }
  return { ok: true, validation: await validateFor(resolved.owner, req.document) };
}

async function validateAgainstFlow(auth: AuthContext, flowId: string, document: unknown): Promise<ValidateFlowDraftResult> {
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!row) return { ok: false, error: 'flow_not_found' };
  // updateDraft's reach rule: a partner-wide row is absent for any caller that is not partner or system scope.
  if (!row.orgId && auth.scope !== 'partner' && auth.scope !== 'system') return { ok: false, error: 'flow_not_found' };

  const owner = await ownerForFlowRow(row);
  if (!owner) return { ok: false, error: 'flow_not_found' };
  const checked = await validateFlowDocument(document, { owner });
  const validation = hasScriptOwnershipRefusal(checked)
    ? allowGeneratedScriptPlaceholders(checked, await shadowPlaceholderAllowance(db, flowId))
    : checked;
  return { ok: true, validation: withoutDocument(validation) };
}

async function validateFor(owner: ToolOwnerRef, document: unknown): Promise<FlowValidationResult> {
  return withoutDocument(await validateFlowDocument(document, { owner }));
}

function withoutDocument(v: FlowValidationResult & { document?: unknown }): FlowValidationResult {
  const { document: _document, ...rest } = v;
  return rest;
}
