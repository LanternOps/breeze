import { describe, expect, it } from 'vitest';
import { canOpenDestination, pickNavGate, type NavViewer } from './navVisibility';

const base: NavViewer = {
  isPlatformAdmin: false,
  permissions: [{ resource: 'devices', action: 'read' }],
  getScope: () => 'partner',
  toolSourcesEnabled: false,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
};

describe('canOpenDestination (one case per Sidebar gate flag)', () => {
  it('requiredPermission', () => {
    const gate = { requiredPermission: { resource: 'devices', action: 'read' } } as const;
    expect(canOpenDestination(gate, base)).toBe(true);
    expect(canOpenDestination(gate, { ...base, permissions: [{ resource: 'alerts', action: 'read' }] })).toBe(false);
  });

  it('hidden while permissions are still loading', () => {
    const gate = { requiredPermission: { resource: 'devices', action: 'read' } } as const;
    expect(canOpenDestination(gate, { ...base, permissions: undefined })).toBe(false);
  });

  it('alsoRequiredPermissions must all be held', () => {
    const gate = {
      requiredPermission: { resource: 'devices', action: 'read' },
      alsoRequiredPermissions: [{ resource: 'organizations', action: 'write' }],
    } as const;
    expect(canOpenDestination(gate, base)).toBe(false);
    expect(
      canOpenDestination(gate, {
        ...base,
        permissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'organizations', action: 'write' },
        ],
      }),
    ).toBe(true);
  });

  it('requiresModule service_management hides unless native', () => {
    const gate = { requiresModule: 'service_management' } as const;
    expect(canOpenDestination(gate, base)).toBe(true);
    expect(canOpenDestination(gate, { ...base, serviceManagementMode: 'off' })).toBe(false);
    expect(canOpenDestination(gate, { ...base, serviceManagementMode: 'external' })).toBe(false);
  });

  it('platformAdminOnly', () => {
    expect(canOpenDestination({ platformAdminOnly: true }, base)).toBe(false);
    expect(canOpenDestination({ platformAdminOnly: true }, { ...base, isPlatformAdmin: true })).toBe(true);
  });

  it('partnerScopeOnly hides for an org-scoped token', () => {
    expect(canOpenDestination({ partnerScopeOnly: true }, base)).toBe(true);
    expect(canOpenDestination({ partnerScopeOnly: true }, { ...base, getScope: () => 'organization' })).toBe(false);
  });

  it('requiresPartnerWideAdmin', () => {
    expect(canOpenDestination({ requiresPartnerWideAdmin: true }, base)).toBe(false);
    expect(canOpenDestination({ requiresPartnerWideAdmin: true }, { ...base, canManagePartnerWide: true })).toBe(true);
  });

  it('ungated destination is always visible', () => {
    expect(canOpenDestination({}, { ...base, permissions: undefined })).toBe(true);
  });
});

describe('pickNavGate', () => {
  it('keeps only gate fields from a nav item', () => {
    const item = {
      name: 'Tickets',
      href: '/tickets',
      requiredPermission: { resource: 'tickets', action: 'read' },
      requiresModule: 'service_management',
      testId: 'x',
    };
    expect(pickNavGate(item as never)).toEqual({
      requiredPermission: { resource: 'tickets', action: 'read' },
      requiresModule: 'service_management',
    });
  });
});
