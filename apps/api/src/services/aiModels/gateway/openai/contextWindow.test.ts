import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_MIN_OUTPUT_TOKENS,
  CONTEXT_WINDOW_MEMO_MAX_ENTRIES,
  CONTEXT_WINDOW_MEMO_TTL_MS,
  CONTEXT_WINDOW_REFUSAL_FRESH_MS,
  __resetContextWindowsForTests,
  contextSafetyMargin,
  contextWindowExceededMessage,
  parseContextLimitRejection,
  planAfterRejection,
  planRequest,
  rememberContextLimit,
} from './contextWindow';

const KEY = { connectionId: 'c1', configVersion: 1, model: 'm' };
const WINDOW = 131_072;
const MARGIN = contextSafetyMargin(WINDOW);

afterEach(() => {
  __resetContextWindowsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseContextLimitRejection (#10577)', () => {
  it.each([
    ['max_tokens wording',
      '{"error":{"message":"This server\'s maximum context length is 131072 tokens: this request needs a 140301-token context (108301 prompt tokens plus max_tokens 32000)","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
      131_072, 108_301],
    ['OpenAI wording',
      'This model\'s maximum context length is 131072 tokens. However, you requested 140301 tokens (108301 in the messages, 32000 in the completion). Please reduce the length.',
      131_072, 108_301],
    ['vLLM wording with input tokens',
      '\'max_tokens\' or \'max_completion_tokens\' is too large: 32000. This model\'s maximum context length is 131072 tokens and your request has 108301 input tokens (32000 > 131072 - 108301).',
      131_072, 108_301],
    ['llama.cpp fields',
      '{"error":{"code":400,"message":"the request exceeds the available context size","type":"exceed_context_size_error","n_prompt_tokens":108301,"n_ctx":131072}}',
      131_072, 108_301],
    ['thousands separators',
      'maximum context length is 131,072 tokens (108,301 prompt tokens plus max_tokens 32,000)',
      131_072, 108_301],
    ['vLLM wording with a lower bound',
      'This model\'s maximum context length is 131072 tokens. However, you requested 32000 output tokens and your prompt contains at least 99073 input tokens, for a total of at least 131073 tokens.',
      131_072, 99_073],
    ['Azure wording',
      'This model\'s maximum context length is 131072 tokens, however your messages resulted in 108301 tokens. Please reduce the length of the messages.',
      131_072, 108_301],
  ])('reads %s', (_name, text, contextWindow, promptTokens) => {
    expect(parseContextLimitRejection(400, text, 32_000)).toEqual({ contextWindow, promptTokens });
  });

  it('reads a window stated as "of only"', () => {
    expect(parseContextLimitRejection(400, 'the model is loaded with context length of only 4096 tokens', 32_000))
      .toEqual({ contextWindow: 4_096, promptTokens: null });
  });

  it.each([413, 422])('reads a rejection sent as HTTP %i', (status) => {
    expect(parseContextLimitRejection(status, 'maximum context length is 131072 tokens (108301 prompt tokens)', 32_000))
      .toEqual({ contextWindow: 131_072, promptTokens: 108_301 });
  });

  it('derives the prompt from a stated total when no prompt count is given', () => {
    expect(parseContextLimitRejection(400, 'maximum context length is 131072 tokens, you requested 140301 tokens', 32_000))
      .toEqual({ contextWindow: 131_072, promptTokens: 108_301 });
  });

  it('keeps the window when the prompt cannot be read', () => {
    expect(parseContextLimitRejection(400, 'maximum context length is 131072 tokens', 32_000))
      .toEqual({ contextWindow: 131_072, promptTokens: null });
  });

  it.each([
    ['another 400', 400, 'temperature must be below 2'],
    ['a 500 that mentions the limit', 500, 'maximum context length is 131072 tokens'],
    ['a 401', 401, 'maximum context length is 131072 tokens'],
    ['an absurdly small window', 400, 'maximum context length is 12 tokens'],
    ['an absurdly large window', 400, 'maximum context length is 999999999999 tokens'],
    ['a mention with no number', 400, 'context_length_exceeded'],
  ])('ignores %s', (_name, status, text) => {
    expect(parseContextLimitRejection(status, text, 32_000)).toBeNull();
  });

  it('drops an implausible prompt count but keeps the window', () => {
    expect(parseContextLimitRejection(400, 'maximum context length is 131072 tokens (999999999999 prompt tokens)', 32_000))
      .toEqual({ contextWindow: 131_072, promptTokens: null });
  });
});

describe('planAfterRejection (#10577)', () => {
  const reported = { contextWindow: WINDOW, promptTokens: 108_301 };

  it('caps to the room the endpoint reported, leaving the safety margin', () => {
    expect(planAfterRejection(reported, 32_000, 102_000)).toEqual({ kind: 'retry', maxTokens: WINDOW - 108_301 - MARGIN });
  });

  it('does not retry when the cap would not lower the request', () => {
    expect(planAfterRejection(reported, 1_000, 102_000)).toEqual({ kind: 'surface' });
  });

  it('reports too_large when the prompt alone fills the window', () => {
    expect(planAfterRejection({ contextWindow: WINDOW, promptTokens: 140_000 }, 32_000, 130_000))
      .toEqual({ kind: 'too_large', contextWindow: WINDOW, promptTokens: 140_000 });
  });

  it('reports too_large when the room left is too small for a useful answer', () => {
    const promptTokens = WINDOW - MARGIN - CONTEXT_MIN_OUTPUT_TOKENS + 1;
    expect(planAfterRejection({ contextWindow: WINDOW, promptTokens }, 32_000, promptTokens))
      .toEqual({ kind: 'too_large', contextWindow: WINDOW, promptTokens });
  });

  it('falls back to the estimate when the endpoint gave no prompt count', () => {
    expect(planAfterRejection({ contextWindow: WINDOW, promptTokens: null }, 32_000, 100_000))
      .toEqual({ kind: 'retry', maxTokens: WINDOW - 100_000 - MARGIN });
  });
});

describe('planRequest (#10577)', () => {
  it('an unknown window leaves the request unchanged and logs once per model', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(planRequest(KEY, 32_000, 108_000)).toEqual({ kind: 'send', maxTokens: 32_000 });
    expect(planRequest(KEY, 32_000, 108_000)).toEqual({ kind: 'send', maxTokens: 32_000 });
    expect(log.mock.calls.filter(([l]) => String(l).includes('no context window known'))).toHaveLength(1);
    planRequest({ ...KEY, model: 'other' }, 32_000, 108_000);
    expect(log.mock.calls.filter(([l]) => String(l).includes('no context window known'))).toHaveLength(2);
  });

  it('a remembered window caps the request, using the calibrated estimate', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The endpoint counted 108,301 where the byte estimate said 100,000.
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 108_301 }, 100_000);
    expect(planRequest(KEY, 32_000, 100_000)).toEqual({ kind: 'send', maxTokens: WINDOW - 108_301 - MARGIN });
  });

  it('never raises what the caller asked for', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 1_000 }, 1_000);
    expect(planRequest(KEY, 256, 1_000)).toEqual({ kind: 'send', maxTokens: 256 });
  });

  it('refuses only when the prompt is clearly over the window', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 100_000 }, 100_000);
    expect(planRequest(KEY, 32_000, WINDOW * 2)).toEqual({ kind: 'too_large', contextWindow: WINDOW, promptTokens: WINDOW * 2 });
  });

  it('an estimate near the window still goes to the endpoint, whose count is exact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 100_000 }, 100_000);
    expect(planRequest(KEY, 32_000, WINDOW + 100)).toEqual({ kind: 'send', maxTokens: CONTEXT_MIN_OUTPUT_TOKENS });
  });

  it('the refusal threshold is 1.2 times the window', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 100_000 }, 100_000);
    const atThreshold = Math.ceil(WINDOW * 1.2);
    expect(planRequest(KEY, 32_000, atThreshold).kind).toBe('too_large');
    expect(planRequest(KEY, 32_000, atThreshold - 1).kind).toBe('send');
  });

  it('a window not reconfirmed recently never refuses alone: the endpoint is asked again, in case it was resized', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 100_000 }, 100_000);
    vi.advanceTimersByTime(CONTEXT_WINDOW_REFUSAL_FRESH_MS + 1);
    expect(planRequest(KEY, 32_000, WINDOW * 2)).toEqual({ kind: 'send', maxTokens: CONTEXT_MIN_OUTPUT_TOKENS });
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: WINDOW * 2 }, WINDOW * 2);
    expect(planRequest(KEY, 32_000, WINDOW * 2).kind).toBe('too_large');
  });

  it('logs the first up-front cap for a remembered window, then stays quiet', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 108_301 }, 108_301);
    planRequest(KEY, 32_000, 108_301);
    planRequest(KEY, 32_000, 108_301);
    expect(log.mock.calls.filter(([l]) => String(l).includes('capping max_tokens'))).toHaveLength(1);
  });

  it('a window is scoped to its connection, config version and model', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 108_301 }, 108_301);
    for (const other of [{ ...KEY, connectionId: 'c2' }, { ...KEY, configVersion: 2 }, { ...KEY, model: 'n' }]) {
      expect(planRequest(other, 32_000, 108_301)).toEqual({ kind: 'send', maxTokens: 32_000 });
    }
  });

  it('a remembered window expires, so a resized endpoint is not capped forever', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 108_301 }, 108_301);
    vi.advanceTimersByTime(CONTEXT_WINDOW_MEMO_TTL_MS + 1);
    expect(planRequest(KEY, 32_000, 108_301)).toEqual({ kind: 'send', maxTokens: 32_000 });
  });

  it('the memo stays bounded, dropping the oldest entry', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberContextLimit(KEY, { contextWindow: WINDOW, promptTokens: 108_301 }, 108_301);
    for (let i = 0; i < CONTEXT_WINDOW_MEMO_MAX_ENTRIES; i += 1) {
      rememberContextLimit({ ...KEY, connectionId: `x${i}` }, { contextWindow: WINDOW, promptTokens: 1 }, 1);
    }
    expect(planRequest(KEY, 32_000, 108_301)).toEqual({ kind: 'send', maxTokens: 32_000 });
  });
});

describe('contextWindowExceededMessage (#10577)', () => {
  it('names the sizes and what to do, in plain text', () => {
    const message = contextWindowExceededMessage(WINDOW, 140_000);
    expect(message).toContain('140,000');
    expect(message).toContain('131,072');
    expect(message).toMatch(/new chat/i);
    expect(message).toMatch(/larger context window/i);
  });
});
