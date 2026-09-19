import { describe, expect, it } from 'vitest';
import { extractUacDetails, executableName, getApprovalCopy } from './approvalCopy';

describe('extractUacDetails', () => {
  it('reads the elevation schema camelCase fields', () => {
    expect(
      extractUacDetails({
        targetExecutablePath: 'C:\\Windows\\System32\\cmd.exe',
        targetExecutableSigner: 'Microsoft Windows',
        targetExecutableHash: 'abc123',
        parentProcess: 'explorer.exe',
        requesterReason: 'install printer',
        intentSummary: 'runs an installer',
      }),
    ).toEqual({
      exePath: 'C:\\Windows\\System32\\cmd.exe',
      signer: 'Microsoft Windows',
      hash: 'abc123',
      parentProcess: 'explorer.exe',
      reason: 'install printer',
      intentSummary: 'runs an installer',
    });
  });

  it('tolerates server aliases and falls back to publisher / parentImage / reason', () => {
    const d = extractUacDetails({
      exePath: 'D:\\tools\\setup.exe',
      targetPublisher: 'Acme Corp',
      hash: 'deadbeef',
      parentImage: 'powershell.exe',
      reason: 'because',
    });
    expect(d.exePath).toBe('D:\\tools\\setup.exe');
    expect(d.signer).toBe('Acme Corp');
    expect(d.parentProcess).toBe('powershell.exe');
    expect(d.reason).toBe('because');
  });

  it('returns nulls for missing / blank / non-string fields', () => {
    expect(extractUacDetails({ targetExecutablePath: '   ', targetExecutableHash: 42 })).toEqual({
      exePath: null,
      signer: null,
      hash: null,
      parentProcess: null,
      reason: null,
      intentSummary: null,
    });
    expect(extractUacDetails(null)).toEqual({
      exePath: null,
      signer: null,
      hash: null,
      parentProcess: null,
      reason: null,
      intentSummary: null,
    });
  });
});

describe('executableName', () => {
  it('takes the basename of a Windows path', () => {
    expect(executableName('C:\\Program Files\\Acme\\thing.exe')).toBe('thing.exe');
  });
  it('takes the basename of a POSIX path', () => {
    expect(executableName('/usr/local/bin/tool')).toBe('tool');
  });
  it('returns null for null/empty', () => {
    expect(executableName(null)).toBeNull();
    expect(executableName('')).toBeNull();
  });
});

describe('getApprovalCopy', () => {
  it('builds uac_intercept copy from the executable name', () => {
    const copy = getApprovalCopy({
      actionToolName: 'uac_intercept',
      actionLabel: 'ignored for uac',
      actionArguments: { targetExecutablePath: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(copy).toEqual({
      headline: 'Allow cmd.exe to run as admin',
      approveLabel: 'Allow',
      holdLabel: 'Hold to allow',
    });
  });

  it('falls back to a generic uac headline when no exe path is present', () => {
    const copy = getApprovalCopy({
      flowType: 'uac_intercept',
      actionToolName: 'uac_intercept',
      actionLabel: 'x',
      actionArguments: {},
    });
    expect(copy.headline).toBe('Allow admin elevation');
    expect(copy.approveLabel).toBe('Allow');
  });

  it('uses the actionLabel and generic verbs for standard approvals', () => {
    const copy = getApprovalCopy({
      actionToolName: 'm365_reset_password',
      actionLabel: 'Reset M365 password',
      actionArguments: { userId: 'u1' },
    });
    expect(copy).toEqual({
      headline: 'Reset M365 password',
      approveLabel: 'Approve',
      holdLabel: 'Hold to approve',
    });
  });
});

describe('getApprovalCopy — raw call-signature labels', () => {
  // Servers before the actionLabel humanising change stamped the audit
  // signature onto approval_requests.action_label. Those rows still exist and
  // still arrive by push, so the phone unpacks them rather than printing a
  // UUID in 28pt.
  it('renders tool + recognisable args instead of the signature', () => {
    const copy = getApprovalCopy({
      actionToolName: 'manage_services',
      actionLabel: 'manage_services(deviceId=6eae0f70-8da9-49ff-9e18-c241698975f3, action=restart, serviceName=Spooler)',
      actionArguments: { deviceId: '6eae0f70-8da9-49ff-9e18-c241698975f3', action: 'restart', serviceName: 'Spooler' },
    });
    expect(copy.headline).toBe('Manage services: restart Spooler');
  });

  it('handles JSON-valued args in the signature', () => {
    const copy = getApprovalCopy({
      actionToolName: 'execute_command',
      actionLabel: 'execute_command(deviceId=6eae0f70-8da9-49ff-9e18-c241698975f3, commandType=list_services, payload={"search":"Spooler"})',
      actionArguments: { deviceId: '6eae0f70-8da9-49ff-9e18-c241698975f3', commandType: 'list_services', payload: { search: 'Spooler' } },
    });
    expect(copy.headline).toBe('Execute command: list_services');
  });

  it('leaves a human label alone', () => {
    const copy = getApprovalCopy({
      actionToolName: 'manage_services',
      actionLabel: 'Restart service "Spooler" on KIT',
      actionArguments: {},
    });
    expect(copy.headline).toBe('Restart service "Spooler" on KIT');
  });
});
