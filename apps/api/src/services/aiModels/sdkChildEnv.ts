/**
 * Agent SDK child-process environments (moved verbatim from
 * streamingSessionManager.ts, W06 Task 9, so the connection factory's
 * `prepareSdkChild` seam can build them without importing the session
 * manager). `buildClaudeSdkChildEnv` serves the Anthropic-dialect kinds
 * (platform, anthropic_byok, catalog); `buildGatewaySdkChildEnv` serves the
 * gateway kinds (W06 openai_compatible, W07 cloud kinds).
 */
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRecognizedSelfHostSignal } from '../../config/env';
import type { ResolvedLlmEndpoint, UsableLlmConfig } from '../llm/llmConfigResolver';
import { PLATFORM_LLM_CREDENTIAL_ENV_KEYS } from '../llm/llmAvailability';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from '../llm/sdkChildEnvGuards';

const SDK_CHILD_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // ANTHROPIC_MODEL (#1412): raw-vLLM model id override. Harmless to forward
  // (the model is also passed explicitly via options.model); not a redirect
  // vector, so unlike ANTHROPIC_BASE_URL it needs no hosted gating.
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'COMSPEC',
] as const;

// The platform credentials — the same set `isPlatformLlmConfigured` counts as
// "a model provider is configured", so readiness and the subprocess agree.
const SDK_CHILD_ENV_CREDENTIAL_KEYS = new Set<string>(PLATFORM_LLM_CREDENTIAL_ENV_KEYS);

/**
 * Proxy configuration the parent process may carry. Forwarded as-is for
 * platform and direct-Anthropic partner sessions (an operator's outbound proxy
 * is legitimate there), but DROPPED wholesale for a catalog session: those must
 * traverse the grant-scoped CONNECT proxy, and a parent `NO_PROXY=*` (or a
 * lowercase `https_proxy` shadowing our uppercase one) would quietly restore
 * direct, unpinned egress to the provider (#3922, quorum P4).
 */
