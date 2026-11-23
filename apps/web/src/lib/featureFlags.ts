const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.includes(normalized)) return true;
  if (FALSY.includes(normalized)) return false;
  console.warn(`[featureFlags] Unrecognized boolean value: "${value}". Defaulting to ${fallback}.`);
  return fallback;
}

export const ENABLE_ENDPOINT_AV_FEATURES = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_ENDPOINT_AV_FEATURES,
  false
);

export const ENABLE_EDR_INTEGRATIONS = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_EDR_INTEGRATIONS,
  false
);

// Unified Devices list network arm (#1322): surface network-discovered assets
// alongside agent endpoints in the Devices view. ON by default since
// 2026-09-06 (unified sort, per-asset detail pages, class-aware filters and an
// honest bulk bar all landed); set PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST=false
// at build time to fall back to the agent-only list.
export const ENABLE_NETWORK_DEVICES_IN_LIST = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST,
  true
);

// Endpoint messaging entry points and the device Chat tab (#8741, #8743,
// #8968). ON by default: the published web image is built without this
// variable, so an opt-in default left the feature unreachable on every hosted
// and self-hosted install. Sending is still gated server-side by the
// `endpoint_messages:send` permission, the minimum agent version, and the
// "Endpoint messaging" switch on the Breeze Assist policy. Set
// PUBLIC_ENABLE_ENDPOINT_MESSAGING=false at build time to hide the entry
// points.
export const ENABLE_ENDPOINT_MESSAGING = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_ENDPOINT_MESSAGING,
  true
);

// NOTE: registration enablement is intentionally NOT a build-time flag. A
// prebuilt web image can't honor a PUBLIC_ env at runtime, so the UI reads the
// runtime ENABLE_REGISTRATION value from GET /api/v1/config instead (see
// useRegistrationGate in stores/featuresStore). Issue #1308.
