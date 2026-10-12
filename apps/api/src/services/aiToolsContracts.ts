/**
 * AI Contract Tools
 *
 * AI tools over the recurring contracts engine:
 *  - `list_contracts` — list contracts for the caller's accessible orgs, with
 *    optional org/status/limit filters.
 *  - `get_contract`   — full view (contract + lines + billing-period history) for
 *    one contract.
 *  - `manage_contracts` — create/update/delete draft contracts, add/remove
 *    lines, and run lifecycle actions.
 *
 * Scope is guarded AT THE TOOL LAYER to match the recurring-contract HTTP
 * surface: only partner and system sessions may enter. Each tool then builds a
 * `ContractActor` from the AI session's auth context (partnerId +
 * accessibleOrgIds) and calls `listContracts` / `getContract`, which enforce
 * `requireOrgAccess` and the defense-in-depth
 * `inArray(contracts.orgId, actor.accessibleOrgIds)` filter.
 * A thrown `ContractServiceError` (e.g. ORG_DENIED, CONTRACT_NOT_FOUND) is
 * converted to a JSON error string rather than propagated. Activate/pause/
 * resume/cancel are approval-gated Tier 3 actions.
 */

import { z } from 'zod';
import { BILLABLE_DEVICE_ROLES, createContractSchema, updateContractSchema, contractLineInputSchema, updateContractLineSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listContracts,
  getContract,
  createContract,
  updateContract,
  updateContractLine,
  deleteDraftContract,
  addContractLineToContract,
  removeContractLine,
  contractLineAuditDetails,
  activateContract,
  pauseContract,
  resumeContract,
  cancelContract
} from './contractService';
import { ContractServiceError, type ContractActor, type ContractLineAudit } from './contractTypes';
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';
import { stampedKeysErrorBody } from './contractHourBlockLocked';
import { listContractHourPeriods } from './contractHourPeriodsRead';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';

/**
 * Params each manage_contracts action requires, presence-checked BEFORE any
 * `String(...)` coercion so a missing id can't become the literal string
 * "undefined" and die downstream as an opaque uuid/DB 500 (#2362 sweep).
 */
const MANAGE_CONTRACTS_REQUIRED: Record<string, readonly string[]> = {
  create_draft: ['input'],
  update: ['contractId', 'patch'],
  delete_draft: ['contractId'],
  add_line: ['contractId', 'line'],
  remove_line: ['contractId', 'lineId'],
  update_line: ['contractId', 'lineId', 'patch'],
  activate: ['contractId'],
  pause: ['contractId'],
  resume: ['contractId'],
  cancel: ['contractId'],
};

function actorFromAuth(auth: AuthContext): ContractActor {
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
    // Thread the caller's site-axis restriction so a site-limited AI session can't
    // read/mutate contracts outside its sites — the sibling actors already do
    // (aiToolsBilling.ts, aiToolsQuotes.ts). undefined (partner/system, all-sites
    // org users) stays unrestricted, preserving prior behavior.
    allowedSiteIds: auth.allowedSiteIds
  };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof ContractServiceError) {
    // #3205 W03: HTTP returns `details` verbatim (routes/contracts/contracts.ts
    // :50-57) while this door dropped it. A model that trips INVALID_LINE_PATCH
    // and is told only "those changes aren't valid" cannot self-correct.
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  return null;
}

// Payload parsers wrap the value under its param name so ZodError paths are
// self-describing ("input.billingTiming: ...", "line.lineType: ..."). These
// are the SAME schemas the HTTP contract routes validate with — one source of
// truth. Without this, a malformed manage_contracts call skipped validation
// entirely (the type-cast reached contractService with no Zod layer at all)
// and died as an opaque DB NOT NULL/constraint 500 instead of a structured
// VALIDATION_ERROR the model could act on.
const createPayload = z.object({ input: createContractSchema });
// Autopay policy changes remain human-only even though HTTP shares the base schema.
const patchPayload = z.object({ patch: updateContractSchema.extend({ autopayExcluded: z.never().optional() }) });
const linePayload = z.object({ line: contractLineInputSchema });
const lineUpdatePayload = z.object({ patch: updateContractLineSchema });

