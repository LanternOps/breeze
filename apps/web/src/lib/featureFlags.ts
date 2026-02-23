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

export const ENABLE_REGISTRATION = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_REGISTRATION,
  true
);

if (!ENABLE_REGISTRATION) {
  console.warn('[web] Registration is disabled (PUBLIC_ENABLE_REGISTRATION=false). Registration pages will redirect to /login.');
}
