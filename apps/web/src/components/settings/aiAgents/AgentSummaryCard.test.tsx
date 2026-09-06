import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AgentPreviewDto } from '@breeze/shared';
import AgentSummaryCard from './AgentSummaryCard';

/**
 * Every tool name here is deliberately fake (`fake_tool_*`) so the assertions
 * exercise the component's own label-formatting fallback (`sentenceCase`,
 * mirroring CapabilityPicker's) rather than depending on the real
 * `aiAgentsPage.catalog.tools/actions` translations staying stable.
 */
const baseOperations: AgentPreviewDto['operations'] = [
  { key: 'fake_tool_a:restart', capability: 'services_startup', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_b:stop', capability: 'services_startup', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_c:approve', capability: 'patching_software', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_d:install', capability: 'patching_software', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_e:list', capability: 'files_disk', outcome: 'logged_proposal', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_f', capability: 'files_disk', outcome: 'logged_proposal', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_g:scan', capability: 'security_response', outcome: 'logged_proposal', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
  { key: 'fake_tool_h:cleanup', capability: 'security_response', outcome: 'logged_proposal', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
];

function buildPreview(overrides: Partial<AgentPreviewDto> = {}): AgentPreviewDto {
  return {
    mode: 'shadow',
    kind: 'triage',
    readOnlyToolCount: 14,
    operations: baseOperations,
    unrecognised: [],
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true, ticketAutonomousWrites: false },
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    cooldownSeconds: 900,
    recipients: { userIds: [], roleIds: ['role-1', 'role-2'] },
    ...overrides,
  };
}

describe('AgentSummaryCard', () => {
  it('renders the title row with name, kind, mode and a "Created disabled" pill by default', () => {
    render(<AgentSummaryCard preview={buildPreview()} name="Triage bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-card')).toHaveTextContent('Triage bot');
    expect(screen.getByTestId('agent-summary-kind')).toHaveTextContent('Alert triage');
    expect(screen.getByTestId('agent-summary-mode')).toHaveTextContent('Shadow');
    expect(screen.getByTestId('agent-summary-org')).toHaveTextContent('Acme');
    expect(screen.getByTestId('agent-summary-enabled-pill')).toHaveTextContent('Created disabled');
  });

  it('shows "All orgs" when orgName is null and an "Enabled" pill when enabled is true', () => {
    render(<AgentSummaryCard preview={buildPreview()} name="Partner bot" orgName={null} enabled />);
    expect(screen.getByTestId('agent-summary-org')).toHaveTextContent('All orgs');
    expect(screen.getByTestId('agent-summary-enabled-pill')).toHaveTextContent('Enabled');
  });

  it('renders one chip per operation (4 approval requests + 4 logged proposals) in shadow mode', () => {
    render(<AgentSummaryCard preview={buildPreview()} name="Triage bot" orgName="Acme" />);
    expect(screen.getAllByTestId(/^agent-summary-chip-/)).toHaveLength(8);
  });

  it('names the org in the "Can read" sentence, or "all organizations" when partner-wide', () => {
    const { rerender } = render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-canRead')).toHaveTextContent('Acme');
    expect(screen.getByTestId('agent-summary-row-canRead')).toHaveTextContent('14');
    expect(screen.getByTestId('agent-summary-row-canRead').textContent).not.toMatch(/everything/i);

    rerender(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName={null} />);
    expect(screen.getByTestId('agent-summary-row-canRead')).toHaveTextContent('all organizations');
  });

  it('shows the shadow-mode "Nothing." sentence for executesUnattended', () => {
    render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-executesUnattended').textContent).toContain('Nothing.');
  });

  it('lists unattended operation labels in act mode', () => {
    const preview = buildPreview({
      mode: 'act',
      operations: [
        ...baseOperations.slice(0, 6),
        { key: 'fake_tool_i:restart', capability: 'services_startup', outcome: 'unattended', preauthorized: true, withinCeiling: true, unattendedBlockedBy: null },
        { key: 'fake_tool_j:cleanup', capability: 'files_disk', outcome: 'unattended', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
      ],
    });
    render(<AgentSummaryCard preview={preview} name="Act bot" orgName="Acme" />);
    const row = screen.getByTestId('agent-summary-row-executesUnattended');
    expect(row.textContent).toContain('Fake tool i');
    expect(row.textContent).toContain('Restart');
    expect(row.textContent).toContain('Fake tool j');
    expect(row.textContent).toContain('Cleanup');
    expect(row.textContent).not.toContain('Nothing.');
    // At least one unattended op is preauthorized -> the pre-authorized note appends.
    expect(row.textContent?.toLowerCase()).toContain('pre-authorized');
  });

  it('flags an operation outside the partner ceiling with the not-in-ceiling badge', () => {
    const preview = buildPreview({
      operations: [...baseOperations.slice(0, 7), { key: 'fake_tool_k:stop', capability: 'services_startup', outcome: 'approval_request', preauthorized: false, withinCeiling: false, unattendedBlockedBy: null }],
    });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-chip-fake_tool_k:stop')).toHaveTextContent('Not in partner baseline');
  });

  it('renders unrecognised allowlist entries in mono after the chips', () => {
    const preview = buildPreview({ unrecognised: ['restart_spooler'] });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    const entry = screen.getByTestId('agent-summary-unrecognised-restart_spooler');
    expect(entry).toHaveTextContent('restart_spooler');
    expect(entry.className).toContain('font-mono');
  });

  it('shows "Nothing is protected yet." when no resources are protected, else mono chips', () => {
    const { rerender } = render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-neverTouches')).toHaveTextContent('Nothing is protected yet.');

    const preview = buildPreview({ protectedResources: { services: ['spooler'], paths: ['C:\\Windows'], registryKeys: [], deviceTags: [] } });
    rerender(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-never-touches-chip-services-spooler')).toBeInTheDocument();
    expect(screen.getByTestId('agent-summary-never-touches-chip-paths-C:\\Windows')).toBeInTheDocument();
  });

  it('keys/test-ids "never touches" chips by category, not just the value, so the same value in two categories does not collide', () => {
    const preview = buildPreview({
      protectedResources: { services: ['shared'], paths: ['shared'], registryKeys: [], deviceTags: [] },
    });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);

    const serviceChip = screen.getByTestId('agent-summary-never-touches-chip-services-shared');
    const pathChip = screen.getByTestId('agent-summary-never-touches-chip-paths-shared');
    expect(serviceChip).not.toBe(pathChip);
    expect(serviceChip).toHaveTextContent('shared');
    expect(pathChip).toHaveTextContent('shared');
  });

  it('reads the six-limit sentence from preview.limits plus the sibling cooldownSeconds, with currency and percent formatting', () => {
    render(<AgentSummaryCard preview={buildPreview({ cooldownSeconds: 1800 })} name="Bot" orgName="Acme" />);
    const row = screen.getByTestId('agent-summary-row-limits');
    expect(row.textContent).toContain(String(AI_AGENT_LIMIT_DEFAULTS.maxDevicesPerRun));
    expect(row.textContent).toContain(String(AI_AGENT_LIMIT_DEFAULTS.maxRunsPerHour));
    expect(row.textContent).toContain(String(Math.round(AI_AGENT_LIMIT_DEFAULTS.wallClockSeconds / 60)));
    expect(row.textContent).toContain('$10.00');
    expect(row.textContent).toContain('5%');
    // cooldownSeconds: 1800 -> 30 minutes between runs on the same device.
    expect(row.textContent).toContain('30');
  });

  it('counts approver roles, or says none are configured', () => {
    const { rerender } = render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-approvers')).toHaveTextContent('2 roles');

    const preview = buildPreview({ recipients: { userIds: [], roleIds: [] } });
    rerender(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-approvers').textContent).not.toContain('0 roles');
  });

  it('names the approver roles when the caller knows them, singular and plural (#5048 QA)', () => {
    const one = buildPreview({ recipients: { userIds: [], roleIds: ['role-1'] } });
    const { rerender } = render(
      <AgentSummaryCard preview={one} name="Bot" orgName="Acme" recipientRoleNames={new Map([['role-1', 'Partner Admin']])} />,
    );
    const row = () => screen.getByTestId('agent-summary-row-approvers');
    expect(row()).toHaveTextContent('Partner Admin is asked');
    expect(row().textContent).not.toMatch(/1 roles/);

    rerender(
      <AgentSummaryCard
        preview={buildPreview()}
        name="Bot"
        orgName="Acme"
        recipientRoleNames={new Map([['role-1', 'Partner Admin'], ['role-2', 'Org Admin']])}
      />,
    );
    expect(row()).toHaveTextContent('Partner Admin and Org Admin are asked');

    // A role id the caller cannot name (deleted since) falls back to the count.
    rerender(<AgentSummaryCard preview={one} name="Bot" orgName="Acme" recipientRoleNames={new Map()} />);
    expect(row()).toHaveTextContent('1 role is asked');
  });

  it('pluralises the limits sentence for a single device / run / minute (#5048 QA)', () => {
    const preview = buildPreview({
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 1, maxRunsPerHour: 1, wallClockSeconds: 60 },
      cooldownSeconds: 60,
    });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    const text = screen.getByTestId('agent-summary-row-limits').textContent ?? '';
    expect(text).toContain('Up to 1 device per run');
    expect(text).toContain('1 run per hour');
    expect(text).toContain('1 minute per run');
    expect(text).toContain('1 minute between runs');
    expect(text).not.toMatch(/1 (devices|runs|minutes)/);
  });

  it('act mode: the "May propose" breakdown accounts for every listed operation, including the unattended ones (#5048 QA)', () => {
    const preview = buildPreview({
      mode: 'act',
      operations: [
        { key: 'fake_tool_a:restart', capability: 'services_startup', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
        { key: 'fake_tool_e:list', capability: 'files_disk', outcome: 'logged_proposal', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
        { key: 'fake_tool_i:restart', capability: 'services_startup', outcome: 'unattended', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
        { key: 'fake_tool_j:cleanup', capability: 'files_disk', outcome: 'unattended', preauthorized: false, withinCeiling: true, unattendedBlockedBy: null },
      ],
    });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    const text = screen.getByTestId('agent-summary-row-mayPropose').textContent ?? '';
    expect(text).toContain('4 operations across 2 capabilities');
    expect(text).toContain('1 raises an approval request');
    expect(text).toContain('1 is logged as a proposal');
    expect(text).toContain('2 run unattended');
  });

  it('act mode: explains a script-gated operation that stays an approval request until a script is authorized (#5048 QA)', () => {
    const preview = buildPreview({
      mode: 'act',
      operations: [
        { key: 'fake_run_script', capability: 'scripts_commands', outcome: 'approval_request', preauthorized: false, withinCeiling: true, unattendedBlockedBy: 'authorized_scripts' },
      ],
    });
    render(<AgentSummaryCard preview={preview} name="Bot" orgName="Acme" />);
    const row = screen.getByTestId('agent-summary-row-executesUnattended');
    expect(row).toHaveTextContent('Nothing yet');
    expect(screen.getByTestId('agent-summary-script-gate')).toHaveTextContent('Fake run script');
    expect(screen.getByTestId('agent-summary-script-gate').textContent).toMatch(/script is authorized/i);
  });

  it('calls onEdit with the section id for the title and each row, and omits Edit links when onEdit is absent', () => {
    const onEdit = vi.fn();
    render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" onEdit={onEdit} />);

    fireEvent.click(screen.getByTestId('agent-summary-title-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('purpose');

    fireEvent.click(screen.getByTestId('agent-summary-row-runsWhen-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('does');
    fireEvent.click(screen.getByTestId('agent-summary-row-canRead-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('does');
    fireEvent.click(screen.getByTestId('agent-summary-row-mayPropose-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('does');

    fireEvent.click(screen.getByTestId('agent-summary-row-executesUnattended-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('safety');
    fireEvent.click(screen.getByTestId('agent-summary-row-neverTouches-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('safety');
    fireEvent.click(screen.getByTestId('agent-summary-row-limits-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('safety');
    fireEvent.click(screen.getByTestId('agent-summary-row-approvers-edit'));
    expect(onEdit).toHaveBeenLastCalledWith('safety');

    expect(onEdit).toHaveBeenCalledTimes(8);
  });

  it('renders no Edit links when onEdit is not provided', () => {
    render(<AgentSummaryCard preview={buildPreview()} name="Bot" orgName="Acme" />);
    expect(screen.queryByTestId('agent-summary-title-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-summary-row-runsWhen-edit')).not.toBeInTheDocument();
  });

  it('builds kind-specific "Runs when" phrasing for patch and helpdesk, appending maintenance-window and ticket-write clauses when set', () => {
    const patchPreview = buildPreview({ kind: 'patch', triggers: { alertSeverities: [], respectMaintenanceWindows: false, ticketAutonomousWrites: false } });
    const { rerender } = render(<AgentSummaryCard preview={patchPreview} name="Bot" orgName="Acme" />);
    expect(screen.getByTestId('agent-summary-row-runsWhen').textContent).not.toMatch(/maintenance window/i);
    expect(screen.getByTestId('agent-summary-row-runsWhen').textContent).toMatch(/patch/i);

    const helpdeskPreview = buildPreview({
      kind: 'helpdesk',
      triggers: { alertSeverities: [], respectMaintenanceWindows: true, ticketAutonomousWrites: true },
    });
    rerender(<AgentSummaryCard preview={helpdeskPreview} name="Bot" orgName="Acme" />);
    const row = screen.getByTestId('agent-summary-row-runsWhen');
    expect(row.textContent).toMatch(/ticket/i);
    expect(row.textContent).toMatch(/maintenance window/i);
  });
});
