import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./contractService', () => {
  class ContractServiceError extends Error {
    constructor(
      message: string,
      public status: 400 | 403 | 404 | 409 | 500 = 400,
      public code?: string,
    ) {
      super(message);
      this.name = 'ContractServiceError';
    }
  }

  return {
    ContractServiceError,
    listContracts: vi.fn(),
    getContract: vi.fn(),
    createContract: vi.fn().mockResolvedValue({ id: 'contract-1', status: 'draft' }),
    updateContract: vi.fn().mockResolvedValue({ id: 'contract-1', name: 'Updated' }),
    deleteDraftContract: vi.fn().mockResolvedValue(undefined),
    addContractLineToContract: vi.fn().mockResolvedValue({ id: 'line-1', contractId: 'contract-1' }),
    removeContractLine: vi.fn().mockResolvedValue(undefined),
    activateContract: vi.fn().mockResolvedValue({ id: 'contract-1', status: 'active' }),
    pauseContract: vi.fn().mockResolvedValue({ id: 'contract-1', status: 'paused' }),
    resumeContract: vi.fn().mockResolvedValue({ id: 'contract-1', status: 'active' }),
    cancelContract: vi.fn().mockResolvedValue({ id: 'contract-1', status: 'cancelled' }),
  };
});

import { registerContractTools } from './aiToolsContracts';
import * as contractService from './contractService';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { ContractServiceError } from './contractTypes';

const auth: AuthContext = {
  principal: { kind: 'user_session' },
  user: { id: 'u-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
  token: {
    sub: 'u-1',
    email: 'user@example.test',
    roleId: null,
    orgId: null,
    partnerId: 'p-1',
    scope: 'partner',
    type: 'access',
    mfa: true,
  },
  partnerId: 'p-1',
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: (orgId) => orgId === 'org-1',
};

const actor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] };

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerContractTools(map);
  const t = map.get('manage_contracts');
  if (!t) throw new Error('manage_contracts not registered');
  return t;
}

describe('manage_contracts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_draft calls createContract with input payload and actor built from auth', async () => {
    // orgId is validated as a UUID (createContractSchema) — unlike contractId/
    // lineId elsewhere in this file, which are only ever String()-coerced path
    // params and never parsed against a guid schema.
    const input = {
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Managed services',
      billingTiming: 'advance',
      intervalMonths: 1,
      startDate: '2026-07-01',
      autoIssue: true,
      currencyCode: 'USD',
    };

    const out = await getTool().handler({ action: 'create_draft', input }, auth);

    expect(contractService.createContract).toHaveBeenCalledWith(input, actor);
    expect(JSON.parse(out)).toEqual({ id: 'contract-1', status: 'draft' });
  });

  it('activate calls activateContract with contractId and actor', async () => {
    const out = await getTool().handler(
      { action: 'activate', contractId: 'contract-1' },
      auth,
    );

    expect(contractService.activateContract).toHaveBeenCalledWith('contract-1', actor);
    expect(JSON.parse(out)).toEqual({ id: 'contract-1', status: 'active' });
  });

  it('add_line calls addContractLineToContract with contractId, line payload, and actor', async () => {
    const line = {
      lineType: 'manual',
      description: 'Endpoint support',
      unitPrice: '99.00',
      manualQuantity: '5',
      taxable: false,
      sortOrder: 1,
    };

    const out = await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line },
      auth,
    );

    expect(contractService.addContractLineToContract).toHaveBeenCalledWith(
      'contract-1',
      line,
      actor,
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-1', contractId: 'contract-1' });
  });

  it('remove_line calls removeContractLine with contractId, lineId, and actor', async () => {
    const out = await getTool().handler(
      { action: 'remove_line', contractId: 'contract-1', lineId: 'line-1' },
      auth,
    );

    expect(contractService.removeContractLine).toHaveBeenCalledWith(
      'contract-1',
      'line-1',
      actor,
    );
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  it('returns a JSON error when a service action rejects with ContractServiceError', async () => {
    vi.mocked(contractService.activateContract).mockRejectedValueOnce(
      new ContractServiceError('Contract needs at least one line', 409, 'NO_LINES'),
    );

    const out = await getTool().handler(
      { action: 'activate', contractId: 'contract-1' },
      auth,
    );

    expect(JSON.parse(out)).toEqual({ error: 'Contract needs at least one line', code: 'NO_LINES' });
  });

  it('re-throws non-service errors from service actions', async () => {
    const err = new Error('database unavailable');
    vi.mocked(contractService.pauseContract).mockRejectedValueOnce(err);

    await expect(
      getTool().handler({ action: 'pause', contractId: 'contract-1' }, auth),
    ).rejects.toBe(err);
  });

  it('unknown action returns a JSON error', async () => {
    const out = await getTool().handler({ action: 'nope' }, auth);

    expect(JSON.parse(out)).toHaveProperty('error');
  });

  it('activate without contractId returns a structured VALIDATION_ERROR instead of coercing "undefined" (#2362 sweep)', async () => {
    const out = await getTool().handler({ action: 'activate' }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('contractId');
    expect(contractService.activateContract).not.toHaveBeenCalled();
  });

  // BUG 1: manage_contracts used to type-cast create_draft/update/add_line
  // payloads straight into the service call with no Zod layer at all — a
  // malformed payload (e.g. missing billingTiming/intervalMonths) reached
  // createContract's raw insert and died as an opaque HTTP 500 NOT NULL
  // violation instead of a structured validation message.
  it('create_draft with an invalid payload (missing billingTiming/intervalMonths) returns a structured VALIDATION_ERROR instead of throwing', async () => {
    const out = await getTool().handler(
      {
        action: 'create_draft',
        input: { orgId: 'org-1', name: 'Managed services', startDate: '2026-07-01' },
      },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(contractService.createContract).not.toHaveBeenCalled();
  });

  it('update with an invalid patch (bad intervalMonths type) returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler(
      {
        action: 'update',
        contractId: 'contract-1',
        patch: { intervalMonths: 'monthly' },
      },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(contractService.updateContract).not.toHaveBeenCalled();
  });

  it('add_line with an invalid line (missing unitPrice/taxable) returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler(
      {
        action: 'add_line',
        contractId: 'contract-1',
        line: { lineType: 'manual', description: 'Support' },
      },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(contractService.addContractLineToContract).not.toHaveBeenCalled();
  });

  // #3205
  it('add_line accepts a per_device_role line with deviceRoles and forwards it verbatim', async () => {
    const line = {
      lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00', taxable: true,
      deviceRoles: ['switch', 'router', 'firewall'],
    };
    const out = await getTool().handler({ action: 'add_line', contractId: 'contract-1', line }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith('contract-1', line, actor);
    expect(JSON.parse(out)).toEqual({ id: 'line-1', contractId: 'contract-1' });
  });

  it('add_line with per_device_role but no deviceRoles returns VALIDATION_ERROR naming the field', async () => {
    const out = await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { lineType: 'per_device_role', description: 'x', unitPrice: '1.00', taxable: false } },
      auth,
    );
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('deviceRoles');
    expect(contractService.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('documents per_device_role and deviceRoles in the tool schema so the model can discover them', () => {
    const desc = JSON.stringify(getTool().definition.input_schema);
    expect(desc).toContain('per_device_role');
    expect(desc).toContain('deviceRoles');
    expect(desc).toContain('unknown');
  });
});
