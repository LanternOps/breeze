function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export const ENABLE_ENDPOINT_AV_FEATURES = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_ENDPOINT_AV_FEATURES,
  false
);
