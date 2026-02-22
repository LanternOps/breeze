export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:4322',
  'http://127.0.0.1:4322',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'tauri://localhost',
  'http://tauri.localhost'
] as const;

type OriginResolverOptions = {
  configuredOriginsRaw?: string;
  nodeEnv?: string;
  defaultOrigins?: string[];
};

export function shouldIncludeDefaultOrigins(nodeEnv: string): boolean {
  if (nodeEnv !== 'production') return true;
  const flag = (process.env.CORS_INCLUDE_DEFAULT_ORIGINS ?? '').trim().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

export function createCorsOriginResolver(options: OriginResolverOptions = {}): (origin?: string) => string | null {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';

  const includeDefaults = options.defaultOrigins
    ? options.defaultOrigins.length > 0
    : shouldIncludeDefaultOrigins(nodeEnv);

  const defaultOrigins = options.defaultOrigins && options.defaultOrigins.length > 0
    ? options.defaultOrigins
    : includeDefaults ? [...DEFAULT_ALLOWED_ORIGINS] : [];

  const configuredOrigins = (options.configuredOriginsRaw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const allowedOrigins = new Set<string>([
    ...defaultOrigins,
    ...configuredOrigins
  ]);

  return (origin?: string): string | null => {
    // No origin header → return null (do not emit ACAO header)
    if (!origin) return null;

    if (allowedOrigins.has(origin)) return origin;

    if (nodeEnv !== 'production') {
      try {
        const parsed = new URL(origin);
        if (
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname.startsWith('10.') ||
          parsed.hostname.startsWith('192.168.') ||
          parsed.hostname.startsWith('100.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
        ) {
          return origin;
        }
      } catch {
        // fall through
      }
    }

    return null;
  };
}
