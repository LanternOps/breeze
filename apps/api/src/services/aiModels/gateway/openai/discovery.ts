/**
 * Model discovery for an `openai_compatible` connection —
 * `GET {base_url}/models` on a partner-supplied, untrusted endpoint.
 *
 * One of the two places allowed to send a request to a partner base URL
 * (Global Constraints; the other is gateway/forward.ts, which this calls): the
 * request goes through `forwardUpstream`, so it is origin/path-pinned to the
 * connection, SSRF-guarded with DNS pinning (safeFetch), never follows a
 * redirect, and carries the credential only in its Authorization header. The
 * response is capped at DISCOVERY_MAX_RESPONSE_BYTES and everything in it is
 * treated as hostile: ids must match BYO_MODEL_ID_PATTERN, names are stripped
 * of control/bidi characters and capped, and a list longer than
 * DISCOVERY_MAX_MODELS is refused outright rather than truncated.
 */
import { BYO_MODEL_ID_PATTERN } from '@breeze/shared';
import { discoveryGrantRecord } from '../grants';
import { joinByoUrl } from '../byoEndpointPolicy';
import { forwardUpstream, readUpstreamErrorText } from '../forward';
import { DISCOVERY_MAX_MODELS, DISCOVERY_MAX_RESPONSE_BYTES, DISCOVERY_TOTAL_TIMEOUT_MS } from '../limits';
import { containsSecretMaterial, scrubSecrets } from '../scrub';
import type { DiscoveredConnectionModel, GatewayConnectionConfig, GatewayCredential } from '../types';

const DISPLAY_NAME_MAX = 120;
/** C0/C1 controls, DEL, and bidi embedding/override/isolate characters (display spoofing). */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const NOT_A_LIST = 'The endpoint did not return a model list.';
const TIMED_OUT = 'The endpoint did not respond in time.';

/** A list too long to trust as complete: the sync records it as failed (no lifecycle change). */
export class DiscoveryTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryTruncatedError';
  }
}

function listOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}

/**
 * The capped display name, or null. Key material is judged on the FULL name
 * (as sent and with unsafe characters stripped) before the length cut: checked
 * after it, an encoding straddling the cut would survive as a fragment.
 */
function displayNameOf(item: object, secret: string | null): string | null {
  const raw = (item as { display_name?: unknown }).display_name ?? (item as { name?: unknown }).name;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, '');
  if (containsSecretMaterial(raw, secret) || containsSecretMaterial(cleaned, secret)) return null;
  const name = cleaned.trim().slice(0, DISPLAY_NAME_MAX).trim();
  return name.length > 0 ? name : null;
}

/**
 * The OpenAI `{ data: [{ id }] }` shape or a bare array. Invalid ids are
 * dropped, duplicates collapse to the first; anything that is not a list
 * throws. More than DISCOVERY_MAX_MODELS entries throws DiscoveryTruncatedError
 * (a cut-off list would age the models past the cut). With
 * `secret`, a name carrying it in any form is dropped before it is capped; ids
 * are screened for the key by the caller (aiModels/discovery withoutKeyMaterial).
 */
export function sanitizeDiscoveredModels(payload: unknown, secret: string | null = null): DiscoveredConnectionModel[] {
  const list = listOf(payload);
  if (!list) throw new Error(NOT_A_LIST);
  if (list.length > DISCOVERY_MAX_MODELS) {
    throw new DiscoveryTruncatedError(`The endpoint lists more than ${DISCOVERY_MAX_MODELS} models; add the ones you need by hand.`);
  }
  const seen = new Set<string>();
  const out: DiscoveredConnectionModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || !BYO_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ modelId: id, displayName: displayNameOf(item, secret) });
  }
  return out;
}

export async function discoverOpenAiCompatibleModels(input: {
  config: Extract<GatewayConnectionConfig, { kind: 'openai_compatible' }>;
  credential: GatewayCredential;
}): Promise<DiscoveredConnectionModel[]> {
  const grant = discoveryGrantRecord(input.config, input.credential);
  // forwardUpstream's own deadline covers connect + headers only, and its
  // inactivity limit resets on every byte, so an endpoint that answers headers
  // at once and then trickles its body would otherwise hold the (single)
  // discovery worker. This bounds the whole listing, DNS through the last byte
  // (stream: false buffers the capped body before forwardUpstream resolves).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DISCOVERY_TOTAL_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await forwardUpstream(grant, {
        url: joinByoUrl(input.config.baseUrl, 'models'),
        method: 'GET',
        headers: { accept: 'application/json' },
        stream: false,
        maxBytes: DISCOVERY_MAX_RESPONSE_BYTES,
      }, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) throw new Error(TIMED_OUT);
      throw error;
    }
    if (res.status === 401 || res.status === 403) {
      // An auth rejection often echoes a masked or partial copy of the key,
      // which the exact-match scrub cannot recognise. This message is stored
      // on the connection, so keep a fixed one (as the request path does).
      await res.body?.cancel().catch(() => {});
      throw new Error(`The endpoint rejected the connection's key (HTTP ${res.status} for /models).`);
    }
    if (!res.ok) {
      const body = await readUpstreamErrorText(res, grant, 300);
      throw new Error(scrubSecrets(`The endpoint returned HTTP ${res.status} for /models: ${body}`, [input.credential.secret], 400));
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error(NOT_A_LIST);
    }
    return sanitizeDiscoveredModels(payload, input.credential.secret);
  } finally {
    clearTimeout(timer);
    // Best effort: drop this call's copy of the plaintext.
    grant.credential.secret = null;
  }
}
