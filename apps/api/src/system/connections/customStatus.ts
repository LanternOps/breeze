/**
 * Status functions that mirror the real resolvers (spec D10) instead of raw
 * `process.env` presence. Reasons name env vars, never values (invariant 4).
 *
 * These read the env snapshot only. None of them opens a `*_FILE` path (D11)
 * or logs anything.
 */
import { resolveRequestDatabaseConfig } from '../../db/requestDatabaseConfig';
import { hasValue, isSet, listNames } from './statusHelpers';
import type { EnvSnapshot, StatusResult } from './types';

// ---------------------------------------------------------------------------
// Database — mirrors resolveRequestDatabaseConfig (db/requestDatabaseConfig.ts:113-140)
// ---------------------------------------------------------------------------

export function databaseStatus(env: EnvSnapshot): StatusResult {
  if (!hasValue(env, 'DATABASE_URL')) {
    return { status: 'required_missing', reason: 'DATABASE_URL is not set' };
  }

  let source: 'explicit' | 'derived' | 'development-fallback';
  try {
    // The real resolver is pure over the env object it is given. Its error
    // messages are fixed strings, but we still never forward them.
    source = resolveRequestDatabaseConfig(env as NodeJS.ProcessEnv).source;
  } catch {
    if (hasValue(env, 'DATABASE_URL_APP')) {
      return { status: 'misconfigured', reason: 'DATABASE_URL_APP is not a valid postgres:// URL' };
    }
    if (hasValue(env, 'BREEZE_APP_DB_PASSWORD') || hasValue(env, 'POSTGRES_PASSWORD')) {
      return {
        status: 'misconfigured',
        reason: 'The request-pool URL cannot be derived from DATABASE_URL (invalid or multi-host URL); set DATABASE_URL_APP',
      };
    }
    return {
      status: 'misconfigured',
      reason: 'Production requires DATABASE_URL_APP, BREEZE_APP_DB_PASSWORD or POSTGRES_PASSWORD for the unprivileged request pool',
    };
  }

  if (source === 'explicit') return { status: 'enabled', reason: 'Request pool uses DATABASE_URL_APP' };
  if (source === 'derived') {
    return { status: 'enabled', reason: 'Request pool derived from DATABASE_URL for the breeze_app role' };
  }
  return {
    status: 'misconfigured',
    reason: 'Neither DATABASE_URL_APP nor BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD is set; request handlers fall back to DATABASE_URL (development only)',
  };
}

// ---------------------------------------------------------------------------
// Redis — mirrors resolveRedisUrl + failOrWarnAboutInsecureRedis (services/redis.ts:24-123)
// ---------------------------------------------------------------------------

function isProductionLike(env: EnvSnapshot): boolean {
  // services/redis.ts:24-31 — tolerant match.
  const raw = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  return raw === 'production' || raw === 'prod';
}

function allowsUnauthenticatedRedis(env: EnvSnapshot): boolean {
  // services/redis.ts:37-39 — strict 'true'.
  return (env.BREEZE_ALLOW_UNAUTH_REDIS ?? '').toLowerCase() === 'true';
}

function isHostedSaas(env: EnvSnapshot): boolean {
  // services/redis.ts isHostedSaas — hosted is always fail-closed, the
  // BREEZE_ALLOW_UNAUTH_REDIS opt-out does not apply.
  return (env.IS_HOSTED ?? '').toLowerCase() === 'true';
}

function redisUrlHasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

export function redisStatus(env: EnvSnapshot): StatusResult {
  const strict = isProductionLike(env) && (isHostedSaas(env) || !allowsUnauthenticatedRedis(env));

  const url = env.REDIS_URL?.trim();
  if (url) {
    if (strict && !redisUrlHasPassword(url)) {
      return {
        status: 'misconfigured',
        reason: 'REDIS_URL has no password; production refuses unauthenticated Redis unless BREEZE_ALLOW_UNAUTH_REDIS is true',
      };
    }
    return { status: 'enabled', reason: 'Using REDIS_URL' };
  }

  if (!hasValue(env, 'REDIS_HOST')) {
    return {
      status: 'required_missing',
      reason: 'Neither REDIS_URL nor REDIS_HOST is set; the API falls back to localhost:6379',
    };
  }

  // REDIS_PASSWORD or REDIS_PASSWORD_FILE (D11; the file is never opened).
  if (strict && !isSet(env, 'REDIS_PASSWORD')) {
    return {
      status: 'misconfigured',
      reason: 'REDIS_HOST is set but REDIS_PASSWORD (or REDIS_PASSWORD_FILE) is missing; production refuses unauthenticated Redis unless BREEZE_ALLOW_UNAUTH_REDIS is true',
    };
  }
  return { status: 'enabled', reason: 'Using REDIS_HOST and REDIS_PORT' };
}

// ---------------------------------------------------------------------------
// Email — mirrors resolveEmailProviderConfig (services/email.ts:686-876)
// ---------------------------------------------------------------------------

type EmailProvider = 'resend' | 'smtp' | 'mailgun';
const AUTO_DETECT_ORDER: readonly EmailProvider[] = ['resend', 'smtp', 'mailgun'];

