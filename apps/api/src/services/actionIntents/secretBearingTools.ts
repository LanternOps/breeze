/**
 * Registry and seal chokepoint for AI tools that mint a credential.
 *
 * A secret-bearing tool never returns its credential in the string that
 * reaches the model, the chat transcript, or the SSE stream. It returns a
 * SecretToolResult carrier; sealToolSecrets splits that into `llmText`
 * (safe everywhere) and `sealedResult` (destined for action_intents.result,
 * with the credential encrypted under the same v3/AAD contract the reveal
 * endpoint already expects).
 *
 * The registry is a readonly tuple with a module-private predicate, not an
 * exported Set: an exported mutable Set would let any importer edit the
 * security registry at runtime.
 */
import { encryptSecret } from '../secretCrypto';
import {
  ACTION_INTENT_RESULT_AAD,
  TEMP_PASSWORD_ENC_KEY,
  TEMP_PASSWORD_LEGACY_KEY,
  TEMP_PASSWORD_SEAL_FAILED_KEY,
} from './resultSecrets';

const SECRET_BEARING_TOOLS = ['m365_reset_password', 'google_reset_password'] as const;

const ENC_V3_PREFIX = 'enc:v3:';

/**
 * Shared `action_intents.error_code` used by both the inline (chat-session)
 * completion path (aiAgentSdk.ts) and the durable release worker
 * (jobs/intentReleaseWorker.ts's failOnPlaintextSecretGuard) when
 * assertNoPlaintextSecret trips. Exported from here — rather than declared
 * independently in each call site — so the two paths cannot drift apart;
 * the whole point of a shared code is that both are queryable together on
 * `action_intents.error_code`.
 */
export const SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE = 'secret_seal_invariant_violated';

/**
 * Shared cap on the serialized size of a sealed action_intents.result,
 * enforced by both the inline path (aiAgentSdk.ts) and the durable release
 * worker (jobs/intentReleaseWorker.ts), which persist to the same column.
 */
export const MAX_RESULT_BYTES = 64 * 1024;

/** Shown to the operator whenever the credential could not be made revealable. */
export const SECRET_UNAVAILABLE_TEXT =
  'The password was reset, but the temporary credential could not be stored securely and is '
  + 'unavailable. Reset the password again to obtain a new one.';

/** Prose tripwire for the shape that caused the original Google leak. */
const PROSE_CREDENTIAL_PATTERN = /Temporary password:\s*(?!\[REDACTED\]|\[redacted\])\S/;

/**
 * Local copy of aiAgentSdk's stripMcpPrefix. Duplicated rather than imported
 * to avoid an import cycle (aiAgentSdk imports this module). Must stay in
 * sync with the canonical algorithm: this predicate gates both the
 * pre-execution refusal (aiAgentSdkTools.ts) and assertNoPlaintextSecret
 * below, so a narrower normalization here (e.g. only literal
 * "mcp__breeze__") lets a differently-prefixed tool name slip past both
 * checks and fails OPEN — reinstating the plaintext-leak class this module
 * exists to close.
 */
function stripMcpPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const separatorIndex = toolName.indexOf('__', 'mcp__'.length);
  return separatorIndex === -1 ? toolName : toolName.slice(separatorIndex + 2);
}

export function isSecretBearingTool(toolName: string): boolean {
  const bare = stripMcpPrefix(toolName);
  return (SECRET_BEARING_TOOLS as readonly string[]).includes(bare);
}

export type SecretToolResult =
  | {
      kind: 'success';
      llmText: string;
      secrets: { temporaryPassword: string };
      meta?: { delegantToolCallId?: string };
    }
  | { kind: 'error'; llmText: string };

/**
 * Split a carrier into the model-facing text and the intent-facing result.
 * Pure and synchronous: no DB access, no intent id.
 */
export function sealToolSecrets(
  result: SecretToolResult,
): { llmText: string; sealedResult: Record<string, unknown> } {
  if (result.kind === 'error') {
    return { llmText: result.llmText, sealedResult: { raw: result.llmText } };
  }

  const pw = result.secrets.temporaryPassword;
  const base: Record<string, unknown> = { ...(result.meta ?? {}) };

  const sealed = encryptSecret(pw, { aad: ACTION_INTENT_RESULT_AAD });
  if (!sealed || !sealed.startsWith(ENC_V3_PREFIX)) {
    // secretCrypto produced v1 (or nothing) — almost certainly APP_ENCRYPTION_KEY_ID
    // is unset. v1 is not AAD-bound, so storing it would allow ciphertext
    // substitution across intents. Fail closed on confidentiality: drop the
    // plaintext. The provider-side reset already happened and cannot be undone,
    // and forceChangePasswordNextSignIn bounds the impact.
    console.error(
      '[secretBearingTools] seal produced non-v3 ciphertext — APP_ENCRYPTION_KEY_ID missing? '
      + 'Temp password dropped (fail closed).',
    );
    return {
      llmText: SECRET_UNAVAILABLE_TEXT,
      sealedResult: { ...base, [TEMP_PASSWORD_SEAL_FAILED_KEY]: true },
    };
  }

  // Defence in depth: if a handler ever reintroduces interpolation, do not ship
  // the credential to the model just because sealing succeeded.
  const llmText = result.llmText.includes(pw) ? SECRET_UNAVAILABLE_TEXT : result.llmText;

  return { llmText, sealedResult: { ...base, [TEMP_PASSWORD_ENC_KEY]: sealed } };
}

/**
 * Post-condition guard. Asserts the invariant on what is about to be
 * persisted, rather than trusting that a particular code path was taken —
 * this way the M365 durable path (which seals via resultSecrets' structured
 * gate) and the Google path (which seals via sealToolSecrets) are both
 * covered by one check.
 *
 * Deliberately does NOT require a "seal marker" (temporaryPasswordEnc /
 * temporaryPasswordSealFailed) to be present. A secret-bearing tool that
 * fails (user not found, connection unavailable) legitimately persists an
 * error result with no credential and therefore no marker; requiring one
 * would throw on every error release. The "sealing actually happened"
 * invariant is guaranteed by construction instead — sealToolSecrets always
 * emits either key for a success carrier — and is pinned by a unit test
 * rather than by a runtime check that cannot distinguish success from
 * failure.
 */
export function assertNoPlaintextSecret(
  toolName: string,
  result: Record<string, unknown>,
): void {
  if (!isSecretBearingTool(toolName)) return;

  if (TEMP_PASSWORD_LEGACY_KEY in result) {
    throw new Error(
      `[secretBearingTools] refusing to persist plaintext credential for ${toolName}: `
      + `result carries the legacy ${TEMP_PASSWORD_LEGACY_KEY} key`,
    );
  }

  for (const value of Object.values(result)) {
    if (typeof value === 'string' && PROSE_CREDENTIAL_PATTERN.test(value)) {
      throw new Error(
        `[secretBearingTools] refusing to persist plaintext credential for ${toolName}: `
        + 'result contains an unredacted credential in prose',
      );
    }
  }
}
