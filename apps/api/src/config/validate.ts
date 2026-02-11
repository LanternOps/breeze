import { z } from 'zod';

// ---------------------------------------------------------------------------
// Insecure default detection
// ---------------------------------------------------------------------------

const INSECURE_PATTERNS = [
  'changeme',
  'change-me',
  'change_me',
  'password',
  'your-secret',
  'your-super-secret',
  'generate-a-random',
  'change-in-production',
  'must-be-at-least',
  'another-secret',
];

/** Known placeholder values from .env.example that must never be used in production. */
const KNOWN_PLACEHOLDER_VALUES = new Set([
  'your-super-secret-jwt-key-change-in-production-must-be-at-least-32-chars',
  'generate-a-random-hex-string-for-production',
  'your-enrollment-secret-change-in-production',
  'another-secret-for-sessions-change-in-production',
  'generate-a-random-secret-for-production',
  'generate-a-random-token-for-production',
]);

function looksInsecure(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (KNOWN_PLACEHOLDER_VALUES.has(lower)) return true;
  return INSECURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const portSchema = z
  .string()
  .default('3001')
  .transform((val) => parseInt(val, 10))
  .pipe(z.number().int().min(1).max(65535));

const envSchema = z
  .object({
    // -- Required (always) ---------------------------------------------------
    DATABASE_URL: z
      .string({ required_error: 'DATABASE_URL is required' })
      .min(1, 'DATABASE_URL must not be empty')
      .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), {
        message: 'DATABASE_URL must be a valid postgres:// or postgresql:// URL',
      }),

    JWT_SECRET: z
      .string({ required_error: 'JWT_SECRET is required' })
      .min(1, 'JWT_SECRET must not be empty'),

    APP_ENCRYPTION_KEY: z
      .string({ required_error: 'APP_ENCRYPTION_KEY is required' })
      .min(1, 'APP_ENCRYPTION_KEY must not be empty'),

    MFA_ENCRYPTION_KEY: z
      .string({ required_error: 'MFA_ENCRYPTION_KEY is required' })
      .min(1, 'MFA_ENCRYPTION_KEY must not be empty'),

    // -- Production-required -------------------------------------------------
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    FORCE_HTTPS: z.string().optional(),

    // -- Optional with defaults -----------------------------------------------
    API_PORT: portSchema,
    REDIS_URL: z.string().default('redis://localhost:6379'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  // --- Cross-field refinements (insecure defaults for required secrets) -------
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';

    // --- Required secrets: reject insecure values in production only ---
    if (isProduction) {
      const requiredSecrets: Array<{ key: string; value: string }> = [
        { key: 'JWT_SECRET', value: data.JWT_SECRET },
        { key: 'APP_ENCRYPTION_KEY', value: data.APP_ENCRYPTION_KEY },
        { key: 'MFA_ENCRYPTION_KEY', value: data.MFA_ENCRYPTION_KEY },
      ];

      for (const { key, value } of requiredSecrets) {
        if (looksInsecure(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is set to an insecure default/placeholder value. Generate a strong random secret (e.g. openssl rand -base64 64).`,
          });
        }
      }

      if (!data.CORS_ALLOWED_ORIGINS || data.CORS_ALLOWED_ORIGINS.trim() === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message:
            'CORS_ALLOWED_ORIGINS must be set to specific origins in production (wildcard * is not allowed).',
        });
      }
    }
  });

// Inferred config type from the schema
export type AppConfig = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _config: AppConfig | null = null;

/**
 * Returns the validated config singleton.
 * Throws if called before `validateConfig()`.
 */
export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error('getConfig() called before validateConfig(). Call validateConfig() at startup.');
  }
  return _config;
}

// ---------------------------------------------------------------------------
// Warnings (non-fatal)
// ---------------------------------------------------------------------------

interface ConfigWarning {
  key: string;
  message: string;
}

function collectWarnings(env: Record<string, string | undefined>): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  // Production: FORCE_HTTPS should be true
  if (isProduction) {
    const forceHttps = (env.FORCE_HTTPS ?? '').trim().toLowerCase();
    if (forceHttps !== 'true' && forceHttps !== '1') {
      warnings.push({
        key: 'FORCE_HTTPS',
        message: 'FORCE_HTTPS is not enabled. HTTPS is strongly recommended in production.',
      });
    }
  }

  // Warn about optional secrets that look insecure
  const optionalSecrets = [
    'AGENT_ENROLLMENT_SECRET',
    'SESSION_SECRET',
    'TURN_SECRET',
    'METRICS_SCRAPE_TOKEN',
    'ENROLLMENT_KEY_PEPPER',
    'MFA_RECOVERY_CODE_PEPPER',
  ];

  for (const key of optionalSecrets) {
    const value = env[key];
    if (value && looksInsecure(value)) {
      warnings.push({
        key,
        message: `${key} appears to be set to an insecure default/placeholder. Consider generating a strong random value.`,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates environment variables on startup.
 *
 * - Returns a typed config object on success and stores it as a singleton.
 * - Logs warnings for non-fatal issues (e.g. optional vars with placeholder values).
 * - Throws with a formatted error listing all problems if validation fails.
 *
 * Retrieve the config later via `getConfig()`.
 */
export function validateConfig(): AppConfig {
  const env = process.env;

  // Collect and log warnings first (these don't prevent startup)
  const warnings = collectWarnings(env as Record<string, string | undefined>);
  for (const w of warnings) {
    console.warn(`[config] WARNING: ${w.key} — ${w.message}`);
  }

  // Validate required config
  const result = envSchema.safeParse({
    DATABASE_URL: env.DATABASE_URL,
    JWT_SECRET: env.JWT_SECRET,
    APP_ENCRYPTION_KEY: env.APP_ENCRYPTION_KEY,
    MFA_ENCRYPTION_KEY: env.MFA_ENCRYPTION_KEY,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    FORCE_HTTPS: env.FORCE_HTTPS,
    API_PORT: env.API_PORT,
    REDIS_URL: env.REDIS_URL,
    NODE_ENV: env.NODE_ENV,
  });

  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );

    const message = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║               CONFIGURATION VALIDATION FAILED              ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '║ The API cannot start due to missing or invalid config.     ║',
      '║ Fix the issues below and restart.                          ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      `Found ${issues.length} configuration error(s):`,
      '',
      ...lines,
      '',
      'Hint: Copy .env.example to .env and update the values.',
      'Generate secrets with: openssl rand -base64 64',
      '',
    ].join('\n');

    throw new Error(message);
  }

  _config = result.data;
  return _config;
}
