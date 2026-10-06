import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DiagnosticAccessApprovalDetails, { isDiagnosticAccessApproval } from './DiagnosticAccessApprovalDetails';

const baseArgs = {
  grantId: 'g1',
  organization: 'Acme Dental',
  orgId: 'org-1',
  deviceId: 'dev-1',
  hostname: 'FRONTDESK-01',
  operations: ['list', 'read'],
  paths: [
    { path: 'C:\\Users\\alice\\AppData\\Local\\Vendor\\Logs', recursive: true },
    { path: 'C:\\ProgramData\\Vendor', recursive: false },
  ],
  sensitiveClasses: [] as string[],
  purpose: 'Game client crashes on launch\nneed the launcher logs',
  durationMinutes: 60,
  requestedBy: 'tech@example.com',
  principal: 'api_key',
};

describe('DiagnosticAccessApprovalDetails', () => {
  it('only claims request_diagnostic_access rows', () => {
    expect(isDiagnosticAccessApproval('request_diagnostic_access')).toBe(true);
    expect(isDiagnosticAccessApproval('execute_command')).toBe(false);
    expect(isDiagnosticAccessApproval(null)).toBe(false);
  });

  it('shows org, device, every path with its recursion, operations, duration, purpose and requester', () => {
    render(<DiagnosticAccessApprovalDetails args={baseArgs} approvalId="a1" />);
    expect(screen.getByText('Acme Dental')).toBeTruthy();
    expect(screen.getByText('FRONTDESK-01')).toBeTruthy();
    const paths = screen.getByTestId('approval-diagnostic-access-paths-a1');
    expect(paths.textContent).toContain('C:\\Users\\alice\\AppData\\Local\\Vendor\\Logs');
    expect(paths.textContent).toContain('Whole subtree');
    expect(paths.textContent).toContain('C:\\ProgramData\\Vendor');
    expect(paths.textContent).toContain('This folder and the files directly in it');
    expect(screen.getByTestId('approval-diagnostic-access-ops-a1').textContent).toContain('list, read');
    expect(screen.getByText('60 minutes from approval')).toBeTruthy();
    expect(screen.getByText(/Game client crashes on launch/)).toBeTruthy();
    expect(screen.getByText(/tech@example.com/).textContent).toContain('MCP API key');
    expect(screen.queryByTestId('approval-diagnostic-access-sensitive-a1')).toBeNull();
    expect(screen.getByText(/fixed list; anything else inside these paths is readable/)).toBeTruthy();
  });

  it('calls out each explicitly requested sensitive store', () => {
    render(
      <DiagnosticAccessApprovalDetails
        args={{ ...baseArgs, sensitiveClasses: ['browser_secrets', 'private_keys', 'not_a_class'] }}
        approvalId="a2"
      />,
    );
    const box = screen.getByTestId('approval-diagnostic-access-sensitive-a2');
    expect(box.textContent).toContain('Browser passwords, cookies and their encryption keys');
    expect(box.textContent).toContain('Private keys (SSH, GnuPG, TLS)');
    expect(box.textContent).not.toContain('not_a_class');
  });

  it('renders safely when arguments are malformed', () => {
    render(<DiagnosticAccessApprovalDetails args={{ paths: 'nope', operations: 7 }} approvalId="a3" />);
    expect(screen.getByTestId('approval-diagnostic-access-paths-a3').children.length).toBe(0);
  });
});
