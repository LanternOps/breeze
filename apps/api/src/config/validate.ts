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

/**
 * Task 26 (audit H-3) helper. Fires a Zod issue when a feature is "soft-enabled"
 * (its flag/URL is present) but a required companion secret is missing or
 * whitespace-only. Production-only enforcement; callers must gate on
 * `NODE_ENV === 'production'`.
 */
function requireIf(
  condition: boolean,
  name: string,
  value: string | undefined,
  hint: string,
  ctx: z.RefinementCtx,
): void {
  if (!condition) return;
  if (value && value.trim()) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [name],
    message: `${name} is required in production when ${hint}. Without it the feature 5xxs at first use instead of failing at boot.`,
  });
}

function validateTrustedProxyCidrsForProduction(value: string | undefined, ctx: z.RefinementCtx): void {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    // CRIT-1 / Task 25: boot-refuse instead of warn-and-default-to-loopback.
    //
    // Previous behavior was to fall back to loopback-only (127.0.0.1/32, ::1/128)
    // when TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS was empty. In a
    // real reverse-proxy deploy, the upstream proxy is never on loopback, so
    // isTrustedProxySource() rejects every request and getTrustedClientIp()
    // returns the proxy's own socket address for every connection. Per-IP
    // rate limits then collapse onto a single fingerprint and the login
    // rate-limit's secondary "UA + lang + XFF" fingerprint key — which the
    // attacker fully controls — becomes the only barrier. That is
    // exploitable for unlimited credential stuffing against any self-host
    // deployment one env-var typo away from this state.
    //
    // Hosted droplets already set TRUSTED_PROXY_CIDRS correctly; this change
    // closes the self-host footgun without affecting them. Operators who do
    // NOT run behind a proxy should set TRUST_PROXY_HEADERS=false instead.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUSTED_PROXY_CIDRS'],
      message:
        'TRUSTED_PROXY_CIDRS must be a non-empty CIDR list when TRUST_PROXY_HEADERS is enabled in production '
        + '(e.g. "172.30.0.11/32" for a local Caddy hop). Private-range proxies MUST be pinned to exact hosts '
        + '(/32 for IPv4, /128 for IPv6) — broad private CIDRs like 172.16.0.0/12 or 10.0.0.0/8 are rejected. '
        + 'Without it, every upstream proxy is rejected and per-IP rate limits collapse onto a spoofable fingerprint. '
        + 'If the API is NOT behind a reverse proxy, set TRUST_PROXY_HEADERS=false instead.',
    });
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

    // Optional: zero-downtime JWT signing key rotation via kid header.
    // JSON map of kid → secret (each ≥32 chars). When set, JWT_ACTIVE_KID
    // must select one of the kids to sign new tokens. JWT_SECRET is then
    // retained as a verify-only fallback for legacy (no-kid) tokens.
    JWT_SIGNING_KEYRING: z.string().optional(),
    JWT_ACTIVE_KID: z.string().optional(),

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
    IS_HOSTED: z.string().optional(),

    // MFA feature flag. When false, ALL requireMfa() gates become no-ops.
    // Warning is emitted in collectWarnings; we do NOT refuse boot (a
    // self-hosted operator may deliberately run 2FA-off).
    ENABLE_2FA: z.string().optional(),

    // OAuth Dynamic Client Registration (DCR) hardening. Both default OFF.
    // See env.ts and provider.ts for the runtime read-paths; the
    // production-only validation in superRefine refuses boot when
    // OAUTH_DCR_ENABLED=true without OAUTH_DCR_REQUIRE_IAT=true.
    OAUTH_DCR_ENABLED: z.string().optional(),
    OAUTH_DCR_REQUIRE_IAT: z.string().optional(),

    // -- Feature-flagged secrets (Task 26 / audit H-3) -----------------------
    // The validator only enforces these in production when the corresponding
    // soft-enable indicator (flag or "URL is set") is present. See the
    // matching superRefine block below for the exact pairing. None of these
    // are required at boot in development/test.
    //
    // OAuth (MCP) — required when MCP_OAUTH_ENABLED=true:
    MCP_OAUTH_ENABLED: z.string().optional(),
    OAUTH_JWKS_PRIVATE_JWK: z.string().optional(),
    OAUTH_COOKIE_SECRET: z.string().optional(),

    // Billing — required when corresponding URL is set (the URL is the
    // "soft-enable" indicator; without a key, the call silently 5xxs at first
    // request rather than at boot).
    BREEZE_BILLING_URL: z.string().optional(),
    BREEZE_BILLING_API_KEY: z.string().optional(),
    BILLING_SERVICE_URL: z.string().optional(),
    BILLING_SERVICE_API_KEY: z.string().optional(),

    // S3 / object storage — required when S3_BUCKET is set.
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),

    // Email — required when EMAIL_PROVIDER explicitly selects a backend.
    EMAIL_PROVIDER: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    MAILGUN_API_KEY: z.string().optional(),
    MAILGUN_DOMAIN: z.string().optional(),

    // Cloudflare mTLS — when CLOUDFLARE_API_TOKEN is set, zone id is required.
    CLOUDFLARE_API_TOKEN: z.string().optional(),
    CLOUDFLARE_ZONE_ID: z.string().optional(),

    // MSI signing — when MSI_SIGNING_URL is set, CF Access secret is required
    // (the signing tunnel rejects unauthenticated requests; without it every
    // first installer-link request 5xxs).
    MSI_SIGNING_URL: z.string().optional(),
    MSI_SIGNING_CF_ACCESS_SECRET: z.string().optional(),

    // Delegant M365 helpdesk — DELEGANT_BASE_URL is the soft-enable indicator.
    // When set, the service token + principal signing material are required;
    // without them every M365 tool call mints an empty/invalid principal JWT
    // and 5xxs (auth_failed) at first use instead of failing at boot.
    DELEGANT_BASE_URL: z.string().optional(),
    DELEGANT_SERVICE_TOKEN: z.string().optional(),
    DELEGANT_PRINCIPAL_SIGNING_KEY: z.string().optional(),
    DELEGANT_PRINCIPAL_KID: z.string().optional(),
    // -- Cloudflare Access JWT trust (Discussion #702) -----------------------
    // Operator opt-in to short-circuiting /auth/login when a valid CF Access
    // JWT is presented. Off by default. When on, TEAM_DOMAIN + AUD are
    // required; TRUSTS_MFA controls whether the minted Breeze session is
    // marked as MFA-satisfied by the CF Access policy (an operator
    // assertion, not derivable from the JWT itself).
    CF_ACCESS_TRUST_ENABLED: z.string().optional(),
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),
    CF_ACCESS_TRUSTS_MFA: z.string().optional(),

    // -- Optional with defaults -----------------------------------------------
    API_PORT: portSchema,
    REDIS_URL: z.string().default('redis://localhost:6379'),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.string().optional(),
    REDIS_PASSWORD_FILE: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PARTNER_HOOKS_URL: z.string().url().optional(),
    PARTNER_HOOKS_SECRET: z.string().min(16).optional(),
    IP_ALLOWLIST_ENFORCEMENT_MODE: z.enum(['enforce', 'off']).default('enforce'),

    // -- Alternative LLM backend (openai-compatible, e.g. vLLM) ---------------
    // Off by default. Chat-only PoC; tool-calling is not supported on this path.
    MCP_LLM_PROVIDER: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
    MCP_LLM_BASE_URL: z.string().url().optional(),
    MCP_LLM_API_KEY: z.string().optional(),
    MCP_LLM_MODEL: z.string().optional(),
    MCP_LLM_PRICE_INPUT_PER_M_USD: z.string().optional().transform((v) => (v ? parseFloat(v) : 0)).pipe(z.number().min(0)),
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: z.string().optional().transform((v) => (v ? parseFloat(v) : 0)).pipe(z.number().min(0)),
  })
  // --- Cross-field refinements (insecure defaults for required secrets) -------
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';

    // --- JWT signing keyring (zero-downtime rotation) ---
    // Validated in every environment: a malformed keyring would break auth
    // regardless of NODE_ENV, and a silent fallback to JWT_SECRET could mask
    // a misconfigured production deploy.
    if (data.JWT_SIGNING_KEYRING && data.JWT_SIGNING_KEYRING.trim()) {
      let parsed: unknown;
      let parseOk = false;
      try {
        parsed = JSON.parse(data.JWT_SIGNING_KEYRING);
        parseOk = true;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SIGNING_KEYRING'],
          message: 'JWT_SIGNING_KEYRING must be a JSON object of kid → secret.',
        });
      }

      if (parseOk) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SIGNING_KEYRING'],
            message: 'JWT_SIGNING_KEYRING must be a JSON object of kid → secret.',
          });
        } else {
          const entries = Object.entries(parsed as Record<string, unknown>);
          if (entries.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['JWT_SIGNING_KEYRING'],
              message: 'JWT_SIGNING_KEYRING is empty. Either unset it or provide at least one kid.',
            });
          }
          for (const [kid, secret] of entries) {
            if (typeof secret !== 'string' || secret.length < 32) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['JWT_SIGNING_KEYRING'],
                message: `JWT_SIGNING_KEYRING['${kid}'] must be a string of at least 32 characters.`,
              });
            }
          }
          if (!data.JWT_ACTIVE_KID && entries.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['JWT_ACTIVE_KID'],
              message: 'JWT_ACTIVE_KID must be set when JWT_SIGNING_KEYRING is configured.',
            });
          }
          if (
            data.JWT_ACTIVE_KID
            && !(parsed as Record<string, unknown>)[data.JWT_ACTIVE_KID]
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['JWT_ACTIVE_KID'],
              message: `JWT_ACTIVE_KID='${data.JWT_ACTIVE_KID}' is not present in JWT_SIGNING_KEYRING.`,
            });
          }
        }
      }
    } else if (data.JWT_ACTIVE_KID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACTIVE_KID'],
        message: 'JWT_ACTIVE_KID is set but JWT_SIGNING_KEYRING is empty.',
      });
    }

    // MCP_LLM_PROVIDER openai-compatible: vLLM endpoint + auth + model id required at boot
    // (enforced in all environments, not just production)
    if (data.MCP_LLM_PROVIDER === 'openai-compatible') {
      if (!data.MCP_LLM_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_LLM_BASE_URL'],
          message: 'MCP_LLM_BASE_URL is required when MCP_LLM_PROVIDER is openai-compatible.',
        });
      }
      if (!data.MCP_LLM_MODEL?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_LLM_MODEL'],
          message: 'MCP_LLM_MODEL is required when MCP_LLM_PROVIDER is openai-compatible.',
        });
      }
      if (!data.MCP_LLM_API_KEY?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_LLM_API_KEY'],
          message: 'MCP_LLM_API_KEY is required when MCP_LLM_PROVIDER is openai-compatible.',
        });
      }
    }

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

      // Task 27 (audit HIGH-2): require the manifest trust root in
      // production for BOTH BINARY_SOURCE=github AND BINARY_SOURCE=local.
      // - github mode: installer fallback assets are downloaded from the
      //   GitHub release page; the manifest signature is the only thing
      //   tying the asset bytes back to a release we built.
      // - local mode: per-deployment manifests are signed by a key minted
      //   into manifest_signing_keys (see services/manifestSigning.ts), but
      //   agents only verify those signatures when a trust root has been
      //   published to them via RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS. With
      //   the env var unset, releaseArtifactManifest.ts has no keys to
      //   verify against and the verification path silently falls back to
      //   accepting unsigned manifests — defeating the whole agent-update
      //   trust chain.
      // The previous `binarySource === 'github'` gate was the bug: a
      // self-host operator who switched to BINARY_SOURCE=local without
      // also wiring RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS would boot clean
      // and trust unsigned update manifests.
      if (!hasReleaseArtifactManifestPublicKey(data)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS'],
          message:
            'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS must be set in production for both BINARY_SOURCE=github (verifies installer fallback assets against the signed release manifest) and BINARY_SOURCE=local (anchors per-deployment update manifests; without a trust root, agents accept unsigned manifests).',
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
      const validBoolValues = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
      if (!validBoolValues.has(trustProxyHeaders)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY_HEADERS'],
          message:
            'TRUST_PROXY_HEADERS must be explicitly set in production to true/false (or 1/0, yes/no, on/off).',
        });
      } else if (['true', '1', 'yes', 'on'].includes(trustProxyHeaders)) {
        validateTrustedProxyCidrsForProduction(data.TRUSTED_PROXY_CIDRS, ctx);
      }

      // IS_HOSTED gates the email-verification → status='active' path in
      // register.ts. Unset/unmapped on a hosted droplet would silently
      // drop new partners straight to 'active', bypassing the verify gate
      // (issue #570). Self-hosted deploys must opt out explicitly.
      const isHostedRaw = (data.IS_HOSTED ?? '').trim().toLowerCase();
      if (!validBoolValues.has(isHostedRaw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['IS_HOSTED'],
          message:
            'IS_HOSTED must be explicitly set in production to true/false (or 1/0, yes/no, on/off). Hosted SaaS deployments set true; self-hosted deployments set false.',
        });
      }

      // OAuth DCR (Dynamic Client Registration) hardening (Task 21).
      // When DCR is enabled in production, an initial-access-token is also
      // required — without it, POST /oauth/reg is anonymous and any actor
      // on the internet can create OAuth clients with deceptive
      // client_name strings (logos, brand mimicry, etc.). Boot-refuse the
      // misconfig so a "DCR=true, IAT unset" deploy never reaches prod.
      const dcrEnabledRaw = (data.OAUTH_DCR_ENABLED ?? '').trim().toLowerCase();
      const dcrRequireIatRaw = (data.OAUTH_DCR_REQUIRE_IAT ?? '').trim().toLowerCase();
      const dcrEnabled = ['true', '1', 'yes', 'on'].includes(dcrEnabledRaw);
      const dcrRequireIat = ['true', '1', 'yes', 'on'].includes(dcrRequireIatRaw);
      if (dcrEnabled && !dcrRequireIat) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OAUTH_DCR_REQUIRE_IAT'],
          message:
            'OAUTH_DCR_REQUIRE_IAT=true is required when OAUTH_DCR_ENABLED=true in production. Without an initial-access-token gate, POST /oauth/reg is anonymous and any actor can create OAuth clients with deceptive client_name strings.',
        });
      }

      // --- Task 26 / audit H-3: feature-flagged secrets -------------------
      // Each soft-enabled feature must have its companion secret(s) present
      // at boot. Without this, the API boots clean and 5xxs only on the
      // first request that exercises the feature — which on a fresh prod
      // deploy can be hours after Caddy's healthcheck passes.
      //
      // Indicator semantics:
      //   - boolean flags  → MCP_OAUTH_ENABLED
      //   - "URL is set"   → BREEZE_BILLING_URL, BILLING_SERVICE_URL,
      //                      S3_BUCKET, CLOUDFLARE_API_TOKEN, MSI_SIGNING_URL
      //   - explicit value → EMAIL_PROVIDER=resend|smtp|mailgun
      const truthyFlag = (raw: string | undefined): boolean =>
        ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

      // OAuth (MCP_OAUTH_ENABLED)
      const mcpOauthEnabled = truthyFlag(data.MCP_OAUTH_ENABLED);
      requireIf(
        mcpOauthEnabled,
        'OAUTH_JWKS_PRIVATE_JWK',
        data.OAUTH_JWKS_PRIVATE_JWK,
        'MCP_OAUTH_ENABLED=true (JWT signing material for /oauth/* endpoints)',
        ctx,
      );
      requireIf(
        mcpOauthEnabled,
        'OAUTH_COOKIE_SECRET',
        data.OAUTH_COOKIE_SECRET,
        'MCP_OAUTH_ENABLED=true (oidc-provider session/interaction cookie signing)',
        ctx,
      );

      // Billing (breeze-billing service-to-service)
      const breezeBillingEnabled = Boolean(data.BREEZE_BILLING_URL?.trim());
      requireIf(
        breezeBillingEnabled,
        'BREEZE_BILLING_API_KEY',
        data.BREEZE_BILLING_API_KEY,
        'BREEZE_BILLING_URL is set (service-to-service auth to breeze-billing)',
        ctx,
      );

      // Billing (AI cost tracker — partner-credits API)
      const partnerBillingEnabled = Boolean(data.BILLING_SERVICE_URL?.trim());
      requireIf(
        partnerBillingEnabled,
        'BILLING_SERVICE_API_KEY',
        data.BILLING_SERVICE_API_KEY,
        'BILLING_SERVICE_URL is set (partner AI-credits check/deduct)',
        ctx,
      );

      // S3 / object storage (S3_BUCKET as indicator)
      const s3Enabled = Boolean(data.S3_BUCKET?.trim());
      requireIf(
        s3Enabled,
        'S3_ACCESS_KEY',
        data.S3_ACCESS_KEY,
        'S3_BUCKET is set (object-storage uploads/presigned URLs)',
        ctx,
      );
      requireIf(
        s3Enabled,
        'S3_SECRET_KEY',
        data.S3_SECRET_KEY,
        'S3_BUCKET is set (object-storage uploads/presigned URLs)',
        ctx,
      );

      // Email — only enforced when EMAIL_PROVIDER explicitly picks a backend.
      // 'auto' / unset leaves the system in best-effort mode (system.ts will
      // mark email as `configured: false` and downstream code degrades).
      const emailProvider = (data.EMAIL_PROVIDER ?? '').trim().toLowerCase();
      requireIf(
        emailProvider === 'resend',
        'RESEND_API_KEY',
        data.RESEND_API_KEY,
        'EMAIL_PROVIDER=resend',
        ctx,
      );
      requireIf(
        emailProvider === 'smtp',
        'SMTP_HOST',
        data.SMTP_HOST,
        'EMAIL_PROVIDER=smtp',
        ctx,
      );
      requireIf(
        emailProvider === 'mailgun',
        'MAILGUN_API_KEY',
        data.MAILGUN_API_KEY,
        'EMAIL_PROVIDER=mailgun',
        ctx,
      );
      requireIf(
        emailProvider === 'mailgun',
        'MAILGUN_DOMAIN',
        data.MAILGUN_DOMAIN,
        'EMAIL_PROVIDER=mailgun',
        ctx,
      );

      // Cloudflare mTLS (CLOUDFLARE_API_TOKEN as indicator)
      const cfMtlsEnabled = Boolean(data.CLOUDFLARE_API_TOKEN?.trim());
      requireIf(
        cfMtlsEnabled,
        'CLOUDFLARE_ZONE_ID',
        data.CLOUDFLARE_ZONE_ID,
        'CLOUDFLARE_API_TOKEN is set (mTLS issuance against the configured zone)',
        ctx,
      );

      // MSI signing (MSI_SIGNING_URL as indicator).
      // The Cloudflare-fronted signing tunnel rejects unauthenticated requests.
      // The signing service also accepts a per-account X-API-Key, but the
      // CF Access service-token pair is mandatory in the current deploy —
      // without it every /installer/link request 5xxs.
      const msiSigningEnabled = Boolean(data.MSI_SIGNING_URL?.trim());
      requireIf(
        msiSigningEnabled,
        'MSI_SIGNING_CF_ACCESS_SECRET',
        data.MSI_SIGNING_CF_ACCESS_SECRET,
        'MSI_SIGNING_URL is set (Cloudflare Access service-token auth to the signing tunnel)',
        ctx,
      );

      // Delegant M365 helpdesk (DELEGANT_BASE_URL as indicator). When the
      // feature is soft-enabled, all transport + principal-signing material is
      // required; a partial config mints an empty/invalid principal JWT and
      // auth_fails at first M365 tool call instead of failing at boot.
      const delegantEnabled = Boolean(data.DELEGANT_BASE_URL?.trim());
      requireIf(
        delegantEnabled,
        'DELEGANT_SERVICE_TOKEN',
        data.DELEGANT_SERVICE_TOKEN,
        'DELEGANT_BASE_URL is set (service-to-service auth to Delegant)',
        ctx,
      );
      requireIf(
        delegantEnabled,
        'DELEGANT_PRINCIPAL_SIGNING_KEY',
        data.DELEGANT_PRINCIPAL_SIGNING_KEY,
        'DELEGANT_BASE_URL is set (Ed25519 PKCS8 key that signs the principal JWT)',
        ctx,
      );
      requireIf(
        delegantEnabled,
        'DELEGANT_PRINCIPAL_KID',
        data.DELEGANT_PRINCIPAL_KID,
        'DELEGANT_BASE_URL is set (key id Delegant uses to verify the principal JWT)',
        ctx,
      );
    }

    // CF Access JWT trust (Discussion #702). Independent of NODE_ENV: the
    // feature is opt-in via CF_ACCESS_TRUST_ENABLED, and when enabled the
    // team domain and AUD are load-bearing for verifying the JWT. Validate
    // anywhere the flag is on so dev misconfig is caught at boot.
    const cfAccessTrustRaw = (data.CF_ACCESS_TRUST_ENABLED ?? '').trim().toLowerCase();
    if (cfAccessTrustRaw && !['', 'false', '0', 'no', 'off'].includes(cfAccessTrustRaw)) {
      if (!['true', '1', 'yes', 'on'].includes(cfAccessTrustRaw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CF_ACCESS_TRUST_ENABLED'],
          message:
            'CF_ACCESS_TRUST_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set.',
        });
      } else {
        const teamDomain = (data.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
        if (!teamDomain) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_TEAM_DOMAIN'],
            message:
              'CF_ACCESS_TEAM_DOMAIN is required when CF_ACCESS_TRUST_ENABLED is true (e.g. example.cloudflareaccess.com, no scheme).',
          });
        } else if (teamDomain.includes('://')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_TEAM_DOMAIN'],
            message:
              'CF_ACCESS_TEAM_DOMAIN must not include a scheme. Use the bare hostname (e.g. example.cloudflareaccess.com).',
          });
        }
        const aud = (data.CF_ACCESS_AUD ?? '').trim();
        if (!aud) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_AUD'],
            message:
              'CF_ACCESS_AUD is required when CF_ACCESS_TRUST_ENABLED is true. Get the application AUD tag from the Cloudflare Zero Trust dashboard.',
          });
        }
        const trustsMfaRaw = (data.CF_ACCESS_TRUSTS_MFA ?? '').trim().toLowerCase();
        const cfBoolValues = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
        if (trustsMfaRaw && !cfBoolValues.has(trustsMfaRaw)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_TRUSTS_MFA'],
            message:
              'CF_ACCESS_TRUSTS_MFA must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (does not satisfy MFA).',
          });
        }
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

  // Warn when 2FA is globally disabled: this neuters ALL requireMfa() step-up
  // gates across the entire API, not just /auth/mfa endpoints. Non-fatal — a
  // self-hosted operator may deliberately run 2FA-off; we must not lock them
  // out. See: Finding #3 (security review May 2026).
  //
  // Mirror envFlag('ENABLE_2FA', true) exactly: it disables on ANY value that
  // isn't in the truthy set (so ENABLE_2FA=disabled / nope also disable 2FA).
  // Match that here so the warning fires for every disabling value, not just
  // the obvious false/0/no/off ones.
  const enable2faRaw = (env.ENABLE_2FA ?? '').trim().toLowerCase();
  const enable2faSetButFalsy =
    enable2faRaw !== '' && !['1', 'true', 'yes', 'on'].includes(enable2faRaw);
  if (enable2faSetButFalsy) {
    warnings.push({
      key: 'ENABLE_2FA',
      message:
        'ENABLE_2FA=false disables ALL requireMfa() step-up gates (admin/abuse, ' +
        'tenant export/erasure, remote access, API keys, SSO, backups) — not just ' +
        'the /auth/mfa endpoints. Strongly discouraged in production.',
    });
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
    JWT_SIGNING_KEYRING: env.JWT_SIGNING_KEYRING,
    JWT_ACTIVE_KID: env.JWT_ACTIVE_KID,
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
    IS_HOSTED: env.IS_HOSTED,
    ENABLE_2FA: env.ENABLE_2FA,
    OAUTH_DCR_ENABLED: env.OAUTH_DCR_ENABLED,
    OAUTH_DCR_REQUIRE_IAT: env.OAUTH_DCR_REQUIRE_IAT,
    // Task 26 (H-3): feature-flagged production secrets.
    MCP_OAUTH_ENABLED: env.MCP_OAUTH_ENABLED,
    OAUTH_JWKS_PRIVATE_JWK: env.OAUTH_JWKS_PRIVATE_JWK,
    OAUTH_COOKIE_SECRET: env.OAUTH_COOKIE_SECRET,
    BREEZE_BILLING_URL: env.BREEZE_BILLING_URL,
    BREEZE_BILLING_API_KEY: env.BREEZE_BILLING_API_KEY,
    BILLING_SERVICE_URL: env.BILLING_SERVICE_URL,
    BILLING_SERVICE_API_KEY: env.BILLING_SERVICE_API_KEY,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
    EMAIL_PROVIDER: env.EMAIL_PROVIDER,
    RESEND_API_KEY: env.RESEND_API_KEY,
    SMTP_HOST: env.SMTP_HOST,
    MAILGUN_API_KEY: env.MAILGUN_API_KEY,
    MAILGUN_DOMAIN: env.MAILGUN_DOMAIN,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID,
    MSI_SIGNING_URL: env.MSI_SIGNING_URL,
    MSI_SIGNING_CF_ACCESS_SECRET: env.MSI_SIGNING_CF_ACCESS_SECRET,
    DELEGANT_BASE_URL: env.DELEGANT_BASE_URL,
    DELEGANT_SERVICE_TOKEN: env.DELEGANT_SERVICE_TOKEN,
    DELEGANT_PRINCIPAL_SIGNING_KEY: env.DELEGANT_PRINCIPAL_SIGNING_KEY,
    DELEGANT_PRINCIPAL_KID: env.DELEGANT_PRINCIPAL_KID,
    CF_ACCESS_TRUST_ENABLED: env.CF_ACCESS_TRUST_ENABLED,
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: env.CF_ACCESS_AUD,
    CF_ACCESS_TRUSTS_MFA: env.CF_ACCESS_TRUSTS_MFA,
    API_PORT: env.API_PORT,
    REDIS_URL: env.REDIS_URL,
    REDIS_HOST: env.REDIS_HOST,
    REDIS_PORT: env.REDIS_PORT,
    REDIS_PASSWORD_FILE: env.REDIS_PASSWORD_FILE,
    NODE_ENV: env.NODE_ENV,
    E2E_MODE: env.E2E_MODE,
    PARTNER_HOOKS_URL: env.PARTNER_HOOKS_URL,
    PARTNER_HOOKS_SECRET: env.PARTNER_HOOKS_SECRET,
    MCP_LLM_PROVIDER: env.MCP_LLM_PROVIDER,
    MCP_LLM_BASE_URL: env.MCP_LLM_BASE_URL,
    MCP_LLM_API_KEY: env.MCP_LLM_API_KEY,
    MCP_LLM_MODEL: env.MCP_LLM_MODEL,
    MCP_LLM_PRICE_INPUT_PER_M_USD: env.MCP_LLM_PRICE_INPUT_PER_M_USD,
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: env.MCP_LLM_PRICE_OUTPUT_PER_M_USD,
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
