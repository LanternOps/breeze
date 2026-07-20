import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./aiTools', () => ({
  getToolTier: vi.fn((toolName: string) => {
    const tiers: Record<string, number> = {
      manage_deployments: 1,
      manage_patches: 1,
      manage_groups: 1,
      manage_maintenance_windows: 1,
      manage_automations: 1,
      manage_alert_rules: 1,
      generate_report: 1,
      // Configuration policy tools
      manage_configuration_policy: 1,
      get_configuration_policy: 1,
      configuration_policy_compliance: 1,
      // Playbook tools
      list_playbooks: 1,
      execute_playbook: 3,
      get_playbook_history: 1,
      // Non-fleet tools for baseline tests
      query_devices: 1,
      query_change_log: 1,
      // file_operations base tier 1; guardrails escalate read/write/delete/mkdir/rename to
      // Tier 3 (SR5-01) and downgrade list to Tier 2 (recon only)
      file_operations: 1,
      execute_command: 3,
      run_backup_verification: 2,
      // Ticketing tools
      manage_tickets: 1,
      manage_alerts: 1,
      // Billing/ticketing write tools
      manage_invoices: 2,
      manage_catalog: 2,
      manage_contracts: 2,
      manage_quotes: 2,
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

import { checkGuardrails, checkToolPermission, checkPermissionRequirement, checkPermissionRequirements } from './aiGuardrails';
import { getUserPermissions, hasPermission } from './permissions';

// ─── Tier escalation for fleet tools ────────────────────────────────────

describe('checkGuardrails — fleet tool tier escalation', () => {
  // --- Tier 1: Read-only actions (auto-execute) ---

  describe('Tier 1 (auto-execute) — read-only actions', () => {
    const t1Cases: [string, string][] = [
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
      // Disabled mutation actions — tools return policy redirect before guardrails apply,
      // but checkGuardrails resolves them at base tier since they're not in TIER2/TIER3 maps.
      ['manage_maintenance_windows', 'create'],
      ['manage_maintenance_windows', 'update'],
      ['manage_maintenance_windows', 'delete'],
      ['manage_alert_rules', 'create_rule'],
      ['manage_alert_rules', 'update_rule'],
      ['manage_alert_rules', 'delete_rule'],
      ['manage_automations', 'create'],
      ['manage_automations', 'update'],
      ['manage_automations', 'delete'],
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
      ['manage_configuration_policy', 'activate'],
      ['manage_configuration_policy', 'deactivate'],
      ['manage_deployments', 'pause'],
      ['manage_deployments', 'resume'],
      ['manage_patches', 'approve'],
      ['manage_patches', 'decline'],
      ['manage_patches', 'defer'],
      ['manage_patches', 'bulk_approve'],
      ['manage_groups', 'add_devices'],
      ['manage_groups', 'remove_devices'],
      ['manage_automations', 'enable'],
      ['manage_automations', 'disable'],
      ['generate_report', 'create'],
      ['generate_report', 'update'],
      ['generate_report', 'delete'],
      ['generate_report', 'generate'],
      ['manage_patches', 'scan'],
      ['manage_tickets', 'log_time_entry'],
      ['manage_tickets', 'start_timer'],
      ['manage_tickets', 'stop_timer'],
      ['file_operations', 'list'],
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
      ['manage_configuration_policy', 'create'],
      ['manage_configuration_policy', 'update'],
      ['manage_configuration_policy', 'delete'],
      ['manage_deployments', 'create'],
      ['manage_deployments', 'start'],
      ['manage_deployments', 'cancel'],
      ['manage_patches', 'install'],
      ['manage_patches', 'rollback'],
      ['manage_groups', 'create'],
      ['manage_groups', 'update'],
      ['manage_groups', 'delete'],
      ['manage_automations', 'run'],
    ];

    it.each(t3Cases)('%s:%s → Tier 3, approval required', (tool, action) => {
      const result = checkGuardrails(tool, { action });
      expect(result.tier).toBe(3);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('provides a description for Tier 3 actions', () => {
      const result = checkGuardrails('manage_configuration_policy', { action: 'create', name: 'Require AV' });
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
    const result = checkGuardrails('manage_configuration_policy', {});
    expect(result.tier).toBe(1);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('applies base tier semantics for playbook tools', () => {
    const readTool = checkGuardrails('list_playbooks', {});
    expect(readTool.tier).toBe(1);
    expect(readTool.requiresApproval).toBe(false);

    const execTool = checkGuardrails('execute_playbook', {
      playbookId: '11111111-1111-1111-1111-111111111111',
      deviceId: '22222222-2222-2222-2222-222222222222',
    });
    expect(execTool.tier).toBe(3);
    expect(execTool.requiresApproval).toBe(true);
  });

  it('treats query_change_log as Tier 1 read-only', () => {
    const result = checkGuardrails('query_change_log', {});
    expect(result.tier).toBe(1);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('does not require a special full recovery approval path for backup verification', () => {
    const result = checkGuardrails('run_backup_verification', {
      deviceId: '11111111-1111-1111-1111-111111111111',
      verificationType: 'test_restore',
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

// ─── Approval descriptions for fleet tools ──────────────────────────────

describe('checkGuardrails — fleet approval descriptions', () => {
  it('includes policy name in create description', () => {
    const result = checkGuardrails('manage_configuration_policy', { action: 'create', name: 'Require Firewall' });
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

// ─── checkPermissionRequirement (MCP-OAUTH-03 extracted core) ──────────

describe('checkPermissionRequirement — extracted core reused by checkToolPermission and resources/read', () => {
  const baseAuth = {
    user: { id: 'user-1' },
    token: { roleId: 'viewer', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  beforeEach(() => {
    vi.mocked(getUserPermissions).mockReset();
    vi.mocked(hasPermission).mockReset();
  });

  it('allows (returns null) when !auth.token — helper-session short-circuit preserved', async () => {
    const helperAuth = { ...baseAuth, token: undefined } as any;
    const result = await checkPermissionRequirement(helperAuth, { resource: 'devices', action: 'read' });
    expect(result).toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('allows (returns null) when auth.token.roleId === null — helper-session short-circuit preserved', async () => {
    const helperAuth = { ...baseAuth, token: { roleId: null, scope: 'organization' } } as any;
    const result = await checkPermissionRequirement(helperAuth, { resource: 'devices', action: 'read' });
    expect(result).toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('denies with "no role assigned" when getUserPermissions resolves null', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    const result = await checkPermissionRequirement(baseAuth, { resource: 'devices', action: 'read' });
    expect(result).toBe('Insufficient permissions: no role assigned');
  });

  it('denies with the resource.action message when hasPermission returns false', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockReturnValue(false);
    const result = await checkPermissionRequirement(baseAuth, { resource: 'devices', action: 'read' });
    expect(result).toBe('Insufficient permissions: requires devices.read');
  });

  it('allows (returns null) when hasPermission returns true', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);
    const result = await checkPermissionRequirement(baseAuth, { resource: 'devices', action: 'read' });
    expect(result).toBeNull();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'read');
  });
});

describe('checkToolPermission — reliability and posture read tools', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'viewer', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  it('enforces devices.read for get_fleet_health', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockReturnValue(false);

    const result = await checkToolPermission('get_fleet_health', {}, auth);
    expect(result).toContain('requires devices.read');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'read');
  });

  it('allows get_security_posture when devices.read is present', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('get_security_posture', { orgId: 'org-1' }, auth);
    expect(result).toBeNull();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'read');
  });
});

describe('checkToolPermission — backup restore tools', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'operator', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  it('requires backup.read in addition to devices.execute for snapshot restores', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockImplementation((_perms, resource, action) => {
      return resource === 'devices' && action === 'execute';
    });

    const result = await checkToolPermission('restore_snapshot', {}, auth);

    expect(result).toContain('requires backup.read');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'execute');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'backup', 'read');
  });

  it('allows restore tools when devices.execute and backup.read are present', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockImplementation((_perms, resource, action) => {
      return (
        (resource === 'devices' && action === 'execute') ||
        (resource === 'backup' && action === 'read')
      );
    });

    const result = await checkToolPermission('restore_mssql_database', {}, auth);

    expect(result).toBeNull();
  });

  it('resolves getUserPermissions once even when extra permissions are required', async () => {
    vi.mocked(getUserPermissions).mockClear();
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    // restore_snapshot has a base permission plus TOOL_EXTRA_PERMISSIONS —
    // all requirements must be checked against a single role resolution.
    const result = await checkToolPermission('restore_snapshot', {}, auth);

    expect(result).toBeNull();
    expect(getUserPermissions).toHaveBeenCalledTimes(1);
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'execute');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'backup', 'read');
  });
});

describe('checkPermissionRequirements — batch variant', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'operator', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  beforeEach(() => {
    vi.mocked(hasPermission).mockReset();
    vi.mocked(getUserPermissions).mockReset();
  });

  it('returns null for an empty requirement list without resolving permissions', async () => {
    const result = await checkPermissionRequirements(auth, []);
    expect(result).toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns the first denial in requirement order', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockImplementation((_perms, resource) => resource !== 'backup');

    const result = await checkPermissionRequirements(auth, [
      { resource: 'devices', action: 'execute' },
      { resource: 'backup', action: 'read' },
      { resource: 'alerts', action: 'read' },
    ]);

    expect(result).toBe('Insufficient permissions: requires backup.read');
    expect(getUserPermissions).toHaveBeenCalledTimes(1);
  });
});

// ─── manage_tickets: tier escalation + RBAC map ─────────────────────────

describe('checkGuardrails — manage_tickets tier escalation', () => {
  it('list and get resolve at Tier 1 (base, auto-execute)', () => {
    for (const action of ['list', 'get']) {
      const result = checkGuardrails('manage_tickets', { action });
      expect(result.tier).toBe(1);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    }
  });

  it('create/comment/assign/update_status escalate to Tier 2 via TIER2_ACTIONS', () => {
    for (const action of ['create', 'comment', 'assign', 'update_status']) {
      const result = checkGuardrails('manage_tickets', { action });
      expect(result.tier).toBe(2);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    }
  });

  it('log_time_entry/start_timer/stop_timer resolve to Tier 2 (auto-execute + audit)', () => {
    for (const action of ['log_time_entry', 'start_timer', 'stop_timer']) {
      const result = checkGuardrails('manage_tickets', { action });
      expect(result.tier).toBe(2);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    }
  });

  it('update_status remains Tier 2 alongside the time-entry actions in TIER2_ACTIONS', () => {
    const result = checkGuardrails('manage_tickets', { action: 'update_status' });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(false);
  });

  it('move_org remains Tier 3 (tenant-shape mutation)', () => {
    const result = checkGuardrails('manage_tickets', { action: 'move_org' });
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
  });
});

describe('checkGuardrails — billing and proposal action tier escalation', () => {
  it.each([
    ['manage_invoices', 'issue'],
    ['manage_contracts', 'activate'],
    ['manage_quotes', 'send'],
  ])('%s:%s resolves to Tier 3 and requires approval', (tool, action) => {
    const result = checkGuardrails(tool, { action });
    expect(result.tier).toBe(3);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('manage_invoices:create_draft stays Tier 2 without approval', () => {
    const result = checkGuardrails('manage_invoices', { action: 'create_draft' });
    expect(result.tier).toBe(2);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

describe('checkToolPermission — manage_tickets RBAC map', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'operator', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  beforeEach(() => {
    vi.mocked(hasPermission).mockClear();
    vi.mocked(getUserPermissions).mockClear();
  });

  it('requires tickets.read for list action', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(false);

    const result = await checkToolPermission('manage_tickets', { action: 'list' }, auth);
    expect(result).toContain('requires tickets.read');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'tickets', 'read');
  });

  it('requires tickets.write for create action', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(false);

    const result = await checkToolPermission('manage_tickets', { action: 'create' }, auth);
    expect(result).toContain('requires tickets.write');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'tickets', 'write');
  });

  it('allows list when tickets.read is present', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('manage_tickets', { action: 'list' }, auth);
    expect(result).toBeNull();
  });

  it('denies when action arg is missing (fail-closed)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('manage_tickets', {}, auth);
    expect(result).toBe('Missing required "action" argument for tool "manage_tickets"');
    expect(hasPermission).not.toHaveBeenCalled();
  });
});

describe('checkToolPermission — action-multiplexed tools require action arg', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'operator', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  beforeEach(() => {
    vi.mocked(hasPermission).mockClear();
    vi.mocked(getUserPermissions).mockClear();
  });

  it('denies action-multiplexed tools when action arg is missing (manage_groups)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('manage_groups', {}, auth);

    expect(result).toBe('Missing required "action" argument for tool "manage_groups"');
    // RBAC permission lookup must NOT have been consulted — we fail closed before it.
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('denies action-multiplexed tools when action arg is missing (manage_alerts)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('manage_alerts', {}, auth);

    expect(result).toBe('Missing required "action" argument for tool "manage_alerts"');
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('permits action-multiplexed tools when action arg is present and permitted', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    const result = await checkToolPermission('manage_groups', { action: 'list' }, auth);

    // Should not be the missing-action denial — the action path must run.
    expect(result).not.toBe('Missing required "action" argument for tool "manage_groups"');
    expect(result).toBeNull();
  });

  it('does not affect simple (non-multiplexed) tools called without action', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockReturnValue(true);

    // query_devices has a flat { resource, action } permDef — no action arg required.
    const result = await checkToolPermission('query_devices', {}, auth);

    expect(result).toBeNull();
  });
});

// ─── SR5-01: filesystem read/write are privileged (execute + Tier 3) ────

describe('checkGuardrails — file_operations read escalates to Tier 3 (SR5-01)', () => {
  it('read requires interactive approval, not auto-execute', () => {
    const result = checkGuardrails('file_operations', { action: 'read', path: '/etc/shadow' });
    expect(result.tier).toBe(3);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('write/delete/mkdir/rename remain Tier 3', () => {
    for (const action of ['write', 'delete', 'mkdir', 'rename']) {
      const result = checkGuardrails('file_operations', { action, path: '/tmp/x' });
      expect(result.tier).toBe(3);
      expect(result.requiresApproval).toBe(true);
    }
  });
});

describe('file_operations tier boundary (SR5-01 partial relaxation)', () => {
  it('list is Tier 2 (auto-execute + audit) — recon only, deliberate downgrade', () => {
    const result = checkGuardrails('file_operations', { action: 'list', deviceId: 'd1', path: '/tmp' });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it.each(['read', 'write', 'delete', 'mkdir', 'rename'])(
    '%s stays Tier 3 (root-context content access requires approval)',
    (action) => {
      const result = checkGuardrails('file_operations', { action, deviceId: 'd1', path: '/tmp/x' });
      expect(result.tier).toBe(3);
      expect(result.requiresApproval).toBe(true);
    },
  );
});

describe('checkToolPermission — file_operations requires devices.execute (SR5-01)', () => {
  const auth = {
    user: { id: 'user-1' },
    token: { roleId: 'viewer', scope: 'organization' },
    orgId: 'org-1',
    partnerId: null,
  } as any;

  beforeEach(() => {
    vi.mocked(hasPermission).mockClear();
    vi.mocked(getUserPermissions).mockClear();
  });

  it('read is denied for a devices.read-only role (no longer maps to devices.read)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    // Role has devices.read but NOT devices.execute.
    vi.mocked(hasPermission).mockImplementation((_perms, resource, action) =>
      resource === 'devices' && action === 'read'
    );

    const result = await checkToolPermission('file_operations', { action: 'read', path: '/etc/shadow' }, auth);

    expect(result).toBe('Insufficient permissions: requires devices.execute');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'execute');
    // Must NOT have been satisfied by devices.read.
    expect(hasPermission).not.toHaveBeenCalledWith(expect.anything(), 'devices', 'read');
  });

  it('list is likewise gated on devices.execute', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'viewer' } as any);
    vi.mocked(hasPermission).mockImplementation((_perms, resource, action) =>
      resource === 'devices' && action === 'read'
    );

    const result = await checkToolPermission('file_operations', { action: 'list', path: '/root' }, auth);

    expect(result).toBe('Insufficient permissions: requires devices.execute');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'execute');
  });

  it('read is allowed when the role holds devices.execute', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'operator' } as any);
    vi.mocked(hasPermission).mockImplementation((_perms, resource, action) =>
      resource === 'devices' && action === 'execute'
    );

    const result = await checkToolPermission('file_operations', { action: 'read', path: '/etc/hosts' }, auth);

    expect(result).toBeNull();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'devices', 'execute');
  });
});
