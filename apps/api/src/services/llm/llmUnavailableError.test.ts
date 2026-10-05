import { describe, expect, it } from 'vitest';
import { LlmUnavailableError, llmUnavailableBody } from './llmUnavailableError';

describe('llmUnavailableBody (#7793)', () => {
  it('a resolver refusal answers with its user-facing message and reason code', () => {
    const err = new LlmUnavailableError('This AI model cannot use tools, which this feature needs.', 'tools_unsupported');
    expect(err.reason).toBe('tools_unsupported');
    expect(llmUnavailableBody(err)).toEqual({ error: 'This AI model cannot use tools, which this feature needs.', code: 'tools_unsupported' });
  });

  it('an error without a resolver reason keeps the opaque ai_unavailable (its message is not vetted for clients)', () => {
    expect(llmUnavailableBody(new LlmUnavailableError())).toEqual({ error: 'ai_unavailable' });
    expect(llmUnavailableBody(new LlmUnavailableError('internal detail from some factory'))).toEqual({ error: 'ai_unavailable' });
  });
});
