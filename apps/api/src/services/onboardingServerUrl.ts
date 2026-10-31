// The value is pasted inside double quotes into a bash and a PowerShell
// command. Reject characters those shells expand inside double quotes.
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