const SDK_CHILD_ENV_PROXY_KEYS = new Set<string>([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

/** The catalog endpoint of a partner session, or null for every other shape. */
export function catalogEndpointOf(
  resolved: UsableLlmConfig,
): Extract<ResolvedLlmEndpoint, { kind: 'catalog' }> | null {
  return resolved.source === 'partner' && resolved.endpoint.kind === 'catalog'
    ? resolved.endpoint
    : null;
}

export function buildClaudeSdkChildEnv(
  resolved: UsableLlmConfig,
  source: NodeJS.ProcessEnv = process.env,
  options: { egressProxyUrl?: string } = {},
): Record<string, string> {
  const catalogEndpoint = catalogEndpointOf(resolved);

  const env: Record<string, string> = {
    CI: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: source.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'breeze-api/ai-agent',
    // HOME is forwarded below; without these the CLI prepends the host's
    // Claude Code auto-memory to every request (#7444). Shared by every return
    // path because they all return this object.
    ...SDK_CHILD_HOST_CONTEXT_GUARDS,
  };

  for (const key of SDK_CHILD_ENV_ALLOWLIST) {
    if (resolved.source === 'partner' && SDK_CHILD_ENV_CREDENTIAL_KEYS.has(key)) continue;
    if (catalogEndpoint && SDK_CHILD_ENV_PROXY_KEYS.has(key)) continue;
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  // `resolved.source === 'partner'` is implied by a catalog endpoint existing;
  // it is restated so `resolved.apiKey` narrows to a required string.
  if (catalogEndpoint && resolved.source === 'partner') {
    const { egressProxyUrl } = options;
    // No proxy URL means no grant, and no grant means the child would dial the
    // provider itself with none of the allowlisting, DNS pinning, or egress
    // audit this whole path exists for. Refuse to build such an environment
    // rather than start a subprocess that silently egresses unguarded.
    if (!egressProxyUrl) {
      throw new Error(
        'A catalog LLM session requires an egress proxy URL; refusing to build an unproxied child environment.',
      );
    }
    // The endpoint's own URL — deliberately NOT the parent's
    // ANTHROPIC_BASE_URL, which is never in the allowlist and stays irrelevant
    // here whatever IS_HOSTED says (#1412 governs the PLATFORM path only).
    env.ANTHROPIC_BASE_URL = catalogEndpoint.baseUrl;
    // Exactly one credential var; the other was already excluded above with the
    // rest of the parent's credentials, so the SDK cannot fall back to a
    // platform key and leak it to a third party.
    if (catalogEndpoint.authMode === 'bearer') {
      env.ANTHROPIC_AUTH_TOKEN = resolved.apiKey;
    } else {
      env.ANTHROPIC_API_KEY = resolved.apiKey;
    }
    env.HTTPS_PROXY = egressProxyUrl;
    env.HTTP_PROXY = egressProxyUrl;
    // Explicit and empty: an unset NO_PROXY would let the parent's (already
    // dropped) value or a library default exempt hosts from the proxy.
    env.NO_PROXY = '';
    return env;
  }

  if (resolved.source === 'partner') {
    env.ANTHROPIC_API_KEY = resolved.apiKey;
    return env;
  }

  // ANTHROPIC_BASE_URL (#1412): forward ONLY when self-host is affirmatively
  // declared (IS_HOSTED explicitly false/0/no/off). Fail-closed — unset / empty
  // / garbage / truthy IS_HOSTED all strip it, so a stray/misconfigured value
  // (including the #570 unmapped-IS_HOSTED footgun) can never redirect platform
  // AI traffic to a third-party backend. The config validator also boot-refuses
  // this combo; this is defense-in-depth at the actual subprocess boundary (the
  // function reads process.env directly, not the validated config singleton).
  const anthropicBaseUrl = source.ANTHROPIC_BASE_URL;
  if (
    isRecognizedSelfHostSignal(source.IS_HOSTED)
    && typeof anthropicBaseUrl === 'string'
    && anthropicBaseUrl.length > 0
  ) {
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  }

  return env;
}

/**
 * The NO_PROXY entry for a gateway child: `127.0.0.1:<port>` of the loopback
 * gateway base URL. Anything else (a missing, unparsable or non-loopback URL)
 * exempts nothing, so the child fails closed onto the deny-all proxy rather
 * than gaining a broad exemption.
 */
function gatewayNoProxyEntry(gatewayBaseUrl: string | undefined): string {
  if (!gatewayBaseUrl) return '';
  let url: URL;
  try { url = new URL(gatewayBaseUrl); } catch { return ''; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') return '';
  return `127.0.0.1:${url.port}`;
}

/** An empty, private working directory for one Agent SDK child. */
export interface IsolatedSdkCwd {
  cwd: string;
  /** Deletes the directory. Idempotent and never throws. */
  remove: () => void;
}

/**
 * A fresh, empty working directory for an Agent SDK child bound to an
 * untrusted endpoint. The CLI describes its working directory (path, git
 * status) in the system prompt it sends upstream; running it in an empty
 * temp directory keeps repository and host paths out of that context.
 */
export async function createIsolatedSdkCwd(): Promise<IsolatedSdkCwd> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'breeze-sdk-'));
  let removed = false;
  return {
    cwd,
    remove: () => {
      if (removed) return;
      removed = true;
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[sdkChildEnv] could not remove an SDK child working directory: ${(error as Error).message}`);
      }
    },
  };
}

/**
 * W06: env for an Agent SDK child bound to a gateway connection. The adapter
 * supplies the base URL (loopback + grant token), the placeholder key and the
 * model pins. No credential env var is forwarded from the parent (platform key,
 * OAuth token, cloud creds); no parent proxy var survives; the child's only
 * routable destination is the loopback gateway — everything else goes to a
 * deny-all, audited CONNECT grant.
 */
export function buildGatewaySdkChildEnv(input: {
  adapterEnv: Record<string, string>;
  denyProxyUrl: string;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.source ?? process.env;
  const env: Record<string, string> = {
    CI: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: source.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'breeze-api/ai-agent',
    ...SDK_CHILD_HOST_CONTEXT_GUARDS,
  };
  for (const key of SDK_CHILD_ENV_ALLOWLIST) {
    if (SDK_CHILD_ENV_CREDENTIAL_KEYS.has(key) || SDK_CHILD_ENV_PROXY_KEYS.has(key)) continue;
    // A parent model override would make the CLI ask the gateway for a model
    // the grant does not bind; the adapter pins every model env itself.
    if (key === 'ANTHROPIC_MODEL') continue;
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  Object.assign(env, input.adapterEnv);
  env.HTTPS_PROXY = input.denyProxyUrl;
  env.HTTP_PROXY = input.denyProxyUrl;
  // The gateway is on loopback: exempt it, and only it, from the deny-all
  // proxy — its exact host:port, so no other loopback listener on the host is
  // reachable directly. The bundled CLI matches port-qualified entries
  // (gatewaySdk.e2e.test.ts proves both directions).
  env.NO_PROXY = gatewayNoProxyEntry(input.adapterEnv.ANTHROPIC_BASE_URL);
  // Host-context guards last: an adapter can never re-enable auto-memory / CLAUDE.md.
  Object.assign(env, SDK_CHILD_HOST_CONTEXT_GUARDS);
  return env;
}
