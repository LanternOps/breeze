import { expect, it } from 'vitest';
import { isNavGateVisible, type NavGateContext } from './navGates';
const context: NavGateContext = { isPlatformAdmin: false, permissions: [{ resource: 'billing', action: 'manage' }],
  getScope: () => 'partner', toolSourcesEnabled: false, aiForOfficeEnabled: false, serviceManagementMode: 'native' };
it('autopay navigation fails closed until its partner gate is explicitly enabled', () => {
  const gate = { requiresAutopay: true, requiredPermission: { resource: 'billing', action: 'manage' } } as const;
  expect(isNavGateVisible(gate, context)).toBe(false);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: false })).toBe(false);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: true })).toBe(true);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: true, permissions: [] })).toBe(false);
});
