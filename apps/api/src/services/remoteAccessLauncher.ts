import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';
import { isAllowedLauncherScheme } from '@breeze/shared';
import { decryptForColumn } from './secretCrypto';

// Reasons we may decline to produce a launch URL. These are surfaced to the UI
// so it can distinguish expected-empty from configuration error from a security
// event (so a tampered partner template that resolves to javascript: at
// substitution time shows up loudly instead of silently falling back).
export type RemoteAccessLaunchSkipReason =
  | 'no_provider_configured'
  | 'provider_disabled'
  | 'missing_device_identifier'
  | 'empty_url_template'
  | 'scheme_not_allowed'
  // Only for an explicit choice (#10922): the requested id is not one of this
  // tenant's enabled providers. Never produced by the availability check.
  | 'provider_not_available';

/**
 * One tool a technician can pick from the Connect menu (#10922). This is the
 * whole client-visible shape: never the template, password or custom-field
 * key. `kind` says how the browser opens it: `web` in a new tab (an http(s)
 * template), `protocol` through the OS handler (rustdesk:, anydesk:, …).
 */
export interface RemoteAccessProviderOption {
  id: string;
  label: string;
  kind: 'web' | 'protocol';
}

export interface RemoteAccessLaunchResult {
  launchUrl: string | null;
  providerId: string | null;
  scheme: string | null;
  skipReason: RemoteAccessLaunchSkipReason | null;
}

// Availability is the subset of RemoteAccessLaunchResult that can be
// determined WITHOUT decrypting the provider password or substituting the
// template: provider exists, is enabled, the device carries the identifier
// the provider needs, and the template is non-empty. There is deliberately
// no `launchUrl` or `scheme` field here, and `skipReason` can never be
// `scheme_not_allowed` — that reason only exists once the template has
// actually been substituted with the real (decrypted) password, which is
// issuance-only work. See `checkRemoteAccessLaunchAvailability` below.
export interface RemoteAccessLaunchAvailability {
  available: boolean;
  providerId: string | null;
  skipReason: RemoteAccessLaunchSkipReason | null;
}

function extractScheme(url: string): string | null {
  const colon = url.indexOf(':');
  if (colon <= 0) return null;
  return url.slice(0, colon).toLowerCase();
}

// Selects which configured provider a launch would use: an explicit choice
// made at click time, else the technician's preference if it names a provider
// this tenant has and is enabled, otherwise the tenant default. Shared by both
// the availability check and the issuance path so the two can never disagree
// about *which* provider they're evaluating.
function selectRemoteAccessProvider(
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
  preferredProviderId?: string | null,
  explicitProviderId?: string | null,
): { provider: RemoteAccessProvider | null; skipReason: RemoteAccessLaunchSkipReason | null } {
  // An explicit choice (#10922) selects exactly like a preference -- only a
  // provider this tenant has AND has enabled -- but it does NOT fall through to
  // the default. The technician picked one tool; quietly launching another
  // would hand back a different tool's credential than the one they clicked.
  if (explicitProviderId) {
    const providers = Array.isArray(remoteAccess?.providers) ? remoteAccess.providers : [];
    const chosen = providers.find((p) => p.id === explicitProviderId && p.enabled);
    return chosen
      ? { provider: chosen, skipReason: null }
      : { provider: null, skipReason: 'provider_not_available' };
  }

  if (!remoteAccess?.providers?.length) {
    return { provider: null, skipReason: 'no_provider_configured' };
  }

  // A preference only counts when it names a provider this tenant actually has
  // AND that provider is enabled. Anything else -- unknown id, id belonging to
  // another tenant, provider since disabled or deleted -- falls through to the
  // tenant default rather than failing the launch, so a stale preference degrades
  // quietly instead of stranding the technician.
  const preferred: RemoteAccessProvider | undefined = preferredProviderId
    ? remoteAccess.providers.find((p) => p.id === preferredProviderId && p.enabled)
    : undefined;

  const targetId = preferred?.id ?? remoteAccess.defaultProviderId;
  if (!targetId) {
    return { provider: null, skipReason: 'no_provider_configured' };
  }

  const provider = remoteAccess.providers.find((p) => p.id === targetId);
  if (!provider) {
    return { provider: null, skipReason: 'no_provider_configured' };
  }
  return { provider, skipReason: null };
}

// Everything the availability check and the issuance path share, up to (but
// NOT including) password decryption and template substitution. This is the
// single source of truth for the pre-decrypt checks so availability and
// issuance can't drift apart on skip-reason vocabulary.
function evaluateRemoteAccessLaunchAvailability(
  device: { customFields?: Record<string, unknown> | null },
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
  preferredProviderId?: string | null,
  explicitProviderId?: string | null,
): { provider: RemoteAccessProvider | null; idValue: string | null; skipReason: RemoteAccessLaunchSkipReason | null } {
  const { provider, skipReason } = selectRemoteAccessProvider(remoteAccess, preferredProviderId, explicitProviderId);
  if (!provider) {
    return { provider: null, idValue: null, skipReason };
  }
  return evaluateProviderForDevice(device, provider);
}

