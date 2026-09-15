import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';

/**
 * The shape a `tool_sources` row's decrypted `auth_config_encrypted` column
 * takes, keyed by `authKind` (spec 2026-09-07 §5.2). This is what a Streamable
 * HTTP MCP client needs to authenticate to the remote endpoint — never stored
 * or logged as plaintext outside this module and `mcpClient.ts`.
 */
export type ToolSourceAuthConfig =
  | { authKind: 'none' }
  | { authKind: 'bearer'; token: string }
  | { authKind: 'api_key_header'; headerName: string; value: string }
  | { authKind: 'basic'; username: string; password: string }
  | {
      authKind: 'oauth2_client_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    };

// `tool_sources.auth_config_encrypted` is registered with `aadBinding: 'row'`
// (see `encryptedColumnRegistry.ts`), the same as `partner_llm_configs`. A
// tool source's credential is a live capability an MSP tech supplied for one
// specific remote endpoint — swapping the ciphertext blob into a different
// row would hand that credential to a different tenant's tool source and have
// it decrypt cleanly, because a plain `table.column` AAD only stops a blob
// moving between COLUMNS, not between ROWS. Binding the AAD to the row id (so
// it decrypts only replayed against the exact row it was written for) is what
// stops that swap, and is why every function below requires the row id up
// front rather than accepting it as an optional hint.
const TOOL_SOURCE_AUTH_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'tool_sources' && entry.column === 'auth_config_encrypted',
  );
  if (!spec) {
    throw new Error('tool_sources.auth_config_encrypted is missing from encryptedColumnRegistry');
  }
  return spec;
})();

/**
 * Encrypts a tool source's auth config for storage in
 * `tool_sources.auth_config_encrypted`, plus an HMAC fingerprint of the
 * plaintext for cheap equality checks (e.g. "did the credential actually
 * change on this PATCH") without ever decrypting.
 *
 * `authKind: 'none'` has no credential material to protect, so it stores
 * `null` rather than an encrypted empty object — that keeps "no credential"
 * distinguishable from "credential present but empty" at the SQL layer.
 */
export function encryptToolSourceAuth(
  rowId: string,
  cfg: ToolSourceAuthConfig,
): { encrypted: string | null; fingerprint: string | null } {
  if (cfg.authKind === 'none') {
    return { encrypted: null, fingerprint: null };
  }

  const serialized = JSON.stringify(cfg);
  const encrypted = encryptSecret(serialized, { aad: columnAad(TOOL_SOURCE_AUTH_SPEC, rowId) });
  if (!encrypted) {
    throw new Error(`Could not encrypt tool source auth config for row ${rowId}`);
  }

  return { encrypted, fingerprint: hmacFingerprint(serialized) };
}

/**
 * Decrypts a `tool_sources` row's auth config back into the typed shape the
 * MCP client needs. Must be called with the SAME row id the config was
 * encrypted under (`row.id`) — passing a different id fails the AAD check in
 * `decryptSecret` and throws, by design (see the AAD comment above).
 */
export function decryptToolSourceAuth(row: {
  id: string;
  authKind: string;
  authConfigEncrypted: string | null;
}): ToolSourceAuthConfig {
  if (row.authKind === 'none') {
    return { authKind: 'none' };
  }

  if (!row.authConfigEncrypted) {
    throw new Error(`tool_sources row ${row.id} has authKind '${row.authKind}' but no encrypted auth config`);
  }

  const plaintext = decryptSecret(row.authConfigEncrypted, {
    aad: columnAad(TOOL_SOURCE_AUTH_SPEC, row.id),
  });
  if (!plaintext) {
    throw new Error(`tool_sources row ${row.id} auth config decrypted to an empty value`);
  }

  return JSON.parse(plaintext) as ToolSourceAuthConfig;
}

/**
 * The origin (`scheme://host[:port]`) a tool source's endpoint URL resolves
 * to, pinned at create/update time and re-checked on every call in
 * `mcpClient.ts` before attaching a credential. This is the anti-SSRF-via-
 * redirect guard for auth headers: even if a source's `endpointUrl` is later
 * changed to point somewhere else without going through the update path that
 * re-derives this value, a credential is only ever sent to the origin it was
 * pinned against, never wherever the endpoint currently happens to resolve.
 * `URL#origin` normalizes away the default port for the scheme (`:443` for
 * `https:`), path, query, and fragment — exactly the granularity a browser
 * would trust an `Authorization` header to.
 */
export function credentialOriginFor(endpointUrl: string): string {
  return new URL(endpointUrl).origin;
}

/**
 * Every secret string embedded in an auth config, for `redactSecrets` to
 * scrub out of tool output/error text before it reaches a chat transcript,
 * audit log, or `lastError` column. Only the values that ARE the credential:
 * `headerName`, `tokenUrl`, `clientId`, and `scope` are identifiers/config,
 * not secrets, and leaving them unredacted is what makes a redacted error
 * message still useful for debugging.
 */
export function secretValuesOf(cfg: ToolSourceAuthConfig): string[] {
  switch (cfg.authKind) {
    case 'none':
      return [];
    case 'bearer':
      return [cfg.token];
    case 'api_key_header':
      return [cfg.value];
    case 'basic':
      return [cfg.username, cfg.password];
    case 'oauth2_client_credentials':
      return [cfg.clientSecret];
  }
}

// Beyond the literal secret values above, a remote MCP server's own response
// text (error messages, tool output) can echo credential-shaped material we
// never stored ourselves — a bearer token it minted, a JWT it embeds in a
// debug trace, a leaked `sk-`-prefixed provider key. Literal replacement alone
// can't catch those because we don't have the string to match against, so
// redaction also runs a small set of shape-based patterns over the full text.
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  // `Authorization: Bearer <token>` — matches the credential value only,
  // consistent with base64url alphabet (RFC 6750 b64token).
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // JSON Web Token: three base64url segments separated by dots. Anchored on
  // the `eyJ` prefix (base64 of `{"`), which every compact JWT header starts
  // with, to avoid matching arbitrary dotted identifiers.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // OpenAI-style `sk-` secret keys, which show up unprompted in a lot of
  // proxied/echoed tool output.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];

/**
 * Scrubs known secret values (literal replace, e.g. this source's own
 * credential) and credential-shaped text (generic patterns, e.g. a token some
 * other system embedded in its response) out of `text`, replacing each match
 * with `[REDACTED]`. Used before any tool-call result, error message, or
 * `lastError` derived from a remote MCP server is persisted or surfaced.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}
