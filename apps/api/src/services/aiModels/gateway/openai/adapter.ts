import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { joinByoUrl } from '../byoEndpointPolicy';
import { forwardUpstream, readUpstreamErrorText } from '../forward';
import { GatewayError, gatewayErrorBody, type AnthropicErrorType, type GatewayGrantRecord, type GatewayResponse } from '../types';
import { genMessageId, translateChatResponse } from './translateResponse';
import { translateChatStream } from './translateStream';
import { translateMessagesRequest } from './translateRequest';

export const GATEWAY_PLACEHOLDER_KEY = 'breeze-gateway';

const json = (status: number, body: unknown): GatewayResponse => ({
  status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)),
});

function parseJson(body: Buffer): unknown {
  try { return JSON.parse(body.toString('utf8')); } catch {
    throw new GatewayError(400, 'invalid_request_error', 'bad_json', 'Request body is not JSON.');
  }
}

export function estimateInputTokens(body: unknown): number {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = JSON.stringify({ s: b.system ?? null, m: b.messages ?? [], t: b.tools ?? [] });
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function upstreamErrorType(status: number): AnthropicErrorType {
  if (status === 429) return 'rate_limit_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request_error';
  if (status === 413) return 'request_too_large';
  return 'api_error';
}

async function upstreamError(res: Response, grant: GatewayGrantRecord): Promise<GatewayResponse> {
  const type = upstreamErrorType(res.status);
  const detail = await readUpstreamErrorText(res, grant);
  const message = type === 'authentication_error'
    ? 'The endpoint rejected the connection\'s key.'
    : `The endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(gatewayErrorBody(type, message)) };
}

async function messages(body: Buffer, grant: GatewayGrantRecord, signal: AbortSignal): Promise<GatewayResponse> {
  const parsed = parseJson(body) as { model?: unknown };
  const model = assertBoundModel(grant, parsed.model);
  if (grant.config.kind !== 'openai_compatible') throw new Error('openai adapter on a non-openai grant');
  const translated = translateMessagesRequest(parsed, model);
  const res = await forwardUpstream(grant, {
    url: joinByoUrl(grant.config.baseUrl, 'chat/completions'),
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: translated.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(translated.body),
    stream: translated.stream,
  }, signal);
  if (!res.ok) return upstreamError(res, grant);
  if (!translated.stream) {
    let payload: unknown;
    try { payload = await res.json(); } catch {
      throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned malformed JSON.');
    }
    return json(200, translateChatResponse(payload, { model, tools: translated.tools, estimatedInputTokens: estimateInputTokens(parsed) }));
  }
  if (!res.body) throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned an empty stream.');
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: translateChatStream(res.body as unknown as AsyncIterable<Uint8Array>, {
      model, tools: translated.tools, messageId: genMessageId(), estimatedInputTokens: estimateInputTokens(parsed),
    }),
  };
}

export const openAiCompatibleAdapter: GatewayAdapter = {
  kind: 'openai_compatible',
  dialect: 'anthropic',
  async handle(req, grant) {
    const path = req.path.replace(/\/+$/, '');
    if (req.method === 'POST' && path === '/v1/messages') return messages(req.body, grant, req.signal);
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      const parsed = parseJson(req.body) as { model?: unknown };
      assertBoundModel(grant, parsed.model);
      return json(200, { input_tokens: estimateInputTokens(parsed) });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const data = [...grant.wireModels].map((id) => ({ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' }));
      return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
  },
  sdkChildEnv({ gatewayBaseUrl, wireModel }) {
    return {
      ANTHROPIC_BASE_URL: gatewayBaseUrl,
      ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: wireModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: wireModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: wireModel,
      ANTHROPIC_DEFAULT_FABLE_MODEL: wireModel,
      ANTHROPIC_SMALL_FAST_MODEL: wireModel,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
      DISABLE_PROMPT_CACHING: '1',
    };
  },
};

registerGatewayAdapter(openAiCompatibleAdapter);
