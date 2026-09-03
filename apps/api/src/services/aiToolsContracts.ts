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
 * Org-scope guarded AT THE TOOL LAYER: each tool builds a `ContractActor` from
 * the AI session's auth context (partnerId + accessibleOrgIds) and calls
 * `listContracts` / `getContract`, which already enforce `requireOrgAccess` and
 * the defense-in-depth `inArray(contracts.orgId, actor.accessibleOrgIds)` filter.
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
    accessibleOrgIds: auth.accessibleOrgIds
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
const patchPayload = z.object({ patch: updateContractSchema });
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

export function registerContractTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_contracts', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_contracts',
      description:
        'List recurring contracts for the orgs the caller can access, newest first. Optionally filter by org or status. Read-only.' +
        ' Every contract carries a 3-letter currencyCode; its line unitPrice values, per-period totals and the invoices it generates are all in that currency. NEVER add amounts from contracts with different currencyCode values — group by currencyCode first and report one total per currency.',
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
        return JSON.stringify({ contracts: rows, showing: rows.length });
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
    definition: {
      name: 'get_contract',
      description:
        'Get the full view of one recurring contract (header, lines, and billing-period history) by id. Read-only.' +
        ' Every contract carries a 3-letter currencyCode; its line unitPrice values, per-period totals and the invoices it generates are all in that currency. NEVER add amounts from contracts with different currencyCode values — group by currencyCode first and report one total per currency.',
      input_schema: {
        type: 'object' as const,
        properties: {
          contractId: { type: 'string', description: 'Contract UUID' }
        },
        required: ['contractId']
      }
    },
    handler: async (input, auth) => {
      try {
        const result = await getContract(String(input.contractId), actorFromAuth(auth));
        return JSON.stringify(result);
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
    definition: {
      name: 'manage_contracts',
      description:
        'Create and manage recurring contracts for orgs the caller can access: draft edits, lines, and lifecycle actions. ' +
        'Activate, pause, resume, and cancel actions change contract lifecycle state and require approval.' +
        ' Contract line prices and totals are in the contract\'s currencyCode.',
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
              'For action "update": contract header fields. For action "update_line": the line patch. ' +
              'update_line edits one line in place, keeping its id (and therefore its invoice lineage). ' +
              'Every field of a line is editable EXCEPT lineType — sending lineType is rejected; to change the ' +
              'type, remove_line then add_line. catalogItemId is three-valued: leave it out to keep the current ' +
              'link AND the current stamped price, send a DIFFERENT item id to re-link and re-resolve price and ' +
              'taxable in the contract\'s currency (any unitPrice/taxable you send is ignored), or send null to ' +
              'unlink — which requires unitPrice AND taxable in the same call. Sending the item id the line ' +
              'already has changes nothing; to re-price an unchanged link, send refreshCatalogPrice: true. ' +
              'siteId accepts null to widen a site-scoped line to the whole org. Lines are only editable on ' +
              'draft and active contracts. Edits apply to future billing periods; invoices already generated ' +
              'are unchanged.',
          },
          line: {
            type: 'object',
            description:
              'Contract line input. lineType is one of flat | per_device | per_device_role | per_device_group | per_seat | manual. ' +
              'per_device counts the org\'s billable devices (optionally one site via siteId). ' +
              'per_device_role counts only devices whose role is in deviceRoles — a non-empty array of ' +
              `${BILLABLE_DEVICE_ROLES.join(', ')} ` +
              '(never unknown: unclassified devices are reported as uncovered, not billed); siteId is optional there too. ' +
              'per_device_group counts the members of one device group named by deviceGroupId (a device group UUID in the ' +
              'contract\'s org). Static groups bill their current members; dynamic groups are evaluated live from their filter at ' +
              'estimate and invoice time (a filter condition on groupId still reads that other group\'s cached membership). ' +
              'No siteId on this type — the group\'s own site narrows it. ' +
              'manual requires manualQuantity. ' +
              'With catalogItemId set, unitPrice/taxable are resolved from the catalog ' +
              'price book in the CONTRACT\'s currency (any supplied values are ignored) and add_line fails with ' +
              'NO_PRICE_FOR_CURRENCY (409) when the item has no price in that currency — never converted; add a ' +
              'non-catalog line with an explicit unitPrice instead. Without catalogItemId, unitPrice is required.',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
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
            const row = await addContractLineToContract(
              String(input.contractId),
              linePayload.parse({ line: input.line }).line,
              actor
            );
            auditContractLineToolEvent(auth, 'contract.line.added', {
              orgId: row.orgId, contractId: String(input.contractId),
              contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
            });
            return JSON.stringify(row);
          }
          case 'remove_line': {
            const audit = await removeContractLine(String(input.contractId), String(input.lineId), actor);
            auditContractLineToolEvent(auth, 'contract.line.removed', audit);
            return JSON.stringify({ ok: true });
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
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