function missingForProvider(provider: EmailProvider, env: EnvSnapshot): string[] {
  const from = hasValue(env, 'EMAIL_FROM');
  const missing: string[] = [];
  if (provider === 'resend') {
    if (!hasValue(env, 'RESEND_API_KEY')) missing.push('RESEND_API_KEY');
    if (!from) missing.push('EMAIL_FROM');
  } else if (provider === 'smtp') {
    if (!hasValue(env, 'SMTP_HOST')) missing.push('SMTP_HOST');
    if (!hasValue(env, 'SMTP_FROM') && !from) missing.push('SMTP_FROM (or EMAIL_FROM)');
  } else {
    if (!hasValue(env, 'MAILGUN_API_KEY')) missing.push('MAILGUN_API_KEY');
    if (!hasValue(env, 'MAILGUN_DOMAIN')) missing.push('MAILGUN_DOMAIN');
    if (!hasValue(env, 'MAILGUN_FROM') && !from) missing.push('MAILGUN_FROM (or EMAIL_FROM)');
  }
  return missing;
}

/** services/email.ts:793 — SMTP_PASS is checked untrimmed, SMTP_USER trimmed. */
function smtpAuthMismatch(env: EnvSnapshot): boolean {
  const user = hasValue(env, 'SMTP_USER');
  const pass = (env.SMTP_PASS ?? '').length > 0;
  return user !== pass;
}

const SMTP_AUTH_REASON = 'SMTP_USER and SMTP_PASS must both be set or both be omitted';

function isOrAre(names: readonly string[]): string {
  return names.length === 1 ? 'is' : 'are';
}

export function emailStatus(env: EnvSnapshot): StatusResult {
  const selection = (env.EMAIL_PROVIDER ?? 'auto').trim().toLowerCase();
  if (selection !== 'auto' && selection !== 'resend' && selection !== 'smtp' && selection !== 'mailgun') {
    return { status: 'misconfigured', reason: 'EMAIL_PROVIDER must be one of auto, resend, smtp, mailgun' };
  }

  if (selection !== 'auto') {
    const missing = missingForProvider(selection, env);
    if (missing.length > 0) {
      return {
        status: 'misconfigured',
        reason: `EMAIL_PROVIDER selects ${selection} but ${listNames(missing)} ${isOrAre(missing)} missing`,
      };
    }
    if (selection === 'smtp' && smtpAuthMismatch(env)) return { status: 'misconfigured', reason: SMTP_AUTH_REASON };
    return { status: 'enabled', reason: `Provider: ${selection}` };
  }

  for (const provider of AUTO_DETECT_ORDER) {
    if (missingForProvider(provider, env).length === 0) {
      if (provider === 'smtp' && smtpAuthMismatch(env)) return { status: 'misconfigured', reason: SMTP_AUTH_REASON };
      return { status: 'enabled', reason: `Provider: ${provider} (auto-detected)` };
    }
  }

  // Nothing complete. Report the first provider the operator started on.
  const started = AUTO_DETECT_ORDER.find((provider) => {
    if (provider === 'resend') return hasValue(env, 'RESEND_API_KEY');
    if (provider === 'smtp') return hasValue(env, 'SMTP_HOST');
    return hasValue(env, 'MAILGUN_API_KEY') || hasValue(env, 'MAILGUN_DOMAIN');
  });
  if (!started) {
    return {
      status: 'required_missing',
      reason: 'No email provider is configured (RESEND_API_KEY, SMTP_HOST or MAILGUN_API_KEY)',
    };
  }
  const missing = missingForProvider(started, env);
  return {
    status: 'misconfigured',
    reason: `${started} is partly configured: ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

// ---------------------------------------------------------------------------
// Non-core entries with real logic
// ---------------------------------------------------------------------------

/** services/binarySource.ts:9 — unset falls back to the default source, so this is never "disabled". */
export function agentBinariesStatus(env: EnvSnapshot): StatusResult {
  if (!hasValue(env, 'BINARY_SOURCE')) {
    return { status: 'enabled', reason: 'BINARY_SOURCE is not set; the default source (github) is used' };
  }
  return { status: 'enabled' };
}

/** extensions/builtinExtensions.ts:137 — strict `=== 'true'`, not the envFlag vocabulary. */
export function workspaceExtensionStatus(env: EnvSnapshot): StatusResult {
  return env.BREEZE_WORKSPACE_ENABLED === 'true' ? { status: 'enabled' } : { status: 'disabled' };
}

/** middleware/security.ts:166-167 — FORCE_HTTPS is 'true' or '1'; the redirect needs PUBLIC_API_URL. */
export function transportSecurityStatus(env: EnvSnapshot): StatusResult {
  const normalized = env.FORCE_HTTPS?.trim().toLowerCase();
  const forceHttps = normalized === 'true' || normalized === '1';
  if (!forceHttps) {
    return { status: 'disabled', reason: 'FORCE_HTTPS is off; HTTPS must terminate at the reverse proxy' };
  }
  if (!hasValue(env, 'PUBLIC_API_URL')) {
    return { status: 'misconfigured', reason: 'FORCE_HTTPS is on but PUBLIC_API_URL is missing' };
  }
  return { status: 'enabled' };
}
