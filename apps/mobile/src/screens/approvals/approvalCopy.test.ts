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
