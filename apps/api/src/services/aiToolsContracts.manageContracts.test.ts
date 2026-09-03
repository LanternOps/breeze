import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3205 W03: the tool audits through the second door (writeAuditEvent +
// requestLikeFromSnapshot), not writeRouteAudit — there is no Hono context here.
const { writeAuditEvent } = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

vi.mock('./contractService', () => {
  class ContractServiceError extends Error {
    constructor(
      message: string,
      public status: 400 | 403 | 404 | 409 | 500 = 400,
      public code?: string,
      public details?: Record<string, unknown>,
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
    updateContractLine: vi.fn().mockResolvedValue({
      line: { id: 'line-1', contractId: 'contract-1', description: 'Renamed' },
      audit: { orgId: 'org-1', contractId: 'contract-1', contractName: 'Acme MSA', contractLineId: 'line-1', lineType: 'flat', changedFields: ['description'] },
    }),
    deleteDraftContract: vi.fn().mockResolvedValue(undefined),
    addContractLineToContract: vi.fn().mockResolvedValue({ id: 'line-1', contractId: 'contract-1', orgId: 'org-1', lineType: 'flat', unitPrice: '5.00', contractName: 'Managed Services' }),
    removeContractLine: vi.fn().mockResolvedValue({ orgId: 'org-1', contractId: 'contract-1', contractName: 'Acme MSA', contractLineId: 'line-1', lineType: 'flat' }),
    contractLineAuditDetails: vi.fn((audit) => ({
      contractLineId: audit.contractLineId,
      lineType: audit.lineType,
      ...(audit.changedFields !== undefined ? { changedFields: audit.changedFields } : {}),
      ...(audit.oldUnitPrice !== undefined ? { oldUnitPrice: audit.oldUnitPrice } : {}),
      ...(audit.newUnitPrice !== undefined ? { newUnitPrice: audit.newUnitPrice } : {}),
    })),
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
import { BILLABLE_DEVICE_ROLES } from '@breeze/shared';

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
    expect(JSON.parse(out)).toMatchObject({ id: 'line-1', contractId: 'contract-1' });
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

  it('add_line accepts a bill allowance and rejects the pairing violations (#3205 W04)', async () => {
    const line = {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    };
    await getTool().handler({ action: 'add_line', contractId: 'contract-1', line }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith(
      'contract-1', expect.objectContaining({ includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' }), actor,
    );

    const lonely = JSON.parse(await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { ...line, overageMode: undefined, overageUnitPrice: undefined } }, auth,
    ));
    expect(lonely.error).toMatch(/overageMode/);

    const onFlat = JSON.parse(await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { ...line, lineType: 'flat' } }, auth,
    ));
    expect(onFlat.error).toBeDefined();
  });

  // #3205
  it('add_line accepts a per_device_role line with deviceRoles and forwards it verbatim', async () => {
    const line = {
      lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00', taxable: true,
      deviceRoles: ['switch', 'router', 'firewall'],
    };
    const out = await getTool().handler({ action: 'add_line', contractId: 'contract-1', line }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith('contract-1', line, actor);
    expect(JSON.parse(out)).toMatchObject({ id: 'line-1', contractId: 'contract-1' });
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

  it('add_line accepts a per_device_group line and rejects one without deviceGroupId', async () => {
    const groupId = '33333333-3333-4333-8333-333333333333';
    await getTool().handler({
      action: 'add_line',
      contractId: 'contract-1',
      line: { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false, deviceGroupId: groupId },
    }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith(
      'contract-1',
      expect.objectContaining({ deviceGroupId: groupId }),
      expect.anything(),
    );
    const bad = JSON.parse(await getTool().handler({
      action: 'add_line',
      contractId: 'contract-1',
      line: { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false },
    }, auth));
    expect(bad.error).toMatch(/deviceGroupId/);
  });

  it('the manage_contracts description names per_device_group, deviceGroupId and the groupId-condition caveat', () => {
    const schema = getTool().definition.input_schema as {
      properties: { line: { description: string } };
    };
    const desc = schema.properties.line.description;
    expect(desc).toContain('per_device_group');
    expect(desc).toContain('deviceGroupId');
    expect(desc).toMatch(/evaluated live/i);
    // The caveat itself, not just the token: a groupId condition reads the other group's CACHED rows.
    expect(desc).toMatch(/filter condition on groupId still reads that other group's cached membership/i);
  });

  it('documents per_device_role and deviceRoles in the tool schema so the model can discover them', () => {
    const desc = JSON.stringify(getTool().definition.input_schema);
    expect(desc).toContain('per_device_role');
    expect(desc).toContain('deviceRoles');
    for (const role of BILLABLE_DEVICE_ROLES) expect(desc).toContain(role);
    expect(desc.match(/unknown/g)).toHaveLength(1);
    expect(desc).toContain('never unknown');
  });
});

describe('manage_contracts update_line (#3205 W03)', () => {
  const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
  const LINE_ID = '22222222-2222-4222-8222-222222222222';
  const run = async (input: Record<string, unknown>) => getTool().handler(input, auth);

  beforeEach(() => vi.clearAllMocks());

  it('requires contractId, lineId and patch before any coercion', async () => {
    const missing = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, patch: { description: 'x' } }));
    expect(missing.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(missing)).toContain('lineId');
    expect(contractService.updateContractLine).not.toHaveBeenCalled();
  });

  it('forwards the parsed patch and returns the line JSON', async () => {
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'Renamed' } }));
    expect(contractService.updateContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, { description: 'Renamed' }, actor);
    expect(out).toMatchObject({ id: 'line-1', description: 'Renamed' });
  });

  it("update_line removes an allowance with three nulls and surfaces the service's INVALID_LINE_PATCH rejection (#3205 W04)", async () => {
    await getTool().handler({
      action: 'update_line', contractId: 'contract-1', lineId: 'line-1',
      patch: { includedQuantity: null, overageMode: null, overageUnitPrice: null },
    }, auth);
    expect(contractService.updateContractLine).toHaveBeenCalledWith(
      'contract-1', 'line-1',
      { includedQuantity: null, overageMode: null, overageUnitPrice: null },
      actor,
    );

    vi.mocked(contractService.updateContractLine).mockRejectedValueOnce(
      new ContractServiceError('includedQuantity and overageMode must be set together', 400, 'INVALID_LINE_PATCH'),
    );
    const bad = JSON.parse(await getTool().handler({
      action: 'update_line', contractId: 'contract-1', lineId: 'line-1', patch: { includedQuantity: null },
    }, auth));
    expect(bad.code).toBe('INVALID_LINE_PATCH');
  });

  // The payload parser wraps the value under its param name, so a ZodError path
  // reads `patch.lineType` rather than a bare `lineType`.
  it('rejects a patch containing lineType with a VALIDATION_ERROR naming patch.lineType', async () => {
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'x', lineType: 'flat' } }));
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(out)).toContain('patch');
    expect(contractService.updateContractLine).not.toHaveBeenCalled();
  });

  it('writes the audit with tool_name manage_contracts and initiatedBy ai', async () => {
    await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'Renamed' } });
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: 'org-1', action: 'contract.line.updated', resourceType: 'contract', resourceId: 'contract-1',
      initiatedBy: 'ai',
      details: { contractLineId: 'line-1', lineType: 'flat', changedFields: ['description'], tool_name: 'manage_contracts' },
    });
  });

  it('add_line and remove_line audit too', async () => {
    const added = JSON.parse(await run({ action: 'add_line', contractId: CONTRACT_ID, line: { lineType: 'flat', description: 'Fee', unitPrice: '5.00', taxable: false } }));
    // The audit-only contractName helper must feed resourceName and never reach the model.
    expect(writeAuditEvent.mock.calls.at(-1)![1]).toMatchObject({ action: 'contract.line.added', initiatedBy: 'ai', resourceName: 'Managed Services' });
    expect(added).not.toHaveProperty('contractName');
    expect(added).toMatchObject({ id: 'line-1' });
    await run({ action: 'remove_line', contractId: CONTRACT_ID, lineId: LINE_ID });
    expect(writeAuditEvent.mock.calls.at(-1)![1]).toMatchObject({ action: 'contract.line.removed', initiatedBy: 'ai' });
  });

  // Without this a model told "those changes aren't valid" has nothing to
  // self-correct against.
  it('surfaces ContractServiceError details in the JSON error', async () => {
    (contractService.updateContractLine as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ContractServiceError('bad patch', 400, 'INVALID_LINE_PATCH', { issues: [{ path: 'siteId', message: 'nope' }] }),
    );
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { siteId: null } }));
    expect(out).toEqual({ error: 'bad patch', code: 'INVALID_LINE_PATCH', details: { issues: [{ path: 'siteId', message: 'nope' }] } });
  });

  it('the tool description explains the tri-state catalogItemId and the locked lineType', () => {
    const props = getTool().definition.input_schema.properties as Record<string, { description?: string; enum?: string[] }>;
    expect(props.action!.enum).toContain('update_line');
    const desc = props.patch!.description!;
    expect(desc).toContain('lineType');
    expect(desc).toContain('refreshCatalogPrice');
    expect(desc).toMatch(/future billing periods/i);
  });

  it('documents the allowance semantics on both the line and the patch descriptions (#3205 W04)', () => {
    const schema = getTool().definition.input_schema as { properties: Record<string, { description?: string }> };
    for (const key of ['line', 'patch']) {
      const desc = schema.properties[key]!.description!;
      expect(desc).toContain('includedQuantity');
      expect(desc).toContain('overageMode');
      expect(desc).toContain('overageUnitPrice');
      // The fixed-allowance rule is the one thing a model will otherwise get wrong.
      expect(desc).toMatch(/every period even when the live count is lower/i);
    }
    const lineDesc = schema.properties.line!.description!;
    expect(lineDesc).toMatch(/For add_line, includedQuantity and overageMode must be supplied together/i);
    const patchDesc = schema.properties.patch!.description!;
    expect(patchDesc).toMatch(/For update_line, the rule applies to the merged line/i);
    expect(patchDesc).toMatch(/absent fields are unchanged/i);
    expect(patchDesc).toMatch(/null clears/i);
    expect(patchDesc).toMatch(/clearing includedQuantity clears the allowance/i);
  });
});
