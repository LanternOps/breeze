// Shared scheme-safety check for remote-access launcher URL templates.
//
// The launcher fires the resulting URL via either an anchor click (custom
// schemes like rustdesk://) or window.open(...) (https). Both vectors will
// execute javascript: and (in some browsers) data: / vbscript: / file:
// payloads in the partner's own origin if a malicious partner admin sets a
// crafted urlTemplate. We block those at validation time AND on the client
// before firing, since one source of truth on a sensitive guard like this
// is brittle.

const DISALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'javascript', 'data', 'vbscript', 'file', 'about', 'chrome', 'jar', 'blob',
  'view-source', 'filesystem',
]);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

export function isAllowedLauncherScheme(urlOrTemplate: string): boolean {
  const m = urlOrTemplate.match(SCHEME_PATTERN);
  if (!m) return false;
  const scheme = m[1]?.toLowerCase();
  if (!scheme) return false;
  return !DISALLOWED_SCHEMES.has(scheme);
}
