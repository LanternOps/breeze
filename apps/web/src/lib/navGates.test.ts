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

it('Wisp memory fails closed until the server reports wispEnabled (W03: flag off = no card, no nav entry)', async () => {
  const { SETTINGS_CATALOG } = await import('./settingsCatalog');
  const entry = SETTINGS_CATALOG.find((e) => e.id === 'wisp-memory');
  expect(entry?.requiresWisp).toBe(true);
  const ctx = { ...context, permissions: [{ resource: 'ai_sessions', action: 'use' }] };
  expect(isNavGateVisible(entry!, ctx)).toBe(false);
  expect(isNavGateVisible(entry!, { ...ctx, wispEnabled: false })).toBe(false);
  expect(isNavGateVisible(entry!, { ...ctx, wispEnabled: true })).toBe(true);
  expect(isNavGateVisible(entry!, { ...ctx, wispEnabled: true, permissions: [] })).toBe(false);
});

it('flows navigation fails closed until the server flag is explicitly on', () => {
  const gate = { requiresFlows: true, requiredPermission: { resource: 'automations', action: 'read' } } as const;
  const ctx = { ...context, permissions: [{ resource: 'automations', action: 'read' }] };
  expect(isNavGateVisible(gate, ctx)).toBe(false);
  expect(isNavGateVisible(gate, { ...ctx, flowsEnabled: false })).toBe(false);
  expect(isNavGateVisible(gate, { ...ctx, flowsEnabled: true })).toBe(true);
  expect(isNavGateVisible(gate, { ...ctx, flowsEnabled: true, permissions: [] })).toBe(false);
});
