export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:4322',
  'http://127.0.0.1:4322',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'tauri://localhost'
] as const;

type OriginResolverOptions = {
  configuredOriginsRaw?: string;
  nodeEnv?: string;
  defaultOrigins?: string[];
};

export function createCorsOriginResolver(options: OriginResolverOptions = {}): (origin?: string) => string {
  const defaultOrigins = options.defaultOrigins && options.defaultOrigins.length > 0
    ? options.defaultOrigins
    : [...DEFAULT_ALLOWED_ORIGINS];

  const configuredOrigins = (options.configuredOriginsRaw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const allowedOrigins = new Set<string>([
    ...defaultOrigins,
    ...configuredOrigins
  ]);

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';

  return (origin?: string): string => {
    if (!origin) return defaultOrigins[0];
    if (allowedOrigins.has(origin)) return origin;

    if (nodeEnv !== 'production') {
      try {
        const parsed = new URL(origin);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          return origin;
        }
      } catch {
        // fall through to default origin
      }
    }

    return defaultOrigins[0];
  };
}
