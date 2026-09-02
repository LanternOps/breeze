import { isIP } from 'net';
import { z } from 'zod';
import { validateM365CustomerGraphReadRuntimeConfigAtBoot } from '../services/m365ControlPlane/runtimeConfig';
import { validateM365CustomerGraphActionsRuntimeConfigAtBoot } from '../services/m365ControlPlane/writeActionRuntimeConfig';
import { validateM365CommunicationsRuntimeConfigAtBoot } from '../services/m365ControlPlane/commsRuntimeConfig';
import {
  OFFICIAL_RELEASE_REPOSITORY,
  RELEASE_SOURCE_REPOSITORY_SHAPE,
  isValidReleaseSourceRepository,
} from '../services/releaseSource';
import { EVENT_SUBSCRIBER_IDS, isSubscriberId } from '../services/eventSubscriberIds';
import {
  canonicalCfAccessTeamDomain,
  decodePartnerApiCursorSigningKey,
  isRecognizedSelfHostSignal,
  parseEventPermissionEpochMode,
  parseOAuthAuthEpochEnforceAfter,
} from './env';

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

// The public trust anchor for OFFICIAL Breeze releases. Also embedded in the
// agent (agent/internal/updater/updater.go) and shipped uncommented in
// deploy/.env.example — which is exactly why it needs its own check below.
const OFFICIAL_RELEASE_MANIFEST_PUBLIC_KEY =
  'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=';

// True when every configured manifest key is the official one. A self-hoster
// pointing BINARY_GITHUB_REPOSITORY at their own signing repo while leaving the
// shipped official key in place would boot cleanly and then fail EVERY sync
// closed (their manifest cannot verify under the official key), freezing the
// fleet behind a single console.error. Catch it at boot instead.
function hasOnlyOfficialReleaseManifestPublicKey(data: {
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?: string;
  BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS?: string;
}): boolean {
  const configured = [
    data.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS,
    data.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS,
  ]
    .flatMap((value) => (value ?? '').split(','))
    .map((key) => key.trim())
    .filter(Boolean);
  return (
    configured.length > 0
    && configured.every((key) => key === OFFICIAL_RELEASE_MANIFEST_PUBLIC_KEY)
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

/**
 * Wave 3 live-authorization rollout controls (`OAUTH_AUTH_EPOCH_ENFORCE_AFTER`,
 * `EVENT_PERMISSION_EPOCH_MODE`).
 *
 * The parsers themselves live in config/env.ts, but they are invoked HERE so a
 * misconfigured value refuses boot through the aggregated validator report
 * rather than throwing while env.ts is being imported. env.ts is imported by
 * this validator, by background jobs, by seeds and by scripts; a module-scope
 * throw there kills all of them and preempts every other config check.
 *
 * Shape is enforced in every environment — a value that is neither `compat`
 * nor `enforce`, or a timestamp without an explicit UTC/offset suffix, is a
 * bug regardless of NODE_ENV. Presence is enforced in production only, so
 * local dev keeps the documented defaults.
 */
function validateLiveAuthorizationRolloutConfig(
  data: {
    OAUTH_AUTH_EPOCH_ENFORCE_AFTER?: string;
    EVENT_PERMISSION_EPOCH_MODE?: string;
    MCP_OAUTH_ENABLED?: string;
  },
  isProduction: boolean,
  ctx: z.RefinementCtx,
): void {
  const truthy = (raw: string | undefined): boolean =>
    ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

  const oauthDeadline = data.OAUTH_AUTH_EPOCH_ENFORCE_AFTER?.trim() ?? '';
  if (oauthDeadline) {
    try {
      // Non-strict options: this call only exercises the format check; the
      // presence rule is applied explicitly below so the message names the
      // production condition.
      parseOAuthAuthEpochEnforceAfter(oauthDeadline, { oauthEnabled: false, nodeEnv: undefined });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OAUTH_AUTH_EPOCH_ENFORCE_AFTER'],
        message:
          'OAUTH_AUTH_EPOCH_ENFORCE_AFTER must be an absolute ISO timestamp with an explicit UTC/offset suffix (e.g. 2026-08-06T00:30:00Z). A local timestamp would move the OAuth compatibility deadline with the host timezone.',
      });
    }
  } else if (isProduction && truthy(data.MCP_OAUTH_ENABLED)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OAUTH_AUTH_EPOCH_ENFORCE_AFTER'],
      message:
        'OAUTH_AUTH_EPOCH_ENFORCE_AFTER is required in production when MCP_OAUTH_ENABLED=true. It is the absolute end of the compatibility window for pre-Wave-3 access tokens that carry no auth_epoch claim; without it those tokens are accepted indefinitely. Choose one timestamp per rollout, at least ACCESS_TOKEN_TTL_SECONDS after the first new token-minting instance starts.',
    });
  }

  const eventMode = data.EVENT_PERMISSION_EPOCH_MODE?.trim() ?? '';
  if (eventMode) {
    try {
      parseEventPermissionEpochMode(eventMode, undefined);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENT_PERMISSION_EPOCH_MODE'],
        message: 'EVENT_PERMISSION_EPOCH_MODE must be compat or enforce.',
      });
    }
  } else if (isProduction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EVENT_PERMISSION_EPOCH_MODE'],
      message:
        'EVENT_PERMISSION_EPOCH_MODE must be explicitly set in production to compat or enforce. Deploy new event-ticket writers with compat, then switch the whole fleet to enforce at least 60 seconds after the last version-one writer drains.',
    });
  }
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

