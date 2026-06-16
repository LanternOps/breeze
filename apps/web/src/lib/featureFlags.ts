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

// Unified Devices list network arm (#1322): surface network-discovered assets
// alongside agent endpoints in the Devices view. Off by default until the
// remaining rough edges (unified sort/pagination, per-asset detail pages,
// inline approval) land — see the #1322 follow-up issues.
export const ENABLE_NETWORK_DEVICES_IN_LIST = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST,
  false
);

// Breeze AI for Office (Excel/Word/etc. add-in admin surface). Off by default.
// This flag controls only the left-nav entry's visibility (combined with the
// existing partner-scope check). The admin pages behind it stay dark until the
// API has CLIENT_AI_ENTRA_CLIENT_ID set, which 404s the /client-ai/admin group
// server-side — a separate, deeper gate, not what this flag does.
export const ENABLE_AI_FOR_OFFICE = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_AI_FOR_OFFICE,
  false
);

// NOTE: registration enablement is intentionally NOT a build-time flag. A
// prebuilt web image can't honor a PUBLIC_ env at runtime, so the UI reads the
// runtime ENABLE_REGISTRATION value from GET /api/v1/config instead (see
// useRegistrationGate in stores/featuresStore). Issue #1308.
