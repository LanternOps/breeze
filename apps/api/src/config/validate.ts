import { isIP } from 'net';
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

function decodeEncryptionKey(value: string): Buffer | null {
  const trimmed = value.trim();

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const decoded = Buffer.from(padded, 'base64');
    const canonical = decoded.toString('base64').replace(/=+$/u, '');
    const input = padded.replace(/=+$/u, '');
    if (canonical !== input) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function validateProductionEncryptionKey(key: string, value: string, ctx: z.RefinementCtx): Buffer | null {
  const decoded = decodeEncryptionKey(value);
  if (!decoded || decoded.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `${key} must be exactly 32 random bytes encoded as 64 hex characters or base64/base64url in production.`,
    });
    return null;
  }

  if (appearsWeakEncryptionKeyMaterial(decoded)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `${key} appears to contain low-entropy key material. Generate 32 random bytes (e.g. openssl rand -hex 32).`,
    });
    return null;
  }

  return decoded;
}

function appearsWeakEncryptionKeyMaterial(decoded: Buffer): boolean {
  const uniqueBytes = new Set(decoded).size;
  if (uniqueBytes < 16) {
    return true;
  }

  if (decoded.length > 1) {
    const firstByte = decoded[0]!;
    const secondByte = decoded[1]!;
    const delta = (secondByte - firstByte + 256) % 256;
    let monotonic = true;
    for (let index = 1; index < decoded.length; index += 1) {
      if (decoded[index]! !== ((decoded[index - 1]! + delta) % 256)) {
        monotonic = false;
        break;
      }
    }
    if (monotonic) {
      return true;
    }
  }

  for (let blockSize = 1; blockSize <= decoded.length / 2; blockSize += 1) {
    if (decoded.length % blockSize !== 0) continue;
    let repeats = true;
    for (let index = blockSize; index < decoded.length; index += 1) {
      if (decoded[index] !== decoded[index % blockSize]) {
        repeats = false;
        break;
      }
    }
    if (repeats) {
      return true;
    }
  }

  return false;
}

function normalizedSecretValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rejectSecretReuse(
  secrets: Array<{ key: string; value: string | undefined }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, string>();
  for (const { key, value } of secrets) {
    const normalized = normalizedSecretValue(value);
    if (!normalized) continue;

    const existingKey = seen.get(normalized);
    if (existingKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must not reuse secret material from ${existingKey}. Generate a dedicated random value for each key domain.`,
      });
      continue;
    }
    seen.set(normalized, key);
  }
}

function validateProductionPepper(
  key: 'ENROLLMENT_KEY_PEPPER' | 'MFA_RECOVERY_CODE_PEPPER',
  value: string | undefined,
  ctx: z.RefinementCtx,
): void {
  const pepper = value?.trim();
  if (!pepper) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `${key} must be set in production. Generate a dedicated random secret (e.g. openssl rand -base64 32).`,
    });
    return;
  }

  if (looksInsecure(pepper)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        `${key} is set to an insecure default/placeholder value. Generate a strong random secret (e.g. openssl rand -base64 32).`,
    });
  }
  if (pepper.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        `${key} must be at least 32 characters in production. Generate a strong random secret (e.g. openssl rand -base64 32).`,
    });
  }
}

function hasReleaseArtifactManifestPublicKey(data: {
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?: string;
  BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?: string;
}): boolean {
  return Boolean(
    data.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?.trim()
    || data.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?.trim()
  );
}

function isPrivateOrLocalProxyNetwork(ip: string): boolean {
  if (ip === '::1') return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;

  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || (first === 100 && second >= 64 && second <= 127)
  );
}

function validateTrustedProxyCidrsForProduction(value: string | undefined, ctx: z.RefinementCtx): void {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    // Don't fail startup. Operators upgrading from a release that didn't require
    // this would otherwise crash on first boot behind their existing reverse proxy.
    // Default to loopback-only (effectively: trust no upstream proxy) and warn.
    // Real IP detection downstream falls back to the socket-level remote address,
    // which is correct for direct connections and conservative for proxied ones.
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[config] TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS is empty. ' +
        'Defaulting to loopback only (127.0.0.1/32, ::1/128). ' +
        'Set TRUSTED_PROXY_CIDRS to your reverse-proxy IPs to restore real-IP detection.'
      );
    }
    return;
  }

  for (const entry of entries) {
    if (entry === 'private_ranges' || entry === '0.0.0.0/0' || entry === '::/0') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message: 'TRUSTED_PROXY_CIDRS must not trust all private ranges or all source IPs.',
      });
      continue;
    }

    const [network, prefixRaw] = entry.split('/');
    if (!network || !isIP(network)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message: `TRUSTED_PROXY_CIDRS contains an invalid IP/CIDR entry: ${entry}`,
      });
      continue;
    }

    if (!prefixRaw) continue;

    const version = isIP(network);
    const prefix = Number.parseInt(prefixRaw, 10);
    const maxPrefix = version === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message: `TRUSTED_PROXY_CIDRS contains an invalid CIDR prefix: ${entry}`,
      });
      continue;
    }

    if (isPrivateOrLocalProxyNetwork(network) && prefix !== maxPrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message:
          'Private-network trusted proxies must be pinned to exact hosts (/32 for IPv4, /128 for IPv6), not broad private ranges.',
      });
    }
  }
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

    DATABASE_URL_APP: z
      .string()
      .optional()
      .refine(
        (v) => !v || v.startsWith('postgres://') || v.startsWith('postgresql://'),
        { message: 'DATABASE_URL_APP must be a valid postgres:// or postgresql:// URL' },
      )
      .describe('Optional unprivileged application DB connection. If unset, falls back to DATABASE_URL.'),

    BREEZE_APP_DB_PASSWORD: z
      .string()
      .optional()
      .describe('Password for the breeze_app role. If unset, ensureAppRole falls back to POSTGRES_PASSWORD.'),

    JWT_SECRET: z
      .string({ required_error: 'JWT_SECRET is required' })
      .min(1, 'JWT_SECRET must not be empty'),

    // -- E2E testing mode (must NEVER be enabled in production) ----------------
    E2E_MODE: z.string().optional(),

    APP_ENCRYPTION_KEY: z
      .string({ required_error: 'APP_ENCRYPTION_KEY is required' })
      .min(1, 'APP_ENCRYPTION_KEY must not be empty'),

    MFA_ENCRYPTION_KEY: z
      .string({ required_error: 'MFA_ENCRYPTION_KEY is required' })
      .min(1, 'MFA_ENCRYPTION_KEY must not be empty'),

    // -- Production-required -------------------------------------------------
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    FORCE_HTTPS: z.string().optional(),
    TRUST_PROXY_HEADERS: z.string().optional(),
    TRUSTED_PROXY_CIDRS: z.string().optional(),
    AGENT_ENROLLMENT_SECRET: z.string().optional(),
    ENROLLMENT_KEY_PEPPER: z.string().optional(),
    MFA_RECOVERY_CODE_PEPPER: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_NAME: z.string().optional(),
    BINARY_SOURCE: z.string().optional(),
    RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: z.string().optional(),
    BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: z.string().optional(),

    // -- Optional with defaults -----------------------------------------------
    API_PORT: portSchema,
    REDIS_URL: z.string().default('redis://localhost:6379'),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.string().optional(),
    REDIS_PASSWORD_FILE: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PARTNER_HOOKS_URL: z.string().url().optional(),
PARTNER_HOOKS_SECRET: z.string().min(16).optional(),
  })
  // --- Cross-field refinements (insecure defaults for required secrets) -------
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';

    // --- Required secrets: reject insecure values in production only ---
    if (isProduction) {
      // E2E_MODE must never be enabled in production
      if (data.E2E_MODE === '1' || data.E2E_MODE === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['E2E_MODE'],
          message:
            'E2E_MODE must not be enabled in production. It disables rate limiting and other security controls.',
        });
      }

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

      const appEncryptionKeyBytes = validateProductionEncryptionKey(
        'APP_ENCRYPTION_KEY',
        data.APP_ENCRYPTION_KEY,
        ctx,
      );
      const mfaEncryptionKeyBytes = validateProductionEncryptionKey(
        'MFA_ENCRYPTION_KEY',
        data.MFA_ENCRYPTION_KEY,
        ctx,
      );
      if (
        appEncryptionKeyBytes
        && mfaEncryptionKeyBytes
        && appEncryptionKeyBytes.equals(mfaEncryptionKeyBytes)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MFA_ENCRYPTION_KEY'],
          message:
            'MFA_ENCRYPTION_KEY must not reuse APP_ENCRYPTION_KEY key material. Generate a dedicated random value for each key domain.',
        });
      }

      // JWT_SECRET must be at least 32 characters in production
      if (data.JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message:
            'JWT_SECRET must be at least 32 characters in production. Generate a strong random secret (e.g. openssl rand -base64 64).',
        });
      }

      const agentEnrollmentSecret = data.AGENT_ENROLLMENT_SECRET?.trim();
      if (!agentEnrollmentSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_ENROLLMENT_SECRET'],
          message:
            'AGENT_ENROLLMENT_SECRET must be set in production. Generate a strong random secret (e.g. openssl rand -base64 32).',
        });
      } else {
        if (looksInsecure(agentEnrollmentSecret)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AGENT_ENROLLMENT_SECRET'],
            message:
              'AGENT_ENROLLMENT_SECRET is set to an insecure default/placeholder value. Generate a strong random secret (e.g. openssl rand -base64 32).',
          });
        }
        if (agentEnrollmentSecret.length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AGENT_ENROLLMENT_SECRET'],
            message:
              'AGENT_ENROLLMENT_SECRET must be at least 32 characters in production when configured. Generate a strong random secret (e.g. openssl rand -base64 32).',
          });
        }
      }

      validateProductionPepper('ENROLLMENT_KEY_PEPPER', data.ENROLLMENT_KEY_PEPPER, ctx);
      validateProductionPepper('MFA_RECOVERY_CODE_PEPPER', data.MFA_RECOVERY_CODE_PEPPER, ctx);

      const binarySource = (data.BINARY_SOURCE ?? 'github').trim().toLowerCase();
      if (binarySource === 'github' && !hasReleaseArtifactManifestPublicKey(data)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS'],
          message:
            'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS must be set in production when BINARY_SOURCE=github so installer fallback assets are verified against the signed release manifest.',
        });
      }

      rejectSecretReuse(
        [
          { key: 'JWT_SECRET', value: data.JWT_SECRET },
          { key: 'APP_ENCRYPTION_KEY', value: data.APP_ENCRYPTION_KEY },
          { key: 'MFA_ENCRYPTION_KEY', value: data.MFA_ENCRYPTION_KEY },
          { key: 'ENROLLMENT_KEY_PEPPER', value: data.ENROLLMENT_KEY_PEPPER },
          { key: 'MFA_RECOVERY_CODE_PEPPER', value: data.MFA_RECOVERY_CODE_PEPPER },
        ],
        ctx,
      );

      const bootstrapAdminEmail = data.BREEZE_BOOTSTRAP_ADMIN_EMAIL?.trim();
      const bootstrapAdminPassword = data.BREEZE_BOOTSTRAP_ADMIN_PASSWORD;
      if (bootstrapAdminEmail || bootstrapAdminPassword) {
        if (!bootstrapAdminEmail) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_EMAIL'],
            message:
              'BREEZE_BOOTSTRAP_ADMIN_EMAIL must be set when BREEZE_BOOTSTRAP_ADMIN_PASSWORD is provided.',
          });
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapAdminEmail)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_EMAIL'],
            message: 'BREEZE_BOOTSTRAP_ADMIN_EMAIL must be a valid email address.',
          });
        } else if (bootstrapAdminEmail.toLowerCase() === 'admin@breeze.local') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_EMAIL'],
            message:
              'BREEZE_BOOTSTRAP_ADMIN_EMAIL must not use the development default admin address in production.',
          });
        }

        if (!bootstrapAdminPassword) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_PASSWORD'],
            message:
              'BREEZE_BOOTSTRAP_ADMIN_PASSWORD must be set when BREEZE_BOOTSTRAP_ADMIN_EMAIL is provided.',
          });
        } else if (bootstrapAdminPassword === 'BreezeAdmin123!') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_PASSWORD'],
            message:
              'BREEZE_BOOTSTRAP_ADMIN_PASSWORD must not use the development default password in production.',
          });
        } else if (bootstrapAdminPassword.length < 16) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_PASSWORD'],
            message: 'BREEZE_BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters in production.',
          });
        } else if (looksInsecure(bootstrapAdminPassword)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BREEZE_BOOTSTRAP_ADMIN_PASSWORD'],
            message:
              'BREEZE_BOOTSTRAP_ADMIN_PASSWORD is set to an insecure default/placeholder value. Generate a strong random password.',
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

      const trustProxyHeaders = (data.TRUST_PROXY_HEADERS ?? '').trim().toLowerCase();
      const validTrustProxyValues = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
      if (!validTrustProxyValues.has(trustProxyHeaders)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY_HEADERS'],
          message:
            'TRUST_PROXY_HEADERS must be explicitly set in production to true/false (or 1/0, yes/no, on/off).',
        });
      } else if (['true', '1', 'yes', 'on'].includes(trustProxyHeaders)) {
        validateTrustedProxyCidrsForProduction(data.TRUSTED_PROXY_CIDRS, ctx);
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

    // (AGENT_ENROLLMENT_SECRET is now a hard error in production — see the
    // schema superRefine. No warning needed here; the validator throws if
    // it's missing or weak.)
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
    DATABASE_URL_APP: env.DATABASE_URL_APP,
    BREEZE_APP_DB_PASSWORD: env.BREEZE_APP_DB_PASSWORD,
    JWT_SECRET: env.JWT_SECRET,
    APP_ENCRYPTION_KEY: env.APP_ENCRYPTION_KEY,
    MFA_ENCRYPTION_KEY: env.MFA_ENCRYPTION_KEY,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    FORCE_HTTPS: env.FORCE_HTTPS,
    TRUST_PROXY_HEADERS: env.TRUST_PROXY_HEADERS,
    TRUSTED_PROXY_CIDRS: env.TRUSTED_PROXY_CIDRS,
    AGENT_ENROLLMENT_SECRET: env.AGENT_ENROLLMENT_SECRET,
    ENROLLMENT_KEY_PEPPER: env.ENROLLMENT_KEY_PEPPER,
    MFA_RECOVERY_CODE_PEPPER: env.MFA_RECOVERY_CODE_PEPPER,
    BREEZE_BOOTSTRAP_ADMIN_EMAIL: env.BREEZE_BOOTSTRAP_ADMIN_EMAIL,
    BREEZE_BOOTSTRAP_ADMIN_PASSWORD: env.BREEZE_BOOTSTRAP_ADMIN_PASSWORD,
    BREEZE_BOOTSTRAP_ADMIN_NAME: env.BREEZE_BOOTSTRAP_ADMIN_NAME,
    BINARY_SOURCE: env.BINARY_SOURCE,
    RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS,
    BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS,
    API_PORT: env.API_PORT,
    REDIS_URL: env.REDIS_URL,
    REDIS_HOST: env.REDIS_HOST,
    REDIS_PORT: env.REDIS_PORT,
    REDIS_PASSWORD_FILE: env.REDIS_PASSWORD_FILE,
    NODE_ENV: env.NODE_ENV,
    E2E_MODE: env.E2E_MODE,
    PARTNER_HOOKS_URL: env.PARTNER_HOOKS_URL,
PARTNER_HOOKS_SECRET: env.PARTNER_HOOKS_SECRET,
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
