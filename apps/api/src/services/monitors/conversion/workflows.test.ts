import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import type { configPolicyAutomations } from '../../../db/schema';
import type { DbExecutor } from '../monitorCompiler';
import { rehomePolicyWorkflow } from './workflows';

const mocks = vi.hoisted(() => ({ references: vi.fn(), bindings: vi.fn() }));
vi.mock('../../automationRuntime', () => ({
  normalizeAutomationActions: (actions: unknown) => actions,
  resolveAutomationReferencesForOwner: mocks.references,
  replaceAutomationResourceBindings: mocks.bindings,
}));
const source = {
  id: 'source', name: 'All critical alerts', enabled: false,
  actions: [{ type: 'execute_command', command: 'echo triage' }], onFailure: 'continue',
} as typeof configPolicyAutomations.$inferSelect;
const policy = { id: 'policy', orgId: 'org', partnerId: null };
const auth: AuthContext = { scope: 'system', principal: { kind: 'system', reason: 'test' },
  user: { id: 'actor', email: 'actor@example.com', name: 'Actor', isPlatformAdmin: true },
  token: null, partnerId: null, orgId: null, accessibleOrgIds: null,
  canAccessOrg: () => true, orgCondition: () => undefined,
};
function fixture(rows = [{ id: 'workflow' }]) {
  const values = vi.fn(() => ({ returning: async () => rows }));
  const insert = vi.fn(() => ({ values }));
  const tx = { insert, rollback: vi.fn() } as unknown as DbExecutor;
  return { tx, insert, values };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.references.mockResolvedValue({});
  mocks.bindings.mockResolvedValue(undefined);
});
it('preserves enabled, actions and failure behavior on a same-axis standalone workflow', async () => {
  const { tx, values } = fixture();
  await expect(rehomePolicyWorkflow(tx, source, policy, auth)).resolves.toBe('workflow');
  expect(values).toHaveBeenCalledWith(expect.objectContaining({
    orgId: 'org', partnerId: null, enabled: false, actions: source.actions,
    onFailure: 'continue', createdBy: null,
    trigger: { type: 'event', eventType: 'alert.triggered', filter: {
      _policyWorkflow: { policyId: 'policy', sourceId: 'source' },
    } },
  }));
  expect(mocks.bindings).toHaveBeenCalledWith(tx, 'workflow', { orgId: 'org', partnerId: null }, {});
});
it('preserves partner ownership and the human actor', async () => {
  const { tx, values } = fixture();
  await rehomePolicyWorkflow(tx, source, { ...policy, orgId: null, partnerId: 'partner' }, {
    scope: 'partner', partnerOrgAccess: 'all', partnerId: 'partner', user: { id: 'user' },
  } as AuthContext);
  expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, partnerId: 'partner', createdBy: 'user' }));
});
it.each([
  [{ ...policy }, { scope: 'organization', canAccessOrg: () => false }],
  [{ ...policy, orgId: null, partnerId: 'partner' }, { scope: 'partner', partnerOrgAccess: 'selected', partnerId: 'partner' }],
  [{ ...policy, orgId: null, partnerId: 'partner' }, { scope: 'partner', partnerOrgAccess: 'all', partnerId: 'other' }],
  [{ ...policy, orgId: null, partnerId: 'partner' }, { scope: 'organization', partnerOrgAccess: 'all', partnerId: 'partner' }],
])('rejects unauthorized ownership before references or writes', async (owner, caller) => {
  const { tx, insert } = fixture();
  await expect(rehomePolicyWorkflow(tx, source, owner, caller as AuthContext)).rejects.toThrow('Workflow owner access denied');
  expect(mocks.references).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});
it('propagates resource authorization failure before writing or retirement', async () => {
  const { tx, insert } = fixture();
  mocks.references.mockRejectedValueOnce(new Error('Resource owner access denied'));
  await expect(rehomePolicyWorkflow(tx, source, policy, auth)).rejects.toThrow('Resource owner access denied');
  expect(insert).not.toHaveBeenCalled();
  expect(mocks.bindings).not.toHaveBeenCalled();
});
it('rejects missing created rows and propagates binding failures to roll back the caller transaction', async () => {
  await expect(rehomePolicyWorkflow(fixture([]).tx, source, policy, auth)).rejects.toThrow('Workflow creation failed');
  expect(mocks.bindings).not.toHaveBeenCalled();
  mocks.bindings.mockRejectedValueOnce(new Error('Binding failed'));
  await expect(rehomePolicyWorkflow(fixture().tx, source, policy, auth)).rejects.toThrow('Binding failed');
});
it('requires a transaction so a binding failure cannot leave a standalone workflow committed', async () => {
  await expect(rehomePolicyWorkflow({} as DbExecutor, source, policy, auth)).rejects.toThrow('Workflow requires a transaction');
});
