// #8120: the server URL agents should enroll against, for the web's
// copy/paste install command. The web bundle cannot read PUBLIC_API_URL at
// runtime (it is frozen in at image build, empty in the published image), so
// the browser fell back to its own origin, which is the dashboard host on
// split dashboard/API deployments. The server-built installers already use
// PUBLIC_API_URL || API_URL, so the command now gets the same value. Never
// derived from the request Host.
//
// The value is pasted inside double quotes into a bash command (PowerShell
// takes it as an escaped single-quoted literal), and the startup URL checks
// only run when FORCE_HTTPS=true. So it is rebuilt from the parsed URL
// (origin + path, trailing slash removed; the parser percent-encodes spaces,
// quotes, backticks and non-ASCII), dropped when it has userinfo, a query or a
// fragment, and dropped when what remains still holds a character bash expands
// inside double quotes ($, `, ", \, history !) or whitespace. Any other valid
// path prefix is kept. Undefined leaves the web on its previous fallback.
const SHELL_LIVE_IN_DOUBLE_QUOTES = /[\s$`"\\!]/;

export function onboardingServerUrl(): string | undefined {
  const raw = (process.env.PUBLIC_API_URL || process.env.API_URL || '').trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const canonical = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return SHELL_LIVE_IN_DOUBLE_QUOTES.test(canonical) ? undefined : canonical;
}
