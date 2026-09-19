import { ManagedIdentityCredential, WorkloadIdentityCredential } from '@azure/identity';
import { isIP } from 'node:net';
import { z } from 'zod';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_VERSION = /^[0-9a-f]{32}$/;
const VAULT_REF = /^akv:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/m365-customer-graph-read\/([0-9a-f]{32})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CALLBACK_PATH = '/api/v1/m365/consent/callback';
const INTERNAL_AUTH_ISSUER = 'breeze-api' as const;
const INTERNAL_AUTH_AUDIENCE = 'm365-graph-read-executor' as const;

type Environment = Readonly<Record<string, string | undefined>>;

export type AzureCredentialMode = 'managed-identity' | 'workload-identity';

const publicJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(BASE64URL),
  kid: z.string().min(1),
  alg: z.literal('EdDSA').optional(),
  use: z.literal('sig').optional(),
  key_ops: z.tuple([z.literal('verify')]).optional(),
}).strict().superRefine((jwk, context) => {
  if (Buffer.from(jwk.x, 'base64url').byteLength !== 32) {
    context.addIssue({
      code: 'custom',
      path: ['x'],
      message: 'x must encode exactly 32 bytes',
    });
  }
});

export type ExecutorInternalAuthPublicJwk = z.infer<typeof publicJwkSchema>;

export interface ExecutorSyncConfig {
  syncMaxInFlight: number;
  maxInFlight: number;
  signinActivityRpm: number;
  signinPagesPerCall: number;
  maxItemsUsers: number;
  maxItemsDevices: number;
  maxItemsCaPolicies: number;
  maxItemsSkus: number;
  /** #5784 W05. Per-run item budget for the /auditLogs/signIns walk. */
  maxItemsSigninEvents: number;
  /** #5784 W05. Own bucket rate: /auditLogs/signIns is not signin_activity's surface. */
  signinEventsRpm: number;
  /**
   * Continuation encryption secret. `null` means "mint an ephemeral one at
   * boot": continuations then die with the process and do not cross replicas,
   * which the API handles by restarting the sign-in domain from page 1. That
   * is a deliberate, self-healing default — it keeps the var optional for
   * every already-deployed executor.
   *
   * The spec asks for a key derived from the executor's signing key; the
   * executor holds only the PUBLIC verification JWK (parsePublicJwk below), so
   * there is no private material here to derive from.
   */
  continuationKey: Buffer | null;
}

export interface M365GraphReadExecutorConfig {
  clientId: string;
  callbackUrl: string;
  vaultUrl: string;
  vaultRef: string;
  credentialVersion: string;
  internalAuthPublicJwk: ExecutorInternalAuthPublicJwk;
  internalAuthKid: string;
  internalAuthIssuer: typeof INTERNAL_AUTH_ISSUER;
  internalAuthAudience: typeof INTERNAL_AUTH_AUDIENCE;
  azureCredentialMode: AzureCredentialMode;
  bindHost: string;
  port: number;
  sync: ExecutorSyncConfig;
}

function privateBindAddress(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const [first, second = -1] = value.split('.').map(Number);
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return !normalized.includes('%')
      && (normalized.startsWith('fc') || normalized.startsWith('fd'));
  }
  return false;
}

function required(source: Environment, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseCallbackUrl(source: Environment): string {
  const raw = required(source, 'M365_CUSTOMER_GRAPH_READ_CALLBACK_URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M365_CUSTOMER_GRAPH_READ_CALLBACK_URL must be the exact HTTPS consent callback URI');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== CALLBACK_PATH
    || parsed.search
    || parsed.hash
    || raw !== `${parsed.origin}${CALLBACK_PATH}`
  ) {
    throw new Error('M365_CUSTOMER_GRAPH_READ_CALLBACK_URL must be the exact HTTPS consent callback URI');
  }
  return raw;
}

function parseVaultUrl(source: Environment): string {
  const raw = required(source, 'M365_CUSTOMER_GRAPH_READ_VAULT_URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M365_CUSTOMER_GRAPH_READ_VAULT_URL must be an HTTPS vault origin');
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || raw !== parsed.origin
  ) {
    throw new Error('M365_CUSTOMER_GRAPH_READ_VAULT_URL must be an HTTPS vault origin');
  }
  return parsed.origin;
}

function parsePublicJwk(source: Environment, expectedKid: string): ExecutorInternalAuthPublicJwk {
  const raw = required(source, 'M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK must contain valid public JWK JSON');
  }
  const result = publicJwkSchema.safeParse(parsed);
  if (!result.success || result.data.kid !== expectedKid) {
    throw new Error(
      'M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK must be the configured Ed25519 public verification JWK and match M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
    );
  }
  return result.data;
}

export function createAzureCredential(
  mode: AzureCredentialMode,
  source: Environment = process.env,
): ManagedIdentityCredential | WorkloadIdentityCredential {
  if (mode === 'managed-identity') {
    const clientId = source.AZURE_CLIENT_ID?.trim();
    return clientId
      ? new ManagedIdentityCredential({ clientId })
      : new ManagedIdentityCredential();
  }
  if (mode === 'workload-identity') {
    const tenantId = required(source, 'AZURE_TENANT_ID');
    const clientId = required(source, 'AZURE_CLIENT_ID');
    const tokenFilePath = required(source, 'AZURE_FEDERATED_TOKEN_FILE');
    return new WorkloadIdentityCredential({ tenantId, clientId, tokenFilePath });
  }
  throw new Error(
    'M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE must be managed-identity or workload-identity',
  );
}

const CONTINUATION_KEY_BYTES = 32;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