// The per-provider half of the pre-decrypt checks: enabled, the device carries
// the identifier this provider needs, and the template is non-empty. The
// Connect menu's option list (#10922) runs it over every provider, so a tool
// is offered exactly when issuance would accept it.
function evaluateProviderForDevice(
  device: { customFields?: Record<string, unknown> | null },
  provider: RemoteAccessProvider,
): { provider: RemoteAccessProvider; idValue: string | null; skipReason: RemoteAccessLaunchSkipReason | null } {
  if (!provider.enabled) {
    return { provider, idValue: null, skipReason: 'provider_disabled' };
  }

  // Number/Boolean custom fields are stored as JSON primitives (#6191);
  // coerce them so a populated numeric identifier isn't treated as missing.
  const raw = device.customFields?.[provider.customFieldKey];
  const idValue =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : typeof raw === 'boolean'
          ? String(raw)
          : null;
  if (idValue === null || idValue.length === 0) {
    return { provider, idValue: null, skipReason: 'missing_device_identifier' };
  }
  if (!provider.urlTemplate) {
    return { provider, idValue, skipReason: 'empty_url_template' };
  }
  return { provider, idValue, skipReason: null };
}

// Checks whether a launch URL WOULD resolve for this device, without
// decrypting the provider password or substituting the template. This is the
// only launcher entry point the device-detail GET should call — it answers
// "should the Connect Desktop button render" without touching credentials.
// See issue #3402.
export function checkRemoteAccessLaunchAvailability(
  device: { customFields?: Record<string, unknown> | null },
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
  preferredProviderId?: string | null,
): RemoteAccessLaunchAvailability {
  const result = evaluateRemoteAccessLaunchAvailability(device, remoteAccess, preferredProviderId);
  return {
    available: result.skipReason === null,
    providerId: result.provider?.id ?? null,
    skipReason: result.skipReason,
  };
}

/**
 * Every provider a technician could pick for this device from the Connect
 * menu (#10922): the tenant's enabled providers that pass the same pre-decrypt
 * checks issuance runs. Like `checkRemoteAccessLaunchAvailability` it never
 * decrypts the password or substitutes the template, and it projects each
 * provider to id/label/kind field by field so a credential-bearing field added
 * to `RemoteAccessProvider` later cannot leak through a spread.
 *
 * A legacy duplicated id (save-time validation rejects new ones, #3401) is
 * listed once: issuance resolves an id by first match, so a second row with
 * the same id could never launch as itself.
 */
export function listRemoteAccessProviderOptions(
  device: { customFields?: Record<string, unknown> | null },
  remoteAccess: InheritableRemoteAccessSettings | undefined | null,
): RemoteAccessProviderOption[] {
  const providers = Array.isArray(remoteAccess?.providers) ? remoteAccess.providers : [];
  const seen = new Set<string>();
  const options: RemoteAccessProviderOption[] = [];
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) continue;
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    if (evaluateProviderForDevice(device, provider).skipReason !== null) continue;
    options.push({
      id: provider.id,
      label: typeof provider.name === 'string' && provider.name.trim().length > 0 ? provider.name : provider.id,
      kind: /^https?:/i.test(provider.urlTemplate) ? 'web' : 'protocol',
    });
  }
  return options;
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
  // A technician's own preferred provider (users.preferences.remoteAccessProviderId).
  // Deliberately an ID and nothing else: it SELECTS from the tenant's configured
  // providers, it never supplies one. The template, password and customFieldKey
  // still come from the tenant record, so a user value cannot introduce a scheme
  // or a destination -- which is what keeps the javascript: guard below meaningful.
  preferredProviderId?: string | null,
  // The tool the technician picked from the Connect menu (#10922). The same
  // "selects, never supplies" rule as the preference, but stricter: an id that
  // is not one of this tenant's enabled providers is refused
  // ('provider_not_available') instead of falling back to the default.
  explicitProviderId?: string | null,
): RemoteAccessLaunchResult {
  // Runs the same pre-decrypt checks `checkRemoteAccessLaunchAvailability`
  // uses (provider selection, enabled, identifier present, template
  // non-empty) so issuance can never disagree with availability on any of
  // these skip reasons -- they share one implementation.
  const { provider, idValue, skipReason } = evaluateRemoteAccessLaunchAvailability(
    device,
    remoteAccess,
    preferredProviderId,
    explicitProviderId,
  );
  if (skipReason !== null || !provider || idValue === null) {
    return { launchUrl: null, providerId: provider?.id ?? null, scheme: null, skipReason };
  }

  // Decrypt the provider password before substitution. Provider passwords
  // are originally written under partners.settings.remoteAccessProviders by
  // the partner-settings update route, so the AAD binding (v3 ciphertext) is
  // partners.settings — the column-level binding the registry walker uses.
  // For pre-migration plaintext rows decryptForColumn is a no-op.
  // See GitHub issue #716.
  const rawPassword = provider.password ?? '';
  const password = decryptForColumn('partners', 'settings', rawPassword) ?? rawPassword;
  const built = provider.urlTemplate
    .replaceAll('{id}', encodeURIComponent(idValue))
    .replaceAll('{password}', encodeURIComponent(password));

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
