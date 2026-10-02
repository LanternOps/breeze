/**
 * Live verification of an Anthropic API key against the endpoint it will be
 * used with (moved from the retired /ai/provider facade, W08 #7606). Probes run
 * outside any transaction; callers hold no lock while they wait on the network.
 */
import Anthropic from '@anthropic-ai/sdk';
import { runOutsideDbContext } from '../../db';
import { resolveDefaultModel } from '../aiModel';
import { LlmEgressViolationError } from '../llm/guardedLlmFetch';
// `isLlmProviderCatalogEnabled` is called from inside function bodies here,
// never at module-evaluation time.
import { buildCatalogEndpointSnapshot, isLlmProviderCatalogEnabled, type ResolvedLlmEndpoint } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { captureException } from '../sentry';
import { createAnthropicClient } from './connectionFactory';

/**
 * A connection write the caller should see verbatim: its message and status
 * are the response (routes/aiModels/shared.ts registryWrite), exactly as the
 * retired facade error was, so the Connections drawer shows the same text.
 */
export class ConnectionCheckError extends Error {
  constructor(message: string, public readonly status: 400 | 409 | 500 | 503) {
    super(message);
    this.name = 'ConnectionCheckError';
  }
}

/**
 * Maps a probe's thrown error to the typed `ConnectionCheckError` phase-1
 * semantics expect, for BOTH probe targets (direct Anthropic and a catalog
 * endpoint reached through the guarded client). A blocked-egress refusal is
 * mapped to a transient 503 — it says nothing about the key itself, only that
 * the pinned endpoint could not be reached right now. Anything else that
 * isn't an `Anthropic.APIError` is returned as-is so the caller can rethrow
 * it unwrapped (a genuine programming error must not masquerade as a probe
 * rejection).
 */
function mapProbeError(error: unknown): unknown {
  if (error instanceof LlmEgressViolationError) {
    return new ConnectionCheckError('Could not reach that endpoint to verify the key. Try again shortly.', 503);
  }
  if (!(error instanceof Anthropic.APIError)) return error;
  const status = error.status;
  if (status === 401) {
    return new ConnectionCheckError('That Anthropic API key was rejected. Check the key and try again.', 400);
  }
  if (status === 403) {
    return new ConnectionCheckError('Anthropic denied access for that API key. Check its permissions and try again.', 409);
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    captureException(error, undefined, { service: 'aiModels.connectionProbe' });
    return new ConnectionCheckError(
      `Anthropic rejected the verification request (HTTP ${status}). ` +
      'The probe model may be unavailable — contact support if this persists.',
      400,
    );
  }
  return new ConnectionCheckError('Anthropic could not verify the API key right now. Try again later.', 503);
}

/**
 * Verifies a key against the endpoint it will actually be used with. Defaults
 * to direct Anthropic; a `kind: 'catalog'` endpoint routes the same ping
 * through the guarded fetch, pinned to the catalog revision's origin, with no
 * partner-level org to attribute the audit event to (see
 * {@link buildProbeEgressRecorder}).
 */
export async function probeAnthropicKey(apiKey: string, endpoint: ResolvedLlmEndpoint = { kind: 'anthropic' }): Promise<void> {
  const model = endpoint.kind === 'catalog' ? endpoint.providerModel : resolveDefaultModel();
  // Probe through the connection factory, against the target the key will be
  // used with: a partner key is pinned to the public API; a catalog key goes
  // through the guarded fetch with exactly one credential header.
  const client = createAnthropicClient({
    apiKey,
    target: endpoint.kind === 'catalog'
      ? { kind: 'endpoint', baseUrl: endpoint.baseUrl, authMode: endpoint.authMode, recordEgress: buildProbeEgressRecorder() }
      : { kind: 'anthropic' },
  });
  try {
    await runOutsideDbContext(() => client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }));
  } catch (error) {
    throw mapProbeError(error);
  }
}

/**
 * A key-verification probe is a partner-level action — there is no
 * organization in scope to attribute an `llm_egress_events` row to (the
 * table's `org_id` is `NOT NULL` behind a composite FK; see
 * `catalogEgressRecorder` in `aiModels/connectionFactory.ts` for the same
 * no-org posture). The guarded fetch's security controls — origin pinning,
 * connect-time SSRF pinning, no redirects — are unaffected by whether the
 * attempt is audited. Warns once per probe rather than once per HTTP attempt.
 */
function buildProbeEgressRecorder(): (attempt: { host: string; resolvedIp: string | null; blocked: boolean }) => void {
  let warned = false;
  return () => {
    if (!warned) {
      warned = true;
      console.warn(
        '[aiModels] catalog endpoint probe egress could not be audited: probes run without an organization context.',
      );
    }
  };
}

/**
 * Joins a catalog entry + model to a probeable `ResolvedLlmEndpoint`, or
 * throws a typed, fail-loud `ConnectionCheckError` explaining why it cannot.
 * The key-rotation probe target; changeAnthropicEndpoint
 * (anthropicConnectionWrites.ts) applies the same three checks in the same
 * order, with the data-note consent between them. Never
 * falls back to probing api.anthropic.com with a key meant for a third-party
 * endpoint.
 */
export async function resolveCatalogEndpointForSelection(
  catalogEntryId: string,
  model: string,
): Promise<ResolvedLlmEndpoint> {
  if (!isLlmProviderCatalogEnabled()) {
    throw new ConnectionCheckError('Catalog endpoint selection is currently disabled on this deployment.', 409);
  }
  const provider = await getListedProviderByEntryId(catalogEntryId);
  if (!provider) {
    throw new ConnectionCheckError('That endpoint was delisted and is no longer available for selection.', 409);
  }
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new ConnectionCheckError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.',
      409,
    );
  }
  return endpoint;
}
