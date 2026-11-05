import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { joinByoUrl } from '../byoEndpointPolicy';
import { noteGatewayFailure } from '../failureNotes';
import { forwardUpstream, readUpstreamErrorText } from '../forward';
import { GATEWAY_ERROR_TEXT_MAX } from '../limits';
import { scrubSecrets } from '../scrub';
import { GatewayError, gatewayErrorBody, type AnthropicErrorType, type GatewayGrantRecord, type GatewayResponse } from '../types';
import {
  contextWindowExceededMessage,
  parseContextLimitRejection,
  planAfterRejection,
  planRequest,
  rememberContextLimit,
} from './contextWindow';
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

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
}

function upstreamErrorType(status: number): AnthropicErrorType {
  if (status === 429) return 'rate_limit_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request_error';
  if (status === 413) return 'request_too_large';
  return 'api_error';
}

/** Diagnostics for one upstream call; never the prompt, the completion or a header value other than the request id. */
interface UpstreamCallContext { model: string; stream: boolean; startedAt: number; promptTokensEstimate: number }

/** Upstream request-id headers, in preference order. */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'openai-request-id', 'x-amzn-requestid', 'cf-ray'];
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The upstream's request id, only when it is a plain bounded token (never logged otherwise). */
function upstreamRequestId(res: Response): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) return SAFE_REQUEST_ID.test(v) ? v : null;
  }
  return null;
}

/**
 * One structured line per failed upstream call (#10591). Ids, model, status,
 * latency and request id identify the call; `detail` is the scrubbed, bounded
 * body from readUpstreamErrorText. Request headers and the prompt never appear.
 */
function logUpstreamFailure(grant: GatewayGrantRecord, call: UpstreamCallContext, what: string, res: Response, detail: string): void {
  const requestId = upstreamRequestId(res);
  console.warn(`[modelGateway] ${what} (grant ${grant.id}, connection ${grant.config.connectionId}, `
    + `model ${JSON.stringify(call.model)}, stream ${call.stream}, latency_ms ${Date.now() - call.startedAt}, `
    + `prompt_tokens_est ${call.promptTokensEstimate}, upstream_request_id ${requestId === null ? 'none' : JSON.stringify(requestId)})`
    + `${detail ? `: ${detail}` : ''}`);
}

/** Characters of a failed upstream's scrubbed reason shown in a log line or a chat turn. */
const UPSTREAM_DETAIL_MAX = 300;

const shortDetail = (grant: GatewayGrantRecord, detail: string): string =>
  scrubSecrets(detail, [grant.credential.secret], UPSTREAM_DETAIL_MAX);

