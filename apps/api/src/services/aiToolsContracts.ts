/**
 * AI Contract Tools
 *
 * Read-only AI tools over the recurring contracts engine:
 *  - `list_contracts` — list contracts for the caller's accessible orgs, with
 *    optional org/status/limit filters.
 *  - `get_contract`   — full view (contract + lines + billing-period history) for
 *    one contract.
 *
 * Org-scope guarded AT THE TOOL LAYER: each tool builds a `ContractActor` from
 * the AI session's auth context (partnerId + accessibleOrgIds) and calls
 * `listContracts` / `getContract`, which already enforce `requireOrgAccess` and
 * the defense-in-depth `inArray(contracts.orgId, actor.accessibleOrgIds)` filter.
 * A thrown `ContractServiceError` (e.g. ORG_DENIED, CONTRACT_NOT_FOUND) is
 * converted to a JSON error string rather than propagated. Write tools are
 * deferred.
 */

import type { ContractLineInput, CreateContractInput, UpdateContractInput } from '@breeze/shared';
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

export function registerContractTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_contracts', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_contracts',
      description:
        'List recurring contracts for the orgs the caller can access, newest first. Optionally filter by org or status. Read-only.',
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
        'Get the full view of one recurring contract (header, lines, and billing-period history) by id. Read-only.',
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
        'Activate, pause, resume, and cancel actions change contract lifecycle state and require approval.',
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
          orgId: { type: 'string', description: 'Organization UUID for create_draft' },
          input: { type: 'object', description: 'Contract create input fields' },
          patch: { type: 'object', description: 'Contract update patch fields' },
          line: { type: 'object', description: 'Contract line input fields' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const s = (k: string) => (input[k] == null ? undefined : String(input[k]));

      try {
        switch (input.action) {
          case 'create_draft':
            return JSON.stringify(await createContract(input.input as CreateContractInput, actor));
          case 'update':
            return JSON.stringify(await updateContract(
              String(input.contractId),
              input.patch as UpdateContractInput,
              actor
            ));
          case 'delete_draft':
            await deleteDraftContract(String(input.contractId), actor);
            return JSON.stringify({ ok: true });
          case 'add_line':
            return JSON.stringify(await addContractLineToContract(
              String(input.contractId),
              input.line as ContractLineInput,
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
            return JSON.stringify({ error: `Unknown action: ${s('action')}` });
        }
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
