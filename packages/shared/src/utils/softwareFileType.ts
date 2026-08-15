/**
 * Installer file-type helpers shared by the API (routes/software.ts,
 * services/softwareVersionShared.ts) and the web package form
 * (components/software/AddPackageModal.tsx).
 *
 * Why this is shared rather than API-local: a software version created from a
 * download URL never had a `file_type`, because only the UPLOAD path derived one
 * from the uploaded filename. The dispatcher then fell back to
 * `fileType: 'exe'` / `fileName: 'package.exe'`, so the agent saved an MSI as
 * `package.exe` and took its EXE branch — which execs the downloaded file
 * DIRECTLY (`exec.CommandContext(ctx, localPath, ...)`). Windows rejects an MSI
 * at CreateProcess with ERROR_BAD_EXE_FORMAT ("This version of %1 is not
 * compatible with the version of Windows you're running"), and the operator's
 * `msiexec /i "{file}" ...` command was never used at all.
 *
 * Deriving the same answer in the browser (to preview and prefill) and on the
 * server (which is authoritative) from ONE implementation is what keeps the two
 * from drifting apart again.
 */

/** File types the agent can install — mirrors isSupportedInstallFileType in
 *  agent/internal/remote/tools/software_install.go. */
export const SOFTWARE_FILE_TYPES = ['msi', 'exe', 'dmg', 'deb', 'pkg'] as const;

export type SoftwareFileType = (typeof SOFTWARE_FILE_TYPES)[number];

export function isSoftwareFileType(value: unknown): value is SoftwareFileType {
  return (
    typeof value === 'string' &&
    (SOFTWARE_FILE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Best-effort installer type for a download URL, or null when the URL does not
 * end in a recognized installer extension.
 *
 * Deliberately conservative: null means "we don't know", and callers keep the
 * pre-existing behavior rather than guessing. A vendor URL like
 * `https://host/download.php?product=foo` yields null, not 'exe' — an
 * over-confident guess here re-creates the exact bug this file exists to fix,
 * just pointed the other way.
 */
export function deriveSoftwareFileTypeFromUrl(
  downloadUrl: string | null | undefined,
): SoftwareFileType | null {
  if (typeof downloadUrl !== 'string') return null;
  const trimmed = downloadUrl.trim();
  if (trimmed === '') return null;

  // Strip query/fragment by hand instead of using `new URL()`: a stored download
  // URL may still carry unresolved deploy-time tokens (`{{org.name}}`,
  // `{{var.site_key}}`), which either make the parser throw or get
  // percent-encoded — both of which would lose the extension we're after.
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  const lastSlash = withoutQuery.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;

  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();

  return isSoftwareFileType(ext) ? ext : null;
}

/**
 * The silent install/uninstall commands to prefill for a file type, or null when
 * the type has no useful default.
 *
 * MSI is the only one with a universally correct pair. An EXE installer's silent
 * switch is vendor-specific (`/S`, `/silent`, `/quiet`, `-q`), so guessing one
 * would produce a command that fails or — worse — installs interactively on an
 * unattended machine.
 */
export function defaultSilentArgsForFileType(
  fileType: string | null | undefined,
): { install: string; uninstall: string } | null {
  if (fileType !== 'msi') return null;
  return {
    install: 'msiexec /i "{file}" /qn /norestart',
    uninstall: 'msiexec /x "{file}" /qn /norestart',
  };
}
