// Shared scheme-safety check for remote-access launcher URL templates.
//
// The launcher fires the resulting URL via either an anchor click (custom
// schemes like rustdesk://) or window.open(...) (https). Both vectors will
// execute javascript: and (in some browsers) data: / vbscript: / file:
// payloads in the partner's own origin if a malicious partner admin sets a
// crafted urlTemplate. We block those at validation time AND on the client
// before firing, since one source of truth on a sensitive guard like this
// is brittle.
//
// The guard is allowlist-first (#714/#680): the well-known remote-access and
// web schemes below are explicitly permitted. Anything off the allowlist is
// still accepted as long as it is not on the dangerous denylist — partners
// configure their own custom protocol handlers (e.g. niche remote tools), so a
// strict allowlist would break legitimate setups. The denylist remains the
// hard floor that no scheme, listed or custom, may cross.

export const ALLOWED_LAUNCHER_SCHEMES: ReadonlySet<string> = new Set([
  'https', 'http', 'rustdesk', 'teamviewer', 'anydesk', 'splashtop', 'screenconnect',
]);

// The hard floor: no scheme — allowlisted or custom — may ever cross this set.
// Exported so callers/tests can assert it stays disjoint from the allowlist (a
// scheme on both lists would be silently un-blocked by the allowlist short
// circuit below).
export const DISALLOWED_LAUNCHER_SCHEMES: ReadonlySet<string> = new Set([
  'javascript', 'data', 'vbscript', 'file', 'about', 'chrome', 'jar', 'blob',
  'view-source', 'filesystem',
]);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

export function isAllowedLauncherScheme(urlOrTemplate: string): boolean {
  const m = urlOrTemplate.match(SCHEME_PATTERN);
  if (!m) return false;
  const scheme = m[1]?.toLowerCase();
  if (!scheme) return false;
  if (ALLOWED_LAUNCHER_SCHEMES.has(scheme)) return true;
  return !DISALLOWED_LAUNCHER_SCHEMES.has(scheme);
}