function upstreamError(res: Response, grant: GatewayGrantRecord, call: UpstreamCallContext, fullDetail: string): GatewayResponse {
  const type = upstreamErrorType(res.status);
  const detail = shortDetail(grant, fullDetail);
  logUpstreamFailure(grant, call, `upstream returned HTTP ${res.status}`, res, detail);
  const message = type === 'authentication_error'
    ? 'The endpoint rejected the connection\'s key.'
    : `The endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
  // The CLI retries on its own and then reports a generic error; this lets the
  // chat turn name the endpoint's reason instead (scrubbed, no URL or key).
  noteGatewayFailure(grant.aiSessionId, message);
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(gatewayErrorBody(type, message)) };
}

/** The prompt does not fit the model: a 400 the CLI does not retry, named for the turn's settlement (#10577). */
function contextWindowRefusal(grant: GatewayGrantRecord, call: UpstreamCallContext, contextWindow: number, promptTokens: number): GatewayResponse {
  console.warn(`[modelGateway] request does not fit the context window (grant ${grant.id}, connection ${grant.config.connectionId}, `
    + `model ${JSON.stringify(call.model)}, prompt_tokens ${promptTokens}, context_window ${contextWindow})`);
  const message = contextWindowExceededMessage(contextWindow, promptTokens);
  noteGatewayFailure(grant.aiSessionId, message, 'context_window_exceeded');
  return { status: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(gatewayErrorBody('invalid_request_error', message)) };
}

async function messages(body: Buffer, grant: GatewayGrantRecord, signal: AbortSignal): Promise<GatewayResponse> {
  const parsed = parseJson(body) as { model?: unknown };
  const model = assertBoundModel(grant, parsed.model);
  if (grant.config.kind !== 'openai_compatible') throw new Error('openai adapter on a non-openai grant');
  const translated = translateMessagesRequest(parsed, model);
  const call: UpstreamCallContext = { model, stream: translated.stream, startedAt: Date.now(), promptTokensEstimate: estimateInputTokens(parsed) };
  const windowKey = { connectionId: grant.config.connectionId, configVersion: grant.config.configVersion, model };
  const plan = planRequest(windowKey, translated.maxTokens, call.promptTokensEstimate);
  if (plan.kind === 'too_large') return contextWindowRefusal(grant, call, plan.contextWindow, plan.promptTokens);
  const send = (maxTokens: number): Promise<Response> => forwardUpstream(grant, {
    url: joinByoUrl(grant.config.baseUrl, 'chat/completions'),
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: translated.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify({ ...translated.body, max_tokens: maxTokens }),
    stream: translated.stream,
  }, signal);
  let res = await send(plan.maxTokens);
  if (!res.ok) {
    const detail = await readUpstreamErrorText(res, grant, GATEWAY_ERROR_TEXT_MAX);
    const reported = parseContextLimitRejection(res.status, detail, plan.maxTokens);
    if (!reported) return upstreamError(res, grant, call, detail);
    rememberContextLimit(windowKey, reported, call.promptTokensEstimate);
    const next = planAfterRejection(reported, plan.maxTokens, call.promptTokensEstimate);
    if (next.kind === 'too_large') return contextWindowRefusal(grant, call, next.contextWindow, next.promptTokens);
    if (next.kind === 'surface') return upstreamError(res, grant, call, detail);
    logUpstreamFailure(grant, call, `upstream rejected max_tokens ${plan.maxTokens} for its context window; retrying once with ${next.maxTokens}`,
      res, shortDetail(grant, detail));
    res = await send(next.maxTokens);
    if (!res.ok) {
      const retryDetail = await readUpstreamErrorText(res, grant, GATEWAY_ERROR_TEXT_MAX);
      const again = parseContextLimitRejection(res.status, retryDetail, next.maxTokens);
      if (!again) return upstreamError(res, grant, call, retryDetail);
      rememberContextLimit(windowKey, again, call.promptTokensEstimate);
      return contextWindowRefusal(grant, call, again.contextWindow, again.promptTokens ?? call.promptTokensEstimate);
    }
  }
  if (!translated.stream) {
    let payload: unknown;
    try { payload = await res.json(); } catch {
      throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned malformed JSON.');
    }
    return json(200, translateChatResponse(payload, { model, tools: translated.tools, estimatedInputTokens: call.promptTokensEstimate }));
  }
  if (!res.body) throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned an empty stream.');
  if (!isEventStream(res.headers.get('content-type'))) {
    // A JSON answer or an HTML error page is not SSE; reading it as one would end
    // as an empty "complete" message. Drain a bounded prefix, drop the rest.
    const contentType = (res.headers.get('content-type') ?? 'none').slice(0, 100);
    const detail = await readUpstreamErrorText(res, grant);
    logUpstreamFailure(grant, call, `upstream did not stream its answer (content_type ${JSON.stringify(contentType)})`, res, detail);
    throw new GatewayError(502, 'api_error', 'upstream_not_streamed', 'The endpoint did not stream its answer.');
  }
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: translateChatStream(res.body as unknown as AsyncIterable<Uint8Array>, {
      model, tools: translated.tools, messageId: genMessageId(), estimatedInputTokens: call.promptTokensEstimate,
      grantId: grant.id, connectionId: grant.config.connectionId, secrets: [grant.credential.secret],
      onFailure: (message) => noteGatewayFailure(grant.aiSessionId, message),
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
