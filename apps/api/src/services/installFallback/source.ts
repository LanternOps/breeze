/**
 * INSTALLER_FALLBACK_SOURCE (#8874, spec §3.8): where the install one-liners
 * may fetch pinned release assets when the control plane is unreachable.
 *
 *   auto (default) — the release-source GitHub repository, but only when
 *                    BINARY_SOURCE=github and BINARY_EDITION is not hosted;
 *                    otherwise off.
 *   off            — no fallback (also the rollback for every deployment).
 *   https://github.com/<owner>/<repo>
 *                  — that repository's releases.
 *   https://<mirror base>
 *                  — self-host only: a mirror laid out as <base><tag>/<asset>
 *                    (Gate B #5). Hosted may only use a GitHub repository.
 *
 * The value only chooses WHERE bytes may come from. WHICH bytes are allowed is
 * decided by the anchor builder from a verified manifest, never from here.
 */
import { isSafeInstallFallbackBaseUrl } from '@breeze/shared';
import { getBinaryEdition } from '../binaryEdition';
import { getBinarySource } from '../binarySource';
import {
  OFFICIAL_RELEASE_REPOSITORY,
  getReleaseSourceRepository,
  isValidReleaseSourceRepository,
} from '../releaseSource';

export type InstallFallbackSource =
  | { kind: 'off' }
  | { kind: 'github'; repository: string }
  | { kind: 'mirror'; base: string };

export type InstallFallbackSourceValue = { kind: 'auto' } | InstallFallbackSource;

export const INSTALL_FALLBACK_SOURCE_SHAPE =
  '"auto", "off", "https://github.com/<owner>/<repo>", or an https:// mirror base with no userinfo, query or fragment';

// Exactly https://github.com/<owner>/<repo> with an optional trailing slash.
// Anything else on a github.com host (a /releases path, a query, userinfo, a
// subdomain) is a typo, not a mirror, and is refused rather than reinterpreted.
const GITHUB_REPOSITORY_URL_RE = /^https:\/\/github\.com\/([^/?#@\s]+)\/([^/?#@\s]+)\/?$/i;
const GITHUB_HOST_RE = /^(?:[^/?#]*@)?(?:[a-z0-9-]+\.)*github\.com(?::\d+)?$/i;

/**
 * Parses the raw env value. Blank or unset is `auto`. Returns null when the
 * value is not one of the accepted shapes. Shared by boot validation
 * (config/validate.ts) and runtime resolution so the two cannot drift.
 */
export function parseInstallFallbackSourceValue(
  raw: string | undefined,
): InstallFallbackSourceValue | null {
  const value = (raw ?? '').trim();
  if (value === '') return { kind: 'auto' };
  const keyword = value.toLowerCase();
  if (keyword === 'auto') return { kind: 'auto' };
  if (keyword === 'off') return { kind: 'off' };
  if (!/^https:\/\//i.test(value)) return null;

  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (GITHUB_HOST_RE.test(authority)) {
    const match = GITHUB_REPOSITORY_URL_RE.exec(value);
    if (!match) return null;
    const repository = `${match[1]}/${match[2]}`;
    if (!isValidReleaseSourceRepository(repository)) return null;
    return { kind: 'github', repository: repository.toLowerCase() };
  }

  const base = value.endsWith('/') ? value : `${value}/`;
  if (!isSafeInstallFallbackBaseUrl(base)) return null;
  return { kind: 'mirror', base };
}

/**
 * The effective fallback source for this deployment. Never throws: any parse
 * or resolution failure is `off` (boot validation already refused a malformed
 * value; this is the runtime backstop).
 */
export function resolveInstallFallbackSource(): InstallFallbackSource {
  const parsed = parseInstallFallbackSourceValue(process.env.INSTALLER_FALLBACK_SOURCE);
  if (parsed === null || parsed.kind === 'off') return { kind: 'off' };

  const hosted = getBinaryEdition() === 'hosted';

  if (parsed.kind === 'auto') {
    if (hosted || getBinarySource() !== 'github') return { kind: 'off' };
    try {
      return { kind: 'github', repository: getReleaseSourceRepository().toLowerCase() };
    } catch {
      return { kind: 'off' };
    }
  }

  if (parsed.kind === 'mirror') {
    return hosted ? { kind: 'off' } : parsed;
  }

  // The official public repository carries the self-host edition, so it can
  // never be a hosted deployment's source. Production boot refuses this
  // combination; this keeps every other environment fail-closed too.
  if (hosted && parsed.repository === OFFICIAL_RELEASE_REPOSITORY) return { kind: 'off' };
  return parsed;
}
