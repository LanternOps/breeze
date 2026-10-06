/**
 * Server-side deny-list for system-tools reads that would expose the agent's
 * own credential material, regardless of the caller's permission.
 *
 * This is defense-in-depth, not the primary control: the agent enforces its
 * own path/registry deny-list locally (agent/internal/remote/tools/fileops.go
 * `isSensitiveReadPath`, agent/internal/remote/tools/registry_denylist.go
 * `isDeniedRegistryTarget`) because only the agent knows its actual configured
 * install/data directories. This module blocks the well-known default
 * locations before a command is even queued, so a caller never learns
 * anything from an agent round-trip for the obvious cases.
 */

import {
  candidateForms,
  isShortNameComponent,
  normalizePath,
  stripWindowsNamespacePrefix,
  UNRESOLVED_FORM,
} from '../../services/devicePathForms';

// Path fragments (forward-slash-normalized, lowercased) for the agent's own
// config/secrets directory on each supported platform. Matched at a
// path-component boundary so e.g. ".../breezex/secrets.yaml" does not
// spuriously match ".../breeze".
const AGENT_CONFIG_DIR_FRAGMENTS = [
  // Windows default: %ProgramData%\Breeze (any drive letter/UNC prefix — we
  // match on the "programdata/breeze" suffix, not the drive).
  '/programdata/breeze',
  // Linux default.
  '/etc/breeze',
  // macOS default. Also covers the data dir (…/breeze/data), which holds the
  // trash and other agent-owned state — intentionally broad, since the whole
  // app-support directory is agent-private on macOS.
  '/library/application support/breeze',
];

function matchesPathFragment(norm: string, frag: string): boolean {
  return norm === frag || norm.endsWith(frag) || norm.includes(`${frag}/`);
}

/**
 * True when `path` targets — or may target — the agent's own config/secrets
 * directory. Windows reaches that directory under spellings other than the
 * canonical one (compatibility junctions such as `Documents and Settings\All
 * Users` and `ProgramData\Application Data`, trailing dots/spaces, `:stream`
 * suffixes, redundant separators, device-namespace and admin-share prefixes),
 * so every form the device could resolve the path to is checked, using the
 * same resolution as the AI path restriction (services/devicePathForms.ts).
 * An 8.3 short name can stand for any long name, so a path containing one
 * cannot be checked and is treated as a match.
 */
export function isAgentConfigPath(path: string): boolean {
  const normalized = normalizePath(stripWindowsNamespacePrefix(path));
  if (normalized.split('/').some(isShortNameComponent)) return true;
  return candidateForms(normalized).some(
    (form) =>
      form === UNRESOLVED_FORM ||
      AGENT_CONFIG_DIR_FRAGMENTS.some((frag) => matchesPathFragment(form, frag)),
  );
}

// Top-level HKLM subkeys that hold OS credential material (SAM database,
// LSA secrets under HKLM\SECURITY\Policy\Secrets — a descendant of the
// HKLM\SECURITY root denied below).
const DENIED_HKLM_ROOTS = new Set(['sam', 'security']);

function canonicalHive(hive: string): string {
  switch (hive.trim().toUpperCase()) {
    case 'HKLM':
    case 'HKEY_LOCAL_MACHINE':
      return 'HKLM';
    case 'HKCU':
    case 'HKEY_CURRENT_USER':
      return 'HKCU';
    case 'HKCR':
    case 'HKEY_CLASSES_ROOT':
      return 'HKCR';
    case 'HKU':
    case 'HKEY_USERS':
      return 'HKU';
    case 'HKCC':
    case 'HKEY_CURRENT_CONFIG':
      return 'HKCC';
    default:
      return hive.trim().toUpperCase();
  }
}

/**
 * Normalizes a registry path into its component segments, resolving `.`/`..`
 * the same way a filesystem path would. The registry has no real `..`
 * semantics, but the query/body schemas accept an arbitrary string, so a
 * caller could still hand one through — collapse it defensively rather than
 * trust that upstream validation always will.
 */
function registryPathSegments(path: string): string[] {
  const normalized = path.toLowerCase().replace(/\//g, '\\');
  const raw = normalized.split('\\').filter((seg) => seg.length > 0);
  const resolved: string[] = [];
  for (const seg of raw) {
    if (seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  return resolved;
}

/** True when `hive`+`path` targets SAM, SECURITY, or an LSA-secrets subkey. */
export function isDeniedRegistryTarget(hive: string, path: string): boolean {
  if (canonicalHive(hive) !== 'HKLM') return false;
  const segments = registryPathSegments(path);
  const root = segments[0];
  return root !== undefined && DENIED_HKLM_ROOTS.has(root);
}