/** Best-effort audit write for the AI door (#3205 W03). Never blocks the tool
 *  result. initiatedBy 'ai' is an explicit value of the initiated_by_type enum
 *  (db/schema/audit.ts:14) and writeAuditEventAsync honours it over its
 *  actor-type inference (auditEvents.ts:73-74). Same no-free-text payload as
 *  the HTTP door. */
function auditContractLineToolEvent(
  auth: AuthContext,
  action: 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated',
  audit: ContractLineAudit,
): void {
  if (audit.changedFields && audit.changedFields.length === 0) return;
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: audit.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action,
      resourceType: 'contract',
      resourceId: audit.contractId,
      resourceName: audit.contractName,
      result: 'success',
      initiatedBy: 'ai',
      details: {
        ...contractLineAuditDetails(audit),
        tool_name: 'manage_contracts',
      },
    });
  } catch (err) {
    console.error('[manage_contracts] audit write failed', err);
  }
}


/**
 * SCOPE PARITY WITH THE HTTP DOOR (#6110 review, finding 1).
 *
 * A tool must require exactly what its route requires. Every route file under `routes/contracts/` is
 * `requireScope('partner','system')` (contracts.ts:16, bulk.ts:11, lines.ts:18,
 * lifecycle.ts:13, periods.ts:10, generate.ts:14, reports.ts:21, deliverables.ts:19).
 * An organization-scoped token therefore cannot reach this domain over HTTP at
 * all — and an org token still carries the OWNING PARTNER's partnerId, so a
 * bare partnerId-presence check is not a substitute. Autonomous AI-agent runs
 * mint `scope: 'organization'` too (aiAgents/agentAuthContext.ts), so this gate
 * refuses them as well; the `business` capability group that carries these
 * tools already contains partner-only tools (aiToolsDeliverables.ts), so that is
 * an existing, expected shape rather than a new one.
 */
/** Site-axis analogue of `SITE_SCOPE_EMPTY_NOTE` (aiToolsSiteScope.ts), worded
 *  for contracts: the site-attributable unit here is the LINE, not a device. */
const CONTRACT_SITE_SCOPE_NOTE =
  'Your site access limits this result: contracts are shown only when they carry a line in one of your sites, '
  + 'and such a contract may still have lines you cannot see. This is a restriction on your access, not an absence of data.';

function partnerScopeRefusal(auth: AuthContext): string | null {
  if (auth.scope === 'system') return null;
  // A partner-scoped context with no partner identity is malformed —
  // fail closed rather than hand the contract service a null-partner actor.
  if (auth.scope === 'partner' && auth.partnerId) return null;
  return JSON.stringify({
    error: 'Contract access requires a partner-scoped session; organization-scoped callers cannot reach the '
      + 'matching HTTP routes either',
    code: 'PARTNER_SCOPE_REQUIRED',
  });
}

