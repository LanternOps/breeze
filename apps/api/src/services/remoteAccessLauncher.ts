import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';
import { isAllowedLauncherScheme } from '@breeze/shared';

// Reasons we may decline to produce a launch URL. These are surfaced to the UI
// so it can distinguish expected-empty from configuration error from a security
// event (so a tampered partner template that resolves to javascript: at
// substitution time shows up loudly instead of silently falling back).
export type RemoteAccessLaunchSkipReason =
  | 'no_provider_configured'
  | 'provider_disabled'
  | 'missing_device_identifier'
  | 'empty_url_template'
  | 'scheme_not_allowed';

export interface RemoteAccessLaunchResult {
  launchUrl: string | null;
  providerId: string | null;
  scheme: string | null;
  skipReason: RemoteAccessLaunchSkipReason | null;
}

function extractScheme(url: string): string | null {
  const colon = url.indexOf(':');
  if (colon <= 0) return null;
  return url.slice(0, colon).toLowerCase();
}

// Build the launch URL the Connect Desktop button should fire for a device,
// based on the partner's configured remote-access providers and the device's
// custom_fields. Returns null when no provider is configured, no default is
// chosen, the chosen provider is disabled, or the device is missing the
// per-device identifier the provider needs.
//
// Substitutes `{id}` and `{password}` placeholders in `urlTemplate` with the
// percent-encoded values, defending against URL-reserved characters
// (#, &, =, +, <, >, etc.) in MSP-set preset passwords or device identifiers.
//
// Examples (with device.customFields.rustdesk_id = '294064193'):
//   urlTemplate 'rustdesk://{id}?password={password}', password 'p#x'
//     → 'rustdesk://294064193?password=p%23x'
//   urlTemplate 'https://acme.screenconnect.com/Host#Access///{id}/Join'
//     → 'https://acme.screenconnect.com/Host#Access///294064193/Join'
export function buildRemoteAccessLaunchUrl(
  device: { customFields?: Record<string, unknown> | null },
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
): string | null {
  return resolveRemoteAccessLaunch(device, remoteAccess).launchUrl;
}

// Resolves the launch URL with a structured result so callers can distinguish
// between "no provider configured" (expected), "missing device identifier"
// (configuration), and "scheme not allowed at substitution time" (potential
// security event: the partner template was tampered to resolve to a
// disallowed scheme only after substitution).
export function resolveRemoteAccessLaunch(
  device: { customFields?: Record<string, unknown> | null },
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
): RemoteAccessLaunchResult {
  if (!remoteAccess?.defaultProviderId || !remoteAccess.providers?.length) {
    return { launchUrl: null, providerId: null, scheme: null, skipReason: 'no_provider_configured' };
  }
  const provider: RemoteAccessProvider | undefined = remoteAccess.providers.find(
    (p) => p.id === remoteAccess.defaultProviderId,
  );
  if (!provider) {
    return { launchUrl: null, providerId: null, scheme: null, skipReason: 'no_provider_configured' };
  }
  if (!provider.enabled) {
    return { launchUrl: null, providerId: provider.id, scheme: null, skipReason: 'provider_disabled' };
  }

  const idValue = device.customFields?.[provider.customFieldKey];
  if (typeof idValue !== 'string' || idValue.length === 0) {
    return { launchUrl: null, providerId: provider.id, scheme: null, skipReason: 'missing_device_identifier' };
  }
  if (!provider.urlTemplate) {
    return { launchUrl: null, providerId: provider.id, scheme: null, skipReason: 'empty_url_template' };
  }

  const built = provider.urlTemplate
    .replaceAll('{id}', encodeURIComponent(idValue))
    .replaceAll('{password}', encodeURIComponent(provider.password ?? ''));

  // Belt-and-suspenders: re-check the scheme on the *substituted* URL. The
  // input validator at orgs.ts already rejects disallowed-scheme templates,
  // but a template like `j{id}cript:foo` passes the template-time check
  // (scheme is `j`, not denylisted) and only resolves to `javascript:` after
  // the device id is substituted. Refuse to return such a URL.
  if (!isAllowedLauncherScheme(built)) {
    return { launchUrl: null, providerId: provider.id, scheme: null, skipReason: 'scheme_not_allowed' };
  }
  return { launchUrl: built, providerId: provider.id, scheme: extractScheme(built), skipReason: null };
}
