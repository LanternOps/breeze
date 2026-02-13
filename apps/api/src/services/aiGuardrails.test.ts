import { describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./aiTools', () => ({
  getToolTier: vi.fn((toolName: string) => {
    const tiers: Record<string, number> = {
      manage_policies: 1,
      manage_deployments: 1,
      manage_patches: 1,
      manage_groups: 1,
      manage_maintenance_windows: 1,
      manage_automations: 1,
      manage_alert_rules: 1,
      generate_report: 1,
      // Non-fleet tools for baseline tests
      query_devices: 1,
      execute_command: 3,
    };
    return tiers[toolName];
  }),
}));

vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock('./rate-limit', () => ({
  rateLimiter: vi.fn(),
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(),
}));

import { checkGuardrails } from './aiGuardrails';

// ─── Tier escalation for fleet tools ────────────────────────────────────

describe('checkGuardrails — fleet tool tier escalation', () => {
  // --- Tier 1: Read-only actions (auto-execute) ---

  describe('Tier 1 (auto-execute) — read-only actions', () => {
    const t1Cases: [string, string][] = [
      ['manage_policies', 'list'],
      ['manage_policies', 'get'],
      ['manage_policies', 'compliance_status'],
      ['manage_policies', 'compliance_summary'],
      ['manage_deployments', 'list'],
      ['manage_deployments', 'get'],
      ['manage_deployments', 'device_status'],
      ['manage_patches', 'list'],
      ['manage_patches', 'compliance'],
      ['manage_groups', 'list'],
      ['manage_groups', 'get'],
      ['manage_groups', 'preview'],
      ['manage_groups', 'membership_log'],
      ['manage_maintenance_windows', 'list'],
      ['manage_maintenance_windows', 'get'],
      ['manage_maintenance_windows', 'active_now'],
      ['manage_automations', 'list'],
      ['manage_automations', 'get'],
      ['manage_automations', 'history'],
      ['manage_alert_rules', 'list_rules'],
      ['manage_alert_rules', 'get_rule'],
      ['manage_alert_rules', 'test_rule'],
      ['manage_alert_rules', 'list_channels'],
      ['manage_alert_rules', 'alert_summary'],
      ['generate_report', 'list'],
      ['generate_report', 'data'],
      ['generate_report', 'history'],
    ];

    it.each(t1Cases)('%s:%s → Tier 1, no approval', (tool, action) => {
      const result = checkGuardrails(tool, { action });
      expect(result.tier).toBe(1);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  // --- Tier 2: Auto-execute + audit ---

  describe('Tier 2 (auto-execute + audit) — low-risk mutations', () => {
    const t2Cases: [string, string][] = [
      ['manage_policies', 'evaluate'],
      ['manage_policies', 'activate'],
      ['manage_policies', 'deactivate'],
      ['manage_deployments', 'pause'],
      ['manage_deployments', 'resume'],
      ['manage_patches', 'approve'],
      ['manage_patches', 'decline'],
      ['manage_patches', 'defer'],
      ['manage_patches', 'bulk_approve'],
      ['manage_groups', 'add_devices'],
      ['manage_groups', 'remove_devices'],
      ['manage_maintenance_windows', 'create'],
      ['manage_maintenance_windows', 'update'],
      ['manage_automations', 'enable'],
      ['manage_automations', 'disable'],
      ['manage_alert_rules', 'create_rule'],
      ['manage_alert_rules', 'update_rule'],
      ['generate_report', 'create'],
      ['generate_report', 'update'],
      ['generate_report', 'delete'],
      ['generate_report', 'generate'],
    ];

    it.each(t2Cases)('%s:%s → Tier 2, no approval', (tool, action) => {
      const result = checkGuardrails(tool, { action });
      expect(result.tier).toBe(2);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  // --- Tier 3: Requires user approval ---

  describe('Tier 3 (requires approval) — destructive/mutating operations', () => {
    const t3Cases: [string, string][] = [
      ['manage_policies', 'create'],
      ['manage_policies', 'update'],
      ['manage_policies', 'delete'],
      ['manage_policies', 'remediate'],
      ['manage_deployments', 'create'],
      ['manage_deployments', 'start'],
      ['manage_deployments', 'cancel'],
      ['manage_patches', 'scan'],
      ['manage_patches', 'install'],
      ['manage_patches', 'rollback'],
      ['manage_groups', 'create'],
      ['manage_groups', 'update'],
      ['manage_groups', 'delete'],
      ['manage_maintenance_windows', 'delete'],
      ['manage_automations', 'create'],
      ['manage_automations', 'update'],
      ['manage_automations', 'delete'],
      ['manage_automations', 'run'],
      ['manage_alert_rules', 'delete_rule'],
    ];

    it.each(t3Cases)('%s:%s → Tier 3, approval required', (tool, action) => {
      const result = checkGuardrails(tool, { action });
      expect(result.tier).toBe(3);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('provides a description for Tier 3 actions', () => {
      const result = checkGuardrails('manage_policies', { action: 'create', name: 'Require AV' });
      expect(result.description).toBeTruthy();
      expect(typeof result.description).toBe('string');
    });
  });

  // --- Unknown tool → Tier 4 (blocked) ---

  it('blocks unknown tools with Tier 4', () => {
    const result = checkGuardrails('nonexistent_tool', { action: 'list' });
    expect(result.tier).toBe(4);
    expect(result.allowed).toBe(false);
  });

  // --- Base tier without action → uses base tier ---

  it('uses base tier when no action provided', () => {
    const result = checkGuardrails('manage_policies', {});
    expect(result.tier).toBe(1);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

// ─── Approval descriptions for fleet tools ──────────────────────────────

describe('checkGuardrails — fleet approval descriptions', () => {
  it('includes policy name in create description', () => {
    const result = checkGuardrails('manage_policies', { action: 'create', name: 'Require Firewall' });
    expect(result.description).toContain('Require Firewall');
  });

  it('includes deployment name in start description', () => {
    const result = checkGuardrails('manage_deployments', { action: 'start', deploymentId: '123' });
    expect(result.description).toBeTruthy();
  });

  it('includes patch action in install description', () => {
    const result = checkGuardrails('manage_patches', { action: 'install', patchIds: ['a', 'b'], deviceIds: ['c'] });
    expect(result.description).toBeTruthy();
  });

  it('includes group name in create description', () => {
    const result = checkGuardrails('manage_groups', { action: 'create', name: 'Accounting' });
    expect(result.description).toContain('Accounting');
  });

  it('includes automation name in create description', () => {
    const result = checkGuardrails('manage_automations', { action: 'create', name: 'Auto-restart' });
    expect(result.description).toContain('Auto-restart');
  });
});