// The plain-object half of the schema. Kept as its own binding purely so its
// key set can be enumerated — `validateConfig()` derives the object it validates
// from `ENV_SCHEMA_KEYS` below rather than from a hand-maintained pick list.
const envObjectSchema = z
  .object({
    // -- Required (always) ---------------------------------------------------
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
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
      .describe(
        'Explicit unprivileged request DB connection. If unset, Breeze derives the breeze_app URL using BREEZE_APP_DB_PASSWORD or POSTGRES_PASSWORD; production refuses direct DATABASE_URL fallback.',
      ),

    BREEZE_APP_DB_PASSWORD: z
      .string()
      .optional()
      .describe('Password for the breeze_app role. If unset, ensureAppRole falls back to POSTGRES_PASSWORD.'),

    POSTGRES_PASSWORD: z
      .string()
      .optional()
      .describe('Standard Compose PostgreSQL password and fallback breeze_app derivation credential.'),

    // Issue #915: dedicated connection string for the `breeze_audit_admin`
    // login role used ONLY by the audit-log retention worker. When set,
    // retention deletes run on a separate pool with connection-level
    // privilege separation, so audit_logs DELETE is unreachable from the
    // main breeze_app pool. When unset, retention falls back to the legacy
    // shared-credential path and logs a startup warning. Optional so
    // existing deploys keep working until they provision the credential.
    AUDIT_ADMIN_DATABASE_URL: z
      .string()
      .optional()
      .refine(
        (v) => !v || v.startsWith('postgres://') || v.startsWith('postgresql://'),
        { message: 'AUDIT_ADMIN_DATABASE_URL must be a valid postgres:// or postgresql:// URL' },
      )
      .describe('Optional dedicated connection for the breeze_audit_admin role (audit retention worker, issue #915). If unset, retention uses the legacy breeze_app + SET ROLE path.'),

    JWT_SECRET: z
      .string({ error: 'JWT_SECRET is required' })
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
      .string({ error: 'APP_ENCRYPTION_KEY is required' })
      .min(1, 'APP_ENCRYPTION_KEY must not be empty'),

    // Active key id for AAD-bound `enc:v2`/`enc:v3` ciphertext
    // (services/secretCrypto.ts). Optional: a deployment without it seals to
    // non-AAD `enc:v1`, which is the shipped default. It becomes REQUIRED once
    // M365_GRAPH_ACTIONS_TOOLS_ENABLED is on — see the superRefine rule below.
    APP_ENCRYPTION_KEY_ID: z.string().optional(),

    MFA_ENCRYPTION_KEY: z
      .string({ error: 'MFA_ENCRYPTION_KEY is required' })
      .min(1, 'MFA_ENCRYPTION_KEY must not be empty'),

    PARTNER_API_CURSOR_SIGNING_KEY: z.string().optional(),

    // -- Production-required -------------------------------------------------
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    FORCE_HTTPS: z.string().optional(),
    // Security remediation Wave 5, Task 8 (TRANSPORT-001): PUBLIC_API_URL is
    // the ONLY source for the canonical HTTPS redirect Location
    // (services/requestTransport.ts) — inbound Host is never trusted or
    // reflected. Shape is only checked when FORCE_HTTPS=true (see the
    // superRefine block below); PUBLIC_API_URL is used unvalidated in many
    // other places (installer links, agent enrollment, etc.) when
    // FORCE_HTTPS is off, so this must not retroactively boot-refuse existing
    // deployments that don't force HTTPS.
    PUBLIC_API_URL: z.string().optional(),
    TRUST_PROXY_HEADERS: z.string().optional(),
    // Whether CF-Connecting-IP is trusted for client-IP resolution
    // (services/clientIp.ts). Boolean-ish; unset/empty means off. Format is
    // guarded in the superRefine below so a typo can't silently read as "off"
    // and strip client-IP attribution from rate limits, audit logs and IP
    // allowlists. collectWarnings() additionally warns in production when proxy
    // trust is on and this is off (SR2-16).
    TRUST_CF_CONNECTING_IP: z.string().optional(),
    TRUSTED_PROXY_CIDRS: z.string().optional(),
    AGENT_ENROLLMENT_SECRET: z.string().optional(),
    ENROLLMENT_KEY_PEPPER: z.string().optional(),
    MFA_RECOVERY_CODE_PEPPER: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
    BREEZE_BOOTSTRAP_ADMIN_NAME: z.string().optional(),
    BINARY_SOURCE: z.string().optional(),
    // "self-host" (default, today's behavior) | "hosted". A hosted deployment
    // must fail closed onto local binaries rather than ever falling back to
    // the public GitHub release — see the production validation block below
    // and services/binaryEdition.ts / services/binarySync.ts.
    BINARY_EDITION: z.string().optional(),
    // BYO signing (spec 3a): the release-source repository override consumed by
    // services/releaseSource.ts. Empty string means "unset" — both compose
    // files map it as `${BINARY_GITHUB_REPOSITORY:-}`, which always injects the
    // key. Shape is validated in EVERY environment so a typo'd override
    // boot-refuses instead of silently building garbage GitHub URLs.
    BINARY_GITHUB_REPOSITORY: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        // Shared with the runtime resolver so boot validation and
        // getReleaseSourceRepository() can never drift apart.
        .refine(
          isValidReleaseSourceRepository,
          `BINARY_GITHUB_REPOSITORY must be ${RELEASE_SOURCE_REPOSITORY_SHAPE}`,
        )
        .optional(),
    ),
    GITHUB_REPO: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        // Shared with the runtime resolver so boot validation and
        // getReleaseSourceRepository() can never drift apart.
        .refine(
          isValidReleaseSourceRepository,
          `GITHUB_REPO must be ${RELEASE_SOURCE_REPOSITORY_SHAPE}`,
        )
        .optional(),
    ),
    RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: z.string().optional(),
    BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: z.string().optional(),
    IS_HOSTED: z.string().optional(),
    AGENT_BACKUP_SERVER_URL: z.string().optional(),

    // Controlled agent-fleet rollout (decouple registration from promotion).
    // When false, binarySync registers new binaries WITHOUT touching
    // agent_versions.isLatest — the fleet upgrade target only changes via
    // POST /agent-versions/promote. Defaults TRUE (preserve current behavior:
    // sync = instant fleet upgrade target). Read at runtime by
    // getAgentAutoPromote(); validated here only for boolean format so a typo
    // is caught at boot instead of silently parsing to a surprising default.
    AGENT_AUTO_PROMOTE: z.string().optional(),

    // Automatic agent edition migration (#4072). Default false; read at
    // runtime by editionAutoMigrateEnabled() (services/agentEditionAutoMigrate.ts)
    // via envFlag(). Validated here for boolean format only, same class as
    // AGENT_AUTO_PROMOTE above — a typo must fail boot, not silently read as
    // "off" for an operator who believed they enabled auto-remediation.
    AGENT_EDITION_AUTO_MIGRATE_ENABLED: z.string().optional(),

    // Signup-abuse detection kill switch / opt-in (services/abuseSignals).
    // Defaults to IS_HOSTED; read at runtime by abuseSignalsEnabled() in
    // env.ts. Validated here for boolean format only, for the same reason as
    // AGENT_AUTO_PROMOTE above — see the superRefine rule for why a typo here
    // is worse than a typo on most flags.
    ABUSE_SIGNALS_ENABLED: z.string().optional(),

    // Durable event dispatch (wave 3.5c, #4085). off = today's in-process
    // delivery only; shadow = mirror routing plans into receipts without
    // executing via the queue; enforce = the EVENT_DISPATCH_QUEUE_SUBSCRIBERS
    // cohort delivers via BullMQ only. Read at runtime by eventDispatchMode()
    // / eventDispatchQueueSubscribers() in env.ts. Validated here for
    // vocabulary/membership — see the superRefine rule below.
    EVENT_DISPATCH_MODE: z.string().optional(),
    EVENT_DISPATCH_QUEUE_SUBSCRIBERS: z.string().optional(),

    // Wave 5 Part B (#3827) sub-flag of BREEZE_AI_AGENTS_ENABLED. Gates
    // attemptPolicyDecision — read at runtime by policyDecideEnabled() in
    // env.ts. Validated here for boolean format only, same class as
    // AGENT_AUTO_PROMOTE above.
    BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED: z.string().optional(),

    // Process role for the 3.5d socket/worker split (wave 3.5b, #4084). all
    // (default) = today's all-in-one process. Read at runtime by
    // breezeRole() in env.ts. Validated here for format only — absence means
    // 'all', and this is NOT required-in-production in this wave (that lands
    // with 3.5d once the split is actually exercised in prod topology).
    BREEZE_ROLE: z.string().optional(),

    // M365 Tier-3 write-action AI tools (m365_disable_user, m365_reset_password)
    // and the action-intents release worker's headless dispatch. Dark by
    // default. Read at runtime by writeActionRuntimeConfig.ts; declared here so
    // the format is guarded (a typo reads as OFF at the runtime flag parser,
    // silently disabling the tools an operator believed they had enabled) and so
    // the APP_ENCRYPTION_KEY_ID pairing rule below is schema-derived.
    M365_GRAPH_ACTIONS_TOOLS_ENABLED: z.string().optional(),

    // MFA feature flag. When false, ALL requireMfa() gates become no-ops.
    // Warning is emitted in collectWarnings; we do NOT refuse boot (a
    // self-hosted operator may deliberately run 2FA-off).
    ENABLE_2FA: z.string().optional(),

    // SSO domain verification enforcement. When 'true', EVERY org is required to
    // verify its domain before SSO login is allowed. When unset or 'false', enforcement
    // is gradual: only orgs that already have a verified domain are gated.
    SSO_DOMAIN_VERIFICATION_STRICT: z.string().optional(),

    // OAuth Dynamic Client Registration (DCR) hardening. All default OFF.
    // See env.ts and provider.ts for the runtime read-paths; the
    // production-only validation in superRefine refuses boot when
    // OAUTH_DCR_ENABLED=true with neither OAUTH_DCR_REQUIRE_IAT=true nor
    // OAUTH_DCR_ALLOW_ANONYMOUS=true (no anti-spam posture chosen).
    OAUTH_DCR_ENABLED: z.string().optional(),
    OAUTH_DCR_REQUIRE_IAT: z.string().optional(),
    OAUTH_DCR_ALLOW_ANONYMOUS: z.string().optional(),

    // Wave 3 live-authorization rollout controls. Shape is validated in EVERY
    // environment (a garbage value is a bug anywhere); presence is required in
    // production only. Enforced here rather than at config/env.ts import time:
    // that module is imported by this validator and by every job/script, so a
    // module-scope throw there would preempt this aggregated report and break
    // unrelated processes that never touch OAuth or event sockets.
    OAUTH_AUTH_EPOCH_ENFORCE_AFTER: z.string().optional(),
    EVENT_PERMISSION_EPOCH_MODE: z.string().optional(),

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

    // Stripe payments (billing) — feature dormant unless set. Per-partner API-key
    // model: partners paste their own key (no Connect OAuth), so STRIPE_CONNECT_CLIENT_ID
    // and STRIPE_OAUTH_REDIRECT_URL are gone. STRIPE_WEBHOOK_SECRET is retained for the
    // (legacy) inbound webhook signature check.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // QuickBooks Online accounting connection foundation. These are optional
    // at boot because Phase A validates them lazily when a partner starts the
    // OAuth connect flow; missing values should not disable unrelated API use.
    QBO_CLIENT_ID: z.string().optional(),
    QBO_CLIENT_SECRET: z.string().optional(),
    QBO_REDIRECT_URI: z.string().optional(),
    QBO_ENVIRONMENT: z.string().optional(),
    // Optional at boot: only the webhook route needs it to verify inbound CDC
    // signatures, and a region without the Intuit webhook configured relies
    // on the 15-minute reconcile sweep instead.
    QBO_WEBHOOK_VERIFIER_TOKEN: z.string().optional(),

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
    AUTH_BROWSER_TRANSITIONS_ENFORCED: z.string().optional(),
    AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED: z.string().optional(),

    // -- Native APNs push (replaces the Expo push relay) ---------------------
    // All optional at boot: push is an optional feature. If ANY APNS_* is set,
    // the superRefine "all-or-none" block below requires the four credential
    // fields (key/kid/team/bundle); APNS_ENVIRONMENT stays optional and
    // defaults to 'production' at the sender. APNS_AUTH_KEY holds the raw .p8
    // PEM contents and may contain literal "\n" escapes (env files can't carry
    // real newlines); the sender normalizes them before importPKCS8.
    APNS_AUTH_KEY: z.string().optional(),
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    // Empty string means "unset", matching the trim() semantics the all-or-none
    // block uses. Compose maps this as `${APNS_ENVIRONMENT:-}`, which always
    // injects the key — as "" when the operator hasn't set it — and a bare
    // `.optional()` enum rejects "" and refuses to boot. The string fields above
    // tolerate "" natively; only the enum needs this.
    APNS_ENVIRONMENT: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['sandbox', 'production']).optional()
    ),

    // -- Optional with defaults -----------------------------------------------
    API_PORT: portSchema,
    REDIS_URL: z.string().default('redis://localhost:6379'),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.string().optional(),
    REDIS_PASSWORD_FILE: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PARTNER_HOOKS_URL: z.string().url().optional(),
    PARTNER_HOOKS_SECRET: z.string().min(16).optional(),
    // Empty string means "unset" — same reason as APNS_ENVIRONMENT above: both
    // compose files map this as `${IP_ALLOWLIST_ENFORCEMENT_MODE:-}`, so the key
    // is ALWAYS injected, as "" when the operator hasn't set it. This enum only
    // started being enforced in #2896 (before that the value never reached the
    // parser at all), so without the preprocess every stack that leaves the
    // variable unset would refuse to boot on upgrade.
    IP_ALLOWLIST_ENFORCEMENT_MODE: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['enforce', 'off']).default('enforce'),
    ),

    // Security remediation Wave 5, Task 6 — the agent certificate/device
    // binding compatibility mode (services/agentCertificateBinding.ts),
    // shared by agent REST auth and the command WebSocket. Defaults to `off`
    // (NOT `enforce`, unlike IP_ALLOWLIST_ENFORCEMENT_MODE above) so an
    // unconfigured production deploy keeps booting exactly as before this
    // feature landed; an explicit but INVALID value still boot-refuses below
    // rather than silently falling back. Deliberately absent from
    // .env.example — see envComposeParity.test.ts's guard, which would then
    // require Compose wiring this task does not scope.
    AGENT_MTLS_BINDING_MODE: z.enum(['off', 'audit', 'enforce']).default('off'),

    // Security remediation Wave 6, Task 9 — agent manifest-signing-key-ID
    // requirement (routes/agents/heartbeat.ts pushes
    // configUpdate.require_manifest_signing_key_id=true ONLY when this is
    // explicitly 'true'). Defaults to false so a rolling deploy or a server
    // rollback stays compatible with agents that predate exact-key-ID
    // verification (Wave 6 Task 6/7). Strict two-value enum (not a free
    // `.optional()` string) so a typo boot-refuses instead of silently
    // staying on the safe default — see docs/operations/agent-network-and-manifest-rollout.md.
    AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID: z.enum(['true', 'false']).default('false'),

    // Phase 2 of per-partner LLM BYOK (#3922), Task 3.1 — gates catalog-mode
    // routing (partner_llm_configs.catalog_entry_id). Off by default so a
    // rolling deploy or rollback never exposes catalog selection ahead of
    // the resolver/route wiring that consumes it (Tasks 3.2+). When false,
    // selection-write routes 404 and existing catalog configs resolve as
    // unavailable('catalog_disabled') — fail-loud, never a silent fallback
    // to direct Anthropic. Strict two-value enum so a typo boot-refuses
    // instead of silently staying on the safe default.
    LLM_PROVIDER_CATALOG_ENABLED: z.enum(['true', 'false']).default('false'),

    // Security remediation Wave 6, Task 9 (approved plan deviation D1) — the
    // managed-software destination gate (services/managedSoftwareDispatchPolicy.ts).
    //   compat (default): a private destination still requires agent
    //     capability >= 1 and fails closed — that is the security fix, on
    //     from the first deploy. An apparently-public destination stays
    //     permitted to a capability-0 device so deploy day does not fail
    //     every in-flight software push to a not-yet-upgraded fleet.
    //   enforce: every managed-software command requires capability >= 1,
    //     public destinations included — the end state once the fleet has
    //     upgraded.
    // The runtime reader (getManagedSoftwarePolicyMode()) treats any
    // unset/unrecognized value as compat, by design, so a misconfiguration
    // can never silently take software deployment down. This schema still
    // boot-refuses an explicit typo/garbage value rather than silently
    // accepting it — the exact #2896 class of gap this task closes for both
    // of its own variables.
    MANAGED_SOFTWARE_POLICY_MODE: z.enum(['compat', 'enforce']).default('compat'),

    // -- Email-to-ticket ingest (Phase 4) ------------------------------------
    // Both optional. If MAILGUN_INBOUND_SIGNING_KEY is unset, `verify()` returns
    // false and the webhook responds 401 (permanent — the provider does NOT retry).
    // TICKETS_INBOUND_DOMAIN gates the slug-address resolver.
    MAILGUN_INBOUND_SIGNING_KEY: z.string().optional(),
    TICKETS_INBOUND_DOMAIN: z.string().optional(),

    // -- Anthropic-compatible backend override (#1412) -----------------------
    // Self-hosted operators can point the AI Agent at any Anthropic
    // /v1/messages-dialect backend (local vLLM 0.23+, a LiteLLM gateway) while
    // keeping full tool-use + the aiGuardrails stack — the SDK already honors
    // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN. Validated as http(s) and
    // fail-closed when IS_HOSTED=true (see superRefine) so a stray value can
    // never redirect the platform's AI traffic. ANTHROPIC_MODEL overrides the
    // default model id for raw vLLM (no LiteLLM alias).
    ANTHROPIC_BASE_URL: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),

    // -- Alternative LLM backend (openai-compatible, e.g. vLLM) ---------------
    // Off by default. Chat-only PoC; tool-calling is not supported on this path.
    MCP_LLM_PROVIDER: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
    MCP_LLM_BASE_URL: z.string().url().optional(),
    MCP_LLM_API_KEY: z.string().optional(),
    MCP_LLM_MODEL: z.string().optional(),
    MCP_LLM_PRICE_INPUT_PER_M_USD: z.string().optional().transform((v) => (v ? parseFloat(v) : 0)).pipe(z.number().min(0)),
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: z.string().optional().transform((v) => (v ? parseFloat(v) : 0)).pipe(z.number().min(0)),
  });

