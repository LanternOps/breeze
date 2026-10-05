/**
 * An in-process Anthropic client talking to the gateway (offering
 * verification's direct stages) is bounded in total by its SDK `timeout`, even
 * against an endpoint that answers headers at once and then trickles its body.
 *
 * Why that holds: the SDK's timeout covers the request until response headers,
 * and for a non-streamed request the gateway sends no headers until the
 * upstream body has been fully buffered (forwardUpstream with stream: false).
 * When the client gives up, its socket closes, the gateway aborts the request
 * and the upstream dial is torn down. The upstream here stands in for a
 * trickling body: it settles only when its signal aborts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests } from './forward';
import { closeModelGateway, getModelGateway } from './index';
import { GATEWAY_PLACEHOLDER_KEY } from './openai/adapter';

afterEach(async () => {
  __setUpstreamFetchForTests(null);
  await closeModelGateway();
  vi.restoreAllMocks();
});

describe('gateway — a non-streamed in-process request is bounded by the client timeout', () => {
  it('the client times out and the upstream request is aborted, not left running', async () => {
    let upstreamAbortedAt: number | null = null;
    __setUpstreamFetchForTests((async (_url: string, init: { signal: AbortSignal; streamResponse: boolean }) => {
      expect(init.streamResponse).toBe(false);
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          upstreamAbortedAt = Date.now();
          reject(new Error('aborted'));
        }, { once: true });
      });
    }) as never);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gw = await getModelGateway();
    const grant = gw.grant({
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://llm.example.com/v1' },
      credential: { secret: 'sk-direct-deadline-123456' },
      wireModels: ['m1'], orgId: null, aiSessionId: null, purpose: 'verification',
    });
    const client = new Anthropic({ baseURL: grant.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, timeout: 200, maxRetries: 0 });

    const started = Date.now();
    await expect(client.messages.create({ model: 'm1', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(1500);

    await vi.waitFor(() => expect(upstreamAbortedAt).not.toBeNull(), { timeout: 1000 });
    expect(upstreamAbortedAt! - started).toBeLessThan(1500);
    grant.revoke();
  }, 5000);
});
