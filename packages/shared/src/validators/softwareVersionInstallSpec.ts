// ============================================
// Software version install-spec validation (#6958)
// ============================================
//
// Cross-field rules for a software version's install spec: archive (zip)
// installs, pre/post-install scripts and silent-install args. Pure and
// dependency-free so API routes and the web editor share one definition.
// Not called from any route yet — the create paths wire it in a later PR.

/** Max size of a pre/post-install script, measured in UTF-8 bytes. */
export const INSTALL_SCRIPT_MAX_BYTES = 65536;

export type InstallSpecIssue =
  | 'zip_requires_post_install_script'
  | 'scripts_require_single_os'
  | 'script_too_large'
  | 'args_unsupported_for_file_type';

/** File types whose installer does not accept silent-install arguments. */
const ARGS_UNSUPPORTED_FILE_TYPES = new Set(['pkg', 'dmg', 'deb', 'zip']);

const encoder = new TextEncoder();

const isPresent = (s: string | null | undefined): s is string =>
  typeof s === 'string' && s.trim().length > 0;

/**
 * Returns every issue that applies, in `InstallSpecIssue` declaration order.
 * Whitespace-only scripts and args count as absent.
 */
export function validateSoftwareVersionInstallSpec(input: {
  fileType: string | null | undefined;
  supportedOs: unknown;
  silentInstallArgs: string | null | undefined;
  preInstallScript: string | null | undefined;
  postInstallScript: string | null | undefined;
}): InstallSpecIssue[] {
  const issues: InstallSpecIssue[] = [];
  const hasPre = isPresent(input.preInstallScript);
  const hasPost = isPresent(input.postInstallScript);

  if (input.fileType === 'zip' && !hasPost) {
    issues.push('zip_requires_post_install_script');
  }

  if ((hasPre || hasPost) && !(Array.isArray(input.supportedOs) && input.supportedOs.length === 1)) {
    issues.push('scripts_require_single_os');
  }

  const tooLarge = (s: string | null | undefined) =>
    isPresent(s) && encoder.encode(s).length > INSTALL_SCRIPT_MAX_BYTES;
  if (tooLarge(input.preInstallScript) || tooLarge(input.postInstallScript)) {
    issues.push('script_too_large');
  }

  if (
    isPresent(input.silentInstallArgs) &&
    input.fileType != null &&
    ARGS_UNSUPPORTED_FILE_TYPES.has(input.fileType)
  ) {
    issues.push('args_unsupported_for_file_type');
  }

  return issues;
}