export function registerContractTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_contracts', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'recurring contracts by organization and lifecycle status',
    definition: {
      name: 'list_contracts',
      description:
        "List accessible recurring contracts newest first, filtered by org or status. Line prices, period totals and generated invoices use contract currencyCode; never sum across currencies; group by currencyCode for totals.",
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Filter to a single organization (UUID)' },
          status: {
            type: 'string',
            enum: ['draft', 'active', 'paused', 'cancelled', 'expired'],
            description: 'Filter by contract status'
          },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const refusal = partnerScopeRefusal(auth);
      if (refusal) return refusal;
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      try {
        const rows = await listContracts(
          {
            orgId: input.orgId ? String(input.orgId) : undefined,
            status: input.status ? String(input.status) : undefined,
            limit
          },
          actorFromAuth(auth)
        );
        return JSON.stringify({
          contracts: rows,
          showing: rows.length,
          // Defence in depth beside the scope gate above: if a site-restricted
          // caller ever does reach this tool, say so, so the model reads a short
          // page as 'limited by access' rather than "this is all that exists".
          ...(auth.allowedSiteIds ? { scopeNote: CONTRACT_SITE_SCOPE_NOTE } : {}),
        });
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });

  aiTools.set('get_contract', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'recurring contract details, line items, pricing and billing period history',
    definition: {
      name: 'get_contract',
      description:
        "Get a recurring contract header, lines, billing-period history and hour-block period history (hourPeriods, newest first, last 24). Line prices, period totals and generated invoices use contract currencyCode; never sum across currencies; group by currencyCode for totals.",
      input_schema: {
        type: 'object' as const,
        properties: {
          contractId: { type: 'string', description: 'Contract UUID' }
        },
        required: ['contractId']
      }
    },
    handler: async (input, auth) => {
      const refusal = partnerScopeRefusal(auth);
      if (refusal) return refusal;
      try {
        const actor = actorFromAuth(auth);
        const contractId = String(input.contractId);
        const result = await getContract(contractId, actor);
        // #4547 W03: same reader as GET /contracts/:id/hour-periods (routes/contracts/hourPeriods.ts).
        const { items: hourPeriods } = await listContractHourPeriods(contractId, { limit: 24 }, actor);
        return JSON.stringify({ ...result, hourPeriods });
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });

  aiTools.set('manage_contracts', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'recurring contracts: create, edit drafts and lines, activate, pause, resume, cancel',
    definition: {
      name: 'manage_contracts',
      description:
        "Manage recurring contracts for accessible orgs; prices and totals use the contract currencyCode. Actions: create_draft, update, delete_draft, add_line, remove_line, update_line, activate, pause, resume, cancel. Lifecycle changes require approval.",
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_draft',
              'update',
              'delete_draft',
              'add_line',
              'remove_line',
              'update_line',
              'activate',
              'pause',
              'resume',
              'cancel',
            ],
          },
          contractId: { type: 'string', description: 'Contract UUID' },
          lineId: { type: 'string', description: 'Contract line UUID' },
          input: { type: 'object', description: 'Full create-contract payload including orgId, name, and schedule fields' },
          patch: {
            type: 'object',
            description:
              "Header (update) or line (update_line) patch; lineType immutable. siteId:null widens to org. Invoices unchanged; hour_block edits apply at open period close.",
            properties: {
              catalogItemId: { type: ['string', 'null'], description: 'Omit to keep link and price; different UUID re-resolves price/taxable (supplied values ignored); null unlinks and requires unitPrice + taxable.' },
              refreshCatalogPrice: { type: 'boolean', description: 'True re-prices an unchanged catalog link. Line edits affect future billing periods only; generated invoices are unchanged.' },
              includedQuantity: { type: ['string', 'null'], description: 'Allowance bills every period even if the live count is lower: a whole number, or hours (decimals ok) on hour_block. Rule applies to the merged line.' },
              overageMode: { type: ['string', 'null'], enum: ['bill', 'flag', null], description: 'bill charges excess; flag reports it. Merged line needs includedQuantity and overageMode together; absent fields unchanged; null clears. hour_block stays bill.' },
              overageUnitPrice: { type: ['string', 'null'], description: 'Contract currency price, required only with bill. To remove allowance send includedQuantity, overageMode and overageUnitPrice all as null.' },
              rolloverPolicy: { type: 'string', enum: ['none', 'carry_forward'], description: 'hour_block: none or carry_forward. A switch to none needs rolloverCapHours null in the same patch.' },
              rolloverCapHours: { type: ['string', 'null'], description: 'hour_block carry_forward: most hours rolled over per period; null removes the limit.' },
              hourBlockAlertPct: { type: ['integer', 'null'], description: 'hour_block: whole percent 1-100 that raises an alert; null removes it.' },
            },
          },
          line: {
            type: 'object',
            description:
              "Line: flat|per_device|per_device_role|per_device_group|per_seat|manual|hour_block (fields below). Contract currency prices; gaps fail, never converted.",
            properties: {
              deviceGroupId: { type: 'string', description: "per_device_group: UUID in contract org; dynamic groups evaluated live; a filter condition on groupId still reads that other group's cached membership." },
              deviceRoles: { type: 'array', items: { type: 'string', enum: [...BILLABLE_DEVICE_ROLES] }, description: 'per_device_role: non-empty billable roles, never unknown; unclassified devices are uncovered. Optional siteId for per_device/per_device_role.' },
              catalogItemId: { type: 'string', description: 'UUID; resolves contract-currency price/taxable, ignoring supplied values. Missing price: NO_PRICE_FOR_CURRENCY. Without a catalog link, unitPrice required.' },
              includedQuantity: { type: 'string', description: 'Allowance: whole number for device/seat lines; hours per period (decimals ok) for hour_block. Bills a minimum. Supply with overageMode.' },
              overageMode: { type: 'string', enum: ['bill', 'flag'], description: 'bill adds a sibling invoice line for excess units; flag reports excess without billing. hour_block must use bill.' },
              overageUnitPrice: { type: 'string', description: 'Contract-currency price per excess unit (per extra hour on hour_block); required for overageMode bill. Allowance bills includedQuantity x unitPrice.' },
              rolloverPolicy: { type: 'string', enum: ['none', 'carry_forward'], description: 'hour_block only, required: none (unused hours expire) or carry_forward (unused hours roll into the next period).' },
              rolloverCapHours: { type: 'string', description: 'hour_block with carry_forward only: most hours that may roll over each period. Omit for no limit.' },
              hourBlockAlertPct: { type: 'integer', description: 'hour_block only: whole percent 1-100 of the block used that raises an alert. Optional.' },
            },
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const refusal = partnerScopeRefusal(auth);
      if (refusal) return refusal;
      const actor = actorFromAuth(auth);

      const action = String(input.action);
      const required = MANAGE_CONTRACTS_REQUIRED[action];
      if (!required) {
        return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      }
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;

      try {
        switch (action) {
          case 'create_draft':
            return JSON.stringify(await createContract(
              createPayload.parse({ input: input.input }).input,
              actor
            ));
          case 'update':
            return JSON.stringify(await updateContract(
              String(input.contractId),
              patchPayload.parse({ patch: input.patch }).patch,
              actor
            ));
          case 'delete_draft':
            await deleteDraftContract(String(input.contractId), actor);
            return JSON.stringify({ ok: true });
          case 'add_line': {
            // contractName is an audit-only helper on the service result: it feeds
            // resourceName and never reaches the model (mirrors routes/contracts/lines.ts).
            const { contractName, ...row } = await addContractLineToContract(
              String(input.contractId),
              linePayload.parse({ line: input.line }).line,
              actor
            );
            auditContractLineToolEvent(auth, 'contract.line.added', {
              orgId: row.orgId, contractId: String(input.contractId), contractName,
              contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
            });
            return JSON.stringify(row);
          }
          case 'remove_line': {
            const audit = await removeContractLine(String(input.contractId), String(input.lineId), actor);
            auditContractLineToolEvent(auth, 'contract.line.removed', audit);
            return JSON.stringify({ ok: true, retired: audit.retired === true });
          }
          case 'update_line': {
            const { line, audit } = await updateContractLine(
              String(input.contractId), String(input.lineId),
              lineUpdatePayload.parse({ patch: input.patch }).patch, actor,
            );
            auditContractLineToolEvent(auth, 'contract.line.updated', audit);
            return JSON.stringify(line);
          }
          case 'activate':
            return JSON.stringify(await activateContract(String(input.contractId), actor));
          case 'pause':
            return JSON.stringify(await pauseContract(String(input.contractId), actor));
          case 'resume':
            return JSON.stringify(await resumeContract(String(input.contractId), actor));
          case 'cancel':
            return JSON.stringify(await cancelContract(String(input.contractId), actor));
          default:
            return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
        }
      } catch (err) {
        const stamped = stampedKeysErrorBody(err);
        if (stamped) return JSON.stringify(stamped);
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