function boundedInteger(
  source: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function parseContinuationKey(source: Environment): Buffer | null {
  const raw = source.M365_SYNC_CONTINUATION_KEY?.trim();
  if (!raw) return null;
  // Buffer.from(_, 'base64') silently drops invalid characters, so the regex —
  // not the decode — is what rejects a malformed key.
  if (!BASE64_32_BYTES.test(raw)) {
    throw new Error(`M365_SYNC_CONTINUATION_KEY must be exactly ${CONTINUATION_KEY_BYTES} bytes of base64`);
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.byteLength !== CONTINUATION_KEY_BYTES) {
    throw new Error(`M365_SYNC_CONTINUATION_KEY must be exactly ${CONTINUATION_KEY_BYTES} bytes of base64`);
  }
  return decoded;
}

function parseSyncConfig(source: Environment): ExecutorSyncConfig {
  const syncMaxInFlight = boundedInteger(source, 'M365_SYNC_MAX_IN_FLIGHT', 4, 1, 64);
  const maxInFlight = boundedInteger(source, 'M365_MAX_IN_FLIGHT', 32, 1, 1024);
  if (maxInFlight < syncMaxInFlight) {
    throw new Error('M365_MAX_IN_FLIGHT must be greater than or equal to M365_SYNC_MAX_IN_FLIGHT');
  }
  return {
    syncMaxInFlight,
    maxInFlight,
    signinActivityRpm: boundedInteger(source, 'M365_SIGNIN_ACTIVITY_RPM', 4, 1, 60),
    signinPagesPerCall: boundedInteger(source, 'M365_SIGNIN_PAGES_PER_CALL', 5, 1, 60),
    maxItemsUsers: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_USERS', 25_000, 1, 200_000),
    maxItemsDevices: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_DEVICES', 25_000, 1, 200_000),
    maxItemsCaPolicies: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_CA', 500, 1, 5_000),
    maxItemsSkus: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_SKUS', 200, 1, 5_000),
    maxItemsSigninEvents: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS', 25_000, 1, 200_000),
    signinEventsRpm: boundedInteger(source, 'M365_SIGNIN_EVENTS_RPM', 6, 1, 60),
    continuationKey: parseContinuationKey(source),
  };
}

/** Loads the executor's fixed profile and public-only internal-auth descriptor. */
export function loadExecutorConfig(
  source: Environment = process.env,
): M365GraphReadExecutorConfig {
  const clientId = required(source, 'M365_CUSTOMER_GRAPH_READ_CLIENT_ID');
  if (!CANONICAL_UUID.test(clientId)) {
    throw new Error('M365_CUSTOMER_GRAPH_READ_CLIENT_ID must be a canonical UUID');
  }

  const callbackUrl = parseCallbackUrl(source);
  const vaultUrl = parseVaultUrl(source);
  const credentialVersion = required(source, 'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION');
  if (!CREDENTIAL_VERSION.test(credentialVersion)) {
    throw new Error(
      'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION must be exactly 32 lowercase hex characters',
    );
  }

  const vaultRef = required(source, 'M365_CUSTOMER_GRAPH_READ_VAULT_REF');
  const vaultMatch = VAULT_REF.exec(vaultRef);
  if (
    !vaultMatch
    || vaultMatch[1] !== new URL(vaultUrl).host
    || vaultMatch[2] !== credentialVersion
  ) {
    throw new Error(
      'M365_CUSTOMER_GRAPH_READ_VAULT_REF must match M365_CUSTOMER_GRAPH_READ_VAULT_URL and end with /m365-customer-graph-read/<M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION>',
    );
  }

  const internalAuthKid = required(source, 'M365_GRAPH_READ_EXECUTOR_SIGNING_KID');
  const internalAuthPublicJwk = parsePublicJwk(source, internalAuthKid);

  const internalAuthIssuer = required(source, 'M365_GRAPH_READ_EXECUTOR_ISSUER');
  if (internalAuthIssuer !== INTERNAL_AUTH_ISSUER) {
    throw new Error(`M365_GRAPH_READ_EXECUTOR_ISSUER must equal ${INTERNAL_AUTH_ISSUER}`);
  }

  const internalAuthAudience = required(source, 'M365_GRAPH_READ_EXECUTOR_AUDIENCE');
  if (internalAuthAudience !== INTERNAL_AUTH_AUDIENCE) {
    throw new Error(`M365_GRAPH_READ_EXECUTOR_AUDIENCE must equal ${INTERNAL_AUTH_AUDIENCE}`);
  }

  const azureCredentialMode = required(
    source,
    'M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE',
  );
  if (azureCredentialMode !== 'managed-identity' && azureCredentialMode !== 'workload-identity') {
    throw new Error(
      'M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE must be managed-identity or workload-identity',
    );
  }

  const bindHost = required(source, 'M365_GRAPH_READ_EXECUTOR_BIND_HOST');
  if (!privateBindAddress(bindHost)) {
    throw new Error('M365_GRAPH_READ_EXECUTOR_BIND_HOST must be a private IP interface');
  }
  const rawPort = required(source, 'M365_GRAPH_READ_EXECUTOR_PORT');
  const port = Number(rawPort);
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('M365_GRAPH_READ_EXECUTOR_PORT must be an integer from 1 through 65535');
  }

  return {
    clientId,
    callbackUrl,
    vaultUrl,
    vaultRef,
    credentialVersion,
    internalAuthPublicJwk,
    internalAuthKid,
    internalAuthIssuer,
    internalAuthAudience,
    azureCredentialMode,
    bindHost,
    port,
    sync: parseSyncConfig(source),
  };
}