const envSchema = envObjectSchema
  // --- Cross-field refinements (insecure defaults for required secrets) -------
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';

    if (
      isProduction
      && !data.DATABASE_URL_APP?.trim()
      && !data.BREEZE_APP_DB_PASSWORD?.trim()
      && !data.POSTGRES_PASSWORD?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL_APP'],
        message:
          'Production requires DATABASE_URL_APP, BREEZE_APP_DB_PASSWORD, or POSTGRES_PASSWORD to configure the unprivileged request database role.',
      });
    }

    // #2288 — instance-level backup control-plane URL pushed to agents.
    // Malformed value = refuse to boot; a silently-dropped backup URL would
    // defeat the whole failover story exactly when it's needed.
    const backupUrlRaw = (data.AGENT_BACKUP_SERVER_URL ?? '').trim();
    if (backupUrlRaw) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(backupUrlRaw);
      } catch {
        parsed = null;
      }
      const isLoopback =
        parsed !== null &&
        ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
      const ok =
        parsed !== null &&
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback));
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_BACKUP_SERVER_URL'],
          message:
            'AGENT_BACKUP_SERVER_URL must be a valid https:// URL (http:// allowed only for localhost)',
        });
      }
    }

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

    // ANTHROPIC_BASE_URL (#1412): when set it must be a well-formed http(s)
    // URL, and it is fail-closed — permitted ONLY when self-host is
    // affirmatively declared (IS_HOSTED explicitly false/0/no/off). Unset /
    // empty / garbage / truthy IS_HOSTED all refuse it, so a stray value (or an
    // unmapped IS_HOSTED — the #570 footgun) can never redirect platform AI
    // traffic to a third-party endpoint. Enforced in every environment so a
    // misconfig is caught at boot, not at first AI request.
    const anthropicBaseUrl = data.ANTHROPIC_BASE_URL?.trim();
    if (anthropicBaseUrl) {
      if (!isRecognizedSelfHostSignal(data.IS_HOSTED)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ANTHROPIC_BASE_URL'],
          message:
            'ANTHROPIC_BASE_URL is a self-hosted-only feature and is refused unless self-host is '
            + 'affirmatively declared. Set IS_HOSTED explicitly to false (or 0/no/off) to use it. '
            + 'On the hosted platform — or with IS_HOSTED unset/invalid — it is refused so a stray '
            + 'value cannot route platform AI traffic to a third-party endpoint.',
        });
      }
      let parsedUrl: URL | null = null;
      try {
        parsedUrl = new URL(anthropicBaseUrl);
      } catch {
        parsedUrl = null;
      }
      if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ANTHROPIC_BASE_URL'],
          message:
            'ANTHROPIC_BASE_URL must be a well-formed http(s) URL (e.g. http://localhost:8000 or '
            + 'https://litellm.internal/v1).',
        });
      }
    }

    // PUBLIC_API_URL canonical form (Wave 5, Task 8 — TRANSPORT-001): the
    // force-HTTPS redirect (services/requestTransport.ts) builds its
    // Location ONLY from PUBLIC_API_URL, never from inbound Host. That
    // guarantee is only as good as PUBLIC_API_URL itself, so when
    // FORCE_HTTPS=true it must be unambiguous: https, no embedded
    // credentials (userinfo would either leak into every redirect or get
    // silently dropped depending on the client), and no query/fragment
    // (those would duplicate or get clobbered on every redirect since only
    // the request's OWN path/query are carried over). Gated purely on
    // FORCE_HTTPS=true, not NODE_ENV/isProduction — PUBLIC_API_URL is used
    // unvalidated in many other places when FORCE_HTTPS is off, so this must
    // never retroactively boot-refuse an existing deployment that doesn't
    // force HTTPS.
    {
      const forceHttpsNormalized = (data.FORCE_HTTPS ?? '').trim().toLowerCase();
      const isForceHttpsEnabled = forceHttpsNormalized === 'true' || forceHttpsNormalized === '1';
      if (isForceHttpsEnabled) {
        const publicApiUrlRaw = data.PUBLIC_API_URL?.trim();
        if (!publicApiUrlRaw) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['PUBLIC_API_URL'],
            message:
              'PUBLIC_API_URL is required when FORCE_HTTPS=true — the canonical HTTPS redirect Location is built from it alone.',
          });
        } else {
          let parsedPublicApiUrl: URL | null = null;
          try {
            parsedPublicApiUrl = new URL(publicApiUrlRaw);
          } catch {
            parsedPublicApiUrl = null;
          }
          if (!parsedPublicApiUrl) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['PUBLIC_API_URL'],
              message: 'PUBLIC_API_URL must be a well-formed URL when FORCE_HTTPS=true.',
            });
          } else {
            if (parsedPublicApiUrl.protocol !== 'https:') {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PUBLIC_API_URL'],
                message: 'PUBLIC_API_URL must use https:// when FORCE_HTTPS=true.',
              });
            }
            if (parsedPublicApiUrl.username || parsedPublicApiUrl.password) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PUBLIC_API_URL'],
                message: 'PUBLIC_API_URL must not contain a username or password when FORCE_HTTPS=true.',
              });
            }
            if (parsedPublicApiUrl.search) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PUBLIC_API_URL'],
                message: 'PUBLIC_API_URL must not contain a query string when FORCE_HTTPS=true.',
              });
            }
            if (parsedPublicApiUrl.hash) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PUBLIC_API_URL'],
                message: 'PUBLIC_API_URL must not contain a fragment when FORCE_HTTPS=true.',
              });
            }
          }
        }
      }
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

    // Wave 3 live-authorization rollout controls. Shape checked everywhere,
    // presence required in production. See the helper for why this cannot live
    // at config/env.ts import time.
    validateLiveAuthorizationRolloutConfig(data, isProduction, ctx);

    // --- Required secrets: reject insecure values in production only ---
    if (isProduction) {
      const cursorSigningKey = decodePartnerApiCursorSigningKey(data.PARTNER_API_CURSOR_SIGNING_KEY);
      if (!cursorSigningKey || cursorSigningKey.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PARTNER_API_CURSOR_SIGNING_KEY'],
          message:
            'PARTNER_API_CURSOR_SIGNING_KEY must decode to at least 32 bytes of random key material from canonical base64 in production.',
        });
      }
      if (cursorSigningKey?.equals(Buffer.from(data.JWT_SECRET, 'utf8'))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PARTNER_API_CURSOR_SIGNING_KEY'],
          message:
            'PARTNER_API_CURSOR_SIGNING_KEY must not reuse UTF-8 JWT_SECRET key material. Generate a dedicated random key.',
        });
      }

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

      // BYO signing (spec 3a): pointing the deployment at a NON-official
      // release repository only makes sense with a manifest trust root that is
      // the OVERRIDING repository's release key — without one, github-mode
      // sync would either fail closed on every release or (if the blanket
      // production key rule above were ever relaxed) accept unverified
      // third-party binaries. Kept as its own rule with its own message even
      // though the blanket rule currently subsumes the "unset" case.
      const releaseRepositoryOverrideKey = data.BINARY_GITHUB_REPOSITORY
        ? 'BINARY_GITHUB_REPOSITORY'
        : 'GITHUB_REPO';
      const releaseRepositoryOverride = (
        data.BINARY_GITHUB_REPOSITORY ?? data.GITHUB_REPO
      )?.trim().toLowerCase();
      if (
        releaseRepositoryOverride &&
        releaseRepositoryOverride !== OFFICIAL_RELEASE_REPOSITORY &&
        !hasReleaseArtifactManifestPublicKey(data)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [releaseRepositoryOverrideKey],
          message:
            `${releaseRepositoryOverrideKey} overrides the release source; production requires RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS to be set to the overriding repository's release manifest public key (NOT the official Breeze key).`,
        });
      }

      // BYO signing edition follow-up: a "hosted" deployment must never serve
      // binaries pulled from the public GitHub release (that release now
      // carries the self-host edition, unsigned by default). In production
      // that only holds if binaries come exclusively from the local volume
      // (BINARY_SOURCE=local — binarySync.ts's GitHub fallbacks are disabled
      // for edition=hosted, but the primary BINARY_SOURCE=github sync path
      // is not, so this is the boot-time backstop) AND a manifest trust root
      // is configured, so whatever manifest IS found in the local volume can
      // be verified rather than trusted blindly.
      const binaryEdition = (data.BINARY_EDITION || 'self-host').trim().toLowerCase();
      if (binaryEdition === 'hosted') {
        const binarySourceForEdition = (data.BINARY_SOURCE || 'github').trim().toLowerCase();
        if (binarySourceForEdition !== 'local') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BINARY_SOURCE'],
            message:
              'BINARY_EDITION=hosted requires BINARY_SOURCE=local in production — a hosted deployment must never serve binaries fetched from the public GitHub release.',
          });
        }
        if (!hasReleaseArtifactManifestPublicKey(data)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS'],
            message:
              'BINARY_EDITION=hosted requires RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS to be set in production, so any release manifest found in the local binaries volume can be verified before being trusted.',
          });
        }
      }

      // "NOT the official Breeze key" above has to be enforced, not just
      // stated. deploy/.env.example ships the official key as an ACTIVE line
      // directly above the BINARY_GITHUB_REPOSITORY hint, so leaving it in
      // place while repointing is the default mistake, not an exotic one — and
      // it fails closed silently at sync time rather than loudly at boot.
      if (
        releaseRepositoryOverride &&
        releaseRepositoryOverride !== OFFICIAL_RELEASE_REPOSITORY &&
        hasOnlyOfficialReleaseManifestPublicKey(data)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS'],
          message:
            `${releaseRepositoryOverrideKey} points at a non-official release repository, but RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS is still (only) the official Breeze key. Manifests from that repository are signed by YOUR release key and can never verify under the official one, so every sync would fail closed and the fleet would silently stay on its current version. Set it to your own manifest public key — the signing workflow's run summary prints it.`,
        });
      }

      rejectSecretReuse(
        [
          { key: 'JWT_SECRET', value: data.JWT_SECRET },
          { key: 'PARTNER_API_CURSOR_SIGNING_KEY', value: data.PARTNER_API_CURSOR_SIGNING_KEY },
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
      // When DCR is enabled in production it must declare an anti-spam posture,
      // EITHER require an initial-access-token (OAUTH_DCR_REQUIRE_IAT=true) OR
      // deliberately allow anonymous registration (OAUTH_DCR_ALLOW_ANONYMOUS=
      // true). Anonymous DCR is the ONLY registration path public MCP clients
      // (Claude Desktop / claude.ai) can use — the IAT gate blocks them — so a
      // public MCP server sets OAUTH_DCR_ALLOW_ANONYMOUS and relies on the
      // compensating controls on /oauth/reg (per-IP rate limit, forced public
      // clients, PKCE S256, software_id rejection, daily stale-client GC).
      // Boot-refuse only the "DCR=true but neither posture chosen" misconfig so
      // an accidental deploy can't open an ungated registration endpoint.
      const dcrEnabledRaw = (data.OAUTH_DCR_ENABLED ?? '').trim().toLowerCase();
      const dcrRequireIatRaw = (data.OAUTH_DCR_REQUIRE_IAT ?? '').trim().toLowerCase();
      const dcrAllowAnonRaw = (data.OAUTH_DCR_ALLOW_ANONYMOUS ?? '').trim().toLowerCase();
      const dcrEnabled = ['true', '1', 'yes', 'on'].includes(dcrEnabledRaw);
      const dcrRequireIat = ['true', '1', 'yes', 'on'].includes(dcrRequireIatRaw);
      const dcrAllowAnon = ['true', '1', 'yes', 'on'].includes(dcrAllowAnonRaw);
      if (dcrEnabled && !dcrRequireIat && !dcrAllowAnon) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OAUTH_DCR_REQUIRE_IAT'],
          message:
            'When OAUTH_DCR_ENABLED=true in production you must set EITHER OAUTH_DCR_REQUIRE_IAT=true (gate registration behind an initial-access-token) OR OAUTH_DCR_ALLOW_ANONYMOUS=true (deliberately permit anonymous DCR — required for public MCP clients like Claude, which cannot supply an IAT). Setting neither leaves POST /oauth/reg ungated by accident.',
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
      //                      S3_BUCKET, CLOUDFLARE_API_TOKEN
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
        const teamDomain = data.CF_ACCESS_TEAM_DOMAIN ?? '';
        if (!teamDomain) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_TEAM_DOMAIN'],
            message:
              'CF_ACCESS_TEAM_DOMAIN is required when CF_ACCESS_TRUST_ENABLED is true (e.g. example.cloudflareaccess.com, no scheme).',
          });
        } else if (!canonicalCfAccessTeamDomain(teamDomain)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CF_ACCESS_TEAM_DOMAIN'],
            message:
              'CF_ACCESS_TEAM_DOMAIN must be the canonical lowercase bare Cloudflare team hostname (e.g. example.cloudflareaccess.com), with no credentials, port, path, query, or fragment.',
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

    const authTransitionFlagValues = new Set([
      'true', 'false', '1', '0', 'yes', 'no', 'on', 'off',
    ]);
    const transitionsRaw = (data.AUTH_BROWSER_TRANSITIONS_ENFORCED ?? '').trim().toLowerCase();
    const terminalPreparationRaw = (
      data.AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED ?? ''
    ).trim().toLowerCase();
    for (const [name, value] of [
      ['AUTH_BROWSER_TRANSITIONS_ENFORCED', transitionsRaw],
      ['AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED', terminalPreparationRaw],
    ] as const) {
      if (value && !authTransitionFlagValues.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must be a boolean (true/false, 1/0, yes/no, on/off) when set.`,
        });
      }
    }
    const flagEnabled = (value: string) => ['true', '1', 'yes', 'on'].includes(value);
    if (flagEnabled(terminalPreparationRaw) && !flagEnabled(transitionsRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED'],
        message:
          'AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true requires AUTH_BROWSER_TRANSITIONS_ENFORCED=true.',
      });
    }

    // AGENT_AUTO_PROMOTE (controlled fleet rollout). Independent of NODE_ENV —
    // the value silently governs whether a sync promotes the fleet, so a typo
    // (e.g. AGENT_AUTO_PROMOTE=falze, which parses as truthy → still
    // auto-promotes) must be caught at boot rather than surprising an operator
    // who believed they had disabled auto-promotion. Empty/unset is allowed
    // (defaults to true). Mirrors getAgentAutoPromote() in binarySource.ts.
    const autoPromoteRaw = (data.AGENT_AUTO_PROMOTE ?? '').trim().toLowerCase();
    const boolValues = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
    if (autoPromoteRaw && !boolValues.has(autoPromoteRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_AUTO_PROMOTE'],
        message:
          'AGENT_AUTO_PROMOTE must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to true (sync immediately becomes the fleet upgrade target). Set false to require explicit promotion via POST /agent-versions/promote.',
      });
    }

    // AGENT_EDITION_AUTO_MIGRATE_ENABLED (auto edition migration, #4072).
    // Same treatment and reasoning as AGENT_AUTO_PROMOTE above.
    const autoMigrateRaw = (data.AGENT_EDITION_AUTO_MIGRATE_ENABLED ?? '').trim().toLowerCase();
    if (autoMigrateRaw && !boolValues.has(autoMigrateRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_EDITION_AUTO_MIGRATE_ENABLED'],
        message:
          'AGENT_EDITION_AUTO_MIGRATE_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. ' +
          'Defaults to false (no automatic edition-migration dispatch).',
      });
    }

    // ABUSE_SIGNALS_ENABLED (signup-abuse detection). Same treatment and same
    // reasoning as AGENT_AUTO_PROMOTE above: independent of NODE_ENV, because
    // the value silently governs whether the subsystem runs at all. A typo
    // (ABUSE_SIGNALS_ENABLED=ture / =enabled) used to read as "off" on the
    // envFlag path, so an operator who believed they had detection ENABLED got
    // a hosted deployment quietly not policing its signups — and the only
    // artifact was one `[AbuseSignals] Disabled` line at boot. abuseSignalsEnabled()
    // now falls back to the IS_HOSTED default on such a value, but the boot
    // refusal here is what actually surfaces the typo to the operator.
    // Empty/unset is allowed: both compose files inject
    // `${ABUSE_SIGNALS_ENABLED:-}`, so "" is the common case and means unset
    // (defaults to IS_HOSTED). Mirrors abuseSignalsEnabled() in env.ts.
    const abuseSignalsRaw = (data.ABUSE_SIGNALS_ENABLED ?? '').trim().toLowerCase();
    if (abuseSignalsRaw && !boolValues.has(abuseSignalsRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABUSE_SIGNALS_ENABLED'],
        message:
          'ABUSE_SIGNALS_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to the value of IS_HOSTED — signup-abuse detection is ON for a hosted deployment and OFF for a self-hosted one. Set true to opt a self-hosted multi-tenant service in, or false to switch a hosted deployment off.',
      });
    }

    // EVENT_DISPATCH_MODE / EVENT_DISPATCH_QUEUE_SUBSCRIBERS (durable event
    // dispatch, wave 3.5c, #4085). Unlike ABUSE_SIGNALS_ENABLED above, an
    // unrecognized mode is a HARD error here, not a warning-and-fallback: boot
    // refusal beats a silent fallback in prod, because eventDispatchMode()'s
    // fallback-to-off is the reader's last line of defense for a process that
    // skipped this validator, not a substitute for catching the typo here.
    const eventDispatchModeRaw = (data.EVENT_DISPATCH_MODE ?? '').trim().toLowerCase();
    const eventDispatchModeValues = new Set(['', 'off', 'shadow', 'enforce']);
    if (!eventDispatchModeValues.has(eventDispatchModeRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENT_DISPATCH_MODE'],
        message:
          'EVENT_DISPATCH_MODE must be one of off, shadow, enforce (or unset, which defaults to off) — see eventDispatchMode() in env.ts.',
      });
    }
    const eventDispatchSubscribersRaw = (data.EVENT_DISPATCH_QUEUE_SUBSCRIBERS ?? '').trim();
    const eventDispatchSubscriberIds = eventDispatchSubscribersRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const id of eventDispatchSubscriberIds) {
      if (!isSubscriberId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EVENT_DISPATCH_QUEUE_SUBSCRIBERS'],
          message: `EVENT_DISPATCH_QUEUE_SUBSCRIBERS contains unknown subscriber id "${id}" — known ids: ${EVENT_SUBSCRIBER_IDS.join(', ')}.`,
        });
      }
    }
    // enforce with an empty cohort is not an error — it degenerates to
    // "everyone stays local", same as off — but is very likely a
    // misconfiguration (the operator meant to enforce SOMETHING), so warn.
    if (eventDispatchModeRaw === 'enforce' && eventDispatchSubscriberIds.length === 0) {
      console.warn(
        '[config] EVENT_DISPATCH_MODE=enforce but EVENT_DISPATCH_QUEUE_SUBSCRIBERS is empty — no subscriber will deliver via the queue.',
      );
    }

    // BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED (wave 5 Part B, #3827). Sub-flag
    // of BREEZE_AI_AGENTS_ENABLED gating attemptPolicyDecision — unattended
    // policy-decided authorization of a supervised-scope action-intent, no
    // human fanout. Same treatment as AGENT_AUTO_PROMOTE/ABUSE_SIGNALS_ENABLED
    // above: a typo must be caught at boot rather than silently reading as
    // off at the envFlag reader. Empty/unset is allowed (defaults to false —
    // dark-ship). Mirrors policyDecideEnabled() in env.ts.
    const policyDecideRaw = (data.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED ?? '').trim().toLowerCase();
    if (policyDecideRaw && !boolValues.has(policyDecideRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED'],
        message:
          'BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (unattended policy-decided authorization is dark).',
      });
    }

    // TRUST_CF_CONNECTING_IP. Same class as the two flags above: the runtime
    // reader (services/clientIp.ts) treats any unrecognized value as OFF, so a
    // typo on a Cloudflare-fronted deploy silently resolves every client IP from
    // X-Forwarded-For instead of the edge IP — rate limits, audit logs and
    // partner IP allowlists all key off the wrong address. Empty/unset is
    // allowed: both compose files inject the key unconditionally
    // (`${TRUST_CF_CONNECTING_IP:-}` in docker-compose.yml, `${…:-true}` in
    // deploy/docker-compose.prod.yml), so "" is what many stacks actually pass.
    const trustCfRaw = (data.TRUST_CF_CONNECTING_IP ?? '').trim().toLowerCase();
    if (trustCfRaw && !boolValues.has(trustCfRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_CF_CONNECTING_IP'],
        message:
          'TRUST_CF_CONNECTING_IP must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (CF-Connecting-IP is ignored). Set true only when the deployment really is behind Cloudflare.',
      });
    }

    // M365_GRAPH_ACTIONS_TOOLS_ENABLED format guard + the APP_ENCRYPTION_KEY_ID
    // pairing rule. The reveal path for m365_reset_password seals its temporary
    // credential with AAD-bound v3 ciphertext and fails CLOSED without a key id,
    // so the credential would be dropped and never revealable — turn that into a
    // boot refusal. Lives here (rather than as a separate post-parse throw in
    // validateConfig) so both keys are schema-declared and the failure joins the
    // aggregated configuration-error report instead of short-circuiting it.
    const graphActionsRaw = (data.M365_GRAPH_ACTIONS_TOOLS_ENABLED ?? '').trim().toLowerCase();
    if (graphActionsRaw && !boolValues.has(graphActionsRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['M365_GRAPH_ACTIONS_TOOLS_ENABLED'],
        message:
          'M365_GRAPH_ACTIONS_TOOLS_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (Tier-3 M365 write-action tools are dark).',
      });
    }
    if (
      ['true', '1', 'yes', 'on'].includes(graphActionsRaw)
      && !data.APP_ENCRYPTION_KEY_ID?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_ENCRYPTION_KEY_ID'],
        message:
          'APP_ENCRYPTION_KEY_ID is required when M365_GRAPH_ACTIONS_TOOLS_ENABLED=true (write-action reveal credentials are sealed with AAD-bound v3 ciphertext).',
      });
    }

    // BREEZE_ROLE ↔ APP_ENCRYPTION_KEY_ID pairing (wave 3.5b, #4084). Once a
    // process is split into 'api' or 'worker', cross-process agent command
    // dispatch goes through agentCommandRelay.ts, which seals every relay job
    // with AAD-bound v3 ciphertext and REFUSES to seal without a configured
    // key id (sealRelayCommand throws rather than silently degrading to the
    // AAD-ignoring v1 fallback). Without this check, a 'api'/'worker' split
    // deployment boots clean and then fails every single relay dispatch at
    // runtime with zero boot-time signal — turn that into a boot refusal, same
    // shape as the M365 pairing rule above. 'all' (default) is unaffected: it
    // never takes the relay branch for a locally-connected agent.
    const breezeRoleRaw = (data.BREEZE_ROLE ?? '').trim().toLowerCase();
    if (
      (breezeRoleRaw === 'api' || breezeRoleRaw === 'worker')
      && !data.APP_ENCRYPTION_KEY_ID?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_ENCRYPTION_KEY_ID'],
        message:
          'APP_ENCRYPTION_KEY_ID is required when BREEZE_ROLE is "api" or "worker" (the cross-process agent command relay envelope requires AAD-bound v3 ciphertext).',
      });
    }

    // --- Native APNs push (all-or-none) ---
    // Push is optional, so an empty APNS_* set is fine. But a partial set
    // (e.g. team + bundle without the signing key) would silently fail to
    // deliver at first use rather than at boot. If the operator has opted in
    // by setting ANY APNS_* field, require the four credentials. Environment
    // stays optional (defaults to 'production' at the sender). Validated in
    // every NODE_ENV — a half-configured push relay is a bug regardless.
    const apnsFields = [
      data.APNS_AUTH_KEY,
      data.APNS_KEY_ID,
      data.APNS_TEAM_ID,
      data.APNS_BUNDLE_ID,
      data.APNS_ENVIRONMENT,
    ];
    const anyApnsSet = apnsFields.some((v) => v != null && v.trim() !== '');
    if (anyApnsSet) {
      const required: Array<[keyof typeof data, string | undefined]> = [
        ['APNS_AUTH_KEY', data.APNS_AUTH_KEY],
        ['APNS_KEY_ID', data.APNS_KEY_ID],
        ['APNS_TEAM_ID', data.APNS_TEAM_ID],
        ['APNS_BUNDLE_ID', data.APNS_BUNDLE_ID],
      ];
      for (const [key, value] of required) {
        if (!value || value.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key as string],
            message:
              `${key} is required when any APNS_* variable is set. Native APNs push needs APNS_AUTH_KEY (the .p8 PEM), APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID together; APNS_ENVIRONMENT is optional (defaults to production).`,
          });
        }
      }
    }
  });

// Inferred config type from the schema
export type AppConfig = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Parse input
// ---------------------------------------------------------------------------

/**
 * Every key declared in `envSchema`, in declaration order.
 *
 * This used to be a second, hand-maintained list of `KEY: env.KEY` lines inside
 * `validateConfig()`. A key declared in the schema but missing from that list
 * was silently never validated: it was `undefined` at parse time, so the schema
 * default always won, an operator typo booted instead of failing, and
 * `getConfig()` reported a value the runtime disagreed with. Seven keys had
 * drifted out of the list, two of them carrying rules that were therefore dead
 * code — `IP_ALLOWLIST_ENFORCEMENT_MODE`'s `z.enum` (issue #2896) and
 * `AGENT_AUTO_PROMOTE`'s boolean typo-guard in the `superRefine` above.
 *
 * Deriving the input from the schema makes that drift structurally impossible:
 * declaring a key in `envObjectSchema` is now the only step required to have it
 * validated.
 *
 * The CONVERSE drift — a variable read straight off `env` inside
 * `validateConfig()`/`collectWarnings()` without ever being declared, so it gets
 * no validation, no default and no place in the contract above — was closed by
 * issue #3374. The last three offenders (`M365_GRAPH_ACTIONS_TOOLS_ENABLED`,
 * `APP_ENCRYPTION_KEY_ID`, `TRUST_CF_CONNECTING_IP`) are now declared, and the
 * `undeclaredEnvReads()` contract test in validate.test.ts fails CI on a new
 * `env.KEY` read written INLINE in either function.
 *
 * That guard is deliberately narrow, so don't read it as "undeclared env reads
 * are now impossible here". Keys reached INDIRECTLY are out of its scope and
 * remain undeclared on purpose: `validateConfig()` hands the whole `env` to the
 * three `validateM365*RuntimeConfigAtBoot()` validators, which parse roughly two
 * dozen executor/descriptor keys lazily and keep them out of `AppConfig`
 * entirely.
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.freeze(
  Object.keys(envObjectSchema.shape),
);

/**
 * Builds the exact object `validateConfig()` hands to `safeParse` — one entry
 * per declared schema key, read from `env`. Exported so the drift contract test
 * can assert the parser sees every declared key.
 */
export function buildEnvParseInput(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const input: Record<string, string | undefined> = {};
  for (const key of ENV_SCHEMA_KEYS) {
    input[key] = env[key];
  }
  return input;
}

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

/**
 * True once `validateConfig()` has run SUCCESSFULLY. The singleton is assigned
 * last, after the parse result is checked, so a run that threw on invalid
 * config also leaves this false.
 *
 * Lets a caller that legitimately runs both before and after boot (unit tests,
 * scripts, the integration harness) branch on config availability instead of
 * wrapping `getConfig()` in a `try`/`catch` that would also swallow real errors.
 */
export function isConfigInitialized(): boolean {
  return _config !== null;
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

    // SR2-16: a prod deploy that trusts proxy headers but leaves
    // TRUST_CF_CONNECTING_IP off resolves client IPs from X-Forwarded-For only.
    // That is correct for a non-Cloudflare front, but a Cloudflare-fronted
    // deploy that forgets the flag silently loses CF-Connecting-IP attribution —
    // rate limits, audit-log IPs and partner IP allowlists then key off XFF (or
    // the proxy hop if XFF isn't populated). Warn so the flag is a conscious
    // choice; hard-failing would break legitimate non-Cloudflare self-hosters.
    const trustProxy = (env.TRUST_PROXY_HEADERS ?? '').trim().toLowerCase();
    const proxyTrustOn = ['1', 'true', 'yes', 'on'].includes(trustProxy);
    const trustCf = (env.TRUST_CF_CONNECTING_IP ?? '').trim().toLowerCase();
    const cfTrustOff = !['1', 'true', 'yes', 'on'].includes(trustCf);
    if (proxyTrustOn && cfTrustOff) {
      warnings.push({
        key: 'TRUST_CF_CONNECTING_IP',
        message:
          'Proxy header trust is enabled but TRUST_CF_CONNECTING_IP is off, so CF-Connecting-IP is ignored. ' +
          'This is correct for a non-Cloudflare front. If this deployment IS behind Cloudflare, set ' +
          'TRUST_CF_CONNECTING_IP=true — otherwise client IPs (rate limits, audit logs, IP allowlists) resolve ' +
          'from X-Forwarded-For instead of the Cloudflare edge IP.',
      });
    }
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
  // Every declared schema key is validated — the input is derived from the
  // schema itself (ENV_SCHEMA_KEYS), never from a second hand-maintained list.
  // See the ENV_SCHEMA_KEYS docblock for why: a key that reached the parser as
  // `undefined` had its rules silently skipped (issue #2896).
  const result = envSchema.safeParse(buildEnvParseInput(env));

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

  // The Graph-read descriptor stays out of AppConfig/public config. Parse it
  // lazily, but fail boot closed when the new-consent rollout is enabled.
  validateM365CustomerGraphReadRuntimeConfigAtBoot(env);

  // Same fail-closed contract for the Graph write-action executor descriptor
  // (customer-graph-actions): parsed lazily, but validated eagerly at boot
  // when the write-action tools rollout is enabled.
  validateM365CustomerGraphActionsRuntimeConfigAtBoot(env);

  // Same again for the communications-delegated descriptor (per-USER axis).
  // Deliberately NOT paired with an APP_ENCRYPTION_KEY_ID assertion: comms has
  // no reveal path and no API-side sealing — the token cache is the
  // executor's, wrapped under a KEK the API's identity cannot get (§3.2).
  validateM365CommunicationsRuntimeConfigAtBoot(env);

  // (The APP_ENCRYPTION_KEY_ID ↔ M365_GRAPH_ACTIONS_TOOLS_ENABLED pairing rule
  // used to live here as a post-parse throw reading `env` directly. It now runs
  // in the schema superRefine on declared keys — see #3374.)

  _config = result.data;

  // #1412: surface an off-default AI route at boot so there is an audit trail
  // (and a self-hoster sees confirmation their backend is active). Reaching
  // here means the fail-closed gate already accepted it, i.e. self-host is
  // affirmatively declared. Log host only — never the auth token.
  const anthropicBaseUrl = _config.ANTHROPIC_BASE_URL?.trim();
  if (anthropicBaseUrl) {
    let host = '(unparseable)';
    try {
      host = new URL(anthropicBaseUrl).host;
    } catch {
      host = '(unparseable)';
    }
    console.warn(
      `[config] AI Agent routed to a custom Anthropic-compatible backend (ANTHROPIC_BASE_URL host=${host}). `
      + 'Cost tracking is best-effort: an unrecognized model id is priced at conservative '
      + 'DEFAULT_PRICING (Opus-tier), not actual backend cost.',
    );
  }

  return _config;
}
