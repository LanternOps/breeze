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
import { BILLABLE_DEVICE_ROLES, createContractSchema, updateContractSchema, contractLineInputSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listContracts,
  getContract,
  createContract,
  updateContract,
  deleteDraftContract,
  addContractLineToContract,
  removeContractLine,
  activateContract,
  pauseContract,
  resumeContract,
  cancelContract
} from './contractService';
import { ContractServiceError, type ContractActor } from './contractTypes';
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';

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
    return JSON.stringify({ error: err.message, code: err.code });
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
              'activate',
              'pause',
              'resume',
              'cancel',
            ],
          },
          contractId: { type: 'string', description: 'Contract UUID' },
          lineId: { type: 'string', description: 'Contract line UUID' },
          input: { type: 'object', description: 'Full create-contract payload including orgId, name, and schedule fields' },
          patch: { type: 'object', description: 'Contract update patch fields' },
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
          case 'add_line':
            return JSON.stringify(await addContractLineToContract(
              String(input.contractId),
              linePayload.parse({ line: input.line }).line,
              actor
            ));
          case 'remove_line':
            await removeContractLine(String(input.contractId), String(input.lineId), actor);
            return JSON.stringify({ ok: true });
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
