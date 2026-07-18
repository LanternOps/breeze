import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_VERSION = /^[0-9a-f]{32}$/;
const VAULT_REF = /^akv:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/m365-customer-graph-read\/([0-9a-f]{32})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EXECUTOR_AUDIENCE = 'm365-graph-read-executor' as const;
const CALLBACK_PATH = '/api/v1/m365/consent/callback';
const LOCAL_CALLBACK_ORIGIN = 'http://localhost:3001';

type Environment = Readonly<Record<string, string | undefined>>;

export interface M365ExecutorSigningPrivateJwk extends Record<string, unknown> {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
}

export interface M365CustomerGraphReadRuntimeConfig {
  clientId: string;
  vaultRef: string;
  credentialVersion: string;
  callbackUrl: string;
  executorUrl: string;
  executorAudience: typeof EXECUTOR_AUDIENCE;
  executorSigningPrivateJwk: M365ExecutorSigningPrivateJwk;
  executorSigningKid: string;
  onboardingOrgIds: '*' | readonly string[];
}

function flagEnabled(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

function required(source: Environment, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseCallbackUrl(source: Environment): string {
  const configured = [source.PUBLIC_URL, source.PUBLIC_APP_URL, source.PUBLIC_API_URL]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  const originInput = configured || (source.NODE_ENV === 'production' ? undefined : LOCAL_CALLBACK_ORIGIN);
  if (!originInput) {
    throw new Error(
      'PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required for the M365 consent callback in production',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(originInput);
  } catch {
    throw new Error('The configured M365 consent callback origin must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('The configured M365 consent callback origin must be a valid HTTP(S) URL');
  }
  return `${parsed.origin}${CALLBACK_PATH}`;
}

function parseExecutorUrl(source: Environment): string {
  const raw = required(source, 'M365_GRAPH_READ_EXECUTOR_URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M365_GRAPH_READ_EXECUTOR_URL must be a valid HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('M365_GRAPH_READ_EXECUTOR_URL must be an origin-only HTTPS URL');
  }
  return parsed.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isThirtyTwoByteBase64Url(value: unknown): value is string {
  return typeof value === 'string'
    && BASE64URL.test(value)
    && Buffer.from(value, 'base64url').byteLength === 32;
}

function parseSigningPrivateJwk(source: Environment, expectedKid: string): M365ExecutorSigningPrivateJwk {
  const file = required(source, 'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE');
  if (!isAbsolute(file)) {
    throw new Error('M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE must be an absolute path');
  }

  let raw: string;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) {
      throw new Error('not a regular file');
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('permissions must deny group and other access (use mode 0600 or stricter)');
    }
    raw = readFileSync(fd, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'cannot read file';
    throw new Error(`M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE ${detail}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE must contain valid JWK JSON');
  }
  if (
    !isRecord(parsed)
    || parsed.kty !== 'OKP'
    || parsed.crv !== 'Ed25519'
    || !isThirtyTwoByteBase64Url(parsed.x)
    || !isThirtyTwoByteBase64Url(parsed.d)
    || (parsed.alg !== undefined && parsed.alg !== 'EdDSA')
    || (parsed.use !== undefined && parsed.use !== 'sig')
    || (parsed.kid !== undefined && parsed.kid !== expectedKid)
  ) {
    throw new Error(
      'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE must contain the configured Ed25519 private signing JWK and matching M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
    );
  }
  if (parsed.key_ops !== undefined) {
    if (!Array.isArray(parsed.key_ops) || !parsed.key_ops.includes('sign')) {
      throw new Error(
        'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE key_ops must permit signing',
      );
    }
  }
  return parsed as M365ExecutorSigningPrivateJwk;
}

function parseOnboardingOrgIds(source: Environment): '*' | readonly string[] {
  const raw = source.M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS?.trim();
  if (!raw) {
    if (!flagEnabled(source.M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED)) return [];
    throw new Error('M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS is required when onboarding is enabled');
  }
  if (raw === '*') return '*';

  const ids = raw.split(',').map((value) => value.trim());
  if (ids.some((value) => !CANONICAL_UUID.test(value))) {
    throw new Error(
      'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS must be literal * or comma-separated canonical UUIDs',
    );
  }
  return [...new Set(ids)];
}

function parseGraphReadToolsOrgIds(source: Environment): '*' | readonly string[] {
  const raw = source.M365_GRAPH_READ_TOOLS_ORG_IDS?.trim();
  if (!raw) {
    if (!flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)) return [];
    throw new Error('M365_GRAPH_READ_TOOLS_ORG_IDS is required when M365 Graph read tools are enabled');
  }
  if (raw === '*') return '*';

  const ids = raw.split(',').map((value) => value.trim());
  if (ids.some((value) => !CANONICAL_UUID.test(value))) {
    throw new Error('M365_GRAPH_READ_TOOLS_ORG_IDS must be literal * or comma-separated canonical UUIDs');
  }
  return [...new Set(ids)];
}

/**
 * Loads the secret-bearing API-to-executor signing key and the non-secret,
 * fixed Graph-read descriptor at call time. Nothing is parsed at import time.
 */
export function loadM365CustomerGraphReadRuntimeConfig(
  source: Environment = process.env,
): M365CustomerGraphReadRuntimeConfig {
  const clientId = required(source, 'M365_CUSTOMER_GRAPH_READ_CLIENT_ID');
  if (!CANONICAL_UUID.test(clientId)) {
    throw new Error('M365_CUSTOMER_GRAPH_READ_CLIENT_ID must be a canonical UUID');
  }

  const credentialVersion = required(source, 'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION');
  if (!CREDENTIAL_VERSION.test(credentialVersion)) {
    throw new Error('M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION must be exactly 32 lowercase hex characters');
  }

  const vaultRef = required(source, 'M365_CUSTOMER_GRAPH_READ_VAULT_REF');
  const vaultMatch = VAULT_REF.exec(vaultRef);
  if (!vaultMatch || vaultMatch[2] !== credentialVersion) {
    throw new Error(
      'M365_CUSTOMER_GRAPH_READ_VAULT_REF must be akv://<host>/m365-customer-graph-read/<32-hex-version> and its version must equal M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION',
    );
  }

  const executorAudience = required(source, 'M365_GRAPH_READ_EXECUTOR_AUDIENCE');
  if (executorAudience !== EXECUTOR_AUDIENCE) {
    throw new Error(`M365_GRAPH_READ_EXECUTOR_AUDIENCE must equal ${EXECUTOR_AUDIENCE}`);
  }
  const executorSigningKid = required(source, 'M365_GRAPH_READ_EXECUTOR_SIGNING_KID');

  return {
    clientId,
    vaultRef,
    credentialVersion,
    callbackUrl: parseCallbackUrl(source),
    executorUrl: parseExecutorUrl(source),
    executorAudience,
    executorSigningPrivateJwk: parseSigningPrivateJwk(source, executorSigningKid),
    executorSigningKid,
    onboardingOrgIds: parseOnboardingOrgIds(source),
  };
}

export function isM365CustomerGraphReadOnboardingEnabledForOrg(
  orgId: string,
  source: Environment = process.env,
): boolean {
  if (!flagEnabled(source.M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED)) return false;
  if (!CANONICAL_UUID.test(orgId)) return false;
  const allowlist = loadM365CustomerGraphReadRuntimeConfig(source).onboardingOrgIds;
  return allowlist === '*' || allowlist.includes(orgId);
}

/**
 * Cheap, side-effect-free gate for whether the M365 Graph read AI tools are
 * enabled for an org. Deliberately does NOT call
 * loadM365CustomerGraphReadRuntimeConfig (which requires all executor envs) —
 * this is called on hot AI-tool-registration paths, not just at boot.
 */
export function isM365GraphReadToolsEnabledForOrg(
  orgId: string,
  source: Environment = process.env,
): boolean {
  if (!flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)) return false;
  if (!CANONICAL_UUID.test(orgId)) return false;
  const allowlist = parseGraphReadToolsOrgIds(source);
  return allowlist === '*' || allowlist.includes(orgId);
}

export function validateM365CustomerGraphReadRuntimeConfigAtBoot(
  source: Environment = process.env,
): void {
  if (
    flagEnabled(source.M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED)
    || flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)
  ) {
    loadM365CustomerGraphReadRuntimeConfig(source);
  }
  if (flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)) {
    // loadM365CustomerGraphReadRuntimeConfig() above does not validate the
    // tools allowlist (M365_GRAPH_READ_TOOLS_ORG_IDS) — it's read lazily on
    // the hot tool-registration path via isM365GraphReadToolsEnabledForOrg.
    // Validate it explicitly here so a missing/malformed allowlist fails
    // boot instead of every subsequent tool call.
    parseGraphReadToolsOrgIds(source);
  }
}
