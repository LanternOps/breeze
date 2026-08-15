import { describe, it, expect } from 'vitest';
import { applySilentArgsPrefill } from '../installerArgsPrefill';

const MSI_INSTALL = 'msiexec /i "{file}" /qn /norestart';
const MSI_UNINSTALL = 'msiexec /x "{file}" /qn /norestart';
const EMPTY = { silentInstallArgs: '', silentUninstallArgs: '' };

describe('applySilentArgsPrefill', () => {
  it('fills empty fields with the MSI defaults', () => {
    expect(applySilentArgsPrefill(EMPTY, 'msi')).toEqual({
      silentInstallArgs: MSI_INSTALL,
      silentUninstallArgs: MSI_UNINSTALL,
    });
  });

  it('leaves empty fields empty for a type with no default', () => {
    expect(applySilentArgsPrefill(EMPTY, 'exe')).toEqual(EMPTY);
    expect(applySilentArgsPrefill(EMPTY, null)).toEqual(EMPTY);
  });

  it('RETRACTS its own prefill when the type changes away from msi', () => {
    // The bug this exists to prevent: leaving msiexec behind on an EXE package
    // makes the agent run `setup.exe msiexec /i <path> /qn /norestart`, and most
    // NSIS/InstallShield installers ignore unknown switches and open an
    // interactive UI — an unattended install that hangs instead of failing.
    const prefilled = { silentInstallArgs: MSI_INSTALL, silentUninstallArgs: MSI_UNINSTALL };
    expect(applySilentArgsPrefill(prefilled, 'exe')).toEqual(EMPTY);
    expect(applySilentArgsPrefill(prefilled, null)).toEqual(EMPTY);
  });

  it('never overwrites a command the user typed', () => {
    const typed = {
      silentInstallArgs: '/S /norestart',
      silentUninstallArgs: '/uninstall /S',
    };
    expect(applySilentArgsPrefill(typed, 'msi')).toEqual(typed);
    expect(applySilentArgsPrefill(typed, 'exe')).toEqual(typed);
  });

  it('treats a user edit of a prefilled value as user-owned', () => {
    // Same command plus REBOOT=ReallySuppress — no longer verbatim ours.
    const edited = {
      silentInstallArgs: 'msiexec /i "{file}" /qn REBOOT=ReallySuppress',
      silentUninstallArgs: MSI_UNINSTALL,
    };
    const result = applySilentArgsPrefill(edited, 'exe');
    expect(result.silentInstallArgs).toBe('msiexec /i "{file}" /qn REBOOT=ReallySuppress');
    // The untouched uninstall field is still ours, so it retracts.
    expect(result.silentUninstallArgs).toBe('');
  });

  it('decides ownership per field, not for the pair', () => {
    const mixed = { silentInstallArgs: '/S', silentUninstallArgs: '' };
    expect(applySilentArgsPrefill(mixed, 'msi')).toEqual({
      silentInstallArgs: '/S',
      silentUninstallArgs: MSI_UNINSTALL,
    });
  });

  it('is idempotent for a stable type', () => {
    const once = applySilentArgsPrefill(EMPTY, 'msi');
    expect(applySilentArgsPrefill(once, 'msi')).toEqual(once);
  });
});
