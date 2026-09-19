import { describe, expect, it } from 'vitest';
import { ExtensionAiError } from './server';

describe('ExtensionAiError', () => {
  it('carries the error code, message, and name for extensions to branch on', () => {
    const err = new ExtensionAiError('budget_exceeded', 'org budget exhausted');

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('budget_exceeded');
    expect(err.message).toBe('org budget exhausted');
    expect(err.name).toBe('ExtensionAiError');
  });

  it('defaults `permanent` to false so a two-argument construction still means "retry may help"', () => {
    // Backward compatibility is the point: every pre-existing call site passes
    // two arguments, and a silent flip to permanent would turn a provider blip
    // into a drained phase.
    expect(new ExtensionAiError('rate_limited', 'slow down').permanent).toBe(false);
  });

  it('carries `permanent: true` when the host says retrying cannot help', () => {
    // Same CODE, opposite handling: budget_exceeded raised because the org has
    // AI switched off (or is on a plan without it) never clears on its own,
    // while budget_exceeded from a daily spend cap does.
    const err = new ExtensionAiError('budget_exceeded', 'AI features are disabled', {
      permanent: true,
    });

    expect(err.permanent).toBe(true);
    expect(err.code).toBe('budget_exceeded');
  });
});
