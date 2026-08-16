import {
  SOFTWARE_FILE_TYPES,
  defaultSilentArgsForFileType,
  type SilentInstallDefaults,
  type SoftwareFileType,
} from "@breeze/shared";

/**
 * Retractable prefill for the silent install/uninstall command fields.
 *
 * A one-directional prefill (fill when empty, never clear) is a silent
 * misconfiguration generator: type a `.msi` URL and the fields auto-fill with
 * the msiexec pair, then correct the URL to `.exe` and the msiexec command stays
 * behind. The version is then stored as `fileType: 'exe'` WITH msiexec args, and
 * the agent's EXE branch runs `setup.exe msiexec /i <path> /qn /norestart` —
 * most NSIS/InstallShield installers ignore unknown switches and open an
 * interactive UI, so an unattended install hangs instead of failing loudly.
 * Nothing catches it agent-side either: validateMSIInstallArgs only runs when
 * fileType is 'msi'.
 *
 * So the prefill has to be OWNED rather than sticky — replaced or withdrawn when
 * the installer type changes, but never overwriting something a human typed.
 * Ownership is decided by value, not by tracking edits: a field still holding a
 * string this module could have produced is ours to revise. That is also what
 * makes it correct across a source switch (URL -> file upload and back), where
 * the previous type isn't otherwise recoverable.
 */

/** True when `current` is empty or is verbatim a default this module generated. */
function isPrefillOwned(
  current: string,
  pick: (defaults: SilentInstallDefaults) => string,
): boolean {
  if (current === "") return true;
  return SOFTWARE_FILE_TYPES.some((type) => {
    const defaults = defaultSilentArgsForFileType(type);
    return defaults !== null && pick(defaults) === current;
  });
}

/**
 * The silent-args fields as they should read for `nextFileType`. Owned fields are
 * rewritten to the new type's defaults (or cleared when it has none); anything
 * the user typed is returned unchanged.
 */
export function applySilentArgsPrefill(
  current: { silentInstallArgs: string; silentUninstallArgs: string },
  nextFileType: SoftwareFileType | null,
): { silentInstallArgs: string; silentUninstallArgs: string } {
  const next = defaultSilentArgsForFileType(nextFileType);
  return {
    silentInstallArgs: isPrefillOwned(current.silentInstallArgs, (d) => d.install)
      ? (next?.install ?? "")
      : current.silentInstallArgs,
    silentUninstallArgs: isPrefillOwned(current.silentUninstallArgs, (d) => d.uninstall)
      ? (next?.uninstall ?? "")
      : current.silentUninstallArgs,
  };
}
