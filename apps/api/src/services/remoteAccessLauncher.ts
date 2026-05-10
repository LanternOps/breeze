import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';
import { isAllowedLauncherScheme } from '@breeze/shared';

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
  if (!remoteAccess?.defaultProviderId || !remoteAccess.providers?.length) {
    return null;
  }
  const provider: RemoteAccessProvider | undefined = remoteAccess.providers.find(
    (p) => p.id === remoteAccess.defaultProviderId && p.enabled,
  );
  if (!provider) return null;

  const idValue = device.customFields?.[provider.customFieldKey];
  if (typeof idValue !== 'string' || idValue.length === 0) return null;
  if (!provider.urlTemplate) return null;

  const built = provider.urlTemplate
    .replaceAll('{id}', encodeURIComponent(idValue))
    .replaceAll('{password}', encodeURIComponent(provider.password ?? ''));

  // Belt-and-suspenders: re-check the scheme on the *substituted* URL. The
  // input validator at orgs.ts already rejects disallowed-scheme templates,
  // but a template like `j{id}cript:foo` passes the template-time check
  // (scheme is `j`, not denylisted) and only resolves to `javascript:` after
  // the device id is substituted. Refuse to return such a URL.
  if (!isAllowedLauncherScheme(built)) return null;
  return built;
}
