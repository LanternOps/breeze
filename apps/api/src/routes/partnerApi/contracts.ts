/**
 * Partner API contract writes.
 *
 * A partner service principal with the opt-in `contracts:write` grant can
 * create a contract, update header fields, add/patch/remove lines, and GET
 * one contract to confirm contents. Lifecycle, documents, templates,
 * deliverables, and the human JWT `/api/v1/contracts` surface stay out.
 *
 * Execution model matches provisioning writes: non-GET has no ambient DB
 * context, so each handler opens its own partner-scoped withDbAccessContext.
 * GET already runs inside the auth middleware's held partner snapshot.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createContractSchema,
  updateContractSchema,
  contractLineInputSchema,
  updateContractLineSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import {
  withDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  requirePartnerApiScope,
  type PartnerApiPrincipalContext,
} from '../../middleware/partnerApiAuth';
import { writeAuditEventAsync } from '../../services/auditEvents';
import {
  addContractLineToContract,
  createContract,
  getContract,
  removeContractLine,
  updateContract,
  updateContractLine,
  contractLineAuditDetails,
} from '../../services/contractService';
import { ContractServiceError, type ContractActor, type ContractLineAudit } from '../../services/contractTypes';

const idParam = z.object({ id: z.string().uuid() });
const lineParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });
const writeScope = requirePartnerApiScope('contracts:write');

function partnerScopedDbContext(principal: PartnerApiPrincipalContext): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: principal.accessibleOrgIds,
    accessiblePartnerIds: [principal.partnerId],
    currentPartnerId: principal.partnerId,
    userId: null,
  };
}

function actorFrom(principal: PartnerApiPrincipalContext): ContractActor {
  return {
    userId: null,
    partnerId: principal.partnerId,
    accessibleOrgIds: principal.accessibleOrgIds,
  };
}

function handleContractError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractServiceError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  throw err;
}

function orgDenied(c: { json: (b: unknown, s: number) => Response }) {
  return c.json({ error: 'Organization access denied', code: 'ORG_DENIED' }, 403);
}

function auditContract(
  c: Parameters<typeof writeAuditEventAsync>[0],
  principal: PartnerApiPrincipalContext,
  event: {
    orgId: string;
    action: string;
    resourceId: string;
    /** Optional: ContractLineAudit.contractName is absent on some line paths. */
    resourceName?: string;
    details?: Record<string, unknown>;
  },
): void {
  void writeAuditEventAsync(c, {
    orgId: event.orgId,
    actorType: 'api_key',
    actorId: principal.keyId,
    action: event.action,
    resourceType: 'contract',
    resourceId: event.resourceId,
    resourceName: event.resourceName,
    result: 'success',
    details: {
      principalType: 'partner_service_principal',
      partnerServicePrincipalId: principal.partnerServicePrincipalId,
      keyId: principal.keyId,
      partnerId: principal.partnerId,
      ...event.details,
    },
  });
}

function auditLine(
  c: Parameters<typeof writeAuditEventAsync>[0],
  principal: PartnerApiPrincipalContext,
  action: 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated',
  a: ContractLineAudit,
): void {
  if (a.changedFields && a.changedFields.length === 0) return;
  auditContract(c, principal, {
    orgId: a.orgId,
    action,
    resourceId: a.contractId,
    resourceName: a.contractName,
    details: contractLineAuditDetails(a),
  });
}

async function inPartnerContext<T>(principal: PartnerApiPrincipalContext, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(partnerScopedDbContext(principal), fn);
}

export const partnerContractRoutes = new Hono();

partnerContractRoutes.post(
  '/contracts',
  writeScope,
  zValidator('json', createContractSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const input = c.req.valid('json');
    if (!principal.accessibleOrgIds.includes(input.orgId)) return orgDenied(c);
    try {
      const row = await inPartnerContext(principal, () => createContract(input, actorFrom(principal)));
      auditContract(c, principal, {
        orgId: row.orgId,
        action: 'contract.create',
        resourceId: row.id,
        resourceName: row.name,
      });
      return c.json({ data: row }, 201);
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);

partnerContractRoutes.get(
  '/contracts/:id',
  writeScope,
  zValidator('param', idParam),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    try {
      const data = await inPartnerContext(principal, () => getContract(c.req.valid('param').id, actorFrom(principal)));
      return c.json({ data });
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);

partnerContractRoutes.patch(
  '/contracts/:id',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', updateContractSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    try {
      const row = await inPartnerContext(principal, () =>
        updateContract(c.req.valid('param').id, c.req.valid('json'), actorFrom(principal)),
      );
      auditContract(c, principal, {
        orgId: row.orgId,
        action: 'contract.update',
        resourceId: row.id,
        resourceName: row.name,
      });
      return c.json({ data: row });
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);

partnerContractRoutes.post(
  '/contracts/:id/lines',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', contractLineInputSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const contractId = c.req.valid('param').id;
    try {
      const { contractName, ...row } = await inPartnerContext(principal, () =>
        addContractLineToContract(contractId, c.req.valid('json'), actorFrom(principal)),
      );
      auditLine(c, principal, 'contract.line.added', {
        orgId: row.orgId, contractId, contractName, contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
      });
      return c.json({ data: row }, 201);
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);

partnerContractRoutes.patch(
  '/contracts/:id/lines/:lineId',
  writeScope,
  zValidator('param', lineParam),
  zValidator('json', updateContractLineSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const p = c.req.valid('param');
    try {
      const { line, audit } = await inPartnerContext(principal, () =>
        updateContractLine(p.id, p.lineId, c.req.valid('json'), actorFrom(principal)),
      );
      auditLine(c, principal, 'contract.line.updated', audit);
      return c.json({ data: line });
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);

partnerContractRoutes.delete(
  '/contracts/:id/lines/:lineId',
  writeScope,
  zValidator('param', lineParam),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const p = c.req.valid('param');
    try {
      const audit = await inPartnerContext(principal, () =>
        removeContractLine(p.id, p.lineId, actorFrom(principal)),
      );
      auditLine(c, principal, 'contract.line.removed', audit);
      return c.json({ data: { ok: true } });
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);
